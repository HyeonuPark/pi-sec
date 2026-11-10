/**
 * `GET /api/usage`'s answer and `POST /api/usage/refresh`'s, built from a fake
 * catalog, a fake ledger and a fake provider API.
 *
 * What matters here is the wiring, not the numbers: which provider gets a card and
 * which gets none, which shape a login draws, which fields a provider with no
 * reader leaves at `wip`, how long a value is reused, what a 429 does to the next
 * request, when a refresh may call and when it is held back, and that no credential
 * or account id reaches the answer. Every value this file feeds in is a fake, and
 * no test here can reach a provider: the fetch the service uses is the one this
 * file hands it.
 */
import { describe, expect, it } from "vitest";
import { ANTHROPIC_USAGE_URL, DEEPSEEK_BALANCE_URL, SYNTHETIC_QUOTAS_URL, USAGE_FETCHERS } from "../src/server/usage/fetchers.ts";
import {
  createUsageService,
  PROVIDER_TIMEOUT_MS,
  RATE_LIMIT_BACKOFF_MS,
  VALUE_REUSE_MS,
  type UsageModels,
  type UsageRefreshResult,
} from "../src/server/usage/service.ts";
import { emptyLedger, type UsageLedger, type UsageWindows } from "../src/server/usage/records.ts";
import { stampInZone, type UsageAnswer, type UsageCard, type UsageSlot } from "../src/server/usage/values.ts";

const TIMEZONE = "Asia/Tokyo";
/** A moment on a minute boundary, so a label can be written out in full. */
const NOW = Date.UTC(2026, 9, 24, 22, 30, 0);

// The fake credential and the account ids the fake answers carry. Each one must be
// absent from every answer, so each carries a marker no other string has.
const ANTHROPIC_TOKEN = "fake-anthropic-oauth-token-0001";
const DEEPSEEK_KEY = "fake-deepseek-api-key-0002";
const ACCOUNT_ID = "fake-account-id-0003";
const ORGANIZATION_ID = "fake-organization-id-0004";

/** The usage answer a subscription account gets, with no balance stated. */
const ANTHROPIC_BODY = {
  five_hour: { utilization: 28, resets_at: "2026-10-26T11:59:59.923715+00:00" },
  seven_day: { utilization: 72, resets_at: "2026-10-30T20:59:59.923737+00:00" },
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: 0,
    utilization: null,
    currency: "USD",
    decimal_places: 2,
    disabled_reason: "out_of_credits",
  },
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: null,
    percent: 0,
    enabled: false,
    disabled_reason: "out_of_credits",
    balance: null,
    can_purchase_credits: false,
  },
  account_id: ACCOUNT_ID,
  organization: { uuid: ORGANIZATION_ID },
};

const DEEPSEEK_BODY = {
  is_available: true,
  balance_infos: [{ currency: "USD", total_balance: "11.25", granted_balance: "0.00", topped_up_balance: "11.25" }],
};

const SYNTHETIC_KEY = "fake-synthetic-api-key-0005";

/** The quota answer synthetic.new gives, with the block at the top level and dollars written as strings. */
const SYNTHETIC_BODY = {
  weeklyTokenLimit: {
    percentRemaining: 42.5,
    nextRegenAt: "2026-10-31T00:00:00.000Z",
    maxCredits: "$24.00",
    remainingCredits: "$10.50",
  },
};

/** Where the synthetic.new card sends a reader for its balance and extra usage. */
const SYNTHETIC_BILLING = { label: "synthetic.new billing page", url: "https://synthetic.new/billing" };

/** The ledger this file hands the service. */
const TOTALS = new Map<string, UsageLedger>([
  [
    "deepseek",
    {
      windows: {
        day: { calls: 12, tokens: 21_000, cost: 0.37 },
        week: { calls: 90, tokens: 250_000, cost: 3.5 },
        month: { calls: 300, tokens: 900_000, cost: 12.25 },
      },
      daily: emptyLedger(NOW).daily,
    },
  ],
  [
    "groq",
    {
      windows: {
        day: { calls: 1, tokens: 900, cost: 0.01 },
        week: { calls: 2, tokens: 1_800, cost: 0.02 },
        month: { calls: 3, tokens: 2_700, cost: 0.03 },
      },
      daily: emptyLedger(NOW).daily,
    },
  ],
]);

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

/** A fetch that answers from a table and remembers every URL it was asked for. */
function fakeFetch(replies: Readonly<Record<string, Reply | (() => Reply)>>): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (input: unknown): Promise<unknown> => {
    const url = String(input);
    calls.push(url);
    const reply = replies[url];
    if (reply === undefined) throw new Error(`this test gave no answer for ${url}`);
    const resolved = typeof reply === "function" ? reply() : reply;
    const status = resolved.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(resolved.body ?? {}),
    };
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

/** A catalog a test can change between two requests. */
interface Catalog {
  readonly providers: { id: string; name?: string }[];
  readonly configured: Set<string>;
  readonly subscription: Set<string>;
  readonly auth: Map<string, string>;
  /** The ids a test declares virtual, the way an extension's entry does. */
  readonly virtual: Set<string>;
}

function catalogOf(options: {
  providers: { id: string; name?: string }[];
  configured?: string[];
  subscription?: string[];
  auth?: Record<string, string>;
  virtual?: string[];
}): Catalog {
  return {
    providers: options.providers,
    configured: new Set(options.configured ?? []),
    subscription: new Set(options.subscription ?? []),
    auth: new Map(Object.entries(options.auth ?? {})),
    virtual: new Set(options.virtual ?? []),
  };
}

/** The catalog as the service reads it: all four questions, answered from one object. */
function modelsOf(catalog: Catalog): UsageModels {
  return {
    getProviders: () => catalog.providers,
    hasConfiguredAuth: (providerId) => catalog.configured.has(providerId),
    isUsingSubscription: (providerId) => catalog.subscription.has(providerId),
    getAuth: async (providerId) => {
      const key = catalog.auth.get(providerId);
      return key === undefined ? undefined : { auth: { apiKey: key } };
    },
  };
}

function serviceOf(options: {
  catalog: Catalog;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  totals?: Map<string, UsageLedger>;
  /** Called once per ledger read, so a test can count them. */
  onTotals?: () => void;
}): ReturnType<typeof createUsageService> {
  return createUsageService({
    models: () => modelsOf(options.catalog),
    records: {
      totals: async () => {
        options.onTotals?.();
        return options.totals ?? TOTALS;
      },
    },
    timezone: () => TIMEZONE,
    now: options.now ?? (() => NOW),
    fetch: options.fetch,
    // The route passes the registry's answer; a catalog with no virtual id hides
    // nothing, which is what every test but the virtual one below relies on.
    isVirtual: (providerId) => options.catalog.virtual.has(providerId),
  });
}

function cardOf(answer: UsageAnswer, provider: string): UsageCard {
  const card = answer.cards.find((entry) => entry.provider === provider);
  if (card === undefined) throw new Error(`no card for ${provider}`);
  return card;
}

/** The one card a refresh answered, or a failure naming why there is none. */
function refreshedCard(result: UsageRefreshResult): UsageCard {
  if (!result.ok) throw new Error(`refresh answered no card: ${result.code}`);
  return result.answer.card;
}

/** The thirty slots of a prepaid card, for the tests that count them. */
function slotsOf(card: UsageCard): readonly UsageSlot[] {
  const field = card.fields["daily"];
  if (field === undefined || field.state !== "value") throw new Error("the card has no daily value");
  return (field.value as { readonly slots: readonly UsageSlot[] }).slots;
}

/**
 * A fetch that answers only when the test releases it, so two requests can be in
 * flight together.
 */
function gatedFetch(body: unknown): { fetch: typeof globalThis.fetch; calls: () => number; release: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const impl = async (): Promise<unknown> => {
    calls += 1;
    await gate;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls: () => calls, release: () => open() };
}

