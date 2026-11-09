/**
 * What the diff page holds while it is open: the answer, what the reader did to
 * it, and the review that is being collected.
 *
 * The rules this file keeps, and why each one is here rather than in a component:
 *
 * 1. **The tab's own copy is drawn before the server answers.** The answer of the
 *    diff route is kept under this tab's key for the pull request, so a reader who
 *    goes to the pull request page and back sees the diff again at once. The
 *    session store and the request tickets belong to `src/ui/state/github-pr.ts`;
 *    this file only decides what the page asks for and what it draws.
 * 2. **The read that started last is the one that draws.** Two reads can be in
 *    flight (the page's own, and the one a `⟳ Reload` press starts), so every read
 *    takes a ticket and an older answer is dropped.
 * 3. **A review is collected in the browser.** A comment a reader writes on a line
 *    is kept in this tab and drawn where it was written; GitHub hears about it only
 *    when the reader submits the whole review. That is why the collection is a
 *    signal here and a write request is sent from exactly one function.
 * 4. **A page that is only being read sends no write.** Nothing in this file sends
 *    a `POST` until {@link submit} runs, and {@link submit} runs only from a press
 *    on `Submit review`.
 *
 * The write controls are drawn only when the page's meta block says the write
 * routes answer ({@link writes}): with the switch off, a reader gets no line
 * selection, no comment box and no review bar at all, because every one of them
 * would end in a write this install refuses.
 */
import { signal } from "@preact/signals";
import type { GithubPrCommitDiffAnswer, GithubPrDiffAnswer, GithubPrThread } from "../api/github-pr.ts";
import {
  diskLimitOf,
  fetchCommitDiff,
  fetchPr,
  fetchPrDiff,
  isDiskLimit,
  submitReview,
} from "../api/github-pr.ts";
import { mount } from "../mount.ts";
import {
  addPendingComment,
  begin,
  commitStoreKey,
  diffStoreKey,
  isCurrent,
  listFailureText,
  loadPendingComments,
  pendingComments,
  prStoreKey,
  readStored,
  removePendingComment,
  setPendingComments,
  writeStored,
} from "../state/github-pr.ts";
import { readMeta } from "./blocks.ts";
import {
  hasThreads,
  isDiffAnswer,
  nextReveal,
  readDiffRoute,
  revealRows,
  type DiffRoute,
  type DiffSide,
  type GapRow,
  type OpenForm,
  type RevealAction,
  type RevealedGap,
} from "./diff-model.ts";

/* -------------------------------------------------------------------- facts */

/** The header's facts, read once: one page does not change them while it is open. */
export const meta = readMeta();

/** The address this page is on, read once, or `null` when it names no diff. */
export const route: DiffRoute | null =
  typeof location === "undefined" ? null : readDiffRoute(location.pathname, mount().base);

/** True when the address names one commit: the page then draws that commit's diff. */
export const commitMode: boolean = route?.sha !== undefined;

/**
 * Whether the write routes answer, which is what draws the review controls.
 *
 * A commit's diff never draws one, even with the switch on: a review belongs to the
 * whole pull request diff, and a comment on one commit's line would be a different
 * write that this dashboard does not make.
 */
export const writes: boolean = meta.writes && !commitMode;

/** What an address that does not name a diff says. */
export const NO_ROUTE = "This address does not name a diff.";

/** The verdicts a review can carry, in the order the panel lists them. */
export const REVIEW_EVENTS = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
] as const;

/** One verdict a review can carry. */
export type ReviewEvent = (typeof REVIEW_EVENTS)[number]["value"];

/* ------------------------------------------------------------------ signals */

/** The diff this page draws, or `null` before anything arrived. */
export const answer = signal<GithubPrDiffAnswer | GithubPrCommitDiffAnswer | null>(null);

/** Why the last read or write failed, or `null` when nothing did. */
export const error = signal<string | null>(null);

/** True while a read is in flight, which is what the bar's `syncing…` says. */
export const loading = signal(false);

/** True while this reader's own `⟳ Reload` press is in flight. */
export const reloading = signal(false);

