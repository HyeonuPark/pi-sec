import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { loadConfig } from "../src/config/load.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import { BUNDLED_EXTENSIONS } from "../src/extensions/index.ts";
import { interviewLanguage, scriptCounts } from "../src/extensions/personality.ts";
import {
  parsePersonality,
  personalityBodyOf,
  personalityPath,
  renderPersonalityFile,
  writePersonalityFile,
} from "../src/extensions/personality-file.ts";
import {
  INTERVIEW,
  PERSONALITY_GET_NONE,
  PERSONALITY_INTRO_FOCUSED,
  PERSONALITY_INTRO_ORCHESTRATOR,
  PERSONALITY_INTRO_ROOT,
  PERSONALITY_SET_FIRST,
  PERSONALITY_SET_REPLACED,
} from "../src/extensions/personality-texts.ts";
import { AGENT_LANGUAGE_KO, FLUENT_KOREAN, SIMPLE_ENGLISH } from "../src/extensions/language-rules-text.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The `personality` and `language-rules` extensions.
 *
 * What a prompt carries is decided by two facts about the conversation: its
 * kind (root, focused chat, orchestrator, planner, worker, scheduled run) and the
 * language its personality names. These tests build one conversation of each kind
 * and read the system prompt the model is actually sent, because that is the only
 * place the two decisions meet.
 */

const CTX = BACKGROUND_CONTEXT;
const NO_INTERVIEW = {
  personality: { file: "memory/personality.md", interview: false, roles: ["orchestrator"] },
} as Partial<Config>;

type Context = Parameters<FauxResponseFactory>[0];

// Korean text here is test data: the code under test handles Korean on purpose.
/** A document with a personality in it, and the language it names. */
const DOCUMENTS = [
  {
    name: "a document that names English",
    text: "---\nlanguage: en\n---\n# Persona\n\nWarm, plain, and short.\n",
    language: "en" as const,
    body: "Warm, plain, and short.",
  },
  {
    name: "a document that names Korean",
    text: "---\nlanguage: ko\n---\n# 인물\n\n따뜻하고 담백하게 말합니다.\n",
    language: "ko" as const,
    body: "따뜻하고 담백하게 말합니다.",
  },
];

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

function entryText(entry: EntryRecord): string {
  return (entry.model ?? []).map(messageText).join("\n");
}

/** The leading system message as a provider without mid-conversation system messages receives it. */
function collapsedHead(messages: Parameters<typeof collapseSystemMessages>[0]["messages"]): string {
  const collapsed = collapseSystemMessages({ messages }).messages;
  const head = collapsed[0];
  return head !== undefined && head.role === "system" ? getSystemMessageText(head) : "";
}

/** The text of every system message in a request, joined: the prompt plus any directive. */
function systemText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message))
    .join("\n---\n");
}

/** The path the default `personality.file` names under this harness's home. */
function personalityFile(test: TestHarness): string {
  return join(test.paths.home, "memory", "personality.md");
}

async function writePersonality(test: TestHarness, text: string): Promise<void> {
  const path = personalityFile(test);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/**
 * Submit one input and return the messages of the first request it made.
 *
 * A subagent's run is nudged when it ends a turn without parking, so `park`
 * answers every request after the first with `await_orders`. The head is read
 * from the first request either way.
 */
async function firstRequest(
  test: TestHarness,
  conversation: Conversation,
  content: string,
  options: { readonly park?: boolean } = {},
): Promise<readonly Message[]> {
  let captured: readonly Message[] | undefined;
  let count = 0;
  const factory = (context: Context): ReturnType<typeof fauxAssistantMessage> => {
    count++;
    if (captured === undefined) captured = context.messages;
    if (options.park === true && count > 1) {
      return fauxAssistantMessage([fauxToolCall("await_orders", { note: "parked" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage([fauxText("ok")]);
  };
  test.faux.setResponses(Array.from({ length: 40 }, () => factory));
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  if (captured === undefined) throw new Error("the conversation made no model request");
  return captured;
}

/** A conversation that is not the root, with an agent record of `kind` and those roles. */
async function makeAgent(
  test: TestHarness,
  kind: "subagent" | "scheduled",
  roles: readonly string[],
): Promise<Conversation> {
  const model = test.faux.getModel();
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
      },
    },
    CTX,
  );
}

/** Run one tool call in `conversation` and return the tool results it added. */
async function toolResultOf(
  test: TestHarness,
  conversation: Conversation,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const before = await conversation.entries({ order: "ascending" }, 500, undefined, CTX);
  const lastId = before.items.at(-1)?.id ?? 0;
  test.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])),
  ]);
  const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
  await submission.wait(CTX);
  const after = await conversation.entries(
    { minEntryId: (lastId + 1) as never, order: "ascending" },
    500,
    undefined,
    CTX,
  );
  return after.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .map(entryText)
    .join("\n");
}

