import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecAgentChild, SecAgentHub, type AgentStatus } from "../src/documents.ts";
import { readMessage } from "../src/message-envelope.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { DraftStore } from "../src/reports/drafts.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The lifecycle of a subagent as its parent sees it: which model a spawn picks,
 * which jobs the root may hand over, when a parent waits on a working child, and
 * how a subagent finishes for good.
 *
 * Every conversation shares one faux model, so each test answers through one
 * factory that reads the conversation it is asked from. A brief carries a marker,
 * and a marker in a user message is what tells one agent from another.
 */
const CTX = BACKGROUND_CONTEXT;
const NUDGE_FRAGMENT = "You cannot end your turn by answering";

type Context = Parameters<FauxResponseFactory>[0];

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
    .join(" ");
}

function hasUser(context: Context, marker: string): boolean {
  return context.messages.some((message) => message.role === "user" && messageText(message).includes(marker));
}

function hasResult(context: Context, fragment: string): boolean {
  return context.messages.some((message) => message.role === "toolResult" && messageText(message).includes(fragment));
}

/**
 * The last message that is not a system one.
 *
 * The personality interview appends a request-scoped system message to the
 * root's first request while no personality is registered, and it sits after the
 * user's text. A script that answers the user's last words reads the last
 * non-system message instead.
 */
function last(context: Context): Message | undefined {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "system") return message;
  }
  return undefined;
}

function call(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function say(words: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(words)]);
}

const park = (): AssistantMessage => call("await_orders", { note: "waiting for orders" });

/** One factory, repeated, so no conversation can run the queue dry. */
function script(factory: FauxResponseFactory, count = 300): FauxResponseFactory[] {
  return Array.from({ length: count }, () => factory);
}

/**
 * The root's command is the last user message when it starts with `CMD`.
 *
 * The text is read through the envelope reader when it carries one. `message-tags`
 * wraps every user message, and the envelope's own tag spells "message", so
 * matching the command words against the raw text would answer yes to every
 * command.
 */
function command(context: Context): string | undefined {
  const message = last(context);
  if (message?.role !== "user") return undefined;
  const text = messageText(message);
  const words = readMessage(text)?.body ?? text;
  return words.includes("CMD:") ? words : undefined;
}

interface Row {
  readonly kind: string;
  readonly text: string;
}

async function rowsOf(harness: TestHarness, conversationId: ConversationId): Promise<Row[]> {
  const page = await harness.runtime.storage.scanEntries({ conversationId, order: "ascending" }, 500, undefined, CTX);
  return page.items.map((entry) => ({
    kind: entry.kind,
    text: ((entry.model ?? []) as Message[]).map(messageText).join("\n"),
  }));
}

