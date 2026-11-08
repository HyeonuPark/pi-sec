import { readMessage } from "./message-envelope.ts";
import type { MessagePeer } from "./documents.ts";

/**
 * How a message from another agent reaches a conversation, and how the model
 * and the operator can tell it apart from input the operator typed.
 *
 * An agent's message is delivered as user input, because user input is the only
 * admission that starts a run: a passive entry write would sit in the transcript
 * until something else woke the agent. The result is that the agent is not
 * talking to the operator's channel, but it arrives on the same wire.
 *
 * Two readers have to be able to tell the difference:
 *
 *   - the model is told, by this tag and by a prompt section, that a message
 *     carrying it is not operator input;
 *   - a person reading the transcript is told the same thing by the tag itself,
 *     which names the sender and its kind.
 *
 * A message written now is an envelope with `src="agent"`
 * (`src/message-envelope.ts`, which owns the format and the escaping rules).
 * The older `<agent-message ...>` tag stays readable because a stored transcript
 * still holds it, and `renderAgentMessage` and `parseLegacyAgentMessage` below
 * are its writer and reader.
 *
 * `src/async-output.ts` is the same shape for the result of a background tool
 * call.
 */

/**
 * First tag of the older form of an inter-agent message's first line.
 *
 * New messages do not use it; the envelope above does. It stays because stored
 * text and the readers of that text are still written against it.
 */
export const AGENT_MESSAGE_TAG = "agent-message";

export type AgentMessageKind = "note" | "request" | "reply" | "order";

export interface AgentMessage {
  /** The sender's display name, or `parent-agent` when it is the parent. */
  readonly from: string;
  /** `root`, `subagent` or `scheduled`, so the reader knows what it is talking to. */
  readonly fromKind: string;
  readonly kind: AgentMessageKind;
  /** The message's document id. */
  readonly id: string;
  /** Present on `request`: the token a reply must carry. */
  readonly replyToken?: string;
  readonly at: number;
  readonly body: string;
}

export interface ParsedAgentMessage {
  readonly from: string;
  readonly fromKind: string;
  readonly kind: string;
  readonly id: string;
  readonly replyToken?: string;
  readonly body: string;
}

/**
 * The submission request id of one message's delivery.
 *
 * A message is delivered by submitting it as input, and a resend must not place
 * it twice. A known request id returns the submission that already exists, so
 * the id is derived from the message and nothing else.
 */
export function agentMessageRequestId(id: string): string {
  return `agent-message:${id}`;
}

/**
 * A short token a model can quote back without transcription errors.
 *
 * The model reads the tag and later calls `send_reply` with this value, so it
 * has to be short enough to copy correctly and long enough not to collide with
 * another open request in the same conversation.
 */
export function replyTokenFor(id: string, salt: string): string {
  return `${id.slice(-4)}${salt}`.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 12);
}

function encodeAttribute(value: string): string {
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

/** How the sender is named in the tag, so the reader knows who it is answering. */
export function senderLabel(sender: MessagePeer, self: string): string {
  if (sender.conversationId === self) return "you";
  if (sender.agentKind === "root") return "root-agent";
  return sender.name;
}

/**
 * The older tag's instant: UTC, ISO 8601, to the second.
 *
 * The tag is the form the harness used before the envelope, and no new message
 * is written with it, so it keeps the shape it always had: a message it wrote is
 * read back byte for byte. The current form and its zone live in
 * `src/message-envelope.ts` and `src/time-format.ts`.
 */
function legacyInstant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Render the older tag.
 *
 * No new message is written this way: the sender builds an envelope,
 * `wrapMessage("agent", body, { from, "from-kind", kind, id, at, "reply-token" })`.
 * The function stays as the writer for the older form, so stored text and the
 * tests that pin that shape keep a producer to compare against.
 */
export function renderAgentMessage(message: AgentMessage): string {
  const attributes = [
    `from="${encodeAttribute(message.from)}"`,
    `from-kind="${encodeAttribute(message.fromKind)}"`,
    `kind="${message.kind}"`,
    `id="${encodeAttribute(message.id)}"`,
    `at="${legacyInstant(message.at)}"`,
  ];
  if (message.replyToken !== undefined) attributes.push(`reply-token="${encodeAttribute(message.replyToken)}"`);
  return [`<${AGENT_MESSAGE_TAG} ${attributes.join(" ")}>`, message.body, `</${AGENT_MESSAGE_TAG}>`].join("\n");
}

/**
 * Parse a rendered message, or `undefined` when this is not one.
 *
 * Both stored forms are read. An envelope is read through `readMessage`, which
 * owns the escaping rules, so they are not written down a second time here. The
 * older tag is read by `parseLegacyAgentMessage` below.
 */
export function parseAgentMessage(content: string): ParsedAgentMessage | undefined {
  const read = readMessage(content);
  if (read !== undefined && read.format === "envelope") {
    if (read.source !== "agent") return undefined;
    const from = read.attrs["from"];
    const id = read.attrs["id"];
    if (from === undefined || id === undefined) return undefined;
    const token = read.attrs["reply-token"];
    return {
      from,
      fromKind: read.attrs["from-kind"] ?? "subagent",
      kind: read.attrs["kind"] ?? "note",
      id,
      ...(token === undefined ? {} : { replyToken: token }),
      body: read.body,
    };
  }
  return parseLegacyAgentMessage(content);
}

/** The older tag's reader. Kept for text written before the envelope. */
function parseLegacyAgentMessage(content: string): ParsedAgentMessage | undefined {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  if (!first.startsWith(`<${AGENT_MESSAGE_TAG}`)) return undefined;
  const attributes = new Map<string, string>();
  for (const match of first.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g)) {
    attributes.set(match[1]!, decodeAttribute(match[2]!));
  }
  const from = attributes.get("from");
  const id = attributes.get("id");
  if (from === undefined || id === undefined) return undefined;
  const rest = newline === -1 ? "" : content.slice(newline + 1);
  const closing = rest.lastIndexOf(`</${AGENT_MESSAGE_TAG}>`);
  const body = (closing === -1 ? rest : rest.slice(0, closing)).replace(/\s+$/, "");
  const token = attributes.get("reply-token");
  return {
    from,
    fromKind: attributes.get("from-kind") ?? "subagent",
    kind: attributes.get("kind") ?? "note",
    id,
    ...(token === undefined ? {} : { replyToken: token }),
    body,
  };
}
