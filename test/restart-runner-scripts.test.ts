import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `user-tools/run`, the supervisor a daemon runs under without systemd.
 *
 * The runner starts the daemon and, when the daemon ends with the restart code,
 * runs the update script and starts the daemon again. Anything else ends the
 * runner with the code that came back: a refusal to start, a crash, or a stop.
 *
 * Nothing here starts a daemon. The build under `snapshot/dist/cli.js` is a small
 * Node script that records how it was called and exits with the code the test
 * asked for, and the update script records its arguments the same way. The child
 * environment is built from scratch: a `PI_SEC_HOME` in this process's
 * environment can name the home of a running daemon, and a test that inherited
 * it could point the runner at that storage and at a real systemd unit.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(REPO, "user-tools", "run");

const roots = new Set<string>();

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly homeDir: string;
  readonly startLog: string;
  readonly updateLog: string;
  readonly counter: string;
  readonly marker: string;
}

/** One fake build, one fake update script, and the home they live in. */
async function sandbox(options: { build?: boolean } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-runner-"));
  roots.add(root);
  const home = join(root, "pi-sec");
  const homeDir = join(root, "home");
  const snapshot = join(home, "snapshot");
  const workspace = join(home, "workspace");
  await mkdir(join(snapshot, "dist"), { recursive: true });
  await mkdir(join(workspace, "user-tools"), { recursive: true });
  await mkdir(join(home, "run"), { recursive: true });
  await mkdir(join(home, "logs"), { recursive: true });
  await mkdir(homeDir, { recursive: true });

  // The daemon: records every start, and exits with the next code of the list.
  // The list lives in `FAKE_START_CODES`, and each run takes the next entry.
  await writeFile(
    join(snapshot, "dist", "cli.js"),
    `const fs = require("node:fs");
const log = process.env.FAKE_START_LOG;
const counter = process.env.FAKE_START_COUNT;
const codes = JSON.parse(process.env.FAKE_START_CODES ?? "[]");
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
fs.writeFileSync(counter, String(n));
// A daemon that waits to be told to stop: the first run registers the handler
// before it says it started, so a stop sent after that line reaches it.
const hold = process.env.FAKE_HOLD === "1" && n === 1;
if (hold) process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));
fs.appendFileSync(log, JSON.stringify({
  run: n,
  args: process.argv.slice(2),
  runner: process.env.PI_SEC_RUNNER ?? null,
  home: process.env.PI_SEC_HOME ?? null,
  notify: process.env.NOTIFY_SOCKET ?? null,
  watchdog: process.env.WATCHDOG_USEC ?? null,
  cwd: process.cwd(),
}) + "\\n");
if (hold) setInterval(() => {}, 1000);
else process.exit(n <= codes.length ? codes[n - 1] : 0);
`,
  );

  // The update script: records its arguments, then exits with what the test
  // asked for. It removes the marker first when `FAKE_UPDATE_REMOVE_MARKER` is
  // set, which is what the real script does before it starts the service.
  await writeFile(
    join(workspace, "user-tools", "update-and-restart"),
    `#!/usr/bin/env bash
if [ "\${FAKE_UPDATE_REMOVE_MARKER:-}" = "1" ]; then rm -f "$PI_SEC_HOME/run/restart-pending"; fi
printf 'args:%s\\n' "$*" >> "$FAKE_UPDATE_LOG"
printf 'update output %s\\n' "\${FAKE_UPDATE_TAG:-plain}"
exit "\${FAKE_UPDATE_EXIT:-0}"
`,
  );
  await chmod(join(workspace, "user-tools", "update-and-restart"), 0o700);
  if (options.build === false) await rm(join(snapshot, "dist", "cli.js"), { force: true });

  return {
    root,
    home,
    homeDir,
    startLog: join(root, "starts.log"),
    updateLog: join(root, "updates.log"),
    counter: join(root, "count"),
    marker: join(home, "run", "restart-pending"),
  };
}

/** The environment a child gets: nothing of this process's, and no bus. */
function childEnv(sb: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: sb.homeDir,
    PI_SEC_HOME: sb.home,
    TERM: "dumb",
    FAKE_START_LOG: sb.startLog,
    FAKE_START_COUNT: sb.counter,
    FAKE_UPDATE_LOG: sb.updateLog,
    ...extra,
  };
  // Rules 2 and 2a of this stage: a session bus or a runtime directory would let
  // `systemctl --user` in a child reach the live unit.
  expect(env.XDG_RUNTIME_DIR, "the child must not carry a runtime directory").toBeUndefined();
  expect(env.DBUS_SESSION_BUS_ADDRESS, "the child must not carry a bus address").toBeUndefined();
  return env;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runRunner(sb: Sandbox, env: NodeJS.ProcessEnv, args: readonly string[] = []): Promise<Run> {
  return new Promise<Run>((settle) => {
    execFile("bash", [RUNNER, ...args], { env, cwd: sb.root, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      settle({ code, stdout, stderr });
    });
  });
}

interface StartRecord {
  readonly run: number;
  readonly args: string[];
  readonly runner: string | null;
  readonly home: string | null;
  readonly notify: string | null;
  readonly watchdog: string | null;
}

async function starts(sb: Sandbox): Promise<StartRecord[]> {
  if (!existsSync(sb.startLog)) return [];
  const text = await readFile(sb.startLog, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StartRecord);
}

