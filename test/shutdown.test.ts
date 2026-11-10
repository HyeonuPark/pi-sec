import { describe, expect, it } from "vitest";
import {
  EXIT_FALLBACK_MS,
  SHUTDOWN_DEADLINE_MS,
  runShutdown,
  type ShutdownLog,
  type ShutdownStep,
  type ShutdownTimers,
} from "../src/runtime/shutdown.ts";

/** A clock the test moves by hand: timers fire when `advance` passes their time. */
function fakeClock(): ShutdownTimers & { advance(ms: number): Promise<void>; pending(): number } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    pending: () => timers.size,
    advance: async (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
      // Let the continuations of the promises the timer settled run.
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    },
  };
}

function recorder(): ShutdownLog & { lines: { level: string; message: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (message, fields) => void lines.push({ level: "info", message, ...(fields === undefined ? {} : { fields }) }),
    error: (message, fields) => void lines.push({ level: "error", message, ...(fields === undefined ? {} : { fields }) }),
  };
}

const done = (name: string, text: string): ShutdownStep => ({ name, run: async () => undefined, done: text });

describe("the shutdown sequence", () => {
  it("ends the process with the chosen code and names the pending step when the deadline passes", async () => {
    const clock = fakeClock();
    const log = recorder();
    const exits: number[] = [];
    const order: string[] = [];
    const result = runShutdown({
      code: 75,
      log,
      timers: clock,
      exit: (code) => void exits.push(code),
      steps: [
        done("server", "server closed"),
        { name: "runtime", run: () => new Promise<void>(() => undefined), done: "runtime closed" },
      ],
      release: async () => void order.push("released"),
    });
    await clock.advance(SHUTDOWN_DEADLINE_MS - 1);
    expect(exits).toEqual([]);
    await clock.advance(1);
    expect(await result).toBe(75);
    expect(exits).toEqual([75]);
    // The pid file and the lock are given back before the process ends.
    expect(order).toEqual(["released"]);
    expect(log.lines.map((line) => line.message)).toEqual(["server closed", "shutdown deadline passed"]);
    expect(log.lines[1]?.fields).toMatchObject({ step: "runtime", code: 75 });
  });

  it("names the first step when it is the one that never ends, and exits with 0 for a signal", async () => {
    const clock = fakeClock();
    const log = recorder();
    const exits: number[] = [];
    const result = runShutdown({
      code: 0,
      log,
      timers: clock,
      exit: (code) => void exits.push(code),
      steps: [{ name: "server", run: () => new Promise<void>(() => undefined), done: "server closed" }, done("runtime", "runtime closed")],
      release: async () => undefined,
    });
    await clock.advance(SHUTDOWN_DEADLINE_MS);
    await result;
    expect(exits).toEqual([0]);
    expect(log.lines[0]).toMatchObject({ message: "shutdown deadline passed", fields: { step: "server", code: 0 } });
  });

  it("logs each step and the end, and leaves the exit to the fallback timer when the steps finish in time", async () => {
    const clock = fakeClock();
    const log = recorder();
    const exits: number[] = [];
    const result = await runShutdown({
      code: 75,
      log,
      timers: clock,
      exit: (code) => void exits.push(code),
      steps: [done("server", "server closed"), done("runtime", "runtime closed")],
      release: async () => undefined,
    });
    expect(result).toBe(75);
    expect(log.lines.map((line) => line.message)).toEqual(["server closed", "runtime closed", "pi-sec stopped"]);
    expect(log.lines[2]?.fields).toEqual({ code: 75 });
    // The deadline timer is cleared, and only the exit fallback is left.
    expect(clock.pending()).toBe(1);
    expect(exits).toEqual([]);
    await clock.advance(EXIT_FALLBACK_MS);
    expect(exits).toEqual([75]);
  });

  it("goes on to the next step and the release when a step throws", async () => {
    const clock = fakeClock();
    const log = recorder();
    const order: string[] = [];
    await runShutdown({
      code: 0,
      log,
      timers: clock,
      exit: () => undefined,
      steps: [
        {
          name: "server",
          run: async () => {
            throw new Error("boom");
          },
          done: "server closed",
        },
        { name: "runtime", run: async () => void order.push("runtime"), done: "runtime closed" },
      ],
      release: async () => void order.push("released"),
    });
    expect(order).toEqual(["runtime", "released"]);
    expect(log.lines.map((line) => line.message)).toEqual(["shutdown error", "runtime closed", "pi-sec stopped"]);
  });

  it("ends the process at the deadline when the release never ends after the steps", async () => {
    const clock = fakeClock();
    const log = recorder();
    const exits: number[] = [];
    const result = runShutdown({
      code: 75,
      log,
      timers: clock,
      exit: (code) => void exits.push(code),
      steps: [done("server", "server closed")],
      release: () => new Promise<void>(() => undefined),
    });
    await clock.advance(SHUTDOWN_DEADLINE_MS - 1);
    expect(exits).toEqual([]);
    await clock.advance(1);
    expect(await result).toBe(75);
    expect(exits).toEqual([75]);
    expect(log.lines.map((line) => line.message)).toEqual(["server closed", "shutdown deadline passed"]);
    expect(log.lines[1]?.fields).toMatchObject({ step: "release", code: 75 });
    await clock.advance(EXIT_FALLBACK_MS);
    expect(exits).toEqual([75]);
  });

  it("ends the process when the release never ends after the deadline passed", async () => {
    const clock = fakeClock();
    const log = recorder();
    const exits: number[] = [];
    const result = runShutdown({
      code: 75,
      log,
      timers: clock,
      exit: (code) => void exits.push(code),
      steps: [{ name: "runtime", run: () => new Promise<void>(() => undefined), done: "runtime closed" }],
      release: () => new Promise<void>(() => undefined),
    });
    await clock.advance(SHUTDOWN_DEADLINE_MS);
    expect(exits).toEqual([]);
    await clock.advance(EXIT_FALLBACK_MS);
    expect(await result).toBe(75);
    expect(exits).toEqual([75]);
    expect(log.lines.map((line) => line.message)).toEqual(["shutdown deadline passed", "shutdown release did not end"]);
  });
});
