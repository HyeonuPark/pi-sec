import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { readMessage } from "../src/message-envelope.ts";
import { NO_RESPONSE_MARKER } from "../src/shared/silent-turn.ts";
import { submitEnveloped } from "../src/submit-envelope.ts";
import { conversationOf, focusedHarness, messageText, openChat } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * The nudge a turn the user started gets when it would end with nothing to read.
 *
 * A person wrote to the root or to a focused chat, so an answer with no text is
 * not an answer. The harness pushes the model back once with the text below. An
 * answer that says nothing is one the chat screen hides: either no text at all, or
 * the no-response line as its whole answer, judged by the same function the page
 * reads. The turns that somebody else started, an approval, a question card's
 * answer, an agent's message, keep their silent answer: that rule is unchanged.
 */
const CTX = BACKGROUND_CONTEXT;

/** The line a turn with nothing to say ends with, which the chat screen hides. */
const MARKER = NO_RESPONSE_MARKER;

/** The nudge's own words, as fixed here: one line, and this is all of it. */
const NUDGE_TEXT =
  "The user wrote to you, and this turn has no text for them yet. Answer the user now, in this conversation. " +
  "If you meant to give a step, a command, or a result, write it in this reply.";

type Context = Parameters<FauxResponseFactory>[0];

/** An answer with no content at all: one of the two answers the screen hides. */
function quiet(): AssistantMessage {
  return fauxAssistantMessage([]);
}

/** The other hidden answer: the no-response line, and nothing else. */
function silent(): AssistantMessage {
  return fauxAssistantMessage([fauxText(MARKER)]);
}

function say(words: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(words)]);
}

/** One factory, repeated, so no conversation can run the queue dry. */
function script(factory: FauxResponseFactory, count = 60): FauxResponseFactory[] {
  return Array.from({ length: count }, () => factory);
}

/** Whether the request shows the nudge, which is what the model reads before it answers again. */
function nudged(context: Context): boolean {
  return context.messages.some((message) => message.role === "user" && messageText(message).includes(NUDGE_TEXT));
}

interface Row {
  readonly kind: string;
  readonly text: string;
}

async function rowsOf(harness: TestHarness, conversationId: ConversationId): Promise<Row[]> {
  const page = await harness.runtime.storage.scanEntries({ conversationId, order: "ascending" }, 500, undefined, CTX);
  return page.items.map((entry) => ({
    kind: entry.kind,
    text: ((entry.model ?? []) as { content?: unknown }[]).map(messageText).join("\n"),
  }));
}

/** How many stored messages carry the nudge's words, envelope read as a reader reads it. */
async function nudges(harness: TestHarness, conversationId: ConversationId): Promise<number> {
  const rows = await rowsOf(harness, conversationId);
  return rows.filter((row) => readMessage(row.text)?.body === NUDGE_TEXT).length;
}

/** The root conversation of this harness. */
async function rootOf(harness: TestHarness): Promise<Conversation> {
  return await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
}

/** One message the user typed, with the envelope the web page writes. */
async function userSays(
  harness: TestHarness,
  conversation: Conversation,
  content: string,
  attrs?: Readonly<Record<string, string>>,
): Promise<void> {
  const submission = await submitEnveloped(
    conversation,
    CTX,
    { type: "input", src: "operator", content, ...(attrs === undefined ? {} : { attrs }) },
    harness.config.timezone,
  );
  await submission.wait(CTX);
}

/** One message from somewhere else, labelled with the source and attributes that door writes. */
async function otherSays(
  harness: TestHarness,
  conversation: Conversation,
  src: "operator" | "agent" | "system" | "tool-output",
  content: string,
  attrs?: Readonly<Record<string, string>>,
): Promise<void> {
  const submission = await submitEnveloped(
    conversation,
    CTX,
    { type: "input", src, content, ...(attrs === undefined ? {} : { attrs }) },
    harness.config.timezone,
  );
  await submission.wait(CTX);
}

