import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ROOT_CONVERSATION_ID,
  defineExtension,
  defineTool,
  type ConversationId,
  type Cursor,
  type DocumentReader,
  type EntryRecord,
  type Extension,
  type PromptInput,
  type Storage,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { type Message } from "@earendil-works/pi-ai";
import { parseAsyncOutput } from "../async-output.ts";
import {
  DOC_KINDS,
  SecAgent,
  SecLesson,
  SecLessonCount,
  type LessonCategory,
  type LessonCountRecord,
  type LessonEvidence,
  type LessonOriginKind,
  type LessonPromotionTarget,
  type LessonRecord,
  type LessonSeverity,
  type LessonSource,
  type LessonStatus,
} from "../documents.ts";
import { readMessage } from "../message-envelope.ts";
import { REVIEW_MARKER } from "../review.ts";
import { ulid } from "../runtime/ids.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";
import type { Redactor } from "../secrets/redact.ts";
import { requireHarness, type ExtensionContext } from "./context.ts";
import { resolveWorkspacePath } from "./self-edit.ts";
import { withLocal, zoneIso } from "../time-format.ts";

/**
 * The bundled `lessons` extension: one store of what an agent learned, so the
 * same correction is not paid for twice.
 *
 * Three shapes of entry share the store — a correction the operator made, a
 * mistake the agent found by itself, and a fact verified while running — and they
 * differ only by `category`. What keeps the store from filling with restatements
 * is the fingerprint: the statement is normalized, hashed, and compared before a
 * row is written. A repeat bumps a counter; a near repeat becomes a merge
 * candidate. The store holds identifiers, never conversation text (see
 * `sanitizeLessonWrite`).
 *
 * The extension writes with the calling tool's `api.commit`, so a lesson lands in
 * one transaction with the recurrence it belongs to, and reads through the
 * harness.
 *
 * The prompt section carries the counts and no lesson text. It may not walk the
 * family at render time, because a section re-renders on every request, so the
 * counts live in one singleton document (`sec.lessonCount`) that every write
 * adjusts inside the same commit as the row it counts. The section shows the
 * numbers its session started with: a value that moved mid-session would be a
 * session-prompt change, and the seal reports one of those as a note plus the
 * banner that asks the operator for a new session. Call `lessons_stats` for the
 * live count.
 *
 * Two tools do not record anything themselves. `lessons_scan` reads recent
 * conversations and returns shortened excerpts, which an agent turns into
 * `proposed` rows with the recording tool, and `lessons_import` loads a list or a
 * file in one pass, previewing by default. The scan reads every conversation that
 * holds an entry in its window, merges the candidates by time, and names the one
 * conversation where the entry budget stopped it. Both hold the same rule as the
 * rest of the extension: identifiers and shortened text only, redacted before
 * anything is returned or stored.
 */

/** Statement and note cap. A lesson is one sentence, and a long one is a plan. */
const MAX_STATEMENT = 600;
const MAX_FILE_PATHS = 10;
/** Notes kept per lesson. At the cap the tool refuses a new note rather than dropping an old one. */
const MAX_NOTES = 20;
/** Job or conversation ids kept in `recurrence.seenIn`. The newest are kept. */
const MAX_SEEN_IN = 20;
const LIST_DEFAULT = 30;
const LIST_MAX = 200;
/** How many neighbours a write returns, so the caller can judge a merge itself. */
const SIMILAR_LIMIT = 3;
/** At or above this a restatement counts as a recurrence without being asked. */
const AUTO_RECURRENCE_SIMILARITY = 0.9;
/** Between this and `AUTO_RECURRENCE_SIMILARITY` a new row is written and marked as a duplicate. */
const DUPLICATE_SIMILARITY = 0.6;
/** Shortened statement in `lessons_list`. The full statement is one `lessons_get` away. */
const LIST_STATEMENT_CHARS = 200;

/** Candidates a scan returns without an explicit `limit`. */
const SCAN_DEFAULT_LIMIT = 20;
/** Candidates a scan returns at most, whatever the caller asks for. */
const SCAN_MAX_LIMIT = 50;
/** How far back a scan looks when the caller gives no `since`. */
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One excerpt. The same cap as a statement, for the same reason. */
const MAX_EXCERPT = 600;
/**
 * Entries one scan may read.
 *
 * There is no cap on conversations and none on a conversation's entries, because
 * either cap made the scan lose a conversation it never opened. The cost of one
 * call is bounded here instead: a 14-day window can read more than a hundred thousand entries, so
 * this covers every ordinary window and cuts only a wider one. A call that stops
 * here reports the conversation it stopped in and gives no cursor, because a
 * conversation it never opened can hold a candidate newer than any time bound.
 */
const SCAN_ENTRY_BUDGET = 150000;
/**
 * Page reads between two yields to the event loop.
 *
 * The sqlite driver answers on the calling thread, so an `await` between pages
 * never reaches the loop's timer and I/O phase and a walk would block every other
 * conversation for its whole length. The count is page reads, not entries: most
 * conversations outside the window end after one cheap page.
 */
export const SCAN_YIELD_PAGES = 25;
const SCAN_ENTRY_PAGE = 100;
/** Items one import accepts, and the largest import file it reads. */
const MAX_IMPORT_ITEMS = 200;
const MAX_IMPORT_BYTES = 512 * 1024;

/** Statuses a similarity search treats as live. A closed lesson needs no merge. */
const OPEN_STATUSES: readonly LessonStatus[] = ["proposed", "open"];

/** Every tool this extension offers, for the callers that must reason about the set. */
export const LESSON_TOOL_NAMES: readonly string[] = [
  "lessons_record",
  "lessons_list",
  "lessons_get",
  "lessons_update",
  "lessons_reword",
  "lessons_stats",
  "lessons_scan",
  "lessons_import",
];

// ---------------------------------------------------------------------------
// Normalization, fingerprint, similarity
// ---------------------------------------------------------------------------

/**
 * Korean particles stripped from the end of a token before hashing.
 *
 * "에이전트가 실수를 했다" and "에이전트는 실수를 했다" are the same lesson, and
 * without this they hash differently. A particle is only removed when what
 * remains is still at least two characters, so a word that ends in the same
 * syllable as a particle keeps its shape.
 */
const JOSA: readonly string[] = [
  "으로서",
  "으로써",
  "이야말로",
  "에서는",
  "에게는",
  "라고는",
  "이란",
  "라는",
  "이라는",
  "에서",
  "에게",
  "한테",
  "부터",
  "까지",
  "처럼",
  "보다",
  "마다",
  "조차",
  "밖에",
  "으로",
  "라고",
  "이나",
  "이든",
  "라도",
  "지라도",
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "에",
  "의",
  "도",
  "로",
  "와",
  "과",
  "만",
  "랑",
  "야",
  "여",
];

function stripJosa(token: string): string {
  // A particle standing on its own is spacing, not a word: a model that writes
  // "typecheck 를" and one that writes "typecheck를" mean the same thing.
  if (JOSA.includes(token)) return "";
  for (const josa of JOSA) {
    if (token.length - josa.length >= 2 && token.endsWith(josa)) return token.slice(0, -josa.length);
  }
  return token;
}

/**
 * The comparable form of a statement: one case, one space, no punctuation, no
 * particles. Two statements with the same normalized form are the same lesson.
 */
export function normalizeStatement(text: string): string {
  const folded = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ");
  return folded
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(stripJosa)
    .filter((token) => token.length > 0)
    .join(" ")
    .trim();
}

/** The sha256 of the normalized statement. This is what a repeat is detected by. */
export function fingerprintOf(text: string): string {
  return createHash("sha256").update(normalizeStatement(text), "utf8").digest("hex");
}

/** Character bigrams of a normalized statement. */
function shingles(text: string): Set<string> {
  const value = text.replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (value.length === 1) out.add(value);
  for (let index = 0; index + 2 <= value.length; index += 1) out.add(value.slice(index, index + 2));
  return out;
}

/** Character 2-gram Jaccard similarity of two statements, 0 to 1. */
export function statementSimilarity(left: string, right: string): number {
  const a = shingles(normalizeStatement(left));
  const b = shingles(normalizeStatement(right));
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------------------
// The secret guard
// ---------------------------------------------------------------------------

/**
 * The mark a registered secret leaves behind after redaction.
 *
 * The guard looks for registered secret values and nothing else. The redactor
 * replaces each registered value with a fixed placeholder, so a placeholder in
 * the text is proof that a secret was there, and the write is refused. A value
 * the registry does not know is not guessed from its shape: a commit sha, a
 * sha256, a ULID in a path, `token=abc123`, and the word "api_key" are all
 * stored as written.
 */
const RESIDUE_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "a secret placeholder", re: /⟦secret:[^⟧]*⟧/u },
];

/** Why the text must not be stored, or `undefined` when it may be. */
function residueReason(text: string): string | undefined {
  for (const pattern of RESIDUE_PATTERNS) {
    if (pattern.re.test(text)) return `refused: the text still holds ${pattern.label} after redaction`;
  }
  return undefined;
}

export interface LessonSanitizeInput {
  readonly statement: string;
  readonly filePaths?: readonly string[];
  readonly tags?: readonly string[];
}

export type LessonSanitizeResult =
  | { readonly ok: true; readonly statement: string; readonly filePaths: string[]; readonly tags: string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Redact, then refuse a text that held a registered secret.
 *
 * Every value that would be written goes through here, and the order matters:
 * the redactor runs first, so a registered secret never reaches the store, and
 * the residue check runs second, so a text whose registered value was replaced
 * by a placeholder stops the write instead of being saved with the placeholder.
 * A text that already carries a placeholder is refused the same way. Nothing
 * else is judged: the guard does not guess at unregistered values from their
 * shape. A caller that gets a refusal rewrites the sentence and calls again.
 */
export function sanitizeLessonWrite(input: LessonSanitizeInput, redactor: Redactor): LessonSanitizeResult {
  const statement = redactor.redact(input.statement).trim();
  if (statement.length === 0) return { ok: false, reason: "refused: the statement is empty" };
  if (statement.length > MAX_STATEMENT) {
    return { ok: false, reason: `refused: the statement is ${statement.length} characters, over the ${MAX_STATEMENT} limit` };
  }
  const statementReason = residueReason(statement);
  if (statementReason !== undefined) return { ok: false, reason: statementReason };

  const rawPaths = input.filePaths ?? [];
  if (rawPaths.length > MAX_FILE_PATHS) {
    return { ok: false, reason: `refused: ${rawPaths.length} file paths, over the ${MAX_FILE_PATHS} limit` };
  }
  const filePaths: string[] = [];
  for (const raw of rawPaths) {
    const path = redactor.redact(raw).trim();
    if (path.length === 0) continue;
    const pathReason = residueReason(path);
    if (pathReason !== undefined) return { ok: false, reason: `${pathReason} (file path)` };
    filePaths.push(path);
  }

  const tags: string[] = [];
  for (const raw of input.tags ?? []) {
    const tag = redactor.redact(raw).trim();
    if (tag.length === 0) continue;
    const tagReason = residueReason(tag);
    if (tagReason !== undefined) return { ok: false, reason: `${tagReason} (tag)` };
    tags.push(tag);
  }

  return { ok: true, statement, filePaths, tags };
}

/** Redact and bound one promotion reference (a file path, a commit hash, or a report slug). */
function sanitizeRef(
  text: string,
  redactor: Redactor,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const redacted = redactor.redact(text).trim();
  if (redacted.length === 0) return { ok: false, reason: "refused: promotionRef is empty" };
  const reason = residueReason(redacted);
  if (reason !== undefined) return { ok: false, reason };
  return { ok: true, text: redacted };
}

/** Redact and bound one note body. */
function sanitizeNote(text: string, redactor: Redactor): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const redacted = redactor.redact(text).trim();
  if (redacted.length === 0) return { ok: false, reason: "refused: the note is empty" };
  if (redacted.length > MAX_STATEMENT) {
    return { ok: false, reason: `refused: the note is ${redacted.length} characters, over the ${MAX_STATEMENT} limit` };
  }
  const reason = residueReason(redacted);
  if (reason !== undefined) return { ok: false, reason };
  return { ok: true, text: redacted };
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

/** What the lessons logic needs from the runtime, narrow enough to fake in a test. */
export interface LessonDeps {
  readonly storage: Storage;
  readonly reader: () => DocumentReader;
  readonly redactor: () => Redactor;
  /**
   * Entries one scan may read, in place of `SCAN_ENTRY_BUDGET`.
   *
   * The extension passes nothing, so a live call reads the module constant. A test
   * passes a small number and reaches the cut path with a small fixture, which a
   * fixture of 150,001 entries would not: the counting code is the same for both.
   * The tool does not offer this field to a caller.
   */
  readonly entryBudget?: number;
}

/** The write half of a tool invocation. `ToolExecutionApi` satisfies this. */
export interface LessonWriteApi {
  readonly conversationId: ConversationId;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every lesson in the store, oldest first. */
export async function readLessons(deps: LessonDeps, ctx: Context): Promise<LessonRecord[]> {
  const reader = deps.reader();
  const records: LessonRecord[] = [];
  for (const key of await scanDocumentKeys(deps.storage, DOC_KINDS.lesson, ctx)) {
    const record = await reader.snapshot(SecLesson, key, ctx);
    // A row that was opened but never written has no `createdAt`; it is a
    // placeholder from a transaction, not a lesson.
    if (record !== undefined && record.createdAt !== 0) records.push(plain(record as LessonRecord));
  }
  records.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));
  return records;
}

