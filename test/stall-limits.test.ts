import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ConversationId, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild, SecAgentHub, SecMessage, type MessageStatus } from "../src/documents.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The limits side of the stall work: a spawn refused at four fifths, a global
 * retry budget, and a round-trip notice.
 *
 * Each test drives the real tools. The children here fail their model call with
 * an error the harness will not retry, which is what keeps them alive and
 * holding their slots: an unanswered run leaves the agent `running`, and that is
 * the state the limits are about.
 */
const CTX = BACKGROUND_CONTEXT;
const MARKER = "stall-limits-brief-marker";

interface Row {
  readonly kind: string;
  readonly text: string;
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

function allText(entries: readonly Row[]): string {
  return entries.map((row) => row.text).join("\n");
}

function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

function answers(count = 20): AssistantMessage[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** A provider error the harness will not retry, so the run settles at once. */
function refused(): AssistantMessage {
  return fauxAssistantMessage("the account is out of budget", {
    stopReason: "error",
    errorMessage: "insufficient_quota: the account is out of budget",
  });
}

/** A transient provider failure, which the harness would retry. */
function outage(): AssistantMessage {
  return fauxAssistantMessage("upstream is unwell", { stopReason: "error", errorMessage: "503: upstream is unwell" });
}

function spawnCall(args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("spawn_subagent", args)], { stopReason: "toolUse" });
}

function listCall(): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("background_list", {})], { stopReason: "toolUse" });
}

function requestCall(args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("request_message", args)], { stopReason: "toolUse" });
}

function brief(name: string): Record<string, unknown> {
  return { name, vmodel: "faux", roles: [], initialPrompt: `${MARKER} ${name}` };
}

function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text?: string }).text)
        : "",
    )
    .join(" ");
}

/** The marker reaches a child as a user message and the parent only inside a tool call. */
function isChild(context: { readonly messages: readonly Message[] }): boolean {
  return context.messages.some((message) => message.role === "user" && messageText(message).includes(MARKER));
}

/** The parent keeps answering; every child gets `child`. */
function scripted(child: () => AssistantMessage, parent: () => AssistantMessage = () => fauxAssistantMessage([fauxText("ok")])): FauxResponseFactory {
  return (context) => (isChild(context) ? child() : parent());
}

async function conversationOf(harness: TestHarness) {
  return await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Submit one input and return the conversation's rows once the run settles. */
async function round(harness: TestHarness, responses: AssistantMessage[], content: string): Promise<Row[]> {
  harness.faux.setResponses(responses);
  const conversation = await conversationOf(harness);
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  const page = await conversation.entries({}, 400, undefined, CTX);
  return rows(page.items);
}

/**
 * Wait until every named child's run has settled.
 *
 * Every conversation shares one scripted response queue, so a child that has not
 * asked for its first answer yet can take the response the parent's next round
 * was meant to get. Waiting for the children's tasks to end takes that race out.
 */
async function settleChildren(harness: TestHarness, names: readonly string[]): Promise<void> {
  await until(async () => {
    for (const name of names) {
      const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, name, CTX);
      if (index === undefined || index.conversationId === "") return undefined;
      const tasks = await harness.runtime.storage.scanTasks(
        { conversationId: Number(index.conversationId) as ConversationId, order: "descending" },
        10,
        undefined,
        CTX,
      );
      if (!tasks.items.some((task) => task.state.status === "terminal")) return undefined;
    }
    return true;
  }, "the children to settle");
}

async function childIdOf(harness: TestHarness, name: string): Promise<ConversationId> {
  const index = await until(
    () => harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, name, CTX),
    `the index entry for ${name}`,
  );
  return Number(index.conversationId) as ConversationId;
}

async function seedMessage(
  harness: TestHarness,
  receiver: ConversationId,
  id: string,
  from: { conversationId: string; name: string; agentKind: "root" | "subagent" },
  to: { conversationId: string; name: string; agentKind: "root" | "subagent" },
  createdAt: number,
  status: MessageStatus = "pending",
): Promise<void> {
  await harness.runtime.harness.commit(async (tx) => {
    const draft = await tx.doc(SecMessage, receiver, id, id);
    draft.id = id;
    draft.from = { ...from };
    draft.to = { ...to };
    draft.kind = "note";
    draft.body = `seeded ${id}`;
    draft.bytes = 12;
    draft.status = status;
    draft.createdAt = createdAt;
  }, CTX);
}

