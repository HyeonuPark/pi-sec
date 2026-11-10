import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Session, Storage } from "@earendil-works/pi-durable";
import { TERMINAL_JOB_STATUSES, type JobRecord } from "../documents.ts";
import { JobRegistry, type JobFilter } from "./registry.ts";

/** How long a finished job stays in the live store, and when to look. */
export interface ArchivePolicy {
  /** Days after completion before a job is moved out of the live store. */
  readonly afterDays: number;
  /** The wall-clock time of the daily sweep, `HH:MM`, in `timeZone`. */
  readonly sweepAt: string;
  /** The zone `sweepAt` is read in: the harness `timezone`, not the scheduler's. */
  readonly timeZone: string;
}

/** The zone's offset at one instant, in milliseconds: wall clock minus instant. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const wall = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  // Whole minutes: every zone offset in tzdata is a whole number of minutes, and
  // the subtraction carries the sub-second part of the instant, which rounds away.
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which a zone's wall clock reads `wall`, given as epoch
 * milliseconds read as if the calendar were UTC.
 *
 * The offset is looked up twice: once near the approximate instant and once
 * again at the answer, because the offset in force on the day of a summer-time
 * shift is not the offset in force today. Two passes settle it, since no zone
 * shifts twice inside the hour a wrong guess can be off by.
 */
