import type { Context, JsonValue } from "@earendil-works/chord";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryRecord,
  type Extension,
  type Storage,
  type SubmissionRecord,
  type TaskRecord,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { SecAgent, type AgentKind, type AgentRecord } from "../documents.ts";
import { requireHarness, type ExtensionContext } from "./context.ts";
import { zoneIso } from "../time-format.ts";

/**
 * The bundled `diagnostics` extension: the `diagnose_conversation` tool.
 *
 * It answers the question a parent had to answer by hand after a provider
 * outage: "is this conversation still working, or did it stop?" The
 * facts live in three tables (`entries`, `tasks`, `submissions`) and one
 * document family (`sec.agent`), all keyed by id, and nothing joined them. This
 * tool joins them at read time.
 *
 * It is read-only. It writes no document, no entry, no task and no audit row, so
 * a diagnosis cannot change the thing it measures. The derived values are
 * computed per call and never stored, which keeps the runtime documents at
 * version 1 and a rollback cheap. See `docs/extensions.md`.
 */

/** The silence threshold when the caller names none: 30 minutes. */
const DEFAULT_STALE_MS = 1_800_000;

/** How many conversations a call without `conversationId` inspects. */
const DEFAULT_LIMIT = 20;

/** The upper bound on `limit`, so one call cannot walk the whole store. */
const MAX_LIMIT = 200;

/** Scan page size. */
const SCAN_PAGE = 50;

/** Entries read per conversation while looking for the newest progress time. */
const ENTRY_SCAN_MAX = 200;

/** Tasks read per conversation while counting the live ones. */
const TASK_SCAN_MAX = 200;

/** Conversations read while looking for the most recently active ones. */
const CONVERSATION_SCAN_MAX = 2_000;

/** A conversation id as the store brands it. Ids are numbers on the wire. */
function cid(value: string | number): ConversationId {
  return Number(value) as ConversationId;
}

type RawTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

type Stalled = "yes" | "no" | "unknown";

/** Everything one conversation's record says, as read at call time. */
export interface ConversationFacts {
  readonly conversationId: string;
  readonly agent: Readonly<AgentRecord> | undefined;
  /**
   * What kind of conversation it is, read from the record or from the creating
   * commit when the record is gone. Optional so a caller that reads only a record
   * can leave it out.
   */
  readonly kind?: AgentKind;
  /** Newest model-message timestamp in the conversation; absent without one. */
  readonly lastEntryAt: number | undefined;
  /** Newest task record of the conversation, in any state. */
  readonly lastTask: RawTask | undefined;
  /** Newest submission of the conversation, in any state. */
  readonly lastSubmission: SubmissionRecord | undefined;
  /** Count of tasks that are not terminal. */
  readonly liveTasks: number;
  /** Name of the newest tool that returned a result. */
  readonly lastTool: string | undefined;
  /** True when a read hit its cap, so a count is a lower bound. */
  readonly truncated: boolean;
}

/** One conversation's verdict, with the rule that produced it. */
export interface Judgement {
  readonly conversationId: string;
  readonly stalled: Stalled;
  readonly rule: string;
  readonly silentMs: number | undefined;
}

/** The whole answer of one call. */
export interface Diagnosis {
  readonly conversations: readonly ConversationFacts[];
  readonly judgements: readonly Judgement[];
  readonly staleMs: number;
}

