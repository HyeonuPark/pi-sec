import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { JobRoutineSpec } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createJobsExtension } from "../src/extensions/jobs.ts";
import { LATE_GRACE_MS, settleOnce, writeRoutine } from "../src/jobs/routine.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The reconciler reads the schedule off the job record, and a one-off run
 * (`once`) is the kind that needs no approval: it is created, it fires once, it
 * closes, or it is cancelled, or its time passes and it is recorded as missed.
 *
 * Every case drives the real `Scheduler` over a real job registry. The clock is
 * the `nowMs` argument of `tick`, so a firing time is a value in the test and not
 * a matter of waiting for one.
 */

const ctx = BACKGROUND_CONTEXT;

type ToolLike = {
  name: string;
  execute: (
    args: never,
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<{ content: readonly { type: string; text?: string }[]; isError?: boolean }>;
};

const routine: JobRoutineSpec = {
  cron: "* * * * *",
  timezone: "UTC",
  catchUp: "skip",
  overlap: "skip",
  prompt: "check the log",
  vmodel: "faux",
  enabled: true,
};

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

function jobsToolset(h: TestHarness): Map<string, ToolLike> {
  const extension = createJobsExtension(extensionContext(h));
  return new Map((extension.tools ?? []).map((found) => [found.name, found as unknown as ToolLike]));
}

function execApi(h: TestHarness): ToolExecutionApi {
  return {
    conversationId: "01ONCESCHEDULE000000000000",
    commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: Context) =>
      h.runtime.harness.commit(change, context),
  } as unknown as ToolExecutionApi;
}

