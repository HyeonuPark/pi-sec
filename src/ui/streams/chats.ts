/**
 * The chats list page's one live feed.
 *
 * The server publishes `focused_chat_updated` on a channel of its own, because a
 * conversation's stream would download a whole transcript for a list of titles.
 * The frame names what changed and the lists come from the list route, so this
 * module does one thing: hand the frame's change to the state module, which reads
 * the lists it can touch.
 *
 * Everything else about the connection is `StreamClient`'s, and it is the same
 * rule the other pages follow: the browser resumes a dropped connection, a stream
 * the server answered with a non-200 code is opened again after a growing wait,
 * nothing is opened while the page is hidden, a page hidden for a minute gives up
 * its stream, and a return (or `pageshow` from the back/forward cache, or
 * `online`) opens a new one.
 *
 * The first `snapshot` answers the connection the page just made, and the lists
 * were read a moment before it. Every later one follows a reopen, and it stands
 * for frames the server no longer holds, so both lists are read again.
 */
import { changeOf, refreshFromStream } from "../state/chats.ts";
import { StreamClient } from "./client.ts";

/** The path the list page's stream is served on. */
export const CHATS_STREAM_PATH = "/api/focused-chats/events";

/** Open the page's stream. The caller keeps the client to stop it when the page goes. */
export function startChatsStream(): StreamClient {
  const client = new StreamClient({ path: CHATS_STREAM_PATH });
  client.on("snapshot", (event) => {
    if (event.snapshotCount > 1) void refreshFromStream();
  });
  client.on("focused_chat_updated", (event) => {
    void refreshFromStream(changeOf(event.data));
  });
  client.start();
  return client;
}
