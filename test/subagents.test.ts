import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { AgentDoc, type Conversation, type ConversationId, type StorageWrite, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { contextPath } from "../src/agent/context-file.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild, SecAgentHub } from "../src/documents.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

interface Row {
  readonly kind: string;
  readonly text: string;
}

function rows(entries: readonly { kind: string; model?: unknown[] }[]): Row[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    text: (entry.model ?? [])
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
      .join("\n"),
  }));
}

function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

/** Enough scripted answers that a spawned child cannot exhaust the queue. */
function answers(count = 30): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

async function once(harness: TestHarness, responses: ReturnType<typeof fauxAssistantMessage>[]): Promise<Row[]> {
  harness.faux.setResponses(responses);
  const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
  const submission = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return rows(page.items);
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

function spawnCall(args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  // The stop reason is what makes the harness treat this as a tool round rather
  // than a final answer; without it the call is never offered to a tool task.
  return fauxAssistantMessage([fauxToolCall("spawn_subagent", args)], { stopReason: "toolUse" });
}

/** One text message of one model message, whatever shape its content has. */
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

/**
 * A script where the child parks and every other conversation answers.
 *
 * The brief carries a marker, and it reaches the child as a user message while
 * the parent only ever sees it inside its own tool-call arguments. That is what
 * tells the two apart, and it is what makes the response the child gets
 * deterministic instead of a race for the next item in one shared queue.
 */
function parkChildren(marker: string): FauxResponseFactory {
  return (context) =>
    context.messages.some((message) => message.role === "user" && messageText(message).includes(marker))
      ? fauxAssistantMessage([fauxToolCall("await_orders", { note: "waiting for orders" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("ok")]);
}

/** One submit round; the conversation's rows once the run has settled. */
async function round(harness: TestHarness, responses: FauxResponseStep[], content: string): Promise<Row[]> {
  harness.faux.setResponses(responses);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT);
  return rows(page.items);
}

describe("spawning a subagent", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  const OVER_LIMIT = "x".repeat(defaultConfig().agent.subagent.maxMessageBytes + 1);
  const REFUSALS: [string, Record<string, unknown>, string[]][] = [
    ["the reserved name", { name: "parent-agent" }, ["parent-agent", "reserved"]],
    ["a name that is not usable as a document key", { name: "../escape" }, ["not usable"]],
    ["a role with no prompt file and names the ones that exist", { roles: ["missing"] }, ["no role file", "Known roles"]],
    ["a brief over the size limit instead of truncating it", { initialPrompt: OVER_LIMIT }, ["the limit is", "Shorten it"]],
  ];

  it.each(REFUSALS)("refuses %s", async (_what, args, expected) => {
    harness = await createTestHarness();
    const entries = await once(harness, [
      spawnCall({ name: "researcher", vmodel: "faux", roles: [], initialPrompt: "work", ...args }),
      ...answers(),
    ]);
    for (const text of expected) expect(toolResult(entries)).toContain(text);
  });

  it("fails the spawn when the limit is full and creates nothing", async () => {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: { agent: { subagent: { ...base.agent.subagent, maxTotal: 0 } } },
    });
    const entries = await once(harness, [
      spawnCall({ name: "researcher", vmodel: "faux", roles: [], initialPrompt: "work" }),
      ...answers(),
    ]);
    expect(toolResult(entries)).toContain("the subagent limit is full");
    // Nothing was written: the refusal happens inside the creating commit, so the
    // name index has no entry at all and no slot was taken.
    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    expect(index).toBeUndefined();
    const hub = await harness.runtime.harness.snapshot(SecAgentHub, BACKGROUND_CONTEXT);
    expect(hub?.live ?? 0).toBe(0);
  });

  it("registers the child, is idempotent by name, and releases a finished child", async () => {
    harness = await createTestHarness();
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    // Both calls ride one assistant message, so the two tool tasks run in the
    // same round and nothing the child does can come between them. The scripted
    // answers after that are interchangeable, which is what keeps the script
    // honest when the child starts its own generation.
    const entries = await once(harness, [
      fauxAssistantMessage([fauxToolCall("spawn_subagent", brief), fauxToolCall("spawn_subagent", brief)], {
        stopReason: "toolUse",
      }),
      ...answers(),
    ]);
    const result = toolResult(entries);
    expect(result).toContain('started "researcher"');
    expect(result).toContain("already exists");

    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    expect(index?.conversationId).not.toBe("");
    const childId = Number(index!.conversationId) as ConversationId;

    // The child answers instead of awaiting orders, so the discipline hook stops
    // it; a stopped agent with nothing of its own is released at once, which is
    // what keeps a finished child from holding a slot forever.
    await until(
      async () =>
        (await harness!.runtime.harness.snapshot(SecAgent, String(childId), BACKGROUND_CONTEXT)) === undefined
          ? true
          : undefined,
      "the finished child to be released",
      10_000,
    );
    // The name has to be free again, or a deleted agent could never be spawned
    // under it a second time: the index entry was retired with it.
    const released = await harness.runtime.harness.snapshot(
      SecAgentChild,
      1 as ConversationId,
      "researcher",
      BACKGROUND_CONTEXT,
    );
    expect(released).toBeUndefined();
    const hub = await harness.runtime.harness.snapshot(SecAgentHub, BACKGROUND_CONTEXT);
    expect(hub?.live ?? 0).toBe(0);
  });

  it("tells the child, in its own section, that it is a subagent with a parent", async () => {
    harness = await createTestHarness();
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    await once(harness, [spawnCall(brief), ...answers()]);
    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    const childId = Number(index!.conversationId) as ConversationId;

    // The generic guide is written as advice ("if you are a subagent"), so an
    // agent given only that has to guess. A run without it guessed wrong and
    // lost a model call to the discipline hook; this section is what stops that.
    const sections = await until(async () => {
      const page = await harness!.runtime.storage.scanEntries(
        { conversationId: childId, order: "descending" },
        50,
        undefined,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        if (entry.kind !== "pi.system") continue;
        const first = (entry.model ?? [])[0] as { sections?: Record<string, string> } | undefined;
        if (first?.sections?.["agent-role"] !== undefined) return first.sections;
      }
      return undefined;
    }, "the child's identity section", 10_000);

    expect(sections["agent-role"]).toContain('subagent named "researcher"');
    expect(sections["agent-role"]).toContain("await_orders");
    // The root's stored name is the value `operator`; a sentence names the root.
    expect(sections["agent-role"]).toContain("started by the root agent.");
    expect(sections["agent-role"]).toContain("reaches one only through the root agent.");
    expect(sections["agent-role"]).not.toContain("operator");
    // How a subagent ends is its role's call, not the harness's: an orchestrator
    // parks when its work is done, a worker finishes.
    expect(sections["subagents"]).toContain(
      "When your work is done, your role says how you end: `finish_work` sends your final report and frees your slot and your name, and `await_orders` sends the report and keeps you for the next order.",
    );
    expect(sections["subagents"]).not.toContain("so your parent does not have to delete you");
    const child: Conversation | undefined = await harness.runtime.harness.conversation(childId, BACKGROUND_CONTEXT);
    const park = (await child!.agent(BACKGROUND_CONTEXT)).tools.find((tool) => tool.name === "await_orders");
    // The description cannot differ per kind, so it says what both kinds do: the
    // role decides whether this turn is the agent's last.
    expect(park?.description).toContain(
      "When your work is done, your role says whether you end for good or wait here for the next order.",
    );
    expect(park?.description).not.toContain("call `finish_work` instead");
    const profile = await harness.runtime.harness.snapshot(AgentDoc, childId, BACKGROUND_CONTEXT);
    expect(profile?.instructions).toContain("It stays after you finish, so the root agent can read it.");
    expect(profile?.instructions).not.toContain("operator");
  });

  it("names the user, not the operator, when the root is refused a park", async () => {
    harness = await createTestHarness();
    const out = toolResult(await once(harness, [fauxAssistantMessage([fauxToolCall("await_orders", { note: "x" })], { stopReason: "toolUse" }), ...answers()]));
    expect(out).toContain("this conversation answers to the user");
    expect(out).not.toContain("operator");
  });

  it("frees a name whose agent record is gone", async () => {
    harness = await createTestHarness();
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    await once(harness, [spawnCall(brief), ...answers()]);
    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    const childId = Number(index!.conversationId) as ConversationId;

    // A delete that died between its two steps: the record is gone, the name
    // index entry is not. Without the check in `liveChild` the name would be
    // taken for good and this second spawn would answer "already exists".
    await harness.runtime.harness.commit(async (tx) => {
      await tx.retireDoc(SecAgent, String(childId));
    }, BACKGROUND_CONTEXT);

    const entries = await once(harness, [spawnCall(brief), ...answers()]);
    expect(toolResult(entries)).toContain('started "researcher"');
  });

  it("narrows the child's tool list and leaves the parent's alone", async () => {
    harness = await createTestHarness();
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    // The pause lets the child's own generation finish before the harness closes,
    // so the test does not race the daemon's teardown.
    const entries = await once(harness, [spawnCall(brief), ...answers()]);
    expect(toolResult(entries)).toContain('started "researcher"');

    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    const childId = Number(index!.conversationId) as ConversationId;
    const child: Conversation | undefined = await harness.runtime.harness.conversation(childId, BACKGROUND_CONTEXT);
    const agent = await child!.agent(BACKGROUND_CONTEXT);
    const names = agent.tools.map((tool) => tool.name);
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("questions_open");
    expect(names).not.toContain("question_withdraw");
    expect(names).not.toContain("notify");
    expect(names).not.toContain("reports_create");
    expect(names).not.toContain("reports_publish_draft");
    expect(names).not.toContain("self_edit");
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("await_orders");
    expect(names).toContain("reports_draft");

    const parent = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
    const parentAgent = await parent.agent(BACKGROUND_CONTEXT);
    const parentNames = parentAgent.tools.map((tool) => tool.name);
    expect(parentNames).toContain("ask_user");
    expect(parentNames).toContain("questions_open");
    expect(parentNames).toContain("question_withdraw");
    expect(parentNames).toContain("reports_create");
    expect(parentNames).toContain("reports_publish_draft");
    expect(parentNames).not.toContain("reports_draft");
  });

  it("gives a new subagent its own context file and names it in its instructions", async () => {
    harness = await createTestHarness();
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    const entries = await once(harness, [spawnCall(brief), ...answers()]);

    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    const childId = Number(index!.conversationId) as ConversationId;
    const path = contextPath(harness.paths, String(childId));

    // The parent is told where to look, and the file is there to be read.
    expect(toolResult(entries)).toContain(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // The path differs per agent, so it reaches the child as `instructions`:
    // those render after every extension section, so the shared sections stay
    // shareable and the per-agent fact sits last.
    const child = await harness.runtime.harness.conversation(childId, BACKGROUND_CONTEXT);
    const agent = await child!.agent(BACKGROUND_CONTEXT);
    expect(agent.instructions).toContain(path);
    expect(agent.instructions).toContain("rewrite the whole file");
  });

  it("records subagent_spawned with the parent conversation and the job", async () => {
    harness = await createTestHarness();
    const job = await harness.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "a handover to audit" });
    await round(
      harness,
      [spawnCall({ name: "researcher", vmodel: "faux", roles: [], initialPrompt: "work", jobId: job.id }), ...answers()],
      "go",
    );

    // The row names a conversation; the two fields that say where it came from
    // and what work it holds are what make the log answer "who asked for this".
    const spawned = (await readAuditTail(harness.paths.auditLog, undefined, 500)).find(
      (event) => event.type === "subagent_spawned",
    );
    expect(spawned).toBeDefined();
    expect(spawned!.parentConversationId).toBe("1");
    expect(spawned!.jobId).toBe(job.id);
  });

  it("writes one subagent_status row on every status change", async () => {
    harness = await createTestHarness();
    const marker = "subagent-status-marker";
    await round(
      harness,
      [spawnCall({ name: "researcher", vmodel: "faux", roles: [], initialPrompt: marker }), ...Array.from({ length: 30 }, () => parkChildren(marker))],
      "go",
    );
    const index = await harness.runtime.harness.snapshot(SecAgentChild, 1 as ConversationId, "researcher", BACKGROUND_CONTEXT);
    const childId = Number(index!.conversationId) as ConversationId;
    await until(async () => {
      const record = await harness!.runtime.harness.snapshot(SecAgent, String(childId), BACKGROUND_CONTEXT);
      return record?.status === "waiting" ? true : undefined;
    }, "the child to park");

    // `starting` is written by the creating commit itself, so it is not a status
    // change the hub made: the two rows here are the two changes there were.
    const changes = (await readAuditTail(harness.paths.auditLog, undefined, 500)).filter(
      (event) => event.type === "subagent_status" && event.conversationId === String(childId),
    );
    expect(changes.map((row) => row.status)).toEqual(["running", "waiting"]);
    expect(changes[1]!.previous).toBe("running");
  });
});

