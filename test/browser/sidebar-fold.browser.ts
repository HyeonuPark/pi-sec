/**
 * Folding a panel from its heading, in a real browser.
 *
 * The fold is a fact about what the page draws and what the server remembers:
 * the list goes away while the heading and its badges stay, the choice survives a
 * reload, `Tab` reaches the heading and `Enter` or `Space` presses it, and the
 * same works on a phone-width screen once the drawer is open. The choice is shared
 * state: one list for wide screens and one for narrow screens, kept on the server.
 * jsdom answers none of that: it applies no stylesheet, so it cannot say that a
 * list really left the screen, and it does not reload a page, so it cannot say
 * that the saved choice came back.
 *
 * So this file drives Chromium through Playwright against a real server on port 0.
 * The inbox notice and the job are real records, and the page reads them the way
 * it reads them in production.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import { createInboxItemTx } from "../../src/extensions/notify.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";

// Same library prefix and launch args as the other browser tests: Chromium needs
// X11/atk/gbm libraries that a minimal Linux image may not ship, and it may have no GPU.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

/** A phone's viewport, the width the drawer's breakpoint covers. */
const PHONE = { width: 390, height: 844 } as const;
/** A wide screen, where the sidebar is a column and is open at rest. */
const WIDE = { width: 1280, height: 900 } as const;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
/** The job the tree draws, so the Jobs panel has a row to fold away. */
let jobId = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const h = harness;

  const job = await h.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sidebar fold fixture" });
  jobId = job.id;
  // One notice, so the inbox draws a row and the unread count is `1`. The count is
  // what the folded heading has to keep saying.
  await h.runtime.harness.commit(
    (tx) =>
      createInboxItemTx(tx, {
        title: "Sidebar fold fixture",
        body: "the body of the notice",
        kind: "notice",
      }),
    BACKGROUND_CONTEXT,
  );

  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: h.runtime,
    bus: h.events,
    sse,
    streams: new StreamHub({ runtime: h.runtime, bus: h.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: builtWebDir(),
    adminState: { restart: h.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext();
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

/** The one browser context these cases share, which is where the store lives. */
function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

/** The shared state on the server, as the page reads it. */
async function serverFolds(): Promise<{ foldedWide?: string[]; foldedNarrow?: string[] }> {
  return (await (await fetch(`${origin}/api/preferences`)).json()) as { foldedWide?: string[]; foldedNarrow?: string[] };
}

/**
 * A chat page with nothing remembered, at the width the case asks for.
 *
 * The folds belong to the server and the cache to the browser, so a case that
 * folded a panel would decide what the next case finds. Both are emptied here,
 * before the reload that the case is judged on, so each case starts the way a
 * first visit does.
 */
async function openChat(viewport: { readonly width: number; readonly height: number } = WIDE): Promise<Page> {
  await fetch(`${origin}/api/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ foldedWide: [], foldedNarrow: [] }),
  });
  const page = await currentContext().newPage();
  await page.setViewportSize(viewport);
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: "load", timeout: 30000 });
  // Attached, not visible: on a phone-width screen the sidebar is a drawer that
  // starts closed, so its rows are drawn and off the screen until it opens.
  await page.waitForSelector("#inbox .inbox-item", { timeout: 30000, state: "attached" });
  await page.waitForSelector(`#jobs [data-job-id="${jobId}"]`, { timeout: 30000, state: "attached" });
  return page;
}

/** Whether an element takes room on the page, as the browser computed it. */
async function shown(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((wanted) => {
    const element = document.querySelector(wanted);
    if (element === null) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return element.getClientRects().length > 0;
  }, selector);
}

/** The browser's cache of the fold, which the page keeps beside the server's list. */
async function storedFolds(page: Page): Promise<string> {
  return page.evaluate(() => window.localStorage.getItem("pi-sec-folded-panels") ?? "");
}

/** Wait until the server holds the lists, which the page saves after it draws the fold. */
async function expectServerFolds(expected: { foldedWide?: string[]; foldedNarrow?: string[] }): Promise<void> {
  await expect
    .poll(async () => {
      const state = await serverFolds();
      return Object.fromEntries(Object.keys(expected).map((key) => [key, state[key as keyof typeof state]]));
    }, { timeout: 15000 })
    .toEqual(expected);
}

it("folds the inbox from its heading, and leaves the heading and its count", async () => {
  const page = await openChat();

  expect(await shown(page, "#inbox .inbox-item"), "the inbox row is drawn before the press").toBe(true);
  expect(await shown(page, "#inbox-count"), "the unread count is drawn before the press").toBe(true);

  await page.click("#inbox-fold");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });

  // The list left the screen, and the heading stayed with the count that is the
  // whole reason a folded inbox is worth having.
  expect(await shown(page, "#inbox .inbox-item")).toBe(false);
  expect(await shown(page, "#inbox-fold")).toBe(true);
  expect(await shown(page, "#inbox-count")).toBe(true);
  expect(await page.locator("#inbox-count").textContent()).toBe("1");
  // The caret says the same thing as `aria-expanded`: the triangle was turned to
  // point into the panel, and it is drawn rather than typed.
  expect(await page.evaluate(() => document.querySelector("#inbox-fold .panel-fold-caret path")?.getAttribute("d"))).toContain(
    "M4.5 2.5",
  );
  // `hide all` goes while the list it hides is out of sight.
  expect(await shown(page, "#inbox-hide-all")).toBe(false);
  // The choice reached the browser's cache and the server's list for wide screens.
  expect(await storedFolds(page)).toBe('["inbox"]');
  await expectServerFolds({ foldedWide: ["inbox"] });

  // One more press puts the row back.
  await page.click("#inbox-fold");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "true", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, "#inbox .inbox-item")).toBe(true);
  expect(await shown(page, "#inbox-hide-all")).toBe(true);
  expect(await storedFolds(page)).toBe("[]");

  await page.close();
});

