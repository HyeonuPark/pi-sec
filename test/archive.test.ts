import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { TERMINAL_JOB_STATUSES } from "../src/documents.ts";
import { reportKind } from "../src/reports/store.ts";
import { createTestHarness } from "./helpers.ts";

/**
 * The archive is what keeps the live store readable: finished work leaves, but
 * nothing is deleted and an id still resolves. The two stores are separate
 * SQLite files in production, so the interesting cases are the ones where the
 * copy and the retire are not simultaneous.
 */

const ctx = BACKGROUND_CONTEXT;

describe("job identity", () => {
  it("gives a new job a dated id", async () => {
    const harness = await createTestHarness();
    try {
      const job = await harness.runtime.jobs.create(ctx, { title: "dated" });
      expect(job.id).toMatch(/^\d{8}-[0-9A-Z]{26}$/);
    } finally {
      await harness.close();
    }
  });

  it("records when a job finished, and clears it when the job is reopened", async () => {
    const harness = await createTestHarness();
    try {
      const jobs = harness.runtime.jobs;
      const job = await jobs.create(ctx, { title: "lifecycle" });
      expect(job.completedAt).toBeUndefined();

      const done = await jobs.update(ctx, job.id, { status: "done" });
      expect(done.completedAt).toBeTypeOf("number");

      // Reopening erases the completion: the job is live work again.
      const reopened = await jobs.update(ctx, job.id, { status: "active" });
      expect(reopened.completedAt).toBeUndefined();

      const again = await jobs.update(ctx, job.id, { status: "done" });
      expect(again.completedAt).toBeTypeOf("number");
    } finally {
      await harness.close();
    }
  });

  it("does not push the completion time out when a finished job is touched again", async () => {
    const harness = await createTestHarness();
    try {
      const jobs = harness.runtime.jobs;
      const job = await jobs.create(ctx, { title: "idle and done" });
      const done = await jobs.update(ctx, job.id, { status: "done" });
      const touched = await jobs.update(ctx, job.id, { title: "renamed", status: "done" });
      // A weekly rename must not keep a finished job alive forever.
      expect(touched.completedAt).toBe(done.completedAt);
    } finally {
      await harness.close();
    }
  });

  it("backfills completedAt for a job that ended before the field existed", async () => {
    const migrate = (await import("../src/documents.ts")).SecJob.definition.migrate;
    expect(migrate).toBeDefined();
    const legacy = {
      id: "01M4NX7Y5J000000000000XYDW",
      title: "legacy",
      status: "done",
      origin: "user",
      labels: [],
      memoryAnchors: [],
      taskIds: [],
      createdAt: 1000,
      updatedAt: 2000,
      stats: { runs: 1, failures: 0 },
    };
    const migrated = migrate!(legacy, 1) as Record<string, unknown>;
    // The honest approximation, not a fabricated completion time.
    expect(migrated["completedAt"]).toBe(2000);
  });

  it("keeps completedAt absent when migrating a job that never ended", async () => {
    const migrate = (await import("../src/documents.ts")).SecJob.definition.migrate;
    const legacy = {
      id: "01M4NX7Y5J000000000000XYDX",
      title: "still running",
      status: "active",
      origin: "user",
      labels: [],
      memoryAnchors: [],
      taskIds: [],
      createdAt: 1000,
      updatedAt: 2000,
      stats: { runs: 0, failures: 0 },
    };
    const migrated = migrate!(legacy, 1) as Record<string, unknown>;
    expect(migrated["completedAt"]).toBeUndefined();
  });
});

