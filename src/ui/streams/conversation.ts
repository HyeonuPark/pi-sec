/**
 * The one conversation stream of this page, and what each frame means.
 *
 * One stream per page: the root conversation's `/basic-chat/events`, or one
 * focused chat's `/api/conversations/<id>/events`. The route was fixed once from
 * `?chat=<id>` (`state/conversation.ts`), so this module cannot address the root
 * while the page shows a focused chat. Job, inbox, question and report events
 * arrive on the same stream, and they belong to the parts that draw them: those
 * register with {@link onConversationEvent} and this module stays out of it.
 *
 * The reconnect rules are the stream client's (`streams/client.ts`): one wait of
 * 1 s doubling to 30 s for a stream the server closed, nothing opened while the
 * page is hidden, a new stream on a return after 30 s, on `pageshow` with
 * `persisted`, and on `online`. What this module adds is what the page does with
 * that: a lost connection turns the ring and then says so once, and the second
 * snapshot of a page re-reads what the frames of the dropped stream would have
 * changed.
 *
 * A live entry that heads a context (a reset, a compaction) opens a new stream:
 * the server draws only the active context, and the snapshot that comes with the
 * new stream is that drawing. The page keeps the rows it held before the
 * snapshot's first entry, so the new session is drawn below the old one.
 */
import { ApiError } from "../api/request.ts";
import { applyChatRecord, chatId, markChatMissing, readChatRecord, routes } from "../state/conversation.ts";
import {
  clearTools,
  compacting,
  connected,
  disconnectToastSpoken,
  endDisconnectWait,
  endTool,
  LOST_CONNECTION,
  refreshProviders,
  refreshStatus,
  restartReady,
  restartRequired,
  running,
  startDisconnectWait,
  startTool,
  updateTool,
  writing,
} from "../state/run.ts";
import {
  applySnapshot,
  appendEntry,
  headsContext,
  seedAttachmentInfo,
  transcriptRows,
  type TranscriptRow,
} from "../state/transcript.ts";
import { showError } from "../state/toast.ts";
import type { ConversationEntry, ConversationSnapshot, FocusedChatRecord } from "../../shared/wire/conversation.ts";
import { StreamClient, RETURN_REOPEN_MS, type StreamEvent, type StreamListener } from "./client.ts";

/** What one frame's `data` is, read as JSON with a frame that is not JSON left alone. */
function readPayload<T>(event: StreamEvent): T {
  return event.data as T;
}

/** The stream this page listens to, or `null` before the page opens it. */
let client: StreamClient | null = null;

/** Handlers other parts registered, by frame name, so a new client gets them too. */
const listeners = new Map<string, Set<StreamListener>>();

/** Handlers for the connection opening and closing, which is not a frame. */
const stateListeners = new Set<(connected: boolean) => void>();

/** A marker entry that arrived while the page was hidden: the return opens the stream. */
let markerPending = false;

/** When the page went hidden, as a clock reading; 0 while it is visible. */
let hiddenAt = 0;

/** The visibility listener that does the marker's reopen on the return. */
let onVisibility: (() => void) | null = null;

/**
 * Register a handler for one frame of this page's stream.
 *
 * The conversation's own frames are handled here, and every other part of the page
 * that something on this stream announces (a job, an inbox item, a question, a
 * report revision) registers here. The handler is handed the whole frame,
 * including `snapshotCount`, so a handler that has to re-read its own state knows a
 * second snapshot from the first. Returns the way to remove it.
 */
export function onConversationEvent(name: string, handler: StreamListener): () => void {
  const set = listeners.get(name) ?? new Set<StreamListener>();
  set.add(handler);
  listeners.set(name, set);
  // A frame name has one subscription on the client, and it is {@link handleFrame}:
  // that is what hands the frame to this handler (see {@link dispatchTo}), so a
  // handler is in one path to the frame and not two. Registering the same handler
  // for a name already subscribed adds nothing, because a client keeps a set.
  client?.on(name, handleFrame);
  return () => {
    set.delete(handler);
  };
}

/**
 * Register a handler for the connection opening and closing.
 *
 * A part that reads its own list once when the page opens uses this to read it
 * again after a reconnect, because the frames that would have changed it went to a
 * page that was not listening.
 */
export function onConversationState(handler: (connected: boolean) => void): () => void {
  stateListeners.add(handler);
  return () => {
    stateListeners.delete(handler);
  };
}

/** Tell every registered part what the connection did. */
function notifyState(open: boolean): void {
  for (const handler of stateListeners) handler(open);
}

/** A frame arrived: hand it to the parts that asked for it, once each. */
function dispatchTo(name: string, event: StreamEvent): void {
  for (const handler of listeners.get(name) ?? []) handler(event);
}

