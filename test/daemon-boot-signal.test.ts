/**
 * A stop signal that arrives while the daemon is still booting.
 *
 * `commandStart` writes the pid file and then writes the restart notice. The
 * notice's first act is to parse the whole active audit file, so on a large
 * trail it takes a moment, and a supervisor, a test, or an operator reads the
 * pid file as the moment the daemon is up. The stop handlers have to be in place
 * before that file exists, otherwise a signal inside the notice ends the process
 * with Node's default action and leaves the pid file, the storage and the lock
 * behind.
 *
 * Only a real process shows which of the two happened, so this file spawns the
 * CLI the way `test/restart-runner-daemon.test.ts` does, and makes the notice
 * slow with test input alone: a large audit trail in the sandbox home. Nothing
 * in `src/` exists for this test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths } from "../src/runtime/paths.ts";

// The repository root, so a child runs the sources this test was compiled from.
const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * How many audit rows the sandbox home starts with.
 *
 * `readAuditTail` reads the file whole and parses every line, and the notice
 * reads it before it decides anything. 1.1 million short rows is about 55 MB,
 * which measured at roughly two thirds of a second to parse: long enough that
 * the signal below lands inside the read, and small enough to stay under the
 * audit trail's default rotation size.
 */
const FILLER_ROWS = 1_100_000;

/** The rotation size `audit.maxBytes` defaults to, which this filler must stay under. */
const AUDIT_ROTATE_BYTES = 64 * 1024 * 1024;

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

/** A free port in a range the other daemon tests do not take. */
async function freePort(): Promise<number> {
  for (let port = 19500; port < 19700; port += 1) {
    const taken = await new Promise<boolean>((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
    });
    if (!taken) return port;
  }
  throw new Error("no free port in 19500-19699");
}

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly homeDir: string;
  readonly port: number;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * One home, and an environment built from nothing.
 *
 * Nothing from `process.env` is spread in: this test starts a daemon, and the
 * environment running the test names the home of the daemon that serves the
 * agent running it. `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are left out
 * as well, so nothing in the child can reach a live user bus or the running
 * `pi-sec` unit.
 */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-boot-signal-"));
  roots.add(root);
  const home = join(root, ".pi", "sec");
  const homeDir = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PI_SEC_HOME: home,
    HOME: homeDir,
    PATH: process.env.PATH,
    TERM: "dumb",
  };
  expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
  expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  return { root, home, homeDir, port, env };
}

/**
 * A home the daemon boots on.
 *
 * The boot fails closed on a model it cannot name, so the config names a catalog
 * model. `deepseek-flash` needs no credential to be looked up, which is all the
 * boot does before it serves. The launcher finds the update script in the
 * workspace tree, so a home without one is refused `script_missing` before any of
 * this is reached.
 */
async function writeHome(sb: Sandbox): Promise<void> {
  const config = {
    server: { port: sb.port },
    vmodels: {
      runner: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium", prompt: "runner" },
    },
    agent: { vmodel: "runner" },
  };
  await writeFile(join(sb.home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // A vmodel names a prompt file and a missing one is an error. Running from the
  // sources there is no built `dist/prompts`, so this home carries its own.
  await mkdir(join(sb.home, "prompts", "vmodel"), { recursive: true });
  await writeFile(join(sb.home, "prompts", "vmodel", "runner.md"), "", { mode: 0o600 });
  // The script the launcher names in its answer. This test never runs it.
  await mkdir(join(sb.home, "workspace", "user-tools"), { recursive: true });
  await writeFile(join(sb.home, "workspace", "user-tools", "update-and-restart"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  await mkdir(join(sb.home, "snapshot"), { recursive: true });
}

/**
 * Fill the sandbox audit trail, so the restart notice spends time on it.
 *
 * The rows carry times in the past, and one `server_start` row from before this
 * boot makes the notice read as a restart rather than a first start. That row is
 * near the end because the notice keeps the newest 20,000 rows of the file.
 */
async function fillAudit(sb: Sandbox): Promise<{ file: string; bytes: number }> {
  const file = buildPaths(sb.home).auditLog;
  await mkdir(join(sb.home, "logs"), { recursive: true });
  const now = Date.now();
  const rows: string[] = [];
  for (let i = 0; i < FILLER_ROWS; i += 1) {
    rows.push(`{"time":${now - 3_600_000 + i},"type":"filler","n":${i}}`);
  }
  rows.push(`{"time":${now - 60_000},"type":"server_start","pid":1}`);
  const text = `${rows.join("\n")}\n`;
  await writeFile(file, text, { mode: 0o600 });
  const bytes = Buffer.byteLength(text);
  // A trail at or past the rotation size would be renamed away by the boot's own
  // first append, and the notice would read an empty file in no time at all.
  expect(bytes, "the filler audit trail must stay under the rotation size").toBeLessThan(AUDIT_ROTATE_BYTES);
  return { file, bytes };
}

interface Child {
  readonly process: ChildProcess;
  readonly run: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
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
  const run = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((settle) => {
    child.once("close", (code, signal) => settle({ code, signal, output }));
  });
  return { process: child, run, output: () => output };
}

/**
 * Wait until this home's pid file names the child.
 *
 * The poll is short because the whole test depends on sending the signal inside
 * the window that starts with this file: a tenth of a second of slack spent here
 * is a tenth of a second less of the notice.
 */
async function waitForPid(pidFile: string, pid: number, timeoutMs: number, onTimeout: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(pidFile, "utf8").catch(() => undefined);
    if (text !== undefined && Number.parseInt(text.trim(), 10) === pid) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for pid ${pid} in ${pidFile}\n${onTimeout()}`);
    }
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