function results(rows: readonly Row[]): string {
  return rows
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

/** Submit one input to the root and wait until that run settles. */
async function root(harness: TestHarness, content: string): Promise<string> {
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    CTX,
  );
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  return results(await rowsOf(harness, 1 as ConversationId));
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function childOf(harness: TestHarness, parent: ConversationId, name: string): Promise<ConversationId> {
  const index = await until(
    () => harness.runtime.harness.snapshot(SecAgentChild, parent, name, CTX),
    `the index entry of "${name}"`,
  );
  return Number(index.conversationId) as ConversationId;
}

async function statusOf(harness: TestHarness, conversationId: ConversationId): Promise<AgentStatus | undefined> {
  return (await harness.runtime.harness.snapshot(SecAgent, String(conversationId), CTX))?.status;
}

async function reachStatus(harness: TestHarness, conversationId: ConversationId, status: AgentStatus): Promise<void> {
  await until(
    async () => ((await statusOf(harness, conversationId)) === status ? true : undefined),
    `conversation ${conversationId} to be ${status}`,
  );
}

/** Whether a conversation still has a task that is not terminal. */
async function busy(harness: TestHarness, conversationId: ConversationId): Promise<boolean> {
  return await harness.runtime.subagents!.hasLiveTask(conversationId, CTX);
}

/** A promise the test opens by hand: the rendezvous a held child waits on. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("requiring a vmodel on every spawn", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function withRole(name: string): Promise<TestHarness> {
    const made = await createTestHarness();
    await mkdir(join(made.paths.promptsDir, "role"), { recursive: true });
    await writeFile(join(made.paths.promptsDir, "role", `${name}.md`), `the ${name} role`, "utf8");
    return made;
  }

  it("refuses a spawn with no vmodel, and creates nothing", async () => {
    // A role file exists under the name the old rule would have turned into a
    // vmodel key. It stands for nothing here: the model is named by the caller.
    harness = await withRole("worker");
    harness.faux.setResponses(
      script((context) =>
        command(context) !== undefined
          ? call("spawn_subagent", { name: "helper", roles: ["worker"], initialPrompt: "BRIEF helper" })
          : say("ok"),
      ),
    );
    const out = await root(harness, "CMD: spawn");
    expect(out).toContain("spawn_subagent");
    expect(out).toContain("vmodel");
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "helper", CTX)).toBeUndefined();
  });

  it("refuses a key that config.vmodels does not hold, and lists the keys", async () => {
    harness = await withRole("worker");
    harness.faux.setResponses(
      script((context) =>
        command(context) !== undefined
          ? call("spawn_subagent", { name: "helper", vmodel: "worker", roles: ["worker"], initialPrompt: "BRIEF helper" })
          : say("ok"),
      ),
    );
    const out = await root(harness, "CMD: spawn");
    expect(out).toContain('"worker" is not a vmodel key');
    expect(out).toContain("faux");
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "helper", CTX)).toBeUndefined();
  });
});

describe("which jobs the root may hand over", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** The root runs what its command says; every child parks at once. */
  function rootRuns(build: (words: string) => AssistantMessage): FauxResponseFactory[] {
    return script((context) => {
      if (hasUser(context, "BRIEF")) return park();
      const words = command(context);
      return words === undefined ? say("ok") : build(words);
    });
  }

  it("refuses a subjob and names its top-level job", async () => {
    harness = await createTestHarness();
    const top = await harness.runtime.jobs.create(CTX, { title: "top" });
    const sub = await harness.runtime.jobs.create(CTX, { title: "sub", parentId: top.id });
    harness.faux.setResponses(
      rootRuns(() => call("spawn_subagent", { name: "orch", vmodel: "faux", roles: [], initialPrompt: "BRIEF", jobId: sub.id })),
    );
    const out = await root(harness, "CMD: spawn");
    expect(out).toContain(`job ${sub.id} is a subjob of ${top.id}`);
    expect(out).toContain("top-level jobs only");
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "orch", CTX)).toBeUndefined();
  });

  it("refuses a second agent on one top-level job and names the first, and does not count a spawn without a job", async () => {
    harness = await createTestHarness();
    const top = await harness.runtime.jobs.create(CTX, { title: "top" });
    harness.faux.setResponses(
      rootRuns((words) =>
        words.includes("temp")
          ? call("spawn_subagent", { name: "temp", vmodel: "faux", roles: [], initialPrompt: "BRIEF temp" })
          : words.includes("first")
            ? call("spawn_subagent", { name: "orch", vmodel: "faux", roles: [], initialPrompt: "BRIEF orch", jobId: top.id })
            : call("spawn_subagent", { name: "orch2", vmodel: "faux", roles: [], initialPrompt: "BRIEF orch2", jobId: top.id }),
      ),
    );
    // A worker the root starts without a job holds no job, so it does not stand
    // in the way of the job's own agent.
    expect(await root(harness, "CMD: temp")).toContain('started "temp"');
    expect(await root(harness, "CMD: first")).toContain('started "orch"');
    const orchId = await childOf(harness, 1 as ConversationId, "orch");
    await reachStatus(harness, orchId, "waiting");

    // A parked agent still holds its job: waiting is not ended.
    const out = await root(harness, "CMD: second");
    expect(out).toContain(`job ${top.id} is already held by "orch" (conversation ${orchId})`);
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "orch2", CTX)).toBeUndefined();
    const hub = await harness.runtime.harness.snapshot(SecAgentHub, CTX);
    expect(hub?.live).toBe(2);
  });

  it("lets only one of two spawns of the same job in one tool round through", async () => {
    harness = await createTestHarness();
    const top = await harness.runtime.jobs.create(CTX, { title: "top" });
    harness.faux.setResponses(
      rootRuns(() =>
        fauxAssistantMessage(
          [
            fauxToolCall("spawn_subagent", { name: "a", vmodel: "faux", roles: [], initialPrompt: "BRIEF a", jobId: top.id }),
            fauxToolCall("spawn_subagent", { name: "b", vmodel: "faux", roles: [], initialPrompt: "BRIEF b", jobId: top.id }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
    );
    const out = await root(harness, "CMD: both");
    const started = out.match(/started "(a|b)"/g) ?? [];
    expect(started.length).toBe(1);
    expect(out).toContain("is already held by");
  });

  it("lets an agent that holds a job start a worker on the same job", async () => {
    harness = await createTestHarness();
    const top = await harness.runtime.jobs.create(CTX, { title: "top" });
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF-W")) return park();
        if (hasUser(context, "BRIEF-O")) {
          if (!hasResult(context, 'started "w"')) {
            return call("spawn_subagent", { name: "w", vmodel: "faux", roles: [], initialPrompt: "BRIEF-W", jobId: top.id });
          }
          const message = last(context);
          if (message?.role === "toolResult" && messageText(message).includes("await_orders was refused")) {
            return say("waiting for w");
          }
          return park();
        }
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "o", vmodel: "faux", roles: [], initialPrompt: "BRIEF-O", jobId: top.id });
      }),
    );
    expect(await root(harness, "CMD: spawn")).toContain('started "o"');
    const orchId = await childOf(harness, 1 as ConversationId, "o");
    const workerId = await childOf(harness, orchId, "w");
    // The spawn commits the child's index entry while the tool still runs, and
    // the tool result reaches the parent's transcript only when the call settles.
    // The index can therefore be found before the result, so the result is
    // waited for, not read once.
    const out = await until(async () => {
      const text = results(await rowsOf(harness!, orchId));
      return text.includes('started "w"') ? text : undefined;
    }, 'the orchestrator\'s result for "w"');
    expect(out).toContain('started "w"');
    const worker = await harness.runtime.harness.snapshot(SecAgent, String(workerId), CTX);
    expect(worker?.jobId).toBe(top.id);
    await reachStatus(harness, orchId, "waiting");
  });
});

