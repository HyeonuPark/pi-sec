/**
 * The report page: the list, one report, and the shell both live in.
 *
 * These are the old `test/report-ui.test.ts` assertions, rewritten against the
 * page bundle the browser gets. What is new here is the first requirement: where
 * the old page replaced the view's HTML, this one changes only what changed, so
 * the row the reader was on stays the row they were on, and the selector and the
 * compare box they just used keep their focus.
 *
 * Every page is loaded at the address it is served at, because the viewer reads
 * its slug off its own path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUiPage, root, settle, type FetchAnswer, type UiPageHandle } from "./harness.ts";

/* ------------------------------------------------------------- fixtures */

interface VersionFixture {
  n: number;
  at: number;
  note?: string;
  bytes: number;
  sha256: string;
  /** The server's record for this revision, when it has one for it. */
  approval?: { at?: number; via?: string; sha256?: string };
}

interface NoteFixture {
  id: string;
  at: number;
  body: string;
  version?: number;
  from: string;
}

interface ReportFixture {
  id: string;
  jobId: string;
  name: string;
  title: string;
  versions: VersionFixture[];
  feedback: NoteFixture[];
  createdAt: number;
  updatedAt: number;
  active: boolean;
  archived: boolean;
  /** The standing word the server sends beside the older flags. */
  status?: string;
  job: { id: string; title: string; status: string } | null;
}

/** The report every read serves. A fresh one per test, because an approval writes to it. */
function makeReport(): ReportFixture {
  return {
    id: "r1",
    jobId: "j1",
    name: "plan",
    title: "Plan",
    versions: [
      { n: 1, at: 1_000, bytes: 8, sha256: "a" },
      { n: 2, at: 2_000, note: "tweak", bytes: 8, sha256: "b" },
    ],
    feedback: [{ id: "f1", at: 3_000, body: "looks right", version: 2, from: "operator" }],
    createdAt: 1_000,
    updatedAt: 3_000,
    active: true,
    archived: false,
    status: "active",
    job: { id: "j1", title: "work", status: "active" },
  };
}

/** What the server answers for a revision body. */
const BODIES: Readonly<Record<string, string>> = { "1": "# Plan\n\nfirst\n", "2": "# Plan\n\nsecond\n" };

/** One comparison of v2 with v1, with a paired line whose words changed. */
const DIFF = {
  from: 1,
  to: 2,
  added: 1,
  removed: 1,
  identical: false,
  truncated: false,
  hunks: [
    {
      fromStart: 1,
      fromCount: 2,
      toStart: 1,
      toCount: 2,
      lines: [
        { kind: "same", text: "# Plan", fromLine: 1, toLine: 1 },
        {
          kind: "remove",
          text: "first <b>x</b>",
          fromLine: 2,
          segments: [
            { text: "first", changed: false },
            { text: " <b>", changed: true },
            { text: "x</b>", changed: false },
          ],
        },
        {
          kind: "add",
          text: "first <b>y</b>",
          toLine: 2,
          segments: [
            { text: "first", changed: false },
            { text: " <b>", changed: true },
            { text: "y</b>", changed: false },
          ],
        },
      ],
    },
  ],
};

/** The list the page reads unless a test hands it another one. */
function makeList(report: ReportFixture): unknown {
  return {
    reports: [
      report,
      {
        ...report,
        id: "r2",
        name: "old",
        title: "Old",
        active: false,
        status: "inactive",
        job: { id: "j1", title: "work", status: "done" },
      },
    ],
    archived: [{ ...report, id: "r3", name: "gone", title: "Gone", archived: true, active: false, status: "archived" }],
  };
}

interface OpenOptions {
  /** The address to load the page at. The page's own path by default. */
  readonly url?: string;
  /** The mount prefix the server stamped. */
  readonly base?: string;
  /** What `GET /api/reports` answers. */
  readonly list?: unknown;
  /** What the report's feedback list holds before anything is sent. */
  readonly feedback?: NoteFixture[];
  /** What `POST /api/reports/:id/approve` answers. */
  readonly approve?: { status?: number; body?: unknown };
  /** What a revision body route answers. */
  readonly bodies?: Readonly<Record<string, string>>;
  /** More routes, for a test that loads the page under a mount no stamp names. */
  readonly extra?: Readonly<Record<string, FetchAnswer>>;
}

interface OpenPage {
  readonly page: UiPageHandle;
  readonly report: ReportFixture;
}

/** Load the report page with the report routes answered. */
async function openReportPage(options: OpenOptions = {}): Promise<OpenPage> {
  const report = makeReport();
  if (options.feedback !== undefined) report.feedback = options.feedback;
  const bodies = options.bodies ?? BODIES;
  const approve = options.approve;
  const fetch: Record<string, FetchAnswer> = {
    "/api/reports": () => ({ body: options.list ?? makeList(report) }),
    "/api/reports/by-name/plan": () => ({ body: report }),
    "/api/reports/r1/diff": () => ({ body: DIFF }),
    "/api/reports/r1/approve": (request) => {
      const status = approve?.status ?? 201;
      // The record is written before the answer goes out, so the read that
      // follows an approval sees what a real server would have written.
      if (status < 400) report.versions[1]!.approval = { at: 5_000, via: "viewer", sha256: "b" };
      return { status, body: approve?.body ?? { at: 5_000, via: "viewer", sha256: "b" } };
    },
    "/api/reports/r1/feedback": () => ({ status: 201, body: {} }),
    "/api/reports/r1/versions/1": () => ({ text: bodies["1"] ?? "" }),
    "/api/reports/r1/versions/2": () => ({ text: bodies["2"] ?? "" }),
    ...options.extra,
  };
  const page = await loadUiPage("report", { url: options.url, base: options.base ?? "", fetch });
  // Two macrotasks, so a read that chains another read has both answered.
  await settle();
  await settle();
  return { page, report };
}

