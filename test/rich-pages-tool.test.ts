/** `share_page`: what it stores, what it refuses and what it returns (C1). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getAttachment } from "../src/attachments/store.ts";
import { RICH_PAGE_MAX_BYTES } from "../src/extensions/attachments.ts";
import { FOCUSED_CHAT_TOOLS } from "../src/agent/tool-profile.ts";
import { bootRichPages, isError, jsonOf, textOf, toolApi, type RichPagesFixture } from "./rich-pages-helpers.ts";

let f: RichPagesFixture | undefined;

afterEach(async () => {
  await f?.close();
  f = undefined;
});

const PAGE = "<!doctype html><html><body><h1>Hello</h1></body></html>";

describe("share_page", () => {
  it("stores a page from a string and returns its id, address and markdown tag", async () => {
    f = await bootRichPages();
    const result = await f.tool("share_page").execute({ title: "Weekly tool calls", html: PAGE } as never, toolApi, ctx);
    expect(isError(result)).toBe(false);
    const payload = jsonOf(result);
    const id = String(payload["id"]);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload["url"]).toBe(`/rich-pages/${id}`);
    expect(payload["markdown"]).toBe(`![Weekly tool calls](/rich-pages/${id})`);
    expect(payload["bytes"]).toBe(Buffer.byteLength(PAGE));
    expect(payload["ownedBy"]).toBeNull();
    const row = await getAttachment(f.ctx(), id);
    expect(row?.kind).toBe("share");
    expect(row?.mime).toBe("text/html");
    expect(row?.name.endsWith(".html")).toBe(true);
    expect(row?.richPage).toBe(true);
    expect(row?.conversationId).toBe("41");
    expect((await readFile(row!.storagePath, "utf8"))).toBe(PAGE);
  });

  it("stores a page from a file, relative to the workspace", async () => {
    f = await bootRichPages();
    const path = join(f.h.paths.workspaceTree, "pages", "demo.html");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, PAGE, "utf8");
    const result = await f.tool("share_page").execute({ title: "From file", source: "pages/demo.html", name: "demo" } as never, toolApi, ctx);
    expect(isError(result)).toBe(false);
    const row = await getAttachment(f.ctx(), String(jsonOf(result)["id"]));
    expect(row?.name).toBe("demo.html");
    expect(await readFile(row!.storagePath, "utf8")).toBe(PAGE);
  });

  it("uses the configured mount prefix and cleans the title in the tag", async () => {
    f = await bootRichPages();
    const result = await f.tool("share_page", { prefix: "/sec" }).execute({ title: "A [b]\nc", html: PAGE } as never, toolApi, ctx);
    const payload = jsonOf(result);
    expect(payload["url"]).toBe(`/sec/rich-pages/${String(payload["id"])}`);
    expect(payload["markdown"]).toBe(`![A b c](/sec/rich-pages/${String(payload["id"])})`);
  });

  it("refuses both inputs, neither input, an empty page, a page over 1 MiB, invalid UTF-8 and an unknown job", async () => {
    f = await bootRichPages();
    const tool = f.tool("share_page");
    const path = join(f.h.paths.workspaceTree, "x.html");
    await writeFile(path, PAGE, "utf8");
    const both = await tool.execute({ title: "t", html: PAGE, source: path } as never, toolApi, ctx);
    expect(isError(both)).toBe(true);
    expect(textOf(both)).toContain("exactly one");
    expect(isError(await tool.execute({ title: "t" } as never, toolApi, ctx))).toBe(true);
    expect(isError(await tool.execute({ title: "t", html: "" } as never, toolApi, ctx))).toBe(true);
    const big = await tool.execute({ title: "t", html: "x".repeat(RICH_PAGE_MAX_BYTES + 1) } as never, toolApi, ctx);
    expect(isError(big)).toBe(true);
    expect(textOf(big)).toContain("1048576");
    const exact = await tool.execute({ title: "t", html: "x".repeat(RICH_PAGE_MAX_BYTES) } as never, toolApi, ctx);
    expect(isError(exact)).toBe(false);
    const bad = join(f.h.paths.workspaceTree, "bad.html");
    await writeFile(bad, Buffer.from([0x3c, 0xff, 0xfe, 0x3e]));
    const invalid = await tool.execute({ title: "t", source: bad } as never, toolApi, ctx);
    expect(isError(invalid)).toBe(true);
    expect(textOf(invalid)).toContain("UTF-8");
    const jobs = { get: async () => undefined };
    const unknown = await f.tool("share_page", { jobs }).execute({ title: "t", html: PAGE, jobId: "nope" } as never, toolApi, ctx);
    expect(isError(unknown)).toBe(true);
    expect(textOf(unknown)).toContain("Job not found: nope");
  });

  it("is listed with richPage true, and a data:text/html share_image row has no mark", async () => {
    f = await bootRichPages();
    const page = jsonOf(await f.tool("share_page").execute({ title: "Listed", html: PAGE } as never, toolApi, ctx));
    const dataUrl = `data:text/html;base64,${Buffer.from(PAGE).toString("base64")}`;
    const image = jsonOf(await f.tool("share_image").execute({ source: dataUrl, name: "plain.html" } as never, toolApi, ctx));
    const listed = jsonOf(await f.tool("attachments_list").execute({} as never, toolApi, ctx))["attachments"] as Record<string, unknown>[];
    expect(listed.find((row) => row["id"] === page["id"])?.["richPage"]).toBe(true);
    const plain = listed.find((row) => row["id"] === image["id"]);
    expect(plain?.["mime"]).toBe("text/html");
    expect(plain?.["richPage"]).toBeUndefined();
    expect((await getAttachment(f.ctx(), String(image["id"])))?.richPage).toBeUndefined();
  });

  it("is in the focused chat allow list", () => {
    expect(FOCUSED_CHAT_TOOLS).toContain("share_page");
  });
});
