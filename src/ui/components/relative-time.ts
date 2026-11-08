/**
 * How a past moment reads beside a time or a button.
 *
 * The hand-written report page and feedback module each carried this function
 * (both removed in this commit), and the two copies were identical: the list's update age, a feedback note's age
 * and the approval hint all say `just now`, `5m ago`, `3h ago`, `2d ago`. It is
 * one function here so they cannot disagree about where one unit ends.
 *
 * A time that cannot be read answers an empty string, which is what the pages
 * did: the caller then shows its own text without a time rather than `NaN`.
 */
export function relativeTime(at: number | undefined): string {
  const seconds = Math.round((Date.now() - Number(at)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
