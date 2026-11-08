import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, type AssistantMessage, type FauxResponseFactory, type Message } from "@earendil-works/pi-ai";
import { InboxDoc, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecAgentChild, SecRestartRound, type AgentKind, type AgentStatus } from "../src/documents.ts";
import { readMessage } from "../src/message-envelope.ts";
import { ROUND_KEY, roundWatchRequestId } from "../src/extensions/session-restart.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { zoneMinute } from "../src/time-format.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The round watch: a restart round that stays open long enough earns its owner
 * one notice per half hour, naming who is still holding it.
 *
 * The tests write the round's `startedAt` and its targets themselves, so a half
 * hour is a value the test chooses rather than one it waits for, the same way the
 * idle notice test back-dates a child's `updatedAt`. Everything the notice reports
 * about a target is read from the store at the moment of the pass, so the tests
 * compare it with what the store holds.
 */
const CTX = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const MINUTE = 60_000;

type Context = Parameters<FauxResponseFactory>[0];

interface Row {
  readonly kind: string;
  readonly text: string;
}

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
    .join("\n");
}

async function rowsOf(harness: TestHarness, conversationId: ConversationId): Promise<Row[]> {
  const page = await harness.runtime.storage.scanEntries({ conversationId, order: "ascending" }, 500, undefined, CTX);
  return page.items.map((entry) => ({ kind: entry.kind, text: ((entry.model ?? []) as Message[]).map(messageText).join("\n") }));
}

function textOf(rows: readonly Row[]): string {
  return rows.map((row) => row.text).join("\n");
}

/** A scripted answer for every request that is not held. Repeated, so no run drains the queue. */
function script(factory: FauxResponseFactory, count = 200): FauxResponseFactory[] {
  return Array.from({ length: count }, () => factory);
}

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * One sentence of answers, and a run that waits for `release` when the input
 * carries the marker.
 *
 * A held run is the only way to put a live task on a conversation, and a live
 * task is what the notice describes as "running" and what keeps the notice from
 * waking a working owner.
 */
function answersWithHold(marker: string, release: Promise<void>): FauxResponseFactory {
  return (context: Context) => {
    const held = context.messages.some((message) => message.role === "user" && messageText(message).includes(marker));
    if (!held) return fauxAssistantMessage([fauxText("ok")]);
    return release.then(() => fauxAssistantMessage([fauxText("released")])) as unknown as AssistantMessage;
  };
}

async function root(test: TestHarness): Promise<Conversation> {
  return await resolveDefaultConversation(test.runtime.harness, test.config, test.runtime.paths, CTX);
}

/** An ownerless conversation with the faux model, so a note delivered to it starts a run. */
async function makeConversation(test: TestHarness): Promise<Conversation> {
  const model = test.faux.getModel();
  return await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
    },
    CTX,
  );
}

/** Write one conversation's agent record, dated now. */
async function seedAgent(
  test: TestHarness,
  id: ConversationId,
  fields: {
    readonly kind: AgentKind;
    readonly name?: string;
    readonly status?: AgentStatus;
    readonly parentConversationId?: string;
  },
): Promise<void> {
  const now = Date.now();
  await test.runtime.harness.commit(async (tx) => {
    const record = await tx.doc(SecAgent, String(id), String(id));
    record.kind = fields.kind;
    record.name = fields.name ?? `agent-${id}`;
    record.vmodel = "faux";
    record.roles = [];
    record.status = fields.status ?? "running";
    record.createdAt = now;
    record.updatedAt = now;
    if (fields.parentConversationId !== undefined) record.parentConversationId = fields.parentConversationId;
  }, CTX);
}

interface SeatTarget {
  readonly name: string;
  readonly conversationId: string;
  /** The message id the round recorded, or `""` for a note that was never written. */
  readonly messageId?: string;
  readonly counted?: boolean;
  readonly verdict?: "waiting" | "ready" | "finished" | "unconfirmed";
}

