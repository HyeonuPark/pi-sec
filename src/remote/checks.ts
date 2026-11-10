/**
 * The runs: starting one, reading one, stopping one, and the check timer that
 * keeps reading the ones that outlive the call which started them.
 *
 * ## The shape of a run's life
 *
 * `start` makes one remote directory (the once-only rule of `src/remote/runs.ts`),
 * waits a short while, and answers one of two ways. A command that finished inside
 * the window answers with its output and its exit status, and nothing else happens
 * to it: no timer, no message. A command still going answers with its run id, and
 * from then on a timer of its own reads it at every interval and reports.
 *
 * ## Why a timer per run, and not the background-call device
 *
 * `src/extensions/async-tools.ts` keeps its checks in memory and ends a call that
 * the daemon cannot safely repeat as "interrupted". A remote run is the opposite
 * case: the daemon may die and the run goes on, so a live run reported as
 * interrupted would be a lie, and finishing a run's story after a restart is the
 * point. This module therefore keeps its own timer and reads its records back from
 * the store at boot (`resume`).
 *
 * A timer also outlives the call that armed it, because the call answers while the
 * run is still going. So a timer never works in the context of that call: the
 * context of an invocation that has ended rejects every commit and every read, and
 * a check that failed for that reason says nothing about the run. Every timer here
 * works in `BACKGROUND_CONTEXT`, and a check that throws is asked again one retry
 * later instead of being left without a timer.
 *
 * ## When a message goes out
 *
 *   - A scheduled check reports whatever it found. That is the message the user is
 *     promised every interval.
 *   - Any other check reports only a judgment the conversation was not told.
 *   - A check that could not reach the machine reports nothing, and neither does
 *     its retry sixty seconds later, and the scheduled time does not move.
 *   - "Finished", "lost" and "stopped" are said once, and the checks stop.
 *
 * Every message carries a request id of its own, so two reports about one run are
 * two inputs and never collapse into one.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import { zoneMinute } from "../time-format.ts";
import type { MachineLevel } from "../shared/wire/remote-machines.ts";
import { execOnMachine, type Access, type AccessResult, type RemotePlumbing, type RemoteRunSettings } from "./plumbing.ts";
import { SecRemoteRun, type RemoteRunRecord } from "../documents.ts";
import {
  CHECK_DEADLINE_MS,
  START_DEADLINE_MS,
  STOP_DEADLINE_MS,
  checkScript,
  parseRunFacts,
  remoteScript,
  readRunState,
  restrictedWrap,
  runIdFor,
  startScript,
  stopScript,
  waitScript,
  type RunFacts,
  type RunStateWord,
} from "./runs.ts";
import {
  finishedCheckText,
  lostCheckText,
  runningCheckText,
  stoppedCheckText,
  unreachableCheckText,
} from "./run-texts.ts";

/** How long a `remote_run` waits before it answers "running". */
export const RUN_WAIT_MS = 20_000;

/** The wait after a check that could not reach the machine. */
export const RETRY_AFTER_UNREACHABLE_MS = 60_000;

/** The seconds taken off one interval, so a message lands inside it. */
export const CHECK_LEAD_SECONDS = 30;

/** ssh's sentence for a host key that is not the pinned one. */
const HOST_KEY_LINE = "Host key verification failed.";

/** What the default setting is, when the config declares `remoteMachines` but not this value. */
export const DEFAULT_RUN_CHECK_SECONDS = 1800;
export const DEFAULT_TIGHTEN_DEADLINE_SECONDS = 300;
export const DEFAULT_RESTRICTED_SECONDS = 600;

/** The settings of this feature as one object, from the keys the schema declares. */
export function runSettings(raw: {
  readonly runCheckSeconds?: number;
  readonly tightenDeadlineSeconds?: number;
  readonly restrictedSeconds?: number;
}): RemoteRunSettings {
  return {
    runCheckSeconds: clamp(raw.runCheckSeconds ?? DEFAULT_RUN_CHECK_SECONDS, 60, 1800),
    tightenDeadlineSeconds: clamp(raw.tightenDeadlineSeconds ?? DEFAULT_TIGHTEN_DEADLINE_SECONDS, 30, 3600),
    restrictedSeconds: clamp(raw.restrictedSeconds ?? DEFAULT_RESTRICTED_SECONDS, 10, 86_400),
  };
}