it("folds the job tree from its heading, and keeps the fold across a reload", async () => {
  const page = await openChat();
  expect(await shown(page, `#jobs [data-job-id="${jobId}"]`)).toBe(true);

  await page.click("#jobs-fold");
  await page.waitForFunction(() => document.getElementById("jobs-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, `#jobs [data-job-id="${jobId}"]`)).toBe(false);
  expect(await shown(page, "#jobs-fold")).toBe(true);
  expect(await storedFolds(page)).toBe('["jobs"]');
  await expectServerFolds({ foldedWide: ["jobs"] });

  // A reload is a new page from the same browser: the fold has to come back. The
  // cache is emptied first, so what comes back can only have come from the server.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#jobs-fold", { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("jobs-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });
  await page.waitForSelector(`#jobs [data-job-id="${jobId}"]`, { timeout: 30000, state: "attached" });
  expect(await shown(page, `#jobs [data-job-id="${jobId}"]`), "the folded tree came back open").toBe(false);
  expect(await shown(page, "#inbox .inbox-item"), "the inbox was not folded and came back folded").toBe(true);

  await page.close();
});

it("reaches the heading with Tab, and presses it with Enter and with Space", async () => {
  const page = await openChat();

  // The operator's own way in: Tab from the top of the page until the heading
  // takes the focus. The loop is bounded, so a heading nothing can reach fails
  // the case instead of hanging it.
  const focusStops = 80;
  let reached = -1;
  for (let count = 1; count <= focusStops; count += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id ?? "");
    if (id === "inbox-fold") {
      reached = count;
      break;
    }
  }
  expect(reached, `the heading took no focus within ${focusStops} Tab presses`).toBeGreaterThan(0);

  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, "#inbox .inbox-item")).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.id), "the press moved the focus away").toBe("inbox-fold");

  await page.keyboard.press(" ");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "true", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, "#inbox .inbox-item")).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("inbox-fold");

  await page.close();
});

it("folds and unfolds inside the drawer on a phone-width screen", async () => {
  const page = await openChat(PHONE);

  // A drawer starts closed, so the heading is not on screen until the bar's
  // toggle opens it.
  await page.waitForFunction(() => document.body.dataset["sidebar"] === "closed", undefined, { timeout: 30000 });
  expect(await shown(page, "#inbox-fold")).toBe(false);

  await page.click("#sidebar-toggle");
  await page.waitForFunction(() => document.body.dataset["sidebar"] === "open", undefined, { timeout: 10000 });
  await page.waitForSelector("#inbox .inbox-item", { timeout: 30000 });
  expect(await shown(page, "#inbox-fold")).toBe(true);

  await page.click("#inbox-fold");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, "#inbox .inbox-item")).toBe(false);
  expect(await shown(page, "#inbox-fold")).toBe(true);
  expect(await shown(page, "#inbox-count")).toBe(true);
  expect(await storedFolds(page)).toBe('["inbox"]');
  // A phone-width screen saves into the narrow list and leaves the wide one alone.
  await expectServerFolds({ foldedNarrow: ["inbox"], foldedWide: [] });

  await page.click("#inbox-fold");
  await page.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "true", undefined, {
    timeout: 10000,
  });
  expect(await shown(page, "#inbox .inbox-item")).toBe(true);

  await page.close();
});
