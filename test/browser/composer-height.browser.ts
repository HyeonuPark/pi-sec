/**
 * The composer keeps its height when one line is typed, in a real browser.
 *
 * jsdom lays nothing out, so the real heights are only measurable here. For each
 * width and theme, the field and the context bar must not move by more than one
 * pixel between the empty field and a field with one typed line.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";

// Same library prefix and launch args as the other browser tests.
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
});

afterAll(async () => {
  await browser?.close();
  await started?.close();
  await harness?.close();
});

const MAX_SHIFT_PX = 1;

async function heights(page: Page): Promise<{ field: number; barTop: number }> {
  return page.evaluate(() => ({
    field: document.getElementById("message")!.getBoundingClientRect().height,
    barTop: document.getElementById("context-bar")!.getBoundingClientRect().top,
  }));
}

for (const width of [1000, 375]) {
  for (const theme of ["light", "dark"]) {
    it(`one typed line keeps the empty height at ${width}px in the ${theme} theme`, async () => {
      const page = await context!.newPage();
      try {
        await page.addInitScript(() => localStorage.clear());
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
        await page.waitForSelector("#message", { timeout: 30000 });
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await page.waitForTimeout(300);
        expect(await page.inputValue("#message"), "the field starts empty").toBe("");
        expect(await page.evaluate(() => document.getElementById("message")!.style.height), "no inline height when empty").toBe("");
        const empty = await heights(page);
        for (const line of ["hello", "안녕하세요 한글 입력"]) {
          await page.fill("#message", "");
          await page.click("#message");
          await page.keyboard.type(line);
          await page.waitForTimeout(200);
          const typed = await heights(page);
          expect(Math.abs(typed.field - empty.field), `field height for ${line}`).toBeLessThanOrEqual(MAX_SHIFT_PX);
          expect(Math.abs(typed.barTop - empty.barTop), `context bar top for ${line}`).toBeLessThanOrEqual(MAX_SHIFT_PX);
        }
      } finally {
        await page.close();
      }
    });
  }
}
