import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createInboxItemTx } from "../src/extensions/notify.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { Router } from "../src/server/router.ts";
import { registerInbox } from "../src/server/routes/inbox.ts";
import type { PiSecEvent } from "../src/runtime/event-bus.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The server-side writes that change a record a screen is showing.
 *
 * A write that leaves no event behind leaves the screen behind with it, so each
 * case here drives one real write — a handover, an archive sweep, a schedule
 * tick, an inbox read — and then looks for the event that write must emit. The
 * events are read from the runtime's own bus, which is the same one the SSE
 * endpoints publish from.
 */

/** Every control event this runtime emits, in order. */
function recordEvents(harness: TestHarness): PiSecEvent[] {
  const seen: PiSecEvent[] = [];
  harness.events.subscribe((event) => seen.push(event));
  return seen;
}

function first(seen: readonly PiSecEvent[], type: string): PiSecEvent | undefined {
  return seen.find((event) => event.type === type);
}

function withId(seen: readonly PiSecEvent[], type: string, id: unknown): PiSecEvent | undefined {
  return seen.find((event) => event.type === type && event.data["id"] === id);
}

/** Poll until the check answers; some writes announce themselves after they return. */
async function until<T>(check: () => T | undefined, what: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Enough scripted answers that a spawned child cannot exhaust the queue. */
function answers(count = 30): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** One turn of the root conversation, driven by scripted faux answers. */
async function rootTurn(
  harness: TestHarness,
  responses: ReturnType<typeof fauxAssistantMessage>[],
): Promise<void> {
  harness.faux.setResponses(responses);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
}

/** A tool round, which is what makes the harness offer the call to a tool task. */
function spawnCall(args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("spawn_subagent", args)], { stopReason: "toolUse" });
}

