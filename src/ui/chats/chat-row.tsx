/**
 * One chat row, and the list of them.
 *
 * The markup is the one the hand-written chats page wrote (removed in this
 * commit): the same classes, the same attributes, the same order. A row is drawn from the item
 * it is given and a list is drawn from the items it holds, so a reader's changes
 * to the page never reach it.
 *
 * A row is keyed by the number the server gave the chat, which is what lets
 * Preact keep the element of a row that did not change while another row's title
 * moves under the reader's cursor.
 */
import type { ChatsListItem } from "../../shared/wire/chats.ts";
import { archivedTerm, chatHref, renameChat } from "../state/chats.ts";
import { relativeTime, zoneStamp } from "./format.ts";

/** The name a row shows. A chat has no title until its agent picks one. */
function chatTitle(item: ChatsListItem): string {
  return typeof item.title === "string" && item.title !== "" ? item.title : "Untitled";
}

export interface ChatRowProps {
  readonly item: ChatsListItem;
  /** True for a row of the archived list, which says when it was archived. */
  readonly archived: boolean;
}

/**
 * One row: the chat's name and when it was opened, and either the press that
 * changes the title or, for an archived chat, when it was archived.
 *
 * The name is the link and the Rename button sits beside it rather than inside
 * it: a button inside an anchor is neither valid markup nor a press a browser
 * agrees on.
 */
export function ChatRow({ item, archived }: ChatRowProps) {
  const id = Number(item.conversationId);
  const name = chatTitle(item);
  const opened = zoneStamp(item.openedAt);
  const archivedAt = archived ? zoneStamp(item.archivedAt) : "";
  return (
    <div class="chat-row" data-id={String(id)}>
      <a class="chat-row-open" href={chatHref(id)}>
        <span class="chat-row-title" title={name}>
          {name}
        </span>
        <span class="chat-row-meta">
          {opened === "" ? null : (
            <span title={`Opened ${opened}`}>{`opened ${relativeTime(item.openedAt)}`}</span>
          )}
          {archivedAt === "" ? null : (
            <span title={`Archived ${archivedAt}`}>
              {`archived ${item.archivedAt === null ? "" : relativeTime(item.archivedAt)}`}
            </span>
          )}
          {item.running === true ? (
            <span class="chat-row-running" title="An answer is being written">
              running
            </span>
          ) : null}
        </span>
      </a>
      {archived ? null : (
        <button type="button" class="button chat-rename" data-rename={String(id)} onClick={() => void renameChat(id)}>
          Rename
        </button>
      )}
    </div>
  );
}

export interface ChatRowListProps {
  readonly items: readonly ChatsListItem[];
  readonly archived: boolean;
  /** The sentence a list draws when it is empty, when its own would say the wrong thing. */
  readonly empty?: string;
}

/** A list's rows, or the sentence that says there are none. */
export function ChatRowList({ items, archived, empty }: ChatRowListProps) {
  if (items.length > 0) {
    return (
      <div class="report-list">
        {items.map((item) => (
          <ChatRow key={String(item.conversationId)} item={item} archived={archived} />
        ))}
      </div>
    );
  }
  // A list whose emptiness means something of its own says that instead: the
  // Test section is empty or it is not, and an archived list says whether a term
  // is what left it empty.
  const none =
    empty ??
    (archived
      ? archivedTerm.value === ""
        ? "No archived chats."
        : "No archived chat matches that title."
      : "No open chats.");
  return <p class="report-empty">{none}</p>;
}
