/**
 * The `↻ reload` control.
 *
 * It is the button the shell carries, taken over in place: one press reads the
 * whole page again, and the button is disabled while that read runs. The cards
 * below are matched by id, so the press never takes the reader's focus or scroll
 * position away.
 */
import { loadUsage, reloading } from "../state/usage.ts";

/** Read every card again. */
export function ReloadButton() {
  return (
    <button id="reload-usage" class="button" type="button" disabled={reloading.value} onClick={() => void loadUsage()}>
      ↻ reload
    </button>
  );
}
