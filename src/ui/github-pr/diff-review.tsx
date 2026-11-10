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
import type { GithubPrPendingComment } from "../state/github-pr.ts";
import { lineSpan } from "./diff-row.tsx";
import { REVIEW_EVENTS, type ReviewEvent } from "./diff-state.ts";

/** One collected comment as the panel lists it. */
export interface ReviewLink {
  readonly id: string;
  readonly comment: GithubPrPendingComment;
  /** The comment's place in the collection, which is what `Remove` names. */
  readonly index: number;
  /** The file's place in the answer, or `-1` when the diff no longer has the file. */
  readonly order: number;
  /** True when the code on the comment's line changed since it was written. */
  readonly moved: boolean;
}

/** The first 60 characters of a body on one line, with `…` when it was cut. */
export function cutBody(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** The words of one link: the file, the side and the lines, the cut body, and a note for a moved comment. */
export function linkText(link: ReviewLink): string {
  const { comment } = link;
  const where = `${comment.side === "LEFT" ? "old" : "new"} ${lineSpan(comment.startLine, comment.line)}`;
  return `${comment.path} ${where} ${cutBody(comment.body)}${link.moved ? " (line changed)" : ""}`;
}

/** `1 comment points at a line that changed`, `3 comments point at lines that changed`. */
export function movedLabel(count: number): string {
  return count === 1 ? "1 comment points at a line that changed" : `${count} comments point at lines that changed`;
}

export interface ReviewBarProps {
  /** How many comments this tab has collected. */
  readonly count: number;
  /** One link per comment whose file is in the diff, in the order of the diff. */
  readonly links: readonly ReviewLink[];
  /** The comments whose file is no longer in the diff. */
  readonly missing: readonly ReviewLink[];
  /** How many comments sit on a line whose code changed since they were written. */
  readonly movedCount: number;
  /** True when a change could not be sent to the server. */
  readonly saveFailed: boolean;
  readonly onRetry: () => void;
  readonly onJump: (id: string) => void;
  readonly onRemove: (index: number) => void;
  readonly onSummaryBlur: () => void;
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
  links,
  missing,
  movedCount,
  saveFailed,
  onRetry,
  onJump,
  onRemove,
  onSummaryBlur,
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
        {saveFailed ? (
          <div class="review-save-failed" role="status">
            {"Not saved to server "}
            <button class="btn review-retry" type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}
        {links.length === 0 ? null : (
          <ul class="review-links" aria-label="Pending comments">
            {links.map((link) => (
              <li key={link.id}>
                <button
                  class="review-link"
                  type="button"
                  data-link-id={link.id}
                  title={link.comment.body}
                  onClick={() => {
                    onJump(link.id);
                  }}
                >
                  {linkText(link)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {missing.length === 0 ? null : (
          <div class="review-missing">
            <div class="review-missing-title">Comments on files not in this diff</div>
            <ul class="review-links">
              {missing.map((link) => (
                <li key={link.id}>
                  <span class="review-missing-text" title={link.comment.body}>
                    {linkText(link)}
                  </span>{" "}
                  <button
                    class="btn review-missing-remove"
                    type="button"
                    disabled={sending}
                    onClick={() => {
                      onRemove(link.index);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <textarea
          ref={field}
          class="review-summary"
          placeholder="Leave an overall comment (optional)…"
          aria-label="Overall comment"
          value={summary}
          disabled={sending}
          onInput={(input) => {
            onSummary((input.target as HTMLTextAreaElement).value);
          }}
          onBlur={onSummaryBlur}
        />
        {REVIEW_EVENTS.map((choice) => (
          <label class="review-event" key={choice.value}>
            <input
              type="radio"
              name="review-event"
              value={choice.value}
              checked={event === choice.value}
              disabled={sending}
              onChange={() => {
                onEvent(choice.value);
              }}
            />
            {` ${choice.label}`}
          </label>
        ))}
        {movedCount > 0 ? <div class="review-moved-count">{movedLabel(movedCount)}</div> : null}
        <div class="reply-actions">
          <button class="btn review-discard" type="button" disabled={count === 0 || sending} onClick={onDiscard}>
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
