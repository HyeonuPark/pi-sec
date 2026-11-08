/**
 * Setup mode of the real daemon.
 *
 * The test spawns `src/cli.ts start` in a temporary home with its own port, as
 * `extension-providers-daemon.test.ts` does. Nothing reaches a running daemon: the
 * environment holds only the temporary home, and the port comes from a range a
 * running daemon does not use.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths } from "../src/runtime/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXED_SENTENCE =
  "No model is set up yet. Choose one on the web page, or run `pi-sec setup-model --provider <id> --model <id>` on the server and then load the configuration.";

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

async function freePort(): Promise<number> {
  for (let port = 19200; port < 19300; port += 1) {
    const taken = await new Promise<boolean>((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
    });
    if (!taken) return port;
  }
  throw new Error("no free port in 19200-19299");
}

interface Sandbox {
  readonly home: string;
  readonly port: number;
  readonly origin: string;
  readonly env: NodeJS.ProcessEnv;
}

async function sandbox(config: unknown): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-model-setup-daemon-"));
  roots.add(root);
  const home = join(root, ".pi", "sec");
  const homeDir = join(root, "home");
  await mkdir(join(home, "prompts", "vmodel"), { recursive: true });
  await mkdir(join(home, "workspace"), { recursive: true });
  await mkdir(join(home, "snapshot"), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  // A source checkout has no built `dist/prompts`, so this home carries its own.
  await writeFile(join(home, "prompts", "vmodel", "default.md"), "", "utf8");
  // `setup-model` names the two root roles, and the reload reads them.
  await mkdir(join(home, "prompts", "role"), { recursive: true });
  for (const role of ["root-agent", "user-facing-agent"]) await writeFile(join(home, "prompts", "role", `${role}.md`), "", "utf8");
  const port = await freePort();
  await writeFile(join(home, "config.json"), `${JSON.stringify({ server: { port }, ...(config as object) }, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    home,
    port,
    origin: `http://127.0.0.1:${port}`,
    env: { PI_SEC_HOME: home, HOME: homeDir, PATH: process.env.PATH, TERM: "dumb" },
  };
}

interface Child {
  readonly process: ChildProcess;
  readonly run: Promise<{ code: number | null; output: string }>;
  output(): string;
}

function start(sb: Sandbox): Child {
  const child = spawn(process.execPath, [join(REPO, "src", "cli.ts"), "start", "--port", String(sb.port)], {
    cwd: REPO,
    env: sb.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.add(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const run = new Promise<{ code: number | null; output: string }>((settle) => {
    child.once("close", (code) => settle({ code, output }));
  });
  return { process: child, run, output: () => output };
}

async function waitReady(sb: Sandbox, child: Child): Promise<void> {
  const pidFile = buildPaths(sb.home).pidFile;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const text = await readFile(pidFile, "utf8").catch(() => undefined);
    if (text !== undefined && Number.parseInt(text.trim(), 10) === child.process.pid) return;
    if (Date.now() > deadline) throw new Error(`daemon not ready\n${child.output()}`);
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

async function portOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const probe = createServer();
    probe.once("error", () => settle(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
  });
}

async function status(sb: Sandbox): Promise<{ modelSetupRequired: boolean; vmodelKeys: string[]; configError: unknown; config: { vmodel: string } }> {
  const response = await fetch(`${sb.origin}/api/admin/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

async function postJson(sb: Sandbox, path: string, body: unknown): Promise<Response> {
  return await fetch(`${sb.origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cli(sb: Sandbox, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(REPO, "src", "cli.ts"), ...args], {
    cwd: REPO,
    env: sb.env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("a daemon with no root model", () => {
  it("starts in setup mode, answers healthz and refuses chat writes with 409 model_not_configured", async () => {
    // Condition 1 and 2: the default configuration, no vmodels, empty agent.vmodel.
    const sb = await sandbox({});
    const child = start(sb);
    await waitReady(sb, child);

    expect((await fetch(`${sb.origin}/healthz`)).status).toBe(200);
    const state = await status(sb);
    expect(state.modelSetupRequired).toBe(true);
    expect(state.vmodelKeys).toEqual([]);
    expect(state.config.vmodel).toBe("");

    const message = await postJson(sb, "/basic-chat/messages", { content: "hello" });
    expect(message.status).toBe(409);
    const refusal = (await message.json()) as { error: { code: string; message: string } };
    expect(refusal.error.code).toBe("model_not_configured");
    expect(refusal.error.message).toBe(FIXED_SENTENCE);
    for (const path of ["/basic-chat/abort", "/basic-chat/reset", "/basic-chat/compact", "/api/focused-chats"]) {
      const response = await postJson(sb, path, {});
      expect(response.status, path).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe("model_not_configured");
    }

    // The daemon survived every refusal.
    expect(child.process.exitCode).toBeNull();
    expect((await fetch(`${sb.origin}/healthz`)).status).toBe(200);
    const log = await readFile(join(sb.home, "logs", "app.log"), "utf8");
    expect(log).toContain("no root model is configured; serving the model setup notice");
    expect(log).not.toContain("root conversation preparation failed");
  }, 180_000);

  it("leaves setup mode on a reload after setup-model, with no restart (condition 3)", async () => {
    const sb = await sandbox({});
    const child = start(sb);
    await waitReady(sb, child);
    expect((await status(sb)).modelSetupRequired).toBe(true);

    const written = cli(sb, ["setup-model", "--provider", "anthropic", "--model", "claude-haiku-4-5"]);
    expect(written.status, written.stderr).toBe(0);
    // The file changed, the daemon did not: it is still in setup mode.
    expect((await status(sb)).modelSetupRequired).toBe(true);

    const reload = await postJson(sb, "/api/admin/reload", {});
    expect(reload.status, await reload.clone().text()).toBe(200);
    const after = await status(sb);
    expect(after.modelSetupRequired).toBe(false);
    expect(after.config.vmodel).toBe("root");
    expect(after.vmodelKeys).toContain("worker");
    // The root conversation exists now: a message is accepted.
    const accepted = await postJson(sb, "/basic-chat/messages", { content: "hello" });
    expect(accepted.status).toBe(202);
    expect((await fetch(`${sb.origin}/basic-chat/context`)).status).toBe(200);
    expect(child.process.exitCode).toBeNull();
  }, 180_000);

  it("reports a prompt file that is missing or a model outside the catalog on reload, and stays in setup mode (condition 4)", async () => {
    const sb = await sandbox({});
    const child = start(sb);
    await waitReady(sb, child);
    const configFile = join(sb.home, "config.json");

    const withRoot = (entry: Record<string, unknown>): string =>
      `${JSON.stringify({ server: { port: sb.port }, vmodels: { root: entry }, agent: { vmodel: "root" } }, null, 2)}\n`;

    await writeFile(configFile, withRoot({ provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "medium", prompt: "no-such-prompt" }));
    let reload = await postJson(sb, "/api/admin/reload", {});
    expect(reload.status).toBe(400);
    let answer = (await reload.json()) as { status: string; issues: string[] };
    expect(answer.status).toBe("config_failed");
    expect(answer.issues.join(" ")).toContain("no-such-prompt");
    let state = await status(sb);
    expect(state.modelSetupRequired).toBe(true);
    expect(state.configError).not.toBeNull();

    await writeFile(configFile, withRoot({ provider: "anthropic", modelId: "no-such-model", thinkingLevel: "medium", prompt: "default" }));
    reload = await postJson(sb, "/api/admin/reload", {});
    expect(reload.status).toBe(400);
    answer = (await reload.json()) as { status: string; issues: string[] };
    expect(answer.issues.join(" ")).toContain("anthropic/no-such-model");
    state = await status(sb);
    expect(state.modelSetupRequired).toBe(true);

    // A chat write still says there is no model, and the daemon is up.
    expect((await postJson(sb, "/basic-chat/messages", { content: "hello" })).status).toBe(409);
    expect(child.process.exitCode).toBeNull();
  }, 180_000);
});

describe("a daemon whose root vmodel is named but broken", () => {
  it("exits with code 2 before the port opens for a key that vmodels does not hold (condition 5)", async () => {
    const sb = await sandbox({
      vmodels: { root: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "medium", prompt: "default" } },
      agent: { vmodel: "nope" },
    });
    const child = start(sb);
    const run = await child.run;
    expect(run.code, run.output).toBe(2);
    expect(await portOpen(sb.port)).toBe(false);
    const log = await readFile(join(sb.home, "logs", "app.log"), "utf8");
    expect(log).toContain("the configured vmodel is not usable");
    expect(log).toContain('agent.vmodel \\"nope\\"');
  }, 120_000);

  it("exits with code 2 for a missing prompt file and for a model outside the catalog", async () => {
    for (const [modelId, prompt, expected] of [
      ["claude-haiku-4-5", "no-such-prompt", "the configured vmodel is not usable"],
      ["no-such-model", "default", "configured model is not in the catalog"],
    ] as const) {
      const sb = await sandbox({
        vmodels: { root: { provider: "anthropic", modelId, thinkingLevel: "medium", prompt } },
        agent: { vmodel: "root" },
      });
      const run = await start(sb).run;
      expect(run.code, run.output).toBe(2);
      expect(await portOpen(sb.port)).toBe(false);
      expect(await readFile(join(sb.home, "logs", "app.log"), "utf8")).toContain(expected);
    }
  }, 120_000);
});
