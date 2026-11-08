/**
 * The production build of the page bundles.
 *
 * What a page must be able to count on: one bundle per page entry, no `eval` or
 * `new Function` in any of them (the page is served under a CSP that forbids
 * both), a split file that is imported by a relative path, so the same files load
 * under `/report/assets/`, and one stylesheet copied out of an installed package:
 * the code-block palette of the pull request dashboard.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUi, ROOT, uiPackages } from "../../scripts/build-ui.mjs";

const PAGES = ["chat", "chats", "github-pr-diff", "github-pr-list", "github-pr-view", "report", "usage-stats", "usage"];

/** Every `.js` file of a build, as `{ name, text }`, entries and chunks alike. */
async function readOutput(directory: string): Promise<Array<{ name: string; text: string }>> {
  const files: Array<{ name: string; text: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const inner of await readdir(path, { withFileTypes: true })) {
        if (inner.isFile() && inner.name.endsWith(".js")) {
          files.push({ name: `${entry.name}/${inner.name}`, text: await readFile(join(path, inner.name), "utf8") });
        }
      }
      continue;
    }
    if (entry.name.endsWith(".js")) files.push({ name: entry.name, text: await readFile(path, "utf8") });
  }
  return files;
}

describe("buildUi", () => {
  it("writes one bundle per page, with no eval and no Function", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-sec-ui-build-"));
    try {
      const result = await buildUi({ root: ROOT, outDir });
      expect(result.pages).toEqual(PAGES);

      const files = await readOutput(outDir);
      expect(files.map((file) => file.name)).toEqual(
        expect.arrayContaining(PAGES.map((page) => `ui-${page}.js`)),
      );

      for (const page of PAGES) {
        const text = await readFile(join(outDir, `ui-${page}.js`), "utf8");
        expect(text.length).toBeGreaterThan(0);
        // A page is an external module that calls nothing by name.
        expect(text).toMatch(/import\s*\{[^}]*\}\s*from\s*"\.\/ui-chunks\//);
      }

      for (const file of files) {
        expect(file.text, `${file.name} carries eval(`).not.toContain("eval(");
        expect(file.text, `${file.name} carries new Function`).not.toContain("new Function");
        // No absolute or mount-rooted import: the same files must load under
        // `/report/assets/`, where the page's own path is not the mount root.
        // An `import ... from "..."` that begins a statement, and nothing else.
        // The bundle's own strings hold words such as `"from","title"` (an
        // attribute-name list) and highlight.js's grammars carry the keyword list
        // `"import","from","export"`, which a bare `from"` would read as an
        // import; a statement always starts at a line break or after a `;`.
        for (const match of file.text.matchAll(/(?:^|;)\s*import[^;]*?from\s*"([^"]*)"/g)) {
          const specifier = match[1] ?? "";
          if (specifier === "preact" || specifier.startsWith("./") || specifier.startsWith("../")) continue;
          throw new Error(`${file.name} imports ${specifier}, which is neither bundled nor relative`);
        }
      }

      expect(result.packages).toContain("preact");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("clears the last build's bundles and chunks, and nothing else", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-sec-ui-rebuild-"));
    try {
      await buildUi({ root: ROOT, outDir });
      const chunks = await readdir(join(outDir, "ui-chunks"));
      expect(chunks.length, "the first build wrote no chunk").toBeGreaterThan(0);

      // What a second build has to deal with: a chunk under a name whose content
      // is gone, the bundle of a page that no longer exists, and two files the
      // daemon serves beside the bundles.
      await writeFile(join(outDir, "ui-chunks", "old-page-0000.js"), "export const gone = 1;\n");
      await writeFile(join(outDir, "ui-gone.js"), "export const gone = 1;\n");
      await writeFile(join(outDir, "ui-gone.js.map"), "{}\n");
      await writeFile(join(outDir, "ui-cards.js"), "/* served as it is */\n");
      await writeFile(join(outDir, "index.html"), "<!doctype html>\n");

      const result = await buildUi({ root: ROOT, outDir });

      // The bundles are written again, the stale chunk and the bundle of the
      // gone page are not there, and the files the daemon serves are untouched.
      const files = await readdir(outDir);
      expect(files).toEqual(expect.arrayContaining(PAGES.map((page) => `ui-${page}.js`)));
      expect(files).not.toContain("ui-gone.js");
      expect(files).not.toContain("ui-gone.js.map");
      expect(await readFile(join(outDir, "ui-cards.js"), "utf8")).toBe("/* served as it is */\n");
      expect(await readFile(join(outDir, "index.html"), "utf8")).toBe("<!doctype html>\n");
      expect(await readdir(join(outDir, "ui-chunks"))).not.toContain("old-page-0000.js");
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("copies the code-block palette out of the installed highlight.js package", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-sec-ui-highlight-"));
    try {
      await buildUi({ root: ROOT, outDir });
      // The file is written beside the bundles, under the name the pull request
      // and diff pages ask for, and it is the package's own file rather than a
      // copy tracked in this repository.
      const copied = await readFile(join(outDir, "ui-highlight-github.css"), "utf8");
      const source = await readFile(join(ROOT, "node_modules/highlight.js/styles/github.css"), "utf8");
      expect(copied).toBe(source);
      // A palette, not an empty file: every highlighting class the pages emit is
      // coloured by it.
      expect(copied).toContain(".hljs-keyword");
      expect(copied).toContain(".hljs-string");
      expect(copied.length).toBeGreaterThan(500);
      // The copy is part of the build's report, so a caller can see it happened.
      const result = await buildUi({ root: ROOT, outDir });
      expect(result.files).toContain("ui-highlight-github.css");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reads the packages of every module under src/ui, not only the pages", async () => {
    // One virtual entry imports every module under `src/ui/`, so a module that no
    // page entry imports yet still reports the packages it reaches.
    const reached = await uiPackages({ root: ROOT });
    expect(reached.packages).toContain("preact");
    expect(reached.packages).toContain("markdown-it");
    expect(reached.packages).toEqual([...reached.packages].sort());
  }, 60_000);

  it("builds the test bundles in memory, as one script per page", async () => {
    const result = await buildUi({ root: ROOT, mode: "test" });
    expect(result.pages).toEqual(PAGES);
    for (const page of PAGES) {
      const code = result.code[page] ?? "";
      expect(code.length).toBeGreaterThan(0);
      // An IIFE: nothing to import or export, which is what `window.eval` needs.
      // The check looks for statements at the start of a line, not for the text:
      // a page that imports a CommonJS package carries esbuild's interop helper
      // `var __export = (target, all) => …`, which is a function, not an export.
      expect(code).not.toMatch(/^\s*import\s/m);
      expect(code).not.toMatch(/^\s*export\s/m);
      expect(code).not.toContain("eval(");
    }
    expect(result.packages).toContain("preact");
  }, 60_000);
});