describe("which cards exist", () => {
  it("makes a subscription card for a subscription login, with its own three fields filled", async () => {
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY } }).fetch });

    const answer = await service.answer();
    const card = cardOf(answer, "anthropic");

    expect(card.shape).toBe("subscription");
    expect(card.name).toBe("Anthropic");
    expect(card.receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });
    expect(card.fields["fiveHour"]).toEqual({
      state: "value",
      value: { utilization: 28, resetsAt: { at: Date.parse("2026-10-26T11:59:59.923Z"), label: "2026-10-26 20:59" } },
    });
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: { utilization: 72, resetsAt: { at: Date.parse("2026-10-30T20:59:59.923Z"), label: "2026-10-31 05:59" } },
    });
    expect(card.fields["credits"]).toEqual({
      state: "value",
      value: {
        enabled: false,
        used: { amount: 0, currency: "USD" },
        limit: null,
        disabledReason: "out_of_credits",
        balance: null,
      },
    });
    // This provider's entry names the daily slots, so the card carries them, from
    // pi-sec's ledger. The three rolling windows are not named, so they are absent.
    expect(slotsOf(card)).toHaveLength(30);
    expect(card.fields["day"]).toBeUndefined();
    expect(card.fields["week"]).toBeUndefined();
    expect(card.fields["month"]).toBeUndefined();
    // The card states what its recorded cost is.
    expect(card.note).toBe("pi-sec calls only · API-equivalent cost");
  });

  it("shows the balance when the usage answer states one", async () => {
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const body = {
      ...ANTHROPIC_BODY,
      spend: { ...ANTHROPIC_BODY.spend, balance: { amount_minor: 1250, currency: "USD", exponent: 2 } },
    };
    const service = serviceOf({ catalog, fetch: fakeFetch({ [ANTHROPIC_USAGE_URL]: { body } }).fetch });

    const credits = cardOf(await service.answer(), "anthropic").fields["credits"];
    expect(credits).toMatchObject({ state: "value", value: { balance: { amount: 12.5, currency: "USD" } } });
  });

  it("makes a prepaid card for an API key login, with the balance and the three windows", async () => {
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({ [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } }).fetch });

    const card = cardOf(await service.answer(), "deepseek");
    expect(card.shape).toBe("prepaid");
    expect(card.note).toBe("Peak/off-peak rates applied · holidays ignored");
    expect(card.fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
    expect(card.fields["day"]).toEqual({ state: "value", value: { calls: 12, tokens: 21_000, cost: 0.37 } });
    expect(card.fields["week"]).toEqual({ state: "value", value: { calls: 90, tokens: 250_000, cost: 3.5 } });
    expect(card.fields["month"]).toEqual({ state: "value", value: { calls: 300, tokens: 900_000, cost: 12.25 } });

    // The daily slots: thirty of them, oldest first, the newest ending at the
    // moment of the answer, exactly as the day window does.
    const slots = slotsOf(card);
    expect(slots).toHaveLength(30);
    expect(slots[29]?.to).toEqual({ at: NOW, label: "2026-10-25 07:30" });
    expect(slots[0]?.from).toEqual({ at: NOW - 30 * 24 * 60 * 60 * 1000, label: "2026-09-25 07:30" });
  });

  it("leaves every field of a provider with no reader at WIP, and still counts its calls", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "kimi-coding", name: "Kimi For Coding" },
        { id: "groq", name: "Groq" },
      ],
      configured: ["kimi-coding", "groq"],
      subscription: ["kimi-coding"],
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });
    const answer = await service.answer();

    const subscription = cardOf(answer, "kimi-coding");
    expect(subscription.shape).toBe("subscription");
    expect(subscription.receivedAt).toBeNull();
    expect(subscription.fields).toEqual({ fiveHour: { state: "wip" }, weekly: { state: "wip" }, credits: { state: "wip" } });

    const prepaid = cardOf(answer, "groq");
    expect(prepaid.shape).toBe("prepaid");
    expect(prepaid.fields["balance"]).toEqual({ state: "wip" });
    // The windows come from pi-sec's own ledger, which every provider has.
    expect(prepaid.fields["day"]).toEqual({ state: "value", value: { calls: 1, tokens: 900, cost: 0.01 } });
    expect(prepaid.fields["month"]).toEqual({ state: "value", value: { calls: 3, tokens: 2_700, cost: 0.03 } });
    expect(slotsOf(prepaid)).toHaveLength(30);
  });

  it("makes no card for a provider without auth", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "groq", name: "Groq" },
      ],
      configured: ["groq"],
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });
    const answer = await service.answer();
    expect(answer.cards.map((card) => card.provider)).toEqual(["groq"]);
  });

  it("puts the subscription cards first, then each shape by display name", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "zeta", name: "Zeta" },
        { id: "openai", name: "OpenAI" },
        { id: "alpha", name: "Alpha" },
        { id: "kimi-coding", name: "Kimi For Coding" },
      ],
      configured: ["zeta", "openai", "alpha", "kimi-coding"],
      subscription: ["kimi-coding"],
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });
    const answer = await service.answer();
    expect(answer.cards.map((card) => card.provider)).toEqual(["kimi-coding", "alpha", "openai", "zeta"]);
  });

  it("has the card of a provider that gained auth between two requests", async () => {
    const added = { id: "fixture-meter", name: "Fixture Meter" };
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY } }).fetch });

    const first = await service.answer();
    expect(first.cards.map((card) => card.provider)).toEqual(["anthropic"]);

    // The catalog answers per request, so a provider added or logged in later is
    // there on the next request with no restart and no code change.
    catalog.providers.push(added);
    catalog.configured.add(added.id);
    const second = await service.answer();
    expect(second.cards.map((card) => card.provider)).toEqual(["anthropic", "fixture-meter"]);
    expect(cardOf(second, "fixture-meter").fields["balance"]).toEqual({ state: "wip" });
  });
});

/**
 * A provider an extension declares virtual.
 *
 * It answers no request itself: it hands each one to another provider, and the
 * ledger records the call under the provider that answered. A card for it would
 * state zeros beside the card that already holds those numbers, so it gets none,
 * on every path that selects a card, and a refresh of it answers as a provider
 * this server has no card for.
 */
