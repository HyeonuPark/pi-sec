import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  StorageWrite,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import type { AgentRecord, AgentStatus } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import type { SubagentHub } from "../src/extensions/subagents.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The gate that runs before the gate.
 *
 * A cold restart does not end a session: the conversation and its job records
 * survive it, and what it cuts is the turn in flight. So a parked child is no
 * reason to wait, and a working child is no reason to refuse — it is a reason to
 * tell that child to finish its block and park, and to come back later.
 *
 * The hub is stubbed, because what these tests are about is who gets told and
 * what the call reports, not how a message reaches an inbox: `test/subagents.test.ts`
 * covers that path. The tasks and conversations below are real storage, so the
 * live-task count is read the same way `diagnose_conversation` reads it.
 */

/**
 * The real gate runs `node_modules/.bin/tsc` and `vitest` in the workspace tree,
 * and the harness's workspace tree is an empty temporary directory, so every call
 * that gets past the checks below ends at the gate's own refusal. That is the
 * right answer for the guard tests, which read "reached the gate" as "was let
 * through". This file needs one more step: a call that passes has to write its
 * `restart_required` row, and the only way to pass here is to run the gate. So
 * the two commands are replaced for this file alone; the checks around them are
 * the ones under test.
 */
vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: async () => ({ typecheck: true, tests: true }),
  collectChangeText: async () => ({ text: "diff --git a/src/x.ts b/src/x.ts\n" }),
}));

const ctx = BACKGROUND_CONTEXT;

/** One note the hub stub was asked to send. */
interface Note {
  readonly to: string;
  readonly kind: string;
  readonly body: string;
}

/**
 * A hub stub whose child tree is given, and whose notes are kept in a list.
 *
 * `state.working` names the conversations the hub's park rule counts as working,
 * so `workingChildren` answers what the real hub would answer for them without
 * this file rebuilding the hub's own task reads.
 */
function stubHub(tree: Map<string, AgentRecord[]>): {
  readonly hub: SubagentHub;
  readonly notes: Note[];
  readonly state: { failDelivery: string | undefined; working: Set<string> };
} {
  const notes: Note[] = [];
  const state: { failDelivery: string | undefined; working: Set<string> } = {
    failDelivery: undefined,
    working: new Set<string>(),
  };
  const hub = {
    children: async (conversationId: ConversationId) => tree.get(String(conversationId)) ?? [],
    workingChildren: async (conversationId: ConversationId) =>
      (tree.get(String(conversationId)) ?? []).filter((child) => state.working.has(child.conversationId)),
    ownAsyncCalls: async () => [],
    backgroundOf: async () => [],
    nameOf: async () => ({ name: "operator", kind: "root" }),
    writeMessage: async (
      _ctx: Context,
      input: { readonly to: { readonly conversationId: string }; readonly kind: string; readonly body: string },
    ) => {
      notes.push({ to: input.to.conversationId, kind: input.kind, body: input.body });
      return {
        id: `message-${notes.length}`,
        from: { conversationId: "1", name: "operator", agentKind: "root" },
        to: input.to,
        kind: input.kind,
        body: input.body,
        bytes: input.body.length,
        status: "pending" as const,
        createdAt: Date.now(),
      };
    },
    deliver: async () =>
      state.failDelivery === undefined
        ? { delivered: true }
        : { delivered: false, problem: state.failDelivery },
  } as unknown as SubagentHub;
  return { hub, notes, state };
}

