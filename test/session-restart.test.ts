import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  ResetEntry,
  SystemEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { DOC_KINDS, SecAgent, SecAgentChild, SecMessage, SecRestartRound, type AgentStatus, type RestartRoundRecord } from "../src/documents.ts";
import { readMessage } from "../src/message-envelope.ts";
import {
  DEFAULT_SCAN_CAPS,
  ledgerPath,
  readinessOf,
  scanLog,
  verdictOf,
  ROUND_KEY,
  type LogPageReader,
  type RoundLogEntry,
} from "../src/extensions/session-restart.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The restart cascade: an agent restarts its own conversation, and its children
 * do the same, until every session in the tree carries the same system prompt.
 *
 * The tests drive the tools through a real run with a scripted model, because
 * the two halves under test are the harness boundary that follows the tool call
 * (a `pi.reset`, then a run started from the queued input) and the reading of a
 * child's entry log. Neither is visible to a tool called in isolation.
 */

const RESTART_TOOLS = [
  "restart_session",
  "restart_cascade_start",
  "restart_cascade_status",
  "restart_cascade_close",
] as const;

interface Row {
  readonly kind: string;
  readonly text: string;
}

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

function rows(entries: readonly EntryRecord[]): Row[] {
  return entries.map((entry) => ({ kind: entry.kind, text: entryText(entry) }));
}

/**
 * The original text of one entry, with the source envelope removed when it has
 * one (`src/message-envelope.ts`). The continuation and the handoff a reset
 * carries are stored inside an envelope, so their text is read after unwrapping.
 */
function plainText(entry: EntryRecord): string {
  const text = entryText(entry);
  return readMessage(text)?.body ?? text;
}

/** The text of every tool result in a transcript, in call order. */
function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

/** Enough scripted answers that a child run cannot exhaust the queue. */
function answers(count = 40): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** A page reader over a log held in memory, so the scan runs without a store. */
function logReaderOf(
  entries: readonly RoundLogEntry[],
  pageSize: number,
): { readonly read: LogPageReader; readonly served: () => number; readonly pages: () => number } {
  let from = 0;
  let served = 0;
  let pages = 0;
  return {
    read: async () => {
      pages += 1;
      const page = entries.slice(from, from + pageSize);
      served += page.length;
      from += page.length;
      return { entries: page, next: from < entries.length ? { from } : undefined };
    },
    served: () => served,
    pages: () => pages,
  };
}

/** A scripted tool call. The stop reason is what makes the harness offer it to a tool task. */
function callTool(name: string, args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Wait until no live task is left in these conversations.
 *
 * Every test here shares one scripted response queue, and a conversation that is
 * still calling the model takes the next answer out of it. Waiting for quiet is
 * what keeps one round's script from being read by another conversation's run.
 */
async function quiet(test: TestHarness, conversationIds: readonly ConversationId[]): Promise<void> {
  const wanted = new Set(conversationIds.map(String));
  await until(async () => {
    const inspection = await test.runtime.harness.inspect(BACKGROUND_CONTEXT);
    const live = inspection.tasks.filter((task) => wanted.has(String(task.record.conversationId)));
    return live.length === 0 ? true : undefined;
  }, "the conversations to stop working");
}

/** The root conversation, as the operator's chat sees it. */
async function root(test: TestHarness): Promise<Conversation> {
  return await resolveDefaultConversation(
    test.runtime.harness,
    test.config,
    test.runtime.paths,
    BACKGROUND_CONTEXT,
  );
}

/** Submit one input, wait for its run to end, and return the whole transcript. */
async function say(
  test: TestHarness,
  conversation: Conversation,
  responses: ReturnType<typeof fauxAssistantMessage>[],
  content: string,
): Promise<{ readonly status: string; readonly entries: readonly EntryRecord[] }> {
  test.faux.setResponses(responses);
  const submission = await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
  return { status: settled.status, entries: page.items };
}

async function log(conversation: Conversation): Promise<readonly EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
  return page.items;
}

/** The entries of one conversation after `id`, oldest first. */
async function since(conversation: Conversation, id: number): Promise<readonly EntryRecord[]> {
  return await until(async () => {
    const page = await conversation.entries(
      { minEntryId: (id + 1) as EntryId, order: "ascending" },
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    return page.items.length > 0 ? page.items : undefined;
  }, "entries after the reset");
}

async function ledgerOf(test: TestHarness, conversation: Conversation): Promise<RestartRoundRecord> {
  const round = await test.runtime.harness.snapshot(SecRestartRound, conversation.id, ROUND_KEY, BACKGROUND_CONTEXT);
  if (round === undefined) throw new Error("this conversation has no restart round document");
  return round;
}

/** The mirror file beside the document: a copy for a human, read by no verdict. */
async function mirrorOf(test: TestHarness, conversation: Conversation): Promise<RestartRoundRecord> {
  const raw = await readFile(ledgerPath(test.paths, String(conversation.id)), "utf8");
  return JSON.parse(raw) as RestartRoundRecord;
}

/** A conversation that is not the root, registered as an agent of `kind`. */
async function makeAgent(
  test: TestHarness,
  kind: "subagent" | "scheduled",
  name: string,
  removals: readonly string[] | undefined,
): Promise<Conversation> {
  const model = test.faux.getModel();
  return await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = kind;
        record.name = name;
        record.vmodel = "faux";
        record.roles = [];
        record.status = "running";
        record.createdAt = Date.now();
        record.updatedAt = Date.now();
        if (removals === undefined) return;
        const profile = await tx.doc(AgentDoc, conversationId);
        profile.tools = { remove: [...removals] };
      },
    },
    BACKGROUND_CONTEXT,
  );
}

/**
 * One child of the root, as `spawn_subagent` would have left it: an index entry
 * in the parent and an agent record of its own. The conversation is real, so a
 * note delivered to it starts a run there.
 *
 * The conversation deliberately has no model. A note that starts a run in it
 * then ends that run at once with `no_model`, which keeps the child from taking
 * answers out of the one scripted response queue the root's own runs read. Its
 * agent record is left exactly as written, which is what these tests count.
 */
