/**
 * The diff page: the header, the file tree, the panes, and the review.
 *
 * The page is an address of its own (`/github/pr/<owner>/<repo>/<number>/diff`), so
 * the repository and the number come from its path, and every link out of it is a
 * real link. It draws in a fixed order:
 *
 * 1. The bar comes from the page's JSON block (the viewer, the repositories, the
 *    write switch), so the header is there before any request.
 * 2. The diff is drawn from this tab's session store when the tab already has an
 *    answer for it, which is what makes going from a pull request to its diff and
 *    back instant. A stored answer this build cannot read is a miss.
 * 3. The page then reads the diff route and draws that answer only if the read is
 *    still the newest one for this diff: two reads can be in flight (the page's own
 *    and the one a `⟳ Reload` press starts), and a slow answer must not put older
 *    data over newer.
 *
 * The marks on the line numbers come from the pull request's review threads, which
 * arrive with the pull request's own answer and not with the diff. That read is
 * separate on purpose: a failure to read it costs the marks and nothing else, and the
 * diff is still drawn.
 *
 * A first fetch that would pass the disk limit is refused before anything is
 * fetched, and the page says so with the three sizes the refusal carries. A page that
 * drew an empty diff instead would be lying about what happened.
 */
import { useEffect, useMemo, useRef } from "preact/hooks";
import { ErrorBanner } from "./banner.tsx";
import { TopBar } from "./topbar.tsx";
import { closeDrawer } from "./sidebar.ts";
import { DiffFile, type FileActions } from "./diff-file.tsx";
import { buildTree, commentMoved, layoutFile, placeThreads, savedTextOf, standingOf, type FileLayout, type PendingOnFile, type ThreadPlacement } from "./diff-model.ts";
import type { GithubPrFile } from "../api/github-pr.ts";
import { DiffTree } from "./diff-tree.tsx";
import { ReviewBar, type ReviewLink } from "./diff-review.tsx";
import { draftFailed, retryDraft } from "../state/github-pr-draft.ts";
import {
  NO_ROUTE,
  activeFile,
  answer,
  commitMode,
  beginSelection,
  commitSummary,
  jumpToComment,
  setEvent,
  setSummary,
  cancelForm,
  collectComment,
  discardPending,
  diskLimit,
  error,
  extendSelection,
  folded,
  loading,
  meta,
  openForm,
  pending,
  releaseSelection,
  revealed,
  reload,
  reloading,
  removePending,
  revealedOf,
  revealGap,
  reviewEvent,
  reviewNotice,
  reviewOpen,
  reviewSummary,
  route,
  setActiveFile,
  staleOpen,
  submit,
  submitting,
  threads,
  toggleFile,
  toggleReview,
  toggleStale,
  toggleTreeDirectory,
  treeFolded,
  writes,
} from "./diff-state.ts";
import { diffUrl, listUrl, prUrl } from "./urls.ts";
import type { GithubPrCommitFacts } from "../api/github-pr.ts";
import { ago } from "./parts.tsx";

/** The first ten characters of a commit id, which is how a diff names its two ends. */
function short(sha: string | null | undefined): string {
  return String(sha ?? "").slice(0, 10);
}

/** `1 file`, `7 files`. */
function fileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

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
        void reload();
      }}
    />
  );
}

/** The failure strip, which is always in the page and hidden while it is empty. */
function Banner() {
  return <ErrorBanner error={error.value} />;
}

/**
 * What a first fetch refused by the disk guard says.
 *
 * The three numbers are megabytes, and this is the sentence:
 * the diff was not fetched, and the sizes beside the limit are what the decision was
 * made from. It is a notice and not the error strip, because nothing failed: the
 * guard did its job.
 */
function DiskLimitNotice({
  current,
  estimate,
  limit,
}: {
  readonly current: number;
  readonly estimate: number;
  readonly limit: number;
}) {
  return (
    <div class="empty disk-limit" id="disk-limit">
      <p id="disk-limit-sentence">
        The disk limit was exceeded, so this repository's diff was not fetched. Nothing was fetched,
        so there is no diff to show.
      </p>
      <p class="disk-limit-sizes">
        <span id="disk-limit-current">{`In use now: ${current} MB`}</span>
        {" · "}
        <span id="disk-limit-estimate">{`This repository is estimated at: ${estimate} MB`}</span>
        {" · "}
        <span id="disk-limit-limit">{`Limit: ${limit} MB`}</span>
      </p>
      <p>
        {"Raise "}
        <code>githubPr.diskLimitMegabytes</code>
        {" in the configuration, or set it to 0 for no limit, or free space under the extension's repository directory. Then open this page again."}
      </p>
    </div>
  );
}

