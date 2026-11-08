/**
 * Jobs, their schedules, and the routine the scheduler reads.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { describe, expect, it, afterEach } from "vitest";
import { cronMatches, parseCron, previousOccurrence, Scheduler } from "../src/extensions/scheduler.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createJobsExtension } from "../src/extensions/jobs.ts";
import { resolveRoutineApproval, JobRegistry } from "../src/jobs/registry.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { defaultConfig } from "../src/config/schema.ts";
import { readMessage } from "../src/message-envelope.ts";
import { createSession, MemoryStorage, type Session, type Storage } from "@earendil-works/pi-durable";
import { SecJob, type JobRecord, type JobRoutineSpec, type JobScheduleSpec, JOB_STATUSES, SecInbox, SecMigration } from "../src/documents.ts";
import { readFile, writeFile } from "node:fs/promises";
import type { Config } from "../src/config/schema.ts";
import { FIRING_JOB_STATUSES, LATE_GRACE_MS, isFiringStatus, parseOnceAt, settleOnce, validateScheduleFields, writeRoutine } from "../src/jobs/routine.ts";
import { LEGACY_LIST_HINT, migrateRoutines, legacyListProblem, readRoutineMigrationState } from "../src/jobs/routine-migration.ts";
import { dayStamp } from "../src/runtime/ids.ts";
import { JOB_ID_DATE_PREFIX, hasDatePrefix, runMigrations } from "../src/runtime/migrations.ts";
import { scanDocumentKeys } from "../src/runtime/storage.ts";

describe("cron.test.ts", () => {
  describe("cron", () => {
    it("matches a fixed time in UTC", () => {
      expect(cronMatches("0 8 * * *", new Date("2026-10-12T08:00:00Z"), "UTC")).toBe(true);
      expect(cronMatches("0 8 * * *", new Date("2026-10-12T08:01:00Z"), "UTC")).toBe(false);
    });

    it("supports steps and lists", () => {
      expect(cronMatches("*/15 * * * *", new Date("2026-10-12T08:15:00Z"), "UTC")).toBe(true);
      expect(cronMatches("*/15 * * * *", new Date("2026-10-12T08:16:00Z"), "UTC")).toBe(false);
      expect(cronMatches("0 8,20 * * *", new Date("2026-10-12T20:00:00Z"), "UTC")).toBe(true);
    });

    it("evaluates day-of-week restrictions", () => {
      // 2026-10-12 is a Monday (weekday 1).
      expect(cronMatches("0 9 * * 1", new Date("2026-10-12T09:00:00Z"), "UTC")).toBe(true);
      expect(cronMatches("0 9 * * 0", new Date("2026-10-12T09:00:00Z"), "UTC")).toBe(false);
    });

    it("finds the previous occurrence", () => {
      const now = Date.parse("2026-10-12T08:30:00Z");
      const after = Date.parse("2026-10-12T07:00:00Z");
      expect(previousOccurrence("0 8 * * *", "UTC", after, now)).toBe(Date.parse("2026-10-12T08:00:00Z"));
    });

    it("rejects malformed expressions", () => {
      expect(() => parseCron("not a cron")).toThrow();
      expect(() => parseCron("0 8 * *")).toThrow();
    });
  });
});

