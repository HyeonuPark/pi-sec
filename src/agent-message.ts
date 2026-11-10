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
 * still holds it, and `readMessage` reads it. Nothing writes it any more.
 *
 * `src/async-output.ts` is the same shape for the result of a background tool
 * call.
 */

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

/** How the sender is named in the tag, so the reader knows who it is answering. */
export function senderLabel(sender: MessagePeer, self: string): string {
  if (sender.conversationId === self) return "you";
  if (sender.agentKind === "root") return "root-agent";
  return sender.name;
}
