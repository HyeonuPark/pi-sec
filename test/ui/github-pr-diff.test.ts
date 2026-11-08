/**
 * The diff page, drawn from a fake answer.
 *
 * Eleven rules of this page are the ones a reader notices when they break, and each
 * group below covers one of them:
 *
 * 1. Every state a changed file can be in is drawn: added, modified, deleted,
 *    renamed, and a binary file the diff cannot show.
 * 2. The change inside a paired line is marked, and only that part of it.
 * 3. A folded stretch opens 30 lines at a time or all at once, and a file whose
 *    content the server left out (over 50000 lines) offers no button at all.
 * 4. The tab's own copy of the diff is drawn before the server answers, which is the
 *    whole reason the session store exists.
 * 5. The read that started last is the one that draws, so a slow answer cannot put
 *    older data over newer.
 * 6. The review controls exist only while the write switch is on.
 * 7. Comments are collected in the tab, removed one at a time or all at once, and
 *    sent in one `POST` when the review is submitted.
 * 8. A page that is only being read sends no write at all.
 * 9. A disk-limit refusal is stated with the sizes it carries, rather than drawn as
 *    an empty diff.
 * 10. A thread marks the line it sits on, and the mark links to the thread on the
 *     pull request's page.
 * 11. The file tree lists every changed file and marks the one the panes show.
 *
 * The page is loaded the way the server and the browser load it: the real shell from
 * `src/web/github-pr-diff.html`, the stamps the server writes, the meta block,
 * `base.js`, and the test bundle of the real entry module.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildUi, ROOT } from "../../scripts/build-ui.mjs";
import { STORE_PREFIX, commitStoreKey, diffStoreKey, pendingStoreKey } from "../../src/ui/state/github-pr.ts";
import { buildRows, nextReveal, readDiffRoute, revealRows, subline, type GapRow } from "../../src/ui/github-pr/diff-model.ts";

/* ------------------------------------------------------------------ fixtures */

/** What `github-pr-meta` holds when writes are on. */
const META_WRITES = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: true };

/** What it holds when writes are off. */
const META_READ_ONLY = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: false };

/** The path of the diff route, and of the pull request route beside it. */
const DIFF_PATH = "/api/github/pr/acme/widgets/12/diff";
const PR_PATH = "/api/github/pr/acme/widgets/12";
const REVIEW_PATH = "/api/github/pr/acme/widgets/12/review";

/** One hunk line: context, removed or added. */
function line(t: "ctx" | "add" | "del", s: string) {
  return { t, s };
}

/** The lines of a numbered file, as the server sends a whole file. */
function numbered(count: number, changed: Readonly<Record<number, string>> = {}): string[] {
  return Array.from({ length: count }, (_value, index) => changed[index + 1] ?? `line ${index + 1}`);
}

/** One comment of a review thread. */
function comment(id: string, author: string, body: string) {
  return {
    id,
    author,
    body,
    createdAt: "2026-10-29T09:00:00Z",
    url: `https://github.com/acme/widgets/pull/12#discussion_r${id}`,
    reactions: [],
  };
}

/**
 * The diff answer, as the route writes it.
 *
 * Six files, which together carry every state the page distinguishes: an added file,
 * a modified one with a paired line and a short folded stretch above it, a deleted
 * one, a rename with no change, a binary file, and a file with a stretch of 100 lines
 * folded away and one of 4 after its last hunk.
 */
function diffAnswer(over: Partial<Record<string, unknown>> = {}) {
  const fluxOld = numbered(13, { 11: "  const a = 1;" });
  const fluxNew = numbered(13, { 11: "  const a = 2;" });
  return {
    repo: "acme/widgets",
    number: 12,
    title: "Fix the flux capacitor",
    baseRef: "main",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    mergeBase: "3333333333333333333333333333333333333333",
    files: [
      {
        path: "src/added.ts",
        oldPath: null,
        status: "A",
        binary: false,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, section: "", lines: [line("add", "export const one = 1;"), line("add", "export const two = 2;")] }],
        additions: 2,
        deletions: 0,
        newContent: ["export const one = 1;", "export const two = 2;"],
      },
      {
        path: "src/flux.ts",
        oldPath: "src/flux.ts",
        status: "M",
        binary: false,
        hunks: [
          {
            oldStart: 10,
            oldLines: 4,
            newStart: 10,
            newLines: 4,
            section: "function flux() {",
            lines: [
              line("ctx", "function flux() {"),
              line("del", "  const a = 1;"),
              line("add", "  const a = 2;"),
              line("ctx", "  return a;"),
              line("ctx", "}"),
            ],
          },
        ],
        additions: 1,
        deletions: 1,
        oldContent: fluxOld,
        newContent: fluxNew,
      },
      {
        path: "src/gone.ts",
        oldPath: "src/gone.ts",
        status: "D",
        binary: false,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, section: "", lines: [line("del", "export const gone = 1;"), line("del", "export const alsoGone = 2;")] }],
        additions: 0,
        deletions: 2,
        oldContent: ["export const gone = 1;", "export const alsoGone = 2;"],
      },
      { path: "src/to.ts", oldPath: "src/from.ts", status: "R", binary: false, hunks: [], additions: 0, deletions: 0 },
      { path: "assets/logo.png", oldPath: "assets/logo.png", status: "M", binary: true, hunks: [], additions: 0, deletions: 0 },
      {
        path: "src/long.ts",
        oldPath: "src/long.ts",
        status: "M",
        binary: false,
        hunks: [{ oldStart: 101, oldLines: 2, newStart: 101, newLines: 2, section: "", lines: [line("del", "line 101 old"), line("add", "line 101 new")] }],
        additions: 1,
        deletions: 1,
        oldContent: numbered(105),
        newContent: numbered(105),
      },
    ],
    ...over,
  };
}

/** The pull request's answer, of which this page reads only the threads. */
function prAnswer(over: Partial<Record<string, unknown>> = {}) {
  return {
    repo: "acme/widgets",
    id: "PR_kw1",
    number: 12,
    title: "Fix the flux capacitor",
    body: "",
    url: "https://github.com/acme/widgets/pull/12",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-28T09:00:00Z",
    author: "octocat",
    additions: 12,
    deletions: 3,
    changedFiles: 6,
    baseRefName: "main",
    headRefName: "flux-fix",
    headRefOid: "2222222222222222222222222222222222222222",
    labels: [],
    reactions: [],
    comments: [],
    reviews: [],
    threads: [
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        path: "src/flux.ts",
        line: 12,
        startLine: 12,
        originalLine: null,
        originalStartLine: null,
        diffSide: "RIGHT",
        diffHunk: "@@ -10,3 +10,3 @@\n function flux() {\n-  const a = 1;\n+  const a = 2;",
        comments: [comment("t1c1", "reviewer", "Why 2?")],
      },
      {
        id: "T2",
        isResolved: false,
        isOutdated: true,
        path: "src/flux.ts",
        line: null,
        startLine: null,
        originalLine: 13,
        originalStartLine: null,
        diffSide: "LEFT",
        diffHunk: "@@ -12,2 +12,2 @@\n-  return a;\n+  return a + 0;",
        comments: [comment("t2c1", "reviewer", "This used to return a"), comment("t2c2", "octocat", "It still does")],
      },
    ],
    ciState: null,
    checks: [],
    ...over,
  };
}

