/**
 * The remote machines: their level, their heartbeat, and their connections.
 *
 * One object owns everything this install does with a remote machine, and every
 * caller reads that state from it rather than keeping a copy: the HTTP routes, the
 * heartbeat timer, and the runtime's `setConfig`.
 *
 * ## What lives where
 *
 * `config.json` names the machines, their addresses, their users, the key file and
 * the interval. This module reads that key on every use and never copies it, so one
 * config reload reaches a running daemon (`docs/architecture.md` section 9).
 *
 * The store holds what this install decided and measured about each machine: the
 * level the operator chose, the user states, the first machine-id read, and any
 * block. It is keyed by the machine's id, so an address change keeps all of it.
 *
 * ## The rules that shape this file
 *
 *   - A machine at `off` is never contacted. The only ssh call it may cost is
 *     `-O exit`, which talks to a local socket and to nothing else.
 *   - A machine whose host key is not pinned is never contacted either. The panel
 *     says so, and nothing is written: an unpinned machine is the state before the
 *     operator's checked key is put in place, not a fault.
 *   - Two things stop every connection to a machine: a host key that is not the
 *     pinned one, and a machine-id that is not the expected one. A stop is durable
 *     and it stays until its evidence changes (`RemoteMachineBlockRecord.watch`).
 *   - A user state is written only when it changes. A machine that stays reachable
 *     for a day costs one write, not 1440.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type Harness, type Session, type Storage } from "@earendil-works/pi-durable";
import type { Config, RemoteMachineConfig, RemoteMachinesConfig } from "../config/schema.ts";
import {
  SecRemoteMachine,
  type RemoteMachineBlockRecord,
  type RemoteMachineOutageRecord,
  type RemoteMachinePendingRecord,
  type RemoteMachineRecord,
  type RemoteMachineUserRecord,
} from "../documents.ts";
import { createInboxItemTx } from "../jobs/inbox.ts";
import type { AuditLog } from "../runtime/audit.ts";
import type { Logger } from "../runtime/logger.ts";
import { expandPath, type Paths } from "../runtime/paths.ts";
import { zoneMinute } from "../time-format.ts";
import type { EventsSink } from "../extensions/context.ts";
import {
  loosens,
  type MachineBlock,
  type MachineBlockReason,
  type MachineLevel,
  type MachineLinkState,
  type MachinePending,
  type MachineUserState,
  type RemoteMachineState,
  type RemoteMachinesResponse,
} from "../shared/wire/remote-machines.ts";
import {
  automaticOffItemBody,
  automaticOffItemTitle,
  automaticOffText,
  hostKeyBlockedText,
  loosenedLevelText,
  machineIdBlockedText,
  sendRootNotice,
  sendRunNotice,
  tightDeadlineText,
  tightenRequestedText,
  type NoticeOutcome,
} from "./notices.ts";
import { strandedRunText } from "./run-texts.ts";
import { decideOutage } from "./outage.ts";
import {
  readHeartbeat,
  runSsh,
  runWithInput,
  sshArguments,
  type SshResult,
  type SshTarget,
} from "./ssh.ts";
import {
  execOnMachine,
  type Access,
  type AccessResult,
  type ProgramRunOptions,
  type RemotePlumbing,
  type RemotePrograms,
  type RemoteRunSettings,
  type RemoteToolName,
  type RunNoticeInput,
  type RunTimers,
} from "./plumbing.ts";
import { RemoteRuns, runSettings, type RunSummary } from "./checks.ts";
import { remoteScript } from "./runs.ts";
import { RemoteFiles } from "./files.ts";

/** The name this feature puts on its own control events. */
export const REMOTE_MACHINE_EVENT = "remote_machine_updated";

/** The command a heartbeat runs. It answers both "is it up" and "is it the same machine". */
export const HEARTBEAT_COMMAND: readonly string[] = ["cat", "/etc/machine-id"];

/** Deadline of one heartbeat, in milliseconds. */
export const HEARTBEAT_DEADLINE_MS = 20_000;

/** Deadline of one `-O exit`, in milliseconds. A local socket answers at once. */
export const EXIT_DEADLINE_MS = 5_000;

/** The default key file, as `src/config/schema.ts` declares it. */
export const DEFAULT_IDENTITY_FILE = "~/.ssh/id_ed25519";

/** The default heartbeat interval, as `src/config/schema.ts` declares it. */
export const DEFAULT_HEARTBEAT_SECONDS = 60;

/**
 * The default outage threshold, as `src/config/schema.ts` declares it.
 *
 * An hour, which is the approved value: long
 * enough that a reboot or a lost link does not ask a question, short enough that a
 * machine switched off for the night is noticed before morning.
 */
export const DEFAULT_OUTAGE_SECONDS = 3600;

/**
 * The run settings an install that declares `remoteMachines` but names none gets.
 *
 * They are also the schema's defaults; they are repeated here for the same reason
 * `DEFAULT_HEARTBEAT_SECONDS` is, so a config object built by hand reads the same
 * way as a file that passed validation.
 */
export const DEFAULT_RUN_SETTINGS: RemoteRunSettings = {
  runCheckSeconds: 1800,
  tightenDeadlineSeconds: 300,
  restrictedSeconds: 600,
};

/**
 * The one short command that answers "what is that machine doing".
 *
 * Three blocks with a marker each, so one round trip answers three questions and
 * the parse never has to guess what a line is: the load averages from
 * `/proc/loadavg`, the memory summary from the four keys of `/proc/meminfo` a
 * person reads, and `who` when the machine has it. `%` in a printf format is
 * doubled, because `sh`'s printf reads it as a conversion.
 */
export const LOAD_SCRIPT = `echo "loadavg=$(cat /proc/loadavg 2>/dev/null)"
echo "memtotal=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
echo "memavailable=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
echo "cpus=$(nproc 2>/dev/null)"
echo "sessions-begin"
who 2>/dev/null || echo "(who is not available on this machine)"
echo "sessions-end"`;

/** What the load read found, or why it could not. */
export type LoadResult =
  | {
      readonly kind: "ok";
      readonly load: string;
      /** Total memory in KiB, as `/proc/meminfo` reports it. */
      readonly memoryTotalKb: number | null;
      readonly memoryAvailableKb: number | null;
      readonly cpus: number | null;
      /** The `who` lines, one entry each, or a sentence that `who` is missing. */
      readonly sessions: readonly string[];
    }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** The agent record fields this feature reads, so it does not depend on the whole type. */
export interface AgentIdentity {
  readonly name: string;
  readonly status: string;
}

/**
 * Read {@link LOAD_SCRIPT}'s answer.
 *
 * Key by key, like the run facts, so a login banner cannot invent a number. The
 * session block is everything between its two markers, because `who` prints one
 * line per session and the number of them is the answer.
 */
export function parseLoad(stdout: string): {
  readonly load: string;
  readonly memoryTotalKb: number | null;
  readonly memoryAvailableKb: number | null;
  readonly cpus: number | null;
  readonly sessions: readonly string[];
} {
  let load = "";
  let memoryTotalKb: number | null = null;
  let memoryAvailableKb: number | null = null;
  let cpus: number | null = null;
  const sessions: string[] = [];
  let inSessions = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "sessions-begin") {
      inSessions = true;
      continue;
    }
    if (trimmed === "sessions-end") {
      inSessions = false;
      continue;
    }
    if (inSessions) {
      if (trimmed !== "") sessions.push(trimmed);
      continue;
    }
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at);
    const value = trimmed.slice(at + 1);
    if (key === "loadavg") load = value;
    else if (key === "memtotal") memoryTotalKb = toNumber(value);
    else if (key === "memavailable") memoryAvailableKb = toNumber(value);
    else if (key === "cpus") cpus = toNumber(value);
  }
  return { load, memoryTotalKb, memoryAvailableKb, cpus, sessions };
}

/** A number, or null when the text is not one. */
function toNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** The last line of some output that carries text, or the fallback. */
function lastLine(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? fallback : (lines[lines.length - 1] as string);
}

/**
 * The last ssh error a machine's users hold, in the config's user order.
 *
 * It is the text of the last failed heartbeat, as the notice carries it, so
 * the user can tell a machine that is off from a key or an account that stopped
 * working. A machine whose users hold no error text at all gets a sentence saying
 * so rather than an empty space in the notice.
 */
function lastFailure(errors: readonly (string | undefined)[]): string {
  const kept = errors.filter((error): error is string => error !== undefined && error !== "");
  return kept.length === 0 ? "no error was recorded" : (kept[kept.length - 1] as string);
}

