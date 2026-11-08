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
import type { ConversationId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { agentMessageRequestId } from "../src/agent-message.ts";
import { SecAgent, SecAgentChild } from "../src/documents.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A message that reaches a subagent around the time it finishes.
 *
 * A note sent to a working agent waits in the harness queue until the agent's
 * run ends, and then starts the next run. If the agent finished in between, the
 * note woke a conversation whose record was already retired, the conversation
 * was judged a scheduled run, `finish_work` was refused as "not available to a
 * scheduled agent", and `parent-agent` resolved to the root.
 */
const CTX = BACKGROUND_CONTEXT;
const NUDGE_FRAGMENT = "You cannot end your turn by answering";

type Context = Parameters<FauxResponseFactory>[0];

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

function hasUser(context: Context, marker: string): boolean {
  return context.messages.some((message) => message.role === "user" && messageText(message).includes(marker));
}

function hasResult(context: Context, fragment: string): boolean {
  return context.messages.some((message) => message.role === "toolResult" && messageText(message).includes(fragment));
}

/**
 * The last message that is not a system one.
 *
 * The personality interview appends a request-scoped system message to the
 * root's first request while no personality is registered, and it sits after the
 * user's text. A script that answers the user's last words reads the last
 * non-system message instead.
 */
function last(context: Context): Message | undefined {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "system") return message;
  }
  return undefined;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function say(words: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(words)]);
}

function script(factory: FauxResponseFactory, count = 300): FauxResponseFactory[] {
  return Array.from({ length: count }, () => factory);
}

/** The root's command is the last user message when it carries `CMD:`. */
function command(context: Context): string | undefined {
  const message = last(context);
  if (message?.role !== "user") return undefined;
  const words = messageText(message);
  return words.includes("CMD:") ? words : undefined;
}

interface Row {
  readonly kind: string;
  readonly text: string;
}

async function rowsOf(harness: TestHarness, conversationId: ConversationId): Promise<Row[]> {
  const page = await harness.runtime.storage.scanEntries({ conversationId, order: "ascending" }, 500, undefined, CTX);
  return page.items.map((entry) => ({
    kind: entry.kind,
    text: ((entry.model ?? []) as Message[]).map(messageText).join("\n"),
  }));
}