describe("archive sweep", () => {
  async function finishedJob(harness: Awaited<ReturnType<typeof createTestHarness>>, title: string) {
    const job = await harness.runtime.jobs.create(ctx, { title });
    await harness.runtime.jobs.update(ctx, job.id, { status: "done" });
    return job;
  }

  it("moves a finished job to the archive once its window has passed", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const job = await finishedJob(harness, "old work");

      const report = await archive.sweep(ctx, 0);

      expect(report.archived).toEqual([job.id]);
      expect(await jobs.get(ctx, job.id)).toBeUndefined();
      expect((await archive.get(ctx, job.id))?.title).toBe("old work");
    } finally {
      await harness.close();
    }
  });

  it("leaves a job alone until its window has passed", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const job = await finishedJob(harness, "just finished");

      const report = await archive.sweep(ctx, 3);

      expect(report.archived).toEqual([]);
      expect(await jobs.get(ctx, job.id)).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it("does not move a job that is still running, however old", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const job = await jobs.create(ctx, { title: "live work" });

      expect((await archive.sweep(ctx, 0)).archived).toEqual([]);
      expect(await jobs.get(ctx, job.id)).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it("holds a finished parent back while a descendant is still live", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const parent = await jobs.create(ctx, { title: "parent" });
      await jobs.create(ctx, { title: "child", parentId: parent.id });
      await jobs.update(ctx, parent.id, { status: "done" });

      const report = await archive.sweep(ctx, 0);

      expect(report.archived).toEqual([]);
      expect(report.heldBack).toEqual([parent.id]);
      expect(await jobs.get(ctx, parent.id)).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it("moves a finished subtree as one unit", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const parent = await jobs.create(ctx, { title: "parent" });
      const child = await jobs.create(ctx, { title: "child", parentId: parent.id });
      await jobs.update(ctx, child.id, { status: "done" });
      await jobs.update(ctx, parent.id, { status: "done" });

      const report = await archive.sweep(ctx, 0);

      expect(report.archived.sort()).toEqual([parent.id, child.id].sort());
      expect((await archive.get(ctx, child.id))?.parentId).toBe(parent.id);
    } finally {
      await harness.close();
    }
  });

  it("resolves an archived job by id from either registry", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const finished = await finishedJob(harness, "archived");
      const live = await jobs.create(ctx, { title: "live" });
      await archive.sweep(ctx, 0);

      expect((await archive.getAny(ctx, finished.id))?.title).toBe("archived");
      expect((await archive.getAny(ctx, live.id))?.title).toBe("live");
      expect(await archive.getAny(ctx, "nope")).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("is idempotent after a crash between the copy and the retire", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, archive } = harness.runtime;
      const job = await finishedJob(harness, "half moved");
      // Exactly the state a crash leaves: copied to the archive, still live.
      await archive.registry.writeAll(ctx, [(await jobs.get(ctx, job.id))!]);

      const report = await archive.sweep(ctx, 0);

      expect(report.archived).toEqual([job.id]);
      expect(await jobs.get(ctx, job.id)).toBeUndefined();
      expect((await archive.list(ctx)).filter((entry) => entry.id === job.id)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("reports the cutoff it used", async () => {
    const harness = await createTestHarness();
    try {
      const report = await harness.runtime.archive.sweep(ctx, 3);
      expect(report.cutoff).toBeLessThan(report.at);
      expect(report.at - report.cutoff).toBe(3 * 24 * 60 * 60 * 1000);
    } finally {
      await harness.close();
    }
  });
});

describe("the report archive", () => {
  const ctx = BACKGROUND_CONTEXT;

  it("moves every field of a report into the archive, by either path", async () => {
    const harness = await createTestHarness();
    try {
      const { jobs, reports, archive } = harness.runtime;
      const job = await jobs.create(ctx, { title: "finished work" });
      const result = await reports.create(ctx, { jobId: job.id, title: "Run log", content: "# Run log\n", kind: "result", note: "first" });
      const plan = await reports.create(ctx, { jobId: job.id, title: "Plan", content: "# Plan\n" });
      expect((await reports.approve(ctx, result.id, 1, { via: "panel", button: "done", text: "run it again" })).ok).toBe(true);
      await reports.addFeedback(ctx, result.id, { body: "the count is off", version: 1 });
      expect((await reports.setPending(ctx, result.id, false, { answer: "fixed" })).ok).toBe(true);
      expect((await reports.setPending(ctx, result.id, true)).ok).toBe(true);
      const before = (await reports.get(ctx, result.id))!;
      const planBefore = (await reports.get(ctx, plan.id))!;
      // Every optional field is set on the result report, so a missing copy shows.
      expect(before.kind).toBe("result");
      expect(before.pendingAt).toBeTypeOf("number");
      expect(before.answeredAt).toBeTypeOf("number");
      expect(before.versions[0]?.approval).toMatchObject({ button: "done", text: "run it again" });
      expect(planBefore.kind).toBeUndefined();
      await jobs.update(ctx, job.id, { status: "done" });

      await archive.sweep(ctx, 0);

      expect(await reports.getArchived(ctx, result.id)).toStrictEqual(before);
      expect(await reports.getArchived(ctx, plan.id)).toStrictEqual(planBefore);
      expect(reportKind((await reports.getArchived(ctx, plan.id))!)).toBe("plan");

      // The briefing path copies the same record and adds the time it left.
      const briefingJob = await jobs.create(ctx, { title: "briefings" });
      const old = await reports.create(ctx, { jobId: briefingJob.id, title: "Briefing one", content: "one\n", kind: "briefing" });
      await reports.addFeedback(ctx, old.id, { body: "thanks", version: 1 });
      expect((await reports.setPending(ctx, old.id, false, { answer: "noted" })).ok).toBe(true);
      const oldBefore = (await reports.get(ctx, old.id))!;
      expect(oldBefore.answeredAt).toBeTypeOf("number");
      await reports.create(ctx, { jobId: briefingJob.id, title: "Briefing two", content: "two\n", kind: "briefing" });

      const archivedBriefing = (await reports.getArchived(ctx, old.id))!;
      expect(archivedBriefing.archivedAt).toBeTypeOf("number");
      const { archivedAt, ...rest } = archivedBriefing;
      expect(archivedAt).toBeGreaterThan(0);
      expect(rest).toStrictEqual(oldBefore);
    } finally {
      await harness.close();
    }
  });
});
