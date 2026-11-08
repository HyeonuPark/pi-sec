/**
 * Line diff for report revisions.
 *
 * Written by hand rather than pulled in, because the requirement is small and
 * bounded: two revisions of one markdown document, shown side by side. A
 * dependency would have to be vetted for the same job, and the whole feature
 * would then rest on it.
 *
 * The algorithm is LCS over lines. That is quadratic in the worst case, so the
 * input is reduced first: the common prefix and suffix are stripped, and if what
 * remains is still too big the pair is reported as one wholesale replacement
 * rather than grinding through a table that would not fit any better.
 *
 * A paired remove and add go through the same alignment once more, over tokens,
 * so the client can mark the words that changed instead of the whole line. That
 * second pass is bounded per line and per request, and it never overrides the
 * line-level result: a pair it declines is simply left whole.
 */

export type DiffLineKind = "same" | "add" | "remove";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 1-based line number in the earlier revision; absent for an addition. */
  readonly fromLine?: number;
  /** 1-based line number in the later revision; absent for a removal. */
  readonly toLine?: number;
  /**
   * The line cut into pieces, each marked as changed or not. Present only when
   * this line was paired with a line on the other side of the hunk; joining the
   * texts gives back `text`.
   */
  segments?: Array<{ text: string; changed: boolean }>;
}

export interface DiffHunk {
  readonly fromStart: number;
  readonly fromCount: number;
  readonly toStart: number;
  readonly toCount: number;
  readonly lines: readonly DiffLine[];
}

export interface LineDiff {
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  readonly identical: boolean;
  /** True when the pair was too large to align and is reported as a full replacement. */
  readonly truncated: boolean;
  /** True when the word pass ran out of budget and left the remaining pairs line level. */
  readonly wordDiffTruncated: boolean;
}

/**
 * Ceiling on the alignment table, in cells. 4M cells is a 16 MB `Uint32Array` —
 * a 2000x2000 line pair. Beyond that a report is not being read line by line
 * anyway.
 */
const MAX_CELLS = 4_000_000;

/**
 * Ceilings on the word pass, which aligns token arrays rather than lines.
 * A longer line stays whole (`MAX_WORD_LINE`); one pair costs at most
 * `MAX_WORD_CELLS`, and the whole request at most `MAX_WORD_BUDGET`. The pair
 * ceiling is below `MAX_CELLS` on purpose: `align` reports an over-large table
 * as `undefined`, and at this ceiling it cannot do so for a line pair.
 */
const MAX_WORD_LINE = 4_000;
const MAX_WORD_CELLS = 250_000;
const MAX_WORD_BUDGET = 4_000_000;

const DEFAULT_CONTEXT = 3;

/** Split into lines the way a text editor does: `\n`, with a trailing newline not adding a line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { readonly kind: DiffLineKind; readonly a: number; readonly b: number };

/** Align two line ranges with an LCS table. Returns `undefined` when too large. */
function align(a: readonly string[], b: readonly string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    const ops: Op[] = [];
    for (let i = 0; i < n; i += 1) ops.push({ kind: "remove", a: i, b: 0 });
    for (let j = 0; j < m; j += 1) ops.push({ kind: "add", a: n, b: j });
    return ops;
  }
  if (n * m > MAX_CELLS) return undefined;

  const width = m + 1;
  // Length of the longest common subsequence of the two suffixes.
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", a: i, b: j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: "remove", a: i, b: j });
      i += 1;
    } else {
      ops.push({ kind: "add", a: i, b: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", a: i, b: j });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", a: i, b: j });
    j += 1;
  }
  return ops;
}

/**
 * Split a line into tokens without losing a character: a run of whitespace, a
 * run of letters, marks and digits, and any other single character each become
 * one token. Joining the tokens gives the line back.
 */
const TOKEN = /(\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}])/gu;
const WORD = /^[\p{L}\p{N}\p{M}]+$/u;
const MARK = /^\p{M}$/u;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

type Segment = { text: string; changed: boolean };

interface WordBudget {
  /** Cells the request may still spend on token alignment. */
  left: number;
  /** Set once a pair was left line level because the budget was gone. */
  hit: boolean;
}

/**
 * Mark the code points of two words that differ. The shared prefix and suffix
 * stay unmarked, so a particle (보고서가 / 보고서를) or an ending
 * (report / reports) marks only the letters that moved. With nothing in common
 * the whole word is marked: a coarser highlight, never a lost letter.
 */
