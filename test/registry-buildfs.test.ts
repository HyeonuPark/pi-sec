import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chooseCachesToPrune,
  detectMode,
  fillBuildDir,
  isSubvolume,
  listCaches,
  lockfileHash,
  pruneCaches,
  removeBuildfs,
  snapshotToCache,
  treeSize,
  type BuildfsDeps,
  type CacheEntry,
  type RunResult,
} from "../src/registry/buildfs.ts";
import { hasUserSubvolRmAllowed, mountFor, parseMountinfo } from "../src/registry/mountinfo.ts";

/**
 * The build directory module and the mount table reader beside it.
 *
 * The table reader is pure text, so it is checked with records a kernel prints,
 * including the escape of a space inside a mount point. The build directory flow
 * runs on the file system of the temporary directory, which is a copy-mode file
 * system here, and the same flow runs again on btrfs with real subvolumes when
 * `PI_SEC_TEST_BTRFS_DIR` names a btrfs directory. Nothing waits on the clock:
 * a cache name is produced from the `createdAt` the caller passes.
 */

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function ok(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "" };
}

function failure(stderr: string): RunResult {
  return { code: 1, stdout: "", stderr };
}

const TABLE = [
  "25 1 0:23 / / rw,relatime shared:1 - overlay overlay rw,lowerdir=/a",
  "36 35 98:0 /mnt1 /mnt/with\\040space rw,noatime master:1 - ext3 /dev/root rw,errors=continue",
  "40 36 0:36 /root / rw,relatime shared:560 - btrfs /dev/nvme0n1p3 rw,seclabel,user_subvol_rm_allowed,subvol=/root",
  "41 40 0:36 / /home rw,relatime - btrfs /dev/nvme0n1p3 rw,subvol=/home",
  "not a mount record at all",
].join("\n");

// The kernel on some hosts prints the flag among the superblock options, so the
// fixture that carries the option has the shape a live btrfs record has.
const OPTION_ON_ROOT = "1 1 0:36 / / rw,relatime - btrfs /dev/x rw,seclabel,user_subvol_rm_allowed,subvol=/root\n";
const OPTION_AS_MOUNT_OPTION = "1 1 0:36 / / rw,user_subvol_rm_allowed - btrfs /dev/x rw\n";
const OPTION_ABSENT = "1 1 0:36 / / rw,relatime - btrfs /dev/x rw\n";

describe("parseMountinfo", () => {
  it("reads both option sets, the file system type, and the escapes", () => {
    const entries = parseMountinfo(TABLE);
    expect(entries).toHaveLength(4);

    const second = entries[1];
    expect(second?.mountId).toBe(36);
    expect(second?.parentId).toBe(35);
    expect(second?.majorMinor).toBe("98:0");
    expect(second?.root).toBe("/mnt1");
    expect(second?.mountPoint).toBe("/mnt/with space");
    expect(second?.options).toEqual(["rw", "noatime"]);
    expect(second?.optionalFields).toEqual(["master:1"]);
    expect(second?.fsType).toBe("ext3");
    expect(second?.source).toBe("/dev/root");
    expect(second?.superOptions).toEqual(["rw", "errors=continue"]);
  });

  it("keeps the superblock options apart from the mount options", () => {
    const root = parseMountinfo(TABLE)[2];
    expect(root?.fsType).toBe("btrfs");
    expect(root?.options).toEqual(["rw", "relatime"]);
    expect(root?.superOptions).toContain("user_subvol_rm_allowed");
    expect(root?.superOptions).toContain("subvol=/root");
    expect(root?.optionalFields).toEqual(["shared:560"]);
  });

  it("resolves an escaped backslash and skips a line it cannot read", () => {
    const entries = parseMountinfo("7 1 8:1 / /mnt/back\\134slash rw - tmpfs tmpfs rw\n");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.mountPoint).toBe("/mnt/back\\slash");
  });
});

