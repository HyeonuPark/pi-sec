import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { JobRoutineSpec } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { Scheduler, nextOccurrence, parseCron, previousOccurrence } from "../src/extensions/scheduler.ts";
import { writeRoutine } from "../src/jobs/routine.ts";
import { readMessage } from "../src/message-envelope.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * What one scheduler tick costs, and why remembering the next occurrence cannot
 * change which occurrence fires.
 *
 * The reconciler used to ask every routine "is there an occurrence between your
 * last run and now?" by walking that window one minute at a time, and it built a
 * formatter for every one of those minutes. Six routines with runs hours and days
 * behind them made one pass tens of thousands of steps and seconds of blocked
 * event loop, every thirty seconds. The fix keeps one formatter per zone and
 * remembers each routine's next occurrence, so the walk happens once per changed
 * window instead of once per tick.
 *
 * Three things are checked here, in this order:
 *
 * 1. the decision is the same as the old code's, over expressions, zones (one
 *    with a daylight-saving shift), window lengths from a minute to forty days,
 *    and dates on both sides of a shift;
 * 2. a tick with six routines costs a few milliseconds, and the second one is
 *    nearly free;
 * 3. an edited expression or an edited run time is noticed, and a routine still
 *    fires at the minute it is due, with that minute as its label.
 *
 * The reference the first check is measured against is the same minute-by-minute
 * walk, with one difference: a minute's wall-clock fields come from its zone's
 * offset, read once per hour, instead of from a formatter built for that minute.
 * The walk over the forty day windows is what the file used to spend its time on,
 * and the first test below checks that reading against the formatter's own on the
 * hours around both shifts.
 */

const ctx = BACKGROUND_CONTEXT;

/** The time zones used, one of them with a daylight-saving shift. */
const ZONES = ["Asia/Tokyo", "UTC", "America/New_York"] as const;

/** A daily time, a weekly time, a stepped time, a monthly one and a weekday range. */
const CRONS = [
  "0 6 * * *",
  "0 10 * * *",
  "0 8 * * 1",
  "5 8 * * 1",
  "*/15 * * * *",
  "0 * * * *",
  "30 2 1 * *",
  "0 9 * * 1-5",
] as const;

const MINUTE = 60_000;

/**
 * The old `previousOccurrence`, kept here as the reference the new decision is
 * measured against: the last matching minute in `(afterMs, nowMs]`, walked one
 * minute at a time, and answerable only by that walk.
 *
 * This is the answer the tick used to act on, so a change that keeps it is a
 * change that cannot move an occurrence. The walk is the old one; what a minute
 * looks like is the one thing this copy reads differently (see `fieldsAt`),
 * because reading forty days of minutes through a formatter cost more time than
 * the answer is worth.
 */
function referencePreviousOccurrence(
  expression: string,
  timeZone: string,
  afterMs: number,
  nowMs: number,
  maxMinutes = 60 * 24 * 40,
): number | undefined {
  const cron = parseCron(expression);
  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  const end = Math.floor(nowMs / 60000) * 60000;
  let found: number | undefined;
  let steps = 0;
  for (let ts = start; ts <= end && steps < maxMinutes; ts += 60000, steps += 1) {
    if (referenceMatches(cron, ts, timeZone)) found = ts;
  }
  if (found === undefined && steps >= maxMinutes) {
    for (let ts = end; ts > afterMs && steps < maxMinutes * 2; ts -= 60000, steps += 1) {
      if (referenceMatches(cron, ts, timeZone)) return ts;
    }
  }
  return found;
}

/** The first matching minute after `afterMs`, walked without the skip. */
function referenceNextOccurrence(
  expression: string,
  timeZone: string,
  afterMs: number,
  horizonMinutes: number,
): number | undefined {
  const cron = parseCron(expression);
  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  for (let ts = start, steps = 0; steps < horizonMinutes; ts += 60000, steps += 1) {
    if (referenceMatches(cron, ts, timeZone)) return ts;
  }
  return undefined;
}

/** What a minute looks like on a wall clock in one zone. */
interface ZonedFields {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const HOUR = 60 * MINUTE;

/** One formatter per zone, made once, with the fields the scheduler reads a minute by. */
const referenceFormatters = new Map<string, Intl.DateTimeFormat>();

function referenceFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = referenceFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  referenceFormatters.set(timeZone, made);
  return made;
}

