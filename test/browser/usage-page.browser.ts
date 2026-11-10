/**
 * The usage page in a real browser: one card per row, the bars, and the answer
 * the server writes into the page so the cards draw without a second request.
 *
 * `test/usage-web.test.ts` draws the same cards in jsdom, and jsdom lays nothing
 * out: it has no viewport, no used widths, and no size that came from a
 * stylesheet. Every condition this file checks is one of those. All the cards sit
 * in one column with the same left edge and the same width, each on a row of its
 * own. A card's name is never cut short. A phone-width page does not scroll
 * sideways. A bar's fill is the share the provider stated, measured against the
 * track it sits in.
 *
 * Provider ids that do exist are used: `anthropic`, `synthetic` and `deepseek`,
 * whose readers bring a bar and thirty daily columns, and `openai`, whose balance
 * no API states, so its card draws the sentence and the billing link. Two cards
 * have no provider at all and are checked here as well: the decision models card,
 * which counts the audit trail's judgement lines, and the extension card in the
 * slot. No test here reaches a provider: `globalThis.fetch` is replaced for the
 * life of this file, the replacement answers the three endpoints those readers
 * call, and it throws on every other address.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { ANTHROPIC_USAGE_URL, DEEPSEEK_BALANCE_URL, SYNTHETIC_QUOTAS_URL } from "../../src/server/usage/fetchers.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

// Chromium needs X11/atk/gbm libraries that a minimal Linux image may not ship, and there may be no
// root to install them. They are unpacked from Fedora RPMs into a local
// prefix instead; point the dynamic linker at it before launching. Same as
// scripts/ui-probe.mjs and `ui-cards.browser.ts`.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}

// A host may have no GPU, and the GPU process may not start at all, so
// rendering stays on the CPU inside the browser process. Same args as
// `ui-cards.browser.ts`.
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

/** The two widths every condition is checked at: a desktop and a phone. */
const VIEWPORTS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: 390, height: 900 },
] as const;

/** The share of the five-hour window the fake Anthropic answer states. */
const FIVE_HOUR_UTILIZATION = 43;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the fake Anthropic usage endpoint answers.
 *
 * The five-hour window is the one this file measures: 43% used, so its fill must
 * be 43% of its track. The weekly window and the credits are here so the card is
 * drawn as a whole rather than as one field.
 */
const ANTHROPIC_ANSWER = {
  five_hour: { utilization: FIVE_HOUR_UTILIZATION, resets_at: "2026-10-25T12:00:00Z" },
  seven_day: { utilization: 12, resets_at: "2026-10-28T00:00:00Z" },
  extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, currency: "USD" },
  spend: { enabled: true, used: { amount: 12.5, currency: "USD" }, limit: { amount: 50, currency: "USD" }, balance: null },
};

/** What the fake DeepSeek balance endpoint answers: one balance, in dollars. */
const DEEPSEEK_ANSWER = {
  is_available: true,
  balance_infos: [{ currency: "USD", total_balance: "11.25", granted_balance: "0.00", topped_up_balance: "11.25" }],
};

/**
 * What the fake synthetic.new quota endpoint answers.
 *
 * The plan block is the one a real account answers: the share that remains and the
 * share that comes back at the next regeneration, and no credit amounts at all.
 */
const SYNTHETIC_ANSWER = {
  planWeeklyLimit: { percentRemaining: 96, nextRegenAt: "2026-10-28T00:00:00Z", nextRegenPercent: 2 },
};

/** Every address the fake fetch was asked for, in order. A stray one shows up here. */
const fetched: string[] = [];

/** A success answer with a JSON body, which is all a reader reads. */
function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** The address of a `fetch` call, whatever shape the caller passed. */
function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const candidate = input as { url?: unknown } | null;
  return typeof candidate?.url === "string" ? candidate.url : String(input);
}

/**
 * One judgement line, as `Judges#writeAudit` writes it.
 *
 * The card sums these, so the numbers the browser draws come from lines of the
 * shape the daemon writes rather than from a literal in this file.
 */
function judgeLine(at: number, outcome: "answered" | "failed"): string {
  return `${JSON.stringify({
    time: at,
    type: "judge",
    judge: "report-check",
    provider: "openai",
    model: "gpt-6-luna",
    outcome,
    ...(outcome === "answered" ? {} : { reason: "provider" }),
    refused: [],
    elapsedMs: 120,
    inputTokens: 300,
    outputTokens: 100,
    totalTokens: 400,
    costUsd: 0.0004,
  })}\n`;
}