describe("mountFor", () => {
  const entries = parseMountinfo(
    [
      "1 1 0:1 / / rw - tmpfs tmpfs rw",
      "2 1 0:2 / /a/b rw - tmpfs tmpfs rw",
      "3 1 0:3 / /a/bc/d rw - tmpfs tmpfs rw",
    ].join("\n"),
  );

  it("takes the longest mount point that covers the path", () => {
    expect(mountFor(entries, "/a/b/c")?.mountPoint).toBe("/a/b");
    expect(mountFor(entries, "/a/b/c/d/e")?.mountPoint).toBe("/a/b");
    expect(mountFor(entries, "/a/bc/d/e")?.mountPoint).toBe("/a/bc/d");
  });

  it("does not treat a bare prefix as a mount boundary", () => {
    // `/a/b` is not a prefix of `/a/bc`, so the root mount owns that path.
    expect(mountFor(entries, "/a/bc")?.mountPoint).toBe("/");
    expect(mountFor(entries, "/a/bc/x")?.mountPoint).toBe("/");
  });

  it("ignores a trailing slash and refuses a relative path", () => {
    expect(mountFor(entries, "/a/b/")?.mountPoint).toBe("/a/b");
    expect(() => mountFor(entries, "a/b")).toThrow(/absolute/u);
  });

  it("answers undefined when nothing covers the path", () => {
    expect(mountFor(parseMountinfo("1 1 0:1 / /a x - tmpfs tmpfs rw"), "/b")).toBeUndefined();
  });
});

describe("hasUserSubvolRmAllowed", () => {
  it("reads the option from the mount that owns the path", () => {
    expect(hasUserSubvolRmAllowed("/srv/user/repo", TABLE)).toBe(true);
    expect(hasUserSubvolRmAllowed("/", TABLE)).toBe(true);
  });

  it("also reads the flag from the per-mount options", () => {
    expect(hasUserSubvolRmAllowed("/srv/repo", OPTION_AS_MOUNT_OPTION)).toBe(true);
  });

  it("is false when the owning mount does not carry the option", () => {
    expect(hasUserSubvolRmAllowed("/srv/user/repo", OPTION_ABSENT)).toBe(false);
    expect(hasUserSubvolRmAllowed("/home/user/repo", TABLE)).toBe(false);
    expect(hasUserSubvolRmAllowed("/mnt/with space/x", TABLE)).toBe(false);
  });

  it("falls back to the live table when no text is given", () => {
    expect(typeof hasUserSubvolRmAllowed("/")).toBe("boolean");
  });
});

describe("detectMode", () => {
  it("returns a configured mode without touching the file system", async () => {
    let calls = 0;
    const deps: BuildfsDeps = {
      run: async () => {
        calls += 1;
        return ok();
      },
    };
    expect(await detectMode("/does/not/exist", "subvolume", deps)).toBe("subvolume");
    expect(await detectMode("/does/not/exist", "copy", deps)).toBe("copy");
    expect(await detectMode("/does/not/exist", "none", deps)).toBe("none");
    expect(calls).toBe(0);
  });

  it("falls back to copy on a file system that is not btrfs", async () => {
    expect(await detectMode(tmpdir(), "auto")).toBe("copy");
  });

  it("answers copy when the probe parent cannot be read", async () => {
    expect(await detectMode(join(tmpdir(), "buildfs-absent-parent"), "auto")).toBe("copy");
  });
});

