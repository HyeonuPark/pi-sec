/**
 * How one entry's text becomes a row: the envelope, the markers, and the
 * folded-message table.
 *
 * This is the reader the hand-written chat page carried (removed in this
 * commit): `readEnvelope` is the browser's copy
 * of `src/message-envelope.ts`, and the marker lines are the server's own
 * (`src/review.ts`, `src/approvals/input.ts`, the answer route). The browser
 * cannot import a server module from `src/`, so the two sides stay in step by
 * hand, and the tests below keep the reader honest. The one judgement both sides
 * need, of an answer that says nothing, lives in `src/shared/silent-turn.ts` so
 * that the server reads the same rule the page does.
 *
 * The order the cards are read in matters: approval before review before answer,
 * because an approval's text is an envelope marked `via="approval"` and a review's
 * is one marked with a report, and the same text must not draw two cards.
 */
import type { ConversationEntry } from "../../../shared/wire/conversation.ts";

const ENVELOPE_OPEN = "<pi-message";
const ENVELOPE_CLOSE = "</pi-message>";
/** The closing string without its `>`, which is the prefix the server escapes. */
const ENVELOPE_CLOSE_PREFIX = "</pi-message";

/** Every source the server writes, from `MESSAGE_SOURCES`. A stranger reads as `unknown`. */
const ENVELOPE_SOURCES = [
  "operator",
  "operator-scheduled",
  "tool-output",
  "agent",
  "restart",
  "section",
  "system",
  "compaction",
  "unknown",
];

/** The one source that keeps a bubble: a message the operator typed in the chat. */
export const OPERATOR_SOURCE = "operator";

/** The marker the server puts on the first line of a review input. */
const REVIEW_MARKER = "[pi-sec review]";

/** The marker the server puts on the first line of an approval input. */
const APPROVAL_MARKER = "[pi-sec approve]";

/** A message envelope, read off one entry's text. */
export interface Envelope {
  /** One of {@link ENVELOPE_SOURCES}, or `unknown`. */
  readonly source: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** The body with the envelope taken off and the server's escaping undone. */
  readonly body: string;
}

/** One message that folds into a working stretch. */
export interface FoldedMessage {
  readonly source: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly body: string;
}

/** A note from the report viewer. */
export interface Review {
  readonly report: string;
  readonly version: string;
  readonly body: string;
}

/** An approval of one report revision. */
export interface Approval {
  readonly report: string;
  readonly version: string;
  /** `done` when the user pressed Done rather than Approve. */
  readonly button: string;
  /**
   * The user's own words, when a Done carried them: everything after the
   * follow-up paragraph's marker line. Empty for an approval without text.
   */
  readonly text: string;
  readonly body: string;
}

/** One answered `ask_user` question. */
export interface Answer {
  readonly question: string;
  readonly answer: string;
}

function decodeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The escaping the server undoes inside a body: the closing prefix first, then the
 * opening string. The `>` after an escaped closing prefix is not part of the
 * substitution, so it stays where the body had it.
 */
function unescapeEnvelopeBody(text: string): string {
  return text.replaceAll("&lt;/pi-message", ENVELOPE_CLOSE_PREFIX).replaceAll("&lt;pi-message", ENVELOPE_OPEN);
}

/** Read the attributes of an envelope's first line, or of a legacy tag's. */
function readAttributes(line: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) attributes.set(name, decodeAttribute(value));
  }
  return attributes;
}

/**
 * Read a message envelope, or `undefined` when the text carries none.
 *
 * The body is the original text. The escaping is undone last, so a body's
 * `&lt;pi-message` can never become a tag a reader acts on. The closing tag is the
 * last one in the text, which is always the one the envelope wrote.
 */
export function readEnvelope(text: string): Envelope | undefined {
  const trimmed = String(text ?? "").trimStart();
  if (!trimmed.startsWith(`${ENVELOPE_OPEN} `) && !trimmed.startsWith(`${ENVELOPE_OPEN}>`)) return undefined;
  const newline = trimmed.indexOf("\n");
  const first = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1);

  const attributes = readAttributes(first);
  const source = attributes.get("src");

  const closing = rest.lastIndexOf(ENVELOPE_CLOSE);
  let body = closing === -1 ? rest : rest.slice(0, closing);
  // The line break before the closing tag belongs to the envelope, not the body.
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return {
    source: source !== undefined && ENVELOPE_SOURCES.includes(source) ? source : "unknown",
    attributes,
    body: unescapeEnvelopeBody(body),
  };
}

/**
 * Read a review input, or `undefined` when this is an ordinary message.
 *
 * A note written now is wrapped in an envelope and keeps the marker line as its
 * body, so the envelope is unwrapped first and the marker is then looked for. An
 * envelope that names the report as an attribute is read from those attributes.
 */
