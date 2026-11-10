import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { obj, opt, str } from "@earendil-works/pi-schema";
import {
  GenerationTask,
  ROOT_CONVERSATION_ID,
  defineExtension,
  defineTool,
  hook,
  section,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  SecAgent,
  SecRestartRound,
  type AgentRecord,
  type RestartRoundRecord,
  type RestartTargetRecord,
  type RestartVerdict,
} from "../documents.ts";
import { ulid } from "../runtime/ids.ts";
import type { Paths } from "../runtime/paths.ts";
import { requireHarness, type ExtensionContext } from "./context.ts";
import { agentMessageRequestId } from "../agent-message.ts";
import { envelopeInstant, wrapMessage } from "../message-envelope.ts";
import { submitEnveloped } from "../submit-envelope.ts";
import { zoneMinute } from "../time-format.ts";
import { SESSION_START_KINDS, readSessionScan } from "../context-advice.ts";

/**
 * `session-restart` — carrying a new system prompt into the sessions that are
 * already running.
 *
 * A provider caches on the exact token prefix of a request, so a session keeps
 * the prompt values it committed at its start (see `sections.ts`). A prompt
 * source that moves therefore reaches a conversation at a new session only:
 * a fresh conversation, a reset, or a compaction. A cold restart is none of
 * those, so it does not help a live session.
 *
 * This extension gives an agent the tool to reset *its own* conversation, and a
 * round ledger for making its whole subtree do the same. Two facts decide the
 * shape of it:
 *
 *   - `control: { handoff }` resets the conversation and starts a new run with
 *     the input queued in the same tool call, and the run that made the call
 *     ends `done`. A reset admitted from outside instead ends that run
 *     `unanswered` and the model's answer is lost. So the agent resets itself,
 *     from inside its own turn, and never someone else's conversation.
 *   - Readiness is read from the entry log, not from a message. A session that
 *     loaded the new baseline has a `pi.reset` with a `pi.system` after it, and
 *     a child that stopped or died is finished. Neither needs a signal to
 *     arrive, so a silent death cannot stop a round forever.
 *
 * The ledger is the document `sec.restartRound`, and every tool reads and writes
 * it inside one commit. The JSON file beside it is a mirror for a human to read
 * and decides nothing: a mirror that fails to be written costs a stale file, not
 * a wrong verdict.
 */

/** Entry kinds this module reads. The two are durable protocol, not ours. */
const RESET_ENTRY = "pi.reset";
const SYSTEM_ENTRY = "pi.system";

/** The document key of the one round document a conversation holds. */
export const ROUND_KEY = "current";

/** Entries one scan reads before it gives up and reports the log as unread. */
export const SCAN_LIMIT = 50_000;

/** Entries read per page while scanning a child's log. */
export const SCAN_PAGE = 1_000;

/** Statuses that mean the agent is finished, so its part of a round is over. */
const FINISHED_STATUSES: readonly string[] = ["stopped", "failed", "deleted"];

/** The entry budget and the page size one readiness scan runs under. */
export interface ScanCaps {
  /** Entries the scan reads before it stops and calls the log unread. */
  limit: number;
  /** Entries one page of the scan asks for. */
  page: number;
}

/**
 * The caps a scan uses when the caller names none.
 *
 * A mutable object rather than two bare constants because the truncation path
 * has to be reachable: with a 50 000 entry cap, no test can write a log long
 * enough to hit it, so the test that covers the path lowers this for one call
 * and puts it back.
 */
export const DEFAULT_SCAN_CAPS: ScanCaps = { limit: SCAN_LIMIT, page: SCAN_PAGE };

/** The part of a log entry the readiness rule reads. */
export interface RoundLogEntry {
  readonly id: number;
  readonly kind: string;
}

/** One page of a child's log: the entries, and the cursor that reads on. */
export interface LogPage {
  readonly entries: readonly RoundLogEntry[];
  readonly next: Cursor | undefined;
}

/** Reads one page of a log. `undefined` means there was nothing to read. */
export type LogPageReader = (cursor: Cursor | undefined) => Promise<LogPage | undefined>;

/**
 * What one streaming pass over a child's log established.
 *
 * `truncated` is the fact the previous version hid: it read 500 entries, gave
 * up, and said nothing, so a child whose reset was past that point was never
 * counted and its round never closed.
 */
export interface LogScan {
  /** The first `pi.reset` after `sinceId`. `0` when none was read. */
  readonly resetId: number;
  /** The first `pi.system` after that reset. `0` when none was read. */
  readonly systemId: number;
  /** Entries read. */
  readonly count: number;
  /** The cap stopped the scan before the log ended and before the proof came. */
  readonly truncated: boolean;
  /** The cap this scan ran under, so the reason can state it. */
  readonly limit: number;
}

/** The readiness rule's answer over the entries of one range. */
export interface Readiness {
  readonly resetId?: number;
  readonly systemId?: number;
  readonly ready: boolean;
  readonly reason: string;
}

/** One target's verdict, as `restart_cascade_status` writes it down. */
export interface Verdict {
  readonly verdict: RestartVerdict;
  /** `verdict !== "waiting"`. A counted target stops holding the round. */
  readonly counted: boolean;
  readonly reason: string;
  readonly resetId: number;
  readonly systemId: number;
}

/** The four verdicts, re-exported so the tools and the document name one set. */
export type { RestartVerdict };

function restartDir(paths: Paths): string {
  return join(paths.stateDir, "restart");
}

/** The mirror file of one conversation's round: one round, one file. */
export function ledgerPath(paths: Paths, conversationId: string): string {
  return join(restartDir(paths), `${conversationId}.json`);
}

function emptyScan(limit: number): LogScan {
  return { resetId: 0, systemId: 0, count: 0, truncated: false, limit };
}

/**
 * Fold one page of a log into a scan.
 *
 * The rule is one line: the first `pi.reset` after `sinceId`, and the first
 * `pi.system` after that reset. A `pi.system` read before any reset is not a
 * baseline, because a tool run writes system entries too, so the scan ignores
 * those. Entries may arrive in any order, so this sorts what it is given: the
 * caller can hand over a page in whatever order its query returned.
 */
export function foldScan(scan: LogScan, entries: readonly RoundLogEntry[], sinceId: number): LogScan {
  let resetId = scan.resetId;
  let systemId = scan.systemId;
  const ordered = entries.filter((entry) => entry.id > sinceId).sort((a, b) => a.id - b.id);
  for (const entry of ordered) {
    if (resetId === 0) {
      if (entry.kind === RESET_ENTRY) resetId = entry.id;
      continue;
    }
    if (entry.kind === SYSTEM_ENTRY && entry.id > resetId) {
      systemId = entry.id;
      break;
    }
  }
  return { ...scan, resetId, systemId, count: scan.count + entries.length };
}

