import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { SecAgent, SecAgentChild, SecReport, SecReportDraft, type ReportFeedback, type ReportRecord, type ReportVersion } from "../src/documents.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { DraftStore, type CreateDraftInput } from "../src/reports/drafts.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { diffLines } from "../src/reports/diff.ts";
import { ReportStore, awaitingAnswer, reportKind, reportName, reportStanding, slugify, type ReportApprovalOutcome, type StandingRecord } from "../src/reports/store.ts";
import { reportNotice } from "../src/reports/notice.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { readMessage } from "../src/message-envelope.ts";
import { parseReview } from "../src/review.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { toolFilterFor } from "../src/agent/tool-profile.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * A record with nothing but the set-aside flag, for the pure standing rule.
 *
 * The rule reads the kind, the flag and what the revisions answered, so a plan
 * with no revision is the smallest record that says one thing: the flag is or is
 * not set.
 */
function pendingRecord(pendingAt: number | undefined): StandingRecord {
  return { ...(pendingAt === undefined ? {} : { pendingAt }), versions: [], feedback: [] };
}

describe("line diff", () => {
  it("reports identical text as identical", () => {
    const diff = diffLines("# a\n\nbody\n", "# a\n\nbody\n");
    expect(diff.identical).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it("shows a changed line in a hunk with context around it", () => {
    const before = ["one", "two", "three", "four", "five"].join("\n");
    const after = ["one", "two", "THREE", "four", "five"].join("\n");
    const diff = diffLines(before, after);

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    const kinds = diff.hunks[0]!.lines.map((line) => line.kind);
    expect(kinds).toContain("add");
    expect(kinds).toContain("remove");
    const added = diff.hunks[0]!.lines.find((line) => line.kind === "add");
    expect(added?.text).toBe("THREE");
    expect(added?.toLine).toBe(3);
  });

  it("keeps two distant changes in separate hunks", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[2] = "changed early";
    afterLines[35] = "changed late";
    const diff = diffLines(before, afterLines.join("\n"));

    expect(diff.hunks).toHaveLength(2);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
  });

  it("handles an addition at the very end without a trailing newline", () => {
    const diff = diffLines("a\nb", "a\nb\nc");
    expect(diff.added).toBe(1);
    expect(diff.hunks[0]!.lines.at(-1)).toMatchObject({ kind: "add", text: "c", toLine: 3 });
  });

  it("reports a wholesale replacement rather than aligning an enormous pair", () => {
    const before = Array.from({ length: 2500 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 2500 }, (_, index) => `new ${index}`).join("\n");
    const diff = diffLines(before, after);
    // The guard is the point: the outcome must be honest about being a fallback.
    expect(diff.truncated).toBe(true);
    expect(diff.added).toBe(2500);
    expect(diff.removed).toBe(2500);
  });
});

describe("word segments", () => {
  const allLines = (diff: ReturnType<typeof diffLines>) => diff.hunks.flatMap((hunk) => hunk.lines);
  const changedText = (line: { segments?: Array<{ text: string; changed: boolean }> } | undefined) =>
    (line?.segments ?? []).filter((segment) => segment.changed).map((segment) => segment.text);

  it("joins back into the original line on both sides", () => {
    // Korean text here is test data: the code under test handles Korean on purpose.
    const diff = diffLines("# Plan\n보고서가 좋다\nreport here\n", "# Plan\n보고서를 좋다\nreports here\n");
    const paired = allLines(diff).filter((line) => line.segments !== undefined);
    // Two removes and two adds: the whole change is one pair of pairs.
    expect(paired).toHaveLength(4);
    for (const line of paired) expect(line.segments!.map((segment) => segment.text).join("")).toBe(line.text);
  });

  it("marks only the particle that changed in a Korean pair", () => {
    const diff = diffLines("보고서가 있다\n", "보고서를 있다\n");
    const removed = allLines(diff).find((line) => line.kind === "remove");
    const added = allLines(diff).find((line) => line.kind === "add");
    expect(changedText(removed)).toEqual(["가"]);
    expect(changedText(added)).toEqual(["를"]);
  });

  it("marks only the ending that changed in an English pair", () => {
    const diff = diffLines("the report\n", "the reports\n");
    expect(changedText(allLines(diff).find((line) => line.kind === "add"))).toEqual(["s"]);
    expect(changedText(allLines(diff).find((line) => line.kind === "remove"))).toEqual([]);
  });

  it("gives no segments to a context line or to an unpaired line", () => {
    // Two removes against one add: an index pairing would match unrelated lines,
    // so the group stays line level and the context line carries nothing either.
    const diff = diffLines("alpha\nbeta\nkept\n", "gamma\nkept\n");
    const lines = allLines(diff);
    expect(lines.some((line) => line.kind === "same")).toBe(true);
    for (const line of lines) expect(line.segments).toBeUndefined();
  });

  it("pairs lines whose group has a context line between remove and add", () => {
    // `x\ny\n` → `y\nx\n` aligns as remove(x), same(y), add(x). A rule that only
    // looked at adjacent removes and adds would drop this pair.
    const diff = diffLines("x\ny\n", "y\nx\n");
    const lines = allLines(diff);
    const removed = lines.find((line) => line.kind === "remove");
    const added = lines.find((line) => line.kind === "add");
    expect(removed?.segments?.map((segment) => segment.text).join("")).toBe(removed?.text);
    expect(added?.segments?.map((segment) => segment.text).join("")).toBe(added?.text);
  });

  it("leaves a group with unequal counts at line level", () => {
    const diff = diffLines("alpha\n", "beta\ngamma\n");
    for (const line of allLines(diff)) expect(line.segments).toBeUndefined();
    expect(diff.wordDiffTruncated).toBe(false);
  });

  it("leaves the wholesale replacement path without segments", () => {
    const before = Array.from({ length: 2500 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 2500 }, (_, index) => `new ${index}`).join("\n");
    const diff = diffLines(before, after);
    expect(diff.truncated).toBe(true);
    expect(diff.added).toBe(2500);
    expect(diff.removed).toBe(2500);
    for (const line of allLines(diff)) expect(line.segments).toBeUndefined();
  });

  it("leaves a pair whole when a line or the whole request is too large", () => {
    // 17 pairs of 500 tokens each is 4.25M cells, past the request budget of 4M:
    // the pairs that fit keep their segments, the last one falls back, and the
    // client is told that it did.
    const longTokens = (letter: string) => Array.from({ length: 250 }, () => letter).join(" ") + " ";
    const bounded = diffLines(
      Array.from({ length: 17 }, () => longTokens("a")).join("\n"),
      Array.from({ length: 17 }, () => longTokens("b")).join("\n"),
    );
    expect(bounded.wordDiffTruncated).toBe(true);
    expect(allLines(bounded).filter((line) => line.segments !== undefined)).toHaveLength(32);

    // A line over the 4,000 character ceiling drops out on its own and is not a
    // budget failure: the short pair beside it keeps its segments.
    const longOld = "가".repeat(5_000);
    const longNew = `${"가".repeat(4_990)}${"나".repeat(10)}`;
    const mixed = diffLines(`short old\n${longOld}\n`, `short new\n${longNew}\n`);
    const lines = allLines(mixed);
    expect(lines.filter((line) => line.text.startsWith("short ")).every((line) => line.segments !== undefined)).toBe(true);
    expect(lines.filter((line) => line.text.length > 4_000).every((line) => line.segments === undefined)).toBe(true);
    expect(mixed.wordDiffTruncated).toBe(false);
  });
});

describe("slugify", () => {
  it("builds a readable slug from a title", () => {
    expect(slugify("Report Feature — Design v2!")).toBe("report-feature-design-v2");
  });

  it("keeps non-latin letters rather than collapsing them", () => {
    // A Korean title must not become `report`, `report-2`, `report-3`.
    expect(slugify("리포트 기능 설계")).toBe("리포트-기능-설계");
  });

  it("falls back when a title has no letters at all", () => {
    expect(slugify("!!!")).toBe("report");
    expect(slugify("")).toBe("report");
  });
});

/**
 * A local midday, so the day half of a name is the same wherever the test runs:
 * the stamp is local time, and a timestamp near midnight would move with the
 * machine's offset.
 */
const NAME_DAY = new Date(2026, 9, 15, 12, 0, 0).getTime();

describe("report names", () => {
  it("puts the local day in front of the slug", () => {
    expect(reportName("Approve buttons design", NAME_DAY)).toBe("261015-approve-buttons-design");
  });

  it("uses today when no time is given", () => {
    expect(reportName("Plan")).toMatch(/^\d{6}-plan$/);
  });

  it("keeps a non-latin title beside the date", () => {
    expect(reportName("리포트 기능 설계", NAME_DAY)).toBe("261015-리포트-기능-설계");
  });

  it("still falls back for a title with no letters", () => {
    expect(reportName("!!!", NAME_DAY)).toBe("261015-report");
  });

  it("cuts the title half, never the date", () => {
    const name = reportName("x".repeat(200), NAME_DAY);
    expect(name).toBe(`261015-${"x".repeat(53)}`);
    // Six digits, the separator, and 53 characters of title: the longest name we mint.
    expect(name.length).toBe(60);
  });
});

describe("report store", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  /** A store that reads a fixed clock, so the day in a name is the one the test chose. */
  function fixedClock(h: TestHarness, at: number): ReportStore {
    return new ReportStore({
      session: h.runtime.harness,
      storage: h.runtime.storage,
      reportsDir: h.paths.reportsDir,
      archiveDir: h.paths.archiveDir,
      now: () => at,
    });
  }

  /** Narrow an outcome to the one that carries a report, and say which one arrived when it does not. */
  function approved(outcome: ReportApprovalOutcome): Extract<ReportApprovalOutcome, { ok: true }> {
    if (!outcome.ok) throw new Error(`expected an approval, got ${outcome.reason}`);
    return outcome;
  }

  it("creates a report on a job and reads its first revision back", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Findings",
      content: "# Findings\n\nFirst pass.\n",
      note: "first",
    });

    expect(report.name).toMatch(/^\d{6}-findings$/);
    expect(report.versions).toHaveLength(1);
    expect(report.versions[0]).toMatchObject({ n: 1, note: "first" });
    expect(report.versions[0]?.approval).toBeUndefined();
    expect(await h.runtime.reports.readVersion(report.id, 1)).toBe("# Findings\n\nFirst pass.\n");
  });

  it("keeps the kind on the record, and reads a record without one as a plan", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const result = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Run log",
      content: "# Run log\n",
      kind: "result",
    });
    const plan = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "# Plan\n" });

    // `result` is stored, and `plan` is the absent value, so a report written by a
    // caller that knows no kind reads the same way as one written as a plan.
    expect((await h.runtime.reports.get(ctx, result.id))?.kind).toBe("result");
    expect((await h.runtime.reports.get(ctx, plan.id))?.kind).toBeUndefined();
    expect(reportKind({})).toBe("plan");
    expect(reportKind({ kind: "plan" })).toBe("plan");
    expect(reportKind({ kind: "result" })).toBe("result");
    // The family version does not move: an older document simply lacks the key.
    expect(SecReport.definition.version).toBe(1);
  });

  it("gives a new revision the kind of its report, whatever the caller hopes", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const result = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Run log",
      content: "one\n",
      kind: "result",
    });

    const second = await h.runtime.reports.addVersion(ctx, result.id, { content: "two\n", note: "second" });
    expect(second.kind).toBe("result");
    expect(second.versions).toHaveLength(2);
    // There is no argument on the store that takes a kind with a revision, which
    // is what makes the rule impossible to break from the write path.
    expect("kind" in { content: "three\n" }).toBe(false);
  });

  it("keeps a result report under `result` while the user still has to look at it", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Run log",
      content: "one\n",
      kind: "result",
    });

    // Published, and nothing answered: the user has to press Done or write
    // Feedback, so the standing is `result`.
    expect(reportStanding((await h.runtime.reports.get(ctx, report.id))!, "active")).toBe("result");

    // Feedback puts it under Pending while the answer is owed, and `unanswered`
    // says the same thing to the agent.
    await h.runtime.reports.addFeedback(ctx, report.id, { body: "the count is off", version: 1 });
    const waiting = (await h.runtime.reports.get(ctx, report.id))!;
    expect(reportStanding(waiting, "active")).toBe("pending");
    expect(awaitingAnswer(waiting)).toBe(true);

    // The revision form of the answer carries no approval, so the report is back
    // under Results and waits for the user again.
    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });
    const revised = (await h.runtime.reports.get(ctx, report.id))!;
    expect(reportStanding(revised, "active")).toBe("result");
    expect(awaitingAnswer(revised)).toBe(false);

    // A message answer clears the flag and stores its time, so the report is under
    // Results again even though no revision landed.
    await h.runtime.reports.addFeedback(ctx, report.id, { body: "and the total", version: 2 });
    const answered = await h.runtime.reports.setPending(ctx, report.id, false, { answer: "both are correct now" });
    expect(answered.ok).toBe(true);
    expect(reportStanding((await h.runtime.reports.get(ctx, report.id))!, "active")).toBe("result");
  });

  it("keeps a plan's standing exactly as it was", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const plan = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });

    expect(reportStanding((await h.runtime.reports.get(ctx, plan.id))!, "active")).toBe("active");
    await h.runtime.reports.addFeedback(ctx, plan.id, { body: "step two is wrong", version: 1 });
    expect(reportStanding((await h.runtime.reports.get(ctx, plan.id))!, "active")).toBe("pending");
  });

  it("puts a result report the user approved under pending, and under Finished when the job ends", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Run log",
      content: "one\n",
      kind: "result",
    });

    // Done is the approval a result report takes, and it is recorded by the same
    // call: the revision then carries an approval, so nothing waits for the user.
    const done = approved(await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel", button: "done" }));
    expect(done.approval.button).toBe("done");
    const afterDone = (await h.runtime.reports.get(ctx, report.id))!;
    // The press set the flag, so the report is under Pending until its job closes.
    expect(reportStanding(afterDone, "active")).toBe("pending");

    await h.runtime.jobs.update(ctx, job.id, { status: "done" });
    expect(reportStanding((await h.runtime.reports.get(ctx, report.id))!, "done")).toBe("inactive");
  });

  it("records the text a Done carried, and nothing for a Done without one", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const bare = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "First run",
      content: "one\n",
      kind: "result",
    });
    const asked = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Second run",
      content: "one\n",
      kind: "result",
    });

    const without = approved(await h.runtime.reports.approve(ctx, bare.id, 1, { via: "viewer", button: "done" }));
    expect(without.approval).toMatchObject({ via: "viewer", button: "done" });
    expect(without.approval.text).toBeUndefined();

    const with_ = approved(
      await h.runtime.reports.approve(ctx, asked.id, 1, { via: "panel", button: "done", text: "run it twice" }),
    );
    expect(with_.approval).toMatchObject({ via: "panel", button: "done", text: "run it twice" });
    // The record keeps the user's words beside the approval, not in a note: a
    // feedback entry would ask the owner for an answer, and a Done asks for work.
    const stored = (await h.runtime.reports.get(ctx, asked.id))!;
    expect(stored.versions[0]?.approval?.text).toBe("run it twice");
    expect(stored.feedback).toEqual([]);
  });

  it("refuses Done on a plan, and leaves the revision unapproved", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const plan = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });

    expect(await h.runtime.reports.approve(ctx, plan.id, 1, { via: "panel", button: "done" })).toEqual({
      ok: false,
      reason: "not_a_result",
    });
    expect((await h.runtime.reports.get(ctx, plan.id))?.versions[0]?.approval).toBeUndefined();
    // Approve is still the plan's button, and it still records an approval with no
    // button field on it.
    const press = approved(await h.runtime.reports.approve(ctx, plan.id, 1, { via: "panel" }));
    expect(press.approval.button).toBeUndefined();
  });

  it("appends revisions instead of overwriting them", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Notes", content: "one\n" });
    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });

    const updated = await h.runtime.reports.get(ctx, report.id);
    expect(updated?.versions.map((version) => version.n)).toEqual([1, 2]);
    // Both revisions are still there, which is the whole reason a diff is possible.
    expect(await h.runtime.reports.readVersion(report.id, 1)).toBe("one\n");
    expect(await h.runtime.reports.readVersion(report.id, 2)).toBe("two\n");
  });

  it("never gives two live reports the same slug", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const first = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Same", content: "a\n" });
    const second = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Same", content: "b\n" });

    expect(first.name).toMatch(/^\d{6}-same$/);
    expect(second.name).toBe(`${first.name}-2`);
  });

  it("files a report under the day it was named, and splits same-day collisions there", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    // The live store reads the wall clock; this one reads a day the test chose, and
    // the two write to the same store, so the names below are exact.
    const store = fixedClock(h, NAME_DAY);
    const first = await store.create(ctx, { jobId: job.id, title: "Same day", content: "a\n" });
    const second = await store.create(ctx, { jobId: job.id, title: "Same day", content: "b\n" });

    expect(first.name).toBe("261015-same-day");
    expect(second.name).toBe("261015-same-day-2");
    // Another day is another name, not another `-2`: uniqueness is decided on the
    // name, and the name carries the day.
    const otherDay = fixedClock(h, new Date(2026, 9, 16, 12, 0, 0).getTime());
    const next = await otherDay.create(ctx, { jobId: job.id, title: "Same day", content: "c\n" });
    expect(next.name).toBe("261016-same-day");
    // The live store reads every one of them back by the names they were given.
    expect((await h.runtime.reports.byName(ctx, "261015-same-day"))?.report.id).toBe(first.id);
  });

  it("leaves a report named before the date rule under the name it was given", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Older name", content: "one\n" });
    // The record an older binary wrote: a name minted before the `YYMMDD-` rule,
    // so it has no date half. The rule governs names as they are minted; it does
    // not rewrite the names already in the store.
    const legacy = "older-name";
    await h.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecReport, report.id, report.id);
      draft.name = legacy;
    }, ctx);

    // Read back under the name it was given: by id, in the list, and by name.
    expect((await h.runtime.reports.get(ctx, report.id))?.name).toBe(legacy);
    expect((await h.runtime.reports.list(ctx)).map((each) => each.name)).toContain(legacy);
    expect((await h.runtime.reports.byName(ctx, legacy))?.report.id).toBe(report.id);

    // A new revision is not a new name: only `create` mints one.
    const versioned = await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });
    expect(versioned.name).toBe(legacy);
    expect(versioned.versions).toHaveLength(2);

    // The rule still does its work on what is created now: the same title gets
    // the day, and it is not filed under the undated name either.
    const store = fixedClock(h, NAME_DAY);
    const fresh = await store.create(ctx, { jobId: job.id, title: "Older name", content: "three\n" });
    expect(fresh.name).toBe("261015-older-name");
    expect(fresh.name).not.toBe(legacy);
    // ...and the older record is untouched by that create.
    expect((await h.runtime.reports.get(ctx, report.id))?.name).toBe(legacy);
  });

  it("resolves a slug, preferring the live store", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Lookup", content: "a\n" });

    const found = await h.runtime.reports.byName(ctx, report.name);
    expect(found?.report.id).toBe(report.id);
    expect(found?.archived).toBe(false);
    expect(await h.runtime.reports.byName(ctx, "nope")).toBeUndefined();
  });

  it("records feedback against a revision", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Review", content: "a\n" });

    const entry = await h.runtime.reports.addFeedback(ctx, report.id, { body: "tighten the intro", version: 1 });
    expect(entry.from).toBe("operator");
    const updated = await h.runtime.reports.get(ctx, report.id);
    expect(updated?.feedback).toHaveLength(1);
    expect(updated?.feedback[0]?.version).toBe(1);
  });

  it("sets the report aside with the operator's note, from one clock read", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const at = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const store = fixedClock(h, at);
    const report = await store.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });

    const entry = await store.addFeedback(ctx, report.id, { body: "the second step is wrong", version: 1 });

    // The note is also the set-aside, in the commit that stores it, so the Active
    // list stops asking the operator about this report. One clock read serves the
    // note, the flag and the record, so the three cannot disagree about the moment.
    expect(entry.from).toBe("operator");
    expect(entry.at).toBe(at);
    const stored = await store.get(ctx, report.id);
    expect(stored?.pendingAt).toBe(at);
    expect(stored?.updatedAt).toBe(at);
    expect(stored?.feedback).toEqual([entry]);
    expect(reportStanding(stored!, "active")).toBe("pending");
  });

  it("leaves the flag alone for a note an agent wrote", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Notes", content: "one\n" });

    const entry = await h.runtime.reports.addFeedback(ctx, report.id, { body: "checked the numbers", from: "agent" });

    // An agent's own note is not the operator's word, so it is not the set-aside:
    // the report keeps asking for what the operator has not said yet.
    expect(entry.from).toBe("agent");
    const stored = await h.runtime.reports.get(ctx, report.id);
    expect(stored?.pendingAt).toBeUndefined();
    expect(reportStanding(stored!, "active")).toBe("active");
    expect(awaitingAnswer(stored!)).toBe(false);
  });

  it("answers the note with a revision, which puts the report back in front of them", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    await h.runtime.reports.addFeedback(ctx, report.id, { body: "the second step is wrong", version: 1 });
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeGreaterThan(0);

    const updated = await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });

    // The revision is the answer, and `addVersion` already clears the flag: the
    // report carries a question again, so it is active and nothing is left owing.
    expect(updated.pendingAt).toBeUndefined();
    expect(updated.versions).toHaveLength(2);
    const stored = await h.runtime.reports.get(ctx, report.id);
    expect(stored?.pendingAt).toBeUndefined();
    expect(reportStanding(stored!, "active")).toBe("active");
    expect(awaitingAnswer(stored!)).toBe(false);
    // The note it answered is still on the report: an answer does not erase it.
    expect(stored?.feedback).toHaveLength(1);
  });

  it("moves a report to the archive with its job, bodies and all", async () => {
    const h = await boot();
    const { jobs, reports, archive } = h.runtime;
    const job = await jobs.create(ctx, { title: "finished work" });
    const report = await reports.create(ctx, { jobId: job.id, title: "Handover", content: "# Handover\n" });
    await jobs.update(ctx, job.id, { status: "done" });

    await archive.sweep(ctx, 0);

    expect(await jobs.get(ctx, job.id)).toBeUndefined();
    expect(await reports.get(ctx, report.id)).toBeUndefined();
    expect((await reports.getArchived(ctx, report.id))?.title).toBe("Handover");
    // The body file moved with it; reading still works and finds it in the archive.
    expect(await reports.readVersion(report.id, 1)).toBe("# Handover\n");
    expect(await reports.byName(ctx, report.name)).toMatchObject({ archived: true });
  });

  it("reads a report written before approvals existed", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Older", content: "one\n" });
    // The record an older binary wrote: a revision with no `approval` key at all.
    // The field is optional and the family version is unchanged, so that document
    // reads back through exactly the same path, with no migration step.
    await h.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecReport, report.id, report.id);
      draft.versions = [{ n: 1, at: 1000, bytes: 4, sha256: "0".repeat(64) }];
    }, ctx);

    expect(SecReport.definition.version).toBe(1);
    const read = await h.runtime.reports.get(ctx, report.id);
    expect(read?.versions).toHaveLength(1);
    expect(read?.versions[0]?.approval).toBeUndefined();
    // Writing an approval onto it is the only thing that adds the key.
    const outcome = approved(await h.runtime.reports.approve(ctx, report.id, 1, { via: "viewer" }));
    expect(outcome.report.versions[0]?.approval?.sha256).toBe("0".repeat(64));
  });

  it("records an approval on the revision it was pressed for", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Approve me", content: "one\n" });
    const revision = report.versions[0]!;

    const outcome = approved(await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" }));
    expect(outcome.approval).toMatchObject({ via: "panel", sha256: revision.sha256 });

    const stored = await h.runtime.reports.get(ctx, report.id);
    // The approval names the revision by its hash, which is copied rather than
    // re-derived, and the revision itself is untouched.
    expect(stored?.versions[0]?.approval).toMatchObject({ via: "panel", sha256: revision.sha256 });
    expect(stored?.versions[0]).toMatchObject({ n: 1, at: revision.at, bytes: revision.bytes });
    expect(stored!.updatedAt).toBeGreaterThanOrEqual(report.updatedAt);
  });

  it("sets a report aside the moment its approval is recorded", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const at = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const store = fixedClock(h, at);
    const report = await store.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    const revision = report.versions[0]!;

    const outcome = approved(await store.approve(ctx, report.id, 1, { via: "panel" }));

    // One commit wrote both, from one clock read, so the approval and the
    // set-aside cannot disagree about the moment.
    expect(outcome.approval.at).toBe(at);
    expect(outcome.report.pendingAt).toBe(at);

    const stored = await store.get(ctx, report.id);
    expect(stored?.pendingAt).toBe(at);
    expect(reportStanding(stored!, "active")).toBe("pending");

    // The approval and the revision it names stay exactly where they were.
    expect(stored?.versions).toHaveLength(1);
    expect(stored?.versions[0]?.approval).toMatchObject({ at, via: "panel", sha256: revision.sha256 });
    expect(stored?.versions[0]).toMatchObject({ n: 1, at: revision.at, bytes: revision.bytes });
    expect(stored?.feedback).toEqual([]);
  });

  it("refuses a second approval of the same revision", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Once", content: "one\n" });
    const first = approved(await h.runtime.reports.approve(ctx, report.id, 1, { via: "viewer" }));

    const again = await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" });
    // The record keeps the moment and the surface of the real approval: a second
    // press does not rewrite either.
    if (again.ok || again.reason !== "already_approved") throw new Error(`expected already_approved, got ${again.reason}`);
    expect(again.approval).toMatchObject({ via: "viewer", at: first.approval.at });
    const stored = await h.runtime.reports.get(ctx, report.id);
    expect(stored?.versions[0]?.approval?.via).toBe("viewer");
  });

  it("refuses a revision that is no longer the latest", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Moved on", content: "one\n" });
    const second = await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });

    const stale = await h.runtime.reports.approve(ctx, report.id, 1, { via: "viewer" });
    // The refusal carries what can be approved, so the caller can say so.
    if (stale.ok || stale.reason !== "stale_revision") throw new Error(`expected stale_revision, got ${stale.reason}`);
    expect(stale.latest).toBe(2);
    expect(stale.latestSha256).toBe(second.versions[1]!.sha256);
    expect((await h.runtime.reports.get(ctx, report.id))?.versions[0]?.approval).toBeUndefined();
    // A revision that does not exist is refused the same way, with the same answer.
    expect(await h.runtime.reports.approve(ctx, report.id, 9, { via: "viewer" })).toMatchObject({
      ok: false,
      reason: "stale_revision",
      latest: 2,
    });
    // The new revision is the one that can be approved, and each approval stays
    // on its own revision.
    expect(approved(await h.runtime.reports.approve(ctx, report.id, 2, { via: "viewer" })).approval.sha256).toBe(
      second.versions[1]!.sha256,
    );
    expect((await h.runtime.reports.get(ctx, report.id))?.versions[0]?.approval).toBeUndefined();
  });

  it("gives two revisions written at the same time their own numbers and their own bodies", async () => {
    const h = await boot();
    const { jobs, reports } = h.runtime;
    const job = await jobs.create(ctx, { title: "work" });
    const report = await reports.create(ctx, { jobId: job.id, title: "Findings", content: "one\n" });

    await Promise.all([
      reports.addVersion(ctx, report.id, { content: "two\n" }),
      reports.addVersion(ctx, report.id, { content: "three\n" }),
    ]);

    const record = (await reports.get(ctx, report.id))!;
    expect(record.versions.map((version) => version.n)).toEqual([1, 2, 3]);
    for (const version of record.versions) {
      const body = await reports.readVersion(report.id, version.n);
      expect(createHash("sha256").update(body!, "utf8").digest("hex")).toBe(version.sha256);
    }
  });

  it("refuses an empty body at the store, for a new report and for a new revision", async () => {
    const h = await boot();
    const { jobs, reports } = h.runtime;
    const job = await jobs.create(ctx, { title: "work" });

    await expect(reports.create(ctx, { jobId: job.id, title: "Empty", content: "  \n" })).rejects.toThrow(
      "a report body must not be empty",
    );
    expect(await reports.list(ctx)).toEqual([]);

    const report = await reports.create(ctx, { jobId: job.id, title: "Findings", content: "one\n" });
    await expect(reports.addVersion(ctx, report.id, { content: "" })).rejects.toThrow(
      "a report body must not be empty",
    );
    expect((await reports.get(ctx, report.id))?.versions).toHaveLength(1);
    expect(await reports.readVersion(report.id, 2)).toBeUndefined();
  });

  it("refuses a report it does not have", async () => {
    const h = await boot();
    expect(await h.runtime.reports.approve(ctx, "no-such-report", 1, { via: "viewer" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Nothing was seeded on the way to the refusal.
    expect(await h.runtime.reports.list(ctx)).toEqual([]);
  });

  it("answers not_found to an approve on an archived report", async () => {
    const h = await boot();
    const { jobs, reports, archive } = h.runtime;
    const job = await jobs.create(ctx, { title: "finished work" });
    const report = await reports.create(ctx, { jobId: job.id, title: "Handover", content: "# Handover\n" });
    approved(await reports.approve(ctx, report.id, 1, { via: "panel" }));
    await jobs.update(ctx, job.id, { status: "done" });

    await archive.sweep(ctx, 0);

    // An archived report is the record of finished work, not a surface to confirm
    // anything on, so it is not found here.
    expect(await reports.approve(ctx, report.id, 1, { via: "viewer" })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("awaiting answer", () => {
  const version = (n: number, at: number): ReportVersion => ({ n, at, bytes: 4, sha256: "a".repeat(64) });
  const note = (at: number, from: "operator" | "agent"): ReportFeedback => ({ id: `f${at}`, at, body: "note", from });

  it("is true only when the newest entry is operator feedback on a set-aside report", () => {
    // The note came after the revision, so nothing has answered it.
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [note(200, "operator")] })).toBe(
      true,
    );
    // A revision after the note is the answer, and it cleared the flag as well, so
    // both conditions say the same thing.
    expect(
      awaitingAnswer({
        pendingAt: 200,
        versions: [version(1, 100), version(2, 300)],
        feedback: [note(200, "operator")],
      }),
    ).toBe(false);
    // No note at all: nothing is being asked of the owner.
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [] })).toBe(false);
    // Only an agent's own note, which is not the operator's word.
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [note(200, "agent")] })).toBe(false);
    // The flag is what carries the answer, so without it nothing is waiting, however
    // new the note is.
    expect(awaitingAnswer({ versions: [version(1, 100)], feedback: [note(200, "operator")] })).toBe(false);
    // A set-aside an approval made: the owner owes nothing for a pressed button,
    // and this is the case the flag alone would get wrong.
    expect(awaitingAnswer({ pendingAt: 200, versions: [version(1, 100)], feedback: [] })).toBe(false);
  });
});

