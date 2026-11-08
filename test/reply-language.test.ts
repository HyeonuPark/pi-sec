import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { AgentDoc, type Conversation } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import type { Config } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import { REPLY_LANGUAGE_EN, REPLY_LANGUAGE_KO } from "../src/extensions/reply-language-text.ts";
import { openFocusedChat } from "../src/focused/service.ts";
import { depsOf, sectionsOf } from "./focused-helpers.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The `reply-language` section: the language of every text the user reads.
 *
 * It renders second in the prompt, right after `preamble`, and only for the two
 * conversations that talk with a person: the root and a focused chat. It picks
 * its text by the language the personality file names, and it renders nothing
 * while no personality is registered, because that document is what names the
 * language. An orchestrator, a worker and a scheduled run answer their parent and
 * never write to a person, so they get no instruction about how to.
 *
 * The tests read the sections of the request the model is actually sent, one
 * conversation of each kind, built the way the product builds it. The section's
 * own text is fixed here, byte for byte.
 */

const CTX = BACKGROUND_CONTEXT;

/** The design interview is a request-scoped message, not a section; these tests read sections. */
const NO_INTERVIEW: Partial<Config> = {
  personality: { file: "memory/personality.md", interview: false, roles: ["orchestrator"] },
};

/** The section text when the personality names Korean. */
const KOREAN =
  "사용자가 읽는 글은 모두 한국어로 씁니다. 대화의 답, 도구를 부르기 전에 쓰는 글, 사용자에게 묻는 질문이 여기에 듭니다. 생각, 도구 결과, 다른 에이전트의 메시지, 이 프롬프트의 다른 절이 영어로 되어 있어도 이 규칙은 그대로입니다. 답을 내보내기 전에, 그 답이 한국어로 쓰였는지 확인합니다.";

/** The section text when the personality names English. */
const ENGLISH =
  "Write every text the user reads in English: chat replies, the text you write before a tool call, and questions to the user. This rule holds when your thinking, a tool result, a message from another agent, or another section of this prompt is in another language. Before you send a reply, make sure that it is in English.";

/**
 * Register a personality, or leave none, in the harness home the prompt reads.
 *
 * The file is the one `personality.file` names: a front matter with the language
 * and a body. The body is short on purpose: this test is about the language, and
 * the voice is the `personality` extension's business.
 */
