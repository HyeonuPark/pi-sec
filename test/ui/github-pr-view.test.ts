/**
 * One pull request's page, drawn from a fake answer.
 *
 * Five rules of this page are the ones a reader notices when they break, and each
 * group below is one of them:
 *
 * 1. The page draws what the server answered: the title, the description, the
 *    conversation in time order, the review threads with their flags, and the
 *    sidebar's facts.
 * 2. The first paint is the tab's own copy of this pull request, drawn before the
 *    server's answer arrives. That is the whole reason the session store exists.
 * 3. The read that started last is the one that draws, so a slow answer cannot put
 *    older data over newer.
 * 4. `writes` off means no write control is drawn at all: no reply box, no comment
 *    box, no reaction picker. The reaction counts stay, because reading is on.
 * 5. An address carrying `#thread-<id>` opens that thread, marks it and brings it
 *    into view, which is what the diff page links to.
 *
 * The page is loaded the way the server and the browser load it: the real shell
 * from `src/web/github-pr-view.html`, the stamps the server writes, the meta block,
 * `base.js`, and the test bundle of the real entry module.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildUi, ROOT } from "../../scripts/build-ui.mjs";
import { STORE_PREFIX, prStoreKey } from "../../src/ui/state/github-pr.ts";

/* ------------------------------------------------------------------ fixtures */

/** What `github-pr-meta` holds when writes are on. */
const META_WRITES = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: true };

/** What it holds when writes are off. */
const META_READ_ONLY = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: false };

/** One reaction count. */
function reaction(content: string, count: number, mine = false) {
  return { content, count, mine };
}

/** One comment, review comment or description. */
function comment(
  id: string,
  author: string,
  body: string,
  extra: Partial<{ createdAt: string; reactions: ReturnType<typeof reaction>[] }> = {},
) {
  return {
    id,
    author,
    body,
    createdAt: extra.createdAt ?? "2026-10-29T09:00:00Z",
    url: `https://github.com/acme/widgets/pull/12#issuecomment-${id}`,
    reactions: extra.reactions ?? [],
  };
}

/** The pull request's answer, as the route writes it. */
function prAnswer(over: Partial<Record<string, unknown>> = {}) {
  return {
    repo: "acme/widgets",
    id: "PR_kw1",
    number: 12,
    title: "Fix the flux capacitor",
    body: "This **fixes** the flux capacitor.\n\n- [x] tested\n- [ ] documented",
    url: "https://github.com/acme/widgets/pull/12",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-28T09:00:00Z",
    author: "octocat",
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    baseRefName: "main",
    headRefName: "flux-fix",
    headRefOid: "abc123",
    labels: [{ name: "bug", color: "d73a4a" }],
    reactions: [reaction("THUMBS_UP", 2, true)],
    comments: [
      comment("c2", "hubot", "Second comment", {
        createdAt: "2026-10-29T11:00:00Z",
        reactions: [reaction("EYES", 1)],
      }),
      comment("c1", "monalisa", "First comment", { createdAt: "2026-10-29T10:00:00Z" }),
    ],
    reviews: [
      {
        ...comment("r1", "reviewer", "Looks good to me", { createdAt: "2026-10-29T10:30:00Z" }),
        reviewState: "APPROVED",
      },
      // A review with no words and the state COMMENTED is a container for line
      // comments, not a message, and the page does not draw it.
      { ...comment("r2", "reviewer", "", { createdAt: "2026-10-29T10:45:00Z" }), reviewState: "COMMENTED" },
    ],
    threads: [
      {
        id: "T1",
        isResolved: true,
        viewerCanResolve: true,
        isOutdated: false,
        path: "src/flux.ts",
        line: 42,
        startLine: 40,
        originalLine: null,
        originalStartLine: null,
        diffSide: "RIGHT",
        diffHunk: "@@ -40,3 +40,3 @@\n context\n-const a = 1;\n+const a = 2;",
        comments: [comment("t1c1", "reviewer", "Why 2?", { createdAt: "2026-10-29T10:10:00Z" })],
      },
      {
        id: "T2",
        isResolved: false,
        viewerCanResolve: true,
        isOutdated: true,
        path: "src/capacitor.ts",
        line: null,
        startLine: null,
        originalLine: 7,
        originalStartLine: null,
        diffSide: "LEFT",
        diffHunk: "@@ -7,1 +7,0 @@\n-removed();",
        comments: [comment("t2c1", "hubot", "This line is gone", { createdAt: "2026-10-29T11:30:00Z" })],
      },
    ],
    ciState: "SUCCESS",
    checks: [{ name: "test", status: "SUCCESS", url: "https://ci.example.com/1" }],
    commits: [
      {
        oid: "a".repeat(40),
        abbreviatedOid: "aaaaaaa",
        headline: "Start the fix",
        author: "octocat",
        committedDate: "2026-10-28T09:10:00Z",
        url: `https://github.com/acme/widgets/commit/${"a".repeat(40)}`,
      },
      {
        oid: "b".repeat(40),
        abbreviatedOid: "bbbbbbb",
        headline: "Finish the fix",
        author: "No Account",
        committedDate: "2026-10-28T09:20:00Z",
        url: `https://github.com/acme/widgets/commit/${"b".repeat(40)}`,
      },
    ],
    totalCommits: 2,
    ...over,
  };
}