/** The header: the two commits compared, the file count, and the ways out of the page. */
function Head({
  repo,
  number,
  title,
  baseRef,
  mergeBase,
  headSha,
  count,
}: {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly baseRef: string;
  readonly mergeBase: string;
  readonly headSha: string;
  readonly count: number;
}) {
  return (
    <h2 class="diff-head">
      <a class="diff-head-back" href={prUrl(repo, number)}>
        {`← #${number}`}
      </a>{" "}
      <span class="diff-head-title">{title}</span>
      <div class="muted">
        {`diff ${short(mergeBase)} … ${short(headSha)} (merge-base of ${baseRef}) · ${fileCount(count)} · `}
        <a class="diff-head-link" href={prUrl(repo, number)}>
          pull request
        </a>
        {" · "}
        <a class="diff-head-link" href={listUrl()}>
          pull request list
        </a>
      </div>
    </h2>
  );
}

/**
 * The header of one commit's diff: its headline, the two commit ids it compares,
 * the file count, the ways out of the page, and the rest of its message.
 *
 * A merge commit says `first parent`, because the diff is against the first parent
 * only. The message is plain preformatted text, not markdown: git messages are
 * plain text.
 */
function CommitHead({
  repo,
  number,
  commit,
  count,
}: {
  readonly repo: string;
  readonly number: number;
  readonly commit: GithubPrCommitFacts;
  readonly count: number;
}) {
  const parent =
    commit.parents.length === 0
      ? "root commit"
      : `${commit.parents.length > 1 ? "first parent" : "parent"} ${short(commit.parents[0])}`;
  const when = ago(commit.committedAt);
  return (
    <h2 class="diff-head commit-head">
      <a class="diff-head-back" href={prUrl(repo, number)}>
        {`← #${number}`}
      </a>{" "}
      <span class="diff-head-title">{commit.headline}</span>
      <div class="muted">
        {`commit ${short(commit.sha)} · ${parent} · ${fileCount(count)} · `}
        <a class="diff-head-link" href={prUrl(repo, number)}>
          pull request
        </a>
        {" · "}
        <a class="diff-head-link" href={diffUrl(repo, number)}>
          pull request diff
        </a>
        {" · "}
        <a class="diff-head-link" href={listUrl()}>
          pull request list
        </a>
      </div>
      <div class="muted commit-author" title={commit.committedAt}>
        {commit.authorName}
        {when === "" ? "" : ` · ${when}`}
      </div>
      {commit.body === "" ? null : <pre class="commit-body">{commit.body}</pre>}
    </h2>
  );
}

const EMPTY_LAYOUT: FileLayout = { slots: [], rows: 0 };

/** What every press inside a file does, in the page's own words. */
const ACTIONS: FileActions = {
  onPress: beginSelection,
  onEnter: extendSelection,
  onReveal: revealGap,
  onFold: toggleFile,
  onRemove: removePending,
  onStale: toggleStale,
  onCancel: cancelForm,
  onCollect: collectComment,
  // The route is not null wherever these are drawn, and a press that arrives without
  // one is a press on a page that draws nothing.
  threadHref: (threadId) => (route === null ? "#" : prUrl(route.repo, route.number, threadId)),
};

/** What one file's layout was built from, so an unchanged file keeps its layout object. */
interface CachedLayout {
  readonly file: GithubPrFile;
  readonly key: string;
  readonly layout: FileLayout;
}

/**
 * The part of the threads' placement that one path draws, as a string.
 *
 * The marks, the outdated threads and the file threads of a path are the only
 * thing of the placement that its file's layout holds, so two placements with the
 * same string give the same layout.
 */
function placementKeys(placement: ThreadPlacement): Map<string, string> {
  const parts = new Map<string, unknown[]>();
  const into = (path: string): unknown[] => {
    let list = parts.get(path);
    if (list === undefined) {
      list = [];
      parts.set(path, list);
    }
    return list;
  };
  for (const [key, group] of placement.groups) into(group.path).push(["g", key, group.count, group.mark, group.targetId]);
  for (const stale of placement.stale) into(stale.thread.path ?? "").push(["s", stale.originalLine, stale.thread]);
  for (const thread of placement.files) into(thread.path ?? "").push(["f", thread]);
  const keys = new Map<string, string>();
  for (const [path, list] of parts) keys.set(path, JSON.stringify(list));
  return keys;
}

