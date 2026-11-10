/**
 * The pull request list page, drawn from a fake answer.
 *
 * The page is the dashboard's front door, and four of its rules are the ones a
 * reader notices when they break:
 *
 * 1. The first answer is the server's. The server writes the list it already holds
 *    into the page, so the rows are there with the page and not one round trip
 *    later.
 * 2. A frame on the stream is a request to read again, and nothing else. The read
 *    that started last is the one that draws, so a slow answer cannot put an older
 *    list over a newer one.
 * 3. `⟳ Reload` asks GitHub itself (`?refresh=1`), and a failure of any read leaves
 *    the rows where they are and puts the server's sentence in the strip.
 * 4. A tab that comes back draws the list it kept, and an answer too large for the
 *    tab's storage is still drawn from memory. That is what the session store is
 *    for, and the key prefix is a fixed one.
 *
 * The page is loaded the way the server and the browser load it: the real shell
 * from `src/web/github-pr-list.html`, the stamps the server writes, the two JSON
 * blocks, `base.js`, and the test bundle of the real entry module. The harness in
 * `test/ui/harness.ts` knows the four older pages only, so this file carries the
 * small loader it needs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildUi, ROOT } from "../../scripts/build-ui.mjs";
import { readMeta, readFirstList, readFirstPending, writesEnabled } from "../../src/ui/github-pr/blocks.ts";
import { STORE_PREFIX, draftQueueStoreKey, forgetStored, pendingStoreKey, readStored, writeStored } from "../../src/ui/state/github-pr.ts";

/* ------------------------------------------------------------------ fixtures */

/** One label, as GitHub states it. */
function label(name: string, color: string) {
  return { name, color };
}

/** One pull request of the list. */
function pr(
  repo: string,
  number: number,
  title: string,
  extra: Partial<{
    isDraft: boolean;
    author: string | null;
    ciState: string | null;
    labels: { name: string; color: string }[];
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
  }> = {},
) {
  return {
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: extra.isDraft ?? false,
    author: extra.author === undefined ? "octocat" : extra.author,
    updatedAt: extra.updatedAt ?? "2026-10-29T10:00:00Z",
    headRefName: extra.headRefName ?? `feature-${number}`,
    baseRefName: extra.baseRefName ?? "main",
    reviewDecision: null,
    labels: extra.labels ?? [],
    ciState: extra.ciState === undefined ? "SUCCESS" : extra.ciState,
    repo,
  };
}

/** The five sections, in the server's order, with one row in the first. */
function listAnswer(over: { title?: string } = {}) {
  return {
    viewer: "octocat",
    repos: [{ repo: "acme/widgets" }],
    sections: [
      {
        key: "mentioned",
        title: "Mentioned",
        prs: [
          pr("acme/widgets", 12, over.title ?? "Fix the flux capacitor", {
            labels: [label("bug", "d73a4a"), label("help wanted", "008672")],
          }),
        ],
      },
      { key: "need-review", title: "Need review", prs: [] },
      { key: "opened", title: "Opened", prs: [pr("acme/widgets", 11, "Add a spinner", { isDraft: false })] },
      { key: "draft", title: "Draft", prs: [pr("acme/widgets", 9, "Spike: sagas", { isDraft: true })] },
      { key: "related", title: "Related", prs: [pr("acme/widgets", 3, "Bump deps", { ciState: "FAILURE" })] },
    ],
  };
}

/** The saved reviews the server wrote into the page: one of each kind of row. */
function pendingAnswer() {
  const pr = (title: string, state: string, isDraft = false) => ({
    title,
    url: "https://github.com/acme/widgets/pull/1",
    state,
    isDraft,
    author: "octocat",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  return {
    reviews: [
      { kind: "draft", repo: "acme/widgets", number: 12, configured: true, comments: 3, summary: true, event: "APPROVE", savedAt: "2026-10-06T00:00:00.000Z", pr: pr("Fix the flux capacitor", "OPEN") },
      { kind: "draft", repo: "acme/widgets", number: 99, configured: true, comments: 1, summary: false, event: "COMMENT", savedAt: "2026-10-05T00:00:00.000Z", pr: pr("Closed work", "CLOSED") },
      { kind: "draft", repo: "acme/widgets", number: 98, configured: true, comments: 2, summary: false, event: "REQUEST_CHANGES", savedAt: "2026-10-04T00:00:00.000Z", pr: pr("Merged work", "MERGED") },
      { kind: "draft", repo: "acme/widgets", number: 97, configured: true, comments: 0, summary: true, event: "COMMENT", savedAt: "2026-10-03T00:00:00.000Z", pr: null },
      { kind: "draft", repo: "old/tool", number: 4, configured: false, comments: 1, summary: false, event: "COMMENT", savedAt: "2026-10-02T00:00:00.000Z", pr: pr("Left behind", "OPEN", true) },
      { kind: "unreadable", repo: "acme/widgets", number: 7, file: "acme+widgets+7.json.unreadable-1767000000000", savedAt: "2026-10-01T00:00:00.000Z" },
    ],
  };
}

/** What `github-pr-meta` holds when writes are on. */
const META_WRITES = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: true };

/** What it holds when writes are off. */
const META_READ_ONLY = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: false };

