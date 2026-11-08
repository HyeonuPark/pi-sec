/**
 * A real daemon under `user-tools/run`, and what its restart route does to it.
 *
 * The runner supervises the daemon and reads one exit code as "update and come
 * back". Nothing in the unit tests covers that last step: the launcher decides,
 * the route answers, and `src/cli.ts` has to turn the request into the shutdown a
 * signal takes, ending with that code. Only a real process shows the code the
 * runner would see, so this file spawns the CLI the way `test/daemon-single-
 * instance.test.ts` does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths } from "../src/runtime/paths.ts";
import { restartMarkerPath, RUNNER_EXIT_CODE, RUNNER_VARIABLE } from "../src/runtime/restart-helper.ts";

// The repository root, so a child runs the sources this test was compiled from.
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The refusal a daemon without a unit and without a runner answers. */
const NO_UNIT =
  "no systemd unit named pi-sec was found and the daemon is not running under user-tools/run; stop the daemon, run user-tools/update-and-restart, and start the daemon again";

const spawned = new Set<ChildProcess>();
const roots = new Set<string>();

/** A free port in a range that tests use, clear of the ones the other daemon tests take. */
async function freePort(): Promise<number> {
  for (let port = 19300; port < 19500; port += 1) {
    const taken = await new Promise<boolean>((settle) => {
      const probe = createServer();
      probe.once("error", () => settle(true));
      probe.listen(port, "127.0.0.1", () => probe.close(() => settle(false)));
    });
    if (!taken) return port;
  }
  throw new Error("no free port in 19300-19499");
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
 * Nothing from `process.env` is spread in. This test starts daemons, and a
 * `PI_SEC_HOME` in the parent environment can name the home of a running daemon.
 * `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are left out
 * for another reason: with a user bus in reach, a refused restart would ask a
 * real `pi-sec` unit instead of answering `no_unit`, and `systemd-run` would be
 * one probe away from stopping it.
 */
async function sandbox(options: { readonly runner?: boolean } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-runner-daemon-"));
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
    ...(options.runner === true ? { [RUNNER_VARIABLE]: "1" } : {}),
  };
  // The one claim the whole file rests on: no user bus, and no runner flag unless
  // the case asks for it.
  expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
  expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  expect(env[RUNNER_VARIABLE]).toBe(options.runner === true ? "1" : undefined);
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
  // The script the launcher names in its answer. This test never runs it: the
  // runner is not part of the process under test, and the exit code is what it
  // would read.
  await mkdir(join(sb.home, "workspace", "user-tools"), { recursive: true });
  await writeFile(join(sb.home, "workspace", "user-tools", "update-and-restart"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await mkdir(join(sb.home, "snapshot"), { recursive: true });
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

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, what: string, onTimeout: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${onTimeout()}`);
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/** Wait until this home's pid file names the child: the daemon writes it once the port answers. */
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

/** Read the pid file's number, or undefined when the file is gone. */
async function pidOnDisk(sb: Sandbox): Promise<number | undefined> {
  const text = await readFile(buildPaths(sb.home).pidFile, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

async function exists(path: string): Promise<boolean> {
  return await readFile(path).then(
    () => true,
    () => false,
  );
}

/** The route the page calls: a JSON body type, and nothing else. */
function postRestart(sb: Sandbox, body = "{}"): Promise<Response> {
  return fetch(`http://127.0.0.1:${sb.port}/api/admin/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/** Await the child's end, and fail with what it wrote rather than hanging the run. */
async function settle(child: Child, timeoutMs = 60_000): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`the daemon did not end within ${timeoutMs}ms\n${child.output()}`)), timeoutMs),
  );
  return await Promise.race([child.run, timeout]);
}

async function readMarker(sb: Sandbox): Promise<{ at: number; source: string }> {
  return JSON.parse(await readFile(restartMarkerPath(buildPaths(sb.home).runDir), "utf8")) as { at: number; source: string };
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
  // Removes each home with everything under it, its secrets directory included.
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("a daemon under the runner", () => {
  it("answers 202 for the restart button, ends with the runner's code, and leaves the home free", async () => {
    const sb = await sandbox({ runner: true });
    await writeHome(sb);
    const first = start(sb);
    await waitReady(sb, first);

    const response = await postRestart(sb);
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as { status: string; mode: string; unit: string | null };
    expect(body.status).toBe("launched");
    expect(body.mode).toBe("runner");
    // There is no unit to name, and `null` says so instead of leaving a key out.
    expect(body.unit).toBeNull();

    // The code the runner reads as "update and come back", not a signal and not 0.
    const ended = await settle(first);
    expect(ended.signal, `the process was signalled:\n${ended.output}`).toBeNull();
    expect(ended.code, `exit code. output:\n${ended.output}`).toBe(RUNNER_EXIT_CODE);

    // The marker is written before the answer, so the runner and the next boot
    // both find it. The route names the press as `ui`.
    const marker = await readMarker(sb);
    expect(marker.source).toBe("ui");
    expect(typeof marker.at).toBe("number");

    // The shutdown a signal takes: pid file removed, then the lock released.
    expect(await pidOnDisk(sb)).toBeUndefined();

    // The lock is what a second start would be refused on, so booting on the same
    // home is the check that it was given back.
    const second = start(sb);
    await waitReady(sb, second);
    expect(await pidOnDisk(sb)).toBe(second.process.pid);

    second.process.kill("SIGTERM");
    const stopped = await settle(second);
    expect(stopped.signal, `the process was signalled:\n${stopped.output}`).toBeNull();
    expect(stopped.code, `exit code of a SIGTERM stop. output:\n${stopped.output}`).toBe(0);
  }, 240_000);

  it("marks a forced reinstall apart, so the runner can name what failed", async () => {
    const sb = await sandbox({ runner: true });
    await writeHome(sb);
    const child = start(sb);
    await waitReady(sb, child);

    const response = await postRestart(sb, JSON.stringify({ reinstall: true }));
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe("runner");

    const ended = await settle(child);
    expect(ended.code, `exit code. output:\n${ended.output}`).toBe(RUNNER_EXIT_CODE);
    expect((await readMarker(sb)).source).toBe("ui-reinstall");
  }, 180_000);
});

describe("a daemon without the runner", () => {
  it("refuses the restart button with the sentence that names both ways, and keeps serving", async () => {
    const sb = await sandbox();
    await writeHome(sb);
    const child = start(sb);
    await waitReady(sb, child);

    const response = await postRestart(sb);
    expect(response.status, await response.clone().text()).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("no_unit");
    expect(body.error.message).toBe(NO_UNIT);

    // Nothing ended the process, and nothing was written for a runner to read.
    expect(child.process.exitCode).toBeNull();
    expect(await pidOnDisk(sb)).toBe(child.process.pid);
    expect(await exists(restartMarkerPath(buildPaths(sb.home).runDir))).toBe(false);

    // A daemon the button left alone still answers, and still stops on a signal.
    const served = await fetch(`http://127.0.0.1:${sb.port}/api/admin/status`).catch(() => undefined);
    expect(served?.status, `a request after the refusal. output:\n${child.output()}`).toBe(200);

    child.process.kill("SIGTERM");
    const stopped = await settle(child);
    expect(stopped.signal, `the process was signalled:\n${stopped.output}`).toBeNull();
    expect(stopped.code, `exit code of a SIGTERM stop. output:\n${stopped.output}`).toBe(0);
  }, 180_000);
});
