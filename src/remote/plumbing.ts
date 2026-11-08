/**
 * What the run, check and file modules need from the manager that owns them.
 *
 * `RemoteMachines` owns the config, the store, the audit trail and the one list of
 * ssh options. The three modules beside it — the run protocol, the checks and the
 * file tools — need those things and nothing else, and they are tested through the
 * same seam the manager uses. So the seam is a named interface here rather than a
 * set of method calls into the class: a test can hand a module a plumbing object,
 * and a reader can see in one place the whole list of what these modules may do.
 *
 * The list is deliberately small. There is no way from here to change a level, to
 * write a machine record, or to reach a conversation other than through `deliver`.
 * Everything that decides policy stays in `RemoteMachines`.
 *
 * The three programs this feature starts are named here rather than by each caller,
 * because the daemon runs `ssh`, `sftp` and `rsync` from `PATH` and a test runs
 * three fakes instead. One place decides which program each name answers, so no
 * module can start a real one by accident.
 */

import type { Context } from "@earendil-works/chord";
import type { Session, Storage } from "@earendil-works/pi-durable";
import type { AuditEvent } from "../runtime/audit.ts";
import type { Logger } from "../runtime/logger.ts";
import type { MachineLevel } from "../shared/wire/remote-machines.ts";
import { runSsh, runWithInput, sshArguments, type SshResult, type SshTarget } from "./ssh.ts";
import type { NoticeOutcome } from "./notices.ts";

/**
 * One tool, as the step check names it.
 *
 * The names follow the tools' own names with the shared `remote_` prefix dropped,
 * because the check reads the tool and not its arguments. Two of them decide
 * whether the check passes: `sync` is refused at `restricted` because the size of
 * a copy is unknown before it starts, and `run` is allowed there with a lower
 * priority and a clock. `machines` and `level-tighten` are here because they take
 * the same path even though they touch nothing on the machine.
 */
export type RemoteToolName =
  | "run"
  | "run-status"
  | "run-stop"
  | "read"
  | "write"
  | "edit"
  | "sync"
  | "machines"
  | "level-tighten";

/** What one tool may do, after the step check. */
export type AccessResult =
  | {
      readonly ok: true;
      readonly level: MachineLevel;
      /** The machine's id, as the config names it. */
      readonly machineId: string;
      /** The ssh user the tool acts as: the named one, or the machine's main user. */
      readonly user: string;
      /** The ssh target, with every path expanded. */
      readonly target: SshTarget;
    }
  | { readonly ok: false; readonly reason: string };

/** A machine and user the step check allowed. */
export type Access = Extract<AccessResult, { ok: true }>;

/** The three settings this feature's runs read on every use. */
export interface RemoteRunSettings {
  /** Seconds between two scheduled checks of one run. */
  readonly runCheckSeconds: number;
  /** Seconds the core waits after a tightening before it stops what is left. */
  readonly tightenDeadlineSeconds: number;
  /** Seconds a command gets at `restricted`. */
  readonly restrictedSeconds: number;
}

/**
 * How a timer is armed and cancelled, so a test can drive the clock itself.
 *
 * The callback may return a promise, and a device that drives the clock itself is
 * expected to await it: one check reads the machine, which is real work, and a test
 * that moved the clock on before that work finished would be measuring its own
 * haste rather than the check.
 */
export interface RunTimers {
  set(callback: () => void | Promise<void>, delayMs: number): { cancel(): void };
}

/** The programs this feature starts. The daemon names them; a test names fakes. */
export interface RemotePrograms {
  readonly ssh: string;
  readonly sftp: string;
  readonly rsync: string;
}

/** One message this feature puts into a conversation. */
export interface RunNoticeInput {
  readonly machine: string;
  /** What the message is about, for the audit row. */
  readonly kind: string;
  /** The conversation the run started from, or null for the root. */
  readonly conversationId: string | null;
  readonly requestId: string;
  readonly text: string;
  readonly ctx: Context;
}

/** What one program may be given besides its arguments. */
export interface ProgramRunOptions {
  readonly timeoutMs: number;
  /** Text for the program's standard input. Absent closes it at once. */
  readonly input?: string;
}

/** The seam `checks.ts` and `files.ts` use to reach the machine and the store. */
export interface RemotePlumbing {
  /** The timer device. A test passes one it drives itself. */
  readonly timers: RunTimers;
  now(): number;
  /** The harness zone, which stamps every time a message prints. */
  timezone(): string;
  settings(): RemoteRunSettings;
  /** The store, once the harness exists. */
  session(): Session | undefined;
  /** The harness storage, for the one document scan this feature performs. */
  storage(): Pick<Storage, "scanDocuments"> | undefined;
  audit(event: AuditEvent): void;
  logger(): Pick<Logger, "debug" | "info" | "warn">;
  /** The programs, and the environment they run with. */
  programs(): RemotePrograms;
  environment(): Readonly<Record<string, string>> | undefined;
  /** Start any one of the three programs and read what it produced. */
  run(program: string, args: readonly string[], options: ProgramRunOptions): Promise<SshResult>;
  /**
   * The step check, and the resolved target.
   *
   * Every tool calls it, and each of these modules calls it again inside itself: a
   * tool that forgot the check still cannot act on a machine at `off`.
   *
   * `ignoreLevel` is the core's own exception and nothing else's. Two callers use
   * it: the check timer, because a run has to be read even on a machine the
   * operator has just set to `off` (that read is how the run is found, reported and
   * stopped), and the tightening flow's stop. Both still honour a stopped machine
   * and an unknown user, which are facts about the machine rather than about the
   * allowance. No tool may pass it.
   */
  access(
    machine: string,
    tool: RemoteToolName,
    user?: string,
    options?: { readonly ignoreLevel?: boolean },
  ): Promise<AccessResult>;
  /** Put one message into the conversation that started the work. */
  deliver(input: RunNoticeInput): Promise<NoticeOutcome>;
  /** A run stopped being live: the tightening flow re-reads what is left. */
  onRunSettled(machine: string, runId: string): void;
}

/**
 * Run one command on one machine, through the single list of ssh options.
 *
 * It is a function rather than a method because it decides nothing: the access the
 * step check allowed is the argument, and the only thing added here is the option
 * list `sshArguments` builds.
 */
export async function execOnMachine(
  plumbing: RemotePlumbing,
  access: Access,
  command: readonly string[],
  options: ProgramRunOptions,
): Promise<SshResult> {
  return await plumbing.run(plumbing.programs().ssh, sshArguments(access.target, { kind: "exec", command }), options);
}

/** Run one sftp batch, whose commands arrive on standard input. */
export async function sftpOnMachine(
  plumbing: RemotePlumbing,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<SshResult> {
  return await plumbing.run(plumbing.programs().sftp, args, { timeoutMs, input });
}

export { runSsh, runWithInput };
