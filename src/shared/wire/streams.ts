/**
 * The five server event streams, and the shape of one frame on any of them.
 *
 * The wire types here are shared by the server and the page code: they describe
 * what travels between them, and hold no code and no import of `src/server`, so
 * the page type check does not pull the Node types in with them. A page's own
 * snapshot and event payload types belong to that page's files.
 *
 * The server writes one frame as three lines and a blank line
 * (`src/server/sse.ts` · `formatFrame`):
 *
 * ```text
 * id: 42
 * event: snapshot
 * data: {"type":"snapshot","apiVersion":1}
 * ```
 *
 * The browser hands the same three fields to the page through a `MessageEvent`,
 * where `lastEventId` is the `id` as text.
 */

/**
 * The paths of the five streams. The conversation stream of a focused chat is
 * the only one whose path carries a value, so it is a template type.
 *
 * @see `/basic-chat/events` — the root conversation, plus the pi-sec control events
 * @see `/api/conversations/:id/events` — one conversation, by id
 * @see `/api/jobs/events` — `snapshot`, `job_created`, `job_updated`
 * @see `/api/focused-chats/events` — `snapshot`, `focused_chat_updated`, `preferences_updated`
 * @see `/api/user-queries/events` — `snapshot`, `user_query`, `user_query_resolved`
 */
export type StreamPath =
  | "/basic-chat/events"
  | `/api/conversations/${number}/events`
  | "/api/jobs/events"
  | "/api/focused-chats/events"
  | "/api/user-queries/events";

/** One frame of a stream, as the server writes it. */
export interface StreamFrame<TData = unknown> {
  /** Counts up per channel. The browser reports it as `lastEventId`. */
  readonly id: number;
  /** The frame's name. A stream sends a known set of them. */
  readonly event: string;
  /** The JSON the server wrote for this frame. */
  readonly data: TData;
}

/**
 * The frame every stream opens with: the whole state as it is now.
 *
 * A reconnect that replays missed frames can also end in a snapshot, when the
 * server no longer holds what it would replay.
 */
export interface SnapshotFrame<TState = unknown> {
  readonly id: number;
  readonly event: "snapshot";
  readonly data: TState & {
    readonly type: "snapshot";
    /** The server's HTTP API version, so a page can refuse a shape it cannot read. */
    readonly apiVersion: number;
  };
}
