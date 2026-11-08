import { spawn as spawnChild, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminNotes } from "./notes.ts";

/**
 * Cold restart, requested from the web UI.
 *
 * The daemon never restarts itself, and it must not try to. It runs under a
 * systemd unit with `KillMode=control-group`, so the moment the update script
 * stops the service, every process in that unit's cgroup dies with it — and a
 * `setsid` child is still in that cgroup. Separating the session does not
 * escape a control group.
 *
 * So the daemon asks systemd to run the script as a transient unit of its own.
 * A sibling unit gets a sibling cgroup: `systemctl --user stop pi-sec` cannot
 * reach it, and the update finishes and starts the service again. What the
 * daemon does here is a request and a bookkeeping entry, nothing more.
 *
 * A daemon started by `user-tools/run` has no unit to ask: the runner is the
 * process that supervises it. There the same request ends the daemon with
 * `RUNNER_EXIT_CODE`, and the runner applies the update and starts it again.
 * That is why the runner check comes before any `systemctl` probe: a daemon
 * under the runner must never touch a unit, not even to look at one.
 *
 * The script is the same one the operator runs by hand (`user-tools/update-and-restart`),
 * which is the point: one path for the update, whether it is started from a
 * terminal or from a button.
 */

/** Marker written before the script starts and removed by it on success. */
export const RESTART_MARKER = "restart-pending";

/**
 * The variable `user-tools/run` sets for the daemon it supervises.
 *
 * The agent shell drops it (`agentShellEnv`): a command an agent runs under the
 * runner would otherwise read itself as supervised by it.
 */
export const RUNNER_VARIABLE = "PI_SEC_RUNNER";

/**
 * Exit code that tells the runner to update and start the daemon again.
 *
 * 75 is `EX_TEMPFAIL` from `sysexits.h`, and it is the code the runner reads as
 * "come back after an update". Nothing else the daemon exits with means that: a
 * refusal to start (a second daemon on the same home, a taken port) carries its
 * own code, so the runner ends instead of looping on a failure it cannot fix.
 */
export const RUNNER_EXIT_CODE = 75;

/** The script's output, appended across runs. */
export const RESTART_LOG = "update-and-restart.log";

export interface CommandRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How the launcher reaches the outside world; injected so tests never call systemd. */
export interface RestartHooks {
  /** Run a short command and read its exit status. */
  probe(command: string, args: readonly string[]): Promise<CommandRun>;
  /** Start a command that outlives the daemon, with its output appended to `logFile`. */
  launch(command: string, args: readonly string[], logFile: string): Promise<{ readonly code: number | null; readonly stderr?: string }>;
  /** Whether a path exists. */
  exists(path: string): boolean;
}

export interface RestartLauncherOptions {
  /** `PI_SEC_HOME`, handed to the script so it finds both trees. */
  readonly home: string;
  readonly workspaceTree: string;
  readonly snapshotTree: string;
  readonly logsDir: string;
  readonly runDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The node binary this daemon runs on; its directory goes first on the script's PATH. */
  readonly nodePath: string;
  readonly hooks?: RestartHooks;
  readonly now?: () => number;
  /**
   * End this process, under the runner, after the HTTP answer is on the wire.
   *
   * Injected rather than reached for: the launcher decides when a restart is
   * granted, and the process that owns the shutdown decides how it ends. The
   * daemon passes the same shutdown a signal takes, with `RUNNER_EXIT_CODE`.
   */
  readonly exitForRunner?: (code: number) => void;
}

/** How a restart is asked for. `reinstall` adds `--reinstall` to the script. */
export interface RestartLaunchOptions {
  /** Delete the execution tree's node_modules and install it again from the lock. */
  readonly reinstall?: boolean;
}

export interface RestartAccepted {
  readonly ok: true;
  /**
   * `systemd` hands the script to a transient unit of its own; `runner` ends
   * this process, and `user-tools/run` applies the update and starts it again.
   */
  readonly mode: "systemd" | "runner";
  /** The transient unit, in systemd mode. Absent under the runner: there is none. */
  readonly unit?: string;
  readonly logFile: string;
  readonly script: string;
  readonly requestedAt: number;
  /**
   * Runner mode only: end the daemon. Called once the answer has been flushed,
   * so the page that asked gets its 202 instead of a closed socket.
   */
  readonly exitAfterAnswer?: () => void;
}

