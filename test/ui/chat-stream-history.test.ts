/**
 * The `Load previous session` button, on the conversation branch's own page.
 *
 * The button is a row of the transcript and not a part of the shell: it is drawn
 * by the drawing plan's list, above the first entry, and it is drawn only while
 * the server says something is stored before the context the page holds. A press
 * reads one session and puts it above the rows; what the model sees and what the
 * store holds are the same afterwards, so the page's only trace of a press is what
 * it draws.
 *
 * Every claim about the wire is made here against `chat-stream-harness.ts`, which
 * answers an unlisted path with `200 {}` — the shape a route the harness does not
 * know returns, and the shape this page has to survive.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assistant, loadStreamPage, operatorMessage, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadStreamPage>[0] = {}): Promise<StreamPage> {
  open = await loadStreamPage(options);
  return open;
}

/** Let the signals settle: a signal notifies its readers in a microtask. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Every row the transcript drew, in order, by `data-row-key`. */
function keys(ui: StreamPage): string[] {
  return [...ui.document.querySelectorAll("#transcript > [data-row-key]")].map(
    (row) => row.getAttribute("data-row-key") ?? "",
  );
}

/** The button, when the page drew one. */
function button(ui: StreamPage): HTMLButtonElement | null {
  return ui.document.querySelector<HTMLButtonElement>(".load-earlier-button");
}

