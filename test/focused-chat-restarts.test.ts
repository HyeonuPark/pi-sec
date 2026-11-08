import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  StorageWrite,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecRestartRound, type AgentStatus } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createSelfEditExtension, restartWatchOf } from "../src/extensions/self-edit.ts";
import { ROUND_KEY } from "../src/extensions/session-restart.ts";
import { archiveFocusedChat } from "../src/focused/service.ts";
import { readMessage } from "../src/message-envelope.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import { depsOf, focusedHarness, openChat, runTool } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";
import type { MessageRecord } from "../src/documents.ts";

/**
 * The restart paths, with a focused chat open.
 *
 * A focused chat is a sub-session of the root that the user reads and writes, so
 * every restart has to reach it: a cold restart sends it the same safe-point note
 * a working subagent gets and waits until it parks, a restart request that is up
 * tells the root when the chat goes back to work, and a session restart round
 * includes it and counts it ready from its own entry log.
 *
 * The gate would run `tsc` and `vitest` in the workspace tree, which is an empty
 * temporary directory here, so it is replaced for this file alone; the checks
 * around it are the ones under test.
 */
vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: async () => ({ typecheck: true, tests: true }),
  collectChangeText: async () => ({ text: "diff --git a/src/x.ts b/src/x.ts\n" }),
}));

const CTX = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const TITLE = "restart: the focused chats stand at a safe point too";

