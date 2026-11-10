/**
 * Extension cards in a real browser.
 *
 * jsdom is what the other web tests use, and jsdom does not build a declarative
 * shadow root from the parser and does not run `<script type="module">`. Both are
 * the point of a card: the server sends a `<template shadowrootmode>` and the
 * browser attaches it while parsing, then runs the card's module script under the
 * page's `script-src 'self'`. So this file drives Chromium through Playwright
 * against a real server on port 0.
 *
 * Two paths are checked. With `ui-cards.js` blocked at the network, nothing but
 * the parser and the browser can have produced the shadow root, and the card's
 * module script still runs and counts itself. With the page intact, the same card
 * mounts, its `api.call` reaches the extension's `action`, and an event the
 * extension publishes arrives at the card's handler through the conversation
 * stream. Both paths watch for a Content Security Policy violation and for a
 * console line that reports one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { launchChromium } from "./chromium.ts";

/** The card's script, served from the extension's `ui/` directory. */
const PROBE_JS = `window.__probeRuns = (window.__probeRuns ?? 0) + 1;
if (window.piSecUi) {
  window.piSecUi.define("demo-cards/probe", (root, api) => {
    window.__probeMounts = (window.__probeMounts ?? 0) + 1;
    root.querySelector("[data-role=state]").textContent = "mounted";
    api.on("ping", (value) => {
      root.querySelector("[data-role=event]").textContent = "ping " + value.n;
    });
    api.call("hello", 41).then(
      (value) => {
        root.querySelector("[data-role=answer]").textContent = "answer " + value;
      },
      (error) => {
        // A refused call leaves a trace the test output can show, instead of a
        // card that silently stays as the server drew it.
        root.querySelector("[data-role=answer]").textContent = "refused " + (error && error.message);
      },
    );
  });
}
`;

/**
 * One card in the page's lower sidebar slot: markup with three elements the test
 * reads, a colour in the card's own stylesheet, an action that answers a value
 * and publishes an event for the card.
 */
const DEMO_CARDS = `
let publishTo = () => {};
export const name = "demo-cards";
export function create() {
  return { name: "demo-cards" };
}
export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "probe", script: "probe.js" }],
  render() {
    return {
      html: '<p data-role="state">server</p><span data-role="event"></span><span data-role="answer"></span>',
      css: "p { color: rgb(1, 2, 3); }",
    };
  },
  action({ action, value }) {
    if (action !== "hello") return { value: "unknown action" };
    // The page's event stream attaches after the card's script runs, and an event
    // published for a stream nobody is attached to reaches no card. A few
    // attempts over the first seconds keep the test off that race; each one
    // carries the same value, so the card's line ends up the same either way.
    const n = value;
    let left = 8;
    const ping = () => {
      publishTo("probe", "ping", { n });
      left -= 1;
      if (left > 0) setTimeout(ping, 250);
    };
    setTimeout(ping, 250);
    return { value: value + 1 };
  },
  start(input) {
    publishTo = input.publish;
  },
};
`;

/** What the page reports about its one card, read in the browser. */
interface CardFacts {
  readonly hostFound: boolean;
  readonly shadowRoot: boolean;
  /** `template` elements still inside the host: zero when the parser consumed it. */
  readonly templatesLeft: number;
  readonly lightChildren: number;
  readonly runs: number;
  readonly mounts: number;
  readonly state: string | null;
  readonly event: string | null;
  readonly answer: string | null;
  readonly color: string | null;
  readonly violations: readonly string[];
}

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
/**
 * One context for the whole file. Chromium runs here with `--single-process`, and
 * closing a context in that mode closed the whole browser (the next test's
 * `newPage` failed), so each test opens a page and the context goes with the
 * browser in `afterAll`.
 */
let context: BrowserContext | undefined;
let origin = "";

beforeAll(async () => {
  harness = await createTestHarness({
    config: { server: { ...defaultConfig().server, port: 0 } },
  });
  const dir = join(harness.paths.extensionsDir, "demo-cards");
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(join(dir, "index.js"), DEMO_CARDS);
  await writeFile(join(dir, "ui", "probe.js"), PROBE_JS);
  const loaded = await harness.runtime.loader.loadAll();
  // A fixture that did not load would turn every assertion below into a puzzle.
  if (loaded.errors.length > 0) throw new Error(`the fixture extension did not load: ${loaded.errors.join("; ")}`);

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
  // A desktop viewport, so the lower sidebar slot is in flow rather than in a
  // drawer that is only there on a narrow screen.
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
});

afterAll(async () => {
  // The browser closes its pages and the context with it, which is why nothing
  // per test closes them (see `context`).
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/** The file's one context, for a test that needs to open a page in it. */
function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

interface OpenedPage {
  readonly page: Page;
  readonly status: number | undefined;
  readonly consoleLines: string[];
  readonly pageErrors: string[];
}

/**
 * Open the conversation page with the policy watcher installed before any page
 * script runs. `blockCoreScript` cuts `ui-cards.js`, which is what makes the
 * parser's own shadow root observable.
 */
async function openPage(target: BrowserContext, path: string, blockCoreScript = false): Promise<OpenedPage> {
  const page = await target.newPage();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await page.addInitScript(() => {
    const probeWindow = window as unknown as { __csp?: string[] };
    probeWindow.__csp = [];
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        probeWindow.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
      },
      true,
    );
  });
  if (blockCoreScript) {
    await page.route("**/ui-cards.js", (route) => route.abort());
  }
  const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30000 });
  return { page, status: response?.status(), consoleLines, pageErrors };
}

