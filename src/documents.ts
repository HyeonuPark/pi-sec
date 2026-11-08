import { createHash } from "node:crypto";
import { defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

/** Lifecycle status of a high-level job. */
export type JobStatus = "planned" | "active" | "waiting" | "paused" | "done" | "failed" | "cancelled";

export const JOB_STATUSES: readonly JobStatus[] = [
  "planned",
  "active",
  "waiting",
  "paused",
  "done",
  "failed",
  "cancelled",
];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

export type JobOrigin = "user" | "agent" | "scheduler" | "system";

/**
 * The old schedule field. Nothing writes it any more and nothing reads it.
 *
 * It held a copy of a `config.scheduler.jobs` entry, and the reconciler read the
 * config entry, not this copy. `routine` and `once` replace it: they are the
 * schedule, and the record is the only source of one. The type stays so a record
 * written before the change still parses; no new value is stored.
 */
export type JobScheduleSpec = {
  readonly cron: string;
  readonly timezone?: string;
  readonly catchUp?: "skip" | "once" | "all";
  readonly overlap?: "skip" | "queue" | "allow";
};

/** What a recurring routine does when its occurrence was missed. */
export type JobRoutineCatchUp = "skip" | "once" | "all";

/** What a recurring routine does when its previous round is still running. */
export type JobRoutineOverlap = "skip" | "queue" | "allow";

/**
 * A recurring routine: the schedule itself, on the job record.
 *
 * This is the only place a recurring schedule is defined. `config.scheduler.jobs`
 * is read once, by the boot migration, and emptied; after that the record is the
 * source, and `jobs_update` is how a routine changes. Creating, changing, or
 * removing one goes through the routine gate, which wants an approved report.
 */
export type JobRoutineSpec = {
  /** Five-field cron expression, in `timezone`. */
  readonly cron: string;
  /** IANA zone; absent means the global `scheduler.timezone`. */
  readonly timezone?: string;
  readonly catchUp?: JobRoutineCatchUp;
  readonly overlap?: JobRoutineOverlap;
  /** The text the run receives. Required: a routine with no prompt fires nothing. */
  readonly prompt: string;
  /** A key of the `vmodels` table. A tool that writes a routine must name one; a record written earlier without one is still read, and its run fails instead of borrowing the root agent's vmodel. */
  readonly vmodel?: string;
  /** Absent means enabled. `false` keeps the record and stops the firing. */
  readonly enabled?: boolean;
};

/**
 * Lifecycle of a one-off run.
 *
 * `pending` waits for `at`. `done` fired. `cancelled` was called off before it
 * fired. `missed` found its time more than five minutes past without firing —
 * the same window `catchUp: "skip"` uses, so there is one late rule, not two.
 * A missed run is closed rather than left waiting: a `pending` record whose time
 * passed would look due on every tick and never fire.
 */
export type JobOnceState = "pending" | "done" | "cancelled" | "missed";

/**
 * A one-off run: it fires once, at `at`, and the job closes.
 *
 * It needs no approval. A job carries `routine` or `once`, never both: the two
 * differ in when they fire, in whether a change needs approval, and in what
 * happens after firing, so one record cannot hold both without a rule that says
 * which side wins.
 */
export type JobOnceSpec = {
  /** When to fire, in epoch milliseconds. Written from an ISO 8601 offset form. */
  readonly at: number;
  readonly prompt: string;
  /** A key of the `vmodels` table. A tool that writes a single run must name one; a record written earlier without one is still read, and its run fails instead of borrowing the root agent's vmodel. */
  readonly vmodel?: string;
  /** Absent means `pending`. */
  readonly state?: JobOnceState;
};

export type JobRunSummary = {
  readonly at: number;
  readonly status: "success" | "failure";
  readonly summary?: string;
};

/** One durable high-level job record (`sec.job`). */
export type JobRecord = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: JobStatus;
  readonly parentId?: string;
  readonly origin: JobOrigin;
  labels: string[];
  memoryAnchors: string[];
  readonly stateDir?: string;
  /** @deprecated Nothing reads this. See `JobScheduleSpec`. */
  readonly schedule?: JobScheduleSpec;
  /** A recurring schedule. Mutually exclusive with `once`. */
  routine?: JobRoutineSpec;
  /** A single run. Mutually exclusive with `routine`. */
  once?: JobOnceSpec;
  readonly conversationId?: string;
  taskIds: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastRun?: JobRunSummary;
  /**
   * When the job reached a terminal status. Cleared when it is reopened.
   *
   * Added in `SecJob` version 2. The archive sweep measures its retention window
   * from this rather than from `updatedAt`, so an unrelated touch cannot keep a
   * finished job alive. Jobs stored before version 2 get `updatedAt` as an
   * approximation — see the `migrate` on `SecJob`.
   */
  readonly completedAt?: number;
  readonly stats: {
    readonly runs: number;
    readonly failures: number;
  };
};

/** One notification item (`sec.inbox`). */
export type InboxItem = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
  readonly readAt?: number;
  /**
   * What the item is about. `reportId` marks an item as a report notice, which
   * is the field the chat UI reads to open the report panel instead of folding
   * the item open in place.
   */
  readonly source?: {
    readonly jobId?: string;
    readonly conversationId?: string;
    readonly reportId?: string;
    /**
     * Which report write this item announces, when a report write made it. The
     * three read the same otherwise — same kind, same report — so this is the only
     * field that tells a publication from a revision from an answer. The chat UI
     * reads it to color the row's mark.
     */
    readonly reportEvent?: "published" | "updated" | "answered";
  };
  readonly severity?: "info" | "warn" | "error";
};

