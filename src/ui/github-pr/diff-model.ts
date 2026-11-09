/**
 * The diff page's arithmetic, kept apart from its markup.
 *
 * Five questions are answered here, each of them a fixed rule:
 *
 * 1. Which rows one changed file's hunks make in a side-by-side view: a context
 *    line stands on both sides, a run of removed lines is paired with the run of
 *    added lines that follows it, and the stretches between hunks become one
 *    collapsed row each.
 * 2. How a collapsed stretch opens: 30 lines at a time from either end, or all at
 *    once, with the whole file already in the answer. A file the server left out
 *    (over 50000 lines) has nothing to reveal, so it offers no control.
 * 3. Where inside a paired line the change is: the common prefix and suffix are
 *    the same text on both sides, and what lies between them is what got darker.
 * 4. How the changed files read as a tree, in git's own entry order, so the tree
 *    and the panes list the files in the same order.
 * 5. Where a review thread's mark goes: a thread that sits on a line of the diff
 *    marks that line's number, and an outdated thread has no line left, so it
 *    becomes a row of its own near where it was written. A file thread (a comment
 *    on a whole file) has no line, so it becomes a row at the top of its file.
 *
 * Everything here is pure: the same inputs answer the same rows, which is what
 * lets a page redraw one file after a press without reading the answer again,
 * and what the tests check without a browser.
 */
import { isFileThread, type GithubPrDiffAnswer, type GithubPrFile, type GithubPrThread } from "../api/github-pr.ts";

/* ------------------------------------------------------------------- routes */

/** One diff page's identity, as its own address states it. */
export interface DiffRoute {
  /** `owner/repo`, spelled as the payload spells it. */
  readonly repo: string;
  readonly number: number;
  /** The full commit id when the address is a commit's diff, else absent. */
  readonly sha?: string;
}

/**
 * The diff this page's address names, or `null`.
 *
 * The rule is the pull request page's rule with one segment more (`/diff` at the
 * end, or `/commits/<sha>` for one commit's diff), and it is written out again rather than imported: a page module runs its
 * first paint when it is imported, so the diff page cannot import the pull
 * request page's module to borrow one function from it. The mount prefix comes
 * off first, and both segments of the repository are decoded, because an address
 * carries them percent-encoded.
 */
export function readDiffRoute(pathname: string, base: string): DiffRoute | null {
  const under = base !== "" && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  const match = /^\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/diff|\/commits\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64}))\/?$/.exec(under);
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
  const sha = match[4];
  return sha === undefined
    ? { repo: `${owner}/${name}`, number: Number(match[3]) }
    : { repo: `${owner}/${name}`, number: Number(match[3]), sha: sha.toLowerCase() };
}

/**
 * Whether a stored value is a diff answer this build can draw.
 *
 * A value from an older build, or one written halfway, is a miss: the page draws
 * its placeholder and asks the server, which is what it would have done anyway.
 * Without this check a stale entry would take the page down on the first `map`.
 */
export function isDiffAnswer(value: unknown): value is GithubPrDiffAnswer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { number?: unknown; files?: unknown };
  if (typeof candidate.number !== "number") return false;
  if (!Array.isArray(candidate.files)) return false;
  return candidate.files.every(
    (file) => typeof file === "object" && file !== null && Array.isArray((file as { hunks?: unknown }).hunks),
  );
}

/** Whether a stored value carries the review threads the marks are drawn from. */
export function hasThreads(value: unknown): value is { readonly threads: readonly GithubPrThread[] } {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { threads?: unknown }).threads);
}

/* --------------------------------------------------------------------- rows */

/** One side of one row: the line's number in that file, and its text. */
export interface DiffSideLine {
  readonly n: number;
  readonly text: string;
  /** `ctx` for a line that stayed, `del` for a removed one, `add` for a new one. */
  readonly kind: "ctx" | "add" | "del";
}

