/**
 * One changed file: its header, and its two panes of code.
 *
 * The panes are one CSS grid of four columns (number, old code, number, new code),
 * and every cell carries the grid row it belongs in. Both panes are
 * `display: contents`, so the cells themselves are the grid items: that is what
 * makes the old and the new line of one row line up without measuring anything, and
 * it is why a row's number reaches the stylesheet as the custom property `--row`
 * through a Preact style object. That is a property written through the CSSOM, which
 * the page's `style-src 'self'` policy allows; a `style="…"` attribute written into
 * the markup would be refused.
 *
 * Three rules of the original survive here unchanged:
 *
 * - A line that exists on one side only leaves the other side's cell empty, and the
 *   empty cell is greyed rather than blank, so an added block reads as a block.
 * - A file the reader folded keeps its header and nothing else, which is what the
 *   stylesheet reads from `file-diff collapsed`.
 * - What is drawn comes from the answer and from what the reader did to it (the
 *   stretches they opened, the comments they collected, the marks of the threads),
 *   and never from a measurement of the page.
 *
 * The panes are drawn as two lists of cells with the grid row on each cell rather
 * than as one list of rows holding two cells: a `display: contents` parent cannot
 * carry a grid row for its children, so the row number has to be on the cells
 * themselves. The two lists are built from one list of rows, so they cannot get out
 * of step.
 */
import type { GithubPrFile } from "../api/github-pr.ts";
import { languageForPath } from "./html.tsx";
import {
  CodeLine,
  ExpandRow,
  FormRow,
  LineNumber,
  PendingRow,
  FileThreadRow,
  StaleRow,
  codeCellClass,
  type Segment,
} from "./diff-row.tsx";
import {
  fileNote,
  fileTitle,
  type DiffSide,
  type FileLayout,
  type PlacedCell,
  type Slot,
  type WideRow,
} from "./diff-model.ts";

/** What a press inside one file does, in the page's own words. */
export interface FileActions {
  /** A press on a line number starts a comment selection. */
  readonly onPress: (index: number, side: DiffSide, line: number) => void;
  /** The pointer moving over a line number while a selection is dragged. */
  readonly onEnter: (index: number, side: DiffSide, line: number) => void;
  /** Open more of one folded stretch. */
  readonly onReveal: (index: number, gap: number, action: "down" | "up" | "all") => void;
  /** Fold this file down to its header, or unfold it. */
  readonly onFold: (index: number) => void;
  /** Drop one collected comment. */
  readonly onRemove: (index: number) => void;
  /** Fold or unfold one outdated thread's code. */
  readonly onStale: (id: string) => void;
  /** Close the comment box without collecting anything. */
  readonly onCancel: () => void;
  /** Collect the words of the comment box. */
  readonly onCollect: (body: string) => boolean;
  /** Where the mark of a thread on a line goes. */
  readonly threadHref: (threadId: string) => string;
}

/** What a drag has covered so far, as the numbers it spans on one side. */
export interface Selection {
  readonly side: DiffSide;
  readonly from: number;
  readonly to: number;
}

export interface DiffFileProps {
  readonly file: GithubPrFile;
  readonly index: number;
  readonly layout: FileLayout;
  /** True when the reader folded this file down to its header. */
  readonly folded: boolean;
  /** The numbers this drag has covered, or `null` when nothing is being dragged. */
  readonly selection: Selection | null;
  readonly actions: FileActions;
}

/** What places one cell in the grid: its row number, as the stylesheet reads it. */
function rowStyle(row: number): Record<string, string> {
  return { "--row": String(row) };
}

/** One of the two cells of an empty side, which is greyed so a block reads as a block. */
function EmptyCell({ side, row }: { readonly side: DiffSide; readonly row: number }) {
  return (
    <>
      <div class="num num-empty" style={rowStyle(row)} />
      <div class={codeCellClass(side, null)} style={rowStyle(row)} />
    </>
  );
}

/** One cell of one pane: a line number and the code beside it. */
function PaneCell({
  cell,
  row,
  language,
  selected,
  actions,
  index,
}: {
  readonly cell: PlacedCell;
  readonly row: number;
  readonly language: string | null;
  readonly selected: boolean;
  readonly actions: FileActions;
  readonly index: number;
}) {
  const segment: Segment | null = cell.segment;
  const style = rowStyle(row);
  return (
    <>
      <LineNumber
        style={style}
        line={cell.line.n}
        side={cell.side}
        kind={cell.line.kind}
        selectable={cell.selectable}
        selected={selected}
        bubble={cell.bubble}
        href={(group) => actions.threadHref(group.targetId)}
        onPress={(side, line) => actions.onPress(index, side, line)}
        onEnter={(side, line) => actions.onEnter(index, side, line)}
      />
      <div class={codeCellClass(cell.side, cell.line.kind)} style={style}>
        <CodeLine text={cell.line.text} language={language} segment={segment} side={cell.side} />
      </div>
    </>
  );
}