describe("cache naming and listing", () => {
  it("uses the UTC stamp of createdAt and suffixes a second cache in the same second", async () => {
    const root = tempRoot("buildfs-name");
    const source = join(root, "node_modules");
    mkdirSync(source);
    writeFileSync(join(source, "f"), "v1\n");
    const cacheParent = join(root, "caches");
    const meta = {
      repo: "local/demo",
      buildDir: "node_modules",
      sourceWorktree: "/worktrees/demo",
      lockfileHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const first = await snapshotToCache({ mode: "copy", source, cacheParent, meta });
    const second = await snapshotToCache({ mode: "copy", source, cacheParent, meta });

    expect(first.name).toBe("20260101T000000Z");
    expect(second.name).toBe("20260101T000000Z-2");
    expect(first.readOnly).toBe(false);
    expect(first.meta?.lockfileHash).toBe("hash");
    expect(JSON.parse(readFileSync(join(first.path, "pi-sec-cache.json"), "utf8"))).toEqual(meta);

    const listed = await listCaches(cacheParent);
    expect(listed.map((entry) => entry.name)).toEqual(["20260101T000000Z-2", "20260101T000000Z"]);
  });

  it("returns an empty list for a parent that does not exist", async () => {
    expect(await listCaches(join(tempRoot("buildfs-empty"), "missing"))).toEqual([]);
  });

  it("leaves a cache without readable meta as an entry without meta", async () => {
    const root = tempRoot("buildfs-broken");
    const cacheParent = join(root, "caches");
    mkdirSync(join(cacheParent, "20260101T000000Z"), { recursive: true });
    writeFileSync(join(cacheParent, "20260101T000000Z", "pi-sec-cache.json"), "{ broken");
    const listed = await listCaches(cacheParent);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.meta).toBeUndefined();
    expect(listed[0]?.readOnly).toBe(false);
    expect(Number.isNaN(Date.parse(listed[0]?.createdAt ?? ""))).toBe(false);
  });
});

describe("chooseCachesToPrune", () => {
  const entry = (name: string, createdAt: string): CacheEntry => ({ path: `/caches/${name}`, name, createdAt, readOnly: false });

  it("keeps the newest entries and returns the rest", () => {
    const entries = [
      entry("20260101T000000Z", "2026-01-01T00:00:00.000Z"),
      entry("20260103T000000Z", "2026-01-03T00:00:00.000Z"),
      entry("20260102T000000Z", "2026-01-02T00:00:00.000Z"),
    ];
    expect(chooseCachesToPrune(entries, 2).map((item) => item.name)).toEqual(["20260101T000000Z"]);
    expect(chooseCachesToPrune(entries, 0)).toHaveLength(3);
    expect(chooseCachesToPrune(entries, 5)).toEqual([]);
  });

  it("breaks a tie on the same second by the later name", () => {
    const entries = [
      entry("20260101T000000Z", "2026-01-01T00:00:00.000Z"),
      entry("20260101T000000Z-2", "2026-01-01T00:00:00.000Z"),
    ];
    expect(chooseCachesToPrune(entries, 1).map((item) => item.name)).toEqual(["20260101T000000Z"]);
  });
});

describe("lockfileHash", () => {
  it("hashes the file bytes and changes with them", () => {
    const root = tempRoot("buildfs-hash");
    const lock = join(root, "package-lock.json");
    writeFileSync(lock, '{"lockfileVersion": 3}\n');
    const first = lockfileHash(lock);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    writeFileSync(lock, '{"lockfileVersion": 3, "name": "x"}\n');
    expect(lockfileHash(lock)).not.toBe(first);
  });
});