/** One lesson by id, or `undefined`. */
export async function getLesson(deps: LessonDeps, ctx: Context, id: string): Promise<LessonRecord | undefined> {
  const record = await deps.reader().snapshot(SecLesson, id, ctx);
  if (record === undefined || record.createdAt === 0) return undefined;
  return plain(record as LessonRecord);
}

// ---------------------------------------------------------------------------
// The count the prompt section reads
// ---------------------------------------------------------------------------

/** Zeroed counts, one field per status. */
function zeroStatusCounts(): Record<LessonStatus, number> {
  return { proposed: 0, open: 0, promoted: 0, dormant: 0, closed: 0 };
}

/** True when two status count maps hold the same numbers. */
function sameCounts(
  left: Readonly<Record<LessonStatus, number>>,
  right: Readonly<Record<LessonStatus, number>>,
): boolean {
  return STATUSES.every((status) => left[status] === right[status]);
}

/**
 * The counter document, or `undefined` when it has never been written.
 *
 * A missing counter is not an error. It is what a store that predates the
 * counter looks like, and what a store nothing has written to yet looks like. A
 * reader treats it as zeros and `lessons_stats` reports the disagreement, which
 * is the signal to recount.
 */
async function counterOf(reader: DocumentReader, ctx: Context): Promise<LessonCountRecord | undefined> {
  const stored = await reader.snapshot(SecLessonCount, ctx);
  return stored === undefined ? undefined : (plain(stored) as LessonCountRecord);
}

/** The counts a recount found, for a counter document that has never been written. */
interface CounterSeed {
  readonly total: number;
  readonly byStatus: Record<LessonStatus, number>;
}

/**
 * The numbers an unwritten counter must start from, or `undefined` when the
 * counter already holds a count.
 *
 * A store that predates the counter holds rows and no document, and a section
 * that reads zeros while the store holds lessons is wrong until somebody
 * refreshes. So the first write that meets an unwritten counter counts the family
 * and seeds the document in the commit of its own change.
 *
 * The family cannot be walked inside a transaction, so the count is taken here
 * and applied there, under the guard that the document is still unwritten. The
 * walk happens once per store, not once per call: as soon as any write seeds the
 * document, `updatedAt` stops being 0 and this returns before reading the rows.
 */
async function counterSeed(
  deps: LessonDeps,
  ctx: Context,
  records?: readonly LessonRecord[],
): Promise<CounterSeed | undefined> {
  const counter = await counterOf(deps.reader(), ctx);
  if (counter !== undefined && counter.updatedAt !== 0) return undefined;
  const rows = records ?? (await readLessons(deps, ctx));
  const byStatus = zeroStatusCounts();
  for (const row of rows) byStatus[row.status] += 1;
  return { total: rows.length, byStatus };
}

/**
 * Seed a counter document that has not been written yet, and say whether it was.
 *
 * The guard is the point: the seed was measured before the commit, so a document
 * another writer seeded in the meantime already holds the truth, and overwriting
 * it with an older count would be wrong.
 */
function seedCounter(counter: LessonCountRecord, seed: CounterSeed | undefined): boolean {
  if (seed === undefined || counter.updatedAt !== 0) return false;
  counter.total = seed.total;
  counter.byStatus = { ...seed.byStatus };
  return true;
}

/** The key of the count section, so a reader can find it in a rendered prompt. */
export const LESSON_COUNT_SECTION = "lessons-count";

/**
 * The value this session has already committed, without the tags around it.
 *
 * A section renders on every request, and the seal compares what it renders with
 * the value the session started on. A value that moves, like a counter, is then
 * recorded as a change and reported by `session_stale`, which costs a restart
 * round. The count section is not worth that. Its numbers are a nudge, and the
 * store's live counts are one `lessons_stats` call away.
 *
 * So the render reads the committed value back out of `input.shown`, where the
 * seal keeps it, and returns it unchanged. The tags are the seal's own wrapper,
 * `<key>` then a newline, the text, a newline and `</key>` (see `tagged` in
 * `src/extensions/sections.ts` and the same wrapper in pi-durable's
 * `renderSections`). When the shape is not what this expects the render falls back
 * to the value the counter holds now, which is the behavior it had before this
 * existed: a format change costs notes, never a wrong prompt.
 */
function committedSectionText(input: PromptInput, key: string): string | undefined {
  const shown = input.shown[key];
  if (shown === undefined) return undefined;
  const open = `<${key}>\n`;
  const close = `\n</${key}>`;
  if (!shown.startsWith(open) || !shown.endsWith(close)) return undefined;
  return shown.slice(open.length, shown.length - close.length);
}

/**
 * The counts alone: the open count and the unconfirmed proposal count. Nothing
 * else, and one line, because it renders on every request.
 *
 * A count is shown as it is stored, negative included. A negative number is
 * impossible while every write goes through this extension, so one on screen is
 * the honest signal that the counter and the store disagree; `lessons_stats`
 * names the disagreement and `refresh: true` repairs it.
 */
function lessonCountSummary(counts: LessonCountRecord | undefined): string {
  const open = counts?.byStatus.open ?? 0;
  const proposed = counts?.byStatus.proposed ?? 0;
  return `lessons: ${open} open, ${proposed} proposed.`;
}

/** The counts and the name of the tool that records one, for a conversation that has it. */
export function lessonCountLine(counts: LessonCountRecord | undefined): string {
  return `${lessonCountSummary(counts)} Record one with \`lessons_record\`.`;
}

/** Where the recording agent sits, read from its `sec.agent` row. */
async function originOf(
  deps: LessonDeps,
  conversationId: ConversationId,
  ctx: Context,
): Promise<{ conversationId: string; agentName: string; kind: LessonOriginKind }> {
  const id = String(conversationId);
  const record = await deps.reader().snapshot(SecAgent, id, ctx);
  // No `sec.agent` row means this is the root conversation: the root is created
  // by the chat, not by a spawn, so `agent-profile` falls back to config for it
  // the same way (`src/extensions/agent-profile.ts`).
  const kind: LessonOriginKind =
    record?.kind === "root"
      ? "root"
      : record?.kind === "subagent"
        ? "subagent"
        : record?.kind === "scheduled"
          ? "schedule"
          : conversationId === ROOT_CONVERSATION_ID
            ? "root"
            : "subagent";
  return { conversationId: id, agentName: record?.name === undefined || record.name === "" ? id : record.name, kind };
}

/** One similarity neighbour: enough to rank a merge, not the whole row. */
export interface LessonNeighbour {
  readonly id: string;
  readonly statement: string;
  readonly similarity: number;
  readonly recurrenceCount: number;
}

function rankNeighbours(existing: readonly LessonRecord[], statement: string): LessonNeighbour[] {
  const scored = existing
    .filter((record) => OPEN_STATUSES.includes(record.status))
    .map((record) => ({
      id: record.id,
      statement: record.statement,
      similarity: Number(statementSimilarity(statement, record.statement).toFixed(4)),
      recurrenceCount: record.recurrence.count,
    }));
  scored.sort((a, b) => (b.similarity === a.similarity ? a.id.localeCompare(b.id) : b.similarity - a.similarity));
  return scored.slice(0, SIMILAR_LIMIT);
}

/** The id that says where a recurrence was met again: the job when there is one. */
function seenMarker(id: string | undefined, conversationId: string): string {
  return id !== undefined && id !== "" ? id : conversationId;
}

/**
 * An idempotence test, not a similarity test: the same evidence point has already
 * been counted against this lesson.
 *
 * The key is `(conversationId, entryId, fingerprint)`. The fingerprint is
 * checked by the caller, which is what makes the pair equal here mean "the same
 * statement from the same place". A caller with no entry id matches a stored row
 * with no entry id, which is the honest reading: nothing distinguishes the two.
 */
function fromSameEvidencePoint(record: LessonRecord, conversationId: string, entryId: string | undefined): boolean {
  return (record.evidence.conversationId ?? "") === conversationId && (record.evidence.entryId ?? "") === (entryId ?? "");
}

export type LessonAction = "created" | "recurrence_recorded" | "duplicate_ignored";

export interface LessonRecordOutcome {
  readonly lessonId: string;
  readonly action: LessonAction;
  readonly recurrenceCount: number;
  readonly similar: readonly LessonNeighbour[];
  /** Set when nothing was written: this is what the call would have done. */
  readonly dryRun?: boolean;
}

export type LessonRecordResult =
  | { readonly ok: true; readonly outcome: LessonRecordOutcome }
  | { readonly ok: false; readonly reason: string };

export interface LessonRecordInput {
  readonly statement: string;
  readonly category: LessonCategory;
  readonly severity?: LessonSeverity;
  /** The row's starting status. Default `open`. */
  readonly status?: LessonStatus;
  /** How the lesson entered the store. Default `agent`. */
  readonly source?: LessonSource;
  readonly evidence?: LessonEvidence;
  readonly relation?: "new" | "recurrence";
  readonly duplicateOf?: string;
  readonly promotionTarget?: LessonPromotionTarget;
  /** Evidence that a rule already exists. Required when `status` is `promoted`. */
  readonly promotionRef?: string;
  readonly tags?: readonly string[];
}

export interface LessonRecordOptions {
  /**
   * Decide and report, write nothing. `lessons_import` uses this for its default
   * `dryRun: true`.
   *
   * A dry run cannot know where a new row would land, so the id it reports for a
   * would-be creation is the id it would have used, not a stored one; the outcome
   * carries `dryRun: true` so a caller can tell the two apart.
   */
  readonly dryRun?: boolean;
}

/**
 * Record a lesson, a recurrence of one, or nothing at all.
 *
 * The order of the decisions is fixed: an exact fingerprint first, then a
 * similarity match. An exact match on the same evidence point is a replay and
 * writes nothing; an exact match anywhere else is a recurrence and bumps the
 * counter; a similarity at or above `AUTO_RECURRENCE_SIMILARITY` is also a
 * recurrence; between the two thresholds a new row is written and pointed at its
 * neighbour. `relation: "recurrence"` is the caller overriding all of that — the
 * case where the same lesson is written in different words and the Jaccard score
 * does not see it.
 */
