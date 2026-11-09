import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AnyModel,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { AgentDoc, type Conversation, type EntryRecord, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import { CONVENTIONS_TEXT } from "../src/extensions/conventions-text.ts";
import {
  COMMON_SYLLABLES,
  REPORT_CHECK_QUESTIONS,
  REPORT_CHECK_UNCHECKED_ITEMS,
  checkCells,
  checkHashes,
  checkIds,
  checkRefs,
  checkSyllables,
  programFindings,
  scanTables,
} from "../src/extensions/reports.ts";
import { SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { PERSONALITY_INTRO_ORCHESTRATOR } from "../src/extensions/personality-texts.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `report_check`: the orchestrator's quick self-test of a draft.
 *
 * The tool checks the 13 items of the report rules in three ways. One judge call
 * asks seven of them, each as an item of its own: 1, 2, 3, 4, 5, 9 and 10. A
 * program checks item 10 again (a reference whose place is missing), and items 11,
 * 12 and 13, and every table. Items 6, 7 and 8 are checked by nothing here. Its
 * answer marks each item whose probability of yes is below the review threshold —
 * the judge entry's `reviewBelow`, and 0.95 without one — with the number, the
 * question and the probability, names each program finding with its item and its
 * line, and names each table whose second line is not a delimiter row. A mark is
 * not a failure: the orchestrator judges it and the root decides.
 *
 * Only an orchestrator has the tool. The stored tool filter is written when a
 * conversation is created, so the live gate is a `beforeTool` hook, and this file
 * drives a real conversation of each role through it rather than calling the hook.
 *
 * The judge here is a fake HTTP function: the tool's judgement goes to the
 * Decisions API client in `src/judges-openai-decisions.ts`, so no network call is
 * made and no credential is needed. The catalog is a real pi-ai `Models`
 * collection, and its classifier implementation fails the test if pi-sec ever
 * routes a judgement through pi-ai.
 */

const CTX = BACKGROUND_CONTEXT;
const JUDGE_PROVIDER = "test-judge-provider";
const JUDGE_MODEL = "test-judge";

type ToolResult = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
  readonly details?: unknown;
};

/** The tool-tag shape the registry hands out: `execute` with the live context. */
type ToolLike = {
  execute: (args: never, api: ToolExecutionApi, context: typeof CTX) => Promise<ToolResult>;
};

function textOf(result: ToolResult): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** The text of the question of one item number, as the tool prints it. */
function questionOf(n: number): string {
  const found = REPORT_CHECK_QUESTIONS.find((question) => question.n === n);
  if (found === undefined) throw new Error(`no question for item ${n}`);
  return found.text;
}

/** A classifier entry: the shape `getModelOfType("classifier", …)` returns. */
function classifierModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
  return {
    id,
    name: id,
    api: "openai-decisions",
    provider,
    baseUrl: "https://judges.invalid",
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 }],
    },
    contextWindow: 100000,
    type: "classifier",
  };
}

/** A chat model of the same name, which a judge must never reach. */
function chatModel(provider: string, id: string): Model<"test-chat"> {
  return {
    id,
    name: id,
    api: "test-chat",
    provider,
    baseUrl: "https://judges.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    reasoning: false,
    type: "chat",
  };
}

/** One HTTP request the judge sent. */
interface JudgeRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: {
    readonly model?: string;
    readonly input?: string;
    readonly questions?: readonly { readonly type: string; readonly name: string; readonly instructions: string }[];
  };
}

interface FakeJudge {
  /** Every HTTP request the judge sent, in order. */
  readonly requests: JudgeRequest[];
  /** Every context the pi-ai classifier was given. A judge must leave this empty. */
  readonly classified: ClassifierContext[];
  /** Every chat model id that was streamed. A judge must leave this empty. */
  readonly streamed: string[];
}

/** Put the fake HTTP function where the judge reads it, and take it out after the test. */
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function useFetch(fake: typeof globalThis.fetch): void {
  const previous = globalThis.fetch;
  globalThis.fetch = fake;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
}

/** A JSON reply. */
function jsonReply(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers });
}

/**
 * Register a fake judge provider on the harness catalog, and a fake HTTP function
 * for its call.
 *
 * `probabilities` maps a question key (`q6`) to the probability of yes; a key it
 * does not name answers 0.99. `refused` names the keys the service refuses to
 * answer. `replies` replaces the whole HTTP answer, which is how the tests make
 * the provider fail.
 */