/* ------------------------------------------------------------------- harness */

type Answer = { status?: number; body?: unknown };
type Reply = Answer | (() => Answer | Promise<Answer>);

interface Call {
  readonly path: string;
  readonly method: string;
  /** The body a write sent, as it was sent. */
  readonly body: string | null;
}

interface Page {
  readonly window: JSDOM["window"];
  readonly document: Document;
  readonly calls: Call[];
  respond(path: string, reply: Reply): void;
  settle(): Promise<void>;
  close(): void;
}

/** The test bundles, built once for the whole file. */
let bundles: Promise<Record<string, string>> | undefined;

function bundle(): Promise<Record<string, string>> {
  bundles ??= buildUi({ root: ROOT, mode: "test" }).then((result) => result.code as Record<string, string>);
  return bundles;
}

/** A JSON data block, written as the server writes it: `<` escaped, never run. */
function block(id: string, value: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`;
}

/** The shell with the server's stamps and the meta block in it. */
async function shell(options: { readonly base?: string; readonly meta?: unknown; readonly metaBlock?: boolean }): Promise<string> {
  const base = options.base ?? "";
  let html = await readFile(join(ROOT, "src/web/github-pr-diff.html"), "utf8");
  html = html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, '<meta name="pi-sec-timezone" content="Asia/Tokyo" />');
  html = html.replace("<!--github-pr-meta-->", options.metaBlock === false ? "" : block("github-pr-meta", options.meta ?? META_WRITES));
  return html;
}

/** Load the diff page with the server faked. */
async function openDiff(
  options: {
    readonly base?: string;
    readonly meta?: unknown;
    readonly metaBlock?: boolean;
    readonly path?: string;
    readonly replies?: Readonly<Record<string, Reply>>;
    /** Run before the page's bundle, so a test can plant what a tab already held. */
    readonly before?: (window: JSDOM["window"]) => void;
  } = {},
): Promise<Page> {
  const code = await bundle();
  const source = code["github-pr-diff"];
  if (source === undefined) throw new Error("the test build has no github-pr-diff page bundle");

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });

  const dom = new JSDOM(await shell(options), {
    url: `http://localhost${options.path ?? "/github/pr/acme/widgets/12/diff"}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const calls: Call[] = [];
  const replies = new Map<string, Reply>(Object.entries(options.replies ?? {}));

  (window as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({
      path: url.pathname + url.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ?? null,
    });
    const reply = replies.get(url.pathname + url.search) ?? replies.get(url.pathname) ?? { status: 200, body: {} };
    const answer = typeof reply === "function" ? await reply() : reply;
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  // This page opens no stream of its own; a stand-in is here so a page that started
  // one would show up rather than throw.
  (window as unknown as { EventSource: unknown }).EventSource = class {
    constructor(readonly url: string) {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  };

  options.before?.(window);
  window.eval(await readFile(join(ROOT, "src/web/base.js"), "utf8"));
  window.eval(source);

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();

  return {
    window,
    document: window.document,
    calls,
    respond(path, reply) {
      replies.set(path, reply);
    },
    settle,
    close() {
      dom.window.close();
    },
  };
}

/** The file headers' status letters, in the order the page drew the files. */
function statuses(document: Document): string[] {
  return [...document.querySelectorAll(".file-header .fstat")].map((element) => element.textContent ?? "");
}

/** The file headers' names, in the order the page drew the files. */
function names(document: Document): string[] {
  return [...document.querySelectorAll(".file-header .file-name")].map((element) => element.textContent ?? "");
}

/** The labels of the tree's file rows. */
function treeLabels(document: Document): string[] {
  return [...document.querySelectorAll(".tree-file .tree-name")].map((element) => element.textContent ?? "");
}

/** The line numbers one pane of one file drew, in order. */
function numbersIn(document: Document, index: number, side: "left" | "right"): string[] {
  const grid = document.querySelector(`.split-grid[data-idx="${index}"] .pane-${side}`);
  return [...(grid?.querySelectorAll(".num") ?? [])].map((element) => element.textContent ?? "");
}

/** Dispatch one mouse event on an element, the way a browser would. */
function fire(window: JSDOM["window"], target: EventTarget, type: string, init: MouseEventInit = {}): void {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** Drag from one line number to another on one side, and let go. */
async function dragLines(page: Page, index: number, side: "LEFT" | "RIGHT", from: number, to: number): Promise<void> {
  const start = page.document.querySelector(`.split-grid[data-idx="${index}"] .num[data-side="${side}"][data-n="${from}"]`);
  const end = page.document.querySelector(`.split-grid[data-idx="${index}"] .num[data-side="${side}"][data-n="${to}"]`);
  if (!(start instanceof page.window.HTMLElement)) throw new Error(`no line number ${side} ${from}`);
  if (!(end instanceof page.window.HTMLElement)) throw new Error(`no line number ${side} ${to}`);
  fire(page.window, start, "mousedown", { button: 0 });
  await page.settle();
  fire(page.window, end, "mouseover");
  await page.settle();
  fire(page.window, page.window, "mouseup");
  await page.settle();
}

/** Type into one textarea, the way a reader does. */
async function type(page: Page, field: HTMLTextAreaElement, text: string): Promise<void> {
  field.value = text;
  field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await page.settle();
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

/* ------------------------------------------------------- the arithmetic alone */

describe("the rows of a file", () => {
  it("pairs a run of removed lines with the run of added lines after it", () => {
    const file = {
      path: "src/a.ts",
      oldPath: "src/a.ts",
      status: "M" as const,
      binary: false,
      additions: 1,
      deletions: 2,
      oldContent: numbered(6),
      newContent: numbered(5),
      hunks: [
        {
          oldStart: 2,
          oldLines: 4,
          newStart: 2,
          newLines: 3,
          section: "",
          lines: [
            line("del", "old one"),
            line("del", "old two"),
            line("add", "new one"),
            line("ctx", "stays"),
            line("ctx", "also stays"),
          ],
        },
      ],
    };
    const rows = buildRows(file);
    // Two gap rows: the line before the hunk and the one after it.
    expect(rows.map((row) => row.kind)).toEqual(["gap", "line", "line", "line", "line", "gap"]);
    const paired = rows.filter((row) => row.kind === "line");
    // The shorter run leaves the second row's new side empty.
    expect(paired.map((row) => (row.kind === "line" ? [row.old?.text ?? null, row.new?.text ?? null] : []))).toEqual([
      ["old one", "new one"],
      ["old two", null],
      ["stays", "stays"],
      ["also stays", "also stays"],
    ]);
  });

  it("counts the stretch after the last hunk on the side that still has a file", () => {
    const file = {
      path: "src/a.ts",
      oldPath: null,
      status: "A" as const,
      binary: false,
      additions: 1,
      deletions: 0,
      newContent: numbered(40),
      hunks: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: "", lines: [line("add", "one")] },
      ],
    };
    const gaps = buildRows(file).filter((row) => row.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind === "gap" ? gaps[0].count : 0).toBe(39);
  });

  it("shares nothing between two lines that have nothing in common", () => {
    expect(subline("abc", "xyz")).toBeNull();
    expect(subline("const a = 1;", "const a = 2;")).toEqual({ p: 10, s: 1 });
    // A line that only grew keeps its whole prefix.
    expect(subline("abc", "abcdef")).toEqual({ p: 3, s: 0 });
  });

  it("opens a stretch from either end and never past its end", () => {
    const row: GapRow = { kind: "gap", oldStart: 1, newStart: 1, count: 45, gap: 0, expandable: true };
    const down = nextReveal(row, { down: 0, up: 0 }, "down");
    expect(down).toEqual({ down: 30, up: 0 });
    const up = nextReveal(row, { down: 30, up: 0 }, "up");
    expect(up).toEqual({ down: 30, up: 15 });
    // Nothing is left after that, and a further press answers nothing to do.
    expect(nextReveal(row, { down: 30, up: 15 }, "down")).toBeNull();
    expect(nextReveal(row, { down: 0, up: 0 }, "all")).toEqual({ down: 45, up: 0 });
  });

  it("offers nothing to reveal when the answer carries no file content", () => {
    const file = {
      path: "src/a.ts",
      oldPath: "src/a.ts",
      status: "M" as const,
      binary: false,
      additions: 1,
      deletions: 1,
      oldContent: null,
      newContent: null,
      hunks: [
        {
          oldStart: 40,
          oldLines: 2,
          newStart: 40,
          newLines: 2,
          section: "",
          lines: [line("del", "old"), line("add", "new")],
        },
      ],
    };
    const gaps = revealRows(file, {}).filter((row) => row.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind === "gap" ? gaps[0].expandable : true).toBe(false);
  });

  it("reads the diff's own address, with the mount prefix taken off", () => {
    expect(readDiffRoute("/github/pr/acme/widgets/12/diff", "")).toEqual({ repo: "acme/widgets", number: 12 });
    expect(readDiffRoute("/sec/github/pr/acme/widgets/12/diff", "/sec")).toEqual({ repo: "acme/widgets", number: 12 });
    // The pull request's own page and the list are not this page.
    expect(readDiffRoute("/github/pr/acme/widgets/12", "")).toBeNull();
    expect(readDiffRoute("/github/pr/", "")).toBeNull();
    // A percent-encoded repository is decoded, and a broken one is refused.
    expect(readDiffRoute("/github/pr/acme%2Fwidgets/x/3/diff", "")).toEqual({ repo: "acme/widgets/x", number: 3 });
  });
});

/* --------------------------------------------------------------------- tests */

describe("the files the diff draws", () => {
  it("draws every state a changed file can be in", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      // Added, modified, deleted, renamed, binary, and the file with long stretches.
      expect(statuses(page.document)).toEqual(["A", "M", "D", "R", "M", "M"]);
      expect(names(page.document)).toEqual([
        "src/added.ts",
        "src/flux.ts",
        "src/gone.ts",
        "src/from.ts → src/to.ts",
        "assets/logo.png",
        "src/long.ts",
      ]);
      // A binary file says so instead of drawing rows, and a rename with no change
      // says that.
      const notes = [...page.document.querySelectorAll(".binary-note")].map((note) => note.textContent);
      expect(notes).toEqual(["File renamed without changes", "Binary file not shown"]);
      // A line that exists on one side only leaves the other side's cell greyed.
      const added = page.document.querySelector('.split-grid[data-idx="0"]');
      expect(added?.querySelectorAll(".code-left.cell-empty")).toHaveLength(2);
      expect(added?.querySelectorAll(".code-right.cell-add")).toHaveLength(2);
      // The line counts of the header.
      const stats = [...page.document.querySelectorAll('.file-diff[data-path="src/flux.ts"] .stats span')].map(
        (element) => element.textContent,
      );
      expect(stats).toEqual(["+1", "−1"]);
      // Every grid cell carries the row it belongs in, and both cells of one row
      // carry the same number: that is what lines the panes up without measuring.
      const grid = page.document.querySelector('.split-grid[data-idx="1"]');
      const left = [...(grid?.querySelectorAll(":scope > .pane-left > *") ?? [])];
      const right = [...(grid?.querySelectorAll(":scope > .pane-right > *") ?? [])];
      const rowOf = (element: Element): string => (element as HTMLElement).style.getPropertyValue("--row");
      expect(left.map(rowOf)).toEqual(["2", "2", "3", "3", "4", "4", "5", "5"]);
      expect(right.map(rowOf)).toEqual(left.map(rowOf));
      // The folded stretch takes the first row, which is what `--row: 1` says.
      expect(rowOf(grid?.querySelector(".expand-row") as HTMLElement)).toBe("1");
    } finally {
      page.close();
    }
  });

  it("marks the change inside a paired line, and only that part of it", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const grid = page.document.querySelector('.split-grid[data-idx="1"]');
      // `  const a = 1;` became `  const a = 2;`, so one side marks the `1` and the
      // other the `2`, and the words both lines share stay unmarked.
      const removed = grid?.querySelector(".seg-del");
      const added = grid?.querySelector(".seg-add");
      expect(removed?.textContent).toBe("1");
      expect(added?.textContent).toBe("2");
      // The mark sits inside the drawn code and the highlighted markup is intact.
      expect(removed?.closest(".code-left")).not.toBeNull();
      expect(added?.closest(".code-right")).not.toBeNull();
      expect(grid?.querySelectorAll(".seg-del, .seg-add")).toHaveLength(2);
      // The lines around it are not marked at all.
      const context = grid?.querySelectorAll(".code-left")[0];
      expect(context?.querySelector(".seg-del")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("highlights by the file's extension, and leaves a very long line alone", async () => {
    const long = `const value = ${"9".repeat(1200)};`;
    const answer = diffAnswer({
      files: [
        {
          path: "src/big.ts",
          oldPath: "src/big.ts",
          status: "M",
          binary: false,
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, section: "", lines: [line("add", "const small = 1;"), line("add", long)] }],
          additions: 2,
          deletions: 0,
          newContent: ["const small = 1;", long],
        },
      ],
    });
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: answer } } });
    try {
      const cells = [...page.document.querySelectorAll('.split-grid[data-idx="0"] .code-right')];
      // The grammar knows `typescript`, and the short line carries its spans.
      expect(cells[0]?.querySelector(".hljs-keyword")?.textContent).toBe("const");
      // A line over 1000 characters is escaped and drawn plain: highlighting a
      // minified bundle costs more than the colour is worth.
      expect(cells[1]?.querySelector(".hljs-keyword")).toBeNull();
      expect(cells[1]?.textContent).toBe(long);
    } finally {
      page.close();
    }
  });
});