function answers(count = 40): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** Wait until no task of these conversations is live, so the next input starts a run now. */
async function quiet(test: TestHarness, conversationIds: readonly number[]): Promise<void> {
  const wanted = new Set(conversationIds.map(String));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const inspection = await test.runtime.harness.inspect(CTX);
    const live = inspection.tasks.filter((task) => wanted.has(String(task.record.conversationId)));
    if (live.length === 0) return;
    if (Date.now() > deadline) throw new Error("the conversations never stopped working");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until `check` answers, because a delivered note lands in the next run. */
async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The messages written into one conversation's inbox. */
async function inbox(test: TestHarness, conversationId: number): Promise<readonly MessageRecord[]> {
  return await test.runtime.subagents!.inbox(conversationId as ConversationId, CTX);
}

/** The `[restart gate]` notes one conversation received. */
async function gateNotes(test: TestHarness, conversationId: number): Promise<readonly MessageRecord[]> {
  return (await inbox(test, conversationId)).filter(
    (message) => message.kind === "note" && message.body.includes("[restart gate]"),
  );
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("a cold restart with an open focused chat", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await focusedHarness();
    harness.faux.setResponses(answers());
    return harness;
  }

  /** `request_restart` over this runtime, with its own hub, store and restart state. */
  function gateTool(test: TestHarness): ToolRegistration {
    const runtime = test.runtime;
    const context = {
      getConfig: runtime.getConfig,
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      harness: runtime.harness,
      subagents: runtime.subagents,
      focusedChats: runtime.focusedChats,
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  function execApi(test: TestHarness): ToolExecutionApi {
    return {
      conversationId: ROOT,
      commit: (change: (tx: never) => unknown, context: Context) =>
        test.runtime.harness.commit(change as never, context),
    } as unknown as ToolExecutionApi;
  }

  async function refusedRows(test: TestHarness): Promise<AuditEvent[]> {
    return (await readAuditTail(test.paths.auditLog, undefined, 100)).filter((event) => event.type === "restart_refused");
  }

  it("tells an idle chat to stand at a safe point, and passes only after it parks", async () => {
    const h = await boot();
    const chat = await openChat(h, "the trip");
    // The `waiting` status a chat is opened with is not a park: it never had a
    // brief, and nobody has answered any note yet.
    const opened = await h.runtime.harness.snapshot(SecAgent, String(chat.conversationId), CTX);
    expect(opened?.status).toBe("waiting");
    expect(opened?.lastNote).toBeUndefined();

    const tool = gateTool(h);
    const first = await tool.execute({ title: TITLE } as never, execApi(h), CTX);

    expect(first.isError).toBe(true);
    const text = textOf(first);
    expect(text).toContain("Restart NOT requested yet");
    expect(text).toContain("safe-point requests sent to 1 child conversation");
    expect(text).toContain(chat.name);
    expect(text).toContain(`conversation ${chat.conversationId}`);
    expect(text).toContain("focused chat");
    expect(h.runtime.restart.status.ready).toBe(false);
    const rows = await refusedRows(h);
    expect(rows.map((row) => row.code)).toEqual(["safe_point_waiting"]);
    expect(rows[0]!.reasons?.some((reason) => reason.includes(chat.name))).toBe(true);

    // The note really reaches the chat: it is addressed to it and delivered.
    const note = await until(async () => (await gateNotes(h, chat.conversationId))[0], "the safe-point note");
    expect(note.to.conversationId).toBe(String(chat.conversationId));
    expect(note.to.agentKind).toBe("focused");
    expect(note.body).toContain("await_orders");

    // A second call does not write a second note: one request, one note per chat.
    const again = await tool.execute({ title: TITLE } as never, execApi(h), CTX);
    expect(textOf(again)).toContain("note sent less than a minute ago");
    expect(await gateNotes(h, chat.conversationId)).toHaveLength(1);

    // The chat parks. That is the record's own `await_orders` write, which is
    // what the gate compares with the time it sent the note.
    await quiet(h, [chat.conversationId]);
    const parked = await runTool(h, chat.conversationId, "await_orders", { note: "parked at a safe point" });
    expect(parked).toContain("Parked");
    const record = await h.runtime.harness.snapshot(SecAgent, String(chat.conversationId), CTX);
    expect(record?.status).toBe("waiting");
    expect(record?.lastNote).toBe("parked at a safe point");

    // The root was told about the park, in the words a subagent's park uses.
    const told = await until(
      async () => (await inbox(h, ROOT)).find((message) => message.body.includes("waiting for orders")),
      "the park note to the root",
    );
    expect(told.from.conversationId).toBe(String(chat.conversationId));

    await quiet(h, [ROOT]);
    const second = await tool.execute({ title: TITLE } as never, execApi(h), CTX);
    expect(textOf(second)).toContain("Gate passed");
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: true });
  });

  it("sends a chat the note its own role can act on, word for word", async () => {
    const h = await boot();
    const chat = await openChat(h, "the note");

    await gateTool(h).execute({ title: TITLE } as never, execApi(h), CTX);

    const note = await until(async () => (await gateNotes(h, chat.conversationId))[0], "the safe-point note");
    // A focused chat is told to do three things in the same turn and to end at
    // `await_orders`, because a reply that just stops is not a safe point. It is
    // not given the subagent note: that one names three cases a chat never has.
    expect(note.body).toBe(
      [
        `[restart gate] A cold restart of this daemon is being prepared for the change "${TITLE}".`,
        "A cold restart cuts the turn in flight, so this chat has to stand at a safe point before it.",
        "In this same turn, do these three steps in order:",
        "1. Tell the user in one or two sentences that a restart is coming and that this chat continues after it.",
        "2. Write your current state and the next step to your context file.",
        "3. Call `await_orders`, and say in its note that you are at a safe point. A reply that ends without `await_orders` does not count as a safe point.",
      ].join("\n"),
    );
  });

  it("asks a chat again when it parked before the note was sent", async () => {
    const h = await boot();
    const chat = await openChat(h, "parked early");
    // A park from an earlier restart round: the status and the note are there,
    // but the write is older than this gate's note, so it proves nothing about it.
    await quiet(h, [chat.conversationId]);
    await runTool(h, chat.conversationId, "await_orders", { note: "parked before the request" });
    const before = await h.runtime.harness.snapshot(SecAgent, String(chat.conversationId), CTX);
    expect(before?.status).toBe("waiting");

    const result = await gateTool(h).execute({ title: TITLE } as never, execApi(h), CTX);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(chat.name);
    const note = await until(async () => (await gateNotes(h, chat.conversationId))[0], "the second note");
    expect(note.body).toContain("[restart gate]");
  });

  it("leaves an archived chat out of the safe point", async () => {
    const h = await boot();
    const open = await openChat(h, "still open");
    const archived = await openChat(h, "already archived");
    await archiveFocusedChat(depsOf(h), archived.conversationId, CTX);

    const result = await gateTool(h).execute({ title: TITLE } as never, execApi(h), CTX);

    const text = textOf(result);
    expect(text).toContain(open.name);
    expect(text).toContain(`conversation ${open.conversationId}`);
    expect(text).not.toContain(archived.name);
    expect(text).not.toContain(`conversation ${archived.conversationId}`);
    expect(await gateNotes(h, archived.conversationId)).toHaveLength(0);
  });

  it("refuses again when a parked chat goes back to work", async () => {
    const h = await boot();
    const chat = await openChat(h, "woken again");
    const tool = gateTool(h);

    await tool.execute({ title: TITLE } as never, execApi(h), CTX);
    await quiet(h, [chat.conversationId]);
    await runTool(h, chat.conversationId, "await_orders", { note: "parked" });
    await quiet(h, [ROOT]);
    expect(textOf(await tool.execute({ title: TITLE } as never, execApi(h), CTX))).toContain("Gate passed");

    // The user writes to the chat: it is working again, so the safe point the
    // request was raised on no longer holds.
    const conversation = await h.runtime.harness.conversation(chat.conversationId as ConversationId, CTX);
    if (conversation === undefined) throw new Error("the chat conversation is gone");
    h.faux.setResponses(answers());
    await (await conversation.submit({ type: "input", content: "one more thing" }, CTX)).wait(CTX);

    const after = await tool.execute({ title: TITLE } as never, execApi(h), CTX);
    expect(after.isError).toBe(true);
    expect(textOf(after)).toContain(chat.name);
  });
});

