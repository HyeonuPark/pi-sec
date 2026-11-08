import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { nextSweepAt, type ArchivistTimers } from "../src/jobs/archive.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus } from "../src/runtime/event-bus.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { openPrivateSqliteStorage } from "../src/runtime/sqlite-file.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";

/**
 * When the archive sweep runs.
 *
 * The sweep is housekeeping, so its schedule is a time of day rather than an
 * interval: once a day at `archive.sweepAt`, in the harness zone, and not at
 * boot. A daemon that was down at that time skips the day. These tests drive the
 * clock and the timer themselves; none of them waits for a real one.
 */

const TOKYO = "Asia/Tokyo";
/** 2026-10-31 12:00 in Tokyo, a Saturday. */
const NOON = Date.parse("2026-10-31T12:00:00+09:00");

function tokyo(iso: string): number {
  return Date.parse(iso);
}

describe("nextSweepAt", () => {
  it("finds today's time when the clock is behind it", () => {
    const at = nextSweepAt(tokyo("2026-10-31T04:59:00+09:00"), "05:00", TOKYO);
    expect(at).toBe(tokyo("2026-10-31T05:00:00+09:00"));
  });

  it("answers the next day when the clock stands exactly on the time", () => {
    // Strictly after `now`: a timer re-armed at the instant it fired must not fire
    // again at once, and a restart inside the same second must not sweep twice.
    const at = nextSweepAt(tokyo("2026-10-31T05:00:00+09:00"), "05:00", TOKYO);
    expect(at).toBe(tokyo("2026-11-01T05:00:00+09:00"));
  });

  it("moves to tomorrow when today's time has passed", () => {
    const at = nextSweepAt(tokyo("2026-10-31T05:00:01+09:00"), "05:00", TOKYO);
    expect(at).toBe(tokyo("2026-11-01T05:00:00+09:00"));
  });

  it("crosses midnight for a time of day that is still before the clock", () => {
    // 23:30 now, 00:15 wanted: the answer is 45 minutes away, on the next date.
    const at = nextSweepAt(tokyo("2026-10-31T23:30:00+09:00"), "00:15", TOKYO);
    expect(at).toBe(tokyo("2026-11-01T00:15:00+09:00"));
    expect(at - tokyo("2026-10-31T23:30:00+09:00")).toBe(45 * 60 * 1000);
  });

  it("reads the time of day in the zone it is given, not in UTC", () => {
    // 05:00 in Tokyo is 20:00 UTC on the day before, so a UTC reading of this
    // instant would answer eight hours away from the one the user set.
    const at = nextSweepAt(tokyo("2026-10-31T12:00:00+09:00"), "05:00", TOKYO);
    expect(at).toBe(tokyo("2026-11-01T05:00:00+09:00"));
    // The same instant read in UTC is 03:00, so that clock is still before its
    // 05:00 and answers later the same day: 05:00Z, which is 14:00 in Tokyo.
    const utc = nextSweepAt(tokyo("2026-10-31T12:00:00+09:00"), "05:00", "UTC");
    expect(utc).toBe(tokyo("2026-10-31T14:00:00+09:00"));
  });

  it("keeps the wall-clock time across a summer-time shift", () => {
    // New York moves to summer time on 2027-03-14, so the day before is 23 hours
    // long. A fixed 24-hour step would sweep at 06:00 local time from then on.
    const at = nextSweepAt(Date.parse("2027-03-13T12:00:00-05:00"), "05:00", "America/New_York");
    expect(at).toBe(Date.parse("2027-03-14T05:00:00-04:00"));
    const after = nextSweepAt(at, "05:00", "America/New_York");
    expect(after).toBe(Date.parse("2027-03-15T05:00:00-04:00"));
    expect(after - at).toBe(24 * 60 * 60 * 1000);
  });

  it("refuses a value that is not a time of day", () => {
    expect(() => nextSweepAt(NOON, "5:00", TOKYO)).toThrow(/HH:MM/);
    expect(() => nextSweepAt(NOON, "24:00", TOKYO)).toThrow(/time of day/);
  });
});

/** A clock and a timer a test drives: nothing fires until `advance` says so. */
class FakeTimers implements ArchivistTimers {
  now = NOON;
  readonly armed: { dueAt: number; fired: boolean }[] = [];
  private callbacks: (() => void)[] = [];

  set(callback: () => void, delayMs: number): { cancel(): void } {
    const entry = { dueAt: this.now + delayMs, fired: false };
    this.armed.push(entry);
    this.callbacks.push(callback);
    const index = this.callbacks.length - 1;
    return {
      cancel: () => {
        this.callbacks[index] = () => undefined;
      },
    };
  }