describe("a turn the user started answers in text", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("nudges the root once, with its fixed words, and the root then answers", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script((context) => {
        requests += 1;
        return nudged(context) ? say("Run the next step: reload sshd.") : quiet();
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    const rows = await rowsOf(harness, root.id);
    expect(requests).toBe(2);
    expect(await nudges(harness, root.id)).toBe(1);
    // The nudge arrived as a system envelope inside the run, as the subagent nudge does.
    const nudgeRow = rows.find((row) => readMessage(row.text)?.body === NUDGE_TEXT);
    expect(readMessage(nudgeRow!.text)).toMatchObject({ source: "system", attrs: { kind: "nudge" } });
    expect(rows.some((row) => row.kind === "pi.assistant" && row.text.includes("Run the next step"))).toBe(true);
  });

  it("nudges a focused chat the same way", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script((context) => {
        requests += 1;
        return nudged(context) ? say("Step 5: reload sshd on the router.") : quiet();
      }),
    );
    const chat = await openChat(harness, "예시 주제");
    const conversation = await conversationOf(harness, chat.conversationId);
    await userSays(harness, conversation, "예시 메시지입니다. 다음?");

    const rows = await rowsOf(harness, chat.conversationId as ConversationId);
    expect(requests).toBe(2);
    expect(await nudges(harness, chat.conversationId as ConversationId)).toBe(1);
    expect(rows.some((row) => row.kind === "pi.assistant" && row.text.includes("Step 5"))).toBe(true);
  });

  it("stops after one nudge when the second answer is empty too", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return quiet();
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    // The run ends after the answer that follows the nudge: one extra request,
    // and the user is not asked again.
    expect(requests).toBe(2);
    expect(await nudges(harness, root.id)).toBe(1);
  });

  it("nudges a turn that ran a tool and then answered with no text", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script((context) => {
        requests += 1;
        if (nudged(context)) return say("Step 5: reload sshd.");
        if (context.messages.some((message) => message.role === "toolResult")) return quiet();
        return fauxAssistantMessage([fauxToolCall("background_list", {})], { stopReason: "toolUse" });
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    // The tool round wrote no text either, and the turn is still one the user is
    // waiting on: the nudge reads the whole run, not just its last answer.
    expect(requests).toBe(3);
    expect(await nudges(harness, root.id)).toBe(1);
    expect((await rowsOf(harness, root.id)).some((row) => row.text.includes("Step 5"))).toBe(true);
  });

  it("nudges a turn that answers the user with the line alone, and the user then reads an answer", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script((context) => {
        requests += 1;
        return nudged(context) ? say("Step 5: reload sshd on the router.") : silent();
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    // The screen hides the line, so the turn the user is waiting on has shown them
    // nothing: the same nudge as an empty answer, and one of them.
    expect(requests).toBe(2);
    expect(await nudges(harness, root.id)).toBe(1);
    expect((await rowsOf(harness, root.id)).some((row) => row.text.includes("Step 5"))).toBe(true);
  });

  it("leaves a turn alone when the line sits inside a sentence, which the screen draws", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return say(`표지는 ${MARKER} 입니다. 잠시 뒤 결과를 알려 드리겠습니다.`);
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    expect(requests).toBe(1);
    expect(await nudges(harness, root.id)).toBe(0);
  });

  it("leaves a turn with text alone", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return say("Step 5: reload sshd.");
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "다음?");

    expect(requests).toBe(1);
    expect(await nudges(harness, root.id)).toBe(0);
  });
});

describe("a turn somebody else started may end empty", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("does not nudge an approval input", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return quiet();
      }),
    );
    const root = await rootOf(harness);
    await userSays(harness, root, "Approved.", { via: "approval", approval: "20261027-01M5YBCRMC000000000000JJP9/v1" });

    expect(requests).toBe(1);
    expect(await nudges(harness, root.id)).toBe(0);
  });

  it("does not nudge a question card's answer", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return quiet();
      }),
    );
    const root = await rootOf(harness);
    await otherSays(harness, root, "operator", "Yes.", { via: "ask-user", key: "k", mode: "choice" });

    expect(requests).toBe(1);
    expect(await nudges(harness, root.id)).toBe(0);
  });

  it("does not nudge a turn an agent's message started, in the root or in a focused chat", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return quiet();
      }),
    );
    const root = await rootOf(harness);
    await otherSays(harness, root, "agent", "The report is published.", { from: "root", kind: "note" });
    const chat = await openChat(harness, "예시 주제");
    const conversation = await conversationOf(harness, chat.conversationId);
    await otherSays(harness, conversation, "agent", "A note from the root.", { from: "root", kind: "note" });

    expect(requests).toBe(2);
    expect(await nudges(harness, root.id)).toBe(0);
    expect(await nudges(harness, chat.conversationId as ConversationId)).toBe(0);
  });

  it("does not nudge a turn an agent's message started, even when it answers with the line alone", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return silent();
      }),
    );
    const root = await rootOf(harness);
    await otherSays(harness, root, "agent", "The report is published.", { from: "root", kind: "note" });
    const chat = await openChat(harness, "예시 주제");
    const conversation = await conversationOf(harness, chat.conversationId);
    await otherSays(harness, conversation, "agent", "A note from the root.", { from: "root", kind: "note" });

    expect(requests).toBe(2);
    expect(await nudges(harness, root.id)).toBe(0);
    expect(await nudges(harness, chat.conversationId as ConversationId)).toBe(0);
  });

  it("does not nudge a message with no envelope, which no producer writes", async () => {
    harness = await focusedHarness();
    let requests = 0;
    harness.faux.setResponses(
      script(() => {
        requests += 1;
        return quiet();
      }),
    );
    const root = await rootOf(harness);
    const submission = await root.submit({ type: "input", content: "다음?" }, CTX);
    await submission.wait(CTX);

    expect(requests).toBe(1);
    expect(await nudges(harness, root.id)).toBe(0);
  });
});
