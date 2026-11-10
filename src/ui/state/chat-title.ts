/**
 * The title check both rename presses make before they send anything.
 *
 * The server keeps its own limit (`src/focused/service.ts`), which a page cannot
 * import, so the number is written here too. An empty title and one over the
 * limit are one sentence each, because a round trip to be told the same is worse
 * than saying it.
 */

/** The longest title the server takes. The page refuses a longer one first. */
export const TITLE_MAX = 80;

/** The trimmed title when it can be sent, or the sentence that refuses it. */
export function checkTitle(answer: string): { readonly title: string } | { readonly refusal: string } {
  const title = answer.trim();
  if (title === "") return { refusal: "A title cannot be empty." };
  if (title.length > TITLE_MAX) return { refusal: `A title holds at most ${TITLE_MAX} characters.` };
  return { title };
}
