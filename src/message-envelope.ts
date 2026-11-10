import { REVIEW_MARKER } from "./review.ts";
import { zoneIso } from "./time-format.ts";

/**
 * The message envelope: how a user-role message in a model request says where
 * it came from.
 *
 * Text reaches a conversation by about twenty doors, and most of them are not
 * the operator typing. The durable layer stores every one of them as an
 * ordinary `pi.user` entry, so the transcript alone cannot tell an operator
 * message from a tool result, a scheduled prompt, or the continuation a session
 * restart writes. The envelope puts that fact on the wire, in the message text
 * itself, where both the model and a person reading the transcript can see it:
 *
 *   <pi-message src="operator">
 *   {the original text}
 *   </pi-message>
 *
 * The first line is the single truth. Nothing else carries the label: an entry's
 * `data` is not a channel every producer can use, and two channels drift.
 *
 * Rules a caller has to keep:
 *
 *   - Wrap with `wrapMessage`, once, at the point the text is made. There is no
 *     second chance to label it after that.
 *   - Read with `readMessage`. It returns the original text: escaping is
 *     undone, and the body is never parsed again as structure.
 *   - `escapeBody` neutralizes both the opening string and the closing string
 *     inside the body. The closing one needs the substitution even though
 *     `readMessage` takes the *last* `</pi-message>`: that rule protects this
 *     reader only. A model reads the first `</pi-message>` as the end of the
 *     envelope, so an unescaped copy in a fetched page or a tool result would
 *     let the text after it pass for an envelope of its own.
 */

/**
 * Every source a message may carry. The list is closed: a reader that meets a
 * value outside it answers `unknown` rather than trusting the text.
 */
export const MESSAGE_SOURCES = [
  "operator",
  "operator-scheduled",
  "tool-output",
  "agent",
  "restart",
  "section",
  "system",
  "compaction",
  "unknown",
] as const;

export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/** Opening tag. An envelope always carries `src` as its first attribute. */
export const ENVELOPE_OPEN = "<pi-message";

/** Closing tag. A reader takes the last one in the text. */
export const ENVELOPE_CLOSE = "</pi-message>";

/** What `escapeBody` puts in the body in place of the opening string. */
const ESCAPED_OPEN = "&lt;pi-message";

/** What `escapeBody` puts in the body in place of the closing string. */
const ESCAPED_CLOSE = "&lt;/pi-message";

/** The closing string without its `>`, which is the prefix a body must not carry. */
const ENVELOPE_CLOSE_PREFIX = "</pi-message";

/**
 * The two strings a body must not carry, escaped.
 *
 * The closing string goes first and the opening string second. The two
 * substitutions do not overlap: after the first, no `</pi-message` is left for
 * the second to see, and the second never produces one.
 *
 * Both are needed. The opening string stops a body from opening a second
 * envelope. The closing string stops a body from closing this one early for a
 * reader that does not take the last occurrence, which is every reader but
 * `readMessage`: a model reading a tool result or a fetched page sees
 * `</pi-message>` as the end of the envelope, and the text after it would pass
 * for input from another source.
 *
 * The cost: a body that already contains the literal
 * `&lt;pi-message` or `&lt;/pi-message` reads back as the tag it stands for after
 * one round trip. A fully reversible rule would have to double every `&` in
 * every tool result, which is worse than the loss.
 */
export function escapeBody(text: string): string {
  return text.replaceAll(ENVELOPE_CLOSE_PREFIX, ESCAPED_CLOSE).replaceAll(ENVELOPE_OPEN, ESCAPED_OPEN);
}

/**
 * Undo `escapeBody`. The result is data: never parse it as structure.
 *
 * The order does not matter here. `&lt;/pi-message` does not contain
 * `&lt;pi-message`, because the slash sits between them, so neither substitution
 * can eat the other's input.
 */
export function unescapeBody(text: string): string {
  return text.replaceAll(ESCAPED_CLOSE, ENVELOPE_CLOSE_PREFIX).replaceAll(ESCAPED_OPEN, ENVELOPE_OPEN);
}

/**
 * Escape a value that goes inside an attribute, quoted with double quotes.
 *
 * One rule for every tag, so an attribute reads the same whichever tag it is on.
 */
