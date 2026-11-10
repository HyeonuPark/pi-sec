/**
 * What the operator made with their hands survives a screen update, in a real
 * browser.
 *
 * jsdom can be told that a scroll happened. It cannot say what a scroll is: a
 * scroll position is a layout number, and jsdom lays nothing out, so
 * `scrollTop` there is a value the test set on an element that has no place to
 * scroll to. The same goes for a Korean composition: an input method is a
 * browser feature, and a caret placed by one is not something a synthetic
 * `Event` can imitate.
 *
 * So each place where a screen update could reset the reader's work is driven here against a real
 * Chromium and a real server on port 0, with the update that reaches it produced
 * by the server and not by the page: a message sent to the conversation, a
 * second revision of the report, a job created through the API, the usage page's
 * own reload press, the conversation stream while a Korean word is being
 * composed, and the model login poll that repeats its question once a second.
 *
 * The assertion is the same shape everywhere: the reading place the operator
 * left, read before the update, is the reading place after it.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createInboxItemTx } from "../../src/extensions/notify.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";

/** Distance from the tail that still counts as "following along"; the page's own slack. */
const BOTTOM_SLACK_PX = 24;

/**
 * The process's one model login, as this file needs it.
 *
 * The daemon's service drives a provider's real login flow, which no test can
 * ask for: the flow needs a browser sign-in, or a key nobody has. So the service
 * is replaced before the routes are registered, and it answers the shape the
 * routes and the page agree on. It asks the same question for as long as it
 * runs, which is the case the page's answer field has to survive, and it counts
 * its reads so a test can wait for the poll that follows the first one.
 */
interface FakeLogin {
  readonly available: boolean;
  polls: number;
  providers(): {
    readonly available: boolean;
    readonly providers: readonly Record<string, unknown>[];
    readonly sessionActive: boolean;
  };
  start(provider: string, type: string): { readonly ok: true; readonly session: string; readonly state: Record<string, unknown> };
  state(session: string): Record<string, unknown> | undefined;
  answer(session: string, value: string): { readonly ok: true; readonly state: Record<string, unknown> };
  cancel(session: string): { readonly ok: true; readonly state: Record<string, unknown> };
}

/** The question the fake login waits on, and the state it answers with. */
const LOGIN_SESSION = "reset-test-session";
const LOGIN_QUESTION = "Paste the API key the provider gave you";

function createFakeLogin(): FakeLogin {
  const startedAt = new Date().toISOString();
  /** One state, with one more line of progress per read: the question never changes. */
  const stateAt = (polls: number): Record<string, unknown> => ({
    status: "prompt",
    provider: "anthropic",
    type: "api_key",
    prompt: { type: "secret", message: LOGIN_QUESTION, placeholder: "sk-…" },
    events: Array.from({ length: polls }, (_, index) => ({ type: "info", message: `still waiting, line ${index + 1}` })),
    startedAt,
    finishedAt: null,
    loginAt: null,
    reason: null,
    warning: null,
  });
  const fake: FakeLogin = {
    available: true,
    polls: 0,
    providers: () => ({
      available: true,
      // The provider the form has to offer before it can be started at all.
      providers: [{ id: "anthropic", extension: null, configured: true, types: ["api_key", "oauth"], lastLogin: null }],
      sessionActive: false,
    }),
    start: (provider) => ({ ok: true, session: LOGIN_SESSION, state: { ...stateAt(0), provider, type: "api_key" } }),
    state: (session) => {
      if (session !== LOGIN_SESSION) return undefined;
      fake.polls += 1;
      return stateAt(fake.polls);
    },
    answer: (session, value) => {
      void value;
      return { ok: true, state: { ...stateAt(fake.polls), status: "succeeded", prompt: null, loginAt: startedAt, finishedAt: startedAt } };
    },
    cancel: (session) => ({ ok: true, state: { ...stateAt(fake.polls), status: "cancelled", prompt: null } }),
  };
  return fake;
}

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
const login = createFakeLogin();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  // Before `startServer`, because the login routes take the service when they are
  // registered: a replacement afterwards is a service no route reads.
  (harness.runtime as unknown as { modelLogin: FakeLogin }).modelLogin = login;

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

  // The root conversation exists after one message, and the page's stream then
  // attaches to a transcript rather than to the 503 a conversation-less boot
  // answers.
  await send("the first message of the reset tests");
  await waitForContextUsed();

  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1000, height: 400 } });
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