async function makeChild(
  test: TestHarness,
  parent: Conversation,
  name: string,
  status: AgentStatus | undefined,
): Promise<ConversationId> {
  const conversation = await test.runtime.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  await test.runtime.harness.commit(async (tx) => {
    const index = await tx.doc(SecAgentChild, parent.id, name, name);
    index.name = name;
    index.conversationId = String(conversation.id);
    index.createdAt = Date.now();
    if (status === undefined) return;
    const record = await tx.doc(SecAgent, String(conversation.id), String(conversation.id));
    record.kind = "subagent";
    record.name = name;
    record.parentConversationId = String(parent.id);
    record.parentName = "operator";
    record.vmodel = "faux";
    record.roles = ["worker"];
    record.status = status;
    record.createdAt = Date.now();
    record.updatedAt = Date.now();
  }, BACKGROUND_CONTEXT);
  return conversation.id;
}

/**
 * Reset this conversation for the round, and count the round from the session
 * that the reset starts.
 *
 * This is the order the cascade note asks for: park, reset, then count the round
 * you left open. The model answers the continuation with the status call. The
 * scan caps are set around the whole call because the counting run starts after
 * the call that starts it has returned, so a caller cannot wrap that run alone.
 */
async function resetThenCount(
  test: TestHarness,
  conversation: Conversation,
  roundId: string,
  caps: { readonly limit: number; readonly page: number } | undefined,
): Promise<string> {
  const saved = { ...DEFAULT_SCAN_CAPS };
  if (caps !== undefined) {
    DEFAULT_SCAN_CAPS.limit = caps.limit;
    DEFAULT_SCAN_CAPS.page = caps.page;
  }
  try {
    const { entries } = await say(
      test,
      conversation,
      [
        callTool("restart_session", {
          reason: "the prompt moved",
          continuation: "Count the round you left open.",
          roundId,
        }),
        callTool("restart_cascade_status", { roundId }),
        fauxAssistantMessage([fauxText("counted")]),
      ],
      "restart, then count",
    );
    const resets = entries.filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);
    const after = await until(async () => {
      const items = await since(conversation, resets[0]!.id);
      return items.some((entry) => entry.kind === "pi.tool-result") ? items : undefined;
    }, "the count of the round from the new session");
    return toolResult(rows(after));
  } finally {
    DEFAULT_SCAN_CAPS.limit = saved.limit;
    DEFAULT_SCAN_CAPS.page = saved.page;
  }
}