/** Everything the browser can say about the card, in one read. */
async function readCard(page: Page): Promise<CardFacts> {
  return await page.evaluate(() => {
    const probeWindow = window as unknown as { __probeRuns?: number; __probeMounts?: number; __csp?: string[] };
    const host = document.querySelector(".ui-card[data-ui-card='probe']");
    const root = host === null ? null : host.shadowRoot;
    const read = (role: string): string | null => {
      const element = root?.querySelector(`[data-role='${role}']`);
      return element === undefined || element === null ? null : element.textContent;
    };
    const paragraph = root?.querySelector("p") ?? null;
    return {
      hostFound: host !== null,
      shadowRoot: root !== null && root !== undefined,
      templatesLeft: host === null ? -1 : host.querySelectorAll("template").length,
      lightChildren: host === null ? -1 : host.children.length,
      runs: probeWindow.__probeRuns ?? 0,
      mounts: probeWindow.__probeMounts ?? 0,
      state: read("state"),
      event: read("event"),
      answer: read("answer"),
      color: paragraph === null ? null : getComputedStyle(paragraph).color,
      violations: probeWindow.__csp ?? [],
    };
  });
}

/** The console lines that report a policy refusal, which are the ones that matter here. */
function cspConsoleLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("Content Security Policy") || line.includes("CSP"));
}

it("makes the server's card a parser shadow root and runs its module script under the page policy", async () => {
  const opened = await openPage(currentContext(), "/basic-chat", true);

  // The card's module script counts itself before it looks for the page's API, so
  // a count of one proves it ran even though `ui-cards.js` never did.
  await opened.page.waitForFunction(
    () => (window as unknown as { __probeRuns?: number }).__probeRuns === 1,
    undefined,
    { timeout: 20000 },
  );
  const facts = await readCard(opened.page);

  expect(opened.status).toBe(200);
  expect(facts.hostFound).toBe(true);
  // The parser attached the shadow root and consumed the template: with the core
  // script blocked, nothing else on the page can have done either.
  expect(facts.shadowRoot).toBe(true);
  expect(facts.templatesLeft).toBe(0);
  expect(facts.lightChildren).toBe(0);
  expect(facts.runs).toBe(1);
  // Nothing called the page's `define`, so the card is still as the server drew it.
  expect(facts.mounts).toBe(0);
  expect(facts.state).toBe("server");
  // The card's own stylesheet arrived under the response's nonce, so it applied.
  expect(facts.color).toBe("rgb(1, 2, 3)");

  console.log(`[test 1] console: ${opened.consoleLines.length === 0 ? "(none)" : opened.consoleLines.join(" | ")}`);
  console.log(`[test 1] page errors: ${opened.pageErrors.length === 0 ? "(none)" : opened.pageErrors.join(" | ")}`);
  expect(opened.pageErrors, "the page threw").toEqual([]);
  expect(facts.violations).toEqual([]);
  expect(cspConsoleLines(opened.consoleLines)).toEqual([]);
});

it("mounts the card, reaches its action through api.call, and hands it a published event", async () => {
  const opened = await openPage(currentContext(), "/basic-chat");

  await opened.page.waitForFunction(
    () => {
      const host = document.querySelector(".ui-card[data-ui-card='probe']");
      const root = host === null ? null : host.shadowRoot;
      const text = (role: string): string => {
        const element = root?.querySelector(`[data-role='${role}']`);
        return element === undefined || element === null ? "" : (element.textContent ?? "");
      };
      return text("state") === "mounted" && text("answer") === "answer 42" && text("event") === "ping 41";
    },
    undefined,
    { timeout: 30000 },
  );
  const facts = await readCard(opened.page);

  expect(opened.status).toBe(200);
  expect(facts.shadowRoot).toBe(true);
  expect(facts.runs).toBe(1);
  // One define, one host, one mount: a second run would show here.
  expect(facts.mounts).toBe(1);
  expect(facts.state).toBe("mounted");
  expect(facts.answer).toBe("answer 42");
  expect(facts.event).toBe("ping 41");
  expect(facts.color).toBe("rgb(1, 2, 3)");

  console.log(`[test 2] console: ${opened.consoleLines.length === 0 ? "(none)" : opened.consoleLines.join(" | ")}`);
  console.log(`[test 2] page errors: ${opened.pageErrors.length === 0 ? "(none)" : opened.pageErrors.join(" | ")}`);
  expect(opened.pageErrors, "the page threw").toEqual([]);
  expect(facts.violations).toEqual([]);
  expect(cspConsoleLines(opened.consoleLines)).toEqual([]);
});
