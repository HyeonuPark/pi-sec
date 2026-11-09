/**
 * The server's copy of the review being collected on the diff page.
 *
 * The page keeps its comments in the tab (`github-pr.ts`) and this module keeps the
 * same review on the server, one file per pull request, so a reader finds it again
 * after the tab closed and on another browser. Four rules run through it:
 *
 * 1. **A change is one small operation.** Add, remove, set and discard each name one
 *    comment or one field, and the server applies them in order. Two tabs adding
 *    comments therefore do not overwrite each other, and a change is safe to send
 *    twice.
 * 2. **Changes go one at a time, in order.** The queue also lives in the tab copy,
 *    so a change that failed (the daemon is down, or has no draft route yet) is sent
 *    again by the next change, the Retry press or the next page load. The comment is
 *    never lost from the page meanwhile.
 * 3. **The server's list wins at load and after a drained queue.** The page never
 *    replaces the overall comment field from a write answer, because the reader may
 *    be typing in it. It takes the server's overall comment and verdict at load only.
 * 4. **The overall comment is sent one second after the last key press**, when the
 *    field loses focus, and when the page closes.
 *
 * Timers belong to `src/ui/state/`, so the save delay is set here.
 */
import { signal } from "@preact/signals";
import {
  postDraft,
  fetchDraft,
  type GithubPrDraft,
  type GithubPrDraftComment,
  type GithubPrDraftOp,
} from "../api/github-pr.ts";
import {
  legacyComments,
  pendingComments,
  readStored,
  setPendingComments,
  writeStored,
  type GithubPrPendingComment,
} from "./github-pr.ts";

/** How long the overall comment waits after the last key press. */
export const SUMMARY_DELAY_MS = 1000;

/** True while a change could not be sent: the review bar says `Not saved to server`. */
export const draftFailed = signal(false);

interface Session {
  readonly repo: string;
  readonly number: number;
  /** Put the server's overall comment and verdict on the page. Called at load only. */
  readonly onLoaded: (draft: GithubPrDraft) => void;
}

let session: Session | null = null;
let queue: GithubPrDraftOp[] = [];
let running: Promise<void> | undefined;
let summaryTimer: ReturnType<typeof setTimeout> | undefined;
let summaryText: string | null = null;
let hooked = false;

/** The store key of the unsent changes of one pull request. */
export function draftQueueKey(repo: string, number: number): string {
  return `draftqueue:${repo}:${number}`;
}

function persist(): void {
  if (session !== null) writeStored(draftQueueKey(session.repo, session.number), queue);
}

function toDraftComment(comment: GithubPrPendingComment): GithubPrDraftComment {
  return {
    id: comment.id,
    path: comment.path,
    side: comment.side,
    line: comment.line,
    startLine: comment.startLine,
    body: comment.body,
    headSha: comment.headSha,
    anchor: comment.anchor,
  };
}

function toPending(comment: GithubPrDraftComment): GithubPrPendingComment {
  return {
    id: comment.id,
    path: comment.path,
    side: comment.side,
    line: comment.line,
    startLine: comment.startLine,
    body: comment.body,
    headSha: comment.headSha,
    anchor: comment.anchor,
  };
}

/** Whether an answer is a draft this build can read. */
function isDraft(value: unknown): value is GithubPrDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Partial<GithubPrDraft>;
  return Array.isArray(draft.comments) && typeof draft.summary === "string" && typeof draft.event === "string";
}

/** Take the server's comment list when it differs from the page's. */
function takeServerList(draft: GithubPrDraft): void {
  const mine = pendingComments.value.map((comment) => comment.id).join("\n");
  const theirs = draft.comments.map((comment) => comment.id).join("\n");
  if (mine !== theirs) setPendingComments(draft.comments.map(toPending));
}

/** Send the queue, one change at a time, until it is empty or a send fails. */
export function sendQueue(): Promise<void> {
  if (running !== undefined) return running;
  const own = session;
  if (own === null) return Promise.resolve();
  const work = (async (): Promise<void> => {
    let rejected = false;
    let last: GithubPrDraft | null = null;
    while (queue.length > 0) {
      const change = queue[0];
      if (change === undefined) break;
      try {
        const answer: unknown = await postDraft(own.repo, own.number, change);
        if (!isDraft(answer)) throw new Error("the server answered no draft");
        last = answer;
      } catch (failure) {
        const status = (failure as { status?: unknown }).status;
        if (status === 400) {
          // The server refused this change itself (over a limit): sending it again cannot help.
          rejected = true;
        } else {
          draftFailed.value = true;
          return;
        }
      }
      if (session !== own) return;
      queue.shift();
      persist();
    }
    draftFailed.value = rejected;
    if (last !== null && queue.length === 0 && session === own) takeServerList(last);
  })();
  const tracked = work.finally(() => {
    if (running === tracked) running = undefined;
  });
  running = tracked;
  return tracked;
}