/** Write one conversation's round document as the cascade would have left it. */
async function seedRound(
  test: TestHarness,
  ownerId: ConversationId,
  fields: {
    readonly roundId: string;
    readonly startedAt: number;
    readonly closedAt?: number;
    readonly targets: readonly SeatTarget[];
  },
): Promise<void> {
  await test.runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(SecRestartRound, ownerId, ROUND_KEY, ROUND_KEY);
    doc.roundId = fields.roundId;
    doc.reason = "the prompt moved";
    doc.startedAt = fields.startedAt;
    doc.closedAt = fields.closedAt ?? 0;
    doc.updatedAt = Date.now();
    doc.targets = fields.targets.map((target) => ({
      name: target.name,
      conversationId: target.conversationId,
      roles: [],
      sinceId: 0,
      messageId: target.messageId ?? "",
      verdict: target.verdict ?? (target.counted === true ? "ready" : "waiting"),
      counted: target.counted === true,
      reason: "",
      resetId: 0,
      systemId: 0,
      checkedAt: 0,
    }));
  }, CTX);
}

/** One delivery's submission, written straight into the store: the note never goes out. */
async function seedNote(test: TestHarness, conversationId: ConversationId, messageId: string): Promise<void> {
  await test.runtime.harness.commit(async (tx) => {
    await tx.createSubmission({
      conversationId,
      requestId: `agent-message:${messageId}`,
      type: "input",
      status: "queued",
    });
  }, CTX);
}

/** The `restart` inputs one conversation received from the watch, oldest first. */
async function watched(harness: TestHarness, conversationId: ConversationId): Promise<string[]> {
  const rows = await rowsOf(harness, conversationId);
  return rows
    .filter((row) => row.kind === "pi.user" && row.text.includes('via="round-watch"'))
    .map((row) => readMessage(row.text)?.body ?? "");
}

/** The `restart_round_watch` audit rows written so far. */
async function watchRows(harness: TestHarness): Promise<Record<string, unknown>[]> {
  const events = await readAuditTail(harness.paths.auditLog, undefined, 500);
  return events.filter((event) => event.type === "restart_round_watch") as Record<string, unknown>[];
}

/** A conversation whose run is held inside its first request, with a live task on it. */
async function holdRun(test: TestHarness, conversation: Conversation, marker: string): Promise<() => void> {
  const held = gate();
  test.faux.setResponses(script(answersWithHold(marker, held.opened)));
  await conversation.submit({ type: "input", content: `${marker}: start` }, CTX);
  // The task is on the list as soon as the run is admitted, so this needs no clock.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const inspection = await test.runtime.harness.inspect(CTX);
    const live = inspection.tasks.filter((task) => String(task.record.conversationId) === String(conversation.id));
    if (live.length > 0) return held.open;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`conversation ${conversation.id} never started a run`);
}

/** Wait until no live task is left on one conversation. */
async function idle(test: TestHarness, conversationId: ConversationId): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!(await test.runtime.subagents!.hasLiveTask(conversationId, CTX))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`conversation ${conversationId} never went idle`);
}

/** The live step of one conversation, as the sweep counts it. */
async function stepOf(test: TestHarness, conversationId: ConversationId): Promise<number | undefined> {
  const inspection = await test.runtime.harness.inspect(CTX);
  const live = inspection.tasks.filter((task) => String(task.record.conversationId) === String(conversationId));
  const starts = live.map((task) => task.record.startedAt).filter((at): at is number => typeof at === "number");
  return starts.length === 0 ? undefined : Math.min(...starts);
}

