// @vitest-environment jsdom
/**
 * The inbox in the sidebar.
 *
 * These are the assertions `test/web-ui.test.ts` made on `renderInbox`
 * (the marks, the age, the badge that leaves out a set-aside report, the title
 * that opens an item and reads it, the hide button, `hide all` as one cell of
 * history, the revert, the report notice that opens the panel) moved onto the new
 * components, plus the read that `report_created` / `report_updated` cause, plus
 * the reset test: a read must leave the pressed title's focus, the text
 * selected in an opened body and the open state where the operator left them.
 */
import { fakePreferences, type FakePreferences } from "./preferences-fake.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySideSnapshot, mountSideParts, startSidePanels } from "../../src/ui/chat/SideParts.tsx";
import { applyInboxFrame, resetInboxState, setInboxOpeners } from "../../src/ui/state/inbox.ts";
import { resetJobsState } from "../../src/ui/state/jobs.ts";
import { resetQueriesState } from "../../src/ui/state/queries.ts";
import { resetNotesState } from "../../src/ui/state/notes.ts";

/* ------------------------------------------------------------ the page */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type Answer = { readonly status?: number; readonly body?: unknown } | Promise<{ readonly status?: number; readonly body?: unknown }>;

const routes = new Map<string, (call: Call) => Answer>();
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
  return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => text } as Response;
}

function answer(path: string, route: (call: Call) => Answer): void {
  routes.set(path, route);
}

/** The server's shared state for this test: it answers reads and keeps what a press saves. */
let server: FakePreferences = fakePreferences();

/** The answers every panel gets, before a test changes one. */
function defaults(): void {
  server = fakePreferences();
  answer("/api/jobs", () => ({ body: { tree: [] } }));
  answer("/api/preferences", (call) => server.handle(call));
  answer("/api/inbox", () => ({ body: { items: [] } }));
  answer("/api/user-queries", () => ({ body: { queries: [] } }));
  answer("/api/admin/status", () => ({ body: {} }));
  answer("/api/inbox/i1/read", () => ({ body: {} }));
  answer("/api/inbox/i2/read", () => ({ body: {} }));
  answer("/api/inbox/i3/read", () => ({ body: {} }));
}

/** The items the next inbox read answers with. */
function setInbox(items: unknown[]): void {
  answer("/api/inbox", () => ({ body: { items } }));
}

/** One notice. */
function note(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "notice",
    title: "Brief ready",
    body: "All good",
    createdAt: Date.now() - 5 * 60_000,
    ...over,
  };
}

/** A report notice: the kind the panel opens for. */
function reportNote(id = "i9") {
  return note(id, {
    kind: "report",
    title: "Plan",
    body: "/report/plan\njob j1\nv2",
    source: { reportId: "r1", jobId: "j1" },
  });
}

