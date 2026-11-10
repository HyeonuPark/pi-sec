/**
 * The shared UI state across machines, in a real browser.
 *
 * Two machines are two browser contexts: each has its own `localStorage` and its
 * own pages, and they meet only at the server. A third context has a phone-width
 * screen. The cases check what jsdom cannot: that a press in one context reaches
 * an open page in another without a reload, that the page paints the shared theme
 * from the HTML it was served, that a phone is left alone by a fold on a computer,
 * and that an old tab cannot undo what another machine did.
 *
 * The server is a test server on port 0 with a harness of its own. Nothing here
 * talks to a running daemon.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import { createInboxItemTx } from "../../src/extensions/notify.ts";
import type { StartedServer } from "../../src/server/server.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";
import { startTestServer } from "../server-helpers.ts";

const PHONE = { width: 390, height: 844 } as const;
const WIDE = { width: 1280, height: 900 } as const;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let machineA: BrowserContext | undefined;
let machineB: BrowserContext | undefined;
let phone: BrowserContext | undefined;
let origin = "";
let firstJob = "";
let secondJob = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const h = harness;
  // Two finished jobs, so each has a chip that clears it off the list.
  const first = await h.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sync fixture one" });
  const second = await h.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sync fixture two" });
  await h.runtime.jobs.update(BACKGROUND_CONTEXT, first.id, { status: "done" });
  await h.runtime.jobs.update(BACKGROUND_CONTEXT, second.id, { status: "done" });
  firstJob = first.id;
  secondJob = second.id;
  await h.runtime.harness.commit(
    (tx) => createInboxItemTx(tx, { title: "Sync fixture", body: "the body of the notice", kind: "notice" }),
    BACKGROUND_CONTEXT,
  );

  started = await startTestServer(h, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await launchChromium({ singleProcess: false });
  machineA = await browser.newContext({ viewport: WIDE });
  machineB = await browser.newContext({ viewport: WIDE });
  phone = await browser.newContext({ viewport: PHONE });
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/** Put the shared state back to a first visit, through the server, as the page would. */
beforeEach(async () => {
  const response = await fetch(`${origin}/api/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      theme: "auto",
      foldedWide: [],
      foldedNarrow: [],
      hiddenJobs: [],
      revertQueueJobs: [],
      collapsedJobs: [],
    }),
  });
  expect(response.status).toBe(200);
});

function context(which: BrowserContext | undefined): BrowserContext {
  if (which === undefined) throw new Error("chromium is not running");
  return which;
}

/** A chat page in one context, once the lists are drawn. */
async function openChat(which: BrowserContext | undefined, options: { blockStream?: boolean } = {}): Promise<Page> {
  const page = await context(which).newPage();
  if (options.blockStream === true) await page.route("**/basic-chat/events", (route) => route.abort());
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#inbox .inbox-item", { timeout: 30000, state: "attached" });
  await page.waitForSelector(`#jobs [data-job-id="${firstJob}"]`, { timeout: 30000, state: "attached" });
  return page;
}

/** Count the saves a page sends from now on. */
function countSaves(page: Page): { readonly count: () => number } {
  let saves = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/api/preferences")) saves += 1;
  });
  return { count: () => saves };
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset["theme"]);

async function waitForTheme(page: Page, mode: string): Promise<void> {
  await page.waitForFunction((wanted) => document.documentElement.dataset["theme"] === wanted, mode, { timeout: 15000 });
}

async function bodyFolds(page: Page): Promise<string> {
  return page.evaluate(() => document.body.dataset["folded"] ?? "");
}

async function serverState(): Promise<Record<string, unknown>> {
  return (await (await fetch(`${origin}/api/preferences`)).json()) as Record<string, unknown>;
}

