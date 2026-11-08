/**
 * The context bar above the composer and the readout in the sidebar footer.
 *
 * Two views of one reading: the thin line is the ratio against the point where
 * compaction fires, and both hover texts carry the exact counts, the model's
 * window and what is held back for the answer. Neither is the operator's state,
 * so a new reading redraws both and nothing else.
 *
 * The bar is `#context-bar` and the line inside it is `#context-fill`; the
 * readout is the `Context` row of the sidebar footer, which the shell draws.
 */
import { contextExact, contextRatio, contextReadout } from "../../state/context.ts";

/** The line the width of the composer, above it. */
export function ContextBar() {
  const ratio = contextRatio.value;
  const exact = contextExact.value;
  return (
    <div
      id="context-bar"
      class="context-bar"
      role="progressbar"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio)}
      title={exact}
    >
      <div id="context-fill" class="context-fill" style={{ width: `${ratio}%` }} />
    </div>
  );
}

/** `10.7k / 983.6k`, or `—` before an answer has been measured. */
export function ContextReadout() {
  return (
    <span id="context-usage" class="sidebar-value" title={contextExact.value}>
      {contextReadout.value}
    </span>
  );
}
