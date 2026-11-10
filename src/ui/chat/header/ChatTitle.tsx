/**
 * The top bar's name for the conversation: the install's name on the root, the
 * chat's title on a focused chat, `Untitled` before the agent names one,
 * `Chat not found` for a number the server does not know, and
 * `Chat could not be read` when the read of its record failed in another way.
 *
 * A press on the title asks for a new one, and only a focused chat takes a press:
 * the root's name is not a title anybody changes here. The same state is what the
 * `Focused chat` mark and the browser tab's title follow; the tab's title and the
 * body's `data-chat` are not elements, so the mount helper writes them from the
 * same signals.
 *
 * The notice below the composer takes the composer's place when the chat cannot be
 * written to: an archived chat keeps its transcript, a chat the server does not
 * know has neither.
 */
import { chat, chatBlocked, chatName, chatsHref, renameChat } from "../../state/conversation.ts";

/** The name, the mark, the bar's colour and the tab's title. */
export function ChatTitle() {
  const name = chatName.value;
  const current = chat.value;
  const focused = !current.root;
  // A focused chat's title is the operator's to change until the chat is archived.
  const locked = !focused || current.archived || current.missing || current.unreadable;

  return (
    <button
      id="chat-title"
      class="chat-title"
      type="button"
      title={name}
      disabled={locked}
      onClick={() => void renameChat()}
    >
      {name}
    </button>
  );
}

/** The `Focused chat` mark in front of the title, shown only on a focused chat. */
export function ChatMark() {
  const focused = !chat.value.root;
  return (
    <span id="chat-mark" class={`chat-mark${focused ? "" : " hidden"}`}>
      Focused chat
    </span>
  );
}

/**
 * One line in the composer's place: what the page can do with this chat, and the
 * way to the list.
 */
export function ChatNotice() {
  const blocked = chatBlocked.value;
  const href = chatsHref();
  return (
    <div id="chat-notice" class={`chat-notice${blocked === null ? " hidden" : ""}`} role="status">
      {blocked === "archived" ? (
        <>
          This chat is archived. <a href={href}>All chats</a>
        </>
      ) : blocked === "missing" ? (
        <>
          This chat does not exist or was deleted. <a href={href}>All chats</a>
        </>
      ) : blocked === "unreadable" ? (
        <>
          This chat could not be read. Reload the page to try again. <a href={href}>All chats</a>
        </>
      ) : null}
    </div>
  );
}