describe("a virtual provider", () => {
  it("has no card, on the answer and on the page, while every other card stays", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "synthetic", name: "synthetic.new" },
        { id: "synthetic-routed", name: "Synthetic (routed)" },
      ],
      configured: ["anthropic", "synthetic", "synthetic-routed"],
      subscription: ["anthropic", "synthetic"],
      auth: { anthropic: ANTHROPIC_TOKEN, synthetic: SYNTHETIC_KEY },
      virtual: ["synthetic-routed"],
    });
    const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY } });
    const service = serviceOf({ catalog, fetch: remote.fetch });

    // The answer and the page load select cards the same way, so neither makes a
    // card for it.
    const answer = await service.answer();
    expect(answer.cards.map((card) => card.provider)).toEqual(["anthropic", "synthetic"]);

    const painted = await service.firstPaint();
    expect(painted.cards.map((card) => card.provider)).toEqual(["anthropic", "synthetic"]);

    // The other cards are the ones they were: this changes which cards exist, not
    // what one holds.
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toMatchObject({ state: "value", value: { utilization: 28 } });
    expect(cardOf(painted, "anthropic").fields["weekly"]).toMatchObject({ state: "value", value: { utilization: 72 } });
  });

  it("is not read by the prefetch either, and not refreshed", async () => {
    // The virtual provider gets a reader of its own here, so the prefetch's own
    // loop would call it: the skip is what this test measures, not the absence of
    // a reader.
    const asked: string[] = [];
    const reader = (providerId: string, values: unknown) => ({
      shape: "prepaid" as const,
      refreshFloorMs: 0,
      read: async () => {
        asked.push(providerId);
        return values as never;
      },
    });
    const catalog = catalogOf({
      providers: [
        { id: "groq", name: "Groq" },
        { id: "synthetic-routed", name: "Synthetic (routed)" },
      ],
      configured: ["groq", "synthetic-routed"],
      virtual: ["synthetic-routed"],
    });
    const service = createUsageService({
      models: () => modelsOf(catalog),
      records: { totals: async () => TOTALS },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: fakeFetch({}).fetch,
      fetchers: {
        groq: reader("groq", { kind: "prepaid", balance: { amount: 1, currency: "USD" } }),
        "synthetic-routed": reader("synthetic-routed", { kind: "prepaid", balance: null }),
      },
      isVirtual: (providerId) => catalog.virtual.has(providerId),
    });

    await service.prefetch();
    expect(asked).toEqual(["groq"]);

    // A refresh of it is the answer a provider with no card gets, and reads nothing.
    expect(await service.refresh("synthetic-routed")).toEqual({ ok: false, code: "unknown_provider" });
    expect(asked).toEqual(["groq"]);
  });

  it("answers a refresh as a provider with no card, and calls nothing", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "groq", name: "Groq" },
        { id: "synthetic-routed", name: "Synthetic (routed)" },
      ],
      configured: ["groq", "synthetic-routed"],
      virtual: ["synthetic-routed"],
    });
    const remote = fakeFetch({});
    const service = serviceOf({ catalog, fetch: remote.fetch });

    expect(await service.refresh("synthetic-routed")).toEqual({ ok: false, code: "unknown_provider" });
    expect(remote.calls).toEqual([]);
    // The provider beside it still refreshes.
    expect((await service.refresh("groq")).ok).toBe(true);
  });

  it("stops being hidden when its marker goes, with no other change", async () => {
    const catalog = catalogOf({
      providers: [{ id: "routed", name: "Routed" }],
      configured: ["routed"],
      virtual: ["routed"],
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });
    expect((await service.answer()).cards).toEqual([]);

    // The selector is read per request, so a reload that drops the marker shows
    // the card on the next one.
    catalog.virtual.clear();
    expect((await service.answer()).cards.map((card) => card.provider)).toEqual(["routed"]);
  });

  it("hides nothing when the runtime has no provider registry", async () => {
    const catalog = catalogOf({ providers: [{ id: "groq", name: "Groq" }], configured: ["groq"] });
    const service = createUsageService({
      models: () => modelsOf(catalog),
      records: { totals: async () => TOTALS },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: fakeFetch({}).fetch,
    });

    expect((await service.answer()).cards.map((card) => card.provider)).toEqual(["groq"]);
  });
});

/**
 * The synthetic.new card.
 *
 * synthetic.new sells a weekly credit subscription and issues an API key, so its
 * card takes the subscription shape although the login is a key. Its quota answer
 * is known only from third-party code: these tests feed a block at the top level
 * and one under `data`, and the amounts as a dollar string and as a number, and
 * check that a slot the answer omits stays empty while the rest still draws.
 */
describe("the synthetic.new card", () => {
  function syntheticCatalog(): Catalog {
    return catalogOf({
      providers: [{ id: "synthetic", name: "synthetic.new" }],
      configured: ["synthetic"],
      auth: { synthetic: SYNTHETIC_KEY },
    });
  }

  it("draws a subscription card for an API key login, with the weekly share, the reset time and the credits", async () => {
    const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body: SYNTHETIC_BODY } });
    const service = serviceOf({ catalog: syntheticCatalog(), fetch: remote.fetch });

    const card = cardOf(await service.answer(), "synthetic");
    expect(remote.calls).toEqual([SYNTHETIC_QUOTAS_URL]);
    expect(card.shape).toBe("subscription");
    expect(card.name).toBe("synthetic.new");
    // synthetic.new has no five-hour window, so the card carries no such field.
    expect(card.fields["fiveHour"]).toBeUndefined();
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: {
        utilization: 57.5,
        resetsAt: { at: Date.parse("2026-10-31T00:00:00.000Z"), label: "2026-10-31 09:00" },
        // The fallback block states no regeneration share.
        regenPercent: null,
      },
    });
    expect(card.fields["credits"]).toEqual({
      state: "value",
      value: {
        enabled: null,
        used: { amount: 13.5, currency: "USD" },
        limit: { amount: 24, currency: "USD" },
        disabledReason: null,
        balance: { amount: 10.5, currency: "USD" },
        billing: SYNTHETIC_BILLING,
      },
    });
  });

  it("reads the same quota from numbers, with the block under data", async () => {
    const body = {
      data: { weeklyTokenLimit: { percentRemaining: 0, maxCredits: 24, remainingCredits: 3.5, nextRegenAt: null } },
    };
    const service = serviceOf({
      catalog: syntheticCatalog(),
      fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body } }).fetch,
    });

    const card = cardOf(await service.answer(), "synthetic");
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: { utilization: 100, resetsAt: null, regenPercent: null },
    });
    expect(card.fields["credits"]).toMatchObject({
      state: "value",
      value: {
        used: { amount: 20.5, currency: "USD" },
        limit: { amount: 24, currency: "USD" },
        balance: { amount: 3.5, currency: "USD" },
      },
    });
  });

  it("leaves a slot empty when the answer does not state it, and fills the rest", async () => {
    const body = { weeklyTokenLimit: { percentRemaining: 90, remainingCredits: "$1.25" } };
    const service = serviceOf({
      catalog: syntheticCatalog(),
      fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body } }).fetch,
    });

    const card = cardOf(await service.answer(), "synthetic");
    // No nextRegenAt: the reset time stays empty and the share is still drawn.
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: { utilization: 10, resetsAt: null, regenPercent: null },
    });
    // No maxCredits: the limit and the difference it would make stay empty too.
    expect(card.fields["credits"]).toEqual({
      state: "value",
      value: {
        enabled: null,
        used: null,
        limit: null,
        disabledReason: null,
        balance: { amount: 1.25, currency: "USD" },
        billing: SYNTHETIC_BILLING,
      },
    });
  });

  /**
   * The block this account actually answers.
   *
   * `planWeeklyLimit` states the share that remains, the moment it regenerates and
   * the percent that comes back, and no credit amounts at all. The fallback block
   * below is the one an account on another plan answers.
   */
  const PLAN_BODY = {
    planWeeklyLimit: {
      nextRegenAt: "2026-10-27T19:56:56.000Z",
      percentRemaining: 100,
      nextRegenPercent: 2,
    },
    subscription: { limit: 500, requests: 0, renewsAt: "2026-10-28T09:00:00.000Z" },
    search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-10-27T20:56:56.000Z" } },
  };

  it("reads the plan block, with the share it gives back and no amounts", async () => {
    const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body: PLAN_BODY } });
    const service = serviceOf({ catalog: syntheticCatalog(), fetch: remote.fetch });

    const card = cardOf(await service.answer(), "synthetic");
    expect(card.shape).toBe("subscription");
    expect(card.fields["fiveHour"]).toBeUndefined();
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: {
        utilization: 0,
        resetsAt: { at: Date.parse("2026-10-27T19:56:56.000Z"), label: "2026-10-28 04:56" },
        regenPercent: 2,
      },
    });
    // The block states no amounts, so every amount is empty and the card keeps the
    // billing link it links instead of printing an amount of zero.
    expect(card.fields["credits"]).toEqual({
      state: "value",
      value: {
        enabled: null,
        used: null,
        limit: null,
        disabledReason: null,
        balance: null,
        billing: SYNTHETIC_BILLING,
      },
    });
  });

  it("reads the plan block under data, and counts what remains as used", async () => {
    const body = {
      data: {
        planWeeklyLimit: {
          percentRemaining: 65,
          nextRegenAt: "2026-10-27T19:56:56.000Z",
          nextRegenPercent: 4,
        },
      },
    };
    const service = serviceOf({
      catalog: syntheticCatalog(),
      fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body } }).fetch,
    });

    const card = cardOf(await service.answer(), "synthetic");
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: {
        utilization: 35,
        resetsAt: { at: Date.parse("2026-10-27T19:56:56.000Z"), label: "2026-10-28 04:56" },
        regenPercent: 4,
      },
    });
    expect(card.fields["credits"]).toMatchObject({
      state: "value",
      value: { used: null, limit: null, balance: null, billing: SYNTHETIC_BILLING },
    });
  });

  it("leaves the regeneration share empty when the plan states no usable one", async () => {
    for (const nextRegenPercent of [undefined, 0, -1, 2.5, "two"]) {
      const body = { planWeeklyLimit: { percentRemaining: 50, nextRegenAt: null, nextRegenPercent } };
      const service = serviceOf({
        catalog: syntheticCatalog(),
        fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body } }).fetch,
      });

      const card = cardOf(await service.answer(), "synthetic");
      // A null share is stated in the key, which is what tells the page to write
      // `next regeneration` rather than `resets`.
      expect(card.fields["weekly"], String(nextRegenPercent)).toEqual({
        state: "value",
        value: { utilization: 50, resetsAt: null, regenPercent: null },
      });
    }
  });

  it("prefers the plan block to the fallback when an answer holds both", async () => {
    const body = {
      planWeeklyLimit: { percentRemaining: 90, nextRegenPercent: 3 },
      weeklyTokenLimit: SYNTHETIC_BODY.weeklyTokenLimit,
    };
    const service = serviceOf({
      catalog: syntheticCatalog(),
      fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body } }).fetch,
    });

    const card = cardOf(await service.answer(), "synthetic");
    expect(card.fields["weekly"]).toEqual({
      state: "value",
      value: { utilization: 10, resetsAt: null, regenPercent: 3 },
    });
    // The plan block states no amounts, so the fallback's dollar amounts are not
    // mixed into the card.
    expect(card.fields["credits"]).toMatchObject({ state: "value", value: { used: null, limit: null, balance: null } });
  });

  it("fails as an unexpected answer when the quota block is nowhere", async () => {
    const service = serviceOf({
      catalog: syntheticCatalog(),
      fetch: fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body: { data: { token: "quota-missing" } } } }).fetch,
    });

    const card = cardOf(await service.answer(), "synthetic");
    expect(card.shape).toBe("subscription");
    expect(card.receivedAt).toBeNull();
    expect(card.fields["fiveHour"]).toBeUndefined();
    expect(card.fields["weekly"]).toEqual({ state: "error", reason: "unexpected answer" });
    expect(card.fields["credits"]).toEqual({ state: "error", reason: "unexpected answer" });
  });

  it("stops calling for thirty minutes after HTTP 429, and keeps the last value with its time", async () => {
    let now = NOW;
    let refuse = false;
    const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: () => (refuse ? { status: 429 } : { body: SYNTHETIC_BODY }) });
    const service = serviceOf({ catalog: syntheticCatalog(), fetch: remote.fetch, now: () => now });

    const first = await service.answer();
    expect(cardOf(first, "synthetic").fields["credits"]).toMatchObject({
      state: "value",
      value: { used: { amount: 13.5, currency: "USD" } },
    });

    // The held value ages out, the next call is refused, and the card keeps what it
    // last received, with the time it received it.
    refuse = true;
    now = NOW + VALUE_REUSE_MS;
    const refused = await service.answer();
    expect(remote.calls).toHaveLength(2);
    expect(cardOf(refused, "synthetic").receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });
    expect(cardOf(refused, "synthetic").fields["weekly"]).toMatchObject({
      state: "value",
      value: { utilization: 57.5 },
    });
    expect(cardOf(refused, "synthetic").hold).toEqual({
      kind: "rate_limited",
      until: { at: NOW + VALUE_REUSE_MS + RATE_LIMIT_BACKOFF_MS, label: "2026-10-25 08:10" },
    });

    // Nothing calls again while the back-off holds, even past the reuse window.
    refuse = false;
    now = NOW + VALUE_REUSE_MS + RATE_LIMIT_BACKOFF_MS - 1;
    await service.answer();
    expect(remote.calls).toHaveLength(2);

    now = NOW + VALUE_REUSE_MS + RATE_LIMIT_BACKOFF_MS;
    await service.answer();
    expect(remote.calls).toHaveLength(3);
  });
});