/** One self-edit operation log entry (`sec.selfEdit`). */
export type SelfEditRecord = {
  readonly id: string;
  readonly title: string;
  readonly kind: "runtime-extension" | "core-change" | "promotion";
  files: string[];
  readonly diffHash?: string;
  /**
   * What the gate actually ran. There is no `smoke`: nothing implemented one,
   * and a declared field nothing fills reads as a check that passed.
   */
  readonly validation?: {
    readonly typecheck?: boolean;
    readonly tests?: boolean;
    readonly secretsClean?: boolean;
  };
  readonly commit?: string;
  readonly restartRequired: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** One core-candidate review-queue entry (`sec.candidate`). */
export type CandidateRecord = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly origin: "runtime-promotion" | "core-edit";
  files: string[];
  readonly diffHash?: string;
  readonly commit?: string;
  /** See `SelfEditRecord.validation`; there is no `smoke` check. */
  readonly validation?: {
    readonly typecheck?: boolean;
    readonly tests?: boolean;
    readonly secretsClean?: boolean;
  };
  readonly status: "proposed" | "accepted" | "rejected" | "applied" | "superseded";
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Agent-adjustable, non-secret preferences (`sec.settings`).
 *
 * The three lists are UI state the server keeps so it survives a reload, a
 * cleared browser store, and the next device: the jobs the operator has cleared
 * off the list, the job titles they have opened, and the inbox items they have
 * cleared. They used to live in `localStorage`, where a failed write was
 * swallowed and the list quietly came back on the next load.
 *
 * All three are optional and the version is deliberately unchanged: an older
 * document simply lacks them, whereas raising the version would make a rollback
 * unable to read the document at all (see the note on `SecJob`).
 */
export type SecPreferences = {
  readonly notes?: string;
  readonly hiddenJobs?: string[];
  readonly expandedJobs?: string[];
  readonly clearedInbox?: string[];
};

/**
 * Durable job records, one document per job, session-scoped.
 *
 * Version 2 added `completedAt`. A job written by version 1 is read through the
 * `migrate` below. Note the asymmetry: a *newer* stored version is refused
 * outright by the runtime, so rolling the binary back past this change leaves
 * the job records unreadable. Back up before applying it.
 *
 * `routine` and `once` are optional additions and the version stays at 2 on
 * purpose: an older record simply lacks them, whereas raising the version would
 * make a rollback unable to read any record at all.
 */
export const SecJob = defineDocFamily<JobRecord, string>({
  kind: "sec.job",
  version: 2,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    title: id,
    status: "planned",
    origin: "agent",
    labels: [],
    memoryAnchors: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
    stats: { runs: 0, failures: 0 },
  }),
  migrate: (value, fromVersion) => {
    if (fromVersion >= 2) return value as unknown as JobRecord;
    const job = value as unknown as JobRecord;
    // A job that already ended before this field existed never recorded when.
    // `updatedAt` is the best available proxy and an honest one to state: it can
    // be later than the real completion, which delays archiving rather than
    // bringing it forward. Backfilling from `lastRun` was rejected — a job can be
    // marked done without a recorded run, and inventing a time is worse than
    // admitting the gap.
    if (TERMINAL_JOB_STATUSES.includes(job.status) && job.completedAt === undefined) {
      return { ...job, completedAt: job.updatedAt };
    }
    return job;
  },
});

/** Notification inbox items, one document per item, session-scoped. */
export const SecInbox = defineDocFamily<InboxItem, string>({
  kind: "sec.inbox",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    kind: "notice",
    title: "",
    body: "",
    createdAt: 0,
  }),
});

/**
 * One open question in the active list (`sec.userQueryList`).
 *
 * There is no status field. An item is active while it sits in the list, and
 * answering or withdrawing it deletes it. `key` is the content key from
 * `userQueryKey` and is what an answer names; `id` is for display and for the
 * audit log only.
 */
export type UserQueryListItem = {
  readonly key: string;
  readonly id: string;
  readonly conversationId: string;
  readonly question: string;
  options: string[];
  readonly createdAt: number;
};

/** The active questions, session singleton (`sec.userQueryList`). */
export type UserQueryListRecord = {
  items: UserQueryListItem[];
  /** When the list last changed. 0 means it has never been written. */
  updatedAt: number;
};

/**
 * The active `ask_user` questions.
 *
 * One session-scoped document, and the only place that says which questions are
 * open. `ask_user` reads it and adds an item in one commit; the answer route
 * reads the same document, finds the item by `key`, and deletes it. Nothing
 * else holds that truth, so a restart loses no question and no memory of a
 * question has to be re-attached.
 *
 * Session scope rather than conversation scope: the key carries the
 * `conversationId`, so one read answers both "is this question already open"
 * and "which conversation does this answer belong to".
 */
export const SecUserQueryList = defineDoc<UserQueryListRecord>({
  kind: "sec.userQueryList",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ items: [], updatedAt: 0 }),
});

/** How an operator answered. This is the `mode` attribute of the answer entry. */
export type UserQueryMode = "choice" | "other";

/** Why a question left the active list. */
export type UserQueryReason = "answer" | "withdraw" | "supersede";

/** Payload of the `user_query_resolved` event. */
export type UserQueryListChange = {
  readonly id: string;
  readonly reason: UserQueryReason;
  readonly conversationId: string;
};

/** A question joined the active list. */
export const USER_QUERY_EVENT = "user_query";

/**
 * A question left the active list. `reason` says why.
 *
 * The name is the one the wait-based design used, and it is kept even though
 * withdrawal and supersession emit it now: renaming a stream event would move
 * the server, the client, and the stream's control-event list for no gain.
 */
export const USER_QUERY_RESOLVED_EVENT = "user_query_resolved";

/**
 * The content key of one question.
 *
 * sha256 over the conversation id, the normalized question, and the options
 * joined by NUL. The conversation id is part of the key, so one key names one
 * question in one conversation and a lookup by key alone cannot reach another
 * conversation's question. A question and its options also name the same key on
 * a retry, which is what stops the same question from being asked twice.
 *
 * Normalization is trim plus runs of whitespace collapsed to one space. A model
 * does not repeat its sentence exactly, and the caller names the question with
 * no other identifier of its own.
 */
