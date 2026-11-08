/**
 * The transcript: what the conversation holds, and the rows it draws.
 *
 * The rows are built from three things and nothing else: the entries the server
 * sent, the calls still in flight, and whether an answer is being written. Each
 * row has a stable key, which is the entry id for a row that draws one entry and
 * the first entry's key for a folded stretch, so a draw that adds an entry leaves
 * every row above it the same element.
 *
 * Two rules of the drawing plan live here rather than in the component:
 *
 * - The first paint of a snapshot draws the last {@link FIRST_DRAW_ENTRIES}
 *   entries and the rest when the browser is idle, so a long conversation opens on
 *   its foot.
 * - Following the tail is decided by a scroll, not by a measurement at the foot of
 *   a draw, so a row that grows after it was drawn cannot pull a reader down.
 *
 * A tool call's growing output is kept out of the rows on purpose: it lives in
 * `run.ts`'s output map, which only the panel that shows it reads, so one output
 * frame writes one `<pre>` and rebuilds no row around it.
 */
import { computed, signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { reconcileById } from "./keyed.ts";
import {
  compacting,
  drawSnapshotTools,
  liveTools,
  model,
  running,
  writing as writingState,
  type LiveTool,
} from "./run.ts";
import type {
  AttachmentDescriptor,
  ConversationEntry,
  ConversationHistory,
  ConversationSnapshot,
} from "../../shared/wire/conversation.ts";
import { routes } from "./conversation.ts";
import { showError } from "./toast.ts";
import { isSilentAssistantTurn } from "../../shared/silent-turn.ts";
import {
  OPERATOR_SOURCE,
  entryText,
  parseAnswerInput,
  parseApprovalInput,
  parseReview,
  readFoldedMessage,
  toolResultCallId,
  toolResultName,
  toolResultText,
  type Answer,
  type Approval,
  type Review,
} from "../chat/transcript/envelope.ts";

/* ------------------------------------------------------------------- state */

/** One held entry and the key the transcript knows it by. */
interface HeldEntry {
  readonly key: string;
  readonly entry: ConversationEntry;
  /**
   * True for an entry a `Load previous session` press brought, and for nothing
   * else. The rows it draws are part of this view and not part of the model's
   * context, so they are drawn with `aria-live` off. A new snapshot keeps them
   * when it keeps the rows around them (see {@link applySnapshot}).
   */
  readonly earlier?: boolean;
}

const held = signal<readonly HeldEntry[]>([]);

/** The entries as the page holds them, in order. */
export const entries = computed<readonly ConversationEntry[]>(() => held.value.map((item) => item.entry));

/** What an attachment id is, by id. Filled by an upload here and by a payload's descriptors. */
export const attachmentInfo = signal<ReadonlyMap<string, AttachmentDescriptor>>(new Map());

/** Which collapsible blocks the operator has opened, by stable group key. */
export const openGroups = signal<ReadonlyMap<string, boolean>>(new Map());

/** The first entry a draw covers. Nonzero only while the rest of a first paint waits. */
export const fromEntry = signal(0);

/**
 * Whether the conversation has drawn anything at all.
 *
 * A page that has heard no snapshot has an empty transcript, as the shell wrote it:
 * the writing row belongs to a draw, and a page that drew nothing is not showing a
 * conversation yet.
 */
const started = signal(false);

/** How many entries the first paint of a snapshot covers: about one screen. */
export const FIRST_DRAW_ENTRIES = 40;

/* -------------------------------------------------------- earlier sessions */

/**
 * Whether the store holds anything before the first entry the page holds.
 *
 * The snapshot says so on the first paint, so the button is drawn with the rows
 * and not added above them afterwards: a row that appears late pushes what the
 * reader was reading down by its own height.
 */
export const hasEarlier = signal(false);

/** True while a press is reading, which is what keeps a second press from reading twice. */
export const loadingEarlier = signal(false);

/** The text the button carries. Part of the row's key, so it cannot change under a press. */
export const LOAD_EARLIER_LABEL = "Load previous session";

/** The key the button row always has. */
export const LOAD_EARLIER_ROW_KEY = "load-earlier";

/* -------------------------------------------------------------------- rows */

/** One tool panel of a folded stretch. */
export interface ToolItemRow {
  readonly kind: "tool";
  readonly key: string;
  readonly name: string;
  /** A live panel carries its call id, so its output can be written into it. */
  readonly callId?: string;
  /** The output of a committed call. A live one reads its output from `run.ts`. */
  readonly text: string;
  /** True for a call still in flight: its panel carries the call id and its output lives in the run state. */
  readonly live?: boolean;
}

/** One folded message of a stretch. */
export interface MessageItemRow {
  readonly kind: "message";
  readonly key: string;
  readonly source: string;
  /** The labels that place it, at most three, `name=value`. */
  readonly labels: readonly string[];
  readonly body: string;
}

export type RunItemRow = ToolItemRow | MessageItemRow;

interface RowBase {
  readonly key: string;
  /**
   * True for a row drawn from an entry a `Load previous session` press brought.
   *
   * The row belongs to what the reader asked to see and not to the model's
   * context, so it is drawn without being announced: the transcript is one live
   * region, and a press that brings hundreds of rows must not read them all out.
   */
  readonly earlier?: boolean;
}

export interface UserRow extends RowBase {
  readonly type: "user";
  readonly text: string;
  readonly attachments: readonly string[];
}

export interface AssistantRow extends RowBase {
  readonly type: "assistant";
  readonly text: string;
}

export interface ReviewRow extends RowBase {
  readonly type: "review";
  readonly review: Review;
}

export interface ApprovalRow extends RowBase {
  readonly type: "approval";
  readonly approval: Approval;
}

export interface AnswerRow extends RowBase {
  readonly type: "answer";
  readonly answer: Answer;
}

export interface DividerRow extends RowBase {
  readonly type: "divider";
  readonly label: string;
}

export interface SectionRow extends RowBase {
  readonly type: "section";
  readonly groupKey: string;
  readonly text: string;
}

export interface RunRow extends RowBase {
  readonly type: "run";
  readonly groupKey: string;
  readonly head: string;
  readonly items: readonly RunItemRow[];
  readonly running: boolean;
}

export interface WritingRow extends RowBase {
  readonly type: "writing";
  readonly writing: boolean;
}

/**
 * The one row above the transcript: the button that brings the session before
 * the one on screen.
 *
 * It is a row of the transcript and not a part of the shell, so the shell's
 * markup stays as it was and the row is drawn by the same list that draws every
 * other row. It is drawn only while something is stored before what the page
 * holds, so a conversation with one session has no button at all.
 */
export interface LoadEarlierRow extends RowBase {
  readonly type: "load-earlier";
  readonly label: string;
  readonly loading: boolean;
}

/** One row of the transcript, in the order it is drawn. */
export type TranscriptRow =
  | UserRow
  | AssistantRow
  | ReviewRow
  | ApprovalRow
  | AnswerRow
  | DividerRow
  | SectionRow
  | RunRow
  | WritingRow
  | LoadEarlierRow;

/** The key the writing row always has. */
export const WRITING_ROW_KEY = "writing";

/** The attributes worth a glance next to an item's source. Fixed order. */
const MESSAGE_ITEM_LABELS = ["via", "kind", "tool", "from", "title", "key", "job", "round", "status"] as const;

/** "bash, read ×2, +1 more" — the tools of one run, counted, four names at most. */
function toolNameList(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const listed = [...counts.entries()]
    .slice(0, 4)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const more = counts.size > 4 ? `, +${counts.size - 4} more` : "";
  return `${listed.join(", ")}${more}`;
}

/** The head of a folded run: the counts first, then the names. */
function runHead(names: readonly string[], messages: number, sources: readonly string[], running: boolean): string {
  const segments: string[] = [];
  if (names.length > 0) {
    segments.push(`${names.length} ${names.length === 1 ? "tool call" : "tool calls"}${running ? " …" : ""}`);
  }
  if (messages > 0) segments.push(`${messages} ${messages === 1 ? "message" : "messages"}`);
  if (names.length > 0) segments.push(toolNameList(names));
  if (sources.length > 0) segments.push(sources.join(", "));
  return segments.join(" · ");
}

/** The key the transcript knows one entry by, also when it carries no id. */
function entryKeyAt(entry: ConversationEntry, index: number): string {
  return entry.id === undefined || entry.id === null ? `at-${index}` : String(entry.id);
}

/** Two held entries with the same key are the same entry when their text did not change. */
function sameEntry(left: HeldEntry, right: HeldEntry): boolean {
  if (left.key !== right.key) return false;
  if (left.entry === right.entry) return true;
  return JSON.stringify(left.entry) === JSON.stringify(right.entry);
}

/** The attachment ids a message names, in the order it names them. */
function attachmentIds(attributes: ReadonlyMap<string, string>): readonly string[] {
  const raw = attributes.get("attachments");
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** What one entry draws: nothing, an item of a run, or rows of its own. */
type EntryDraw =
  | { readonly kind: "skip" }
  | { readonly kind: "tool"; readonly item: ToolItemRow }
  | { readonly kind: "fold"; readonly item: MessageItemRow }
  | { readonly kind: "rows"; readonly rows: readonly TranscriptRow[] };

/** The rows of a section note, which starts folded and keeps its own open state. */
function sectionRows(key: string, text: string): readonly TranscriptRow[] {
  return [
    { type: "divider", key: `divider:${key}`, label: "system prompt updated" },
    { type: "section", key: `section:${key}`, groupKey: `section:${key}`, text },
  ];
}

/** The rows one entry draws, each carrying the flag a press's entries are drawn with. */
function marked(rows: readonly TranscriptRow[], earlier: boolean | undefined): readonly TranscriptRow[] {
  if (earlier !== true) return rows;
  return rows.map((row) => ({ ...row, earlier: true }));
}

/** One entry, read the way the transcript reads it. */
function drawEntry(entry: ConversationEntry, key: string, earlier: boolean | undefined): EntryDraw {
  const kind = entry.kind;
  if (kind === "pi.tool-result") {
    const callId = toolResultCallId(entry);
    return {
      kind: "tool",
      item: {
        kind: "tool",
        key: `entry:${key}`,
        name: toolResultName(entry),
        text: toolResultText(entry),
        ...(callId === undefined ? {} : { callId }),
      },
    };
  }

  const text = entryText(entry);
  // An entry that draws nothing must not split a run: a system prompt change, an
  // assistant turn that only asks for the next tool call, or one whose whole
  // answer is the no-response marker.
  if (kind === "pi.system" || (kind === "pi.assistant" && isSilentAssistantTurn(text))) return { kind: "skip" };

  if (kind === "pi.user") {
    const approval = parseApprovalInput(text);
    if (approval !== undefined) {
      return { kind: "rows", rows: marked([{ type: "approval", key: `entry:${key}`, approval }], earlier) };
    }
    const review = parseReview(text);
    if (review !== undefined) {
      return { kind: "rows", rows: marked([{ type: "review", key: `entry:${key}`, review }], earlier) };
    }

    const answer = parseAnswerInput(text);
    if (answer !== undefined) {
      return { kind: "rows", rows: marked([{ type: "answer", key: `entry:${key}`, answer }], earlier) };
    }

    const message = readFoldedMessage(text);
    if (message === undefined) {
      // No label at all: an operator message from before the envelope.
      return { kind: "rows", rows: marked([{ type: "user", key: `entry:${key}`, text, attachments: [] }], earlier) };
    }
    if (message.source === OPERATOR_SOURCE) {
      // The envelope is a label, not the message, so the bubble shows the body.
      return {
        kind: "rows",
        rows: marked(
          [{ type: "user", key: `entry:${key}`, text: message.body, attachments: attachmentIds(message.attributes) }],
          earlier,
        ),
      };
    }
    return {
      kind: "fold",
      item: {
        kind: "message",
        key: `entry:${key}`,
        source: message.source,
        labels: MESSAGE_ITEM_LABELS.map((name) => [name, message.attributes.get(name)] as const)
          .filter(([name, value]) => value !== undefined && value !== "" && !(name === "status" && value === "done"))
          .slice(0, 3)
          .map(([name, value]) => `${name}=${value}`),
        body: message.body,
      },
    };
  }

  if (kind === "pi.assistant") {
    return { kind: "rows", rows: marked([{ type: "assistant", key: `entry:${key}`, text }], earlier) };
  }
  if (kind === "pi.reset") {
    return { kind: "rows", rows: marked([{ type: "divider", key: `divider:${key}`, label: "new session" }], earlier) };
  }
  if (kind === "sec.section-update") {
    const note = readFoldedMessage(text);
    if (note !== undefined && note.source !== OPERATOR_SOURCE) {
      return {
        kind: "fold",
        item: {
          kind: "message",
          key: `entry:${key}`,
          source: note.source,
          labels: MESSAGE_ITEM_LABELS.map((name) => [name, note.attributes.get(name)] as const)
            .filter(([name, value]) => value !== undefined && value !== "" && !(name === "status" && value === "done"))
            .slice(0, 3)
            .map(([name, value]) => `${name}=${value}`),
          body: note.body,
        },
      };
    }
    const body = note === undefined ? text : note.body;
    return { kind: "rows", rows: marked(sectionRows(key, body), earlier) };
  }
  if (kind === "pi.compaction") {
    return {
      kind: "rows",
      rows: marked([{ type: "divider", key: `divider:${key}`, label: "context compacted" }], earlier),
    };
  }
  return { kind: "skip" };
}

/**
 * The rows of the transcript, from `from` on, plus the button row and the writing
 * row.
 *
 * The button row comes first, above the first entry drawn, because that is where
 * the reader asks for the session before this one: the shell's `new session`
 * divider is the top of the session on screen, and the button sits over it.
 *
 * A working stretch holds tool calls and folded messages together, in the order
 * they arrived: one card, not two. A call still in flight joins the stretch it
 * continues, and a stretch that ends on a message another agent sent still takes
 * it, because the card is drawn only when a row of its own ends the stretch.
 */
function buildRows(
  list: readonly HeldEntry[],
  tools: ReadonlyMap<string, LiveTool>,
  writing: boolean,
  from: number,
  earlier: boolean,
  loading: boolean,
): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  // The button is the first row whenever something is stored before the context,
  // also on the first paint of a long transcript, which draws its last rows only.
  // It is drawn with the rows and never added above them afterwards: a row that
  // appears late pushes what the reader was reading down by its own height.
  if (earlier) {
    rows.push({ type: "load-earlier", key: LOAD_EARLIER_ROW_KEY, label: LOAD_EARLIER_LABEL, loading });
  }
  const committed = new Set<string>();
  let run: { key: string; names: string[]; sources: string[]; messages: number; items: RunItemRow[] } | null = null;

  const openRun = (key: string) => {
    run ??= { key, names: [], sources: [], messages: 0, items: [] };
    return run;
  };
  const flushRun = () => {
    if (run !== null) {
      rows.push({
        type: "run",
        key: run.key,
        groupKey: run.key,
        head: runHead(run.names, run.messages, run.sources, false),
        items: run.items,
        running: false,
      });
      run = null;
    }
  };

  for (let index = from; index < list.length; index += 1) {
    const item = list[index];
    if (item === undefined) continue;
    const draw = drawEntry(item.entry, item.key, item.earlier);
    if (draw.kind === "skip") continue;
    if (draw.kind === "tool") {
      const current = openRun(`run:${item.key}`);
      current.names.push(draw.item.name);
      current.items.push(draw.item);
      if (draw.item.callId !== undefined) committed.add(draw.item.callId);
      continue;
    }
    if (draw.kind === "fold") {
      const current = openRun(`run:${item.key}`);
      if (!current.sources.includes(draw.item.source)) current.sources.push(draw.item.source);
      current.messages += 1;
      current.items.push(draw.item);
      continue;
    }
    // A row of its own ends the open run.
    flushRun();
    for (const row of draw.rows) rows.push(row);
  }

  // A call still in flight continues the run it belongs to: it is a tool call, and
  // nothing drawn has come between it and the calls before it.
  const live = [...tools.entries()].filter(([callId]) => !committed.has(callId));
  if (live.length > 0) {
    const current = openRun("run:live");
    for (const [callId, tool] of live) {
      current.names.push(tool.name);
      current.items.push({
        kind: "tool",
        key: `live:${callId}`,
        name: tool.name,
        callId,
        text: "",
        live: true,
      });
    }
    rows.push({
      type: "run",
      key: current.key,
      groupKey: current.key,
      head: runHead(current.names, current.messages, current.sources, live.some(([, tool]) => !tool.done)),
      items: current.items,
      running: live.some(([, tool]) => !tool.done),
    });
    run = null;
  } else {
    flushRun();
  }

  // An answer is written behind this row, not in pieces. The row is pushed whether
  // or not an answer is under way: an idle row is hidden by its class but keeps its
  // height, so the tail of the transcript is the same size before, during and after
  // an answer.
  rows.push({ type: "writing", key: WRITING_ROW_KEY, writing });
  return rows;
}

/** What a draw did, for the tests: how many rows it built and how many draws ran. */
export const transcriptStats = { built: 0, draws: 0 };

/** The markup each row carried on the last draw, by row key: what a build is counted by. */
let drawnSignatures = new Map<string, string>();

/** The rows the transcript draws now. */
export const transcriptRows = computed<readonly TranscriptRow[]>(() => {
  if (!started.value) return [];
  transcriptStats.draws += 1;
  const rows = buildRows(
    held.value,
    liveTools.value,
    writingState.value,
    fromEntry.value,
    hasEarlier.value,
    loadingEarlier.value,
  );
  const next = new Map<string, string>();
  for (const row of rows) {
    const signature = JSON.stringify(row);
    next.set(row.key, signature);
    // The writing row is not an entry: it is drawn on every list and counted by
    // nothing.
    if (row.type === "writing") continue;
    if (drawnSignatures.get(row.key) !== signature) transcriptStats.built += 1;
  }
  drawnSignatures = next;
  return rows;
});

/** Whether the transcript has drawn a row already, which decides the first paint. */
let drawnOnce = false;

/** Mark the transcript as drawn, so the next snapshot draws it whole. */
export function markDrawn(): void {
  drawnOnce = true;
}

/* ---------------------------------------------------------------- snapshot */

/**
 * The held entries a snapshot leaves on screen, or an empty list.
 *
 * A snapshot is the active context, which starts at its head marker: the entry
 * with a `head` field, a reset or a compaction. When the page already holds that
 * marker, it received it as a live frame on the same stream, so it received every
 * entry before it too, and the rows before the snapshot's first entry are the
 * ones the reader had. When the page does not hold the marker, entries could be
 * missing between the held rows and the snapshot, so nothing is kept.
 */
function rowsBeforeSnapshot(next: readonly ConversationEntry[]): readonly HeldEntry[] {
  const head = next.find((entry) => headsContext(entry));
  if (head === undefined) return [];
  const headKey = entryKeyAt(head, next.indexOf(head));
  if (!held.value.some((item) => item.key === headKey)) return [];
  let first = Infinity;
  for (const entry of next) {
    const id = Number(entry.id);
    if (Number.isSafeInteger(id) && id < first) first = id;
  }
  if (first === Infinity) return [];
  return held.value.filter((item) => {
    const id = Number(item.entry.id);
    return Number.isSafeInteger(id) && id < first;
  });
}

/** Take the entries a snapshot carries, matching them to the ones the page holds by key. */
export function applySnapshotEntries(next: readonly ConversationEntry[]): void {
  const kept = rowsBeforeSnapshot(next);
  const incoming: HeldEntry[] = [
    ...kept,
    ...next.map((entry, index) => ({ key: entryKeyAt(entry, index), entry })),
  ];
  held.value = reconcileById(held.value, incoming, (item) => item.key, sameEntry);
  keptRows = kept.length > 0;
}

/** Whether the last snapshot left earlier rows on screen. */
let keptRows = false;

/**
 * The number the page must send to ask for the session before the one it holds.
 *
 * That is the smallest entry id on screen. An entry the page holds without a
 * numeric id cannot be asked for, and the answer is `undefined`: the page then
 * does nothing rather than asking for a place it cannot name.
 */
export function oldestEntryId(): number | undefined {
  for (const item of held.value) {
    const id = Number(item.entry.id);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return undefined;
}

/**
 * Read the session before the one on screen and put it above the rows.
 *
 * One press reads one session. What comes back is drawn on top of what is
 * already there, and nothing is written anywhere: the entries the model sees and
 * the stored transcript are the same after the press as before it.
 *
 * Three things happen around the draw, and all three are needed:
 *
 * - The distance from the foot is measured before the rows are added. The reader
 *   was looking at a row; new rows above it must not move it, and the number in
 *   `scrollTop` would name a different row once the list grew.
 * - The draw is put back to the first row. A long conversation draws its last
 *   {@link FIRST_DRAW_ENTRIES} rows first and the rest when the browser is idle;
 *   a draw that is still limited would leave the new rows out.
 * - The rows are matched by entry id, so nothing already drawn is built twice and
 *   the two lists cannot draw the same entry as two rows.
 *
 * A failed read keeps every row and keeps the button, and says so once in the
 * page's notice. An answer that is not this route's shape is not a failure: the
 * page draws nothing new and leaves the button where it was.
 */
export async function loadEarlier(): Promise<void> {
  if (loadingEarlier.value) return;
  if (!hasEarlier.value) return;
  const before = oldestEntryId();
  if (before === undefined) return;
  loadingEarlier.value = true;
  try {
    const answer = await request<ConversationHistory>(`${routes.history}?before=${before}`);
    if (answer === null || typeof answer !== "object" || !Array.isArray(answer.entries)) return;
    // The descriptors are taken before the draw, so a picture in the loaded
    // session is a picture on the first paint and not a chip to correct later.
    seedAttachmentInfo(answer);
    const known = new Set(held.value.map((item) => item.key));
    const incoming: HeldEntry[] = [];
    answer.entries.forEach((entry, index) => {
      const key = entryKeyAt(entry, index);
      if (known.has(key)) return;
      known.add(key);
      incoming.push({ key, entry, earlier: true });
    });
    if (incoming.length > 0) {
      const pane = transcriptPane();
      restDistance = pane === null ? null : pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      keepDistanceFromBottom = true;
      cancelRestOfTranscript();
      fromEntry.value = 0;
      held.value = [...incoming, ...held.value];
    }
    hasEarlier.value = answer.hasMore === true;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    loadingEarlier.value = false;
  }
}

/**
 * Take one entry an appended frame carries.
 *
 * An entry is announced once, but appending is kept idempotent anyway: a frame
 * replayed after a snapshot must not append the same entry twice.
 */
export function appendEntry(entry: ConversationEntry): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const key = entryKeyAt(entry, held.value.length);
  if (held.value.some((item) => item.key === key)) return false;
  // A newer draw reads the state as it stands, so the queued rest of a first paint
  // has nothing left to do, and the list it draws is the whole of it.
  cancelRestOfTranscript();
  keepDistanceFromBottom = false;
  fromEntry.value = 0;
  started.value = true;
  held.value = [...held.value, { key, entry }];
  return true;
}

/**
 * Remember what one payload says each of its attachment ids is.
 *
 * A message carries ids alone, so its bubble draws from {@link attachmentInfo}. A
 * payload that carries entries also carries a descriptor for every id they name,
 * which is what lets the first paint pick the picture branch. An id with no
 * descriptor keeps what the page already knew, and draws as a chip otherwise.
 */
export function seedAttachmentInfo(payload: { readonly attachments?: Readonly<Record<string, AttachmentDescriptor>> } | null): void {
  const described = payload?.attachments;
  if (described === null || described === undefined || typeof described !== "object") return;
  const next = new Map(attachmentInfo.value);
  let learned = false;
  for (const [id, record] of Object.entries(described)) {
    if (record === null || typeof record !== "object") continue;
    const known = next.get(id);
    const merged: AttachmentDescriptor = {
      name: record.name ?? known?.name ?? id,
      mime: record.mime ?? known?.mime ?? "",
      bytes: record.bytes ?? known?.bytes,
      w: record.w ?? known?.w,
      h: record.h ?? known?.h,
    };
    next.set(id, merged);
    if (known === undefined || JSON.stringify(known) !== JSON.stringify(merged)) learned = true;
  }
  if (learned) attachmentInfo.value = next;
}

/**
 * Take the whole state a snapshot carries: the entries, the model, the calls in
 * flight, the compaction row, the writing row and whether a run is active.
 *
 * The order matters only once: the attachment descriptors are taken before the
 * draw, so a picture in this payload is a picture on the first paint and not a
 * chip that has to be corrected.
 */
export function applySnapshot(snapshot: ConversationSnapshot): void {
  started.value = true;
  applySnapshotEntries(Array.isArray(snapshot.entries) ? snapshot.entries : []);
  seedAttachmentInfo(snapshot);
  // The snapshot is the server's own drawing of the active context. When it left
  // earlier rows on screen, the button keeps the state it had, because it sits
  // over those rows and not over the snapshot. Otherwise whether anything is
  // stored before this context is what the server says it is. An older server
  // that does not send the field answers `false`: the page draws no button.
  if (!keptRows) hasEarlier.value = snapshot.hasEarlier === true;
  const next = snapshot.agent?.model;
  if (next !== undefined && next !== null) model.value = next;
  drawSnapshotTools(snapshot.tools);
  compacting.value = Array.isArray(snapshot.compactions) && snapshot.compactions.length > 0;
  writingState.value = Boolean(snapshot.generation?.message);
  running.value = snapshot.run !== null && snapshot.run !== undefined;
  planSnapshotDraw();
}

/* -------------------------------------------------------------- first paint */

/** How long an idle callback may be put off before the rest is drawn anyway. */
export const REST_OF_TRANSCRIPT_TIMEOUT_MS = 500;

/** The way to drop the queued rest of a first paint, or `null` when none is queued. */
let restOfTranscript: (() => void) | null = null;

/** Drop a queued rest of a first paint: a newer draw reads the same state. */
export function cancelRestOfTranscript(): void {
  if (restOfTranscript === null) return;
  restOfTranscript();
  restOfTranscript = null;
}

/** The pane's state when the rest was queued: adding rows above must not move the reader. */
let restDistance: number | null = null;

/**
 * Draw the rows the first paint left out, once the browser is idle.
 *
 * These rows are added above the ones already drawn, so the number in `scrollTop`
 * would no longer name the same row. A reader keeps their distance from the foot
 * instead, which holds the row they are reading in place.
 */
export function scheduleRestOfTranscript(): void {
  cancelRestOfTranscript();
  let queued = true;
  const run = () => {
    if (!queued) return;
    queued = false;
    restOfTranscript = null;
    // The reader may have scrolled since this was queued, so the distance is the
    // one the pane reports now, before the rows above are added.
    const pane = transcriptPane();
    restDistance = pane === null ? null : pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    keepDistanceFromBottom = true;
    fromEntry.value = 0;
  };
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: REST_OF_TRANSCRIPT_TIMEOUT_MS });
    restOfTranscript = () => {
      queued = false;
      window.cancelIdleCallback(handle);
    };
    return;
  }
  const handle = setTimeout(run, 0);
  restOfTranscript = () => {
    queued = false;
    clearTimeout(handle);
  };
}