export async function recordLesson(
  deps: LessonDeps,
  api: LessonWriteApi,
  ctx: Context,
  input: LessonRecordInput,
  options: LessonRecordOptions = {},
): Promise<LessonRecordResult> {
  const sanitized = sanitizeLessonWrite(
    { statement: input.statement, filePaths: input.evidence?.filePaths, tags: input.tags },
    deps.redactor(),
  );
  if (!sanitized.ok) return sanitized;

  let promotionRef: string | undefined;
  if (input.promotionRef !== undefined) {
    const ref = sanitizeRef(input.promotionRef, deps.redactor());
    if (!ref.ok) return ref;
    promotionRef = ref.text;
  }
  // The same rule as `lessons_update`, applied here so a bulk import cannot write
  // a promoted row over a rule nobody can check. The recording tool has no
  // `promotionRef` argument, so it is `lessons_update` that promotes.
  if (input.status === "promoted" && promotionRef === undefined) {
    return {
      ok: false,
      reason:
        "refused: status promoted needs promotionRef (a file path, a commit hash, or a report slug); record the lesson as open and promote it with lessons_update, or name promotionRef in the import item",
    };
  }

  const dryRun = options.dryRun === true;
  const conversationId = String(api.conversationId);
  const entryId = input.evidence?.entryId;
  const fingerprint = fingerprintOf(sanitized.statement);
  const existing = await readLessons(deps, ctx);
  const similar = rankNeighbours(existing, sanitized.statement);
  const exact = existing.find((record) => record.fingerprint === fingerprint);
  // A counter that was never written is seeded from the rows just read, so a
  // record on a store that predates the counter fixes the count instead of
  // starting it at one. Reads only, so a dry run pays nothing for it.
  const seed = await counterSeed(deps, ctx, existing);

  const bump = async (target: LessonRecord): Promise<LessonRecordResult> => {
    const now = Date.now();
    const marker = seenMarker(input.evidence?.jobId, conversationId);
    // A recurrence bumps the counter and nothing else. It does not overwrite
    // `source` or `status`. `source` says how the lesson first entered the store,
    // so rewriting it to "scan" because a scan met the same words again would make
    // the row's history false. `status` is a standing decision somebody made: an
    // agent retired the lesson, or a scan left it `proposed` for review. A repeat
    // is new evidence that the lesson happened again, not a fresh judgement of that
    // decision, and letting the caller's default win would silently reopen a closed
    // lesson and turn every later call into a status write.
    if (dryRun) {
      return {
        ok: true,
        outcome: {
          lessonId: target.id,
          action: "recurrence_recorded",
          recurrenceCount: target.recurrence.count + 1,
          similar,
          dryRun: true,
        },
      };
    }
    const updated = await api.commit(async (tx) => {
      const draft = await tx.doc(SecLesson, target.id, target.id);
      if (draft.createdAt === 0) throw new Error(`lesson vanished during the write: ${target.id}`);
      const seenIn = draft.recurrence.seenIn.includes(marker)
        ? [...draft.recurrence.seenIn]
        : [...draft.recurrence.seenIn, marker].slice(-MAX_SEEN_IN);
      draft.recurrence = {
        count: draft.recurrence.count + 1,
        firstSeenAt: draft.recurrence.firstSeenAt === 0 ? now : draft.recurrence.firstSeenAt,
        lastSeenAt: now,
        seenIn,
      };
      draft.updatedAt = now;
      // A recurrence moves no count. It does seed an unwritten counter, which is a
      // count this call established rather than one it changed.
      if (seed !== undefined) {
        const counter = await tx.doc(SecLessonCount);
        if (seedCounter(counter, seed)) counter.updatedAt = now;
      }
      return plain(draft);
    }, ctx);
    return {
      ok: true,
      outcome: { lessonId: updated.id, action: "recurrence_recorded", recurrenceCount: updated.recurrence.count, similar },
    };
  };

  const ignored = (target: LessonRecord): LessonRecordResult => ({
    ok: true,
    outcome: {
      lessonId: target.id,
      action: "duplicate_ignored",
      recurrenceCount: target.recurrence.count,
      similar,
    },
  });

  // The caller's own judgement: this is the lesson `duplicateOf` names, however
  // different the wording. It is an instruction, so it counts even when the same
  // evidence point has been counted before.
  if (input.relation === "recurrence") {
    const targetId = input.duplicateOf ?? exact?.id ?? similar[0]?.id;
    if (targetId === undefined) {
      return { ok: false, reason: "relation recurrence needs duplicateOf or an existing similar lesson" };
    }
    const target = existing.find((record) => record.id === targetId);
    if (target === undefined) return { ok: false, reason: `no lesson ${targetId}` };
    return bump(target);
  }

  if (exact !== undefined) {
    if (fromSameEvidencePoint(exact, conversationId, entryId)) return ignored(exact);
    return bump(exact);
  }

  const nearest = similar[0];
  if (nearest !== undefined && nearest.similarity >= AUTO_RECURRENCE_SIMILARITY) {
    const target = existing.find((record) => record.id === nearest.id);
    if (target !== undefined) {
      if (fromSameEvidencePoint(target, conversationId, entryId)) return ignored(target);
      return bump(target);
    }
  }

  const duplicateOf =
    nearest !== undefined && nearest.similarity >= DUPLICATE_SIMILARITY ? nearest.id : undefined;
  const now = Date.now();
  const id = ulid(now);
  if (dryRun) {
    return {
      ok: true,
      outcome: { lessonId: id, action: "created", recurrenceCount: 1, similar, dryRun: true },
    };
  }
  const origin = await originOf(deps, api.conversationId, ctx);
  const evidence: LessonEvidence = {
    ...(input.evidence?.jobId !== undefined ? { jobId: input.evidence.jobId } : {}),
    conversationId: input.evidence?.conversationId ?? conversationId,
    ...(entryId !== undefined ? { entryId } : {}),
    ...(input.evidence?.reportId !== undefined ? { reportId: input.evidence.reportId } : {}),
    ...(sanitized.filePaths.length > 0 ? { filePaths: sanitized.filePaths } : {}),
  };

  const created = await api.commit(async (tx) => {
    const draft = await tx.doc(SecLesson, id, id);
    draft.id = id;
    draft.statement = sanitized.statement;
    draft.category = input.category;
    draft.status = input.status ?? "open";
    draft.severity = input.severity ?? "normal";
    draft.fingerprint = fingerprint;
    if (duplicateOf !== undefined) draft.duplicateOf = duplicateOf;
    draft.recurrence = {
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      seenIn: [seenMarker(input.evidence?.jobId, conversationId)],
    };
    draft.evidence = evidence;
    draft.origin = origin;
    draft.source = input.source ?? "agent";
    draft.promotionTarget = input.promotionTarget ?? "undecided";
    if (promotionRef !== undefined) draft.promotionRef = promotionRef;
    draft.notes = [];
    draft.tags = [...sanitized.tags];
    draft.createdAt = now;
    draft.updatedAt = now;
    // The count moves in this commit or not at all. A second commit would leave a
    // window in which the process can die with the row written and the count not,
    // and the section would report a number the store does not hold.
    const counter = await tx.doc(SecLessonCount);
    seedCounter(counter, seed);
    counter.total += 1;
    counter.byStatus[draft.status] += 1;
    counter.updatedAt = now;
    return plain(draft);
  }, ctx);

  return {
    ok: true,
    outcome: { lessonId: created.id, action: "created", recurrenceCount: created.recurrence.count, similar },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type LessonOrder = "recurrence" | "recent" | "severity";

export interface LessonListFilter {
  readonly status?: LessonStatus;
  readonly category?: LessonCategory;
  readonly promotionTarget?: LessonPromotionTarget;
  readonly minRecurrence?: number;
  readonly since?: number;
  readonly order?: LessonOrder;
  readonly limit?: number;
}

const SEVERITY_RANK: Record<LessonSeverity, number> = { high: 0, normal: 1, low: 2 };

/** Lessons matching the filter, most interesting first. */
export async function listLessons(deps: LessonDeps, ctx: Context, filter: LessonListFilter = {}): Promise<LessonRecord[]> {
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? LIST_DEFAULT)), LIST_MAX);
  let records = await readLessons(deps, ctx);
  if (filter.status !== undefined) records = records.filter((record) => record.status === filter.status);
  if (filter.category !== undefined) records = records.filter((record) => record.category === filter.category);
  if (filter.promotionTarget !== undefined) {
    records = records.filter((record) => record.promotionTarget === filter.promotionTarget);
  }
  if (filter.minRecurrence !== undefined) {
    const minimum = filter.minRecurrence;
    records = records.filter((record) => record.recurrence.count >= minimum);
  }
  if (filter.since !== undefined) {
    const since = filter.since;
    records = records.filter((record) => record.updatedAt >= since);
  }

  const order: LessonOrder = filter.order ?? "recurrence";
  records.sort((a, b) => {
    if (order === "recurrence") {
      if (a.recurrence.count !== b.recurrence.count) return b.recurrence.count - a.recurrence.count;
      if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    } else if (order === "severity") {
      if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (a.recurrence.count !== b.recurrence.count) return b.recurrence.count - a.recurrence.count;
    }
    return b.updatedAt === a.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt - a.updatedAt;
  });
  return records.slice(0, limit);
}

export interface LessonStats {
  readonly total: number;
  readonly byStatus: Record<LessonStatus, number>;
  readonly byCategory: Record<LessonCategory, number>;
  readonly open: number;
  readonly proposed: number;
  readonly promoted: number;
  readonly recurrenceTotal: number;
  readonly recurring: number;
  readonly unowned: number;
  readonly topRecurring: readonly { readonly id: string; readonly statement: string; readonly count: number }[];
  /**
   * The counter the prompt section reads, or `undefined` when it has never been
   * written. The counts above are the live ones, walked from the family.
   */
  readonly counter: LessonCountRecord | undefined;
  /**
   * True when the counter holds the counts above. An absent counter matches a
   * store with no rows: the section then reads zeros, which is the truth.
   */
  readonly counterMatches: boolean;
}

/** Counts for the operator and for the self-improvement pass. */
export async function lessonStats(deps: LessonDeps, ctx: Context): Promise<LessonStats> {
  const records = await readLessons(deps, ctx);
  const byStatus = zeroStatusCounts();
  const byCategory: Record<LessonCategory, number> = { user_correction: 0, self_found: 0, runtime_observed: 0 };
  let recurrenceTotal = 0;
  for (const record of records) {
    byStatus[record.status] += 1;
    byCategory[record.category] += 1;
    recurrenceTotal += record.recurrence.count;
  }
  const topRecurring = [...records]
    .filter((record) => record.recurrence.count > 1)
    .sort((a, b) => (b.recurrence.count === a.recurrence.count ? a.id.localeCompare(b.id) : b.recurrence.count - a.recurrence.count))
    .slice(0, 5)
    .map((record) => ({ id: record.id, statement: record.statement, count: record.recurrence.count }));
  const counter = await counterOf(deps.reader(), ctx);
  const counterMatches =
    counter === undefined ? records.length === 0 : counter.total === records.length && sameCounts(counter.byStatus, byStatus);
  return {
    total: records.length,
    byStatus,
    byCategory,
    open: byStatus.open,
    proposed: byStatus.proposed,
    promoted: byStatus.promoted,
    recurrenceTotal,
    recurring: records.filter((record) => record.recurrence.count > 1).length,
    unowned: records.filter((record) => record.promotionTarget === "undecided").length,
    topRecurring,
    counter,
    counterMatches,
  };
}

