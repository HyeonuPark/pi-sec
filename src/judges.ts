/**
 * Judge models: one text in, fixed questions answered.
 *
 * A judge is a pi-ai **classifier** model (`type: "classifier"`), named in the
 * top-level `judges` table the way a `vmodels` entry names a conversation model.
 * Code calls one by that name:
 *
 * ```ts
 * const result = await context.judges.judge("reply-language", { state, questions });
 * ```
 *
 * A judge is answered by the Decisions API client in
 * `judges-openai-decisions.ts`, which pi-sec sends itself. The pi-ai classifier
 * call is not used: it turns one refused question into an error for the whole
 * request, and a refusal belongs to its own question. A judge whose model names
 * another api is skipped, because this is the only service pi-sec speaks to.
 *
 * The call has exactly three outcomes and never throws:
 *
 * - `answered`: one answer per question, with its probability, and the token
 *   usage when the service reports it. A question the service refused to answer
 *   has no probability; its key is in `refused`, and the other answers stand.
 * - `skipped`: the name is not in the table (`"name"`), the model is not in the
 *   catalog or the credential cannot reach it (`"model"`), the provider has no
 *   credential (`"auth"`), or the model's api is not one pi-sec calls (`"api"`).
 *   Nothing was called.
 * - `failed`: the call ran past its deadline (`"timeout"`), the service answered
 *   429 and the call gave up (`"rate_limited"`), or the provider answered with
 *   another error (`"provider"`). The failure carries the reason and, when the
 *   service answered with an error, its status, the wait it asked for, and the
 *   short error type and code. The provider's own message and body are dropped,
 *   because they can echo the text under judgement.
 *
 * A caller treats anything but `answered` as "the judge said nothing" and goes
 * on with its own fallback: a judgement must never be able to stop the work that
 * asked for it.
 *
 * Two rules keep the table honest:
 *
 * - Only classifier models are looked up. `getModelOfType("classifier", …)`
 *   cannot return the chat model of the same id, so a chat model can never stand
 *   in for a judge, and no code path here calls one.
 * - Every call appends one audit line: the name, the provider, the model, the
 *   outcome, the reason and the HTTP facts of a failure, the elapsed time, the refused question keys, the token counts and
 *   the cost. The text under judgement is never written, in the audit line or
 *   anywhere else. The token counts and the cost are the ones the service
 *   reported, also for a failed call, because a reply that cannot be read was
 *   still billed.
 *
 * Judgements are not added to a provider card. A provider card counts the calls
 * pi-sec made inside a conversation, and a judgement runs outside every
 * conversation, so its tokens are not in the ledger those cards sum. The usage
 * page shows them on a card of their own, "Decision models", which is built from
 * this audit trail: the same lines this file writes, summed by judge name over the
 * last 24 hours, 7 days and 30 days (`src/server/usage/judges.ts`). That card's
 * cost is not added to any provider card's total, so one call is never counted
 * twice.
 */
import type {
  AuthCheck,
  ClassifierAnswer,
  ClassifierApi,
  ClassifierModel,
  ClassifierQuestion,
  JsonObject,
  Models,
  Usage,
} from "@earendil-works/pi-ai";
import type { DecisionsAuth, DecisionsHttpFailure } from "./judges-openai-decisions.ts";
import { classifyWithDecisions, DECISIONS_API } from "./judges-openai-decisions.ts";
import type { Config } from "./config/schema.ts";
import type { AuditLog } from "./runtime/audit.ts";
import type { Logger } from "./runtime/logger.ts";

/** The HTTP facts of a failure, each only when known. */
function httpFields(http: DecisionsHttpFailure): Pick<JudgeFailed, "status" | "retryAfterMs" | "errorType" | "errorCode"> {
  return {
    status: http.status,
    ...(http.retryAfterMs === undefined ? {} : { retryAfterMs: http.retryAfterMs }),
    ...(http.errorType === undefined ? {} : { errorType: http.errorType }),
    ...(http.errorCode === undefined ? {} : { errorCode: http.errorCode }),
  };
}

