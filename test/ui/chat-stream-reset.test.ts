/**
 * The first requirement: an update changes only what changed.
 *
 * A stream event, a frame that appends an entry and a second snapshot after a
 * reconnect must leave every row the user did not touch the same element, with the
 * text selection, the focus, the open state and the scroll position it had.
 *
 * jsdom lays nothing out, so the scroll cases stub the pane's three numbers, as the
 * page's own transcript tests did. The real browser check of the scroll belongs to
 * the branch that switches the pages over: this file holds only what jsdom can
 * decide.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assistant, loadStreamPage, operatorMessage, toolResult, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
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

/** The transcript element, which is the shell's own. */
function transcript(ui: StreamPage): HTMLElement {
  return ui.document.getElementById("transcript") as HTMLElement;
}

/** The numbers jsdom does not compute: six hundred pixels of pane, a hundred a row. */
function stubPane(ui: StreamPage) {
  const pane = transcript(ui).parentElement as HTMLElement;
  const numbers = { clientHeight: 600, rowHeight: 100, scrollTop: 0 };
  Object.defineProperty(pane, "clientHeight", { configurable: true, get: () => numbers.clientHeight });
  Object.defineProperty(pane, "scrollHeight", { configurable: true, get: () => transcript(ui).childElementCount * numbers.rowHeight });
  Object.defineProperty(pane, "scrollTop", {
    configurable: true,
    get: () => numbers.scrollTop,
    set: (value: number) => {
      numbers.scrollTop = value;
    },
  });
  return { pane, numbers };
}

/** Select the whole of one row, as a reader does before copying from it. */
function selectRow(ui: StreamPage, selector: string): string {
  const row = ui.document.querySelector(selector);
  if (row === null) throw new Error(`the transcript has no ${selector}`);
  const range = ui.document.createRange();
  range.selectNodeContents(row);
  const selection = ui.window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection?.toString() ?? "";
}

/** What the reader has selected now. */
function selected(ui: StreamPage): string {
  return ui.window.getSelection()?.toString() ?? "";
}

describe("one row of the transcript", () => {
  it("keeps the element, the selection and the focus of a row another row's arrival does not touch", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "the answer above"), toolResult(2, "bash", "c1", "the tool output")] });
    await flush();

    const kept = ui.capture('[data-row-key="entry:1"]');
    const before = selectRow(ui, '[data-row-key="entry:1"]');
    expect(before).toContain("the answer above");

    // A new entry arrives, and the tool call it answers moves its own row only.
    ui.emit("entry_appended", { entry: operatorMessage(3, "one more thing") });
    await flush();

    ui.expectUntouched(kept);
    expect(selected(ui)).toBe(before);
    // The row that changed is the tool call's, which is no longer live.
    expect(ui.document.querySelector('[data-row-key="entry:1"]')).toBe(kept.element);
  });

  it("changes the words of one row and no other when a snapshot corrects it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "the first answer"), assistant(2, "the second answer")] });
    await flush();
    const first = ui.capture('[data-row-key="entry:1"]');
    const second = ui.document.querySelector('[data-row-key="entry:2"]');
    const before = selectRow(ui, '[data-row-key="entry:1"]');

    ui.emit("snapshot", { entries: [assistant(1, "the first answer"), assistant(2, "the second answer, corrected")] });
    await flush();

    ui.expectUntouched(first);
    expect(selected(ui)).toBe(before);
    // The corrected row keeps its element and changes its words, which is what an
    // update is: the row that did not change is not touched at all.
    expect(ui.document.querySelector('[data-row-key="entry:2"]')).toBe(second);
    expect(ui.document.querySelector('[data-row-key="entry:2"]')?.textContent).toContain("corrected");
  });

  it("leaves every row the same element when a second snapshot repeats them", async () => {
    const ui = await page();
    const entries = [operatorMessage(1, "please look"), toolResult(2, "bash", "c1", "out"), assistant(3, "done")];
    ui.emit("snapshot", { entries });
    await flush();
    const before = [...ui.document.querySelectorAll("#transcript > [data-row-key]")];

    ui.emit("snapshot", { entries });
    await flush();
    const after = [...ui.document.querySelectorAll("#transcript > [data-row-key]")];
    expect(after).toHaveLength(before.length);
    // Row for row: the same element. This is what `reconcileById` is for.
    for (let index = 0; index < before.length; index += 1) expect(after[index]).toBe(before[index]);
  });
});

describe("a folded card the operator opened", () => {
  it("stays open when a new event draws the transcript", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [toolResult(1, "bash", "c1", "out")] });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]');
    card!.open = true;
    card!.dispatchEvent(new ui.window.Event("toggle"));
    await flush();
    const kept = ui.capture('[data-row-key="run:1"]');

    ui.emit("message_start", {});
    await flush();
    ui.expectUntouched(kept);
    expect(ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]')?.open).toBe(true);
  });

  it("stays open across a second snapshot after a reconnect", async () => {
    const ui = await page();
    const entries = [toolResult(1, "bash", "c1", "out"), assistant(2, "done")];
    ui.emit("snapshot", { entries });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]');
    card!.open = true;
    card!.dispatchEvent(new ui.window.Event("toggle"));
    await flush();
    const kept = ui.capture('[data-row-key="run:1"]');

    ui.emit("snapshot", { entries });
    await flush();
    ui.expectUntouched(kept);
    expect(ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]')?.open).toBe(true);
  });

  it("stays open while a new entry is appended inside it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [toolResult(1, "bash", "c1", "out")] });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]');
    card!.open = true;
    card!.dispatchEvent(new ui.window.Event("toggle"));
    await flush();

    ui.emit("tool_execution_start", { toolCallId: "c2", toolName: "read" });
    await flush();
    expect(ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]')?.open).toBe(true);
    expect(ui.document.querySelectorAll('[data-row-key="run:1"] .tool-item')).toHaveLength(2);
  });
});

