import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentEvent, SnapshotEvent } from "./conversation-events.ts";

/**
 * Entry slimming for the conversation streams (`/basic-chat/events` and
 * `/api/conversations/:id/events`).
 *
 * The chat page is the only reader of these streams, and it draws far less than
 * an entry holds. A system prompt entry's `model[0]` carries the whole prompt
 * (`sections` and `toolsAdded`, over a hundred kilobytes in a long conversation); an
 * assistant turn carries its thinking text and signature and the arguments of
 * every tool call; a tool result carries `details`, where an edit holds the same
 * change twice (`diff` and `patch`). Measured on real transcripts these fields
 * the page never draws were more than half of it.
 *
 * So the frames the page receives carry what it draws. The stored transcript is
 * untouched, and `GET /api/conversations/:id` still answers with the full
 * entries: this module builds copies and never mutates the objects it is given.
 *
 * Five frames carry an entry or a message: `snapshot`, `entry_appended`,
 * `message_end`, `message_start` and `tool_execution_end`. The first three carry
 * entries and go through `slimEntry`. `message_start` carries its `message`
 * through `slimMessage`, which is where a system prompt message loses `sections`
 * and `toolsAdded`. `tool_execution_end` carries its `entry` through
 * `slimEntry`. A `tool_execution_update` carries no entry, only its partial
 * result, so it loses that result's `details`. The page reads none of these
 * bodies: it parses only `toolCallId` and `output` on an update, and nothing at
 * all on a start or an end.
 *
 * The `pi.system` entry keeps its place with an empty `model`. The page skips it
 * by kind, but the entry itself is what orders ids, so dropping it would shift
 * everything the page keys on. Tool-result text is kept whole, because the page
 * shows it inside a fold. An unknown message or block shape passes through as it
 * is: a shape this module cannot judge is not one it trims.
 */

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One content block, slimmed; `undefined` means the block is dropped. */
function slimBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  const type = block["type"];
  // A redacted thinking block is the same type with `redacted: true` and the
  // opaque payload in `thinkingSignature`, so this drops both.
  if (type === "thinking") return undefined;
  if (type === "toolCall") {
    // The page draws a call by name. Its arguments are the input of a tool that
    // has already run, and nothing on the page reads them again.
    return { type: block["type"], id: block["id"], name: block["name"] };
  }
  return block;
}

/** The message with the fields the page never draws taken out, or the same object. */
function slimMessage(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const role = message["role"];
  if (role === "assistant") {
    let changed = false;
    const content = message["content"];
    let slimContent: unknown = content;
    if (Array.isArray(content)) {
      const blocks = content.map(slimBlock).filter((block) => block !== undefined);
      if (blocks.length !== content.length) changed = true;
      slimContent = blocks;
    }
    if (message["usage"] !== undefined) changed = true;
    // A frame with nothing to trim returns the entry it was given, so the resume
    // buffer does not keep a copy per frame that needed none.
    if (!changed) return message;
    const copy: AnyRecord = { ...message, content: slimContent };
    delete copy["usage"];
    return copy;
  }
  if (role === "toolResult") {
    // `details` holds the same edit twice, as `diff` and `patch`.
    if (message["details"] === undefined) return message;
    const copy: AnyRecord = { ...message };
    delete copy["details"];
    return copy;
  }
  if (role === "system") {
    // A system prompt message is what a `pi.system` entry holds, and it arrives
    // on the stream a second time as the `message` of `message_start`. Its
    // `content` is what a reader shows; `sections` and `toolsAdded` are the same
    // prompt again, in the shape the agent builds requests from.
    if (message["sections"] === undefined && message["toolsAdded"] === undefined) return message;
    const copy: AnyRecord = { ...message };
    delete copy["sections"];
    delete copy["toolsAdded"];
    return copy;
  }
  return message;
}

/** One entry with the fields the page never draws taken out. */
export function slimEntry(entry: EntryRecord): EntryRecord {
  if (entry.kind === "pi.system") {
    const model = entry.model;
    if (model === undefined || model.length === 0) return entry;
    return { ...entry, model: [] };
  }
  const model = entry.model;
  if (model === undefined || model.length === 0) return entry;
  let changed = false;
  const slimmed = model.map((message) => {
    const slim = slimMessage(message);
    if (slim !== message) changed = true;
    return slim;
  });
  if (!changed) return entry;
  return { ...entry, model: slimmed as EntryRecord["model"] };
}

/** The entries of one frame, slimmed. */
export function slimEntries(entries: readonly EntryRecord[]): EntryRecord[] {
  return entries.map(slimEntry);
}

/** A snapshot with its entries slimmed; `tools`, `compactions`, `usage` and the rest are kept. */
export function slimSnapshot(snapshot: SnapshotEvent): SnapshotEvent {
  return { ...snapshot, entries: slimEntries(snapshot.entries) };
}

/**
 * One agent event, with the body of every frame that carries an entry or a
 * message slimmed.
 *
 * `snapshot` carries every visible entry, `entry_appended` and `message_end` each
 * carry one, `message_start` carries a message, `tool_execution_end` carries the
 * entry a tool produced, and `tool_execution_update` carries its partial result.
 * Every other frame is returned exactly as it arrived.
 */
export function slimAgentEvent(event: AgentEvent): AgentEvent {
  if (event.type === "snapshot") return slimSnapshot(event);
  if (event.type === "message_start") {
    const message = event.message;
    const slim = slimMessage(message);
    if (slim === message) return event;
    return { ...event, message: slim as typeof event.message };
  }
  if (event.type === "tool_execution_end") {
    if (event.entry === undefined) return event;
    return { ...event, entry: slimEntry(event.entry) };
  }
  if (event.type === "tool_execution_update") {
    // No entry here, only the result the tool has produced so far: the page reads
    // `output` to show progress, and nothing reads `details`.
    if (event.details === undefined) return event;
    const copy: AnyRecord = { ...event };
    delete copy["details"];
    return copy as unknown as AgentEvent;
  }
  if (event.type === "entry_appended" || event.type === "message_end") {
    const slimmed = { ...event, entry: slimEntry(event.entry) };
    // A `message_end` that also carries the message itself (this pi-durable does
    // not, but a frame is data from a library that can grow a field) gets the
    // same rule, so the message is not a second copy of what the entry dropped.
    const message = (event as { message?: unknown }).message;
    if (message !== undefined) {
      return { ...slimmed, message: slimMessage(message) } as unknown as AgentEvent;
    }
    return slimmed;
  }
  return event;
}