describe("report pending", () => {
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

  const api = { conversationId: 1 } as unknown as ToolExecutionApi;

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  it("marks a report that is waiting on an answer, and only that", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });

    const before = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(before).not.toContain("unanswered");

    await h.runtime.reports.addFeedback(ctx, report.id, { body: "the second step is wrong", version: 1 });
    const after = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    // Two marks, because the report is both set aside and owing an answer.
    expect(after).toContain(" pending");
    expect(after).toContain(" unanswered");

    // The revision form of the answer takes both marks off, because it clears the
    // flag and the newest entry is the revision.
    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });
    const revised = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(revised).not.toContain("unanswered");

    // A set-aside an approval made is not an unanswered note: the mark is about the
    // owner's debt, and a pressed button leaves none.
    const approved = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Approved", content: "one\n" });
    await h.runtime.reports.approve(ctx, approved.id, 1, { via: "panel" });
    const listing = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(listing).toContain(" pending");
    expect(listing).not.toContain("unanswered");
  });

  it("sets a report aside and brings it back, leaving its revisions alone", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "a\n" });

    expect((await h.runtime.reports.setPending(ctx, report.id, true)).ok).toBe(true);
    const aside = await h.runtime.reports.get(ctx, report.id);
    expect(aside?.pendingAt).toBeGreaterThan(0);
    // Nothing else about the report moved: the flag is where its standing lives.
    expect(aside?.versions).toHaveLength(1);
    expect(aside?.updatedAt).toBeGreaterThanOrEqual(report.updatedAt);

    expect((await h.runtime.reports.setPending(ctx, report.id, false)).ok).toBe(true);
    // Cleared means the key is gone, not set to zero. A reader cannot tell the
    // difference, and a document written before the flag existed has the same shape.
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeUndefined();
  });

  it("takes the job's word over the flag, in both directions", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "a\n" });
    await h.runtime.reports.setPending(ctx, report.id, true);

    expect(reportStanding(pendingRecord(1000), "active")).toBe("pending");
    expect(reportStanding(pendingRecord(1000), "done")).toBe("inactive");
    expect(reportStanding(pendingRecord(1000), undefined)).toBe("archived");
    expect(reportStanding(pendingRecord(undefined), "active")).toBe("active");

    // A job that ends outranks the flag and does not clear it, so a job that is
    // reopened brings the report back to where the operator left it.
    await h.runtime.jobs.update(ctx, job.id, { status: "done" });
    expect(reportStanding((await h.runtime.reports.get(ctx, report.id))!, "done")).toBe("inactive");
    await h.runtime.jobs.update(ctx, job.id, { status: "active" });
    expect(reportStanding((await h.runtime.reports.get(ctx, report.id))!, "active")).toBe("pending");
  });

  it("refuses a report whose job has ended, and one it does not have", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "a\n" });

    expect(await h.runtime.reports.setPending(ctx, "no-such-report", true)).toEqual({ ok: false, reason: "not_found" });
    expect(await h.runtime.reports.list(ctx)).toHaveLength(1);

    await h.runtime.jobs.update(ctx, job.id, { status: "done" });
    expect(await h.runtime.reports.setPending(ctx, report.id, true)).toEqual({
      ok: false,
      reason: "not_active",
      status: "done",
    });
    // A refusal writes nothing at all, so no flag waits for the job to reopen.
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeUndefined();
  });

  it("carries the flag into the archive, where the job's end outranks it", async () => {
    const h = await boot();
    const { jobs, reports, archive } = h.runtime;
    const job = await jobs.create(ctx, { title: "finished work" });
    const report = await reports.create(ctx, { jobId: job.id, title: "Handover", content: "# Handover\n" });
    await reports.setPending(ctx, report.id, true);
    await jobs.update(ctx, job.id, { status: "done" });

    await archive.sweep(ctx, 0);

    const archived = await reports.getArchived(ctx, report.id);
    expect(reportStanding(archived!, undefined)).toBe("archived");
  });

  it("moves a report between the two states through the tool, and says nothing in the inbox", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "a\n" });
    const notices = (await h.runtime.inbox.list(ctx)).length;

    const set = await tool(h, "reports_set_pending").execute({ id: report.id, pending: true }, api, ctx);
    expect(textOf(set)).toContain("pending");
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeGreaterThan(0);
    // The one report write that says nothing: a notice here would be exactly the
    // attention the tool exists to take away.
    expect((await h.runtime.inbox.list(ctx)).length).toBe(notices);

    const back = await tool(h, "reports_set_pending").execute({ id: report.id, pending: false }, api, ctx);
    expect(textOf(back)).toContain("active");
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeUndefined();
  });

  it("clears the set-aside an approval made when a new revision lands", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
    // The press records the flag in its own commit, so this report starts aside.
    const approved = await h.runtime.reports.approve(ctx, report.id, 1, { via: "panel" });
    if (!approved.ok) throw new Error(`expected an approval, got ${approved.reason}`);
    expect(approved.report.pendingAt).toBeGreaterThan(0);

    const updated = await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });

    // v2 carries no approval, so the report is waiting on an answer again and the
    // word it shows is the one that asks for attention.
    expect(updated.pendingAt).toBeUndefined();
    const stored = await h.runtime.reports.get(ctx, report.id);
    expect(stored?.pendingAt).toBeUndefined();
    expect(reportStanding(stored!, "active")).toBe("active");
    // The revision that was approved is untouched, and the new one is appended.
    expect(stored?.versions.map((version) => version.n)).toEqual([1, 2]);
    expect(stored?.versions[0]?.approval).toMatchObject({ via: "panel", sha256: report.versions[0]?.sha256 });
  });

  it("clears a set-aside the operator made by hand when a new revision lands", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Notes", content: "one\n" });
    expect((await h.runtime.reports.setPending(ctx, report.id, true)).ok).toBe(true);

    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });

    // The set-aside answered the question that was on the report when it was set.
    // A later revision is a different question, so it asks again; the operator can
    // set the report aside once more if they want it quiet.
    const stored = await h.runtime.reports.get(ctx, report.id);
    expect(stored?.pendingAt).toBeUndefined();
    expect(reportStanding(stored!, "active")).toBe("active");
  });

  it("refuses through the tool with the reason, and writes nothing", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Done", content: "a\n" });
    await h.runtime.jobs.update(ctx, job.id, { status: "done" });

    const refused = await tool(h, "reports_set_pending").execute({ id: report.id, pending: true }, api, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("its job is done");
    expect((await h.runtime.reports.get(ctx, report.id))?.pendingAt).toBeUndefined();
  });

  it("is offered to the root and withheld from a subagent", async () => {
    const h = await boot();
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    const agent = await conversation.agent(ctx);

    expect(agent.tools.map((item) => item.name)).toContain("reports_set_pending");
    // Removal is the gate, so a subagent cannot reach it through `js` either.
    expect(toolFilterFor("subagent")?.remove ?? []).toContain("reports_set_pending");
  });
});

