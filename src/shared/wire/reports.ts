/**
 * What travels between the report routes and the report page.
 *
 * The server builds these shapes in `src/server/routes/reports.ts` (`view()`,
 * `GET /api/reports`, `GET /api/reports/by-name/:name`, `GET /api/reports/:id/diff`)
 * and the stored record is `ReportRecord` in `src/documents.ts`. Nothing here is
 * imported from the server: these are the fields the page reads, written down
 * once so the page and its tests agree on them.
 *
 * The standing of a report is one word the server derives from the job and the
 * set-aside flag (`reportStanding` in `src/reports/store.ts`). The older flags
 * travel beside it, because a page talking to an older daemon still has to draw
 * something true, and the page reads the word first.
 *
 * The diff shapes repeat `src/reports/diff.ts` rather than importing it: that
 * module is server code with algorithms in it, and the page only needs the
 * answer's shape.
 */

/** Where a report stands, as one word. See `reportStanding`. */
export type ReportStanding = "active" | "result" | "briefing" | "pending" | "inactive" | "archived";

/**
 * What kind of report this is: a plan, a report about work that already ran, or
 * the morning briefing. The page reads a kind it does not know as a plan.
 */
export type ReportKind = "plan" | "result" | "briefing";

/** Which surface an approval was pressed on. The server records it and refuses any other value. */
export type ReportApprovalVia = "viewer" | "panel";

/** One approval of one revision: what was approved, when, and from where. */
export interface ReportApproval {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly via: ReportApprovalVia;
  /** The hash of the revision text this approval is about. */
  readonly sha256: string;
  /** `done` when the user pressed Done rather than Approve. */
  readonly button?: "done";
  /** The text the user wrote with Done, which asks for follow-up work. */
  readonly text?: string;
}

/** One revision of a report body. The body itself is read from its own route. */
export interface ReportRevision {
  readonly n: number;
  /** Epoch milliseconds. */
  readonly at: number;
  /** The one line the author wrote about this revision. */
  readonly note?: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Present once this revision was approved; absent means no approval to show. */
  readonly approval?: ReportApproval;
}

/** One note left on a report, from the viewer, the panel, or the agent. */
export interface ReportFeedbackEntry {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly body: string;
  /** The revision the note is about, when it is about one. */
  readonly version?: number;
  readonly from: "operator" | "agent";
}

/** The job a report belongs to, as the page shows it. */
export interface ReportJobRef {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * One report as every report route answers it.
 *
 * `active` is the job being live, which is what an approval asks for: a revision
 * can be confirmed while its job is open. It says nothing about `pending`.
 */
export interface ReportSummary {
  readonly id: string;
  readonly jobId: string;
  /** The slug in `/report/<slug>`. */
  readonly name: string;
  readonly title: string;
  /**
   * `plan`, `result` or `briefing`, or absent on a report written before the field
   * existed, which reads as `plan`. The page reads the absent value as a plan too,
   * so a page talking to an older daemon draws the report it always drew.
   */
  readonly kind?: ReportKind;
  readonly versions: readonly ReportRevision[];
  readonly feedback: readonly ReportFeedbackEntry[];
  /** Set aside: not finished, and not waiting on an answer right now. */
  readonly pendingAt?: number;
  readonly answeredAt?: number;
  /** Set when the report left the live store on its own, as an older briefing does. */
  readonly archivedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly active: boolean;
  readonly archived: boolean;
  readonly status: ReportStanding;
  readonly job: ReportJobRef | null;
}

/** What `GET /api/reports/by-name/:name` adds: the archived name, when there is one. */
export interface ReportDetail extends ReportSummary {
  readonly archivedName?: string;
}

/** What `GET /api/reports?includeArchived=true` answers. */
export interface ReportListAnswer {
  readonly reports?: readonly ReportSummary[];
  readonly archived?: readonly ReportSummary[];
}

/** The three kinds of line a diff is made of. */
export type DiffLineKind = "same" | "add" | "remove";

/** One line of a hunk, with its number on each side it exists. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 1-based line number in the earlier revision; absent for an addition. */
  readonly fromLine?: number;
  /** 1-based line number in the later revision; absent for a removal. */
  readonly toLine?: number;
  /**
   * The line cut into pieces, each marked as changed or not. Present only when
   * this line was paired with one on the other side of the hunk.
   */
  readonly segments?: readonly { readonly text: string; readonly changed: boolean }[];
}

/** One stretch of the diff that has something in it, with the lines around it. */
export interface DiffHunk {
  readonly fromStart: number;
  readonly fromCount: number;
  readonly toStart: number;
  readonly toCount: number;
  readonly lines: readonly DiffLine[];
}

/** What `GET /api/reports/:id/diff?from=&to=` answers. */
export interface LineDiff {
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  readonly identical: boolean;
  /** True when the pair was too large to align and is reported as a full replacement. */
  readonly truncated: boolean;
  /** True when the word pass ran out of budget and left the remaining pairs line level. */
  readonly wordDiffTruncated?: boolean;
}