/**
 * One file's layout: its rows, with its marks, the comments collected on it and the
 * box being written on it.
 *
 * `key` says what the layout depends on. A file whose key did not change keeps its
 * layout object, so a press redraws the file whose rows changed and no other.
 */
function layoutOf(
  index: number,
  file: GithubPrFile,
  placement: ThreadPlacement,
  placed: ReadonlyMap<string, string>,
  cache: Map<number, CachedLayout>,
  headSha: string,
): FileLayout {
  const path = file.path ?? file.oldPath ?? "";
  const comments: PendingOnFile[] = [];
  // With the write switch off there is no review to collect, so a comment this tab
  // still holds from an earlier visit is not drawn: it could not be sent, and a row
  // saying `Pending` with a `Remove` button would be a control that leads nowhere.
  if (writes) {
    pending.value.forEach((comment, position) => {
      if (comment.path !== path) return;
      // A comment written on an older head whose line holds other code now is
      // marked, and its row goes to the top of the file. The mark is a value of the
      // comment, so it is part of the layout's key below.
      const moved = commentMoved(file, comment, headSha);
      comments.push({
        index: position,
        id: comment.id,
        side: comment.side,
        startLine: comment.startLine,
        line: comment.line,
        body: comment.body,
        moved,
        savedText: moved ? savedTextOf(comment.anchor) : "",
      });
    });
  }
  const form = writes ? openForm.value : null;
  const own = form !== null && form.index === index ? form : null;
  const open = staleOpen.value;
  const opened = placement.stale
    .filter((stale) => (stale.thread.path ?? "") === path && open.has(stale.thread.id))
    .map((stale) => stale.thread.id);
  const gaps = revealedOf(index);
  const key = JSON.stringify([gaps, comments, own, opened, placed.get(path) ?? ""]);
  const hit = cache.get(index);
  if (hit !== undefined && hit.file === file && hit.key === key) return hit.layout;
  const layout = layoutFile({
    file,
    index,
    gaps,
    pending: comments,
    threads: placement,
    form: own,
    staleOpen: open,
    // With the write switch off there is no comment to start, so a line number is
    // not a handle; the mark of a thread still is, because reading is on.
    commentable: writes,
  });
  cache.set(index, { file, key, layout });
  return layout;
}

/** The file tree, which reads the marked file and the folded directories itself. */
function TreeView({ repo, number, files }: { readonly repo: string; readonly number: number; readonly files: readonly GithubPrFile[] }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const active = activeFile.value;
  const marked = files.length === 0 ? 0 : Math.min(Math.max(active, 0), files.length - 1);
  return (
    <DiffTree
      repo={repo}
      number={number}
      files={files}
      tree={tree}
      active={marked}
      folded={treeFolded.value}
      onSelect={selectFile}
      onFold={toggleTreeDirectory}
    />
  );
}

/** A press on a file of the tree: mark it, bring it to the top, and fold the drawer. */
function selectFile(index: number): void {
  setActiveFile(index);
  const target = document.getElementById(`file-${index}`);
  const scroll = (target as HTMLElement | null)?.scrollIntoView;
  if (target !== null && typeof scroll === "function") scroll.call(target, { block: "start" });
  closeDrawer();
}

/**
 * The review bar, which reads the review's own signals itself.
 *
 * It reads the comments, the overall comment, the verdict, the save state and the
 * file list of the answer, and nothing a code cell draws from.
 */
function ReviewPanel() {
  const diff = answer.value;
  const headSha = diff !== null && "headSha" in diff ? diff.headSha : "";
  const files = diff?.files ?? [];
  const comments = pending.value;
  const links: ReviewLink[] = [];
  const missing: ReviewLink[] = [];
  let moved = 0;
  comments.forEach((comment, index) => {
    const standing = standingOf(files, comment, headSha);
    if (standing.moved) moved += 1;
    const link: ReviewLink = { id: comment.id, comment, index, order: standing.fileIndex, moved: standing.moved };
    if (standing.fileIndex < 0) missing.push(link);
    else links.push(link);
  });
  links.sort(
    (a, b) =>
      a.order - b.order ||
      (a.comment.side === b.comment.side ? 0 : a.comment.side === "LEFT" ? -1 : 1) ||
      a.comment.line - b.comment.line,
  );
  return (
    <ReviewBar
      count={comments.length}
      links={links}
      missing={missing}
      movedCount={moved}
      saveFailed={draftFailed.value}
      onRetry={retryDraft}
      onJump={jumpToComment}
      onRemove={removePending}
      onSummaryBlur={commitSummary}
      open={reviewOpen.value}
      summary={reviewSummary.value}
      event={reviewEvent.value}
      sending={submitting.value}
      notice={reviewNotice.value}
      onToggle={toggleReview}
      onSummary={setSummary}
      onEvent={setEvent}
      onDiscard={discardPending}
      onSubmit={submitReviewPress}
    />
  );
}

