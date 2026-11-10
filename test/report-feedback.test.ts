import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import type { StartedServer } from "../src/server/server.ts";
import { ReportStore, awaitingAnswer } from "../src/reports/store.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * Operator feedback, and the two forms of the answer.
 *
 * A note moves the report to `pending` in the same commit that stores it, so the
 * operator's Active list stops asking about it. The owner then answers: a new
 * revision, which is the report write path, or a message, which is
 * `reports_set_pending {pending: false, answer}`. These tests hold both forms and
 * the refusals around them, at the level the tools and the routes reach.
 *
 * The report is read through the same routes the viewer uses, so what the operator
 * sees is what is asserted rather than an internal field.
 */

describe("report feedback and the answer", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  let origin = "";

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<void> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    started = await startTestServer(harness);
    origin = started.origin;
  }

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A live job with one report on it, through the public routes. */
  async function report(title = "Plan"): Promise<{ id: string; name: string; jobId: string }> {
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post("/api/reports", { jobId: job.id, title, content: "one\n" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string };
    return { id: body.id, name: body.name, jobId: job.id };
  }

  /** The report as the viewer reads it. */
  interface ReportView {
    status: string;
    active: boolean;
    archived: boolean;
    pendingAt?: number;
    versions: { n: number; approval?: unknown }[];
    feedback: { body: string; from: string }[];
  }

  /** One inbox item as the inbox route reports it. */
  interface InboxView {
    id: string;
    kind?: string;
    title: string;
    body: string;
    pending?: boolean;
    source?: { reportId?: string; jobId?: string };
  }

  async function view(id: string): Promise<ReportView> {
    const response = await fetch(`${origin}/api/reports/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ReportView;
  }

  async function inbox(): Promise<InboxView[]> {
    const response = await fetch(`${origin}/api/inbox`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: InboxView[] }).items;
  }

  function tool(name: string): ToolRegistration {
    const entry = harness!.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool;
  }

  const api = { conversationId: 1 } as unknown as ToolExecutionApi;

  /** The api `notify` needs: an id, and a commit into the session it writes through. */
  function execApi(): ToolExecutionApi {
    const h = harness!;
    return {
      conversationId: 1,
      commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: typeof ctx) =>
        h.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  const NOTE = "the second step is wrong";

  it("sets the report aside when the operator leaves a note, and a revision brings it back", async () => {
    await boot();
    const created = await report();

    const before = await inbox();
    expect(before).toHaveLength(1);
    expect(before[0]?.pending).toBeUndefined();

    const feedback = await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });
    expect(feedback.status).toBe(201);

    // One word for the screen: the report is set aside, while `active` still
    // answers the question the approval path asks about the job.
    const aside = await view(created.id);
    expect(aside.status).toBe("pending");
    expect(aside.active).toBe(true);
    expect(aside.archived).toBe(false);
    expect(aside.pendingAt).toBeGreaterThan(0);

    // Its notice keeps its place and stops raising the unread badge, because the
    // inbox reads the same flag.
    const marked = await inbox();
    expect(marked).toHaveLength(1);
    expect(marked[0]?.pending).toBe(true);

    // The revision form of the answer: the report comes back without the root
    // having to do anything, and the note it answered stays on the record.
    const added = await post(`/api/reports/${created.id}/versions`, { content: "one\ntwo\n", note: "second" });
    expect(added.status).toBe(201);
    const revised = await view(created.id);
    expect(revised.status).toBe("active");
    expect(revised.pendingAt).toBeUndefined();
    expect(revised.versions).toHaveLength(2);
    expect(revised.feedback).toHaveLength(1);
    expect((await inbox()).every((item) => item.pending === undefined)).toBe(true);
  });

  it("refuses to bring the report back without an answer, and writes nothing", async () => {
    await boot();
    const created = await report();
    await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });
    const stored = (await harness!.runtime.reports.get(ctx, created.id))!;
    const notices = await inbox();

    // The store refuses with a reason, and the tool with a sentence a person can
    // read. Neither writes anything: the flag, the timestamp and the inbox are
    // exactly where the note left them.
    expect(await harness!.runtime.reports.setPending(ctx, created.id, false)).toEqual({
      ok: false,
      reason: "answer_required",
    });
    const refused = await tool("reports_set_pending").execute({ id: created.id, pending: false }, api, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("needs the answer in `answer`");

    const after = (await harness!.runtime.reports.get(ctx, created.id))!;
    expect(after.pendingAt).toBe(stored.pendingAt);
    expect(after.updatedAt).toBe(stored.updatedAt);
    expect(await inbox()).toHaveLength(notices.length);
    expect((await view(created.id)).status).toBe("pending");
  });

  it("answers with a message: one call clears the flag and writes the notice", async () => {
    await boot();
    const created = await report();
    await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });
    const before = new Set((await inbox()).map((item) => item.id));
    const answer = "The second step stands: the retry is what makes the first one safe.";

    const result = await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer },
      api,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("active");
    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.pendingAt).toBeUndefined();
    // A message answers without touching the document, so the revision and the
    // approval button on it are exactly where they were.
    expect(stored?.versions).toHaveLength(1);

    const written = (await inbox()).filter((item) => !before.has(item.id));
    expect(written).toHaveLength(1);
    const item = written[0]!;
    expect(item.kind).toBe("report");
    expect(item.source?.reportId).toBe(created.id);
    expect(item.source?.jobId).toBe(created.jobId);
    // No header string on the title: the row says the kind from the field, and the
    // title is the report's own name.
    expect(item.title).toBe("Plan");
    expect(item.source?.reportEvent).toBe("answered");
    // The answer is the body, with the address a report write would have used
    // under it, so the item reads like every other report notice.
    const lines = item.body.split("\n");
    expect(lines[0]).toBe(answer);
    expect(lines.slice(-3)).toEqual([`/report/${created.name}`, `job ${created.jobId}`, "v1"]);
  });

  it("refuses an answer on a report that is not waiting for one", async () => {
    await boot();
    const created = await report();
    // A set-aside the approval made. The owner owes the operator nothing for a
    // button they pressed, so there is nothing here for an answer to answer.
    const pressed = await post(`/api/reports/${created.id}/approve`, { version: 1, via: "panel" });
    expect(pressed.status).toBe(201);
    expect((await view(created.id)).status).toBe("pending");

    expect(await harness!.runtime.reports.setPending(ctx, created.id, false, { answer: "nothing to answer" })).toEqual({
      ok: false,
      reason: "not_awaiting",
    });
    // The refusal leaves the report where it was, so a caller is never told an
    // answer was recorded when nothing was asking.
    expect((await harness!.runtime.reports.get(ctx, created.id))?.pendingAt).toBeGreaterThan(0);
  });

  it("ignores an answer sent while the report is being set aside", async () => {
    await boot();
    const created = await report();
    const before = await inbox();
    const stored = (await harness!.runtime.reports.get(ctx, created.id))!;

    // Setting a report aside asks nothing, so there is nothing for an answer to
    // answer: the call still works, and the answer is what it drops.
    const result = await tool("reports_set_pending").execute(
      { id: created.id, pending: true, answer: "this must be ignored" },
      api,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("pending");
    const after = (await harness!.runtime.reports.get(ctx, created.id))!;
    expect(after.pendingAt).toBeGreaterThan(0);
    // Nothing else moved: the answer is not stored as feedback, the document keeps
    // its one revision, and no notice is written for it.
    expect(after.versions).toHaveLength(stored.versions.length);
    expect(after.feedback).toHaveLength(0);
    expect(await inbox()).toHaveLength(before.length);
    expect((await view(created.id)).status).toBe("pending");
    expect((await inbox())[0]?.pending).toBe(true);
  });

  it("answers a report whose job has finished by notice alone", async () => {
    await boot();
    const created = await report();
    await harness!.runtime.jobs.update(ctx, created.jobId, { status: "done" });

    // The report is not live work any more, so there is no flag to clear and the
    // refusal is the one this call always gave for a finished job.
    expect(await harness!.runtime.reports.setPending(ctx, created.id, false, { answer: "still stands" })).toEqual({
      ok: false,
      reason: "not_active",
      status: "done",
    });

    const before = new Set((await inbox()).map((item) => item.id));
    const result = await tool("notify").execute(
      { title: "Report answered: Plan", body: "still stands", reportId: created.id },
      execApi(),
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const written = (await inbox()).filter((item) => !before.has(item.id));
    expect(written).toHaveLength(1);
    expect(written[0]?.kind).toBe("report");
    expect(written[0]?.source?.reportId).toBe(created.id);
    expect(written[0]?.body).toContain("still stands");
  });

  it("takes the unanswered mark off when the answer is a message", async () => {
    await boot();
    const created = await report();
    await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });

    const marked = textOf(await tool("reports_list").execute({}, api, ctx));
    expect(marked).toContain(" pending");
    expect(marked).toContain(" unanswered");

    await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer: "It stands because of the retry." },
      api,
      ctx,
    );

    // The same predicate the revision form clears, cleared from the other path.
    const cleared = textOf(await tool("reports_list").execute({}, api, ctx));
    expect(cleared).not.toContain("unanswered");
    expect(cleared).not.toContain(" pending");
  });

  it("does not ask the answered question again when the report is set aside again", async () => {
    await boot();
    const created = await report();
    await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });
    await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer: "The second step stands: the retry makes it safe." },
      api,
      ctx,
    );
    // The message left a time behind, which is the only trace of an answer that
    // writes no revision.
    const answered = await harness!.runtime.reports.get(ctx, created.id);
    expect(answered?.answeredAt).toBeGreaterThan(0);
    expect(answered?.answeredAt).toBe(answered?.updatedAt);

    const aside = await tool("reports_set_pending").execute({ id: created.id, pending: true }, api, ctx);
    expect(aside.isError).toBeUndefined();

    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.pendingAt).toBeGreaterThan(0);
    // Set aside is not the same as unanswered: this note already got its answer.
    expect(awaitingAnswer(stored!)).toBe(false);
    const listed = textOf(await tool("reports_list").execute({}, api, ctx));
    expect(listed).toContain(" pending");
    expect(listed).not.toContain("unanswered");
  });

  it("asks again when the operator writes a note after the message answer", async () => {
    await boot();
    const created = await report();
    await post(`/api/reports/${created.id}/feedback`, { body: NOTE, version: 1 });
    await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer: "The second step stands: the retry makes it safe." },
      api,
      ctx,
    );
    // The note has to be newer than the answer, and the two times are milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await post(`/api/reports/${created.id}/feedback`, { body: "now the third step is wrong" });
    expect(second.status).toBe(201);

    const stored = await harness!.runtime.reports.get(ctx, created.id);
    expect(stored?.answeredAt).toBeLessThan(stored!.feedback.at(-1)!.at);
    expect(awaitingAnswer(stored!)).toBe(true);
    expect(textOf(await tool("reports_list").execute({}, api, ctx))).toContain("unanswered");
  });
});

/** A revision and a note as `awaitingAnswer` reads them, with only the two times set. */
function version(n: number, at: number) {
  return { n, at, bytes: 1, sha256: "0" };
}

function note(at: number, from: "operator" | "agent") {
  return { id: `f${at}`, at, body: "note", from };
}

describe("awaitingAnswer and the time of a message answer", () => {
  it("judges a record without answeredAt exactly as before", () => {
    // The note and the revision case, the revision being newer, no note, a note
    // from the agent, and no flag. These are the cases the old shape answered.
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [note(200, "operator")] })).toBe(
      true,
    );
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 300)], feedback: [note(200, "operator")] })).toBe(
      false,
    );
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [] })).toBe(false);
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [note(200, "agent")] })).toBe(false);
    expect(awaitingAnswer({ versions: [version(1, 100)], feedback: [note(200, "operator")] })).toBe(false);
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [] })).toBe(false);
  });

  it("counts a message answer as the answer to every older note", () => {
    // Answered after the note: not waiting. A note written after the answer:
    // waiting again. A note written before it: still answered.
    expect(
      awaitingAnswer({ pendingAt: 300, answeredAt: 300, versions: [version(1, 100)], feedback: [note(200, "operator")] }),
    ).toBe(false);
    expect(
      awaitingAnswer({ pendingAt: 500, answeredAt: 400, versions: [version(1, 100)], feedback: [note(450, "operator")] }),
    ).toBe(true);
    expect(
      awaitingAnswer({ pendingAt: 400, answeredAt: 400, versions: [version(1, 100)], feedback: [note(300, "operator")] }),
    ).toBe(false);
  });
});

/**
 * The two answer checks `setPending` makes, staged against each other.
 *
 * The note below is written from the store's own clock read, which falls between
 * the check outside the commit and the check inside it. A session runs its commits
 * in call order (`#enqueue` in the durable session chains them onto one tail), so
 * the note's commit is placed first and has landed by the time the second check
 * runs. That makes the race a rendezvous rather than a matter of timing.
 */
describe("the set-aside re-check", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("refuses when the note that makes the report wait lands between the two checks", async () => {
    harness = await createTestHarness();
    const h = harness;
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const at = new Date(2026, 9, 15, 12, 0, 0).getTime();

    let armed = false;
    let race: Promise<unknown> = Promise.resolve();
    const store: ReportStore = new ReportStore({
      session: h.runtime.harness,
      storage: h.runtime.storage,
      reportsDir: h.paths.reportsDir,
      archiveDir: h.paths.archiveDir,
      now: () => {
        if (armed) {
          armed = false;
          race = store.addFeedback(ctx, report.id, { body: "the second step is wrong", version: 1 });
        }
        return at;
      },
    });
    const report = await store.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });

    // Nothing is waiting when the call starts, so the check outside the commit lets
    // it through with no answer. The note lands before the commit reads the record,
    // and the second check is what stops the flag being cleared without one.
    armed = true;
    const outcome = await store.setPending(ctx, report.id, false);
    await race;

    expect(outcome).toEqual({ ok: false, reason: "answer_required" });
    const stored = await store.get(ctx, report.id);
    expect(stored?.pendingAt).toBe(at);
    expect(awaitingAnswer(stored!)).toBe(true);
  });
});