describe("the limits", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("refuses a spawn at four fifths of the limit and asks for a person instead of failing it", async () => {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: { agent: { subagent: { ...base.agent.subagent, maxTotal: 5 } } },
    });
    const names = ["alpha", "beta", "gamma", "delta"];
    const start = fauxAssistantMessage(
      names.map((name) => fauxToolCall("spawn_subagent", brief(name))),
      { stopReason: "toolUse" },
    );
    const started = toolResult(await round(harness, [start, ...Array.from({ length: 20 }, () => scripted(refused))], "spawn four"));
    for (const name of names) expect(started).toContain(`started "${name}"`);
    const hub = await harness.runtime.harness.snapshot(SecAgentHub, CTX);
    expect(hub?.live).toBe(4);
    await settleChildren(harness, names);

    // Four fifths of five is four, so this one is refused: the caller is told
    // which count it hit and that a person has to agree first, and nothing is
    // created. The refusal leaves no waiting state behind.
    const held = toolResult(await round(harness, [spawnCall(brief("epsilon")), ...answers()], "one more"));
    expect(held).toContain("four fifths full");
    expect(held).toContain("was refused");
    expect(held).toContain("Ask the user");
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "epsilon", CTX)).toBeUndefined();
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(4);
  });

  it("fails the spawn as before at the limit itself", async () => {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: { agent: { subagent: { ...base.agent.subagent, maxTotal: 4 } } },
    });
    const names = ["alpha", "beta", "gamma", "delta"];
    const start = fauxAssistantMessage(
      names.map((name) => fauxToolCall("spawn_subagent", brief(name))),
      { stopReason: "toolUse" },
    );
    const started = toolResult(await round(harness, [start, ...Array.from({ length: 20 }, () => scripted(refused))], "spawn four"));
    for (const name of names) expect(started).toContain(`started "${name}"`);
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(4);
    await settleChildren(harness, names);

    const full = toolResult(await round(harness, [spawnCall(brief("epsilon")), ...answers()], "one more"));
    expect(full).toContain("the subagent limit is full");
    expect(full).not.toContain("Ask the user");
  });

  it("does not start another retry once the global budget is spent", async () => {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: { agent: { retry: { ...base.agent.retry, enabled: true, maxRetries: 3, windowMs: 600_000, maxFailures: 1 } } },
    });
    harness.faux.setResponses([outage(), fauxAssistantMessage([fauxText("ok")])]);
    const conversation = await conversationOf(harness);
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);

    // The first failure spends the budget, so the run settles instead of waiting
    // out the backoff and trying again. A retry would keep it placed past the
    // first backoff of two seconds, which is longer than this wait allows.
    const settled = await until(async () => {
      const record = await submission.status(CTX);
      return record.status === "unanswered" ? record : undefined;
    }, "the run to settle unanswered", 1_500);
    expect(settled.reason).toBe("model_error");
    expect(harness.faux.state.callCount).toBe(1);
    // The second scripted response is still waiting: nothing asked for it.
    expect(harness.faux.getPendingResponseCount()).toBeGreaterThan(0);
  });

  it("leaves the run unanswered and tells the parent when the budget is spent", async () => {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: { agent: { retry: { ...base.agent.retry, enabled: true, maxRetries: 3, windowMs: 600_000, maxFailures: 1 } } },
    });
    await round(
      harness,
      [spawnCall(brief("researcher")), ...Array.from({ length: 20 }, () => scripted(outage))],
      "spawn a child that cannot reach the model",
    );
    const childId = await childIdOf(harness, "researcher");

    const told = await until(async () => {
      const conversation = await conversationOf(harness);
      const page = await conversation.entries({}, 400, undefined, CTX);
      const text = allText(rows(page.items));
      return text.includes("retry budget is spent") ? text : undefined;
    }, "the parent to be told the budget is spent");
    expect(told).toContain("researcher");
    expect(told).toContain("no further retry is started");

    // The run was not killed and nothing was cleaned up: it is left unanswered,
    // which is what the audits and the parent's list then read.
    const unanswered = await until(async () => {
      const page = await harness!.runtime.storage.scanSubmissions(
        { conversationId: childId, status: "unanswered" },
        10,
        undefined,
        CTX,
      );
      return page.items[0];
    }, "the child's unanswered submission");
    expect(unanswered.reason).toBe("model_error");
  });

  it("announces a round trip between the same two conversations once past the threshold", async () => {
    harness = await createTestHarness();
    await round(
      harness,
      [spawnCall(brief("researcher")), ...Array.from({ length: 20 }, () => scripted(refused))],
      "spawn a child",
    );
    const childId = await childIdOf(harness, "researcher");

    // Twenty messages, alternating who sent them: nineteen direction changes,
    // which is past the threshold of fifteen in ten minutes.
    const now = Date.now();
    for (let index = 0; index < 20; index += 1) {
      const at = now - (20 - index) * 1_000;
      const rootPeer = { conversationId: "1", name: "operator", agentKind: "root" as const };
      const childPeer = { conversationId: String(childId), name: "researcher", agentKind: "subagent" as const };
      const outbound = index % 2 === 0;
      await seedMessage(
        harness,
        outbound ? childId : (1 as ConversationId),
        `seed-${index}`,
        outbound ? rootPeer : childPeer,
        outbound ? childPeer : rootPeer,
        at,
      );
    }

    const first = toolResult(
      await round(harness, [requestCall({ to: "researcher", body: "status?", timeoutMs: 60 }), ...answers(5)], "ask"),
    );
    expect(first).toContain("direction changes");
    expect(first).toContain("Nothing was cut, resent, or deferred");

    // The threshold belongs to the pair, not to one direction: the child asking
    // the root is the same burst seen from the other end, so it carries no
    // notice of its own.
    expect(await harness.runtime.subagents?.roundTripNotice(childId, "1", CTX)).toBe("");

    const second = allText(
      await round(harness, [requestCall({ to: "researcher", body: "status?", timeoutMs: 60 }), ...answers(5)], "ask again"),
    );
    // Said once: the second request over the same threshold carries no notice.
    expect(second.split("direction changes").length - 1).toBe(1);
  });

  it("names a reply that has been claimed for longer than twice the blocking deadline", async () => {
    harness = await createTestHarness();
    await round(
      harness,
      [spawnCall(brief("researcher")), ...Array.from({ length: 20 }, () => scripted(refused))],
      "spawn a child",
    );
    const childId = await childIdOf(harness, "researcher");

    // One reply, claimed twenty-five minutes ago. The threshold is twice the
    // blocking deadline, so this is past it, and nothing else about the pair's
    // traffic is unusual.
    const claimedAt = Date.now() - 25 * 60_000;
    await seedMessage(
      harness,
      1 as ConversationId,
      "claimed-0",
      { conversationId: String(childId), name: "researcher", agentKind: "subagent" },
      { conversationId: "1", name: "operator", agentKind: "root" },
      claimedAt,
      "claimed",
    );
    await harness.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecMessage, 1 as ConversationId, "claimed-0", "claimed-0");
      draft.claimedAt = claimedAt;
    }, CTX);

    const result = toolResult(
      await round(harness, [requestCall({ to: "researcher", body: "status?", timeoutMs: 60 }), ...answers(5)], "ask"),
    );
    expect(result).toContain("claimed for longer than 20 minutes");
  });

  it("does not create the next occurrence while the previous one has a non-terminal task", async () => {
    // "nightly" already ran and its round has not settled; "hourly" has never run.
    harness = await createTestHarness({
      config: {
        scheduler: {
          enabled: true,
          tickMs: 30_000,
          timezone: "UTC",
          jobs: [
            { name: "nightly", schedule: "* * * * *", prompt: "look", vmodel: "faux" },
            { name: "hourly", schedule: "* * * * *", prompt: "look", vmodel: "faux" },
          ],
        },
      } as Partial<Config>,
    });
    const round = await seedConversation(harness, { kind: "scheduled", name: "nightly", task: "running" });
    await harness.runtime.jobs.create(CTX, {
      title: "nightly",
      origin: "scheduler",
      labels: ["schedule:nightly"],
      conversationId: round,
    });

    await harness.runtime.scheduler.tick(Date.now());

    // Only "hourly" started a round. "nightly" is waiting, and waiting is not
    // skipping: its last run was not recorded, so the occurrence is still pending.
    // The root conversation exists from boot and is not a round, so it is left out.
    const conversations = await harness.runtime.storage.scanConversations({}, 50, undefined, CTX);
    expect(conversations.items.filter((item) => item.id !== ROOT_CONVERSATION_ID).length).toBe(2);
    const jobs = await harness.runtime.jobs.list(CTX);
    expect(jobs.find((job) => job.title === "nightly")?.lastRun).toBeUndefined();
    const hourly = jobs.find((job) => job.title === "hourly");
    expect(hourly?.conversationId).toBeDefined();
    expect(hourly?.conversationId).not.toBe(round);
  });

  it("treats a scheduled conversation as a reconcile target", async () => {
    harness = await createTestHarness();
    // A round that finished: the record still says `running` and nothing is live.
    const round = await seedConversation(harness, { kind: "scheduled", name: "nightly" });

    await harness.runtime.subagents!.reconcile(CTX);

    // It is judged rather than skipped, and judging it gives no slot back: a
    // scheduled round never took one.
    const rows = (await readAuditTail(harness.paths.auditLog, undefined, 200)).filter(
      (event) => event.type === "subagent_status" && event.conversationId === round,
    );
    expect(rows.map((row) => row.status)).toEqual(["stopped"]);
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live ?? 0).toBe(0);
    expect(await harness.runtime.harness.snapshot(SecAgent, round, CTX)).toBeUndefined();
  });
});

/**
 * One conversation with an agent record, and optionally a task, written straight
 * into storage. A scheduled round is shaped here because no run through the
 * harness leaves one behind in the state these rules are about.
 */
async function seedConversation(
  harness: TestHarness,
  seed: { readonly kind: "scheduled"; readonly name: string; readonly task?: "running" },
): Promise<string> {
  const storage = harness.runtime.storage;
  const at = Date.now();
  let id = "";
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    const record = await tx.doc(SecAgent, id, id);
    record.kind = seed.kind;
    record.name = seed.name;
    record.status = "running";
    record.createdAt = at;
    record.updatedAt = at;
  }, CTX);
  if (seed.task === "running") {
    const taskId = await storage.mintId<TaskId>();
    await commitWrites(storage, [
        {
          type: "task",
          value: {
            id: taskId,
            conversationId: Number(id) as ConversationId,
            kind: "pi.generation",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            startedAt: at,
            state: { status: "running", checkpoint: { phase: "execute" } },
          },
        } as unknown as StorageWrite,
      ],
      CTX,
    );
  }
  return id;
}
