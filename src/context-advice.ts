import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { Config } from "./config/schema.ts";
import { ENVELOPE_CLOSE, readMessage } from "./message-envelope.ts";
import type { Logger } from "./runtime/logger.ts";

/**
 * The restart advice: a short text the harness puts on one input of a conversation
 * whose context has grown long.
 *
 * A long session costs more than it saves. Its every request carries the whole
 * context, the provider caches that context for minutes at a time, and a model
 * that reads a very long history judges more weakly than one that reads a state
 * file. So when a conversation passes the size an install sets, this module asks
 * the agent, once, to tidy its state file and start a new session of its own.
 *
 * Four rules shape it, and each is a cost paid once per advice:
 *
 *   No extra model call. The size is read from the answer the provider already
 *   sent (`input + cacheRead + cacheWrite`, the request it answered), in the
 *   `afterResponse` hook. Nothing is generated and nothing is judged.
 *
 *   Stored, not injected. The advice is written into the stored text of the next
 *   input of that conversation, after the envelope's closing tag, exactly where a
 *   reminder used to go. So the request prefix of the next request still matches
 *   the one before it, and the provider's prompt cache stays warm. An injection
 *   at send time would add a line to every prompt.
 *
 *   Once per session. The fact that the advice went in is readable later: the
 *   stored input carries the `[restart advice]` first line. Before appending, the
 *   module reads backward from the newest entry to the entry that started this
 *   session and stops there, so an advice in an earlier session is not counted.
 *   Only text after the envelope's last closing tag counts, because a tool result
 *   or a fetched page can quote the marker inside a body.
 *
 *   Out of sight. The advice sits after the closing tag, so the chat page, which
 *   draws an input from inside its envelope, never shows it. It reaches the model
 *   and the transcript and nobody else.
 *
 * The read of the log happens only when the conversation was marked and an input
 * arrives. A conversation whose answer passed the threshold and that receives no
 * input needs no advice: it is already resting.
 *
 * The second half of this module is the time-based advice, which rests on a
 * different fact. A conversation that goes quiet for long enough earns one
 * suggestion without waiting for an input, because the input that would have
 * carried the advice is exactly the input that pays for the whole context again:
 * the provider's prompt cache expires after about an hour, so the first request
 * after a long silence writes the prefix afresh at full price. A suggestion that
 * arrives while that cache is still warm is cheap to act on, and an agent that
 * takes it starts the next input on a session with a small context. The six
 * conditions below are the whole of it, and the sweep in
 * `src/extensions/subagents.ts` asks this module once per conversation.
 */

/** The first line of the advice, which is also how an earlier advice is found. */
export const RESTART_ADVICE_MARKER = "[restart advice]";

/** The entry kinds that begin a session. The advice stops reading at the newest one. */
export const SESSION_START_KINDS: readonly string[] = ["pi.reset", "pi.compaction"];

/** Entries one backward read looks at before it gives up. */
export const ADVICE_SCAN_LIMIT = 500;

/** Entries one page of that read asks for. */
export const ADVICE_SCAN_PAGE = 200;

/** One entry of a session, as the advice reads it. */
export interface ScannedEntry {
  readonly id: number;
  readonly kind: string;
  /** The text of the entry's user-role messages, joined. Empty for every other entry. */
  readonly text: string;
}

/** What one backward read established about a conversation's current session. */
export interface SessionScan {
  /** The entry that began this session. `0` when the read reached the head of the log instead. */
  readonly startId: number;
  /** The instant that entry carries, in epoch milliseconds. `0` when it carries none. */
  readonly startAt: number;
  /** The entries after that boundary, newest first. */
  readonly entries: readonly ScannedEntry[];
}

/** The text of one entry: its user-role messages only, since an input is a user message. */
function userText(entry: EntryRecord): string {
  let text = "";
  for (const message of entry.model ?? []) {
    if (message.role !== "user") continue;
    const content: unknown = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      text += content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        text += String((part as { text?: unknown }).text ?? "");
      }
    }
  }
  return text;
}

