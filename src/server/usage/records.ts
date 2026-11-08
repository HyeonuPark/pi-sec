/**
 * What pi-sec's own model calls cost, per provider and per window.
 *
 * Every model call pi-sec makes is one row in `entries` whose record has
 * `kind: "pi.assistant"`, and the record carries the provider, the model, the
 * call's time, its token count and the cost the catalog's prices give it. This
 * module turns those rows into the three rolling windows a provider card shows:
 * the last 24 hours, the last 7 days and the last 30 days, each ending at the
 * moment of the request. The same minute buckets also give the thirty daily slots
 * of the last thirty days, one slot per day.
 *
 * Three rules hold here.
 *
 * - **The database is opened read-only and never written.** The daemon runs one
 *   SQLite file, and this is a reader of it; a second connection that could write
 *   would be a second owner.
 * - **The first scan is the last full scan.** Sums are kept in memory as one
 *   bucket per provider per minute, and later calls read only the rows whose
 *   `id` is larger than the largest one read before. `id` is the table's
 *   `INTEGER PRIMARY KEY`, a rowid alias that pi-durable fills from one counter
 *   that only grows (`nextId` in its SQLite storage), and nothing in that storage
 *   deletes an entry, so "rows after the last id" is every row added since.
 * - **DeepSeek's cost is the price at the time of the call.** The catalog's price
 *   for a DeepSeek model is the peak price, and the off-peak price is half of it.
 *   Peak is Monday to Friday in UTC, 01:00-04:00 and 06:00-10:00; a call outside
 *   it costs half the recorded amount. Chinese holidays are not considered.
 *
 * A bucket is kept for one minute, so a window's start is the start of the minute
 * the window began in. Nothing older than 30 days stays in memory.
 */
import { DatabaseSync } from "node:sqlite";

/** The three windows a prepaid card shows, longest last. */
export const USAGE_WINDOWS = ["day", "week", "month"] as const;

export type UsageWindowName = (typeof USAGE_WINDOWS)[number];

/** How long each window lasts, in milliseconds. */
export const USAGE_WINDOW_MS: Readonly<Record<UsageWindowName, number>> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const MINUTE_MS = 60 * 1000;

/** One window's sums. */
export interface UsageTotals {
  readonly calls: number;
  readonly tokens: number;
  readonly cost: number;
}

/** One provider's three windows, as a card shows them. */
export type UsageWindows = Readonly<Record<UsageWindowName, UsageTotals>>;

/** A provider with no call in a window still has that window, at zero. */
export const EMPTY_TOTALS: UsageTotals = { calls: 0, tokens: 0, cost: 0 };

/** How many daily slots a prepaid card shows. */
export const DAILY_SLOT_COUNT = 30;

const MINUTES_PER_DAY = 24 * 60;

/** One of the daily slots: its boundaries, and the sums of the calls inside them. */
export interface UsageSlotSums extends UsageTotals {
  /** The start of the slot, epoch milliseconds, on a whole minute. */
  readonly from: number;
  /** The end of the slot, epoch milliseconds. The newest slot ends at the moment of the read. */
  readonly to: number;
}

/** One provider's ledger as a card shows it: the three windows and the daily slots. */
export interface UsageLedger {
  readonly windows: UsageWindows;
  /** The last thirty days, one day per slot, oldest first. */
  readonly daily: readonly UsageSlotSums[];
}

/**
 * The boundaries of the daily slots, oldest first.
 *
 * A slot holds the same minute buckets the windows count, and its edges sit on
 * the minute grid: slot `j`, counted from the newest at 0, holds the minutes from
 * `m - (j+1)*1440` to `m - j*1440`, where `m` is the minute of `now`. A minute at
 * that start is inside and the minute before it is not. The newest slot has no
 * minute edge above it: it ends at `now` itself, the same way the day window
 * does, so a call in the current minute is in it.
 */
export function dailySlotRanges(now: number): { readonly from: number; readonly to: number }[] {
  const m = Math.floor(now / MINUTE_MS);
  const ranges: { from: number; to: number }[] = [];
  for (let j = DAILY_SLOT_COUNT - 1; j >= 0; j -= 1) {
    ranges.push({
      from: (m - (j + 1) * MINUTES_PER_DAY) * MINUTE_MS,
      to: j === 0 ? now : (m - j * MINUTES_PER_DAY) * MINUTE_MS,
    });
  }
  return ranges;
}

