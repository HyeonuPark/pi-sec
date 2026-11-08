/**
 * The answer of `GET /api/usage`: one card per provider that has auth right now.
 *
 * Which cards exist is asked of the model catalog on every request, so a provider
 * that was logged in a minute ago, or that a `models.json` or an extension added
 * after the daemon started, has its card on the next request with no restart and
 * no code change. A provider without auth has no card.
 *
 * A provider an extension declared virtual has no card either, whether or not it
 * has auth. Such a provider does not answer requests itself: it hands each one to
 * another provider, and pi-sec's ledger records that call under the provider that
 * answered. A card for it would state zeros beside the card that already holds
 * the numbers, so every path here that selects a card skips it, and a refresh of
 * it answers as a provider this server has no card for.
 *
 * Each card takes one of two shapes from the provider's current login: a
 * subscription login draws utilization and credits, and every other login (an API
 * key, a non-subscription OAuth login, cloud credentials) draws a balance. The
 * three usage windows and the thirty daily slots come from pi-sec's own ledger for
 * every provider, on a prepaid card always and on a subscription card when that
 * provider's entry in `fetchers.ts` names them. The balance, utilization and
 * credit fields come from the provider's API through the registry in `fetchers.ts`,
 * and a field no entry fills states `wip`.
 *
 * Five rules govern the external calls.
 *
 * - **A request calls out, and the daemon's start does it once.** There is no
 *   timer here. `prefetch()` is the one call that no request made: the daemon
 *   runs it once when the server starts, so the first page after a restart
 *   usually has values already. A page that nobody opens costs nothing after it.
 * - **Every call has a deadline.** A provider that does not answer within
 *   `PROVIDER_TIMEOUT_MS` fails for its own card, and the other cards still draw.
 * - **A value is reused for ten minutes**, per provider, so reloading the page
 *   does not multiply calls. Two requests that arrive together share one call.
 * - **A refusal (HTTP 429) stops that provider for thirty minutes**, and the card
 *   then shows the last value it received with the time it received it. One
 *   provider's refusal never touches another provider's card.
 * - **A refresh obeys a provider's own minimum interval** counted from its last
 *   attempt, so a page whose button is pressed again and again still costs one
 *   call per interval. See `#refreshExternal`.
 *
 * Nothing in the answer is a credential: no key, no token, no account or
 * organization id. A failure is reported as a status, never as the provider's own
 * sentence, which can carry account details.
 */
import {
  BALANCE_NOTICES,
  USAGE_FETCHERS,
  UsageHttpError,
  UsageShapeError,
  type FetchedValues,
  type LedgerFieldName,
  type ProviderCredential,
  type ProviderFetcher,
} from "./fetchers.ts";
import { emptyLedger, type UsageLedger, type UsageRecords } from "./records.ts";
import {
  errorField,
  momentOf,
  NO_JUDGE_SUMS,
  READING_FIELD,
  timeField,
  valueField,
  WIP_FIELD,
  type CreditLine,
  type JudgeCard,
  type PrepaidBalance,
  type UsageAnswer,
  type UsageCard,
  type UsageField,
  type UsageHold,
  type UsageRefreshAnswer,
  type UsageShape,
  type UsageSlot,
} from "./values.ts";
import type { JudgeUsage, JudgeUsageRow } from "./judges.ts";

/** How long one provider's external value is reused without calling again. */
export const VALUE_REUSE_MS = 10 * 60 * 1000;

/**
 * How long one provider's API may take before its card states a failure.
 *
 * The two documented endpoints normally answer in well under a second, so this
 * bounds a hung or throttled provider rather than a slow one. A provider that
 * passes it costs its own card only: the reads run together, and the answer
 * moves on.
 */
export const PROVIDER_TIMEOUT_MS = 10 * 1000;

/** How long a provider that answered HTTP 429 is left alone. */
export const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

/** Why every ledger field of a card is an error when the database cannot be read. */
const LEDGER_REASON = "ledger unreadable";

/** Why a card says its value is held back: the provider refused with HTTP 429. */
const RATE_LIMITED_REASON = "rate limited";

/**
 * A line under a card whose numbers are made in a way worth stating.
 *
 * The DeepSeek line names the pricing rule this build applies to its recorded
 * cost. The two subscription lines say what the amount is: synthetic.new's cost
 * is the weekly credit the call used, at its subscription rates, and Anthropic's
 * is the API list price of the same calls. Neither is a bill, and both count only
 * the calls pi-sec made itself.
 */