/**
 * Feedback on a result report.
 *
 * A result report is listed under Results, and its buttons are Done and Feedback.
 * Feedback on it asks for more in the same report, and it moves the report the way
 * feedback on a plan moves it: under Pending while the answer is owed, and back
 * under Results once it is answered. The one thing that differs is that the report
 * cannot be set aside while the user still has to look at it.
 */
describe("feedback on a result report", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  let origin = "";

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<void> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    started = await startTestServer(harness);
    origin = started.origin;
  }

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function result(): Promise<{ id: string; name: string; jobId: string }> {
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post("/api/reports", { jobId: job.id, title: "Run log", content: "one\n", kind: "result" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; status: string };
    // The report is under Results from the moment it exists.
    expect(body.status).toBe("result");
    return { id: body.id, name: body.name, jobId: job.id };
  }

  async function statusOf(id: string): Promise<{ status: string; pendingAt?: number; versions: unknown[] }> {
    return (await (await fetch(`${origin}/api/reports/${id}`)).json()) as {
      status: string;
      pendingAt?: number;
      versions: unknown[];
    };
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

  it("moves a result report under Pending while the answer is owed, and back to Results after a revision", async () => {
    await boot();
    const created = await result();
    expect((await statusOf(created.id)).status).toBe("result");

    const feedback = await post(`/api/reports/${created.id}/feedback`, { body: "the count is off", version: 1 });
    expect(feedback.status).toBe(201);
    const waiting = await statusOf(created.id);
    expect(waiting.status).toBe("pending");
    expect(waiting.pendingAt).toBeGreaterThan(0);
    expect(awaitingAnswer((await harness!.runtime.reports.get(ctx, created.id))!)).toBe(true);

    const added = await post(`/api/reports/${created.id}/versions`, { content: "two\n", note: "second" });
    expect(added.status).toBe(201);
    const revised = await statusOf(created.id);
    // The revision carries no approval, so the user has something to look at
    // again and the report is back under Results.
    expect(revised.status).toBe("result");
    expect(revised.pendingAt).toBeUndefined();
    expect(revised.versions).toHaveLength(2);
  });

  it("returns a result report to Results after a message answer", async () => {
    await boot();
    const created = await result();
    await post(`/api/reports/${created.id}/feedback`, { body: "the count is off", version: 1 });
    expect((await statusOf(created.id)).status).toBe("pending");

    const answered = await tool("reports_set_pending").execute(
      { id: created.id, pending: false, answer: "The count includes the retries, which is correct." },
      api,
      ctx,
    );
    expect(answered.isError).toBeUndefined();
    expect((await statusOf(created.id)).status).toBe("result");
  });

  it("refuses to set a result report aside while the user still has to look at it", async () => {
    await boot();
    const created = await result();

    expect(await harness!.runtime.reports.setPending(ctx, created.id, true)).toEqual({
      ok: false,
      reason: "needs_user_check",
    });
    const refused = await tool("reports_set_pending").execute({ id: created.id, pending: true }, api, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("stays under Results");
    // The refusal writes nothing: no flag, and the report is still under Results.
    expect((await statusOf(created.id)).pendingAt).toBeUndefined();
    expect((await statusOf(created.id)).status).toBe("result");

    // Once the user has pressed Done, the report is no longer waiting for them, and
    // a plan may still be set aside by hand, which is the case this refusal is not
    // about.
    expect((await post(`/api/reports/${created.id}/done`, { version: 1, via: "viewer" })).status).toBe(201);
    expect((await harness!.runtime.reports.setPending(ctx, created.id, true)).ok).toBe(true);
  });
});
