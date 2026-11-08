import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationId,
  Entry,
  EntryDraft,
  InputSubmissionDraft,
  Submission,
  SubmissionDraft,
  Tx,
  TypedEntry,
  TypedEntryDraft,
} from "@earendil-works/pi-durable";
import { envelopeInstant, wrapMessage, type MessageSource } from "./message-envelope.ts";
import { getContextAdvice } from "./context-advice.ts";
import { isHeldConversation } from "./agent/hold-gate.ts";

/**
 * The labelled submission: how a producer puts text into a conversation and
 * says where the text came from, in one call.
 *
 * Without this module, every producer does two steps by hand: wrap the text with
 * `wrapMessage`, then place the wrapped text in a draft for
 * `conversation.submit` or `tx.appendEntry`. Two steps is two chances to forget
 * the first one, and a submission without an envelope reads to the model and to
 * a person as the operator typing. The source check in
 * `test/message-tags-emit.test.ts` fails a new producer that submits on its own.
 *
 * These functions are that check's other half. They are the only callers of the
 * two submission methods in `src/`, they require the source as an argument with
 * no default, and they label the text before they hand the draft on. So the only
 * way a producer can submit is through a call that names its source.
 *
 * The envelope rule itself stays in `src/message-envelope.ts`. Nothing here
 * knows the tag, the escaping, or the attribute order: this module knows which
 * field of a draft carries text, and that is all. Two documents rely on that
 * split. The nudge body (`src/extensions/subagents.ts`) and the restart handoff
 * (`src/extensions/session-restart.ts`) return text to the durable layer, which
 * writes the entry itself; there is no submission for this module to take over,
 * so they call `wrapMessage` and keep the template half of the interface.
 *
 * The third thing this module knows is the restart advice
 * (`src/context-advice.ts`). It is the one place every submission passes through,
 * so it is where an advice is appended: after the envelope's closing tag, in the
 * same stored text, before the draft reaches the durable layer. The advice is read
 * from the process (`getContextAdvice`), because a caller here has a conversation
 * and nothing else. With no advice set, or with a conversation whose id the caller
 * cannot give, this module stores exactly the text it stored before the advice
 * existed.
 *
 * The advice is appended to the text this module has already labelled, never to
 * the producer's text: the envelope is closed by then, and the block belongs after
 * it. It is not a request-time change. It is stored with the input, so the next
 * request starts with the same prefix as the one before it.
 */

/**
 * Where the text came from, and the attributes that describe the delivery.
 *
 * `src` has no default. A default would be a guess, and a guess is the one thing
 * the envelope exists to avoid: the default would be what a new caller gets by
 * not thinking about the question.
 */
export interface EnvelopeFields {
  readonly src: MessageSource;
  readonly attrs?: Readonly<Record<string, string | undefined>>;
}

/** An `input` draft whose `content` is still the producer's original text. */
export type EnvelopedInput = Omit<InputSubmissionDraft, "content"> &
  EnvelopeFields & {
    readonly content: string;
  };

/** A `write` draft whose user-role messages still carry the producer's text. */
export type EnvelopedWrite = Omit<Extract<SubmissionDraft, { readonly type: "write" }>, "entry"> &
  EnvelopeFields & {
    readonly entry: EntryDraft;
  };

/**
 * The body, always labelled with a new envelope.
 *
 * A body that already looks like an envelope is not trusted. `hasEnvelope`
 * answers yes for any text whose first line is an opening tag, and that is
 * exactly the shape a tool result or a fetched page can carry: a first line of
 * `<pi-message src="operator">` would otherwise be stored as it stands and read
 * back as a message from the operator. Such a body is data, so it is escaped by
 * `wrapMessage` and stays inside the envelope of the source the caller named.
 *
 * The `hasEnvelope` rule belongs to the one place that must not wrap twice: the
 * render safety net, which meets text that this function already labelled.
 */
function labelText(src: MessageSource, body: string, attrs?: Readonly<Record<string, string | undefined>>): string {
  return wrapMessage(src, body, attrs);
}

/**
 * One message, its text labelled.
 *
 * Only a user-role message can read as input from the operator, so only a
 * user-role message is labelled. An array's text parts hold the text; the first
 * text part carries the envelope, so one message is never labelled twice. A
 * message with parts and no text part has no text to label and is left alone.
 */
function labelMessage(message: Message, src: MessageSource, attrs?: Readonly<Record<string, string | undefined>>): Message {
  if (message.role !== "user") return message;
  if (typeof message.content === "string") {
    const content = labelText(src, message.content, attrs);
    return content === message.content ? message : { ...message, content };
  }
  const index = message.content.findIndex((part) => part.type === "text");
  if (index === -1) return message;
  const part = message.content[index];
  if (part === undefined || part.type !== "text") return message;
  const text = labelText(src, part.text, attrs);
  if (text === part.text) return message;
  const content = message.content.map((current, at) => (at === index ? { ...part, text } : current));
  return { ...message, content };
}