export function userQueryKey(conversationId: string, question: string, options: readonly string[]): string {
  const normalized = question.trim().replace(/\s+/g, " ");
  const text = `${conversationId}\u0000${normalized}\u0000${options.join("\u0000")}`;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Lifecycle of one background call.
 *
 * `unused` is the value a document has when nothing but a read has touched it.
 * Duplicate detection asks for that value rather than for the document's
 * existence: reading a family member that is absent yields the seed, so
 * "reserved" is a fact about the row's state, and it is the same fact whether or
 * not a read persisted anything.
 */
export type AsyncCallStatus = "unused" | "running" | "done" | "failed" | "interrupted" | "cancelled";

/** One background call (`sec.asyncCall`), keyed by its title within a conversation. */
export type AsyncCallRecord = {
  readonly title: string;
  readonly conversationId: string;
  readonly tool: string;
  readonly args?: JsonObject;
  status: AsyncCallStatus;
  /** The durable task that runs the call. Absent until the reservation commits. */
  readonly taskId?: string;
  readonly createdAt: number;
  settledAt?: number;
  /** When the result reached the conversation. Absent means it still has to. */
  deliveredAt?: number;
  /** Redacted, bounded progress text. */
  progress?: string;
  readonly resultBytes?: number;
  /** Why it failed, when it did. */
  error?: string;
}

/**
 * Background calls, one document per call, conversation-scoped and keyed by
 * title. The title is therefore unique within a conversation by construction.
 */
export const SecAsyncCall = defineDocFamily<AsyncCallRecord, string>({
  kind: "sec.asyncCall",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "current",
  family: true,
  initial: (title) => ({
    title,
    conversationId: "",
    tool: "",
    status: "unused",
    createdAt: 0,
  }),
});

/** Self-edit operation log, conversation-scoped and rewindable. */
export const SecSelfEdit = defineDocFamily<SelfEditRecord, string>({
  kind: "sec.selfEdit",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "rewindable",
  fork: "asOf",
  family: true,
  initial: (id) => ({
    id,
    title: "",
    kind: "runtime-extension",
    files: [],
    restartRequired: false,
    createdAt: 0,
    updatedAt: 0,
  }),
});

/** Core-candidate review queue, session-scoped. */
export const SecCandidate = defineDocFamily<CandidateRecord, string>({
  kind: "sec.candidate",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    title: "",
    summary: "",
    origin: "core-edit",
    files: [],
    status: "proposed",
    createdAt: 0,
    updatedAt: 0,
  }),
});

/** Which surface an approval was pressed on: `/report/<slug>`, or the chat's report panel. */
export type ReportApprovalVia = "viewer" | "panel";

/**
 * What kind of report this is.
 *
 * A plan asks the user to approve work that has not started, and the viewer shows
 * it with the Approve button. A result report tells the user about work that
 * already ran, and the viewer shows it with Done and Feedback from the start.
 * A briefing report carries the morning briefing: the root writes it, it asks for
 * no approval, so the viewer shows Feedback alone, and it is listed at the top.
 * A record written before the field existed has no kind, and reads as `plan`, so
 * no document needs a migration.
 */
export type ReportKind = "plan" | "result" | "briefing";

/**
 * One approval of one report revision.
 *
 * The operator confirmed that *this* revision, unchanged, may be carried out, so
 * the record repeats the revision's hash: it says what was approved rather than
 * relying on whoever reads it to look the hash up.
 */
export type ReportApproval = {
  readonly at: number;
  readonly via: ReportApprovalVia;
  readonly sha256: string;
  /**
   * Set when the user pressed Done rather than Approve. A result report is
   * approved with Done, and this is what tells the two presses apart on the same
   * record. Absent on a press of Approve, including an approval written before
   * Done existed.
   */
  readonly button?: "done";
  /**
   * The text the user wrote with Done, when they wrote one. It is a request for
   * follow-up work, kept beside the approval so the record holds what the user
   * asked for as well as what they confirmed.
   */
  readonly text?: string;
};

/** One revision of a report body (`sec.report.versions`). */
export type ReportVersion = {
  readonly n: number;
  readonly at: number;
  readonly note?: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * The operator's approval of this revision, once they press the button.
   *
   * Optional, and `SecReport` deliberately stays at version 1: an older document
   * simply lacks the key, whereas raising the version would make a rollback
   * unable to read a report at all (see the note on `SecJob`). The approval sits
   * inside the revision it is about, and a revision is never overwritten, so an
   * approval cannot come loose from the text that was approved. A new revision
   * carries no approval, which is what retires the previous button.
   */
  readonly approval?: ReportApproval;
};

/** One note left on a report, from the viewer or from the agent. */
export type ReportFeedback = {
  readonly id: string;
  readonly at: number;
  readonly body: string;
  /** The revision the note is about, when it is about one. */
  readonly version?: number;
  readonly from: "operator" | "agent";
};

/**
 * One report: a long document owned by a job, with an append-only revision
 * history. The bodies themselves live on disk under `state/reports/<id>/v<n>.md`;
 * this record is the index. A revision is never overwritten, which is the whole
 * reason the diff is possible.
 */
