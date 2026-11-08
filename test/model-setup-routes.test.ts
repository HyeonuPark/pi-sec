/**
 * The two model setup routes.
 *
 * One real `ModelRuntime` over a temporary home, with the fixture provider `acme`
 * and a `models.json` provider `local-fake` in its catalog, and the real
 * configuration reload. The same starting `config.json` is also given to
 * `pi-sec setup-model` in a second home, and the two files are compared byte for
 * byte. Every credential is a fake and nothing reaches a network.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { createModels } from "../src/agent/models.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { ProviderRegistry, preloadExtensionProviders } from "../src/registry/providers.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus } from "../src/runtime/event-bus.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { createConfigReloader } from "../src/server/config-reload.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/acme/", import.meta.url));
const MODEL_FIELDS = { provider: "acme", model: "acme-fake-chat" };
const ENDPOINT_KEY = "fake-local-endpoint-key-for-setup-test";

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const root of roots.splice(0)) {
    await rm(join(root, ".pi", "sec", "extensions", "node_modules"), { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/** A `models.json` provider: a second model id, so a worker can differ from the root. */
const MODELS_JSON = JSON.stringify({
  providers: {
    "local-fake": {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: ENDPOINT_KEY,
      models: [
        {
          id: "fake-local",
          name: "Fake Local",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 1_024,
          reasoning: false,
        },
      ],
    },
  },
});

/** The files a home needs: providers, the shipped-prompt stand-ins and a starting config. */
async function prepareHome(root: string, startingConfig: string): Promise<Paths> {
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
  await cp(FIXTURE, join(paths.extensionsDir, "acme"), { recursive: true });
  await writeFile(join(paths.extensionsDir, "acme", "config.json"), JSON.stringify({ answer: "setup fixture" }), "utf8");
  await writeFile(paths.modelsFile, MODELS_JSON, "utf8");
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await mkdir(join(paths.promptsDir, "role"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "default.md"), "", "utf8");
  for (const role of ["root-agent", "user-facing-agent"]) await writeFile(join(paths.promptsDir, "role", `${role}.md`), "", "utf8");
  await writeFile(paths.configFile, startingConfig, { mode: 0o600 });
  return paths;
}

interface Boot {
  readonly origin: string;
  readonly paths: Paths;
  readonly runtime: AgentRuntime;
  readonly configText: () => Promise<string>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  readonly auditRows: () => Promise<{ type: string; [key: string]: unknown }[]>;
}

