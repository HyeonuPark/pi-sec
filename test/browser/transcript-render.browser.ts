/**
 * Transcript rows in a real browser.
 *
 * jsdom has no layout, so it cannot answer any of these: whether an off-screen
 * row is skipped, where the scrollbar is after a row arrives, and whether an
 * animation is running. This file drives Chromium through Playwright against a
 * real server on port 0.
 *
 * The four facts it pins: a transcript row computes `content-visibility: auto`,
 * a pane at the tail stays at the tail when an entry arrives while a pane scrolled
 * up holds its place, the same holds while an open live tool panel grows under
 * frames that only append output, and the idle writing row's dots are paused
 * while the row that is writing keeps them running.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { launchChromium } from "./chromium.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: harness.runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: builtWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await launchChromium();
  // A short viewport on purpose: the transcript has to overflow for the scroll
  // facts to mean anything.
  context = await browser.newContext({ viewport: { width: 1280, height: 420 } });

  // The root conversation is created by the first message, and the page's stream
  // attaches to it. Filling it first means the page opens on a transcript rather
  // than on the 503 a conversation-less boot answers.
  await send("hello there, this is the first message of the test conversation");
  await waitForContextUsed();
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * One user turn, and the one faux answer it gets. A step may take its time: the
 * provider awaits the step, so a slow one keeps the page in its writing state,
 * which is the only way to read the moving dots.
 */
async function send(content: string, step?: () => Promise<unknown>): Promise<void> {
  if (harness === undefined) throw new Error("the harness is not running");
  harness.faux.setResponses([(step ?? (async () => fauxAssistantMessage([fauxText("ok")]))) as never]);
  await post("/basic-chat/messages", { content });
}

/** Wait until the root conversation holds a committed answer, which ends the run. */
async function waitForContextUsed(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await fetch(`${origin}/basic-chat/context`);
    if (response.ok) {
      const data = (await response.json()) as { used?: number };
      if (typeof data.used === "number" && data.used > 0) return;
    }
    await wait(100);
  }
  throw new Error("the root conversation never reported a used context");
}

interface OpenedPage {
  readonly page: Page;
  readonly consoleLines: string[];
  readonly pageErrors: string[];
}

async function openPage(): Promise<OpenedPage> {
  const page = await currentContext().newPage();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#transcript > [data-row-key]").length >= 2, undefined, {
    timeout: 30000,
  });
  return { page, consoleLines, pageErrors };
}

/** The rows on screen, the writing row included. */
function rowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
}

/** Two frames: long enough for a scroll the page sets to be laid out. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** How far the pane is from its tail, in pixels. */
function distanceFromBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  });
}

/**
 * Put the pane at its tail.
 *
 * Repeated, because a row near the tail may still carry its estimated height and
 * take its real one once it comes into view, which moves the tail again.
 */
async function scrollToTail(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".transcript-pane");
      if (pane !== null) pane.scrollTop = pane.scrollHeight;
    });
    await settle(page);
    if ((await distanceFromBottom(page)) <= 0) return;
  }
}

/** One transcript entry, in the shape a `snapshot` frame carries it. */
function chatEntry(id: number, kind: "pi.user" | "pi.assistant", text: string) {
  return { id, kind, model: [{ role: kind === "pi.user" ? "user" : "assistant", content: [{ type: "text", text }] }] };
}

/** One frame of the conversation stream, as this test hands it to the page. */
interface Frame {
  readonly type: string;
  readonly data?: unknown;
}

interface FramePage extends OpenedPage {
  /** Hand the page one or more frames in a single task, so they share one paint. */
  emit(frames: Frame[]): Promise<void>;
}

/**
 * A page whose conversation stream this test drives frame by frame.
 *
 * The other tests read what a real run puts on the wire. This one needs a live
 * tool call whose output grows in known steps, and a shell command cannot promise
 * that: its writes land when the process feels like it, and a panel that grows
 * past its 14rem would stop moving the pane. So the stream alone is stubbed, and
 * the page keeps its own script, its own layout and its own scrollbar.
 */