const inbox = () => document.querySelector<HTMLElement>("#inbox")!;
const badge = () => document.querySelector<HTMLElement>("#inbox-count")!;
const hideAllButton = () => document.querySelector<HTMLButtonElement>("#inbox-hide-all")!;
const title = (index = 0) => inbox().querySelectorAll<HTMLElement>(".inbox-title")[index]!;
const hide = (index = 0) => inbox().querySelectorAll<HTMLElement>(".inbox-hide")[index]!;
const restoreButton = () => inbox().querySelector<HTMLButtonElement>("#inbox-restore")!;
const patchBodies = () =>
  calls
    .filter((call) => call.url.includes("/api/preferences") && call.method === "PATCH")
    .map((call) => (call.body === null ? undefined : JSON.parse(call.body)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Remember one element, the state a redraw could take from it, and its place. */
function remember(selector: string): { element: Element; focused: boolean } {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`the page has no element matching ${selector}`);
  return { element, focused: document.activeElement === element };
}

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

describe("the inbox", () => {
  it("draws each notice with its age, its severity and an unread badge", async () => {
    setInbox([
      note("i1"),
      note("i2", { severity: "error", kind: "job", title: "Job failed", body: "it broke" }),
      note("i3", { readAt: Date.now() - 1000, title: "Already read" }),
    ]);
    await startSidePanels();
    await settle();

    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(3);
    expect(inbox().textContent).toContain("Brief ready");
    expect(inbox().textContent).toContain("5m ago");
    expect(inbox().querySelector(".severity-dot.severity-info")).not.toBeNull();
    expect(inbox().querySelector(".severity-dot.severity-error")).not.toBeNull();
    // A read item is listed and does not count.
    expect(inbox().querySelector<HTMLElement>('.inbox-item[data-id="i3"]')!.className).toBe("inbox-item read");
    expect(badge().textContent).toBe("2");
    // The row is a title line: the body is a press away.
    expect(inbox().textContent).not.toContain("it broke");
    expect(hideAllButton().disabled).toBe(false);
  });

  it("lists a notice about a report that is set aside without raising the badge", async () => {
    setInbox([note("i1"), { ...reportNote("i9"), pending: true }]);
    await startSidePanels();
    await settle();

    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(2);
    expect(badge().textContent).toBe("1");
    const quiet = inbox().querySelector<HTMLElement>('.inbox-item[data-id="i9"]')!;
    expect(quiet.className).toBe("inbox-item read pending");
  });

  it("opens an item on its title and reads it, then folds it shut again", async () => {
    setInbox([note("i1")]);
    await startSidePanels();
    await settle();
    expect(badge().textContent).toBe("1");

    title().click();
    await settle();

    expect(inbox().textContent).toContain("All good");
    expect(inbox().querySelector(".inbox-item")!.className).toBe("inbox-item read");
    expect(badge().textContent).toBe("0");
    expect(title().getAttribute("aria-expanded")).toBe("true");
    expect(title().querySelector(".inbox-caret")!.textContent).toBe("▾");
    expect(calls.some((call) => call.url === "/api/inbox/i1/read" && call.method === "POST")).toBe(true);

    title().click();
    await settle();
    expect(inbox().textContent).not.toContain("All good");
    // Folding it shut is not clearing it.
    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(1);
  });

  it("clears an item from its own hide button, and brings it back one cell at a time", async () => {
    setInbox([note("i1"), note("i2")]);
    await startSidePanels();
    await settle();

    hide().click();
    await settle();
    hide().click();
    await settle();

    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(0);
    expect(restoreButton().textContent).toBe("↩ revert (2)");
    expect(patchBodies().at(-1)).toEqual({ clearedInbox: ["i1", "i2"], revertQueueInbox: ["i1", "i2"], baseRevision: 1 });

    restoreButton().click();
    await settle();

    // Only the newest hide came back, and one save carries both lists.
    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(1);
    expect(inbox().querySelector('.inbox-item[data-id="i2"]')).not.toBeNull();
    expect(inbox().querySelector('.inbox-item[data-id="i1"]')).toBeNull();
    expect(patchBodies().at(-1)).toEqual({ clearedInbox: ["i1"], revertQueueInbox: ["i1"], baseRevision: 2 });
    expect(restoreButton().textContent).toBe("↩ revert (1)");

    restoreButton().click();
    await settle();
    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(2);
    expect(restoreButton().disabled).toBe(true);
    expect(patchBodies().at(-1)).toEqual({ clearedInbox: [], revertQueueInbox: [], baseRevision: 3 });
  });

  it("hides every item in one press, as one cell and one undo", async () => {
    setInbox([note("i1"), note("i2"), note("i3")]);
    await startSidePanels();
    await settle();

    hideAllButton().click();
    await settle();

    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(0);
    expect(badge().textContent).toBe("0");
    expect(restoreButton().textContent).toBe("↩ revert (1)");
    // The whole group rides in one queue entry: a queue holds plain strings.
    expect(patchBodies().at(-1)).toEqual({
      clearedInbox: ["i1", "i2", "i3"],
      revertQueueInbox: ["hide-all:i1,i2,i3"],
      baseRevision: 0,
    });
    // With nothing on screen there is nothing to hide, and the button says so.
    expect(hideAllButton().disabled).toBe(true);

    restoreButton().click();
    await settle();
    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(3);
    expect(patchBodies().at(-1)).toEqual({ clearedInbox: [], revertQueueInbox: [], baseRevision: 1 });
  });

  it("declines hide all when nothing is on screen", async () => {
    setInbox([]);
    await startSidePanels();
    await settle();

    expect(inbox().querySelector(".inbox-body")!.textContent).toBe("Inbox is empty.");
    expect(hideAllButton().disabled).toBe(true);
    hideAllButton().click();
    await settle();
    expect(patchBodies()).toEqual([]);
  });

  it("opens a report notice in the report panel instead of folding it", async () => {
    const opened: string[] = [];
    setInboxOpeners({ openReport: (id) => opened.push(id) });
    setInbox([reportNote()]);
    await startSidePanels();
    await settle();

    // The mark says what the notice is, and names the event it records.
    const mark = inbox().querySelector<HTMLElement>(".inbox-mark")!;
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Report");
    expect(mark.className).toBe("inbox-mark inbox-mark--report");
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(inbox().querySelector(".inbox-title-text")!.textContent).toBe("Plan");

    title().click();
    await settle();

    expect(opened).toEqual(["r1"]);
    // The row did not fold: the document is the panel's business.
    expect(inbox().querySelector(".inbox-body")).toBeNull();
    expect(badge().textContent).toBe("0");
  });

  it("names the event a report notice records on its mark", async () => {
    setInbox([note("i9", { kind: "report", title: "Plan", source: { reportId: "r1", reportEvent: "updated" } })]);
    await startSidePanels();
    await settle();

    const mark = inbox().querySelector<HTMLElement>(".inbox-mark")!;
    expect(mark.className).toBe("inbox-mark inbox-mark--report inbox-mark--updated");
    expect(mark.getAttribute("aria-label")).toBe("Report updated");
    expect(mark.querySelectorAll("path").length).toBeLessThanOrEqual(3);
  });

  it("names the producer on a notice that is not a report", async () => {
    setInbox([
      note("a1", { kind: "archive", title: "Swept" }),
      note("a2", { kind: "async_call", title: "Ran" }),
      note("a3", { kind: "focused_chat", title: "Opened" }),
    ]);
    await startSidePanels();
    await settle();

    const names = [...inbox().querySelectorAll<HTMLElement>(".inbox-mark")].map((mark) => mark.getAttribute("aria-label"));
    expect(names).toEqual(["Archive sweep", "Background task", "Focused chat"]);
    expect(inbox().querySelector<HTMLElement>(".inbox-mark")!.className).toBe("inbox-mark inbox-mark--other");
  });

  it("reads the inbox again when a report is published or updated", async () => {
    setInbox([note("i1")]);
    await startSidePanels();
    await settle();
    setInbox([note("i1"), note("i2")]);
    const before = calls.filter((call) => call.url.startsWith("/api/inbox?")).length;

    applyInboxFrame("report_created");
    await settle();
    applyInboxFrame("report_updated");
    await settle();

    expect(calls.filter((call) => call.url.startsWith("/api/inbox?")).length).toBe(before + 2);
    expect(inbox().querySelectorAll(".inbox-item")).toHaveLength(2);
  });

  it("sends a focused chat's notice to that chat, read first", async () => {
    const opened: number[] = [];
    setInboxOpeners({ openChat: (id) => opened.push(id) });
    setInbox([note("i1", { kind: "focused_chat", title: "Chat opened", source: { conversationId: "7" } })]);
    await startSidePanels();
    await settle();

    title().click();
    await settle();

    expect(opened).toEqual([7]);
    // Read first: leaving the page drops whatever was not sent.
    expect(calls.some((call) => call.url === "/api/inbox/i1/read" && call.method === "POST")).toBe(true);
    expect(badge().textContent).toBe("0");
  });

  it("reads the inbox and the questions again when the stream comes back", async () => {
    await startSidePanels();
    await settle();
    const inboxReads = () => calls.filter((call) => call.url.startsWith("/api/inbox?")).length;
    const queryReads = () => calls.filter((call) => call.url === "/api/user-queries").length;
    const before = [inboxReads(), queryReads()];

    applySideSnapshot();
    await settle();

    // Both lists change only when a frame says so, and that frame went to nobody
    // while the stream was away.
    expect([inboxReads(), queryReads()]).toEqual([before[0]! + 1, before[1]! + 1]);
  });

  it("moves an age every minute, and holds a hidden tab's ages still", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const createdAt = Date.now();
    setInbox([note("i1", { createdAt })]);
    await startSidePanels();
    await settle();
    const age = () => inbox().querySelector<HTMLElement>(".inbox-age")!;
    const drawn = inbox().querySelector(".inbox-item");
    expect(age().textContent).toBe("just now");
    expect(age().dataset.createdAt).toBe(String(createdAt));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(age().textContent).toBe("1m ago");
    // Text only: the row is the same node, so an open item and its read mark stay.
    expect(inbox().querySelector(".inbox-item")).toBe(drawn);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(age().textContent).toBe("1m ago");

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(age().textContent).toBe("2m ago");
  });

  it("keeps the pressed hide button, the opened body and the selected text when the inbox is read again", async () => {
    setInbox([note("i1", { body: "a body the operator is reading" }), note("i2")]);
    await startSidePanels();
    await settle();

    title().click();
    await settle();
    const body = inbox().querySelector<HTMLElement>('.inbox-item[data-id="i1"] .inbox-body')!;
    const text = body.firstChild!;

    // Focus first, then select: jsdom drops the document's selection when an
    // element takes the focus, which a browser does not do to a reader.
    hide(1).focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const before = selection.toString();
    expect(before).toBe("a body the operator is reading");

    const focused = remember('.inbox-item[data-id="i2"] .inbox-hide');
    const row = remember('.inbox-item[data-id="i1"]');
    inbox().scrollTop = 40;

    // The read brings a changed row, so the list is really drawn again: the second
    // notice got a new title, and the row the operator holds keeps its element.
    setInbox([note("i1", { body: "a body the operator is reading" }), note("i2", { title: "Brief ready again" })]);
    applyInboxFrame("report_updated");
    await settle();

    expect(document.querySelector('.inbox-item[data-id="i2"] .inbox-hide')).toBe(focused.element);
    expect(document.activeElement).toBe(focused.element);
    expect(document.querySelector('.inbox-item[data-id="i1"]')).toBe(row.element);
    // The body stayed the same text node, so the selection still covers it.
    expect(body.firstChild).toBe(text);
    expect(selection.toString()).toBe(before);
    expect(inbox().scrollTop).toBe(40);
    // The open item is still open, and the changed row did reach the screen.
    expect(inbox().querySelector('.inbox-item[data-id="i1"] .inbox-body')).toBe(body);
    expect(inbox().querySelector('.inbox-item[data-id="i2"] .inbox-title-text')!.textContent).toBe("Brief ready again");
  });
});
