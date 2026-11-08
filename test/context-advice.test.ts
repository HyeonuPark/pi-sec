import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { contextUsage } from "../src/agent/context-usage.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import {
  ContextAdvice,
  alreadyAdvised,
  carriesAdvice,
  readSessionScan,
  restartAdviceText,
  type ScannedEntry,
} from "../src/context-advice.ts";
import { SecAgent } from "../src/documents.ts";
import { ROUND_KEY } from "../src/extensions/session-restart.ts";
import { ENVELOPE_CLOSE, readMessage, wrapMessage } from "../src/message-envelope.ts";
import { SecRestartRound, type RestartRoundRecord } from "../src/documents.ts";
import { submitEnveloped } from "../src/submit-envelope.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The restart advice: a conversation that passes the size an install set gets one
 * suggestion on its next input, and no other input of that session gets one.
 *
 * The tests drive real runs with a scripted model, because the two halves under
 * test are the `afterResponse` hook (which sees the answer's usage) and the
 * submission path (`src/submit-envelope.ts`, which writes the stored text). Both
 * are invisible to a unit test of the module alone.
 */

const CTX = BACKGROUND_CONTEXT;

/** A config whose advice threshold is low enough that every answer passes it. */
function adviceConfig(overrides: { threshold?: number; roles?: string[] } = {}): Partial<Config> {
  const base = defaultConfig();
  return {
    agent: {
      ...base.agent,
      contextRestart: {
        thresholdTokens: overrides.threshold ?? 1,
        roles: overrides.roles ?? ["orchestrator"],
      },
    },
  };
}

/** The text of every user-role message of one entry. */
function userText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .filter((message) => message.role === "user")
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    })
    .join("\n");
}

/** The entries of one conversation, oldest first. */
async function log(test: TestHarness, conversationId: ConversationId): Promise<readonly EntryRecord[]> {
  const conversation = await test.runtime.harness.conversation(conversationId, CTX);
  if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, CTX);
  return page.items;
}

/** The user entries whose stored text carries the advice outside its envelope. */
function advisedEntries(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  return entries.filter((entry) => {
    if (entry.kind !== "pi.user") return false;
    const text = userText(entry);
    const closing = text.lastIndexOf(ENVELOPE_CLOSE);
    return closing !== -1 && text.slice(closing + ENVELOPE_CLOSE.length).includes("[restart advice]");
  });
}

/**
 * Submit one input the way the product does, and wait for its run to end.
 *
 * The advice is appended by `submitEnveloped`, which every producer of an input
 * goes through, so a test that called `conversation.submit` directly would bypass
 * the code under test.
 */
async function say(test: TestHarness, conversationId: ConversationId, content: string): Promise<void> {
  const conversation = await test.runtime.harness.conversation(conversationId, CTX);
  if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
  test.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
  const submission = await submitEnveloped(
    conversation,
    CTX,
    { type: "input", src: "operator", content },
    test.config.timezone,
  );
  await submission.wait(CTX);
}

/** The conversation a person talks to. */
async function root(test: TestHarness) {
  return await resolveDefaultConversation(test.runtime.harness, test.config, test.runtime.paths, CTX);
}

/** A subagent conversation with one role, as a spawn leaves it. */
async function makeSubagent(test: TestHarness, name: string, roles: readonly string[]): Promise<ConversationId> {
  const model = test.faux.getModel();
  const conversation = await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = "subagent";
        record.name = name;
        record.vmodel = "faux";
        record.roles = [...roles];
        record.status = "running";
        record.createdAt = Date.now();
        record.updatedAt = Date.now();
      },
    },
    CTX,
  );
  test.faux.setResponses([]);
  return conversation.id;
}

/** One restart round's record, or `undefined` when the conversation holds none. */
async function ledger(test: TestHarness, conversationId: ConversationId): Promise<RestartRoundRecord | undefined> {
  return await test.runtime.harness.snapshot(SecRestartRound, conversationId, ROUND_KEY, CTX);
}

