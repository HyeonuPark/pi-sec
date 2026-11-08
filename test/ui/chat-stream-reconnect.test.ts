/**
 * The stream's life: what the page does when it is closed, when the tab is hidden,
 * when it comes back, and when a live marker entry says the transcript the server
 * draws has moved.
 *
 * The waits are the stream client's and are tested against it in
 * `test/ui/stream-client.test.ts`; what is checked here is that the page still does
 * its part of them: it opens the next stream, it re-reads what the frames of the
 * dropped stream would have changed, and it draws the snapshot that arrives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistant, loadStreamPage, type StreamPage } from "./chat-stream-harness.ts";

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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Every row the transcript drew, in order, by `data-row-key`. */
const rowKeys = (ui: StreamPage): string[] =>
  [...ui.document.querySelectorAll("#transcript > [data-row-key]")].map((row) => row.getAttribute("data-row-key") ?? "");

const title = (ui: StreamPage) => ui.document.getElementById("chat-title") as HTMLButtonElement;

describe("a stream the server closed", () => {
  it("opens a new one after a second, waiting longer each failed attempt", async () => {
    const ui = await page();
    vi.useFakeTimers();
    expect(ui.streams()).toHaveLength(1);

    ui.currentStream().fail();
    await vi.advanceTimersByTimeAsync(999);
    expect(ui.streams()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.streams()).toHaveLength(2);

    // The second attempt failed too, and the wait doubles.
    ui.currentStream().fail();
    await vi.advanceTimersByTimeAsync(1500);
    expect(ui.streams()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(ui.streams()).toHaveLength(3);
  });

  it("opens nothing while the tab is hidden, and does on the return", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.setVisibility("hidden");
    ui.currentStream().fail();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.streams()).toHaveLength(1);

    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("gives up a stream a hidden page held for a minute, and opens a new one on the return", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    await vi.advanceTimersByTimeAsync(0);

    ui.setVisibility("hidden");
    const held = ui.currentStream();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held.closed).toBe(true);
    await flush();
    expect((ui.document.getElementById("connection") as HTMLElement).textContent).toBe("offline");

    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("keeps the stream of a page that comes back before the minute is up", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(1);
  });

  it("opens a new stream when a hidden page comes back after thirty seconds", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("opens a new stream for a page restored from the back/forward cache, and for the network's return", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();
    ui.pageShow(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);

    ui.currentStream().open();
    ui.online();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(3);
  });
});

describe("the second snapshot", () => {
  it("re-reads the chat record the dropped stream would have changed", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Mine" } } } });
    const reads = () => ui.fetchCalls.filter((call) => call.path === "/api/focused-chats/7").length;
    expect(reads()).toBe(1);

    // The first snapshot is the page's own connection: the record was read already.
    ui.emit("snapshot", { entries: [] });
    await flush();
    expect(reads()).toBe(1);

    // The second one follows a reopen, and what the stream would have announced
    // went to a page that was not listening.
    ui.emit("snapshot", { entries: [] });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(2);
  });

  it("shows the missing state, and stops opening streams, for a chat deleted while away", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Mine" } } } });
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.respond("/api/focused-chats/7", { status: 404, body: {} });
    ui.emit("snapshot", { entries: [] });
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(title(ui).textContent).toBe("Chat not found");

    // The stream the page gave up is not opened again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ui.streams()).toHaveLength(1);
  });

  it("draws the whole state the new snapshot carries", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "before")] });
    await flush();
    ui.emit("snapshot", {
      entries: [assistant(1, "before"), assistant(2, "after")],
      agent: { model: { provider: "openai", modelId: "gpt" } },
    });
    await flush();
    const text = (ui.document.getElementById("transcript") as HTMLElement).textContent ?? "";
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect((ui.document.getElementById("model") as HTMLElement).textContent).toBe("openai/gpt");
  });
});

