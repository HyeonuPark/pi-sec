import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { SecAgent, SecAgentChild, SecAsyncCall, SecUserQueryList, userQueryKey } from "../src/documents.ts";
import { createAttachmentsExtension } from "../src/extensions/attachments.ts";
import { createAskUserExtension } from "../src/extensions/ask-user.ts";
import { createAsyncToolsExtension } from "../src/extensions/async-tools.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createDiagnosticsExtension } from "../src/extensions/diagnostics.ts";
import { createJobsExtension } from "../src/extensions/jobs.ts";
import { createLessonsExtension, getLesson, withLocalScan, type LessonDeps } from "../src/extensions/lessons.ts";
import { createReportsExtension } from "../src/extensions/reports.ts";
import { SubagentHub } from "../src/extensions/subagents.ts";
import { zoneIso } from "../src/time-format.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The times a tool prints, in the harness zone.
 *
 * A text answer carries `2026-10-24T16:30:05+09:00` rather than a UTC string, so
 * an agent reading it does not convert by hand. A JSON answer keeps every number
 * it had, because a script may read those, and adds `<name>Local` beside the
 * times in the table: the same instant, in the same form. Each twin is checked
 * twice here — against the number it twins, and against the string the zone
 * module builds from that number — because a twin that parses back to the right
 * instant is the whole point.
 *
 * The zone is `Asia/Tokyo`, so a value written in UTC would end in `Z` and a
 * value sliced off a `Date` would carry no offset at all. Both fail.
 */
const ZONE = "Asia/Tokyo";
const CTX = BACKGROUND_CONTEXT;

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

interface ToolLike {
  readonly name: string;
  execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<ToolResult>;
}

/** The lesson store, read the way the lessons tools read it. */
function lessonDeps(h: TestHarness): LessonDeps {
  return {
    storage: h.runtime.storage,
    reader: () => h.runtime.harness,
    redactor: () => h.runtime.secrets.redactor(),
  };
}

/** The harness zone's form of one instant, which is what every answer must carry. */
function zoned(ms: number): string {
  return zoneIso(ms, ZONE);
}

/** The zone form as a pattern, for a field whose instant this test does not know. */
const ZONE_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;

function textOf(result: ToolResult): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/**
 * Every member of the extension context, taken from the running test harness.
 *
 * One object for every extension: a tool that needs a store the harness already
 * holds gets that store, so the test drives the same wiring the daemon does.
 */
function runtimeContext(h: TestHarness): ExtensionContext {
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
    drafts: runtime.drafts,
    subagents: runtime.subagents,
  } as unknown as ExtensionContext;
}

function toolOf(extension: { tools?: readonly unknown[] }, name: string): ToolLike {
  const found = (extension.tools ?? []).find((candidate) => (candidate as ToolLike).name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found as unknown as ToolLike;
}

/** The execution API a tool call gets, with the harness's own commit behind it. */
function execApi(h: TestHarness, conversationId: ConversationId = ROOT_CONVERSATION_ID): ToolExecutionApi {
  return {
    conversationId,
    commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: Context) =>
      h.runtime.harness.commit(change, context),
    // `questions_open` reads its list through the call's own snapshot.
    snapshot: (token: never, context: Context) => h.runtime.harness.snapshot(token, context),
  } as unknown as ToolExecutionApi;
}

/**
 * A `Local` twin beside a number field.
 *
 * The twin must be the zone form of the same instant to the second: `zoneIso`
 * truncates milliseconds, so the number is floored to its second before the two
 * are compared, and a value that parsed to a second either side would fail.
 */
function expectLocalTwin(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  expect(typeof value, `${key} should be a number`).toBe("number");
  const twin = record[`${key}Local`];
  expect(typeof twin, `${key}Local should be a string`).toBe("string");
  expect(twin as string).toMatch(ZONE_FORM);
  expect(twin).toBe(zoned(value as number));
  expect(Date.parse(twin as string)).toBe(Math.floor((value as number) / 1000) * 1000);
}

/** The time field of a text answer, read back as an instant. */
function timeInText(text: string, field: string): number {
  const form = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}";
  const match = new RegExp(`(?:^|\\s)${field}="?(${form})`).exec(text);
  if (match?.[1] === undefined) throw new Error(`no ${field} in: ${text}`);
  expect(match[1], `${field} in: ${text}`).toMatch(ZONE_FORM);
  const parsed = Date.parse(match[1]);
  expect(Number.isNaN(parsed)).toBe(false);
  return parsed;
}

