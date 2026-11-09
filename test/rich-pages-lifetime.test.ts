/**
 * A rich page follows the share file lifetime (C9): a page without a job that is
 * 25 hours old is disposed by the boot sweep, and its addresses then answer the
 * "no longer exists" sentence. The test says nothing about a page that a job owns.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getAttachment, SecShare } from "../src/attachments/store.ts";
import { sweepAttachments } from "../src/attachments/sweep.ts";
import { RICH_PAGE_GONE } from "../src/server/routes/rich-pages.ts";
import { bootRichPages, jsonOf, toolApi, type RichPagesFixture } from "./rich-pages-helpers.ts";

let f: RichPagesFixture | undefined;

afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("rich page lifetime", () => {
  it("deletes a page without a job after 25 hours, and the addresses then say it is gone", async () => {
    f = await bootRichPages();
    const made = await f.tool("share_page").execute({ title: "Old", html: "<p>old</p>" } as never, toolApi, ctx);
    const id = String(jsonOf(made)["id"]);
    expect((await fetch(`${f.origin}/rich-pages/${id}/frame`)).status).toBe(200);
    await f.h.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(SecShare, id, id);
      doc.collectedAt = Date.now() - 25 * 60 * 60 * 1000;
    }, ctx);

    const swept = await sweepAttachments(f.ctx());
    expect(swept.dropped).toBe(1);
    expect(await getAttachment(f.ctx(), id)).toBeUndefined();

    const frame = await fetch(`${f.origin}/rich-pages/${id}/frame`);
    expect(frame.status).toBe(404);
    expect(await frame.text()).toContain(RICH_PAGE_GONE);
    const shell = await fetch(`${f.origin}/rich-pages/${id}`);
    expect(shell.status).toBe(404);
    expect(await shell.text()).toContain(RICH_PAGE_GONE);
  });
});