/** One full-width row: a folded stretch, a pending comment, an outdated thread, or the box. */
function Wide({
  wide,
  row,
  actions,
}: {
  readonly wide: WideRow;
  readonly row: number;
  readonly actions: FileActions;
}) {
  const style = rowStyle(row);
  switch (wide.kind) {
    case "expand":
      return (
        <ExpandRow
          count={wide.count}
          expandable={wide.expandable}
          style={style}
          onReveal={(action) => actions.onReveal(wide.index, wide.gap, action)}
        />
      );
    case "pending":
      return (
        <PendingRow
          index={wide.index}
          side={wide.side}
          startLine={wide.startLine}
          line={wide.line}
          body={wide.body}
          style={style}
          onRemove={actions.onRemove}
        />
      );
    case "stale":
      return (
        <StaleRow
          thread={wide.thread}
          open={wide.open}
          href={actions.threadHref(wide.thread.id)}
          style={style}
          onToggle={actions.onStale}
        />
      );
    case "fileThread":
      return <FileThreadRow thread={wide.thread} href={actions.threadHref(wide.thread.id)} style={style} />;
    case "form":
      return (
        <FormRow
          path={wide.path}
          side={wide.side}
          startLine={wide.startLine}
          line={wide.line}
          style={style}
          onCancel={actions.onCancel}
          onCollect={actions.onCollect}
        />
      );
  }
}

/** The two panes and the full-width rows of one file, in one grid. */
function SplitGrid({
  file,
  index,
  layout,
  selection,
  actions,
}: {
  readonly file: GithubPrFile;
  readonly index: number;
  readonly layout: FileLayout;
  readonly selection: Selection | null;
  readonly actions: FileActions;
}) {
  const language = languageForPath(file.path ?? file.oldPath);
  const covered = (side: DiffSide, line: number): boolean =>
    selection !== null && selection.side === side && line >= selection.from && line <= selection.to;
  const lines = layout.slots.filter((slot): slot is Extract<Slot, { kind: "line" }> => slot.kind === "line");
  const wides = layout.slots.filter((slot): slot is Extract<Slot, { kind: "wide" }> => slot.kind === "wide");
  return (
    <div class="split-grid" data-idx={String(index)}>
      <div class="pane pane-left">
        {lines.map((slot) =>
          slot.old === null ? (
            <EmptyCell key={`lo-${slot.row}`} side="LEFT" row={slot.row} />
          ) : (
            <PaneCell
              key={`lc-${slot.row}`}
              cell={slot.old}
              row={slot.row}
              language={language}
              selected={covered("LEFT", slot.old.line.n)}
              actions={actions}
              index={index}
            />
          ),
        )}
      </div>
      <div class="pane pane-right">
        {lines.map((slot) =>
          slot.new === null ? (
            <EmptyCell key={`ro-${slot.row}`} side="RIGHT" row={slot.row} />
          ) : (
            <PaneCell
              key={`rc-${slot.row}`}
              cell={slot.new}
              row={slot.row}
              language={language}
              selected={covered("RIGHT", slot.new.line.n)}
              actions={actions}
              index={index}
            />
          ),
        )}
      </div>
      {wides.map((slot) => (
        <Wide key={`w-${slot.row}`} wide={slot.wide} row={slot.row} actions={actions} />
      ))}
    </div>
  );
}

/**
 * One changed file.
 *
 * The header is the file's own row of facts: how it changed, its name (both names
 * for a rename), and how many lines it gained and lost. The arrow folds the file
 * down to that header, which is how a reader walks a diff of twenty files.
 */
export function DiffFile({ file, index, layout, folded, selection, actions }: DiffFileProps) {
  const note = fileNote(file);
  const classes = folded ? "file-diff collapsed" : "file-diff";
  return (
    <div class={classes} id={`file-${index}`} data-path={file.path ?? file.oldPath ?? ""}>
      <div class="file-header">
        <button
          class="file-collapse"
          type="button"
          title={folded ? "Expand file" : "Collapse file"}
          aria-expanded={!folded}
          onClick={() => {
            actions.onFold(index);
          }}
        >
          {folded ? "▸" : "▾"}
        </button>
        <span class={`fstat fstat-${file.status}`}>{file.status}</span>
        <span class="file-name">{fileTitle(file)}</span>
        <span class="stats">
          <span class="diff-stat-add">{`+${file.additions}`}</span>{" "}
          <span class="diff-stat-del">{`−${file.deletions}`}</span>
        </span>
      </div>
      {note !== null ? (
        <div class="binary-note">{note}</div>
      ) : layout.slots.length === 0 ? (
        <div class="binary-note">No changes in this file</div>
      ) : (
        <SplitGrid file={file} index={index} layout={layout} selection={selection} actions={actions} />
      )}
    </div>
  );
}