  /** Move the clock to `at` and fire every timer that is due by then, in order. */
  async advanceTo(at: number): Promise<void> {
    this.now = at;
    for (let index = 0; index < this.armed.length; index += 1) {
      const entry = this.armed[index]!;
      const callback = this.callbacks[index]!;
      if (entry.fired || entry.dueAt > at) continue;
      entry.fired = true;
      callback();
      // The run is asynchronous; let it finish before the next timer is examined.
      await settle();
    }
  }
}

/** Give the runtime's own promises a turn, without a timer of the test's own. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

interface Booted {
  readonly runtime: AgentRuntime;
  readonly paths: Paths;
  readonly home: string;
  readonly log: () => Promise<string>;
}

/**
 * Boot a runtime with the sweep's clock and timer injected.
 *
 * `storage` names the files a second boot reopens: an in-memory store is closed
 * with its runtime, so a restart cannot be checked over one. The default is
 * in-memory, because one boot is all most of these tests do.
 */
async function boot(options: {
  readonly storage?: MemoryStorage;
  readonly archiveStorage?: MemoryStorage;
  readonly config?: Partial<Config>;
  readonly timers?: FakeTimers;
  readonly home?: string;
}): Promise<Booted> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "pi-sec-archive-")));
  const paths = buildPaths(home);
  await ensureLayout(paths);
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "faux.md"), "", "utf8");

  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("ok")])));
  const base = defaultConfig();
  const config: Config = {
    ...base,
    timezone: TOKYO,
    ...(options.config ?? {}),
    attachments: { dir: join(home, "attachments"), shareDir: join(home, "share") },
    vmodels: { faux: { provider: "faux", modelId: faux.getModel().id, thinkingLevel: "medium", prompt: "faux" } },
    agent: { ...base.agent, vmodel: "faux", roles: [] },
    code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
  };
  const secrets = new SecretRegistry({ dir: paths.secretsDir, includeModelCredentials: false });
  await secrets.load();
  const logger = createLogger({ console: false, file: paths.appLog });
  const audit = createAuditLog({ file: paths.auditLog, redactor: () => secrets.redactor() });
  const events = createEventBus();

  const runtime = await createAgentRuntime({
    paths,
    config,
    storage: options.storage ?? (await openPrivateSqliteStorage(paths.stateDb)),
    archiveStorage: options.archiveStorage ?? (await openPrivateSqliteStorage(paths.archiveDb)),
    models,
    secrets,
    logger,
    audit,
    events: events.sink,
    loadExtensions: true,
    watchExtensions: false,
    prepareRoot: false,
    ...(options.timers === undefined ? {} : { archiveClock: () => options.timers!.now, archiveTimers: options.timers }),
  });

  return {
    runtime,
    paths,
    home,
    log: async () => {
      try {
        return await readFile(paths.appLog, "utf8");
      } catch {
        return "";
      }
    },
  };
}

function sweepLines(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { level: string; message: string; [key: string]: unknown })
    .filter((entry) => entry.message === "archive sweep")
    .map((entry) => JSON.stringify(entry));
}

describe("archive.sweepAt in the config", () => {
  /** Load a config file that names one `archive` object, as an install would. */
  async function load(archive: unknown): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-archive-config-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ archive }), "utf8");
    return await loadConfig({ home, env: {} });
  }

  it("defaults to 05:00 when the file names no archive key", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-archive-config-"));
    const loaded = await loadConfig({ home, env: {} });
    expect(loaded.config.archive.sweepAt).toBe("05:00");
    expect(loaded.config.archive.sweepMs).toBeUndefined();
  });

  it("refuses a time of day the schema cannot read", async () => {
    // The control first: the same shape with a good time loads. Without it a
    // refusal could come from anything else in the object.
    const good = await load({ enabled: true, afterDays: 3, sweepAt: "05:30" });
    expect(good.config.archive.sweepAt).toBe("05:30");

    const error = await load({ enabled: true, afterDays: 3, sweepAt: "5:00" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join("\n")).toContain("/archive/sweepAt");
    const late = await load({ enabled: true, afterDays: 3, sweepAt: "24:00" }).catch((thrown: unknown) => thrown);
    expect(late).toBeInstanceOf(ConfigError);
  });

  it("still loads a file that carries the old interval key", async () => {
    // Refusing it would stop the boot of every install that copied an older
    // default, so it is accepted and warned about instead.
    const loaded = await load({
      enabled: true,
      afterDays: 3,
      sweepAt: "06:30",
      sweepMs: 3_600_000,
    } as Partial<Config["archive"]>);
    expect(loaded.config.archive.sweepAt).toBe("06:30");
    expect(loaded.config.archive.sweepMs).toBe(3_600_000);
  });
});

