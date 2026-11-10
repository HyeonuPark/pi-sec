/**
 * A press on a link that opens another tab closes the thing the press came from.
 *
 * Two links on the chat page open a page in a new tab and leave the chat tab
 * standing: the `Reports` entry of the sidebar's Pages dropdown, and `Open page`
 * in the report panel. The dropdown and the panel stay on screen after the press
 * today, and the feature under test is that they close themselves.
 *
 * jsdom cannot say whether they close at the right moment. It does not follow a
 * link at all, so it cannot tell a close that runs before the browser takes the
 * address from one that runs after it. The panel is the case that matters:
 * closing it points its `Open page` link back at the report list, and a close
 * that ran first would open `/report` in the new tab instead of the report the
 * reader pressed. So this file drives Chromium through Playwright against a real
 * server on port 0, and reads the address the new tab really landed on.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
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
import { launchChromium } from "./chromium.ts";

/** How long the chat tab gets to put the press behind it before the test fails. */
const CLOSED_TIMEOUT_MS = 10000;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
/** The path of the fixture report's own page, which is where `Open page` goes. */
let reportPath = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });

  // One job, one report and one inbox notice about it: the notice is the press
  // that opens the report panel, and the report is what `Open page` opens.
  const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "sidebar autoclose fixture" });
  const report = await harness.runtime.reports.create(BACKGROUND_CONTEXT, {
    jobId: job.id,
    title: "Sidebar autoclose fixture",
    content: "# Sidebar autoclose fixture\n\nthe body of the report\n",
  });
  reportPath = `/report/${report.name}`;
  await harness.runtime.harness.commit(
    (tx) =>
      createInboxItemTx(tx, {
        title: "Report published: Sidebar autoclose fixture",
        body: "the body of the notice",
        kind: "report",
        reportId: report.id,
        reportEvent: "published",
        jobId: job.id,
      }),
    BACKGROUND_CONTEXT,
  );

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

/** Open the chat page and answer the tab once its inbox has a report notice. */
async function openChatPage(): Promise<Page> {
  const page = await currentContext().newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#inbox .inbox-title", { timeout: 30000 });
  return page;
}

/** Press a link that opens a new tab, and answer the tab it opened, once loaded. */
async function pressAndTakeNewTab(page: Page, selector: string): Promise<Page> {
  const opened = page.waitForEvent("popup", { timeout: 30000 });
  await page.click(selector);
  const popup = await opened;
  await popup.waitForLoadState("load", { timeout: 30000 });
  return popup;
}

it("closes the Pages dropdown when its Reports link opens a new tab", async () => {
  const page = await openChatPage();
  await page.click("#pages-toggle");
  await page.waitForFunction(() => document.getElementById("pages-menu")?.classList.contains("open") === true, undefined, {
    timeout: 10000,
  });

  const popup = await pressAndTakeNewTab(page, '#pages-menu a[href="/report"]');

  // The tab the press asked for, and the dropdown is gone on the chat tab behind
  // it. The address matters: the row closes by its class, and a close that ran
  // before the browser read the link would leave this tab somewhere else.
  expect(popup.url(), "the Reports link opened the wrong address").toBe(`${origin}/report`);
  await page.waitForFunction(
    () => document.getElementById("pages-menu")?.classList.contains("open") === false,
    undefined,
    { timeout: CLOSED_TIMEOUT_MS },
  );

  await popup.close();
  await page.close();
});

it("closes the report panel when `Open page` opens the report in a new tab", async () => {
  const page = await openChatPage();
  await page.click("#inbox .inbox-title");
  // The panel carries the report's own address before the press, so the address
  // the new tab lands on belongs to the press and not to a close that ran early.
  await page.waitForFunction(
    (wanted) => document.getElementById("report-pane-page")?.getAttribute("href") === wanted,
    reportPath,
    { timeout: 30000 },
  );
  const href = await page.evaluate(() => document.getElementById("report-pane-page")?.getAttribute("href") ?? "");
  expect(href, "the panel is not pointed at the fixture report").toBe(reportPath);

  const popup = await pressAndTakeNewTab(page, "#report-pane-page");

  expect(popup.url(), "`Open page` opened the wrong address").toBe(`${origin}${reportPath}`);
  await page.waitForFunction(() => document.body.dataset["report"] === "closed", undefined, {
    timeout: CLOSED_TIMEOUT_MS,
  });

  await popup.close();
  await page.close();
});