/**
 * One run the provider gave up on, written straight into storage.
 *
 * The shape under test — four attempts with a bookkeeping entry between two of
 * them — is what an outage leaves behind; producing it through the harness would
 * mean waiting out the real backoff of two, four and eight seconds.
 *
 * Returns the conversation and the entry the run answered, so the settled
 * submission can be written after the sweep's baseline is taken.
 */
async function seedSpentRun(harness: TestHarness): Promise<{ conversationId: ConversationId; inputEntry: number }> {
  const storage = harness.runtime.storage;
  const at = Date.now();
  let id = "";
  let inputEntry = 0;
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    const entry = await tx.appendEntry(conversation.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "go", timestamp: at }],
    });
    inputEntry = entry.id;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // A bookkeeping entry between attempts: an entry that carries no model
      // message, exactly like the ones that can sit between failures.
      if (attempt === 2) await tx.appendEntry(conversation.id, { kind: "pi.note" });
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("upstream is unwell", { stopReason: "error", errorMessage: "503: upstream is unwell" })],
      });
    }
  }, BACKGROUND_CONTEXT);

  const conversationId = Number(id) as ConversationId;
  const taskId = await storage.mintId<TaskId>();
  await commitWrites(storage, [
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
          endedAt: at,
          state: { status: "terminal", outcome: { status: "failed", error: { message: "503: upstream is unwell", detail: { reason: "model_error" } } } },
        },
      } as unknown as StorageWrite,
    ],
    BACKGROUND_CONTEXT,
  );
  return { conversationId, inputEntry };
}