describe("fillBuildDir on a copy-mode file system", () => {
  it("installs, caches, refills from the cache, and keeps the copies independent", async () => {
    const root = tempRoot("buildfs-flow");
    const worktree = join(root, "worktrees", "demo");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "package-lock.json"), '{"lockfileVersion": 3}\n');
    const hash = lockfileHash(join(worktree, "package-lock.json"));
    const cacheParent = join(root, "buildfs", "local", "demo", "node_modules");
    const install = ["sh", "-c", "mkdir -p node_modules/pkg && echo v1 > node_modules/pkg/f"];
    const target = join(worktree, "node_modules");

    const first = await fillBuildDir({ mode: "copy", target, cacheParent, lockHash: hash, install, cwd: worktree });
    expect(first.installed).toBe(true);
    expect(first.filledFrom).toBeUndefined();
    expect(first.mode).toBe("copy");
    expect(readFileSync(join(target, "pkg", "f"), "utf8")).toBe("v1\n");

    const cache = await snapshotToCache({
      mode: "copy",
      source: target,
      cacheParent,
      meta: { repo: "local/demo", buildDir: "node_modules", sourceWorktree: worktree, lockfileHash: hash },
    });
    expect(cache.readOnly).toBe(false);
    expect(cache.meta?.createdAt).toBe(cache.createdAt);

    const second = join(root, "worktrees", "demo-two");
    mkdirSync(second);
    const target2 = join(second, "node_modules");
    const refilled = await fillBuildDir({ mode: "copy", target: target2, cacheParent, lockHash: hash, install, cwd: second });
    expect(refilled.installed).toBe(false);
    expect(refilled.filledFrom).toBe(cache.path);
    expect(readFileSync(join(target2, "pkg", "f"), "utf8")).toBe("v1\n");
    expect(existsSync(join(target2, "pi-sec-cache.json"))).toBe(true);

    // One worktree's edit and delete must not reach the other worktree or the cache.
    writeFileSync(join(target2, "pkg", "f"), "changed\n");
    rmSync(join(target2, "pkg", "f"));
    expect(readFileSync(join(target, "pkg", "f"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(cache.path, "pkg", "f"), "utf8")).toBe("v1\n");
  });

  it("installs again when the lockfile hash does not match the newest cache", async () => {
    const root = tempRoot("buildfs-mismatch");
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    const cacheParent = join(root, "caches");
    const install = ["sh", "-c", "mkdir -p node_modules/pkg && echo v2 > node_modules/pkg/f"];
    const first = await fillBuildDir({ mode: "copy", target: join(worktree, "node_modules"), cacheParent, lockHash: "old", install, cwd: worktree });
    expect(first.installed).toBe(true);
    await snapshotToCache({
      mode: "copy",
      source: join(worktree, "node_modules"),
      cacheParent,
      meta: { repo: "local/demo", buildDir: "node_modules", sourceWorktree: worktree, lockfileHash: "old" },
    });

    const second = join(root, "worktree-two");
    mkdirSync(second);
    const filled = await fillBuildDir({ mode: "copy", target: join(second, "node_modules"), cacheParent, lockHash: "new", install, cwd: second });
    expect(filled.installed).toBe(true);
    expect(filled.filledFrom).toBeUndefined();
  });

  it("makes an empty directory in none mode and never reads the caches", async () => {
    const root = tempRoot("buildfs-none");
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    const target = join(worktree, "node_modules");
    const result = await fillBuildDir({ mode: "none", target, cacheParent: join(root, "caches"), lockHash: "x", cwd: worktree });
    expect(result).toEqual({ installed: false, mode: "none" });
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses a target that already exists", async () => {
    const root = tempRoot("buildfs-exists");
    mkdirSync(join(root, "node_modules"));
    await expect(fillBuildDir({ mode: "copy", target: join(root, "node_modules"), cacheParent: join(root, "c"), cwd: root })).rejects.toThrow(/already exists/u);
  });

  it("reports the install failure with the command's stderr", async () => {
    const root = tempRoot("buildfs-install-fail");
    const target = join(root, "node_modules");
    await expect(
      fillBuildDir({ mode: "copy", target, cacheParent: join(root, "c"), install: ["sh", "-c", "echo boom >&2; exit 3"], cwd: root }),
    ).rejects.toThrow(/boom/u);
    expect(existsSync(target)).toBe(false);
  });
});