/** A row of a file before anything is revealed: either two cells or a gap. */
export type RawRow =
  | { readonly kind: "line"; readonly old: DiffSideLine | null; readonly new: DiffSideLine | null }
  | {
      readonly kind: "gap";
      /** The first line number of the stretch on each side. */
      readonly oldStart: number;
      readonly newStart: number;
      /** How many lines are folded away. */
      readonly count: number;
      /** Which of this file's gaps it is, which is its key in the reveal state. */
      readonly gap: number;
    };

/**
 * The rows of one file's hunks, in the order the panes draw them.
 *
 * This is the original's walk, step for step: the lines before the first hunk and
 * after the last one are collapsed stretches, a context line is one row with the
 * same text on both sides, and a run of removed lines that is followed by a run
 * of added lines becomes as many rows as the longer run, with an empty cell where
 * the shorter one ran out. The trailing stretch is counted from the file's own
 * length, which is why an added file counts from its new side and a deleted file
 * from its old one.
 */
export function buildRows(file: GithubPrFile): RawRow[] {
  const rows: RawRow[] = [];
  let oldNext = 1;
  let newNext = 1;
  let gap = 0;
  for (const hunk of file.hunks) {
    if (hunk.oldStart > oldNext) {
      rows.push({ kind: "gap", oldStart: oldNext, newStart: newNext, count: hunk.oldStart - oldNext, gap });
      gap += 1;
    }
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    const lines = hunk.lines;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined) break;
      if (line.t === "ctx") {
        rows.push({
          kind: "line",
          old: { n: oldNumber, text: line.s, kind: "ctx" },
          new: { n: newNumber, text: line.s, kind: "ctx" },
        });
        oldNumber += 1;
        newNumber += 1;
        index += 1;
        continue;
      }
      const removed: string[] = [];
      while (lines[index]?.t === "del") {
        removed.push(lines[index]?.s ?? "");
        index += 1;
      }
      const added: string[] = [];
      while (lines[index]?.t === "add") {
        added.push(lines[index]?.s ?? "");
        index += 1;
      }
      const longer = Math.max(removed.length, added.length);
      for (let k = 0; k < longer; k += 1) {
        const gone = removed[k];
        const arrived = added[k];
        rows.push({
          kind: "line",
          old: gone === undefined ? null : { n: oldNumber, text: gone, kind: "del" },
          new: arrived === undefined ? null : { n: newNumber, text: arrived, kind: "add" },
        });
        if (gone !== undefined) oldNumber += 1;
        if (arrived !== undefined) newNumber += 1;
      }
    }
    oldNext = oldNumber;
    newNext = newNumber;
  }
  // The stretch after the last hunk, measured on a side that still has a file.
  const tail =
    file.newContent != null
      ? file.newContent.length - newNext + 1
      : file.oldContent != null
        ? file.oldContent.length - oldNext + 1
        : 0;
  if (tail > 0) rows.push({ kind: "gap", oldStart: oldNext, newStart: newNext, count: tail, gap });
  return rows;
}

/** How much of one collapsed stretch is revealed from each end. */
export interface RevealedGap {
  /** Lines revealed just below the hunk above. */
  readonly down: number;
  /** Lines revealed just above the hunk below. */
  readonly up: number;
}

/** What one press on a collapsed stretch asks for. */
export type RevealAction = "down" | "up" | "all";

/** The lines one press reveals, which is the original's step. */
export const REVEAL_STEP = 30;

/** The common prefix and suffix of two paired lines, as offsets. */
export interface Pair {
  /** How many characters both lines start with. */
  readonly p: number;
  /** How many characters both lines end with. */
  readonly s: number;
}

/** One row of a file that is ready to draw: two cells, or the folded stretch. */
export interface LineRow {
  readonly kind: "line";
  readonly old: DiffSideLine | null;
  readonly new: DiffSideLine | null;
  /** The change inside a paired line, or `null` when the lines share nothing. */
  readonly pair: Pair | null;
  /** True when this row's numbers may be dragged to leave a review comment. */
  readonly selectable: boolean;
}