/** The fields of one instant, formatted by the zone's formatter. */
function intlFields(ts: number, timeZone: string): ZonedFields {
  const parts = referenceFormatter(timeZone).formatToParts(ts);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    minute: Number.parseInt(get("minute"), 10),
    hour: Number.parseInt(get("hour"), 10) % 24,
    day: Number.parseInt(get("day"), 10),
    month: Number.parseInt(get("month"), 10),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday") as (typeof WEEKDAYS)[number])),
  };
}

/** How far the zone's wall clock is ahead of UTC at one instant, in minutes. */
function offsetMinutesAt(ts: number, timeZone: string): number {
  const parts = referenceFormatter(timeZone).formatToParts(ts);
  const get = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  const local = (get("hour") % 24) * 60 + get("minute");
  const utc = new Date(ts);
  let offset = local - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
  // A wall clock is at most a day from UTC, so one step puts the difference in
  // the range every zone in use sits in.
  if (offset <= -720) offset += 1440;
  if (offset > 840) offset -= 1440;
  return offset;
}

/** A number above every minute index, so that a zone and a block make one key. */
const ZONE_KEY_STEP = 1e10;

/** A number for each zone name, so that the caches below key on numbers. */
const zoneIds = new Map<string, number>();

function zoneIdFor(timeZone: string): number {
  const known = zoneIds.get(timeZone);
  if (known !== undefined) return known;
  const id = zoneIds.size;
  zoneIds.set(timeZone, id);
  return id;
}

/** Per zone and hour block: the offset there, or `NaN` where it is not constant. */
const blockOffsets = new Map<number, number>();

/** The five fields of a minute in one number: minute, hour, day, month, weekday. */
function packFields(minute: number, hour: number, day: number, month: number, weekday: number): number {
  return minute | (hour << 6) | (day << 11) | (month << 16) | (weekday << 21);
}

/**
 * The fields of one minute, read from the zone's offset rather than formatted.
 *
 * The walk below asks about one minute at a time, and formatting every one of
 * them made a forty day window cost seconds: the offset is the only way the zone
 * enters the answer, and it changes at a shift and nowhere else. So it is read
 * once per hour block, and a minute's fields are that minute plus the offset, read
 * as UTC fields. A block whose offset differs at its two ends holds a shift, and
 * its minutes are formatted instead, so a shift inside an hour is never a guess.
 *
 * The fields come back packed into one number, because a walk asks about two
 * million minutes and an object for each of them is work without an answer. The
 * check below unpacks them and compares them with the formatter's own on the hours
 * around both of New York's shifts and across the long windows.
 */
