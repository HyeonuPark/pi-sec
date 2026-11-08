/**
 * A conversation stream that breaks, in a real browser.
 *
 * jsdom can be told that an `EventSource` is CLOSED. Whether Chromium really
 * gives up on a stream after a 502, and whether the page really opens another one
 * and draws what it missed, is a browser fact, so it is pinned here against a real
 * server on port 0.
 *
 * The two facts: a stream the server dropped and a proxy answered with 502 leaves
 * the page to open a new one, which draws an entry appended while it was down; and
 * a page hidden for 30 s or more opens a new stream when it comes back, which
 * arrives as a snapshot and is what re-reads the lists.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
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

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 1000, height: 800 } });

  // The root conversation is created by the first message, and the page's stream
  // attaches to it. Filling it first means the page opens on a transcript rather
  // than on the 503 a conversation-less boot answers.
  await send("hello, this is the first message of the reconnect test");
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

function currentServer(): StartedServer {
  if (started === undefined) throw new Error("the server is not running");
  return started;
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

/** One user turn, and the one faux answer it gets. */
async function send(content: string): Promise<void> {
  if (harness === undefined) throw new Error("the harness is not running");
  harness.faux.setResponses([(async () => fauxAssistantMessage([fauxText("ok")])) as never]);
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

/** A page on the root conversation, with the URLs it asks the server for. */
interface WatchedPage {
  readonly page: Page;
  /** Every request URL the page made, in order. */
  readonly requests: string[];
  readonly pageErrors: string[];
}

async function openPage(): Promise<WatchedPage> {
  const page = await currentContext().newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  // The first snapshot is drawn: the greeting and the answer are both on screen.
  await page.waitForFunction(() => document.querySelectorAll("#transcript > [data-row-key]").length >= 2, undefined, {
    timeout: 30000,
  });
  return { page, requests, pageErrors };
}

const countOf = (requests: string[], needle: string) => requests.filter((url) => url.includes(needle)).length;

/** Wait until the transcript shows one string, or throw with what it does show. */
async function waitForText(page: Page, text: string, timeoutMs = 30000): Promise<void> {
  try {
    await page.waitForFunction(
      (wanted) => (document.getElementById("transcript")?.textContent ?? "").includes(wanted),
      text,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const shown = await page.evaluate(() => document.getElementById("transcript")?.textContent ?? "");
    throw new Error(`the transcript never showed "${text}". It showed: ${shown.slice(0, 600)}`);
  }
}

it("opens a new stream after a 502 and draws an entry appended while it was down", async () => {
  const watched = await openPage();
  const { page, requests } = watched;
  // A mark that a reload would erase: the page must recover in place.
  await page.evaluate(() => {
    (window as unknown as { __noReloadMark?: number }).__noReloadMark = 1;
  });

  // Only the reconnects are intercepted, so the stream the page already holds is
  // the server's own. The next attempt is answered the way a proxy's error page
  // answers it, which is the case Chromium gives up on.
  let failNext = 1;
  await page.route("**/basic-chat/events*", async (route) => {
    if (failNext > 0) {
      failNext -= 1;
      await route.fulfill({ status: 502, contentType: "text/plain", body: "bad gateway" });
      return;
    }
    await route.continue();
  });

  const streamRequests = countOf(requests, "/basic-chat/events");
  expect(streamRequests).toBe(1);

  // The server drops the live stream, and an entry is committed while nothing is
  // listening on this page.
  currentServer().server.closeAllConnections();
  await wait(300);
  await send("the line sent while the stream was down");

  // The browser will not retry a stream answered with 502, so a page that draws
  // this line has opened a stream of its own and drawn the snapshot it got.
  await waitForText(page, "the line sent while the stream was down", 40000);
  expect(countOf(requests, "/basic-chat/events")).toBeGreaterThan(streamRequests);
  const marked = await page.evaluate(() => (window as unknown as { __noReloadMark?: number }).__noReloadMark);
  expect(marked).toBe(1);
  expect(watched.pageErrors).toEqual([]);
});

it("opens a new stream when a page hidden for 30 s comes back", async () => {
  const watched = await openPage();
  const { page, requests } = watched;
  const streamRequests = countOf(requests, "/basic-chat/events");
  const inboxReads = countOf(requests, "/api/inbox");
  expect(inboxReads).toBe(1);

  // Hidden, with the page's own clock wrapped so the 30 s can pass in a step: a
  // frozen timer is what a phone gives a background page, so the page has to
  // measure the time away from the clock.
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

  // An entry committed while the page was hidden. It is on screen either way, but
  // the reads below only happen for a snapshot, which only a new stream sends.
  await send("the line sent while the page was hidden");
  await wait(500);

  await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(31_000));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // The stream is opened again, and the snapshot it arrives with re-reads the
  // lists that changed while the page was away.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (countOf(requests, "/api/inbox") >= inboxReads + 1) break;
    await wait(100);
  }
  expect(countOf(requests, "/basic-chat/events")).toBeGreaterThan(streamRequests);
  expect(countOf(requests, "/api/inbox")).toBeGreaterThan(inboxReads);
  await waitForText(page, "the line sent while the page was hidden");
  expect(watched.pageErrors).toEqual([]);
});