/** A number kept inside its declared range, the way the schema's bounds would. */
function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** What `start` came to. */
export type StartRunResult =
  | {
      /** The command finished inside the wait, so no check will follow. */
      readonly kind: "done";
      readonly runId: string;
      readonly code: number;
      readonly output: string;
      readonly bytes: number;
      readonly truncated: boolean;
    }
  | {
      /** The command is still going. The core checks it from now on. */
      readonly kind: "running";
      readonly runId: string;
      readonly machine: string;
      readonly user: string;
      readonly startedAt: number;
    }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** What `status` came to. */
export type RunStatusResult =
  | {
      readonly kind: "ok";
      readonly runId: string;
      readonly machine: string;
      readonly user: string;
      readonly state: RunStateWord;
      readonly exitCode: number | null;
      readonly bytes: number;
      /** When the output last grew, in epoch milliseconds, or null. */
      readonly grewAt: number | null;
      readonly output: string;
      readonly startedAt: number;
      /** The conversation the run reports to, or null when none was recorded. */
      readonly conversationId: string | null;
    }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** What `stop` came to. */
export type StopRunResult =
  | { readonly kind: "stopped"; readonly runId: string; readonly was: string }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** One line about a run, for a list. */
export interface RunSummary {
  readonly id: string;
  readonly machine: string;
  readonly user: string;
  /** The level the run started at: it decides whether a new level still fits it. */
  readonly level: MachineLevel;
  readonly state: string;
  readonly startedAt: number;
  readonly settled: boolean;
  readonly conversationId: string | null;
}

/** One run that the automatic off stopped watching. */
export interface StrandedRun {
  readonly id: string;
  readonly machine: string;
  readonly user: string;
  /** The conversation that started the run, or null when it named none. */
  readonly conversationId: string | null;
}

/** Why a check ran. Only a scheduled one reports regardless of what it found. */
type CheckTrigger = "timer" | "resume" | "reconnect";

/**
 * Every run this install knows about, and one timer per run that is still going.
 *
 * One object per runtime, owned by `RemoteMachines` and reached through it. The
 * store is the truth; the map of armed timers is all this object holds, so nothing
 * here can be older than the record it was built from.
 */
export class RemoteRuns {
  readonly #plumbing: RemotePlumbing;
  readonly #armed = new Map<string, { cancel(): void }>();
  /** Runs whose check is running, so two timers for one run cannot overlap. */
  readonly #checking = new Set<string>();
  #stopped = false;

  constructor(plumbing: RemotePlumbing) {
    this.#plumbing = plumbing;
  }

  // -- starting ------------------------------------------------------------

