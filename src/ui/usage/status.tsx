/**
 * The one line above the cards.
 *
 * It is the `#usage-status` paragraph the shell carries, taken over in place. The
 * old page hid it with the `hidden` class and emptied its text; the class is what
 * the stylesheet reads, so hiding is a class here too and the element stays.
 */
import { status } from "../state/usage.ts";

/** The status line: what the page is doing, or why it is empty. */
export function StatusLine() {
  const text = status.value;
  return (
    <p id="usage-status" class={text === null ? "usage-status hidden" : "usage-status"}>
      {text ?? ""}
    </p>
  );
}
