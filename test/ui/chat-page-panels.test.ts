/**
 * The chat page's one left-hand slot, and the report panel in it.
 *
 * One rule is shared by the three panels: one place, one document, so
 * opening any of them closes the other two and `Esc` closes whichever is up.
 * The report panel itself shows what a press on an inbox notice
 * puts on screen: the meta line, the newest revision as markdown, the way to the
 * report's own page, and the feedback control the report viewer carries too —
 * pressed here it records `via: "panel"`, which is the surface the server is told
 * about.
 *
 * The panel is drawn on the assembled page, so these tests also say that the
 * inbox's opener and the panel agree about which report a press is about.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import {
  byId,
  escape,
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
  open?.close();
  open = undefined;
});

/** The page a report notice is one press away on, with the report it names. */
async function pageWithReport(options: Parameters<typeof loadChatPage>[0] = {}): Promise<UiPageHandle> {
  open = await loadChatPage({
    ...options,
    fetch: {
      "/api/reports/r1": { body: reportRecord(2) },
      "/api/reports/r1/versions/2": { text: "# Plan\n\nsecond revision" },
      ...(options?.fetch ?? {}),
    },
  });
  return open;
}

describe("the one panel slot", () => {
  it("holds one panel at a time: the snippet takes the slot from the report", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    expect(ui.document.body.dataset.report).toBe("open");

    await openSnippetPanel(ui);
    expect(ui.document.body.dataset.snippet).toBe("open");
    expect(ui.document.body.dataset.report).toBe("closed");
  });

  it("holds one panel at a time: the login panel takes the slot from the snippet", async () => {
    const ui = await open0(await loadChatPage());
    await openSnippetPanel(ui);
    await openLoginPanel(ui);
    expect(ui.document.body.dataset.login).toBe("open");
    expect(ui.document.body.dataset.snippet).toBe("closed");
  });

  it("closes the panel that is up on Escape, and only that one", async () => {
    const ui = await open0(await loadChatPage());
    await openSnippetPanel(ui);
    expect(ui.document.body.dataset.snippet).toBe("open");
    escape(ui);
    await more(2);
    expect(ui.document.body.dataset.snippet).toBe("closed");
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(ui.document.body.dataset.login).toBe("closed");
    // The drawer is the sheet's own business and Escape puts it away too.
    expect(ui.document.body.dataset.sidebar).toBe("closed");
  });

  it("keeps the three panels in the transcript's column, before the transcript", async () => {
    const ui = await open0(await loadChatPage());
    const main = ui.document.querySelector(".app-main");
    const panes = [...(main?.children ?? [])].slice(0, 3).map((element) => element.id);
    expect(panes).toEqual(["report-pane", "snippet-pane", "login-pane"]);
    for (const id of panes) expect(ui.document.body.dataset[id.replace("-pane", "")]).toBe("closed");
  });
});

/** Keep a page open for teardown, and hand it back. */
async function open0(ui: UiPageHandle): Promise<UiPageHandle> {
  open = ui;
  return ui;
}

