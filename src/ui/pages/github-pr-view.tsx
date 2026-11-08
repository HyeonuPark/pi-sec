/**
 * One pull request's page.
 *
 * The page is an address of its own (`/github/pr/<owner>/<repo>/<number>`), so
 * the repository and the number come from the path and not from a data block, and
 * every link out of it is a real link. It draws in the same three steps as the
 * list page, with one difference:
 *
 * 1. The bar comes from the page's JSON block (the viewer, the repositories, the
 *    write switch), so the page has its header before any request.
 * 2. The pull request itself is drawn from this tab's session store when the tab
 *    already has an answer for it, which is what makes going from a thread back to
 *    its pull request instant. The server writes no data block for this page: it
 *    reads GitHub per request and caches nothing, so a block would only delay the
 *    page.
 * 3. The page then reads the pull request route and draws the answer, but only if
 *    that read is still the newest one for this pull request: two reads can be in
 *    flight (the page's own, one after a write, one after a reload press) and a
 *    slow answer must not put older data over newer.
 *
 * A failure leaves what is drawn where it is and puts the server's own sentence in
 * the strip under the bar, which is what the original did.
 *
 * The write controls are drawn only when the block says the write routes answer:
 * the thread reply boxes, the resolve buttons, the Edit buttons, the pull request's
 * comment box, and the reaction pickers. An Edit button is drawn only on the
 * description and the comments that this account wrote and GitHub lets it edit. A write is sent when a reader presses a button and at no other time,
 * so a page that is only being read never writes to GitHub.
 */
import { useLayoutEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { GithubPrComment, GithubPrDetail, GithubPrThread } from "../api/github-pr.ts";
import { fetchPr, postEdit, postReaction, postReply, postResolve } from "../api/github-pr.ts";
import { mountAt, mountPage, mount } from "../mount.ts";
import { ErrorBanner } from "../github-pr/banner.tsx";
import { TopBar } from "../github-pr/topbar.tsx";
import { readMeta } from "../github-pr/blocks.ts";
import { CommentCard, type ReactionBarProps } from "../github-pr/pr-comments.tsx";
import { ReplyBox, ThreadCard } from "../github-pr/pr-threads.tsx";
import { SideBar } from "../github-pr/pr-sidebar.tsx";
import {
  begin,
  isCurrent,
  listFailureText,
  prStoreKey,
  readStored,
  writeStored,
} from "../state/github-pr.ts";

/** The header's facts, read once: one page does not change them while it is open. */
const meta = readMeta();

/** What an address that does not name a pull request says. */
const NO_ROUTE = "This address does not name a pull request.";

/** One pull request's identity, as the page's own path states it. */
export interface PrRoute {
  /** `owner/repo`, spelled as the payload spells it. */
  readonly repo: string;
  readonly number: number;
}

/**
 * The pull request this page's address names, or `null`.
 *
 * The mount prefix is taken off first, because the page is served under a
 * path-prefix proxy as often as at the root. Both segments of the repository are
 * decoded, because an address carries them percent-encoded.
 */
export function readPrRoute(pathname: string, base: string): PrRoute | null {
  const under = base !== "" && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  const match = /^\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(under);
  if (match === null) return null;
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(match[1] ?? "");
    name = decodeURIComponent(match[2] ?? "");
  } catch {
    return null;
  }
  if (owner === "" || name === "") return null;
  return { repo: `${owner}/${name}`, number: Number(match[3]) };
}