/** Press the button the way an operator does. */
function press(ui: StreamPage): void {
  const element = button(ui);
  if (element === null) throw new Error("the page drew no button");
  element.dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** The one session restart entry, as the server writes it. */
function restart(id: number): Record<string, unknown> {
  return { id, kind: "pi.reset", head: "self", model: [] };
}

/** One earlier session's answer, as the route writes it. */
function historyAnswer(entries: readonly Record<string, unknown>[], hasMore: boolean): Record<string, unknown> {
  return { entries, attachments: {}, hasMore, apiVersion: 1 };
}

/** Every request the page made to the history route, in order. */
function historyCalls(ui: StreamPage): string[] {
  return ui.fetchCalls.filter((call) => call.path === "/basic-chat/history").map((call) => call.url);
}

/** The snapshot a page opens on: two entries of the active context. */
function snapshotLines(): Record<string, unknown> {
  return {
    entries: [restart(100), operatorMessage(101, "the newest session")],
    hasEarlier: true,
  };
}

describe("the Load previous session button", () => {
  it("is drawn when the snapshot says something is stored before the context", async () => {
    const ui = await page();
    ui.emit("snapshot", snapshotLines());
    await flush();
    expect(button(ui)).not.toBeNull();
    expect(button(ui)?.textContent).toBe("Load previous session");
    // It sits above the first entry, which is the `new session` line of the session
    // on screen.
    expect(keys(ui)).toEqual(["load-earlier", "divider:100", "entry:101", "writing"]);
  });

  it("is not drawn when the snapshot says there is nothing before it, or does not say", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [restart(100), operatorMessage(101, "only this")], hasEarlier: false });
    await flush();
    expect(button(ui)).toBeNull();
    expect(keys(ui)).toEqual(["divider:100", "entry:101", "writing"]);

    // An older server that does not send the field draws the page it always drew.
    ui.emit("snapshot", { entries: [restart(102), operatorMessage(103, "no field at all")] });
    await flush();
    expect(button(ui)).toBeNull();
    expect(keys(ui)).toEqual(["divider:102", "entry:103", "writing"]);
  });

  it("asks for the smallest entry id the page holds, and puts the session above the rows", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], true),
    });

    press(ui);
    await flush();
    await flush();

    // One request, naming the smallest id on screen.
    expect(historyCalls(ui)).toHaveLength(1);
    expect(historyCalls(ui)[0]).toBe("/basic-chat/history?before=100");

    // The loaded session is above the rows that were already there, with its own
    // `new session` divider, and the button stayed because more is stored.
    expect(keys(ui)).toEqual([
      "load-earlier",
      "divider:90",
      "entry:91",
      "divider:100",
      "entry:101",
      "writing",
    ]);
    expect(button(ui)).not.toBeNull();
  });

  it("asks again from the newly loaded session, and takes the button away at the end", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], true),
    });
    press(ui);
    await flush();
    await flush();

    ui.respond("/basic-chat/history", {
      body: historyAnswer([operatorMessage(80, "the first session")], false),
    });
    press(ui);
    await flush();
    await flush();

    expect(historyCalls(ui)).toEqual(["/basic-chat/history?before=100", "/basic-chat/history?before=90"]);
    // The second press reached the conversation's first entry, so `hasMore` is false
    // and the button is gone.
    expect(keys(ui)).toEqual([
      "entry:80",
      "divider:90",
      "entry:91",
      "divider:100",
      "entry:101",
      "writing",
    ]);
    expect(button(ui)).toBeNull();
  });

  it("keeps the rows, the button and one notice when the read fails", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", { status: 500, body: { error: { code: "boom", message: "the store is on fire" } } });

    press(ui);
    await flush();
    await flush();

    // Everything drawn before the press is still drawn, and the button is still
    // there to try again.
    expect(keys(ui)).toEqual(["load-earlier", "divider:100", "entry:101", "writing"]);
    expect(button(ui)).not.toBeNull();
    expect(ui.toast.toast.value.visible).toBe(true);
    expect(ui.toast.toast.value.text).toBe("the store is on fire");
    // One press, one read: a second press on a button that is still there reads
    // again, so the count says the failure was not retried silently.
    expect(historyCalls(ui)).toHaveLength(1);
  });

  it("treats an answer that is not this route's shape as nothing new, and keeps the button", async () => {
    // The harness answers an unlisted path with `200 {}`: no entries, no hasMore.
    // The page must not stop on it and must not take its own button away.
    const ui = await page();
    ui.emit("snapshot", snapshotLines());
    await flush();
    press(ui);
    await flush();
    await flush();

    expect(historyCalls(ui)).toHaveLength(1);
    expect(keys(ui)).toEqual(["load-earlier", "divider:100", "entry:101", "writing"]);
    expect(button(ui)).not.toBeNull();
    expect(ui.toast.toast.value.visible).toBe(false);
  });

  it("marks the rows a press brought as not to be announced, and leaves the others alone", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session"), assistant(92, "an older answer")], true),
    });
    press(ui);
    await flush();
    await flush();

    for (const key of ["divider:90", "entry:91", "entry:92"]) {
      expect(ui.document.querySelector(`[data-row-key="${key}"]`)?.getAttribute("aria-live"), key).toBe("off");
    }
    // The rows of the context on screen are announced as they always were.
    for (const key of ["divider:100", "entry:101"]) {
      expect(ui.document.querySelector(`[data-row-key="${key}"]`)?.getAttribute("aria-live"), key).toBeNull();
    }
    // The button explains what a press does, because the label alone does not say
    // that the transcript is about to grow above the reader.
    expect(button(ui)?.getAttribute("aria-description")).toContain("before this session");
  });

  it("reads once while a read is in flight, and refuses the second press", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    let released: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      released = resolve;
    });
    ui.respond("/basic-chat/history", async () => {
      await held;
      return { body: historyAnswer([restart(90), operatorMessage(91, "an older session")], true) };
    });

    press(ui);
    await flush();
    // The button is disabled while the read is under way, so the second press does
    // nothing at all.
    expect(button(ui)?.disabled).toBe(true);
    press(ui);
    await flush();
    expect(historyCalls(ui)).toHaveLength(1);

    released?.();
    await flush();
    await flush();
    expect(button(ui)?.disabled).toBe(false);
    expect(keys(ui)).toEqual([
      "load-earlier",
      "divider:90",
      "entry:91",
      "divider:100",
      "entry:101",
      "writing",
    ]);
  });

  it("takes the loaded session away when the server draws the conversation again", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], true),
    });
    press(ui);
    await flush();
    await flush();
    expect(keys(ui)).toContain("entry:91");

    // A snapshot that starts at an entry the page never held, for example after a
    // restart while the connection was down, draws the active context alone. What
    // the press brought is a view and not storage, so it goes with it.
    ui.emit("snapshot", { entries: [restart(200), operatorMessage(201, "a session after a restart")], hasEarlier: true });
    await flush();
    expect(keys(ui)).toEqual(["load-earlier", "divider:200", "entry:201", "writing"]);
    expect(button(ui)).not.toBeNull();
  });

  it("keeps the button state, and asks before the oldest row, after a restart that kept the rows", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    // The live reset, then the snapshot of the new stream, which says nothing is
    // stored before it because its context starts at the reset.
    ui.emit("entry_appended", { entry: restart(110) });
    await flush();
    ui.emit("snapshot", { entries: [restart(110), operatorMessage(111, "after the restart")], hasEarlier: false });
    await flush();
    expect(keys(ui)).toEqual(["load-earlier", "divider:100", "entry:101", "divider:110", "entry:111", "writing"]);
    expect(button(ui)).not.toBeNull();

    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], false),
    });
    press(ui);
    await flush();
    await flush();
    expect(historyCalls(ui)).toEqual(["/basic-chat/history?before=100"]);
    expect(keys(ui)).toEqual([
      "divider:90",
      "entry:91",
      "divider:100",
      "entry:101",
      "divider:110",
      "entry:111",
      "writing",
    ]);
    expect(button(ui)).toBeNull();
  });

  it("keeps no button when the page had none and the restart kept its rows", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [restart(100), operatorMessage(101, "only session")], hasEarlier: false });
    await flush();
    ui.emit("entry_appended", { entry: restart(110) });
    await flush();
    ui.emit("snapshot", { entries: [restart(110), operatorMessage(111, "next")], hasEarlier: true });
    await flush();
    expect(keys(ui)).toEqual(["divider:100", "entry:101", "divider:110", "entry:111", "writing"]);
    expect(button(ui)).toBeNull();
  });

  it("keeps a restart's rows in a focused chat, and asks that chat's route", async () => {
    const ui = await page({
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "A chat", archived: false } } },
    });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.emit("entry_appended", { entry: restart(110) });
    await flush();
    ui.emit("snapshot", { entries: [restart(110), operatorMessage(111, "after")], hasEarlier: false });
    await flush();
    expect(keys(ui)).toEqual(["load-earlier", "divider:100", "entry:101", "divider:110", "entry:111", "writing"]);

    ui.respond("/api/conversations/7/history", { body: historyAnswer([operatorMessage(91, "older")], false) });
    press(ui);
    await flush();
    await flush();
    expect(ui.fetchCalls.filter((call) => call.path === "/api/conversations/7/history").map((call) => call.url)).toEqual([
      "/api/conversations/7/history?before=100",
    ]);
  });

  it("keeps the session a press brought when the same session is drawn again", async () => {
    const ui = await page({ fetch: {} });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/basic-chat/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], true),
    });
    press(ui);
    await flush();
    await flush();

    // A reconnect: the same snapshot again, which holds the head the page holds.
    ui.emit("snapshot", snapshotLines());
    await flush();
    expect(keys(ui)).toEqual(["load-earlier", "divider:90", "entry:91", "divider:100", "entry:101", "writing"]);
    expect(button(ui)).not.toBeNull();
  });

  it("reads the focused chat's own route when the page shows a chat", async () => {
    const ui = await page({
      chat: 7,
      fetch: {
        "/api/focused-chats/7": { body: { conversationId: 7, title: "A chat", archived: false } },
      },
    });
    ui.emit("snapshot", snapshotLines());
    await flush();
    ui.respond("/api/conversations/7/history", {
      body: historyAnswer([restart(90), operatorMessage(91, "an older session")], false),
    });
    press(ui);
    await flush();
    await flush();

    expect(ui.fetchCalls.filter((call) => call.path === "/api/conversations/7/history")).toHaveLength(1);
    expect(keys(ui)).toEqual(["divider:90", "entry:91", "divider:100", "entry:101", "writing"]);
    expect(button(ui)).toBeNull();
  });

  it("is drawn with the first paint of a long transcript, which draws its last rows only", async () => {
    // The first paint of a long conversation draws its last 40 entries and the rest
    // when the browser is idle. The button must be there from that paint: it is a
    // row of the list, and a row added afterwards would move what is on screen.
    const ui = await page();
    const entries: Record<string, unknown>[] = [restart(1)];
    for (let index = 0; index < 60; index += 1) entries.push(operatorMessage(2 + index, `line ${index + 1}`));
    ui.emit("snapshot", { entries, hasEarlier: true });
    await flush();
    expect(keys(ui)[0]).toBe("load-earlier");
    expect(button(ui)).not.toBeNull();
    // The paint really is partial, which is what makes the claim worth making.
    expect(keys(ui).length).toBeLessThan(entries.length + 2);
  });

  it("draws no button while nothing has been drawn at all", async () => {
    // A page that has heard no snapshot shows the shell's empty transcript, and a
    // button there would sit above nothing.
    const ui = await page();
    expect(ui.transcript.transcriptRows.value).toEqual([]);
    expect(button(ui)).toBeNull();
  });
});