/** The ledger of a provider with no recorded call: every window and every slot at zero. */
export function emptyLedger(now: number): UsageLedger {
  return {
    windows: { day: EMPTY_TOTALS, week: EMPTY_TOTALS, month: EMPTY_TOTALS },
    daily: dailySlotRanges(now).map((range) => ({ from: range.from, to: range.to, ...EMPTY_TOTALS })),
  };
}

/** The provider whose recorded cost is restated at the price of the call's hour. */
export const PEAK_PRICED_PROVIDER = "deepseek";

/** How much of the recorded price an off-peak DeepSeek call actually cost. */
export const OFF_PEAK_FACTOR = 0.5;

/**
 * Whether a moment is inside DeepSeek's peak window: Monday to Friday in UTC,
 * 01:00-04:00 or 06:00-10:00. The start of a range is inside it and the end is
 * not. A timestamp that is not a whole number of milliseconds is not a moment,
 * and answers false.
 */
export function isDeepSeekPeak(timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const at = new Date(timestamp);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** One minute of one provider's calls. */
interface Bucket {
  calls: number;
  tokens: number;
  cost: number;
}

/** One row the ledger query returns. */
interface LedgerRow {
  provider: unknown;
  at: unknown;
  tokens: unknown;
  cost: unknown;
}

export interface UsageRecordsOptions {
  /** `paths.stateDb`: the daemon's SQLite file, read and never written. */
  readonly path: string;
  /**
   * Rows per range of the catch-up read. The read is synchronous inside SQLite,
   * so a whole ledger in one statement would hold the event loop for the length
   * of the scan. A range of this many ids gives the loop a turn between ranges.
   */
  readonly chunkSize?: number;
}

/** The rows this module reads, in one shape. */
function ledgerQuery(): string {
  return (
    "select json_extract(record,'$.model[0].provider') as provider," +
    " json_extract(record,'$.model[0].timestamp') as at," +
    " json_extract(record,'$.model[0].usage.totalTokens') as tokens," +
    " json_extract(record,'$.model[0].usage.cost.total') as cost" +
    " from entries" +
    " where id > ? and id <= ? and json_extract(record,'$.kind') = 'pi.assistant'"
  );
}

/** Give the event loop one turn, so a long catch-up does not stop the daemon. */
async function yieldToLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The in-memory sums over `state/sec.sqlite`, and the catch-up that keeps them
 * current.
 *
 * One instance belongs to one page route: it opens the database on first use,
 * keeps the sums for as long as the process lives, and hands out a snapshot per
 * request. Nothing here writes, and a database that cannot be read throws from
 * `totals()`, which the caller turns into a reason on the card.
 */
export class UsageRecords {
  readonly #path: string;
  readonly #chunkSize: number;
  #db: DatabaseSync | undefined;
  /** Provider id to minute to sums. The only copy of the ledger this process keeps. */
  readonly #buckets = new Map<string, Map<number, Bucket>>();
  /** The largest `entries.id` read so far. Every later read starts after it. */
  #lastId = 0;
  /**
   * The catch-up runs one at a time: two page loads at once must not both read
   * the same tail, or the second would add every row twice.
   */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: UsageRecordsOptions) {
    this.#path = options.path;
    this.#chunkSize = options.chunkSize ?? 20_000;
  }

  /**
   * The ledger of every provider, read as of `now`.
   *
   * The first call reads the whole ledger in ranges; every later call reads only
   * what arrived since. A caller never shares a bucket map or a totals object
   * with this instance, so it can hold the answer while the next call runs.
   */
  async totals(now: number): Promise<Map<string, UsageLedger>> {
    const run = this.#queue.then(() => this.#catchUp());
    // The queue keeps its turn after a failure, so one unreadable database does
    // not leave every later request waiting on a rejected promise.
    this.#queue = run.catch(() => undefined);
    await run;
    this.#prune(now);
    return this.#snapshot(now);
  }

  /** Close the read-only connection. A test calls it; the daemon lets the process end. */
  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  #open(): DatabaseSync {
    if (this.#db !== undefined) return this.#db;
    try {
      this.#db = new DatabaseSync(this.#path, { readOnly: true });
    } catch (error) {
      throw new Error(`usage ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.#db;
  }

  async #catchUp(): Promise<void> {
    const db = this.#open();
    const highest = db.prepare("select max(id) as value from entries").get() as { value: number | null } | undefined;
    const maxId = typeof highest?.value === "number" ? highest.value : 0;
    if (maxId <= this.#lastId) return;
    const statement = db.prepare(ledgerQuery());
    while (this.#lastId < maxId) {
      const from = this.#lastId;
      const to = Math.min(from + this.#chunkSize, maxId);
      const rows = statement.all(from, to) as unknown as LedgerRow[];
      for (const row of rows) this.#add(row);
      this.#lastId = to;
      if (to < maxId) await yieldToLoop();
    }
  }

  #add(row: LedgerRow): void {
    const provider = typeof row.provider === "string" ? row.provider : undefined;
    const at = typeof row.at === "number" ? row.at : Number(row.at);
    const tokens = typeof row.tokens === "number" ? row.tokens : Number(row.tokens);
    const cost = typeof row.cost === "number" ? row.cost : Number(row.cost);
    // A record whose shape this build does not know costs nothing and is not a
    // reason to stop reading: the rest of the ledger still counts.
    if (provider === undefined || provider === "") return;
    if (!Number.isFinite(at) || !Number.isFinite(tokens) || !Number.isFinite(cost)) return;
    const minute = Math.floor(at / MINUTE_MS);
    let minutes = this.#buckets.get(provider);
    if (minutes === undefined) {
      minutes = new Map();
      this.#buckets.set(provider, minutes);
    }
    const bucket = minutes.get(minute);
    const priced = provider === PEAK_PRICED_PROVIDER && !isDeepSeekPeak(at) ? cost * OFF_PEAK_FACTOR : cost;
    if (bucket === undefined) minutes.set(minute, { calls: 1, tokens, cost: priced });
    else {
      bucket.calls += 1;
      bucket.tokens += tokens;
      bucket.cost += priced;
    }
  }

  /** Drop the buckets no window can reach, so memory follows the ledger's last 30 days. */
  #prune(now: number): void {
    const first = Math.floor((now - USAGE_WINDOW_MS.month) / MINUTE_MS);
    for (const [provider, minutes] of this.#buckets) {
      for (const minute of minutes.keys()) if (minute < first) minutes.delete(minute);
      if (minutes.size === 0) this.#buckets.delete(provider);
    }
  }

  #snapshot(now: number): Map<string, UsageLedger> {
    // A window starts at the start of the minute it began in, so a bucket at that
    // minute counts and the bucket before it does not.
    const first = {
      day: Math.floor((now - USAGE_WINDOW_MS.day) / MINUTE_MS),
      week: Math.floor((now - USAGE_WINDOW_MS.week) / MINUTE_MS),
      month: Math.floor((now - USAGE_WINDOW_MS.month) / MINUTE_MS),
    };
    const m = Math.floor(now / MINUTE_MS);
    const ranges = dailySlotRanges(now);
    const out = new Map<string, UsageLedger>();
    for (const [provider, minutes] of this.#buckets) {
      const sums: Record<UsageWindowName, { calls: number; tokens: number; cost: number }> = {
        day: { calls: 0, tokens: 0, cost: 0 },
        week: { calls: 0, tokens: 0, cost: 0 },
        month: { calls: 0, tokens: 0, cost: 0 },
      };
      const daily: { from: number; to: number; calls: number; tokens: number; cost: number }[] = ranges.map(
        (range) => ({ from: range.from, to: range.to, calls: 0, tokens: 0, cost: 0 }),
      );
      for (const [minute, bucket] of minutes) {
        for (const window of USAGE_WINDOWS) {
          if (minute < first[window]) continue;
          const sum = sums[window];
          sum.calls += bucket.calls;
          sum.tokens += bucket.tokens;
          sum.cost += bucket.cost;
        }
        // The oldest slot starts where the month window starts, so every bucket
        // the month window keeps is in exactly one slot.
        if (minute < first.month) continue;
        const slot = daily[DAILY_SLOT_COUNT - 1 - this.#slotsFromNewest(minute, m)];
        if (slot === undefined) continue;
        slot.calls += bucket.calls;
        slot.tokens += bucket.tokens;
        slot.cost += bucket.cost;
      }
      out.set(provider, {
        windows: {
          day: { ...sums.day },
          week: { ...sums.week },
          month: { ...sums.month },
        },
        daily,
      });
    }
    return out;
  }

  /**
   * How many slots back from the newest a bucket minute sits.
   *
   * The minute `m` itself is 0, a minute at the newest slot's own start is 0 as
   * well, and the minute before that start is 1. A timestamp later than `now`
   * cannot be in a past slot, so it counts as 0.
   */
  #slotsFromNewest(minute: number, m: number): number {
    const back = m - minute;
    return back <= 0 ? 0 : Math.floor((back - 1) / MINUTES_PER_DAY);
  }
}
