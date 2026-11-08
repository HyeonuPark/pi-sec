import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  defineExtension,
  section,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { SecAgent, type JobOnceSpec, type JobRecord, type JobRoutineSpec } from "../documents.ts";
import { vmodelEntry } from "../agent/vmodel.ts";
import { SCHEDULED_TOOL_REMOVALS } from "../agent/tool-profile.ts";
import { requireHarness, requireJobs, type ExtensionContext } from "./context.ts";
import { submitEnveloped } from "../submit-envelope.ts";
import { migrateRoutines, type RoutineMigrationResult } from "../jobs/routine-migration.ts";
import { isFiringStatus, LATE_GRACE_MS, settleOnce } from "../jobs/routine.ts";

export interface CronField {
  readonly any: boolean;
  readonly values: ReadonlySet<number>;
}

export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

function parseField(text: string, min: number, max: number): CronField {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (rangePart !== "*" && rangePart !== undefined) {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-");
        start = Number.parseInt(a!, 10);
        end = Number.parseInt(b!, 10);
      } else {
        start = Number.parseInt(rangePart, 10);
        end = start;
      }
    } else {
      any = step === 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
      throw new Error(`invalid cron field: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { any, values };
}

/** Parse a standard 5-field cron expression. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${expression}`);
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 6),
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The timezone-local parts of one instant. */
type ZonedParts = { minute: number; hour: number; day: number; month: number; weekday: number };

/**
 * One formatter per time zone, made once and reused.
 *
 * Building an `Intl.DateTimeFormat` costs about a hundred microseconds, which is
 * more than the formatting it then does. The scheduler asks for the parts of one
 * minute per step of a scan that can be thousands of steps long, so a new
 * formatter per call is what made one pass cost seconds: thousands of steps meant
 * thousands of formatters. A formatter is immutable and its `formatToParts` keeps no
 * state, so one per zone is enough, and the cache is a module value because the
 * zones in use are the config's and the records' — a handful, not a stream.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  // A zone name the runtime refuses throws here, on every call as before: the
  // refusal is not a value, so nothing is cached for it.
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  formatters.set(timeZone, made);
  return made;
}

/** Parse the timezone-local parts of an instant. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "0";
  const weekdayShort = get("weekday");
  const weekday = Math.max(0, WEEKDAYS.indexOf(weekdayShort as (typeof WEEKDAYS)[number]));
  return {
    minute: Number.parseInt(get("minute"), 10),
    hour: Number.parseInt(get("hour"), 10) % 24,
    day: Number.parseInt(get("day"), 10),
    month: Number.parseInt(get("month"), 10),
    weekday,
  };
}

/** Whether the date of these parts is a day the expression can match. */
function dayMatches(cron: ParsedCron, parts: ZonedParts): boolean {
  if (!cron.month.values.has(parts.month)) return false;
  const domMatch = cron.dayOfMonth.values.has(parts.day);
  const dowMatch = cron.dayOfWeek.values.has(parts.weekday);
  // Standard cron OR semantics when both DOM and DOW are restricted.
  if (cron.dayOfMonth.any && cron.dayOfWeek.any) return true;
  if (cron.dayOfMonth.any) return dowMatch;
  if (cron.dayOfWeek.any) return domMatch;
  return domMatch || dowMatch;
}

/** Whether one instant, given as its zoned parts, matches the expression. */
function partsMatch(cron: ParsedCron, parts: ZonedParts): boolean {
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  return dayMatches(cron, parts);
}

/** Whether an instant matches the cron expression in its timezone. */
export function cronMatches(expression: string | ParsedCron, date: Date, timeZone: string): boolean {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  return partsMatch(cron, zonedParts(date, timeZone));
}

/**
 * How many minutes after `parts` can be stepped over without a match.
 *
 * The step is decided from the fields that cannot match, and every minute it
 * covers carries the same value of that field, so a skip never passes over a
 * minute the expression would have matched:
 *
 * - the hour cannot match: the rest of this local hour, up to the next one;
 * - the minute cannot match, but a later minute of the hour can: up to that one;
 * - neither can match any more in this hour: up to the next local hour.
 *
 * Skipping the rest of a failing hour keeps a daily expression at a day of
 * checks instead of a day of minutes, which is what makes a remembered value
 * cheap enough to compute at boot. A daylight-saving shift moves the hour
 * boundary, and the checks after the skip are the same plain ones, so a shift
 * costs a step and never hides a match.
 */
