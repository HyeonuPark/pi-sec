import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, type AgentKind } from "../src/documents.ts";
import { RestartLauncher } from "../src/runtime/restart-helper.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer, type TestServer } from "./server-helpers.ts";

/**
 * A reset empties the context its sub-agents report into, so both reset routes
 * refuse while one of them is working, unless the body says `force`.
 *
 * The working agents here are real: a seeded `sec.agent` record in a real
 * conversation, plus a run that the faux model holds open. So the "working" test
 * is the one the server makes in production, a `pi.live.run`, and nothing here
 * stubs it.
 */
const CTX = BACKGROUND_CONTEXT;

interface Booted {
  readonly origin: string;
  readonly deps: AppDeps;
  /** The conversation both routes are asked to reset. */
  readonly root: string;
}

describe("a reset while sub-agents are working", () => {
  let harness: TestHarness | undefined;
  let started: TestServer | undefined;
  let held: { readonly opened: Promise<void>; open(): void } | undefined;

  afterEach(async () => {
    held?.open();
    held = undefined;
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  /** A gate that keeps one fake model request open, so a run stays live. */
  function gate(): { readonly opened: Promise<void>; open(): void } {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  async function boot(): Promise<Booted> {
    harness = await createTestHarness({
      config: { server: { ...defaultConfig().server, port: 0 } },
    });
    held = gate();
    const opened = held.opened;
    const answer: FauxResponseFactory = async () => {
      await opened;
      return fauxAssistantMessage([fauxText("done")]);
    };
    harness.faux.setResponses(Array.from({ length: 20 }, () => answer));
    started = await startTestServer(harness);
    const conversation = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    return { origin: started.origin, deps: started.deps, root: String(conversation.id) };
  }

  /** One agent record in a conversation of its own, as the harness would write it. */
  async function seedAgent(
    parent: string,
    name: string,
    kind: AgentKind = "subagent",
    parentOf: string = parent,
  ): Promise<string> {
    let id = "";
    await harness!.runtime.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      id = String(conversation.id);
      const record = await tx.doc(SecAgent, id, id);
      record.kind = kind;
      record.name = name;
      record.parentConversationId = parentOf;
      record.status = "running";
    }, CTX);
    return id;
  }

  /**
   * Start a run in that conversation and return once the harness is driving it.
   *
   * The conversation needs an agent of its own first: a conversation with no
   * model answers nothing and its run ends at once, which would make every
   * "working" case here pass for the wrong reason.
   */
  async function startRun(id: string): Promise<void> {
    const conversation = await harness!.runtime.harness.conversation(Number(id) as ConversationId, CTX);
    if (conversation === undefined) throw new Error(`no conversation ${id}`);
    await conversation.configure(
      { model: { provider: "faux", modelId: harness!.faux.getModel().id }, thinkingLevel: "medium" },
      CTX,
    );
    void conversation.submit({ type: "input", content: "work" }, CTX);
    await until(
      async () =>
        (await harness!.runtime.harness.snapshot(LiveDoc, Number(id) as ConversationId, CTX))?.run === undefined
          ? undefined
          : true,
      `conversation ${id} to be driven`,
    );
  }

  /** A sub-agent of the conversation under test that is working right now. */
  async function workingChild(root: string, name: string): Promise<string> {
    const id = await seedAgent(root, name);
    await startRun(id);
    return id;
  }

  async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const reset = (booted: Booted, path: string, body: unknown = {}) =>
    fetch(`${booted.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** How many reset markers the conversation holds, which is what a reset appends. */
  async function resets(root: string): Promise<number> {
    const page = await harness!.runtime.storage.scanEntries(
      { conversationId: Number(root) as ConversationId, order: "ascending" },
      200,
      undefined,
      CTX,
    );
    return page.items.filter((entry) => entry.kind === "pi.reset").length;
  }

  async function waitsForReset(root: string): Promise<number> {
    return until(
      async () => {
        const count = await resets(root);
        return count > 0 ? count : undefined;
      },
      "the reset marker",
    );
  }

  const routes: readonly { readonly name: string; readonly path: (root: string) => string }[] = [
    { name: "POST /basic-chat/reset", path: () => "/basic-chat/reset" },
    { name: "POST /api/conversations/:id/reset", path: (root) => `/api/conversations/${root}/reset` },
  ];

  for (const route of routes) {
    describe(route.name, () => {
      it("refuses with 409 agents_working while a sub-agent works, and resets nothing", async () => {
        const booted = await boot();
        const child = await workingChild(booted.root, "w-child");

        const answer = await reset(booted, route.path(booted.root));
        expect(answer.status).toBe(409);
        const body = (await answer.json()) as {
          error: { code: string; message: string };
          agents: { conversationId: string; name: string }[];
        };
        expect(body.error.code).toBe("agents_working");
        expect(body.error.message).toBe("1 sub-agent is working");
        expect(body.agents).toEqual([{ conversationId: child, name: "w-child" }]);
        // Refused means nothing was written: the conversation keeps its context.
        expect(await resets(booted.root)).toBe(0);
      });

      it("counts a working grandchild under a child that waits for orders", async () => {
        const booted = await boot();
        const child = await seedAgent(booted.root, "orch-child");
        // The child is parked: its record exists and nothing drives it.
        const grandchild = await seedAgent(booted.root, "w-grandchild", "subagent", child);
        await startRun(grandchild);
        // The child really is parked: nothing drives it while its worker runs.
        const parked = await harness!.runtime.harness.snapshot(LiveDoc, Number(child) as ConversationId, CTX);
        expect(parked?.run).toBeUndefined();

        const answer = await reset(booted, route.path(booted.root));
        expect(answer.status).toBe(409);
        const body = (await answer.json()) as { agents: { conversationId: string; name: string }[] };
        expect(body.agents).toEqual([{ conversationId: grandchild, name: "w-grandchild" }]);
        expect(await resets(booted.root)).toBe(0);
      });

      it("resets when the body carries force, and names the agent it keeps running", async () => {
        const booted = await boot();
        await workingChild(booted.root, "w-child");

        const answer = await reset(booted, route.path(booted.root), { force: true });
        expect(answer.status).toBe(202);
        expect(await waitsForReset(booted.root)).toBe(1);
      });

      it("resets at once when the only sub-agents wait for orders", async () => {
        const booted = await boot();
        await seedAgent(booted.root, "parked-one");
        await seedAgent(booted.root, "parked-two");

        const answer = await reset(booted, route.path(booted.root));
        expect(answer.status).toBe(202);
        expect(await waitsForReset(booted.root)).toBe(1);
      });

      it("does not count a working agent of another kind, or one under another conversation", async () => {
        const booted = await boot();
        // A scheduled run is not work under this conversation, even when its
        // record names the conversation as a parent.
        const scheduled = await seedAgent(booted.root, "nightly", "scheduled");
        await startRun(scheduled);
        // A sub-agent of a different conversation is not below this one either.
        const elsewhere = await seedAgent("999", "w-elsewhere");
        await startRun(elsewhere);
        // Both runs are live now, so the 202 below is the kind and the tree
        // saying no rather than liveness saying no.
        for (const id of [scheduled, elsewhere]) {
          const live = await harness!.runtime.harness.snapshot(LiveDoc, Number(id) as ConversationId, CTX);
          expect(live?.run).toBeDefined();
        }

        const answer = await reset(booted, route.path(booted.root));
        expect(answer.status).toBe(202);
        expect(await waitsForReset(booted.root)).toBe(1);
      });
    });
  }
});