/** The folded stretch that is left after some of it was revealed. */
export interface GapRow {
  readonly kind: "gap";
  readonly oldStart: number;
  readonly newStart: number;
  readonly count: number;
  /** Which gap of the file this is. */
  readonly gap: number;
  /** False when the server sent no file content, which is a file over 50000 lines. */
  readonly expandable: boolean;
}

/** A row of one file's panes. */
export type FileRow = LineRow | GapRow;

/**
 * The common prefix and the common suffix of two paired lines.
 *
 * A paired row is one line that became another, and only the middle of it is the
 * change: `const a = 1;` to `const a = 2;` keeps `const a = ` and `;`. When the
 * two lines share nothing, there is no middle to mark and the answer is `null`,
 * which is the original's rule: a line that changed completely already reads as a
 * changed line.
 */
export function subline(before: string, after: string): Pair | null {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix === 0) return null;
  return { p: prefix, s: suffix };
}

/** The lines of a file the server sent, and which side they are the lines of. */
export function contentOf(file: GithubPrFile): { readonly lines: readonly string[]; readonly usesNew: boolean } | null {
  if (file.newContent != null) return { lines: file.newContent, usesNew: true };
  if (file.oldContent != null) return { lines: file.oldContent, usesNew: false };
  return null;
}

/** One context line revealed out of a folded stretch, on both sides. */
function revealedLine(file: GithubPrFile, oldNumber: number, newNumber: number): LineRow {
  const content = contentOf(file);
  const index = (content !== null && content.usesNew ? newNumber : oldNumber) - 1;
  const text = content?.lines[index] ?? "";
  return {
    kind: "line",
    old: { n: oldNumber, text, kind: "ctx" },
    new: { n: newNumber, text, kind: "ctx" },
    pair: null,
    selectable: false,
  };
}

/**
 * One file's rows with the collapsed stretches this reader opened.
 *
 * A stretch is opened from one end at a time: `down` reveals the next
 * {@link REVEAL_STEP} lines below the hunk above, `up` reveals as many above the
 * hunk below, and `all` reveals what is left. The revealed lines are context
 * lines whose text comes from the file content the answer already carries, so no
 * press on a collapsed stretch asks the server anything.
 */
export function revealRows(file: GithubPrFile, gaps: Readonly<Record<string, RevealedGap>>): FileRow[] {
  const rows: FileRow[] = [];
  const content = contentOf(file);
  for (const row of buildRows(file)) {
    if (row.kind === "line") {
      const paired = row.old?.kind === "del" && row.new?.kind === "add" ? subline(row.old.text, row.new.text) : null;
      rows.push({ kind: "line", old: row.old, new: row.new, pair: paired, selectable: true });
      continue;
    }
    const state = gaps[String(row.gap)] ?? { down: 0, up: 0 };
    const down = Math.max(0, Math.min(row.count, state.down));
    const up = Math.max(0, Math.min(row.count - down, state.up));
    for (let k = 0; k < down; k += 1) rows.push(revealedLine(file, row.oldStart + k, row.newStart + k));
    const remaining = row.count - down - up;
    if (remaining > 0) {
      rows.push({
        kind: "gap",
        oldStart: row.oldStart + down,
        newStart: row.newStart + down,
        count: remaining,
        gap: row.gap,
        expandable: content !== null,
      });
    }
    for (let k = 0; k < up; k += 1) {
      rows.push(revealedLine(file, row.oldStart + down + remaining + k, row.newStart + down + remaining + k));
    }
  }
  return rows;
}

/**
 * The reveal state after one press, or `null` when the press changes nothing.
 *
 * `all` reveals what is left from the top, and the two stepped presses reveal
 * {@link REVEAL_STEP} lines from their own end. A press on a stretch that has no
 * more lines to give answers `null`, so the page can skip a redraw.
 */
