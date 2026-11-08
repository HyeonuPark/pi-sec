/**
 * Whether a conversation is held by a provider's usage limit, read where an input
 * is put into a conversation.
 *
 * This is the one question `submitEnveloped` asks before it submits: an input to
 * a held conversation starts a run, and a run is a model call the provider has
 * already refused. The answer therefore has to be available without a storage
 * read, at a place that holds a conversation and nothing else — the module that
 * names its source and submits, which has no extension context to read a
 * document from.
 *
 * So the answer is a set in memory, held by the `usage-freeze` extension: it
 * fills the set from the hold documents when the daemon starts, and writes it
 * again on every hold, retry and resume. The set is a claim that can be wrong in
 * one direction only. A conversation the set does not name is submitted as it
 * always was, and a conversation it names keeps its text in the transcript
 * instead of starting a run; the retry that follows a recovered provider sends
 * that text with the request it resubmits. Losing a message is the fault this
 * ordering avoids, and one extra model call is the fault it accepts.
 *
 * The process-wide handle follows `src/context-advice.ts`: one runtime installs
 * its gate, and a runtime that closes removes only the handle that still points
 * at its own. With no gate installed, nothing is held and every input is
 * submitted as before, which is what a test that builds a conversation by hand
 * expects.
 */

import type { MessageSource } from "../message-envelope.ts";

/** The question a runtime answers. */
export interface HoldGate {
  /** Whether one conversation waits for its provider to accept a request again. */
  isHeld(conversationId: string): boolean;
}

let installed: HoldGate | undefined;

/** Install the gate of one runtime. Returns the way to remove this same gate. */
export function setHoldGate(gate: HoldGate): () => void {
  installed = gate;
  return () => {
    if (installed === gate) installed = undefined;
  };
}

/** The installed gate, or `undefined` when no runtime runs the watch. */
export function getHoldGate(): HoldGate | undefined {
  return installed;
}

/**
 * Whether this conversation is held.
 *
 * A gate that throws answers `false`, and a gate that has no opinion answers
 * `false` with it: an input that starts one more model call is a smaller fault
 * than an input nobody ever answers.
 */
export function isHeldConversation(conversationId: string | undefined): boolean {
  if (conversationId === undefined) return false;
  try {
    return installed?.isHeld(conversationId) === true;
  } catch {
    return false;
  }
}

/**
 * Whether this message waits for its provider, and its author has to be told.
 *
 * The gate above answers for every source: an agent's note, a scheduled run and a
 * tool result are written to the transcript while the provider refuses just as the
 * operator's text is. Only a person can read a notice, and only the operator's text
 * comes from a page that can draw one, so the question a route asks before it
 * answers that page is this one, with the envelope's source beside the conversation.
 * Every other source is recorded and carried by the retry in silence: its author
 * reads the transcript, not a page.
 */
export function isHeldOperatorInput(conversationId: string | undefined, src: MessageSource): boolean {
  return src === "operator" && isHeldConversation(conversationId);
}

/**
 * The set the `usage-freeze` extension keeps, as the gate it installs.
 *
 * Reading it returns a copy of nothing: the extension replaces the whole set on
 * every pass, so a reader here never sees a half-built one.
 */
export class HoldSet implements HoldGate {
  #held: ReadonlySet<string> = new Set();

  isHeld(conversationId: string): boolean {
    return this.#held.has(conversationId);
  }

  /** Replace the whole set: the pass has just read every hold document. */
  replace(conversationIds: Iterable<string>): void {
    this.#held = new Set(conversationIds);
  }

  /** The conversations named right now. */
  names(): readonly string[] {
    return [...this.#held];
  }
}
