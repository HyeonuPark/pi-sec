import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import {
  DOC_KINDS,
  SecReportDraft,
  TERMINAL_JOB_STATUSES,
  type JobStatus,
  type ReportDraftRecord,
  type ReportDraftStatus,
  type ReportKind,
} from "../documents.ts";
import { ulid } from "../runtime/ids.ts";
import type { Paths } from "../runtime/paths.ts";
import type { AuditLog } from "../runtime/audit.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";

/**
 * Draft reports: a file plus an index row, and nothing else.
 *
 * A subagent may not publish a report — that is the root's decision — so what it
 * can produce is a draft. A draft is deliberately not a `sec.report`: it carries
 * no revisions, produces no operator notice, and is deleted the moment it stops
 * being needed. Keeping a draft alive after it was published or refused would
 * leave a second copy of a document that already exists somewhere else.
 *
 * A draft belongs to a job. That ownership, not the author, is what its lifetime
 * hangs on: deleting the subagent that wrote it leaves the draft where it is, and
 * the draft is dropped when the job itself ends. Only a row written before the
 * job field existed still follows its author.
 */
/**
 * A draft row as this store writes it: the stored record plus the sha256 of the
 * body it wrote.
 *
 * The digest is what makes the published text the reviewed text. A reader reads
 * the file, the publisher reads it again, and the two are the same document only
 * if the file did not move in between, which the digest is there to tell.
 * `sha256` is absent on a row written before the field existed, and such a row
 * publishes as it always did.
 */
export type DraftRecord = ReportDraftRecord & { readonly sha256?: string };

/** The sha256 of a draft body: hex, over the utf8 text, the same as a revision's. */
export function draftDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The audit reason a drop records when the job the draft belonged to ended.
 *
 * One string, because every path that ends a job drops through the same
 * function, and a reader of the audit log compares the reasons.
 */
export const JOB_FINISHED_REASON = "job-finished";

export interface DraftStoreOptions {
  readonly harness: () => Harness;
  readonly paths: Paths;
  readonly storage: Storage;
  /**
   * Where a disposal is recorded. Optional so a store can be built without one,
   * but the runtime always passes it: a retired row is an event nobody can read
   * back from the store itself.
   */
  readonly audit?: AuditLog;
}

export interface CreateDraftInput {
  readonly agentConversationId: string;
  /** The job the draft belongs to. Required: a draft without a job has no owner. */
  readonly jobId: string;
  readonly title: string;
  readonly content: string;
  /** What this draft is, in a few words. Optional: a draft may carry none. */
  readonly note?: string;
  /** `result` for a report about work that already ran. Absent means a plan. */
  readonly kind?: ReportKind;
}

/**
 * The one thing the store needs from the live job registry: a job by id.
 *
 * A structural type rather than `JobRegistry`, so the store does not reach into
 * the job layer for a single lookup, and so a store can be built without one.
 */
export interface LiveJobLookup {
  get(context: Context, id: string): Promise<{ readonly id: string; readonly status?: JobStatus } | undefined>;
}

/**
 * Paths of draft bodies that `create` is writing and has not committed a row for.
 * It is one set per process, not per store, because callers build a store per call.
 */
const writing = new Set<string>();

export class DraftStore {
  readonly #harness: () => Harness;
  readonly #paths: Paths;
  readonly #storage: Storage;
  readonly #audit: AuditLog | undefined;

  constructor(options: DraftStoreOptions) {
    this.#harness = options.harness;
    this.#paths = options.paths;
    this.#storage = options.storage;
    this.#audit = options.audit;
  }

  /**
   * Where a draft body is written. Not under `cache/`: the cleanup pass empties
   * that directory on an age, and a draft that nobody published yet is work, not
   * a cache entry.
   */
  get dir(): string {
    return this.#paths.draftsDir;
  }

