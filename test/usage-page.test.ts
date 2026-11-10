/**
 * The usage page's two routes, over HTTP, with a fake catalog and a temporary
 * ledger.
 *
 * The page is a shell the server stamps, and the `usage.cards` slot below the
 * provider cards is filled by the server the way the chat page fills its own
 * slot: one host element per card, one style nonce in the policy when a card
 * rendered, and one line where a card failed. `GET /api/usage` is the read the
 * page's script draws from, and it is asked of the catalog on every request, so a
 * provider that gains auth between two requests has its card on the second.
 *
 * No test here reaches a provider: the one catalog that names a provider with a
 * reader is handed a fake fetch, and every other provider is a name this
 * repository does not ship, and so has no reader either.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { ANTHROPIC_USAGE_URL } from "../src/server/usage/fetchers.ts";
import type { UsageAnswer, UsageRefreshAnswer } from "../src/server/usage/values.ts";
import { withFirstPaint } from "../src/server/routes/usage.ts";
import type { UsageLedger } from "../src/server/usage/records.ts";
import type { UsageRouteOptions } from "../src/server/routes/usage.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/** The policy a page with no card carries. */
const CSP_BASE = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/** A catalog a test can change while the server runs. */
interface Catalog {
  readonly providers: { id: string; name?: string }[];
  readonly configured: Set<string>;
  readonly subscription: Set<string>;
  /** The key each provider signs its calls with, when a test plants one. */
  readonly auth?: ReadonlyMap<string, string>;
}

/** The four questions the usage route asks the catalog, answered from one object. */
function modelsOf(catalog: Catalog): Models {
  return {
    getProviders: () => catalog.providers,
    hasConfiguredAuth: (providerId: string) => catalog.configured.has(providerId),
    isUsingSubscription: (providerId: string) => catalog.subscription.has(providerId),
    getAuth: async (providerId: string) => {
      const key = catalog.auth?.get(providerId);
      return key === undefined ? undefined : { auth: { apiKey: key } };
    },
    // Nothing else this route calls is needed, and a member the route might ask
    // for in a later build is absent on purpose: the route has to survive a
    // catalog that answers only some of it.
  } as unknown as Models;
}

/** The usage answer a subscription account gets, for the one catalog with a reader. */
const ANTHROPIC_BODY = {
  five_hour: { utilization: 28, resets_at: "2026-10-26T11:59:59Z" },
  seven_day: { utilization: 72, resets_at: "2026-10-30T20:59:59Z" },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, currency: "USD" },
  spend: { enabled: false, used: { amount: 0, currency: "USD" }, limit: null, balance: null },
};