describe("personality and language-rule sections", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  for (const document of DOCUMENTS) {
    it(`scopes the sections by agent kind: ${document.name}`, async () => {
      harness = await createTestHarness();
      await writePersonality(harness, document.text);
      const root = await resolveDefaultConversation(
        harness.runtime.harness,
        harness.config,
        harness.runtime.paths,
        CTX,
      );
      const orchestrator = await makeAgent(harness, "subagent", ["orchestrator"]);
      const planner = await makeAgent(harness, "subagent", ["planner"]);
      const focused = await makeAgent(harness, "focused", []);
      const worker = await makeAgent(harness, "subagent", ["worker"]);
      const scheduled = await makeAgent(harness, "scheduled", []);

      const heads = {
        root: collapsedHead(await firstRequest(harness, root, "hello")),
        orchestrator: collapsedHead(await firstRequest(harness, orchestrator, "hello", { park: true })),
        planner: collapsedHead(await firstRequest(harness, planner, "hello", { park: true })),
        focused: collapsedHead(await firstRequest(harness, focused, "hello", { park: true })),
        worker: collapsedHead(await firstRequest(harness, worker, "hello", { park: true })),
        scheduled: collapsedHead(await firstRequest(harness, scheduled, "hello")),
      };

      // The English writing rules reach every agent, whatever language it writes in.
      for (const head of Object.values(heads)) {
        expect(head).toContain("<simple-english>");
        expect(head).toContain(SIMPLE_ENGLISH);
      }

      // The root gets the root's introduction; an orchestrator gets its own.
      expect(heads.root).toContain("<personality>");
      expect(heads.root).toContain(PERSONALITY_INTRO_ROOT[document.language]);
      expect(heads.root).not.toContain(PERSONALITY_INTRO_ORCHESTRATOR[document.language]);
      // The body follows the introduction with nothing in between: front matter
      // that reached the section would sit right there.
      expect(heads.root).toContain(`${PERSONALITY_INTRO_ROOT[document.language]}\n\n${parsePersonality(document.text)!.body}`);

      expect(heads.orchestrator).toContain("<personality>");
      expect(heads.orchestrator).toContain(PERSONALITY_INTRO_ORCHESTRATOR[document.language]);
      expect(heads.orchestrator).not.toContain(PERSONALITY_INTRO_ROOT[document.language]);
      expect(heads.orchestrator).toContain(document.body);

      // A focused chat talks with the user too, so it gets the personality with
      // its own introduction.
      expect(heads.focused).toContain("<personality>");
      expect(heads.focused).toContain(PERSONALITY_INTRO_FOCUSED[document.language]);

      // A worker and a scheduled run get no personality: its voice would reach
      // instructions that no person reads as conversation. A planner writes no
      // text the user reads, so it gets none either.
      for (const head of [heads.worker, heads.scheduled, heads.planner]) {
        expect(head).not.toContain("<personality>");
      }

      // `fluent-korean` is about Korean words, so every agent that writes Korean
      // receives it, whatever its scope, and no agent receives it otherwise. A
      // planner is the exception: it writes its working document in English.
      for (const [name, head] of Object.entries(heads)) {
        if (document.language === "ko" && name !== "planner") {
          expect(head).toContain("<fluent-korean>");
          expect(head).toContain(FLUENT_KOREAN);
        } else {
          expect(head).not.toContain("<fluent-korean>");
        }
      }

      // `agent-language` is the worker's, the scheduled run's and the planner's
      // own section. The other three read the same rule in their personality
      // introduction, so the section stays out of theirs.
      for (const head of [heads.worker, heads.scheduled, heads.planner]) {
        if (document.language === "ko") {
          expect(head).toContain("<agent-language>");
          expect(head).toContain(AGENT_LANGUAGE_KO);
        } else {
          expect(head).not.toContain("<agent-language>");
        }
      }
      for (const head of [heads.root, heads.focused, heads.orchestrator]) {
        expect(head).not.toContain("<agent-language>");
      }
    });
  }

  it("gives the Korean sections to no scope while no personality is registered", async () => {
    harness = await createTestHarness({ config: NO_INTERVIEW });
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const orchestrator = await makeAgent(harness, "subagent", ["orchestrator"]);
    const focused = await makeAgent(harness, "focused", []);
    const worker = await makeAgent(harness, "subagent", ["worker"]);
    const scheduled = await makeAgent(harness, "scheduled", []);

    const heads = [
      collapsedHead(await firstRequest(harness, root, "hello")),
      collapsedHead(await firstRequest(harness, orchestrator, "hello", { park: true })),
      collapsedHead(await firstRequest(harness, focused, "hello", { park: true })),
      collapsedHead(await firstRequest(harness, worker, "hello", { park: true })),
      collapsedHead(await firstRequest(harness, scheduled, "hello")),
    ];

    // Both sections name a language, and the file that names it is what decides
    // them. The English writing rules are the only ones that do not need it.
    for (const head of heads) {
      expect(head).toContain("<simple-english>");
      expect(head).not.toContain("<fluent-korean>");
      expect(head).not.toContain("<agent-language>");
    }
  });

  it("keeps a name line out of the prompt, and leaves the language decision alone", async () => {
    harness = await createTestHarness();
    await writePersonality(harness, "---\nlanguage: ko\nname: 테스트봇\n---\n# 인물\n\n따뜻하게 말합니다.\n");
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const head = collapsedHead(await firstRequest(harness, root, "안녕하세요"));

    expect(head).toContain(`${PERSONALITY_INTRO_ROOT.ko}\n\n# 인물\n\n따뜻하게 말합니다.`);
    // The metadata stays metadata: no marker, no key line, no name line.
    expect(head).not.toContain("name: 테스트봇");
    expect(head).not.toContain("language: ko");
    // The extra key line does not change which language the document names.
    expect(head).toContain("<fluent-korean>");
  });

  it("says nothing about a personality while none is registered", async () => {
    harness = await createTestHarness({ config: NO_INTERVIEW });
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const head = collapsedHead(await firstRequest(harness, root, "hello"));

    expect(head).toContain("<simple-english>");
    expect(head).not.toContain("<personality>");
    expect(head).not.toContain("<fluent-korean>");
  });

  it("takes the orchestrator roles from `personality.roles`", async () => {
    harness = await createTestHarness({
      config: { personality: { file: "memory/personality.md", interview: false, roles: ["lead"] } },
    });
    await writePersonality(harness, DOCUMENTS[0]!.text);

    const lead = await makeAgent(harness, "subagent", ["lead"]);
    const orchestrator = await makeAgent(harness, "subagent", ["orchestrator"]);

    const leadHead = collapsedHead(await firstRequest(harness, lead, "hello", { park: true }));
    const orchestratorHead = collapsedHead(await firstRequest(harness, orchestrator, "hello", { park: true }));

    expect(leadHead).toContain("<personality>");
    expect(leadHead).toContain(PERSONALITY_INTRO_ORCHESTRATOR.en);
    // The default role name no longer counts, so this one reads as a worker.
    expect(orchestratorHead).not.toContain("<personality>");
  });

  it("reads the document's front matter, and English when it names no language", () => {
    const named = parsePersonality("---\nlanguage: ko\n---\n# 제목\n\n본문\n");
    expect(named).toEqual({ language: "ko", languageNamed: true, body: "# 제목\n\n본문" });

    // No front matter, an unknown language, and a block that is not three lines:
    // all of them are English, and each keeps its whole text as the body.
    for (const text of ["# 제목\n\n본문\n", "---\nlanguage: fr\n---\n# 제목\n\n본문\n"]) {
      expect(parsePersonality(text)).toEqual({ language: "en", languageNamed: false, body: "# 제목\n\n본문" });
    }
    expect(parsePersonality("---\nlanguage: ko\n# 제목\n\n본문\n")).toEqual({
      language: "en",
      languageNamed: false,
      body: "---\nlanguage: ko\n# 제목\n\n본문",
    });

    // A document that is only whitespace reads as none at all.
    expect(parsePersonality("---\nlanguage: ko\n---\n\n")).toBeUndefined();
    expect(parsePersonality("\n\n")).toBeUndefined();

    // The file form is the front matter and the body, and it reads back the same.
    expect(renderPersonalityFile("ko", "# 제목")).toBe("---\nlanguage: ko\n---\n# 제목\n");
    expect(parsePersonality(renderPersonalityFile("en", "# Title"))?.body).toBe("# Title");

    // A pasted document drops its own front matter; the argument decides.
    expect(personalityBodyOf("---\nlanguage: ko\n---\n# Title\n")).toBe("# Title");
    expect(personalityBodyOf("# Title\n")).toBe("# Title");
  });

  it("reads the name line in a front matter of one, two or three key lines", () => {
    // Three lines, as this release wrote them before the name line existed.
    expect(parsePersonality("---\nlanguage: ko\n---\n# 제목\n\n본문\n")).toEqual({
      language: "ko",
      languageNamed: true,
      body: "# 제목\n\n본문",
    });

    // Four lines, in both key orders.
    for (const keys of ["language: ko\nname: 테스트봇", "name: 테스트봇\nlanguage: ko"]) {
      expect(parsePersonality(`---\n${keys}\n---\n# 제목\n\n본문\n`)).toEqual({
        language: "ko",
        languageNamed: true,
        name: "테스트봇",
        body: "# 제목\n\n본문",
      });
    }

    // A front matter that names only the name reads the language as English.
    expect(parsePersonality("---\nname: 테스트봇\n---\n# 제목\n\n본문\n")).toEqual({
      language: "en",
      languageNamed: false,
      name: "테스트봇",
      body: "# 제목\n\n본문",
    });

    // The value is trimmed, and an empty value is no name at all.
    expect(parsePersonality("---\nlanguage: ko\nname:   테스트봇  \n---\n# 제목\n")?.name).toBe("테스트봇");
    expect(parsePersonality("---\nlanguage: ko\nname:\n---\n# 제목\n")).toEqual({
      language: "ko",
      languageNamed: true,
      body: "# 제목",
    });

    // A key line this release does not read makes the whole block text, as it
    // was before the name line existed: the file is never half understood.
    expect(parsePersonality("---\nversion: 2\nlanguage: ko\n---\n# 제목\n")).toEqual({
      language: "en",
      languageNamed: false,
      body: "---\nversion: 2\nlanguage: ko\n---\n# 제목",
    });
    expect(parsePersonality("---\nlanguage: ko\nname: 이해\nname: 다른이름\n---\n# 제목\n")?.languageNamed).toBe(false);
  });

  it("strips a three-line block whose middle line it does not read", () => {
    // A three-line block was front matter before the name line existed, whatever
    // its middle line said: the marker pair decided it, and a line this release
    // does not read leaves the language at English. A file written then must
    // read as it read then.
    expect(parsePersonality("---\nfoo: bar\n---\n# Doc\n\nBody\n")).toEqual({
      language: "en",
      languageNamed: false,
      body: "# Doc\n\nBody",
    });
    // A `language` line with no value is no language, and the block is still
    // stripped: the value is what a person omits, not the line.
    expect(parsePersonality("---\nlanguage:\n---\n# Doc\n")).toEqual({
      language: "en",
      languageNamed: false,
      body: "# Doc",
    });

    // The body a caller registers drops the same block, so those three lines can
    // never be written into the body of the next document.
    expect(personalityBodyOf("---\nfoo: bar\n---\n# Doc\n")).toBe("# Doc");
    expect(personalityBodyOf("---\nlanguage:\n---\n# Doc\n")).toBe("# Doc");
  });

  it("writes the name line only when it is given, and never inside the body", () => {
    expect(renderPersonalityFile("ko", "# 제목")).toBe("---\nlanguage: ko\n---\n# 제목\n");
    expect(renderPersonalityFile("ko", "# 제목", "테스트봇")).toBe("---\nlanguage: ko\nname: 테스트봇\n---\n# 제목\n");
    // An empty name is no name: the file keeps the three-line front matter.
    expect(renderPersonalityFile("ko", "# 제목", "")).toBe("---\nlanguage: ko\n---\n# 제목\n");

    expect(parsePersonality(renderPersonalityFile("en", "# Title", "Alice"))).toEqual({
      language: "en",
      languageNamed: true,
      name: "Alice",
      body: "# Title",
    });

    // A pasted document drops a four-line front matter as well, so a name line
    // can never be written into the body of the next document.
    expect(personalityBodyOf("---\nlanguage: ko\nname: 테스트봇\n---\n# 제목\n")).toBe("# 제목");
  });

  it("resolves the file under the home, or wherever an absolute path points", () => {
    expect(personalityPath({ home: "/srv/persona" }, "memory/personality.md")).toBe("/srv/persona/memory/personality.md");
    expect(personalityPath({ home: "/srv/persona" }, "")).toBe("/srv/persona/memory/personality.md");
    expect(personalityPath({ home: "/srv/persona" }, "/etc/persona.md")).toBe("/etc/persona.md");
  });
});