async function post(path: string, body: unknown): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** One user turn, and the one faux answer it gets. */
async function send(content: string): Promise<void> {
  if (harness === undefined) throw new Error("the harness is not running");
  harness.faux.setResponses([(async () => fauxAssistantMessage([fauxText("ok")])) as never]);
  const response = await post("/basic-chat/messages", { content });
  if (!response.ok) throw new Error(`/basic-chat/messages answered ${response.status}: ${await response.text()}`);
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

/** Two frames: long enough for a scroll the page sets to be laid out. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** The conversation page, open on a transcript with two rows in it. */
async function openChat(): Promise<Page> {
  const page = await currentContext().newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await waitForRows(page, 2);
  return page;
}

async function waitForRows(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#transcript > [data-row-key]").length >= expected,
    count,
    { timeout: 30000 },
  );
  await settle(page);
}

/** The pane's scroll offset, and how far it is from its tail. */
function paneFacts(page: Page): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane === null) throw new Error("no transcript pane");
    return { scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
  });
}

/**
 * How long the test waits for the pane's `scroll` event before it gives up on it.
 *
 * A pane already at the offset asked for fires no scroll, so the event alone cannot
 * be the way out. Chromium dispatches a scroll on the next frame, well inside this.
 */
const SCROLL_EVENT_TIMEOUT_MS = 500;

/**
 * Put the pane at a place that is neither its top nor its tail, and wait until the
 * page has seen the scroll.
 *
 * The page decides whether it follows the tail from the pane's `scroll` event and
 * not from the offset, so an entry that lands between the assignment and the event
 * is drawn for a reader the page still believes is at the tail. Waiting for the
 * event here leaves the state a scroll by hand would leave: the test then reads the
 * place of a reader who scrolled, which is the reader this test is about.
 */
async function scrollPaneTo(page: Page, top: number): Promise<number> {
  return await page.evaluate(
    async ({ wanted, timeoutMs }) => {
      const pane = document.querySelector<HTMLElement>(".transcript-pane");
      if (pane === null) throw new Error("no transcript pane");
      // Registered before the offset moves: the event can arrive after a frame, and
      // the page's own listener was registered before this one, so it has run by the
      // time this promise settles.
      const seen = new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          pane.removeEventListener("scroll", finish);
          resolve();
        };
        pane.addEventListener("scroll", finish, { once: true });
        timer = setTimeout(finish, timeoutMs);
      });
      pane.scrollTop = wanted;
      await seen;
      return pane.scrollTop;
    },
    { wanted: top, timeoutMs: SCROLL_EVENT_TIMEOUT_MS },
  );
}

/**
 * Hide the page for longer than the stream's return window, then show it again.
 *
 * A hidden page is given no new stream, and a page that comes back after thirty
 * seconds opens one: the snapshot that stream arrives with is the whole state,
 * which is the update this asks the page to survive.
 */
async function hideAndReturn(page: Page, awayMs: number): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    Date.now = () => realNow() + offsetMs;
    (window as unknown as { __advance: (ms: number) => void }).__advance = (ms) => {
      offsetMs += ms;
    };
  });
  await wait(200);
  await page.evaluate((ms) => (window as unknown as { __advance: (ms: number) => void }).__advance(ms), awayMs);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// ---------------------------------------------------------------------------

