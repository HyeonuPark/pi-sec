import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Session, Storage, Tx } from "@earendil-works/pi-durable";
import {
  SecInbox,
  SecJob,
  SecReport,
  TERMINAL_JOB_STATUSES,
  type InboxItem,
  type JobRecord,
  type JobStatus,
  type ReportApproval,
  type ReportApprovalVia,
  type ReportFeedback,
  type ReportKind,
  type ReportRecord,
  type ReportVersion,
} from "../documents.ts";
import type { AuditLog } from "../runtime/audit.ts";
import { dayStamp, ulid } from "../runtime/ids.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";

/** Longest slug we will mint. Long enough to be descriptive, short enough to read in a URL. */
const MAX_SLUG = 60;

/** `YYMMDD-`: six digits and the separator, which the title half of a name must leave room for. */
const DATE_PREFIX_LENGTH = 7;

export interface ReportCreateInput {
  readonly jobId: string;
  readonly title: string;
  readonly name?: string;
  readonly content: string;
  readonly note?: string;
  /**
   * `result` for a report about work that already ran, `briefing` for the morning
   * briefing. Absent means a plan.
   */
  readonly kind?: ReportKind;
}

export interface ReportFeedbackInput {
  readonly body: string;
  readonly version?: number;
  readonly from?: "operator" | "agent";
}

/**
 * A report write that a caller may want to announce: a new report, a new revision,
 * or the answer to operator feedback.
 */
export interface ReportChange {
  readonly kind: "created" | "updated" | "answered";
  readonly report: ReportRecord;
  /**
   * The answer to the operator's feedback, carried only by an `answered` change:
   * the words that go in the notice, because the document itself did not move.
   */
  readonly answer?: string;
}

/**
 * Runs inside the commit that writes the report, so whatever it writes lands with
 * the report or not at all. The runtime uses it to put one inbox notice per
 * change; that is why it takes the transaction rather than the finished record.
 */
export type ReportChangeHook = (tx: Tx, change: ReportChange, context: Context) => Promise<void> | void;

export class ReportNotFoundError extends Error {
  constructor(id: string) {
    super(`report not found: ${id}`);
    this.name = "ReportNotFoundError";
  }
}

/**
 * Turn a title into a URL slug.
 *
 * Unicode letters and digits are kept, so a Korean title stays readable in the
 * address bar instead of collapsing to `report`, `report-2`, `report-3`.
 */
export function slugify(title: string, maxLength: number = MAX_SLUG): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug === "" ? "report" : slug;
}

/**
 * The name a report is filed under: `YYMMDD-<slug>`.
 *
 * The day goes in the slug and never in the title. The slug is the address and
 * the place uniqueness is decided, so the same title on another day gets its own
 * name instead of a `-2`. The title is what a person reads in the viewer, the
 * inbox and the chat, and a date in front of it would start every one of those
 * sentences with a number.
 *
 * This is the one place a report name is built. `ReportStore.create` and the
 * `reports_publish_draft` collision check both call it, so the name the store
 * mints and the name the publishing tool looks for cannot drift apart.
 *
 * The day is local, as it is for job ids: the operator reads the store with
 * their own calendar in mind. The title half is cut to 53 characters, so the
 * prefix is never what gets truncated.
 */
export function reportName(source: string, at: number = Date.now()): string {
  return `${dayStamp(at).slice(2)}-${slugify(source, MAX_SLUG - DATE_PREFIX_LENGTH)}`;
}

/**
 * What `approve` did, or why it refused.
 *
 * A refusal is a value rather than a thrown error because each one is a normal
 * answer the caller has to tell apart: a route turns them into 404 and 409, and
 * the panel shows a different sentence for each.
 */
export type ReportApprovalOutcome =
  | { readonly ok: true; readonly report: ReportRecord; readonly approval: ReportApproval }
  | ReportApprovalRefusal
  | ReportDoneRefusal;

/**
 * Every way an approval is refused. A refusal is a value, never an exception.
 */
export type ReportApprovalRefusal =
  | { readonly ok: false; readonly reason: "not_found" }
  | {
      readonly ok: false;
      readonly reason: "stale_revision";
      /** The revision that can be approved. */
      readonly latest: number;
      readonly latestSha256: string;
    }
  | { readonly ok: false; readonly reason: "already_approved"; readonly approval: ReportApproval }
  /**
   * The report is a briefing, which asks for no approval at all: neither Approve
   * nor Done means anything on it, and only Feedback does.
   */
  | { readonly ok: false; readonly reason: "briefing" }
  | {
      readonly ok: false;
      readonly reason: "not_active";
      /**
       * The job's status, or `undefined` when the job is no longer in the live
       * store. A report is live exactly while its job is, so a job the live store
       * does not have makes the report read-only too — the archive sweep retires
       * the report a moment later, and refusing here does not depend on that
       * happening first.
       */
      readonly status: JobStatus | undefined;
    };

/**
 * Done was pressed on a plan. Only `approve` returns this: `checkApproval`
 * answers whether a revision can be approved at all, and a plan's revision can
 * be, with Approve.
 */
export type ReportDoneRefusal = { readonly ok: false; readonly reason: "not_a_result" };

/**
 * What a read-only approval check found.
 *
 * On success it hands back the report and the exact revision, so the caller does
 * not have to read the store a second time to learn what it is about to act on.
 */
export type ReportApprovalCheck =
  | { readonly ok: true; readonly report: ReportRecord; readonly version: ReportVersion }
  | ReportApprovalRefusal;

/**
 * What `setPending` did, or why it refused.
 *
 * A refusal is a value rather than a thrown error for the same reason an approval
 * refusal is: each one is a normal answer the caller tells apart, and the tool
 * turns each into its own sentence instead of an exception nobody can read.
 */