describe("a parent waits on a working child", () => {
  let harness: TestHarness | undefined;
  let held: ReturnType<typeof gate> | undefined;

  afterEach(async () => {
    // A held child must be let go before the harness closes, or its request
    // would keep the close waiting.
    held?.open();
    held = undefined;
    await harness?.close();
    harness = undefined;
  });

  it("returns a woken agent to running", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) return park();
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("order")
          ? call("send_message", { to: "c", body: "one more thing", kind: "order" })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await reachStatus(harness, childId, "waiting");

    expect(await root(harness, "CMD: order")).toContain("sent order to c");
    const changes = await until(async () => {
      const rows = (await readAuditTail(harness!.paths.auditLog, undefined, 500)).filter(
        (event) => event.type === "subagent_status" && event.conversationId === String(childId),
      );
      return rows.length >= 4 ? rows : undefined;
    }, "the child to work and park again");
    // The order woke the parked child, and its record said so.
    expect(changes.map((row) => row.status)).toEqual(["running", "waiting", "running", "waiting"]);
    expect(changes[2]!.previous).toBe("waiting");
  });

  it("ends a turn without a nudge and refuses await_orders while a child works, then parks once the child waits", async () => {
    harness = await createTestHarness();
    held = gate();
    const opened = held.opened;
    harness.faux.setResponses(
      script(async (context) => {
        if (hasUser(context, "BRIEF-W")) {
          // The worker's request is held open, so its generation task stays
          // live until the test opens the gate.
          await opened;
          return park();
        }
        if (hasUser(context, "BRIEF-O")) {
          if (!hasResult(context, 'started "w"')) {
            return call("spawn_subagent", { name: "w", vmodel: "faux", roles: [], initialPrompt: "BRIEF-W" });
          }
          const message = last(context);
          if (message?.role === "toolResult" && messageText(message).includes("await_orders was refused")) {
            return say("waiting for w");
          }
          return park();
        }
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "o", vmodel: "faux", roles: [], initialPrompt: "BRIEF-O" });
      }),
    );
    await root(harness, "CMD: spawn");
    const orchId = await childOf(harness, 1 as ConversationId, "o");
    const workerId = await childOf(harness, orchId, "w");

    // The orchestrator tried to park, was refused, answered, and its run ended.
    await until(async () => {
      const rows = await rowsOf(harness!, orchId);
      const answered = rows.some((row) => row.kind === "pi.assistant" && row.text.includes("waiting for w"));
      return answered && !(await busy(harness!, orchId)) ? true : undefined;
    }, "the orchestrator's turn to end");
    const before = await rowsOf(harness, orchId);
    expect(results(before)).toContain('await_orders was refused: "w" is still working');
    expect(before.some((row) => row.text.includes(NUDGE_FRAGMENT))).toBe(false);
    expect(await statusOf(harness, orchId)).toBe("running");
    expect(await statusOf(harness, workerId)).toBe("running");

    // The worker parks; its note wakes the orchestrator, which may park now
    // because a waiting child does not hold it.
    held.open();
    await reachStatus(harness, workerId, "waiting");
    await reachStatus(harness, orchId, "waiting");
    const after = await rowsOf(harness, orchId);
    expect(results(after)).toContain("Parked.");
    expect(after.some((row) => row.text.includes(NUDGE_FRAGMENT))).toBe(false);
  });
});

