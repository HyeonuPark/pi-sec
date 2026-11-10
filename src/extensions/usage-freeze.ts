/**
 * The `usage-freeze` extension: hold a conversation whose provider refused it for
 * usage, and send it again when that provider accepts requests once more.
 *
 * A model provider answers HTTP 429 when the account is over its quota. The
 * harness's own retry policy tries a few times and then settles the run
 * `unanswered` with `model_error`, and the agent record is left claiming to be
 * `running`. Three things then go wrong at once: the stall watch tells the parent
 * half an hour later that the child stopped, the boot repair tells the parent the
 * child ended without awaiting orders, and the chat page draws a conversation
 * that is doing nothing as busy. One state answers all three (`held`), and this
 * extension is what writes it and what ends it.
 *
 * Four rules shape the watch.
 *
 *   **Two documents, no new fields on the agent.** `sec.usageHold` (one per held
 *   conversation) says which provider and model refused, which submission failed,
 *   and how many times this hold has asked for a retry. `sec.usageProbe` (one per
 *   provider) says when the newest probe went out and what it came to. Neither is
 *   a field of `sec.agent`, so a rollback to a build without this extension reads
 *   the agent records it knows and simply never ends the holds.
 *
 *   **Recovery is judged twice.** The provider's own usage numbers say "it may be
 *   over": a subscription window that has reset and still has room, or a prepaid
 *   balance above zero. The last word is a probe — one short model request to the
 *   same provider and model, with no context and no tools — because a 429 is an
 *   account-level refusal and a request that goes through is the only proof the
 *   account can be asked again. A provider whose usage this server cannot read
 *   skips the first step and is probed from the first pass.
 *
 *   **One probe per provider per ten minutes.** The interval counts from the last
 *   probe attempt and is stored, so a restart cannot shorten it. It does not
 *   depend on how many conversations are held: ten held conversations cost one
 *   probe, not ten.
 *
 *   **A held conversation does not call the model.** An input to it is written to
 *   the transcript and starts no run, which is what `src/agent/hold-gate.ts` is
 *   for. The retry that follows a successful probe is a run with no inputs of its
 *   own, so the request carries the transcript as it stands: the failed attempt is
 *   already left out of the context (its stop reason is `error` and the library
 *   excludes those), and the text written while the conversation was held rides
 *   along in the order it arrived.
 *
 * The retry is the one part of this that leans on the durable library's internal
 * shape. The library exports no function that runs a failed generation again, so
 * this writes `run` into `pi.live` and creates the generation task in one commit,
 * which is what the library's own private `startRun` does. `test/usage-freeze.test.ts`
 * holds that path, so a library upgrade that changes it fails there first.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  LiveDoc,
  defineExtension,
  type ConversationId,
  type Cursor,
  type Extension,
  type Harness,
  type TaskId,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { setHoldGate } from "../agent/hold-gate.ts";
import {
  DOC_KINDS,
  SecAgent,
  SecUsageHold,
  SecUsageProbe,
  type AgentStatus,
  type UsageHoldRecord,
  type UsageProbeRecord,
  type UsageProbeResult,
} from "../documents.ts";
import {
  requireHarness,
  type ExtensionContext,
  type UsageFreezePass,
  type UsageFreezeWatch,
  type UsageHoldView,
} from "./context.ts";
import type { UsageCard } from "../server/usage/values.ts";

/**
 * How often the watch runs, in milliseconds.
 *
 * The interval is a constant, not a setting: it decides how quickly a 429 becomes
 * a hold and how quickly a recovered provider is asked again, and neither is worth
 * a value an operator could get wrong. It is also the closest thing this build has
 * to "the next time the balance is looked at", which is what a prepaid provider's
 * recovery is judged on.
 */
export const HOLD_TICK_MS = 60_000;

/**
 * The least time between two probes of one provider, in milliseconds.
 *
 * This number is the only thing that bounds the request rate:
 * a hold is retried without a limit on attempts, and a provider that keeps
 * refusing costs one short request per ten minutes.
 */
export const PROBE_INTERVAL_MS = 10 * 60 * 1000;

/** How long one probe may take before it counts as unanswered. */
export const PROBE_TIMEOUT_MS = 30_000;

