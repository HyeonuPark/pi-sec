/**
 * The job tree the sidebar draws, and the schedule fields on a job record.
 *
 * The server's own copy of these shapes is `src/documents.ts` (`JobRecord`,
 * `JobOnceSpec`, `JobRoutineSpec`) and `src/server/streams.ts` (`WorkingNode`).
 * They are written out again here because the page type check must not pull the
 * server's Node imports in with them; the field names and the closed unions are
 * the contract, and a field added on the server is added here with it.
 *
 * The page reads the tree from `GET /api/jobs?shape=tree`, and the same shape
 * rides on the jobs stream's `snapshot` frame.
 */

/** Lifecycle status of a high-level job. */
export type JobStatus = "planned" | "active" | "waiting" | "paused" | "done" | "failed" | "cancelled";

/** Where a one-off run stands. `pending` waits for `at`. */
export type JobOnceState = "pending" | "done" | "cancelled" | "missed";

/** How a recurring routine catches up with a round it missed. */
export type JobRoutineCatchUp = "skip" | "once" | "all";

/** What a recurring routine does when the previous round still runs. */
export type JobRoutineOverlap = "skip" | "queue" | "allow";

/** A recurring schedule, held on the job record itself. */
export interface JobRoutineSpec {
  /** Five-field cron expression, in `timezone`. */
  readonly cron: string;
  /** IANA zone; absent means the scheduler's own zone. */
  readonly timezone?: string;
  readonly catchUp?: JobRoutineCatchUp;
  readonly overlap?: JobRoutineOverlap;
  /** The text the run receives. */
  readonly prompt: string;
  /** A key of the `vmodels` table. */
  readonly vmodel?: string;
  /** Absent means enabled. */
  readonly enabled?: boolean;
}

/** A single run: it fires once, at `at`, and the job closes. */
export interface JobOnceSpec {
  /** When to fire, in epoch milliseconds. */
  readonly at: number;
  readonly prompt: string;
  readonly vmodel?: string;
  /** Absent means `pending`. */
  readonly state?: JobOnceState;
}

/** What the last run did and when. */
export interface JobRunSummary {
  readonly at: number;
  readonly status: "success" | "failure";
  readonly summary?: string;
}

/** One durable job record, as `sec.job` stores it. */
export interface JobRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: JobStatus;
  readonly parentId?: string;
  readonly labels: readonly string[];
  readonly routine?: JobRoutineSpec | null;
  readonly once?: JobOnceSpec | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastRun?: JobRunSummary | null;
  readonly stats: {
    readonly runs: number;
    readonly failures: number;
  };
}

/** One agent that is running on a job right now. */
export interface JobWorker {
  readonly conversationId: string;
  readonly name: string;
}

/**
 * A job with the derived "working now" list attached. The list is read per
 * request and is not part of the record: an empty list means nobody is on it.
 */
export type WorkingJob = JobRecord & { readonly working?: readonly JobWorker[] };

/** One node of the tree: a job and the jobs under it. */
export interface JobNode {
  readonly job: WorkingJob;
  readonly children?: readonly JobNode[];
}

/** The answer to `GET /api/jobs?shape=tree`. */
export interface JobTreeResponse {
  readonly tree?: readonly JobNode[];
  /**
   * The server's own text while a leftover `config.scheduler.jobs` list is
   * still populated. Absent or null draws no banner.
   */
  readonly legacyScheduleProblem?: string | null;
}

/** The payload of a `job_created` or `job_updated` frame on the conversation stream. */
export interface JobEventFrame {
  readonly id?: string;
  readonly type?: string;
}
