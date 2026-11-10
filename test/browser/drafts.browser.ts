/**
 * Unsent input text survives a real reload.
 *
 * jsdom can stand a page up again from a copied `localStorage`, and the other
 * test file does that. What it cannot show is the browser itself: the store, the
 * page's own startup order, and a real `reload()`. So this file drives Chromium
 * through Playwright against a server on port 0, types into each field, reloads,
 * and reads the field back. Nothing is sent: the tests never press a send button.
 */
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import type { StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { launchChromium } from "./chromium.ts";
import { startTestServer } from "../server-helpers.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
/**
 * One context for the whole file, for the same reason the card test keeps one:
 * Chromium runs here with `--single-process`, and closing a context in that mode
 * closed the whole browser.
 */
let context: BrowserContext | undefined;
let origin = "";
/** The slug of the report the feedback test writes into. */
let reportName = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  // One report to leave feedback on. Nothing reads it: the bar only needs a
  // report to be pointed at, and the draft is kept before anything is sent.
  const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "draft fixture" });
  const report = await harness.runtime.reports.create(BACKGROUND_CONTEXT, {
    jobId: job.id,
    title: "Draft fixture",
    content: "# Draft fixture\n\nbody\n",
  });
  reportName = report.name;

  started = await startTestServer(harness, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

interface OpenedPage {
  readonly page: Page;
  readonly status: number | undefined;
  readonly pageErrors: string[];
}

/** Open one page of the app and record what it reports as its own error. */
async function openPage(path: string): Promise<OpenedPage> {
  const page = await currentContext().newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30000 });
  return { page, status: response?.status(), pageErrors };
}

it("brings the composer's unsent text back after a reload", async () => {
  const opened = await openPage("/basic-chat");
  const page = opened.page;
  const text = "a draft for the composer, typed and not sent";

  await page.fill("#message", text);
  // The store is written on the input event, so the value the field holds and
  // the value the store holds are checked before the reload.
  const stored = await page.evaluate(() => {
    const keys = Object.keys(window.localStorage).filter((key) => key.startsWith("pi-sec:drafts:"));
    return keys.map((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"));
  });
  expect(stored).toHaveLength(1);
  expect((stored[0] as { text: string }).text).toBe(text);

  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    (expected) => (document.getElementById("message") as HTMLTextAreaElement | null)?.value === expected,
    text,
    { timeout: 20000 },
  );
  expect(await page.inputValue("#message")).toBe(text);
  expect(opened.status).toBe(200);
  expect(opened.pageErrors).toEqual([]);
  await page.close();
});

it("brings the feedback field's unsent text back after a reload", async () => {
  const opened = await openPage(`/report/${reportName}`);
  const page = opened.page;
  const text = "a draft for the feedback bar, typed and not sent";

  await page.waitForSelector("#feedback-body", { state: "attached", timeout: 30000 });
  // The bar restores a stored draft when it is pointed at the report, so the
  // field has to be the one the report was loaded for before it is typed into.
  await page.waitForFunction(
    () => document.getElementById("feedback-submit")?.textContent === "Approve",
    undefined,
    { timeout: 20000 },
  );
  await page.fill("#feedback-body", text);
  // Text in the field flips the one button to the feedback action, which is what
  // a restored draft must do as well.
  await page.waitForFunction(() => document.getElementById("feedback-submit")?.textContent === "Feedback", undefined, {
    timeout: 5000,
  });

  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    (expected) => (document.getElementById("feedback-body") as HTMLTextAreaElement | null)?.value === expected,
    text,
    { timeout: 20000 },
  );
  expect(await page.inputValue("#feedback-body")).toBe(text);
  expect(await page.textContent("#feedback-submit")).toBe("Feedback");
  expect(opened.status).toBe(200);
  expect(opened.pageErrors).toEqual([]);
  // Nothing was sent: no feedback, no approval left the page.
  await page.close();
});
