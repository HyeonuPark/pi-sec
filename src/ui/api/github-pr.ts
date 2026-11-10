/**
 * Every request the pull request dashboard makes, and the shapes its answers have.
 *
 * One file holds all of them, because the three pages and the shared parts read
 * the same payloads and a second reader of `/api/github/pr/...` would be a second
 * place to keep the shape in step. The routes and the payloads are fixed:
 * the payloads are the server's JSON with `remote` dropped and `repo`
 * (`owner/repo`) on every pull request.
 *
 * Two differences from `src/ui/api/request.ts` are deliberate.
 *
 * 1. A refusal is read in both shapes. The pi-sec routes answer the envelope
 *    `{ "error": { "code", "message" } }`, and these routes answer the original's
 *    flat `{ "error": "<message>" }` with the facts beside it (`currentMegabytes`
 *    and the other two numbers of a disk-limit refusal). A reader that knew only
 *    one shape would print `the server answered 502` for every failure of the
 *    other.
 * 2. A refusal is thrown as {@link GithubPrError}, which carries the status and
 *    the whole body, so a page can say what a disk-limit refusal measured.
 *
 * `fetch` stays in this folder, as the source-rule test requires; the pages call
 * the functions below and never a URL.
 */
import { at } from "../mount.ts";

/* ------------------------------------------------------------------ shapes */

/** One repository of the operator's config list, as every payload spells it. */
export interface GithubPrRepo {
  readonly repo: string;
}

/** A label: the GitHub name and its six hex digits, without the `#`. */
export interface GithubPrLabel {
  readonly name: string;
  readonly color: string;
}

/** One reaction count on a comment, a review or a description. */
export interface GithubPrReaction {
  readonly content: string;
  readonly count: number;
  readonly mine: boolean;
}

/** A comment, a review or a description as GitHub states it. */
export interface GithubPrComment {
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string | null;
  /** Whether GitHub lets this account edit it. An older stored copy lacks it and counts as false. */
  readonly viewerCanUpdate?: boolean;
  /** Whether this account wrote it. An older stored copy lacks it and counts as false. */
  readonly viewerDidAuthor?: boolean;
  readonly reactions: readonly GithubPrReaction[];
}

/** A review: a comment whose state is `APPROVED`, `CHANGES_REQUESTED` and so on. */
export interface GithubPrReview extends GithubPrComment {
  readonly reviewState: string;
}

/** One line of a hunk: context, added or removed. */
export interface GithubPrDiffLine {
  readonly t: "ctx" | "add" | "del";
  readonly s: string;
}

/** One hunk of a file's diff, as `git diff -U3` grouped it. */
export interface GithubPrHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly section: string;
  readonly lines: readonly GithubPrDiffLine[];
}

/** One review thread: where it sits, whether it is open, and its comments. */
export interface GithubPrThread {
  readonly id: string;
  readonly isResolved: boolean;
  /** Whether this account may resolve the thread. An older stored copy lacks it and counts as false. */
  readonly viewerCanResolve?: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly diffSide: "LEFT" | "RIGHT";
  /** `FILE` for a comment on a whole file. Absent in an older stored copy, which counts as `LINE`. */
  readonly subjectType?: "LINE" | "FILE";
  readonly diffHunk: string | null;
  readonly comments: readonly GithubPrComment[];
}

/** Whether a thread is a comment on a whole file, with no lines. */
export function isFileThread(thread: { readonly subjectType?: string }): boolean {
  return thread.subjectType === "FILE";
}

/** One CI job of the head commit. */
export interface GithubPrCheck {
  readonly name: string;
  readonly status: string;
  readonly url: string | null;
}

/**
 * One pull request of the list.
 *
 * `repo` is the repository the row came from, which is how a list of several
 * repositories says where each row lives.
 */
export interface GithubPrItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly updatedAt: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly reviewDecision: string | null;
  readonly labels: readonly GithubPrLabel[];
  readonly ciState: string | null;
  readonly repo: string;
}

/** One section of the list, in the order the server wrote it. */
export interface GithubPrSection {
  readonly key: string;
  readonly title: string;
  readonly prs: readonly GithubPrItem[];
}

/** What `GET /api/github/pr/list` answers. */
export interface GithubPrListAnswer {
  readonly viewer: string | null;
  readonly repos: readonly GithubPrRepo[];
  readonly sections: readonly GithubPrSection[];
}

/** What the Pending reviews section knows about a pull request that has a saved review. */
export interface GithubPrPendingPr {
  readonly title: string;
  readonly url: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly updatedAt: string;
}