describe("the report panel", () => {
  it("opens on an inbox report notice, and shows the newest revision", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);

    expect(ui.document.body.dataset.report).toBe("open");
    expect(byId(ui, "report-pane-title").textContent).toBe("Plan");
    expect(byId(ui, "report-pane-meta").textContent).toBe("v2 · work");
    expect(byId(ui, "report-pane-body").textContent).toContain("second revision");
    expect(byId(ui, "report-pane").getAttribute("aria-label")).toBe("Report");
    // The panel shares the transcript's column and comes before it, so opening it
    // covers the left of the conversation instead of reflowing it.
    const pane = byId(ui, "report-pane");
    const transcript = ui.document.querySelector(".transcript-pane");
    expect(pane.parentElement?.classList.contains("app-main")).toBe(true);
    expect(pane.nextElementSibling?.id).toBe("snippet-pane");
    expect(transcript?.previousElementSibling?.id).toBe("login-pane");
  });

  it("carries the mount into the report's own page, opened in a new tab", async () => {
    const ui = await pageWithReport({
      base: "/sec",
      url: "/sec/basic-chat",
      fetch: { "/api/inbox": { body: { items: [reportNotice()] } } },
    });
    await openReportPanel(ui);

    const link = byId(ui, "report-pane-page");
    expect(link.getAttribute("href")).toBe("/sec/report/plan");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("Open page");
  });

  it("says how a report stands, and when its revision was approved", async () => {
    const approved = reportRecord(2);
    (approved.versions as Record<string, unknown>[])[1]!.approval = { at: Date.now() - 5 * 60_000, via: "viewer", sha256: "2" };
    const archived = reportRecord(3, { status: "archived", active: false, archived: true });
    (archived.versions as Record<string, unknown>[])[2]!.approval = { at: Date.now() - 5 * 60_000, via: "panel", sha256: "3" };
    const ui = await loadChatPage({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: archived },
        "/api/reports/r1/versions/3": { text: "third" },
      },
    });
    open = ui;
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v3 · work · archived · approved 5m ago");
    // `approved` is said once, by the word itself; the time is the note's own.
    expect(byId(ui, "report-pane-meta").textContent).not.toContain("approved approved");
  });

  it("says `job missing` when the report outlived its job", async () => {
    const ui = await loadChatPage({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: reportRecord(1, { job: null }) },
        "/api/reports/r1/versions/1": { text: "body" },
      },
    });
    open = ui;
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v1 · job missing");
  });

  it("closes from `Open page`, after the press has gone to the link it was", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    const link = byId(ui, "report-pane-page");
    expect(link.getAttribute("href")).toBe("/report/plan");

    press(ui, link);
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(byId(ui, "report-pane-title").textContent).toBe("Report");
  });

  it("closes from `Open page` pressed with the middle button", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);

    byId(ui, "report-pane-page").dispatchEvent(
      new ui.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
    );
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
  });

  it("stays open on a right-button press of `Open page`, which is a menu the page cannot see", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);

    byId(ui, "report-pane-page").dispatchEvent(
      new ui.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }),
    );
    await more(2);
    expect(ui.document.body.dataset.report).toBe("open");
  });

  it("closes from its own button", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    press(ui, byId(ui, "report-pane-close"));
    await more(2);
    expect(ui.document.body.dataset.report).toBe("closed");
    expect(byId(ui, "report-pane-title").textContent).toBe("Report");
  });

  it("approves the newest revision from the panel, and steps aside for what it wrote", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);

    const control = byId(ui, "report-pane-feedback");
    expect(control.hasAttribute("hidden")).toBe(false);
    const form = control.querySelector("#feedback-form");
    expect(form).not.toBeNull();
    expect(byId(ui, "feedback-submit").textContent).toBe("Approve");

    form!.dispatchEvent(new ui.window.Event("submit", { cancelable: true, bubbles: true }));
    await more(4);

    const sent = ui.fetchCalls.find((call) => call.path === "/api/reports/r1/approve");
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "null")).toEqual({ version: 2, via: "panel" });
    // The press is what the panel was for, so it makes room for the chat.
    expect(ui.document.body.dataset.report).toBe("closed");
  });

  it("reads the report again when a new revision lands, and for no other report", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v2 · work");

    ui.respond("/api/reports/r1", { body: reportRecord(3) });
    ui.respond("/api/reports/r1/versions/3", { text: "third revision" });
    // Another report's frame changes nothing on this screen.
    ui.emit("report_updated", { id: "r9" });
    await more(4);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v2 · work");

    ui.emit("report_updated", { id: "r1" });
    await more(4);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v3 · work");
    expect(byId(ui, "report-pane-body").textContent).toContain("third revision");
  });

  it("reads the report again when a note is left on it", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    ui.respond("/api/reports/r1", { body: reportRecord(2, { status: "pending", pendingAt: 1 }) });
    ui.emit("report_feedback", { id: "r1", entry: "e1" });
    await more(4);
    expect(byId(ui, "report-pane-meta").textContent).toBe("v2 · work · pending");
  });

  it("says so when the report cannot be read, and offers nothing to press", async () => {
    const ui = await loadChatPage({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { status: 404, body: { error: { code: "report_not_found", message: "no report with that id" } } },
      },
    });
    open = ui;
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-body").textContent).toBe("Could not load this report.");
    expect(byId(ui, "report-pane-feedback").hasAttribute("hidden")).toBe(true);
    // The notice carries the server's reason, which is the one thing the panel
    // itself does not have room for.
    expect(byId(ui, "toast").textContent).toContain("no report with that id");
  });

  it("shows the loading line on a report opened fresh, and nothing on one read again", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    // The read is held open, so the loading line is on screen while it runs.
    ui.respond("/api/reports/r1", { body: reportRecord(2) });
    await more(2);
    await openReportPanel(ui);
    expect(byId(ui, "report-pane-body").textContent).toContain("second revision");
  });

  it("keeps the feedback field when the same report is read again", async () => {
    const ui = await pageWithReport({ fetch: { "/api/inbox": { body: { items: [reportNotice()] } } } });
    await openReportPanel(ui);
    type(ui, byId(ui, "feedback-body"), "a note I am writing");
    ui.emit("report_updated", { id: "r1" });
    await more(4);
    expect((byId(ui, "feedback-body") as HTMLTextAreaElement).value).toBe("a note I am writing");
  });
});

