import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  UsageDoc,
  type AgentState,
  type CompactionReason,
  type CompactionStatus,
  type ConversationView,
  type EntryRecord,
  type InboxItem,
  type InboxState,
  type JsonObject,
  type LiveState,
  type SubmissionId,
  type TaskId,
  type ToolSlot,
  type UsageState,
} from "@earendil-works/pi-durable";

/**
 * The frames of the conversation streams, built from conversation views.
 *
 * pi-durable 1.5.0 removed `watchEvents()`. A client now reads `Conversation.watch()`,
 * which delivers the next revision of a view: a window over the transcript and the
 * built-in documents (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`). The page under
 * `src/ui` still reads frames by name (`snapshot`, `message_end`, `tool_execution_update`
 * and so on), and its payloads are a contract of `docs/http-api.md`. This module
 * turns two revisions of a view into those frames, so the page and the document
 * stay as they were.
 *
 * What a frame is built from:
 *
 * - `snapshot`: the active context's entries, the `pi.live` run, generation, tools and
 *   compactions, `pi.inbox`, `pi.agent` and `pi.usage` (`snapshotOf`).
 * - `entry_appended`, `message_start`, `message_end`: entries that the new revision holds
 *   and the old one did not. Entry ids only grow, so an entry is new when its id is above
 *   the newest one already sent.
 * - `tool_execution_*`: the slots of `pi.live.tools`.
 * - `run_start`, `run_end`: `pi.live.run` appearing, changing its first input, and going.
 * - `compaction_start`, `compaction_end`: `pi.live.compactions`.
 * - `auto_retry_*`, `deferred_poll`, `inbox_update`, `agent_changed`, `usage_changed`: the
 *   matching fields of `pi.live`, `pi.inbox`, `pi.agent` and `pi.usage`.
 *
 * Some frames of `watchEvents()` are not built: `message_update` (the page never read it
 * and the streamed text is in the snapshot's `generation.message`), and `turn_start`,
 * `turn_end`, `submission` and `task_failed`, which need task records that a view does not
 * carry. The page reads none of them. `tool_execution_start` carries empty `args`, because
 * a model-issued call's arguments are in its assistant entry and not in the view.
 *
 * A revision can fold several commits, so one frame can stand for more than one change,
 * and a change that began and ended inside one revision gives only its end frames.
 */

type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

export type SnapshotEvent = {
  type: "snapshot";
  entries: readonly EntryRecord[];
  run?: { inputs: readonly SubmissionId[] };
  generation?: NonNullable<LiveState["generation"]>;
  tools: readonly ToolSlot[];
  compactions: readonly CompactionStatus[];
  inbox: readonly QueuedItem[];
  agent: AgentState;
  usage: UsageState;
};

export type ToolOutputChange = { trimStart?: number; append?: string } | { set: string };

export type AgentEvent =
  | SnapshotEvent
  | { type: "run_start"; inputs: readonly SubmissionId[] }
  | { type: "run_end"; inputs: readonly SubmissionId[] }
  | { type: "message_start"; message: Message }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: ToolOutputChange;
      details?: JsonValue;
      diagnostics?: ToolSlot["diagnostics"];
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "inbox_update"; items: readonly QueuedItem[] }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "agent_changed"; agent: AgentState }
  | { type: "usage_changed"; usage: UsageState }
  | { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
  | { type: "compaction_end"; taskId: TaskId; reason: CompactionReason };

type Docs = {
  readonly live: LiveState;
  readonly inbox: InboxState | undefined;
  readonly agent: AgentState | undefined;
  readonly usage: UsageState | undefined;
};

function docsOf(view: ConversationView): Docs {
  const docs = view.docs as Readonly<Record<string, unknown>>;
  return {
    live: (docs["pi.live"] ?? {}) as LiveState,
    inbox: docs["pi.inbox"] as InboxState | undefined,
    agent: docs["pi.agent"] as AgentState | undefined,
    usage: docs["pi.usage"] as UsageState | undefined,
  };
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
  return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}

/**
 * The snapshot frame: `entries` is the active context (`Conversation.context()`), and
 * everything else is read from the documents of `view`.
 */
export function snapshotOf(view: ConversationView, entries: readonly EntryRecord[]): SnapshotEvent {
  const { live, inbox, agent, usage } = docsOf(view);
  return {
    type: "snapshot",
    entries,
    ...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
    ...(live.generation === undefined ? {} : { generation: live.generation as NonNullable<SnapshotEvent["generation"]> }),
    tools: live.tools ?? [],
    compactions: live.compactions ?? [],
    inbox: queued(inbox),
    agent: agent ?? (AgentDoc.definition.initial() as AgentState),
    usage: usage ?? (UsageDoc.definition.initial() as UsageState),
  };
}

/** The newest entry id among `entries`, or `floor` when none is higher. */
export function newestEntryId(entries: readonly EntryRecord[], floor = 0): number {
  let newest = floor;
  for (const entry of entries) if (entry.id > newest) newest = entry.id;
  return newest;
}

/** The result entry of tool call `callId` among `entries`. */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
  return entries.find((entry) => {
    const message = entry.model?.[0] as { role?: string; toolCallId?: string } | undefined;
    return message?.role === "toolResult" && message.toolCallId === callId;
  });
}