export function nextReveal(row: GapRow, state: RevealedGap, action: RevealAction): RevealedGap | null {
  const down = Math.max(0, Math.min(row.count, state.down));
  const up = Math.max(0, Math.min(row.count - down, state.up));
  const remaining = row.count - down - up;
  if (remaining <= 0) return null;
  if (action === "all") return { down: down + remaining, up };
  const step = Math.min(REVEAL_STEP, remaining);
  if (action === "down") return { down: down + step, up };
  return { down, up: up + step };
}

/* --------------------------------------------------------------------- tree */

/** A directory of the changed-file tree. */
export interface TreeDirectory {
  readonly kind: "dir";
  readonly name: string;
  readonly children: readonly TreeEntry[];
}

/** One changed file, as the tree lists it. */
export interface TreeLeaf {
  readonly kind: "file";
  readonly name: string;
  /** The file's place in the answer, which is what `#file-<index>` names. */
  readonly index: number;
}

/** One node of the changed-file tree. */
export type TreeEntry = TreeDirectory | TreeLeaf;

/** A directory while it is being built. */
interface Building {
  readonly dirs: Map<string, Building>;
  readonly files: { readonly name: string; readonly index: number }[];
}

/** The name a node sorts by: a directory sorts as `name/`, which is git's order. */
function sortKey(entry: TreeEntry): string {
  return entry.kind === "dir" ? `${entry.name}/` : entry.name;
}

/** The path a file is listed under, which is its new name, or its old one when it is gone. */
export function filePath(file: GithubPrFile): string {
  return file.path ?? file.oldPath ?? "";
}

/**
 * The changed files as a tree, in git's tree-entry order.
 *
 * A directory sorts as if its name ended in `/`, so `src/` comes before `src.ts`
 * and the tree's leaves come out in the same order as the panes, which the server
 * sorted by path. A file whose path is empty or absent is left out: it has no name
 * to draw and no place in the tree.
 */
export function buildTree(files: readonly GithubPrFile[]): TreeEntry[] {
  const root: Building = { dirs: new Map(), files: [] };
  files.forEach((file, index) => {
    const path = filePath(file);
    if (path === "") return;
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node.dirs.get(part);
      if (existing === undefined) {
        const created: Building = { dirs: new Map(), files: [] };
        node.dirs.set(part, created);
        node = created;
        continue;
      }
      node = existing;
    }
    node.files.push({ name, index });
  });
  return convert(root);
}

/** One built directory as tree entries, sorted the way git lists them. */
function convert(node: Building): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const [name, child] of node.dirs) entries.push({ kind: "dir", name, children: convert(child) });
  for (const file of node.files) entries.push({ kind: "file", name: file.name, index: file.index });
  entries.sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return entries;
}

/* ------------------------------------------------------------------ threads */

/** The side of a diff a line is on. */
export type DiffSide = "LEFT" | "RIGHT";

/** The threads that sit on one line of the diff, as one mark. */
export interface ThreadGroup {
  readonly path: string;
  readonly side: DiffSide;
  /** The line the group's mark is drawn on. */
  readonly line: number;
  /** How many threads are on that line. */
  readonly count: number;
  /** `live` when one of them is still open, `resolved` when all are closed. */
  readonly mark: "live" | "resolved";
  /** The thread a press opens: the first open one, or the first one there is. */
  readonly targetId: string;
}

/** An outdated thread, which has no line of the diff left to mark. */
export interface StaleThread {
  readonly thread: GithubPrThread;
  /** The line the thread was written on, on its own side, or `null`. */
  readonly originalLine: number | null;
}

/** Where the marks of a pull request's threads go. */
export interface ThreadPlacement {
  /** The marks, keyed `<path>|<side>|<line>`. */
  readonly groups: ReadonlyMap<string, ThreadGroup>;
  /** The outdated threads, each of which becomes a row of its own. */
  readonly stale: readonly StaleThread[];
  /** The file threads, in the order of the answer. Each becomes a row at the top of its file. */
  readonly files: readonly GithubPrThread[];
}

