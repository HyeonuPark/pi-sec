import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SecJob, type JobOnceSpec, type JobOnceState, type JobRecord, type JobRoutineSpec, type JobStatus } from "../documents.ts";
import type { ExtensionContext } from "../extensions/context.ts";
import { requireHarness, requireJobs } from "../extensions/context.ts";
import { parseCron } from "../extensions/scheduler.ts";

/**
 * A schedule that arrives late is still run if it is late by less than this, and
 * is dropped once it is later than this.
 *
 * One constant for two rules on purpose. `catchUp: "skip"` drops an occurrence
 * that is more than five minutes past, and a one-off run whose time is more than
 * five minutes past is closed as `missed` instead of firing. They were written
 * separately as the same literal, which is two places to change and one place to
 * forget; naming it once is what keeps the two rules one rule.
 */
export const LATE_GRACE_MS = 5 * 60_000;

export const ONCE_STATES: readonly JobOnceState[] = ["pending", "done", "cancelled", "missed"];

/**
 * The statuses a schedule fires in. Every other status means "do not fire".
 *
 * `paused` is here because pausing a routine is how the operator switches it off
 * without deleting it, and a routine that keeps firing while it is switched off
 * is the change the routine gate exists to stop. `planned`, `active` and
 * `waiting` all mean the work is still wanted. A terminal job is finished, and a
 * finished job does not start work. Unpausing needs nothing: the next due
 * occurrence is still ahead of `lastRun`, so the routine resumes at once.
 *
 * The list is a whitelist on purpose. A status added later does not fire until
 * somebody writes it here, which is the safe default: the failure it produces is
 * a routine that stays quiet and says so, not one that runs while switched off.
 */
export const FIRING_JOB_STATUSES: readonly JobStatus[] = ["planned", "active", "waiting"];

/** Whether a job in this status may fire. See `FIRING_JOB_STATUSES`. */
export function isFiringStatus(status: JobStatus): boolean {
  return FIRING_JOB_STATUSES.includes(status);
}

export const CATCH_UP_VALUES: readonly NonNullable<JobRoutineSpec["catchUp"]>[] = ["skip", "once", "all"];
export const OVERLAP_VALUES: readonly NonNullable<JobRoutineSpec["overlap"]>[] = ["skip", "queue", "allow"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

/** A zone name that `Intl` cannot resolve is a zone that formats wrong at every tick. */
export function requireTimeZone(value: string, path: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`${path} is not a time zone: ${value}`);
  }
  return value;
}

/**
 * Turn a written `once.at` into epoch milliseconds.
 *
 * Two forms are accepted: a number of milliseconds, and an ISO 8601 instant that
 * names its offset (`Z` or `+09:00`). A string without an offset is refused
 * rather than read as local time: the same text would then mean a different
 * instant on a process that moved zone.
 */