export interface RestartRefused {
  readonly ok: false;
  /** HTTP status the route should answer with. */
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type RestartOutcome = RestartAccepted | RestartRefused;

export interface PendingRestart {
  readonly at: number;
  readonly source: string;
}

export function restartMarkerPath(runDir: string): string {
  return join(runDir, RESTART_MARKER);
}

export function restartLogPath(logsDir: string): string {
  return join(logsDir, RESTART_LOG);
}

/** The script the operator runs by hand: the workspace copy, else the execution tree's. */
export function restartScriptPath(workspaceTree: string, snapshotTree: string, exists: (path: string) => boolean = existsSync): string | undefined {
  const candidates = [join(workspaceTree, "user-tools", "update-and-restart"), join(snapshotTree, "user-tools", "update-and-restart")];
  return candidates.find((candidate) => exists(candidate));
}

/** A unit name systemd accepts, and one a human can recognise in `systemctl --user list-units`. */
export function restartUnitName(at: number): string {
  return `pi-sec-restart-${Math.floor(at / 1000)}`;
}

export function defaultRestartHooks(): RestartHooks {
  return {
    probe: (command, args) =>
      new Promise<CommandRun>((resolve) => {
        const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 5000 });
        resolve({
          code: result.status ?? (result.error === undefined ? null : 1),
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? result.error?.message ?? "",
        });
      }),
    launch: async (command, args, logFile) => {
      await mkdir(dirname(logFile), { recursive: true });
      const fd = openSync(logFile, "a", 0o600);
      try {
        const child = spawnChild(command, [...args], { detached: true, stdio: ["ignore", fd, fd] });
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
            resolve(null);
          }, 10_000);
          child.once("error", () => {
            clearTimeout(timer);
            resolve(1);
          });
          child.once("exit", (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
          });
        });
        return { code };
      } finally {
        closeSync(fd);
      }
    },
    exists: existsSync,
  };
}

/**
 * Asks an outside unit to run the update script, and remembers that it did.
 *
 * One process answers one of these: a second request while the first is still
 * running would only race the same stop and build.
 */
export class RestartLauncher {
  readonly #options: RestartLauncherOptions;
  readonly #hooks: RestartHooks;
  readonly #now: () => number;
  #requested = false;
  #exiting = false;

  constructor(options: RestartLauncherOptions) {
    this.#options = options;
    this.#hooks = options.hooks ?? defaultRestartHooks();
    this.#now = options.now ?? (() => Date.now());
  }

  /** Whether this process already handed a restart to systemd. */
  get requested(): boolean {
    return this.#requested;
  }