export type LessonCounterRefresh =
  | { readonly ok: true; readonly counter: LessonCountRecord; readonly attempts: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Recount the store and write the counter back.
 *
 * This is the repair path for the two ways the counter can drift: a store that
 * already held lessons when the counter was introduced, and a change made
 * outside the tool paths. A write seeds a counter that was never written on its
 * own (`counterSeed`); this is the path for a counter that exists and is wrong.
 * The write is guarded, because the recount is a read
 * followed by a write. Every write that changes a count also writes this document
 * in its own commit, so a counter that moved between the two means a lesson was
 * written in between and the recounted numbers are already stale; the attempt is
 * then dropped and the loop recounts. A few attempts cover the race a single
 * owner can meet, and a caller that still loses returns an honest failure rather
 * than a wrong count.
 *
 * The write touches the counter alone. It never rewrites a lesson.
 */
export async function refreshLessonCounter(
  deps: LessonDeps,
  api: LessonWriteApi,
  ctx: Context,
  options: { readonly attempts?: number } = {},
): Promise<LessonCounterRefresh> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await counterOf(deps.reader(), ctx);
    const records = await readLessons(deps, ctx);
    const byStatus = zeroStatusCounts();
    for (const record of records) byStatus[record.status] += 1;
    const now = Date.now();
    const written = await api.commit(async (tx) => {
      const draft = await tx.doc(SecLessonCount);
      const untouched =
        before === undefined
          ? draft.updatedAt === 0 && draft.total === 0 && sameCounts(draft.byStatus, zeroStatusCounts())
          : draft.updatedAt === before.updatedAt && draft.total === before.total && sameCounts(draft.byStatus, before.byStatus);
      if (!untouched) return undefined;
      draft.total = records.length;
      draft.byStatus = byStatus;
      draft.updatedAt = now;
      return plain(draft) as LessonCountRecord;
    }, ctx);
    if (written !== undefined) return { ok: true, counter: written, attempts: attempt };
  }
  return {
    ok: false,
    reason: `the lesson store changed while the counter was recounted (${attempts} attempts); call lessons_stats with refresh again`,
  };
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

export interface LessonUpdateInput {
  readonly id: string;
  readonly status?: LessonStatus;
  readonly promotionTarget?: LessonPromotionTarget;
  readonly promotionRef?: string;
  readonly note?: string;
  readonly severity?: LessonSeverity;
}