/**
 * The one fetch this file allows.
 *
 * Anything that is not one of the two provider endpoints throws, so a real
 * network call cannot happen: a reader that asks somewhere else fails loudly in
 * this file rather than quietly reaching the internet.
 */
const fakeFetch = (async (input: unknown): Promise<Response> => {
  const url = urlOf(input);
  fetched.push(url);
  if (url === ANTHROPIC_USAGE_URL) return fakeResponse(ANTHROPIC_ANSWER);
  if (url === DEEPSEEK_BALANCE_URL) return fakeResponse(DEEPSEEK_ANSWER);
  if (url === SYNTHETIC_QUOTAS_URL) return fakeResponse(SYNTHETIC_ANSWER);
  throw new Error(`this test answers no request for ${url}`);
}) as unknown as typeof globalThis.fetch;

/** The real fetch, put back when the file ends. */
const realFetch = globalThis.fetch;

/** A catalog with two logins that have auth: a subscription and an API key. */
interface Catalog {
  readonly providers: { id: string; name?: string }[];
  readonly configured: Set<string>;
  readonly subscription: Set<string>;
  /** The credential each provider signs its calls with. */
  readonly auth: ReadonlyMap<string, string>;
}

/**
 * The four questions the usage route asks the catalog, answered from one object.
 * The same shape `test/usage-page.test.ts` hands the route.
 */
function modelsOf(catalog: Catalog): Models {
  return {
    getProviders: () => catalog.providers,
    hasConfiguredAuth: (providerId: string) => catalog.configured.has(providerId),
    isUsingSubscription: (providerId: string) => catalog.subscription.has(providerId),
    getAuth: async (providerId: string) => {
      const key = catalog.auth.get(providerId);
      return key === undefined ? undefined : { auth: { apiKey: key } };
    },
  } as unknown as Models;
}

/**
 * One paid call a day for the last thirty days, so every daily column of that
 * provider's card has a cost to stand on. The costs differ, so the columns are not
 * all the same height, and `scale` keeps one provider's amounts apart from another's.
 */
function addLedgerDays(path: string, provider: string, now: number, scale = 1): void {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS entries (" +
      " id INTEGER PRIMARY KEY," +
      " conversation_id INTEGER NOT NULL," +
      " head INTEGER," +
      " commit_seq INTEGER NOT NULL," +
      " record TEXT NOT NULL CHECK (json_valid(record))" +
      ") STRICT",
  );
  const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (NULL, 1, NULL, 1, ?)");
  for (let back = 0; back < 30; back += 1) {
    // The middle of the day slot, so a few milliseconds of drift cannot move the
    // row into a neighbouring slot.
    const at = now - (back + 0.5) * DAY_MS;
    const record = {
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          provider,
          timestamp: at,
          usage: { totalTokens: (500 + back * 10) * scale, cost: { total: (0.02 + (back % 7) * 0.01) * scale } },
        },
      ],
    };
    insert.run(JSON.stringify(record));
  }
  db.close();
}

/**
 * A card in the usage slot, from an extension name that exists nowhere else.
 *
 * It is a plain block of markup with one line of its own, and the extension
 * brings a colour: the page's policy names the style nonce only when a card
 * rendered, and a rule that reached the page would show here.
 */
const DEMO_USAGE = `
export const name = "demo-usage";
export function create() {
  return { name: "demo-usage" };
}
export const ui = {
  cards: [{ slot: "usage.cards", name: "allowance" }],
  render() {
    return {
      html: '<p class="demo-usage-line">Team allowance: 1,200 of 2,000 left this month</p>',
      css: "p { margin: 0; color: rgb(1, 2, 3); }",
    };
  },
};
`;