/** One row of the Pending reviews section: a saved review, or a file that could not be read. */
export type GithubPrPendingReview =
  | {
      readonly kind: "draft";
      readonly repo: string;
      readonly number: number;
      /** False when the repository is no longer in the settings. */
      readonly configured: boolean;
      readonly comments: number;
      /** True when the overall comment is not empty. */
      readonly summary: boolean;
      readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      readonly savedAt: string;
      /** `null` when the server does not know the pull request yet. */
      readonly pr: GithubPrPendingPr | null;
    }
  | {
      readonly kind: "unreadable";
      readonly repo: string;
      readonly number: number;
      readonly file: string;
      readonly savedAt: string;
    };

/** What `GET /api/github/pr/pending` answers. */
export interface GithubPrPendingAnswer {
  readonly reviews: readonly GithubPrPendingReview[];
}

/** The body that deletes one saved review, or one file that could not be read. */
export type GithubPrDraftDeleteBody =
  | { readonly repo: string; readonly number: number; readonly savedAt: string }
  | { readonly file: string };

/** One commit of the pull request, as the Commits panel lists it. */
export interface GithubPrCommit {
  readonly oid: string;
  readonly abbreviatedOid: string;
  readonly headline: string;
  readonly author: string | null;
  readonly committedDate: string;
  readonly url: string;
}

/** What `GET /api/github/pr/<owner>/<repo>/<number>` answers. */
export interface GithubPrDetail {
  readonly repo: string;
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly author: string | null;
  /** Whether GitHub lets this account edit the description. An older stored copy lacks it. */
  readonly viewerCanUpdate?: boolean;
  /** Whether this account wrote the pull request. An older stored copy lacks it. */
  readonly viewerDidAuthor?: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly labels: readonly GithubPrLabel[];
  readonly reactions: readonly GithubPrReaction[];
  readonly comments: readonly GithubPrComment[];
  readonly reviews: readonly GithubPrReview[];
  readonly threads: readonly GithubPrThread[];
  readonly ciState: string | null;
  readonly checks: readonly GithubPrCheck[];
  /** The newest commits, oldest first. Absent in an answer an older build stored. */
  readonly commits?: readonly GithubPrCommit[];
  /** How many commits the pull request has. Absent in an older stored answer. */
  readonly totalCommits?: number;
}

/**
 * One changed file of a diff.
 *
 * `oldContent` and `newContent` are the whole file, one entry per line, so the
 * page unfolds a collapsed stretch without another request. Either is `null` when
 * the file is not there on that side or when it is too long to send, and both are
 * absent on a binary file.
 */
export interface GithubPrFile {
  readonly path: string | null;
  readonly oldPath: string | null;
  readonly status: "A" | "M" | "D" | "R";
  readonly binary: boolean;
  readonly hunks: readonly GithubPrHunk[];
  readonly additions: number;
  readonly deletions: number;
  readonly oldContent?: readonly string[] | null;
  readonly newContent?: readonly string[] | null;
}

/** What `GET /api/github/pr/<owner>/<repo>/<number>/diff` answers. */
export interface GithubPrDiffAnswer {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBase: string;
  readonly files: readonly GithubPrFile[];
}

/** The facts of one commit, as the commit diff route answers them. */
export interface GithubPrCommitFacts {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly headline: string;
  readonly body: string;
}

/**
 * What `GET /api/github/pr/<owner>/<repo>/<number>/commits/<sha>` answers: the
 * diff answer's fields, where `headSha` is the commit and `mergeBase` its first
 * parent (empty for a root commit), plus the commit's facts.
 */
export interface GithubPrCommitDiffAnswer extends GithubPrDiffAnswer {
  readonly commit: GithubPrCommitFacts;
}

/** The body of a reply: a thread reply when `threadId` is set, else a PR comment. */
export interface GithubPrReplyBody {
  readonly body: string;
  readonly threadId?: string | null;
}

/** The body of a reaction press. */
export interface GithubPrReactionBody {
  readonly subjectId: string;
  readonly content: string;
  readonly add: boolean;
}

/** One comment a review carries, anchored to a line of the diff. */
export interface GithubPrReviewComment {
  readonly body: string;
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  readonly line: number;
  readonly startLine?: number | null;
}

/** The body of a review submission. */
export interface GithubPrReviewBody {
  readonly body: string;
  readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  readonly comments: readonly GithubPrReviewComment[];
  /** The ids of the saved draft comments this review sends, so the server removes them from the draft. */
  readonly draftCommentIds?: readonly string[];
}

/** What a write answers: the original's `{"ok": true}`. */
export interface GithubPrWriteAnswer {
  readonly ok: boolean;
}

/** The body of a resolve press: the node id of the thread. */
export interface GithubPrResolveBody {
  readonly threadId: string;
}

/** What a resolve answers: `ok` and the thread's state as GitHub holds it. */
export interface GithubPrResolveAnswer extends GithubPrWriteAnswer {
  readonly thread: { readonly id: string; readonly isResolved: boolean };
}

