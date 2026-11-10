/**
 * What the pull request dashboard keeps between page loads, and what it says
 * about the requests it has in flight.
 *
 * Three things live here, because each is a rule that a page must not re-decide:
 *
 * 1. The session store. The three pages are separate addresses, so a reader who
 *    goes from the list to a pull request and back asks for the same data twice.
 *    The last answer per key is kept in this tab, in memory and in
 *    `sessionStorage` under `github-pr:v1:`, and a page draws it before its own
 *    request answers. An answer too big for the storage quota is kept in memory
 *    only: a large diff is exactly that case, and persistence is an optimisation
 *    rather than a requirement.
 * 2. The request order. Two reads of the same thing can be in flight (the page's
 *    own read and the one an event asks for), and they may answer out of order.
 *    Only the read that started last may draw, so a slow answer cannot overwrite
 *    a newer one. {@link begin} hands out the ticket and {@link isCurrent} says
 *    whether it is still the newest.
 * 3. The comments a reader has collected on a diff's lines but not submitted.
 *    They belong to the tab, like the diff they were written on, and they survive
 *    the reload that a page load is.
 *
 * The two JSON blocks the server writes into a page are read by
 * `src/ui/github-pr/blocks.ts`, next to the parts that draw from them.
 *
 * Timers belong to this folder and to `src/ui/streams/`; this module sets none.
 */
import { signal } from "@preact/signals";
import {
  fetchPending,
  fetchPrList,
  postDraftDelete,
  type GithubPrListAnswer,
  type GithubPrPendingAnswer,
  type GithubPrPendingReview,
} from "../api/github-pr.ts";
import { readFirstList, readFirstPending } from "../github-pr/blocks.ts";

/** The prefix of every key this dashboard writes into the tab's session storage. */
export const STORE_PREFIX = "github-pr:v1:";

/* ----------------------------------------------------------- session store */

/** The keys this tab holds in memory, which is also what a failed write keeps. */
const memory = new Map<string, unknown>();

/** The storage, or `undefined` where the browser refuses one (a sandboxed frame). */
function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * The last answer stored under `key`, or `null`.
 *
 * A stored value that cannot be read back (an older build's shape, a half-written
 * entry) is a miss rather than an error: the page then draws its placeholder and
 * asks the server, which is what it would have done anyway.
 */
export function readStored<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T;
  const store = storage();
  if (store === undefined) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORE_PREFIX + key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as T;
    memory.set(key, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Keep `value` under `key` for this tab.
 *
 * The memory copy is written first and always succeeds, so a page that stores a
 * diff too large for the quota still draws it on the next navigation within this
 * tab. The storage write is what may fail, and a failure is not an error: it is
 * the oversize case the original skipped the same way.
 */
export function writeStored(key: string, value: unknown): void {
  memory.set(key, value);
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Oversized payloads just skip persistence; the memory copy is already there.
  }
}

/** Drop one stored answer. */
export function forgetStored(key: string): void {
  memory.delete(key);
  const store = storage();
  if (store === undefined) return;
  try {
    store.removeItem(STORE_PREFIX + key);
  } catch {
    // A storage that refuses a removal holds nothing this page needs.
  }
}

/** The store key of one pull request's detail answer. */
export function prStoreKey(repo: string, number: number): string {
  return `pr:${repo}:${number}`;
}

/** The store key of one pull request's diff answer. */
export function diffStoreKey(repo: string, number: number): string {
  return `diff:${repo}:${number}`;
}

/** The store key of one commit's diff answer. */
export function commitStoreKey(repo: string, sha: string): string {
  return `commit:${repo}:${sha}`;
}

/** The store key of the comments collected on one pull request's diff. */
export function pendingStoreKey(repo: string, number: number): string {
  return `pending:${repo}:${number}`;
}

/** The store key of the changes of one pull request that were not sent to the server yet. */
export function draftQueueStoreKey(repo: string, number: number): string {
  return `draftqueue:${repo}:${number}`;
}

/* ------------------------------------------------------------ request order */

/** The ticket of the newest read of each key, so an older answer can be dropped. */
const tickets = new Map<string, number>();
/** What each ticket counts from; one counter is enough for every key. */
let issued = 0;

/**
 * Take the ticket for a read of `key`.
 *
 * The value is opaque to the caller: it only ever compares its own ticket to
 * {@link isCurrent}.
 */
export function begin(key: string): number {
  issued += 1;
  tickets.set(key, issued);
  return issued;
}

/** Whether `ticket` is still the newest read of `key`. */
export function isCurrent(key: string, ticket: number): boolean {
  return tickets.get(key) === ticket;
}

/* --------------------------------------------------- comments held for a review */

