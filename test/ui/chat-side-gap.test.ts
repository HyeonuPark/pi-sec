/**
 * The old chat page's sidebar assertions that the new page's own tests left
 * uncovered.
 *
 * Every test here comes from one named test of the hand-written page
 * (`test/web-ui.test.ts`, `test/page-job-stream.test.ts`) and checks the same
 * thing on the assembled page the browser is served: the sidebar's job tree, its
 * inbox and the revert memories beside them, the mark an inbox row draws, and what
 * a reconnect re-reads. The old page's own tests stay where they are; this file is
 * the new page's answer to the part of them that no `test/ui/chat-side-*.test.ts`
 * had taken over.
 *
 * The counts are read off the wire, not off a module: a hide is one `PATCH
 * /api/preferences` with both lists in it, and a reconnect is one read of each
 * list, so the request log is what the assertions use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { JOBS_REFRESH_WINDOW_MS } from "../../src/ui/state/jobs.ts";
import {
  byId,
  callsTo,
  loadChatPage,
  more,
  openReportPanel,
  press,
  reportNotice,
  reportRecord,
} from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/* ------------------------------------------------------------- fixtures */

/** One node in the shape `GET /api/jobs?shape=tree` answers with. */
function node(id: string, title: string, extra: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    job: { id, title, status: "active", labels: [], stats: { runs: 1, failures: 0 }, working: [], ...extra },
    children,
  };
}

/** One inbox notice. */
function notice(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "info",
    title: `notice ${id}`,
    body: "",
    createdAt: Date.now() - 30_000,
    severity: "info",
    ...over,
  };
}

/** A job tree answered by the next read. */
function treeAnswer(tree: unknown[]) {
  return { body: { tree } };
}

/** Every preference write the page made, youngest last, as the server read it. */
function preferenceWrites(ui: UiPageHandle): Record<string, unknown>[] {
  return callsTo(ui, "/api/preferences", "PATCH").map((call) => {
    const sent = ui.fetchCalls.find((entry) => entry === call);
    return JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
  });
}

/** The body of the last preference write. */
function lastPreference(ui: UiPageHandle): Record<string, unknown> {
  return preferenceWrites(ui).at(-1) ?? {};
}

const jobRows = (ui: UiPageHandle) => byId(ui, "jobs").querySelectorAll(".job-row");
const restore = (ui: UiPageHandle) => byId(ui, "jobs").querySelector<HTMLButtonElement>("#jobs-restore");
const inboxRows = (ui: UiPageHandle) => byId(ui, "inbox").querySelectorAll(".inbox-item");
const inboxRestore = (ui: UiPageHandle) => byId(ui, "inbox").querySelector<HTMLButtonElement>("#inbox-restore");

/**
 * Run `body` with the page's clock in the test's hand.
 *
 * The page's window is a real `setTimeout` inside the page bundle, and a test that
 * waits it out costs a second per frame. Nothing that needs a real timer — the page
 * load, `more()` — may run inside this block, because the harness's own `settle()`
 * is one of those timers.
 */
async function withPageClock(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

/** Let the job tree's one-second window pass, and the read it costs land. */
async function pastWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(JOBS_REFRESH_WINDOW_MS + 100);
}

/* ----------------------------------------------------------- chat-side */

describe("chat-side: the tree is read once at open, and not again for the open frame", () => {
  it("reads the tree at open, and again on a second snapshot rather than on an open frame", async () => {
    // `test/page-job-stream.test.ts` "does nothing on the first open and reads the
    // tree on a reconnect". The new page stopped listening for `open` and re-reads
    // what a reconnect dropped from the second snapshot on (a screen update changes
    // only what changed). So the
    // assertion is kept and its trigger is the frame that now carries it.
    const ui = await loadChatPage({ fetch: { "/api/jobs": treeAnswer([node("job-1", "parent")]) } });
    open = ui;
    expect(callsTo(ui, "/api/jobs")).toHaveLength(1);

    // The first open is the page's own connection: the read at load answered it.
    // The first snapshot is that same connection, and it reads nothing either. A
    // second snapshot means the stream was away, and the list is read again,
    // through the one-second window every job read goes through. The window is the
    // page's own timer, so the clock is the test's for these three frames.
    await withPageClock(async () => {
      ui.emit("open");
      await pastWindow();
      expect(callsTo(ui, "/api/jobs")).toHaveLength(1);

      ui.emit("snapshot", { entries: [] });
      await pastWindow();
      expect(callsTo(ui, "/api/jobs")).toHaveLength(1);

      ui.emit("snapshot", { entries: [] });
      await pastWindow();
      expect(callsTo(ui, "/api/jobs")).toHaveLength(2);
    });
  });
});

