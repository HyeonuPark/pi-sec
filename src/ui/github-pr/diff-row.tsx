/**
 * One row of a diff: two cells of code, or the full-width row that sits between
 * them.
 *
 * A cell is a line number and a line of code, and three details of how it is drawn
 * are the ones a reader notices when they break:
 *
 * 1. **The code is highlighted, and inside it the change is darker.** The
 *    highlight comes from {@link CodeHtml}, the one component that puts a
 *    highlighted line on a page. The emphasis inside it cannot be a second
 *    highlight: the grammar's own spans may begin and end anywhere, so a changed
 *    stretch cuts across them. It is wrapped instead as a range over the drawn
 *    text nodes, in a layout effect, which is why the tint lands on the exact
 *    characters and the colours underneath survive.
 * 2. **A line number is a handle.** Pressing one starts a comment selection;
 *    moving down the same side of the same file extends it; letting go opens the
 *    comment box under the last line the drag reached. The number is not
 *    selectable text, so a drag across the code copies the code and not the
 *    numbers, and both panes are separate grid cells, so a drag cannot span them.
 * 3. **A thread that sits on the line marks its number.** The mark is a real link
 *    to the thread on the pull request's page, because a thread is a conversation
 *    and that page is where it is read and answered.
 *
 * Every component here takes what it draws as properties and calls back through
 * the functions it is given: the page owns the state, so a row cannot decide on its
 * own to send anything anywhere.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import type { GithubPrThread } from "../api/github-pr.ts";
import { CodeHtml, highlightLine } from "./html.tsx";
import { HunkTable } from "./pr-threads.tsx";
import { REVEAL_STEP, type DiffSide, type ThreadGroup } from "./diff-model.ts";

/* ----------------------------------------------------------------- emphasis */

/** The characters that changed inside a paired line. */
export interface Segment {
  /** Where the change starts, as a character offset into the line. */
  readonly from: number;
  /** Where it ends, as an offset, exclusive. */
  readonly to: number;
}

/** The class each side marks its own change with; both are in the stylesheet. */
export function segmentClass(side: DiffSide): string {
  return side === "LEFT" ? "seg-del" : "seg-add";
}

/**
 * Wrap `[segment.from, segment.to)` of the drawn text in one span.
 *
 * The walk is over text nodes, so a range that starts inside one highlight span and
 * ends inside the next one is wrapped in as many pieces as it covers, and the
 * highlighted markup stays as the grammar wrote it. Every emphasis the previous
 * render made is taken out first, and the text is normalized, so a redraw answers
 * the same page it did before rather than a pile of nested spans.
 */
function emphasise(host: HTMLElement, segment: Segment, side: DiffSide): void {
  const owner = host.ownerDocument;
  const cls = segmentClass(side);
  for (const stale of [...host.querySelectorAll(`span.${cls}`)]) stale.replaceWith(...stale.childNodes);
  host.normalize();
  const start = Math.max(0, segment.from);
  const end = Math.min(host.textContent?.length ?? 0, segment.to);
  if (start >= end) return;
  const walker = owner.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
  const targets: { readonly node: Text; readonly from: number; readonly to: number }[] = [];
  let position = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    const low = Math.max(start, position);
    const high = Math.min(end, position + length);
    if (low < high) targets.push({ node: text, from: low - position, to: high - position });
    position += length;
  }
  for (const target of targets) {
    const range = owner.createRange();
    range.setStart(target.node, target.from);
    range.setEnd(target.node, target.to);
    const span = owner.createElement("span");
    span.className = cls;
    try {
      range.surroundContents(span);
    } catch {
      // A range that cannot be surrounded leaves the text as it is. One missing
      // tint is not worth a broken page.
    }
  }
}

export interface CodeLineProps {
  /** The line's text, as the file has it. */
  readonly text: string;
  /** The language of the file, or `null` for a file the table does not know. */
  readonly language: string | null;
  /** The change inside this line, or `null` when the whole line is the change. */
  readonly segment: Segment | null;
  /** Which pane this cell is in, which decides the tint of its change. */
  readonly side: DiffSide;
}