/**
 * One conversation's transcript, written straight into storage as a list of
 * steps.
 *
 * `input` starts a run, `err` is one failed attempt, `ok` is a response that is
 * not one, and `note` is a bookkeeping entry that carries no model message.
 * Returns the id of every input, so a settlement can name the run it belongs to.
 */
type Step = "input" | "err" | "ok" | "note";

async function seedSteps(
  harness: TestHarness,
  steps: readonly Step[],
): Promise<{ conversationId: ConversationId; inputs: number[] }> {
  const at = Date.now();
  let id = "";
  const inputs: number[] = [];
  await harness.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    id = String(conversation.id);
    for (const step of steps) {
      if (step === "input") {
        const entry = await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "go", timestamp: at }],
        });
        inputs.push(Number(entry.id));
      } else if (step === "note") {
        await tx.appendEntry(conversation.id, { kind: "pi.note" });
      } else if (step === "ok") {
        await tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [fauxAssistantMessage("done")] });
      } else {
        await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage("upstream is unwell", { stopReason: "error", errorMessage: "503: upstream is unwell" })],
        });
      }
    }
  }, BACKGROUND_CONTEXT);
  return { conversationId: Number(id) as ConversationId, inputs };
}

/** Settle one input as a spent retry loop and return the rows the sweep wrote. */
async function spentRows(harness: TestHarness, conversationId: ConversationId, inputEntry: number) {
  const submissionId = await harness.runtime.storage.mintId<SubmissionId>();
  await commitWrites(harness.runtime.storage, [
      {
        type: "submission",
        value: {
          id: submissionId,
          conversationId,
          type: "input",
          status: "unanswered",
          reason: "model_error",
          entry: inputEntry,
          detail: "503: upstream is unwell",
        },
      } as unknown as StorageWrite,
    ],
    BACKGROUND_CONTEXT,
  );
  await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT);
  return (await readAuditTail(harness.paths.auditLog, undefined, 200)).filter(
    (event) => event.type === "run_failed",
  );
}