describe("tool output times are in the harness zone", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness({ config: { timezone: ZONE } });
    expect(harness.config.timezone).toBe(ZONE);
    return harness;
  }

  describe("jobs", () => {
    it("prints lastRun and completed in the zone, from jobs_create, jobs_update and jobs_list", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      const api = execApi(h);
      const tools = createJobsExtension(context);
      const create = toolOf(tools, "jobs_create");
      const update = toolOf(tools, "jobs_update");
      const list = toolOf(tools, "jobs_list");

      const created = textOf(await create.execute({ title: "a job that ran" } as never, api, CTX));
      const id = /^created (\S+) \[/.exec(created)?.[1];
      expect(id).toBeDefined();

      // A recorded run is what puts `lastRun` on the line, and the store's own
      // instant is what the line must carry.
      const ran = textOf(
        await update.execute({ id, recordRun: { success: true, summary: "ran once" } } as never, api, CTX),
      );
      const at = timeInText(ran, "lastRun");
      const stored = await h.runtime.jobs.get(CTX, id!);
      // `zoneIso` truncates to the second, so the instant read back from the text
      // is the stored one floored to its second.
      expect(Math.floor(stored!.lastRun!.at / 1000) * 1000).toBe(at);
      expect(ran).toContain(`lastRun=${zoned(stored!.lastRun!.at)}:success`);

      const done = textOf(await update.execute({ id, status: "done" } as never, api, CTX));
      const completedAt = timeInText(done, "completed");
      const finished = await h.runtime.jobs.get(CTX, id!);
      expect(Math.floor(finished!.completedAt! / 1000) * 1000).toBe(completedAt);
      expect(done).toContain(`completed=${zoned(finished!.completedAt!)}`);

      // The listing prints the same fields through the same formatter.
      const listed = textOf(await list.execute({} as never, api, CTX));
      expect(listed).toContain(`lastRun=${zoned(stored!.lastRun!.at)}:success`);
      expect(listed).toContain(`completed=${zoned(finished!.completedAt!)}`);
    });
  });

  describe("reports", () => {
    it("prints updated and written in the zone, from every report tool that answers with a line", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      const api = execApi(h);
      const tools = createReportsExtension(context);
      const create = toolOf(tools, "reports_create");
      const addVersion = toolOf(tools, "reports_add_version");
      const setPending = toolOf(tools, "reports_set_pending");
      const move = toolOf(tools, "reports_move");
      const list = toolOf(tools, "reports_list");

      const job = await h.runtime.jobs.create(CTX, { title: "the job a report belongs to" });
      const other = await h.runtime.jobs.create(CTX, { title: "the job it moves to" });

      const published = textOf(
        await create.execute({ jobId: job.id, title: "Plan", content: "one\n" } as never, api, CTX),
      );
      const reportId = /^published (\S+) \/report\//.exec(published)?.[1];
      expect(reportId).toBeDefined();
      const first = await h.runtime.reports.getAny(CTX, reportId!);
      expect(published).toContain(`updated=${zoned(first!.updatedAt)}`);
      expect(timeInText(published, "updated")).toBe(Math.floor(first!.updatedAt / 1000) * 1000);

      const revised = textOf(await addVersion.execute({ id: reportId, content: "one\ntwo\n" } as never, api, CTX));
      const second = await h.runtime.reports.getAny(CTX, reportId!);
      expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt);
      expect(revised).toContain(`updated=${zoned(second!.updatedAt)}`);

      const aside = textOf(await setPending.execute({ id: reportId, pending: true } as never, api, CTX));
      expect(aside.startsWith("pending ")).toBe(true);
      expect(aside).toContain(`updated=${zoned((await h.runtime.reports.getAny(CTX, reportId!))!.updatedAt)}`);

      const moved = textOf(await move.execute({ id: reportId, jobId: other.id } as never, api, CTX));
      expect(moved.startsWith(`moved ${reportId} from job ${job.id} to job ${other.id}: `)).toBe(true);
      expect(moved).toContain(`updated=${zoned((await h.runtime.reports.getAny(CTX, reportId!))!.updatedAt)}`);

      // The listing carries the same line, and the draft section carries
      // `written=` through its own formatter.
      const listed = textOf(await list.execute({ jobId: other.id } as never, api, CTX));
      expect(listed).toContain(`updated=${zoned((await h.runtime.reports.getAny(CTX, reportId!))!.updatedAt)}`);

      const draft = await h.runtime.drafts.create(CTX, {
        agentConversationId: String(ROOT_CONVERSATION_ID),
        jobId: other.id,
        title: "A draft nobody published",
        note: "first words",
        content: "draft body\n",
      });
      const withDraft = textOf(await list.execute({ jobId: other.id } as never, api, CTX));
      expect(withDraft).toContain(`written=${zoned(draft.createdAt)}`);
      expect(timeInText(withDraft, "written")).toBe(Math.floor(draft.createdAt / 1000) * 1000);
    });
  });

  describe("lessons", () => {
    it("prints updated in the zone, from lessons_list, lessons_update and lessons_reword", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      const api = execApi(h);
      const tools = createLessonsExtension(context);
      const record = toolOf(tools, "lessons_record");
      const list = toolOf(tools, "lessons_list");
      const update = toolOf(tools, "lessons_update");
      const reword = toolOf(tools, "lessons_reword");

      const recorded = await record.execute(
        { statement: "the zone is config, not a constant", category: "self_found" } as never,
        api,
        CTX,
      );
      // `lessons_record` answers with the id and the neighbours and prints no
      // time at all, so it has no UTC string to convert and nothing was added.
      expect(textOf(recorded)).toMatch(/^created \S+ recurrence=1/);
      expect(textOf(recorded)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      const id = /^created (\S+) /.exec(textOf(recorded))?.[1];
      expect(id).toBeDefined();

      const listed = textOf(await list.execute({} as never, api, CTX));
      const at = timeInText(listed, "updated");
      expect(at).toBe(Math.floor((await getLesson(lessonDeps(h), CTX, id!))!.updatedAt / 1000) * 1000);

      const noted = textOf(
        await update.execute({ id, note: "a note on the row", severity: "high" } as never, api, CTX),
      );
      const afterNote = await getLesson(lessonDeps(h), CTX, id!);
      expect(noted).toContain(`updated=${zoned(afterNote!.updatedAt)}`);

      const reworded = textOf(
        await reword.execute(
          { id, statement: "the zone comes from config and is never a constant" } as never,
          api,
          CTX,
        ),
      );
      const afterReword = await getLesson(lessonDeps(h), CTX, id!);
      expect(reworded).toContain(`reworded ${id}`);
      expect(reworded).toContain(`updated=${zoned(afterReword!.updatedAt)}`);
    });
  });

  describe("background_list", () => {
    it("prints started, settled, delivered, updated and progress in the zone", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      // The subagent rows come from the hub, which the subagents extension
      // installs onto the context. Without the rest of the extensions, the test
      // installs that one object itself.
      context.subagents = new SubagentHub(context);
      const conversationId = String(ROOT_CONVERSATION_ID);
      const api = execApi(h);
      const tools = createAsyncToolsExtension(context);
      const list = toolOf(tools, "background_list");

      // One call record, written by hand: the point of the row is the time
      // fields, and a real background call would only defer them.
      const createdAt = Date.now() - 60_000;
      const settledAt = createdAt + 5_000;
      const deliveredAt = settledAt + 1_000;
      const childAt = createdAt + 2_000;
      const childUpdatedAt = createdAt + 3_000;
      const childEntryAt = createdAt + 4_000;
      const childId = await h.runtime.harness.commit(async (tx) => {
        // A family document takes its key and then the seed value its `initial`
        // builds the row from, which for these two is the key again.
        const call = await tx.doc(SecAsyncCall, ROOT_CONVERSATION_ID, "a call that settled", "a call that settled");
        call.title = "a call that settled";
        call.conversationId = conversationId;
        call.tool = "bash";
        call.status = "settled";
        call.createdAt = createdAt;
        call.settledAt = settledAt;
        call.deliveredAt = deliveredAt;

        const self = await tx.doc(SecAgent, conversationId, conversationId);
        self.kind = "root";
        self.name = "root";
        self.status = "waiting";

        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const id = String(conversation.id);
        const child = await tx.doc(SecAgent, id, id);
        child.kind = "subagent";
        child.name = "a child that worked";
        child.status = "waiting";
        child.vmodel = "faux";
        child.createdAt = childAt;
        child.updatedAt = childUpdatedAt;
        const index = await tx.doc(
          SecAgentChild,
          ROOT_CONVERSATION_ID,
          "a child that worked",
          "a child that worked",
        );
        index.conversationId = id;
        index.name = "a child that worked";
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "a seeded entry", timestamp: childEntryAt }],
        });
        return id;
      }, CTX);

      const line = textOf(await list.execute({} as never, api, CTX));
      const callLine = line.split("\n").find((each) => each.includes('title="a call that settled"'));
      expect(callLine).toBeDefined();
      expect(callLine).toContain(`started="${zoned(createdAt)}"`);
      expect(callLine).toContain(`settled="${zoned(settledAt)}"`);
      expect(callLine).toContain(`delivered="${zoned(deliveredAt)}"`);

      const childLine = line.split("\n").find((each) => each.includes(`conversation="${childId}"`));
      expect(childLine, line).toBeDefined();
      expect(childLine).toContain(`started="${zoned(childAt)}"`);
      expect(childLine).toContain(`updated="${zoned(childUpdatedAt)}"`);
      // Progress is the newest of the last entry and the last task end, read at
      // the moment of the call, so its instant is checked through the form.
      expect(timeInText(childLine!, "progress")).toBe(Math.floor(childEntryAt / 1000) * 1000);
    });
  });

  describe("diagnose_conversation", () => {
    it("prints lastEntryAt in the zone, and leaves silentMs a duration", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      const api = execApi(h);
      const tools = createDiagnosticsExtension(context);
      const diagnose = toolOf(tools, "diagnose_conversation");

      const at = Date.now() - 90_000;
      const conversationId = await h.runtime.harness
        .commit(async (tx) => {
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          const id = String(conversation.id);
          await tx.appendEntry(conversation.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "go", timestamp: at }],
          });
          const agent = await tx.doc(SecAgent, id, id);
          agent.status = "running";
          agent.updatedAt = at;
          return id;
        }, CTX);

      const text = textOf(await diagnose.execute({ conversationId } as never, api, CTX));
      const line = text.split("\n").find((each) => each.includes(`conversation="${conversationId}"`));
      expect(line).toBeDefined();
      expect(line).toContain(`lastEntryAt="${zoned(at)}"`);
      // A duration is not an instant, so it keeps its number of milliseconds.
      expect(line).toMatch(/ silentMs="\d+"/);
    });
  });

  describe("questions_open", () => {
    it("prints created in the zone", async () => {
      const h = await boot();
      const context = runtimeContext(h);
      const conversationId = String(ROOT_CONVERSATION_ID);
      const api = execApi(h);
      const tools = createAskUserExtension(context);
      const open = toolOf(tools, "questions_open");

      const createdAt = Date.now() - 30_000;
      const question = "which account?";
      await h.runtime.harness.commit(async (tx) => {
        const list = await tx.doc(SecUserQueryList);
        list.items.push({
          key: userQueryKey(conversationId, question, ["work"]),
          id: "01J000000000000000000000AA",
          conversationId,
          question,
          options: ["work"],
          createdAt,
        });
        list.updatedAt = createdAt;
      }, CTX);

      const text = textOf(await open.execute({} as never, api, CTX));
      expect(text).toContain(`created="${zoned(createdAt)}"`);
      expect(timeInText(text, "created")).toBe(Math.floor(createdAt / 1000) * 1000);
    });
  });
});

