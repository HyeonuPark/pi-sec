/**
 * The two presses that ask the server to change something: opening a chat, and
 * renaming one.
 *
 * No test here writes to a real server. The page's requests are answered by the
 * fixture, which is how the request's shape — no title on a new chat, a trimmed
 * title on a rename — is read. Where a press would have left the page, the
 * bridge says: `window.piSecChats.openChat` is what the page calls last, because
 * jsdom does not navigate.
 */
import { describe, expect, it } from "vitest";
import { chatsPage, click, notice, openChat, rows, type ChatsServer } from "./chats-fixtures.ts";
import { settle, type FakeResponse } from "./harness.ts";

/** Record where the page would have gone, instead of letting jsdom refuse. */
function watchNavigation(page: Awaited<ReturnType<typeof chatsPage>>): string[] {
  const seen: string[] = [];
  const bridge = (page.window as unknown as { piSecChats: { openChat(href: string): void } }).piSecChats;
  bridge.openChat = (href: string) => {
    seen.push(href);
  };
  return seen;
}

/** Answer `window.prompt` with `answer`, as a reader typing a title would. */
function answerPrompt(page: Awaited<ReturnType<typeof chatsPage>>, answer: string | null): string[] {
  const asked: string[] = [];
  page.window.prompt = ((message?: string) => {
    asked.push(String(message));
    return answer;
  }) as typeof page.window.prompt;
  return asked;
}

describe("New chat (2.3-4)", () => {
  it("opens a chat with no title, and goes to it", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } });
    try {
      const went = watchNavigation(page);
      click(page, page.document.getElementById("new-chat") as HTMLElement);
      await settle();

      const posted = page.fetchCalls.filter((each) => each.method === "POST");
      expect(posted).toHaveLength(1);
      expect(posted[0]?.path).toBe("/api/focused-chats");
      // No title: the chat's agent names the chat after it reads the first message.
      expect(posted[0]?.body).toBe("{}");
      // The page leaves for the chat it just opened, through the mount.
      expect(went).toEqual(["/basic-chat?chat=42"]);
      expect((page.window as unknown as { piSecChats: { chatHref(id: number): string } }).piSecChats.chatHref(42)).toBe(
        "/basic-chat?chat=42",
      );
    } finally {
      page.close();
    }
  });

  it("waits with its button disabled, so one press opens one chat", async () => {
    let release: ((answer: FakeResponse) => void) | undefined;
    const server: ChatsServer = {
      active: [],
      archived: { "": { items: [] } },
      post: () =>
        new Promise<FakeResponse>((resolve) => {
          release = resolve;
        }),
    };
    const page = await chatsPage(server);
    try {
      watchNavigation(page);
      const button = page.document.getElementById("new-chat") as HTMLButtonElement;
      click(page, button);
      await settle();
      expect(button.hasAttribute("disabled")).toBe(true);

      release?.({ status: 201, body: { conversationId: 42, name: "focused-42", title: null, openedAt: 0, test: false } });
      await settle();
      expect(button.hasAttribute("disabled")).toBe(false);
    } finally {
      page.close();
    }
  });

  it("says why when the chat could not be opened", async () => {
    const page = await chatsPage({
      active: [],
      archived: { "": { items: [] } },
      post: { status: 500, body: { error: { code: "internal", message: "the store is closed" } } },
    });
    try {
      const went = watchNavigation(page);
      click(page, page.document.getElementById("new-chat") as HTMLElement);
      await settle();

      expect(notice(page)).toBe("Could not open a chat: the store is closed");
      expect(went).toEqual([]);
    } finally {
      page.close();
    }
  });
});

describe("Rename (2.3-5)", () => {
  it("asks for a title, trims it, sends it, and reads the lists again", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      const asked = answerPrompt(page, "  Newer  ");
      click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
      await settle();

      // The question names the rule the server enforces, and starts from the
      // title the row holds.
      expect(asked[0]).toBe("New title (1 to 80 characters)");
      const patched = page.fetchCalls.filter((each) => each.method === "PATCH");
      expect(patched).toHaveLength(1);
      expect(patched[0]?.path).toBe("/api/focused-chats/3");
      expect(patched[0]?.body).toBe(JSON.stringify({ title: "Newer" }));
      // The lists are read again, so the row shows the name the server now holds.
      expect(rows(page)[0]?.querySelector(".chat-row-title")?.textContent).toBe("Newer");
    } finally {
      page.close();
    }
  });

  it("sends nothing when the question is dismissed", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      answerPrompt(page, null);
      click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
      await settle();
      expect(page.fetchCalls.filter((each) => each.method === "PATCH")).toHaveLength(0);
      expect(notice(page)).toBe("");
    } finally {
      page.close();
    }
  });

  it("refuses an empty title and one over 80 characters, and sends neither", async () => {
    for (const [term, message] of [
      ["   ", "A title cannot be empty."],
      ["x".repeat(81), "A title holds at most 80 characters."],
    ] as const) {
      const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
      try {
        answerPrompt(page, term);
        click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
        await settle();
        expect(page.fetchCalls.filter((each) => each.method === "PATCH"), term).toHaveLength(0);
        expect(notice(page)).toBe(message);
      } finally {
        page.close();
      }
    }
  });

  it("takes an 80-character title, which is the longest the server takes", async () => {
    const page = await chatsPage({ active: [openChat(3, "Topic notes")], archived: { "": { items: [] } } });
    try {
      answerPrompt(page, "y".repeat(80));
      click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
      await settle();
      expect(page.fetchCalls.filter((each) => each.method === "PATCH")).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("says a chat that was archived in the meantime can no longer be renamed, and reads both lists", async () => {
    const server: ChatsServer = {
      active: [openChat(3, "Topic notes")],
      archived: { "": { items: [] } },
      patch: { status: 409, body: { error: { code: "chat_archived", message: "this chat is archived" } } },
    };
    const page = await chatsPage(server);
    try {
      answerPrompt(page, "Newer");
      const archivedBefore = page.fetchCalls.filter((each) => each.url.includes("state=archived")).length;
      click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
      await settle();

      expect(notice(page)).toBe("This chat is archived, so its title can no longer change.");
      // The chat left this list, so both lists are read again rather than
      // patched up from the refusal.
      expect(page.fetchCalls.filter((each) => each.url.includes("state=archived")).length).toBe(archivedBefore + 1);
    } finally {
      page.close();
    }
  });

  it("says why when the server refused the title", async () => {
    const page = await chatsPage({
      active: [openChat(3, "Topic notes")],
      archived: { "": { items: [] } },
      patch: { status: 400, body: { error: { code: "invalid_request", message: "a title holds at most 80 characters" } } },
    });
    try {
      answerPrompt(page, "Newer");
      click(page, page.document.querySelector('[data-rename="3"]') as HTMLElement);
      await settle();
      expect(notice(page)).toBe("Could not rename the chat: a title holds at most 80 characters");
    } finally {
      page.close();
    }
  });
});
