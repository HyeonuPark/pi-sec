/**
 * One field of a usage card, drawn the way the hand-written page drew it.
 *
 * The same elements, classes and ids as the hand-written usage page (removed in
 * this commit): a quota field is a bar
 * with its percentage and reset time, a credit line states what was used against
 * what limit, a prepaid window states calls, tokens and cost, and a daily field is
 * one column per slot. `usage.css` styles exactly these, so nothing here may
 * rename one of them.
 *
 * Every length is written through the CSSOM (`style.width`, `style.height`), never
 * as a style attribute written as text: the page's policy allows no inline style,
 * and the browser would drop such a text without a word.
 */
import type { ComponentChildren } from "preact";
import type {
  UsageBalance,
  UsageCredits,
  UsageDaily,
  UsageField,
  UsageQuota,
  UsageSlot,
  UsageTime,
  UsageTotals,
} from "../../shared/wire/usage.ts";
import { amountNumber, bounded, cost, count, level, money, numberOrNull, percent, shortCost, words } from "./format.ts";

/**
 * The fields of each card shape, in the order the card shows them.
 *
 * A subscription card draws pi-sec's own windows and daily columns after its own
 * three fields, for the providers whose reader names them: the page draws the
 * fields the answer holds, so a provider whose answer carries none keeps the card
 * it had, and the page names no provider.
 */
export const FIELDS: Readonly<Record<"subscription" | "prepaid", readonly { key: string; name: string }[]>> = {
  subscription: [
    { key: "fiveHour", name: "5-hour limit" },
    { key: "weekly", name: "Weekly limit" },
    { key: "credits", name: "Credits" },
    { key: "day", name: "Last 24 hours" },
    { key: "week", name: "Last 7 days" },
    { key: "month", name: "Last 30 days" },
    { key: "daily", name: "Usage per day" },
  ],
  prepaid: [
    { key: "balance", name: "Prepaid balance" },
    { key: "day", name: "Last 24 hours" },
    { key: "week", name: "Last 7 days" },
    { key: "month", name: "Last 30 days" },
    { key: "daily", name: "Usage per day" },
  ],
};

/** The line every prepaid card carries about where its numbers come from. */
export const PREPAID_NOTE = "pi-sec calls only · estimated cost";

/** The address the monthly API credits of a paid subscription are bought on. */
export const CONSOLE_BILLING_URL = "https://platform.claude.com/settings/billing";

/**
 * One horizontal bar. Its length is the share in percent and its colour level is a
 * data attribute the stylesheet reads, so a share and its length cannot disagree.
 */
