/**
 * A press on Send while the agent is busy queues the message, and the page sends
 * it once when it is idle.
 *
 * Busy means a run is active on a connected page. Offline, no model and a send on
 * its way keep the button disabled and queue nothing. Every request is answered by
 * the fake `fetch`, so the sends are counted on the wire.
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

/** A page with a run in progress. */
async function busyPage(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  const ui = await page(options);
  ui.emit("run_start", {});
  await ui.settle();
  return ui;
}

const send = (ui: ComposerPage) => ui.document.getElementById("send") as HTMLButtonElement;
const field = (ui: ComposerPage) => ui.document.getElementById("message") as HTMLTextAreaElement;
const queued = (ui: ComposerPage) => field(ui).classList.contains("send-queued");
const posts = (ui: ComposerPage, suffix = "/messages") =>
  ui.fetchCalls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

async function press(ui: ComposerPage): Promise<void> {
  send(ui).click();
  await ui.settle();
}

function gated() {
  const pending: ((answer: FakeAnswer) => void)[] = [];
  return {
    answer: () => new Promise<FakeAnswer>((resolve) => pending.push(resolve)),
    release: (status = 202, body: unknown = { status: "accepted" }) => pending.shift()?.({ status, body }),
  };
}

describe("the busy Send button", () => {
  it("is not disabled, carries send-busy and no aria-disabled while a run is active", async () => {
    const ui = await busyPage();
    expect(send(ui).disabled).toBe(false);
    expect(send(ui).classList.contains("send-busy")).toBe(true);
    expect(send(ui).hasAttribute("aria-disabled")).toBe(false);
  });

  it("carries the busy title while a run is active, and none at rest", async () => {
    const ui = await busyPage();
    expect(send(ui).title).toBe("The agent is busy. Press to send when it is idle.");
    ui.emit("run_end", {});
    await ui.settle();
    expect(send(ui).title).toBe("");
  });

  it("stays disabled with no busy class when offline, with no model, or while a send is on its way", async () => {
    const offline = await page();
    offline.emit("run_start", {});
    offline.currentStream().fail({ closed: false });
    await offline.settle();
    expect(send(offline).disabled).toBe(true);
    expect(send(offline).classList.contains("send-busy")).toBe(false);

    const setup = await page();
    setup.run.modelSetupRequired.value = true;
    await setup.settle();
    expect(send(setup).disabled).toBe(true);
    expect(send(setup).classList.contains("send-busy")).toBe(false);

    const gate = gated();
    const sending = await page({ fetch: { "/basic-chat/messages": gate.answer } });
    sending.type("in flight");
    sending.submit();
    await sending.settle();
    expect(send(sending).disabled).toBe(true);
    expect(send(sending).classList.contains("send-busy")).toBe(false);
    gate.release();
    await sending.settle();
  });
});

