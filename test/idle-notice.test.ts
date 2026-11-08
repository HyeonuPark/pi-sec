import { utimes } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { contextPath, ensureContextFile } from "../src/agent/context-file.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild, type AgentStatus } from "../src/documents.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The idle notice: a child that has waited for orders past
 * `agent.subagent.idleNoticeMs` earns its parent one note per wait.
 *
 * The children here are written straight into the store, so the moment a wait
 * began is a value the test sets rather than one it has to sleep for. The parent
 * is the root conversation, which has id 1.
 */
const CTX = BACKGROUND_CONTEXT;
const PARENT = 1 as ConversationId;
const MINUTE = 60_000;

function answers(count = 30): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** Write one child record whose status last changed at `updatedAt`. */
async function seedChild(
  harness: TestHarness,
  name: string,
  status: AgentStatus,
  updatedAt: number,
): Promise<ConversationId> {
  let id = "";
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    const record = await tx.doc(SecAgent, id, id);
    record.kind = "subagent";
    record.name = name;
    record.parentConversationId = String(PARENT);
    record.status = status;
    record.createdAt = updatedAt;
    record.updatedAt = updatedAt;
  }, CTX);
  return Number(id) as ConversationId;
}

/** Move a seeded child to a new status, dated `updatedAt`. */
async function restate(harness: TestHarness, id: ConversationId, status: AgentStatus, updatedAt: number): Promise<void> {
  await harness.runtime.harness.commit(async (tx) => {
    const record = await tx.doc(SecAgent, String(id), String(id));
    record.status = status;
    record.updatedAt = updatedAt;
  }, CTX);
}

async function idleNotes(harness: TestHarness): Promise<string[]> {
  const messages = await harness.runtime.subagents!.inbox(PARENT, CTX);
  return messages
    .filter((message) => message.kind === "note" && message.body.includes("has waited for orders"))
    .map((message) => message.body);
}

/** The notice the parent is owed, with the child's own state file named in it. */
function expectedNotice(name: string, path: string, wait: string, last: string): string {
  return (
    `"${name}" has waited for orders for ${wait}. ` +
    "If it waits for your decision, send it one. If you have work for it, send it an order. " +
    `If you have none, read its state file ${path} and delete it with subagent_delete. ` +
    last
  );
}

/** The child's state file path, the one the spawn briefing names. */
function stateFile(harness: TestHarness, id: ConversationId): string {
  return contextPath(harness.runtime.paths, String(id));
}

async function withParent(idleNoticeMs?: number): Promise<TestHarness> {
  const base = defaultConfig();
  const harness = await createTestHarness(
    idleNoticeMs === undefined
      ? {}
      : { config: { agent: { ...base.agent, subagent: { ...base.agent.subagent, idleNoticeMs } } } },
  );
  // The note opens a run in the parent; it gets plain answers.
  harness.faux.setResponses(answers());
  // The parent has to exist for the note to have a receiver.
  await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
  return harness;
}