describe("restarting a session", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function withRestart(): Promise<{ test: TestHarness; conversation: Conversation }> {
    const base = defaultConfig();
    const test = await createTestHarness({
      config: {
        agent: { extensions: { enabled: [...base.agent.extensions.enabled, "session-restart"] } },
      },
    });
    harness = test;
    const conversation = await root(test);
    return { test, conversation };
  }

  it("resets once, ends the run done, and starts one new run with the continuation", async () => {
    const { test, conversation } = await withRestart();
    const continuation = "The prompt changed. You were restarted; continue with the round.";

    const { status, entries } = await say(
      test,
      conversation,
      [
        callTool("restart_session", { reason: "the prompt moved", continuation, roundId: "R1" }),
        fauxAssistantMessage([fauxText("after the restart")]),
      ],
      "go",
    );

    // The handoff path ends the calling run `done`. The queued-reset path would
    // end it `unanswered` and the operator would see a question with no answer.
    expect(status).toBe("done");

    const resets = entries.filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);
    const reset = resets[0]!;
    expect(entryText(reset)).toContain("R1");

    // One new session: its baseline, then the continuation as the first user entry.
    const after = await until(async () => {
      const items = await since(conversation, reset.id);
      const baseline = items.some((entry) => entry.kind === "pi.system");
      const first = items.find((entry) => entry.kind === "pi.user");
      const answered = items.some((entry) => entry.kind === "pi.assistant");
      return baseline && first !== undefined && answered ? items : undefined;
    }, "the new run to read the baseline and answer");

    const first = after.find((entry) => entry.kind === "pi.user");
    // The continuation is stored as an envelope whose first line names the restart
    // as its source; its body is the continuation, byte for byte.
    const stored = readMessage(entryText(first!));
    expect(stored).toMatchObject({ source: "restart", format: "envelope", body: continuation });
    expect(stored?.attrs["via"]).toBe("continuation");
    expect(stored?.attrs["round"]).toBe("R1");
    expect(after.filter((entry) => entry.kind === "pi.reset")).toHaveLength(0);
    // The model was asked once for the tool round and once for the new run, so
    // exactly one new run started. A second reset would have added a third.
    expect(test.faux.state.callCount).toBe(2);
  });

  it("restarts with the id of a round that was closed before the restart", async () => {
    const { test, conversation } = await withRestart();
    const continuation = "Setup is done. The new session starts with a greeting.";

    // The first-run order: open the round, see that there are no children, close
    // it, and only then restart. The close has to come first because the new
    // session will not know the round id.
    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the personality is settled" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);
    expect(opened.targets).toHaveLength(0);
    const closed = await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: opened.roundId, note: "no children" }), ...answers()],
      "close the round",
    );
    expect(toolResult(rows(closed.entries))).toContain("is closed");
    expect((await ledgerOf(test, conversation)).closedAt).toBeGreaterThan(0);
    await quiet(test, [conversation.id]);

    // A closed round is not a closed door: `restart_session` does not read the
    // round's state, so the same id resets this conversation and queues the
    // continuation.
    const { entries } = await say(
      test,
      conversation,
      [
        callTool("restart_session", {
          reason: "the personality is settled",
          continuation,
          roundId: opened.roundId,
        }),
        ...answers(),
      ],
      "restart now",
    );
    expect(toolResult(rows(entries))).toContain(`restarting this conversation for round "${opened.roundId}"`);

    const resets = entries.filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);
    expect(entryText(resets[0]!)).toContain(opened.roundId);

    // The continuation is the first user entry of the new session, and the new
    // session answers it.
    const after = await until(async () => {
      const items = await since(conversation, resets[0]!.id);
      const first = items.find((entry) => entry.kind === "pi.user");
      const answered = items.some((entry) => entry.kind === "pi.assistant");
      return first !== undefined && answered ? items : undefined;
    }, "the new run to read the continuation and answer");
    const stored = readMessage(entryText(after.find((entry) => entry.kind === "pi.user")!));
    expect(stored).toMatchObject({ source: "restart", body: continuation });
    expect(stored?.attrs["round"]).toBe(opened.roundId);

    // The restart wrote nothing about the round: it stays closed, and it keeps
    // the id the first-run flow used.
    const record = await ledgerOf(test, conversation);
    expect(record.roundId).toBe(opened.roundId);
    expect(record.closedAt).toBeGreaterThan(0);
  });

  it("queues nothing twice for one round and refuses a re-call after the reset", async () => {
    const { test, conversation } = await withRestart();
    const continuation = "Continue after the restart.";
    const second = "This one must not be queued.";

    // Two calls in one assistant message: they run in the same tool round, so
    // neither can see the other's reset.
    const { entries } = await say(
      test,
      conversation,
      [
        fauxAssistantMessage(
          [
            fauxToolCall("restart_session", { reason: "the prompt moved", continuation, roundId: "R1" }),
            fauxToolCall("restart_session", { reason: "the prompt moved", continuation, roundId: "R1" }),
          ],
          { stopReason: "toolUse" },
        ),
        ...answers(),
      ],
      "go",
    );

    const reset = entries.find((entry) => entry.kind === "pi.reset");
    expect(reset).toBeDefined();
    expect(entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(1);
    const after = await since(conversation, reset!.id);
    // The request id makes the second call the same submission, so the turn is
    // queued once and the new run starts from exactly that one entry.
    expect(after.filter((entry) => entry.kind === "pi.user" && plainText(entry) === continuation)).toHaveLength(1);

    // The re-call rule: the reset is in the log after the entry the ledger
    // recorded, so this is the crash-recovery case and it is refused.
    const again = await say(
      test,
      conversation,
      [callTool("restart_session", { reason: "the prompt moved", continuation: second, roundId: "R1" }), ...answers()],
      "the reset happened; call again with the same round",
    );
    expect(toolResult(rows(again.entries))).toContain("already reset");
    const final = await log(conversation);
    expect(final.filter((entry) => entry.kind === "pi.reset")).toHaveLength(1);
    expect(final.some((entry) => entry.kind === "pi.user" && plainText(entry) === second)).toBe(false);
  });

  it("keeps the child topology across the reset", async () => {
    const { test, conversation } = await withRestart();
    const child = await makeChild(test, conversation, "researcher", "running");

    await say(
      test,
      conversation,
      [callTool("restart_session", { reason: "the prompt moved", continuation: "continue", roundId: "R1" }), ...answers()],
      "go",
    );
    await until(async () => {
      const page = await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT);
      return page.items.some((entry) => entry.kind === "pi.reset") ? true : undefined;
    }, "the reset");

    // After the reset the parent reads its children again. The index and the
    // identities live in the document table, which a reset does not touch, so
    // the same name still resolves to the same conversation.
    const { entries } = await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const ledger = await ledgerOf(test, conversation);
    expect(ledger.targets.map((target) => target.name)).toEqual(["researcher"]);
    expect(ledger.targets[0]!.conversationId).toBe(String(child));
    expect(toolResult(rows(entries))).toContain("researcher");

    // And the child is still reachable under that name: the note landed in its
    // own conversation.
    const message = await test.runtime.harness.snapshot(
      SecMessage,
      child,
      ledger.targets[0]!.messageId!,
      BACKGROUND_CONTEXT,
    );
    expect(message?.to.conversationId).toBe(String(child));
  });

  it("allows the root and a subagent, and refuses a scheduled run", async () => {
    const { test, conversation } = await withRestart();

    const asRoot = (await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const tool of RESTART_TOOLS) expect(asRoot).toContain(tool);

    // A subagent conversation, built as `spawn_subagent` builds one: the gate
    // lets it through, so the call resets that conversation.
    const subagent = await makeAgent(test, "subagent", "worker", SUBAGENT_TOOL_REMOVALS);
    const subagentNames = (await subagent.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const tool of RESTART_TOOLS) expect(subagentNames).toContain(tool);
    const ran = await say(
      test,
      subagent,
      [callTool("restart_session", { reason: "the prompt moved", continuation: "continue", roundId: "R2" }), ...answers()],
      "go",
    );
    expect(toolResult(rows(ran.entries))).toContain("restarting this conversation");
    expect(ran.entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(1);
    await quiet(test, [subagent.id]);

    // A scheduled run, built as `Scheduler.dispatch` builds one: the scout tool
    // profile removes the four tools outright, so the call is answered as a tool
    // that was never offered.
    const scheduled = await makeAgent(test, "scheduled", "nightly", SCHEDULED_TOOL_REMOVALS);
    const scheduledNames = (await scheduled.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const tool of RESTART_TOOLS) expect(scheduledNames).not.toContain(tool);
    const refused = await say(
      test,
      scheduled,
      [callTool("restart_session", { reason: "the prompt moved", continuation: "continue", roundId: "R3" }), ...answers()],
      "go",
    );
    expect(toolResult(rows(refused.entries))).toContain("restart_session is not available");
    expect(refused.entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(0);

    // And with the tools offered, the gate is what refuses: the kind is not one
    // the four tools are for. This is the layer that holds when a stored tool
    // selection is wrong.
    const offered = await makeAgent(test, "scheduled", "nightly-offered", undefined);
    const offeredNames = (await offered.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
    for (const tool of RESTART_TOOLS) expect(offeredNames).toContain(tool);
    const gated = await say(
      test,
      offered,
      [callTool("restart_session", { reason: "the prompt moved", continuation: "continue", roundId: "R4" }), ...answers()],
      "go",
    );
    expect(toolResult(rows(gated.entries))).toContain("not available to a scheduled agent");
    expect(gated.entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(0);
  });

  it("counts a stopped child and a child whose record is gone as finished", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "stopped-one", "stopped");
    const gone = await makeChild(test, conversation, "gone-one", "running");
    // A third child that really did start again: its log gets the two entries the
    // rule looks for. What matters is that the round reads the log of the child
    // and not the message the child may or may not send.
    const restarted = await makeChild(test, conversation, "reset-one", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);
    expect(opened.targets.map((target) => target.name).sort()).toEqual(["gone-one", "reset-one", "stopped-one"]);

    // The second child dies while the round is open: its record is retired the
    // way `retireIfFinished` retires a finished agent. Nothing else is written
    // for it, so this is exactly the silent death the round must survive.
    await test.runtime.harness.commit(async (tx) => {
      await tx.retireDoc(SecAgent, String(gone));
    }, BACKGROUND_CONTEXT);

    // And the third one restarts itself while the round is open: a reset, then
    // the baseline the new session wrote after it.
    const baseline = await test.runtime.harness.commit(async (tx) => {
      await tx.appendEntry(ResetEntry, restarted, { head: "self", model: [{ role: "user", content: "handoff", timestamp: Date.now() }] });
      return await tx.appendEntry(SystemEntry, restarted, { model: [{ role: "system", content: "" }] });
    }, BACKGROUND_CONTEXT);

    const { entries } = await say(
      test,
      conversation,
      [callTool("restart_cascade_status", { roundId: opened.roundId }), ...answers()],
      "count the round",
    );
    const report = toolResult(rows(entries));
    expect(report).toContain("3/3");
    // This conversation has not reset, so the restart is still the step.
    expect(report).toContain(
      "Every target is ready. Call `restart_session` with this round id, then close the round with `restart_cascade_close`.",
    );
    expect(report).not.toContain("already reset");
    expect(report).toContain("stopped-one");
    expect(report).toContain("gone-one");
    expect(report).toContain(`reset-one (conversation ${restarted}, roles: worker, from entry 0, reset `);
    expect(report).toContain(", system ");
    expect(report).toContain("loaded a new baseline");

    const counted = await ledgerOf(test, conversation);
    expect(counted.targets.every((target) => target.counted)).toBe(true);
    expect(counted.targets.find((target) => target.name === "reset-one")?.verdict).toBe("ready");
    expect(counted.targets.find((target) => target.name === "gone-one")?.verdict).toBe("finished");
    expect(counted.targets.find((target) => target.name === "stopped-one")?.verdict).toBe("finished");
    expect(counted.targets.find((target) => target.name === "gone-one")?.reason).toContain("record is gone");
    expect(counted.targets.find((target) => target.name === "stopped-one")?.reason).toContain("stopped");
    expect(counted.targets.find((target) => target.name === "reset-one")?.systemId).toBe(baseline.id);
    expect(counted.targets.every((target) => target.checkedAt > 0)).toBe(true);
  });

  it("asks for the close, not a second restart, when this conversation already reset", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "stopped-one", "stopped");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);

    // The round is counted from the session the reset started, which is the
    // session the notice of the round could not reach: a second
    // `restart_session` there would be refused, so the status asks for the close.
    const report = await resetThenCount(test, conversation, opened.roundId, undefined);
    await quiet(test, [conversation.id]);

    expect(report).toContain(
      "Every target is ready. This conversation already reset after this round opened, so do not call `restart_session` again. Close the round with `restart_cascade_close`.",
    );
    expect(report).not.toContain("Call `restart_session` with this round id");

    // What the status read: this conversation's own reset, recorded under this
    // round and requested after the round opened.
    const record = await ledgerOf(test, conversation);
    expect(record.selfRoundId).toBe(opened.roundId);
    expect(record.selfRequestedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.closedAt).toBe(0);
  });

  it("words the counted-without-evidence line the same way after this conversation reset", async () => {
    const { test, conversation } = await withRestart();
    const slow = await makeChild(test, conversation, "slow-one", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const round = await ledgerOf(test, conversation);
    // A log longer than the cap, and no reset in it, so the target is counted
    // without evidence.
    await test.runtime.harness.commit(async (tx) => {
      for (let n = 0; n < 6; n += 1) {
        await tx.appendEntry(SystemEntry, slow, { model: [{ role: "system", content: "" }] });
      }
    }, BACKGROUND_CONTEXT);

    const report = await resetThenCount(test, conversation, round.roundId, { limit: 2, page: 2 });
    await quiet(test, [conversation.id]);

    expect(report).toContain(
      "Counted as finished without evidence: slow-one. The round does not wait for them. This conversation already reset after this round opened, so do not call `restart_session` again. Close the round with `restart_cascade_close`.",
    );
    expect(report).not.toContain("The round does not wait for them: call");
  });

  it("sends one note per child that tells an orchestrator to open its own round", async () => {
    const { test, conversation } = await withRestart();
    const first = await makeChild(test, conversation, "researcher", "running");
    const second = await makeChild(test, conversation, "writer", "running");

    const { entries } = await say(
      test,
      conversation,
      [
        callTool("restart_cascade_start", { reason: "the prompt moved for every session" }),
        ...answers(),
      ],
      "open the round",
    );
    const report = toolResult(rows(entries));
    expect(report).toContain("2 target(s)");
    expect(report).toContain("restart_cascade_status");

    const ledger = await ledgerOf(test, conversation);
    expect(ledger.targets).toHaveLength(2);
    for (const target of ledger.targets) {
      expect(target.messageId).toBeDefined();
      const message = await test.runtime.harness.snapshot(
        SecMessage,
        Number(target.conversationId) as ConversationId,
        target.messageId!,
        BACKGROUND_CONTEXT,
      );
      expect(message).toBeDefined();
      // One note per child: the round is the message, not a stream of them.
      const notes = await test.runtime.storage.scanDocuments(
        {
          scope: { kind: "conversation", conversationId: Number(target.conversationId) as ConversationId },
          at: "current",
          kind: DOC_KINDS.message,
        },
        50,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(notes.items).toHaveLength(1);

      const body = message!.body;
      expect(body).toContain(ledger.roundId);
      expect(body).toContain("restart_cascade_start");
      expect(body).toContain("your own round");
      expect(body).toContain("restart_session");
      expect(body).toContain("await_orders");
      // The continuation is read by the person, so the note names the user.
      expect(body).toContain("Your `continuation` is what the user reads where your context was reset");
      expect(body).not.toContain("operator");
    }
    expect(new Set(ledger.targets.map((target) => target.conversationId))).toEqual(
      new Set([String(first), String(second)]),
    );

    // Closing records the targets that were never seen to be ready, and it does
    // not notify the operator from a subagent.
    const closed = await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: ledger.roundId, note: "no child answered" }), ...answers()],
      "close the round",
    );
    expect(toolResult(rows(closed.entries))).toContain("is closed");
    expect(toolResult(rows(closed.entries))).toContain("Only the root agent notifies the user");
    const after = await ledgerOf(test, conversation);
    expect(after.closedAt).toBeGreaterThan(0);
    expect(after.unconfirmed.sort()).toEqual(["researcher", "writer"]);
  });

  it("opens one round when two starts run in one tool round, and refuses the other", async () => {
    const { test, conversation } = await withRestart();
    const child = await makeChild(test, conversation, "researcher", "running");

    // Both calls are in one assistant message, so the harness starts them
    // together and neither can see the other's round unless the store orders
    // them. The commit's read-modify-write is what orders them.
    const { entries } = await say(
      test,
      conversation,
      [
        fauxAssistantMessage(
          [
            fauxToolCall("restart_cascade_start", { reason: "the prompt moved" }),
            fauxToolCall("restart_cascade_start", { reason: "the prompt moved" }),
          ],
          { stopReason: "toolUse" },
        ),
        ...answers(),
      ],
      "open the round",
    );

    const report = toolResult(rows(entries));
    const opened = [...report.matchAll(/round "([^"]+)" is open over/g)].map((match) => match[1]!);
    const refused = [...report.matchAll(/round "([^"]+)" is still open for this conversation/g)].map(
      (match) => match[1]!,
    );
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The refused call names the round that is really there. A second write would
    // have buried the first round, and the child would hold an id nothing knows.
    expect(refused[0]).toBe(opened[0]);

    const round = await ledgerOf(test, conversation);
    expect(round.roundId).toBe(opened[0]);
    expect(round.targets.map((target) => target.name)).toEqual(["researcher"]);
    expect(round.targets[0]!.messageId).not.toBe("");
    const note = await test.runtime.harness.snapshot(
      SecMessage,
      child,
      round.targets[0]!.messageId,
      BACKGROUND_CONTEXT,
    );
    expect(note?.body).toContain(round.roundId);
    // One note, not two: the refused call sent nothing.
    const messages = await test.runtime.storage.scanDocuments(
      { scope: { kind: "conversation", conversationId: child }, at: "current", kind: DOC_KINDS.message },
      50,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(messages.items).toHaveLength(1);

    // Apart in time it is the same answer: the round on record is what refuses
    // the next start, and the round on record does not change.
    const again = await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open another round",
    );
    expect(toolResult(rows(again.entries))).toContain("is still open for this conversation");
    expect((await ledgerOf(test, conversation)).roundId).toBe(round.roundId);
  });

  it("holds two read-modify-writes of one document in order", async () => {
    // The whole atomic-open fix rests on this: both callbacks run on the store's
    // one mutation line, so the second one reads what the first committed.
    const { test, conversation } = await withRestart();
    const labels = ["first", "second"];
    const results = await Promise.all(
      labels.map((label) =>
        test.runtime.harness.commit(async (tx) => {
          const doc = await tx.doc(SecRestartRound, conversation.id, ROUND_KEY, ROUND_KEY);
          if (doc.startedAt !== 0) return "refused";
          doc.roundId = label;
          doc.startedAt = Date.now();
          return "opened";
        }, BACKGROUND_CONTEXT),
      ),
    );
    expect(results.filter((result) => result === "opened")).toHaveLength(1);
    expect(results.filter((result) => result === "refused")).toHaveLength(1);
    // The winner's write is the one in the store: the other one was refused, so
    // it could not bury it.
    expect((await ledgerOf(test, conversation)).roundId).toBe(labels[results.indexOf("opened")]);
  });

  it("mirrors the round document to the ledger file", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "researcher", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);
    expect(await mirrorOf(test, conversation)).toEqual(opened);

    // Every write reaches the file, not only the first one.
    await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: opened.roundId, note: "everyone reported" }), ...answers()],
      "close the round",
    );
    const closed = await ledgerOf(test, conversation);
    expect(closed.closedAt).toBeGreaterThan(0);
    expect(closed).not.toEqual(opened);
    expect(await mirrorOf(test, conversation)).toEqual(closed);
  });

  it("writes only the record type's fields into the ledger file", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "researcher", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);

    // The shape an older build left behind: the round, plus a key the type does
    // not have. The store writes back what it read, so the document keeps it.
    await test.runtime.harness.commit(async (tx) => {
      const doc = (await tx.doc(SecRestartRound, conversation.id, ROUND_KEY, ROUND_KEY)) as RestartRoundRecord & {
        approval?: string;
      };
      doc.approval = "operator approved";
      doc.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    expect((await ledgerOf(test, conversation) as unknown as { approval?: string }).approval).toBe("operator approved");

    // The next write of the file carries the type's fields and no others: the
    // list of them is the record's own initial value, so a field added to the
    // type needs no second list kept in step with it.
    await say(
      test,
      conversation,
      [callTool("restart_cascade_status", { roundId: opened.roundId }), ...answers()],
      "count the round",
    );
    const mirror = (await mirrorOf(test, conversation)) as unknown as Record<string, unknown>;
    expect(Object.keys(mirror).sort()).toEqual(Object.keys(SecRestartRound.definition.initial()).sort());
    expect(Object.hasOwn(mirror, "approval")).toBe(false);
  });

  it("opens a round from the reason alone, and records no approval", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "researcher", "running");

    // The call carries the reason and nothing else. Nothing reads an approval, so
    // the round opens from the reason.
    const { entries } = await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    expect(toolResult(rows(entries))).toContain("1 target(s)");

    const ledger = await ledgerOf(test, conversation);
    expect(ledger.reason).toBe("the prompt moved");
    expect(ledger.startedAt).toBeGreaterThan(0);
    expect(ledger.targets.map((target) => target.name)).toEqual(["researcher"]);
    // The record no longer holds an approval field, so neither the document nor
    // its mirror has a value under that name.
    expect(Object.hasOwn(ledger, "approval")).toBe(false);
    expect(Object.hasOwn(await mirrorOf(test, conversation), "approval")).toBe(false);
  });

  it("reads a round document that still carries the approval text of an older build", async () => {
    const { test, conversation } = await withRestart();
    await makeChild(test, conversation, "researcher", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const opened = await ledgerOf(test, conversation);

    // The stored shape an older build left behind: the same round, plus the
    // `approval` text that the tool used to take and write. The field is gone
    // from the record now, and a stored value is read as it stands.
    await test.runtime.harness.commit(async (tx) => {
      const doc = (await tx.doc(SecRestartRound, conversation.id, ROUND_KEY, ROUND_KEY)) as RestartRoundRecord & {
        approval?: string;
      };
      doc.approval = "operator approved";
      doc.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    const legacy = (await ledgerOf(test, conversation)) as unknown as { approval?: string };
    expect(legacy.approval).toBe("operator approved");

    // Reading that value is not refused, and both tools that read the round work:
    // the count and the close run over the round, and the extra key rides along
    // untouched.
    const counted = await say(
      test,
      conversation,
      [callTool("restart_cascade_status", { roundId: opened.roundId }), ...answers()],
      "count the round",
    );
    expect(toolResult(rows(counted.entries))).toContain(`round "${opened.roundId}": 0/1 target(s) counted.`);

    const closed = await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: opened.roundId, note: "counted once" }), ...answers()],
      "close the round",
    );
    expect(toolResult(rows(closed.entries))).toContain(`round "${opened.roundId}" is closed.`);

    const after = (await ledgerOf(test, conversation)) as unknown as { approval?: string; closedAt: number };
    expect(after.closedAt).toBeGreaterThan(0);
    expect(after.approval).toBe("operator approved");
  });

  it("refuses to close a round this conversation never opened, and writes nothing", async () => {
    const { test, conversation } = await withRestart();
    const { entries } = await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: "R9", note: "nothing to close" }), ...answers()],
      "close the round",
    );
    expect(toolResult(rows(entries))).toContain("no restart round is recorded");
    // The refusal is not a write: reading an absent document inside a commit
    // would create the row the refusal is about.
    expect(
      await test.runtime.harness.snapshot(SecRestartRound, conversation.id, ROUND_KEY, BACKGROUND_CONTEXT),
    ).toBeUndefined();
  });

  it("counts a child whose log the scan could not finish as done without evidence", async () => {
    const { test, conversation } = await withRestart();
    const slow = await makeChild(test, conversation, "slow-one", "running");

    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open the round",
    );
    const round = await ledgerOf(test, conversation);

    // A log longer than the cap the next count runs under, and no reset in it.
    await test.runtime.harness.commit(async (tx) => {
      for (let n = 0; n < 6; n += 1) {
        await tx.appendEntry(SystemEntry, slow, { model: [{ role: "system", content: "" }] });
      }
    }, BACKGROUND_CONTEXT);

    // The cap is injectable for exactly this case: with 50000 entries no test
    // can reach the truncated path by writing a log.
    const saved = { ...DEFAULT_SCAN_CAPS };
    DEFAULT_SCAN_CAPS.limit = 2;
    DEFAULT_SCAN_CAPS.page = 2;
    let counted: { readonly entries: readonly EntryRecord[] };
    try {
      counted = await say(
        test,
        conversation,
        [callTool("restart_cascade_status", { roundId: round.roundId }), ...answers()],
        "count the round",
      );
    } finally {
      DEFAULT_SCAN_CAPS.limit = saved.limit;
      DEFAULT_SCAN_CAPS.page = saved.page;
    }

    const report = toolResult(rows(counted.entries));
    expect(report).toContain("1/1 target(s) counted");
    expect(report).toContain(": unconfirmed — ");
    expect(report).toContain(
      "Counted as finished without evidence: slow-one. The round does not wait for them: call `restart_session` with this round id, then close the round with `restart_cascade_close`.",
    );
    expect(report).not.toContain("already reset");
    // A child the scan cannot finish does not hold the round.
    expect(report).not.toContain("Not every target is counted");

    const after = await ledgerOf(test, conversation);
    expect(after.targets[0]!.verdict).toBe("unconfirmed");
    expect(after.targets[0]!.counted).toBe(true);
    expect(after.targets[0]!.reason).toContain("not read to the end");
    expect(after.targets[0]!.reason).toContain("without evidence");
    expect(await mirrorOf(test, conversation)).toEqual(after);

    // The close records what was never confirmed, and does not undo the count.
    await say(
      test,
      conversation,
      [callTool("restart_cascade_close", { roundId: round.roundId, note: "counted without evidence" }), ...answers()],
      "close the round",
    );
    const closed = await ledgerOf(test, conversation);
    expect(closed.unconfirmed).toEqual(["slow-one"]);
    expect(closed.targets[0]!.counted).toBe(true);
  });
});