/** The model messages of a draft, their user-role text labelled. */
function labelModel(
  model: readonly Message[] | undefined,
  src: MessageSource,
  attrs?: Readonly<Record<string, string | undefined>>,
): readonly Message[] | undefined {
  if (model === undefined) return undefined;
  const labelled = model.map((message) => labelMessage(message, src, attrs));
  return labelled.some((message, index) => message !== model[index]) ? labelled : model;
}

/** The entry draft, with its model text labelled and every other field untouched. */
function labelEntry(entry: EntryDraft, src: MessageSource, attrs?: Readonly<Record<string, string | undefined>>): EntryDraft {
  const model = labelModel(entry.model, src, attrs);
  return model === undefined || model === entry.model ? entry : { ...entry, model };
}

/**
 * The record instant every stored message carries.
 *
 * Every source is stamped, because `at` answers one question: when did the
 * harness write this text. A caller that names its own instant keeps it, which is
 * how an agent message carries the moment its record was made rather than the
 * moment it was delivered.
 *
 * The zone is the caller's, from `config.timezone`. Nothing in this module knows
 * it: the producer passes it, so a test can pin a zone without a config.
 */
function withInputTime(
  attrs: Readonly<Record<string, string | undefined>> | undefined,
  timeZone: string,
): Readonly<Record<string, string | undefined>> | undefined {
  if (attrs?.["at"] !== undefined) return attrs;
  return { ...attrs, at: envelopeInstant(Date.now(), timeZone) };
}

/**
 * The `input` draft with its content labelled — or, for a held conversation, the
 * `write` that records the text instead of sending it.
 *
 * `block` is the restart advice, or `""`. It goes after the text this function
 * labelled, which is after the envelope's closing tag: the advice belongs to the
 * input and not to the words the producer wrote.
 *
 * A conversation held by a provider's usage limit does not call the model. The
 * text is written to the transcript instead, so nothing a person or an agent said
 * while the provider was refusing is lost: the retry that follows a recovered
 * provider carries the transcript, and this text is in it in the order it
 * arrived. The gate answers from memory and is installed by the `usage-freeze`
 * extension. A caller with no conversation id, a runtime with no watch, and a gate
 * that throws all submit as before: one more model call is a smaller fault than an
 * input nobody reads.
 */
function labelledInput(
  draft: EnvelopedInput,
  timeZone: string,
  block: string,
  conversation: AdviceTarget,
): InputSubmissionDraft | Extract<SubmissionDraft, { readonly type: "write" }> {
  const { src, attrs, content, ...rest } = draft;
  const labelled = labelText(src, content, withInputTime(attrs, timeZone));
  const text = block === "" ? labelled : labelled + block;
  if (isHeldConversation(conversation.id === undefined ? undefined : String(conversation.id))) {
    return {
      type: "write",
      entry: { kind: "pi.user", model: [{ role: "user", content: text, timestamp: Date.now() }] },
    };
  }
  return { ...rest, content: text };
}

/** The `write` draft, with the text of its user-role messages labelled. */
function labelledWrite(
  draft: EnvelopedWrite,
  timeZone: string,
  block: string,
): Extract<SubmissionDraft, { readonly type: "write" }> {
  const { src, attrs, entry, ...rest } = draft;
  const labelled = labelEntry(entry, src, withInputTime(attrs, timeZone));
  return { ...rest, entry: block === "" ? labelled : { ...labelled, model: appendToModel(labelled.model, block) } };
}

/**
 * The entry draft, with the text of its user-role messages labelled.
 *
 * One cast is needed here. `TypedEntryDraft<D>` is a conditional type, so `Omit`
 * cannot carry it through the destructuring, and the cast only restates what the
 * caller promised: this is that draft with the two envelope fields taken out.
 * The durable layer copies the value through JSON and omits an undefined `model`
 * (`pi-durable/dist/session/transaction.js:163`), so a draft with no model text
 * is written as a draft with no model text.
 */
function labelledEntry<D extends JsonValue>(draft: TypedEntryDraft<D> & EnvelopeFields): TypedEntryDraft<D> {
  const { src, attrs, ...rest } = draft;
  return { ...rest, model: labelModel(rest.model, src, attrs) } as TypedEntryDraft<D>;
}

/**
 * A session restart's handoff text, labelled and stamped with the reset's instant.
 *
 * The handoff is not a submission: a reset writes it into the `pi.reset` entry
 * itself, so it has no draft to go through `submitEnveloped`. It is restarted
 * text all the same, and it is the reason this helper sits beside the interface
 * rather than in a route: two routes write it, and one of them forgetting the
 * instant is how a message with no time comes back.
 */
