// @vitest-environment jsdom
/**
 * The job tree in the sidebar.
 *
 * These are the assertions `test/web-ui.test.ts` made on `renderJobs` (the
 * cleared job and its subtree, the chip that folds a group, the opened title
 * block, the routine and one-off marks, the harness clock, the old schedule
 * list's banner, the ten-cell revert memory) moved onto the new components, plus
 * the one-second coalescer that `test/page-job-stream.test.ts` pins, plus the
 * reset test: a job event that reads the tree back must leave the pressed
 * chip's focus, the opened row and the list's scroll where the operator left
 * them.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { resetJobsState } from "../../src/ui/state/jobs.ts";
import { fakePreferences, type FakePreferences } from "./preferences-fake.ts";
import { resetInboxState } from "../../src/ui/state/inbox.ts";
import { resetQueriesState } from "../../src/ui/state/queries.ts";
import { resetNotesState } from "../../src/ui/state/notes.ts";

/* ------------------------------------------------------------ the page */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type Answer = { readonly status?: number; readonly body?: unknown } | Promise<{ readonly status?: number; readonly body?: unknown }>;
type Route = (call: Call) => Answer;

const routes = new Map<string, Route>();
let calls: Call[] = [];

/** Put the chat page's shell into this test's document, minus its scripts. */
async function installShell(): Promise<void> {
  const html = await readFile(join(process.cwd(), "src/web/index.html"), "utf8");
  const stripped = html.replaceAll("{{base}}", "").replace(/<script\b[^>]*>\s*<\/script>/gi, "");
  const parsed = new DOMParser().parseFromString(stripped, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  for (const attribute of parsed.body.attributes) document.body.setAttribute(attribute.name, attribute.value);
  document.head.innerHTML = parsed.head.innerHTML;
}

/** One response object of the shape the page's `request` function reads. */
function response(status: number, body: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
  } as Response;
}

/** Answer one route. The key is the path with its query, or the path alone. */
function answer(path: string, route: Route): void {
  routes.set(path, route);
}

/** The server's shared state for this test: it answers reads and keeps what a press saves. */
let server: FakePreferences = fakePreferences();

/** The answer to the job tree or the preferences read, unless a test says otherwise. */
function defaults(): void {
  server = fakePreferences();
  answer("/api/jobs", () => ({ body: { tree: [] } }));
  answer("/api/preferences", (call) => server.handle(call));
  answer("/api/inbox", () => ({ body: { items: [] } }));
  answer("/api/user-queries", () => ({ body: { queries: [] } }));
  answer("/api/admin/status", () => ({ body: {} }));
}

/** One node in the shape `GET /api/jobs?shape=tree` answers with. */
function node(id: string, title: string, extra: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    job: { id, title, status: "active", labels: [], stats: { runs: 1, failures: 0 }, working: [], ...extra },
    children,
  };
}

/** The job tree the next read answers with. */
function setTree(tree: unknown[], problem: string | null = null): void {
  answer("/api/jobs?shape=tree", () => ({ body: { tree, legacyScheduleProblem: problem } }));
}

/**
 * Remember one element and the state a redraw could take from it.
 *
 * `test/ui/harness.ts` has the same pair for the page harness, but importing it
 * pulls the bundle build (and esbuild) into this jsdom environment, where
 * esbuild's own invariant check fails. These three helpers are the part of it
 * this file needs.
 */
interface Captured {
  readonly element: Element;
  readonly selector: string;
  readonly value: string | undefined;
  readonly start: number | null;
  readonly end: number | null;
  readonly focused: boolean;
  readonly scrollTop: number;
}

function captureElement(doc: Document, selector: string): Captured {
  const element = doc.querySelector(selector);
  if (element === null) throw new Error(`the page has no element matching ${selector}`);
  const field = element as HTMLInputElement;
  return {
    element,
    selector,
    value: "value" in element ? String(field.value) : undefined,
    start: typeof field.selectionStart === "number" ? field.selectionStart : null,
    end: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
    focused: doc.activeElement === element,
    scrollTop: (element as HTMLElement).scrollTop ?? 0,
  };
}