/** What a caller may replace, for a test that must not start a real program. */
export interface RemoteMachinesOverrides {
  /** The program to run instead of `ssh`. A test passes the fixture's path. */
  readonly sshPath?: string;
  /** The program to run instead of `sftp`. A test passes the fixture's path. */
  readonly sftpPath?: string;
  /** The program to run instead of `rsync`. A test passes the fixture's path. */
  readonly rsyncPath?: string;
  /** Extra environment for those programs. */
  readonly sshEnv?: Readonly<Record<string, string>>;
  /** The clock. A test passes a counter it controls. */
  readonly now?: () => number;
  /** The deadline of one heartbeat. */
  readonly heartbeatDeadlineMs?: number;
  /** The timer device of the run checks. A test passes one it drives itself. */
  readonly timers?: RunTimers;
  /** The cap `remote_read` returns, in bytes. A test lowers it instead of writing a big file. */
  readonly readMaxBytes?: number;
}

/** The settings this module reads from one config. */
export interface RemoteMachinesSettings {
  readonly identityFile: string;
  readonly heartbeatSeconds: number;
  /** Seconds a machine may stay unreachable before the core makes it `off` (`outageSeconds`). */
  readonly outageSeconds: number;
  readonly machines: readonly RemoteMachineConfig[];
  /** The three run settings, read on every use. */
  readonly runs: RemoteRunSettings;
}

/**
 * The `remoteMachines` settings of one config, or undefined when the key is absent.
 *
 * The two defaults are applied here as well as in the schema, because a config a
 * test builds by hand does not pass through `Value.Default`. One reader of the
 * defaults would be better than two; the schema's default exists for the file an
 * operator writes, and this function exists for a config object any other caller
 * can hand over.
 */
export function readRemoteMachines(config: Config): RemoteMachinesSettings | undefined {
  const raw: RemoteMachinesConfig | undefined = config.remoteMachines;
  if (raw === undefined) return undefined;
  return {
    identityFile: raw.identityFile ?? DEFAULT_IDENTITY_FILE,
    heartbeatSeconds: raw.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
    outageSeconds: raw.outageSeconds ?? DEFAULT_OUTAGE_SECONDS,
    machines: raw.machines,
    runs: runSettings(raw),
  };
}

/** The machine with this id, or undefined. */
export function findMachine(
  settings: RemoteMachinesSettings | undefined,
  id: string,
): RemoteMachineConfig | undefined {
  return settings?.machines.find((machine) => machine.id === id);
}

/**
 * The path of the socket of one machine and user.
 *
 * A digest of the machine's name and the user's name, so a change of address keeps
 * the name and `-O exit` always finds the socket it opened. Sixteen hex characters
 * keep the whole path at 43 bytes for the default install, well under the 108-byte
 * limit of a unix socket path, and `src/config/load.ts` refuses a home that would
 * not fit.
 */
export function controlPathFor(paths: Paths, machineId: string, user: string): string {
  const digest = createHash("sha256").update(`${machineId}\u0000${user}`).digest("hex").slice(0, 16);
  return join(paths.sshSocketDir, digest);
}

/**
 * The name the pinned key is filed under in the known_hosts file.
 *
 * `HostKeyAlias` makes ssh look the key up by this name, so this is what a line in
 * the file carries. A non-default port is part of the name ssh writes, because
 * `known_hosts` names such a host `[host]:port`.
 */
export function hostKeyName(machineId: string, port: number): string {
  return port === 22 ? machineId : `[${machineId}]:${port}`;
}

/**
 * Whether the pinned-keys file holds a key for this machine.
 *
 * The file is read whole: it holds one short line per machine, so a parse of the
 * first field of every line is cheaper than any index. A missing file is not an
 * error: it means nothing has been pinned yet.
 */
export async function pinnedHostKey(file: string, machineId: string, port: number): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  const name = hostKeyName(machineId, port);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const first = trimmed.split(/\s+/)[0];
    if (first === name) return true;
  }
  return false;
}

/**
 * One digest of the pinned keys and one machine's config entry.
 *
 * It is the evidence a block watches. Both halves are the operator's own act: the
 * file changes when they pin a key, the entry changes when they edit the config.
 * A block ends when either changes, so accepting a new key or a new address needs
 * no button and never re-alerts on a clock.
 */
export async function blockWatch(knownHostsFile: string, machine: RemoteMachineConfig): Promise<string> {
  let keys = "";
  try {
    keys = await readFile(knownHostsFile, "utf8");
  } catch {
    keys = "";
  }
  return createHash("sha256").update(`${keys}\u0000${JSON.stringify(machine)}`).digest("hex");
}

/** What `setLevel` came to. */
export type SetLevelOutcome =
  | { readonly kind: "ok"; readonly machine: RemoteMachineState; readonly changed: boolean }
  | { readonly kind: "not-found" }
  | { readonly kind: "disabled" };

/** What `tighten` came to: the same answers, and the refusal a widening gets. */
export type TightenOutcome = SetLevelOutcome | { readonly kind: "refused"; readonly reason: string };

export interface RemoteMachinesOptions {
  readonly paths: Paths;
  /** The live config. Read on every use; never copied. */
  readonly getConfig: () => Config;
  /** The store, once the harness exists. Absent until then. */
  readonly session: () => Session | undefined;
  /** The harness, for the root conversation. Absent until it is built. */
  readonly harness?: () => Pick<Harness, "conversation"> | undefined;
  /** The harness storage, for the one document scan this feature performs. */
  readonly storage?: () => Pick<Storage, "scanDocuments"> | undefined;
  /**
   * The agent record of one conversation, or undefined when there is none.
   *
   * A run check answers the conversation that started the run, and it needs to know
   * whether that conversation is still somewhere a message can be read: a record
   * that ended as stopped, failed or deleted is not. The tightening request names
   * the agent that started each run, so it reads the record's name and kind too.
   */
  readonly agent?: (conversationId: string) => Promise<AgentIdentity | undefined>;
  readonly audit: Pick<AuditLog, "append">;
  readonly logger: Pick<Logger, "debug" | "info" | "warn">;
  readonly events: EventsSink;
  readonly overrides?: RemoteMachinesOverrides;
}

/** A machine that has a heartbeat running, so the next round skips it. */
type BusySet = Set<string>;

/**
 * The remote machines of one runtime.
 *
 * There is one of these per process. It holds no state of its own that matters:
 * the level and the measured states are in the store, and the in-flight set exists
 * only to keep two rounds from overlapping.
 */