describe("an open restart round", () => {
  let harness: TestHarness | undefined;
  let release: (() => void) | undefined;

  afterEach(async () => {
    release?.();
    release = undefined;
    await harness?.close();
    harness = undefined;
  });

  /**
   * The owner is the root, and its round has one target that is working.
   *
   * The root is the interesting owner: the sweep skips a root record for every
   * other judgement, so the watch runs before that skip or the round a root opens
   * is never seen.
   */
  async function withOwnedRound(startedAt: number): Promise<{
    test: TestHarness;
    owner: Conversation;
    target: Conversation;
  }> {
    const test = await createTestHarness();
    harness = test;
    const owner = await root(test);
    await seedAgent(test, owner.id, { kind: "root", name: "operator", status: "running" });
    const target = await makeConversation(test);
    await seedAgent(test, target.id, { kind: "subagent", name: "worker", status: "running", parentConversationId: "1" });
    await seedRound(test, owner.id, {
      roundId: "01ROUNDWATCH00000000000000A",
      startedAt,
      targets: [{ name: "worker", conversationId: String(target.id), messageId: "01NOTE0000000000000000000A" }],
    });
    await seedNote(test, target.id, "01NOTE0000000000000000000A");
    return { test, owner, target };
  }

  it("tells the owner once when the round passes its first half hour", async () => {
    const { test, owner } = await withOwnedRound(Date.now() - 31 * MINUTE);

    await test.runtime.subagents!.sweep(CTX);

    const notices = await watched(test, owner.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[restart round 01ROUNDWATCH00000000000000A] This round has been open for 31 minutes");
    expect(notices[0]).toContain("1 of its 1 targets are not counted ready");
    expect(notices[0]).toContain(
      'Count the round again with `restart_cascade_status` and roundId "01ROUNDWATCH00000000000000A".',
    );
    expect(notices[0]).toContain("Nothing was stopped, deleted, or closed.");

    // The audit row carries four values.
    expect(await watchRows(test)).toEqual([
      expect.objectContaining({
        roundId: "01ROUNDWATCH00000000000000A",
        conversationId: String(owner.id),
        unready: 1,
        bucket: 1,
      }),
    ]);
  });

  it("says nothing before the first half hour", async () => {
    const { test, owner } = await withOwnedRound(Date.now() - 20 * MINUTE);

    await test.runtime.subagents!.sweep(CTX);

    expect(await watched(test, owner.id)).toEqual([]);
    expect(await watchRows(test)).toEqual([]);
  });

  it("does not repeat itself in the same half hour, and says it again in the next", async () => {
    const { test, owner, target } = await withOwnedRound(Date.now() - 31 * MINUTE);
    const subagents = test.runtime.subagents!;

    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(1);

    // Three more passes inside the same cell: the request id is the same, so the
    // harness refuses a second submission even if the process forgot it.
    for (let pass = 0; pass < 3; pass += 1) await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(1);
    expect(await watchRows(test)).toHaveLength(1);

    // A half hour later is another cell, and that cell owes its own notice. Only
    // the open instant moves; the target and its note stay as they were. The
    // first notice started a run in the owner, and a working owner is left to the
    // next pass, so this waits for it to finish first.
    await idle(test, owner.id);
    await seedRound(test, owner.id, {
      roundId: "01ROUNDWATCH00000000000000A",
      startedAt: Date.now() - 61 * MINUTE,
      targets: [{ name: "worker", conversationId: String(target.id), messageId: "01NOTE0000000000000000000A" }],
    });

    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(2);
    expect((await watchRows(test)).map((row) => row["bucket"])).toEqual([1, 2]);
    // The second notice is submitted under the new cell's request id, not the first one's.
    expect(roundWatchRequestId("01ROUNDWATCH00000000000000A", 2)).toBe(
      "restart-round-watch:01ROUNDWATCH00000000000000A:2",
    );
  });

  it("says nothing about a closed round, a counted round, or a round with no targets", async () => {
    const test = await createTestHarness();
    harness = test;
    const owner = await root(test);
    await seedAgent(test, owner.id, { kind: "root", name: "operator", status: "running" });
    const target = await makeConversation(test);
    await seedAgent(test, target.id, {
      kind: "subagent",
      name: "worker",
      status: "running",
      parentConversationId: "1",
    });

    // Closed.
    await seedRound(test, owner.id, {
      roundId: "01ROUNDCLOSED000000000000AA",
      startedAt: Date.now() - 90 * MINUTE,
      closedAt: Date.now() - 60 * MINUTE,
      targets: [{ name: "worker", conversationId: String(target.id), counted: true, verdict: "ready" }],
    });
    await test.runtime.subagents!.sweep(CTX);
    expect(await watched(test, owner.id)).toEqual([]);

    // Open, but every target is counted.
    await seedRound(test, owner.id, {
      roundId: "01ROUNDCOUNTED000000000000A",
      startedAt: Date.now() - 90 * MINUTE,
      targets: [{ name: "worker", conversationId: String(target.id), counted: true, verdict: "ready" }],
    });
    await test.runtime.subagents!.sweep(CTX);
    expect(await watched(test, owner.id)).toEqual([]);

    // Open with no target at all.
    await seedRound(test, owner.id, {
      roundId: "01ROUNDEMPTY00000000000000A",
      startedAt: Date.now() - 90 * MINUTE,
      targets: [],
    });
    await test.runtime.subagents!.sweep(CTX);
    expect(await watched(test, owner.id)).toEqual([]);
    expect(await watchRows(test)).toEqual([]);
  });

  it("holds the notice while a daemon restart request is up, and sends it once the request is withdrawn", async () => {
    const { test, owner } = await withOwnedRound(Date.now() - 31 * MINUTE);
    const subagents = test.runtime.subagents!;

    test.runtime.restart.requireRestart();
    test.runtime.restart.markReady();
    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toEqual([]);
    expect(await watchRows(test)).toEqual([]);

    test.runtime.restart.withdraw();
    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(1);
    expect(await watchRows(test)).toHaveLength(1);

    // One notice: the withdrawal earned it, not the hold.
    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(1);
  });

  it("leaves the notice to the next pass while the owner is working", async () => {
    const { test, owner } = await withOwnedRound(Date.now() - 31 * MINUTE);
    const subagents = test.runtime.subagents!;

    release = await holdRun(test, owner, "HOLD-OWNER");
    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toEqual([]);
    expect(await watchRows(test)).toEqual([]);

    // The owner ended its run and is idle: a notice is worth sending now.
    release();
    release = undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const live = await test.runtime.subagents!.hasLiveTask(owner.id, CTX);
      if (!live) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await subagents.sweep(CTX);
    expect(await watched(test, owner.id)).toHaveLength(1);
  });

  it("names each target's state, its step, the queue the note sits in, and its own open round", async () => {
    const test = await createTestHarness();
    harness = test;
    const owner = await root(test);
    await seedAgent(test, owner.id, { kind: "root", name: "operator", status: "running" });

    // A target held inside one long run, with a note that never left the queue.
    const busy = await makeConversation(test);
    await seedAgent(test, busy.id, { kind: "subagent", name: "busy", status: "running", parentConversationId: "1" });
    release = await holdRun(test, busy, "HOLD-TARGET");
    await seedNote(test, busy.id, "01NOTEBUSY0000000000000000A");

    // A target with a note and nothing to do.
    const parked = await makeConversation(test);
    await seedAgent(test, parked.id, { kind: "subagent", name: "parked", status: "waiting", parentConversationId: "1" });
    await seedNote(test, parked.id, "01NOTEPARKED00000000000000A");

    // A target whose record is gone, and one whose note the harness never took.
    const gone = await makeConversation(test);
    const fresh = await makeConversation(test);
    await seedAgent(test, fresh.id, { kind: "subagent", name: "fresh", status: "starting", parentConversationId: "1" });

    // The busy target owns an open round of its own with one target still out.
    const grandchild = await makeConversation(test);
    await seedRound(test, busy.id, {
      roundId: "01INNERROUND0000000000000A",
      startedAt: Date.now() - 5 * MINUTE,
      targets: [{ name: "grandchild", conversationId: String(grandchild.id), messageId: "01NOTEINNER00000000000000A" }],
    });
    await seedNote(test, grandchild.id, "01NOTEINNER00000000000000A");

    await seedRound(test, owner.id, {
      roundId: "01ROUNDSTATES0000000000000A",
      startedAt: Date.now() - 61 * MINUTE,
      targets: [
        { name: "busy", conversationId: String(busy.id), messageId: "01NOTEBUSY0000000000000000A" },
        { name: "parked", conversationId: String(parked.id), messageId: "01NOTEPARKED00000000000000A" },
        { name: "gone", conversationId: String(gone.id), messageId: "01NOTEGONE0000000000000000A" },
        { name: "fresh", conversationId: String(fresh.id) },
      ],
    });

    await test.runtime.subagents!.sweep(CTX);
    const notices = await watched(test, owner.id);
    expect(notices).toHaveLength(1);
    const body = notices[0]!;

    // The step's own start, in the harness zone, and the sentence that says the
    // run is older than it.
    const since = await stepOf(test, busy.id);
    expect(since).toBeDefined();
    expect(body).toContain(
      `- busy (conversation ${busy.id}): running. Its current step started at ${zoneMinute(since!, test.config.timezone)}`,
    );
    expect(body).toContain("The run that step belongs to started earlier.");
    expect(body).toContain("The note that asked it to join the round is still queued in its conversation.");
    expect(body).toContain("It has an open round of its own, with 1 target(s) not counted ready.");

    expect(body).toContain(`- parked (conversation ${parked.id}): waiting for orders. The note that asked it to join the round is still queued.`);
    expect(body).toContain(`- gone (conversation ${gone.id}): its agent record is gone.`);
    expect(body).toContain(
      `- fresh (conversation ${fresh.id}): its agent record is starting. The note that asked it to join the round was never accepted.`,
    );
    expect(body).toContain("4 of its 4 targets are not counted ready");

    // The notice changed nothing: every record and every round is as it was.
    for (const [id, status] of [
      [busy.id, "running"],
      [parked.id, "waiting"],
      [fresh.id, "starting"],
    ] as const) {
      expect((await test.runtime.harness.snapshot(SecAgent, String(id), CTX))?.status).toBe(status);
    }
    const inner = await test.runtime.harness.snapshot(SecRestartRound, busy.id, ROUND_KEY, CTX);
    expect(inner?.closedAt).toBe(0);
    expect(inner?.targets[0]?.counted).toBe(false);
  });

  it("delivers the notice to the owner as a `restart` input, and never to a target", async () => {
    const { test, owner, target } = await withOwnedRound(Date.now() - 31 * MINUTE);

    await test.runtime.subagents!.sweep(CTX);

    const ownerRows = await rowsOf(test, owner.id);
    const notice = ownerRows.find((row) => row.kind === "pi.user" && row.text.includes("This round has been open for"));
    expect(notice).toBeDefined();
    const parsed = readMessage(notice!.text);
    expect(parsed?.source).toBe("restart");
    expect(parsed?.format).toBe("envelope");
    expect(parsed?.attrs).toEqual(
      expect.objectContaining({ round: "01ROUNDWATCH00000000000000A", via: "round-watch" }),
    );

    // The target heard nothing: the harness is not a peer in the tree, and the
    // note that asked it to join came from its owner.
    expect(textOf(await rowsOf(test, target.id))).not.toContain("This round has been open for");
  });
});

describe("the round note", () => {
  let harness: TestHarness | undefined;
  let release: (() => void) | undefined;

  afterEach(async () => {
    release?.();
    release = undefined;
    await harness?.close();
    harness = undefined;
  });

  it("waits for the boundary between tool rounds when asked, and for the run's end by default", async () => {
    const test = await createTestHarness();
    harness = test;
    const owner = await makeConversation(test);
    const child = await makeConversation(test);
    release = await holdRun(test, child, "HOLD-CHILD");
    const hub = test.runtime.subagents!;

    const note = await hub.writeMessage(CTX, {
      from: { conversationId: String(owner.id), name: "owner", agentKind: "subagent" },
      to: { conversationId: String(child.id), name: "child", agentKind: "subagent" },
      kind: "note",
      body: "hello",
    });
    await hub.deliver(CTX, note, "steer");
    const steered = await test.runtime.harness.snapshot(InboxDoc, child.id, CTX);
    expect(steered?.items.map((item) => item.mode)).toEqual(["steer"]);

    // The same note on the default argument keeps what every delivery did before
    // the argument existed: the message waits for the end of the run.
    const other = await hub.writeMessage(CTX, {
      from: { conversationId: String(owner.id), name: "owner", agentKind: "subagent" },
      to: { conversationId: String(child.id), name: "child", agentKind: "subagent" },
      kind: "note",
      body: "hello again",
    });
    await hub.deliver(CTX, other);
    const both = await test.runtime.harness.snapshot(InboxDoc, child.id, CTX);
    expect(both?.items.map((item) => item.mode)).toEqual(["steer", "followUp"]);
  });

  it(
    "reaches a child inside one long run between two tool rounds",
    { timeout: 120_000 },
    async () => {
      const test = await createTestHarness();
      harness = test;
      const rootConversation = await root(test);
      const BRIEF = "BRIEF-CHILD";
      let notedAtRound = -1;
      let opened = false;
      let spawned = false;
      const factory: FauxResponseFactory = (context) => {
        const isChild = context.messages.some(
          (message) => message.role === "user" && messageText(message).includes(BRIEF),
        );
        if (!isChild) {
          const said = (marker: string): boolean =>
            context.messages.some((message) => message.role === "user" && messageText(message).includes(marker));
          if (said("OPEN-ROUND")) {
            if (opened) return fauxAssistantMessage([fauxText("opened")]);
            opened = true;
            return fauxAssistantMessage(
              [
                {
                  type: "toolCall",
                  id: "call-open-round",
                  name: "restart_cascade_start",
                  arguments: { reason: "the prompt moved" },
                },
              ],
              { stopReason: "toolUse" },
            );
          }
          // One spawn, and then prose: a second tool call in the same run would
          // only repeat the idempotent spawn and drain the script.
          if (spawned) return fauxAssistantMessage([fauxText("the child is working")]);
          spawned = true;
          return fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "call-spawn",
                name: "spawn_subagent",
                arguments: { name: "runner", vmodel: "faux", roles: [], initialPrompt: BRIEF },
              },
            ],
            { stopReason: "toolUse" },
          );
        }
        // The child keeps working, one tool round at a time, until it has read the
        // round note and finished two more rounds.
        const rounds = context.messages.filter((message) => message.role === "toolResult").length;
        const noted = context.messages.some(
          (message) => message.role === "user" && messageText(message).includes("[restart round"),
        );
        if (noted && notedAtRound < 0) notedAtRound = rounds;
        if (noted && rounds >= notedAtRound + 2) {
          return fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "call-park",
                name: "await_orders",
                arguments: { note: "READ-THE-ROUND-NOTE mid-run" },
              },
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [{ type: "toolCall", id: `call-work-${rounds}`, name: "bash", arguments: { command: "sleep 0.2; echo ROUND" } }],
          { stopReason: "toolUse" },
        );
      };
      test.faux.setResponses(Array.from({ length: 300 }, () => factory));

      const spawnRun = await rootConversation.submit({ type: "input", content: "start the child" }, CTX);
      await spawnRun.wait(CTX);
      // The child has to be inside its run before the round opens, or the note
      // would be placed at once and prove nothing about the boundary.
      const index = await until(
        () => test.runtime.harness.snapshot(SecAgentChild, ROOT, "runner", CTX),
        "the child index entry",
      );
      const childId = Number(index.conversationId) as ConversationId;
      await until(async () => {
        const rows = await rowsOf(test, childId);
        return rows.filter((row) => row.kind === "pi.tool-result").length >= 2 ? true : undefined;
      }, "the child to finish two tool rounds");

      const openRun = await rootConversation.submit({ type: "input", content: "OPEN-ROUND now" }, CTX);
      await openRun.wait(CTX);
      expect(textOf(await rowsOf(test, ROOT))).toContain("1 target(s)");

      const rows = await until(async () => {
        const found = await rowsOf(test, childId);
        const parked = found.some((row) => row.kind === "pi.tool-result" && row.text.includes("Parked."));
        return parked && textOf(found).includes("[restart round") ? found : undefined;
      }, "the child to read the note and park");

      const noteAt = rows.findIndex((row) => row.kind === "pi.user" && row.text.includes("[restart round"));
      expect(noteAt).toBeGreaterThan(0);
      // The note is one user message between two tool rounds of the one run the
      // child was already in: a tool result comes before it, and at least one more
      // comes after it before the child parks. A `followUp` note could not do
      // that, because nothing of that run would follow it.
      expect(rows.slice(0, noteAt).at(-1)?.kind).toBe("pi.tool-result");
      expect(rows.slice(noteAt + 1).filter((row) => row.kind === "pi.tool-result").length).toBeGreaterThanOrEqual(2);
      // One reset is not in the log: the child read the note and parked, which is
      // what the note asks for. It never restarted itself inside the run.
      expect(rows.filter((row) => row.kind === "pi.reset")).toHaveLength(0);
    },
  );
});

/** Wait for a value, or fail with what was being waited for. */
async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