describe("a folded stretch", () => {
  it("opens a short one in one press, from the file content it already has", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const grid = page.document.querySelector('.split-grid[data-idx="1"]');
      // Lines 1 to 9 are folded above the first hunk, and 9 lines is one press.
      const buttons = [...(grid?.querySelectorAll(".expand-row .exp") ?? [])];
      expect(grid?.querySelectorAll(".expand-row")).toHaveLength(1);
      expect(buttons.map((button) => button.textContent)).toEqual(["⤡ expand 9 hidden lines"]);
      // The first line the pane draws is the hunk's own, because the stretch above
      // it is folded into one row.
      expect(numbersIn(page.document, 1, "right")[0]).toBe("10");
      if (!(buttons[0] instanceof page.window.HTMLElement)) throw new Error("no expand button");
      buttons[0].click();
      await page.settle();
      // The nine lines are drawn with their numbers, and no stretch is left.
      expect(numbersIn(page.document, 1, "right").slice(0, 10)).toEqual([
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
      ]);
      expect(page.document.querySelector('.split-grid[data-idx="1"] .expand-row')).toBeNull();
      // Their text came from the file the answer carried, and the server was not
      // asked again.
      expect(page.calls.filter((call) => call.path === DIFF_PATH)).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("offers both ends and all of it for a long one, thirty lines at a time", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const index = 5;
      // The labels of the stretch above the first hunk, which is the first of the
      // two stretches this file has (4 lines after the hunk are folded as well).
      const labels = (): (string | null)[] =>
        [...((page.document.querySelector(`.split-grid[data-idx="${index}"] .expand-row`)?.querySelectorAll(".exp")) ?? [])].map(
          (button) => button.textContent,
        );
      expect(page.document.querySelectorAll(`.split-grid[data-idx="${index}"] .expand-row`)).toHaveLength(2);
      // 100 lines are folded above the first hunk of the last file.
      expect(labels()).toEqual(["⤓ expand 30 more", "⋯ 100 hidden lines ⋯", "⤒ expand 30 more"]);
      const first = page.document.querySelector(`.split-grid[data-idx="${index}"] .expand-row .exp[data-act="down"]`);
      if (!(first instanceof page.window.HTMLElement)) throw new Error("no expand-down button");
      first.click();
      await page.settle();
      // Thirty more lines are drawn, and the middle button counts what is left.
      expect(numbersIn(page.document, index, "right").slice(0, 30)).toEqual(
        Array.from({ length: 30 }, (_value, at) => String(at + 1)),
      );
      expect(labels()).toEqual(["⤓ expand 30 more", "⋯ 70 hidden lines ⋯", "⤒ expand 30 more"]);
      const all = page.document.querySelector(`.split-grid[data-idx="${index}"] .expand-row .exp[data-act="all"]`);
      if (!(all instanceof page.window.HTMLElement)) throw new Error("no expand-all button");
      all.click();
      await page.settle();
      // The rest of that stretch is drawn; only the four lines after the last hunk
      // are still folded.
      expect(numbersIn(page.document, index, "right")[99]).toBe("100");
      // The four lines after the last hunk are still folded, and they are now the
      // only stretch left in the file, so one press opens them.
      expect(labels()).toEqual(["⤡ expand 4 hidden lines"]);
      const tail = page.document.querySelector(`.split-grid[data-idx="${index}"] .expand-row .exp`);
      if (!(tail instanceof page.window.HTMLElement)) throw new Error("no tail button");
      tail.click();
      await page.settle();
      expect(page.document.querySelector(`.split-grid[data-idx="${index}"] .expand-row`)).toBeNull();
    } finally {
      page.close();
    }
  });

  it("offers no button at all for a file whose content the server left out", async () => {
    // A file over 50000 lines arrives without its content: both sides are null, and
    // the page has nothing to reveal. That is the payload the server sends, which is
    // why this fixture carries no content rather than 50001 lines.
    const answer = diffAnswer({
      files: [
        {
          path: "src/huge.ts",
          oldPath: "src/huge.ts",
          status: "M",
          binary: false,
          hunks: [
            { oldStart: 50010, oldLines: 2, newStart: 50010, newLines: 2, section: "", lines: [line("del", "old"), line("add", "new")] },
          ],
          additions: 1,
          deletions: 1,
          oldContent: null,
          newContent: null,
        },
      ],
    });
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: answer } } });
    try {
      const row = page.document.querySelector('.split-grid[data-idx="0"] .expand-row');
      expect(row?.className).toContain("expand-unavailable");
      expect(Math.round(Number((row?.querySelector(".exp-note")?.textContent ?? "").match(/\d+/)?.[0] ?? "0"))).toBe(50009);
      // Nothing to press: the answer really does not hold the lines.
      expect(page.document.querySelector('.split-grid[data-idx="0"] .expand-row .exp')).toBeNull();
    } finally {
      page.close();
    }
  });
});