export const COST_NOTES: Readonly<Record<string, string>> = {
  deepseek: "Peak/off-peak rates applied · holidays ignored",
  synthetic: "pi-sec calls only · estimated credit use at subscription rates",
  anthropic: "pi-sec calls only · API-equivalent cost",
};

/** One provider as the card selection reads it. */
export interface UsageProvider {
  readonly id: string;
  readonly name?: string;
}

/**
 * The parts of the model catalog this module uses.
 *
 * The daemon hands it the coding agent's runtime, which answers all of them. A
 * test double may answer only some, so every member is looked for and a missing
 * one has the safe reading: a provider whose auth cannot be checked has no card,
 * and a login shape that cannot be read is not a subscription.
 */
export interface UsageModels {
  getProviders(): readonly UsageProvider[];
  hasConfiguredAuth?(providerId: string): boolean;
  checkAuth?(providerId: string): Promise<unknown>;
  isUsingSubscription?(providerId: string): boolean;
  getAuth?(providerId: string): Promise<{ readonly auth?: { readonly apiKey?: string; readonly headers?: Record<string, string> } } | undefined>;
}

export interface UsageLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface UsageServiceOptions {
  /** The catalog, read again on every request. */
  readonly models: () => UsageModels;
  /** pi-sec's own ledger; `UsageRecords` is one. */
  readonly records: Pick<UsageRecords, "totals">;
  /** The harness time zone, read on every request. */
  readonly timezone: () => string;
  readonly now?: () => number;
  /** `globalThis.fetch` unless a test says otherwise. */
  readonly fetch?: typeof globalThis.fetch;
  readonly fetchers?: Readonly<Record<string, ProviderFetcher>>;
  /** The deadline of one provider call. `PROVIDER_TIMEOUT_MS` unless a test sets it. */
  readonly timeoutMs?: number;
  readonly logger?: UsageLogger;
  /**
   * The judgement models the config names, by the name code calls them with.
   *
   * A judge named here has a row on the decision models card even before its first
   * call, so a configured judge that never answers is visible as a row of zeros.
   * A missing member means the config names no judge.
   */
  readonly judgeModels?: () => Readonly<Record<string, { readonly provider?: string; readonly modelId?: string }>>;
  /**
   * The audit trail, read for the judgement lines every judge call writes.
   *
   * A judgement runs outside any conversation, so this is the only record of it:
   * the ledger counts conversation calls and nothing else. A missing member means
   * nothing can be said about judgements, and the card is absent.
   */
  readonly judgeRecords?: Pick<JudgeUsage, "rows">;
  /**
   * Whether a provider is an extension's virtual one, which answers no request
   * itself and gets no card. A missing member hides nothing.
   */
  readonly isVirtual?: (providerId: string) => boolean;
}

/** Why a value was not refreshed, before the answer stamps it with a label. */
type HoldCause =
  | { readonly kind: "rate_limited"; readonly until: number }
  | { readonly kind: "kept"; readonly nextAt: number };

/** What one provider's external value came to on this request. */
interface ExternalOutcome {
  readonly values: FetchedValues | null;
  /** When the value arrived, or null when it never did. */
  readonly receivedAt: number | null;
  /** Why there is no value, when that is a failure rather than a missing reader. */
  readonly reason: string | null;
  /** Why the value did not refresh, when it did not. */
  readonly hold: HoldCause | null;
  /**
   * Set when this answer was built without asking the provider, so the fields its
   * reader fills are `reading` rather than `wip`.
   */
  readonly pending?: boolean;
}

const NOTHING: ExternalOutcome = { values: null, receivedAt: null, reason: null, hold: null };

