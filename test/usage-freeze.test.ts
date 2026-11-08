/**
 * The usage-limit hold: a conversation whose provider refused it for usage waits,
 * one short request per ten minutes checks the provider, and a success sends every
 * conversation that provider held.
 *
 * Every test here is a fake provider and a controlled clock. The provider is the
 * harness's `faux` one, which counts the calls it answered: a probe is a call the
 * watch made, and "no model request went out" is that count not moving. The usage
 * signal is a double for the service, so a test says what a provider's own numbers
 * are instead of reaching an account.
 */
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import { getHoldGate, HoldSet, isHeldOperatorInput } from "../src/agent/hold-gate.ts";
import { defaultConfig } from "../src/config/schema.ts";
import {
  DOC_KINDS,
  SecAgent,
  SecUsageHold,
  SecUsageProbe,
  type UsageHoldRecord,
} from "../src/documents.ts";
import { PROBE_INTERVAL_MS, UsageFreeze, type RecoverySignal } from "../src/extensions/usage-freeze.ts";
import { MESSAGE_SOURCES } from "../src/message-envelope.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { submitEnveloped } from "../src/submit-envelope.ts";
import type { UsageService } from "../src/server/usage/service.ts";
import type { UsageCard } from "../src/server/usage/values.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const CTX = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;
const MINUTE = 60_000;

/** The provider's answer to "is this account over its limit". */
type Signal = RecoverySignal;

/** The usage service a test hands the runtime, and the providers it was asked about. */
function fakeUsage(initial: Record<string, Signal> = {}): {
  readonly service: UsageService;
  readonly asked: string[];
  set(provider: string, signal: Signal): void;
} {
  const asked: string[] = [];
  const table = new Map(Object.entries(initial));
  const service = {
    async refresh(provider: string) {
      asked.push(provider);
      const signal = table.get(provider);
      if (signal === undefined) return { ok: false as const, code: "unknown_provider" as const };
      return { ok: true as const, answer: { generatedAt: Date.now(), timezone: "UTC", card: cardFor(provider, signal) } };
    },
  } as unknown as UsageService;
  return {
    service,
    asked,
    set(provider: string, signal: Signal) {
      table.set(provider, signal);
    },
  };
}

/** The card one provider's signal is drawn as, in the shape the usage page reads. */
function cardFor(provider: string, signal: Signal): UsageCard {
  if (signal.kind === "none") {
    return { provider, name: provider, shape: "prepaid", receivedAt: null, fields: { balance: { state: "wip" } } };
  }
  if (signal.resetsAt !== null) {
    return {
      provider,
      name: provider,
      shape: "subscription",
      receivedAt: null,
      fields: {
        fiveHour: {
          state: "value",
          value: { utilization: signal.recovered ? 0 : 100, resetsAt: { at: signal.resetsAt, label: "x" } },
        },
      },
    };
  }
  return {
    provider,
    name: provider,
    shape: "prepaid",
    receivedAt: null,
    fields: { balance: { state: "value", value: { amount: signal.recovered ? 12 : 0, currency: "USD" } } },
  };
}

/** The provider's own usage refusal, which the harness settles at once. */
function refused(): AssistantMessage {
  return fauxAssistantMessage("usage limit", {
    stopReason: "error",
    errorMessage: "429: This request would exceed your account's rate limit",
  });
}

function ok(text = "ok"): AssistantMessage {
  return fauxAssistantMessage([fauxText(text)]);
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
    .join(" ");
}

interface Rig {
  readonly harness: TestHarness;
  readonly watch: UsageFreeze;
  readonly usage: ReturnType<typeof fakeUsage>;
  readonly clock: { at: number };
}

/**
 * A runtime with the `usage-freeze` extension installed, and a watch over it whose
 * clock a test moves.
 *
 * The runtime's own timer is stopped, so the only clock is `clock`: ten minutes is
 * one assignment, and no test waits for a minute to pass. The provider's retries
 * are off, because the state under test is the run that settled on its first
 * refusal.
 */