function expectUntouched(before: Captured): void {
  const now = before.element.ownerDocument.querySelector(before.selector);
  expect(now, "the element was replaced").toBe(before.element);
  if (before.value !== undefined) expect.soft((now as HTMLInputElement).value).toBe(before.value);
  if (before.start !== null) {
    expect.soft((now as HTMLInputElement).selectionStart).toBe(before.start);
    expect.soft((now as HTMLInputElement).selectionEnd).toBe(before.end);
  }
  if (before.focused) expect.soft(before.element.ownerDocument.activeElement).toBe(before.element);
  expect.soft((now as HTMLElement).scrollTop).toBe(before.scrollTop);
}

const jobsPanel = () => document.querySelector<HTMLElement>("#jobs")!;
const requests = (needle: string, method = "PATCH") => calls.filter((call) => call.url.includes(needle) && call.method === method);
const lastBody = (needle: string) => {
  const sent = requests(needle).at(-1);
  return sent === undefined || sent.body === null ? undefined : JSON.parse(sent.body);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  routes.clear();
  calls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const call: Call = {
      url: parsed.pathname + parsed.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ?? null,
    };
    calls.push(call);
    const route = routes.get(call.url) ?? routes.get(parsed.pathname);
    const answered = route === undefined ? { status: 200, body: {} } : await route(call);
    return response(answered.status ?? 200, answered.body);
  };
  await installShell();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  defaults();
  resetJobsState();
  resetInboxState();
  resetQueriesState();
  resetNotesState();
  mountSideParts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the job tree", () => {
  it("draws the tree the first read answered with", async () => {
    setTree([node("job-1", "parent", {}, [node("job-2", "child", { status: "done" })])]);
    await startSidePanels();
    await settle();

    const rows = [...jobsPanel().querySelectorAll<HTMLElement>(".job-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dataset.jobId).toBe("job-1");
    expect(rows[0]!.dataset.depth).toBe("0");
    expect(rows[0]!.getAttribute("title")).toBe("parent");
    expect(rows[1]!.dataset.depth).toBe("1");
    // The indent is an attribute the stylesheet reads; the CSP blocks a style.
    expect(jobsPanel().innerHTML).not.toContain("style=");
    // The status word is the chip's text, so status is never colour alone; the
    // row has children, so the same chip is the control that folds them.
    expect(rows[0]!.querySelector(".status-chip")!.textContent).toBe("▾ active");
    expect(rows[0]!.querySelector(".status-chip")!.className).toBe("status-chip status-active");
    // The reports link is the ▤ the panel has always carried, under the mount.
    const link = rows[0]!.querySelector<HTMLAnchorElement>(".job-reports")!;
    expect(link.getAttribute("href")).toBe("/report?job=job-1");
    expect(link.getAttribute("title")).toBe("Reports for this job");
    expect(link.textContent).toBe("▤");
    expect(rows[0]!.querySelector(".job-counts")!.textContent).toBe("1/0");
    // The revert button is drawn at the foot even with nothing to undo.
    const restore = jobsPanel().querySelector<HTMLButtonElement>("#jobs-restore")!;
    expect(restore.textContent).toBe("↩ revert (0)");
    expect(restore.disabled).toBe(true);
  });

  it("says there are no jobs, and says nothing else", async () => {
    setTree([]);
    await startSidePanels();
    await settle();

    expect(jobsPanel().querySelector(".inbox-body")!.textContent).toBe("No jobs yet.");
    expect(jobsPanel().querySelector("#jobs-restore")).toBeNull();
  });

  it("clears a closed job from its chip, with its subtree, and saves both lists", async () => {
    setTree([node("job-1", "parent", { status: "done" }, [node("job-2", "child", { status: "done" })])]);
    await startSidePanels();
    await settle();
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(2);

    jobsPanel().querySelector<HTMLElement>("[data-hide-job]")!.click();
    await settle();

    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(0);
    expect(jobsPanel().querySelector<HTMLElement>("#jobs-restore")!.textContent).toBe("↩ revert (1)");
    expect(lastBody("/api/preferences")).toEqual({ hiddenJobs: ["job-1"], revertQueueJobs: ["job-1"], baseRevision: 0 });
  });

  it("leaves a live job's chip inert, and folds its children from the chip", async () => {
    setTree([node("job-1", "group", {}, [node("job-2", "child")])]);
    await startSidePanels();
    await settle();
    const chip = () => jobsPanel().querySelector<HTMLElement>(".status-chip")!;

    // A live job cannot be cleared: hiding work in progress is not tidying. It
    // folds its children instead, which is the one control the row has.
    expect(chip().tagName).toBe("BUTTON");
    expect(chip().dataset.hideJob).toBeUndefined();
    expect(chip().dataset.toggleChildren).toBe("job-1");
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(chip().textContent).toBe("▾ active");

    chip().click();
    await settle();
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(1);
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(chip().textContent).toBe("▸ active");
    // A fold is shared state: it is saved, so every page folds the same group.
    await settle();
    expect(lastBody("/api/preferences")).toEqual({ collapsedJobs: ["job-1"], baseRevision: 0 });

    // The fold stays a fold: a second press opens it again.
    chip().click();
    await settle();
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(2);
  });

  it("opens a title under its row and saves the opened list", async () => {
    const long = "a long job title that the sidebar would truncate at the end";
    setTree([node("job-1", long)]);
    await startSidePanels();
    await settle();

    jobsPanel().querySelector<HTMLElement>(".job-title")!.click();
    await settle();

    const row = jobsPanel().querySelector<HTMLElement>('[data-job-id="job-1"]')!;
    const button = row.querySelector<HTMLElement>(".job-title")!;
    // The row keeps no title text of its own; the title is a block beneath it.
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe(long);
    const block = row.nextElementSibling as HTMLElement;
    expect(block.tagName).toBe("BUTTON");
    expect(block.className).toBe("job-open");
    expect(block.parentElement).toBe(jobsPanel());
    expect(block.getAttribute("data-open-job-id")).toBe("job-1");
    expect(block.querySelector(".job-open-title")!.textContent).toBe(long);
    expect(lastBody("/api/preferences")).toEqual({ expandedJobs: ["job-1"], baseRevision: 0 });

    // Pressing the block folds it again, the same way the caret does.
    block.click();
    await settle();
    expect(jobsPanel().querySelector(".job-open")).toBeNull();
    expect(lastBody("/api/preferences")).toEqual({ expandedJobs: [], baseRevision: 1 });
  });

  it("marks a routine job routine and a one-off once, by field and not by label", async () => {
    setTree([
      node("job-1", "daily digest", { routine: { cron: "0 9 * * *", prompt: "digest" } }),
      node("job-2", "one call", { status: "waiting", once: { at: Date.parse("2026-10-18T14:00:00+09:00"), prompt: "call" } }),
      node("job-3", "old label", { labels: ["schedule:daily"] }),
    ]);
    await startSidePanels();
    await settle();

    const badges = [...jobsPanel().querySelectorAll<HTMLElement>("[data-job-badge]")];
    expect(badges.map((badge) => badge.dataset.jobBadge)).toEqual(["routine", "once"]);
    expect(badges.map((badge) => badge.textContent)).toEqual(["routine", "once"]);
    expect(jobsPanel().querySelector('[data-job-id="job-3"] [data-job-badge]')).toBeNull();
  });

  it("shows a one-off run's time in the harness zone and where it stands", async () => {
    document.querySelector('meta[name="pi-sec-timezone"]')!.setAttribute("content", "Asia/Tokyo");
    const at = Date.parse("2026-10-18T14:00:00+09:00");
    setTree([
      node("job-1", "pending run", { once: { at, prompt: "run" } }),
      node("job-2", "missed run", { once: { at, prompt: "run", state: "missed" } }),
      node("job-3", "fired run", {
        once: { at, prompt: "run", state: "done" },
        lastRun: { at, status: "failure", summary: "no answer" },
      }),
    ]);
    await startSidePanels();
    await settle();

    const pending = jobsPanel().querySelector<HTMLElement>('[data-job-id="job-1"] .job-once')!;
    expect(pending.textContent).toBe("10.18\u00a014:00 pending");
    expect(pending.dataset.onceState).toBe("pending");
    expect(pending.getAttribute("title")).toContain("2026-10-18 14:00 Asia/Tokyo");
    expect(jobsPanel().querySelector<HTMLElement>('[data-job-id="job-2"] .job-once')!.dataset.onceState).toBe("missed");
    // One row holds one notice: a fired one-off keeps its own line, and what the
    // run did moves into the tooltip.
    const fired = jobsPanel().querySelector<HTMLElement>('[data-job-id="job-3"] .job-once')!;
    expect(fired.textContent).toBe("10.18\u00a014:00 done");
    expect(fired.getAttribute("title")).toContain("lastRun: failed 10.18\u00a014:00");
    expect(jobsPanel().querySelector('[data-job-id="job-3"] .job-last-run')).toBeNull();
  });

  it("shows the last run's result beside the counts, and falls back to UTC", async () => {
    // A page with no zone stamp came from a static copy: the stamps then say UTC.
    setTree([
      node("job-1", "broken brief", {
        lastRun: { at: Date.parse("2026-10-17T09:30:00+09:00"), status: "failure", summary: "tool timed out" },
      }),
      node("job-2", "never ran"),
    ]);
    await startSidePanels();
    await settle();

    const lastRun = jobsPanel().querySelector<HTMLElement>('[data-job-id="job-1"] .job-last-run')!;
    expect(lastRun.dataset.lastRunStatus).toBe("failure");
    expect(lastRun.textContent).toBe("failed 10.17\u00a000:30");
    expect(lastRun.getAttribute("title")).toBe("failure · tool timed out · 2026-10-17 00:30 UTC");
    expect(jobsPanel().querySelector('[data-job-id="job-2"] .job-last-run')).toBeNull();
  });

  it("shows a working agent by filling the one chip, and keeps the names in the tooltip", async () => {
    setTree([
      node("job-1", "finished thing", { status: "done", working: [{ conversationId: "1", name: "worker-a" }] }),
      node("job-2", "running thing", { working: [{ conversationId: "2", name: "worker-b" }] }),
    ]);
    await startSidePanels();
    await settle();

    const rows = [...jobsPanel().querySelectorAll<HTMLElement>(".job-row")];
    const closedChip = rows[0]!.querySelector<HTMLElement>(".status-chip")!;
    // One chip, and no second one repeating "working".
    expect(rows[0]!.querySelectorAll(".status-chip")).toHaveLength(1);
    expect(closedChip.className).toBe("status-chip status-done job-working");
    expect(closedChip.getAttribute("title")).toBe("Clear this job · Working: worker-a");
    expect(closedChip.tagName).toBe("BUTTON");
    const liveChip = rows[1]!.querySelector<HTMLElement>(".status-chip")!;
    expect(liveChip.className).toBe("status-chip status-active job-working");
    expect(liveChip.getAttribute("title")).toBe("Working: worker-b");
    expect(liveChip.tagName).toBe("SPAN");
  });

  it("lights a folded job for the work under it, and lights an open one only for its own", async () => {
    const tree = () => [
      node("job-1", "group", {}, [node("job-2", "child", { working: [{ conversationId: "2", name: "worker-b" }] })]),
      node("job-3", "quiet group", {}, [node("job-4", "quiet child", { status: "done" })]),
    ];
    setTree(tree());
    await startSidePanels();
    await settle();

    const chip = (id: string) => jobsPanel().querySelector<HTMLElement>(`[data-job-id="${id}"] .status-chip`)!;

    // Open: the group draws its own work only, which it has none of. The child's
    // chip carries the marker, and the group's does not repeat it.
    expect(chip("job-1").className).toBe("status-chip status-active");
    expect(chip("job-1").getAttribute("title")).toBeNull();
    expect(chip("job-2").className).toBe("status-chip status-active job-working");

    // Folded: the child is off screen, so the group says where the work is.
    chip("job-1").click();
    await settle();
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(3);
    expect(chip("job-1").className).toBe("status-chip status-active job-working");
    expect(chip("job-1").getAttribute("title")).toBe("Working below: worker-b");

    // Open again: back to its own work, and the fold is the only thing that
    // changed.
    chip("job-1").click();
    await settle();
    expect(chip("job-1").className).toBe("status-chip status-active");
    expect(chip("job-1").getAttribute("title") ?? "").toBe("");

    // A folded group with nothing working below it stays unfilled.
    chip("job-3").click();
    await settle();
    expect(chip("job-3").className).toBe("status-chip status-active");
    expect(chip("job-3").getAttribute("title") ?? "").toBe("");
  });

  it("names both facts when a folded job is worked on itself and below", async () => {
    setTree([
      node("job-1", "group", { working: [{ conversationId: "1", name: "orchestrator-a" }] }, [
        node("job-2", "child", { working: [{ conversationId: "2", name: "worker-b" }] }),
      ]),
    ]);
    await startSidePanels();
    await settle();

    const chip = () => jobsPanel().querySelector<HTMLElement>('[data-job-id="job-1"] .status-chip')!;
    chip().click();
    await settle();

    // One fill, two lines: the operator can tell which of the two lit it.
    expect(chip().className).toBe("status-chip status-active job-working");
    expect(chip().getAttribute("title")).toBe("Working: orchestrator-a\nWorking below: worker-b");
  });

  it("draws the old schedule list's error above the tree, and takes it down again", async () => {
    const problem = 'config.scheduler.jobs still lists "routine-c"; nothing fires from that list any more.';
    setTree([node("job-1", "parent")], problem);
    await startSidePanels();
    await settle();

    const banner = jobsPanel().querySelector<HTMLElement>(".jobs-banner")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("routine-c");
    expect(jobsPanel().firstElementChild).toBe(banner);

    // A clean list draws no banner, and the empty tree still carries the point.
    setTree([], null);
    await startSidePanels();
    await settle();
    expect(jobsPanel().querySelector(".jobs-banner")).toBeNull();
    expect(jobsPanel().textContent).toContain("No jobs yet.");
  });

  it("reverts one hide at a time, newest first", async () => {
    setTree([node("job-1", "first", { status: "done" }), node("job-2", "second", { status: "done" })]);
    await startSidePanels();
    await settle();

    jobsPanel().querySelectorAll<HTMLElement>("[data-hide-job]")[0]!.click();
    await settle();
    jobsPanel().querySelectorAll<HTMLElement>("[data-hide-job]")[0]!.click();
    await settle();
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(0);
    expect(lastBody("/api/preferences")).toEqual({
      hiddenJobs: ["job-1", "job-2"],
      revertQueueJobs: ["job-1", "job-2"],
      baseRevision: 1,
    });

    jobsPanel().querySelector<HTMLElement>("#jobs-restore")!.click();
    await settle();

    // The newest hide came back and the other stayed off the list.
    expect(jobsPanel().querySelector('[data-job-id="job-2"]')).not.toBeNull();
    expect(jobsPanel().querySelector('[data-job-id="job-1"]')).toBeNull();
    expect(lastBody("/api/preferences")).toEqual({ hiddenJobs: ["job-1"], revertQueueJobs: ["job-1"], baseRevision: 2 });
  });
});