/** The instant an entry carries, from its first message. */
function entryInstant(entry: EntryRecord): number {
  const first = (entry.model ?? [])[0] as { readonly timestamp?: unknown } | undefined;
  const stamp = first?.timestamp;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Read a conversation's current session, newest entry first.
 *
 * The read stops at the newest entry that began a session, which is the entry a
 * session restart writes (`pi.reset`) or a compaction's summary (`pi.compaction`).
 * `undefined` means the conversation could not be read at all; an empty entry list
 * means the session holds nothing after its boundary.
 *
 * The entry cap is what keeps a long session's read to a few pages. A read that
 * reaches the cap without finding a boundary reports `startId: 0`, which says "the
 * head of the log is older than this read" rather than pretending the log began
 * there.
 */
export async function readSessionScan(
  harness: Harness,
  conversationId: ConversationId,
  ctx: Context,
  options: { readonly limit?: number; readonly page?: number } = {},
): Promise<SessionScan | undefined> {
  const conversation = await harness.conversation(conversationId, ctx);
  if (conversation === undefined) return undefined;
  const limit = options.limit ?? ADVICE_SCAN_LIMIT;
  const pageSize = options.page ?? ADVICE_SCAN_PAGE;
  const entries: ScannedEntry[] = [];
  let cursor: Cursor | undefined;
  let read = 0;
  for (;;) {
    const page = await conversation.entries({ order: "descending" }, pageSize, cursor, ctx);
    for (const entry of page.items) {
      read += 1;
      if (SESSION_START_KINDS.includes(entry.kind)) {
        return { startId: entry.id, startAt: entryInstant(entry), entries };
      }
      entries.push({ id: entry.id, kind: entry.kind, text: userText(entry) });
      if (read >= limit) return { startId: 0, startAt: 0, entries };
    }
    if (page.next === undefined) return { startId: 0, startAt: 0, entries };
    cursor = page.next;
  }
}

/**
 * Whether one entry carries the advice where the advice is written.
 *
 * The marker counts only after the envelope's last closing tag. A tool result can
 * hold the same line inside its body, and a body is escaped and is not an advice;
 * reading it as one would silence the real advice for a whole session.
 */
export function carriesAdvice(entry: ScannedEntry): boolean {
  if (entry.text === "") return false;
  const closing = entry.text.lastIndexOf(ENVELOPE_CLOSE);
  const outside = closing === -1 ? "" : entry.text.slice(closing + ENVELOPE_CLOSE.length);
  return outside.includes(RESTART_ADVICE_MARKER);
}

/** Whether this session already carries an advice. */
export function alreadyAdvised(scan: SessionScan): boolean {
  return scan.entries.some(carriesAdvice);
}

/**
 * The advice's text, with the two values filled in.
 *
 * The first line names the text and says what it is, because the model reads it in
 * the same entry as the words a person wrote. The rest names the one action it
 * asks for and the moment to take it. It is a suggestion: nothing here restarts
 * anything, and the agent chooses the resting point.
 */
export function restartAdviceText(size: number, threshold: number): string {
  return [
    `${RESTART_ADVICE_MARKER} This conversation's context is ${Math.round(size)} tokens, past the limit of ${Math.round(threshold)} tokens set for one session. This is a suggestion, not a command.`,
    "When the work you are on reaches a resting point, tidy your state file so the next session can continue from it, and restart this session with `restart_session`, a reason and no round id. Your `continuation` is what the user reads where the context was reset, so say there what you did and what comes next.",
    "If your judgment is already blurring, take that resting point sooner.",
  ].join("\n");
}

/** One input the advice could be appended to. */
export interface AdviceInput {
  readonly conversationId: ConversationId;
  readonly ctx: Context;
  /** The envelope source of the input. */
  readonly src: string;
  /** The envelope's attributes, after the record instant was added. */
  readonly attrs: Readonly<Record<string, string | undefined>>;
}

/**
 * The restart advice, and the mark that says a conversation has earned one.
 *
 * One instance belongs to one runtime. It is reachable through the process-wide
 * pair `setContextAdvice` and `getContextAdvice`, because the module that puts
 * inputs into conversations (`src/submit-envelope.ts`) has no extension context to
 * read it from: it is called from routes, extensions and the scheduler with a
 * conversation and nothing else. With none set, that module stores exactly the
 * text it stored before the advice existed.
 */
export class ContextAdvice {
  readonly #getConfig: () => Config;
  readonly #getHarness: () => Harness | undefined;
  readonly #logger: Logger | undefined;
  /** Per conversation, the context size that passed the threshold and still owes an input. */
  readonly #pending = new Map<string, number>();

  constructor(options: {
    readonly getConfig: () => Config;
    readonly getHarness: () => Harness | undefined;
    readonly logger?: Logger;
  }) {
    this.#getConfig = options.getConfig;
    this.#getHarness = options.getHarness;
    this.#logger = options.logger;
  }

  /**
   * Record the size of one answer's request.
   *
   * The caller has already established that this conversation is a target (the
   * root, or a subagent whose roles are the configured ones). A size under the
   * threshold changes nothing: the mark, when there is one, stays, because it
   * belongs to an earlier answer of the same session.
   *
   * A threshold of `0` turns the advice off, and it also drops any mark already
   * recorded, so a config reload that switches the advice off takes effect at once.
   */
  noteResponse(conversationId: ConversationId, size: number): void {
    const key = String(conversationId);
    const threshold = this.#getConfig().agent.contextRestart.thresholdTokens;
    if (threshold <= 0) {
      this.#pending.delete(key);
      return;
    }
    if (!Number.isFinite(size) || size <= 0) return;
    if (size < threshold) return;
    this.#pending.set(key, size);
  }

  /** The size this conversation owes an advice for, or `undefined`. For tests and diagnostics. */
  pending(conversationId: ConversationId): number | undefined {
    return this.#pending.get(String(conversationId));
  }

  /** Drop the mark of one conversation, used when a read cannot say whether a session already carries one. */
  forget(conversationId: ConversationId): void {
    this.#pending.delete(String(conversationId));
  }

  /**
   * The advice to append to one input, or `""` when none is due.
   *
   * The mark is consumed here whatever the answer is. It belongs to one input: the
   * input after the answer that passed the threshold, and no other. A mark left in
   * place would put the advice on every later input of the session.
   *
   * Two inputs are never advised. A session restart's continuation is the first
   * input of a new, empty session, and nothing about it is long; the new session
   * decides for itself. An input whose conversation cannot be read is not advised
   * either, because the read is the only way to know whether this session already
   * carries one.
   */
  async blockFor(input: AdviceInput): Promise<string> {
    const key = String(input.conversationId);
    const size = this.#pending.get(key);
    if (size === undefined) return "";
    this.#pending.delete(key);

    if (input.src === "restart" && input.attrs["via"] === "continuation") return "";

    const threshold = this.#getConfig().agent.contextRestart.thresholdTokens;
    if (threshold <= 0) return "";

    const harness = this.#getHarness();
    if (harness === undefined) return "";

    let scan: SessionScan | undefined;
    try {
      scan = await readSessionScan(harness, input.conversationId, input.ctx);
    } catch (error) {
      this.#logger?.warn("the restart advice was dropped: the conversation could not be read", {
        conversationId: String(input.conversationId),
        error,
      });
      return "";
    }
    if (scan === undefined) return "";
    if (alreadyAdvised(scan)) return "";
    return restartAdviceText(size, threshold);
  }
}

