import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { writeFile, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { SecReportDraft } from "../src/documents.ts";
import { DraftStore, type CreateDraftInput } from "../src/reports/drafts.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `reports_publish_draft` with `reportId`, and the digest a draft carries.
 *
 * A draft becomes the next revision of a report that exists, so a long revision
 * never passes through the chat. And whichever way a draft is published, the text
 * that goes out must be the text the draft was written with: a file changed after
 * the fact is refused, unless the row is older than the digest.
 */
const ctx = BACKGROUND_CONTEXT;
const api = { conversationId: 1 } as unknown as ToolExecutionApi;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("publishing a draft as a revision", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  function tool(h: TestHarness, name: string): ToolRegistration {
    const entry = h.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool;
  }

  function draftsOf(h: TestHarness): DraftStore {
    return new DraftStore({
      harness: () => h.runtime.harness,
      paths: h.paths,
      storage: h.runtime.storage,
      audit: h.runtime.audit,
    });
  }

  async function liveJob(h: TestHarness, title = "work"): Promise<string> {
    return (await h.runtime.jobs.create(ctx, { title })).id;
  }

  async function writeDraft(
    h: TestHarness,
    jobId: string,
    title: string,
    content: string,
    kind?: "plan" | "result",
  ): Promise<{ id: string; path: string }> {
    const text = textOf(
      await tool(h, "reports_draft").execute({ jobId, title, content, ...(kind === undefined ? {} : { kind }) }, api, ctx),
    );
    const match = /^draft (\S+) written \(\d+ bytes\) at (.+?)\. The user has not been told/.exec(text);
    if (match === null) throw new Error(`unexpected draft result: ${text}`);
    return { id: match[1]!, path: match[2]! };
  }

  async function draftRow(h: TestHarness, id: string) {
    return (await h.runtime.harness.snapshot(SecReportDraft, id, ctx)) as (Record<string, unknown> & { sha256?: string }) | undefined;
  }

  async function reportNotices(h: TestHarness, reportId: string) {
    return (await h.runtime.inbox.list(ctx)).filter((item) => item.kind === "report" && item.source?.reportId === reportId);
  }

  it("records the sha256 of the body on the draft, and shows it to the reader", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const body = "# Plan\n\nfirst pass\n";
    const draft = await writeDraft(h, jobId, "Plan", body);

    expect((await draftRow(h, draft.id))?.sha256).toBe(sha256(body));
    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: draft.id }, api, ctx)));
    expect(view.sha256).toBe(sha256(body));
  });

  it("appends a draft to an existing report as its next revision", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Plan", content: "# Plan\n\nv1\n" });
    const body = "# Plan\n\nv2 from a draft\n";
    const draft = await writeDraft(h, jobId, "ignored title", body);
    const seen: string[] = [];
    h.events.subscribe((event) => seen.push(event.type));

    const result = await tool(h, "reports_publish_draft").execute(
      { id: draft.id, jobId, reportId: report.id, note: "second pass" },
      api,
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    const after = await h.runtime.reports.get(ctx, report.id);
    expect(after?.versions).toHaveLength(2);
    expect(after?.versions[1]).toMatchObject({ n: 2, note: "second pass", sha256: sha256(body) });
    // The revision keeps the report's own title and name: it is the same report.
    expect(after).toMatchObject({ title: "Plan", name: report.name, jobId });
    expect(await h.runtime.reports.readVersion(report.id, 2)).toBe(body);
    expect(await h.runtime.reports.list(ctx)).toHaveLength(1);

    // The result names the report, the revision, and the digest of what went out.
    expect(text).toContain(report.id);
    expect(text).toContain("revision v2");
    expect(text).toContain(`sha256 ${sha256(body)}`);
    expect(text).toContain("The inbox notice carries this to the user");

    // The draft is gone, row and file, as after any publish.
    expect(await draftRow(h, draft.id)).toBeUndefined();
    expect(await stat(draft.path).catch(() => undefined)).toBeUndefined();

    // The same event and the same notice `reports_add_version` leaves.
    expect(seen).toContain("report_updated");
    expect(seen).not.toContain("report_created");
    const notices = await reportNotices(h, report.id);
    // The inbox lists newest first, so the order is not the point: one of each.
    expect(notices.map((item) => item.source?.reportEvent).sort()).toEqual(["published", "updated"]);
  });

  it("leaves the same notice reports_add_version leaves", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const byTool = await h.runtime.reports.create(ctx, { jobId, title: "By tool", content: "v1\n" });
    const byDraft = await h.runtime.reports.create(ctx, { jobId, title: "By draft", content: "v1\n" });
    await tool(h, "reports_add_version").execute({ id: byTool.id, content: "v2\n" }, api, ctx);
    const draft = await writeDraft(h, jobId, "By draft", "v2\n");
    await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, reportId: byDraft.id }, api, ctx);

    const shape = (items: Awaited<ReturnType<typeof reportNotices>>) =>
      items.map((item) => ({ kind: item.kind, event: item.source?.reportEvent }));
    expect(shape(await reportNotices(h, byDraft.id))).toEqual(shape(await reportNotices(h, byTool.id)));
  });

  it("refuses a report of another job, and keeps the draft and the report as they were", async () => {
    const h = await boot();
    const own = await liveJob(h, "own");
    const other = await liveJob(h, "other");
    const report = await h.runtime.reports.create(ctx, { jobId: other, title: "Theirs", content: "v1\n" });
    const draft = await writeDraft(h, own, "Ours", "ours\n");

    const refused = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: own, reportId: report.id }, api, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(other);
    expect(textOf(refused)).toContain(own);

    // Naming the report's job instead does not get past the draft's own job.
    const renamed = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: other, reportId: report.id }, api, ctx);
    expect(renamed.isError).toBe(true);
    expect(textOf(renamed)).toContain(`belongs to job ${own}`);

    expect((await h.runtime.reports.get(ctx, report.id))?.versions).toHaveLength(1);
    expect(await draftRow(h, draft.id)).toBeDefined();
  });

  it("refuses a report that is not live, and a title or a name next to reportId", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Plan", content: "v1\n" });
    const draft = await writeDraft(h, jobId, "Plan", "v2\n");

    const missing = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, reportId: "no-such-report" }, api, ctx);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("no live report with id no-such-report");

    const titled = await tool(h, "reports_publish_draft").execute(
      { id: draft.id, jobId, reportId: report.id, title: "New title" },
      api,
      ctx,
    );
    expect(titled.isError).toBe(true);
    expect(textOf(titled)).toContain("`title` and `name`");

    expect((await h.runtime.reports.get(ctx, report.id))?.versions).toHaveLength(1);
    expect(await draftRow(h, draft.id)).toBeDefined();
  });

  it("refuses a draft file changed after it was written, as a new report and as a revision", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Plan", content: "v1\n" });
    const draft = await writeDraft(h, jobId, "Reviewed", "the reviewed text\n");
    await writeFile(draft.path, "a different text\n", "utf8");

    const asNew = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, name: "fresh" }, api, ctx);
    expect(asNew.isError).toBe(true);
    expect(textOf(asNew)).toContain("the draft file changed after it was written");
    expect(textOf(asNew)).toContain("write a new draft");

    const asRevision = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, reportId: report.id }, api, ctx);
    expect(asRevision.isError).toBe(true);
    expect(textOf(asRevision)).toContain("the draft file changed after it was written");

    // Nothing went out, and the draft is still there to be read and replaced.
    expect(await h.runtime.reports.list(ctx)).toHaveLength(1);
    expect((await h.runtime.reports.get(ctx, report.id))?.versions).toHaveLength(1);
    expect(await draftRow(h, draft.id)).toBeDefined();

    // Putting the reviewed text back makes the same draft publishable again.
    await writeFile(draft.path, "the reviewed text\n", "utf8");
    const back = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, reportId: report.id }, api, ctx);
    expect(back.isError).toBeFalsy();
    expect(await h.runtime.reports.readVersion(report.id, 2)).toBe("the reviewed text\n");
  });

  it("publishes a row older than the digest as it did before, both ways", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Plan", content: "v1\n" });
    const store = draftsOf(h);

    /** A row of the shape written before the digest existed: no `sha256` on it. */
    async function legacy(title: string, content: string) {
      const record = await store.create(ctx, { agentConversationId: "1", jobId, title, content } as CreateDraftInput);
      await h.runtime.harness.commit(async (tx) => {
        const row = (await tx.doc(SecReportDraft, record.id, record.id)) as unknown as Record<string, unknown>;
        delete row["sha256"];
      }, ctx);
      expect((await draftRow(h, record.id))?.sha256).toBeUndefined();
      return record;
    }

    const asRevision = await legacy("Plan", "written\n");
    await writeFile(asRevision.path, "edited later\n", "utf8");
    const revised = await tool(h, "reports_publish_draft").execute({ id: asRevision.id, jobId, reportId: report.id }, api, ctx);
    expect(revised.isError).toBeFalsy();
    expect(await h.runtime.reports.readVersion(report.id, 2)).toBe("edited later\n");

    const asNew = await legacy("Older", "written\n");
    await writeFile(asNew.path, "edited later\n", "utf8");
    const created = await tool(h, "reports_publish_draft").execute({ id: asNew.id, jobId, name: "older" }, api, ctx);
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toContain("published ");
  });
});

