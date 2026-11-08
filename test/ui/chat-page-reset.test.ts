/**
 * The four reset sites this branch owns.
 *
 * The first requirement of the rewrite is that an update never resets what the
 * operator did not touch. This branch's places are four: the report panel's body, the login panel's two selects,
 * the login panel's answer field, and the snippet panel's name and
 * body.
 *
 * Each test builds the reader's own state first — text, a caret, a focus, a
 * scroll, a selection — then causes the server update that belongs to that place,
 * and then asks whether the same element still holds the same state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedElement, UiPageHandle } from "./harness.ts";
import {
  byId,
  loadChatPage,
  more,
  openLoginPanel,
  openReportPanel,
  openSnippetPanel,
  press,
  reportNotice,
  reportRecord,
  type,
} from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** The page a report is open on, with two revisions of one report. */
async function pageWithReport(): Promise<UiPageHandle> {
  open = await loadChatPage({
    fetch: {
      "/api/inbox": { body: { items: [reportNotice()] } },
      "/api/reports/r1": { body: reportRecord(2) },
      "/api/reports/r1/versions/2": { text: "# Plan\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph" },
    },
  });
  return open;
}

/** Select some words inside an element, the way a reader does with a mouse. */
function selectInside(ui: UiPageHandle, element: Element, from: number, to: number): void {
  const node = element.querySelector("p")?.firstChild ?? element.firstChild;
  if (node === null) throw new Error("nothing to select inside");
  const range = ui.document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = ui.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** What the page's selection says now, or `null` when nothing is selected. */
function selectedText(ui: UiPageHandle): string | null {
  const selection = ui.window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  return selection.toString();
}

/** Remember an element and the selection inside it, as a redraw could lose both. */
function captureWithSelection(ui: UiPageHandle, selector: string): { captured: CapturedElement; selection: string | null } {
  return { captured: ui.capture(selector), selection: selectedText(ui) };
}

describe("the report panel's body", () => {
  it("keeps the body, its scroll and the selected words when the report is read again", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);

    const body = byId(ui, "report-pane-body");
    // A reader who scrolled into the report and selected a sentence.
    (body as HTMLElement).scrollTop = 120;
    selectInside(ui, body, 0, 5);
    const before = captureWithSelection(ui, "#report-pane-body");
    expect(before.selection).toBe("first");

    // The record changed — a note was left on it — and the panel read it again.
    ui.emit("report_feedback", { id: "r1", entry: "e1" });
    await more(4);

    expect(ui.document.querySelector("#report-pane-body")).toBe(before.captured.element);
    expect(selectedText(ui)).toBe("first");
    expect((ui.document.querySelector("#report-pane-body") as HTMLElement).scrollTop).toBe(120);
    // The prose itself is not drawn again when its text did not change.
    expect(ui.document.querySelector("#report-pane-body")?.innerHTML).toBe(body.innerHTML);
  });

  it("keeps the panel around the body, and the feedback being written, when a revision lands", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);

    type(ui, byId(ui, "feedback-body"), "half a note");
    const title = byId(ui, "report-pane-title");
    const meta = byId(ui, "report-pane-meta");
    const close = byId(ui, "report-pane-close");
    const field = ui.capture("#feedback-body");

    ui.respond("/api/reports/r1", { body: reportRecord(3) });
    ui.respond("/api/reports/r1/versions/3", { text: "# Plan\n\nfirst paragraph\n\nsecond paragraph\n\nfourth paragraph" });
    ui.emit("report_updated", { id: "r1" });
    await more(4);

    // The newest revision is on screen, and everything that is not the prose is
    // the same element it was.
    expect(byId(ui, "report-pane-meta").textContent).toBe("v3 · work");
    expect(byId(ui, "report-pane-title")).toBe(title);
    expect(byId(ui, "report-pane-meta")).toBe(meta);
    expect(byId(ui, "report-pane-close")).toBe(close);
    ui.expectUntouched(field);
    expect(byId(ui, "report-pane-body").textContent).toContain("fourth paragraph");
  });

  it("keeps the body on screen while the same report is read again", async () => {
    const ui = await pageWithReport();
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-body").textContent).toContain("first paragraph");

    ui.emit("report_feedback", { id: "r1", entry: "e1" });
    // Read before the answer lands: the loading line must not replace the report.
    // The prose the reader was looking at is still there: the loading line, which
    // would replace it, belongs to a report the panel was not showing before.
    expect(byId(ui, "report-pane-body").textContent?.trim()).toBe(
      "Plan\nfirst paragraph\nsecond paragraph\nthird paragraph",
    );
    await more(4);
    expect(byId(ui, "report-pane-body").textContent).toContain("first paragraph");
  });
});