/** How long the probe's answer may be. A probe asks a question it does not read. */
export const PROBE_MAX_TOKENS = 16;

/** The text a probe sends. It carries no context, no tools and no instruction. */
export const PROBE_PROMPT = "ping";

/** The status a provider answers with when the account is over its quota. */
const RATE_LIMIT_STATUS = 429;

/** What one provider's own numbers say about whether it accepts requests again. */
export type RecoverySignal =
  /** The provider states nothing this build can read, so only a probe can tell. */
  | { readonly kind: "none" }
  /** The provider states a quota or a balance. */
  | {
      readonly kind: "known";
      readonly recovered: boolean;
      /** When the provider says the window resets, or null when it states none. */
      readonly resetsAt: number | null;
    };

/** What a probe came to. */
export interface ProbeOutcome {
  readonly result: UsageProbeResult;
  readonly reason: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
}

/** The provider's own usage, as the watch reads it. */
export interface UsageReader {
  refresh(providerId: string): Promise<{ readonly ok: boolean; readonly answer?: { readonly card?: UsageCard } }>;
}

/** Everything the watch reads. Assembled once, so a test can hand in its own. */
export interface UsageFreezeSources {
  readonly context: ExtensionContext;
  /** The usage service, or undefined when the runtime holds none. */
  readonly usage: UsageReader | undefined;
  readonly models: Models | undefined;
  readonly isVirtual: (providerId: string) => boolean;
  /** The clock the ten-minute floor is counted on. `Date.now` unless a test sets it. */
  readonly now?: () => number;
}

/** One provider that holds at least one conversation. */
export interface HeldProvider {
  readonly provider: string;
  readonly conversations: readonly UsageHoldRecord[];
}

/**
 * The watch. One belongs to one runtime, and the runtime starts and stops it
 * beside the stall watch.
 */
export class UsageFreeze implements UsageFreezeWatch {
  /**
   * What this watch reads. Public so a test can build a second watch over the
   * same store with its own clock, which is how "the ten-minute floor survives a
   * restart" is checked without waiting ten minutes.
   */
  readonly sources: UsageFreezeSources;
  /** The conversations a hold document names. Replaced whole on every pass, so a reader never sees a half-built set. */
  #held: ReadonlySet<string> = new Set();
  #timer: ReturnType<typeof setInterval> | undefined;
  #removeGate: (() => void) | undefined;
  /** The provider list an open page last heard about, so one event says one change. */
  #announced = "";
  /** One pass at a time: a slow probe must not stack passes on itself. */
  #busy = false;
  /** The last signal read for each provider, so a status read costs no provider call. */
  readonly #signals = new Map<string, RecoverySignal>();

  constructor(sources: UsageFreezeSources) {
    this.sources = sources;
  }