/* -------------------------------------------------------------------- loader */

/** One request the fake `fetch` saw. */
interface Call {
  readonly path: string;
  readonly method: string;
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
  readonly streams: FakeSource[];
  /** Answer a path from now on. */
  respond(path: string, reply: Reply): void;
  /** Send one frame on the page's current stream. */
  emit(name: string): void;
  /** A microtask and a macrotask, so the page's reads can answer. */
  settle(): Promise<void>;
  close(): void;
}

/** An `EventSource` stand-in, which records itself so a test can drive a frame. */
class FakeSource {
  static instances: FakeSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  readyState = 0;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}

  emit(type: string, payload?: unknown): void {
    const data = payload === undefined ? "" : JSON.stringify(payload);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data });
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
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

/** The shell with the server's stamps and the three blocks in it. */
async function shell(options: {
  readonly base?: string;
  readonly meta?: unknown;
  readonly first?: unknown;
  readonly pending?: unknown;
  readonly metaBlock?: boolean;
}): Promise<string> {
  const base = options.base ?? "";
  let html = await readFile(join(ROOT, "src/web/github-pr-list.html"), "utf8");
  html = html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, '<meta name="pi-sec-timezone" content="Asia/Tokyo" />');
  html = html.replace("<!--github-pr-meta-->", options.metaBlock === false ? "" : block("github-pr-meta", options.meta ?? META_WRITES));
  html = html.replace("<!--github-pr-list-first-->", options.first === undefined ? "" : block("github-pr-list-first", options.first));
  html = html.replace("<!--github-pr-pending-first-->", options.pending === undefined ? "" : block("github-pr-pending-first", options.pending));
  return html;
}