/**
 * One line of code, highlighted, with the change inside it marked.
 *
 * The HTML comes from {@link highlightLine}, which escapes a line it cannot
 * highlight and refuses one longer than {@link MAX_HIGHLIGHT_LENGTH}. That function
 * is the only way a line of a file becomes markup on this page.
 */
export function CodeLine({ text, language, segment, side }: CodeLineProps) {
  const host = useRef<HTMLSpanElement | null>(null);
  // The emphasis writes to text the page just drew, so it runs after that text is
  // in the page and before the browser paints: a reader never sees the dark patch
  // arrive a frame late.
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null || segment === null) return;
    emphasise(element, segment, side);
  });
  return (
    <span class="code-html" ref={host}>
      <CodeHtml html={highlightLine(text, language)} />
    </span>
  );
}

/* -------------------------------------------------------------------- cells */

export interface LineNumberProps {
  /** The line's number on its side. */
  readonly line: number;
  readonly side: DiffSide;
  /** What the line is, which decides the tint this number gets. */
  readonly kind: "ctx" | "add" | "del";
  /** True when this number may be dragged to leave a review comment. */
  readonly selectable: boolean;
  /** True while this number is inside the range a drag has covered. */
  readonly selected: boolean;
  /** The threads on this line, or `null` when it has none. */
  readonly bubble: ThreadGroup | null;
  /** Where this cell sits in the grid, which the stylesheet reads as `--row`. */
  readonly style: Record<string, string>;
  /** Where the mark of the threads on this line goes. */
  readonly href: (group: ThreadGroup) => string;
  /** A press on the number starts a selection here. */
  readonly onPress: (side: DiffSide, line: number) => void;
  /** The pointer arrives here while a selection is being dragged. */
  readonly onEnter: (side: DiffSide, line: number) => void;
}

/**
 * The number of one line, which is also the handle a review comment starts from.
 *
 * The mark of a thread is drawn here without the write switch, because reading a
 * thread is not writing. What the switch turns off is the start of a new comment,
 * which is what `selectable` carries.
 */
export function LineNumber({
  line,
  side,
  kind,
  selectable,
  selected,
  bubble,
  style,
  href,
  onPress,
  onEnter,
}: LineNumberProps) {
  const classes = numberCellClass(side, kind).split(" ");
  if (selected) classes.push("sel");
  // The press is taken before the browser sees it, so a drag down the numbers
  // starts a comment instead of a text selection that would run into the code
  // beside it. A drag across the code itself still selects text, which is what a
  // reader copying a line does.
  const press = selectable
    ? (event: MouseEvent) => {
        event.preventDefault();
        onPress(side, line);
      }
    : undefined;
  const enter = selectable ? () => onEnter(side, line) : undefined;
  const data = selectable ? { "data-side": side, "data-n": String(line) } : {};
  return (
    <div class={classes.join(" ")} style={style} {...data} onMouseDown={press} onMouseOver={enter}>
      {bubble === null ? (
        line
      ) : (
        <a
          class={`line-bubble ${bubble.mark}`}
          href={href(bubble)}
          title={`${bubble.count} review thread${bubble.count === 1 ? "" : "s"}`}
        >
          {line}
        </a>
      )}
    </div>
  );
}

/** The class of one code cell: which pane it is in, and what the line is. */
export function codeCellClass(side: DiffSide, kind: "ctx" | "add" | "del" | null): string {
  const base = side === "LEFT" ? "code-left" : "code-right";
  if (kind === null) return `${base} cell-empty`;
  if (side === "LEFT" && kind === "del") return `${base} cell-del`;
  if (side === "RIGHT" && kind === "add") return `${base} cell-add`;
  return base;
}

/** The class of one line number, which carries the tint of an added or removed line. */
export function numberCellClass(side: DiffSide, kind: "ctx" | "add" | "del"): string {
  if (side === "LEFT" && kind === "del") return "num num-del";
  if (side === "RIGHT" && kind === "add") return "num num-add";
  return "num";
}

