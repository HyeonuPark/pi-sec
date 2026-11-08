import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { SecReport } from "../src/documents.ts";
import { reportKind, reportStanding } from "../src/reports/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { createInboxItemTx } from "../src/extensions/notify.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * The third report kind, and the archive of the briefings before it.
 *
 * A briefing report carries the morning briefing. It asks for no approval, so the
 * viewer shows Feedback alone, and it is listed at the top of the list. A new one
 * moves every earlier briefing and its inbox notices into the archive, so the live
 * store holds the newest briefing and nothing older.
 *
 * The two stores are separate SQLite files, so the interesting cases are the ones
 * where the copy and the retire are not simultaneous: the steps have to be
 * idempotent, and the next briefing has to finish a move a crash interrupted.
 */

describe("a briefing report", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  let origin = "";

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime: harness.runtime,
      bus: harness.events,
      sse,
      streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    origin = started.origin;
    return harness;
  }

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function tool(name: string): ToolRegistration {
    const entry = harness!.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool;
  }

  const api = { conversationId: 1 } as unknown as ToolExecutionApi;

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  /** A live job standing in for the routine's job, which never leaves the store. */
  async function routineJob(title = "morning-briefing"): Promise<string> {
    const job = await harness!.runtime.jobs.create(ctx, { title });
    return job.id;
  }

  async function briefing(
    jobId: string,
    title: string,
    content = "# Briefing\n\nToday.\n",
  ): Promise<{ id: string; name: string }> {
    const body = await post("/api/reports", { jobId, title, content, kind: "briefing" });
    expect(body.status).toBe(201);
    const record = (await body.json()) as { id: string; name: string };
    return { id: record.id, name: record.name };
  }

  /** One notice of the kind the inbox kept for a briefing before reports carried it. */
  async function legacyBriefingNotice(title = "Briefing"): Promise<string> {
    const item = await harness!.runtime.harness.commit(
      (tx) => createInboxItemTx(tx, { title, body: "the briefing", kind: "briefing" }),
      ctx,
    );
    return item.id;
  }

  it("stores the kind and stands as `briefing` while its job is live", async () => {
    await boot();
    const jobId = await routineJob();
    const created = await briefing(jobId, "Morning briefing 2026-11-01");

    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.kind).toBe("briefing");
    expect(reportKind(stored!)).toBe("briefing");
    expect(reportStanding(stored!, "active")).toBe("briefing");
    // The list marks the kind, as it does for a result report.
    const listed = textOf(await tool("reports_list").execute({ jobId }, api, ctx));
    expect(listed).toContain("kind=briefing");
    // And the API says the same one word.
    const view = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as Record<string, unknown>;
    expect(view["status"]).toBe("briefing");
    expect(view["active"]).toBe(true);
    expect(view["archived"]).toBe(false);
  });

  it("carries only Feedback: no press of Approve or Done is recorded", async () => {
    await boot();
    const jobId = await routineJob();
    const created = await briefing(jobId, "Morning briefing");

    const approve = await post(`/api/reports/${created.id}/approve`, { version: 1, via: "viewer" });
    expect(approve.status).toBe(409);
    expect((await approve.json()).error.code).toBe("briefing");
    const done = await post(`/api/reports/${created.id}/done`, { version: 1, via: "panel" });
    expect(done.status).toBe(409);
    expect((await done.json()).error.code).toBe("briefing");
    // Neither press wrote anything: the revision still carries no approval.
    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.versions[0]?.approval).toBeUndefined();
  });

  it("takes feedback, and an answer to it", async () => {
    await boot();
    const jobId = await routineJob();
    const created = await briefing(jobId, "Morning briefing");

    const note = await post(`/api/reports/${created.id}/feedback`, { body: "the weather is wrong", version: 1 });
    expect(note.status).toBe(201);
    // The note does not move a briefing: it stays at the top while its job lives.
    const waiting = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as Record<string, unknown>;
    expect(waiting["status"]).toBe("briefing");
    // `answer` is the one way back, and it is accepted.
    const answered = await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer: "the place was wrong; fixed" },
      api,
      ctx,
    );
    expect(answered.isError).toBeFalsy();
    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.answeredAt).toBeGreaterThan(0);
  });

  it("refuses to be set aside", async () => {
    await boot();
    const jobId = await routineJob();
    const created = await briefing(jobId, "Morning briefing");

    const aside = await tool("reports_set_pending").execute({ id: created.id, pending: true }, api, ctx);
    expect(aside.isError).toBe(true);
    expect(textOf(aside)).toContain("stays at the top under Briefing");
    expect((await harness!.runtime.reports.get(ctx, created.id))?.pendingAt).toBeUndefined();
  });

  it("is refused by the draft tools, and published by `reports_create` alone", async () => {
    await boot();
    const jobId = await routineJob();

    const drafted = await tool("reports_draft").execute(
      { jobId, title: "Briefing", content: "# Briefing\n", kind: "briefing" },
      api,
      ctx,
    );
    expect(drafted.isError).toBe(true);
    expect(textOf(drafted)).toContain("no draft stands behind one");
    // Nothing was written: no draft was left behind by the refusal.
    expect(textOf(await tool("reports_list").execute({ jobId }, api, ctx))).not.toContain("Drafts");

    const created = await tool("reports_create").execute(
      { jobId, title: "Briefing", content: "# Briefing\n", kind: "briefing" },
      api,
      ctx,
    );
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toContain("kind=briefing");
  });

  it("refuses `briefing` from `reports_publish_draft`, and keeps the draft", async () => {
    await boot();
    const jobId = await routineJob();
    const drafted = await tool("reports_draft").execute(
      { jobId, title: "Plan", content: "# Plan\n" },
      api,
      ctx,
    );
    const id = /^draft (\S+) written/.exec(textOf(drafted))?.[1] ?? "";
    expect(id).not.toBe("");

    const published = await tool("reports_publish_draft").execute({ id, jobId, kind: "briefing" }, api, ctx);
    expect(published.isError).toBe(true);
    expect(textOf(published)).toContain("not published from a draft");
    // The refusal leaves the draft where it was, as every refusal of this tool does.
    expect(textOf(await tool("reports_get").execute({ id }, api, ctx))).toContain("\"kind\": \"draft\"");
  });

  it("moves the briefing before it, its notices and the `briefing` notices into the archive", async () => {
    const h = await boot();
    const jobId = await routineJob();
    const legacy = await legacyBriefingNotice();
    const older = await briefing(jobId, "Morning briefing 2026-10-31");
    // A revision notice and an answer notice, beside the publication notice: three
    // notices about the older briefing, and the one the inbox kept before reports
    // carried briefings at all.
    const revised = await tool("reports_add_version").execute(
      { id: older.id, content: "# Briefing\n\ncorrected\n", note: "second" },
      api,
      ctx,
    );
    expect(revised.isError).toBeFalsy();
    const olderFeedback = await post(`/api/reports/${older.id}/feedback`, { body: "check the day", version: 2 });
    expect(olderFeedback.status).toBe(201);
    const answered = await tool("reports_set_pending").execute(
      { id: older.id, pending: false, answer: "the day is right" },
      api,
      ctx,
    );
    expect(answered.isError).toBeFalsy();
    const olderNotices = (await h.runtime.inbox.list(ctx)).filter((item) => item.source?.reportId === older.id);
    expect(olderNotices.map((item) => item.source?.reportEvent).sort()).toEqual(["answered", "published", "updated"]);

    const newer = await briefing(jobId, "Morning briefing 2026-11-01");

    // The live store holds the newest briefing and nothing older.
    expect(await h.runtime.reports.get(ctx, older.id)).toBeUndefined();
    const live = await h.runtime.reports.list(ctx);
    expect(live.filter((record) => reportKind(record) === "briefing").map((record) => record.id)).toEqual([newer.id]);

    // The archived record says when it left, and reads back with its kind.
    const archived = await h.runtime.reports.getArchived(ctx, older.id);
    expect(archived?.kind).toBe("briefing");
    expect(archived?.archivedAt).toBeGreaterThan(0);
    expect(archived?.feedback).toHaveLength(1);
    // The archive holds its notices too, and the live inbox holds none of them.
    const archivedNotices = (await h.runtime.reports.archivedInbox(ctx)).map((item) => item.id);
    for (const notice of olderNotices) expect(archivedNotices).toContain(notice.id);
    expect(archivedNotices).toContain(legacy);
    const liveInbox = await h.runtime.inbox.list(ctx);
    expect(liveInbox.filter((item) => item.kind === "briefing")).toEqual([]);
    expect(liveInbox.filter((item) => item.source?.reportId === older.id)).toEqual([]);
    // The notice about the new report stays: it is of kind `report`, and it names
    // the report that did not move.
    expect(liveInbox.filter((item) => item.source?.reportId === newer.id)).toHaveLength(1);

    // The body directory moved rather than being deleted.
    expect((await readdir(join(h.paths.archiveDir, "reports"))).sort()).toContain(older.id);

    // The audit trail says why a report left without its job.
    const rows = (await readAuditTail(h.paths.auditLog, undefined, 200)).filter(
      (event) => event.type === "report_archived",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "briefing-archived", reportId: older.id, title: "Morning briefing 2026-10-31" });
  });

  it("moves nothing when a plan or a result report is written", async () => {
    const h = await boot();
    const jobId = await routineJob();
    const older = await briefing(jobId, "Morning briefing");

    await post("/api/reports", { jobId, title: "A plan", content: "one\n" });
    await post("/api/reports", { jobId, title: "A result", content: "one\n", kind: "result" });

    expect(await h.runtime.reports.get(ctx, older.id)).toBeDefined();
    expect(await h.runtime.reports.listArchived(ctx)).toEqual([]);
  });

  it("finishes a move a crash interrupted, when the next briefing is written", async () => {
    const h = await boot();
    const jobId = await routineJob();
    const older = await briefing(jobId, "Morning briefing 2026-10-30");
    const middle = await briefing(jobId, "Morning briefing 2026-10-31");
    // The first briefing is archived by the second. Put it back exactly where a
    // crash between the copy and the retire leaves it: live, and already archived.
    const record = await h.runtime.reports.getArchived(ctx, older.id);
    expect(record).toBeDefined();
    await h.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecReport, older.id, older.id);
      draft.id = older.id;
      draft.jobId = record!.jobId;
      draft.name = record!.name;
      draft.title = record!.title;
      draft.kind = "briefing";
      draft.versions = record!.versions.map((version) => ({ ...version }));
      draft.feedback = [];
      draft.createdAt = record!.createdAt;
      draft.updatedAt = record!.updatedAt;
    }, ctx);
    expect(await h.runtime.reports.get(ctx, older.id)).toBeDefined();

    await briefing(jobId, "Morning briefing 2026-11-01");

    // The leftover is gone from the live store, and the live one before it too:
    // one briefing stays, and the archive holds one record per briefing.
    const live = (await h.runtime.reports.list(ctx)).filter((item) => reportKind(item) === "briefing");
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(older.id);
    expect(live[0]?.id).not.toBe(middle.id);
    const archivedIds = (await h.runtime.reports.listArchived(ctx))
      .filter((item) => reportKind(item) === "briefing")
      .map((item) => item.id)
      .sort();
    expect(archivedIds).toEqual([older.id, middle.id].sort());
  });

  it("reads an archived briefing by id, and says it is archived", async () => {
    const h = await boot();
    const jobId = await routineJob();
    const older = await briefing(jobId, "Morning briefing 2026-10-31", "# Briefing\n\nyesterday\n");
    await briefing(jobId, "Morning briefing 2026-11-01");

    const read = await tool("reports_get").execute({ id: older.id, includeBody: true }, api, ctx);
    expect(read.isError).toBeFalsy();
    const view = JSON.parse(textOf(read)) as { standing?: string; body?: string; title?: string };
    expect(view.standing).toBe("archived");
    expect(view.title).toBe("Morning briefing 2026-10-31");
    expect(view.body).toBe("# Briefing\n\nyesterday\n");

    const route = (await (await fetch(`${origin}/api/reports/${older.id}`)).json()) as Record<string, unknown>;
    expect(route["status"]).toBe("archived");
    expect(route["archived"]).toBe(true);
    expect(route["active"]).toBe(false);

    // The report stays readable through the tools that list the archive.
    const listed = textOf(await tool("reports_list").execute({ includeArchived: true }, api, ctx));
    expect(listed).toContain(older.id);
    expect(listed).toContain("Archived (moved out of the live store; still readable by id):");
    // Reading a body out of the archive works through the route as well.
    const body = await fetch(`${origin}/api/reports/${older.id}/versions/1`);
    expect(body.status).toBe(200);
    expect(await body.text()).toBe("# Briefing\n\nyesterday\n");
    expect(h.runtime.reports.archivedInbox !== undefined).toBe(true);
  });

  it("takes no feedback and no answer once it is archived", async () => {
    await boot();
    const jobId = await routineJob();
    const older = await briefing(jobId, "Morning briefing 2026-10-31");
    await briefing(jobId, "Morning briefing 2026-11-01");

    const note = await post(`/api/reports/${older.id}/feedback`, { body: "late note", version: 1 });
    expect(note.status).toBe(400);
    const answer = await tool("reports_set_pending").execute(
      { id: older.id, pending: false, answer: "late answer" },
      api,
      ctx,
    );
    expect(answer.isError).toBe(true);
  });

  it("never clears a gate that asks for an approved report", async () => {
    const h = await boot();
    const jobId = await routineJob();
    const created = await briefing(jobId, "Morning briefing");
    // A gate reads an approval from the newest revision; a briefing has none to
    // give, and its refusal says so rather than "no approval".
    const { checkApprovedReport } = await import("../src/jobs/registry.ts");
    const refused = await checkApprovedReport({
      reports: h.runtime.reports,
      context: ctx,
      reportId: created.id,
      wording: { act: "this test change", retry: () => "try again" },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("report_is_briefing");
  });
});