  /**
   * Where a draft body was written before it moved under `state/`.
   *
   * Only the boot relocation reads it, and only for a row written before the
   * move.
   */
  get legacyDir(): string {
    return join(this.#paths.cacheDir, "drafts");
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  /**
   * Move every pending draft body still under `cache/` to `state/drafts/`, and
   * repoint its row.
   *
   * Called at boot, before the sweep: a daemon that started before this change
   * left rows that name a cache path, and the cleanup pass that empties `cache/`
   * would take their bodies with it. The file moves first and the row follows, so
   * an interrupted pass leaves a row that names a missing file and a body already
   * in place; the next boot finds the body at its new path and only repoints the
   * row. A body that is gone already is left to the sweep, which disposes it as
   * `body-file-missing`.
   */
  async relocate(context: Context): Promise<{ moved: number }> {
    const drafts = await this.list(context);
    let moved = 0;
    for (const draft of drafts) {
      if (draft.id === "" || draft.path === "") continue;
      if (dirname(draft.path) !== this.legacyDir) continue;
      const next = this.pathFor(draft.id);
      const here = await stat(draft.path).then(() => true).catch(() => false);
      if (here) {
        await mkdir(dirname(next), { recursive: true, mode: 0o700 });
        await rename(draft.path, next);
      } else if (!(await stat(next).then(() => true).catch(() => false))) {
        // Neither path has a body: the sweep records that, with the reason it
        // already uses, so this step never invents a fate for a draft.
        continue;
      }
      await this.#harness().commit(async (tx) => {
        const row = await tx.doc(SecReportDraft, draft.id, draft.id);
        row.path = next;
        row.updatedAt = Date.now();
      }, context);
      moved += 1;
    }
    return { moved };
  }

