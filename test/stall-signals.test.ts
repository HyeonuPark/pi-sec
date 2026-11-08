import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, StorageWrite, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecAgentChild, type AgentStatus } from "../src/documents.ts";
import { zoneIso } from "../src/time-format.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The display side of the stall work: `background_list` has to say when a child
 * last moved, not only what its status is.
 *
 * The values are read from the store at the moment of the read, so the tests here
 * compare them with what the store holds rather than with a stored field.
 */
const CTX = BACKGROUND_CONTEXT;

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

function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

/**
 * The newest subagent row of the conversation, or `undefined`.
 *
 * Entries are read newest first, so the first tool result that carries a
 * subagent row is the newest `background_list` output.
 */
function subagentLine(text: string): string | undefined {
  for (const line of text.split("\n")) if (line.includes('kind="subagent"')) return line;
  return undefined;
}

function answers(count = 30): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

function spawnCall(args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("spawn_subagent", args)], { stopReason: "toolUse" });
}

function parkCall(): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("await_orders", { note: "waiting for orders" })], {
    stopReason: "toolUse",
  });
}

function listCall(): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("background_list", {})], { stopReason: "toolUse" });
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

/**
 * A script where the child parks and everything else answers.
 *
 * The brief marker is what tells the two apart. It arrives at the child as a user
 * message and reaches the parent only inside the assistant's own tool-call
 * arguments, so "a user message carrying it" is the child and nothing else.
 */
function parkChildren(marker: string): FauxResponseFactory {
  return (context) =>
    context.messages.some((message) => message.role === "user" && messageText(message).includes(marker))
      ? parkCall()
      : fauxAssistantMessage([fauxText("ok")]);
}

async function submit(harness: TestHarness, content: string): Promise<Row[]> {
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    CTX,
  );
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  const page = await conversation.entries({}, 300, undefined, CTX);
  return rows(page.items);
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

/** Spawn one child and wait until it has parked, so the row stays on the list. */
async function spawnParked(harness: TestHarness, name: string): Promise<ConversationId> {
  const marker = `orders marker ${name}`;
  harness.faux.setResponses([
    spawnCall({ name, vmodel: "faux", roles: [], initialPrompt: marker }),
    ...Array.from({ length: 40 }, () => parkChildren(marker)),
  ]);
  const listed = await submit(harness, "spawn one child");
  expect(toolResult(listed)).toContain(`started "${name}"`);

  const index = await until(
    () => harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, name, CTX),
    "the child index entry",
  );
  const childId = Number(index.conversationId) as ConversationId;
  await until(async () => {
    const record = await harness.runtime.harness.snapshot(SecAgent, String(childId), CTX);
    return record?.status === "waiting" ? true : undefined;
  }, "the child to park");
  return childId;
}

/** One `background_list` round; the newest subagent row it printed. */
async function listRow(harness: TestHarness): Promise<string> {
  harness.faux.setResponses([listCall(), ...answers()]);
  const listed = await submit(harness, "list the background work");
  const line = subagentLine(toolResult(listed));
  expect(line).toBeDefined();
  return line!;
}

function entryTime(entry: { readonly model?: readonly { readonly timestamp?: number }[] }): number | undefined {
  const stamps = (entry.model ?? [])
    .map((message) => message.timestamp)
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at > 0);
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

