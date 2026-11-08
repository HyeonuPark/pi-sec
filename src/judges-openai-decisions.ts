/**
 * The OpenAI Decisions API, called directly by a judge.
 *
 * `POST {baseUrl}/decisions` with `{ model, input, questions }` answers one item
 * per question. An item is a probability for a predicate question, a chosen value
 * with its probabilities for a choice question, a score for a score question, or a
 * refusal. A refusal belongs to the question it names and leaves every other
 * answer in place, which is why this client exists: the classifier call in pi-ai
 * turns one refusal into an error for the whole request.
 *
 * The request body is the one pi-ai 1.1.0 builds. Its code was read and copied
 * here rather than called, so a pi-ai upgrade cannot change what a judge sends.
 * The input is the judged text as JSON; a judge has no images to add.
 *
 * What this client guarantees:
 *
 * - One answer per question, or the question key in `refused`. Every question
 *   refused is still `answered`, with no answers and every key refused.
 * - A call that ends without an answer says why. A 429 that is not waited for
 *   or not recovered is `rate_limited`. Any other status is `failed` with the
 *   status. `timeout` is only the deadline timer firing. The failure carries the
 *   status, the wait the service asked for, and the short error type and code of
 *   the body, and never its message.
 * - A malformed reply is `failed`: an unknown answer type, a missing answer, an
 *   answer of the wrong type for its question, a probability that is not a number
 *   between 0 and 1, or a body that is not JSON. No provider text leaves here.
 * - Retries follow pi-ai's rules. A connection error, 408, 409, 429 and 500 or
 *   above are sent again, at most twice. 504 is not retried: it is the gateway
 *   timing out on a large input, and the same input meets it again. Neither is any
 *   other 4xx. The wait is the `retry-after` the service names, or 0.5 s and then
 *   1 s, and the whole call stays inside its deadline.
 * - Usage is summed over every response that reported it, and priced from the
 *   model catalog by pi-ai's `calculateCost`. A response whose answers are
 *   malformed was still billed, so a failed call keeps its usage.
 *
 * A refusal is an answer, not an HTTP error, so it is never retried.
 */
import {
  calculateCost,
  type ClassifierAnswer,
  type ClassifierModel,
  type ClassifierQuestion,
  type JsonObject,
  type Usage,
} from "@earendil-works/pi-ai";

/** The classifier api this client speaks. Another api is not called at all. */
export const DECISIONS_API = "openai-decisions";

/** How many times one request is sent again after a retryable failure. */
const MAX_RETRIES = 2;

/** The wait before the first and the second retry when the service names none, in milliseconds. */
const BACKOFF_MS: readonly number[] = [500, 1000];

/** An HTTP status that means the gateway timed out on the input, which a retry does not change. */
const GATEWAY_TIMEOUT = 504;

/** The credential one call uses. The key goes into the `Authorization` header only. */
export interface DecisionsAuth {
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the catalog address when the credential store names one. */
  readonly baseUrl?: string;
}