interface Seed {
  readonly name: string;
  readonly parent: string;
  readonly status: AgentStatus;
  readonly task?: "running" | "completed";
}

/**
 * One agent written straight into storage, with its name index and one task.
 *
 * A record that says `running` while its only task has ended is what a stop
 * from the screen leaves behind, and no run through the harness holds that
 * shape still long enough to be judged.
 */
async function seed(harness: TestHarness, spec: Seed): Promise<ConversationId> {
  const at = Date.now();
  let id = "";
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    const index = await tx.doc(SecAgentChild, Number(spec.parent) as ConversationId, spec.name, spec.name);
    index.name = spec.name;
    index.conversationId = id;
    index.createdAt = at;
    const record = await tx.doc(SecAgent, id, id);
    record.kind = "subagent";
    record.name = spec.name;
    record.parentConversationId = spec.parent;
    record.status = spec.status;
    record.createdAt = at;
    record.updatedAt = at;
  }, CTX);
  const conversationId = Number(id) as ConversationId;
  if (spec.task !== undefined) {
    const taskId = await harness.runtime.storage.mintId<TaskId>();
    const state =
      spec.task === "running"
        ? { status: "running", checkpoint: { phase: "execute" } }
        : { status: "terminal", outcome: { status: "completed", result: {} } };
    await commitWrites(harness.runtime.storage, [
        {
          type: "task",
          value: {
            id: taskId,
            conversationId,
            kind: "pi.generation",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            startedAt: at,
            ...(spec.task === "running" ? {} : { endedAt: at }),
            state,
          },
        } as unknown as StorageWrite,
      ],
      CTX,
    );
  }
  return conversationId;
}

