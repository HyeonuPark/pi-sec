import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild } from "../src/documents.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AdminNotes } from "../src/runtime/notes.ts";
import type { PiSecEvent } from "../src/runtime/event-bus.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A job an agent works for without a handover.
 *
 * `spawn_subagent` names a job two ways. `jobId` hands the job over and moves its
 * owner to the child; `forJobId` is the same statement about what the agent is
 * doing, and the job keeps its owner. This is what lets a planner or a worker
 * light the Jobs panel for the job it was started for, which the handover alone
 * never did: the orchestrator role tells the parent not to hand a job to a
 * planner, so the marker stayed dark for the whole plan.
 *
 * The marker itself is the derived `working` list on `GET /api/jobs`, and the
 * events that make a page redraw it are the job announcements a run boundary
 * emits. Both are read here from the real server and the real bus.
 */

const CTX = BACKGROUND_CONTEXT;

/** Every control event this runtime emits, in order. */
function recordEvents(harness: TestHarness): PiSecEvent[] {
  const seen: PiSecEvent[] = [];
  harness.events.subscribe((event) => seen.push(event));
  return seen;
}

function jobEvents(seen: readonly PiSecEvent[], jobId: string): PiSecEvent[] {
  return seen.filter((event) => event.type === "job_updated" && event.data["id"] === jobId);
}

async function until<T>(check: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A gate that keeps one fake model request open, so a run stays live. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Whether the request comes from a subagent conversation. */
function fromSubagent(context: { messages: unknown[] }): boolean {
  return context.messages.some((message) => {
    const sections = (message as { sections?: Record<string, string> }).sections;
    return sections?.["agent-role"]?.includes("You are a subagent") === true;
  });
}

function spawnCall(args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("spawn_subagent", args)], { stopReason: "toolUse" });
}

function callTool(name: string, args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** Enough scripted answers that a spawned child cannot exhaust the queue. */
function answers(count = 40): FauxResponseFactory[] {
  return Array.from({ length: count }, () => () => fauxAssistantMessage([fauxText("ok")]));
}

/** One turn of the root conversation, driven by the scripted answers. */
async function rootTurn(harness: TestHarness, responses: Parameters<TestHarness["faux"]["setResponses"]>[0]): Promise<void> {
  harness.faux.setResponses(responses);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    CTX,
  );
  const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
  await submission.wait(CTX);
}

/** The `working` names of one job in `GET /api/jobs?shape=tree`. */
async function workingNames(origin: string, jobId: string): Promise<string[]> {
  const answer = (await (await fetch(`${origin}/api/jobs?shape=tree`)).json()) as {
    tree: { job: { id: string; working?: { name: string }[] }; children: unknown[] }[];
  };
  const found: string[] = [];
  const walk = (nodes: typeof answer.tree): void => {
    for (const node of nodes) {
      if (node.job.id === jobId) found.push(...(node.job.working ?? []).map((worker) => worker.name));
      walk(node.children as typeof answer.tree);
    }
  };
  walk(answer.tree);
  return found;
}

/** The same names in the flat `jobs` array, which is the other half of the route. */
async function flatWorkingNames(origin: string, jobId: string): Promise<string[]> {
  const answer = (await (await fetch(`${origin}/api/jobs`)).json()) as {
    jobs: { id: string; working?: { name: string }[] }[];
  };
  const job = answer.jobs.find((row) => row.id === jobId);
  return (job?.working ?? []).map((worker) => worker.name);
}

describe("a job an agent works for without a handover", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<{ origin: string; harness: TestHarness }> {
    const created = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    harness = created;
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime: created.runtime,
      bus: created.events,
      sse,
      streams: new StreamHub({ runtime: created.runtime, bus: created.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: created.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin, harness: created };
  }

  it("keeps the job's owner, lists the agent while it runs, and drops it when it parks", async () => {
    const { origin, harness: h } = await boot();
    const job = await h.runtime.jobs.create(CTX, { title: "a plan to write" });
    const owner = job.conversationId;
    expect(owner).toBeUndefined();
    const seen = recordEvents(h);
    const held = gate();

    // The child's first request is held open, so the run is live while the job
    // list is read. When the gate opens the child parks, which ends the run.
    await rootTurn(h, [
      spawnCall({ name: "planner", vmodel: "faux", roles: [], initialPrompt: "write the plan", forJobId: job.id }),
      (context: { messages: unknown[] }) =>
        fromSubagent(context)
          ? held.opened.then(() => callTool("await_orders", { note: "drafted" }))
          : fauxAssistantMessage([fauxText("ok")]),
      ...answers(),
    ]);

    const index = await h.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "planner", CTX);
    const childId = index!.conversationId;
    expect(childId).not.toBe("");

    // The link is on the agent, and the job still belongs to nobody.
    const record = await h.runtime.harness.snapshot(SecAgent, childId, CTX);
    expect(record?.forJobId).toBe(job.id);
    expect(record?.jobId).toBeUndefined();
    const stored = await h.runtime.jobs.get(CTX, job.id);
    expect(stored?.conversationId).toBeUndefined();
    // The handover is a link, not a status change, and neither is this.
    expect(stored?.status).toBe("planned");

    // While the child is driven, the job's derived list names it, in both shapes
    // of the same read.
    expect(await until(() => workingNames(origin, job.id).then((names) => (names.length > 0 ? names : undefined)), "the marker")).toEqual([
      "planner",
    ]);
    expect(await flatWorkingNames(origin, job.id)).toEqual(["planner"]);
    // The creation is announced, which is the event a page redraws on.
    expect((await until(() => (jobEvents(seen, job.id).length > 0 ? true : undefined), "the creation announcement"))).toBe(true);

    held.open();

    // The park ends the run, so the list empties and the park is announced.
    const before = jobEvents(seen, job.id).length;
    await until(
      async () => ((await workingNames(origin, job.id)).length === 0 ? true : undefined),
      "the marker to clear at the park",
    );
    await until(() => (jobEvents(seen, job.id).length > before ? true : undefined), "the park announcement");
    expect((await h.runtime.harness.snapshot(SecAgent, childId, CTX))?.status).toBe("waiting");
  });

  it("refuses a job that does not exist, and refuses both links together", async () => {
    const { harness: h } = await boot();
    const job = await h.runtime.jobs.create(CTX, { title: "one job" });

    const entries = await (async () => {
      h.faux.setResponses([
        spawnCall({ name: "ghost", vmodel: "faux", roles: [], initialPrompt: "work", forJobId: "20260101-00000000000000000000000000" }),
        spawnCall({ name: "both", vmodel: "faux", roles: [], initialPrompt: "work", jobId: job.id, forJobId: job.id }),
        ...answers(10),
      ]);
      const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, CTX);
      const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
      await submission.wait(CTX);
      return (await conversation.entries({}, 200, undefined, CTX)).items;
    })();
    const result = entries
      .filter((entry) => entry.kind === "pi.tool-result")
      .flatMap((entry) => (entry.model ?? []).map((message) => JSON.stringify((message as { content?: unknown }).content)))
      .join("\n");

    expect(result).toContain("no job 20260101-00000000000000000000000000");
    expect(result).toContain("not both");
    // Nothing was created for either name, and the job kept its owner.
    expect(await h.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "ghost", CTX)).toBeUndefined();
    expect(await h.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "both", CTX)).toBeUndefined();
    expect((await h.runtime.jobs.get(CTX, job.id))?.conversationId).toBeUndefined();
  });
});