describe("a marker entry that arrives live", () => {
  it("opens a new stream for a reset, and draws the snapshot below the rows it held", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [assistant(1, "old")] });
    await flush();
    expect(ui.streams()).toHaveLength(1);

    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.reset", model: [], head: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);

    // The server's snapshot starts at the reset the page already holds.
    ui.emit("snapshot", { entries: [{ id: 2, kind: "pi.reset", model: [], head: 2 }, assistant(3, "new")] });
    await flush();
    expect(rowKeys(ui)).toEqual(["entry:1", "divider:2", "entry:3", "writing"]);
    expect((ui.document.getElementById("transcript") as HTMLElement).textContent).toContain("old");
  });

  it("keeps the rows of a focused chat the same way", async () => {
    const ui = await page({ chat: 7, fetch: { "/api/focused-chats/7": { body: { title: "Mine" } } } });
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [assistant(1, "old")] });
    await flush();
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.reset", model: [], head: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);

    ui.emit("snapshot", { entries: [{ id: 2, kind: "pi.reset", model: [], head: 2 }, assistant(3, "new")] });
    await flush();
    expect(rowKeys(ui)).toEqual(["entry:1", "divider:2", "entry:3", "writing"]);
  });

  it("keeps the rows a compaction dropped above its divider", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [assistant(1, "dropped one"), assistant(2, "dropped two")] });
    await flush();
    ui.emit("entry_appended", { entry: { id: 3, kind: "pi.compaction", model: [], head: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);

    ui.emit("snapshot", { entries: [{ id: 3, kind: "pi.compaction", model: [], head: 3 }, assistant(4, "kept")] });
    await flush();
    expect(rowKeys(ui)).toEqual(["entry:1", "entry:2", "divider:3", "entry:4", "writing"]);
    const divider = ui.document.querySelector('[data-row-key="divider:3"]') as HTMLElement;
    expect(divider.textContent).toContain("context compacted");
  });

  it("draws the snapshot alone when the page does not hold its head marker", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "old")], hasEarlier: false });
    await flush();

    // The reset came while the connection was down: the page never held entry 2.
    ui.emit("snapshot", {
      entries: [{ id: 2, kind: "pi.reset", model: [], head: 2 }, assistant(3, "new")],
      hasEarlier: true,
    });
    await flush();
    expect(rowKeys(ui)).toEqual(["load-earlier", "divider:2", "entry:3", "writing"]);
    expect((ui.document.getElementById("transcript") as HTMLElement).textContent).not.toContain("old");
  });

  it("opens a new stream for a compaction that arrives as a message_end", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.emit("message_end", { entry: { id: 3, kind: "pi.compaction", model: [], head: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("keeps its stream for a snapshot that already carries a marker", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [{ id: 1, kind: "pi.reset", model: [], head: 1 }] });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.streams()).toHaveLength(1);
  });

  it("keeps its stream for a live entry that heads nothing", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [] });
    ui.emit("entry_appended", { entry: assistant(2, "a message") });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.streams()).toHaveLength(1);
  });

  it("waits for the return when a marker arrives on a hidden page", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.setVisibility("hidden");
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.reset", model: [], head: 2 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.streams()).toHaveLength(1);

    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("opens one stream, not two, for a marker on a page hidden for thirty seconds", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.currentStream().open();
    expect(ui.streams()).toHaveLength(1);

    // The marker waits for the return, and so does the client's own return rule:
    // a page hidden for thirty seconds opens a new stream when it comes back. The
    // two asks are one open, not two.
    ui.setVisibility("hidden");
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.reset", model: [], head: 2 } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ui.streams()).toHaveLength(1);

    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });

  it("keeps one stream when another route already opened the one a marker waited for", async () => {
    const ui = await page();
    vi.useFakeTimers();
    ui.currentStream().open();

    ui.setVisibility("hidden");
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.reset", model: [], head: 2 } });
    // The page came out of the back/forward cache, and that stream's snapshot is
    // the drawing the marker asked for.
    ui.pageShow(true);
    ui.currentStream().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);

    ui.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.streams()).toHaveLength(2);
  });
});