describe("the tab's own copy of a diff", () => {
  it("is drawn before the server answers, and the read still runs", async () => {
    const page = await openDiff({
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: () => new Promise<Answer>(() => {}) },
      before: (window) => {
        window.sessionStorage.setItem(
          `${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`,
          JSON.stringify(diffAnswer({ title: "From the tab's own copy" })),
        );
      },
    });
    try {
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("From the tab's own copy");
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
      // The copy is where the diff was when the reader left it, so the page asks
      // anyway.
      expect(page.calls.map((call) => call.path)).toContain(DIFF_PATH);
    } finally {
      page.close();
    }
  });

  it("keeps the answer under the fixed key prefix", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const key = `${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`;
      const stored = JSON.parse(page.window.sessionStorage.getItem(key) ?? "null");
      expect(stored.title).toBe("Fix the flux capacitor");
      expect(stored.files).toHaveLength(6);
    } finally {
      page.close();
    }
  });

  it("treats a stored value it cannot read as a miss", async () => {
    const page = await openDiff({
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
      before: (window) => {
        window.sessionStorage.setItem(`${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`, JSON.stringify({ number: 12 }));
      },
    });
    try {
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Fix the flux capacitor");
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
    } finally {
      page.close();
    }
  });
});

describe("the reads the page makes", () => {
  it("draws the answer of the read that started last, and drops the earlier one", async () => {
    let releaseSlow: ((answer: Answer) => void) | null = null;
    let slow = true;
    const page = await openDiff({
      replies: {
        [PR_PATH]: { body: prAnswer() },
        [DIFF_PATH]: () =>
          slow
            ? new Promise<Answer>((resolve) => {
                releaseSlow = resolve;
                slow = false;
              })
            : { body: diffAnswer({ title: "The newer read" }) },
      },
    });
    try {
      // The page's own read is still held; `⟳ Reload` starts a second one.
      const reload = page.document.querySelector("#reload");
      if (!(reload instanceof page.window.HTMLElement)) throw new Error("no reload button");
      reload.click();
      await page.settle();
      expect(page.calls.filter((call) => call.path === DIFF_PATH)).toHaveLength(2);
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("The newer read");

      releaseSlow!({ body: diffAnswer({ title: "The older read" }) });
      await page.settle();
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("The newer read");
    } finally {
      page.close();
    }
  });

  it("says the address names no diff when it does not, and asks nothing", async () => {
    const page = await openDiff({ path: "/github/pr/acme/widgets/12" });
    try {
      expect(page.document.querySelector("#view .empty")?.textContent).toBe("This address does not name a diff.");
      expect(page.calls).toEqual([]);
    } finally {
      page.close();
    }
  });

  it("reads under the mount it is served from", async () => {
    const page = await openDiff({
      base: "/sec",
      path: "/sec/github/pr/acme/widgets/12/diff",
      replies: {
        "/sec/api/github/pr/acme/widgets/12": { body: prAnswer() },
        "/sec/api/github/pr/acme/widgets/12/diff": { body: diffAnswer() },
      },
    });
    try {
      expect(page.calls.map((call) => call.path).sort()).toEqual([
        "/sec/api/github/pr/acme/widgets/12",
        "/sec/api/github/pr/acme/widgets/12/diff",
      ]);
      expect(page.document.querySelector(".side-nav-btn")?.getAttribute("href")).toBe("/sec/github/pr/acme/widgets/12");
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });
});

describe("a disk-limit refusal", () => {
  it("states the three sizes instead of drawing an empty diff", async () => {
    const page = await openDiff({
      replies: {
        [PR_PATH]: { body: prAnswer() },
        [DIFF_PATH]: {
          status: 409,
          body: { error: "disk_limit", currentMegabytes: 1024, estimateMegabytes: 2000, limitMegabytes: 2048 },
        },
      },
    });
    try {
      expect(page.document.querySelector("#disk-limit")).not.toBeNull();
      expect(page.document.querySelector("#disk-limit-sentence")?.textContent).toContain(
        "this repository's diff was not fetched",
      );
      expect(page.document.querySelector("#disk-limit-current")?.textContent).toBe("In use now: 1024 MB");
      expect(page.document.querySelector("#disk-limit-estimate")?.textContent).toBe(
        "This repository is estimated at: 2000 MB",
      );
      expect(page.document.querySelector("#disk-limit-limit")?.textContent).toBe("Limit: 2048 MB");
      // No diff is drawn, and the sentence is not an error: nothing failed.
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(0);
      expect(page.document.querySelector("#error-banner")?.className).toBe("error-banner hidden");
    } finally {
      page.close();
    }
  });

  it("puts any other refusal in the strip and keeps what is drawn", async () => {
    const kept = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    let stored = "";
    try {
      stored = kept.window.sessionStorage.getItem(`${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`) ?? "";
    } finally {
      kept.close();
    }
    const page = await openDiff({
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { status: 502, body: { error: "git: could not fetch" } } },
      before: (window) => {
        window.sessionStorage.setItem(`${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`, stored);
      },
    });
    try {
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("git: could not fetch");
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
    } finally {
      page.close();
    }
  });
});

