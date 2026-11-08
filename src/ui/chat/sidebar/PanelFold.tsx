/**
 * A panel's heading as the control that folds its list away.
 *
 * The panel's name and a caret are one `<button>`, so the heading is a keyboard
 * stop: `Tab` reaches it and `Enter` or `Space` presses it, with nothing written
 * for the keys. `aria-expanded` says whether the list under the heading is open,
 * and `aria-controls` names that list, so a screen reader can read the pair as one
 * control. The caret repeats the state for the eye and is hidden from the reader,
 * which already has `aria-expanded`.
 *
 * The caret is drawn, not typed, the way the composer's tool marks and the inbox
 * marks are: a triangle pointing down while the list is open and pointing right
 * while it is folded. A glyph in this place would depend on a font the machine may
 * not have, and it would also land in the heading's own text, which names the panel
 * (`<h2>` reads as the panel's name).
 *
 * The heading keeps everything else it carried — the unread count, `hide all`, the
 * working count, the stopped warning — because the fold hides what is below the
 * heading, not the heading itself.
 */
import type { VNode } from "preact";
import { isFolded, toggleFold, type FoldPanel } from "../../state/folds.ts";

/** What a heading button is drawn from. */
export interface PanelFoldProps {
  /** The panel this heading folds, which is also its row in the stored choice. */
  readonly panel: FoldPanel;
  /** The words the heading shows and the reader hears. */
  readonly label: string;
  /** The id of the list the press hides. */
  readonly controls: string;
}

/** The caret a folded panel draws: a triangle pointing right, into the panel. */
function CaretFolded() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4.5 2.5 8.5 6l-4 3.5z" fill="currentColor" />
    </svg>
  );
}

/** The caret an open panel draws: a triangle pointing down, into the list. */
function CaretOpen() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5 6 8.5l3.5-4z" fill="currentColor" />
    </svg>
  );
}

/** One panel's heading button. The shell carries `#<panel>-fold` for the two panels it writes. */
export function PanelFold({ panel, label, controls }: PanelFoldProps): VNode {
  const folded = isFolded(panel);
  return (
    <button
      type="button"
      id={`${panel}-fold`}
      class="panel-fold"
      aria-expanded={folded ? "false" : "true"}
      aria-controls={controls}
      title={folded ? `Show ${label}` : `Fold ${label}`}
      onClick={() => toggleFold(panel)}
    >
      <span class="panel-fold-label">{label}</span>
      <span class="panel-fold-caret" aria-hidden="true">
        {folded ? <CaretFolded /> : <CaretOpen />}
      </span>
    </button>
  );
}
