/**
 * The places where a server update could have taken something the operator did.
 *
 * The first requirement of the rewrite is that an update redraws the values that
 * changed and nothing else. The composer is the worst place to get that wrong:
 * the field holds a half-written message, a caret, a focus and a menu, and every
 * one of them was thrown away by a region written wholesale. So each of these
 * tests builds that state, causes the server update that would have reset it, and
 * compares the element against what it was: the same node, the same value, the
 * same caret, the same focus, the same scroll.
 *
 * The chips are the second place: an upload that finishes on one chip must not
 * rebuild the tray, because the operator may be one press away from removing
 * another file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fileOf, loadComposerPage, operatorMessage, type ComposerPage } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Type into the field, put the caret in the middle of it, and leave it focused. */
async function typeIntoTheField(ui: ComposerPage, text = "a half-written message") {
  ui.type(text);
  const field = ui.document.getElementById("message") as HTMLTextAreaElement;
  field.focus();
  field.setSelectionRange(7, 7);
  field.scrollTop = 12;
  await ui.settle();
  return field;
}

describe("the field", () => {
  it("keeps the text, the caret and the focus across a live entry", async () => {
    const ui = await page();
    await typeIntoTheField(ui);
    const before = ui.capture("#message");
    expect(before.focused).toBe(true);

    ui.emit("entry_appended", { entry: operatorMessage(2, "something else") });
    ui.emit("message_end", { entry: { id: 3, kind: "pi.assistant", model: [{ role: "assistant", content: "an answer" }] } });
    await ui.settle();

    ui.expectUntouched(before);
  });

  it("keeps them across the whole state a reconnect brings", async () => {
    const ui = await page();
    await typeIntoTheField(ui);
    const before = ui.capture("#message");

    // A second snapshot is what a reconnected stream opens with: the transcript is
    // drawn again from it, and the field is not part of it.
    ui.emit("snapshot", { entries: [operatorMessage(1, "earlier"), { id: 2, kind: "pi.assistant", model: [] }], run: null });
    await ui.settle();

    ui.expectUntouched(before);
  });

  it("keeps them while the ring turns and stops", async () => {
    const ui = await page();
    await typeIntoTheField(ui);
    const before = ui.capture("#message");

    ui.emit("run_start", {});
    await ui.settle();
    ui.emit("run_end", {});
    await ui.settle();

    ui.expectUntouched(before);
  });

  it("keeps them while the context bar reads again", async () => {
    const ui = await page({ fetch: { "/basic-chat/context": { body: { used: 100, max: 1000 } } } });
    await typeIntoTheField(ui);
    const before = ui.capture("#message");

    ui.respond("/basic-chat/context", { body: { used: 900, max: 1000 } });
    ui.emit("message_end", { entry: { id: 4, kind: "pi.assistant", model: [] } });
    await ui.settle();

    ui.expectUntouched(before);
    // And the bar it was read for did move, so the comparison above is not vacuous.
    expect((ui.document.getElementById("context-fill") as HTMLElement).style.width).toBe("90%");
  });

  it("keeps a draft the operator restored while the stream draws the transcript", async () => {
    const ui = await page({ storage: { "pi-sec:drafts::composer:root": JSON.stringify({ text: "restored", at: Date.now() }) } });
    const before = ui.capture("#message");
    expect(before.value).toBe("restored");

    ui.emit("snapshot", { entries: [operatorMessage(1, "hello")], run: null });
    await ui.settle();

    ui.expectUntouched(before);
  });
});

describe("the chips", () => {
  /**
   * Two chips: the first is refused, so it carries a Retry; the second is still
   * uploading, and the test releases it when it wants the change.
   */
  async function twoChips(ui: ComposerPage): Promise<() => void> {
    let held: ((answer: unknown) => void) | undefined;
    ui.respond("/api/attachments", (request) => {
      if (request.method === "POST" && new URL(request.url, "http://localhost").searchParams.get("name") === "second.png") {
        return new Promise((resolve) => {
          held = resolve;
        });
      }
      return { status: 413, body: { error: { code: "payload_too_large", message: "payload too large" } } };
    });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "first.png", "image/png", 900)]);
    await ui.settle();
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "second.png", "image/png", 1200)]);
    await ui.settle();
    return () => held?.({ status: 201, body: { id: "att-late", name: "second.png", mime: "image/png", bytes: 1200 } });
  }

  it("keeps a chip, and the focus on its Retry, while another chip finishes", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    const release = await twoChips(ui);

    const retry = ui.document.querySelector('#attachment-tray [data-retry="att-1"]') as HTMLElement;
    expect(retry).not.toBeNull();
    retry.focus();
    await ui.settle();
    const before = ui.capture('#attachment-tray [data-retry="att-1"]');
    expect(before.focused).toBe(true);

    // The second chip's upload lands: one chip changes from uploading to ready,
    // and the other chip keeps its element, its Retry and the focus on it.
    release();
    await ui.settle();

    ui.expectUntouched(before);
    expect(ui.document.querySelectorAll("#attachment-tray .attachment-chip")).toHaveLength(2);
    expect(ui.document.querySelector("#attachment-tray .attachment-chip.is-ready")).not.toBeNull();
  });

  it("keeps a chip when another one is added, and when one is removed", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "keeper.png", "image/png", 900)]);
    await ui.settle();
    const chip = ui.document.querySelector('#attachment-tray [data-remove="att-1"]') as HTMLElement;
    chip.focus();
    await ui.settle();
    const before = ui.capture('#attachment-tray [data-remove="att-1"]');

    ui.attachments.addAttachmentFiles([fileOf(ui.window, "added.png", "image/png", 1200)]);
    await ui.settle();
    ui.attachments.removeAttachment("att-2");
    await ui.settle();

    ui.expectUntouched(before);
    expect(ui.document.querySelectorAll("#attachment-tray .attachment-chip")).toHaveLength(1);
  });

  it("keeps the tray's scroll and the field's text while a chip moves", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.type("with a file");
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png", 900)]);
    await ui.settle();
    const field = ui.capture("#message");
    const tray = ui.document.getElementById("attachment-tray") as HTMLElement;
    tray.scrollTop = 8;
    const trayBefore = ui.capture("#attachment-tray");

    ui.attachments.addAttachmentFiles([fileOf(ui.window, "another.png", "image/png", 1200)]);
    await ui.settle();

    ui.expectUntouched(field);
    ui.expectUntouched(trayBefore);
  });
});