function registerJudge(
  harness: TestHarness,
  probabilities: Record<string, number> = {},
  options: {
    readonly refused?: readonly string[];
    readonly replies?: readonly (() => Response)[];
    readonly credentials?: boolean;
  } = {},
): FakeJudge {
  const requests: JudgeRequest[] = [];
  const classified: ClassifierContext[] = [];
  const streamed: string[] = [];
  harness.models.setProvider(
    createProvider({
      id: JUDGE_PROVIDER,
      auth: {
        apiKey: {
          name: "test judge key",
          resolve: async () => (options.credentials === false ? undefined : { auth: { apiKey: "sk-test-judge-key" } }),
        },
      },
      models: [classifierModel(JUDGE_PROVIDER, JUDGE_MODEL), chatModel(JUDGE_PROVIDER, JUDGE_MODEL)],
      api: {
        stream: (model: AnyModel) => {
          streamed.push(model.id);
          throw new Error(`a judge streamed chat model ${model.id}`);
        },
        streamSimple: (model: AnyModel) => {
          streamed.push(model.id);
          throw new Error(`a judge streamed chat model ${model.id}`);
        },
      },
      classifiers: {
        "openai-decisions": {
          classify: (model, context) => {
            classified.push(context);
            throw new Error(`pi-sec sent ${model.id} through the pi-ai classifier`);
          },
        },
      },
    }),
  );
  const refused = new Set(options.refused ?? []);
  useFetch((async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as JudgeRequest["body"];
    requests.push({ headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (options.replies !== undefined) {
      const reply = options.replies[Math.min(requests.length - 1, options.replies.length - 1)];
      if (reply === undefined) throw new Error("the fake was given no reply");
      return await reply();
    }
    return new Response(
      JSON.stringify({
        model: JUDGE_MODEL,
        answers: (body.questions ?? []).map((question) =>
          refused.has(question.name)
            ? { type: "refusal", name: question.name }
            : { type: "predicate", name: question.name, probability: probabilities[question.name] ?? 0.99 },
        ),
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch);
  return { requests, classified, streamed };
}

function configWith(judges: Config["judges"]): Partial<Config> {
  return { judges };
}

/** A temporary markdown file, so a check can be given a path. */
async function scratchFile(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sec-report-check-"));
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}

describe("report rules and the table check", () => {
  it("asks seven items, numbered 1, 2, 3, 4, 5, 9 and 10, each one distinct", () => {
    expect(REPORT_CHECK_QUESTIONS.map((question) => question.n)).toEqual([1, 2, 3, 4, 5, 9, 10]);
    expect(new Set(REPORT_CHECK_QUESTIONS.map((question) => question.text)).size).toBe(7);
    for (const question of REPORT_CHECK_QUESTIONS) expect(question.text.trim().length).toBeGreaterThan(10);
    expect(REPORT_CHECK_UNCHECKED_ITEMS).toEqual([6, 7, 8]);
  });

  it("counts a table whose second line is not a delimiter row", () => {
    const text = ["# t", "", "| a | b |", "| c | d |", "", "| e | f |", "|---|---|", ""].join("\n");
    expect(scanTables(text)).toEqual({ found: 2, withoutDelimiter: [3] });
  });

  it("does not count a table inside a fenced code block", () => {
    const text = ["```text", "| a | b |", "| c | d |", "```", "", "| e | f |", "|---|---|", "| g | h |", ""].join("\n");
    expect(scanTables(text)).toEqual({ found: 1, withoutDelimiter: [] });
  });

  it("closes a fence only on a fence of the same character and length", () => {
    // A four-backtick block holds a three-backtick line; the table after both
    // fences is the only one counted.
    const text = ["````markdown", "```js", "| a | b |", "```", "````", "", "| e | f |", "| :-- | --: |"].join("\n");
    expect(scanTables(text)).toEqual({ found: 1, withoutDelimiter: [] });
  });

  it("reports a table that ends the document with no second line", () => {
    expect(scanTables("text\n\n| a | b |")).toEqual({ found: 1, withoutDelimiter: [3] });
  });
});

describe("the program checks of items 10 to 14", () => {
  /** A document with headings 3 and 3.2, and appendix A, all above any finding. */
  const HEADINGS = ["# 계획", "", "## 3. 바꾸는 것", "", "## 3.2 질문", ""];

  it("item 10: finds a reference to a section or an appendix that does not exist", () => {
    const text = [...HEADINGS, "3.2절을 보십시오.", "", "12.3절과 부록 F 를 보십시오.", ""].join("\n");
    expect(checkRefs(text)).toEqual([
      { line: 9, text: "12.3절" },
      { line: 9, text: "부록 F" },
    ]);
  });

  it("item 10: passes a reference whose target exists, in the body and in an appendix", () => {
    const text = [...HEADINGS, "3.2절을 보십시오.", "", "## 부록 A. 질문", "", "부록 A 를 읽으십시오.", ""].join("\n");
    expect(checkRefs(text)).toEqual([]);
  });

  it("item 10: skips a reference to another document, and a reference joined to it", () => {
    // Each of these names the other document before the number, in its own way.
    const other = [
      "분석 리포트 4.3절을 보십시오.",
      "`docs/install.md` 4.2절과 4.3절을 보십시오.",
      "조사 노트 4.5절을 보십시오.",
      "리포트(다른 문서)의 10절과 같습니다.",
      "로드맵 2.1.2절을 보십시오.",
    ];
    const text = [...HEADINGS, ...other, ""].join("\n");
    expect(checkRefs(text)).toEqual([]);
    // The rule is a shape, not a list of documents: a reference with no document
    // name before it is still reported.
    expect(checkRefs([...HEADINGS, "4.3절을 보십시오.", ""].join("\n"))).toEqual([{ line: 7, text: "4.3절" }]);
  });

  it("item 10: does not read a heading, a quote, or an inline code span as a reference", () => {
    const text = [...HEADINGS, "`4.3절` 은 코드입니다.", "> 7절은 인용입니다.", "## 8. 9절이라는 제목", ""].join("\n");
    expect(checkRefs(text)).toEqual([]);
  });

  it("item 10: reads no line inside a fenced code block", () => {
    const text = [...HEADINGS, "```text", "12.3절", "```", ""].join("\n");
    expect(checkRefs(text)).toEqual([]);
  });

  it("item 12: finds a hex value in the body, and not in an appendix or a fence", () => {
    const text = [
      "# 계획", // 1
      "", // 2
      "커밋 1a2b3c4 입니다.", // 3
      "", // 4
      "```text", // 5
      "abcdef1234567", // 6
      "```", // 7
      "", // 8
      "## 부록 A. 해시", // 9
      "", // 10
      "fedcba9876543", // 11
      "", // 12
    ].join("\n");
    expect(checkHashes(text)).toEqual([{ line: 3, text: "1a2b3c4" }]);
  });

  it("item 12: does not read a digit-only value, which is a date", () => {
    expect(checkHashes("# 계획\n\n20261020 에 열었습니다.\n")).toEqual([]);
  });

  it("item 12: finds a sha256, and passes a word that only looks like one", () => {
    const sha = "9f8e7d6c5b4a3021324567890abcdef0123456789abcdef0123456789abcdef0";
    expect(checkHashes(`# 계획\n\n${sha}\n`)).toEqual([{ line: 3, text: sha }]);
    // A longer word that holds a hex run is not a value of its own.
    expect(checkHashes("# 계획\n\nzz1a2b3c4zz\n")).toEqual([]);
  });

  it("item 11: finds a paragraph that is mostly identifiers, and passes one that is not", () => {
    const crowded = "`a` `b` `c` `d` `e` `f` `g` `h` `i` `j` 는 열 개의 코드입니다.";
    const text = ["# 계획", "", crowded, "", "짧은 문단 `x` 하나.", ""].join("\n");
    expect(checkIds(text)).toEqual([{ line: 3, ids: 10, share: 0.57 }]);
    // Nine identifiers are below the count, and a long paragraph is below the share.
    expect(checkIds("# 계획\n\n`a` `b` `c` `d` `e` `f` `g` `h` `i` 는 아홉 개입니다.\n")).toEqual([]);
  });

  it("item 11: counts a list item as a paragraph of its own, and reads no table row", () => {
    const item = "- `a` `b` `c` `d` `e` `f` `g` `h` `i` `j` 는 열 개입니다.";
    expect(checkIds(["# 계획", "", item, ""].join("\n"))).toEqual([{ line: 3, ids: 10, share: 0.59 }]);
    const row = "| `a` `b` `c` `d` `e` `f` `g` `h` `i` `j` | x |";
    expect(checkIds(["# 계획", "", row, "|---|---|", ""].join("\n"))).toEqual([]);
  });

  it("item 13: finds a cell over 120 characters, and passes a cell of exactly 120", () => {
    expect(checkCells(`| a | ${"x".repeat(121)} |\n|---|---|\n`)).toEqual([
      { line: 1, text: "x".repeat(40), chars: 121 },
    ]);
    expect(checkCells(`| a | ${"x".repeat(120)} |\n|---|---|\n`)).toEqual([]);
  });

  it("item 13: reads no table inside a fenced code block", () => {
    const text = ["```text", `| a | ${"x".repeat(121)} |`, "|---|---|", "```", ""].join("\n");
    expect(checkCells(text)).toEqual([]);
  });

  it("item 14: finds a Korean syllable outside the 2350 of KS X 1001, and passes the corrected sentence", () => {
    const broken = [...HEADINGS, "sudo 1.9.17 설명서에 기됱니다. 그리고 쟽니다.", ""].join("\n");
    const found = checkSyllables(broken);
    expect(found.map(({ line, syllable }) => ({ line, syllable }))).toEqual([
      { line: 7, syllable: "됱" },
      { line: 7, syllable: "쟽" },
    ]);
    expect(found[0]!.context).toContain("기됱니다");
    const fixed = [...HEADINGS, "sudo 1.9.17 설명서에 기댑니다. 그리고 잽니다.", ""].join("\n");
    expect(checkSyllables(fixed)).toEqual([]);
  });

  it("item 14: reads no line inside a fence and no line in the appendix", () => {
    const text = [...HEADINGS, "```text", "기됱니다", "```", "", "## 부록 A. 인용", "", "기됱니다", ""].join("\n");
    expect(checkSyllables(text)).toEqual([]);
  });

  it("item 14: holds the 2350 common syllables of KS X 1001", () => {
    expect(COMMON_SYLLABLES.size).toBe(2350);
    expect(COMMON_SYLLABLES.has("묻")).toBe(true);
    expect(COMMON_SYLLABLES.has("댃")).toBe(false);
  });

  it("names every finding with its item and its line, in item order", () => {
    const text = [
      "# 계획", // 1
      "", // 2
      "부록 F 를 보십시오.", // 3
      "", // 4
      "1a2b3c4", // 5
      "", // 6
      `| a | ${"x".repeat(121)} |`, // 7
      "|---|---|", // 8
      "", // 9
    ].join("\n");
    expect(programFindings(text).map((finding) => [finding.item, finding.line])).toEqual([
      [10, 3],
      [12, 5],
      [13, 7],
    ]);
  });
});

describe("report_check: who has it", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(judges: Config["judges"] = {}): Promise<TestHarness> {
    harness = await createTestHarness({ loadExtensions: true, config: configWith(judges) });
    return harness;
  }

  /** A conversation of one role, with the agent record and the filter a spawn writes. */
  async function makeAgent(test: TestHarness, roles: readonly string[]): Promise<Conversation> {
    const model = test.faux.getModel();
    return await test.runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
        init: async (tx, conversationId) => {
          const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
          record.kind = "subagent";
          record.name = "helper";
          record.vmodel = "faux";
          record.roles = [...roles];
          record.status = "running";
          record.createdAt = Date.now();
          record.updatedAt = Date.now();
          const profile = await tx.doc(AgentDoc, conversationId);
          profile.tools = { remove: [...SUBAGENT_TOOL_REMOVALS] };
        },
      },
      CTX,
    );
  }

  /** The text of one entry, whichever shape its content takes. */
  function entryText(entry: EntryRecord): string {
    return (entry.model ?? [])
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
      .join("\n");
  }

  async function toolResults(conversation: Conversation): Promise<{ text: string; isError: boolean }[]> {
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, CTX);
    return page.items
      .filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => {
        const first = (entry.model?.[0] ?? {}) as { isError?: boolean };
        return { text: entryText(entry), isError: first.isError === true };
      });
  }

  /** Run one turn that calls one tool and then parks. */
  async function runTool(
    test: TestHarness,
    roles: readonly string[],
    name: string,
    args: Record<string, unknown>,
  ) {
    const conversation = await makeAgent(test, roles);
    test.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("await_orders", { note: "checked" })], { stopReason: "toolUse" }),
    ]);
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
    await submission.wait(CTX);
    return await toolResults(conversation);
  }

  /** Run one turn that calls `report_check` and then parks. */
  async function runCheck(test: TestHarness, roles: readonly string[], args: Record<string, unknown>) {
    return await runTool(test, roles, "report_check", args);
  }

  /** The personality file the default config names, in this harness's home. */
  async function writePersonality(test: TestHarness, text: string): Promise<void> {
    const path = join(test.paths.home, "memory", "personality.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  }

  it("runs for an orchestrator, whose prompt carries the personality", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const judge = registerJudge(test, {});
    const path = await scratchFile("draft.md", "# draft\n\n| a | b |\n| c | d |\n");
    await writePersonality(test, "---\nlanguage: en\n---\n# Persona\n\nSpeak plainly.\n");

    const conversation = await makeAgent(test, ["orchestrator"]);
    const heads: string[] = [];
    test.faux.setResponses([
      (input: { readonly messages: readonly Message[] }) => {
        heads.push(head(collapseSystemMessages({ messages: input.messages }).messages as Message[]));
        return fauxAssistantMessage([fauxToolCall("report_check", { path })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxToolCall("await_orders", { note: "checked" })], { stopReason: "toolUse" }),
    ]);
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
    await submission.wait(CTX);
    const results = await toolResults(conversation);

    // The orchestrator writes the report, so the prompt is the one it writes in.
    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain("<personality>");
    expect(heads[0]).toContain(PERSONALITY_INTRO_ORCHESTRATOR.en);
    // The turn also parks, so the last tool result is `await_orders`; the check is
    // the first one.
    expect(results[0]!.isError).toBe(false);
    expect(judge.requests).toHaveLength(1);
    const questions = judge.requests[0]!.body.questions ?? [];
    // The keys carry the item numbers of the report rules, not their position in
    // the request, so a reader matches an answer to the item it belongs to.
    expect(questions.map((question) => question.name)).toEqual(["q1", "q2", "q3", "q4", "q5", "q9", "q10"]);
    // A predicate has no criteria field, so the meanings of true and false are
    // appended to its instructions, the way the Decisions client sends them.
    expect(questions.map((question) => question.instructions)).toEqual(
      REPORT_CHECK_QUESTIONS.map((question) => `${question.text}\n\nTrue means: Yes\nFalse means: No`),
    );
    for (const question of questions) expect(question.type).toBe("predicate");
    expect(judge.classified).toEqual([]);
    expect(judge.streamed).toEqual([]);
  });

  it("blocks a worker, and the judge is never called", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const judge = registerJudge(test, {});
    const path = await scratchFile("draft.md", "# draft\n");

    const results = await runCheck(test, ["worker"], { path });

    expect(results[0]!.text).toContain("`report_check` is available to an orchestrator only.");
    expect(judge.requests).toEqual([]);
  });

  it("refuses a planner both report tools", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const judge = registerJudge(test, {});
    const path = await scratchFile("draft.md", "# draft\n");
    const job = await test.runtime.jobs.create(CTX, { title: "work" });

    const check = await runCheck(test, ["planner"], { path });
    const draft = await runTool(test, ["planner"], "reports_draft", {
      jobId: job.id,
      title: "plan",
      content: "# draft\n",
    });

    expect(check[0]!.text).toContain("`report_check` is available to an orchestrator only.");
    expect(draft[0]!.text).toContain("`reports_draft` is not available to a planner.");
    // Neither call reaches the judge, and no draft is left in the job.
    expect(judge.requests).toEqual([]);
    expect(await test.runtime.drafts.list(CTX)).toEqual([]);
  });

  it("reads the role file of a planner, which writes no draft", async () => {
    const test = await boot();
    // The role file travels through the `roles` section: the harness reads the
    // shipped file from the install home, so the test puts it there the way an
    // install does.
    const shipped = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "role", "planner.md"),
      "utf8",
    );
    const rolePath = join(test.paths.promptsDir, "role", "planner.md");
    await mkdir(dirname(rolePath), { recursive: true });
    await writeFile(rolePath, shipped, "utf8");

    const conversation = await makeAgent(test, ["planner"]);
    const heads: string[] = [];
    test.faux.setResponses(
      Array.from({ length: 4 }, () => (input: { readonly messages: readonly Message[] }) => {
        heads.push(head(collapseSystemMessages({ messages: input.messages }).messages as Message[]));
        return fauxAssistantMessage([fauxToolCall("await_orders", { note: "parked" })], { stopReason: "toolUse" });
      }),
    );
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
    await submission.wait(CTX);

    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain("# Planner: the role that works out the content of one plan");
    expect(heads[0]).toContain("You have no `reports_draft` and no `report_check`.");
    expect(heads[0]).not.toContain("Run `report_check`");
    // The default role list names the orchestrator alone: the planner is found by
    // its role name, and it takes neither the personality nor the Korean rules.
    expect(defaultConfig().personality.roles).toEqual(["orchestrator"]);
    expect(heads[0]).not.toContain("<personality>");
  });
});