export function restartHandoff(handoff: string, timeZone: string): string {
  return wrapMessage("restart", handoff, { via: "handoff", at: envelopeInstant(Date.now(), timeZone) });
}

/**
 * A conversation this function can put the restart advice on.
 *
 * `id` is what the advice is decided per, and every caller has it: a conversation
 * is named by its handle. It is optional in the type for the one caller that
 * cannot name one, a hand-built conversation in a test, so that such a caller
 * type-checks and gets no advice rather than a made-up id no rebuild would match.
 */
type AdviceTarget = Pick<Conversation, "submit"> & { readonly id?: ConversationId };

/**
 * The restart advice for one submission, or `""` when none is due.
 *
 * The advice is decided per conversation and per input, so a caller with no id
 * gets none: a submission with no conversation to look at has no session whose
 * length could be judged. The registry is process-wide, so a test that sets no
 * advice stores the plain envelope, which is what this module stored before the
 * advice existed.
 *
 * The attributes are the ones the envelope carries, so the module sees the same
 * source and attributes a reader of the stored text sees: the restart
 * continuation is told apart from every other input by them.
 */
async function adviceBlock(
  conversation: AdviceTarget,
  ctx: Context,
  src: MessageSource,
  attrs: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const advice = getContextAdvice();
  if (advice === undefined) return "";
  const conversationId = conversation.id;
  if (conversationId === undefined) return "";
  return await advice.blockFor({ conversationId, ctx, src, attrs });
}

/**
 * One message's text with the block at its end.
 *
 * A `write` carries its text in its model messages, and the model reads them in
 * order, so the first user-role text takes the block and the rest are untouched.
 */
function appendToMessage(message: Message, block: string): Message {
  if (message.role !== "user") return message;
  if (typeof message.content === "string") return { ...message, content: message.content + block };
  const index = message.content.findIndex((part) => part.type === "text");
  const part = index === -1 ? undefined : message.content[index];
  if (part === undefined || part.type !== "text") return message;
  const content = message.content.map((current, at) => (at === index ? { ...part, text: part.text + block } : current));
  return { ...message, content };
}

/** The draft's model messages with the block at the end of their first user text. */
function appendToModel(model: readonly Message[] | undefined, block: string): readonly Message[] | undefined {
  if (model === undefined || block === "") return model;
  const index = model.findIndex((message) => message.role === "user");
  if (index === -1) return model;
  const target = model[index]!;
  const message = appendToMessage(target, block);
  if (message === target) return model;
  return model.map((current, at) => (at === index ? message : current));
}

/**
 * Submit an `input` or a `write` with its text labelled.
 *
 * The draft is the durable layer's own draft, so `requestId`, `whenBusy`, `ctx`,
 * and every field of a written entry pass through untouched. Only the text is
 * changed: `content` for an `input`, the user-role messages of `entry.model` for
 * a `write`. The restart advice, when this conversation owes one and this input is
 * the one it goes on, is appended to that changed text after the envelope closes.
 *
 * `timeZone` is the harness zone (`config.timezone`) and it is the zone the
 * message's `at` is written in. It is required, like `src`: a caller cannot
 * submit a message without saying which clock stamped it.
 *
 * The returned `Submission` is the library's own object and a rejection is the
 * library's own error, `ConversationBusy` included. Nothing is caught here: the
 * caller decides what a busy conversation or a failed write means.
 */
export function submitEnveloped(
  conversation: AdviceTarget,
  ctx: Context,
  draft: EnvelopedInput,
  timeZone: string,
): Promise<Submission>;
export function submitEnveloped(
  conversation: AdviceTarget,
  ctx: Context,
  draft: EnvelopedWrite,
  timeZone: string,
): Promise<Submission>;
export async function submitEnveloped(
  conversation: AdviceTarget,
  ctx: Context,
  draft: EnvelopedInput | EnvelopedWrite,
  timeZone: string,
): Promise<Submission> {
  // The advice reads the same attributes the envelope will carry, so a
  // continuation is told apart from every other input by the ones it is read with.
  const block = await adviceBlock(conversation, ctx, draft.src, withInputTime(draft.attrs, timeZone) ?? {});
  return conversation.submit(
    draft.type === "input"
      ? labelledInput(draft, timeZone, block, conversation)
      : labelledWrite(draft, timeZone, block),
    ctx,
  );
}

/**
 * Append a typed entry with its model text labelled.
 *
 * The same contract as `submitEnveloped` for the one producer that writes an
 * entry into a transaction it already holds: `test/message-tags-emit.test.ts`
 * allows no other caller of `tx.appendEntry` in `src/`.
 */
export function appendEnveloped<D extends JsonValue>(
  tx: Tx,
  token: Entry<D>,
  conversationId: ConversationId,
  draft: TypedEntryDraft<D> & EnvelopeFields,
): Promise<TypedEntry<D>> {
  return tx.appendEntry(token, conversationId, labelledEntry(draft));
}