describe("the restart request and a focused chat that goes back to work", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** One task on a conversation, in the state the busy rule reads. */
  async function seedTask(test: TestHarness, conversationId: number, status: "running" | "terminal"): Promise<void> {
    const storage = test.runtime.storage;
    const taskId = await storage.mintId<TaskId>();
    const settle = status === "terminal";
    const write = {
      type: "task",
      value: {
        id: taskId,
        conversationId: conversationId as ConversationId,
        kind: "pi.generation",
        version: 1,
        input: {},
        background: false,
        abortRequested: false,
        startedAt: Date.now(),
        ...(settle ? { endedAt: Date.now() } : {}),
        state: settle
          ? { status: "terminal", outcome: { status: "completed", result: {} } }
          : { status, checkpoint: { phase: "execute" } },
      },
    } as unknown as StorageWrite;
    await commitWrites(storage, [write], CTX);
  }

  async function boot(): Promise<TestHarness> {
    harness = await focusedHarness();
    harness.faux.setResponses(answers());
    return harness;
  }

  /**
   * Raise the request and arm the watch, the way a gate that passes does.
   *
   * The gate itself is `test/focused-chat-restarts.test.ts` above; what this
   * block is about is what the watch does once the request is up, so it arms the
   * same object `request_restart` arms.
   */
  function arm(test: TestHarness): void {
    test.runtime.restart.requireRestart();
    test.runtime.restart.markReady();
    const watch = restartWatchOf(test.runtime.restart);
    if (watch === undefined) throw new Error("the restart watch is not registered");
    watch.arm({ conversationId: ROOT, title: TITLE });
  }

  /** The `[restart state]` notes in the root's conversation, oldest first. */
  async function stateNotes(test: TestHarness): Promise<string[]> {
    const page = await test.runtime.storage.scanEntries({ conversationId: ROOT, order: "descending" }, 200, undefined, CTX);
    const bodies: string[] = [];
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "user") continue;
        const content = (message as { content?: unknown }).content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) =>
                    part !== null && typeof part === "object" ? String((part as { text?: string }).text ?? "") : "",
                  )
                  .join("")
              : "";
        const read = readMessage(text);
        if (read === undefined || !read.body.includes("[restart state]")) continue;
        bodies.push(read.body);
      }
    }
    return bodies.reverse();
  }

  async function lostRows(test: TestHarness): Promise<AuditEvent[]> {
    return (await readAuditTail(test.paths.auditLog, undefined, 100)).filter(
      (event) => event.type === "restart_safe_point_lost",
    );
  }

  /** Put one chat record into the state a model request is about to find it in. */
  async function restate(test: TestHarness, conversationId: number, status: AgentStatus): Promise<void> {
    await test.runtime.harness.commit(async (tx) => {
      const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
      record.status = status;
      record.updatedAt = Date.now();
    }, CTX);
  }

  /** The `beforeRequest` handler of the subagents extension, as the runtime calls it. */
  function beforeRequestOf(test: TestHarness): (request: unknown, api: unknown, context: Context) => Promise<unknown> {
    const handlers = test.runtime.registry
      .snapshot()
      .installed()
      .flatMap((extension) =>
        (extension.hooks ?? [])
          .filter((registration) => registration.task === "pi.generation")
          .map((registration) => ({
            name: extension.name,
            handler: (
              registration.handlers as {
                beforeRequest?: (request: unknown, api: unknown, context: Context) => Promise<unknown>;
              }
            ).beforeRequest,
          })),
      );
    const subagents = handlers.find((each) => each.name === "subagents");
    if (subagents?.handler === undefined) throw new Error("the subagents beforeRequest hook is not installed");
    return subagents.handler;
  }

  it("tells the root when a chat that is already running starts a model request", async () => {
    const h = await boot();
    const chat = await openChat(h, "wake me");
    // A record that says `running` with no status change is the case a status
    // change cannot see: only the request itself carries the fact.
    await restate(h, chat.conversationId, "running");
    await seedTask(h, chat.conversationId, "running");
    arm(h);

    await beforeRequestOf(h)({ messages: [] }, { conversationId: chat.conversationId }, CTX);

    const bodies = await until(async () => ((await stateNotes(h)).length > 0 ? await stateNotes(h) : undefined), "the note");
    expect(bodies).toEqual([
      `[restart state] The restart request for "${TITLE}" is still up, but ${chat.name} started working. ` +
        "The safe point no longer holds. Withdraw the request with withdraw_restart and tell the user that the restart must wait.",
    ]);
    const rows = await lostRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent).toBe(chat.name);
    expect(rows[0]!.trigger).toBe("request");
    // The harness reports; the state stays the root's to withdraw.
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: true });
  });

  it("tells the root when a parked chat is put back to running", async () => {
    const h = await boot();
    const chat = await openChat(h, "parked and woken");
    await seedTask(h, chat.conversationId, "running");
    arm(h);

    await h.runtime.subagents!.setStatus(CTX, chat.conversationId as ConversationId, "running", {});

    const bodies = await until(async () => ((await stateNotes(h)).length > 0 ? await stateNotes(h) : undefined), "the note");
    expect(bodies[0]).toContain(`${chat.name} started working`);
    expect((await lostRows(h))[0]!.trigger).toBe("status");
  });
});