/** The number of times the page asked for the list. */
function listReads(page: UiPageHandle): number {
  return page.fetchCalls.filter((call) => call.method === "GET" && call.path === "/api/reports").length;
}

/** The number of times the page asked for the report by its slug. */
function reportReads(page: UiPageHandle): number {
  return page.fetchCalls.filter((call) => call.path === "/api/reports/by-name/plan").length;
}

/** The declarations of one rule, with the comments already stripped. */
function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`);
  return pattern.exec(css)?.[1] ?? "";
}

/* ----------------------------------------------------------------- list */

describe("report list", () => {
  it("separates live, finished, and archived reports", async () => {
    const { page } = await openReportPage();
    try {
      const text = page.document.getElementById("view")?.textContent ?? "";
      expect(text).toContain("Plan");
      expect(text).toContain("Finished");
      expect(text).toContain("Archive (1)");
      expect(page.document.querySelectorAll(".report-row")).toHaveLength(3);
    } finally {
      page.close();
    }
  });

  it("puts a report that is set aside in its own group, above the finished ones", async () => {
    const report = makeReport();
    const { page } = await openReportPage({
      list: {
        reports: [
          { ...report, id: "r1", name: "now", title: "Now", status: "active" },
          { ...report, id: "r2", name: "later", title: "Later", pendingAt: 4_000, status: "pending" },
        ],
        archived: [],
      },
    });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).toContain("Pending");
      expect(view.textContent).not.toContain("Finished");
      expect(view.textContent).toContain("Not finished, and not waiting on an answer right now.");
      // Its chip says the standing, and the two groups keep the server's order.
      expect([...view.querySelectorAll(".report-row .status-chip")].map((chip) => chip.textContent)).toEqual([
        "active",
        "pending",
      ]);
      expect(view.querySelector(".report-h2")?.textContent).toBe("Pending");
    } finally {
      page.close();
    }
  });

  it("reads the older flags when the server sends no standing word", async () => {
    const report = makeReport();
    const { page } = await openReportPage({
      list: {
        reports: [
          { ...report, status: undefined },
          { ...report, id: "r2", name: "old", title: "Old", active: false, status: undefined },
        ],
        archived: [],
      },
    });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).toContain("Finished");
      expect(view.querySelectorAll(".report-row")).toHaveLength(2);
    } finally {
      page.close();
    }
  });

  it("filters to one job when the address asks for it", async () => {
    const { page } = await openReportPage({ url: "/report?job=j1" });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).toContain("Filtered to work");
      expect(view.querySelectorAll(".report-row")).toHaveLength(3);
    } finally {
      page.close();
    }
  });

  it("shows nothing for a job with no reports", async () => {
    const { page } = await openReportPage({ url: "/report?job=nobody" });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).toContain("No active reports.");
      expect(view.querySelectorAll(".report-row")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("links each row at its own slug", async () => {
    const { page } = await openReportPage();
    try {
      const hrefs = [...page.document.querySelectorAll(".report-row")].map((row) => row.getAttribute("href"));
      expect(hrefs).toEqual(["/report/plan", "/report/old", "/report/gone"]);
    } finally {
      page.close();
    }
  });

  it("draws no link back to a report, which is what the back button is for", async () => {
    const { page } = await openReportPage();
    try {
      expect(page.document.getElementById("back-to-report")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("counts the feedback rows without the old word", async () => {
    const { page } = await openReportPage();
    try {
      expect(page.document.querySelector(".report-row .report-row-meta")?.textContent).toContain("1 feedback");
    } finally {
      page.close();
    }
  });

  it("reloads the list in place from the header button", async () => {
    const { page } = await openReportPage({ url: "/report?job=j1" });
    try {
      const button = page.document.getElementById("reload-list") as HTMLButtonElement;
      expect(button.classList.contains("hidden")).toBe(false);
      expect(listReads(page)).toBe(1);

      button.dispatchEvent(new page.window.Event("click"));
      await settle();
      await settle();

      expect(listReads(page)).toBe(2);
      // The list it was looking at is the list it reads again.
      expect(page.document.getElementById("view")?.textContent).toContain("Filtered to work");
    } finally {
      page.close();
    }
  });

  it("holds one read at a time", async () => {
    const { page } = await openReportPage();
    try {
      const button = page.document.getElementById("reload-list") as HTMLButtonElement;
      button.dispatchEvent(new page.window.Event("click"));
      // The first press has not answered yet, so the second one waits for it
      // instead of starting a read of its own.
      button.dispatchEvent(new page.window.Event("click"));
      await settle();
      await settle();
      expect(listReads(page)).toBe(2);
    } finally {
      page.close();
    }
  });

  it("keeps the rows, the focus and the list's scroll when it reads the list again", async () => {
    const { page, report } = await openReportPage();
    try {
      const row = page.document.querySelector(".report-row") as HTMLElement;
      const scroll = page.document.querySelector(".report-scroll") as HTMLElement;
      row.focus();
      scroll.scrollTop = 120;
      const rowBefore = page.capture(".report-row");
      const scrollBefore = page.capture(".report-scroll");
      const untouchedTitle = row.querySelector(".report-row-title")?.textContent;

      // The answer that comes back moved one report of the two: that one is a new
      // element, and the one the reader was on must not be.
      const changed = makeList(report) as { reports: ReportFixture[]; archived: ReportFixture[] };
      changed.reports[1] = { ...changed.reports[1]!, title: "Old, renamed" };
      page.respond("/api/reports", { body: changed });

      (page.document.getElementById("reload-list") as HTMLButtonElement).dispatchEvent(new page.window.Event("click"));
      await settle();
      await settle();

      expect(listReads(page)).toBe(2);
      const rows = [...page.document.querySelectorAll(".report-row")];
      expect(rows[1]?.querySelector(".report-row-title")?.textContent).toBe("Old, renamed");
      page.expectUntouched(rowBefore);
      page.expectUntouched(scrollBefore);
      expect(rows[0]).toBe(row);
      expect(row.querySelector(".report-row-title")?.textContent).toBe(untouchedTitle);
    } finally {
      page.close();
    }
  });
});

/* --------------------------------------------------------------- viewer */

describe("report viewer", () => {
  it("reads the report its address names", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.querySelector("h1.report-h1")?.textContent).toBe("Plan");
      expect((view.querySelector("#version-select") as HTMLSelectElement).value).toBe("2");
      expect(page.document.title).toBe("Plan · pi-sec");
      // The list's own button has nothing to reload here.
      expect(page.document.getElementById("reload-list")?.classList.contains("hidden")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("renders the latest revision as markdown", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const body = page.document.querySelector("#report-body") as HTMLElement;
      expect(body.innerHTML).toContain("<h1>Plan</h1>");
      expect(body.textContent).toContain("second");
    } finally {
      page.close();
    }
  });

  it("shows the feedback already left on it", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      expect(page.document.querySelector("#report-notes")?.textContent).toContain("looks right");
      expect(page.document.querySelector(".report-feedback .report-h2")?.textContent).toBe("Feedback");
    } finally {
      page.close();
    }
  });

  it("says the list is empty in the new words", async () => {
    const { page } = await openReportPage({ url: "/report/plan", feedback: [] });
    try {
      expect(page.document.querySelector("#report-notes")?.textContent).toContain("No feedback yet.");
    } finally {
      page.close();
    }
  });

  it("reloads the body when another revision is chosen", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const select = page.document.querySelector("#version-select") as HTMLSelectElement;
      select.value = "1";
      select.dispatchEvent(new page.window.Event("change"));
      await settle();
      await settle();

      expect(page.document.querySelector("#report-body")?.textContent).toContain("first");
      expect(page.fetchCalls.some((call) => call.path.endsWith("/versions/1"))).toBe(true);
    } finally {
      page.close();
    }
  });

  /** Choose a revision in the selector, as a reader does. */
  function choose(page: UiPageHandle, n: number): void {
    const select = page.document.querySelector("#version-select") as HTMLSelectElement;
    select.value = String(n);
    select.dispatchEvent(new page.window.Event("change"));
  }

  /** An answer that waits for the test: call the returned function to let it go. */
  function gated<T>(answer: () => T): { readonly answer: () => Promise<T>; readonly release: () => void } {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      answer: async () => {
        await open;
        return answer();
      },
      release,
    };
  }

  it("draws the revision chosen last when the two answers come back in reverse order", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const first = gated(() => ({ text: BODIES["1"] ?? "" }));
      page.respond("/api/reports/r1/versions/1", first.answer);
      choose(page, 1);
      await settle();
      choose(page, 2);
      await settle();
      await settle();
      first.release();
      await settle();
      await settle();

      expect(page.document.querySelector("#report-body")?.textContent).toContain("second");
      expect(page.document.querySelector("#report-body")?.textContent).not.toContain("first");
    } finally {
      page.close();
    }
  });

  it("draws the comparison of the revision chosen last", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      (page.document.querySelector("#diff-toggle") as HTMLInputElement).click();
      await settle();
      await settle();
      choose(page, 1);
      await settle();
      await settle();
      expect(page.document.querySelectorAll("#report-body .diff-add")).toHaveLength(0);

      const held = gated(() => ({ body: DIFF }));
      page.respond("/api/reports/r1/diff", held.answer);
      choose(page, 2);
      await settle();
      await settle();
      choose(page, 1);
      await settle();
      await settle();
      held.release();
      await settle();
      await settle();

      // v1 has nothing before it, so its comparison is empty: the late answer
      // for v2 is not drawn under it.
      expect(page.document.querySelectorAll("#report-body .diff-add")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("says a comparison that failed, and draws the chosen revision's text", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      (page.document.querySelector("#diff-toggle") as HTMLInputElement).click();
      await settle();
      await settle();
      choose(page, 1);
      await settle();
      await settle();
      // Draw a comparison first, so the failure has something to take away.
      choose(page, 2);
      await settle();
      await settle();
      expect(page.document.querySelectorAll("#report-body .diff-add")).toHaveLength(1);

      choose(page, 1);
      await settle();
      await settle();
      page.respond("/api/reports/r1/diff", () => ({ status: 500, body: { error: { code: "boom", message: "diff broke" } } }));
      choose(page, 2);
      await settle();
      await settle();

      expect(page.document.querySelectorAll("#report-body .diff-add")).toHaveLength(0);
      expect(page.document.querySelector("#report-body")?.textContent).toContain("second");
      expect(page.document.getElementById("toast")?.textContent).toContain("Could not load the comparison.");
    } finally {
      page.close();
    }
  });

  it("keeps a revision chosen while a restored page reads the report again", async () => {
    const { page, report } = await openReportPage({ url: "/report/plan" });
    try {
      const held = gated(() => ({ body: report }));
      page.respond("/api/reports/by-name/plan", held.answer);
      page.pageShow(true);
      await settle();
      choose(page, 1);
      await settle();
      await settle();
      held.release();
      await settle();
      await settle();
      await settle();

      expect((page.document.querySelector("#version-select") as HTMLSelectElement).value).toBe("1");
      expect(page.document.querySelector("#report-body")?.textContent).toContain("first");
    } finally {
      page.close();
    }
  });

  it("keeps the selector's element and its focus when another revision is chosen", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const select = page.document.querySelector("#version-select") as HTMLSelectElement;
      select.focus();
      select.value = "1";
      select.dispatchEvent(new page.window.Event("change"));
      const before = page.capture("#version-select");
      await settle();
      await settle();

      // The reader is still on the control they just used, holding the value they
      // chose; only the body under it was redrawn.
      page.expectUntouched(before);
      expect(page.document.querySelector("#report-body")?.textContent).toContain("first");
    } finally {
      page.close();
    }
  });

  it("shows a diff against the previous revision when asked", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      (page.document.querySelector("#diff-toggle") as HTMLInputElement).click();
      await settle();
      await settle();

      const body = page.document.querySelector("#report-body") as HTMLElement;
      expect(body.querySelectorAll(".diff-add")).toHaveLength(1);
      expect(body.querySelectorAll(".diff-remove")).toHaveLength(1);
      expect(body.textContent).toContain("+1 −1");
    } finally {
      page.close();
    }
  });

  it("marks the changed words of a paired line and escapes their text", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      (page.document.querySelector("#diff-toggle") as HTMLInputElement).click();
      await settle();
      await settle();

      const body = page.document.querySelector("#report-body") as HTMLElement;
      // One changed segment on each side of the pair, and the markup inside it is
      // text: a segment must not become an element.
      expect(body.querySelectorAll(".diff-word")).toHaveLength(2);
      expect(body.querySelector("b")).toBeNull();
      expect(body.querySelector(".diff-add .diff-body")?.textContent).toBe("first <b>y</b>");
      expect(body.querySelector(".diff-add .diff-mark")?.textContent).toBe("+");
    } finally {
      page.close();
    }
  });

  it("keeps the head and the notes when the comparison comes and goes", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const toggle = page.document.querySelector("#diff-toggle") as HTMLInputElement;
      toggle.focus();
      const headBefore = page.capture(".report-head");
      const notesBefore = page.capture("#report-notes");

      toggle.click();
      await settle();
      await settle();
      expect(page.document.querySelectorAll(".diff-line").length).toBeGreaterThan(0);
      page.expectUntouched(headBefore);
      page.expectUntouched(notesBefore);

      toggle.click();
      await settle();
      await settle();
      expect(page.document.querySelector("#report-body h1")?.textContent).toBe("Plan");
      page.expectUntouched(headBefore);
      page.expectUntouched(notesBefore);
    } finally {
      page.close();
    }
  });

  it("keeps the prose's selection when the same revision is read again", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const body = page.document.querySelector("#report-body") as HTMLElement;
      const paragraph = body.querySelector("p") as HTMLElement;
      const range = page.document.createRange();
      range.selectNodeContents(paragraph);
      const selection = page.window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      const selected = selection.toString();
      const bodyBefore = page.capture("#report-body");

      // A page restored from the back/forward cache reads the report again; the
      // revision is the one the reader was on, so the text is the same text.
      page.pageShow(true);
      await settle();
      await settle();
      await settle();

      expect(reportReads(page)).toBe(2);
      page.expectUntouched(bodyBefore);
      // The paragraph the selection lives in is the node it was: the body was not
      // written again, so the selection was never taken apart.
      expect(page.document.querySelector("#report-body p")).toBe(paragraph);
      expect(page.window.getSelection()?.toString()).toBe(selected);
    } finally {
      page.close();
    }
  });

  it("keeps the note out of the option text and next to the control", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const select = page.document.querySelector("#version-select") as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(["2", "1"]);
      expect([...select.options].map((option) => option.textContent)).toEqual(["v2", "v1"]);
      expect(page.document.querySelector("span.report-tool.report-dim")?.textContent).toBe("tweak");
      expect(page.document.querySelector("label.report-tool > .report-tool-name")?.textContent).toBe("revision");
    } finally {
      page.close();
    }
  });
});

/* ---------------------------------------------------------------- shell */

describe("report page shell", () => {
  it("puts the viewer in a scrolling row under a fixed-height shell", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      const doc = page.document;
      expect(doc.body.classList.contains("report-page")).toBe(true);
      const scroll = doc.getElementById("view")?.parentElement as HTMLElement;
      expect(scroll.className).toBe("report-scroll");
      // The bar is the shell's last row, not a passenger of the scrolling one.
      const bar = doc.getElementById("note-bar") as HTMLElement;
      expect(scroll.contains(bar)).toBe(false);
      expect(bar.parentElement).toBe(doc.body);

      // Those two rows are a height only because of these rules, so a missing block
      // is a page that scrolls the document again.
      const css = (await readFile(join(root, "src/web/styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(cssRule(css, "body.report-page")).toContain("overflow: hidden");
      expect(cssRule(css, ".report-scroll")).toContain("overflow-y: auto");
      expect(cssRule(css, ".report-scroll")).toContain("min-height: 0");
      expect(cssRule(css, "body.report-page #note-bar")).toContain("position: static");
    } finally {
      page.close();
    }
  });

  it("keeps the diff mark column a character wide on a blank line", async () => {
    const css = (await readFile(join(root, "src/web/styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    // A blank line's mark cell holds one space, and jsdom does no layout, so the
    // 0px row a collapsed space produces does not show up here. These rules are
    // what the test can hold: the mark keeps its character, the body still folds,
    // and the row is still the two-column grid that splits them.
    expect(cssRule(css, ".diff-mark")).toContain("white-space: pre");
    expect(cssRule(css, ".diff-body")).toContain("white-space: pre-wrap");
    expect(cssRule(css, ".diff-line")).toContain("display: grid");
  });

  it("lets the revision label and its control shrink", async () => {
    const css = (await readFile(join(root, "src/web/styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssRule(css, ".report-tool")).toContain("min-width: 0");
    expect(cssRule(css, ".report-tool-name")).toContain("white-space: nowrap");
    const control = cssRule(css, ".report-tools select");
    expect(control).toContain("min-width: 0");
    expect(control).toContain("max-width: 100%");
  });

  it("stacks the feedback bar with a 44px button on a narrow screen", async () => {
    const css = (await readFile(join(root, "src/web/styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: { maxWidth: number; body: string }[] = [];
    for (const match of css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      let close = open;
      for (let index = open; index < css.length; index += 1) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            close = index;
            break;
          }
        }
      }
      blocks.push({ maxWidth: Number(match[1]), body: css.slice(open, close) });
    }

    // A 390px phone has to fall under the rule, and the bar has to be the thing it
    // stacks. The button keeps a 44px tap target rather than being clipped.
    const narrow = blocks.find((block) => block.maxWidth >= 390 && block.body.includes(".note-bar .report-feedback-form"));
    expect(narrow).toBeDefined();
    expect(narrow?.body).toContain("flex-direction: column");
    expect(narrow?.body).toContain("min-height: 44px");
  });

  it("lets the layout viewport follow the keyboard", async () => {
    const html = await readFile(join(root, "src/web/report.html"), "utf8");
    const meta = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(meta).toContain("width=device-width");
    expect(meta).toContain("interactive-widget=resizes-content");
  });

  it("offers the way back to the list only while one report is open", async () => {
    const list = await openReportPage();
    try {
      expect(list.page.document.getElementById("list-link")?.classList.contains("hidden")).toBe(true);
    } finally {
      list.page.close();
    }

    const viewer = await openReportPage({ url: "/report/plan" });
    try {
      const link = viewer.page.document.getElementById("list-link") as HTMLElement;
      expect(link.classList.contains("hidden")).toBe(false);
      expect(link.getAttribute("href")).toBe("/report");
      // Going back to the list is not a new-tab move; it is this page again.
      expect(link.getAttribute("target")).toBeNull();
    } finally {
      viewer.page.close();
    }
  });

  it("keeps the note box in a bar at the foot of the page, not in the document", async () => {
    const viewer = await openReportPage({ url: "/report/plan" });
    try {
      const bar = viewer.page.document.getElementById("note-bar") as HTMLElement;
      expect(bar.classList.contains("hidden")).toBe(false);
      expect(bar.contains(viewer.page.document.getElementById("feedback-form"))).toBe(true);
      // ...and out of the scrollable view, so it stays on screen wherever the reader is.
      expect(viewer.page.document.getElementById("view")?.contains(viewer.page.document.getElementById("feedback-form"))).toBe(
        false,
      );
    } finally {
      viewer.page.close();
    }

    const list = await openReportPage();
    try {
      expect(list.page.document.getElementById("note-bar")?.classList.contains("hidden")).toBe(true);
    } finally {
      list.page.close();
    }
  });

  it("takes over the header's theme button and the notice", async () => {
    const { page } = await openReportPage();
    try {
      const toggle = page.document.getElementById("theme-toggle") as HTMLButtonElement;
      expect(toggle.textContent).toBe("◐ auto");
      toggle.dispatchEvent(new page.window.Event("click"));
      await settle();
      expect(page.document.getElementById("theme-toggle")?.textContent).toBe("◐ light");
      expect(page.document.getElementById("toast")?.getAttribute("role")).toBe("alert");
    } finally {
      page.close();
    }
  });

  it("says a report could not be read instead of loading for ever", async () => {
    const { page } = await openReportPage({
      url: "/report/missing",
      extra: { "/api/reports/by-name/missing": { status: 404, body: { error: { code: "not_found", message: "report not found" } } } },
    });
    try {
      expect(page.document.getElementById("view")?.textContent).toContain("Could not load this report.");
      expect(page.document.getElementById("toast")?.textContent).toContain("report not found");
    } finally {
      page.close();
    }
  });
});

/* ---------------------------------------------------------------- mount */

describe("report page mount", () => {
  it("uses the prefix the server stamped", async () => {
    const { page } = await openReportPage({ base: "/sec" });
    try {
      expect(page.fetchCalls.length).toBeGreaterThan(0);
      expect(page.fetchCalls.every((call) => call.path.startsWith("/sec/"))).toBe(true);
      expect(page.document.getElementById("view")?.innerHTML).toContain('href="/sec/report/plan"');
      expect(page.document.getElementById("list-link")?.getAttribute("href")).toBe("/sec/report");
    } finally {
      page.close();
    }
  });

  it("reads the mount off its own path when the stamp is missing", async () => {
    // A cached or mirrored page has no stamp; its path still names the page, so the
    // prefix in front of that name is what it is mounted under.
    const report = makeReport();
    const page = await loadUiPage("report", {
      url: "/sec/report/plan",
      fetch: { "/sec/api/reports/by-name/plan": { body: report }, "/sec/api/reports/r1/versions/2": { text: BODIES["2"]! } },
    });
    try {
      await settle();
      await settle();
      expect(page.fetchCalls.length).toBeGreaterThan(0);
      expect(page.fetchCalls.every((call) => call.path.startsWith("/sec/"))).toBe(true);
      expect(page.document.querySelector("h1.report-h1")?.textContent).toBe("Plan");
    } finally {
      page.close();
    }
  });

  it("says so instead of fetching when no mount can be determined", async () => {
    const page = await loadUiPage("report", { url: "/elsewhere" });
    try {
      await settle();
      expect(page.fetchCalls).toHaveLength(0);
      expect(page.document.getElementById("view")?.textContent).toContain("Mount point unknown");
    } finally {
      page.close();
    }
  });
});

/* ---------------------------------------------------------------- markup */

/**
 * The elements under one node, as `tag#id.class` lines in order.
 *
 * The expectations below are the tree the hand-written report page drew (removed
 * in this commit), printed from the page it serves today (list at `/report`, one report at `/report/plan`, the bar
 * and the header both times). The rewrite keeps the markup, so a class the
 * stylesheet names cannot go missing without a test saying which line moved.
 */
