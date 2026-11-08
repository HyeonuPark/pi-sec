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
import { SecAgent, SecAgentChild, type AgentStatus } from "../src/documents.ts";
import { readMessage } from "../src/message-envelope.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The two tools that end a run, and the notice one wait is worth.
 *
 * `await_orders` and `finish_work` end the run that calls them, and the durable
 * layer ends a run only when every call of the batch ends it. A batch that holds
 * another call therefore leaves the run live, and the agent is nudged for a turn
 * it already ended. Both tools are refused in that case.
 *
 * A park is news once. An agent that parks again after a nudge or a background
 * result, with no message from another agent in between, has nothing new to say
 * to its parent.
 */
const CTX = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const NUDGE_FRAGMENT = "You cannot end your turn by answering";
const WAIT_NOTICE = "has finished what it was given and is waiting for orders.";
const FINISH_NOTICE = "finished its work and ended";
const AWAIT_REFUSAL =
  "await_orders was refused: call it as the only tool call of its batch, because the run ends only " +
  "when every call of the batch ends it. Call it again on its own.";
const FINISH_REFUSAL =
  "finish_work was refused: call it as the only tool call of its batch, because the run ends only " +
  "when every call of the batch ends it. Call it again on its own.";

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
 * The root's command, when the newest message that is not a system one carries it.
 *
 * The command is read from that message and no other. A tool result sits after
 * the command while the run continues, and reading past it would hand the same
 * command to every later request of the run.
 */
function command(context: Context): string | undefined {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]!;
    if (message.role === "system") continue;
    if (message.role !== "user") return undefined;
    const text = messageText(message);
    const words = readMessage(text)?.body ?? text;
    return words.includes("CMD:") ? words : undefined;
  }
  return undefined;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function say(words: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(words)]);
}

const park = (): AssistantMessage => call("await_orders", { note: "waiting for orders" });

/** One factory, repeated, so no conversation can run the queue dry. */
function script(factory: FauxResponseFactory, count = 300): FauxResponseFactory[] {
  return Array.from({ length: count }, () => factory);
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

/** How many entries of one conversation carry `fragment`. */
function mentions(rows: readonly Row[], fragment: string): number {
  return rows.filter((row) => row.text.includes(fragment)).length;
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
  return results(await rowsOf(harness, ROOT));
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

async function statusOf(harness: TestHarness, conversationId: ConversationId): Promise<AgentStatus | undefined> {
  return (await harness.runtime.harness.snapshot(SecAgent, String(conversationId), CTX))?.status;
}

async function reachStatus(harness: TestHarness, conversationId: ConversationId, status: AgentStatus): Promise<void> {
  await until(
    async () => ((await statusOf(harness, conversationId)) === status ? true : undefined),
    `conversation ${conversationId} to be ${status}`,
  );
}

async function busy(harness: TestHarness, conversationId: ConversationId): Promise<boolean> {
  return await harness.runtime.subagents!.hasLiveTask(conversationId, CTX);
}

/** The status rows the hub wrote for one conversation, in order. */
async function statusRows(harness: TestHarness, conversationId: ConversationId): Promise<string[]> {
  return (await readAuditTail(harness.paths.auditLog, undefined, 500))
    .filter((event) => event.type === "subagent_status" && event.conversationId === String(conversationId))
    .map((event) => String(event.status));
}

/** A root that spawns `c` on `CMD:` and sends it a note when the command says note. */
function rootScript(brief: string): FauxResponseFactory {
  return (context) => {
    const words = command(context);
    if (words === undefined) return say("ok");
    return words.includes("note")
      ? call("send_message", { to: "c", body: `NOTE ${brief}` })
      : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: brief });
  };
}

describe("a tool that ends its run is refused beside another call", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("refuses await_orders, writes no state, and tells the parent nothing", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (!hasUser(context, "BRIEF c")) return rootScript("BRIEF c")(context);
        // Nothing about the call is wrong: the batch has a second call in it, and
        // that is what the refusal is about.
        if (!hasResult(context, "call it as the only tool call of its batch")) {
          return fauxAssistantMessage(
            [fauxToolCall("background_list", {}), fauxToolCall("await_orders", { note: "BATCH-NOTE" })],
            { stopReason: "toolUse" },
          );
        }
        return call("finish_work", { note: "FINAL-REPORT after the refusal" });
      }),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    // The child ends the only way it can, so the parent's channel is proven by
    // the final report it gets.
    await until(
      async () => ((await harness!.runtime.harness.snapshot(SecAgent, String(childId), CTX)) === undefined ? true : undefined),
      "the child to finish",
    );

    expect(results(await rowsOf(harness, childId))).toContain(AWAIT_REFUSAL);
    // The refused call wrote no status, and the finish after it wrote one row.
    const statuses = await statusRows(harness, childId);
    expect(statuses).not.toContain("waiting");
    expect(statuses.at(-1)).toBe("stopped");

    const parentRows = await rowsOf(harness, ROOT);
    expect(mentions(parentRows, WAIT_NOTICE)).toBe(0);
    expect(mentions(parentRows, FINISH_NOTICE)).toBe(1);
  });

  it("refuses finish_work, writes no state, and ends nothing", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (!hasUser(context, "BRIEF c")) return rootScript("BRIEF c")(context);
        if (!hasResult(context, "call it as the only tool call of its batch")) {
          return fauxAssistantMessage(
            [fauxToolCall("background_list", {}), fauxToolCall("finish_work", { note: "BATCH-REPORT" })],
            { stopReason: "toolUse" },
          );
        }
        return park();
      }),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    await reachStatus(harness, childId, "waiting");

    expect(results(await rowsOf(harness, childId))).toContain(FINISH_REFUSAL);
    // The agent is still there and still holds its work: the refused call wrote
    // nothing, and only the park after it is a status change.
    expect(await statusOf(harness, childId)).toBe("waiting");
    expect(await statusRows(harness, childId)).toEqual(["running", "waiting"]);

    const parentRows = await rowsOf(harness, ROOT);
    expect(mentions(parentRows, FINISH_NOTICE)).toBe(0);
    expect(mentions(parentRows, WAIT_NOTICE)).toBe(1);
  });
});