describe("chat-side: a reload still holds the server's revert queue", () => {
  it("reverts what the server still remembers after a reload", async () => {
    const ui = await loadChatPage({
      fetch: {
        "/api/preferences": { body: { hiddenJobs: ["job-1"], revertQueueJobs: ["job-1"], expandedJobs: [], clearedInbox: [] } },
        "/api/jobs": treeAnswer([node("job-1", "finished thing", { status: "done" }), node("job-2", "other", { status: "done" })]),
      },
    });
    open = ui;

    // The queue is server state, so a page that opens later can still undo the
    // last hide it did not make.
    expect(jobRows(ui)).toHaveLength(1);
    expect(restore(ui)!.disabled).toBe(false);
    expect(restore(ui)!.textContent).toContain("↩ revert (1)");

    press(ui, restore(ui)!);
    await more();

    expect(jobRows(ui)).toHaveLength(2);
    expect(byId(ui, "jobs").textContent).toContain("finished thing");
    expect(lastPreference(ui)).toEqual({ hiddenJobs: [], revertQueueJobs: [] });
  });
});

describe("chat-side: one hide of a parent is one memory", () => {
  it("counts a parent's hide as one memory and restores its subtree with one revert", async () => {
    const ui = await loadChatPage({
      fetch: { "/api/jobs": treeAnswer([node("job-1", "parent", { status: "done" }, [node("job-2", "child", { status: "done" })])]) },
    });
    open = ui;
    expect(jobRows(ui)).toHaveLength(2);

    press(ui, byId(ui, "jobs").querySelector<HTMLElement>('[data-job-id="job-1"] [data-hide-job]')!);
    await more();

    // The child left the list with its parent, but the operator pressed once.
    expect(jobRows(ui)).toHaveLength(0);
    expect(restore(ui)!.textContent).toContain("↩ revert (1)");
    expect(lastPreference(ui)).toEqual({ hiddenJobs: ["job-1"], revertQueueJobs: ["job-1"] });

    press(ui, restore(ui)!);
    await more();

    expect(jobRows(ui)).toHaveLength(2);
    expect(byId(ui, "jobs").querySelector('[data-job-id="job-2"]')).not.toBeNull();
  });
});

describe("chat-side: a child hidden on its own stays hidden", () => {
  it("keeps a separately hidden child hidden when its parent is reverted", async () => {
    const ui = await loadChatPage({
      fetch: { "/api/jobs": treeAnswer([node("job-1", "parent", { status: "done" }, [node("job-2", "child", { status: "done" })])]) },
    });
    open = ui;

    // The child is hidden on its own first, so it has a memory of its own.
    press(ui, byId(ui, "jobs").querySelector<HTMLElement>('[data-job-id="job-2"] [data-hide-job]')!);
    await more();
    expect(byId(ui, "jobs").querySelector('[data-job-id="job-2"]')).toBeNull();
    // Then the parent, which took the child off the list a second time.
    press(ui, byId(ui, "jobs").querySelector<HTMLElement>('[data-job-id="job-1"] [data-hide-job]')!);
    await more();
    expect(restore(ui)!.textContent).toContain("↩ revert (2)");

    press(ui, restore(ui)!);
    await more();

    // The parent is back; the child stays hidden, because it was hidden alone.
    expect(byId(ui, "jobs").querySelector('[data-job-id="job-1"]')).not.toBeNull();
    expect(byId(ui, "jobs").querySelector('[data-job-id="job-2"]')).toBeNull();
    // Both lists travel in the one save: the child is still hidden on the server
    // and still remembered, while the parent is neither.
    expect(lastPreference(ui)).toEqual({ hiddenJobs: ["job-2"], revertQueueJobs: ["job-2"] });
    // Its own memory is still in the queue, so a second revert brings it back.
    expect(restore(ui)!.textContent).toContain("↩ revert (1)");
    press(ui, restore(ui)!);
    await more();
    expect(byId(ui, "jobs").querySelector('[data-job-id="job-2"]')).not.toBeNull();
  });
});

