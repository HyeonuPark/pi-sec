/**
 * Keeping the lists current: the page's one light stream, and the ways a page
 * that was away catches up.
 *
 * The stream carries `focused_chat_updated` and nothing else, so what it costs is
 * one read of the lists it can touch, and a burst costs one read per burst. The
 * connection's own rules — a hidden tab gives up its stream after a minute, a
 * return opens a new one, and the snapshot that new stream opens with stands for
 * the frames nobody heard — are `StreamClient`'s, and these tests drive them
 * through the page.
 */
import { describe, expect, it, vi } from "vitest";
import { archivedChat, archivedReads, activeReads, chatsPage, click, openChat, rows } from "./chats-fixtures.ts";
import { settle, type UiPageHandle } from "./harness.ts";

/** One stream frame, as the server writes it. */
function frame(change: string, conversationId = 3): Record<string, unknown> {
  return { conversationId, name: `focused-${conversationId}`, title: null, openedAt: 0, archivedAt: null, change };
}

/** The opening frame of a stream, which is the whole state and no change. */
const SNAPSHOT = { type: "snapshot", apiVersion: 1 };

describe("the focused chat stream (2.3-8)", () => {
  it("opens the focused chats' own stream, and reads nothing for the snapshot it opens with", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      // One light stream, and it is the focused chats' own: a conversation's
      // stream would download a whole transcript for a list of titles.
      expect(page.streams()).toEqual(["/api/focused-chats/events"]);

      const before = page.fetchCalls.length;
      page.emit("snapshot", SNAPSHOT);
      await settle();
      // The first snapshot answers the connection this page just made, and the
      // lists were read a moment before it.
      expect(page.fetchCalls.length).toBe(before);
      expect(archivedReads(page)).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("reads the open list for a title, and both lists for a chat that moved", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();

      page.server.active = [openChat(3, "Renamed by the agent")];
      page.emit("focused_chat_updated", frame("titled"));
      await settle();
      // A titled chat is an open chat: the archived list is untouched by it.
      expect(rows(page)[0]?.querySelector(".chat-row-title")?.textContent).toBe("Renamed by the agent");
      expect(activeReads(page)).toHaveLength(2);
      expect(archivedReads(page)).toHaveLength(1);

      page.server.active = [];
      page.server.archived = { "": { items: [archivedChat(3, "Renamed by the agent")] } };
      page.emit("focused_chat_updated", frame("archived"));
      await settle();
      // An archived chat moves between the lists, so both are read.
      expect(activeReads(page)).toHaveLength(3);
      expect(archivedReads(page)).toHaveLength(2);
      expect(page.document.querySelector('.chat-row[data-id="3"] .chat-row-open')?.getAttribute("href")).toBe(
        "/basic-chat?chat=3",
      );
    } finally {
      page.close();
    }
  });

  it("reads both lists again when a reconnection arrives as a snapshot", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const active = activeReads(page).length;
      const archived = archivedReads(page).length;

      // A snapshot after the first answers a reopen, and stands for frames the
      // server no longer holds.
      page.emit("snapshot", SNAPSHOT);
      await settle();
      expect(activeReads(page)).toHaveLength(active + 1);
      expect(archivedReads(page)).toHaveLength(archived + 1);
    } finally {
      page.close();
    }
  });

  it("answers a burst of changes with one read of each list, and then stops", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const before = { active: activeReads(page).length, archived: archivedReads(page).length, all: page.fetchCalls.length };

      // Three frames arrive back to back. The first is answered at once; the
      // other two are answered by the one read that follows it, because a read
      // in flight already covers them.
      for (const change of ["opened", "titled", "opened"]) page.emit("focused_chat_updated", frame(change));
      await settle();
      expect(activeReads(page).length - before.active).toBe(2);
      expect(archivedReads(page).length - before.archived).toBe(1);

      // Nothing is left queued: a page that keeps reading after the burst is a
      // page spinning on its own events.
      await settle();
      expect(page.fetchCalls.length).toBe(before.all + 3);
    } finally {
      page.close();
    }
  });

  it("keeps the search term and the pages already loaded when the stream reads again", async () => {
    const page = await chatsPage({
      active: [],
      archived: {
        "": { items: [archivedChat(1, "Release notes")], next: "plan-2" },
        "plan-2": { items: [archivedChat(3, "Release plan")] },
      },
    });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const field = page.document.getElementById("archive-q") as HTMLInputElement;
      field.value = "release";
      page.document
        .getElementById("archive-search")
        ?.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      click(page, page.document.getElementById("load-more") as HTMLElement);
      await settle();
      expect(rows(page)).toHaveLength(2);

      const read = archivedReads(page).length;
      page.emit("focused_chat_updated", { conversationId: 9, title: "Old topic", change: "deleted" });
      await settle();

      // The archived list is read on the term it was searched with, and as deep
      // as it had been read.
      expect(archivedReads(page).slice(read).map((each) => each.url)).toEqual([
        "/api/focused-chats?state=archived&q=release",
        "/api/focused-chats?state=archived&q=release&cursor=plan-2",
      ]);
      expect(rows(page)).toHaveLength(2);
    } finally {
      page.close();
    }
  });

  it("reads both lists again from the reload press", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      const before = archivedReads(page).length;
      click(page, page.document.getElementById("reload") as HTMLElement);
      await settle();
      expect(archivedReads(page)).toHaveLength(before + 1);
    } finally {
      page.close();
    }
  });

  it("reads both lists again when the window comes back", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      const before = page.fetchCalls.length;
      page.window.dispatchEvent(new page.window.Event("focus"));
      await settle();
      // The focus fallback stays: it covers a stream that was down while the
      // tab was hidden, and a list is read at a glance.
      expect(page.fetchCalls.length).toBeGreaterThan(before);
      expect(archivedReads(page)).toHaveLength(2);
    } finally {
      page.close();
    }
  });
});