describe("run failures in the audit log", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("writes a run_failed row with attempts and provider status when the retries are spent", async () => {
    harness = await createTestHarness();
    const { conversationId, inputEntry } = await seedSpentRun(harness);

    // The first pass only takes a baseline: settlements older than the process are
    // history, and rewriting them after every restart would copy the store.
    expect((await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT)).failed).toBe(0);

    const submissionId = await harness.runtime.storage.mintId<SubmissionId>();
    await commitWrites(harness.runtime.storage, [
        {
          type: "submission",
          value: {
            id: submissionId,
            conversationId,
            type: "input",
            status: "unanswered",
            reason: "model_error",
            entry: inputEntry,
            detail: "503: upstream is unwell request_id: 7f3c-9a11",
          },
        } as unknown as StorageWrite,
      ],
      BACKGROUND_CONTEXT,
    );

    expect((await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT)).failed).toBe(1);
    const row = (await readAuditTail(harness.paths.auditLog, undefined, 200)).find(
      (event) => event.type === "run_failed",
    );
    expect(row?.conversationId).toBe(String(conversationId));
    expect(row?.reason).toBe("model_error");
    // Four attempts, not two: the walk skips the entry that carries no model
    // message instead of stopping at it.
    expect(row?.attempts).toBe(4);
    expect(row?.providerStatus).toBe(503);
    expect(row?.requestId).toBe("7f3c-9a11");

    // Nothing is written twice: the watermark moved past this settlement.
    expect((await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT)).failed).toBe(0);
  });

  it("counts only the tail when an answer sits between two failure bundles", async () => {
    harness = await createTestHarness();
    const { conversationId, inputs } = await seedSteps(harness, ["input", "err", "ok", "err", "err", "note", "err"]);
    await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT);

    const rows = await spentRows(harness, conversationId, inputs[0]!);
    expect(rows.length).toBe(1);
    // Three, not four: the failure before the answer ended with the answer, so
    // only the failures after it are this run's last retry loop. The bookkeeping
    // entry between them does not end the walk.
    expect(rows[0]?.attempts).toBe(3);
  });

  it("counts a failure bundle across an entry that carries no model message", async () => {
    harness = await createTestHarness();
    const { conversationId, inputs } = await seedSteps(harness, ["input", "err", "note", "err", "err"]);
    await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT);

    const rows = await spentRows(harness, conversationId, inputs[0]!);
    expect(rows.length).toBe(1);
    // The note carries no model message, so it says nothing about attempts and the
    // walk steps over it: three attempts, not one and not two.
    expect(rows[0]?.attempts).toBe(3);
  });

  it("does not count a later run's failures as this run's attempts", async () => {
    harness = await createTestHarness();
    const { conversationId, inputs } = await seedSteps(harness, [
      "input",
      "err",
      "err",
      "err",
      "err",
      "input",
      "err",
      "err",
    ]);
    await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT);

    // The later run's two failures are newer, so a walk that started at the end of
    // the conversation would meet them first and answer two. The run asked about
    // is the first input, and it spent four attempts.
    const rows = await spentRows(harness, conversationId, inputs[0]!);
    expect(rows.length).toBe(1);
    expect(rows[0]?.attempts).toBe(4);
  });

  it("starts the walk at the run's newest failure, not at the end of the transcript", async () => {
    harness = await createTestHarness();
    // A bookkeeping entry and an ordinary response were written after the run's
    // last failed attempt. The settlement names the input, not the failure, so the
    // count finds the failure for itself: one attempt, then the input, which ends
    // the walk.
    const { conversationId, inputs } = await seedSteps(harness, ["input", "err", "note", "ok"]);
    await harness.runtime.subagents!.sweep(BACKGROUND_CONTEXT);

    const rows = await spentRows(harness, conversationId, inputs[0]!);
    expect(rows.length).toBe(1);
    expect(rows[0]?.attempts).toBe(1);
  });
});
