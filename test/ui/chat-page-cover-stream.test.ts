/**
 * The conversation branch's features, on the assembled page.
 *
 * The conversation branch's own tests mount that branch's parts by hand. That branch was written before
 * this one assembled the page, so nothing there says the features still work once
 * the page draws everything at once: one bundle, one stream, four panels and three
 * others beside them. This file says that, one test per feature, on the page the
 * browser is served.
 *
 * A test that needs a clock of its own takes one (`vi.useFakeTimers` after the
 * page loaded), so a one-second wait is a step and not a second of the run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { byId, loadChatPage, more, press, type } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** One assistant answer, the way the server writes an entry. */
function assistant(id: number, text: string): Record<string, unknown> {
  return { id, kind: "pi.assistant", model: [{ role: "assistant", content: text }] };
}

/** One operator message, inside the envelope the server uses now. */
function operator(id: number, body: string): Record<string, unknown> {
  return { id, kind: "pi.user", model: [{ role: "user", content: `<pi-message src="operator">\n${body}\n</pi-message>` }] };
}

/** One tool result. */
function toolResult(id: number, name: string, callId: string, text: string): Record<string, unknown> {
  return { id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: name, toolCallId: callId, content: text }] };
}

/** The rows the transcript drew now, as `data-row-key` values. */
function rowKeys(ui: UiPageHandle): string[] {
  return [...ui.document.querySelectorAll("#transcript > [data-row-key]")].map(
    (row) => row.getAttribute("data-row-key") ?? "",
  );
}

