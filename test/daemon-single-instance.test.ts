import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { agentShellEnv, createEnvFactory } from "../src/agent/env.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { acquireDaemonLock } from "../src/runtime/daemon-lock.ts";
import { buildPaths } from "../src/runtime/paths.ts";
import { createRedactor } from "../src/secrets/redact.ts";

// The repository root, so a child runs the sources this test was compiled from.
const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The live home of this checkout, computed and never written down.
 *
 * The guard below is about "a variable that points at the home the serving
 * daemon uses". Spelled as a literal, it names one account's home on one box,
 * which is true nowhere else; computed, it is the same check in every install.
 */
const LIVE_HOME = join(homedir(), ".pi", "sec");

/**
 * A home of its own for one child, and the smallest environment that reaches it.
 *
 * Nothing from `process.env` is spread in. This test starts daemons, and a
 * `PI_SEC_HOME` set in the parent environment can name the home of a running
 * daemon: a child that inherited it could open that storage, which is the
 * failure the change under test exists to prevent.
 */
interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
}

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-single-instance-"));
  roots.add(root);
  const home = join(root, "pi-sec");
  const homeDir = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { PI_SEC_HOME: home, HOME: homeDir, PATH: process.env.PATH };
  // Only a variable that names a home can move the child to the live one. PATH is
  // carried as it is: the checkout sits under that home, so its entries do.
  expect(env.PI_SEC_HOME).toBe(home);
  expect(env.HOME).toBe(homeDir);
  for (const [name, value] of Object.entries(env)) {
    if (name === "PATH") continue;
    expect(value ?? "", `${name} must not point at the live home`).not.toContain(LIVE_HOME);
  }
  return { root, home, homeDir, env };
}

/**
 * A `config.json` a daemon accepts.
 *
 * The boot fails closed on a model it cannot name, so the file names a catalog
 * model. `deepseek-flash` is in the shipped catalog and needs no credential to
 * be looked up, which is all the boot does before it serves.
 */
