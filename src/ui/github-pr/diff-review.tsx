/**
 * The review bar: the button in the corner, and the panel that submits a review.
 *
 * A review is one request, so the page collects the line comments first and the
 * panel is where they are counted, summarised and sent. That is the whole reason
 * this is a bar over the diff rather than a box on each line: a reader who submits
 * line by line makes a new review per line, and a review is a verdict on a commit.
 *
 * The four rules the panel keeps:
 *
 * - The count of collected comments is on the button, so a reader can see what they
 *   have collected without opening anything.
 * - The three verdicts are the ones GitHub accepts (Comment, Approve, Request
 *   changes), and one is always chosen, because a review with no verdict is not a
 *   thing GitHub can take.
 * - A review needs one comment or one overall comment. The server refuses an empty
 *   review, and a press that would be refused is answered here instead.
 * - `Discard all` throws the collection away, and it says how many it is throwing
 *   away, so the press is not a surprise.
 *
 * The bar is drawn only when the write switch is on: every one of these presses ends
 * in a write, and this dashboard draws no control that would only be refused.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { REVIEW_EVENTS, type ReviewEvent } from "./diff-state.ts";

export interface ReviewBarProps {
  /** How many comments this tab has collected. */
  readonly count: number;
  readonly open: boolean;
  readonly summary: string;
  readonly event: ReviewEvent;
  readonly sending: boolean;
  /** What the page says after a review was accepted, or `null`. */
  readonly notice: string | null;
  readonly onToggle: () => void;
  readonly onSummary: (text: string) => void;
  readonly onEvent: (event: ReviewEvent) => void;
  readonly onDiscard: () => void;
  readonly onSubmit: () => void;
}

/** `1 pending comment`, `3 pending comments`, or `No pending comments`. */
export function pendingLabel(count: number): string {
  if (count === 0) return "No pending comments";
  return `${count} pending comment${count === 1 ? "" : "s"}`;
}

/** The review bar over the diff. */
export function ReviewBar({
  count,
  open,
  summary,
  event,
  sending,
  notice,
  onToggle,
  onSummary,
  onEvent,
  onDiscard,
  onSubmit,
}: ReviewBarProps) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The panel opens under the button that opened it, so the overall comment is
  // where a reader is already looking; focusing it saves a press on a page that is
  // mostly code.
  useLayoutEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  return (
    <div class="review-bar">
      <button
        class={count > 0 ? "btn review-bar-btn has-pending" : "btn review-bar-btn"}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        {`Finish review (${count})`}
      </button>
      <div class={open ? "review-panel" : "review-panel hidden"}>
        <div class="review-panel-title">Submit review</div>
        <div class="review-panel-count">{pendingLabel(count)}</div>
        <textarea
          ref={field}
          class="review-summary"
          placeholder="Leave an overall comment (optional)…"
          aria-label="Overall comment"
          value={summary}
          onInput={(input) => {
            onSummary((input.target as HTMLTextAreaElement).value);
          }}
        />
        {REVIEW_EVENTS.map((choice) => (
          <label class="review-event" key={choice.value}>
            <input
              type="radio"
              name="review-event"
              value={choice.value}
              checked={event === choice.value}
              onChange={() => {
                onEvent(choice.value);
              }}
            />
            {` ${choice.label}`}
          </label>
        ))}
        <div class="reply-actions">
          <button class="btn review-discard" type="button" disabled={count === 0} onClick={onDiscard}>
            {count === 0 ? "Discard all" : `Discard all (${count})`}
          </button>
          <button class="btn btn-primary review-submit" type="button" disabled={sending} onClick={onSubmit}>
            {sending ? "Submitting…" : "Submit review"}
          </button>
        </div>
        {notice === null ? null : <div class="review-form-ok">{notice}</div>}
      </div>
    </div>
  );
}