describe("the marks of the review threads", () => {
  it("marks the line a thread sits on, and links to the thread's own page", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const marked = page.document.querySelector('.split-grid[data-idx="1"] .num[data-side="RIGHT"][data-n="12"]');
      const bubble = marked?.querySelector(".line-bubble");
      expect(bubble?.className).toBe("line-bubble live");
      expect(bubble?.textContent).toBe("12");
      // The mark is a real link, with the thread's id in the anchor.
      expect(bubble?.getAttribute("href")).toBe("/github/pr/acme/widgets/12#thread-T1");
      expect(bubble?.getAttribute("title")).toBe("1 review thread");
    } finally {
      page.close();
    }
  });

  it("draws a file thread as one row at the top of its file, with no mark on line 1", async () => {
    const base = prAnswer();
    const fileThread = {
      id: "T9",
      isResolved: false,
      isOutdated: false,
      path: "src/added.ts",
      line: 1,
      startLine: null,
      originalLine: 1,
      originalStartLine: null,
      diffSide: "RIGHT",
      subjectType: "FILE",
      diffHunk: "",
      comments: [comment("t9c1", "reviewer", "Rename this file")],
    };
    const page = await openDiff({
      replies: { [PR_PATH]: { body: { ...base, threads: [...base.threads, fileThread] } }, [DIFF_PATH]: { body: diffAnswer() } },
    });
    try {
      const grid = page.document.querySelector('.split-grid[data-idx="0"]');
      expect(grid?.querySelector(".line-bubble")).toBeNull();
      expect(grid?.querySelector(".stale-row")?.getAttribute("data-thread")).toBe("T9");
      const rows = grid?.querySelectorAll(".file-thread-row") ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.querySelector(".flag-file")?.textContent).toBe("File comment");
      expect(rows[0]?.querySelector(".stale-link")?.getAttribute("href")).toBe("/github/pr/acme/widgets/12#thread-T9");
      expect(rows[0]?.querySelector(".stale-link")?.textContent).toBe("View thread (1 comment)");
      expect(rows[0]?.querySelector(".stale-toggle")).toBeNull();
      // The row takes grid row 1, above the first line of code.
      expect((rows[0] as HTMLElement | undefined)?.style.getPropertyValue("--row")).toBe("1");
      expect(grid?.querySelector('.num[data-side="RIGHT"][data-n="1"]')?.closest("[style]")?.getAttribute("style")).toContain("--row: 2");
    } finally {
      page.close();
    }
  });

  it("draws an outdated thread near the line it was written on, with its code folded", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const row = page.document.querySelector('.split-grid[data-idx="1"] .stale-row');
      expect(row?.getAttribute("data-thread")).toBe("T2");
      expect(row?.querySelector(".flag-outdated")?.textContent).toBe("Outdated");
      expect(row?.querySelector(".stale-loc")?.textContent).toBe("original old 13");
      expect(row?.querySelector(".stale-link")?.getAttribute("href")).toBe("/github/pr/acme/widgets/12#thread-T2");
      expect(row?.querySelector(".stale-link")?.textContent).toBe("View thread (2 comments)");
      // The code it was written on stays folded until a reader asks for it.
      expect(row?.querySelector(".stale-hunk")?.className).toBe("stale-hunk hidden");
      const toggle = row?.querySelector(".stale-toggle");
      if (!(toggle instanceof page.window.HTMLElement)) throw new Error("no stale toggle");
      toggle.click();
      await page.settle();
      expect(page.document.querySelector('.split-grid[data-idx="1"] .stale-hunk')?.className).toBe("stale-hunk");
      expect(page.document.querySelector('.split-grid[data-idx="1"] .stale-toggle')?.textContent).toBe("▾ Hide original code");
    } finally {
      page.close();
    }
  });

  it("draws no mark when the pull request could not be read", async () => {
    const page = await openDiff({
      replies: { [PR_PATH]: { status: 502, body: { error: "gh: Not Found" } }, [DIFF_PATH]: { body: diffAnswer() } },
    });
    try {
      // The diff is the page, so it is drawn; the marks are what is missing, and the
      // strip says nothing, because the page's own failure is what a reader needs.
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
      expect(page.document.querySelectorAll(".line-bubble")).toHaveLength(0);
      expect(page.document.querySelector("#error-banner")?.className).toBe("error-banner hidden");
    } finally {
      page.close();
    }
  });
});