/** One comment a reader wrote on a diff's line and has not submitted yet. */
export interface GithubPrPendingComment {
  /** Random, made by the browser: the server's draft names a comment by it. */
  readonly id: string;
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  readonly line: number;
  /** The first line of a range, or `null` for a single line. */
  readonly startLine: number | null;
  readonly body: string;
  /** The head commit of the diff the comment was written on, or `""` for a copy that predates it. */
  readonly headSha: string;
  /** The text of the first and the last line of the range, or `null` when the diff had no file text. */
  readonly anchor: { readonly first: string; readonly last: string } | null;
}

/** A new random id for a collected comment. */
export function newCommentId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The comments collected on the diff that is open, as a signal.
 *
 * The diff page is the only page that changes them, and it draws them on the
 * lines they were written on, so a signal is what makes a press redraw one row.
 * They are stored under the pull request's key as well, so the count survives
 * the navigation to the pull request page and back.
 */
export const pendingComments = signal<readonly GithubPrPendingComment[]>([]);

/** The keys whose comments {@link pendingComments} currently holds. */
let pendingKey: string | null = null;

/**
 * The comments of a tab copy that predates the draft on the server: they had no
 * id, so this load gave them one. The draft module sends them to the server once,
 * and only when the server has no draft.
 */
export const legacyComments: GithubPrPendingComment[] = [];

/** Read the collected comments of one pull request, and make them the open ones. */
export function loadPendingComments(repo: string, number: number): readonly GithubPrPendingComment[] {
  const key = pendingStoreKey(repo, number);
  const stored = readStored<Partial<GithubPrPendingComment>[]>(key);
  legacyComments.length = 0;
  const list = (Array.isArray(stored) ? stored : []).map((item): GithubPrPendingComment => {
    if (typeof item.id === "string" && item.id !== "") return item as GithubPrPendingComment;
    const filled = { ...item, id: newCommentId(), headSha: item.headSha ?? "", anchor: item.anchor ?? null } as GithubPrPendingComment;
    legacyComments.push(filled);
    return filled;
  });
  pendingKey = key;
  pendingComments.value = list;
  if (legacyComments.length > 0) writeStored(key, list);
  return list;
}

/** Replace the collected comments of the open pull request, and keep them. */
export function setPendingComments(list: readonly GithubPrPendingComment[]): void {
  pendingComments.value = list;
  if (pendingKey !== null) writeStored(pendingKey, list);
}

/** Add one comment to the open pull request's collection. */
export function addPendingComment(comment: GithubPrPendingComment): void {
  setPendingComments([...pendingComments.value, comment]);
}

/** Drop the comment at `index`, and answer whether it was there. */
export function removePendingComment(index: number): boolean {
  const list = pendingComments.value;
  if (index < 0 || index >= list.length) return false;
  setPendingComments([...list.slice(0, index), ...list.slice(index + 1)]);
  return true;
}

/* --------------------------------------------------------------- list page */

/**
 * The list the page draws, or `null` before anything arrived.
 *
 * The server writes the list it already held into the page
 * (`github-pr-list-first`), so the first value is that answer and the rows are
 * there with the page. A page the server had no list for starts at `null` and
 * says `Loading pull requests…` until the read answers.
 */
export const listAnswer = signal<GithubPrListAnswer | null>(null);

/** Why the last read failed, or `null` when it did not. */
export const listError = signal<string | null>(null);

/** True while a read is in flight, which is what `syncing…` says. */
export const listLoading = signal(false);

/** True while a forced refresh is in flight, which disables `⟳ Reload`. */
export const listForcing = signal(false);

/** The store key of the list, so a tab that comes back draws it before it asks. */
export const LIST_STORE_KEY = "list";

/**
 * The words of one failure.
 *
 * The server answers a refusal as `{ "error": "<message>" }`, which this
 * dashboard's request function turns into the message itself. A failure that is
 * not that (a dropped connection, a body that was not JSON) has a message of its
 * own, and a failure with no message says so rather than reading `undefined`.
 */
export function listFailureText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error ?? "");
  return text === "" ? "the request failed" : text;
}

/**
 * Draw a list answer: the sections, and no failure line.
 *
 * An answer without a `sections` list is not a list this build can draw, and a
 * page that drew it would fail on the first `map`. It is treated as a failed read
 * instead, which leaves whatever is drawn where it is and says so once.
 */
function applyList(answer: GithubPrListAnswer): boolean {
  if (!Array.isArray(answer?.sections)) {
    listError.value = "the server answered no list";
    return false;
  }
  listAnswer.value = answer;
  listError.value = null;
  writeStored(LIST_STORE_KEY, answer);
  return true;
}

