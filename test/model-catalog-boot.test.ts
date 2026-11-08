/**
 * The daemon's own boot writes `<home>/model-catalog.json` once.
 *
 * This test spawns the real CLI, because the point is what a boot does rather
 * than what one function returns: the write happens after the extensions are
 * loaded, it must not hold the boot, and nothing after it may write the file
 * again. The home, the port and every credential are this test's own.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths } from "../src/runtime/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The root vmodel names the extension's model, so the boot proves that the
 * extension was loaded before the catalog was read.
 *
 * The provider id is this test's own rather than a real service's: a daemon
 * with a stored credential asks the provider for its usage, and a made-up id
 * keeps that request off the network.
 */
const ROOT_PROVIDER = "catalog-only";
const ROOT_MODEL = "catalog-chat";

/** A stored credential of this test's own: it must not reach the file. */
const SECRET_FILE_NAME = `model-auth.${ROOT_PROVIDER}.key`;
const SECRET_VALUE = "fake-catalog-only-stored-key-000000000000";

/**
 * The extension this home carries, as a config pair with a literal key.
 *
 * The literal key is what makes the test deterministic: the runtime records a
 * provider configured by its own `apiKey` synchronously, so the daemon's file
 * and `pi-sec models` see the same answer. A provider that resolves its
 * credential in code is only marked configured after an asynchronous pass, and
 * a short-lived command can read it before that pass finishes.
 */
const EXTENSION_INDEX = `export const name = "catalog-only";

export function create() {
  return { name: "catalog-only", sections: [] };
}

export function providers() {
  return [
    {
      id: "catalog-only",
      config: {
        name: "Catalog Only (fake)",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "catalog-only-api",
        apiKey: "fake-catalog-only-key",
        models: [
          {
            id: "catalog-chat",
            name: "Catalog Chat",
            api: "catalog-only-api",
            provider: "catalog-only",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 4_096,
            reasoning: false,
          },
        ],
      },
    },
  ];
}
`;

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

/** A free port inside the range this test owns, so no other test's daemon is touched. */
async function freePort(): Promise<number> {
  for (let port = 19800; port < 19900; port += 1) {
    const taken = await new Promise<boolean>((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
    });
    if (!taken) return port;
  }
  throw new Error("no free port in 19800-19899");
}

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly port: number;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * One home and the smallest environment that reaches it.
 *
 * Nothing from `process.env` is spread in: this test starts daemons, and this
 * checkout's own `PI_SEC_HOME` names the home of the daemon serving the agent
 * running the test.
 */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-model-catalog-boot-"));
  roots.add(root);
  const home = join(root, ".pi", "sec");
  const homeDir = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const port = await freePort();
  return { root, home, port, env: { PI_SEC_HOME: home, HOME: homeDir, PATH: process.env.PATH, TERM: "dumb" } };
}

