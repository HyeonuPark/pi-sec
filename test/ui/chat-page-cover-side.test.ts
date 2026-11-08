/**
 * The sidebar branch's features, on the assembled page.
 *
 * The sidebar branch's own tests mount the six
 * sidebar elements by hand and call the state functions directly. On the page the
 * browser is served, those lists are filled by one read at open and by the frames
 * the conversation stream carries — the wiring this branch owns — so this file
 * checks the four panels where they really are: in the sidebar, beside a running
 * transcript, fed by the page's own stream.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { byId, loadChatPage, more, press, type } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/** One open question, as `GET /api/user-queries` answers it. */
function question(key: string, text: string): Record<string, unknown> {
  return { key, id: key, question: text, options: ["One", "Two"], createdAt: Date.now() - 60_000, askedAt: Date.now() - 60_000 };
}

/** One job node, as `GET /api/jobs?shape=tree` answers it. */
function node(id: string, title: string, extra: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    job: { id, title, status: "active", labels: [], stats: { runs: 1, failures: 0 }, working: [], ...extra },
    children,
  };
}

/** One inbox notice. */
function notice(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "info", title, body: "", createdAt: Date.now() - 30_000, severity: "info", ...over };
}

describe("the sidebar on the assembled page", () => {
  it("draws a question that was already pending, and answers it by its key", async () => {
    open = await loadChatPage({ fetch: { "/api/user-queries": { body: { queries: [question("q1", "Which way?")] } } } });
    const ui = open;
    const card = ui.document.querySelector("#queries .query");
    expect(card?.getAttribute("data-key")).toBe("q1");
    expect(card?.textContent).toContain("Which way?");
    expect(card?.querySelectorAll("button[data-choice]")).toHaveLength(2);
    expect(card?.querySelector(".other-input")).not.toBeNull();

    press(ui, card!.querySelector('button[data-choice="1"]') as Element);
    await more(3);
    const sent = ui.fetchCalls.find((call) => call.path === "/api/user-queries/q1");
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "null")).toMatchObject({ choice: 1 });
  });

  it("draws the inbox with its unread badge, opens an item, and hides one", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/inbox": {
          body: { items: [notice("i1", "First notice"), notice("i2", "Second notice", { readAt: Date.now() })] },
        },
        "/api/inbox/i1/read": { body: {} },
      },
    });
    const ui = open;
    const rows = ui.document.querySelectorAll("#inbox .inbox-item");
    expect(rows).toHaveLength(2);
    expect(byId(ui, "inbox-count").textContent).toBe("1");

    // A note without a report opens in place and is marked read.
    press(ui, rows[0]!.querySelector(".inbox-title") as Element);
    await more(3);
    expect(ui.fetchCalls.filter((call) => call.path === "/api/inbox/i1/read")).toHaveLength(1);
    expect(ui.document.querySelector("#inbox .inbox-item .inbox-body")).not.toBeNull();

    // Its own hide button takes it out of the list.
    press(ui, ui.document.querySelector("#inbox .inbox-hide") as Element);
    await more(3);
    expect(ui.document.querySelectorAll("#inbox .inbox-item")).toHaveLength(1);
  });

  it("draws the job tree, and folds a live job's children from its chip", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/jobs": {
          body: { tree: [node("j1", "Parent job", {}, [node("j2", "Child job")])] },
        },
      },
    });
    const ui = open;
    const rows = ui.document.querySelectorAll("#jobs .job-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(byId(ui, "jobs").textContent).toContain("Parent job");
    expect(ui.document.querySelector('#jobs [data-job-id="j2"]')?.getAttribute("data-depth")).toBe("1");

    // The chip of a live job folds what is under it.
    const chip = ui.document.querySelector('#jobs [data-job-id="j1"] .status-chip');
    expect(chip).not.toBeNull();
    press(ui, chip as Element);
    await more(2);
    expect(ui.document.querySelector('#jobs [data-job-id="j2"]')).toBeNull();
  });

  it("shows the daemon's recent notes, and hides the panel while there are none", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/admin/status": {
          body: {
            restartRequired: false,
            restartReady: false,
            configError: null,
            notes: [
              { at: Date.now() - 60_000, text: "mount conflict: X-Forwarded-Prefix \"/other\"" },
              { at: Date.now(), text: "config reload failed: server.basePath is a URL" },
            ],
          },
        },
      },
    });
    const ui = open;
    expect(byId(ui, "notes-panel").classList.contains("hidden")).toBe(false);
    const text = byId(ui, "notes").textContent ?? "";
    expect(text).toContain("config reload failed");
    // Newest first: the operator wants to know what is happening now.
    expect(text.indexOf("config reload failed")).toBeLessThan(text.indexOf("/other"));

    open.close();
    open = await loadChatPage();
    expect(byId(open, "notes-panel").classList.contains("hidden")).toBe(true);
  });

  it("fills the three lists from one read at open, and re-reads them for a frame", async () => {
    open = await loadChatPage();
    const ui = open;
    const reads = (path: string) => ui.fetchCalls.filter((call) => call.path === path).length;
    expect(reads("/api/jobs")).toBeGreaterThan(0);
    const inboxReads = reads("/api/inbox");
    const queryReads = reads("/api/user-queries");

    // A frame that says the inbox changed, and a question that was resolved.
    ui.emit("inbox_item", { id: "i1" });
    ui.emit("user_query_resolved", { key: "q1" });
    await more(4);
    expect(reads("/api/inbox")).toBeGreaterThan(inboxReads);
    expect(reads("/api/user-queries")).toBeGreaterThan(queryReads);
  });

  it("keeps what is typed into a question's `Other…` field while the list is read again", async () => {
    open = await loadChatPage({ fetch: { "/api/user-queries": { body: { queries: [question("q1", "Which way?")] } } } });
    const ui = open;
    const other = ui.document.querySelector("#queries .other-input input") as HTMLInputElement;
    other.focus();
    type(ui, other, "my own answer");
    other.setSelectionRange(4, 4);
    const before = ui.capture("#queries .other-input input");

    ui.emit("user_query_resolved", { key: "q9" });
    await more(4);

    expect(ui.document.querySelector("#queries .other-input input")).toBe(before.element);
    expect((ui.document.querySelector("#queries .other-input input") as HTMLInputElement).value).toBe("my own answer");
    expect(ui.document.activeElement).toBe(before.element);
  });
});
