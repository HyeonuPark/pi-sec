/**
 * The Pending reviews section of the list page: every pull request that has a
 * review saved on the server, whatever its state.
 *
 * It is the first box of the page and keeps the look of the other boxes: a head
 * with the title and the count, then one row per saved review, newest first (the
 * server's order). A row is a `div` that holds a link and a button, because a
 * button inside an `<a>` is not valid HTML. The title links to the diff page,
 * where the review panel is. A repository that is not in the settings has no
 * dashboard page, so its title links to GitHub when the server knows the address
 * and is plain text otherwise. A file that could not be read has no link.
 *
 * The Delete button is drawn whether the write switch is on or off, because a
 * delete never reaches GitHub. The confirmation and the request are the state
 * module's, so this part only draws and reports a press.
 *
 * A section with no row says `No saved reviews` instead of hiding, as the other
 * sections say `No pull requests`: an empty box tells the reader that the page
 * finished loading and that nothing waits.
 */
import type { GithubPrPendingReview } from "../api/github-pr.ts";
import { ago } from "./parts.tsx";
import { diffUrl } from "./urls.ts";

/** The state mark of one row: its words and its class. */
function stateMark(review: GithubPrPendingReview): { readonly text: string; readonly tone: string } {
  if (review.kind === "unreadable" || review.pr === null) return { text: "Unknown", tone: "unknown" };
  if (review.pr.state === "MERGED") return { text: "Merged", tone: "merged" };
  if (review.pr.state === "CLOSED") return { text: "Closed", tone: "closed" };
  if (review.pr.isDraft) return { text: "Draft", tone: "draft" };
  return { text: "Open", tone: "open" };
}

/** The verdict a reader chose, in words, or `""` for a plain comment. */
function verdictText(event: string): string {
  if (event === "APPROVE") return "Approve";
  if (event === "REQUEST_CHANGES") return "Request changes";
  return "";
}

/** The one line under the title. */
export function pendingLine(review: GithubPrPendingReview): string {
  const parts = [`#${review.number}`, review.repo];
  if (review.kind === "draft") {
    if (review.comments > 0) parts.push(`${review.comments} ${review.comments === 1 ? "comment" : "comments"}`);
    if (review.summary) parts.push("overall comment");
    const verdict = verdictText(review.event);
    if (verdict !== "") parts.push(verdict);
    if (!review.configured) parts.push("not in settings");
  }
  const saved = ago(review.savedAt);
  if (saved !== "") parts.push(`saved ${saved}`);
  return parts.join(" · ");
}

/** The title of a row: a link where the page has an address for it, text otherwise. */
function Title({ review }: { readonly review: GithubPrPendingReview }) {
  if (review.kind === "unreadable") return <span>This saved review cannot be read</span>;
  const text = review.pr?.title === undefined || review.pr.title === "" ? `Pull request #${review.number}` : review.pr.title;
  if (review.configured) return <a href={diffUrl(review.repo, review.number)}>{text}</a>;
  const external = review.pr?.url ?? "";
  return external === "" ? <span>{text}</span> : <a href={external}>{text}</a>;
}

/** One saved review's row. */
export function PendingRow({
  review,
  onDelete,
}: {
  readonly review: GithubPrPendingReview;
  readonly onDelete: (review: GithubPrPendingReview) => void;
}) {
  const mark = stateMark(review);
  return (
    <div class="pending-row">
      <span class={`pending-state pending-state-${mark.tone}`}>{mark.text}</span>
      <div class="pr-main">
        <div class="pr-title">
          <Title review={review} />
        </div>
        <div class="pr-sub">{pendingLine(review)}</div>
      </div>
      <button type="button" class="pending-delete" onClick={() => onDelete(review)}>
        Delete
      </button>
    </div>
  );
}

/** The box: its head with the count, and its rows or its one sentence. */
export function PendingSection({
  reviews,
  onDelete,
}: {
  readonly reviews: readonly GithubPrPendingReview[];
  readonly onDelete: (review: GithubPrPendingReview) => void;
}) {
  return (
    <div class="section pending-section">
      <div class="section-header">
        Pending reviews
        <span class="section-count">{reviews.length}</span>
      </div>
      {reviews.length === 0 ? (
        <div class="section-empty">No saved reviews</div>
      ) : (
        reviews.map((review) => (
          <PendingRow
            key={review.kind === "unreadable" ? review.file : `${review.repo}#${review.number}`}
            review={review}
            onDelete={onDelete}
          />
        ))
      )}
    </div>
  );
}