/** Whether the next draw holds the reader's distance from the foot rather than its place. */
let keepDistanceFromBottom = false;

/**
 * Plan the draw a snapshot opens with.
 *
 * The last screen is what the page opens on, so that is what its first paint
 * builds, and the rows above it follow in the same draw rules. A transcript that
 * already shows rows is drawn whole instead: a partial pass would take the rows
 * above the foot away only to put them back.
 */
export function planSnapshotDraw(): void {
  cancelRestOfTranscript();
  keepDistanceFromBottom = false;
  const total = held.value.length;
  if (drawnOnce || total <= FIRST_DRAW_ENTRIES) {
    fromEntry.value = 0;
    return;
  }
  fromEntry.value = total - FIRST_DRAW_ENTRIES;
  scheduleRestOfTranscript();
}

/* -------------------------------------------------------------- following */

/** Distance from the tail that still counts as "following along". */
export const BOTTOM_SLACK_PX = 24;

/**
 * Whether the operator was reading the tail of the transcript the last time they
 * scrolled. A scroll is the only thing that says what the operator wants, and a
 * layout can move the foot without one, so the remembered answer keeps saying the
 * tail until the operator scrolls.
 */
let followTail = true;

/** Whether the pane is watched for a scroll and a size change already. */
let paneWatched = false;

