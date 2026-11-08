/**
 * The files beside the field: the four buttons, the one upload each, the chip
 * that says how far it got, and what the next message carries.
 *
 * Two of these are measured rather than assumed, because both cost the operator
 * something. A picture that already fits 1920×1080 must not touch a canvas at
 * all: re-encoding it loses a GIF its animation and costs a phone a second. A
 * larger one is drawn once, at the size the server takes. jsdom has no canvas, so
 * the counters here are also the proof that the happy path never asks for one.
 *
 * Every picture size in this file comes from a stubbed `createImageBitmap`, and
 * every upload is answered by the fake `fetch`: nothing leaves the process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bodyOf, fileOf, loadComposerPage, operatorMessage, type ComposerPage } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Every upload the page made. */
function uploads(ui: ComposerPage) {
  return ui.fetchCalls.filter((call) => call.method === "POST" && call.path.startsWith("/api/attachments"));
}

/** The tray element. */
function tray(ui: ComposerPage): HTMLElement {
  return ui.document.getElementById("attachment-tray") as HTMLElement;
}

/** The id the fake server gave the upload of `name`: the default answer counts them. */
function idOf(ui: ComposerPage, name: string): string {
  const index = uploads(ui).findIndex((item) => new URL(item.url, "http://localhost").searchParams.get("name") === name);
  if (index === -1) throw new Error(`no upload was made for ${name}`);
  return `att-${index + 1}`;
}

describe("the four buttons", () => {
  it("opens the picker each button belongs to", async () => {
    const ui = await page();
    const opened: string[] = [];
    for (const id of ["pick-image", "pick-camera", "pick-file"]) {
      const input = ui.document.getElementById(id) as HTMLInputElement;
      input.click = () => {
        opened.push(id);
      };
    }
    (ui.document.getElementById("attach-image") as HTMLButtonElement).click();
    (ui.document.getElementById("attach-camera") as HTMLButtonElement).click();
    (ui.document.getElementById("attach-file") as HTMLButtonElement).click();
    expect(opened).toEqual(["pick-image", "pick-camera", "pick-file"]);
  });

  it("takes a handful of pictures from the image picker, and one photo from the camera", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    const image = ui.document.getElementById("pick-image") as HTMLInputElement;
    expect(image.getAttribute("accept")).toBe("image/*");
    expect(image.multiple).toBe(true);

    // The camera: `capture` makes a phone open the camera, and `image/*` alone
    // keeps video and sound recording out of the picker. One photo.
    const camera = ui.document.getElementById("pick-camera") as HTMLInputElement;
    expect(camera.getAttribute("accept")).toBe("image/*");
    expect(camera.accept).not.toContain("video/");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.multiple).toBe(false);

    Object.defineProperty(image, "files", {
      configurable: true,
      value: [fileOf(ui.window, "one.png", "image/png"), fileOf(ui.window, "two.png", "image/png")],
    });
    image.dispatchEvent(new ui.window.Event("change"));
    await ui.settle();

    expect(uploads(ui)).toHaveLength(2);
    expect(tray(ui).querySelectorAll(".attachment-chip")).toHaveLength(2);
    // The input is emptied, so the same file can be picked twice in a row.
    expect(image.value).toBe("");
  });

  it("hands the snippet button to the panel that owns it", async () => {
    const ui = await page();
    let opened = 0;
    ui.composer.onSnippetPress(() => {
      opened += 1;
    });
    (ui.document.getElementById("attach-snippet") as HTMLButtonElement).click();
    expect(opened).toBe(1);
    ui.composer.onSnippetPress(null);
  });
});

describe("one upload", () => {
  it("sends a picture that already fits as it is, without touching a canvas", async () => {
    const ui = await page({ bitmap: { width: 1280, height: 720 } });
    const file = fileOf(ui.window, "shot one.png", "image/png", 2048);

    const record = await ui.attachments.uploadAttachment(file);

    expect(ui.canvas.contexts).toBe(0);
    expect(ui.canvas.blobs).toHaveLength(0);
    expect(record.id).toBe("att-1");

    const [upload] = uploads(ui);
    expect(upload?.method).toBe("POST");
    expect(upload?.url).toBe("/api/attachments?name=shot%20one.png");
    expect(upload?.headers["content-type"]).toBe("image/png");
    // The original file, byte for byte and object for object.
    expect(upload?.body).toBe(file);
  });

  it("shrinks a picture over 1920×1080 once, in one draw, as a jpeg", async () => {
    const ui = await page({ bitmap: { width: 3840, height: 2160 } });
    const file = fileOf(ui.window, "screen.jpg", "image/jpeg", 4096);

    await ui.attachments.uploadAttachment(file);

    expect(ui.canvas.contexts).toBe(1);
    expect(ui.canvas.draws).toHaveLength(1);
    expect(ui.canvas.draws[0]?.slice(1)).toEqual([0, 0, 1920, 1080]);
    expect(ui.canvas.blobs).toHaveLength(1);
    expect(ui.canvas.blobs[0]?.type).toBe("image/jpeg");
    expect(ui.canvas.blobs[0]?.quality).toBe(0.85);
    expect(ui.canvas.blobs[0]?.width).toBe(1920);
    expect(ui.canvas.blobs[0]?.height).toBe(1080);

    const [upload] = uploads(ui);
    expect(upload?.headers["content-type"]).toBe("image/jpeg");
    // The body is the re-encoded picture, not the file that was picked.
    expect(upload?.body).not.toBe(file);
    expect((upload?.body as Blob).size).toBe(3);
  });

  it("keeps a png a png when it has to be shrunk", async () => {
    const ui = await page({ bitmap: { width: 2560, height: 1440 } });
    await ui.attachments.uploadAttachment(fileOf(ui.window, "wide.png", "image/png"));

    expect(ui.canvas.blobs[0]?.type).toBe("image/png");
    // A PNG has no quality to give, so none is passed.
    expect(ui.canvas.blobs[0]?.quality).toBeUndefined();
    expect(uploads(ui)[0]?.headers["content-type"]).toBe("image/png");
  });

  it("sends a picture whose size cannot be read as it is, and says so on the chip", async () => {
    // No `createImageBitmap` and no `<img>` path in jsdom: the size is unreadable.
    const ui = await page();
    const file = fileOf(ui.window, "odd.webp", "image/webp", 512);

    const record = await ui.attachments.uploadAttachment(file);

    expect(ui.canvas.contexts).toBe(0);
    expect(uploads(ui)[0]?.body).toBe(file);
    expect(record.note).toBe("size could not be read, sent as it is");
  });

  it("does not read the size of a file that is not an image", async () => {
    const ui = await page({ bitmap: { width: 10, height: 10 } });
    const file = fileOf(ui.window, "report.pdf", "application/pdf", 1200);

    await ui.attachments.uploadAttachment(file);

    expect(ui.canvas.contexts).toBe(0);
    expect(uploads(ui)[0]?.headers["content-type"]).toBe("application/pdf");
    expect(uploads(ui)[0]?.body).toBe(file);
  });
});