async function updates(sb: Sandbox): Promise<string[]> {
  if (!existsSync(sb.updateLog)) return [];
  return (await readFile(sb.updateLog, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
}

async function markerOf(sb: Sandbox): Promise<{ at: number; source: string }> {
  return JSON.parse(await readFile(sb.marker, "utf8")) as { at: number; source: string };
}

/** Wait until the daemon has started `count` times, or fail with the reason. */
async function waitForStarts(sb: Sandbox, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await starts(sb)).length >= count) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(`the runner did not start the daemon ${count} time(s)`);
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("the runner", () => {
  it("runs the update and starts the daemon again when the daemon asks for a restart", async () => {
    const sb = await sandbox();
    await writeFile(sb.marker, `${JSON.stringify({ at: 1_700_000_000_000, source: "ui" })}\n`);
    const env = childEnv(sb, { FAKE_START_CODES: JSON.stringify([75, 0]) });

    const result = await runRunner(sb, env, ["--port", "19100"]);

    // The second start ends with 0, and that is the runner's code: a restart is
    // not a failure and does not become one on the way out.
    expect(result.code, result.stderr).toBe(0);
    const calls = await starts(sb);
    expect(calls.map((call) => call.run)).toEqual([1, 2]);
    // The runner passes its own arguments to the daemon it starts.
    expect(calls[0]!.args).toEqual(["start", "--port", "19100"]);
    expect(calls[1]!.args).toEqual(["start", "--port", "19100"]);

    // The update ran once, between the two starts, with no argument of its own.
    expect(await updates(sb)).toEqual(["args:"]);

    // The update's output reaches the log the restart answer names.
    const log = await readFile(join(sb.home, "logs", "update-and-restart.log"), "utf8");
    expect(log).toContain("update output plain");
  });

  it("passes --reinstall when the marker says the menu asked for it", async () => {
    const sb = await sandbox();
    await writeFile(sb.marker, `${JSON.stringify({ at: 1, source: "ui-reinstall" })}\n`);
    const env = childEnv(sb, { FAKE_START_CODES: JSON.stringify([75, 0]) });

    const result = await runRunner(sb, env);

    expect(result.code).toBe(0);
    expect(await updates(sb)).toEqual(["args:--reinstall"]);
    expect(await starts(sb)).toHaveLength(2);
  });

  it("starts the daemon again after a failed update, and leaves the marker for the next boot", async () => {
    const sb = await sandbox();
    await writeFile(sb.marker, `${JSON.stringify({ at: 1, source: "ui" })}\n`);
    // The script removes the marker before it starts anything, then fails: the
    // marker has to come back, or the next boot says nothing about the restart.
    const env = childEnv(sb, { FAKE_START_CODES: JSON.stringify([75, 0]), FAKE_UPDATE_EXIT: "1", FAKE_UPDATE_REMOVE_MARKER: "1" });

    const result = await runRunner(sb, env);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("the update failed");
    expect(await starts(sb)).toHaveLength(2);
    const marker = await markerOf(sb);
    expect(marker.source).toBe("runner");
    expect(Number.isFinite(marker.at)).toBe(true);
  });

  it("ends with the daemon's own code when it is not the restart code", async () => {
    const sb = await sandbox();
    await writeFile(sb.marker, `${JSON.stringify({ at: 1, source: "ui" })}\n`);
    const env = childEnv(sb, { FAKE_START_CODES: JSON.stringify([3]) });

    const result = await runRunner(sb, env);

    // Starting again would repeat a failure the operator has to read, so the
    // runner ends instead and takes the code with it.
    expect(result.code).toBe(3);
    expect(await starts(sb)).toHaveLength(1);
    expect(await updates(sb)).toEqual([]);
  });

  it("puts the runner flag and the home into the daemon's environment", async () => {
    const sb = await sandbox();
    const env = childEnv(sb, {
      FAKE_START_CODES: JSON.stringify([0]),
      // A daemon started from here has no unit: a socket or a watchdog interval
      // in the environment would be answered for a unit that is not there.
      NOTIFY_SOCKET: "/run/systemd/notify-from-the-test",
      WATCHDOG_USEC: "60000000",
    });

    const result = await runRunner(sb, env);

    expect(result.code).toBe(0);
    const [call] = await starts(sb);
    expect(call!.runner).toBe("1");
    expect(call!.home).toBe(sb.home);
    expect(call!.notify).toBeNull();
    expect(call!.watchdog).toBeNull();
  });

  it("forwards a stop signal to the daemon and ends with the daemon's code", async () => {
    const sb = await sandbox();
    const env = childEnv(sb, { FAKE_HOLD: "1" });
    const child = spawn("bash", [RUNNER], { env, cwd: sb.root });
    const exited = new Promise<number | null>((settle) => child.once("exit", (code) => settle(code)));
    try {
      await waitForStarts(sb, 1);
      child.kill("SIGTERM");
      // The runner forwards the signal and the daemon answers it with 0. That 0
      // is the runner's code, not the 143 an interrupted `wait` would report.
      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
    expect(await starts(sb)).toHaveLength(1);
  });

  it("refuses to start when the execution tree has no build", async () => {
    const sb = await sandbox({ build: false });
    const env = childEnv(sb);

    const result = await runRunner(sb, env);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no build at");
    expect(await starts(sb)).toEqual([]);
    expect(await updates(sb)).toEqual([]);
  });
});
