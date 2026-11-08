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
import { SecAgentChild } from "../src/documents.ts";
import { readMessage } from "../src/message-envelope.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * Where a background result is placed: the answer to a background
 * `request_message` waits for the next boundary between tool rounds, and every
 * other result waits for the end of the run.
 *
 * The second rule is what keeps a result that arrives mid-run from interrupting
 * the run. The first is what makes an answer readable while the agent still
 * works, which is the whole point of asking. `background_list` reports the two
 * facts apart, because `delivered` says only that the submission was accepted.
 */
const CTX = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const ANSWER = "ANSWER-FROM-PARENT";
const QUESTION = "QUESTION-FROM-CHILD";

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

function userIndexes(context: Context, marker: string): number[] {
  return context.messages.flatMap((message, index) =>
    message.role === "user" && messageText(message).includes(marker) ? [index] : [],
  );
}

function hasResult(context: Context, fragment: string): boolean {
  return context.messages.some((message) => message.role === "toolResult" && messageText(message).includes(fragment));
}

/** How many tool results the model context already holds: one per finished tool round. */
function rounds(context: Context): number {
  return context.messages.filter((message) => message.role === "toolResult").length;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function say(words: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(words)]);
}

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

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

async function childOf(harness: TestHarness, parent: ConversationId, name: string): Promise<ConversationId> {
  const index = await until(
    () => harness.runtime.harness.snapshot(SecAgentChild, parent, name, CTX),
    `the index entry of "${name}"`,
  );
  return Number(index.conversationId) as ConversationId;
}

/** The reply token of the newest agent request in a context, if one is open. */
function replyToken(context: Context): string | undefined {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]!;
    if (message.role === "system" || message.role === "assistant") continue;
    if (message.role !== "user") break;
    const parsed = readMessage(messageText(message));
    if (parsed?.source !== "agent") break;
    const token = parsed.attrs["reply-token"];
    if (token !== undefined) return token;
  }
  return undefined;
}

describe("where a background result is placed", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("places the answer to a background request_message between tool rounds", { timeout: 120_000 }, async () => {
    harness = await createTestHarness();
    let answered = false;
    let spawned = false;
    // The child's own decision is the evidence. It asks in the background and
    // then keeps working, which is the state the answer has to reach: a run that
    // has not ended. A child that gives up before the answer arrives says one
    // thing, and one that read it says the other.
    let childTurns = 0;
    let gaveUp = false;
    const factory: FauxResponseFactory = (context) => {
      if (!hasUser(context, "BRIEF c")) {
        const token = answered ? undefined : replyToken(context);
        if (token !== undefined) {
          answered = true;
          return call("send_reply", { replyToken: token, body: ANSWER });
        }
        if (!spawned && hasUser(context, "CMD: spawn")) {
          spawned = true;
          return call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
        }
        return say("ok");
      }
      childTurns += 1;
      if (hasUser(context, ANSWER)) return call("finish_work", { note: gaveUp ? "LATE-ANSWER" : "SAW-ANSWER" });
      // A result placed only at the end of the run cannot arrive before this: the
      // child gives up by answering, which ends the run and lets the queue empty.
      if (childTurns > 6) {
        gaveUp = true;
        return say("giving up");
      }
      if (!hasResult(context, 'started "ask"')) {
        return call("async_call", {
          title: "ask",
          tool: "request_message",
          args: { to: "parent-agent", body: QUESTION },
        });
      }
      // A tool round that takes time, so the answer arrives while this run lives.
      return call("bash", { command: "sleep 0.3; echo ROUND-DONE" });
    };
    harness.faux.setResponses(script(factory));

    expect(await root(harness, "CMD: spawn")).toContain('started "c"');
    const childId = await childOf(harness, ROOT, "c");
    const parentRows = await until(async () => {
      const rows = await rowsOf(harness!, ROOT);
      const text = rows.map((row) => row.text).join("\n");
      return text.includes("SAW-ANSWER") || text.includes("LATE-ANSWER") ? rows : undefined;
    }, "the child's final report");
    const report = parentRows.map((row) => row.text).join("\n");
    expect(report).toContain("SAW-ANSWER");
    expect(report).not.toContain("LATE-ANSWER");

    // One copy of the answer, placed between two tool rounds of one run: a tool
    // result comes before it and the next tool result comes after it, so the run
    // that read it went on instead of ending first.
    const childRows = await rowsOf(harness, childId);
    const answerAt = childRows.findIndex((row) => row.kind === "pi.user" && row.text.includes(ANSWER));
    expect(answerAt).toBeGreaterThan(0);
    expect(childRows.filter((row) => row.kind === "pi.user" && row.text.includes(ANSWER)).length).toBe(1);
    expect(childRows.slice(0, answerAt).at(-1)?.kind).toBe("pi.tool-result");
    expect(childRows.slice(answerAt + 1).some((row) => row.kind === "pi.tool-result")).toBe(true);
  });

  it("holds every other background result until the run ends, and says so with placed", { timeout: 120_000 }, async () => {
    harness = await createTestHarness();
    // One scripted step per model call: the call starts, two slow rounds follow so
    // the result settles while the run lives, then the run reads the list.
    const steps = [
      call("async_call", { title: "bg", tool: "bash", args: { command: "sleep 0.8; echo BG-RESULT" } }),
      call("bash", { command: "sleep 0.6" }),
      call("bash", { command: "sleep 0.6" }),
      call("background_list", {}),
      say("checked"),
      say("the result is in"),
    ];
    harness.faux.setResponses(script(() => {
      const step = steps.shift();
      return step ?? say("the result is in");
    }));
    await root(harness, "start it");

    // The run ends before the result can be placed, so this reads one transcript:
    // the list was answered while the run lived, and the result was placed after
    // it ended.
    const rows = await until(async () => {
      const found = await rowsOf(harness!, ROOT);
      return found.some((row) => row.kind === "pi.user" && row.text.includes("BG-RESULT")) ? found : undefined;
    }, "the result to be placed after the run");

    const listRow = rows.find((row) => row.kind === "pi.tool-result" && row.text.includes('kind="async_tool_call"'));
    expect(listRow).toBeDefined();
    // `delivered` says the submission was accepted; `placed` says where it got.
    expect(listRow!.text).toContain('delivered="2026');
    expect(listRow!.text).toContain('placed="queued"');

    const listAt = rows.indexOf(listRow!);
    const resultAt = rows.findIndex((row) => row.kind === "pi.user" && row.text.includes("BG-RESULT"));
    const delivered = rows[resultAt]!;
    // It was not placed while the run lived, and the run went on after the list:
    // at least one entry of the run sits between the list and the placed result.
    expect(resultAt).toBeGreaterThan(listAt + 1);
    expect(delivered.text).toContain('src="tool-output"');
  });
});