function numberOrDash(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function iso(value: number | undefined, timeZone: string): string {
  return value === undefined ? "-" : zoneIso(value, timeZone);
}

/** The tool result of one entry, if it holds one. */
function toolNameOf(entry: EntryRecord): string | undefined {
  for (const message of entry.model ?? []) {
    if (message.role === "toolResult") return message.toolName;
  }
  return undefined;
}

/** Newest model-message timestamp inside one entry, if it has a model message. */
function entryTimeOf(entry: EntryRecord): number | undefined {
  let newest: number | undefined;
  for (const message of entry.model ?? []) {
    const at = message.timestamp;
    if (typeof at === "number" && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Read a conversation's newest progress time and newest tool.
 *
 * Entries are walked newest first, and only until the first one that carries a
 * time: an entry without a `model` payload (a bookkeeping entry such as
 * `pi.reset`) has no timestamp, and the ones behind it belong to older work.
 */
async function readProgress(
  storage: Storage,
  conversationId: ConversationId,
  max: number,
  ctx: Context,
): Promise<{ lastEntryAt: number | undefined; lastTool: string | undefined; truncated: boolean }> {
  let cursor: Cursor | undefined;
  let read = 0;
  let lastEntryAt: number | undefined;
  let lastTool: string | undefined;
  let truncated = false;
  for (;;) {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, SCAN_PAGE, cursor, ctx);
    for (const entry of page.items) {
      read += 1;
      if (lastEntryAt === undefined) lastEntryAt = entryTimeOf(entry);
      if (lastTool === undefined) lastTool = toolNameOf(entry);
    }
    if (page.next === undefined) break;
    if (read >= max) {
      truncated = true;
      break;
    }
    cursor = page.next;
  }
  return { lastEntryAt, lastTool, truncated };
}

/** Count the tasks that are not terminal, and return the newest task. */
async function readTasks(
  storage: Storage,
  conversationId: ConversationId,
  ctx: Context,
): Promise<{ liveTasks: number; lastTask: RawTask | undefined; truncated: boolean }> {
  let cursor: Cursor | undefined;
  let read = 0;
  let liveTasks = 0;
  let lastTask: RawTask | undefined;
  let truncated = false;
  for (;;) {
    const page = await storage.scanTasks({ conversationId, order: "descending" }, SCAN_PAGE, cursor, ctx);
    for (const task of page.items) {
      read += 1;
      if (lastTask === undefined) lastTask = task;
      if (task.state.status !== "terminal") liveTasks += 1;
    }
    if (page.next === undefined) break;
    if (read >= TASK_SCAN_MAX) {
      truncated = true;
      break;
    }
    cursor = page.next;
  }
  return { liveTasks, lastTask, truncated };
}

/** The newest submission of a conversation, if it has one. */
async function readLastSubmission(
  storage: Storage,
  conversationId: ConversationId,
  ctx: Context,
): Promise<SubmissionRecord | undefined> {
  const page = await storage.scanSubmissions({ conversationId, order: "descending" }, 1, undefined, ctx);
  return page.items[0];
}

/** Read everything one conversation's record says. */
async function factsOf(context: ExtensionContext, conversationId: string, ctx: Context): Promise<ConversationFacts> {
  const storage = context.storage;
  const harness = requireHarness(context);
  const id = cid(conversationId);
  const progress = await readProgress(storage, id, ENTRY_SCAN_MAX, ctx);
  const tasks = await readTasks(storage, id, ctx);
  const agent = await harness.snapshot(SecAgent, conversationId, ctx);
  const lastSubmission = await readLastSubmission(storage, id, ctx);
  // The kind outlives the record: a deleted focused chat has no record, and its
  // creating commit still says what it was. Nothing else here depends on it.
  const kind = agent?.kind ?? (await context.subagents?.kindOf(id, ctx));
  return {
    conversationId,
    agent,
    ...(kind === undefined ? {} : { kind }),
    lastEntryAt: progress.lastEntryAt,
    lastTask: tasks.lastTask,
    lastSubmission,
    liveTasks: tasks.liveTasks,
    lastTool: progress.lastTool,
    truncated: progress.truncated || tasks.truncated,
  };
}

/** Every conversation in the session, capped. */
async function allConversations(storage: Storage, ctx: Context): Promise<readonly ConversationRecord[]> {
  const out: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanConversations({}, SCAN_PAGE, cursor, ctx);
    out.push(...page.items);
    if (page.next === undefined || out.length >= CONVERSATION_SCAN_MAX) break;
    cursor = page.next;
  }
  return out;
}

/** The outcome of a task: its settled outcome, else the state it is in. */
function outcomeOf(task: RawTask | undefined): string | undefined {
  if (task === undefined) return undefined;
  const state = task.state;
  if (state.status === "terminal" || state.status === "completing") return state.outcome.status;
  return state.status;
}

/**
 * The verdict for one conversation.
 *
 * The rules are those of the design: a conversation is stalled when it has been
 * silent past the threshold, has no task left to run, did not finish its last
 * task, and still says it is running. A conversation that is waiting for orders,
 * or that still has a task to run, is not stalled. Everything else is unknown,
 * because the record does not say. The rule name travels with the verdict so a
 * reader can tell "not stalled" from "cannot say".
 */
export function judge(facts: ConversationFacts, staleMs: number, now: number): Judgement {
  const silentMs = facts.lastEntryAt === undefined ? undefined : Math.max(0, now - facts.lastEntryAt);
  const verdict = (stalled: Stalled, rule: string): Judgement => ({
    conversationId: facts.conversationId,
    stalled,
    rule,
    silentMs,
  });

  // A focused chat is read and written by the user, who may leave it alone for
  // days and come back to it. A quiet one is not a stuck one, so it is never
  // judged stalled, and the rule says why the answer is what it is.
  if (facts.kind === "focused") return verdict("no", "focused-chat");
  if (facts.agent === undefined) return verdict("unknown", "no-agent-record");
  if (facts.agent.status === "waiting") return verdict("no", "agent-waiting");
  if (facts.liveTasks > 0) return verdict("no", "live-tasks");
  if (facts.agent.status !== "running") return verdict("unknown", "agent-not-running");
  if (silentMs === undefined) return verdict("unknown", "no-progress-time");
  if (silentMs <= staleMs) return verdict("unknown", "silent-not-past-stale");
  const outcome = outcomeOf(facts.lastTask);
  if (outcome === undefined) return verdict("unknown", "no-task");
  if (outcome === "completed") return verdict("unknown", "last-task-completed");
  return verdict("yes", "silent-past-stale");
}

/**
 * Read the record and decide.
 *
 * `now` is a parameter so a caller can pin the clock; the tool passes
 * `Date.now()`. Nothing here writes.
 */
export async function collectDiagnosis(
  context: ExtensionContext,
  options: { conversationId?: string; staleMs?: number; limit?: number; now?: number },
  ctx: Context,
): Promise<Diagnosis> {
  const storage = context.storage;
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs !== undefined && options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  let ids: string[];
  if (options.conversationId !== undefined && options.conversationId !== "") {
    ids = [options.conversationId];
  } else {
    const known = new Map<string, ConversationRecord>();
    for (const record of await allConversations(storage, ctx)) known.set(String(record.id), record);
    // Most recently active first. A conversation with no time at all sorts last,
    // because the record cannot place it.
    const times = new Map<string, number | undefined>();
    for (const id of known.keys()) {
      times.set(id, (await readProgress(storage, cid(id), SCAN_PAGE, ctx)).lastEntryAt);
    }
    ids = [...known.keys()]
      .sort((a, b) => (times.get(b) ?? -1) - (times.get(a) ?? -1))
      .slice(0, limit);
  }

  const conversations: ConversationFacts[] = [];
  for (const id of ids) conversations.push(await factsOf(context, id, ctx));
  return { conversations, judgements: conversations.map((facts) => judge(facts, staleMs, now)), staleMs };
}

/** Render one diagnosis as the tool's text answer. */
export function renderDiagnosis(diagnosis: Diagnosis, timeZone: string): string {
  if (diagnosis.conversations.length === 0) return "no conversation to diagnose";
  const quoted = (value: string | undefined): string => (value ?? "-").replace(/"/g, "'").replace(/\s+/g, " ").slice(0, 200);
  const lines: string[] = [];
  for (const [index, facts] of diagnosis.conversations.entries()) {
    const fields = [
      'kind="conversation"',
      `conversation="${facts.conversationId}"`,
      `agent="${quoted(facts.agent?.status)}"`,
      `agentKind="${quoted(facts.agent?.kind)}"`,
      `parent="${quoted(facts.agent?.parentConversationId)}"`,
      `job="${quoted(facts.agent?.jobId)}"`,
      `lastEntryAt="${iso(facts.lastEntryAt, timeZone)}"`,
      `silentMs="${numberOrDash(diagnosis.judgements[index]?.silentMs)}"`,
      `liveTasks="${facts.liveTasks}"`,
      `lastTask="${facts.lastTask === undefined ? "-" : String(facts.lastTask.id)}"`,
      `lastOutcome="${quoted(outcomeOf(facts.lastTask))}"`,
      `lastSubmission="${quoted(facts.lastSubmission?.status)}"`,
      `lastSubmissionReason="${quoted(facts.lastSubmission?.reason)}"`,
      `lastTool="${quoted(facts.lastTool)}"`,
    ];
    if (facts.truncated) fields.push('truncated="yes"');
    lines.push(`<item ${fields.join(" ")} />`);
  }
  for (const judgement of diagnosis.judgements) {
    lines.push(
      `<judgement conversation="${judgement.conversationId}" stalled="${judgement.stalled}" rule="${judgement.rule}" silentMs="${numberOrDash(judgement.silentMs)}" />`,
    );
  }
  return lines.join("\n");
}

const DESCRIPTION = `Read one conversation's record and decide whether it is stalled.

It reports the last progress time, the silence since then, the count of tasks that are not terminal, the last task and what it ended as, the last submission and its reason, and the last tool that returned a result. Then it prints one judgement line per conversation: stalled="yes", "no" or "unknown", the rule that decided it, and silentMs.

A conversation is stalled when it has been silent longer than staleMs, has no task left to run, did not end its last task as completed, and still reports that it is running. A conversation that is waiting for orders, or that still has a task to run, is not stalled. Anything else is unknown. The rule name says which reading was used.

This tool writes nothing: no document, no entry, no task. Give conversationId to diagnose one conversation. Leave it out to walk the conversations with the most recent progress, up to limit. staleMs is the silence threshold in milliseconds and defaults to ${DEFAULT_STALE_MS} (30 minutes); limit defaults to ${DEFAULT_LIMIT}.`;

/** The bundled diagnostics tool. */
export function createDiagnosticsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const tool = defineTool({
    name: "diagnose_conversation",
    description: DESCRIPTION,
    parameters: obj(
      {
        conversationId: opt(
          str({ description: "The conversation to diagnose. Omit to walk the most recently active ones." }),
        ),
        staleMs: opt(
          num({ description: `Silence threshold in milliseconds. Default ${DEFAULT_STALE_MS}.` }),
        ),
        limit: opt(
          num({ description: `How many conversations to walk without conversationId. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.` }),
        ),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const diagnosis = await collectDiagnosis(
        context,
        {
          ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
          ...(args.staleMs !== undefined ? { staleMs: args.staleMs } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        ctx,
      );
      return { output: [{ type: "text" as const, text: renderDiagnosis(diagnosis, context.getConfig().timezone) }] };
    },
  });

  return defineExtension({ name: "diagnostics", tools: [tool] });
}
