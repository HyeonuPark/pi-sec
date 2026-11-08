/**
 * The words and numbers the usage page prints for one value.
 *
 * The server sends values, not sentences: an amount is a number and a currency, a
 * share is a percentage, and a moment is an epoch time with the label the server
 * already wrote in the harness zone. This file is the one place that turns those
 * into the text the card shows, so a bar and its percentage cannot disagree and no
 * page code formats a time itself.
 */
import type { UsageTime } from "../../shared/wire/usage.ts";

/** A finite number, or null for anything else. */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The amount of a `{ amount, currency }`, or null when none is stated. */
export function amountNumber(amount: unknown): number | null {
  if (amount === null || amount === undefined || typeof amount !== "object") return null;
  return numberOrNull((amount as { amount?: unknown }).amount);
}

/** An amount as `$11.25`, or `11.25 EUR` for another currency, or `not stated`. */
export function money(amount: unknown): string {
  if (amount === null || amount === undefined || typeof amount !== "object") return "not stated";
  const value = Number((amount as { amount?: unknown }).amount);
  if (!Number.isFinite(value)) return "not stated";
  const currency = String((amount as { currency?: unknown }).currency ?? "");
  return currency === "USD" ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

/** An estimated cost. A cost of one call is small, so it keeps four decimals. */
export function cost(amount: unknown, currency?: string | null): string {
  const value = Number(amount);
  if (amount === null || amount === undefined || !Number.isFinite(value)) return "not stated";
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  const text = value.toFixed(digits);
  const unit = currency === undefined || currency === null ? "USD" : String(currency);
  return unit === "USD" ? `$${text}` : `${text} ${unit}`;
}

/** A cost in a column's tooltip: always `$x.xx`, because a day is a rough sum. */
export function shortCost(amount: unknown): string {
  const value = numberOrNull(amount);
  return `$${(value === null ? 0 : value).toFixed(2)}`;
}

/** A whole count with thousands separators, or `0` for no number. */
export function count(value: unknown): string {
  const parsed = numberOrNull(value);
  return parsed === null ? "0" : parsed.toLocaleString("en-US");
}

/** A percentage without a trailing `.0`, or `not stated`. */
export function percent(value: unknown): string {
  if (value === null || value === undefined) return "not stated";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "not stated";
  return `${parsed % 1 === 0 ? String(parsed) : parsed.toFixed(1)}%`;
}

/** `out_of_credits` reads as `out of credits`. */
export function words(value: unknown): string {
  return String(value).replace(/_/g, " ");
}

/** The `HH:mm` of a moment, read off the label the server wrote. */
export function hhmm(moment: UsageTime | null | undefined): string {
  const label = moment !== null && moment !== undefined && typeof moment.label === "string" ? moment.label : "";
  return label.slice(11) || "--:--";
}

/** A share cut to 0..100, whole when it can be, else one decimal. */
export function bounded(value: unknown): number {
  const parsed = numberOrNull(value);
  if (parsed === null) return 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed % 1 === 0 ? parsed : Math.round(parsed * 10) / 10;
}

/** The level of a share: under 70 is ok, under 90 warns, 90 and up is danger. */
export function level(share: number): "ok" | "warn" | "danger" {
  if (share >= 90) return "danger";
  if (share >= 70) return "warn";
  return "ok";
}
