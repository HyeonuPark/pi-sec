/**
 * Model call statistics: the computation over fixed rows, and `GET /api/usage/stats`.
 */
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCallsStore, type ModelCallInput } from "../src/agent/model-calls-store.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { MAX_REQUEST_SPEED, bucketIndex, computeCallStats, percentiles, slotEdges } from "../src/server/usage/call-stats.ts";
import type { UsageStatsAnswer } from "../src/shared/wire/usage-stats.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const TZ = "Asia/Tokyo";
/** 2026-11-06 16:30 +09:00. */
const NOW = Date.UTC(2026, 10, 6, 7, 30, 0);
/** 2026-11-06 14:00 +09:00, the start of an hour slot. */
const H14 = Date.UTC(2026, 10, 6, 5, 0, 0);
const HOUR = 3_600_000;

let dir: string | undefined;
let harness: TestHarness | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function call(over: Partial<ModelCallInput> & { startedAt: number }): ModelCallInput {
  return {
    provider: "p",
    model: "m",
    api: "x",
    stopReason: "stop",
    input: 10_000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 101,
    reasoning: null,
    headersMs: 100,
    ttftMs: 1000,
    durationMs: 11_000,
    lastContentMs: null,
    contentEvents: null,
    ...over,
  };
}

async function fixture(path: string, calls: ModelCallInput[]): Promise<void> {
  const store = await ModelCallsStore.open(path, () => NOW);
  for (const c of calls) store.insert(c);
  store.close();
}

async function tmpDb(calls: ModelCallInput[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "usage-stats-"));
  const path = join(dir, "model-calls.sqlite");
  await fixture(path, calls);
  return path;
}

const base = (path: string, over: object = {}) =>
  computeCallStats({ path, now: NOW, timezone: TZ, range: "24h", step: "hour", ...over });

describe("slots and buckets", () => {
  it("puts slot edges on whole hours and whole days of the zone", () => {
    const hours = slotEdges(NOW, "24h", "hour", TZ);
    expect(hours[0]).toBe(Date.UTC(2026, 10, 5, 7, 0, 0)); // 16:00 +09:00 the day before
    expect(hours[hours.length - 1]).toBe(Date.UTC(2026, 10, 6, 8, 0, 0)); // 17:00 +09:00
    expect(hours.length - 1).toBe(25);
    const days = slotEdges(NOW, "7d", "day", TZ);
    // Midnight +09:00 is 15:00 UTC.
    expect(days.every((e) => new Date(e).getUTCHours() === 15)).toBe(true);
    expect(days.length - 1).toBe(8);
  });

  it("assigns prompt length to the five buckets by input + cache read + cache write", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(63_999)).toBe(0);
    expect(bucketIndex(64_000)).toBe(1);
    expect(bucketIndex(127_999)).toBe(1);
    expect(bucketIndex(128_000)).toBe(2);
    expect(bucketIndex(511_999)).toBe(3);
    expect(bucketIndex(512_000)).toBe(4);
    expect(bucketIndex(5_000_000)).toBe(4);
  });

  it("gives p50 and p90 by nearest rank, and null under three values", () => {
    expect(percentiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ p50: 5, p90: 9, count: 10 });
    expect(percentiles([1, 2])).toEqual({ p50: null, p90: null, count: 2 });
    expect(percentiles([])).toEqual({ p50: null, p90: null, count: 0 });
    expect(percentiles([1, 2, 3])).toEqual({ p50: 2, p90: 3, count: 3 });
  });
});

