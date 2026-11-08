/**
 * The two time forms the harness writes.
 *
 * The harness has one clock, the `timezone` value in `config.json`, and it says
 * which zone that is so nobody has to guess. Two forms come from it:
 *
 *   - `zoneIso`: `2030-01-15T16:30:05+00:00`. Second precision, with the offset
 *     in force at that instant, so a machine can read it and a person can still
 *     see the zone.
 *   - `zoneMinute`: `2030-01-15 16:30 +00:00`. Minute precision, for a line a
 *     person reads.
 *
 * The offset is never a constant. A zone with summer time has two of them, and
 * the one that belongs on a line is the one in force at that instant, so the
 * wall clock is read out of `Intl` and the offset is the distance between that
 * wall clock and the instant itself. A zone name is not abbreviated to `CET` or
 * `PST`: `Intl` does not answer those for every zone (`Asia/Tokyo` comes back
 * as `GMT+9`), and an abbreviation loses the half-hour zones anyway.
 */

/** One instant as a wall clock in a zone, with that zone's offset at the instant. */
interface ZonedInstant {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  /** `+09:00`, `-07:00`, `+05:30`, `+00:00`. */
  readonly offset: string;
}

function inZone(ms: number, timeZone: string): ZonedInstant {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const wall = Date.UTC(
    Number(field("year")),
    Number(field("month")) - 1,
    Number(field("day")),
    Number(field("hour")),
    Number(field("minute")),
    Number(field("second")),
  );
  // Whole minutes: every zone offset in tzdata is a whole number of minutes, and
  // the subtraction carries the sub-second part of `ms`, which rounds away here.
  const totalMinutes = Math.round((wall - ms) / 60_000);
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
    offset,
  };
}

/**
 * One instant as ISO 8601 in a named zone, to the second: `2030-01-15T16:30:05+00:00`.
 *
 * Truncation, not rounding: a millisecond value of 999 stays in the second it
 * belongs to, because a rounded value would name a second later than the
 * instant the value stands for.
 */
export function zoneIso(ms: number, timeZone: string): string {
  const at = inZone(ms, timeZone);
  return `${at.year}-${at.month}-${at.day}T${at.hour}:${at.minute}:${at.second}${at.offset}`;
}

/**
 * One instant as a person reads it, to the minute: `2030-01-15 16:30 +00:00`.
 *
 * Minute precision because this form goes into a document a person reads, and
 * the offset is kept so the line still names the zone it was written in.
 */
export function zoneMinute(ms: number, timeZone: string): string {
  const at = inZone(ms, timeZone);
  return `${at.year}-${at.month}-${at.day} ${at.hour}:${at.minute} ${at.offset}`;
}

/**
 * One record with a readable twin beside each of its time fields.
 *
 * A tool that answers with a whole record keeps every number, because a script
 * may read those, and adds `<name>Local` next to the ones the caller would
 * otherwise convert by hand. The number stays the record's own value and the
 * twin is only ever added here, in the answer: a stored record does not grow a
 * `Local` key.
 *
 * A zero gets no twin. The stores write 0 into a field that was never set, and
 * `1970-01-01T00:00:00+00:00` would name an instant that never happened. A key
 * that is absent, null, or a string (a `once.at` given as ISO text) gets none
 * either, because there is no number to twin.
 */
export function withLocal<T extends object>(
  record: T,
  keys: readonly string[],
  timeZone: string,
): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
      out[`${key}Local`] = zoneIso(value, timeZone);
    }
  }
  return out as T & Record<string, unknown>;
}