describe("progress on a child row", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("shows updatedAt, progressAt and lastOutcome on a child row", async () => {
    harness = await createTestHarness();
    const childId = await spawnParked(harness, "researcher");

    const line = await listRow(harness);
    expect(line).toContain('name="researcher"');
    expect(line).toContain(`conversation="${childId}"`);
    expect(line).toMatch(/ updated="\d{4}-\d{2}-\d{2}T/);
    expect(line).toMatch(/ progress="\d{4}-\d{2}-\d{2}T/);
    expect(line).toContain('outcome="completed"');
    // The status alone is what the row always had; the times are new, and they
    // are what separates a child that is working from one that stopped.
    const record = await harness.runtime.harness.snapshot(SecAgent, String(childId), CTX);
    // The harness zone, with its offset, not UTC: that is the form a row carries.
    expect(line).toContain(`updated="${zoneIso(record!.updatedAt, harness.config.timezone)}"`);
  });

  it("progressAt is the newest of the last entry time and the last task end", async () => {
    harness = await createTestHarness();
    const childId = await spawnParked(harness, "researcher");
    const storage = harness.runtime.storage;

    const tasks = await storage.scanTasks({ conversationId: childId, order: "descending" }, 20, undefined, CTX);
    const ends = tasks.items.map((task) => task.endedAt).filter((at): at is number => at !== undefined);
    expect(ends.length).toBeGreaterThan(0);
    const lastTaskEnd = Math.max(...ends);

    // An entry older than the last task end must not move the row: the newest of
    // the two is the task end. An implementation that read only the newest entry
    // would report this one instead, because it is the newest entry by id.
    const older = Date.now() - 3_600_000;
    const appendEntry = async (timestamp: number): Promise<void> => {
      await harness!.runtime.harness.commit(async (tx) => {
        await tx.appendEntry(childId, {
          kind: "pi.user",
          model: [{ role: "user", content: "a seeded entry", timestamp }],
        });
      }, CTX);
    };
    await appendEntry(older);
    expect(await listRow(harness)).toContain(`progress="${zoneIso(lastTaskEnd, harness.config.timezone)}"`);

    // An entry newer than every task end is the other half of the rule: progress
    // follows the newest of the two, so the row moves even though no task ran.
    const future = Date.now() + 600_000;
    await appendEntry(future);
    expect(await listRow(harness)).toContain(`progress="${zoneIso(future, harness.config.timezone)}"`);
  });
});

interface ChildSeed {
  /** When the child was last alive. Everything it owns is dated from here. */
  readonly at: number;
  readonly status?: AgentStatus;
  /** The newest task: how it ended, or that it has not settled. */
  readonly task?: "failed" | "completed" | "running";
  /** An entry written after the task ended, dated `at + 10s`. */
  readonly movedAfter?: boolean;
}

/**
 * One child's remains, written straight into storage.
 *
 * The shape under test — a record that still says `running` while its last task
 * has already ended — is what a provider outage leaves behind, and no run through
 * the harness can be made to leave it for long enough to be judged.
 */
async function seedChild(harness: TestHarness, name: string, seed: ChildSeed): Promise<string> {
  const storage = harness.runtime.storage;
  let id = "";
  let inputEntry = 0;
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    const entry = await tx.appendEntry(conversation.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "go", timestamp: seed.at }],
    });
    inputEntry = entry.id;
    if (seed.movedAfter === true) {
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "a later order", timestamp: seed.at + 10_000 }],
      });
    }
    const record = await tx.doc(SecAgent, id, id);
    record.kind = "subagent";
    record.name = name;
    record.parentConversationId = "1";
    record.status = seed.status ?? "running";
    record.createdAt = seed.at;
    record.updatedAt = seed.at;
  }, CTX);

  const conversationId = Number(id) as ConversationId;
  const taskId = await storage.mintId<TaskId>();
  const how = seed.task ?? "failed";
  const state =
    how === "running"
      ? { status: "running", checkpoint: { phase: "execute" } }
      : how === "completed"
        ? { status: "terminal", outcome: { status: "completed", result: {} } }
        : { status: "terminal", outcome: { status: "failed", error: { message: "503: gone" } } };
  await commitWrites(storage, [
      {
        type: "task",
        value: {
          id: taskId,
          conversationId,
          kind: "pi.generation",
          version: 1,
          input: {},
          background: false,
          abortRequested: false,
          startedAt: seed.at,
          ...(how === "running" ? {} : { endedAt: seed.at }),
          state,
        },
      } as unknown as StorageWrite,
    ],
    CTX,
  );

  const submissionId = await storage.mintId<SubmissionId>();
  await commitWrites(storage, [
      {
        type: "submission",
        value: {
          id: submissionId,
          conversationId,
          type: "input",
          status: "unanswered",
          reason: "model_error",
          entry: inputEntry,
          detail: "503: gone",
        },
      } as unknown as StorageWrite,
    ],
    CTX,
  );
  return id;
}

