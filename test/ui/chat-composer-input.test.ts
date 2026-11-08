/**
 * The composer's field: what a keystroke does, and what survives a reload.
 *
 * The keyboard rules are the hand-written chat page's (removed in this commit),
 * and they are all about one thing: one
 * press is one message, whatever the input method and the keyboard are doing. So
 * a plain `Enter` sends, `Shift+Enter` is a newline, an `Enter` that commits an
 * input-method composition sends nothing (and is not taken from the input method
 * either), and the repeats a held key fires send nothing at all.
 *
 * The draft is the other half: a text typed before a reload comes back, under the
 * conversation it was written in, and only a send the server accepted drops it.
 * Each of these is measured on the field the operator types in, because a draft
 * that comes back to the wrong box is worse than one that is lost.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bodyOf, loadComposerPage, settleTurns, type ComposerPage } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Every message POST the page made. */
function sends(ui: ComposerPage) {
  return ui.fetchCalls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));
}

/** What this page left in the browser, exactly as it is stored. */
function stored(ui: ComposerPage): Record<string, string> {
  const out: Record<string, string> = {};
  const storage = ui.window.localStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) out[key] = storage.getItem(key) ?? "";
  }
  return out;
}

/** The drafts this page left in the browser, by the name the drafts module uses. */
function drafts(ui: ComposerPage): Record<string, string> {
  const out: Record<string, string> = {};
  const storage = ui.window.localStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith("pi-sec:drafts:")) continue;
    const raw = storage.getItem(key) ?? "null";
    const entry = JSON.parse(raw) as { text?: unknown } | null;
    out[key] = typeof entry?.text === "string" ? entry.text : "";
  }
  return out;
}

describe("one Enter, one message", () => {
  it("sends a plain Enter once, with the text and a request id", async () => {
    const ui = await page();
    ui.type("hello there");
    const event = ui.press({});
    await ui.settle();

    expect(event.defaultPrevented).toBe(true);
    expect(sends(ui)).toHaveLength(1);
    expect(bodyOf(sends(ui)[0])).toEqual({ content: "hello there", requestId: expect.stringMatching(/^web:/) });
  });

  it("sends nothing for an Enter that commits an input method composition", async () => {
    const ui = await page();
    ui.type("안녕하세요");

    const composing = ui.press({ isComposing: true } as KeyboardEventInit);
    await ui.settle();
    expect(sends(ui)).toHaveLength(0);
    // The input method keeps its own Enter: the default action is not taken from it.
    expect(composing.defaultPrevented).toBe(false);

    // Safari and older browsers report the composing Enter by key code alone.
    const legacy = ui.press({ keyCode: 229 } as KeyboardEventInit);
    await ui.settle();
    expect(legacy.keyCode).toBe(229);
    expect(sends(ui)).toHaveLength(0);
    expect(legacy.defaultPrevented).toBe(false);

    // The Enter the browser fires after the composition ended sends, once.
    ui.press({});
    await ui.settle();
    expect(sends(ui)).toHaveLength(1);
  });

  it("sends nothing for a repeated Enter from a held key", async () => {
    const ui = await page();
    ui.type("held");
    const repeated = ui.press({ repeat: true });
    await ui.settle();

    expect(sends(ui)).toHaveLength(0);
    // No newline either: the held key is swallowed.
    expect(repeated.defaultPrevented).toBe(true);
    expect(ui.text()).toBe("held");
  });

  it("keeps Shift+Enter as a newline", async () => {
    const ui = await page();
    ui.type("line one");
    const event = ui.press({ shiftKey: true });
    await ui.settle();

    expect(event.defaultPrevented).toBe(false);
    expect(sends(ui)).toHaveLength(0);
  });

  it("takes no message while the activity ring turns", async () => {
    const ui = await page();
    ui.type("not now");
    ui.emit("run_start", {});
    await ui.settle();

    // A press of Send and an `Enter` both end up here, and both send nothing.
    ui.submit();
    ui.press({});
    await ui.settle();
    expect(sends(ui)).toHaveLength(0);
    expect(ui.text()).toBe("not now");
  });
});

describe("the field that grows", () => {
  it("grows with its text, up to 12rem, and scrolls past that", async () => {
    const ui = await page();
    const field = ui.document.getElementById("message") as HTMLTextAreaElement;
    const height = { value: 48 };
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => height.value });

    ui.type("one line");
    await ui.settle();
    expect(field.style.height).toBe("48px");

    height.value = 300;
    ui.type("one line\nand another\nand a third");
    await ui.settle();
    expect(field.style.height).toBe("192px");

    // An emptied field goes back to the height its stylesheet gives it: an inline
    // height left behind would keep a one-row field six lines tall.
    ui.type("");
    await ui.settle();
    expect(field.style.height).toBe("");
  });
});