async function register(test: TestHarness, language: "en" | "ko" | "none"): Promise<void> {
  if (language === "none") return;
  const body = language === "ko" ? "# 인물\n\n따뜻하고 담백하게 말합니다." : "# Persona\n\nWarm, plain, and short.";
  const path = join(test.paths.home, "memory", "personality.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nlanguage: ${language}\n---\n${body}\n`, "utf8");
}

/**
 * Submit one input and return the messages of the first request it made.
 *
 * A conversation that ends a turn by answering is nudged, and a nudge would read
 * the next scripted answer, so every request after the first parks in a
 * conversation that has `await_orders`. A scheduled run does not have it, and it
 * is never nudged the same way, so it answers with plain text throughout.
 */
async function firstRequest(test: TestHarness, conversation: Conversation, park: boolean): Promise<readonly Message[]> {
  let captured: readonly Message[] | undefined;
  let count = 0;
  const factory = (context: { readonly messages: readonly Message[] }): ReturnType<typeof fauxAssistantMessage> => {
    count++;
    if (captured === undefined) captured = context.messages;
    if (park && count > 1) {
      return fauxAssistantMessage([fauxToolCall("await_orders", { note: "parked" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage([fauxText("ok")]);
  };
  test.faux.setResponses(Array.from({ length: 40 }, () => factory));
  const submission = await conversation.submit({ type: "input", content: "hello" }, CTX);
  await submission.wait(CTX);
  if (captured === undefined) throw new Error("the conversation made no model request");
  return captured;
}

/** A conversation that is not the root, with an agent record and the tool filter of its kind. */
async function makeAgent(
  test: TestHarness,
  kind: "subagent" | "scheduled",
  roles: readonly string[],
): Promise<Conversation> {
  const model = test.faux.getModel();
  const remove = kind === "scheduled" ? SCHEDULED_TOOL_REMOVALS : SUBAGENT_TOOL_REMOVALS;
  return await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = kind;
        record.name = "helper";
        record.vmodel = "faux";
        record.roles = [...roles];
        record.status = "running";
        record.createdAt = Date.now();
        record.updatedAt = Date.now();
        // The filter the spawn and the scheduler write into the creating commit.
        const profile = await tx.doc(AgentDoc, conversationId);
        profile.tools = { remove: [...remove] };
      },
    },
    CTX,
  );
}

/** The root conversation, built the way the daemon builds it. */
async function rootOf(test: TestHarness): Promise<Conversation> {
  return await resolveDefaultConversation(test.runtime.harness, test.config, test.runtime.paths, CTX);
}

/** One focused chat, opened the way the web page opens it. */
async function focusedOf(test: TestHarness): Promise<Conversation> {
  const row = await openFocusedChat(depsOf(test), {}, CTX);
  const conversation = await test.runtime.harness.conversation(row.conversationId as never, CTX);
  if (conversation === undefined) throw new Error("the focused chat has no conversation");
  return conversation;
}

/** The text of one section, without the tags the seal puts around it. */
function sectionText(sections: Record<string, string>, key: string): string | undefined {
  const shown = sections[key];
  if (shown === undefined) return undefined;
  const open = `<${key}>\n`;
  const close = `\n</${key}>`;
  return shown.startsWith(open) && shown.endsWith(close) ? shown.slice(open.length, shown.length - close.length) : shown;
}

describe("the reply language named second in the prompt", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("carries the two texts, byte for byte", () => {
    // The sentences above are retyped: this is the check that
    // the constants and the text a reviewer read are the same text. The constants
    // are imported as well, so a drifted constant fails here.
    expect(REPLY_LANGUAGE_KO).toBe(KOREAN);
    expect(REPLY_LANGUAGE_EN).toBe(ENGLISH);
  });

  it("puts the section second for the root and a focused chat, in the language of the personality", async () => {
    for (const language of ["ko", "en"] as const) {
      const expected = language === "ko" ? KOREAN : ENGLISH;
      harness = await createTestHarness({ loadExtensions: true, config: NO_INTERVIEW });
      await register(harness, language);

      const conversations = { root: await rootOf(harness), focused: await focusedOf(harness) };
      for (const [kind, conversation] of Object.entries(conversations)) {
        const sections = sectionsOf(await firstRequest(harness, conversation, true));
        const keys = Object.keys(sections);
        expect(keys[0], `${language} / ${kind} / first`).toBe("preamble");
        expect(keys[1], `${language} / ${kind} / second`).toBe("reply-language");
        expect(sectionText(sections, "reply-language"), `${language} / ${kind}`).toBe(expected);
      }

      await harness.close();
      harness = undefined;
    }
  });

  it("leaves the section out of every conversation that does not write to a person", async () => {
    harness = await createTestHarness({ loadExtensions: true, config: NO_INTERVIEW });
    await register(harness, "ko");

    const conversations = {
      orchestrator: await makeAgent(harness, "subagent", ["orchestrator"]),
      worker: await makeAgent(harness, "subagent", ["worker"]),
      scheduled: await makeAgent(harness, "scheduled", []),
    };
    for (const [kind, conversation] of Object.entries(conversations)) {
      const sections = sectionsOf(await firstRequest(harness, conversation, kind !== "scheduled"));
      expect(sections["reply-language"], kind).toBeUndefined();
      // The prompt is still the prompt: the absence above is not an empty request.
      expect(Object.keys(sections).length, kind).toBeGreaterThan(5);
    }
  });

  it("leaves the section out of the root while no personality is registered", async () => {
    harness = await createTestHarness({ loadExtensions: true, config: NO_INTERVIEW });

    const sections = sectionsOf(await firstRequest(harness, await rootOf(harness), true));
    expect(sections["reply-language"]).toBeUndefined();
    // The root still reads the writing rules, and the personality is what is missing.
    expect(sections["simple-english"]).toBeDefined();
  });
});