/** The readiness rule as words, for the ids one scan found. */
export function describeScan(scan: Pick<LogScan, "resetId" | "systemId">): Readiness {
  if (scan.resetId === 0) {
    return { ready: false, reason: `no ${RESET_ENTRY} after the round started` };
  }
  if (scan.systemId === 0 || scan.systemId < scan.resetId) {
    return {
      resetId: scan.resetId,
      ready: false,
      reason: `the reset (${scan.resetId}) has no ${SYSTEM_ENTRY} baseline after it`,
    };
  }
  return {
    resetId: scan.resetId,
    systemId: scan.systemId,
    ready: true,
    reason: `it loaded a new baseline (reset ${scan.resetId}, system ${scan.systemId})`,
  };
}

/** The readiness rule over one range of entries, in whatever order they arrive. */
export function readinessOf(entries: readonly RoundLogEntry[], sinceId: number): Readiness {
  return describeScan(foldScan(emptyScan(SCAN_LIMIT), entries, sinceId));
}

/**
 * Read a log until the rule is answered, or until the cap stops the scan.
 *
 * Streaming and early: it stops at the first `pi.system` after the first
 * `pi.reset`, which is usually the page right after the reset, and it stops at
 * `caps.limit` entries when the log is longer than that. Reaching the cap is
 * reported in `truncated` rather than swallowed: the caller counts such a child
 * as finished without evidence and says so.
 */
export async function scanLog(
  read: LogPageReader,
  sinceId: number,
  caps: ScanCaps = DEFAULT_SCAN_CAPS,
): Promise<LogScan> {
  let scan = emptyScan(caps.limit);
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await read(cursor);
    if (page === undefined) return scan;
    scan = foldScan(scan, page.entries, sinceId);
    if (scan.resetId !== 0 && scan.systemId > scan.resetId) return scan;
    if (page.next === undefined) return scan;
    if (scan.count >= caps.limit) return { ...scan, truncated: true };
    cursor = page.next;
  }
}

/** A target whose agent record says it is finished. */
export function finishedVerdict(reason: string): Verdict {
  return { verdict: "finished", counted: true, reason, resetId: 0, systemId: 0 };
}

/**
 * The verdict one log scan supports.
 *
 * `waiting` is the only verdict that holds a round. `unconfirmed` means the log
 * was longer than the scan read, so nothing proves the child loaded the new
 * baseline; it is counted all the same, because no waiting limit was set, and
 * both the reason and the document say that the evidence is missing. A round
 * that waits for a child the scan cannot read is a round that never closes.
 */
export function verdictOf(scan: LogScan): Verdict {
  const rule = describeScan(scan);
  if (rule.ready) {
    return { verdict: "ready", counted: true, reason: rule.reason, resetId: scan.resetId, systemId: scan.systemId };
  }
  if (scan.truncated) {
    return {
      verdict: "unconfirmed",
      counted: true,
      reason: `its log was not read to the end (${scan.count} entries against a cap of ${scan.limit}), so nothing proves it loaded a new baseline: it is counted as finished without evidence`,
      resetId: scan.resetId,
      systemId: scan.systemId,
    };
  }
  return { verdict: "waiting", counted: false, reason: rule.reason, resetId: scan.resetId, systemId: scan.systemId };
}

/** A plain copy of one draft, so no caller holds a revoked document handle. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** One target, as the round document records it before anything was counted. */
function newTarget(record: Readonly<AgentRecord>, sinceId: number): RestartTargetRecord {
  return {
    name: record.name,
    conversationId: String(record.conversationId),
    roles: [...record.roles],
    sinceId,
    messageId: "",
    verdict: "waiting",
    counted: false,
    reason: "",
    resetId: 0,
    systemId: 0,
    checkedAt: 0,
  };
}

/** Why a child counts as finished, or `undefined` while it is still alive. */
function finishedReason(record: Readonly<AgentRecord> | undefined): string | undefined {
  if (record === undefined) return "its agent record is gone, so it ended";
  if (FINISHED_STATUSES.includes(record.status)) return `its agent record is ${record.status}, so it ended`;
  return undefined;
}

/** One target as a line, without leaning on fields a scan has not filled in yet. */
function describeTarget(target: Readonly<RestartTargetRecord>): string {
  const roles = target.roles.length === 0 ? "no roles" : `roles: ${target.roles.join(", ")}`;
  return `${target.name} (conversation ${target.conversationId}, ${roles}, from entry ${target.sinceId}${
    target.resetId === 0 ? "" : `, reset ${target.resetId}`
  }${target.systemId === 0 ? "" : `, system ${target.systemId}`})`;
}

function text(body: string, isError = false) {
  return { output: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) };
}

/** The note that tells one child to take part in a round. The recursion lives here. */
function childNote(roundId: string, reason: string): string {
  return [
    `[restart round ${roundId}] The system prompt changed: ${reason}.`,
    "Every running session keeps the prompt it started with, so every session in this tree has to start again to load the new baseline. You are part of this round.",
    "Finish what you are doing, then park with `await_orders`. Start no new work.",
    "If you have children of your own, open your own round with `restart_cascade_start` and call `restart_cascade_status` with that round id until every target reports ready.",
    `When your own part is ready, call \`restart_session\` with roundId "${roundId}". Your \`continuation\` is what the user reads where your context was reset, so write it for them.`,
    "Then report to your parent with `await_orders`, saying what you restarted and what is left.",
  ].join("\n");
}

/** The handoff text. It is not shown to the operator: the UI draws `pi.reset` as a divider. */
function handoffText(roundId: string, timeZone: string): string {
  return wrapMessage(
    "restart",
    [
      `[restart ${roundId}] This conversation's context was reset just before this line, and the system prompt baseline was read again.`,
      `If you can still see the conversation from before this line, the reset did not happen: call \`restart_session\` again with roundId "${roundId}".`,
    ].join("\n"),
    // The handoff is one entry the durable layer writes at the reset below, so
    // the instant is read here, at the boundary it describes.
    { via: "handoff", round: roundId, at: envelopeInstant(Date.now(), timeZone) },
  );
}

/** The newest entry id of one conversation, or `0` when it has no entries. */
async function latestEntryId(context: ExtensionContext, conversationId: ConversationId, ctx: Context): Promise<number> {
  const conversation = await requireHarness(context).conversation(conversationId, ctx);
  if (conversation === undefined) return 0;
  const page = await conversation.entries({}, 1, undefined, ctx);
  return page.items[0]?.id ?? 0;
}

/**
 * Whether this conversation reset itself after the round opened.
 *
 * The round records the last `restart_session` request of this conversation: its
 * round id, the entry the log had reached, and the instant. A request made after
 * the round opened, with a `pi.reset` after that entry, is a reset the round
 * asked for, so the status cannot ask for a second one. That is the same
 * evidence the re-call refusal reads, and the entry id is the only anchor a log
 * offers: entries carry no clock.
 *
 * A conversation that never called `restart_session` has a request instant of
 * `0`, which is before any round that opened, and costs no scan.
 */