describe("the design interview", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  // Each language's directive opens with its own marker line.
  const MARKERS = { en: "[pi-sec · no personality registered yet]", ko: "[pi-sec · 아직 personality 가 등록되지 않았습니다]" };

  it("opens in Korean when the user's first message is Korean", async () => {
    harness = await createTestHarness();
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    // The submitted text arrives inside the `<pi-message ...>` envelope, which is
    // written in Latin letters: the count must ignore it or a short Korean
    // message would read as English.
    const messages = await firstRequest(harness, root, "안녕하세요, 방금 설치했어요");
    const directive = messages.filter((message) => message.role === "system").map(messageText).join("\n");

    expect(directive).toContain(MARKERS.ko);
    expect(directive).toContain(INTERVIEW.ko);
    expect(directive).not.toContain(INTERVIEW.en);
  });

  it("opens in English when the user's first message is English", async () => {
    harness = await createTestHarness();
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const messages = await firstRequest(harness, root, "Hi, I just installed this");
    const directive = messages.filter((message) => message.role === "system").map(messageText).join("\n");

    expect(directive).toContain(MARKERS.en);
    expect(directive).toContain(INTERVIEW.en);
    expect(directive).not.toContain(INTERVIEW.ko);
  });

  it("counts the two scripts, and leaves the envelope out of the count", () => {
    expect(scriptCounts("안녕하세요")).toEqual({ hangul: 5, latin: 0 });
    expect(scriptCounts("hello")).toEqual({ hangul: 0, latin: 5 });

    const user = (content: string): Message => ({ role: "user", content, timestamp: 0 }) as Message;
    expect(interviewLanguage([user("안녕하세요, 방금 설치했어요")])).toBe("ko");
    expect(interviewLanguage([user("Hi, I just installed this")])).toBe("en");
    // A Korean sentence that quotes English words stays Korean.
    expect(interviewLanguage([user("이 도구의 personality 설정을 바꿔 주세요")])).toBe("ko");
    // A tie is not a Korean majority.
    expect(interviewLanguage([user("hello 안녕")])).toBe("en");
    // The envelope's own tag and attributes are Latin letters; ignoring them is
    // what keeps a short Korean message Korean.
    expect(interviewLanguage([user('<pi-message src="operator">\n안녕\n</pi-message>')])).toBe("ko");
    expect(interviewLanguage([user('<agent-message from="parent">\n안녕하세요\n</agent-message>')])).toBe("ko");
    // No user message at all reads as English.
    expect(interviewLanguage([])).toBe("en");
  });

  it("does not run once a personality is registered", async () => {
    harness = await createTestHarness();
    await writePersonality(harness, DOCUMENTS[1]!.text);
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const messages = await firstRequest(harness, root, "안녕하세요");

    expect(systemText(messages)).not.toContain(MARKERS.en);
    expect(systemText(messages)).not.toContain(MARKERS.ko);
  });

  it("does not run once the conversation has an answer in it", async () => {
    harness = await createTestHarness();
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    await firstRequest(harness, root, "hello");
    const messages = await firstRequest(harness, root, "hello again");

    expect(systemText(messages)).not.toContain(MARKERS.en);
    expect(systemText(messages)).not.toContain(MARKERS.ko);
  });

  it("does not run when the interview is switched off", async () => {
    harness = await createTestHarness({ config: NO_INTERVIEW });
    const root = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const messages = await firstRequest(harness, root, "hello");

    expect(systemText(messages)).not.toContain(MARKERS.en);
    expect(systemText(messages)).not.toContain(MARKERS.ko);
  });

  it("never runs in a subagent or a scheduled run", async () => {
    harness = await createTestHarness();
    const subagent = await makeAgent(harness, "subagent", ["worker"]);
    const scheduled = await makeAgent(harness, "scheduled", []);

    const subagentText = systemText(await firstRequest(harness, subagent, "안녕하세요", { park: true }));
    const scheduledText = systemText(await firstRequest(harness, scheduled, "안녕하세요"));

    expect(subagentText).not.toContain(MARKERS.en);
    expect(subagentText).not.toContain(MARKERS.ko);
    expect(scheduledText).not.toContain(MARKERS.en);
    expect(scheduledText).not.toContain(MARKERS.ko);
  });
});