describe("the revert memory", () => {
  it("remembers ten hides and drops the oldest, one cell per click", async () => {
    setTree(Array.from({ length: 11 }, (_, index) => node(`job-${index + 1}`, `thing ${index + 1}`, { status: "done" })));
    await startSidePanels();
    await settle();

    for (let index = 0; index < 11; index += 1) {
      jobsPanel().querySelector<HTMLElement>("[data-hide-job]")!.click();
      await settle();
    }

    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(0);
    // Ten cells, not eleven: the eleventh hide pushed the first one out.
    expect(jobsPanel().querySelector<HTMLElement>("#jobs-restore")!.textContent).toBe("↩ revert (10)");
    expect(lastBody("/api/preferences")).toEqual({
      hiddenJobs: Array.from({ length: 11 }, (_, index) => `job-${index + 1}`),
      revertQueueJobs: Array.from({ length: 10 }, (_, index) => `job-${index + 2}`),
      baseRevision: 10,
    });

    // Ten reverts undo ten hides; the eleventh has nothing left to undo.
    for (let index = 0; index < 11; index += 1) {
      jobsPanel().querySelector<HTMLElement>("#jobs-restore")!.click();
      await settle();
    }
    expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(10);
    expect(jobsPanel().querySelector('[data-job-id="job-1"]')).toBeNull();
    expect(jobsPanel().querySelector('[data-job-id="job-11"]')).not.toBeNull();
  });
});