function structure(element: Element | null): string[] {
  if (element === null) return [];
  const lines: string[] = [];
  const walk = (node: Element, depth: number): void => {
    for (const child of node.children) {
      const id = child.id === "" ? "" : `#${child.id}`;
      const classes = child.classList.length === 0 ? "" : `.${[...child.classList].join(".")}`;
      lines.push(`${"  ".repeat(depth)}${child.tagName.toLowerCase()}${id}${classes}`);
      walk(child, depth + 1);
    }
  };
  walk(element, 0);
  return lines;
}

const LIST_VIEW = [
  "h1.report-h1",
  "div.report-list",
  "  a.report-row",
  "    div.report-row-head",
  "      span.status-chip.status-active",
  "      span.report-row-title",
  "      span.report-row-name",
  "    div.report-row-meta",
  "      span",
  "      span",
  "      span",
  "      span",
  "h2.report-h2",
  "p.report-hint",
  "div.report-list",
  "  a.report-row",
  "    div.report-row-head",
  "      span.status-chip.status-done",
  "      span.report-row-title",
  "      span.report-row-name",
  "    div.report-row-meta",
  "      span",
  "      span",
  "      span",
  "      span",
  "details.report-archive",
  "  summary",
  "  p.report-hint",
  "  div.report-list",
  "    a.report-row",
  "      div.report-row-head",
  "        span.status-chip.status-cancelled",
  "        span.report-row-title",
  "        span.report-row-name",
  "      div.report-row-meta",
  "        span",
  "        span",
  "        span",
  "        span",
];