/* ----------------------------------------------------------------- wide rows */

/** One button of a folded stretch. */
export interface RevealButton {
  readonly action: "down" | "up" | "all";
  readonly label: string;
}

/**
 * The buttons a folded stretch offers.
 *
 * A stretch of 30 lines or fewer opens in one press. A longer one offers both ends
 * and the whole of it, which is the rule: a reader who wants
 * the two lines just above the change does not have to read 30 to reach them, and
 * one who wants the middle of a 4000-line file has to ask for it.
 */
export function revealButtons(count: number): RevealButton[] {
  if (count <= REVEAL_STEP) {
    return [{ action: "all", label: `⤡ expand ${count} hidden line${count === 1 ? "" : "s"}` }];
  }
  return [
    { action: "down", label: `⤓ expand ${REVEAL_STEP} more` },
    { action: "all", label: `⋯ ${count} hidden lines ⋯` },
    { action: "up", label: `⤒ expand ${REVEAL_STEP} more` },
  ];
}

export interface ExpandRowProps {
  readonly count: number;
  /** False when the server sent no file content, which is a file over 50000 lines. */
  readonly expandable: boolean;
  /** The grid row this element sits in. */
  readonly style: Record<string, string>;
  readonly onReveal: (action: "down" | "up" | "all") => void;
}

/**
 * A folded stretch, and the buttons that open it.
 *
 * A file whose content the server left out has nothing to open, so it says how many
 * lines are folded and offers no button: the answer really does not hold them, and
 * such a file is not expandable rather than read again.
 */
export function ExpandRow({ count, expandable, style, onReveal }: ExpandRowProps) {
  if (!expandable) {
    return (
      <div class="wide-row expand-row expand-unavailable" style={style}>
        <span class="exp-note">{`${count} hidden line${count === 1 ? "" : "s"} · this file is too large to expand`}</span>
      </div>
    );
  }
  return (
    <div class="wide-row expand-row" style={style}>
      {revealButtons(count).map((button) => (
        <span
          key={button.action}
          class="exp"
          data-act={button.action}
          role="button"
          tabIndex={0}
          onClick={() => {
            onReveal(button.action);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onReveal(button.action);
          }}
        >
          {button.label}
        </span>
      ))}
    </div>
  );
}

/** The lines a comment covers, as one string: `7`, or `7–9`. */
export function lineSpan(startLine: number | null, line: number): string {
  return startLine !== null && startLine !== line ? `${startLine}–${line}` : `${line}`;
}

export interface PendingRowProps {
  /** The comment's place in the collection, which is what `Remove` names. */
  readonly index: number;
  readonly side: DiffSide;
  readonly startLine: number | null;
  readonly line: number;
  readonly body: string;
  /** The grid row this element sits in. */
  readonly style: Record<string, string>;
  readonly onRemove: (index: number) => void;
}