describe("report move", () => {
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

  const api = { conversationId: 1 } as unknown as ToolExecutionApi;

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  it("moves a live report to another live job and keeps everything the report holds", async () => {
    const h = await boot();
    const from = await h.runtime.jobs.create(ctx, { title: "old owner" });
    const to = await h.runtime.jobs.create(ctx, { title: "new owner" });
    const report = await h.runtime.reports.create(ctx, { jobId: from.id, title: "Findings", content: "one\n" });
    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });
    const approved = await h.runtime.reports.approve(ctx, report.id, 2, { via: "panel" });
    if (!approved.ok) throw new Error(`expected an approval, got ${approved.reason}`);
    await h.runtime.reports.addFeedback(ctx, report.id, { body: "the second step is wrong", version: 2 });
    const before = (await h.runtime.reports.get(ctx, report.id))!;

    const moved = await tool(h, "reports_move").execute({ id: report.id, jobId: to.id }, api, ctx);
    expect(textOf(moved)).toContain(from.id);
    expect(textOf(moved)).toContain(to.id);

    const after = (await h.runtime.reports.get(ctx, report.id))!;
    expect(after.jobId).toBe(to.id);
    // Only the owner moved: the revisions, their digests, the approval inside the
    // second one, the feedback, the name and the title are the document's own.
    expect(after.versions).toEqual(before.versions);
    expect(after.versions.map((version) => version.sha256)).toEqual(before.versions.map((version) => version.sha256));
    expect(after.versions[1]?.approval).toMatchObject({ via: "panel", sha256: before.versions[1]?.sha256 });
    expect(after.feedback).toEqual(before.feedback);
    expect(after.name).toBe(before.name);
    expect(after.title).toBe(before.title);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    // The listing follows the new owner, and the old one no longer shows it.
    expect(textOf(await tool(h, "reports_list").execute({ jobId: to.id }, api, ctx))).toContain(report.id);
    expect(textOf(await tool(h, "reports_list").execute({ jobId: from.id }, api, ctx))).not.toContain(report.id);
    // The report body is still where it was, so a reader loses nothing.
    expect(await h.runtime.reports.readVersion(report.id, 2)).toBe("two\n");
  });

  it("refuses a missing job, a finished job, an archived report and its own job, and writes nothing", async () => {
    const h = await boot();
    const from = await h.runtime.jobs.create(ctx, { title: "old owner" });
    const done = await h.runtime.jobs.create(ctx, { title: "finished work" });
    const report = await h.runtime.reports.create(ctx, { jobId: from.id, title: "Findings", content: "one\n" });
    await h.runtime.jobs.update(ctx, done.id, { status: "done" });

    const missingJob = await tool(h, "reports_move").execute({ id: report.id, jobId: "20261021-NOSUCHJOB" }, api, ctx);
    expect(missingJob.isError).toBe(true);
    expect(textOf(missingJob)).toContain("no live job with id 20261021-NOSUCHJOB");

    const finishedJob = await tool(h, "reports_move").execute({ id: report.id, jobId: done.id }, api, ctx);
    expect(finishedJob.isError).toBe(true);
    expect(textOf(finishedJob)).toContain(`job ${done.id} is done`);

    const sameJob = await tool(h, "reports_move").execute({ id: report.id, jobId: from.id }, api, ctx);
    expect(sameJob.isError).toBeFalsy();
    expect(textOf(sameJob)).toContain("already belongs to job");

    // Every refusal above leaves the owner exactly as it was.
    expect((await h.runtime.reports.get(ctx, report.id))?.jobId).toBe(from.id);
    // A report that is not there at all is refused too, and no row is written for it.
    expect(await h.runtime.reports.moveToJob(ctx, "01NOSUCHREPORT", from.id)).toEqual({
      ok: false,
      reason: "not_found",
    });

    // A report leaves the live store with its job, and the archive is closed to a move.
    await h.runtime.jobs.update(ctx, from.id, { status: "done" });
    await h.runtime.archive.sweep(ctx, 0);
    expect(await h.runtime.reports.get(ctx, report.id)).toBeUndefined();
    const archived = await tool(h, "reports_move").execute({ id: report.id, jobId: done.id }, api, ctx);
    expect(archived.isError).toBe(true);
    expect(textOf(archived)).toContain("no live report with id");
    expect((await h.runtime.reports.getArchived(ctx, report.id))?.jobId).toBe(from.id);
  });

  it("records the move in the audit log with both jobs", async () => {
    const h = await boot();
    const from = await h.runtime.jobs.create(ctx, { title: "old owner" });
    const to = await h.runtime.jobs.create(ctx, { title: "new owner" });
    const report = await h.runtime.reports.create(ctx, { jobId: from.id, title: "Findings", content: "one\n" });

    await tool(h, "reports_move").execute({ id: report.id, jobId: to.id }, api, ctx);

    const rows = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_moved",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reportId: report.id, fromJobId: from.id, toJobId: to.id });
  });

  it("is offered to the root and withheld from a subagent and a scheduled run", async () => {
    const h = await boot();
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    const agent = await conversation.agent(ctx);

    expect(agent.tools.map((item) => item.name)).toContain("reports_move");
    // Removal is the gate, so a subagent cannot reach it through `js` either, and a
    // scheduled run inherits the same list.
    expect(toolFilterFor("subagent")?.remove ?? []).toContain("reports_move");
    expect(toolFilterFor("scheduled")?.remove ?? []).toContain("reports_move");
  });
});