/** One card as the browser laid it out, in CSS pixels from the viewport's corner. */
interface CardRect {
  readonly kind: "provider" | "slot";
  readonly label: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** One card name, and whether its text fits inside it. */
interface NameFacts {
  readonly text: string;
  readonly width: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}

/** Everything the page reports about its layout and its drawings, in one read. */
interface PageFacts {
  readonly documentScrollWidth: number;
  /** The page's own scroll area: a card that overflows widens this before the document. */
  readonly scrollClientWidth: number;
  readonly scrollWidth: number;
  readonly cards: readonly CardRect[];
  readonly names: readonly NameFacts[];
  /** The extension card's own shadow root was attached and holds its markup. */
  readonly slotDrawn: boolean;
  /** The five-hour bar: the fill's width, the track's width and the label beside them. */
  readonly fiveHour: { readonly fill: number; readonly track: number; readonly label: string } | null;
  /** The prepaid card's daily columns. */
  readonly days: { readonly count: number; readonly heights: readonly number[] } | null;
  /** The row names of one provider's card, in the order the page drew them. */
  readonly rowNames: Readonly<Record<string, readonly string[]>>;
  /** The note line under one provider's card, or an empty string. */
  readonly notes: Readonly<Record<string, string>>;
  /** The two subscription cards' own daily columns, with their heights. */
  readonly subscriptionDays: Readonly<Record<string, readonly number[]>>;
  /** The OpenAI card's balance row: its sentence, and the link it draws with it. */
  readonly openaiBalance: {
    readonly note: string;
    readonly linkText: string;
    readonly linkHref: string;
    /** True when the row draws no number and no `WIP`. */
    readonly numberAbsent: boolean;
  } | null;
  /** The decision models card: its name, its note and its rows. */
  readonly judges: {
    readonly name: string;
    readonly chip: string;
    readonly note: string;
    readonly rows: readonly { readonly title: string; readonly lines: readonly string[] }[];
    readonly top: number;
    readonly bottom: number;
  } | null;
  readonly violations: readonly string[];
}

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
/**
 * One context for the whole file. Chromium runs here with `--single-process`, and
 * closing a context in that mode closed the whole browser. Each test opens its own
 * page at its own width, and the context goes with the browser in `afterAll`.
 */
let context: BrowserContext | undefined;
let origin = "";

beforeAll(async () => {
  // Installed before the server starts, so the first provider read already meets
  // the fake answer.
  globalThis.fetch = fakeFetch;

  harness = await createTestHarness({
    config: { timezone: "Asia/Tokyo", server: { ...defaultConfig().server, port: 0 } },
  });
  // Every provider's ledger, so the prepaid card and the two subscription cards
  // each have thirty daily columns with a cost of their own.
  addLedgerDays(harness.paths.stateDb, "deepseek", Date.now());
  addLedgerDays(harness.paths.stateDb, "synthetic", Date.now(), 10);
  addLedgerDays(harness.paths.stateDb, "anthropic", Date.now(), 100);
  addLedgerDays(harness.paths.stateDb, "openai", Date.now(), 1000);
  // The judgement lines of the audit trail, which the decision models card sums.
  // Two answered calls today and one failure, all of them `report-check`.
  await writeFile(
    harness.paths.auditLog,
    [
      judgeLine(Date.now() - 60 * 60 * 1000, "answered"),
      judgeLine(Date.now() - 2 * 60 * 60 * 1000, "answered"),
      judgeLine(Date.now() - 3 * 60 * 60 * 1000, "failed"),
    ].join(""),
    "utf8",
  );

  const dir = join(harness.paths.extensionsDir, "demo-usage");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), DEMO_USAGE);
  const loaded = await harness.runtime.loader.loadAll();
  // A fixture that did not load would turn every layout assertion into a puzzle.
  if (loaded.errors.length > 0) throw new Error(`the fixture extension did not load: ${loaded.errors.join("; ")}`);

