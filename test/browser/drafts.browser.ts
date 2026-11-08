/**
 * Unsent input text survives a real reload.
 *
 * jsdom can stand a page up again from a copied `localStorage`, and the other
 * test file does that. What it cannot show is the browser itself: the store, the
 * page's own startup order, and a real `reload()`. So this file drives Chromium
 * through Playwright against a server on port 0, types into each field, reloads,
 * and reads the field back. Nothing is sent: the tests never press a send button.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

// Chromium needs X11/atk/gbm libraries that a minimal Linux image may not ship, and there may be no
// root to install them. They are unpacked from Fedora RPMs into a local
// prefix instead; point the dynamic linker at it before launching. Same as
// scripts/ui-probe.mjs.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}

// A host may have no GPU, and the GPU process may not start at all
// (`gpu_data_manager_impl_private.cc: GPU process isn't usable`). `--single-process`
// keeps rendering on the CPU inside the browser process, which is all this needs.
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

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

  try {
    browser = await chromium.launch({ args: LAUNCH_ARGS });
  } catch (error) {
    // A launch failure is the host's, not
    // the code's, and the exact error is the only useful thing to report.
    throw new Error(`chromium did not launch: ${error instanceof Error ? error.message : String(error)}`);
  }
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