describe("the chips above the field", () => {
  it("shows a ready chip with its name, type and size, then drops it on Remove", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png", 1500)]);
    await ui.settle();

    const chip = tray(ui).querySelector(".attachment-chip.is-ready");
    expect(tray(ui).classList.contains("hidden")).toBe(false);
    expect(chip?.querySelector(".attachment-name")?.textContent).toBe("photo.png");
    expect(chip?.querySelector(".attachment-meta")?.textContent).toBe("image/png · 1.5 KB");

    (tray(ui).querySelector("button.attachment-remove") as HTMLButtonElement).click();
    await ui.settle();
    expect(tray(ui).classList.contains("hidden")).toBe(true);
    expect(tray(ui).querySelectorAll(".attachment-chip")).toHaveLength(0);
  });

  it("drags a refused upload through failed and back to ready on Retry", async () => {
    let refuse = true;
    const ui = await page({
      bitmap: { width: 800, height: 600 },
      fetch: {
        "/api/attachments": () =>
          refuse
            ? { status: 413, body: { error: { code: "payload_too_large", message: "payload too large" } } }
            : { status: 201, body: { id: "att-9", name: "huge.png", mime: "image/png", bytes: 9000 } },
      },
    });

    ui.attachments.addAttachmentFiles([fileOf(ui.window, "huge.png", "image/png", 9000)]);
    await ui.settle();

    const failed = tray(ui).querySelector(".attachment-chip.is-failed");
    expect(failed?.querySelector(".attachment-name")?.textContent).toBe("huge.png");
    // The server's own sentence is the reason, not a code.
    expect(failed?.querySelector(".attachment-meta")?.textContent).toBe("payload too large");

    refuse = false;
    (tray(ui).querySelector("button.attachment-retry") as HTMLButtonElement).click();
    await ui.settle();

    expect(uploads(ui)).toHaveLength(2);
    const ready = tray(ui).querySelector(".attachment-chip.is-ready");
    expect(ready?.querySelector(".attachment-name")?.textContent).toBe("huge.png");
    expect(ui.attachments.readyAttachmentIds()).toEqual(["att-9"]);
  });

  it("says a failed upload that could not be sent at all, and retries it", async () => {
    const ui = await page({
      bitmap: { width: 800, height: 600 },
      fetch: {
        "/api/attachments": () => ({ status: 400, body: { error: { code: "invalid_request", message: "an uploaded file has no bytes" } } }),
      },
    });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "empty.bin", "application/octet-stream", 0)]);
    await ui.settle();

    expect(tray(ui).querySelector(".attachment-chip.is-failed .attachment-meta")?.textContent).toBe("an uploaded file has no bytes");
    // A failed chip contributes nothing to the next message.
    expect(ui.attachments.readyAttachmentIds()).toEqual([]);
  });

  it("carries the ready ids in the order the files were picked", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([
      fileOf(ui.window, "photo.png", "image/png"),
      fileOf(ui.window, "report.pdf", "application/pdf"),
    ]);
    await ui.settle();

    ui.type("here they are");
    ui.submit();
    await ui.settle();

    const send = ui.fetchCalls.find((call) => call.path.endsWith("/messages"));
    expect(bodyOf(send)).toEqual({
      content: "here they are",
      attachmentIds: [idOf(ui, "photo.png"), idOf(ui, "report.pdf")],
      requestId: expect.stringMatching(/^web:/),
    });
    // A send the server accepted empties the tray.
    expect(tray(ui).classList.contains("hidden")).toBe(true);
    expect(ui.attachments.attachments.value).toEqual([]);
  });

  it("names the file in the transcript's bubble for the id it uploaded", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png", 1500)]);
    await ui.settle();

    // The id is remembered before the message comes back, so the bubble that
    // names it draws the picture and prints the file's name, not its id.
    ui.emit("message_end", { entry: operatorMessage(1, "here it is", { attachments: "att-1" }) });
    await ui.settle();

    const bubble = ui.document.querySelector("#transcript .message.user");
    expect(bubble?.querySelector(".message-image img")?.getAttribute("alt")).toBe("photo.png");
    expect(bubble?.textContent ?? "").not.toContain("att-1");
  });
});