  const catalog: Catalog = {
    providers: [
      { id: "anthropic", name: "Anthropic" },
      { id: "synthetic", name: "synthetic.new" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "openai", name: "OpenAI" },
    ],
    configured: new Set(["anthropic", "synthetic", "deepseek", "openai"]),
    subscription: new Set(["anthropic", "synthetic"]),
    auth: new Map([
      ["anthropic", "fixture-subscription-token"],
      ["synthetic", "fixture-synthetic-key"],
      ["deepseek", "fixture-api-key"],
      ["openai", "fixture-openai-key"],
    ]),
  };
  // One judge the config names, so the decision models card has its row.
  const runtime = {
    ...harness.runtime,
    models: modelsOf(catalog),
    getConfig: () => ({ ...harness!.config, judges: { "report-check": { provider: "openai", modelId: "gpt-6-luna" } } }),
  };
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: builtWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: builtWebDir(), ui: { renderTimeoutMs: 2000 }, usage: { models: () => runtime.models as never, fetch: fakeFetch } });
  origin = started.origin;

  try {
    browser = await chromium.launch({ args: LAUNCH_ARGS });
  } catch (error) {
    throw new Error(`chromium did not launch: ${error instanceof Error ? error.message : String(error)}`);
  }
  context = await browser.newContext({ viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height } });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/**
 * Wait until the server holds both provider values.
 *
 * The server asks each provider once when it starts, without delaying the start,
 * so a page opened by a test may arrive before that one read finished. Asking for
 * the answer here is the same request the page would make, and it shares the read
 * that is already in flight, so it adds no call.
 */