  #now(): number {
    return this.sources.now?.() ?? Date.now();
  }

  /** Whether one conversation waits for its provider to accept requests again. */
  isHeld(conversationId: string): boolean {
    return this.#held.has(conversationId);
  }

  /** Install the gate `src/submit-envelope.ts` reads. Called once, by the extension. */
  install(): void {
    this.#removeGate = setHoldGate(this);
  }

  /**
   * Start the periodic pass, and take one pass at once.
   *
   * The immediate pass is what fills the gate from the documents after a restart:
   * the first input can arrive before the first timer tick, and a daemon restarted
   * in the middle of a hold must not answer that input with a model call.
   */
  startWatch(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick(BACKGROUND_CONTEXT).catch((error) => this.#log("warn", "usage hold pass failed", { error }));
    }, HOLD_TICK_MS);
    this.#timer.unref?.();
    void this.tick(BACKGROUND_CONTEXT).catch((error) => this.#log("warn", "usage hold pass failed", { error }));
  }

  /** Stop the periodic pass and take the gate out. A no-op when it was never started. */
  stopWatch(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#removeGate?.();
    this.#removeGate = undefined;
  }

  // ------------------------------------------------------------- one pass

  /** One pass: settle finished retries, judge new failures, judge each provider. */
  async tick(ctx: Context = BACKGROUND_CONTEXT): Promise<UsageFreezePass> {
    if (this.#busy) return { held: 0, probed: 0, resumed: 0 };
    this.#busy = true;
    try {
      const resumed = await this.#collectRetries(ctx);
      const held = await this.#judgeFailures(ctx);
      const probed = await this.#judgeProviders(ctx);
      await this.#refreshGate(ctx);
      this.#announce();
      return { held, probed, resumed };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Notice a hold whose retry has ended.
   *
   * The retry creates no submission, so the submission table cannot answer this:
   * the run's own task is the only record that it happened, and its terminal
   * outcome says whether the provider answered.
   */
  async #collectRetries(ctx: Context): Promise<number> {
    const harness = requireHarness(this.sources.context);
    let resumed = 0;
    for (const record of await this.#allHolds(harness, ctx)) {
      if (record.status !== "retrying" || record.retryTaskId === "") continue;
      // The id is stored as text, as every id in a document is, and a task is
      // read by its number.
      const task = await harness.getTask(Number(record.retryTaskId) as TaskId, ctx);
      if (task === undefined) {
        // The task is not in the store, so nothing will ever report it. The hold is
        // dropped rather than kept forever: an agent record that still says
        // `running` is what the stall watch reports, and that is the honest reading.
        await this.#retire(record, ctx);
        continue;
      }
      if (task.state.status !== "terminal") continue;
      const outcome = task.state.outcome;
      if (outcome.status === "completed") {
        await this.#resume(record, "the provider accepted the retried request", ctx);
        resumed += 1;
        continue;
      }
      const reason = outcome.status === "failed" ? outcome.error.message : (outcome.reason ?? outcome.status);
      if (firstNumber(reason) === RATE_LIMIT_STATUS) {
        // The short probe went through and the real request did not. That is the
        // same refusal again: hold it again, and leave the probe clock where it is
        // so the next probe is ten minutes after the one that was accepted.
        await this.#hold(record, ctx, record.retries);
        continue;
      }
      // Any other ending says the provider answered and the run failed on its own
      // terms (a model that is gone, a timeout). The freeze is over; the run has
      // left the agent's status where a failed run leaves it.
      await this.#resume(record, "the retried request ended without a usage refusal", ctx);
      resumed += 1;
    }
    return resumed;
  }

  /**
   * Hold every conversation whose run has just ended on HTTP 429.
   *
   * The submission is the evidence, and the transcript's newest assistant entry is
   * what names the provider: a failure's `detail` is the provider's own sentence
   * and carries no provider id, while the entry the library appended does. A
   * virtual provider passes the target's message through unchanged, so the entry
   * names the provider that answered; a virtual provider that failed before
   * choosing a target names itself, and that failure belongs to no account.
   */
  async #judgeFailures(ctx: Context): Promise<number> {
    const context = this.sources.context;
    const harness = requireHarness(context);
    const storage = context.storage;
    const live = await liveByConversation(storage, ctx);
    const known = new Set((await this.#allHolds(harness, ctx)).map((record) => record.conversationId));
    let held = 0;
    for (const key of await sessionKeys(storage, DOC_KINDS.agent, ctx)) {
      // A conversation that already has a hold document is this watch's own work in
      // progress, whatever its agent status says.
      if (known.has(key)) continue;
      if ((live.get(key) ?? 0) > 0) continue;
      const record = await harness.snapshot(SecAgent, key, ctx);
      if (record === undefined) continue;
      // A finished agent's transcript can hold an old 429 from work that is over.
      // Only an agent that still claims to be working is owed a hold.
      if (record.status !== "running") continue;
      const conversationId = Number(key) as ConversationId;
      const page = await storage.scanSubmissions({ conversationId, order: "descending" }, 1, undefined, ctx);
      const submission = page.items[0];
      if (submission === undefined) continue;
      if (submission.status !== "unanswered" || submission.reason !== "model_error") continue;
      const detail = typeof submission.detail === "string" ? submission.detail : "";
      if (firstNumber(detail) !== RATE_LIMIT_STATUS) continue;
      const failure = await this.#lastFailure(conversationId, ctx);
      if (failure === undefined) continue;
      if (failure.provider === "" || this.sources.isVirtual(failure.provider)) continue;
      const now = this.#now();
      await harness.commit(async (tx: Tx) => {
        const doc = await tx.doc(SecUsageHold, key, key);
        doc.conversationId = key;
        doc.provider = failure.provider;
        doc.model = failure.model;
        doc.submissionId = String(submission.id);
        doc.status = "held";
        doc.heldAt = now;
        doc.retries = 0;
        doc.lastRetryAt = 0;
        doc.retryTaskId = "";
        doc.updatedAt = now;
        const probe = await tx.doc(SecUsageProbe, failure.provider, failure.provider);
        probe.provider = failure.provider;
        if (probe.firstHeldAt === 0) probe.firstHeldAt = now;
        probe.lastModel = failure.model;
        probe.updatedAt = now;
      }, ctx);
      context.audit.append({
        type: "usage_held",
        conversationId: key,
        provider: failure.provider,
        model: failure.model,
        submissionId: String(submission.id),
      });
      await this.#writeAgentStatus(record, conversationId, "held", ctx);
      await this.#tellParent(record, failure.provider, ctx);
      held += 1;
    }
    return held;
  }

  /**
   * Tell a child's parent once that the child waits for its provider.
   *
   * The note goes out with the hold, so it happens once per hold: a second pass
   * finds the hold document and says nothing. The child itself is not woken — the
   * gate turns any input to it into a transcript write — and the note says what
   * will happen without the parent having to act.
   */
  async #tellParent(record: Readonly<{ conversationId: string; name: string; parentConversationId?: string }>, provider: string, ctx: Context): Promise<void> {
    const hub = this.sources.context.subagents;
    if (hub === undefined) return;
    if (record.parentConversationId === undefined) return;
    const full = await hub.recordOf(Number(record.conversationId) as ConversationId, ctx);
    if (full === undefined) return;
    try {
      await hub.notifyParent(
        ctx,
        Number(record.parentConversationId) as ConversationId,
        full,
        `"${record.name}" is held: ${provider} refused its model request for usage (HTTP 429). ` +
          `It will be sent again automatically as soon as ${provider} accepts a request; one short request per ten minutes checks that, and nothing is lost meanwhile. ` +
          "Its input is written to its transcript and not sent while it is held. Nothing was stopped, restarted, or deleted.",
      );
    } catch (error) {
      this.#log("warn", "the usage hold note was not delivered", { conversationId: record.conversationId, error });
    }
  }

  /**
   * The provider and model of the refusal at the tail of a conversation.
   *
   * Only the newest assistant entry counts, and it has to be the refusal itself.
   * That is what makes a hold end and what keeps one from starting twice: the retry
   * that follows a recovered provider appends its own entry, so the refusal is no
   * longer the tail. A retry that failed for another reason (a model that is gone,
   * a timeout) is not a usage limit either, so the conversation is left where the
   * run left it rather than held for the refusal that started all this.
   */
  async #lastFailure(
    conversationId: ConversationId,
    ctx: Context,
  ): Promise<{ provider: string; model: string } | undefined> {
    const page = await this.sources.context.storage.scanEntries(
      { conversationId, order: "descending" },
      20,
      undefined,
      ctx,
    );
    const entry = page.items.find((item) => item.kind === "pi.assistant");
    if (entry === undefined) return undefined;
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (message.role !== "assistant") continue;
      if (message.stopReason !== "error") return undefined;
      if (firstNumber(message.errorMessage ?? "") !== RATE_LIMIT_STATUS) return undefined;
      return { provider: String(message.provider), model: message.model };
    }
    return undefined;
  }

  /**
   * Judge every provider that holds a conversation, and probe the ones that are due.
   *
   * A provider with a readable quota is probed only once its own numbers say the
   * window has room; a provider with none is probed from the first pass. Both share
   * the ten-minute floor, which is the whole of this feature's request budget.
   */
  async #judgeProviders(ctx: Context): Promise<number> {
    const context = this.sources.context;
    const harness = requireHarness(context);
    const providers = await this.#readHolds(harness, ctx);
    const stillHeld = new Set(providers.map((entry) => entry.provider));
    // A provider that holds nothing keeps its record no longer: the probe clock only
    // has to outlive a hold, and a record left behind would be read by the banner.
    for (const record of await this.#allProbes(harness, ctx)) {
      if (stillHeld.has(record.provider)) continue;
      await harness.commit(async (tx: Tx) => {
        await tx.retireDoc(SecUsageProbe, record.provider);
      }, ctx);
      this.#signals.delete(record.provider);
    }
    let probed = 0;
    for (const entry of providers) {
      const signal = (await this.#signalOf(entry.provider)) ?? ({ kind: "none" } as const);
      this.#signals.set(entry.provider, signal);
      if (signal.kind === "known" && !signal.recovered) {
        // The provider says its window has no room yet. Nothing is sent: the next
        // pass reads the numbers again, and a page that asks sees the reset time.
        continue;
      }
      const done = await harness.snapshot(SecUsageProbe, entry.provider, ctx);
      const now = this.#now();
      const lastAt = done?.lastProbeAt ?? 0;
      if (lastAt !== 0 && now - lastAt < PROBE_INTERVAL_MS) continue;
      const model = entry.conversations[0]?.model ?? "";
      const outcome = await this.#probe(entry.provider, model);
      probed += 1;
      await harness.commit(async (tx: Tx) => {
        const doc = await tx.doc(SecUsageProbe, entry.provider, entry.provider);
        doc.provider = entry.provider;
        doc.lastProbeAt = now;
        doc.lastResult = outcome.result;
        doc.lastReason = outcome.reason;
        doc.lastModel = outcome.model;
        if (doc.firstHeldAt === 0) doc.firstHeldAt = now;
        doc.updatedAt = this.#now();
      }, ctx);
      context.audit.append({
        type: "usage_probed",
        provider: entry.provider,
        model: outcome.model,
        result: outcome.result,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        cost: outcome.cost,
        ...(outcome.reason === "" ? {} : { reason: outcome.reason }),
      });
      if (outcome.result === "ok") await this.#retryProvider(entry, ctx);
    }
    return probed;
  }

  /**
   * One short model request to the provider, and what it came to.
   *
   * It goes through `Models.completeSimple`, which builds a real request with no
   * conversation behind it: no system prompt, no tools and no transcript. The
   * library's adapters put no retry on a simple call unless one is asked for, so
   * this is one request. It never throws: a request that cannot be prepared comes
   * back as a message whose stop reason is `error`.
   */
  async #probe(provider: string, modelId: string): Promise<ProbeOutcome> {
    const models = this.sources.models;
    const blank: ProbeOutcome = { result: "failed", reason: "", model: modelId, inputTokens: 0, outputTokens: 0, cost: 0 };
    if (models === undefined) return { ...blank, reason: "no model catalog is available" };
    if (modelId === "") return { ...blank, reason: "the hold names no model" };
    const model = models.getModel(provider, modelId);
    if (model === undefined) return { ...blank, reason: `the model is not in the catalog for ${provider}` };
    try {
      const message = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: PROBE_PROMPT, timestamp: this.#now() }] },
        { maxTokens: PROBE_MAX_TOKENS, timeoutMs: PROBE_TIMEOUT_MS, maxRetries: 0 },
      );
      const counted = {
        model: message.model === "" ? modelId : message.model,
        inputTokens: message.usage?.input ?? 0,
        outputTokens: message.usage?.output ?? 0,
        cost: message.usage?.cost?.total ?? 0,
      };
      if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
        return { ...counted, result: "ok", reason: "" };
      }
      const reason = message.errorMessage ?? `the probe ended with ${message.stopReason}`;
      return {
        ...counted,
        result: firstNumber(reason) === RATE_LIMIT_STATUS ? "rate_limited" : "failed",
        reason: describe(reason),
      };
    } catch (error) {
      return { ...blank, reason: describe(error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Retry every conversation one provider holds, with no new input.
   *
   * The run is one generation task and the `run` field of the conversation's live
   * document, written in one commit: the library's scheduler picks the task up, and
   * the generation reads the task id from `run`. Nothing is submitted, so the
   * submission table keeps the failure that started the hold, and the request
   * carries the transcript exactly as it stands.
   */
  async #retryProvider(entry: HeldProvider, ctx: Context): Promise<void> {
    const context = this.sources.context;
    const harness = requireHarness(context);
    for (const record of entry.conversations) {
      const conversationId = Number(record.conversationId) as ConversationId;
      let taskId = "";
      try {
        taskId = await harness.commit(async (tx: Tx) => {
          const live = await tx.doc(LiveDoc, conversationId);
          // A conversation that is already running needs no retry: its own run will
          // end on its own terms, and the hold was judged by that run's outcome.
          if (live.run !== undefined) return "";
          const id = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId });
          live.run = { taskId: id, inputs: [], turns: 0 };
          const doc = await tx.doc(SecUsageHold, record.conversationId, record.conversationId);
          doc.status = "retrying";
          doc.retries = record.retries + 1;
          doc.lastRetryAt = this.#now();
          doc.retryTaskId = String(id);
          doc.updatedAt = this.#now();
          return String(id);
        }, ctx);
      } catch (error) {
        this.#log("warn", "the usage retry could not start", { conversationId: record.conversationId, error });
        continue;
      }
      if (taskId === "") continue;
      context.audit.append({
        type: "usage_retried",
        conversationId: record.conversationId,
        provider: record.provider,
        model: record.model,
        retries: record.retries + 1,
        taskId,
      });
      // The agent is working again from this moment, and every reader that looks at
      // the status has to see that: the parent's "is it working" test, the stall
      // watch and the chat page.
      const agent = await harness.snapshot(SecAgent, record.conversationId, ctx);
      if (agent !== undefined) await this.#writeAgentStatus(agent, conversationId, "running", ctx);
    }
  }

  /**
   * Write the agent status one way, through the subagent hub when there is one.
   *
   * The hub is the owner of `sec.agent`: it writes the audit row a status change
   * earns and tells the restart watch that a safe point moved. A runtime with no
   * hub (a test that builds its own) gets the plain write.
   */
  async #writeAgentStatus(
    record: Readonly<{ conversationId: string }>,
    conversationId: ConversationId,
    status: AgentStatus,
    ctx: Context,
  ): Promise<void> {
    const hub = this.sources.context.subagents;
    if (hub !== undefined) {
      await hub.setStatus(ctx, conversationId, status, {});
      return;
    }
    const harness = requireHarness(this.sources.context);
    await harness.commit(async (tx: Tx) => {
      const doc = await tx.doc(SecAgent, record.conversationId, record.conversationId);
      if (doc.status === status) return;
      doc.status = status;
      doc.updatedAt = this.#now();
    }, ctx);
  }

  /** End one hold: the provider accepted a request, or answered without a usage refusal. */
  async #resume(record: UsageHoldRecord, why: string, ctx: Context): Promise<void> {
    await this.#retire(record, ctx);
    this.sources.context.audit.append({
      type: "usage_resumed",
      conversationId: record.conversationId,
      provider: record.provider,
      heldMs: record.heldAt === 0 ? 0 : Math.max(0, this.#now() - record.heldAt),
      reason: why,
    });
  }

  /**
   * Hold one conversation, from a first refusal or from a retry that was refused.
   *
   * The provider's probe record keeps its `lastProbeAt`, so the next probe is ten
   * minutes after the one that went through, not ten minutes after this write.
   */
  async #hold(record: UsageHoldRecord, ctx: Context, retries: number): Promise<void> {
    const context = this.sources.context;
    const harness = requireHarness(context);
    const now = this.#now();
    await harness.commit(async (tx: Tx) => {
      const doc = await tx.doc(SecUsageHold, record.conversationId, record.conversationId);
      doc.status = "held";
      doc.heldAt = now;
      doc.retries = retries;
      doc.retryTaskId = "";
      doc.updatedAt = now;
      const probe = await tx.doc(SecUsageProbe, record.provider, record.provider);
      probe.provider = record.provider;
      if (probe.firstHeldAt === 0) probe.firstHeldAt = now;
      probe.updatedAt = now;
    }, ctx);
    context.audit.append({
      type: "usage_held",
      conversationId: record.conversationId,
      provider: record.provider,
      model: record.model,
      submissionId: record.submissionId,
      retries,
    });
    const agent = await harness.snapshot(SecAgent, record.conversationId, ctx);
    if (agent !== undefined) {
      await this.#writeAgentStatus(agent, Number(record.conversationId) as ConversationId, "held", ctx);
    }
  }

  /** Drop one hold document, leaving the agent's status to whoever owns it next. */
  async #retire(record: UsageHoldRecord, ctx: Context): Promise<void> {
    const harness = requireHarness(this.sources.context);
    await harness.commit(async (tx: Tx) => {
      await tx.retireDoc(SecUsageHold, record.conversationId);
    }, ctx);
  }

  // ------------------------------------------------------------ the reads

  /** Every hold document. */
  async #allHolds(harness: Harness, ctx: Context): Promise<readonly UsageHoldRecord[]> {
    const keys = await sessionKeys(this.sources.context.storage, DOC_KINDS.usageHold, ctx);
    const out: UsageHoldRecord[] = [];
    for (const key of keys) {
      const record = await harness.snapshot(SecUsageHold, key, ctx);
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  /** Every probe document. */
  async #allProbes(harness: Harness, ctx: Context): Promise<readonly UsageProbeRecord[]> {
    const keys = await sessionKeys(this.sources.context.storage, DOC_KINDS.usageProbe, ctx);
    const out: UsageProbeRecord[] = [];
    for (const key of keys) {
      const record = await harness.snapshot(SecUsageProbe, key, ctx);
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  /** The holds, grouped by the provider that caused them. */
  async #readHolds(harness: Harness, ctx: Context): Promise<HeldProvider[]> {
    const groups = new Map<string, UsageHoldRecord[]>();
    for (const record of await this.#allHolds(harness, ctx)) {
      if (record.provider === "") continue;
      const list = groups.get(record.provider);
      if (list === undefined) groups.set(record.provider, [record]);
      else list.push(record);
    }
    return [...groups.entries()]
      .map(([provider, conversations]) => ({ provider, conversations }))
      .sort((left, right) => (left.provider < right.provider ? -1 : 1));
  }

  /** Rebuild the gate from the documents. Only a `held` conversation is closed to input. */
  async #refreshGate(ctx: Context): Promise<void> {
    const harness = requireHarness(this.sources.context);
    const names = (await this.#allHolds(harness, ctx))
      .filter((record) => record.status === "held")
      .map((record) => record.conversationId);
    this.#held = new Set(names);
  }

  /** What one provider's own numbers say, read through the usage service. */
  async #signalOf(provider: string): Promise<RecoverySignal | undefined> {
    const usage = this.sources.usage;
    if (usage === undefined) return { kind: "none" };
    try {
      const answer = await usage.refresh(provider);
      const card = answer.ok ? answer.answer?.card : undefined;
      if (card === undefined) return { kind: "none" };
      return signalOfCard(card, this.#now());
    } catch {
      return { kind: "none" };
    }
  }

  /**
   * What `GET /api/admin/status` carries, one entry per provider that holds a
   * conversation.
   *
   * It reads documents and the last signal each provider gave, and calls no
   * provider: a page load must not cost a quota read. The recovery time and the
   * probe clock are what the banner draws, and an empty list is what takes the
   * banner down.
   */
  async holdView(ctx: Context = BACKGROUND_CONTEXT): Promise<UsageHoldView[]> {
    const harness = requireHarness(this.sources.context);
    const providers = await this.#readHolds(harness, ctx);
    const views: UsageHoldView[] = [];
    for (const entry of providers) {
      const probe = await harness.snapshot(SecUsageProbe, entry.provider, ctx);
      const signal = this.#signals.get(entry.provider) ?? (await this.#signalOf(entry.provider)) ?? { kind: "none" as const };
      const resetsAt = signal.kind === "known" ? (signal.resetsAt ?? undefined) : undefined;
      views.push({
        provider: entry.provider,
        conversations: entry.conversations.length,
        readable: signal.kind === "known",
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(probe === undefined || probe.lastProbeAt === 0
          ? {}
          : {
              lastProbeAt: probe.lastProbeAt,
              lastProbeResult: probe.lastResult,
              ...(probe.lastReason === "" ? {} : { lastProbeReason: probe.lastReason }),
              nextProbeAt: probe.lastProbeAt + PROBE_INTERVAL_MS,
            }),
      });
    }
    return views;
  }

  /** One event per change of the held provider list, so an open page re-reads it. */
  #announce(): void {
    const providers = [...this.#signals.keys()]
      .filter(() => [...this.#held].some((name) => name !== ""))
      .sort();
    const key = this.#held.size === 0 ? "" : providers.join(",");
    if (key === this.#announced) return;
    this.#announced = key;
    this.sources.context.events.emit("usage_hold_changed", { providers: key === "" ? [] : key.split(",") });
  }

  #log(level: "warn" | "info", message: string, fields?: Record<string, unknown>): void {
    const logger = this.sources.context.logger;
    if (level === "info") logger.info(message, fields);
    else logger.warn(message, fields);
  }
}

/**
 * What one usage card says about whether its provider accepts requests again.
 *
 * A subscription card states the windows' utilization and the moments they reset;
 * a prepaid card states a balance. Either is a signal only when the value is
 * actually there: a card whose reader failed, or whose provider has no reader,
 * states `wip` or an error, and that is "this server cannot tell", which makes the
 * probe the only judge.
 */
export function signalOfCard(card: UsageCard, now: number): RecoverySignal {
  if (card.shape === "subscription") {
    const field = card.fields["fiveHour"] ?? card.fields["weekly"];
    if (field === undefined || field.state !== "value") return { kind: "none" };
    const value = field.value as { readonly utilization?: unknown; readonly resetsAt?: unknown } | null;
    if (value === null || typeof value !== "object") return { kind: "none" };
    const utilization = typeof value.utilization === "number" ? value.utilization : null;
    const resetAt = value.resetsAt;
    const resetsAt =
      resetAt !== null && typeof resetAt === "object" && typeof (resetAt as { at?: unknown }).at === "number"
        ? (resetAt as { at: number }).at
        : null;
    // The window has room when the provider's own number says less than all of it
    // is used. That is what "the reset time has passed and some is left" comes to
    // once the value is read again: a window that reset reports a low utilization
    // and the moment it will reset next. A utilization the provider did not state is
    // left to the probe, because "no room" and "cannot tell" are two different
    // claims.
    const recovered = utilization !== null && utilization < 100;
    return { kind: "known", recovered, resetsAt };
  }
  const field = card.fields["balance"];
  if (field === undefined || field.state !== "value") return { kind: "none" };
  const value = field.value as { readonly amount?: unknown } | null;
  if (value === null || typeof value !== "object") return { kind: "none" };
  const amount = typeof value.amount === "number" ? value.amount : null;
  // A balance card with no amount states a sentence in its place (a provider whose
  // balance no API reports), and that is no signal at all.
  if (amount === null) return { kind: "none" };
  return { kind: "known", recovered: amount > 0, resetsAt: null };
}

/** The first three-digit number of a provider's sentence, or undefined. */
export function firstNumber(message: string): number | undefined {
  const found = /^\s*(\d{3})\b/.exec(message)?.[1];
  return found === undefined ? undefined : Number(found);
}

/** A failure reason that says what kind of failure this was and little else. */
function describe(message: string): string {
  const first = message.split("\n")[0] ?? "";
  return first.slice(0, 120);
}

/**
 * The conversations with a live task right now, and how many each has.
 *
 * It is read from storage rather than from `harness.inspect()`, because the
 * inspector lists the tasks the scheduler loaded in this process, and a retry this
 * watch started is not one of them until the scheduler picks it up. A conversation
 * with a run in flight needs no hold: its own run will end on its own terms.
 */
async function liveByConversation(storage: ExtensionContext["storage"], ctx: Context): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  for (const status of ["pending", "running", "waiting"] as const) {
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await storage.scanTasks({ status, order: "ascending" }, 200, cursor, ctx);
      for (const task of page.items) {
        const key = String(task.conversationId);
        live.set(key, (live.get(key) ?? 0) + 1);
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }
  return live;
}

/** Every key of one session-scoped document family, read the way the subagent hub reads them. */
async function sessionKeys(
  storage: ExtensionContext["storage"],
  kind: string,
  ctx: Context,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: Parameters<ExtensionContext["storage"]["scanDocuments"]>[2];
  for (;;) {
    const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 200, cursor, ctx);
    for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return keys;
}

/** The bundled `usage-freeze` extension. */
export function createUsageFreezeExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const watch = new UsageFreeze({
    context,
    usage: context.usage,
    models: context.models,
    isVirtual: (providerId) => context.isVirtualProvider?.(providerId) === true,
  });
  watch.install();
  context.usageFreeze = watch;
  return defineExtension({ name: "usage-freeze" });
}