  get logFile(): string {
    return restartLogPath(this.#options.logsDir);
  }

  async launch(source = "ui", options: RestartLaunchOptions = {}): Promise<RestartOutcome> {
    const reinstall = options.reinstall === true;
    if (this.#requested) {
      return {
        ok: false,
        status: 409,
        code: "already_requested",
        message: "this daemon has already asked for a restart; wait for it to come back",
      };
    }

    // Before any `systemctl` probe: a daemon under the runner answers to the
    // runner and to nothing else, and probing a unit would be the first step of
    // driving one.
    if (this.#options.env[RUNNER_VARIABLE] === "1") {
      return this.#requestFromRunner(source, reinstall);
    }

    const service = await this.#serviceKind();
    if (service === "none") {
      return {
        ok: false,
        status: 409,
        code: "no_unit",
        message:
          "no systemd unit named pi-sec was found and the daemon is not running under user-tools/run; stop the daemon, run user-tools/update-and-restart, and start the daemon again",
      };
    }
    if (service === "system") {
      // The system unit needs sudo, which this process does not have and must
      // not want. Say so instead of stopping a service nothing can start again.
      return {
        ok: false,
        status: 409,
        code: "system_unit",
        message: "pi-sec runs under a system unit, which needs sudo to restart; run user-tools/update-and-restart yourself",
      };
    }

    const systemdRun = await this.#hooks.probe("systemd-run", ["--version"]);
    if (systemdRun.code !== 0) {
      return {
        ok: false,
        status: 500,
        code: "systemd_run_missing",
        message: "systemd-run is not available; run user-tools/update-and-restart yourself",
      };
    }

    const script = restartScriptPath(this.#options.workspaceTree, this.#options.snapshotTree, this.#hooks.exists);
    if (script === undefined) {
      return {
        ok: false,
        status: 500,
        code: "script_missing",
        message: "user-tools/update-and-restart was not found in either tree",
      };
    }

    const requestedAt = this.#now();
    const unit = restartUnitName(requestedAt);
    const logFile = this.logFile;
    await this.#writeMarker(requestedAt, source, reinstall);

    const result = await this.#hooks.launch("systemd-run", this.#unitArgs(unit, script, logFile, reinstall), logFile);
    if (result.code !== 0) {
      await rm(restartMarkerPath(this.#options.runDir), { force: true });
      const detail = result.code === null ? "systemd-run did not answer within 10s" : `systemd-run exited with ${result.code}`;
      return { ok: false, status: 500, code: "launch_failed", message: `${detail}; see ${logFile}` };
    }

    this.#requested = true;
    return { ok: true, mode: "systemd", unit, logFile, script, requestedAt };
  }

  /**
   * The runner path: write the marker, and end this process once the answer is
   * out. The script is found the same way as for systemd, and a tree without one
   * is refused the same way: the runner would have nothing to run.
   */
  async #requestFromRunner(source: string, reinstall: boolean): Promise<RestartOutcome> {
    const script = restartScriptPath(this.#options.workspaceTree, this.#options.snapshotTree, this.#hooks.exists);
    if (script === undefined) {
      return {
        ok: false,
        status: 500,
        code: "script_missing",
        message: "user-tools/update-and-restart was not found in either tree",
      };
    }

    const requestedAt = this.#now();
    await this.#writeMarker(requestedAt, source, reinstall);
    this.#requested = true;
    const exit = this.#options.exitForRunner;
    return {
      ok: true,
      mode: "runner",
      logFile: this.logFile,
      script,
      requestedAt,
      ...(exit === undefined ? {} : { exitAfterAnswer: () => this.#exitAfterAnswer(exit) }),
    };
  }

  /** End the daemon once, even if a route asks twice. */
  #exitAfterAnswer(exit: (code: number) => void): void {
    if (this.#exiting) return;
    this.#exiting = true;
    exit(RUNNER_EXIT_CODE);
  }

  /**
   * Written before the script starts: it is what the next boot reads when the
   * restart never finished. The script removes it on success. A forced reinstall
   * is named apart, so the runner and the next boot can say which entry failed.
   */
  async #writeMarker(requestedAt: number, source: string, reinstall: boolean): Promise<void> {
    const markerSource = reinstall && source === "ui" ? "ui-reinstall" : source;
    await mkdir(this.#options.runDir, { recursive: true });
    await writeFile(restartMarkerPath(this.#options.runDir), `${JSON.stringify({ at: requestedAt, source: markerSource })}\n`, { mode: 0o600 });
  }

  #unitArgs(unit: string, script: string, logFile: string, reinstall: boolean): readonly string[] {
    const { env, home, nodePath } = this.#options;
    // A transient unit inherits the *user manager's* environment, not this
    // process's. That environment has no node on PATH, so `npm ci` and
    // `npm run build` would fail inside the script. Pass what it needs.
    const path = [dirname(nodePath), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].filter(Boolean).join(":");
    // The command up to the script name, which is `$0` below. The argument that
    // differs is appended to this, so the plain command is unchanged.
    const execHead = 'echo "[$(date -Is)] restart requested from the web UI"; sleep 2; exec "$0"';
    return [
      "--user",
      "--collect",
      `--unit=${unit}`,
      "--description=pi-sec: update and restart, requested from the web UI",
      `--setenv=PATH=${path}`,
      `--setenv=HOME=${env.HOME ?? home}`,
      `--setenv=PI_SEC_HOME=${home}`,
      "--",
      "bash",
      "-c",
      // Two seconds so the HTTP response and the page's "restarting" note get
      // out first. "$0" is the script, "$1" the log: no quoting of our own. The
      // forced reinstall adds the one argument the script reads as `--reinstall`.
      `${execHead}${reinstall ? ' --reinstall >>"$1" 2>&1' : ' >>"$1" 2>&1'}`,
      script,
      logFile,
    ];
  }

  async #serviceKind(): Promise<"user" | "system" | "none"> {
    const user = await this.#hooks.probe("systemctl", ["--user", "is-enabled", "pi-sec"]);
    if (user.code === 0) return "user";
    const system = await this.#hooks.probe("systemctl", ["is-enabled", "pi-sec"]);
    if (system.code === 0) return "system";
    return "none";
  }
}

/**
 * Read a marker left by a restart that never finished, and clear it.
 *
 * Called once at boot. The daemon that comes up after a failed update is the
 * only place the failure can be reported: the request came from the UI, so
 * nobody was watching a terminal.
 */
export async function readPendingRestart(runDir: string): Promise<PendingRestart | undefined> {
  const file = restartMarkerPath(runDir);
  try {
    const raw = await readFile(file, "utf8");
    await rm(file, { force: true });
    const parsed = JSON.parse(raw) as { at?: unknown; source?: unknown };
    if (typeof parsed.at !== "number") return undefined;
    return { at: parsed.at, source: typeof parsed.source === "string" ? parsed.source : "unknown" };
  } catch {
    return undefined;
  }
}

/** Report an unfinished restart in the notes the operator sees, once. */
export async function reportPendingRestart(runDir: string, notes: AdminNotes, logsDir: string): Promise<PendingRestart | undefined> {
  const pending = await readPendingRestart(runDir);
  if (pending === undefined) return undefined;
  notes.add(
    `the last restart attempt (${new Date(pending.at).toISOString()}) did not finish; see ${restartLogPath(logsDir)}`,
    pending.at,
  );
  return pending;
}