/** One comment a reader collected, under the line it was written on. */
export function PendingRow({ index, side, startLine, line, body, style, onRemove }: PendingRowProps) {
  return (
    <div class="wide-row pending-row" style={style}>
      <div class="pending-comment">
        <span class="pending-badge">Pending</span>
        <span class="pending-loc">{`${side === "LEFT" ? "old" : "new"} ${lineSpan(startLine, line)}`}</span>
        <span class="pending-body">{body}</span>
        <button
          class="btn pending-remove"
          type="button"
          data-pi={String(index)}
          onClick={() => {
            onRemove(index);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export interface StaleRowProps {
  readonly thread: GithubPrThread;
  readonly open: boolean;
  /** Where the thread lives on the pull request's page. */
  readonly href: string;
  /** The grid row this element sits in. */
  readonly style: Record<string, string>;
  readonly onToggle: (id: string) => void;
}

/**
 * An outdated thread: a row where its line used to be.
 *
 * The thread has no line in the current diff, so the honest place for it is the line
 * it was written on, and the diff may not have that line at all. It says which line
 * that was, and the code it was written on stays folded until a reader asks for it:
 * a page that unfolded every outdated thread would bury the diff under code that no
 * longer exists.
 */
export function StaleRow({ thread, open, href, style, onToggle }: StaleRowProps) {
  const count = thread.comments.length;
  const line = thread.originalLine;
  const where = line === null ? "" : `original ${thread.diffSide === "LEFT" ? "old" : "new"} ${lineSpan(thread.originalStartLine, line)}`;
  return (
    <div class={`wide-row stale-row${thread.isResolved ? " resolved" : ""}`} data-thread={thread.id} style={style}>
      <div class="stale-head">
        <span class="flag flag-outdated">Outdated</span>
        {thread.isResolved ? <span class="flag flag-resolved">Resolved</span> : null}
        <span class="stale-loc">{where}</span>
        <button
          class="stale-toggle"
          type="button"
          onClick={() => {
            onToggle(thread.id);
          }}
        >
          {open ? "▾ Hide original code" : "▸ Show original code"}
        </button>
        <a class="stale-link" href={href}>
          {`View thread (${count} comment${count === 1 ? "" : "s"})`}
        </a>
      </div>
      <div class={`stale-hunk${open ? "" : " hidden"}`}>
        <HunkTable diffHunk={thread.diffHunk} />
      </div>
    </div>
  );
}

export interface FileThreadRowProps {
  readonly thread: GithubPrThread;
  /** Where the thread lives on the pull request's page. */
  readonly href: string;
  /** The grid row this element sits in. */
  readonly style: Record<string, string>;
}

/**
 * A file thread: a comment on a whole file, drawn at the top of that file.
 *
 * It has no line and no code, so it has no code toggle. It looks like an outdated
 * thread's row and links to the thread on the pull request's page.
 */
export function FileThreadRow({ thread, href, style }: FileThreadRowProps) {
  const count = thread.comments.length;
  return (
    <div class={`wide-row stale-row file-thread-row${thread.isResolved ? " resolved" : ""}`} data-thread={thread.id} style={style}>
      <div class="stale-head">
        <span class="flag flag-file">File comment</span>
        {thread.isResolved ? <span class="flag flag-resolved">Resolved</span> : null}
        {thread.isOutdated ? <span class="flag flag-outdated">Outdated</span> : null}
        <a class="stale-link" href={href}>
          {`View thread (${count} comment${count === 1 ? "" : "s"})`}
        </a>
      </div>
    </div>
  );
}

export interface FormRowProps {
  readonly path: string;
  readonly side: DiffSide;
  readonly startLine: number;
  readonly line: number;
  /** The grid row this element sits in. */
  readonly style: Record<string, string>;
  readonly onCancel: () => void;
  /** Collect the words written here; `false` means they were empty. */
  readonly onCollect: (body: string) => boolean;
}

/**
 * The box a review comment is written in, under the lines it is written on.
 *
 * Nothing is sent from here. `Add to review` collects the words into this tab, which
 * is what the page draws as `Pending` and what `Submit review` sends in one request;
 * that is the whole reason a review is collected rather than posted line by line.
 */
export function FormRow({ path, side, startLine, line, style, onCancel, onCollect }: FormRowProps) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    field.current?.focus();
  }, []);
  const where = startLine === line ? `line ${line}` : `lines ${startLine}–${line}`;
  return (
    <div class="wide-row review-form-row" style={style}>
      <div class="review-form">
        <div class="review-form-title">
          {"Review comment on "}
          <code>{path}</code>
          {` ${where} (${side === "LEFT" ? "old" : "new"} side)`}
        </div>
        <textarea ref={field} placeholder="Leave a review comment…" aria-label="Review comment" />
        <div class="reply-actions">
          <button class="btn cancel-btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            class="btn btn-primary submit-btn"
            type="button"
            onClick={() => {
              onCollect(field.current?.value ?? "");
            }}
          >
            Add to review
          </button>
        </div>
      </div>
    </div>
  );
}