/** A home with the built-in root model, one stored credential, and one extension provider. */
async function writeHome(sb: Sandbox): Promise<void> {
  await mkdir(join(sb.home, "extensions", "catalog-only"), { recursive: true });
  await writeFile(join(sb.home, "extensions", "catalog-only", "index.js"), EXTENSION_INDEX, "utf8");
  // The vmodel names the shipped `prompts/vmodel/default.md`. Running from the
  // sources there is no built `dist/prompts`, so this home carries its own.
  await mkdir(join(sb.home, "prompts", "vmodel"), { recursive: true });
  await writeFile(join(sb.home, "prompts", "vmodel", "default.md"), "", "utf8");
  await mkdir(join(sb.home, "workspace"), { recursive: true });
  await mkdir(join(sb.home, "snapshot"), { recursive: true });

  // A credential in the shape the daemon reads: `auth.json` names a secret file.
  // The value must never reach the catalog file, and neither must the file name.
  await mkdir(join(sb.home, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(join(sb.home, "secrets", SECRET_FILE_NAME), SECRET_VALUE, { mode: 0o600 });
  await writeFile(
    join(sb.home, "auth.json"),
    `${JSON.stringify({ [ROOT_PROVIDER]: { type: "api_key", key: { file: SECRET_FILE_NAME } } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const config = {
    server: { port: sb.port },
    timezone: "Asia/Tokyo",
    vmodels: {
      root: { provider: ROOT_PROVIDER, modelId: ROOT_MODEL, thinkingLevel: "medium", prompt: "default" },
    },
    agent: { vmodel: "root", roles: [] },
  };
  await writeFile(join(sb.home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

interface Child {
  readonly process: ChildProcess;
  readonly run: Promise<{ code: number | null; stdout: string; stderr: string }>;
  output(): string;
}

function start(sb: Sandbox): Child {
  const child = spawn(
    process.execPath,
    [join(REPO, "src", "cli.ts"), "start", "--port", String(sb.port)],
    { cwd: REPO, env: sb.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.add(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const run = new Promise<{ code: number | null; stdout: string; stderr: string }>((settle) => {
    child.once("close", (code) => settle({ code, stdout: output, stderr: output }));
  });
  return { process: child, run, output: () => output };
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
  onTimeout: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${onTimeout()}`);
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/** Wait until this home's pid file names the child. */
async function waitReady(sb: Sandbox, child: Child): Promise<void> {
  const pidFile = buildPaths(sb.home).pidFile;
  await waitFor(
    async () => {
      const text = await readFile(pidFile, "utf8").catch(() => undefined);
      if (text === undefined) return undefined;
      return Number.parseInt(text.trim(), 10) === child.process.pid ? true : undefined;
    },
    90_000,
    `pid ${child.process.pid} in ${pidFile}`,
    () => child.output(),
  );
}

interface Catalog {
  readonly note?: string;
  readonly generatedAt?: string;
  readonly providers?: {
    id: string;
    source?: string;
    configured?: boolean;
    virtual?: boolean;
    models?: { id: string; name?: string }[];
    error?: string;
  }[];
}

async function readCatalog(sb: Sandbox): Promise<Catalog> {
  return JSON.parse(await readFile(buildPaths(sb.home).modelCatalogFile, "utf8")) as Catalog;
}

/** Wait until the boot's write has happened. */
async function waitCatalog(sb: Sandbox, child: Child): Promise<Catalog> {
  return waitFor(
    async () => readCatalog(sb).catch(() => undefined),
    60_000,
    "model-catalog.json",
    () => child.output(),
  );
}

/** The `provider/modelId` pairs the catalog file lists. */
function filePairs(catalog: Catalog): string[] {
  return (catalog.providers ?? []).flatMap((provider) =>
    (provider.models ?? []).map((model) => `${provider.id}/${model.id}`),
  );
}

/** The pairs `pi-sec models` prints with `auth=yes` on this home. */
function modelsPairs(sb: Sandbox): string[] {
  const run = spawnSync(
    process.execPath,
    [join(REPO, "src", "cli.ts"), "models"],
    { cwd: REPO, env: sb.env, encoding: "utf8" },
  );
  expect(run.status, `${run.stderr}`).toBe(0);
  const pairs: string[] = [];
  for (const line of run.stdout.split("\n")) {
    if (line === "") continue;
    const [name, ...fields] = line.split("\t");
    if (fields.includes("auth=yes")) pairs.push(name!);
  }
  return pairs.sort();
}

afterEach(async () => {
  for (const child of spawned) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawned.clear();
  for (const root of roots) {
    await unlink(join(root, ".pi", "sec", "extensions", "node_modules")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("the model catalog written at boot", () => {
  it("lists exactly the providers with credentials, 0600, and no credential in the body", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const child = start(sb);
    await waitReady(sb, child);
    const catalog = await waitCatalog(sb, child);
    const paths = buildPaths(sb.home);

    // The set the file holds is the set the same catalog offers to a request,
    // which is what `vmodels` may name.
    expect(filePairs(catalog).sort()).toEqual(modelsPairs(sb));
    expect(filePairs(catalog).sort()).toEqual(["catalog-only/catalog-chat"]);
    // A provider an extension registered is in the file under its extension.
    const fromExtension = catalog.providers?.find((provider) => provider.id === "catalog-only");
    expect(fromExtension?.source).toBe("extension:catalog-only");
    expect(fromExtension?.configured).toBe(true);
    // The stamp is the configured zone's, with that zone's offset.
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    expect(catalog.note).toContain("pi-sec");

    expect((await stat(paths.modelCatalogFile)).mode & 0o777).toBe(0o600);

    const body = await readFile(paths.modelCatalogFile, "utf8");
    expect(body).not.toContain(SECRET_VALUE);
    expect(body).not.toContain(SECRET_FILE_NAME);
    expect(body).not.toContain("fake-catalog-only-key");
  }, 180_000);

  it("is not written again when SIGHUP reloads the extensions", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const child = start(sb);
    await waitReady(sb, child);
    const paths = buildPaths(sb.home);
    await waitCatalog(sb, child);

    const before = await stat(paths.modelCatalogFile);
    const bodyBefore = await readFile(paths.modelCatalogFile, "utf8");
    child.process.kill("SIGHUP");
    await new Promise((settle) => setTimeout(settle, 1500));

    const after = await stat(paths.modelCatalogFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(paths.modelCatalogFile, "utf8")).toBe(bodyBefore);
  }, 180_000);

  it("still boots with one warning when the file cannot be written", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const paths = buildPaths(sb.home);
    // A directory where the file goes: the rename the write ends with cannot
    // replace it, so the write fails after the boot's own checks have passed.
    await mkdir(paths.modelCatalogFile, { recursive: true });
    const child = start(sb);
    await waitReady(sb, child);

    const log = await waitFor(
      async () => {
        const text = await readFile(paths.appLog, "utf8").catch(() => undefined);
        if (text === undefined || !text.includes("model catalog not written")) return undefined;
        return text;
      },
      30_000,
      "the model catalog warning in the app log",
      () => child.output(),
    );
    const warnings = log.split("\n").filter((line) => line.includes("model catalog not written"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("model-catalog.json");
  }, 180_000);
});