async function boot(startingConfig = "{}\n", options: { prompts?: boolean } = {}): Promise<Boot> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-model-setup-routes-"));
  roots.push(root);
  const paths = await prepareHome(root, startingConfig);
  if (options.prompts === false) await rm(join(paths.promptsDir, "vmodel", "default.md"));

  const base = defaultConfig();
  const config: Config = {
    ...base,
    server: { ...base.server, port: 0 },
    code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
  };
  const secrets = new SecretRegistry({ dir: paths.secretsDir });
  await secrets.load();
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
    providers,
  });
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
    reloadConfig: createConfigReloader({ home: paths.home, runtime }),
  };
  const started: StartedServer = await startServer(deps, { webDir: defaultWebDir() });
  closers.push(async () => {
    await started.close();
    await runtime.close();
  });
  return {
    origin: started.origin,
    paths,
    runtime,
    configText: () => readFile(paths.configFile, "utf8"),
    post: (path, body, headers) =>
      fetch(`${started.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    auditRows: async () =>
      (await readFile(paths.auditLog, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { type: string }),
  };
}

/** `pi-sec setup-model` in a second home that starts from the same file. */
async function runCommand(startingConfig: string, args: readonly string[]): Promise<{ status: number | null; stderr: string; config: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-model-setup-cli-"));
  roots.push(root);
  const paths = await prepareHome(root, startingConfig);
  const homeDir = join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const result = spawnSync(process.execPath, [join(REPO, "src", "cli.ts"), "setup-model", ...args], {
    cwd: REPO,
    env: { PI_SEC_HOME: paths.home, HOME: homeDir, PATH: process.env.PATH, TERM: "dumb" },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, config: await readFile(paths.configFile, "utf8") };
}

describe("POST /api/admin/model-setup", () => {
  it("leaves the same config.json bytes as `pi-sec setup-model` for the same input (condition 7)", async () => {
    const starting = `${JSON.stringify({ server: { port: 8123 }, timezone: "Asia/Tokyo" }, null, 2)}\n`;

    // One case with a worker model and a thinking level.
    const web = await boot(starting);
    const saved = await web.post("/api/admin/model-setup", {
      ...MODEL_FIELDS,
      thinking: "high",
      workerProvider: "local-fake",
      workerModel: "fake-local",
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const command = await runCommand(starting, [
      "--provider", "acme", "--model", "acme-fake-chat", "--thinking", "high",
      "--worker-provider", "local-fake", "--worker-model", "fake-local",
    ]);
    expect(command.status, command.stderr).toBe(0);
    expect(await web.configText()).toBe(command.config);
    expect(JSON.parse(command.config).vmodels.worker.modelId).toBe("fake-local");

    // One case with the replace checkbox: the file already declares the four.
    const existing = `${JSON.stringify(
      { vmodels: { root: { provider: "old", modelId: "old", thinkingLevel: "low", prompt: "default" }, worker: { provider: "old", modelId: "old", thinkingLevel: "low", prompt: "default" } } },
      null,
      2,
    )}\n`;
    const webForce = await boot(existing);
    const savedForce = await webForce.post("/api/admin/model-setup", { ...MODEL_FIELDS, force: true });
    expect(savedForce.status, await savedForce.clone().text()).toBe(200);
    const commandForce = await runCommand(existing, ["--provider", "acme", "--model", "acme-fake-chat", "--force"]);
    expect(commandForce.status, commandForce.stderr).toBe(0);
    expect(await webForce.configText()).toBe(commandForce.config);
    expect(JSON.parse(commandForce.config).vmodels.root.provider).toBe("acme");
  }, 120_000);

  it("ends setup mode and creates the root conversation in one request (condition 10)", async () => {
    const web = await boot();
    const before = await fetch(`${web.origin}/api/admin/status`);
    expect(((await before.json()) as { modelSetupRequired: boolean }).modelSetupRequired).toBe(true);
    expect((await fetch(`${web.origin}/basic-chat/context`)).status).toBe(503);

    const saved = await web.post("/api/admin/model-setup", MODEL_FIELDS);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ status: "saved", root: "acme/acme-fake-chat", worker: "acme/acme-fake-chat", thinking: "medium" });

    const after = (await (await fetch(`${web.origin}/api/admin/status`)).json()) as { modelSetupRequired: boolean; config: { vmodel: string } };
    expect(after.modelSetupRequired).toBe(false);
    expect(after.config.vmodel).toBe("root");
    expect((await fetch(`${web.origin}/basic-chat/context`)).status).toBe(200);

    const rows = (await web.auditRows()).filter((row) => row.type === "model_setup");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "acme", model: "acme-fake-chat", outcome: "saved" });
  }, 60_000);

  it("lets only one of two simultaneous saves write", async () => {
    const web = await boot();
    const results = await Promise.all([
      web.post("/api/admin/model-setup", MODEL_FIELDS),
      web.post("/api/admin/model-setup", { ...MODEL_FIELDS, thinking: "low" }),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = results.find((response) => response.status === 409)!;
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("model_already_configured");
  }, 60_000);

  it("refuses outside setup mode with 409 model_already_configured and keeps the file (condition 8)", async () => {
    const web = await boot();
    expect((await web.post("/api/admin/model-setup", MODEL_FIELDS)).status).toBe(200);
    const bytes = await web.configText();

    const again = await web.post("/api/admin/model-setup", { ...MODEL_FIELDS, thinking: "low", force: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("model_already_configured");
    expect(await web.configText()).toBe(bytes);
  }, 60_000);

  it("refuses each bad request and leaves config.json as it was (condition 9)", async () => {
    const existing = `${JSON.stringify({ vmodels: { root: { provider: "old", modelId: "old", thinkingLevel: "low", prompt: "default" } } }, null, 2)}\n`;
    const web = await boot(existing);
    const bytes = await web.configText();
    const expectRefused = async (response: Response, status: number, code: string): Promise<void> => {
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(await web.configText()).toBe(bytes);
    };

    // Not the JSON content type: a cross-site form cannot send it.
    await expectRefused(
      await fetch(`${web.origin}/api/admin/model-setup`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(MODEL_FIELDS),
      }),
      415,
      "json_required",
    );
    // An Origin of another site, stopped by the global guard.
    await expectRefused(
      await web.post("/api/admin/model-setup", MODEL_FIELDS, { origin: "https://evil.example" }),
      403,
      "origin_forbidden",
    );
    // A model outside the catalog, for the root and for the worker.
    await expectRefused(
      await web.post("/api/admin/model-setup", { provider: "acme", model: "no-such-model", force: true }),
      400,
      "model_not_in_catalog",
    );
    await expectRefused(
      await web.post("/api/admin/model-setup", { ...MODEL_FIELDS, workerProvider: "acme", workerModel: "no-such-model", force: true }),
      400,
      "model_not_in_catalog",
    );
    // Existing vmodels without the replace checkbox.
    await expectRefused(await web.post("/api/admin/model-setup", MODEL_FIELDS), 409, "write_refused");
    // Field errors.
    await expectRefused(await web.post("/api/admin/model-setup", { provider: "acme" }), 400, "invalid_request");
    await expectRefused(await web.post("/api/admin/model-setup", { ...MODEL_FIELDS, thinking: "max" }), 400, "invalid_request");
    await expectRefused(await web.post("/api/admin/model-setup", { ...MODEL_FIELDS, workerProvider: "acme" }), 400, "invalid_request");

    // A missing prompt file, in a home of its own.
    const noPrompt = await boot("{}\n", { prompts: false });
    const noPromptBytes = await noPrompt.configText();
    const refused = await noPrompt.post("/api/admin/model-setup", MODEL_FIELDS);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("prompt_missing");
    expect(await noPrompt.configText()).toBe(noPromptBytes);
    // Nothing was left beside the file either.
    expect((await readdir(noPrompt.paths.home)).filter((name) => name.endsWith(".config.json"))).toEqual([]);
  }, 120_000);
});

describe("GET /api/admin/model-setup/models", () => {
  it("lists only providers with a credential, with ids and names, and no credential value (condition 11)", async () => {
    const web = await boot();
    // The `models.json` provider carries a key; the fixture provider has no login.
    const list = await fetch(`${web.origin}/api/admin/model-setup/models`);
    expect(list.status).toBe(200);
    const text = await list.text();
    const body = JSON.parse(text) as {
      providers: { id: string; models: { id: string; name: string }[] }[];
      existingVmodels: string[];
      modelSetupRequired: boolean;
    };
    const login = (await (await fetch(`${web.origin}/api/admin/model-login/providers`)).json()) as {
      providers: { id: string; configured: boolean }[];
    };
    const configured = login.providers.filter((provider) => provider.configured).map((provider) => provider.id).sort();
    expect(body.providers.map((provider) => provider.id).sort()).toEqual(configured);
    // The route would be empty if no provider were signed in, which proves nothing.
    expect(configured).toContain("local-fake");
    const local = body.providers.find((provider) => provider.id === "local-fake")!;
    expect(local.models).toEqual([{ id: "fake-local", name: "Fake Local" }]);
    for (const provider of body.providers) for (const model of provider.models) expect(Object.keys(model).sort()).toEqual(["id", "name"]);
    expect(body.modelSetupRequired).toBe(true);
    expect(body.existingVmodels).toEqual([]);
    expect(text).not.toContain(ENDPOINT_KEY);

    // It answers outside setup mode too, and names the vmodels the file declares.
    expect((await web.post("/api/admin/model-setup", { provider: "local-fake", model: "fake-local" })).status).toBe(200);
    const later = (await (await fetch(`${web.origin}/api/admin/model-setup/models`)).json()) as {
      existingVmodels: string[];
      modelSetupRequired: boolean;
    };
    expect(later.modelSetupRequired).toBe(false);
    expect(later.existingVmodels).toEqual(["root", "orchestrator", "planner", "worker"]);
  }, 60_000);
});