function skipMinutes(cron: ParsedCron, parts: ZonedParts): number {
  if (!cron.hour.values.has(parts.hour)) return 60 - parts.minute;
  let nextMinute: number | undefined;
  for (const value of cron.minute.values) {
    if (value > parts.minute && (nextMinute === undefined || value < nextMinute)) nextMinute = value;
  }
  return nextMinute === undefined ? 60 - parts.minute : nextMinute - parts.minute;
}

/**
 * How far ahead a routine's next occurrence is looked for, in minutes.
 *
 * A five-field expression that matches at all does so within a year, apart from
 * `29 2` (29 February, up to eight years apart). The horizon is longer than that
 * year, so an ordinary expression is answered in full; a leap-day expression is
 * answered only as far as the horizon, and the scheduler then keeps looking the
 * way it did before.
 */
const NEXT_HORIZON_MINUTES = 60 * 24 * 400;

/**
 * The first matching minute strictly after `afterMs`, or undefined when there is
 * none within the horizon.
 *
 * This is the question the old per-tick scan answered implicitly, by walking
 * every minute from the last run to now and returning nothing when the walk found
 * no match. Asked this way it is answered once per routine, not once per tick,
 * and the walk it does takes hours and days in one step (see `skipMinutes`). The
 * window starts exactly where `previousOccurrence` starts, on the first minute
 * boundary after `afterMs`, so "nothing before this instant" and "nothing in
 * `(afterMs, now]`" are the same statement.
 */
export function nextOccurrence(
  expression: string | ParsedCron,
  timeZone: string,
  afterMs: number,
  maxMinutes = NEXT_HORIZON_MINUTES,
): number | undefined {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  let ts = Math.floor(afterMs / 60000) * 60000 + 60000;
  let walked = 0;
  while (walked < maxMinutes) {
    const parts = zonedParts(new Date(ts), timeZone);
    if (partsMatch(cron, parts)) return ts;
    const skip = skipMinutes(cron, parts);
    ts += skip * 60000;
    walked += skip;
  }
  return undefined;
}

/** Most recent matching minute at or before `now`, after `after`, or undefined. */
export function previousOccurrence(
  expression: string,
  timeZone: string,
  afterMs: number,
  nowMs: number,
  maxMinutes = 60 * 24 * 40,
): number | undefined {
  const cron = parseCron(expression);
  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  const end = Math.floor(nowMs / 60000) * 60000;
  let found: number | undefined;
  let steps = 0;
  for (let ts = start; ts <= end && steps < maxMinutes; ts += 60000, steps += 1) {
    if (cronMatches(cron, new Date(ts), timeZone)) found = ts;
  }
  if (found === undefined && steps >= maxMinutes) {
    // Fall back to scanning backward from `end`.
    for (let ts = end; ts > afterMs && steps < maxMinutes * 2; ts -= 60000, steps += 1) {
      if (cronMatches(cron, new Date(ts), timeZone)) return ts;
    }
  }
  return found;
}

export interface SchedulerOptions {
  readonly context: ExtensionContext;
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void };
}

/** How many task records one overlap check reads. */
const ROUND_TASK_SCAN = 50;

/** A job that carries a routine or a one-off run, narrowed by the caller. */
type RoutineJob = JobRecord & { routine: JobRoutineSpec };
type OnceJob = JobRecord & { once: JobOnceSpec };

/**
 * What one routine's next occurrence is, and what it was computed from.
 *
 * `key` holds every input the answer depends on — the expression, the zone and
 * the instant the window starts — so a record that was edited, or a run that was
 * recorded, is a different key and the value is computed again instead of used.
 * `scannedTo` is where the search stopped: no match exists between the window
 * start and this instant, which is the same answer as `due: undefined` for every
 * tick that comes before it.
 */
interface RoutineNext {
  readonly key: string;
  readonly due: number | undefined;
  readonly scannedTo: number;
}

