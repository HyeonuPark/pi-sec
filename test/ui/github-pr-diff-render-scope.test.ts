// @vitest-environment jsdom
/**
 * What each action on the diff page draws again.
 *
 * The page is drawn from source in jsdom and the components that draw are counted
 * through Preact's render hook, so the test says how much work an action costs and
 * not how long it takes on one machine. A cell that draws again is a `PaneCellView`
 * call; a file is a `DiffFileView` call and its grid is a `SplitGridView` call.
 * The numbers in the test names are the completion conditions of the change.
 */
import { options, render, h } from "preact";
import hljs from "highlight.js/lib/common";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type State = typeof import("../../src/ui/github-pr/diff-state.ts");
type Page = typeof import("../../src/ui/github-pr/diff-page.tsx");
type Html = typeof import("../../src/ui/github-pr/html.tsx");

let state: State;
let page: Page;
let html: Html;

/** One render, as the hook sees it: the component's name and the properties it got. */
interface Drawn {
  readonly name: string;
  readonly props: Record<string, unknown>;
}

let drawn: Drawn[] = [];

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** The renders since the last reset, by component name. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of drawn) out[entry.name] = (out[entry.name] ?? 0) + 1;
  return out;
}

function cellsOf(): Drawn[] {
  return drawn.filter((entry) => entry.name === "PaneCellView");
}

function line(t: "ctx" | "add" | "del", s: string) {
  return { t, s };
}

/**
 * A file with `pairs` changed rows between three context lines on each side and a
 * folded stretch of twenty lines before and after.
 */
function fileWith(path: string, pairs: number, tag: string) {
  const lines = [line("ctx", `${tag} before 1`), line("ctx", `${tag} before 2`), line("ctx", `${tag} before 3`)];
  for (let i = 0; i < pairs; i += 1) {
    lines.push(line("del", `const ${tag}v = ${i % 10};`), line("add", `const ${tag}v = ${(i + 1) % 10};`));
  }
  lines.push(line("ctx", `${tag} after 1`), line("ctx", `${tag} after 2`), line("ctx", `${tag} after 3`));
  const total = 26 + pairs + 20;
  const content = Array.from({ length: total }, (_v, k) => `${tag} line ${k + 1}`);
  return {
    path,
    oldPath: path,
    status: "M" as const,
    binary: false,
    hunks: [{ oldStart: 21, oldLines: 6 + pairs, newStart: 21, newLines: 6 + pairs, section: "", lines }],
    additions: pairs,
    deletions: pairs,
    oldContent: content,
    newContent: content,
  };
}

function answerOf(pairs: number, tag: string, files = 3) {
  return {
    repo: "acme/widgets",
    number: 12,
    title: "A diff",
    baseRef: "main",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    mergeBase: "3".repeat(40),
    files: Array.from({ length: files }, (_v, k) => fileWith(`src/f${k}.ts`, pairs, `${tag}${k}`)),
  };
}

function thread(id: string, path: string, over: Record<string, unknown> = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path,
    line: 24,
    startLine: null,
    originalLine: 24,
    originalStartLine: null,
    diffSide: "RIGHT",
    diffHunk: null,
    comments: [],
    ...over,
  };
}

let host: HTMLElement;

async function mountPage(pairs: number, tag: string): Promise<void> {
  state.answer.value = answerOf(pairs, tag) as never;
  render(h(page.View, {}), host);
  await sleep();
  drawn = [];
}

beforeAll(async () => {
  document.head.innerHTML = "";
  document.body.innerHTML = `<script id="github-pr-meta" type="application/json">${JSON.stringify({
    viewer: "octocat",
    repos: [{ repo: "acme/widgets" }],
    writes: true,
  })}</script><div id="root"></div>`;
  history.pushState({}, "", "/github/pr/acme/widgets/12/diff");
  state = await import("../../src/ui/github-pr/diff-state.ts");
  page = await import("../../src/ui/github-pr/diff-page.tsx");
  html = await import("../../src/ui/github-pr/html.tsx");
  // Installed after the page's modules, so it sits outside the signals hook.
  const previous = (options as unknown as { __r?: (vnode: unknown) => void }).__r;
  (options as unknown as { __r: (vnode: unknown) => void }).__r = (vnode) => {
    const node = vnode as { type: unknown; props: Record<string, unknown> };
    if (typeof node.type === "function") {
      const fn = node.type as { displayName?: string; name?: string };
      const name = fn.displayName ?? fn.name ?? "";
      if (!name.startsWith("Memo")) drawn.push({ name, props: node.props });
    }
    previous?.(vnode);
  };
});

