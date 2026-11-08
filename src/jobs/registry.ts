import type { Context, Draft } from "@earendil-works/chord";
import type { Session, Storage, Tx } from "@earendil-works/pi-durable";
import {
  SecJob,
  TERMINAL_JOB_STATUSES,
  type JobOnceSpec,
  type JobRecord,
  type JobRoutineSpec,
  type JobStatus,
} from "../documents.ts";
import type { ReportStore } from "../reports/store.ts";
import { jobId, ulid } from "../runtime/ids.ts";

export interface JobCreateInput {
  readonly title: string;
  readonly description?: string;
  readonly parentId?: string;
  readonly origin?: JobRecord["origin"];
  readonly labels?: readonly string[];
  readonly memoryAnchors?: readonly string[];
  readonly stateDir?: string;
  /** A recurring schedule. Gated: see `judgeRoutineChange`. */
  readonly routine?: JobRoutineSpec;
  /** A single run. Not gated. */
  readonly once?: JobOnceSpec;
  /** The approval `resolveRoutineApproval` minted. Required exactly when the change is gated. */
  readonly routineApproval?: RoutineApproval;
  readonly conversationId?: string;
  readonly taskIds?: readonly string[];
}

export interface JobUpdateInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: JobStatus;
  readonly parentId?: string | null;
  readonly labels?: readonly string[];
  readonly memoryAnchors?: readonly string[];
  readonly stateDir?: string | null;
  /** Set a routine, or `null` to remove one. Both directions are gated. */
  readonly routine?: JobRoutineSpec | null;
  /** Set a one-off run, or `null` to remove one. Gated only when it replaces a routine. */
  readonly once?: JobOnceSpec | null;
  /** The approval `resolveRoutineApproval` minted. Required exactly when the change is gated. */
  readonly routineApproval?: RoutineApproval;
  readonly conversationId?: string | null;
  readonly taskIds?: readonly string[];
  readonly lastRun?: JobRecord["lastRun"];
  readonly recordRun?: { readonly success: boolean; readonly summary?: string };
}

/** What a cancel may carry besides the id: the approval, when one is needed. */
export interface JobCancelOptions {
  readonly routineApproval?: RoutineApproval;
  /** Refuse the cancel when an open descendant carries a routine. The tool path sets it. */
  readonly refuseRoutineDescendants?: boolean;
}

/** What a cancel changed: the target, and the descendants it moved to `cancelled`. */
export interface JobCancelResult {
  readonly job: JobRecord;
  readonly descendants: readonly JobRecord[];
}

export interface JobFilter {
  readonly status?: JobStatus | readonly JobStatus[];
  readonly parentId?: string;
  readonly label?: string;
}

export interface JobNode {
  readonly job: JobRecord;
  readonly children: JobNode[];
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`job not found: ${id}`);
    this.name = "JobNotFoundError";
  }
}

/**
 * The change one write asks for, as far as the routine gate is concerned.
 *
 * Only three keys matter. A write that names none of them, or names a `once`
 * alone, is not a routine change and needs no approval; everything else is
 * decided by `judgeRoutineChange` below.
 */
export interface RoutineChangeSubject {
  readonly routine?: JobRoutineSpec | null;
  readonly once?: JobOnceSpec | null;
  readonly status?: JobStatus;
}

/**
 * What the gate says about one write: pass, or the reasons it is gated.
 *
 * The reasons are what the refusal prints, in the words the model reads: a caller
 * that is refused learns why its change counted as a routine change instead of
 * having to infer it, and the same list goes into the `routine_refused` audit row.
 * `resolveRoutineApproval` is what puts them into the message.
 */
export type RoutineGate =
  | { readonly gated: false }
  | { readonly gated: true; readonly reasons: readonly string[] };

/**
 * The statuses that stop a routine from firing.
 *
 * Closing or pausing a routine deletes a schedule in everything but name, so it
 * is gated with the field itself. `planned`, `active` and `waiting` are not
 * here: they start a job or resume one, and the schedule they resume was
 * approved when it was written.
 */