describe("readiness from the entry log", () => {
  it("needs a pi.system after the pi.reset", () => {
    const loaded = readinessOf(
      [
        { id: 4, kind: "pi.assistant" },
        { id: 2, kind: "pi.reset" },
        { id: 3, kind: "pi.system" },
        { id: 5, kind: "pi.user" },
      ],
      1,
    );
    expect(loaded.ready).toBe(true);
    expect(loaded.resetId).toBe(2);
    expect(loaded.systemId).toBe(3);

    // A reset with no baseline after it is not enough: the context was cut, but
    // nothing proves the new prompt was read.
    const cut = readinessOf(
      [
        { id: 2, kind: "pi.reset" },
        { id: 3, kind: "pi.user" },
        { id: 4, kind: "pi.assistant" },
      ],
      1,
    );
    expect(cut.ready).toBe(false);
    expect(cut.reason).toContain("pi.system");

    // A baseline from before the round, or from before a later reset, is not it.
    const early = readinessOf(
      [
        { id: 1, kind: "pi.system" },
        { id: 2, kind: "pi.reset" },
        { id: 3, kind: "pi.assistant" },
        { id: 5, kind: "pi.reset" },
      ],
      0,
    );
    expect(early.ready).toBe(false);
    expect(early.resetId).toBe(2);

    const older = readinessOf(
      [
        { id: 1, kind: "pi.reset" },
        { id: 2, kind: "pi.system" },
      ],
      2,
    );
    expect(older.ready).toBe(false);
    expect(older.reason).toContain("no pi.reset");
  });

  it("reads the same log whatever order it arrives in", () => {
    const log = [
      { id: 7, kind: "pi.system" },
      { id: 6, kind: "pi.reset" },
      { id: 8, kind: "pi.user" },
    ];
    const ascending = readinessOf(log, 5);
    const descending = readinessOf([...log].reverse(), 5);
    expect(descending).toEqual(ascending);
    expect(ascending.ready).toBe(true);
  });

  it("stops a scan at the first baseline after the reset", async () => {
    const log: RoundLogEntry[] = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, kind: "pi.user" }));
    log[149] = { id: 150, kind: "pi.reset" };
    log[159] = { id: 160, kind: "pi.system" };
    const reader = logReaderOf(log, 100);

    const scan = await scanLog(reader.read, 0, { limit: 50_000, page: 100 });
    expect(scan.resetId).toBe(150);
    expect(scan.systemId).toBe(160);
    expect(scan.truncated).toBe(false);
    // Two pages, and the rest of the log is never read: the answer arrived, and
    // the 50000-entry cap is not what stopped it.
    expect(reader.pages()).toBe(2);
    expect(scan.count).toBe(200);
    expect(reader.served()).toBe(200);
    expect(verdictOf(scan).verdict).toBe("ready");
  });

  it("does not read a baseline from before the reset, and counts a cut scan anyway", async () => {
    // A tool run writes `pi.system` entries too, so a system entry that arrives
    // before the reset proves nothing about the prompt.
    const reader = logReaderOf(
      [
        { id: 1, kind: "pi.system" },
        { id: 2, kind: "pi.system" },
        { id: 3, kind: "pi.reset" },
        { id: 4, kind: "pi.user" },
      ],
      1000,
    );
    const scan = await scanLog(reader.read, 0, { limit: 50_000, page: 1000 });
    expect(scan.resetId).toBe(3);
    expect(scan.systemId).toBe(0);
    const waiting = verdictOf(scan);
    expect(waiting.verdict).toBe("waiting");
    expect(waiting.counted).toBe(false);
    expect(waiting.reason).toContain("pi.system");

    // The cap is the one thing that turns a log nobody finished reading into a
    // verdict, and that verdict is counted: a round that waited for it would
    // never close.
    const cut = verdictOf({ resetId: 0, systemId: 0, count: 2, truncated: true, limit: 2 });
    expect(cut.verdict).toBe("unconfirmed");
    expect(cut.counted).toBe(true);
    expect(cut.reason).toContain("without evidence");
  });
});

