import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rename as realRename } from "node:fs/promises";
import { readCodeDrift, rebuildWebAssets, syncWebAssets, UiAssetError } from "../src/runtime/ui-assets.ts";

/** The repository this test runs from, whose `node_modules` and build script it lends out. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-ui-assets-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const path = join(root, relPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The same manifest the module builds, written out here so the format is fixed. */
function expectedHash(files: readonly (readonly [string, string])[]): string {
  const sorted = [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256(sorted.map(([path, content]) => `${path}\u0000${sha256(Buffer.from(content))}\n`).join(""));
}

async function refusal(promise: Promise<unknown>): Promise<UiAssetError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiAssetError) return error;
    throw error;
  }
  throw new Error("expected a UiAssetError");
}

describe("syncWebAssets", () => {
  it("copies the tree, counts the files, and hashes them in path order", async () => {
    const root = await makeRoot();
    const sourceDir = join(root, "src-web");
    const targetDir = join(root, "dist-web");
    const files = [
      ["index.html", "<html><body>one</body></html>"],
      ["app.js", "console.log(1)\n"],
      ["vendor/lib.js", "export const lib = 1;\n"],
    ] as const;
    await writeTree(sourceDir, Object.fromEntries(files));
    await mkdir(targetDir);

    const result = await syncWebAssets({ sourceDir, targetDir });

    expect(result.copied).toBe(3);
    expect(result.uiHash).toBe(expectedHash(files));
    // The bytes are the source's, not a rewrite of them.
    expect(await readFile(join(targetDir, "vendor/lib.js"), "utf8")).toBe("export const lib = 1;\n");
    // Nothing is left beside the two directories.
    expect((await readdir(root)).sort()).toEqual(["dist-web", "src-web"]);
  });

  it("replaces what was served, and keeps the hash stable for the same content", async () => {
    const root = await makeRoot();
    const sourceDir = join(root, "src-web");
    const targetDir = join(root, "dist-web");
    await writeTree(targetDir, { "app.js": "old\n", "only-in-the-old-tree.js": "stale\n" });
    await writeTree(sourceDir, { "app.js": "new\n", "index.html": "i\n" });

    const first = await syncWebAssets({ sourceDir, targetDir });
    expect(first.copied).toBe(2);
    expect(await readFile(join(targetDir, "app.js"), "utf8")).toBe("new\n");
    // The whole directory is replaced, so a file deleted from the source stops
    // being served. A `cp -r` over the directory would leave it behind.
    expect(await readdir(targetDir)).not.toContain("only-in-the-old-tree.js");

    const second = await syncWebAssets({ sourceDir, targetDir });
    expect(second.uiHash).toBe(first.uiHash);

    await writeFile(join(sourceDir, "app.js"), "newer\n", "utf8");
    const third = await syncWebAssets({ sourceDir, targetDir });
    expect(third.uiHash).not.toBe(first.uiHash);
    expect(await readFile(join(targetDir, "app.js"), "utf8")).toBe("newer\n");
    expect((await readdir(root)).sort()).toEqual(["dist-web", "src-web"]);
  });

  it("puts the old tree back when the second rename fails", async () => {
    const root = await makeRoot();
    const sourceDir = join(root, "src-web");
    const targetDir = join(root, "dist-web");
    await writeTree(sourceDir, { "app.js": "new\n", "index.html": "i\n" });
    await writeTree(targetDir, { "app.js": "old\n" });

    // Fail the move into place only. The restore that follows is the third call
    // and it must go through, which is what makes `restored: true` true.
    const moves: string[][] = [];
    const rename = async (from: string, to: string): Promise<void> => {
      moves.push([from, to]);
      if (moves.length === 2) throw new Error("rename failed on purpose");
      await realRename(from, to);
    };

    const error = await refusal(syncWebAssets({ sourceDir, targetDir, rename }));

    expect(moves).toHaveLength(3);
    expect(error.code).toBe("sync_failed");
    expect(error.restored).toBe(true);
    // The served tree is the old one again, byte for byte.
    expect(await readFile(join(targetDir, "app.js"), "utf8")).toBe("old\n");
    expect(await readdir(targetDir)).toEqual(["app.js"]);
    // The staging and backup directories are gone, so a retry starts clean.
    expect((await readdir(root)).filter((name) => /^web\.(next|prev)-/.test(name))).toEqual([]);
  });

  it("does not claim a restore that failed", async () => {
    const root = await makeRoot();
    const sourceDir = join(root, "src-web");
    const targetDir = join(root, "dist-web");
    await writeTree(sourceDir, { "app.js": "new\n" });
    await writeTree(targetDir, { "app.js": "old\n" });

    // The second call fails and so does the restore: the old tree is left in the
    // backup directory, and the caller has to be told that rather than "restored".
    const rename = async (from: string, to: string): Promise<void> => {
      if (rename.calls >= 1) throw new Error("rename failed on purpose");
      rename.calls += 1;
      await realRename(from, to);
    };
    rename.calls = 0;

    const error = await refusal(syncWebAssets({ sourceDir, targetDir, rename }));

    expect(error.code).toBe("sync_failed");
    expect(error.restored).toBe(false);
    // The message names where the tree the operator needs actually is.
    const left = (await readdir(root)).find((name) => name.startsWith("web.prev-"));
    expect(left).toBeDefined();
    expect(error.message).toContain(join(root, left!));
    expect(await readFile(join(root, left!, "app.js"), "utf8")).toBe("old\n");
    // No target, and no half-built copy either.
    expect((await readdir(root)).filter((name) => name === "dist-web" || name.startsWith("web.next-"))).toEqual([]);
  });

  it("refuses without a source, and leaves the served tree alone", async () => {
    const root = await makeRoot();
    const targetDir = join(root, "dist-web");
    await writeTree(targetDir, { "app.js": "keep\n" });

    const error = await refusal(syncWebAssets({ sourceDir: join(root, "gone"), targetDir }));

    expect(error.code).toBe("source_missing");
    expect(error.restored).toBe(true);
    expect(await readFile(join(targetDir, "app.js"), "utf8")).toBe("keep\n");
    expect((await readdir(root)).sort()).toEqual(["dist-web"]);
  });

  it("refuses without a target, and creates nothing beside it", async () => {
    const root = await makeRoot();
    const sourceDir = join(root, "src-web");
    await writeTree(sourceDir, { "app.js": "new\n" });

    const error = await refusal(syncWebAssets({ sourceDir, targetDir: join(root, "dist-web") }));

    expect(error.code).toBe("web_dir_missing");
    // No tree is being served at that path, so there is nothing to be restored.
    expect(error.restored).toBe(false);
    expect(await readdir(root)).toEqual(["src-web"]);
  });

  it("reports a failed copy, keeps the old tree, and removes the half copy", async () => {
    const root = await makeRoot();
    const targetDir = join(root, "dist-web");
    await writeTree(targetDir, { "app.js": "old\n" });

    // Two ways for a file to be unreadable: no permission, and a link that
    // points at nothing. The first depends on the uid the suite runs as, so the
    // second is here to keep the case covered either way.
    const cases: (readonly [string, (dir: string) => Promise<void>])[] = [
      ["unreadable", async (dir) => chmod(join(dir, "app.js"), 0o000)],
      ["dangling", async (dir) => {
        await rm(join(dir, "app.js"));
        await symlink(join(dir, "missing.js"), join(dir, "app.js"));
      }],
    ];
    for (const [label, breakIt] of cases) {
      const sourceDir = join(root, `src-web-${label}`);
      await writeTree(sourceDir, { "index.html": "new\n", "app.js": "new\n" });
      await breakIt(sourceDir);

      const error = await refusal(syncWebAssets({ sourceDir, targetDir }));
      expect(error.code, label).toBe("sync_failed");
      expect(error.restored).toBe(true);
      expect(await readFile(join(targetDir, "app.js"), "utf8")).toBe("old\n");
      // The staging directory is gone: a second attempt must not inherit it.
      expect((await readdir(root)).filter((name) => /^web\.(next|prev)-/.test(name)), label).toEqual([]);
    }
  });
});