describe("the advice's own parts", () => {
  it("counts a marker only where an advice is written, not inside an envelope", () => {
    const outside: ScannedEntry = {
      id: 1,
      kind: "pi.user",
      text: `${wrapMessage("operator", "hello")}\n[restart advice] this conversation's context is 5 tokens`,
    };
    // A tool result can quote the marker. It sits in a body, and a body is data.
    const inside: ScannedEntry = {
      id: 2,
      kind: "pi.user",
      text: wrapMessage("tool-output", "[restart advice] this conversation's context is 5 tokens"),
    };
    const plain: ScannedEntry = { id: 3, kind: "pi.user", text: wrapMessage("operator", "hello") };

    expect(carriesAdvice(outside)).toBe(true);
    expect(carriesAdvice(inside)).toBe(false);
    expect(carriesAdvice(plain)).toBe(false);

    expect(alreadyAdvised({ startId: 1, startAt: 0, entries: [plain, outside] })).toBe(true);
    expect(alreadyAdvised({ startId: 1, startAt: 0, entries: [plain, inside] })).toBe(false);
    expect(alreadyAdvised({ startId: 1, startAt: 0, entries: [] })).toBe(false);
  });

  it("fills the two values and keeps the marker as the first line", () => {
    // The text is pinned whole, with the two values filled in. A session's stored
    // input carries it on every later request, so a longer text is a permanent
    // cost, and the first line is what says whether a session already has one.
    const text = restartAdviceText(321_356, 300_000);
    expect(text).toBe(
      [
        "[restart advice] This conversation's context is 321356 tokens, past the limit of 300000 tokens set for one session. This is a suggestion, not a command.",
        "When the work you are on reaches a resting point, tidy your state file so the next session can continue from it, and restart this session with `restart_session`, a reason and no round id. Your `continuation` is what the user reads where the context was reset, so say there what you did and what comes next.",
        "If your judgment is already blurring, take that resting point sooner.",
      ].join("\n"),
    );
    expect([...text].length).toBeLessThan(600);
  });

  it("marks a conversation that passed the threshold, and unmarks it when the advice is off", () => {
    let config = defaultConfig();
    const advice = new ContextAdvice({ getConfig: () => config, getHarness: () => undefined });

    // A size over the threshold is marked; a size under it is not.
    advice.noteResponse(1 as ConversationId, config.agent.contextRestart.thresholdTokens);
    expect(advice.pending(1 as ConversationId)).toBe(300_000);
    advice.noteResponse(2 as ConversationId, 10);
    expect(advice.pending(2 as ConversationId)).toBeUndefined();
    // A nonsense size changes nothing: it is not a request this provider answered.
    advice.noteResponse(3 as ConversationId, 0);
    expect(advice.pending(3 as ConversationId)).toBeUndefined();

    // A threshold of 0 turns the advice off, and it drops a mark already made, so
    // a reload that switches the advice off takes effect at once.
    config = {
      ...config,
      agent: { ...config.agent, contextRestart: { ...config.agent.contextRestart, thresholdTokens: 0 } },
    };
    advice.noteResponse(1 as ConversationId, 900_000);
    expect(advice.pending(1 as ConversationId)).toBeUndefined();
    advice.noteResponse(4 as ConversationId, 900_000);
    expect(advice.pending(4 as ConversationId)).toBeUndefined();
  });

  it("keeps a mark until the input it goes on, and drops it there", async () => {
    // The mark belongs to one input: the one after the answer that passed. A mark
    // that stayed would put the advice on every later input of the session.
    const config = defaultConfig();
    const advice = new ContextAdvice({ getConfig: () => config, getHarness: () => undefined });
    advice.noteResponse(7 as ConversationId, 900_000);
    // No harness, so no read: the block is empty and the mark is gone.
    const block = await advice.blockFor({
      conversationId: 7 as ConversationId,
      ctx: CTX,
      src: "operator",
      attrs: {},
    });
    expect(block).toBe("");
    expect(advice.pending(7 as ConversationId)).toBeUndefined();
  });
});