/** The key of one mark: the file, the side and the line it sits on. */
export function threadKey(path: string, side: DiffSide, line: number): string {
  return `${path}|${side}|${line}`;
}

/**
 * Where each thread of the pull request marks the diff.
 *
 * A thread that still has a line marks that line, and several threads on one line
 * become one mark that says how many there are. A thread whose line is gone is
 * outdated: it keeps the line it was written on (`originalLine`) and becomes a row
 * near it, which is the only place left to show it.
 *
 * A file thread with a path is neither a mark nor an outdated row: GitHub sends
 * line 1 with it, which is not a place the comment is about. It goes to `files`.
 *
 * A thread with no path, or with neither a line nor an original line, marks
 * nothing: there is no place on this page it belongs, and the pull request page
 * lists every thread anyway.
 */
export function placeThreads(threads: readonly GithubPrThread[]): ThreadPlacement {
  const groups = new Map<string, { path: string; side: DiffSide; line: number; threads: GithubPrThread[] }>();
  const stale: StaleThread[] = [];
  const files: GithubPrThread[] = [];
  for (const thread of threads) {
    const path = thread.path ?? "";
    const side = thread.diffSide;
    if (side !== "LEFT" && side !== "RIGHT") continue;
    if (path === "") continue;
    if (isFileThread(thread)) {
      files.push(thread);
      continue;
    }
    const line = thread.startLine ?? thread.line;
    if (line != null) {
      const key = threadKey(path, side, line);
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, { path, side, line, threads: [thread] });
      else existing.threads.push(thread);
      continue;
    }
    if (thread.isOutdated) stale.push({ thread, originalLine: thread.originalLine });
  }
  const placed = new Map<string, ThreadGroup>();
  for (const [key, group] of groups) {
    const live = group.threads.filter((thread) => !thread.isResolved);
    const target = live[0] ?? group.threads[0];
    if (target === undefined) continue;
    placed.set(key, {
      path: group.path,
      side: group.side,
      line: group.line,
      count: group.threads.length,
      mark: live.length > 0 ? "live" : "resolved",
      targetId: target.id,
    });
  }
  return { groups: placed, stale, files };
}

/* ------------------------------------------------------------------- layout */

/** One cell of one row, as the page draws it. */
export interface PlacedCell {
  readonly side: DiffSide;
  readonly line: DiffSideLine;
  /** True when this cell's number may be dragged to leave a review comment. */
  readonly selectable: boolean;
  /** The mark of the review threads on this line, when it has any. */
  readonly bubble: ThreadGroup | null;
  /** The changed middle of the text, as offsets into this cell's own text. */
  readonly segment: { readonly from: number; readonly to: number } | null;
}

/** The comment being written, and where on the file it goes. */
export interface OpenForm {
  readonly index: number;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly line: number;
}

/** One comment a reader collected on this file, with its index in the collection. */
export interface PendingOnFile {
  readonly index: number;
  /** The comment's id, which names its row for the link in the review panel. */
  readonly id: string;
  readonly side: DiffSide;
  readonly startLine: number | null;
  readonly line: number;
  readonly body: string;
  /** True when the code on its line changed since it was written: the row goes to the top of the file. */
  readonly moved: boolean;
  /** The saved text of its line, shown on a moved comment, or `""`. */
  readonly savedText: string;
}