/**
 * What a disk-limit refusal measured, or `null`.
 *
 * A first fetch of a repository that would pass `githubPr.diskLimitMegabytes` is
 * refused with `409` and three sizes. The page says so instead of drawing a diff,
 * because there is no diff: nothing was fetched.
 */
export const diskLimit = signal<{
  readonly currentMegabytes: number;
  readonly estimateMegabytes: number;
  readonly limitMegabytes: number;
} | null>(null);

/**
 * The pull request's review threads, which is where the marks on the lines come
 * from.
 *
 * They arrive with the pull request's own answer and not with the diff, because
 * a thread is a conversation and the diff is a pair of commits. The page reads the
 * pull request for them, as the original did, and a failure to read it costs the
 * marks and nothing else: the diff is still drawn.
 */
export const threads = signal<readonly GithubPrThread[]>([]);

/** The files the reader folded down to their header, by index in the answer. */
export const folded = signal<ReadonlySet<number>>(new Set());

/** How much of each folded stretch was opened, keyed `<file index>:<gap>`. */
export const revealed = signal<Readonly<Record<string, RevealedGap>>>({});

/** The comment being written, or `null` when none is. */
export const openForm = signal<OpenForm | null>(null);

/** The outdated threads this reader opened, so a redraw keeps them open. */
export const staleOpen = signal<ReadonlySet<string>>(new Set());

/**
 * The lines one drag has covered so far.
 *
 * A drag starts on a line number and follows the pointer down the same side of the
 * same file; letting go opens a comment box under the last line it reached. The
 * side matters: a comment belongs to one side of the diff, so a drag cannot mix
 * the old and the new lines.
 */
export const drag = signal<{ readonly index: number; readonly side: DiffSide; readonly anchor: number; readonly end: number } | null>(null);

/** Which file the reader is looking at, which is the row the tree marks. */
export const activeFile = signal(0);

/** The directories the reader folded in the tree, by their path. */
export const treeFolded = signal<ReadonlySet<string>>(new Set());

/** Whether the review panel is open. */
export const reviewOpen = signal(false);

/** The overall comment of the review being written. */
export const reviewSummary = signal("");

/** The verdict the review will carry. */
export const reviewEvent = signal<ReviewEvent>("COMMENT");

/** True while the review is being sent, which disables its button. */
export const submitting = signal(false);

/** What the page says after a review was accepted, or `null`. */
export const reviewNotice = signal<string | null>(null);

/** The tab's collection of comments, as this page reads it. */
export const pending = pendingComments;

/* ------------------------------------------------------------------ actions */

/** Start the page's collection of comments for this pull request. */
export function startPending(): void {
  if (route === null || commitMode) return;
  loadPendingComments(route.repo, route.number);
}

/* -------------------------------------------------------------------- reads */

/** The store key of this page's diff, or `null` for an address it cannot read. */
const storeKey =
  route === null
    ? null
    : route.sha === undefined
      ? diffStoreKey(route.repo, route.number)
      : commitStoreKey(route.repo, route.sha);

/** The store key of the pull request this diff belongs to, which carries the threads. */
const threadStoreKey = route === null || commitMode ? null : prStoreKey(route.repo, route.number);

/**
 * Draw the diff this tab already had, before the read answers.
 *
 * That is the whole point of the session store: a reader who comes back to a page
 * they were on sees it again at once rather than an empty pane. The read still
 * runs, because the copy is where the diff was when the reader left it.
 */
export function drawStoredDiff(): boolean {
  if (storeKey === null) return false;
  const stored = readStored<GithubPrDiffAnswer | GithubPrCommitDiffAnswer>(storeKey);
  if (!isDiffAnswer(stored)) return false;
  answer.value = stored;
  return true;
}

/**
 * Draw the threads this tab already had for the pull request, before the read
 * answers.
 *
 * The marks on the lines come from here, so a page that drew a stored diff and no
 * stored threads would show the code and then add the marks a moment later. The
 * copy is only a head start: the read below replaces it.
 */