function tool(tools: Map<string, ToolLike>, name: string): ToolLike {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function madeJobId(result: { content: readonly { type: string; text?: string }[] }): string {
  const match = /^created (\S+) \[/.exec(textOf(result));
  if (match?.[1] === undefined) throw new Error(`no job id in: ${textOf(result)}`);
  return match[1];
}

/** The runs this tick started, as the notice the scheduler emits for each. */
function dispatchNotices(h: TestHarness): { code?: string; jobId?: string; conversationId?: number }[] {
  const found: { code?: string; jobId?: string; conversationId?: number }[] = [];
  h.events.subscribe((event) => {
    if (event.type !== "notice") return;
    const data = event.data as { code?: string; jobId?: string; conversationId?: number };
    if (data.code === "scheduler_dispatch") found.push(data);
  });
  return found;
}

describe("the scheduler reads the schedule off the record", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** A harness whose model answers every run the test dispatches. */
  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness({
      responses: Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])),
    });
    return harness;
  }

  it("fires from the record's routine.cron, and not from a value it no longer holds", async () => {
    const h = await boot();
    const context = extensionContext(h);
    const job = await h.runtime.jobs.create(ctx, { title: "nightly" });
    // A routine that cannot match the tick below: the stored value is what the
    // reconciler reads, so this record stays quiet.
    await writeRoutine(context, job.id, { ...routine, cron: "0 0 1 1 *" });
    const dispatched = dispatchNotices(h);

    await h.runtime.scheduler.tick(Date.UTC(2026, 5, 15, 12, 0, 30));
    expect(dispatched).toHaveLength(0);

    // Only `routine.cron` changes, on the same record.
    await writeRoutine(context, job.id, routine);
    const stored = await h.runtime.jobs.get(ctx, job.id);
    expect(stored?.routine?.cron).toBe("* * * * *");

    await h.runtime.scheduler.tick(Date.UTC(2026, 5, 15, 12, 1, 30));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.jobId).toBe(job.id);
    expect((await h.runtime.jobs.get(ctx, job.id))?.stats.runs).toBe(1);
  });

  it("never archives a routine job, and archives a one-off that fired", async () => {
    const h = await boot();
    const context = extensionContext(h);
    const nightly = await h.runtime.jobs.create(ctx, { title: "nightly" });
    await writeRoutine(context, nightly.id, routine);
    const record = (await h.runtime.jobs.get(ctx, nightly.id))!;
    // A closed routine: the record has to stay in the live store, because that is
    // where the reconciler and the next boot read the schedule from.
    await h.runtime.jobs.writeAll(ctx, [{ ...record, status: "done", completedAt: Date.now() - 1000 }]);

    const oneOff = await h.runtime.jobs.create(ctx, { title: "one run", once: { at: Date.now() + 60_000, prompt: "run", vmodel: "faux" } });
    await settleOnce(context, oneOff.id, "done");

    await h.runtime.archive.sweep(ctx, 0);

    expect(await h.runtime.jobs.get(ctx, nightly.id)).toBeDefined();
    expect((await h.runtime.jobs.get(ctx, nightly.id))?.routine?.cron).toBe("* * * * *");
    expect(await h.runtime.archive.get(ctx, nightly.id)).toBeUndefined();
    expect(await h.runtime.jobs.get(ctx, oneOff.id)).toBeUndefined();
    expect((await h.runtime.archive.get(ctx, oneOff.id))?.once?.state).toBe("done");
  });

  it("creates a one-off with no approval, fires it once and closes the job", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const at = Date.now() + 30_000;

    const created = await tool(tools, "jobs_create").execute(
      { title: "one run", once: { at, prompt: "check the log", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    expect(created.isError).toBeUndefined();
    const id = madeJobId(created);
    expect((await h.runtime.jobs.get(ctx, id))?.once?.at).toBe(at);
    expect((await h.runtime.jobs.get(ctx, id))?.once?.state).toBeUndefined();

    const dispatched = dispatchNotices(h);
    await h.runtime.scheduler.tick(at + 1000);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.jobId).toBe(id);
    const fired = await h.runtime.jobs.get(ctx, id);
    expect(fired?.once?.state).toBe("done");
    expect(fired?.status).toBe("done");
    expect(fired?.completedAt).toBeDefined();
    expect(fired?.stats.runs).toBe(1);
    expect(fired?.conversationId).toBe(String(dispatched[0]!.conversationId));
  });

  it("does not fire the same one-off again", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const at = Date.now() + 30_000;
    const created = await tool(tools, "jobs_create").execute(
      { title: "one run", once: { at, prompt: "check the log", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    const id = madeJobId(created);
    const dispatched = dispatchNotices(h);

    await h.runtime.scheduler.tick(at + 1000);
    await h.runtime.scheduler.tick(at + 2000);
    await h.runtime.scheduler.tick(at + 60_000);

    expect(dispatched).toHaveLength(1);
    expect((await h.runtime.jobs.get(ctx, id))?.once?.state).toBe("done");
    expect((await h.runtime.jobs.get(ctx, id))?.stats.runs).toBe(1);
  });

  it("cancels a one-off with no approval, and writes the state in the same commit", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const at = Date.now() + 3_600_000;
    const created = await tool(tools, "jobs_create").execute(
      { title: "one run", once: { at, prompt: "check the log", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    const id = madeJobId(created);

    const cancelled = await tool(tools, "jobs_update").execute({ id, status: "cancelled" } as never, api, ctx);
    expect(cancelled.isError).toBeUndefined();
    const stored = await h.runtime.jobs.get(ctx, id);
    expect(stored?.status).toBe("cancelled");
    // The value lands with the status: the record never says "cancelled job,
    // pending run" while the scheduler waits for its next pass.
    expect(stored?.once?.state).toBe("cancelled");

    // The other way to call it off is the cancel tool, and it needs nothing either.
    const second = await tool(tools, "jobs_create").execute(
      { title: "another one", once: { at, prompt: "check the log", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    const secondId = madeJobId(second);
    const byTool = await tool(tools, "jobs_cancel").execute({ id: secondId } as never, api, ctx);
    expect(byTool.isError).toBeUndefined();
    expect((await h.runtime.jobs.get(ctx, secondId))?.once?.state).toBe("cancelled");
    expect((await h.runtime.jobs.get(ctx, secondId))?.status).toBe("cancelled");
  });

  it("fires a one-off inside the five minute window", async () => {
    const h = await boot();
    const at = Date.now() + 30_000;
    const job = await h.runtime.jobs.create(ctx, { title: "one run", once: { at, prompt: "check the log", vmodel: "faux" } });
    const dispatched = dispatchNotices(h);

    await h.runtime.scheduler.tick(at + LATE_GRACE_MS - 10_000);

    expect(dispatched).toHaveLength(1);
    const fired = await h.runtime.jobs.get(ctx, job.id);
    expect(fired?.once?.state).toBe("done");
    expect(fired?.status).toBe("done");
  });

  it("closes a one-off as missed when its time is more than five minutes past", async () => {
    const h = await boot();
    const at = Date.now() + 30_000;
    const job = await h.runtime.jobs.create(ctx, { title: "one run", once: { at, prompt: "check the log", vmodel: "faux" } });
    const dispatched = dispatchNotices(h);

    await h.runtime.scheduler.tick(at + LATE_GRACE_MS + 1000);

    expect(dispatched).toHaveLength(0);
    const missed = await h.runtime.jobs.get(ctx, job.id);
    // Not left waiting: a `pending` run whose time has passed looks due on every
    // tick for ever. The value says what happened, and the panel shows it.
    expect(missed?.once?.state).toBe("missed");
    expect(missed?.status).toBe("done");
    expect(missed?.stats.runs).toBe(1);
    expect(missed?.lastRun?.status).toBe("failure");
    expect(missed?.lastRun?.summary).toContain("missed");
  });

  it("does not fire a paused, done, failed or cancelled job, routine or one-off", async () => {
    const h = await boot();
    const context = extensionContext(h);
    const at = Date.UTC(2026, 5, 15, 12, 0, 0);
    const dispatched = dispatchNotices(h);

    for (const status of ["paused", "done", "failed", "cancelled"] as const) {
      const made = await h.runtime.jobs.create(ctx, { title: `routine ${status}` });
      await writeRoutine(context, made.id, routine);
      const record = (await h.runtime.jobs.get(ctx, made.id))!;
      const terminal = status === "done" || status === "failed" || status === "cancelled";
      await h.runtime.jobs.writeAll(ctx, [
        terminal ? { ...record, status, completedAt: at - 1000 } : { ...record, status },
      ]);

      const oneOff = await h.runtime.jobs.create(ctx, { title: `once ${status}`, once: { at: at - 1000, prompt: "run", vmodel: "faux" } });
      await h.runtime.jobs.update(ctx, oneOff.id, { status });
    }

    await h.runtime.scheduler.tick(at);
    expect(dispatched).toHaveLength(0);

    const jobs = await h.runtime.jobs.list(ctx);
    for (const status of ["paused", "done", "failed", "cancelled"] as const) {
      const made = jobs.find((job) => job.title === `routine ${status}`);
      expect(made?.status).toBe(status);
      const oneOff = jobs.find((job) => job.title === `once ${status}`);
      // A switched-off one-off is not a missed one, and the cancelled one carries
      // its own value; neither of them fired.
      expect(oneOff?.once?.state).toBe(status === "cancelled" ? "cancelled" : undefined);
      expect(oneOff?.stats.runs).toBe(0);
    }
  });

  it("fires a planned, active and waiting job, routine and one-off alike", async () => {
    const h = await boot();
    const context = extensionContext(h);
    const at = Date.UTC(2026, 5, 15, 12, 0, 0);
    const dispatched = dispatchNotices(h);

    const routines: string[] = [];
    for (const status of ["planned", "active", "waiting"] as const) {
      const made = await h.runtime.jobs.create(ctx, { title: `routine ${status}` });
      await writeRoutine(context, made.id, routine);
      if (status !== "planned") {
        const record = (await h.runtime.jobs.get(ctx, made.id))!;
        await h.runtime.jobs.writeAll(ctx, [{ ...record, status }]);
      }
      routines.push(made.id);
    }

    const oneOffs: string[] = [];
    for (const status of ["planned", "active", "waiting"] as const) {
      const made = await h.runtime.jobs.create(ctx, {
        title: `once ${status}`,
        once: { at: at - 1000, prompt: "run", vmodel: "faux" },
      });
      if (status !== "planned") await h.runtime.jobs.update(ctx, made.id, { status });
      oneOffs.push(made.id);
    }

    await h.runtime.scheduler.tick(at);

    expect(dispatched).toHaveLength(6);
    expect(dispatched.map((notice) => notice.jobId).sort()).toEqual([...routines, ...oneOffs].sort());
    for (const id of routines) expect((await h.runtime.jobs.get(ctx, id))?.stats.runs).toBe(1);
    for (const id of oneOffs) {
      const record = await h.runtime.jobs.get(ctx, id);
      expect(record?.once?.state).toBe("done");
      expect(record?.status).toBe("done");
    }
  });

  it("refuses a one-off whose time has passed, and a write that carries both schedules", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);

    const past = await tool(tools, "jobs_create").execute(
      { title: "late", once: { at: Date.now() - 60_000, prompt: "run", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain("once.at must be in the future");

    const both = await tool(tools, "jobs_create").execute(
      { title: "both", routine, once: { at: Date.now() + 60_000, prompt: "run", vmodel: "faux" } } as never,
      api,
      ctx,
    );
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("a job cannot carry both routine and once");
    expect(await h.runtime.jobs.list(ctx)).toHaveLength(0);
  });
});