export class RemoteMachines {
  readonly #paths: Paths;
  readonly #getConfig: () => Config;
  readonly #session: () => Session | undefined;
  readonly #harness: (() => Pick<Harness, "conversation"> | undefined) | undefined;
  readonly #storage: (() => Pick<Storage, "scanDocuments"> | undefined) | undefined;
  readonly #agent: ((conversationId: string) => Promise<AgentIdentity | undefined>) | undefined;
  readonly #audit: Pick<AuditLog, "append">;
  readonly #logger: Pick<Logger, "debug" | "info" | "warn">;
  readonly #events: EventsSink;
  readonly #now: () => number;
  readonly #sshPath: string | undefined;
  readonly #sshEnv: Readonly<Record<string, string>> | undefined;
  readonly #heartbeatDeadlineMs: number;
  readonly #overrides: RemoteMachinesOverrides | undefined;
  /** Runs this install started, and the check timer of each. */
  readonly #runs: RemoteRuns;
  /** The sftp and rsync tools. */
  readonly #files: RemoteFiles;
  /** Machines with a round running right now. */
  readonly #busy: BusySet = new Set<string>();
  /** Machines whose heartbeat came back since the last failure, so a check runs at once. */
  readonly #recovered: Set<string> = new Set<string>();
  /** Machines with a tightening whose deadline is armed. */
  readonly #deadlines: Map<string, ReturnType<typeof setTimeout>> = new Map<string, ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: RemoteMachinesOptions) {
    this.#paths = options.paths;
    this.#getConfig = options.getConfig;
    this.#session = options.session;
    this.#harness = options.harness;
    this.#audit = options.audit;
    this.#logger = options.logger;
    this.#events = options.events;
    this.#now = options.overrides?.now ?? (() => Date.now());
    this.#sshPath = options.overrides?.sshPath;
    this.#sshEnv = options.overrides?.sshEnv;
    this.#heartbeatDeadlineMs = options.overrides?.heartbeatDeadlineMs ?? HEARTBEAT_DEADLINE_MS;
    this.#overrides = options.overrides;
    this.#storage = options.storage;
    this.#agent = options.agent;
    const plumbing = this.#plumbing();
    this.#runs = new RemoteRuns(plumbing);
    this.#files = new RemoteFiles(plumbing);
  }

  /** Every run this install started, newest first. */
  runs(): RemoteRuns {
    return this.#runs;
  }

  /** The sftp and rsync tools. */
  files(): RemoteFiles {
    return this.#files;
  }

  /**
   * The seam the run, check and file modules use, in one object.
   *
   * It is built once and closes over the manager, so a module that was handed it
   * cannot see a stale config or a stale store: `getConfig` and `session` are the
   * manager's own lazy reads.
   */
  #plumbing(): RemotePlumbing {
    const manager = this;
    return {
      timers: manager.#timers(),
      now: () => manager.#now(),
      timezone: () => manager.#getConfig().timezone,
      settings: () => {
        const settings = manager.settings();
        return settings === undefined ? DEFAULT_RUN_SETTINGS : settings.runs;
      },
      session: () => manager.#session(),
      storage: () => manager.#storage?.(),
      audit: (event) => manager.#audit.append(event),
      logger: () => manager.#logger,
      programs: () => ({
        ssh: manager.#sshPath ?? "ssh",
        sftp: manager.#overrides?.sftpPath ?? "sftp",
        rsync: manager.#overrides?.rsyncPath ?? "rsync",
      }),
      environment: () => manager.#sshEnv,
      run: async (program, args, runOptions) => await manager.#runProgram(program, args, runOptions),
      access: async (machine, tool, user, accessOptions) =>
        await manager.access(machine, tool, user, accessOptions),
      deliver: async (notice) => await manager.#deliver(notice),
      onRunSettled: (machine, runId) => manager.#onRunSettled(machine, runId),
    };
  }

  /** The timer device: the one a test named, or real timers that do not hold the process. */
  #timers(): RunTimers {
    const override = this.#overrides?.timers;
    if (override !== undefined) return override;
    return {
      set(callback, delayMs) {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      },
    };
  }

  /** The settings of the current config, or undefined while the feature is off. */
  settings(): RemoteMachinesSettings | undefined {
    return readRemoteMachines(this.#getConfig());
  }

  /**
   * The list the panel draws.
   *
   * Config order, one entry per configured machine. A machine whose store record
   * cannot be read is answered from the record's initial value rather than
   * dropped: a machine the operator registered is always on the list, because a
   * missing row looks like a machine that is not registered.
   */
  async list(ctx: Context = BACKGROUND_CONTEXT): Promise<RemoteMachinesResponse> {
    const settings = this.settings();
    if (settings === undefined) return { enabled: false, machines: [] };
    const machines: RemoteMachineState[] = [];
    for (const machine of settings.machines) {
      machines.push(await this.#state(machine));
    }
    void ctx;
    return { enabled: true, machines };
  }

  /** One machine's state, or undefined when the config does not name it. */
  async state(id: string): Promise<RemoteMachineState | undefined> {
    const machine = findMachine(this.settings(), id);
    if (machine === undefined) return undefined;
    return await this.#state(machine);
  }

  // -- the step check ------------------------------------------------------

  /**
   * Whether one tool may act on one machine and user, and what it acts on.
   *
   * This is the whole rule and nothing else. Every tool calls it, and so
   * does every module a tool hands its work to, because a tool that forgets it is
   * then the only thing that forgot it.
   *
   * The order is the table's order, and the order is the rule:
   *
   *   1. No `remoteMachines` key: the feature is off and every tool refuses.
   *   2. A machine the config does not name: not registered.
   *   3. A user the config does not name: not registered either, because a run as
   *      an unknown account would be a run this install never agreed to.
   *   4. A machine at `off`: refused, and the sentence says that widening is the
   *      user's own act. Nothing is contacted.
   *   5. A stopped machine, or one whose host key is not pinned: refused, with the
   *      reason the block records.
   *   6. `sync` at `restricted`: refused, because the size of a copy is not known
   *      before it starts.
   *
   * `run` at `restricted` passes here; the limit is applied by the caller as the
   * `ionice`/`nice`/`timeout` wrapper, because it changes how the command runs
   * rather than whether it may.
   *
   * `ignoreLevel` is the core's own exception, described on `RemotePlumbing`.
   */
  async access(
    machine: string,
    tool: RemoteToolName,
    user?: string,
    options?: { readonly ignoreLevel?: boolean },
  ): Promise<AccessResult> {
    const settings = this.settings();
    if (settings === undefined) {
      return {
        ok: false,
        reason: "the remote machines feature is off: config.json has no remoteMachines key",
      };
    }
    const config = findMachine(settings, machine);
    if (config === undefined) return { ok: false, reason: `no remote machine is registered as ${machine}` };
    const chosen = user ?? config.users[0];
    if (chosen === undefined || !config.users.includes(chosen)) {
      return {
        ok: false,
        reason: `user ${user ?? ""} is not registered on ${machine}; its users are ${config.users.join(", ")}`,
      };
    }
    const level = await this.levelOf(machine);
    if (level === "off" && options?.ignoreLevel !== true) {
      return {
        ok: false,
        reason:
          `remote machine ${machine} is at level off, so nothing may be done on it. ` +
          "Only the user widens a level, with the sidebar slider.",
      };
    }
    const record = await this.#record(machine);
    if (record.block !== undefined) {
      const reason =
        record.block.reason === "host-key-mismatch"
          ? "its host key is not the pinned one"
          : "its machine-id is not the expected one";
      return { ok: false, reason: `connections to remote machine ${machine} are stopped: ${reason}` };
    }
    const port = config.port ?? 22;
    if (!(await pinnedHostKey(this.#paths.remoteKnownHostsFile, machine, port))) {
      return { ok: false, reason: `remote machine ${machine} has no pinned host key` };
    }
    if (tool === "sync" && level === "restricted") {
      return {
        ok: false,
        reason:
          `remote_sync is not allowed on ${machine} at level restricted, because the size of a copy ` +
          "is not known before it starts. Ask the user for a wider level.",
      };
    }
    return { ok: true, level, machineId: machine, user: chosen, target: this.#target(config, settings, chosen) };
  }

  /**
   * Read a machine's load, memory and logged-in sessions in one ssh call.
   *
   * The command prints three blocks with markers, so one round trip answers all
   * three questions: the load averages from `/proc/loadavg`, the memory summary
   * from `/proc/meminfo`, and the sessions from `who` when it exists. This is what
   * `remote_machines` with a machine name runs, and it is why that tool takes no
   * argument to stay free: with no name, nothing is contacted.
   */
  async load(machine: string, user?: string): Promise<LoadResult> {
    const access = await this.access(machine, "machines", user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const result = await execOnMachine(this.#plumbing(), access, remoteScript(LOAD_SCRIPT), {
      timeoutMs: HEARTBEAT_DEADLINE_MS,
    });
    if (result.timedOut) return { kind: "failed", reason: "the machine did not answer in time" };
    if (result.code !== 0) return { kind: "failed", reason: lastLine(result.stderr, "the machine did not answer") };
    return { kind: "ok", ...parseLoad(result.stdout) };
  }

  /**
   * How much this install may do on one machine, as stored.
   *
   * A machine nobody has set reads as `off`, which is the record's initial value
   * and the safe answer: it is also what a store that cannot answer gives.
   */
  async levelOf(id: string): Promise<MachineLevel> {
    const record = await this.#record(id);
    return levelOfRecord(record);
  }

  /**
   * Change one machine's level, and apply the change.
   *
   * The new level is always stored at once, in this commit and no later one. What
   * follows depends on the direction, and the direction is `loosens`:
   *
   *   - **Loosening** (a wider level) needs nothing but one root notice, numbered by
   *     the change so the same change cannot be announced twice, and one read of the
   *     runs the automatic off stranded while the machine was `off`. The slider is
   *     already true the moment it lands.
   *   - **Tightening** (a narrower level) has to end or wait for the runs the new
   *     level does not allow. Runs that no longer fit are found
   *     first. With none, the level applies at once, which is the earlier
   *     behaviour and the common case. With some, the record gets `pending`, the
   *     root gets one request naming the runs and the deadline, the deadline is
   *     armed, and the connections stay open until the runs are gone: an `off`
   *     that closed them immediately would leave the cleanup no way to reach the
   *     machine.
   *   - **The same level as before** does nothing at all: no write, no notice, no
   *     ssh call.
   *
   * ## The two defects this fixes
   *
   * A heartbeat that is running while the level moves is the same machine being
   * contacted twice, and the earlier code moved without looking at it. Both halves are
   * fixed here:
   *
   *   - `#closeConnections` waits for a heartbeat on that machine to finish before
   *     it sends `-O exit`, so a connection opened by a round that was already
   *     running is not left for up to five minutes.
   *   - The immediate check that follows a move away from `off` is skipped while a
   *     heartbeat is running, because that round records the same answer this check
   *     would have written.
   */
  async setLevel(id: string, level: MachineLevel, ctx: Context = BACKGROUND_CONTEXT): Promise<SetLevelOutcome> {
    const settings = this.settings();
    if (settings === undefined) return { kind: "disabled" };
    const machine = findMachine(settings, id);
    if (machine === undefined) return { kind: "not-found" };
    const session = this.#session();
    if (session === undefined) return { kind: "not-found" };

    const before = await this.#record(id);
    const previous = levelOfRecord(before);
    const now = this.#now();
    const changed = previous !== level;
    if (changed) {
      const next: RemoteMachineRecord = {
        ...before,
        level,
        levelChangedAt: now,
        levelSequence: before.levelSequence + 1,
        // A new change replaces whatever wait the last one left, so a level that
        // moved twice before anything was cleaned up has one wait, not two.
        pending: null,
        updatedAt: now,
      };
      await session.commit(async (tx) => {
        const draft = await tx.doc(SecRemoteMachine, id, id);
        Object.assign(draft, next);
      }, ctx);
      this.#audit.append({ type: "remote_machine_level", machine: id, from: previous, to: level, at: now });
      if (loosens(previous, level)) {
        await this.#sendNotice(
          {
            machine: id,
            kind: "loosened",
            requestId: `remote-machine-loosen:<${id}>:<${next.levelSequence}>`,
            text: loosenedLevelText({
              machine: id,
              from: previous,
              to: level,
              time: zoneMinute(now, this.#getConfig().timezone),
            }),
          },
          ctx,
        );
        // A run the automatic off stranded was settled, so nothing read it while the
        // machine was `off`. The machine answers again at this level, so the core
        // reads those runs once and each starting conversation learns what became of
        // its run.
        await this.#runs.wakeStranded(id, ctx);
      }
      // Only a real change is announced: a frame that says a machine was updated
      // when nothing moved would make an open page read the list for nothing.
      this.#events.emit(REMOTE_MACHINE_EVENT, { id });
      this.#clearDeadline(id);
    }

    const tightening = changed && !loosens(previous, level);
    if (tightening) {
      const waiting = await this.#beginTightening(machine, previous, level, ctx);
      if (waiting) {
        // Runs that no longer fit are out there: the connections stay open, because
        // the cleanup needs one, and the deadline or the last run's end closes them.
        // Nothing is heartbeated at `off`, so the check below is skipped here.
        return { kind: "ok", machine: await this.#state(machine), changed };
      }
      // Nothing to clean up, so the level applies at once: this is the earlier
      // behaviour, and it is the common case.
      if (level === "off") await this.#closeConnections(machine, settings);
    } else if (level === "off" && changed) {
      await this.#closeConnections(machine, settings);
    }

    // A move away from `off` checks the machine at once, so the panel can answer
    // "is it there" without waiting a whole interval. A machine with a heartbeat
    // already running is left to that round, which is about to write the same
    // answer: that is the second defect this fixes.
    if (changed && level !== "off" && !this.#busy.has(id)) {
      await this.#checkMachine(machine, settings, ctx);
    }
    return { kind: "ok", machine: await this.#state(machine), changed };
  }

  /**
   * Make a machine stricter for the root, which is the only caller of this path.
   *
   * The slider's `setLevel` takes any level, because a wider one is the user's own
   * act. An agent asks the other way round: it has no way to widen a level, and the
   * one level it can ask for is a stricter one. So the same stored change runs here
   * after two guards, and `reason` is written to the audit trail beside the change:
   * the runner of this install can then see why its own level moved, and by what
   * argument, without reading a conversation.
   *
   * A widening, and the level `on`, are refused here rather than in the tool, so a
   * tool that forgets the rule still cannot widen a machine. The rest is exactly
   * `setLevel`: the wait, the root request, the deadline and the cleanup of section
   * 5.6 start from this one call.
   */
  async tighten(
    machine: string,
    level: MachineLevel,
    reason: string,
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<TightenOutcome> {
    const settings = this.settings();
    if (settings === undefined) return { kind: "disabled" };
    if (findMachine(settings, machine) === undefined) return { kind: "not-found" };
    if (level !== "off" && level !== "restricted") {
      return {
        kind: "refused",
        reason: `level ${level} is not a tightening: only off and restricted are stricter than a level`,
      };
    }
    const previous = await this.levelOf(machine);
    if (loosens(previous, level)) {
      return {
        kind: "refused",
        reason:
          `level ${level} is wider than ${previous} on ${machine}, and only the user widens a level, ` +
          "with the sidebar slider",
      };
    }
    const outcome = await this.setLevel(machine, level, ctx);
    if (outcome.kind === "ok" && outcome.changed) {
      this.#audit.append({
        type: "remote_machine_tighten",
        machine,
        from: previous,
        to: level,
        reason,
      });
    }
    return outcome;
  }

  // -- tightening: the wait and the cleanup --------------

  /**
   * Find the runs a new level does not allow, and set out to end them.
   *
   * Returns true when a wait was set, which means at least one run was found. The
   * five steps, in order, are all here: the wait in the record, the one
   * root request, the panel's line (which reads the record), the armed deadline,
   * and the point where the wait is dropped once nothing is left.
   *
   * A machine that cannot be read right now still gets the wait: the runs are known
   * from the store, and the deadline is what makes the cleanup happen when the
   * machine comes back. The wait is kept while the machine is away.
   */
  async #beginTightening(
    machine: RemoteMachineConfig,
    from: MachineLevel,
    to: MachineLevel,
    ctx: Context,
  ): Promise<boolean> {
    const left = await this.#runs.runsThatDoNotFit(machine.id, to);
    if (left.length === 0) return false;
    const now = this.#now();
    const deadline = now + this.settings()!.runs.tightenDeadlineSeconds * 1000;
    const pending: RemoteMachinePendingRecord = { level: to, since: now, deadline, runs: left.length };
    const session = this.#session();
    if (session !== undefined) {
      await session.commit(async (tx) => {
        const draft = await tx.doc(SecRemoteMachine, machine.id, machine.id);
        draft.pending = pending;
        draft.updatedAt = now;
      }, ctx);
    }
    const runs = await Promise.all(
      left.map(async (run) => ({ run: run.id, agent: await this.#agentName(run.conversationId) })),
    );
    await this.#sendNotice(
      {
        machine: machine.id,
        kind: "tighten-requested",
        requestId: `remote-machine-tighten:<${machine.id}>:<${now}>`,
        text: tightenRequestedText({
          machine: machine.id,
          from,
          to,
          time: zoneMinute(now, this.#getConfig().timezone),
          runs,
          deadline: `${String(this.settings()!.runs.tightenDeadlineSeconds)} seconds`,
          deadlineTime: zoneMinute(deadline, this.#getConfig().timezone),
        }),
      },
      ctx,
    );
    this.#audit.append({
      type: "remote_machine_tightening",
      machine: machine.id,
      from,
      to,
      runs: left.length,
      deadline,
    });
    this.#armDeadline(machine.id, pending, ctx);
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine.id });
    return true;
  }

  /**
   * Arm the deadline of every tightening the previous process left behind.
   *
   * The wait is stored, so a daemon that stops in the middle of one starts again
   * with the same wait: the deadline is re-armed from the stored moment, and one
   * that passed while the process was down runs as soon as this boot is up. That is
   * the rule for a machine that was away, applied to the process instead of
   * the machine: the cleanup happens when it can, and the wait stays until then.
   */
  async #resumeTightenings(ctx: Context): Promise<void> {
    const settings = this.settings();
    if (settings === undefined) return;
    for (const machine of settings.machines) {
      const record = await this.#record(machine.id);
      if (record.pending === null) continue;
      this.#armDeadline(machine.id, record.pending, ctx);
    }
  }

  /** Arm the moment the core stops what is left. */
  #armDeadline(machine: string, pending: RemoteMachinePendingRecord, ctx: Context): void {
    this.#clearDeadline(machine);
    const delay = Math.max(0, pending.deadline - this.#now());
    const handle = this.#timers().set(async () => {
      this.#deadlines.delete(machine);
      try {
        await this.#passDeadline(machine, ctx);
      } catch (error) {
        this.#logger.warn("remote machine tightening deadline failed", { machine, error });
      }
    }, delay);
    this.#deadlines.set(machine, handle as unknown as ReturnType<typeof setTimeout>);
  }

  #clearDeadline(machine: string): void {
    const handle = this.#deadlines.get(machine);
    if (handle === undefined) return;
    (handle as unknown as { cancel(): void }).cancel();
    this.#deadlines.delete(machine);
  }

  /**
   * The deadline passed: stop what is left, say so, and drop the wait.
   *
   * This is the one irreversible step of the feature. Every run
   * the level does not allow is stopped with the core named as the one that did it,
   * the core's stop is the one that also tells the run's conversation, and the root
   * gets one message that names them. A machine that cannot be reached is not
   * skipped: the stop is retried when it comes back, and the wait stays until then.
   */
  async #passDeadline(machine: string, ctx: Context): Promise<void> {
    const record = await this.#record(machine);
    const pending = record.pending;
    if (pending === null) return;
    const level = levelWord(pending.level);
    const left = await this.#runs.runsThatDoNotFit(machine, level);
    const stopped: string[] = [];
    let unreachable = false;
    for (const run of left) {
      const outcome = await this.#runs.stop({
        runId: run.id,
        who: "core",
        notify: true,
        skipAccessCheck: true,
        ctx,
      });
      if (outcome.kind === "stopped") stopped.push(run.id);
      else if (outcome.kind === "failed" || outcome.kind === "refused") unreachable = true;
    }
    const now = this.#now();
    if (unreachable) {
      // The machine is away. The wait stays, and the deadline moves so the next
      // attempt is not a tight loop.
      const again: RemoteMachinePendingRecord = {
        ...pending,
        deadline: now + this.settings()!.runs.tightenDeadlineSeconds * 1000,
        runs: left.length,
      };
      const session = this.#session();
      if (session !== undefined) {
        await session.commit(async (tx) => {
          const draft = await tx.doc(SecRemoteMachine, machine, machine);
          draft.pending = again;
          draft.updatedAt = now;
        }, ctx);
      }
      this.#armDeadline(machine, again, ctx);
      return;
    }
    if (stopped.length > 0) {
      await this.#sendNotice(
        {
          machine,
          kind: "tighten-deadline",
          requestId: `remote-machine-tighten-deadline:<${machine}>:<${now}>`,
          text: tightDeadlineText({
            time: zoneMinute(now, this.#getConfig().timezone),
            count: stopped.length,
            runs: stopped,
            machine,
            level,
          }),
        },
        ctx,
      );
    }
    this.#audit.append({
      type: "remote_machine_tightened",
      machine,
      level,
      stopped: stopped.length,
      at: now,
    });
    await this.#finishTightening(machine, await this.#record(machine), ctx);
  }

  /**
   * Nothing that does not fit is left, so the wait goes and the machine settles.
   *
   * A machine at `off` closes its connections here rather than when the slider
   * moved, which is the whole reason the wait keeps them open: the cleanup needs
   * the connection, and closing it first would leave the cleanup with no way in.
   */
  async #finishTightening(machine: string, record: RemoteMachineRecord, ctx: Context): Promise<void> {
    this.#clearDeadline(machine);
    const session = this.#session();
    if (session === undefined) return;
    const now = this.#now();
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, machine, machine);
      draft.pending = null;
      draft.updatedAt = now;
    }, ctx);
    if (levelOfRecord(record) === "off") {
      const settings = this.settings();
      if (settings !== undefined) {
        const config = findMachine(settings, machine);
        if (config !== undefined) await this.#closeConnections(config, settings);
      }
    }
    this.#audit.append({ type: "remote_machine_tightening_done", machine, at: now });
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine });
  }

  /** Write the number of runs that still do not fit, without moving the deadline. */
  async #updatePendingCount(machine: string, record: RemoteMachineRecord, runs: number): Promise<void> {
    if (record.pending === null || record.pending.runs === runs) return;
    const session = this.#session();
    if (session === undefined) return;
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, machine, machine);
      if (draft.pending !== null) draft.pending = { ...draft.pending, runs };
      draft.updatedAt = this.#now();
    }, BACKGROUND_CONTEXT);
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine });
  }

  /**
   * The name of the agent that started a run, as the tightening request names it.
   *
   * A run started by a conversation with no record is named by its id: the root
   * would have to ask somebody, and an id is at least something the log can be
   * searched for. A run started from the root itself is named `the root`.
   */
  async #agentName(conversationId: string | null): Promise<string> {
    if (conversationId === null) return "the root";
    if (conversationId === String(ROOT_CONVERSATION_ID)) return "the root";
    const record = this.#agent === undefined ? undefined : await this.#agent(conversationId).catch(() => undefined);
    if (record === undefined) return conversationId;
    return record.name === "" ? conversationId : record.name;
  }

  /**
   * Start the heartbeat timer.
   *
   * The first round is not run here: a boot must not wait for a machine, and a
   * machine at `off` would be checked for nothing. The interval is re-read from the
   * config on every round, so an operator's new `heartbeatSeconds` applies at the
   * next one.
   */
  start(ctx: Context = BACKGROUND_CONTEXT): void {
    this.#stopped = false;
    this.#schedule(ctx);
    // Runs that outlived the previous process: their records are in the store and
    // the runs are still on the machine, so the checks are picked up here. It is
    // not awaited: a boot must not wait for a machine to answer, and the checks
    // schedule themselves.
    void this.#runs.resume(ctx).catch((error: unknown) => {
      this.#logger.warn("remote run checks could not be resumed", { error });
    });
    // A tightening that was still being applied is the same kind of work: the wait
    // is in the store, and the deadline is what finishes it.
    void this.#resumeTightenings(ctx).catch((error: unknown) => {
      this.#logger.warn("remote machine tightenings could not be resumed", { error });
    });
  }

  /** Stop the timer. Connections stay open: `close` is what ends them. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * End the connections and the timer. Called when the daemon stops.
   *
   * `-O exit` per user per machine, in parallel, each with its own short deadline.
   * A machine at `off` has no socket, and ssh answers a missing socket with a
   * non-zero status that is logged at debug and nothing else: there is nothing to
   * close and nothing to report.
   */
  async close(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.stop();
    // The checks stop with the daemon and resume at the next boot from the store.
    // The runs themselves are on the machine and are not touched here.
    this.#runs.stopAll();
    for (const machine of this.#deadlines.keys()) this.#clearDeadline(machine);
    const settings = this.settings();
    if (settings === undefined) return;
    await Promise.all(settings.machines.map((machine) => this.#closeConnections(machine, settings)));
    void ctx;
  }

  /**
   * The config changed.
   *
   * Two things are recomputed here and nothing else is touched: the evidence each
   * block watches, so a new pinned key or a new address unblocks a machine, and the
   * timer, so a new interval applies without a restart. Then one event, so an open
   * page redraws the list it now has.
   *
   * The panel must not refresh on `extension_reloaded`: the admin reload route
   * emits that event before it replaces the config (`src/server/routes/admin.ts`),
   * so a page listening to it would read the config that is about to go away. This
   * is the event that comes after the new config is in place.
   */
  async configChanged(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    const settings = this.settings();
    if (settings === undefined) return;
    for (const machine of settings.machines) {
      const record = await this.#record(machine.id);
      if (record.block === undefined) continue;
      const watch = await blockWatch(this.#paths.remoteKnownHostsFile, machine);
      if (watch === record.block.watch) continue;
      await this.#clearBlock(machine.id, ctx);
    }
    // A new interval is applied by restarting the timer; a machine added to the
    // config is checked by the next round it schedules.
    if (!this.#stopped) {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#schedule(ctx);
    }
  }

  /**
   * One heartbeat round over every machine that is not at `off`.
   *
   * Exported through this method rather than kept private because a test runs a
   * round on its own clock; the timer calls the same one.
   *
   * The long-outage watch runs after each machine's round, and it
   * runs for a machine at `off` too: the round skipped that machine, and skipping it
   * is what drops the record of an outage it was in.
   */
  async tick(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    const settings = this.settings();
    if (settings === undefined) return;
    for (const machine of settings.machines) {
      if (this.#busy.has(machine.id)) continue;
      const level = await this.levelOf(machine.id);
      if (level === "off") {
        await this.#watchOutageSafely(machine, ctx);
        continue;
      }
      this.#busy.add(machine.id);
      try {
        await this.#checkMachine(machine, settings, ctx);
        // The connection that was down is up again, so a check that was waiting for
        // one runs now instead of at its interval. It is not a scheduled check, so
        // it reports only a judgment the conversation was not told.
        if (this.#recovered.delete(machine.id)) {
          await this.#runs.checkMachineNow(machine.id, ctx);
        }
      } catch (error) {
        this.#logger.warn("remote machine heartbeat failed", { machine: machine.id, error });
      } finally {
        this.#busy.delete(machine.id);
      }
      // The watch reads what the round just wrote. A round that threw wrote nothing,
      // and the record it leaves is judged as it stands.
      await this.#watchOutageSafely(machine, ctx);
    }
  }

  /** Schedule the next round, if the feature is on and the timer is wanted. */
  #schedule(ctx: Context): void {
    if (this.#stopped) return;
    const seconds = this.settings()?.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void (async () => {
        try {
          await this.tick(ctx);
        } finally {
          this.#schedule(ctx);
        }
      })();
    }, Math.max(1, seconds) * 1000);
    // A pending round must not keep a shutting-down process alive.
    this.#timer.unref?.();
  }

  /**
   * The long-outage watch of one machine, and the errors it may raise.
   *
   * A store write that fails here must not end the round for the machines after
   * this one, so it is logged and dropped: the next round reads the same record.
   */
  async #watchOutageSafely(machine: RemoteMachineConfig, ctx: Context): Promise<void> {
    try {
      await this.#watchOutage(machine, ctx);
    } catch (error) {
      this.#logger.warn("remote machine outage watch failed", { machine: machine.id, error });
    }
  }

  /**
   * Read one machine's outage after its round, and do what the record says.
   *
   * The decision is `src/remote/outage.ts` and nothing else; this method only carries
   * it out. Three writes exist and only one of them can be the first: the record is
   * dropped when the outage ended, started when the machine is down and no record
   * exists, and carried out as an automatic off when the threshold passed. The notice
   * goes through `#sendNotice`, which is the one path to the root and writes the audit
   * row for every attempt.
   */
  async #watchOutage(machine: RemoteMachineConfig, ctx: Context): Promise<void> {
    const settings = this.settings();
    if (settings === undefined) return;
    const record = await this.#record(machine.id);
    // Only the users that were checked speak for the machine: a user with no state
    // was never reached, and it counts as neither answer nor failure.
    const users: { readonly state: string }[] = [];
    for (const user of machine.users) {
      const stored = record.users[user];
      if (stored !== undefined) users.push(stored);
    }
    const decision = decideOutage({
      level: levelOfRecord(record),
      blocked: record.block !== undefined,
      users,
      outage: record.outage,
      now: this.#now(),
      outageSeconds: settings.outageSeconds,
    });
    if (decision.kind === "drop") {
      await this.#endOutage(machine.id, record, ctx);
      return;
    }
    if (decision.kind === "start") {
      await this.#writeOutage(machine.id, { since: decision.since }, ctx);
      return;
    }
    if (decision.kind === "off") await this.#automaticOff(machine, record, decision.since, ctx);
  }

  /**
   * Make a machine `off` because it did not answer for longer than the threshold.
   *
   * The commit comes first, because it is the promise: the level, the runs that were
   * live and the user's inbox item land together, so a process that dies right after
   * the write has told the user and left no run that still claims to be watched.
   * Everything after the commit is memory and messages: the deadline that could dial
   * the machine is cleared, the run timers are cancelled, the sockets are closed, the
   * panel is told, the audit trail gets its rows, each starting conversation hears
   * about its own run, and the root hears it last. A message lost in that window costs
   * no state, and the item has already told the user.
   *
   * The runs come from the store, not from the machine: a run on a machine that is
   * away cannot be read, and the item and the notice must name what the core stopped
   * watching. Nothing here opens a connection to the machine; the only command it may
   * cost is the local socket close of `#closeConnections`.
   */
  async #automaticOff(
    machine: RemoteMachineConfig,
    record: RemoteMachineRecord,
    since: number,
    ctx: Context,
  ): Promise<void> {
    const settings = this.settings();
    const session = this.#session();
    if (settings === undefined || session === undefined) return;
    const now = this.#now();
    const zone = this.#getConfig().timezone;
    const previous = levelOfRecord(record);
    const errors: (string | undefined)[] = [];
    for (const user of machine.users) errors.push(record.users[user]?.error);
    const sshError = lastFailure(errors);
    const live = await this.#runs.list(machine.id);

    const written = await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, machine.id, machine.id);
      draft.level = "off";
      draft.levelChangedAt = now;
      draft.levelSequence = draft.levelSequence + 1;
      // No cleanup of a stricter level can be owed to a level that is already the
      // strictest one, and a wait left in the record would arm a stop call.
      draft.pending = null;
      delete (draft as { outage?: unknown }).outage;
      draft.updatedAt = now;
      const stranded = await this.#runs.strand(live, tx);
      const item = await createInboxItemTx(
        tx,
        {
          title: automaticOffItemTitle({ machine: machine.id }),
          body: automaticOffItemBody({
            time: zoneMinute(since, zone),
            seconds: settings.outageSeconds,
            sshError,
            runs: stranded.map((run) => run.id),
          }),
          severity: "warn",
        },
        now,
      );
      return { stranded, item };
    }, ctx);

    // Nothing may act on behalf of a level that has moved: the deadline that would
    // stop what is left, and the connections that a stop would have needed.
    this.#clearDeadline(machine.id);
    await this.#closeConnections(machine, settings);
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine.id });

    this.#audit.append({
      type: "remote_machine_level",
      machine: machine.id,
      from: previous,
      to: "off",
      // Who moved it, because no route and no agent did: the watch did, by itself.
      by: "core-outage",
      since,
      at: now,
    });
    this.#audit.append({
      type: "remote_machine_auto_off",
      machine: machine.id,
      runs: written.stranded.length,
      runIds: written.stranded.map((run) => run.id),
      since,
      at: now,
    });
    for (const run of written.stranded) {
      this.#audit.append({ type: "remote_run_stranded", run: run.id, machine: machine.id, at: now });
    }
    this.#audit.append({ type: "inbox_item", itemId: written.item.id, kind: written.item.kind });

    // Each run's own conversation, through the path a check already uses, so a
    // conversation with no record left falls back to the root.
    for (const run of written.stranded) {
      await this.#deliver({
        machine: machine.id,
        kind: "run-stranded",
        conversationId: run.conversationId,
        requestId: `remote-run-stranded:<${run.id}>:<${now}>`,
        text: strandedRunText({ run: run.id, machine: machine.id, user: run.user }),
        ctx,
      });
    }

    await this.#sendNotice(
      {
        machine: machine.id,
        kind: "auto-off",
        // The machine and the start of the outage, so a second round cannot put a
        // second message there even if the code runs twice.
        requestId: `remote-machine-auto-off:<${machine.id}>:<${since}>`,
        text: automaticOffText({
          machine: machine.id,
          time: zoneMinute(since, zone),
          seconds: settings.outageSeconds,
          level: previous,
          sshError,
          runs: written.stranded.map((run) => run.id),
        }),
        since,
      },
      ctx,
    );
  }

  /** Drop one machine's outage record, because the outage ended or is not watched. */
  async #endOutage(id: string, record: RemoteMachineRecord, ctx: Context): Promise<void> {
    // The common case by far: a machine that answers has no record, and this is the
    // one write per round that must not happen for it.
    if (record.outage === undefined) return;
    const session = this.#session();
    if (session === undefined) return;
    const now = this.#now();
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, id, id);
      delete (draft as { outage?: unknown }).outage;
      draft.updatedAt = now;
    }, ctx);
  }

  /** Write one machine's outage record, which is the whole state of the watch. */
  async #writeOutage(id: string, outage: RemoteMachineOutageRecord, ctx: Context): Promise<void> {
    const session = this.#session();
    if (session === undefined) return;
    const now = this.#now();
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, id, id);
      draft.outage = outage;
      draft.updatedAt = now;
    }, ctx);
  }

  /**
   * Check one machine: its block, its pinned key, and then each user.
   *
   * The order is the rule: a block is re-examined first, because it is the only
   * way out of one; then the pinned key, because contacting a machine with no
   * pinned key is exactly what the strict check would refuse; and only then the
   * users.
   */
  async #checkMachine(machine: RemoteMachineConfig, settings: RemoteMachinesSettings, ctx: Context): Promise<void> {
    const record = await this.#record(machine.id);
    if (record.block !== undefined) {
      const watch = await blockWatch(this.#paths.remoteKnownHostsFile, machine);
      if (watch === record.block.watch) return;
      // The evidence a block watched has changed, so the block has run its course:
      // the operator pinned a new key or changed this machine's entry. It is
      // dropped here rather than kept beside a fresh state, and the machine is
      // tried again in this same round.
      await this.#clearBlock(machine.id, ctx);
    }
    const port = machine.port ?? 22;
    if (!(await pinnedHostKey(this.#paths.remoteKnownHostsFile, machine.id, port))) {
      this.#logger.debug("remote machine has no pinned host key", { machine: machine.id });
      return;
    }
    await mkdir(this.#paths.sshSocketDir, { recursive: true, mode: 0o700 });
    for (const user of machine.users) {
      const stopped = await this.#heartbeatUser(machine, settings, user, ctx);
      if (stopped) return;
    }
  }

  /**
   * One user's heartbeat, and what it does about the answer.
   *
   * Returns true when it stopped the machine, so the caller does not check the
   * remaining users: one changed key or one wrong machine-id is a fact about the
   * machine, and the second user's answer cannot make it less true.
   */
  async #heartbeatUser(
    machine: RemoteMachineConfig,
    settings: RemoteMachinesSettings,
    user: string,
    ctx: Context,
  ): Promise<boolean> {
    const target = this.#target(machine, settings, user);
    const result = await this.#run(sshArguments(target, { kind: "exec", command: HEARTBEAT_COMMAND }), {
      timeoutMs: this.#heartbeatDeadlineMs,
    });
    const reading = readHeartbeat(result);
    const now = this.#now();

    if (reading.kind === "host-key-mismatch") {
      await this.#block(machine, {
        reason: "host-key-mismatch",
        at: now,
        detail: reading.detail,
        users: machine.users,
        notice: (time) =>
          hostKeyBlockedText({
            machine: machine.id,
            time,
            address: machine.address,
            sshError: reading.detail,
          }),
        error: reading.detail,
        ctx,
      });
      return true;
    }

    if (reading.kind === "failed") {
      await this.#recordState(machine, user, {
        state: "unreachable",
        since: now,
        error: reading.detail,
      }, ctx);
      // A machine that was reachable and is not now is one a run check will fail to
      // read. Nothing is done here about that: the retry is the check's own.
      this.#recovered.delete(machine.id);
      return false;
    }

    // A reachable machine answers with its own id. The expected value is the
    // config's when it names one, and the first value read otherwise.
    const record = await this.#record(machine.id);
    const expected = machine.machineId ?? record.machineId;
    if (expected !== undefined && expected !== reading.machineId) {
      await this.#block(machine, {
        reason: "machine-id-mismatch",
        at: now,
        detail: `read ${reading.machineId}, expected ${expected}`,
        users: machine.users,
        notice: (time) =>
          machineIdBlockedText({
            machine: machine.id,
            time,
            found: reading.machineId,
            user,
            expected,
          }),
        error: `machine-id mismatch: read ${reading.machineId}, expected ${expected}`,
        ctx,
      });
      return true;
    }

    if (record.machineId === undefined && machine.machineId === undefined) {
      // The first value is recorded without asking the operator: it was read over
      // a connection whose host key they checked, so it is a value from the machine
      // whose key they pinned.
      const session = this.#session();
      if (session !== undefined) {
        await session.commit(async (tx) => {
          const draft = await tx.doc(SecRemoteMachine, machine.id, machine.id);
          draft.machineId = reading.machineId;
          draft.updatedAt = now;
        }, ctx);
      }
      this.#logger.info("remote machine machine-id recorded", { machine: machine.id });
    }

    const wasUnreachable = (await this.#record(machine.id)).users[user]?.state === "unreachable";
    await this.#recordState(machine, user, { state: "reachable", since: now }, ctx);
    if (wasUnreachable) this.#recovered.add(machine.id);
    return false;
  }

  /** Drop one machine's block, and say so in the log and the audit trail. */
  async #clearBlock(id: string, ctx: Context): Promise<void> {
    const session = this.#session();
    if (session === undefined) return;
    const now = this.#now();
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, id, id);
      delete (draft as { block?: unknown }).block;
      draft.updatedAt = now;
    }, ctx);
    this.#audit.append({ type: "remote_machine_unblocked", machine: id, at: now });
    this.#logger.info("remote machine evidence changed, trying again", { machine: id });
    this.#events.emit(REMOTE_MACHINE_EVENT, { id });
  }

  /**
   * Stop every connection to one machine, once.
   *
   * The record gets the block, every user gets `unreachable` with the reason as its
   * error text, the audit trail gets a row, and the root gets one notice numbered by
   * the block. A machine that is already blocked with the same reason writes
   * nothing here: `#checkMachine` returns before this is reached.
   */
  async #block(
    machine: RemoteMachineConfig,
    input: {
      readonly reason: MachineBlockReason;
      readonly at: number;
      readonly detail: string;
      readonly users: readonly string[];
      readonly notice: (time: string) => string;
      readonly error: string;
      readonly ctx: Context;
    },
  ): Promise<void> {
    const session = this.#session();
    if (session === undefined) return;
    const watch = await blockWatch(this.#paths.remoteKnownHostsFile, machine);
    const users: Record<string, RemoteMachineUserRecord> = {};
    for (const user of input.users) {
      users[user] = { state: "unreachable", since: input.at, error: input.error };
    }
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, machine.id, machine.id);
      draft.users = users;
      draft.block = { reason: input.reason, at: input.at, detail: input.detail, watch };
      draft.updatedAt = input.at;
    }, input.ctx);
    this.#audit.append({
      type: "remote_machine_blocked",
      machine: machine.id,
      reason: input.reason,
      detail: input.detail,
      at: input.at,
    });
    this.#logger.warn("remote machine connections stopped", {
      machine: machine.id,
      reason: input.reason,
      detail: input.detail,
    });
    await this.#sendNotice(
      {
        machine: machine.id,
        kind: input.reason,
        requestId: `remote-machine-block:<${machine.id}>:<${input.reason}>:<${input.at}>`,
        text: input.notice(zoneMinute(input.at, this.#getConfig().timezone)),
      },
      input.ctx,
    );
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine.id });
  }

  /**
   * Write one user's state, and only when it changed.
   *
   * A machine that stays up for a day is one write, not one per round: the record
   * is rewritten when the state word changes, and `since` moves with the word
   * rather than with the check. That is what makes a heartbeat cheap on the store
   * and it is what the panel's "unreachable since 16:20" means.
   */
  async #recordState(
    machine: RemoteMachineConfig,
    user: string,
    next: RemoteMachineUserRecord,
    ctx: Context,
  ): Promise<void> {
    const session = this.#session();
    if (session === undefined) return;
    const record = await this.#record(machine.id);
    const before = record.users[user];
    if (before !== undefined && before.state === next.state && (before.error ?? "") === (next.error ?? "")) return;
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteMachine, machine.id, machine.id);
      draft.users = { ...draft.users, [user]: next };
      draft.updatedAt = next.since;
    }, ctx);
    this.#events.emit(REMOTE_MACHINE_EVENT, { id: machine.id });
  }

  /**
   * Close the kept-open connections of one machine, one per user.
   *
   * A heartbeat that is running right now may be about to open one of these
   * connections, and an `-O exit` sent before it does would leave that connection
   * open for its whole five minutes (`ControlPersist=300`). So the round is awaited
   * first. That is the defect this fixes, and the wait
   * is bounded by one heartbeat's own deadline.
   */
  async #closeConnections(machine: RemoteMachineConfig, settings: RemoteMachinesSettings): Promise<void> {
    await this.#settleRound(machine.id);
    await Promise.all(
      machine.users.map(async (user) => {
        const target = this.#target(machine, settings, user);
        try {
          await access(target.controlPath, fsConstants.F_OK);
        } catch {
          // No socket: nothing was opened, and ssh -O exit would only report that.
          return;
        }
        const result = await this.#run(sshArguments(target, { kind: "exit" }), { timeoutMs: EXIT_DEADLINE_MS });
        this.#logger.debug("remote machine connection closed", {
          machine: machine.id,
          user,
          code: result.code,
        });
      }),
    );
  }

  /**
   * Wait for a heartbeat on one machine to finish, if one is running.
   *
   * The wait is a poll rather than a promise because the round is started by the
   * timer and by `tick`, and neither hands out the promise. Ten milliseconds is well
   * under the cost of an ssh round trip, and the bound is the heartbeat's own
   * deadline plus a second, so a stuck round cannot hold a level change forever.
   */
  async #settleRound(machineId: string): Promise<void> {
    const limit = Date.now() + this.#heartbeatDeadlineMs + 1_000;
    while (this.#busy.has(machineId) && Date.now() < limit) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  /** The ssh target of one machine and user, with every path expanded. */
  #target(machine: RemoteMachineConfig, settings: RemoteMachinesSettings, user: string): SshTarget {
    return {
      machineId: machine.id,
      address: machine.address,
      port: machine.port ?? 22,
      user,
      identityFile: expandPath(settings.identityFile),
      knownHostsFile: this.#paths.remoteKnownHostsFile,
      controlPath: controlPathFor(this.#paths, machine.id, user),
    };
  }

  /** Run one ssh command line through the real program or the one a test named. */
  async #run(args: readonly string[], options: { readonly timeoutMs: number }): Promise<SshResult> {
    return await this.#runProgram(this.#sshPath ?? "ssh", args, options);
  }

  /**
   * Run one of the three programs this feature starts.
   *
   * One place decides the program, the environment and the input, so no module can
   * start a real `ssh` in a test by naming `"ssh"` itself, and the daemon runs the
   * program on `PATH` without any module having to know which.
   */
  async #runProgram(
    program: string,
    args: readonly string[],
    options: ProgramRunOptions,
  ): Promise<SshResult> {
    const runOptions = {
      timeoutMs: options.timeoutMs,
      ...(this.#sshEnv === undefined ? {} : { env: this.#sshEnv }),
    };
    if (options.input === undefined) return await runSsh(args, { ...runOptions, program });
    return await runWithInput(args, options.input, { ...runOptions, program });
  }

  /**
   * Put one message where its reader is, and record what it came to.
   *
   * A run check goes to the conversation that started the run and falls back to the
   * root, so it uses `sendRunNotice`, which makes that choice.
   * Every other message from this feature is a root notice. Either way one audit
   * row says what happened, because a message that was skipped leaves the operator
   * no other trace.
   */
  async #deliver(notice: RunNoticeInput): Promise<NoticeOutcome> {
    const harness = this.#harness?.();
    const timezone = this.#getConfig().timezone;
    const agent = this.#agent;
    const outcome = await sendRunNotice(
      {
        harness,
        timezone,
        ctx: notice.ctx,
        conversationId: notice.conversationId,
        agentStatus: async (conversationId, ctx) => {
          void ctx;
          const record = agent === undefined ? undefined : await agent(conversationId).catch(() => undefined);
          return record?.status;
        },
      },
      { requestId: notice.requestId, text: notice.text },
    );
    this.#audit.append({
      type: "remote_machine_notice",
      machine: notice.machine,
      reason: notice.kind,
      outcome: outcome.kind,
      ...(outcome.kind === "skipped" ? { skipped: outcome.reason } : {}),
      ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
    });
    if (outcome.kind !== "sent") {
      this.#logger.info("remote machine notice not delivered", { reason: notice.requestId, outcome });
    }
    return outcome;
  }

  /**
   * A run is no longer live, so the tightening that waits for the machine's runs
   * may be finished.
   *
   * Called by the run module when a run ends or is stopped. It does nothing when no
   * tightening is set, which is the usual case, and it never throws into the
   * caller: the run's own bookkeeping has already been written.
   */
  #onRunSettled(machine: string, runId: string): void {
    void runId;
    void (async () => {
      try {
        const record = await this.#record(machine);
        if (record.pending === null) return;
        const pending = record.pending;
        if (pending === null) return;
        const left = await this.#runs.runsThatDoNotFit(machine, levelWord(pending.level));
        if (left.length === 0) await this.#finishTightening(machine, record, BACKGROUND_CONTEXT);
        else await this.#updatePendingCount(machine, record, left.length);
      } catch (error) {
        this.#logger.warn("remote machine tightening update failed", { machine, error });
      }
    })();
  }

  /**
   * Send one root notice, and record what it came to.
   *
   * The audit row is written every time, whether the message went out or not. A
   * notice that was skipped because the root has no message yet leaves the
   * operator no other trace, and that case is recorded in the audit
   * trail only.
   *
   * The long-outage notice passes `since`, the moment the core first saw the machine
   * down, and the row carries it beside the `time` the log stamps on every row. Those
   * two numbers are how the promise of the threshold is measured: the difference is
   * the delay between the machine going quiet and the notice being submitted.
   */
  async #sendNotice(
    notice: {
      readonly machine: string;
      readonly kind: string;
      readonly requestId: string;
      readonly text: string;
      /** The start of the outage this notice is about, for the audit row. */
      readonly since?: number;
    },
    ctx: Context,
  ): Promise<NoticeOutcome> {
    const outcome = await sendRootNotice(
      {
        harness: this.#harness?.(),
        timezone: this.#getConfig().timezone,
        ctx,
      },
      { requestId: notice.requestId, text: notice.text },
    );
    this.#audit.append({
      type: "remote_machine_notice",
      machine: notice.machine,
      reason: notice.kind,
      outcome: outcome.kind,
      ...(notice.since === undefined ? {} : { since: notice.since }),
      ...(outcome.kind === "skipped" ? { skipped: outcome.reason } : {}),
      ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
    });
    if (outcome.kind !== "sent") {
      this.#logger.info("remote machine notice not delivered", { reason: notice.requestId, outcome });
    }
    return outcome;
  }

  /** The stored record of one machine, or its initial value. */
  async #record(id: string): Promise<RemoteMachineRecord> {
    const session = this.#session();
    if (session === undefined) return initialRecord(id);
    try {
      const record = (await session.snapshot(SecRemoteMachine, id, BACKGROUND_CONTEXT)) as
        | RemoteMachineRecord
        | undefined;
      return record ?? initialRecord(id);
    } catch {
      return initialRecord(id);
    }
  }

  /** The panel's view of one machine. */
  async #state(machine: RemoteMachineConfig): Promise<RemoteMachineState> {
    const record = await this.#record(machine.id);
    const port = machine.port ?? 22;
    const pinned = await pinnedHostKey(this.#paths.remoteKnownHostsFile, machine.id, port);
    const level = levelOfRecord(record);
    const users: MachineUserState[] = machine.users.map((user) => {
      const stored = record.users[user];
      if (level === "off") {
        // Nothing was checked at this level, whatever an earlier level found. The
        // stored state is kept for the moment the level rises again.
        return { name: user, state: "not-checked", since: null, error: null };
      }
      if (record.block !== undefined) {
        return {
          name: user,
          state: "unreachable",
          since: stored?.since ?? record.block.at,
          error: stored?.error ?? record.block.detail,
        };
      }
      if (stored === undefined) return { name: user, state: "unknown", since: null, error: null };
      return {
        name: user,
        state: isLinkState(stored.state) ? stored.state : "unknown",
        since: stored.since === 0 ? null : stored.since,
        error: stored.error ?? null,
      };
    });
    return {
      id: machine.id,
      address: machine.address,
      port,
      users,
      level,
      levelChangedAt: record.levelChangedAt === 0 ? null : record.levelChangedAt,
      pending: pendingOf(record.pending),
      hostKey: pinned ? "pinned" : "unpinned",
      blocked: blockOf(record.block),
    };
  }
}