const VIEWER_VIEW = [
  "div.report-head",
  "  h1.report-h1",
  "  div.report-row-meta",
  "    span.status-chip.status-active",
  "    span",
  "      code",
  "  div.report-tools",
  "    label.report-tool",
  "      span.report-tool-name",
  "      select#version-select",
  "        option",
  "        option",
  "    label.report-tool",
  "      input#diff-toggle",
  "    span.report-tool.report-dim",
  "article#report-body.report-body",
  "  h1",
  "  p",
  "section.report-feedback",
  "  h2.report-h2",
  "  div#report-notes",
  "    div.report-note",
  "      div.report-note-meta",
  "      div.report-note-body",
];

const NOTE_BAR = [
  "form#feedback-form.report-feedback-form",
  "  textarea#feedback-body",
  "  button#feedback-submit.button.button-approve",
  "p#feedback-hint.feedback-hint",
];

const HEADER = [
  "button#reload-list.button",
  "a#list-link.pill.pill-muted.hidden",
  "a#chat-link.pill.pill-muted",
  "button#theme-toggle.button",
];

describe("the page's markup", () => {
  it("draws the list, the bar and the header the old page drew", async () => {
    const { page } = await openReportPage();
    try {
      expect(structure(page.document.getElementById("view"))).toEqual(LIST_VIEW);
      expect(structure(page.document.getElementById("note-bar"))).toEqual(NOTE_BAR);
      expect(structure(page.document.querySelector(".header-status"))).toEqual(HEADER);
    } finally {
      page.close();
    }
  });

  it("draws one report, the bar and the header the old page drew", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      expect(structure(page.document.getElementById("view"))).toEqual(VIEWER_VIEW);
      expect(structure(page.document.getElementById("note-bar"))).toEqual(NOTE_BAR);
      expect(structure(page.document.querySelector(".header-status"))).toEqual([
        "button#reload-list.button.hidden",
        "a#list-link.pill.pill-muted",
        "a#chat-link.pill.pill-muted",
        "button#theme-toggle.button",
      ]);
    } finally {
      page.close();
    }
  });
});

