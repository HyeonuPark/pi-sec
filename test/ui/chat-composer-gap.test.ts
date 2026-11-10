/**
 * The old chat page's composer assertions that the new page's own tests left
 * uncovered.
 *
 * Each test comes from one named test of the hand-written page
 * (`test/attachments-web.test.ts`, `test/focused-chat-web.test.ts`,
 * `test/web-ui.test.ts`) and checks the same thing on the new page: an empty
 * `Enter` sends nothing, a send carries the ready attachment ids and empties the
 * tray, the focused chat has no archive or delete control, the composer row keeps
 * its three actions and its menu the same at every width, and a refused reinstall
 * question sends nothing.
 *
 * The two narrow-screen layout rules are pinned as CSS text, the way the old test
 * pinned them: jsdom computes no layout, so the rule that decides the geometry is
 * what a test can hold still.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bodyOf, fileOf, loadComposerPage, type ComposerPage } from "./chat-composer-harness.ts";
import { root, type UiPageHandle } from "./harness.ts";
import { loadChatPage, more } from "./chat-harness.ts";

let open: ComposerPage | undefined;
let page: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  page?.close();
  page = undefined;
});

async function composer(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Calls by route suffix, whichever method. */
function calls(ui: ComposerPage, suffix: string) {
  return ui.fetchCalls.filter((call) => call.path.endsWith(suffix));
}

/** The attachment tray element. */
function tray(ui: ComposerPage): HTMLElement {
  return ui.document.getElementById("attachment-tray") as HTMLElement;
}

/** The id the fake server gave the upload of `name`: the default answer counts them. */
function idOf(ui: ComposerPage, name: string): string {
  const uploads = ui.fetchCalls.filter((call) => call.method === "POST" && call.path.startsWith("/api/attachments"));
  const at = uploads.findIndex((call) => new URL(call.url, "http://localhost").searchParams.get("name") === name);
  return `att-${at + 1}`;
}

/** The menu element. */
function menu(ui: ComposerPage): HTMLElement {
  return ui.document.getElementById("composer-menu") as HTMLElement;
}

/* ------------------------------------------------------- chat-composer */

describe("chat-composer: the ready ids go out and the tray empties", () => {
  it("puts the ready ids in the message body and empties the tray", async () => {
    // `test/attachments-web.test.ts` "puts the ready ids in the message body and
    // empties the tray". The ids are read off the request, in the order the files
    // were picked, and the tray is what a send the server accepted clears.
    const ui = await composer({ bitmap: { width: 800, height: 600 } });
    ui.attachments.addAttachmentFiles([
      fileOf(ui.window, "photo.png", "image/png"),
      fileOf(ui.window, "report.pdf", "application/pdf"),
    ]);
    await ui.settle();

    ui.type("here they are");
    ui.submit();
    await ui.settle();

    const [send] = calls(ui, "/messages");
    expect(send?.path).toBe("/basic-chat/messages");
    expect(bodyOf(send)).toEqual({
      content: "here they are",
      // In the order they were picked, whatever order the uploads finished in.
      attachmentIds: [idOf(ui, "photo.png"), idOf(ui, "report.pdf")],
      requestId: expect.stringMatching(/^web:/),
    });
    expect(tray(ui).classList.contains("hidden")).toBe(true);
    expect(ui.attachments.attachments.value).toEqual([]);
    expect(ui.text()).toBe("");
  });
});

describe("chat-composer: a focused chat carries no archive or delete control", () => {
  it("are nowhere on the page", async () => {
    // `test/focused-chat-web.test.ts` "are nowhere on the page": a focused chat's
    // last message is `archive` or `delete` on the chat record, never a control
    // beside the field.
    page = await loadChatPage({ url: "/basic-chat?chat=7" });
    // The page is the focused chat, and its composer is on it: the two words below
    // are absent from a page that drew, not from a page that drew nothing.
    expect(page.streams()).toEqual(["/api/conversations/7/events"]);
    expect(page.document.getElementById("send")).not.toBeNull();
    const labels = [...page.document.querySelectorAll("button")].map((button) => (button.textContent ?? "").toLowerCase());
    for (const word of ["archive", "delete"]) {
      expect(labels.filter((label) => label.includes(word))).toEqual([]);
    }
  });
});

