/**
 * The page's frame: the four elements this branch owns, the Pages row, the
 * extension cards and the mount rule.
 *
 * The rewrite keeps the hand-written page's markup, because the stylesheet and
 * every id the page's own tests name are part of the contract. So the strongest
 * statement this file makes is the literal one: the elements this branch draws are
 * the elements `src/web/index.html` carries, with the same ids, classes and
 * attributes. The comparison is made on the element tree and not on the markup,
 * because Preact drops comment nodes and the whitespace between the shell's
 * elements: those change nothing a reader or the stylesheet can see.
 *
 * The three features here are the ones that live on the frame rather than in a
 * panel: the Pages row, a `ui_event` handed to the extension card it
 * names, and the mount rule that says a page with no mount stamp must say
 * so rather than build guessed URLs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { loadUiPage, root, type UiPageHandle } from "./harness.ts";
import { byId, escape, loadChatPage, more, press } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/** The shell's own markup, before any page code touches it. */
async function shellMarkup(): Promise<Document> {
  const html = (await readFile(join(root, "src/web/index.html"), "utf8")).replaceAll("{{base}}", "");
  return new JSDOM(html, { url: "http://localhost/basic-chat" }).window.document;
}

/** One element as the page draws it: the tag, every attribute, and its children. */
function shape(node: Element | null): unknown {
  if (node === null) return null;
  return {
    tag: node.tagName.toLowerCase(),
    attributes: [...node.attributes].map((attribute) => [attribute.name, attribute.value]).sort(),
    children: [...node.childNodes]
      .filter((child) => child.nodeType === 1 || (child.nodeType === 3 && (child.textContent ?? "").trim() !== ""))
      .map((child) => (child.nodeType === 1 ? shape(child as Element) : { text: (child.textContent ?? "").trim() })),
  };
}

/**
 * One panel's frame: the element and everything static inside it.
 *
 * The report panel's body and feedback container are drawn from a read (the
 * loading line, the shared control), so what a panel *holds* there is pinned by
 * the tests that read a report. This comparison is about the frame the stylesheet
 * and the page's ids are written against, so those two containers are compared as
 * empty containers (`container`) on both sides.
 */
function frameOf(panel: Element | null): unknown {
  const copy = panel?.cloneNode(true) as Element | null;
  for (const selector of ["#report-pane-body", "#report-pane-feedback"]) {
    const container = copy?.querySelector(selector);
    container?.replaceChildren();
    // Whether the control is on screen is the panel's state, not its frame.
    container?.removeAttribute("hidden");
  }
  // Whether a select is disabled follows what the server answered, not the frame.
  for (const select of copy?.querySelectorAll("select") ?? []) select.removeAttribute("disabled");
  return shape(copy);
}

describe("the page the parts draw", () => {
  it("draws the three panels the shell carries, with the same tags, classes and attributes", async () => {
    const shell = await shellMarkup();
    open = await loadChatPage();
    for (const id of ["report-pane", "snippet-pane", "login-pane"]) {
      expect(frameOf(byId(open, id)), `#${id} is not the element the shell wrote`).toEqual(
        frameOf(shell.getElementById(id)),
      );
    }
  });

  it("draws the drawer's two controls as the shell wrote them", async () => {
    const shell = await shellMarkup();
    open = await loadChatPage();
    // The panel is out on a wide screen and nothing has moved it, so the button
    // still says what it does rather than which way it would go.
    expect(shape(byId(open, "sidebar-toggle"))).toEqual(shape(shell.getElementById("sidebar-toggle")));
    expect(shape(byId(open, "sidebar-scrim"))).toEqual(shape(shell.getElementById("sidebar-scrim")));
    expect(shape(byId(open, "toast"))).toEqual(shape(shell.getElementById("toast")));
    expect(shape(byId(open, "theme-toggle"))).toEqual(shape(shell.getElementById("theme-toggle")));
  });

  it("draws the Pages row's wrapper as the shell wrote it", async () => {
    const shell = await shellMarkup();
    open = await loadChatPage();
    const drawn = open.document.querySelector(".sidebar-more");
    const written = shell.querySelector(".sidebar-more");
    // The menu is empty in the shell and filled by the page, as the hand-written
    // page filled it; its links are the row's own business and are pinned below.
    expect(shape(drawn?.querySelector("#pages-toggle") ?? null)).toEqual(
      shape(written?.querySelector("#pages-toggle") ?? null),
    );
    expect(drawn?.querySelector("#pages-menu")?.getAttribute("role")).toBe("menu");
    expect(drawn?.querySelector("#pages-menu")?.getAttribute("aria-label")).toBe("Pages");
    // The row keeps its place: after the Appearance row, before the card slot.
    expect(drawn?.closest(".sidebar-row")?.previousElementSibling?.textContent).toContain("Appearance");
    expect(drawn?.closest(".sidebar-row")?.nextElementSibling?.getAttribute("data-ui-slot")).toBe("sidebar.bottom");
  });

  it("keeps the footer's extension slot where the server put it, and touches nothing inside it", async () => {
    const ui = await loadUiPage("chat", { url: "/basic-chat" });
    open = ui;
    await more(2);
    const slot = ui.document.querySelector('.ui-slot[data-ui-slot="sidebar.bottom"]');
    expect(slot).not.toBeNull();
    expect(slot?.childElementCount).toBe(0);
    expect(slot?.parentElement?.classList.contains("sidebar-footer")).toBe(true);
  });
});

