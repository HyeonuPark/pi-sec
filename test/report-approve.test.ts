import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { APPROVAL_MARKER, approvalInput, approvalRequestId, parseApproval } from "../src/approvals/input.ts";
import { readMessage, wrapMessage } from "../src/message-envelope.ts";
import { parseReview } from "../src/review.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * The approval input, and the route that writes it.
 *
 * Two records are written for one press of Approve, and these tests hold both
 * ends: the approval on the exact revision in the store, and the input in the
 * conversation that says so. The order between them is part of the contract, so
 * a refusal is checked for the input it did *not* leave behind as well as for
 * the status code it returned.
 */

describe("approval input", () => {
  const target = { name: "261015-plan", version: 2, sha256: "a".repeat(64) };

  it("writes a marker line a reader can take apart", () => {
    const text = approvalInput(target, "Approved from the viewer.");
    expect(text.startsWith(`${APPROVAL_MARKER} report=261015-plan v=2 sha=${"a".repeat(64)}\n\n`)).toBe(true);
    expect(parseApproval(text)).toEqual({
      report: "261015-plan",
      version: 2,
      sha256: "a".repeat(64),
      text: "Approved from the viewer.",
    });
  });

  it("reads the envelope the route writes", () => {
    const stored = wrapMessage("operator", approvalInput(target, "Yes."), {
      via: "approval",
      approval: "01J-report/v2",
    });
    expect(readMessage(stored)?.source).toBe("operator");
    expect(parseApproval(stored)).toEqual({
      id: "01J-report",
      report: "261015-plan",
      version: 2,
      sha256: "a".repeat(64),
      text: "Yes.",
    });
  });

  it("is not a review, even though it names a report", () => {
    // The reason the report name is in the body and not in the envelope: a
    // `report=` attribute would make `parseReview` claim this entry, and an
    // approval would arrive as feedback.
    const stored = wrapMessage("operator", approvalInput(target, "Yes."), { via: "approval" });
    expect(parseReview(stored)).toBeUndefined();
  });

  it("refuses a marker line inside a message of another kind", () => {
    // A tool result can quote the marker line. The envelope's `via` is what
    // decides, so quoted text cannot pass for an approval.
    const quoted = wrapMessage("tool-output", `${APPROVAL_MARKER} report=x v=1 sha=${"b".repeat(64)}\n\nlook`);
    expect(parseApproval(quoted)).toBeUndefined();
    expect(parseApproval(`${APPROVAL_MARKER} report=x v=1 sha=${"b".repeat(64)}\n\nlook`)).toMatchObject({
      report: "x",
      version: 1,
    });
  });

  it("asks for a report and a revision, and ignores a marker line without them", () => {
    expect(parseApproval(`${APPROVAL_MARKER} report=x\n\nlook`)).toBeUndefined();
    expect(parseApproval(`${APPROVAL_MARKER} v=1\n\nlook`)).toBeUndefined();
    expect(parseApproval("[pi-sec review] report=x v=1\n\nlook")).toBeUndefined();
    expect(parseApproval("plain text")).toBeUndefined();
  });

  it("names one admission per report revision", () => {
    expect(approvalRequestId("01J-report", 3)).toBe("report-approve:01J-report:3");
  });
});