describe("chat-composer: the field takes the first row at 860px", () => {
  /** Every `@media (max-width: 860px)` block that carries `selector`'s own rule. */
  const blocksWith = (css: string, selector: string): string[] => {
    const blocks = [...css.matchAll(/@media \(max-width: 860px\) \{[\s\S]*?\n\}/g)].map((match) => match[0]);
    return blocks.filter((block) => bodyOfSelector(block, selector) !== "");
  };
  const bodyOfSelector = (block: string, selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return block.match(new RegExp(`(?:^|\\n)\\s*${escaped} \\{([\\s\\S]*?)\\n\\s*\\}`))?.[1] ?? "";
  };

  it("puts the field alone on the first row at 860px and narrower, with the pickers at the left of the row below it and the actions at its right", async () => {
    // `test/web-ui.test.ts` "puts the field alone on the first row at 860px ...".
    const css = await readFile(join(root, "src/web/styles.css"), "utf8");
    const blocks = blocksWith(css, ".composer-tools");
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;

    // A row, not a column: the actions can then share a line with the pickers.
    expect(bodyOfSelector(block, ".composer")).toMatch(/flex-direction:\s*row/);
    // The field asks for the whole row, so it wraps on its own and keeps its width.
    expect(bodyOfSelector(block, "#message")).toMatch(/order:\s*1/);
    expect(bodyOfSelector(block, "#message")).toMatch(/flex:\s*1 0 100%/);
    // The pickers keep their order and start at the left edge of the second row.
    expect(bodyOfSelector(block, ".composer-tools")).toMatch(/order:\s*2/);
    expect(bodyOfSelector(block, ".composer-tools")).not.toMatch(/margin-left:\s*auto/);
    // The actions take the free space in front of them, so they sit at the right.
    expect(bodyOfSelector(block, ".composer-actions")).toMatch(/order:\s*3/);
    expect(bodyOfSelector(block, ".composer-actions")).toMatch(/margin-left:\s*auto/);
  });

  it("gives the attachment tray its own full-width row at 860px, so it never pushes the field sideways", async () => {
    // `test/web-ui.test.ts` "gives the attachment tray its own full-width row ...".
    const css = await readFile(join(root, "src/web/styles.css"), "utf8");
    const blocks = blocksWith(css, ".attachment-tray");
    expect(blocks).toHaveLength(1);
    const trayBody = bodyOfSelector(blocks[0]!, ".attachment-tray");

    // Sized by its own width rather than by a flex basis, which in a stacked
    // column would become a height, and placed before the field.
    expect(trayBody).toMatch(/order:\s*0/);
    expect(trayBody).toMatch(/flex:\s*0 0 auto/);
    expect(trayBody).toMatch(/width:\s*100%/);
  });
});

describe("chat-composer: three actions in the row", () => {
  it("keeps Send, Stop and the dropdown as the three actions at every width", async () => {
    // `test/web-ui.test.ts` "keeps Send, Stop and the dropdown as the three actions
    // at every width". The new page draws one row for every width and lets the
    // stylesheet move it, so the markup is the same either way: the three actions
    // are the row's children, and a second Stop for a narrow screen does not exist.
    const ui = await composer();
    const row = ui.document.querySelector(".composer-actions")!;
    const ids = [...row.children].map((element) =>
      element.tagName === "BUTTON" ? element.id : element.querySelector("button")!.id,
    );
    expect(ids).toEqual(["abort", "more-actions", "send"]);
    expect(ui.document.getElementById("abort-quick")).toBeNull();
    // None of the three is put away by a class or an attribute, which is the other
    // way a width could take one off the row.
    for (const id of ids) {
      const element = ui.document.getElementById(id)!;
      expect(element.classList.contains("hidden")).toBe(false);
      expect(element.hasAttribute("hidden")).toBe(false);
    }
  });
});

describe("chat-composer: the secondary actions are in the menu, Send is not", () => {
  it("folds the secondary actions into the dropdown, leaving Send out of it", async () => {
    // `test/web-ui.test.ts` "folds the secondary actions into the dropdown,
    // leaving Send out of it": all six entries, in order, and Send outside.
    const ui = await composer();
    expect([...menu(ui).querySelectorAll("button")].map((button) => button.id)).toEqual([
      "reset",
      "compact",
      "model-login",
      "restart-ui",
      "restart",
      "restart-reinstall",
    ]);
    expect(menu(ui).contains(ui.document.getElementById("send"))).toBe(false);
    expect(ui.document.getElementById("more-actions")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("chat-composer: a refused reinstall question sends nothing", () => {
  it("sends nothing when the reinstall confirmation is refused", async () => {
    // `test/web-ui.test.ts` "sends nothing when the reinstall confirmation is
    // refused". The question is asked and refused, so no restart is asked for.
    const ui = await composer({ ask: [] });
    const reinstall = ui.document.getElementById("restart-reinstall")!;

    (reinstall as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toHaveLength(1);
    expect(ui.questions[0]).toContain("node_modules");
    expect(ui.fetchCalls.filter((call) => call.path.endsWith("/api/admin/restart"))).toEqual([]);
  });
});
