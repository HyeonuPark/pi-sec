/**
 * The `Load previous session` button in a real browser.
 *
 * jsdom can be told that a scroll happened, but it cannot say what a scroll is: a
 * scroll position is a layout number, and jsdom lays nothing out. Two claims about
 * this button are layout claims, so they are made here against a real Chromium and
 * a real server on port 0:
 *
 * - A press brings the session before the one on screen, and a second press brings
 *   the one before that. A third has nothing left, so the button goes away.
 * - The row the reader was on before the press is on screen after it, in the same
 *   place: rows are added above them, and the pane holds its distance from the
 *   foot instead of its scroll offset.
 *
 * The conversation is built through the store and not through the model: the
 * entries are what the transcript draws, and no answer is needed to draw them.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryDraft } from "@earendil-works/pi-durable";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

// Same library prefix and launch args as the other browser tests: Chromium needs
// X11/atk/gbm libraries that a minimal Linux image may not ship, and it may have no GPU.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One operator message, inside the envelope the server writes. */
function operatorMessage(body: string): EntryDraft {
  return {
    kind: "pi.user",
    model: [{ role: "user", content: `<pi-message src="operator">\n${body}\n</pi-message>`, timestamp: Date.now() }],
  };
}

/** One answer. */
function assistantMessage(body: string): EntryDraft {
  return {
    kind: "pi.assistant",
    model: [{ role: "assistant", content: [{ type: "text", text: body }], timestamp: Date.now() }],
  };
}

/** One session restart. */
function restart(handoff: string): EntryDraft {
  return { kind: "pi.reset", head: "self", model: [{ role: "user", content: handoff, timestamp: Date.now() }] };
}

/** One session's worth of conversation: enough rows to fill more than the pane. */
function session(test: TestHarness, conversationId: number, name: string, turns: number): Promise<void> {
  return (async () => {
    for (let turn = 0; turn < turns; turn += 1) {
      await append(test, conversationId, operatorMessage(`${name} question ${turn + 1}`));
      await append(test, conversationId, assistantMessage(`${name} answer ${turn + 1}, long enough to take a line of the pane.`));
    }
  })();
}

/** One entry appended to one conversation, without running the model. */
async function append(test: TestHarness, conversationId: number, entry: EntryDraft): Promise<void> {
  await test.runtime.harness.commit(async (tx) => {
    await tx.appendEntry(conversationId as ConversationId, entry);
  }, BACKGROUND_CONTEXT);
}

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

  // Three sessions: the oldest has no restart of its own, because a conversation
  // begins in one.
  const root = 1;
  await session(harness, root, "oldest", 6);
  await append(harness, root, restart("handoff one"));
  await session(harness, root, "middle", 6);
  await append(harness, root, restart("handoff two"));
  await session(harness, root, "newest", 6);

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 900, height: 420 } });
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

/** Two frames: long enough for a scroll the page sets to be laid out. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** How many rows the transcript has drawn. */
function rowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
}

/** How many `new session` dividers the transcript has drawn. */
function dividerCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("#transcript > .divider").length);
}

async function waitForRows(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#transcript > [data-row-key]").length >= expected,
    count,
    { timeout: 30000 },
  );
  await settle(page);
}

/** Wait until the page has drawn one more `new session` line than it had. */
async function waitForDividers(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#transcript > .divider").length >= expected,
    count,
    { timeout: 30000 },
  );
  await settle(page);
}

/** The button's own element, or a failure that names what is missing. */
async function buttonHandle(page: Page) {
  const button = await page.$(".load-earlier-button");
  if (button === null) throw new Error("the page drew no Load previous session button");
  return button;
}

/**
 * Put the pane at a place that is neither its top nor its tail, and wait until the
 * page has seen the scroll.
 *
 * The page decides whether it follows the tail from the pane's `scroll` event, so
 * a scroll that the page has not seen yet would be followed as if the reader were
 * at the foot. Waiting for the event leaves the state a scroll by hand leaves.
 */
async function scrollPaneTo(page: Page, top: number): Promise<number> {
  return await page.evaluate(async (wanted) => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    const seen = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        pane.removeEventListener("scroll", finish);
        resolve();
      };
      pane.addEventListener("scroll", finish, { once: true });
      timer = setTimeout(finish, 500);
    });
    pane.scrollTop = wanted;
    await seen;
    return pane.scrollTop;
  }, top);
}