/**
 * The kind of a report, from the draft to the published record.
 *
 * The author of a draft says what the draft is, the root may correct it when it
 * publishes, and a revision keeps the kind of its report. A draft that says
 * nothing is a plan, so every draft written by a conversation that was started
 * before the field existed publishes the way it always did.
 */
describe("the kind of a published report", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  function tool(h: TestHarness, name: string): ToolRegistration {
    const entry = h.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  async function liveJob(h: TestHarness, title = "work"): Promise<string> {
    return (await h.runtime.jobs.create(ctx, { title })).id;
  }

  async function writeDraft(
    h: TestHarness,
    jobId: string,
    title: string,
    content: string,
    kind?: "plan" | "result",
  ): Promise<{ id: string }> {
    const text = textOf(
      await tool(h, "reports_draft").execute({ jobId, title, content, ...(kind === undefined ? {} : { kind }) }, api, ctx),
    );
    const match = /^draft (\S+) written \(\d+ bytes\) at (.+?)\. The user has not been told/.exec(text);
    if (match === null) throw new Error(`unexpected draft result: ${text}`);
    return { id: match[1]! };
  }

  it("keeps the kind the draft named, and says the kind back to the author", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const result = textOf(await tool(h, "reports_draft").execute({ jobId, title: "Run log", content: "body\n", kind: "result" }, api, ctx));
    const plan = textOf(await tool(h, "reports_draft").execute({ jobId, title: "Plan", content: "body\n" }, api, ctx));

    // A draft that names a kind says so, and one that names none reads as a plan.
    expect(result).toContain("kind: result");
    expect(plan).toContain("kind: plan");
  });

  it("publishes a result draft as a result report, and shows it in the listing", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const draft = await writeDraft(h, jobId, "Run log", "the run\n", "result");

    const result = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId }, api, ctx);
    expect(result.isError).toBeFalsy();
    const reports = await h.runtime.reports.list(ctx);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe("result");

    // A result report says so in its own listing line, in the same field the other
    // marks use: `kind=result`.
    const listed = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(listed).toContain("kind=result");
    const read = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: reports[0]!.id }, api, ctx)));
    expect(read.kind).toBe("result");
    expect(read.standing).toBe("result");
  });

  it("lets the root correct the kind when it publishes", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const asResult = await writeDraft(h, jobId, "Run log", "the run\n", "result");
    const asPlan = await writeDraft(h, jobId, "Plan", "the plan\n");

    // The draft says `result` and the root publishes it as a plan, and the other
    // way round: the kind published is the kind the publish call names.
    await tool(h, "reports_publish_draft").execute({ id: asResult.id, jobId, kind: "plan" }, api, ctx);
    await tool(h, "reports_publish_draft").execute({ id: asPlan.id, jobId, kind: "result" }, api, ctx);

    const byName = new Map((await h.runtime.reports.list(ctx)).map((record) => [record.title, record.kind]));
    expect(byName.get("Run log")).toBeUndefined();
    expect(byName.get("Plan")).toBe("result");
  });

  it("refuses a kind next to reportId, because a revision keeps its report's kind", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Plan", content: "v1\n" });
    const draft = await writeDraft(h, jobId, "Plan", "v2\n");

    const refused = await tool(h, "reports_publish_draft").execute(
      { id: draft.id, jobId, reportId: report.id, kind: "result" },
      api,
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("`kind`");
    // Nothing moved: the report still has one revision and still a plan.
    const after = await h.runtime.reports.get(ctx, report.id);
    expect(after?.versions).toHaveLength(1);
    expect(after?.kind).toBeUndefined();
  });

  it("publishes a result draft into an existing result report as a revision of the same kind", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const report = await h.runtime.reports.create(ctx, { jobId, title: "Run log", content: "v1\n", kind: "result" });
    const draft = await writeDraft(h, jobId, "Run log", "v2\n");

    const published = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId, reportId: report.id }, api, ctx);
    expect(published.isError).toBeFalsy();
    expect((await h.runtime.reports.get(ctx, report.id))?.kind).toBe("result");
    expect(textOf(published)).toContain("kind=result");
  });
});
