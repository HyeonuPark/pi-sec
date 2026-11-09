/** The frame route and the shell route of rich pages (C2). */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getAttachment, SecShare } from "../src/attachments/store.ts";
import {
  RICH_PAGE_GONE,
  RICH_PAGE_REPORTER,
  RICH_PAGE_REPORTER_VERSION,
  richPageFrameHeaders,
} from "../src/server/routes/rich-pages.ts";
import { bootRichPages, jsonOf, toolApi, type RichPagesFixture } from "./rich-pages-helpers.ts";

let f: RichPagesFixture | undefined;

afterEach(async () => {
  await f?.close();
  f = undefined;
});

const PAGE = "<!doctype html><html><body><h1>Hello</h1></body></html>";

const EXPECTED_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

async function makePage(fixture: RichPagesFixture, title = "Hello page", html = PAGE): Promise<string> {
  return String(jsonOf(await fixture.tool("share_page").execute({ title, html } as never, toolApi, ctx))["id"]);
}

describe("GET /rich-pages/<id>/frame", () => {
  it("serves the stored bytes and the reporter under the exact isolation header set", async () => {
    f = await bootRichPages();
    const id = await makePage(f);
    const row = await getAttachment(f.ctx(), id);
    const response = await fetch(`${f.origin}/rich-pages/${id}/frame`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toBe(EXPECTED_CSP);
    expect(policy).toContain("sandbox allow-scripts");
    for (const forbidden of ["allow-same-origin", "allow-popups", "allow-top-navigation"]) {
      expect(policy).not.toContain(forbidden);
    }
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toBe(`"${row!.sha256}-${RICH_PAGE_REPORTER_VERSION}"`);
    const body = await response.text();
    expect(body.startsWith(PAGE)).toBe(true);
    expect(body.slice(PAGE.length)).toBe(`\n${RICH_PAGE_REPORTER}\n`);
    expect(richPageFrameHeaders()["Content-Security-Policy"]).toBe(EXPECTED_CSP);
  });

  it("answers 304 for the ETag it sent", async () => {
    f = await bootRichPages();
    const id = await makePage(f);
    const first = await fetch(`${f.origin}/rich-pages/${id}/frame`);
    const etag = first.headers.get("etag")!;
    const second = await fetch(`${f.origin}/rich-pages/${id}/frame`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("redirects a top-level document request to the shell, and serves a frame request", async () => {
    f = await bootRichPages();
    const id = await makePage(f);
    const top = await fetch(`${f.origin}/rich-pages/${id}/frame`, { headers: { "Sec-Fetch-Dest": "document" }, redirect: "manual" });
    expect(top.status).toBe(302);
    expect(top.headers.get("location")).toBe(`/rich-pages/${id}`);
    const framed = await fetch(`${f.origin}/rich-pages/${id}/frame`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(framed.status).toBe(200);
  });

  it("answers the sentence for a bad id, an unknown id, an image, an html share_image and an operator upload", async () => {
    f = await bootRichPages();
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(2, 20);
    const image = jsonOf(
      await f.tool("share_image").execute({ source: `data:image/png;base64,${png.toString("base64")}` } as never, toolApi, ctx),
    );
    const html = jsonOf(
      await f.tool("share_image").execute(
        { source: `data:text/html;base64,${Buffer.from(PAGE).toString("base64")}`, name: "loose.html" } as never,
        toolApi,
        ctx,
      ),
    );
    const upload = (await (
      await fetch(`${f.origin}/api/attachments?name=note.html`, {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: PAGE,
      })
    ).json()) as { id: string };
    const ids = ["not-an-id", "01ARZ3NDEK0000000000005FAV", String(image["id"]), String(html["id"]), upload.id];
    for (const id of ids) {
      const response = await fetch(`${f.origin}/rich-pages/${id}/frame`);
      expect(response.status, id).toBe(404);
      expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain(RICH_PAGE_GONE);
    }
    // The html file stays a download at its own name.
    const plain = await fetch(`${f.origin}${String(html["url"])}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses a POST with Origin: null", async () => {
    f = await bootRichPages();
    const response = await fetch(`${f.origin}/api/attachments?name=x`, {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /rich-pages/<id> (the shell)", () => {
  it("answers the core policy, the bar and a sandboxed frame under the mount", async () => {
    f = await bootRichPages();
    const id = await makePage(f, "Quarterly numbers");
    const response = await fetch(`${f.origin}/rich-pages/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).toContain("Generated page");
    expect(body).toContain("Quarterly-numbers");
    expect(body).toContain('href="/basic-chat">Back to chat');
    expect(body).toContain(`sandbox="allow-scripts allow-forms"`);
    expect(body).toContain(`src="/rich-pages/${id}/frame"`);
    expect(body).not.toContain("allow-same-origin");
    expect(body).not.toContain("<script");
  });

  it("honors a forwarded prefix in the frame address", async () => {
    f = await bootRichPages();
    const id = await makePage(f);
    const response = await fetch(`${f.origin}/rich-pages/${id}`, { headers: { "X-Forwarded-Prefix": "/sec" } });
    const body = await response.text();
    expect(body).toContain(`src="/sec/rich-pages/${id}/frame"`);
    expect(body).toContain('href="/sec/basic-chat"');
  });

  it("answers 404 with the sentence for an unknown id", async () => {
    f = await bootRichPages();
    const response = await fetch(`${f.origin}/rich-pages/01ARZ3NDEK0000000000005FAV`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(RICH_PAGE_GONE);
  });

  it("keeps a title with markup as text", async () => {
    f = await bootRichPages();
    const id = await makePage(f);
    // The store sanitizes a name, so the hostile value is written into the row directly.
    await f.h.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(SecShare, id, id);
      doc.name = '<script>alert(1)</script>"x.html';
    }, ctx);
    const body = await (await fetch(`${f.origin}/rich-pages/${id}`)).text();
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;x");
  });

  it("serves the stylesheet it links", async () => {
    f = await bootRichPages();
    const response = await fetch(`${f.origin}/rich-page.css`);
    expect(response.status).toBe(200);
  });
});

describe("/api/share/<name>.html", () => {
  it("is still a download", async () => {
    f = await bootRichPages();
    const id = await makePage(f, "Download me");
    const row = await getAttachment(f.ctx(), id);
    const response = await fetch(`${f.origin}/api/share/${row!.name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});
