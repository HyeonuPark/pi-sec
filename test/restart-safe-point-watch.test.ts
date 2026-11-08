import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationId,
  StorageWrite,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecAgentChild, type AgentStatus } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createSelfEditExtension, restartWatchOf, type RestartWatchTrigger } from "../src/extensions/self-edit.ts";
import { readMessage } from "../src/message-envelope.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The notes the harness owes the root while a restart request is up.
 *
 * The restart state is the root's to write. What the harness does is notice that
 * a subagent went back to work after the gate passed, and say so, so the root can
 * withdraw the request before someone applies a restart in the middle of a turn.
 * These tests fire each event that can carry that fact, one at a time, and check
 * the note, its audit row, and that the state did not move.
 *
 * The gate itself runs `tsc` and `vitest` in the workspace tree, which is an empty
 * temporary directory here, so it is replaced for this file alone. What is under
 * test is what happens after a request went out.
 */
vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: async () => ({ typecheck: true, tests: true }),
  collectChangeText: async () => ({ text: "diff --git a/src/x.ts b/src/x.ts\n" }),
}));

const ctx = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const TITLE = "restart: tell the root when a subagent leaves the safe point";

const LOST = (name: string): string =>
  `[restart state] The restart request for "${TITLE}" is still up, but ${name} started working. ` +
  "The safe point no longer holds. Withdraw the request with withdraw_restart and tell the user that the restart must wait.";

const BACK =
  "[restart state] Every subagent is at a safe point again. " +
  "If the batch is closed, raise the restart request again with request_restart.";

/** One note in the root's conversation, as the model receives it. */
interface Found {
  readonly source: string;
  readonly via: string | undefined;
  readonly body: string;
}