export function drawStoredThreads(): boolean {
  if (threadStoreKey === null) return false;
  const stored = readStored<unknown>(threadStoreKey);
  if (!hasThreads(stored)) return false;
  threads.value = stored.threads;
  return true;
}

/**
 * Read the diff, and draw it when this read is still the newest one.
 *
 * A disk-limit refusal is not a failure of the page: nothing was fetched, so the
 * page says what the guard measured instead of drawing an empty diff. Any other
 * refusal puts the server's own sentence in the strip and leaves what is drawn
 * where it is.
 */
export async function loadDiff(): Promise<boolean> {
  if (route === null || storeKey === null) return false;
  const ticket = begin(storeKey);
  loading.value = true;
  try {
    const diff =
      route.sha === undefined
        ? await fetchPrDiff(route.repo, route.number)
        : await fetchCommitDiff(route.repo, route.number, route.sha);
    if (!isCurrent(storeKey, ticket)) return false;
    if (!isDiffAnswer(diff)) {
      error.value = "the server answered no diff";
      return false;
    }
    diskLimit.value = null;
    answer.value = diff;
    error.value = null;
    writeStored(storeKey, diff);
    return true;
  } catch (failure) {
    if (!isCurrent(storeKey, ticket)) return false;
    if (isDiskLimit(failure)) {
      const measured = diskLimitOf(failure);
      if (measured !== null) {
        diskLimit.value = measured;
        answer.value = null;
        error.value = null;
        return false;
      }
    }
    error.value = listFailureText(failure);
    return false;
  } finally {
    if (isCurrent(storeKey, ticket)) loading.value = false;
  }
}

/**
 * Read the pull request, for its review threads.
 *
 * A thread is where the mark on a line number comes from, and the diff answer
 * carries none: a diff is a pair of commits, and a thread is a conversation. A
 * failure here costs the marks and nothing else, so it leaves the strip alone: the
 * page's own failure, if there was one, is the one a reader needs to read.
 */
export async function loadThreads(): Promise<boolean> {
  if (route === null || threadStoreKey === null) return false;
  const ticket = begin(threadStoreKey);
  try {
    const pr = await fetchPr(route.repo, route.number);
    if (!isCurrent(threadStoreKey, ticket)) return false;
    if (!hasThreads(pr)) return false;
    threads.value = pr.threads;
    writeStored(threadStoreKey, pr);
    return true;
  } catch {
    return false;
  }
}

/** Read the diff again at this reader's press. */
export async function reload(): Promise<void> {
  reloading.value = true;
  try {
    await loadDiff();
  } finally {
    reloading.value = false;
  }
}

/** Move the tree's marked file, and fold the drawer a narrow screen opened. */
export function setActiveFile(index: number): void {
  activeFile.value = index;
}