describe("the login panel's selects", () => {
  it("keeps the chosen provider and its focus when a login starts and ends", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/admin/model-login/providers": {
          body: {
            available: true,
            rootProvider: "anthropic",
            providers: [
              { id: "anthropic", extension: null, configured: false, types: ["oauth", "api_key"], lastLogin: null },
              { id: "acme", extension: "acme", configured: true, types: ["oauth"], lastLogin: null },
            ],
          },
        },
        "/api/admin/model-login/start": {
          body: {
            session: "session-1",
            state: {
              status: "running",
              provider: "acme",
              type: "oauth",
              prompt: null,
              events: [],
              startedAt: "2026-10-24T00:00:00.000Z",
              finishedAt: null,
              loginAt: null,
              reason: null,
              warning: null,
            },
          },
        },
        "/api/admin/model-login/state": {
          body: {
            status: "succeeded",
            provider: "acme",
            type: "oauth",
            prompt: null,
            events: [],
            startedAt: "2026-10-24T00:00:00.000Z",
            finishedAt: "2026-10-24T00:05:00.000Z",
            loginAt: "2026-10-24T00:05:00.000Z",
            reason: null,
            warning: null,
          },
        },
      },
    });
    const ui = open;
    await openLoginPanel(ui);

    const provider = byId<HTMLSelectElement>(ui, "login-provider");
    // The operator picks the second provider and leaves the focus there.
    provider.value = "acme";
    provider.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    await more(2);
    provider.focus();
    const before = ui.capture("#login-provider");
    expect(provider.value).toBe("acme");

    vi.useFakeTimers();
    press(ui, byId(ui, "login-start"));
    await vi.advanceTimersByTimeAsync(0);
    // The login starts: the form is drawn again with both selects disabled.
    expect(byId<HTMLSelectElement>(ui, "login-provider").disabled).toBe(true);
    // And it ends, which draws the form a third time.
    await vi.advanceTimersByTimeAsync(1200);
    expect(byId(ui, "login-status").textContent).toContain("Signed in");
    expect(byId<HTMLSelectElement>(ui, "login-provider").disabled).toBe(false);

    const now = ui.document.getElementById("login-provider");
    expect(now).toBe(before.element);
    expect((now as HTMLSelectElement).value).toBe("acme");
    // The select was disabled and enabled again under the focus; the element is
    // the same one, so no native dropdown was closed and nothing was re-chosen.
    expect((now as HTMLSelectElement).options.length).toBe(2);
  });

  it("keeps the chosen provider and type when the panel is opened again", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/admin/model-login/providers": {
          body: {
            available: true,
            rootProvider: "anthropic",
            providers: [
              { id: "anthropic", extension: null, configured: false, types: ["oauth", "api_key"], lastLogin: null },
              { id: "acme", extension: "acme", configured: true, types: ["oauth"], lastLogin: null },
            ],
          },
        },
      },
    });
    const ui = open;
    await openLoginPanel(ui);
    const provider = byId<HTMLSelectElement>(ui, "login-provider");
    provider.value = "acme";
    provider.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    await more(2);

    press(ui, byId(ui, "login-pane-close"));
    await more(2);
    await openLoginPanel(ui);
    expect(byId<HTMLSelectElement>(ui, "login-provider").value).toBe("acme");
    // The type follows the provider it belongs to.
    expect(byId<HTMLSelectElement>(ui, "login-type").value).toBe("oauth");
  });
});

