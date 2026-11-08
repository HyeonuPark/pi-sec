/**
 * The two ways a row says a time: the exact stamp in its tooltip, and the short
 * age beside it.
 *
 * Both come from the hand-written chats page (removed in this commit), unchanged:
 * a clock in the harness time zone built from `formatToParts` (so every browser
 * prints the same order), a `UTC` fallback for a name `Intl` will not take, and
 * the same four ages (`just now`, `Nm ago`, `Nh ago`, `Nd ago`).
 */
import { timezone } from "../mount.ts";

/** The harness time zone, read once: a page does not move while it is open. */
let zoneName: string | undefined;

/** The zone a stamp is written in, or `UTC` when the page carried no stamp. */
function zone(): string {
  zoneName ??= timezone() === "" ? "UTC" : timezone();
  return zoneName;
}

/** The formatter, built on first use and kept. */
let formatter: Intl.DateTimeFormat | undefined;

/** A clock in the harness zone, or a UTC one when the zone name is not a zone. */
function zoneFormat(): Intl.DateTimeFormat {
  if (formatter !== undefined) return formatter;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone(), ...options });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
  }
  return formatter;
}

/** One time as `2030-01-15 14:00 UTC`. Empty when it is not a time. */
export function zoneStamp(at: number | null | undefined): string {
  if (at === null || at === undefined) return "";
  const ms = Number(at);
  if (!Number.isFinite(ms)) return "";
  const fields: Record<string, string> = {};
  for (const part of zoneFormat().formatToParts(new Date(ms))) fields[part.type] = part.value;
  return `${fields["year"]}-${fields["month"]}-${fields["day"]} ${fields["hour"]}:${fields["minute"]} ${zone()}`;
}

/** How long ago a time was, in the row's short form. Empty when it is not a time. */
export function relativeTime(at: number | null | undefined): string {
  const seconds = Math.round((Date.now() - Number(at)) / 1000);
  if (at === null || at === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