  async create(context: Context, input: CreateDraftInput): Promise<DraftRecord> {
    const id = ulid();
    const path = this.pathFor(id);
    const bytes = Buffer.byteLength(input.content, "utf8");
    const sha256 = draftDigest(input.content);
    const now = Date.now();
    writing.add(path);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, input.content, { encoding: "utf8", mode: 0o600 });
      const harness = this.#harness();
      await harness.commit(async (tx) => {
        const draft = await tx.doc(SecReportDraft, id, id);
        draft.id = id;
        draft.agentConversationId = input.agentConversationId;
        draft.jobId = input.jobId;
        draft.title = input.title;
        if (input.note !== undefined) draft.note = input.note;
        // Only `result` is written: a plan is the absent value, so a draft written
        // by an older caller and a plan read the same way.
        if (input.kind === "result") draft.kind = "result";
        draft.path = path;
        draft.bytes = bytes;
        Object.assign(draft, { sha256 });
        draft.createdAt = now;
        draft.status = "pending";
        draft.updatedAt = now;
      }, context);
    } finally {
      writing.delete(path);
    }
    return {
      id,
      agentConversationId: input.agentConversationId,
      jobId: input.jobId,
      title: input.title,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.kind === "result" ? { kind: "result" as const } : {}),
      path,
      bytes,
      sha256,
      createdAt: now,
      status: "pending",
      updatedAt: now,
    };
  }

  async get(context: Context, id: string): Promise<DraftRecord | undefined> {
    return (await this.#harness().snapshot(SecReportDraft, id, context)) as DraftRecord | undefined;
  }

  async list(context: Context): Promise<readonly Readonly<ReportDraftRecord>[]> {
    const keys = await scanDocumentKeys(this.#storage, DOC_KINDS.reportDraft, context);
    const harness = this.#harness();
    const found: Readonly<ReportDraftRecord>[] = [];
    for (const key of keys) {
      const record = await harness.snapshot(SecReportDraft, key, context);
      if (record !== undefined && record.status === "pending") found.push(record);
    }
    return found.sort((a, b) => a.createdAt - b.createdAt);
  }

  async read(record: ReportDraftRecord): Promise<string> {
    return await readFile(record.path, "utf8");
  }

  /** Read by id, or `undefined` when the draft is gone. */
  async readById(context: Context, id: string): Promise<{ record: ReportDraftRecord; content: string } | undefined> {
    const record = await this.get(context, id);
    if (record === undefined) return undefined;
    const content = await readFile(record.path, "utf8").catch(() => undefined);
    if (content === undefined) return undefined;
    return { record, content };
  }

  /**
   * Mark one draft and remove its file.
   *
   * The file goes first and the record second: a crash between them leaves a row
   * that names a missing file, which the sweep collects, rather than a file
   * nobody knows about.
   */
  async drop(context: Context, id: string, status: ReportDraftStatus): Promise<boolean> {
    const record = await this.get(context, id);
    if (record === undefined) return false;
    await rm(record.path, { force: true });
    await this.#harness().commit(async (tx) => {
      const draft = await tx.doc(SecReportDraft, id, id);
      draft.status = status;
      draft.updatedAt = Date.now();
      await tx.retireDoc(SecReportDraft, id);
    }, context);
    return true;
  }

  /**
   * Drop one row, and record why in the audit trail.
   *
   * The row retires here, so the audit entry is the only record that the draft
   * ever existed and why it went. No conversation disposes of the draft on these
   * paths — the sweep and the job archive do — so the entry names the author
   * rather than a caller, and `reason` says what made the row unattachable.
   */
  async #dispose(
    context: Context,
    draft: Readonly<ReportDraftRecord>,
    reason: string,
  ): Promise<void> {
    // A draft that goes because its job ended takes its body at the same moment.
    // The next boot is not when this work ended, and a body left behind is a file
    // nobody knows about until the orphan pass reaches it. The file goes first,
    // as it does in `drop`: a crash between the two leaves a row that names a
    // missing file, which the sweep collects. The archive path keeps the order it
    // always had, because the sweep's orphan pass is what has always removed that
    // body.
    if (reason === JOB_FINISHED_REASON) await rm(draft.path, { force: true });
    await this.#harness().commit(async (tx) => {
      const row = await tx.doc(SecReportDraft, draft.id, draft.id);
      row.status = "dropped";
      row.updatedAt = Date.now();
      await tx.retireDoc(SecReportDraft, draft.id);
    }, context);
    this.#audit?.append({
      type: "report_draft_disposed",
      draftId: draft.id,
      outcome: "dropped",
      reason,
      ...(draft.jobId === undefined ? {} : { jobId: draft.jobId }),
      agentConversationId: draft.agentConversationId,
    });
  }

  /**
   * Every draft one agent wrote that has no job, dropped when that agent is deleted.
   *
   * A draft that names a job is skipped: it belongs to that job now, so deleting
   * its author does not take it. What remains is the older kind of row, one
   * written before the job field existed.
   *
   * It returns what it dropped rather than how many, because the caller is
   * deleting the author: this record is the last chance to say what went with it.
   */
  async dropForAgent(context: Context, conversationId: string): Promise<readonly Readonly<ReportDraftRecord>[]> {
    const drafts = await this.list(context);
    const dropped: Readonly<ReportDraftRecord>[] = [];
    for (const draft of drafts) {
      if (draft.agentConversationId !== conversationId) continue;
      if (draft.jobId !== undefined) continue;
      if (await this.drop(context, draft.id, "dropped")) dropped.push(draft);
    }
    return dropped;
  }

  /**
   * Every pending draft that belongs to one of these jobs, dropped together.
   *
   * A draft is open work of its job, so it goes when that job ends. The caller
   * supplies the reason because the audit row is the only trace of the draft that
   * outlives the deletion: the row retires here, and a draft is invisible to the
   * operator's own lists.
   */
  async dropForJobs(
    context: Context,
    jobIds: readonly string[],
    reason: string,
  ): Promise<readonly Readonly<ReportDraftRecord>[]> {
    const wanted = new Set(jobIds);
    if (wanted.size === 0) return [];
    const drafts = await this.list(context);
    const dropped: Readonly<ReportDraftRecord>[] = [];
    for (const draft of drafts) {
      if (draft.jobId === undefined || !wanted.has(draft.jobId)) continue;
      await this.#dispose(context, draft, reason);
      dropped.push(draft);
    }
    return dropped;
  }

  /**
   * Remove drafts whose record is gone, whose file is missing, whose job is no
   * longer live, or whose job has already ended.
   *
   * Called at boot: a draft is a temporary file, and the one thing it must never
   * do is accumulate. A draft whose job left the live store has nothing left to
   * belong to, so it goes rather than waiting for a reader that cannot come. A
   * draft whose job ended is dropped here as well, because the status change that
   * ended the job may have stopped between the write and the disposal.
   *
   * The orphan pass runs on a row list read earlier, so a draft that `create`
   * finishes after that read has a body but no row in the list. Two checks keep
   * such a body: the path is in `writing` (a create is in flight), and the row
   * is read again just before the delete (a create committed since the list).
   *
   * `liveJobs` is optional so the store can be built without a job registry; the
   * runtime always passes the live one.
   */
  async sweep(
    context: Context,
    liveJobs?: LiveJobLookup,
  ): Promise<{ retired: number; orphanFiles: number }> {
    const live = await this.list(context);
    const known = new Set(live.map((draft) => draft.path));
    let retired = 0;
    for (const draft of live) {
      const present = await readFile(draft.path, "utf8").then(() => true).catch(() => false);
      if (present) {
        if (draft.jobId !== undefined && liveJobs !== undefined) {
          const job = await liveJobs.get(context, draft.jobId);
          if (job === undefined) {
            await this.#dispose(context, draft, "orphaned");
            retired += 1;
            continue;
          }
          if (job.status !== undefined && TERMINAL_JOB_STATUSES.includes(job.status)) {
            await this.#dispose(context, draft, JOB_FINISHED_REASON);
            retired += 1;
          }
        }
        continue;
      }
      await this.#dispose(context, draft, "body-file-missing");
      retired += 1;
    }
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.dir).catch(() => [] as string[]);
    let orphanFiles = 0;
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (known.has(join(this.dir, file))) continue;
      if (writing.has(join(this.dir, file))) continue;
      const row = await this.get(context, file.slice(0, -3)).catch(() => undefined);
      if (row !== undefined && row.status === "pending") continue;
      await rm(join(this.dir, file), { force: true });
      orphanFiles += 1;
    }
    return { retired, orphanFiles };
  }
}