describe("the unsent text", () => {
  it("comes back after a reload, in the conversation it was written in", async () => {
    const root = await page();
    root.type("a note for the root");
    const afterRoot = stored(root);
    expect(drafts(root)["pi-sec:drafts::composer:root"]).toBe("a note for the root");
    root.close();

    const rootAgain = await page({ storage: afterRoot });
    expect(rootAgain.text()).toBe("a note for the root");
    rootAgain.close();

    // The same browser, another conversation: the root's draft is not there.
    const chat = await page({ chat: 7, storage: afterRoot });
    expect(chat.text()).toBe("");
    chat.type("a note for chat 7");
    const afterChat = stored(chat);
    expect(drafts(chat)["pi-sec:drafts::composer:chat:7"]).toBe("a note for chat 7");
    expect(drafts(chat)["pi-sec:drafts::composer:root"]).toBe("a note for the root");
    chat.close();

    const chatAgain = await page({ chat: 7, storage: afterChat });
    expect(chatAgain.text()).toBe("a note for chat 7");
    chatAgain.close();

    // And the other way round: the chat's draft stays out of the root's box.
    const rootOnceMore = await page({ storage: afterChat });
    expect(rootOnceMore.text()).toBe("a note for the root");
  });

  it("files a draft under the mount the page is served from", async () => {
    const prefixed = await page({ base: "/sec" });
    prefixed.type("behind a prefix");
    const storage = stored(prefixed);
    expect(drafts(prefixed)["pi-sec:drafts:/sec:composer:root"]).toBe("behind a prefix");
    prefixed.close();

    // An install at the root reads nothing of it.
    const plain = await page({ storage });
    expect(plain.text()).toBe("");
  });

  it("keeps nothing for whitespace, and removes what was there", async () => {
    const ui = await page();
    ui.type("text");
    ui.type("   \n\t ");
    await ui.settle();
    expect(drafts(ui)).toEqual({});
  });

  it("drops the draft when the server accepted the send", async () => {
    const ui = await page();
    ui.type("send me");
    ui.submit();
    await ui.settle();

    expect(ui.text()).toBe("");
    expect(drafts(ui)).toEqual({});
  });

  it("keeps the draft when the send failed", async () => {
    const ui = await page({
      fetch: { "/basic-chat/messages": { status: 500, body: { error: { code: "failed", message: "the store is unavailable" } } } },
    });
    ui.type("send me");
    ui.submit();
    await ui.settle();

    expect(sends(ui)).toHaveLength(1);
    expect(ui.text()).toBe("send me");
    expect(drafts(ui)["pi-sec:drafts::composer:root"]).toBe("send me");
    // And the reason is on the page, with the server's own sentence.
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("the store is unavailable");
  });

  it("says once that the browser refused the text, and keeps typing", async () => {
    const ui = await page({ refuseWrites: true });
    ui.type("one");
    await ui.settle();
    const toast = ui.document.getElementById("toast") as HTMLElement;
    expect(toast.classList.contains("hidden")).toBe(false);
    const spoken = toast.textContent;

    ui.type("one two");
    ui.type("one two three");
    await ui.settle();

    // One notice for the whole page load, and the field is the operator's.
    expect(toast.textContent).toBe(spoken);
    expect(spoken).toContain("Could not save this text");
    expect(ui.text()).toBe("one two three");
    expect(drafts(ui)).toEqual({});
  });

  it("puts the draft back on the first paint, before anything is read", async () => {
    const ui = await page({
      storage: {
        "pi-sec:drafts::composer:root": JSON.stringify({ text: "half a message", at: Date.now() }),
      },
    });
    expect(ui.text()).toBe("half a message");
    // A restored draft is not a keystroke: nothing was read and nothing was sent.
    expect(sends(ui)).toHaveLength(0);
  });

  it("drops a draft nobody came back for, and keeps a newer one", async () => {
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const ui = await page({
      storage: {
        "pi-sec:drafts::composer:root": JSON.stringify({ text: "stale", at: old }),
        "pi-sec:drafts::composer:chat:3": JSON.stringify({ text: "fresh", at: Date.now() }),
      },
    });
    await settleTurns(2);
    expect(ui.text()).toBe("");
    const left = drafts(ui);
    expect(left["pi-sec:drafts::composer:root"]).toBeUndefined();
    expect(left["pi-sec:drafts::composer:chat:3"]).toBe("fresh");
  });
});