/**
 * The list a previous read or a previous page load left in this tab.
 *
 * Only used when the page carries no first answer, which is a server that had no
 * list yet: a reader who reloads while the first fetch of the daemon is still
 * running then sees the list the tab already had rather than an empty page.
 */
export function drawStoredList(): boolean {
  const stored = readStored<GithubPrListAnswer>(LIST_STORE_KEY);
  if (stored === null || stored === undefined || !Array.isArray(stored.sections)) return false;
  listAnswer.value = stored;
  return true;
}

/** Draw the list the server wrote into the page, if it wrote one. */
export function drawFirstList(): boolean {
  const first = readFirstList();
  if (first === undefined) return false;
  listAnswer.value = first;
  writeStored(LIST_STORE_KEY, first);
  return true;
}

/**
 * Read the list, and draw it when this read is still the newest one.
 *
 * `refresh` asks GitHub now: the server reads GitHub, replaces its cache with the
 * answer, and announces the change to every other open page. A failure leaves the
 * rows that are drawn alone and puts one sentence in the error strip, which is
 * what the original did with a failed forced refresh.
 */
export async function loadList(options: { readonly refresh?: boolean } = {}): Promise<boolean> {
  const ticket = begin(LIST_STORE_KEY);
  listLoading.value = true;
  if (options.refresh === true) listForcing.value = true;
  try {
    const answer = await fetchPrList(options.refresh === true ? { refresh: true } : {});
    if (!isCurrent(LIST_STORE_KEY, ticket)) return false;
    return applyList(answer);
  } catch (error) {
    if (!isCurrent(LIST_STORE_KEY, ticket)) return false;
    listError.value = listFailureText(error);
    return false;
  } finally {
    if (isCurrent(LIST_STORE_KEY, ticket)) {
      listLoading.value = false;
      listForcing.value = false;
    }
  }
}

/* ---------------------------------------------------------- pending reviews */

/**
 * The saved reviews the Pending reviews section draws, or `null` before anything
 * arrived. A page whose server sent no block and answers no read has none, and
 * draws no section.
 */
export const pendingAnswer = signal<GithubPrPendingAnswer | null>(null);

/** The ticket key of the saved reviews, apart from the list's. */
const PENDING_KEY = "pending-reviews";

/** Draw the saved reviews the server wrote into the page, if it wrote any. */
export function drawFirstPending(): boolean {
  const first = readFirstPending();
  if (first === undefined) return false;
  pendingAnswer.value = first;
  return true;
}

/**
 * Read the saved reviews again, and draw them when this read is still the newest.
 *
 * A failure leaves what is drawn where it is and says nothing: the section is a
 * second view of files on the server, and the list's own failure strip is for the
 * list. A server that has no such route answers 404 and the page keeps no section.
 */
export async function loadPending(): Promise<boolean> {
  const ticket = begin(PENDING_KEY);
  try {
    const answer = await fetchPending();
    if (!isCurrent(PENDING_KEY, ticket)) return false;
    if (!Array.isArray(answer?.reviews)) return false;
    pendingAnswer.value = answer;
    return true;
  } catch {
    return false;
  }
}

/** The browser's confirmation, or a refusal on a page that has none. */
function confirmDelete(message: string): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
  return window.confirm(message) === true;
}

/** What the confirmation says is lost, in words. */
export function deleteQuestion(review: GithubPrPendingReview): string {
  const name = `${review.repo} #${review.number}`;
  if (review.kind === "unreadable") {
    return `Delete the saved review of ${name} that cannot be read? This cannot be undone.`;
  }
  const parts: string[] = [];
  if (review.comments > 0) parts.push(`${review.comments} ${review.comments === 1 ? "comment" : "comments"}`);
  if (review.summary) parts.push("an overall comment");
  const holds = parts.length === 0 ? "" : ` It holds ${parts.join(" and ")}.`;
  return `Delete the saved review of ${name}?${holds} This cannot be undone.`;
}

/**
 * Delete one saved review after the reader confirms.
 *
 * A cancel sends nothing. A success also drops this tab's own copies of the
 * review (the collected comments and the unsent changes), because the diff page
 * would otherwise send them again at its next load and make the draft anew. A
 * refusal puts the server's sentence in the list's strip and keeps the row.
 */
export async function deletePending(review: GithubPrPendingReview): Promise<boolean> {
  if (!confirmDelete(deleteQuestion(review))) return false;
  try {
    await postDraftDelete(
      review.kind === "unreadable"
        ? { file: review.file }
        : { repo: review.repo, number: review.number, savedAt: review.savedAt },
    );
  } catch (error) {
    listError.value = listFailureText(error);
    return false;
  }
  forgetStored(pendingStoreKey(review.repo, review.number));
  forgetStored(draftQueueStoreKey(review.repo, review.number));
  listError.value = null;
  await loadPending();
  return true;
}