/**
 * The body of an edit press.
 *
 * `baseBody` is the text the page drew when the reader pressed Edit, exactly as
 * the payload carried it, so the server can refuse a text that changed on GitHub
 * since. No `commentId` edits the description.
 */
export interface GithubPrEditBody {
  readonly body: string;
  readonly baseBody: string;
  readonly commentId?: string;
}

/** What an edit answers: `ok` and the text as GitHub holds it now. */
export interface GithubPrEditAnswer extends GithubPrWriteAnswer {
  readonly body: string;
}

/* ------------------------------------------------------------------ errors */

/** A refusal from the dashboard's routes, or an answer this file could not read. */
export class GithubPrError extends Error {
  /** The HTTP status, such as 502. */
  readonly status: number;
  /** The answer's body when it was JSON, so a page can read numbers beside it. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "GithubPrError";
    this.status = status;
    this.body = body;
  }
}

/** The message a refusal's body carries, in either shape this app writes. */
function refusalMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const envelope = body as { error?: unknown; detail?: unknown };
  if (typeof envelope.error === "string" && envelope.error !== "") return envelope.error;
  if (typeof envelope.error === "object" && envelope.error !== null) {
    const inner = (envelope.error as { message?: unknown }).message;
    if (typeof inner === "string" && inner !== "") return inner;
  }
  if (typeof envelope.detail === "string" && envelope.detail !== "") return envelope.detail;
  return undefined;
}

/**
 * Whether a refusal is the disk-limit one, whose body names three megabyte
 * values: what is there now, what the first fetch would take, and the limit.
 */
export function isDiskLimit(error: unknown): boolean {
  if (!(error instanceof GithubPrError) || error.status !== 409) return false;
  const body = error.body;
  if (typeof body !== "object" || body === null) return false;
  return (body as { error?: unknown }).error === "disk_limit";
}

/** The disk-limit numbers, or `null` for any other refusal. */
export function diskLimitOf(
  error: unknown,
): { readonly currentMegabytes: number; readonly estimateMegabytes: number; readonly limitMegabytes: number } | null {
  if (!(error instanceof GithubPrError) || !isDiskLimit(error)) return null;
  const body = error.body as {
    currentMegabytes?: unknown;
    estimateMegabytes?: unknown;
    limitMegabytes?: unknown;
  };
  const current = Number(body.currentMegabytes);
  const estimate = Number(body.estimateMegabytes);
  const limit = Number(body.limitMegabytes);
  if (!Number.isFinite(current) || !Number.isFinite(estimate) || !Number.isFinite(limit)) return null;
  return { currentMegabytes: current, estimateMegabytes: estimate, limitMegabytes: limit };
}