/** The advice this process appends, when the runtime set one. */
let processAdvice: ContextAdvice | undefined;

/** Set the process-wide advice. The runtime calls this once, at boot. */
export function setContextAdvice(advice: ContextAdvice | undefined): void {
  processAdvice = advice;
}

/** The process-wide advice, or `undefined` when this process has none. */
export function getContextAdvice(): ContextAdvice | undefined {
  return processAdvice;
}

// ------------------------------------------------------------ idle advice

/**
 * The time-based restart advice: one suggestion the harness puts into a
 * conversation that has been quiet for a while.
 *
 * This is the other half of the module's subject. The advice above waits for an
 * input, and the input it waits for is the one that pays for the whole context
 * again once the provider's prompt cache has expired. This half speaks while the
 * conversation is still resting, so the agent can decide before that input
 * arrives, and an agent that restarts starts the next input on a small context.
 *
 * Six conditions decide it, and the judge below is four of them (the other two,
 * "this conversation is a target" and its restart request, are read by the sweep
 * that owns the pass). All six must hold:
 *
 *   1. The conversation is a target. The sweep reads that from the same rule the
 *      size advice uses, so the two cannot disagree about who is spoken to.
 *   2. The conversation itself is not working. A live task of its own is about to
 *      write an entry, so it is not resting. A background call it started is not
 *      counted: the call carries a progress check every half hour, and the user
 *      asked for a time condition on the conversation, not on its tools.
 *   3. It holds no input that has not been placed yet. Such an input is about to
 *      start a run, and the advice would ride along into it.
 *   4. Its newest recorded activity is at least `minutes` old.
 *   5. Its newest answer answered a request of at least `minTokens` tokens. A
 *      conversation with no answer has no size to read, and a small context has
 *      nothing to gain from a restart.
 *   6. This quiet stretch has no advice yet. The record is the log itself: the
 *      newest user-role entry of the session is the advice only when it came in
 *      through the `restart` source marked `via="idle"`.
 *
 * The judgement is here and the submission is in the sweep, because the module
 * that submits (`src/submit-envelope.ts`) reads this module for the size advice,
 * and an import the other way would close that circle.
 */