describe("what counts as a working child", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("counts a running child with a live task, and not a waiting one or one stopped from outside", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    await seed(harness, { name: "live", parent: "1", status: "running", task: "running" });
    await seed(harness, { name: "parked", parent: "1", status: "waiting", task: "completed" });
    // Running on its record, nothing live behind it: a run the user stopped.
    await seed(harness, { name: "aborted", parent: "1", status: "running", task: "completed" });

    const working = await harness.runtime.subagents!.workingChildren(1 as ConversationId, CTX);
    expect(working.map((child) => child.name)).toEqual(["live"]);
  });

  it("counts a child whose own child works", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    const middle = await seed(harness, { name: "middle", parent: "1", status: "running", task: "completed" });
    await seed(harness, { name: "leaf", parent: String(middle), status: "running", task: "running" });

    const working = await harness.runtime.subagents!.workingChildren(1 as ConversationId, CTX);
    expect(working.map((child) => child.name)).toEqual(["middle"]);
  });

  it("keeps an agent that waits on a working child running through the boot repair", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, CTX);
    const waiter = await seed(harness, { name: "waiter", parent: "1", status: "running" });
    await seed(harness, { name: "worker", parent: String(waiter), status: "running", task: "running" });
    const idle = await seed(harness, { name: "idle", parent: "1", status: "running" });

    await harness.runtime.subagents!.reconcile(CTX);
    expect(await statusOf(harness, waiter)).toBe("running");
    // The control: the same shape with no working child is still repaired.
    expect(await statusOf(harness, idle)).toBeUndefined();
  });
});