/**
 * The exception belongs to the reader, not to the login.
 *
 * An installation that signs in to Anthropic with an API key keeps the prepaid card
 * it has today: only a reader that says its own key is a subscription widens the
 * subscription shape.
 */
describe("an API key login of another provider", () => {
  it("keeps the prepaid card, and never calls the subscription reader", async () => {
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY } });
    const service = serviceOf({ catalog, fetch: remote.fetch });

    const card = cardOf(await service.answer(), "anthropic");
    expect(card.shape).toBe("prepaid");
    expect(remote.calls).toEqual([]);
    expect(card.fields["balance"]).toEqual({ state: "wip" });
    expect(card.fields["fiveHour"]).toBeUndefined();
    expect(card.fields["day"]).toEqual({ state: "value", value: { calls: 0, tokens: 0, cost: 0 } });
  });
});

describe("the calls to a provider's own API", () => {
  it("reuses one value for ten minutes and calls again after that", async () => {
    let now = NOW;
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const remote = fakeFetch({ [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    await service.answer();
    await service.answer();
    await service.answer();
    expect(remote.calls).toHaveLength(1);

    now = NOW + VALUE_REUSE_MS - 1;
    await service.answer();
    expect(remote.calls).toHaveLength(1);

    now = NOW + VALUE_REUSE_MS;
    await service.answer();
    expect(remote.calls).toHaveLength(2);
  });

  it("stops calling a provider for thirty minutes after HTTP 429, and keeps the last value with its time", async () => {
    let now = NOW;
    let refuse = false;
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const remote = fakeFetch({
      [DEEPSEEK_BALANCE_URL]: () => (refuse ? { status: 429 } : { body: DEEPSEEK_BODY }),
    });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    const first = await service.answer();
    expect(cardOf(first, "deepseek").fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });

    // The held value ages out, the next call is refused, and the card keeps what
    // it last received — with the time it received it.
    refuse = true;
    now = NOW + VALUE_REUSE_MS;
    const refused = await service.answer();
    expect(remote.calls).toHaveLength(2);
    expect(cardOf(refused, "deepseek").fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
    expect(cardOf(refused, "deepseek").receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });

    // Nothing calls again while the back-off holds, even past the reuse window.
    refuse = false;
    now = NOW + VALUE_REUSE_MS + RATE_LIMIT_BACKOFF_MS - 1;
    await service.answer();
    expect(remote.calls).toHaveLength(2);

    now = NOW + VALUE_REUSE_MS + RATE_LIMIT_BACKOFF_MS;
    await service.answer();
    expect(remote.calls).toHaveLength(3);
  });

  it("puts the reason in the field when a provider refuses and no value was ever received", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "deepseek", name: "DeepSeek" },
        { id: "anthropic", name: "Anthropic" },
      ],
      configured: ["deepseek", "anthropic"],
      subscription: ["anthropic"],
      auth: { deepseek: DEEPSEEK_KEY, anthropic: ANTHROPIC_TOKEN },
    });
    const remote = fakeFetch({
      [DEEPSEEK_BALANCE_URL]: { status: 503 },
      [ANTHROPIC_USAGE_URL]: { status: 429 },
    });
    const service = serviceOf({ catalog, fetch: remote.fetch });
    const answer = await service.answer();

    expect(cardOf(answer, "deepseek").fields["balance"]).toEqual({ state: "error", reason: "HTTP 503" });
    // One provider's refusal touches that provider's fields only.
    expect(cardOf(answer, "deepseek").fields["day"]).toEqual({ state: "value", value: { calls: 12, tokens: 21_000, cost: 0.37 } });
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toEqual({ state: "error", reason: "HTTP 429" });
    expect(cardOf(answer, "anthropic").receivedAt).toBeNull();
  });

  it("does not follow a provider's redirect into a value", async () => {
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    // A fetch that follows a redirect would end on the 200 below. A fetch told to
    // leave the redirect alone is given the 302 itself.
    const remote = (async (_input: unknown, init?: { redirect?: string }) => {
      const manual = init?.redirect === "manual";
      const status = manual ? 302 : 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(manual ? {} : DEEPSEEK_BODY),
      };
    }) as unknown as typeof globalThis.fetch;
    const answer = await serviceOf({ catalog, fetch: remote }).answer();

    expect(cardOf(answer, "deepseek").fields["balance"]).toEqual({ state: "error", reason: "HTTP 302" });
  });

  it("says the ledger is unreadable instead of failing the whole answer", async () => {
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const service = createUsageService({
      models: () => modelsOf(catalog),
      records: {
        totals: async () => {
          throw new Error("usage ledger cannot be read: no such file");
        },
      },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: fakeFetch({ [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } }).fetch,
    });
    const answer = await service.answer();
    const card = cardOf(answer, "deepseek");

    expect(card.fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
    expect(card.fields["day"]).toEqual({ state: "error", reason: "ledger unreadable" });
  });
});

