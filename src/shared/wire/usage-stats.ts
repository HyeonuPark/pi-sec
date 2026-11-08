/**
 * What `GET /api/usage/stats` answers, as the stats page reads it.
 *
 * Every percentile is `null` when fewer than three calls make it, so a graph
 * shows a gap there. No code and no import of `src/server` lives here.
 */

/** The ranges the route accepts. */
export const USAGE_STATS_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageStatsRange = (typeof USAGE_STATS_RANGES)[number];

/** The slot lengths the route accepts. */
export const USAGE_STATS_STEPS = ["hour", "day"] as const;
export type UsageStatsStep = (typeof USAGE_STATS_STEPS)[number];

/** The error codes of HTTP 400 from this route. */
export type UsageStatsErrorCode = "bad_query" | "range_too_large";

/** One prompt length bucket. The upper limit is `null` for the open end. */
export interface UsageStatsBucket {
  readonly key: string;
  readonly label: string;
  /** Inclusive lower limit, in prompt tokens. */
  readonly from: number;
  /** Exclusive upper limit, in prompt tokens. */
  readonly to: number | null;
}

/** The median and the 90th percentile of the calls that made a value, and how many they were. */
export interface UsageStatsPercentiles {
  readonly p50: number | null;
  readonly p90: number | null;
  readonly count: number;
}

/** Time to first token and time per output token of one bucket in one slot. */
export interface UsageStatsBucketSlot {
  /** Milliseconds. */
  readonly ttftMs: UsageStatsPercentiles;
  /** Milliseconds per token. */
  readonly tpotMs: UsageStatsPercentiles;
}

export interface UsageStatsSlot {
  /** Start of the slot, epoch milliseconds. */
  readonly from: number;
  /** End of the slot, epoch milliseconds (the start of the next slot). */
  readonly to: number;
  /** Every call that started in the slot, failed ones included. */
  readonly calls: number;
  /** Calls whose stop reason is `error` or `aborted`. */
  readonly failed: number;
  /** Successful calls left out of `speed` and TPOT because their speed is above 1000 tokens per second. */
  readonly bursts: number;
  /** Tokens per second after the first token. One value for all prompt lengths. */
  readonly speed: UsageStatsPercentiles;
  /** One entry per bucket, in the order of `buckets`. */
  readonly buckets: readonly UsageStatsBucketSlot[];
}

export interface UsageStatsModel {
  readonly model: string;
  readonly calls: number;
}

export interface UsageStatsProvider {
  readonly provider: string;
  readonly calls: number;
  readonly models: readonly UsageStatsModel[];
}

export interface UsageStatsAnswer {
  /** Epoch milliseconds. */
  readonly generatedAt: number;
  readonly timezone: string;
  /** `null` when the range holds no call. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly range: UsageStatsRange;
  readonly step: UsageStatsStep;
  readonly providers: readonly UsageStatsProvider[];
  readonly buckets: readonly UsageStatsBucket[];
  readonly slots: readonly UsageStatsSlot[];
}