describe("the report panel and a result report", () => {
  it("offers Done and Feedback, and records the panel as the surface", async () => {
    const ui = await pageWithReport({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: reportRecord(2, { kind: "result", status: "result" }) },
      },
    });
    await openReportPanel(ui);

    const control = byId(ui, "report-pane-feedback");
    expect(control.hasAttribute("hidden")).toBe(false);
    expect(byId(ui, "feedback-done").textContent).toBe("Done");
    expect(byId(ui, "feedback-submit").textContent).toBe("Feedback");
    expect(byId(ui, "feedback-hint").textContent).toBe(
      "Done closes this result. Text with Done asks for follow-up work. Feedback asks for more in this report.",
    );

    press(ui, byId(ui, "feedback-done"));
    await more(4);
    const sent = ui.fetchCalls.find((call) => call.path === "/api/reports/r1/done");
    expect(sent?.method).toBe("POST");
    // The panel is the surface, the same word the bar's own one-button press
    // records on an approval.
    expect(JSON.parse(sent?.body ?? "null")).toEqual({ version: 2, via: "panel" });
    // The press is what the panel was for, so it makes room for the chat.
    expect(ui.document.body.dataset.report).toBe("closed");
  });
});

describe("the report panel and a briefing report", () => {
  it("offers Feedback alone, with the sentence that says a briefing needs no approval", async () => {
    const ui = await pageWithReport({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: reportRecord(2, { kind: "briefing", status: "briefing" }) },
      },
    });
    await openReportPanel(ui);

    const control = byId(ui, "report-pane-feedback");
    expect(control.hasAttribute("hidden")).toBe(false);
    // No Done, and the one button says Feedback rather than Approve.
    expect(ui.document.getElementById("feedback-done")).toBeNull();
    expect(byId(ui, "feedback-submit").textContent).toBe("Feedback");
    expect(byId(ui, "feedback-hint").textContent).toBe("A briefing needs no approval. Feedback goes to the root.");
    // The panel's meta line says the standing the server sent.
    expect(byId(ui, "report-pane-meta").textContent).toBe("v2 · work · briefing");

    // A press with text records the panel as the surface, as any other press does.
    type(ui, byId(ui, "feedback-body"), "the weather is wrong");
    await more(2);
    const form = ui.document.getElementById("feedback-form");
    form!.dispatchEvent(new ui.window.Event("submit", { cancelable: true, bubbles: true }));
    await more(4);
    const sent = ui.fetchCalls.find((call) => call.path === "/api/reports/r1/feedback");
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "null")).toEqual({ body: "the weather is wrong", version: 2 });
  });

  it("sends nothing when the field is empty, because a briefing has no approval to press", async () => {
    const ui = await pageWithReport({
      fetch: {
        "/api/inbox": { body: { items: [reportNotice()] } },
        "/api/reports/r1": { body: reportRecord(2, { kind: "briefing", status: "briefing" }) },
      },
    });
    await openReportPanel(ui);
    const button = byId(ui, "feedback-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const form = ui.document.getElementById("feedback-form");
    form!.dispatchEvent(new ui.window.Event("submit", { cancelable: true, bubbles: true }));
    await more(4);
    // Nothing was sent to a report route: the reads of the panel are the only calls
    // on that path.
    expect(ui.fetchCalls.filter((call) => call.path.startsWith("/api/reports") && call.method !== "GET")).toEqual([]);
  });
});