it("shows a theme pressed on one machine on the open page of another, without a reload and without a save", async () => {
  const a = await openChat(machineA);
  const b = await openChat(machineB);
  const saves = countSaves(b);
  expect(await theme(b)).toBe("auto");

  await a.click("#theme-toggle");
  await waitForTheme(a, "light");
  await waitForTheme(b, "light");
  expect(await b.locator("#theme-toggle").textContent()).toBe("◐ light");

  // Applying the answer is not a press: B sent nothing back, so the two pages
  // cannot start a loop.
  await b.waitForTimeout(500);
  expect(saves.count()).toBe(0);
  expect((await serverState())["theme"]).toBe("light");

  await a.close();
  await b.close();
});

it("folds the inbox on every wide screen and leaves a phone-width screen alone", async () => {
  const a = await openChat(machineA);
  const b = await openChat(machineB);
  const p = await openChat(phone);
  expect(await bodyFolds(b)).toBe("");

  await a.click("#inbox-fold");
  await a.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 10000,
  });
  await b.waitForFunction(() => document.getElementById("inbox-fold")?.getAttribute("aria-expanded") === "false", undefined, {
    timeout: 15000,
  });
  expect(await bodyFolds(b)).toBe("inbox");
  // The phone heard the same event and drew its own list, which holds nothing.
  await p.waitForTimeout(500);
  expect(await bodyFolds(p)).toBe("");
  const state = await serverState();
  expect(state["foldedWide"]).toEqual(["inbox"]);
  expect(state["foldedNarrow"]).toEqual([]);

  await a.close();
  await b.close();
  await p.close();
});

it("takes a job cleared on one machine off the list of the other", async () => {
  const a = await openChat(machineA);
  const b = await openChat(machineB);
  const saves = countSaves(b);

  await a.click(`#jobs [data-job-id="${firstJob}"] [data-hide-job]`);
  await b.waitForSelector(`#jobs [data-job-id="${firstJob}"]`, { state: "detached", timeout: 15000 });
  expect(await b.locator(`#jobs [data-job-id="${secondJob}"]`).count()).toBe(1);
  await b.waitForTimeout(500);
  expect(saves.count()).toBe(0);

  await a.close();
  await b.close();
});

it("keeps a folded job group folded across a reload, on every machine", async () => {
  const parent = await harness!.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sync fixture group" });
  await harness!.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sync fixture child", parentId: parent.id });
  const a = await openChat(machineA);
  const b = await openChat(machineB);
  const chip = `#jobs [data-job-id="${parent.id}"] [data-toggle-children]`;
  await b.waitForSelector(chip, { timeout: 30000 });

  await a.click(chip);
  await b.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("aria-expanded") === "false",
    chip,
    { timeout: 15000 },
  );
  await b.reload({ waitUntil: "load", timeout: 30000 });
  await b.waitForSelector(chip, { timeout: 30000 });
  expect(await b.locator(chip).getAttribute("aria-expanded")).toBe("false");

  await a.close();
  await b.close();
});

it("updates a page without a stream when the tab is shown again, and paints the shared theme from the served page", async () => {
  const a = await openChat(machineA);
  const usage = await context(machineB).newPage();
  await usage.goto(`${origin}/usage`, { waitUntil: "load", timeout: 30000 });
  await usage.waitForSelector("#theme-toggle", { timeout: 30000 });
  expect(await theme(usage)).toBe("auto");

  await a.click("#theme-toggle");
  await waitForTheme(a, "light");
  // The usage page has no stream: it keeps the mode it drew until the tab is shown.
  await usage.waitForTimeout(500);
  expect(await theme(usage)).toBe("auto");
  await usage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitForTheme(usage, "light");

  // A reload paints the shared mode from the HTML itself: with every script
  // blocked, the attribute can only have come from the server.
  const bare = await context(machineB).newPage();
  await bare.route("**/*.js", (route) => route.abort());
  await bare.goto(`${origin}/usage`, { waitUntil: "load", timeout: 30000 });
  expect(await theme(bare)).toBe("light");

  await a.close();
  await usage.close();
  await bare.close();
});