/**
 * A restart of the agent's own, taken because the conversation's context grew
 * long. It carries no round, so it opens none and blocks none, and its identity
 * is where the current session began rather than an id the model made up.
 */
describe("a restart of the agent's own", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function withRestart(): Promise<{ test: TestHarness; conversation: Conversation }> {
    const base = defaultConfig();
    const test = await createTestHarness({
      config: {
        agent: { extensions: { enabled: [...base.agent.extensions.enabled, "session-restart"] } },
      },
    });
    harness = test;
    return { test, conversation: await root(test) };
  }

  it("restarts the session and opens no round", async () => {
    const { test, conversation } = await withRestart();
    const continuation = "The context grew long. Continue from your state file.";

    const { status, entries } = await say(
      test,
      conversation,
      [
        callTool("restart_session", { reason: "the context grew long", continuation }),
        fauxAssistantMessage([fauxText("after the restart")]),
      ],
      "go",
    );
    expect(status).toBe("done");

    const resets = entries.filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);
    // The handoff names what happened, and it does not say a prompt moved: none
    // did. It also carries the check for a reset that did not happen.
    const handoff = readMessage(entryText(resets[0]!));
    expect(handoff?.attrs["via"]).toBe("handoff");
    expect(handoff?.attrs["kind"]).toBe("context-length");
    expect(handoff?.body).toContain("[restart self]");
    expect(handoff?.body).toContain("because it was too long");
    expect(handoff?.body).toContain("call `restart_session` again with the same reason and no round id");
    expect(handoff?.body).not.toContain("system prompt changed");

    // The continuation is the first input of the new session, and it carries no
    // round.
    const after = await since(conversation, resets[0]!.id);
    const first = after.find((entry) => entry.kind === "pi.user");
    expect(first).toBeDefined();
    const stored = readMessage(entryText(first!));
    expect(stored?.body).toBe(continuation);
    expect(stored?.source).toBe("restart");
    expect(stored?.attrs["via"]).toBe("continuation");
    expect(stored?.attrs["round"]).toBeUndefined();

    // No round was opened: the record holds the request and no round id or start.
    const record = await ledgerOf(test, conversation);
    expect(record.roundId).toBe("");
    expect(record.startedAt).toBe(0);
    expect(record.targets).toEqual([]);
    expect(record.selfRoundId).toBe("self:0");
    expect(record.selfRequestedAt).toBeGreaterThan(0);
  });

  it("queues one continuation when the same session calls twice", async () => {
    const { test, conversation } = await withRestart();
    const continuation = "Continue from your state file.";
    const second = "Continue from the second call.";

    // Two calls in one assistant message: they run in the same tool round, so
    // neither can see the other's reset. Both compute the same identity, because
    // the identity is where this session began and neither can reset it first.
    const { entries } = await say(
      test,
      conversation,
      [
        fauxAssistantMessage(
          [
            fauxToolCall("restart_session", { reason: "the context grew long", continuation }),
            fauxToolCall("restart_session", { reason: "the context grew long", continuation: second }),
          ],
          { stopReason: "toolUse" },
        ),
        ...answers(),
      ],
      "go",
    );

    const resets = entries.filter((entry) => entry.kind === "pi.reset");
    expect(resets).toHaveLength(1);
    // One queued item, not two: the second call is the same submission, because
    // both computed the same request id from the session start. The two calls
    // run side by side, so either of them can be the one that is queued.
    const continuations = entries.filter(
      (entry) => entry.kind === "pi.user" && readMessage(entryText(entry))?.attrs["via"] === "continuation",
    );
    expect(continuations).toHaveLength(1);
    expect([continuation, second]).toContain(readMessage(entryText(continuations[0]!))?.body);
  });

  it("gives the new session its own identity, so a later restart works", async () => {
    // The identity is where the current session began, and a reset moves that
    // point. So the next restart of the new session is a new request rather than
    // a repeat of one already in the log, and a long conversation can restart
    // more than once.
    const { test, conversation } = await withRestart();
    const continuation = "Continue from your state file.";
    const call = callTool("restart_session", { reason: "the context grew long", continuation });

    await say(test, conversation, [call, ...answers()], "go");
    const first = (await ledgerOf(test, conversation)).selfRoundId;
    expect(first).toBe("self:0");

    await quiet(test, [conversation.id]);
    await say(test, conversation, [call, ...answers()], "go again");

    const entries = await log(conversation);
    expect(entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(2);
    const second = (await ledgerOf(test, conversation)).selfRoundId;
    expect(second).toMatch(/^self:[1-9]\d*$/);
    expect(second).not.toBe(first);
  });

  /** Restart once, then pad the new session with entries that start no session. */
  async function restartThenPad(test: TestHarness, conversation: Conversation, pad: number): Promise<string> {
    const call = callTool("restart_session", { reason: "the context grew long", continuation: "Continue from your state file." });
    await say(test, conversation, [call, ...answers()], "go");
    const first = (await ledgerOf(test, conversation)).selfRoundId;
    expect(first).toBe("self:0");
    await quiet(test, [conversation.id]);
    await test.runtime.harness.commit(async (tx) => {
      for (let n = 0; n < pad; n += 1) {
        await tx.appendEntry(SystemEntry, conversation.id, { model: [{ role: "system", content: "" }] });
      }
    }, BACKGROUND_CONTEXT);
    return first;
  }

  it("restarts again when the session start is more than 200 entries back", async () => {
    const { test, conversation } = await withRestart();
    const first = await restartThenPad(test, conversation, 250);
    const call = callTool("restart_session", { reason: "the context grew long", continuation: "Continue again." });
    const { entries } = await say(test, conversation, [call, ...answers()], "go again");

    const resets = (await log(conversation)).filter((entry) => entry.kind === "pi.reset");
    expect(JSON.stringify(entries)).not.toContain("already reset");
    expect(resets).toHaveLength(2);
    expect((await ledgerOf(test, conversation)).selfRoundId).toBe(`self:${resets[0]!.id}`);
    expect(first).toBe("self:0");
  });

  it("finds the session start across several pages", async () => {
    const { test, conversation } = await withRestart();
    await restartThenPad(test, conversation, 25);
    const saved = { ...DEFAULT_SCAN_CAPS };
    DEFAULT_SCAN_CAPS.page = 2;
    try {
      const call = callTool("restart_session", { reason: "the context grew long", continuation: "Continue again." });
      const { entries } = await say(test, conversation, [call, ...answers()], "go again");
      const resets = (await log(conversation)).filter((entry) => entry.kind === "pi.reset");
      expect(resets).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain("already reset");
      expect((await ledgerOf(test, conversation)).selfRoundId).toBe(`self:${resets[0]!.id}`);
    } finally {
      DEFAULT_SCAN_CAPS.limit = saved.limit;
      DEFAULT_SCAN_CAPS.page = saved.page;
    }
  });

  it("gives a new identity when the scan stops at its cap", async () => {
    const { test, conversation } = await withRestart();
    const first = await restartThenPad(test, conversation, 40);
    const saved = { ...DEFAULT_SCAN_CAPS };
    DEFAULT_SCAN_CAPS.page = 5;
    DEFAULT_SCAN_CAPS.limit = 10;
    try {
      const call = callTool("restart_session", { reason: "the context grew long", continuation: "Continue again." });
      const { entries } = await say(test, conversation, [call, ...answers()], "go again");
      expect((await log(conversation)).filter((entry) => entry.kind === "pi.reset")).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain("already reset");
      const second = (await ledgerOf(test, conversation)).selfRoundId;
      expect(second).toMatch(/^self:[1-9]\d*$/);
      expect(second).not.toBe("self:0");
      expect(second).not.toBe(first);
    } finally {
      DEFAULT_SCAN_CAPS.limit = saved.limit;
      DEFAULT_SCAN_CAPS.page = saved.page;
    }
  });

  it("queues one continuation for two calls in a session that began more than 200 entries back", async () => {
    const { test, conversation } = await withRestart();
    await restartThenPad(test, conversation, 250);
    await say(
      test,
      conversation,
      [
        fauxAssistantMessage(
          [
            fauxToolCall("restart_session", { reason: "the context grew long", continuation: "one" }),
            fauxToolCall("restart_session", { reason: "the context grew long", continuation: "two" }),
          ],
          { stopReason: "toolUse" },
        ),
        ...answers(),
      ],
      "go again",
    );
    const entries = await log(conversation);
    expect(entries.filter((entry) => entry.kind === "pi.reset")).toHaveLength(2);
    const continuations = entries.filter(
      (entry) => entry.kind === "pi.user" && readMessage(entryText(entry))?.attrs["via"] === "continuation",
    );
    expect(continuations).toHaveLength(2);
  });

  it("leaves the round fields alone, so a round can still open afterwards", async () => {
    const { test, conversation } = await withRestart();

    await say(
      test,
      conversation,
      [callTool("restart_session", { reason: "the context grew long", continuation: "carry on" }), ...answers()],
      "go",
    );
    expect((await ledgerOf(test, conversation)).startedAt).toBe(0);
    await quiet(test, [conversation.id]);

    // A round opens afterwards, which the restart of the agent's own did not
    // block: it opened none and closed none.
    await say(
      test,
      conversation,
      [callTool("restart_cascade_start", { reason: "the prompt moved" }), ...answers()],
      "open a round",
    );
    const opened = await ledgerOf(test, conversation);
    expect(opened.roundId).not.toBe("");
    expect(opened.startedAt).toBeGreaterThan(0);
  });
});