async function waitForHeldValues(): Promise<void> {
  const deadline = Date.now() + 20000;
  for (;;) {
    // The real fetch: `globalThis.fetch` is the fake the providers are answered
    // with, and this request goes to the server this file started.
    const answer = (await (await realFetch(`${origin}/api/usage`)).json()) as { cards: { receivedAt: unknown }[] };
    // The OpenAI card never receives a value from its provider, so it is the one
    // card this waits for a judgement row instead. Its `receivedAt` stays null.
    const held = answer.cards.filter((card) => (card as { provider?: string }).provider !== "openai");
    if (answer.cards.length === 4 && held.every((card) => card.receivedAt !== null)) return;
    if (Date.now() > deadline) throw new Error("the server never held a provider value");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
 * Open the usage page at one width, with the policy watcher installed before any
 * page script runs. It waits until the provider cards are drawn and the daily
 * columns exist, so a measurement never runs against a page still being built.
 */
async function openUsage(width: number, height: number): Promise<OpenedPage> {
  const page = await currentContext().newPage();
  await page.setViewportSize({ width, height });
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
  const response = await page.goto(`${origin}/usage`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => {
      // Four provider cards and the decision models card, which is not a provider.
      const providers = document.querySelectorAll("#usage-cards article.usage-card[data-provider]").length;
      const judges = document.querySelectorAll('#usage-cards article.usage-card[data-card="judges"] .usage-field').length;
      const days = document.querySelectorAll('#usage-cards article.usage-card[data-provider="deepseek"] .usage-day').length;
      const slot = document.querySelector('.usage-slot [data-ui-slot="usage.cards"] > .ui-card');
      const drawn = slot !== null && slot.shadowRoot !== null && (slot.shadowRoot.textContent ?? "").includes("Team allowance");
      return providers === 4 && judges === 1 && days === 30 && drawn;
    },
    undefined,
    { timeout: 30000 },
  );
  return { page, status: response?.status(), consoleLines, pageErrors };
}

/** Everything the page can say about its layout and its drawings, in one read. */
async function readFacts(page: Page): Promise<PageFacts> {
  return await page.evaluate(() => {
    const rectOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };

    // The decision models card is an `article.usage-card` too, but it names no
    // provider: it is read on its own, below.
    const providerCards = [...document.querySelectorAll("#usage-cards article.usage-card[data-provider]")];
    // The outermost element of a slot card is the host the server drew: a direct
    // child of the slot, with the card's identity on it (see `cardMarkup` in
    // src/server/ui-page.ts).
    const slotCards = [...document.querySelectorAll('.usage-slot [data-ui-slot="usage.cards"] > .ui-card')];

    const cards = [
      ...providerCards.map((element) => ({
        kind: "provider" as const,
        label: element.getAttribute("data-provider") ?? "",
        ...rectOf(element),
      })),
      ...slotCards.map((element) => ({
        kind: "slot" as const,
        label: `${element.getAttribute("data-ui-extension")}/${element.getAttribute("data-ui-card")}`,
        ...rectOf(element),
      })),
    ];

    const names = [...document.querySelectorAll("h2.usage-card-name")].map((element) => ({
      text: (element.textContent ?? "").trim(),
      width: element.getBoundingClientRect().width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));

    const slotHost = slotCards[0] ?? null;
    const slotDrawn =
      slotHost !== null && slotHost.shadowRoot !== null && (slotHost.shadowRoot.textContent ?? "").includes("Team allowance");

    const anthropic = document.querySelector('#usage-cards article.usage-card[data-provider="anthropic"]');
    const fieldOf = (card: Element | null, name: string): Element | null => {
      if (card === null) return null;
      for (const field of card.querySelectorAll(".usage-field")) {
        if ((field.querySelector(".usage-field-name")?.textContent ?? "") === name) return field;
      }
      return null;
    };
    const fiveHourField = fieldOf(anthropic, "5-hour limit");
    const track = fiveHourField?.querySelector(".usage-bar") ?? null;
    const fill = fiveHourField?.querySelector(".usage-bar-fill") ?? null;
    const fiveHour =
      track === null || fill === null
        ? null
        : {
            track: track.getBoundingClientRect().width,
            fill: fill.getBoundingClientRect().width,
            label: (fiveHourField?.querySelector(".usage-value")?.textContent ?? "").trim(),
          };

    const deepseek = document.querySelector('#usage-cards article.usage-card[data-provider="deepseek"]');
    const columns = deepseek === null ? [] : [...deepseek.querySelectorAll(".usage-day")];
    const days =
      deepseek === null
        ? null
        : { count: columns.length, heights: columns.map((column) => column.getBoundingClientRect().height) };

    const rowNames: Record<string, string[]> = {};
    const notes: Record<string, string> = {};
    const subscriptionDays: Record<string, number[]> = {};
    for (const provider of ["anthropic", "synthetic", "deepseek", "openai"]) {
      const card = document.querySelector(`#usage-cards article.usage-card[data-provider="${provider}"]`);
      if (card === null) continue;
      rowNames[provider] = [...card.querySelectorAll(".usage-field")].map(
        (field) => (field.querySelector(".usage-field-name")?.textContent ?? "").trim(),
      );
      notes[provider] = (card.querySelector(".usage-note")?.textContent ?? "").trim();
      subscriptionDays[provider] = [...card.querySelectorAll(".usage-day")].map(
        (column) => column.getBoundingClientRect().height,
      );
    }

    const openai = document.querySelector('#usage-cards article.usage-card[data-provider="openai"]');
    const openaiField = fieldOf(openai, "Prepaid balance");
    const link = openaiField?.querySelector("a") ?? null;
    const openaiBalance =
      openaiField === null
        ? null
        : {
            note: (openaiField.querySelector(".usage-balance-note")?.textContent ?? "").trim(),
            linkText: (link?.textContent ?? "").trim(),
            linkHref: link?.getAttribute("href") ?? "",
            numberAbsent:
              openaiField.querySelector(".usage-balance") === null && openaiField.querySelector(".usage-wip") === null,
          };

    const judgesCard = document.querySelector('#usage-cards article.usage-card[data-card="judges"]');
    const judges = {
      name: (judgesCard?.querySelector(".usage-card-name")?.textContent ?? "").trim(),
      chip: (judgesCard?.querySelector(".usage-chip")?.textContent ?? "").trim(),
      note: (judgesCard?.querySelector(".usage-note")?.textContent ?? "").trim(),
      rows: [...(judgesCard?.querySelectorAll('[data-judge]') ?? [])].map((row) => ({
        title: (row.querySelector(".usage-field-name")?.textContent ?? "").trim(),
        lines: [...row.querySelectorAll(".usage-line")].map((line) => (line.textContent ?? "").trim()),
      })),
      top: judgesCard === null ? -1 : judgesCard.getBoundingClientRect().top,
      bottom: judgesCard === null ? -1 : judgesCard.getBoundingClientRect().bottom,
    };

    const scroller = document.querySelector(".usage-scroll");
    const probeWindow = window as unknown as { __csp?: string[] };
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      scrollClientWidth: scroller === null ? -1 : scroller.clientWidth,
      scrollWidth: scroller === null ? -1 : scroller.scrollWidth,
      cards,
      names,
      slotDrawn,
      fiveHour,
      days,
      rowNames,
      notes,
      subscriptionDays,
      openaiBalance,
      judges,
      violations: probeWindow.__csp ?? [],
    };
  });
}

/** The console lines that report a policy refusal, which are the ones that matter here. */
function cspConsoleLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("Content Security Policy") || line.includes("CSP"));
}