describe("rebuildWebAssets", () => {
  /**
   * A workspace tree and an execution tree, small enough to build for real.
   *
   * The build script is the repository's own, copied in, because the route runs
   * the workspace's script and not a second implementation; `node_modules` is a
   * link to this repository's install, which is where `esbuild` comes from. The
   * served tree starts with a file the source does not have, so a test can tell
   * a replaced tree from an untouched one.
   */
  async function makeWebTree(): Promise<{ workspaceDir: string; targetDir: string }> {
    const root = await makeRoot();
    const workspaceDir = join(root, "workspace");
    const targetDir = join(root, "exec", "dist", "web");
    await writeTree(workspaceDir, {
      "src/web/index.html": "<html><body>shell</body></html>\n",
      "src/web/app.js": "console.log('shell')\n",
      "src/ui/pages/home.tsx":
        'const el = document.createElement("div");\nel.textContent = "home";\ndocument.body.append(el);\n',
    });
    await mkdir(join(workspaceDir, "scripts"), { recursive: true });
    await copyFile(join(REPO_ROOT, "scripts", "build-ui.mjs"), join(workspaceDir, "scripts", "build-ui.mjs"));
    await symlink(join(REPO_ROOT, "node_modules"), join(workspaceDir, "node_modules"), "dir");
    await writeTree(targetDir, { "index.html": "old shell\n", "stale.js": "stale\n" });
    return { workspaceDir, targetDir };
  }

  it("builds the page bundles into the tree it swaps in", async () => {
    const { workspaceDir, targetDir } = await makeWebTree();

    const result = await rebuildWebAssets({ workspaceDir, targetDir });

    // The shell, its script, the page bundle with its source map, and the
    // code-block palette the build copies out of the installed highlight.js
    // package for the pull request and diff pages.
    expect(result.copied).toBe(5);
    expect(await readFile(join(targetDir, "index.html"), "utf8")).toBe("<html><body>shell</body></html>\n");
    expect((await readdir(targetDir)).sort()).toEqual([
      "app.js",
      "index.html",
      "ui-highlight-github.css",
      "ui-home.js",
      "ui-home.js.map",
    ]);
    // The bundle is the built page and not a copy of the TSX source.
    expect(await readFile(join(targetDir, "ui-home.js"), "utf8")).toContain('.textContent="home"');
    // The whole directory was replaced, and nothing is left beside it.
    expect(await readdir(targetDir)).not.toContain("stale.js");
    expect((await readdir(dirname(targetDir))).sort()).toEqual(["web"]);
  });

  it("keeps the served tree when the pages do not build", async () => {
    const { workspaceDir, targetDir } = await makeWebTree();
    // A syntax error in a page entry: the build fails inside esbuild, which is
    // the failure the route has to survive without touching what is served.
    await writeFile(join(workspaceDir, "src/ui/pages/home.tsx"), "const broken = ;\n", "utf8");

    const error = await refusal(rebuildWebAssets({ workspaceDir, targetDir }));

    expect(error.code).toBe("build_failed");
    // Nothing was swapped, so the previous tree is still what the route serves.
    expect(error.restored).toBe(true);
    // The build really ran: its own complaint about the page is in the detail.
    expect(error.message).toContain("home.tsx");
    expect(error.message).toContain("Unexpected");
    expect((await readdir(targetDir)).sort()).toEqual(["index.html", "stale.js"]);
    expect(await readFile(join(targetDir, "index.html"), "utf8")).toBe("old shell\n");
    // Neither the build directory nor a half copy is left behind.
    expect((await readdir(dirname(targetDir))).sort()).toEqual(["web"]);
  });

  it("gives up on a build that does not finish in time", async () => {
    const { workspaceDir, targetDir } = await makeWebTree();
    // A build that never ends stands in for a hung one; the limit, not the
    // build, has to be what stops the swap.
    await writeFile(join(workspaceDir, "scripts", "build-ui.mjs"), "setTimeout(() => {}, 60_000);\n", "utf8");

    const error = await refusal(rebuildWebAssets({ workspaceDir, targetDir, timeoutMs: 250 }));

    expect(error.code).toBe("build_failed");
    expect(error.restored).toBe(true);
    expect(error.message).toContain("250");
    expect((await readdir(targetDir)).sort()).toEqual(["index.html", "stale.js"]);
    expect((await readdir(dirname(targetDir))).sort()).toEqual(["web"]);
  });

  it("refuses without the build script, and leaves the served tree alone", async () => {
    const { workspaceDir, targetDir } = await makeWebTree();
    await rm(join(workspaceDir, "scripts", "build-ui.mjs"));

    const error = await refusal(rebuildWebAssets({ workspaceDir, targetDir }));

    expect(error.code).toBe("build_failed");
    expect(error.restored).toBe(true);
    expect(error.message).toContain("build-ui.mjs");
    expect((await readdir(targetDir)).sort()).toEqual(["index.html", "stale.js"]);
    expect((await readdir(dirname(targetDir))).sort()).toEqual(["web"]);
  });

  it("refuses before building when the source is missing", async () => {
    const { workspaceDir, targetDir } = await makeWebTree();
    await rm(join(workspaceDir, "src", "web"), { recursive: true });

    const error = await refusal(rebuildWebAssets({ workspaceDir, targetDir }));

    expect(error.code).toBe("source_missing");
    expect(error.restored).toBe(true);
    expect((await readdir(targetDir)).sort()).toEqual(["index.html", "stale.js"]);
    expect((await readdir(dirname(targetDir))).sort()).toEqual(["web"]);
  });
});

