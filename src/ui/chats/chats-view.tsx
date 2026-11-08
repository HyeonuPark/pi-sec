/**
 * The chat list page, drawn from the state module.
 *
 * The markup is the one the hand-written chats page wrote (removed in this
 * commit): the same headings,
 * the same tools, the same three sections in the same order, the same search
 * form. Nothing here reads the server, and nothing here is drawn from anything a
 * reader typed: the search field is a field with no value bound to it, so a
 * refresh cannot put back a word the reader has moved on from.
 *
 * The sections are drawn while the page is empty too, so the shape of the page is
 * the same before and after the first read; only the rows and the counts change.
 */
import { activeChats, archivedChats, archivedNext, creatingChat, loadMore, newChat, reload, searchArchived, testSectionOpen } from "../state/chats.ts";
import { mount } from "../mount.ts";
import { ChatRowList } from "./chat-row.tsx";

/** The sentence a page with no mount stamp says instead of drawing a list. */
export const MOUNT_UNKNOWN =
  "Mount point unknown — this page carried no mount stamp and its path does not name a known page, " +
  "so its URLs cannot be built. Reload it from the server.";

/**
 * The archived list is read when the search is submitted, not on every keystroke:
 * the term is the key of a read, and half a word is a read of half the list.
 */
function onSearchSubmit(event: Event): void {
  event.preventDefault();
  const field = document.getElementById("archive-q");
  const term = field instanceof HTMLInputElement ? field.value.trim() : "";
  void searchArchived(term);
}

/** The chats list page. */
export function ChatsView() {
  if (!mount().known) return <p class="report-empty">{MOUNT_UNKNOWN}</p>;

  const active = activeChats.value;
  const regular = active.filter((item) => item.test !== true);
  const test = active.filter((item) => item.test === true);
  const archived = archivedChats.value;
  const open = testSectionOpen.value;
  const more = archivedNext.value !== undefined;

  return (
    <>
      <h1 class="report-h1">Chats</h1>
      <p class="report-hint">
        A focused chat is a sub-session of the root: a long conversation about one topic. It reads; it does not change
        the system.
      </p>
      <div class="chats-tools">
        <button id="new-chat" class="button button-primary" type="button" disabled={creatingChat.value} onClick={() => void newChat()}>
          New chat
        </button>
        <button id="reload" class="button" type="button" onClick={() => void reload()}>
          ↻ reload
        </button>
      </div>
      <h2 class="report-h2">{`Active (${regular.length})`}</h2>
      <ChatRowList items={regular} archived={false} />
      {/* `Test` sits between the two lists, closed on every load, so its heading
          and count are all a reader sees until it is pressed. The rows are in the
          page while it is closed, which is what `aria-controls` promises, and a
          class hides them. */}
      <h2 class="report-h2">
        <button
          id="test-toggle"
          class="chats-test-toggle"
          type="button"
          aria-expanded={open ? "true" : "false"}
          aria-controls="test-rows"
          onClick={() => {
            testSectionOpen.value = !testSectionOpen.value;
          }}
        >
          {`Test (${test.length})`}
        </button>
      </h2>
      <div id="test-rows" class={open ? undefined : "hidden"}>
        <ChatRowList items={test} archived={false} empty="No test chats." />
      </div>
      <h2 class="report-h2">{`Archived (${archived.length}${more ? "+" : ""})`}</h2>
      <form id="archive-search" class="chats-search" role="search" onSubmit={onSearchSubmit}>
        <input
          id="archive-q"
          class="chats-search-input"
          type="search"
          placeholder="Search titles"
          aria-label="Search archived titles"
          defaultValue=""
        />
        <button class="button" type="submit">
          Search
        </button>
      </form>
      <ChatRowList items={archived} archived={true} />
      {more ? (
        <button id="load-more" class="button" type="button" onClick={() => void loadMore()}>
          Load more
        </button>
      ) : null}
    </>
  );
}