export type ReportRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly name: string;
  readonly title: string;
  /**
   * `plan`, `result` or `briefing`, or absent for a report written before the
   * field existed, which reads as `plan`. The kind is not derived from anything:
   * the author of the draft names it, and a revision inherits the kind of its
   * report. Optional, and `SecReport` stays at version 1 for the reason
   * `pendingAt` gives.
   */
  readonly kind?: ReportKind;
  versions: ReportVersion[];
  feedback: ReportFeedback[];
  /**
   * When this report was set aside as `pending`, or absent when it never was.
   * `pending` means the report is not waiting on an answer right now. An approval
   * sets the key in the same commit that records the approval, so an approved
   * report lands here without a second write, and `reports_set_pending` sets or
   * clears the key by hand.
   *
   * This is the one thing about a report's standing that is stored rather than
   * derived, and it is stored because it is not a fact about anything else: the
   * day a report finishes is the day its job finishes, but "do not ask me about
   * this yet" is a decision only the operator or the agent can make. Everything
   * the job decides stays derived (see `ReportStore`); this key never overrides
   * the job, so it cannot make a finished report look open.
   *
   * Optional, and `SecReport` stays at version 1: an older document simply lacks
   * the key, unlike a version bump, which would make a rollback unable to read a
   * report at all.
   */
  pendingAt?: number;
  /**
   * When the message form of an answer was written, or absent when none was.
   *
   * The other form of the answer, a new revision, needs no key: it is a version
   * with its own time. A message leaves the revisions alone, so without this key
   * a report answered that way would be judged by the note it answered again the
   * next time it is set aside. `awaitingAnswer` reads both forms.
   *
   * Optional, and `SecReport` stays at version 1 for the reason `pendingAt`
   * gives: an older document simply lacks the key, so no migration is needed.
   */
  answeredAt?: number;
  /**
   * When this report left the live store on its own, rather than with its job.
   *
   * A briefing report is archived when a newer briefing replaces it, while the
   * job of its routine is still live. Nothing about the job then says the report
   * is archived, so the fact is stored on the record. `reportStanding` reads it
   * before it reads the job, and an archived report still resolves by id.
   *
   * Optional, and `SecReport` stays at version 1 for the reason `pendingAt` gives.
   */
  archivedAt?: number;
  readonly createdAt: number;
  updatedAt: number;
};

/** Reports, one document per report, session-scoped. */
export const SecReport = defineDocFamily<ReportRecord, string>({
  kind: "sec.report",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    jobId: "",
    name: "",
    title: "",
    versions: [],
    feedback: [],
    createdAt: 0,
    updatedAt: 0,
  }),
});

/** Which way a lesson entered the store. */
export type LessonCategory = "user_correction" | "self_found" | "runtime_observed";

/** Where a lesson stands in the promotion flow. */
export type LessonStatus = "proposed" | "open" | "promoted" | "dormant" | "closed";

/** How much it costs to repeat the mistake a lesson describes. */
export type LessonSeverity = "high" | "normal" | "low";

/** Which route a lesson should take to become a rule. */
export type LessonPromotionTarget = "prompt" | "memory" | "code" | "ops" | "undecided";

/** Who recorded a lesson: the agent itself, a scan, or the one-time import. */
export type LessonSource = "agent" | "scan" | "seed";

/** What kind of conversation recorded a lesson. `scheduled` is a cron run. */
export type LessonOriginKind = "root" | "subagent" | "schedule";

/**
 * How often a lesson has been met again, and where.
 *
 * `seenIn` holds job or conversation ids and is capped when it is written; it is
 * a sample of where the lesson recurred, not a complete ledger.
 */
export type LessonRecurrence = {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  seenIn: string[];
};

/**
 * Identifiers the lesson points at. Identifiers only: the store must not become
 * a second copy of a conversation, which is also why `filePaths` is capped.
 */
export type LessonEvidence = {
  readonly jobId?: string;
  readonly conversationId?: string;
  readonly entryId?: string;
  readonly reportId?: string;
  readonly filePaths?: string[];
};

/** One note a person or an agent added after the lesson was recorded. */
export type LessonNote = {
  readonly at: number;
  readonly by: string;
  text: string;
};

/** Which agent recorded a lesson. */
export type LessonOrigin = {
  readonly conversationId: string;
  readonly agentName: string;
  readonly kind: LessonOriginKind;
};

/**
 * One lesson (`sec.lesson`): something an agent learned, kept so it is not
 * relearned.
 *
 * `fingerprint` is the sha256 of the normalized statement and is what makes a
 * repeated lesson a recurrence rather than a second row. `duplicateOf` points at
 * a neighbour that was similar but not identical, so a report can show merge
 * candidates without deciding for the agent. `promotionRef` is the evidence that
 * a rule now exists because of this lesson: a file path, a commit hash, or a
 * report slug.
 */
export type LessonRecord = {
  readonly id: string;
  readonly statement: string;
  readonly category: LessonCategory;
  status: LessonStatus;
  readonly severity: LessonSeverity;
  readonly fingerprint: string;
  duplicateOf?: string;
  recurrence: LessonRecurrence;
  readonly evidence: LessonEvidence;
  readonly origin: LessonOrigin;
  readonly source: LessonSource;
  promotionTarget: LessonPromotionTarget;
  promotionRef?: string;
  notes: LessonNote[];
  tags: string[];
  readonly createdAt: number;
  updatedAt: number;
};

/**
 * Lessons, one document per lesson, session-scoped.
 *
 * Session scope and not a conversation scope: a lesson outlives the
 * conversation that produced it, and the whole point is that every agent can
 * read every other agent's lessons. No sweeper touches this family, so a row
 * stays until somebody retires it.
 */
export const SecLesson = defineDocFamily<LessonRecord, string>({
  kind: "sec.lesson",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    statement: "",
    category: "self_found",
    status: "open",
    severity: "normal",
    fingerprint: "",
    recurrence: { count: 0, firstSeenAt: 0, lastSeenAt: 0, seenIn: [] },
    evidence: {},
    origin: { conversationId: "", agentName: "", kind: "subagent" },
    source: "agent",
    promotionTarget: "undecided",
    notes: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }),
});

