/**
 * The busy Send button and a queued message, in a real browser.
 *
 * jsdom applies no stylesheet, so the ring colours, the faded fill and the
 * button's real opacity are only measurable here. The run is real: the faux model
 * holds its first answer open on a gate, so the page is connected and busy until
 * the test opens the gate.
 *
 * The four cases: the busy button's computed style in the light theme, the
 * queued field's computed style, both in the dark theme, and the whole flow from
 * a held run to one automatic send.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
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

const LIGHT_RING = "rgb(47, 74, 153)";
const DARK_RING = "rgb(149, 176, 255)";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  started = await startTestServer(harness, { webDir: builtWebDir() });
  origin = started.origin;
  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
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

/** A gate that keeps the first fake model answer open. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Open the chat, start a run the gate holds, and wait until Send is busy.
 * Later answers come at once.
 */
async function heldRun(first: string): Promise<{ page: Page; release(): void }> {
  if (harness === undefined || context === undefined) throw new Error("the test is not set up");
  const held = gate();
  const slow: FauxResponseFactory = async () => {
    await held.opened;
    return fauxAssistantMessage([fauxText("first answer")]);
  };
  const quick: FauxResponseFactory = async () => fauxAssistantMessage([fauxText("second answer")]);
  harness.faux.setResponses([slow, quick, quick]);
  const page = await context.newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#message", { timeout: 30000 });
  await page.fill("#message", first);
  await page.press("#message", "Enter");
  await page.waitForSelector("#send.send-busy", { timeout: 30000 });
  return { page, release: held.open };
}

async function style(page: Page, selector: string): Promise<{ opacity: string; border: string; shadow: string; background: string }> {
  // The button and the field fade their border and fill over 200 ms.
  await page.waitForTimeout(500);
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) throw new Error(`no ${sel}`);
    const computed = getComputedStyle(element);
    return {
      opacity: computed.opacity,
      border: computed.borderTopColor,
      shadow: computed.boxShadow,
      background: computed.backgroundColor,
    };
  }, selector);
}

async function settleIdle(page: Page, release: () => void): Promise<void> {
  release();
  await page.waitForSelector("#send:not(.send-busy)", { timeout: 30000 });
  await page.close();
}

it("draws the busy Send at full opacity with the faded fill and the ring, in the light theme", async () => {
  const { page, release } = await heldRun("light theme run");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.mouse.move(1, 1);
  const busy = await style(page, "#send");
  expect(busy.opacity).toBe("1");
  expect(busy.border).toBe(LIGHT_RING);
  expect(busy.shadow).toContain(LIGHT_RING);
  expect(busy.shadow).toContain("inset");
  // The faded button over the composer's own background, computed by the browser.
  const faded = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "color-mix(in srgb, #4f7cff 50%, #ffffff)";
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  expect(busy.background).toBe(faded);
  await settleIdle(page, release);
});

it("rings the queued field with the same colour as the button", async () => {
  const { page, release } = await heldRun("queued field run");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.fill("#message", "queued text");
  await page.click("#send");
  await page.waitForSelector("#message.send-queued", { timeout: 10000 });
  const field = await style(page, "#message");
  expect(field.border).toBe(LIGHT_RING);
  expect(field.shadow).toContain(LIGHT_RING);
  expect(field.shadow).toContain("inset");
  await page.fill("#message", "");
  await settleIdle(page, release);
});

it("takes the lighter ring in the dark theme, on the button and on the field", async () => {
  const { page, release } = await heldRun("dark theme run");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.fill("#message", "dark queued");
  await page.click("#send");
  await page.waitForSelector("#message.send-queued", { timeout: 10000 });
  await page.mouse.move(1, 1);
  const button = await style(page, "#send");
  const field = await style(page, "#message");
  expect(button.border).toBe(DARK_RING);
  expect(button.shadow).toContain(DARK_RING);
  expect(field.border).toBe(DARK_RING);
  expect(field.shadow).toContain(DARK_RING);
  await page.fill("#message", "");
  await settleIdle(page, release);
});

it("sends the queued message once when the run ends, and Enter queues nothing", async () => {
  const { page, release } = await heldRun("held first message");
  const marker = "queued second message";
  await page.fill("#message", marker);
  await page.press("#message", "Enter");
  await page.waitForTimeout(300);
  expect(await page.locator("#message.send-queued").count()).toBe(0);
  expect(await page.inputValue("#message")).toBe(marker);

  await page.click("#send");
  await page.waitForSelector("#message.send-queued", { timeout: 10000 });
  expect(await page.inputValue("#message")).toBe(marker);

  release();
  await page.waitForFunction(() => (document.getElementById("message") as HTMLTextAreaElement).value === "", undefined, { timeout: 30000 });
  await page.waitForSelector("#send:not(.send-busy)", { timeout: 30000 });
  await page.waitForFunction((text) => document.body.innerText.includes(text), marker, { timeout: 30000 });
  const shown = await page.evaluate((text) => document.body.innerText.split(text).length - 1, marker);
  expect(shown).toBe(1);
  expect(await page.locator("#message.send-queued").count()).toBe(0);
  await page.close();
});
