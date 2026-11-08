/**
 * The dashboard's one live feed.
 *
 * The server publishes `prs` on `/api/github/pr/events` when the cached list
 * changed, including after a forced refresh that changed it. The frame carries no
 * payload the page needs: it says that the list moved, and the list page reads the
 * list route again, which is what puts the new rows in front of a reader who has
 * the page open in another tab.
 *
 * Everything about keeping the connection open is `StreamClient`'s: a stream the
 * browser dropped is resumed by the browser, a stream the server refused is opened
 * again after a growing wait, nothing is opened while the page is hidden, a page
 * hidden for a minute gives up its stream, and a return (or `pageshow` from the
 * back/forward cache, or `online`) opens a new one.
 *
 * A frame is only ever a request to read again, never a payload to draw, so a
 * burst of frames costs one read per frame and nothing is drawn twice: the state
 * module's ticket says which of two reads in flight may draw.
 *
 * `EventSource` is opened only from this folder, as the source-rule test requires.
 */
import { prEventsPath } from "../api/github-pr.ts";
import { StreamClient } from "./client.ts";

/** The frame the server sends when the cached list changed. */
export const PRS_EVENT = "prs";

/** What the stream says to the page that holds it. */
export interface GithubPrStreamHandlers {
  /** One `prs` frame: the list should be read again. */
  readonly onPrs: () => void;
  /**
   * Called with `true` when the connection opened and `false` when it was lost, so
   * the page can say whether it is live.
   */
  readonly onStateChange?: (connected: boolean) => void;
}

/** Open the dashboard's stream. The caller keeps the client to stop it. */
export function startGithubPrStream(handlers: GithubPrStreamHandlers): StreamClient {
  const client = new StreamClient({
    path: prEventsPath(),
    ...(handlers.onStateChange === undefined ? {} : { onStateChange: handlers.onStateChange }),
  });
  client.on(PRS_EVENT, () => {
    handlers.onPrs();
  });
  client.start();
  return client;
}