describe("the daily archive sweep", () => {
  it("runs at the set time and arms the next day rather than an interval", async () => {
    const timers = new FakeTimers();
    const booted = await boot({ timers });
    try {
      // One timer, and it points at the next 05:00 in Tokyo, not at an hour later.
      expect(timers.armed).toHaveLength(1);
      expect(timers.armed[0]!.dueAt).toBe(tokyo("2026-11-01T05:00:00+09:00"));

      await timers.advanceTo(tokyo("2026-11-01T05:00:00+09:00"));
      // One sweep, and one line in the daemon log, even though nothing was moved.
      expect(sweepLines(await booted.log())).toHaveLength(1);
      expect(timers.armed).toHaveLength(2);
      expect(timers.armed[1]!.dueAt).toBe(tokyo("2026-11-02T05:00:00+09:00"));

      await timers.advanceTo(tokyo("2026-11-02T05:00:00+09:00"));
      expect(sweepLines(await booted.log())).toHaveLength(2);
      expect(timers.armed[2]!.dueAt).toBe(tokyo("2026-11-03T05:00:00+09:00"));
    } finally {
      await booted.runtime.close();
      await rm(booted.home, { recursive: true, force: true });
    }
  });

  it("does not sweep at boot, and skips a day it was down for", async () => {
    // The stores live in this harness's home, so the second boot finds the job the
    // old code would have moved at once.
    const config: Partial<Config> = { archive: { enabled: true, afterDays: 0, sweepAt: "05:00" } };
    const first = await boot({ config, timers: new FakeTimers() });
    let jobId: string;
    try {
      const job = await first.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "finished long ago" });
      await first.runtime.jobs.update(BACKGROUND_CONTEXT, job.id, { status: "done" });
      jobId = job.id;
    } finally {
      await first.runtime.close();
    }

    // The daemon comes back at 12:00, long after that day's 05:00.
    const timers = new FakeTimers();
    const second = await boot({ config, timers, home: first.home });
    try {
      expect(await second.runtime.jobs.get(BACKGROUND_CONTEXT, jobId)).toBeDefined();
      expect(await second.runtime.archive.get(BACKGROUND_CONTEXT, jobId)).toBeUndefined();
      expect(sweepLines(await second.log())).toHaveLength(0);
      // The missed 05:00 is not made up: the next one is tomorrow's.
      expect(timers.armed[0]!.dueAt).toBe(tokyo("2026-11-01T05:00:00+09:00"));

      await timers.advanceTo(tokyo("2026-11-01T05:00:00+09:00"));
      expect(await second.runtime.jobs.get(BACKGROUND_CONTEXT, jobId)).toBeUndefined();
      expect((await second.runtime.archive.get(BACKGROUND_CONTEXT, jobId))?.title).toBe("finished long ago");
      expect(sweepLines(await second.log())).toHaveLength(1);
    } finally {
      await second.runtime.close();
      await rm(second.home, { recursive: true, force: true });
    }
  });

  it("logs one line per sweep, with the counts, when it moved nothing", async () => {
    const booted = await boot({
      config: { archive: { enabled: true, afterDays: 3, sweepAt: "05:00" } },
      timers: new FakeTimers(),
    });
    try {
      await booted.runtime.archivist.run();
      const lines = sweepLines(await booted.log());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"level":"info"');
      expect(lines[0]).toContain('"archived":0');
    } finally {
      await booted.runtime.close();
      await rm(booted.home, { recursive: true, force: true });
    }
  });

  it("warns once when the old interval key is still in the config", async () => {
    const withKey = await boot({
      config: {
        // The key is optional in the schema, so an older file still loads.
        archive: { enabled: true, afterDays: 3, sweepAt: "05:00", sweepMs: 3_600_000 },
      } as Partial<Config>,
      timers: new FakeTimers(),
    });
    try {
      const log = await withKey.log();
      const warnings = log
        .split("\n")
        .filter((line) => line.includes('"level":"warn"') && line.includes("archive.sweepMs"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ignored");
      // It also still boots and arms the daily timer, so the key is a warning and
      // not a refusal.
      expect(withKey.runtime.archivist.nextAt()).toBe(tokyo("2026-11-01T05:00:00+09:00"));
    } finally {
      await withKey.runtime.close();
      await rm(withKey.home, { recursive: true, force: true });
    }

    const without = await boot({ timers: new FakeTimers() });
    try {
      expect((await without.log()).includes("archive.sweepMs")).toBe(false);
    } finally {
      await without.runtime.close();
      await rm(without.home, { recursive: true, force: true });
    }
  });
});
