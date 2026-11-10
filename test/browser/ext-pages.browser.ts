/**
 * A runtime extension's page in a real browser: the example page loads, its script
 * runs, its `piSecPage.fetch` reaches the extension's api and updates the table,
 * and a `<script>` element or an event handler attribute inside the `render` html
 * does not run, because the core page policy forbids inline code.
 *
 * jsdom does not enforce a Content-Security-Policy and does not run module
 * scripts, so neither claim can be tested there.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { builtWebDir } from "./web-dir.ts";
import { bootServer, installHostStatus, pagesExtension, writeExtension, type BootedPages } from "../ext-pages-helpers.ts";
import { launchChromium } from "./chromium.ts";

/** A page whose html carries code of every inline kind, and one allowed script file. */
const INLINE = pagesExtension(
  "inline",
  `
export const pages = {
  entries: [{ page: "", label: "Inline", script: "ok.js" }],
  render() {
    return {
      html:
        '<p id="state">server</p>' +
        '<script>window.__inlineScript = true</script>' +
        '<button id="handler" type="button" onclick="window.__inlineHandler = true">go</button>' +
        '<img id="broken" src="data:," onerror="window.__inlineError = true">',
    };
  },
};
`,
);

let booted: BootedPages | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

beforeAll(async () => {
  booted = await bootServer({ server: { webDir: builtWebDir() } });
  await installHostStatus(booted.harness);
  await writeExtension(booted.harness, "inline", INLINE, {
    "ui/ok.js": "window.__fileScript = true; document.getElementById('state').textContent = 'script ran';\n",
  });
  const loaded = await booted.harness.runtime.loader.loadAll();
  if (loaded.errors.length > 0) throw new Error(`the fixture extensions did not load: ${loaded.errors.join("; ")}`);
  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  await booted?.close();
  booted = undefined;
});

it("loads the example page, runs its script, and updates the table through piSecPage.fetch", async () => {
  const page = await context!.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(`${booted!.origin}/ext/host-status/`);
  expect(response?.status()).toBe(200);

  expect(await page.title()).toBe("Host status · pi-sec");
  expect(await page.locator("h1").textContent()).toBe("Host status");
  const helper = await page.evaluate(() => {
    const api = (window as unknown as { piSecPage?: { extension: string; page: string; apiUrl(p: string): string } }).piSecPage;
    return api === undefined ? null : { extension: api.extension, page: api.page, url: api.apiUrl("status") };
  });
  expect(helper).toEqual({ extension: "host-status", page: "", url: "/ext/host-status/api/status" });

  // The stylesheet from ui/ applies: the theme variable reaches the cell border.
  const border = await page.locator("td").first().evaluate((cell) => getComputedStyle(cell).borderBottomStyle);
  expect(border).toBe("solid");

  // Overwrite a cell, press Refresh: only the script's fetch of the api can put a real value back.
  await page.locator('[data-field="load"]').evaluate((cell) => {
    cell.textContent = "stale";
  });
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.querySelector('[data-field="load"]')?.textContent !== "stale");
  const load = await page.locator('[data-field="load"]').textContent();
  expect(load).toMatch(/^[\d.]+, [\d.]+, [\d.]+$/);
  expect(errors).toEqual([]);
  await page.close();
});

it("runs the declared script file and nothing inline in the rendered html", async () => {
  const page = await context!.newPage();
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  await page.goto(`${booted!.origin}/ext/inline/`);
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>)["__fileScript"] === true);
  expect(await page.locator("#state").textContent()).toBe("script ran");

  await page.locator("#handler").click();
  await page.waitForTimeout(200);
  const flags = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { script: w["__inlineScript"], handler: w["__inlineHandler"], error: w["__inlineError"] };
  });
  expect(flags).toEqual({ script: undefined, handler: undefined, error: undefined });
  // The browser said why: the policy refused the inline code.
  expect(violations.length).toBeGreaterThan(0);
  await page.close();
});