/**
 * Take a frame of the conversation stream.
 *
 * This is the stream's one listener for a frame name it carries: the page's own work
 * on the frame comes first, and then {@link dispatchTo} hands the same frame to the
 * parts that asked for it, so a part that draws a job or a question on this stream
 * reacts to the frame the transcript did and to it once.
 */
function handleFrame(event: StreamEvent): void {
  const name = event.name;
  // The snapshot is read before its handlers run, so a handler that draws from the
  // entries this page now holds sees them.
  switch (name) {
    case "snapshot": {
      const snapshot = readPayload<ConversationSnapshot>(event);
      applySnapshot(snapshot);
      // The first snapshot is this page's own connection; from the second one on
      // the stream was away, and what it would have announced went to nobody.
      if (event.snapshotCount > 1) void rereadAfterStreamReturn();
      break;
    }
    case "run_start":
      running.value = true;
      break;
    case "run_end":
      running.value = false;
      writing.value = false;
      clearTools();
      break;
    case "message_start":
      writing.value = true;
      break;
    case "message_end": {
      const data = readPayload<{ entry?: ConversationEntry; attachments?: ConversationSnapshot["attachments"] }>(event);
      // The frame that carries a sent message also carries what its files are.
      seedAttachmentInfo(data);
      if (data.entry !== undefined) appendEntry(data.entry);
      writing.value = false;
      if (data.entry !== undefined) reopenForMarker(data.entry);
      break;
    }
    case "entry_appended": {
      const data = readPayload<{ entry?: ConversationEntry; attachments?: ConversationSnapshot["attachments"] }>(event);
      seedAttachmentInfo(data);
      if (data.entry !== undefined) {
        appendEntry(data.entry);
        reopenForMarker(data.entry);
      }
      break;
    }
    case "tool_execution_start": {
      const data = readPayload<{ toolCallId: string; toolName?: string }>(event);
      startTool(data.toolCallId, data.toolName ?? "tool");
      break;
    }
    case "tool_execution_update": {
      const data = readPayload<{ toolCallId: string; output?: { set?: string; append?: string } }>(event);
      updateTool(data.toolCallId, data.output);
      break;
    }
    case "tool_execution_end": {
      const data = readPayload<{ toolCallId: string }>(event);
      endTool(data.toolCallId);
      break;
    }
    case "compaction_start":
      compacting.value = true;
      break;
    case "compaction_end":
      compacting.value = false;
      break;
    case "notice": {
      const data = readPayload<{ code?: string }>(event);
      // The server says its buffer for this stream is behind; the page says so in
      // the ring, and the reconnect it is already trying is what catches up.
      if (data.code === "stream_lagging") connected.value = false;
      break;
    }
    case "restart_required": {
      const data = readPayload<{ ready?: boolean }>(event);
      restartRequired.value = true;
      restartReady.value = data.ready === true;
      break;
    }
    case "restart_withdrawn":
      restartReady.value = false;
      break;
    case "usage_hold_changed":
      // The banner draws from the status route and from nothing else, so the frame
      // is a nudge to read it again rather than a value of its own.
      void refreshStatus();
      break;
    case "focused_chat_updated": {
      const data = readPayload<FocusedChatRecord>(event);
      if (chatId === null || Number(data.conversationId) !== chatId) break;
      if (data.change === "deleted") markChatMissing();
      else applyChatRecord(data);
      break;
    }
    default:
      break;
  }
  dispatchTo(name, event);
}

/**
 * Re-read what the frames of a dropped stream would have changed.
 *
 * The snapshot restores the transcript and nothing else. An inbox item, a
 * question, a report revision and a chat record are each drawn from their own
 * read, and the frame that announced one went to a page that was not listening;
 * those parts register with {@link onConversationEvent} and hear the second
 * snapshot's `snapshotCount`. What this module owns is the chat record.
 */
async function rereadAfterStreamReturn(): Promise<void> {
  if (chatId === null) return;
  try {
    const state = await readChatRecord();
    if (state === "missing") {
      // The chat was deleted while the page was away. There is nothing to stream
      // any more, so the retries stop here rather than at a stream that answers 404.
      client?.stop();
      client = null;
    }
  } catch {
    /* the connection's own state is on screen already */
  }
}

/**
 * Open the stream again when a live frame carries a marker entry.
 *
 * The marker arrives as a live frame and never as a new snapshot, so the page opens
 * a new stream and takes the snapshot that comes with it. The snapshot holds the
 * marker, so the page keeps the rows above it and draws the snapshot below them.
 * A hidden page asks for nothing: the return is what opens the stream.
 */