/** The live `ResizeObserver` over the transcript and its pane, or `null` without one. */
let paneResizeObserver: ResizeObserver | null = null;

/** The element the transcript draws into, which is the shell's own `#transcript`. */
let transcriptHost: HTMLElement | null = null;

/** The element the transcript draws into. */
export function setTranscriptElement(element: Element | null): void {
  transcriptHost = element instanceof HTMLElement ? element : null;
}

/** The pane the transcript scrolls in, which is its parent. */
export function transcriptPane(): HTMLElement | null {
  const host = transcriptHost;
  if (host === null) return null;
  const pane = host.parentElement;
  return pane instanceof HTMLElement ? pane : null;
}

/** Whether the pane sits at the tail of the transcript. */
export function paneAtTheBottom(pane: HTMLElement | null): boolean {
  if (pane === null) return true;
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= BOTTOM_SLACK_PX;
}

/** Whether the page is following the tail now. */
export function followingTail(): boolean {
  return followTail;
}

/**
 * Watch the pane for the two things a draw does not see: a scroll by the operator,
 * and a row whose height changes after it was drawn.
 *
 * A row can grow well after its draw: a bubble reflows around a picture, a code
 * block takes the width of the pane, a font finishes loading. A reader at the foot
 * stays at the foot.
 */