describe("computeCallStats", () => {
  it("computes TTFT, TPOT and request speed per slot, with the exclusion rules", async () => {
    const t = H14 + 60_000;
    const calls: ModelCallInput[] = [
      // Three good calls in bucket 0: ttft 1000/2000/3000, after-first-token 10000 ms for 101 output.
      call({ startedAt: t, ttftMs: 1000, durationMs: 11_000, output: 101 }),
      call({ startedAt: t + 1, ttftMs: 2000, durationMs: 12_000, output: 101 }),
      call({ startedAt: t + 2, ttftMs: 3000, durationMs: 23_000, output: 101 }),
      // Excluded from everything but the count: failed.
      call({ startedAt: t + 3, stopReason: "error", ttftMs: 5000, durationMs: 9000 }),
      call({ startedAt: t + 4, stopReason: "aborted" }),
      // Output 0 and 1: TTFT only.
      call({ startedAt: t + 5, output: 0, ttftMs: 4000, durationMs: 5000 }),
      call({ startedAt: t + 6, output: 1, ttftMs: 4000, durationMs: 5000 }),
      // No first token: nothing.
      call({ startedAt: t + 7, ttftMs: null }),
      // duration <= ttft: TTFT only.
      call({ startedAt: t + 8, ttftMs: 6000, durationMs: 6000 }),
      call({ startedAt: t + 9, ttftMs: 7000, durationMs: 6000 }),
      // `length` counts as success; other bucket (128k).
      call({ startedAt: t + 10, stopReason: "length", input: 100_000, cacheRead: 30_000, ttftMs: 100, durationMs: 1100, output: 11 }),
      // Another hour slot, other provider: not in this answer.
      call({ startedAt: t + 11, provider: "other" }),
    ];
    const answer = base(await tmpDb(calls));
    expect(answer.provider).toBe("p");
    expect(answer.model).toBe("m");
    expect(answer.providers.map((p) => [p.provider, p.calls])).toEqual([["p", 11], ["other", 1]]);
    const slot = answer.slots.find((s) => s.from === H14)!;
    expect(slot.to).toBe(H14 + HOUR);
    expect(slot.calls).toBe(11);
    expect(slot.failed).toBe(2);
    // Request speed per call: 100 / 10 s = 10; 100 / 10 s = 10; 100 / 20 s = 5; the 128k call: 10 / 1 s = 10.
    expect(slot.speed).toEqual({ p50: 10, p90: 10, count: 4 });
    // Bucket 0 TTFT: 1000, 2000, 3000, 4000, 4000, 6000, 7000 (output 0/1 and duration<=ttft count, no-ttft and failed do not).
    expect(slot.buckets[0]!.ttftMs).toEqual({ p50: 4000, p90: 7000, count: 7 });
    // Bucket 0 TPOT: 10000/100, 10000/100, 20000/100 = 100, 100, 200.
    expect(slot.buckets[0]!.tpotMs).toEqual({ p50: 100, p90: 200, count: 3 });
    // Bucket 2 has one call: no percentile.
    expect(slot.buckets[2]!.ttftMs).toEqual({ p50: null, p90: null, count: 1 });
    expect(slot.buckets[2]!.tpotMs).toEqual({ p50: null, p90: null, count: 1 });
    // The slot before holds nothing.
    expect(answer.slots[0]!.calls).toBe(0);
  });

  it("leaves a call above the speed limit out of speed and TPOT, keeps it in TTFT and calls, and counts it", async () => {
    expect(MAX_REQUEST_SPEED).toBe(1000);
    const t = H14 + 60_000;
    const calls: ModelCallInput[] = [
      // 100 tokens after the first token in 10 s: speed 10.
      call({ startedAt: t, ttftMs: 1000, durationMs: 11_000, output: 101 }),
      call({ startedAt: t + 1, ttftMs: 1100, durationMs: 11_100, output: 101 }),
      call({ startedAt: t + 2, ttftMs: 1200, durationMs: 11_200, output: 101 }),
      // Exactly 1000 tokens per second: 100 tokens in 100 ms. Kept.
      call({ startedAt: t + 3, ttftMs: 2000, durationMs: 2100, output: 101 }),
      // Above the limit: 100 tokens in 99 ms, and 100 tokens in 5 ms. Left out.
      call({ startedAt: t + 4, ttftMs: 3000, durationMs: 3099, output: 101 }),
      call({ startedAt: t + 5, ttftMs: 4000, durationMs: 4005, output: 101 }),
    ];
    const slot = base(await tmpDb(calls)).slots.find((s) => s.from === H14)!;
    expect(slot.calls).toBe(6);
    expect(slot.bursts).toBe(2);
    expect(slot.speed).toEqual({ p50: 10, p90: 1000, count: 4 });
    expect(slot.buckets[0]!.ttftMs.count).toBe(6);
    // TPOT: 100, 100, 100 and 1 ms per token; the two bursts are not in it.
    expect(slot.buckets[0]!.tpotMs).toEqual({ p50: 100, p90: 100, count: 4 });
    expect(base(await tmpDb(calls)).slots[0]!.bursts).toBe(0);
  });

  it("request speed is a percentile of per-call values, not the inverse of the TPOT percentile", async () => {
    const t = H14;
    // TPOT 100, 100, 400 ms -> speeds 10, 10, 2.5. p90 of speed = 10, inverse of p90 TPOT = 2.5.
    const answer = base(
      await tmpDb([
        call({ startedAt: t, ttftMs: 0, durationMs: 10_000, output: 101 }),
        call({ startedAt: t + 1, ttftMs: 0, durationMs: 10_000, output: 101 }),
        call({ startedAt: t + 2, ttftMs: 0, durationMs: 40_000, output: 101 }),
      ]),
    );
    const slot = answer.slots.find((s) => s.from === H14)!;
    expect(slot.speed.p90).toBe(10);
    expect(slot.buckets[0]!.tpotMs.p90).toBe(400);
  });

  it("picks the busiest provider and model when none is named, and honors a named one", async () => {
    const t = H14;
    const path = await tmpDb([
      call({ startedAt: t }),
      call({ startedAt: t + 1, provider: "q", model: "a" }),
      call({ startedAt: t + 2, provider: "q", model: "b" }),
      call({ startedAt: t + 3, provider: "q", model: "b" }),
    ]);
    const auto = base(path);
    expect([auto.provider, auto.model]).toEqual(["q", "b"]);
    const named = base(path, { provider: "q", model: "a" });
    expect(named.slots.reduce((s, x) => s + x.calls, 0)).toBe(1);
  });

  it("answers empty when the file does not exist, and does not create it", async () => {
    dir = await mkdtemp(join(tmpdir(), "usage-stats-"));
    const path = join(dir, "none.sqlite");
    const answer = base(path);
    expect(answer.provider).toBeNull();
    expect(answer.providers).toEqual([]);
    expect(answer.slots.length).toBe(25);
    expect(existsSync(path)).toBe(false);
  });
});

