/**
 * The chats list itself: the three sections, the search over the archived titles,
 * and the button that reads the next page.
 *
 * What the page asks the server for is the whole point of these tests. The
 * archived list is read one page at a time with the cursor the last answer left
 * behind, the term travels as `q` on that same read, and a row's own press names
 * one chat. The page also splits the open chats it is given: the ones an agent
 * opened with `{"test": true}` go to `Test`, which starts closed.
 */
import { describe, expect, it } from "vitest";
import type { ChatsServer } from "./chats-fixtures.ts";
import {
  activeReads,
  answerFrom,
  archivedChat,
  archivedReads,
  chatsPage,
  click,
  openChat,
  rows,
  search,
  testRows,
  testToggle,
} from "./chats-fixtures.ts";
import { settle, type UiPageHandle } from "./harness.ts";

/** Whether the `Test` section says it is open. */
function testIsOpen(toggle: HTMLElement): boolean {
  return toggle.getAttribute("aria-expanded") === "true";
}

describe("the Active section (2.3-1)", () => {
  it("lists the open chats that are not tests, and says each row's facts", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes", { running: true }), openChat(4, null)],
      archived: { "": { items: [] } },
    });
    try {
      const headings = [...page.document.querySelectorAll("h2.report-h2")].map((each) => each.textContent);
      expect(headings[0]).toBe("Active (2)");

      const row = rows(page)[0];
      const title = row?.querySelector(".chat-row-title");
      expect(title?.textContent).toBe("Topic notes");
      expect(title?.getAttribute("title")).toBe("Topic notes");
      // The link is the row's whole left side, and it names one conversation.
      expect(row?.querySelector(".chat-row-open")?.getAttribute("href")).toBe("/basic-chat?chat=3");
      // When it was opened is the tooltip's exact stamp, in the harness zone.
      expect(row?.querySelector(".chat-row-meta span")?.getAttribute("title")).toBe("Opened 2026-10-24 12:00 Asia/Tokyo");
      // Running or not is one of the row's facts.
      expect(page.document.querySelector(".chat-row-running")?.textContent).toBe("running");
      expect(page.document.querySelector(".chat-row-running")?.getAttribute("title")).toBe(
        "An answer is being written",
      );
      // A chat the agent has not named yet reads as Untitled.
      expect(rows(page)[1]?.querySelector(".chat-row-title")?.textContent).toBe("Untitled");
      // The open rows are the renamed ones: a press per row names its chat.
      expect(rows(page).map((each) => each.querySelector("[data-rename]")?.getAttribute("data-rename"))).toEqual([
        "3",
        "4",
      ]);
    } finally {
      page.close();
    }
  });

  it("says when there is no open chat", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      expect(page.document.querySelector("#view .report-empty")?.textContent).toBe("No open chats.");
      expect(rows(page)).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});

describe("the Test section (2.3-2)", () => {
  it("holds the open test chats, and only those", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes"), openChat(4, "Test topic", { test: true })],
      // An archived chat keeps whatever mark it was opened with, and the page
      // does not filter the archived list: the server pages it.
      archived: { "": { items: [archivedChat(9, "Old topic", { test: true })] } },
    });
    try {
      const headings = [...page.document.querySelectorAll("h2.report-h2")].map((each) => each.textContent);
      expect(headings[0]).toBe("Active (1)");
      expect(testToggle(page).textContent).toBe("Test (1)");
      expect(testRows(page).map((row) => row.getAttribute("data-id"))).toEqual(["4"]);
      // The three sections keep their order: active, test, archived.
      expect(rows(page).map((row) => row.getAttribute("data-id"))).toEqual(["3", "4", "9"]);
      // A test chat is renamed like an open one: the section is a place, not a
      // different kind of row.
      expect(page.document.querySelector('#test-rows [data-rename="4"]')).not.toBeNull();
      expect(page.document.querySelector('#test-rows [data-id="9"]')).toBeNull();
      expect(headings[2]).toBe("Archived (1)");
    } finally {
      page.close();
    }
  });

  it("starts closed on every load, with the count drawn even at zero", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      expect(testToggle(page).textContent).toBe("Test (0)");
      expect(testIsOpen(testToggle(page))).toBe(false);
      expect(testToggle(page).getAttribute("aria-controls")).toBe("test-rows");
      // Only the heading is shown. The rows are in the page all the same, which
      // is what the heading promises to control, and a class keeps them out of
      // sight.
      expect(page.document.getElementById("test-rows")?.getAttribute("class")).toBe("hidden");
      expect(page.document.querySelector("#test-rows .report-empty")?.textContent).toBe("No test chats.");
    } finally {
      page.close();
    }
  });

  it("opens from its heading, closes from it again, and reads nothing for either", async () => {
    const page = await chatsPage({
      active: [openChat(4, "Test topic", { test: true })],
      archived: { "": { items: [] } },
    });
    try {
      const before = page.fetchCalls.length;
      click(page, testToggle(page));
      await settle();
      expect(testIsOpen(testToggle(page))).toBe(true);
      expect(page.document.getElementById("test-rows")?.hasAttribute("class")).toBe(false);
      expect(testRows(page)).toHaveLength(1);

      click(page, testToggle(page));
      await settle();
      expect(testIsOpen(testToggle(page))).toBe(false);
      expect(page.document.getElementById("test-rows")?.getAttribute("class")).toBe("hidden");
      // The rows were in the page already, so neither press read the server.
      expect(page.fetchCalls.length).toBe(before);
    } finally {
      page.close();
    }
  });

  it("stays open when a stream frame draws the lists again", async () => {
    const page = await chatsPage({
      active: [openChat(4, "Test topic", { test: true })],
      archived: { "": { items: [] } },
    });
    try {
      click(page, testToggle(page));
      await settle();
      expect(testIsOpen(testToggle(page))).toBe(true);

      page.server.active = [openChat(4, "Renamed by the agent", { test: true }), openChat(5, "Another topic")];
      page.emit("focused_chat_updated", { conversationId: 5, title: "Another topic", change: "titled" });
      await settle();

      expect(page.document.getElementById("view")?.textContent).toContain("Renamed by the agent");
      expect(testToggle(page).textContent).toBe("Test (1)");
      // The reader's press is still in force after the read.
      expect(testIsOpen(testToggle(page))).toBe(true);
      expect(page.document.getElementById("test-rows")?.hasAttribute("class")).toBe(false);
      expect(testRows(page).map((row) => row.getAttribute("data-id"))).toEqual(["4"]);
    } finally {
      page.close();
    }
  });
});