/** The notes one parent has been sent, in the order they were written. */
async function notesTo(harness: TestHarness, conversationId: ConversationId): Promise<string[]> {
  const messages = (await harness.runtime.subagents!.inbox(conversationId, CTX)).filter(
    (message) => message.kind === "note",
  );
  return messages.map((message) => message.body);
}

describe("a child that stopped without saying so", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("announces a child once when its last task is terminal, failed, and no new entry followed", async () => {
    harness = await createTestHarness();
    // The parent has to exist for the note to have a receiver.
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "silent", { at: Date.now() - 40 * 60_000 });
    const subagents = harness.runtime.subagents!;

    const first = await subagents.sweep(CTX);
    expect(first.stalled).toBe(1);
    expect(first.failed).toBe(0);
    const written = await notesTo(harness, 1 as ConversationId);
    expect(written.length).toBe(1);
    expect(written[0]).toContain('"silent"');
    expect(written[0]).toContain("its last task ended failed");
    expect(written[0]).toContain("Nothing was stopped, restarted, or deleted");

    // The child is still stalled on the next pass, and the parent already knows.
    await subagents.sweep(CTX);
    expect((await notesTo(harness, 1 as ConversationId)).length).toBe(1);
  });

  it("does not announce a child that still has a non-terminal task", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "busy", { at: Date.now() - 40 * 60_000, task: "running" });

    const result = await harness.runtime.subagents!.sweep(CTX);
    expect(result.stalled).toBe(0);
    expect(await notesTo(harness, 1 as ConversationId)).toEqual([]);
  });

  it("does not announce a child that is waiting order", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "parked", { at: Date.now() - 40 * 60_000, status: "waiting" });

    const result = await harness.runtime.subagents!.sweep(CTX);
    expect(result.stalled).toBe(0);
    expect((await notesTo(harness, 1 as ConversationId)).filter((body) => body.includes("has not moved"))).toEqual([]);
  });

  it("does not announce a child that moved after its last task ended", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "woken", { at: Date.now() - 40 * 60_000, movedAfter: true });

    const result = await harness.runtime.subagents!.sweep(CTX);
    expect(result.stalled).toBe(0);
    expect(await notesTo(harness, 1 as ConversationId)).toEqual([]);
  });

  it("says nothing while a restart request is up, and names the stall once it is withdrawn", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "silent", { at: Date.now() - 40 * 60_000 });
    const subagents = harness.runtime.subagents!;

    // The gate passed, so the operator may restart now: the note would wake a
    // parent parked at the safe point the restart needs.
    harness.runtime.restart.requireRestart();
    harness.runtime.restart.markReady();
    const held = await subagents.sweep(CTX);
    // Held is not hidden: the child is still counted as stalled.
    expect(held.stalled).toBe(1);
    expect(await notesTo(harness, 1 as ConversationId)).toEqual([]);

    // The request was withdrawn: the stall is still owed a note, and it goes now.
    harness.runtime.restart.withdraw();
    expect((await subagents.sweep(CTX)).stalled).toBe(1);
    const written = await notesTo(harness, 1 as ConversationId);
    expect(written.length).toBe(1);
    expect(written[0]).toContain('"silent"');
    expect(written[0]).toContain("has not moved");

    // One note per episode, as before the hold.
    await subagents.sweep(CTX);
    expect((await notesTo(harness, 1 as ConversationId)).length).toBe(1);
  });

  it("still names the stall when a restart is required but not requested", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seedChild(harness, "silent", { at: Date.now() - 40 * 60_000 });

    // A batch of work is open: the restart is needed, but no request is up, so the
    // note costs no safe point and goes as before.
    harness.runtime.restart.requireRestart();
    expect(harness.runtime.restart.status).toMatchObject({ required: true, ready: false });
    expect((await harness.runtime.subagents!.sweep(CTX)).stalled).toBe(1);
    const written = await notesTo(harness, 1 as ConversationId);
    expect(written.length).toBe(1);
    expect(written[0]).toContain("has not moved");
  });
});