describe("the login panel's answer field", () => {
  /** A page with a login waiting on a pasted code. */
  async function pageWithPrompt(): Promise<UiPageHandle> {
    open = await loadChatPage({
      fetch: {
        "/api/admin/model-login/providers": {
          body: {
            available: true,
            rootProvider: "anthropic",
            providers: [{ id: "anthropic", extension: null, configured: false, types: ["oauth"], lastLogin: null }],
          },
        },
        "/api/admin/model-login/start": {
          body: {
            session: "session-1",
            state: {
              status: "prompt",
              provider: "anthropic",
              type: "oauth",
              prompt: { type: "manual_code", message: "Paste the code", placeholder: "code#state" },
              events: [],
              startedAt: "2026-10-24T00:00:00.000Z",
              finishedAt: null,
              loginAt: null,
              reason: null,
              warning: null,
            },
          },
        },
        "/api/admin/model-login/state": () => ({
          body: {
            status: "prompt",
            provider: "anthropic",
            type: "oauth",
            prompt: { type: "manual_code", message: "Paste the code", placeholder: "code#state" },
            events: [{ type: "progress", message: "polled" }],
            startedAt: "2026-10-24T00:00:00.000Z",
            finishedAt: null,
            loginAt: null,
            reason: null,
            warning: null,
          },
        }),
      },
    });
    await openLoginPanel(open);
    vi.useFakeTimers();
    press(open, byId(open, "login-start"));
    await vi.advanceTimersByTimeAsync(0);
    return open;
  }

  it("keeps the pasted key, the caret and the focus across three polls", async () => {
    const ui = await pageWithPrompt();
    const field = byId<HTMLInputElement>(ui, "login-answer");
    field.focus();
    field.value = "pasted-key-0123";
    field.setSelectionRange(6, 6);
    const before = ui.capture("#login-answer");

    // Three reads of the state, one a second, carrying only a new progress line.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const now = ui.document.getElementById("login-answer");
    expect(now).toBe(before.element);
    expect((now as HTMLInputElement).value).toBe("pasted-key-0123");
    expect((now as HTMLInputElement).selectionStart).toBe(6);
    expect(ui.document.activeElement).toBe(now);
  });

  it("draws a new field only when the question changes", async () => {
    const ui = await pageWithPrompt();
    const field = byId<HTMLInputElement>(ui, "login-answer");
    field.value = "typed for the first question";

    ui.respond("/api/admin/model-login/state", {
      body: {
        status: "prompt",
        provider: "anthropic",
        type: "oauth",
        prompt: { type: "secret", message: "Paste the API key", placeholder: "sk-…" },
        events: [],
        startedAt: "2026-10-24T00:00:00.000Z",
        finishedAt: null,
        loginAt: null,
        reason: null,
        warning: null,
      },
    });
    await vi.advanceTimersByTimeAsync(1000);

    const next = byId<HTMLInputElement>(ui, "login-answer");
    expect(next).not.toBe(field);
    expect(next.value).toBe("");
    expect(next.type).toBe("password");
    expect(next.placeholder).toBe("sk-…");
  });
});

describe("the snippet panel's fields", () => {
  /** The page the snippet panel is open on, with the name and body being written. */
  async function pageWithText(): Promise<UiPageHandle> {
    open = await loadChatPage();
    await openSnippetPanel(open);
    type(open, byId(open, "snippet-name"), "/tmp/notes.md");
    type(open, byId(open, "snippet-body"), "a note I am still writing");
    byId<HTMLTextAreaElement>(open, "snippet-body").focus();
    byId<HTMLTextAreaElement>(open, "snippet-body").setSelectionRange(7, 7);
    return open;
  }

  it("keeps the name, the body, the caret and the focus across a live frame", async () => {
    const ui = await pageWithText();
    const name = ui.capture("#snippet-name");
    const body = ui.capture("#snippet-body");

    ui.emit("entry_appended", {
      entry: { id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: "an answer" }] },
    });
    await more(4);

    ui.expectUntouched(name);
    ui.expectUntouched(body);
  });

  it("keeps them across a reconnection's whole state", async () => {
    const ui = await pageWithText();
    const name = ui.capture("#snippet-name");
    const body = ui.capture("#snippet-body");

    // The stream comes back and sends everything it holds.
    const stream = ui.currentStream();
    stream.emit("snapshot", { entries: [], run: null });
    stream.emit("snapshot", { entries: [], run: null });
    await more(4);

    ui.expectUntouched(name);
    ui.expectUntouched(body);
    expect(ui.document.body.dataset.snippet).toBe("open");
  });

  it("keeps them when another panel is opened and this one comes back", async () => {
    const ui = await pageWithText();
    press(ui, byId(ui, "snippet-pane-close"));
    await more(2);
    await openSnippetPanel(ui);
    expect((byId(ui, "snippet-name") as HTMLInputElement).value).toBe("/tmp/notes.md");
    expect((byId(ui, "snippet-body") as HTMLTextAreaElement).value).toBe("a note I am still writing");
  });
});