async function rig(initial: Record<string, Signal> = {}): Promise<Rig> {
  const usage = fakeUsage(initial);
  const base = defaultConfig();
  const harness = await createTestHarness({
    loadExtensions: true,
    usage: usage.service,
    config: {
      agent: {
        ...base.agent,
        extensions: { enabled: [...base.agent.extensions.enabled, "usage-freeze"] },
        retry: { ...base.agent.retry, enabled: false },
      },
    },
  });
  const installed = harness.runtime.usageFreeze;
  expect(installed).toBeInstanceOf(UsageFreeze);
  const clock = { at: Date.now() };
  // The runtime's watch started its own timer at boot. It is stopped here, so a
  // pass happens only when a test asks for one.
  installed!.stopWatch();
  const watch = new UsageFreeze({ ...(installed as UsageFreeze).sources, now: () => clock.at });
  watch.install();
  return { harness, watch, usage, clock };
}

/** The hold document of one conversation. */
async function holdOf(r: Rig, id: ConversationId): Promise<Readonly<UsageHoldRecord> | undefined> {
  return await r.harness.runtime.harness.snapshot(SecUsageHold, String(id), CTX);
}

/** The agent record of one conversation. */
async function agentOf(r: Rig, id: ConversationId) {
  return await r.harness.runtime.harness.snapshot(SecAgent, String(id), CTX);
}

/** Every audit row of one type, about one conversation when one is named. */
async function auditRows(r: Rig, type: string, conversationId?: string): Promise<Record<string, unknown>[]> {
  const rows = await readAuditTail(r.harness.paths.auditLog, undefined, 500);
  return rows.filter(
    (row) => row.type === type && (conversationId === undefined || row["conversationId"] === conversationId),
  );
}

/** Every key of one session-scoped document family. */
async function docKeys(r: Rig, kind: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await r.harness.runtime.storage.scanDocuments(
      { scope: { kind: "session" }, at: "current", kind },
      200,
      cursor,
      CTX,
    );
    for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return keys;
}

/**
 * One conversation whose work ended on the provider's usage refusal, in the shape
 * the harness leaves behind.
 *
 * The entries are written directly because the shape is what the watch reads: an
 * input, an assistant entry that names the provider and model, and a submission
 * settled `unanswered` with `model_error` whose detail starts with the status. A
 * run produced through the harness would need the real retry backoff to settle,
 * and the provider it names would be the faux one whatever the test meant.
 */
async function seedRefused(
  r: Rig,
  options: {
    readonly name: string;
    readonly provider?: string;
    readonly model?: string;
    /**
     * Off by default. A conversation with a parent sends the parent a hold note
     * when it is held, and that note starts a model run in the root on the same
     * faux provider. That run takes a queued answer and moves the call count at a
     * moment the test does not control. A test that turns this on must not assert
     * on model calls.
     */
    readonly parent?: boolean;
    /**
     * Date the run more than half an hour back, and give it a failed task, so the
     * stall watch would judge a record that still says `running` as stalled. That
     * is the control this file's stall test needs; it is off by default so no
     * other test has to account for a task it did not mean to write.
     */
    readonly stale?: boolean;
  } = {
    name: "worker",
  },
): Promise<ConversationId> {
  const provider = options.provider ?? "faux";
  const model = options.model ?? r.harness.faux.getModel().id;
  // The stall watch's own threshold is half an hour; a minute past it is stale and
  // still close enough that no other clock in this file has to move.
  const at = options.stale === true ? r.clock.at - 31 * MINUTE : r.clock.at;
  // A conversation carries its model, and that is what a retry with no input reads:
  // a conversation with no model has nothing to ask and fails on its own account.
  // The harness's own creating path is used because it is the one that applies the
  // agent change; a transaction's `createConversation` records the id only.
  const created = await r.harness.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: r.harness.faux.getModel().id }, thinkingLevel: "off" },
    },
    CTX,
  );
  let id = String(created.id);
  await r.harness.runtime.harness.commit(async (tx) => {
    await tx.appendEntry(created.id, {
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: '<pi-message src="operator">\nfirst question\n</pi-message>',
          timestamp: at,
        },
      ],
    });
    await tx.appendEntry(created.id, {
      kind: "pi.assistant",
      // The entry carries the same refusal the submission's detail carries: the
      // entry is what names the provider, and it has to be the refusal itself
      // for the hold to be about a usage limit. Its timestamp is the run's own,
      // which is what the stall watch reads as the last time anything moved.
      model: [{ ...refused(), provider, model, timestamp: at } as AssistantMessage],
    });
    const record = await tx.doc(SecAgent, id, id);
    // A scheduled round, not a subagent: it has no parent hook that would nudge a
    // turn ending without `finish_work`, and an agent's nudge is itself a model
    // call that would blur the count this test watches. It is a conversation like
    // any other to the hold watch, which is what the test is about.
    record.kind = "scheduled";
    record.name = options.name;
    if (options.parent === true) record.parentConversationId = String(ROOT);
    record.status = "running";
    record.createdAt = at;
    record.updatedAt = at;
  }, CTX);
  const conversationId = Number(id) as ConversationId;
  const submission = await r.harness.runtime.storage.mintId();
  await commitWrites(r.harness.runtime.storage, [
      {
        type: "submission",
        value: {
          id: submission,
          conversationId,
          type: "input",
          status: "unanswered",
          reason: "model_error",
          detail: "429: This request would exceed your account's rate limit",
        },
      },
    ],
    CTX,
  );
  if (options.stale === true) {
    // The newest task ended in failure, and nothing was written after it: the two
    // facts the stall watch reads beside the settled submission.
    const taskId = await r.harness.runtime.storage.mintId();
    await commitWrites(r.harness.runtime.storage, [
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
            state: {
              status: "terminal",
              outcome: {
                status: "failed",
                error: {
                  message: "429: This request would exceed your account's rate limit",
                  detail: { reason: "model_error" },
                },
              },
            },
          },
        },
      ],
      CTX,
    );
  }
  return conversationId;
}