describe("the personality tools", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function root(test: TestHarness): Promise<Conversation> {
    return await resolveDefaultConversation(test.runtime.harness, test.config, test.runtime.paths, CTX);
  }

  it("keeps `personality_set` off a subagent and a scheduled run", async () => {
    // The selection: both lists remove it, and the scheduled list inherits it.
    expect(SUBAGENT_TOOL_REMOVALS).toContain("personality_set");
    expect(SCHEDULED_TOOL_REMOVALS).toContain("personality_set");
    // Reading stays open to everyone.
    expect(SUBAGENT_TOOL_REMOVALS).not.toContain("personality_get");

    // The live gate: a conversation whose stored selection still offers the tool
    // is blocked when it calls it.
    harness = await createTestHarness();
    const subagent = await makeAgent(harness, "subagent", ["worker"]);
    const subagentResult = await toolResultOf(harness, subagent, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "en",
    });
    expect(subagentResult).toContain("`personality_set` is not available to a subagent agent");
    expect(subagentResult).toContain("It is for: root");

    const scheduled = await makeAgent(harness, "scheduled", []);
    const scheduledResult = await toolResultOf(harness, scheduled, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "en",
    });
    expect(scheduledResult).toContain("`personality_set` is not available to a scheduled agent");
    // Nothing was written either way.
    await expect(readFile(personalityFile(harness), "utf8")).rejects.toThrow();
  });

  it("refuses a call with no language, or one outside the two", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);

    const missing = await toolResultOf(harness, conversation, "personality_set", { content: "# Persona\n\nWarm." });
    expect(missing).toContain('Refused: `language` must be "en" or "ko"');

    const wrong = await toolResultOf(harness, conversation, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "fr",
    });
    expect(wrong).toContain('Refused: `language` must be "en" or "ko"');
    await expect(readFile(personalityFile(harness), "utf8")).rejects.toThrow();
  });

  it("keeps the old document checks", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);

    const empty = await toolResultOf(harness, conversation, "personality_set", { content: "  ", language: "en" });
    expect(empty).toContain("Refused: the personality document is empty.");

    const long = await toolResultOf(harness, conversation, "personality_set", {
      content: `# Persona\n\n${"x".repeat(8001)}`,
      language: "en",
    });
    expect(long).toContain("is over the 8000 limit");

    const headingless = await toolResultOf(harness, conversation, "personality_set", {
      content: "Warm and plain, with no title.",
      language: "en",
    });
    expect(headingless).toContain("Refused: no markdown heading found.");
  });

  it("writes the front matter, and answers differently the first time", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);
    const path = personalityFile(harness);

    const first = await toolResultOf(harness, conversation, "personality_set", {
      content: "---\nlanguage: en\n---\n# 인물\n\n따뜻하게 말합니다.",
      language: "ko",
    });
    // A pasted front matter is dropped, and the argument decides the language.
    expect(await readFile(path, "utf8")).toBe("---\nlanguage: ko\n---\n# 인물\n\n따뜻하게 말합니다.\n");
    const body = "# 인물\n\n따뜻하게 말합니다.";
    expect(first).toContain(
      PERSONALITY_SET_FIRST.replace("<n>", String(body.length))
        .replace("<en|ko>", "ko")
        .replace("<path>", path)
        .replace("<name>", "no name"),
    );
    expect(first).toContain("This is the first personality of this installation");

    const second = await toolResultOf(harness, conversation, "personality_set", {
      content: "# Persona\n\nWarm and plain.",
      language: "en",
    });
    expect(await readFile(path, "utf8")).toBe("---\nlanguage: en\n---\n# Persona\n\nWarm and plain.\n");
    const replacedBody = "# Persona\n\nWarm and plain.";
    expect(second).toContain(
      PERSONALITY_SET_REPLACED.replace("<n>", String(replacedBody.length))
        .replace("<en|ko>", "en")
        .replace("<path>", path)
        .replace("<name>", "no name"),
    );
    expect(second).not.toContain("This is the first personality of this installation");
  });

  it("reads the personality back in the three result shapes", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);
    const path = personalityFile(harness);

    const none = await toolResultOf(harness, conversation, "personality_get", {});
    expect(none).toContain(PERSONALITY_GET_NONE.replace("<path>", path));

    // A document with no front matter names no language, so English applies.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "# Persona\n\nWarm and plain, with a longer body.\n", "utf8");
    const unnamed = await toolResultOf(harness, conversation, "personality_get", {});
    expect(unnamed).toContain(
      "Language: en (the document names no language, so English applies)\n\n# Persona\n\nWarm and plain, with a longer body.",
    );

    await writeFile(path, "---\nlanguage: ko\n---\n# 인물\n\n따뜻하게 말합니다.\n", "utf8");
    const named = await toolResultOf(harness, conversation, "personality_get", {});
    expect(named).toContain("Language: ko\n\n# 인물\n\n따뜻하게 말합니다.");
  });

  it("sets, keeps and clears the name, and reports it in the result", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);
    const path = personalityFile(harness);

    const named = await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n따뜻하게 말합니다.",
      language: "ko",
      name: "테스트봇",
    });
    expect(await readFile(path, "utf8")).toBe("---\nlanguage: ko\nname: 테스트봇\n---\n# 인물\n\n따뜻하게 말합니다.\n");
    expect(named).toContain("name 테스트봇");

    // The argument left out keeps the registered name: a replacement of the body
    // is not a request to rename the agent.
    const kept = await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n한결 더 따뜻하게 말합니다.",
      language: "ko",
    });
    expect(await readFile(path, "utf8")).toBe(
      "---\nlanguage: ko\nname: 테스트봇\n---\n# 인물\n\n한결 더 따뜻하게 말합니다.\n",
    );
    expect(kept).toContain("name 테스트봇");

    // An empty string removes it, and the result says there is no name.
    const cleared = await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n한결 더 따뜻하게 말합니다.",
      language: "ko",
      name: "",
    });
    expect(await readFile(path, "utf8")).toBe("---\nlanguage: ko\n---\n# 인물\n\n한결 더 따뜻하게 말합니다.\n");
    expect(cleared).toContain("name no name");

    // A name is trimmed before it is written.
    const trimmed = await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n한결 더 따뜻하게 말합니다.",
      language: "ko",
      name: "  테스트봇  ",
    });
    expect(await readFile(path, "utf8")).toContain("\nname: 테스트봇\n");
    expect(trimmed).toContain("name 테스트봇");
  });

  it("refuses a name with a line break, and one over 40 characters", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);
    const path = personalityFile(harness);

    const broken = await toolResultOf(harness, conversation, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "en",
      name: "one\ntwo",
    });
    expect(broken).toContain("Refused: `name` must be on one line");

    const long = await toolResultOf(harness, conversation, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "en",
      name: "가".repeat(41),
    });
    expect(long).toContain("`name` is 41 characters, over the 40 limit");
    // Both refused calls wrote nothing.
    await expect(readFile(path, "utf8")).rejects.toThrow();

    // The limit counts code points, not bytes: 40 Korean letters are accepted.
    const accepted = await toolResultOf(harness, conversation, "personality_set", {
      content: "# Persona\n\nWarm.",
      language: "en",
      name: "가".repeat(40),
    });
    expect(accepted).toContain(`name ${"가".repeat(40)}`);
  });

  it("shows the name line right after the language line", async () => {
    harness = await createTestHarness();
    const conversation = await root(harness);
    const path = personalityFile(harness);

    await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n따뜻하게 말합니다.",
      language: "ko",
      name: "테스트봇",
    });
    const named = await toolResultOf(harness, conversation, "personality_get", {});
    expect(named).toContain("Language: ko\nName: 테스트봇\n\n# 인물\n\n따뜻하게 말합니다.");

    // The name line is absent, not empty, when the file names none.
    const unnamed = await toolResultOf(harness, conversation, "personality_set", {
      content: "# 인물\n\n따뜻하게 말합니다.",
      language: "ko",
      name: "",
    });
    expect(unnamed).toContain("name no name");
    const read = await toolResultOf(harness, conversation, "personality_get", {});
    expect(read).toContain("Language: ko\n\n# 인물\n\n따뜻하게 말합니다.");
    expect(read).not.toContain("Name:");
  });
});