/** Whether a read stopped on the deadline this service put on it. */
function timedOut(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/** The reason the answer gives for a failure, in words that cannot carry a secret. */
function reasonOf(error: unknown): string {
  if (error instanceof UsageHttpError) return `HTTP ${error.status}`;
  if (error instanceof UsageShapeError) return error.message;
  if (timedOut(error)) return "timeout";
  return "request failed";
}

/** A card, or the `undefined` a provider without auth answers. */
function isCard(card: UsageCard | undefined): card is UsageCard {
  return card !== undefined;
}

/** The order the page draws cards in: subscription first, then by display name. */
function sortCards(cards: UsageCard[]): UsageCard[] {
  return cards.sort((left, right) => {
    if (left.shape !== right.shape) return left.shape === "subscription" ? -1 : 1;
    if (left.name === right.name) return left.provider < right.provider ? -1 : 1;
    return left.name < right.name ? -1 : 1;
  });
}

/** One provider's ledger, or the empty one when it has no recorded call. */
function ledgerFor(totals: Map<string, UsageLedger> | null, providerId: string, now: number): UsageLedger | null {
  if (totals === null) return null;
  return totals.get(providerId) ?? emptyLedger(now);
}

/** The `hold` property of a card, from why its value did not refresh. */
function holdField(cause: HoldCause, timezone: string): UsageHold {
  if (cause.kind === "rate_limited") return { kind: "rate_limited", until: momentOf(cause.until, timezone) };
  return { kind: "kept", nextAt: momentOf(cause.nextAt, timezone) };
}

/** What a refresh came to: the one card, or a provider this server has no card for. */
export type UsageRefreshResult =
  | { readonly ok: true; readonly answer: UsageRefreshAnswer }
  | { readonly ok: false; readonly code: "unknown_provider" };

export class UsageService {
  readonly #options: UsageServiceOptions;
  /** The last value each provider gave, and when. */
  readonly #values = new Map<string, { values: FetchedValues; receivedAt: number }>();
  /** The last decision models card this service built, and when. */
  #judgeCard: { card: JudgeCard | undefined; at: number } | undefined;
  /** Providers left alone until this moment, after an HTTP 429. */
  readonly #blockedUntil = new Map<string, number>();
  /**
   * What each provider's last call came to, and when it started.
   *
   * A refresh that the minimum interval holds back shows this, and counts the
   * interval from it, so the record outlives the request that made the call.
   */
  readonly #lastAttempt = new Map<string, { readonly at: number; readonly outcome: ExternalOutcome }>();
  /** Calls in flight, so two requests at once cost one call. */
  readonly #inflight = new Map<string, Promise<ExternalOutcome>>();

  constructor(options: UsageServiceOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** One answer, as of now. */
  async answer(): Promise<UsageAnswer> {
    const models = this.#options.models();
    const now = this.#now();
    const timezone = this.#options.timezone();

    const totals = await this.#ledger(now);

    // Every provider's read starts before the first one is awaited, so the calls
    // run together: one slow provider costs its own deadline, not a queue.
    const cards = await Promise.all(
      models.getProviders().map(async (provider) => {
        if (this.#hidden(provider.id)) return undefined;
        if (!(await this.#configured(models, provider.id))) return undefined;
        const shape = this.#shape(models, provider.id);
        // One provider's failure is that provider's card: the read never throws.
        const external = await this.#external(provider.id, shape, models, now).catch(() => NOTHING);
        return this.#card(provider, shape, external, ledgerFor(totals, provider.id, now), timezone);
      }),
    );

    return { generatedAt: now, timezone, cards: sortCards(cards.filter(isCard)), ...(await this.#judges(now)) };
  }

  /**
   * The answer the usage page carries, built from what this service already holds.
   *
   * The page draws with the page load, so nothing here calls a provider. A value
   * this service received within `VALUE_REUSE_MS` is served from memory, under the
   * same rate-limit hold `answer()` would state. A provider with a reader and no
   * such value has the fields its reader fills marked `reading`, which is how the
   * page knows to ask. A provider with no reader keeps `wip`, so it never makes
   * the page ask. The windows and the daily slots come from the ledger, as in
   * `answer()`, so pi-sec's own numbers are on the page immediately.
   *
   * The judgement rows are not a provider value, so this answer carries them as
   * `answer()` does, from the audit trail. They are read here and not by a reader
   * that answers over HTTP: a row the page was served with is already complete,
   * so it never makes the page ask.
   */
  async firstPaint(): Promise<UsageAnswer> {
    const models = this.#options.models();
    const now = this.#now();
    const timezone = this.#options.timezone();

    const totals = await this.#ledger(now);

    const cards = await Promise.all(
      models.getProviders().map(async (provider) => {
        if (this.#hidden(provider.id)) return undefined;
        if (!(await this.#configured(models, provider.id))) return undefined;
        const shape = this.#shape(models, provider.id);
        const external = this.#heldExternal(provider.id, shape, now);
        return this.#card(provider, shape, external, ledgerFor(totals, provider.id, now), timezone);
      }),
    );

    return { generatedAt: now, timezone, cards: sortCards(cards.filter(isCard)), ...(await this.#judges(now)) };
  }

  /**
   * The decision models card, or the empty object when there is nothing to show.
   *
   * One read of the audit trail is reused for `VALUE_REUSE_MS`, the same ten
   * minutes a provider value is reused, so a page load does not read a trail that
   * can hold megabytes every time. A trail that cannot be read at all is no card
   * rather than a failure: this page is about spending, and a judgement the audit
   * trail cannot state is one it cannot state.
   *
   * A row exists for every judge the config names and for every judge the trail
   * records. The config decides the provider and the model, because the config is
   * what the next call uses: a trail whose entries named another model belongs to
   * an earlier configuration, and the windows still count its tokens and its cost,
   * because that is what was spent.
   */
  async #judges(now: number): Promise<{ readonly judges?: JudgeCard }> {
    const held = this.#judgeCard;
    if (held !== undefined && now - held.at < VALUE_REUSE_MS) {
      return held.card === undefined ? {} : { judges: held.card };
    }
    const card = await this.#readJudges(now);
    this.#judgeCard = { card, at: now };
    return card === undefined ? {} : { judges: card };
  }

  /** Build the decision models card from the config and the audit trail. */
  async #readJudges(now: number): Promise<JudgeCard | undefined> {
    const configured = this.#options.judgeModels?.() ?? {};
    let recorded = new Map<string, JudgeUsageRow>();
    try {
      recorded = (await this.#options.judgeRecords?.rows(now)) ?? new Map<string, JudgeUsageRow>();
    } catch (error) {
      this.#options.logger?.warn("usage judges failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const names = [...new Set([...Object.keys(configured), ...recorded.keys()])];
    if (names.length === 0) return undefined;
    names.sort((left, right) => (left < right ? -1 : 1));

    const rows = names.map((name): JudgeCard["rows"][number] => {
      const entry = configured[name];
      const seen = recorded.get(name);
      const windows = seen?.windows ?? { day: NO_JUDGE_SUMS, week: NO_JUDGE_SUMS, month: NO_JUDGE_SUMS };
      return {
        name,
        provider: entry?.provider ?? seen?.provider ?? null,
        model: entry?.modelId ?? seen?.model ?? null,
        day: windows.day,
        week: windows.week,
        month: windows.month,
      };
    });
    return { rows };
  }

  /**
   * Read every provider once, in the background, so a page opened after the daemon
   * starts usually has the values already.
   *
   * The daemon calls this once at start and does not await it. It never throws: a
   * provider that fails leaves its reason in `#lastAttempt` exactly as a request
   * would, and one warning is logged. The ten-minute reuse and each provider's own
   * `refreshFloorMs` are honoured, so a second prefetch inside either window calls
   * nothing.
   */
  async prefetch(): Promise<void> {
    try {
      const models = this.#options.models();
      const now = this.#now();
      const started: Promise<unknown>[] = [];
      for (const provider of models.getProviders()) {
        if (this.#hidden(provider.id)) continue;
        const fetcher = this.#fetcher(provider.id);
        if (fetcher === undefined) continue;
        if (!(await this.#configured(models, provider.id))) continue;
        const shape = this.#shape(models, provider.id);
        if (shape !== fetcher.shape) continue;
        const last = this.#lastAttempt.get(provider.id);
        if (last !== undefined && now - last.at < fetcher.refreshFloorMs) continue;
        // `#external` serves a value held for ten minutes, so a second prefetch
        // inside that window calls nothing either.
        started.push(this.#external(provider.id, shape, models, now).catch(() => NOTHING));
      }
      await Promise.all(started);
    } catch (error) {
      this.#options.logger?.warn("usage prefetch failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One card, brought up to date now.
   *
   * A refresh recounts the ledger, so the windows and slots it answers are as
   * fresh as the answer's. It skips the ten-minute reuse and calls the provider,
   * unless one of the two brakes holds: the HTTP 429 back-off, or the provider's
   * own minimum interval since its last attempt. Either way the card comes back,
   * with a `hold` that says why its value did not change. A provider this server
   * would make no card for is not found, because a refresh is about one card.
   */
  async refresh(providerId: string): Promise<UsageRefreshResult> {
    const models = this.#options.models();
    const now = this.#now();
    const timezone = this.#options.timezone();

    const provider = models.getProviders().find((entry) => entry.id === providerId);
    if (provider === undefined) return { ok: false, code: "unknown_provider" };
    // A virtual provider has no card, so there is nothing here to refresh either.
    // It gets the answer a provider with no card gets, not an error of its own.
    if (this.#hidden(providerId)) return { ok: false, code: "unknown_provider" };
    // The same rule the card selection applies: a provider without auth now has
    // no card, and so nothing to refresh.
    if (!(await this.#configured(models, providerId))) return { ok: false, code: "unknown_provider" };

    const totals = await this.#ledger(now);
    const shape = this.#shape(models, providerId);
    const external = await this.#refreshExternal(providerId, shape, models, now).catch(() => NOTHING);
    return {
      ok: true,
      answer: {
        generatedAt: now,
        timezone,
        card: this.#card(provider, shape, external, ledgerFor(totals, providerId, now), timezone),
      },
    };
  }

  /**
   * The ledger as of `now`, or null when it cannot be read.
   *
   * An unreadable database is one fact on each card, not a failed answer: the
   * windows and the slots state the reason, and every provider call still runs.
   */
  async #ledger(now: number): Promise<Map<string, UsageLedger> | null> {
    try {
      return await this.#options.records.totals(now);
    } catch (error) {
      this.#options.logger?.warn("usage ledger failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** One provider's card, built the same way for the answer and for a refresh. */
  #card(
    provider: UsageProvider,
    shape: UsageShape,
    external: ExternalOutcome,
    ledger: UsageLedger | null,
    timezone: string,
  ): UsageCard {
    const fetcher = this.#fetcher(provider.id);
    const fields =
      shape === "subscription"
        ? subscriptionFields(external, ledger, timezone, fetcher)
        : prepaidFields(external, ledger, timezone, BALANCE_NOTICES[provider.id]);
    const note = COST_NOTES[provider.id];
    const hold = external.hold === null ? undefined : holdField(external.hold, timezone);
    return {
      provider: provider.id,
      name: provider.name ?? provider.id,
      shape,
      receivedAt: timeField(external.receivedAt, timezone),
      ...(note === undefined ? {} : { note }),
      ...(hold === undefined ? {} : { hold }),
      fields,
    };
  }

  /** Whether this provider is an extension's virtual one, and so has no card. */
  #hidden(providerId: string): boolean {
    try {
      return this.#options.isVirtual?.(providerId) === true;
    } catch {
      // A selector that cannot answer leaves the card drawn: a list that is too
      // long is a smaller fault than one that silently drops a provider.
      return false;
    }
  }

  /** Whether this provider has auth now: a stored or ambient credential. */
  async #configured(models: UsageModels, providerId: string): Promise<boolean> {
    if (typeof models.hasConfiguredAuth === "function") {
      try {
        return models.hasConfiguredAuth(providerId) === true;
      } catch {
        return false;
      }
    }
    // A catalog without the synchronous check answers the side-effect-free way.
    // A provider that throws is one nothing can be said about, and no card is the
    // safe reading of "cannot tell".
    if (typeof models.checkAuth === "function") {
      try {
        return (await models.checkAuth(providerId)) !== undefined;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** The reader of one provider, or undefined when this server ships none. */
  #fetcher(providerId: string): ProviderFetcher | undefined {
    return (this.#options.fetchers ?? USAGE_FETCHERS)[providerId];
  }

  /**
   * The card shape this login draws.
   *
   * A subscription login draws a subscription card. So does a login this server's
   * own reader declares to be a subscription even as an API key, which is the one
   * way a provider without an OAuth login can have a subscription card. Every
   * other login is prepaid.
   */
  #shape(models: UsageModels, providerId: string): UsageShape {
    try {
      if (typeof models.isUsingSubscription === "function" && models.isUsingSubscription(providerId) === true) {
        return "subscription";
      }
    } catch {
      // A login shape that cannot be read is not a subscription.
    }
    return this.#fetcher(providerId)?.subscriptionWithApiKey === true ? "subscription" : "prepaid";
  }

  /** The external value of one provider, from the cache, a call, or the reason there is none. */
  async #external(providerId: string, shape: UsageShape, models: UsageModels, now: number): Promise<ExternalOutcome> {
    const fetcher = this.#fetcher(providerId);
    // A reader that speaks about another shape fills nothing here, and is not called.
    if (fetcher === undefined || fetcher.shape !== shape) return NOTHING;

    const held = this.#values.get(providerId);
    const blockedUntil = this.#blockedUntil.get(providerId);
    // The back-off is a fact about the provider, not about the call that found
    // it, so a card whose value is still fresh says it is inside one as well.
    const hold: HoldCause | null =
      blockedUntil !== undefined && blockedUntil > now ? { kind: "rate_limited", until: blockedUntil } : null;

    if (held !== undefined && now - held.receivedAt < VALUE_REUSE_MS) {
      return { values: held.values, receivedAt: held.receivedAt, reason: null, hold };
    }
    if (hold !== null) {
      return held === undefined
        ? { values: null, receivedAt: null, reason: RATE_LIMITED_REASON, hold }
        : { values: held.values, receivedAt: held.receivedAt, reason: null, hold };
    }
    return await this.#call(providerId, fetcher, models, now);
  }

  /**
   * The external value of one provider, from memory only.
   *
   * It makes the same decision `#external` makes, without the call: a value held
   * inside the reuse window, the rate-limit hold, and otherwise the statement that
   * a value is on its way. So the page's first paint shows what the next answer
   * would show, minus the call nobody has made yet.
   */
  #heldExternal(providerId: string, shape: UsageShape, now: number): ExternalOutcome {
    const fetcher = this.#fetcher(providerId);
    // A reader that speaks about another shape fills nothing here, as in `answer()`.
    if (fetcher === undefined || fetcher.shape !== shape) return NOTHING;

    const held = this.#values.get(providerId);
    const blockedUntil = this.#blockedUntil.get(providerId);
    const hold: HoldCause | null =
      blockedUntil !== undefined && blockedUntil > now ? { kind: "rate_limited", until: blockedUntil } : null;

    if (held !== undefined && now - held.receivedAt < VALUE_REUSE_MS) {
      return { values: held.values, receivedAt: held.receivedAt, reason: null, hold };
    }
    if (hold !== null) {
      return held === undefined
        ? { values: null, receivedAt: null, reason: RATE_LIMITED_REASON, hold }
        : { values: held.values, receivedAt: held.receivedAt, reason: null, hold };
    }
    return { values: null, receivedAt: null, reason: null, hold: null, pending: true };
  }

  /**
   * The external value of one provider on a refresh.
   *
   * A refresh skips the ten-minute reuse: the page asked for a new value, and it
   * already shows the held one. Two brakes stay. The HTTP 429 back-off is never
   * bypassed. And the provider's own minimum interval is counted from its last
   * attempt, not from its last success, so that "at most one Anthropic call per
   * five minutes and one DeepSeek call per minute, however many clicks or tabs"
   * holds also when a call fails: a provider that refuses quickly must not be
   * asked again at the speed of the refusals.
   */
  async #refreshExternal(
    providerId: string,
    shape: UsageShape,
    models: UsageModels,
    now: number,
  ): Promise<ExternalOutcome> {
    const fetcher = this.#fetcher(providerId);
    // A provider with no reader, or with a reader of the other shape, refreshes
    // its ledger fields only: there is no external value to ask again for.
    if (fetcher === undefined || fetcher.shape !== shape) return NOTHING;

    const held = this.#values.get(providerId);
    const blockedUntil = this.#blockedUntil.get(providerId);
    if (blockedUntil !== undefined && blockedUntil > now) {
      return {
        ...(held === undefined
          ? { values: null, receivedAt: null, reason: RATE_LIMITED_REASON }
          : { values: held.values, receivedAt: held.receivedAt, reason: null }),
        hold: { kind: "rate_limited", until: blockedUntil },
      };
    }

    const last = this.#lastAttempt.get(providerId);
    if (last !== undefined && now - last.at < fetcher.refreshFloorMs) {
      // What the last attempt left is what the card shows meanwhile: the value it
      // brought, or, when it failed and nothing was ever received, its reason.
      return { ...last.outcome, hold: { kind: "kept", nextAt: last.at + fetcher.refreshFloorMs } };
    }
    return await this.#call(providerId, fetcher, models, now);
  }

  /** One call, shared with any request already in flight for the same provider. */
  async #call(providerId: string, fetcher: ProviderFetcher, models: UsageModels, now: number): Promise<ExternalOutcome> {
    const pending = this.#inflight.get(providerId);
    if (pending !== undefined) return await pending;

    const run = this.#read(providerId, fetcher, models, now);
    this.#inflight.set(providerId, run);
    try {
      return await run;
    } finally {
      this.#inflight.delete(providerId);
    }
  }

  /** One call to a provider's API, and what to show afterwards. */
  async #read(providerId: string, fetcher: ProviderFetcher, models: UsageModels, now: number): Promise<ExternalOutcome> {
    const credential = await this.#credential(models, providerId);
    let outcome: ExternalOutcome;
    try {
      const values = await fetcher.read({ fetch: this.#withDeadline(), credential });
      this.#values.set(providerId, { values, receivedAt: now });
      outcome = { values, receivedAt: now, reason: null, hold: null };
    } catch (error) {
      const reason = reasonOf(error);
      let hold: HoldCause | null = null;
      if (error instanceof UsageHttpError && error.status === 429) {
        const until = now + RATE_LIMIT_BACKOFF_MS;
        this.#blockedUntil.set(providerId, until);
        // This answer is inside the back-off it just started, and says so.
        hold = { kind: "rate_limited", until };
      }
      this.#options.logger?.warn("usage value failed", { provider: providerId, reason });
      // A provider that stops answering keeps showing what it last said, with the
      // time it said it, instead of emptying its card.
      const held = this.#values.get(providerId);
      outcome =
        held === undefined
          ? { values: null, receivedAt: null, reason, hold }
          : { values: held.values, receivedAt: held.receivedAt, reason: null, hold };
    }
    // Kept after the call, so a refresh that arrives while it runs shares the
    // call instead of finding an attempt it could not account for.
    this.#lastAttempt.set(providerId, { at: now, outcome });
    return outcome;
  }

  /**
   * The fetch one provider read uses, with this service's deadline on it.
   *
   * The signal belongs to the call itself, so a provider that never answers is
   * dropped with the card that states the failure rather than left running behind
   * it. A reader gets the same `fetch` signature it always did, and may still pass
   * its own options; the signal is the one this service sets.
   */
  #withDeadline(): typeof globalThis.fetch {
    const fetch = this.#options.fetch ?? globalThis.fetch;
    const timeoutMs = this.#options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
      fetch(input, { ...(init ?? {}), signal: AbortSignal.timeout(timeoutMs) })) as typeof globalThis.fetch;
  }

  /** The provider's request auth. A resolution that throws is no credential. */
  async #credential(models: UsageModels, providerId: string): Promise<ProviderCredential | undefined> {
    if (typeof models.getAuth !== "function") return undefined;
    try {
      const resolved = await models.getAuth(providerId);
      const auth = resolved?.auth;
      if (auth === undefined) return undefined;
      const credential: ProviderCredential = {
        ...(typeof auth.apiKey === "string" && auth.apiKey !== "" ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
      };
      return credential;
    } catch {
      return undefined;
    }
  }
}

/**
 * The field of a provider value that did not arrive, when that is not a failure.
 *
 * `wip` is a provider with no reader at all, and nothing is on the way for it.
 * `reading` is the first-paint answer's reading: the provider has a reader, the
 * page was served before it was asked, and the value is on its way.
 */
function absentField(external: ExternalOutcome): UsageField {
  return external.pending === true ? READING_FIELD : WIP_FIELD;
}

/** One of the three rolling windows of a card, from the ledger. */
function windowField(ledger: UsageLedger | null, name: "day" | "week" | "month"): UsageField {
  return ledger === null ? errorField(LEDGER_REASON) : valueField(ledger.windows[name]);
}

/** The thirty daily slots of a card, from the ledger. */
function dailyField(ledger: UsageLedger | null, timezone: string): UsageField {
  if (ledger === null) return errorField(LEDGER_REASON);
  return valueField({
    slots: ledger.daily.map(
      (slot): UsageSlot => ({
        from: momentOf(slot.from, timezone),
        to: momentOf(slot.to, timezone),
        calls: slot.calls,
        tokens: slot.tokens,
        cost: slot.cost,
      }),
    ),
  });
}

/** The ledger fields a card carries, by name, in the order they are listed. */
function ledgerFieldsOf(
  names: readonly LedgerFieldName[],
  ledger: UsageLedger | null,
  timezone: string,
): Record<string, UsageField> {
  const fields: Record<string, UsageField> = {};
  for (const name of names) {
    fields[name] = name === "daily" ? dailyField(ledger, timezone) : windowField(ledger, name);
  }
  return fields;
}

/**
 * The fields of a subscription card.
 *
 * A provider that has no five-hour window carries no `fiveHour` field, so the page
 * draws no such row: the page draws the fields the answer holds, and names no
 * provider. The credit line carries the billing link when its reader names one.
 *
 * The weekly value carries the regeneration share exactly when its reader stated
 * one, key and all: the page tells a provider that states none (Anthropic) from one
 * that states one it could not read (a null), and only the reader knows which.
 *
 * A provider whose reader names ledger fields carries them after its own, from
 * pi-sec's ledger: the three rolling windows and the thirty daily slots, drawn
 * and worded exactly as a prepaid card draws them. They are independent of the
 * provider's answer, so a provider that does not answer leaves them drawn, and a
 * ledger that cannot be read leaves the provider's own fields as they are.
 */
function subscriptionFields(
  external: ExternalOutcome,
  ledger: UsageLedger | null,
  timezone: string,
  fetcher: ProviderFetcher | undefined,
): Record<string, UsageField> {
  const hasFiveHour = fetcher?.hasFiveHour !== false;
  const billing = fetcher?.billing;
  const ledgerFields = ledgerFieldsOf(fetcher?.ledgerFields ?? [], ledger, timezone);
  const values = external.values;
  if (values === null || values.kind !== "subscription") {
    const field: UsageField = external.reason === null ? absentField(external) : errorField(external.reason);
    return {
      ...(hasFiveHour ? { fiveHour: field } : {}),
      weekly: field,
      credits: field,
      ...ledgerFields,
    };
  }
  return {
    ...(hasFiveHour
      ? {
          fiveHour: valueField({
            utilization: values.fiveHour.utilization,
            resetsAt: timeField(values.fiveHour.resetsAt, timezone),
          }),
        }
      : {}),
    weekly: valueField({
      utilization: values.weekly.utilization,
      resetsAt: timeField(values.weekly.resetsAt, timezone),
      // Absent stays absent: the page prints `resets` only for a provider that
      // states no regeneration share at all.
      ...("regenPercent" in values.weekly ? { regenPercent: values.weekly.regenPercent } : {}),
    }),
    credits: valueField({
      enabled: values.credits.enabled,
      used: values.credits.used,
      limit: values.credits.limit,
      disabledReason: values.credits.disabledReason,
      balance: values.credits.balance,
      ...(billing === undefined ? {} : { billing }),
    } satisfies CreditLine),
    ...ledgerFields,
  };
}

/**
 * The five fields of a prepaid card: the balance, pi-sec's own three windows, and
 * the thirty daily slots the page draws under them.
 *
 * A provider whose balance no API states carries the sentence and the billing
 * link that stand in its place, from `BALANCE_NOTICES`. That card calls nothing,
 * so it has no value and no failure either, and the balance it states is the
 * notice rather than `wip`: nothing is on its way for it.
 */
function prepaidFields(
  external: ExternalOutcome,
  ledger: UsageLedger | null,
  timezone: string,
  balanceNotice: { readonly note: string; readonly billing: { readonly label: string; readonly url: string } } | undefined,
): Record<string, UsageField> {
  const values = external.values;
  const balance: UsageField =
    values !== null && values.kind === "prepaid"
      ? valueField(values.balance === null ? null : { amount: values.balance.amount, currency: values.balance.currency })
      : balanceNotice !== undefined
        ? valueField({
            amount: null,
            currency: null,
            note: balanceNotice.note,
            billing: balanceNotice.billing,
          } satisfies PrepaidBalance)
        : external.reason === null
          ? absentField(external)
          : errorField(external.reason);
  return {
    balance,
    day: windowField(ledger, "day"),
    week: windowField(ledger, "week"),
    month: windowField(ledger, "month"),
    daily: dailyField(ledger, timezone),
  };
}

/** The service the daemon's usage route holds. */
export function createUsageService(options: UsageServiceOptions): UsageService {
  return new UsageService(options);
}
