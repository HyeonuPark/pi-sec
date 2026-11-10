/**
 * The external values a provider card shows, one reader per provider id.
 *
 * A card has two shapes, and each shape has fields no record can fill: a
 * subscription card needs the provider's own utilization and reset times, and a
 * prepaid card needs the account's balance. Those come from the provider's API,
 * with the credential pi-sec already holds for it.
 *
 * **One registry, keyed by provider id.** Adding a provider later is one entry
 * here; the card selection, the page and the shapes do not change. A provider
 * with no entry keeps its card and shows `WIP` in the fields this registry would
 * have filled.
 *
 * An entry declares the shape it fills, so a provider whose login is not the
 * shape its reader speaks about is not called at all: an Anthropic API key makes
 * a prepaid card, and the usage endpoint this registry knows needs a subscription
 * token. An entry may also declare that its own API key draws the subscription
 * shape, which is what synthetic.new needs: a weekly credit subscription behind
 * an API key.
 *
 * An entry may also name the fields its subscription card takes from pi-sec's own
 * ledger (`ledgerFields`), which is how a provider's own quota is shown beside
 * what pi-sec spent with it. The page draws the fields the answer holds, so the
 * list is the answer's own way of saying which rows a card has, and no card code
 * names a provider.
 *
 * Nothing here logs, returns or embeds a credential. A request that fails is an
 * error carrying its HTTP status and nothing else: the provider's answer can hold
 * account details, and the card only needs to say that the value did not arrive.
 */
import { moneyOf, type CreditLine, type Money, type QuotaWindow, type UsageShape } from "./values.ts";

/** What one read of a provider's API came to. */
export interface SubscriptionValues {
  readonly kind: "subscription";
  readonly fiveHour: QuotaWindow;
  readonly weekly: QuotaWindow;
  readonly credits: CreditLine;
}

export interface PrepaidValues {
  readonly kind: "prepaid";
  readonly balance: Money | null;
}

export type FetchedValues = SubscriptionValues | PrepaidValues;

/** The credential of one provider, in the only two forms a HTTP header takes it. */
export interface ProviderCredential {
  /** The key or token itself, as `getAuth` answers it. */
  readonly apiKey?: string;
  /** The headers `getAuth` already built, which win over `apiKey`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FetcherContext {
  readonly fetch: typeof globalThis.fetch;
  readonly credential: ProviderCredential | undefined;
}

/**
 * A field a card can take from pi-sec's own ledger: one of the three rolling
 * windows, or the thirty daily slots, named as the answer names them.
 */
export type LedgerFieldName = "day" | "week" | "month" | "daily";

/** One provider's reader, the card shape it fills, and how often it may be asked. */
export interface ProviderFetcher {
  readonly shape: UsageShape;
  readonly read: (context: FetcherContext) => Promise<FetchedValues>;
  /**
   * The least time between two calls to this provider, whatever asked for them.
   *
   * A page reload reuses the held value for ten minutes, but a refresh is a
   * request to call again, and this is the floor under it. It is counted from the
   * last attempt, not the last success, so failed calls count too.
   */
  readonly refreshFloorMs: number;
  /**
   * Whether this provider's account has a five-hour window. Default true.
   *
   * A provider that has none is read in the subscription shape anyway, and its
   * card then carries no `fiveHour` field at all: the page draws the fields the
   * answer holds, so the row a provider does not have is a row the answer does not
   * carry. Stated here rather than in the page, because the page names no
   * provider.
   */
  readonly hasFiveHour?: boolean;
  /**
   * Whether this provider's API key draws a subscription card.
   *
   * A provider that sells a weekly credit subscription but issues an API key has
   * no OAuth login that could say so. Only its own reader knows that the key is a
   * subscription: reading the flag off `shape` alone would turn every API key
   * login into a subscription card, and that would change the card of an
   * installation that signs in to Anthropic with a key.
   */
  readonly subscriptionWithApiKey?: boolean;
  /**
   * Where this account's prepaid balance is bought, when the card draws a link
   * for it instead of the vendor's own console line. The label is the link text.
   */
  readonly billing?: { readonly label: string; readonly url: string };
  /**
   * The ledger fields a subscription card of this provider carries, in the order
   * the card shows them after its own fields.
   *
   * Every prepaid card carries all four, from the ledger alone. A subscription
   * card carries the ones its provider states here, because a subscription card
   * is about the provider's own quota and only the provider's own reader knows
   * whether pi-sec's calls are worth putting beside it: Anthropic gets the daily
   * slots, and synthetic.new gets the three windows and the slots. A provider
   * that states none keeps the card it had. The fields come from the same
   * aggregation the prepaid card uses, keyed by the provider id of the ledger.
   */
  readonly ledgerFields?: readonly LedgerFieldName[];
}

/** A provider's answer was not a success. The status is all the card needs. */
export class UsageHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
    this.name = "UsageHttpError";
  }
}

