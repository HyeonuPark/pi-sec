/**
 * The usage ledger and the cards read from it, and the judgement models that
 * are called outside a conversation.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JudgeUsage } from "../src/server/usage/judges.ts";
import { USAGE_WINDOW_MS, dailySlotRanges, isDeepSeekPeak, UsageRecords, DAILY_SLOT_COUNT, type UsageLedger, type UsageSlotSums, type UsageTotals, type UsageWindows, emptyLedger } from "../src/server/usage/records.ts";
import { DatabaseSync } from "node:sqlite";
import { ANTHROPIC_USAGE_URL, SYNTHETIC_QUOTAS_URL } from "../src/server/usage/fetchers.ts";
import { createUsageService, type UsageModels } from "../src/server/usage/service.ts";
import type { UsageAnswer, UsageCard, UsageSlot } from "../src/server/usage/values.ts";
import { fileURLToPath } from "node:url";
import { createModels, createProvider, type AnyModel, type Api, type ClassifierApi, type ClassifierContext, type ClassifierModel, type ClassifierQuestion, type Model } from "@earendil-works/pi-ai";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { DEFAULT_JUDGE_TIMEOUT_MS, Judges, type JudgeRequest } from "../src/judges.ts";
import { REPORT_CHECK_QUESTIONS } from "../src/extensions/reports.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import type { Logger } from "../src/runtime/logger.ts";

describe("usage-judges.test.ts", () => {
  /**
   * The judgement lines the decision models card is built from.
   *
   * Every judgement pi-sec makes appends one line to the audit trail, and that line
   * is the only record of it: a judgement runs outside every conversation, so
   * pi-sec's ledger has no row for it. `JudgeUsage` read the trail's files and sums
   * those lines by judge name over the three windows the usage page shows.
   *
   * Three properties matter here, and each is a way a screen can lie:
   *
   * - A line belongs to a window by its own `time`, not by the file it sits in, so a
   *   rotated file is read and an old line inside it is still dropped.
   * - A count is a count of lines, and `unanswered` is the part of it that failed or
   *   was skipped. A judgement that never reached the model counts, because a reader
   *   wants to see that it did not happen.
   * - No text of a judgement is in the sums. The audit line does not hold it, and a
   *   reader of the audit line cannot carry it.
   */

  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  /** A temporary home with one audit file, and the path of that file. */
  async function trail(): Promise<{ readonly file: string; readonly dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-judges-"));
    roots.push(dir);
    return { file: join(dir, "audit.jsonl"), dir };
  }

  /** One judgement line, as `Judges#writeAudit` writes it. */
  function judgeLine(options: {
    at: number;
    judge?: string;
    provider?: string;
    model?: string;
    outcome?: "answered" | "failed" | "skipped";
    tokens?: number;
    cost?: number;
    refused?: string[];
  }): string {
    const line: Record<string, unknown> = {
      time: options.at,
      type: "judge",
      judge: options.judge ?? "report-check",
      outcome: options.outcome ?? "answered",
      refused: options.refused ?? [],
      elapsedMs: 120,
      inputTokens: options.tokens ?? 0,
      outputTokens: 0,
      totalTokens: options.tokens ?? 0,
      costUsd: options.cost ?? 0,
    };
    if (options.provider !== undefined) line["provider"] = options.provider;
    if (options.model !== undefined) line["model"] = options.model;
    if (line["outcome"] === "failed") line["reason"] = "provider";
    if (line["outcome"] === "skipped") line["reason"] = "model";
    return JSON.stringify(line);
  }

  /** Write lines to one file. */
  async function writeTrail(file: string, lines: readonly string[]): Promise<void> {
    await writeFile(file, lines.map((line) => `${line}\n`).join(""), "utf8");
  }

  const NOW = Date.UTC(2026, 9, 30, 3, 0, 0);
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  describe("the judgement sums", () => {
    it("leaves out a line whose time is after the moment of the read", async () => {
      const { file } = await trail();
      await writeTrail(file, [
        judgeLine({ at: NOW - HOUR, tokens: 10 }),
        judgeLine({ at: NOW + HOUR, tokens: 1000 }),
      ]);

      const usage = new JudgeUsage({ file });
      const before = (await usage.rows(NOW)).get("report-check");
      for (const window of ["day", "week", "month"] as const) {
        expect(before?.windows[window].calls).toBe(1);
        expect(before?.windows[window].tokens).toBe(10);
      }
      // Once its moment comes, the line counts.
      const after = (await usage.rows(NOW + 2 * HOUR)).get("report-check");
      expect(after?.windows.day.calls).toBe(2);
    });

    it("counts a failed and a skipped judgement as unanswered, and keeps their cost", async () => {
      const { file } = await trail();
      await writeTrail(file, [
        judgeLine({ at: NOW - HOUR, outcome: "answered", tokens: 100, cost: 0.0001 }),
        judgeLine({ at: NOW - 2 * HOUR, outcome: "failed", tokens: 400, cost: 0.0004 }),
        judgeLine({ at: NOW - 3 * HOUR, outcome: "skipped" }),
      ]);

      const rows = await new JudgeUsage({ file }).rows(NOW);
      const day = rows.get("report-check")?.windows.day;
      // Every line is one judgement, so every line is one call.
      expect(day?.calls).toBe(3);
      // Two of the three gave no answer: the failure and the skip.
      expect(day?.unanswered).toBe(2);
      // A reply that could not be read was still billed, so its tokens stay.
      expect(day?.tokens).toBe(500);
      expect(day?.cost).toBeCloseTo(0.0005, 10);
    });

    it("keeps each judge apart, and reports every judge the trail holds", async () => {
      const { file } = await trail();
      await writeTrail(file, [
        judgeLine({ at: NOW - HOUR, judge: "report-check", provider: "openai", model: "gpt-6-luna" }),
        judgeLine({ at: NOW - HOUR, judge: "reply-language", provider: "deepseek", model: "flash" }),
        judgeLine({ at: NOW - HOUR, judge: "reply-language", provider: "deepseek", model: "flash", outcome: "failed" }),
      ]);

      const rows = await new JudgeUsage({ file }).rows(NOW);
      expect([...rows.keys()].sort()).toEqual(["reply-language", "report-check"]);
      expect(rows.get("report-check")?.windows.day.calls).toBe(1);
      expect(rows.get("reply-language")?.windows.day.calls).toBe(2);
      expect(rows.get("reply-language")?.windows.day.unanswered).toBe(1);
      expect(rows.get("reply-language")?.provider).toBe("deepseek");
    });

    it("ignores a line of another type, a corrupt line, and a file that is not there", async () => {
      const { file } = await trail();
      await writeTrail(file, [
        JSON.stringify({ time: NOW - HOUR, type: "server_start", pid: 1 }),
        judgeLine({ at: NOW - HOUR, tokens: 100 }),
        "{not json",
        "",
      ]);

      const rows = await new JudgeUsage({ file }).rows(NOW);
      expect(rows.get("report-check")?.windows.day.calls).toBe(1);

      // A trail that does not exist is no judgement, not a failure.
      const absent = await new JudgeUsage({ file: join(file, "..", "never-written.jsonl") }).rows(NOW);
      expect(absent.size).toBe(0);
    });

    it("carries no text of a judgement, because the audit line holds none", async () => {
      const { file } = await trail();
      // A line whose event text a caller did put in `state`. `writeAudit` never
      // writes it, and a line like this one must not leak it into the sums.
      const planted = "the judged text that must not reach the screen";
      await writeTrail(file, [
        `${judgeLine({ at: NOW - HOUR, tokens: 100 })}\n${JSON.stringify({ time: NOW - HOUR, type: "judge", judge: "report-check", state: { text: planted } })}`,
      ]);

      const rows = await new JudgeUsage({ file }).rows(NOW);
      const serialized = JSON.stringify([...rows.values()]);
      expect(serialized).not.toContain(planted);
      expect(serialized).toContain("report-check");
    });

    it("answers an empty map when the last thirty days hold no judgement", async () => {
      const { file } = await trail();
      await writeTrail(file, [judgeLine({ at: NOW - USAGE_WINDOW_MS.month - DAY })]);
      expect((await new JudgeUsage({ file }).rows(NOW)).size).toBe(0);
    });
  });
});