/** A row that spans both panes. */
export type WideRow =
  | {
      readonly kind: "expand";
      /** The file this stretch belongs to. */
      readonly index: number;
      /** Which of that file's stretches it is. */
      readonly gap: number;
      readonly count: number;
      /** False when the server sent no file content, which is a file over 50000 lines. */
      readonly expandable: boolean;
    }
  | {
      readonly kind: "pending";
      readonly index: number;
      readonly id: string;
      readonly side: DiffSide;
      readonly startLine: number | null;
      readonly line: number;
      readonly body: string;
      readonly moved: boolean;
      readonly savedText: string;
    }
  | { readonly kind: "stale"; readonly thread: GithubPrThread; readonly open: boolean }
  | { readonly kind: "fileThread"; readonly thread: GithubPrThread }
  | {
      readonly kind: "form";
      readonly index: number;
      readonly side: DiffSide;
      readonly startLine: number;
      readonly line: number;
      readonly path: string;
    };

/**
 * One row of the grid, in the order the file draws it.
 *
 * A line row's two cells share the row; a wide row is one element across both
 * panes. The row number is what `--row` carries, because both panes are
 * `display: contents` and the grid places the cells themselves.
 */
export type Slot =
  | { readonly kind: "line"; readonly row: number; readonly old: PlacedCell | null; readonly new: PlacedCell | null }
  | { readonly kind: "wide"; readonly row: number; readonly wide: WideRow };

/** Everything one file's layout depends on besides the file itself. */
export interface FileLayoutInput {
  readonly file: GithubPrFile;
  readonly index: number;
  /** The reveal state of each of this file's gaps, by the gap's number. */
  readonly gaps: Readonly<Record<string, RevealedGap>>;
  /** The comments collected on this file's lines, with their index in the collection. */
  readonly pending: readonly PendingOnFile[];
  /** Where the marks of the pull request's threads go. */
  readonly threads: ThreadPlacement;
  /** The comment being written, when it is being written on this file. */
  readonly form: OpenForm | null;
  /** The outdated threads this reader has opened. */
  readonly staleOpen: ReadonlySet<string>;
  /**
   * True when a reader may start a comment on a line, which is what the write
   * switch says. Off means no number is a handle, so no box can open.
   */
  readonly commentable: boolean;
}

/** One file's rows, ready to draw. */
export interface FileLayout {
  readonly slots: readonly Slot[];
  /** How many grid rows the file occupies. */
  readonly rows: number;
}

/**
 * One file's rows, with every full-width row in the place it belongs.
 *
 * A row that spans both panes sits directly under a line of the file: the comment
 * a reader is writing under the line the drag ended on, a collected comment under
 * the line it was written on, and an outdated thread under the line it was written
 * on. A row whose line the diff does not have (an outdated thread on a line that is
 * now revealed away, say) goes to the top of the file, which is where the original
 * put it when its anchor line was gone.
 *
 * Two correspondences make this work. A pending comment or an outdated thread is
 * anchored by the line's number on its own side, which is the same key the mark of
 * a thread uses, so one lookup table serves both. And the grid rows are numbered in
 * the order the slots are listed in, which is the order the grid draws them and the
 * order a reader reads them.
 */