function packedFieldsAt(ts: number, timeZone: string): number {
  const block = Math.floor(ts / HOUR);
  const blockKey = zoneIdFor(timeZone) * ZONE_KEY_STEP + block;
  let offset = blockOffsets.get(blockKey);
  if (offset === undefined) {
    const firstOffset = offsetMinutesAt(block * HOUR, timeZone);
    const lastOffset = offsetMinutesAt(block * HOUR + HOUR - MINUTE, timeZone);
    offset = firstOffset === lastOffset ? firstOffset : Number.NaN;
    blockOffsets.set(blockKey, offset);
  }
  if (Number.isNaN(offset)) {
    const fields = intlFields(ts, timeZone);
    return packFields(fields.minute, fields.hour, fields.day, fields.month, fields.weekday);
  }
  const shifted = new Date(ts + offset * MINUTE);
  return packFields(
    shifted.getUTCMinutes(),
    shifted.getUTCHours(),
    shifted.getUTCDate(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDay(),
  );
}

/** The fields of one minute, unpacked for comparison with the formatter's own. */
function fieldsAt(ts: number, timeZone: string): ZonedFields {
  const packed = packedFieldsAt(ts, timeZone);
  return {
    minute: packed & 0x3f,
    hour: (packed >> 6) & 0x1f,
    day: (packed >> 11) & 0x1f,
    month: (packed >> 16) & 0x0f,
    weekday: (packed >> 21) & 0x07,
  };
}

/** Whether one minute matches the expression, by the rule the old scan applied. */
function referenceMatches(cron: ReturnType<typeof parseCron>, ts: number, timeZone: string): boolean {
  const packed = packedFieldsAt(ts, timeZone);
  if (!cron.minute.values.has(packed & 0x3f)) return false;
  if (!cron.hour.values.has((packed >> 6) & 0x1f)) return false;
  if (!cron.month.values.has((packed >> 16) & 0x0f)) return false;
  const domMatch = cron.dayOfMonth.values.has((packed >> 11) & 0x1f);
  const dowMatch = cron.dayOfWeek.values.has((packed >> 21) & 0x07);
  if (cron.dayOfMonth.any && cron.dayOfWeek.any) return true;
  if (cron.dayOfMonth.any) return dowMatch;
  if (cron.dayOfWeek.any) return domMatch;
  return domMatch || dowMatch;
}

/**
 * The tick's decision, stated the way the reconciler states it: nothing is due
 * until the remembered instant, and past it the occurrence is the one the old
 * walk returns.
 *
 * The reconciler takes the second branch with `previousOccurrence`, which is the
 * same minute walk inside the real module, so the only new question is whether
 * "before the remembered instant" means "the window held no match".
 */
function decision(
  expression: string,
  timeZone: string,
  lastRun: number,
  nowMs: number,
): { fires: boolean; due: number | undefined } {
  const remembered = nextOccurrence(expression, timeZone, lastRun);
  if (remembered !== undefined && nowMs < remembered) return { fires: false, due: undefined };
  return { fires: true, due: previousOccurrence(expression, timeZone, lastRun, nowMs) };
}

describe("the remembered next occurrence picks the occurrence the old walk picked", () => {
  it("reads a minute the way the formatter reads it, across both shifts and the long windows", () => {
    // The walk takes a minute's fields from its zone's offset instead of building
    // a formatter for that minute, so the reading is checked against the
    // formatter's own: every minute of the three hours around each of New York's
    // shifts, every hour of the forty day window, and every sixth hour of the far
    // end of the leap-day span.
    const samples: number[] = [];
    for (const shift of [Date.UTC(2026, 2, 8, 7, 0, 0), Date.UTC(2026, 10, 1, 6, 0, 0)]) {
      for (let ts = shift - HOUR; ts <= shift + 2 * HOUR; ts += MINUTE) samples.push(ts);
    }
    const fortyDayStart = Date.UTC(2026, 8, 20, 3, 20, 0);
    for (let ts = fortyDayStart; ts <= fortyDayStart + 40 * 24 * HOUR; ts += HOUR) samples.push(ts);
    const leapStart = Date.UTC(2026, 0, 2, 4, 0, 0);
    for (let ts = leapStart + 380 * 24 * HOUR; ts <= leapStart + 400 * 24 * HOUR; ts += 6 * HOUR) {
      samples.push(ts);
    }
    for (const zone of ZONES) {
      for (const ts of samples) {
        expect({ zone, ts, fields: fieldsAt(ts, zone) }).toEqual({ zone, ts, fields: intlFields(ts, zone) });
      }
    }
  });

  it("agrees over windows from a minute to a day, in three zones", { timeout: 300_000 }, () => {
    // 2026-10-12 is a Monday, so a weekly expression has a match just behind it.
    const lastRun = Date.UTC(2026, 9, 12, 0, 0, 0);
    const windows = [1, 45, 360, 1440];
    for (const cron of CRONS) {
      for (const zone of ZONES) {
        for (const minutes of windows) {
          const now = lastRun + minutes * MINUTE + 17_000;
          const wanted = referencePreviousOccurrence(cron, zone, lastRun, now);
          const found = decision(cron, zone, lastRun, now);
          expect({ cron, zone, minutes, due: found.due }).toEqual({ cron, zone, minutes, due: wanted });
          expect({ cron, zone, minutes, fires: found.fires }).toEqual({
            cron,
            zone,
            minutes,
            fires: wanted !== undefined,
          });
        }
      }
    }
  });

  it("agrees across both daylight-saving shifts of a zone that has them", { timeout: 300_000 }, () => {
    // New York springs forward at 02:00 on 2026-03-08 and falls back at 02:00 on
    // 2026-11-01. A window laid over either shift walks an hour that does not
    // exist, or one that happens twice, and the two walks have to agree there.
    // `30 2 8 3 *` names 02:30 on 8 March, a minute New York never has.
    const starts = [
      Date.UTC(2026, 2, 7, 12, 0, 0), // the day before the spring shift
      Date.UTC(2026, 9, 31, 12, 0, 0), // the day before the autumn shift
    ];
    const crons = [...CRONS, "30 2 8 3 *", "0 1 * * *"];
    for (const lastRun of starts) {
      for (const cron of crons) {
        for (const minutes of [60, 1440]) {
          for (const zone of ZONES) {
            const now = lastRun + minutes * MINUTE + 17_000;
            const wanted = referencePreviousOccurrence(cron, zone, lastRun, now);
            const found = decision(cron, zone, lastRun, now);
            expect({ cron, zone, lastRun, minutes, due: found.due }).toEqual({
              cron,
              zone,
              lastRun,
              minutes,
              due: wanted,
            });
            expect({ cron, zone, lastRun, minutes, fires: found.fires }).toEqual({
              cron,
              zone,
              lastRun,
              minutes,
              fires: wanted !== undefined,
            });
          }
        }
      }
    }
  });

  it("agrees over the forty day window the old walk was capped at", { timeout: 300_000 }, () => {
    const lastRun = Date.UTC(2026, 8, 20, 3, 20, 0);
    const now = lastRun + 40 * 24 * 60 * MINUTE + 17_000;
    for (const cron of ["0 6 * * *", "0 8 * * 1", "30 2 1 * *"] as const) {
      for (const zone of ZONES) {
        const wanted = referencePreviousOccurrence(cron, zone, lastRun, now);
        const found = decision(cron, zone, lastRun, now);
        expect({ cron, zone, due: found.due, fires: found.fires }).toEqual({
          cron,
          zone,
          due: wanted,
          fires: wanted !== undefined,
        });
      }
    }
  });

  it("steps over days and hours without passing a match a plain walk would find", { timeout: 300_000 }, () => {
    // The skip is what makes the remembered value cheap, so it is measured
    // against the plain minute-by-minute walk from the same start: the first
    // match has to be the same instant. The horizon covers the longest gap in
    // this set, a weekly expression eight days out.
    const starts = [
      Date.UTC(2026, 2, 7, 6, 30, 0), // before the spring shift in New York
      Date.UTC(2026, 9, 31, 6, 30, 0), // before the autumn shift in New York
      Date.UTC(2026, 9, 12, 7, 41, 0),
    ];
    for (const cron of ["0 6 * * *", "0 8 * * 1", "5 8 * * 1", "*/15 * * * *"] as const) {
      for (const zone of ZONES) {
        for (const start of starts) {
          expect({ cron, zone, start, next: nextOccurrence(cron, zone, start) }).toEqual({
            cron,
            zone,
            start,
            next: referenceNextOccurrence(cron, zone, start, 8 * 24 * 60),
          });
        }
      }
    }
    // The monthly expression needs a month of walking to be answered at all.
    for (const zone of ZONES) {
      expect(nextOccurrence("30 2 1 * *", zone, starts[2])).toBe(
        referenceNextOccurrence("30 2 1 * *", zone, starts[2], 40 * 24 * 60),
      );
    }
    // One long range too, because a skip that is one day too long only shows up
    // when the next match is far away: February 29 is not before 2027, and the
    // remembered value has to be the same minute the walk finds.
    const start = Date.UTC(2026, 0, 2, 4, 0, 0);
    expect(nextOccurrence("0 0 29 2 *", "UTC", start)).toBe(
      referenceNextOccurrence("0 0 29 2 *", "UTC", start, 400 * 24 * 60),
    );
  });
});

describe("the scheduler checks six routines without walking their windows", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** The context the scheduler reads its config, jobs and storage through. */
  function extensionContext(h: TestHarness): ExtensionContext {
    const runtime = h.runtime;
    return {
      getConfig: () => runtime.getConfig(),
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      harness: runtime.harness,
      jobs: runtime.jobs,
      archive: runtime.archive,
      reports: runtime.reports,
    } as unknown as ExtensionContext;
  }

  const base: JobRoutineSpec = {
    cron: "0 6 * * *",
    timezone: "Asia/Tokyo",
    catchUp: "skip",
    overlap: "skip",
    prompt: "check the log",
    vmodel: "faux",
    enabled: true,
  };

  function answers(count = 8): ReturnType<typeof fauxAssistantMessage>[] {
    return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
  }

  /** The six routines the daemon ran, and how long before the measurement each last ran. */
  const LIVE_ROUTINES: readonly (readonly [string, number])[] = [
    ["0 6 * * *", 785],
    ["0 10 * * *", 545],
    ["0 8 * * 1", 9305],
    ["0 10 * * *", 545],
    ["0 9 * * *", 605],
    ["5 8 * * 1", 9300],
  ];

  /**
   * A harness holding those six routines, each with a last run that many minutes
   * before `nowMs`, and nothing due at `nowMs`: the state a daemon was in
   * when a block of seconds was measured.
   */
  async function sixRoutines(nowMs: number): Promise<TestHarness> {
    harness = await createTestHarness({ responses: answers() });
    const context = extensionContext(harness);
    for (const [index, [cron, ageMinutes]] of LIVE_ROUTINES.entries()) {
      const job = await harness.runtime.jobs.create(ctx, { title: `routine ${index + 1} ${cron}` });
      await writeRoutine(context, job.id, { ...base, cron });
      const record = (await harness.runtime.jobs.get(ctx, job.id))!;
      await harness.runtime.jobs.writeAll(ctx, [
        { ...record, lastRun: { at: nowMs - ageMinutes * MINUTE, status: "success" } },
      ]);
    }
    return harness;
  }

  it("takes a few milliseconds for the first pass and almost none for the second", { timeout: 300_000 }, async () => {
    // A fixed instant, 19:05 at +09:00.
    const nowMs = Date.UTC(2026, 9, 25, 10, 5, 0);
    const h = await sixRoutines(nowMs);
    const context = extensionContext(h);

    // Three fresh schedulers, so every first pass is a real first pass: the
    // remembered values live in the instance and nowhere else. The host is shared
    // and busy, so what is reported is the smallest of the three; a threshold on
    // an average would measure the load of the machine as much as the code.
    const first: number[] = [];
    const second: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scheduler = new Scheduler({ context });
      await scheduler.ready();
      const started = performance.now();
      await scheduler.tick(nowMs);
      const remembered = performance.now();
      await scheduler.tick(nowMs);
      const again = performance.now();
      first.push(remembered - started);
      second.push(again - remembered);
    }
    const firstMs = Math.min(...first);
    const secondMs = Math.min(...second);
    // Printed so the numbers in the report come from a run and not from an
    // estimate: `first` is the pass that computes the six next occurrences,
    // `second` is the pass that finds them remembered.
    console.log(
      `[tick-cost] first=${firstMs.toFixed(1)}ms second=${secondMs.toFixed(1)}ms ` +
        `(first of 3: ${first.map((value) => value.toFixed(1)).join(", ")}; ` +
        `second of 3: ${second.map((value) => value.toFixed(1)).join(", ")})`,
    );
    expect(firstMs).toBeLessThanOrEqual(300);
    expect(secondMs).toBeLessThanOrEqual(5);
  });

  it("fires the routine whose minute comes, and labels the run with that minute", { timeout: 300_000 }, async () => {
    harness = await createTestHarness({ responses: answers() });
    const context = extensionContext(harness);
    const job = await harness.runtime.jobs.create(ctx, { title: "every minute" });
    await writeRoutine(context, job.id, { ...base, cron: "* * * * *", timezone: "UTC" });

    const notices: { code?: string; conversationId?: number }[] = [];
    harness.events.subscribe((event) => {
      if (event.type === "notice") notices.push(event.data as { code?: string; conversationId?: number });
    });

    // A tick thirty seconds into a minute, with the last run a minute and a half
    // before it: one occurrence is inside the window, and it is that minute.
    const tickAt = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000;
    const record = (await harness.runtime.jobs.get(ctx, job.id))!;
    await harness.runtime.jobs.writeAll(ctx, [
      { ...record, lastRun: { at: tickAt - 90_000, status: "success" } },
    ]);

    await harness.runtime.scheduler.tick(tickAt);
    const dispatched = await until(
      () => notices.find((notice) => notice.code === "scheduler_dispatch"),
      "the scheduled run to be dispatched",
    );
    const conversation = await harness.runtime.harness.conversation(
      dispatched.conversationId as ConversationId,
      ctx as Context,
    );
    const text = await until(async () => (await userTexts(conversation!))[0], "the scheduled prompt to be stored");
    const parsed = readMessage(text);
    const occurred = Number(parsed?.["attrs"]["occurrence"]);
    // The label is the occurrence the reconciler chose, and it is the minute the
    // old walk returns for this window.
    expect(occurred).toBe(referencePreviousOccurrence("* * * * *", "UTC", tickAt - 90_000, tickAt));
    expect(occurred).toBe(tickAt - 30_000);
    expect((await harness.runtime.jobs.get(ctx, job.id))?.stats.runs).toBe(1);
  });

  it("computes again when the expression is edited, and does not fire twice for one window", { timeout: 300_000 }, async () => {
    harness = await createTestHarness({ responses: answers() });
    const context = extensionContext(harness);
    // A time in the past, so that the run a firing tick records — stamped with the
    // real clock — is after the ticks that follow it and cannot make them due.
    const nowMs = Date.UTC(2026, 5, 15, 12, 0, 30);
    const job = await harness.runtime.jobs.create(ctx, { title: "nightly" });
    await writeRoutine(context, job.id, { cron: "0 6 * * *", timezone: "UTC", prompt: "check", vmodel: "faux" });
    const record = (await harness.runtime.jobs.get(ctx, job.id))!;
    await harness.runtime.jobs.writeAll(ctx, [{ ...record, lastRun: { at: nowMs - 180 * MINUTE, status: "success" } }]);
    const notices: { code?: string }[] = [];
    harness.events.subscribe((event) => {
      if (event.type === "notice") notices.push(event.data as { code?: string });
    });
    const dispatches = (): number => notices.filter((notice) => notice.code === "scheduler_dispatch").length;

    // Tomorrow at six: the remembered value says nothing is due, and nothing is.
    await harness.runtime.scheduler.tick(nowMs);
    expect(dispatches()).toBe(0);
    expect((await harness.runtime.jobs.get(ctx, job.id))?.stats.runs).toBe(0);

    // The record now says every minute. The remembered value was computed from the
    // daily expression, so it must not be used for this one.
    await writeRoutine(context, job.id, { cron: "* * * * *", timezone: "UTC", prompt: "check", vmodel: "faux" });
    await harness.runtime.scheduler.tick(nowMs + 30_000);
    expect(dispatches()).toBe(1);
    expect((await harness.runtime.jobs.get(ctx, job.id))?.stats.runs).toBe(1);

    // The same tick again: the run it recorded moved the window start, and one
    // occurrence is one run.
    await harness.runtime.scheduler.tick(nowMs + 30_000);
    expect(dispatches()).toBe(1);
    expect((await harness.runtime.jobs.get(ctx, job.id))?.stats.runs).toBe(1);
  });

  it("computes again when the recorded run moves, and skips the occurrence it missed", { timeout: 300_000 }, async () => {
    harness = await createTestHarness({ responses: answers() });
    const context = extensionContext(harness);
    const nowMs = Date.UTC(2026, 5, 15, 12, 0, 30);
    const job = await harness.runtime.jobs.create(ctx, { title: "nightly" });
    await writeRoutine(context, job.id, { cron: "0 6 * * *", timezone: "UTC", prompt: "check", vmodel: "faux" });
    const record = (await harness.runtime.jobs.get(ctx, job.id))!;
    await harness.runtime.jobs.writeAll(ctx, [{ ...record, lastRun: { at: nowMs - 180 * MINUTE, status: "success" } }]);
    const notices: { code?: string }[] = [];
    harness.events.subscribe((event) => {
      if (event.type === "notice") notices.push(event.data as { code?: string });
    });

    await harness.runtime.scheduler.tick(nowMs);
    expect(notices.filter((notice) => notice.code === "scheduler_dispatch")).toHaveLength(0);

    // The recorded run moves back a day, so six this morning came after it and is
    // more than the late window past. That is a skipped occurrence, and it is the
    // old rule that says so: the catch-up rule is `skip`.
    const moved = (await harness.runtime.jobs.get(ctx, job.id))!;
    await harness.runtime.jobs.writeAll(ctx, [
      { ...moved, lastRun: { at: nowMs - 24 * 60 * MINUTE - 30_000, status: "success" } },
    ]);
    await harness.runtime.scheduler.tick(nowMs);
    const skipped = await harness.runtime.jobs.get(ctx, job.id);
    expect(notices.filter((notice) => notice.code === "scheduler_dispatch")).toHaveLength(0);
    expect(skipped?.stats.runs).toBe(1);
    expect(skipped?.lastRun?.status).toBe("failure");
    expect(skipped?.lastRun?.summary).toContain("missed occurrence skipped");
  });
});

/** The text of one entry, whichever shape its content takes. */
function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: string }).text ?? "")
            : "",
        )
        .join("");
    })
    .join("\n");
}

/** Every user-role entry's text, oldest first. */
async function userTexts(conversation: Conversation): Promise<string[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, ctx);
  return page.items.filter((entry) => entry.kind === "pi.user").map(entryText);
}

async function until<T>(check: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
