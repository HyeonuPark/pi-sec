/**
 * The two places the hand-written page reset what a reader was doing, and what
 * the new page must not reset.
 *
 * The page rebuilt the whole list on every
 * read, which threw away a term typed into the search field but not submitted,
 * the caret in it, the focus in it, the scroll position, and every row's
 * element. Each test here writes into the search field, or takes hold of a row,
 * and then asks the server for a new answer — through the stream, the reload
 * press, a rename and the next page. The element must be the same element, and
 * what the reader put in it must still be there.
 *
 * A row is renamed through the page's question (`window.prompt`), not through a
 * field inside the row, so the row's own way of being "in the middle of
 * something" is the press that is held: its Rename button keeps the focus.
 */
import { describe, expect, it } from "vitest";
import { archivedChat, archivedReads, chatsPage, click, openChat, rows } from "./chats-fixtures.ts";
import { settle, type UiPageHandle } from "./harness.ts";

/** The opening frame of a stream, which is the whole state and no change. */
const SNAPSHOT = { type: "snapshot", apiVersion: 1 };

/** Two archived pages, so `Load more` is in the page, and two open chats. */
const serverWithMore = () => ({
  active: [openChat(3, "Topic notes"), openChat(4, "Second topic")],
  archived: {
    "": { items: [archivedChat(1, "Release notes")], next: "plan-2" },
    "plan-2": { items: [archivedChat(2, "Release plan")] },
  },
});

/** Write a term into the archived search, put the caret in it, and hold it focused. */
function typeIntoSearch(page: UiPageHandle, term: string, caret: number): HTMLInputElement {
  const field = page.document.getElementById("archive-q") as HTMLInputElement;
  field.focus();
  field.value = term;
  field.setSelectionRange(caret, caret);
  return field;
}

describe("the archived search field keeps what is being typed", () => {
  it("across a stream frame that reads the lists again", async () => {
    const page = await chatsPage(serverWithMore());
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const field = typeIntoSearch(page, "rel", 3);
      const before = page.capture("#archive-q");

      page.emit("focused_chat_updated", { conversationId: 4, title: "Second topic", change: "titled" });
      await settle();

      expect(page.document.getElementById("archive-q")).toBe(field);
      page.expectUntouched(before);
    } finally {
      page.close();
    }
  });

  it("across the reload press", async () => {
    const page = await chatsPage(serverWithMore());
    try {
      const field = typeIntoSearch(page, "release", 4);
      const before = page.capture("#archive-q");

      click(page, page.document.getElementById("reload") as HTMLElement);
      await settle();

      expect(page.document.getElementById("archive-q")).toBe(field);
      page.expectUntouched(before);
    } finally {
      page.close();
    }
  });

  it("across another row's rename", async () => {
    const page = await chatsPage(serverWithMore());
    try {
      const field = typeIntoSearch(page, "rel", 2);
      const before = page.capture("#archive-q");
      page.window.prompt = (() => "Newer") as typeof page.window.prompt;

      click(page, page.document.querySelector('[data-rename="4"]') as HTMLElement);
      await settle();

      // The rename was sent and the lists were read again, and the field the
      // reader was in is the same field with the same text and caret.
      expect(page.fetchCalls.filter((each) => each.method === "PATCH")).toHaveLength(1);
      expect(page.document.getElementById("archive-q")).toBe(field);
      page.expectUntouched(before);
    } finally {
      page.close();
    }
  });

  it("across Load more", async () => {
    const page = await chatsPage(serverWithMore());
    try {
      const field = typeIntoSearch(page, "rel", 1);
      const before = page.capture("#archive-q");
      const archivedBefore = archivedReads(page).length;

      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();

      expect(archivedReads(page)).toHaveLength(archivedBefore + 1);
      expect(page.document.getElementById("archive-q")).toBe(field);
      page.expectUntouched(before);
    } finally {
      page.close();
    }
  });

  it("does not take the field back to the term that was searched", async () => {
    const page = await chatsPage(serverWithMore());
    try {
      const field = typeIntoSearch(page, "  release  ", 0);
      page.document
        .getElementById("archive-search")
        ?.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();

      // The read went out with the trimmed term, and the field still holds what
      // the reader typed, spaces and all, with the caret where it was.
      expect(archivedReads(page).at(-1)?.url).toBe("/api/focused-chats?state=archived&q=release");
      expect(page.document.getElementById("archive-q")).toBe(field);
      expect(field.value).toBe("  release  ");
      expect(field.selectionStart).toBe(0);
      expect(page.document.activeElement).toBe(field);
    } finally {
      page.close();
    }
  });
});

describe("the rows keep their elements", () => {
  it("leaves a row that did not change as the same element, with the changed row's own element kept", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes"), openChat(4, "Second topic", { running: true })],
      archived: { "": { items: [archivedChat(9, "Old topic")] } },
    });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const unchanged = page.document.querySelector('.chat-row[data-id="3"]');
      const changed = page.document.querySelector('.chat-row[data-id="4"]');
      const archived = page.document.querySelector('.chat-row[data-id="9"]');
      // The row is what holds the reader's focus, so the element is what has to
      // survive: the title inside it may change, the row may not go.
      const press = changed?.querySelector("[data-rename]") as HTMLButtonElement;
      press.focus();

      page.server.active = [openChat(3, "Topic notes"), openChat(4, "Second topic, renamed")];
      page.emit("focused_chat_updated", { conversationId: 4, change: "titled" });
      await settle();

      expect(page.document.querySelector('.chat-row[data-id="3"]')).toBe(unchanged);
      expect(page.document.querySelector('.chat-row[data-id="4"]')).toBe(changed);
      expect(page.document.querySelector('.chat-row[data-id="9"]')).toBe(archived);
      // Only the text changed, and the press that held the focus is the same
      // press, still holding it.
      expect(changed?.querySelector(".chat-row-title")?.textContent).toBe("Second topic, renamed");
      expect(page.document.querySelector('.chat-row[data-id="4"] [data-rename]')).toBe(press);
      expect(page.document.activeElement).toBe(press);
    } finally {
      page.close();
    }
  });

  it("keeps the focus on a row's Rename press while another row is refreshed", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes"), openChat(4, "Second topic")],
      archived: { "": { items: [] } },
    });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const press = page.document.querySelector('[data-rename="3"]') as HTMLButtonElement;
      press.focus();
      const before = page.capture('[data-rename="3"]');

      page.server.active = [openChat(3, "Topic notes"), openChat(4, "Second topic", { running: true })];
      page.emit("focused_chat_updated", { conversationId: 4, change: "opened" });
      await settle();

      expect(page.document.querySelector('[data-rename="3"]')).toBe(press);
      page.expectUntouched(before);
    } finally {
      page.close();
    }
  });

  it("does not reorder or renumber the rows of a list that did not change", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes")],
      archived: { "": { items: [archivedChat(9, "Old topic")] } },
    });
    try {
      const list = page.document.querySelector("#view .report-list");
      click(page, page.document.getElementById("reload") as HTMLElement);
      await settle();
      // The same answer leaves the same list: Preact saw the signal's value was
      // the value it already had, so nothing under the list was drawn again.
      expect(page.document.querySelector("#view .report-list")).toBe(list);
    } finally {
      page.close();
    }
  });
});