describe("the Archived section (2.3-3)", () => {
  it("lists the archived chats, marks a further page with `+`, and says when one was archived", async () => {
    const page = await chatsPage({
      active: [],
      archived: { "": { items: [archivedChat(9, "Old topic")], next: "page-2" } },
    });
    try {
      const headings = [...page.document.querySelectorAll("h2.report-h2")].map((each) => each.textContent);
      // The `+` says another page waits behind this one.
      expect(headings[2]).toBe("Archived (1+)");
      const row = page.document.querySelector('.chat-row[data-id="9"]');
      // Where the open row carries the press that renames it, an archived row
      // says when the chat was archived: an archived chat cannot be renamed.
      expect(row?.querySelector("[data-rename]")).toBeNull();
      expect(row?.querySelector(".chat-row-meta")?.textContent).toBe("opened 4d agoarchived 4d ago");
      expect(row?.querySelectorAll(".chat-row-meta span")[1]?.getAttribute("title")).toBe(
        "Archived 2026-10-24 12:00 Asia/Tokyo",
      );
      expect(page.document.getElementById("load-more")?.textContent).toBe("Load more");
    } finally {
      page.close();
    }
  });

  it("says when no chat was archived, and when a term matched none", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      const empties = () => [...page.document.querySelectorAll("#view .report-empty")].map((each) => each.textContent);
      expect(empties().at(-1)).toBe("No archived chats.");

      search(page, "nothing matches this");
      await settle();
      expect(empties().at(-1)).toBe("No archived chat matches that title.");
    } finally {
      page.close();
    }
  });
});

describe("the search over archived titles (2.3-6)", () => {
  it("reads nothing while the term is being typed, and reads it once on submit", async () => {
    const page = await chatsPage({
      active: [],
      archived: { "": { items: [archivedChat(1, "Release notes")] } },
    });
    try {
      const before = archivedReads(page).length;
      const field = page.document.getElementById("archive-q") as HTMLInputElement;
      field.value = "rel";
      field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await settle();
      // Half a word is a read of half a list, so typing reads nothing.
      expect(archivedReads(page)).toHaveLength(before);

      search(page, "  release  ");
      await settle();
      // The term travels trimmed and as `q` on the archived read.
      expect(archivedReads(page).at(-1)?.url).toBe("/api/focused-chats?state=archived&q=release");
      expect(archivedReads(page)).toHaveLength(before + 1);
    } finally {
      page.close();
    }
  });

  it("reads a term once, because the same term is the same list", async () => {
    const page = await chatsPage({
      active: [],
      archived: { "": { items: [archivedChat(1, "Release notes")], next: "page-2" }, "page-2": { items: [archivedChat(2, "Release plan")] } },
    });
    try {
      search(page, "release");
      await settle();
      const after = archivedReads(page).length;
      search(page, "release");
      await settle();
      // A second read would only move a reader who had loaded more back to the
      // first page.
      expect(archivedReads(page)).toHaveLength(after);
    } finally {
      page.close();
    }
  });

  it("starts a new term at the first page, however deep the old one was read", async () => {
    const page = await chatsPage({
      active: [],
      archived: {
        "": { items: [archivedChat(1, "Release notes")], next: "page-2" },
        "page-2": { items: [archivedChat(2, "Release plan")] },
      },
    });
    try {
      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();
      expect(rows(page)).toHaveLength(2);

      search(page, "release");
      await settle();
      const last = archivedReads(page).at(-1);
      expect(last?.url).toBe("/api/focused-chats?state=archived&q=release");
      expect(last?.url).not.toContain("cursor=");
    } finally {
      page.close();
    }
  });
});