async function boot(path?: string, basePath?: string): Promise<{ origin: string; paths: TestHarness["paths"] }> {
  harness = await createTestHarness({
    config: { timezone: TZ, server: { ...defaultConfig().server, port: 0, ...(basePath === undefined ? {} : { basePath }) } },
  });
  const runtime = harness.runtime;
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  if (path !== undefined) await fixture(harness.paths.modelCallsDb, []);
  started = await startServer(deps, {
    webDir: defaultWebDir(),
    usage: { prefetch: false },
    usageStats: { now: () => NOW },
  });
  return { origin: started.origin, paths: harness.paths };
}

describe("GET /api/usage/stats", () => {
  it("answers 400 range_too_large and bad_query, and writes nothing to the database", async () => {
    const { origin, paths } = await boot("db");
    const t = H14 + 1000;
    const store = await ModelCallsStore.open(paths.modelCallsDb, () => NOW);
    store.insert(call({ startedAt: t }));
    store.insert(call({ startedAt: t + 1, stopReason: "error" }));
    store.close();
    const before = { bytes: await readFile(paths.modelCallsDb), mtime: (await stat(paths.modelCallsDb)).mtimeMs };

    const big = await fetch(`${origin}/api/usage/stats?range=90d&step=hour`);
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("range_too_large");
    for (const q of ["range=1y", "step=week", "range=7d&step=minute"]) {
      const bad = await fetch(`${origin}/api/usage/stats?${q}`);
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_query");
    }

    const ok = await fetch(`${origin}/api/usage/stats?range=24h`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as UsageStatsAnswer;
    expect(body.range).toBe("24h");
    expect(body.step).toBe("hour");
    expect(body.timezone).toBe(TZ);
    expect(body.slots.find((s) => s.from === H14)).toMatchObject({ calls: 2, failed: 1 });
    // Defaults: 7d hourly (169 slots), and 30d daily.
    const week = (await (await fetch(`${origin}/api/usage/stats`)).json()) as UsageStatsAnswer;
    expect([week.range, week.step, week.slots.length]).toEqual(["7d", "hour", 169]);
    const month = (await (await fetch(`${origin}/api/usage/stats?range=90d`)).json()) as UsageStatsAnswer;
    expect(month.step).toBe("day");

    const after = { bytes: await readFile(paths.modelCallsDb), mtime: (await stat(paths.modelCallsDb)).mtimeMs };
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtime).toBe(before.mtime);
  });

  it("answers empty and creates no file when nothing was recorded yet", async () => {
    const { origin, paths } = await boot();
    // The test harness may have opened the store already: remove it, so the route meets no file.
    await rm(paths.modelCallsDb, { force: true });
    const res = await fetch(`${origin}/api/usage/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageStatsAnswer;
    expect(body.provider).toBeNull();
    expect(body.slots.every((s) => s.calls === 0)).toBe(true);
    expect(existsSync(paths.modelCallsDb)).toBe(false);
  });
});

describe("GET /usage/stats", () => {
  it("serves the page with the mount prefix and the security headers, and /usage links to it", async () => {
    const { origin } = await boot(undefined, "/sec");
    const res = await fetch(`${origin}/sec/usage/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src");
    const page = await res.text();
    expect(page).toContain('<meta name="pi-sec-base" content="/sec" />');
    expect(page).toContain('<meta name="pi-sec-timezone" content="Asia/Tokyo" />');
    expect(page).toContain('src="/sec/ui-usage-stats.js"');
    expect(page).toContain('href="/sec/usage-stats.css"');

    const usage = await (await fetch(`${origin}/sec/usage`)).text();
    expect(usage).toContain('href="/sec/usage/stats"');
  });

  it("serves the page at the root without a prefix", async () => {
    const { origin } = await boot();
    const page = await (await fetch(`${origin}/usage/stats`)).text();
    expect(page).toContain('src="/ui-usage-stats.js"');
    expect(page).toContain('id="stats-root"');
  });
});