  /**
   * Start one command, or answer what the run of this call is already doing.
   *
   * The run id is a digest of the conversation and the tool call, so the same call
   * twice is the same id. Three things make a repeat safe and cheap, in this order:
   * a stored record answers without touching the machine, the remote `mkdir` fails
   * when the directory is there so no second process starts, and the record is
   * written before the process can outlive this call.
   *
   * The step check runs here, not only in the tool. At `restricted` the command is
   * wrapped in `ionice -c3 nice -n 10 timeout -k 5 <seconds>`; at `on` it runs as
   * it is. Nothing is started on a machine the check refuses.
   */
  async start(input: {
    readonly conversationId: string;
    readonly toolCallId: string;
    readonly machine: string;
    readonly user?: string;
    readonly command: string;
    readonly cwd?: string;
    readonly waitMs?: number;
    readonly ctx?: Context;
  }): Promise<StartRunResult> {
    const ctx = input.ctx ?? BACKGROUND_CONTEXT;
    const access = await this.#plumbing.access(input.machine, "run", input.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };

    const runId = runIdFor(input.conversationId, input.toolCallId);
    const existing = await this.#record(runId);
    if (existing !== undefined) return await this.#answerFor(existing);

    const now = this.#plumbing.now();
    const wrap = access.level === "restricted" ? restrictedWrap(this.#plumbing.settings().restrictedSeconds) : "";
    const started = await execOnMachine(
      this.#plumbing,
      access,
      remoteScript(
        startScript({
          runId,
          command: input.command,
          cwd: input.cwd ?? "",
          level: access.level,
          wrap,
        }),
      ),
      { timeoutMs: START_DEADLINE_MS },
    );
    if (started.timedOut) {
      return { kind: "failed", reason: "the machine did not answer while the run was starting" };
    }
    const facts = parseRunFacts(started.stdout);
    if (facts.pid === null) {
      return {
        kind: "failed",
        reason:
          started.stderr.trim() === ""
            ? "the run started but wrote no process id"
            : lastLine(started.stderr, "the run started but wrote no process id"),
      };
    }

    const record: RemoteRunRecord = {
      id: runId,
      machine: access.machineId,
      user: access.user,
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      level: access.level,
      startedAt: now,
      pid: facts.pid,
      tick: facts.tick ?? "",
      dueAt: now + this.#gapMs(),
      lastNotified: "",
      lastState: "running",
      bytes: facts.bytes,
      exitCode: -1,
      settled: false,
      settledAt: 0,
      notices: 0,
      updatedAt: now,
    };
    await this.#write(record, ctx);
    this.#plumbing.audit({
      type: "remote_run_started",
      run: runId,
      machine: record.machine,
      user: record.user,
      level: record.level,
      conversation: record.conversationId === "" ? null : record.conversationId,
    });

