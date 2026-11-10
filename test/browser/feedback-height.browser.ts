/**
 * The empty feedback field is one row tall, on both surfaces that carry the bar.
 *
 * The rewrite drew it short. The bar stands in a hidden container until it is
 * pointed at a report, and `src/ui/components/feedback.tsx` measured the field in
 * the render before that. The `scrollHeight` of a field inside `display: none` is
 * 0, and a box drawn at `height: 0px` is still as tall as its own padding and
 * border, so the field came out 18px tall and the placeholder was cut in half.
 * The height was never measured again, because the field's text did not change.
 *
 * jsdom cannot show this: it has no layout, so every height it reports is 0 and
 * the broken component and the fixed one measure the same. So this file drives
 * Chromium through Playwright against a server on port 0, the way the other
 * browser tests do.
 *
 * The expected numbers are what the earlier hand-written bar drew under
 * these conditions, read with the same probe on that bar's own tree. The
 * conditions are a report in a live job with one revision, so the hint line under
 * the bar is empty, viewports of 390x844 and 1280x900, and device scale factor 1.
 *
 *   surface  viewport    field  bar box
 *   viewer   phone         39      108
 *   viewer   desktop       39       56
 *   panel    phone         18       83
 *   panel    desktop       18    76.28
 *
 * The old viewer's field is what this test holds the field to. The old panel drew
 * the same 18px box, because it measured the field while its own container was
 * hidden, so the panel's box below is written as the old box plus the 21px the
 * field gains over that measurement.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
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

/** The two viewports measured, named for the failure messages. */
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;
const SIZES = [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const;

/** The empty field's height in the old viewer, at both viewports. */
const EMPTY_FIELD_PX = 39;
/** The old bar's box around it: `#note-bar` on the viewer, at both viewports. */
const VIEWER_BOX_PX = { phone: 108, desktop: 56 } as const;
/** What the old panel drew, and the box it drew it in, at both viewports. */
const OLD_PANEL_FIELD_PX = 18;
const OLD_PANEL_BOX_PX = { phone: 83, desktop: 76.28125 } as const;
/** The panel's box once its field has the one row the old viewer gave it. */
const PANEL_BOX_PX = {
  phone: OLD_PANEL_BOX_PX.phone + (EMPTY_FIELD_PX - OLD_PANEL_FIELD_PX),
  // The panel's buttons are at least 44px tall at every width now, so the wide
  // panel draws the same box as the narrow one: this is the height measured on
  // the change, not the old stacked row grown by the field's 21px.
  desktop: 104,
} as const;
/** The height the field stops growing at, which is the `max-height` it is given. */
const MAX_FIELD_PX = 128;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
/**
 * One page for the whole file. Chromium runs here with `--single-process`, and
 * closing the last page closes the browser with it, so nothing here closes one.
 */
let page: Page | undefined;
/** Everything the page reported as its own error, checked by the first test run. */
let pageErrors: string[] = [];
let origin = "";
let reportName = "";
let reportId = "";
let jobId = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  // One report to draw the bar for. The job stays live, so the bar offers an
  // approval and the hint line under it stays empty, which is the state the old
  // numbers were read in.
  const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "feedback height fixture" });
  jobId = job.id;
  const report = await harness.runtime.reports.create(BACKGROUND_CONTEXT, {
    jobId: job.id,
    title: "Feedback height fixture",
    content: "# Feedback height fixture\n\nbody\n",
  });
  reportName = report.name;
  reportId = report.id;

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
  page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  page = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/** The file's one page, for a test that measures on it. */
function currentPage(): Page {
  if (page === undefined) throw new Error("chromium is not running");
  return page;
}

/** What the bar drew, in the page, in CSS pixels. */
interface BarFacts {
  /** The field's rendered height. */
  readonly field: number;
  /** The container the bar stands in: `#note-bar` or `#report-pane-feedback`. */
  readonly box: number;
}

/** Read the field and the bar's box on the page as it stands. */
async function readBar(target: Page, containerId: string): Promise<BarFacts> {
  return await target.evaluate((id) => {
    const field = document.getElementById("feedback-body");
    const container = document.getElementById(id);
    if (field === null) throw new Error("the bar drew no #feedback-body");
    if (container === null) throw new Error(`the page has no #${id}`);
    return { field: field.getBoundingClientRect().height, box: container.getBoundingClientRect().height };
  }, containerId);
}