/**
 * How many lessons the store holds, by status (`sec.lessonCount`).
 *
 * A counter rather than a query: the prompt section that shows the counts
 * renders on every request, and it may not walk the family at render time. So
 * the section reads this one document instead.
 *
 * The document is written in the same commit as the lesson row it counts, so the
 * store's own write paths cannot leave the two disagreeing. `updatedAt` is 0
 * while the document has never been written, which is the only honest way to say
 * "nobody has counted yet": an empty store and an uncounted store hold the same
 * numbers.
 */
export type LessonCountRecord = {
  /** Lessons stored, which is every row whose `createdAt` is set. */
  total: number;
  byStatus: Record<LessonStatus, number>;
  /** When the counter was last changed. 0 means it has never been written. */
  updatedAt: number;
};

/** Lesson counts, one status per field, session singleton. */
export const SecLessonCount = defineDoc<LessonCountRecord>({
  kind: "sec.lessonCount",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({
    total: 0,
    byStatus: { proposed: 0, open: 0, promoted: 0, dormant: 0, closed: 0 },
    updatedAt: 0,
  }),
});

/**
 * Ledger of one-shot data migrations already applied to this store.

 * Separate from `state/VERSION`, which records the *storage backend's* schema
 * version and is owned by the runtime, not by pi-sec's own documents.
 */
export type MigrationRecord = {
  readonly applied: Record<string, number>;
};

/** Applied-migration ledger, session singleton. */
export const SecMigration = defineDoc<MigrationRecord>({
  kind: "sec.migration",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ applied: {} }),
});

/** Agent-adjustable non-secret preferences, session singleton. */
export const SecSettings = defineDoc<SecPreferences>({
  kind: "sec.settings",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({}),
});

/**
 * Where every connection to one remote machine stands (`sec.remoteMachine`).
 *
 * The record is keyed by the machine's id, which is what the config names and
 * what the pinned host key is looked up by, so a record outlives an address
 * change. A machine removed from the config keeps its record and is not shown:
 * adding it back finds the level and the block it had.
 *
 * What is *not* here: the address, the port, the users and the key file. Those
 * are read from the config on use, so a config reload reaches a running daemon
 * without a write here. The record holds only what this install decided and what
 * it measured, which a config reload cannot say.
 */
export type RemoteMachineUserRecord = {
  /** `reachable`, `unreachable`, `not-checked` or `unknown`; see the wire type. */
  readonly state: string;
  /** When `state` was last written. 0 while nothing has been checked. */
  readonly since: number;
  /** The last line of ssh's error, for `unreachable`. */
  readonly error?: string;
};

/**
 * A stricter level that waits for the runs that do not fit it to stop.
 *
 * `level` is the level the user chose and which is already stored; `runs` is what
 * was found when the wait began, so the panel can say how many are left without a
 * scan, and `deadline` is when the core stops whatever is still there.
 */
export type RemoteMachinePendingRecord = {
  /** `off` or `restricted`: a tightening never waits. */
  readonly level: string;
  /** When the wait started, in epoch milliseconds. */
  readonly since: number;
  /** When the core stops what is left, in epoch milliseconds. */
  readonly deadline: number;
  /** How many runs still do not fit. It falls as they end or are stopped. */
  readonly runs: number;
};

/** Why every connection to one machine is stopped, and what was true when it was. */
export type RemoteMachineBlockRecord = {
  /** `host-key-mismatch` or `machine-id-mismatch`. */
  readonly reason: string;
  readonly at: number;
  /** The ssh line, or the two values that disagreed. Shown as a tooltip. */
  readonly detail: string;
  /**
   * The pinned key file's content and this machine's config entry, digested
   * together, as they were when the block was written.
   *
   * A block ends when this digest stops matching: the operator pinned a new key,
   * or changed this machine's configuration. Both are the operator's own act, and
   * both are what the notice asks for, so the block needs no button and can never
   * re-alert on a timer.
   */
  readonly watch: string;
};

/**
 * One machine that stopped answering while the user did not switch it off.
 *
 * The record exists only while the machine is in an outage, and it holds the one
 * fact the watch needs: when the core first saw the machine down. The start is here
 * rather than in a user's own `since`, because a user state's `since` moves whenever
 * the failure text changes (`src/remote/machines.ts`), so it cannot measure an hour.
 * Nothing else is kept, because nothing asks and nothing waits for an answer: when
 * the threshold passes, the core makes the level `off` and drops the record.
 *
 * A record written by an earlier version can still carry the two fields of the
 * question this feature used to send. No reader looks at them, so no migration is
 * needed, and the record goes at the next end of an outage.
 */
export type RemoteMachineOutageRecord = {
  /** When the core first saw the machine down, in epoch milliseconds. */
  readonly since: number;
};

export type RemoteMachineRecord = {
  readonly id: string;
  /** `off`, `restricted` or `on`. A machine nobody has set is `off`. */
  level: string;
  /** When `level` was last changed. 0 while nobody changed it. */
  levelChangedAt: number;
  /**
   * How many times the level was changed. It numbers the notice a loosening
   * sends, so the same change cannot be announced twice.
   */
  levelSequence: number;
  /**
   * A stricter level that is being applied, or null.
   *
   * A tightening is stored at once and the runs that no longer fit it are stopped
   * after a deadline. That wait is what this field holds, so the
   * panel can show a slider colour and a line while it goes on, and so a daemon
   * restart in the middle of one finishes the job instead of forgetting it.
   */
  pending: RemoteMachinePendingRecord | null;
  /** One entry per user the config names, keyed by the ssh user name. */
  users: Record<string, RemoteMachineUserRecord>;
  /**
   * The `/etc/machine-id` first read over a connection with a pinned host key.
   * Absent until the first successful heartbeat.
   */
  machineId?: string;
  /** Why connections are stopped, or absent while they are not. */
  block?: RemoteMachineBlockRecord;
  /**
   * The outage the machine is in, or absent while it answers.
   *
   * It is dropped when a user answers, when the level becomes `off`, and when a
   * block stops the machine, so its presence is the whole answer to "is this
   * machine in an outage". The record keeps its version number: an optional field
   * needs no migration, as the wait of a tightening needed none.
   */
  outage?: RemoteMachineOutageRecord;
  readonly createdAt: number;
  updatedAt: number;
};