export function parseReview(text: string): Review | undefined {
  const envelope = readEnvelope(text);
  if (envelope !== undefined) {
    const report = envelope.attributes.get("report");
    if (report !== undefined && report !== "") {
      return {
        report,
        version: envelope.attributes.get("version") ?? envelope.attributes.get("v") ?? "",
        body: envelope.body,
      };
    }
    if (envelope.source !== OPERATOR_SOURCE) return undefined;
    return parseLegacyReview(envelope.body);
  }
  return parseLegacyReview(text);
}

/** The marker line's reader, kept for text written before the envelope. */
function parseLegacyReview(text: string): Review | undefined {
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (!first.startsWith(REVIEW_MARKER)) return undefined;

  const body = (newline === -1 ? "" : text.slice(newline + 1)).replace(/^\n+/, "");
  const named = readMarkerFields(first.slice(REVIEW_MARKER.length));
  if (named.report === "") return undefined;
  return { report: named.report, version: named.version, body };
}

/** The `report=` and `v=` fields of a marker line, in the order the server writes them. */
function readMarkerFields(rest: string): { report: string; version: string } {
  let report = "";
  let version = "";
  for (const field of rest.trim().split(/\s+/)) {
    const [key, value] = field.split("=");
    if (key === "report" && value !== undefined && value !== "") report = value;
    if (key === "v" && value !== undefined && value !== "") version = value;
  }
  return { report, version };
}

/**
 * The label line the follow-up paragraph of a Done puts before the user's words.
 *
 * The route writes it once, and the card reads it to keep the agent's own
 * instructions off the screen: a card shows the report and what the user wrote, and
 * the paragraph between the two is for the root.
 */
const FOLLOW_UP_LABEL = "The user's words:";

/**
 * Read an approval input, or `undefined` when this is an ordinary message.
 *
 * The route writes an approval in an envelope marked `via="approval"`, and the
 * marker line names the report and the revision. Without an envelope the marker
 * line decides on its own, the same fallback the review reader keeps.
 */
export function parseApprovalInput(text: string): Approval | undefined {
  const envelope = readEnvelope(text);
  if (envelope !== undefined) {
    if (envelope.attributes.get("via") !== "approval") return undefined;
    return parseApprovalMarker(envelope.body);
  }
  return parseApprovalMarker(text);
}

function parseApprovalMarker(text: string): Approval | undefined {
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (!first.startsWith(APPROVAL_MARKER)) return undefined;
  const rest = first.slice(APPROVAL_MARKER.length);
  const named = readMarkerFields(rest);
  if (named.report === "") return undefined;
  const body = (newline === -1 ? "" : text.slice(newline + 1)).replace(/^\n+/, "");
  // `button=done` is the one field beyond the report and the revision that the
  // card reads, and it is read from the marker line rather than the sentence: the
  // marker is the machine-readable half.
  const button = rest.trim().split(/\s+/).some((field) => field === "button=done") ? "done" : "";
  return { report: named.report, version: named.version, button, text: approvalText(body), body };
}

/**
 * The user's words in a Done's body, or nothing.
 *
 * The body is the sentence about the press, then, when the user wrote something, a
 * blank line and a paragraph that ends with the label. The words after that label
 * are the user's own and nothing else, so they are what the card shows.
 */
function approvalText(body: string): string {
  const at = body.indexOf(FOLLOW_UP_LABEL);
  if (at === -1) return "";
  const after = body.slice(at + FOLLOW_UP_LABEL.length);
  return after.replace(/^\n+/, "").trimEnd();
}

/**
 * The label lines an answer carries, in the order the answer route writes them.
 *
 * The route writes them in one fixed order, and the reader leans on that order:
 * the question is what comes before the options, and the answer is the last label,
 * so a value of several lines is read whole.
 */
const ANSWER_LABELS = ["Question:", "Options:", "Answer:"] as const;
type AnswerLabel = (typeof ANSWER_LABELS)[number];

/** The label this line starts with, or `undefined` when it starts with none. */
function answerLabelAt(line: string): AnswerLabel | undefined {
  const trimmed = line.trimStart();
  return ANSWER_LABELS.find((label) => trimmed.startsWith(label));
}

/** The value of the label at `index`: the rest of its line, then every line up to `end`. */
function answerLabelValue(lines: readonly string[], index: number, end: number): string {
  const line = lines[index] ?? "";
  const label = answerLabelAt(line) ?? "";
  return [line.trimStart().slice(label.length), ...lines.slice(index + 1, end)].join("\n").trim();
}

/**
 * Read an answer to an `ask_user` question, or `undefined` when this is an
 * ordinary message.
 *
 * The answer arrives as operator input marked `via="ask-user"`. That attribute
 * alone does not identify a card, so the body must carry both marker lines as
 * well.
 */
export function parseAnswerInput(text: string): Answer | undefined {
  const envelope = readEnvelope(text);
  if (envelope === undefined) return undefined;
  if (envelope.attributes.get("via") !== "ask-user") return undefined;
  return parseAnswerBody(envelope.body);
}