describe("a session restart round over a focused chat", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await focusedHarness();
    harness.faux.setResponses(answers(80));
    return harness;
  }

  it("includes an idle open chat, leaves an archived one out, and counts it ready after its reset", async () => {
    const h = await boot();
    const root = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, CTX);
    const open = await openChat(h, "a chat in the round");
    const archived = await openChat(h, "a chat already archived");
    await archiveFocusedChat(depsOf(h), archived.conversationId, CTX);

    const started = await runTool(h, root.id, "restart_cascade_start", { reason: "the prompt moved" });
    expect(started).toContain("is open over 1 target(s)");
    expect(started).toContain(open.name);
    expect(started).not.toContain(archived.name);

    const round = await h.runtime.harness.snapshot(SecRestartRound, root.id, ROUND_KEY, CTX);
    if (round === undefined) throw new Error("the round document is missing");
    expect(round.targets.map((target) => target.conversationId)).toEqual([String(open.conversationId)]);

    // The note reaches the idle chat: nothing else wakes it, so a round that only
    // spoke to working chats would wait here forever.
    const note = await until(
      async () =>
        (await inbox(h, open.conversationId)).find((message) => message.body.includes("[restart round")),
      "the round note",
    );
    expect(note.to.agentKind).toBe("focused");
    expect(await inbox(h, archived.conversationId)).toHaveLength(0);

    // The chat restarts itself, which writes its own `pi.reset` and the new
    // baseline after it.
    await quiet(h, [open.conversationId, root.id]);
    const restarted = await runTool(h, open.conversationId, "restart_session", {
      reason: "the prompt moved",
      continuation: "Continue where this chat stopped.",
      roundId: round.roundId,
    });
    expect(restarted).toContain("restarting this conversation");
    await quiet(h, [open.conversationId]);

    await quiet(h, [root.id]);
    const counted = await runTool(h, root.id, "restart_cascade_status", { roundId: round.roundId });
    expect(counted).toContain("1/1 target(s) counted");
    expect(counted).toContain("ready");
  });
});