describe("finishing a subagent", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("frees the slot and the name, gives the parent the final report, and refuses later messages", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) return call("finish_work", { note: "FINAL-REPORT all done" });
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("message")
          ? call("send_message", { to: "c", body: "anything else?" })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    const spawned = await root(harness, "CMD: spawn");
    // The child may finish before the index can be read, so its id comes from
    // the spawn result.
    const childId = Number(/started "c" \(conversation (\d+)/.exec(spawned)?.[1]) as ConversationId;
    expect(childId).toBeGreaterThan(1);
    await until(
      async () =>
        (await harness!.runtime.harness.snapshot(SecAgent, String(childId), CTX)) === undefined ? true : undefined,
      "the finished child to be released",
    );
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "c", CTX)).toBeUndefined();
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live ?? 0).toBe(0);

    const notes = (await harness.runtime.subagents!.inbox(1 as ConversationId, CTX)).filter(
      (message) => message.kind === "note",
    );
    const final = notes.find((message) => message.body.includes("FINAL-REPORT"));
    expect(final?.body).toContain('"c" finished its work and ended. Its slot and its name are free.');

    const statuses = (await readAuditTail(harness.paths.auditLog, undefined, 500)).filter(
      (event) => event.type === "subagent_status" && event.conversationId === String(childId),
    );
    expect(statuses.at(-1)?.status).toBe("stopped");
    expect(statuses.at(-1)?.note).toBe("finished");

    expect(await root(harness, "CMD: message")).toContain('no subagent named "c" here');
    // The name is free again.
    const again = await root(harness, "CMD: spawn again");
    expect(again.match(/started "c"/g)?.length).toBe(2);
  });

  it("is refused while a subagent remains, even one that waits for orders", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF-W")) return park();
        if (hasUser(context, "BRIEF-O")) {
          if (!hasResult(context, 'started "w"')) {
            return call("spawn_subagent", { name: "w", vmodel: "faux", roles: [], initialPrompt: "BRIEF-W" });
          }
          const message = last(context);
          if (message?.role === "toolResult" && messageText(message).includes("await_orders was refused")) {
            return say("waiting for w");
          }
          if (!hasResult(context, "finish_work was refused")) return call("finish_work", { note: "done" });
          return park();
        }
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "o", vmodel: "faux", roles: [], initialPrompt: "BRIEF-O" });
      }),
    );
    await root(harness, "CMD: spawn");
    const orchId = await childOf(harness, 1 as ConversationId, "o");
    await reachStatus(harness, orchId, "waiting");
    const out = results(await rowsOf(harness, orchId));
    expect(out).toContain("finish_work was refused: you still have subagent:w");
    expect(await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "o", CTX)).toBeDefined();
  });

  it("names the root agent and the user in a request's tail and in the reply result", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) {
          const token = /send_reply\("([^"]+)"/.exec(
            context.messages.map((message) => (message.role === "user" ? messageText(message) : "")).join("\n"),
          )?.[1];
          if (token === undefined) return park();
          return hasResult(context, "answered") ? park() : call("send_reply", { replyToken: token, body: "ANSWER" });
        }
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("ask")
          ? call("request_message", { to: "c", body: "a question", timeoutMs: 600_000 })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await reachStatus(harness, childId, "waiting");

    expect(await root(harness, "CMD: ask")).toContain("ANSWER");
    const rows = await rowsOf(harness, childId);
    const request = rows.find((row) => row.kind === "pi.user" && row.text.includes("a question"));
    expect(request?.text).toContain("This came from another agent, not from the user.");
    expect(results(rows)).toMatch(/answered the root agent \(/);
    expect(results(rows)).not.toContain("answered operator");
  }, 20_000);

  it("ends a waiting request_message at once when its target finishes", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) {
          return hasUser(context, "send_reply(") ? call("finish_work", { note: "leaving without an answer" }) : park();
        }
        const words = command(context);
        if (words === undefined) return say("ok");
        return words.includes("ask")
          ? call("request_message", { to: "c", body: "a question", timeoutMs: 600_000 })
          : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
      }),
    );
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await reachStatus(harness, childId, "waiting");

    // The deadline is ten minutes, so only the gone target can end this call
    // inside the test's time limit; the text says which way it ended.
    const out = await root(harness, "CMD: ask");
    expect(out).toContain('"c" has ended and its record is gone, so no answer is coming.');
  }, 20_000);

  /** The token a request handed out, read from the message the child received. */
  function tokenIn(context: Context): string {
    const message = context.messages.find((m) => m.role === "user" && messageText(m).includes('send_reply("'));
    return /send_reply\("([^"]+)"/.exec(message === undefined ? "" : messageText(message))?.[1] ?? "no-token";
  }

  /** A child that parks, and answers the request it holds when told ANSWER-NOW. */
  function lateAnswerer(timeoutMs: number): FauxResponseFactory[] {
    return script((context) => {
      if (hasUser(context, "BRIEF")) {
        // A message that arrives while this child works makes await_orders refuse.
        // The child then ends its turn without a tool call, as the refusal asks,
        // and the waiting message starts its next run.
        const end = last(context);
        if (end?.role === "toolResult" && messageText(end).includes("await_orders was refused: a message is waiting")) {
          return say("reading the waiting message");
        }
        if (!hasUser(context, "ANSWER-NOW") || hasResult(context, "withdrawn")) return park();
        return call("send_reply", { replyToken: tokenIn(context), body: "THE-LATE-ANSWER" });
      }
      const words = command(context);
      if (words === undefined) return say("ok");
      return words.includes("ask")
        ? call("request_message", { to: "c", body: "a question", timeoutMs })
        : call("spawn_subagent", { name: "c", vmodel: "faux", roles: [], initialPrompt: "BRIEF c" });
    });
  }

  async function tellChild(h: TestHarness, childId: ConversationId): Promise<string> {
    const conversation = await h.runtime.harness.conversation(childId, CTX);
    const submission = await conversation!.submit({ type: "input", content: "ANSWER-NOW" }, CTX);
    await submission.wait(CTX);
    return results(await rowsOf(h, childId));
  }

  const repliesOfRoot = async (h: TestHarness): Promise<number> =>
    (await h.runtime.subagents!.inbox(1 as ConversationId, CTX)).filter((message) => message.kind === "reply").length;

  it("withdraws a direct request at its deadline, so a late reply is refused and names send_message", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(lateAnswerer(300));
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await reachStatus(harness, childId, "waiting");

    expect(await root(harness, "CMD: ask")).toContain("The request was withdrawn, so c can no longer answer it.");
    const out = await tellChild(harness, childId);
    expect(out).toContain("was withdrawn: the root agent stopped waiting for the answer");
    expect(out).toContain("send_message");
    expect(out).not.toContain("answered the root agent");
    expect(await repliesOfRoot(harness)).toBe(0);
  }, 20_000);

  it("withdraws a direct request when its wait is aborted", async () => {
    harness = await createTestHarness();
    harness.faux.setResponses(lateAnswerer(600_000));
    await root(harness, "CMD: spawn");
    const childId = await childOf(harness, 1 as ConversationId, "c");
    await reachStatus(harness, childId, "waiting");

    const conversation = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      CTX,
    );
    const asking = await conversation.submit({ type: "input", content: "CMD: ask" }, CTX);
    await until(async () => {
      const inbox = await harness!.runtime.subagents!.inbox(childId, CTX);
      return inbox.some((message) => message.kind === "request") ? true : undefined;
    }, "the request to reach the child");
    await conversation.abort(CTX);
    await asking.wait(CTX).catch(() => undefined);
    await until(async () => {
      const inbox = await harness!.runtime.subagents!.inbox(childId, CTX);
      return inbox.some((message) => message.kind === "request" && message.status === "cancelled") ? true : undefined;
    }, "the withdrawal of the request");

    const out = await tellChild(harness, childId);
    expect(out).toContain("was withdrawn: the root agent stopped waiting for the answer");
    expect(out).not.toContain("answered the root agent");
    expect(await repliesOfRoot(harness)).toBe(0);
  }, 20_000);
});