/** Deadline of one judgement when its config entry names none, in milliseconds. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 5000;

/** Why a judgement was skipped. Nothing was asked of the model. */
export type JudgeSkipReason =
  /** No entry of that name in `config.judges`. */
  | "name"
  /** The provider has no classifier model of that id that this credential can reach. */
  | "model"
  /** The provider has no credential, so no model of it can be called. */
  | "auth"
  /** The model's api is not one pi-sec calls, so nothing here can ask it. */
  | "api";

/** Why a judgement failed. The model was asked and gave no usable answer. */
export type JudgeFailureReason =
  /** The deadline timer fired and the call was aborted. */
  | "timeout"
  /** The service answered 429 and the call gave up: the wait did not fit, or the retries ran out. */
  | "rate_limited"
  /** The provider answered with another error, or the call itself broke. */
  | "provider";

/** What one judgement is asked: the text to judge, and the questions about it. */
export interface JudgeRequest {
  /** The text to judge. Never written to the log or the audit trail. */
  readonly state: JsonObject;
  /** One question per key. pi-ai's three shapes: bool, choice, score. */
  readonly questions: Record<string, ClassifierQuestion>;
}

/** The model answered every question, one answer or one refusal each. */
export interface JudgeAnswered {
  readonly outcome: "answered";
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  /** One answer per question that was answered. A refused key has none. */
  readonly answers: Record<string, ClassifierAnswer>;
  /** The question keys the service refused to answer. Empty when it refused none. */
  readonly refused: readonly string[];
  /** Token usage and its cost at the catalog price, when the service reports it. */
  readonly usage?: Usage;
  readonly elapsedMs: number;
}

/** Nothing was asked of a model. */
export interface JudgeSkipped {
  readonly outcome: "skipped";
  readonly name: string;
  readonly reason: JudgeSkipReason;
  /** Absent when the name itself is unknown: there is no entry to read them from. */
  readonly provider?: string;
  readonly modelId?: string;
  readonly elapsedMs: number;
}

/** The model was asked and gave no usable answer. No provider text is carried. */
export interface JudgeFailed {
  readonly outcome: "failed";
  readonly name: string;
  readonly reason: JudgeFailureReason;
  readonly provider: string;
  readonly modelId: string;
  /**
   * What the service reported using, when it reported anything. A reply that
   * cannot be read was still billed, so its usage is kept.
   */
  readonly usage?: Usage;
  readonly elapsedMs: number;
  /** The HTTP status of the last error response, when the service sent one. */
  readonly status?: number;
  /** The wait the service asked for, in milliseconds, when it named one. */
  readonly retryAfterMs?: number;
  /** The short `error.type` of the response, when it is a plain token. */
  readonly errorType?: string;
  /** The short `error.code` of the response, when it is a plain token. */
  readonly errorCode?: string;
}

export type JudgeResult = JudgeAnswered | JudgeSkipped | JudgeFailed;

export interface JudgesOptions {
  /** The live config. Read on every call, so a reloaded config reaches the next judgement. */
  readonly getConfig: () => Config;
  /** The model catalog: classifier lookup, availability, and the provider credentials. */
  readonly models: Models;
  readonly logger: Logger;
  /** Where each call leaves its one line. */
  readonly audit: AuditLog;
  /** `globalThis.fetch` unless a test injects one: the judge's HTTP call. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The judges named in `config.judges`.
 *
 * One instance lives in the extension context (`context.judges`), so a runtime
 * extension calls a judge without holding a model runtime of its own.
 */
export class Judges {
  readonly #getConfig: () => Config;
  readonly #models: Models;
  readonly #logger: Logger;
  readonly #audit: AuditLog;
  readonly #fetch: typeof globalThis.fetch | undefined;

  constructor(options: JudgesOptions) {
    this.#getConfig = options.getConfig;
    this.#models = options.models;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#fetch = options.fetch;
  }