/** Every condition, checked against one reading of one width. */
function expectEveryCondition(facts: PageFacts, opened: OpenedPage, width: number): void {
  // 1. Five cards, in one column, each on a row of its own: four provider cards,
  //    then the decision models card, then the extension's card in the slot.
  expect(facts.cards.map((card) => `${card.kind}:${card.label}`)).toEqual([
    "provider:anthropic",
    "provider:synthetic",
    "provider:deepseek",
    "provider:openai",
    "slot:demo-usage/allowance",
  ]);
  expect(facts.slotDrawn).toBe(true);
  const judges = facts.judges;
  if (judges === null) throw new Error("the page drew no decision models card");
  // The judgement card sits between the last provider card and the slot.
  expect(judges.top).toBeGreaterThanOrEqual(facts.cards[3]!.bottom);
  expect(facts.cards[4]!.top).toBeGreaterThanOrEqual(judges.bottom);
  const byRow = [...facts.cards].sort((left, right) => left.top - right.top);
  const first = byRow[0];
  if (first === undefined) throw new Error("the page drew no card");
  expect(first.height).toBeGreaterThan(0);
  for (let index = 1; index < byRow.length; index += 1) {
    const before = byRow[index - 1]!;
    const card = byRow[index]!;
    // No two vertical ranges overlap: every card starts below the one above it.
    expect(card.top).toBeGreaterThanOrEqual(before.bottom);
    expect(card.height).toBeGreaterThan(0);
  }
  for (const card of facts.cards) {
    expect(Math.abs(card.left - first.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.width - first.width)).toBeLessThanOrEqual(1);
  }

  // 2. Every card name is drawn, and none is cut short. The decision models card
  //    has a name of its own and no provider.
  expect(facts.names.map((name) => name.text)).toEqual([
    "Anthropic",
    "synthetic.new",
    "DeepSeek",
    "OpenAI",
    "Decision models",
  ]);
  for (const name of facts.names) {
    expect(name.width).toBeGreaterThan(0);
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  }

  // 3. A phone-width page does not scroll sideways, and no card crosses the edge.
  if (width <= 390) {
    expect(facts.documentScrollWidth).toBeLessThanOrEqual(390);
    for (const card of facts.cards) expect(card.right).toBeLessThanOrEqual(390);
    // The scroll area is the page's own box. `overflow-y: auto` makes a `visible`
    // horizontal axis `auto` too, so a card wider than the phone widens this box
    // before it reaches the document: the two readings together are the whole of
    // "the page does not scroll sideways".
    expect(facts.scrollClientWidth).toBeGreaterThan(0);
    expect(facts.scrollWidth).toBeLessThanOrEqual(facts.scrollClientWidth + 1);
  }

  // 4. The five-hour fill is the share the provider stated, and the prepaid card
  //    has one column per day with a height of its own.
  const fiveHour = facts.fiveHour;
  if (fiveHour === null) throw new Error("the subscription card drew no five-hour bar");
  expect(fiveHour.label).toBe(`${FIVE_HOUR_UTILIZATION}%`);
  expect(fiveHour.track).toBeGreaterThan(0);
  expect(Math.abs(fiveHour.fill - fiveHour.track * (FIVE_HOUR_UTILIZATION / 100))).toBeLessThanOrEqual(1);
  const days = facts.days;
  if (days === null) throw new Error("the prepaid card was not drawn");
  expect(days.count).toBe(30);
  for (const height of days.heights) expect(height).toBeGreaterThan(0);

  // 5. The two subscription cards draw pi-sec's own rows under the provider's:
  //    four on synthetic.new, one on Anthropic, each with thirty columns. The
  //    provider's own rows keep their place above them, and each card states what
  //    its cost is.
  expect(facts.rowNames["synthetic"]).toEqual([
    "Weekly limit",
    "Credits",
    "Last 24 hours",
    "Last 7 days",
    "Last 30 days",
    "Usage per day",
  ]);
  expect(facts.rowNames["anthropic"]).toEqual([
    "5-hour limit",
    "Weekly limit",
    "Credits",
    "Usage per day",
  ]);
  expect(facts.rowNames["deepseek"]).toEqual([
    "Prepaid balance",
    "Last 24 hours",
    "Last 7 days",
    "Last 30 days",
    "Usage per day",
  ]);
  expect(facts.rowNames["openai"]).toEqual([
    "Prepaid balance",
    "Last 24 hours",
    "Last 7 days",
    "Last 30 days",
    "Usage per day",
  ]);
  expect(facts.notes["synthetic"]).toBe("pi-sec calls only · estimated credit use at subscription rates");
  expect(facts.notes["anthropic"]).toBe("pi-sec calls only · API-equivalent cost");
  expect(facts.notes["deepseek"]).toBe("pi-sec calls only · estimated cost · Peak/off-peak rates applied · holidays ignored");
  expect(facts.notes["openai"]).toBe("pi-sec calls only · estimated cost");
  for (const provider of ["synthetic", "anthropic"]) {
    const heights = facts.subscriptionDays[provider] ?? [];
    expect(heights, provider).toHaveLength(30);
    for (const height of heights) expect(height, provider).toBeGreaterThan(0);
  }

  // 6. The OpenAI card states the sentence and the billing link in its balance
  //    row, and draws no number and no `WIP` there. It sits on its own row with
  //    the same left edge as every other card.
  const balance = facts.openaiBalance;
  if (balance === null) throw new Error("the OpenAI card drew no balance row");
  expect(balance.note).toBe("No API for the balance");
  expect(balance.linkText).toBe("OpenAI billing page");
  expect(balance.linkHref).toBe("https://platform.openai.com/settings/organization/billing");
  expect(balance.numberAbsent).toBe(true);

  // 7. The decision models card names the judge and its model, states the three
  //    windows of it, and says what its numbers are not.
  expect(judges.name).toBe("Decision models");
  expect(judges.chip).toBe("judges");
  expect(judges.rows).toHaveLength(1);
  expect(judges.rows[0]?.title).toBe("report-check · openai/gpt-6-luna");
  expect(judges.rows[0]?.lines).toHaveLength(3);
  // Three judgement lines were written, all inside the last 24 hours, and one of
  // them failed.
  expect(judges.rows[0]?.lines[0]).toBe("Last 24 hours: 3 calls · 1,200 tokens · $0.0012 · 1 unanswered");
  expect(judges.rows[0]?.lines[2]).toBe("Last 30 days: 3 calls · 1,200 tokens · $0.0012 · 1 unanswered");
  expect(judges.note).toBe("pi-sec's own judgement calls · not counted in the provider cards");

  // 8. Nothing on the page was refused by its own policy.
  expect(facts.violations).toEqual([]);
  expect(cspConsoleLines(opened.consoleLines)).toEqual([]);
}