describe("report draft tools", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    return harness;
  }

  // The registry holds every installed tool, whatever a conversation's kind is
  // offered. The draft tool is one the root is not offered, so this is the way to
  // reach both sides of the flow from one test.
  function tool(h: TestHarness, name: string): ToolRegistration {
    const entry = h.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool;
  }

  const api = { conversationId: 1 } as unknown as ToolExecutionApi;

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  /**
   * The store the runtime wires into the extension context, built again here so a
   * test can read the rows the tool wrote without the tool in the way.
   */
  function draftsOf(h: TestHarness): DraftStore {
    return new DraftStore({
      harness: () => h.runtime.harness,
      paths: h.paths,
      storage: h.runtime.storage,
      audit: h.runtime.audit,
    });
  }

  /** A live job, which is the one thing a draft cannot be written without. */
  async function liveJob(h: TestHarness, title = "work"): Promise<string> {
    return (await h.runtime.jobs.create(ctx, { title })).id;
  }

  /**
   * The two records a subagent has: the parent's name index and the agent's own
   * row. Written by hand so a test can reach the delete path, and the assignment
   * check, without a spawn.
   */
  async function handWrittenSubagent(h: TestHarness, childId: ConversationId, assigned?: string): Promise<void> {
    // The parent conversation must exist before anything of its scope is written.
    await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    await h.runtime.harness.commit(async (tx) => {
      const index = await tx.doc(SecAgentChild, 1 as ConversationId, "researcher", "researcher");
      index.name = "researcher";
      index.conversationId = String(childId);
      index.createdAt = Date.now();
      const record = await tx.doc(SecAgent, String(childId), String(childId));
      record.kind = "subagent";
      record.name = "researcher";
      record.parentConversationId = "1";
      record.status = "waiting";
      record.createdAt = Date.now();
      record.updatedAt = Date.now();
      if (assigned !== undefined) record.jobId = assigned;
    }, ctx);
  }

  /** Write a draft through its own tool, so the id and path come from its contract. */
  async function writeDraft(
    h: TestHarness,
    jobId: string,
    title: string,
    content: string,
    as: ToolExecutionApi = api,
  ): Promise<{ id: string; path: string }> {
    const text = textOf(await tool(h, "reports_draft").execute({ jobId, title, content }, as, ctx));
    const match = /^draft (\S+) written \(\d+ bytes\) at (.+?)\. The user has not been told/.exec(text);
    if (match === null) throw new Error(`unexpected draft result: ${text}`);
    return { id: match[1]!, path: match[2]! };
  }

  /**
   * A row of the shape the store wrote before the job field existed: it carries no
   * job, so it keeps the older lifetime. The tool cannot write one any more,
   * because `jobId` is required, so the row comes from the store itself.
   */
  async function writeLegacyDraft(
    h: TestHarness,
    conversationId: string,
    title: string,
    content: string,
  ): Promise<{ id: string; path: string }> {
    const input = { agentConversationId: conversationId, title, content } as unknown as CreateDraftInput;
    const record = await draftsOf(h).create(ctx, input);
    return { id: record.id, path: record.path };
  }

  it("refuses a draft with no jobId, and writes nothing", async () => {
    const h = await boot();
    const result = await tool(h, "reports_draft").execute({ title: "Unowned", content: "body\n" }, api, ctx);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`jobId`");
    // Nothing is written before the checks pass, so a refused call leaves neither
    // a row nor a file behind.
    expect(await draftsOf(h).list(ctx)).toHaveLength(0);
    expect(await readdir(draftsOf(h).dir).catch(() => [] as string[])).toHaveLength(0);
  });

  it("records the job on the row and in the result", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the job that produced it");

    const text = textOf(await tool(h, "reports_draft").execute({ jobId, title: "Ours", content: "body\n" }, api, ctx));

    expect(text).toContain(`job: ${jobId}`);
    const rows = await draftsOf(h).list(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId, title: "Ours", status: "pending" });
  });

  it("keeps the note the draft was written with and shows it to a reader", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");

    const text = textOf(
      await tool(h, "reports_draft").execute(
        { jobId, title: "Threading plan", content: "body\n", note: "the plan, before review" },
        api,
        ctx,
      ),
    );
    const id = /^draft (\S+) written/.exec(text)?.[1];
    expect(id).toBeDefined();

    // The row keeps it, so the publish below can carry it without retyping it.
    expect(await draftsOf(h).get(ctx, id!)).toMatchObject({ note: "the plan, before review" });
    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id }, api, ctx)));
    expect(view.note).toBe("the plan, before review");
  });

  it("publishes under the draft's note, and a note given to publish wins", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const own = textOf(
      await tool(h, "reports_draft").execute(
        { jobId: job.id, title: "Own note", content: "body\n", note: "written with the draft" },
        api,
        ctx,
      ),
    );
    const given = textOf(
      await tool(h, "reports_draft").execute(
        { jobId: job.id, title: "Given note", content: "body\n", note: "written with the draft" },
        api,
        ctx,
      ),
    );
    const ownId = /^draft (\S+) written/.exec(own)?.[1];
    const givenId = /^draft (\S+) written/.exec(given)?.[1];

    // No note on the publish call: the draft's own note is what the first revision says.
    await tool(h, "reports_publish_draft").execute({ id: ownId, jobId: job.id }, api, ctx);
    // A note on the publish call is the root's word at publish time, and it wins.
    await tool(h, "reports_publish_draft").execute({ id: givenId, jobId: job.id, note: "given at publish" }, api, ctx);

    const reports = await h.runtime.reports.list(ctx);
    expect(reports.find((item) => item.title === "Own note")?.versions).toMatchObject([
      { n: 1, note: "written with the draft" },
    ]);
    expect(reports.find((item) => item.title === "Given note")?.versions).toMatchObject([
      { n: 1, note: "given at publish" },
    ]);
  });

  it("publishes a draft written before the note field with no note at all", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    // The row is written without a note, which is the shape of a row written before
    // the field existed: the reader treats a missing note as an empty one.
    const draft = await writeDraft(h, job.id, "No note", "body\n");

    expect(await draftsOf(h).get(ctx, draft.id)).not.toHaveProperty("note");
    await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: job.id }, api, ctx);

    const reports = await h.runtime.reports.list(ctx);
    expect(reports[0]?.versions[0]?.note).toBeUndefined();
  });

  it("refuses a draft filed against a job the conversation is not assigned to", async () => {
    const h = await boot();
    const assigned = await liveJob(h, "assigned");
    const other = await liveJob(h, "someone else's");
    await handWrittenSubagent(h, 5 as ConversationId, assigned);
    const childApi = { conversationId: 5 } as unknown as ToolExecutionApi;

    const refused = await tool(h, "reports_draft").execute({ jobId: other, title: "Stray", content: "body\n" }, childApi, ctx);
    expect(refused.isError).toBe(true);
    // The text names the job the caller may use, so the retry needs no guessing.
    expect(textOf(refused)).toContain(assigned);
    expect(await draftsOf(h).list(ctx)).toHaveLength(0);

    const accepted = textOf(
      await tool(h, "reports_draft").execute({ jobId: assigned, title: "Ours", content: "body\n" }, childApi, ctx),
    );
    expect(accepted).toContain(`job: ${assigned}`);
    expect(await draftsOf(h).list(ctx)).toHaveLength(1);
  });

  it("warns about a top-level job, and still records the draft", async () => {
    const h = await boot();
    const top = await liveJob(h, "top level");
    expect((await h.runtime.jobs.get(ctx, top))?.parentId).toBeUndefined();

    const text = textOf(await tool(h, "reports_draft").execute({ jobId: top, title: "Misplaced", content: "body\n" }, api, ctx));
    expect(text).toContain(`job: ${top}`);
    expect(text).toContain("not recommended: this is a top-level job");
    // A warning is not a refusal: losing a draft is worse than keeping it.
    expect(await draftsOf(h).list(ctx)).toHaveLength(1);

    // A job below another is the shape a draft belongs to, so it passes quietly.
    const parent = await liveJob(h, "parent");
    const child = (await h.runtime.jobs.create(ctx, { title: "child", parentId: parent })).id;
    const quiet = textOf(await tool(h, "reports_draft").execute({ jobId: child, title: "Nested", content: "body\n" }, api, ctx));
    expect(quiet).toContain(`job: ${child}`);
    expect(quiet).not.toContain("not recommended");
  });

  it("takes the draft text from a file when the call names one with `path`", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");
    // A body with what a caller's own transcription gets wrong: a trailing space,
    // a tab, a non-latin line, and no trailing newline.
    const content = "# Findings \n\n\tindented\n\n결론: 바꾸지 않습니다.";
    const path = join(h.paths.workspaceTree, "findings.md");
    await writeFile(path, content, "utf8");

    const text = textOf(await tool(h, "reports_draft").execute({ jobId, title: "From a file", path }, api, ctx));
    const id = /^draft (\S+) written/.exec(text)?.[1];
    expect(id).toBeDefined();

    // One row, and its body is the file's text, byte for byte.
    const rows = await draftsOf(h).list(ctx);
    expect(rows).toHaveLength(1);
    const stored = await draftsOf(h).readById(ctx, id!);
    expect(stored?.content).toBe(content);
    // The file the tool wrote is the text the file it read held, byte for byte.
    expect(await readFile(stored!.record.path)).toEqual(Buffer.from(content, "utf8"));
  });

  it("refuses a call that gives both `content` and `path`, and one that gives neither", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");
    const path = join(h.paths.workspaceTree, "both.md");
    await writeFile(path, "from the file\n", "utf8");

    const both = await tool(h, "reports_draft").execute({ jobId, title: "Both", content: "from the call\n", path }, api, ctx);
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("exactly one of `content` and `path`");

    const neither = await tool(h, "reports_draft").execute({ jobId, title: "Neither" }, api, ctx);
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain("exactly one of `content` and `path`");

    // Neither refusal leaves a row or a file behind.
    expect(await draftsOf(h).list(ctx)).toHaveLength(0);
    expect(await readdir(draftsOf(h).dir).catch(() => [] as string[])).toHaveLength(0);
  });

  it("refuses a file it cannot read, and leaves no draft behind", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");
    const path = join(h.paths.workspaceTree, "not-there.md");

    const missing = await tool(h, "reports_draft").execute({ jobId, title: "Missing", path }, api, ctx);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain(path);
    expect(await draftsOf(h).list(ctx)).toHaveLength(0);
    expect(await readdir(draftsOf(h).dir).catch(() => [] as string[])).toHaveLength(0);
  });

  it("redacts a registered secret that the file holds, so the draft cannot publish it", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");
    // The harness's own home holds the secret store, so the test registers a value
    // there rather than reading a real secret file.
    const secret = "test-secret-value-2f8a1c";
    await writeFile(join(h.paths.secretsDir, "probe"), `${secret}\n`, { mode: 0o600 });
    await h.runtime.secrets.reload();
    const path = join(h.paths.workspaceTree, "with-secret.md");
    await writeFile(path, `before ${secret} after\n`, "utf8");

    const text = textOf(await tool(h, "reports_draft").execute({ jobId, title: "Secret", path }, api, ctx));
    const id = /^draft (\S+) written/.exec(text)?.[1];
    const stored = await draftsOf(h).readById(ctx, id!);
    expect(stored?.content).toBe("before ⟦secret:probe⟧ after\n");
    expect(stored?.content).not.toContain(secret);
  });

  it("reads a draft by id, with its text when asked", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "the draft's job");
    const draft = await writeDraft(h, jobId, "Draft findings", "# Findings\n\nfirst pass\n");

    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: draft.id, includeBody: true }, api, ctx)));
    expect(view.kind).toBe("draft");
    expect(view.id).toBe(draft.id);
    expect(view.title).toBe("Draft findings");
    expect(view.status).toBe("pending");
    expect(view.path).toBe(draft.path);
    expect(view.url).toBeNull();
    expect(view.body).toBe("# Findings\n\nfirst pass\n");
    expect(view.publish).toContain("reports_publish_draft");
    // The reader is told which job the draft belongs to, because the publish call
    // takes that job and the id alone does not say it.
    expect(view.jobId).toBe(jobId);
    expect(view.publish).toContain(`jobId ${jobId}`);

    // The text is opt-in here too, exactly as it is for a report.
    const head = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: draft.id }, api, ctx)));
    expect(head.kind).toBe("draft");
    expect(head.body).toBeUndefined();
  });

  it("says the body file is gone rather than that the draft is gone", async () => {
    const h = await boot();
    const jobId = await liveJob(h);
    const draft = await writeDraft(h, jobId, "Vanished", "body\n");
    await rm(draft.path, { force: true });

    const result = await tool(h, "reports_get").execute({ id: draft.id, includeBody: true }, api, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`draft ${draft.id} exists (status pending) but its body file is gone`);
  });

  it("answers for neither a report nor a draft with one message", async () => {
    const h = await boot();
    const result = await tool(h, "reports_get").execute({ id: "no-such-id" }, api, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("No report or draft with id no-such-id");
  });

  it("publishes a draft once, leaving the report and no draft behind", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const draft = await writeDraft(h, job.id, "Lessons first pass", "# Lessons\n\nbody\n");

    const text = textOf(
      await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: job.id, note: "first" }, api, ctx),
    );
    expect(text).toContain("published ");
    expect(text).toMatch(/\/report\/\d{6}-lessons-first-pass/);

    const reports = await h.runtime.reports.list(ctx);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ jobId: job.id, title: "Lessons first pass" });
    expect(reports[0]!.name).toMatch(/^\d{6}-lessons-first-pass$/);
    expect(reports[0]!.versions).toMatchObject([{ n: 1, note: "first" }]);
    expect(reports[0]!.versions[0]?.approval).toBeUndefined();
    expect(await h.runtime.reports.readVersion(reports[0]!.id, 1)).toBe("# Lessons\n\nbody\n");

    // The draft row retires with its file, so a later lookup finds neither.
    expect(await h.runtime.harness.snapshot(SecReportDraft, draft.id, ctx)).toBeUndefined();
    expect(await stat(draft.path).catch(() => undefined)).toBeUndefined();

    const notices = (await h.runtime.inbox.list(ctx)).filter((item) => item.kind === "report");
    expect(notices).toHaveLength(1);
    // The title is the report's own, with no header in front of it: the row marks
    // the kind from `reportEvent` instead, which is what the chat UI colors.
    expect(notices[0]?.title).toBe("Lessons first pass");
    expect(notices[0]?.source?.reportId).toBe(reports[0]!.id);
    expect(notices[0]?.source?.reportEvent).toBe("published");
  });

  it("refuses to publish a draft into a job other than its own", async () => {
    const h = await boot();
    const own = await liveJob(h, "own");
    const other = await liveJob(h, "other");
    const draft = await writeDraft(h, own, "Ours", "body\n");

    const refused = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: other }, api, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(own);
    expect(await h.runtime.reports.list(ctx)).toHaveLength(0);
    // The refusal costs the draft nothing, so the same call can go to its own job.
    expect(await h.runtime.harness.snapshot(SecReportDraft, draft.id, ctx)).toBeDefined();

    const text = textOf(
      await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: own, name: "ours" }, api, ctx),
    );
    expect(text).toContain("published ");
    expect((await h.runtime.reports.list(ctx))[0]).toMatchObject({ jobId: own });
  });

  it("refuses a name a live report holds, and keeps the draft", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const held = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Shared", content: "live\n" });
    const draft = await writeDraft(h, job.id, "Shared", "draft body\n");

    const result = await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: job.id }, api, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(held.id);
    expect(textOf(result)).toContain("shared");

    // The draft survives, so the same call can be made again under a free name.
    expect(await h.runtime.harness.snapshot(SecReportDraft, draft.id, ctx)).toBeDefined();
    expect(await h.runtime.reports.list(ctx)).toHaveLength(1);
    const retry = textOf(
      await tool(h, "reports_publish_draft").execute({ id: draft.id, jobId: job.id, name: "shared-draft" }, api, ctx),
    );
    // The name the tool looked for and the name the store minted are the same one,
    // because both come from the same helper: the day is in front of both.
    expect(retry).toContain(`/report/${reportName("shared-draft")}`);
    expect(retry).toMatch(/\/report\/\d{6}-shared-draft/);
  });

  it("refuses an empty title or an empty body", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    // Draft creation validates nothing, so both of these exist and neither publishes.
    const blankTitle = await writeDraft(h, job.id, "   ", "body\n");
    const blankBody = await writeDraft(h, job.id, "Title", "   \n");

    const noTitle = await tool(h, "reports_publish_draft").execute({ id: blankTitle.id, jobId: job.id }, api, ctx);
    expect(noTitle.isError).toBe(true);
    expect(textOf(noTitle)).toContain("title must not be empty");

    const noBody = await tool(h, "reports_publish_draft").execute({ id: blankBody.id, jobId: job.id }, api, ctx);
    expect(noBody.isError).toBe(true);
    expect(textOf(noBody)).toContain("body must not be empty");

    expect(await h.runtime.reports.list(ctx)).toHaveLength(0);
    expect(await h.runtime.harness.snapshot(SecReportDraft, blankBody.id, ctx)).toBeDefined();
  });

  it("audits a draft the boot sweep retires over its missing body file", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "work");
    const draft = await writeDraft(h, jobId, "Half written", "body\n");
    // The state a crash between the file write and the row write leaves behind, or
    // a cache directory that was cleared under a live store.
    await rm(draft.path, { force: true });

    // The live registry is passed here because the runtime passes it: the job is
    // still there, so the missing file is the only reason left.
    expect(await draftsOf(h).sweep(ctx, h.runtime.jobs)).toEqual({ retired: 1, orphanFiles: 0 });

    // The row is gone, so the audit entry is the only thing left that says the
    // draft existed and why it was retired.
    const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed" && event.draftId === draft.id,
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "body-file-missing" });
    expect(await h.runtime.harness.snapshot(SecReportDraft, draft.id, ctx)).toBeUndefined();
  });

  it("drops a pending draft in the boot sweep when its job is no longer live", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "still live");
    // A draft whose job is not in the registry: what an archive leaves behind if
    // the store was written by a binary that did not clean up, or a job id that
    // never existed in this store.
    const gone = "01JNOPE00000000000000000000";
    expect(await h.runtime.jobs.get(ctx, gone)).toBeUndefined();
    const orphan = await draftsOf(h).create(ctx, {
      agentConversationId: "1",
      jobId: gone,
      title: "Orphaned",
      content: "body\n",
    });
    const live = await writeDraft(h, jobId, "Still live", "body\n");

    expect(await draftsOf(h).sweep(ctx, h.runtime.jobs)).toEqual({ retired: 1, orphanFiles: 0 });
    expect(await h.runtime.harness.snapshot(SecReportDraft, orphan.id, ctx)).toBeUndefined();
    // A draft whose job is still live is left alone, and so is its file.
    expect(await h.runtime.harness.snapshot(SecReportDraft, live.id, ctx)).toBeDefined();
    expect(await stat(live.path).catch(() => undefined)).toBeDefined();

    const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed" && event.draftId === orphan.id,
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "orphaned", jobId: gone });
    // The row retires and the body file stays, because this pass counts only the
    // files no row claimed when it started. The file goes on the sweep after this
    // one, which is also true of the archive path.
    expect(await stat(orphan.path).catch(() => undefined)).toBeDefined();
    expect(await draftsOf(h).sweep(ctx, h.runtime.jobs)).toEqual({ retired: 0, orphanFiles: 1 });
    expect(await stat(orphan.path).catch(() => undefined)).toBeUndefined();
  });

  it("drops a job's drafts when the archive sweep moves the job out", async () => {
    const h = await boot();
    const jobId = await liveJob(h, "finished work");
    const draft = await writeDraft(h, jobId, "Draft of the plan", "body\n");
    const other = await liveJob(h, "still running");
    const kept = await writeDraft(h, other, "Kept", "body\n");
    await h.runtime.jobs.update(ctx, jobId, { status: "done" });

    expect((await h.runtime.archive.sweep(ctx, 0)).archived).toEqual([jobId]);

    // A draft is a temporary file rather than a document the job kept, so it does
    // not move into the archive with the job; it goes.
    expect(await h.runtime.harness.snapshot(SecReportDraft, draft.id, ctx)).toBeUndefined();
    expect(await h.runtime.harness.snapshot(SecReportDraft, kept.id, ctx)).toBeDefined();
    // The disposal retires the row and leaves the body file, which is what the
    // orphan-file pass of the next boot sweep is for: the row is gone, so the file
    // has nothing left to belong to.
    expect(await draftsOf(h).sweep(ctx, h.runtime.jobs)).toEqual({ retired: 0, orphanFiles: 1 });
    expect(await stat(draft.path).catch(() => undefined)).toBeUndefined();
    expect(await stat(kept.path).catch(() => undefined)).toBeDefined();
    const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed" && event.draftId === draft.id,
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toMatchObject({ outcome: "dropped", reason: "job-archived", jobId });
  });

  it("records the fate of each draft in the audit log", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const kept = await writeDraft(h, job.id, "Kept", "body\n");
    const unused = await writeDraft(h, job.id, "Unused", "body\n");

    await tool(h, "reports_publish_draft").execute({ id: kept.id, jobId: job.id }, api, ctx);
    await tool(h, "reports_draft_drop").execute({ id: unused.id }, api, ctx);

    // Both rows retire with their file, so the audit trail is the only record
    // that says which of the two was published and which was thrown away.
    const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed",
    );
    expect(disposed).toHaveLength(2);
    expect(disposed.find((event) => event.draftId === kept.id)).toMatchObject({ outcome: "accepted" });
    expect(disposed.find((event) => event.draftId === unused.id)).toMatchObject({ outcome: "dropped" });
  });

  it("keeps a deleted subagent's drafts, and names the job that holds them", async () => {
    const h = await boot();
    const childId = 7 as ConversationId;
    const jobId = await liveJob(h, "the child's work");
    await handWrittenSubagent(h, childId);

    const childApi = { conversationId: childId } as unknown as ToolExecutionApi;
    const first = await writeDraft(h, jobId, "Findings first pass", "body\n", childApi);
    const second = await writeDraft(h, jobId, "Second attempt", "body\n", childApi);
    const mine = await writeDraft(h, jobId, "Not the child's", "body\n");
    // The older kind of row, written before the job field existed, still follows
    // its author: that is the one difference the delete path keeps.
    const legacy = await writeLegacyDraft(h, String(childId), "Old shape", "body\n");

    const text = textOf(await tool(h, "subagent_delete").execute({ name: "researcher", reason: "done" }, api, ctx));

    // A draft is invisible to the operator's lists, so this result is the only
    // place the root learns that the drafts survived and which job holds them.
    expect(text).toContain("2 draft reports stayed with their jobs and can still be published");
    expect(text).toContain(`${first.id} (job ${jobId})`);
    expect(text).toContain(`${second.id} (job ${jobId})`);
    // Both stay, with their bodies, so the root can still publish them.
    expect(await h.runtime.harness.snapshot(SecReportDraft, first.id, ctx)).toMatchObject({
      status: "pending",
      jobId,
    });
    expect(await h.runtime.harness.snapshot(SecReportDraft, second.id, ctx)).toBeDefined();
    expect(await stat(first.path).catch(() => undefined)).toBeDefined();

    // The row with no job keeps the older lifetime, and the deletion is a disposal
    // too, so it leaves the same audit entry the draft tools leave.
    expect(await h.runtime.harness.snapshot(SecReportDraft, legacy.id, ctx)).toBeUndefined();
    const disposed = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed" && event.draftId === legacy.id,
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toMatchObject({ outcome: "dropped", conversationId: "1" });
    // A survivor is not a disposal, and another author's draft is untouched.
    const survivors = (await readAuditTail(h.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "report_draft_disposed" && (event.draftId === first.id || event.draftId === mine.id),
    );
    expect(survivors).toHaveLength(0);
    expect(await h.runtime.harness.snapshot(SecReportDraft, mine.id, ctx)).toBeDefined();
  });

  it("keeps the older lifetime for a row written before the job field existed", async () => {
    const h = await boot();
    const childId = 7 as ConversationId;
    const anyJob = await liveJob(h, "any job at all");
    await handWrittenSubagent(h, childId);
    const legacy = await writeLegacyDraft(h, String(childId), "Old shape", "body\n");

    // A reader sees no job, so the guess about which job to publish into is not
    // made for it.
    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: legacy.id }, api, ctx)));
    expect(view.kind).toBe("draft");
    expect(view.jobId).toBeUndefined();
    expect(view.publish).toContain("giving it this id and a jobId");

    // It publishes into any live job, which is what the older rule allowed.
    const text = textOf(await tool(h, "reports_publish_draft").execute({ id: legacy.id, jobId: anyJob }, api, ctx));
    expect(text).toContain("published ");
    expect((await h.runtime.reports.list(ctx))[0]).toMatchObject({ jobId: anyJob });
    expect(await h.runtime.harness.snapshot(SecReportDraft, legacy.id, ctx)).toBeUndefined();

    // And it is still dropped with its author, rather than with a job.
    const another = await writeLegacyDraft(h, String(childId), "Another old shape", "body\n");
    await tool(h, "subagent_delete").execute({ name: "researcher", reason: "done" }, api, ctx);
    expect(await h.runtime.harness.snapshot(SecReportDraft, another.id, ctx)).toBeUndefined();
  });

  it("reads a report by its own id exactly as before", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, {
      jobId: job.id,
      title: "Findings",
      content: "# Findings\n",
      note: "first",
    });

    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: report.id, includeBody: true }, api, ctx)));
    expect(view.kind).toBeUndefined();
    expect(view.id).toBe(report.id);
    expect(view.url).toBe(`/report/${report.name}`);
    expect(view.body).toBe("# Findings\n");
    expect(view.bodyVersion).toBe(1);
    expect(view.job).toMatchObject({ id: job.id, title: "work" });
    // A record with no approval carries no key, so a reader that does not know the
    // field sees the same document it saw before.
    expect(view.versions[0].approval).toBeUndefined();
  });

  // The body is served from the file on disk, so the file is what a reader gets.
  // When it no longer matches the digest the revision recorded, the response says
  // so instead of presenting the text as the revision that was written.
  it("flags a body whose file no longer matches the revision's sha256", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "# Findings\n" });

    await writeFile(join(h.paths.reportsDir, report.id, "v1.md"), "# Findings\n\nrewritten on disk\n", "utf8");

    const view = JSON.parse(textOf(await tool(h, "reports_get").execute({ id: report.id, includeBody: true }, api, ctx)));
    expect(view.bodySha256Mismatch).toBe(true);
    // The text served is the file's, and the version it claims to be is unchanged.
    expect(view.body).toBe("# Findings\n\nrewritten on disk\n");
    expect(view.bodyVersion).toBe(1);
  });

  it("adds no mismatch field for a body that still matches its sha256", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "# Findings\n" });

    const text = textOf(await tool(h, "reports_get").execute({ id: report.id, includeBody: true }, api, ctx));
    const view = JSON.parse(text);
    expect(await h.runtime.reports.readVersion(report.id, 1)).toBe("# Findings\n");
    expect(view.body).toBe("# Findings\n");
    // A healthy body keeps the response shape it had before the check existed, so
    // the key is absent rather than false.
    expect("bodySha256Mismatch" in view).toBe(false);
    expect(text).not.toContain("bodySha256Mismatch");
  });

  it("shows an approval in the listing once there is one", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Planned", content: "one\n" });

    const before = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(before).toContain(`/report/${report.name}`);
    expect(before).not.toContain("approved v");

    await h.runtime.reports.approve(ctx, report.id, 1, { via: "viewer" });

    const after = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(after).toContain("approved v1");

    // The newest approved revision is the one named, so a later revision does not
    // make the line claim the new text was approved.
    await h.runtime.reports.addVersion(ctx, report.id, { content: "two\n", note: "second" });
    const moved = textOf(await tool(h, "reports_list").execute({}, api, ctx));
    expect(moved).toContain("v=2");
    expect(moved).toContain("approved v1");
    expect(moved).not.toContain("approved v2");
  });
});

