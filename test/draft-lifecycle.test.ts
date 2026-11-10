import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { SecReportDraft } from "../src/documents.ts";
import { DraftStore } from "../src/reports/drafts.ts";
import { Janitor } from "../src/runtime/janitor.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import type { StartedServer } from "../src/server/server.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

/**
 * A draft report is open work of its job, from the moment a subagent writes it
 * until the job ends.
 *
 * The body lives under `state/drafts/`, where the cleanup pass does not reach, so
 * a draft nobody published yet is not taken by an age. The job's own record
 * (`jobs_get`) and the job's report list (`reports_list` with `jobId`) show it,
 * and the job ending drops it and says which drafts went. The boot pass moves a
 * body written before this change, and drops what a job that already ended left
 * behind.
 *
 * A job ends through a tool or through an HTTP route, so both are tested here:
 * the route the page and the CLI write a status with, and the route behind the
 * user's cancel button.
 */

const ctx = BACKGROUND_CONTEXT;

type ToolResult = { readonly content: readonly { readonly type: string; readonly text?: string }[]; readonly isError?: boolean };

/** The tool-tag shape the registry hands out: `execute` with the live context. */
type ToolLike = ToolRegistration & {
  execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<ToolResult>;
};

function textOf(result: ToolResult): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("a draft report is open work of its job", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  /** The same harness, on a port the test can reach: the routes end jobs too. */
  async function bootServed(): Promise<TestHarness> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    return harness;
  }

  /** One server over the harness; the caller closes it. */
  async function serve(h: TestHarness): Promise<StartedServer> {
    return await startTestServer(h);
  }

  /** Every installed tool, whatever the calling conversation is offered. */
  function tool(h: TestHarness, name: string): ToolLike {
    const entry = h.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool as unknown as ToolLike;
  }

  function apiOf(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: 1,
      commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: Context) =>
        h.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  /** The store the runtime wires into the extension context, built again to read it. */
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

  /** Write a draft through its own tool, so the id and path come from its contract. */
  async function writeDraft(
    h: TestHarness,
    jobId: string,
    title: string,
    content: string,
    note?: string,
  ): Promise<{ id: string; path: string }> {
    const text = textOf(
      await tool(h, "reports_draft").execute(
        { jobId, title, content, ...(note === undefined ? {} : { note }) } as never,
        apiOf(h),
        ctx,
      ),
    );
    const match = /^draft (\S+) written \(\d+ bytes\) at (.+?)\. The user has not been told/.exec(text);
    if (match === null) throw new Error(`unexpected draft result: ${text}`);
    return { id: match[1]!, path: match[2]! };
  }

  /**
   * A draft row and body in the shape the store wrote before the move: a body
   * under `cache/drafts/`, named by the row.
   *
   * `withBody: false` leaves the file out, which is the row a cleanup pass already
   * emptied.
   */
  async function writeCacheDraft(
    h: TestHarness,
    jobId: string,
    id: string,
    title: string,
    content: string,
    options: { readonly withBody?: boolean } = {},
  ): Promise<string> {
    const legacyDir = join(h.paths.cacheDir, "drafts");
    const path = join(legacyDir, `${id}.md`);
    if (options.withBody ?? true) {
      await mkdir(legacyDir, { recursive: true, mode: 0o700 });
      await writeFile(path, content, "utf8");
    }
    await h.runtime.harness.commit(async (tx) => {
      const row = await tx.doc(SecReportDraft, id, id);
      row.id = id;
      row.agentConversationId = "1";
      row.jobId = jobId;
      row.title = title;
      row.path = path;
      row.bytes = Buffer.byteLength(content, "utf8");
      row.createdAt = Date.now();
      row.status = "pending";
      row.updatedAt = Date.now();
    }, ctx);
    return path;
  }

  describe("where a draft body lives", () => {
    it("writes under state/drafts, where the cleanup pass does not reach", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "the job that produced it");
      const draft = await writeDraft(h, jobId, "Plan draft", "body\n");

      expect(dirname(draft.path)).toBe(join(h.paths.stateDir, "drafts"));

      // The cleanup pass empties `cache/` on an age. A draft is work, so its body
      // must survive a pass that runs with the file already old.
      const janitor = new Janitor({
        privateTmp: false,
        maxAgeHours: 1,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        cacheDir: h.paths.cacheDir,
        now: () => Date.now() + 48 * 60 * 60 * 1000,
      });
      await janitor.run();

      expect(await stat(draft.path).catch(() => undefined)).toBeDefined();
      expect(await readFile(draft.path, "utf8")).toBe("body\n");
      // And it is still publishable, which is what losing the body would stop.
      const published = textOf(
        await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId } as never, apiOf(h), ctx),
      );
      expect(published).toContain("published ");
      expect(published).not.toContain("body file is gone");
    });

    it("moves a body still under cache/drafts, and repoints its row", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "work");
      const id = "01JDRAFTLIFECYCLE00000000001";
      const cachePath = await writeCacheDraft(h, jobId, id, "Old shape", "body\n");
      // The row a cleanup pass already emptied: its body is gone, and the sweep is
      // what records that.
      const goneId = "01JDRAFTLIFECYCLE00000000002";
      await writeCacheDraft(h, jobId, goneId, "No body", "body\n", { withBody: false });

      const store = draftsOf(h);
      expect(await store.relocate(ctx)).toEqual({ moved: 1 });

      const moved = await store.get(ctx, id);
      expect(dirname(moved!.path)).toBe(join(h.paths.stateDir, "drafts"));
      expect(await readFile(moved!.path, "utf8")).toBe("body\n");
      expect(await stat(cachePath).catch(() => undefined)).toBeUndefined();
      // The row whose body is gone stays for the sweep, which has the reason.
      expect(await store.get(ctx, goneId)).toBeDefined();
      expect(await store.sweep(ctx, h.runtime.jobs)).toEqual({ retired: 1, orphanFiles: 0 });
      expect(await store.get(ctx, goneId)).toBeUndefined();
      const missing = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
        (event) => event.type === "report_draft_disposed" && event.draftId === goneId,
      );
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ outcome: "dropped", reason: "body-file-missing", jobId });
    });

    it("repoints a row whose body an interrupted move already placed", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "work");
      const id = "01JDRAFTLIFECYCLE00000000003";
      // The crash point the move allows: the file went, the row did not follow.
      const cachePath = await writeCacheDraft(h, jobId, id, "Half moved", "body\n", { withBody: false });
      await mkdir(join(h.paths.stateDir, "drafts"), { recursive: true, mode: 0o700 });
      await writeFile(join(h.paths.stateDir, "drafts", `${id}.md`), "body\n", "utf8");

      const store = draftsOf(h);
      expect(await store.relocate(ctx)).toEqual({ moved: 1 });
      expect(dirname((await store.get(ctx, id))!.path)).toBe(join(h.paths.stateDir, "drafts"));
      expect(await stat(cachePath).catch(() => undefined)).toBeUndefined();
    });
  });

  describe("showing a job's drafts", () => {
    it("lists them in jobs_get and in reports_list of that job, and drops one that is published", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "with drafts");
      const other = await liveJob(h, "without drafts");
      const first = await writeDraft(h, jobId, "Findings", "one\n", "what the child found");
      const second = await writeDraft(h, jobId, "Result", "two\n");
      const elsewhere = await writeDraft(h, other, "Someone else's", "three\n");

      const got = JSON.parse(textOf(await tool(h, "jobs_get").execute({ id: jobId } as never, apiOf(h), ctx))) as {
        drafts: readonly { id: string; title: string; note: string | null; createdAt: number; agentConversationId: string }[];
      };
      expect(got.drafts.map((draft) => draft.id)).toEqual([first.id, second.id]);
      expect(got.drafts[0]).toMatchObject({
        title: "Findings",
        note: "what the child found",
        agentConversationId: "1",
      });
      expect(got.drafts[1]!.note).toBeNull();
      expect(got.drafts[0]!.createdAt).toBeGreaterThan(0);

      const listed = textOf(await tool(h, "reports_list").execute({ jobId } as never, apiOf(h), ctx));
      expect(listed).toContain("Drafts (written, not yet published):");
      expect(listed).toContain(first.id);
      expect(listed).toContain(second.id);
      expect(listed).not.toContain(elsewhere.id);

      // Without a jobId the list is reports only: a draft belongs to a job.
      const all = textOf(await tool(h, "reports_list").execute({} as never, apiOf(h), ctx));
      expect(all).not.toContain(first.id);

      await tool(h, "reports_publish_draft").execute({ id: first.id, jobId } as never, apiOf(h), ctx);
      const after = JSON.parse(textOf(await tool(h, "jobs_get").execute({ id: jobId } as never, apiOf(h), ctx))) as {
        drafts: readonly { id: string }[];
      };
      expect(after.drafts.map((draft) => draft.id)).toEqual([second.id]);
      expect(textOf(await tool(h, "reports_list").execute({ jobId } as never, apiOf(h), ctx))).not.toContain(first.id);
    });
  });

  describe("dropping a job's drafts when the job ends", () => {
    it("drops them when jobs_update ends the job, and names them", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "finishing work");
      const other = await liveJob(h, "still running");
      const first = await writeDraft(h, jobId, "Plan", "one\n");
      const second = await writeDraft(h, jobId, "Result", "two\n");
      const kept = await writeDraft(h, other, "Other job's draft", "three\n");

      const text = textOf(await tool(h, "jobs_update").execute({ id: jobId, status: "done" } as never, apiOf(h), ctx));

      expect(text).toContain("dropped 2 draft reports of the job that ended");
      expect(text).toContain(`${first.id} ("Plan")`);
      expect(text).toContain(`${second.id} ("Result")`);
      const store = draftsOf(h);
      expect(await store.get(ctx, first.id)).toBeUndefined();
      expect(await store.get(ctx, second.id)).toBeUndefined();
      // Another job's draft is another job's work, and stays.
      expect(await store.get(ctx, kept.id)).toMatchObject({ status: "pending", jobId: other });
      // The body goes with the row at the moment of the drop: the next boot is
      // not when this work ended, and the file would sit there until it is.
      expect(await stat(first.path).catch(() => undefined)).toBeUndefined();
      expect(await stat(second.path).catch(() => undefined)).toBeUndefined();
      expect(await stat(kept.path).catch(() => undefined)).toBeDefined();

      const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
        (event) => event.type === "report_draft_disposed" && event.draftId === first.id,
      );
      expect(disposed).toHaveLength(1);
      expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "job-finished", jobId });
    });

    it("drops the drafts of every job a cancel ends, and keeps another job's", async () => {
      const h = await boot();
      const parentId = await liveJob(h, "parent work");
      const childId = (await h.runtime.jobs.create(ctx, { title: "child work", parentId })).id;
      const other = await liveJob(h, "untouched");
      const parentDraft = await writeDraft(h, parentId, "Parent plan", "one\n");
      const childDraft = await writeDraft(h, childId, "Child result", "two\n");
      const kept = await writeDraft(h, other, "Untouched draft", "three\n");

      const text = textOf(await tool(h, "jobs_cancel").execute({ id: parentId } as never, apiOf(h), ctx));

      expect(text).toContain("dropped 2 draft reports of the job that ended");
      expect(text).toContain(`${parentDraft.id} ("Parent plan")`);
      expect(text).toContain(`${childDraft.id} ("Child result")`);
      const store = draftsOf(h);
      expect(await store.get(ctx, parentDraft.id)).toBeUndefined();
      expect(await store.get(ctx, childDraft.id)).toBeUndefined();
      expect(await store.get(ctx, kept.id)).toMatchObject({ status: "pending" });
      expect(await stat(parentDraft.path).catch(() => undefined)).toBeUndefined();
      expect(await stat(childDraft.path).catch(() => undefined)).toBeUndefined();
      expect(await stat(kept.path).catch(() => undefined)).toBeDefined();
    });

    it("drops a draft of a job that ended, at the boot sweep", async () => {
      const h = await boot();
      const jobId = await liveJob(h, "ended before the drop");
      const draft = await writeDraft(h, jobId, "Left behind", "body\n");
      // A status write that the daemon did not survive: the job is done and the
      // draft is still pending, which is the state the boot pass exists for.
      await h.runtime.jobs.update(ctx, jobId, { status: "done" });
      const store = draftsOf(h);
      expect(await store.get(ctx, draft.id)).toBeDefined();

      expect(await store.sweep(ctx, h.runtime.jobs)).toEqual({ retired: 1, orphanFiles: 0 });
      expect(await store.get(ctx, draft.id)).toBeUndefined();
      // The sweep that finds the job already ended takes the body as well, so the
      // orphan pass has nothing left to collect.
      expect(await stat(draft.path).catch(() => undefined)).toBeUndefined();
      const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
        (event) => event.type === "report_draft_disposed" && event.draftId === draft.id,
      );
      expect(disposed).toHaveLength(1);
      expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "job-finished", jobId });
    });
  });

  /**
   * A job ends through a route as well as through a tool.
   *
   * `PATCH /api/jobs/:id` is how the page and the CLI set a status, and
   * `POST /api/jobs/:id/cancel` is behind the user's cancel button. A draft is
   * open work of its job, so a job that ends through either one takes its drafts
   * with it, and the reply names them.
   */
  describe("ending a job over HTTP", () => {
    it("drops the job's drafts when PATCH /api/jobs/:id ends it, and removes their bodies", async () => {
      const h = await bootServed();
      const started = await serve(h);
      try {
        const jobId = await liveJob(h, "finishing over http");
        const other = await liveJob(h, "still running");
        const gone = await writeDraft(h, jobId, "Plan", "one\n");
        const kept = await writeDraft(h, other, "Other job's draft", "two\n");

        const response = await fetch(`${started.origin}/api/jobs/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          status: string;
          droppedDrafts?: readonly { id: string; title: string }[];
        };
        expect(body.status).toBe("done");
        expect(body.droppedDrafts).toEqual([{ id: gone.id, title: "Plan" }]);

        const store = draftsOf(h);
        expect(await store.get(ctx, gone.id)).toBeUndefined();
        expect(await stat(gone.path).catch(() => undefined)).toBeUndefined();
        // Another job's draft is another job's work, and stays.
        expect(await store.get(ctx, kept.id)).toMatchObject({ status: "pending", jobId: other });
        expect(await stat(kept.path).catch(() => undefined)).toBeDefined();

        const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
          (event) => event.type === "report_draft_disposed" && event.draftId === gone.id,
        );
        expect(disposed).toHaveLength(1);
        expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "job-finished", jobId });
      } finally {
        await started.close();
      }
    });

    it("drops the drafts of every job POST /api/jobs/:id/cancel ends, and keeps another job's", async () => {
      const h = await bootServed();
      const started = await serve(h);
      try {
        const parentId = await liveJob(h, "parent over http");
        const childId = (await h.runtime.jobs.create(ctx, { title: "child over http", parentId })).id;
        const other = await liveJob(h, "untouched");
        const parentDraft = await writeDraft(h, parentId, "Parent plan", "one\n");
        const childDraft = await writeDraft(h, childId, "Child result", "two\n");
        const kept = await writeDraft(h, other, "Untouched draft", "three\n");

        const response = await fetch(`${started.origin}/api/jobs/${parentId}/cancel`, { method: "POST" });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          status: string;
          droppedDrafts?: readonly { id: string; title: string }[];
        };
        expect(body.status).toBe("cancelled");
        expect([...(body.droppedDrafts ?? [])].map((draft) => draft.id).sort()).toEqual(
          [parentDraft.id, childDraft.id].sort(),
        );
        expect(body.droppedDrafts).toHaveLength(2);

        const store = draftsOf(h);
        expect(await store.get(ctx, parentDraft.id)).toBeUndefined();
        expect(await store.get(ctx, childDraft.id)).toBeUndefined();
        expect(await stat(parentDraft.path).catch(() => undefined)).toBeUndefined();
        expect(await stat(childDraft.path).catch(() => undefined)).toBeUndefined();
        expect(await store.get(ctx, kept.id)).toMatchObject({ status: "pending", jobId: other });
        expect(await stat(kept.path).catch(() => undefined)).toBeDefined();
      } finally {
        await started.close();
      }
    });
  });
});
