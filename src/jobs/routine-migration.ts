import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JobRecord } from "../documents.ts";
import type { ExtensionContext } from "../extensions/context.ts";
import { requireJobs } from "../extensions/context.ts";
import { routineFromLegacyEntry, validateRoutineSpec, writeRoutine } from "./routine.ts";

/** Where the record of one migration lives, under the state directory. */
export const ROUTINE_MIGRATION_FILE = "scheduler-migration.json";

/** The sentence every "the old list is still there" message ends with. */
export const LEGACY_LIST_HINT =
  "Fix `routine` on the job records instead: config.scheduler.jobs is not read as a schedule any more.";

/** One routine that ended up on a job record. */
export interface RoutineMigrationEntry {
  readonly name: string;
  readonly jobId: string;
  /** True when the migration had to create the record. */
  readonly created: boolean;
}

/** What `state/scheduler-migration.json` holds. Read by people and by the next boot. */
export interface RoutineMigrationState {
  /** When the last successful migration ran, in epoch milliseconds. */
  readonly migratedAt: number;
  /** Where the previous `config.json` was copied before `scheduler.jobs` was emptied. */
  readonly configBackup?: string;
  /** The routines the migration wrote, by the name the legacy entry carried. */
  readonly routines: readonly RoutineMigrationEntry[];
  /**
   * Legacy entries the scheduler saw and did not read, because the migration had
   * already run. Non-empty means somebody edited the old list: the value names
   * the entries, so the message can name them too.
   */
  readonly ignoredLegacy: readonly string[];
  /** Set when the migration ran and could not finish, or when the list came back. */
  readonly error?: string;
}

export interface RoutineMigrationResult {
  /** False when the migration had already run and did nothing. */
  readonly ran: boolean;
  readonly state: RoutineMigrationState;
  /** The message to report, when there is one. */
  readonly error?: string;
  /**
   * Whether the scheduler must stay off.
   *
   * A migration that could not finish is fatal: half the routines have moved and
   * firing from that set either runs the same work twice or stops one routine
   * without saying so. A legacy list that came back is not fatal: the records are
   * the schedule and keep firing, and the list is an error to report.
   */
  readonly fatal: boolean;
}

/**
 * Record and return the message for a legacy list that came back after the
 * migration.
 *
 * The scheduler calls this on its first pass. It is exported on its own because
 * a configuration reload can add the list back while the process keeps running,
 * and the reload path is the place that has to say so: waiting for the next boot
 * would report it a day late.
 */
export async function reportLegacyList(
  context: ExtensionContext,
  existing: RoutineMigrationState,
  names: readonly string[],
): Promise<{ readonly state: RoutineMigrationState; readonly error: string }> {
  const error = `scheduler.jobs is no longer the schedule source: ignored ${names.join(", ")}. ${LEGACY_LIST_HINT}`;
  context.logger.error("scheduler.jobs is not a schedule source", { ignored: names });
  context.audit.append({ type: "routine_migration_ignored", names });
  context.events.emit("notice", { code: "scheduler_legacy_jobs_ignored", names, error });
  const state: RoutineMigrationState = { ...existing, ignoredLegacy: [...names], error };
  try {
    await writeState(context, state);
  } catch (writeError) {
    context.logger.warn("could not record the ignored legacy schedule list", { error: writeError });
  }
  return { state, error };
}

/**
 * The message for a legacy list that is present right now, or undefined.
 *
 * Reads the current config, so a caller can use it after a reload. It writes the
 * state file and the audit entry through `reportLegacyList`.
 */
export async function legacyListProblem(context: ExtensionContext): Promise<string | undefined> {
  const existing = await readRoutineMigrationState(context);
  const legacy = context.getConfig().scheduler.jobs;
  if (existing === undefined || legacy.length === 0) return undefined;
  const reported = await reportLegacyList(context, existing, legacy.map((entry) => entry.name));
  return reported.error;
}

/**
 * Make the in-memory configuration agree with the file the migration just wrote.
 *
 * The file is what the next boot reads. This process, though, holds the
 * configuration it booted with, and that copy still carries the list the
 * migration emptied. Left alone it reports the names it has just moved as
 * "ignored" the first time anybody asks — a false alarm about a migration that
 * worked, shown by the panel banner and by any reload that follows.
 *
 * Re-reading the file would mean a new `Config` object, and the context has no
 * setter for one: the runtime owns the value and hands extensions a getter. So
 * the one field that changed is cleared in place. That is the whole difference
 * between the file and memory here, and it keeps the fix inside the step that
 * caused it.
 */