/** The thread id this page's address names after `#`, or `null`. */
export function readThreadAnchor(hash: string): string | null {
  if (!hash.startsWith("#thread-")) return null;
  const raw = hash.slice("#thread-".length);
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Whether a stored value is a pull request answer this build can draw.
 *
 * A value from an older build, or a half-written one, is a miss: the page then
 * draws its placeholder and asks the server, which is what it would have done
 * anyway. This keeps a stale entry from taking the page down with a `map` on
 * `undefined`.
 */
export function isPrDetail(value: unknown): value is GithubPrDetail {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { number?: unknown; threads?: unknown; comments?: unknown; reviews?: unknown };
  return (
    typeof candidate.number === "number" &&
    Array.isArray(candidate.threads) &&
    Array.isArray(candidate.comments) &&
    Array.isArray(candidate.reviews)
  );
}

/* ------------------------------------------------------------------- the page */

/** The pull request the page draws, or `null` before anything arrived. */
const answer = signal<GithubPrDetail | null>(null);

/** Why the last read or write failed, or `null` when nothing did. */
const error = signal<string | null>(null);

/** True while a read is in flight, which is what the bar's `syncing…` says. */
const loading = signal(false);

/**
 * True while the reader's own `⟳ Reload` press is in flight.
 *
 * It is a signal of its own rather than `loading`, because the page's first read
 * starts by itself and a reader who presses the button while that read is still
 * running is asking for a newer answer, not repeating the same one. The ticket in
 * the state module still decides which answer draws.
 */
const reloading = signal(false);

/** The identity of the pull request this page is on, read once from the address. */
const route: PrRoute | null = (() => {
  if (typeof location === "undefined") return null;
  return readPrRoute(location.pathname, mount().base);
})();

/** The thread the address names, read once: a page does not move while it is open. */
const targetThreadId: string | null =
  typeof location === "undefined" ? null : readThreadAnchor(location.hash);

/** The store key of this page's pull request, or `null` for an address it cannot read. */
const storeKey = route === null ? null : prStoreKey(route.repo, route.number);

/** Whether the thread the address names has already been opened and scrolled to. */
let revealed = false;

/**
 * Draw one answer, and keep it for this tab.
 *
 * The store copy is what the page draws from when the reader comes back to it, so
 * it is written with the answer and not on a separate path.
 */
function applyPr(pr: GithubPrDetail): void {
  answer.value = pr;
  error.value = null;
  if (storeKey !== null) writeStored(storeKey, pr);
}

/**
 * Read the pull request, and draw it when this read is still the newest one.
 *
 * Every read is one ticket on this pull request's store key, so the page's first
 * read, the read after a write and the read after a reload press cannot overwrite
 * each other out of order. A failure puts the sentences in the strip and leaves
 * whatever is drawn where it is.
 */
export async function loadPr(): Promise<boolean> {
  if (route === null || storeKey === null) return false;
  const ticket = begin(storeKey);
  loading.value = true;
  try {
    const pr = await fetchPr(route.repo, route.number);
    if (!isCurrent(storeKey, ticket)) return false;
    if (!isPrDetail(pr)) {
      error.value = "the server answered no pull request";
      return false;
    }
    applyPr(pr);
    return true;
  } catch (failure) {
    if (!isCurrent(storeKey, ticket)) return false;
    error.value = listFailureText(failure);
    return false;
  } finally {
    if (isCurrent(storeKey, ticket)) loading.value = false;
  }
}

/** One write, and the read that shows its result. A failure is the strip's sentence. */
async function write(work: () => Promise<unknown>): Promise<boolean> {
  if (route === null) return false;
  try {
    await work();
  } catch (failure) {
    error.value = listFailureText(failure);
    return false;
  }
  return await loadPr();
}

/** React to one comment, review or description. */
function react(comment: GithubPrComment, content: string, add: boolean): Promise<void> | void {
  if (route === null) return;
  return write(async () => {
    await postReaction(route.repo, route.number, { subjectId: comment.id, content, add });
  }).then(() => undefined);
}

/** Answer one thread, or leave a comment on the pull request when `thread` is `null`. */
function reply(thread: GithubPrThread | null, body: string): Promise<boolean> {
  if (route === null) return Promise.resolve(false);
  return write(async () => {
    await postReply(route.repo, route.number, { body, threadId: thread === null ? null : thread.id });
  });
}

/**
 * Resolve one thread.
 *
 * On success the thread is marked resolved in what the page draws at once, without
 * waiting for the read that follows, and then the pull request is read again. If
 * that read fails, the card still shows `Resolved` and the strip shows the failure.
 */
async function resolve(thread: GithubPrThread): Promise<boolean> {
  if (route === null) return false;
  try {
    await postResolve(route.repo, route.number, { threadId: thread.id });
  } catch (failure) {
    error.value = listFailureText(failure);
    return false;
  }
  const current = answer.value;
  if (current !== null) {
    applyPr({
      ...current,
      threads: current.threads.map((item) => (item.id === thread.id ? { ...item, isResolved: true } : item)),
    });
  }
  await loadPr();
  return true;
}

/**
 * Save an edited description, or an edited comment when `commentId` is given.
 *
 * `base` is the text the page drew when Edit was pressed, and the server refuses
 * the save when GitHub holds another text. On success the new text, as GitHub
 * answered it, is drawn at once, and then the pull request is read again. A
 * refusal puts the server's sentence in the strip and leaves the box open.
 */
async function edit(text: string, base: string, commentId: string | null): Promise<boolean> {
  if (route === null) return false;
  let saved: string;
  try {
    const result = await postEdit(route.repo, route.number, {
      body: text,
      baseBody: base,
      ...(commentId === null ? {} : { commentId }),
    });
    saved = typeof result.body === "string" ? result.body : text;
  } catch (failure) {
    error.value = listFailureText(failure);
    return false;
  }
  const current = answer.value;
  if (current !== null) {
    const swap = <T extends GithubPrComment>(item: T): T =>
      item.id === commentId ? { ...item, body: saved } : item;
    applyPr(
      commentId === null
        ? { ...current, body: saved }
        : {
            ...current,
            comments: current.comments.map(swap),
            threads: current.threads.map((thread) => ({ ...thread, comments: thread.comments.map(swap) })),
          },
    );
  }
  await loadPr();
  return true;
}

/* ----------------------------------------------------------------- components */

/** The bar, in the place the shell left for it. */
function Bar() {
  return (
    <TopBar
      viewer={meta.viewer}
      repos={meta.repos}
      loading={loading.value}
      forcing={reloading.value}
      sidebar
      onReload={() => {
        reloading.value = true;
        void loadPr().finally(() => {
          reloading.value = false;
        });
      }}
    />
  );
}

/** The failure strip, which is always in the page and hidden while it is empty. */
function Banner() {
  return <ErrorBanner error={error.value} />;
}

/** One review in the conversation: a comment whose header carries its state. */
function reviewExtra(state: string) {
  return <span class={`review-state review-${state}`}>{state.replace(/_/g, " ")}</span>;
}

/**
 * The conversation, in one list: the comments and the review summaries, oldest
 * first.
 *
 * A review with no words and the state `COMMENTED` is not a message: it is the
 * container GitHub keeps the review's line comments in, and those are drawn in
 * their threads. Every other review is a message, with its state on it.
 */
function conversation(pr: GithubPrDetail): { item: GithubPrComment; reviewState: string | null }[] {
  const comments = pr.comments.map((comment) => ({ item: comment as GithubPrComment, reviewState: null }));
  const reviews = pr.reviews
    .filter((review) => (review.body ?? "").trim() !== "" || review.reviewState !== "COMMENTED")
    .map((review) => ({ item: review as GithubPrComment, reviewState: review.reviewState }));
  return [...comments, ...reviews].sort((left, right) =>
    String(left.item.createdAt).localeCompare(String(right.item.createdAt)),
  );
}

/** The state badge: `Draft`, or the state with its first letter capitalized. */
function stateBadge(pr: GithubPrDetail): { text: string; cls: string } {
  if (pr.isDraft) return { text: "Draft", cls: "draft" };
  const state = String(pr.state ?? "").toLowerCase();
  const text = state === "" ? "Unknown" : state.charAt(0).toUpperCase() + state.slice(1);
  return { text, cls: state === "" ? "closed" : state };
}

/** The pull request itself. */
function PrView({ pr }: { readonly pr: GithubPrDetail }) {
  const onReact = react as ReactionBarProps["onReact"];
  const badge = stateBadge(pr);
  const items = conversation(pr);
  const [highlight, setHighlight] = useState(targetThreadId);

  // The thread the address names is opened by its card (it starts unfolded), and
  // this marks it and brings it into view once: a redraw after a write must not
  // pull the reader away from where they are reading. It runs after the elements
  // are in the page and before the browser paints, which is why the reader never
  // sees the page jump.
  useLayoutEffect(() => {
    if (revealed || targetThreadId === null) return;
    const card = document.getElementById(`thread-${targetThreadId}`);
    if (card === null) return;
    revealed = true;
    setHighlight(targetThreadId);
    const scroll = (card as HTMLElement).scrollIntoView;
    if (typeof scroll === "function") scroll.call(card, { block: "start" });
  });

  return (
    <div class="dash">
      <div class="dash-main">
        <h1 class="dash-title">
          {pr.title} <span class="pr-number">{`#${pr.number}`}</span>
        </h1>
        <div class="dash-meta-line">
          <span class={`state-badge state-${badge.cls}`}>{badge.text}</span>{" "}
          <strong>{pr.author ?? "?"}</strong> wants to merge <code>{pr.headRefName}</code> into{" "}
          <code>{pr.baseRefName}</code> · <code>{pr.repo}</code> ·{" "}
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            open on GitHub ↗
          </a>
        </div>
        <CommentCard
          comment={{
            id: pr.id,
            author: pr.author,
            body: pr.body,
            createdAt: pr.createdAt,
            url: pr.url,
            reactions: pr.reactions,
            viewerCanUpdate: pr.viewerCanUpdate === true,
            viewerDidAuthor: pr.viewerDidAuthor === true,
          }}
          writes={meta.writes}
          onReact={onReact}
          onEdit={(text, base) => edit(text, base, null)}
        />
        {items.map(({ item, reviewState }) => (
          <CommentCard
            key={item.id}
            comment={item}
            writes={meta.writes}
            onReact={onReact}
            {...(reviewState === null ? { onEdit: (text: string, base: string) => edit(text, base, item.id) } : {})}
            {...(reviewState === null ? {} : { extra: reviewExtra(reviewState) })}
            {...(reviewState === null ? {} : { empty: "No review comment." })}
          />
        ))}
        {pr.threads.length === 0 ? null : <h3>Review threads</h3>}
        {pr.threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            writes={meta.writes}
            open={!thread.isResolved || thread.id === highlight}
            targeted={thread.id === highlight}
            onReact={onReact}
            onReply={(target, body) => reply(target, body)}
            onResolve={(target) => resolve(target)}
            onEdit={(comment, text, base) => edit(text, base, comment.id)}
          />
        ))}
        {meta.writes ? (
          <>
            <h3>Add a comment</h3>
            <div class="thread-card">
              <ReplyBox
                label="Comment"
                placeholder="Leave a comment on the pull request…"
                onSend={(body) => reply(null, body)}
              />
            </div>
          </>
        ) : null}
      </div>
      <SideBar pr={pr} />
    </div>
  );
}

/** The page: the pull request, the one line that says it is loading, or the address's complaint. */
function View() {
  if (route === null) return <div class="empty">{NO_ROUTE}</div>;
  const pr = answer.value;
  if (pr === null) return <div class="empty">{`Loading PR #${route.number}…`}</div>;
  return <PrView pr={pr} />;
}

/* --------------------------------------------------------------- first paint */

// The tab's own copy of this pull request is drawn before the read answers, which
// is the whole point of the store: a reader who comes back to a page they were on
// sees it again at once.
if (storeKey !== null) {
  const stored = readStored<GithubPrDetail>(storeKey);
  if (isPrDetail(stored)) answer.value = stored;
}

const bar = document.querySelector("#topbar");
if (bar === null) throw new Error("the pull request page has no element matching #topbar");
mountAt(bar, <Bar />);
const strip = document.querySelector("#error-banner");
if (strip === null) throw new Error("the pull request page has no element matching #error-banner");
mountAt(strip, <Banner />);
mountPage("#view", View);

void loadPr();
