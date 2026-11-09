/**
 * Statistics over the rows of `state/model-calls.sqlite`.
 *
 * The file is opened read-only and never written, and it is not created: a
 * daemon that has not recorded a call yet leaves no file, and that reads as no
 * rows. Time slots start on whole hours or whole days of the harness time zone.
 * A percentile is the nearest-rank value of the sorted values and needs three
 * values or more.
 *
 * Rules:
 * - A failed call (`error`, `aborted`) is in `calls` and `failed` and in no value.
 * - TTFT needs `ttft_ms`.
 * - TPOT = (duration - ttft) / (output - 1) ms, and request speed =
 *   (output - 1) / ((duration - ttft) / 1000) tokens per second. Both need
 *   `ttft_ms`, output of 2 or more, and duration greater than ttft.
 * - A call whose request speed is above `MAX_REQUEST_SPEED` arrived all at once. It
 *   stays in `calls` and in TTFT, is left out of speed and TPOT, and is counted in
 *   `bursts` of its slot. The rule is the same for old and new rows.
 * - Prompt length = input + cache read + cache write. 1k is 1000 tokens.
 * - A row whose provider the caller's `isVirtual` selector marks is dropped before
 *   anything is aggregated: an extension's virtual provider answers no call itself,
 *   and the call is recorded under the provider that answered. A selector that
 *   throws is read as "not virtual" and hides no row, the rule the usage service
 *   holds (`#hidden` in `service.ts`): a list that is too long is a smaller fault
 *   than one that silently drops a provider.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MODEL_CALLS_TABLE } from "../../agent/model-calls-store.ts";
import type {
  UsageStatsAnswer,
  UsageStatsBucket,
  UsageStatsPercentiles,
  UsageStatsProvider,
  UsageStatsRange,
  UsageStatsSlot,
  UsageStatsStep,
} from "../../shared/wire/usage-stats.ts";

export const MAX_SLOTS = 744;
export const MIN_PERCENTILE_COUNT = 3;
/** Tokens per second. A call above this value is left out of speed and TPOT. */
export const MAX_REQUEST_SPEED = 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_MS: Readonly<Record<UsageStatsRange, number>> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};

export const PROMPT_BUCKETS: readonly UsageStatsBucket[] = [
  { key: "lt64k", label: "<64k", from: 0, to: 64_000 },
  { key: "64k-128k", label: "64k-128k", from: 64_000, to: 128_000 },
  { key: "128k-256k", label: "128k-256k", from: 128_000, to: 256_000 },
  { key: "256k-512k", label: "256k-512k", from: 256_000, to: 512_000 },
  { key: "gte512k", label: "≥512k", from: 512_000, to: null },
];

/** The slot length a range has when the query names none. */
export function defaultStep(range: UsageStatsRange): UsageStatsStep {
  return RANGE_MS[range] <= RANGE_MS["7d"] ? "hour" : "day";
}

/** The bucket index of a prompt length. */
export function bucketIndex(promptTokens: number): number {
  for (let i = 0; i < PROMPT_BUCKETS.length; i += 1) {
    const to = PROMPT_BUCKETS[i]!.to;
    if (to === null || promptTokens < to) return i;
  }
  return PROMPT_BUCKETS.length - 1;
}

/** Nearest-rank percentile of a sorted list. `p` is between 0 and 1. */
function rank(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function percentiles(values: readonly number[]): UsageStatsPercentiles {
  if (values.length < MIN_PERCENTILE_COUNT) return { p50: null, p90: null, count: values.length };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: rank(sorted, 0.5), p90: rank(sorted, 0.9), count: values.length };
}

/** The offset of a zone from UTC at one moment, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return local - Math.floor(at / 1000) * 1000;
}

/** The start of the hour or day that holds `at`, in the zone. */
export function slotStart(at: number, step: UsageStatsStep, timeZone: string): number {
  const unit = step === "hour" ? HOUR_MS : DAY_MS;
  const offset = zoneOffset(at, timeZone);
  let start = Math.floor((at + offset) / unit) * unit - offset;
  // A start that falls across a change of offset (daylight saving) is moved to the offset it lies in.
  const shifted = zoneOffset(start, timeZone);
  if (shifted !== offset) start = Math.floor((at + shifted) / unit) * unit - shifted;
  return start;
}

function nextSlotStart(start: number, step: UsageStatsStep, timeZone: string): number {
  return slotStart(start + (step === "hour" ? 90 * 60_000 : 30 * HOUR_MS), step, timeZone);
}

/** The slot edges that cover `[now - range, now]`: n+1 edges for n slots. */
export function slotEdges(now: number, range: UsageStatsRange, step: UsageStatsStep, timeZone: string): number[] {
  const edges = [slotStart(now - RANGE_MS[range], step, timeZone)];
  while (edges[edges.length - 1]! <= now) {
    edges.push(nextSlotStart(edges[edges.length - 1]!, step, timeZone));
    if (edges.length > MAX_SLOTS + 2) break; // the caller refuses such a count
  }
  return edges;
}