export type ReportPendingOutcome =
  | { readonly ok: true; readonly report: ReportRecord }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "not_active"; readonly status: JobStatus | undefined }
  /** The report is waiting on an answer, and this call brought none. */
  | { readonly ok: false; readonly reason: "answer_required" }
  /** An answer came, but nothing on this report was waiting for one. */
  | { readonly ok: false; readonly reason: "not_awaiting" }
  /**
   * The report is a result report that still waits for the user's Done or
   * Feedback, so the user has to look at it: it cannot be set aside.
   */
  | { readonly ok: false; readonly reason: "needs_user_check" }
  /**
   * The report is a briefing, which stays at the top of the list while its job
   * lives: setting it aside is refused.
   */
  | { readonly ok: false; readonly reason: "briefing" };

/** True when nothing can be confirmed on this report any more. */
function inactive(status: JobStatus | undefined): boolean {
  return status === undefined || TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * What `moveToJob` did, or why it refused.
 *
 * A refusal is a value for the same reason the pending and approval refusals are:
 * every one is a normal answer the caller tells apart, and the tool turns each into
 * its own sentence. A refusal writes nothing at all.
 */
export type ReportMoveOutcome =
  | { readonly ok: true; readonly report: ReportRecord; readonly fromJobId: string }
  /** No live report has this id. A report that moved to the archive with its job is here. */
  | { readonly ok: false; readonly reason: "not_found" }
  /** The report's own job has ended, so the report is not a live one to move. */
  | { readonly ok: false; readonly reason: "not_active"; readonly status: JobStatus | undefined }
  /** The target job is not in the live store. */
  | { readonly ok: false; readonly reason: "job_not_found" }
  /** The target job has ended. */
  | { readonly ok: false; readonly reason: "job_not_active"; readonly status: JobStatus }
  /** The report already belongs to that job, and nothing was written. */
  | { readonly ok: false; readonly reason: "same_job" };

/** Where a report stands, as one word a surface can render. */
export type ReportStanding = "active" | "result" | "briefing" | "pending" | "inactive" | "archived";

/**
 * The kind a record names, or `plan` for a record written before the field.
 *
 * This is the one place the absent value becomes a word, so no caller has to
 * decide for itself what an older report is.
 */
export function reportKind(record: { readonly kind?: ReportKind }): ReportKind {
  if (record.kind === "result" || record.kind === "briefing") return record.kind;
  return "plan";
}

/** The fields the standing is decided from: the kind, the flag, and what was answered. */
export interface StandingRecord {
  readonly kind?: ReportKind;
  readonly pendingAt?: number;
  readonly answeredAt?: number;
  /** Set when the report left the live store on its own, as an older briefing does. */
  readonly archivedAt?: number;
  readonly versions: readonly ReportVersion[];
  readonly feedback: readonly ReportFeedback[];
}

/**
 * Whether a result report still waits for the user to look at it.
 *
 * Two conditions together: the newest revision carries no Done or approval, and
 * no operator feedback on the report waits for an answer. Either one means the
 * user has something to do with the report, and nothing else does.
 */
export function needsUserCheck(record: StandingRecord): boolean {
  const newest = record.versions.at(-1);
  if (newest !== undefined && newest.approval !== undefined) return false;
  return !awaitingAnswer(record);
}

/**
 * The one word for a report's standing, derived from the job and the stored flag.
 *
 * The order is the whole meaning, and it has six steps:
 *
 *   1. A job the live store does not have takes the report to the archive, and so
 *      does `archivedAt` on the record: that is a report which left the live
 *      store on its own, as a briefing does when a newer one replaces it.
 *   2. A job that has ended makes the report inactive.
 *   3. A briefing report is `briefing` for as long as its job is live. It asks for
 *      no approval, so no flag moves it: the set-aside flag is refused for it.
 *   4. A result report that still waits for the user (`needsUserCheck`) is
 *      `result`, whatever the set-aside flag says. The user has to look at it, so
 *      it does not go below the pending section.
 *   5. The set-aside flag then makes it `pending`.
 *   6. Nothing else: a plan is `active`, a result report is `result`.
 *
 * So `pending` describes a report that would otherwise be open, and it can never
 * make a finished report look open. A job that is reopened brings the flag back
 * into force, because nothing clears it.
 *
 * This is the only place the words are decided. The report routes, the HTTP API
 * and the tools all read them from here, so no surface can disagree about what a
 * report is.
 */
export function reportStanding(record: StandingRecord, status: JobStatus | undefined): ReportStanding {
  if (record.archivedAt !== undefined) return "archived";
  if (status === undefined) return "archived";
  if (TERMINAL_JOB_STATUSES.includes(status)) return "inactive";
  const kind = reportKind(record);
  if (kind === "briefing") return "briefing";
  if (kind === "result" && needsUserCheck(record)) return "result";
  if (record.pendingAt !== undefined) return "pending";
  return kind === "result" ? "result" : "active";
}

/**
 * Whether a report is waiting for an answer to operator feedback.
 *
 * Three conditions. The report has to be set aside, the newest entry on it has
 * to be an operator note, and that note has to be newer than every answer the
 * report already carries. Without the flag, a report whose last note was answered
 * with a revision is not waiting on anything. Without the note, a report set aside
 * by an approval — which asks the owner for nothing — would look like a question
 * nobody answered. Without the answer, a report set aside again after it was
 * answered by message would ask the same question twice.
 *
 * The answers are the two forms a report takes. A revision is an answer by its
 * time, and the message form stores one in `answeredAt`. A message leaves the
 * revisions where they were, which is why the record needs that key at all. The
 * flag is what lets both forms clear the mark in one place: a revision clears it
 * in `addVersion`, and the message form clears it in `setPending`, so a reader
 * asks one question and gets the same answer either way.
 *
 * A tie between the note and a revision counts as the note being newer: the note
 * is the thing just written when the flag goes up, and a revision has already
 * cleared the flag by the time it could tie. A note written at the same
 * millisecond as a message answer is the note that answer was about, so there the
 * answer wins.
 *
 * A record written before `answeredAt` existed is judged exactly as it was: the
 * key is absent, and the note is compared with the revisions alone. So no
 * document needs a migration.
 */
export function awaitingAnswer(record: {
  readonly pendingAt?: number;
  readonly answeredAt?: number;
  readonly versions: readonly ReportVersion[];
  readonly feedback: readonly ReportFeedback[];
}): boolean {
  if (record.pendingAt === undefined) return false;
  const note = record.feedback.at(-1);
  if (note === undefined || note.from !== "operator") return false;
  if (record.answeredAt !== undefined && note.at <= record.answeredAt) return false;
  const revision = record.versions.at(-1);
  return revision === undefined || note.at >= revision.at;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The one copier of a live report record into an archived one, used by both
 * archive paths. It copies every field the live record holds, so a field that a
 * later change adds travels into the archive with no edit here. The records
 * carry the kind, the revisions with their approvals, the feedback, the
 * set-aside time and the answer time, and an archived report read back is the
 * same report it was.
 */
function copyReportToArchive(draft: ReportRecord, report: ReportRecord): void {
  Object.assign(draft, plain(report));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ReportStoreOptions {
  readonly session: Session;
  readonly storage: Storage;
  /** Live report bodies. */
  readonly reportsDir: string;
  /** Where archived report bodies go. */
  readonly archiveDir: string;
  /** The archive session, for moving reports out with their job. */
  readonly archiveSession?: Session;
  readonly archiveStorage?: Storage;
  /** Called inside the write commit; see `ReportChangeHook`. */
  readonly onChange?: ReportChangeHook;
  /** Where a report archived on its own is recorded, with the reason it left. */
  readonly audit?: AuditLog;
  readonly now?: () => number;
}

/**
 * Reports: a long document owned by a job, with an append-only revision history.
 *
 * The record is the index; the bodies are files, one per revision, never
 * overwritten. That is what makes a diff between revisions meaningful — an
 * overwritten file cannot be compared with anything.
 *
 * A report's *active* state is derived from its job rather than stored: it is
 * live exactly while its job is live. That removes an entire class of bug, since
 * there is no second copy of the truth to fall out of step when a job finishes,
 * is cancelled, or is archived. See `ArchiveStore`.
 *
 * One thing is stored: the `pending` flag, which says a report is set aside and is
 * not waiting on an answer right now. Three things set it, and they agree: the
 * operator sets or clears it by hand with `reports_set_pending`, an approval
 * records it in the same commit that records the approval, and an operator note
 * records it in the same commit that stores the note. Two writes clear it: a new
 * revision, which carries no approval and so is a question again, and the message
 * form of an answer, which clears the flag in the same commit that writes the
 * notice for that answer and stores its time in `answeredAt` (`setPending` with
 * an `answer`). It is not
 * a second copy of anything, because no job state decides it, and it ranks below
 * the job in `reportStanding()`, so it cannot contradict it.
 */
export class ReportStore {
  private readonly session: Session;
  private readonly storage: Storage;
  private readonly reportsDir: string;
  private readonly archiveDir: string;
  private readonly archiveSession: Session | undefined;
  private readonly archiveStorage: Storage | undefined;
  private readonly onChange: ReportChangeHook | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly now: () => number;

  /** The tail of the pending `addVersion` calls of each report. */
  private readonly versionChains = new Map<string, Promise<void>>();

  constructor(options: ReportStoreOptions) {
    this.session = options.session;
    this.storage = options.storage;
    this.reportsDir = options.reportsDir;
    this.archiveDir = options.archiveDir;
    this.archiveSession = options.archiveSession;
    this.archiveStorage = options.archiveStorage;
    this.onChange = options.onChange;
    this.audit = options.audit;
    this.now = options.now ?? (() => Date.now());
  }

  /** Directory holding one report's revisions, live or archived. */
  private liveDir(id: string): string {
    return join(this.reportsDir, id);
  }

  private archivedDir(id: string): string {
    return join(this.archiveDir, "reports", id);
  }

  private bodyPath(root: string, id: string, n: number): string {
    return root === this.archiveDir ? join(this.archivedDir(id), `v${n}.md`) : join(this.liveDir(id), `v${n}.md`);
  }

  async keys(context: Context): Promise<string[]> {
    return scanDocumentKeys(this.storage, "sec.report", context);
  }

  async list(context: Context, filter?: { readonly jobId?: string }): Promise<ReportRecord[]> {
    const records: ReportRecord[] = [];
    for (const key of await this.keys(context)) {
      const record = await this.session.snapshot(SecReport, key, context);
      if (record === undefined) continue;
      if (filter?.jobId !== undefined && record.jobId !== filter.jobId) continue;
      records.push(record as ReportRecord);
    }
    records.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));
    return records;
  }

  /** One report from the live store only. */
  async get(context: Context, id: string): Promise<ReportRecord | undefined> {
    return (await this.session.snapshot(SecReport, id, context)) as ReportRecord | undefined;
  }

  /** One report from the archive only. */
  async getArchived(context: Context, id: string): Promise<ReportRecord | undefined> {
    if (this.archiveSession === undefined) return undefined;
    return (await this.archiveSession.snapshot(SecReport, id, context)) as ReportRecord | undefined;
  }

  /** Live first, then the archive. */
  async getAny(context: Context, id: string): Promise<ReportRecord | undefined> {
    return (await this.get(context, id)) ?? (await this.getArchived(context, id));
  }

  async listArchived(context: Context): Promise<ReportRecord[]> {
    if (this.archiveSession === undefined || this.archiveStorage === undefined) return [];
    const records: ReportRecord[] = [];
    for (const key of await scanDocumentKeys(this.archiveStorage, "sec.report", context)) {
      const record = await this.archiveSession.snapshot(SecReport, key, context);
      if (record !== undefined) records.push(record as ReportRecord);
    }
    return records;
  }

  /**
   * Resolve a slug. The live store wins; an archived report is only reached when
   * no live report claims the name, and then the newest one wins. Names are kept
   * unique among live reports only — two archived reports may share one.
   */
  async byName(context: Context, name: string): Promise<{ report: ReportRecord; archived: boolean } | undefined> {
    const live = (await this.list(context)).filter((record) => record.name === name);
    if (live.length > 0) return { report: live[live.length - 1]!, archived: false };
    const archived = (await this.listArchived(context)).filter((record) => record.name === name);
    if (archived.length === 0) return undefined;
    archived.sort((a, b) => b.createdAt - a.createdAt);
    return { report: archived[0]!, archived: true };
  }

  /** The first free slug close to `base`. */
  private async reserveName(context: Context, base: string, exclude?: string): Promise<string> {
    const taken = new Set(
      (await this.list(context)).filter((record) => record.id !== exclude).map((record) => record.name),
    );
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${ulid(this.now())}`;
  }

  /** Write one revision body. A revision is never overwritten. */
  private async writeBody(root: string, id: string, n: number, content: string): Promise<ReportVersion> {
    const dir = root === this.archiveDir ? this.archivedDir(id) : this.liveDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const text = content.endsWith("\n") ? content : `${content}\n`;
    await writeFile(this.bodyPath(root, id, n), text, { encoding: "utf8", mode: 0o600 });
    return { n, at: this.now(), bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) };
  }

  /** Read one revision body, live first and then the archive. */
  async readVersion(id: string, n: number): Promise<string | undefined> {
    for (const root of [this.reportsDir, this.archiveDir]) {
      try {
        return await readFile(this.bodyPath(root, id, n), "utf8");
      } catch {
        /* try the next root */
      }
    }
    return undefined;
  }

  /** True when the body files are where the record says they are. */
  async hasBody(id: string, n: number): Promise<boolean> {
    for (const root of [this.reportsDir, this.archiveDir]) {
      try {
        await stat(this.bodyPath(root, id, n));
        return true;
      } catch {
        /* try the next root */
      }
    }
    return false;
  }

  async create(context: Context, input: ReportCreateInput): Promise<ReportRecord> {
    if (input.title.trim() === "") throw new Error("report title must not be empty");
    if (input.jobId.trim() === "") throw new Error("a report must belong to a job");
    if (input.content.trim() === "") throw new Error("a report body must not be empty");
    const id = ulid(this.now());
    const name = await this.reserveName(context, reportName(input.name ?? input.title, this.now()));
    // The body lands before the record, so a record never points at a file that
    // was never written. A body with no record is inert.
    const version = await this.writeBody(this.reportsDir, id, 1, input.content);
    const record = await this.session.commit(async (tx: Tx) => {
      const draft = await tx.doc(SecReport, id, id);
      draft.id = id;
      draft.jobId = input.jobId;
      draft.name = name;
      draft.title = input.title;
      // The kind is written only when it is not `plan`: a plan is the absent
      // value, so a report written by an older caller and a plan read the same way.
      if (input.kind === "result" || input.kind === "briefing") draft.kind = input.kind;
      draft.versions = [{ ...version, ...(input.note !== undefined ? { note: input.note } : {}) }];
      draft.feedback = [];
      draft.createdAt = this.now();
      draft.updatedAt = this.now();
      const written = plain(draft);
      await this.onChange?.(tx, { kind: "created", report: written }, context);
      return written;
    }, context);
    // Only a new briefing report pushes the one before it out of the live store.
    // It happens after the new record stands, so the newest briefing is never the
    // one that goes: a failure here leaves two briefings live, which the next
    // briefing clears.
    if (input.kind === "briefing") await this.archiveEarlierBriefings(context, id);
    return record;
  }

  /**
   * Append a revision to a live report.
   *
   * A new revision is a new question: it carries no approval, so nothing the
   * operator confirmed with a button covers this text, and the report is waiting
   * on an answer again. The `pending` flag therefore does not survive the write.
   * It is cleared in the same commit as the revision, never by a second call, so
   * no reader sees a report whose newest revision waits while the record says it
   * does not.
   */
  async addVersion(
    context: Context,
    id: string,
    input: { readonly content: string; readonly note?: string },
  ): Promise<ReportRecord> {
    if (input.content.trim() === "") throw new Error("a report body must not be empty");
    // One chain per report: the read of the revision count, the body write and the
    // commit of two calls on one report run one after the other, so each call takes
    // its own number. Calls on other reports do not wait for this one.
    const previous = this.versionChains.get(id) ?? Promise.resolve();
    const run = previous.then(() => this.appendVersion(context, id, input));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.versionChains.set(id, tail);
    void tail.then(() => {
      if (this.versionChains.get(id) === tail) this.versionChains.delete(id);
    });
    return run;
  }

  private async appendVersion(
    context: Context,
    id: string,
    input: { readonly content: string; readonly note?: string },
  ): Promise<ReportRecord> {
    const current = await this.get(context, id);
    if (current === undefined) throw new ReportNotFoundError(id);
    const n = current.versions.length + 1;
    const version = await this.writeBody(this.reportsDir, id, n, input.content);
    return this.session.commit(async (tx) => {
      const draft = await tx.doc(SecReport, id, id);
      if (draft.createdAt === 0) throw new ReportNotFoundError(id);
      // A second line of defense for a writer outside the chain: the record must
      // still hold the revisions this call counted.
      if (draft.versions.length !== n - 1) throw new Error(`report ${id} changed while its revision was written`);
      draft.versions = [...draft.versions, { ...version, ...(input.note !== undefined ? { note: input.note } : {}) }];
      // The flag says the operator does not have to answer about this report yet.
      // The revision just written takes that back: it is unanswered text, and its
      // notice has to raise the badge that says so.
      delete draft.pendingAt;
      draft.updatedAt = this.now();
      const record = plain(draft);
      await this.onChange?.(tx, { kind: "updated", report: record }, context);
      return record;
    }, context);
  }

  /**
   * Set a live report aside as `pending`, or bring it back to its open standing:
   * `active` for a plan and `result` for a result report.
   *
   * Only the stored flag moves. Nothing about the job is written, and no revision
   * or approval is touched, so a report set aside keeps everything it had: the
   * same text, the same feedback, the same button to press if the operator does
   * open it. What changes is where it appears and whether it asks for attention —
   * which is why this call, when it only moves the flag, puts nothing in the inbox.
   *
   * The one exception is the answer path: bringing back a report that is waiting on
   * an answer to operator feedback needs the answer itself (`awaitingAnswer` says
   * which reports those are). That call clears the flag and writes the notice for
   * the answer in one commit, through the `answered` change, so a report cannot come
   * back with nobody told why. The answer is a message by design: it leaves the
   * revisions and the last approval exactly where they were, which is the whole
   * point of answering without a new revision. It stores its own time in
   * `answeredAt`, so a report set aside again afterwards does not ask the operator
   * the question the message already answered.
   *
   * Five refusals. The first two are about the report rather than about the caller. A
   * report that is not in the live store is refused as `not_found`: an
   * archived report is the record of finished work, and a flag on it could never be
   * shown. A report whose job has ended is refused as `not_active`, in both
   * directions, because the job has already decided that nothing is waiting for an
   * answer, and writing a flag that `reportStanding()` outranks would be a change
   * with no effect pretending to be one. A result report that still waits for the
   * user's Done or Feedback is refused as `needs_user_check`: the user has to look
   * at it, so it belongs under Results, and setting it aside would leave a flag on
   * screen that nobody can see take effect. The other two are about the answer this
   * call brought, or did not bring. A report that is waiting on an answer is refused
   * as `answer_required` when the call brings none, so the one path back to its open
   * standing cannot be walked silently. A report that is not waiting on an answer is
   * refused as `not_awaiting` when the call brings one anyway, so a caller is never
   * told an answer was recorded when nothing was asking. An `answer` sent with
   * `pending: true` is ignored: setting a report aside asks nothing, so there is
   * nothing for it to answer.
   *
   * Those last two are asked twice, outside the commit and again inside it, for the
   * reason `approve` gives about its own re-check: a note that lands between the two
   * reads makes the report wait for an answer, and this call must not walk past it.
   * The refusal of a report that waits for the user is asked in both places too, so
   * a revision that lands in between is not walked past either.
   *
   * The checks read once before the commit for the reason `approve` gives: a
   * refusal taken inside the commit would leave an empty report row behind, since
   * acquiring an absent family document seeds it.
   */
  async setPending(
    context: Context,
    id: string,
    pending: boolean,
    input?: { readonly answer?: string },
  ): Promise<ReportPendingOutcome> {
    const report = await this.get(context, id);
    if (report === undefined) return { ok: false, reason: "not_found" };
    const status = await this.jobStatus(context, report.jobId);
    if (inactive(status)) return { ok: false, reason: "not_active", status };
    // Whitespace is not an answer. It is the same rule `addFeedback` applies to a
    // note: a blank one is not a note, so a blank answer is not an answer.
    const answer = input?.answer?.trim();
    const given = answer !== undefined && answer !== "";
    if (!pending) {
      const waiting = awaitingAnswer(report);
      if (waiting && !given) return { ok: false, reason: "answer_required" };
      if (!waiting && given) return { ok: false, reason: "not_awaiting" };
    } else if (reportKind(report) === "briefing") {
      // A briefing stays at the top of the list for as long as its job lives, so a
      // flag that would move it down is refused rather than written and ignored.
      return { ok: false, reason: "briefing" };
    } else if (reportKind(report) === "result" && needsUserCheck(report)) {
      // A result report the user still has to answer about cannot be set aside: it
      // is under Results for exactly as long as it waits for their Done or
      // Feedback, and a flag the standing outranks would be a change with no
      // effect pretending to be one.
      return { ok: false, reason: "needs_user_check" };
    }
    const at = this.now();
    return this.session.commit(async (tx: Tx): Promise<ReportPendingOutcome> => {
      const draft = await tx.doc(SecReport, id, id);
      // A report that vanished between the read above and this commit is not a
      // report: throwing aborts the commit rather than seeding one.
      if (draft.createdAt === 0) throw new ReportNotFoundError(id);
      // Asked again here, so a note that landed since the read above is not walked
      // past: the report is waiting on an answer now even if it was not then.
      if (!pending) {
        const waitingNow = awaitingAnswer(draft);
        if (waitingNow && !given) return { ok: false, reason: "answer_required" };
        if (!waitingNow && given) return { ok: false, reason: "not_awaiting" };
      } else if (reportKind(draft) === "briefing") {
        return { ok: false, reason: "briefing" };
      } else if (reportKind(draft) === "result" && needsUserCheck(draft)) {
        // Asked again here, so a revision that landed since the read above is not
        // walked past: the report waits for the user again even if it did not then.
        return { ok: false, reason: "needs_user_check" };
      }
      if (pending) draft.pendingAt = at;
      else delete draft.pendingAt;
      // The message form of an answer, and the one thing it stores: when it was
      // given. `awaitingAnswer` reads it against the newest note, so the note this
      // message answered stops counting as unanswered when the report is set aside
      // again, and a note the operator writes afterwards counts once more.
      if (!pending && given) draft.answeredAt = at;
      draft.updatedAt = at;
      const record = plain(draft);
      // The message form of an answer. The flag and the notice land in one commit,
      // so the two cannot disagree about whether the operator was told.
      if (!pending && given && answer !== undefined) {
        await this.onChange?.(tx, { kind: "answered", report: record, answer }, context);
      }
      return { ok: true, report: record };
    }, context);
  }

  /**
   * Move a live report to another live job.
   *
   * One field moves. The record's `jobId` is the only thing a report says about
   * where it belongs: the name, the title, the revisions, the approvals inside
   * them and the feedback are all the document's own, so a report that changes
   * hands keeps every one of them and the reader sees the same text under a new
   * owner. The `pending` flag stays too, because it is about the operator's
   * attention rather than about the job.
   *
   * A report is live exactly while its job is (see the class note), so both ends
   * of the move have to be live jobs: `not_found` for a report the live store does
   * not have, `not_active` for one whose job has ended, `job_not_found` for a
   * target the store does not have, and `job_not_active` for one that has ended.
   * Without that, a move would be a way to bring finished work back to life, or to
   * file a report under a job nobody can reopen. `same_job` is a refusal as well:
   * it writes nothing, and the caller says the report is already there.
   *
   * Drafts are not moved. A draft belongs to the job that produced it, so the
   * drafts of the job the report leaves stay where they are.
   *
   * The checks read once before the commit for the reason `approve` gives: a
   * refusal taken inside the commit would leave an empty report row behind, since
   * acquiring an absent family document seeds it.
   */
  async moveToJob(context: Context, id: string, jobId: string): Promise<ReportMoveOutcome> {
    const report = await this.get(context, id);
    if (report === undefined) return { ok: false, reason: "not_found" };
    const fromJobId = report.jobId;
    if (fromJobId === jobId) return { ok: false, reason: "same_job" };
    const sourceStatus = await this.jobStatus(context, fromJobId);
    if (inactive(sourceStatus)) return { ok: false, reason: "not_active", status: sourceStatus };
    const targetStatus = await this.jobStatus(context, jobId);
    if (targetStatus === undefined) return { ok: false, reason: "job_not_found" };
    if (TERMINAL_JOB_STATUSES.includes(targetStatus)) {
      return { ok: false, reason: "job_not_active", status: targetStatus };
    }
    const at = this.now();
    return this.session.commit(async (tx: Tx): Promise<ReportMoveOutcome> => {
      const draft = await tx.doc(SecReport, id, id);
      // A report that vanished between the read above and this commit is not a
      // report: throwing aborts the commit rather than seeding one.
      if (draft.createdAt === 0) throw new ReportNotFoundError(id);
      draft.jobId = jobId;
      draft.updatedAt = at;
      return { ok: true, report: plain(draft), fromJobId };
    }, context);
  }

  /**
   * Whether revision `n` of `id` can be approved right now, and why not.
   *
   * This is the read-only half of `approve`, and it writes nothing. A caller that
   * refuses on it does so before it has done anything the refusal would have to
   * undo — which is why the route asks this question before it puts an approval
   * into the conversation.
   *
   * Four refusals, in the order they are asked:
   *
   *   - `not_found`: no live report has this id. A report moved to the archive
   *     with its job is here, and stays here: the archive is the record of
   *     finished work, not a surface to confirm anything on.
   *   - `not_active`: the report's job is finished, cancelled, failed, or gone
   *     from the live store. Its revisions are no longer a proposal anybody can
   *     take up, so no button on them means anything.
   *   - `stale_revision`: `n` is not the newest revision. The agent has published
   *     a new one since, and approving the old text would look like consent to
   *     something nobody was shown. The refusal names the revision that can be
   *     approved, so the caller can say so.
   *   - `already_approved`: this revision already carries one. An approval is not
   *     rewritten, so `at` and `via` keep the moment and the surface they
   *     happened on.
   *
   * The job is read through this store's own session, which is where the job
   * document lives. That is the one fact the report does not carry: a report's
   * active state is derived from its job rather than stored (see the class note),
   * so it has to be read from the job when it is needed.
   */
  async checkApproval(context: Context, id: string, n: number): Promise<ReportApprovalCheck> {
    const report = await this.get(context, id);
    if (report === undefined) return { ok: false, reason: "not_found" };
    // A briefing asks for no approval, so no press on it means anything: it is
    // refused before the job is read, because the press is wrong whatever the job
    // says.
    if (reportKind(report) === "briefing") return { ok: false, reason: "briefing" };
    const status = await this.jobStatus(context, report.jobId);
    if (inactive(status)) return { ok: false, reason: "not_active", status };
    const latest = report.versions.length;
    if (latest !== n || n < 1) {
      return { ok: false, reason: "stale_revision", latest, latestSha256: report.versions[latest - 1]?.sha256 ?? "" };
    }
    const version = report.versions[n - 1]!;
    if (version.approval !== undefined) {
      return { ok: false, reason: "already_approved", approval: { ...version.approval } };
    }
    return { ok: true, report, version };
  }

  /** One job's status, from the live store; `undefined` when it is not there. */
  private async jobStatus(context: Context, jobId: string): Promise<JobStatus | undefined> {
    const job = await this.session.snapshot(SecJob, jobId, context);
    return (job as JobRecord | undefined)?.status;
  }

  /**
   * Record the operator's approval of one revision.
   *
   * `checkApproval` above is the rule, and this writes only what it approved. The
   * check and the write are in the same commit, so two requests that race cannot
   * both win: the second sees the approval the first wrote. Nothing is written on
   * a refusal, and the approval copies the revision's stored `sha256` rather than
   * hashing the body again: the point is to name the revision the store already
   * holds, not to re-derive it.
   *
   * Reading once before the commit is also what keeps a refusal from leaving a
   * trace: acquiring a family document that is absent seeds a row, so a refusal
   * taken inside the commit would leave an empty report behind.
   *
   * The press is also the set-aside: this records the `pending` flag in the same
   * commit, from the same clock read, so no reader ever sees an approved report
   * still asking for an answer, and the operator has nothing left to do about it.
   * Three writes set the flag and they agree: this press, an operator note in
   * `addFeedback`, and the operator's own `reports_set_pending`. Two clear it:
   * `addVersion`, because a revision written after this one is asked about on its
   * own, and `reports_set_pending` with an `answer`, which clears the flag for the
   * note it answers. The landing gate reads `versions[n].approval` and never this
   * flag.
   */
  async approve(
    context: Context,
    id: string,
    n: number,
    input: { readonly via: ReportApprovalVia; readonly button?: "done"; readonly text?: string },
  ): Promise<ReportApprovalOutcome> {
    const check = await this.checkApproval(context, id, n);
    if (!check.ok) return check;
    // A briefing asks for no approval, and `checkApproval` has already refused it;
    // the guard is repeated here so the write path cannot be reached another way.
    if (reportKind(check.report) === "briefing") return { ok: false, reason: "briefing" };
    // Done is the approve button of a result report. A plan is approved with
    // Approve, so Done on a plan is refused before anything is written.
    if (input.button === "done" && reportKind(check.report) !== "result") return { ok: false, reason: "not_a_result" };
    const at = this.now();
    return this.session.commit(async (tx: Tx): Promise<ReportApprovalOutcome> => {
      const draft = await tx.doc(SecReport, id, id);
      // A report that vanished between the read above and this commit is not a
      // report: throwing aborts the commit rather than seeding one.
      if (draft.createdAt === 0) throw new ReportNotFoundError(id);
      const latest = draft.versions.length;
      const target = latest === n ? draft.versions[n - 1] : undefined;
      if (target === undefined) {
        return { ok: false, reason: "stale_revision", latest, latestSha256: draft.versions[latest - 1]?.sha256 ?? "" };
      }
      if (target.approval !== undefined) {
        return { ok: false, reason: "already_approved", approval: { ...target.approval } };
      }
      const approval: ReportApproval = {
        at,
        via: input.via,
        sha256: target.sha256,
        ...(input.button === "done" ? { button: "done" as const } : {}),
        ...(input.text !== undefined && input.text !== "" ? { text: input.text } : {}),
      };
      draft.versions = draft.versions.map((version, index) =>
        index === n - 1 ? { ...version, approval } : version,
      );
      // The press is also the set-aside: the flag lands in this commit, with the
      // approval, so no reader sees an approved report still asking for an answer.
      // The landing gate reads `versions[n].approval` and never this flag.
      draft.pendingAt = at;
      draft.updatedAt = at;
      return { ok: true, report: plain(draft), approval };
    }, context);
  }

  /**
   * Record a note against a report.
   *
   * An operator note is also the set-aside, in the same commit that stores it: the
   * operator has said their piece, so the Active list stops asking them about this
   * report. The answer still comes, in either of the two forms the convention
   * names — a new revision, which clears the flag in `addVersion`, or a message,
   * which clears it in `setPending` — and the report goes back in front of them.
   * A note an agent wrote is not the operator's word and sets nothing.
   *
   * The clock is read once, outside the commit, so the note, the flag and the
   * record's `updatedAt` cannot disagree about the moment. `approve` reads it once
   * for the same reason.
   */
  async addFeedback(context: Context, id: string, input: ReportFeedbackInput): Promise<ReportFeedback> {
    if (input.body.trim() === "") throw new Error("feedback must not be empty");
    const at = this.now();
    const entry: ReportFeedback = {
      id: ulid(at),
      at,
      body: input.body,
      ...(input.version !== undefined ? { version: input.version } : {}),
      from: input.from ?? "operator",
    };
    await this.session.commit(async (tx) => {
      const draft = await tx.doc(SecReport, id, id);
      if (draft.createdAt === 0) throw new ReportNotFoundError(id);
      draft.feedback = [...draft.feedback, entry];
      // The note is also the set-aside: the operator has said their piece, so the
      // Active list stops asking them about this report. The answer still comes —
      // a revision clears this flag and puts the report back in front of them.
      if (entry.from === "operator") draft.pendingAt = at;
      draft.updatedAt = at;
    }, context);
    return entry;
  }

  /**
   * Every live inbox item: the notice store in this session, read through storage.
   *
   * The `sec.inbox` family is not enumerable from inside a `Tx`, so a sweep that
   * works on the whole list has to walk it here.
   */
  private async inboxItems(context: Context): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const key of await scanDocumentKeys(this.storage, "sec.inbox", context)) {
      const item = await this.session.snapshot(SecInbox, key, context);
      if (item !== undefined) items.push(item as InboxItem);
    }
    return items;
  }

  /**
   * The inbox items the archive holds: the notices of an archived briefing.
   *
   * Nothing on screen reads these, and no tool returns them. The accessor is here
   * because the notice is the only record that the user was told about a briefing
   * that has since left the live store, and a test that moves one has to see where
   * it went.
   */
  async archivedInbox(context: Context): Promise<InboxItem[]> {
    if (this.archiveSession === undefined || this.archiveStorage === undefined) return [];
    const items: InboxItem[] = [];
    for (const key of await scanDocumentKeys(this.archiveStorage, "sec.inbox", context)) {
      const item = await this.archiveSession.snapshot(SecInbox, key, context);
      if (item !== undefined) items.push(item as InboxItem);
    }
    return items;
  }

  /**
   * Move the briefings before `keepId` out of the live store, notices and all.
   *
   * A briefing replaces the one before it, so only the newest one stays where the
   * user reads it. The steps are the ones `moveJobsToArchive` takes, one report at
   * a time and for one reason: the report does not leave with its job, so the job
   * says nothing about it, and the record carries the time it left in
   * `archivedAt` instead.
   *
   *   1. Copy the records and the notices into the archive, in one commit, so the
   *      archive is complete before anything is retired.
   *   2. Move the body directories by rename, never by a delete: a missing file is
   *      recoverable and a lost one is not.
   *   3. Retire the live records, in one commit.
   *
   * The two stores are separate SQLite files, so a crash between the copy and the
   * retire leaves the report live and archived at once. The next briefing picks it
   * up again — the steps are idempotent, and copying a record the archive already
   * holds writes the same fields back.
   *
   * An inbox notice is moved rather than hidden. Hiding means writing the user's
   * `clearedInbox` list, which the next page to save its own copy of the list
   * overwrites, and which drops ids past its cap; the archive has neither problem
   * and is where the report itself goes. Nothing reads notices out of the archive,
   * so a moved notice is a record rather than something on screen.
   */
  private async archiveEarlierBriefings(context: Context, keepId: string): Promise<void> {
    if (this.archiveSession === undefined) return;
    const earlier = (await this.list(context)).filter(
      (record) => record.id !== keepId && reportKind(record) === "briefing",
    );
    const earlierIds = new Set(earlier.map((record) => record.id));
    // Two rules pick the notices: one that points at a briefing being moved, and
    // one of kind `briefing` at all. The second is what clears the briefings that
    // came in as `notify` items before reports carried them. The notice of the new
    // report is of kind `report` and names the new report, so neither rule takes it.
    const notices = (await this.inboxItems(context)).filter(
      (item) => item.kind === "briefing" || (item.source?.reportId !== undefined && earlierIds.has(item.source.reportId)),
    );
    if (earlier.length === 0 && notices.length === 0) return;
    const at = this.now();

    await this.archiveSession.commit(async (tx) => {
      for (const report of earlier) {
        const draft = await tx.doc(SecReport, report.id, report.id);
        copyReportToArchive(draft, report);
        // The one field this path adds: the record itself says it left the live
        // store, because no job change says it.
        draft.archivedAt = at;
      }
      for (const item of notices) {
        const draft = await tx.doc(SecInbox, item.id, item.id);
        draft.id = item.id;
        draft.kind = item.kind;
        draft.title = item.title;
        draft.body = item.body;
        draft.createdAt = item.createdAt;
        if (item.readAt !== undefined) draft.readAt = item.readAt;
        if (item.source !== undefined) draft.source = { ...item.source };
        if (item.severity !== undefined) draft.severity = item.severity;
      }
    }, context);

    for (const report of earlier) {
      try {
        await mkdir(join(this.archiveDir, "reports"), { recursive: true, mode: 0o700 });
        await rename(this.liveDir(report.id), this.archivedDir(report.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await this.session.commit(async (tx) => {
      for (const report of earlier) await tx.retireDoc(SecReport, report.id);
      for (const item of notices) await tx.retireDoc(SecInbox, item.id);
    }, context);

    // The audit trail is where a report that left without its job is explained.
    for (const report of earlier) {
      this.audit?.append({
        type: "report_archived",
        reason: "briefing-archived",
        reportId: report.id,
        title: report.title,
        jobId: report.jobId,
      });
    }
  }

  /**
   * Move these jobs' reports into the archive: documents, then bodies.
   *
   * Called by the archive sweep after the job documents are copied and before
   * they are retired, so the live report records outlive their job only if the
   * process dies in between — and `readVersion` looks in both roots either way.
   */
  async moveJobsToArchive(context: Context, jobIds: readonly string[]): Promise<void> {
    if (this.archiveSession === undefined) return;
    const wanted = new Set(jobIds);
    const reports = (await this.list(context)).filter((record) => wanted.has(record.jobId));
    if (reports.length === 0) return;

    await this.archiveSession.commit(async (tx) => {
      for (const report of reports) {
        const draft = await tx.doc(SecReport, report.id, report.id);
        copyReportToArchive(draft, report);
      }
    }, context);

    // Body files move by rename, and only after the archive has the record: a
    // missing file is recoverable, a lost one is not.
    for (const report of reports) {
      try {
        const destination = this.archivedDir(report.id);
        await mkdir(join(this.archiveDir, "reports"), { recursive: true, mode: 0o700 });
        await rename(this.liveDir(report.id), destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await this.session.commit(async (tx) => {
      for (const report of reports) await tx.retireDoc(SecReport, report.id);
    }, context);
  }
}