describe("chat-side: single hides and one hide-all share one newest-first queue", () => {
  it("keeps the newest-first order when single hides and one hide all are mixed", async () => {
    const ui = await loadChatPage({ fetch: { "/api/inbox": { body: { items: [notice("i1"), notice("i2"), notice("i3")] } } } });
    open = ui;
    expect(inboxRows(ui)).toHaveLength(3);

    press(ui, byId(ui, "inbox").querySelector<HTMLElement>('[data-id="i1"] .inbox-hide')!);
    await more();
    press(ui, byId(ui, "inbox-hide-all"));
    await more();

    // Two presses, two cells: the single hide, then the group.
    expect(inboxRestore(ui)!.textContent).toContain("↩ revert (2)");
    expect(lastPreference(ui)).toEqual({
      clearedInbox: ["i1", "i2", "i3"],
      revertQueueInbox: ["i1", "hide-all:i2,i3"],
    });

    // The group is the newer hide, so it comes back first and alone.
    press(ui, inboxRestore(ui)!);
    await more();
    expect(inboxRows(ui)).toHaveLength(2);
    expect(lastPreference(ui)).toEqual({ clearedInbox: ["i1"], revertQueueInbox: ["i1"] });

    press(ui, inboxRestore(ui)!);
    await more();
    expect(inboxRows(ui)).toHaveLength(3);
    expect(lastPreference(ui)).toEqual({ clearedInbox: [], revertQueueInbox: [] });
  });
});

describe("chat-side: a full queue drops one cell, never half a group", () => {
  it("drops one history cell when the queue is full, never half of a group", async () => {
    // Nine single hides were remembered, and the oldest cell of the ten is a
    // group. The next hide overflows the queue, and the unit that leaves is one
    // cell: the group goes whole, so no id of it is left to undo on its own.
    const older = Array.from({ length: 9 }, (_, index) => `old-${index + 1}`);
    const ui = await loadChatPage({
      fetch: {
        "/api/inbox": { body: { items: [notice("i1"), notice("i2")] } },
        "/api/preferences": { body: { hiddenJobs: [], expandedJobs: [], clearedInbox: [], revertQueueInbox: ["hide-all:a1,a2", ...older] } },
      },
    });
    open = ui;

    press(ui, byId(ui, "inbox-hide-all"));
    await more();

    const queue = lastPreference(ui).revertQueueInbox as string[];
    expect(queue).toHaveLength(10);
    expect(queue).toEqual([...older, "hide-all:i1,i2"]);

    // Eleven hides, one of them a hide all: ten cells stay, and the cell the
    // eleventh drops is the whole of the oldest one.
    const many = Array.from({ length: 12 }, (_, index) => `i${index + 1}`);
    const busy = await loadChatPage({ fetch: { "/api/inbox": { body: { items: many.map((id) => notice(id)) } } } });
    open?.close();
    open = busy;
    expect(inboxRows(busy)).toHaveLength(12);

    for (let index = 0; index < 10; index += 1) {
      press(busy, byId(busy, "inbox").querySelector<HTMLElement>(".inbox-hide")!);
      await more();
    }
    press(busy, byId(busy, "inbox-hide-all"));
    await more();

    const trimmed = lastPreference(busy).revertQueueInbox as string[];
    expect(trimmed).toHaveLength(10);
    expect(trimmed).not.toContain("i1");
    expect(trimmed[trimmed.length - 1]).toBe("hide-all:i11,i12");
  });
});