it("holds the reader's place in the transcript when an entry lands and when the stream returns", async () => {
  const page = await currentContext().newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await waitForRows(page, 2);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  // A transcript longer than the pane, made one turn at a time so every entry is
  // an ordinary frame of the live stream.
  for (let turn = 0; turn < 6; turn += 1) {
    await send(`question ${turn + 1}, written long enough to take a few lines of the pane`);
    await waitForRows(page, 4 + turn * 2);
  }

  const beforeEntry = await paneFacts(page);
  expect(beforeEntry.scrollHeight).toBeGreaterThan(beforeEntry.clientHeight);
  // Scrolled up, which is the reader this test is about.
  const readingAt = await scrollPaneTo(page, 200);
  expect(readingAt).toBe(200);

  const rows = await page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
  await send("a message that lands while the reader is reading above");
  await waitForRows(page, rows + 2);
  expect((await paneFacts(page)).scrollTop).toBe(200);

  // The stream goes away and comes back, and the whole state arrives with it.
  const streams = requests.filter((url) => url.includes("/basic-chat/events")).length;
  await hideAndReturn(page, 31_000);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (requests.filter((url) => url.includes("/basic-chat/events")).length > streams) break;
    await wait(100);
  }
  expect(requests.filter((url) => url.includes("/basic-chat/events")).length).toBeGreaterThan(streams);
  await wait(500);
  await settle(page);
  expect((await paneFacts(page)).scrollTop).toBe(200);

  // At the tail, the same arrival is followed instead: that is what the page does
  // for a reader who never scrolled up.
  await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane");
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  });
  await settle(page);
  const atTail = await page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
  await send("a message that lands while the reader is at the tail");
  await waitForRows(page, atTail + 2);
  const tail = await paneFacts(page);
  expect(tail.scrollHeight - tail.scrollTop - tail.clientHeight).toBeLessThanOrEqual(BOTTOM_SLACK_PX);

  // Scrolled all the way up, the same arrival must not pull the reader down either.
  expect(await scrollPaneTo(page, 0)).toBe(0);
  const atTop = await page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
  await send("a message that lands while the reader is at the very top");
  await waitForRows(page, atTop + 2);
  expect((await paneFacts(page)).scrollTop).toBe(0);
  expect(pageErrors).toEqual([]);
  await page.close();
});

it("keeps the report panel's body where the reader left it, and the words they selected", async () => {
  if (harness === undefined) throw new Error("the harness is not running");
  const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "reset fixture job" });
  const body = Array.from({ length: 40 }, (_, index) => `paragraph ${index} of the report, long enough to wrap a line`).join("\n\n");
  const report = await harness.runtime.reports.create(BACKGROUND_CONTEXT, {
    jobId: job.id,
    title: "Reset fixture",
    content: `# Reset fixture\n\n${body}\n`,
  });
  await harness.runtime.harness.commit(
    (tx) =>
      createInboxItemTx(tx, {
        title: `Report published: ${report.title}`,
        body: "the notice body",
        kind: "report",
        reportId: report.id,
        reportEvent: "published",
        jobId: job.id,
      }),
    BACKGROUND_CONTEXT,
  );

  const page = await openChat();
  // The inbox notice is the way into the panel: it is what the operator presses.
  await page.waitForSelector("#inbox .inbox-title", { timeout: 30000 });
  await page.click("#inbox .inbox-title");
  await page.waitForSelector("#report-pane-body p", { timeout: 30000 });
  await wait(300);

  const before = await page.evaluate(() => {
    const pane = document.getElementById("report-pane-body");
    if (pane === null) throw new Error("no report pane body");
    pane.scrollTop = 200;
    const node = pane.querySelector("p")?.firstChild ?? null;
    if (node !== null) {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 9);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return {
      scrollTop: pane.scrollTop,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      selection: window.getSelection()?.toString() ?? "",
      html: pane.innerHTML,
    };
  });
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  expect(before.scrollTop).toBe(200);
  expect(before.selection).toBe("paragraph");

  // A second revision lands. It carries the same prose, so what the frame changes
  // is the record around the body — the revision number in the meta line.
  const revision = await post(`/api/reports/${report.id}/versions`, { content: `# Reset fixture\n\n${body}\n` });
  expect(revision.status).toBe(201);
  await page.waitForFunction(() => (document.getElementById("report-pane-meta")?.textContent ?? "").startsWith("v2"), undefined, {
    timeout: 30000,
  });
  await settle(page);

  const after = await page.evaluate(() => {
    const pane = document.getElementById("report-pane-body");
    if (pane === null) throw new Error("no report pane body");
    return {
      scrollTop: pane.scrollTop,
      selection: window.getSelection()?.toString() ?? "",
      html: pane.innerHTML,
    };
  });
  expect(after.scrollTop).toBe(200);
  expect(after.selection).toBe("paragraph");
  // The prose was not drawn again, which is what keeps the selection alive.
  expect(after.html).toBe(before.html);
  await page.close();
});