export function Bar({ share }: { share: unknown }) {
  const value = bounded(share);
  return (
    <div class="usage-bar" data-level={level(value)}>
      <div class="usage-bar-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

/** A plain value line, the shape of every non-bar field. */
function Line({ text, className }: { text: string; className?: string }) {
  return <div class={className ?? "usage-line"}>{text}</div>;
}

/** A link that opens away from the page, so the usage view stays where it was. */
function LinkTo({ url, text }: { url: string; text: string }) {
  return (
    <a class="usage-link" href={url} target="_blank" rel="noreferrer noopener">
      {text}
    </a>
  );
}

/**
 * The sentence beside a quota's percentage.
 *
 * A window the server states no regeneration share for says when it resets. One
 * that states the share says what comes back at that moment: `next +2% at …`, or
 * `next regeneration at …` when the share could not be read. The key's presence is
 * the signal, so a card from a provider that states none reads exactly as it did.
 */
export function quotaNote(value: UsageQuota): string {
  const time = value.resetsAt;
  if (time === null || time === undefined) return "reset time not stated";
  if (!("regenPercent" in value)) return `resets ${time.label}`;
  const share = value.regenPercent;
  return share === null || share === undefined
    ? `next regeneration at ${time.label}`
    : `next +${percent(share)} at ${time.label}`;
}

/** The value of a quota field: a bar, the percentage and the reset time. */
export function QuotaValue({ value }: { value: UsageQuota }) {
  return (
    <div class="usage-quota">
      <div class="usage-field-head">
        <span class="usage-value">{percent(value.utilization)}</span>
        <span class="usage-muted usage-small">{quotaNote(value)}</span>
      </div>
      {numberOrNull(value.utilization) !== null ? <Bar share={value.utilization} /> : null}
    </div>
  );
}

/** Whether a credit line states none of its three amounts. */
function noAmounts(value: UsageCredits): boolean {
  return value.used == null && value.limit == null && value.balance == null;
}

/**
 * The value of the credits field.
 *
 * A credit line that names a billing page is an account whose balance is bought
 * there: it states the used, the whole and the remaining amounts, and the link.
 * When it states none of the three, it says `Amounts not provided` in place of the
 * amounts and still links the page, because there is nothing to print. One that
 * names no billing page is the vendor console's usage credits, whose monthly API
 * credits have no API to read and are linked on the console instead.
 */
export function CreditsValue({ value }: { value: UsageCredits }) {
  const limit = amountNumber(value.limit);
  const used = amountNumber(value.used);
  const bar = limit !== null && limit > 0 && used !== null ? <Bar share={(used / limit) * 100} /> : null;

  if (value.billing !== undefined) {
    return (
      <div class="usage-credits">
        {noAmounts(value) ? (
          <Line text="Amounts not provided" />
        ) : (
          <div class="usage-line">
            <span>{`used ${money(value.used)}`}</span>
            <span class="usage-muted">{` · limit ${money(value.limit)}`}</span>
            <span class="usage-muted">{` · balance ${money(value.balance)}`}</span>
          </div>
        )}
        {bar}
        <div class="usage-line">
          <span>{"Prepaid balance and extra usage: see the "}</span>
          <LinkTo url={value.billing.url} text={value.billing.label} />
        </div>
      </div>
    );
  }

  const state = value.enabled === true ? "on" : value.enabled === false ? "off" : "state not stated";
  return (
    <div class="usage-credits">
      <div class="usage-line">
        <span>{`Usage credits: ${state}`}</span>
        {value.disabledReason ? <span class="usage-muted">{` (${words(value.disabledReason)})`}</span> : null}
        <span class="usage-muted">{` · used ${money(value.used)}`}</span>
        <span class="usage-muted">{` · monthly limit ${value.limit === null ? "none" : money(value.limit)}`}</span>
        <span class="usage-muted">
          {value.balance === null ? " · Balance not available" : ` · balance ${money(value.balance)}`}
        </span>
      </div>
      {bar}
      <div class="usage-line">
        <span>{"Monthly API credits: No API"}</span>
        <span class="usage-muted">{" · "}</span>
        <LinkTo url={CONSOLE_BILLING_URL} text="Console billing" />
      </div>
    </div>
  );
}

/**
 * The value of a prepaid balance.
 *
 * A balance that states an amount is the large number the card always drew. A
 * balance no API states carries the sentence that says so and the page where it is
 * bought: the card then states the fact and the way to the number, instead of
 * `WIP`, which would promise a value that nothing will send.
 */
export function BalanceValue({ value }: { value: UsageBalance | null | undefined }) {
  const note = value?.note;
  const billing = value?.billing;
  if (typeof note === "string" && note !== "") {
    return (
      <div class="usage-balance-notice">
        <Line text={note} className="usage-line usage-balance-note" />
        {billing === undefined ? null : (
          <div class="usage-line">
            <LinkTo url={billing.url} text={billing.label} />
          </div>
        )}
      </div>
    );
  }
  return <Line text={money(value)} className="usage-line usage-balance" />;
}

/** The value of one usage window: calls, tokens and the estimated cost. */
export function WindowValue({ value }: { value: UsageTotals | undefined }) {
  const usage = value ?? { calls: 0, tokens: 0, cost: 0 };
  return <Line text={`${count(usage.calls)} calls · ${count(usage.tokens)} tokens · ${cost(usage.cost, "USD")}`} />;
}

/** The tooltip of one daily column: its window, its cost and its call count. */
function columnTitle(slot: UsageSlot): string {
  const from: UsageTime | undefined = slot.from;
  const to: UsageTime | undefined = slot.to;
  return `${from?.label ?? "--"} to ${to?.label ?? "--"} · ${shortCost(slot.cost)} · ${count(slot.calls)} calls`;
}

/**
 * The value of the daily field: one column per slot, oldest first, and the columns
 * of the last seven slots marked as the recent ones.
 *
 * Height follows a slot's cost over the largest cost of the 30. When the whole
 * month costs nothing — a card read before its first paid call — height follows the
 * call count instead, and the label under the columns says so.
 */
export function DailyValue({ value }: { value: UsageDaily | undefined }) {
  const slots = value?.slots ?? [];
  let maxCost = 0;
  let maxCalls = 0;
  for (const slot of slots) {
    maxCost = Math.max(maxCost, Number(slot.cost) || 0);
    maxCalls = Math.max(maxCalls, Number(slot.calls) || 0);
  }
  const byCalls = maxCost <= 0;
  const top = byCalls ? maxCalls : maxCost;

  return (
    <div class="usage-daily">
      <div class="usage-days">
        {slots.map((slot, index) => {
          const weight = byCalls ? Number(slot.calls) || 0 : Number(slot.cost) || 0;
          const share = top > 0 ? weight / top : 0;
          const height = `${Math.round(Math.max(0, Math.min(1, share)) * 1000) / 10}%`;
          const className = index >= slots.length - 7 ? "usage-day usage-day--recent" : "usage-day";
          return <div class={className} style={{ height }} title={columnTitle(slot)} />;
        })}
      </div>
      {byCalls ? <p class="usage-days-label">by calls</p> : null}
    </div>
  );
}

/** The value of one field, whatever state it is in. */
export function FieldValue({ fieldKey, field }: { fieldKey: string; field: UsageField }) {
  if (field.state === "wip") return <Line text="WIP" className="usage-line usage-wip" />;
  // A provider the page was served before its value arrived: the page asks for it
  // and draws the value in place of this line.
  if (field.state === "reading") return <Line text="Reading…" className="usage-line usage-reading" />;
  if (field.state === "error") {
    return <Line text={`Not available (${field.reason})`} className="usage-line usage-error" />;
  }
  return valueOf(fieldKey, field.value);
}

/**
 * The value of a field the answer states, picked by the field's name.
 *
 * The answer's value is untyped (`unknown`) because one field can be any of the
 * shapes above; the field's name is what says which one this is.
 */
function valueOf(fieldKey: string, value: unknown): ComponentChildren {
  if (fieldKey === "fiveHour" || fieldKey === "weekly") return <QuotaValue value={value as UsageQuota} />;
  if (fieldKey === "credits") return <CreditsValue value={value as UsageCredits} />;
  if (fieldKey === "balance") return <BalanceValue value={value as UsageBalance | null | undefined} />;
  if (fieldKey === "daily") return <DailyValue value={value as UsageDaily | undefined} />;
  return <WindowValue value={value as UsageTotals | undefined} />;
}

/** One row of a card: a name on the left, the field's value on the right. */
export function FieldRow({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <div class="usage-field">
      <span class="usage-field-name">{name}</span>
      <div class="usage-field-value">{children}</div>
    </div>
  );
}