it("draws one card per row in one column at 1280 wide, with the bars the values state", async () => {
  const viewport = VIEWPORTS[0];
  const opened = await openUsage(viewport.width, viewport.height);
  const facts = await readFacts(opened.page);

  expect(opened.status).toBe(200);
  expectEveryCondition(facts, opened, viewport.width);

  console.log(
    `[${viewport.name}] cards: ` +
      facts.cards.map((card) => `${card.label} left=${card.left.toFixed(2)} width=${card.width.toFixed(2)} top=${card.top.toFixed(2)} bottom=${card.bottom.toFixed(2)}`).join(" | "),
  );
  console.log(
    `[${viewport.name}] five-hour fill=${facts.fiveHour?.fill.toFixed(2)} track=${facts.fiveHour?.track.toFixed(2)} ` +
      `days=${facts.days?.count} scrollWidth=${facts.documentScrollWidth} scrollArea=${facts.scrollWidth}/${facts.scrollClientWidth} violations=${facts.violations.length}`,
  );
  console.log(`[${viewport.name}] console: ${opened.consoleLines.length === 0 ? "(none)" : opened.consoleLines.join(" | ")}`);
  console.log(`[${viewport.name}] page errors: ${opened.pageErrors.length === 0 ? "(none)" : opened.pageErrors.join(" | ")}`);
  expect(opened.pageErrors, "the page threw").toEqual([]);
});