/** Per-machine level, connection state and block, session-scoped and keyed by machine id. */
export const SecRemoteMachine = defineDocFamily<RemoteMachineRecord, string>({
  kind: "sec.remoteMachine",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    level: "off",
    levelChangedAt: 0,
    levelSequence: 0,
    pending: null,
    users: {},
    createdAt: 0,
    updatedAt: 0,
  }),
});

/**
 * One detached run (`sec.remoteRun`), keyed by its run id.
 *
 * This is the record that makes a run outlive the daemon. The remote directory is
 * the run; this is what this install remembers about it, so a check after a restart
 * knows which machine and user to ask about, which conversation to answer, and when
 * the next check is due.
 *
 * `lastNotified` is the judgment the conversation was told most recently, and
 * `lastState` is the judgement most recently read. The two differ while a change is
 * news, which is the whole rule for a check that is not one of the scheduled ones
 */
export type RemoteRunRecord = {
  readonly id: string;
  readonly machine: string;
  readonly user: string;
  /** The conversation that started the run, or "" when the call named none. */
  readonly conversationId: string;
  readonly toolCallId: string;
  /** The level the run started at: it decides whether a new level still fits it. */
  readonly level: string;
  readonly startedAt: number;
  /** The process number the runner recorded. */
  readonly pid: number;
  /** The process start time the runner recorded, as text: it is compared, never computed on. */
  readonly tick: string;
  /** When the next scheduled check runs, in epoch milliseconds. */
  readonly dueAt: number;
  /** The judgment most recently delivered, or "". */
  readonly lastNotified: string;
  /** The judgment most recently read. */
  readonly lastState: string;
  readonly bytes: number;
  /** The exit status, or -1 while there is none. */
  readonly exitCode: number;
  readonly settled: boolean;
  readonly settledAt: number;
  /** How many messages about this run were sent: it numbers the request ids. */
  readonly notices: number;
  readonly updatedAt: number;
};

/** Per-run record, session-scoped and keyed by run id. */
export const SecRemoteRun = defineDocFamily<RemoteRunRecord, string>({
  kind: "sec.remoteRun",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    machine: "",
    user: "",
    conversationId: "",
    toolCallId: "",
    level: "off",
    startedAt: 0,
    pid: 0,
    tick: "",
    dueAt: 0,
    lastNotified: "",
    lastState: "running",
    bytes: 0,
    exitCode: -1,
    settled: false,
    settledAt: 0,
    notices: 0,
    updatedAt: 0,
  }),
});

/**
 * Stored kind strings, for the readers that must scan a family by kind.
 *
 * A document token carries the definition, not a readable kind, and
 * `scanDocuments` takes the persisted string. Spelling it out at each scan site
 * would put the protocol in two places.
 */
export const DOC_KINDS = {
  lesson: "sec.lesson",
  agent: "sec.agent",
  agentChild: "sec.agentChild",
  agentHub: "sec.agentHub",
  message: "sec.message",
  reportDraft: "sec.reportDraft",
  archivedConversation: "sec.archivedConversation",
  asyncCall: "sec.asyncCall",
  remoteMachine: "sec.remoteMachine",
  usageHold: "sec.usageHold",
  usageProbe: "sec.usageProbe",
  remoteRun: "sec.remoteRun",
} as const;

/**
 * What kind of conversation an agent record describes.
 *
 * `scheduled` is a cron run: it has no parent and is never counted against the
 * subagent limit, but recording it is what lets one lookup answer "what is this
 * conversation?" for the tool gates and the prompt sections alike.
 *
 * `focused` is a chat the user opened from the web page: a sub-session of the
 * root that reads and answers, and asks the root for anything that changes the
 * system. It holds a subagent slot while it is open and gives it back when the
 * root archives or deletes it. Its record outlives an archive on purpose, because
 * the kind has to stay answerable after the chat stops.
 */
export type AgentKind = "root" | "subagent" | "scheduled" | "focused";

export type AgentStatus =
  | "starting"
  | "running"
  | "waiting"
  // Stopped by a provider's usage limit (HTTP 429) and waiting for that provider
  // to accept a request again. The `usage-freeze` extension writes it, and the
  // hold document beside it says which provider and which model. It is not
  // `running`, so the stall watch, the boot repair and the idle notice all pass
  // it over, and it is not `stopped`, so nothing retires the record: the agent
  // still holds its slot and its work is still owed.
  | "held"
  | "stopped"
  | "failed"
  | "deleted";

/**
 * One agent (`sec.agent`), keyed by its own conversation id.
 *
 * This is the only place an agent's status is written. The name index beside it
 * (`sec.agentChild`) is immutable, so the two cannot disagree about anything
 * that changes.
 *
 * `stopped` and `failed` are transient by design: the record is retired in the
 * same commit that writes one, so a finished agent cannot keep holding a slot
 * because somebody forgot to clean it up.
 */
export type AgentRecord = {
  readonly conversationId: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly parentConversationId?: string;
  /** The parent's own display name, so a child can say who told it to work. */
  readonly parentName?: string;
  readonly vmodel: string;
  roles: string[];
  status: AgentStatus;
  /** The job this agent was handed. The handover moves the job's owner to this agent. */
  readonly jobId?: string;
  /**
   * The job this agent works for, without a handover.
   *
   * It is a link and nothing else: the job keeps its owner, and the only reader
   * is the derived "working now" list, which joins both fields. It is written once,
   * in the creating commit, and never changes.
   */
  readonly forJobId?: string;
  /** The last `await_orders` note, shown in list output. */
  lastNote?: string;
  readonly createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** Why it stopped or failed. */
  note?: string;
};