const ROUTINE_STOPPING_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled", "paused"];

/**
 * Decide whether one write is a routine change, and why.
 *
 * The rule, in one place: a job that gains, changes or loses a
 * `routine`, and a routine job whose status is closed or paused, needs an
 * approved report. A one-off (`once`) and a job with no schedule do not. The
 * two directions of a swap are both routine changes — `once` cleared with
 * `routine` set is a routine created, `routine` cleared with `once` set is one
 * deleted — and the subject carries both fields so neither direction can slip
 * through by naming only the field it adds.
 *
 * `before` is the record as it stands. `undefined` means the write creates one,
 * which is the only case where setting `routine` is a creation rather than a
 * change.
 */
export function judgeRoutineChange(before: JobRecord | undefined, change: RoutineChangeSubject): RoutineGate {
  const reasons: string[] = [];
  const setsRoutine = change.routine !== undefined && change.routine !== null;
  const clearsRoutine = change.routine === null;
  const hadRoutine = before?.routine !== undefined;
  if (before === undefined) {
    if (setsRoutine) reasons.push("creates a job that carries a routine, which is a recurring schedule");
  } else {
    if (setsRoutine && hadRoutine) reasons.push("changes the routine of a job that already has one");
    if (setsRoutine && !hadRoutine) {
      reasons.push("adds a routine to a job that has none, which creates a recurring schedule");
    }
    if (clearsRoutine && hadRoutine) reasons.push("removes the routine from a job, which deletes a recurring schedule");
    if (
      change.status !== undefined &&
      hadRoutine &&
      change.status !== before.status &&
      ROUTINE_STOPPING_STATUSES.includes(change.status)
    ) {
      reasons.push(`closes or pauses the job of a routine with status "${change.status}", so the routine stops firing`);
    }
  }
  return reasons.length === 0 ? { gated: false } : { gated: true, reasons };
}

/**
 * The approval a gated write carries: which report, which revision, which text.
 *
 * The seal is a symbol declared here and not exported, so `typeof` it is a type
 * no other file can name. The only code that writes `seal` into an approval is
 * `resolveRoutineApproval` below, which reads the report store and compares the
 * sha256 — so a caller that skips the check cannot fill the field without an
 * explicit cast, and the registry checks the symbol at run time as well. That is
 * what makes the gate a gate rather than a habit.
 */
const ROUTINE_APPROVAL_SEAL: unique symbol = Symbol("pi-sec.routine-approval");

export interface RoutineApproval {
  readonly reportId: string;
  /** The revision the approval sits on. Always the newest at the time of the check. */
  readonly revision: number;
  /** The sha256 of that revision, which the approval must also name. */
  readonly sha256: string;
  readonly seal: typeof ROUTINE_APPROVAL_SEAL;
}

/** Why a gated write was refused, as the caller reports it. */
export interface RoutineRefusal {
  /** Stable and machine-readable: the `code` of the `routine_refused` row. */
  readonly code: string;
  /** What the caller reports, and the sentence the user reads. */
  readonly message: string;
  /** What was refused and why, as one list. */
  readonly reasons: readonly string[];
}

export type RoutineApprovalOutcome =
  | { readonly ok: true; readonly approval: RoutineApproval }
  | { readonly ok: false; readonly refusal: RoutineRefusal };

/**
 * The last line of the gate: a gated change with no approval never reaches a
 * record.
 *
 * It is thrown rather than returned because every caller that a person reaches
 * (`jobs_create`, `jobs_update`, `jobs_cancel`, the HTTP routes) resolves the
 * approval first and answers with text. This fires only for a caller that wrote
 * a routine change without going through that path, and a throw is the right
 * answer there: the write must not happen, and no caller is prepared to read a
 * value.
 */