describe("what the answer must not carry", () => {
  it("holds no key, no token and no account id", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "deepseek", name: "DeepSeek" },
      ],
      configured: ["anthropic", "deepseek"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN, deepseek: DEEPSEEK_KEY },
    });
    const service = serviceOf({
      catalog,
      fetch: fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY }, [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } })
        .fetch,
    });
    const serialized = JSON.stringify(await service.answer());

    for (const secret of [ANTHROPIC_TOKEN, DEEPSEEK_KEY, ACCOUNT_ID, ORGANIZATION_ID]) {
      expect(serialized).not.toContain(secret);
    }
    // The fields the card shows are still there: this is an absence check, not an
    // empty answer.
    expect(serialized).toContain("11.25");
    expect(serialized).toContain("out_of_credits");
  });

  it("holds no credential when the call fails either", async () => {
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({ [ANTHROPIC_USAGE_URL]: { status: 500 } }).fetch });
    const serialized = JSON.stringify(await service.answer());
    expect(serialized).not.toContain(ANTHROPIC_TOKEN);
    expect(serialized).toContain("HTTP 500");
  });
});

/**
 * One card's own refresh.
 *
 * A refresh skips the ten-minute reuse, so it can replace the value the page
 * already holds. It obeys two brakes instead: the provider's HTTP 429 back-off,
 * and the provider's own minimum interval counted from its last attempt. The
 * clock and the fetch are both fakes, so each case fixes the exact moment and
 * counts the calls that moment allowed.
 */
