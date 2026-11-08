/**
 * The files a sent message carries, under its words.
 *
 * A message names its files by id alone, so a bubble draws from what the page knows
 * about those ids. A descriptor that arrives with the message's own frame draws a
 * picture on the first paint; an id the page knows nothing about draws a chip that
 * names its id and still downloads, because guessing a picture there would put a
 * broken image where a file is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadStreamPage, operatorMessage, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadStreamPage>[0] = {}): Promise<StreamPage> {
  open = await loadStreamPage(options);
  return open;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const image = { name: "photo.png", mime: "image/png", bytes: 1200, w: 640, h: 480 };
const file = { name: "notes.txt", mime: "text/plain", bytes: 2500 };

describe("an attachment in the transcript", () => {
  it("draws a picture at the width and height the descriptor gives", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "look", { attachments: "a1" })], attachments: { a1: image } });
    await flush();
    const link = ui.document.querySelector('[data-row-key="entry:1"] .message-image');
    expect(link?.getAttribute("href")).toBe("/api/attachments/a1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    const picture = link?.querySelector("img");
    expect(picture?.getAttribute("src")).toBe("/api/attachments/a1");
    expect(picture?.getAttribute("alt")).toBe("photo.png");
    expect(picture?.getAttribute("width")).toBe("640");
    expect(picture?.getAttribute("height")).toBe("480");
    expect(picture?.getAttribute("loading")).toBe("lazy");
  });

  it("draws anything else as a chip with its name, type and size", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "read this", { attachments: "a2" })], attachments: { a2: file } });
    await flush();
    const chip = ui.document.querySelector('[data-row-key="entry:1"] .message-file');
    expect(chip?.getAttribute("href")).toBe("/api/attachments/a2/download");
    expect(chip?.querySelector(".message-file-name")?.textContent).toBe("notes.txt");
    expect(chip?.querySelector(".message-file-meta")?.textContent).toBe("text/plain · 2.5 KB");
  });

  it("draws an id it cannot describe as a chip that names the id", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "what is this", { attachments: "a9" })] });
    await flush();
    const chip = ui.document.querySelector('[data-row-key="entry:1"] .message-file');
    expect(chip?.querySelector(".message-file-name")?.textContent).toBe("a9");
    expect(chip?.querySelector(".message-file-meta")).toBeNull();
    expect(ui.document.querySelector('[data-row-key="entry:1"] img')).toBeNull();
  });

  it("keeps the mount prefix on both links", async () => {
    const ui = await page({ base: "/sec" });
    ui.emit("snapshot", {
      entries: [operatorMessage(1, "files", { attachments: "a1,a2" })],
      attachments: { a1: image, a2: file },
    });
    await flush();
    expect(ui.document.querySelector(".message-image")?.getAttribute("href")).toBe("/sec/api/attachments/a1");
    expect(ui.document.querySelector(".message-file")?.getAttribute("href")).toBe("/sec/api/attachments/a2/download");
  });

  it("keeps the order the message names its files in", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [operatorMessage(1, "both", { attachments: "a2,a1" })],
      attachments: { a1: image, a2: file },
    });
    await flush();
    const names = [...ui.document.querySelectorAll('[data-row-key="entry:1"] .message-attachments > *')].map((element) =>
      element.className.includes("message-image") ? "image" : "file",
    );
    expect(names).toEqual(["file", "image"]);
  });

  it("turns a chip into a picture when the descriptor arrives later, without replacing the row", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "look", { attachments: "a1" })] });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.querySelector(".message-file")).not.toBeNull();

    ui.emit("message_end", { attachments: { a1: image } });
    await flush();
    expect(ui.document.querySelector('[data-row-key="entry:1"]')).toBe(row);
    expect(ui.document.querySelector('[data-row-key="entry:1"] .message-image')).not.toBeNull();
  });

  it("draws nothing under a message that names no file", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "plain words")] });
    await flush();
    expect(ui.document.querySelector('[data-row-key="entry:1"] .message-attachments')).toBeNull();
  });
});