describe("a drag across the code", () => {
  it("keeps each side in its own pane, and its numbers out of the copied text", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const grid = page.document.querySelector('.split-grid[data-idx="1"]');
      // The two sides are two containers, and every cell is one element of its own.
      // A drag inside one of them therefore reaches that side's cells and no others,
      // which is what makes the copied text one side of the diff.
      const left = grid?.querySelector(":scope > .pane-left");
      const right = grid?.querySelector(":scope > .pane-right");
      expect(left?.querySelectorAll(".code-left").length).toBeGreaterThan(0);
      expect(right?.querySelectorAll(".code-right").length).toBeGreaterThan(0);
      expect(left?.querySelector(".code-right")).toBeNull();
      expect(right?.querySelector(".code-left")).toBeNull();
      // A line number is not text a reader can select or copy: it is a handle.
      expect([...(grid?.querySelectorAll(".num") ?? [])].every((cell) => cell.children.length <= 1)).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe("the file tree", () => {
  it("lists every changed file with its status and counts", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      expect(treeLabels(page.document)).toEqual(["logo.png", "added.ts", "flux.ts", "gone.ts", "long.ts", "to.ts"]);
      const letters = [...page.document.querySelectorAll(".tree-file .fstat")].map((element) => element.textContent);
      expect(letters).toEqual(["M", "A", "M", "D", "M", "R"]);
      // A directory sorts as `name/`, so `assets` comes before `src`.
      const dirs = [...page.document.querySelectorAll(".tree-dir")].map((element) => element.textContent);
      expect(dirs).toEqual(["▾ assets/", "▾ src/"]);
    } finally {
      page.close();
    }
  });

  it("brings the file it names into view, and marks it", async () => {
    const scrolled: string[] = [];
    const page = await openDiff({
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
      before: (window) => {
        // jsdom has no layout, so the page's scroll call is a method this test
        // installs; without it the page must simply not throw.
        Object.defineProperty(window.Element.prototype, "scrollIntoView", {
          configurable: true,
          writable: true,
          value(this: Element) {
            scrolled.push(this.id);
          },
        });
      },
    });
    try {
      expect(page.document.querySelectorAll(".tree-file.active")).toHaveLength(1);
      expect(page.document.querySelector(".tree-file.active")?.getAttribute("data-idx")).toBe("0");
      const row = page.document.querySelector('.tree-file[data-idx="2"]');
      if (!(row instanceof page.window.HTMLElement)) throw new Error("no tree row for the deleted file");
      row.click();
      await page.settle();
      expect(scrolled).toEqual(["file-2"]);
      expect(page.document.querySelector(".tree-file.active")?.getAttribute("data-idx")).toBe("2");
    } finally {
      page.close();
    }
  });

  it("folds a directory when its name is pressed", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const dir = page.document.querySelectorAll(".tree-dir")[1];
      if (!(dir instanceof page.window.HTMLElement)) throw new Error("no src directory");
      dir.click();
      await page.settle();
      const children = dir.parentElement?.querySelector(".tree-children");
      expect(children?.className).toBe("tree-children hidden");
      expect(dir.textContent).toBe("▸ src/");
    } finally {
      page.close();
    }
  });
});

describe("the review a reader collects", () => {
  it("collects a comment on a dragged range without sending anything", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      // Nothing was sent while the page was only being read.
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);

      await dragLines(page, 1, "RIGHT", 10, 12);
      const form = page.document.querySelector('.split-grid[data-idx="1"] .review-form');
      expect(form?.querySelector(".review-form-title")?.textContent).toBe(
        "Review comment on src/flux.ts lines 10–12 (new side)",
      );
      const field = form?.querySelector("textarea");
      if (!(field instanceof page.window.HTMLTextAreaElement)) throw new Error("no comment field");
      await type(page, field, "This range needs a test");
      const add = form?.querySelector(".submit-btn");
      if (!(add instanceof page.window.HTMLElement)) throw new Error("no add button");
      add.click();
      await page.settle();

      // It is in the tab, drawn under the line it was written on, and nothing went
      // to the server.
      const pending = page.document.querySelector('.split-grid[data-idx="1"] .pending-row');
      expect(pending?.querySelector(".pending-loc")?.textContent).toBe("new 10–12");
      expect(pending?.querySelector(".pending-body")?.textContent).toBe("This range needs a test");
      expect(page.document.querySelector(".review-bar-btn")?.textContent).toBe("Finish review (1)");
      expect(page.calls.filter((call) => call.method === "POST")).toEqual([]);
      // The collection survives a reload of the page: it lives in this tab.
      const stored = JSON.parse(
        page.window.sessionStorage.getItem(`${STORE_PREFIX}${pendingStoreKey("acme/widgets", 12)}`) ?? "null",
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].path).toBe("src/flux.ts");
      expect(stored[0].startLine).toBe(10);
      expect(stored[0].line).toBe(12);
    } finally {
      page.close();
    }
  });

  it("draws the comments a reader collected before the page was reloaded", async () => {
    const page = await openDiff({
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
      before: (window) => {
        // The collection lives in this tab, so a reload of the page finds it where
        // it was left.
        window.sessionStorage.setItem(
          `${STORE_PREFIX}${pendingStoreKey("acme/widgets", 12)}`,
          JSON.stringify([
            { path: "src/flux.ts", side: "RIGHT", line: 11, startLine: null, body: "still here" },
            { path: "src/flux.ts", side: "LEFT", line: 11, startLine: null, body: "and this one" },
          ]),
        );
      },
    });
    try {
      const rows = [...page.document.querySelectorAll('.split-grid[data-idx="1"] .pending-row')];
      expect(rows).toHaveLength(2);
      // Both sit under line 11, and the left side's rows come first because the left
      // pane is read first.
      expect(rows.map((row) => row.querySelector(".pending-loc")?.textContent)).toEqual(["old 11", "new 11"]);
      expect(page.document.querySelector(".review-bar-btn")?.textContent).toBe("Finish review (2)");
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("removes one comment, and discards all of them", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const addOn = async (from: number): Promise<void> => {
        await dragLines(page, 1, "RIGHT", from, from);
        const field = page.document.querySelector('.split-grid[data-idx="1"] .review-form textarea');
        if (!(field instanceof page.window.HTMLTextAreaElement)) throw new Error("no comment field");
        await type(page, field, `comment ${from}`);
        const button = page.document.querySelector('.split-grid[data-idx="1"] .review-form .submit-btn');
        if (!(button instanceof page.window.HTMLElement)) throw new Error("no add button");
        button.click();
        await page.settle();
      };
      await addOn(11);
      await addOn(12);
      expect(page.document.querySelectorAll(".pending-row")).toHaveLength(2);

      const remove = page.document.querySelector('.pending-row .pending-remove');
      if (!(remove instanceof page.window.HTMLElement)) throw new Error("no remove button");
      remove.click();
      await page.settle();
      expect(page.document.querySelectorAll(".pending-row")).toHaveLength(1);
      expect(page.document.querySelector(".pending-body")?.textContent).toBe("comment 12");

      const bar = page.document.querySelector(".review-bar-btn");
      if (!(bar instanceof page.window.HTMLElement)) throw new Error("no review bar button");
      bar.click();
      await page.settle();
      const discard = page.document.querySelector(".review-panel .review-discard");
      expect(discard?.textContent).toBe("Discard all (1)");
      if (!(discard instanceof page.window.HTMLElement)) throw new Error("no discard button");
      discard.click();
      await page.settle();
      expect(page.document.querySelectorAll(".pending-row")).toHaveLength(0);
      expect(page.document.querySelector(".review-bar-btn")?.textContent).toBe("Finish review (0)");
    } finally {
      page.close();
    }
  });

  it("sends the whole review in one request when it is submitted", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      page.respond(REVIEW_PATH, { body: { ok: true } });
      // Two comments on the diff.
      for (const from of [11, 13]) {
        await dragLines(page, 1, "RIGHT", from, from);
        const field = page.document.querySelector('.split-grid[data-idx="1"] .review-form textarea');
        if (!(field instanceof page.window.HTMLTextAreaElement)) throw new Error("no comment field");
        await type(page, field, `comment on ${from}`);
        const button = page.document.querySelector('.split-grid[data-idx="1"] .review-form .submit-btn');
        if (!(button instanceof page.window.HTMLElement)) throw new Error("no add button");
        button.click();
        await page.settle();
      }
      const bar = page.document.querySelector(".review-bar-btn");
      if (!(bar instanceof page.window.HTMLElement)) throw new Error("no review bar button");
      bar.click();
      await page.settle();
      expect(page.document.querySelector(".review-panel-count")?.textContent).toBe("2 pending comments");

      const summary = page.document.querySelector(".review-panel .review-summary");
      if (!(summary instanceof page.window.HTMLTextAreaElement)) throw new Error("no summary field");
      await type(page, summary, "Two things to fix");
      const approve = [...page.document.querySelectorAll('.review-panel input[name="review-event"]')].find(
        (input) => (input as HTMLInputElement).value === "APPROVE",
      );
      if (!(approve instanceof page.window.HTMLInputElement)) throw new Error("no approve choice");
      approve.checked = true;
      approve.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await page.settle();

      const send = page.document.querySelector(".review-panel .review-submit");
      if (!(send instanceof page.window.HTMLElement)) throw new Error("no submit button");
      send.click();
      await page.settle();

      const writes = page.calls.filter((call) => call.method === "POST");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.path).toBe(REVIEW_PATH);
      const body = JSON.parse(writes[0]?.body ?? "null");
      expect(body.event).toBe("APPROVE");
      expect(body.body).toBe("Two things to fix");
      expect(body.comments).toHaveLength(2);
      expect(body.comments[0]).toEqual({ body: "comment on 11", path: "src/flux.ts", side: "RIGHT", line: 11, startLine: null });
      expect(body.comments[1]).toMatchObject({ line: 13 });

      // A submitted review empties the collection, because those comments are
      // GitHub's now and a second submit would send them twice.
      expect(page.document.querySelectorAll(".pending-row")).toHaveLength(0);
      expect(page.document.querySelector(".review-bar-btn")?.textContent).toBe("Finish review (0)");
      expect(page.document.querySelector(".review-form-ok")?.textContent).toBe("Review submitted.");
    } finally {
      page.close();
    }
  });

  it("keeps the collection when the server refuses the review", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      page.respond(REVIEW_PATH, { status: 502, body: { error: "gh: review could not be created" } });
      await dragLines(page, 1, "RIGHT", 11, 11);
      const field = page.document.querySelector('.split-grid[data-idx="1"] .review-form textarea');
      if (!(field instanceof page.window.HTMLTextAreaElement)) throw new Error("no comment field");
      await type(page, field, "keep me");
      const add = page.document.querySelector('.split-grid[data-idx="1"] .review-form .submit-btn');
      if (!(add instanceof page.window.HTMLElement)) throw new Error("no add button");
      add.click();
      await page.settle();

      const bar = page.document.querySelector(".review-bar-btn");
      if (!(bar instanceof page.window.HTMLElement)) throw new Error("no review bar button");
      bar.click();
      await page.settle();
      const send = page.document.querySelector(".review-panel .review-submit");
      if (!(send instanceof page.window.HTMLElement)) throw new Error("no submit button");
      send.click();
      await page.settle();

      expect(page.document.querySelector("#error-banner")?.textContent).toBe("gh: review could not be created");
      // Nothing the reader wrote is lost.
      expect(page.document.querySelectorAll(".pending-row")).toHaveLength(1);
      expect(page.document.querySelector(".review-bar-btn")?.textContent).toBe("Finish review (1)");
    } finally {
      page.close();
    }
  });

  it("refuses to send an empty review, and sends nothing", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      const bar = page.document.querySelector(".review-bar-btn");
      if (!(bar instanceof page.window.HTMLElement)) throw new Error("no review bar button");
      bar.click();
      await page.settle();
      const send = page.document.querySelector(".review-panel .review-submit");
      if (!(send instanceof page.window.HTMLElement)) throw new Error("no submit button");
      send.click();
      await page.settle();
      expect(page.calls.filter((call) => call.method === "POST")).toEqual([]);
      expect(page.document.querySelector("#error-banner")?.textContent).toBe(
        "a review needs one comment or an overall comment",
      );
    } finally {
      page.close();
    }
  });
});

