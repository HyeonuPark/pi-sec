import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { reportStanding, type ReportStore } from "../src/reports/store.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * The execution api the harness would hand a tool: an id, and a commit into the
 * session. A call that gets past the guard records itself before it runs the
 * gate, so the commit has to be real.
 */
function execApi(h: TestHarness): ToolExecutionApi {
  return {
    conversationId: 1,
    commit: (change: (tx: never) => unknown, context: Context) =>
      h.runtime.harness.commit(change as never, context),
  } as unknown as ToolExecutionApi;
}

/**
 * The take-off guard: a core change needs the user's approval on the report
 * whose newest revision describes it.
 *
 * Consent is the one thing the gate below cannot check, so it is checked first
 * and refused on its own message, before typecheck or the suite runs. The
 * harness workspace has no `node_modules` and is not a git tree, so every case
 * that gets past the guard ends at the gate's own refusal — which is how these
 * tests tell "the guard let it through" from "the guard said no".
 */
describe("request_restart needs an approved report", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    // Core work is recorded in the default conversation, so the tool that gets
    // past the guard has to find it there.
    await resolveDefaultConversation(harness.runtime.harness, harness.runtime.getConfig(), harness.runtime.paths, ctx);
    return harness;
  }

  /** The gate's own refusal, which is where a call that passed the guard lands. */
  const GATE_REFUSED = "the gate refused the change";

  /**
   * The restart tool, built against this harness's own context. The report store
   * is the one field that can be taken away: a build with no store has no
   * approval record to read, and that has to be reachable in a test.
   */
  function restartTool(reports: ReportStore | undefined): ToolRegistration {
    const runtime = harness!.runtime;
    const context = {
      getConfig: runtime.getConfig,
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      ...(reports === undefined ? {} : { reports }),
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  /** A live job with one report on it, and the report's id. */
  async function report(): Promise<string> {
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const record = await harness!.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    return record.id;
  }

  /**
   * A report whose job has finished, so the report moved to the archive with it.
   * When it carries an approval, that approval was taken while the job was live:
   * the archive keeps the record, and `checkApproval` can no longer grant one
   * there because it reads the live store.
   */
  async function archivedReport(approved: boolean): Promise<string> {
    const h = harness!;
    const job = await h.runtime.jobs.create(ctx, { title: "finished work" });
    const record = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    if (approved) {
      expect((await h.runtime.reports.approve(ctx, record.id, 1, { via: "panel" })).ok).toBe(true);
    }
    await h.runtime.jobs.update(ctx, job.id, { status: "done" });
    await h.runtime.archive.sweep(ctx, 0);
    // The archive is what is left: the live store no longer answers for it.
    expect(await h.runtime.reports.get(ctx, record.id)).toBeUndefined();
    expect(await h.runtime.reports.getArchived(ctx, record.id)).toBeDefined();
    return record.id;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  it("declares reportId as a required argument", async () => {
    await boot();
    const installed = harness!.runtime.registry
      .snapshot()
      .tools()
      .find((item) => item.tool.name === "request_restart");
    expect(installed).toBeDefined();
    const required = (installed!.tool.parameters as { readonly required?: readonly string[] }).required ?? [];
    expect(required).toContain("reportId");
  });

  it("refuses a call that names no report", async () => {
    const h = await boot();
    const result = await restartTool(h.runtime.reports).execute({ title: "guard" } as never, execApi(h), ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("reportId is required");
    expect(text).not.toContain(GATE_REFUSED);
    expect(text).not.toContain("operator");
  });

  it("refuses a report whose newest revision is not approved", async () => {
    const h = await boot();
    const id = await report();
    const result = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    // The message has to say which report, which revision, and what to do next,
    // or the model cannot act on it.
    expect(text).toContain(id);
    expect(text).toContain("v1");
    expect(text).toContain("no approval on its newest revision");
    expect(text).toContain("Approve");
    expect(text).not.toContain(GATE_REFUSED);
    expect(text).not.toContain("operator");
    expect((await h.runtime.reports.get(ctx, id))?.versions[0]?.approval).toBeUndefined();

    const refusals = (await readAuditTail(h.paths.auditLog, undefined, 20)).filter(
      (event) => event.type === "restart_refused",
    );
    expect(refusals).toHaveLength(1);
    // The row has to say the same three things whatever refused, and the reason
    // has to be readable without parsing prose. See
    // test/restart-flow.test.ts for the contract across all three
    // places that record one.
    expect(refusals[0]!.source).toBe("agent");
    expect(refusals[0]!.code).toBe("no_approval");
    expect(refusals[0]!.title).toBe("guard");
    expect(refusals[0]!.conversationId).toBe(1);
    expect(refusals[0]!.reasons).toEqual([expect.stringContaining(`no approval on its newest revision, v1`)]);
  });

  it("refuses a report it does not have", async () => {
    const h = await boot();
    const result = await restartTool(h.runtime.reports).execute(
      { title: "guard", reportId: "no-such-report" } as never,
      execApi(h),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no report no-such-report exists");
    expect(textOf(result)).not.toContain(GATE_REFUSED);
    expect(textOf(result)).not.toContain("operator");
  });

  it("refuses when only an older revision was approved", async () => {
    const h = await boot();
    const id = await report();
    // v1 is approved; v2 is a new proposal, and approving v1 never approved it.
    expect((await h.runtime.reports.approve(ctx, id, 1, { via: "viewer" })).ok).toBe(true);
    await h.runtime.reports.addVersion(ctx, id, { content: "two\n", note: "second" });

    const result = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no approval on its newest revision, v2");
    expect(textOf(result)).not.toContain(GATE_REFUSED);
  });

  it("passes once the newest revision is approved, and refuses again after a new one", async () => {
    const h = await boot();
    const id = await report();
    expect((await h.runtime.reports.approve(ctx, id, 1, { via: "panel" })).ok).toBe(true);

    const passed = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    // Past the guard: what refuses now is the gate, which is a different question.
    expect(textOf(passed)).toContain(GATE_REFUSED);
    expect(textOf(passed)).not.toContain("no approval on its newest revision");

    await h.runtime.reports.addVersion(ctx, id, { content: "two\n", note: "second" });
    const again = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    expect(textOf(again)).toContain("no approval on its newest revision, v2");
    expect(textOf(again)).not.toContain(GATE_REFUSED);
  });

  it("passes when the approved report has been set aside as pending", async () => {
    const h = await boot();
    const id = await report();
    expect((await h.runtime.reports.approve(ctx, id, 1, { via: "panel" })).ok).toBe(true);
    // The approval sets the flag in the same commit. This call makes the state
    // explicit, so the case holds even if that default changes later.
    expect((await h.runtime.reports.setPending(ctx, id, true)).ok).toBe(true);
    const stored = await h.runtime.reports.get(ctx, id);
    expect(stored?.pendingAt).toBeGreaterThan(0);
    expect(reportStanding(stored!, "active")).toBe("pending");

    const result = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    // Past the guard: `approvalRefusal` reads the newest revision's `approval` and
    // nothing else, so a report set aside cannot refuse a landing the user
    // already approved.
    expect(textOf(result)).toContain(GATE_REFUSED);
    expect(textOf(result)).not.toContain("no approval on its newest revision");
  });

  it("refuses an approval on a report whose job has already archived it", async () => {
    const h = await boot();
    const id = await archivedReport(true);

    const result = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    // The approval covered the work that job landed. It is not standing
    // permission for the next change, which is the routine gate's rule too.
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("is archived because its job finished");
    expect(text).not.toContain(GATE_REFUSED);
    expect(text).not.toContain("operator");
    const refusals = (await readAuditTail(h.paths.auditLog, undefined, 20)).filter(
      (event) => event.type === "restart_refused",
    );
    expect(refusals.map((row) => row.code)).toEqual(["report_archived"]);
  });

  it("refuses an approval on a report whose job has ended but is not archived yet", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "ended work" });
    const record = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    expect((await h.runtime.reports.approve(ctx, record.id, 1, { via: "panel" })).ok).toBe(true);
    await h.runtime.jobs.update(ctx, job.id, { status: "done" });
    // Still in the live store: only the job's status says the work is over.
    expect(await h.runtime.reports.get(ctx, record.id)).toBeDefined();

    const result = await restartTool(h.runtime.reports).execute(
      { title: "guard", reportId: record.id } as never,
      execApi(h),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Restart NOT requested");
    expect(text).toContain('belongs to a job that is done');
    expect(text).not.toContain(GATE_REFUSED);
    const refusals = (await readAuditTail(h.paths.auditLog, undefined, 20)).filter(
      (event) => event.type === "restart_refused",
    );
    expect(refusals.map((row) => row.code)).toEqual(["report_not_active"]);
  });

  it("refuses an approval whose sha256 does not name the newest revision", async () => {
    const h = await boot();
    // The store writes the revision's own sha256 into an approval, so a mismatch
    // can only come from a record that disagrees with itself. A stub is the way
    // to reach that case, and the check has to refuse it.
    const stored = {
      id: "01REPORT000000000000000001",
      title: "Plan",
      jobId: "01JOB000000000000000000001",
      versions: [{ n: 1, sha256: "text-the-user-was-shown" }],
    };
    const store = {
      get: async () => stored,
      getArchived: async () => undefined,
      checkApproval: async () => ({
        ok: false,
        reason: "already_approved",
        approval: { at: 1, via: "panel", sha256: "text-approved-earlier" },
      }),
    } as unknown as ReportStore;

    const result = await restartTool(store).execute({ title: "guard", reportId: stored.id } as never, execApi(h), ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("text-approved-earlier");
    expect(text).toContain("text-the-user-was-shown");
    expect(text).not.toContain(GATE_REFUSED);
    const refusals = (await readAuditTail(h.paths.auditLog, undefined, 20)).filter(
      (event) => event.type === "restart_refused",
    );
    expect(refusals.map((row) => row.code)).toEqual(["approval_sha256_mismatch"]);
  });

  it("keeps its own words for an archived report that holds no approval", async () => {
    const h = await boot();
    const id = await archivedReport(false);

    const result = await restartTool(h.runtime.reports).execute({ title: "guard", reportId: id } as never, execApi(h), ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    // The report is there, in the archive, so "no report exists" would be a lie,
    // and the refusal has to say why no approval can be taken now.
    expect(text).toContain("is archived because its job finished");
    expect(text).not.toContain(`no report ${id} exists`);
    expect(text).not.toContain(GATE_REFUSED);
  });

  it("passes in a build with no report store", async () => {
    const h = await boot();
    // No store means no approval record exists to read, and a guard that refused
    // here would refuse every restart in that build.
    const result = await restartTool(undefined).execute({ title: "guard", reportId: "anything" } as never, execApi(h), ctx);
    expect(textOf(result)).toContain(GATE_REFUSED);
    expect(textOf(result)).not.toContain("no approval");
  });

  it("lets a store read failure surface as a failure", async () => {
    const h = await boot();
    const broken = {
      get: () => {
        throw new Error("the store is unreachable");
      },
    } as unknown as ReportStore;
    await expect(restartTool(broken).execute({ title: "guard", reportId: "x" } as never, execApi(h), ctx)).rejects.toThrow(
      "the store is unreachable",
    );
  });
});