describe("report notice", () => {
  const record: ReportRecord = {
    id: "01J-report",
    jobId: "01J-job",
    name: "261015-plan",
    title: "Plan",
    versions: [{ n: 1, at: 1000, bytes: 4, sha256: "a".repeat(64) }],
    feedback: [],
    createdAt: 1000,
    updatedAt: 1000,
  };

  it("names each of the three changes in its field, and puts the answer in the body", () => {
    // The three kinds carry the report's own title and no words in front of it. What
    // a reader of the inbox is told about the kind is `reportEvent`, and the UI draws
    // it as a colored mark rather than spending the row on a header string.
    const created = reportNotice({ kind: "created", report: record });
    expect(created.title).toBe("Plan");
    expect(created.reportEvent).toBe("published");
    // A revision keeps its number on the title and a publication does not: the
    // header is gone, the fact that tells two notices apart is not.
    const revised = reportNotice({ kind: "updated", report: record });
    expect(revised.title).toBe("Plan (v1)");
    expect(revised.reportEvent).toBe("updated");
    // The body is untouched: the address lines a report write has always carried.
    expect(created.body).toBe("/report/261015-plan\njob 01J-job\nv1");

    const answer = "The second step stands: the retry is what makes the first one safe.";
    const answered = reportNotice({ kind: "answered", report: record, answer });
    expect(answered.title).toBe("Plan");
    expect(answered.reportEvent).toBe("answered");
    expect(answered.kind).toBe("report");
    expect(answered.reportId).toBe(record.id);
    expect(answered.jobId).toBe(record.jobId);
    // The answer is the first line, and the address a report write would have used
    // is under it, so the item reads the same way as every other report notice.
    const lines = answered.body.split("\n");
    expect(lines[0]).toBe(answer);
    expect(lines.slice(-3)).toEqual(["/report/261015-plan", "job 01J-job", "v1"]);
  });
});