describe("the write switch", () => {
  it("draws no review control at all while writes are off", async () => {
    const page = await openDiff({
      meta: META_READ_ONLY,
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
    });
    try {
      expect(page.document.querySelectorAll(".review-bar, .review-panel, .review-form")).toHaveLength(0);
      expect(page.document.querySelectorAll("textarea")).toHaveLength(0);
      // A line number is not a handle, so no drag can start from one and no box can
      // appear.
      expect(page.document.querySelector('.split-grid[data-idx="1"] .num[data-n]')).toBeNull();
      const num = [...page.document.querySelectorAll('.split-grid[data-idx="1"] .pane-right .num')][1];
      if (!(num instanceof page.window.HTMLElement)) throw new Error("no line number");
      expect(num.getAttribute("data-n")).toBeNull();
      fire(page.window, num, "mousedown", { button: 0 });
      await page.settle();
      expect(page.document.querySelector(".review-form")).toBeNull();
      // Reading is on: the diff, the tree and the thread marks are drawn.
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
      expect(page.document.querySelectorAll(".line-bubble")).toHaveLength(1);
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("draws no review control when the page carries no meta block", async () => {
    const page = await openDiff({
      metaBlock: false,
      replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
    });
    try {
      expect(page.document.querySelectorAll("textarea, .review-bar")).toHaveLength(0);
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });
});

describe("the bar and the header", () => {
  it("names the repositories and the login", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("acme/widgets · @octocat");
      expect(page.document.querySelector(".diff-head .muted")?.textContent).toContain("3 files".replace("3", "6"));
      expect(page.document.querySelector(".diff-head .muted")?.textContent).toContain("merge-base of main");
      expect(page.document.querySelector(".diff-head-back")?.getAttribute("href")).toBe("/github/pr/acme/widgets/12");
    } finally {
      page.close();
    }
  });

  it("opens the file tree as a drawer on a narrow screen", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      // The button toggles one class on the body, and the stylesheet is what turns
      // the sidebar into a panel below 768 pixels.
      const toggle = page.document.querySelector("#sidebar-toggle");
      if (!(toggle instanceof page.window.HTMLElement)) throw new Error("the page drew no drawer button");
      toggle.click();
      await page.settle();
      expect(page.document.body.className).toBe("sidebar-open");
      // A press inside the drawer moves the reader, so the drawer closes behind it.
      const row = page.document.querySelector('.tree-file[data-idx="3"]');
      if (!(row instanceof page.window.HTMLElement)) throw new Error("no tree row for the renamed file");
      row.click();
      await page.settle();
      expect(page.document.body.className).toBe("");
    } finally {
      page.close();
    }
  });

  it("says it is computing the diff before the answer arrives", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: () => new Promise<Answer>(() => {}) } });
    try {
      expect(page.document.querySelector("#diff-loading")?.textContent).toBe("Computing the diff for PR #12…");
    } finally {
      page.close();
    }
  });
});

