/**
 * THIRD_PARTY_NOTICES.md is generated from package-lock.json, and nothing else in
 * the build reads it. A dependency that changes while the notice file stays the
 * same would leave the attribution wrong, so this file pins the two together: the
 * generator must reproduce the tracked file exactly, and a copy with one row
 * removed must be reported as stale.
 *
 * The child process gets an environment built from nothing but this file's own
 * values. Nothing from `process.env` is spread in, because the daemon that runs
 * the test carries variables that a spawned process must not inherit.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { uiPackages } from "../scripts/build-ui.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "third-party-notices.mjs");
const NOTICES = join(REPO, "THIRD_PARTY_NOTICES.md");

const CHILD_ENV = { PATH: process.env.PATH ?? "", TZ: "UTC", TERM: "dumb" };

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the generator's `--check`, against the tracked file or against a copy. */
function check(...args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [SCRIPT, "--check", ...args], {
    cwd: REPO,
    env: CHILD_ENV,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("third-party notices", () => {
  it("reproduces the tracked file from package-lock.json", () => {
    const result = check();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("reports a copy with one row removed as stale", async () => {
    const text = await readFile(NOTICES, "utf8");
    const lines = text.split("\n");
    // The last table row is a package row: the delimiter row does not match this
    // pattern, and the bundled packages are the last table in the file.
    const last = lines.findLastIndex((line) => /^\| .+ \|$/.test(line));
    expect(last, "the notice file has no table row to remove").toBeGreaterThan(-1);

    const dir = await mkdtemp(join(tmpdir(), "pi-sec-notices-"));
    try {
      const copy = join(dir, "THIRD_PARTY_NOTICES.md");
      const removed = lines.filter((_line, index) => index !== last);
      expect(removed.length).toBe(lines.length - 1);
      await writeFile(copy, removed.join("\n"), "utf8");

      const result = check(copy);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("THIRD_PARTY_NOTICES.md is out of date. Run: npm run notices");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names markdown-it once, as a package the pages bundle", async () => {
    // The repository used to ship a copy of markdown-it's browser build beside the
    // hand-written page scripts, and it had a section of its own. The switch commit
    // deleted that copy: the pages now reach markdown-it through the bundle, and
    // section 2 is the one place that names it.
    const text = await readFile(NOTICES, "utf8");
    expect(text).toMatch(
      /^\| markdown-it \| \d+\.\d+\.\d+ \| MIT \| https:\/\/github\.com\/markdown-it\/markdown-it \|$/m,
    );
    expect((text.match(/^\| markdown-it \|/gm) ?? []).length, "markdown-it is named twice").toBe(1);

    const at = text.indexOf("## 2. Packages that the code under `src/ui/` reaches");
    expect(at, "the notice file has no bundled section").toBeGreaterThan(-1);
    expect(text.slice(at)).toContain("| markdown-it | 15.0.3 |");
    // Nothing in the tree holds third-party source any more.
    expect(text).not.toContain("Code included in this repository");
    expect(text).not.toContain("src/web/vendor");
  });

  it("lists every package that code under src/ui reaches", async () => {
    // The list is one bundle's input list, so a package that any module under
    // `src/ui/` imports is in section 3 whether or not a page entry imports it,
    // and whether or not anyone remembered to add it here.
    const reached = await uiPackages({ root: REPO });
    expect(reached.packages.length, "the code under src/ui reaches no package at all").toBeGreaterThan(0);
    expect(reached.packages).toContain("preact");
    expect(reached.packages).toContain("markdown-it");

    const text = await readFile(NOTICES, "utf8");
    const at = text.indexOf("## 2. Packages that the code under `src/ui/` reaches");
    expect(at, "the notice file has no bundled section").toBeGreaterThan(-1);
    const section = text.slice(at);
    for (const name of reached.packages) {
      expect(section, `${name} is reached from src/ui but is not listed`).toContain(`| ${name} |`);
    }
  }, 60_000);

  it("leaves out a package that no module under src/ui imports", async () => {
    // jsdom is installed for the tests and marked a development dependency, and
    // nothing under `src/ui/` imports it. Section 3 names the packages that code
    // under `src/ui/` reaches, so it must name neither more nor less than that.
    const manifest = JSON.parse(await readFile(join(REPO, "node_modules/jsdom/package.json"), "utf8"));
    expect(manifest.name, "jsdom is not installed, so this test proves nothing").toBe("jsdom");

    const reached = await uiPackages({ root: REPO });
    expect(reached.packages.length, "the code under src/ui reaches no package at all").toBeGreaterThan(0);
    expect(reached.packages).not.toContain("jsdom");

    const text = await readFile(NOTICES, "utf8");
    const at = text.indexOf("## 2. Packages that the code under `src/ui/` reaches");
    expect(at, "the notice file has no bundled section").toBeGreaterThan(-1);
    expect(text.slice(at), "the bundled section names a package that src/ui never imports").not.toContain("| jsdom |");
  }, 60_000);

  it("lists the runtime dependencies in a rendered table", async () => {
    const text = await readFile(NOTICES, "utf8");
    expect(text).toContain("## 1. Runtime dependencies");
    expect(text).toContain("| Package | Version | License | Repository |");
    // A markdown table without this row renders as a paragraph of pipes.
    expect(text).toContain("| --- | --- | --- | --- |");
    const rows = text.split("\n").filter((line) => /^\| \S.* \| \S.* \| \S.* \|$/.test(line));
    expect(rows.length, "the runtime section is empty").toBeGreaterThan(100);
  });
});