/* -------------------------------------------------------------- results */

describe("the Results section", () => {
  it("puts the result reports in their own section, directly above Pending", async () => {
    const report = makeReport();
    const { page } = await openReportPage({
      list: {
        reports: [
          { ...report, id: "r1", name: "plan", title: "Plan", status: "active", kind: undefined },
          { ...report, id: "r2", name: "log", title: "Run log", status: "result", kind: "result" },
          { ...report, id: "r3", name: "later", title: "Later", status: "pending", pendingAt: 4_000 },
          { ...report, id: "r4", name: "old", title: "Old", status: "inactive", active: false },
        ],
        archived: [],
      },
    });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      // The order of the headings is the whole point: Active is the h1, then
      // Results, then Pending, then Finished.
      expect([...view.querySelectorAll(".report-h2")].map((heading) => heading.textContent)).toEqual([
        "Results",
        "Pending",
        "Finished",
      ]);
      // The fixed sentence, word for word.
      expect(view.textContent).toContain(
        "Work that ran. Press Done to close it, or write Feedback for more in the report.",
      );
      // And the report is in that section, with its own chip.
      const results = [...view.querySelectorAll(".report-h2")][0]!;
      const rows = results.nextElementSibling?.nextElementSibling?.querySelectorAll(".report-row") ?? [];
      expect([...rows].map((row) => row.querySelector(".report-row-title")?.textContent)).toEqual(["Run log"]);
      expect(rows[0]?.querySelector(".status-chip")?.textContent).toBe("result");
      expect(rows[0]?.querySelector(".status-chip")?.classList.contains("status-result")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("draws no Results heading when there is no result report", async () => {
    const { page } = await openReportPage();
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).not.toContain("Results");
    } finally {
      page.close();
    }
  });
});

describe("the two buttons of a result report", () => {
  /** The viewer, pointed at a result report. */
  async function openResult(options: { done?: { status?: number; body?: unknown } } = {}): Promise<OpenPage> {
    const report = { ...makeReport(), name: "log", title: "Run log", kind: "result", status: "result" };
    const bodies = BODIES;
    const done = options.done;
    const fetch: Record<string, FetchAnswer> = {
      "/api/reports": () => ({ body: { reports: [report], archived: [] } }),
      "/api/reports/by-name/log": () => ({ body: report }),
      "/api/reports/r1/diff": () => ({ body: DIFF }),
      "/api/reports/r1/approve": () => ({ status: 201, body: { at: 5_000, via: "viewer", sha256: "b" } }),
      "/api/reports/r1/done": () => {
        const status = done?.status ?? 201;
        if (status < 400) report.versions[1]!.approval = { at: 5_000, via: "viewer", sha256: "b", button: "done" };
        return { status, body: done?.body ?? { id: "r1", version: 2, approval: { at: 5_000, via: "viewer", sha256: "b", button: "done" } } };
      },
      "/api/reports/r1/feedback": () => ({ status: 201, body: {} }),
      "/api/reports/r1/versions/1": () => ({ text: bodies["1"] ?? "" }),
      "/api/reports/r1/versions/2": () => ({ text: bodies["2"] ?? "" }),
    };
    const page = await loadUiPage("report", { url: "/report/log", fetch });
    await settle();
    await settle();
    return { page, report };
  }

  function posts(page: UiPageHandle): { path: string; body: unknown }[] {
    return page.fetchCalls
      .filter((call) => call.method === "POST")
      .map((call) => ({ path: call.path, body: call.body === null ? null : JSON.parse(call.body) }));
  }

  it("shows Done and Feedback from the start, and the sentence that explains them", async () => {
    const { page } = await openResult();
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.querySelector(".status-chip")?.textContent).toBe("result");
      const done = page.document.getElementById("feedback-done") as HTMLButtonElement;
      const feedback = page.document.getElementById("feedback-submit") as HTMLButtonElement;
      expect(done.textContent).toBe("Done");
      expect(feedback.textContent).toBe("Feedback");
      // With no text in the field, Feedback has nothing to send and Done is the
      // one press the bar offers.
      expect(done.disabled).toBe(false);
      expect(feedback.disabled).toBe(true);
      expect(page.document.getElementById("feedback-hint")?.textContent).toBe(
        "Done closes this result. Text with Done asks for follow-up work. Feedback asks for more in this report.",
      );
    } finally {
      page.close();
    }
  });

  it("sends one Done with an empty field, and Feedback once the field has text", async () => {
    const { page } = await openResult();
    try {
      const field = page.document.getElementById("feedback-body") as HTMLTextAreaElement;
      const done = page.document.getElementById("feedback-done") as HTMLButtonElement;
      const feedback = page.document.getElementById("feedback-submit") as HTMLButtonElement;

      // Empty: one Done, with no text key at all.
      done.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await settle();
      await settle();
      expect(posts(page)).toEqual([{ path: "/api/reports/r1/done", body: { version: 2, via: "viewer" } }]);
      // The server took the press, so the line under the bar says what it was.
      expect(page.document.getElementById("feedback-hint")?.textContent).toContain("Done v2");
      expect(done.disabled).toBe(true);

      // With text: the same route, and the user's words with it.
      field.value = "run the check again";
      field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await settle();
      expect(feedback.disabled).toBe(false);
      feedback.dispatchEvent(new page.window.Event("click", { bubbles: true }));
      await settle();
      await settle();
      expect(posts(page).at(-1)).toEqual({
        path: "/api/reports/r1/feedback",
        body: { body: "run the check again", version: 2 },
      });
    } finally {
      page.close();
    }
  });

  it("sends the text with Done when the field has some", async () => {
    const { page } = await openResult();
    try {
      const field = page.document.getElementById("feedback-body") as HTMLTextAreaElement;
      field.value = "run it once more";
      field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await settle();

      (page.document.getElementById("feedback-done") as HTMLButtonElement).dispatchEvent(
        new page.window.Event("click", { bubbles: true }),
      );
      await settle();
      await settle();
      // The same route as an empty Done, with the user's words in it: text with
      // Done is a request for follow-up work, not feedback.
      expect(posts(page)).toEqual([
        { path: "/api/reports/r1/done", body: { version: 2, via: "viewer", text: "run it once more" } },
      ]);
      // The server took it, so the field is empty again.
      expect(field.value).toBe("");
    } finally {
      page.close();
    }
  });

  it("keeps the reader's text when the server refuses the Done", async () => {
    const { page } = await openResult({
      done: { status: 409, body: { error: { code: "not_active", message: "the job finished" } } },
    });
    try {
      const field = page.document.getElementById("feedback-body") as HTMLTextAreaElement;
      field.value = "run it once more";
      field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await settle();

      (page.document.getElementById("feedback-done") as HTMLButtonElement).dispatchEvent(
        new page.window.Event("click", { bubbles: true }),
      );
      await settle();
      await settle();
      // A refusal leaves the reader's words where they are, so the press can be
      // taken again once the reason is gone.
      expect(field.value).toBe("run it once more");
      expect(page.document.getElementById("feedback-hint")?.textContent).toContain("finished");
    } finally {
      page.close();
    }
  });

  it("leaves a plan's bar with its one button", async () => {
    const { page } = await openReportPage({ url: "/report/plan" });
    try {
      expect(page.document.getElementById("feedback-done")).toBeNull();
      expect((page.document.getElementById("feedback-submit") as HTMLButtonElement).textContent).toBe("Approve");
      expect(page.document.getElementById("feedback-hint")?.textContent).toBe("");
    } finally {
      page.close();
    }
  });
});