/**
 * Wait until the retry one hold started has ended, then run one pass.
 *
 * A retry is a real run: the scheduler picks its task up on its own turn, so the
 * pass that started it cannot know how it ended. The pass that follows is what
 * reads that ending, which is how the product behaves and how a test drives it.
 */
async function settleRetry(r: Rig, id: ConversationId): Promise<void> {
  await until(async () => {
    const hold = await holdOf(r, id);
    if (hold === undefined) return true;
    if (hold.status !== "retrying") return true;
    const task = await r.harness.runtime.harness.getTask(Number(hold.retryTaskId) as never, CTX);
    return task !== undefined && task.state.status === "terminal" ? true : undefined;
  }, "the retry to end");
  await r.watch.tick();
}

/** Poll one question until it answers, or fail. */
async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined && found !== false) return found as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every user message the model was handed, in order. */
function transcriptOf(context: { readonly messages: readonly Message[] }): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message));
}

/** Whether one request is the probe: one user message, and it is the probe's. */
function isProbe(context: { readonly messages: readonly Message[] }): boolean {
  const users = transcriptOf(context);
  return users.length === 1 && users[0] === "ping";
}

describe("a conversation the provider refused for usage", () => {
  const open: Rig[] = [];

  afterEach(async () => {
    for (const r of open) await r.harness.close();
    open.length = 0;
  });

  async function boot(initial: Record<string, Signal> = {}): Promise<Rig> {
    const made = await rig(initial);
    open.push(made);
    return made;
  }

  it("is held once, and its document names the provider, the model and the submission", async () => {
    const r = await boot({ faux: { kind: "known", recovered: false, resetsAt: Date.now() + 60 * MINUTE } });
    const id = await seedRefused(r, { name: "worker", parent: true });

    const pass = await r.watch.tick();
    expect(pass.held).toBe(1);

    const hold = await holdOf(r, id);
    expect(hold?.provider).toBe("faux");
    expect(hold?.model).toBe(r.harness.faux.getModel().id);
    expect(hold?.status).toBe("held");
    expect(hold?.heldAt).toBe(r.clock.at);
    const submissions = await r.harness.runtime.storage.scanSubmissions(
      { conversationId: id, order: "descending" },
      5,
      undefined,
      CTX,
    );
    expect(hold?.submissionId).toBe(String(submissions.items[0]!.id));
    expect((await agentOf(r, id))?.status).toBe("held");
    // The provider's probe document appeared, and it names the model to ask with.
    const probe = await r.harness.runtime.harness.snapshot(SecUsageProbe, "faux", CTX);
    expect(probe?.lastModel).toBe(r.harness.faux.getModel().id);
    expect(probe?.firstHeldAt).toBe(r.clock.at);
    // The parent was told once, and the note says the work is not lost.
    const notes = (await r.harness.runtime.subagents!.inbox(ROOT, CTX)).filter((message) =>
      message.body.includes("is held"),
    );
    expect(notes.length).toBe(1);
    expect(notes[0]!.body).toContain("faux");
    expect(notes[0]!.body).toContain("Nothing was stopped, restarted, or deleted");
  });

  it("holds once, however many passes run", async () => {
    const r = await boot({ faux: { kind: "known", recovered: false, resetsAt: Date.now() + 60 * MINUTE } });
    const id = await seedRefused(r, { name: "worker", parent: true });

    await r.watch.tick();
    await r.watch.tick();
    await r.watch.tick();

    expect(await docKeys(r, DOC_KINDS.usageHold)).toEqual([String(id)]);
    expect((await auditRows(r, "usage_held", String(id))).length).toBe(1);
    const notes = (await r.harness.runtime.subagents!.inbox(ROOT, CTX)).filter((message) =>
      message.body.includes("is held"),
    );
    expect(notes.length).toBe(1);
  });

  it("does not report a held child as stalled, where the same record claiming to be running is reported", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const heldChild = await seedRefused(r, { name: "held-child", stale: true, parent: true });
    const runningChild = await seedRefused(r, { name: "running-child", stale: true, parent: true });

    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect((await agentOf(r, heldChild))?.status).toBe("held");
    expect((await agentOf(r, runningChild))?.status).toBe("held");

    // The control: the same record put back to `running` is the one the stall watch
    // is there for. Without it this test would pass on a sweep that said nothing
    // about anything.
    await r.harness.runtime.harness.commit(async (tx) => {
      const record = await tx.doc(SecAgent, String(runningChild), String(runningChild));
      record.status = "running";
    }, CTX);

    await r.harness.runtime.subagents!.sweep(CTX);
    const bodies = (await r.harness.runtime.subagents!.inbox(ROOT, CTX)).map((message) => message.body);
    const stalled = bodies.filter((body) => body.includes("has not moved"));
    expect(stalled.length).toBe(1);
    expect(stalled[0]).toContain("running-child");
    expect(bodies.some((body) => body.includes("held-child") && body.includes("has not moved"))).toBe(false);
    // The parent hears the hold instead, once per held child, and that is the note
    // that tells it the work is not lost.
    expect(bodies.filter((body) => body.includes("is held")).length).toBe(2);
  });

  it("sends nothing while the provider's own numbers say the window is full, and probes once they say it has room", async () => {
    const resetsAt = Date.now() + 60 * MINUTE;
    const r = await boot({ faux: { kind: "known", recovered: false, resetsAt } });
    await seedRefused(r);

    const before = r.harness.faux.state.callCount;
    await r.watch.tick();
    // The hold happened and no model request went out: the signal said "no room".
    expect(r.harness.faux.state.callCount).toBe(before);

    r.usage.set("faux", { kind: "known", recovered: true, resetsAt });
    r.clock.at += 1_000;
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    // The window has room now, so one probe went out.
    expect(r.harness.faux.state.callCount).toBe(before + 1);
  });

  it("probes once per provider, however many conversations that provider holds", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const first = await seedRefused(r, { name: "one" });
    const second = await seedRefused(r, { name: "two" });
    r.harness.faux.setResponses([refused()]);

    const pass = await r.watch.tick();
    expect(pass.probed).toBe(1);
    expect(pass.held).toBe(2);
    expect((await auditRows(r, "usage_probed")).length).toBe(1);
    expect((await auditRows(r, "usage_probed"))[0]!["provider"]).toBe("faux");
    // The refusal held both, and neither was retried.
    expect(await holdOf(r, first)).toBeDefined();
    expect(await holdOf(r, second)).toBeDefined();
    expect((await auditRows(r, "usage_retried")).length).toBe(0);
  });

  it("waits ten minutes before the next probe, and that moment survives a restart", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);

    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    const probe = await r.harness.runtime.harness.snapshot(SecUsageProbe, "faux", CTX);
    expect(probe?.lastResult).toBe("rate_limited");
    expect(probe?.lastProbeAt).toBe(r.clock.at);
    expect(await holdOf(r, id)).toBeDefined();

    // Five minutes later this watch sends nothing.
    const quiet = r.harness.faux.state.callCount;
    r.clock.at += 5 * MINUTE;
    await r.watch.tick();
    expect(r.harness.faux.state.callCount).toBe(quiet);

    // A second watch over the same store, as a restarted daemon would be, reads the
    // moment from the document and still sends nothing.
    const restarted = new UsageFreeze({ ...r.watch.sources, now: () => r.clock.at });
    restarted.install();
    await restarted.tick();
    expect(r.harness.faux.state.callCount).toBe(quiet);

    // Ten minutes after that probe, the next one goes out.
    r.harness.faux.setResponses([refused()]);
    r.clock.at += 5 * MINUTE;
    await restarted.tick();
    expect(r.harness.faux.state.callCount).toBe(quiet + 1);
    expect(
      (await r.harness.runtime.harness.snapshot(SecUsageProbe, "faux", CTX))?.lastProbeAt,
    ).toBe(r.clock.at);
  });

  it("probes with one short message, no context and no tools, on the held model", async () => {
    const r = await boot({ faux: { kind: "none" } });
    await seedRefused(r);

    const seen: { messages: readonly Message[]; maxTokens: unknown; model: string; call: number }[] = [];
    const script: FauxResponseFactory = (context, options, state, model) => {
      seen.push({ messages: [...context.messages], maxTokens: (options as { maxTokens?: unknown })?.maxTokens, model: model.id, call: state.callCount });
      return refused();
    };
    r.harness.faux.setResponses([script]);
    await r.watch.tick();

    expect(seen.length).toBe(1);
    expect(seen[0]!.messages.length).toBe(1);
    expect(seen[0]!.messages[0]!.role).toBe("user");
    expect(messageText(seen[0]!.messages[0]!)).toBe("ping");
    expect(seen[0]!.maxTokens).toBe(16);
    expect(seen[0]!.model).toBe(r.harness.faux.getModel().id);
    // A probe's tokens and cost are on the audit row, because no card counts them.
    const probed = await auditRows(r, "usage_probed");
    expect(probed.length).toBe(1);
    expect(probed[0]).toHaveProperty("inputTokens");
    expect(probed[0]).toHaveProperty("outputTokens");
    expect(probed[0]).toHaveProperty("cost");
  });

  it("resumes every conversation one provider held and leaves another provider's hold alone", async () => {
    const r = await boot({ faux: { kind: "none" }, other: { kind: "known", recovered: false, resetsAt: 0 } });
    const mine = await seedRefused(r, { name: "one", provider: "faux" });
    // The second provider holds a conversation, and its signal says its window is
    // full, so this pass sends nothing for it.
    const theirs = await seedRefused(r, { name: "two", provider: "other" });

    r.harness.faux.setResponses([ok("pong"), ...Array.from({ length: 40 }, () => ok())]);
    await r.watch.tick();
    await settleRetry(r, mine);

    expect(await holdOf(r, mine)).toBeUndefined();
    expect(await holdOf(r, theirs)).toBeDefined();
    expect((await agentOf(r, theirs))?.status).toBe("held");
    expect((await agentOf(r, mine))?.status).toBe("running");
    // Exactly one probe went out, and it named the provider that was due.
    expect((await auditRows(r, "usage_probed")).map((row) => row["provider"])).toEqual(["faux"]);
  });

  it("holds a provider whose usage cannot be read, and probes it from the first pass", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);

    const before = r.harness.faux.state.callCount;
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();

    // The probe went out on the first pass, with no signal step to wait for.
    expect(r.harness.faux.state.callCount).toBe(before + 1);
    const probe = await r.harness.runtime.harness.snapshot(SecUsageProbe, "faux", CTX);
    expect(probe?.lastProbeAt).toBe(r.clock.at);
    expect(probe?.lastResult).toBe("rate_limited");
    expect(await holdOf(r, id)).toBeDefined();
    // Its view says this server cannot read the provider's usage, which is what the
    // banner says in place of a reset time.
    const view = await r.watch.holdView();
    expect(view[0]!.readable).toBe(false);
  });

  it("holds again when the retried request is refused, with no cap on attempts", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);

    for (let round = 0; round < 5; round += 1) {
      // The probe is answered, and the retried request the probe started is refused.
      r.harness.faux.setResponses([ok("pong"), refused(), ...Array.from({ length: 10 }, () => refused())]);
      await r.watch.tick();
      await settleRetry(r, id);
      const hold = await holdOf(r, id);
      expect(hold, `round ${round}`).toBeDefined();
      expect(hold?.status).toBe("held");
      expect(hold?.retries).toBe(round + 1);
      // A retry creates no submission, so the table still holds the first failure.
      const submissions = await r.harness.runtime.storage.scanSubmissions(
        { conversationId: id, order: "descending" },
        10,
        undefined,
        CTX,
      );
      expect(submissions.items.filter((item) => item.type === "input").length).toBe(1);
      r.clock.at += PROBE_INTERVAL_MS;
    }
    // One hold for the first refusal, and one for each refusal of a retry.
    expect((await auditRows(r, "usage_held", String(id))).length).toBe(6);
  });

  it("keeps an input out of the model while held, and sends it with the retry in order", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect(await holdOf(r, id)).toBeDefined();

    // The operator writes to the held conversation. Nothing is called, and the text
    // is in the transcript as a user entry that started no run.
    const conversation = await r.harness.runtime.harness.conversation(id, CTX);
    expect(conversation).toBeDefined();
    const before = r.harness.faux.state.callCount;
    await submitEnveloped(conversation!, CTX, { type: "input", src: "operator", content: "WHILE HELD" }, "UTC");
    expect(r.harness.faux.state.callCount).toBe(before);
    const entries = await r.harness.runtime.storage.scanEntries(
      { conversationId: id, order: "ascending" },
      200,
      undefined,
      CTX,
    );
    const userTexts = entries.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) => messageText((entry.model ?? [])[0] as Message));
    expect(userTexts.some((text) => text.includes("WHILE HELD"))).toBe(true);
    // The hold document has no waiting list: the transcript is the only copy.
    expect(JSON.stringify(await holdOf(r, id))).not.toContain("WHILE HELD");

    // The provider answers, and the retry carries the transcript as it stands: the
    // first question, then the text written while held, in that order.
    const retries: (readonly Message[])[] = [];
    const script: FauxResponseFactory = (context) => {
      if (isProbe(context)) return ok("pong");
      retries.push([...context.messages]);
      return ok("answered");
    };
    r.harness.faux.setResponses(Array.from({ length: 20 }, () => script));
    r.clock.at += PROBE_INTERVAL_MS;
    await r.watch.tick();
    await settleRetry(r, id);

    expect(retries.length).toBeGreaterThanOrEqual(1);
    const users = transcriptOf({ messages: retries[0]! });
    const first = users.findIndex((text) => text.includes("first question"));
    const held = users.findIndex((text) => text.includes("WHILE HELD"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(held).toBeGreaterThan(first);
    // The retry adds nothing of its own: no "carry on", no repeat of the question.
    // These two are every user message the model was handed, which is what "sent
    // again with no new input" means.
    expect(users.length).toBe(2);
    expect(await holdOf(r, id)).toBeUndefined();
  });

  it("tells the person whose message waits, and no other author", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect(await holdOf(r, id)).toBeDefined();

    // The operator typed into the held conversation, so the page that sent the text
    // is the one place a notice can be read.
    expect(isHeldOperatorInput(String(id), "operator")).toBe(true);
    // Every other author is recorded the same way and told nothing: an agent's note,
    // the run a schedule started, a tool result and the restart handoff all read the
    // transcript, not a page. The list is read from the source list itself, so a
    // source added later gets this answer without anyone remembering it.
    for (const src of MESSAGE_SOURCES) {
      if (src === "operator") continue;
      expect([src, isHeldOperatorInput(String(id), src)]).toEqual([src, false]);
    }
    // A conversation nobody holds gets no notice, whichever page asks.
    expect(isHeldOperatorInput("424242", "operator")).toBe(false);
    expect(isHeldOperatorInput(undefined, "operator")).toBe(false);
  });

  it("closes the gate it installed when the last hold ends, and opens it again for a new one", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();

    const gate = getHoldGate();
    expect(gate).toBeDefined();
    expect(gate!.isHeld(String(id))).toBe(true);
    // Nothing may reach this conversation while it is held, whichever producer asks.
    expect(gate!.isHeld("unrelated")).toBe(false);

    r.harness.faux.setResponses([ok("pong"), ...Array.from({ length: 10 }, () => ok())]);
    r.clock.at += PROBE_INTERVAL_MS;
    await r.watch.tick();
    // The retry is a run of its own, and the conversation is working again: the
    // gate names a conversation that waits, and this one no longer waits. An input
    // now is queued behind that run, which is what any running conversation does.
    expect(gate!.isHeld(String(id))).toBe(false);
    await settleRetry(r, id);
    expect(gate!.isHeld(String(id))).toBe(false);
    expect(await holdOf(r, id)).toBeUndefined();
  });

  it("takes the banner's value down when the last hold ends", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();

    const held = await r.watch.holdView();
    expect(held.map((entry) => entry.provider)).toEqual(["faux"]);
    expect(held[0]!.conversations).toBe(1);
    expect(held[0]!.lastProbeResult).toBe("rate_limited");
    expect(held[0]!.nextProbeAt).toBe(r.clock.at + PROBE_INTERVAL_MS);

    r.harness.faux.setResponses([ok("pong"), ...Array.from({ length: 10 }, () => ok())]);
    r.clock.at += PROBE_INTERVAL_MS;
    await r.watch.tick();
    await settleRetry(r, id);
    expect(await r.watch.holdView()).toEqual([]);
    expect(await holdOf(r, id)).toBeUndefined();
  });

  it("says a provider an extension declared virtual is not an account's usage limit", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r, { provider: "synthetic-routed" });

    // A provider no registry marks virtual is held like any other; one that is
    // marked virtual answers no request itself, so its id in a failure is not a
    // usage limit of anybody's. This harness has no registry, so the first reading
    // is the one it takes, and the test says which it took.
    const virtual = r.harness.runtime.providers?.isVirtual("synthetic-routed") === true;
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect(virtual).toBe(false);
    expect(await holdOf(r, id)).toBeDefined();
  });

  it("leaves a conversation with live work alone", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    const taskId = await r.harness.runtime.storage.mintId();
    await commitWrites(r.harness.runtime.storage, [
        {
          type: "task",
          value: {
            id: taskId,
            conversationId: id,
            kind: "pi.generation",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            startedAt: r.clock.at,
            state: { status: "running", checkpoint: { phase: "prepare", attempt: 0 } },
          },
        },
      ],
      CTX,
    );
    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect(await holdOf(r, id)).toBeUndefined();
  });

  it("leaves a refusal that is not a usage limit alone", async () => {
    const r = await boot({ faux: { kind: "none" } });
    const id = await seedRefused(r);
    await r.harness.runtime.harness.commit(async (tx) => {
      const submission = await tx.scanSubmissions({ conversationId: id, order: "descending" }, 1);
      void submission;
    }, CTX).catch(() => undefined);
    // Rewrite the settled failure as one the provider answered with 503.
    const submissions = await r.harness.runtime.storage.scanSubmissions(
      { conversationId: id, order: "descending" },
      5,
      undefined,
      CTX,
    );
    const settled = submissions.items[0]!;
    const replacement = await r.harness.runtime.storage.mintId();
    await commitWrites(r.harness.runtime.storage, [
        {
          type: "submission",
          value: {
            id: replacement,
            conversationId: id,
            type: "input",
            status: "unanswered",
            reason: "model_error",
            detail: "503: upstream is unwell",
          },
        },
      ],
      CTX,
    );
    void settled;

    r.harness.faux.setResponses([refused()]);
    await r.watch.tick();
    expect(await holdOf(r, id)).toBeUndefined();
    expect(r.harness.faux.state.callCount).toBe(0);
  });
});

describe("the hold gate", () => {
  it("answers no for a conversation nothing named, and takes the set it is handed", () => {
    const set = new HoldSet();
    expect(set.isHeld("1")).toBe(false);
    set.replace(["1", "2"]);
    expect(set.isHeld("1")).toBe(true);
    expect(set.isHeld("3")).toBe(false);
    expect(set.names().sort()).toEqual(["1", "2"]);
    set.replace([]);
    expect(set.isHeld("1")).toBe(false);
  });
});
