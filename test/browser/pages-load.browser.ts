/**
 * The four pages, opened in a real browser: no error, no failed request, no refused style.
 *
 * The page modules are bundles now, and a bundle is the one thing jsdom never
 * runs: a typo in an import path, a module that throws on load, or a specifier
 * that resolves under the repository root but not under `/report/assets/` all
 * pass every jsdom test and leave a browser with a page that draws nothing.
 *
 * So each path the app serves is opened for real, and three things are read:
 *
 * - `pageerror`, which is an exception the page threw;
 * - a request that failed, and a response with a 4xx or 5xx status, which is a
 *   file the shell asks for and does not get;
 * - a `securitypolicyviolation` event, and a console line that names the policy,
 *   which is the page's own CSP refusing something it wrote.
 *
 * The page must also have drawn what it exists to draw before it is judged: a
 * reporter that answered 200 with a page stuck on "Loading…" is not a healthy
 * page, and the check below would pass it.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import type { StartedServer } from "../../src/server/server.ts";
import { createInboxItemTx } from "../../src/extensions/notify.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";
import { startTestServer } from "../server-helpers.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
/** The slug of the report the viewer test opens. */
let reportName = "";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });

  // A transcript to draw, a job, a report and the inbox notice that links to it:
  // every page then has something on screen, so "it loaded" means more than "the
  // shell arrived".
  const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "pages-load fixture" });
  const report = await harness.runtime.reports.create(BACKGROUND_CONTEXT, {
    jobId: job.id,
    title: "Pages load fixture",
    content: "# Pages load fixture\n\nthe body of the report\n",
  });
  reportName = report.name;
  await harness.runtime.harness.commit(
    (tx) =>
      createInboxItemTx(tx, {
        title: `Report published: ${report.title}`,
        body: "the body of the notice",
        kind: "report",
        reportId: report.id,
        reportEvent: "published",
        jobId: job.id,
      }),
    BACKGROUND_CONTEXT,
  );

  started = await startTestServer(harness, { webDir: builtWebDir() });
  origin = started.origin;

  // One message in the root conversation, so the chat page draws a transcript.
  harness.faux.setResponses([(async () => fauxAssistantMessage([fauxText("ok")])) as never]);
  const posted = await fetch(`${origin}/basic-chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "the first message of the pages-load test" }),
  });
  if (!posted.ok) throw new Error(`the fixture message answered ${posted.status}`);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await fetch(`${origin}/basic-chat/context`);
    if (response.ok) {
      const data = (await response.json()) as { used?: number };
      if (typeof data.used === "number" && data.used > 0) break;
    }
    await wait(100);
  }

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

/** Everything one page said about itself while it loaded. */
interface LoadFacts {
  readonly status: number | undefined;
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  readonly errorResponses: readonly string[];
  readonly violations: readonly string[];
  readonly consoleLines: readonly string[];
}

/**
 * Open one path with every watcher installed before the first script runs, wait
 * until `drawn` says the page has drawn, then read what it said.
 */
async function openAndWatch(path: string, drawn: (page: Page) => Promise<void>): Promise<LoadFacts> {
  const page = await currentContext().newPage();
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const errorResponses: string[] = [];
  const consoleLines: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  await page.addInitScript(() => {
    const probe = window as unknown as { __csp?: string[] };
    probe.__csp = [];
    document.addEventListener(
      "securitypolicyviolation",
      (event) => probe.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`),
      true,
    );
  });

  const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30000 });
  await drawn(page);
  // Two frames after the last thing drawn, so a script that fails right after its
  // first draw is still counted.
  await wait(300);
  const violations = (await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])) as string[];
  await page.close();
  return {
    status: response?.status(),
    pageErrors,
    failedRequests,
    errorResponses,
    violations,
    consoleLines,
  };
}

/** The console lines that report a policy refusal, which are the ones that matter here. */
function cspConsoleLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("Content Security Policy") || line.includes("CSP"));
}

/** Every condition, in one place, so each page is judged by the same four. */
function expectClean(facts: LoadFacts, path: string): void {
  expect(facts.status, `${path} answered ${facts.status}`).toBe(200);
  expect(facts.pageErrors, `${path} threw`).toEqual([]);
  expect(facts.failedRequests, `${path} asked for a file it did not get`).toEqual([]);
  expect(facts.errorResponses, `${path} was answered with an error`).toEqual([]);
  expect(facts.violations, `${path} was refused by its own policy`).toEqual([]);
  expect(cspConsoleLines(facts.consoleLines), `${path} reported a policy refusal`).toEqual([]);
}

it("opens the conversation page and draws its transcript", async () => {
  const facts = await openAndWatch("/basic-chat", async (page) => {
    await page.waitForFunction(() => document.querySelectorAll("#transcript > [data-row-key]").length >= 2, undefined, {
      timeout: 30000,
    });
    await page.waitForSelector("#inbox .inbox-title", { timeout: 30000 });
  });
  expectClean(facts, "/basic-chat");
});

it("opens the report list", async () => {
  const facts = await openAndWatch("/report", async (page) => {
    await page.waitForFunction(() => (document.getElementById("view")?.textContent ?? "").trim() !== "", undefined, {
      timeout: 30000,
    });
  });
  expectClean(facts, "/report");
});

it("opens one report, with the feedback bar under it", async () => {
  const facts = await openAndWatch(`/report/${reportName}`, async (page) => {
    await page.waitForSelector("#feedback-body", { state: "attached", timeout: 30000 });
    await page.waitForFunction(() => (document.getElementById("view")?.textContent ?? "").includes("Pages load fixture"), undefined, {
      timeout: 30000,
    });
  });
  expectClean(facts, `/report/${reportName}`);
});

it("opens the chats list", async () => {
  const facts = await openAndWatch("/chats", async (page) => {
    await page.waitForFunction(() => (document.getElementById("view")?.textContent ?? "").trim() !== "", undefined, {
      timeout: 30000,
    });
  });
  expectClean(facts, "/chats");
});

it("opens the usage page and draws a card", async () => {
  const facts = await openAndWatch("/usage", async (page) => {
    await page.waitForFunction(() => document.querySelectorAll("#usage-cards article.usage-card").length >= 1, undefined, {
      timeout: 30000,
    });
  });
  expectClean(facts, "/usage");
});
