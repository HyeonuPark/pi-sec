import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkDocument, type AllowedOperation } from "./document.ts";
import { zoneMinute } from "../../time-format.ts";

/** The one endpoint. No tool takes a URL or a header. */
export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

const TIMEOUT_MS = 20_000;
const RETRY_AFTER_LIMIT_S = 20;
const LOW_REQUESTS = 100;
const LOW_COMPLEXITY = 100_000;
const KEY_PLACEHOLDER = "[linear key]";
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The parts of the outside world that a test replaces. Every field is optional. */
export interface LinearDeps {
  readonly fetch?: typeof fetch;
  /** Read the secret file at this path. Returns undefined when it does not exist. */
  readonly readKey?: (path: string) => Promise<string | undefined>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
}

/** A failure the tool reports as its answer. The text never holds the key, a header or a request body. */
export class LinearError extends Error {
  /** True when a write may or may not have reached Linear. */
  readonly unsure: boolean;
  constructor(message: string, unsure = false) {
    super(message);
    this.unsure = unsure;
  }
}

export interface RateInfo {
  readonly requestsRemaining?: number;
  readonly complexityRemaining?: number;
  readonly resetAtMs?: number;
}

export interface GraphqlError {
  readonly message: string;
  readonly type?: string;
  readonly code?: string;
  readonly path?: string;
}

export interface LinearResult {
  // The data is whatever the query selected; the tools read it by the shape they asked for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
  readonly errors: readonly GraphqlError[];
}

export interface RequestOptions {
  /** True for a mutation: the request is never repeated, and a network failure says so. */
  readonly write?: boolean;
}

const AUTH_TEXT =
  "Linear refused the key. It may be revoked, mistyped, or expired. Ask the user to check Settings > Account > Security & Access.";
const FORBIDDEN_TEXT =
  "Linear denied access. The key may lack the permission or the team for this call, or the workspace may block this network.";
const WRITE_UNSURE = " The write may or may not have happened. Read the issue before you try again.";

/** The text for a refusal of a document before any request. */
export function refusedText(tool: string, kind: string): string {
  return `Refused: ${tool} sends only one read query. This document holds ${kind}. Nothing was sent to Linear.`;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function errorList(body: unknown): GraphqlError[] {
  if (body === null || typeof body !== "object") return [];
  const raw = (body as { errors?: unknown }).errors;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): GraphqlError => {
    const item = (entry ?? {}) as {
      message?: unknown;
      path?: unknown;
      extensions?: { type?: unknown; code?: unknown; userPresentableMessage?: unknown };
    };
    const present = item.extensions?.userPresentableMessage;
    const message =
      typeof present === "string" && present !== "" ? present : typeof item.message === "string" ? item.message : "unknown error";
    return {
      message,
      ...(typeof item.extensions?.type === "string" ? { type: item.extensions.type } : {}),
      ...(typeof item.extensions?.code === "string" ? { code: item.extensions.code } : {}),
      ...(Array.isArray(item.path) ? { path: item.path.join(".") } : {}),
    };
  });
}

/** One error as a line: its type, its message and its path. */
export function describeError(error: GraphqlError): string {
  const type = error.type !== undefined ? `${error.type}: ` : "";
  const path = error.path !== undefined ? ` (at ${error.path})` : "";
  return `${type}${error.message}${path}`;
}

/** The client of one tool call: it holds the key for the length of that call and no longer. */
export class LinearClient {
  private readonly key: string;
  private readonly deps: Required<Pick<LinearDeps, "fetch" | "now" | "sleep">>;
  private readonly zone: string;
  private rate: RateInfo = {};

  constructor(key: string, deps: Required<Pick<LinearDeps, "fetch" | "now" | "sleep">>, zone: string) {
    this.key = key;
    this.deps = deps;
    this.zone = zone;
  }

  /** Replace every copy of the key in a text. */
  scrub(text: string): string {
    return this.key === "" ? text : text.split(this.key).join(KEY_PLACEHOLDER);
  }

  /** One line when the hourly budget is low, else an empty string. */
  budgetLine(): string {
    const { requestsRemaining, complexityRemaining, resetAtMs } = this.rate;
    const lowRequests = requestsRemaining !== undefined && requestsRemaining < LOW_REQUESTS;
    const lowComplexity = complexityRemaining !== undefined && complexityRemaining < LOW_COMPLEXITY;
    if (!lowRequests && !lowComplexity) return "";
    const reset = resetAtMs !== undefined ? ` The budget resets at ${zoneMinute(resetAtMs, this.zone)}.` : "";
    return `Linear budget is low: ${String(requestsRemaining ?? "unknown")} requests and ${String(complexityRemaining ?? "unknown")} complexity points are left this hour.${reset}`;
  }

  get lastRate(): RateInfo {
    return this.rate;
  }