export function watchPane(): void {
  if (paneWatched) return;
  const host = transcriptHost;
  if (host === null) return;
  const pane = transcriptPane();
  if (pane === null) return;
  paneWatched = true;
  pane.addEventListener(
    "scroll",
    () => {
      followTail = paneAtTheBottom(pane);
    },
    { passive: true },
  );
  if (typeof ResizeObserver !== "function") return;
  paneResizeObserver = new ResizeObserver(() => {
    if (followTail) pane.scrollTop = pane.scrollHeight;
  });
  paneResizeObserver.observe(host);
  paneResizeObserver.observe(pane);
}

/** Stop watching the pane: a page that goes away leaves no observer behind. */
export function unwatchPane(): void {
  paneResizeObserver?.disconnect();
  paneResizeObserver = null;
  paneWatched = false;
  transcriptHost = null;
  followTail = true;
}

/**
 * Put the viewport where the draw left it.
 *
 * A draw that follows the tail puts the foot on screen. A draw that adds rows above
 * the reader holds their distance from the foot. Every other draw leaves the
 * number alone, which is the row the reader was on.
 */
export function afterDraw(): void {
  const pane = transcriptPane();
  if (pane === null) return;
  if (keepDistanceFromBottom) {
    keepDistanceFromBottom = false;
    pane.scrollTop = restDistance === null ? pane.scrollHeight : pane.scrollHeight - pane.clientHeight - restDistance;
    restDistance = null;
    return;
  }
  if (followTail) pane.scrollTop = pane.scrollHeight;
}

/** Whether a group is open, by key. */
export function isGroupOpen(key: string): boolean {
  return openGroups.value.get(key) === true;
}

/** Remember the operator's choice to open or fold one block. */
export function setGroupOpen(key: string, open: boolean): void {
  const next = new Map(openGroups.value);
  next.set(key, open);
  openGroups.value = next;
}

/** A live entry that heads a context: the page opens a new stream for it. */
export function headsContext(entry: ConversationEntry | null | undefined): boolean {
  return entry !== null && entry !== undefined && typeof entry === "object" && entry.head !== undefined;
}
