/**
 * The measurement behind the `expiry_check` tool: a registry of dated entries,
 * and the entries whose warning window has been entered.
 *
 * Nothing here knows what an entry is for. The registry schema is the whole
 * input contract — `expires_on`, `warn_days_before`, `note`, `renew` — so one
 * machine serves credential expiry, a certificate, or a lease. The registry
 * itself stays outside: the caller names the file and the machine reads no
 * other input.
 *
 * All date arithmetic is done on UTC midnights. A local-time difference would
 * make the day count move with the host's time zone and with daylight saving,
 * and a day count that changes for a reason nobody can see is worse than no
 * day count at all.
 */

/** A registry entry, validated. */
export interface ExpiryEntry {
  readonly name: string;
  readonly expiresOn: string;
  readonly warnDaysBefore?: number;
  readonly note?: string;
  readonly renew?: string;
}

/** One entry inside its warning window, in the form the tool reports. */
export interface DueEntry {
  readonly name: string;
  readonly expires_on: string;
  /** Whole days from the measured day to `expires_on`. Negative once expired. */
  readonly daysLeft: number;
  readonly note?: string;
  readonly renew?: string;
}

export interface EvaluateOptions {
  /** The day to measure against, `YYYY-MM-DD`. */
  readonly today: string;
  /** Used for every entry that carries no `warn_days_before`. */
  readonly warnDaysDefault?: number;
}

/** The warning window used when neither the entry nor the call names one. */
export const DEFAULT_WARN_DAYS = 30;

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A registry that does not match the schema. The message names the entry. */
export class ExpiryRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpiryRegistryError";
  }
}

/**
 * Read one `YYYY-MM-DD` date as the UTC midnight of that day.
 *
 * The shape check alone accepts `2026-02-30`, so the parsed day is compared
 * back with the written one: a date that does not exist on the calendar is a
 * registry mistake, not a value to round into March.
 */
export function parseDay(text: string, where: string): number {
  const match = DATE.exec(text);
  if (match === null) {
    throw new ExpiryRegistryError(`${where}: "${text}" is not a date (expected YYYY-MM-DD)`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new ExpiryRegistryError(`${where}: "${text}" is not a day on the calendar (expected YYYY-MM-DD)`);
  }
  return ms;
}

/** The calendar day in one time zone, `YYYY-MM-DD`. */
export function dayInZone(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const pick = (type: "year" | "month" | "day"): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * Today in one zone, for a caller that named no day.
 *
 * The zone is the harness timezone (`timezone` in config.json) and the tool
 * passes it in. UTC is what this function falls back to, because UTC is the
 * harness default: a fallback to a fixed operator zone would put the day
 * boundary somewhere the config never asked for.
 */
export function todayInZone(now = Date.now(), timeZone = "UTC"): string {
  return dayInZone(now, timeZone);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(item: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = item[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ExpiryRegistryError(`${where}: "${key}" must be a string`);
  return value;
}

function warnDaysOf(item: Record<string, unknown>, where: string): number | undefined {
  const value = item["warn_days_before"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ExpiryRegistryError(`${where}: "warn_days_before" must be a whole number of days, 0 or more`);
  }
  return value;
}

function parseEntry(name: string, item: unknown, where: string): ExpiryEntry {
  if (!isRecord(item)) throw new ExpiryRegistryError(`${where}: an entry must be a JSON object`);
  const expiresOn = item["expires_on"];
  if (typeof expiresOn !== "string") {
    throw new ExpiryRegistryError(`${where}: "expires_on" is required and must be a string (YYYY-MM-DD)`);
  }
  parseDay(expiresOn, where);
  // Fields this schema does not know are left alone on purpose: the registry is
  // written by another job, and a field it adds for its own readers must not
  // stop the watch. A misspelled known field still fails, because the field it
  // meant is then missing.
  return {
    name,
    expiresOn,
    warnDaysBefore: warnDaysOf(item, where),
    note: optionalText(item, "note", where),
    renew: optionalText(item, "renew", where),
  };
}

/**
 * Read the registry document.
 *
 * Three shapes are accepted, because the file is written by hand or by another
 * job and the shape was never fixed:
 *   - an array of entries, each carrying `name`
 *   - `{ "entries": [ ... ] }`
 *   - an object keyed by entry name
 * Nothing else is guessed: an unknown shape fails with the file named.
 */
export function parseRegistry(raw: unknown, source: string): ExpiryEntry[] {
  const fromArray = (items: readonly unknown[], where: string): ExpiryEntry[] =>
    items.map((item, index) => {
      if (!isRecord(item)) throw new ExpiryRegistryError(`${where}: entry #${index + 1} must be a JSON object`);
      const name = item["name"];
      if (typeof name !== "string" || name.trim() === "") {
        throw new ExpiryRegistryError(`${where}: entry #${index + 1} needs a non-empty "name"`);
      }
      return parseEntry(name, item, `${where}: entry "${name}"`);
    });

  if (Array.isArray(raw)) return fromArray(raw, `registry ${source}`);

  if (!isRecord(raw)) {
    throw new ExpiryRegistryError(`registry ${source}: expected a JSON object or an array of entries`);
  }
  const nested = raw["entries"];
  if (Array.isArray(nested)) return fromArray(nested, `registry ${source}`);
  if (nested !== undefined) {
    throw new ExpiryRegistryError(`registry ${source}: "entries" must be an array`);
  }
  return Object.entries(raw).map(([name, item]) => parseEntry(name, item, `registry ${source}: entry "${name}"`));
}

/**
 * The entries whose warning window has been entered, soonest first.
 *
 * An entry is due when the days left are at most its warning window, so an
 * expired entry (a negative count) is always due and never falls out of view.
 */
export function evaluateExpiry(entries: readonly ExpiryEntry[], options: EvaluateOptions): DueEntry[] {
  const todayMs = parseDay(options.today, "today");
  const fallback = options.warnDaysDefault ?? DEFAULT_WARN_DAYS;
  if (!Number.isInteger(fallback) || fallback < 0) {
    throw new ExpiryRegistryError("warnDaysDefault must be a whole number of days, 0 or more");
  }

  const due: DueEntry[] = [];
  for (const entry of entries) {
    const daysLeft = Math.round((parseDay(entry.expiresOn, `entry "${entry.name}"`) - todayMs) / DAY_MS);
    const window = entry.warnDaysBefore ?? fallback;
    if (daysLeft > window) continue;
    due.push({
      name: entry.name,
      expires_on: entry.expiresOn,
      daysLeft,
      note: entry.note,
      renew: entry.renew,
    });
  }
  due.sort((left, right) => (left.daysLeft - right.daysLeft) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return due;
}