describe("drafts for a job tree", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("accepts a draft for a subjob of the assigned job and refuses an unrelated job", async () => {
    harness = await createTestHarness();
    const top = await harness.runtime.jobs.create(CTX, { title: "top" });
    const mid = await harness.runtime.jobs.create(CTX, { title: "mid", parentId: top.id });
    const leaf = await harness.runtime.jobs.create(CTX, { title: "leaf", parentId: mid.id });
    const other = await harness.runtime.jobs.create(CTX, { title: "other" });
    harness.faux.setResponses(
      script((context) => {
        if (hasUser(context, "BRIEF")) {
          if (!hasResult(context, "draft ")) {
            return call("reports_draft", { jobId: leaf.id, title: "plan for the leaf", content: "the plan" });
          }
          if (!hasResult(context, "is neither")) {
            return call("reports_draft", { jobId: other.id, title: "elsewhere", content: "no" });
          }
          return park();
        }
        return command(context) === undefined
          ? say("ok")
          : call("spawn_subagent", { name: "o", vmodel: "faux", roles: [], initialPrompt: "BRIEF o", jobId: top.id });
      }),
    );
    await root(harness, "CMD: spawn");
    const orchId = await childOf(harness, 1 as ConversationId, "o");
    await reachStatus(harness, orchId, "waiting");
    const out = results(await rowsOf(harness, orchId));
    expect(out).toMatch(/draft \S+ written/);
    expect(out).toContain(`so its draft must name that job or one of its subjobs, and ${other.id} is neither`);
    const store = new DraftStore({
      harness: () => harness!.runtime.harness,
      paths: harness.paths,
      storage: harness.runtime.storage,
      audit: harness.runtime.audit,
    });
    const drafts = await store.list(CTX);
    expect(drafts.map((draft) => draft.jobId)).toEqual([leaf.id]);
  });
});