/**
 * In-process reconciler: each due occurrence becomes durable work.
 *
 * The schedule lives on the job record (`routine` or `once`), so one pass is one
 * `jobs.list` scan with a field test. There is nothing to build a schedule from
 * and no second source to keep in step: changing the record is changing the
 * schedule, and the next tick reads it.
 *
 * The first pass does the boot migration first (`migrateRoutines`), and the timer
 * starts only after it succeeds. A migration that fails leaves the scheduler off
 * and says so, rather than half-firing from a partly moved set of routines.
 */
export class Scheduler {
  private readonly context: ExtensionContext;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private bootstrapping: Promise<RoutineMigrationResult> | undefined;
  /** The reconciliation pass the interval started, while it runs. */
  private inFlight: Promise<void> | undefined;
  private readonly running = new Set<string>();
  private readonly lastRuns = new Map<string, number>();
  /**
   * The next occurrence of each routine, by job id.
   *
   * A tick used to ask every routine "is an occurrence between your last run and
   * now?" by walking that window one minute at a time. Routines with runs
   * hours and days behind them made one pass thousands of steps long and blocked the
   * daemon for seconds at every tick, and the cost grew with
   * every minute that passed. The answer only changes when the expression, the
   * zone or the window start changes, so it is remembered and a tick that finds
   * `now` before it stops there. Nothing is persisted: after a restart the first
   * pass computes it again, at the cost of the one scan the old code did anyway.
   */
  private readonly nextDue = new Map<string, RoutineNext>();
  /** The window start remembered for a routine that has no recorded run yet. */
  private readonly firstWindows = new Map<string, number>();
  /** Jobs already reported as waiting for their previous round. */
  private readonly waiting = new Set<string>();
  /** Problems already logged once, so a bad record does not write a line a minute. */
  private readonly reported = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.context = options.context;
  }

  start(): void {
    const config = this.context.getConfig();
    if (!config.scheduler.enabled || this.timer !== undefined) return;
    this.stopped = false;
    void this.bootstrap().then((migration) => {
      if (migration.fatal || this.stopped || this.timer !== undefined) return;
      this.timer = setInterval(() => {
        this.inFlight = this.tick()
          .catch((error) => this.context.logger.error("scheduler tick failed", { error }))
          .finally(() => {
            this.inFlight = undefined;
          });
      }, Math.max(1000, config.scheduler.tickMs));
      this.timer.unref?.();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Stop the timer and wait for the work a start already began.
   *
   * `start()` returns before the boot migration has written
   * `state/scheduler-migration.json`, and an interval pass writes the same file
   * when it finds a legacy list. A runtime that closes while one of those writes
   * is in flight leaves it running behind the close, and a caller that removes
   * the home tree next is racing that write: the file can land between the walk
   * and the directory removal, which fails the removal with `ENOTEMPTY`. So the
   * caller that is about to remove the tree waits here first.
   */
  async drain(): Promise<void> {
    this.stop();
    await this.bootstrapping?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * Finish the boot migration and hand back its result.
   *
   * `start()` is synchronous because the runtime calls it that way, so this is
   * how a caller waits for the migration: tests, and anything that wants to know
   * whether the scheduler came up.
   */
  ready(): Promise<RoutineMigrationResult> {
    return this.bootstrap();
  }

  private bootstrap(): Promise<RoutineMigrationResult> {
    this.bootstrapping ??= migrateRoutines({ context: this.context }).catch(
      (error): RoutineMigrationResult => {
        const message = error instanceof Error ? error.message : String(error);
        this.context.logger.error("routine migration failed; the scheduler will not start", { error: message });
        return {
          ran: false,
          state: { migratedAt: Date.now(), routines: [], ignoredLegacy: [] },
          error: message,
          fatal: true,
        };
      },
    );
    return this.bootstrapping;
  }

  /** Run one reconciliation pass. Exposed for tests. */
  async tick(nowMs = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const config = this.context.getConfig();
      if (!config.scheduler.enabled) return;
      const migration = await (this.bootstrapping ?? this.bootstrap());
      // A migration that could not finish leaves the scheduler off. A legacy list
      // that came back is an error to report, not a reason to stop: the records
      // are the schedule, and they keep firing from the value on the record.
      if (migration.fatal) return;
      const defaultZone = config.scheduler.timezone;
      const jobs = await requireJobs(this.context).list(BACKGROUND_CONTEXT);
      for (const job of jobs) {
        if (job.routine === undefined && job.once === undefined) continue;
        try {
          if (job.routine !== undefined && job.once !== undefined) {
            this.warnOnce(
              `both:${job.id}`,
              "scheduler job carries both routine and once; it does not fire",
              { id: job.id, title: job.title },
            );
            continue;
          }
          if (job.routine !== undefined) {
            await this.reconcileRoutine(job as RoutineJob, defaultZone, nowMs);
          } else {
            await this.reconcileOnce(job as OnceJob, nowMs);
          }
        } catch (error) {
          this.context.logger.warn("scheduler job failed", { id: job.id, title: job.title, error });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.context.logger.warn(message, fields);
  }

  private async reconcileRoutine(job: RoutineJob, defaultZone: string, nowMs: number): Promise<void> {
    const routine = job.routine;
    // Two ways a routine is switched off, and both keep the record: `enabled:
    // false` on the routine, and a job status that is not a working one. Pausing
    // a job is the operator's way of stopping it without deleting it, so a paused
    // routine does not fire. Closing a routine job needs the routine gate, so the
    // status this path sees was allowed by a person.
    if (routine.enabled === false) return;
    if (!isFiringStatus(job.status)) return;
    if (this.running.has(job.id) && (routine.overlap ?? "skip") === "skip") return;

    const timeZone = routine.timezone ?? defaultZone;
    const lastRun = job.lastRun?.at ?? this.lastRuns.get(job.id) ?? this.firstWindow(job.id, nowMs);
    let step: RoutineNext;
    try {
      // The remembered value is used only when it was computed from what the
      // record says now. Anything that could change the answer — an edited cron,
      // an edited zone, a run recorded since — makes a different key.
      const windowKey = `${routine.cron}\u0000${timeZone}\u0000${lastRun}`;
      const remembered = this.nextDue.get(job.id);
      if (remembered !== undefined && remembered.key === windowKey) {
        step = remembered;
      } else {
        this.nextDue.delete(job.id);
        step = {
          key: windowKey,
          due: nextOccurrence(routine.cron, timeZone, lastRun),
          scannedTo: lastRun + NEXT_HORIZON_MINUTES * 60_000,
        };
        this.nextDue.set(job.id, step);
      }
    } catch (error) {
      // A record edited by hand can hold an expression the parser refuses. One
      // line, once, and the rest of the pass keeps going — a throw here would
      // repeat the same warning every tick. No value is remembered for a record
      // whose expression cannot be parsed.
      this.nextDue.delete(job.id);
      this.warnOnce(`cron:${job.id}`, "scheduler job has an unusable cron expression; it does not fire", {
        id: job.id,
        title: job.title,
        cron: routine.cron,
        error: String(error),
      });
      return;
    }

    // Nothing to do until the remembered instant. This is the return that keeps a
    // thirty-second tick off the minute-by-minute walk: the walk is done once,
    // when the routine's window changes, and a tick that comes earlier stops here.
    // `due: undefined` is not "never": it is "nothing until `scannedTo`", and it
    // carries the same answer for every tick inside that horizon.
    if (nowMs < (step.due ?? step.scannedTo)) return;
    // Past the horizon with no match found: this record is answered the old way
    // from here, and the remembered value goes, so the next pass looks again.
    if (step.due === undefined) this.nextDue.delete(job.id);

    let due: number | undefined;
    try {
      due = previousOccurrence(routine.cron, timeZone, lastRun, nowMs);
    } catch (error) {
      // A record edited by hand can hold an expression the parser refuses. One
      // line, once, and the rest of the pass keeps going — a throw here would
      // repeat the same warning every tick.
      this.warnOnce(`cron:${job.id}`, "scheduler job has an unusable cron expression; it does not fire", {
        id: job.id,
        title: job.title,
        cron: routine.cron,
        error: String(error),
      });
      return;
    }
    if (due === undefined) return;

    // The previous occurrence is the ceiling on this one. While its conversation
    // still has a task that has not settled, another round would run beside it,
    // which is the overlap this rule exists to stop. Waiting is not skipping:
    // `lastRun` stays where it was, so the occurrence is still pending and starts
    // as soon as the round ends instead of being dropped.
    if (await this.roundIsOpen(job)) {
      if (!this.waiting.has(job.id)) {
        this.waiting.add(job.id);
        this.context.logger.warn("scheduler occurrence waits for the previous round", {
          id: job.id,
          title: job.title,
          conversationId: job.conversationId,
        });
      }
      return;
    }
    this.waiting.delete(job.id);

    const catchUp = routine.catchUp ?? "skip";
    if (catchUp === "skip" && nowMs - due > LATE_GRACE_MS) {
      this.lastRuns.set(job.id, nowMs);
      await this.recordRun(job, false, "missed occurrence skipped");
      return;
    }

    this.running.add(job.id);
    this.lastRuns.set(job.id, due);
    try {
      await this.dispatch(job, { prompt: routine.prompt, vmodel: routine.vmodel }, due);
      await this.recordRun(job, true, undefined);
    } catch (error) {
      await this.recordRun(job, false, String(error));
      throw error;
    } finally {
      this.running.delete(job.id);
    }
  }

  /**
   * One pass over a one-off run.
   *
   * The states are the record: `pending` waits, and the reconcile closes it as
   * `done` once it fired, `cancelled` when the job was called off, or `missed`
   * when its time is more than the grace window past. A `pending` run whose time
   * passed is never left as it is — it would look due on every tick for ever.
   */
  private async reconcileOnce(job: OnceJob, nowMs: number): Promise<void> {
    const once = job.once;
    const state = once.state ?? "pending";
    if (state !== "pending") return;
    if (typeof once.at !== "number" || !Number.isFinite(once.at)) {
      this.warnOnce(`at:${job.id}`, "scheduler one-off has no usable run time; it does not fire", {
        id: job.id,
        title: job.title,
        at: once.at,
      });
      return;
    }
    if (job.status === "cancelled") {
      await settleOnce(this.context, job.id, "cancelled", { closeJob: false });
      return;
    }
    // Paused, done and failed do not fire, and they do not turn into `missed`
    // either: a run the operator switched off has not been missed.
    if (!isFiringStatus(job.status)) return;
    if (nowMs < once.at) return;
    if (nowMs - once.at > LATE_GRACE_MS) {
      await settleOnce(this.context, job.id, "missed", {
        run: { success: false, summary: `missed: the run time passed by more than ${LATE_GRACE_MS / 60_000} minutes` },
      });
      this.context.events.emit("notice", { code: "scheduler_once_missed", id: job.id, at: once.at });
      return;
    }
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    try {
      await this.dispatch(job, { prompt: once.prompt, vmodel: once.vmodel }, once.at);
      await settleOnce(this.context, job.id, "done", { run: { success: true, summary: "once fired" } });
    } catch (error) {
      // Still pending, so the occurrence is retried while it is inside the grace
      // window and closed as missed after it. The failure is on the record.
      await this.recordRun(job, false, String(error));
      throw error;
    } finally {
      this.running.delete(job.id);
    }
  }

  /**
   * Where a routine's window starts while its record holds no run of its own.
   *
   * This was `nowMs - 60_000`, a value that moves with the tick. That is free
   * while the window is walked every time — one minute is two steps — but a
   * remembered answer keyed on a value that changes every tick would be thrown
   * away every tick, and the window would never be wider than the minute before
   * the tick. So the first value this process computed is kept for the job: the
   * walk starts where the first tick started, and a routine that has never run is
   * answered like one that has. Nothing changes for a working scheduler, which
   * ticks every thirty seconds: the minute an occurrence falls in is reached by a
   * tick inside that same minute either way.
   */
  private firstWindow(jobId: string, nowMs: number): number {
    let known = this.firstWindows.get(jobId);
    if (known === undefined) {
      known = nowMs - 60_000;
      this.firstWindows.set(jobId, known);
    }
    return known;
  }

  /**
   * Whether the round this job last started is still open.
   *
   * The test is durable, and that is the point: the in-process `running` set is
   * emptied as soon as the prompt is placed, which is the moment the round has
   * only just begun. The job points at its newest round's conversation, and that
   * round is open while any of the conversation's tasks has not settled.
   */
  private async roundIsOpen(job: JobRecord): Promise<boolean> {
    const previous = job.conversationId;
    if (previous === undefined) return false;
    const page = await this.context.storage.scanTasks(
      { conversationId: Number(previous) as ConversationId, order: "descending" },
      ROUND_TASK_SCAN,
      undefined,
      BACKGROUND_CONTEXT,
    );
    return page.items.some((task) => task.state.status !== "terminal");
  }

  private async recordRun(job: JobRecord, success: boolean, summary: string | undefined): Promise<void> {
    const jobs = requireJobs(this.context);
    const updated = await jobs.update(BACKGROUND_CONTEXT, job.id, { recordRun: { success, summary } });
    this.context.events.emit("job_updated", updated as unknown as Record<string, unknown>);
  }

  /**
   * Start one occurrence.
   *
   * The run is recorded as an agent of kind `scheduled`. It has no parent and is
   * never counted against the subagent limit, but recording it is what lets the
   * prompt section and the message tool answer "what is this conversation?" and
   * "what may it send". Its tool profile is the scout profile: it investigates
   * and reports, and the root decides whether real work follows.
   */
  private async dispatch(
    record: JobRecord,
    spec: { readonly prompt: string; readonly vmodel: string | undefined },
    occurrence: number,
  ): Promise<void> {
    const harness = requireHarness(this.context);
    const jobs = requireJobs(this.context);
    const config = this.context.getConfig();
    // No stand-in model. A run that names none does not borrow the root agent's,
    // because the operator declared this run and did not say what it runs on. The
    // failure is recorded on the job through the throw, which is the same path an
    // unusable key takes, and no conversation is created.
    const key = spec.vmodel;
    if (key === undefined || key.trim() === "") {
      throw new Error(
        `no vmodel: this run names no model, so nothing was started. Give \`vmodel\` a key of config.vmodels. Known vmodel keys: ${Object.keys(config.vmodels).join(", ") || "(none)"}`,
      );
    }
    const vmodel = vmodelEntry(config, key);
    const now = Date.now();
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: vmodel.provider, modelId: vmodel.modelId },
          thinkingLevel: vmodel.thinkingLevel,
        },
        init: async (tx, conversationId) => {
          const agent = await tx.doc(SecAgent, String(conversationId), String(conversationId));
          agent.kind = "scheduled";
          agent.name = record.title;
          agent.vmodel = key;
          agent.roles = [];
          agent.status = "running";
          agent.createdAt = now;
          agent.updatedAt = now;
          const profile = await tx.doc(AgentDoc, conversationId);
          profile.tools = { remove: [...SCHEDULED_TOOL_REMOVALS] };
        },
      },
      BACKGROUND_CONTEXT,
    );
    // The record the operator declared runs now, without them being in the room,
    // so the source says so and names the job. `occurrence` identifies the instant
    // this run is for: the due minute the reconciler matched, or the `at` a
    // one-off run was given. Read off `record.lastRun` it named the run before: a
    // fresh job's first run said `0`, and every later run carried the previous
    // run's start time instead of its own due minute.
    await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
      type: "input",
      src: "operator-scheduled",
      attrs: { job: record.title, occurrence: String(occurrence) },
      content: spec.prompt,
      // Keyed by the record id, not by the title: two routines may share a title,
      // and one occurrence must be sent once.
      requestId: `schedule:${record.id}:${occurrence}`,
    }, config.timezone);
    // The job points at its newest round. That pointer is the only durable link
    // between a schedule and the conversation it produced, and the next tick
    // reads it to decide whether the round is still open.
    await jobs.update(BACKGROUND_CONTEXT, record.id, { conversationId: String(conversation.id) });
    this.context.events.emit("notice", {
      code: "scheduler_dispatch",
      name: record.title,
      jobId: record.id,
      conversationId: conversation.id,
    });
  }
}

/** The bundled `scheduler` extension: a stable section describing scheduled jobs. */
export function createSchedulerExtension(_context: ExtensionContext): Extension<ToolRegistration> {
  const guide = section(
    "scheduler",
    () =>
      "A schedule is a field on the job record: `routine` for a recurring run, `once` for a single run at a time. " +
      "Each firing is durable work, not a live chat turn. `config.scheduler.jobs` is not a schedule source. " +
      "Only a planned, active or waiting job fires: a paused job and a finished one do not, and unpausing resumes at the next due time.",
  );
  return defineExtension({ name: "scheduler", sections: [guide] });
}