describe("refreshing one card", () => {
  /** A catalog with both providers logged in, the subscription one as a subscription. */
  function bothProviders(): Catalog {
    return catalogOf({
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "deepseek", name: "DeepSeek" },
      ],
      configured: ["anthropic", "deepseek"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN, deepseek: DEEPSEEK_KEY },
    });
  }

  /** Both provider answers, so one page load is one call each. */
  function bothReplies(): Record<string, Reply> {
    return { [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY }, [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } };
  }

  it("states the minimum interval of each provider it ships a reader for", () => {
    expect(USAGE_FETCHERS["anthropic"]?.refreshFloorMs).toBe(5 * 60 * 1000);
    expect(USAGE_FETCHERS["deepseek"]?.refreshFloorMs).toBe(60 * 1000);
    expect(USAGE_FETCHERS["synthetic"]?.refreshFloorMs).toBe(5 * 60 * 1000);
  });

  it("makes no call inside the minimum interval, and says when a refresh may call again", async () => {
    let now = NOW;
    const remote = fakeFetch(bothReplies());
    const service = serviceOf({ catalog: bothProviders(), fetch: remote.fetch, now: () => now });

    // One page load: one call each, both as the same moment.
    await service.answer();
    expect(remote.calls).toHaveLength(2);

    // Fifty-nine seconds after the DeepSeek call: one second short of its minute.
    now = NOW + 59_000;
    const deepseek = await service.refresh("deepseek");
    expect(remote.calls).toHaveLength(2);
    expect(refreshedCard(deepseek).hold).toEqual({ kind: "kept", nextAt: { at: NOW + 60_000, label: "2026-10-25 07:31" } });
    // What the last attempt left is what the card still shows.
    expect(refreshedCard(deepseek).fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });

    // Four minutes fifty-nine after the Anthropic call: one second short of five.
    now = NOW + 4 * 60_000 + 59_000;
    const anthropic = await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(2);
    expect(refreshedCard(anthropic).hold).toEqual({
      kind: "kept",
      nextAt: { at: NOW + 5 * 60_000, label: "2026-10-25 07:35" },
    });
  });

  it("calls once the interval is over, even though the held value is younger than ten minutes", async () => {
    let now = NOW;
    const remote = fakeFetch(bothReplies());
    const service = serviceOf({ catalog: bothProviders(), fetch: remote.fetch, now: () => now });

    await service.answer();
    expect(remote.calls).toHaveLength(2);

    now = NOW + 5 * 60_000;
    const result = await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(3);
    expect(refreshedCard(result).hold).toBeUndefined();
    expect(refreshedCard(result).receivedAt).toEqual({ at: NOW + 5 * 60_000, label: "2026-10-25 07:35" });
  });

  it("counts the interval from a failed attempt too, and shows what that attempt left", async () => {
    let now = NOW;
    let refuse = false;
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: () => (refuse ? { status: 500 } : { body: ANTHROPIC_BODY }) });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(1);

    // Past the interval, the refresh calls and fails; the held value stays.
    refuse = true;
    now = NOW + 6 * 60_000;
    const failed = await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(2);
    expect(refreshedCard(failed).fields["fiveHour"]).toMatchObject({ state: "value" });
    expect(refreshedCard(failed).hold).toBeUndefined();

    // One minute later the interval still holds, though the last attempt failed
    // and brought no new value. That is the point of counting attempts.
    now = NOW + 7 * 60_000;
    const kept = await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(2);
    expect(refreshedCard(kept).hold).toEqual({
      kind: "kept",
      nextAt: { at: NOW + 11 * 60_000, label: "2026-10-25 07:41" },
    });
  });

  it("shows the failure reason while the interval holds when no value was ever received", async () => {
    let now = NOW;
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: { status: 503 } });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    const first = await service.refresh("anthropic");
    expect(refreshedCard(first).fields["fiveHour"]).toEqual({ state: "error", reason: "HTTP 503" });
    expect(refreshedCard(first).hold).toBeUndefined();

    now = NOW + 60_000;
    const kept = await service.refresh("anthropic");
    expect(remote.calls).toHaveLength(1);
    expect(refreshedCard(kept).fields["fiveHour"]).toEqual({ state: "error", reason: "HTTP 503" });
    expect(refreshedCard(kept).hold).toEqual({
      kind: "kept",
      nextAt: { at: NOW + 5 * 60_000, label: "2026-10-25 07:35" },
    });
  });

  it("never bypasses the 429 back-off, and both a refresh and a page load say when it ends", async () => {
    let now = NOW;
    let refuse = true;
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const remote = fakeFetch({ [DEEPSEEK_BALANCE_URL]: () => (refuse ? { status: 429 } : { body: DEEPSEEK_BODY }) });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    // The refusal starts the back-off, and this answer is already inside it.
    const until = { at: NOW + RATE_LIMIT_BACKOFF_MS, label: "2026-10-25 08:00" };
    const refused = await service.refresh("deepseek");
    expect(remote.calls).toHaveLength(1);
    expect(refreshedCard(refused).fields["balance"]).toEqual({ state: "error", reason: "HTTP 429" });
    expect(refreshedCard(refused).hold).toEqual({ kind: "rate_limited", until });

    // Half a minute later, past the one-minute interval, the back-off still holds.
    refuse = false;
    now = NOW + 30_000;
    const kept = await service.refresh("deepseek");
    expect(remote.calls).toHaveLength(1);
    expect(refreshedCard(kept).hold).toEqual({ kind: "rate_limited", until });

    // A page load inside the back-off carries it too, and calls nothing.
    now = NOW + 20 * 60_000;
    const answer = await service.answer();
    expect(remote.calls).toHaveLength(1);
    expect(cardOf(answer, "deepseek").hold).toEqual({ kind: "rate_limited", until });

    // Once it ends, a refresh calls again.
    now = NOW + RATE_LIMIT_BACKOFF_MS;
    const again = await service.refresh("deepseek");
    expect(remote.calls).toHaveLength(2);
    expect(refreshedCard(again).hold).toBeUndefined();
    expect(refreshedCard(again).fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
  });

  it("shares one call between two refreshes that arrive together", async () => {
    const catalog = catalogOf({
      providers: [{ id: "anthropic", name: "Anthropic" }],
      configured: ["anthropic"],
      subscription: ["anthropic"],
      auth: { anthropic: ANTHROPIC_TOKEN },
    });
    const gated = gatedFetch(ANTHROPIC_BODY);
    const service = serviceOf({ catalog, fetch: gated.fetch });

    const left = service.refresh("anthropic");
    const right = service.refresh("anthropic");
    gated.release();
    const [first, second] = await Promise.all([left, right]);

    expect(gated.calls()).toBe(1);
    expect(refreshedCard(first).receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });
    expect(refreshedCard(second).receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });
  });

  it("recounts the ledger on every refresh, and on the answer", async () => {
    let now = NOW;
    let reads = 0;
    const remote = fakeFetch(bothReplies());
    const service = serviceOf({
      catalog: bothProviders(),
      fetch: remote.fetch,
      now: () => now,
      onTotals: () => {
        reads += 1;
      },
    });

    await service.answer();
    expect(reads).toBe(1);
    // A refresh reads the ledger even when its interval holds the call back.
    await service.refresh("deepseek");
    expect(reads).toBe(2);
    now = NOW + 60_000;
    await service.refresh("deepseek");
    expect(reads).toBe(3);
    expect(remote.calls).toHaveLength(3);
  });

  it("still reuses one value for ten minutes on a page load", async () => {
    let now = NOW;
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const remote = fakeFetch({ [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } });
    const service = serviceOf({ catalog, fetch: remote.fetch, now: () => now });

    await service.answer();
    // Six minutes: past the one-minute interval, inside the ten-minute reuse.
    now = NOW + 6 * 60_000;
    const reused = await service.answer();
    expect(remote.calls).toHaveLength(1);
    expect(cardOf(reused, "deepseek").hold).toBeUndefined();
    expect(cardOf(reused, "deepseek").receivedAt).toEqual({ at: NOW, label: "2026-10-25 07:30" });

    now = NOW + VALUE_REUSE_MS;
    await service.answer();
    expect(remote.calls).toHaveLength(2);
  });

  it("refreshes the ledger fields of a provider with no reader, and calls nothing", async () => {
    const catalog = catalogOf({ providers: [{ id: "groq", name: "Groq" }], configured: ["groq"] });
    const remote = fakeFetch({});
    const service = serviceOf({ catalog, fetch: remote.fetch });

    const result = await service.refresh("groq");
    expect(remote.calls).toHaveLength(0);
    const card = refreshedCard(result);
    expect(card.fields["balance"]).toEqual({ state: "wip" });
    expect(card.fields["day"]).toEqual({ state: "value", value: { calls: 1, tokens: 900, cost: 0.01 } });
    expect(slotsOf(card)).toHaveLength(30);
    expect(card.hold).toBeUndefined();
  });

  it("answers no card for a provider the catalog does not have, or one without auth", async () => {
    const catalog = catalogOf({
      providers: [
        { id: "groq", name: "Groq" },
        { id: "kimi-coding", name: "Kimi For Coding" },
      ],
      configured: ["groq"],
    });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });

    expect(await service.refresh("absent-provider")).toEqual({ ok: false, code: "unknown_provider" });
    // In the catalog and without auth is the same answer: there is no card.
    expect(await service.refresh("kimi-coding")).toEqual({ ok: false, code: "unknown_provider" });
    expect((await service.refresh("groq")).ok).toBe(true);
  });

  it("gives the daily field the ledger's reason when the ledger cannot be read", async () => {
    const catalog = catalogOf({
      providers: [{ id: "deepseek", name: "DeepSeek" }],
      configured: ["deepseek"],
      auth: { deepseek: DEEPSEEK_KEY },
    });
    const service = createUsageService({
      models: () => modelsOf(catalog),
      records: {
        totals: async () => {
          throw new Error("usage ledger cannot be read: no such file");
        },
      },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: fakeFetch({ [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } }).fetch,
    });

    const card = refreshedCard(await service.refresh("deepseek"));
    expect(card.fields["day"]).toEqual({ state: "error", reason: "ledger unreadable" });
    expect(card.fields["daily"]).toEqual({ state: "error", reason: "ledger unreadable" });
    // The provider's own value is unaffected.
    expect(card.fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
  });

  it("answers no credential on a refresh either", async () => {
    const remote = fakeFetch(bothReplies());
    const service = serviceOf({ catalog: bothProviders(), fetch: remote.fetch });

    const serialized = JSON.stringify(await service.refresh("anthropic"));
    for (const secret of [ANTHROPIC_TOKEN, DEEPSEEK_KEY, ACCOUNT_ID, ORGANIZATION_ID]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("28");
  });
});

/** A catalog with the two providers this repository ships a reader for. */
function readerCatalog(): Catalog {
  return catalogOf({
    providers: [
      { id: "anthropic", name: "Anthropic" },
      { id: "deepseek", name: "DeepSeek" },
    ],
    configured: ["anthropic", "deepseek"],
    subscription: ["anthropic"],
    auth: { anthropic: ANTHROPIC_TOKEN, deepseek: DEEPSEEK_KEY },
  });
}

/** Both provider answers, so one read is one call each. */
function readerReplies(): Record<string, Reply> {
  return { [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY }, [DEEPSEEK_BALANCE_URL]: { body: DEEPSEEK_BODY } };
}

