import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config/schema.ts";
import { defaultConfig } from "../src/config/schema.ts";
import type { ConversationId, StorageWrite, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, type AgentRecord, type AgentStatus } from "../src/documents.ts";
import { judge, type ConversationFacts } from "../src/extensions/diagnostics.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `diagnose_conversation` reads what a finished or stopped conversation left
 * behind. The fixtures below are written straight into storage, because the one
 * thing the tool has to survive is a conversation whose last task is terminal
 * and whose agent record still says `running` — a shape a real run only produces
 * when a provider gives up, which no test can arrange through the harness.
 */

interface Row {
  readonly kind: string;
  readonly text: string;
}

interface TaskSeed {
  readonly status: "pending" | "running" | "waiting" | "terminal";
  readonly outcome?: "completed" | "failed" | "aborted" | "faulted" | "orphaned";
}

interface ConversationSeed {
  /** Timestamp of the conversation's only model entry. */
  readonly at?: number;
  /** Agent status; `none` leaves no `sec.agent` record at all. */
  readonly agent?: AgentStatus | "none";
  readonly tasks?: readonly TaskSeed[];
  readonly submission?: { readonly status: "unanswered" | "done"; readonly reason?: string };
}

function rows(entries: readonly { kind: string; model?: unknown[] }[]): Row[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    text: (entry.model ?? [])
      .map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((part) =>
            part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
              ? String((part as { text?: string }).text ?? "")
              : "",
          )
          .join("");
      })
      .join("\n"),
  }));
}

function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

/** A harness whose enabled list carries the diagnostics extension. */
async function withDiagnostics(): Promise<TestHarness> {
  const base = defaultConfig();
  return await createTestHarness({
    config: {
      agent: {
        ...base.agent,
        // The test helper only defaults the model when the caller leaves it out,
        // so the faux alias has to be named here.
        vmodel: "faux",
        extensions: { enabled: [...base.agent.extensions.enabled, "diagnostics"] },
      },
    } as Partial<Config>,
  });
}

/** Write one conversation's record straight into storage, without running it. */
async function seed(harness: TestHarness, seed: ConversationSeed): Promise<string> {
  const storage = harness.runtime.storage;
  const at = seed.at ?? Date.now();
  let id = "";
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    if (seed.at !== undefined) {
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "go", timestamp: at }],
      });
    }
    if (seed.agent !== undefined && seed.agent !== "none") {
      const record = await tx.doc(SecAgent, id, id);
      record.status = seed.agent;
      record.updatedAt = at;
    }
  }, BACKGROUND_CONTEXT);

  const conversationId = Number(id) as unknown as ConversationId;
  for (const task of seed.tasks ?? []) {
    const taskId = await storage.mintId<TaskId>();
    const state =
      task.status === "terminal"
        ? {
            status: "terminal",
            outcome:
              (task.outcome ?? "failed") === "completed"
                ? { status: "completed", result: {} }
                : { status: task.outcome ?? "failed", error: { message: "503 service_unavailable_error" } },
          }
        : { status: task.status, checkpoint: { phase: "execute" } };
    const write = {
      type: "task",
      value: {
        id: taskId,
        conversationId,
        kind: "pi.generation",
        version: 1,
        input: {},
        background: false,
        abortRequested: false,
        startedAt: at,
        ...(task.status === "terminal" ? { endedAt: at } : {}),
        state,
      },
    } as unknown as StorageWrite;
    await commitWrites(storage, [write], BACKGROUND_CONTEXT);
  }

  if (seed.submission !== undefined) {
    const submissionId = await storage.mintId<SubmissionId>();
    const value =
      seed.submission.status === "unanswered"
        ? {
            id: submissionId,
            conversationId,
            type: "input",
            status: "unanswered",
            reason: seed.submission.reason ?? "model_error",
          }
        : { id: submissionId, conversationId, type: "input", status: "done", entry: 1, answer: 1 };
    await commitWrites(storage, [{ type: "submission", value } as unknown as StorageWrite], BACKGROUND_CONTEXT);
  }

  return id;
}