/** A fetch that answers the Anthropic endpoint and remembers every address it saw. */
function providerFetch(): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: unknown): Promise<unknown> => {
    const url = String(input);
    calls.push(url);
    if (url !== ANTHROPIC_USAGE_URL) throw new Error(`this test answers no request for ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(ANTHROPIC_BODY) };
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

/** The usage answer the page carries, read the way the page's script reads it. */
function firstPaintOf(page: string): UsageAnswer {
  const match = /<script type="application\/json" id="usage-first">([\s\S]*?)<\/script>/.exec(page);
  if (match === null) throw new Error("the page carries no usage data block");
  return JSON.parse(match[1] ?? "") as UsageAnswer;
}

/** One model call in the temporary ledger, so a prepaid card has numbers. */
function addLedgerRow(path: string, provider: string, at: number, cost: number): void {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS entries (" +
        " id INTEGER PRIMARY KEY," +
        " conversation_id INTEGER NOT NULL," +
        " head INTEGER," +
        " commit_seq INTEGER NOT NULL," +
        " record TEXT NOT NULL CHECK (json_valid(record))" +
        ") STRICT",
    );
  } catch (error) {
    throw new Error(`the test ledger could not be opened: ${String(error)}`);
  }
  const record = {
    kind: "pi.assistant",
    model: [{ role: "assistant", provider, timestamp: at, usage: { totalTokens: 500, cost: { total: cost } } }],
  };
  db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (NULL, 1, NULL, 1, ?)").run(
    JSON.stringify(record),
  );
  db.close();
}

interface BootOptions {
  readonly catalog: Catalog;
  readonly basePath?: string;
  readonly timezone?: string;
  readonly extension?: { readonly name: string; readonly body: string };
  /** The usage route's test settings, handed through the server's own options. */
  readonly usage?: UsageRouteOptions;
}

/** A harness with one temporary ledger and, when asked, one fixture extension. */
async function boot(options: BootOptions): Promise<string> {
  harness = await createTestHarness({
    config: {
      ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
      server: { ...defaultConfig().server, port: 0, ...(options.basePath === undefined ? {} : { basePath: options.basePath }) },
    },
  });
  addLedgerRow(harness.paths.stateDb, "fixture-meter", Date.now() - 60 * 60 * 1000, 0.25);
  if (options.extension !== undefined) {
    const dir = join(harness.paths.extensionsDir, options.extension.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.js"), options.extension.body);
    const loaded = await harness.runtime.loader.loadAll();
    expect(loaded.errors).toEqual([]);
  }
  const runtime = { ...harness.runtime, models: modelsOf(options.catalog) };
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, {
    webDir: defaultWebDir(),
    ui: { renderTimeoutMs: 50 },
    // The made-up catalog is handed to the route's own service as well, so a card
    // of this page is drawn from the catalog and the ledger this test built.
    usage: { models: () => modelsOf(options.catalog), ...(options.usage ?? {}) },
  });
  return started.origin;
}

/** A card in the usage slot: a made-up extension with a made-up card name. */
const USAGE_CARD = `
export const name = "fixture-meter";
export function create() {
  return { name: "fixture-meter" };
}
export const ui = {
  cards: [{ slot: "usage.cards", name: "allowance" }],
  render() {
    return { html: '<p class="allowance">1,200 of 2,000 left</p>', css: "p{color:teal}" };
  },
};
`;

/** The same slot, with a card that never draws. */
const BROKEN_USAGE_CARD = `
export const name = "fixture-meter";
export function create() {
  return { name: "fixture-meter" };
}
export const ui = {
  cards: [{ slot: "usage.cards", name: "allowance" }],
  render() {
    throw new Error("this card never draws");
  },
};
`;

describe("GET /usage", () => {
  it("serves the page with the provider cards first and the usage slot below them", async () => {
    const origin = await boot({ catalog: { providers: [], configured: new Set(), subscription: new Set() } });
    const response = await fetch(`${origin}/usage`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();

    const cards = page.indexOf('id="usage-cards"');
    const slot = page.indexOf('data-ui-slot="usage.cards"');
    expect(cards).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(cards);

    // The page's own assets and script, and the two meta values the mount uses.
    expect(page).toContain('src="/ui-usage.js"');
    expect(page).toContain('src="/base.js"');
    expect(page).toContain('src="/ui-cards.js"');
    expect(page).toContain('<meta name="pi-sec-base" content="" />');
    // No card rendered, so the policy is the one every other page carries.
    expect(response.headers.get("content-security-policy")).toBe(CSP_BASE);
  });

  it("fills the slot with the extension's card and names the style nonce in the policy", async () => {
    const origin = await boot({
      catalog: { providers: [], configured: new Set(), subscription: new Set() },
      extension: { name: "fixture-meter", body: USAGE_CARD },
    });
    const response = await fetch(`${origin}/usage`);
    const page = await response.text();

    expect(page).toContain('data-ui-extension="fixture-meter" data-ui-card="allowance"');
    expect(page).toContain('<p class="allowance">1,200 of 2,000 left</p>');
    expect(page).toContain("p{color:teal}");

    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(policy).toBe(CSP_BASE.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
    expect(page).toContain(`<style nonce="${nonce}">p{color:teal}</style>`);
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("script-src 'self' 'nonce");
  });

  it("leaves one failure line for a card that does not render", async () => {
    const origin = await boot({
      catalog: { providers: [], configured: new Set(), subscription: new Set() },
      extension: { name: "fixture-meter", body: BROKEN_USAGE_CARD },
    });
    const response = await fetch(`${origin}/usage`);
    const page = await response.text();

    expect(page).toContain("fixture-meter/allowance: failed to load");
    // The page around the slot is untouched, and a failed card brings no nonce.
    expect(page).toContain('id="usage-cards"');
    expect(response.headers.get("content-security-policy")).toBe(CSP_BASE);
  });

  it("follows the mount prefix in its assets and in its links", async () => {
    const origin = await boot({
      catalog: { providers: [], configured: new Set(), subscription: new Set() },
      basePath: "/sec",
      extension: { name: "fixture-meter", body: USAGE_CARD },
    });
    const page = await (await fetch(`${origin}/sec/usage`)).text();
    expect(page).toContain('<meta name="pi-sec-base" content="/sec" />');
    expect(page).toContain('src="/sec/ui-usage.js"');
    expect(page).toContain('href="/sec/basic-chat"');
  });
});

describe("the answer the page carries", () => {
  it("writes the answer it holds, and what a provider value is, into a JSON data block", async () => {
    const remote = providerFetch();
    const origin = await boot({
      catalog: {
        providers: [
          { id: "anthropic", name: "Anthropic" },
          { id: "fixture-meter", name: "Fixture Meter" },
        ],
        configured: new Set(["anthropic", "fixture-meter"]),
        subscription: new Set(["anthropic"]),
        auth: new Map([["anthropic", "fixture-subscription-token"]]),
      },
      timezone: "Asia/Tokyo",
      usage: { fetch: remote.fetch, prefetch: false },
    });

    const response = await fetch(`${origin}/usage`);
    const page = await response.text();
    const first = firstPaintOf(page);

    // A provider with a reader and no held value says its value is on the way,
    // which is the one thing that makes the page ask.
    expect(first.cards.map((card) => card.provider)).toEqual(["anthropic", "fixture-meter"]);
    expect(first.cards[0]?.fields["fiveHour"]).toEqual({ state: "reading" });
    // A provider with no reader keeps `wip`: no value is coming for it.
    expect(first.cards[1]?.fields["balance"]).toEqual({ state: "wip" });
    // pi-sec's own numbers are in the block, so the card draws them at once.
    expect(first.cards[1]?.fields["day"]).toMatchObject({ state: "value", value: { calls: 1, tokens: 500 } });
    expect(first.timezone).toBe("Asia/Tokyo");

    // Building the page asked no provider.
    expect(remote.calls).toEqual([]);
    expect(page).toContain('<script type="application/json" id="usage-first">');
    // The policy still names no script nonce: the block is data, never run.
    expect(response.headers.get("content-security-policy")).toBe(CSP_BASE);
  });

  it("writes a value with a `$` pattern into the data block as it is", () => {
    const answer = {
      generatedAt: 1,
      timezone: "UTC",
      cards: [{ provider: "p", name: "$& $' $` $$", shape: "usage", receivedAt: null, fields: {} }],
    } as unknown as UsageAnswer;
    const page = withFirstPaint("<p>x</p><!--usage-first--><p>y</p>", answer);
    expect(firstPaintOf(page)).toEqual(answer);
  });

  it("writes every angle bracket in the block as an escape, so no value can end the element", async () => {
    const origin = await boot({
      catalog: {
        providers: [{ id: "fixture-meter", name: "Fixture <Meter> & Co" }],
        configured: new Set(["fixture-meter"]),
        subscription: new Set(),
      },
      usage: { prefetch: false },
    });

    const page = await (await fetch(`${origin}/usage`)).text();
    const block = /<script type="application\/json" id="usage-first">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";

    expect(block).toContain("\\u003c");
    expect(block).not.toContain("<Meter>");
    // The escape is the JSON escape, so the page reads the name back unchanged.
    expect(firstPaintOf(page).cards[0]?.name).toBe("Fixture <Meter> & Co");
  });

  it("asks no provider while the page is built, however often the page is read", async () => {
    const remote = providerFetch();
    const origin = await boot({
      catalog: {
        providers: [{ id: "anthropic", name: "Anthropic" }],
        configured: new Set(["anthropic"]),
        subscription: new Set(["anthropic"]),
        auth: new Map([["anthropic", "fixture-subscription-token"]]),
      },
      usage: { fetch: remote.fetch, prefetch: false },
    });

    for (let index = 0; index < 3; index += 1) {
      expect((await fetch(`${origin}/usage`)).status).toBe(200);
    }
    expect(remote.calls).toEqual([]);
  });

  it("reads each provider once when the server starts, and the page then carries the value", async () => {
    const remote = providerFetch();
    const origin = await boot({
      catalog: {
        providers: [{ id: "anthropic", name: "Anthropic" }],
        configured: new Set(["anthropic"]),
        subscription: new Set(["anthropic"]),
        auth: new Map([["anthropic", "fixture-subscription-token"]]),
      },
      usage: { fetch: remote.fetch },
    });

    // The prefetch is not awaited by the start, so the test waits for its one call.
    for (let waited = 0; remote.calls.length === 0 && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(remote.calls).toEqual([ANTHROPIC_USAGE_URL]);

    const first = firstPaintOf(await (await fetch(`${origin}/usage`)).text());
    expect(first.cards[0]?.fields["fiveHour"]).toMatchObject({ state: "value", value: { utilization: 28 } });
    // The page still made no call of its own.
    expect(remote.calls).toEqual([ANTHROPIC_USAGE_URL]);
  });
});