/** The leading system message of a request, with every section collapsed into it. */
function head(messages: Parameters<typeof collapseSystemMessages>[0]["messages"]): string {
  const collapsed = collapseSystemMessages({ messages }).messages;
  const first = collapsed[0];
  return first !== undefined && first.role === "system" ? getSystemMessageText(first) : "";
}

describe("report_check: the answer", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(judges: Config["judges"]): Promise<TestHarness> {
    harness = await createTestHarness({ loadExtensions: true, config: configWith(judges) });
    return harness;
  }

  function tool(test: TestHarness, name: string): ToolLike {
    const entry = test.runtime.registry.snapshot().tools().find((item) => item.tool.name === name);
    if (entry === undefined) throw new Error(`tool not registered: ${name}`);
    return entry.tool as unknown as ToolLike;
  }

  function apiOf(test: TestHarness): ToolExecutionApi {
    return {
      conversationId: 1,
      commit: (change: never, context: typeof CTX) => test.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  async function checkText(test: TestHarness, args: Record<string, unknown>): Promise<ToolResult> {
    return await tool(test, "report_check").execute(args as never, apiOf(test), CTX);
  }

  /** A text with three tables, a hash value, and one table without a delimiter row. */
  const TEXT = [
    "# draft", // 1
    "", // 2
    "| a | b |", // 3
    "|---|---|", // 4
    "| c | d |", // 5
    "", // 6
    "the commit is 1a2b3c4 in the body", // 7
    "", // 8
    "| e | f |", // 9
    "| g | h |", // 10
    "", // 11
    "```text", // 12
    "| i | j |", // 13
    "```", // 14
    "", // 15
    "| k | l |", // 16
    "|---|---|", // 17
    "", // 18
  ].join("\n");

  it("names the items to review, the program finding and the table without a delimiter row", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const judge = registerJudge(test, { q9: 0.21 });
    const path = await scratchFile("draft.md", TEXT);

    const result = await checkText(test, { path });
    const lines = textOf(result).split("\n");

    expect(judge.requests).toHaveLength(1);
    expect(lines[0]).toBe(
      "report_check: 7 questions, 1 to review (yes below 0.95). 5 program checks, 1 finding. Tables: 3 found, 1 without a delimiter row.",
    );
    expect(lines[1]).toBe(`REVIEW 9. ${questionOf(9)} (yes 0.21)`);
    // The program found the hash value on line 7 of the body, which is item 12.
    expect(lines[2]).toBe("CHECK 12 at line 7: a hash value in the body: 1a2b3c4");
    expect(lines[3]).toBe("TABLE at line 9: the second line is not a delimiter row.");
    expect(lines[4]).toBe("no review needed: 1 (0.99), 2 (0.99), 3 (0.99), 4 (0.99), 5 (0.99), 10 (0.99)");
    expect(lines[5]).toBe("program checks with no finding: 10, 11, 13, 14");
    expect(lines[6]).toBe("not checked, your own check and the root's check only: 6, 7, 8");
    expect(lines[7]).toBe(
      "Yes at 0.95 or more means that the item is clear. An item to review is one to look at once, and it does not mean that the item is bad.",
    );
    expect(lines[8]).toBe(
      "An item to review is not a failure. You judge it, and the root makes the final judgement.",
    );
    expect(lines[9]).toBe(
      "This is a quick self-test. It does not replace your own check or the root's check.",
    );
    expect(result.isError).toBeUndefined();
    // The details carry the probability of every question and every program
    // finding, so a caller reads the same facts without parsing the text.
    const details = result.details as {
      reviewBelow: number;
      review: number[];
      refused: number[];
      questions: Record<string, { probability: number | null; review: boolean }>;
      program: { checks: number[]; findings: { item: number; line: number; what: string }[]; unchecked: number[] };
      tables: { found: number; withoutDelimiter: number[] };
    };
    expect(details.reviewBelow).toBe(0.95);
    expect(details.review).toEqual([9]);
    expect(details.refused).toEqual([]);
    expect(details.questions["q9"]).toEqual({ probability: 0.21, review: true });
    expect(details.questions["q1"]).toEqual({ probability: 0.99, review: false });
    expect(details.program).toEqual({
      checks: [10, 11, 12, 13, 14],
      findings: [{ item: 12, line: 7, what: "a hash value in the body: 1a2b3c4" }],
      unchecked: [6, 7, 8],
    });
    expect(details.tables).toEqual({ found: 3, withoutDelimiter: [9] });
  });

  it("marks a refused item for review with its own words, and keeps the other six", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const judge = registerJudge(test, { q9: 0.18 }, { refused: ["q3"] });
    const path = await scratchFile("draft.md", "# draft\n");

    const result = await checkText(test, { path });
    const lines = textOf(result).split("\n");

    expect(judge.requests).toHaveLength(1);
    expect(lines[0]).toBe(
      "report_check: 7 questions, 2 to review (yes below 0.95). 5 program checks, 0 findings. Tables: 0 found, 0 without a delimiter row.",
    );
    expect(lines[1]).toBe(`REVIEW 3. ${questionOf(3)} (refused to answer)`);
    expect(lines[2]).toBe(`REVIEW 9. ${questionOf(9)} (yes 0.18)`);
    expect(lines[3]).toBe("no review needed: 1 (0.99), 2 (0.99), 4 (0.99), 5 (0.99), 10 (0.99)");
    expect(lines[4]).toBe("program checks with no finding: 10, 11, 12, 13, 14");
    expect(lines[5]).toBe("not checked, your own check and the root's check only: 6, 7, 8");
    const details = result.details as {
      review: number[];
      refused: number[];
      questions: Record<string, { probability: number | null; review: boolean }>;
    };
    expect(details.review).toEqual([3, 9]);
    expect(details.refused).toEqual([3]);
    expect(details.questions["q3"]).toEqual({ probability: null, review: true });
    expect(details.questions["q1"]).toEqual({ probability: 0.99, review: false });
  });

  it("takes the threshold from the judge entry's reviewBelow", async () => {
    const test = await boot({
      "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL, reviewBelow: 0.99 },
    });
    registerJudge(test, { q1: 0.96 });
    const path = await scratchFile("draft.md", "# draft\n");

    const text = textOf(await checkText(test, { path }));

    expect(text.split("\n")[0]).toContain("1 to review (yes below 0.99)");
    expect(text).toContain("REVIEW 1. ");
    expect(text).toContain("(yes 0.96)");
  });

  it("uses 0.95 when the entry names no threshold", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    registerJudge(test, { q1: 0.96 });
    const path = await scratchFile("draft.md", "# draft\n");

    const text = textOf(await checkText(test, { path }));

    expect(text.split("\n")[0]).toContain("0 to review (yes below 0.95)");
    expect(text).toContain("no review needed: 1 (0.96)");
  });

  it("reads a draft by id as well as a file", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    registerJudge(test, {});
    const live = await test.runtime.jobs.create(CTX, { title: "work" });
    const written = textOf(
      await tool(test, "reports_draft").execute(
        { jobId: live.id, title: "plan", content: TEXT } as never,
        apiOf(test),
        CTX,
      ),
    );
    const id = /^draft (\S+) written/.exec(written)?.[1];
    expect(id).toBeDefined();

    const result = await checkText(test, { draftId: id });
    expect(textOf(result).split("\n")[0]).toContain("Tables: 3 found, 1 without a delimiter row.");
    expect(textOf(result)).toContain("TABLE at line 9:");
  });

  it("refuses both inputs and neither", async () => {
    const test = await boot({});
    const both = await checkText(test, { draftId: "x", path: "y" });
    const neither = await checkText(test, {});
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("exactly one of `draftId` and `path`");
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain("exactly one of `draftId` and `path`");
  });

  it("names the reason when the judge is not configured, and does not fail", async () => {
    const test = await boot({});
    const path = await scratchFile("draft.md", TEXT);

    const result = await checkText(test, { path });

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("report_check: the judge did not answer (skipped: name).");
    expect(text).toContain("Tables: 3 found, 1 without a delimiter row.");
    expect(text).toContain("TABLE at line 9: the second line is not a delimiter row.");
    expect(text).toContain(
      "This is a quick self-test. It does not replace your own check or the root's check.",
    );
  });

  it("names the reason when the provider fails, and does not fail", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    // A 400 is not retried, so the failure is the provider's answer, not a wait.
    registerJudge(test, {}, { replies: [jsonReply({ error: "the draft cannot be read" }, 400)] });
    const path = await scratchFile("draft.md", "# draft\n");

    const result = await checkText(test, { path });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("report_check: the judge did not answer (failed: provider; status 400).");
  });

  it("names the rate limit with its status, type, code and wait, and asks for no early check", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    const body = { error: { type: "tokens", code: "rate_limit_exceeded", message: "org-quoted text" } };
    registerJudge(test, {}, { replies: [jsonReply(body, 429, { "retry-after": "60" })] });
    const path = await scratchFile("draft.md", "# draft\n");

    const result = await checkText(test, { path });

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain(
      "(failed: rate_limited; status 429, type tokens, code rate_limit_exceeded, retry after 60 s)",
    );
    expect(text).toContain("A check before the retry time gets the same answer.");
    expect(text).not.toContain("org-quoted text");
    expect(result.details).toMatchObject({ reason: "rate_limited", status: 429, retryAfterMs: 60000 });
  });

  it("leaves no draft text in the audit trail", async () => {
    const test = await boot({ "report-check": { provider: JUDGE_PROVIDER, modelId: JUDGE_MODEL } });
    registerJudge(test, {});
    const marker = "The quiet zebra keeps a secret sentence.";
    const path = await scratchFile("draft.md", `# draft\n\n${marker}\n`);

    await checkText(test, { path });

    const audit = await readAuditTail(test.paths.auditLog, 50);
    const judgeLines = audit.filter((line) => line.type === "judge");
    expect(judgeLines).toHaveLength(1);
    expect(judgeLines[0]).toMatchObject({ judge: "report-check", outcome: "answered" });
    const raw = await readFile(test.paths.auditLog, "utf8");
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain("quiet zebra");
  });
});

