/**
 * The header leaves the model pill out on a phone and keeps it on a wide screen.
 *
 * The pill takes a second header row at the width where the app switches to its
 * phone layout, and that row costs the transcript a line. So `src/web/styles.css`
 * hides `#model` inside the breakpoint's own `@media (max-width: 860px)` block.
 * The element is still drawn and still updated there, which is what the second
 * half of this file holds: only the drawing of it is gone.
 *
 * jsdom cannot show this either: `getComputedStyle` there answers the rule the
 * stylesheet declares but lays nothing out, so a box that the browser collapses
 * is the same box as one it draws. So this file drives Chromium through Playwright
 * against a server on port 0, the way the other browser tests do.
 *
 * Two things are read at each width: the computed `display`, and the box the pill
 * takes. A `display: none` element has a zero box, which is what the first half
 * asserts on its own, and the wide screen asserts the opposite plus the text.
 *
 * If the rule is taken out of the stylesheet, the phone half fails on the display
 * it reads (`inline` in place of `none`), and the wide half still passes: the
 * failure names the narrow screen, not something else.
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

/** The widths the app switches layout at, one on each side and one exactly on it. */
const PHONE = { width: 390, height: 844 } as const;
const BREAKPOINT = { width: 860, height: 900 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
/** Everything the page reported as its own error, checked by every test. */
let pageErrors: string[] = [];
let origin = "";
/** `provider/modelId` the header is expected to name, read from the test config. */
let modelText = "";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const vmodel = harness.config.vmodels["faux"];
  if (vmodel === undefined) throw new Error("the test config declares no `faux` vmodel");
  modelText = `${vmodel.provider}/${vmodel.modelId}`;

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

  // One message in the root conversation, so the page has a snapshot to draw the
  // header from and the pill has a model to name.
  harness.faux.setResponses([(async () => fauxAssistantMessage([fauxText("ok")])) as never]);
  const posted = await fetch(`${origin}/basic-chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "the first message of the model-pill test" }),
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

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: DESKTOP });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  page = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

function currentPage(): Page {
  if (page === undefined) throw new Error("chromium is not running");
  return page;
}

/** What the page drew for `#model`, and what it says. */
interface PillFacts {
  /** The computed `display`, which is what the stylesheet decides. */
  readonly display: string;
  /** The drawn box, which is 0 by 0 while the element is not drawn. */
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

/** Open the conversation at one width and read the pill once the header is drawn. */
async function readPill(size: { width: number; height: number }): Promise<PillFacts> {
  const target = currentPage();
  await target.setViewportSize(size);
  await target.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  // The pill's text is `—` until the snapshot names a model, so waiting for a
  // name is waiting for the header to have drawn from real state.
  await target.waitForFunction(
    (expected) => document.getElementById("model")?.textContent?.trim() === expected,
    modelText,
    { timeout: 30000 },
  );
  return await target.evaluate(() => {
    const pill = document.getElementById("model");
    if (pill === null) throw new Error("the header drew no #model");
    const box = pill.getBoundingClientRect();
    return {
      display: getComputedStyle(pill).display,
      width: box.width,
      height: box.height,
      text: (pill.textContent ?? "").trim(),
    };
  });
}

it("does not draw the model pill on a phone", async () => {
  const facts = await readPill(PHONE);
  expect(facts.display, `the pill at ${PHONE.width}px`).toBe("none");
  expect(facts.width, `the pill's width at ${PHONE.width}px`).toBe(0);
  expect(facts.height, `the pill's height at ${PHONE.width}px`).toBe(0);
  // The element is still on the page and still names the model: the rule removes
  // the drawing of it, not the pill.
  expect(facts.text, `the pill's text at ${PHONE.width}px`).toBe(modelText);
  expect(pageErrors).toEqual([]);
});

it("does not draw the model pill on the breakpoint's own width", async () => {
  const facts = await readPill(BREAKPOINT);
  expect(facts.display, `the pill at ${BREAKPOINT.width}px`).toBe("none");
  expect(facts.height, `the pill's height at ${BREAKPOINT.width}px`).toBe(0);
  expect(pageErrors).toEqual([]);
});

it("draws the model pill, with the model's name, on a wide screen", async () => {
  const facts = await readPill(DESKTOP);
  expect(facts.display, `the pill at ${DESKTOP.width}px`).not.toBe("none");
  expect(facts.height, `the pill's height at ${DESKTOP.width}px`).toBeGreaterThan(0);
  expect(facts.width, `the pill's width at ${DESKTOP.width}px`).toBeGreaterThan(0);
  expect(facts.text, `the pill's text at ${DESKTOP.width}px`).toBe(modelText);
  expect(pageErrors).toEqual([]);
});