export function layoutFile(input: FileLayoutInput): FileLayout {
  const path = filePath(input.file);
  const rows = revealRows(input.file, input.gaps);

  /**
   * The lines this file's rows draw, keyed the way a mark's key is built.
   *
   * A comment or a thread whose line is not among them has nowhere in the code to
   * sit: its line may be folded away, or the hunk may not reach it. Such a row goes to
   * the top of the file, where a reader sees it, rather than being dropped: losing a
   * comment somebody wrote is not a thing this page may do quietly.
   */
  const drawn = new Set<string>();
  for (const entry of rows) {
    if (entry.kind !== "line") continue;
    if (entry.old !== null) drawn.add(threadKey(path, "LEFT", entry.old.n));
    if (entry.new !== null) drawn.add(threadKey(path, "RIGHT", entry.new.n));
  }

  /** The extra rows of one drawn line, keyed by the line's mark key. */
  const anchored = new Map<string, WideRow[]>();
  const leading: WideRow[] = [];

  /** Put one wide row under the line it names, or at the top when that line is missing. */
  const place = (side: DiffSide, line: number | null, wide: WideRow): void => {
    const key = line === null ? "" : threadKey(path, side, line);
    if (!drawn.has(key)) {
      leading.push(wide);
      return;
    }
    const bucket = anchored.get(key);
    if (bucket === undefined) anchored.set(key, [wide]);
    else bucket.push(wide);
  };

  for (const comment of input.pending) {
    const wide: WideRow = {
      kind: "pending",
      index: comment.index,
      id: comment.id,
      side: comment.side,
      startLine: comment.startLine,
      line: comment.line,
      body: comment.body,
      moved: comment.moved,
      savedText: comment.savedText,
    };
    // A comment whose line holds other code now has no line to sit under.
    if (comment.moved) leading.push(wide);
    else place(comment.side, comment.line, wide);
  }
  for (const stale of input.threads.stale) {
    if ((stale.thread.path ?? "") !== path) continue;
    place(stale.thread.diffSide, stale.originalLine, {
      kind: "stale",
      thread: stale.thread,
      open: input.staleOpen.has(stale.thread.id),
    });
  }
  const form = input.form !== null && input.form.index === input.index ? input.form : null;
  if (form !== null) {
    place(form.side, form.line, {
      kind: "form",
      index: input.index,
      side: form.side,
      startLine: form.startLine,
      line: form.line,
      path,
    });
  }

  const slots: Slot[] = [];
  let row = 0;

  /**
   * Take the next grid row number for one row of the file.
   *
   * Every line and every full-width row takes a number of its own, and none is
   * skipped: the grid places its items by these numbers, so a gap in the sequence
   * would leave an empty line in the middle of the code.
   */
  const nextRow = (): number => {
    row += 1;
    return row;
  };

  for (const thread of input.threads.files) {
    if ((thread.path ?? "") !== path) continue;
    slots.push({ kind: "wide", row: nextRow(), wide: { kind: "fileThread", thread } });
  }
  for (const wide of leading) slots.push({ kind: "wide", row: nextRow(), wide });
  for (const entry of rows) {
    if (entry.kind === "gap") {
      slots.push({
        kind: "wide",
        row: nextRow(),
        wide: {
          kind: "expand",
          index: input.index,
          gap: entry.gap,
          count: entry.count,
          expandable: entry.expandable,
        },
      });
      continue;
    }
    const cell = (side: DiffSide, line: DiffSideLine | null, own: boolean): PlacedCell | null => {
      if (line === null) return null;
      return {
        side,
        line,
        selectable: input.commentable && entry.selectable,
        bubble: input.threads.groups.get(threadKey(path, side, line.n)) ?? null,
        segment: own && entry.pair !== null ? { from: entry.pair.p, to: line.text.length - entry.pair.s } : null,
      };
    };
    const oldCell = cell("LEFT", entry.old, entry.old?.kind === "del");
    const newCell = cell("RIGHT", entry.new, entry.new?.kind === "add");
    slots.push({ kind: "line", row: nextRow(), old: oldCell, new: newCell });
    const under = [
      ...(oldCell === null ? [] : (anchored.get(threadKey(path, "LEFT", oldCell.line.n)) ?? [])),
      ...(newCell === null ? [] : (anchored.get(threadKey(path, "RIGHT", newCell.line.n)) ?? [])),
    ];
    for (const wide of under) slots.push({ kind: "wide", row: nextRow(), wide });
  }
  return { slots, rows: row };
}

/* ------------------------------------------------------ comments and commits */

/** The part of a collected comment that decides where it sits after new commits. */
export interface PlaceableComment {
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number;
  readonly startLine: number | null;
  readonly headSha: string;
  readonly anchor: { readonly first: string; readonly last: string } | null;
}

/** The text of one line of a file on one side, `undefined` past the end, `null` when the answer has no text. */
export function sideText(file: GithubPrFile, side: DiffSide, n: number): string | undefined | null {
  const lines = side === "LEFT" ? file.oldContent : file.newContent;
  if (lines == null) return null;
  return lines[n - 1];
}