function wordMarks(before: string, after: string): { before: boolean[]; after: boolean[] } {
  const a = [...before];
  const b = [...after];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  // A combining mark belongs to the letter in front of it, so a cut moves off it.
  while (head > 0 && MARK.test(a[head] ?? "")) head -= 1;
  while (tail > 0 && MARK.test(a[a.length - tail] ?? "")) tail -= 1;
  const marks = (chars: readonly string[]): boolean[] => chars.map((_, index) => index >= head && index < chars.length - tail);
  return { before: marks(a), after: marks(b) };
}

/** Piece one side of a pair together from its tokens and their change marks. */
function toSegments(tokens: readonly string[], marks: readonly (readonly boolean[] | null)[]): Segment[] {
  const out: Segment[] = [];
  const append = (text: string, changed: boolean): void => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && last.changed === changed) out[out.length - 1] = { text: last.text + text, changed };
    else out.push({ text, changed });
  };
  tokens.forEach((token, index) => {
    const flags = marks[index] ?? null;
    if (flags === null) {
      append(token, false);
      return;
    }
    let run = "";
    let runChanged = flags[0] ?? false;
    for (const [position, char] of [...token].entries()) {
      const changed = flags[position] ?? false;
      if (changed !== runChanged) {
        append(run, runChanged);
        run = "";
        runChanged = changed;
      }
      run += char;
    }
    append(run, runChanged);
  });
  return out;
}

/**
 * Word segments for one paired line, or `undefined` when the pair stays line
 * level. The size tests run before `align`, because `align` reports an
 * over-large table as `undefined`, and at the top of `diffLines` that one value
 * means a wholesale replacement.
 */
function wordSegments(before: string, after: string, budget: WordBudget): { before: Segment[]; after: Segment[] } | undefined {
  if (before.length > MAX_WORD_LINE || after.length > MAX_WORD_LINE) return undefined;
  const a = tokenize(before);
  const b = tokenize(after);
  const cells = a.length * b.length;
  if (cells > MAX_WORD_CELLS) return undefined;
  if (cells > budget.left) {
    budget.hit = true;
    return undefined;
  }
  budget.left -= cells;
  const ops = align(a, b);
  if (ops === undefined) return undefined;

  const marksA: (boolean[] | null)[] = a.map(() => null);
  const marksB: (boolean[] | null)[] = b.map(() => null);
  for (let index = 0; index < ops.length; ) {
    if (ops[index]!.kind === "same") {
      index += 1;
      continue;
    }
    // A run of removes and the adds that follow it pair token by token.
    const removed: number[] = [];
    const added: number[] = [];
    while (index < ops.length && ops[index]!.kind !== "same") {
      const op = ops[index]!;
      if (op.kind === "remove") removed.push(op.a);
      else added.push(op.b);
      index += 1;
    }
    for (let k = 0; k < removed.length; k += 1) {
      const oldToken = a[removed[k]!]!;
      const newToken = k < added.length ? b[added[k]!]! : null;
      if (newToken !== null && WORD.test(oldToken) && WORD.test(newToken)) {
        const marks = wordMarks(oldToken, newToken);
        marksA[removed[k]!] = marks.before;
        marksB[added[k]!] = marks.after;
      } else {
        marksA[removed[k]!] = [...oldToken].map(() => true);
        if (newToken !== null) marksB[added[k]!] = [...newToken].map(() => true);
      }
    }
    for (let k = removed.length; k < added.length; k += 1) {
      marksB[added[k]!] = [...b[added[k]!]!].map(() => true);
    }
  }
  return { before: toSegments(a, marksA), after: toSegments(b, marksB) };
}

interface Numbered {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly fromLine?: number;
  readonly toLine?: number;
}

function numberOps(ops: readonly Op[], a: readonly string[], b: readonly string[], aOffset: number, bOffset: number): Numbered[] {
  const out: Numbered[] = [];
  for (const op of ops) {
    if (op.kind === "remove") {
      out.push({ kind: "remove", text: a[op.a]!, fromLine: aOffset + op.a + 1 });
    } else if (op.kind === "add") {
      out.push({ kind: "add", text: b[op.b]!, toLine: bOffset + op.b + 1 });
    } else {
      out.push({ kind: "same", text: a[op.a]!, fromLine: aOffset + op.a + 1, toLine: bOffset + op.b + 1 });
    }
  }
  return out;
}