describe("a child that waits for orders", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("defaults the limit to five minutes", () => {
    expect(defaultConfig().agent.subagent.idleNoticeMs).toBe(300_000);
  });

  it("tells the parent once when the wait passes the limit", async () => {
    harness = await withParent();
    const id = await seedChild(harness, "parked", "waiting", Date.now() - 6 * MINUTE);
    const subagents = harness.runtime.subagents!;

    await subagents.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([
      expectedNotice("parked", stateFile(harness, id), "5 minutes", "That file does not exist."),
    ]);

    // The same wait on the next pass: the parent already knows.
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);

    // The notice changes nothing about the child.
    const record = await harness.runtime.harness.snapshot(SecAgent, String(id), CTX);
    expect(record?.status).toBe("waiting");
  });

  it("says nothing before the limit", async () => {
    harness = await withParent();
    await seedChild(harness, "fresh", "waiting", Date.now() - 4 * MINUTE);

    await harness.runtime.subagents!.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([]);
  });

  it("counts afresh when the child works and waits again", async () => {
    harness = await withParent();
    const id = await seedChild(harness, "again", "waiting", Date.now() - 10 * MINUTE);
    const subagents = harness.runtime.subagents!;

    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);

    // An order woke it, and it parked again: a new wait, not yet past the limit.
    await restate(harness, id, "running", Date.now() - 2 * MINUTE);
    await subagents.sweep(CTX);
    await restate(harness, id, "waiting", Date.now() - MINUTE);
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);

    // The new wait passes the limit and earns its own note.
    await restate(harness, id, "waiting", Date.now() - 7 * MINUTE);
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(2);
  });

  it("counts afresh through the hub's own status changes", async () => {
    // A limit of one minute: no pause the machine can cause reaches it.
    harness = await withParent(MINUTE);
    const id = await seedChild(harness, "woken", "waiting", Date.now() - 2 * MINUTE);
    const subagents = harness.runtime.subagents!;

    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);
    expect((await idleNotes(harness))[0]).toContain('"woken" has waited for orders for 1 minute.');

    await subagents.setStatus(CTX, id, "running", {});
    await subagents.setStatus(CTX, id, "waiting", {});
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);

    // Only the clock moves past the limit, and only for this one sweep.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow + MINUTE + 1000);
    try {
      await subagents.sweep(CTX);
    } finally {
      clock.mockRestore();
    }
    expect((await idleNotes(harness)).length).toBe(2);
  });

  it("says nothing about a working child", async () => {
    harness = await withParent();
    await seedChild(harness, "busy", "running", Date.now() - 20 * MINUTE);

    await harness.runtime.subagents!.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([]);
  });

  it("says how long before parking the state file was last written", async () => {
    harness = await withParent();
    const parkedAt = Date.now() - 6 * MINUTE;
    const id = await seedChild(harness, "dated", "waiting", parkedAt);
    const path = await ensureContextFile(harness.runtime.paths, String(id));
    // Written three minutes before it parked: the wait began at `parkedAt`.
    const writtenAt = (parkedAt - 3 * MINUTE) / 1000;
    await utimes(path, writtenAt, writtenAt);

    await harness.runtime.subagents!.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([
      expectedNotice("dated", path, "5 minutes", "That file was last written 3 minutes before it parked."),
    ]);
  });

  it("says so when the state file was written after the child parked", async () => {
    harness = await withParent();
    const parkedAt = Date.now() - 6 * MINUTE;
    const id = await seedChild(harness, "refreshed", "waiting", parkedAt);
    const path = await ensureContextFile(harness.runtime.paths, String(id));
    // Two minutes after it parked, so the file is newer than the wait's start.
    const writtenAt = (parkedAt + 2 * MINUTE) / 1000;
    await utimes(path, writtenAt, writtenAt);

    await harness.runtime.subagents!.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([
      expectedNotice("refreshed", path, "5 minutes", "That file was last written after it parked."),
    ]);
  });

  it("says the state file does not exist when the child never wrote one", async () => {
    harness = await withParent();
    const id = await seedChild(harness, "silent", "waiting", Date.now() - 7 * MINUTE);

    await harness.runtime.subagents!.sweep(CTX);
    // The sweep only reads: a missing state file is a fact to report, not a file
    // to create on the child's behalf.
    expect(await idleNotes(harness)).toEqual([
      expectedNotice("silent", stateFile(harness, id), "5 minutes", "That file does not exist."),
    ]);
    await expect(utimes(stateFile(harness, id), 0, 0)).rejects.toThrow();
  });

  it("says nothing when the limit is 0", async () => {
    harness = await withParent(0);
    await seedChild(harness, "parked", "waiting", Date.now() - 60 * MINUTE);

    await harness.runtime.subagents!.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([]);
  });

  it("says nothing while a restart request is up, and names the wait once it is withdrawn", async () => {
    harness = await withParent();
    await seedChild(harness, "parked", "waiting", Date.now() - 6 * MINUTE);
    const subagents = harness.runtime.subagents!;

    // The gate passed, so the operator may restart now: nothing may wake a parent
    // that is parked at the safe point the restart needs.
    harness.runtime.restart.requireRestart();
    harness.runtime.restart.markReady();
    await subagents.sweep(CTX);
    expect(await idleNotes(harness)).toEqual([]);

    // The request was withdrawn: the wait is still owed a note, and it goes now.
    harness.runtime.restart.withdraw();
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);

    // Sent once, not once per sweep: the withdrawal earned the note, not the hold.
    await subagents.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);
  });

  it("still names the wait when a restart is required but not requested", async () => {
    harness = await withParent();
    await seedChild(harness, "parked", "waiting", Date.now() - 6 * MINUTE);

    // A batch of work is open: the restart is needed, but no request is up, so a
    // note costs no safe point and the parent is told as before.
    harness.runtime.restart.requireRestart();
    expect(harness.runtime.restart.status).toMatchObject({ required: true, ready: false });
    await harness.runtime.subagents!.sweep(CTX);
    expect((await idleNotes(harness)).length).toBe(1);
  });
});

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

describe("the nudge", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("leaves the way a subagent ends to its role", async () => {
    harness = await createTestHarness();
    const marker = "idle-notice nudge marker";
    const nudged = (context: Parameters<FauxResponseFactory>[0]): boolean =>
      context.messages.some((message) => messageText(message).includes("no person reads this"));
    const isChild = (context: Parameters<FauxResponseFactory>[0]): boolean =>
      context.messages.some((message) => message.role === "user" && messageText(message).includes(marker));
    // The child answers in prose once, which earns the nudge, and parks after it.
    const script: FauxResponseFactory = (context) =>
      isChild(context)
        ? nudged(context)
          ? fauxAssistantMessage([fauxToolCall("await_orders", { note: "parked" })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("done, I think")])
        : fauxAssistantMessage([fauxText("ok")]);
    harness.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("spawn_subagent", { name: "talker", vmodel: "faux", roles: [], initialPrompt: marker })],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 30 }, () => script),
    ]);
    const conversation = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const submission = await conversation.submit({ type: "input", content: "spawn one" }, CTX);
    await submission.wait(CTX);

    const index = await (async () => {
      const deadline = Date.now() + 8_000;
      for (;;) {
        const found = await harness!.runtime.harness.snapshot(SecAgentChild, PARENT, "talker", CTX);
        if (found !== undefined && found.conversationId !== "") return found;
        if (Date.now() > deadline) throw new Error("no index entry for talker");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const id = Number(index.conversationId) as ConversationId;
    const deadline = Date.now() + 10_000;
    let text = "";
    for (;;) {
      const page = await harness.runtime.storage.scanEntries({ conversationId: id, order: "ascending" }, 100, undefined, CTX);
      text = page.items
        .flatMap((entry) => (entry.model ?? []) as Message[])
        .map(messageText)
        .join("\n");
      const record = await harness.runtime.harness.snapshot(SecAgent, String(id), CTX);
      if (text.includes("no person reads this") && record?.status === "waiting") break;
      if (Date.now() > deadline) throw new Error("the child was never nudged and parked");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(text).toContain(
      "If your task is done, end it the way your role says: `finish_work` ends you with a final report, " +
        "and `await_orders` reports and keeps you for the next order. " +
        "If you need a decision from your parent, call `await_orders` with a note.",
    );
    expect(text).not.toContain("If your task is done, call `finish_work` with your final report.");
  });
});
