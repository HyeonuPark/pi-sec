/**
 * The strip a failed request puts its sentence in.
 *
 * Every page of the dashboard carries one, right under the bar, and it is the
 * page's only place for a failure: the original drew the server's message there,
 * above whatever the page already held, and left the held data where it was. So a
 * failed reload never empties a list that a reader was reading.
 *
 * The text is the server's own sentence, printed as text and not as markup: a gh
 * error carries a message with quotes and newlines in it, and the strip keeps its
 * line breaks because a git failure is several lines. An empty strip is hidden by
 * the `hidden` class rather than removed, because the stylesheet's rules measure
 * the page from an element that is always there.
 */
export interface ErrorBannerProps {
  /** The sentence, or `null` when nothing failed. */
  readonly error: string | null;
}

/** The strip. */
export function ErrorBanner({ error }: ErrorBannerProps) {
  const text = error ?? "";
  return (
    <div id="error-banner" class={text === "" ? "error-banner hidden" : "error-banner"} role="alert">
      {text}
    </div>
  );
}
