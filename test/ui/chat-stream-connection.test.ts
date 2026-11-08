/**
 * The connection pill, the activity ring, the model pill and what the page says
 * when its stream is gone.
 *
 * The rules are the hand-written chat page's (removed in this commit): the pill
 * reads `live` or `offline`, the ring
 * turns red for a lost connection before anything is said about it, the toast waits
 * five seconds and then speaks once, and every failed attempt after that says so
 * again. A lost connection outranks a run in the ring, and the composer takes no
 * message while the ring turns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStreamPage, type StreamPage } from "./chat-stream-harness.ts";

const element = (page: StreamPage, id: string) => page.document.getElementById(id) as HTMLElement;
const pill = (page: StreamPage) => element(page, "connection");
const ring = (page: StreamPage) => element(page, "activity");
const model = (page: StreamPage) => element(page, "model");

let open: StreamPage | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadStreamPage>[0] = {}): Promise<StreamPage> {
  open = await loadStreamPage(options);
  return open;
}

describe("one stream per page", () => {
  it("opens the root conversation's stream on a page without a chat number", async () => {
    const ui = await page();
    expect(ui.streams()).toEqual(["/basic-chat/events"]);
  });

  it("opens one focused chat's stream when the address names one", async () => {
    const ui = await page({ chat: 7 });
    expect(ui.streams()).toEqual(["/api/conversations/7/events"]);
    // The record is read before the stream opens, because the bar and the composer
    // are drawn from it. The status route and the provider list follow, as they do
    // on every page.
    const paths = ui.fetchCalls.map((call) => call.path);
    expect(paths[0]).toBe("/api/focused-chats/7");
    expect(paths).toContain("/api/admin/status");
    expect(paths).toContain("/api/admin/model-login/providers");
  });

  it("opens no stream for a chat the server does not know", async () => {
    const ui = await page({ chat: 9, fetch: { "/api/focused-chats/9": { status: 404, body: {} } } });
    expect(ui.streams()).toEqual([]);
    expect(element(ui, "chat-title").textContent).toBe("Chat not found");
  });
});

describe("the connection pill", () => {
  it("reads offline until the stream opens, and live after", async () => {
    const ui = await page();
    expect(pill(ui).textContent).toBe("offline");
    expect(pill(ui).className).toBe("pill pill-offline");

    ui.currentStream().open();
    await Promise.resolve();
    expect(pill(ui).textContent).toBe("live");
    expect(pill(ui).className).toBe("pill pill-online");
  });

  it("returns to offline the moment a stream fails", async () => {
    const ui = await page();
    ui.currentStream().open();
    ui.currentStream().fail();
    await Promise.resolve();
    expect(pill(ui).textContent).toBe("offline");
  });
});

describe("the activity ring", () => {
  it("sits hidden at rest, with no stage", async () => {
    const ui = await page();
    ui.currentStream().open();
    await Promise.resolve();
    expect(ring(ui).classList.contains("hidden")).toBe(true);
    expect(ring(ui).hasAttribute("data-stage")).toBe(false);
  });

  it("turns blue while the model is waited on and green while a tool runs", async () => {
    const ui = await page();
    ui.currentStream().open();
    ui.emit("run_start", {});
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");

    ui.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("tool");

    ui.emit("tool_execution_end", { toolCallId: "c1" });
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");

    ui.emit("run_end", {});
    await Promise.resolve();
    expect(ring(ui).classList.contains("hidden")).toBe(true);
  });

  it("keeps the model stage while the answer streams in", async () => {
    const ui = await page();
    ui.currentStream().open();
    ui.emit("run_start", {});
    ui.emit("message_start", {});
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");
  });

  it("draws a run that was already going when the page opened", async () => {
    const ui = await page();
    ui.currentStream().open();
    ui.emit("snapshot", { entries: [], run: { startedAt: 1 }, tools: [] });
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");
  });

  it("turns red on a lost connection, which outranks a run", async () => {
    const ui = await page();
    ui.currentStream().open();
    ui.emit("run_start", {});
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");

    ui.currentStream().fail({ closed: false });
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("offline");

    ui.currentStream().open();
    await Promise.resolve();
    expect(ring(ui).getAttribute("data-stage")).toBe("model");
  });

  it("turns red from the first paint, before the stream has opened", async () => {
    const ui = await page();
    expect(ring(ui).classList.contains("hidden")).toBe(false);
    expect(ring(ui).getAttribute("data-stage")).toBe("offline");
  });
});

describe("the model pill", () => {
  it("reads the provider and model of the snapshot, and `—` before one", async () => {
    const ui = await page();
    expect(model(ui).textContent).toBe("—");
    ui.emit("snapshot", { entries: [], agent: { model: { provider: "anthropic", modelId: "claude" } } });
    await Promise.resolve();
    expect(model(ui).textContent).toBe("anthropic/claude");
  });
});

describe("a lost connection", () => {
  it("keeps the toast back for five seconds, then shows it", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.currentStream().fail();
    expect(ui.toast.toast.value.visible).toBe(false);

    // A second failed attempt inside the wait says nothing either.
    await vi.advanceTimersByTimeAsync(2000);
    ui.currentStream().fail();
    expect(ui.toast.toast.value.visible).toBe(false);

    await vi.advanceTimersByTimeAsync(2999);
    expect(ui.toast.toast.value.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.toast.toast.value.visible).toBe(true);
    expect(ui.toast.toast.value.text).toBe("Connection lost — retrying…");
    expect(ui.toast.toast.value.kind).toBe("error");
  });

  it("says so again on a failed attempt after the toast has spoken", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.currentStream().fail();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.toast.toast.value.visible).toBe(true);
    // The toast's own wait ends, and a later failure brings it back.
    await vi.advanceTimersByTimeAsync(8000);
    expect(ui.toast.toast.value.visible).toBe(false);
    ui.currentStream().fail();
    expect(ui.toast.toast.value.visible).toBe(true);
    expect(ui.toast.toast.value.text).toBe("Connection lost — retrying…");
  });

  it("says nothing when the connection comes back inside the five seconds", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.currentStream().fail();
    await vi.advanceTimersByTimeAsync(3000);
    ui.currentStream().open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.toast.toast.value.visible).toBe(false);
    expect(ring(ui).classList.contains("hidden")).toBe(true);
    expect(ui.run.canSend.value).toBe(true);
  });

  it("marks the page disconnected on a lagging stream notice", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    await Promise.resolve();
    expect(pill(ui).textContent).toBe("live");
    ui.emit("notice", { code: "stream_lagging" });
    await Promise.resolve();
    expect(pill(ui).textContent).toBe("offline");
  });
});

describe("what the composer may do", () => {
  it("takes a message at rest and none while a run or a lost connection turns the ring", async () => {
    const ui = await page();
    ui.currentStream().open();
    await Promise.resolve();
    expect(ui.run.canSend.value).toBe(true);

    ui.emit("run_start", {});
    await Promise.resolve();
    expect(ui.run.canSend.value).toBe(false);

    ui.emit("run_end", {});
    await Promise.resolve();
    expect(ui.run.canSend.value).toBe(true);

    ui.currentStream().fail({ closed: false });
    await Promise.resolve();
    expect(ui.run.canSend.value).toBe(false);
  });

  it("stays down for a send that has not answered yet", async () => {
    const ui = await page();
    ui.currentStream().open();
    await Promise.resolve();
    ui.run.sending.value = true;
    expect(ui.run.canSend.value).toBe(false);
    ui.run.sending.value = false;
    expect(ui.run.canSend.value).toBe(true);
  });
});