export class RoutineGateError extends Error {
  readonly code = "routine_approval_required";
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(
      `routine change refused: this write ${reasons.join("; ")}, and an approved report is required. ` +
        "Resolve the approval with `resolveRoutineApproval` and pass the result as `routineApproval`.",
    );
    this.name = "RoutineGateError";
    this.reasons = [...reasons];
  }
}

/**
 * A cancel refused because an open descendant carries a routine.
 *
 * Thrown inside the commit, so nothing is written. `jobs` names each routine
 * job by id and title, so the caller can close those first, each with its own
 * approval.
 */
export class RoutineDescendantError extends Error {
  readonly code = "routine_descendant";
  readonly jobs: readonly { readonly id: string; readonly title: string }[];
  constructor(id: string, jobs: readonly JobRecord[]) {
    const named = jobs.map((job) => `${job.id} ("${job.title}")`).join(", ");
    super(
      `job ${id} was NOT cancelled, and nothing was written: open descendant${jobs.length === 1 ? "" : "s"} ${named} ` +
        `carr${jobs.length === 1 ? "ies" : "y"} a routine. Closing a routine job needs its own approved report. ` +
        "Close each routine job first with jobs_update or jobs_cancel and its reportId, then cancel this job again.",
    );
    this.name = "RoutineDescendantError";
    this.jobs = jobs.map((job) => ({ id: job.id, title: job.title }));
  }
}

function approvalRefusal(
  code: string,
  subject: readonly string[],
  detail: string,
): RoutineApprovalOutcome {
  const reasons = [...subject, detail];
  // The reason travels in the message, not only in the audit row: the caller that
  // is refused has to read which part of its write counted as a routine change,
  // or the next call guesses again. It comes after the opening sentence, which
  // stays one fixed string so a reader (and a test) can match the refusal without
  // knowing which of the seven codes answered.
  const why = subject.length === 0 ? "" : ` Why the gate covers this write: it ${subject.join("; it ")}.`;
  return {
    ok: false,
    refusal: { code, message: `Routine NOT changed. Nothing was written: ${detail}${why}`, reasons },
  };
}

/**
 * The words a caller puts around the shared approval check.
 *
 * The routine gate and the restart gate ask the same question of the report
 * store, and refuse for the same reasons. Only the act they guard and the next
 * step they tell the caller to take differ, so those two are the only things a
 * caller supplies.
 */
export interface ApprovalWording {
  /** The act that needs the approval, as a noun phrase: "this routine change", "this change". */
  readonly act: string;
  /** What the caller does once the approval is in place, given the report id it named. */
  readonly retry: (reportId: string) => string;
}