interface Row {
  readonly started_at: number;
  readonly provider: string;
  readonly model: string;
  readonly stop_reason: string;
  readonly input: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly output: number;
  readonly ttft_ms: number | null;
  readonly duration_ms: number;
}

/** Read every row at or after `since`, or none when the file is not there. */
function readRows(path: string, since: number): Row[] {
  if (!existsSync(path)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return [];
  }
  try {
    return db
      .prepare(
        `SELECT started_at, provider, model, stop_reason, input, cache_read, cache_write, output, ttft_ms, duration_ms
         FROM ${MODEL_CALLS_TABLE} WHERE started_at >= ?`,
      )
      .all(since) as unknown as Row[];
  } catch {
    // The file exists but holds no table yet.
    return [];
  } finally {
    db.close();
  }
}

const FAILED = new Set(["error", "aborted"]);

export interface CallStatsInput {
  readonly path: string;
  readonly now: number;
  readonly timezone: string;
  readonly range: UsageStatsRange;
  readonly step: UsageStatsStep;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** Marks a provider a caller leaves out of the statistics; see the header rules. */
  readonly isVirtual?: ((providerId: string) => boolean) | undefined;
}

/**
 * Whether a provider is virtual, by the caller's selector.
 *
 * A selector that throws is read as "not virtual" and hides nothing, so a broken
 * registry leaves a list that is too long rather than one that drops a provider.
 */
export function virtualOf(isVirtual: ((providerId: string) => boolean) | undefined, providerId: string): boolean {
  if (isVirtual === undefined) return false;
  try {
    return isVirtual(providerId) === true;
  } catch {
    return false;
  }
}

function top<T extends { calls: number }>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) if (best === undefined || item.calls > best.calls) best = item;
  return best;
}

export function computeCallStats(input: CallStatsInput): UsageStatsAnswer {
  const { now, timezone, range, step } = input;
  const edges = slotEdges(now, range, step, timezone);
  const rows = readRows(input.path, edges[0]!).filter((r) => r.started_at <= now && !virtualOf(input.isVirtual, r.provider));

  const byProvider = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const models = byProvider.get(r.provider) ?? new Map<string, number>();
    models.set(r.model, (models.get(r.model) ?? 0) + 1);
    byProvider.set(r.provider, models);
  }
  const providers: UsageStatsProvider[] = [...byProvider]
    .map(([provider, models]) => {
      const list = [...models].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
      return { provider, calls: list.reduce((s, m) => s + m.calls, 0), models: list };
    })
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));

  const provider = input.provider ?? top(providers)?.provider ?? null;
  const model =
    input.model ?? (provider === null ? null : top(providers.find((p) => p.provider === provider)?.models ?? [])?.model ?? null);

  const slotCount = edges.length - 1;
  const calls = new Array<number>(slotCount).fill(0);
  const failed = new Array<number>(slotCount).fill(0);
  const bursts = new Array<number>(slotCount).fill(0);
  const speeds: number[][] = Array.from({ length: slotCount }, () => []);
  const ttfts: number[][][] = Array.from({ length: slotCount }, () => PROMPT_BUCKETS.map(() => []));
  const tpots: number[][][] = Array.from({ length: slotCount }, () => PROMPT_BUCKETS.map(() => []));

  let slot = 0;
  for (const r of rows.filter((x) => x.provider === provider && x.model === model).sort((a, b) => a.started_at - b.started_at)) {
    while (slot < slotCount - 1 && r.started_at >= edges[slot + 1]!) slot += 1;
    calls[slot]! += 1;
    if (FAILED.has(r.stop_reason)) {
      failed[slot]! += 1;
      continue;
    }
    if (r.ttft_ms === null) continue;
    const b = bucketIndex(r.input + r.cache_read + r.cache_write);
    ttfts[slot]![b]!.push(r.ttft_ms);
    const after = r.duration_ms - r.ttft_ms;
    if (r.output >= 2 && after > 0) {
      const speed = (r.output - 1) / (after / 1000);
      if (speed > MAX_REQUEST_SPEED) {
        bursts[slot]! += 1;
      } else {
        tpots[slot]![b]!.push(after / (r.output - 1));
        speeds[slot]!.push(speed);
      }
    }
  }

  const slots: UsageStatsSlot[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    slots.push({
      from: edges[i]!,
      to: edges[i + 1]!,
      calls: calls[i]!,
      failed: failed[i]!,
      bursts: bursts[i]!,
      speed: percentiles(speeds[i]!),
      buckets: PROMPT_BUCKETS.map((_, b) => ({ ttftMs: percentiles(ttfts[i]![b]!), tpotMs: percentiles(tpots[i]![b]!) })),
    });
  }

  return { generatedAt: now, timezone, provider, model, range, step, providers, buckets: PROMPT_BUCKETS, slots };
}