/** A scripted tool call of any name, driven the same way `spawnCall` is. */
function callTool(name: string, args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/**
 * Whether the request comes from a subagent conversation.
 *
 * The answer is read from the conversation's own identity section, because the
 * root gets a different one. Two conversations share a single scripted queue, so
 * this is what keeps the child from taking the root's next answer.
 */
function fromSubagent(context: { messages: unknown[] }): boolean {
  return context.messages.some((message) => {
    const sections = (message as { sections?: Record<string, string> }).sections;
    return sections?.["agent-role"]?.includes("You are a subagent") === true;
  });
}

/**
 * A script that leaves the child parked and lets the root answer.
 *
 * The child parks with `await_orders` and stays reachable, so a message is the
 * only thing that can start another run in it.
 */
function parkedChild(count: number): ((context: { messages: unknown[] }) => ReturnType<typeof fauxAssistantMessage>)[] {
  return Array.from({ length: count }, () => (context: { messages: unknown[] }) =>
    fromSubagent(context) ? callTool("await_orders", { note: "parked" }) : fauxAssistantMessage([fauxText("ok")]),
  );
}

/** The announcements of one job that are already on the bus. */
function jobEvents(seen: readonly PiSecEvent[], jobId: string): PiSecEvent[] {
  return seen.filter((event) => event.type === "job_updated" && event.data["id"] === jobId);
}

/** Just enough `ServerResponse` for a JSON answer: the status and the body. */
class StubResponse {
  status = 0;
  body = "";
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  end(payload?: string): this {
    this.body = payload ?? "";
    return this;
  }
}

describe("job and inbox events", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("announces a job handover, and leaves the status alone", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "handover" });
    const seen = recordEvents(harness);

    await rootTurn(harness, [
      spawnCall({ name: "worker", vmodel: "faux", roles: [], initialPrompt: "work", jobId: job.id }),
      ...answers(),
    ]);

    const announced = await until(() => withId(seen, "job_updated", job.id), "the handover announcement");
    const stored = await harness.runtime.jobs.get(BACKGROUND_CONTEXT, job.id);
    expect(stored?.conversationId).toBeTypeOf("string");
    // The event carries the committed record, not the record before the commit.
    expect(announced.data["conversationId"]).toBe(stored?.conversationId);
    // A handover is a link, not a start: the status is untouched.
    expect(stored?.status).toBe("planned");
    expect(announced.data["status"]).toBe("planned");
  });

  it("announces the run that a message waking a parked child starts", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "handover" });
    const seen = recordEvents(harness);
    const brief = { name: "worker", vmodel: "faux", roles: [], initialPrompt: "work", jobId: job.id };

    // The child parks, so the two boundaries of its first run are the handover
    // link and the park, and both are already announced when the turn is over.
    await rootTurn(harness, [spawnCall(brief), ...parkedChild(30)]);
    await until(
      () => (jobEvents(seen, job.id).length >= 2 ? jobEvents(seen, job.id) : undefined),
      "the child's park to be announced",
    );
    const before = jobEvents(seen, job.id).length;

    // A parked child is woken by a message and by nothing else, so the note the
    // root sends starts a run that no job write is behind.
    await rootTurn(harness, [callTool("send_message", { to: "worker", body: "keep going", kind: "note" }), ...parkedChild(30)]);

    // Both boundaries of that run have to reach the list: the start, which no
    // job write announces, and the park that ends it. Without the first, a page
    // drawn before the note keeps the child absent for the whole run.
    await until(
      () => (jobEvents(seen, job.id).length >= before + 2 ? jobEvents(seen, job.id) : undefined),
      "the run the note started and the park that ended it",
    );
    expect(jobEvents(seen, job.id).length).toBe(before + 2);
  });

  it("announces the park that ends a run", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "handover" });
    const seen = recordEvents(harness);

    await rootTurn(harness, [
      spawnCall({ name: "worker", vmodel: "faux", roles: [], initialPrompt: "work", jobId: job.id }),
      ...parkedChild(30),
    ]);

    // The link is one boundary and the park is the other. A park changes no
    // field of the job, so without an event of its own the list would keep the
    // marker it drew while the run was live.
    await until(
      () => (jobEvents(seen, job.id).length >= 2 ? jobEvents(seen, job.id) : undefined),
      "the park to be announced",
    );
    expect(jobEvents(seen, job.id).length).toBe(2);
  });

  it("announces every job the archive sweep moved out", async () => {
    harness = await createTestHarness({
      // The sweep is driven by hand here; the daily timer is `archive-schedule.test.ts`'s
      // subject. Every field of `archive` is written out because the harness
      // replaces the whole key when a test passes one.
      config: { archive: { enabled: true, afterDays: 0, sweepAt: "05:00" } },
    });
    const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "old" });
    await harness.runtime.jobs.update(BACKGROUND_CONTEXT, job.id, { status: "done" });
    const seen = recordEvents(harness);

    const report = await harness.runtime.archivist.run();
    expect(report?.archived).toEqual([job.id]);
    // The row is gone from the live store, which is what the event tells a page.
    expect(await harness.runtime.jobs.get(BACKGROUND_CONTEXT, job.id)).toBeUndefined();

    const announced = await until(() => withId(seen, "job_updated", job.id), "the archive announcement");
    expect(announced.data["status"]).toBe("done");
  });

  it("announces a schedule job's creation and its run", async () => {
    harness = await createTestHarness({
      config: {
        scheduler: {
          enabled: true,
          tickMs: 30_000,
          timezone: "UTC",
          // Every optional field is written out, the shape `docs/runtime-layout.md`
          // shows. The reconciler copies only the fields an entry has, so omitting
          // one would also work; the full entry is kept because it is what the
          // documentation shows an operator writing.
          jobs: [
            {
              name: "nightly",
              schedule: "* * * * *",
              timezone: "UTC",
              catchUp: "skip",
              overlap: "skip",
              prompt: "work",
            },
          ],
        },
      },
      responses: answers(),
    });
    const seen = recordEvents(harness);

    await harness.runtime.scheduler.tick(Date.now());

    const created = await until(() => first(seen, "job_created"), "the scheduler's job_created");
    expect(created.data["origin"]).toBe("scheduler");
    expect(created.data["labels"]).toEqual(["schedule:nightly"]);

    const updated = await until(
      () => withId(seen, "job_updated", created.data["id"]),
      "the scheduler's job_updated",
    );
    const stats = updated.data["stats"] as { runs?: number } | undefined;
    expect(stats?.runs).toBe(1);
  });

  it("announces an inbox item that was marked read", async () => {
    harness = await createTestHarness();
    const item = await harness.runtime.harness.commit(
      (tx) => createInboxItemTx(tx, { title: "Brief", body: "All good" }),
      BACKGROUND_CONTEXT,
    );
    const seen = recordEvents(harness);

    // The real handler, registered on the real router and matched the way the
    // server matches it. Only the response object is a stub, because nothing here
    // needs a listening socket. `registerInbox` reads the inbox and the event
    // sink and nothing else, so the streaming fields of `AppDeps` are left out on
    // purpose: it keeps this file off the streaming module.
    const router = new Router();
    registerInbox(router, { runtime: harness.runtime, bus: harness.events } as unknown as AppDeps);
    const matched = router.match("POST", `/api/inbox/${item.id}/read`);
    expect(matched).toBeDefined();
    const res = new StubResponse();
    await matched!.handler({
      req: {} as IncomingMessage,
      res: res as unknown as ServerResponse,
      url: new URL(`http://localhost/api/inbox/${item.id}/read`),
      params: matched!.params,
      requestId: "job-events-test",
      body: undefined,
    });

    expect(res.status).toBe(200);
    const announced = await until(() => first(seen, "inbox_item"), "the read announcement");
    expect(announced.data["id"]).toBe(item.id);
    // The announcement is of the read state, not of the item as it was created.
    expect(announced.data["readAt"]).toBeTypeOf("number");
  });
});