function submitReviewPress(): void {
  void submit();
}

/**
 * The panes: every changed file, drawn from the answer and from what the reader did to it.
 *
 * This component reads the answer and what the layouts are built from, and nothing
 * else. The mark of the current file, the folded files, the drag and the review
 * panel are read by the components they belong to, so a press on one of them draws
 * that component and not the diff.
 */
function DiffBody({ repo, number }: { readonly repo: string; readonly number: number }) {
  const diff = answer.value;
  const headSha = diff !== null && "headSha" in diff ? diff.headSha : "";
  const panes = useRef<HTMLDivElement | null>(null);
  const cache = useRef(new Map<number, CachedLayout>());
  const placement = useMemo(() => placeThreads(threads.value), [threads.value]);
  const placed = useMemo(() => placementKeys(placement), [placement]);
  // Every file's rows are built from its own inputs, and an unchanged file keeps the
  // object it had: a diff of two thousand lines is walked by the file that changed.
  const layouts = diff === null ? [] : diff.files.map((file, index) => layoutOf(index, file, placement, placed, cache.current, headSha));
  /**
   * Mark the file the reader is looking at.
   *
   * The file at the top of the panes is the one whose header the reader has scrolled
   * past last, which is the original's rule. It runs while the panes scroll, so the
   * tree follows the code without a press; nothing else reads a layout, and no timer
   * is involved, so a page that is not being scrolled does no work.
   */
  useEffect(() => {
    const content = panes.current;
    if (content === null || diff === null) return;
    const spy = (): void => {
      const top = content.scrollTop + 60;
      const files = content.querySelectorAll(".file-diff");
      let found = 0;
      for (let index = 0; index < files.length; index += 1) {
        const element = files[index] as HTMLElement;
        if (element.offsetTop - content.offsetTop > top) break;
        found = index;
      }
      if (found !== activeFile.value) setActiveFile(found);
    };
    content.addEventListener("scroll", spy, { passive: true });
    return () => {
      content.removeEventListener("scroll", spy);
    };
  }, [diff]);
  if (diff === null) return null;
  const files = diff.files;
  return (
    <div class="diff-layout">
      <TreeView repo={repo} number={number} files={files} />
      <div class="diff-content" ref={panes}>
        {writes ? <ReviewPanel /> : null}
        {"commit" in diff ? (
          <CommitHead repo={repo} number={number} commit={diff.commit} count={files.length} />
        ) : (
          <Head
            repo={repo}
            number={number}
            title={diff.title ?? ""}
            baseRef={diff.baseRef}
            mergeBase={diff.mergeBase}
            headSha={diff.headSha}
            count={files.length}
          />
        )}
        {files.length === 0 ? <div class="empty">No changes.</div> : null}
        {files.map((file, index) => (
          <DiffFile
            key={`${file.path ?? file.oldPath ?? ""}-${index}`}
            file={file}
            index={index}
            layout={layouts[index] ?? EMPTY_LAYOUT}
            actions={ACTIONS}
          />
        ))}
      </div>
    </div>
  );
}

/** The page: the diff, the disk-limit notice, or the one line that says it is loading. */
function View() {
  const current = diskLimit.value;
  // A selection is released on the window, not on a line: the pointer may be over a
  // number, over the code, or outside the page by the time the reader lets go.
  useEffect(() => {
    window.addEventListener("mouseup", releaseSelection);
    return () => {
      window.removeEventListener("mouseup", releaseSelection);
    };
  }, []);
  if (route === null) return <div class="empty">{NO_ROUTE}</div>;
  if (answer.value === null) {
    if (current !== null) {
      return (
        <DiskLimitNotice
          current={current.currentMegabytes}
          estimate={current.estimateMegabytes}
          limit={current.limitMegabytes}
        />
      );
    }
    return (
      <div class="empty" id="diff-loading">
        {commitMode ? `Loading commit ${short(route.sha)}…` : `Computing the diff for PR #${route.number}…`}
      </div>
    );
  }
  return <DiffBody repo={route.repo} number={route.number} />;
}

export { View, Bar, Banner, DiskLimitNotice };