describe("one commit's diff", () => {
  const SHA = "c".repeat(40);
  const COMMIT_ADDRESS = `/github/pr/acme/widgets/12/commits/${SHA}`;
  const COMMIT_PATH = `/api/github/pr/acme/widgets/12/commits/${SHA}`;

  function commitAnswer(over: Partial<Record<string, unknown>> = {}) {
    return {
      ...diffAnswer(),
      baseRef: "",
      baseSha: "4".repeat(40),
      headSha: SHA,
      mergeBase: "4".repeat(40),
      commit: {
        sha: SHA,
        parents: ["4".repeat(40)],
        authorName: "Hubot",
        authorEmail: "hubot@example.com",
        authoredAt: "2026-10-29T10:00:00Z",
        committedAt: "2026-10-29T10:05:00Z",
        headline: "Make the flux steadier",
        body: "A longer reason.\n\nWith <b>no markdown</b>.",
      },
      ...over,
    };
  }

  it("reads the address of a commit, with the mount prefix taken off", () => {
    expect(readDiffRoute(COMMIT_ADDRESS, "")).toEqual({ repo: "acme/widgets", number: 12, sha: SHA });
    expect(readDiffRoute(`/sec${COMMIT_ADDRESS}`, "/sec")).toEqual({ repo: "acme/widgets", number: 12, sha: SHA });
    expect(readDiffRoute("/github/pr/acme/widgets/12/commits/abc123", "")).toBeNull();
    expect(readDiffRoute("/github/pr/acme/widgets/12/commits/", "")).toBeNull();
  });

  it("reads the commit route and not the diff route, draws the commit header and the files, and reads no pull request", async () => {
    const page = await openDiff({
      path: COMMIT_ADDRESS,
      meta: META_WRITES,
      replies: { [COMMIT_PATH]: { body: commitAnswer() }, [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } },
    });
    try {
      expect(page.calls.map((call) => call.path)).toEqual([COMMIT_PATH]);
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Make the flux steadier");
      const line = page.document.querySelector(".diff-head .muted")?.textContent ?? "";
      expect(line).toContain(`commit ${"c".repeat(10)} · parent ${"4".repeat(10)} · 6 files`);
      const links = [...page.document.querySelectorAll(".diff-head .muted a")].map((link) => [link.textContent, link.getAttribute("href")]);
      expect(links).toEqual([
        ["pull request", "/github/pr/acme/widgets/12"],
        ["pull request diff", "/github/pr/acme/widgets/12/diff"],
        ["pull request list", "/github/pr/"],
      ]);
      expect(page.document.querySelector(".commit-author")?.textContent).toContain("Hubot");
      // The rest of the message is plain text: no element came out of it.
      const body = page.document.querySelector(".commit-body");
      expect(body?.textContent).toContain("With <b>no markdown</b>.");
      expect(body?.querySelector("b")).toBeNull();
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(6);
      expect(page.document.querySelectorAll(".tree-file").length).toBeGreaterThan(0);
    } finally {
      page.close();
    }
  });

  it("says first parent for a merge commit and root commit for one with no parent", async () => {
    const merge = await openDiff({
      path: COMMIT_ADDRESS,
      replies: {
        [COMMIT_PATH]: {
          body: commitAnswer({ commit: { ...commitAnswer().commit, parents: ["4".repeat(40), "5".repeat(40)] } }),
        },
      },
    });
    try {
      expect(merge.document.querySelector(".diff-head .muted")?.textContent).toContain(`first parent ${"4".repeat(10)}`);
    } finally {
      merge.close();
    }
    const root = await openDiff({
      path: COMMIT_ADDRESS,
      replies: { [COMMIT_PATH]: { body: commitAnswer({ mergeBase: "", commit: { ...commitAnswer().commit, parents: [] } }) } },
    });
    try {
      expect(root.document.querySelector(".diff-head .muted")?.textContent).toContain("root commit");
    } finally {
      root.close();
    }
  });

  it("draws no review control and no thread mark even with writes on, and sends only GET", async () => {
    const page = await openDiff({
      path: COMMIT_ADDRESS,
      meta: META_WRITES,
      replies: { [COMMIT_PATH]: { body: commitAnswer() }, [PR_PATH]: { body: prAnswer() } },
    });
    try {
      expect(page.document.querySelectorAll(".review-bar, .review-panel, .review-form")).toHaveLength(0);
      expect(page.document.querySelectorAll("textarea")).toHaveLength(0);
      expect(page.document.querySelectorAll(".line-bubble")).toHaveLength(0);
      const num = [...page.document.querySelectorAll('.split-grid[data-idx="1"] .pane-right .num')][1];
      if (!(num instanceof page.window.HTMLElement)) throw new Error("no line number");
      fire(page.window, num, "mousedown", { button: 0 });
      await page.settle();
      expect(page.document.querySelector(".review-form")).toBeNull();
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("puts the server's sentence in the strip when the commit is not in the pull request", async () => {
    const sentence = "commit ccccccc is not part of pull request #12 now. A force-push can remove a commit. Reload the pull request page for the current list.";
    const page = await openDiff({ path: COMMIT_ADDRESS, replies: { [COMMIT_PATH]: { status: 404, body: { error: sentence } } } });
    try {
      expect(page.document.querySelector("#error-banner")?.textContent).toBe(sentence);
      expect(page.document.querySelectorAll(".file-diff")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("keeps the answer under the commit key, and draws it before the server answers", async () => {
    const kept = await openDiff({ path: COMMIT_ADDRESS, replies: { [COMMIT_PATH]: { body: commitAnswer() } } });
    let stored = "";
    try {
      stored = kept.window.sessionStorage.getItem(`${STORE_PREFIX}${commitStoreKey("acme/widgets", SHA)}`) ?? "";
      expect(stored).not.toBe("");
      expect(kept.window.sessionStorage.getItem(`${STORE_PREFIX}${diffStoreKey("acme/widgets", 12)}`)).toBeNull();
    } finally {
      kept.close();
    }
    const page = await openDiff({
      path: COMMIT_ADDRESS,
      replies: { [COMMIT_PATH]: () => new Promise<Answer>(() => {}) },
      before: (window) => {
        window.sessionStorage.setItem(`${STORE_PREFIX}${commitStoreKey("acme/widgets", SHA)}`, stored);
      },
    });
    try {
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Make the flux steadier");
    } finally {
      page.close();
    }
  });

  it("says it is loading the commit before the answer arrives", async () => {
    const page = await openDiff({ path: COMMIT_ADDRESS, replies: { [COMMIT_PATH]: () => new Promise<Answer>(() => {}) } });
    try {
      expect(page.document.querySelector("#diff-loading")?.textContent).toBe(`Loading commit ${"c".repeat(10)}…`);
    } finally {
      page.close();
    }
  });

  it("leaves the pull request diff address as it was", async () => {
    const page = await openDiff({ replies: { [PR_PATH]: { body: prAnswer() }, [DIFF_PATH]: { body: diffAnswer() } } });
    try {
      expect(page.calls.map((call) => call.path).sort()).toEqual([DIFF_PATH, PR_PATH].sort());
      expect(page.document.querySelector(".diff-head-title")?.textContent).toBe("Fix the flux capacitor");
      expect(page.document.querySelector(".commit-head")).toBeNull();
    } finally {
      page.close();
    }
  });
});
