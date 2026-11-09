/**
 * The page registry: what it accepts from a `pages` export, what it drops with
 * one diagnostic line, and the checks on what `render` and `api` return.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PageRegistry } from "../src/registry/pages.ts";

const logger = { warn: () => {}, info: () => {} };
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** An extension directory with a `ui/` directory holding `files`. */
async function extensionDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ext-pages-registry-"));
  dirs.push(dir);
  await mkdir(join(dir, "ui"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, "ui", name), text);
  return dir;
}

const render = () => ({ html: "<p>x</p>" });

describe("PageRegistry.register", () => {
  it("accepts valid pages and lists the menu links in declared order", async () => {
    const dir = await extensionDir({ "app.js": "", "app.css": "" });
    const registry = new PageRegistry({ logger });
    const result = await registry.register(
      "foo",
      {
        entries: [
          { page: "", label: " Home ", menu: true, script: "app.js", style: "app.css" },
          { page: "history", label: "History" },
          { page: "more-1", label: "More", menu: true },
        ],
        render,
      },
      { dir, config: {} },
    );
    expect(result).toEqual({ pages: ["/", "history", "more-1"], errors: [] });
    expect(registry.page("foo", "")?.label).toBe("Home");
    expect(registry.page("foo", "")?.script).toBe("app.js");
    expect(registry.page("foo", "history")?.menu).toBe(false);
    expect(registry.links()).toEqual([
      { label: "Home", path: "/ext/foo/" },
      { label: "More", path: "/ext/foo/more-1" },
    ]);
    expect(registry.uiDir("foo")).toBe(join(dir, "ui"));
    expect(registry.diagnostics("foo")).toEqual({ pages: ["/", "history", "more-1"], errors: [] });
  });

  it("sorts links by extension name", async () => {
    const dir = await extensionDir();
    const registry = new PageRegistry({ logger });
    for (const name of ["zed", "alpha"]) {
      await registry.register(name, { entries: [{ page: "", label: name, menu: true }], render }, { dir, config: {} });
    }
    expect(registry.links().map((link) => link.label)).toEqual(["alpha", "zed"]);
  });

  it("replaces the previous registration, and an undefined export removes it without an error", async () => {
    const dir = await extensionDir();
    const registry = new PageRegistry({ logger });
    await registry.register("foo", { entries: [{ page: "a", label: "A" }], render }, { dir, config: {} });
    await registry.register("foo", { entries: [{ page: "b", label: "B" }], render }, { dir, config: {} });
    expect(registry.page("foo", "a")).toBeUndefined();
    expect(registry.page("foo", "b")).toBeDefined();

    const removed = await registry.register("foo", undefined, { dir, config: {} });
    expect(removed).toEqual({ pages: [], errors: [] });
    expect(registry.names()).toEqual([]);
    expect(registry.diagnostics("foo")).toBeUndefined();
    expect(registry.uiDir("foo")).toBeUndefined();
  });

  it.each([
    ["not an object", "x", "pages must be an object"],
    ["an array", [], "pages must be an object"],
    ["no render", { entries: [] }, "pages has no render function"],
    ["no entries array", { render }, "pages.entries must be an array"],
  ])("keeps an empty registration and one error for a wrong shape: %s", async (_name, exported, message) => {
    const registry = new PageRegistry({ logger });
    const result = await registry.register("foo", exported, { dir: await extensionDir(), config: {} });
    expect(result).toEqual({ pages: [], errors: [message] });
    expect(registry.diagnostics("foo")).toEqual({ pages: [], errors: [message] });
    // No page means no file route either.
    expect(registry.uiDir("foo")).toBeUndefined();
  });

  it("drops a bad entry alone, with one line each, and refuses the reserved names", async () => {
    const registry = new PageRegistry({ logger });
    const result = await registry.register(
      "foo",
      {
        entries: [
          { page: "good", label: "Good" },
          "text",
          { page: "Bad Name", label: "x" },
          { page: "ui", label: "x" },
          { page: "api", label: "x" },
          { page: "good", label: "again" },
          { page: "nolabel", label: "  " },
          { page: "badmenu", label: "x", menu: "yes" },
          { page: 7, label: "x" },
          { page: "a/b", label: "x" },
        ],
        render,
      },
      { dir: await extensionDir(), config: {} },
    );
    expect(result.pages).toEqual(["good"]);
    expect(result.errors).toHaveLength(9);
    expect(result.errors.join("\n")).toContain('page "ui" is a reserved name');
    expect(result.errors.join("\n")).toContain('page "api" is a reserved name');
    expect(result.errors.join("\n")).toContain("already declared");
    expect(registry.page("foo", "ui")).toBeUndefined();
    expect(registry.page("foo", "api")).toBeUndefined();
  });

  it("refuses an extension name that cannot be a URL segment", async () => {
    const registry = new PageRegistry({ logger });
    const result = await registry.register("bad name", { entries: [{ page: "", label: "x" }], render }, { dir: await extensionDir(), config: {} });
    expect(result.pages).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(registry.page("bad name", "")).toBeUndefined();
    expect(registry.links()).toEqual([]);
  });

  it("applies the file rules to script and style", async () => {
    const dir = await extensionDir({ "ok.js": "", "ok.css": "", "note.txt": "" });
    await writeFile(join(dir, "outside.js"), "");
    await symlink(join(dir, "outside.js"), join(dir, "ui", "linked.js"));
    const registry = new PageRegistry({ logger });
    const result = await registry.register(
      "foo",
      {
        entries: [
          { page: "ok", label: "x", script: "ok.js", style: "ok.css" },
          { page: "missing", label: "x", script: "gone.js" },
          { page: "dots", label: "x", script: "../outside.js" },
          { page: "link", label: "x", script: "linked.js" },
          { page: "suffix", label: "x", script: "note.txt" },
          { page: "suffix2", label: "x", style: "ok.js" },
          { page: "nostring", label: "x", style: 4 },
          { page: "abs", label: "x", script: "/etc/passwd" },
        ],
        render,
      },
      { dir, config: {} },
    );
    expect(result.pages).toEqual(["ok"]);
    const text = result.errors.join("\n");
    expect(text).toContain('script "gone.js" is not a file in ui/');
    expect(text).toContain('has a "." or ".." segment');
    expect(text).toContain("resolves outside ui/");
    expect(text).toContain("must end in .js or .mjs");
    expect(text).toContain("must end in .css");
    expect(text).toContain("style must be a string");
    expect(result.errors).toHaveLength(7);
  });

  it("keeps the newest 20 diagnostic lines", async () => {
    const registry = new PageRegistry({ logger });
    const entries = Array.from({ length: 30 }, (_value, index) => ({ page: "Bad", label: `n${index}`, extra: index }));
    await registry.register("foo", { entries, render }, { dir: await extensionDir(), config: {} });
    expect(registry.diagnostics("foo")?.errors).toHaveLength(20);
  });

  it("ignores an api that is not a function, with one line", async () => {
    const registry = new PageRegistry({ logger });
    const result = await registry.register("foo", { entries: [], render, api: 3 }, { dir: await extensionDir(), config: {} });
    expect(result.errors).toEqual(["pages.api is not a function, so it is ignored"]);
    expect(registry.hasApi("foo")).toBe(false);
  });
});