  /**
   * Ask one configured judge the questions, and report what happened.
   *
   * Never throws, whatever the config, the credential store or the provider
   * does: an extension that judges a reply must be able to go on without one.
   */
  async judge(name: string, request: JudgeRequest): Promise<JudgeResult> {
    const started = Date.now();
    const result = await this.#run(name, request, started);
    this.#writeAudit(result);
    if (result.outcome === "failed") this.#warnFailed(result);
    return result;
  }

  /**
   * One warning line per configured judge that cannot answer.
   *
   * Run after every extension load pass, beside `warnMissingVmodels`: a reload
   * that drops a provider, or a credential that expired, leaves a judge entry
   * naming something nothing can call, and the next judgement of it is skipped
   * without a word to the operator. Two checks, because the two causes are
   * different and only one of them the operator can fix by logging in:
   *
   * - the provider has no classifier model of that id;
   * - the provider has no credential (`checkAuth` answers nothing);
   * - the model's api is not the one pi-sec calls, so the entry names a model
   *   nothing here can ask.
   *
   * All three are warnings, not a stop: a judge nothing calls, or one a caller
   * can do without, must not keep the daemon from starting.
   */
  async warnMissing(): Promise<void> {
    for (const [name, entry] of Object.entries(this.#getConfig().judges)) {
      const model = this.#models.getModelOfType("classifier", entry.provider, entry.modelId);
      if (model === undefined) {
        this.#logger.warn("judge names a classifier model the catalog does not have", {
          judge: name,
          provider: entry.provider,
          model: entry.modelId,
        });
        continue;
      }
      if (model.api !== DECISIONS_API) {
        this.#logger.warn("judge names a model whose api pi-sec does not call", {
          judge: name,
          provider: entry.provider,
          model: entry.modelId,
          api: model.api,
        });
        continue;
      }
      let auth: AuthCheck | undefined;
      try {
        auth = await this.#models.checkAuth(entry.provider);
      } catch {
        // A credential store that cannot be read answers the same call the same
        // way as a missing credential: the judgement is skipped, so the operator
        // needs the same line.
        auth = undefined;
      }
      if (auth === undefined) {
        this.#logger.warn("judge names a provider with no credentials", { judge: name, provider: entry.provider });
      }
    }
  }

  /** Resolve, check, call, and turn every way out into one of the three outcomes. */
  async #run(name: string, request: JudgeRequest, started: number): Promise<JudgeResult> {
    const entry = Object.hasOwn(this.#getConfig().judges, name) ? this.#getConfig().judges[name] : undefined;
    if (entry === undefined) return { outcome: "skipped", name, reason: "name", elapsedMs: Date.now() - started };
    const { provider, modelId } = entry;
    const elapsed = (): number => Date.now() - started;
    const skipped = (reason: JudgeSkipReason): JudgeSkipped => ({
      outcome: "skipped",
      name,
      reason,
      provider,
      modelId,
      elapsedMs: elapsed(),
    });
    const failed = (reason: JudgeFailureReason, usage?: Usage, http?: DecisionsHttpFailure): JudgeFailed => ({
      outcome: "failed",
      name,
      reason,
      provider,
      modelId,
      ...(usage === undefined ? {} : { usage }),
      elapsedMs: elapsed(),
      ...(http === undefined ? {} : httpFields(http)),
    });
    try {
      // Classifier models only: the chat model of the same id is a different
      // catalog entry, and nothing here builds a chat request.
      const model = this.#models.getModelOfType("classifier", provider, modelId);
      if (model === undefined) return skipped("model");
      const auth = await this.#models.checkAuth(provider);
      if (auth === undefined) return skipped("auth");
      if (!(await this.#reachable(provider, modelId))) return skipped("model");
      // One service is spoken to. A model of another api is skipped before the
      // credential is read: there is no request to send it.
      if (model.api !== DECISIONS_API) return skipped("api");
      const credential = await this.#credential(model);
      if (credential === undefined) return skipped("auth");
      const result = await classifyWithDecisions({
        model,
        auth: credential,
        state: request.state,
        questions: request.questions,
        timeoutMs: entry.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
      if (result.kind === "timeout") return failed("timeout", result.usage, result.http);
      if (result.kind === "rate_limited") return failed("rate_limited", result.usage, result.http);
      if (result.kind === "failed") return failed("provider", result.usage, result.http);
      return {
        outcome: "answered",
        name,
        provider,
        modelId,
        answers: result.answers,
        refused: result.refused,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        elapsedMs: elapsed(),
      };
    } catch {
      // The catalog or the credential store threw where the library says it does
      // not. The judgement is the thing that may not stop the caller, so this is
      // a failure like any other, and the message stays out of the result.
      return failed("provider");
    }
  }

  /**
   * Whether this provider's credential can reach the classifier model.
   *
   * The catalog lists a model even when the current credential cannot use it:
   * the `openai` provider drops its classifier models from the available list
   * while its credential is a ChatGPT login, because the Decisions API refuses
   * that token. The lookup above reads the catalog, so this second check is what
   * turns that case into `"model"` instead of a failed call. A provider whose
   * availability cannot be read is given the benefit of the doubt, and the call
   * itself reports its refusal as a failed judgement.
   */
  async #reachable(provider: string, modelId: string): Promise<boolean> {
    try {
      const available = await this.#models.getAvailableOfType("classifier", provider);
      return available.some((model) => model.id === modelId);
    } catch {
      return true;
    }
  }

  /**
   * The key and headers of one call, from the same credential lookup the other
   * model calls use.
   *
   * The key is used in the request header only. A store that throws, or an answer
   * with no key, is the `"auth"` skip: nothing can be sent.
   */
  async #credential(model: ClassifierModel<ClassifierApi>): Promise<DecisionsAuth | undefined> {
    try {
      const resolved = await this.#models.getAuth(model);
      const auth = resolved?.auth;
      if (auth?.apiKey === undefined || auth.apiKey === "") return undefined;
      // A header the credential store sets to null is one pi-ai drops, not a
      // header with an empty value.
      const headers = Object.fromEntries(
        Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
      );
      return {
        apiKey: auth.apiKey,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
      };
    } catch {
      return undefined;
    }
  }

  /** One warning line per failed judgement, with the reason and the HTTP facts. No judged text. */
  #warnFailed(result: JudgeFailed): void {
    this.#logger.warn("judge failed", {
      judge: result.name,
      provider: result.provider,
      model: result.modelId,
      reason: result.reason,
      elapsedMs: result.elapsedMs,
      ...failureFacts(result),
    });
  }

  /**
   * One audit line per call.
   *
   * The counts are the ones a reader adds up, and no field can hold the judged
   * text: `state` is not read here at all. A skipped call writes zeros, and a
   * failed call writes the usage the service reported, because a reply that could
   * not be read was still billed. Every line has the same fields.
   *
   * `refused` is the question keys the service would not answer. It is empty when
   * it refused none, and it never holds the questions themselves.
   */
  #writeAudit(result: JudgeResult): void {
    const usage = result.outcome === "answered" || result.outcome === "failed" ? result.usage : undefined;
    this.#audit.append({
      type: "judge",
      judge: result.name,
      ...(result.provider === undefined ? {} : { provider: result.provider }),
      ...(result.modelId === undefined ? {} : { model: result.modelId }),
      outcome: result.outcome,
      ...(result.outcome === "answered" ? {} : { reason: result.reason }),
      ...(result.outcome === "failed" ? failureFacts(result) : {}),
      refused: result.outcome === "answered" ? [...result.refused] : [],
      elapsedMs: result.elapsedMs,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: usage?.cost.total ?? 0,
    });
  }
}

/** The HTTP fields a failed judgement knows, for the audit line and the log line. */
function failureFacts(result: JudgeFailed): Record<string, string | number> {
  return {
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    ...(result.errorType === undefined ? {} : { errorType: result.errorType }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}