/** A provider answered something this build does not read. */
export class UsageShapeError extends Error {
  constructor() {
    super("unexpected answer");
    this.name = "UsageShapeError";
  }
}

/** One object, or undefined. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** An ISO timestamp as epoch milliseconds, or null when it is not one. */
function timeOrNull(value: unknown): number | null {
  const text = textOrNull(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The bearer value of a credential: its `Authorization` header first, then its key. */
export function bearerOf(credential: ProviderCredential | undefined): string | undefined {
  if (credential === undefined) return undefined;
  for (const [name, value] of Object.entries(credential.headers ?? {})) {
    if (name.toLowerCase() !== "authorization") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    return trimmed.replace(/^bearer\s+/i, "");
  }
  const key = credential.apiKey?.trim();
  if (key === undefined || key === "") return undefined;
  return key.replace(/^bearer\s+/i, "");
}

/**
 * One JSON answer from a provider.
 *
 * The caller passes the headers it needs; the credential's own headers are added
 * first, so a provider that resolves an unusual scheme keeps it. A redirect is
 * not followed (`redirect: "manual"`), so the credential's headers never go to a
 * second address: only a success with a body this build can read is a value.
 */
async function fetchJson(
  context: FetcherContext,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const merged: Record<string, string> = { ...(context.credential?.headers ?? {}), ...headers };
  const response = await context.fetch(url, { method: "GET", headers: merged, redirect: "manual" });
  if (!response.ok) throw new UsageHttpError(response.status);
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new UsageShapeError();
  }
  const object = objectOf(body);
  if (object === undefined) throw new UsageShapeError();
  return object;
}

/** A quota window from one field of the usage answer. */
function quotaOf(value: unknown): QuotaWindow {
  const window = objectOf(value);
  if (window === undefined) return { utilization: null, resetsAt: null };
  return {
    utilization: numberOrNull(window["utilization"]),
    resetsAt: timeOrNull(window["resets_at"]),
  };
}

/** A money value that arrives as an object: `amount` or `amount_minor` plus `exponent`. */
function moneyOfObject(value: unknown, fallbackCurrency: string): Money | null {
  const object = objectOf(value);
  if (object === undefined) return null;
  const currency = textOrNull(object["currency"]) ?? fallbackCurrency;
  const direct = numberOrNull(object["amount"]);
  if (direct !== null) return { amount: direct, currency };
  const minor = numberOrNull(object["amount_minor"]);
  if (minor === null) return null;
  const exponent = numberOrNull(object["exponent"]);
  return { amount: minor / 10 ** (exponent === null ? 2 : exponent), currency };
}

/**
 * The usage credits of a subscription account, from the two blocks the usage
 * answer carries.
 *
 * `extra_usage` holds the monthly limit and the used amount; `spend` holds the
 * same state in the newer shape, plus the balance. A value present in one block
 * and absent in the other is taken from whichever has it; a null balance is the
 * normal answer for an account that cannot buy credits, and it stays null so the
 * card can say the balance is not available rather than show zero.
 */
function creditsOf(body: Record<string, unknown>): CreditLine {
  const extra = objectOf(body["extra_usage"]);
  const spend = objectOf(body["spend"]);
  const currency = textOrNull(extra?.["currency"]) ?? textOrNull(objectOf(spend?.["used"])?.["currency"]) ?? "USD";
  return {
    enabled: booleanOrNull(spend?.["enabled"]) ?? booleanOrNull(extra?.["is_enabled"]),
    used:
      moneyOfObject(extra?.["used_credits"] === undefined ? undefined : { amount: extra["used_credits"], currency }, currency) ??
      moneyOfObject(spend?.["used"], currency),
    limit: moneyOfObject(extra?.["monthly_limit"] === undefined ? undefined : { amount: extra["monthly_limit"], currency }, currency)
      ?? moneyOfObject(spend?.["limit"], currency),
    disabledReason: textOrNull(extra?.["disabled_reason"]) ?? textOrNull(spend?.["disabled_reason"]),
    balance: moneyOfObject(spend?.["balance"], currency),
  };
}

/** The address the Claude subscription's own usage is read from. */
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The address a prepaid DeepSeek account's balance is read from. */
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** The address a synthetic.new account's weekly credit quota is read from. */
export const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

/** Where the balance of a synthetic.new account is bought and topped up. */
const SYNTHETIC_BILLING = { label: "synthetic.new billing page", url: "https://synthetic.new/billing" };

/** Where an OpenAI account's prepaid credits are bought. */
const OPENAI_BILLING = {
  label: "OpenAI billing page",
  url: "https://platform.openai.com/settings/organization/billing",
};

/**
 * The subscription's utilization, reset times and credits.
 *
 * The endpoint is the one the vendor's own client uses and is not documented, so
 * its answer can change without notice. A field this build cannot read stays null
 * and the rest of the card still draws.
 */
async function readAnthropic(context: FetcherContext): Promise<FetchedValues> {
  const bearer = bearerOf(context.credential);
  if (bearer === undefined) throw new UsageHttpError(401);
  const body = await fetchJson(context, ANTHROPIC_USAGE_URL, {
    Authorization: `Bearer ${bearer}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    accept: "application/json",
    "user-agent": "claude-cli/2.1.280",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
  });
  return {
    kind: "subscription",
    fiveHour: quotaOf(body["five_hour"]),
    weekly: quotaOf(body["seven_day"]),
    credits: creditsOf(body),
  };
}

/**
 * The prepaid balance of a DeepSeek account.
 *
 * The answer lists one balance per currency. The first one with an amount is the
 * one the card shows; an account with no listed balance has no balance to show,
 * which is not an error.
 */
async function readDeepSeek(context: FetcherContext): Promise<FetchedValues> {
  const bearer = bearerOf(context.credential);
  if (bearer === undefined) throw new UsageHttpError(401);
  const body = await fetchJson(context, DEEPSEEK_BALANCE_URL, {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
  });
  const infos = Array.isArray(body["balance_infos"]) ? body["balance_infos"] : [];
  for (const info of infos) {
    const balance = moneyOf(objectOf(info)?.["total_balance"], textOrNull(objectOf(info)?.["currency"]) ?? "USD");
    if (balance !== null) return { kind: "prepaid", balance };
  }
  return { kind: "prepaid", balance: null };
}

/**
 * An amount of dollars, from the number the answer states or from the `"$24.00"`
 * string it writes instead.
 *
 * A thousands separator and the currency sign are part of the written form, not
 * of the amount. Anything else is no amount at all, rather than zero.
 */
function dollarsOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A share of a window, cut to two decimals so a floating point tail cannot leak into it. */
function shareOf(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The share of a quota that was used, from the share the answer says is left.
 *
 * The answer states what remains, as 0 to 100. A value outside that range is one
 * this build cannot read, so it stays null like any other unread field.
 */
function usedShareOf(value: unknown): number | null {
  const remaining = numberOrNull(value);
  if (remaining === null || remaining < 0 || remaining > 100) return null;
  return shareOf(100 - remaining);
}

/**
 * The share a weekly quota gives back at its next reset.
 *
 * synthetic.new states it as a whole percent of the weekly limit. A value that is
 * not a positive whole number is no share this build can print, and stays null.
 */
function regenerationOf(value: unknown): number | null {
  const share = numberOrNull(value);
  if (share === null || !Number.isInteger(share) || share <= 0) return null;
  return share;
}

/**
 * The weekly credit quota of a synthetic.new account.
 *
 * synthetic.new sells a weekly credit subscription and issues an API key rather
 * than an OAuth login, so this reader fills the subscription shape: the weekly
 * share that is used, the moment the credits come back, the share that comes back
 * with them, and the credit line.
 *
 * The endpoint is not documented, and the block that holds the quota is known only
 * from third-party code. Two blocks exist: `planWeeklyLimit` states the share that
 * remains, the next regeneration time and the percent that returns, and is the one
 * this account answers; `weeklyTokenLimit` states the same shape with credit
 * amounts, and is kept as the fallback for an account whose plan still answers it.
 * Each block sits at the top level in some answers and under `data` in others, so
 * both places are looked at. The plan block is read first, and a block that is in
 * neither place is no answer at all, which fails the way every other unreadable
 * answer does. A field inside the block that this build cannot read stays null, and
 * the rest of the card still draws.
 */
async function readSynthetic(context: FetcherContext): Promise<FetchedValues> {
  const bearer = bearerOf(context.credential);
  if (bearer === undefined) throw new UsageHttpError(401);
  const body = await fetchJson(context, SYNTHETIC_QUOTAS_URL, {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
  });
  const data = objectOf(body["data"]);
  const plan = objectOf(body["planWeeklyLimit"]) ?? objectOf(data?.["planWeeklyLimit"]);
  if (plan !== undefined) {
    return {
      kind: "subscription",
      // synthetic.new states no five-hour window, and its card draws none.
      fiveHour: { utilization: null, resetsAt: null },
      weekly: {
        utilization: usedShareOf(plan["percentRemaining"]),
        resetsAt: timeOrNull(plan["nextRegenAt"]),
        regenPercent: regenerationOf(plan["nextRegenPercent"]),
      },
      // This block states no credit amounts at all: the card says so in one line
      // instead of printing three empty ones.
      credits: { enabled: null, used: null, limit: null, disabledReason: null, balance: null },
    };
  }
  const block = objectOf(body["weeklyTokenLimit"]) ?? objectOf(data?.["weeklyTokenLimit"]);
  if (block === undefined) throw new UsageShapeError();
  const limit = dollarsOrNull(block["maxCredits"]);
  const remaining = dollarsOrNull(block["remainingCredits"]);
  return {
    kind: "subscription",
    // synthetic.new states no five-hour window, and its card draws none.
    fiveHour: { utilization: null, resetsAt: null },
    // This block states no regeneration share, so the page keeps writing `resets`.
    weekly: {
      utilization: usedShareOf(block["percentRemaining"]),
      resetsAt: timeOrNull(block["nextRegenAt"]),
      regenPercent: null,
    },
    credits: {
      enabled: null,
      // A used amount is a subtraction of two stated amounts, and is stated only
      // when both of them arrived.
      used:
        limit === null || remaining === null
          ? null
          : { amount: Math.round((limit - remaining) * 1e6) / 1e6, currency: "USD" },
      limit: limit === null ? null : { amount: limit, currency: "USD" },
      disabledReason: null,
      balance: remaining === null ? null : { amount: remaining, currency: "USD" },
    },
  };
}

/**
 * Every provider a card can fill a value for, keyed by provider id.
 *
 * Adding one is adding one entry. Nothing else names a provider: the card
 * selection asks this table, and the page draws whatever the fields hold.
 */
/**
 * The balance line of a provider whose balance no API states.
 *
 * `prepaidFields()` in `service.ts` states `wip` for a balance no reader fills,
 * because a value may still be on its way. For these providers nothing is on its
 * way: no API pi-sec may call returns the amount. The entry is a table of its own
 * rather than a `ProviderFetcher` entry, because a fetcher is a reader and would
 * be called, kept for ten minutes, held back after an HTTP 429 and refreshed by a
 * button, and none of that is true of a card whose value comes from nothing.
 *
 * `openai` is the one entry. Its API key can read neither the prepaid credit
 * balance nor the organization's spend: the balance endpoint takes a browser
 * session key only, and the cost endpoints take an admin key that pi-sec does not
 * hold. OpenAI's own CLI, codex, does the same thing with an API key login: it
 * states that the key is configured and points at the billing page. So the card
 * states the sentence and links the page where the credits are bought, and it
 * calls no address at all.
 */
export const BALANCE_NOTICES: Readonly<
  Record<string, { readonly note: string; readonly billing: { readonly label: string; readonly url: string } }>
> = {
  openai: { note: "No API for the balance", billing: OPENAI_BILLING },
};

export const USAGE_FETCHERS: Readonly<Record<string, ProviderFetcher>> = {
  anthropic: {
    shape: "subscription",
    read: readAnthropic,
    // Five minutes rather than one: the usage endpoint is undocumented, rapid
    // repeats were reported to cause HTTP 429 answers that last a long time,
    // and at least five minutes between two calls was advised.
    refreshFloorMs: 5 * 60 * 1000,
    // The recorded cost of a Claude call is the API list price, so the card's
    // daily columns are an API-equivalent amount beside the subscription quota.
    ledgerFields: ["daily"],
  },
  deepseek: { shape: "prepaid", read: readDeepSeek, refreshFloorMs: 60 * 1000 },
  synthetic: {
    shape: "subscription",
    read: readSynthetic,
    // The same floor as Anthropic, and for the same reason: the quota endpoint is
    // undocumented, and an HTTP 429 it answers lasts long enough that two calls
    // are kept minutes apart rather than seconds.
    refreshFloorMs: 5 * 60 * 1000,
    hasFiveHour: false,
    subscriptionWithApiKey: true,
    billing: SYNTHETIC_BILLING,
    ledgerFields: ["day", "week", "month", "daily"],
  },
};
