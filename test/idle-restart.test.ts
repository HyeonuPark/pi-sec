import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ConversationId, type EntryRecord } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { IDLE_ADVICE_MARKER, idleAdvice, idleAdviceText } from "../src/context-advice.ts";
import { SecAgent, type AgentKind, type AgentStatus } from "../src/documents.ts";
import { readFoldedMessage } from "../src/ui/chat/transcript/envelope.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The time-based restart advice: a target conversation that has been quiet long
 * enough gets one suggestion to restart its own session, without waiting for an
 * input.
 *
 * The tests write the conversation log and its timestamps themselves, so the
 * fifty-five minutes the rule waits for is a value a test sets rather than one it
 * sleeps through. The advice itself is submitted like any other input, so the
 * assertion is on the stored text of a `pi.user` entry: that is where the agent
 * reads it and where the next pass finds it.
 */
const CTX = BACKGROUND_CONTEXT;
const MINUTE = 60_000;

/** A config that keeps the fifty-five minute rule but lowers the size gate. */
function idleConfig(overrides: { readonly minutes?: number; readonly minTokens?: number } = {}): Partial<Config> {
  const base = defaultConfig();
  return {
    agent: {
      ...base.agent,
      contextRestart: {
        ...base.agent.contextRestart,
        idle: {
          minutes: overrides.minutes ?? 55,
          minTokens: overrides.minTokens ?? 1_000,
        },
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

/** The stored texts one conversation received as the time-based advice. */
async function adviceTexts(test: TestHarness, conversationId: ConversationId): Promise<string[]> {
  return (await log(test, conversationId))
    .map(userText)
    .filter((text) => text.includes(IDLE_ADVICE_MARKER));
}

/** An answer whose message carries a chosen timestamp and request size. */
function datedAnswer(at: number, tokens: number): Message {
  const message = fauxAssistantMessage([fauxText("ok")]);
  return {
    ...message,
    timestamp: at,
    usage: { ...message.usage, input: tokens, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
  } as Message;
}

interface SeedOptions {
  readonly name?: string;
  readonly kind?: AgentKind;
  readonly roles?: readonly string[];
  readonly status?: AgentStatus;
  /** How long before now the conversation last moved. */
  readonly quietForMs: number;
  /** The request size of its newest answer, in tokens. */
  readonly tokens?: number;
  /** The root record cannot name a parent, and it is written for conversation 1. */
  readonly root?: boolean;
}

/**
 * One conversation with a log that says it last moved `quietForMs` ago.
 *
 * It is created the way a subagent is created, with the faux model, so the advice
 * it receives really runs: the placement of the input is what the tests read.
 */
async function seed(test: TestHarness, options: SeedOptions): Promise<ConversationId> {
  const at = Date.now() - options.quietForMs;
  const tokens = options.tokens ?? 50_000;
  if (options.root === true) {
    const conversation = await resolveDefaultConversation(
      test.runtime.harness,
      test.config,
      test.runtime.paths,
      CTX,
    );
    await test.runtime.harness.commit(async (tx) => {
      await tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: "go", timestamp: at }] });
      await tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [datedAnswer(at, tokens)] });
      const record = await tx.doc(SecAgent, String(conversation.id), String(conversation.id));
      record.kind = "root";
      record.name = "operator";
      record.roles = [];
      record.status = "running";
      record.createdAt = at;
      record.updatedAt = at;
    }, CTX);
    return conversation.id;
  }

  const model = test.faux.getModel();
  const conversation = await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        await tx.appendEntry(conversationId, { kind: "pi.user", model: [{ role: "user", content: "go", timestamp: at }] });
        await tx.appendEntry(conversationId, { kind: "pi.assistant", model: [datedAnswer(at, tokens)] });
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = options.kind ?? "subagent";
        record.name = options.name ?? "quiet-one";
        record.vmodel = "faux";
        record.roles = [...(options.roles ?? ["orchestrator"])];
        record.parentConversationId = String(ROOT_CONVERSATION_ID);
        record.status = options.status ?? "running";
        record.createdAt = at;
        record.updatedAt = at;
      },
    },
    CTX,
  );
  return conversation.id;
}

/** Append an input the conversation received, dated as the caller says. */
async function appendInput(test: TestHarness, conversationId: ConversationId, content: string, at: number): Promise<void> {
  await test.runtime.harness.commit(async (tx) => {
    await tx.appendEntry(conversationId, { kind: "pi.user", model: [{ role: "user", content, timestamp: at }] });
  }, CTX);
}