describe("the answer the page is served with", () => {
  it("carries pi-sec's own windows and marks a provider value it has not read as reading", async () => {
    const remote = fakeFetch(readerReplies());
    const service = serviceOf({ catalog: readerCatalog(), fetch: remote.fetch });

    const answer = await service.firstPaint();

    // The calls this file hands the service were not made: the page is built from
    // what the service holds, and it holds nothing yet.
    expect(remote.calls).toEqual([]);
    expect(answer.cards.map((card) => card.provider)).toEqual(["anthropic", "deepseek"]);
    const anthropic = cardOf(answer, "anthropic");
    expect(anthropic.receivedAt).toBeNull();
    // A reader exists for this provider and has not been asked, so the value is on
    // its way: `reading`, which is what makes the page ask for it.
    expect(anthropic.fields["fiveHour"]).toEqual({ state: "reading" });
    expect(anthropic.fields["weekly"]).toEqual({ state: "reading" });
    expect(anthropic.fields["credits"]).toEqual({ state: "reading" });

    const deepseek = cardOf(answer, "deepseek");
    expect(deepseek.fields["balance"]).toEqual({ state: "reading" });
    // The ledger's fields are not a provider value: they are already here.
    expect(deepseek.fields["day"]).toMatchObject({ state: "value", value: { calls: 12, tokens: 21_000 } });
    expect(deepseek.fields["daily"]).toMatchObject({ state: "value" });
  });

  it("keeps wip for a provider with no reader, so it never makes the page ask", async () => {
    const catalog = catalogOf({ providers: [{ id: "fixture-meter", name: "Fixture Meter" }], configured: ["fixture-meter"] });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });

    const card = cardOf(await service.firstPaint(), "fixture-meter");
    expect(card.fields["balance"]).toEqual({ state: "wip" });
    expect(card.fields["day"]).toMatchObject({ state: "value" });
  });

  it("serves a value it received less than ten minutes ago, and calls nothing more", async () => {
    let now = NOW;
    const remote = fakeFetch(readerReplies());
    const service = serviceOf({ catalog: readerCatalog(), fetch: remote.fetch, now: () => now });

    await service.answer();
    expect(remote.calls).toHaveLength(2);

    now = NOW + 60 * 1000;
    const answer = await service.firstPaint();
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toMatchObject({ state: "value", value: { utilization: 28 } });
    expect(cardOf(answer, "deepseek").fields["balance"]).toEqual({ state: "value", value: { amount: 11.25, currency: "USD" } });
    expect(cardOf(answer, "anthropic").receivedAt).toEqual({ at: NOW, label: stampInZone(NOW, TIMEZONE) });
    expect(remote.calls).toHaveLength(2);
  });

  it("treats a value received ten minutes ago as not there", async () => {
    let now = NOW;
    const remote = fakeFetch(readerReplies());
    const service = serviceOf({ catalog: readerCatalog(), fetch: remote.fetch, now: () => now });

    await service.answer();
    now = NOW + VALUE_REUSE_MS;
    const answer = await service.firstPaint();

    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toEqual({ state: "reading" });
    expect(cardOf(answer, "deepseek").fields["balance"]).toEqual({ state: "reading" });
    // The old value is not served as if it were current, and nothing is called
    // while the page is built.
    expect(cardOf(answer, "anthropic").receivedAt).toBeNull();
    expect(remote.calls).toHaveLength(2);
  });
});