/** One agent record, with only the fields the check reads filled in. */
function agent(conversationId: string, status: AgentStatus, name: string): AgentRecord {
  return {
    conversationId,
    kind: "subagent",
    name,
    parentConversationId: "1",
    vmodel: "faux",
    roles: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("request_restart waits for its children to stand at a safe point", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    // The call records itself in the default conversation, so it has to exist.
    await resolveDefaultConversation(harness.runtime.harness, harness.runtime.getConfig(), harness.runtime.paths, ctx);
    return harness;
  }

  /** A conversation with no agent record and no task: a place to hang work on. */
  async function seedConversation(h: TestHarness): Promise<string> {
    let id = "";
    await h.runtime.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      id = String(conversation.id);
    }, ctx);
    return id;
  }

  /** One task on a conversation, in the state a check reads. */
  async function seedTask(h: TestHarness, conversationId: string, status: "running" | "terminal"): Promise<void> {
    const storage = h.runtime.storage;
    const taskId = await storage.mintId<TaskId>();
    const settle = status === "terminal";
    const write = {
      type: "task",
      value: {
        id: taskId,
        conversationId: Number(conversationId) as ConversationId,
        kind: "pi.generation",
        version: 1,
        input: {},
        background: false,
        abortRequested: false,
        startedAt: Date.now(),
        ...(settle ? { endedAt: Date.now() } : {}),
        state: settle
          ? { status: "terminal", outcome: { status: "completed", result: {} } }
          : { status, checkpoint: { phase: "execute" } },
      },
    } as unknown as StorageWrite;
    await commitWrites(storage, [write], ctx);
  }

  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: 1,
      commit: (change: (tx: never) => unknown, context: Context) =>
        h.runtime.harness.commit(change as never, context),
    } as unknown as ToolExecutionApi;
  }

  /**
   * The restart tool over this harness. The report store is left out on purpose:
   * the approval guard is `test/restart-approval-guard.test.ts`, and leaving it
   * out keeps these cases on the safe-point check alone.
   */
  function restartTool(subagents: SubagentHub | undefined): ToolRegistration {
    const runtime = harness!.runtime;
    const context = {
      getConfig: runtime.getConfig,
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      ...(subagents === undefined ? {} : { subagents }),
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  async function auditOf(h: TestHarness, type: string): Promise<AuditEvent[]> {
    return (await readAuditTail(h.paths.auditLog, undefined, 50)).filter((event) => event.type === type);
  }

  it("passes with no note when every child is parked", async () => {
    const h = await boot();
    const idle = await seedConversation(h);
    const { hub, notes } = stubHub(new Map([["1", [agent(idle, "waiting", "idle-child")]]]));

    const result = await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    // Parked is what the note asks for, so a parked child is not a reason to wait.
    expect(notes).toHaveLength(0);
    expect(textOf(result)).toContain("Gate passed");
    expect(await auditOf(h, "restart_refused")).toHaveLength(0);
  });

  it("tells one working child to stand at a safe point, and asks the user nothing yet", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub, notes } = stubHub(new Map([["1", [agent(child, "running", "agent-a")]]]));

    const result = await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    // One note, addressed to the child, asking it to park rather than to stop.
    expect(notes).toHaveLength(1);
    expect(notes[0]!.to).toBe(child);
    expect(notes[0]!.kind).toBe("note");
    expect(notes[0]!.body).toContain("await_orders");
    expect(notes[0]!.body).toContain("safe point");

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Restart NOT requested yet");
    expect(text).toContain("no request is recorded");
    expect(text).toContain("safe-point requests sent to 1 child conversation");
    expect(text).toContain(`conversation ${child}`);
    expect(text).toContain("live tasks: 1");
    expect(text).toContain("note sent now");

    // The user was not asked: no request is raised, and no passing row is
    // written either.
    expect(h.runtime.restart.status.required).toBe(false);
    expect(h.runtime.restart.status.ready).toBe(false);
    expect(await auditOf(h, "restart_required")).toHaveLength(0);

    // The wait is recorded as a refusal row, with one reason per child, so a
    // reader can tell it from the gate's own refusal without parsing prose.
    const rows = await auditOf(h, "restart_refused");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("agent");
    expect(rows[0]!.code).toBe("safe_point_waiting");
    expect(rows[0]!.title).toBe("batch");
    expect(rows[0]!.reasons).toEqual([expect.stringContaining("agent-a")]);
  });

  it("passes once the child has parked, and does not tell it again", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const record = agent(child, "running", "agent-a");
    const { hub, notes } = stubHub(new Map([["1", [record]]]));
    const tool = restartTool(hub);

    const first = await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(textOf(first)).toContain("safe-point requests sent to 1 child conversation");

    // The child parks: the work is gone, the record says `waiting`, and the
    // conversation is still a child of this one.
    record.status = "waiting";

    const second = await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(notes).toHaveLength(1);
    expect(textOf(second)).toContain("Gate passed");
    expect(h.runtime.restart.status.required).toBe(true);
  });

  it("does not send a second note while the same child is still working", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub, notes } = stubHub(new Map([["1", [agent(child, "running", "agent-a")]]]));
    const tool = restartTool(hub);

    await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    const again = await tool.execute({ title: "batch" } as never, execApi(h), ctx);

    // One note per episode: the second call says the note is already out, and
    // when, instead of writing into the child's inbox again.
    expect(notes).toHaveLength(1);
    const text = textOf(again);
    expect(text).toContain("Restart NOT requested yet");
    expect(text).toContain("note sent less than a minute ago");
    expect(text).not.toContain("note sent now");
  });

  it("says a recorded core change has raised no request yet, and leaves the need standing", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub } = stubHub(new Map([["1", [agent(child, "running", "late-child")]]]));
    // A core change was recorded, so a restart is needed; the gate has not
    // passed, so the user was never asked. Saying "a request is recorded"
    // here would tell the reader to wait for something nobody can act on.
    h.runtime.restart.requireRestart();
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: false });

    const result = await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    const text = textOf(result);
    expect(text).toContain("Restart NOT requested yet");
    expect(text).toContain("no request has gone to the user");
    expect(text).not.toContain("a request already went to the user");
    expect(text).not.toContain("operator");
    expect(text).not.toContain("no request is recorded");
    expect(text).toContain("This call raised no request");
    expect(text).toContain("Call request_restart again after each reports a safe point");
    // Waiting is not withdrawing: the need still stands, and it is still not ready.
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: false });
    expect((await auditOf(h, "restart_refused")).map((row) => row.code)).toEqual(["safe_point_waiting"]);
  });

  it("says the user already has a request, and leaves it ready", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub } = stubHub(new Map([["1", [agent(child, "running", "late-child")]]]));
    // The only state the user can act on: a core change recorded and a gate
    // that passed. The wait must neither deny it nor withdraw it.
    h.runtime.restart.requireRestart();
    h.runtime.restart.markReady();
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: true });

    const result = await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    const text = textOf(result);
    expect(text).toContain("Restart NOT requested again");
    expect(text).toContain("a request already went to the user");
    expect(text).not.toContain("no request is recorded");
    expect(text).not.toContain("no request has gone to the user");
    expect(text).not.toContain("operator");
    expect(text).toContain("This call raised no request");
    expect(text).toContain("Call request_restart again after each reports a safe point");
    expect(h.runtime.restart.status).toMatchObject({ required: true, ready: true });
    expect((await auditOf(h, "restart_refused")).map((row) => row.code)).toEqual(["safe_point_waiting"]);
  });

  it("forgets a child that left the tree, so a returning one is told again", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const tree = new Map([["1", [agent(child, "running", "comes-back")]]]);
    const { hub, notes } = stubHub(tree);
    const tool = restartTool(hub);

    await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(notes).toHaveLength(1);

    // The child is retired or deleted: the index no longer lists it, so this scan
    // has no entry for it. Its sent time has to go with it.
    tree.clear();
    const without = await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(textOf(without)).toContain("Gate passed");
    expect(notes).toHaveLength(1);

    // The same conversation is a child again. It is a new episode, so it is told
    // again instead of being silenced by a marker for a conversation that was gone.
    tree.set("1", [agent(child, "running", "comes-back")]);
    const back = await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(textOf(back)).toContain("safe-point requests sent to 1 child conversation");
    expect(notes).toHaveLength(2);
    expect(notes[1]!.to).toBe(child);
  });

  it("skips the check when a reason is given, and records it; an empty reason is refused", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub, notes } = stubHub(new Map([["1", [agent(child, "running", "stuck-child")]]]));
    const tool = restartTool(hub);

    const reason = "the child is stuck inside a tool that cannot reach a safe point";
    const bypassed = await tool.execute({ title: "batch", allowBusyReason: reason } as never, execApi(h), ctx);
    expect(notes).toHaveLength(0);
    expect(textOf(bypassed)).toContain("Gate passed");
    expect(h.runtime.restart.status.required).toBe(true);

    // The bypass is the one fact the user has to be able to find afterwards.
    const passing = await auditOf(h, "restart_required");
    expect(passing).toHaveLength(1);
    expect(passing[0]!.reasons).toEqual([
      `busy bypass: ${reason}`,
      `busy bypass skipped: stuck-child (conversation ${child})`,
    ]);

    const empty = await tool.execute({ title: "batch", allowBusyReason: "  " } as never, execApi(h), ctx);
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain("empty string");
    const rows = await auditOf(h, "restart_refused");
    expect(rows.map((row) => row.code)).toEqual(["busy_bypass_reason_invalid"]);
    expect(notes).toHaveLength(0);
  });

  it("follows the tree: a working grandchild is told too", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    const grandchild = await seedConversation(h);
    await seedTask(h, grandchild, "running");
    // The middle conversation is parked with no work of its own; only the
    // grandchild is holding a turn.
    const { hub, notes } = stubHub(
      new Map([
        ["1", [agent(child, "waiting", "middle-child")]],
        [child, [agent(grandchild, "running", "deep-worker")]],
      ]),
    );

    const result = await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.to).toBe(grandchild);
    const text = textOf(result);
    expect(text).toContain("safe-point requests sent to 1 child conversation");
    expect(text).toContain("deep-worker");
    expect(text).not.toContain("middle-child");
  });

  it("sends a working child the note it already got, word for word", async () => {
    const h = await boot();
    const child = await seedConversation(h);
    await seedTask(h, child, "running");
    const { hub, notes } = stubHub(new Map([["1", [agent(child, "running", "any-agent")]]]));

    await restartTool(hub).execute({ title: "batch" } as never, execApi(h), ctx);

    // A focused chat got a note of its own; this one did not move. A child ends
    // its turn, finishes, or parks, and the note names all three.
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(
      [
        '[restart gate] A cold restart of this daemon is being prepared for the change "batch".',
        "A cold restart cuts the turn in flight, so every conversation doing work has to stand at a safe point. You are one of them.",
        "Finish the block you are doing. Start no new work. Write your current state and the next step to your context file. Then do the one of these that fits:",
        "1. If a subagent of yours is still working, end your turn without a tool call. Its message starts your next turn; read this note again then.",
        "2. If the work you were given is done, end with the tool your role names for that: `finish_work` or `await_orders`.",
        "3. Otherwise, park with `await_orders` and tell your parent that you are at a safe point and where you stopped.",
      ].join("\n"),
    );
  });

  it("counts an agent that waits on a working child as busy, and passes once the child is done", async () => {
    const h = await boot();
    const orchestrator = await seedConversation(h);
    const worker = await seedConversation(h);
    // The orchestrator ended its turn to wait for its worker: its record still
    // says `running`, and it holds no task and no background call of its own.
    // Only the worker holds a turn.
    await seedTask(h, worker, "running");
    const workerRecord = agent(worker, "running", "busy-worker");
    const { hub, notes, state } = stubHub(
      new Map([
        ["1", [agent(orchestrator, "running", "waiting-orchestrator")]],
        [orchestrator, [workerRecord]],
      ]),
    );
    state.working.add(worker);
    const tool = restartTool(hub);

    const first = await tool.execute({ title: "batch" } as never, execApi(h), ctx);

    // Both are told: the worker to stand at a safe point, the orchestrator to
    // wait for the worker. Neither counts as parked.
    expect(first.isError).toBe(true);
    expect(notes.map((note) => note.to).sort()).toEqual([orchestrator, worker].sort());
    const text = textOf(first);
    expect(text).toContain("safe-point requests sent to 2 child conversations");
    expect(text).toContain("waiting-orchestrator");
    expect(text).toContain("busy-worker");
    expect(text).not.toContain("Gate passed");
    expect(h.runtime.restart.status.ready).toBe(false);

    // The worker parks and the hub no longer counts it as working. Now nothing
    // under the orchestrator is working, and the gate goes on.
    workerRecord.status = "waiting";
    state.working.delete(worker);
    const second = await tool.execute({ title: "batch" } as never, execApi(h), ctx);
    expect(textOf(second)).toContain("Gate passed");
  });
});