export function parseOnceAt(value: unknown, path = "once.at"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${path} must be a positive epoch time in milliseconds`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
      throw new Error(`${path} must carry an offset, for example 2030-01-15T14:00:00Z: ${value}`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`${path} is not a date: ${value}`);
    return parsed;
  }
  throw new Error(`${path} must be an ISO 8601 instant with an offset, or epoch milliseconds`);
}

/**
 * Check one `routine` value and return it normalized.
 *
 * The cron expression goes through the parser the reconciler uses at every tick
 * (`parseCron`), so a stored value that the reconciler would throw on cannot be
 * stored in the first place. The config loader calls the same parser for the
 * legacy list; one parser, so a stored expression and a loaded one agree.
 */
export function validateRoutineSpec(value: unknown, path = "routine"): JobRoutineSpec {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const cron = requireString(value["cron"], `${path}.cron`);
  try {
    parseCron(cron);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}.cron ${message}`);
  }
  const timezone =
    value["timezone"] === undefined ? undefined : requireTimeZone(requireString(value["timezone"], `${path}.timezone`), `${path}.timezone`);
  const prompt = requireString(value["prompt"], `${path}.prompt`);
  const vmodel = optionalString(value["vmodel"], `${path}.vmodel`);
  const catchUp = value["catchUp"];
  if (catchUp !== undefined && !CATCH_UP_VALUES.includes(catchUp as (typeof CATCH_UP_VALUES)[number])) {
    throw new Error(`${path}.catchUp must be one of ${CATCH_UP_VALUES.join(", ")}`);
  }
  const overlap = value["overlap"];
  if (overlap !== undefined && !OVERLAP_VALUES.includes(overlap as (typeof OVERLAP_VALUES)[number])) {
    throw new Error(`${path}.overlap must be one of ${OVERLAP_VALUES.join(", ")}`);
  }
  const enabled = value["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  return {
    cron,
    ...(timezone === undefined ? {} : { timezone }),
    ...(catchUp === undefined ? {} : { catchUp: catchUp as JobRoutineSpec["catchUp"] }),
    ...(overlap === undefined ? {} : { overlap: overlap as JobRoutineSpec["overlap"] }),
    prompt,
    ...(vmodel === undefined ? {} : { vmodel }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

/**
 * Check one `once` value and return it normalized.
 *
 * `requireFuture` is the difference between creating one and changing one. A new
 * one-off run must be in the future, because "run this at a time that has passed"
 * is a run that either fires at once in a way the caller did not mean or is
 * dropped as missed. An existing one is past its time by definition once it has
 * fired, so an update to its prompt must not be refused for that.
 */
export function validateOnceSpec(
  value: unknown,
  nowMs: number,
  options: { readonly requireFuture?: boolean; readonly path?: string } = {},
): JobOnceSpec {
  const path = options.path ?? "once";
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const at = parseOnceAt(value["at"], `${path}.at`);
  if (options.requireFuture !== false && at <= nowMs) {
    throw new Error(`${path}.at must be in the future: ${new Date(at).toISOString()}`);
  }
  const prompt = requireString(value["prompt"], `${path}.prompt`);
  const vmodel = optionalString(value["vmodel"], `${path}.vmodel`);
  const state = value["state"];
  if (state !== undefined && !ONCE_STATES.includes(state as JobOnceState)) {
    throw new Error(`${path}.state must be one of ${ONCE_STATES.join(", ")}`);
  }
  return {
    at,
    prompt,
    ...(vmodel === undefined ? {} : { vmodel }),
    ...(state === undefined ? {} : { state: state as JobOnceState }),
  };
}

/**
 * Check a write that carries both schedule fields.
 *
 * A job holds one schedule or none. Both together would need a rule that says
 * which side fires, and a rule that can disagree with itself is the state this
 * change exists to remove: a job that looks scheduled and never runs.
 */
export function validateScheduleFields(
  routine: unknown,
  once: unknown,
  nowMs: number,
  options: { readonly requireFutureOnce?: boolean; readonly routinePath?: string; readonly oncePath?: string } = {},
): { routine?: JobRoutineSpec; once?: JobOnceSpec } {
  if (routine !== undefined && routine !== null && once !== undefined && once !== null) {
    throw new Error("a job cannot carry both routine and once; use one record per schedule");
  }
  const result: { routine?: JobRoutineSpec; once?: JobOnceSpec } = {};
  if (routine !== undefined && routine !== null) result.routine = validateRoutineSpec(routine, options.routinePath);
  if (once !== undefined && once !== null) {
    result.once = validateOnceSpec(once, nowMs, {
      requireFuture: options.requireFutureOnce !== false,
      ...(options.oncePath === undefined ? {} : { path: options.oncePath }),
    });
  }
  return result;
}

/** The routine a legacy `config.scheduler.jobs` entry becomes. */
export function routineFromLegacyEntry(entry: {
  readonly name: string;
  readonly schedule: string;
  readonly timezone?: string;
  readonly catchUp?: "skip" | "once" | "all";
  readonly overlap?: "skip" | "queue" | "allow";
  readonly prompt: string;
  readonly vmodel?: string;
}): JobRoutineSpec {
  return validateRoutineSpec(
    {
      cron: entry.schedule,
      ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
      ...(entry.catchUp === undefined ? {} : { catchUp: entry.catchUp }),
      ...(entry.overlap === undefined ? {} : { overlap: entry.overlap }),
      prompt: entry.prompt,
      ...(entry.vmodel === undefined ? {} : { vmodel: entry.vmodel }),
      enabled: true,
    },
    `scheduler.jobs[${entry.name}]`,
  );
}

/**
 * Write `routine` on a record, without going through a tool.
 *
 * The boot migration and the reconciler are the two internal writers, and both
 * are exempt from the routine gate for the same reason: they are not a person
 * asking for a schedule change. The migration runs before any run exists, and
 * the reconciler only moves `once.state` and closes the job it already fired.
 * Everything a caller asks for goes through `jobs_update`, where the gate is.
 *
 * The registry is not asked to do this: it carries the fields a tool may set,
 * and adding the schedule there would make the gate a registry concern. So the
 * write is the document write itself, inside one commit. It also clears `once`
 * in the same commit, because a record that carried both would fire neither.
 */
export async function writeRoutine(context: ExtensionContext, jobId: string, routine: JobRoutineSpec): Promise<void> {
  await requireHarness(context).commit(async (tx) => {
    const draft = await tx.doc(SecJob, jobId, jobId);
    if (draft.createdAt === 0) throw new Error(`job not found: ${jobId}`);
    draft.routine = { ...routine };
    delete (draft as { once?: JobOnceSpec }).once;
    draft.updatedAt = Date.now();
  }, BACKGROUND_CONTEXT);
}

/**
 * Move `once.state` and, when the run is over, close the job in the same commit.
 *
 * One commit matters here: a closed job whose state still says `pending` would
 * look due again on the next tick, and a `done` state on a job still marked
 * active would look like work in flight to everything that reads the list.
 */
export async function settleOnce(
  context: ExtensionContext,
  jobId: string,
  state: JobOnceState,
  options: { readonly closeJob?: boolean; readonly run?: { readonly success: boolean; readonly summary?: string } } = {},
): Promise<void> {
  const jobs = requireJobs(context);
  await requireHarness(context).commit(async (tx) => {
    if (options.run !== undefined || options.closeJob !== false) {
      await jobs.updateTx(tx, jobId, {
        ...(options.closeJob === false ? {} : { status: "done" as const }),
        ...(options.run === undefined ? {} : { recordRun: options.run }),
      });
    }
    const draft = await tx.doc(SecJob, jobId, jobId);
    const current = draft.once;
    if (current === undefined) throw new Error(`job ${jobId} carries no once`);
    draft.once = { ...current, state };
    draft.updatedAt = Date.now();
  }, BACKGROUND_CONTEXT);
}