describe("the restart request tells the root when the safe point moves", () => {
  let h: TestHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /**
   * The `request_restart` tool over this harness, with the runtime's own restart
   * state, hub, and harness.
   *
   * The report store is left out on purpose: the approval guard is
   * `test/restart-approval-guard.test.ts`, and leaving it out keeps these cases on
   * the watch alone. The restart state is the runtime's, so the watch this
   * extension registers is the one the hub and `async-tools` look up.
   */
  async function boot(responses?: ReturnType<typeof fauxAssistantMessage>[]): Promise<ToolRegistration> {
    h = await createTestHarness(responses === undefined ? {} : { responses });
    await resolveDefaultConversation(h.runtime.harness, h.runtime.getConfig(), h.runtime.paths, ctx);
    const runtime = h.runtime;
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
      harness: runtime.harness,
      subagents: runtime.subagents,
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  function execApi(): ToolExecutionApi {
    return {
      conversationId: ROOT,
      commit: (change: (tx: never) => unknown, context: Context) =>
        h!.runtime.harness.commit(change as never, context),
    } as unknown as ToolExecutionApi;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  /** Write one child of the root, with the hub's own index entry beside its record. */
  async function seedChild(name: string, status: AgentStatus): Promise<ConversationId> {
    let id = "";
    await h!.runtime.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      id = String(conversation.id);
      const record = await tx.doc(SecAgent, id, id);
      record.kind = "subagent";
      record.name = name;
      record.parentConversationId = String(ROOT);
      record.status = status;
      record.createdAt = 1;
      record.updatedAt = 1;
      const index = await tx.doc(SecAgentChild, ROOT, name, name);
      index.name = name;
      index.conversationId = id;
      index.createdAt = 1;
    }, ctx);
    return Number(id) as ConversationId;
  }

  /**
   * One task on a conversation, in the state the busy rule reads.
   *
   * A second call with the id of the first settles that task in place, which is
   * how a test moves a conversation from busy to safe without any event: a task
   * that ends announces nothing, and that silence is what the watch has to live
   * with.
   */
  async function seedTask(
    conversationId: ConversationId,
    status: "running" | "terminal",
    reuse?: TaskId,
  ): Promise<{ readonly id: TaskId }> {
    const storage = h!.runtime.storage;
    const taskId = reuse ?? (await storage.mintId<TaskId>());
    const settle = status === "terminal";
    const write = {
      type: "task",
      value: {
        id: taskId,
        conversationId,
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
    return { id: taskId };
  }

  /** Raise the request the way the root does: a gate that passes. */
  async function raise(tool: ToolRegistration): Promise<void> {
    const result = await tool.execute({ title: TITLE } as never, execApi(), ctx);
    expect(textOf(result)).toContain("Gate passed");
    expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: true });
  }

  /** Every `[restart state]` note in the root's conversation, oldest first. */
  async function notes(): Promise<Found[]> {
    const page = await h!.runtime.storage.scanEntries({ conversationId: ROOT, order: "descending" }, 200, undefined, ctx);
    const out: Found[] = [];
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "user") continue;
        const content = (message as { content?: unknown }).content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) => (part !== null && typeof part === "object" ? String((part as { text?: string }).text ?? "") : ""))
                  .join("")
              : "";
        const read = readMessage(text);
        if (read === undefined || !read.body.includes("[restart state]")) continue;
        out.push({ source: read.source, via: read.attrs["via"], body: read.body });
      }
    }
    return out.reverse();
  }

  async function rows(type: string): Promise<AuditEvent[]> {
    return (await readAuditTail(h!.paths.auditLog, undefined, 100)).filter((event) => event.type === type);
  }

  /** Wait until `check` answers, because a submitted note lands in the next run. */
  async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const bodies = async (): Promise<string[]> => (await notes()).map((note) => note.body);

  /** Wait until the root conversation holds no work, so the next input starts a run now. */
  async function idleRoot(): Promise<true | undefined> {
    const page = await h!.runtime.storage.scanTasks({ conversationId: ROOT, order: "descending" }, 50, undefined, ctx);
    return page.items.some((task) => task.state.status !== "terminal") ? undefined : true;
  }

  it("tells the root when a status change puts a subagent back to work, and leaves the state alone", async () => {
    const tool = await boot();
    const child = await seedChild("agent-a", "waiting");
    // The child is parked, so the gate passes and the request goes out.
    await raise(tool);
    await seedTask(child, "running");

    // The child's own status change is the event: it was parked, and it works again.
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});

    await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");
    const found = await notes();
    expect(found.map((note) => note.body)).toEqual([LOST("agent-a")]);
    // A `restart` input, not an agent message: the harness is not a peer in the tree.
    expect(found[0]!.source).toBe("restart");
    expect(found[0]!.via).toBe("safe-point-lost");

    const lost = await rows("restart_safe_point_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.title).toBe(TITLE);
    expect(lost[0]!.agent).toBe("agent-a");
    expect(lost[0]!.conversationId).toBe(ROOT);
    expect(lost[0]!.trigger).toBe("status");

    // The state is the root's: the note is the whole of the harness's part.
    expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: true });
  });

  it("tells the root once while the state stays lost", async () => {
    const tool = await boot();
    const child = await seedChild("agent-a", "waiting");
    await raise(tool);
    await seedTask(child, "running");

    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");

    // Three more events that all find a subagent working. A repeat would be three
    // more messages the root has to read for one fact.
    await h!.runtime.subagents!.setStatus(ctx, child, "waiting", {});
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    await h!.runtime.subagents!.setStatus(ctx, child, "stopped", {});
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});

    expect(await bodies()).toEqual([LOST("agent-a")]);
    expect(await rows("restart_safe_point_lost")).toHaveLength(1);
  });

  it("sees a subagent that is already running when a new model request starts", async () => {
    const tool = await boot();
    // A record that says `running` with nothing in flight is not busy, so the gate
    // passes; the work arrives afterwards, without any status change at all.
    const child = await seedChild("late-worker", "running");
    await raise(tool);

    await seedTask(child, "running");
    const handlers = h!.runtime.registry
      .snapshot()
      .installed()
      .flatMap((extension) =>
        (extension.hooks ?? [])
          .filter((registration) => registration.task === "pi.generation")
          .map((registration) => ({
            name: extension.name,
            handler: (
              registration.handlers as {
                beforeRequest?: (request: unknown, api: unknown, context: Context) => Promise<unknown>;
              }
            ).beforeRequest,
          })),
      );
    const subagents = handlers.find((each) => each.name === "subagents");
    expect(subagents?.handler).toBeTypeOf("function");
    await subagents!.handler!({ messages: [] }, { conversationId: child }, ctx);

    await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");
    expect(await bodies()).toEqual([LOST("late-worker")]);
    const lost = await rows("restart_safe_point_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.trigger).toBe("request");
    expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: true });
  });

  it("says the safe point is back once the root has withdrawn and every subagent has stopped", async () => {
    const tool = await boot();
    const child = await seedChild("agent-a", "waiting");
    await raise(tool);
    await seedTask(child, "running");
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");

    // The request is still up, so the second note stays unsent even though the
    // child parks: its wording invites a request, and one is already out.
    await h!.runtime.subagents!.setStatus(ctx, child, "waiting", {});
    expect(await bodies()).toEqual([LOST("agent-a")]);

    // The root takes its request back, and nothing is working any more: the safe
    // point holds again, and the root is the one who may raise the request.
    h!.runtime.restart.withdraw();
    await h!.runtime.subagents!.setStatus(ctx, child, "stopped", {});

    await until(async () => ((await notes()).length > 1 ? true : undefined), "the second note");
    const found = await notes();
    expect(found.map((note) => note.body)).toEqual([LOST("agent-a"), BACK]);
    expect(found[1]!.via).toBe("safe-point-back");
    const back = await rows("restart_safe_point_back");
    expect(back).toHaveLength(1);
    expect(back[0]!.title).toBe(TITLE);
    expect(back[0]!.conversationId).toBe(ROOT);
    expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: false });
  });

  it("judges nothing while no request is up, and nothing after the episode ends", async () => {
    const tool = await boot();
    const child = await seedChild("agent-a", "waiting");
    await seedTask(child, "running");

    // A core change is recorded, so a restart is needed, but no request has gone
    // to the user: there is nothing to withdraw, and no note is owed.
    h!.runtime.restart.requireRestart();
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    expect(await notes()).toEqual([]);
    expect(await rows("restart_safe_point_lost")).toHaveLength(0);

    // The child parks, so the gate passes and the request goes out.
    await h!.runtime.subagents!.setStatus(ctx, child, "waiting", {});
    await raise(tool);

    // Lost, then withdrawn, then safe again: the episode is over after the second
    // note, and a child that starts working afterwards earns nothing.
    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");
    h!.runtime.restart.withdraw();
    await h!.runtime.subagents!.setStatus(ctx, child, "waiting", {});
    await until(async () => ((await notes()).length > 1 ? true : undefined), "the second note");

    await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
    expect(await bodies()).toEqual([LOST("agent-a"), BACK]);
    expect(await rows("restart_safe_point_lost")).toHaveLength(1);
  });

  it(
    "judges a background call that starts and one that settles",
    async () => {
      // A real background call, because the two `async_call_*` events come from
      // one. It runs in the root's conversation on purpose: a call in a subagent
      // would deliver its result back into that subagent, which puts it to work
      // again before the harness can say the safe point is back.
      //
      // The first answer is for the run the first note starts in the root's
      // conversation, the second and third are for the turn that starts the call,
      // and the fourth is for the run that receives the settled result.
      const tool = await boot([
        fauxAssistantMessage([fauxText("noted")]),
        fauxAssistantMessage([fauxToolCall("async_call", { title: "slow", tool: "bash", args: { command: "sleep 1" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("started it")]),
        fauxAssistantMessage([fauxText("ok")]),
      ]);
      const child = await seedChild("background-worker", "waiting");
      await raise(tool);
      const task = await seedTask(child, "running");
      await h!.runtime.subagents!.setStatus(ctx, child, "running", {});
      await until(async () => ((await notes()).length > 0 ? true : undefined), "the first note");
      expect(await bodies()).toEqual([LOST("background-worker")]);

      // The root withdraws, and the child still holds a task, so the safe point
      // does not hold yet: the call that starts finds the tree busy and is silent.
      h!.runtime.restart.withdraw();
      await until(idleRoot, "the root conversation to finish the note's run");
      const conversation = await resolveDefaultConversation(
        h!.runtime.harness,
        h!.runtime.getConfig(),
        h!.runtime.paths,
        ctx,
      );
      const submitted = await conversation.submit({ type: "input", content: "start the slow call" }, ctx);
      await submitted.wait(ctx);
      expect(await bodies()).toEqual([LOST("background-worker")]);

      // The task ends. Nothing announces it: no status changed, so no event fires
      // here, and the tree is safe in silence.
      await seedTask(child, "terminal", task.id);

      // The call settling is the next event, and it finds every subagent safe.
      await until(async () => ((await notes()).length > 1 ? true : undefined), "the second note", 15_000);
      expect(await bodies()).toEqual([LOST("background-worker"), BACK]);
      const back = await rows("restart_safe_point_back");
      expect(back).toHaveLength(1);
      expect(back[0]!.trigger).toBe("async-settled");
      expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: false });
    },
    30_000,
  );

  it("judges each event kind the same way, and none of them writes the state", async () => {
    for (const trigger of ["status", "request", "async-started", "async-settled"] as RestartWatchTrigger[]) {
      const tool = await boot();
      const child = await seedChild("any-worker", "running");
      h!.runtime.restart.requireRestart();
      h!.runtime.restart.markReady();
      const watch = restartWatchOf(h!.runtime.restart);
      expect(watch, "the self-edit extension did not register a watch").toBeDefined();
      // Armed here rather than through the gate, because this case is about the
      // four triggers and not about what raises the request.
      watch!.arm({ conversationId: ROOT, title: TITLE });
      await seedTask(child, "running");

      await watch!.observe(ctx, trigger);

      await until(async () => ((await notes()).length > 0 ? true : undefined), `the ${trigger} note`);
      expect(await bodies()).toEqual([LOST("any-worker")]);
      const lost = await rows("restart_safe_point_lost");
      expect(lost).toHaveLength(1);
      expect(lost[0]!.trigger).toBe(trigger);
      // No trigger writes the state: the root's request is still exactly as it was.
      expect(h!.runtime.restart.status).toMatchObject({ required: true, ready: true });
      await h!.close();
      h = undefined;
    }
  });
});