describe("the first paint", () => {
  const answers = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => assistant(from + index, `answer ${from + index}`));

  it("draws the last forty entries first and the rest when the browser is idle", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "the oldest answer"), ...answers(2, 59)] });
    await flush();
    const before = [...ui.document.querySelectorAll("#transcript > [data-row-key]")].map((row) => row.getAttribute("data-row-key"));
    expect(before).toHaveLength(41);
    expect(transcript(ui).textContent).toContain("answer 60");
    expect(transcript(ui).textContent).not.toContain("the oldest answer");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ui.document.querySelectorAll("#transcript > [data-row-key]")).toHaveLength(61);
    expect(transcript(ui).textContent).toContain("the oldest answer");
  });

  it("keeps the foot of the transcript on screen, and the reader's distance when they scrolled up", async () => {
    const ui = await page();
    const { pane, numbers } = stubPane(ui);
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    // Forty rows and the writing row, with the foot on screen.
    expect(transcript(ui).childElementCount).toBe(41);
    expect(numbers.scrollTop).toBe(pane.scrollHeight);

    // The reader scrolls up before the rest lands above them.
    numbers.scrollTop = 1000;
    pane.dispatchEvent(new ui.window.Event("scroll"));
    const distance = pane.scrollHeight - numbers.scrollTop - numbers.clientHeight;

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transcript(ui).childElementCount).toBe(61);
    expect(pane.scrollHeight - numbers.scrollTop - numbers.clientHeight).toBe(distance);
  });

  it("draws a second snapshot whole, because its rows are on screen already", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    expect(transcript(ui).childElementCount).toBe(41);
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    expect(transcript(ui).childElementCount).toBe(61);
  });

  it("drops a queued rest when a newer draw reads the same state", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    expect(transcript(ui).childElementCount).toBe(41);
    ui.emit("entry_appended", { entry: assistant(61, "answer 61") });
    await flush();
    // A newer draw reads the state as it stands, so the queued pass was dropped and
    // the list is the whole conversation: sixty-one rows and the writing row.
    expect(transcript(ui).childElementCount).toBe(62);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transcript(ui).childElementCount).toBe(62);
    expect(transcript(ui).textContent).toContain("answer 61");
  });
});

describe("following the tail", () => {
  const answers = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => assistant(from + index, `answer ${from + index}`));

  type Watcher = { callback: () => void; targets: Element[] };

  /** A `ResizeObserver` for a page that has none, installed before the page is loaded. */
  function watchSizes(): Watcher[] {
    const watchers: Watcher[] = [];
    class FakeResizeObserver implements Watcher {
      readonly targets: Element[] = [];
      constructor(readonly callback: () => void) {
        watchers.push(this);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve(target: Element) {
        const at = this.targets.indexOf(target);
        if (at !== -1) this.targets.splice(at, 1);
      }
      disconnect() {
        this.targets.length = 0;
      }
    }
    Object.defineProperty(globalThis, "ResizeObserver", { value: FakeResizeObserver, configurable: true, writable: true });
    return watchers;
  }

  afterEach(() => {
    Object.defineProperty(globalThis, "ResizeObserver", { value: undefined, configurable: true, writable: true });
  });

  it("follows the tail when the operator is already at the bottom", async () => {
    const watchers = watchSizes();
    const ui = await page();
    const { pane, numbers } = stubPane(ui);
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The observer watched the transcript and its pane, from the first draw.
    expect(watchers).toHaveLength(1);
    expect(watchers[0]?.targets).toEqual([transcript(ui), pane]);
    expect(numbers.scrollTop).toBe(pane.scrollHeight);

    ui.emit("entry_appended", { entry: assistant(61, "answer 61") });
    await flush();
    expect(numbers.scrollTop).toBe(pane.scrollHeight);
  });

  it("holds the operator's place when they scrolled up", async () => {
    const watchers = watchSizes();
    const ui = await page();
    const { pane, numbers } = stubPane(ui);
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));

    numbers.scrollTop = 1000;
    pane.dispatchEvent(new ui.window.Event("scroll"));
    ui.emit("entry_appended", { entry: assistant(61, "answer 61") });
    await flush();
    expect(numbers.scrollTop).toBe(1000);

    // A row that grows after its draw moves nobody who scrolled up.
    numbers.rowHeight = 150;
    watchers[0]?.callback();
    expect(numbers.scrollTop).toBe(1000);
  });

  it("follows the tail when a row grows after it was drawn, for a reader at the foot", async () => {
    const watchers = watchSizes();
    const ui = await page();
    const { pane, numbers } = stubPane(ui);
    ui.emit("snapshot", { entries: answers(1, 60) });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(numbers.scrollTop).toBe(pane.scrollHeight);

    numbers.rowHeight = 150;
    watchers[0]?.callback();
    expect(numbers.scrollTop).toBe(pane.scrollHeight);
  });
});
