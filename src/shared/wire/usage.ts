/**
 * What `GET /api/usage` and `POST /api/usage/refresh` answer, as the usage page
 * reads it.
 *
 * The page draws what the answer holds and names no provider: a field that is
 * absent is a field this provider does not have (a five-hour window, a daily
 * column), and a field that is present is drawn whatever state it is in. So the
 * shapes here describe every field the readers can fill — the balance, the
 * utilization windows and the credits a provider states, and pi-sec's own
 * `day`, `week`, `month` and `daily` fields — and a page keyed by field name picks
 * the one it needs.
 *
 * No code and no import of `src/server` lives here: the page type check reads
 * these files, and the server's own node types must not come with them.
 */

/** A card drawn from a subscription account, or from a prepaid one. */
export type UsageShape = "subscription" | "prepaid";

/** An amount of one currency, as a provider states it. */
export interface UsageMoney {
  readonly amount: number;
  readonly currency: string;
}

/** A moment, and its time in the harness zone as the card prints it. */
export interface UsageTime {
  /** Epoch milliseconds. */
  readonly at: number;
  /** `YYYY-MM-DD HH:mm` in the harness time zone. */
  readonly label: string;
}

/**
 * One utilization window, with the moment it resets.
 *
 * `regenPercent` is the share the window gives back at its next reset, when the
 * provider states one (synthetic.new does). The key is absent when the provider
 * states no such share at all, and null when it states one this build could not
 * read; the page says `resets <time>` for the first and `next regeneration at
 * <time>` for the second.
 */
export interface UsageQuota {
  /** Percent used, or null when the provider did not state one. */
  readonly utilization: number | null;
  readonly resetsAt: UsageTime | null;
  readonly regenPercent?: number | null;
}

/**
 * The usage credits of a subscription account.
 *
 * Every amount is nullable because the provider's answer may omit it: a null
 * `balance` means the provider stated no balance, which is what the card reports
 * instead of an amount of zero. A card whose `billing` is set states a plain used,
 * limit and balance and the page where they are bought; one without it states the
 * vendor console's usage credits and monthly API credits.
 */
export interface UsageCredits {
  readonly enabled: boolean | null;
  readonly used: UsageMoney | null;
  readonly limit: UsageMoney | null;
  readonly disabledReason: string | null;
  readonly balance: UsageMoney | null;
  readonly billing?: { readonly label: string; readonly url: string };
}

/**
 * The balance of a prepaid card.
 *
 * Most prepaid cards state an amount. A provider whose balance no API states
 * carries `note`, the sentence that says so, and `billing`, the page where the
 * balance is bought, in place of an amount: `amount` and `currency` are null for
 * such a card. The page draws the sentence and the link where it would draw the
 * number, so the card says what is true instead of `WIP`.
 */
export interface UsageBalance {
  readonly amount: number | null;
  readonly currency: string | null;
  /** The sentence that stands in place of an amount no API states. */
  readonly note?: string;
  /** Where the balance is bought, when the card draws a link for it. */
  readonly billing?: { readonly label: string; readonly url: string };
}

/** One of pi-sec's own rolling windows on a card. */
export interface UsageTotals {
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

/** One day of a card's last thirty, and what pi-sec spent in it. */
export interface UsageSlot {
  readonly from: UsageTime;
  readonly to: UsageTime;
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

/**
 * The thirty daily slots of a card.
 *
 * Every prepaid card carries them, and a subscription card carries them when its
 * provider's reader names them: the same aggregation counts them for every card.
 */
export interface UsageDaily {
  readonly slots: readonly UsageSlot[];
}

/**
 * One field of a card: a value, a field no reader fills, a value that has not
 * arrived yet, or a failure.
 *
 * `reading` appears only in the answer the server writes into the page itself, for
 * a provider that has a reader and no value held yet. The page draws `Reading…`
 * for it and asks `GET /api/usage` for the rest. An answer to that request has no
 * `reading` field: by then the reader was called, or the field states why not.
 */
export type UsageField =
  | { readonly state: "value"; readonly value: unknown }
  | { readonly state: "wip" }
  | { readonly state: "reading" }
  | { readonly state: "error"; readonly reason: string };

/**
 * Why a card's external value was not brought up to date: the provider's own
 * refusal until a moment, or this server's brake until the next allowed attempt.
 */
export type UsageHold =
  | { readonly kind: "rate_limited"; readonly until: UsageTime }
  | { readonly kind: "kept"; readonly nextAt: UsageTime };

/** One window of one judgement model's calls. */
export interface UsageJudgeTotals {
  /** Every judgement line in the window, answered or not. */
  readonly calls: number;
  /** The tokens the service reported using, over those lines. */
  readonly tokens: number;
  /** The cost the service reported, over those lines, in dollars. */
  readonly cost: number;
  /** The lines that gave no answer: a failed judgement and a skipped one. */
  readonly unanswered: number;
}

/**
 * One judgement model of the answer, by the name the config gives it.
 *
 * A judgement runs outside every conversation, so it is never in pi-sec's ledger:
 * these numbers come from the audit trail, where every judgement leaves one line,
 * and its cost is not added to any provider card's total.
 */
export interface UsageJudgeRow {
  readonly name: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly day: UsageJudgeTotals;
  readonly week: UsageJudgeTotals;
  readonly month: UsageJudgeTotals;
}

/**
 * The judgement models card.
 *
 * It is not a provider card: no provider id, no login shape, no refresh button. It
 * is present when the config names a judge or the audit trail holds a judgement.
 */
export interface UsageJudges {
  readonly rows: readonly UsageJudgeRow[];
}

/** One provider card. */
export interface UsageCard {
  readonly provider: string;
  readonly name: string;
  readonly shape: UsageShape;
  /** When the provider's own value last arrived, or null when none ever did. */
  readonly receivedAt: UsageTime | null;
  /** A line under the card about how its numbers are made, when it has one. */
  readonly note?: string;
  /** Why the external value did not refresh, when it did not. Absent otherwise. */
  readonly hold?: UsageHold;
  /** The shape's fields, by name. */
  readonly fields: Readonly<Record<string, UsageField>>;
}

/** The whole answer of `GET /api/usage`. */
export interface UsageAnswer {
  readonly generatedAt: number;
  readonly timezone: string;
  readonly cards: readonly UsageCard[];
  /** The judgement models card. Absent when nothing judges and nothing ever did. */
  readonly judges?: UsageJudges;
}

/** The whole answer of `POST /api/usage/refresh`: the one card that was asked for. */
export interface UsageRefreshAnswer {
  readonly generatedAt: number;
  readonly timezone: string;
  readonly card: UsageCard;
}