describe("approve route", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<string> {
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
    return started.origin;
  }

  function post(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A live job with one report on it, through the public routes. */
  async function report(
    origin: string,
    title = "Plan",
    kind?: "result",
  ): Promise<{ id: string; name: string; sha256: string; jobId: string }> {
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", {
      jobId: job.id,
      title,
      content: "one\n",
      ...(kind === undefined ? {} : { kind }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; versions: { sha256: string }[] };
    return { id: body.id, name: body.name, sha256: body.versions[0]!.sha256, jobId: job.id };
  }

  /** Every user-role entry in the default conversation, oldest first. */
  async function userTexts(): Promise<string[]> {
    const conversation = await resolveDefaultConversation(
      harness!.runtime.harness,
      harness!.runtime.getConfig(),
      harness!.runtime.paths,
      ctx,
    );
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx as Context);
    return page.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) =>
        (entry.model ?? [])
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n"),
      );
  }

  it("records the approval and puts the input in the conversation", async () => {
    const origin = await boot();
    const created = await report(origin);
    const seen: string[] = [];
    const off = harness!.events.subscribe((event) => {
      if (event.type === "report_updated") seen.push(String(event.data["id"]));
    });

    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "panel" });
    off();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; version: number; approval: Record<string, unknown> };
    expect(body.id).toBe(created.id);
    expect(body.version).toBe(1);
    expect(body.approval).toMatchObject({ via: "panel", sha256: created.sha256 });
    expect(Number(body.approval["at"])).toBeGreaterThan(0);
    // The record is on the revision, and the surface is the one the caller named.
    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      versions: { approval?: { via: string; sha256: string } }[];
    };
    expect(stored.versions[0]!.approval).toMatchObject({ via: "panel", sha256: created.sha256 });
    expect(seen).toEqual([created.id]);

    // The input went through the labelled interface, and it parses back to the
    // revision that was approved.
    const texts = await userTexts();
    expect(texts).toHaveLength(1);
    // The stored shape the take-off checklist reads: the envelope names the report
    // id and the surface, and the second line is the marker line.
    const [first, second] = texts[0]!.split("\n");
    expect(first).toMatch(
      new RegExp(`^<pi-message src="operator" approval="${created.id}/v1" at="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\+00:00" via="approval">$`),
    );
    expect(second).toBe(`${APPROVAL_MARKER} report=${created.name} v=1 sha=${created.sha256}`);
    const envelope = readMessage(texts[0]!);
    expect(envelope?.format).toBe("envelope");
    expect(envelope?.source).toBe("operator");
    expect(envelope?.attrs).toMatchObject({ via: "approval", approval: `${created.id}/v1` });
    expect(parseApproval(texts[0]!)).toMatchObject({
      id: created.id,
      report: created.name,
      version: 1,
      sha256: created.sha256,
    });
    // And it is not read as feedback by anything that knows the review marker.
    expect(parseReview(texts[0]!)).toBeUndefined();
  });

  it("sets the report aside with the same press, and its notice stops asking", async () => {
    const origin = await boot();
    const created = await report(origin);
    const seen: Record<string, unknown>[] = [];
    const off = harness!.events.subscribe((event) => {
      if (event.type === "report_updated") seen.push(event.data as Record<string, unknown>);
    });

    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "panel" });
    off();
    expect(response.status).toBe(201);

    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      status: string;
      active: boolean;
      archived: boolean;
      pendingAt?: number;
      versions: { approval?: { via: string; sha256: string } }[];
    };
    // Both records landed together, and the one word the viewer reads is pending
    // while `active` still answers the question about the job.
    expect(stored.status).toBe("pending");
    expect(stored.active).toBe(true);
    expect(stored.archived).toBe(false);
    expect(stored.pendingAt).toBeGreaterThan(0);
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0]!.approval).toMatchObject({ via: "panel", sha256: created.sha256 });

    // The single event carries the new standing, so a page that does not refetch
    // still moves the report out of the waiting list.
    expect(seen.map((event) => event["id"])).toEqual([created.id]);
    expect(seen[0]).toMatchObject({ status: "pending" });

    // The report's notice keeps its place in the inbox and stops raising the
    // unread badge, because the inbox reads the same flag.
    const inbox = (await (await fetch(`${origin}/api/inbox`)).json()) as { items: { pending?: boolean }[] };
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.pending).toBe(true);

    // The set-aside is the operator's to undo, and undoing it leaves the approval
    // and the revision where they were.
    expect((await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "panel" })).status).toBe(409);
    expect((await harness!.runtime.reports.setPending(ctx, created.id, false)).ok).toBe(true);
    const back = await harness!.runtime.reports.get(ctx, created.id);
    expect(back?.pendingAt).toBeUndefined();
    expect(back?.versions[0]?.approval).toMatchObject({ via: "panel", sha256: created.sha256 });
  });

  it("brings an approved report back to active when a new revision lands", async () => {
    const origin = await boot();
    const created = await report(origin);
    const pressed = await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "panel" });
    expect(pressed.status).toBe(201);

    const added = await post(origin, `/api/reports/${created.id}/versions`, { content: "two\n", note: "second" });
    expect(added.status).toBe(201);
    const view = (await added.json()) as {
      status: string;
      pendingAt?: number;
      versions: { approval?: unknown }[];
    };

    // v2 carries no approval, so it is waiting on an answer, and the word the page
    // shows is the one that says so. The set-aside answered the revision before it.
    expect(view.status).toBe("active");
    expect(view.pendingAt).toBeUndefined();
    expect(view.versions).toHaveLength(2);
    expect(view.versions[1]?.approval).toBeUndefined();
    expect((await (await fetch(`${origin}/api/reports/${created.id}`)).json())).toMatchObject({ status: "active" });

    // Its notice asks to be read: with no `pending` field it counts toward the
    // unread badge, which is what tells the operator a new revision is waiting. The
    // marker is derived from the record when the inbox is read rather than stored on
    // the item, so clearing the flag takes it off every notice about this report.
    const inbox = (await (await fetch(`${origin}/api/inbox`)).json()) as {
      items: { title: string; pending?: boolean; source?: { reportId?: string; reportEvent?: string } }[];
    };
    const revised = inbox.items.find((item) => item.source?.reportEvent === "updated");
    // The header string is gone, the revision number is not: the two notices about
    // this report read "Plan" and "Plan (v2)", and the source says which is which.
    expect(revised?.title).toBe("Plan (v2)");
    expect(revised?.pending).toBeUndefined();
    const published = inbox.items.find((item) => item.source?.reportEvent === "published");
    expect(published?.title).toBe("Plan");
    expect(published?.pending).toBeUndefined();
  });

  it("defaults the surface to the viewer", async () => {
    const origin = await boot();
    const created = await report(origin);
    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1 });
    expect(response.status).toBe(201);
    expect((await response.json()).approval.via).toBe("viewer");
  });

  it("refuses a second approval without putting a second input in", async () => {
    const origin = await boot();
    const created = await report(origin);
    await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "viewer" });

    const again = await post(origin, `/api/reports/${created.id}/approve`, { version: 1, via: "panel" });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: { code: string }; approval: { via: string } };
    expect(body.error.code).toBe("already_approved");
    // The record keeps the surface and the moment of the real approval, and that
    // record is beside `error` because the feedback bar reads it there.
    expect(body.approval.via).toBe("viewer");
    expect(await userTexts()).toHaveLength(1);
  });

  it("refuses a revision that is no longer the newest, and says which one is", async () => {
    const origin = await boot();
    const created = await report(origin);
    const added = await post(origin, `/api/reports/${created.id}/versions`, { content: "two\n", note: "second" });
    const second = (await added.json()) as { versions: { sha256: string }[] };

    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1 });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string }; latest: number; latestSha256: string };
    expect(body.error.code).toBe("stale_revision");
    expect(body.latest).toBe(2);
    expect(body.latestSha256).toBe(second.versions[1]!.sha256);
    // A refusal taken before the input was submitted leaves the conversation
    // untouched: no message claims an approval that was never recorded.
    expect(await userTexts()).toEqual([]);
    // A revision that does not exist is refused the same way.
    const missing = await post(origin, `/api/reports/${created.id}/approve`, { version: 9 });
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.code).toBe("stale_revision");

    // The newest revision is the one that can be approved.
    expect((await post(origin, `/api/reports/${created.id}/approve`, { version: 2 })).status).toBe(201);
  });

  it("refuses a report whose job has finished", async () => {
    const origin = await boot();
    const created = await report(origin);
    const job = (await harness!.runtime.jobs.list(ctx))[0]!;
    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });

    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1 });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string }; status: string };
    expect(body.error.code).toBe("not_active");
    expect(body.status).toBe("done");
    expect(await userTexts()).toEqual([]);
    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      active: boolean;
      versions: { approval?: unknown }[];
    };
    // The screen and the server agree about which reports can be approved.
    expect(stored.active).toBe(false);
    expect(stored.versions[0]!.approval).toBeUndefined();
  });

  it("refuses a report that moved to the archive with its job", async () => {
    const origin = await boot();
    const created = await report(origin);
    const job = (await harness!.runtime.jobs.list(ctx))[0]!;
    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });
    await harness!.runtime.archive.sweep(ctx, 0);

    const response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1 });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("refuses a report it does not have", async () => {
    const origin = await boot();
    expect((await post(origin, "/api/reports/no-such-report/approve", { version: 1 })).status).toBe(404);
  });

  it("answers not_found at the store without writing a report", async () => {
    harness = await createTestHarness();
    expect(await harness.runtime.reports.checkApproval(ctx, "no-such-report", 1)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await harness.runtime.reports.list(ctx)).toEqual([]);
  });

  it("treats a job the live store does not have as inactive, and seeds no job row", async () => {
    harness = await createTestHarness();
    const reports = harness.runtime.reports;
    // A report whose job is gone from the live store: the archive sweep retires
    // the report a moment later, and until it does the report is read-only.
    const report = await reports.create(ctx, { jobId: "01J-ghost", title: "Orphan", content: "one\n" });

    expect(await reports.checkApproval(ctx, report.id, 1)).toEqual({ ok: false, reason: "not_active", status: undefined });
    // Reading the job does not write one: a refusal must leave no trace.
    expect(await harness.runtime.jobs.list(ctx)).toEqual([]);
    expect((await reports.get(ctx, report.id))?.versions[0]?.approval).toBeUndefined();
  });

  it("reports the job's status when the job finished", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(ctx, { title: "work" });
    const report = await harness.runtime.reports.create(ctx, { jobId: job.id, title: "Done", content: "one\n" });
    await harness.runtime.jobs.update(ctx, job.id, { status: "cancelled" });
    expect(await harness.runtime.reports.checkApproval(ctx, report.id, 1)).toEqual({
      ok: false,
      reason: "not_active",
      status: "cancelled",
    });
  });

  it("hands back the report and the revision it would approve", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(ctx, { title: "work" });
    const report = await harness.runtime.reports.create(ctx, { jobId: job.id, title: "Live", content: "one\n" });
    const check = await harness.runtime.reports.checkApproval(ctx, report.id, 1);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("expected the revision to be approvable");
    expect(check.report.id).toBe(report.id);
    expect(check.version).toMatchObject({ n: 1, sha256: report.versions[0]!.sha256 });
  });

  it("refuses a body that names no revision", async () => {
    const origin = await boot();
    const created = await report(origin);
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: "second" }, { version: 1, via: "email" }]) {
      const response = await post(origin, `/api/reports/${created.id}/approve`, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect(await userTexts()).toEqual([]);
  });

  it("writes no record when the input cannot be delivered", async () => {
    const origin = await boot();
    const created = await report(origin);
    // The one failure a route cannot be talked out of: the conversation it must
    // submit into is not reachable. The record must not exist without the input.
    const runtime = harness!.runtime as unknown as { harness: unknown };
    const real = runtime.harness;
    runtime.harness = {
      root: () => {
        throw new Error("the conversation is unavailable");
      },
    };
    let response: Response;
    try {
      response = await post(origin, `/api/reports/${created.id}/approve`, { version: 1 });
    } finally {
      runtime.harness = real;
    }
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("delivery_failed");

    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      versions: { approval?: unknown }[];
    };
    expect(stored.versions[0]!.approval).toBeUndefined();
    expect(await userTexts()).toEqual([]);
    // The same press is taken again once the conversation is reachable, and the
    // request id keeps one admission.
    expect((await post(origin, `/api/reports/${created.id}/approve`, { version: 1 })).status).toBe(201);
    expect(await userTexts()).toHaveLength(1);
  });
});