export type LessonUpdateResult =
  | { readonly ok: true; readonly lesson: LessonRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Change a lesson's standing, or add a note.
 *
 * `status: "promoted"` is refused without a `promotionRef`, which is the whole
 * point of the field: a rule claims a reason, and the reason is a file, a commit,
 * or a report. A claim with no evidence is a claim nobody can check.
 */
export async function updateLesson(
  deps: LessonDeps,
  api: LessonWriteApi,
  ctx: Context,
  input: LessonUpdateInput,
): Promise<LessonUpdateResult> {
  const current = await getLesson(deps, ctx, input.id);
  if (current === undefined) return { ok: false, reason: `no lesson ${input.id}` };

  const nextRef = input.promotionRef ?? current.promotionRef;
  if (input.status === "promoted" && (nextRef === undefined || nextRef.trim() === "")) {
    return {
      ok: false,
      reason: "refused: status promoted needs promotionRef (a file path, a commit hash, or a report slug)",
    };
  }
  let promotionRef: string | undefined;
  if (input.promotionRef !== undefined) {
    const ref = sanitizeRef(input.promotionRef, deps.redactor());
    if (!ref.ok) return ref;
    promotionRef = ref.text;
  }

  let note: string | undefined;
  if (input.note !== undefined) {
    if (current.notes.length >= MAX_NOTES) {
      return { ok: false, reason: `refused: the lesson already holds ${MAX_NOTES} notes` };
    }
    const sanitized = sanitizeNote(input.note, deps.redactor());
    if (!sanitized.ok) return sanitized;
    note = sanitized.text;
  }

  const by = (await originOf(deps, api.conversationId, ctx)).agentName;
  const now = Date.now();
  // Seeded before the commit, applied inside it: see `counterSeed`.
  const seed = await counterSeed(deps, ctx);
  const updated = await api.commit(async (tx) => {
    const draft = await tx.doc(SecLesson, input.id, input.id);
    if (draft.createdAt === 0) throw new Error(`lesson vanished during the write: ${input.id}`);
    // The status this row leaves is read inside the commit, not from the read the
    // checks above used. Two status changes racing on one row would otherwise
    // both subtract the status they each saw and drive the counter negative.
    const from = draft.status;
    if (input.status !== undefined) draft.status = input.status;
    if (input.promotionTarget !== undefined) draft.promotionTarget = input.promotionTarget;
    if (promotionRef !== undefined) draft.promotionRef = promotionRef;
    if (input.severity !== undefined) draft.severity = input.severity;
    if (note !== undefined) draft.notes = [...draft.notes, { at: now, by, text: note }];
    draft.updatedAt = now;
    // A status move is the only edit that changes the counts, and it does so in
    // the same commit as the row. Editing the target, the reference, the severity,
    // or the notes leaves the counts alone.
    if (input.status !== undefined && input.status !== from) {
      const counter = await tx.doc(SecLessonCount);
      seedCounter(counter, seed);
      counter.byStatus[from] -= 1;
      counter.byStatus[input.status] += 1;
      counter.updatedAt = now;
    } else if (seed !== undefined) {
      // No count moved, but an unwritten counter is still established here: the
      // section reads it, and the section does not write.
      const counter = await tx.doc(SecLessonCount);
      if (seedCounter(counter, seed)) counter.updatedAt = now;
    }
    return plain(draft);
  }, ctx);

  return { ok: true, lesson: updated };
}

// ---------------------------------------------------------------------------
// Rewording
// ---------------------------------------------------------------------------

export interface LessonRewordInput {
  readonly id: string;
  readonly statement: string;
  /** Why the wording changed. Kept in the lesson's notes when given. */
  readonly note?: string;
}

/** `reworded` wrote the new sentence; `unchanged` found it already stored. */
export type LessonRewordAction = "reworded" | "unchanged";

export interface LessonRewordOutcome {
  readonly lessonId: string;
  readonly action: LessonRewordAction;
  readonly previousStatement: string;
  readonly lesson: LessonRecord;
  /** What the new sentence now resembles, best first, so a caller can judge it. */
  readonly similar: readonly LessonNeighbour[];
}

export type LessonRewordResult =
  | { readonly ok: true; readonly outcome: LessonRewordOutcome }
  | { readonly ok: false; readonly reason: string };

/**
 * Replace a stored lesson's sentence, and nothing else.
 *
 * The row is the lesson: its id, recurrence count, evidence, notes, origin, and
 * promotion claim stay where they are, and only the wording moves. So a lesson
 * written with a bad sentence is repaired in place instead of being retired and
 * recorded again, which would split its recurrence history and leave the bad
 * sentence in the store for `lessons_list` to keep returning.
 *
 * The fingerprint is recomputed from the new sentence, and that is the part with
 * consequences: the fingerprint is how a repeat is recognised, so a later
 * `lessons_record` with the new wording folds into this row, and the old wording
 * stops matching it. Three gates follow from that.
 *
 * 1. The new sentence goes through the same secret gate as a recording. An empty
 *    sentence, one over `MAX_STATEMENT`, or one that still holds a secret after
 *    redaction is refused.
 * 2. A sentence whose normalized form is already stored in another row is
 *    refused, because two rows with one fingerprint make a repeat ambiguous:
 *    `recordLesson` matches the first row it finds. The reply of a refusal names
 *    the other lesson, and `lessons_record` with `relation: "recurrence"` is the
 *    path that counts the repeat against the existing row.
 * 3. A rewrite that leaves another row merely similar rather than identical is
 *    allowed and reported. `duplicateOf` is not rewritten: it records why the row
 *    was written, and this tool's work is the sentence.
 *
 * No count moves, because a sentence is not counted. Both guards are reads taken
 * before the commit, so two rewrites racing on one store can still pass the
 * second gate together; `recordLesson` tolerates that by matching the first row,
 * and the store has one writer per tool call.
 */
export async function rewordLesson(
  deps: LessonDeps,
  api: LessonWriteApi,
  ctx: Context,
  input: LessonRewordInput,
): Promise<LessonRewordResult> {
  const current = await getLesson(deps, ctx, input.id);
  if (current === undefined) return { ok: false, reason: `no lesson ${input.id}` };

  const sanitized = sanitizeLessonWrite({ statement: input.statement }, deps.redactor());
  if (!sanitized.ok) return sanitized;

  let note: string | undefined;
  if (input.note !== undefined) {
    if (current.notes.length >= MAX_NOTES) {
      return { ok: false, reason: `refused: the lesson already holds ${MAX_NOTES} notes` };
    }
    const clean = sanitizeNote(input.note, deps.redactor());
    if (!clean.ok) return clean;
    note = clean.text;
  }

  const fingerprint = fingerprintOf(sanitized.statement);
  const existing = await readLessons(deps, ctx);
  const similar = rankNeighbours(
    existing.filter((record) => record.id !== current.id),
    sanitized.statement,
  );

  // The sentence is already there. The reply says so rather than writing an
  // `updatedAt` that reports a change nobody made.
  if (sanitized.statement === current.statement) {
    return {
      ok: true,
      outcome: {
        lessonId: current.id,
        action: "unchanged",
        previousStatement: current.statement,
        lesson: current,
        similar,
      },
    };
  }

  const twin = existing.find((record) => record.id !== current.id && record.fingerprint === fingerprint);
  if (twin !== undefined) {
    return {
      ok: false,
      reason: `refused: the lesson ${twin.id} already holds that statement; record a recurrence against ${twin.id} with lessons_record (relation "recurrence"), or reword this lesson to different words`,
    };
  }

  const by = note === undefined ? "" : (await originOf(deps, api.conversationId, ctx)).agentName;
  const now = Date.now();
  // Seeded before the commit, applied inside it: see `counterSeed`. A sentence is
  // not counted, so the counter is established here and never moved.
  const seed = await counterSeed(deps, ctx);
  const updated = await api.commit(async (tx) => {
    const draft = await tx.doc(SecLesson, current.id, current.id);
    if (draft.createdAt === 0) throw new Error(`lesson vanished during the write: ${current.id}`);
    // The sentence and its fingerprint move together. A row that kept the old
    // fingerprint would answer a repeat with words nobody writes any more.
    draft.statement = sanitized.statement;
    draft.fingerprint = fingerprint;
    if (note !== undefined) draft.notes = [...draft.notes, { at: now, by, text: note }];
    draft.updatedAt = now;
    if (seed !== undefined) {
      const counter = await tx.doc(SecLessonCount);
      if (seedCounter(counter, seed)) counter.updatedAt = now;
    }
    return plain(draft);
  }, ctx);

  return {
    ok: true,
    outcome: {
      lessonId: updated.id,
      action: "reworded",
      previousStatement: current.statement,
      lesson: updated,
      similar,
    },
  };
}

// ---------------------------------------------------------------------------
// Scanning recent conversations
// ---------------------------------------------------------------------------

/** One candidate the scan offers. Nothing is stored until an agent records it. */
export type LessonScanKind = "review" | "failed_tool";

/** The kinds a scan can return. */
const LESSON_SCAN_KINDS: readonly LessonScanKind[] = ["review", "failed_tool"];

export interface LessonScanCandidate {
  readonly conversationId: string;
  readonly entryId: string;
  /**
   * `review` is a message carrying one of the caller's markers, by default an
   * operator note from the report viewer. `failed_tool` is a tool call that
   * failed, with the exchange that followed it.
   */
  readonly kind: LessonScanKind;
  /** When the entry was written, in epoch milliseconds. 0 when it carries no time. */
  readonly at: number;
  /** At most `MAX_EXCERPT` characters, after redaction. */
  readonly excerpt: string;
}

/** How many candidates of each kind the page holds. */
export interface LessonScanCounts {
  readonly review: number;
  readonly failed_tool: number;
}

export interface LessonScanInput {
  readonly since?: number;
  /** Exclusive upper bound on the candidate time: the previous page's `nextBefore`. */
  readonly before?: number;
  readonly limit?: number;
  readonly markers?: readonly string[];
  /** Which kinds to collect. Both when the argument is absent or empty. */
  readonly kinds?: readonly LessonScanKind[];
}

/** The conversation the entry budget stopped the call in, and where it stopped. */
export interface LessonScanWindowCut {
  readonly conversationId: string;
  /** The time of the oldest entry the call read in that conversation, in epoch milliseconds. */
  readonly at: number;
}

export interface LessonScanResult {
  readonly since: number;
  /** Echoed when the caller gave one. */
  readonly before?: number;
  readonly candidates: readonly LessonScanCandidate[];
  /** The page, per kind, so a caller sees which kind filled it. */
  readonly counts: LessonScanCounts;
  /**
   * The bound for the next page: the oldest time on this page, exclusive. Absent
   * when no candidate on the page carries a time, and absent when the entry
   * budget stopped the call, because a conversation it never opened can hold a
   * candidate newer than any time bound. Pass it as `before` to read on.
   */
  readonly nextBefore?: number;
  /**
   * The conversation the entry budget stopped the call in, with the time of the
   * oldest entry it read there. Absent unless the budget stopped the call.
   */
  readonly windowsCut?: readonly LessonScanWindowCut[];
  /**
   * The conversations in which the call found at least one entry inside the
   * window: at or after `since`, and below `before` when one was given.
   */
  readonly conversationsExamined: number;
  /** The conversations the call never opened, because the entry budget stopped it. */
  readonly conversationsUnread: number;
  /** True when the page was cut at `limit`, or when the entry budget stopped the call. */
  readonly truncated: boolean;
}

/** The text one message contributes, flattened. Images contribute nothing. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function messageText(message: Message): string {
  switch (message.role) {
    case "user":
    case "system":
    case "assistant":
    case "toolResult":
      return contentText(message.content);
    default:
      return "";
  }
}

function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .map(messageText)
    .filter((text) => text.trim() !== "")
    .join("\n");
}

/**
 * The text a reader should see for one entry: the original text, with the
 * source envelope removed when the entry carries one (`src/message-envelope.ts`).
 *
 * The envelope is a label on the first line, not part of the message, so an
 * excerpt that keeps it shows the reader markup instead of what was said. Text
 * written before the envelope is returned unchanged.
 */
function plainText(entry: EntryRecord): string {
  const text = entryText(entry);
  return readMessage(text)?.body ?? text;
}

/**
 * The text of a review entry, without its marker line.
 *
 * A note written now is wrapped around the marker line, so the line survives
 * into the envelope's body: `readMessage` drops the envelope and not the label
 * inside it (`src/review.ts`). That line names the report and the version and
 * carries no message, so the excerpt drops it — the same line `readMessage`
 * already drops from the older, unwrapped form. Detection is not affected:
 * `isReviewEntry` reads the marker wherever it sits.
 */
function reviewText(entry: EntryRecord, markers: readonly string[]): string {
  const text = plainText(entry);
  const trimmed = text.trimStart();
  for (const marker of markers) {
    if (!trimmed.startsWith(marker)) continue;
    const newline = trimmed.indexOf("\n");
    return newline === -1 ? "" : trimmed.slice(newline + 1).replace(/^\n+/, "");
  }
  return text;
}

/**
 * Whether a user-role entry is one of the caller's review notes.
 *
 * The marker used to be the first line of the entry, which is why `markers` is
 * a list of strings a message starts with. A note written now is wrapped in an
 * envelope and the marker line sits inside it, so the marker is looked for in
 * the raw text first (the older form and a wrapped one both keep it) and then in
 * the unwrapped body. Looking only at the first line of the raw text finds
 * nothing, and nothing is the silent answer this rule exists to avoid.
 */
function isReviewEntry(text: string, markers: readonly string[]): boolean {
  const body = readMessage(text)?.body;
  return markers.some(
    (marker) => text.trimStart().startsWith(marker) || (body !== undefined && body.trimStart().startsWith(marker)),
  );
}

/**
 * When an entry was written: the newest timestamp among its messages.
 *
 * Entries carry no timestamp of their own, and an entry with no messages (a
 * bookmark or a section update) has none here either. `undefined` means "cannot
 * tell", and the scan keeps such an entry rather than guessing that it is old.
 */
function entryAt(entry: EntryRecord): number | undefined {
  const stamps = (entry.model ?? []).map((message) => message.timestamp).filter((at) => Number.isFinite(at) && at > 0);
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

function isFailedToolResult(entry: EntryRecord): boolean {
  if (entry.kind !== "pi.tool-result") return false;
  return (entry.model ?? []).some((message) => message.role === "toolResult" && message.isError === true);
}

function toolResultName(entry: EntryRecord): string {
  for (const message of entry.model ?? []) {
    if (message.role === "toolResult") return message.toolName;
  }
  return "tool";
}

/**
 * One excerpt: shortened, then redacted, then cut again.
 *
 * The second cut is what holds the cap. A redaction dummy can be longer than the
 * value it replaced, so shortening once is not enough. Cutting a dummy in half
 * reveals nothing about the value it stood for.
 */
function excerptOf(text: string, redactor: Redactor): string {
  const redacted = redactor.redact(text.trim().slice(0, MAX_EXCERPT));
  return redacted.length > MAX_EXCERPT ? redacted.slice(0, MAX_EXCERPT) : redacted;
}

/**
 * The counters one call carries from the conversation listing into the walk.
 *
 * `remaining` is the entry budget left. It counts every entry the call reads,
 * including one above `before` that the walk reads only to learn its time, so the
 * cost of a call has one number whatever the store holds.
 */
interface ScanWalk {
  remaining: number;
  pages: number;
  spent: boolean;
}

/**
 * Give the event loop its timer and I/O phase back after a few page reads.
 *
 * `Storage.scanEntries` is `async`, but the driver behind it is `node:sqlite`'s
 * `DatabaseSync`: it answers on the calling thread and hands back an already
 * settled promise, so an `await` between two pages drains microtasks and never
 * reaches the loop's later phases. The daemon serves every conversation from that
 * one thread, so the walk has to yield by hand. See
 * `SCAN_YIELD_PAGES` for why the count is page reads.
 */
async function yieldToLoop(walk: ScanWalk): Promise<void> {
  walk.pages += 1;
  if (walk.pages % SCAN_YIELD_PAGES !== 0) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Every conversation in the store, newest first.
 *
 * There is no cap. A conversation record carries no time, so descending id order
 * is the only order there is, and the merge by time makes the walk order
 * irrelevant to the answer. The root chat is not placed first: it was placed there
 * to survive a cap that no longer exists, and a first slot is exactly what made a
 * page hold the root's candidates instead of the window's newest ones.
 */
async function conversationIds(deps: LessonDeps, ctx: Context, walk: ScanWalk): Promise<ConversationId[]> {
  const ids: ConversationId[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await deps.storage.scanConversations({ order: "descending" }, 200, cursor, ctx);
    await yieldToLoop(walk);
    for (const record of page.items) ids.push(record.id);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return ids;
}

/**
 * The entries of one conversation that fall inside the window, oldest first.
 *
 * The walk runs newest first and stops at `since`, when the conversation ends, or
 * when the entry budget runs out. There is no per-conversation cap: a cap was one
 * of the two ways a conversation's candidates were lost. `stopped` says the
 * budget ended the read here, and the caller reports the cut.
 */
async function conversationWindow(
  deps: LessonDeps,
  ctx: Context,
  conversationId: ConversationId,
  since: number,
  before: number | undefined,
  walk: ScanWalk,
): Promise<{ readonly entries: readonly EntryRecord[]; readonly stopped: boolean }> {
  const collected: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  let stopped = false;
  for (;;) {
    const page = await deps.storage.scanEntries(
      { conversationId, order: "descending" },
      SCAN_ENTRY_PAGE,
      cursor,
      ctx,
    );
    await yieldToLoop(walk);
    let reachedSince = false;
    for (const entry of page.items) {
      // The budget is checked before an entry is read, so a call reads exactly as
      // many entries as its budget allows and no more.
      if (walk.remaining <= 0) {
        walk.spent = true;
        stopped = true;
        break;
      }
      walk.remaining -= 1;
      const at = entryAt(entry);
      if (at !== undefined && at < since) {
        reachedSince = true;
        break;
      }
      // The bound is exclusive, so the entry the previous page ended on stays
      // there. An entry with no time of its own cannot be placed either side of
      // the bound and is kept.
      if (at !== undefined && before !== undefined && at >= before) continue;
      collected.push(entry);
    }
    if (stopped || reachedSince || page.next === undefined) break;
    cursor = page.next;
  }
  return { entries: [...collected].reverse(), stopped };
}

/**
 * The oldest time among `entries`, or `undefined` when none of them carries one.
 *
 * An entry with no time of its own cannot mark a place in the walk, so it is
 * passed over: a bound built from it would move the next page nowhere.
 */
function oldestTime(entries: readonly EntryRecord[]): number | undefined {
  let oldest: number | undefined;
  for (const entry of entries) {
    const at = entryAt(entry);
    if (at === undefined) continue;
    if (oldest === undefined || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * The candidates one conversation's window holds, newest first.
 *
 * The window is walked oldest first, because the pairing reads the next entry:
 * the assistant turn that reacts to a failure comes after it. The result is
 * reversed at the end. Newest first is what makes `before`/`nextBefore` paginate:
 * a page holds the newest candidates of the merged window, `nextBefore` is the
 * oldest time on it, and the next page is everything older.
 *
 * Kinds this caller did not ask for are skipped here rather than at the end, so
 * the page holds the requested kinds only and the cursor describes them.
 */
function candidatesOfWindow(
  entries: readonly EntryRecord[],
  conversationId: string,
  markers: readonly string[],
  kinds: readonly LessonScanKind[],
  redactor: Redactor,
): LessonScanCandidate[] {
  const wantReview = kinds.includes("review");
  const wantFailedTool = kinds.includes("failed_tool");
  const out: LessonScanCandidate[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const at = entryAt(entry) ?? 0;
    const text = entryText(entry);

    if (entry.kind === "pi.user") {
      if (wantReview && isReviewEntry(text, markers)) {
        out.push({
          conversationId,
          entryId: String(entry.id),
          kind: "review",
          at,
          excerpt: excerptOf(reviewText(entry, markers), redactor),
        });
        continue;
      }
      // A background call's result arrives as a user message carrying the async
      // envelope, and only `failed` counts: `cancelled` is the caller's own
      // cancellation and `interrupted` comes from a daemon restart, so neither is
      // a tool that failed (`parseAsyncOutput` owns both stored shapes).
      const background = wantFailedTool ? parseAsyncOutput(text) : undefined;
      if (background !== undefined && background.status === "failed") {
        const body = `background call ${background.title} (${background.tool}) failed: ${background.body}`;
        out.push({ conversationId, entryId: String(entry.id), kind: "failed_tool", at, excerpt: excerptOf(body, redactor) });
      }
      continue;
    }
    if (!wantFailedTool || !isFailedToolResult(entry)) continue;

    // "The exchange right after the failure": the assistant turn that reacts to
    // it, when the next entry is one. A later operator message is a new exchange,
    // not part of this one, so the pairing stops at the immediate next entry.
    const next = entries[index + 1];
    const reply = next !== undefined && next.kind === "pi.assistant" ? entryText(next).trim() : "";
    const body = `tool ${toolResultName(entry)} failed: ${text}`;
    const raw = reply === "" ? body : `${body}\nnext: ${reply}`;
    out.push({ conversationId, entryId: String(entry.id), kind: "failed_tool", at, excerpt: excerptOf(raw, redactor) });
  }
  return out.reverse();
}

/** The kinds to collect: the caller's list, or both when none was given. */
function scanKinds(kinds: readonly LessonScanKind[] | undefined): readonly LessonScanKind[] {
  if (kinds === undefined || kinds.length === 0) return LESSON_SCAN_KINDS;
  return LESSON_SCAN_KINDS.filter((kind) => kinds.includes(kind));
}

/** How many candidates of each kind a page holds. */
function countKinds(candidates: readonly LessonScanCandidate[]): LessonScanCounts {
  let review = 0;
  let failedTool = 0;
  for (const candidate of candidates) {
    if (candidate.kind === "review") review += 1;
    else failedTool += 1;
  }
  return { review, failed_tool: failedTool };
}

/**
 * The cursor for the next page: the oldest time on this one.
 *
 * A candidate that carries no time is passed over, because it cannot place
 * itself relative to a time bound. `undefined` means there is no page to read on
 * to from the candidates alone, either because this page is empty or because no
 * candidate can move the cursor.
 */
function pageCursor(candidates: readonly LessonScanCandidate[]): number | undefined {
  let oldest: number | undefined;
  for (const candidate of candidates) {
    if (candidate.at <= 0) continue;
    if (oldest === undefined || candidate.at < oldest) oldest = candidate.at;
  }
  return oldest;
}

/**
 * The order of two candidates: newest first, and the newer entry id first on a tie.
 *
 * The tie rule is what makes two calls on the same store return the same order.
 */
function compareCandidates(left: LessonScanCandidate, right: LessonScanCandidate): number {
  if (left.at !== right.at) return right.at - left.at;
  return compareEntryIds(left.entryId, right.entryId);
}

/** Entry ids come from one counter, so a numeric compare keeps entry 9 below entry 10. */
function compareEntryIds(left: string, right: string): number {
  if (/^[0-9]+$/.test(left) && /^[0-9]+$/.test(right)) return Number(right) - Number(left);
  return right.localeCompare(left);
}

/**
 * The page one call returns: every candidate of the window, newest first, cut at
 * `limit`, with the millisecond at the cut kept whole.
 *
 * The bound of the next page is one time and it is exclusive, so a candidate that
 * shares the boundary millisecond with the last candidate on the page would be
 * lost between two pages if it went to the next one. The page therefore takes
 * every candidate at the bound, and can hold more than `limit`. `cut` says the
 * page stopped at `limit` and candidates remain below it.
 */
export function scanPage(
  candidates: readonly LessonScanCandidate[],
  limit: number,
): { readonly candidates: LessonScanCandidate[]; readonly cut: boolean } {
  const sorted = [...candidates].sort(compareCandidates);
  if (sorted.length <= limit) return { candidates: sorted, cut: false };
  const boundary = sorted[limit - 1]?.at ?? 0;
  let end = limit;
  while (end < sorted.length && sorted[end]?.at === boundary) end += 1;
  return { candidates: sorted.slice(0, end), cut: true };
}

/**
 * Collect candidate excerpts from recent conversations. Read-only.
 *
 * What it returns is only what a marker or a failure points at, shortened and
 * redacted. It never returns a conversation, and it never writes: an agent reads
 * the candidates and decides which of them is a lesson.
 *
 * The page is the newest candidates of the whole window. Every conversation that
 * holds an entry in it is read, the candidates are merged by time, and the page is
 * cut at the caller's `limit`. `before` is the exclusive upper bound on a
 * candidate's time and `nextBefore` is the oldest time on the page, which the next
 * call passes back, so a caller reads on without a cursor of its own.
 *
 * One call reads at most `SCAN_ENTRY_BUDGET` entries. When the budget runs out the
 * reply names the conversation it stopped in in `windowsCut`, counts the rest in
 * `conversationsUnread`, and gives no `nextBefore`: a conversation it never opened
 * can hold a candidate newer than any time bound, so a bound would either skip
 * that candidate or make no progress. The caller raises `since` instead.
 */
export async function scanLessons(deps: LessonDeps, ctx: Context, input: LessonScanInput = {}): Promise<LessonScanResult> {
  const since = input.since ?? Date.now() - SCAN_WINDOW_MS;
  const before =
    input.before !== undefined && Number.isFinite(input.before) ? Math.trunc(input.before) : undefined;
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? SCAN_DEFAULT_LIMIT)), SCAN_MAX_LIMIT);
  const markers = (input.markers ?? [REVIEW_MARKER]).filter((marker) => marker.trim() !== "");
  if (markers.length === 0) markers.push(REVIEW_MARKER);
  const kinds = scanKinds(input.kinds);
  const redactor = deps.redactor();
  const budget = Math.max(0, Math.trunc(deps.entryBudget ?? SCAN_ENTRY_BUDGET));

  const walk: ScanWalk = { remaining: budget, pages: 0, spent: false };
  const ids = await conversationIds(deps, ctx, walk);
  const candidates: LessonScanCandidate[] = [];
  let examined = 0;
  let unread = 0;
  let cut: LessonScanWindowCut | undefined;

  for (const [index, conversationId] of ids.entries()) {
    if (walk.remaining <= 0) {
      // The budget ended after the previous conversation. That conversation is
      // where the call stopped, and every conversation from here is unread.
      walk.spent = true;
      unread = ids.length - index;
      break;
    }
    const window = await conversationWindow(deps, ctx, conversationId, since, before, walk);
    // `conversationsExamined` counts a conversation that holds an entry inside
    // the window, which is what the field's name says. An entry above `before` was
    // read only to learn its time, so it does not count.
    if (window.entries.length > 0) examined += 1;
    candidates.push(...candidatesOfWindow(window.entries, String(conversationId), markers, kinds, redactor));
    const oldest = oldestTime(window.entries);
    if (oldest !== undefined) cut = { conversationId: String(conversationId), at: oldest };
    if (window.stopped) {
      unread = ids.length - (index + 1);
      break;
    }
  }

  const page = scanPage(candidates, limit);
  const nextBefore = walk.spent ? undefined : pageCursor(page.candidates);
  return {
    since,
    ...(before !== undefined ? { before } : {}),
    candidates: page.candidates,
    counts: countKinds(page.candidates),
    ...(nextBefore !== undefined ? { nextBefore } : {}),
    ...(walk.spent && cut !== undefined ? { windowsCut: [cut] } : {}),
    conversationsExamined: examined,
    conversationsUnread: unread,
    truncated: page.cut || walk.spent,
  };
}

// ---------------------------------------------------------------------------
// Importing a list
// ---------------------------------------------------------------------------

/** The status, category, severity, source, and target values an item may carry. */
const CATEGORIES: readonly LessonCategory[] = ["user_correction", "self_found", "runtime_observed"];
const STATUSES: readonly LessonStatus[] = ["proposed", "open", "promoted", "dormant", "closed"];
const SEVERITIES: readonly LessonSeverity[] = ["high", "normal", "low"];
const SOURCES: readonly LessonSource[] = ["agent", "scan", "seed"];
const TARGETS: readonly LessonPromotionTarget[] = ["prompt", "memory", "code", "ops", "undecided"];
/** The fields an import item may carry, refused by name when one is unknown. */
const IMPORT_ITEM_FIELDS: readonly string[] = [
  "statement",
  "category",
  "severity",
  "status",
  "source",
  "promotionTarget",
  "promotionRef",
  "evidence",
  "tags",
];
const IMPORT_EVIDENCE_FIELDS: readonly string[] = ["jobId", "conversationId", "entryId", "reportId", "filePaths"];

export interface LessonImportItem {
  readonly statement: string;
  readonly category: LessonCategory;
  readonly severity?: LessonSeverity;
  readonly status?: LessonStatus;
  readonly source?: LessonSource;
  readonly promotionTarget?: LessonPromotionTarget;
  readonly promotionRef?: string;
  readonly evidence?: LessonEvidence;
  readonly tags?: readonly string[];
}

/** What became of one imported item. */
export type LessonImportOutcome = "created" | "recurrence_recorded" | "duplicate_ignored" | "refused";

export interface LessonImportItemResult {
  readonly index: number;
  /** The statement, shortened, so a summary names the item.
   * Empty when the item was refused before its statement could be read. */
  readonly statement: string;
  readonly outcome: LessonImportOutcome;
  readonly reason?: string;
  readonly lessonId?: string;
  readonly recurrenceCount?: number;
}

export interface LessonImportTotals {
  readonly total: number;
  readonly created: number;
  readonly recurrenceRecorded: number;
  readonly duplicateIgnored: number;
  readonly refused: number;
}

export interface LessonImportSummary {
  readonly ok: true;
  /** True when nothing was written. */
  readonly dryRun: boolean;
  readonly items: readonly LessonImportItemResult[];
  readonly totals: LessonImportTotals;
}

export type LessonImportResult = LessonImportSummary | { readonly ok: false; readonly reason: string };

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): { readonly ok: true; readonly value: T | undefined } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return { ok: false, reason: `refused: ${field} "${String(value)}" is not one of ${allowed.join(", ")}` };
  }
  return { ok: true, value: value as T };
}

function optionalText(value: unknown, field: string): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, reason: `refused: ${field} is not a string` };
  return { ok: true, value };
}