describe("the settings a check reads", () => {
  it("rejects a reviewBelow outside 0 and 1", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ judges: { "report-check": { provider: "openai", modelId: "gpt-6-luna", reviewBelow: 1.5 } } }),
    );
    const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join("\n")).toContain("reviewBelow");
  });

  it("accepts a reviewBelow from 0 to 1", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ judges: { "report-check": { provider: "openai", modelId: "gpt-6-luna", reviewBelow: 0.8 } } }),
    );
    const loaded = await loadConfig({ home, env: {} });
    expect(loaded.config.judges["report-check"]?.reviewBelow).toBe(0.8);
  });

  it("tells the four roles apart in the common conventions", () => {
    const section = CONVENTIONS_TEXT.slice(
      CONVENTIONS_TEXT.indexOf("## Roles and flow"),
      CONVENTIONS_TEXT.indexOf("\n## Approval"),
    );
    expect(section).toContain("Four roles share the work.");
    expect(section).toContain(
      "- A planner works out the content of one plan or one result report for its orchestrator. It researches the facts and writes a working document in the job directory, and it answers the points that come back. It writes no text that the user reads. It ends when that report is approved or its work is cancelled.",
    );
    expect(section).toContain(
      "- An orchestrator understands its job in depth. It holds the goal, the outline, and the main decisions of each plan, has a planner work out the content of each plan and each result report, and writes the reports the user reads from that content.",
    );
    expect(section).toContain("`planner` for a planner");
    expect(section).toContain("A planner calls `finish_work` when the report it works for is approved or its work is cancelled.");
    expect(section).not.toContain("Three roles share the work.");
    // The report check belongs to the role that writes the report.
    expect(CONVENTIONS_TEXT).toContain("- The orchestrator's `report_check` checks some of these items");
    expect(CONVENTIONS_TEXT).not.toContain("The planner's `report_check`");
  });
});
