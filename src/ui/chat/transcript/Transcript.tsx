/**
 * The transcript pane: the list of rows, the compaction line beside it, and the two
 * things that must happen around a draw.
 *
 * The list is the shell's own `#transcript` element, mounted in place, so its
 * `aria-live` region and the CSS of `#transcript > [data-row-key]` are untouched.
 * The rows come from the state module, which decides what a draw covers: the last
 * screen first and the rest when the browser is idle.
 *
 * A draw is followed by `afterDraw`, which puts the viewport where the reader left
 * it: at the foot when they were following the tail, and where they were when they
 * were not.
 */
import { useEffect, useLayoutEffect } from "preact/hooks";
import { compacting } from "../../state/run.ts";
import { afterDraw, markDrawn, transcriptRows, watchPane } from "../../state/transcript.ts";
import { TranscriptRow } from "./Rows.tsx";

/** The row list. */
export function Transcript() {
  const rows = transcriptRows.value;

  // The pane is watched once, at the first draw: a page that has drawn nothing has
  // nothing to watch, and the observer has to be made after the elements exist.
  useEffect(() => {
    watchPane();
  }, []);

  // After every draw: a draw that follows the tail puts its foot on screen, and a
  // draw that adds rows above the reader holds their distance from the foot.
  useLayoutEffect(() => {
    // The first draw of a conversation is the one that may split its work; a page
    // that has heard nothing has drawn no row and is not that draw.
    if (rows.length > 0) markDrawn();
    afterDraw();
  });

  return (
    <div id="transcript" class="transcript" aria-live="polite" aria-label="Conversation transcript">
      {rows.map((row) => (
        <TranscriptRow key={row.key} row={row} />
      ))}
    </div>
  );
}

/**
 * The transient `compressing context…` line under the transcript.
 *
 * It is drawn or dropped by a compaction's start and end frame, and by a snapshot:
 * the frame that ended a compaction went to a page that was not listening, so a page
 * that reconnects while one ran would otherwise keep the line forever.
 */
export function CompactionStatus() {
  const on = compacting.value;
  return (
    <div id="compaction-status" class={`compaction${on ? "" : " hidden"}`} role="status">
      compressing context…
    </div>
  );
}