describe("notify tool", () => {
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

  /** The api the harness hands a tool: an id, and a commit into the session. */
  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: 1,
      commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: typeof ctx) =>
        h.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  it("raises a report notice for an existing report without adding a revision", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Handover", content: "# Handover\n" });
    const before = new Set((await h.runtime.inbox.list(ctx)).map((item) => item.id));

    const text = textOf(
      await tool(h, "notify").execute(
        { title: "Approval needed: Handover", body: "This is the report I am waiting on.", reportId: report.id },
        execApi(h),
        ctx,
      ),
    );
    expect(text).toMatch(/^inbox item \S+ created$/);

    const written = (await h.runtime.inbox.list(ctx)).filter((item) => !before.has(item.id));
    expect(written).toHaveLength(1);
    const item = written[0]!;
    // A report notice: the chat UI reads `reportId` alone to open the panel, and
    // the kind is what the stored item says about itself.
    expect(item.kind).toBe("report");
    expect(item.source?.reportId).toBe(report.id);
    expect(item.source?.jobId).toBe(job.id);
    expect(item.title).toBe("Approval needed: Handover");
    // The words the agent wrote, then the address a report write would have put
    // under its own title, so the document is findable when a click cannot open it.
    expect(item.body).toContain("This is the report I am waiting on.");
    expect(item.body).toContain(`/report/${report.name}`);
    expect(item.body).toContain(`job ${job.id}`);
    expect(item.body).toContain("v1");

    // Nothing was written to the report: the notice is the whole effect.
    const after = await h.runtime.reports.get(ctx, report.id);
    expect(after?.versions).toHaveLength(1);
    expect(after?.updatedAt).toBe(report.updatedAt);
  });

  it("stands in the address alone when the agent writes no words", async () => {
    const h = await boot();
    const job = await h.runtime.jobs.create(ctx, { title: "work" });
    const report = await h.runtime.reports.create(ctx, { jobId: job.id, title: "Findings", content: "one\n" });

    await tool(h, "notify").execute({ title: "Look again", body: "  ", reportId: report.id }, execApi(h), ctx);

    const item = (await h.runtime.inbox.list(ctx)).filter((entry) => entry.source?.reportId === report.id).at(-1)!;
    expect(item.body).toBe(`/report/${report.name}\njob ${job.id}\nv1`);
  });

  it("raises a notice for a report whose job is finished and archived", async () => {
    const h = await boot();
    const { jobs, reports, archive } = h.runtime;
    const job = await jobs.create(ctx, { title: "finished work" });
    const report = await reports.create(ctx, { jobId: job.id, title: "Handover", content: "# Handover\n" });
    await jobs.update(ctx, job.id, { status: "done" });
    await archive.sweep(ctx, 0);

    // An archived report still resolves, so the notice is not refused for pointing
    // at finished work. The panel is where the operator learns it cannot be
    // confirmed any more, rather than a refusal here that says nothing.
    const result = await tool(h, "notify").execute(
      { title: "Handover is filed", body: "Reading, not confirming.", reportId: report.id },
      execApi(h),
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const item = (await h.runtime.inbox.list(ctx)).filter((entry) => entry.source?.reportId === report.id).at(-1)!;
    expect(item.kind).toBe("report");
    expect(item.source?.jobId).toBe(job.id);
    expect(item.body).toContain(`/report/${report.name}`);
  });

  it("refuses an id that names no report, and writes nothing", async () => {
    const h = await boot();
    const result = await tool(h, "notify").execute(
      { title: "x", body: "y", reportId: "01M4ZZZZZZZZZZZZZZZZZZZZZZ" },
      execApi(h),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No report with id 01M4ZZZZZZZZZZZZZZZZZZZZZZ");
    expect(await h.runtime.inbox.list(ctx)).toEqual([]);
  });

  it("leaves a plain notice when no report is named", async () => {
    const h = await boot();
    await tool(h, "notify").execute({ title: "Brief", body: "All good" }, execApi(h), ctx);

    const items = await h.runtime.inbox.list(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("notice");
    expect(items[0]?.source?.reportId).toBeUndefined();
    expect(items[0]?.body).toBe("All good");
  });
});

describe("report routes", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<string> {
    harness = await createTestHarness({
      config: { server: { ...defaultConfig().server, port: 0 } },
    });
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

  async function post(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("serves the report page at /report and at a slug", async () => {
    const origin = await boot();
    for (const path of ["/report", "/report/some-slug"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      // The asset prefix is stamped, and the page carries no inline script (CSP).
      expect(html).toContain("/report/assets/ui-report.js");
      expect(html).not.toContain("{{base}}");
    }
  });

  it("walks a report from creation to diff to feedback", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });

    const created = await post(origin, "/api/reports", {
      jobId: job.id,
      title: "Plan",
      content: "one\ntwo\n",
    });
    expect(created.status).toBe(201);
    const report = (await created.json()) as { id: string; name: string; active: boolean };
    expect(report.active).toBe(true);

    const version = await post(origin, `/api/reports/${report.id}/versions`, { content: "one\nTWO\n", note: "tweak" });
    expect(version.status).toBe(201);

    const diff = await (await fetch(`${origin}/api/reports/${report.id}/diff?from=1&to=2`)).json();
    expect(diff).toMatchObject({ from: 1, to: 2, added: 1, removed: 1, identical: false });

    const feedback = await post(origin, `/api/reports/${report.id}/feedback`, { body: "looks right", version: 2 });
    expect(feedback.status).toBe(201);

    const byName = await (await fetch(`${origin}/api/reports/by-name/${report.name}`)).json();
    expect(byName).toMatchObject({ id: report.id, feedback: [{ body: "looks right", version: 2 }] });

    // The note reaches the agent as an input submission — the admission that
    // starts a run — not parked in a surface somebody has to go and read.
    const conversation = await resolveDefaultConversation(harness!.runtime.harness, harness!.runtime.getConfig(), harness!.runtime.paths, ctx);
    const page = await conversation.entries({ order: "ascending" }, 50, undefined, ctx);
    const texts = page.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) => entry.model.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n"));
    // The note is stored as an envelope, so the marker line is no longer the first
    // line of the stored text. It is found by what it parses to, and the parse is
    // then compared exactly.
    const review = texts.find((text) => parseReview(text) !== undefined);
    expect(review).toBeDefined();
    expect(readMessage(review!)?.source).toBe("operator");
    expect(parseReview(review!)).toEqual({ report: report.name, version: 2, text: "looks right" });
  });

  it("refuses a report that names no live job", async () => {
    const origin = await boot();
    const response = await post(origin, "/api/reports", { jobId: "nope", title: "Orphan", content: "x\n" });
    expect(response.status).toBe(400);
  });

  it("leaves one inbox notice per published revision", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "Brief", content: "a\n" });
    const report = (await created.json()) as { id: string; name: string };
    await post(origin, `/api/reports/${report.id}/versions`, { content: "b\n", note: "tweak" });

    const notices = (await harness!.runtime.inbox.list(ctx)).filter((item) => item.kind === "report");
    expect(notices).toHaveLength(2);
    // Both point at the report, which is what the chat UI opens the panel from.
    expect(notices.map((item) => item.source?.reportId)).toEqual([report.id, report.id]);
    expect(notices.map((item) => item.source?.jobId)).toEqual([job.id, job.id]);
    // The kind of write is a field on the source, and the title is the report's own
    // in both cases: the row says which is which by the color of its mark.
    expect(notices.map((item) => item.source?.reportEvent).sort()).toEqual(["published", "updated"]);
    // The header is gone from both, and only the revision carries its number.
    expect(notices.map((item) => item.title).sort()).toEqual(["Brief", "Brief (v2)"]);
    const updated = notices.find((item) => item.source?.reportEvent === "updated")!;
    expect(updated.body).toContain(`/report/${report.name}`);
    // The revision number stayed in the body, where the address lines live.
    expect(updated.body).toContain("v2");
    expect(updated.body).toContain("tweak");
  });

  it("leaves no inbox notice for a note written in the viewer", async () => {
    // A note is pushed into the conversation, which is where the agent reads it.
    // An inbox item about it would tell the operator what they had just written.
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "Brief", content: "a\n" });
    const report = (await created.json()) as { id: string };

    await post(origin, `/api/reports/${report.id}/feedback`, { body: "one more section", version: 1 });

    const notices = (await harness!.runtime.inbox.list(ctx)).filter((item) => item.kind === "report");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Brief");
    expect(notices[0]?.source?.reportEvent).toBe("published");
  });

  it("refuses an empty document", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const response = await post(origin, "/api/reports", { jobId: job.id, title: "Empty", content: "   " });
    expect(response.status).toBe(400);
  });

  it("reports a missing revision rather than an empty document", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "One", content: "a\n" });
    const report = (await created.json()) as { id: string };

    expect((await fetch(`${origin}/api/reports/${report.id}/versions/9`)).status).toBe(404);
    expect((await fetch(`${origin}/api/reports/unknown-id`)).status).toBe(404);
  });

  it("marks a report inactive once its job is finished, without touching the record", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "Done soon", content: "a\n" });
    const report = (await created.json()) as { id: string };

    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });

    const view = await (await fetch(`${origin}/api/reports/${report.id}`)).json();
    // Derived, not stored: reopening the job makes it active again for free.
    expect(view).toMatchObject({ active: false, archived: false });
    await harness!.runtime.jobs.update(ctx, job.id, { status: "active" });
    const reopened = await (await fetch(`${origin}/api/reports/${report.id}`)).json();
    expect(reopened.active).toBe(true);
  });

  it("serves the standing word, and keeps `active` about the job", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "Later", content: "a\n" });
    const report = (await created.json()) as { id: string };

    expect((await (await fetch(`${origin}/api/reports/${report.id}`)).json())).toMatchObject({ status: "active" });

    await harness!.runtime.reports.setPending(ctx, report.id, true);
    const aside = await (await fetch(`${origin}/api/reports/${report.id}`)).json();
    // `active` still answers the question the approval path asks: the job is live,
    // so a revision on this report can still be confirmed.
    expect(aside).toMatchObject({ status: "pending", active: true, archived: false });

    const list = await (await fetch(`${origin}/api/reports`)).json();
    expect(list.reports.map((entry: { id: string; status: string }) => [entry.id, entry.status])).toEqual([
      [report.id, "pending"],
    ]);

    // The job's end outranks the flag, and does not clear it.
    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });
    expect(await (await fetch(`${origin}/api/reports/${report.id}`)).json()).toMatchObject({ status: "inactive" });
    await harness!.runtime.jobs.update(ctx, job.id, { status: "active" });
    expect(await (await fetch(`${origin}/api/reports/${report.id}`)).json()).toMatchObject({ status: "pending" });
  });

  it("marks a set-aside report's notice so it stops asking to be read", async () => {
    const origin = await boot();
    const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
    const created = await post(origin, "/api/reports", { jobId: job.id, title: "Brief", content: "a\n" });
    const report = (await created.json()) as { id: string };

    const before = (await (await fetch(`${origin}/api/inbox`)).json()) as { items: { pending?: boolean }[] };
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.pending).toBeUndefined();

    await harness!.runtime.reports.setPending(ctx, report.id, true);
    const after = (await (await fetch(`${origin}/api/inbox`)).json()) as { items: { pending?: boolean }[] };
    // The item stays: it records a write that happened. What it stops doing is
    // raising the unread badge, which is the client's read of this field.
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.pending).toBe(true);

    // A once-only `true`: the field is absent rather than false, so a caller reads
    // it the way it reads every other optional field on an item.
    await harness!.runtime.jobs.update(ctx, job.id, { status: "done" });
    const finished = (await (await fetch(`${origin}/api/inbox`)).json()) as { items: { pending?: boolean }[] };
    expect(finished.items[0]?.pending).toBeUndefined();
  });
});