describe("usage-records.test.ts", () => {
  /**
   * The ledger that fills a prepaid card's three windows.
   *
   * The numbers come from pi-sec's own database: one row per model call, with the
   * provider, the moment, the tokens and the cost the catalog's prices gave it.
   * `UsageRecords` keeps minute sums in memory and reads only what arrived since the
   * last read, so two properties have to hold: a window must include the calls after
   * its start and no calls before it, and the sums built by catching up must equal
   * the sums a full recount gives. Both are checked here, on a temporary database,
   * never on the daemon's own file.
   *
   * DeepSeek's recorded cost is the peak price, and the price of a call that ran
   * outside DeepSeek's peak hours is half of it. The peak window is Monday to Friday
   * in UTC, 01:00-04:00 and 06:00-10:00, with the start inside and the end outside,
   * so the edge minutes are pinned one at a time.
   */

  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  /** The schema pi-durable creates, so a row here is a row the daemon would write. */
  const SCHEMA =
    "CREATE TABLE entries (" +
    " id INTEGER PRIMARY KEY," +
    " conversation_id INTEGER NOT NULL," +
    " head INTEGER," +
    " commit_seq INTEGER NOT NULL," +
    " record TEXT NOT NULL CHECK (json_valid(record))" +
    ") STRICT";

  let nextId = 1;

  /** One ledger in a temporary directory, with the daemon's schema and no rows. */
  async function ledger(): Promise<{ path: string; db: DatabaseSync }> {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-usage-"));
    roots.push(root);
    const path = join(root, "sec.sqlite");
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return { path, db };
  }

  /** One model call, as the daemon records it. */
  function addCall(
    db: DatabaseSync,
    call: { provider: string; at: number; tokens?: number; cost?: number; kind?: string },
  ): void {
    const record = {
      kind: call.kind ?? "pi.assistant",
      model: [
        {
          role: "assistant",
          provider: call.provider,
          model: `${call.provider}-model`,
          timestamp: call.at,
          usage: { totalTokens: call.tokens ?? 100, cost: { total: call.cost ?? 1 } },
        },
      ],
    };
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)").run(
      nextId,
      1,
      null,
      nextId,
      JSON.stringify(record),
    );
    nextId += 1;
  }

  /** One window's sums, from a totals map that may not name the provider at all. */
  function windowOf(totals: Map<string, UsageLedger>, provider: string, window: keyof UsageWindows): UsageTotals {
    return totals.get(provider)?.windows[window] ?? { calls: 0, tokens: 0, cost: 0 };
  }

  /** One provider's daily slots, or thirty zero slots when it has no row at all. */
  function slotsOf(totals: Map<string, UsageLedger>, provider: string, now: number): readonly UsageSlotSums[] {
    const daily = totals.get(provider)?.daily;
    if (daily !== undefined) return daily;
    return dailySlotRanges(now).map((range) => ({ from: range.from, to: range.to, calls: 0, tokens: 0, cost: 0 }));
  }

  /** The sums of a run of slots, oldest first, as the windows count them. */
  function sumOf(slots: readonly UsageSlotSums[], from: number, to: number = slots.length): UsageTotals {
    const sum = { calls: 0, tokens: 0, cost: 0 };
    for (const slot of slots.slice(from, to)) {
      sum.calls += slot.calls;
      sum.tokens += slot.tokens;
      sum.cost += slot.cost;
    }
    return sum;
  }

  /** A moment on a whole minute, so a window edge and a bucket edge are the same. */
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

  describe("the three windows", () => {
    it("counts a call at the start of a window and leaves out the minute before it", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.day, cost: 1 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.day - 60_000, cost: 10 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.week, cost: 100 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.week - 60_000, cost: 1000 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.month, cost: 10_000 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.month - 60_000, cost: 100_000 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      expect(windowOf(totals, "alpha", "day")).toEqual({ calls: 1, tokens: 100, cost: 1 });
      expect(windowOf(totals, "alpha", "week").calls).toBe(3);
      expect(windowOf(totals, "alpha", "week").cost).toBe(111);
      expect(windowOf(totals, "alpha", "month").calls).toBe(5);
      expect(windowOf(totals, "alpha", "month").cost).toBe(11_111);
    });

    it("leaves out a call recorded after the moment of the read, in every window and in every slot", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - 60_000, tokens: 10, cost: 1 });
      addCall(db, { provider: "alpha", at: NOW + 2 * 60_000, tokens: 1000, cost: 100 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      for (const window of ["day", "week", "month"] as const) {
        expect(windowOf(totals, "alpha", window)).toEqual({ calls: 1, tokens: 10, cost: 1 });
      }
      expect(sumOf(slotsOf(totals, "alpha", NOW), 0)).toEqual({ calls: 1, tokens: 10, cost: 1 });

      // A read at a moment past that row counts it.
      const later = await records.totals(NOW + 3 * 60_000);
      records.close();
      expect(windowOf(later, "alpha", "day")).toEqual({ calls: 2, tokens: 1010, cost: 101 });
      expect(sumOf(slotsOf(later, "alpha", NOW + 3 * 60_000), 0).calls).toBe(2);
    });

    it("keeps one provider's calls apart from another's", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - 60_000, tokens: 10, cost: 0.5 });
      addCall(db, { provider: "beta", at: NOW - 60_000, tokens: 20, cost: 0.25 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      expect(windowOf(totals, "alpha", "day")).toEqual({ calls: 1, tokens: 10, cost: 0.5 });
      expect(windowOf(totals, "beta", "day")).toEqual({ calls: 1, tokens: 20, cost: 0.25 });
    });

    it("skips a row that is not a model call, and a call whose numbers are unreadable", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - 60_000, cost: 1, kind: "pi.user" });
      db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)").run(
        99,
        1,
        null,
        99,
        JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", provider: "alpha", timestamp: "later" }] }),
      );
      addCall(db, { provider: "alpha", at: NOW - 120_000, cost: 2 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      expect(windowOf(totals, "alpha", "day")).toEqual({ calls: 1, tokens: 100, cost: 2 });
    });
  });

  describe("catching up", () => {
    it("adds only what arrived since, and agrees with a full recount", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - 3_600_000, cost: 1 });
      addCall(db, { provider: "beta", at: NOW - 3_600_000, cost: 2 });
      db.close();

      // One instance counts what it saw first, then catches up twice.
      const records = new UsageRecords({ path });
      const first = await records.totals(NOW);
      expect(windowOf(first, "alpha", "day").calls).toBe(1);

      const writer = new DatabaseSync(path);
      addCall(writer, { provider: "alpha", at: NOW - 1_800_000, cost: 3 });
      addCall(writer, { provider: "gamma", at: NOW - 1_200_000, cost: 4 });
      addCall(writer, { provider: "alpha", at: NOW - 600_000, cost: 5 });
      const second = await records.totals(NOW);
      addCall(writer, { provider: "beta", at: NOW - 300_000, cost: 6 });
      const third = await records.totals(NOW);
      writer.close();
      records.close();

      // A second instance reads the same file from nothing, which is the recount.
      const recount = new UsageRecords({ path });
      const full = await recount.totals(NOW);
      recount.close();

      expect(third.get("alpha")?.day).toEqual(full.get("alpha")?.day);
      expect(third.get("beta")?.day).toEqual(full.get("beta")?.day);
      expect(third.get("gamma")?.day).toEqual(full.get("gamma")?.day);
      expect(windowOf(third, "alpha", "day")).toEqual({ calls: 3, tokens: 300, cost: 9 });
      expect(windowOf(second, "beta", "day").cost).toBe(2);
      expect(windowOf(third, "beta", "day").cost).toBe(8);
    });

    it("does not count the same row twice when two requests ask at once", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - 60_000, cost: 1 });
      db.close();

      const records = new UsageRecords({ path });
      const [left, right] = await Promise.all([records.totals(NOW), records.totals(NOW)]);
      records.close();

      expect(windowOf(left, "alpha", "day").calls).toBe(1);
      expect(windowOf(right, "alpha", "day").calls).toBe(1);
    });

    it("says so when the database cannot be read", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sec-usage-"));
      roots.push(root);
      const records = new UsageRecords({ path: join(root, "absent.sqlite") });
      await expect(records.totals(NOW)).rejects.toThrow(/usage ledger cannot be read/);
    });
  });

  describe("DeepSeek's peak price", () => {
    /** Monday 2026-10-26 at one minute past the hour, in UTC. */
    const monday = (hour: number, minute: number): number => Date.UTC(2026, 9, 26, hour, minute);

    it("states the peak window as Monday to Friday, 01:00-04:00 and 06:00-10:00 UTC", () => {
      expect(new Date(monday(1, 0)).getUTCDay()).toBe(1);
      expect(isDeepSeekPeak(monday(0, 59))).toBe(false);
      expect(isDeepSeekPeak(monday(1, 0))).toBe(true);
      expect(isDeepSeekPeak(monday(3, 59))).toBe(true);
      expect(isDeepSeekPeak(monday(4, 0))).toBe(false);
      expect(isDeepSeekPeak(monday(6, 0))).toBe(true);
      expect(isDeepSeekPeak(monday(9, 59))).toBe(true);
      expect(isDeepSeekPeak(monday(10, 0))).toBe(false);
      // Saturday 02:00 UTC is inside the hours but not a working day.
      expect(isDeepSeekPeak(Date.UTC(2026, 9, 31, 2, 0))).toBe(false);
    });

    /** The recorded cost one call at `at` comes to, through a ledger of its own. */
    async function costAt(at: number, provider = "deepseek"): Promise<number> {
      const { path, db } = await ledger();
      addCall(db, { provider, at, cost: 1 });
      db.close();
      const records = new UsageRecords({ path });
      const totals = await records.totals(at + 60_000);
      records.close();
      expect(windowOf(totals, provider, "day").calls).toBe(1);
      return windowOf(totals, provider, "day").cost;
    }

    it.each([
      ["halves the recorded amount outside the peak hours: just before", "deepseek", monday(0, 59), 0.5],
      ["halves the recorded amount outside the peak hours: end of the morning window", "deepseek", monday(4, 0), 0.5],
      ["halves the recorded amount outside the peak hours: end of the afternoon window", "deepseek", monday(10, 0), 0.5],
      ["halves the recorded amount outside the peak hours: a Saturday", "deepseek", Date.UTC(2026, 9, 31, 2, 0), 0.5],
      ["keeps the recorded amount inside the peak hours: start", "deepseek", monday(1, 0), 1],
      ["keeps the recorded amount inside the peak hours: end of the morning window", "deepseek", monday(3, 59), 1],
      ["keeps the recorded amount inside the peak hours: afternoon start", "deepseek", monday(6, 0), 1],
      ["keeps the recorded amount inside the peak hours: afternoon end", "deepseek", monday(9, 59), 1],
      ["leaves every other provider's recorded amount alone", "alpha", monday(0, 59), 1],
    ])("%s", async (_name, provider, at, cost) => {
      expect(await costAt(at, provider)).toBe(cost);
    });
  });

  /**
   * The thirty daily slots of a prepaid card.
   *
   * They come from the same minute buckets as the windows, so the two must agree:
   * the newest slot is the day window, seven of them are the week, and all thirty
   * are the month. The edges are the part worth pinning one minute at a time,
   * because a minute at a slot's start belongs to that slot and the minute before
   * it belongs to the older one.
   */
  describe("the thirty daily slots", () => {
    /** The minute of `NOW`, which is on a whole minute. */
    const m = Math.floor(NOW / 60_000);
    const MINUTE = 60_000;
    const SLOT_MS = USAGE_WINDOW_MS.day;

    it("gives thirty slots of one day, oldest first, ending at now", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - MINUTE, cost: 1 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      const slots = slotsOf(totals, "alpha", NOW);
      expect(slots).toHaveLength(DAILY_SLOT_COUNT);
      expect(DAILY_SLOT_COUNT).toBe(30);
      // The oldest slot starts exactly where the month window starts.
      expect(slots[0]?.from).toBe(NOW - USAGE_WINDOW_MS.month);
      expect(slots[DAILY_SLOT_COUNT - 1]?.to).toBe(NOW);
      // Contiguous: each slot ends where the next one begins.
      for (let index = 0; index < DAILY_SLOT_COUNT; index += 1) {
        const slot = slots[index];
        expect(slot).toBeDefined();
        expect(slot!.to - slot!.from).toBe(SLOT_MS);
        if (index > 0) expect(slot!.from).toBe(slots[index - 1]!.to);
      }
      // The newest slot ends at the moment of the read, not at the next minute.
      expect(slots[DAILY_SLOT_COUNT - 1]?.from).toBe((m - 1440) * MINUTE);
    });

    it("ends the newest slot at a moment that is not on a minute", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - MINUTE, cost: 1 });
      db.close();

      const late = NOW + 30_000;
      const records = new UsageRecords({ path });
      const totals = await records.totals(late);
      records.close();

      const slots = slotsOf(totals, "alpha", late);
      expect(slots[DAILY_SLOT_COUNT - 1]?.to).toBe(late);
      expect(slots[DAILY_SLOT_COUNT - 1]?.from).toBe((m - 1440) * MINUTE);
      // The current minute is inside the newest slot, as it is inside the day window.
      expect(slots[DAILY_SLOT_COUNT - 1]?.calls).toBe(1);
      expect(windowOf(totals, "alpha", "day").calls).toBe(1);
    });

    it("makes the newest slot the day window, the last seven the week, and all thirty the month", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "alpha", at: NOW - MINUTE, cost: 1, tokens: 10 });
      addCall(db, { provider: "alpha", at: NOW - 3 * SLOT_MS, cost: 2, tokens: 20 });
      addCall(db, { provider: "alpha", at: NOW - 6 * SLOT_MS, cost: 4, tokens: 40 });
      addCall(db, { provider: "alpha", at: NOW - 7 * SLOT_MS, cost: 8, tokens: 80 });
      addCall(db, { provider: "alpha", at: NOW - 20 * SLOT_MS, cost: 16, tokens: 160 });
      addCall(db, { provider: "alpha", at: NOW - USAGE_WINDOW_MS.month, cost: 32, tokens: 320 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      const slots = slotsOf(totals, "alpha", NOW);
      const newest = slots[DAILY_SLOT_COUNT - 1]!;
      expect({ calls: newest.calls, tokens: newest.tokens, cost: newest.cost }).toEqual(windowOf(totals, "alpha", "day"));
      expect(sumOf(slots, DAILY_SLOT_COUNT - 7)).toEqual(windowOf(totals, "alpha", "week"));
      expect(sumOf(slots)).toEqual(windowOf(totals, "alpha", "month"));

      // The call seven days back is in the week window and outside the seven newest
      // slots, and the one thirty days back is in the month window and the oldest slot.
      expect(slots[DAILY_SLOT_COUNT - 7]?.cost).toBe(8);
      expect(slots[0]?.cost).toBe(32);
      expect(windowOf(totals, "alpha", "week").cost).toBe(1 + 2 + 4 + 8);
      expect(windowOf(totals, "alpha", "month").cost).toBe(1 + 2 + 4 + 8 + 16 + 32);
    });

    it("puts a call at a slot's start minute in that slot, and the minute before it in the older one", async () => {
      const { path, db } = await ledger();
      // The boundary between the newest slot and the one before it.
      addCall(db, { provider: "alpha", at: (m - 1440) * MINUTE, cost: 1 });
      addCall(db, { provider: "alpha", at: (m - 1440) * MINUTE - MINUTE, cost: 10 });
      // A boundary fifteen days back, well inside the run of slots.
      addCall(db, { provider: "alpha", at: (m - 15 * 1440) * MINUTE, cost: 100 });
      addCall(db, { provider: "alpha", at: (m - 15 * 1440) * MINUTE - MINUTE, cost: 1000 });
      // The outer edge: the first minute of the oldest slot, and the one before it.
      addCall(db, { provider: "alpha", at: (m - 30 * 1440) * MINUTE, cost: 10_000 });
      addCall(db, { provider: "alpha", at: (m - 30 * 1440) * MINUTE - MINUTE, cost: 100_000 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      const slots = slotsOf(totals, "alpha", NOW);
      // Newest slot start: inside the newest slot; the minute before: slot 28.
      expect(slots[29]?.cost).toBe(1);
      expect(slots[28]?.cost).toBe(10);
      // Fifteen days back: inside slot 15; the minute before: slot 14.
      expect(slots[15]?.cost).toBe(100);
      expect(slots[14]?.cost).toBe(1000);
      // The oldest slot keeps its first minute; the minute before it is in no slot.
      expect(slots[0]?.cost).toBe(10_000);
      expect(slots.reduce((sum, slot) => sum + slot.cost, 0)).toBe(1 + 10 + 100 + 1000 + 10_000);
      // The windows agree: the minute before the month's start is in no window either.
      expect(windowOf(totals, "alpha", "month").cost).toBe(11_111);
      expect(windowOf(totals, "alpha", "day").cost).toBe(1);
    });

    it("gives a provider with no recorded call thirty zero slots", async () => {
      const { path, db } = await ledger();
      addCall(db, { provider: "beta", at: NOW - MINUTE, cost: 1 });
      db.close();

      const records = new UsageRecords({ path });
      const totals = await records.totals(NOW);
      records.close();

      // The map only names providers with a row; the card fills the rest from
      // `emptyLedger`, which is the same thirty boundaries at zero.
      expect(totals.get("alpha")).toBeUndefined();
      const slots = slotsOf(totals, "alpha", NOW);
      expect(slots).toHaveLength(DAILY_SLOT_COUNT);
      expect(slots[DAILY_SLOT_COUNT - 1]?.to).toBe(NOW);
      expect(sumOf(slots)).toEqual({ calls: 0, tokens: 0, cost: 0 });
      expect(totals.get("beta")?.daily[DAILY_SLOT_COUNT - 1]?.calls).toBe(1);
    });
  });
});