function reopenForMarker(entry: ConversationEntry | null | undefined): void {
  if (!headsContext(entry)) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    markerPending = true;
    return;
  }
  client?.reopenNow();
}

/**
 * A page that came back opens the stream a marker asked for while it was away.
 *
 * The stream client opens a stream of its own for a return after thirty seconds,
 * and the snapshot that comes with it is the drawing the marker asked for. A
 * return that the client opens needs nothing from here: counting the time away
 * is how this module stays out of that open, and a return that opens two streams
 * is what a second ask would cost.
 */
function watchMarkerReturn(): void {
  if (typeof document === "undefined" || onVisibility !== null) return;
  onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const awayMs = hiddenAt === 0 ? 0 : Date.now() - hiddenAt;
    hiddenAt = 0;
    if (!markerPending) return;
    markerPending = false;
    if (awayMs >= RETURN_REOPEN_MS) return;
    client?.reopenNow();
  };
  document.addEventListener("visibilitychange", onVisibility);
}

/** The stream opened: the ring rests, and the status this page shows is read again. */
function handleOpen(): void {
  connected.value = true;
  endDisconnectWait();
  void refreshStatus();
  // Any new stream serves a marker that waited for the return: the snapshot it
  // opens with is the drawing the marker asked for. A pending marker that another
  // route opened for (`pageshow`, `online`) must not open a second one.
  markerPending = false;
  notifyState(true);
}

/**
 * The stream is not open any more: it failed, or a page that went away gave it up.
 *
 * The ring says so from this call, and the toast is the failure's own business
 * ({@link handleLost}), so a stream a hidden page gave up costs no notice.
 */
function handleClosed(): void {
  connected.value = false;
  notifyState(false);
}

/**
 * The stream failed or was closed.
 *
 * The first failure starts the wait, and only its end speaks. A failure that comes
 * after the toast has spoken says so again, as it always did.
 */
function handleLost(): void {
  connected.value = false;
  if (disconnectToastSpoken()) showError(LOST_CONNECTION);
  else startDisconnectWait();
  notifyState(false);
}

/** The frames this module reads itself; every other name a part registers for is a pass. */
const OWNED_FRAMES: readonly string[] = [
  "snapshot",
  "run_start",
  "run_end",
  "message_start",
  "message_end",
  "entry_appended",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "notice",
  "restart_required",
  "restart_withdrawn",
  "usage_hold_changed",
  "focused_chat_updated",
];

/** Attach the frames this module owns to a client, and the connection's two states. */
function attach(target: StreamClient): void {
  // A name this module reads is subscribed here, and so is a name a part registered
  // for before the page had a client: both go through `handleFrame`, which is the
  // only path a frame takes to a registered handler.
  for (const name of new Set([...OWNED_FRAMES, ...listeners.keys()])) target.on(name, handleFrame);
  target.on("error", () => handleLost());
}

/** Open the stream this page listens to. */
export function startConversation(): void {
  if (client !== null) return;
  // A page that has just opened its stream is not connected yet, so the ring says
  // so from the first paint. A stream that opens inside the wait says nothing more;
  // one that does not ends with the toast.
  if (!connected.value) startDisconnectWait();
  watchMarkerReturn();
  const next = new StreamClient({
    path: routes.events,
    onStateChange: (open) => {
      if (open) handleOpen();
      else handleClosed();
    },
  });
  client = next;
  attach(next);
  next.start();
}

/**
 * Read this page's chat record, and open the stream.
 *
 * A number the server does not know opens no stream at all: a non-200 answer
 * closes an `EventSource` and the browser never retries it, and there is no
 * transcript to stream anyway. The bar and the composer are drawn from the record,
 * which is the other reason it comes first.
 */
export async function openChat(): Promise<void> {
  if (chatId !== null) {
    try {
      const state = await readChatRecord();
      // Gone between the press and the read, which a reader cannot tell from a
      // number that never existed: the same sentence covers both.
      if (state === "missing") return;
    } catch (error) {
      markChatMissing();
      if (!(error instanceof ApiError && error.status === 404)) {
        showError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }
  startConversation();
  // The status route and the provider list are read at load, as the page always did:
  // the restart banner, the failed config reload and the credential line are facts
  // about the daemon, not about the stream.
  void refreshStatus();
  void refreshProviders();
}

/** Give up the stream: the page is going away, or the chat it showed is. */
export function stopConversation(): void {
  client?.stop();
  client = null;
  if (onVisibility !== null && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
  onVisibility = null;
  markerPending = false;
  hiddenAt = 0;
}

/** The rows the transcript draws now, for a caller that reads them without a component. */
export function currentRows(): readonly TranscriptRow[] {
  return transcriptRows.value;
}