function enqueue(change: GithubPrDraftOp): void {
  if (session === null) return;
  // Two changes of the overall comment or the verdict that wait together are one.
  const tail = queue[queue.length - 1];
  const sending = running !== undefined && queue.length === 1;
  if (change.op === "set" && tail !== undefined && tail.op === "set" && !sending) {
    queue[queue.length - 1] = { ...tail, ...change };
  } else {
    queue.push(change);
  }
  persist();
  void sendQueue();
}

function clearSummaryTimer(): void {
  if (summaryTimer !== undefined) clearTimeout(summaryTimer);
  summaryTimer = undefined;
}

/** Send the overall comment now, when a key press left one waiting. */
export function flushSummary(): void {
  if (summaryText === null) return;
  const text = summaryText;
  summaryText = null;
  clearSummaryTimer();
  enqueue({ op: "set", summary: text });
}

/** The overall comment changed: send it after the reader stops typing. */
export function saveSummary(text: string): void {
  if (session === null) return;
  summaryText = text;
  clearSummaryTimer();
  summaryTimer = setTimeout(flushSummary, SUMMARY_DELAY_MS);
}

/** The verdict changed. */
export function saveEvent(event: GithubPrDraft["event"]): void {
  flushSummary();
  enqueue({ op: "set", event });
}

/** One comment was collected. */
export function saveAdd(comment: GithubPrPendingComment): void {
  enqueue({ op: "add", comment: toDraftComment(comment) });
}

/** One comment was removed. */
export function saveRemove(id: string): void {
  enqueue({ op: "remove", id });
}

/** The whole review was thrown away. */
export function saveDiscard(): void {
  summaryText = null;
  clearSummaryTimer();
  enqueue({ op: "discard" });
}

/** Wait until what the page holds is on the server, or until a send fails. */
export async function settleDraft(): Promise<void> {
  flushSummary();
  await sendQueue();
}

/** After a review was accepted: the server already removed what it sent, so nothing waits any more. */
export function dropDraftQueue(): void {
  summaryText = null;
  clearSummaryTimer();
  queue = [];
  persist();
  draftFailed.value = false;
}

/** The Retry press: send what waits. */
export function retryDraft(): void {
  flushSummary();
  void sendQueue();
}

/** Send a waiting overall comment as the page closes, in a request that outlives the page. */
function onPageHide(): void {
  if (session === null || summaryText === null) return;
  const text = summaryText;
  summaryText = null;
  clearSummaryTimer();
  void postDraft(session.repo, session.number, { op: "set", summary: text }, { keepalive: true }).catch(() => undefined);
}

/**
 * Begin the draft of one pull request: send what an earlier page left unsent, read
 * the server's draft, and put it on the page.
 */
export async function startDraft(
  repo: string,
  number: number,
  onLoaded: (draft: GithubPrDraft) => void,
): Promise<void> {
  const own: Session = { repo, number, onLoaded };
  session = own;
  clearSummaryTimer();
  summaryText = null;
  running = undefined;
  const stored = readStored<GithubPrDraftOp[]>(draftQueueKey(repo, number));
  queue = Array.isArray(stored) ? [...stored] : [];
  if (!hooked && typeof addEventListener === "function") {
    hooked = true;
    addEventListener("pagehide", onPageHide);
  }
  if (queue.length > 0) {
    await sendQueue();
    if (session !== own || queue.length > 0) return;
  }
  let draft: GithubPrDraft;
  try {
    const answer: unknown = await fetchDraft(repo, number);
    if (!isDraft(answer)) throw new Error("the server answered no draft");
    draft = answer;
  } catch {
    if (session === own) draftFailed.value = true;
    return;
  }
  if (session !== own) return;
  draftFailed.value = false;
  const empty = draft.comments.length === 0 && draft.summary === "";
  if (empty && legacyComments.length > 0) {
    // A tab copy from before the draft existed: the server has none, so it takes the copy.
    const old = legacyComments.splice(0);
    for (const comment of old) enqueue({ op: "add", comment: toDraftComment(comment) });
    return;
  }
  legacyComments.length = 0;
  if (queue.length > 0 || running !== undefined) return;
  own.onLoaded(draft);
  takeServerList(draft);
}

/** Run `work` after the page drew again: the next animation frame, or a short timeout without one. */
export function afterFrame(work: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(work);
  else setTimeout(work, 16);
}