async function writeConfig(sb: Sandbox): Promise<void> {
  const config = {
    vmodels: {
      runner: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium", prompt: "runner" },
    },
    agent: { vmodel: "runner" },
  };
  await writeFile(join(sb.home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // A vmodel names a prompt file and a missing one is an error, so this home
  // carries an empty one. Running from the sources, the shipped prompts sit in
  // `dist/prompts`, which does not exist until a build, so the home supplies it.
  await mkdir(join(sb.home, "prompts", "vmodel"), { recursive: true });
  await writeFile(join(sb.home, "prompts", "vmodel", "runner.md"), "", { mode: 0o600 });
}

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface DaemonChild {
  readonly child: ChildProcess;
  readonly run: Promise<Run>;
  /** Everything the child has written to stderr so far, for a failure message. */
  stderr(): string;
}

/**
 * Run `start` in a child process.
 *
 * `--port 0` asks the kernel for a free port, so two cases of this file cannot
 * collide with each other or with the daemon that is already running. Readiness
 * is the pid file, which the daemon writes only after the port answers.
 */
function startIn(sb: Sandbox, extra: readonly string[] = []): DaemonChild {
  const child = spawn(
    process.execPath,
    [join(REPO, "src", "cli.ts"), "start", "--port", "0", ...extra],
    { cwd: REPO, env: sb.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const run = new Promise<Run>((settle) => {
    child.once("close", (code, signal) => settle({ code, signal, stdout, stderr }));
  });
  return { child, run, stderr: () => stderr };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/** Wait until the child's pid is the one in this home's pid file. */
async function waitReady(sb: Sandbox, child: DaemonChild, timeoutMs = 90_000): Promise<void> {
  const pidFile = buildPaths(sb.home).pidFile;
  await waitFor(
    async () => {
      const text = await readFile(pidFile, "utf8").catch(() => undefined);
      if (text === undefined) return undefined;
      return Number.parseInt(text.trim(), 10) === child.child.pid ? true : undefined;
    },
    timeoutMs,
    `pid ${child.child.pid} in ${pidFile}. stderr so far:\n${child.stderr()}`,
  );
}

async function exists(path: string): Promise<boolean> {
  return await readFile(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  for (const child of spawned) {
    // SIGKILL is the point, not a shortcut: a child that took the lock must give
    // it back by dying, so the cases below never depend on a shutdown handler.
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawned.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("one daemon per home", () => {
  it("refuses a second start, naming the home, before it opens the storage", async () => {
    const sb = await sandbox();
    await writeConfig(sb);
    const first = startIn(sb);
    await waitReady(sb, first);

    const second = startIn(sb);
    const rejected = await second.run;
    expect(rejected.code, `second start exited with ${rejected.signal ?? rejected.code}`).toBe(1);
    expect(rejected.stderr).toContain(sb.home);
    expect(rejected.stderr).toContain("another pi-sec daemon is running on this home");
    // The refusal read the pid file rather than overwriting it.
    expect(Number.parseInt((await readFile(buildPaths(sb.home).pidFile, "utf8")).trim(), 10)).toBe(first.child.pid);

    // A home whose lock this test holds itself, so the first daemon's own state
    // cannot account for the refusal. The storage must be absent afterwards: the
    // lock is taken before `openStorage`, which is what writes `state/sec.sqlite`.
    const held = await sandbox();
    const paths = buildPaths(held.home);
    await mkdir(paths.runDir, { recursive: true });
    const lock = acquireDaemonLock(paths.daemonLockFile);
    try {
      const third = startIn(held);
      const refused = await third.run;
      expect(refused.code, `start on a held lock exited with ${refused.signal ?? refused.code}`).toBe(1);
      expect(refused.stderr).toContain(held.home);
      expect(await exists(paths.stateDb)).toBe(false);
    } finally {
      lock.release();
    }
  }, 180_000);

  it("starts on the same home after the first one is killed", async () => {
    const sb = await sandbox();
    await writeConfig(sb);
    const first = startIn(sb);
    await waitReady(sb, first);

    first.child.kill("SIGKILL");
    const killed = await first.run;
    expect(killed.signal).toBe("SIGKILL");

    const second = startIn(sb);
    await waitReady(sb, second);
    expect(Number.parseInt((await readFile(buildPaths(sb.home).pidFile, "utf8")).trim(), 10)).toBe(second.child.pid);
  }, 180_000);
});

describe("a start whose port is taken", () => {
  it("exits with code 1 instead of staying up without a port", async () => {
    const sb = await sandbox();
    await writeConfig(sb);

    const holder = createServer();
    await new Promise<void>((settle, fail) => {
      holder.once("error", fail);
      holder.listen(0, "127.0.0.1", () => settle());
    });
    const address = holder.address();
    if (address === null || typeof address === "string") throw new Error("the port holder has no port");
    try {
      const child = startIn(sb, ["--port", String(address.port)]);
      const run = await Promise.race([
        child.run,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the failed start did not end")), 60_000)),
      ]);
      expect(run.signal, `the process was signalled instead of exiting:\n${run.stderr}`).toBeNull();
      expect(run.code, `exit code. stderr:\n${run.stderr}`).toBe(1);
      expect(run.stderr).toContain("EADDRINUSE");
    } finally {
      await new Promise<void>((settle) => holder.close(() => settle()));
    }
  }, 180_000);
});

describe("the agent shell environment", () => {
  it("drops the systemd handshake and the runner flag, and keeps every other variable", () => {
    const env = agentShellEnv({
      NOTIFY_SOCKET: "/run/systemd/notify",
      WATCHDOG_USEC: "60000000",
      WATCHDOG_PID: "4242",
      PI_SEC_RUNNER: "1",
      PI_SEC_HOME: "/var/lib/example/.pi/sec",
      HOME: "/var/lib/example",
      PATH: "/usr/bin",
    });

    // The key stays and the value goes: an absent key would let the daemon's own
    // value back in through `{ ...process.env, ...shellEnv }`. `PI_SEC_RUNNER` is
    // here for the same reason as the handshake: it describes the process the
    // runner started, not the command an agent runs in a shell under it.
    for (const name of ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID", "PI_SEC_RUNNER"]) {
      expect(name in env, `${name} must keep its key`).toBe(true);
      expect(env[name], `${name} must lose its value`).toBeUndefined();
    }
    expect(env.PI_SEC_HOME).toBe("/var/lib/example/.pi/sec");
    expect(env.HOME).toBe("/var/lib/example");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("runs a shell command without them, and with the home it was given", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-agent-env-"));
    roots.add(root);
    const saved = new Map<string, string | undefined>();
    for (const name of ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID", "PI_SEC_HOME", "PI_SEC_RUNNER"]) {
      saved.set(name, process.env[name]);
    }
    process.env.NOTIFY_SOCKET = "/run/systemd/notify-from-daemon";
    process.env.WATCHDOG_USEC = "60000000";
    process.env.WATCHDOG_PID = "424242";
    process.env.PI_SEC_HOME = root;
    process.env.PI_SEC_RUNNER = "1";
    try {
      const base = defaultConfig();
      const config = { ...base, agent: { ...base.agent, workspace: root } };
      const factory = createEnvFactory({
        paths: buildPaths(root),
        getConfig: () => config,
        redactor: () => createRedactor([]),
      });
      // The factory reads only `cwd`; the rest of the target belongs to the harness.
      const env = factory({ conversationId: "test", read: undefined } as unknown as EnvTarget);

      let output = "";
      const result = await env.exec("env", { onOutput: (text: string) => (output += text) }, BACKGROUND_CONTEXT);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(output).toContain(`PI_SEC_HOME=${root}`);
      expect(output).not.toContain("NOTIFY_SOCKET=");
      expect(output).not.toContain("WATCHDOG_USEC=");
      expect(output).not.toContain("WATCHDOG_PID=");
      expect(output).not.toContain("PI_SEC_RUNNER=");
      expect(output).not.toContain("notify-from-daemon");
      await env.cleanup(BACKGROUND_CONTEXT);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);
});