/** One request's answer, read as JSON, with a refusal thrown as {@link GithubPrError}. */
async function call<T>(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
    /** Let the request outlive the page, for a send at `pagehide`. */
    readonly keepalive?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(at(path), {
    method: options.method ?? "GET",
    body,
    headers,
    signal: options.signal,
    ...(options.keepalive === true ? { keepalive: true } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  let readable = true;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    readable = false;
  }
  if (!response.ok) {
    const message =
      (readable ? refusalMessage(parsed) : undefined) ?? `the server answered ${response.status}`;
    throw new GithubPrError(response.status, message, readable ? parsed : text);
  }
  if (!readable) throw new GithubPrError(response.status, "the answer was not JSON", text);
  return parsed as T;
}

/* ------------------------------------------------------------ route paths */

/** One path segment, encoded so it stays one segment. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The two path segments of a repository.
 *
 * A repository is spelled `owner/repo` in every payload, and its page URL carries
 * it as two segments, so this is the one place the split happens.
 */
export function repoSegments(repo: string): readonly [string, string] {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) throw new Error(`a repository is owner/repo, got ${JSON.stringify(repo)}`);
  return [segment(repo.slice(0, slash)), segment(repo.slice(slash + 1))];
}

/** The path of the list route. */
export function prListPath(): string {
  return "/api/github/pr/list";
}

/** The path of the saved reviews. */
export function prPendingPath(): string {
  return "/api/github/pr/pending";
}

/** The path that deletes a saved review. */
export function prDraftDeletePath(): string {
  return "/api/github/pr/drafts/discard";
}

/** The path of the event stream. */
export function prEventsPath(): string {
  return "/api/github/pr/events";
}

/** The path of one pull request, and of one of its suffixes (`/diff`, `/reply`). */
export function prItemPath(repo: string, number: number, suffix = ""): string {
  const [owner, name] = repoSegments(repo);
  return `/api/github/pr/${owner}/${name}/${number}${suffix}`;
}

/* ---------------------------------------------------------------- requests */

/** Read the list. `refresh` asks GitHub now, which also replaces the server's cache. */
export async function fetchPrList(
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GithubPrListAnswer> {
  const query = options.refresh === true ? "?refresh=1" : "";
  return await call<GithubPrListAnswer>(`${prListPath()}${query}`, { signal: options.signal });
}

/** Read the saved reviews. The server never asks GitHub for this. */
export async function fetchPending(options: { readonly signal?: AbortSignal } = {}): Promise<GithubPrPendingAnswer> {
  return await call<GithubPrPendingAnswer>(prPendingPath(), { signal: options.signal });
}

/** Delete one saved review, or one file that could not be read. Nothing reaches GitHub. */
export async function postDraftDelete(
  body: GithubPrDraftDeleteBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ readonly deleted: boolean }> {
  return await call<{ readonly deleted: boolean }>(prDraftDeletePath(), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/** Read one pull request: its description, conversation, threads and checks. */
export async function fetchPr(
  repo: string,
  number: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrDetail> {
  return await call<GithubPrDetail>(prItemPath(repo, number), { signal: options.signal });
}

/** Read one pull request's diff, with each changed file's whole contents. */
export async function fetchPrDiff(
  repo: string,
  number: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrDiffAnswer> {
  return await call<GithubPrDiffAnswer>(prItemPath(repo, number, "/diff"), { signal: options.signal });
}

/** Read the diff of one commit of a pull request, with each file's whole contents. */
export async function fetchCommitDiff(
  repo: string,
  number: number,
  sha: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrCommitDiffAnswer> {
  return await call<GithubPrCommitDiffAnswer>(prItemPath(repo, number, `/commits/${segment(sha)}`), {
    signal: options.signal,
  });
}

/** Reply to a review thread, or leave a comment on the pull request. */
export async function postReply(
  repo: string,
  number: number,
  body: GithubPrReplyBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrWriteAnswer> {
  return await call<GithubPrWriteAnswer>(prItemPath(repo, number, "/reply"), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/** Mark one review thread resolved. */
export async function postResolve(
  repo: string,
  number: number,
  body: GithubPrResolveBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrResolveAnswer> {
  return await call<GithubPrResolveAnswer>(prItemPath(repo, number, "/resolve"), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/** Replace the description, or one of the account's own comments. */
export async function postEdit(
  repo: string,
  number: number,
  body: GithubPrEditBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrEditAnswer> {
  return await call<GithubPrEditAnswer>(prItemPath(repo, number, "/edit"), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/** Add or remove one reaction on a comment, a review or a description. */
export async function postReaction(
  repo: string,
  number: number,
  body: GithubPrReactionBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrWriteAnswer> {
  return await call<GithubPrWriteAnswer>(prItemPath(repo, number, "/reaction"), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/** Submit a review, with the comments collected on the diff's lines. */
export async function submitReview(
  repo: string,
  number: number,
  body: GithubPrReviewBody,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GithubPrWriteAnswer> {
  return await call<GithubPrWriteAnswer>(prItemPath(repo, number, "/review"), {
    method: "POST",
    body,
    signal: options.signal,
  });
}

/* ------------------------------------------------------------ review drafts */

/** The text of the first and the last line of a comment's range, saved with it. */
export interface GithubPrDraftAnchor {
  readonly first: string;
  readonly last: string;
}

/** One comment of a saved draft. */
export interface GithubPrDraftComment {
  readonly id: string;
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  readonly line: number;
  readonly startLine: number | null;
  readonly body: string;
  readonly headSha: string;
  readonly anchor: GithubPrDraftAnchor | null;
  readonly createdAt?: string;
}

/** What the draft routes answer: the whole saved review of one pull request. */
export interface GithubPrDraft {
  readonly summary: string;
  readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  readonly comments: readonly GithubPrDraftComment[];
}

/** One change of a saved draft, as the POST route takes it. */
export type GithubPrDraftOp =
  | { readonly op: "add"; readonly comment: GithubPrDraftComment }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "set"; readonly summary?: string; readonly event?: GithubPrDraft["event"] }
  | { readonly op: "discard" };

/** Read the saved draft of one pull request. */
export async function fetchDraft(repo: string, number: number): Promise<GithubPrDraft> {
  return await call<GithubPrDraft>(prItemPath(repo, number, "/draft"));
}

/** Send one change of the saved draft, and read the whole draft after it. */
export async function postDraft(
  repo: string,
  number: number,
  change: GithubPrDraftOp,
  options: { readonly keepalive?: boolean } = {},
): Promise<GithubPrDraft> {
  return await call<GithubPrDraft>(prItemPath(repo, number, "/draft"), {
    method: "POST",
    body: change,
    ...(options.keepalive === true ? { keepalive: true } : {}),
  });
}
