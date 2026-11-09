/**
 * Runtime extension pages through the loader: a written extension answers without
 * a restart, a reload replaces the pages, a broken module keeps the old ones, and
 * a removed directory or a removed export takes them away.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootServer, installHostStatus, pagesExtension, removeExtension, writeExtension, type BootedPages } from "./ext-pages-helpers.ts";

let booted: BootedPages | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const pagesSource = (text: string, extra = "") =>
  pagesExtension(
    "foo",
    `export const pages = { entries: [{ page: "", label: "Foo", menu: true }], render() { return { html: "<p id=\\"mark\\">${text}</p>" }; }, api() { return { json: { text: "${text}" } }; } ${extra} };`,
  );

async function get(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${booted!.origin}${path}`);
  return { status: response.status, text: await response.text() };
}

describe("runtime extension pages", () => {
  it("answers a page of an extension written into the directory, without a restart", async () => {
    booted = await bootServer();
    expect((await get("/ext/foo/")).status).toBe(404);

    await writeExtension(booted.harness, "foo", pagesSource("first"));
    const loaded = await booted.harness.runtime.loader.reload();
    expect(loaded.errors).toEqual([]);

    const page = await get("/ext/foo/");
    expect(page.status).toBe(200);
    expect(page.text).toContain('<p id="mark">first</p>');
    // The body sits inside the core document.
    expect(page.text).toContain('<meta name="pi-sec-ext" content="foo" />');
    expect(page.text).toContain("<title>Foo · pi-sec</title>");
    expect(JSON.parse((await get("/ext/foo/api/x")).text)).toEqual({ text: "first" });
  });

  it("answers the new content after the module changes and reloads", async () => {
    booted = await bootServer();
    await writeExtension(booted.harness, "foo", pagesSource("old"));
    await booted.harness.runtime.loader.reload();
    expect((await get("/ext/foo/")).text).toContain(">old<");

    await writeExtension(booted.harness, "foo", pagesSource("new"));
    await booted.harness.runtime.loader.reload();
    expect((await get("/ext/foo/")).text).toContain(">new<");
    expect(JSON.parse((await get("/ext/foo/api/x")).text)).toEqual({ text: "new" });
  });

  it("keeps the old content when the module breaks, and shows the error in list()", async () => {
    booted = await bootServer();
    await writeExtension(booted.harness, "foo", pagesSource("kept"));
    await booted.harness.runtime.loader.reload();

    await writeExtension(booted.harness, "foo", "export const pages = {;\n");
    const loaded = await booted.harness.runtime.loader.reload();
    expect(loaded.errors.join("\n")).toContain("foo:");

    expect((await get("/ext/foo/")).text).toContain(">kept<");
    const record = booted.harness.runtime.loader.list().find((entry) => entry.name === "foo");
    expect(record?.error).toBeDefined();
    expect(record?.pages).toEqual({ pages: ["/"], errors: [] });
  });

  it("answers 404 for the page, the api, the files and the menu after the directory is removed", async () => {
    booted = await bootServer();
    await installHostStatus(booted.harness);
    await booted.harness.runtime.loader.reload();
    expect((await get("/ext/host-status/")).status).toBe(200);
    expect((await get("/ext/host-status/api/status")).status).toBe(200);
    expect((await get("/ext/host-status/ui/app.js")).status).toBe(200);
    expect(booted.harness.runtime.pages.links()).toEqual([{ label: "Host status", path: "/ext/host-status/" }]);

    await removeExtension(booted.harness, "host-status");
    await booted.harness.runtime.loader.reload();
    for (const path of ["/ext/host-status/", "/ext/host-status/api/status", "/ext/host-status/ui/app.js"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect(booted.harness.runtime.pages.links()).toEqual([]);
    const links = JSON.parse((await get("/api/ui/page-links")).text) as unknown[];
    expect(links).toEqual([]);
  });

  it("answers 404 after the pages export is removed", async () => {
    booted = await bootServer();
    await writeExtension(booted.harness, "foo", pagesSource("here"));
    await booted.harness.runtime.loader.reload();
    expect((await get("/ext/foo/")).status).toBe(200);

    await writeExtension(booted.harness, "foo", pagesExtension("foo", ""));
    await booted.harness.runtime.loader.reload();
    expect((await get("/ext/foo/")).status).toBe(404);
    expect((await get("/ext/foo/api/x")).status).toBe(404);
  });

  it("shows pages: { pages, errors } for the extension in GET /api/admin/status", async () => {
    booted = await bootServer();
    await writeExtension(
      booted.harness,
      "foo",
      pagesExtension(
        "foo",
        `export const pages = { entries: [{ page: "", label: "Foo" }, { page: "ui", label: "Bad" }], render() { return null; } };`,
      ),
    );
    await booted.harness.runtime.loader.reload();
    const status = (await (await fetch(`${booted.origin}/api/admin/status`)).json()) as {
      runtimeExtensions: { name: string; pages?: { pages: string[]; errors: string[] } }[];
    };
    const record = status.runtimeExtensions.find((entry) => entry.name === "foo");
    expect(record?.pages?.pages).toEqual(["/"]);
    expect(record?.pages?.errors).toHaveLength(1);
    expect(record?.pages?.errors[0]).toContain("reserved");
  });
});