/** The first line of the time-based advice, and how an earlier one is found. */
export const IDLE_ADVICE_MARKER = "[idle restart advice]";

/** Entries one read of a quiet conversation looks at before it gives up. */
export const IDLE_SCAN_LIMIT = 600;

/** Entries one page of that read asks for. */
export const IDLE_SCAN_PAGE = 200;

/** What one read established about the conversation it read. */
export interface IdleScan {
  /** The newest entry the read saw. The request id is built from it. */
  readonly newestEntryId: number;
  /** The newest activity instant: the newest entry that carries a time. */
  readonly newestAt: number | undefined;
  /** The stored text of the newest user-role entry of this session. */
  readonly newestUserText: string | undefined;
  /** The request size of the newest answer of this session, in tokens. */
  readonly requestSize: number | undefined;
  /** The entry that began this session, or `0` when the read found none. */
  readonly startId: number;
  readonly startAt: number;
}

/** The newest instant one entry carries, or `undefined` when it carries none. */
function entryTime(entry: EntryRecord): number | undefined {
  const stamps = (entry.model ?? [])
    .map((message) => (message as { readonly timestamp?: unknown }).timestamp)
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at > 0);
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

/** The size of the request the newest answer of one entry answered, in tokens. */
function answerSize(entry: EntryRecord): number | undefined {
  const messages = entry.model ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { readonly role?: unknown; readonly usage?: { readonly input?: unknown; readonly cacheRead?: unknown; readonly cacheWrite?: unknown } }
      | undefined;
    if (message?.role !== "assistant" || message.usage === undefined) continue;
    const total = Number(message.usage.input ?? 0) + Number(message.usage.cacheRead ?? 0) + Number(message.usage.cacheWrite ?? 0);
    return Number.isFinite(total) ? total : undefined;
  }
  return undefined;
}

/**
 * Read what the time-based advice asks of one conversation.
 *
 * The read walks the log newest first, one page at a time, and stops at the entry
 * that began this session, exactly as `readSessionScan` does. It also stops early
 * once it can answer: the newest activity is recent, so no older entry can make
 * the conversation quiet, and no later page changes that. A conversation that is
 * not quiet therefore costs one page.
 */
export async function readIdleScan(
  harness: Harness,
  conversationId: ConversationId,
  ctx: Context,
  options: { readonly now: number; readonly minutes: number; readonly limit?: number; readonly page?: number },
): Promise<IdleScan | undefined> {
  const conversation = await harness.conversation(conversationId, ctx);
  if (conversation === undefined) return undefined;
  const limit = options.limit ?? IDLE_SCAN_LIMIT;
  const pageSize = options.page ?? IDLE_SCAN_PAGE;
  const since = options.now - options.minutes * 60_000;
  let cursor: Cursor | undefined;
  let read = 0;
  let newestEntryId = 0;
  let newestAt: number | undefined;
  let newestUserText: string | undefined;
  let requestSize: number | undefined;
  const found = (): IdleScan => ({ newestEntryId, newestAt, newestUserText, requestSize, startId: 0, startAt: 0 });
  for (;;) {
    const page = await conversation.entries({ order: "descending" }, pageSize, cursor, ctx);
    for (const entry of page.items) {
      read += 1;
      if (newestEntryId === 0) newestEntryId = entry.id;
      if (SESSION_START_KINDS.includes(entry.kind)) {
        return { ...found(), startId: entry.id, startAt: entryInstant(entry) };
      }
      if (newestAt === undefined) newestAt = entryTime(entry);
      if (newestUserText === undefined) {
        const text = userText(entry);
        if (text !== "") newestUserText = text;
      }
      if (requestSize === undefined) requestSize = answerSize(entry);
      if (read >= limit) return found();
    }
    if (page.next === undefined) return found();
    // The newest activity is recent, so the conversation is not quiet and no
    // later page can say otherwise.
    if (newestAt !== undefined && newestAt > since) return found();
    if (newestUserText !== undefined && requestSize !== undefined) return found();
    cursor = page.next;
  }
}

/** Whether this quiet stretch already carries the time-based advice. */
export function idleAdvised(scan: IdleScan): boolean {
  if (scan.newestUserText === undefined) return false;
  const message = readMessage(scan.newestUserText);
  if (message === undefined) return false;
  return message.source === "restart" && message.attrs["via"] === "idle";
}