describe("job events", () => {
  it("reads the tree once for a burst of events inside one second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await startSidePanels();
    await settle();
    const before = requests("/api/jobs?shape=tree", "GET").length;

    const { applyJobEvent } = await import("../../src/ui/state/jobs.ts");
    for (let index = 0; index < 5; index += 1) applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(999);
    expect(requests("/api/jobs?shape=tree", "GET")).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(requests("/api/jobs?shape=tree", "GET")).toHaveLength(before + 1);
  });

  it("runs one more read after a read still in flight, and never two at once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await startSidePanels();
    await settle();
    const { applyJobEvent } = await import("../../src/ui/state/jobs.ts");
    const reads = () => calls.filter((call) => call.url === "/api/jobs?shape=tree").length;
    const before = reads();

    // Hold the next tree read at the fetch, so a second event's window ends while
    // the first read is still running.
    let release: (() => void) | undefined;
    let held = 0;
    answer("/api/jobs?shape=tree", () => {
      held += 1;
      if (held === 1) {
        return new Promise((resolve) => {
          release = () => resolve({ body: { tree: [] } });
        });
      }
      return { body: { tree: [] } };
    });

    applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads()).toBe(before + 1);

    applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(1000);
    // The second window ended while that read was still in flight.
    expect(reads()).toBe(before + 1);

    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(reads()).toBe(before + 2);
  });

  it("hides what the server already holds as cleared, and carries a browser's old list once", async () => {
    window.localStorage.setItem("pi-sec-hidden-jobs", JSON.stringify(["job-2"]));
    answer("/api/preferences", (call) => server.handle(call));
    setTree([node("job-1", "kept", { status: "done" }), node("job-2", "cleared", { status: "done" })]);
    await startSidePanels();
    await settle();

    // The browser's list went to the server once, and the browser copy is gone.
    const patches = calls.filter((call) => call.url === "/api/preferences" && call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0]!.body!)).toEqual({ hiddenJobs: ["job-2"] });
    expect(window.localStorage.getItem("pi-sec-hidden-jobs")).toBeNull();
    // The cleared row never reached the screen.
    expect(jobsPanel().querySelector('[data-job-id="job-1"]')).not.toBeNull();
    expect(jobsPanel().querySelector('[data-job-id="job-2"]')).toBeNull();
  });

  it("reads nothing while the tab is hidden, then once when it is looked at", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await startSidePanels();
    await settle();
    const before = requests("/api/jobs?shape=tree", "GET").length;
    const { applyJobEvent } = await import("../../src/ui/state/jobs.ts");

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests("/api/jobs?shape=tree", "GET")).toHaveLength(before);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(requests("/api/jobs?shape=tree", "GET")).toHaveLength(before + 1);
  });

  it("keeps the pressed chip's focus, the opened row and the scroll when the tree is read again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Each read brings a changed tree, so the list is really drawn again and the
    // rows that did not change have to keep their elements.
    let runs = 1;
    const tree = () => [
      node("job-1", "group", {}, [node("job-2", "child", { status: "done" }), node("job-3", "other")]),
      node("job-4", "last", { stats: { runs: (runs += 1), failures: 0 } }),
    ];
    setTree(tree());
    await startSidePanels();
    await settle();

    // The operator folds a group, opens a title and scrolls the list.
    const chip = jobsPanel().querySelector<HTMLElement>("[data-toggle-children]")!;
    chip.click();
    await settle();
    chip.focus();
    const title = () => jobsPanel().querySelector<HTMLElement>('[data-job-id="job-4"] .job-title')!;
    title().click();
    await settle();
    jobsPanel().scrollTop = 96;

    const chipBefore = captureElement(document, '#jobs [data-job-id="job-1"] .status-chip');
    const titleBefore = captureElement(document, '#jobs [data-job-id="job-4"] .job-title');
    const listBefore = captureElement(document, "#jobs");

    const stillTheSame = (expectedRuns: number) => {
      expectUntouched(chipBefore);
      expectUntouched(titleBefore);
      expectUntouched(listBefore);
      // The fold and the opened block the operator made are still there.
      expect(jobsPanel().querySelectorAll(".job-row")).toHaveLength(2);
      expect(jobsPanel().querySelector('[data-open-job-id="job-4"]')).not.toBeNull();
      // The changed value did reach the row, so this is a real draw.
      expect(jobsPanel().querySelector('[data-job-id="job-4"] .job-counts')!.textContent).toBe(`${expectedRuns}/0`);
    };

    setTree(tree());

    // A job event arrives; the tree is read back after its one-second window.
    const { applyJobEvent, refreshJobs } = await import("../../src/ui/state/jobs.ts");
    applyJobEvent("job_updated");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    stillTheSame(runs);

    // The panel is read again on its own, as the first read of a page is.
    setTree(tree());
    await refreshJobs();
    await settle();
    stillTheSame(runs);

    // The tab comes back and the tree is read once.
    setTree(tree());
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    stillTheSame(runs);
  });
});