describe("removeBuildfs path checks", () => {
  it("reports a missing path without running anything", async () => {
    const root = tempRoot("buildfs-missing");
    const deps: BuildfsDeps = {
      run: async () => {
        throw new Error("a missing path must not run a command");
      },
    };
    expect(await removeBuildfs(join(root, "absent"), { allowedRoot: root, mode: "copy" }, deps)).toEqual({
      removed: false,
      method: "none",
      reason: "missing",
    });
  });

  it("refuses a path outside the allowed root, the root itself, and a symlink that leaves it", async () => {
    const root = tempRoot("buildfs-root");
    const allowed = join(root, "allowed");
    mkdirSync(join(allowed, "cache"), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);

    const escaped = await removeBuildfs(outside, { allowedRoot: allowed, mode: "copy" });
    expect(escaped.removed).toBe(false);
    expect(escaped.reason).toMatch(/outside/u);

    const itself = await removeBuildfs(allowed, { allowedRoot: allowed, mode: "copy" });
    expect(itself.removed).toBe(false);
    expect(itself.reason).toMatch(/allowed root/u);

    mkdirSync(join(outside, "real"));
    const link = join(allowed, "link");
    execFileSync("ln", ["-s", join(outside, "real"), link]);
    const linked = await removeBuildfs(link, { allowedRoot: allowed, mode: "copy" });
    expect(linked.removed).toBe(false);
    expect(linked.reason).toMatch(/outside/u);
    expect(existsSync(join(outside, "real"))).toBe(true);
  });

  it("refuses a plain directory when the mode says subvolumes", async () => {
    const root = tempRoot("buildfs-plain");
    const cache = join(root, "cache");
    mkdirSync(cache);
    const result = await removeBuildfs(cache, { allowedRoot: root, mode: "subvolume" });
    expect(result.removed).toBe(false);
    expect(result.method).toBe("none");
    expect(result.reason).toMatch(/not a subvolume/u);
    expect(existsSync(cache)).toBe(true);
  });

  it("removes a plain directory tree in copy mode", async () => {
    const root = tempRoot("buildfs-rm");
    const cache = join(root, "cache");
    mkdirSync(join(cache, "deep"), { recursive: true });
    writeFileSync(join(cache, "deep", "f"), "x");
    const result = await removeBuildfs(cache, { allowedRoot: root, mode: "copy" });
    expect(result).toEqual({ removed: true, method: "rm" });
    expect(existsSync(cache)).toBe(false);
  });
});

describe("pruneCaches", () => {
  it("removes everything after the newest keep", async () => {
    const root = tempRoot("buildfs-prune");
    const source = join(root, "node_modules");
    mkdirSync(source);
    writeFileSync(join(source, "f"), "x");
    const cacheParent = join(root, "caches");
    const base = { repo: "local/demo", buildDir: "node_modules", sourceWorktree: "/w", lockfileHash: "h" };
    const old = await snapshotToCache({ mode: "copy", source, cacheParent, meta: { ...base, createdAt: "2026-01-01T00:00:00.000Z" } });
    const middle = await snapshotToCache({ mode: "copy", source, cacheParent, meta: { ...base, createdAt: "2026-01-02T00:00:00.000Z" } });
    const newest = await snapshotToCache({ mode: "copy", source, cacheParent, meta: { ...base, createdAt: "2026-01-03T00:00:00.000Z" } });

    const removed = await pruneCaches(cacheParent, 2, { allowedRoot: root, mode: "copy" });
    expect(removed).toEqual([old.path]);
    expect(existsSync(middle.path)).toBe(true);
    expect(existsSync(newest.path)).toBe(true);

    const again = await pruneCaches(cacheParent, 2, { allowedRoot: root, mode: "copy" });
    expect(again).toEqual([]);
  });
});

describe("treeSize", () => {
  it("sums allocated blocks, counts a hard link once, and does not follow a symlink", async () => {
    const root = tempRoot("buildfs-size");
    const tree = join(root, "tree");
    mkdirSync(tree);
    const bytes = Buffer.alloc(128 * 1024, 1);
    writeFileSync(join(tree, "f"), bytes);
    const before = await treeSize(tree);
    expect(before).toBeGreaterThan(0);

    execFileSync("ln", [join(tree, "f"), join(tree, "f2")]);
    expect(await treeSize(tree)).toBe(before);

    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "big"), bytes);
    const linked = join(root, "linked");
    mkdirSync(linked);
    execFileSync("ln", ["-s", join(outside, "big"), join(linked, "big")]);
    expect(await treeSize(linked)).toBeLessThan(await treeSize(outside));

    expect(await treeSize(join(root, "absent"))).toBe(0);
  });
});

/**
 * The btrfs half. It runs only when PI_SEC_TEST_BTRFS_DIR names a btrfs
 * directory, because a subvolume cannot be faked: the inode number of its root is
 * what marks it, and only btrfs hands out that number. The commands run for real
 * and the temporary tree is removed at the end, read-only caches first.
 */