/**
 * The text a comment saves with itself: the first and the last line of its range,
 * or `null` when the answer holds no text for that side of the file.
 */
export function anchorOf(
  file: GithubPrFile,
  side: DiffSide,
  startLine: number | null,
  line: number,
): { first: string; last: string } | null {
  const first = sideText(file, side, startLine ?? line);
  const last = sideText(file, side, line);
  if (typeof first !== "string" || typeof last !== "string") return null;
  return { first, last };
}

/**
 * Whether the code under a comment is no longer the code it was written on.
 *
 * Only a comment written on another head commit is compared, and only by the text
 * of the first and the last line of its range. A comment with no saved text, or
 * on a file the answer has no text for, is compared by its line number against the
 * end of the file that the diff shows.
 */
export function commentMoved(file: GithubPrFile, comment: PlaceableComment, headSha: string): boolean {
  if (comment.headSha === "" || comment.headSha === headSha) return false;
  const first = sideText(file, comment.side, comment.startLine ?? comment.line);
  const last = sideText(file, comment.side, comment.line);
  if (first === null || last === null) {
    // No text to compare: only a line past the end of the file's own rows is known to be wrong.
    return comment.line > lastLineOf(file, comment.side);
  }
  if (first === undefined || last === undefined) return true;
  if (comment.anchor === null) return false;
  return comment.anchor.first !== first || comment.anchor.last !== last;
}

/** The highest line number the diff of a file names on one side. */
function lastLineOf(file: GithubPrFile, side: DiffSide): number {
  let top = 0;
  for (const hunk of file.hunks) {
    top = Math.max(top, side === "LEFT" ? hunk.oldStart + hunk.oldLines - 1 : hunk.newStart + hunk.newLines - 1);
  }
  return top;
}

/** The text a moved comment shows: the saved line, or the saved range ends. */
export function savedTextOf(anchor: PlaceableComment["anchor"]): string {
  if (anchor === null) return "";
  return anchor.first === anchor.last ? anchor.last : `${anchor.first} … ${anchor.last}`;
}

/**
 * The folded stretch of a file that holds one line, or `null` when no stretch does.
 *
 * Only a stretch that is still folded counts, so a line that is already drawn
 * answers `null`.
 */
export function stretchHolding(
  file: GithubPrFile,
  gaps: Readonly<Record<string, RevealedGap>>,
  side: DiffSide,
  line: number,
): number | null {
  for (const row of revealRows(file, gaps)) {
    if (row.kind !== "gap") continue;
    const start = side === "LEFT" ? row.oldStart : row.newStart;
    if (line >= start && line < start + row.count) return row.gap;
  }
  return null;
}

/** Where one collected comment stands in a diff answer. */
export interface CommentStanding {
  /** The file's place in the answer, or `-1` when the diff no longer has the file. */
  readonly fileIndex: number;
  readonly moved: boolean;
}

/** Find the file of a collected comment and say whether its line moved. */
export function standingOf(files: readonly GithubPrFile[], comment: PlaceableComment, headSha: string): CommentStanding {
  const fileIndex = files.findIndex((file) => filePath(file) === comment.path);
  const file = files[fileIndex];
  if (file === undefined) return { fileIndex: -1, moved: false };
  return { fileIndex, moved: commentMoved(file, comment, headSha) };
}

/* -------------------------------------------------------------------- title */

/** The name a file is drawn under: a rename says both names. */
export function fileTitle(file: GithubPrFile): string {
  if (file.status === "R" && file.oldPath !== null && file.path !== null) return `${file.oldPath} → ${file.path}`;
  return filePath(file);
}

/** Whether a file shows a note instead of rows: a binary file, or a pure rename. */
export function fileNote(file: GithubPrFile): string | null {
  if (file.binary) return "Binary file not shown";
  if (file.hunks.length === 0 && file.status === "R") return "File renamed without changes";
  return null;
}