/* ------------------------------------------------------------ briefings */

describe("a briefing report", () => {
  it("puts the briefing in its own section at the top of the list", async () => {
    const report = makeReport();
    const { page } = await openReportPage({
      list: {
        reports: [
          { ...report, id: "r1", name: "plan", title: "Plan", status: "active", kind: undefined },
          { ...report, id: "r5", name: "briefing", title: "Morning briefing", status: "briefing", kind: "briefing" },
        ],
        archived: [],
      },
    });
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      // The briefing comes before the plan, under its own heading.
      expect([...view.querySelectorAll(".report-h2")].map((heading) => heading.textContent)).toEqual(["Briefing"]);
      const briefingHeading = view.querySelector(".report-h2")!;
      expect([...view.querySelectorAll(".report-row-title")].map((row) => row.textContent)).toEqual([
        "Morning briefing",
        "Plan",
      ]);
      expect(briefingHeading.nextElementSibling?.nextElementSibling?.querySelector(".report-row-title")?.textContent).toBe(
        "Morning briefing",
      );
      // Its chip says `briefing`, in a colour of its own.
      const chip = view.querySelector(".report-row .status-chip")!;
      expect(chip.textContent).toBe("briefing");
      expect(chip.classList.contains("status-briefing")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("draws no Briefing heading when there is no briefing", async () => {
    const { page } = await openReportPage();
    try {
      const view = page.document.getElementById("view") as HTMLElement;
      expect(view.textContent).not.toContain("Briefing");
    } finally {
      page.close();
    }
  });

  it("leaves an archived briefing out of the Archive section", async () => {
    const report = makeReport();
    const { page } = await openReportPage({
      list: {
        reports: [{ ...report, id: "r1", name: "plan", title: "Plan" }],
        archived: [
          { ...report, id: "r5", name: "old-briefing", title: "Old briefing", status: "archived", kind: "briefing" },
          { ...report, id: "r3", name: "gone", title: "Gone", status: "archived" },
        ],
      },
    });
    try {
      const text = page.document.getElementById("view")?.textContent ?? "";
      // One archived report keeps its place; the briefing that a newer one
      // replaced does not appear at all.
      expect(text).toContain("Archive (1)");
      expect(text).toContain("Gone");
      expect(text).not.toContain("Old briefing");
    } finally {
      page.close();
    }
  });

  it("gives the viewer Feedback alone, with the sentence that says why", async () => {
    const report = { ...makeReport(), name: "briefing", title: "Morning briefing", kind: "briefing", status: "briefing" };
    const fetch: Record<string, FetchAnswer> = {
      "/api/reports": () => ({ body: { reports: [report], archived: [] } }),
      "/api/reports/by-name/briefing": () => ({ body: report }),
      "/api/reports/r1/versions/1": () => ({ text: BODIES["1"] ?? "" }),
      "/api/reports/r1/versions/2": () => ({ text: BODIES["2"] ?? "" }),
      "/api/reports/r1/diff": () => ({ body: DIFF }),
      "/api/reports/r1/feedback": () => ({ status: 201, body: {} }),
    };
    const page = await loadUiPage("report", { url: "/report/briefing", fetch });
    try {
      await settle();
      await settle();
      expect(page.document.getElementById("view")?.querySelector(".status-chip")?.textContent).toBe("briefing");
      // There is no Done, and the one button is Feedback rather than Approve.
      expect(page.document.getElementById("feedback-done")).toBeNull();
      const button = page.document.getElementById("feedback-submit") as HTMLButtonElement;
      expect(button.textContent).toBe("Feedback");
      // An empty field has nothing to send, so the button is off.
      expect(button.disabled).toBe(true);
      expect(page.document.getElementById("feedback-hint")?.textContent).toBe(
        "A briefing needs no approval. Feedback goes to the root.",
      );

      // Text in the field is what the button sends, and it goes to the feedback route.
      const field = page.document.getElementById("feedback-body") as HTMLTextAreaElement;
      field.value = "the second block is missing";
      field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await settle();
      expect(button.disabled).toBe(false);
      // The one button is the bar's submit button, so the press is a submit of
      // the form the bar holds.
      page.document
        .getElementById("feedback-form")
        ?.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      await settle();
      expect(
        page.fetchCalls
          .filter((call) => call.method === "POST")
          .map((call) => ({ path: call.path, body: JSON.parse(call.body ?? "null") })),
      ).toEqual([
        { path: "/api/reports/r1/feedback", body: { body: "the second block is missing", version: 2 } },
      ]);
    } finally {
      page.close();
    }
  });

  it("gives the chip a colour of its own", async () => {
    const css = await readFile(join(root, "src/web/styles.css"), "utf8");
    // The rule names a colour variable no other report standing uses.
    expect(cssRule(css, ".status-briefing")).toMatch(/var\(--status-/);
    expect(cssRule(css, ".status-briefing")).not.toBe(cssRule(css, ".status-active"));
    expect(cssRule(css, ".status-briefing")).not.toBe(cssRule(css, ".status-result"));
  });
});