/** Retire a conversation's `sec.agent` record, as deleting its agent does. */
async function retireAgent(harness: TestHarness, id: string): Promise<void> {
  await harness.runtime.harness.commit(async (tx) => {
    await tx.retireDoc(SecAgent, id);
  }, BACKGROUND_CONTEXT);
}

/** The status of a conversation's `sec.agent` record, read at the current revision. */
async function agentStatus(harness: TestHarness, id: string): Promise<string> {
  const record = await harness.runtime.harness.snapshot(SecAgent, id, BACKGROUND_CONTEXT);
  return record === undefined ? "none" : record.status;
}

/** Run one `diagnose_conversation` call in the root conversation, and read its answer. */
async function diagnose(harness: TestHarness, args: Record<string, unknown>): Promise<string> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("diagnose_conversation", args)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "diagnose" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return toolResult(rows(page.items));
}

/** How many records of each kind one conversation holds. */
async function tally(harness: TestHarness, id: string): Promise<string> {
  const storage = harness.runtime.storage;
  const conversationId = Number(id) as unknown as ConversationId;
  const entries = await storage.scanEntries({ conversationId, order: "descending" }, 500, undefined, BACKGROUND_CONTEXT);
  const tasks = await storage.scanTasks({ conversationId, order: "descending" }, 500, undefined, BACKGROUND_CONTEXT);
  const submissions = await storage.scanSubmissions(
    { conversationId, order: "descending" },
    500,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const documents = await storage.scanDocuments(
    { scope: { kind: "conversation", conversationId }, at: "current" },
    500,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const agent = await harness.runtime.harness.snapshot(SecAgent, id, BACKGROUND_CONTEXT);
  return JSON.stringify({
    entries: entries.items.length,
    tasks: tasks.items.length,
    submissions: submissions.items.length,
    documents: documents.items.length,
    agent: agent === undefined ? "none" : `${agent.status}@${agent.updatedAt}`,
  });
}

describe("diagnose_conversation", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("prints stalled=yes with silentMs for a conversation with no live work and a failed last task", async () => {
    harness = await withDiagnostics();
    const at = Date.now() - 5_900_000;
    const child = await seed(harness, {
      at,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
      submission: { status: "unanswered", reason: "model_error" },
    });

    const text = await diagnose(harness, { conversationId: child });

    expect(text).toContain(`conversation="${child}"`);
    expect(text).toContain('stalled="yes"');
    expect(text).toContain('rule="silent-past-stale"');
    expect(text).toContain('agent="running"');
    expect(text).toContain('lastOutcome="failed"');
    expect(text).toContain('lastSubmissionReason="model_error"');
    expect(text).toContain('liveTasks="0"');
    expect(text).toMatch(/silentMs="59\d{5}"/);
  });

  it("prints no-agent-record when the agent record was retired", async () => {
    harness = await withDiagnostics();
    // Every other fact below is the shape of a stall. The record is written and
    // then retired, which is what a force-deleted agent leaves behind, and a read
    // at the current revision does not see a retired incarnation.
    const child = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
      submission: { status: "unanswered", reason: "model_error" },
    });
    expect(await agentStatus(harness, child)).toBe("running");

    await retireAgent(harness, child);
    expect(await agentStatus(harness, child)).toBe("none");

    const text = await diagnose(harness, { conversationId: child });

    expect(text).toContain('rule="no-agent-record"');
    expect(text).toContain('stalled="unknown"');
    expect(text).not.toContain('stalled="yes"');
    expect(text).toContain('agent="-"');
    expect(text).toContain('lastOutcome="failed"');
    expect(text).toContain('lastSubmissionReason="model_error"');
    expect(text).toContain('liveTasks="0"');
    expect(text).toMatch(/silentMs="59\d{5}"/);
  });

  it("reproduces the outage silence values exactly when the clock is pinned", () => {
    // Two conversations of a provider outage: the last progress each left, and
    // the instant the parent force-deleted them.
    const running = { status: "running" } as unknown as AgentRecord;
    const failed = {
      state: { status: "terminal", outcome: { status: "failed" } },
    } as unknown as ConversationFacts["lastTask"];
    const facts = (over: Partial<ConversationFacts>): ConversationFacts => ({
      conversationId: "101",
      agent: running,
      lastEntryAt: undefined,
      lastTask: failed,
      lastSubmission: undefined,
      liveTasks: 0,
      lastTool: undefined,
      truncated: false,
      ...over,
    });

    // 01:37:17.584Z to 03:15:22.642Z, the 5885.1 seconds of the outage table.
    expect(judge(facts({ lastEntryAt: 1892028237584 }), 1_800_000, 1892034122642)).toEqual({
      conversationId: "101",
      stalled: "yes",
      rule: "silent-past-stale",
      silentMs: 5_885_058,
    });
    // 01:39:03.122Z to 03:15:22.643Z, the 5779.5 seconds of the same table.
    expect(judge(facts({ conversationId: "102", lastEntryAt: 1892028343122 }), 1_800_000, 1892034122643)).toEqual({
      conversationId: "102",
      stalled: "yes",
      rule: "silent-past-stale",
      silentMs: 5_779_521,
    });
    // The same facts with the record retired: the silence is still measured, but
    // the verdict falls back to the rule that says why it cannot be yes.
    expect(judge(facts({ lastEntryAt: 1892028237584, agent: undefined }), 1_800_000, 1892034122642)).toEqual({
      conversationId: "101",
      stalled: "unknown",
      rule: "no-agent-record",
      silentMs: 5_885_058,
    });
  });

  it("prints stalled=no when the agent is waiting", async () => {
    harness = await withDiagnostics();
    const child = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "waiting",
      tasks: [{ status: "terminal", outcome: "failed" }],
    });

    const text = await diagnose(harness, { conversationId: child });

    expect(text).toContain('stalled="no"');
    expect(text).toContain('rule="agent-waiting"');
    expect(text).not.toContain('stalled="yes"');
  });

  it("prints stalled=no when a non-terminal task exists", async () => {
    harness = await withDiagnostics();
    const child = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }, { status: "running" }],
    });

    const text = await diagnose(harness, { conversationId: child });

    expect(text).toContain('stalled="no"');
    expect(text).toContain('rule="live-tasks"');
    expect(text).toContain('liveTasks="1"');
    expect(text).not.toContain('stalled="yes"');
  });

  it("prints stalled=unknown otherwise", async () => {
    harness = await withDiagnostics();
    const finished = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "completed" }],
    });
    const silent = await seed(harness, {
      at: Date.now() - 1_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
    });
    const orphan = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "none",
      tasks: [{ status: "terminal", outcome: "failed" }],
    });

    expect(await diagnose(harness, { conversationId: finished })).toContain('rule="last-task-completed"');
    expect(await diagnose(harness, { conversationId: silent })).toContain('rule="silent-not-past-stale"');
    expect(await diagnose(harness, { conversationId: orphan })).toContain('rule="no-agent-record"');

    const text = await diagnose(harness, { conversationId: finished });
    expect(text).toContain('stalled="unknown"');
    expect(text).not.toContain('stalled="yes"');
  });

  it("writes nothing: no document and no entry is created", async () => {
    harness = await withDiagnostics();
    const child = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
      submission: { status: "unanswered", reason: "model_error" },
    });

    const before = await tally(harness, child);
    const text = await diagnose(harness, { conversationId: child });
    const after = await tally(harness, child);

    expect(text).toContain('stalled="yes"');
    expect(after).toBe(before);
  });

  it("walks the most recently active conversations when no id is given", async () => {
    harness = await withDiagnostics();
    const older = await seed(harness, {
      at: Date.now() - 5_900_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
    });
    const newer = await seed(harness, {
      at: Date.now() - 60_000,
      agent: "running",
      tasks: [{ status: "terminal", outcome: "failed" }],
    });

    const text = await diagnose(harness, { limit: 5 });

    // Both are reported, and the newest progress leads the list.
    expect(text).toContain(`conversation="${newer}"`);
    expect(text).toContain(`conversation="${older}"`);
    expect(text.indexOf(`conversation="${newer}"`)).toBeLessThan(text.indexOf(`conversation="${older}"`));
    expect(text).toContain('rule="silent-past-stale"');
    expect(text).toContain('rule="silent-not-past-stale"');
  });
});