describe("GET /api/usage", () => {
  it("answers one card per provider that has auth, and none for the rest", async () => {
    const catalog: Catalog = {
      providers: [
        { id: "fixture-meter", name: "Fixture Meter" },
        { id: "absent-provider", name: "Absent Provider" },
      ],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });
    const response = await fetch(`${origin}/api/usage`);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as UsageAnswer;

    expect(answer.cards.map((card) => card.provider)).toEqual(["fixture-meter"]);
    const card = answer.cards[0]!;
    expect(card.name).toBe("Fixture Meter");
    expect(card.shape).toBe("prepaid");
    // The balance has no reader, so it says so; the windows come from the ledger.
    expect(card.fields["balance"]).toEqual({ state: "wip" });
    expect(card.fields["day"]).toMatchObject({ state: "value", value: { calls: 1, tokens: 500 } });
  });

  it("has the card of a provider that gains auth between two requests", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });

    const first = (await (await fetch(`${origin}/api/usage`)).json()) as UsageAnswer;
    expect(first.cards).toEqual([]);

    catalog.configured.add("fixture-meter");
    catalog.providers.push({ id: "later-provider", name: "Later Provider" });
    catalog.configured.add("later-provider");

    const second = (await (await fetch(`${origin}/api/usage`)).json()) as UsageAnswer;
    expect(second.cards.map((card) => card.provider)).toEqual(["fixture-meter", "later-provider"]);
  });

  it("answers under the mount prefix too", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog, basePath: "/sec" });
    const response = await fetch(`${origin}/sec/api/usage`);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as UsageAnswer;
    expect(answer.cards.map((card) => card.provider)).toEqual(["fixture-meter"]);
  });
});

  it("answers from the ledger a test hands to the server, with no global replaced", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    // The temporary ledger holds one call of 0.25 dollars. This one holds seven,
    // so a card that shows seven can only have read the option.
    const ledger: UsageLedger = {
      windows: {
        day: { calls: 7, tokens: 7000, cost: 1.25 },
        week: { calls: 7, tokens: 7000, cost: 1.25 },
        month: { calls: 7, tokens: 7000, cost: 1.25 },
      },
      daily: Array.from({ length: 30 }, (_unused, index) => ({
        calls: index === 29 ? 7 : 0,
        tokens: 0,
        cost: 0,
        from: 0,
        to: 0,
      })),
    };
    const origin = await boot({
      catalog,
      usage: { records: { totals: async () => new Map([["fixture-meter", ledger]]) } },
    });

    const answer = (await (await fetch(`${origin}/api/usage`)).json()) as UsageAnswer;
    expect(answer.cards.map((card) => card.provider)).toEqual(["fixture-meter"]);
    expect(answer.cards[0]!.fields["day"]).toEqual({ state: "value", value: { calls: 7, tokens: 7000, cost: 1.25 } });
    expect(answer.cards[0]!.fields["balance"]).toEqual({ state: "wip" });
  });