/* -------------------------------------------------------------------- loader */

/** One request the fake `fetch` saw. */
interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

/** What the fake `fetch` answers with. */
interface Answer {
  readonly status?: number;
  readonly body?: unknown;
}

/** An answer, or a function that answers when the test says so. */
type Reply = Answer | (() => Answer | Promise<Answer>);

/** What one loaded page offers a test. */
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
  let html = await readFile(join(ROOT, "src/web/github-pr-view.html"), "utf8");
  html = html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, '<meta name="pi-sec-timezone" content="Asia/Tokyo" />');
  html = html.replace("<!--github-pr-meta-->", options.metaBlock === false ? "" : block("github-pr-meta", options.meta ?? META_WRITES));
  return html;
}

/** Load the pull request page with the server faked. */
async function openView(
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
  const source = code["github-pr-view"];
  if (source === undefined) throw new Error("the test build has no github-pr-view page bundle");

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });

  const dom = new JSDOM(await shell(options), {
    url: `http://localhost${options.path ?? "/github/pr/acme/widgets/12"}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const document = window.document;
  const calls: Call[] = [];
  const replies = new Map<string, Reply>(Object.entries(options.replies ?? {}));

  (window as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ path: url.pathname + url.search, method: (init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : "" });
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
  // The page opens no stream of its own; a stand-in is here so a page that
  // started one would show up rather than throw.
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
    document,
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

/** The text of every thread card's path line, in the order the page drew them. */
function threadPaths(document: Document): string[] {
  return [...document.querySelectorAll(".thread-card .thread-file")].map((element) => element.textContent ?? "");
}

/** The comment cards' authors, in the order the page drew them. */
function authors(document: Document): string[] {
  return [...document.querySelectorAll(".comment-card .comment-header .author")].map(
    (element) => element.textContent ?? "",
  );
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

/* --------------------------------------------------------------------- tests */

describe("the pull request the page draws", () => {
  it("draws the header, the description and the sidebar", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("#12");
      expect(page.document.querySelector(".state-badge")?.textContent).toBe("Open");
      expect(page.document.querySelector(".dash-meta-line")?.textContent).toContain("octocat wants to merge");
      expect(page.document.querySelector(".dash-meta-line code")?.textContent).toBe("flux-fix");
      // The description is the first comment card, and its markdown was drawn.
      const first = page.document.querySelector(".comment-card");
      expect(first?.querySelector(".comment-header .author")?.textContent).toBe("octocat");
      expect(first?.querySelector(".comment-body strong")?.textContent).toBe("fixes");
      // Its task list says what is done and what is not, and neither box can be pressed.
      const boxes = [...(first?.querySelectorAll('.comment-body input[type="checkbox"]') ?? [])];
      expect(boxes.map((box) => box.hasAttribute("checked"))).toEqual([true, false]);
      for (const box of boxes) expect(box.hasAttribute("disabled")).toBe(true);
      // The sidebar's facts.
      const rows = [...page.document.querySelectorAll(".dash-side .side-row")].map((row) => row.textContent ?? "");
      expect(rows).toContain("Number#12");
      expect(rows).toContain("Diff+12 −3 · 2 files");
      expect(rows).toContain("Branchflux-fix");
      expect(page.document.querySelector(".dash-side .label-chip")?.textContent).toBe("bug");
      expect(page.document.querySelector(".dash-side .check-row")?.textContent).toBe("✓testdetails");
      expect(page.document.querySelector(".dash-side .check-row a")?.getAttribute("href")).toBe("https://ci.example.com/1");
      // The ways out of the page.
      const links = [...page.document.querySelectorAll(".dash-side .diff-link-btn")].map((link) =>
        link.getAttribute("href"),
      );
      expect(links).toEqual(["/github/pr/acme/widgets/12/diff", "/github/pr/"]);
    } finally {
      page.close();
    }
  });

  it("draws the conversation in time order, with a review's state on it", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      // The description, then the comment at 10:00, the approval at 10:30 and the
      // comment at 11:00. The wordless `COMMENTED` review is not a message.
      expect(authors(page.document)).toEqual(["octocat", "monalisa", "reviewer", "hubot"]);
      const states = [...page.document.querySelectorAll(".comment-header .review-state")];
      expect(states.map((state) => state.textContent)).toEqual(["APPROVED"]);
      expect(states[0]?.className).toBe("review-state review-APPROVED");
    } finally {
      page.close();
    }
  });

  it("draws a thread with its path, its line range, its flags and its hunk", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(threadPaths(page.document)).toEqual(["src/flux.ts:40–42", "src/capacitor.ts:7"]);
      const [first, second] = [...page.document.querySelectorAll(".thread-card")];
      expect(first?.querySelector(".flag-resolved")?.textContent).toBe("Resolved");
      expect(first?.querySelector(".flag-outdated")).toBeNull();
      expect(second?.querySelector(".flag-outdated")?.textContent).toBe("Outdated");
      // The hunk keeps the three kinds of row, and the `+` and `-` marks sit in a
      // cell of their own so a drag across the code copies the code.
      const rows = [...(first?.querySelectorAll(".hunk-table tr") ?? [])];
      expect(rows.map((row) => row.className)).toEqual(["l-hunk", "", "l-del", "l-add"]);
      expect(rows.map((row) => row.querySelector(".sign")?.textContent)).toEqual(["", "", "-", "+"]);
      expect(rows[2]?.lastElementChild?.textContent).toBe("const a = 1;");
      // A resolved thread starts folded; an open one is drawn.
      expect(first?.querySelector(".thread-inner")?.className).toBe("thread-inner hidden");
      expect(second?.querySelector(".thread-inner")?.className).toBe("thread-inner");
    } finally {
      page.close();
    }
  });

  it("draws a file thread with its path alone, a File comment flag and a note, and no code table", async () => {
    const base = prAnswer();
    const fileThread = {
      id: "T9",
      isResolved: false,
      viewerCanResolve: true,
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
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { body: { ...base, threads: [...base.threads, fileThread] } } },
    });
    try {
      expect(threadPaths(page.document)).toEqual(["src/flux.ts:40–42", "src/capacitor.ts:7", "src/added.ts"]);
      const card = page.document.querySelector("#thread-T9");
      expect(card?.querySelector(".flag-file")?.textContent).toBe("File comment");
      expect(card?.querySelector(".thread-file-note")?.textContent).toBe("This comment is on the whole file, so no lines are shown.");
      expect(card?.querySelector(".hunk-table")).toBeNull();
      expect(card?.querySelector(".thread-comment")).not.toBeNull();
      // A thread with no subjectType is a line thread.
      expect(page.document.querySelectorAll(".flag-file")).toHaveLength(1);
      expect(page.document.querySelectorAll(".thread-file-note")).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("folds and unfolds a resolved thread when its button is pressed", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      const card = page.document.querySelector(".thread-card");
      const toggle = card?.querySelector(".thread-toggle");
      if (!(toggle instanceof page.window.HTMLElement)) throw new Error("no thread toggle");
      expect(toggle.textContent).toBe("▸ Show resolved thread (1 comment)");
      toggle.click();
      await page.settle();
      expect(card?.querySelector(".thread-inner")?.className).toBe("thread-inner");
      expect(toggle.textContent).toBe("▾ Hide resolved thread (1 comment)");
    } finally {
      page.close();
    }
  });

  it("draws the reactions on a comment, counts and all", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      const pills = [...page.document.querySelectorAll(".reaction-bar .reaction-pill")].map((pill) => pill.textContent);
      expect(pills).toContain("👀 1");
      // The reader's own reaction is marked.
      expect(page.document.querySelector(".reaction-pill.mine")?.textContent).toBe("👍 2");
    } finally {
      page.close();
    }
  });

  it("says it is loading before the answer arrives", async () => {
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": () => new Promise<Answer>(() => {}) },
    });
    try {
      expect(page.document.querySelector("#view .empty")?.textContent).toBe("Loading PR #12…");
      // It asked the route its own address names.
      expect(page.calls.map((call) => call.path)).toEqual(["/api/github/pr/acme/widgets/12"]);
    } finally {
      page.close();
    }
  });

  it("says so when the server's sentence is a refusal, and keeps what is drawn", async () => {
    const kept = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    let stored: string | null = null;
    try {
      stored = kept.window.sessionStorage.getItem(`${STORE_PREFIX}${prStoreKey("acme/widgets", 12)}`);
      expect(stored).not.toBeNull();
    } finally {
      kept.close();
    }
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { status: 502, body: { error: "gh: could not resolve to a Repository" } } },
      before: (window) => {
        window.sessionStorage.setItem(`${STORE_PREFIX}${prStoreKey("acme/widgets", 12)}`, stored ?? "");
      },
    });
    try {
      expect(page.document.querySelector("#error-banner")?.className).toBe("error-banner");
      expect(page.document.querySelector("#error-banner")?.textContent).toBe(
        "gh: could not resolve to a Repository",
      );
      // The copy the tab already had is still on the page.
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });

  it("draws the draft state rather than the open one", async () => {
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer({ isDraft: true }) } },
    });
    try {
      expect(page.document.querySelector(".state-badge")?.textContent).toBe("Draft");
      expect(page.document.querySelector(".state-badge")?.className).toBe("state-badge state-draft");
    } finally {
      page.close();
    }
  });
});

describe("the sidebar panels", () => {
  const press = async (page: Page, selector: string): Promise<void> => {
    const button = page.document.querySelector(selector);
    if (!(button instanceof page.window.HTMLElement)) throw new Error(`no ${selector}`);
    button.click();
    await page.settle();
  };

  it("starts with the CI and Commits panels open", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      const buttons = [...page.document.querySelectorAll(".dash-side .side-fold")];
      expect(buttons.map((button) => button.textContent)).toEqual(["▾ CI status", "▾ Commits (2)"]);
      for (const button of buttons) expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(page.document.querySelector("#side-ci")?.className).toBe("side-fold-body");
      expect(page.document.querySelector("#side-commits")?.className).toBe("side-fold-body");
      expect(buttons[0]?.getAttribute("aria-controls")).toBe("side-ci");
    } finally {
      page.close();
    }
  });

  it("hides the CI rows on a press, keeps the rollup mark, and shows them on a second press", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      await press(page, '.side-fold[aria-controls="side-ci"]');
      const button = page.document.querySelector('.side-fold[aria-controls="side-ci"]');
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      expect(button?.textContent).toBe("▸ CI status");
      expect(page.document.querySelector("#side-ci")?.className).toBe("side-fold-body hidden");
      // The mark of the whole CI state is in the heading, outside the hidden part.
      expect(button?.parentElement?.textContent).toContain("✓");
      expect(page.document.querySelector("#side-ci")?.textContent).toContain("test");
      expect(page.document.querySelector("#side-commits")?.className).toBe("side-fold-body");
      await press(page, '.side-fold[aria-controls="side-ci"]');
      expect(page.document.querySelector("#side-ci")?.className).toBe("side-fold-body");
      expect(page.document.querySelector('.side-fold[aria-controls="side-ci"]')?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      page.close();
    }
  });

  it("lists the commits with short id, headline, author and a link to the commit diff", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      const rows = [...page.document.querySelectorAll("#side-commits .commit-row")];
      expect(rows.map((row) => row.querySelector(".commit-oid")?.textContent)).toEqual(["aaaaaaa", "bbbbbbb"]);
      expect(rows.map((row) => row.querySelector(".commit-headline")?.textContent)).toEqual(["Start the fix", "Finish the fix"]);
      expect(rows[0]?.querySelector(".commit-meta")?.textContent).toContain("octocat");
      expect(rows[1]?.querySelector(".commit-meta")?.textContent).toContain("No Account");
      expect(rows[0]?.querySelector(".commit-meta")?.getAttribute("title")).toBe("2026-10-28T09:10:00Z");
      expect(rows.map((row) => row.getAttribute("href"))).toEqual([
        `/github/pr/acme/widgets/12/commits/${"a".repeat(40)}`,
        `/github/pr/acme/widgets/12/commits/${"b".repeat(40)}`,
      ]);
      expect(page.document.querySelector("#side-commits .commit-more")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("says how many commits it shows when GitHub has more, with a link to all of them", async () => {
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer({ totalCommits: 130 }) } },
    });
    try {
      const more = page.document.querySelector("#side-commits .commit-more");
      expect(more?.textContent).toContain("Showing the newest 2 of 130 commits");
      expect(more?.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/12/commits");
    } finally {
      page.close();
    }
  });

  it("draws an answer without commits and says it is loading them", async () => {
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer({ commits: undefined, totalCommits: undefined }) } },
    });
    try {
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
      expect(page.document.querySelector("#side-commits")?.textContent).toContain("Loading commits…");
      expect(page.document.querySelectorAll("#side-commits .commit-row")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("links the commit rows under the mount prefix", async () => {
    const page = await openView({
      base: "/sec",
      path: "/sec/github/pr/acme/widgets/12",
      replies: { "/sec/api/github/pr/acme/widgets/12": { body: prAnswer() } },
    });
    try {
      expect(page.document.querySelector("#side-commits .commit-row")?.getAttribute("href")).toBe(
        `/sec/github/pr/acme/widgets/12/commits/${"a".repeat(40)}`,
      );
    } finally {
      page.close();
    }
  });
});

describe("the tab's own copy of a pull request", () => {
  it("is drawn before the server answers", async () => {
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": () => new Promise<Answer>(() => {}) },
      before: (window) => {
        window.sessionStorage.setItem(
          `${STORE_PREFIX}${prStoreKey("acme/widgets", 12)}`,
          JSON.stringify(prAnswer({ title: "From the tab's own copy" })),
        );
      },
    });
    try {
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("From the tab's own copy");
      // It asks anyway: the copy is where the pull request was when the reader
      // left it.
      expect(page.calls.map((call) => call.path)).toEqual(["/api/github/pr/acme/widgets/12"]);
    } finally {
      page.close();
    }
  });

  it("keeps the answer under the fixed key prefix", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      const keys = [...Array(page.window.sessionStorage.length).keys()].map((index) =>
        page.window.sessionStorage.key(index),
      );
      expect(keys).toEqual([`${STORE_PREFIX}${prStoreKey("acme/widgets", 12)}`]);
      const kept = JSON.parse(page.window.sessionStorage.getItem(keys[0] ?? "") ?? "null");
      expect(kept.title).toBe("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });

  it("treats a stored value it cannot read as a miss", async () => {
    for (const stored of ["{not json", JSON.stringify({ number: 12 }), JSON.stringify("nope") ]) {
      const page = await openView({
        replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } },
        before: (window) => {
          window.sessionStorage.setItem(`${STORE_PREFIX}${prStoreKey("acme/widgets", 12)}`, stored);
        },
      });
      try {
        expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
      } finally {
        page.close();
      }
    }
  });
});

describe("the reads the page makes", () => {
  it("draws the answer of the read that started last, and drops the earlier one", async () => {
    let releaseSlow: ((answer: Answer) => void) | null = null;
    let slow = true;
    const page = await openView({
      replies: {
        "/api/github/pr/acme/widgets/12": () =>
          slow
            ? new Promise<Answer>((resolve) => {
                releaseSlow = resolve;
                slow = false;
              })
            : { body: prAnswer({ title: "The newer read" }) },
      },
    });
    try {
      // The page's own read is still held; `⟳ Reload` starts a second one.
      const reload = page.document.querySelector("#reload");
      if (!(reload instanceof page.window.HTMLElement)) throw new Error("no reload button");
      reload.click();
      await page.settle();
      expect(page.calls).toHaveLength(2);
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("The newer read");

      // The older read answers now, and draws nothing.
      releaseSlow!({ body: prAnswer({ title: "The older read" }) });
      await page.settle();
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("The newer read");
    } finally {
      page.close();
    }
  });

  it("says the address names no pull request when it does not", async () => {
    const page = await openView({ path: "/github/pr/acme/widgets" });
    try {
      expect(page.document.querySelector("#view .empty")?.textContent).toBe("This address does not name a pull request.");
      expect(page.calls).toEqual([]);
    } finally {
      page.close();
    }
  });

  it("reads the pull request under the mount it is served from", async () => {
    const page = await openView({
      base: "/sec",
      path: "/sec/github/pr/acme/widgets/12",
      replies: { "/sec/api/github/pr/acme/widgets/12": { body: prAnswer() } },
    });
    try {
      expect(page.calls.map((call) => call.path)).toEqual(["/sec/api/github/pr/acme/widgets/12"]);
      expect(page.document.querySelector(".brand")?.getAttribute("href")).toBe("/sec/github/pr/");
      expect(page.document.querySelector(".diff-link-btn")?.getAttribute("href")).toBe(
        "/sec/github/pr/acme/widgets/12/diff",
      );
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });
});

describe("the write controls", () => {
  it("draws a reply box in every thread, a comment box, and the reaction picker", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      // One box per thread (two threads, one of them folded) and one for the
      // pull request itself.
      expect(page.document.querySelectorAll(".reply-box textarea")).toHaveLength(3);
      const labels = [...page.document.querySelectorAll(".reply-btn")].map((button) => button.textContent);
      expect(labels).toEqual(["Reply", "Reply", "Comment"]);
      // One picker per subject that carries reactions: the description, the three
      // conversation items and the two thread comments.
      expect(page.document.querySelectorAll(".reaction-add")).toHaveLength(6);
      // The picker is closed until its button is pressed.
      expect(page.document.querySelector(".reaction-picker")?.className).toBe("reaction-picker hidden");
      const add = page.document.querySelector(".reaction-add");
      if (!(add instanceof page.window.HTMLElement)) throw new Error("no reaction picker button");
      add.click();
      await page.settle();
      expect(page.document.querySelector(".reaction-picker")?.className).toBe("reaction-picker");
      // The eight reactions GitHub accepts, in the picker that was just opened.
      expect(page.document.querySelectorAll(".reaction-picker .reaction-choice")).toHaveLength(48);
      expect(page.document.querySelector(".reaction-picker:not(.hidden) .reaction-choice")).not.toBeNull();
      expect(
        page.document.querySelectorAll(".reaction-picker:not(.hidden) .reaction-choice"),
      ).toHaveLength(8);
    } finally {
      page.close();
    }
  });

  it("draws no write control at all while the server says writes are off", async () => {
    const page = await openView({ meta: META_READ_ONLY, replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(page.document.querySelectorAll("textarea")).toHaveLength(0);
      expect(
        page.document.querySelectorAll(
          ".reply-box, .reply-btn, .reaction-add, .reaction-choice, .resolve-row, .resolve-btn, .edit-btn, .edit-box",
        ),
      ).toHaveLength(0);
      expect(page.document.body.textContent).not.toContain("Resolve conversation");
      // Reading is on, so the counts and the page are still drawn.
      expect(page.document.querySelectorAll(".reaction-pill")).toHaveLength(2);
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });

  it("sends a thread reply only when the button is pressed", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      // Nothing was sent while the page was only being read.
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);
      page.respond("/api/github/pr/acme/widgets/12/reply", { body: { ok: true } });
      page.respond("/api/github/pr/acme/widgets/12", { body: prAnswer({ title: "After the reply" }) });

      const box = page.document.querySelector(".thread-card .reply-box textarea");
      const button = page.document.querySelector(".thread-card .reply-btn");
      if (!(box instanceof page.window.HTMLTextAreaElement)) throw new Error("no reply box");
      if (!(button instanceof page.window.HTMLButtonElement)) throw new Error("no reply button");
      box.value = "   ";
      box.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      // The box's value is its component's state, and one render has to pass
      // between the typed text and the press for the press to see it.
      await page.settle();
      button.click();
      await page.settle();
      // An empty box sends nothing.
      expect(page.calls.filter((call) => call.method === "POST")).toEqual([]);

      box.value = "Good catch";
      box.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await page.settle();
      button.click();
      await page.settle();
      expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(page.calls.filter((call) => call.method === "POST")[0]?.path).toBe(
        "/api/github/pr/acme/widgets/12/reply",
      );
      // The page read the pull request again after the write.
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("After the reply");
    } finally {
      page.close();
    }
  });

  /** Write `text` into the first thread's reply box, and let the box draw it. */
  async function writeReply(page: Awaited<ReturnType<typeof openView>>, text: string) {
    const box = page.document.querySelector(".thread-card .reply-box textarea");
    const button = page.document.querySelector(".thread-card .reply-btn");
    if (!(box instanceof page.window.HTMLTextAreaElement)) throw new Error("no reply box");
    if (!(button instanceof page.window.HTMLButtonElement)) throw new Error("no reply button");
    box.value = text;
    box.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await page.settle();
    return { box, button };
  }

  it("clears a reply that GitHub took when the read after it fails", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      page.respond("/api/github/pr/acme/widgets/12/reply", { body: { ok: true } });
      page.respond("/api/github/pr/acme/widgets/12", { status: 502, body: { error: "gh: read failed" } });
      const { box, button } = await writeReply(page, "Good catch");
      button.click();
      await page.settle();
      // The reply is on GitHub, so the box is empty and a second press has nothing to post.
      expect(box.value).toBe("");
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("gh: read failed");
      expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("keeps the text when GitHub refuses the reply", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      page.respond("/api/github/pr/acme/widgets/12/reply", { status: 400, body: { error: "gh refused the reply" } });
      const { box, button } = await writeReply(page, "Good catch");
      button.click();
      await page.settle();
      expect(box.value).toBe("Good catch");
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("gh refused the reply");
    } finally {
      page.close();
    }
  });

  it("sends one reply for two presses before the page draws again", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      let release: () => void = () => {};
      page.respond("/api/github/pr/acme/widgets/12/reply", () => new Promise((resolve) => {
        release = () => resolve({ body: { ok: true } });
      }));
      const { button } = await writeReply(page, "Good catch");
      // Two presses in one task: the state of the box has not been drawn between them.
      button.click();
      button.click();
      await page.settle();
      expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      release();
      await page.settle();
    } finally {
      page.close();
    }
  });

  it("draws the resolve button only for an unresolved thread that the account can resolve", async () => {
    const base = prAnswer();
    const extra = {
      ...base.threads[1]!,
      id: "T3",
      viewerCanResolve: false,
      comments: [comment("t3c1", "hubot", "Cannot resolve this", { createdAt: "2026-10-29T11:40:00Z" })],
    };
    const noFlag = { ...base.threads[1]!, id: "T4", comments: [comment("t4c1", "hubot", "Old copy", { createdAt: "2026-10-29T11:50:00Z" })] };
    delete (noFlag as { viewerCanResolve?: boolean }).viewerCanResolve;
    const page = await openView({
      replies: { "/api/github/pr/acme/widgets/12": { body: { ...base, threads: [...base.threads, extra, noFlag] } } },
    });
    try {
      // T1 is resolved, T2 can be resolved, T3 and T4 cannot (T4 has no flag at all).
      const cards = [...page.document.querySelectorAll(".thread-card")].filter((card) => card.id.startsWith("thread-T"));
      expect(cards.map((card) => [card.id, card.querySelector(".resolve-btn")?.textContent ?? null])).toEqual([
        ["thread-T1", null],
        ["thread-T2", "Resolve conversation"],
        ["thread-T3", null],
        ["thread-T4", null],
      ]);
    } finally {
      page.close();
    }
  });

  it("resolves a thread on one press, shows Resolved at once, and sends one request", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(page.calls.every((call) => call.method === "GET")).toBe(true);
      page.respond("/api/github/pr/acme/widgets/12/resolve", {
        body: { ok: true, thread: { id: "T2", isResolved: true } },
      });
      // The read after the write answers what GitHub holds now.
      const resolved = prAnswer();
      page.respond("/api/github/pr/acme/widgets/12", {
        body: { ...resolved, threads: resolved.threads.map((item) => (item.id === "T2" ? { ...item, isResolved: true } : item)) },
      });
      const button = page.document.querySelector("#thread-T2 .resolve-btn");
      if (!(button instanceof page.window.HTMLButtonElement)) throw new Error("no resolve button");
      button.click();
      button.click();
      await page.settle();
      const posts = page.calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.path).toBe("/api/github/pr/acme/widgets/12/resolve");
      const card = page.document.querySelector("#thread-T2");
      expect(card?.querySelector(".flag-resolved")?.textContent).toBe("Resolved");
      expect(card?.querySelector(".resolve-btn")).toBeNull();
      expect(card?.querySelector(".thread-toggle")?.textContent).toContain("Hide resolved thread");
    } finally {
      page.close();
    }
  });

  it("keeps Resolved on the card when the read after the resolve fails", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      page.respond("/api/github/pr/acme/widgets/12/resolve", {
        body: { ok: true, thread: { id: "T2", isResolved: true } },
      });
      page.respond("/api/github/pr/acme/widgets/12", { status: 502, body: { error: "gh: read failed" } });
      const button = page.document.querySelector("#thread-T2 .resolve-btn");
      if (!(button instanceof page.window.HTMLButtonElement)) throw new Error("no resolve button");
      button.click();
      await page.settle();
      expect(page.document.querySelector("#thread-T2 .flag-resolved")?.textContent).toBe("Resolved");
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("gh: read failed");
    } finally {
      page.close();
    }
  });

  it("puts the server's sentence in the strip when a resolve is refused, and keeps the button", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      page.respond("/api/github/pr/acme/widgets/12/resolve", {
        status: 400,
        body: { error: "this account cannot resolve this thread" },
      });
      const button = page.document.querySelector("#thread-T2 .resolve-btn");
      if (!(button instanceof page.window.HTMLButtonElement)) throw new Error("no resolve button");
      button.click();
      await page.settle();
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("this account cannot resolve this thread");
      const again = page.document.querySelector("#thread-T2 .resolve-btn");
      expect(again?.textContent).toBe("Resolve conversation");
      expect((again as HTMLButtonElement).disabled).toBe(false);
      expect(page.document.querySelector("#thread-T2 .flag-resolved")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("puts the server's sentence in the strip when a write is refused", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      page.respond("/api/github/pr/acme/widgets/12/reaction", { status: 502, body: { error: "gh: Not Found" } });
      const pill = page.document.querySelector(".reaction-pill");
      if (!(pill instanceof page.window.HTMLButtonElement)) throw new Error("no reaction pill");
      pill.click();
      await page.settle();
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("gh: Not Found");
      // The pull request is still drawn.
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });
});

/** An answer whose description and two comments are the account's own, and whose other comments are not. */
function editableAnswer(over: Partial<Record<string, unknown>> = {}) {
  const base = prAnswer();
  const mine = { viewerCanUpdate: true, viewerDidAuthor: true };
  const notMine = { viewerCanUpdate: true, viewerDidAuthor: false };
  return prAnswer({
    viewerCanUpdate: true,
    viewerDidAuthor: true,
    comments: base.comments.map((item) => ({ ...item, ...(item.id === "c1" ? mine : notMine) })),
    // A review summary is never editable, even when the flags say so.
    reviews: base.reviews.map((item) => ({ ...item, ...mine })),
    threads: base.threads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((item) => ({ ...item, ...(item.id === "t2c1" ? mine : notMine) })),
    })),
    ...over,
  });
}

/** Type into the one open edit box, the way a browser reports it. */
async function typeInto(page: Page, box: Element | null, text: string): Promise<void> {
  if (!(box instanceof page.window.HTMLTextAreaElement)) throw new Error("no edit box");
  box.value = text;
  box.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  // The page redraws on the next turn, and Save reads the text from that redraw.
  await page.settle();
}

function press(page: Page, element: Element | null | undefined): void {
  if (!(element instanceof page.window.HTMLButtonElement)) throw new Error("no such button");
  element.click();
}

describe("the edit buttons", () => {
  const PR_PATH = "/api/github/pr/acme/widgets/12";
  const EDIT_PATH = `${PR_PATH}/edit`;

  it("draws Edit on the description only while writes are on and both flags are true", async () => {
    const on = await openView({ replies: { [PR_PATH]: { body: editableAnswer() } } });
    try {
      const headers = [...on.document.querySelectorAll(".comment-card")].map((card) => card.querySelector(".edit-btn") !== null);
      // The description, c1 (own), r1 (a review summary), c2 (not own).
      expect(headers).toEqual([true, true, false, false]);
    } finally {
      on.close();
    }
    for (const flags of [{ viewerCanUpdate: false }, { viewerDidAuthor: false }, { viewerCanUpdate: undefined, viewerDidAuthor: undefined }]) {
      const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer(flags) } } });
      try {
        expect(page.document.querySelector(".comment-card .edit-btn")?.closest(".comment-card")).not.toBe(
          page.document.querySelector(".comment-card"),
        );
      } finally {
        page.close();
      }
    }
    const off = await openView({ meta: META_READ_ONLY, replies: { [PR_PATH]: { body: editableAnswer() } } });
    try {
      expect(off.document.querySelectorAll(".edit-btn")).toHaveLength(0);
    } finally {
      off.close();
    }
  });

  it("opens a box with the raw markdown, Save and Cancel, and Cancel sends nothing", async () => {
    const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer() } } });
    try {
      const card = page.document.querySelector(".comment-card");
      press(page, card?.querySelector(".edit-btn"));
      await page.settle();
      const box = card?.querySelector(".edit-box textarea") as HTMLTextAreaElement | null;
      expect(box?.value).toBe("This **fixes** the flux capacitor.\n\n- [x] tested\n- [ ] documented");
      expect([...(card?.querySelectorAll(".edit-actions button") ?? [])].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
      expect(card?.querySelector(".comment-body")).toBeNull();

      press(page, card?.querySelector(".edit-actions button"));
      await page.settle();
      expect(card?.querySelector(".edit-box")).toBeNull();
      expect(card?.querySelector(".comment-body")?.textContent).toContain("fixes");
      expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("sends nothing for a Save of unchanged text, line ends included", async () => {
    const body = "line one\r\nline two";
    const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer({ body }) } } });
    try {
      const card = page.document.querySelector(".comment-card");
      press(page, card?.querySelector(".edit-btn"));
      await page.settle();
      press(page, card?.querySelector(".edit-save"));
      await page.settle();
      expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(0);
      expect(card?.querySelector(".edit-box")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("saves changed text with one POST, shows the new text and closes the box", async () => {
    const body = "old\r\ntext";
    const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer({ body }) } } });
    try {
      page.respond(EDIT_PATH, { body: { ok: true, body: "new **text**" } });
      // The read after the save answers what GitHub holds now.
      page.respond(PR_PATH, { body: editableAnswer({ body: "new **text**" }) });
      const card = page.document.querySelector(".comment-card");
      press(page, card?.querySelector(".edit-btn"));
      await page.settle();
      await typeInto(page, card?.querySelector(".edit-box textarea") ?? null, "new **text**");
      const save = card?.querySelector(".edit-save");
      press(page, save);
      press(page, save);
      await page.settle();
      const posts = page.calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.path).toBe(EDIT_PATH);
      // The base text is the payload's text, with its own line ends.
      expect(JSON.parse(posts[0]?.body ?? "")).toEqual({ body: "new **text**", baseBody: "old\r\ntext" });
      expect(page.document.querySelector(".comment-card .edit-box")).toBeNull();
      expect(page.document.querySelector(".comment-card .comment-body strong")?.textContent).toBe("text");
    } finally {
      page.close();
    }
  });

  it("puts the 409 message in the strip and keeps the box open with the typed text", async () => {
    const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer() } } });
    try {
      const message = "the description changed on GitHub after you started editing; your text was not saved.";
      page.respond(EDIT_PATH, { status: 409, body: { error: message } });
      const card = page.document.querySelector(".comment-card");
      press(page, card?.querySelector(".edit-btn"));
      await page.settle();
      await typeInto(page, card?.querySelector(".edit-box textarea") ?? null, "my typed text");
      press(page, card?.querySelector(".edit-save"));
      await page.settle();
      expect(page.document.querySelector("#error-banner")?.textContent).toBe(message);
      const box = card?.querySelector(".edit-box textarea") as HTMLTextAreaElement | null;
      expect(box?.value).toBe("my typed text");
      expect((card?.querySelector(".edit-save") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      page.close();
    }
  });

  it("edits own conversation comments and thread comments, with the comment id", async () => {
    const page = await openView({ replies: { [PR_PATH]: { body: editableAnswer() } } });
    try {
      page.respond(EDIT_PATH, { body: { ok: true, body: "edited" } });
      // The conversation comment c1.
      const cards = [...page.document.querySelectorAll(".comment-card")];
      const c1 = cards[1];
      expect(c1?.textContent).toContain("First comment");
      press(page, c1?.querySelector(".edit-btn"));
      await page.settle();
      await typeInto(page, c1?.querySelector(".edit-box textarea") ?? null, "edited");
      press(page, c1?.querySelector(".edit-save"));
      await page.settle();

      // The thread comment t2c1, in the unresolved thread.
      const thread = page.document.querySelector("#thread-T2");
      expect(thread?.querySelectorAll(".edit-btn")).toHaveLength(1);
      expect(page.document.querySelector("#thread-T1 .edit-btn")).toBeNull();
      press(page, thread?.querySelector(".edit-btn"));
      await page.settle();
      await typeInto(page, thread?.querySelector(".edit-box textarea") ?? null, "edited line note");
      press(page, thread?.querySelector(".edit-save"));
      await page.settle();

      const posts = page.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body));
      expect(posts).toEqual([
        { body: "edited", baseBody: "First comment", commentId: "c1" },
        { body: "edited line note", baseBody: "This line is gone", commentId: "t2c1" },
      ]);
    } finally {
      page.close();
    }
  });
});

describe("the thread an address names", () => {
  // The scroll itself is a layout fact, so test/browser/github-pr.browser.ts checks it
  // in Chromium.
  it("opens it and marks it, and leaves the other thread unmarked", async () => {
    const page = await openView({
      path: "/github/pr/acme/widgets/12#thread-T1",
      replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } },
    });
    try {
      const card = page.document.getElementById("thread-T1");
      // A resolved thread is folded unless the address names it.
      expect(card?.querySelector(".thread-inner")?.className).toBe("thread-inner");
      expect(card?.className).toBe("thread-card thread-target");
      expect(card?.querySelector(".thread-toggle")?.textContent).toBe("▾ Hide resolved thread (1 comment)");
      // The other thread is not marked.
      expect(page.document.getElementById("thread-T2")?.className).toBe("thread-card");
    } finally {
      page.close();
    }
  });

  it("does nothing for an id the pull request does not have", async () => {
    const page = await openView({
      path: "/github/pr/acme/widgets/12#thread-nope",
      replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } },
    });
    try {
      expect(page.document.querySelectorAll(".thread-target")).toHaveLength(0);
      // A resolved thread stays folded when the address names another thread.
      expect(page.document.getElementById("thread-T1")?.querySelector(".thread-inner")?.className).toBe(
        "thread-inner hidden",
      );
    } finally {
      page.close();
    }
  });
});

describe("the bar the page is served with", () => {
  it("names the repositories and the login, and opens the sidebar as a drawer", async () => {
    const page = await openView({ replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("acme/widgets · @octocat");
      const toggle = page.document.querySelector("#sidebar-toggle");
      if (!(toggle instanceof page.window.HTMLElement)) throw new Error("the page drew no drawer button");
      toggle.click();
      await page.settle();
      expect(page.document.body.className).toBe("sidebar-open");
    } finally {
      page.close();
    }
  });

  it("draws no login and no repository when the page carries no meta block", async () => {
    const page = await openView({ metaBlock: false, replies: { "/api/github/pr/acme/widgets/12": { body: prAnswer() } } });
    try {
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("");
      // No block means no write switch, and the safe side of that is off.
      expect(page.document.querySelectorAll("textarea")).toHaveLength(0);
      expect(page.document.querySelector(".dash-title")?.textContent).toContain("Fix the flux capacitor");
    } finally {
      page.close();
    }
  });
});
