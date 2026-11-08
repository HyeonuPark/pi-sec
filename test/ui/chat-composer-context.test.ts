/**
 * The context bar above the composer, and the readout in the sidebar footer.
 *
 * Both draw one reading of `GET …/context`: the bar as a ratio against the point
 * where compaction fires, the row as two numbers in thousands, and the exact
 * counts in both hover texts. The read is the part with a rule: one read at a
 * time and one more queued behind it, so a burst of events cannot draw a state
 * older than the one before it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadComposerPage, type ComposerPage, type FakeAnswer } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

const bar = (ui: ComposerPage) => ui.document.getElementById("context-bar") as HTMLElement;
const fill = (ui: ComposerPage) => ui.document.getElementById("context-fill") as HTMLElement;
const readout = (ui: ComposerPage) => ui.document.getElementById("context-usage") as HTMLElement;

/** Every read of the context route. */
function reads(ui: ComposerPage) {
  return ui.fetchCalls.filter((call) => call.path.endsWith("/context"));
}

/** The reading a page starts from: the one the daemon really answers. */
const START = { used: 10659, max: 983616, window: 1000000, reserveTokens: 16384 };

/** A context route that answers only when the test lets it. */
function gated(initial: unknown = START) {
  const pending: ((answer: FakeAnswer) => void)[] = [];
  let next: unknown = initial;
  return {
    set(value: unknown) {
      next = value;
    },
    answer: () => new Promise<FakeAnswer>((resolve) => pending.push(resolve)),
    release: () => pending.shift()?.({ status: 200, body: next }),
    waiting: () => pending.length,
  };
}

describe("the bar", () => {
  it("fills against the compaction point, not the whole window", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: START } } });

    // 10,659 of the 983,616 usable tokens. Against the 1,000,000 window instead
    // the bar would read 1.07% and reach the end after compaction had fired.
    expect(Number.parseFloat(fill(ui).style.width)).toBeCloseTo((10659 / 983616) * 100, 4);
    expect(bar(ui).getAttribute("aria-valuenow")).toBe("1");
    expect(bar(ui).getAttribute("role")).toBe("progressbar");
    expect(bar(ui).getAttribute("aria-label")).toBe("Context used");
    // The window is still stated, in full, one hover away.
    expect(bar(ui).title).toContain("983,616");
    expect(bar(ui).title).toContain("1,000,000");
    expect(bar(ui).title).toContain("16,384 held back for the answer");
  });

  it("sits directly above the composer", async () => {
    const ui = await page();
    expect(bar(ui).nextElementSibling?.id).toBe("composer");
    expect(fill(ui).parentElement).toBe(bar(ui));
  });

  it("is empty until an answer has been measured", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: { used: null, max: 983616, window: 1000000, reserveTokens: 16384 } } } });

    expect(fill(ui).style.width).toBe("0%");
    expect(bar(ui).getAttribute("aria-valuenow")).toBe("0");
    expect(readout(ui).textContent).toBe("—");
    expect(bar(ui).title).toBe("No answer in this context yet.");
  });
});

describe("the readout", () => {
  it("reads both numbers out in thousands, above the theme control", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: START } } });

    expect(readout(ui).textContent).toBe("10.7k / 983.6k");
    expect(readout(ui).title).toContain("10,659 / 983,616 tokens (1.1%)");
    // The theme row is the next one down, so the readout is what the operator sees
    // just above the control they reach for.
    const theme = ui.document.getElementById("theme-toggle") as HTMLElement;
    expect(readout(ui).parentElement?.nextElementSibling?.contains(theme)).toBe(true);
  });

  it("says a small count as it is, and one without a maximum in thousands", async () => {
    const small = await page({ fetch: { "/basic-chat/context": { body: { used: 950, max: 1000 } } } });
    expect(readout(small).textContent).toBe("950 / 1k");
    small.close();

    const noMax = await page({ fetch: { "/basic-chat/context": { body: { used: 1500, max: null } } } });
    expect(readout(noMax).textContent).toBe("1.5k");
  });

  it("takes the new number when an answer lands", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: { used: 100, max: 1000, window: 2000, reserveTokens: 1000 } } } });
    expect(fill(ui).style.width).toBe("10%");

    ui.respond("/basic-chat/context", { body: { used: 600, max: 1000, window: 2000, reserveTokens: 1000 } });
    ui.emit("message_end", { entry: { id: 7, kind: "pi.assistant", model: [{ role: "assistant", content: "answer" }] } });
    await ui.settle();

    expect(fill(ui).style.width).toBe("60%");
    expect(readout(ui).textContent).toBe("600 / 1k");
  });
});

describe("one read at a time", () => {
  it("reads once when the page opens", async () => {
    const ui = await page();
    expect(reads(ui)).toHaveLength(1);
    expect(reads(ui)[0]?.method).toBe("GET");
    expect(reads(ui)[0]?.path).toBe("/basic-chat/context");
  });

  it("reads a focused chat's own context route", async () => {
    const ui = await page({
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Topic", archived: false } } },
    });
    expect(reads(ui)[0]?.path).toBe("/api/conversations/7/context");
  });

  it("absorbs a burst into one more read, and draws the last state", async () => {
    const gate = gated({ used: 100, max: 1000 });
    const ui = await page({ fetch: { "/basic-chat/context": gate.answer } });
    await ui.settle();
    // The page's own read is the one in flight.
    expect(gate.waiting()).toBe(1);
    expect(reads(ui)).toHaveLength(1);

    // Two events, one after the other, in the window of that read.
    gate.set({ used: 500, max: 1000 });
    ui.emit("message_end", { entry: { id: 1, kind: "pi.assistant", model: [] } });
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.compaction", model: [] } });
    await ui.settle();
    expect(reads(ui)).toHaveLength(1);

    // The first answer lands, and the one queued read follows it: two reads for
    // the burst, and the state on the page is the last one.
    gate.release();
    await ui.settle();
    expect(reads(ui)).toHaveLength(2);
    gate.release();
    await ui.settle();
    expect(fill(ui).style.width).toBe("50%");
    expect(readout(ui).textContent).toBe("500 / 1k");
  });

  it("reads for the four frames that move the numbers, and no others", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: { used: 100, max: 1000 } } } });
    const before = reads(ui).length;

    ui.emit("snapshot", { entries: [] });
    await ui.settle();
    ui.emit("run_end", {});
    await ui.settle();
    ui.emit("message_end", { entry: { id: 1, kind: "pi.assistant", model: [] } });
    await ui.settle();
    // A tool result only reaches the next request, so it moves nothing the bar shows.
    ui.emit("entry_appended", { entry: { id: 2, kind: "pi.tool-result", model: [] } });
    await ui.settle();
    expect(reads(ui)).toHaveLength(before + 3);

    ui.emit("entry_appended", { entry: { id: 3, kind: "pi.assistant", model: [] } });
    await ui.settle();
    expect(reads(ui)).toHaveLength(before + 4);
  });

  it("keeps the last reading when a read fails", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: { used: 400, max: 1000 } } } });
    expect(readout(ui).textContent).toBe("400 / 1k");

    ui.respond("/basic-chat/context", { status: 503, body: { error: { code: "unavailable", message: "no" } } });
    ui.emit("run_end", {});
    await ui.settle();

    expect(readout(ui).textContent).toBe("400 / 1k");
    expect(fill(ui).style.width).toBe("40%");
  });
});