const btrfsRoot = process.env["PI_SEC_TEST_BTRFS_DIR"] ?? "";
const BTRFS_SUPER_MAGIC = 2435016766;
const btrfsAvailable = ((): boolean => {
  if (btrfsRoot === "") return false;
  try {
    return statfsSync(btrfsRoot).type === BTRFS_SUPER_MAGIC;
  } catch {
    return false;
  }
})();

function realRun(cmd: string, args: string[], opts?: { cwd?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      const text = typeof stderr === "string" ? stderr : "";
      resolve({
        code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 126,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: text === "" ? error.message : text,
      });
    });
  });
}

function deleteSubvolumes(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    if (isSubvolume(path)) {
      deleteSubvolumes(path);
      try {
        execFileSync("btrfs", ["property", "set", path, "ro", "false"], { stdio: "ignore" });
      } catch {
        // Already writable, or the delete below reports it.
      }
      try {
        execFileSync("btrfs", ["subvolume", "delete", path], { stdio: "ignore" });
      } catch {
        // The assertion that created this tree reports a failed delete.
      }
      continue;
    }
    try {
      if (lstatSync(path).isDirectory()) deleteSubvolumes(path);
    } catch {
      // Gone during the walk.
    }
  }
}

describe.skipIf(!btrfsAvailable)("buildfs on btrfs", () => {
  let root = "";

  beforeAll(() => {
    mkdirSync(btrfsRoot, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(btrfsRoot, "buildfs-run-"));
  });

  afterAll(() => {
    if (root === "") return;
    deleteSubvolumes(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("detects subvolume mode by creating and deleting a probe", async () => {
    expect(await detectMode(root, "auto")).toBe("subvolume");
    expect(readdirSync(root)).toEqual([]);
  });

  it("fills a subvolume, snapshots it into a read-only cache, and fills a second worktree from it", async () => {
    const worktree = join(root, "worktrees", "one");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "package-lock.json"), '{"lockfileVersion": 3}\n');
    const hash = lockfileHash(join(worktree, "package-lock.json"));
    const cacheParent = join(root, "buildfs", "local", "demo", "node_modules");
    const install = ["sh", "-c", "mkdir -p node_modules/pkg && echo v1 > node_modules/pkg/f"];
    const target = join(worktree, "node_modules");

    const first = await fillBuildDir({ mode: "subvolume", target, cacheParent, lockHash: hash, install, cwd: worktree });
    expect(first.installed).toBe(true);
    expect(isSubvolume(target)).toBe(true);
    writeFileSync(join(target, "pkg", "extra"), "x");

    const cache = await snapshotToCache({
      mode: "subvolume",
      source: target,
      cacheParent,
      meta: { repo: "local/demo", buildDir: "node_modules", sourceWorktree: worktree, lockfileHash: hash, createdAt: "2026-01-02T03:04:05.000Z" },
    });
    expect(cache.name).toBe("20260102T030405Z");
    expect(cache.readOnly).toBe(true);
    expect(isSubvolume(cache.path)).toBe(true);

    const listed = await listCaches(cacheParent);
    expect(listed[0]?.readOnly).toBe(true);
    expect(listed[0]?.meta?.lockfileHash).toBe(hash);

    const second = join(root, "worktrees", "two");
    mkdirSync(second);
    const target2 = join(second, "node_modules");
    const refilled = await fillBuildDir({ mode: "subvolume", target: target2, cacheParent, lockHash: hash, install, cwd: second });
    expect(refilled.installed).toBe(false);
    expect(refilled.filledFrom).toBe(cache.path);
    expect(isSubvolume(target2)).toBe(true);

    // The snapshot of a read-only cache is writable, and the copies stay apart.
    writeFileSync(join(target2, "pkg", "f"), "changed\n");
    expect(readFileSync(join(target2, "pkg", "f"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(target, "pkg", "f"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(cache.path, "pkg", "f"), "utf8")).toBe("v1\n");

    const removed = await removeBuildfs(cache.path, { allowedRoot: cacheParent, mode: "subvolume" });
    expect(removed).toEqual({ removed: true, method: "subvolume-delete" });
    expect(existsSync(cache.path)).toBe(false);
  });

  it("leaves no subvolume behind when the install fails", async () => {
    const worktree = join(root, "failed", "worktree");
    mkdirSync(worktree, { recursive: true });
    const target = join(worktree, "node_modules");
    await expect(
      fillBuildDir({
        mode: "subvolume",
        target,
        cacheParent: join(root, "failed", "caches"),
        install: ["sh", "-c", "echo boom >&2; exit 4"],
        cwd: worktree,
      }),
    ).rejects.toThrow(/boom/u);
    expect(existsSync(target)).toBe(false);
    expect(isSubvolume(target)).toBe(false);
  });

  it("refuses a subvolume that holds another subvolume", async () => {
    const parent = join(root, "nested", "parent");
    mkdirSync(join(root, "nested"));
    await realRun("btrfs", ["subvolume", "create", parent]);
    await realRun("btrfs", ["subvolume", "create", join(parent, "child")]);

    const deps: BuildfsDeps = { mountinfo: () => OPTION_ON_ROOT };
    const result = await removeBuildfs(parent, { allowedRoot: join(root, "nested"), mode: "subvolume" }, deps);
    expect(result.removed).toBe(false);
    expect(result.method).toBe("none");
    expect(result.reason).toMatch(/another subvolume/u);
    expect(isSubvolume(parent)).toBe(true);
  });

  it("empties and removes a subvolume when the mount does not allow the delete", async () => {
    const parent = join(root, "fallback");
    const cache = join(parent, "cache");
    mkdirSync(parent);
    await realRun("btrfs", ["subvolume", "create", cache]);
    writeFileSync(join(cache, "f"), "x");
    await realRun("btrfs", ["property", "set", cache, "ro", "true"]);
    expect(isSubvolume(cache)).toBe(true);

    const deps: BuildfsDeps = { mountinfo: () => OPTION_ABSENT };
    const result = await removeBuildfs(cache, { allowedRoot: parent, mode: "subvolume" }, deps);
    expect(result).toEqual({ removed: true, method: "rm-rmdir" });
    expect(existsSync(cache)).toBe(false);
  });

  it("empties and removes a subvolume when the delete ends in a permission error", async () => {
    const parent = join(root, "denied");
    const cache = join(parent, "cache");
    mkdirSync(parent);
    await realRun("btrfs", ["subvolume", "create", cache]);
    writeFileSync(join(cache, "f"), "x");

    const deps: BuildfsDeps = {
      mountinfo: () => OPTION_ON_ROOT,
      run: async (cmd, args, opts) => {
        if (cmd === "btrfs" && args[0] === "subvolume" && args[1] === "delete") {
          return failure("ERROR: cannot delete: Operation not permitted");
        }
        return realRun(cmd, args, opts);
      },
    };
    const result = await removeBuildfs(cache, { allowedRoot: parent, mode: "subvolume" }, deps);
    expect(result).toEqual({ removed: true, method: "rm-rmdir" });
    expect(existsSync(cache)).toBe(false);
  });

  it("prunes a read-only cache on btrfs", async () => {
    const source = join(root, "prune-source");
    const cacheParent = join(root, "prune-caches");
    await realRun("btrfs", ["subvolume", "create", source]);
    writeFileSync(join(source, "f"), "x");
    const base = { repo: "local/demo", buildDir: "node_modules", sourceWorktree: source, lockfileHash: "h" };
    const old = await snapshotToCache({ mode: "subvolume", source, cacheParent, meta: { ...base, createdAt: "2026-01-01T00:00:00.000Z" } });
    const newest = await snapshotToCache({ mode: "subvolume", source, cacheParent, meta: { ...base, createdAt: "2026-01-02T00:00:00.000Z" } });
    expect(old.readOnly).toBe(true);

    const removed = await pruneCaches(cacheParent, 1, { allowedRoot: cacheParent, mode: "subvolume" });
    expect(removed).toEqual([old.path]);
    expect(isSubvolume(newest.path)).toBe(true);
  });
});