/**
 * The advice's text, with the two values filled in.
 *
 * The first line names the text, says how long the conversation has been quiet and
 * says what it is not. The rest gives the one action and the moment to take it, and
 * then the opposite case, because the rules the agent already reads say that a
 * restart advice is to be taken at a resting point: this text has to say when that
 * rule does not apply. The last line says how often it comes, so an agent that
 * decides to stay does not wait for another one.
 */
export function idleAdviceText(minutes: number, size: number): string {
  return [
    `${IDLE_ADVICE_MARKER} Nothing has happened in this conversation for ${Math.round(minutes)} minutes. This is a suggestion, not a command.`,
    `Your context is ${Math.round(size)} tokens. If you expect no input for a while, tidy your state file so the next session can continue from it, and restart this session with \`restart_session\`, a reason and no round id. Your \`continuation\` is what the user reads where the context was reset, so say there what you did and what comes next.`,
    "Leave this session as it is when an input is likely soon: a report from a child agent, the result of a background call, an order from your parent, or an answer from the user. Restarting pays off only when the next input would find a long context that the provider no longer holds in its cache.",
    "This conversation gets one message for one quiet stretch. The next one comes after a new input.",
  ].join("\n");
}

/** One conversation, and what the sweep knows about it before the read. */
export interface IdleAdviceInput {
  readonly harness: Harness;
  readonly conversationId: ConversationId;
  readonly ctx: Context;
  readonly now: number;
  /** `agent.contextRestart.idle.minutes`; `0` turns the advice off. */
  readonly minutes: number;
  /** `agent.contextRestart.idle.minTokens`; `0` ignores the size. */
  readonly minTokens: number;
  /** Live tasks of this conversation, its background calls left out. */
  readonly working: number;
  /**
   * Reads the inputs admitted to this conversation and not yet placed. A function,
   * because the sweep reads that inbox only for a conversation that passed the
   * cheaper conditions.
   */
  readonly queued: () => Promise<number>;
  /** Whether a daemon restart request is up. */
  readonly restartUp: boolean;
}

/** What one pass decided: the advice to submit, or why there is none. */
export type IdleAdviceOutcome =
  | {
      readonly kind: "due";
      readonly entryId: number;
      readonly requestId: string;
      readonly text: string;
      readonly size: number;
    }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * Judge one conversation, and build the advice when it is owed.
 *
 * The request id carries the conversation and the newest entry the judgement saw.
 * A quiet conversation's newest entry does not change, so two passes that overlap
 * compute the same id, and the harness refuses the second submission under an id
 * it already holds. That covers the gap between the decision and the placement,
 * which the log cannot cover: an advice still in the inbox is not an entry yet.
 * Once it is placed, the last condition reads it from the log.
 */
export async function idleAdvice(input: IdleAdviceInput): Promise<IdleAdviceOutcome> {
  if (!(input.minutes > 0)) return { kind: "skip", reason: "the advice is off" };
  if (input.restartUp) return { kind: "skip", reason: "a daemon restart request is up" };
  if (input.working > 0) return { kind: "skip", reason: "the conversation is working" };
  let scan: IdleScan | undefined;
  try {
    scan = await readIdleScan(input.harness, input.conversationId, input.ctx, {
      now: input.now,
      minutes: input.minutes,
    });
  } catch {
    return { kind: "skip", reason: "the conversation could not be read" };
  }
  if (scan === undefined) return { kind: "skip", reason: "the conversation could not be read" };
  if (scan.newestAt === undefined) return { kind: "skip", reason: "the conversation records no activity" };
  if (input.now - scan.newestAt < input.minutes * 60_000) return { kind: "skip", reason: "the conversation is not quiet yet" };
  if ((await input.queued()) > 0) return { kind: "skip", reason: "an input is waiting to be placed" };
  const size = scan.requestSize;
  if (size === undefined) return { kind: "skip", reason: "the conversation has no answer to measure" };
  if (input.minTokens > 0 && size < input.minTokens) return { kind: "skip", reason: "the context is below the minimum" };
  if (idleAdvised(scan)) return { kind: "skip", reason: "this quiet stretch already has the advice" };
  return {
    kind: "due",
    entryId: scan.newestEntryId,
    requestId: `idle-restart:${input.conversationId}:${scan.newestEntryId}`,
    text: idleAdviceText(input.minutes, size),
    size,
  };
}