/** How running output changed: an append when the new text extends the old, else the whole text. */
function outputChange(before: string | undefined, after: string | undefined): ToolOutputChange | undefined {
  if (before === after) return undefined;
  const previous = before ?? "";
  const next = after ?? "";
  if (previous !== "" && next.startsWith(previous)) return { append: next.slice(previous.length) };
  return { set: next };
}

export type Translation = {
  readonly events: AgentEvent[];
  /** The newest entry id that the events and everything before them carried. */
  readonly newest: number;
};

/**
 * The frames that the change from `before` to `after` causes, in the order the page
 * has always received them: tool progress, retry state, tool ends and entries,
 * compaction ends, the run's end, document changes, then what began.
 *
 * `sent` is the newest entry id already delivered (in a snapshot or an earlier call).
 */
export function translateView(before: ConversationView, after: ConversationView, sent: number): Translation {
  const was = docsOf(before);
  const now = docsOf(after);
  const events: AgentEvent[] = [];

  const added = after.entries.filter((entry) => entry.id > sent);
  const newest = newestEntryId(added, sent);

  const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.live.tools ?? [];

  for (const slot of slots) {
    if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
    events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args: {} });
  }

  const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
  const partial = now.live.generation?.message as AssistantMessage | undefined;
  if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });

  for (const slot of slots) {
    const previous = slotsBefore.get(slot.callId);
    if (slot.status !== "running" || previous?.status !== "running") continue;
    const output = outputChange(previous.output, slot.output);
    const update = {
      ...(output === undefined ? {} : { output }),
      ...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
      ...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
    };
    if (Object.keys(update).length === 0) continue;
    events.push({ type: "tool_execution_update", toolCallId: slot.callId, toolName: slot.name, ...update });
  }

  const generation = now.live.generation;
  const generationBefore = was.live.generation;
  if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
    const { at, error } = generation.retry;
    events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
  }
  if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
    events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
  }
  if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
    events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
  }

  // A tool ends when its slot becomes done, appears done, or vanishes unfinished.
  const entryById = (id: number | undefined): EntryRecord | undefined =>
    id === undefined ? undefined : after.entries.find((candidate) => candidate.id === id);
  const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
  const endTool = (callId: string, name: string, entry: EntryRecord | undefined): void => {
    toolEnds.push({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: name,
      ...(entry === undefined ? {} : { entry }),
    });
  };
  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot?.status === "done") endTool(previous.callId, previous.name, entryById(slot.entry));
    else if (slot === undefined) endTool(previous.callId, previous.name, resultOf(added, previous.callId));
  }
  for (const slot of slots) {
    if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot.callId, slot.name, entryById(slot.entry));
  }

  // Entries in append order; a tool's end directly precedes its result's message.
  const addedIds = new Set(added.map((entry) => entry.id));
  let assistantAppended = false;
  for (const entry of added) {
    events.push(...toolEnds.filter((end) => end.entry?.id === entry.id));
    const message = entry.model?.[0];
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    // A streamed answer already started with its first partial.
    const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) events.push({ type: "message_start", message });
    events.push({ type: "message_end", entry });
  }
  // Ends whose result entry was sent earlier, or that have none: a faulted tool, or one whose run ended.
  events.push(...toolEnds.filter((end) => end.entry === undefined || !addedIds.has(end.entry.id)));

  const compactionsBefore = was.live.compactions ?? [];
  const compactions = now.live.compactions ?? [];
  for (const { taskId, trigger } of compactionsBefore) {
    if (!compactions.some((status) => status.taskId === taskId)) {
      events.push({ type: "compaction_end", taskId, reason: trigger });
    }
  }

  const run = now.live.run;
  const runBefore = was.live.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
  if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

  if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
  if (now.agent !== was.agent) {
    events.push({ type: "agent_changed", agent: now.agent ?? (AgentDoc.definition.initial() as AgentState) });
  }
  if (now.usage !== was.usage) {
    events.push({ type: "usage_changed", usage: now.usage ?? (UsageDoc.definition.initial() as UsageState) });
  }

  for (const { taskId, trigger, blocking } of compactions) {
    if (!compactionsBefore.some((status) => status.taskId === taskId)) {
      events.push({ type: "compaction_start", taskId, reason: trigger, blocking });
    }
  }
  if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });

  return { events, newest };
}