/** Load the list page with the server faked. */
async function openList(
  options: {
    readonly base?: string;
    readonly meta?: unknown;
    readonly metaBlock?: boolean;
    readonly first?: unknown;
    readonly pending?: unknown;
    readonly url?: string;
    readonly replies?: Readonly<Record<string, Reply>>;
    /** Run before the page's bundle, so a test can plant what a tab already held. */
    readonly before?: (window: JSDOM["window"]) => void;
  } = {},
): Promise<Page> {
  const code = await bundle();
  const source = code["github-pr-list"];
  if (source === undefined) throw new Error("the test build has no github-pr-list page bundle");

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });

  FakeSource.instances = [];
  const dom = new JSDOM(await shell(options), {
    url: `http://localhost${options.url ?? "/github/pr/"}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const document = window.document;
  const calls: Call[] = [];
  const replies = new Map<string, Reply>(Object.entries(options.replies ?? {}));

  (window as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ path: url.pathname + url.search, method: (init?.method ?? "GET").toUpperCase() });
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
  (window as unknown as { EventSource: unknown }).EventSource = FakeSource;

  options.before?.(window);
  window.eval(await readFile(join(ROOT, "src/web/base.js"), "utf8"));
  window.eval(source);

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();

  return {
    window,
    document,
    calls,
    streams: FakeSource.instances,
    respond(path, reply) {
      replies.set(path, reply);
    },
    emit(name) {
      const current = FakeSource.instances.at(-1);
      if (current === undefined) throw new Error("the page opened no stream");
      current.emit(name);
    },
    settle,
    close() {
      dom.window.close();
    },
  };
}

/** The titles of the rows the page drew, in the order it drew them. */
function rowTitles(document: Document): (string | null | undefined)[] {
  return [...document.querySelectorAll(".pr-row .pr-title")].map((title) => title.childNodes[0]?.textContent);
}

/** The people the section heads name, with their counts. */
function sectionHeads(document: Document): { title: string; count: string }[] {
  return [...document.querySelectorAll(".section")].map((section) => ({
    title: section.querySelector(".section-header")?.textContent?.replace(/\d+$/, "").trim() ?? "",
    count: section.querySelector(".section-count")?.textContent ?? "",
  }));
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

/* --------------------------------------------------------------------- tests */

describe("the list page's first answer", () => {
  it("draws the list the server wrote into the page, before any request answers", async () => {
    // The read never answers, so every row on screen came from the block.
    const page = await openList({ first: listAnswer(), replies: { "/api/github/pr/list": () => new Promise<Answer>(() => {}) } });
    try {
      expect(rowTitles(page.document)).toEqual(["Fix the flux capacitor", "Add a spinner", "Spike: sagas", "Bump deps"]);
      // It asks anyway: the block is where the list was when the page was built.
      expect(page.calls.map((call) => call.path)).toEqual(["/api/github/pr/list"]);
    } finally {
      page.close();
    }
  });

  it("says it is loading when the server had no list", async () => {
    const page = await openList({ first: undefined, replies: { "/api/github/pr/list": () => new Promise<Answer>(() => {}) } });
    try {
      expect(page.document.querySelector("#view .empty")?.textContent).toBe("Loading pull requests…");
    } finally {
      page.close();
    }
  });

  it("asks the server when the block is a value this build cannot read", async () => {
    for (const first of ["not a list", { sections: "no" }, []]) {
      const page = await openList({ first, replies: { "/api/github/pr/list": { body: listAnswer() } } });
      try {
        expect(page.document.querySelectorAll(".pr-row")).toHaveLength(4);
      } finally {
        page.close();
      }
    }
  });
});

describe("the sections of the list", () => {
  it("draws one box per section, in the server's order, with its title and count", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      expect(sectionHeads(page.document)).toEqual([
        { title: "Mentioned", count: "1" },
        { title: "Need review", count: "0" },
        { title: "Opened", count: "1" },
        { title: "Draft", count: "1" },
        { title: "Related", count: "1" },
      ]);
    } finally {
      page.close();
    }
  });

  it("says a section is empty rather than hiding it", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      const empty = [...page.document.querySelectorAll(".section-empty")];
      expect(empty.map((line) => line.textContent)).toEqual(["No pull requests"]);
      // The empty box is the second one, which is the section the server sent empty.
      expect(empty[0]?.closest(".section")?.querySelector(".section-header")?.textContent).toBe("Need review0");
    } finally {
      page.close();
    }
  });

  it("puts a row's number, author, branches, age, labels and CI mark on it", async () => {
    const page = await openList({ first: listAnswer(), replies: {} });
    try {
      const first = page.document.querySelector(".pr-row");
      expect(first?.getAttribute("href")).toBe("/github/pr/acme/widgets/12");
      // The age is the shared relative-time part's words, and this file loads the
      // page without a fixed clock, so only the shape of the sentence is pinned.
      expect(first?.querySelector(".pr-sub")?.textContent).toMatch(
        /^#12 · octocat · feature-12 → main · updated .+ ago$|^#12 · octocat · feature-12 → main · updated just now$/,
      );
      // A single repository is not named on every row.
      expect(first?.querySelector(".pr-sub")?.textContent).not.toContain("acme/widgets");
      const chips = [...(first?.querySelectorAll(".label-chip") ?? [])];
      expect(chips.map((chip) => chip.textContent)).toEqual(["bug", "help wanted"]);
      // The colour comes from a style object the script sets, which is what the
      // page's policy allows: a `style` attribute written into markup is refused
      // by `style-src 'self'`. jsdom reflects the property into the attribute, so
      // the value is read through the CSSOM, as the browser paints it.
      expect((chips[0] as HTMLElement).style.backgroundColor).toBe("rgb(215, 58, 74)");
      expect((chips[0] as HTMLElement).style.color).toBe("rgb(255, 255, 255)");
      expect((chips[1] as HTMLElement).style.color).toBe("rgb(255, 255, 255)");
    } finally {
      page.close();
    }
  });

  it("marks a draft, a CI failure and a draft's own mark", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      const rows = [...page.document.querySelectorAll(".pr-row")];
      // The description's age is printed by the shared relative-time part, so a
      // moment far from the test's clock says how long ago it was.
      expect(rows[0]?.querySelector(".pr-icon")?.textContent).toBe("⊙");
      expect(rows[2]?.querySelector(".pr-icon")?.textContent).toBe("◐");
      expect(rows[0]?.querySelector(".ci-ok")?.getAttribute("title")).toBe("CI passed");
      expect(rows[3]?.querySelector(".ci-fail")?.getAttribute("title")).toBe("CI failed");
    } finally {
      page.close();
    }
  });

  it("names the repository on every row when the dashboard watches more than one", async () => {
    const page = await openList({
      first: listAnswer(),
      meta: { viewer: "octocat", repos: [{ repo: "acme/widgets" }, { repo: "acme/gadgets" }], writes: true },
    });
    try {
      expect(page.document.querySelector(".pr-row .pr-sub")?.textContent?.endsWith("· acme/widgets")).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe("the requests the list page makes", () => {
  it("reads the list again when the stream says it changed, and draws that answer", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      expect(page.calls).toHaveLength(1);
      page.respond("/api/github/pr/list", { body: listAnswer({ title: "Renamed while you watched" }) });
      page.emit("prs");
      await page.settle();
      expect(page.calls.filter((call) => call.path === "/api/github/pr/list")).toHaveLength(2);
      expect(rowTitles(page.document)[0]).toBe("Renamed while you watched");
    } finally {
      page.close();
    }
  });

  it("opens the stream on the dashboard's own route and nothing else", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      expect(page.streams.map((stream) => stream.url)).toEqual(["/api/github/pr/events"]);
      // The stream heard the frame name it needs and no other.
      // `prs` is the dashboard's own frame; `open` and `error` are the two the
      // stream client listens to so it knows when the connection came and went.
      expect([...(page.streams[0]?.listeners.keys() ?? [])]).toEqual(["prs", "open", "error"]);
    } finally {
      page.close();
    }
  });

  it("draws the answer of the read that started last, and drops the one that answers later", async () => {
    let releaseSlow: ((answer: Answer) => void) | null = null;
    let slow = true;
    const page = await openList({
      first: listAnswer(),
      replies: {
        "/api/github/pr/list": () =>
          slow
            ? new Promise<Answer>((resolve) => {
                releaseSlow = resolve;
                slow = false;
              })
            : { body: listAnswer({ title: "The newer read" }) },
      },
    });
    try {
      // The page's own read is still held, and the frame starts a second one.
      page.emit("prs");
      await page.settle();
      expect(page.calls.filter((call) => call.path === "/api/github/pr/list")).toHaveLength(2);
      expect(rowTitles(page.document)[0]).toBe("The newer read");

      // The older read answers now, with an older list, and draws nothing.
      releaseSlow!({ body: listAnswer({ title: "The older read" }) });
      await page.settle();
      expect(rowTitles(page.document)[0]).toBe("The newer read");
    } finally {
      page.close();
    }
  });

  it("asks GitHub for a forced refresh, and disables the button while it runs", async () => {
    let release: ((answer: Answer) => void) | null = null;
    const page = await openList({
      first: listAnswer(),
      replies: {
        "/api/github/pr/list?refresh=1": () =>
          new Promise<Answer>((resolve) => {
            release = resolve;
          }),
      },
    });
    try {
      const reload = page.document.querySelector("#reload") as HTMLButtonElement;
      expect(reload.textContent).toBe("⟳ Reload");
      expect(reload.disabled).toBe(false);

      reload.click();
      await page.settle();
      expect(page.calls.map((call) => call.path)).toEqual(["/api/github/pr/list", "/api/github/pr/list?refresh=1"]);
      expect(reload.disabled).toBe(true);
      // The bar says work is running rather than looking dead.
      expect(page.document.querySelector("#loading")?.className).toBe("loading");

      release!({ body: listAnswer({ title: "Fresh from GitHub" }) });
      await page.settle();
      expect(rowTitles(page.document)[0]).toBe("Fresh from GitHub");
      expect(reload.disabled).toBe(false);
      expect(page.document.querySelector("#loading")?.className).toBe("loading hidden");
    } finally {
      page.close();
    }
  });

  it("keeps the rows and shows the server's sentence when a read fails", async () => {
    const page = await openList({
      first: listAnswer(),
      replies: {
        "/api/github/pr/list": { body: listAnswer() },
        "/api/github/pr/list?refresh=1": { status: 502, body: { error: "gh: could not resolve to a Repository" } },
      },
    });
    try {
      const strip = page.document.querySelector("#error-banner");
      expect(strip?.className).toBe("error-banner hidden");
      (page.document.querySelector("#reload") as HTMLButtonElement).click();
      await page.settle();
      expect(strip?.className).toBe("error-banner");
      expect(strip?.textContent).toBe("gh: could not resolve to a Repository");
      // The list a reader was reading is still there.
      expect(page.document.querySelectorAll(".pr-row")).toHaveLength(4);
    } finally {
      page.close();
    }
  });

  it("draws a disk-limit refusal's sentence as the server wrote it", async () => {
    const page = await openList({
      first: undefined,
      replies: {
        "/api/github/pr/list": { status: 409, body: { error: "disk_limit", currentMegabytes: 10, estimateMegabytes: 4000, limitMegabytes: 2048 } },
      },
    });
    try {
      // The message of that refusal is its code, which is what the route writes;
      // the numbers beside it are for the page that shows them (the diff page).
      expect(page.document.querySelector("#error-banner")?.textContent).toBe("disk_limit");
      expect(page.document.querySelector("#view .empty")?.textContent).toBe("Loading pull requests…");
    } finally {
      page.close();
    }
  });
});

describe("the tab's own copy of the list", () => {
  it("keeps the answer under the fixed key prefix, and draws it before the first read answers", async () => {
    const first = await openList({ first: listAnswer() });
    let kept: string | null = null;
    try {
      kept = first.window.sessionStorage.getItem(`${STORE_PREFIX}list`);
      expect(kept).not.toBeNull();
      expect(JSON.parse(kept ?? "null")).toEqual(listAnswer());
      // Nothing else of this dashboard is in the tab's storage.
      expect(first.window.sessionStorage.length).toBe(1);
      expect(first.window.sessionStorage.key(0)).toBe(`${STORE_PREFIX}list`);
    } finally {
      first.close();
    }

    // A second load of the page, with no block and a read that never answers:
    // every row came from what the tab kept.
    const page = await openList({
      first: undefined,
      replies: { "/api/github/pr/list": () => new Promise<Answer>(() => {}) },
      before: (window) => {
        window.sessionStorage.setItem(`${STORE_PREFIX}list`, kept ?? "");
      },
    });
    try {
      expect(rowTitles(page.document)).toEqual(["Fix the flux capacitor", "Add a spinner", "Spike: sagas", "Bump deps"]);
    } finally {
      page.close();
    }
  });

  it("keeps an answer the tab's storage refuses in memory, and says nothing", () => {
    // A storage that refuses anything over a small size, as a browser does when the
    // quota is full. The value is still readable in this tab, which is what the
    // page needs; only the copy that outlives the tab is missing.
    const kept = new Map<string, string>();
    const refusal = new Error("QuotaExceededError");
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 64) throw refusal;
        kept.set(key, value);
      },
      removeItem: (key: string) => {
        kept.delete(key);
      },
    };

    const big = { sections: [], filler: "x".repeat(200) };
    writeStored("diff:acme/widgets:12", big);
    expect(readStored("diff:acme/widgets:12")).toEqual(big);
    // The refused write left nothing behind under that key.
    expect(kept.has(`${STORE_PREFIX}diff:acme/widgets:12`)).toBe(false);

    // A small value is persisted, so the difference is the size and not the key.
    writeStored("list", { sections: [] });
    expect(kept.get(`${STORE_PREFIX}list`)).toBe('{"sections":[]}');
  });

  it("keeps a stored answer of a shape this build cannot read as a miss", () => {
    const kept = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => {
        kept.set(key, value);
      },
      removeItem: (key: string) => {
        kept.delete(key);
      },
    };
    // The key is not in this tab's memory, which is what a value written by
    // another build looks like to this one.
    forgetStored("list");
    kept.set(`${STORE_PREFIX}list`, "{not json");
    expect(readStored("list")).toBeNull();
  });
});

describe("the header the page is served with", () => {
  it("names the repositories and the login in the bar", async () => {
    const page = await openList({ first: listAnswer() });
    try {
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("acme/widgets · @octocat");
      // The list page has no sidebar, so it draws no drawer button.
      expect(page.document.querySelector("#sidebar-toggle")).toBeNull();
      expect(page.document.querySelector(".brand")?.getAttribute("href")).toBe("/github/pr/");
    } finally {
      page.close();
    }
  });

  it("builds its links under the mount it is served from", async () => {
    const page = await openList({ base: "/sec", first: listAnswer() });
    try {
      expect(page.document.querySelector(".brand")?.getAttribute("href")).toBe("/sec/github/pr/");
      expect(page.document.querySelector(".pr-row")?.getAttribute("href")).toBe("/sec/github/pr/acme/widgets/12");
      // The requests carry the mount too, which is what makes the page work behind
      // a path-prefix proxy.
      expect(page.calls.map((call) => call.path)).toEqual(["/sec/api/github/pr/list"]);
      expect(page.streams.map((stream) => stream.url)).toEqual(["/sec/api/github/pr/events"]);
    } finally {
      page.close();
    }
  });

  it("draws no write control while the server says writes are off", async () => {
    const page = await openList({ first: listAnswer(), meta: META_READ_ONLY });
    try {
      // The list page never carries a write control; a page that would must ask
      // `writesEnabled()` before it draws one, which is what the block's value is
      // for. The bar still names the repositories and the login, because the read
      // side is on.
      expect(page.document.querySelectorAll("textarea")).toHaveLength(0);
      expect(page.document.querySelectorAll(".reply-box, .reply-btn, .reaction-pill")).toHaveLength(0);
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("acme/widgets · @octocat");
    } finally {
      page.close();
    }
  });

  it("draws no login and no repository when the page carries no meta block", async () => {
    const page = await openList({ first: listAnswer(), metaBlock: false });
    try {
      expect(page.document.querySelector("#repo-slug")?.textContent).toBe("");
      expect(page.document.querySelector("#repo-slug")?.getAttribute("title")).toBe("");
    } finally {
      page.close();
    }
  });
});

describe("the two blocks, read on their own", () => {
  /** Point the module's `document` at one page, run `read`, and put it back. */
  async function withBlocks(html: string, read: () => unknown): Promise<unknown> {
    const dom = new JSDOM(html, { url: "http://localhost/github/pr/" });
    const had = Object.hasOwn(globalThis, "document");
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = dom.window.document;
    try {
      return read();
    } finally {
      if (had) (globalThis as { document?: unknown }).document = previous;
      else delete (globalThis as { document?: unknown }).document;
      dom.window.close();
    }
  }

  it("reads the write switch, and says off for a block that is absent or unreadable", async () => {
    expect(await withBlocks(block("github-pr-meta", META_WRITES), writesEnabled)).toBe(true);
    expect(await withBlocks(block("github-pr-meta", META_READ_ONLY), writesEnabled)).toBe(false);
    // A block without the switch, one that is not JSON, and no block at all are
    // all "off": a control that would refuse is never drawn.
    expect(await withBlocks(block("github-pr-meta", { viewer: "octocat", repos: [] }), writesEnabled)).toBe(false);
    expect(await withBlocks('<script type="application/json" id="github-pr-meta">nope</script>', writesEnabled)).toBe(false);
    expect(await withBlocks("", writesEnabled)).toBe(false);
  });

  it("reads the header's facts and the first list", async () => {
    expect(await withBlocks(block("github-pr-meta", META_WRITES), readMeta)).toEqual(META_WRITES);
    expect(await withBlocks("", readMeta)).toEqual({ viewer: null, repos: [], writes: false });
    expect(await withBlocks(block("github-pr-list-first", listAnswer()), readFirstList)).toEqual(listAnswer());
    expect(await withBlocks("", readFirstList)).toBeUndefined();
    expect(await withBlocks(block("github-pr-pending-first", pendingAnswer()), readFirstPending)).toEqual(pendingAnswer());
    expect(await withBlocks(block("github-pr-pending-first", { reviews: "no" }), readFirstPending)).toBeUndefined();
    expect(await withBlocks(block("github-pr-pending-first", { reviews: [{ kind: "other" }] }), readFirstPending)).toBeUndefined();
    expect(await withBlocks("", readFirstPending)).toBeUndefined();
  });
});

describe("the three shells the dashboard is served as", () => {
  /** One shell's text. */
  async function shellOf(name: string): Promise<string> {
    return await readFile(join(ROOT, "src/web", name), "utf8");
  }

  /** The `href` of every stylesheet a shell loads. */
  function sheetsFor(html: string): string[] {
    return [...html.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].map((match) => match[1] ?? "");
  }

  it("loads its own bundle, its own stylesheet, and no pi-sec theme", async () => {
    for (const [name, bundle] of [
      ["github-pr-list.html", "ui-github-pr-list.js"],
      ["github-pr-view.html", "ui-github-pr-view.js"],
      ["github-pr-diff.html", "ui-github-pr-diff.js"],
    ] as const) {
      const html = await shellOf(name);
      expect(html, name).toContain(`{{base}}/${bundle}`);
      expect(html, name).toContain('{{base}}/github-pr.css');
      // pi-sec's own theme and layout are not loaded: this theme is GitHub's.
      // Only the `href` of a stylesheet is read, because the comments name the
      // two files they say are not loaded.
      const sheets = sheetsFor(html);
      expect(sheets, name).not.toContain("{{base}}/theme.css");
      expect(sheets, name).not.toContain("{{base}}/styles.css");
      // The palette is the code-block one, and only a page that draws code loads
      // it: the list draws none.
      const drawsCode = name !== "github-pr-list.html";
      expect(sheetsFor(html).includes("{{base}}/ui-highlight-github.css"), name).toBe(drawsCode);
      // The mount rule runs before the page module.
      expect(html.indexOf("{{base}}/base.js"), name).toBeLessThan(html.indexOf(`{{base}}/${bundle}`));
      // The page carries no inline script and no inline style: its policy allows
      // neither. The comments are dropped first, because they name the blocks the
      // server writes and say that a style attribute is refused.
      const markup = html.replace(/<!--[\s\S]*?-->/g, "");
      expect(markup, name).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);
      expect(markup, name).not.toMatch(/\sstyle=/);
    }
  });

  it("leaves the data blocks to the server, and only the list page takes the second and the third", async () => {
    const list = await shellOf("github-pr-list.html");
    expect(list).toContain("<!--github-pr-meta-->");
    expect(list).toContain("<!--github-pr-list-first-->");
    expect(list).toContain("<!--github-pr-pending-first-->");
    // The page writes the three elements the script takes over.
    expect(list).toContain('id="topbar"');
    expect(list).toContain('id="error-banner"');
    expect(list).toContain('id="view"');

    for (const name of ["github-pr-view.html", "github-pr-diff.html"]) {
      const html = await shellOf(name);
      expect(html, name).toContain("<!--github-pr-meta-->");
      expect(html, name).not.toContain("github-pr-list-first");
      expect(html, name).not.toContain("github-pr-pending-first");
    }
  });

  it("carries one title of pi-sec's own and no other mark", async () => {
    for (const name of ["github-pr-list.html", "github-pr-view.html", "github-pr-diff.html"]) {
      const html = await shellOf(name);
      // One title, and it is this server's: the shell belongs to pi-sec, and the
      // dashboard whose layout it takes does not own its heading.
      expect(html.match(/<title>/gu), name).toHaveLength(1);
      expect(html, name).toContain("<title>Pull requests · pi-sec</title>");
      // The only characters outside ASCII are the middle dot of the title and the
      // ellipsis the markup carries, so no pictograph and no other letter came
      // along with the port.
      const outside = [...new Set([...html].filter((character) => character.codePointAt(0) > 0x7f))];
      expect(outside.sort(), name).toEqual(["·", "…"].sort());
    }
  });
});

describe("the Pending reviews section", () => {
  /** The rows of the section, as the words a reader sees. */
  function pendingRows(document: Document) {
    return [...document.querySelectorAll(".pending-section .pending-row")].map((row) => ({
      state: row.querySelector(".pending-state")?.textContent,
      title: row.querySelector(".pr-title")?.textContent,
      href: row.querySelector(".pr-title a")?.getAttribute("href") ?? null,
      sub: row.querySelector(".pr-sub")?.textContent?.replace(/ · saved .*$/, ""),
    }));
  }

  it("draws the saved reviews above the five sections, newest first", async () => {
    const page = await openList({ first: listAnswer(), pending: pendingAnswer() });
    try {
      expect(sectionHeads(page.document).map((head) => head.title)).toEqual([
        "Pending reviews",
        "Mentioned",
        "Need review",
        "Opened",
        "Draft",
        "Related",
      ]);
      expect(sectionHeads(page.document)[0]?.count).toBe("6");
      expect(pendingRows(page.document)).toEqual([
        { state: "Open", title: "Fix the flux capacitor", href: "/github/pr/acme/widgets/12/diff", sub: "#12 · acme/widgets · 3 comments · overall comment · Approve" },
        { state: "Closed", title: "Closed work", href: "/github/pr/acme/widgets/99/diff", sub: "#99 · acme/widgets · 1 comment" },
        { state: "Merged", title: "Merged work", href: "/github/pr/acme/widgets/98/diff", sub: "#98 · acme/widgets · 2 comments · Request changes" },
        { state: "Unknown", title: "Pull request #97", href: "/github/pr/acme/widgets/97/diff", sub: "#97 · acme/widgets · overall comment" },
        // A repository that is not in the settings has no dashboard page: the title goes to GitHub.
        { state: "Draft", title: "Left behind", href: "https://github.com/acme/widgets/pull/1", sub: "#4 · old/tool · 1 comment · not in settings" },
        { state: "Unknown", title: "This saved review cannot be read", href: null, sub: "#7 · acme/widgets" },
      ]);
      // A row is a div with a link and a button, and no button sits inside a link.
      expect(page.document.querySelectorAll(".pending-row a button, .pending-row button a")).toHaveLength(0);
      expect(page.document.querySelectorAll(".pending-row .pending-delete")).toHaveLength(6);
      // The saved reviews came with the page, so the page asked for the list only.
      expect(page.calls.map((call) => call.path)).toEqual(["/api/github/pr/list"]);
    } finally {
      page.close();
    }
  });

  it("shows the box with its empty sentence when no saved review exists, and no box when the server sent none", async () => {
    const empty = await openList({ first: listAnswer(), pending: { reviews: [] } });
    try {
      expect(sectionHeads(empty.document)[0]).toEqual({ title: "Pending reviews", count: "0" });
      expect(empty.document.querySelector(".pending-section .section-empty")?.textContent).toBe("No saved reviews");
    } finally {
      empty.close();
    }
    const none = await openList({ first: listAnswer() });
    try {
      expect(none.document.querySelector(".pending-section")).toBeNull();
      expect(sectionHeads(none.document)).toHaveLength(5);
    } finally {
      none.close();
    }
  });

  it("shows a pull request with a saved review in the Pending reviews box only", async () => {
    // The server leaves the pull request out of the list it sends, so the head
    // of its section counts one less, and the box holds it.
    const without = listAnswer();
    const withRow = listAnswer();
    withoutRow(without);
    const page = await openList({ first: without, pending: pendingAnswer() });
    const before = await openList({ first: withRow });
    try {
      expect(sectionHeads(before.document)[0]).toEqual({ title: "Mentioned", count: "1" });
      expect(sectionHeads(page.document)[1]).toEqual({ title: "Mentioned", count: "0" });
      expect(rowTitles(page.document)).not.toContain("Fix the flux capacitor");
      expect(pendingRows(page.document)[0]?.title).toBe("Fix the flux capacitor");
    } finally {
      page.close();
      before.close();
    }
  });

  /** Take the first pull request out of the Mentioned section, as the server does for a saved review. */
  function withoutRow(answer: ReturnType<typeof listAnswer>): void {
    answer.sections[0]!.prs.length = 0;
  }

  it("asks before it deletes, and sends nothing when the reader cancels", async () => {
    const remaining = { reviews: pendingAnswer().reviews.slice(1) };
    const page = await openList({
      first: listAnswer(),
      pending: pendingAnswer(),
      replies: { "/api/github/pr/drafts/discard": { body: { deleted: true } }, "/api/github/pr/pending": { body: remaining } },
      before(window) {
        // The tab holds the review's own copies, which a delete must drop.
        window.sessionStorage.setItem(STORE_PREFIX + pendingStoreKey("acme/widgets", 12), "[]");
        window.sessionStorage.setItem(STORE_PREFIX + draftQueueStoreKey("acme/widgets", 12), "[]");
        window.sessionStorage.setItem(STORE_PREFIX + pendingStoreKey("acme/widgets", 99), "[]");
      },
    });
    try {
      const asked: string[] = [];
      let answer = false;
      (page.window as unknown as { confirm: (message: string) => boolean }).confirm = (message) => {
        asked.push(message);
        return answer;
      };
      const button = (): HTMLButtonElement => page.document.querySelector(".pending-row .pending-delete") as HTMLButtonElement;
      const before = page.calls.length;

      button().click();
      await page.settle();
      expect(asked).toEqual(["Delete the saved review of acme/widgets #12? It holds 3 comments and an overall comment. This cannot be undone."]);
      expect(page.calls).toHaveLength(before);
      expect(pendingRows(page.document)).toHaveLength(6);

      answer = true;
      button().click();
      await page.settle();
      const sent = page.calls.slice(before);
      expect(sent).toEqual([
        { path: "/api/github/pr/drafts/discard", method: "POST" },
        { path: "/api/github/pr/pending", method: "GET" },
      ]);
      expect(pendingRows(page.document)).toHaveLength(5);
      expect(page.window.sessionStorage.getItem(STORE_PREFIX + pendingStoreKey("acme/widgets", 12))).toBeNull();
      expect(page.window.sessionStorage.getItem(STORE_PREFIX + draftQueueStoreKey("acme/widgets", 12))).toBeNull();
      // The copies of another pull request stay.
      expect(page.window.sessionStorage.getItem(STORE_PREFIX + pendingStoreKey("acme/widgets", 99))).toBe("[]");
    } finally {
      page.close();
    }
  });

  it("sends the repository, the number and the saved time of a draft, and the file name of a set-aside file", async () => {
    const bodies: unknown[] = [];
    const page = await openList({
      first: listAnswer(),
      pending: pendingAnswer(),
      replies: { "/api/github/pr/drafts/discard": { body: { deleted: true } }, "/api/github/pr/pending": { body: pendingAnswer() } },
    });
    try {
      const real = (page.window as unknown as { fetch: (input: unknown, init?: { body?: string; method?: string }) => Promise<unknown> }).fetch;
      (page.window as unknown as { fetch: unknown }).fetch = (input: unknown, init?: { body?: string; method?: string }) => {
        if (init?.method === "POST") bodies.push(JSON.parse(init.body ?? "null"));
        return real(input, init);
      };
      (page.window as unknown as { confirm: () => boolean }).confirm = () => true;
      const buttons = [...page.document.querySelectorAll(".pending-row .pending-delete")] as HTMLButtonElement[];
      buttons[0]!.click();
      await page.settle();
      buttons[5]!.click();
      await page.settle();
      expect(bodies).toEqual([
        { repo: "acme/widgets", number: 12, savedAt: "2026-10-06T00:00:00.000Z" },
        { file: "acme+widgets+7.json.unreadable-1767000000000" },
      ]);
    } finally {
      page.close();
    }
  });

  it("keeps the row and shows the server's sentence when the delete is refused", async () => {
    const page = await openList({
      first: listAnswer(),
      pending: pendingAnswer(),
      replies: {
        "/api/github/pr/drafts/discard": { status: 409, body: { error: "The saved review changed after this list showed it. Reload the list and try again." } },
      },
    });
    try {
      (page.window as unknown as { confirm: () => boolean }).confirm = () => true;
      (page.document.querySelector(".pending-row .pending-delete") as HTMLButtonElement).click();
      await page.settle();
      expect(page.document.querySelector("#error-banner")?.textContent).toBe(
        "The saved review changed after this list showed it. Reload the list and try again.",
      );
      expect(pendingRows(page.document)).toHaveLength(6);
    } finally {
      page.close();
    }
  });

  it("draws the Delete button while writes are off", async () => {
    const page = await openList({ first: listAnswer(), pending: pendingAnswer(), meta: META_READ_ONLY });
    try {
      expect(page.document.querySelectorAll(".pending-row .pending-delete")).toHaveLength(6);
    } finally {
      page.close();
    }
  });

  it("reads the saved reviews again when the stream says the list changed, and after Reload", async () => {
    const page = await openList({
      first: listAnswer(),
      pending: { reviews: [] },
      replies: {
        "/api/github/pr/pending": { body: pendingAnswer() },
        "/api/github/pr/list?refresh=1": { body: listAnswer() },
      },
    });
    try {
      expect(pendingRows(page.document)).toHaveLength(0);
      page.emit("prs");
      await page.settle();
      expect(pendingRows(page.document)).toHaveLength(6);
      expect(sectionHeads(page.document)[0]).toEqual({ title: "Pending reviews", count: "6" });

      page.respond("/api/github/pr/pending", { body: { reviews: pendingAnswer().reviews.slice(0, 2) } });
      (page.document.querySelector("#reload") as HTMLButtonElement).click();
      await page.settle();
      await page.settle();
      expect(pendingRows(page.document)).toHaveLength(2);
      expect(page.calls.map((call) => call.path)).toEqual([
        "/api/github/pr/list",
        "/api/github/pr/list",
        "/api/github/pr/pending",
        "/api/github/pr/list?refresh=1",
        "/api/github/pr/pending",
      ]);
    } finally {
      page.close();
    }
  });
});
