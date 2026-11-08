/**
 * Send and Stop: one send at a time, one request id per draft, and a Stop that
 * only exists while there is something to stop.
 *
 * The request id is the part that is easy to get wrong and expensive when it is:
 * a send that failed and is tried again must carry the id it carried the first
 * time, or the server admits the same message twice. So the id is measured on the
 * wire, not read off the page.
 *
 * Nothing here reaches a server: every request is answered by the fake `fetch`,
 * and the ones that have to stay in flight are held open on purpose.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bodyOf, fileOf, loadComposerPage, type ComposerPage, type FakeAnswer } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Calls by route, whichever method. */
function calls(ui: ComposerPage, suffix: string) {
  return ui.fetchCalls.filter((call) => call.path.endsWith(suffix));
}

/** A message route that answers only when the test lets it. */
function gated() {
  const pending: ((answer: FakeAnswer) => void)[] = [];
  return {
    answer: () => new Promise<FakeAnswer>((resolve) => pending.push(resolve)),
    release: (status = 202, body: unknown = { status: "accepted" }) => pending.shift()?.({ status, body }),
    waiting: () => pending.length,
  };
}

/** The `requestId` one message POST carried. */
function requestIdOf(call: Parameters<typeof bodyOf>[0]): unknown {
  return bodyOf(call)["requestId"];
}