/** Agent identity and status, one document per conversation, session-scoped. */
export const SecAgent = defineDocFamily<AgentRecord, string>({
  kind: "sec.agent",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (conversationId) => ({
    conversationId,
    kind: "subagent",
    name: conversationId,
    vmodel: "",
    roles: [],
    status: "starting",
    createdAt: 0,
    updatedAt: 0,
  }),
});

/**
 * A parent's name index (`sec.agentChild`), keyed by the child's name.
 *
 * The document key is the name, so uniqueness within one parent is a property
 * of the store rather than a check somebody has to remember. Absence is read
 * from the seed value: an entry whose `conversationId` is empty has never been
 * written.
 */
export type AgentChildRecord = {
  readonly name: string;
  readonly conversationId: string;
  readonly createdAt: number;
};

export const SecAgentChild = defineDocFamily<AgentChildRecord, string>({
  kind: "sec.agentChild",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "current",
  family: true,
  initial: (name) => ({ name, conversationId: "", createdAt: 0 }),
});

/** How one target of a restart round stands. See `restart_cascade_status`. */
export type RestartVerdict = "ready" | "finished" | "unconfirmed" | "waiting";

/**
 * One child of the conversation that opened a restart round.
 *
 * Every field carries a zero value rather than being absent: the round is
 * written by a read-modify-write inside one commit, and a present field with a
 * zero saves that write from deleting keys as it goes.
 */
export type RestartTargetRecord = {
  readonly name: string;
  readonly conversationId: string;
  roles: string[];
  /** Newest entry id of the child when the round opened. The scan starts after it. */
  readonly sinceId: number;
  /** The note that asked this child to take part. Empty until it was written. */
  messageId: string;
  /** `waiting` until the first count, and the only value that is not counted. */
  verdict: RestartVerdict;
  /** `verdict !== "waiting"`. A counted target stops holding the round. */
  counted: boolean;
  reason: string;
  /** The `pi.reset` the scan found. `0` when it found none. */
  resetId: number;
  /** The `pi.system` after that reset. `0` when it found none. */
  systemId: number;
  /** When this target was last counted. `0` means it never was. */
  checkedAt: number;
};

/**
 * One restart round (`sec.restartRound`), one document per conversation.
 *
 * It is a document and not a file because opening a round is a check and a
 * write that must not be split: two `restart_cascade_start` calls in one tool
 * round read the same file, both see no open round, and the second write buries
 * the first round. A read-modify-write inside one commit is atomic, so the
 * second call sees the first one's round and is refused.
 *
 * One conversation holds at most one round, so the key is the constant
 * `"current"` and a reopen replaces it. `startedAt` is 0 until a round opens:
 * a leaf that only restarted itself through `restart_session` writes this same
 * document, and that must not block the round it opens later over its children.
 * A round is open exactly when `startedAt !== 0` and `closedAt === 0`.
 */
export type RestartRoundRecord = {
  /** The round this conversation opened. Empty means it never opened one. */
  roundId: string;
  reason: string;
  /** When the round opened. `0` means no round was ever opened here. */
  startedAt: number;
  targets: RestartTargetRecord[];
  /** This conversation's own `restart_session` request, for the re-call check. */
  selfRoundId: string;
  selfRequestedAt: number;
  selfEntryId: number;
  /** When the round closed. `0` while it is open. */
  closedAt: number;
  closeNote: string;
  /** Targets never confirmed ready at close: `waiting` or `unconfirmed`. */
  unconfirmed: string[];
  updatedAt: number;
};

/** Restart rounds, one per conversation, keyed by the constant `"current"`. */
export const SecRestartRound = defineDocFamily<RestartRoundRecord, string>({
  kind: "sec.restartRound",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "current",
  family: true,
  initial: () => ({
    roundId: "",
    reason: "",
    startedAt: 0,
    targets: [],
    selfRoundId: "",
    selfRequestedAt: 0,
    selfEntryId: 0,
    closedAt: 0,
    closeNote: "",
    unconfirmed: [],
    updatedAt: 0,
  }),
});

/**
 * One conversation held by a provider's usage limit, keyed by its conversation id.
 *
 * The `usage-freeze` extension writes it when a run ended on HTTP 429 and the
 * provider the request went to is a real one. It is a document of its own rather
 * than fields on `sec.agent` so that a rollback to a build without this feature
 * leaves the agent records in a shape that build can read: an old binary reads
 * `held` as a status it does not know, and knows nothing of this document, which
 * is a smaller fault than fields it would have to keep in step.
 *
 * `status` says what the record means instead of absence doing it. `retrying`
 * is written for the run this record asked for: a run of its own that ends on
 * 429 is a new hold, and the older record is replaced by it.
 */
export type UsageHoldStatus = "held" | "retrying";

export type UsageHoldRecord = {
  readonly conversationId: string;
  /** The provider that answered HTTP 429. A real provider, never a virtual one. */
  readonly provider: string;
  /** The model of the request that was refused. The probe asks with it. */
  readonly model: string;
  /** The submission the refused run settled, so the hold names what failed. */
  readonly submissionId: string;
  status: UsageHoldStatus;
  /** When the provider first refused this conversation. */
  readonly heldAt: number;
  /** How many runs this hold has asked for. */
  retries: number;
  /** When the last of those started. `0` before the first one. */
  lastRetryAt: number;
  /**
   * The generation task the newest retry started. Empty while held.
   *
   * A retry creates no submission, so this task and its terminal outcome are the
   * only record of what the retried request came to.
   */
  retryTaskId: string;
  updatedAt: number;
};

