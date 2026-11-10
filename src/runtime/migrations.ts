import type { Context } from "@earendil-works/chord/context";
import type { Session, Storage } from "@earendil-works/pi-durable";
import { SecInbox, SecMigration, SecReport, type JobRecord } from "../documents.ts";
import { JobRegistry } from "../jobs/registry.ts";
import { dayStamp } from "./ids.ts";
import { scanDocumentKeys } from "./storage.ts";

/**
 * One-shot data migrations.
 *
 * These are not the storage backend's schema migrations — those live in
 * `state/VERSION` and belong to the runtime. These transform pi-sec's own
 * documents, and each one is recorded in the `sec.migration` ledger so it runs
 * exactly once.
 *
 * Every migration must be idempotent even so. The ledger write and the change
 * it describes go in the same commit, so a crash cannot record a migration that
 * did not happen; but a store restored from a backup taken mid-way could still
 * present already-migrated data.
 */

/** Job identity before it carried a date: a bare ULID. */
const PREFIXED_JOB_ID = /^\d{8}-[0-9A-Z]{26}$/;

export const JOB_ID_DATE_PREFIX = "job-id-date-prefix";

export interface MigrationOptions {
  readonly session: Session;
  readonly storage: Storage;
  readonly context: Context;
  readonly now?: () => number;
  readonly logger?: { info?(message: string, fields?: Record<string, unknown>): void };
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Run every migration that has not been recorded yet. */
export async function runMigrations(options: MigrationOptions): Promise<MigrationResult> {
  const now = options.now ?? (() => Date.now());
  const ledger = await options.session.snapshot(SecMigration, options.context);
  const done = ledger?.applied ?? {};

  const applied: string[] = [];
  const skipped: string[] = [];

  if (done[JOB_ID_DATE_PREFIX] === undefined) {
    const moved = await applyJobIdDatePrefix({ ...options, now });
    if (moved > 0) {
      applied.push(JOB_ID_DATE_PREFIX);
      options.logger?.info?.("migration applied", { id: JOB_ID_DATE_PREFIX, jobs: moved });
    } else {
      skipped.push(JOB_ID_DATE_PREFIX);
    }
  }

  return { applied, skipped };
}

/**
 * Give every job that predates the format a `YYYYMMDD-` prefix.
 *
 * The date is *today's*, not the job's creation day: the job's own ULID already
 * carries the real creation instant, and inventing a historical date per job
 * would mean trusting a clock this process never observed. Every migrated job
 * therefore shares one day, and their relative order is preserved by the ULID
 * that stays on the end.
 *
 * Returns the number of jobs moved.
 */
async function applyJobIdDatePrefix(options: MigrationOptions & { now: () => number }): Promise<number> {
  const { session, storage, context } = options;
  const registry = new JobRegistry({ session, storage, now: options.now });

  const jobs = await registry.list(context);
  const stamp = dayStamp(options.now());
  const rename = new Map<string, string>();
  for (const job of jobs) {
    if (!PREFIXED_JOB_ID.test(job.id)) rename.set(job.id, `${stamp}-${job.id}`);
  }

  const inboxKeys = await scanDocumentKeys(storage, "sec.inbox", context);
  const reportKeys = await scanDocumentKeys(storage, "sec.report", context);
  const inbox = (await Promise.all(inboxKeys.map((key) => session.snapshot(SecInbox, key, context)))).filter(
    (item) => item !== undefined,
  );
  const reports = (await Promise.all(reportKeys.map((key) => session.snapshot(SecReport, key, context)))).filter(
    (report) => report !== undefined,
  );

  const remap = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (rename.get(id) ?? id);

  const inboxTouched = inbox.filter((item) => remap(item.source?.jobId) !== item.source?.jobId);
  const reportsTouched = reports.filter((report) => remap(report.jobId) !== report.jobId);

  await session.commit(async (tx) => {
    for (const job of jobs) {
      const nextId = rename.get(job.id);
      if (nextId === undefined) continue;
      const moved: JobRecord = { ...job, id: nextId, parentId: remap(job.parentId) };
      await registry.writeTx(tx, moved);
    }
    // Retire only after every renamed record is in place: a `parentId` still
    // pointing at an old key would resolve to nothing if the order flipped.
    for (const job of jobs) {
      if (rename.has(job.id)) await registry.removeTx(tx, job.id);
    }

    for (const item of inboxTouched) {
      const draft = await tx.doc(SecInbox, item.id, item.id);
      draft.source = { ...item.source, jobId: remap(item.source?.jobId) as string };
    }
    for (const report of reportsTouched) {
      const draft = await tx.doc(SecReport, report.id, report.id);
      draft.jobId = remap(report.jobId) as string;
    }

    const ledgerDraft = await tx.doc(SecMigration);
    ledgerDraft.applied = { ...ledgerDraft.applied, [JOB_ID_DATE_PREFIX]: options.now() };
  }, context);

  return rename.size;
}

/** True when a job id already carries the date prefix. Exposed for tests and the CLI. */
export function hasDatePrefix(id: string): boolean {
  return PREFIXED_JOB_ID.test(id);
}