describe("queueing", () => {
  it("sends nothing on Enter while busy", async () => {
    const ui = await busyPage();
    ui.type("hello");
    ui.press({});
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
    expect(queued(ui)).toBe(false);
  });

  it("queues on a press, ignores a second press, and sends once when the run ends", async () => {
    const ui = await busyPage();
    ui.type("queued words");
    await press(ui);
    expect(posts(ui)).toHaveLength(0);
    expect(queued(ui)).toBe(true);

    await press(ui);
    expect(posts(ui)).toHaveLength(0);

    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(1);
    expect(bodyOf(posts(ui)[0])).toEqual({ content: "queued words", requestId: expect.stringMatching(/^web:/) });
    expect(ui.text()).toBe("");
    expect(queued(ui)).toBe(false);
  });

  it("does not queue an empty field", async () => {
    const ui = await busyPage();
    await press(ui);
    expect(queued(ui)).toBe(false);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
  });

  it("refuses to queue while a file uploads, and shows the upload toast", async () => {
    const upload = gated();
    const ui = await busyPage({ bitmap: { width: 800, height: 600 }, fetch: { "/api/attachments": upload.answer } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png")]);
    ui.type("with a file");
    await press(ui);
    expect(queued(ui)).toBe(false);
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("still uploading");
    upload.release(201, { id: "att-1", name: "photo.png", mime: "image/png", bytes: 3 });
    await ui.settle();
  });

  it("gives the field a status text while queued, and removes it after", async () => {
    const ui = await busyPage();
    expect(ui.document.getElementById("send-queued-status")).toBeNull();
    expect(field(ui).hasAttribute("aria-describedby")).toBe(false);
    ui.type("hello");
    await press(ui);
    const status = ui.document.getElementById("send-queued-status") as HTMLElement;
    expect(status.classList.contains("sr-only")).toBe(true);    expect(field(ui).getAttribute("aria-describedby")).toBe("send-queued-status");
    expect(status.textContent).toBe("Queued. Sends when the agent is idle.");
    ui.emit("run_end", {});
    await ui.settle();
    expect(field(ui).hasAttribute("aria-describedby")).toBe(false);
    expect(ui.document.getElementById("send-queued-status")).toBeNull();
  });
});

describe("cancelling", () => {
  it("cancels on an input event, even one that leaves the same text", async () => {
    const ui = await busyPage();
    ui.type("same");
    await press(ui);
    ui.type("same");
    await ui.settle();
    expect(queued(ui)).toBe(false);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
    expect(ui.text()).toBe("same");
  });

  it("cancels when a chip is removed or a file is added", async () => {
    const ui = await busyPage({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "one.png", "image/png")]);
    await ui.settle();
    await press(ui);
    expect(queued(ui)).toBe(true);
    (ui.document.querySelector("button.attachment-remove") as HTMLButtonElement).click();
    await ui.settle();
    expect(queued(ui)).toBe(false);

    ui.type("again");
    await press(ui);
    expect(queued(ui)).toBe(true);
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "two.png", "image/png")]);
    await ui.settle();
    expect(queued(ui)).toBe(false);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
  });

  it("drops the queue on pagehide", async () => {
    const ui = await busyPage();
    ui.type("gone");
    await press(ui);
    ui.window.dispatchEvent(new ui.window.Event("pagehide"));
    await ui.settle();
    expect(queued(ui)).toBe(false);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
  });
});

describe("the automatic send", () => {
  it("waits through a reconnect for the snapshot, and sends only when it holds no run", async () => {
    const ui = await busyPage();
    ui.type("after reconnect");
    await press(ui);
    ui.currentStream().fail({ closed: false });
    await ui.settle();
    ui.currentStream().open();
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);

    ui.emit("snapshot", { entries: [], run: { startedAt: 1 }, tools: [] });
    await ui.settle();
    expect(posts(ui)).toHaveLength(0);
    expect(queued(ui)).toBe(true);

    ui.emit("snapshot", { entries: [], run: null, tools: [] });
    await ui.settle();
    expect(posts(ui)).toHaveLength(1);
  });

  it("sends to the focused chat's own route", async () => {
    const ui = await busyPage({ chat: 7 });
    ui.type("to the focused chat");
    await press(ui);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(1);
    expect(posts(ui)[0]?.path).toBe("/api/conversations/7/messages");
  });

  it("on a failed send shows the toast, keeps the text, drops the queue and keeps the request id", async () => {
    const gate = gated();
    const ui = await busyPage({ fetch: { "/basic-chat/messages": gate.answer } });
    ui.type("will fail");
    await press(ui);
    ui.emit("run_end", {});
    await ui.settle();
    gate.release(502, { error: { code: "bad_gateway", message: "upstream" } });
    await ui.settle();
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("Send failed");
    expect(ui.text()).toBe("will fail");
    expect(queued(ui)).toBe(false);

    ui.submit();
    await ui.settle();
    gate.release();
    await ui.settle();
    const [first, second] = posts(ui);
    expect(bodyOf(second as NonNullable<typeof second>)["requestId"]).toBe(bodyOf(first as NonNullable<typeof first>)["requestId"]);
  });

  it("keeps the queue when Stop is pressed, and sends when the run ends", async () => {
    const ui = await busyPage();
    ui.type("after stop");
    await press(ui);
    (ui.document.getElementById("abort") as HTMLButtonElement).click();
    await ui.settle();
    expect(posts(ui, "/abort")).toHaveLength(1);
    expect(queued(ui)).toBe(true);
    expect(posts(ui)).toHaveLength(0);
    ui.emit("run_end", {});
    await ui.settle();
    expect(posts(ui)).toHaveLength(1);
  });
});
