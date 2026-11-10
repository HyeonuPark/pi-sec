/**
 * Model provider login from the web UI.
 *
 * One real `ModelRuntime` over a temporary home, its credential store writing
 * into that home's secret directory, and the fixture extension `acme` registered
 * the way the daemon registers it. Two small native providers carry the parts
 * the fixture cannot: a flow that asks a question and can refuse the answer, and
 * one that fails before it asks anything.
 *
 * Nothing here reaches a provider over the network. Every credential, link and
 * code is a fake.
 *
 * The logger and the audit log are built without a redactor on purpose: a value
 * that reached a log line must fail this test, and redaction would hide it
 * behind a placeholder.
 */
import { request as httpRequest } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { LoginOptions, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { createModels } from "../src/agent/models.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { ProviderRegistry, preloadExtensionProviders } from "../src/registry/providers.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus } from "../src/runtime/event-bus.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { readOrCreateDeviceId } from "../src/runtime/model-login.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/acme/", import.meta.url));

// The fixture's fake credentials. Keep these in step with
// `test/fixtures/extensions/acme/index.js`.
const ACME_ACCESS = "fake-acme-oauth-access-0000000000000000";
const ACME_REFRESH = "fake-acme-oauth-refresh-000000000000000";
const ACME_API_KEY = "fake-native-login-key-000000000000";

// This file's own fakes. Each carries a marker no other line can contain, so a
// leak into a log is found by value and not by shape.
const LOGIN_ACCESS = "test-login-oauth-access-0000000000001";
const LOGIN_REFRESH = "test-login-oauth-refresh-000000000000";
const LOGIN_CODE = "test-code-0001#test-state-0002";
const DEVICE_ACCESS = "test-device-oauth-access-000000000000";
const DEVICE_REFRESH = "test-device-oauth-refresh-000000000000";
const AUTH_URL = "https://signin.example.test/oauth/authorize?code_challenge=AUTH-URL-MARKER-0003";
const DEVICE_URL = "https://signin.example.test/device";

// What the device ID file must hold, as the code writes it.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE_ID_FILE = "device-id";

/** What the device-ID provider's flow saw, kept per boot. */
interface DeviceIdLog {
  /** The login options the flow was given, or `undefined` when it was given none. */
  options: LoginOptions | undefined;
  /** Each value `getDeviceId` returned, in the order the flows asked. */
  ids: string[];
}