/** The two marker lines decide, and both have to be there. */
function parseAnswerBody(text: string): Answer | undefined {
  const lines = text.split("\n");
  const questionAt = lines.findIndex((line) => answerLabelAt(line) === "Question:");
  const optionsAt = lines.findIndex((line) => answerLabelAt(line) === "Options:");
  // The route writes the labels in one fixed order, so its own `Answer:` line is
  // the first one after the options.
  const answerAt = lines.findIndex((line, index) => answerLabelAt(line) === "Answer:" && index > optionsAt);
  if (questionAt === -1 || answerAt === -1) return undefined;
  return {
    question: answerLabelValue(lines, questionAt, optionsAt === -1 ? questionAt + 1 : optionsAt),
    answer: answerLabelValue(lines, answerAt, lines.length),
  };
}

/** The two tags the envelope replaced, and the source each one names. */
const LEGACY_MESSAGE_TAGS = [
  { tag: "tool-call-output", source: "tool-output" },
  { tag: "agent-message", source: "agent" },
] as const;

/** Prefix of a restart's handoff text. */
const RESTART_PREFIX = "[restart ";

/** First line of a compaction entry's text. */
const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:";

/** Drop the blank lines after a marker line and the trailing whitespace of a body. */
function markerBody(rest: string): string {
  return rest.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** Drop a leading `[marker]` from a line and keep the rest of it. */
function stripBracketMarker(line: string): string {
  if (!line.startsWith("[")) return line;
  const end = line.indexOf("]");
  return end === -1 ? line : line.slice(end + 1).trim();
}

/**
 * Read one message for the folded group: the source it carries, its attributes,
 * and its original body with the envelope taken off.
 *
 * The older forms below are the server's table too, in the same order, so one
 * input reads as the same source on both sides: the two replaced tags, the review
 * marker, the restart handoff, and the compaction summary line.
 *
 * `undefined` means the text carries no label at all. That is not a folded
 * message: an unlabeled user message is the operator's, and it always was.
 */
export function readFoldedMessage(text: string): FoldedMessage | undefined {
  const envelope = readEnvelope(text);
  if (envelope !== undefined) return envelope;

  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : text.slice(newline + 1);

  for (const legacy of LEGACY_MESSAGE_TAGS) {
    if (!first.startsWith(`<${legacy.tag}`)) continue;
    const attributes = readAttributes(first);
    const closing = rest.lastIndexOf(`</${legacy.tag}>`);
    const body = (closing === -1 ? rest : rest.slice(0, closing)).replace(/\s+$/, "");
    return { source: legacy.source, attributes, body };
  }

  // The bare marker line: the server's reader calls it the operator's, with
  // `via="review"`.
  if (first.startsWith(REVIEW_MARKER)) {
    return { source: OPERATOR_SOURCE, attributes: new Map([["via", "review"]]), body: markerBody(rest) };
  }
  // The handoff a session restart writes. Its marker line's remainder is the first
  // line of the text, so it stays.
  if (first.startsWith(RESTART_PREFIX)) {
    const inline = stripBracketMarker(first);
    const remainder = markerBody(rest);
    const body = inline === "" ? remainder : remainder === "" ? inline : `${inline}\n${remainder}`;
    return { source: "restart", attributes: new Map([["via", "handoff"]]), body };
  }
  // The compaction summary, line and all.
  if (first.startsWith(COMPACTION_PREFIX)) {
    return { source: "compaction", attributes: new Map(), body: text };
  }
  return undefined;
}

/** The text of one model message: a string, or blocks with `text` fields. */
export function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message
      .map((block) => (typeof block === "string" ? block : (block as { text?: string } | null)?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The text one entry's model messages carry, joined the way the page always joined them. */
export function entryText(entry: ConversationEntry): string {
  const messages = Array.isArray(entry.model) ? entry.model : [];
  return messages.map((message) => messageText((message as { content?: unknown } | null)?.content)).join("\n");
}

/** The name of a tool result, which lives on the model message, not on `entry.data`. */
export function toolResultName(entry: ConversationEntry): string {
  const messages = (Array.isArray(entry.model) ? entry.model : []) as { toolName?: string }[];
  const named = messages.find((candidate) => typeof candidate?.toolName === "string");
  return named?.toolName ?? (entry.data?.toolName as string | undefined) ?? (entry.data?.name as string | undefined) ?? "tool";
}

/** The call id a tool result names, which is how a live panel is dropped when it lands. */
export function toolResultCallId(entry: ConversationEntry): string | undefined {
  const messages = (Array.isArray(entry.model) ? entry.model : []) as { toolCallId?: string }[];
  return messages.find((candidate) => typeof candidate?.toolCallId === "string")?.toolCallId;
}

/** The output a tool result carries. */
export function toolResultText(entry: ConversationEntry): string {
  const messages = (Array.isArray(entry.model) ? entry.model : []) as { content?: unknown }[];
  return messages.map((message) => messageText(message?.content)).join("\n");
}