describe("the reads of one answer", () => {
  it("starts every provider's read before it awaits the first one", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const replies = readerReplies();
    const calls: string[] = [];
    const impl = async (input: unknown): Promise<unknown> => {
      const url = String(input);
      calls.push(url);
      await gate;
      const reply = replies[url];
      if (reply === undefined) throw new Error(`this test gave no answer for ${url}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(reply.body ?? {}) };
    };
    const service = serviceOf({ catalog: readerCatalog(), fetch: impl as unknown as typeof globalThis.fetch });

    const pending = service.answer();
    // A sequential loop would still be waiting for the first provider here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);

    open();
    const answer = await pending;
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toMatchObject({ state: "value" });
    expect(cardOf(answer, "deepseek").fields["balance"]).toMatchObject({ state: "value" });
  });

  it("stops one provider's read at ten seconds and leaves the other card alone", async () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
    const signals: AbortSignal[] = [];
    const impl = async (input: unknown, init?: { signal?: AbortSignal }): Promise<unknown> => {
      const url = String(input);
      if (url === DEEPSEEK_BALANCE_URL) {
        return { ok: true, status: 200, text: async () => JSON.stringify(DEEPSEEK_BODY) };
      }
      const signal = init?.signal;
      if (signal === undefined) throw new Error("a provider read was given no deadline");
      signals.push(signal);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const service = createUsageService({
      models: () => modelsOf(readerCatalog()),
      records: { totals: async () => TOTALS },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: impl as unknown as typeof globalThis.fetch,
      // The deadline is a constant of the service; a test sets it small so the
      // suite does not wait ten seconds for the same code path.
      timeoutMs: 20,
    });

    const answer = await service.answer();

    // The reason is a fixed phrase, not the browser's own error sentence.
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toEqual({ state: "error", reason: "timeout" });
    expect(cardOf(answer, "anthropic").fields["weekly"]).toEqual({ state: "error", reason: "timeout" });
    // The other provider answered, and its card is untouched by the one timeout.
    expect(cardOf(answer, "deepseek").fields["balance"]).toMatchObject({ state: "value" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("the prefetch at daemon start", () => {
  it("reads each provider once and leaves the value for the first page", async () => {
    const remote = fakeFetch(readerReplies());
    const service = serviceOf({ catalog: readerCatalog(), fetch: remote.fetch });

    await service.prefetch();
    expect(remote.calls).toHaveLength(2);

    const answer = await service.firstPaint();
    expect(cardOf(answer, "anthropic").fields["fiveHour"]).toMatchObject({ state: "value" });
    expect(cardOf(answer, "deepseek").fields["balance"]).toMatchObject({ state: "value" });

    // A second prefetch inside the ten-minute reuse calls nothing.
    await service.prefetch();
    expect(remote.calls).toHaveLength(2);
  });

  it("honours the provider's minimum interval after a failed read", async () => {
    let now = NOW;
    const calls: string[] = [];
    const impl = async (input: unknown): Promise<unknown> => {
      calls.push(String(input));
      throw new Error("the provider did not answer");
    };
    const service = serviceOf({
      catalog: readerCatalog(),
      fetch: impl as unknown as typeof globalThis.fetch,
      now: () => now,
    });

    await service.prefetch();
    expect(calls).toHaveLength(2);

    // Inside Anthropic's five minutes and DeepSeek's one minute: no call.
    now = NOW + 30 * 1000;
    await service.prefetch();
    expect(calls).toHaveLength(2);

    // Past both floors, and with no value held, each is asked again.
    now = NOW + 5 * 60 * 1000;
    await service.prefetch();
    expect(calls).toHaveLength(4);
  });

  it("never rejects when the catalog itself fails", async () => {
    const service = createUsageService({
      models: () =>
        ({
          getProviders: () => {
            throw new Error("the catalog is not readable");
          },
        }) as unknown as UsageModels,
      records: { totals: async () => TOTALS },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: fakeFetch({}).fetch,
    });

    await expect(service.prefetch()).resolves.toBeUndefined();
  });
});

/**
 * The OpenAI card.
 *
 * OpenAI's API key can read neither the prepaid credit balance nor the
 * organization's spend: the balance endpoint takes a browser session key, and the
 * cost endpoints take an admin key that pi-sec does not hold. So the card states
 * the fact and links the page where the credits are bought, and it asks OpenAI for
 * nothing at all.
 */
describe("the OpenAI card", () => {
  /** Where the OpenAI card sends a reader for its balance. */
  const OPENAI_BILLING = {
    label: "OpenAI billing page",
    url: "https://platform.openai.com/settings/organization/billing",
  };

  function openaiCatalog(): Catalog {
    return catalogOf({
      providers: [{ id: "openai", name: "OpenAI" }],
      configured: ["openai"],
      auth: { openai: "fake-openai-api-key-0006" },
    });
  }

  it("states the sentence and the billing link in the balance row instead of WIP", async () => {
    const service = serviceOf({ catalog: openaiCatalog(), fetch: fakeFetch({}).fetch });
    const card = cardOf(await service.answer(), "openai");

    expect(card.shape).toBe("prepaid");
    expect(card.receivedAt).toBeNull();
    expect(card.fields["balance"]).toEqual({
      state: "value",
      value: { amount: null, currency: null, note: "No API for the balance", billing: OPENAI_BILLING },
    });
  });

  it("calls no address at all, neither on the answer, the page load, a refresh nor the prefetch", async () => {
    // A fetch that fails the test if it is asked for anything: the absence of a
    // call is the whole point, so an address this table gained would show up here.
    const asked: string[] = [];
    const impl = async (input: unknown): Promise<unknown> => {
      asked.push(String(input));
      throw new Error(`the OpenAI card asked ${String(input)}`);
    };
    const service = serviceOf({ catalog: openaiCatalog(), fetch: impl as unknown as typeof globalThis.fetch });

    await service.answer();
    await service.firstPaint();
    await service.prefetch();
    const refreshed = await service.refresh("openai");
    expect(refreshedCard(refreshed).fields["balance"]).toMatchObject({ state: "value" });

    expect(asked).toEqual([]);
    // No warning about a held value either: nothing failed, because nothing ran.
    expect(refreshedCard(refreshed).hold).toBeUndefined();
  });

  it("keeps its ledger windows, which are pi-sec's own calls", async () => {
    const totals = new Map<string, UsageLedger>([
      [
        "openai",
        {
          windows: {
            day: { calls: 3, tokens: 4000, cost: 0.06 },
            week: { calls: 9, tokens: 12_000, cost: 0.18 },
            month: { calls: 40, tokens: 60_000, cost: 0.9 },
          },
          daily: emptyLedger(NOW).daily,
        },
      ],
    ]);
    const service = serviceOf({ catalog: openaiCatalog(), fetch: fakeFetch({}).fetch, totals });
    const card = cardOf(await service.answer(), "openai");

    expect(card.fields["day"]).toEqual({ state: "value", value: { calls: 3, tokens: 4000, cost: 0.06 } });
    expect(card.fields["week"]).toEqual({ state: "value", value: { calls: 9, tokens: 12_000, cost: 0.18 } });
    expect(card.fields["month"]).toEqual({ state: "value", value: { calls: 40, tokens: 60_000, cost: 0.9 } });
    expect(slotsOf(card)).toHaveLength(30);
  });

  it("keeps WIP for a provider no entry names and no reader fills", async () => {
    const catalog = catalogOf({ providers: [{ id: "fixture-meter", name: "Fixture Meter" }], configured: ["fixture-meter"] });
    const service = serviceOf({ catalog, fetch: fakeFetch({}).fetch });
    expect(cardOf(await service.answer(), "fixture-meter").fields["balance"]).toEqual({ state: "wip" });
  });
});

/**
 * The decision models card.
 *
 * A judgement runs outside every conversation, so no provider card counts it. The
 * rows come from the audit trail's judgement lines, by judge name, over the three
 * windows. The card is absent when nothing judges, and its cost is never added to
 * a provider card's windows.
 */
describe("the decision models card", () => {
  /** A ledger sum over one judge's three windows, as the audit reader answers it. */
  function recorded(): Map<string, import("../src/server/usage/judges.ts").JudgeUsageRow> {
    return new Map([
      [
        "report-check",
        {
          name: "report-check",
          provider: "openai",
          model: "gpt-6-luna",
          windows: {
            day: { calls: 2, tokens: 800, cost: 0.0008, unanswered: 0 },
            week: { calls: 12, tokens: 4000, cost: 0.0042, unanswered: 2 },
            month: { calls: 57, tokens: 16_100, cost: 0.0199, unanswered: 9 },
          },
        },
      ],
    ]);
  }

  /** A service over the OpenAI card and the rows above. */
  function serviceWith(options: {
    readonly judges: Readonly<Record<string, { provider?: string; modelId?: string }>>;
    readonly rows?: Map<string, import("../src/server/usage/judges.ts").JudgeUsageRow>;
    readonly now?: () => number;
    readonly reads?: () => void;
  }): ReturnType<typeof createUsageService> {
    const catalog = catalogOf({
      providers: [{ id: "openai", name: "OpenAI" }],
      configured: ["openai"],
      auth: { openai: "fake-openai-api-key-0006" },
    });
    return createUsageService({
      models: () => modelsOf(catalog),
      records: { totals: async () => new Map() },
      timezone: () => TIMEZONE,
      now: options.now ?? (() => NOW),
      fetch: fakeFetch({}).fetch,
      judgeModels: () => options.judges,
      judgeRecords: {
        rows: async () => {
          options.reads?.();
          return options.rows ?? new Map();
        },
      },
    });
  }

  const CONFIGURED = { "report-check": { provider: "openai", modelId: "gpt-6-luna" } };

  it("counts one judge by name over the three windows, with the config's provider and model", async () => {
    const service = serviceWith({ judges: CONFIGURED, rows: recorded() });
    const answer = await service.answer();

    expect(answer.judges).toBeDefined();
    const rows = answer.judges?.rows ?? [];
    expect(rows.map((row) => row.name)).toEqual(["report-check"]);
    expect(rows[0]?.provider).toBe("openai");
    expect(rows[0]?.model).toBe("gpt-6-luna");
    expect(rows[0]?.day).toEqual({ calls: 2, tokens: 800, cost: 0.0008, unanswered: 0 });
    expect(rows[0]?.week).toEqual({ calls: 12, tokens: 4000, cost: 0.0042, unanswered: 2 });
    expect(rows[0]?.month).toEqual({ calls: 57, tokens: 16_100, cost: 0.0199, unanswered: 9 });
  });

  it("states a judge the config names and the trail has never seen, at zero", async () => {
    const service = serviceWith({ judges: CONFIGURED });
    const rows = (await service.answer()).judges?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "report-check", provider: "openai", model: "gpt-6-luna" });
    // Nothing was spent on it, so every window is zero rather than absent.
    expect(rows[0]?.month).toEqual({ calls: 0, tokens: 0, cost: 0, unanswered: 0 });
  });

  it("states a judge the trail records and the config no longer names", async () => {
    const service = serviceWith({ judges: {}, rows: recorded() });
    const rows = (await service.answer()).judges?.rows ?? [];
    expect(rows.map((row) => row.name)).toEqual(["report-check"]);
    // The config says nothing, so the audit line's own provider and model stand.
    expect(rows[0]).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
  });

  it("leaves the card out entirely when no judge is configured and the trail holds none", async () => {
    const answer = await serviceWith({ judges: {} }).answer();
    expect(answer.judges).toBeUndefined();
    // Not an empty card: the property is absent, which is what the page reads as
    // "draw no decision models card".
    expect(Object.prototype.hasOwnProperty.call(answer, "judges")).toBe(false);
  });

  it("adds nothing of the judgement cost to a provider card's windows", async () => {
    const service = serviceWith({ judges: CONFIGURED, rows: recorded() });
    const card = cardOf(await service.answer(), "openai");
    // The OpenAI card's ledger is empty here, and the judge's 0.0199 of the month
    // is nowhere on it.
    expect(card.fields["day"]).toEqual({ state: "value", value: { calls: 0, tokens: 0, cost: 0 } });
    expect(card.fields["month"]).toEqual({ state: "value", value: { calls: 0, tokens: 0, cost: 0 } });
  });

  it("reads the trail once for ten minutes, as a provider value is reused", async () => {
    let now = NOW;
    let reads = 0;
    const service = serviceWith({ judges: CONFIGURED, rows: recorded(), now: () => now, reads: () => (reads += 1) });

    await service.answer();
    expect(reads).toBe(1);
    now = NOW + VALUE_REUSE_MS - 1;
    await service.answer();
    expect(reads).toBe(1);
    now = NOW + VALUE_REUSE_MS;
    await service.answer();
    expect(reads).toBe(2);
  });

  it("carries the rows in the answer the page is served with, so the page asks for nothing", async () => {
    const service = serviceWith({ judges: CONFIGURED, rows: recorded() });
    const answer = await service.firstPaint();
    const rows = answer.judges?.rows ?? [];
    expect(rows.map((row) => row.name)).toEqual(["report-check"]);
    expect(rows[0]?.month.calls).toBe(57);
  });

  it("carries no text a judgement was shown", async () => {
    const planted = "the judged text that must not reach the answer";
    const rows = recorded();
    // A row cannot hold the text: this checks the serialized answer, which is what
    // reaches the browser.
    const serialized = JSON.stringify(await serviceWith({ judges: CONFIGURED, rows }).answer());
    expect(serialized).not.toContain(planted);
    expect(serialized).toContain("report-check");
  });
});