/** Unknown keys are refused rather than dropped: a mistyped field must not vanish. */
function unknownField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function parseImportEvidence(raw: unknown): { readonly ok: true; readonly evidence?: LessonEvidence } | { readonly ok: false; readonly reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "refused: evidence is not an object" };
  const value = raw as Record<string, unknown>;
  const extra = unknownField(value, IMPORT_EVIDENCE_FIELDS);
  if (extra !== undefined) return { ok: false, reason: `refused: evidence has an unknown field "${extra}"` };

  const text: Record<string, string | undefined> = {};
  for (const field of ["jobId", "conversationId", "entryId", "reportId"]) {
    const parsed = optionalText(value[field], `evidence.${field}`);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) text[field] = parsed.value;
  }
  let filePaths: string[] | undefined;
  const rawPaths = value["filePaths"];
  if (rawPaths !== undefined && rawPaths !== null) {
    if (!Array.isArray(rawPaths) || rawPaths.some((path) => typeof path !== "string")) {
      return { ok: false, reason: "refused: evidence.filePaths is not an array of strings" };
    }
    filePaths = rawPaths as string[];
  }
  return {
    ok: true,
    evidence: {
      ...(text["jobId"] !== undefined ? { jobId: text["jobId"] } : {}),
      ...(text["conversationId"] !== undefined ? { conversationId: text["conversationId"] } : {}),
      ...(text["entryId"] !== undefined ? { entryId: text["entryId"] } : {}),
      ...(text["reportId"] !== undefined ? { reportId: text["reportId"] } : {}),
      ...(filePaths !== undefined ? { filePaths } : {}),
    },
  };
}

/** One raw item, from a tool argument or from a file, or the reason it is unusable. */
function parseImportItem(raw: unknown): { readonly ok: true; readonly item: LessonImportItem } | { readonly ok: false; readonly reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "refused: the item is not an object" };
  }
  const value = raw as Record<string, unknown>;
  const extra = unknownField(value, IMPORT_ITEM_FIELDS);
  if (extra !== undefined) {
    return { ok: false, reason: `refused: unknown field "${extra}"; allowed fields are ${IMPORT_ITEM_FIELDS.join(", ")}` };
  }

  const statement = value["statement"];
  if (typeof statement !== "string" || statement.trim() === "") {
    return { ok: false, reason: "refused: the item has no statement" };
  }
  const category = value["category"];
  if (typeof category !== "string" || !CATEGORIES.includes(category as LessonCategory)) {
    return { ok: false, reason: `refused: category "${String(category)}" is not one of ${CATEGORIES.join(", ")}` };
  }
  const severity = oneOf(value["severity"], SEVERITIES, "severity");
  if (!severity.ok) return severity;
  const status = oneOf(value["status"], STATUSES, "status");
  if (!status.ok) return status;
  const source = oneOf(value["source"], SOURCES, "source");
  if (!source.ok) return source;
  const target = oneOf(value["promotionTarget"], TARGETS, "promotionTarget");
  if (!target.ok) return target;
  const promotionRef = optionalText(value["promotionRef"], "promotionRef");
  if (!promotionRef.ok) return promotionRef;
  const evidence = parseImportEvidence(value["evidence"]);
  if (!evidence.ok) return evidence;

  let tags: string[] | undefined;
  const rawTags = value["tags"];
  if (rawTags !== undefined && rawTags !== null) {
    if (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== "string")) {
      return { ok: false, reason: "refused: tags is not an array of strings" };
    }
    tags = rawTags as string[];
  }

  return {
    ok: true,
    item: {
      statement,
      category: category as LessonCategory,
      ...(severity.value !== undefined ? { severity: severity.value } : {}),
      ...(status.value !== undefined ? { status: status.value } : {}),
      ...(source.value !== undefined ? { source: source.value } : {}),
      ...(target.value !== undefined ? { promotionTarget: target.value } : {}),
      ...(promotionRef.value !== undefined ? { promotionRef: promotionRef.value } : {}),
      ...(evidence.evidence !== undefined ? { evidence: evidence.evidence } : {}),
      ...(tags !== undefined ? { tags } : {}),
    },
  };
}

