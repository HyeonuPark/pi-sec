import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Config } from "../../src/config/schema.ts";
import type { ExtensionContext } from "../../src/extensions/context.ts";
import { createLinearExtension } from "../../src/extensions/linear/index.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

export const FAKE_KEY = "lin_api_FAKEKEY0123456789";
export const NOW = Date.parse("2026-11-06T00:00:00Z");
export const CTX = BACKGROUND_CONTEXT;

/** One request the fake fetch saw. The key is read from the header and never kept in `headers`. */
export interface Seen {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly query: string;
  readonly variables: Record<string, any>;
  readonly operation: string;
}

export type Answer = Response | (() => Response);

/** A JSON answer the way Linear sends one. */
export function reply(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A fake fetch that records every call and answers by operation name, in order per name. */
export class FakeLinear {
  readonly seen: Seen[] = [];
  private readonly answers = new Map<string, Answer[]>();
  readonly fetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, any> };
    const operation = /(?:query|mutation|subscription)\s+(\w+)/.exec(body.query)?.[1] ?? "(anonymous)";
    const headers = new Headers(init?.headers);
    this.seen.push({
      url: String(input),
      method: String(init?.method),
      authorization: headers.get("authorization") ?? "",
      query: body.query,
      variables: body.variables ?? {},
      operation,
    });
    const queue = this.answers.get(operation);
    const next = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
    if (next === undefined) throw new Error(`the fake has no answer for operation ${operation}`);
    return typeof next === "function" ? next() : next.clone();
  };

  /** Answer every call of one operation with `answer`, or one answer per call when several are given. */
  on(operation: string, ...answers: Answer[]): this {
    this.answers.set(operation, answers);
    return this;
  }

  get operations(): string[] {
    return this.seen.map((call) => call.operation);
  }
}

export interface Rig {
  readonly harness: TestHarness;
  readonly linear: FakeLinear;
  readonly rows: Record<string, unknown>[];
  readonly sleeps: number[];
  readonly config: { current: Config };
  readonly extension: Extension<ToolRegistration>;
  tool(name: string): ToolRegistration;
  call(name: string, args: Record<string, unknown>, conversationId?: string): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** The text of one tool result. */
export function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
  return (result.output ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

export interface RigOptions {
  readonly writes?: boolean;
  readonly keyFile?: string | undefined | "missing";
  readonly extraConfig?: Partial<Config>;
  /** Wrap the real report store, to test a store that answers differently. */
  readonly wrapReports?: (real: ExtensionContext["reports"]) => ExtensionContext["reports"];
}

/** The extension over a real harness (real report store and jobs) and a fake network. */
export async function createRig(options: RigOptions = {}): Promise<Rig> {
  const harness = await createTestHarness();
  const linear = new FakeLinear();
  const rows: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const config = {
    current: {
      ...harness.config,
      timezone: "Asia/Tokyo",
      linear: { apiKeySecret: "linear.api-key", writes: options.writes ?? true },
      ...(options.extraConfig ?? {}),
    } as Config,
  };
  const context = {
    getConfig: () => config.current,
    paths: harness.paths,
    audit: { append: (row: Record<string, unknown>) => rows.push(row), hashArguments: () => "" },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    reports: options.wrapReports === undefined ? harness.runtime.reports : options.wrapReports(harness.runtime.reports),
  } as unknown as ExtensionContext;
  const extension = createLinearExtension(context, {
    fetch: linear.fetch,
    readKey: async () => (options.keyFile === "missing" ? undefined : `${options.keyFile ?? FAKE_KEY}\n`),
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    newId: () => "00000000-0000-4000-8000-000000000001",
  });
  const tool = (name: string): ToolRegistration => {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`the extension registers no tool ${name}`);
    return found;
  };
  return {
    harness,
    linear,
    rows,
    sleeps,
    config,
    extension,
    tool,
    async call(name, args, conversationId = "7") {
      const api = { conversationId, callId: "call-1" } as unknown as ToolExecutionApi;
      const result = await (tool(name).execute as (a: unknown, b: unknown, c: unknown) => Promise<{ isError?: boolean; output?: { type: string; text?: string }[] }>)(
        args,
        api,
        CTX,
      );
      return { text: textOf(result), isError: result.isError === true };
    },
    close: () => harness.close(),
  };
}

/** A job and a report on it, approved at its first revision. Returns the ids. */
export async function approvedReport(
  rig: Rig,
  content: string,
  options: { approve?: boolean; kind?: "plan" | "result" | "briefing" } = {},
): Promise<{ reportId: string; jobId: string }> {
  const { jobs, reports } = rig.harness.runtime;
  const job = await jobs.create(CTX, { title: "linear work" });
  const report = await reports.create(CTX, {
    jobId: job.id,
    title: "Linear write",
    content,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  });
  if (options.approve !== false && options.kind !== "briefing") {
    const outcome = await reports.approve(CTX, report.id, 1, { via: "panel" });
    if (!outcome.ok) throw new Error(`approval refused: ${outcome.reason}`);
  }
  return { reportId: report.id, jobId: job.id };
}

/** A canned issue as the write-side read returns it. */
export function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "issue-uuid-1",
    identifier: "ENG-123",
    title: "Old title",
    url: "https://linear.app/acme/issue/ENG-123/old-title",
    team: { id: "team-uuid-1", key: "ENG" },
    state: { id: "state-1", name: "Todo" },
    assignee: null,
    priority: 3,
    priorityLabel: "Medium",
    project: null,
    dueDate: null,
    estimate: null,
    labels: { nodes: [] },
    ...overrides,
  };
}