describe("a page that was away (2.3-9)", () => {
  /** Run `body` with the page's clock under the test's control. */
  async function withFakeClock(body: (flush: () => Promise<void>) => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await body(() => vi.advanceTimersByTimeAsync(0));
    } finally {
      vi.useRealTimers();
    }
  }

  it("closes the stream of a tab hidden for a minute, and opens a new one on the return", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes")],
      archived: { "": { items: [archivedChat(1, "Release notes")] } },
    });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      await withFakeClock(async (flush) => {
        const archivedBefore = archivedReads(page).length;
        page.setVisibility("hidden");
        await vi.advanceTimersByTimeAsync(59_999);
        // A minute has not passed, so the light stream stays open.
        expect(page.currentStream().closed).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        // A minute hidden: the page gives up its own stream, and opens nothing
        // while the tab is still hidden.
        expect(page.currentStream().closed).toBe(true);
        expect(page.streams()).toHaveLength(1);

        page.setVisibility("visible");
        await flush();
        // The return opens a new stream, which starts with a snapshot.
        expect(page.streams()).toHaveLength(2);
        expect(page.streams()[1]).toBe("/api/focused-chats/events");

        page.emit("snapshot", SNAPSHOT);
        await flush();
        // That snapshot stands for a minute of frames nobody heard, so both
        // lists are read again.
        expect(archivedReads(page)).toHaveLength(archivedBefore + 1);
        expect(activeReads(page)).toHaveLength(2);
      });
    } finally {
      page.close();
    }
  });

  it("keeps its stream, and reads nothing, when the tab comes back before the minute is up", async () => {
    const page: UiPageHandle = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      await withFakeClock(async (flush) => {
        const before = page.fetchCalls.length;
        page.setVisibility("hidden");
        await vi.advanceTimersByTimeAsync(20_000);

        page.setVisibility("visible");
        await vi.advanceTimersByTimeAsync(60_000);

        expect(page.currentStream().closed).toBe(false);
        expect(page.streams()).toHaveLength(1);
        // Nothing was read either: the connection was never away.
        expect(page.fetchCalls.length).toBe(before);
      });
    } finally {
      page.close();
    }
  });

  it("opens a new stream for a page restored from the back/forward cache, and reads on its snapshot", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      page.emit("snapshot", SNAPSHOT);
      await settle();
      const archivedBefore = archivedReads(page).length;

      page.pageShow(true);
      await settle();
      expect(page.streams()).toHaveLength(2);

      page.emit("snapshot", SNAPSHOT);
      await settle();
      expect(archivedReads(page)).toHaveLength(archivedBefore + 1);
    } finally {
      page.close();
    }
  });
});