/**
 * The row the reader is looking at, and where it sits in the pane.
 *
 * The row is the first one whose top is inside the pane's visible box and which is
 * not the writing row, and its distance from the top of that box is what a press
 * must not change.
 */
function readingPlace(page: Page): Promise<{ key: string; top: number; text: string }> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    const box = pane.getBoundingClientRect();
    for (const row of document.querySelectorAll<HTMLElement>("#transcript > [data-row-key]")) {
      const rect = row.getBoundingClientRect();
      if (rect.height === 0) continue;
      if (rect.top < box.top - 1 || rect.top > box.bottom) continue;
      return { key: row.dataset["rowKey"] ?? "", top: rect.top - box.top, text: (row.textContent ?? "").trim().slice(0, 40) };
    }
    throw new Error("no row is on screen");
  });
}

/** Where one row sits from the top of the pane now, or `null` when it is gone. */
function rowTop(page: Page, key: string): Promise<number | null> {
  return page.evaluate((wanted) => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    const row = document.querySelector<HTMLElement>(`#transcript > [data-row-key="${wanted}"]`);
    if (row === null) return null;
    return row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, key);
}

it("brings two earlier sessions one press each, then takes its own button away", async () => {
  const page = await currentContext().newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await waitForRows(page, 2);

  // The page opens on the newest session, and one press is one session.
  expect(await dividerCount(page)).toBe(1);
  const rowsBefore = await rowCount(page);
  await (await buttonHandle(page)).click();
  await waitForDividers(page, 2);
  await page.waitForFunction((before) => document.querySelectorAll("#transcript > [data-row-key]").length > before, rowsBefore, {
    timeout: 30000,
  });
  expect(await dividerCount(page)).toBe(2);
  expect(await page.$(".load-earlier-button")).not.toBeNull();

  // The second press brings the oldest session, which has no restart of its own to
  // draw, so the button is gone and the transcript holds the whole conversation.
  const afterFirst = await rowCount(page);
  await (await buttonHandle(page)).click();
  await page.waitForFunction((before) => document.querySelectorAll("#transcript > [data-row-key]").length > before, afterFirst, {
    timeout: 30000,
  });
  await settle(page);
  // The oldest session began with the conversation itself, so it brings no restart
  // of its own: the count of `new session` lines stays where it was.
  expect(await dividerCount(page)).toBe(2);
  // Nothing is stored before it, so the button is gone and the transcript holds the
  // whole conversation.
  await page.waitForFunction(() => document.querySelector(".load-earlier-button") === null, undefined, { timeout: 30000 });
  expect(await page.$(".load-earlier-button")).toBeNull();

  await page.close();
});

it("holds the reader's place when a session is added above them", async () => {
  const page = await currentContext().newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await waitForRows(page, 2);
  // The rest of a long first paint is drawn when the browser is idle; the press is
  // about a list that is already drawn, so the test waits for it.
  await wait(500);
  await settle(page);

  const paneFacts = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    return { scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
  });
  expect(paneFacts.scrollHeight).toBeGreaterThan(paneFacts.clientHeight);

  // Scrolled up, which is the reader this test is about: the button is at the top
  // and the row they are reading is in the middle of the pane.
  const scrolledTo = await scrollPaneTo(page, 120);
  expect(scrolledTo).toBe(120);
  const reading = await readingPlace(page);
  expect(reading.key).not.toBe("load-earlier");

  const dividers = await dividerCount(page);
  await (await buttonHandle(page)).click();
  await waitForDividers(page, dividers + 1);
  await settle(page);
  await wait(200);
  await settle(page);

  // Same row, same place in the pane: rows were added above it and the pane held
  // its distance from the foot rather than its scroll offset.
  const after = await rowTop(page, reading.key);
  expect(after).not.toBeNull();
  // The row is where it was, up to the width of a line: the pages holds its
  // distance from the foot, which is the device the rest of the first paint uses
  // for the same reason, and the last few pixels come from rows whose height
  // `content-visibility` was still estimating when the draw landed.
  expect(Math.abs((after ?? 0) - reading.top)).toBeLessThanOrEqual(24);
  // And the reader's scroll offset really did move, which is what "added above"
  // means: the number in `scrollTop` is not the row it named before.
  const moved = await page.evaluate(() => document.querySelector<HTMLElement>(".transcript-pane")?.scrollTop ?? 0);
  expect(moved).toBeGreaterThan(scrolledTo);

  await page.close();
});
