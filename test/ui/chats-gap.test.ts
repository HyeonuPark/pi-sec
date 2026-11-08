/**
 * The chats page's assertion that the old page's tests made and the new page's
 * tests did not.
 *
 * The chats list is served under whatever prefix the install sits behind, and both
 * of its links are built from that prefix rather than from the host root: the
 * shell's `← root chat` link, and the stylesheet the page loads. Its assets come
 * from the report page's directory, which serves the whole web folder, so the page
 * needs no asset route of its own. The new page adds nothing to that link — the
 * shell's stamp is the whole of it — and this test holds the shell to it.
 */
import { describe, expect, it } from "vitest";
import { chatsPage } from "./chats-fixtures.ts";

describe("the chats page under a mount prefix", () => {
  it("links the root chat, and builds the link under the mount the page is served from", async () => {
    const page = await chatsPage({ active: [], archived: { "": { items: [] } } }, { base: "/sec" });
    try {
      expect(page.document.getElementById("chat-link")?.getAttribute("href")).toBe("/sec/basic-chat");
      // Assets come from the report page's directory, which serves the whole web
      // folder, so the page needs no asset route of its own.
      expect(page.document.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe(
        "/sec/report/assets/theme.css",
      );
      // The lists behind the links are empty, which is the page the link sits on.
      expect(page.document.querySelectorAll("#view .chat-row")).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});
