/**
 * The shapes one provider card is built from, and the small readers that turn a
 * provider's answer into them.
 *
 * A field of a card is one of four things, and the page draws each of them
 * differently: a value it can show, `wip` for a field no reader fills yet,
 * `reading` for a provider value the server has not received yet, and a failure
 * with a reason. Keeping that distinction in the wire format is what lets the
 * page draw the rest of a card when one provider's call fails, and lets a
 * provider with no reader keep its card instead of disappearing.
 *
 * `reading` is the first-paint answer's own state: the page is served before any
 * provider is asked, so a card with a reader and no held value says that its
 * value is on the way, and the page asks for it. It never appears in the answer
 * of `GET /api/usage`, which by then has called the reader or knows why not.
 */

/** A subscription card, or a prepaid one. */
export type UsageShape = "subscription" | "prepaid";

/** An amount of one currency, as a provider states it. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/** One utilization window of a subscription, with the moment it resets. */
export interface QuotaWindow {
  /** Percent used, or null when the provider did not state one. */
  readonly utilization: number | null;
  /** Epoch milliseconds, or null. */
  readonly resetsAt: number | null;
  /**
   * The share the window gives back at its next reset, in percent, when the
   * provider states one.
   *
   * The key is absent for a provider that states no such share at all (Anthropic),
   * and null for a block that states one this build could not read: the page tells
   * the two apart, and writes `resets` for the first and `next regeneration` for
   * the second.
   */
  readonly regenPercent?: number | null;
}

/**
 * The usage credits of a subscription account.
 *
 * Every field is nullable because the provider's answer may omit it: a null
 * `balance` means the provider stated no balance, which is what the card reports
 * instead of an amount of zero.
 */
export interface CreditLine {
  readonly enabled: boolean | null;
  readonly used: Money | null;
  readonly limit: Money | null;
  readonly disabledReason: string | null;
  readonly balance: Money | null;
  /**
   * Where this account's prepaid balance and extra usage are bought, when the card
   * draws that link instead of the vendor console line. `label` is the link text.
   *
   * The page keeps two credit lines and picks one by this field: a card that names
   * a billing page states a plain used, limit and balance, and one that names none
   * states the usage credits and the monthly API credits of the vendor console.
   */
  readonly billing?: { readonly label: string; readonly url: string };
}

/** A moment, and its time in the harness zone as the card prints it. */
export interface UsageTime {
  /** Epoch milliseconds. */
  readonly at: number;
  /** `YYYY-MM-DD HH:mm` in the harness time zone. */
  readonly label: string;
}

/** One field of a card. */
export type UsageField =
  | { readonly state: "value"; readonly value: unknown }
  | { readonly state: "wip" }
  | { readonly state: "reading" }
  | { readonly state: "error"; readonly reason: string };

/** One day of a prepaid card's last thirty, and what pi-sec spent in it. */
export interface UsageSlot {
  /** The start of the slot, on a whole minute. */
  readonly from: UsageTime;
  /** The end of the slot. The newest slot ends at the moment of the answer. */
  readonly to: UsageTime;
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

/**
 * Why a card's external value was not brought up to date.
 *
 * `rate_limited` is the provider's own refusal: it answered HTTP 429, and every
 * call is held back until `until`. `kept` is this server's own brake: the value
 * the card shows is younger than the provider lets it call again, and `nextAt` is
 * the first moment a refresh may call. Only a refresh answers `kept`, because
 * only a refresh asks for a new value.
 */
export type UsageHold =
  | { readonly kind: "rate_limited"; readonly until: UsageTime }
  | { readonly kind: "kept"; readonly nextAt: UsageTime };

/** The field of a provider with no reader for it. */
export const WIP_FIELD: UsageField = { state: "wip" };

/** A window of a judge the audit trail holds no line for. */
export const NO_JUDGE_SUMS: JudgeTotals = { calls: 0, tokens: 0, cost: 0, unanswered: 0 };

/**
 * The field of a provider value the page was served before it arrived.
 *
 * It is the first-paint answer's way of saying "this card has a reader, and it
 * has not been asked yet": the page draws `Reading…` and asks for the value. A
 * provider with no reader keeps `wip`, because no value is on the way for it.
 */
export const READING_FIELD: UsageField = { state: "reading" };

export function valueField(value: unknown): UsageField {
  return { state: "value", value };
}

export function errorField(reason: string): UsageField {
  return { state: "error", reason };
}

/**
 * The balance of a prepaid card.
 *
 * Most prepaid cards state an amount. A provider whose balance no API states
 * carries `note`, the sentence that says so, and `billing`, the page where the
 * balance is bought, in place of an amount: `amount` and `currency` are null for
 * such a card. The page draws the note and the link instead of the number.
 */
export interface PrepaidBalance {
  readonly amount: number | null;
  readonly currency: string | null;
  /** The sentence that stands in place of an amount no API states. */
  readonly note?: string;
  /** Where the balance is bought, when the card draws a link for it. */
  readonly billing?: { readonly label: string; readonly url: string };
}

/** One window of one judgement model's calls. */
export interface JudgeTotals {
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
 * these numbers come from the audit trail, where every judgement leaves one line.
 */
export interface JudgeRow {
  readonly name: string;
  /** The provider of the judge: the config's entry first, else the audit line. */
  readonly provider: string | null;
  /** The model id of the judge: the config's entry first, else the audit line. */
  readonly model: string | null;
  readonly day: JudgeTotals;
  readonly week: JudgeTotals;
  readonly month: JudgeTotals;
}

/**
 * The judgement models card.
 *
 * It is not a provider card: it counts a model pi-sec calls itself, outside any
 * conversation, and its cost is not added to any provider card's total. It is
 * present when the config names a judge or the audit trail holds a judgement.
 */
export interface JudgeCard {
  readonly rows: readonly JudgeRow[];
}

/** One card of `GET /api/usage`. */
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
  /** The moment the answer was built. */
  readonly generatedAt: number;
  readonly timezone: string;
  readonly cards: readonly UsageCard[];
  /** The judgement models card. Absent when nothing judges and nothing ever did. */
  readonly judges?: JudgeCard;
}

/** The whole answer of `POST /api/usage/refresh`: the one card that was asked for. */
export interface UsageRefreshAnswer {
  /** The moment the answer was built. */
  readonly generatedAt: number;
  readonly timezone: string;
  readonly card: UsageCard;
}

/**
 * An amount, from a number or from the string a provider writes it as.
 *
 * A prepaid balance arrives as a decimal string (`"11.25"`), and a null or an
 * unreadable value is no amount at all rather than zero.
 */
export function moneyOf(value: unknown, currency: string): Money | null {
  if (typeof value === "number") return Number.isFinite(value) ? { amount: value, currency } : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? { amount, currency } : null;
}

/**
 * A moment in one time zone, as `YYYY-MM-DD HH:mm`.
 *
 * `parts` rather than a formatted string, because a locale's own pattern moves
 * with the locale and this label is read beside a number the page did not format.
 * An hour of `24` is midnight in some ICU builds and is written as `00`.
 */
export function stampInZone(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}`;
}

/** One moment this build computed itself, as the wire format carries it. */
export function momentOf(at: number, timeZone: string): UsageTime {
  return { at, label: stampInZone(at, timeZone) };
}

/** One moment as the wire format carries it, or null. */
export function timeField(at: number | null, timeZone: string): UsageTime | null {
  if (at === null || !Number.isFinite(at)) return null;
  return momentOf(at, timeZone);
}
