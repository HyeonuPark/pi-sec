/**
 * The composer's place on the chat page.
 *
 * The rewrite keeps the hand-written page's markup, because the stylesheet and
 * every id the page's own tests name are part of the contract. So the strongest
 * statement this file can make is the literal one: the form the composer draws is
 * the form `src/web/index.html` carries, character for character, and the context
 * bar and its readout keep the ids, classes and attributes the stylesheet finds
 * them by.
 *
 * The tray is checked in both states: empty and hidden at rest, and one chip per
 * file with the three things a chip says.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { fileOf, loadComposerPage, type ComposerPage } from "./chat-composer-harness.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

let open: ComposerPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/**
 * One element as the page really draws it: the tag, every attribute, every child
 * element in order, and the text a reader sees.
 *
 * The comparison is made on this and not on the markup itself, because Preact
 * drops the comment nodes and the whitespace between the shell's elements. Those
 * change nothing a reader or the stylesheet can see; an id, a class, an attribute
 * or an order that differs does, and every one of them is here.
 */
function shape(node: Element): unknown {
  return {
    tag: node.tagName.toLowerCase(),
    attributes: [...node.attributes].map((attribute) => [attribute.name, attribute.value]).sort(),
    children: [...node.childNodes]
      .filter((child) => child.nodeType === 1 || (child.nodeType === 3 && (child.textContent ?? "").trim() !== ""))
      .map((child) => (child.nodeType === 1 ? shape(child as Element) : { text: (child.textContent ?? "").trim() })),
  };
}

/** The shell's own markup, before any page code touches it. */
async function shellMarkup(): Promise<Document> {
  const html = (await readFile(join(root, "src/web/index.html"), "utf8")).replaceAll("{{base}}", "");
  return new JSDOM(html, { url: "http://localhost/basic-chat" }).window.document;
}

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

describe("the page the composer draws", () => {
  it("draws the form the shell carries: the same elements, ids, classes, attributes and order", async () => {
    const shell = await shellMarkup();
    const ui = await page();

    const drawn = ui.document.getElementById("composer");
    const written = shell.getElementById("composer");
    expect(drawn).not.toBeNull();
    expect(shape(drawn as Element)).toEqual(shape(written as Element));
  });

  it("keeps the context bar above the form, and the readout in the sidebar footer", async () => {
    const shell = await shellMarkup();
    const ui = await page();

    const bar = ui.document.getElementById("context-bar") as HTMLElement;
    expect(bar.getAttribute("class")).toBe(shell.getElementById("context-bar")?.getAttribute("class"));
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("Context used");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(ui.document.getElementById("context-fill")?.parentElement).toBe(bar);
    expect(bar.nextElementSibling?.id).toBe("composer");

    const readout = ui.document.getElementById("context-usage") as HTMLElement;
    expect(readout.tagName).toBe("SPAN");
    expect(readout.getAttribute("class")).toBe(shell.getElementById("context-usage")?.getAttribute("class"));
    expect(readout.closest(".sidebar-footer")).not.toBeNull();
  });

  it("keeps the composer out of the way of the chat notice, which takes its slot", async () => {
    const ui = await page();
    const notice = ui.document.getElementById("chat-notice") as HTMLElement;
    // The notice follows the form: with the form hidden it takes the same slot,
    // which is why it is not between the bar and the field.
    expect(notice.previousElementSibling?.id).toBe("composer");
  });

  it("leaves the tray hidden and empty at rest", async () => {
    const ui = await page();
    const tray = ui.document.getElementById("attachment-tray") as HTMLElement;
    expect(tray.getAttribute("class")).toBe("attachment-tray hidden");
    expect(tray.getAttribute("aria-label")).toBe("Attachments for the next message");
    expect(tray.childElementCount).toBe(0);
  });

  it("draws one chip per file, with its name, its state and its two controls", async () => {
    const ui = await page({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([fileOf(ui.window, "photo.png", "image/png", 1500)]);
    await ui.settle();

    const chip = ui.document.querySelector("#attachment-tray .attachment-chip");
    expect(chip?.getAttribute("class")).toBe("attachment-chip is-ready");
    expect(chip?.querySelector(".attachment-name")?.textContent).toBe("photo.png");
    expect(chip?.querySelector(".attachment-meta")?.textContent).toBe("image/png · 1.5 KB");
    const remove = chip?.querySelector("button.attachment-remove");
    expect(remove?.getAttribute("aria-label")).toBe("Remove photo.png");
    expect(remove?.getAttribute("type")).toBe("button");
    // A ready chip has nothing to retry.
    expect(chip?.querySelector("button.attachment-retry")).toBeNull();
  });

  it("takes the composer away for a chat this page cannot write to, and leaves the field alone", async () => {
    const ui = await page({
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Old topic", archived: true } } },
    });

    // The conversation branch owns that class; the composer must not undo it.
    expect(ui.document.getElementById("composer")?.classList.contains("hidden")).toBe(true);
    expect(ui.document.getElementById("chat-notice")?.classList.contains("hidden")).toBe(false);
  });
});