async function openFramePage(): Promise<FramePage> {
  const page = await currentContext().newPage();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  // Installed before any page script, which is what makes the page's own
  // `new EventSource(...)` a source this test can emit on.
  await page.addInitScript(() => {
    const sources: Array<{ emit: (type: string, data?: unknown) => void }> = [];
    (window as unknown as { __sseSources: unknown }).__sseSources = sources;
    class EmittingSource {
      readonly url: string;
      readonly listeners: Map<string, Array<(event: { data: string }) => void>> = new Map();
      constructor(url: string) {
        this.url = String(url);
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: { data: string }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      removeEventListener(): void {}
      close(): void {}
      emit(type: string, data?: unknown): void {
        const payload = data === undefined ? "" : JSON.stringify(data);
        for (const listener of this.listeners.get(type) ?? []) listener({ data: payload });
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = EmittingSource;
  });
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => ((window as unknown as { __sseSources?: unknown[] }).__sseSources?.length ?? 0) > 0,
    undefined,
    { timeout: 30000 },
  );

  const emit = async (frames: Frame[]): Promise<void> => {
    await page.evaluate((handed) => {
      const built = (window as unknown as { __sseSources?: Array<{ emit: (type: string, data?: unknown) => void }> })
        .__sseSources ?? [];
      const source = built[built.length - 1];
      if (source === undefined) throw new Error("the page opened no stream");
      for (const frame of handed) source.emit(frame.type, frame.data);
    }, frames);
  };

  return { page, consoleLines, pageErrors, emit };
}

/** The live panel's text, so a step can show that it really grew. */
function liveOutput(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-tool-call-id="call-live"] pre')?.textContent ?? "",
  );
}

/** What the frames did to the transcript, as the transcript itself reports it. */
interface Touched {
  /** Every mutation the observer saw, inside the live panel or not. */
  readonly records: number;
  /** The ones outside the live panel, each named: a row rebuilt, or an attribute moved. */
  readonly outside: readonly string[];
}

/**
 * Watch the transcript while the frames are handed to the page.
 *
 * A live output frame writes the panel's `<pre>` and rebuilds no row: the panel
 * reads the output from the run state, and the rows around it are the same
 * elements after the frame as before. A full draw instead touches those rows, so
 * a record from outside the panel is a draw this test did not expect. The
 * hand-written page kept a draw counter on `window`; the new one keeps it to
 * itself, and this reads the same fact where it shows: in the DOM the page left.
 */
async function watchTranscript(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.getElementById("transcript");
    if (host === null) throw new Error("no transcript");
    const outside: string[] = [];
    let records = 0;
    const observer = new MutationObserver((list) => {
      for (const record of list) {
        records += 1;
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target !== null && target.closest('[data-tool-call-id="call-live"]') !== null) continue;
        outside.push(`${record.type} on ${target === null ? "a detached node" : target.className || target.nodeName}`);
      }
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
    (window as unknown as { __stopWatching: () => Touched }).__stopWatching = () => {
      observer.disconnect();
      return { records, outside };
    };
  });
}

/** Stop watching, and answer what the frames touched in the meantime. */
async function touched(page: Page): Promise<Touched> {
  return await page.evaluate(
    () => (window as unknown as { __stopWatching?: () => Touched }).__stopWatching?.() ?? { records: 0, outside: [] },
  );
}

/** Three output frames of one paint, two lines each, numbered from `first`. */
function appendFrames(first: number): Frame[] {
  return [first, first + 1, first + 2].map((line) => ({
    type: "tool_execution_update",
    data: { toolCallId: "call-live", output: { append: `line ${line} of the live output\nand its second line\n` } },
  }));
}

/** The pane's scroll offset. */
function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector<HTMLElement>(".transcript-pane")?.scrollTop ?? 0);
}

/** Wait until two more rows are on screen — one turn, and the answer to it. */
async function waitForRow(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#transcript > [data-row-key]").length >= expected,
    count,
    { timeout: 30000 },
  );
  await page.waitForSelector(".message.writing.idle", { state: "attached", timeout: 30000 });
  await settle(page);
}

it("skips layout for rows far from the viewport", async () => {
  const opened = await openPage();
  const facts = await opened.page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("#transcript > [data-row-key]");
    if (row === null) return null;
    const style = getComputedStyle(row);
    return { contentVisibility: style.contentVisibility, containIntrinsicSize: style.containIntrinsicSize };
  });

  expect(opened.pageErrors).toEqual([]);
  expect(facts).not.toBeNull();
  expect(facts!.contentVisibility).toBe("auto");
  expect(facts!.containIntrinsicSize).toContain("80px");
});