beforeEach(() => {
  host = document.getElementById("root") as HTMLElement;
  state.drag.value = null;
  state.openForm.value = null;
  state.folded.value = new Set();
  state.revealed.value = {};
  state.staleOpen.value = new Set();
  state.threads.value = [];
  state.pending.value = [];
  state.activeFile.value = 0;
  state.reviewSummary.value = "";
  state.answer.value = null;
});

afterEach(() => {
  render(null, host);
});

describe("render scope of the diff page", () => {
  for (const pairs of [100, 2000]) {
    it(`condition 1: a drag step in a file of ${pairs} changed rows draws at most 2 cells and no other file`, async () => {
      await mountPage(pairs, `c1x${pairs}`);
      state.beginSelection(0, "RIGHT", 30);
      await sleep();
      drawn = [];
      state.extendSelection(0, "RIGHT", 31);
      await sleep();
      const c = counts();
      expect(c.PaneCellView ?? 0).toBeLessThanOrEqual(2);
      expect(c.PaneCellView ?? 0).toBeGreaterThan(0);
      expect(c.SplitGridView).toBe(1);
      expect(c.DiffFileView ?? 0).toBe(0);
      expect(cellsOf().every((entry) => entry.props.index === 0)).toBe(true);
    }, 120000);
  }

  it("condition 2: a drag that enters the same line again draws nothing", async () => {
    await mountPage(20, "c2");
    state.beginSelection(0, "RIGHT", 30);
    state.extendSelection(0, "RIGHT", 31);
    await sleep();
    drawn = [];
    state.extendSelection(0, "RIGHT", 31);
    await sleep();
    expect(drawn.length).toBe(0);
  });

  it("condition 3: a key in the overall comment draws no cell and no file", async () => {
    await mountPage(20, "c3");
    state.reviewSummary.value = "a";
    await sleep();
    const c = counts();
    expect(c.PaneCellView ?? 0).toBe(0);
    expect(c.DiffFileView ?? 0).toBe(0);
    expect(c.SplitGridView ?? 0).toBe(0);
    expect(c.DiffBody ?? 0).toBe(0);
    expect(c.ReviewPanel).toBe(1);
  });

  it("condition 4: a change of the current file draws no cell and no file", async () => {
    await mountPage(20, "c4");
    state.setActiveFile(2);
    await sleep();
    const c = counts();
    expect(c.PaneCellView ?? 0).toBe(0);
    expect(c.DiffFileView ?? 0).toBe(0);
    expect(c.TreeView).toBe(1);
  });

  it("condition 5: folding and unfolding one file draws no cell", async () => {
    await mountPage(20, "c5");
    state.toggleFile(1);
    await sleep();
    expect(counts().PaneCellView ?? 0).toBe(0);
    expect(counts().DiffFileView).toBe(1);
    expect(document.querySelectorAll(".file-diff.collapsed").length).toBe(1);
    drawn = [];
    state.toggleFile(1);
    await sleep();
    expect(counts().PaneCellView ?? 0).toBe(0);
    expect(document.querySelectorAll(".file-diff.collapsed").length).toBe(0);
  });

  it("condition 6: the box, Cancel, Add to review, expand and outdated code draw no cell of another file", async () => {
    await mountPage(20, "c6");
    state.threads.value = [
      thread("T1", "src/f0.ts", { line: null, originalLine: 24, isOutdated: true }),
    ] as never;
    await sleep();
    const others = (): void => {
      expect(cellsOf().filter((entry) => entry.props.index !== 0)).toEqual([]);
      expect(drawn.filter((entry) => entry.name === "DiffFileView" && entry.props.index !== 0)).toEqual([]);
    };
    drawn = [];
    state.beginSelection(0, "RIGHT", 24);
    state.releaseSelection();
    await sleep();
    expect(document.querySelectorAll(".review-form-row").length).toBe(1);
    others();
    drawn = [];
    state.cancelForm();
    await sleep();
    others();
    state.beginSelection(0, "RIGHT", 24);
    state.releaseSelection();
    await sleep();
    drawn = [];
    expect(state.collectComment("a note")).toBe(true);
    await sleep();
    others();
    drawn = [];
    state.revealGap(0, 0, "all");
    await sleep();
    others();
    expect(cellsOf().length).toBeGreaterThan(0);
    drawn = [];
    state.toggleStale("T1");
    await sleep();
    others();
  });

  it("condition 6 (rows): a box that opens above rows draws their numbers and none of their code", async () => {
    await mountPage(40, "c6r");
    state.beginSelection(0, "RIGHT", 24);
    state.releaseSelection();
    await sleep();
    const c = counts();
    expect(c.PaneCellView ?? 0).toBeGreaterThan(0);
    expect(c.CodeLineView ?? 0).toBe(0);
    expect(c.FormRow).toBe(1);
  });

  it("condition 7: a second answer with the same content draws no cell and highlights nothing", async () => {
    await mountPage(20, "c7");
    const spy = vi.spyOn(hljs, "highlight");
    state.answer.value = structuredClone(state.answer.value) as never;
    await sleep();
    expect(counts().PaneCellView ?? 0).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("condition 8: one render calls highlight.js once per distinct line text", async () => {
    const spy = vi.spyOn(hljs, "highlight");
    const answer = answerOf(30, "c8");
    const distinct = new Set<string>();
    for (const file of answer.files) for (const entry of file.hunks[0]!.lines) distinct.add(entry.s);
    state.answer.value = answer as never;
    render(h(page.View, {}), host);
    await sleep();
    expect(distinct.size).toBeLessThan(answer.files.length * 66);
    expect(spy).toHaveBeenCalledTimes(distinct.size);
    spy.mockRestore();
  });

  it("condition 9: a drag step and a key in the overall comment edit no code cell", async () => {
    await mountPage(20, "c9");
    const edits: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as Node;
        const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
        if (element?.closest(".code-left, .code-right") != null) edits.push(record);
      }
    });
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    state.beginSelection(0, "RIGHT", 26);
    await sleep();
    state.extendSelection(0, "RIGHT", 27);
    await sleep();
    state.reviewSummary.value = "abc";
    await sleep();
    observer.takeRecords();
    observer.disconnect();
    expect(document.querySelectorAll(".num.sel").length).toBeGreaterThan(0);
    expect(edits.length).toBe(0);
  });

  it("condition 10: the emphasis markup is what the old page edit made", () => {
    const language = "typescript";
    /** The edit the page made after each draw, kept here as the reference. */
    const reference = (text: string, from: number, to: number, cls: string): string => {
      const box = document.createElement("span");
      box.innerHTML = html.highlightLine(text, language);
      const start = Math.max(0, from);
      const end = Math.min(box.textContent?.length ?? 0, to);
      if (start < end) {
        const walker = document.createTreeWalker(box, 4);
        const targets: { node: Text; from: number; to: number }[] = [];
        let position = 0;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const text = node as Text;
          const low = Math.max(start, position);
          const high = Math.min(end, position + text.data.length);
          if (low < high) targets.push({ node: text, from: low - position, to: high - position });
          position += text.data.length;
        }
        for (const target of targets) {
          const range = document.createRange();
          range.setStart(target.node, target.from);
          range.setEnd(target.node, target.to);
          const span = document.createElement("span");
          span.className = cls;
          range.surroundContents(span);
        }
      }
      return box.innerHTML;
    };
    /** The markup as the browser writes it back, so only the tree is compared. */
    const normal = (markup: string): string => {
      const box = document.createElement("span");
      box.innerHTML = markup;
      return box.innerHTML;
    };
    const samples = [
      'const value = "text" + other; // note',
      "if (a < b && c > 'x') { return `t&${y}`; }",
      "  return items.map((item) => item.name).join(', ');",
      "plain words only",
      "",
      'x = "é 한글 &amp; <b>";',
    ];
    let checked = 0;
    let crossing = 0;
    for (const text of samples) {
      const plain = html.highlightLine(text, language);
      const n = text.length;
      for (let from = -1; from <= n + 1; from += 1) {
        for (let to = from; to <= n + 2; to += 1) {
          for (const cls of ["seg-add", "seg-del"]) {
            const got = html.emphasiseHtml(plain, from, Math.min(n, to), cls);
            expect(normal(got)).toBe(reference(text, from, to, cls));
            checked += 1;
            if ((got.match(new RegExp(`class="${cls}"`, "g"))?.length ?? 0) > 1) crossing += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(crossing).toBeGreaterThan(0);
    expect(html.highlightCell("a < b", language, { from: 0, to: 3 }, "seg-add")).toContain('<span class="seg-add">');
  }, 120000);

  /** One collected comment, with the fields the review draft adds. */
  function collected(id: string, path: string, line: number, over: Record<string, unknown> = {}) {
    return { id, path, side: "RIGHT", line, startLine: null, body: `note ${id}`, headSha: "2".repeat(40), anchor: null, ...over };
  }

  it("condition 18: a press on a link to a comment that is already drawn renders no cell and no file", async () => {
    await mountPage(20, "c18");
    state.pending.value = [collected("p1", "src/f0.ts", 24)] as never;
    await sleep();
    expect(document.querySelectorAll('[data-pending-id="p1"]').length).toBe(1);
    drawn = [];
    state.jumpToComment("p1");
    await sleep();
    expect(drawn.length).toBe(0);
    expect(document.activeElement).toBe(document.querySelector('[data-pending-id="p1"]'));
  });

  it("condition 19: a press that unfolds a file and opens a stretch renders no cell of another file", async () => {
    await mountPage(20, "c19");
    state.pending.value = [collected("p2", "src/f1.ts", 5)] as never;
    await sleep();
    state.toggleFile(1);
    await sleep();
    const numbers = (): string[] =>
      [...document.querySelectorAll('.split-grid[data-idx="1"] .pane-right .num')].map((e) => e.textContent ?? "");
    expect(document.querySelectorAll(".file-diff.collapsed").length).toBe(1);
    expect(numbers()).not.toContain("5");
    drawn = [];
    state.jumpToComment("p2");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cellsOf().length).toBeGreaterThan(0);
    expect(cellsOf().filter((entry) => entry.props.index !== 1)).toEqual([]);
    expect(drawn.filter((entry) => entry.name === "DiffFileView" && entry.props.index !== 1)).toEqual([]);
    expect(document.querySelectorAll(".file-diff.collapsed").length).toBe(0);
    expect(numbers()).toContain("5");
    expect(document.activeElement).toBe(document.querySelector('[data-pending-id="p2"]'));
  });

  it("condition 20: typing in the overall comment and a change of the save state render no cell and no file, with links in the panel", async () => {
    const drafts = await import("../../src/ui/state/github-pr-draft.ts");
    await mountPage(20, "c20");
    state.pending.value = [collected("p3", "src/f0.ts", 24), collected("p4", "src/f2.ts", 24)] as never;
    await sleep();
    expect(document.querySelectorAll(".review-link").length).toBe(2);
    drawn = [];
    state.reviewSummary.value = "typing";
    drafts.draftFailed.value = true;
    await sleep();
    drafts.draftFailed.value = false;
    await sleep();
    const c = counts();
    expect(c.PaneCellView ?? 0).toBe(0);
    expect(c.DiffFileView ?? 0).toBe(0);
    expect(c.SplitGridView ?? 0).toBe(0);
    expect(c.DiffBody ?? 0).toBe(0);
    expect(c.ReviewPanel).toBeGreaterThan(0);
  });
});