/** Poll until a condition holds, so a run that starts after a pass can finish. */
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Run one periodic pass. */
async function sweep(test: TestHarness): Promise<void> {
  await test.runtime.subagents!.sweep(CTX);
}

describe("the time-based advice", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /**
   * A harness whose seeded conversations park when the advice wakes them.
   *
   * A seeded conversation is a subagent with no parent of its own, so a run that
   * ended in prose would earn the nudge and then be stopped and retired, and the
   * pass after it would have no record to read. Parking is what an orchestrator
   * does at the end of a turn anyway, so the conversation stays where the advice
   * found it.
   */
  async function boot(overrides: { readonly minutes?: number; readonly minTokens?: number } = {}): Promise<TestHarness> {
    harness = await createTestHarness({
      config: idleConfig(overrides),
      responses: Array.from({ length: 40 }, () =>
        fauxAssistantMessage([fauxToolCall("await_orders", { note: "nothing to do" })], { stopReason: "toolUse" }),
      ),
    });
    return harness;
  }

  it("defaults to fifty-five minutes and a hundred thousand tokens", () => {
    const idle = defaultConfig().agent.contextRestart.idle;
    expect(idle.minutes).toBe(55);
    expect(idle.minTokens).toBe(100_000);
  });

  it("puts one advice into a quiet target, and the next pass does not add another", async () => {
    const test = await boot();
    const id = await seed(test, { quietForMs: 60 * MINUTE });

    await sweep(test);
    const advice = await adviceTexts(test, id);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toContain(IDLE_ADVICE_MARKER);

    // The advice is an input, so it is the newest entry, but it is not a new quiet
    // stretch: the same stretch gets one message.
    await sweep(test);
    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(1);

    // It is input for the agent, not a note for a person.
    expect(await test.runtime.subagents!.inbox(1 as ConversationId, CTX)).toEqual([]);
  });

  it("advises again after a new input and another quiet stretch", async () => {
    // The size gate is off here: the advice's own answer is a short one, and this
    // test is about the quiet stretch, not about the size.
    const test = await boot({ minTokens: 0 });
    const id = await seed(test, { quietForMs: 60 * MINUTE });

    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(1);
    // The advice starts a run. The next pass is owed an advice only once the
    // conversation is resting again, so the test waits for the run to end, as
    // thirty seconds of real time would.
    await until(async () => (await test.runtime.harness.inspect(CTX)).tasks.length === 0, "the answer to the advice");

    // A new input arrives and the conversation goes quiet again for the same
    // stretch: that is a new quiet stretch, and it earns its own advice.
    await appendInput(test, id, "a new order", Date.now() - 60 * MINUTE);
    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(2);

    // Still one message for that stretch.
    await until(async () => (await test.runtime.harness.inspect(CTX)).tasks.length === 0, "the second answer");
    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(2);
  });

  it("says nothing to a conversation that moved more recently than the limit", async () => {
    const test = await boot();
    const id = await seed(test, { quietForMs: 54 * MINUTE });

    await sweep(test);
    expect(await adviceTexts(test, id)).toEqual([]);
  });

  it("says nothing below the minimum context, and nothing when the advice is off", async () => {
    const test = await boot({ minTokens: 100_000 });
    const small = await seed(test, { quietForMs: 60 * MINUTE, tokens: 50_000, name: "small" });
    const large = await seed(test, { quietForMs: 60 * MINUTE, tokens: 150_000, name: "large" });

    await sweep(test);
    expect(await adviceTexts(test, small)).toEqual([]);
    expect(await adviceTexts(test, large)).toHaveLength(1);
    await test.close();
    harness = undefined;

    const off = await boot({ minutes: 0 });
    const quiet = await seed(off, { quietForMs: 60 * MINUTE });
    await sweep(off);
    expect(await adviceTexts(off, quiet)).toEqual([]);
  });

  it("speaks to the root and to an orchestrator, and to no other role or kind", async () => {
    const test = await boot();
    const root = await seed(test, { root: true, quietForMs: 60 * MINUTE });
    const orchestrator = await seed(test, { quietForMs: 60 * MINUTE, name: "orch", roles: ["orchestrator"] });
    const worker = await seed(test, { quietForMs: 60 * MINUTE, name: "work", roles: ["worker"] });
    const planner = await seed(test, { quietForMs: 60 * MINUTE, name: "plan", roles: ["planner"] });
    const focused = await seed(test, { quietForMs: 60 * MINUTE, name: "focus", kind: "focused", roles: [] });
    const scheduled = await seed(test, { quietForMs: 60 * MINUTE, name: "clock", kind: "scheduled", roles: [] });

    await sweep(test);
    expect(await adviceTexts(test, root)).toHaveLength(1);
    expect(await adviceTexts(test, orchestrator)).toHaveLength(1);
    expect(await adviceTexts(test, worker)).toEqual([]);
    expect(await adviceTexts(test, planner)).toEqual([]);
    expect(await adviceTexts(test, focused)).toEqual([]);
    expect(await adviceTexts(test, scheduled)).toEqual([]);
  });

  it("says nothing while the conversation works or holds an input that is not placed", async () => {
    // The sweep does not start a run only to watch one: the two facts it passes to
    // the judge are read from the live task count and the inbox, and the judge is
    // what these two lines exercise.
    const test = await boot();
    const id = await seed(test, { quietForMs: 60 * MINUTE });
    const base = {
      harness: test.runtime.harness,
      conversationId: id,
      ctx: CTX,
      now: Date.now(),
      minutes: 55,
      minTokens: 1_000,
      restartUp: false,
    };

    expect(await idleAdvice({ ...base, working: 1, queued: async () => 0 })).toMatchObject({
      kind: "skip",
      reason: "the conversation is working",
    });
    expect(await idleAdvice({ ...base, working: 0, queued: async () => 1 })).toMatchObject({
      kind: "skip",
      reason: "an input is waiting to be placed",
    });
    // The same conversation, with neither of the two, is owed the advice.
    expect(await idleAdvice({ ...base, working: 0, queued: async () => 0 })).toMatchObject({ kind: "due", size: 50_000 });
  });

  it("holds the advice while a restart request is up, and sends it once it is withdrawn", async () => {
    const test = await boot();
    const id = await seed(test, { quietForMs: 60 * MINUTE });

    test.runtime.restart.requireRestart();
    test.runtime.restart.markReady();
    await sweep(test);
    expect(await adviceTexts(test, id)).toEqual([]);

    test.runtime.restart.withdraw();
    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(1);

    // The withdrawal is owed one advice, not one per pass.
    await sweep(test);
    expect(await adviceTexts(test, id)).toHaveLength(1);
  });

  it("stores the advice as a folded harness message that the page does not draw as the user's", async () => {
    const test = await boot();
    const id = await seed(test, { quietForMs: 60 * MINUTE });
    await sweep(test);

    const stored = await adviceTexts(test, id);
    expect(stored).toHaveLength(1);
    const text = stored[0]!;
    // The stored text is an envelope, so the page reads a message rather than a
    // bare input from the operator.
    expect(text.startsWith('<pi-message src="restart"')).toBe(true);
    const folded = readFoldedMessage(text);
    expect(folded?.source).toBe("restart");
    expect(folded?.attributes.get("via")).toBe("idle");
    // A source that is not the operator's is what the chat page folds into the run
    // card instead of drawing a bubble.
    expect(folded?.source).not.toBe("operator");
    expect(folded?.body).toContain(IDLE_ADVICE_MARKER);
  });

  it("keeps the fixed text, with the two values filled in", () => {
    // The text is pinned whole. It is stored with the input, so every later request
    // of that session carries it, and the first line is how the next pass knows the
    // quiet stretch is answered.
    expect(idleAdviceText(55, 230_000)).toBe(
      [
        "[idle restart advice] Nothing has happened in this conversation for 55 minutes. This is a suggestion, not a command.",
        "Your context is 230000 tokens. If you expect no input for a while, tidy your state file so the next session can continue from it, and restart this session with `restart_session`, a reason and no round id. Your `continuation` is what the user reads where the context was reset, so say there what you did and what comes next.",
        "Leave this session as it is when an input is likely soon: a report from a child agent, the result of a background call, an order from your parent, or an answer from the user. Restarting pays off only when the next input would find a long context that the provider no longer holds in its cache.",
        "This conversation gets one message for one quiet stretch. The next one comes after a new input.",
      ].join("\n"),
    );
    // It is stored with every later request of the session, so it stays short.
    expect([...idleAdviceText(55, 230_000)].length).toBeLessThan(900);
  });
});
