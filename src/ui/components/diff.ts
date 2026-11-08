/**
 * One comparison of two report revisions, drawn as elements.
 *
 * The old viewer built this as a string and put it in the article with
 * `innerHTML`. The rewrite cannot do that, and
 * does not want to: a line's text comes from a revision body, which is a file on
 * disk, and a string built by hand is one escaping mistake away from markup. Here
 * every text is a text node, so `<b>` in a revision stays three characters.
 *
 * The elements and their classes are the ones the stylesheet already names:
 * `.diff-hunk`, `.diff-head`, `.diff-line` with `diff-same` / `diff-add` /
 * `diff-remove`, `.diff-mark`, `.diff-body`, and `.diff-word` for the words that
 * changed inside a paired line.
 *
 * A paired line arrives with its `segments`, and joining them gives the line's
 * text back; a line the word pass declined arrives whole and is drawn whole.
 */
import { Fragment, h, type ComponentChild } from "preact";
import type { LineDiff, DiffLine } from "../../shared/wire/reports.ts";

/** The character in the mark column: a mark per kind, and a space for an unchanged line. */
function markOf(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "−";
  return " ";
}

/** One line, with the words that changed marked when the server paired it. */
function diffLineVNode(line: DiffLine, index: number): ComponentChild {
  const body =
    line.segments === undefined
      ? line.text
      : line.segments.map((segment, at) =>
          segment.changed ? h("span", { class: "diff-word", key: at }, segment.text) : segment.text,
        );
  return h(
    "div",
    { class: `diff-line diff-${line.kind}`, key: index },
    h("span", { class: "diff-mark" }, markOf(line.kind)),
    h("span", { class: "diff-body" }, body),
  );
}

/**
 * The comparison: one line about what changed, then a block per hunk.
 *
 * The line above the hunks carries the counts and says when the pair was too
 * large to align, or when the largest lines were compared whole. Two revisions
 * with the same text say so instead of drawing an empty diff.
 */
export function diffVNode(diff: LineDiff): ComponentChild {
  if (diff.identical) return h("p", { class: "report-empty" }, "These two revisions are identical.");
  const note =
    (diff.truncated === true ? " · too large to align; shown as a wholesale replacement" : "") +
    (diff.wordDiffTruncated === true ? " · the largest lines are shown whole" : "");
  return h(
    Fragment,
    null,
    h("p", { class: "report-hint" }, `+${diff.added} −${diff.removed}${note}`),
    ...diff.hunks.map((hunk, index) =>
      h(
        "div",
        { class: "diff-hunk", key: index },
        h("div", { class: "diff-head" }, `@@ −${hunk.fromStart},${hunk.fromCount} +${hunk.toStart},${hunk.toCount} @@`),
        ...hunk.lines.map(diffLineVNode),
      ),
    ),
  );
}
