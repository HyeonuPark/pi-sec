/**
 * A daemon whose root vmodel names a model only a runtime extension provides.
 *
 * This test spawns the real CLI. Nothing else proves the point: under vitest a
 * bare import inside an extension resolves through Vite from the project root,
 * so the module loads even when the real loader could not resolve it. A child
 * process resolves the way the daemon does, through the `node_modules` link the
 * preload establishes before it imports anything.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths } from "../src/runtime/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/acme/", import.meta.url));
const ANSWER = "the extension provider answered";

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

/** A free port inside a range that tests use, so a running daemon is never touched. */
async function freePort(): Promise<number> {
  for (let port = 19100; port < 19200; port += 1) {
    const taken = await new Promise<boolean>((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
    });
    if (!taken) return port;
  }
  throw new Error("no free port in 19100-19199");
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
 * Nothing from `process.env` is spread in. This test starts daemons, and this
 * checkout's own `PI_SEC_HOME` names the home of the daemon serving the agent
 * running the test. `PI_SEC_RUNNER`, `NOTIFY_SOCKET` and the systemd variables
 * are left out for the same reason.
 */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-provider-daemon-"));
  roots.add(root);
  const home = join(root, ".pi", "sec");
  const homeDir = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const port = await freePort();
  return { root, home, port, env: { PI_SEC_HOME: home, HOME: homeDir, PATH: process.env.PATH, TERM: "dumb" } };
}

/** A config whose root vmodel names the fixture provider's model. */
async function writeHome(
  sb: Sandbox,
  options: { readonly broken?: boolean; readonly deadVmodel?: boolean } = {},
): Promise<void> {
  await mkdir(join(sb.home, "extensions"), { recursive: true });
  await cp(FIXTURE, join(sb.home, "extensions", "acme"), { recursive: true });
  if (options.broken === true) {
    // A module that cannot even be parsed: the extension contributes no
    // provider, so the boot's catalog check has nothing to name.
    await writeFile(join(sb.home, "extensions", "acme", "index.js"), "export const providers = [ };\n", "utf8");
  } else {
    await writeFile(
      join(sb.home, "extensions", "acme", "config.json"),
      JSON.stringify({ answer: ANSWER }),
      "utf8",
    );
  }
  // The vmodel names the shipped `prompts/vmodel/default.md`. Running from the
  // sources there is no built `dist/prompts`, so this home carries its own.
  await mkdir(join(sb.home, "prompts", "vmodel"), { recursive: true });
  await writeFile(join(sb.home, "prompts", "vmodel", "default.md"), "", "utf8");
  // The agent's own working directory, which a tool call would need.
  await mkdir(join(sb.home, "workspace"), { recursive: true });
  await mkdir(join(sb.home, "snapshot"), { recursive: true });

  const config = {
    server: { port: sb.port },
    vmodels: {
      root: { provider: "acme", modelId: "acme-fake-chat", thinkingLevel: "medium", prompt: "default" },
      // A vmodel nothing can serve. The boot must survive it and say so after
      // the load, because only a reload can take a model away later.
      ...(options.deadVmodel === true
        ? { dead: { provider: "acme", modelId: "no-such-model", thinkingLevel: "medium", prompt: "default" } }
        : {}),
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

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, what: string, onTimeout: () => string): Promise<T> {
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

interface Entry {
  readonly id: number;
  readonly kind: string;
  readonly model?: { content?: unknown }[];
}

function textOf(entries: readonly Entry[]): string {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.assistant") continue;
    for (const message of entry.model ?? []) {
      const content = message.content;
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        texts.push(
          content
            .map((block) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
            .join(""),
        );
      }
    }
  }
  return texts.join("\n").trim();
}

/** One operator message through the daemon's own route, then the answer. */
async function sendOne(sb: Sandbox, content: string): Promise<string> {
  const origin = `http://127.0.0.1:${sb.port}`;
  const post = await fetch(`${origin}/basic-chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(post.status, await post.clone().text()).toBe(202);
  const accepted = (await post.json()) as { conversationId: number };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 250));
    const response = await fetch(`${origin}/api/conversations/${accepted.conversationId}`).catch(() => undefined);
    if (response === undefined || !response.ok) continue;
    const body = (await response.json()) as { entries?: Entry[] };
    const answer = textOf(body.entries ?? []);
    if (answer !== "") return answer;
  }
  throw new Error(`no answer from the daemon within 60s`);
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
    // Removes the home, including its secrets directory and the fixture's link.
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("a daemon on a model an extension provides", () => {
  it("boots and answers one message with the extension provider's reply", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const child = start(sb);
    await waitReady(sb, child);

    expect(await sendOne(sb, "hello")).toBe(ANSWER);
    // The preload registered before the boot's catalog check; the full load then
    // replaced the same entry instead of adding a second one, which is why one
    // warning-free log names the providers once.
    const log = await readFile(join(sb.home, "logs", "app.log"), "utf8");
    const registrations = log.split("\n").filter((line) => line.includes("extension providers registered"));
    expect(registrations.length).toBeGreaterThanOrEqual(1);
    expect(log).not.toContain('"provider":"acme" is already registered');
  }, 180_000);

  it("warns after the load about a vmodel whose model is gone, and keeps serving", async () => {
    const sb = await sandbox();
    await writeHome(sb, { deadVmodel: true });
    const child = start(sb);
    await waitReady(sb, child);

    const log = await readFile(join(sb.home, "logs", "app.log"), "utf8");
    const warning = log.split("\n").find((line) => line.includes("vmodel names a model the catalog does not have"));
    expect(warning).toBeDefined();
    expect(warning).toContain('"vmodel":"dead"');
    expect(warning).toContain('"provider":"acme"');

    // A model the catalog dropped is a warning, not a stop.
    expect(await sendOne(sb, "still there?")).toBe(ANSWER);
  }, 180_000);

  it("exits with code 2 when the extension that provides the root model cannot load, and the log names it", async () => {
    const sb = await sandbox();
    await writeHome(sb, { broken: true });
    const child = start(sb);
    const run = await child.run;
    expect(run.code, run.stderr).toBe(2);

    const log = await readFile(join(sb.home, "logs", "app.log"), "utf8");
    expect(log).toContain('"name":"acme"');
    expect(log).toMatch(/extension provider preload failed|runtime extension failed to load/);
    expect(log).toContain("configured model is not in the catalog");
  }, 120_000);
});