export function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Attribute names the readers accept. The same pattern the older parsers use. */
const ATTRIBUTE_PATTERN = /([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g;

/** Read one tag line's attributes, with their values unescaped. */
function readAttributes(line: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of line.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = decodeAttribute(match[2]!);
  }
  return attributes;
}

/**
 * Render an envelope around `body`.
 *
 * The shape is fixed: `src` is always the first attribute, the rest follow in
 * name order, and an attribute whose value is `undefined` is left out so a
 * caller can pass an optional attribute directly. Two calls with the same
 * arguments produce the same text: nothing here reads the clock or any other
 * state, because the request prefix has to stay byte-identical between requests.
 */
export function wrapMessage(
  source: MessageSource,
  body: string,
  attrs?: Readonly<Record<string, string | undefined>>,
): string {
  const attributes = [`src="${encodeAttribute(source)}"`];
  const names = Object.keys(attrs ?? {})
    .filter((name) => name !== "src")
    .sort();
  for (const name of names) {
    const value = attrs?.[name];
    if (value === undefined) continue;
    attributes.push(`${name}="${encodeAttribute(value)}"`);
  }
  return `${ENVELOPE_OPEN} ${attributes.join(" ")}>\n${escapeBody(body)}\n${ENVELOPE_CLOSE}`;
}

/**
 * The instant one stored message was written, in the harness zone.
 *
 * The value is the moment the harness recorded the message, not the moment the
 * model read it, and it is written in the zone the preamble names, with the
 * offset in force at that instant: `2030-01-15T16:30:05+00:00`. The form itself
 * lives in `src/time-format.ts`, because the tool output and the `write` marker
 * write the same clock.
 *
 * Every producer passes the zone; nothing here reads it from anywhere, because
 * the module that hands the text to the store is where the clock is read.
 */
export function envelopeInstant(ms: number, timeZone: string): string {
  return zoneIso(ms, timeZone);
}

/**
 * Whether the text already carries an envelope.
 *
 * This is the safety net's test, so it answers yes for any form a real envelope
 * can take, including one with no attributes at all.
 */
export function hasEnvelope(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(`${ENVELOPE_OPEN} `) || trimmed.startsWith(`${ENVELOPE_OPEN}>`);
}

export interface ParsedMessage {
  readonly source: MessageSource;
  /** The envelope's other attributes, without `src`, or a legacy tag's attributes. */
  readonly attrs: Readonly<Record<string, string>>;
  /** The original text, with escaping undone. */
  readonly body: string;
  /** `envelope` for the current form, `legacy` for a marker or an older tag. */
  readonly format: "envelope" | "legacy";
}

const SOURCES: ReadonlySet<string> = new Set<string>(MESSAGE_SOURCES);

/** One older tag a stored transcript may still hold, and the source it names. */
export interface LegacyTag {
  readonly tag: string;
  readonly source: MessageSource;
}

/**
 * Older tags a stored transcript may still hold, and the source each one names.
 *
 * Exported for the `message-tags` safety net: it reads these forms by this table
 * and has to tell an older tag from a first-line marker, because the two differ
 * in what the body is.
 */
export const LEGACY_TAGS: readonly LegacyTag[] = [
  { tag: "tool-call-output", source: "tool-output" },
  { tag: "agent-message", source: "agent" },
];

/** Prefix of a restart's handoff text (`src/extensions/session-restart.ts:323`). */
const RESTART_PREFIX = "[restart ";

/**
 * First line of a compaction entry's text. The constant is
 * `SUMMARY_PREFIX` in `pi-durable/dist/harness/compaction.js:12`; a compaction
 * arrives as user role, so without this rule it would read as operator input.
 */
const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:";

/** Drop the blank lines after a marker line and the trailing whitespace of a body. */
function markerBody(rest: string): string {
  return rest.replace(/^\n+/, "").replace(/\s+$/, "");
}

/**
 * Drop a leading `[marker]` from a line and keep the rest of it.
 *
 * A review's first line is metadata and carries no message, so the whole line
 * goes. A restart's marker ends at the bracket and the message continues after
 * it on the same line, so the remainder is content and stays.
 */
function stripBracketMarker(line: string): string {
  if (!line.startsWith("[")) return line;
  const end = line.indexOf("]");
  return end === -1 ? line : line.slice(end + 1).trim();
}

/**
 * Read a message's source, attributes, and original text.
 *
 * Order matters. The boundaries are found first, the body is cut second, and
 * the escaping is undone last. Undoing it earlier would turn the body's
 * `&lt;pi-message` back into an opening tag, and the text would be read as
 * structure. The restored text is data and is never parsed again.
 *
 * `undefined` means the text is neither an envelope nor a known older form.
 */
export function readMessage(text: string): ParsedMessage | undefined {
  const trimmed = text.trimStart();
  const newline = trimmed.indexOf("\n");
  const first = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1);

  if (hasEnvelope(text)) {
    const { src, ...others } = readAttributes(first);
    const closing = rest.lastIndexOf(ENVELOPE_CLOSE);
    let body = closing === -1 ? rest : rest.slice(0, closing);
    // The line break before the closing tag belongs to the envelope, not to the
    // body. Dropping exactly that one keeps a round trip exact.
    if (body.endsWith("\n")) body = body.slice(0, -1);
    return {
      source: src !== undefined && SOURCES.has(src) ? (src as MessageSource) : "unknown",
      attrs: others,
      body: unescapeBody(body),
      format: "envelope",
    };
  }

  for (const legacy of LEGACY_TAGS) {
    if (!first.startsWith(`<${legacy.tag}`)) continue;
    const closing = rest.lastIndexOf(`</${legacy.tag}>`);
    const body = (closing === -1 ? rest : rest.slice(0, closing)).replace(/\s+$/, "");
    return { source: legacy.source, attrs: readAttributes(first), body, format: "legacy" };
  }

  if (first.startsWith(REVIEW_MARKER)) {
    return { source: "operator", attrs: { via: "review" }, body: markerBody(rest), format: "legacy" };
  }
  if (first.startsWith(RESTART_PREFIX)) {
    const inline = stripBracketMarker(first);
    const remainder = markerBody(rest);
    const body = inline === "" ? remainder : remainder === "" ? inline : `${inline}\n${remainder}`;
    return { source: "restart", attrs: { via: "handoff" }, body, format: "legacy" };
  }
  if (first.startsWith(COMPACTION_PREFIX)) {
    return { source: "compaction", attrs: {}, body: text, format: "legacy" };
  }
  return undefined;
}

/** The source a message carries, or `unknown` when it carries none. */
export function sourceLabel(text: string): MessageSource {
  return readMessage(text)?.source ?? "unknown";
}