/** The bar is pointed at the fixture report, and its one button offers an approval. */
const BAR_READY = () => {
  const button = document.getElementById("feedback-submit");
  const noteBar = document.getElementById("note-bar");
  const pane = document.getElementById("report-pane-feedback");
  const shown = noteBar === null || !noteBar.classList.contains("hidden");
  const paneShown = pane === null || !pane.hasAttribute("hidden");
  return shown && paneShown && button !== null && button.textContent === "Approve";
};

/** A fresh inbox notice about the fixture, which is how the panel is opened. */
async function notice(): Promise<void> {
  if (harness === undefined) throw new Error("the harness is not running");
  await harness.runtime.harness.commit(
    (tx) =>
      createInboxItemTx(tx, {
        title: `Report published: ${reportId}`,
        body: "the notice body",
        kind: "report",
        reportId,
        reportEvent: "published",
        jobId,
      }),
    BACKGROUND_CONTEXT,
  );
}

it("draws the empty field one row tall in the report viewer", async () => {
  const target = currentPage();
  for (const [label, size] of SIZES) {
    await target.setViewportSize(size);
    await target.goto(`${origin}/report/${reportName}`, { waitUntil: "load", timeout: 30000 });
    await target.waitForFunction(BAR_READY, undefined, { timeout: 30000 });
    const facts = await readBar(target, "note-bar");
    expect(facts.field, `viewer field at ${label} (${size.width}px)`).toBe(EMPTY_FIELD_PX);
    expect(facts.box, `viewer bar box at ${label} (${size.width}px)`).toBe(VIEWER_BOX_PX[label]);
  }
  expect(pageErrors).toEqual([]);
});

it("draws the empty field one row tall in the chat's report panel", async () => {
  const target = currentPage();
  for (const [label, size] of SIZES) {
    // The notice is what opens the panel, and opening it marks it read, so each
    // measurement gets one of its own.
    await notice();
    await target.setViewportSize(size);
    await target.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
    if (size.width < 860) {
      // The inbox is the drawer on a narrow screen, and the drawer starts closed.
      const open = await target.evaluate(() => document.body.dataset["sidebar"] === "open");
      if (!open) {
        await target.click("#sidebar-toggle");
        await target.waitForFunction(() => document.body.dataset["sidebar"] === "open", undefined, { timeout: 10000 });
      }
    }
    await target.waitForSelector("#inbox .inbox-title", { timeout: 30000 });
    await target.click("#inbox .inbox-title");
    await target.waitForFunction(BAR_READY, undefined, { timeout: 30000 });
    const facts = await readBar(target, "report-pane-feedback");
    expect(facts.field, `panel field at ${label} (${size.width}px)`).toBe(EMPTY_FIELD_PX);
    expect(facts.box, `panel box at ${label} (${size.width}px)`).toBe(PANEL_BOX_PX[label]);
  }
  expect(pageErrors).toEqual([]);
});

it("grows the field with its text, up to the height the stylesheet allows", async () => {
  const target = currentPage();
  await target.setViewportSize(PHONE);
  await target.goto(`${origin}/report/${reportName}`, { waitUntil: "load", timeout: 30000 });
  await target.waitForFunction(BAR_READY, undefined, { timeout: 30000 });

  // Nothing is sent: the text only reaches the field and the browser's draft
  // store, which is what the bar saves on every keystroke.
  await target.fill("#feedback-body", "a line of feedback\n".repeat(20));
  const grown = await readBar(target, "note-bar");
  expect(grown.field, "the field stops at the stylesheet's max-height").toBe(MAX_FIELD_PX);

  await target.fill("#feedback-body", "");
  const back = await readBar(target, "note-bar");
  expect(back.field, "an emptied field is one row again").toBe(EMPTY_FIELD_PX);
  expect(back.box, "and the bar is back to the height it opened at").toBe(VIEWER_BOX_PX.phone);
  expect(pageErrors).toEqual([]);
});