/** Group a flat edit script into hunks, merging changes closer than twice the context. */
function toHunks(lines: readonly Numbered[], contextLines: number): DiffHunk[] {
  const changed: number[] = [];
  for (let index = 0; index < lines.length; index += 1) if (lines[index]!.kind !== "same") changed.push(index);
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor]!;
    let last = first;
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= contextLines * 2) {
      cursor += 1;
      last = changed[cursor]!;
    }
    const start = Math.max(0, first - contextLines);
    const end = Math.min(lines.length - 1, last + contextLines);
    const slice = lines.slice(start, end + 1);

    const fromLines = slice.filter((line) => line.kind !== "add");
    const toLines = slice.filter((line) => line.kind !== "remove");
    hunks.push({
      fromStart: fromLines[0]?.fromLine ?? 0,
      fromCount: fromLines.length,
      toStart: toLines[0]?.toLine ?? 0,
      toCount: toLines.length,
      lines: slice,
    });
    cursor += 1;
  }
  return hunks;
}

/**
 * Pair the removes and adds inside one hunk and attach word segments to both
 * sides of a pair.
 *
 * A group is a run of changed lines in which every remove comes before every
 * add; context lines are ignored, so `remove, same, add` is one group. That case
 * is real: `x\ny\n` → `y\nx\n` aligns as exactly that. Groups whose two counts
 * differ stay line level, because an index pairing across different counts would
 * match lines that have nothing to do with each other.
 */
function pairHunk(hunk: DiffHunk, budget: WordBudget): DiffHunk {
  const lines: DiffLine[] = hunk.lines.slice();
  const changed: number[] = [];
  for (let index = 0; index < lines.length; index += 1) if (lines[index]!.kind !== "same") changed.push(index);

  let cursor = 0;
  while (cursor < changed.length) {
    const start = cursor;
    let seenAdd = false;
    while (cursor < changed.length) {
      const kind = lines[changed[cursor]!]!.kind;
      if (kind === "add") seenAdd = true;
      else if (seenAdd) break; // a remove after an add opens the next group
      cursor += 1;
    }
    const group = changed.slice(start, cursor);
    const removes = group.filter((index) => lines[index]!.kind === "remove");
    const adds = group.filter((index) => lines[index]!.kind === "add");
    if (removes.length > 0 && removes.length === adds.length) {
      for (let k = 0; k < removes.length; k += 1) {
        const oldIndex = removes[k]!;
        const newIndex = adds[k]!;
        const pair = wordSegments(lines[oldIndex]!.text, lines[newIndex]!.text, budget);
        if (pair === undefined) continue;
        lines[oldIndex] = { ...lines[oldIndex]!, segments: pair.before };
        lines[newIndex] = { ...lines[newIndex]!, segments: pair.after };
      }
    }
  }
  return { ...hunk, lines };
}

/** A unified-style line diff between two revisions. */
export function diffLines(before: string, after: string, contextLines = DEFAULT_CONTEXT): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  if (before === after) {
    return { hunks: [], added: 0, removed: 0, identical: true, truncated: false, wordDiffTruncated: false };
  }

  // Strip the shared ends so the table only covers the part that actually differs.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }

  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  const aligned = align(midA, midB);
  const truncated = aligned === undefined;

  const ops: Op[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ kind: "same", a: i, b: i });
  if (aligned === undefined) {
    for (let i = 0; i < midA.length; i += 1) ops.push({ kind: "remove", a: head + i, b: head });
    for (let j = 0; j < midB.length; j += 1) ops.push({ kind: "add", a: tailA, b: head + j });
  } else {
    for (const op of aligned) ops.push({ kind: op.kind, a: op.a + head, b: op.b + head });
  }
  for (let k = 0; k < a.length - tailA; k += 1) {
    ops.push({ kind: "same", a: tailA + k, b: tailB + k });
  }

  const numbered = numberOps(ops, a, b, 0, 0);
  let added = 0;
  let removed = 0;
  for (const line of numbered) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }

  const budget: WordBudget = { left: MAX_WORD_BUDGET, hit: false };
  // A wholesale replacement has no matched lines to pair, and the token pass
  // would repeat the work the line pass just refused.
  const hunks = toHunks(numbered, contextLines).map((hunk) => (truncated ? hunk : pairHunk(hunk, budget)));

  return {
    hunks,
    added,
    removed,
    identical: added === 0 && removed === 0,
    truncated,
    wordDiffTruncated: budget.hit,
  };
}
