import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * `scripts/ui-probe.mjs` reports the elements wider than the viewport, and its
 * verdict is only worth reading if the selector it walks can reach the page
 * under test. It was `#view *`, and only the report page has a `#view`: on the
 * app page the list was empty because nothing matched, not because nothing
 * overflowed. These tests pin the selector against both real pages, so a change
 * back to a page-specific scope fails here instead of silently reading as
 * "no overflow".
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** The selector the tool passes to `querySelectorAll` inside `wideOffenders`. */
async function overflowSelector(): Promise<string> {
  const source = await readFile(join(root, "scripts/ui-probe.mjs"), "utf8");
  const start = source.indexOf("wideOffenders:");
  const end = source.indexOf("diffLineOffenders:");
  if (start === -1 || end === -1 || end < start) throw new Error("ui-probe.mjs has no wideOffenders block");
  const block = source.slice(start, end);
  const match = /document\.querySelectorAll\("([^"]+)"\)/.exec(block);
  if (match === null) throw new Error("wideOffenders walks no selector");
  return match[1]!;
}

/** The selector the tool counts with, inside `wideScanned`. */
async function countedSelector(): Promise<string> {
  const source = await readFile(join(root, "scripts/ui-probe.mjs"), "utf8");
  const start = source.indexOf("wideScanned:");
  const end = source.indexOf("wideOffenders:");
  if (start === -1 || end === -1 || end < start) throw new Error("ui-probe.mjs has no wideScanned block");
  const block = source.slice(start, end);
  const match = /document\.querySelectorAll\("([^"]+)"\)/.exec(block);
  if (match === null) throw new Error("wideScanned counts no selector");
  return match[1]!;
}

/** One entry of `wideOffenders`, as far as the printed line is concerned. */
interface WideOffender {
  tag: string;
  cls: string | null;
  width: number;
  scrollWidth: number;
  overflowX: string;
  text: string;
}

interface WideInfo {
  wideScanned: number;
  wideOffenders: WideOffender[];
}

/**
 * `formatWideSection` from `scripts/ui-probe.mjs`, compiled on its own.
 *
 * The probe is a script, not a module: importing it launches Chromium and reads
 * `process.argv` before any export could be reached. So the test lifts the one
 * pure function out of the source and runs that, which keeps the assertion on
 * the text the tool really prints instead of on a copy of it here.
 */
async function formatWideSection(): Promise<(info: WideInfo) => string> {
  const source = await readFile(join(root, "scripts/ui-probe.mjs"), "utf8");
  const start = source.indexOf("function formatWideSection(");
  if (start === -1) throw new Error("ui-probe.mjs has no formatWideSection");
  const end = source.indexOf("\n}\n", start);
  if (end === -1) throw new Error("formatWideSection has no closing brace at column 0");
  const body = source.slice(start, end + 2);
  return new Function(`${body}\nreturn formatWideSection;`)() as (info: WideInfo) => string;
}

async function dom(file: string): Promise<Document> {
  const html = await readFile(join(root, "src/web", file), "utf8");
  return new JSDOM(html.replaceAll("{{base}}", "")).window.document;
}

describe("ui-probe overflow selector", () => {
  it("reaches elements on the app page, which has no #view", async () => {
    const selector = await overflowSelector();
    const document = await dom("index.html");
    // The bug this replaced: a #view-scoped selector matched nothing here.
    expect(document.querySelectorAll("#view *").length).toBe(0);
    expect(document.querySelectorAll(selector).length).toBeGreaterThan(0);
  });

  it("reaches elements on the report page too", async () => {
    const selector = await overflowSelector();
    const document = await dom("report.html");
    expect(document.querySelectorAll("#view").length).toBe(1);
    const matched = document.querySelectorAll(selector);
    expect(matched.length).toBeGreaterThan(0);
    // The report viewer is still inside what the selector covers.
    for (const element of document.querySelectorAll("#view, #view *")) {
      expect(Array.from(matched).includes(element)).toBe(true);
    }
  });
});

describe("ui-probe overflow count", () => {
  it("counts with the same selector it reports on", async () => {
    // A count from some other walk would answer a different question than the
    // list it sits next to.
    expect(await countedSelector()).toBe(await overflowSelector());
    const document = await dom("index.html");
    expect(document.querySelectorAll(await countedSelector()).length).toBeGreaterThan(0);
  });

  it("separates a selector that matched nothing from a page that fits", async () => {
    const format = await formatWideSection();
    // Navigation failed, or the walk was scoped to a page that has no such
    // element: nothing was measured, and the old output said `(none)` exactly
    // as it did for a healthy page.
    const matchedNothing = format({ wideScanned: 0, wideOffenders: [] });
    const allFit = format({ wideScanned: 42, wideOffenders: [] });
    expect(matchedNothing).not.toBe(allFit);
    expect(matchedNothing).toContain("--- elements wider than the viewport (scanned 0) ---");
    expect(matchedNothing).toContain("(none)");
    expect(matchedNothing).toContain("matched no element");
    expect(allFit).toContain("--- elements wider than the viewport (scanned 42) ---");
    expect(allFit).toContain("(none)");
    expect(allFit).toContain("42 matched element(s) fit");
    expect(allFit).not.toContain("matched no element");
  });

  it("keeps the scanned count in the heading and lists every offender", async () => {
    const format = await formatWideSection();
    const out = format({
      wideScanned: 7,
      wideOffenders: [
        { tag: "pre", cls: "diff", width: 900, scrollWidth: 1200, overflowX: "auto", text: "diff body" },
        { tag: "div", cls: null, width: 410, scrollWidth: 410, overflowX: "visible", text: "wide box" },
      ],
    });
    expect(out).toContain("--- elements wider than the viewport (scanned 7) ---");
    expect(out).toContain('  <pre class="diff"> 900px (scroll 1200px, overflow-x auto) :: diff body');
    expect(out).toContain("  <div> 410px (scroll 410px, overflow-x visible) :: wide box");
    expect(out).not.toContain("(none)");
  });
});