/** The record a machine nobody has written reads as. */
function initialRecord(id: string): RemoteMachineRecord {
  return {
    id,
    level: "off",
    levelChangedAt: 0,
    levelSequence: 0,
    pending: null,
    users: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/** One stored level word, read defensively: an unknown word means `off`. */
export function levelWord(word: string): MachineLevel {
  return word === "restricted" || word === "on" ? word : "off";
}

/** The level a record carries, read defensively: an unknown word means `off`. */
function levelOfRecord(record: RemoteMachineRecord): MachineLevel {
  const level = record.level;
  return level === "restricted" || level === "on" ? level : "off";
}

/** Whether a stored word is one of the four the panel knows. */
function isLinkState(value: string): value is MachineLinkState {
  return value === "reachable" || value === "unreachable" || value === "not-checked" || value === "unknown";
}

/**
 * The wait of a record, as the wire names it.
 *
 * The stored shape and the wire shape are the same four numbers, and they are
 * copied rather than shared because the wire type is what the page compiles
 * against: a change there must not reach into the store's type by itself.
 */
function pendingOf(pending: RemoteMachinePendingRecord | null): MachinePending | null {
  if (pending === null) return null;
  return {
    level: levelWord(pending.level),
    since: pending.since,
    deadline: pending.deadline,
    runs: pending.runs,
  };
}

/** The block of a record, as the wire names it. */
function blockOf(block: RemoteMachineBlockRecord | undefined): MachineBlock | null {
  if (block === undefined) return null;
  const reason: MachineBlockReason =
    block.reason === "machine-id-mismatch" ? "machine-id-mismatch" : "host-key-mismatch";
  return { reason, at: block.at, detail: block.detail };
}