describe("chat-side: both ways out of an opened title save the same list", () => {
  it("saves the same expandedJobs body from the block and from the caret", async () => {
    // Two paths into one state change. They have to leave the same write behind,
    // array order included, or the server holds a different list per click path.
    const lastBody = async (second: ".job-open" | ".job-title.expanded") => {
      const ui = await loadChatPage({ fetch: { "/api/jobs": treeAnswer([node("job-1", "a long job title that the sidebar truncates")]) } });
      open?.close();
      open = ui;
      const title = () => byId(ui, "jobs").querySelector<HTMLElement>(".job-title")!;

      press(ui, title());
      await more();
      press(ui, byId(ui, "jobs").querySelector<HTMLElement>(second)!);
      await more();
      return lastPreference(ui);
    };

    const fromBlock = await lastBody(".job-open");
    const fromCaret = await lastBody(".job-title.expanded");

    expect(fromBlock).toEqual({ expandedJobs: [] });
    expect(fromCaret).toEqual(fromBlock);
  });
});

describe("chat-side: a fold is the operator's own", () => {
  it("keeps a folded group folded when the next snapshot arrives", async () => {
    const routineTree = [node("routine", "routine", {}, Array.from({ length: 6 }, (_, index) => node(`job-${index + 1}`, `run ${index + 1}`, { status: "done" })))];
    const ui = await loadChatPage({ fetch: { "/api/jobs": treeAnswer(routineTree) } });
    open = ui;
    expect(jobRows(ui)).toHaveLength(7);

    // A fold is the operator's own choice, so a later snapshot must not open the
    // group again behind their back.
    press(ui, byId(ui, "jobs").querySelector<HTMLElement>("[data-toggle-children]")!);
    await more();
    expect(jobRows(ui)).toHaveLength(1);

    await withPageClock(async () => {
      ui.emit("snapshot", { entries: [] });
      ui.emit("snapshot", { entries: [] });
      await pastWindow();
    });
    await more();
    expect(jobRows(ui)).toHaveLength(1);

    // An unfold stays an unfold the same way.
    press(ui, byId(ui, "jobs").querySelector<HTMLElement>("[data-toggle-children]")!);
    await more();
    expect(jobRows(ui)).toHaveLength(7);

    await withPageClock(async () => {
      ui.emit("snapshot", { entries: [] });
      await pastWindow();
    });
    await more();
    expect(jobRows(ui)).toHaveLength(7);
  });
});

describe("chat-side: the mark an inbox row draws", () => {
  it("draws an inline outline document inside the mark", async () => {
    const marked = notice("m1", {
      kind: "report",
      title: "Plan",
      body: "/report/plan",
      source: { reportId: "r1", jobId: "j1", reportEvent: "published" },
    });
    const ui = await loadChatPage({ fetch: { "/api/inbox": { body: { items: [marked] } } } });
    open = ui;

    const mark = byId(ui, "inbox").querySelector<HTMLElement>(".inbox-mark")!;
    const svg = mark.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.getAttribute("focusable")).toBe("false");
    expect(svg!.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    // Outline only: two paths, so the shape still reads at 0.75rem.
    expect(svg!.querySelectorAll("path").length).toBeLessThanOrEqual(3);
  });
});

describe("chat-side: a reconnect re-reads the open report panel", () => {
  it("re-reads the inbox, the questions and the open report on a second snapshot", async () => {
    const ui = await loadChatPage({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: reportRecord(2) },
        "/api/reports/r1/versions/2": { text: "# Plan\n\nsecond revision" },
      },
    });
    open = ui;
    ui.emit("snapshot", { entries: [] });
    await more();

    // The first snapshot is the page's own connection and its lists were read at
    // load, so nothing is read again for it.
    expect(callsTo(ui, "/api/inbox")).toHaveLength(1);
    expect(callsTo(ui, "/api/user-queries")).toHaveLength(1);

    // Open the report pane, so the second snapshot has a panel to reload.
    await openReportPanel(ui);
    const reportReads = (): number => ui.fetchCalls.filter((call) => call.path.startsWith("/api/reports/r1")).length;
    const opened = reportReads();
    expect(opened).toBeGreaterThan(0);

    // The second snapshot means the stream was away, and every frame that would
    // have announced a change went to nobody.
    ui.emit("snapshot", { entries: [] });
    await more();

    expect(callsTo(ui, "/api/inbox")).toHaveLength(2);
    expect(callsTo(ui, "/api/user-queries")).toHaveLength(2);
    expect(reportReads()).toBeGreaterThan(opened);
  });
});