/** Read the pid file's number, or undefined when the file is gone. */
async function pidOnDisk(sb: Sandbox): Promise<number | undefined> {
  const text = await readFile(buildPaths(sb.home).pidFile, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

/** The last `bytes` of a file as text, so a 55 MB trail can be read for its end alone. */
async function readTailBytes(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(bytes, info.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Await the child's end, and fail with what it wrote rather than hanging the run. */
async function settle(
  child: Child,
  timeoutMs = 120_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`the daemon did not end within ${timeoutMs}ms\n${child.output()}`)), timeoutMs),
  );
  return await Promise.race([child.run, timeout]);
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
  // Removes each home with everything under it, its audit trail included.
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("a stop signal during the boot", () => {
  it("ends the daemon through the shutdown, not through the default signal action", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const audit = await fillAudit(sb);

    const child = start(sb);
    const pidFile = buildPaths(sb.home).pidFile;
    const pid = child.process.pid;
    expect(typeof pid).toBe("number");
    await waitForPid(pidFile, pid as number, 90_000, () => child.output());

    // The notice records its outcome last, so a row here would mean the boot
    // finished the notice before the signal could be sent, and this run would
    // prove nothing about a signal inside it. Say that, instead of passing on a
    // shutdown that was not timed.
    const before = await readTailBytes(audit.file, 1 << 20);
    expect(
      before,
      `the boot finished its restart notice before the signal could be sent, so this run does not show a signal inside the notice:\n${child.output()}`,
    ).not.toContain('"type":"restart_notice');

    child.process.kill("SIGTERM");
    const ended = await settle(child);
    expect(ended.signal, `the process was signalled:\n${ended.output}`).toBeNull();
    expect(ended.code, `exit code of a SIGTERM stop. output:\n${ended.output}`).toBe(0);
    // The shutdown removed it, so the next start does not read a pid it cannot
    // find and call this a stop that skipped the shutdown.
    expect(await pidOnDisk(sb)).toBeUndefined();

    // The shutdown's own row: the handler that the fix installs before the pid
    // file exists is the one that wrote it.
    const after = await readTailBytes(audit.file, 1 << 16);
    expect(after, `the audit trail has no stop row:\n${ended.output}`).toContain('"type":"server_stop"');
    expect(after).toContain('"signal":"SIGTERM"');
  }, 240_000);
});