function newDeviceIdLog(): DeviceIdLog {
  return { options: undefined, ids: [] };
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function chatModel(provider: string, id: string) {
  return {
    id,
    name: id,
    api: "test-login-api",
    provider,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
    reasoning: false,
  };
}

/** The provider a flow needs a question from: it asks, then it judges the answer. */
function promptingProvider(): Provider {
  return {
    id: "test-login",
    name: "Test login",
    auth: {
      oauth: {
        name: "Test login (OAuth)",
        async login(interaction) {
          interaction.notify({ type: "auth_url", url: AUTH_URL, instructions: "Open the link, then paste the code." });
          const method = await interaction.prompt({
            type: "select",
            message: "How do you want to sign in?",
            options: [
              { id: "browser", label: "Browser login" },
              { id: "copy_code", label: "Copy code login", description: "Paste the code from any device." },
            ],
          });
          if (method === "browser") {
            interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: DEVICE_URL });
          }
          const answer = await interaction.prompt({
            type: "manual_code",
            message: "Paste the code the provider showed",
            placeholder: "code#state",
          });
          if (answer !== LOGIN_CODE) {
            // A library error can carry the provider's response body, which is
            // where an exchange failure puts the code back. This one carries the
            // answer on purpose: the routes must not repeat it anywhere.
            throw new Error(`provider rejected the code: ${answer}`);
          }
          return {
            type: "oauth" as const,
            access: LOGIN_ACCESS,
            refresh: LOGIN_REFRESH,
            expires: Date.now() + 3_600_000,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels() {
      return [chatModel("test-login", "test-login-chat")];
    },
    stream() {
      throw new Error("no request is made in these tests");
    },
    streamSimple() {
      throw new Error("no request is made in these tests");
    },
  } as unknown as Provider;
}

/** A flow that fails before it asks anything. */
function failingProvider(): Provider {
  return {
    id: "test-fail",
    name: "Test fail",
    auth: {
      oauth: {
        name: "Test fail (OAuth)",
        async login() {
          throw new Error("the provider refused the request");
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels() {
      return [chatModel("test-fail", "test-fail-chat")];
    },
    stream() {
      throw new Error("no request is made in these tests");
    },
    streamSimple() {
      throw new Error("no request is made in these tests");
    },
  } as unknown as Provider;
}

/**
 * A flow that asks for the installation ID the way pi-ai's `openai` flow does:
 * it reads the ID before anything else, and a throw from there is the failure of
 * the whole login. It asks nothing and returns its credential at once.
 */
function deviceIdProvider(log: DeviceIdLog): Provider {
  return {
    id: "test-device",
    name: "Test device",
    auth: {
      oauth: {
        name: "Test device (OAuth)",
        async login(_interaction: any, options?: LoginOptions) {
          log.options = options;
          const id = options?.getDeviceId?.();
          if (typeof id === "string") log.ids.push(id);
          return {
            type: "oauth" as const,
            access: DEVICE_ACCESS,
            refresh: DEVICE_REFRESH,
            expires: Date.now() + 3_600_000,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels() {
      return [chatModel("test-device", "test-device-chat")];
    },
    stream() {
      throw new Error("no request is made in these tests");
    },
    streamSimple() {
      throw new Error("no request is made in these tests");
    },
  } as unknown as Provider;
}

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly body: any;
}

interface Boot {
  readonly origin: string;
  readonly root: string;
  readonly paths: Paths;
  readonly runtime: AgentRuntime;
  readonly started: StartedServer;
  get(path: string, headers?: Record<string, string>): Promise<Answer>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Answer>;
  close(): Promise<void>;
}

interface BootOptions {
  /** Text the record file holds before the first login. */
  readonly record?: string;
  readonly publicUrl?: string;
  readonly sessionTimeoutMs?: number;
  readonly finishedRetentionMs?: number;
  /** A home already laid out, for a second runtime on the same state directory. */
  readonly root?: string;
  /** Where the device-ID provider's flow writes what it saw. */
  readonly deviceIdLog?: DeviceIdLog;
}

function request(
  origin: string,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  const url = new URL(options.path, origin);
  return new Promise((settle, fail) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let body: any;
          try {
            body = text === "" ? undefined : JSON.parse(text);
          } catch {
            body = undefined;
          }
          settle({ status: res.statusCode ?? 0, text, body });
        });
      },
    );
    req.on("error", fail);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function boot(options: BootOptions = {}): Promise<Boot> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "pi-sec-model-login-")));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });

  await cp(FIXTURE, join(paths.extensionsDir, "acme"), { recursive: true });
  await writeFile(join(paths.extensionsDir, "acme", "config.json"), JSON.stringify({ answer: "login fixture" }), "utf8");

  const base = defaultConfig();
  const config: Config = {
    ...base,
    server: {
      ...base.server,
      port: 0,
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    },
    vmodels: {
      root: { provider: "acme", modelId: "acme-fake-chat", thinkingLevel: "medium", prompt: "default" },
    },
    agent: { ...base.agent, vmodel: "root", roles: [] },
    code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
  };

  const secrets = new SecretRegistry({ dir: paths.secretsDir });
  await secrets.load();
  // No redactor in either log: see the note at the top of this file.
  const logger = createLogger({ console: false, file: paths.appLog });
  const audit = createAuditLog({ file: paths.auditLog });
  const bus = createEventBus();

  const models = await createModels({
    authPath: paths.authFile,
    modelsPath: paths.modelsFile,
    secretsDir: paths.secretsDir,
    onCredentialsChanged: () => secrets.reload(),
  });
  const providers = new ProviderRegistry({ host: models, logger });
  await preloadExtensionProviders({ extensionsDir: paths.extensionsDir, registry: providers, logger });
  models.registerNativeProvider(promptingProvider());
  models.registerNativeProvider(failingProvider());
  models.registerNativeProvider(deviceIdProvider(options.deviceIdLog ?? newDeviceIdLog()));

  const runtime = await createAgentRuntime({
    paths,
    config,
    storage: new MemoryStorage(),
    archiveStorage: new MemoryStorage(),
    models,
    secrets,
    logger,
    audit,
    events: bus.sink,
    loadExtensions: false,
    watchExtensions: false,
    prepareRoot: false,
    providers,
    modelLogin: {
      ...(options.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: options.sessionTimeoutMs }),
      ...(options.finishedRetentionMs === undefined ? {} : { finishedRetentionMs: options.finishedRetentionMs }),
    },
  });

  if (options.record !== undefined) await writeFile(paths.modelLoginsFile, options.record, "utf8");

  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime,
    bus,
    sse,
    streams: new StreamHub({ runtime, bus, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: runtime.restart, notes: new AdminNotes() },
  };
  const started = await startServer(deps, { webDir: defaultWebDir() });

  return {
    origin: started.origin,
    root,
    paths,
    runtime,
    started,
    get: (path, headers) => request(started.origin, { method: "GET", path, headers }),
    post: (path, body, headers) =>
      request(started.origin, {
        method: "POST",
        path,
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    close: async () => {
      await started.close();
      await runtime.close();
    },
  };
}

const START = "/api/admin/model-login/start";
const STATE = "/api/admin/model-login/state";
const ANSWER = "/api/admin/model-login/answer";
const CANCEL = "/api/admin/model-login/cancel";
const PROVIDERS = "/api/admin/model-login/providers";

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

/** Poll the state route until it says what the test waits for. */
async function waitState(
  app: Boot,
  session: string,
  until: (state: any) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const answer = await app.post(STATE, { session });
    expect(answer.status, answer.text).toBe(200);
    last = answer.body;
    if (until(last)) return last;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}`);
}

async function recordFile(paths: Paths): Promise<any> {
  return JSON.parse(await readFile(paths.modelLoginsFile, "utf8"));
}

/** The audit rows of one type. */
async function auditRows(paths: Paths, type: string): Promise<any[]> {
  const text = await readFile(paths.auditLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === type);
}

/** Start the device-ID flow and wait until it ended either way. */
async function startDeviceLogin(app: Boot): Promise<any> {
  const started = await app.post(START, { provider: "test-device", type: "oauth" });
  expect(started.status, started.text).toBe(200);
  return waitState(
    app,
    started.body.session,
    (state) => state.status === "succeeded" || state.status === "failed",
    "the end of the device-ID login",
  );
}

describe("signing a provider in from the web UI", () => {
  it("takes a login from start to success through prompts, and records the time", async () => {
    const app = await boot();
    try {
      const started = await app.post(START, { provider: "test-login", type: "oauth" });
      expect(started.status, started.text).toBe(200);
      const session: string = started.body.session;
      expect(typeof session).toBe("string");
      expect(session.length).toBeGreaterThan(20);
      expect(started.body.state.provider).toBe("test-login");
      expect(started.body.state.type).toBe("oauth");
      // The session id and the answer travel in the body only; the access log
      // records `req.url`, so a route that took either in the query would write
      // it down.
      const log = await readFile(app.paths.appLog, "utf8");
      expect(log).not.toContain(session);

      const choosing = await waitState(app, session, (state) => state.status === "prompt", "the method question");
      expect(choosing.prompt.type).toBe("select");
      expect(choosing.prompt.options.map((option: any) => option.id)).toEqual(["browser", "copy_code"]);
      // The sign-in link is already in the notifications, and it is the one the
      // panel opens in a new tab.
      expect(choosing.events).toEqual([
        { type: "auth_url", url: AUTH_URL, instructions: "Open the link, then paste the code." },
      ]);

      const answeredMethod = await app.post(ANSWER, { session, value: "copy_code" });
      expect(answeredMethod.status, answeredMethod.text).toBe(200);

      const pasting = await waitState(
        app,
        session,
        (state) => state.status === "prompt" && state.prompt?.type === "manual_code",
        "the code question",
      );
      expect(pasting.prompt.placeholder).toBe("code#state");

      const answeredCode = await app.post(ANSWER, { session, value: LOGIN_CODE });
      expect(answeredCode.status, answeredCode.text).toBe(200);

      const done = await waitState(app, session, (state) => state.status === "succeeded", "the success");
      expect(done.reason).toBeNull();
      expect(done.warning).toBeNull();
      expect(typeof done.loginAt).toBe("string");
      expect(Number.isNaN(Date.parse(done.loginAt))).toBe(false);
      expect(done.finishedAt).not.toBeNull();
      expect(done.prompt).toBeNull();

      // The values are in the secret store, and `auth.json` names their files.
      expect(await readFile(join(app.paths.secretsDir, "model-auth.test-login.access"), "utf8")).toBe(LOGIN_ACCESS);
      expect(await readFile(join(app.paths.secretsDir, "model-auth.test-login.refresh"), "utf8")).toBe(LOGIN_REFRESH);
      const authText = await readFile(app.paths.authFile, "utf8");
      const auth = JSON.parse(authText) as Record<string, any>;
      expect(auth["test-login"]?.["type"]).toBe("oauth");
      expect(auth["test-login"]?.["access"]).toEqual({ file: "model-auth.test-login.access" });
      expect(auth["test-login"]?.["refresh"]).toEqual({ file: "model-auth.test-login.refresh" });
      expect(authText).not.toContain(LOGIN_ACCESS);
      expect(authText).not.toContain(LOGIN_REFRESH);

      // One entry for this provider, with the time the state reported, and the
      // file is private.
      const record = await recordFile(app.paths);
      expect(record).toEqual({ version: 1, logins: { "test-login": { at: done.loginAt, type: "oauth" } } });
      expect((await stat(app.paths.modelLoginsFile)).mode & 0o777).toBe(0o600);

      const rows = await auditRows(app.paths, "model_login");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: "test-login", loginType: "oauth", outcome: "success" });
      // A row carries the provider, the type and the outcome, and nothing else.
      expect(Object.keys(rows[0]).sort()).toEqual(["loginType", "outcome", "provider", "time", "type"]);
    } finally {
      await app.close();
    }
  });

  it("keeps another provider's entry and does not stop on a corrupt record file", async () => {
    const earlier = { at: "2026-10-01T00:05:00.000Z", type: "api_key", note: "kept as it was" };
    const app = await boot({
      record: `${JSON.stringify({ version: 1, logins: { "acme-native": earlier } }, null, 2)}\n`,
    });
    try {
      const started = await app.post(START, { provider: "test-login", type: "oauth" });
      const session: string = started.body.session;
      await waitState(app, session, (state) => state.status === "prompt", "the method question");
      await app.post(ANSWER, { session, value: "copy_code" });
      await waitState(app, session, (state) => state.status === "prompt" && state.prompt?.type === "manual_code", "the code question");
      await app.post(ANSWER, { session, value: LOGIN_CODE });
      const done = await waitState(app, session, (state) => state.status === "succeeded", "the success");

      const record = await recordFile(app.paths);
      // The other provider's entry is kept; this one's is written whole.
      expect(record.logins["acme-native"]).toEqual(earlier);
      expect(record.logins["test-login"]).toEqual({ at: done.loginAt, type: "oauth" });
      expect(done.warning).toBeNull();
    } finally {
      await app.close();
    }

    const broken = await boot({ record: "{ not json at all\n" });
    try {
      const started = await broken.post(START, { provider: "test-login", type: "oauth" });
      const session: string = started.body.session;
      await waitState(broken, session, (state) => state.status === "prompt", "the method question");
      await broken.post(ANSWER, { session, value: "copy_code" });
      await waitState(broken, session, (state) => state.status === "prompt" && state.prompt?.type === "manual_code", "the code question");
      await broken.post(ANSWER, { session, value: LOGIN_CODE });
      const done = await waitState(broken, session, (state) => state.status === "succeeded", "the success");

      // A corrupt file does not block the login. It costs the warning line, and the pass starts from an empty record.
      expect(typeof done.warning).toBe("string");
      expect(done.warning).toContain("warning: the login time was not recorded in");
      expect(done.warning).toContain(broken.paths.modelLoginsFile);
      const record = await recordFile(broken.paths);
      expect(record.version).toBe(1);
      expect(record.logins["test-login"]).toEqual({ at: done.loginAt, type: "oauth" });
      // The warning is in the app log too, and it names no value.
      const log = await readFile(broken.paths.appLog, "utf8");
      expect(log).toContain("login record file replaced");
    } finally {
      await broken.close();
    }
  });

  it("writes no record entry for a failure, a cancel or a timeout, and audits each", async () => {
    const app = await boot({ sessionTimeoutMs: 400 });
    try {
      // A flow that fails before it asks anything.
      const failing = await app.post(START, { provider: "test-fail", type: "oauth" });
      expect(failing.status, failing.text).toBe(200);
      const failed = await waitState(app, failing.body.session, (state) => state.status === "failed", "the failure");
      expect(failed.reason).toBe("failed");

      // A rejected code: the failure came after an answer to a code question.
      const started = await app.post(START, { provider: "test-login", type: "oauth" });
      const session: string = started.body.session;
      await waitState(app, session, (state) => state.status === "prompt", "the method question");
      await app.post(ANSWER, { session, value: "copy_code" });
      await waitState(app, session, (state) => state.status === "prompt" && state.prompt?.type === "manual_code", "the code question");
      await app.post(ANSWER, { session, value: "not-the-code" });
      const rejected = await waitState(app, session, (state) => state.status === "failed", "the refusal");
      expect(rejected.reason).toBe("code_rejected");

      // Cancel while a question is open.
      const cancelling = await app.post(START, { provider: "test-login", type: "oauth" });
      const toCancel: string = cancelling.body.session;
      await waitState(app, toCancel, (state) => state.status === "prompt", "the method question");
      const cancelled = await app.post(CANCEL, { session: toCancel });
      expect(cancelled.status, cancelled.text).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");
      expect(cancelled.body.reason).toBe("cancelled");

      // The timeout ends a session that nobody answers.
      const timingOut = await app.post(START, { provider: "test-login", type: "oauth" });
      const timedOut = await waitState(app, timingOut.body.session, (state) => state.status === "timeout", "the timeout");
      expect(timedOut.reason).toBe("timeout");

      // No credential, no record entry, and one audit row per session.
      expect(await readdir(app.paths.secretsDir).catch(() => [])).not.toContain("model-auth.test-login.access");
      await expect(readFile(app.paths.modelLoginsFile, "utf8")).rejects.toThrow();

      const rows = await auditRows(app.paths, "model_login");
      expect(rows.map((row) => row.outcome)).toEqual(["failed", "failed", "cancelled", "timeout"]);
      expect(rows.map((row) => row.provider)).toEqual(["test-fail", "test-login", "test-login", "test-login"]);
    } finally {
      await app.close();
    }
  });

  it("refuses another origin, a non-JSON body, a wrong session id, a second start and plain HTTP", async () => {
    const app = await boot();
    try {
      // The global Origin guard answers before the route does.
      const foreign = await app.post(START, { provider: "test-login", type: "oauth" }, { origin: "https://elsewhere.test" });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe("origin_forbidden");

      const text = await app.post(START, { provider: "test-login", type: "oauth" }, { "content-type": "text/plain" });
      expect(text.status).toBe(415);
      expect(text.body.error.code).toBe("json_required");
      expect(text.body.error.message).toBe("send this request with Content-Type: application/json");

      const unknown = await app.post(STATE, { session: "no-such-session" });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe("login_not_found");

      const live = await app.post(START, { provider: "test-login", type: "oauth" });
      expect(live.status, live.text).toBe(200);
      await waitState(app, live.body.session, (state) => state.status === "prompt", "the method question");
      const second = await app.post(START, { provider: "acme", type: "oauth" });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("login_busy");
      await app.post(CANCEL, { session: live.body.session });

      // An answer to a session that is not waiting for one.
      const idle = await app.post(ANSWER, { session: live.body.session, value: "x" });
      expect(idle.status).toBe(409);
      expect(idle.body.error.code).toBe("login_no_prompt");

      // A type the provider does not offer.
      const wrongType = await app.post(START, { provider: "test-login", type: "api_key" });
      expect(wrongType.status).toBe(400);
      expect(wrongType.body.error.code).toBe("login_type_unavailable");

      // An unknown provider.
      const unknownProvider = await app.post(START, { provider: "no-such-provider", type: "oauth" });
      expect(unknownProvider.status).toBe(404);
      expect(unknownProvider.body.error.code).toBe("unknown_provider");
    } finally {
      await app.close();
    }

    // A start that arrives under a public name on a plain-HTTP address is
    // refused: the sign-in link carries the proof that binds the answer to this
    // flow, and it must not cross a network in the clear.
    const publicApp = await boot({ publicUrl: "http://pi.example.test" });
    try {
      const refused = await request(publicApp.origin, {
        method: "POST",
        path: START,
        headers: { host: "pi.example.test", "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-login", type: "oauth" }),
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("https_required");

      // From this machine the same daemon starts a login: loopback needs no
      // transport.
      const fromHost = await publicApp.post(START, { provider: "test-login", type: "oauth" });
      expect(fromHost.status, fromHost.text).toBe(200);
      await publicApp.post(CANCEL, { session: fromHost.body.session });
    } finally {
      await publicApp.close();
    }
  });

  it("signs a provider in with an API key, which the flow asks for as a secret", async () => {
    const app = await boot();
    try {
      const started = await app.post(START, { provider: "acme-native", type: "api_key" });
      expect(started.status, started.text).toBe(200);
      const session: string = started.body.session;
      const asking = await waitState(app, session, (state) => state.status === "prompt", "the key question");
      expect(asking.prompt.type).toBe("secret");
      expect(asking.prompt.message).toBe("Enter Acme native API key");

      await app.post(ANSWER, { session, value: ACME_API_KEY });
      const done = await waitState(app, session, (state) => state.status === "succeeded", "the success");
      expect(done.loginAt).not.toBeNull();
      expect(await readFile(join(app.paths.secretsDir, "model-auth.acme-native.key"), "utf8")).toBe(ACME_API_KEY);
      expect(await readFile(app.paths.authFile, "utf8")).not.toContain(ACME_API_KEY);
      const record = await recordFile(app.paths);
      expect(record.logins["acme-native"]).toEqual({ at: done.loginAt, type: "api_key" });
      const rows = await auditRows(app.paths, "model_login");
      expect(rows.map((row) => [row.provider, row.loginType, row.outcome])).toEqual([
        ["acme-native", "api_key", "success"],
      ]);
    } finally {
      await app.close();
    }
  });

  it("lists the providers with the extension that registered them and their credential state", async () => {
    const app = await boot();
    try {
      const listed = await app.get(PROVIDERS);
      expect(listed.status).toBe(200);
      expect(listed.body.available).toBe(true);
      expect(listed.body.rootProvider).toBe("acme");
      expect(listed.body.sessionActive).toBe(false);
      const byId = new Map<string, any>(listed.body.providers.map((entry: any) => [entry.id, entry]));

      const acme = byId.get("acme");
      expect(acme).toBeDefined();
      expect(acme.extension).toBe("acme");
      expect(acme.types).toContain("oauth");
      // The fixture's config-form provider also carries an API key, and the
      // runtime gives it the key prompt that goes with one.
      expect(acme.types).toContain("api_key");
      expect(acme.configured).toBe(true);

      const native = byId.get("acme-native");
      expect(native.extension).toBe("acme");
      expect(native.types).toEqual(["api_key"]);

      // A provider with nothing stored is reported as unconfigured, which is
      // what makes the page say so.
      expect(byId.get("test-login")?.configured).toBe(false);
      // A built-in provider has no extension behind it.
      expect(byId.get("anthropic")?.extension).toBeNull();
      // No login has been recorded yet.
      expect(byId.get("test-login")?.lastLogin).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("gives a login flow the installation ID it asks for, as a UUID from the state directory", async () => {
    const log = newDeviceIdLog();
    const app = await boot({ deviceIdLog: log });
    try {
      const done = await startDeviceLogin(app);
      expect(done.status, JSON.stringify(done)).toBe("succeeded");

      // The options carry the getter and nothing else: `agentName` is the Codex
      // originator, and that login keeps its default.
      expect(typeof log.options?.getDeviceId).toBe("function");
      expect(log.options?.agentName).toBeUndefined();

      expect(log.ids).toHaveLength(1);
      const id = log.ids[0] as string;
      expect(id).toMatch(UUID_V4);

      // The file holds the same ID, one line, readable by this user only.
      const file = join(app.paths.stateDir, DEVICE_ID_FILE);
      expect(await readFile(file, "utf8")).toBe(`${id}\n`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await app.close();
    }
  });

  it("keeps one installation ID across logins and across a runtime on the same state", async () => {
    // The rule lives in the function that every login and every runtime calls on the same file,
    // so the case calls it three times. The manager passing it to the flow is the wiring case above.
    const root = await mkdtemp(join(tmpdir(), "pi-sec-device-id-"));
    roots.push(root);
    const file = join(root, DEVICE_ID_FILE);
    const id = readOrCreateDeviceId(file);
    const written = await readFile(file, "utf8");
    // A rewrite would give the file a new time, so the test gives it an old
    // one and looks for that time after the next call.
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    const stamp = (await stat(file)).mtimeMs;

    // A second login, and a new runtime over the same home, which is what a daemon restart leaves.
    expect(readOrCreateDeviceId(file)).toBe(id);
    expect(readOrCreateDeviceId(file)).toBe(id);
    expect(await readFile(file, "utf8")).toBe(written);
    expect((await stat(file)).mtimeMs).toBe(stamp);
  });

  it("fails a login that needs the ID when the file holds no UUID, and leaves the file as it is", async () => {
    const log = newDeviceIdLog();
    const app = await boot({ deviceIdLog: log });
    try {
      const file = join(app.paths.stateDir, DEVICE_ID_FILE);
      const broken = "this file holds no uuid\n";
      await writeFile(file, broken, "utf8");

      const failed = await startDeviceLogin(app);
      expect(failed.status, JSON.stringify(failed)).toBe("failed");
      expect(failed.reason).toBe("failed");
      // The flow never got an ID, and the file is exactly as it was.
      expect(log.ids).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(broken);

      // A second attempt fails the same way, and the log still holds one
      // sentence that names the file.
      expect((await startDeviceLogin(app)).status).toBe("failed");
      expect(await readFile(file, "utf8")).toBe(broken);
      const appLog = await readFile(app.paths.appLog, "utf8");
      expect(appLog.split("device ID file").length - 1).toBe(1);
      expect(appLog).toContain(file);

      // Two failures, so no record entry and two audit rows.
      const rows = await auditRows(app.paths, "model_login");
      expect(rows.map((row) => [row.provider, row.outcome])).toEqual([
        ["test-device", "failed"],
        ["test-device", "failed"],
      ]);
      await expect(readFile(app.paths.modelLoginsFile, "utf8")).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it("keeps the sign-in link, the pasted code and the API key out of the app log and the audit log", async () => {
    const app = await boot();
    try {
      const started = await app.post(START, { provider: "test-login", type: "oauth" });
      const session: string = started.body.session;
      await waitState(app, session, (state) => state.status === "prompt", "the method question");
      await app.post(ANSWER, { session, value: "copy_code" });
      await waitState(app, session, (state) => state.status === "prompt" && state.prompt?.type === "manual_code", "the code question");
      // A code the flow rejects: its error sentence carries the value, which is
      // exactly the kind of text that must not travel further.
      await app.post(ANSWER, { session, value: LOGIN_CODE });
      await waitState(app, session, (state) => state.status === "succeeded", "the success");

      const key = await app.post(START, { provider: "acme-native", type: "api_key" });
      const keySession: string = key.body.session;
      await waitState(app, keySession, (state) => state.status === "prompt", "the key question");
      await app.post(ANSWER, { session: keySession, value: ACME_API_KEY });
      await waitState(app, keySession, (state) => state.status === "succeeded", "the key success");

      const appLog = await readFile(app.paths.appLog, "utf8");
      const auditLog = await readFile(app.paths.auditLog, "utf8");
      for (const value of [AUTH_URL, LOGIN_CODE, ACME_API_KEY, ACME_ACCESS, ACME_REFRESH, LOGIN_ACCESS, LOGIN_REFRESH]) {
        expect(appLog).not.toContain(value);
        expect(auditLog).not.toContain(value);
      }
      // The session ids are not written down either.
      expect(appLog).not.toContain(session);
      expect(auditLog).not.toContain(session);
    } finally {
      await app.close();
    }
  });

  it("drops a finished session's state after the retention window", async () => {
    const app = await boot({ finishedRetentionMs: 200 });
    try {
      const failing = await app.post(START, { provider: "test-fail", type: "oauth" });
      const session: string = failing.body.session;
      await waitState(app, session, (state) => state.status === "failed", "the failure");
      await sleep(400);
      const gone = await app.post(STATE, { session });
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe("login_not_found");
    } finally {
      await app.close();
    }
  });
});
