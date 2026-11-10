/**
 * The composer keeps its height when one line is typed, in a real browser.
 *
 * jsdom lays nothing out, so the real heights are only measurable here. For each
 * width and theme, the field and the context bar must not move by more than one
 * pixel between the empty field and a field with one typed line.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import type { StartedServer } from "../../src/server/server.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";
import { startTestServer } from "../server-helpers.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  started = await startTestServer(harness, { webDir: builtWebDir() });
  origin = started.origin;
  browser = await launchChromium();
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
