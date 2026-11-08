/**
 * One frame reaches a handler registered with `onConversationEvent` once.
 *
 * The module keeps its own work for the frames it owns (`applySnapshot`, the run
 * state, the tool state) and hands the same frame to the parts that asked for it.
 * The two must not both be a delivery: a part that reads a route for a frame, as
 * the context bar does, would read it twice for one frame, and a part that counts
 * answers would count each one twice.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadStreamPage, operatorMessage, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(): Promise<StreamPage> {
  open = await loadStreamPage();
  return open;
}

describe("a frame dispatched by the conversation stream", () => {
  it("reaches a handler registered after the stream opened once", async () => {
    const ui = await page();
    const seen: string[] = [];
    const off = ui.stream.onConversationEvent("run_start", (event) => seen.push(event.name));

    ui.emit("run_start", {});
    expect(seen).toEqual(["run_start"]);

    off();
  });

  it("reaches a snapshot handler once, and the snapshot is applied once", async () => {
    const ui = await page();
    let frames = 0;
    const off = ui.stream.onConversationEvent("snapshot", () => {
      frames += 1;
    });

    ui.emit("snapshot", { entries: [operatorMessage(1, "hello")], run: null });

    expect(frames).toBe(1);
    // The page's own work on the frame comes before the handler, and it happened once.
    expect(ui.stream.currentRows().filter((row) => row.key === "entry:1")).toHaveLength(1);

    off();
  });

  it("reaches a handler registered before the stream opened once", async () => {
    const ui = await page();
    // A handler registered while the page holds no stream goes into the module's
    // own map; the next client is given it when it is attached.
    ui.stream.stopConversation();
    const seen: string[] = [];
    const off = ui.stream.onConversationEvent("run_start", (event) => seen.push(event.name));

    ui.stream.startConversation();
    ui.emit("run_start", {});

    expect(seen).toEqual(["run_start"]);

    off();
  });
});
