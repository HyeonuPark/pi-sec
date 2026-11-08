import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { MOUNT_UNKNOWN } from "../../src/ui/chats/chats-view.tsx";
import { archivedChat, chatsPage, openChat, type ChatsServer } from "./chats-fixtures.ts";
import { root, settle } from "./harness.ts";

// The first test loads the chats page modules cold. On a busy machine that load passes
// the default 5 s test limit. This line applies only to this file.
vi.setConfig({ testTimeout: 45_000 });

/**
 * What the hand-written page drew into `#view`, read from the file it printed
 * before the switch commit deleted it.
 *
 * `fixtures/old-dom/README.md` says how each file was produced and from which
 * commit, so the comparison stays against what the replaced code wrote rather
 * than against a copy of what that code was once thought to write.
 */
async function oldView(name: string): Promise<string> {
  return await readFile(join(root, "test/ui/fixtures/old-dom", `${name}.html`), "utf8");
}

/** Both pages with the same chats behind them: one open, one a test, one archived. */
function twoLists(): ChatsServer {
  return {
    active: [openChat(3, "Topic notes", { running: true }), openChat(4, null), openChat(5, "Test topic", { test: true })],
    archived: { "": { items: [archivedChat(9, "Old topic")], next: "page-2" } },
  };
}

describe("the chats page's markup", () => {
  it("draws the same elements, classes, attributes and order as the hand-written page", async () => {
    const page = await chatsPage(twoLists());
    try {
      expect(page.document.getElementById("view")?.innerHTML).toBe(await oldView("chats-two-lists"));
    } finally {
      page.close();
    }
  });

  it("draws the same markup for empty lists", async () => {
    const empty: ChatsServer = { active: [], archived: { "": { items: [] } } };
    const page = await chatsPage(empty);
    try {
      expect(page.document.getElementById("view")?.innerHTML).toBe(await oldView("chats-empty"));
      expect(page.document.querySelector(".report-empty")?.textContent).toBe("No open chats.");
    } finally {
      page.close();
    }
  });

  it("says a term matched no archived title, and leaves the field as the reader typed it", async () => {
    const server: ChatsServer = { active: [], archived: { "": { items: [] } } };
    const page = await chatsPage(server);
    try {
      const field = page.document.getElementById("archive-q") as HTMLInputElement;
      field.value = "release";
      page.document
        .getElementById("archive-search")
        ?.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();

      // The last empty sentence is the archived list's: the open list and the
      // Test section keep theirs above it.
      const none = [...page.document.querySelectorAll(".report-empty")].at(-1);
      expect(none?.textContent).toBe("No archived chat matches that title.");
      // The hand-written page redrew the field with the term it had submitted.
      // This page binds no value to the field, so the reader's text and the
      // attribute the shell wrote are both left where they were.
      expect(field.value).toBe("release");
      expect(field.getAttribute("value")).toBe("");
    } finally {
      page.close();
    }
  });
});

describe("the chats page's chrome", () => {
  it("takes over the shell's theme button, and cycles the mode on a press", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      const button = page.document.getElementById("theme-toggle");
      expect(button?.textContent).toBe("◐ auto");
      expect(page.document.querySelectorAll("#theme-toggle")).toHaveLength(1);
      expect(page.document.documentElement.dataset.theme).toBe("auto");

      button?.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
      // A signal's reader is drawn again in the microtask after the write.
      await settle();
      expect(page.document.getElementById("theme-toggle")).toBe(button);
      expect(button?.textContent).toBe("◐ light");
      expect(page.document.documentElement.dataset.theme).toBe("light");
      expect(page.window.localStorage.getItem("pi-sec-theme")).toBe("light");
    } finally {
      page.close();
    }
  });

  it("takes over the shell's notice, hidden at rest", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      const notices = page.document.querySelectorAll("#toast");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.getAttribute("class")).toBe("toast hidden");
      expect(notices[0]?.getAttribute("role")).toBe("alert");
      expect(notices[0]?.getAttribute("aria-live")).toBe("assertive");
      expect(notices[0]?.textContent).toBe("");
    } finally {
      page.close();
    }
  });

  it("keeps the shell's link back to the root chat, under the mount the page is served from", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } }, { base: "/sec" });
    try {
      expect(page.document.getElementById("chat-link")?.getAttribute("href")).toBe("/sec/basic-chat");
      // The page's own reads and its stream are built by the same mount rule.
      expect(page.fetchCalls.map((each) => each.path)).toEqual([
        "/sec/api/focused-chats",
        "/sec/api/focused-chats",
      ]);
      expect(page.streams()).toEqual(["/sec/api/focused-chats/events"]);
    } finally {
      page.close();
    }
  });

  it("holds no composer, because the page writes nothing but a new chat and a rename", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      expect(page.document.querySelector("#view textarea")).toBeNull();
      expect(page.document.querySelector("#view [contenteditable]")).toBeNull();
      // The only fields are the archived search's and its submit press.
      expect([...page.document.querySelectorAll("#view input")].map((each) => each.id)).toEqual(["archive-q"]);
      expect([...page.document.querySelectorAll("#view button[id]")].map((each) => each.id)).toEqual([
        "new-chat",
        "reload",
        "test-toggle",
      ]);
    } finally {
      page.close();
    }
  });

  it("says what is missing when the page carried no mount stamp", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="view" class="report-view"></main></body></html>', {
      url: "http://localhost/chats",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("window", dom.window);
    try {
      await import("../../src/ui/pages/chats.tsx");
      const view = dom.window.document.getElementById("view");
      expect(view?.innerHTML).toBe(`<p class="report-empty">${MOUNT_UNKNOWN}</p>`);
      // A page that cannot build a URL asks the server for nothing.
      expect(dom.window.document.querySelector(".report-list")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });
});
