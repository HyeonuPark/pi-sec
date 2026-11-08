/**
 * The one HTTP request function every page uses.
 *
 * Three rules live here, so no page has to remember them:
 *
 * 1. A path is a route under the mount, never a bare URL. `at()` puts the mount
 *    on it, which is what makes a page work behind a path-prefix proxy.
 * 2. A JSON answer is read here. An empty body is `undefined`, which is what a
 *    202 or a 204 answers with.
 * 3. A refusal is thrown as an {@link ApiError}, which carries the status and
 *    the server's `code` beside the message, and the body it was written in. A
 *    control that has to say why the server refused a press cannot read that out
 *    of a sentence, and an answer such as a stale approval names the revision
 *    that can be approved beside the envelope rather than inside it.
 *
 * `fetch` is called only from this folder; the source-rule test in
 * `test/ui/state-and-sources.test.ts` holds page code to that.
 */
import type { ApiErrorBody, ApiErrorDetail } from "../../shared/wire/errors.ts";
import { at } from "../mount.ts";

/** What a caller may pass beside the path. A JSON request needs no more. */
export interface RequestOptions {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** A refusal from the server, or an answer this function could not read. */
export class ApiError extends Error {
  /** The HTTP status, such as 409. */
  readonly status: number;
  /** The server's stable code, such as `agents_working`, or `http_<status>`. */
  readonly code: string;
  /** The id the server logged for this request, when it sent one. */
  readonly requestId: string | undefined;
  /** A refusal's extra facts, when the code alone does not say enough. */
  readonly details: unknown;
  /**
   * The refusal as the server wrote it: the `error` envelope and whatever the
   * route put beside it, such as the `latest` and `approval` a refused approval
   * answers with. `undefined` when the answer was not the shape this app writes.
   */
  readonly body: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: { readonly requestId?: string; readonly details?: unknown; readonly body?: unknown },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = detail?.requestId;
    this.details = detail?.details;
    this.body = detail?.body;
  }
}

/**
 * The body an error answer carries — the envelope and the facts beside it — when
 * it is the shape this app writes.
 */
function readErrorBody(text: string): ApiErrorBody | undefined {
  if (text === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const detail = (value as { error?: unknown }).error;
  if (typeof detail !== "object" || detail === null) return undefined;
  const candidate = detail as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return undefined;
  return value as ApiErrorBody;
}

/** A refusal body that is a JSON object but not the error envelope, or `undefined`. */
function readJsonObject(text: string): ApiErrorBody | undefined {
  if (text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ApiErrorBody) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One request to the server under the mount.
 *
 * `T` is what the route answers with. A caller that reads a route's answer as a
 * shape knows the shape from `src/shared/wire/` or from its own page file.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(at(path), {
    method: options.method ?? "GET",
    body: options.body,
    headers,
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    // An answer without the envelope (the configuration reload answers
    // `{ status, issues }`) still keeps its JSON, so a caller can read it.
    const body = readErrorBody(text) ?? readJsonObject(text);
    const detail: ApiErrorDetail | undefined = body?.error;
    throw new ApiError(
      response.status,
      detail?.code ?? `http_${response.status}`,
      detail?.message ?? `the server answered ${response.status}`,
      { requestId: detail?.requestId, details: detail?.details, body },
    );
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