describe("a JSON answer keeps its numbers and adds a Local twin", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness({ config: { timezone: ZONE } });
    return harness;
  }

  it("jobs_get twins createdAt, updatedAt, completedAt, lastRun.at, once.at and drafts[].createdAt", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createJobsExtension(context);
    const create = toolOf(tools, "jobs_create");
    const update = toolOf(tools, "jobs_update");
    const get = toolOf(tools, "jobs_get");

    const created = textOf(
      await create.execute({ title: "a job with a single run" } as never, api, CTX),
    );
    const id = /^created (\S+) \[/.exec(created)?.[1];
    expect(id).toBeDefined();
    await update.execute(
      { id, recordRun: { success: false, summary: "it failed" } } as never,
      api,
      CTX,
    );
    await update.execute({ id, status: "failed" } as never, api, CTX);
    const draft = await h.runtime.drafts.create(CTX, {
      agentConversationId: String(ROOT_CONVERSATION_ID),
      jobId: id!,
      title: "a draft of that job",
      content: "draft body\n",
    });

    const job = jsonOf(await get.execute({ id } as never, api, CTX));
    for (const key of ["createdAt", "updatedAt", "completedAt"]) expectLocalTwin(job, key);
    expectLocalTwin(job.lastRun as Record<string, unknown>, "at");
    const drafts = job.drafts as Record<string, unknown>[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.createdAt).toBe(draft.createdAt);
    expectLocalTwin(drafts[0]!, "createdAt");
    // A job with no `once` has no `once.at` at all, so there is nothing to twin.
    expect(job.once ?? null).toBeNull();

    // A `once` given as an ISO string is not a number, so it gets no twin; the
    // same schedule given as epoch milliseconds does.
    const at = Date.now() + 3_600_000;
    const scheduled = textOf(
      await create.execute(
        { title: "a job with a single run scheduled", once: { at, prompt: "run", vmodel: "faux" } } as never,
        api,
        CTX,
      ),
    );
    const scheduledId = /^created (\S+) \[/.exec(scheduled)?.[1];
    const loaded = jsonOf(await get.execute({ id: scheduledId } as never, api, CTX));
    expect((loaded.once as Record<string, unknown>).at).toBe(at);
    expectLocalTwin(loaded.once as Record<string, unknown>, "at");
    expect((loaded.once as Record<string, unknown>).atLocal).toBe(zoned(at));
  });

  it("reports_get twins every time of the report branch and of the draft branch", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createReportsExtension(context);
    const create = toolOf(tools, "reports_create");
    const addVersion = toolOf(tools, "reports_add_version");
    const get = toolOf(tools, "reports_get");

    const job = await h.runtime.jobs.create(CTX, { title: "the job under the report" });
    const published = textOf(await create.execute({ jobId: job.id, title: "Plan", content: "one\n" } as never, api, CTX));
    const reportId = /^published (\S+) \/report\//.exec(published)?.[1];
    expect(reportId).toBeDefined();
    await addVersion.execute({ id: reportId, content: "one\ntwo\n" } as never, api, CTX);
    const approved = await h.runtime.reports.approve(CTX, reportId!, 2, { via: "panel" });
    expect(approved.ok).toBe(true);
    await h.runtime.reports.setPending(CTX, reportId!, true);
    await h.runtime.reports.addFeedback(CTX, reportId!, { body: "one note from the viewer", from: "operator" });

    const report = jsonOf(await get.execute({ id: reportId } as never, api, CTX));
    for (const key of ["createdAt", "updatedAt", "pendingAt"]) expectLocalTwin(report, key);
    const versions = report.versions as Record<string, unknown>[];
    expect(versions).toHaveLength(2);
    for (const version of versions) expectLocalTwin(version, "at");
    const approval = versions[1]!.approval as Record<string, unknown>;
    expect(approval).toBeDefined();
    expectLocalTwin(approval, "at");
    expect(versions[0]!.approval ?? null).toBeNull();
    const feedback = report.feedback as Record<string, unknown>[];
    expect(feedback).toHaveLength(1);
    expectLocalTwin(feedback[0]!, "at");

    const draft = await h.runtime.drafts.create(CTX, {
      agentConversationId: String(ROOT_CONVERSATION_ID),
      jobId: job.id,
      title: "a draft of the report",
      content: "draft body\n",
    });
    const draftAnswer = jsonOf(await get.execute({ id: draft.id, includeBody: true } as never, api, CTX));
    expect(draftAnswer.kind).toBe("draft");
    for (const key of ["createdAt", "updatedAt"]) expectLocalTwin(draftAnswer as Record<string, unknown>, key);
  });

  it("lessons_get twins createdAt, updatedAt, recurrence.lastSeenAt and notes[].at", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createLessonsExtension(context);
    const record = toolOf(tools, "lessons_record");
    const update = toolOf(tools, "lessons_update");
    const get = toolOf(tools, "lessons_get");

    const recorded = textOf(
      await record.execute({ statement: "a rule the store keeps", category: "self_found" } as never, api, CTX),
    );
    const id = /^created (\S+) /.exec(recorded)?.[1];
    expect(id).toBeDefined();
    await update.execute({ id, note: "the first note", severity: "high" } as never, api, CTX);
    // A second sighting writes the recurrence's last-seen time.
    await record.execute(
      { statement: "a rule the store keeps", category: "self_found", relation: "recurrence", duplicateOf: id } as never,
      api,
      CTX,
    );

    const lesson = jsonOf(await get.execute({ id } as never, api, CTX));
    for (const key of ["createdAt", "updatedAt"]) expectLocalTwin(lesson, key);
    const recurrence = lesson.recurrence as Record<string, unknown>;
    expect(recurrence.lastSeenAt as number).toBeGreaterThan(0);
    expectLocalTwin(recurrence, "lastSeenAt");
    const notes = lesson.notes as Record<string, unknown>[];
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expectLocalTwin(note, "at");
  });

  it("lessons_stats twins counter.updatedAt", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createLessonsExtension(context);
    const record = toolOf(tools, "lessons_record");
    const stats = toolOf(tools, "lessons_stats");

    await record.execute({ statement: "a counted rule", category: "self_found" } as never, api, CTX);
    const summary = jsonOf(await stats.execute({} as never, api, CTX));
    const counter = summary.counter as Record<string, unknown>;
    expect(counter).toBeDefined();
    expect(counter.updatedAt as number).toBeGreaterThan(0);
    expectLocalTwin(counter, "updatedAt");
  });

  it("lessons_scan twins since, before, nextBefore, each candidate's at and each cut window's at", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createLessonsExtension(context);
    const scan = toolOf(tools, "lessons_scan");

    const reviewAt = Date.now() - 600_000;
    await h.runtime.harness.commit(async (tx) => {
      const root = await tx.doc(SecAgent, String(ROOT_CONVERSATION_ID), String(ROOT_CONVERSATION_ID));
      root.kind = "root";
      root.status = "waiting";
      await tx.appendEntry(ROOT_CONVERSATION_ID, {
        kind: "pi.user",
        model: [{ role: "user", content: "[pi-sec review] the zone form is right", timestamp: reviewAt }],
      });
    }, CTX);

    const result = jsonOf(
      await scan.execute({ since: reviewAt - 3_600_000, before: Date.now(), limit: 20 } as never, api, CTX),
    );
    for (const key of ["since", "before", "nextBefore"]) expectLocalTwin(result, key);
    const candidates = result.candidates as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expectLocalTwin(candidate, "at");

    // A cut is out of a small fixture's reach through the tool: no
    // per-conversation cap exists any more and the entry budget is 150000. The
    // formatter the tool uses is what puts the twin on a cut, so it is checked
    // with a cut of its own.
    const formatted = withLocalScan(
      {
        since: reviewAt - 3_600_000,
        candidates: [],
        counts: { review: 0, failed_tool: 0 },
        windowsCut: [{ conversationId: "1", at: reviewAt }],
        conversationsExamined: 0,
        conversationsUnread: 1,
        truncated: true,
      },
      ZONE,
    ) as Record<string, unknown>;
    const windowsCut = formatted.windowsCut as Record<string, unknown>[];
    expect(windowsCut).toHaveLength(1);
    expectLocalTwin(windowsCut[0]!, "at");
  });

  it("attachments_list twins collectedAt", async () => {
    const h = await boot();
    const context = runtimeContext(h);
    const api = execApi(h);
    const tools = createAttachmentsExtension(context);
    const share = toolOf(tools, "share_image");
    const list = toolOf(tools, "attachments_list");

    const shared = await share.execute(
      { source: "data:text/plain;base64,aGVsbG8=", name: "a note.txt", alt: "a note" } as never,
      api,
      CTX,
    );
    expect(shared.isError ?? false).toBe(false);
    const id = (jsonOf(shared).id as string | undefined);
    expect(id).toBeDefined();

    const listed = jsonOf(await list.execute({} as never, api, CTX));
    const attachments = listed.attachments as Record<string, unknown>[];
    const found = attachments.find((record) => record.id === id);
    expect(found).toBeDefined();
    expectLocalTwin(found!, "collectedAt");
  });
});
