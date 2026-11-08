/**
 * What the chats list page reads and writes over HTTP, and what its stream says.
 *
 * The wire types here are shared by the server and the page code: they describe
 * what travels between them, and hold no code and no import of `src/server`, so
 * the page type check does not pull the Node types in with them.
 *
 * The shapes are the ones `src/server/routes/focused-chats.ts` answers with (a
 * list item is `focusedChatView(row)` plus `running`) and the one
 * `src/focused/service.ts` · `focusedChatEvent` publishes.
 */

/**
 * One chat as both lists give it.
 *
 * `title` is `null` until an agent names the chat, and the page draws `Untitled`
 * for it. `archived` is in the row as the server sends it; the page keeps the two
 * lists apart by the route it read, not by this field. `test` is the mark an
 * agent puts on a chat it opened to try something, and it is why the open list is
 * split in two. `running` says an answer is being written inside the chat now.
 */
export interface ChatsListItem {
  readonly conversationId: number;
  readonly name: string;
  readonly title: string | null;
  readonly openedAt: number;
  readonly archived: boolean;
  readonly archivedAt: number | null;
  readonly test: boolean;
  readonly running: boolean;
}

/**
 * One page of a list.
 *
 * `next` is the cursor of the page after this one, and it is absent at the end of
 * the list. The archived list is the only one that is paged.
 */
export interface ChatsListAnswer {
  readonly items: readonly ChatsListItem[];
  readonly next?: string;
}

/** What `POST /api/focused-chats` answers: the chat it opened. */
export interface NewChatAnswer {
  readonly conversationId: number;
  readonly name: string;
  readonly title: string | null;
  readonly openedAt: number;
  readonly test: boolean;
}

/** Which change the stream's `focused_chat_updated` frame reports. */
export type FocusedChatChange = "opened" | "titled" | "archived" | "deleted";

/**
 * One `focused_chat_updated` frame.
 *
 * The server sends the whole row with it, so the chat page can draw its bar
 * without a read. This page reads only `change`: a title in a list is a row of a
 * list that is read again, and the frame's copy of it could be older than the
 * read. The rest of the fields are here because they travel, not because this
 * page depends on them.
 */
export interface FocusedChatFrame {
  readonly conversationId?: number;
  readonly name?: string;
  readonly title?: string | null;
  readonly openedAt?: number;
  readonly archivedAt?: number | null;
  readonly change?: FocusedChatChange;
}