  /**
   * Send one document. The operation check runs first, and a refusal sends
   * nothing. Authentication, permission, rate limit and network failures throw
   * a {@link LinearError}; a GraphQL error comes back in `errors` with the data.
   */
  async request(
    tool: string,
    document: string,
    variables: Record<string, unknown>,
    allowed: AllowedOperation,
    options: RequestOptions = {},
  ): Promise<LinearResult> {
    const checked = checkDocument(document, allowed);
    if (!checked.ok) throw new LinearError(refusedText(tool, checked.kind));
    const write = options.write === true;
    let retried = false;
    for (;;) {
      const outcome = await this.send(document, variables, write);
      if (outcome.kind === "result") return outcome.result;
      if (write || retried || outcome.retryAfter > RETRY_AFTER_LIMIT_S) {
        throw new LinearError(`Linear rate limit; retry after ${String(outcome.retryAfter)} s.`);
      }
      retried = true;
      await this.deps.sleep(outcome.retryAfter * 1000);
    }
  }

  private async send(
    document: string,
    variables: Record<string, unknown>,
    write: boolean,
  ): Promise<{ kind: "result"; result: LinearResult } | { kind: "limited"; retryAfter: number }> {
    let response: Response;
    try {
      response = await this.deps.fetch(LINEAR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.key },
        body: JSON.stringify({ query: document, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const code = (error as { code?: unknown } | undefined)?.code;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const text = timedOut
        ? "Linear did not answer within 20 s."
        : `Linear could not be reached (${typeof code === "string" ? code : name || "network error"}).`;
      throw new LinearError(write ? text + WRITE_UNSURE : text, write);
    }

    const headers = response.headers;
    const requestsRemaining = headerNumber(headers, "x-ratelimit-requests-remaining");
    const complexityRemaining = headerNumber(headers, "x-ratelimit-complexity-remaining");
    const resetAtMs = headerNumber(headers, "x-ratelimit-requests-reset");
    this.rate = {
      ...(requestsRemaining === undefined ? {} : { requestsRemaining }),
      ...(complexityRemaining === undefined ? {} : { complexityRemaining }),
      ...(resetAtMs === undefined ? {} : { resetAtMs }),
    };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const errors = errorList(body);
    const retryHeader = headerNumber(headers, "retry-after");
    const limited =
      response.status === 429 ||
      errors.some((e) => e.code === "RATELIMITED" || e.type === "ratelimited");
    if (limited) return { kind: "limited", retryAfter: Math.ceil(retryHeader ?? 60) };
    if (response.status === 401 || errors.some((e) => e.type === "authentication error")) throw new LinearError(AUTH_TEXT);
    if (response.status === 403 || errors.some((e) => e.type === "forbidden")) throw new LinearError(FORBIDDEN_TEXT);

    const data = body !== null && typeof body === "object" ? ((body as { data?: unknown }).data ?? null) : null;
    if (data === null && (errors.length === 0 || (write && response.status >= 500))) {
      const text = `Linear answered HTTP ${String(response.status)} with no data.`;
      // For a write, an answer without data does not show whether Linear ran it:
      // a gateway can answer 5xx after Linear committed. So it is unsure, like a timeout.
      throw new LinearError(write ? text + WRITE_UNSURE : text, write);
    }
    return { kind: "result", result: { data, errors } };
  }
}

/** Throw the errors as one text when the answer holds no data. */
export function requireData(result: LinearResult): LinearResult {
  if (result.data === null) {
    throw new LinearError(`Linear returned an error: ${result.errors.map(describeError).join("; ")}`);
  }
  return result;
}

/** True when the answer says an entity was not found. */
export function isNotFound(result: LinearResult, field: string): boolean {
  if (result.errors.some((e) => /not found|does not exist/i.test(e.message))) return true;
  return result.data !== null && result.data[field] === null;
}

/** Lines that follow the data when the answer also carried errors. */
export function errorLines(result: LinearResult): string[] {
  if (result.errors.length === 0) return [];
  return ["Linear also returned errors:", ...result.errors.map((e) => `  ${describeError(e)}`)];
}

/** Build the dependencies a client needs, with the real thing for each absent field. */
export function resolveDeps(deps: LinearDeps): Required<Pick<LinearDeps, "fetch" | "now" | "sleep" | "newId">> {
  return {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    newId: deps.newId ?? (() => crypto.randomUUID()),
  };
}

/** Read the key from `<secretsDir>/<name>`, or explain why not. The value is not logged anywhere. */
export async function loadKey(
  secretsDir: string,
  name: string,
  readKey: LinearDeps["readKey"],
): Promise<string> {
  const missing = new LinearError(
    `No Linear key: the secret ${name} does not exist. Ask the user to store it with the web UI secret upload.`,
  );
  if (!SECRET_NAME.test(name)) throw missing;
  const path = join(secretsDir, name);
  let raw: string | undefined;
  try {
    raw = readKey !== undefined ? await readKey(path) : await readFile(path, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw === undefined) throw missing;
  const key = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (key === "") throw missing;
  return key;
}