it("keeps the work panel where the reader left it when a job event arrives", async () => {
  if (harness === undefined) throw new Error("the harness is not running");
  // A list taller than the panel, so there is a place to scroll to.
  for (let index = 0; index < 30; index += 1) {
    await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: `long list job ${index}` });
  }

  const page = await openChat();
  await page.waitForSelector("#jobs .job-row", { timeout: 30000 });
  const before = await page.evaluate(() => {
    const sidebar = document.getElementById("sidebar");
    if (sidebar === null) throw new Error("no work panel");
    sidebar.scrollTop = 300;
    return {
      scrollTop: sidebar.scrollTop,
      scrollHeight: sidebar.scrollHeight,
      clientHeight: sidebar.clientHeight,
      rows: sidebar.querySelectorAll("#jobs .job-row").length,
    };
  });
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  expect(before.scrollTop).toBe(300);

  // A job created through the API, which is the frame the panel reads its tree back for.
  const created = await post("/api/jobs", { title: "a job created while the list is scrolled" });
  expect(created.status).toBe(201);
  await page.waitForFunction(
    (count) => document.querySelectorAll("#jobs .job-row").length > count,
    before.rows,
    { timeout: 30000 },
  );
  await settle(page);

  const after = await page.evaluate(() => (document.getElementById("sidebar") as HTMLElement | null)?.scrollTop);
  expect(after).toBe(300);
  await page.close();
});

it("keeps the usage page where the reader left it across its own reload", async () => {
  const page = await currentContext().newPage();
  await page.setViewportSize({ width: 800, height: 300 });
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/usage")) reads.push(request.url());
  });
  await page.goto(`${origin}/usage`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#usage-cards article.usage-card").length >= 1, undefined, {
    timeout: 30000,
  });
  await wait(500);

  const before = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".usage-scroll");
    if (scroller === null) throw new Error("no usage scroll area");
    scroller.scrollTop = 120;
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  });
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  expect(before.scrollTop).toBe(120);

  const readsBefore = reads.length;
  await page.click("#reload-usage");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (reads.length > readsBefore) break;
    await wait(50);
  }
  expect(reads.length).toBeGreaterThan(readsBefore);
  await wait(300);
  await settle(page);

  const after = await page.evaluate(() => (document.querySelector(".usage-scroll") as HTMLElement | null)?.scrollTop);
  expect(after).toBe(120);
  await page.close();
});

it("keeps a Korean composition and its caret while the conversation moves, and sends no composing Enter", async () => {
  const page = await openChat();
  const sends: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/basic-chat/messages")) sends.push(request.url());
  });

  const cdp = await currentContext().newCDPSession(page);
  await page.click("#message");
  // An input method is composing "안녕", with the caret after it. Only the browser
  // has this state, which is why this test is a browser test.
  await cdp.send("Input.imeSetComposition", { text: "안녕", selectionStart: 2, selectionEnd: 2 });
  expect(await fieldFacts(page)).toEqual({ value: "안녕", start: 2, end: 2, focused: true });

  // A press of Enter that arrives while the word is still being composed. Enter is
  // how a Korean reader accepts the word, so the page must not send anything.
  const sendsBefore = sends.length;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await wait(600);
  expect(sends.length).toBe(sendsBefore);
  expect((await fieldFacts(page)).value).toBe("안녕");

  // The stream moves under the composition: an answer is written into the
  // transcript while the word is being composed.
  await cdp.send("Input.imeSetComposition", { text: "안녕하세요", selectionStart: 5, selectionEnd: 5 });
  expect((await fieldFacts(page)).value).toBe("안녕하세요");
  const rows = await page.evaluate(() => document.querySelectorAll("#transcript > [data-row-key]").length);
  await send("a message that arrives while someone is composing");
  await waitForRows(page, rows + 2);

  expect(await fieldFacts(page)).toEqual({ value: "안녕하세요", start: 5, end: 5, focused: true });
  await page.close();
});

/** What the composer's field holds, where its caret is, and whether it is the focused element. */
function fieldFacts(page: Page): Promise<{ value: string; start: number; end: number; focused: boolean }> {
  return page.evaluate(() => {
    const field = document.getElementById("message") as HTMLTextAreaElement | null;
    if (field === null) throw new Error("no composer field");
    return {
      value: field.value,
      start: field.selectionStart,
      end: field.selectionEnd,
      focused: document.activeElement === field,
    };
  });
}
