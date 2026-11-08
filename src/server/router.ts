import type { IncomingMessage, ServerResponse } from "node:http";
import { sendBody } from "./compress.ts";

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly body: unknown;
}

export type RouteHandler = (context: RouteContext) => Promise<void> | void;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** A tiny path router: `:name` captures one segment; `*` captures the rest. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.add("PATCH", path, handler);
  }

  /** Match a path; returns the handler and captured params, or undefined. */
  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | undefined {
    const parts = splitPath(path);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) {
        if (route.segments.length === parts.length) methodMismatch = true;
        continue;
      }
      const params = matchSegments(route.segments, parts);
      if (params !== undefined) return { handler: route.handler, params };
    }
    if (methodMismatch) return undefined;
    return undefined;
  }
}

function matchSegments(pattern: readonly string[], parts: readonly string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  let index = 0;
  while (index < pattern.length) {
    const segment = pattern[index]!;
    if (segment === "*") {
      params["*"] = parts.slice(index).join("/");
      return params;
    }
    const value = parts[index];
    if (value === undefined) return undefined;
    if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return undefined;
    index += 1;
  }
  return index === parts.length ? params : undefined;
}

/**
 * One JSON answer.
 *
 * The body goes through `sendBody`, so a caller that asked for gzip and a body of
 * at least a kilobyte gets it compressed. A smaller answer is sent as it is.
 */
export function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  sendBody(res, {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers,
  });
}

export function apiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  json(res, status, { error: { code, message, requestId } });
}

/** Parse an int query parameter with a fallback. */
export function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