/** What the shared approval check found: the approved revision, or why there is none. */
export type ApprovedReportCheck =
  | { readonly ok: true; readonly reportId: string; readonly revision: number; readonly sha256: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * Check that a report carries an approval that covers its current text.
 *
 * Three things have to hold:
 *
 *   1. the report is live and its newest revision is the one approved — an
 *      approval on an older revision is not an approval of the current text;
 *   2. the approval's `sha256` equals the newest revision's `sha256` — the plan
 *      is approved as written, not as it was two revisions ago;
 *   3. the report's job is still live, which `checkApproval` decides. A report
 *      that moved to the archive with its finished job, or whose job has ended,
 *      is a record of consent to work that already landed, not standing
 *      permission for the next change.
 *
 * `reportId` names the report. Nothing else is asked of the caller: the sha256
 * is read from the store and compared there, because a value the caller types
 * proves nothing about what the user saw. The routine gate
 * (`resolveRoutineApproval`) and the restart gate (`request_restart`) both use
 * this check, so the two cannot disagree about what counts as an approval.
 */
export async function checkApprovedReport(args: {
  readonly reports: ReportStore;
  readonly context: Context;
  readonly reportId: string | undefined;
  readonly wording: ApprovalWording;
}): Promise<ApprovedReportCheck> {
  const { reports, wording } = args;
  const reportId = args.reportId?.trim();
  if (reportId === undefined || reportId === "") {
    return {
      ok: false,
      code: "report_id_required",
      detail:
        `no reportId was passed, and ${wording.act} needs one: pass the reportId of a report whose newest revision the user approved. ` +
        "The approval must name that revision's sha256, so publishing a newer revision after the approval cancels it.",
    };
  }
  const report = await reports.get(args.context, reportId);
  if (report === undefined) {
    return {
      ok: false,
      code: "report_not_found",
      detail:
        `no live report ${reportId} exists, so there is no approval to read. A report whose job finished moved to the archive with its approval, ` +
        `and that approval covered the change it was written for. Publish ${wording.act} as a report, have the user approve its newest revision, and ${wording.retry(reportId)}.`,
    };
  }
  const latest = report.versions.length;
  const check = await reports.checkApproval(args.context, report.id, latest);
  if (check.ok) {
    return {
      ok: false,
      code: "no_approval",
      detail:
        `report ${report.id} ("${report.title}") has no approval on its newest revision, v${latest}. ` +
        `Ask the user to press Approve on v${latest} in the report viewer or the chat's report panel, then ${wording.retry(report.id)}.`,
    };
  }
  if (check.reason === "not_found") {
    return {
      ok: false,
      code: "report_not_found",
      detail: `report ${report.id} disappeared while the approval was being checked. Try again.`,
    };
  }
  if (check.reason === "not_active") {
    return {
      ok: false,
      code: "report_not_active",
      detail:
        `report ${report.id} ("${report.title}") belongs to a job that is ${check.status ?? "no longer in the live store"}, ` +
        `so its revisions are not a proposal anyone can act on now. Write ${wording.act} as a report on a live job and have the user approve it.`,
    };
  }
  if (check.reason === "stale_revision") {
    return {
      ok: false,
      code: "stale_revision",
      detail: `report ${report.id} published a newer revision while this call was being checked (v${check.latest} is newest now). Have the user approve v${check.latest}, then ${wording.retry(report.id)}.`,
    };
  }
  if (check.reason === "briefing") {
    // A briefing asks for no approval, so it can never clear a gate that asks for
    // one. Said in its own words, because the fix is a different report rather
    // than another press.
    return {
      ok: false,
      code: "report_is_briefing",
      detail:
        `report ${report.id} ("${report.title}") is a briefing, and a briefing asks for no approval, so nothing on it can be confirmed. ` +
        `Write ${wording.act} as a plan and have the user approve its newest revision, then ${wording.retry(report.id)}.`,
    };
  }
  const approvedSha = check.approval.sha256;
  const latestSha = report.versions[latest - 1]?.sha256 ?? "";
  if (approvedSha !== latestSha) {
    return {
      ok: false,
      code: "approval_sha256_mismatch",
      detail:
        `the approval on report ${report.id} v${latest} names sha256 ${approvedSha || "(empty)"}, but that revision is ${latestSha || "(empty)"}. ` +
        `An approval that does not name the text it covers does not count; ask the user to approve v${latest} again.`,
    };
  }
  return { ok: true, reportId: report.id, revision: latest, sha256: latestSha };
}

/** How the routine gate words the shared check. */
const ROUTINE_WORDING: ApprovalWording = {
  act: "this routine change",
  retry: (reportId) => `pass reportId=${reportId} again`,
};

/**
 * Check that a gated write carries an approval, and hand back the token for it.
 *
 * The rule is `checkApprovedReport` above; this adds the routine gate's own
 * opening sentence and the seal the registry checks.
 */
export async function resolveRoutineApproval(args: {
  readonly reports: ReportStore | undefined;
  readonly context: Context;
  readonly reportId: string | undefined;
  readonly gate: RoutineGate;
}): Promise<RoutineApprovalOutcome> {
  const subject = args.gate.gated ? args.gate.reasons : [];
  const reports = args.reports;
  if (reports === undefined) {
    return approvalRefusal(
      "report_store_unavailable",
      subject,
      "this process has no report store, so no approval can be read. Start the daemon with reports wired, then pass the reportId of the approved report.",
    );
  }
  const check = await checkApprovedReport({ reports, context: args.context, reportId: args.reportId, wording: ROUTINE_WORDING });
  if (!check.ok) return approvalRefusal(check.code, subject, check.detail);
  const approval: RoutineApproval = {
    reportId: check.reportId,
    revision: check.revision,
    sha256: check.sha256,
    seal: ROUTINE_APPROVAL_SEAL,
  };
  return { ok: true, approval };
}

/**
 * Record (or clear) the completion time as a job crosses the terminal boundary.
 *
 * The first terminal time is kept. A later no-op update to an already-finished
 * job must not push its archive date back out — otherwise a job that is touched
 * once a week would never age out.
 */
function applyCompletion(draft: Draft<JobRecord>, status: JobStatus, now: number): void {
  if (TERMINAL_JOB_STATUSES.includes(status)) {
    if (draft.completedAt === undefined) draft.completedAt = now;
  } else if (draft.completedAt !== undefined) {
    delete (draft as { completedAt?: number }).completedAt;
  }
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface JobRegistryOptions {
  readonly session: Session;
  readonly storage: Storage;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** Durable high-level job registry over the `sec.job` session family. */
export class JobRegistry {
  private readonly session: Session;
  private readonly storage: Storage;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: JobRegistryOptions) {
    this.session = options.session;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => jobId(this.now()));
  }

  /** Enumerate every job document's key. */
  async keys(context: Context): Promise<string[]> {
    const keys: string[] = [];
    let cursor: Parameters<Storage["scanDocuments"]>[2];
    for (;;) {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "sec.job" },
        500,
        cursor,
        context,
      );
      for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return keys;
  }

  async list(context: Context, filter?: JobFilter): Promise<JobRecord[]> {
    const keys = await this.keys(context);
    const jobs: JobRecord[] = [];
    for (const key of keys) {
      const job = await this.session.snapshot(SecJob, key, context);
      if (job === undefined) continue;
      if (!matches(job, filter)) continue;
      jobs.push(job as JobRecord);
    }
    jobs.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));
    return jobs;
  }

  async get(context: Context, id: string): Promise<JobRecord | undefined> {
    const job = await this.session.snapshot(SecJob, id, context);
    return job as JobRecord | undefined;
  }

  async tree(context: Context, filter?: JobFilter): Promise<JobNode[]> {
    const jobs = await this.list(context, filter);
    const byId = new Map<string, JobNode>();
    for (const job of jobs) byId.set(job.id, { job, children: [] });
    const roots: JobNode[] = [];
    for (const node of byId.values()) {
      const parentId = node.job.parentId;
      const parent = parentId !== undefined ? byId.get(parentId) : undefined;
      if (parent !== undefined) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /** Create a job inside an existing commit. */
  async createTx(tx: Tx, input: JobCreateInput): Promise<JobRecord> {
    if (input.title.trim() === "") throw new Error("job title must not be empty");
    const gate = judgeRoutineChange(undefined, { routine: input.routine, once: input.once });
    if (gate.gated && input.routineApproval?.seal !== ROUTINE_APPROVAL_SEAL) throw new RoutineGateError(gate.reasons);
    if (input.parentId !== undefined) {
      const parent = await this.getTx(tx, input.parentId);
      if (parent === undefined) throw new Error(`parent job not found: ${input.parentId}`);
    }
    const id = this.newId();
    const now = this.now();
    const draft = await tx.doc(SecJob, id, id);
    draft.id = id;
    draft.title = input.title;
    if (input.description !== undefined) draft.description = input.description;
    if (input.parentId !== undefined) draft.parentId = input.parentId;
    draft.origin = input.origin ?? "agent";
    draft.labels = [...(input.labels ?? [])];
    draft.memoryAnchors = [...(input.memoryAnchors ?? [])];
    if (input.stateDir !== undefined) draft.stateDir = input.stateDir;
    if (input.routine !== undefined) draft.routine = { ...input.routine };
    if (input.once !== undefined) draft.once = { ...input.once };
    if (input.conversationId !== undefined) draft.conversationId = input.conversationId;
    draft.taskIds = [...(input.taskIds ?? [])];
    draft.status = "planned";
    draft.createdAt = now;
    draft.updatedAt = now;
    draft.stats = { runs: 0, failures: 0 };
    return plain(draft);
  }

  /** Read a job draft inside a commit; throws when it does not exist. */
  async getTx(tx: Tx, id: string): Promise<JobRecord | undefined> {
    const draft = await tx.doc(SecJob, id, id);
    if (draft.createdAt === 0) return undefined;
    return plain(draft);
  }

  async updateTx(tx: Tx, id: string, change: JobUpdateInput): Promise<JobRecord> {
    const draft = await tx.doc(SecJob, id, id);
    if (draft.createdAt === 0) throw new JobNotFoundError(id);
    // The gate is asked against the record as it stands, because whether a write
    // creates, changes or deletes a routine is a fact about the value it is
    // replacing. A gated write with no approval never reaches the fields below.
    const before = plain(draft) as JobRecord;
    const gate = judgeRoutineChange(before, { routine: change.routine, once: change.once, status: change.status });
    if (gate.gated && change.routineApproval?.seal !== ROUTINE_APPROVAL_SEAL) throw new RoutineGateError(gate.reasons);
    if (change.title !== undefined) draft.title = change.title;
    if (change.description !== undefined) {
      if (change.description === null) delete (draft as { description?: string }).description;
      else draft.description = change.description;
    }
    if (change.status !== undefined) {
      draft.status = change.status;
      applyCompletion(draft, change.status, this.now());
    }
    if (change.parentId !== undefined) {
      if (change.parentId === null) delete (draft as { parentId?: string }).parentId;
      else draft.parentId = change.parentId;
    }
    if (change.labels !== undefined) draft.labels = [...change.labels];
    if (change.memoryAnchors !== undefined) draft.memoryAnchors = [...change.memoryAnchors];
    if (change.stateDir !== undefined) {
      if (change.stateDir === null) delete (draft as { stateDir?: string }).stateDir;
      else draft.stateDir = change.stateDir;
    }
    // One schedule per record. Setting one clears the other, and a caller that
    // sets one while the other is still on the record is told so: the record it
    // asked for is not a record this store can hold, and picking a winner for it
    // would be the silent rule this change exists to remove.
    if (change.routine !== undefined) {
      if (change.routine === null) delete (draft as { routine?: JobRoutineSpec }).routine;
      else {
        draft.routine = { ...change.routine };
        delete (draft as { once?: JobOnceSpec }).once;
      }
    }
    if (change.once !== undefined) {
      if (change.once === null) delete (draft as { once?: JobOnceSpec }).once;
      else {
        if (draft.routine !== undefined) {
          throw new Error(
            "a job cannot carry both routine and once: clear the routine in the same change (that is a routine deletion and needs an approved report), or put the one-off on its own job",
          );
        }
        draft.once = { ...change.once };
      }
    }
    // Cancelling a one-off before it fires writes the state in this commit, not
    // on the next tick. The scheduler would reach the same value a minute later,
    // and until then the record would say "cancelled job, pending run".
    if (change.status === "cancelled" && draft.once !== undefined && (draft.once.state ?? "pending") === "pending") {
      draft.once = { ...draft.once, state: "cancelled" };
    }
    if (change.conversationId !== undefined) {
      if (change.conversationId === null) delete (draft as { conversationId?: string }).conversationId;
      else draft.conversationId = change.conversationId;
    }
    if (change.taskIds !== undefined) draft.taskIds = [...change.taskIds];
    if (change.lastRun !== undefined) draft.lastRun = { ...change.lastRun };
    if (change.recordRun !== undefined) {
      const stats = { runs: (draft.stats?.runs ?? 0) + 1, failures: (draft.stats?.failures ?? 0) + (change.recordRun.success ? 0 : 1) };
      draft.stats = stats;
      const summary: JobRecord["lastRun"] = { at: this.now(), status: change.recordRun.success ? "success" : "failure" };
      if (change.recordRun.summary !== undefined) (summary as { summary?: string }).summary = change.recordRun.summary;
      draft.lastRun = summary;
    }
    draft.updatedAt = this.now();
    return plain(draft);
  }

  /**
   * Store a complete record verbatim, preserving its own id, timestamps, and
   * run stats. `createTx` mints a fresh identity and stamps `createdAt`; this is
   * the opposite, for moving a record between stores without rewriting it.
   */
  async writeTx(tx: Tx, record: JobRecord): Promise<JobRecord> {
    const draft = await tx.doc(SecJob, record.id, record.id);
    draft.id = record.id;
    draft.title = record.title;
    if (record.description === undefined) delete (draft as { description?: string }).description;
    else draft.description = record.description;
    draft.status = record.status;
    if (record.parentId === undefined) delete (draft as { parentId?: string }).parentId;
    else draft.parentId = record.parentId;
    draft.origin = record.origin;
    draft.labels = [...record.labels];
    draft.memoryAnchors = [...record.memoryAnchors];
    if (record.stateDir === undefined) delete (draft as { stateDir?: string }).stateDir;
    else draft.stateDir = record.stateDir;
    // `schedule` is dead and a move does not carry it. The schedule a record
    // fires on is its `routine` or `once`; nothing reads the old copy, so copying
    // it here only kept a stale field alive in the archive. The field is deleted
    // instead, so a record that had one loses it on its next move. Reading stays
    // compatible: `JobRecord.schedule` keeps the field optional, and a stored
    // document that still holds one loads unchanged.
    delete (draft as { schedule?: JobRecord["schedule"] }).schedule;
    // Verbatim means verbatim: a record that carries a routine keeps it across a
    // move, or a one-off that fired would arrive in the archive with nothing to
    // say it ever had a time.
    if (record.routine === undefined) delete (draft as { routine?: JobRoutineSpec }).routine;
    else draft.routine = { ...record.routine };
    if (record.once === undefined) delete (draft as { once?: JobOnceSpec }).once;
    else draft.once = { ...record.once };
    if (record.conversationId === undefined) delete (draft as { conversationId?: string }).conversationId;
    else draft.conversationId = record.conversationId;
    draft.taskIds = [...record.taskIds];
    draft.createdAt = record.createdAt;
    draft.updatedAt = record.updatedAt;
    if (record.lastRun === undefined) delete (draft as { lastRun?: JobRecord["lastRun"] }).lastRun;
    else draft.lastRun = { ...record.lastRun };
    if (record.completedAt === undefined) delete (draft as { completedAt?: number }).completedAt;
    else draft.completedAt = record.completedAt;
    draft.stats = { runs: record.stats.runs, failures: record.stats.failures };
    return plain(draft);
  }

  /** Retire a job document inside an existing commit. */
  async removeTx(tx: Tx, id: string): Promise<void> {
    await tx.retireDoc(SecJob, id);
  }

  /** Convenience: retire a job document in its own commit. */
  async remove(context: Context, id: string): Promise<void> {
    await this.session.commit((tx) => this.removeTx(tx, id), context);
  }

  /** Store several complete records in one commit. All of them, or none. */
  async writeAll(context: Context, records: readonly JobRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.session.commit(async (tx) => {
      for (const record of records) await this.writeTx(tx, record);
    }, context);
  }

  /** Retire several job documents in one commit. All of them, or none. */
  async removeAll(context: Context, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.session.commit(async (tx) => {
      for (const id of ids) await this.removeTx(tx, id);
    }, context);
  }

  /** Convenience: create in its own commit. */
  async create(context: Context, input: JobCreateInput): Promise<JobRecord> {
    return this.session.commit((tx) => this.createTx(tx, input), context);
  }

  /** Convenience: update in its own commit. */
  async update(context: Context, id: string, change: JobUpdateInput): Promise<JobRecord> {
    return this.session.commit((tx) => this.updateTx(tx, id, change), context);
  }

  /**
   * The ids of every live descendant of one job, nearest first.
   *
   * A `Tx` cannot enumerate the `sec.job` family, so the walk reads the store
   * before the commit and `cancelTx` reads each record again inside it. The walk
   * keeps the ids it has seen, so a parent chain that loops in hand-edited data
   * ends instead of hanging the cancel.
   */
  async descendantIds(context: Context, id: string): Promise<string[]> {
    const jobs = await this.list(context);
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const job of jobs) {
          if (job.parentId !== parent || seen.has(job.id)) continue;
          seen.add(job.id);
          out.push(job.id);
          next.push(job.id);
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Cancel one job and its non-terminal descendants, inside an existing commit.
   *
   * This is the one cancel both callers use: the `jobs_cancel` tool and the
   * HTTP cancel route behind the user's cancel button. A descendant that is
   * already `done`, `failed` or `cancelled` keeps its status and its completion
   * time, because cancelling finished work would rewrite what happened.
   *
   * `descendants` comes from `descendantIds`, read before the commit. Each record
   * is read again here, so a descendant that finished in between is left alone.
   *
   * One approval covers the whole cancel, so whether it is needed is decided
   * once, over the target and the open descendants that carry a routine. Asking
   * for a second approval because closing a routine parent also closed a routine
   * child would be one user decision split into two buttons.
   *
   * With `refuseRoutineDescendants`, an open descendant that carries a routine
   * refuses the whole cancel with `RoutineDescendantError`, and nothing is
   * written. The tool path sets it: an agent closes a routine job on its own, with
   * the approval for that job, rather than as a side effect of closing its parent.
   */
  async cancelTx(
    tx: Tx,
    id: string,
    descendants: readonly string[],
    options: JobCancelOptions = {},
  ): Promise<JobCancelResult> {
    const target = await this.getTx(tx, id);
    if (target === undefined) throw new JobNotFoundError(id);
    const open: JobRecord[] = [];
    for (const descendantId of descendants) {
      if (descendantId === id) continue;
      const record = await this.getTx(tx, descendantId);
      if (record === undefined || TERMINAL_JOB_STATUSES.includes(record.status)) continue;
      open.push(record);
    }
    if (options.refuseRoutineDescendants === true) {
      const routines = open.filter((record) => record.routine !== undefined);
      if (routines.length > 0) throw new RoutineDescendantError(id, routines);
    }
    const reasons: string[] = [];
    for (const record of [target, ...open]) {
      const gate = judgeRoutineChange(record, { status: "cancelled" });
      if (gate.gated) reasons.push(...gate.reasons);
    }
    const approval = options.routineApproval;
    if (reasons.length > 0 && approval?.seal !== ROUTINE_APPROVAL_SEAL) throw new RoutineGateError(reasons);
    const carry = approval === undefined ? {} : { routineApproval: approval };
    const job = await this.updateTx(tx, id, { status: "cancelled", ...carry });
    const cancelled: JobRecord[] = [];
    for (const record of open) cancelled.push(await this.updateTx(tx, record.id, { status: "cancelled", ...carry }));
    return { job, descendants: cancelled };
  }

  /** Convenience: cancel a job and its non-terminal descendants in its own commit. */
  async cancel(context: Context, id: string, options: JobCancelOptions = {}): Promise<JobCancelResult> {
    const descendants = await this.descendantIds(context, id);
    return this.session.commit((tx) => this.cancelTx(tx, id, descendants, options), context);
  }
}

function matches(job: JobRecord, filter?: JobFilter): boolean {
  if (filter === undefined) return true;
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(job.status)) return false;
  }
  if (filter.parentId !== undefined && job.parentId !== filter.parentId) return false;
  if (filter.label !== undefined && !job.labels.includes(filter.label)) return false;
  return true;
}