function clearLegacyListInMemory(context: ExtensionContext): void {
  const scheduler = context.getConfig().scheduler as { jobs: readonly unknown[] };
  if (scheduler.jobs.length > 0) scheduler.jobs = [];
}

export interface RoutineMigrationOptions {
  readonly context: ExtensionContext;
  readonly now?: () => number;
}

/** Read the migration record, or undefined when there is none (or it is unreadable). */
export async function readRoutineMigrationState(context: ExtensionContext): Promise<RoutineMigrationState | undefined> {
  const file = join(context.paths.stateDir, ROUTINE_MIGRATION_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RoutineMigrationState>;
    return {
      migratedAt: typeof parsed.migratedAt === "number" ? parsed.migratedAt : 0,
      ...(typeof parsed.configBackup === "string" ? { configBackup: parsed.configBackup } : {}),
      routines: Array.isArray(parsed.routines) ? parsed.routines : [],
      ignoredLegacy: Array.isArray(parsed.ignoredLegacy) ? parsed.ignoredLegacy : [],
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    // A record that cannot be read is treated as absent. Running the migration
    // again is safe — it matches records by label or title and writes the same
    // routine back — and that is better than a corrupt file stopping every
    // routine for ever.
    return undefined;
  }
}

async function writeState(context: ExtensionContext, state: RoutineMigrationState): Promise<string> {
  const dir = context.paths.stateDir;
  await mkdir(dir, { recursive: true });
  const file = join(dir, ROUTINE_MIGRATION_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return file;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

/** Replace the raw document's `scheduler.jobs` with an empty array, keeping every other key. */
async function emptyLegacyList(configFile: string, at: number): Promise<void> {
  const text = await readFile(configFile, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const scheduler = parsed["scheduler"];
  if (typeof scheduler === "object" && scheduler !== null && !Array.isArray(scheduler)) {
    (scheduler as Record<string, unknown>)["jobs"] = [];
  } else {
    parsed["scheduler"] = { jobs: [] };
  }
  const temp = `${configFile}.tmp-${at}`;
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, configFile);
}

/**
 * The record a legacy entry belongs to: by its schedule label first, then by its
 * title.
 *
 * The label was what the scheduler wrote when it created the record, so it is the
 * stronger link. The title is the fallback for a record an operator made by hand,
 * and for the label being removed. Two candidates that disagree is not something
 * this migration can settle, so the label wins and the file records the id.
 */
function findRecord(jobs: readonly JobRecord[], name: string): JobRecord | undefined {
  const label = `schedule:${name}`;
  return jobs.find((job) => job.labels.includes(label)) ?? jobs.find((job) => job.title === name);
}

/**
 * Move `config.scheduler.jobs` onto the job records, once.
 *
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. every entry gets a record with a `routine`, and every routine is read back
 *    and checked;
 * 2. the previous `config.json` is copied aside, and the list is emptied;
 * 3. the record of what moved is written to `state/scheduler-migration.json`.
 *
 * Filling the records first keeps the schedule alive if the process dies before
 * the list is emptied: the next boot runs the migration again and writes the same
 * values. Emptying the list before the records exist would lose the schedule in a
 * way nothing notices until the run does not happen.
 *
 * A failure at any step is returned as `error`, and the caller must not start the
 * scheduler. Half a migration that fires is worse than a boot with no routines:
 * the first does the same work twice or stops silently, the second says so.
 */
export async function migrateRoutines(options: RoutineMigrationOptions): Promise<RoutineMigrationResult> {
  const context = options.context;
  const now = options.now ?? (() => Date.now());
  const at = now();
  const jobs = requireJobs(context);
  const legacy = context.getConfig().scheduler.jobs;
  const existing = await readRoutineMigrationState(context);

  // A list that came back after the migration is not a schedule. Say so with the
  // names in it, keep the evidence in the state file, and let the caller decide
  // not to start. Reading it would restore the two-sources window this removes.
  if (existing !== undefined) {
    if (legacy.length === 0) return { ran: false, state: existing, fatal: false };
    const reported = await reportLegacyList(context, existing, legacy.map((entry) => entry.name));
    return { ran: false, state: reported.state, error: reported.error, fatal: false };
  }

  if (legacy.length === 0) {
    // Nothing to move. Still record that the migration ran, so a list added by
    // hand later is refused instead of quietly taken as a schedule.
    const state: RoutineMigrationState = { migratedAt: at, routines: [], ignoredLegacy: [] };
    try {
      await writeState(context, state);
    } catch (error) {
      context.logger.warn("could not record the routine migration", { error });
    }
    return { ran: true, state, fatal: false };
  }

  const routines: RoutineMigrationEntry[] = [];
  try {
    const live = await jobs.list(BACKGROUND_CONTEXT);
    for (const entry of legacy) {
      const routine = routineFromLegacyEntry(entry);
      const matched = findRecord(live, entry.name);
      let jobId: string;
      let created = false;
      if (matched !== undefined) {
        if (matched.once !== undefined) {
          throw new Error(
            `job ${matched.id} (${entry.name}) carries a once run and cannot also become a routine; ` +
              `move the one-off to its own record and run the migration again`,
          );
        }
        jobId = matched.id;
      } else {
        const record = await jobs.create(BACKGROUND_CONTEXT, {
          title: entry.name,
          origin: "scheduler",
          labels: [`schedule:${entry.name}`],
        });
        context.events.emit("job_created", record as unknown as Record<string, unknown>);
        jobId = record.id;
        created = true;
      }
      await writeRoutine(context, jobId, routine);
      routines.push({ name: entry.name, jobId, created });
    }

    // Read every routine back. A write that returned without storing the value is
    // the silent failure this whole section exists to make impossible.
    for (const moved of routines) {
      const record = await jobs.get(BACKGROUND_CONTEXT, moved.jobId);
      const stored = record?.routine;
      if (stored === undefined) throw new Error(`job ${moved.jobId} (${moved.name}) has no routine after the write`);
      validateRoutineSpec(stored, `routine of ${moved.name}`);
      const expected = routineFromLegacyEntry(legacy.find((entry) => entry.name === moved.name)!);
      if (stored.cron !== expected.cron || stored.prompt !== expected.prompt) {
        throw new Error(
          `job ${moved.jobId} (${moved.name}) stored a different routine than the one it was given: ` +
            `cron=${stored.cron} prompt=${JSON.stringify(stored.prompt)}`,
        );
      }
    }

    // A configuration can also arrive from the environment or from defaults,
    // and then there is no file to copy or to empty. The records are already
    // written at this point, so the migration has done its work.
    let backup: string | undefined;
    if (await fileExists(context.paths.configFile)) {
      backup = `${context.paths.configFile}.bak-${stamp(at)}-routine-migration`;
      await copyFile(context.paths.configFile, backup);
      await emptyLegacyList(context.paths.configFile, at);
    } else {
      context.logger.warn("routine migration found no config.json to empty", { configFile: context.paths.configFile });
    }

    const state: RoutineMigrationState = {
      migratedAt: at,
      ...(backup === undefined ? {} : { configBackup: backup }),
      routines,
      ignoredLegacy: [],
    };
    await writeState(context, state);
    clearLegacyListInMemory(context);
    context.logger.info("routine migration moved the legacy schedule list onto job records", {
      moved: routines.map((moved) => moved.name),
      ...(backup === undefined ? {} : { backup }),
    });
    context.audit.append({
      type: "routine_migration",
      moved: routines.map((moved) => ({ name: moved.name, jobId: moved.jobId })),
      ...(backup === undefined ? {} : { backup }),
    });
    return { ran: true, state, fatal: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.logger.error("routine migration failed; the scheduler will not start", { error: message });
    context.audit.append({ type: "routine_migration_failed", error: message });
    context.events.emit("notice", { code: "scheduler_migration_failed", error: message });
    // No state file is written: the migration has not finished, so the next boot
    // must run it again. The writes it did make are the same values, and the
    // matching step finds those records instead of creating them twice.
    return { ran: false, state: { migratedAt: at, routines, ignoredLegacy: [] }, error: message, fatal: true };
  }
}