/** Holds, one document per held conversation, keyed by the conversation id. */
export const SecUsageHold = defineDocFamily<UsageHoldRecord, string>({
  kind: "sec.usageHold",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (conversationId) => ({
    conversationId,
    provider: "",
    model: "",
    submissionId: "",
    status: "held",
    heldAt: 0,
    retries: 0,
    lastRetryAt: 0,
    retryTaskId: "",
    updatedAt: 0,
  }),
});

/**
 * One provider's probe, keyed by the provider id.
 *
 * The probe is a model request of its own, outside every conversation, and the
 * interval between two of them is ten minutes. That interval has to survive a
 * daemon restart, which is why this record is a document and not a value in
 * memory: a process that restarted twice in a minute would otherwise ask the
 * provider twice, and a provider that is refusing would be asked at the speed of
 * the restarts.
 *
 * `lastProbeAt` and `lastResult` describe the newest probe. `firstHeldAt` is when
 * this provider first refused any conversation, so a banner can say how long the
 * limit has lasted; it is cleared with the record when no held conversation is
 * left.
 */
export type UsageProbeRecord = {
  readonly provider: string;
  /** When the newest probe went out. */
  lastProbeAt: number;
  /** `ok` when it was answered, `rate_limited` for a 429, `failed` for anything else. */
  lastResult: UsageProbeResult;
  /** Why the last probe was not answered, when it was not. Never a provider's own body. */
  lastReason: string;
  /** The model the last probe asked with, so a banner can name it. */
  lastModel: string;
  /** When this provider first refused a conversation of this session. */
  firstHeldAt: number;
  updatedAt: number;
};

export type UsageProbeResult = "none" | "ok" | "rate_limited" | "failed";

/** Probes, one document per provider, keyed by the provider id. */
export const SecUsageProbe = defineDocFamily<UsageProbeRecord, string>({
  kind: "sec.usageProbe",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (provider) => ({
    provider,
    lastProbeAt: 0,
    lastResult: "none",
    lastReason: "",
    lastModel: "",
    firstHeldAt: 0,
    updatedAt: 0,
  }),
});

/** Counter the global subagent limit is checked against. */
export type AgentHubRecord = {
  live: number;
};

/**
 * The live-subagent counter, session singleton.
 *
 * It exists so the limit check can run inside the creating commit. A check made
 * before the commit cannot see a parallel spawn in the same tool round, and the
 * two of them would both fit through a limit with one slot left.
 */
export const SecAgentHub = defineDoc<AgentHubRecord>({
  kind: "sec.agentHub",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ live: 0 }),
});

export type MessageKind = "note" | "request" | "reply" | "order";
export type MessageStatus = "pending" | "claimed" | "answered" | "cancelled";

/** Who sent or receives a message, as the tag renders it. */
export type MessagePeer = {
  readonly conversationId: string;
  readonly name: string;
  readonly agentKind: string;
};

/**
 * One inter-agent message (`sec.message`), keyed by a ULID and stored in the
 * receiver's conversation scope.
 *
 * Storing it with the receiver keeps a lookup to one scope. `status` is the
 * whole delivery decision: every consumer claims the row in a commit before it
 * acts, so exactly one of them can deliver it.
 */
export type MessageRecord = {
  readonly id: string;
  readonly from: MessagePeer;
  readonly to: MessagePeer;
  readonly kind: MessageKind;
  readonly body: string;
  readonly bytes: number;
  /** The request this answers, for `reply`. */
  readonly inReplyTo?: string;
  /** Short token the model echoes back with `send_reply`. */
  readonly replyToken?: string;
  status: MessageStatus;
  claimedBy?: string;
  claimedAt?: number;
  deliveredAt?: number;
  answeredAt?: number;
  readonly createdAt: number;
};

export const SecMessage = defineDocFamily<MessageRecord, string>({
  kind: "sec.message",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "current",
  family: true,
  initial: (id) => ({
    id,
    from: { conversationId: "", name: "", agentKind: "subagent" },
    to: { conversationId: "", name: "", agentKind: "subagent" },
    kind: "note",
    body: "",
    bytes: 0,
    status: "pending",
    createdAt: 0,
  }),
});

export type ReportDraftStatus = "pending" | "accepted" | "rejected" | "dropped";

/**
 * One draft report (`sec.reportDraft`), session-scoped.
 *
 * A draft is a file plus this index row. It is not a report: it has no
 * revisions, the operator is never told about it, and it is deleted the moment
 * it is published or refused.
 *
 * `jobId` is the job the draft belongs to, and it is what decides the draft's
 * life. `agentConversationId` only records who wrote it: a draft with a job is
 * open work of that job, so it is dropped when the job ends, and it survives the
 * deletion of its author. A row written before this field existed has no job, and
 * keeps the older lifetime — it is abandoned with its author and may be published
 * into any job.
 */
export type ReportDraftRecord = {
  readonly id: string;
  readonly agentConversationId: string;
  /**
   * The kind the author gave the draft: `result` for a report about work that
   * ran. Absent means the draft is a plan, and a publication that names no other
   * kind publishes it as one.
   */
  readonly kind?: ReportKind;
  /** The job this draft belongs to. Absent on a row written before the field. */
  readonly jobId?: string;
  readonly title: string;
  /**
   * What this draft is, in the words of whoever wrote it. Absent on a row written
   * before the field, and such a row reads as a draft with no note.
   */
  readonly note?: string;
  readonly path: string;
  readonly bytes: number;
  readonly createdAt: number;
  status: ReportDraftStatus;
  updatedAt: number;
};

export const SecReportDraft = defineDocFamily<ReportDraftRecord, string>({
  kind: "sec.reportDraft",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => ({
    id,
    agentConversationId: "",
    title: "",
    path: "",
    bytes: 0,
    createdAt: 0,
    status: "pending",
    updatedAt: 0,
  }),
});