describe("one send at a time", () => {
  it("sends the draft once while its send is in flight, and holds the Send button", async () => {
    const gate = gated();
    const ui = await page({ fetch: { "/basic-chat/messages": gate.answer } });
    const send = ui.document.getElementById("send") as HTMLButtonElement;
    ui.type("only once");

    ui.submit();
    await ui.settle();
    // The first POST is in flight and has not been answered: this is the window in
    // which one press went out three times.
    expect(gate.waiting()).toBe(1);
    expect(send.disabled).toBe(true);

    ui.submit();
    ui.submit();
    await ui.settle();
    expect(calls(ui, "/messages")).toHaveLength(1);

    gate.release();
    await ui.settle();
    expect(send.disabled).toBe(false);
    expect(ui.text()).toBe("");
    expect(calls(ui, "/messages")).toHaveLength(1);
  });

  it("carries the same request id when a failed draft is sent again", async () => {
    const gate = gated();
    const ui = await page({ fetch: { "/basic-chat/messages": gate.answer } });
    ui.type("try twice");

    ui.submit();
    await ui.settle();
    gate.release(502, { error: { code: "bad_gateway", message: "upstream" } });
    await ui.settle();
    // The draft stays for the retry, and the button is free again.
    expect(ui.text()).toBe("try twice");
    expect((ui.document.getElementById("send") as HTMLButtonElement).disabled).toBe(false);

    ui.submit();
    await ui.settle();
    gate.release();
    await ui.settle();

    const [first, second] = calls(ui, "/messages");
    expect(calls(ui, "/messages")).toHaveLength(2);
    expect(requestIdOf(first)).toMatch(/^web:/);
    expect(requestIdOf(second)).toBe(requestIdOf(first));
  });

  it("gives a changed draft and the next draft new request ids", async () => {
    const gate = gated();
    const ui = await page({ fetch: { "/basic-chat/messages": gate.answer } });

    ui.type("first wording");
    ui.submit();
    await ui.settle();
    gate.release(502, { error: { code: "bad_gateway", message: "upstream" } });
    await ui.settle();

    // The operator edits the draft after the failure: it is a new draft.
    ui.type("second wording");
    ui.submit();
    await ui.settle();
    gate.release();
    await ui.settle();

    // The same words again, after a send that went through, are a new message.
    ui.type("second wording");
    ui.submit();
    await ui.settle();
    gate.release();
    await ui.settle();

    const ids = calls(ui, "/messages").map((call) => requestIdOf(call));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("sends nothing for an empty draft, or one that is only whitespace", async () => {
    const ui = await page();
    ui.submit();
    await ui.settle();
    expect(calls(ui, "/messages")).toHaveLength(0);

    ui.type("   \n  ");
    ui.press({});
    await ui.settle();
    expect(calls(ui, "/messages")).toHaveLength(0);
  });

  it("trims the draft it sends, and sends the text alone when nothing is attached", async () => {
    const ui = await page();
    ui.type("  a padded message  ");
    ui.submit();
    await ui.settle();

    expect(bodyOf(calls(ui, "/messages")[0])).toEqual({
      content: "a padded message",
      requestId: expect.stringMatching(/^web:/),
    });
  });

  it("refuses a send while a file is still uploading, and says why", async () => {
    const upload = gated();
    const ui = await page({ bitmap: { width: 800, height: 600 }, fetch: { "/api/attachments": upload.answer } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png")]);

    // No wait: the upload is in flight, and it must not be dropped silently.
    ui.type("photo attached");
    ui.submit();
    await ui.settle();
    expect(calls(ui, "/messages")).toHaveLength(0);
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("still uploading");

    upload.release(201, { id: "att-1", name: "photo.png", mime: "image/png", bytes: 3 });
    await ui.settle();
    ui.submit();
    await ui.settle();
    expect(bodyOf(calls(ui, "/messages")[0])).toEqual({
      content: "photo attached",
      attachmentIds: ["att-1"],
      requestId: expect.stringMatching(/^web:/),
    });
  });
});

describe("a message the provider's usage limit holds", () => {
  it("says on the page that the text waits for the provider, and keeps what was typed out of the field", async () => {
    // The server stored the text instead of starting a run, which is the answer the
    // hold gives a send. The page has to say so: nothing on screen would otherwise
    // tell the operator that the silence is a wait and not an answer on its way.
    const ui = await page({
      fetch: { "/basic-chat/messages": { status: 202, body: { status: "accepted", held: true } } },
    });
    ui.type("are you still there?");
    ui.submit();
    await ui.settle();

    const toast = ui.document.getElementById("toast") as HTMLElement;
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(toast.classList.contains("toast-info")).toBe(true);
    expect(toast.textContent).toContain("paused because the provider's usage limit was reached");
    expect(toast.textContent).toContain("will be sent when the provider recovers");
    // The field is empty because the server took the text, not because the send
    // failed: the notice says where the text is, and the send button is back.
    expect(ui.text()).toBe("");
    expect((ui.document.getElementById("send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing about a hold when the send was an ordinary one", async () => {
    const ui = await page({ fetch: { "/basic-chat/messages": { status: 202, body: { status: "accepted" } } } });
    ui.type("hello");
    ui.submit();
    await ui.settle();

    expect((ui.document.getElementById("toast") as HTMLElement).classList.contains("hidden")).toBe(true);
    expect(ui.text()).toBe("");
  });
});

describe("Stop", () => {
  it("is inert until a run is active, and posts to the conversation's abort route", async () => {
    const ui = await page();
    const stop = ui.document.getElementById("abort") as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    stop.click();
    await ui.settle();
    expect(calls(ui, "/abort")).toHaveLength(0);

    ui.emit("run_start", {});
    await ui.settle();
    expect(stop.disabled).toBe(false);

    stop.click();
    await ui.settle();
    expect(calls(ui, "/abort")).toHaveLength(1);
    expect(calls(ui, "/abort")[0]?.method).toBe("POST");
    expect(calls(ui, "/abort")[0]?.body).toBeUndefined();

    ui.emit("run_end", {});
    await ui.settle();
    expect(stop.disabled).toBe(true);
  });

  it("stops a focused chat on its own route, never the root's", async () => {
    const ui = await page({
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Topic", archived: false } } },
    });
    ui.emit("run_start", {});
    await ui.settle();
    (ui.document.getElementById("abort") as HTMLButtonElement).click();
    await ui.settle();

    expect(calls(ui, "/abort")[0]?.path).toBe("/api/conversations/7/abort");
  });
});