describe("the advice on a live conversation", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(config: Partial<Config> = adviceConfig()): Promise<TestHarness> {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: {
        ...config,
        agent: {
          ...base.agent,
          extensions: { enabled: [...base.agent.extensions.enabled, "session-restart"] },
          ...(config.agent ?? {}),
        },
      } as Partial<Config>,
    });
    return harness;
  }

  it("puts one advice on the input after the answer that passed, and not on the next one", async () => {
    const test = await boot();
    const conversation = await root(test);

    // The first input's answer passes the threshold of 1, so the mark is set. The
    // advice goes on the input after it, so this one carries none.
    await say(test, conversation.id, "first");
    expect(advisedEntries(await log(test, conversation.id))).toHaveLength(0);

    // The next input is the one the advice goes on.
    await say(test, conversation.id, "second");
    const afterSecond = advisedEntries(await log(test, conversation.id));
    expect(afterSecond).toHaveLength(1);
    expect(userText(afterSecond[0]!)).toContain("second");

    // And the same session gives no second advice, even though every answer of
    // this conversation passes the threshold.
    await say(test, conversation.id, "third");
    const afterThird = advisedEntries(await log(test, conversation.id));
    expect(afterThird).toHaveLength(1);
    expect(afterThird[0]!.id).toBe(afterSecond[0]!.id);
  });

  it("draws the advice nowhere: it is stored outside the envelope the page reads", async () => {
    const test = await boot();
    const conversation = await root(test);
    await say(test, conversation.id, "first");
    await say(test, conversation.id, "second");

    const advised = advisedEntries(await log(test, conversation.id));
    expect(advised).toHaveLength(1);
    const text = userText(advised[0]!);

    // The envelope holds the words the person wrote and nothing else, which is
    // what the page draws.
    const parsed = readMessage(text);
    expect(parsed?.body).toBe("second");
    expect(parsed?.source).toBe("operator");
    // The advice is after the closing tag, so no reader of the body sees it.
    expect(text.indexOf("[restart advice]")).toBeGreaterThan(text.lastIndexOf(ENVELOPE_CLOSE));
  });

  it("advises again in the new session a restart starts", async () => {
    const test = await boot();
    const conversation = await root(test);
    await say(test, conversation.id, "first");
    await say(test, conversation.id, "second");
    expect(advisedEntries(await log(test, conversation.id))).toHaveLength(1);

    // The agent takes the advice: it restarts its own session with no round id.
    test.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("restart_session", { reason: "the context grew long", continuation: "carry on" })],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])),
    ]);
    const submission = await conversation.submit({ type: "input", content: "restart now" }, CTX);
    await submission.wait(CTX);
    const resets = (await log(test, conversation.id)).filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);

    // The new session starts empty, so its first answer is small. The advice of
    // the old session is behind the reset and is not counted.
    const scan = await readSessionScan(test.runtime.harness, conversation.id, CTX);
    expect(scan?.startId).toBe(resets[0]!.id);
    expect(alreadyAdvised(scan!)).toBe(false);
  });

  it("leaves a conversation alone when the threshold is 0", async () => {
    const test = await boot(adviceConfig({ threshold: 0 }));
    const conversation = await root(test);
    await say(test, conversation.id, "first");
    await say(test, conversation.id, "second");
    await say(test, conversation.id, "third");
    expect(advisedEntries(await log(test, conversation.id))).toHaveLength(0);
  });

  it("gives the advice to an orchestrator and not to a worker or a planner", async () => {
    const test = await boot();
    const orchestrator = await makeSubagent(test, "orchestrator-one", ["orchestrator"]);
    const worker = await makeSubagent(test, "worker-one", ["worker"]);
    const planner = await makeSubagent(test, "planner-one", ["planner"]);

    for (const conversationId of [orchestrator, worker, planner]) {
      await say(test, conversationId, "first");
      await say(test, conversationId, "second");
    }

    expect(advisedEntries(await log(test, orchestrator))).toHaveLength(1);
    expect(advisedEntries(await log(test, worker))).toHaveLength(0);
    expect(advisedEntries(await log(test, planner))).toHaveLength(0);
  });

  it("reads the size the provider answered, not the transcript", async () => {
    // The size the advice is judged on is the one `contextUsage` reads: input plus
    // cache reads plus cache writes of the newest answer. The threshold here is
    // the size of the harness's own prompt, so the second answer passes it.
    const test = await boot(adviceConfig({ threshold: 1 }));
    const conversation = await root(test);
    await say(test, conversation.id, "first");
    const usage = await contextUsage(conversation, test.models, 0, CTX);
    expect(usage.used).toBeGreaterThan(0);
  });
});