describe("Load more (2.3-7)", () => {
  it("reads the page the last answer pointed at, and adds its rows under the ones already read", async () => {
    const page = await chatsPage({
      active: [],
      archived: {
        "": { items: [archivedChat(1, "One"), archivedChat(2, "Two")], next: "page-2" },
        "page-2": { items: [archivedChat(3, "Three")] },
      },
    });
    try {
      // The first read asks for the archived state alone: no cursor, no term.
      expect(archivedReads(page).map((each) => each.url)).toEqual(["/api/focused-chats?state=archived"]);
      expect(rows(page)).toHaveLength(2);

      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();

      expect(archivedReads(page).at(-1)?.url).toBe("/api/focused-chats?state=archived&cursor=page-2");
      expect(rows(page).map((row) => row.getAttribute("data-id"))).toEqual(["1", "2", "3"]);
      // That answer carried no `next`, so the list ends here.
      expect(page.document.getElementById("load-more")).toBeNull();
      // The heading keeps its count and loses its `+`.
      expect([...page.document.querySelectorAll("h2.report-h2")][2]?.textContent).toBe("Archived (3)");
    } finally {
      page.close();
    }
  });

  it("keeps the term on the next page", async () => {
    const page = await chatsPage({
      active: [],
      archived: {
        "": { items: [archivedChat(1, "Release notes")], next: "plan-2" },
        "plan-2": { items: [archivedChat(3, "Release plan")] },
      },
    });
    try {
      search(page, "release");
      await settle();
      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();

      const last = archivedReads(page).at(-1)?.url;
      expect(last).toContain("q=release");
      expect(last).toContain("cursor=plan-2");
      expect(rows(page)).toHaveLength(2);
    } finally {
      page.close();
    }
  });
});

describe("a press that meets a read in flight", () => {
  /**
   * Hold the next archived read that `when` accepts until the test calls the
   * returned function. A read with a `q` term answers the release list, so the
   * term decides the rows, as it does on the server.
   */
  function hold(page: UiPageHandle, server: ChatsServer, when: (url: URL) => boolean): () => void {
    const inner = answerFrom(server);
    let gate: (() => void) | undefined;
    let armed = true;
    page.respond("/api/focused-chats", async (request) => {
      const url = new URL(request.url, "http://localhost");
      const archived = request.method === "GET" && url.searchParams.get("state") === "archived";
      const held = archived && armed && when(url);
      if (held) {
        armed = false;
        const answered = await inner(request);
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        return answered;
      }
      if (archived && url.searchParams.get("q") === "release") {
        return { body: { items: [archivedChat(7, "Release notes")] } };
      }
      return inner(request);
    });
    return () => gate?.();
  }

  const lists = (): ChatsServer => ({
    active: [],
    archived: {
      "": { items: [archivedChat(1, "One")], next: "page-2" },
      "page-2": { items: [archivedChat(2, "Two")] },
    },
  });

  it("reads the new term when it is submitted while a stream read runs", async () => {
    const server = lists();
    const page = await chatsPage(server);
    try {
      const release = hold(page, server, () => true);
      page.emit("focused_chat_updated", { conversationId: 1, title: "One", change: "archived" });
      await settle();
      search(page, "release");
      await settle();
      release();
      await settle();
      await settle();

      expect(archivedReads(page).some((each) => each.url.includes("q=release"))).toBe(true);
      expect(rows(page).map((row) => row.getAttribute("data-id"))).toEqual(["7"]);
    } finally {
      page.close();
    }
  });

  it("drops a page read with the old term when a new term is submitted", async () => {
    const server = lists();
    const page = await chatsPage(server);
    try {
      const release = hold(page, server, (url) => url.searchParams.get("cursor") === "page-2");
      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();
      search(page, "release");
      await settle();
      release();
      await settle();
      await settle();

      expect(rows(page).map((row) => row.getAttribute("data-id"))).toEqual(["7"]);
    } finally {
      page.close();
    }
  });

  it("reads the open list again for a title that changes while the archived list is read", async () => {
    const server = lists();
    server.active = [openChat(3, "Old title")];
    const page = await chatsPage(server);
    try {
      const release = hold(page, server, () => true);
      click(page, page.document.getElementById("reload") as HTMLElement);
      await settle();
      const before = activeReads(page).length;
      server.active = [openChat(3, "New title")];
      page.emit("focused_chat_updated", { conversationId: 3, title: "New title", change: "titled" });
      await settle();
      release();
      await settle();
      await settle();

      expect(activeReads(page).length).toBeGreaterThan(before);
      expect(page.document.getElementById("view")?.textContent).toContain("New title");
    } finally {
      page.close();
    }
  });
});