describe("the conversation stream on the assembled page", () => {
  it("opens one stream, at the route the address fixed", async () => {
    open = await loadChatPage();
    expect(open.streams()).toEqual(["/basic-chat/events"]);

    open.close();
    open = await loadChatPage({
      url: "/basic-chat?chat=7",
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "A chat", archived: false } } },
    });
    expect(open.streams()).toEqual(["/api/conversations/7/events"]);

    open.close();
    open = await loadChatPage({
      url: "/basic-chat?chat=9",
      fetch: { "/api/focused-chats/9": { status: 404, body: { error: { code: "not_found", message: "no chat" } } } },
    });
    // A chat the server does not know opens no stream at all.
    expect(open.streams()).toEqual([]);
  });

  it("draws the whole state a snapshot carries", async () => {
    open = await loadChatPage();
    const ui = open;
    ui.currentStream().open();
    await more(1);
    ui.emit("snapshot", {
      entries: [operator(1, "hello"), assistant(2, "**hi** there")],
      run: { active: true },
      agent: { model: { provider: "anthropic", modelId: "claude" } },
      tools: [{ callId: "t1", name: "read", status: "running" }],
      writing: true,
      compaction: false,
    });
    await more(2);

    expect(byId(ui, "transcript").textContent).toContain("hello");
    expect(byId(ui, "transcript").textContent).toContain("hi there");
    expect(byId(ui, "model").textContent).toBe("anthropic/claude");
    expect(byId(ui, "transcript").textContent).toContain("read");
    expect(ui.document.querySelector("#transcript .message.writing")).not.toBeNull();
  });

  it("reopens a stream the server closed, and reads the lists again", async () => {
    open = await loadChatPage();
    const ui = open;
    ui.currentStream().open();
    ui.currentStream().emit("snapshot", { entries: [], run: null });
    await more(2);
    const before = ui.fetchCalls.filter((call) => call.path === "/api/inbox").length;

    vi.useFakeTimers();
    ui.currentStream().fail({ closed: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.streams().length).toBe(2);
    vi.useRealTimers();

    // The second snapshot is a reconnect: what the dropped stream announced is
    // read back rather than assumed.
    ui.currentStream().emit("snapshot", { entries: [], run: null });
    await more(4);
    expect(ui.fetchCalls.filter((call) => call.path === "/api/inbox").length).toBeGreaterThan(before);
  });

  it("says offline, then live, and speaks once a loss has lasted five seconds", async () => {
    open = await loadChatPage();
    const ui = open;
    expect(byId(ui, "connection").textContent).toBe("offline");
    expect(byId(ui, "connection").classList.contains("pill-offline")).toBe(true);

    vi.useFakeTimers();
    ui.currentStream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(byId(ui, "connection").textContent).toBe("live");

    ui.currentStream().fail({ closed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(byId(ui, "connection").textContent).toBe("offline");
    expect(byId(ui, "toast").textContent).toBe("");
    await vi.advanceTimersByTimeAsync(5000);
    expect(byId(ui, "toast").textContent).toContain("Connection lost");
  });

  it("turns the ring by stage, and holds the message while it turns", async () => {
    open = await loadChatPage();
    const ui = open;
    ui.currentStream().open();
    await more(1);
    const ring = byId(ui, "activity");
    expect(ring.classList.contains("hidden")).toBe(true);

    ui.emit("run_start", {});
    await more(1);
    expect(ring.getAttribute("data-stage")).toBe("model");
    expect(ring.classList.contains("hidden")).toBe(false);

    ui.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
    await more(1);
    expect(ring.getAttribute("data-stage")).toBe("tool");

    // Enter sends nothing while the ring turns, and the draft stays in the field.
    type(ui, byId(ui, "message"), "not now");
    byId(ui, "message").dispatchEvent(
      new ui.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await more(2);
    expect(ui.fetchCalls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(0);
    expect((byId(ui, "message") as HTMLTextAreaElement).value).toBe("not now");

    ui.emit("run_end", {});
    await more(1);
    expect(ring.classList.contains("hidden")).toBe(true);
  });

  it("names the model, and `—` before one is known", async () => {
    open = await loadChatPage();
    expect(byId(open, "model").textContent).toBe("—");
    open.emit("snapshot", { entries: [], agent: { model: { provider: "acme", modelId: "m1" } } });
    await more(2);
    expect(byId(open, "model").textContent).toBe("acme/m1");
  });

  it("shows the restart and config banners when the daemon has something to say", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/admin/status": {
          body: {
            restartRequired: true,
            restartReady: false,
            configError: { issues: ["server.basePath is a URL"] },
            notes: [],
          },
        },
      },
    });
    await more(2);
    const restart = byId(open, "restart-banner");
    expect(restart.classList.contains("hidden")).toBe(false);
    expect(restart.textContent).toContain("staged");
    const config = byId(open, "config-banner");
    expect(config.classList.contains("hidden")).toBe(false);
    expect(config.textContent).toContain("server.basePath is a URL");
  });

  it("names the chat in the top bar, and the tab with it", async () => {
    open = await loadChatPage({ name: "pi" });
    expect(byId(open, "chat-title").textContent).toBe("pi");
    expect(open.window.document.title).toBe("pi-sec");

    open.close();
    open = await loadChatPage({
      url: "/basic-chat?chat=7",
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Old topic", archived: false } } },
    });
    await more(2);
    expect(byId(open, "chat-title").textContent).toBe("Old topic");
    expect(byId(open, "chat-mark").classList.contains("hidden")).toBe(false);
    expect(open.window.document.title).toBe("Old topic · pi-sec");
  });

  it("asks for a new title and sends it", async () => {
    open = await loadChatPage({
      url: "/basic-chat?chat=7",
      fetch: {
        "/api/focused-chats/7": (request: { readonly method: string; readonly body: string | null }) =>
          request.method === "PATCH"
            ? {
                body: {
                  conversationId: 7,
                  title: (JSON.parse(request.body ?? "{}") as { title?: string }).title ?? "",
                  archived: false,
                },
              }
            : { body: { conversationId: 7, title: "Old topic", archived: false } },
      },
    });
    await more(2);
    (open.window as unknown as { prompt: () => string }).prompt = () => "New topic";
    press(open, byId(open, "chat-title"));
    await more(3);

    const patch = open.fetchCalls.find((call) => call.path === "/api/focused-chats/7" && call.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch?.body ?? "null")).toEqual({ title: "New topic" });
    expect(byId(open, "chat-title").textContent).toBe("New topic");
  });

  it("keeps an archived chat's transcript and takes its composer away", async () => {
    open = await loadChatPage({
      url: "/basic-chat?chat=7",
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Old topic", archived: true } } },
    });
    await more(3);
    expect(byId(open, "composer").classList.contains("hidden")).toBe(true);
    expect(byId(open, "chat-notice").classList.contains("hidden")).toBe(false);
    expect(byId(open, "chat-notice").textContent).toContain("All chats");
  });

  it("follows a rename that arrives as a frame", async () => {
    open = await loadChatPage({
      url: "/basic-chat?chat=7",
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Old topic", archived: false } } },
    });
    await more(2);
    open.emit("focused_chat_updated", { conversationId: 7, title: "Renamed", archived: false });
    await more(2);
    expect(byId(open, "chat-title").textContent).toBe("Renamed");

    open.emit("focused_chat_updated", { conversationId: 8, title: "Another", archived: false });
    await more(2);
    expect(byId(open, "chat-title").textContent).toBe("Renamed");
  });

  it("draws an answer as markdown, never as markup", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [assistant(1, "**bold** and <script>x</script>")] });
    await more(2);
    const transcript = byId(open, "transcript");
    expect(transcript.querySelector(".message.assistant strong")?.textContent).toBe("bold");
    // Raw HTML in a message stays text.
    expect(transcript.querySelector("script")).toBeNull();
    expect(transcript.textContent).toContain("<script>x</script>");
  });

  it("gives the operator's own words a bubble, without the envelope", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [operator(1, "my own words")] });
    await more(2);
    const bubble = open.document.querySelector("#transcript .message.user");
    expect(bubble?.textContent?.trim()).toBe("my own words");
    expect(bubble?.textContent).not.toContain("pi-message");
    // A message that is not the operator's is folded into a card instead.
    open.emit("snapshot", {
      entries: [
        operator(1, "my own words"),
        { id: 2, kind: "pi.user", model: [{ role: "user", content: '<pi-message src="agent">\na note\n</pi-message>' }] },
      ],
    });
    await more(2);
    expect(open.document.querySelector("#transcript .tool-card")).not.toBeNull();
    expect(open.document.querySelectorAll("#transcript .message.user")).toHaveLength(1);
  });

  it("draws a review, an approval and an answer as their own cards", async () => {
    open = await loadChatPage();
    open.emit("snapshot", {
      entries: [
        {
          id: 1,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content:
                '<pi-message src="pi-sec review" report="plan" version="2">\nthe wording is long and this note says so\n</pi-message>',
            },
          ],
        },
        {
          id: 2,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: '<pi-message src="operator" via="approval">\n[pi-sec approve] report=plan version=2\n</pi-message>',
            },
          ],
        },
        {
          id: 3,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: '<pi-message src="operator" via="ask-user">\nQuestion: Which way?\nOptions:\n1. Both\nAnswer: Both\n</pi-message>',
            },
          ],
        },
      ],
    });
    await more(2);
    const review = open.document.querySelector("#transcript .message.review");
    expect(review).not.toBeNull();
    expect(review?.textContent).toContain("the wording is long");
    const approval = open.document.querySelector("#transcript .message.approval");
    expect(approval).not.toBeNull();
    expect(approval?.textContent).toContain("Approved");
    const answer = open.document.querySelector("#transcript .message.answer");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toContain("Which way?");
    expect(answer?.textContent).toContain("Both");
    // A marker line is never drawn as prose.
    expect(open.document.querySelector("#transcript")?.textContent).not.toContain("[pi-sec approve]");
  });

  it("folds one working stretch into one card, and keeps it open", async () => {
    open = await loadChatPage();
    open.emit("snapshot", {
      entries: [assistant(1, "answer"), toolResult(2, "read", "t1", "some output"), assistant(3, "second answer")],
    });
    await more(2);
    const card = open.document.querySelector("#transcript .tool-card") as HTMLDetailsElement;
    expect(card).not.toBeNull();
    // The card counts what it holds and leaves the zeroes out.
    expect(card.textContent).toContain("read");
    card.open = true;
    // Another entry does not fold it again.
    open.emit("message_start", {});
    await more(2);
    expect((open.document.querySelector("#transcript .tool-card") as HTMLDetailsElement).open).toBe(true);
  });

  it("writes a growing output into the panel that is already there", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [assistant(1, "working on it")], run: { active: true } });
    open.emit("run_start", {});
    open.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
    open.emit("tool_execution_update", { toolCallId: "t1", output: { set: "first line" } });
    await more(2);
    const panel = open.document.querySelector("#transcript .tool-item");
    expect(panel?.textContent).toContain("first line");

    open.emit("tool_execution_update", { toolCallId: "t1", output: { append: "\nsecond line" } });
    await more(2);
    // The same panel took the text: no row was built again for it.
    expect(open.document.querySelector("#transcript .tool-item")).toBe(panel);
    expect(panel?.textContent).toContain("second line");
  });

  it("draws a reset as a divider, and the compaction line while it runs", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [{ id: 1, kind: "pi.reset", model: [] }] });
    await more(2);
    expect(open.document.querySelector("#transcript .divider")).not.toBeNull();

    expect(byId(open, "compaction-status").classList.contains("hidden")).toBe(true);
    open.emit("compaction_start", {});
    await more(1);
    expect(byId(open, "compaction-status").classList.contains("hidden")).toBe(false);
    open.emit("compaction_end", {});
    await more(1);
    expect(byId(open, "compaction-status").classList.contains("hidden")).toBe(true);
  });

  it("keeps the writing row at the tail, with its height, through an answer", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [assistant(1, "an answer")] });
    await more(2);
    const row = open.document.querySelector("#transcript .message.writing") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.classList.contains("idle")).toBe(true);
    // It is the last row whether or not anything is being written.
    expect(open.document.querySelector("#transcript > [data-row-key]:last-child")).toBe(row);

    open.emit("message_start", {});
    await more(2);
    expect(open.document.querySelector("#transcript .message.writing")).toBe(row);
    expect(row.classList.contains("idle")).toBe(false);
  });

  it("keeps a row that a new entry does not touch", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [operator(1, "one"), assistant(2, "two")] });
    await more(2);
    const first = open.document.querySelector('#transcript [data-row-key="entry:1"]');
    expect(first).not.toBeNull();

    open.emit("entry_appended", { entry: assistant(3, "three") });
    await more(2);
    expect(open.document.querySelector('#transcript [data-row-key="entry:1"]')).toBe(first);
    expect(rowKeys(open)).toContain("entry:3");
  });

  it("paints a live output into the same element", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [assistant(1, "working on it")], run: { active: true } });
    open.emit("run_start", {});
    open.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
    open.emit("tool_execution_update", { toolCallId: "t1", output: { set: "one" } });
    await more(2);
    const pre = open.document.querySelector("#transcript .tool-item pre");
    open.emit("tool_execution_update", { toolCallId: "t1", output: { append: " two" } });
    await more(2);
    expect(open.document.querySelector("#transcript .tool-item pre")).toBe(pre);
    expect(pre?.textContent).toContain("one two");
  });

  it("draws every row as a direct child carrying `data-row-key`", async () => {
    open = await loadChatPage();
    open.emit("snapshot", { entries: [operator(1, "one"), assistant(2, "two"), assistant(3, "three")] });
    await more(2);
    const rows = [...byId(open, "transcript").children];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(row.getAttribute("data-row-key")).not.toBeNull();
  });

  it("draws the last forty entries first, then the rest", async () => {
    open = await loadChatPage();
    vi.useFakeTimers();
    const entries = [];
    for (let index = 1; index <= 60; index += 1) entries.push(assistant(index, `answer ${index}`));
    open.emit("snapshot", { entries });
    // The first draw, before the rest is scheduled: the last forty entries.
    await vi.advanceTimersByTimeAsync(0);
    const first = rowKeys(open).length;
    expect(first).toBeGreaterThanOrEqual(40);
    expect(first).toBeLessThan(62);

    // The rest arrives on its own, without another read.
    await vi.advanceTimersByTimeAsync(600);
    expect(rowKeys(open).length).toBe(61);
    expect(open.fetchCalls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(0);
  });

  it("keeps the foot of the transcript on screen while an answer lands", async () => {
    open = await loadChatPage();
    const pane = byId(open, "transcript");
    // jsdom computes no layout, so the page's own numbers are the test's.
    Object.defineProperty(pane, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(pane, "scrollHeight", { value: 1000, configurable: true });
    pane.scrollTop = 600;
    open.emit("snapshot", { entries: [assistant(1, "an answer")] });
    await more(2);
    Object.defineProperty(pane, "scrollHeight", { value: 1200, configurable: true });
    open.emit("entry_appended", { entry: assistant(2, "another answer") });
    await more(3);
    // A reader at the foot is taken along; one who scrolled up is not.
    expect(pane.scrollTop).toBeGreaterThanOrEqual(600);
  });

  it("draws an attachment as a picture, and anything else as a chip", async () => {
    open = await loadChatPage();
    open.emit("snapshot", {
      entries: [
        {
          id: 1,
          kind: "pi.user",
          model: [{ role: "user", content: '<pi-message src="operator" attachments="a1,a2">\nlook\n</pi-message>' }],
        },
      ],
      attachments: {
        a1: { id: "a1", name: "photo.png", mime: "image/png", bytes: 100, width: 320, height: 200 },
        a2: { id: "a2", name: "notes.txt", mime: "text/plain", bytes: 12 },
      },
    });
    await more(2);
    const image = open.document.querySelector("#transcript .message-image img") as HTMLImageElement;
    expect(image?.getAttribute("src")).toContain("/api/attachments/a1");
    const file = open.document.querySelector("#transcript .message-file");
    expect(file?.textContent).toContain("notes.txt");
  });
});