describe("PageRegistry.render and api", () => {
  async function registered(exported: Record<string, unknown>): Promise<PageRegistry> {
    const registry = new PageRegistry({ logger });
    await registry.register("foo", { entries: [{ page: "", label: "x" }], ...exported }, { dir: await extensionDir(), config: { k: 1 } });
    return registry;
  }

  it("passes page, query, config and timezone to render and returns a frozen result", async () => {
    let seen: unknown;
    const registry = await registered({
      render: (args: unknown) => {
        seen = args;
        return { html: "<p>a</p>", title: "T", css: "p{}" };
      },
    });
    const result = await registry.render("foo", "", { query: { a: "1" }, timezone: "Asia/Seoul" });
    expect(result).toEqual({ html: "<p>a</p>", title: "T", css: "p{}" });
    expect(seen).toEqual({ page: "", query: { a: "1" }, config: { k: 1 }, timezone: "Asia/Seoul" });
  });

  it("returns null for null or undefined, and throws on a wrong shape", async () => {
    const results: unknown[] = [null, undefined, "text", {}, { html: 1 }, { html: "", title: 1 }, { html: "", css: 1 }];
    let next = 0;
    const registry = await registered({ render: () => results[next++] });
    const input = { query: {}, timezone: "UTC" };
    expect(await registry.render("foo", "", input)).toBeNull();
    expect(await registry.render("foo", "", input)).toBeNull();
    for (let index = 2; index < results.length; index += 1) {
      await expect(registry.render("foo", "", input)).rejects.toThrow(/pages\.render of foo\//);
    }
    await expect(registry.render("foo", "nope", input)).rejects.toThrow(/no page/);
  });

  it("defaults the api status to 200 and checks the status and the shape", async () => {
    const results: unknown[] = [{ json: { a: 1 } }, undefined, { status: 201 }, { status: 99 }, { status: "x" }, "text"];
    let next = 0;
    const registry = await registered({ render, api: () => results[next++] });
    const input = { method: "GET", path: "p", query: {}, body: undefined, timezone: "UTC" };
    expect(await registry.api("foo", input)).toEqual({ status: 200, json: { a: 1 } });
    expect(await registry.api("foo", input)).toEqual({ status: 200 });
    expect(await registry.api("foo", input)).toEqual({ status: 201 });
    for (let index = 3; index < results.length; index += 1) {
      await expect(registry.api("foo", input)).rejects.toThrow(/pages\.api of foo/);
    }
  });
});