describe("the personality settings", () => {
  it("loads a config file that names none of the new keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-personality-config-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ server: { port: 9000 } }), "utf8");

    const loaded = await loadConfig({ home, env: {} });
    expect(loaded.config.server.port).toBe(9000);
    expect(loaded.config.personality).toEqual({
      file: "memory/personality.md",
      interview: true,
      // An orchestrator writes the reports a person reads, so it takes the
      // personality's language and writing rules by default. A planner writes no
      // text the user reads, and the planner scope is read from its role name.
      roles: ["orchestrator"],
    });
  });

  it("names both extensions in the default enabled list", () => {
    const enabled = defaultConfig().agent.extensions.enabled;
    expect(enabled).toContain("language-rules");
    expect(enabled).toContain("personality");
    // `read-full` stays opt-in.
    expect(enabled).not.toContain("read-full");
  });

  it("keeps the five prompt extensions in section order", () => {
    // Install order is section order, and the order is the one the runtime
    // extensions had: conventions, language-rules, message-tags, personality,
    // read-full.
    const names = BUNDLED_EXTENSIONS.map((extension) => extension.name);
    const prompt = ["conventions", "language-rules", "message-tags", "personality", "read-full"];
    const positions = prompt.map((name) => names.indexOf(name));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const name of prompt) {
      expect(BUNDLED_EXTENSIONS[names.indexOf(name)]?.phase).toBe("app");
    }
  });
});

describe("the personality file on disk", () => {
  it("writes one file twice at once and leaves one whole document and no temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personality-race-"));
    const path = join(directory, "personality.md");
    await Promise.all([
      writePersonalityFile(path, "en", "first document\n"),
      writePersonalityFile(path, "en", "second document\n"),
    ]);
    const text = await readFile(path, "utf8");
    expect(["first document", "second document"].filter((body) => text.includes(body))).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