async function selfResetSinceRound(
  context: ExtensionContext,
  self: ConversationId,
  round: Readonly<RestartRoundRecord>,
  caps: ScanCaps,
  ctx: Context,
): Promise<boolean> {
  if (round.selfRequestedAt === 0 || round.selfRequestedAt < round.startedAt) return false;
  const scan = await scanLog(logReader(context, self, round.selfEntryId, caps.page, ctx), round.selfEntryId, caps);
  return scan.resetId !== 0;
}

/**
 * The page reader for one conversation's log after `sinceId`.
 *
 * The conversation handle is resolved once, so the scan does one lookup and
 * then only pages: a child that is deleted mid-scan fails the read, and the
 * caller settles that before it starts.
 */
function logReader(
  context: ExtensionContext,
  conversationId: ConversationId,
  sinceId: number,
  pageSize: number,
  ctx: Context,
): LogPageReader {
  return async (cursor) => {
    const conversation = await requireHarness(context).conversation(conversationId, ctx);
    if (conversation === undefined) return undefined;
    const page = await conversation.entries(
      { minEntryId: (sinceId + 1) as EntryId, order: "ascending" },
      pageSize,
      cursor,
      ctx,
    );
    return {
      entries: page.items.map((entry) => ({ id: entry.id, kind: entry.kind })),
      next: page.next,
    };
  };
}

/**
 * The fields the round record type has, read from the document's own initial
 * value.
 *
 * `initial` takes the family key as its seed, which this value does not read, so
 * the empty string stands in. Taking the names from there means a field added to
 * the type needs no second list kept in step with it.
 */
const RECORD_FIELDS = Object.keys(SecRestartRound.definition.initial(""));

/**
 * The round as the record type declares it, and nothing else.
 *
 * The document store writes back what it read, so a key an older build put on a
 * round survives every commit. The ledger file is what a person opens, and a
 * value such as the old `approval` text reads as if the round needed one. So the
 * file is written from the type's fields alone and a key outside the type is
 * dropped.
 */
function typedRecord(round: RestartRoundRecord): RestartRoundRecord {
  const source = round as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of RECORD_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out as unknown as RestartRoundRecord;
}

/**
 * Write the mirror file of one conversation's round.
 *
 * Written to a temporary name and renamed, so a reader never sees half a file,
 * and with mode `0600`: it holds reason text and concerns one agent's own
 * conversation. The document is the ledger and this is a copy of it, so it may
 * lag the document by one commit, and a failed write leaves the file stale or
 * absent. Nothing reads it to decide anything.
 */