/** One judgement to ask of the service. */
export interface DecisionsRequest {
  /** The catalog entry of the classifier model: its id, its address, and its price. */
  readonly model: ClassifierModel<string>;
  readonly auth: DecisionsAuth;
  /** The text to judge. Sent as JSON and never written anywhere else. */
  readonly state: JsonObject;
  readonly questions: Record<string, ClassifierQuestion>;
  /** The deadline of the whole call, retries and waits included, in milliseconds. */
  readonly timeoutMs: number;
  /** `globalThis.fetch` unless a test injects one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Every question has an answer, or its key is in `refused`. */
export interface DecisionsAnswered {
  readonly kind: "answered";
  readonly answers: Record<string, ClassifierAnswer>;
  /** The keys the service refused to answer, in the order of the questions. */
  readonly refused: readonly string[];
  readonly usage?: Usage;
}

/**
 * What the last non-ok response said, as far as it is safe to keep.
 *
 * `errorType` and `errorCode` come from `error.type` and `error.code` of a JSON
 * body and are kept only when they match `^[A-Za-z0-9_.-]{1,64}$`. The message of
 * the body is never read.
 */
export interface DecisionsHttpFailure {
  readonly status: number;
  /** The wait the service named in `retry-after-ms` or `retry-after`, in milliseconds. */
  readonly retryAfterMs?: number;
  readonly errorType?: string;
  readonly errorCode?: string;
}

/** The service answered in a shape this client cannot read, or not at all. */
export interface DecisionsFailed {
  readonly kind: "failed";
  readonly usage?: Usage;
  /** The last non-ok response, when the call ended on one. */
  readonly http?: DecisionsHttpFailure;
}

/** The service answered 429 and the call gave up: the wait did not fit, or the retries ran out. */
export interface DecisionsRateLimited {
  readonly kind: "rate_limited";
  readonly usage?: Usage;
  readonly http: DecisionsHttpFailure;
}

/** The deadline timer fired. */
export interface DecisionsTimedOut {
  readonly kind: "timeout";
  readonly usage?: Usage;
  /** The last non-ok response before the deadline, when there was one. */
  readonly http?: DecisionsHttpFailure;
}

export type DecisionsOutcome = DecisionsAnswered | DecisionsFailed | DecisionsRateLimited | DecisionsTimedOut;

/** One question in the shape the service reads. */
type WireQuestion =
  | { readonly type: "predicate"; readonly name: string; readonly instructions: string }
  | {
      readonly type: "choice";
      readonly name: string;
      readonly instructions: string;
      readonly choices: readonly { readonly value: string; readonly description?: string }[];
    }
  | {
      readonly type: "score";
      readonly name: string;
      readonly instructions: string;
      readonly levels: readonly { readonly label: string }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A probability is a number from 0 to 1; anything else is a malformed answer. */
function isProbability(value: unknown): value is number {
  return isNumber(value) && value >= 0 && value <= 1;
}

/**
 * A predicate has no criteria field, so the meaning of true and false goes into
 * the instructions, the way pi-ai sends it.
 */
function predicateInstructions(question: Extract<ClassifierQuestion, { type: "bool" }>): string {
  const meanings = [
    question.criteria.true ? `True means: ${question.criteria.true}` : "",
    question.criteria.false ? `False means: ${question.criteria.false}` : "",
  ].filter(Boolean);
  return meanings.length > 0 ? `${question.instructions}\n\n${meanings.join("\n")}` : question.instructions;
}

/** One question as the service reads it. `bool` is the service's `predicate`. */
function wireQuestion(name: string, question: ClassifierQuestion): WireQuestion {
  if (question.type === "choice") {
    return {
      type: "choice",
      name,
      instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) =>
        description ? { value, description } : { value },
      ),
    };
  }
  if (question.type === "score") {
    return {
      type: "score",
      name,
      instructions: question.instructions,
      levels: question.criteria.map((label) => ({ label })),
    };
  }
  return { type: "predicate", name, instructions: predicateInstructions(question) };
}

/** The request body: the model id, the judged text as JSON, and one entry per question. */
export function decisionsBody(
  model: ClassifierModel<string>,
  request: Omit<DecisionsRequest, "model" | "auth">,
): string {
  return JSON.stringify({
    model: model.id,
    input: JSON.stringify(request.state),
    questions: Object.entries(request.questions).map(([name, question]) => wireQuestion(name, question)),
  });
}

/** The probabilities of a choice answer, or `undefined` when one of them is malformed. */
function choiceProbabilities(value: unknown): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const probabilities: Record<string, number> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.value !== "string" || !isProbability(entry.probability)) return undefined;
    probabilities[entry.value] = entry.probability;
  }
  return probabilities;
}

