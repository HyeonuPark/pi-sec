/**
 * The Pages menu's extension links: the ones the server plants in the page.
 *
 * The row draws three links of its own (`Reports`, `Usage`, `Chats`) and then one
 * link per entry of the `pages-links` data block, which the server writes from
 * the page links the enabled extensions declare. A page served by a server whose
 * extensions declare none carries an empty block, and a page with no block at all
 * is the page every other test in this directory loads: it draws the three and
 * nothing else.
 *
 * The block is data, so what this file drives is the page's own reading of it.
 * The server's side of the device is `test/pages-links.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadUiPage, settle, type UiPageHandle } from "./harness.ts";
import { byId, loadChatPage, more, press } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/** The menu's links, in the order it draws them. */
function links(ui: UiPageHandle): HTMLAnchorElement[] {
  return [...byId(ui, "pages-menu").querySelectorAll("a")] as HTMLAnchorElement[];
}

/** The one link the server planted, as the block writes it. */
const PRS = { label: "PRs", path: "/github/pr/" };

describe("the Pages menu with the enabled extensions' links", () => {
  it("draws the three links and then the planted one, each in a new tab with no opener", async () => {
    open = await loadChatPage({ pagesLinks: [PRS] });
    press(open, byId(open, "pages-toggle"));
    await more(1);

    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats", "PRs"]);
    expect(links(open).map((each) => each.getAttribute("href"))).toEqual([
      "/report",
      "/usage",
      "/chats",
      "/github/pr/",
    ]);
    // The planted link is drawn by the row itself, so it carries the same three
    // attributes as the three above it.
    const last = links(open).at(-1)!;
    expect(last.getAttribute("target")).toBe("_blank");
    expect(last.getAttribute("rel")).toBe("noopener");
    expect(last.getAttribute("role")).toBe("menuitem");
  });

  it("puts the mount prefix on the planted link's address", async () => {
    open = await loadChatPage({ base: "/sec", url: "/sec/basic-chat", pagesLinks: [PRS] });
    press(open, byId(open, "pages-toggle"));
    await more(1);
    expect(links(open).map((each) => each.getAttribute("href"))).toEqual([
      "/sec/report",
      "/sec/usage",
      "/sec/chats",
      "/sec/github/pr/",
    ]);
  });

  it("draws the three links when the page carries an empty block", async () => {
    open = await loadChatPage({ pagesLinks: [] });
    press(open, byId(open, "pages-toggle"));
    await more(1);
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats"]);
  });

  it("draws the three links when the page carries no block", async () => {
    open = await loadChatPage();
    expect(open.document.getElementById("pages-links")).toBeNull();
    press(open, byId(open, "pages-toggle"));
    await more(1);
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats"]);
  });

  it("draws the three links when the block cannot be read", async () => {
    // A block the server wrote as something other than a list of links: the menu
    // keeps what it always had instead of failing to draw its own three.
    open = await loadUiPage("chat", { url: "/basic-chat", pagesLinks: "not a list" });
    await more();
    press(open, byId(open, "pages-toggle"));
    await more(1);
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats"]);

    // And an entry that is not a usable link is skipped while the rest are drawn.
    open.close();
    open = await loadUiPage("chat", {
      url: "/basic-chat",
      pagesLinks: [{ label: "", path: "/empty/" }, { label: "Relative", path: "github/pr/" }, PRS],
    });
    await more();
    press(open, byId(open, "pages-toggle"));
    await settle();
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats", "PRs"]);
  });

  it("closes the menu when the planted link is pressed", async () => {
    open = await loadChatPage({ pagesLinks: [PRS] });
    press(open, byId(open, "pages-toggle"));
    await more(1);
    expect(byId(open, "pages-menu").classList.contains("open")).toBe(true);

    press(open, links(open).at(-1)!);
    await more(2);
    expect(byId(open, "pages-menu").classList.contains("open")).toBe(false);
    // The press belongs to the link, so its address is where the new tab goes.
    expect(links(open).at(-1)!.getAttribute("href")).toBe("/github/pr/");
  });
});

describe("the Pages menu reads the list again each time it opens", () => {
  const HOST = { label: "Host status", path: "/ext/host-status/" };

  it("shows a link the server added after the page loaded, and puts the mount on it", async () => {
    open = await loadChatPage({
      base: "/sec",
      url: "/sec/basic-chat",
      pagesLinks: [PRS],
      fetch: { "/api/ui/page-links": { body: [PRS, HOST] } },
    });
    expect(open.fetchCalls.filter((call) => call.path === "/sec/api/ui/page-links")).toHaveLength(0);
    press(open, byId(open, "pages-toggle"));
    await more(3);

    expect(open.fetchCalls.filter((call) => call.path === "/sec/api/ui/page-links")).toHaveLength(1);
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats", "PRs", "Host status"]);
    expect(links(open).at(-1)!.getAttribute("href")).toBe("/sec/ext/host-status/");
  });

  it("keeps the list from the data block when the read fails or answers something else", async () => {
    for (const answer of [{ status: 500, body: { error: "x" } }, { body: "not a list" }, { body: {} }]) {
      open = await loadChatPage({ pagesLinks: [PRS], fetch: { "/api/ui/page-links": answer } });
      press(open, byId(open, "pages-toggle"));
      await more(3);
      expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats", "PRs"]);
      open.close();
    }
    open = undefined;
  });

  it("drops an entry the read answers that is not a usable link", async () => {
    open = await loadChatPage({
      pagesLinks: [],
      fetch: { "/api/ui/page-links": { body: [{ label: "", path: "/x/" }, { label: "Rel", path: "x/" }, HOST] } },
    });
    press(open, byId(open, "pages-toggle"));
    await more(3);
    expect(links(open).map((each) => each.textContent)).toEqual(["Reports", "Usage", "Chats", "Host status"]);
  });
});