describe("one wait, one notice", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("parks alone, ends its run, and tells its parent once", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => (!hasUser(context, "BRIEF c") ? rootScript("BRIEF c")(context) : park())),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    await reachStatus(harness, childId, "waiting");

    expect(results(await rowsOf(harness, childId))).toContain("Parked.");
    // The run ended: nothing is live under the child any more.
    expect(await busy(harness, childId)).toBe(false);
    expect(mentions(await rowsOf(harness, ROOT), WAIT_NOTICE)).toBe(1);
  });

  it("says nothing on a second park until an agent message arrives", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (!hasUser(context, "BRIEF c")) return rootScript("BRIEF c")(context);
        // The wake below is not a message from another agent, so the child tries
        // to answer first and is nudged back, then parks again.
        const nudged = context.messages.some((message) => messageText(message).includes(NUDGE_FRAGMENT));
        return hasUser(context, "PING") && !nudged ? say("hm") : park();
      }),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    await reachStatus(harness, childId, "waiting");
    expect(mentions(await rowsOf(harness, ROOT), WAIT_NOTICE)).toBe(1);

    // A background result and a nudge both reach a conversation without
    // `deliver()`, and a plain input is the same shape: it starts the run and
    // says nothing about another agent.
    const conversation = await harness.runtime.harness.conversation(childId, CTX);
    expect(conversation).toBeDefined();
    const submission = await conversation!.submit({ type: "input", content: "PING" }, CTX);
    await submission.wait(CTX);
    await reachStatus(harness, childId, "waiting");
    const childRows = await rowsOf(harness, childId);
    expect(mentions(childRows, NUDGE_FRAGMENT)).toBe(1);
    expect(mentions(childRows, "Parked.")).toBe(2);
    expect(mentions(await rowsOf(harness, ROOT), WAIT_NOTICE)).toBe(1);

    // The parent speaks, which is news: the next park is announced again.
    expect(await root(harness, "CMD: note")).toContain("sent note to c");
    await until(
      async () => ((mentions(await rowsOf(harness!, ROOT), WAIT_NOTICE) === 2) ? true : undefined),
      "the second wait notice",
    );
    expect(await statusOf(harness, childId)).toBe("waiting");
  });
});

describe("an answer from another agent is news too", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("hears the next park after a background request is answered", async () => {
    harness = await createTestHarness();
    // The parent answers a request by the token in its envelope. That answer is
    // word from another agent, even though a background request receives it as a
    // tool result rather than as an agent message. The answer is held back until
    // the first park is announced, so the two notices cannot arrive in one burst.
    let token: string | undefined;
    const parent = (context: Context): AssistantMessage => {
      for (let index = context.messages.length - 1; index >= 0; index -= 1) {
        const message = context.messages[index]!;
        if (message.role === "system") continue;
        if (message.role !== "user") break;
        const parsed = readMessage(messageText(message));
        if (parsed?.source !== "agent") break;
        const open = parsed.attrs["reply-token"];
        if (open === undefined) break;
        token = open;
        return say("noted");
      }
      const words = command(context);
      if (words === undefined) return say("ok");
      if (!words.includes("reply")) return rootScript("BRIEF c")(context);
      if (token === undefined) return say("nothing to answer");
      return call("send_reply", { replyToken: token, body: "ANSWER-FROM-PARENT" });
    };
    harness.faux.setResponses(
      script((context) => {
        if (!hasUser(context, "BRIEF c")) return parent(context);
        // Ask in the background, park while it runs, and park again when the
        // answer arrives as a tool result.
        if (hasResult(context, 'started "ask"')) return park();
        return call("async_call", {
          title: "ask",
          tool: "request_message",
          args: { to: "parent-agent", body: "QUESTION-FROM-CHILD" },
        });
      }),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    await reachStatus(harness, childId, "waiting");
    await until(async () => (token === undefined ? undefined : true), "the request to reach its parent");
    expect(mentions(await rowsOf(harness, ROOT), WAIT_NOTICE)).toBe(1);

    // The answer clears the child's record of the announced wait, so the park
    // after it is announced again.
    expect(await root(harness, "CMD: reply")).toContain("answered c");
    await until(
      async () => ((mentions(await rowsOf(harness!, ROOT), WAIT_NOTICE) === 2) ? true : undefined),
      "the second wait notice after the answer",
    );
    const rootRows = await rowsOf(harness, ROOT);
    expect(mentions(rootRows, "QUESTION-FROM-CHILD")).toBe(1);
    expect(mentions(rootRows, "ANSWER-FROM-PARENT")).toBe(0);
    const childRows = await rowsOf(harness, childId);
    expect(mentions(childRows, "ANSWER-FROM-PARENT")).toBe(1);
    expect(mentions(childRows, "Parked.")).toBe(2);
    expect(await busy(harness, childId)).toBe(false);
    expect(await statusRows(harness, childId)).toEqual(["running", "waiting", "running", "waiting"]);
  });
});