/** Fold or unfold one file. */
export function toggleFile(index: number): void {
  const next = new Set(folded.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  folded.value = next;
}

/** Fold or unfold one directory of the tree. */
export function toggleTreeDirectory(path: string): void {
  const next = new Set(treeFolded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  treeFolded.value = next;
}

/**
 * Open more of one folded stretch.
 *
 * The whole file is in the answer, so nothing here asks the server: the state
 * says how many lines of the stretch were opened from each end, and the rows are
 * rebuilt from that.
 */
export function revealGap(index: number, gap: number, action: RevealAction): void {
  const diff = answer.value;
  const file = diff?.files[index];
  if (diff === null || file === undefined) return;
  // The stretch is rebuilt from the answer with nothing revealed, because the state
  // counts from the whole of it: a row this function read after an earlier press
  // would already be the shortened one, and 30 more lines would then be counted
  // twice.
  const row = revealRows(file, {}).find(
    (entry): entry is GapRow => entry.kind === "gap" && entry.gap === gap,
  );
  if (row === undefined) return;
  const key = `${index}:${gap}`;
  const current = revealed.value[key] ?? { down: 0, up: 0 };
  const next = nextReveal(row, current, action);
  if (next === null) return;
  revealed.value = { ...revealed.value, [key]: next };
}

/** The reveal state of one file's stretches. */
export function revealedOf(index: number): Readonly<Record<string, RevealedGap>> {
  const out: Record<string, RevealedGap> = {};
  for (const [key, value] of Object.entries(revealed.value)) {
    const [file, gap] = key.split(":");
    if (file === String(index) && gap !== undefined) out[gap] = value;
  }
  return out;
}

/** Begin a drag on one line number, and drop the comment box that was open. */
export function beginSelection(index: number, side: DiffSide, line: number): void {
  if (!writes) return;
  openForm.value = null;
  drag.value = { index, side, anchor: line, end: line };
}

/** Follow the pointer down the same side of the same file. */
export function extendSelection(index: number, side: DiffSide, line: number): void {
  const current = drag.value;
  if (current === null || current.index !== index || current.side !== side) return;
  // The pointer entering the same line again (for example a thread mark inside the
  // number) changes nothing the reader sees, so it writes nothing.
  if (current.end === line) return;
  drag.value = { ...current, end: line };
}

/**
 * Let go, which opens the comment box under the last line the drag reached.
 *
 * A drag that ended where it started is one line, and a drag that ran upwards is
 * the same range as one that ran downwards: the box covers from the lower number
 * to the higher one either way.
 */
export function releaseSelection(): void {
  const current = drag.value;
  drag.value = null;
  if (current === null) return;
  const startLine = Math.min(current.anchor, current.end);
  const line = Math.max(current.anchor, current.end);
  openForm.value = { index: current.index, side: current.side, startLine, line };
}

/** Close the comment box without collecting anything. */
export function cancelForm(): void {
  openForm.value = null;
}

/** Collect the comment that was written, and close the box. */
export function collectComment(body: string): boolean {
  const form = openForm.value;
  if (form === null || body.trim() === "") return false;
  const diff = answer.value;
  const file = diff?.files[form.index];
  if (file === undefined) return false;
  const path = file.path ?? file.oldPath ?? "";
  if (path === "") return false;
  addPendingComment({
    path,
    side: form.side,
    line: form.line,
    startLine: form.startLine === form.line ? null : form.startLine,
    body,
  });
  openForm.value = null;
  return true;
}

/** Drop one collected comment, by its place in the collection. */
export function removePending(index: number): void {
  removePendingComment(index);
}

/** Throw the whole collection away. */
export function discardPending(): void {
  setPendingComments([]);
  reviewOpen.value = false;
}

/** Fold or unfold one outdated thread's review-time code. */
export function toggleStale(id: string): void {
  const next = new Set(staleOpen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  staleOpen.value = next;
}

/** Open or close the review panel. */
export function toggleReview(): void {
  reviewOpen.value = !reviewOpen.value;
}

/**
 * Send the collected review, once, when the reader presses its button.
 *
 * This is the only function in the page that writes to GitHub. It sends the
 * comments this tab collected, the overall comment and the verdict in one request,
 * which is what a review is; a success empties the collection, because those
 * comments are now GitHub's and keeping them would submit them twice.
 *
 * A refusal leaves the collection where it is, so nothing the reader wrote is
 * lost, and puts the server's own sentence in the strip.
 */
export async function submit(): Promise<boolean> {
  if (route === null || commitMode || submitting.value) return false;
  const comments = pending.value;
  const body = reviewSummary.value.trim();
  if (comments.length === 0 && body === "") {
    error.value = "a review needs one comment or an overall comment";
    return false;
  }
  submitting.value = true;
  reviewNotice.value = null;
  try {
    await submitReview(route.repo, route.number, {
      body,
      event: reviewEvent.value,
      comments: comments.map((comment) => ({
        body: comment.body,
        path: comment.path,
        side: comment.side,
        line: comment.line,
        startLine: comment.startLine,
      })),
    });
    setPendingComments([]);
    reviewSummary.value = "";
    // The panel stays open, because the page does not navigate away and a note
    // inside a panel that just closed is a note nobody reads.
    reviewNotice.value = "Review submitted.";
    error.value = null;
    return true;
  } catch (failure) {
    error.value = listFailureText(failure);
    return false;
  } finally {
    submitting.value = false;
  }
}