describe("usage-subscription-windows.test.ts", () => {
  /**
   * pi-sec's own usage on the two subscription cards.
   *
   * The synthetic.new card and the Anthropic card state a quota the provider
   * reports. Beside it, the answer carries the windows and the daily slots that the
   * prepaid card already carries, counted from pi-sec's own ledger: the three
   * rolling windows and the thirty daily slots for synthetic.new, and the thirty
   * daily slots for Anthropic. Which of them a card has comes from the provider's
   * entry in `fetchers.ts`, never from the provider's name in the card code.
   *
   * Two rules are pinned here, because the two numbers have two different sources.
   * A ledger that cannot be read is a reason on those fields alone, and leaves the
   * provider's own quota as it was. A provider that does not answer is a reason on
   * its own fields alone, and leaves the ledger's fields drawn. A card that mixed
   * the two would report a database failure as a provider failure, or hide pi-sec's
   * own count because a provider was down.
   */

  const TIMEZONE = "Asia/Tokyo";
  /** A moment on a minute boundary, so every label below can be written in full. */
  const NOW = Date.UTC(2026, 9, 24, 22, 30, 0);

  const ANTHROPIC_TOKEN = "fake-anthropic-oauth-token-0011";
  const SYNTHETIC_KEY = "fake-synthetic-api-key-0012";

  /** The quota answer synthetic.new gives. */
  const SYNTHETIC_BODY = {
    planWeeklyLimit: { percentRemaining: 96, nextRegenAt: "2026-10-27T19:56:56.000Z", nextRegenPercent: 2 },
  };

  /** The usage answer the Anthropic subscription endpoint gives. */
  const ANTHROPIC_BODY = {
    five_hour: { utilization: 28, resets_at: "2026-10-26T11:59:59Z" },
    seven_day: { utilization: 72, resets_at: "2026-10-30T20:59:59Z" },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, currency: "USD" },
    spend: { enabled: false, used: { amount: 0, currency: "USD" }, limit: null, balance: null },
  };

  /**
   * One provider's ledger, with numbers no other provider in this file has: the
   * window totals are the provider's own, and the newest daily slot is the whole of
   * the day window.
   */
  function ledgerOf(sums: { calls: number; tokens: number; cost: number }): UsageLedger {
    const daily = emptyLedger(NOW).daily.map((slot, index) =>
      index === emptyLedger(NOW).daily.length - 1 ? { ...slot, ...sums } : { ...slot },
    );
    return { windows: { day: { ...sums }, week: { ...sums }, month: { ...sums } }, daily };
  }

  /** synthetic.new's numbers, and Anthropic's, differ so a mixed-up key shows. */
  const SYNTHETIC_SUMS = { calls: 863, tokens: 83_403_123, cost: 0.8426 };
  const ANTHROPIC_SUMS = { calls: 20_145, tokens: 900_000_000, cost: 2_065.39 };
  /** A third provider, so a card that read the wrong key would find numbers here. */
  const OTHER_SUMS = { calls: 5, tokens: 5_000, cost: 0.05 };

  const TOTALS = new Map<string, UsageLedger>([
    ["synthetic", ledgerOf(SYNTHETIC_SUMS)],
    ["anthropic", ledgerOf(ANTHROPIC_SUMS)],
    ["deepseek", ledgerOf(OTHER_SUMS)],
  ]);

  interface Reply {
    readonly status?: number;
    readonly body?: unknown;
  }

  /** A fetch that answers from a table and remembers every address it was asked for. */
  function fakeFetch(replies: Readonly<Record<string, Reply>>): { fetch: typeof globalThis.fetch; calls: string[] } {
    const calls: string[] = [];
    const impl = async (input: unknown): Promise<unknown> => {
      const url = String(input);
      calls.push(url);
      const reply = replies[url];
      if (reply === undefined) throw new Error(`this test gave no answer for ${url}`);
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(reply.body ?? {}),
      };
    };
    return { fetch: impl as unknown as typeof globalThis.fetch, calls };
  }

  /** The catalog with both subscription logins and one prepaid login. */
  interface Catalog {
    readonly configured: Set<string>;
    readonly subscription: Set<string>;
    readonly auth: Map<string, string>;
  }

  function catalogOf(): Catalog {
    return {
      configured: new Set(["synthetic", "anthropic", "deepseek"]),
      subscription: new Set(["anthropic", "synthetic"]),
      auth: new Map([
        ["synthetic", SYNTHETIC_KEY],
        ["anthropic", ANTHROPIC_TOKEN],
        ["deepseek", "fake-deepseek-key-0013"],
      ]),
    };
  }

  function modelsOf(catalog: Catalog): UsageModels {
    return {
      getProviders: () => [
        { id: "synthetic", name: "synthetic.new" },
        { id: "anthropic", name: "Anthropic" },
        { id: "deepseek", name: "DeepSeek" },
      ],
      hasConfiguredAuth: (providerId) => catalog.configured.has(providerId),
      isUsingSubscription: (providerId) => catalog.subscription.has(providerId),
      getAuth: async (providerId) => {
        const key = catalog.auth.get(providerId);
        return key === undefined ? undefined : { auth: { apiKey: key } };
      },
    };
  }

  /** The service, with a fake ledger that a test may make unreadable. */
  function serviceOf(options: { fetch: typeof globalThis.fetch; ledgerFails?: boolean }) {
    return createUsageService({
      models: () => modelsOf(catalogOf()),
      records: {
        totals: async () => {
          if (options.ledgerFails === true) throw new Error("usage ledger cannot be read: no such file");
          return TOTALS;
        },
      },
      timezone: () => TIMEZONE,
      now: () => NOW,
      fetch: options.fetch,
    });
  }

  function cardOf(answer: UsageAnswer, provider: string): UsageCard {
    const card = answer.cards.find((entry) => entry.provider === provider);
    if (card === undefined) throw new Error(`no card for ${provider}`);
    return card;
  }

  /** The thirty slots of a card's daily field. */
  function slotsOf(card: UsageCard): readonly UsageSlot[] {
    const field = card.fields["daily"];
    if (field === undefined || field.state !== "value") throw new Error("the card has no daily value");
    return (field.value as { readonly slots: readonly UsageSlot[] }).slots;
  }

  describe("the subscription cards and pi-sec's own ledger", () => {
    it("carries the three windows and the daily slots of the synthetic.new card, from the synthetic ledger", async () => {
      const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body: SYNTHETIC_BODY } });
      const card = cardOf(await serviceOf({ fetch: remote.fetch }).answer(), "synthetic");

      expect(card.shape).toBe("subscription");
      // The provider's own two fields are unchanged by the ledger's four.
      expect(card.fields["weekly"]).toMatchObject({ state: "value", value: { utilization: 4, regenPercent: 2 } });
      expect(card.fields["credits"]).toMatchObject({ state: "value", value: { used: null, limit: null, balance: null } });

      expect(card.fields["day"]).toEqual({ state: "value", value: SYNTHETIC_SUMS });
      expect(card.fields["week"]).toEqual({ state: "value", value: SYNTHETIC_SUMS });
      expect(card.fields["month"]).toEqual({ state: "value", value: SYNTHETIC_SUMS });

      const slots = slotsOf(card);
      expect(slots).toHaveLength(30);
      // The newest slot is the day window itself, and it carries the same numbers.
      expect(slots[29]).toEqual({
        from: { at: NOW - 24 * 60 * 60 * 1000, label: "2026-10-24 07:30" },
        to: { at: NOW, label: "2026-10-25 07:30" },
        ...SYNTHETIC_SUMS,
      });
      // The oldest slot starts thirty days back, and holds none of these calls.
      expect(slots[0]?.from).toEqual({ at: NOW - 30 * 24 * 60 * 60 * 1000, label: "2026-09-25 07:30" });
      expect(slots[0]?.calls).toBe(0);
      // The card states what its cost is, in one line.
      expect(card.note).toBe("pi-sec calls only · estimated credit use at subscription rates");
    });

    it("carries the daily slots of the Anthropic card only, from the anthropic ledger", async () => {
      const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: { body: ANTHROPIC_BODY } });
      const card = cardOf(await serviceOf({ fetch: remote.fetch }).answer(), "anthropic");

      // The three windows are not this provider's: only the daily
      // columns are asked for, and the answer carries no window the card did not have before.
      expect(card.fields["day"]).toBeUndefined();
      expect(card.fields["week"]).toBeUndefined();
      expect(card.fields["month"]).toBeUndefined();

      const slots = slotsOf(card);
      expect(slots).toHaveLength(30);
      expect(slots[29]).toMatchObject(ANTHROPIC_SUMS);
      expect(slots[0]?.calls).toBe(0);

      // The three fields the card always had are untouched.
      expect(card.fields["fiveHour"]).toEqual({
        state: "value",
        value: { utilization: 28, resetsAt: { at: Date.parse("2026-10-26T11:59:59Z"), label: "2026-10-26 20:59" } },
      });
      expect(card.fields["weekly"]).toEqual({
        state: "value",
        value: { utilization: 72, resetsAt: { at: Date.parse("2026-10-30T20:59:59Z"), label: "2026-10-31 05:59" } },
      });
      expect(card.fields["credits"]).toEqual({
        state: "value",
        value: { enabled: false, used: { amount: 0, currency: "USD" }, limit: null, disabledReason: null, balance: null },
      });
      expect(card.note).toBe("pi-sec calls only · API-equivalent cost");
    });

    it("leaves a subscription card of a provider that names no ledger fields without them", async () => {
      const remote = fakeFetch({});
      const service = createUsageService({
        models: () => ({
          getProviders: () => [{ id: "kimi-coding", name: "Kimi For Coding" }],
          hasConfiguredAuth: () => true,
          isUsingSubscription: () => true,
        }),
        records: { totals: async () => TOTALS },
        timezone: () => TIMEZONE,
        now: () => NOW,
        fetch: remote.fetch,
      });

      const card = cardOf(await service.answer(), "kimi-coding");
      expect(Object.keys(card.fields).sort()).toEqual(["credits", "fiveHour", "weekly"]);
      expect(card.note).toBeUndefined();
    });

    it("states the ledger's own reason on the four fields, and leaves the provider's fields alone", async () => {
      const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { body: SYNTHETIC_BODY } });
      const card = cardOf(await serviceOf({ fetch: remote.fetch, ledgerFails: true }).answer(), "synthetic");

      for (const key of ["day", "week", "month", "daily"]) {
        expect(card.fields[key], key).toEqual({ state: "error", reason: "ledger unreadable" });
      }
      // The provider answered, so its own fields are the values it stated.
      expect(card.fields["weekly"]).toMatchObject({ state: "value", value: { utilization: 4 } });
      expect(card.fields["credits"]).toMatchObject({ state: "value", value: { billing: { label: "synthetic.new billing page" } } });
    });

    it("states the provider's failure on its own fields, and keeps the ledger's fields drawn", async () => {
      const remote = fakeFetch({ [SYNTHETIC_QUOTAS_URL]: { status: 503 } });
      const card = cardOf(await serviceOf({ fetch: remote.fetch }).answer(), "synthetic");

      expect(card.receivedAt).toBeNull();
      expect(card.fields["fiveHour"]).toBeUndefined();
      expect(card.fields["weekly"]).toEqual({ state: "error", reason: "HTTP 503" });
      expect(card.fields["credits"]).toEqual({ state: "error", reason: "HTTP 503" });

      // pi-sec's own numbers come from the database, so a provider that is down
      // does not take them away.
      expect(card.fields["day"]).toEqual({ state: "value", value: SYNTHETIC_SUMS });
      expect(card.fields["month"]).toEqual({ state: "value", value: SYNTHETIC_SUMS });
      expect(slotsOf(card)).toHaveLength(30);
    });

    it("keeps the daily slots of a failed Anthropic card too", async () => {
      const remote = fakeFetch({ [ANTHROPIC_USAGE_URL]: { status: 429 } });
      const card = cardOf(await serviceOf({ fetch: remote.fetch }).answer(), "anthropic");

      expect(card.fields["fiveHour"]).toEqual({ state: "error", reason: "HTTP 429" });
      expect(card.fields["daily"]).toMatchObject({ state: "value" });
      expect(slotsOf(card)).toHaveLength(30);
      expect(slotsOf(card)[29]).toMatchObject(ANTHROPIC_SUMS);
    });
  });
});