/**
 * Load a list of lessons in one pass, previewing by default.
 *
 * Each item goes through the same gate as a single recording: redaction, the
 * refusal of what redaction left behind, the length caps, and the fingerprint
 * decision against the rows already stored. Twice the same item in one batch is
 * therefore a recurrence, exactly as two separate calls would be.
 *
 * A dry run writes nothing, so an item that a dry run reports as `created` is not
 * there for the next item to match against: a repeat inside one previewed batch is
 * reported as a second creation, where the real run reports a recurrence. The
 * preview of a batch without repeats is exact.
 *
 * The root chat is the only caller. A subagent or a scheduled run records what it
 * learned with `lessons_record`, one lesson at a time.
 */
export async function importLessons(
  deps: LessonDeps,
  api: LessonWriteApi,
  ctx: Context,
  items: readonly unknown[],
  options: { readonly dryRun?: boolean } = {},
): Promise<LessonImportResult> {
  if ((await originOf(deps, api.conversationId, ctx)).kind !== "root") {
    return {
      ok: false,
      reason: "refused: lessons_import belongs to the root chat; a subagent or a scheduled run records one lesson at a time with lessons_record",
    };
  }
  if (items.length === 0) return { ok: false, reason: "refused: no items" };
  if (items.length > MAX_IMPORT_ITEMS) {
    return { ok: false, reason: `refused: ${items.length} items, over the ${MAX_IMPORT_ITEMS} limit` };
  }

  const dryRun = options.dryRun !== false;
  const results: LessonImportItemResult[] = [];
  for (const [index, raw] of items.entries()) {
    const parsed = parseImportItem(raw);
    if (!parsed.ok) {
      results.push({ index, statement: "", outcome: "refused", reason: parsed.reason });
      continue;
    }
    const recorded = await recordLesson(deps, api, ctx, parsed.item, { dryRun });
    if (!recorded.ok) {
      results.push({ index, statement: shortStatement(parsed.item.statement), outcome: "refused", reason: recorded.reason });
      continue;
    }
    results.push({
      index,
      statement: shortStatement(parsed.item.statement),
      outcome: recorded.outcome.action,
      lessonId: recorded.outcome.lessonId,
      recurrenceCount: recorded.outcome.recurrenceCount,
    });
  }

  const outcomes = results.map((item) => item.outcome);
  const totals: LessonImportTotals = {
    total: results.length,
    created: outcomes.filter((outcome) => outcome === "created").length,
    recurrenceRecorded: outcomes.filter((outcome) => outcome === "recurrence_recorded").length,
    duplicateIgnored: outcomes.filter((outcome) => outcome === "duplicate_ignored").length,
    refused: outcomes.filter((outcome) => outcome === "refused").length,
  };
  return { ok: true, dryRun, items: results, totals };
}

/**
 * Read one import file from the workspace tree, refusing anything outside it.
 *
 * The boundary is the same one `self_edit` enforces (`resolveWorkspacePath`), and
 * the size cap is what bounds a file-driven write when the item cap and the
 * statement cap are not enough on their own.
 */
export async function readImportFile(
  workspaceRoot: string,
  path: string,
): Promise<{ readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly reason: string }> {
  let absolute: string;
  try {
    absolute = resolveWorkspacePath(workspaceRoot, path);
  } catch {
    return { ok: false, reason: `refused: ${path} is outside the workspace tree (${workspaceRoot})` };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absolute);
  } catch (error) {
    return { ok: false, reason: `refused: ${path} could not be read (${String(error)})` };
  }
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    return { ok: false, reason: `refused: ${path} is ${buffer.byteLength} bytes, over the ${MAX_IMPORT_BYTES} limit` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: `refused: ${path} is not JSON (${String(error)})` };
  }
  if (Array.isArray(parsed)) return { ok: true, items: parsed };
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
    return { ok: true, items: (parsed as { items: unknown[] }).items };
  }
  return { ok: false, reason: `refused: ${path} must hold a JSON array of items, or an object with an items array` };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const CategorySchema = union([
  lit("user_correction"),
  lit("self_found"),
  lit("runtime_observed"),
]);

const StatusSchema = union([
  lit("proposed"),
  lit("open"),
  lit("promoted"),
  lit("dormant"),
  lit("closed"),
]);

const SeveritySchema = union([lit("high"), lit("normal"), lit("low")]);

const SourceSchema = union([lit("agent"), lit("scan"), lit("seed")]);

const TargetSchema = union([
  lit("prompt"),
  lit("memory"),
  lit("code"),
  lit("ops"),
  lit("undecided"),
]);

const EvidenceSchema = obj(
  {
    jobId: opt(str()),
    conversationId: opt(str()),
    entryId: opt(str()),
    reportId: opt(str()),
    filePaths: opt(arr(str(), { maxItems: MAX_FILE_PATHS })),
  },
);

/** Keep in step with `IMPORT_ITEM_FIELDS` and the `*` value lists above. */
const ImportItemSchema = obj(
  {
    statement: str(),
    category: CategorySchema,
    severity: opt(SeveritySchema),
    status: opt(StatusSchema),
    source: opt(SourceSchema),
    promotionTarget: opt(TargetSchema),
    promotionRef: opt(str()),
    evidence: opt(EvidenceSchema),
    tags: opt(arr(str())),
  },
);

function shortStatement(statement: string): string {
  return statement.length <= LIST_STATEMENT_CHARS ? statement : `${statement.slice(0, LIST_STATEMENT_CHARS)}…`;
}

function formatLesson(record: LessonRecord, timeZone: string): string {
  const duplicate = record.duplicateOf !== undefined ? ` duplicateOf=${record.duplicateOf}` : "";
  const promoted = record.promotionRef !== undefined ? ` ref=${record.promotionRef}` : "";
  return `${record.id} [${record.status}] ${record.category}/${record.severity} x${record.recurrence.count} target=${record.promotionTarget}${promoted}${duplicate} updated=${zoneIso(record.updatedAt, timeZone)} ${shortStatement(record.statement)}`;
}

/**
 * One lesson record with a readable twin beside each time it carries: the row's
 * two times, the last time the recurrence moved, and each note's own.
 *
 * `recurrence.lastSeenAt` is the field also called `recurrence.lastAt`; the
 * stored name is `lastSeenAt`, and it is that field that gets the twin.
 */
function withLocalLesson(record: LessonRecord, timeZone: string): LessonRecord & Record<string, unknown> {
  return {
    ...withLocal(record, ["createdAt", "updatedAt"], timeZone),
    recurrence: withLocal(record.recurrence, ["lastSeenAt"], timeZone),
    notes: record.notes.map((note) => withLocal(note, ["at"], timeZone)),
  };
}

/**
 * The counts with a readable twin on the counter's write time, when there is a
 * counter at all. A counter that was never written holds 0 there, which is not a
 * time, so it gets no twin.
 */
function withLocalStats(summary: LessonStats, timeZone: string): LessonStats & Record<string, unknown> {
  return {
    ...summary,
    ...(summary.counter === undefined ? {} : { counter: withLocal(summary.counter, ["updatedAt"], timeZone) }),
  };
}

/**
 * A scan page with a readable twin on every bound and every candidate time.
 *
 * Exported for the test that checks the twin, and for nothing else: the tool's own
 * `execute` is the only caller in the extension.
 */
export function withLocalScan(result: LessonScanResult, timeZone: string): LessonScanResult & Record<string, unknown> {
  return {
    ...withLocal(result, ["since", "before", "nextBefore"], timeZone),
    candidates: result.candidates.map((candidate) => withLocal(candidate, ["at"], timeZone)),
    ...(result.windowsCut === undefined
      ? {}
      : { windowsCut: result.windowsCut.map((cut) => withLocal(cut, ["at"], timeZone)) }),
  };
}

function formatNeighbours(neighbours: readonly LessonNeighbour[]): string {
  if (neighbours.length === 0) return "similar: (none)";
  return `similar:\n${neighbours
    .map((neighbour) => `  ${neighbour.similarity.toFixed(3)} x${neighbour.recurrenceCount} ${neighbour.id} ${shortStatement(neighbour.statement)}`)
    .join("\n")}`;
}

/** One line per imported item, plus the header and the totals. */
function formatImport(summary: LessonImportSummary): string {
  const head = summary.dryRun
    ? "dry run: nothing was written; call again with dryRun false to store these"
    : "written";
  const totals = summary.totals;
  const lines = [
    head,
    `total=${totals.total} created=${totals.created} recurrence_recorded=${totals.recurrenceRecorded} duplicate_ignored=${totals.duplicateIgnored} refused=${totals.refused}`,
  ];
  for (const item of summary.items) {
    const id = item.lessonId === undefined || item.lessonId === "" ? "" : ` ${item.lessonId}`;
    const count = item.recurrenceCount === undefined ? "" : ` x${item.recurrenceCount}`;
    const reason = item.reason === undefined ? "" : `: ${item.reason}`;
    lines.push(`${item.index}. ${item.outcome}${id}${count} ${item.statement}${reason}`);
  }
  return lines.join("\n");
}