/**
 * Done, the approve button of a result report.
 *
 * It records the same approval as Approve, on the same revision, and the record
 * says which button was pressed. Its text is the user's request for follow-up
 * work, and it goes into the conversation as part of the same input rather than as
 * feedback: an approval stands either way, and a Done with text asks for a new
 * piece of work on top of it.
 */
describe("done route", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<string> {
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
    return started.origin;
  }

  function post(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A live job, and one report on it of the kind named. */
  async function report(
    origin: string,
    kind: "plan" | "result",
    title = kind === "result" ? "Run log" : "Plan",
  ): Promise<{ id: string; name: string; sha256: string; jobId: string }> {
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title, content: "one\n", kind });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; versions: { sha256: string }[] };
    return { id: body.id, name: body.name, sha256: body.versions[0]!.sha256, jobId: job.id };
  }

  /** Every user-role entry in the default conversation, oldest first. */
  async function userTexts(): Promise<string[]> {
    const conversation = await resolveDefaultConversation(
      harness!.runtime.harness,
      harness!.runtime.getConfig(),
      harness!.runtime.paths,
      ctx,
    );
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx as Context);
    return page.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) =>
        (entry.model ?? [])
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n"),
      );
  }

  it("records the approval on the revision with the button named, and writes no follow-up", async () => {
    const origin = await boot();
    const created = await report(origin, "result");

    const response = await post(origin, `/api/reports/${created.id}/done`, { version: 1, via: "panel" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; version: number; approval: Record<string, unknown> };
    expect(body.id).toBe(created.id);
    expect(body.version).toBe(1);
    expect(body.approval).toMatchObject({ via: "panel", sha256: created.sha256, button: "done" });
    // The text is absent rather than empty: a Done with nothing written is one
    // press and nothing more.
    expect(body.approval["text"]).toBeUndefined();

    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      status: string;
      versions: { approval?: { button?: string; sha256: string } }[];
    };
    expect(stored.versions[0]!.approval).toMatchObject({ button: "done", sha256: created.sha256 });
    // The press is also the set-aside, exactly as Approve is: the user has nothing
    // left to do with this revision.
    expect(stored.status).toBe("pending");
  });

  it("writes the input the root reads: the Done sentence, and no follow-up paragraph", async () => {
    const origin = await boot();
    const created = await report(origin, "result");
    const response = await post(origin, `/api/reports/${created.id}/done`, { version: 1, via: "viewer" });
    expect(response.status).toBe(201);

    const texts = await userTexts();
    expect(texts).toHaveLength(1);
    const [first, second] = texts[0]!.split("\n");
    expect(first).toMatch(
      new RegExp(`^<pi-message src="operator" approval="${created.id}/v1" at="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\+00:00" via="approval">$`),
    );
    expect(second).toBe(`${APPROVAL_MARKER} report=${created.name} v=1 sha=${created.sha256} button=done`);
    expect(parseApproval(texts[0]!)).toMatchObject({
      id: created.id,
      report: created.name,
      version: 1,
      sha256: created.sha256,
      button: "done",
    });
    const envelope = readMessage(texts[0]!);
    expect(envelope?.attrs["via"]).toBe("approval");
    // The sentence says Done was pressed and that this is the approval, so the root
    // does not have to decide what a Done with no text means.
    expect(envelope?.body).toContain(`The user pressed Done on revision 1 of "Run log" (/report/${created.name}) from the report viewer.`);
    expect(envelope?.body).toContain("This is the approval of the text hashed above, the same as Approve.");
    // Nothing about follow-up work, because the user asked for none.
    expect(envelope?.body).not.toContain("follow-up work");
    // And it is not feedback: a Done is not a note the owner has to answer.
    expect(parseReview(texts[0]!)).toBeUndefined();
  });

  it("carries the follow-up request when the user wrote one", async () => {
    const origin = await boot();
    const created = await report(origin, "result", "Second run");
    const words = "Run the same check on the second machine.";
    const response = await post(origin, `/api/reports/${created.id}/done`, { version: 1, via: "panel", text: words });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { approval: { text?: string; button?: string } };
    expect(body.approval).toMatchObject({ button: "done", text: words });

    const texts = await userTexts();
    const envelope = readMessage(texts[0]!);
    // The user's words are in the input as they wrote them, with the ids the root
    // needs to hand the request on.
    expect(envelope?.body).toContain(
      `The user also asked for follow-up work with Done. The approval of this revision stands. Hand the request over as a new request, with report ${created.id}, job ${created.jobId}, and the title above as context. The user's words:`,
    );
    expect(envelope?.body?.endsWith(`\n\n${words}`)).toBe(true);
    // The record keeps the same words, so the approval names what was asked for.
    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      versions: { approval?: { text?: string } }[];
      feedback: unknown[];
    };
    expect(stored.versions[0]!.approval?.text).toBe(words);
    expect(stored.feedback).toEqual([]);
  });

  it("refuses Done on a plan, and puts nothing in the conversation", async () => {
    const origin = await boot();
    const created = await report(origin, "plan");

    const response = await post(origin, `/api/reports/${created.id}/done`, { version: 1, via: "panel" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("not_a_result");
    expect(await userTexts()).toEqual([]);
    const stored = (await (await fetch(`${origin}/api/reports/${created.id}`)).json()) as {
      versions: { approval?: unknown }[];
    };
    expect(stored.versions[0]!.approval).toBeUndefined();
  });

  it("refuses Done on a report whose job has finished, and on one it does not have", async () => {
    const origin = await boot();
    const created = await report(origin, "result");
    const job = (await harness!.runtime.jobs.list(ctx))[0]!;
    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });

    const response = await post(origin, `/api/reports/${created.id}/done`, { version: 1, via: "panel" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string }; status: string };
    expect(body.error.code).toBe("not_active");
    expect(body.status).toBe("done");
    expect(await userTexts()).toEqual([]);

    expect((await post(origin, "/api/reports/no-such-report/done", { version: 1 })).status).toBe(404);
  });

  it("keeps the gates reading the Done record as an approval", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(ctx, { title: "work" });
    const report = await harness.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Run log",
      content: "one\n",
      kind: "result",
    });
    await harness.runtime.reports.approve(ctx, report.id, 1, { via: "panel", button: "done" });

    // Both gates read the newest revision's approval and its sha256, and nothing
    // else, so a Done closes them exactly as Approve does.
    const check = await harness.runtime.reports.checkApproval(ctx, report.id, 1);
    expect(check.ok).toBe(false);
    if (check.ok || check.reason !== "already_approved") throw new Error("expected the Done record to count");
    expect(check.approval.sha256).toBe(report.versions[0]!.sha256);
    expect(check.approval.button).toBe("done");
  });
});