function instantForWall(wall: number, timeZone: string): number {
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/**
 * The next instant a `HH:MM` wall clock time comes round in a zone, after `now`.
 *
 * The answer is a single instant, so the caller arms one timer: this is not an
 * interval. It is computed again after every run rather than once, because a zone
 * with summer time has two offsets and a fixed 24-hour step would drift across a
 * shift. The answer is strictly after `now`, so a timer that is re-armed at the
 * instant it fired cannot fire again at once.
 */
export function nextSweepAt(now: number, sweepAt: string, timeZone: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(sweepAt);
  if (match === null) throw new Error(`archive.sweepAt is not HH:MM: ${sweepAt}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`archive.sweepAt is not a time of day: ${sweepAt}`);

  // Today's wall clock date in the zone, plus the time of day. `wall` is a
  // calendar value read as UTC, so day arithmetic on it is plain arithmetic.
  const wallNow = Math.floor(now / 1000) * 1000 + offsetAt(now, timeZone);
  const midnight = wallNow - (((wallNow % 86400000) + 86400000) % 86400000);
  const today = midnight + hour * 3600000 + minute * 60000;
  const candidate = instantForWall(today, timeZone);
  if (candidate > now) return candidate;
  return instantForWall(today + 86400000, timeZone);
}

export interface ArchiveSweepReport {
  readonly at: number;
  readonly cutoff: number;
  /** Job ids moved out of the live store in this sweep. */
  readonly archived: string[];
  /** Finished jobs held back because something below them is still live. */
  readonly heldBack: string[];
  /** Jobs that failed to move; the live copy is untouched. */
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

export interface ArchiveStoreOptions {
  /** The live registry. Jobs are read from here and retired here. */
  readonly live: JobRegistry;
  /** A Session over the archive database. */
  readonly session: Session;
  readonly storage: Storage;
  readonly now?: () => number;
  /**
   * Move anything that belongs to these jobs — report bodies, for instance —
   * after the job document is copied and before it is retired from the live
   * store. Called once per sweep with the whole batch.
   */
  readonly onArchive?: (jobIds: readonly string[], context: Context) => Promise<void>;
}

/**
 * The archive: finished jobs, and everything hanging off them, in their own
 * database.
 *
 * The live store is what the job list scans, so keeping finished work in it
 * makes every listing slower and the store harder to read. Moving it out is the
 * whole point; nothing is deleted, and an archived id still resolves.
 *
 * **The two stores cannot be written atomically.** They are separate SQLite
 * files, so a crash between the copy and the retire leaves a job in both. The
 * order is fixed — copy first, retire second — so the worst case is a
 * duplicate, never a loss. `sweep()` is idempotent, so the next run retires the
 * leftover without copying again.
 */
export class ArchiveStore {
  private readonly live: JobRegistry;
  private readonly archive: JobRegistry;
  private readonly now: () => number;
  private readonly onArchive: ((jobIds: readonly string[], context: Context) => Promise<void>) | undefined;

  constructor(options: ArchiveStoreOptions) {
    this.live = options.live;
    this.now = options.now ?? (() => Date.now());
    this.archive = new JobRegistry({
      session: options.session,
      storage: options.storage,
      now: this.now,
    });
    this.onArchive = options.onArchive;
  }

  /** The archive-side registry, for reads. */
  get registry(): JobRegistry {
    return this.archive;
  }

  async list(context: Context, filter?: JobFilter): Promise<JobRecord[]> {
    return this.archive.list(context, filter);
  }

  /** Look one job up in the archive only. */
  async get(context: Context, id: string): Promise<JobRecord | undefined> {
    return this.archive.get(context, id);
  }

  /** Look one job up in the live store first, then the archive. */
  async getAny(context: Context, id: string): Promise<JobRecord | undefined> {
    return (await this.live.get(context, id)) ?? (await this.archive.get(context, id));
  }

  /**
   * Move every finished job that is past the retention window into the archive.
   *
   * A job whose descendants are not all finished is held back: splitting a tree
   * across two stores would leave a live child pointing at a parent the live
   * store no longer has. A finished leaf under a live parent *is* moved — the
   * leaf is done, and the parent's own status is what keeps it live.
   *
   * A job that carries `routine` is never moved, whatever its status: the
   * schedule lives on that record, and the reconciler reads the live store. Two
   * things bring a routine job here — the operator closed it, or a change set it
   * done — and in both cases the record has to stay where the next boot can read
   * it. A one-off run (`once`) is not exempt: after it fires it is a finished job
   * like any other and leaves after the retention window, which is what keeps the
   * live list about work and not about history.
   */
  async sweep(context: Context, afterDays: number): Promise<ArchiveSweepReport> {
    const at = this.now();
    const cutoff = at - afterDays * 24 * 60 * 60 * 1000;
    const jobs = await this.live.list(context);

    const childrenOf = new Map<string, string[]>();
    for (const job of jobs) {
      if (job.parentId === undefined) continue;
      const siblings = childrenOf.get(job.parentId) ?? [];
      siblings.push(job.id);
      childrenOf.set(job.parentId, siblings);
    }

    const due = (job: JobRecord): boolean =>
      job.routine === undefined &&
      TERMINAL_JOB_STATUSES.includes(job.status) &&
      job.completedAt !== undefined &&
      job.completedAt <= cutoff;

    const isDue = new Map(jobs.map((job) => [job.id, due(job)]));
    const blockedMemo = new Map<string, boolean>();
    const blocked = (id: string): boolean => {
      const memo = blockedMemo.get(id);
      if (memo !== undefined) return memo;
      // Guard against a cycle introduced by hand-edited data.
      blockedMemo.set(id, true);
      let result = false;
      for (const child of childrenOf.get(id) ?? []) {
        if (isDue.get(child) !== true || blocked(child)) {
          result = true;
          break;
        }
      }
      blockedMemo.set(id, result);
      return result;
    };

    const movable = jobs.filter((job) => isDue.get(job.id) === true && !blocked(job.id));
    const heldBack = jobs.filter((job) => isDue.get(job.id) === true && blocked(job.id)).map((job) => job.id);
    if (movable.length === 0) return { at, cutoff, archived: [], heldBack, failed: [] };

    const archived: string[] = [];
    const failed: { id: string; error: string }[] = [];

    // Copy first, one commit, and skip anything already there. A previous run
    // that died between the copy and the retire leaves exactly this state.
    const toCopy: JobRecord[] = [];
    for (const job of movable) {
      if ((await this.archive.get(context, job.id)) === undefined) toCopy.push(job);
    }
    if (toCopy.length > 0) {
      try {
        await this.archive.writeAll(context, toCopy);
      } catch (error) {
        // Nothing has been retired, so the live store is still complete.
        return {
          at,
          cutoff,
          archived: [],
          heldBack,
          failed: toCopy.map((job) => ({ id: job.id, error: String(error) })),
        };
      }
    }

    try {
      await this.onArchive?.(movable.map((job) => job.id), context);
    } catch (error) {
      return {
        at,
        cutoff,
        archived: [],
        heldBack,
        failed: movable.map((job) => ({ id: job.id, error: String(error) })),
      };
    }

    // Copied, so a failure here is recoverable: the next sweep retires it.
    for (const job of movable) {
      try {
        await this.live.remove(context, job.id);
        archived.push(job.id);
      } catch (error) {
        failed.push({ id: job.id, error: String(error) });
      }
    }

    return { at, cutoff, archived, heldBack, failed };
  }
}

export interface ArchivistOptions {
  readonly store: ArchiveStore;
  readonly enabled: boolean;
  readonly policy: ArchivePolicy;
  /** Called with the sweep result after a run that moved or failed on something. */
  readonly onSweep?: (report: ArchiveSweepReport) => void;
  readonly logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** The clock, in epoch milliseconds. Defaults to the system's. */
  readonly now?: () => number;
  /** How a timer is armed and cancelled. Defaults to `setTimeout`/`clearTimeout`. */
  readonly timers?: ArchivistTimers;
}

/** How a timer is armed and cancelled, so a test can drive the clock itself. */
export interface ArchivistTimers {
  set(callback: () => void, delayMs: number): { cancel(): void };
}

const SYSTEM_TIMERS: ArchivistTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    // Unreferenced: a pending daily sweep must not keep the process alive.
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * Runs the archive sweep once a day, at `archive.sweepAt` in the harness zone.
 *
 * A daemon that was down at that time does not catch up: the day is skipped and
 * the next sweep is the next day's. That is the point of a wall-clock time. The
 * sweep is a daily housekeeping pass, and running it twice in one day because the
 * process restarted twice is what the schedule exists to avoid.
 */
export class Archivist {
  private readonly options: ArchivistOptions;
  private timer: { cancel(): void } | undefined;
  private running = false;
  /** Set by `stop()`, so a run that ends after the shutdown arms nothing. */
  private stopped = false;

  constructor(options: ArchivistOptions) {
    this.options = options;
  }

  /**
   * Sweep once and leave one `info` line. Re-entrant calls are dropped rather
   * than queued.
   *
   * The line is written on every run, including a run that moved nothing: the
   * question the log answers is "did the daily sweep happen", and a silent day
   * would be indistinguishable from a daemon that never armed the timer.
   */
  async run(): Promise<ArchiveSweepReport | undefined> {
    if (!this.options.enabled || this.running) return undefined;
    this.running = true;
    try {
      const report = await this.options.store.sweep(BACKGROUND_CONTEXT, this.options.policy.afterDays);
      this.options.logger?.info("archive sweep", {
        archived: report.archived.length,
        heldBack: report.heldBack.length,
        failed: report.failed.length,
      });
      if (report.archived.length > 0 || report.failed.length > 0) this.options.onSweep?.(report);
      return report;
    } catch (error) {
      this.options.logger?.warn("archive sweep failed", { error });
      return undefined;
    } finally {
      this.running = false;
    }
  }

  /**
   * The instant of the next sweep.
   *
   * Read from the clock rather than remembered, so a clock that moves (a test, a
   * machine whose time was corrected) answers honestly.
   */
  nextAt(): number {
    const now = this.options.now?.() ?? Date.now();
    return nextSweepAt(now, this.options.policy.sweepAt, this.options.policy.timeZone);
  }

  /** Arm the one timer. A no-op while a timer is already armed (`start()` twice). */
  start(): void {
    if (!this.options.enabled || this.timer !== undefined) return;
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private arm(): void {
    const timers = this.options.timers ?? SYSTEM_TIMERS;
    const now = this.options.now?.() ?? Date.now();
    let at: number;
    try {
      at = nextSweepAt(now, this.options.policy.sweepAt, this.options.policy.timeZone);
    } catch (error) {
      // A value the schema should have refused. Warn once and arm nothing: a
      // wrong time must not become a sweep at a random hour.
      this.options.logger?.warn("archive sweep time is not usable", { sweepAt: this.options.policy.sweepAt, error });
      return;
    }
    this.timer = timers.set(() => {
      this.timer = undefined;
      void this.run().finally(() => {
        // The next day's time, computed after the run: a sweep that took a while
        // still arms from where the clock is now.
        if (this.options.enabled && !this.stopped) this.arm();
      });
    }, Math.max(0, at - now));
  }
}