/** The bundled `lessons` extension. */
export function createLessonsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  // Every time this extension prints is the harness zone, read from the config
  // each call rather than captured: the zone is config, and config can be reloaded.
  const zone = (): string => context.getConfig().timezone;
  const deps: LessonDeps = {
    storage: context.storage,
    reader: () => requireHarness(context),
    redactor: () => context.secrets.redactor(),
  };
  // An import file is read from the workspace tree and nowhere else, the same
  // boundary `self_edit` enforces.
  const workspaceRoot = resolve(context.getConfig().code.workspace);

  const record = defineTool({
    name: "lessons_record",
    description:
      "Record something learned, so the same correction is not paid for twice: a user correction, a mistake you found yourself, or a fact you verified while running. A statement already stored is not written twice. The same normalized statement from a different evidence point raises the existing lesson's recurrence count; the same call, from the same conversation and the same evidence point, is ignored and the count does not move. To count a repeat that is worded differently on purpose, call again with relation \"recurrence\" and duplicateOf. Returns the id, what happened, and the three closest existing lessons.",
    parameters: obj(
      {
        statement: str({ description: "The lesson in one sentence. Identifiers and paths only, never conversation text." }),
        category: CategorySchema,
        severity: opt(SeveritySchema),
        evidence: opt(EvidenceSchema),
        relation: opt(union([lit("new"), lit("recurrence")])),
        duplicateOf: opt(
          str({ description: "The existing lesson this one repeats, when relation is recurrence." }),
        ),
        promotionTarget: opt(TargetSchema),
        // `source` defaults to "agent" and `status` to "open". The scan path calls
        // with "scan" and "proposed"; see `lessons_scan`.
        source: opt(SourceSchema),
        status: opt(StatusSchema),
        tags: opt(arr(str())),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const result = await recordLesson(deps, api, ctx, {
        statement: args.statement,
        category: args.category,
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence as LessonEvidence } : {}),
        ...(args.relation !== undefined ? { relation: args.relation } : {}),
        ...(args.duplicateOf !== undefined ? { duplicateOf: args.duplicateOf } : {}),
        ...(args.promotionTarget !== undefined ? { promotionTarget: args.promotionTarget } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      });
      if (!result.ok) return { output: [{ type: "text" as const, text: result.reason }], isError: true };
      const { outcome } = result;
      return {
        output: [
          {
            type: "text" as const,
            text: `${outcome.action} ${outcome.lessonId} recurrence=${outcome.recurrenceCount}\n${formatNeighbours(outcome.similar)}`,
          },
        ],
      };
    },
  });

  const list = defineTool({
    name: "lessons_list",
    description:
      "List recorded lessons, most repeated first by default. Statements are shortened; read one in full with lessons_get.",
    parameters: obj(
      {
        status: opt(StatusSchema),
        category: opt(CategorySchema),
        promotionTarget: opt(TargetSchema),
        minRecurrence: opt(num({ description: "Only lessons seen at least this many times." })),
        since: opt(num({ description: "Only lessons touched at or after this epoch millisecond." })),
        order: opt(union([lit("recurrence"), lit("recent"), lit("severity")])),
        limit: opt(num({ description: `Default ${LIST_DEFAULT}, at most ${LIST_MAX}.` })),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const records = await listLessons(deps, ctx, {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.promotionTarget !== undefined ? { promotionTarget: args.promotionTarget } : {}),
        ...(args.minRecurrence !== undefined ? { minRecurrence: args.minRecurrence } : {}),
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return {
        output: [
          {
            type: "text" as const,
            text: records.length === 0 ? "(no lessons)" : records.map((item) => formatLesson(item, zone())).join("\n"),
          },
        ],
      };
    },
  });

  const get = defineTool({
    name: "lessons_get",
    description: "Read one lesson in full: its statement, recurrence, evidence, notes, and promotion.",
    parameters: obj({ id: str() }),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const record = await getLesson(deps, ctx, args.id);
      if (record === undefined) return { output: [{ type: "text" as const, text: `lesson not found: ${args.id}` }], isError: true };
      return { output: [{ type: "text" as const, text: JSON.stringify(withLocalLesson(record, zone()), null, 2) }] };
    },
  });

  const update = defineTool({
    name: "lessons_update",
    description:
      "Change a lesson's status, promotion target, or promotion evidence, or add a note. Marking a lesson promoted needs promotionRef: the file path, commit hash, or report slug that shows the rule now exists.",
    parameters: obj(
      {
        id: str(),
        status: opt(StatusSchema),
        promotionTarget: opt(TargetSchema),
        promotionRef: opt(str({ description: "The evidence that the rule exists. Required for status promoted." })),
        note: opt(str()),
        severity: opt(SeveritySchema),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const result = await updateLesson(deps, api, ctx, {
        id: args.id,
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.promotionTarget !== undefined ? { promotionTarget: args.promotionTarget } : {}),
        ...(args.promotionRef !== undefined ? { promotionRef: args.promotionRef } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
      });
      if (!result.ok) return { output: [{ type: "text" as const, text: result.reason }], isError: true };
      return { output: [{ type: "text" as const, text: `updated ${formatLesson(result.lesson, zone())}` }] };
    },
  });

  const reword = defineTool({
    name: "lessons_reword",
    description:
      "Replace the statement of a stored lesson, for the case where a lesson was recorded with the wrong wording and the row itself should stay. The id, the recurrence count, the evidence, the notes, the origin, and the promotion are kept: only the sentence moves. The fingerprint is recomputed from the new statement, so a later record with the new wording folds into this lesson and the old wording stops matching it. The call is refused when another lesson already holds the same normalized statement, and the reply names the lessons the new wording resembles. Read the lesson with lessons_get first. lessons_update changes the standing; this tool changes the sentence.",
    parameters: obj(
      {
        id: str({ description: "The lesson whose statement is wrong." }),
        statement: str({
          description: "The corrected lesson in one sentence. Identifiers and paths only, never conversation text.",
        }),
        note: opt(str({ description: "Why the wording changed. Kept in the lesson's notes." })),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const result = await rewordLesson(deps, api, ctx, {
        id: args.id,
        statement: args.statement,
        ...(args.note !== undefined ? { note: args.note } : {}),
      });
      if (!result.ok) return { output: [{ type: "text" as const, text: result.reason }], isError: true };
      const { outcome } = result;
      const head =
        outcome.action === "unchanged"
          ? `unchanged ${formatLesson(outcome.lesson, zone())} (the stored statement is already that text)`
          : `reworded ${formatLesson(outcome.lesson, zone())}\nwas: ${shortStatement(outcome.previousStatement)}`;
      return { output: [{ type: "text" as const, text: `${head}\n${formatNeighbours(outcome.similar)}` }] };
    },
  });

  const stats = defineTool({
    name: "lessons_stats",
    description:
      "Count the recorded lessons by status, category, and recurrence. The reply carries the live counts and the counter the prompt section reads, and whether the two agree. The count section shows the numbers this session started with, so this tool is where the live count is. The starting point for a self-improvement report. Pass refresh true to recount the stored lessons and write the counter back, which is what to call when counterMatches is false or after lessons were changed outside the store's own tools. A counter that was never written is counted and written by this call before it answers.",
    parameters: obj(
      {
        refresh: opt(
          bool({
            description:
              "Recount the stored lessons and write the counter back. Use when counterMatches is false. The write changes the counter only and never rewrites a lesson.",
          }),
        ),
      },
    ),
    // The store's convention marks a write `unsafe`, so an interrupted call is not
    // replayed. This tool keeps `safe`: its write is a function of the state it
    // just read, so a replay recounts and writes the same numbers, and the counter
    // path sets a value rather than adding to one, which leaves no effect to land
    // twice. Marking it `unsafe` would also take retry away from the plain read,
    // and a plain read is what most calls are.
    replay: "safe",
    execute: async (args, api, ctx) => {
      const summary = await lessonStats(deps, ctx);
      // A store that predates the counter reads as zeros in the section until
      // somebody counts it. This is the read path that counts it, the same way a
      // write does (`counterSeed`). The section itself never writes.
      const unwritten = summary.counter === undefined || summary.counter.updatedAt === 0;
      if (args.refresh !== true && !unwritten) {
        return { output: [{ type: "text" as const, text: JSON.stringify(withLocalStats(summary, zone()), null, 2) }] };
      }
      const refreshed = await refreshLessonCounter(deps, api, ctx);
      if (!refreshed.ok) {
        return {
          output: [{ type: "text" as const, text: `${JSON.stringify(withLocalStats(summary, zone()), null, 2)}\n${refreshed.reason}` }],
          isError: true,
        };
      }
      // Read again, so the reply describes the state the caller is left with rather
      // than the one the recount started from.
      const after = await lessonStats(deps, ctx);
      const line = `counter written: total=${refreshed.counter.total} open=${refreshed.counter.byStatus.open} proposed=${refreshed.counter.byStatus.proposed}; the counts above are the live ones`;
      return { output: [{ type: "text" as const, text: `${JSON.stringify(withLocalStats(after, zone()), null, 2)}\n${line}` }] };
    },
  });

  const scan = defineTool({
    name: "lessons_scan",
    description: `Collect candidate excerpts from recent conversations: user messages that carry a marker at the start of the message or of its envelope body, and tool calls that failed, whether they ran in the turn or as a background call. A failed background call is a user message whose envelope names src="tool-output" and status="failed", or the older tool-call-output tag with that status. Each excerpt is shortened and has registered secrets removed. This tool reads and never writes. Candidates come newest first across every conversation in the window. The reply carries counts per kind and nextBefore. Pass nextBefore as before to read the next page. One call reads every conversation that holds an entry at or after since, newest entry first, and stops after ${SCAN_ENTRY_BUDGET} entries. When it stops there, windowsCut names the conversation it stopped in, conversationsUnread counts the conversations it never opened, and no nextBefore comes back: raise since to read a smaller window. Candidates that share the millisecond at the end of a page all come on that page, so a page can hold more than limit. A candidate an agent records twice is absorbed by the recurrence rule. Turn what it finds into lessons with lessons_record, usually with source "scan" and status "proposed".`,
    parameters: obj(
      {
        since: opt(
          num({ description: "Only entries written at or after this epoch millisecond. Default: the last 24 hours." }),
        ),
        before: opt(
          num({
            description:
              "Only candidates older than this epoch millisecond, exclusive. Pass the nextBefore of the previous reply to read on. Keep since and kinds the same while paging.",
          }),
        ),
        limit: opt(
          num({
            description: `Default ${SCAN_DEFAULT_LIMIT} candidates, at most ${SCAN_MAX_LIMIT}. A page can hold more when candidates share the millisecond at its end.`,
          }),
        ),
        markers: opt(
          arr(str(), { description: `Text that starts a user message or the body of its envelope. Default: ${REVIEW_MARKER}.` }),
        ),
        kinds: opt(
          arr(union([lit("review"), lit("failed_tool")]), {
            description:
              "Which candidates to return. Omit for both. Use review for user corrections only, or failed_tool for failed tool calls only, background calls included.",
          }),
        ),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const result = await scanLessons(deps, ctx, {
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.markers !== undefined ? { markers: args.markers } : {}),
        ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
      });
      return { output: [{ type: "text" as const, text: JSON.stringify(withLocalScan(result, zone()), null, 2) }] };
    },
  });

  const importTool = defineTool({
    name: "lessons_import",
    description:
      "Load lessons in bulk, from a list or from a JSON file in the workspace tree. Every item passes the same secret and duplicate checks as lessons_record. By default this is a dry run: it reports what each item would become and writes nothing. Call it again with dryRun false to store. The root chat is the only caller.",
    parameters: obj(
      {
        items: opt(arr(ImportItemSchema)),
        file: opt(
          str({
            description: "A JSON file inside the workspace tree: an array of items, or an object with an items array.",
          }),
        ),
        dryRun: opt(bool({ description: "Default true: report only, store nothing." })),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      let items: readonly unknown[] | undefined = args.items;
      if (items === undefined) {
        if (args.file === undefined) {
          return { output: [{ type: "text" as const, text: "provide items or file" }], isError: true };
        }
        const read = await readImportFile(workspaceRoot, args.file);
        if (!read.ok) return { output: [{ type: "text" as const, text: read.reason }], isError: true };
        items = read.items;
      }
      const result = await importLessons(deps, api, ctx, items, { dryRun: args.dryRun ?? true });
      if (!result.ok) return { output: [{ type: "text" as const, text: result.reason }], isError: true };
      return { output: [{ type: "text" as const, text: formatImport(result) }] };
    },
  });

  /**
   * The count section. One document read per request and no family walk, which is
   * the whole reason the counter exists.
   *
   * It shows the numbers this session started with. A section keeps the value its
   * session committed, and a counter moves on every write, so the render returns
   * the committed value rather than a fresh one: a fresh value would be reported
   * as a change and written into the history as a note, plus the banner that asks
   * the operator for a new session. `lessons_stats` is where the live count is.
   *
   * The line that names `lessons_record` goes only to a conversation that has the
   * tool. A focused chat can read lessons and cannot record one, so it reads the
   * counts alone. The tool list is written in the commit that creates the
   * conversation and never changes, so the choice is as stable as the count this
   * section keeps.
   */
  const countSection = {
    key: LESSON_COUNT_SECTION,
    render: async (input: PromptInput, ctx: Context): Promise<string> => {
      const committed = committedSectionText(input, LESSON_COUNT_SECTION);
      if (committed !== undefined) return committed;
      const counts = await counterOf(input.read, ctx);
      return input.agent.tools.some((tool) => tool.name === "lessons_record")
        ? lessonCountLine(counts)
        : lessonCountSummary(counts);
    },
  };

  return defineExtension({
    name: "lessons",
    tools: [record, list, get, update, reword, stats, scan, importTool],
    sections: [countSection],
  });
}
