import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { JobOnceSpec, JobRoutineSpec } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createJobsExtension } from "../src/extensions/jobs.ts";
import { resolveRoutineApproval } from "../src/jobs/registry.ts";
import { settleOnce, writeRoutine } from "../src/jobs/routine.ts";
import type { ReportRecord } from "../src/documents.ts";
import type { ReportStore } from "../src/reports/store.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The routine gate: a recurring schedule is a change to the harness, so it needs
 * the user's approval on a report revision, and a one-off run does not.
 *
 * Every case here drives the real tool over a real job registry and a real report
 * store. The one exception is the sha256 comparison, which no stored report can
 * reach — the store never records an approval whose sha256 is not the revision's
 * own — so that branch is reached with a store that returns the two values
 * disagreeing, and its refusal is checked directly.
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
  cron: "0 6 * * *",
  timezone: "UTC",
  catchUp: "skip",
  overlap: "skip",
  prompt: "promote the lessons",
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
    conversationId: "01ROUTINEGATE0000000000000",
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

/** The job id that a `created ...` line names. */
function madeJobId(result: { content: readonly { type: string; text?: string }[] }): string {
  const match = /^created (\S+) \[/.exec(textOf(result));
  if (match?.[1] === undefined) throw new Error(`no job id in: ${textOf(result)}`);
  return match[1];
}

describe("the routine gate", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  /** A live job carrying one report, approved by the user on its newest revision. */
  async function approvedReport(h: TestHarness): Promise<string> {
    const job = await h.runtime.jobs.create(ctx, { title: "routine plan" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    const approved = await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" });
    expect(approved.ok).toBe(true);
    return report.id;
  }

  /** A routine job, created through the tool with an approved report. */
  async function routineJob(h: TestHarness, tools: Map<string, ToolLike>, api: ToolExecutionApi): Promise<string> {
    const reportId = await approvedReport(h);
    const made = await tool(tools, "jobs_create").execute(
      { title: "nightly", routine, reportId } as never,
      api,
      ctx,
    );
    expect(made.isError).toBeUndefined();
    return madeJobId(made);
  }

  async function record(h: TestHarness, id: string): Promise<Record<string, unknown> | undefined> {
    const job = await h.runtime.jobs.get(ctx, id);
    return job === undefined ? undefined : (JSON.parse(JSON.stringify(job)) as Record<string, unknown>);
  }

  /** Every `routine_refused` row this harness has written, oldest first. */
  async function refusalRows(h: TestHarness): Promise<AuditEvent[]> {
    return (await readAuditTail(h.paths.auditLog, undefined, 100)).filter((event) => event.type === "routine_refused");
  }

  it("refuses a routine created with no approval, and stores no record", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);

    const result = await tool(tools, "jobs_create").execute({ title: "nightly", routine } as never, api, ctx);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Routine NOT changed. Nothing was written");
    expect(text).toContain("no reportId was passed");
    expect(text).toContain("whose newest revision the user approved");
    expect(text).not.toContain("operator");
    expect(await h.runtime.jobs.list(ctx)).toHaveLength(0);

    // The message carries what to do about it; the row carries why the write
    // counted as a routine change in the first place.
    const rows = await refusalRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("jobs_create");
    expect(rows[0]!.code).toBe("report_id_required");
    // `reasons` is the gate's own sentences followed by the fix-it detail, so a
    // reader of the audit row can tell why it was gated from what to do.
    expect(rows[0]!.reasons?.[0]).toContain("creates a job that carries a routine");
    expect(rows[0]!.reasons?.at(-1)).toContain("no reportId was passed");
  });

  it("stores the routine when the newest revision of a live report is approved", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const reportId = await approvedReport(h);
    const report = await h.runtime.reports.get(ctx, reportId);
    const stored = report!.versions[0]!;

    const result = await tool(tools, "jobs_create").execute({ title: "nightly", routine, reportId } as never, api, ctx);

    expect(result.isError).toBeUndefined();
    const id = madeJobId(result);
    const created = await h.runtime.jobs.get(ctx, id);
    expect(created?.routine).toEqual(routine);
    // The approval names the revision's own sha256, which is what the gate compared.
    expect(stored.approval?.sha256).toBe(stored.sha256);
  });

  it("refuses a routine change and a routine deletion with no approval, and leaves the field alone", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const id = await routineJob(h, tools, api);
    const before = await record(h, id);

    const changed = await tool(tools, "jobs_update").execute(
      { id, routine: { ...routine, cron: "0 7 * * *" } } as never,
      api,
      ctx,
    );
    expect(changed.isError).toBe(true);
    expect(textOf(changed)).toContain("no reportId was passed");

    const deleted = await tool(tools, "jobs_update").execute({ id, routine: null } as never, api, ctx);
    expect(deleted.isError).toBe(true);
    expect(textOf(deleted)).toContain("no reportId was passed");

    const rows = await refusalRows(h);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.reasons?.[0]).toContain("changes the routine of a job that already has one");
    expect(rows[1]!.reasons?.[0]).toContain("removes the routine from a job, which deletes a recurring schedule");

    // A refusal that still wrote would be the worst of both: an error the caller
    // retries against a record that already moved.
    expect(await record(h, id)).toEqual(before);
  });

  it("refuses cancelling or pausing a routine job with no approval, and leaves the status alone", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const id = await routineJob(h, tools, api);
    expect((await h.runtime.jobs.get(ctx, id))?.status).toBe("planned");

    const cancelled = await tool(tools, "jobs_cancel").execute({ id } as never, api, ctx);
    expect(cancelled.isError).toBe(true);
    expect(textOf(cancelled)).toContain("Routine NOT changed. Nothing was written");

    for (const status of ["paused", "done", "cancelled"] as const) {
      const closed = await tool(tools, "jobs_update").execute({ id, status } as never, api, ctx);
      expect(closed.isError).toBe(true);
      expect((await h.runtime.jobs.get(ctx, id))?.status).toBe("planned");
    }

    const rows = await refusalRows(h);
    expect(rows.map((row) => row.source)).toEqual(["jobs_cancel", "jobs_update", "jobs_update", "jobs_update"]);
    expect(rows[0]!.reasons?.[0]).toContain('closes or pauses the job of a routine with status "cancelled"');
    expect(rows.map((row) => row.reasons?.[0])).toEqual([
      expect.stringContaining("closes or pauses"),
      expect.stringContaining('with status "paused"'),
      expect.stringContaining('with status "done"'),
      expect.stringContaining('with status "cancelled"'),
    ]);
    for (const row of rows) expect(row.jobId).toBe(id);
  });

  it("voids an approval once a newer revision is published, and names the text that moved", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const reportId = await approvedReport(h);
    const first = (await h.runtime.reports.get(ctx, reportId))!.versions[0]!;

    await h.runtime.reports.addVersion(ctx, reportId, { content: "two\n", note: "second" });
    const second = (await h.runtime.reports.get(ctx, reportId))!.versions[1]!;
    expect(second.sha256).not.toBe(first.sha256);
    expect(first.approval?.sha256).toBe(first.sha256);

    const result = await tool(tools, "jobs_create").execute({ title: "nightly", routine, reportId } as never, api, ctx);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`has no approval on its newest revision, v2`);
    expect(textOf(result)).toContain("Ask the user to press Approve on v2");
    expect(textOf(result)).not.toContain("operator");
    // Only the report's own job exists: the refused write stored nothing.
    expect(await h.runtime.jobs.list(ctx)).toHaveLength(1);
  });

  it("refuses an approval whose sha256 names a different text", async () => {
    const h = await boot();
    const report = {
      id: "01REPORT000000000000000001",
      title: "Plan",
      jobId: "01JOB000000000000000000001",
      versions: [{ n: 1, sha256: "text-the-operator-was-shown" }],
    } as unknown as ReportRecord;
    const store = {
      get: async () => report,
      checkApproval: async () => ({
        ok: false,
        reason: "already_approved",
        approval: { at: 1, via: "panel", sha256: "text-approved-earlier" },
      }),
    } as unknown as ReportStore;

    const outcome = await resolveRoutineApproval({
      reports: store,
      context: ctx,
      reportId: report.id,
      gate: { gated: true, reasons: ["creates a job that carries a routine"] },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("the gate passed an approval that names other text");
    expect(outcome.refusal.code).toBe("approval_sha256_mismatch");
    expect(outcome.refusal.message).toContain("text-approved-earlier");
    expect(outcome.refusal.message).toContain("text-the-operator-was-shown");
  });

  it("refuses both directions of a swap with no approval", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const once: JobOnceSpec = { at: Date.now() + 3_600_000, prompt: "run once", vmodel: "faux" };
    const created = await tool(tools, "jobs_create").execute({ title: "one run", once } as never, api, ctx);
    expect(created.isError).toBeUndefined();
    const onceId = madeJobId(created);
    const routineId = await routineJob(h, tools, api);
    const routineBefore = await record(h, routineId);

    // once -> routine: a routine created, so it is gated.
    const toRoutine = await tool(tools, "jobs_update").execute(
      { id: onceId, routine, once: null } as never,
      api,
      ctx,
    );
    expect(toRoutine.isError).toBe(true);
    expect(textOf(toRoutine)).toContain("Routine NOT changed. Nothing was written");
    expect((await h.runtime.jobs.get(ctx, onceId))?.routine).toBeUndefined();
    expect((await h.runtime.jobs.get(ctx, onceId))?.once?.prompt).toBe("run once");

    // routine -> once: a routine deleted, so it is gated too.
    const toOnce = await tool(tools, "jobs_update").execute(
      { id: routineId, routine: null, once } as never,
      api,
      ctx,
    );
    expect(toOnce.isError).toBe(true);
    expect(await record(h, routineId)).toEqual(routineBefore);

    const rows = await refusalRows(h);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.reasons?.[0]).toContain("adds a routine to a job that has none");
    expect(rows[1]!.reasons?.[0]).toContain("removes the routine from a job");

    // Naming only the field it adds cannot slip past either: the registry keeps
    // one schedule per record and says so.
    await expect(
      tool(tools, "jobs_update").execute({ id: routineId, once } as never, api, ctx),
    ).rejects.toThrow(/cannot carry both routine and once/);
    const onlyRoutine = await tool(tools, "jobs_update").execute({ id: onceId, routine } as never, api, ctx);
    expect(onlyRoutine.isError).toBe(true);
    const after = await refusalRows(h);
    expect(after.at(-1)?.reasons?.[0]).toContain("adds a routine to a job that has none");
  });

  it("applies a swap that carries an approval, and leaves one schedule on the record", async () => {
    const h = await boot();
    const tools = jobsToolset(h);
    const api = execApi(h);
    const once: JobOnceSpec = { at: Date.now() + 3_600_000, prompt: "run once", vmodel: "faux" };
    const created = await tool(tools, "jobs_create").execute({ title: "one run", once } as never, api, ctx);
    const id = madeJobId(created);
    const reportId = await approvedReport(h);

    const swapped = await tool(tools, "jobs_update").execute(
      { id, routine, once: null, reportId } as never,
      api,
      ctx,
    );

    expect(swapped.isError).toBeUndefined();
    const stored = await h.runtime.jobs.get(ctx, id);
    expect(stored?.routine).toEqual(routine);
    expect(stored?.once).toBeUndefined();
  });

  it("lets the scheduler's own writes through, and still refuses the registry", async () => {
    const h = await boot();
    const context = extensionContext(h);
    const plain = await h.runtime.jobs.create(ctx, { title: "nightly" });

    // The migration's write: no report, no approval, and it lands.
    await writeRoutine(context, plain.id, routine);
    expect((await h.runtime.jobs.get(ctx, plain.id))?.routine?.cron).toBe("0 6 * * *");

    // The same change through the registry is refused: the gate is not bypassed
    // by calling the registry instead of the tool.
    await expect(h.runtime.jobs.update(ctx, plain.id, { routine: null })).rejects.toThrow(/routine change refused/);
    await expect(
      h.runtime.jobs.update(ctx, plain.id, { routine: { ...routine, cron: "0 7 * * *" } }),
    ).rejects.toThrow(/routine change refused/);
    expect((await h.runtime.jobs.get(ctx, plain.id))?.routine?.cron).toBe("0 6 * * *");

    // The scheduler's run record is not a routine change and is not gated.
    const recorded = await h.runtime.jobs.update(ctx, plain.id, { recordRun: { success: true, summary: "ran" } });
    expect(recorded.stats.runs).toBe(1);
    expect((await h.runtime.jobs.get(ctx, plain.id))?.routine?.cron).toBe("0 6 * * *");

    // The reconciler closes a one-off in its own commit, with no approval either.
    const oneOff = await h.runtime.jobs.create(ctx, { title: "one run", once: { at: Date.now() + 60_000, prompt: "run" } });
    await settleOnce(context, oneOff.id, "done");
    const closed = await h.runtime.jobs.get(ctx, oneOff.id);
    expect(closed?.status).toBe("done");
    expect(closed?.once?.state).toBe("done");
    expect(closed?.completedAt).toBeDefined();
  });
});

describe("the routine gate and a Done", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("takes a Done on a result report as the approval it records", async () => {
    harness = await createTestHarness();
    const h = harness;
    const tools = jobsToolset(h);
    const api = execApi(h);
    const job = await h.runtime.jobs.create(ctx, { title: "run" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Run log", content: "one\n", kind: "result" });

    // Done writes the same approval record as Approve, with the button named, so
    // the gate reads it as consent and nothing in the gate changes.
    const done = await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel", button: "done" });
    expect(done.ok).toBe(true);

    const result = await tool(tools, "jobs_create").execute({ title: "nightly", routine, reportId: report.id } as never, api, ctx);
    expect(result.isError).toBeUndefined();
    const created = await h.runtime.jobs.get(ctx, madeJobId(result));
    expect(created?.routine).toEqual(routine);
  });
});
