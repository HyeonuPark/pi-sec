/**
 * The no-response line, and the one judgement both sides of the wire make of it.
 *
 * A turn of the root or of a focused chat that has nothing to say to the user
 * ends with {@link NO_RESPONSE_MARKER} as its whole answer. The chat screen hides
 * such an answer, and the harness counts it as an answer with no text when it
 * decides whether to nudge a turn the user started. The two sit on opposite sides
 * of the wire, so the line and the judgement live here: the page code imports
 * this module with a relative path, and the server imports it as it does any
 * other module under `src/`.
 *
 * The judgement is exact on purpose. An answer is hidden only when its whole text,
 * with the space around it taken off, is the line itself or nothing at all. A
 * quoted, backticked, re-cased, punctuation-added, or sentence-wrapped copy of the
 * line is drawn, because a reader who meets one of those must see that the rule
 * was not followed. The role file says in words which forms not to write.
 */

/** The whole answer of a turn that has nothing to tell the user. */
export const NO_RESPONSE_MARKER = "[pi-sec no-response]";

/**
 * True when this is an answer the chat screen draws nothing for: empty text, or
 * the no-response line alone.
 *
 * The caller decides what to judge. The page judges a `pi.assistant` entry's
 * text, and the harness judges the answer a turn is about to yield.
 */
export function isSilentAssistantTurn(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === NO_RESPONSE_MARKER;
}