/** One answer of the type its question asked for, or `undefined` when it is malformed. */
function parseAnswer(question: ClassifierQuestion, answer: Record<string, unknown>): ClassifierAnswer | undefined {
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string") return undefined;
    const probabilities = choiceProbabilities(answer.probabilities);
    if (probabilities === undefined || !isNumber(answer.confidence)) return undefined;
    return { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence };
  }
  if (question.type === "score") {
    if (answer.type !== "score" || !isNumber(answer.score) || !isNumber(answer.confidence)) return undefined;
    return { type: "score", score: answer.score, confidence: answer.confidence };
  }
  if (answer.type !== "predicate" || !isProbability(answer.probability)) return undefined;
  return { type: "bool", probability: answer.probability };
}

/**
 * Every question's answer, or `undefined` when the reply does not hold one
 * readable answer per question.
 *
 * A `refusal` answer is the question's answer: its key goes into `refused` and no
 * probability is made up for it. An answer the request did not ask for is
 * ignored, as pi-ai ignores it.
 */
export function parseDecisionsAnswers(
  value: unknown,
  questions: Record<string, ClassifierQuestion>,
): { answers: Record<string, ClassifierAnswer>; refused: string[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  const byName = new Map<string, Record<string, unknown>>();
  for (const answer of value) {
    if (isRecord(answer) && typeof answer.name === "string" && !byName.has(answer.name)) {
      byName.set(answer.name, answer);
    }
  }
  const answers: Record<string, ClassifierAnswer> = {};
  const refused: string[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = byName.get(id);
    if (answer === undefined) return undefined;
    if (answer.type === "refusal") {
      refused.push(id);
      continue;
    }
    const parsed = parseAnswer(question, answer);
    if (parsed === undefined) return undefined;
    answers[id] = parsed;
  }
  return { answers, refused };
}

/** The token counts of a reply, when it reports them. A malformed value counts as none. */
function reportedTokens(value: unknown): { input: number; output: number } | undefined {
  if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
  const count = (raw: unknown): number => (isNumber(raw) && raw > 0 ? raw : 0);
  return { input: count(value.input_tokens), output: count(value.output_tokens) };
}

/** Whether another send can answer differently. */
function isRetryableStatus(status: number): boolean {
  if (status === GATEWAY_TIMEOUT) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * The wait the service asked for, in milliseconds, or `undefined` when it named none.
 *
 * `retry-after` is a number of seconds or an HTTP date. A value that is not a
 * number and not a date is ignored.
 */
function namedRetryAfterMs(headers: Headers): number | undefined {
  const afterMs = headers.get("retry-after-ms");
  if (afterMs !== null) {
    const value = Number.parseFloat(afterMs);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const after = headers.get("retry-after");
  if (after !== null) {
    const seconds = Number.parseFloat(after);
    const value = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return undefined;
}

/** The wait before this retry when the service names none. */
function backoffMs(retry: number): number {
  return BACKOFF_MS[retry] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

/** A short code of the error body, or `undefined` when it is missing or not a plain token. */
function shortCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value) ? value : undefined;
}

/** Sleep, unless the deadline passes first. */
function pause(ms: number, signal: AbortSignal): Promise<"ok" | "timeout"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("timeout");
      return;
    }
    const done = (outcome: "ok" | "timeout"): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => done("timeout");
    const timer = setTimeout(() => done("ok"), Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ask the service the questions, and report what happened.
 *
 * Never throws and never waits past `timeoutMs`: a judge must not be able to stop
 * the work that asked for it. The judged text, the provider's message and the
 * response body stay inside this function.
 */
export async function classifyWithDecisions(request: DecisionsRequest): Promise<DecisionsOutcome> {
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const { model, auth, questions } = request;
  const body = decisionsBody(model, request);
  const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/u, "");
  const url = new URL("decisions", `${base}/`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.apiKey}`,
    "content-type": "application/json",
    ...(auth.headers ?? {}),
  };

  // Summed over every response that reported usage, so a retried call records all
  // of what it was billed for.
  const tokens = { input: 0, output: 0, reported: false };
  const usageSoFar = (): Usage | undefined => {
    if (!tokens.reported) return undefined;
    const usage: Usage = {
      input: tokens.input,
      output: tokens.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens.input + tokens.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    return usage;
  };
  const countUsage = (value: unknown): void => {
    const reported = reportedTokens(value);
    if (reported === undefined) return;
    tokens.input += reported.input;
    tokens.output += reported.output;
    tokens.reported = true;
  };

  // The last non-ok response, and whether a connection error came after it.
  let lastHttp: DecisionsHttpFailure | undefined;
  let connectionErrorLast = false;
  const timedOut = (): DecisionsTimedOut => ({
    kind: "timeout",
    usage: usageSoFar(),
    ...(lastHttp === undefined ? {} : { http: lastHttp }),
  });
  // The call gives up on its own: the outcome follows the last failure.
  const giveUp = (): DecisionsOutcome => {
    if (connectionErrorLast || lastHttp === undefined) return { kind: "failed", usage: usageSoFar() };
    if (lastHttp.status === 429) return { kind: "rate_limited", usage: usageSoFar(), http: lastHttp };
    return { kind: "failed", usage: usageSoFar(), http: lastHttp };
  };

  const controller = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve("timeout");
      },
      Math.max(0, request.timeoutMs),
    );
  });

  const run = async (): Promise<DecisionsOutcome> => {
    for (let attempt = 0; ; attempt += 1) {
      const retry = (): "retry" | "give-up" => (attempt < MAX_RETRIES ? "retry" : "give-up");
      const wait = async (named?: number): Promise<DecisionsOutcome | "again"> => {
        const delay = named ?? backoffMs(attempt);
        // Waiting longer than the call may live would be a deadline missed by way
        // of a timer, so the call ends now, with the reason of the last failure.
        if (delay >= request.timeoutMs - (Date.now() - startedAt)) return giveUp();
        return (await pause(delay, controller.signal)) === "ok" ? "again" : timedOut();
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch {
        // A connection that never answered, or our own deadline aborting it.
        if (controller.signal.aborted) return timedOut();
        connectionErrorLast = true;
        if (retry() === "give-up") return giveUp();
        const next = await wait();
        if (next !== "again") return next;
        continue;
      }

      if (!response.ok) {
        // The error body is read, its usage counted, and the text dropped: it can
        // quote the text judged.
        const body = await response.text().catch(() => "");
        let errorType: string | undefined;
        let errorCode: string | undefined;
        try {
          const payload: unknown = JSON.parse(body);
          if (isRecord(payload)) {
            countUsage(payload.usage);
            if (isRecord(payload.error)) {
              errorType = shortCode(payload.error.type);
              errorCode = shortCode(payload.error.code);
            }
          }
        } catch {
          // A body that is not JSON reports nothing to count.
        }
        const named = namedRetryAfterMs(response.headers);
        lastHttp = {
          status: response.status,
          ...(named === undefined ? {} : { retryAfterMs: named }),
          ...(errorType === undefined ? {} : { errorType }),
          ...(errorCode === undefined ? {} : { errorCode }),
        };
        connectionErrorLast = false;
        if (controller.signal.aborted) return timedOut();
        if (!isRetryableStatus(response.status) || retry() === "give-up") return giveUp();
        const next = await wait(named);
        if (next !== "again") return next;
        continue;
      }

      // Usage is read before the answers: a reply this client cannot read was
      // still billed.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) return timedOut();
        return { kind: "failed", usage: usageSoFar() };
      }
      if (!isRecord(payload)) return { kind: "failed", usage: usageSoFar() };
      countUsage(payload.usage);
      const parsed = parseDecisionsAnswers(payload.answers, questions);
      if (parsed === undefined) return { kind: "failed", usage: usageSoFar() };
      return { kind: "answered", answers: parsed.answers, refused: parsed.refused, usage: usageSoFar() };
    }
  };

  try {
    const outcome = await Promise.race([run(), deadline]);
    if (outcome === "timeout") return timedOut();
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