describe("jobs-cancel-descendants.test.ts", () => {
  /**
   * `jobs_cancel` cancels a job and its non-terminal descendants, as its
   * description says and as the user's cancel button does. Finished descendants
   * keep their status. An open descendant that carries a routine refuses the whole
   * call, because closing a routine job needs its own approval.
   */

  const ctx = BACKGROUND_CONTEXT;

  type ToolLike = {
    execute: (
      args: never,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<{ content: readonly { type: string; text?: string }[]; isError?: boolean }>;
  };

  const routine: JobRoutineSpec = { cron: "0 6 * * *", timezone: "UTC", prompt: "run", enabled: true };

  function cancelTool(h: TestHarness): ToolLike {
    const runtime = h.runtime;
    const context = {
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
    const found = createJobsExtension(context).tools?.find((item) => item.name === "jobs_cancel");
    if (found === undefined) throw new Error("jobs_cancel is not registered");
    return found as unknown as ToolLike;
  }

  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: "01JOBSCANCEL00000000000000",
      commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: Context) =>
        h.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  describe("jobs_cancel and descendants", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    async function boot(): Promise<TestHarness> {
      harness = await createTestHarness();
      return harness;
    }

    /** A routine job under `parentId`, written with a real approval. */
    async function routineJob(h: TestHarness, parentId: string, title: string): Promise<string> {
      const planJob = await h.runtime.jobs.create(ctx, { title: `plan for ${title}` });
      const report = await h.runtime.reports.create(ctx, { jobId: planJob.id, title: "Plan", content: "one\n" });
      expect((await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" })).ok).toBe(true);
      const outcome = await resolveRoutineApproval({
        reports: h.runtime.reports,
        context: ctx,
        reportId: report.id,
        gate: { gated: true, reasons: ["creates a job that carries a routine"] },
      });
      if (!outcome.ok) throw new Error(outcome.refusal.message);
      const job = await h.runtime.jobs.create(ctx, { title, parentId, routine, routineApproval: outcome.approval });
      return job.id;
    }

    it("cancels the open descendants, and leaves done, failed and cancelled ones alone", async () => {
      const h = await boot();
      const jobs = h.runtime.jobs;
      const parent = await jobs.create(ctx, { title: "parent" });
      const active = await jobs.create(ctx, { title: "active child", parentId: parent.id });
      await jobs.update(ctx, active.id, { status: "active" });
      const waiting = await jobs.create(ctx, { title: "waiting grandchild", parentId: active.id });
      await jobs.update(ctx, waiting.id, { status: "waiting" });
      const done = await jobs.create(ctx, { title: "done child", parentId: parent.id });
      const doneRecord = await jobs.update(ctx, done.id, { status: "done" });
      const failed = await jobs.create(ctx, { title: "failed child", parentId: parent.id });
      const failedRecord = await jobs.update(ctx, failed.id, { status: "failed" });
      const cancelled = await jobs.create(ctx, { title: "cancelled child", parentId: parent.id });
      const cancelledRecord = await jobs.update(ctx, cancelled.id, { status: "cancelled" });
      // Open work under finished work is still open work.
      const under = await jobs.create(ctx, { title: "planned under done", parentId: done.id });
      const unrelated = await jobs.create(ctx, { title: "unrelated" });

      const result = await cancelTool(h).execute({ id: parent.id } as never, execApi(h), ctx);

      expect(result.isError).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain(`cancelled ${parent.id}`);
      expect(text).toContain("3 non-terminal descendants");
      for (const id of [parent.id, active.id, waiting.id, under.id]) {
        expect((await jobs.get(ctx, id))?.status).toBe("cancelled");
      }
      // Finished descendants keep their status and their completion time.
      expect(await jobs.get(ctx, done.id)).toMatchObject({ status: "done", completedAt: doneRecord.completedAt });
      expect(await jobs.get(ctx, failed.id)).toMatchObject({ status: "failed", completedAt: failedRecord.completedAt });
      expect(await jobs.get(ctx, cancelled.id)).toMatchObject({
        status: "cancelled",
        completedAt: cancelledRecord.completedAt,
        updatedAt: cancelledRecord.updatedAt,
      });
      expect((await jobs.get(ctx, unrelated.id))?.status).toBe("planned");
    });

    it("refuses when an open descendant carries a routine, names it, and changes nothing", async () => {
      const h = await boot();
      const jobs = h.runtime.jobs;
      const parent = await jobs.create(ctx, { title: "parent" });
      const child = await jobs.create(ctx, { title: "plain child", parentId: parent.id });
      const routineId = await routineJob(h, child.id, "nightly digest");

      const result = await cancelTool(h).execute({ id: parent.id } as never, execApi(h), ctx);

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("NOT cancelled");
      expect(text).toContain(routineId);
      expect(text).toContain("nightly digest");
      for (const id of [parent.id, child.id, routineId]) {
        expect((await jobs.get(ctx, id))?.status).toBe("planned");
      }
      const rows = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
        (event) => event.type === "routine_refused",
      );
      expect(rows.map((row) => row.code)).toEqual(["routine_descendant"]);
      expect(rows[0]!.jobId).toBe(parent.id);
    });

    it("does not refuse for a routine descendant that has already finished", async () => {
      const h = await boot();
      const jobs = h.runtime.jobs;
      const parent = await jobs.create(ctx, { title: "parent" });
      const routineId = await routineJob(h, parent.id, "old routine");
      // Closing a routine is gated, so the test writes the finished state the way
      // an approved close would leave it.
      const planJob = await jobs.create(ctx, { title: "close plan" });
      const report = await h.runtime.reports.create(ctx, { jobId: planJob.id, title: "Close", content: "close\n" });
      expect((await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" })).ok).toBe(true);
      const close = await resolveRoutineApproval({
        reports: h.runtime.reports,
        context: ctx,
        reportId: report.id,
        gate: { gated: true, reasons: ["closes a routine"] },
      });
      if (!close.ok) throw new Error(close.refusal.message);
      await jobs.update(ctx, routineId, { status: "done", routineApproval: close.approval });

      const result = await cancelTool(h).execute({ id: parent.id } as never, execApi(h), ctx);

      expect(result.isError).toBeUndefined();
      expect((await jobs.get(ctx, parent.id))?.status).toBe("cancelled");
      expect((await jobs.get(ctx, routineId))?.status).toBe("done");
    });
  });
});

describe("jobs-schedule.test.ts", () => {
  /**
   * A schedule that is accepted and then ignored is worse than one that is
   * refused: the caller reports a reservation that does not exist, and nothing
   * says otherwise until somebody notices the job never ran.
   *
   * So a job record takes no schedule from a tool or a route, and a configured
   * expression is parsed at load rather than at the tick that would have used it.
   * The last test measures what the scheduler does put in the envelope, because
   * the value there names the occurrence and must not be the previous run.
   */

  const ctx = BACKGROUND_CONTEXT;

  /**
   * The jobs extension with no runtime behind it: only the schema is under test.
   *
   * The context carries the config because a line the tools print names a time,
   * and a time is written in the zone the config holds.
   */
  function jobsTools(): ReturnType<typeof createJobsExtension> {
    return createJobsExtension({ getConfig: () => defaultConfig() } as unknown as ExtensionContext);
  }

  function tool(extension: ReturnType<typeof createJobsExtension>, name: string) {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no tool named ${name}`);
    return found;
  }

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

  async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function answers(count = 4): ReturnType<typeof fauxAssistantMessage>[] {
    return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
  }

  describe("jobs_create takes one schedule and refuses a stale key", () => {
    it("declares routine, once and reportId, and still no top-level cron", () => {
      const create = tool(jobsTools(), "jobs_create");
      const schema = create.parameters as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      // `routine` and `once` are the schedule now: the record is the only source
      // of one, so the tool that writes a record is where a schedule arrives. The
      // old top-level keys stay refused, because a `cron` beside a title is the
      // half-set schedule this contract used to forbid.
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        "conversationId",
        "description",
        "labels",
        "memoryAnchors",
        "once",
        "parentId",
        "reportId",
        "routine",
        "stateDir",
        "title",
      ]);
      expect(schema.properties?.["cron"]).toBeUndefined();
      expect(schema.properties?.["timezone"]).toBeUndefined();
      // Without this, a model that still sends `cron` gets `created ...` back and
      // the key is dropped on the floor: the schema validator allows unknown keys
      // by default, which is the silent failure this change exists to remove.
      expect(schema.additionalProperties).toBe(false);
    });

    it("fails a cron argument through the validator the harness uses", () => {
      const create = tool(jobsTools(), "jobs_create");
      let message = "";
      try {
        validateToolArguments(create, { name: "jobs_create", arguments: { title: "nightly", cron: "0 8 * * *" } });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("jobs_create");
      expect(message).toContain("cron");
      // A title alone still passes: the argument list shrank, the tool did not.
      expect(validateToolArguments(create, { name: "jobs_create", arguments: { title: "one-off" } })).toEqual({
        title: "one-off",
      });
    });
  });

  /**
   * Reparenting, which is what puts a routine job under the routine container.
   *
   * The registry stores `parentId` and does not check it, so the tool must: a job
   * that is its own ancestor makes every tree read recurse until the process
   * dies. These cases drive the real tools over a temporary store.
   */
  type ToolLike = {
    name: string;
    execute: (
      args: never,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<{ content: readonly { type: string; text?: string }[] }>;
  };

  function jobsToolset(harness: TestHarness): Map<string, ToolLike> {
    const context = {
      jobs: harness.runtime.jobs,
      archive: harness.runtime.archive,
      harness: harness.runtime.harness,
      audit: harness.runtime.audit,
      events: harness.events.sink,
      getConfig: () => harness.runtime.getConfig(),
    } as unknown as ExtensionContext;
    const extension = createJobsExtension(context);
    return new Map((extension.tools ?? []).map((found) => [found.name, found as unknown as ToolLike]));
  }

  function execApi(harness: TestHarness): ToolExecutionApi {
    return {
      conversationId: "01JOBREPARENT00000000000000",
      commit: (change: Parameters<typeof harness.runtime.harness.commit>[0], context: Context) =>
        harness.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  /** The job id that a `created ...` line names. */
  function madeJobId(result: { content: readonly { type: string; text?: string }[] }): string {
    const match = /(\S+) \[/.exec(textOf(result));
    if (match?.[1] === undefined) throw new Error(`no job id in: ${textOf(result)}`);
    return match[1];
  }

  describe("jobs_update reparents a job", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    /** A temporary store with the jobs tools over it, and two jobs under a parent. */
    async function twoJobs(): Promise<{
      h: TestHarness;
      tools: Map<string, ToolLike>;
      api: ToolExecutionApi;
      parent: string;
      child: string;
    }> {
      const h = await createTestHarness();
      harness = h;
      const tools = jobsToolset(h);
      const api = execApi(h);
      const create = tools.get("jobs_create");
      if (create === undefined) throw new Error("no jobs_create tool");
      const parent = madeJobId(await create.execute({ title: "routine" } as never, api, ctx));
      const child = madeJobId(await create.execute({ title: "routine child" } as never, api, ctx));
      return { h, tools, api, parent, child };
    }

    async function recordOf(tools: Map<string, ToolLike>, api: ToolExecutionApi, id: string): Promise<Record<string, unknown>> {
      const get = tools.get("jobs_get");
      if (get === undefined) throw new Error("no jobs_get tool");
      return JSON.parse(textOf(await get.execute({ id } as never, api, ctx))) as Record<string, unknown>;
    }

    it("moves a job under another job", async () => {
      const { tools, api, parent, child } = await twoJobs();
      const update = tools.get("jobs_update");
      if (update === undefined) throw new Error("no jobs_update tool");

      const updated = textOf(await update.execute({ id: child, parentId: parent } as never, api, ctx));
      expect(updated).toContain(`parent=${parent}`);

      expect((await recordOf(tools, api, child))["parentId"]).toBe(parent);
      expect((await recordOf(tools, api, parent))["subjobs"]).toEqual([child]);
    });

    it("clears the parent with null", async () => {
      const { tools, api, parent, child } = await twoJobs();
      const update = tools.get("jobs_update");
      if (update === undefined) throw new Error("no jobs_update tool");
      await update.execute({ id: child, parentId: parent } as never, api, ctx);

      await update.execute({ id: child, parentId: null } as never, api, ctx);

      const cleared = await recordOf(tools, api, child);
      expect(cleared["parentId"]).toBeUndefined();
      expect((await recordOf(tools, api, parent))["subjobs"]).toEqual([]);
    });

    it("refuses a parent that would close a loop, and leaves the record alone", async () => {
      const { tools, api, parent, child } = await twoJobs();
      const update = tools.get("jobs_update");
      if (update === undefined) throw new Error("no jobs_update tool");
      await update.execute({ id: child, parentId: parent } as never, api, ctx);
      const before = await recordOf(tools, api, parent);

      await expect(update.execute({ id: parent, parentId: parent } as never, api, ctx)).rejects.toThrow(
        /own parent/,
      );
      await expect(update.execute({ id: parent, parentId: child } as never, api, ctx)).rejects.toThrow(
        /descendant/,
      );
      await expect(
        update.execute({ id: child, parentId: "01NOSUCHJOB000000000000000" } as never, api, ctx),
      ).rejects.toThrow(/parent job not found/);

      // A refusal that still wrote would be the worst of both: an error the caller
      // retries against a tree that already moved.
      const after = await recordOf(tools, api, parent);
      expect(after).toEqual(before);
      expect((await recordOf(tools, api, child))["parentId"]).toBe(parent);
    });
  });

  describe("the scheduler's occurrence label", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    it("carries the due minute, not the previous run", async () => {
      const tickAt = Date.UTC(2026, 0, 1, 12, 0, 30);
      const due = Date.UTC(2026, 0, 1, 12, 0, 0);
      harness = await createTestHarness({
        responses: answers(),
        config: {
          scheduler: {
            enabled: true,
            tickMs: 30_000,
            timezone: "UTC",
            jobs: [{ name: "nightly", schedule: "* * * * *", timezone: "UTC", catchUp: "skip", overlap: "skip", prompt: "check the log", vmodel: "faux" }],
          },
        },
      });
      const notices: { code?: string; conversationId?: number }[] = [];
      harness.events.subscribe((event) => {
        if (event.type === "notice") notices.push(event.data as { code?: string; conversationId?: number });
      });

      await harness.runtime.scheduler.tick(tickAt);

      const dispatched = await until(async () => {
        const found = notices.find((notice) => notice.code === "scheduler_dispatch");
        return found?.conversationId === undefined ? undefined : found;
      }, "the scheduled run to be dispatched");
      const conversation = await harness.runtime.harness.conversation(
        dispatched.conversationId as ConversationId,
        ctx as Context,
      );
      expect(conversation).toBeDefined();
      const text = await until(async () => (await userTexts(conversation!))[0], "the scheduled prompt to be stored");
      const parsed = readMessage(text);

      // The measurement, printed once: what the run says about itself. The first
      // run of a fresh job has no previous run at all, so the old expression
      // (`record.lastRun?.at ?? 0`) would put `0` here.
      console.log(
        `[occurrence] tick=${new Date(tickAt).toISOString()} due=${new Date(due).toISOString()} ` +
          `occurrence=${parsed?.attrs["occurrence"]} job=${parsed?.attrs["job"]}`,
      );
      expect(parsed?.source).toBe("operator-scheduled");
      expect(parsed?.attrs["job"]).toBe("nightly");
      expect(Number(parsed?.attrs["occurrence"])).toBe(due);
      expect(Number(parsed?.attrs["occurrence"])).not.toBe(0);
    });
  });
});

describe("registry-schedule-copy.test.ts", () => {
  /**
   * `schedule` is the dead half of the old record shape: the schedule a job fires
   * on is its `routine` or `once`, and nothing reads the copy. A move used to
   * carry it anyway, which is how a stale field outlived its reader.
   *
   * Two things have to hold and they pull in opposite directions. A write must not
   * put the copy back, including when the target document already holds one. A read
   * must still accept a record written before this changed, because those records
   * are in the archive and nothing rewrites them.
   */

  const ctx = BACKGROUND_CONTEXT;
  const NOW = 1_760_000_000_000;

  const LEGACY_ID = "20261018-01M56VPJM9000000000000PAVQ";
  const MOVED_ID = "20261018-01M56VPJM9000000000000PAVR";
  const FRESH_TITLE = "a job that never had one";

  const routine: JobRoutineSpec = {
    cron: "0 6 * * *",
    timezone: "Asia/Tokyo",
    catchUp: "skip",
    overlap: "skip",
    prompt: "check the log",
    enabled: true,
  };

  const copy: JobScheduleSpec = { cron: "0 6 * * *", timezone: "Asia/Tokyo", catchUp: "skip", overlap: "skip" };

  interface Store {
    readonly storage: Storage;
    readonly session: Session;
    readonly jobs: JobRegistry;
  }

  function newStore(): Store {
    const storage = new MemoryStorage();
    const session = createSession(storage);
    return { storage, session, jobs: new JobRegistry({ session, storage, now: () => NOW }) };
  }

  /** A record in the shape an older build left on disk: the copy next to the routine. */
  function legacyRecord(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
    return {
      id,
      title: "carries a routine and its old copy",
      status: "done",
      origin: "user",
      labels: ["routine-a"],
      memoryAnchors: [],
      taskIds: [],
      createdAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      stats: { runs: 2, failures: 0 },
      schedule: copy,
      routine,
      ...overrides,
    };
  }

  /** Write a record as the old shape left it, so the dead field is really on disk. */
  async function seedRaw(store: Store, record: JobRecord): Promise<void> {
    await store.session.commit(async (tx) => {
      const draft = await tx.doc(SecJob, record.id, record.id);
      Object.assign(draft, record);
    }, ctx);
  }

  async function readRaw(store: Store, id: string): Promise<JobRecord | undefined> {
    return (await store.session.snapshot(SecJob, id, ctx)) as JobRecord | undefined;
  }

  /** Whether the stored document carries the key at all, not whether its value is a value. */
  function holdsCopy(record: JobRecord | undefined): boolean {
    return record !== undefined && Object.hasOwn(record, "schedule");
  }

  describe("the dead schedule copy", () => {
    it("writes no schedule copy on a new job or on a move", async () => {
      const live = newStore();
      const created = await live.jobs.create(ctx, { title: FRESH_TITLE });
      expect(created.schedule).toBeUndefined();
      expect(holdsCopy(await readRaw(live, created.id))).toBe(false);

      // The move: the target document already holds a stale copy, and the record
      // being moved carries one too. Neither survives the write.
      const archive = newStore();
      await seedRaw(archive, legacyRecord(MOVED_ID, { title: "a target that still had the copy" }));
      expect(holdsCopy(await readRaw(archive, MOVED_ID))).toBe(true);

      const moved = await archive.session.commit((tx) => archive.jobs.writeTx(tx, legacyRecord(MOVED_ID)), ctx);

      expect(moved.schedule).toBeUndefined();
      const stored = await readRaw(archive, MOVED_ID);
      expect(holdsCopy(stored)).toBe(false);
      // The routine is the schedule now, so it is what a move has to keep.
      expect(stored?.routine).toEqual(routine);
      expect(stored?.title).toBe("carries a routine and its old copy");
      expect(stored?.stats).toEqual({ runs: 2, failures: 0 });
      expect(stored?.completedAt).toBe(2000);
    });

    it("still reads a record that holds only the old copy", async () => {
      const store = newStore();
      await seedRaw(store, {
        id: LEGACY_ID,
        title: "a record from before the move stopped copying",
        status: "active",
        origin: "scheduler",
        labels: [],
        memoryAnchors: [],
        taskIds: [],
        createdAt: 1000,
        updatedAt: 2000,
        stats: { runs: 0, failures: 0 },
        schedule: copy,
      });
      expect(holdsCopy(await readRaw(store, LEGACY_ID))).toBe(true);

      const job = await store.jobs.get(ctx, LEGACY_ID);
      expect(job).toBeDefined();
      expect(job?.schedule).toEqual(copy);
      expect(job?.routine).toBeUndefined();
      expect(job?.once).toBeUndefined();
      expect(job?.title).toBe("a record from before the move stopped copying");

      // The listing and the tree walk the same documents, so a record the read
      // path could not load would fall out of them as well.
      expect((await store.jobs.list(ctx)).map((listed) => listed.id)).toContain(LEGACY_ID);
      expect((await store.jobs.tree(ctx)).map((node) => node.job.id)).toContain(LEGACY_ID);
    });
  });
});

describe("routine-model.test.ts", () => {
  /**
   * The schedule model and the boot migration: the two places where a schedule
   * value becomes a fact the reconciler acts on.
   *
   * Both are value-level, and that is what these tests check: what a written
   * `at` means, which statuses fire, that one record holds one schedule, and that
   * the legacy list moves onto the records exactly once. The reconciler itself is
   * driven in test/once-schedule.test.ts.
   */

  const ctx = BACKGROUND_CONTEXT;

  function extensionContext(h: TestHarness, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
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
      ...overrides,
    } as unknown as ExtensionContext;
  }

  function answers(count = 6): ReturnType<typeof fauxAssistantMessage>[] {
    return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
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

  describe("once.at is a written instant", () => {
    it("reads an ISO instant that names its offset, and epoch milliseconds", () => {
      expect(parseOnceAt("2026-10-18T14:00:00+09:00")).toBe(Date.UTC(2026, 9, 18, 5, 0, 0));
      expect(parseOnceAt("2026-10-18T05:00:00Z")).toBe(Date.UTC(2026, 9, 18, 5, 0, 0));
      expect(parseOnceAt(1_792_000_000_000)).toBe(1_792_000_000_000);
    });

    it("refuses a time without an offset, because it names a different instant in another zone", () => {
      expect(() => parseOnceAt("2026-10-18T14:00:00")).toThrow(/must carry an offset/);
    });

    it("refuses a value that is not a positive epoch time", () => {
      expect(() => parseOnceAt(0)).toThrow(/positive epoch/);
      expect(() => parseOnceAt(-5)).toThrow(/positive epoch/);
      expect(() => parseOnceAt(Number.NaN)).toThrow(/positive epoch/);
      expect(() => parseOnceAt(true)).toThrow(/ISO 8601 instant with an offset, or epoch milliseconds/);
    });
  });

  describe("the late window is one constant", () => {
    it("is five minutes, named once for the catch-up rule and the one-off rule", () => {
      expect(LATE_GRACE_MS).toBe(300_000);
      expect(LATE_GRACE_MS).toBe(5 * 60_000);
    });
  });

  describe("only a working job fires", () => {
    it("fires planned, active and waiting, and no other status", () => {
      expect([...FIRING_JOB_STATUSES].sort()).toEqual(["active", "planned", "waiting"]);
      for (const status of JOB_STATUSES) {
        expect(isFiringStatus(status)).toBe(FIRING_JOB_STATUSES.includes(status));
      }
      for (const status of ["paused", "done", "failed", "cancelled"] as const) {
        expect(isFiringStatus(status)).toBe(false);
      }
    });
  });

  describe("one record holds one schedule", () => {
    const now = Date.UTC(2026, 9, 18, 5, 0, 0);

    it("refuses a write that carries both fields, with the reason it refused", () => {
      expect(() =>
        validateScheduleFields({ cron: "0 6 * * *", prompt: "run" }, { at: now + 60_000, prompt: "run" }, now),
      ).toThrow(/cannot carry both routine and once/);
    });

    it("returns the routine it checked, and the once it checked, on their own", () => {
      expect(validateScheduleFields({ cron: "0 6 * * *", timezone: "UTC", prompt: "run" }, undefined, now)).toEqual({
        routine: { cron: "0 6 * * *", timezone: "UTC", prompt: "run" },
      });
      expect(validateScheduleFields(undefined, { at: now + 60_000, prompt: "run" }, now)).toEqual({
        once: { at: now + 60_000, prompt: "run" },
      });
      // `null` is "leave this one alone", which is how an update names one field.
      expect(validateScheduleFields(null, undefined, now)).toEqual({});
    });

    it("refuses a time in the past, and allows one when the write edits a run that already fired", () => {
      expect(() => validateScheduleFields(undefined, { at: now - 1, prompt: "run" }, now)).toThrow(
        /must be in the future/,
      );
      expect(
        validateScheduleFields(undefined, { at: now - 1, prompt: "run" }, now, { requireFutureOnce: false }),
      ).toEqual({ once: { at: now - 1, prompt: "run" } });
    });

    it("parses the cron with the reconciler's own parser, so a stored value is one it can act on", () => {
      expect(() => validateScheduleFields({ cron: "0 8 * *", prompt: "run" }, undefined, now)).toThrow(
        /routine\.cron cron must have 5 fields/,
      );
      expect(() => validateScheduleFields({ cron: "0 99 * * *", prompt: "run" }, undefined, now)).toThrow(
        /invalid cron field/,
      );
    });

    it("refuses a zone name and an enum value the reconciler could not use", () => {
      expect(() =>
        validateScheduleFields({ cron: "0 6 * * *", timezone: "Mars/Olympus", prompt: "run" }, undefined, now),
      ).toThrow(/is not a time zone/);
      expect(() =>
        validateScheduleFields({ cron: "0 6 * * *", prompt: "run", catchUp: "maybe" }, undefined, now),
      ).toThrow(/catchUp must be one of skip, once, all/);
      expect(() => validateScheduleFields({ cron: "0 6 * * *", prompt: "run", enabled: "yes" }, undefined, now)).toThrow(
        /enabled must be a boolean/,
      );
      expect(() => validateScheduleFields(undefined, { at: now + 1000, prompt: "run", state: "waiting" }, now)).toThrow(
        /state must be one of pending, done, cancelled, missed/,
      );
      expect(() => validateScheduleFields({ cron: "0 6 * * *" }, undefined, now)).toThrow(/prompt must be a non-empty string/);
    });
  });

  /** Four entries of mixed cadence. */
  const legacyJobs: Config["scheduler"]["jobs"] = [
    { name: "routine-a", schedule: "0 6 * * *", timezone: "UTC", catchUp: "skip", overlap: "skip", prompt: "promote lessons", vmodel: "faux" },
    { name: "routine-b", schedule: "0 8 * * 1", timezone: "UTC", prompt: "watch the release", vmodel: "faux" },
    { name: "routine-c", schedule: "0 9 * * *", timezone: "UTC", prompt: "digest", vmodel: "faux" },
    { name: "routine-d", schedule: "5 8 * * 1", timezone: "UTC", prompt: "watch the price", vmodel: "faux" },
  ];

  const legacyNames = legacyJobs.map((entry) => entry.name);

  /** A `config.json` with this schedule list, as the boot before the migration finds it. */
  async function writeConfigFile(h: TestHarness, jobs: Config["scheduler"]["jobs"]): Promise<void> {
    const config = { scheduler: { enabled: true, tickMs: 30_000, timezone: "UTC", jobs } };
    await writeFile(h.paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /**
   * The context of a later boot: the config it loads is the one on disk now.
   *
   * A second boot in a real process reads the file the migration emptied, so
   * rebuilding the config from that file is what makes "does it run again?" a
   * question about the value the next process sees rather than about the object
   * the first one held.
   */
  async function fileBootContext(h: TestHarness): Promise<ExtensionContext> {
    const raw = JSON.parse(await readFile(h.paths.configFile, "utf8")) as { scheduler?: Config["scheduler"] };
    const base = h.runtime.getConfig();
    const scheduler: Config["scheduler"] = { ...base.scheduler, ...(raw.scheduler ?? {}) };
    return extensionContext(h, { getConfig: () => ({ ...base, scheduler }) });
  }

  describe("the boot migration moves the legacy schedule list onto the records", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    async function boot(): Promise<TestHarness> {
      harness = await createTestHarness({
        responses: answers(),
        config: { scheduler: { enabled: true, tickMs: 30_000, timezone: "UTC", jobs: legacyJobs } },
      });
      await writeConfigFile(harness, legacyJobs);
      return harness;
    }

    it("fills one record per entry, empties the list, and does not run again on the next boot", async () => {
      const h = await boot();
      const byLabel = await h.runtime.jobs.create(ctx, { title: "lessons", labels: ["schedule:routine-a"] });
      const byTitle = await h.runtime.jobs.create(ctx, { title: "routine-b" });
      const context = extensionContext(h);
      const at = Date.UTC(2026, 5, 15, 12, 0, 0);

      const result = await migrateRoutines({ context, now: () => at });
      expect(result.error).toBeUndefined();
      expect(result.fatal).toBe(false);
      expect(result.ran).toBe(true);

      const jobs = await h.runtime.jobs.list(ctx);
      expect(jobs).toHaveLength(4);
      const withRoutine = jobs.filter((job) => job.routine !== undefined);
      expect(withRoutine).toHaveLength(4);
      expect(withRoutine.map((job) => job.routine?.cron).sort()).toEqual(
        ["0 6 * * *", "0 8 * * 1", "0 9 * * *", "5 8 * * 1"].sort(),
      );
      // A record the label pointed at and a record the title pointed at both keep
      // their identity: the migration fills a record, it does not replace one.
      expect((await h.runtime.jobs.get(ctx, byLabel.id))?.routine?.prompt).toBe("promote lessons");
      expect((await h.runtime.jobs.get(ctx, byTitle.id))?.routine?.prompt).toBe("watch the release");

      // The list is empty in the file the operator reads, and the previous file is
      // kept beside it: the migration can be undone by copying it back.
      const emptied = JSON.parse(await readFile(h.paths.configFile, "utf8")) as { scheduler: { jobs: unknown[] } };
      expect(emptied.scheduler.jobs).toEqual([]);
      expect(result.state.configBackup).toBeDefined();
      const backup = JSON.parse(await readFile(result.state.configBackup!, "utf8")) as { scheduler: { jobs: unknown[] } };
      expect(backup.scheduler.jobs).toHaveLength(4);

      // The record of the move names what went where, and which two it created.
      const state = await readRoutineMigrationState(context);
      expect(state?.routines.map((moved) => moved.name).sort()).toEqual([...legacyNames].sort());
      expect(state?.routines.filter((moved) => moved.created)).toHaveLength(2);
      expect(state?.ignoredLegacy).toEqual([]);

      // The second boot loads the emptied file, so there is nothing to move.
      const second = await fileBootContext(h);
      const again = await migrateRoutines({ context: second, now: () => at + 60_000 });
      expect(again.ran).toBe(false);
      expect(again.error).toBeUndefined();
      expect(again.fatal).toBe(false);
      expect(again.state.routines.map((moved) => moved.name).sort()).toEqual([...legacyNames].sort());
      expect(await h.runtime.jobs.list(ctx)).toHaveLength(4);
    });

    it("reports a legacy list that came back, and keeps firing from the record", async () => {
      const h = await boot();
      const context = extensionContext(h);
      const first = await migrateRoutines({ context });
      expect(first.ran).toBe(true);

      const moved = (await h.runtime.jobs.list(ctx)).find((job) => job.routine?.prompt === "promote lessons");
      expect(moved).toBeDefined();
      // The schedule the reconciler must now follow lives only on the record.
      await writeRoutine(context, moved!.id, {
        cron: "* * * * *",
        timezone: "UTC",
        catchUp: "skip",
        overlap: "skip",
        prompt: "promote lessons",
        vmodel: "faux",
        enabled: true,
      });

      // The old way comes back: an operator edited `config.json` again.
      await writeConfigFile(h, legacyJobs);
      const later = await fileBootContext(h);
      const problem = await legacyListProblem(later);
      expect(problem).toContain(`ignored ${legacyNames.join(", ")}`);
      expect(problem).toContain(LEGACY_LIST_HINT);
      expect((await readRoutineMigrationState(later))?.ignoredLegacy).toEqual(legacyNames);

      const dispatched: { jobId?: string }[] = [];
      h.events.subscribe((event) => {
        if (event.type === "notice") {
          const data = event.data as { code?: string; jobId?: string };
          if (data.code === "scheduler_dispatch") dispatched.push(data);
        }
      });

      const scheduler = new Scheduler({ context: later });
      const migration = await scheduler.ready();
      // A list that came back is an error to report, not a reason to stop: the
      // records are the schedule, and they keep firing.
      expect(migration.fatal).toBe(false);
      expect(migration.error).toContain("scheduler.jobs is no longer the schedule source");

      await scheduler.tick(Date.UTC(2026, 5, 15, 12, 17, 30));
      const fired = await until(() => dispatched[0], "the run to be dispatched");
      expect(fired.jobId).toBe(moved!.id);
      expect(dispatched).toHaveLength(1);
    });
  });
});

describe("migration.test.ts", () => {
  /**
   * The rename is the part of this change that touches data already on disk, so it
   * gets its own tests: it has to move keys, follow every reference, and be safe
   * to run twice.
   */

  const ctx = BACKGROUND_CONTEXT;
  const NOW = 1_760_000_000_000;
  const STAMP = dayStamp(NOW);

  const PARENT = "01M4NX7Y5J000000000000XYDW";
  const CHILD = "01M4NX7Y5J000000000000XYDX";
  const DATED = "20261001-01M4NX7Y5J000000000000XYDY";

  interface Store {
    storage: MemoryStorage;
    session: Session;
  }

  async function seedJob(store: Store, id: string, title: string, parentId?: string): Promise<void> {
    await store.session.commit(async (tx) => {
      const draft = await tx.doc(SecJob, id, id);
      draft.id = id;
      draft.title = title;
      draft.status = "done";
      draft.origin = "user";
      draft.labels = [];
      draft.memoryAnchors = [];
      draft.taskIds = [];
      draft.createdAt = 1000;
      draft.updatedAt = 2000;
      draft.stats = { runs: 1, failures: 0 };
      draft.completedAt = 2000;
      if (parentId !== undefined) draft.parentId = parentId;
    }, ctx);
  }

  async function seedInbox(store: Store, id: string, jobId: string): Promise<void> {
    await store.session.commit(async (tx) => {
      const draft = await tx.doc(SecInbox, id, id);
      draft.id = id;
      draft.kind = "notice";
      draft.title = "note";
      draft.body = "body";
      draft.createdAt = 1000;
      draft.source = { jobId };
    }, ctx);
  }

  async function emptyStore(): Promise<Store> {
    const storage = new MemoryStorage();
    return { storage, session: createSession(storage) };
  }

  async function jobKeys(store: Store): Promise<string[]> {
    return (await scanDocumentKeys(store.storage, "sec.job", ctx)).sort();
  }

  describe("job id date-prefix migration", () => {
    it("prefixes existing job ids with today's date", async () => {
      const store = await emptyStore();
      await seedJob(store, PARENT, "parent");

      const result = await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      expect(result.applied).toEqual([JOB_ID_DATE_PREFIX]);
      expect(await jobKeys(store)).toEqual([`${STAMP}-${PARENT}`]);
      expect((await store.session.snapshot(SecJob, `${STAMP}-${PARENT}`, ctx))?.title).toBe("parent");
    });

    it("follows parentId through the rename", async () => {
      const store = await emptyStore();
      await seedJob(store, PARENT, "parent");
      await seedJob(store, CHILD, "child", PARENT);

      await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      const child = await store.session.snapshot(SecJob, `${STAMP}-${CHILD}`, ctx);
      expect(child?.parentId).toBe(`${STAMP}-${PARENT}`);
    });

    it("follows an inbox item's job reference", async () => {
      const store = await emptyStore();
      await seedJob(store, PARENT, "parent");
      await seedInbox(store, "01M4NX7Y5J000000000000XYZ0", PARENT);

      await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      const item = await store.session.snapshot(SecInbox, "01M4NX7Y5J000000000000XYZ0", ctx);
      expect(item?.source?.jobId).toBe(`${STAMP}-${PARENT}`);
    });

    it("preserves the run stats and timestamps it moved", async () => {
      const store = await emptyStore();
      await seedJob(store, PARENT, "parent");

      await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      const moved = await store.session.snapshot(SecJob, `${STAMP}-${PARENT}`, ctx);
      expect(moved?.createdAt).toBe(1000);
      expect(moved?.updatedAt).toBe(2000);
      expect(moved?.stats).toEqual({ runs: 1, failures: 0 });
      expect(moved?.completedAt).toBe(2000);
    });

    it("leaves an already-dated id alone", async () => {
      const store = await emptyStore();
      await seedJob(store, DATED, "already dated");

      const result = await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      expect(result.skipped).toEqual([JOB_ID_DATE_PREFIX]);
      expect(await jobKeys(store)).toEqual([DATED]);
    });

    it("migrates a mixed store without disturbing the dated ids", async () => {
      const store = await emptyStore();
      await seedJob(store, DATED, "already dated");
      await seedJob(store, PARENT, "legacy");

      await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      expect(await jobKeys(store)).toEqual([DATED, `${STAMP}-${PARENT}`].sort());
    });

    it("records itself, so a second pass is a no-op", async () => {
      const store = await emptyStore();
      await seedJob(store, PARENT, "parent");

      await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });
      const second = await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });

      expect(second.applied).toEqual([]);
      // Not "skipped" either: a recorded migration is not looked at again.
      expect(second.skipped).toEqual([]);
      expect(await jobKeys(store)).toEqual([`${STAMP}-${PARENT}`]);
      const ledger = await store.session.snapshot(SecMigration, ctx);
      expect(ledger?.applied[JOB_ID_DATE_PREFIX]).toBe(NOW);
    });

    it("keeps every job when the store is already dated", async () => {
      const store = await emptyStore();
      const result = await runMigrations({ session: store.session, storage: store.storage, context: ctx, now: () => NOW });
      expect(await jobKeys(store)).toEqual([]);
      // Nothing to do is still recorded: there is no reason to rescan forever.
      expect(result.skipped).toEqual([JOB_ID_DATE_PREFIX]);
    });
  });

  describe("hasDatePrefix", () => {
    it("recognises the current format and rejects the old one", () => {
      expect(hasDatePrefix(DATED)).toBe(true);
      expect(hasDatePrefix(PARENT)).toBe(false);
      expect(hasDatePrefix(`${STAMP}-nope`)).toBe(false);
    });
  });
});