    // One more call asks the machine to wait out the rest of the window, so a
    // short command costs two ssh calls rather than a poll every second.
    const waitSeconds = Math.max(1, Math.ceil((input.waitMs ?? RUN_WAIT_MS) / 1000));
    const waited = await execOnMachine(
      this.#plumbing,
      access,
      remoteScript(waitScript({ runId, seconds: waitSeconds })),
      { timeoutMs: (waitSeconds + 15) * 1000 },
    );
    const after = waited.timedOut ? facts : parseRunFacts(waited.stdout);
    const state = readRunState(after);
    if (state.kind !== "running") {
      // Whatever it is, it is not going to be reported: the caller of this very
      // call is reading the answer, and a run that ends inside the
      // wait is not checked and not reported.
      const word: RunStateWord = state.kind === "missing" ? "lost" : state.kind;
      await this.#write(
        {
          ...record,
          bytes: after.bytes,
          exitCode: after.exitCode === null ? record.exitCode : after.exitCode,
          lastState: word,
          settled: true,
          settledAt: this.#plumbing.now(),
          updatedAt: this.#plumbing.now(),
        },
        ctx,
      );
      if (state.kind !== "finished") {
        return { kind: "done", runId, code: -1, output: after.output, bytes: after.bytes, truncated: false };
      }
      return {
        kind: "done",
        runId,
        code: state.code,
        output: after.output,
        bytes: after.bytes,
        truncated: after.bytes > Buffer.byteLength(after.output, "utf8"),
      };
    }

    await this.#write(
      { ...record, bytes: after.bytes, exitCode: after.exitCode === null ? -1 : after.exitCode, updatedAt: this.#plumbing.now() },
      ctx,
    );
    this.#arm({ ...record, dueAt: record.dueAt });
    return { kind: "running", runId, machine: record.machine, user: record.user, startedAt: record.startedAt };
  }

  // -- reading -------------------------------------------------------------

  /**
   * Read one run now, and say what it is doing.
   *
   * The read asks the machine, so `unreachable` says nothing about the run itself:
   * it says the machine could not be asked. The step check refuses a machine at
   * `off`, like every other tool. The core's own checks do not come through here,
   * which is why the tightening flow can still stop what is running on a machine
   * that was just set to `off`.
   */
  async status(runId: string, ctx: Context = BACKGROUND_CONTEXT): Promise<RunStatusResult> {
    void ctx;
    const record = await this.#record(runId);
    if (record === undefined) return { kind: "unknown", reason: `no run ${runId} is recorded` };
    const access = await this.#plumbing.access(record.machine, "run-status", record.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const read = await this.#read(record);
    if (read.kind === "unreachable") return { kind: "unreachable", reason: read.reason };
    const state = readRunState(read.facts);
    return {
      kind: "ok",
      runId,
      machine: record.machine,
      user: record.user,
      state: state.kind === "missing" ? "lost" : state.kind,
      exitCode: read.facts.exitCode,
      bytes: read.facts.bytes,
      grewAt: read.facts.mtime,
      output: read.facts.output,
      startedAt: record.startedAt,
      conversationId: record.conversationId === "" ? null : record.conversationId,
    };
  }

  /** Every run this install has a record of, newest first, or one machine's. */
  async list(machine?: string): Promise<readonly RunSummary[]> {
    const storage = this.#plumbing.storage();
    if (storage === undefined) return [];
    const keys: string[] = [];
    let cursor: Parameters<typeof storage.scanDocuments>[2];
    for (;;) {
      const page = await storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "sec.remoteRun" },
        200,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const item of page.items) if (item.key !== undefined) keys.push(item.key as string);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const found: RunSummary[] = [];
    for (const key of keys) {
      const record = await this.#record(key);
      if (record === undefined) continue;
      if (machine !== undefined && record.machine !== machine) continue;
      found.push({
        id: record.id,
        machine: record.machine,
        user: record.user,
        level: levelOfRecord(record.level),
        state: record.lastState,
        startedAt: record.startedAt,
        settled: record.settled,
        conversationId: record.conversationId === "" ? null : record.conversationId,
      });
    }
    return found.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The runs on one machine that the given level no longer allows.
   *
   * A move to `off` disallows every run. A move to `restricted` disallows the runs
   * started at `on`: one started at `restricted` already carries the limit and
   * stays. A settled run is nobody's to stop, and a move to `on` is not a
   * tightening at all.
   */
  async runsThatDoNotFit(machine: string, level: MachineLevel): Promise<readonly RunSummary[]> {
    if (level === "on") return [];
    const all = await this.list(machine);
    return all.filter((run) => (run.settled ? false : level === "off" ? true : run.level === "on"));
  }

  // -- the automatic off, and the wake after it ---------------------------

  /**
   * Settle every run that was live as `stranded`, inside the commit that makes the
   * machine `off`.
   *
   * The write belongs to that commit and not to a second one, because the level and
   * the runs must not disagree: a machine at `off` with a run still recorded as live
   * is a run whose check keeps dialling a machine the core has stopped watching.
   *
   * `stranded` is a fact about what the core did and not a reading of the run's
   * files, so `readRunState` never produces it and `RunStateWord` does not name it.
   * The record's own timer is cancelled here because nothing reads this run until the
   * user raises the level again: the core has no way to notice the machine coming
   * back, so a check on a timer would only dial a machine that is not there.
   *
   * The runs are handed in rather than read here, so the caller's commit callback
   * performs no read of its own.
   */
  async strand(runs: readonly RunSummary[], tx: Tx): Promise<readonly StrandedRun[]> {
    const now = this.#plumbing.now();
    const stranded: StrandedRun[] = [];
    for (const run of runs) {
      if (run.settled) continue;
      const draft = await tx.doc(SecRemoteRun, run.id, run.id);
      Object.assign(draft, { settled: true, settledAt: now, lastState: "stranded", updatedAt: now });
      this.#disarm(run.id);
      stranded.push({ id: run.id, machine: run.machine, user: run.user, conversationId: run.conversationId });
    }
    return stranded;
  }

  /**
   * Wake the stranded runs of one machine, because the user raised its level again.
   *
   * A stranded run is settled, so nothing reads it and nobody ever learns what became
   * of it. When the level rises, each stranded record goes back to live with a fresh
   * due time, and one check runs: it reads the machine and reports what it finds to
   * the conversation that started the run, which is `finished`, `lost`, `running` or
   * `stopped`. The check reports as a scheduled one does, because the record's time
   * has come, so a run that is still going says so as well.
   *
   * This is the only step that makes a stranded run readable again, and it costs one
   * call of the machine per stranded run.
   */
  async wakeStranded(machine: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    for (const summary of await this.list(machine)) {
      if (!summary.settled || summary.state !== "stranded") continue;
      const record = await this.#record(summary.id);
      if (record === undefined) continue;
      const now = this.#plumbing.now();
      await this.#write({ ...record, settled: false, settledAt: 0, dueAt: now, updatedAt: now }, ctx);
      await this.#check(summary.id, "timer", ctx);
    }
  }

  // -- stopping ------------------------------------------------------------

  /**
   * Stop one run.
   *
   * The remote script writes the stop marker before it signals, so a check that
   * arrives while the process is still dying reads a stopped run rather than a
   * lost one. `who` is what the sentence that reports it says.
   *
   * `notify` is set only for the core's own stop: an agent that called
   * `remote_run_stop` reads the answer of that call, and a
   * message to the starting conversation only when the core is what stopped it.
   */
  async stop(input: {
    readonly runId: string;
    readonly who: "agent" | "core";
    readonly notify?: boolean;
    /** The step check is skipped only by the core's own tightening flow. */
    readonly skipAccessCheck?: boolean;
    readonly ctx?: Context;
  }): Promise<StopRunResult> {
    const ctx = input.ctx ?? BACKGROUND_CONTEXT;
    const record = await this.#record(input.runId);
    if (record === undefined) return { kind: "unknown", reason: `no run ${input.runId} is recorded` };
    let access: AccessResult;
    if (input.skipAccessCheck === true) {
      // The core is applying a narrowing the operator asked for. Refusing here
      // because the level is now `off` would leave the run that no longer fits.
      access = await this.#plumbing.access(record.machine, "run-stop", record.user, { ignoreLevel: true });
    } else {
      access = await this.#plumbing.access(record.machine, "run-stop", record.user);
    }
    if (!access.ok) return { kind: "refused", reason: access.reason };
    return await this.#stopRecord(record, access, input.who, input.notify === true, ctx);
  }

  async #stopRecord(
    record: RemoteRunRecord,
    access: Access,
    who: "agent" | "core",
    notify: boolean,
    ctx: Context,
  ): Promise<StopRunResult> {
    const now = this.#plumbing.now();
    const result = await execOnMachine(
      this.#plumbing,
      access,
      remoteScript(stopScript({ runId: record.id, who, at: now })),
      { timeoutMs: STOP_DEADLINE_MS },
    );
    if (result.timedOut) {
      return { kind: "failed", reason: "the machine did not answer while the run was stopping" };
    }
    const facts = parseRunFacts(result.stdout);
    // Every real answer of the stop script starts with an `exists=` line. An answer
    // without one and with a non-zero code means the script did not run (ssh could
    // not start, or failed on its own), so the run may still be running: the stop
    // failed and the record stays as it was.
    const answered = /^exists=/m.test(result.stdout);
    if (!answered && result.code !== 0) {
      return { kind: "failed", reason: lastLine(result.stderr, "the machine did not answer") };
    }
    const state = readRunState(facts);
    const was = record.lastState;
    this.#disarm(record.id);
    const next: RemoteRunRecord = {
      ...record,
      bytes: facts.bytes,
      exitCode: facts.exitCode === null ? record.exitCode : facts.exitCode,
      lastState: state.kind === "missing" ? "lost" : state.kind,
      settled: true,
      settledAt: now,
      updatedAt: now,
    };
    await this.#write(next, ctx);
    this.#plumbing.audit({ type: "remote_run_stopped", run: record.id, machine: record.machine, by: who });
    if (notify) {
      await this.#notify(record, {
        kind: "stopped",
        text: stoppedCheckText({
          run: record.id,
          machine: record.machine,
          user: record.user,
          when: zoneMinute(now, this.#plumbing.timezone()),
          who: who === "core" ? "the core" : "the agent that started it",
        }),
      }, ctx);
      const current = await this.#record(record.id);
      if (current !== undefined) await this.#write({ ...current, settled: true, settledAt: now }, ctx);
    }
    this.#plumbing.onRunSettled(record.machine, record.id);
    return { kind: "stopped", runId: record.id, was };
  }

  // -- the clock -----------------------------------------------------------

  /**
   * Read the stored runs and pick up where the previous process stopped.
   *
   * A run whose scheduled time has passed is read at once: the daemon being down
   * is a missed interval, and the promise is a message every interval. Every other
   * run gets its timer back. Neither case repeats a start, because the run
   * directory is the run and nothing here creates one.
   */
  async resume(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.#stopped = false;
    for (const summary of await this.list()) {
      if (summary.settled) continue;
      const record = await this.#record(summary.id);
      if (record === undefined) continue;
      if (record.dueAt <= this.#plumbing.now()) {
        await this.#check(record.id, "resume", ctx);
      } else {
        this.#arm(record);
      }
    }
  }

  /** Stop every timer. Called when the daemon stops; the runs go on. */
  stopAll(): void {
    this.#stopped = true;
    for (const [, timer] of this.#armed) timer.cancel();
    this.#armed.clear();
  }

  /**
   * Check one machine's runs now.
   *
   * Called when a heartbeat that had failed comes back: the connection is up, so a
   * check that was waiting for one runs at once instead of at its interval. It is
   * not a scheduled check, so it reports only a judgment that is news.
   */
  async checkMachineNow(machine: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    for (const summary of await this.list(machine)) {
      if (summary.settled) continue;
      await this.#check(summary.id, "reconnect", ctx);
    }
  }

  /** Re-arm every timer, after the interval setting moved. */
  async rearm(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#stopped) return;
    const gap = this.#gapMs();
    for (const summary of await this.list()) {
      if (summary.settled) continue;
      const record = await this.#record(summary.id);
      if (record === undefined) continue;
      const dueAt = record.startedAt + gap;
      await this.#write({ ...record, dueAt, updatedAt: this.#plumbing.now() }, ctx);
      this.#arm({ ...record, dueAt });
    }
  }

  /** The timer delay: one interval, less the lead that keeps a message inside it. */
  #gapMs(): number {
    return Math.max(1, this.#plumbing.settings().runCheckSeconds - CHECK_LEAD_SECONDS) * 1000;
  }

  #disarm(runId: string): void {
    const timer = this.#armed.get(runId);
    if (timer === undefined) return;
    timer.cancel();
    this.#armed.delete(runId);
  }

  #arm(record: RemoteRunRecord): void {
    if (this.#stopped) return;
    this.#disarm(record.id);
    const delay = Math.max(0, record.dueAt - this.#plumbing.now());
    this.#armed.set(
      record.id,
      this.#plumbing.timers.set(async () => {
        this.#armed.delete(record.id);
        await this.#checkFromTimer(record.id, "remote run check failed");
      }, delay),
    );
  }

  /**
   * One check from a timer, and the timer it leaves behind.
   *
   * A timer outlives the call that armed it: the run is still on the machine long
   * after the tool call that started it answered. So nothing a timer does may use
   * that call's context, because the context of an invocation that has ended
   * rejects every commit and every read, and the check would then fail for a
   * reason that says nothing about the run. `BACKGROUND_CONTEXT` is the one
   * context a timer can trust.
   *
   * A check that throws is one failed look at a run that is still going, so the run
   * is asked again after the retry interval instead of being left without a timer.
   * The interval is what keeps a run that keeps throwing from spinning, and a run
   * that has settled in the meantime is not asked again at all.
   */
  async #checkFromTimer(runId: string, warning: string): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#check(runId, "timer", BACKGROUND_CONTEXT);
    } catch (error) {
      this.#plumbing.logger().warn(warning, { run: runId, error });
      await this.#retryAfterFailure(runId);
    }
  }

  /** Put one timer back on a run whose check threw, unless the run is over. */
  async #retryAfterFailure(runId: string): Promise<void> {
    if (this.#stopped) return;
    const record = await this.#record(runId);
    if (record === undefined || record.settled) return;
    this.#retryLater(record);
  }

  /**
   * One check of one run.
   *
   * The timer firing is a scheduled check when the record's time has come and a
   * retry when it has not, which is how the sixty-second retry after an
   * unreachable machine reports nothing while the scheduled check still does.
   */
  async #check(runId: string, trigger: CheckTrigger, ctx: Context): Promise<void> {
    if (this.#checking.has(runId)) return;
    this.#checking.add(runId);
    try {
      const record = await this.#record(runId);
      if (record === undefined || record.settled) {
        this.#disarm(runId);
        return;
      }
      const now = this.#plumbing.now();
      const scheduled = trigger === "resume" || (trigger === "timer" && now >= record.dueAt);
      const read = await this.#read(record);

      // A run that settled while this check was asking the machine is nobody's to
      // write any more. The automatic off settles a machine's runs in one commit, and
      // a write built from the record this check read before that commit would put a
      // settled run back into the retry loop it was taken out of.
      const latest = await this.#record(runId);
      if (latest === undefined || latest.settled) {
        this.#disarm(runId);
        return;
      }

      if (read.kind === "unreachable") {
        // Nothing about the run was read. The scheduled check says so once; the
        // retry says nothing, and the scheduled time does not move.
        if (scheduled && record.lastNotified !== "unreachable") {
          await this.#notify(record, {
            kind: "unreachable",
            text: unreachableCheckText({
              run: record.id,
              machine: record.machine,
              user: record.user,
              reason: read.reason,
            }),
          }, ctx);
        }
        await this.#write({ ...record, lastState: "unreachable", updatedAt: now }, ctx);
        this.#retryLater({ ...record, lastState: "unreachable" });
        return;
      }

      const state = readRunState(read.facts);
      const word: RunStateWord = state.kind === "missing" ? "lost" : state.kind;
      const next: RemoteRunRecord = {
        ...record,
        bytes: read.facts.bytes,
        exitCode: read.facts.exitCode === null ? record.exitCode : read.facts.exitCode,
        lastState: word,
        dueAt: scheduled ? now + this.#gapMs() : record.dueAt,
        updatedAt: now,
      };

      if (word === "running") {
        if (scheduled) {
          await this.#notify(record, {
            kind: "running",
            text: runningCheckText({
              run: record.id,
              machine: record.machine,
              user: record.user,
              when: zoneMinute(read.facts.mtime ?? now, this.#plumbing.timezone()),
              bytes: read.facts.bytes,
            }),
          }, ctx);
        }
        const current = await this.#record(runId);
        await this.#write(current === undefined ? next : { ...current, dueAt: next.dueAt }, ctx);
        this.#arm(next);
        return;
      }

      // Every other judgment ends the run's story.
      this.#disarm(runId);
      const settled: RemoteRunRecord = { ...next, settled: true, settledAt: now, updatedAt: now };
      const news = record.lastNotified !== word;
      await this.#write(settled, ctx);
      if (scheduled || news) {
        await this.#notify(settled, { kind: word, text: this.#settledText(record, word, read.facts, now) }, ctx);
      }
      this.#plumbing.audit({
        type: "remote_run_settled",
        run: record.id,
        machine: record.machine,
        state: word,
        exitCode: read.facts.exitCode,
      });
      this.#plumbing.onRunSettled(record.machine, record.id);
    } finally {
      this.#checking.delete(runId);
    }
  }

  /** The sentence for a judgment that ends a run. */
  #settledText(record: RemoteRunRecord, word: RunStateWord, facts: RunFacts, now: number): string {
    const common = { run: record.id, machine: record.machine, user: record.user };
    if (word === "finished") {
      return finishedCheckText({
        ...common,
        when: zoneMinute(facts.mtime ?? now, this.#plumbing.timezone()),
        code: facts.exitCode ?? -1,
      });
    }
    if (word === "stopped") {
      return stoppedCheckText({
        ...common,
        when: zoneMinute(facts.stop?.at ?? now, this.#plumbing.timezone()),
        who: facts.stop?.who === "core" ? "the core" : "the agent that started it",
      });
    }
    return lostCheckText(common);
  }

  /** Read one run's directory, or say why the machine could not be asked. */
  async #read(
    record: RemoteRunRecord,
  ): Promise<{ kind: "ok"; facts: RunFacts } | { kind: "unreachable"; reason: string }> {
    const access = await this.#plumbing.access(record.machine, "run-status", record.user, { ignoreLevel: true });
    if (!access.ok) return { kind: "unreachable", reason: access.reason };
    const result = await execOnMachine(this.#plumbing, access, remoteScript(checkScript(record.id)), {
      timeoutMs: CHECK_DEADLINE_MS,
    });
    if (result.timedOut) return { kind: "unreachable", reason: "the machine did not answer in time" };
    if (result.stderr.includes(HOST_KEY_LINE)) {
      return { kind: "unreachable", reason: lastLine(result.stderr, HOST_KEY_LINE) };
    }
    if (result.code !== 0) return { kind: "unreachable", reason: lastLine(result.stderr, "the machine did not answer") };
    return { kind: "ok", facts: parseRunFacts(result.stdout) };
  }

  /**
   * Arm the retry after a check that could not reach the machine, or that threw.
   *
   * The scheduled time is not moved by a check that failed, so this attempt and
   * the ones after it still read as the scheduled check and still report what
   * they find.
   */
  #retryLater(record: RemoteRunRecord): void {
    if (this.#stopped) return;
    this.#disarm(record.id);
    this.#armed.set(
      record.id,
      this.#plumbing.timers.set(async () => {
        this.#armed.delete(record.id);
        await this.#checkFromTimer(record.id, "remote run retry failed");
      }, RETRY_AFTER_UNREACHABLE_MS),
    );
  }

  /**
   * Send one message about one run.
   *
   * The request id carries the run and the count of messages already sent about
   * it, so every message is a request of its own and two reports never merge. The
   * record keeps the count and the judgment, which is how the next check knows
   * whether what it found is news.
   */
  async #notify(
    record: RemoteRunRecord,
    message: { readonly kind: string; readonly text: string },
    ctx: Context,
  ): Promise<void> {
    const notices = record.notices + 1;
    // The manager's `deliver` writes the audit row, because it is the one place that
    // knows where the message went. Writing one here as well would be two rows for
    // one message.
    await this.#plumbing.deliver({
      machine: record.machine,
      kind: `run-${message.kind}`,
      conversationId: record.conversationId === "" ? null : record.conversationId,
      requestId: `remote-run:<${record.id}>:<${notices}>`,
      text: message.text,
      ctx,
    });
    const current = await this.#record(record.id);
    if (current === undefined) return;
    await this.#write(
      { ...current, lastNotified: message.kind, notices, updatedAt: this.#plumbing.now() },
      ctx,
    );
  }

  /** What a repeat of the same tool call answers: the run it already made. */
  async #answerFor(record: RemoteRunRecord): Promise<StartRunResult> {
    if (record.lastState === "finished" && record.exitCode >= 0) {
      const read = await this.#read(record);
      const output = read.kind === "ok" ? read.facts.output : "";
      return { kind: "done", runId: record.id, code: record.exitCode, output, bytes: record.bytes, truncated: false };
    }
    return {
      kind: "running",
      runId: record.id,
      machine: record.machine,
      user: record.user,
      startedAt: record.startedAt,
    };
  }

  /** The stored record of one run, or undefined. */
  async #record(runId: string): Promise<RemoteRunRecord | undefined> {
    const session = this.#plumbing.session();
    if (session === undefined) return undefined;
    try {
      return (await session.snapshot(SecRemoteRun, runId, BACKGROUND_CONTEXT)) as RemoteRunRecord | undefined;
    } catch {
      return undefined;
    }
  }

  /** Write one run record. */
  async #write(record: RemoteRunRecord, ctx: Context): Promise<void> {
    const session = this.#plumbing.session();
    if (session === undefined) return;
    await session.commit(async (tx) => {
      const draft = await tx.doc(SecRemoteRun, record.id, record.id);
      Object.assign(draft, record);
    }, ctx);
  }
}

/** The last line of some ssh output, or the fallback. */
function lastLine(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? fallback : (lines[lines.length - 1] as string);
}

/** A stored level word, read defensively: an unknown word means `off`. */
function levelOfRecord(level: string): MachineLevel {
  return level === "restricted" || level === "on" ? level : "off";
}