/**
 * Drop the pending drafts of every job that just ended, and say which ones went.
 *
 * Every path that ends a job calls this: the tools `jobs_update` and
 * `jobs_cancel`, and the two HTTP routes that set a status or cancel a subtree. A
 * draft is open work of its job, so a job cannot end with its drafts still
 * pending because one path forgot the step. `store` is optional because a store
 * can be built without one, and a caller that has none has nothing to drop.
 */
export async function dropDraftsOfEndedJobs(
  store: DraftStore | undefined,
  context: Context,
  jobIds: readonly string[],
): Promise<readonly Readonly<ReportDraftRecord>[]> {
  if (store === undefined) return [];
  return await store.dropForJobs(context, jobIds, JOB_FINISHED_REASON);
}

/**
 * What a reply says about the drafts a job took with it.
 *
 * The drafts are gone from the store, so this line is the only chance to say
 * which ones went. A draft that was never published cannot come back, and an
 * agent that closed the job is the one who can still act on that.
 */
export function droppedDraftsNote(dropped: readonly Readonly<ReportDraftRecord>[]): string {
  if (dropped.length === 0) return "";
  const shown = dropped.map((draft) => `${draft.id} ("${draft.title}")`).join(", ");
  return `\ndropped ${dropped.length} draft report${dropped.length === 1 ? "" : "s"} of the job that ended: ${shown}`;
}

/** The same drafts as a list, for a JSON reply on the route that ended the job. */
export function droppedDraftRefs(
  dropped: readonly Readonly<ReportDraftRecord>[],
): readonly { readonly id: string; readonly title: string }[] {
  return dropped.map((draft) => ({ id: draft.id, title: draft.title }));
}