function results(rows: readonly Row[]): string {
  return rows
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

async function root(harness: TestHarness, content: string): Promise<string> {
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    CTX,
  );
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  return results(await rowsOf(harness, 1 as ConversationId));
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

async function childOf(harness: TestHarness, parent: ConversationId, name: string): Promise<ConversationId> {
  const index = await until(
    () => harness.runtime.harness.snapshot(SecAgentChild, parent, name, CTX),
    `the index entry of "${name}"`,
  );
  return Number(index.conversationId) as ConversationId;
}

async function released(harness: TestHarness, conversationId: ConversationId): Promise<void> {
  await until(
    async () =>
      (await harness.runtime.harness.snapshot(SecAgent, String(conversationId), CTX)) === undefined ? true : undefined,
    `conversation ${conversationId} to be released`,
  );
}

async function idle(harness: TestHarness, conversationId: ConversationId): Promise<void> {
  await until(
    async () => ((await harness.runtime.subagents!.hasLiveTask(conversationId, CTX)) ? undefined : true),
    `conversation ${conversationId} to go idle`,
  );
}

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Notes the root received, oldest first. */
async function rootNotes(harness: TestHarness): Promise<string[]> {
  return (await harness.runtime.subagents!.inbox(1 as ConversationId, CTX))
    .filter((message) => message.kind === "note")
    .map((message) => message.body);
}

describe("a message that reaches a subagent around the time it finishes", () => {
  let harness: TestHarness | undefined;
  let held: ReturnType<typeof gate> | undefined;

  afterEach(async () => {
    held?.open();
    held = undefined;
    await harness?.close();
    harness = undefined;
  });

  it("refuses finish_work while a message waits, and finishes after the agent read it", async () => {
    harness = await createTestHarness();
    held = gate();
    const opened = held.opened;
    harness.faux.setResponses(
      script(async (context) => {
        if (hasUser(context, "BRIEF")) {
          if (hasUser(context, "LATE-NOTE")) return call("finish_work", { note: "FINAL-REPORT after the note" });
          await opened;
          if (!hasResult(context, "finish_work was refused")) return call("finish_work", { note: "too early" });
          return say("ending the turn to read the message");
        }
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("note")
          ? call("send_message", { to: "c", body: "LATE-NOTE one more thing" })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    // The child is held inside its first request, so the note is queued.
    expect(await root(harness, "CMD: note")).toContain("sent note to c");
    expect(await harness.runtime.subagents!.queuedInputs(childId, CTX)).toHaveLength(1);

    held.open();
    await released(harness, childId);
    await idle(harness, childId);

    const rows = await rowsOf(harness, childId);
    const out = results(rows);
    expect(out).toContain(
      "finish_work was refused: a message is waiting for you. End your turn without a tool call, read the message in the next turn, then call finish_work again.",
    );
    expect(out).toContain("Finished. Your parent has your final report.");
    expect(out).not.toContain("scheduled agent");
    // The note was read in the run it started, and ending the turn for it was
    // not counted as a turn without finish_work.
    expect(rows.some((row) => row.kind === "pi.user" && row.text.includes("LATE-NOTE"))).toBe(true);
    expect(rows.some((row) => row.text.includes(NUDGE_FRAGMENT))).toBe(false);

    const notes = await rootNotes(harness);
    expect(notes.some((body) => body.includes("FINAL-REPORT after the note"))).toBe(true);
    expect(notes.some((body) => body.includes("too early"))).toBe(false);
  }, 20_000);

  it("refuses await_orders while a message waits, and parks after the agent read it", async () => {
    harness = await createTestHarness();
    held = gate();
    const opened = held.opened;
    // A second gate holds the child after the refused call and before its turn
    // ends, so the test can read the state the refusal left behind.
    const second = gate();
    harness.faux.setResponses(
      script(async (context) => {
        if (hasUser(context, "BRIEF")) {
          if (hasUser(context, "LATE-NOTE")) return call("await_orders", { note: "WAITING after the note" });
          await opened;
          if (!hasResult(context, "await_orders was refused")) {
            return call("await_orders", { note: "WAITING too early" });
          }
          await second.opened;
          return say("ending the turn to read the message");
        }
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("note")
          ? call("send_message", { to: "c", body: "LATE-NOTE one more thing" })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    expect(await root(harness, "CMD: note")).toContain("sent note to c");
    const hub = harness.runtime.subagents!;
    expect(await hub.queuedInputs(childId, CTX)).toHaveLength(1);

    held.open();
    await until(
      async () => ((await rowsOf(harness!, childId)).some((row) => row.text.includes("await_orders was refused")) ? true : undefined),
      "the refusal of await_orders",
    );

    // The refusal wrote nothing: the child is still running, no note reports it
    // as waiting, and the parent has not been told that the work is parked.
    const record = await harness.runtime.harness.snapshot(SecAgent, String(childId), CTX);
    expect(record?.status).toBe("running");
    expect(record?.lastNote).toBeUndefined();
    expect(await hub.hasLiveTask(childId, CTX)).toBe(true);
    expect(results(await rowsOf(harness, childId))).toContain(
      "await_orders was refused: a message is waiting for you. End your turn without a tool call, read the message in the next turn, then call await_orders again.",
    );
    expect((await rootNotes(harness)).some((body) => body.includes("WAITING too early"))).toBe(false);

    second.open();
    const parked = await until(async () => {
      const found = (await rootNotes(harness!)).filter((body) => body.includes("WAITING after the note"));
      return found.length > 0 ? found : undefined;
    }, "the note the park sends");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toContain("is waiting for orders");
    expect((await rootNotes(harness)).some((body) => body.includes("WAITING too early"))).toBe(false);
    expect((await harness.runtime.harness.snapshot(SecAgent, String(childId), CTX))?.status).toBe("waiting");
  }, 20_000);

  it("judges a finished subagent by how its conversation was created, not as a scheduled run", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) return call("finish_work", { note: "FINAL-REPORT done" });
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    const spawned = await root(harness, "CMD: spawn");
    const childId = Number(/started "c" \(conversation (\d+)/.exec(spawned)?.[1]) as ConversationId;
    await released(harness, childId);
    const hub = harness.runtime.subagents!;
    expect(await hub.kindOf(childId, CTX)).toBe("subagent");
    expect(await hub.isFinished(childId, CTX)).toBe(true);

    // A conversation with no record and no spawn behind it is still narrow.
    const plain = await harness.runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, CTX);
    expect(await hub.kindOf(plain.id, CTX)).toBe("scheduled");
    expect(await hub.isFinished(plain.id, CTX)).toBe(false);
  }, 20_000);

  it("does not start a run for a message to a finished subagent, and tells the sender", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) return call("finish_work", { note: "FINAL-REPORT done" });
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    const spawned = await root(harness, "CMD: spawn");
    const childId = Number(/started "c" \(conversation (\d+)/.exec(spawned)?.[1]) as ConversationId;
    await released(harness, childId);
    await idle(harness, childId);
    const before = (await rowsOf(harness, childId)).length;

    const hub = harness.runtime.subagents!;
    const written = await hub.writeMessage(CTX, {
      from: { conversationId: "1", name: "operator", agentKind: "root" },
      to: { conversationId: String(childId), name: "c", agentKind: "subagent" },
      kind: "note",
      body: "a note after the end",
    });
    const delivery = await hub.deliver(CTX, written);
    expect(delivery.delivered).toBe(false);
    expect(delivery.problem).toBe('"c" already finished its work and ended, so nobody would read it');
    expect(await hub.hasLiveTask(childId, CTX)).toBe(false);
    expect((await rowsOf(harness, childId)).length).toBe(before);
  }, 20_000);

  it("tells the sender when a message slipped in anyway, and keeps that run from acting as the agent", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "STRAY-NOTE")) {
          return hasResult(context, "is not available")
            ? say("nothing to do")
            : call("finish_work", { note: "a second final report" });
        }
        if (hasUser(context, "BRIEF")) return call("finish_work", { note: "FINAL-REPORT done" });
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    const spawned = await root(harness, "CMD: spawn");
    const childId = Number(/started "c" \(conversation (\d+)/.exec(spawned)?.[1]) as ConversationId;
    await released(harness, childId);
    await idle(harness, childId);

    // The race `deliver()` cannot close: a message admitted straight to the
    // conversation, the way a note queued a moment before the end arrives.
    const hub = harness.runtime.subagents!;
    const written = await hub.writeMessage(CTX, {
      from: { conversationId: "1", name: "operator", agentKind: "root" },
      to: { conversationId: String(childId), name: "c", agentKind: "subagent" },
      kind: "note",
      body: "STRAY-NOTE that slipped in",
    });
    const conversation = await harness.runtime.harness.conversation(childId, CTX);
    const submission = await conversation!.submit(
      { type: "input", content: "STRAY-NOTE that slipped in", requestId: agentMessageRequestId(written.id) },
      CTX,
    );
    await submission.wait(CTX);

    const out = results(await rowsOf(harness, childId));
    expect(out).toContain("`finish_work` is not available: this agent already finished its work and ended");
    expect(out).not.toContain("scheduled agent");
    // Nothing was recreated for the finished agent.
    expect(await harness.runtime.harness.snapshot(SecAgent, String(childId), CTX)).toBeUndefined();

    const notes = await until(async () => {
      const found = (await rootNotes(harness!)).filter((body) => body.includes("nobody read it"));
      return found.length > 0 ? found : undefined;
    }, "the note to the sender");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`"c" had already finished its work and ended when your note ${written.id} arrived`);
    expect(notes[0]).toContain("STRAY-NOTE that slipped in");
    expect((await rootNotes(harness)).some((body) => body.includes("a second final report"))).toBe(false);
  }, 20_000);

  it("withdraws a queued message and tells its sender", async () => {
    harness = await createTestHarness();
    held = gate();
    const opened = held.opened;
    harness.faux.setResponses(
      script(async (context) => {
        if (hasUser(context, "BRIEF")) {
          await opened;
          return call("await_orders", { note: "waiting" });
        }
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("note")
          ? call("send_message", { to: "c", body: "QUEUED-NOTE for later" })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await root(harness, "CMD: note");
    const hub = harness.runtime.subagents!;
    expect(await hub.queuedInputs(childId, CTX)).toHaveLength(1);

    const withdrawn = await hub.withdrawQueued(CTX, childId);
    expect(withdrawn.map((message) => message.body)).toEqual(["QUEUED-NOTE for later"]);
    expect(await hub.queuedInputs(childId, CTX)).toHaveLength(0);
    expect(await hub.tellUnread(CTX, withdrawn)).toBe(1);
    // Told once per message.
    expect(await hub.tellUnread(CTX, withdrawn)).toBe(0);
    const notes = (await rootNotes(harness)).filter((body) => body.includes("nobody read it"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("QUEUED-NOTE for later");
  }, 20_000);
});