async function mirrorRound(
  context: ExtensionContext,
  conversationId: string,
  round: RestartRoundRecord,
): Promise<void> {
  const dir = restartDir(context.paths);
  const path = ledgerPath(context.paths, conversationId);
  // Two calls of one tool round run in parallel, so the temporary name is unique
  // per write; a shared one would let a rename carry a half-written file.
  const temporary = `${path}.${ulid()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(typedRecord(round), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    context.logger.warn("the restart ledger mirror could not be written", { path, error });
  }
}

/**
 * The instant an entry carries, from its first message. `0` when it carries none.
 *
 * A session's start entry is a reset or a compaction summary, and both hold a
 * user message with the time the harness wrote it. That time is what the ledger
 * records for a restart that opened no round.
 */
function sessionStartInstant(entry: { readonly model?: readonly { readonly timestamp?: number }[] }): number {
  const stamp = entry.model?.[0]?.timestamp;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The entry id of the last session start of a conversation.
 *
 * It is the request id of a restart that opened no round, so it has to come from
 * the log rather than from the model: an id the model made up would defeat the
 * one defence that keeps two calls of one turn from queueing two continuations.
 * The newest entry that began a session is a reset or a compaction summary. The
 * read pages through the log, newest first, `caps.page` entries at a time, and
 * stops at the first such entry. It has three outcomes:
 *
 * - it finds one: the id of that entry;
 * - it reads the whole log and finds none: `0`, which only the first session of
 *   a conversation can produce, so no other session shares it;
 * - it reads `caps.limit` entries and finds none: the id of the oldest entry it
 *   read. That entry belongs to the current session, and every earlier session
 *   start is older, so no earlier request can have this id.
 */
async function lastSessionStart(
  context: ExtensionContext,
  conversationId: ConversationId,
  caps: ScanCaps,
  ctx: Context,
): Promise<{ readonly id: number; readonly at: number }> {
  const harness = requireHarness(context);
  const conversation = await harness.conversation(conversationId, ctx);
  if (conversation === undefined) return { id: 0, at: 0 };
  let cursor: Cursor | undefined;
  let read = 0;
  let oldest = 0;
  while (read < caps.limit) {
    const want = Math.min(caps.page, caps.limit - read);
    const page = await conversation.entries({ order: "descending" }, want, cursor, ctx);
    for (const entry of page.items) {
      if (SESSION_START_KINDS.includes(entry.kind)) {
        return { id: entry.id, at: sessionStartInstant(entry as unknown as { model?: readonly { timestamp?: number }[] }) };
      }
      oldest = entry.id;
    }
    read += page.items.length;
    if (page.items.length === 0 || page.next === undefined) return { id: 0, at: 0 };
    cursor = page.next;
  }
  return { id: oldest, at: 0 };
}

/**
 * The handoff text of a restart that opened no round.
 *
 * It says why the session started again, and it deliberately does not say that a
 * prompt moved: no prompt moved. It also gives the reader a way to tell a reset
 * that did not happen, which is the same check the round's handoff offers.
 */
function selfHandoffText(timeZone: string): string {
  return wrapMessage(
    "restart",
    "[restart self] This conversation's context was reset just before this line, because it was too long, and this session's system prompt baseline was written again. If you can still see the conversation from before this line, the reset did not happen: call `restart_session` again with the same reason and no round id.",
    // The handoff is one entry the durable layer writes at the reset, so the
    // instant is read here, at the boundary it describes.
    { via: "handoff", kind: "context-length", at: envelopeInstant(Date.now(), timeZone) },
  );
}

/**
 * Whether this conversation is one the restart advice is for.
 *
 * The root is a target, and so is a subagent whose roles share a name with
 * `agent.contextRestart.roles`. A planner, a worker, a focused chat and a
 * scheduled run are not: they are short-lived, or a person reads them turn by
 * turn and restarts them when they choose.
 *
 * The roles come from the advice's own list rather than from the personality's,
 * because the two lists name different things: the personality names the roles
 * that write the text the user reads, and this one names the roles that live long
 * enough for a restart to be worth it.
 *
 * Both advices ask this one question, so both read it here: the size advice asks
 * it when an answer arrives, and the time-based advice asks it once per pass in
 * the sweep.
 */
export async function adviceTargetOf(
  context: ExtensionContext,
  conversationId: ConversationId,
  ctx: Context,
): Promise<boolean> {
  const hub = context.subagents;
  if (hub === undefined) return conversationId === ROOT_CONVERSATION_ID;
  const kind = await hub.kindOf(conversationId, ctx);
  if (kind === "root") return true;
  if (kind !== "subagent") return false;
  const record = await hub.recordOf(conversationId, ctx);
  if (record === undefined) return false;
  const wanted = context.getConfig().agent.contextRestart.roles;
  return record.roles.some((role) => wanted.includes(role));
}

/**
 * How often an open round earns its owner a notice, in milliseconds.
 *
 * The round is counted in cells of this length from the instant it opened, so the
 * first notice leaves at the half hour and the next one at the hour. A constant,
 * not a setting: the notice only chooses when to say a fact the round already
 * states, and the sweep that reads the round is a constant period as well.
 */
export const ROUND_WATCH_MS = 1_800_000;

/** Where one notice stands after one pass. */
export type RoundWatchStatus =
  /** No open round, or every target counted, or the first cell is not over. */
  | "quiet"
  /** A daemon restart request is up, so no input may wake the owner. */
  | "held-restart"
  /** The owner is working; the notice is left to the next pass. */
  | "held-busy"
  /** This cell's notice is already submitted, and a repeat would be the same submission. */
  | "already-sent"
  | "sent"
  | "failed";

/** What one pass over one conversation's round did. */
export interface RoundWatchResult {
  readonly status: RoundWatchStatus;
  readonly roundId?: string;
  /** The half-hour cell this pass fell in, `0` being the first half hour after the open. */
  readonly bucket?: number;
  /** Targets the round is still waiting for, at the moment of the pass. */
  readonly unready?: number;
  readonly problem?: string;
}

/** One live task of a conversation, as the sweep already counted it. */
export interface LiveStep {
  /** Live tasks of that conversation. */
  readonly count: number;
  /** When the earliest of them first went `running`. */
  readonly since: number;
}

/**
 * How far one target's round note got.
 *
 * `queued` is a note the conversation has not put in its transcript yet, which is
 * the state the whole change exists to make visible. `placed` is a note its
 * reader has. `none` is a note the harness never took: no submission by that
 * request id is on record.
 */
type NoteState = "queued" | "placed" | "none";

/** The request id one cell's notice is submitted under, which is what makes it once per cell. */
export function roundWatchRequestId(roundId: string, bucket: number): string {
  return `restart-round-watch:${roundId}:${bucket}`;
}

/** Whole minutes, so a notice never claims more time than has passed. */
function minutesOf(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

/** How far the round note that asked one target to join got. */
async function noteStateOf(
  context: ExtensionContext,
  target: Readonly<RestartTargetRecord>,
  ctx: Context,
): Promise<NoteState> {
  if (target.messageId === "") return "none";
  const submission = await context.storage.submissionByRequest(
    Number(target.conversationId) as ConversationId,
    agentMessageRequestId(target.messageId),
    ctx,
  );
  if (submission === undefined) return "none";
  if (submission.status === "queued") return "queued";
  // `done` and `placed` both mean the note is in the transcript. `unanswered` is
  // a note that was taken and then dropped, so nothing of it reaches the reader,
  // and it reads as a note that was never accepted.
  return submission.status === "unanswered" ? "none" : "placed";
}

/** The sentence one line uses for the state of that target's round note. */
function noteStateWords(state: NoteState, where: "conversation" | "bare"): string {
  if (state === "queued") {
    return where === "conversation" ? "is still queued in its conversation" : "is still queued";
  }
  if (state === "placed") return where === "conversation" ? "was placed in its conversation" : "was placed";
  return "was never accepted";
}

/**
 * The lines that name every target the round is still waiting for.
 *
 * The shape of a line follows what the target can say about itself. A target
 * whose note was taken and that is working is described by its work, because a
 * long run is the usual reason a round stays open: the instant its current step
 * started, which is only part of the run, plus the sentence that says so. Every
 * other target is described by its record and by how far its note got.
 */
async function targetLines(
  context: ExtensionContext,
  round: Readonly<RestartRoundRecord>,
  live: ReadonlyMap<string, LiveStep>,
  now: number,
  ctx: Context,
): Promise<string[]> {
  const timeZone = context.getConfig().timezone;
  const lines: string[] = [];
  for (const target of round.targets) {
    if (target.counted) continue;
    const record = await requireHarness(context).snapshot(SecAgent, target.conversationId, ctx);
    const state = await noteStateOf(context, target, ctx);
    const step = live.get(target.conversationId);
    const line = (tail: string): string => `- ${target.name} (conversation ${target.conversationId}): ${tail}`;
    if (record === undefined) {
      lines.push(
        line(`its agent record is gone. The note that asked it to join the round ${noteStateWords(state, "bare")}.`),
      );
      continue;
    }
    if (state === "none") {
      lines.push(
        line(`its agent record is ${record.status}. The note that asked it to join the round was never accepted.`),
      );
      continue;
    }
    if (record.status === "running" && step !== undefined && step.count > 0) {
      const parts = [
        `running. Its current step started at ${zoneMinute(step.since, timeZone)}, ${minutesOf(now - step.since)} minutes ago. The run that step belongs to started earlier. The note that asked it to join the round ${noteStateWords(state, "conversation")}.`,
      ];
      // Its own round is the reason its owner may be waiting on it again, so the
      // count is worth the one read when that round is open.
      const own = await requireHarness(context).snapshot(
        SecRestartRound,
        Number(target.conversationId) as ConversationId,
        ROUND_KEY,
        ctx,
      );
      if (own !== undefined && own.startedAt !== 0 && own.closedAt === 0) {
        const inner = own.targets.filter((nested) => !nested.counted).length;
        parts.push(`It has an open round of its own, with ${inner} target(s) not counted ready.`);
      }
      lines.push(line(parts.join(" ")));
      continue;
    }
    if (record.status === "waiting") {
      lines.push(line(`waiting for orders. The note that asked it to join the round ${noteStateWords(state, "bare")}.`));
      continue;
    }
    lines.push(
      line(`its agent record is ${record.status}. The note that asked it to join the round ${noteStateWords(state, "bare")}.`),
    );
  }
  return lines;
}

/**
 * Say once per half hour that a round is still open, and who is holding it.
 *
 * A round that finishes needs nobody: a target resets itself, its owner counts the
 * round, and the round closes. A round whose target is inside one long run does
 * not finish, and before this the harness said nothing about it at all, so the
 * owner sat idle while the round stayed open for hours. The sweep already walks
 * every live conversation every thirty seconds and already knows which of them
 * are working, so the round is read here, in the same pass, and its owner is told.
 *
 * This reads and says only. It never stops, restarts or deletes a target, and it
 * never closes a round: those are the owner's calls, and a harness that made them
 * would be acting for an agent that is still able to.
 *
 * The notice is held while a daemon restart request is up, exactly as the idle
 * notice and the stall note are: the notice is input, input starts a run, and a
 * run in a parked owner costs the restart its safe point. It is also left to the
 * next pass while the owner is working, because an owner that is running can
 * count its own round and a notice is worth sending to one that is not.
 *
 * One cell, one submission: the request id carries the round and the cell, and
 * the harness refuses a second submission under an id it already holds. That is
 * what keeps the notice from repeating after the process forgets everything.
 */
export async function watchOpenRound(
  context: ExtensionContext,
  input: {
    /** The conversation whose own round this pass reads. */
    readonly conversationId: ConversationId;
    /** That conversation's agent record, as the sweep read it. */
    readonly owner: Readonly<AgentRecord> | undefined;
    /** Live tasks of that conversation, as the sweep counted them. */
    readonly live: ReadonlyMap<string, LiveStep>;
    readonly now: number;
  },
  ctx: Context,
): Promise<RoundWatchResult> {
  const owner = input.owner;
  // A record that is gone or finished has nobody to tell, and a submission into
  // it would start a run that answers to nobody.
  if (owner === undefined || FINISHED_STATUSES.includes(owner.status)) return { status: "quiet" };
  const round = await requireHarness(context).snapshot(SecRestartRound, input.conversationId, ROUND_KEY, ctx);
  if (round === undefined) return { status: "quiet" };
  if (round.startedAt === 0 || round.closedAt !== 0) return { status: "quiet" };
  const unready = round.targets.filter((target) => !target.counted).length;
  if (unready === 0) return { status: "quiet", roundId: round.roundId, unready: 0 };

  const bucket = Math.floor((input.now - round.startedAt) / ROUND_WATCH_MS);
  if (bucket < 1) return { status: "quiet", roundId: round.roundId, bucket, unready };

  if (context.restart.status.ready) return { status: "held-restart", roundId: round.roundId, bucket, unready };
  const ownerStep = input.live.get(String(input.conversationId));
  if (ownerStep !== undefined && ownerStep.count > 0) {
    return { status: "held-busy", roundId: round.roundId, bucket, unready };
  }

  const requestId = roundWatchRequestId(round.roundId, bucket);
  const seen = await context.storage.submissionByRequest(input.conversationId, requestId, ctx);
  if (seen !== undefined) return { status: "already-sent", roundId: round.roundId, bucket, unready };

  const lines = [
    `[restart round ${round.roundId}] This round has been open for ${minutesOf(input.now - round.startedAt)} minutes, and ${unready} of its ${round.targets.length} targets are not counted ready.`,
    "",
    ...(await targetLines(context, round, input.live, input.now, ctx)),
    "",
    `Count the round again with \`restart_cascade_status\` and roundId "${round.roundId}". If a target is held up by its own long work, tell your parent with \`await_orders\` (the root tells the user). Nothing was stopped, deleted, or closed.`,
  ];
  const conversation = await requireHarness(context).conversation(input.conversationId, ctx);
  if (conversation === undefined) {
    return { status: "failed", roundId: round.roundId, bucket, unready, problem: "the conversation is gone" };
  }
  try {
    await submitEnveloped(
      conversation,
      ctx,
      {
        // The harness is not a peer in the tree, so this is a `restart` input and
        // not an agent message: nothing here comes from another agent.
        type: "input",
        src: "restart",
        attrs: { via: "round-watch", round: round.roundId },
        content: lines.join("\n"),
        whenBusy: "followUp",
        requestId,
      },
      context.getConfig().timezone,
    );
  } catch (error) {
    // Nothing reached the conversation, so no row is written and the next pass
    // tries the same cell again.
    return {
      status: "failed",
      roundId: round.roundId,
      bucket,
      unready,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  context.audit.append({
    type: "restart_round_watch",
    roundId: round.roundId,
    conversationId: String(input.conversationId),
    unready,
    bucket,
  });
  return { status: "sent", roundId: round.roundId, bucket, unready };
}

/** The bundled `session-restart` extension: self-restart and the round cascade. */
export function createSessionRestartExtension(
  context: ExtensionContext,
  caps: ScanCaps = DEFAULT_SCAN_CAPS,
): Extension<ToolRegistration> {
  const paths = context.paths;

  const restartSession = defineTool({
    name: "restart_session",
    description:
      "Restart your own conversation now: the context above is cut and a new run starts with the `continuation` you write, which is the entry the user reads where the reset happened. This is a one-way door for this session: the old context is not recoverable, only forkable into a new conversation with a new id. Give `roundId` when a restart round asked you to restart, and use the id that the round's note carried. Leave `roundId` out when you restart on your own because this conversation's context grew long: the ledger records the request and opens no round. A second call in the same session is refused once the reset is in the log, and it queues nothing twice before that. A call from a later session is a new request, so a conversation can restart on its own each time its context grows long.",
    parameters: obj(
      {
        reason: str({ description: "Why this session restarts. Shown to the user in the ledger." }),
        continuation: str({
          description: "What the new run starts with, and what the user reads where the reset happened. Write it for them.",
        }),
        roundId: opt(
          str({
            description: "The round this restart belongs to. Leave it out for a restart of your own, which carries no new prompt.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const harness = requireHarness(context);
      const self = api.conversationId;
      const conversation = await harness.conversation(self, ctx);
      if (conversation === undefined) return text("this conversation is gone, so there is nothing to restart", true);

      // A call with no round id is a restart of the agent's own choosing, because
      // this conversation's context grew long. Its identity is not the model's to
      // give: it is where the current session began, which is the newest entry a
      // session starts from. Two calls in one turn of one session compute the same
      // id, so the second is the same submission; after the reset the newest such
      // entry is the new one, so the next restart gets a new id and works.
      const selfRestart = args.roundId === undefined;
      const start = selfRestart ? await lastSessionStart(context, self, caps, ctx) : undefined;
      const identity = selfRestart ? `self:${start!.id}` : (args.roundId as string);

      // The re-call rule. A reset already in the log after the request that the
      // document holds means this restart's work is done, so the second call is a
      // repeat rather than a new request — the exact case of a crash between the
      // two steps of the first call. The scan stops at the first reset, so it
      // reads one page at most.
      const recorded = await harness.snapshot(SecRestartRound, self, ROUND_KEY, ctx);
      if (recorded !== undefined && recorded.selfRoundId === identity && recorded.selfRoundId !== "") {
        const scan = await scanLog(logReader(context, self, recorded.selfEntryId, caps.page, ctx), recorded.selfEntryId, caps);
        if (scan.resetId !== 0) {
          return text(
            `restart "${identity}" already reset this conversation (a \`${RESET_ENTRY}\` is in the log after entry ${recorded.selfEntryId}). Nothing was queued and nothing was reset. Carry on in the context you are in.`,
            true,
          );
        }
      }

      const requestedAt = Date.now();
      const entryId = await latestEntryId(context, self, ctx);
      const written = await harness.commit(async (tx) => {
        const round = await tx.doc(SecRestartRound, self, ROUND_KEY, ROUND_KEY);
        // A restart of one's own opens no round: the fields that open one
        // (`roundId`, `startedAt`, the targets) are left exactly as they are, so
        // this request neither opens a round nor blocks a later one. The three
        // fields below are the request itself, and `selfRoundId` carries an
        // identity that begins with `self:` and so cannot be read as a round id.
        round.selfRoundId = identity;
        round.selfRequestedAt = requestedAt;
        round.selfEntryId = entryId;
        round.updatedAt = requestedAt;
        return plain(round);
      }, ctx);
      await mirrorRound(context, String(self), written);

      // Queued, not placed: this run is the one making the call, so the input
      // waits for the boundary that the handoff below creates. The request id
      // makes a repeated call the same submission rather than a second one.
      const requestId = `restart:${identity}:${self}`;
      try {
        // The continuation is model-written text that lands as the first user
        // message of the new run, so it is labelled before it is submitted.
        await submitEnveloped(conversation, ctx, {
          type: "input",
          src: "restart",
          attrs: { via: "continuation", round: args.roundId },
          content: args.continuation,
          whenBusy: "followUp",
          requestId,
        }, context.getConfig().timezone);
      } catch (error) {
        // No handoff: a reset with no continuation would end this session with
        // nothing to run. A later call with the same reason starts over.
        return text(
          `the continuation was not accepted (${error instanceof Error ? error.message : String(error)}), so nothing was reset. Call again with the same reason.`,
          true,
        );
      }

      context.audit.append({
        type: "session_restart_requested",
        roundId: args.roundId ?? "",
        conversationId: String(self),
      });
      return {
        output: [
          {
            type: "text" as const,
            text: selfRestart
              ? "restarting this conversation on its own, because its context grew long"
              : `restarting this conversation for round "${args.roundId}"`,
          },
        ],
        control: {
          handoff: selfRestart
            ? selfHandoffText(context.getConfig().timezone)
            : handoffText(args.roundId as string, context.getConfig().timezone),
        },
      };
    },
  });

  const cascadeStart = defineTool({
    name: "restart_cascade_start",
    description:
      "Open a restart round over your own subagents: record each child, note the entry id it is at now, and send each child one note that tells it to restart itself after its own children are ready. Start it only when the prompt source is settled. The root opens a round on its own judgment, and the round needs no approval from the user. A round already open here is refused, so close it first. Waiting is a count, not a clock: children that stopped or died count as finished. It returns the round id, so use that id in the other three tools.",
    parameters: obj(
      {
        reason: str({ description: "What changed and why every session must start again. It reaches every child." }),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const harness = requireHarness(context);
      const self = api.conversationId;
      const hub = context.subagents;
      if (hub === undefined) return text("the subagents extension is not installed, so there are no children to read", true);

      // Every child of this conversation is a target, a focused chat included:
      // it is a sub-session of the root with the same prompt baseline, so a
      // prompt that moved has not reached it either. An archived or deleted chat
      // is not here, because both retire the parent's index entry.
      //
      // Every store read happens before the commit: the commit holds the one
      // mutation line, so it must not wait on a scan of the whole tree.
      const children = await hub.children(self, ctx);
      const roundId = ulid();
      const targets: RestartTargetRecord[] = [];
      const kinds = new Map<string, AgentRecord["kind"]>();
      for (const child of children) {
        kinds.set(String(child.conversationId), child.kind);
        targets.push(newTarget(child, await latestEntryId(context, Number(child.conversationId) as ConversationId, ctx)));
      }

      const note = childNote(roundId, args.reason);
      const sizeProblem = hub.sizeProblem(note);
      if (sizeProblem !== undefined) return text(`the note cannot be sent: ${sizeProblem}`, true);

      const now = Date.now();
      // The open check and the open are one read-modify-write in one commit. Two
      // calls of one tool round run in parallel; a check before the commit would
      // read the same unchanged document in both, and the second write would
      // bury the first round with its targets and its ids.
      const opened = await harness.commit(
        async (tx): Promise<{ refusal: string; round?: undefined } | { refusal?: undefined; round: RestartRoundRecord }> => {
          const doc = await tx.doc(SecRestartRound, self, ROUND_KEY, ROUND_KEY);
          if (doc.startedAt !== 0 && doc.closedAt === 0) {
            // Nothing is written: the document keeps the open round's targets.
            return {
              refusal: `round "${doc.roundId}" is still open for this conversation. Count it with \`restart_cascade_status\` and close it with \`restart_cascade_close\` before opening another.`,
            };
          }
          doc.roundId = roundId;
          doc.reason = args.reason;
          doc.startedAt = now;
          doc.targets = targets;
          doc.closedAt = 0;
          doc.closeNote = "";
          doc.unconfirmed = [];
          doc.updatedAt = now;
          return { round: plain(doc) };
        },
        ctx,
      );

      if (opened.round === undefined) return text(opened.refusal, true);
      await mirrorRound(context, String(self), opened.round);
      context.audit.append({
        type: "session_restart_opened",
        roundId,
        conversationId: String(self),
        targets: targets.length,
      });

      const me = await hub.nameOf(self, ctx);
      const problems: string[] = [];
      const written = new Map<string, string>();
      for (const target of opened.round.targets) {
        // A note, not an order: the child may be mid-work, and a note queued in
        // its inbox is placed at its next boundary. That queue is the
        // serialisation, so there is nothing to check about idleness first.
        //
        // The boundary it waits for is the one between tool rounds, not the end of
        // the run. A child inside one long run used to read the note only after
        // that run ended, which kept the round open for hours while nobody knew. A
        // `steer` note arrives between two tool rounds, so the child reads it,
        // finishes the unit it is in, and restarts. It still never interrupts the
        // run.
        const message = await hub.writeMessage(ctx, {
          from: { conversationId: String(self), name: me.name, agentKind: me.kind },
          // The kind is the child's own, so the envelope names a focused chat as
          // one and a subagent as one.
          to: {
            conversationId: target.conversationId,
            name: target.name,
            agentKind: kinds.get(target.conversationId) ?? "subagent",
          },
          kind: "note",
          body: note,
        });
        written.set(target.name, message.id);
        const delivery = await hub.deliver(ctx, message, "steer");
        if (!delivery.delivered) problems.push(`${target.name}: ${delivery.problem ?? "not delivered"}`);
      }

      // The ids are recorded in a second commit that reads the document again.
      // Between the two, the round may have been counted, or closed and replaced:
      // writing the first commit's result back would undo whichever of those
      // happened, so only the ids are written and only under the same round.
      if (written.size > 0) {
        const after = await harness.commit(async (tx) => {
          const doc = await tx.doc(SecRestartRound, self, ROUND_KEY, ROUND_KEY);
          if (doc.roundId !== roundId || doc.startedAt !== now) return undefined;
          for (const target of doc.targets) {
            const messageId = written.get(target.name);
            if (messageId !== undefined) target.messageId = messageId;
          }
          doc.updatedAt = Date.now();
          return plain(doc);
        }, ctx);
        if (after !== undefined) await mirrorRound(context, String(self), after);
      }

      const lines = [
        `round "${roundId}" is open over ${targets.length} target(s).`,
        ...targets.map((target) => `- ${describeTarget(target)}`),
      ];
      if (problems.length > 0) lines.push(`Not delivered: ${problems.join("; ")}. They are recorded in the ledger.`);
      if (targets.length === 0) {
        lines.push("You have no children, so there is nothing to count: restart yourself with `restart_session` now.");
      } else {
        lines.push(
          `Next: wait for their notes, then call \`restart_cascade_status\` with roundId "${roundId}" until every target is ready, and then call \`restart_session\` with the same round id.`,
        );
      }
      return text(lines.join("\n"));
    },
  });

  const cascadeStatus = defineTool({
    name: "restart_cascade_status",
    description:
      "Count a restart round you opened. For each target it reads the child's entry log from the id recorded when the round opened, and asks whether a `pi.reset` followed by a `pi.system` is there, which means the child started again on the new prompt. A child whose agent record is stopped, failed, deleted or gone counts as finished too. It writes what it found back into the ledger, so call it whenever you are woken.",
    parameters: obj(
      {
        roundId: str({ description: "The round to count, as `restart_cascade_start` returned it." }),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const self = api.conversationId;
      const harness = requireHarness(context);
      // The snapshot fixes the round under this id and the targets to count. The
      // verdicts are read from the logs outside the commit; the commit only
      // writes them, and only while the same round is still there.
      const snapshot = await harness.snapshot(SecRestartRound, self, ROUND_KEY, ctx);
      if (snapshot === undefined || snapshot.startedAt === 0) {
        return text(
          `no restart round is recorded for this conversation, so "${args.roundId}" cannot be read. Open one with \`restart_cascade_start\`.`,
          true,
        );
      }
      if (snapshot.roundId !== args.roundId) {
        return text(`this conversation's recorded round is "${snapshot.roundId}", not "${args.roundId}".`, true);
      }
      // A closed round keeps the verdicts its close recorded: counting it again
      // would rewrite them and tell the owner to close what is already closed.
      if (snapshot.closedAt !== 0) return text(`round "${args.roundId}" is already closed, so it is not counted again. Open a new round with \`restart_cascade_start\` when a new prompt has to reach your children.`, true);

      const checkedAt = Date.now();
      const verdicts = new Map<string, Verdict>();
      for (const target of snapshot.targets) {
        const record = await harness.snapshot(SecAgent, target.conversationId, ctx);
        const finished = finishedReason(record);
        if (finished !== undefined) {
          verdicts.set(target.name, finishedVerdict(finished));
          continue;
        }
        const conversationId = Number(target.conversationId) as ConversationId;
        const conversation = await harness.conversation(conversationId, ctx);
        if (conversation === undefined) {
          verdicts.set(target.name, finishedVerdict(`conversation ${target.conversationId} is gone, so it ended`));
          continue;
        }
        const scan = await scanLog(logReader(context, conversationId, target.sinceId, caps.page, ctx), target.sinceId, caps);
        verdicts.set(target.name, verdictOf(scan));
      }

      const updated = await harness.commit(
        async (tx): Promise<RestartRoundRecord | "closed" | undefined> => {
          const doc = await tx.doc(SecRestartRound, self, ROUND_KEY, ROUND_KEY);
          if (doc.roundId !== args.roundId || doc.startedAt === 0) return undefined;
          if (doc.closedAt !== 0) return "closed";
          for (const target of doc.targets) {
            const verdict = verdicts.get(target.name);
            if (verdict === undefined) continue;
            target.verdict = verdict.verdict;
            target.counted = verdict.counted;
            target.reason = verdict.reason;
            target.resetId = verdict.resetId;
            target.systemId = verdict.systemId;
            target.checkedAt = checkedAt;
          }
          doc.updatedAt = checkedAt;
          return plain(doc);
        },
        ctx,
      );
      if (updated === undefined) {
        return text(
          `this conversation no longer holds round "${args.roundId}", so nothing was written. Count the round it holds now.`,
          true,
        );
      }
      if (updated === "closed") return text(`round "${args.roundId}" is already closed, so it is not counted again. Open a new round with \`restart_cascade_start\` when a new prompt has to reach your children.`, true);
      await mirrorRound(context, String(self), updated);

      const targetList = updated.targets;
      const counted = targetList.filter((target) => target.counted);
      const unconfirmed = targetList.filter((target) => target.verdict === "unconfirmed").map((target) => target.name);
      // A ready round is the only one the status words as a next step, so the
      // scan of this conversation's own log happens only then. The conversation
      // may have reset for this round already, and then `restart_session` is not
      // the next step: the round has one step left, and that is the close.
      const selfReset =
        counted.length === targetList.length ? await selfResetSinceRound(context, self, updated, caps, ctx) : false;
      const lines = [
        `round "${args.roundId}": ${counted.length}/${targetList.length} target(s) counted.`,
        ...targetList.map(
          (target) => `- ${describeTarget(target)}: ${target.verdict} — ${target.reason === "" ? "not counted yet" : target.reason}`,
        ),
      ];
      if (counted.length === targetList.length) {
        if (unconfirmed.length === 0) {
          lines.push(
            selfReset
              ? "Every target is ready. This conversation already reset after this round opened, so do not call `restart_session` again. Close the round with `restart_cascade_close`."
              : "Every target is ready. Call `restart_session` with this round id, then close the round with `restart_cascade_close`.",
          );
        } else if (selfReset) {
          lines.push(
            `Counted as finished without evidence: ${unconfirmed.join(", ")}. The round does not wait for them. This conversation already reset after this round opened, so do not call \`restart_session\` again. Close the round with \`restart_cascade_close\`.`,
          );
        } else {
          lines.push(
            `Counted as finished without evidence: ${unconfirmed.join(", ")}. The round does not wait for them: call \`restart_session\` with this round id, then close the round with \`restart_cascade_close\`.`,
          );
        }
      } else {
        lines.push(
          "Not every target is counted. Wait to be woken and count again. A child that never answers can be deleted, and a deleted child counts as finished.",
        );
      }
      return text(lines.join("\n"));
    },
  });

  const cascadeClose = defineTool({
    name: "restart_cascade_close",
    description:
      "Close a restart round you opened, recording when it closed and which targets were never seen to be ready. Closing does not restart anything and does not undo a reset. Only the root agent tells the user; a subagent reports to its parent with `await_orders`, and the root decides what the user hears.",
    parameters: obj(
      {
        roundId: str({ description: "The round to close." }),
        note: str({ description: "How the round went, for the ledger and for the user." }),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const self = api.conversationId;
      const harness = requireHarness(context);
      // A conversation with no round document is refused before the commit, and
      // only for that: reading a document that does not exist inside a commit
      // creates the row, and a refused close would leave one behind. Everything
      // that decides the close is still decided in the commit below.
      if ((await harness.snapshot(SecRestartRound, self, ROUND_KEY, ctx)) === undefined) {
        return text(
          `no restart round is recorded for this conversation, so "${args.roundId}" cannot be closed. Open one with \`restart_cascade_start\`.`,
          true,
        );
      }
      // One commit for the whole close: the round id check, the open check, the
      // list of targets never confirmed, and the close itself. A close that was
      // read and written apart could record a list from a superseded round.
      const result = await harness.commit(
        async (tx): Promise<{ refusal: string; round?: undefined } | { refusal?: undefined; round: RestartRoundRecord }> => {
          const doc = await tx.doc(SecRestartRound, self, ROUND_KEY, ROUND_KEY);
          if (doc.startedAt === 0) {
            return {
              refusal: `no restart round is recorded for this conversation, so "${args.roundId}" cannot be closed. Open one with \`restart_cascade_start\`.`,
            };
          }
          if (doc.roundId !== args.roundId) {
            return { refusal: `this conversation's recorded round is "${doc.roundId}", not "${args.roundId}".` };
          }
          if (doc.closedAt !== 0) {
            return { refusal: `round "${args.roundId}" is already closed. Read it, or open a new round.` };
          }
          // Never confirmed: still waiting, or counted without evidence. Both are
          // what the operator has to hear about, and neither holds the round.
          const unconfirmed = doc.targets
            .filter((target) => target.verdict === "waiting" || target.verdict === "unconfirmed")
            .map((target) => target.name);
          doc.closedAt = Date.now();
          doc.closeNote = args.note;
          doc.unconfirmed = unconfirmed;
          doc.updatedAt = doc.closedAt;
          return { round: plain(doc) };
        },
        ctx,
      );
      if (result.round === undefined) return text(result.refusal, true);
      await mirrorRound(context, String(self), result.round);
      const unconfirmed = result.round.unconfirmed;
      context.audit.append({
        type: "session_restart_closed",
        roundId: args.roundId,
        conversationId: String(self),
        unconfirmed,
      });

      const lines = [
        `round "${args.roundId}" is closed. ${result.round.targets.length - unconfirmed.length} of ${result.round.targets.length} target(s) were confirmed ready.`,
      ];
      if (unconfirmed.length > 0) lines.push(`Never confirmed ready: ${unconfirmed.join(", ")}. They are recorded in the ledger.`);
      lines.push(
        "Only the root agent notifies the user. If you are a subagent, report to your parent with `await_orders` instead.",
      );
      return text(lines.join("\n"));
    },
  });

  /**
   * What the model reads about restarting a session, chosen by its own tools.
   *
   * `session_stale` is the root's tool, `restart_cascade_*` is an agent's that
   * starts children, and `restart_session` is what a focused chat is told about by
   * a note from the root. A scheduled run has none of them and no session to
   * restart, so it reads no section at all. The tool list is written in the commit
   * that creates the conversation and never changes, so the choice is as stable
   * as any other value a section renders.
   */
  const guide = section("session-restart", (input) => {
    const offered = new Set(input.agent.tools.map((tool) => tool.name));
    const opening =
      "A running session keeps the system prompt values it started with, so a changed prompt reaches a conversation only at a new session: a new conversation, a reset, or a compaction. A cold restart is none of those, so it does not carry a new prompt into a session that is already running.";
    const restart =
      "`restart_session` restarts this conversation: your context is cut and a new run starts with the `continuation` you write. Write that text for the user, because it is what they read where the reset happened. The reset is a one-way door for this session; the context is forkable, not recoverable. When the harness puts a restart advice on one of your inputs, that advice is a suggestion, not a command: at the next resting point between units of work, make your state file current and call it with a reason and no round id.";
    const again =
      "If the continuation you wrote arrives while the conversation before it is still there, the reset did not happen: call `restart_session` again, with the same round id when a round gave you one, and with no round id when you restarted on your own.";
    if (offered.has("session_stale")) {
      return [
        opening,
        "A changed prompt source is not written into the conversation. Ask `session_stale` before every `await_orders`, and before you open a round; it reports the sections whose source has moved since this session started. Only the root has that tool.",
        "When the answer is yes, open the round once the work unit in flight is finished and no prompt source write is left; otherwise look again at the next milestone. The root opens a round on its own judgment and asks the user for no approval. A daemon restart is different: only the user applies it.",
        restart,
        "To carry a new prompt through a tree, the parent opens a round with `restart_cascade_start` and every child restarts itself. Start a round only when no prompt source write is left to do.",
        "A child is ready when its entry log holds a `pi.reset` with a `pi.system` after it, or when its agent record is stopped, failed, deleted or gone. Count with `restart_cascade_status`, which writes what it found into the ledger at " +
          `${restartDir(paths)}/<conversationId>.json` +
          ".",
        "There is no time limit. Wait for the children's notes, count again, and restart yourself with `restart_session` once every target is ready. Close the round with `restart_cascade_close`. Only the root agent notifies the user; a subagent reports to its parent.",
        again,
      ].join("\n");
    }
    if (offered.has("restart_cascade_start") && offered.has("restart_session")) {
      return [
        opening,
        "The root opens a round on its own judgment and asks the user for no approval. A daemon restart is different: only the user applies it.",
        restart,
        "To carry a new prompt through a tree, the parent opens a round with `restart_cascade_start` and every child restarts itself. Start a round only when no prompt source write is left to do.",
        "A child is ready when its entry log holds a `pi.reset` with a `pi.system` after it, or when its agent record is stopped, failed, deleted or gone. Count with `restart_cascade_status`, which writes what it found into the ledger at " +
          `${restartDir(paths)}/<conversationId>.json` +
          ".",
        "There is no time limit. Wait for the children's notes, count again, and restart yourself with `restart_session` once every target is ready. Close the round with `restart_cascade_close`. Only the root agent notifies the user; a subagent reports to its parent.",
        again,
      ].join("\n");
    }
    if (offered.has("restart_session")) {
      return [
        opening,
        "The root opens a round on its own judgment and asks the user for no approval. A daemon restart is different: only the user applies it.",
        restart,
        "When a note from the root opens a restart round, finish what you are doing and call `restart_session` with the round id that the note gives.",
        again,
      ].join("\n");
    }
    return undefined;
  });

  /**
   * The restart advice: mark a conversation whose answer passed the size the
   * install set.
   *
   * The size is the request the provider answered — its input tokens, its cache
   * reads and its cache writes — and it is read from the answer itself, so this
   * costs no model call and no stored document. Nothing is generated here: the
   * mark is memory only, and the advice text itself is written by
   * `src/context-advice.ts` when that conversation next receives an input.
   *
   * A mark lost to a daemon restart is not a loss: the next answer of a
   * conversation that is still long passes the threshold again and marks it again.
   *
   * The hook runs for every conversation, so the target check comes first and
   * costs one config read for anything that is not the root.
   */
  const advice = hook(GenerationTask, {
    afterResponse: async (message, api, ctx) => {
      const usage = message.usage;
      if (usage === undefined) return;
      const size = usage.input + usage.cacheRead + usage.cacheWrite;
      if (size <= 0) return;
      const threshold = context.getConfig().agent.contextRestart.thresholdTokens;
      if (threshold <= 0) return;
      if (size < threshold) return;
      if (!(await adviceTargetOf(context, api.conversationId, ctx))) return;
      context.contextAdvice.noteResponse(api.conversationId, size);
    },
  });

  return defineExtension({
    name: "session-restart",
    tools: [restartSession, cascadeStart, cascadeStatus, cascadeClose],
    hooks: [advice],
    sections: [guide],
  });
}