describe("readCodeDrift", () => {
  function git(dir: string, args: readonly string[]): string {
    return execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  }

  async function commit(dir: string, message: string, files: Record<string, string>): Promise<string> {
    await writeTree(dir, files);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", message]);
    return git(dir, ["rev-parse", "HEAD"]).trim();
  }

  it("counts the commits ahead and lists the changed server code only", async () => {
    const root = await makeRoot();
    const workspaceDir = join(root, "workspace");
    await mkdir(workspaceDir);
    git(workspaceDir, ["init"]);
    const base = await commit(workspaceDir, "one", { "src/web/app.js": "a1\n", "docs/one.md": "d\n" });
    await commit(workspaceDir, "two", { "src/web/app.js": "a2\n", "src/server/routes/admin.ts": "s\n" });
    await commit(workspaceDir, "three", { "src/runtime/ui-assets.ts": "r\n" });

    const snapshotDir = join(root, "snapshot");
    execFileSync("git", ["clone", "--quiet", workspaceDir, snapshotDir], { stdio: "ignore" });
    git(snapshotDir, ["checkout", "--quiet", base]);

    const drift = await readCodeDrift({ workspaceDir, snapshotDir });

    expect(drift.known).toBe(true);
    expect(drift.behind).toBe(2);
    // `src/web` is what the swap itself carries, and `docs/` is not server code.
    expect(drift.codePaths).toEqual(["src/runtime/ui-assets.ts", "src/server/routes/admin.ts"]);
  });

  it("leaves page code under src/ui out of the count, because the swap builds it", async () => {
    const root = await makeRoot();
    const repo = join(root, "workspace");
    await mkdir(repo);
    git(repo, ["init"]);
    await commit(repo, "one", { "src/web/app.js": "a\n" });

    // The admin route builds `src/ui` into the tree it swaps in, so page code is
    // carried like `src/web`. `src/shared` is compiled into the server as well,
    // so it stays counted.
    await writeTree(repo, {
      "src/ui/pages/chat.tsx": "export {};\n",
      "src/server/routes/admin.ts": "s\n",
      "src/shared/ids.ts": "i\n",
    });

    const drift = await readCodeDrift({ workspaceDir: repo, snapshotDir: repo });

    expect(drift.known).toBe(true);
    expect(drift.codePaths).toEqual(["src/server/routes/admin.ts", "src/shared/ids.ts"]);
  });

  it("counts a tracked file that was edited without a commit", async () => {
    const root = await makeRoot();
    const repo = join(root, "workspace");
    await mkdir(repo);
    git(repo, ["init"]);
    await commit(repo, "one", { "src/server/routes/admin.ts": "old\n", "src/web/app.js": "a\n" });

    // The operator edits code and presses the button before committing: that is
    // what the button is for, so the edit has to be in the answer.
    await writeFile(join(repo, "src/server/routes/admin.ts"), "new\n", "utf8");
    await writeFile(join(repo, "src/web/app.js"), "b\n", "utf8");

    // The same directory stands in for both trees, so nothing comes from the
    // commit range and every path here comes from the working tree.
    const drift = await readCodeDrift({ workspaceDir: repo, snapshotDir: repo });

    expect(drift.known).toBe(true);
    expect(drift.behind).toBe(0);
    // The asset edit is on purpose not reported: the swap is what applies it.
    expect(drift.codePaths).toEqual(["src/server/routes/admin.ts"]);
  });

  it("counts a new file that git has never seen", async () => {
    const root = await makeRoot();
    const repo = join(root, "workspace");
    await mkdir(repo);
    git(repo, ["init"]);
    await commit(repo, "one", { "src/web/app.js": "a\n" });

    await writeTree(repo, { "src/extensions/new-thing.ts": "export {};\n" });
    expect(git(repo, ["status", "--porcelain", "--untracked-files=all"])).toContain("?? src/extensions/new-thing.ts");

    const drift = await readCodeDrift({ workspaceDir: repo, snapshotDir: repo });

    expect(drift.known).toBe(true);
    expect(drift.codePaths).toEqual(["src/extensions/new-thing.ts"]);
  });

  it("answers unknown when git cannot read either tree", async () => {
    const root = await makeRoot();
    expect(await readCodeDrift({ workspaceDir: root, snapshotDir: root })).toEqual({ known: false, behind: 0, codePaths: [] });
    expect(await readCodeDrift({ workspaceDir: join(root, "nope"), snapshotDir: join(root, "nope") })).toEqual({
      known: false,
      behind: 0,
      codePaths: [],
    });
  });
});