it("holds the tail while an open live tool panel grows, and holds the place while scrolled up", async () => {
  const opened = await openFramePage();
  const { page, emit } = opened;

  const paragraph =
    "a paragraph that takes room in the transcript, so the pane has a place to scroll\n\n" +
    "a second paragraph under it, for the same reason\n\n" +
    "and a third one, so eight rows do not fit the viewport";
  const entries = [];
  for (let turn = 0; turn < 4; turn += 1) {
    entries.push(chatEntry(turn * 2 + 1, "pi.user", `question ${turn + 1}\n\n${paragraph}`));
    entries.push(chatEntry(turn * 2 + 2, "pi.assistant", `answer ${turn + 1}\n\n${paragraph}`));
  }

  await emit([{ type: "open" }, { type: "snapshot", data: { entries } }]);
  await page.waitForFunction(() => document.querySelectorAll("#transcript > [data-row-key]").length >= 9, undefined, {
    timeout: 30000,
  });
  await emit([{ type: "tool_execution_start", data: { toolCallId: "call-live", toolName: "bash" } }]);
  await page.waitForSelector('[data-tool-call-id="call-live"] pre', { state: "attached", timeout: 30000 });

  // The operator opened the run: its panel now takes room in the pane, and what
  // grows is the text inside it.
  await page.evaluate(() => {
    for (const group of document.querySelectorAll<HTMLDetailsElement>("details[data-group-key]")) group.open = true;
  });
  await scrollToTail(page);
  // The transcript really does overflow, or a scroll assertion would mean nothing.
  expect(await scrollTop(page)).toBeGreaterThan(0);
  expect(await distanceFromBottom(page)).toBeLessThanOrEqual(24);

  const grownFrom = (await liveOutput(page)).length;
  // Frames of one paint, each appending two lines: the batch moves the tail by
  // more than the slack, which is what makes a fast path without a scroll show.
  await watchTranscript(page);
  await emit(appendFrames(1));
  await settle(page);

  const grownAtTail = (await liveOutput(page)).length;
  expect(grownAtTail).toBeGreaterThan(grownFrom);
  // The frames took the fast path: the panel's own text is all they touched, so
  // the tail below is the fast path's work and not a full draw's.
  const atTailTouched = await touched(page);
  expect(atTailTouched.records).toBeGreaterThan(0);
  expect(atTailTouched.outside).toEqual([]);
  expect(await distanceFromBottom(page)).toBeLessThanOrEqual(24);

  // Scrolled up, the same growth must not pull the reader down.
  await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane !== null) pane.scrollTop = 0;
  });
  await settle(page);
  await watchTranscript(page);
  await emit(appendFrames(4));
  await settle(page);

  expect((await liveOutput(page)).length).toBeGreaterThan(grownAtTail);
  const scrolledUpTouched = await touched(page);
  expect(scrolledUpTouched.records).toBeGreaterThan(0);
  expect(scrolledUpTouched.outside).toEqual([]);
  expect(await scrollTop(page)).toBe(0);
  expect(opened.pageErrors).toEqual([]);
});

it("pauses the idle writing dots and runs them while an answer is written", async () => {
  const opened = await openPage();
  const { page } = opened;

  const idle = await page.evaluate(() => {
    const dot = document.querySelector(".message.writing.idle .writing-dots > span");
    return dot === null ? null : getComputedStyle(dot).animationPlayState;
  });
  expect(idle).toBe("paused");

  // The writing state lasts as long as one SSE frame does, so it is read where it
  // is guaranteed to be seen: a mutation observer runs between the task that
  // draws the writing row (`message_start`) and the task that ends it.
  await page.evaluate(() => {
    const states: string[] = [];
    (window as unknown as { __writingStates: string[] }).__writingStates = states;
    const container = document.getElementById("transcript");
    if (container === null) return;
    const observer = new MutationObserver(() => {
      const row = container.querySelector(".message.writing");
      if (row === null || row.classList.contains("idle")) return;
      const dot = row.querySelector(".writing-dots > span");
      if (dot === null) return;
      states.push(getComputedStyle(dot).animationPlayState);
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  });

  await send("a message whose answer turns the dots on");
  await page.waitForFunction(() => (window as unknown as { __writingStates?: string[] }).__writingStates?.length ?? 0, undefined, {
    timeout: 30000,
  });
  const states = await page.evaluate(() => (window as unknown as { __writingStates: string[] }).__writingStates);
  expect(states).toContain("running");

  await page.waitForSelector(".message.writing.idle", { state: "attached", timeout: 30000 });
  expect(opened.pageErrors).toEqual([]);
});