it("keeps the same column inside a phone's width at 390 wide", async () => {
  const viewport = VIEWPORTS[1];
  const opened = await openUsage(viewport.width, viewport.height);
  const facts = await readFacts(opened.page);

  expect(opened.status).toBe(200);
  expectEveryCondition(facts, opened, viewport.width);

  console.log(
    `[${viewport.name}] cards: ` +
      facts.cards.map((card) => `${card.label} left=${card.left.toFixed(2)} width=${card.width.toFixed(2)} top=${card.top.toFixed(2)} bottom=${card.bottom.toFixed(2)}`).join(" | "),
  );
  console.log(
    `[${viewport.name}] five-hour fill=${facts.fiveHour?.fill.toFixed(2)} track=${facts.fiveHour?.track.toFixed(2)} ` +
      `days=${facts.days?.count} scrollWidth=${facts.documentScrollWidth} scrollArea=${facts.scrollWidth}/${facts.scrollClientWidth} violations=${facts.violations.length}`,
  );
  console.log(`[${viewport.name}] console: ${opened.consoleLines.length === 0 ? "(none)" : opened.consoleLines.join(" | ")}`);
  console.log(`[${viewport.name}] page errors: ${opened.pageErrors.length === 0 ? "(none)" : opened.pageErrors.join(" | ")}`);
  expect(opened.pageErrors, "the page threw").toEqual([]);
});

it("catches a style its own policy refuses, so an empty violation list means something", async () => {
  const viewport = VIEWPORTS[0];
  const opened = await openUsage(viewport.width, viewport.height);

  // The page as the server sent it is clean.
  expect((await readFacts(opened.page)).violations).toEqual([]);

  // A style element written by a script carries no nonce, so `style-src 'self'
  // '<nonce>'` refuses it. A watcher that misses this would report every page as
  // clean, and the check in the two tests above would prove nothing.
  await opened.page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".usage-card { outline: 3px solid red; }";
    document.head.appendChild(style);
  });
  await opened.page.waitForFunction(
    () => ((window as unknown as { __csp?: string[] }).__csp ?? []).length > 0,
    undefined,
    { timeout: 10000 },
  );

  const refused = (await readFacts(opened.page)).violations;
  expect(refused.length).toBeGreaterThan(0);
  expect(refused.join(" ")).toContain("style-src");
  expect(cspConsoleLines(opened.consoleLines).length).toBeGreaterThan(0);

  console.log(`[control] violations: ${refused.join(" | ")}`);
});

it("draws the cards with the page, and asks for no usage answer again", async () => {
  await waitForHeldValues();
  const page = await currentContext().newPage();
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/usage") asked.push(request.url());
  });
  try {
    await page.goto(`${origin}/usage`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll("#usage-cards article.usage-card[data-provider]").length === 4,
      undefined,
      { timeout: 30000 },
    );
    // The card is drawn from the block the page was served with: no request for
    // the answer, so nothing waited for one.
    expect(asked).toEqual([]);
    const fiveHour = await page.evaluate(() => {
      const card = document.querySelector('#usage-cards article.usage-card[data-provider="anthropic"]');
      const line = card?.querySelector(".usage-value")?.textContent ?? "";
      return line.trim();
    });
    expect(fiveHour).toBe(`${FIVE_HOUR_UTILIZATION}%`);
    // The block is data, so the page's policy had nothing to refuse for it.
    const violations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    expect(violations).toEqual([]);

    // The watcher is a watcher: a request the page makes is seen, so the empty
    // list above is an absence and not a listener that never ran.
    await page.evaluate(() => {
      void fetch("/api/usage").catch(() => undefined);
    });
    for (let waited = 0; asked.length === 0 && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(asked).toHaveLength(1);
  } finally {
    await page.close();
  }
});

it("read the three provider answers from the fake endpoints and asked no other address", () => {
  // A positive control for the fake fetch: the bar above could not be 43% of its
  // track unless the Anthropic endpoint was asked.
  expect(fetched).toContain(ANTHROPIC_USAGE_URL);
  expect(fetched).toContain(DEEPSEEK_BALANCE_URL);
  expect(fetched).toContain(SYNTHETIC_QUOTAS_URL);
  // The list is every address this server asked for, whatever the reason, so an
  // OpenAI address would be here if the OpenAI card asked for one. It has none to
  // ask: its balance is a sentence and a link.
  const strays = fetched.filter(
    (url) => url !== ANTHROPIC_USAGE_URL && url !== DEEPSEEK_BALANCE_URL && url !== SYNTHETIC_QUOTAS_URL,
  );
  expect(strays).toEqual([]);
  expect(fetched.filter((url) => url.includes("openai"))).toEqual([]);
});