/** POST a refresh body, with the JSON type unless the test says otherwise. */
async function postRefresh(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${origin}/api/usage/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

/**
 * `POST /api/usage/refresh` is one card's own control.
 *
 * It answers the same card the page load would, but asks the provider again
 * unless a brake holds it. The provider here is a name this repository does not
 * ship, so it has no reader and the route cannot reach any service.
 */
describe("POST /api/usage/refresh", () => {
  it("answers the one card, with the ledger's windows and slots", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog, timezone: "Asia/Tokyo" });

    const response = await postRefresh(origin, { provider: "fixture-meter" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const answer = (await response.json()) as UsageRefreshAnswer;

    // The answer is the one card and nothing else: no cards array, no key.
    expect(Object.keys(answer).sort()).toEqual(["card", "generatedAt", "timezone"]);
    expect(answer.timezone).toBe("Asia/Tokyo");
    expect(answer.card.provider).toBe("fixture-meter");
    expect(answer.card.shape).toBe("prepaid");
    // The balance has no reader; the windows and the thirty slots are counted
    // again on the refresh, from the same ledger.
    expect(answer.card.fields["balance"]).toEqual({ state: "wip" });
    expect(answer.card.fields["day"]).toMatchObject({ state: "value", value: { calls: 1, tokens: 500 } });
    const daily = answer.card.fields["daily"];
    expect(daily).toMatchObject({ state: "value" });
    const slots = (daily as { value: { slots: { calls: number }[] } }).value.slots;
    expect(slots).toHaveLength(30);
    expect(slots[29]?.calls).toBe(1);
  });

  it("answers 404 for a provider the catalog does not have, and for one without auth", async () => {
    const catalog: Catalog = {
      providers: [
        { id: "fixture-meter", name: "Fixture Meter" },
        { id: "unauthed-provider", name: "Unauthed Provider" },
      ],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });

    const absent = await postRefresh(origin, { provider: "absent-provider" });
    expect(absent.status).toBe(404);
    expect(((await absent.json()) as ApiErrorBody).error.code).toBe("unknown_provider");

    const unauthed = await postRefresh(origin, { provider: "unauthed-provider" });
    expect(unauthed.status).toBe(404);
    expect(((await unauthed.json()) as ApiErrorBody).error.code).toBe("unknown_provider");
  });

  it("answers 415 for a body that is not JSON", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });

    const response = await postRefresh(origin, { provider: "fixture-meter" }, { "Content-Type": "text/plain" });
    expect(response.status).toBe(415);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("json_required");
  });

  it("answers 400 for a body that names no provider", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });

    for (const body of [{}, { provider: 7 }, { provider: "" }, { provider: ["fixture-meter"] }, "fixture-meter"]) {
      const response = await postRefresh(origin, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe("invalid_request");
    }

    // A body that is not JSON at all is refused before the route runs, with the
    // same status and the same code.
    const broken = await postRefresh(origin, "{not json");
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as ApiErrorBody).error.code).toBe("invalid_request");
  });

  it("refuses a refresh from a foreign origin", async () => {
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
    };
    const origin = await boot({ catalog });

    // The check is the server's own, for every request that is not a read: it
    // runs before the body is read, so this route never sees the request.
    const response = await postRefresh(origin, { provider: "fixture-meter" }, { Origin: "http://evil.example" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("origin_forbidden");
  });

  it("carries no key or token the catalog holds", async () => {
    const planted = "fake-fixture-provider-key-0009";
    const catalog: Catalog = {
      providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
      configured: new Set(["fixture-meter"]),
      subscription: new Set(),
      auth: new Map([["fixture-meter", planted]]),
    };
    const origin = await boot({ catalog });

    const response = await postRefresh(origin, { provider: "fixture-meter" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(planted);
    // An absence check, not an empty answer.
    expect(text).toContain("fixture-meter");
  });
});

/**
 * The two cards this change adds, over HTTP: the OpenAI card, whose balance no API
 * states, and the decision models card, which counts the audit trail's judgement
 * lines.
 *
 * The OpenAI card is checked twice here: that it states the sentence and the link,
 * and that it asks the network for nothing. The judgement rows are checked against
 * a real audit file in the harness's own home, so the route reads the same path the
 * daemon writes, and a rotated file beside it.
 */
describe("the OpenAI card and the decision models card", () => {
  /** One judgement line, as the audit log writes it. */
  function judgeLine(at: number, options: { readonly judge?: string; readonly outcome?: string } = {}): string {
    return `${JSON.stringify({
      time: at,
      type: "judge",
      judge: options.judge ?? "report-check",
      provider: "openai",
      model: "gpt-6-luna",
      outcome: options.outcome ?? "answered",
      refused: [],
      elapsedMs: 90,
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      costUsd: 0.0004,
    })}\n`;
  }

  it("states the OpenAI balance sentence and the billing link, and calls no address", async () => {
    const remote = providerFetch();
    const origin = await boot({
      // The one catalog with a reader is Anthropic; OpenAI is added beside it, and
      // the fake fetch fails on any address but Anthropic's, so a call for OpenAI
      // would fail the test by asking.
      catalog: {
        providers: [
          { id: "openai", name: "OpenAI" },
          { id: "anthropic", name: "Anthropic" },
        ],
        configured: new Set(["openai", "anthropic"]),
        subscription: new Set(["anthropic"]),
        auth: new Map([
          ["openai", "fixture-openai-key"],
          ["anthropic", "fixture-subscription-token"],
        ]),
      },
      usage: { fetch: remote.fetch, prefetch: false },
    });

    const answer = (await (await fetch(`${origin}/api/usage`)).json()) as UsageAnswer;
    const openai = answer.cards.find((card) => card.provider === "openai");
    expect(openai?.fields["balance"]).toEqual({
      state: "value",
      value: {
        amount: null,
        currency: null,
        note: "No API for the balance",
        billing: {
          label: "OpenAI billing page",
          url: "https://platform.openai.com/settings/organization/billing",
        },
      },
    });
    expect(openai?.shape).toBe("prepaid");
    expect(openai?.receivedAt).toBeNull();
    // The one reader this route ships was the only address asked for.
    expect(remote.calls).toEqual([ANTHROPIC_USAGE_URL]);
    // A refresh of the OpenAI card asks nothing either, and still states it.
    const refreshed = (await postRefresh(origin, { provider: "openai" }).then((response) => response.json())) as UsageRefreshAnswer;
    expect(refreshed.card.fields["balance"]).toMatchObject({ state: "value", value: { note: "No API for the balance" } });
    expect(remote.calls).toEqual([ANTHROPIC_USAGE_URL]);
  });

  it("counts the audit trail's judgement lines, including the rotated file and the failures", async () => {
    harness = await createTestHarness({
      config: { timezone: "Asia/Tokyo", server: { ...defaultConfig().server, port: 0 } },
    });
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    // The live file: two answered judgements today and one failure three days back.
    await writeFile(
      harness.paths.auditLog,
      judgeLine(now - hour) +
        judgeLine(now - 2 * hour, { outcome: "failed" }) +
        judgeLine(now - 3 * day) +
        // Just outside the month: in no window.
        judgeLine(now - 31 * day),
      "utf8",
    );
    // A rotated file beside it: one judgement twenty days back, one older than the
    // month that must not count.
    await writeFile(
      `${harness.paths.auditLog}.2026-10-01T00-00-00.000Z`,
      judgeLine(now - 20 * day) + judgeLine(now - 40 * day),
      "utf8",
    );

    const runtime = {
      ...harness.runtime,
      models: modelsOf({
        providers: [{ id: "openai", name: "OpenAI" }],
        configured: new Set(["openai"]),
        subscription: new Set(),
        auth: new Map([["openai", "fixture-openai-key"]]),
      }),
      // A judge the config names, so the card has a row even before a call.
      getConfig: () => ({ ...harness!.config, judges: { "report-check": { provider: "openai", modelId: "gpt-6-luna" } } }),
    };
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime,
      bus: harness.events,
      sse,
      streams: new StreamHub({ runtime, bus: harness.events, sse }),
      startedAt: now,
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir(), ui: { renderTimeoutMs: 50 }, usage: { prefetch: false } });

    const answer = (await (await fetch(`${started.origin}/api/usage`)).json()) as UsageAnswer;
    expect(answer.judges).toBeDefined();
    const rows = answer.judges?.rows ?? [];
    expect(rows.map((row) => row.name)).toEqual(["report-check"]);
    const row = rows[0]!;
    // Two lines in the last 24 hours, and one of them failed.
    expect(row.day).toEqual({ calls: 2, tokens: 800, cost: expect.closeTo(0.0008, 10), unanswered: 1 });
    // Three in the last 7 days: the two today and the one three days back.
    expect(row.week).toEqual({ calls: 3, tokens: 1200, cost: expect.closeTo(0.0012, 10), unanswered: 1 });
    // Four in the last 30 days: the rotated file's twenty-day line counts, the
    // one from forty days back does not.
    expect(row.month).toEqual({ calls: 4, tokens: 1600, cost: expect.closeTo(0.0016, 10), unanswered: 1 });
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-6-luna");

    // The same rows are in the answer the page carries, so the page asks nothing.
    const first = firstPaintOf(await (await fetch(`${started.origin}/usage`)).text());
    expect(first.judges?.rows[0]?.month.calls).toBe(4);
  });

  it("leaves the card out when neither the config names a judge nor the trail holds one", async () => {
    const origin = await boot({
      catalog: {
        providers: [{ id: "fixture-meter", name: "Fixture Meter" }],
        configured: new Set(["fixture-meter"]),
        subscription: new Set(),
      },
      usage: { prefetch: false },
    });

    const answer = (await (await fetch(`${origin}/api/usage`)).json()) as UsageAnswer;
    expect(answer.judges).toBeUndefined();
    // The trail the harness writes holds no judgement line, and the config names
    // no judge, so there is nothing to draw.
    expect(Object.prototype.hasOwnProperty.call(answer, "judges")).toBe(false);
  });
});