describe("the Pages row", () => {
  const menu = (ui: UiPageHandle) => byId(ui, "pages-menu");
  const toggle = (ui: UiPageHandle) => byId(ui, "pages-toggle");
  const links = (ui: UiPageHandle) => [...menu(ui).querySelectorAll("a")] as HTMLAnchorElement[];
  const isOpen = (ui: UiPageHandle) => menu(ui).classList.contains("open");

  it("opens three links in one order, each in a new tab and with no opener", async () => {
    open = await loadChatPage();
    expect(isOpen(open)).toBe(false);
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);
    expect(toggle(open).getAttribute("aria-expanded")).toBe("true");

    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats"]);
    expect(links(open).map((each) => each.getAttribute("href"))).toEqual(["/report", "/usage", "/chats"]);
    expect(links(open).map((each) => each.getAttribute("target"))).toEqual(["_blank", "_blank", "_blank"]);
    // The opened page must not reach back through `window.opener`.
    expect(links(open).map((each) => each.getAttribute("rel"))).toEqual(["noopener", "noopener", "noopener"]);
    expect(links(open).map((each) => each.getAttribute("role"))).toEqual(["menuitem", "menuitem", "menuitem"]);
  });

  it("toggles on the button, and closes on a press outside the row", async () => {
    open = await loadChatPage();
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(false);
    expect(toggle(open).getAttribute("aria-expanded")).toBe("false");

    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);
    // The transcript is as far from the row as a press gets.
    press(open, byId(open, "transcript"));
    await more(1);
    expect(isOpen(open)).toBe(false);
  });

  it("closes on Escape", async () => {
    open = await loadChatPage();
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);
    escape(open);
    await more(1);
    expect(isOpen(open)).toBe(false);
    expect(toggle(open).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when one of its links is pressed, and leaves the link's own address alone", async () => {
    open = await loadChatPage();
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);

    press(open, links(open)[0]!);
    await more(2);
    expect(isOpen(open)).toBe(false);
    expect(toggle(open).getAttribute("aria-expanded")).toBe("false");
    // The press belongs to the link: closing the menu must not move where the new
    // tab would go, and the link stays where it was for the next press.
    expect(links(open)[0]!.getAttribute("href")).toBe("/report");
  });

  it("closes when one of its links is pressed with the middle button", async () => {
    open = await loadChatPage();
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);

    links(open)[1]!.dispatchEvent(
      new open.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
    );
    await more(2);
    expect(isOpen(open)).toBe(false);
    expect(links(open)[1]!.getAttribute("href")).toBe("/usage");
  });

  it("stays open on a right-button press, which is a menu the page cannot see", async () => {
    open = await loadChatPage();
    press(open, toggle(open));
    await more(1);
    expect(isOpen(open)).toBe(true);

    links(open)[0]!.dispatchEvent(
      new open.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }),
    );
    await more(2);
    // The browser opens its own menu here and says nothing the page can act on, so
    // the row keeps the state the reader left it in.
    expect(isOpen(open)).toBe(true);
  });
});

describe("an extension card's event", () => {
  it("hands a ui_event to the card script, in the shape the server sent", async () => {
    open = await loadChatPage();
    const ui = open;
    const heard: unknown[] = [];
    // What `src/web/ui-cards.js` installs on the page. The harness runs no card
    // script, so the page sees the one bridge and nothing else.
    (ui.window as unknown as { piSecUi: unknown }).piSecUi = {
      define: () => {},
      dispatch: (payload: unknown) => heard.push(payload),
    };

    const payload = { extension: "demo-cards", card: "toggle", event: "tick", value: 3 };
    ui.emit("ui_event", payload);
    await more(2);
    expect(heard).toEqual([payload]);

    // A different event of another card is still one frame, handed on as it came.
    ui.emit("ui_event", { extension: "demo-cards", card: "switch", event: "tock" });
    await more(2);
    expect(heard).toHaveLength(2);
    expect((heard[1] as { event: string }).event).toBe("tock");
  });

  it("carries an event with no card script on the page without failing", async () => {
    open = await loadChatPage();
    // No `window.piSecUi` at all: a page whose card script did not load has no
    // cards to tell, and a frame that names one is not an error.
    expect((open.window as unknown as { piSecUi?: unknown }).piSecUi).toBeUndefined();
    open.emit("ui_event", { extension: "demo-cards", card: "toggle", event: "tick" });
    await more(2);
    expect(open.document.getElementById("composer")).not.toBeNull();
  });
});

describe("a page with no mount stamp", () => {
  it("says the mount is unknown instead of building guessed URLs", async () => {
    open = await loadUiPage("chat", { url: "/somewhere/else" });
    await more(3);
    const banner = byId(open, "mount-banner");
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toContain("Mount point unknown");

    // Every URL the frame builds is still a route under the mount, and the mount
    // prefix rule refuses anything else rather than resolving it by accident.
    press(open, byId(open, "pages-toggle"));
    await more(1);
    for (const anchor of open.document.querySelectorAll("#pages-menu a")) {
      expect(anchor.getAttribute("href")?.startsWith("/")).toBe(true);
    }
    const bridge = (open.window as unknown as { piSecMount: { at(base: string, route: string): string } }).piSecMount;
    expect(() => bridge.at("", "report")).toThrow(/absolute/);
  });

  it("keeps the banner hidden on a page that carries its stamp", async () => {
    open = await loadChatPage({ base: "/sec", url: "/sec/basic-chat" });
    expect(byId(open, "mount-banner").classList.contains("hidden")).toBe(true);
  });

  it("assembles the whole page on a mount it cannot name", async () => {
    open = await loadUiPage("chat", { url: "/nowhere" });
    await more(3);
    // The parts are all there, and the page says what is wrong instead of drawing
    // half of itself and a guessed request behind it.
    expect(open.document.getElementById("composer")).not.toBeNull();
    expect(open.document.getElementById("report-pane")).not.toBeNull();
    expect(open.document.getElementById("login-pane")).not.toBeNull();
    expect(open.document.querySelector("#pages-menu a")).not.toBeNull();
  });
});