describe("judges.test.ts", () => {
  /**
   * Judge models: the request pi-sec sends to the Decisions API, and the answers it
   * reads back.
   *
   * A judge is answered by `src/judges-openai-decisions.ts`, which pi-sec calls
   * itself. The tests here drive that call with a fake HTTP function, so no network
   * call is made and no credential is needed, and they count the calls the fake was
   * given. The catalog is a real pi-ai `Models` collection with a test provider, so
   * the lookup, the credential and the availability checks are the ones the daemon
   * runs. The provider also registers a classifier implementation that fails the
   * test if it is ever called: pi-sec must not route a judgement through pi-ai.
   *
   * A chat model of the same id is listed on the same provider, with a streaming
   * implementation that fails the test if it is ever streamed: a judge never falls
   * back to a conversation model.
   */

  type LogLine = { readonly level: string; readonly message: string; readonly fields?: Record<string, unknown> };

  interface Sandbox {
    readonly log: LogLine[];
    readonly logger: Logger;
    readonly auditFile: string;
    close(): Promise<void>;
  }

  /** The key every test provider hands out. It must never leave the request header. */
  const TEST_KEY = "sk-test-judge-key";

  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function sandbox(): Promise<Sandbox> {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-judges-"));
    roots.push(root);
    const log: LogLine[] = [];
    const logger: Logger = {
      debug: (message, fields) => log.push({ level: "debug", message, fields }),
      info: (message, fields) => log.push({ level: "info", message, fields }),
      warn: (message, fields) => log.push({ level: "warn", message, fields }),
      error: (message, fields) => log.push({ level: "error", message, fields }),
      child: () => logger,
    };
    return {
      log,
      logger,
      auditFile: join(root, "audit.jsonl"),
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  /** One request the fake HTTP function was given. */
  interface HttpCall {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    /** The body exactly as it was serialized. */
    readonly body: string;
    /** The body as the service would read it. */
    readonly json: {
      readonly model?: string;
      readonly input?: string;
      readonly questions?: readonly { readonly type: string; readonly name: string }[];
    };
  }

  interface FakeHttp {
    readonly fetch: typeof globalThis.fetch;
    readonly calls: HttpCall[];
  }

  /** An HTTP function that answers with the replies in order and repeats the last one. */
  function fakeHttp(replies: readonly (() => Response)[]): FakeHttp {
    const calls: HttpCall[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
        json: JSON.parse(body) as HttpCall["json"],
      });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply === undefined) throw new Error("the fake was given no reply");
      return await reply();
    };
    return { fetch: fetch as typeof globalThis.fetch, calls };
  }

  /** A JSON reply. */
  function jsonReply(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
    return () => new Response(JSON.stringify(body), { status, headers });
  }

  /** A reply body with one predicate answer per key, then one refusal per refused key. */
  function answersBody(
    probabilities: Readonly<Record<string, number>>,
    refused: readonly string[] = [],
    usage?: Readonly<Record<string, unknown>>,
  ): unknown {
    return {
      model: "test-judge",
      answers: [
        ...Object.entries(probabilities).map(([name, probability]) => ({ type: "predicate", name, probability })),
        ...refused.map((name) => ({ type: "refusal", name })),
      ],
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** A classifier entry: the shape `getModelOfType("classifier", …)` returns. */
  function classifierModel(provider: string, id: string, api: ClassifierApi = "openai-decisions"): ClassifierModel<ClassifierApi> {
    return {
      id,
      name: id,
      api,
      provider,
      baseUrl: "https://judges.invalid",
      input: ["text"],
      cost: {
        input: 0.1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        // The catalog price of `openai`/`gpt-6-luna`: a long input costs twice as much.
        tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 }],
      },
      contextWindow: 922000,
      type: "classifier",
    };
  }

  /** A chat model of the same name, which a judge must never reach. */
  function chatModel(provider: string, id: string): Model<Api> {
    return {
      id,
      name: id,
      api: "test-chat",
      provider,
      baseUrl: "https://judges.invalid",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: false,
      type: "chat",
    };
  }

  interface ProviderSpec {
    readonly id: string;
    /** Classifier models this provider lists, with the api each one names. */
    readonly classifiers?: readonly string[];
    /** The api the classifier models name. Default `openai-decisions`. */
    readonly api?: ClassifierApi;
    /** Chat model ids this provider lists, with a stream that fails the test if called. */
    readonly chats?: readonly string[];
    /** Whether `checkAuth()` finds a credential. Default true. */
    readonly credentials?: boolean;
    /** Models the provider hides for the current credential, as `openai` hides its classifier under a chat login. */
    readonly hidden?: readonly string[];
  }

  interface Catalog {
    readonly models: ReturnType<typeof createModels>;
    /** Every context the pi-ai classifier was given. A judge must leave this empty. */
    readonly classified: ClassifierContext[];
    /** Every chat model id that was streamed. A judge must leave this empty. */
    readonly streamed: string[];
  }

  /** A catalog of fake providers, on a real pi-ai `Models` collection. */
  function catalog(specs: readonly ProviderSpec[]): Catalog {
    const classified: ClassifierContext[] = [];
    const streamed: string[] = [];
    const models = createModels();
    for (const spec of specs) {
      const api = spec.api ?? "openai-decisions";
      models.setProvider(
        createProvider({
          id: spec.id,
          auth: {
            apiKey: {
              name: `${spec.id} test key`,
              resolve: async () => (spec.credentials === false ? undefined : { auth: { apiKey: TEST_KEY } }),
            },
          },
          models: [
            ...(spec.classifiers ?? []).map((id) => classifierModel(spec.id, id, api)),
            ...(spec.chats ?? []).map((id) => chatModel(spec.id, id)),
          ],
          api: {
            stream: (model) => {
              streamed.push(model.id);
              throw new Error(`a judge streamed chat model ${model.id}`);
            },
            streamSimple: (model) => {
              streamed.push(model.id);
              throw new Error(`a judge streamed chat model ${model.id}`);
            },
          },
          classifiers: {
            [api]: {
              classify: (model, context) => {
                classified.push(context);
                throw new Error(`pi-sec sent ${model.id} through the pi-ai classifier`);
              },
            },
          },
          ...(spec.hidden === undefined
            ? {}
            : {
                filterAllModels: (all: readonly AnyModel[]) =>
                  all.filter((model) => !spec.hidden!.includes(model.id)),
              }),
        }),
      );
    }
    return { models, classified, streamed };
  }

  function configWithJudges(table: Config["judges"]): Config {
    return { ...defaultConfig(), judges: table };
  }

  /** One bool question, the shape `report_check` asks. */
  function boolQuestion(instructions: string): ClassifierQuestion {
    return { type: "bool", instructions, criteria: { true: "Yes", false: "No" } };
  }

  const request: JudgeRequest = {
    state: { text: "안녕하세요, 오늘 날씨가 좋네요." },
    questions: { korean: boolQuestion("Is this text written in Korean?") },
  };

  /** A Judges instance over one fake HTTP function and one config. */
  function judgesWith(
    sb: Sandbox,
    models: ReturnType<typeof createModels>,
    table: Config["judges"],
    fetch: typeof globalThis.fetch,
  ): Judges {
    return new Judges({
      getConfig: () => configWithJudges(table),
      models,
      logger: sb.logger,
      audit: createAuditLog({ file: sb.auditFile }),
      fetch,
    });
  }

  describe("judge models: the request and the answer", () => {
    it("answers a refused question with its key, and keeps the other answers", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"], chats: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(answersBody({ q1: 0.9, q3: 0.2 }, ["q2"], { input_tokens: 100, output_tokens: 0 }))]);
      const judges = judgesWith(
        sb,
        c.models,
        { mixed: { provider: "test", modelId: "test-judge", timeoutMs: 500 } },
        http.fetch,
      );

      const result = await judges.judge("mixed", {
        state: { text: "text" },
        questions: { q1: boolQuestion("one"), q2: boolQuestion("two"), q3: boolQuestion("three") },
      });

      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.url).toBe("https://judges.invalid/decisions");
      expect(http.calls[0]?.json.model).toBe("test-judge");
      expect(http.calls[0]?.json.input).toBe('{"text":"text"}');
      expect(http.calls[0]?.json.questions?.map((question) => [question.type, question.name])).toEqual([
        ["predicate", "q1"],
        ["predicate", "q2"],
        ["predicate", "q3"],
      ]);
      expect(result.outcome).toBe("answered");
      if (result.outcome !== "answered") throw new Error(`expected an answer, got ${result.outcome}`);
      expect(result.answers).toEqual({
        q1: { type: "bool", probability: 0.9 },
        q3: { type: "bool", probability: 0.2 },
      });
      expect(result.refused).toEqual(["q2"]);
      // The reply reported 100 input tokens, and the catalog price is 0.1 per million.
      expect(result.usage?.input).toBe(100);
      expect(result.usage?.cost.total).toBeCloseTo(0.00001);
      // pi-ai's own classifier is never the path a judgement takes.
      expect(c.classified).toEqual([]);
      expect(c.streamed).toEqual([]);
      await sb.close();
    });

    it("answers with no probability when every question is refused", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(answersBody({}, ["q1", "q2"]))]);
      const judges = judgesWith(sb, c.models, { all: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("all", {
        questions: { q1: boolQuestion("one"), q2: boolQuestion("two") },
        state: { text: "text" },
      } as JudgeRequest);

      expect(http.calls).toHaveLength(1);
      expect(result).toMatchObject({ outcome: "answered", answers: {}, refused: ["q1", "q2"] });
      await sb.close();
    });

    it("reads a choice answer and a score answer the way pi-ai does", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([
        jsonReply({
          answers: [
            {
              type: "choice",
              name: "colour",
              choice: "red",
              probabilities: [
                { value: "red", probability: 0.7 },
                { value: "blue", probability: 0.3 },
              ],
              confidence: 0.82,
            },
            { type: "score", name: "quality", score: 4, confidence: 0.9 },
          ],
        }),
      ]);
      const judges = judgesWith(sb, c.models, { mixed: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("mixed", {
        state: { text: "text" },
        questions: {
          colour: { type: "choice", instructions: "Which colour?", criteria: { red: "Red", blue: "Blue" } },
          quality: { type: "score", instructions: "How good is it?", criteria: ["bad", "poor", "fine", "good", "great"] },
        },
      });

      expect(http.calls[0]?.json.questions?.map((question) => question.type)).toEqual(["choice", "score"]);
      if (result.outcome !== "answered") throw new Error(`expected an answer, got ${result.outcome}`);
      expect(result.answers).toEqual({
        colour: { type: "choice", choice: "red", probabilities: { red: 0.7, blue: 0.3 }, confidence: 0.82 },
        quality: { type: "score", score: 4, confidence: 0.9 },
      });
      expect(result.refused).toEqual([]);
      await sb.close();
    });

    it("fails on a reply it cannot read, and carries no provider text", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const marker = "provider says: the draft is unusable";
      const replies: readonly { readonly name: string; readonly reply: () => Response }[] = [
        { name: "an unknown answer type", reply: jsonReply({ answers: [{ type: "thought", name: "korean" }] }) },
        { name: "a missing answer", reply: jsonReply({ answers: [] }) },
        {
          name: "an answer of the wrong type for its question",
          reply: jsonReply({ answers: [{ type: "score", name: "korean", score: 1, confidence: 1 }] }),
        },
        {
          name: "a probability that is not a number",
          reply: jsonReply({ answers: [{ type: "predicate", name: "korean", probability: "0.5" }] }),
        },
        {
          name: "a probability above 1",
          reply: jsonReply({ answers: [{ type: "predicate", name: "korean", probability: 1.5 }] }),
        },
        { name: "a body that is not JSON", reply: () => new Response(marker, { status: 200 }) },
        { name: "a body that is not an object", reply: jsonReply([1, 2, 3]) },
      ];

      for (const { name, reply } of replies) {
        const http = fakeHttp([reply]);
        const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);
        const result = await judges.judge("korean", request);

        expect({ name, outcome: result.outcome, reason: result.outcome === "failed" ? result.reason : undefined }).toEqual({
          name,
          outcome: "failed",
          reason: "provider",
        });
        expect(JSON.stringify(result)).not.toContain(marker);
        expect(JSON.stringify(result)).not.toContain("draft is unusable");
        const audit = await readFile(sb.auditFile, "utf8");
        expect(audit).not.toContain("draft is unusable");
      }
      await sb.close();
    });

    it("sends a 429 again and answers the second reply", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([
        jsonReply({ error: "slow down" }, 429, { "retry-after": "0" }),
        jsonReply(answersBody({ korean: 0.94 }, [], { input_tokens: 20, output_tokens: 0 })),
      ]);
      const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("korean", request);

      expect(http.calls).toHaveLength(2);
      expect(result.outcome).toBe("answered");
      if (result.outcome !== "answered") throw new Error(`expected an answer, got ${result.outcome}`);
      expect(result.answers).toEqual({ korean: { type: "bool", probability: 0.94 } });
      await sb.close();
    });

    it("does not send a 504 or a 400 again", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      for (const status of [504, 400]) {
        const http = fakeHttp([jsonReply({ error: "no" }, status), jsonReply(answersBody({ korean: 0.9 }))]);
        const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

        const result = await judges.judge("korean", request);

        expect({ status, calls: http.calls.length, outcome: result.outcome }).toEqual({
          status,
          calls: 1,
          outcome: "failed",
        });
        if (result.outcome === "failed") expect(result.reason).toBe("provider");
      }
      await sb.close();
    });

    it("stops at its deadline, and a wait longer than the deadline ends it as a rate limit", async () => {
      expect(DEFAULT_JUDGE_TIMEOUT_MS).toBe(5000);
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);

      // A reply that never arrives: the deadline, not the service, ends the call.
      const silent = fakeHttp([() => new Promise<Response>(() => undefined)]);
      const slow = judgesWith(sb, c.models, { slow: { provider: "test", modelId: "test-judge", timeoutMs: 25 } }, silent.fetch);
      expect(await slow.judge("slow", request)).toMatchObject({ outcome: "failed", reason: "timeout" });

      // A retry the service asks to wait 60 s for cannot fit in 50 ms, so the call
      // ends instead of waiting.
      const asked = fakeHttp([jsonReply({ error: "later" }, 429, { "retry-after": "60" })]);
      const rushed = judgesWith(sb, c.models, { rushed: { provider: "test", modelId: "test-judge", timeoutMs: 50 } }, asked.fetch);
      expect(await rushed.judge("rushed", request)).toMatchObject({ outcome: "failed", reason: "rate_limited" });
      expect(asked.calls).toHaveLength(1);
      await sb.close();
    });

    /** The audit lines of a sandbox, parsed. */
    async function auditLines(sb: Sandbox): Promise<Record<string, unknown>[]> {
      return (await readFile(sb.auditFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    const MARKER = "MARKER-org-secret-text-7731";
    const rateBody = { error: { type: "tokens", code: "rate_limit_exceeded", message: MARKER } };

    it("records a 429 as rate_limited with its status, wait, type and code, and drops the message", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(rateBody, 429, { "retry-after": "60" })]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 50 } }, http.fetch);

      const result = await judges.judge("j", request);

      expect(result).toMatchObject({
        outcome: "failed",
        reason: "rate_limited",
        status: 429,
        retryAfterMs: 60000,
        errorType: "tokens",
        errorCode: "rate_limit_exceeded",
      });
      expect(http.calls).toHaveLength(1);
      const facts = { status: 429, retryAfterMs: 60000, errorType: "tokens", errorCode: "rate_limit_exceeded" };
      expect((await auditLines(sb))[0]).toMatchObject({ outcome: "failed", reason: "rate_limited", ...facts });
      const warns = sb.log.filter((line) => line.level === "warn" && line.message === "judge failed");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.fields).toMatchObject({ judge: "j", provider: "test", model: "test-judge", reason: "rate_limited", ...facts });
      expect(await readFile(sb.auditFile, "utf8")).not.toContain(MARKER);
      expect(JSON.stringify(sb.log)).not.toContain(MARKER);
      expect(JSON.stringify(result)).not.toContain(MARKER);
      await sb.close();
    });

    it("waits for a short retry-after-ms and answers on the second request", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([
        jsonReply(rateBody, 429, { "retry-after-ms": "20" }),
        jsonReply(answersBody({ korean: 0.9 })),
      ]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 2000 } }, http.fetch);

      const result = await judges.judge("j", request);

      expect(result.outcome).toBe("answered");
      expect(http.calls).toHaveLength(2);
      await sb.close();
    });

    it("records a 503 with a long wait as provider with its status and wait", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply({ error: "down" }, 503, { "retry-after": "60" })]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 50 } }, http.fetch);

      expect(await judges.judge("j", request)).toMatchObject({
        outcome: "failed",
        reason: "provider",
        status: 503,
        retryAfterMs: 60000,
      });
      await sb.close();
    });

    it("gives up as rate_limited when three 429 replies use the retries up", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(rateBody, 429, { "retry-after": "0" })]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 2000 } }, http.fetch);

      expect(await judges.judge("j", request)).toMatchObject({ outcome: "failed", reason: "rate_limited", status: 429 });
      expect(http.calls).toHaveLength(3);
      await sb.close();
    });

    it("keeps the earlier 429 status when a later request never arrives and the deadline ends the call", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(rateBody, 429, { "retry-after-ms": "10" }), () => new Promise<Response>(() => undefined)]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 100 } }, http.fetch);

      expect(await judges.judge("j", request)).toMatchObject({ outcome: "failed", reason: "timeout", status: 429 });
      expect(http.calls).toHaveLength(2);
      await sb.close();
    });

    it("drops an error type or code that does not match the short pattern", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const body = { error: { type: "has space", code: "x".repeat(200), message: MARKER } };
      const http = fakeHttp([jsonReply(body, 429, { "retry-after": "60" })]);
      const judges = judgesWith(sb, c.models, { j: { provider: "test", modelId: "test-judge", timeoutMs: 50 } }, http.fetch);

      const result = await judges.judge("j", request);

      expect(result).toMatchObject({ reason: "rate_limited", status: 429 });
      expect(result).not.toHaveProperty("errorType");
      expect(result).not.toHaveProperty("errorCode");
      const line = (await auditLines(sb))[0]!;
      expect(line).not.toHaveProperty("errorType");
      expect(line).not.toHaveProperty("errorCode");
      expect(await readFile(sb.auditFile, "utf8")).not.toContain("xxxxxxxx");
      await sb.close();
    });

    it("puts the key in the Authorization header only, and reads neither the text nor the key back", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(answersBody({ korean: 0.97 }, [], { input_tokens: 12, output_tokens: 0 }))]);
      const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("korean", request);

      expect(http.calls[0]?.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
      expect(http.calls[0]?.headers["content-type"]).toBe("application/json");
      expect(JSON.stringify(result)).not.toContain(TEST_KEY);
      expect(await readFile(sb.auditFile, "utf8")).not.toContain(TEST_KEY);
      expect(JSON.stringify(sb.log)).not.toContain(TEST_KEY);
      // The text under judgement is sent, and it is nowhere else.
      expect(http.calls[0]?.json.input).toBe(JSON.stringify(request.state));
      expect(await readFile(sb.auditFile, "utf8")).not.toContain("안녕하세요");
      await sb.close();
    });

    it("sends the seven report_check questions in the body the Decisions client builds for them", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "openai", classifiers: ["gpt-6-luna"] }]);
      const http = fakeHttp([jsonReply(answersBody({}))]);
      const judges = judgesWith(sb, c.models, { "report-check": { provider: "openai", modelId: "gpt-6-luna" } }, http.fetch);
      const questions: Record<string, ClassifierQuestion> = {};
      for (const question of REPORT_CHECK_QUESTIONS) {
        questions[`q${question.n}`] = boolQuestion(question.text);
      }
      expect(Object.keys(questions)).toEqual(["q1", "q2", "q3", "q4", "q5", "q9", "q10"]);

      await judges.judge("report-check", { state: { text: "<TEXT>" }, questions });

      // The fixture holds the wire body written out by hand from the approved
      // question text, so it does not come from the code it checks.
      const expected = await readFile(
        fileURLToPath(new URL("./fixtures/judges/report-check-body.json", import.meta.url)),
        "utf8",
      );
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.body).toBe(expected.trimEnd());
      await sb.close();
    });
  });

  describe("judge models: what is not called", () => {
    const KOREAN = { korean: { provider: "test", modelId: "test-judge" } };
    it.each<{
      name: string;
      specs: ProviderSpec[];
      judges: Config["judges"];
      asks: [string, string][];
      warns?: Record<string, unknown>;
    }>([
      {
        name: "skips a model whose api pi-sec does not call, and warns about it",
        specs: [{ id: "test", classifiers: ["test-judge"], chats: ["test-judge"], api: "test-classifier" }],
        judges: KOREAN,
        asks: [["korean", "api"]],
        warns: {
          message: "judge names a model whose api pi-sec does not call",
          fields: { judge: "korean", provider: "test", model: "test-judge", api: "test-classifier" },
        },
      },
      {
        name: "skips a name whose provider has only a chat model of that id, and streams nothing",
        specs: [{ id: "test", chats: ["test-judge"] }],
        judges: KOREAN,
        asks: [["korean", "model"]],
      },
      {
        name: "skips a model the credential hides, the way openai hides its classifier under a chat login",
        specs: [{ id: "test", classifiers: ["test-judge"], chats: ["test-judge"], hidden: ["test-judge"] }],
        judges: KOREAN,
        asks: [["korean", "model"]],
      },
      {
        name: "skips an unknown name, a missing model and a missing credential, each with its own reason",
        specs: [{ id: "test", classifiers: ["test-judge"] }, { id: "locked", classifiers: ["test-judge"], credentials: false }],
        judges: {
          absentModel: { provider: "test", modelId: "absent-judge" },
          noCredential: { provider: "locked", modelId: "test-judge" },
        },
        asks: [["unknownName", "name"], ["absentModel", "model"], ["noCredential", "auth"]],
      },
    ])("$name", async ({ specs, judges: table, asks, warns }) => {
      const sb = await sandbox();
      const c = catalog(specs);
      const http = fakeHttp([jsonReply(answersBody({ korean: 0.9 }))]);
      const judges = judgesWith(sb, c.models, table, http.fetch);

      for (const [name, reason] of asks) {
        expect(await judges.judge(name, request)).toMatchObject({ outcome: "skipped", reason });
      }
      expect(http.calls).toEqual([]);
      expect(c.classified).toEqual([]);
      expect(c.streamed).toEqual([]);
      if (warns !== undefined) {
        await judges.warnMissing();
        const warnings = sb.log.filter((line) => line.level === "warn");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject(warns);
      }
      await sb.close();
    });

    it("warns once about a missing model and once about a missing credential", async () => {
      const sb = await sandbox();
      const c = catalog([
        { id: "test", classifiers: ["test-judge"] },
        { id: "locked", classifiers: ["test-judge"], credentials: false },
      ]);
      const judges = judgesWith(
        sb,
        c.models,
        {
          fine: { provider: "test", modelId: "test-judge" },
          gone: { provider: "test", modelId: "absent-judge" },
          locked: { provider: "locked", modelId: "test-judge" },
        },
        fakeHttp([jsonReply(answersBody({}))]).fetch,
      );

      await judges.warnMissing();

      const warnings = sb.log.filter((line) => line.level === "warn");
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatchObject({
        message: "judge names a classifier model the catalog does not have",
        fields: { judge: "gone", provider: "test", model: "absent-judge" },
      });
      expect(warnings[1]).toMatchObject({
        message: "judge names a provider with no credentials",
        fields: { judge: "locked", provider: "locked" },
      });
      await sb.close();
    });
  });

  describe("judge models: the audit trail", () => {
    it("writes one line with the refused keys and the reported usage, and no judged text", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([
        jsonReply(answersBody({ q1: 0.8 }, ["q2"], { input_tokens: 5542, output_tokens: 0 })),
      ]);
      const judges = judgesWith(
        sb,
        c.models,
        {
          korean: { provider: "test", modelId: "test-judge" },
          absent: { provider: "test", modelId: "absent-judge" },
        },
        http.fetch,
      );

      const answered = await judges.judge("korean", {
        state: { text: "안녕하세요" },
        questions: { q1: boolQuestion("one"), q2: boolQuestion("two") },
      });
      expect(answered.outcome).toBe("answered");
      await judges.judge("absent", request);

      const text = await readFile(sb.auditFile, "utf8");
      const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        type: "judge",
        judge: "korean",
        provider: "test",
        model: "test-judge",
        outcome: "answered",
        refused: ["q2"],
        inputTokens: 5542,
        outputTokens: 0,
        totalTokens: 5542,
      });
      expect(typeof lines[0]?.["elapsedMs"]).toBe("number");
      // The catalog price of the classifier model: 0.1 per million input tokens.
      expect(lines[0]?.["costUsd"]).toBeCloseTo(0.0005542);
      expect(lines[1]).toMatchObject({ type: "judge", judge: "absent", outcome: "skipped", reason: "model", refused: [] });
      // The line counts the call, and the text judged is nowhere in it.
      expect(text).not.toContain("안녕하세요");
      await sb.close();
    });

    it("adds up the usage of every reply that reported it, across a retry", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([
        jsonReply({ error: "slow down", usage: { input_tokens: 30, output_tokens: 0 } }, 429, { "retry-after": "0" }),
        jsonReply(answersBody({ korean: 0.9 }, [], { input_tokens: 20, output_tokens: 0 })),
      ]);
      const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("korean", request);

      expect(http.calls).toHaveLength(2);
      if (result.outcome !== "answered") throw new Error(`expected an answer, got ${result.outcome}`);
      expect(result.usage?.input).toBe(50);
      const lines = (await readFile(sb.auditFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ outcome: "answered", inputTokens: 50, totalTokens: 50 });
      // 50 input tokens at 0.1 per million.
      expect(lines[0]?.["costUsd"]).toBeCloseTo(0.000005);
      await sb.close();
    });

    it("prices an input above 272000 tokens at the long-context rate", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      const http = fakeHttp([jsonReply(answersBody({ korean: 0.9 }, [], { input_tokens: 300000, output_tokens: 0 }))]);
      const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("korean", request);

      if (result.outcome !== "answered") throw new Error(`expected an answer, got ${result.outcome}`);
      // The catalog's long-context tier: 0.2 per million input tokens.
      expect(result.usage?.cost.total).toBeCloseTo(0.06);
      await sb.close();
    });

    it("keeps the usage a failed call reported, because the service billed it", async () => {
      const sb = await sandbox();
      const c = catalog([{ id: "test", classifiers: ["test-judge"] }]);
      // A reply that reports its usage and holds no readable answer: a missing one.
      const http = fakeHttp([jsonReply({ answers: [], usage: { input_tokens: 60, output_tokens: 0 } })]);
      const judges = judgesWith(sb, c.models, { korean: { provider: "test", modelId: "test-judge" } }, http.fetch);

      const result = await judges.judge("korean", request);

      expect(result).toMatchObject({ outcome: "failed", reason: "provider" });
      const lines = (await readFile(sb.auditFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ outcome: "failed", reason: "provider", inputTokens: 60, totalTokens: 60 });
      // 60 input tokens at the catalog price of 0.1 per million.
      expect(lines[0]?.["costUsd"]).toBeCloseTo(0.000006);
      await sb.close();
    });
  });
});
