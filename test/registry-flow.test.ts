/**
 * The registry end to end: register a repository, cut worktrees from it, fill
 * their build directories from a cache, refresh and prune the cache, list and
 * check what is there, and move `main` forward.
 *
 * Everything below runs real git and real file systems, because the parts that
 * are worth testing here are the ones where git has an opinion: a worktree on an
 * unborn branch, a folder with untracked files that git refuses to remove, a hook
 * that must let a commit through and refuse a moved `main`, and a merge that must
 * be a fast-forward. A test that answered from a fake would pass while git
 * refused.
 *
 * The installed build directory is never produced by npm. Each registry root here
 * carries a small shell script that plays the part of an install: it copies the
 * lockfile into `node_modules/.package-lock.json`, the marker npm writes, and
 * writes two files. Install times are set with `utimesSync`, so nothing waits on
 * the clock.
 *
 * The second half of the file needs a btrfs directory in `PI_SEC_TEST_BTRFS_DIR`
 * and is skipped without one, because a subvolume cannot be faked: the inode
 * number of its root is what marks it, and only btrfs hands out that number.
 */

import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isSubvolume, listCaches, lockfileHash, type RunResult } from "../src/registry/buildfs.ts";
import {
  bareRepoDir,
  cacheParent,
  inPlaceRecordPath,
  registryPaths,
  worktreeDir,
  type RegistrySettings,
} from "../src/registry/layout.ts";
import {
  doctorRegistry,
  listRegistry,
  registerInPlace,
  registerRepo,
  resolveRepo,
  showRepo,
  type RegistryListing,
} from "../src/registry/store.ts";
import { addWorktree, fastForward, refillBuildfs, removeWorktree } from "../src/registry/worktree.ts";
import {
  BuildfsRefresher,
  pruneAll,
  refreshCaches,
  type BuildfsRefresherTimers,
  type RefreshEntry,
} from "../src/registry/refresh.ts";

/**
 * The git settings every call runs with: no operator configuration, and an
 * identity so that a commit can be made.
 */
const GIT_VARIABLES = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "pi-sec test",
  GIT_AUTHOR_EMAIL: "pi-sec@localhost",
  GIT_COMMITTER_NAME: "pi-sec test",
  GIT_COMMITTER_EMAIL: "pi-sec@localhost",
} as const;

const SAVED_GIT_VARIABLES = new Map<string, string | undefined>(
  Object.keys(GIT_VARIABLES).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, GIT_VARIABLES);

afterAll(() => {
  for (const [name, value] of SAVED_GIT_VARIABLES) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run one git command, and report its exit status whatever it is. */
function git(cwd: string, args: readonly string[]): GitRun {
  const result = spawnSync("git", [...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run one git command that must succeed. */
function gitOk(cwd: string, args: readonly string[]): GitRun {
  const run = git(cwd, args);
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${run.status}): ${run.stderr.trim()}`);
  }
  return run;
}

/** A fresh folder under the file system's temporary directory. */
function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** The install script, written into each root so no test names a local path. */
const INSTALL_SCRIPT = `#!/bin/sh
set -e
mkdir -p node_modules/pkg
cp package-lock.json node_modules/.package-lock.json
printf '%s\\n' "$1" > node_modules/pkg/value
printf 'extra\\n' > node_modules/pkg/extra
printf '%s\\n' "$PWD" >> "$2"
`;

/**
 * The settings of one registry root, with a fake install for `node_modules`.
 *
 * The install command is argv style: `sh <script> <version> <log>`, run in the
 * worktree, which is why the script finds its lockfile in the current folder.
 */
function settingsFor(root: string, overrides: Partial<RegistrySettings> = {}): RegistrySettings {
  const script = join(root, "install.sh");
  if (!existsSync(script)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  }
  return {
    root,
    cacheKeep: 2,
    refreshHours: 24,
    mode: "copy",
    buildDirs: [{ dir: "node_modules", lockfile: "package-lock.json", install: ["sh", script, "v1", join(root, "installs.log")] }],
    ...overrides,
  };
}

/** A lockfile whose single package is `node_modules/pkg` at one version. */
function writeLockfile(dir: string, version: string): void {
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "demo",
        version,
        lockfileVersion: 3,
        packages: {
          "": { name: "demo", version },
          "node_modules/pkg": { version: "1.0.0" },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** A plain repository with one commit that it pushes to a bare repository. */
function seedRepo(bare: string, work: string, version: string): string {
  mkdirSync(work, { recursive: true, mode: 0o700 });
  gitOk(work, ["init", "-b", "main"]);
  writeFileSync(join(work, ".gitignore"), "node_modules/\ndist/\n");
  writeLockfile(work, version);
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-m", "seed"]);
  gitOk(work, ["push", bare, "main"]);
  return gitOk(work, ["rev-parse", "HEAD"]).stdout.trim();
}

/** The worktrees the fake install ran in, newest last. */
function installsIn(root: string): string[] {
  try {
    return readFileSync(join(root, "installs.log"), "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** The entry of one refresh run, or a failure that names what was missing. */
function entryOf(entries: readonly RefreshEntry[], repo: string, buildDir: string): RefreshEntry {
  const entry = entries.find((item) => item.repo === repo && item.buildDir === buildDir);
  if (entry === undefined) throw new Error(`no entry for ${repo} ${buildDir}: ${JSON.stringify(entries)}`);
  return entry;
}

/** One worktree of a listing, by path. */
function worktreeOf(listing: RegistryListing, path: string) {
  const entry = listing.worktrees.find((item) => item.path === path);
  if (entry === undefined) throw new Error(`no worktree ${path} in ${JSON.stringify(listing.worktrees)}`);
  return entry;
}

// `git worktree add --orphan` is newer than some git packages. The probe asks git
// for its usage text, so it follows the ability and not a version number.
const orphanWorktreeSupported = ((): boolean => {
  const help = spawnSync("git", ["worktree", "add", "-h"], { encoding: "utf8" });
  return `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("--orphan");
})();

const JOB_ID = "20261103-01M6EF23H50000000000005RPQ";
const WORKTREE_A = "20261103-01m6ef23h50000000000005rpq-a";

describe("the registry flow on a temporary directory", () => {
  let root = "";
  let settings: RegistrySettings;
  let bare = "";
  let seed = "";
  let a: Awaited<ReturnType<typeof addWorktree>>;
  let b: Awaited<ReturnType<typeof addWorktree>>;
  let firstCache = "";

  beforeAll(() => {
    root = tempRoot("registry-flow");
    settings = settingsFor(root);
    seed = join(root, "seed");
  });

  afterAll(() => {
    if (root === "") return;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("makes the owner folder before it writes an in-place record", async () => {
    // A root of its own, because a fresh registry root has `repos` but no
    // `repos/<owner>`: a test that ran after a bare registration would find the
    // folder already there and would pass while the in-place path still failed.
    const fresh = tempRoot("registry-inplace");
    try {
      const plain = join(fresh, "plain");
      gitOk(fresh, ["init", "-b", "main", plain]);
      writeFileSync(join(plain, "a.txt"), "a\n");
      gitOk(plain, ["add", "a.txt"]);
      gitOk(plain, ["commit", "-m", "one"]);

      const ref = await registerInPlace(settingsFor(fresh), join(plain, ".git"), "solo");
      expect(ref).toEqual({ id: "local/solo", gitDir: join(plain, ".git"), inPlace: true });

      const record = inPlaceRecordPath(fresh, "local/solo");
      expect(existsSync(record)).toBe(true);
      expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ gitDir: join(plain, ".git") });
      expect(statSync(join(fresh, "repos", "local")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(fresh, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("registers a bare repository and installs the protection hook", async () => {
    const ref = await registerRepo(settings, "Local/Demo");
    expect(ref.id).toBe("local/demo");
    expect(ref.inPlace).toBe(false);
    bare = bareRepoDir(root, "local/demo");
    expect(ref.gitDir).toBe(bare);

    expect(statSync(bare).isDirectory()).toBe(true);
    expect(gitOk(root, ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"]).stdout.trim()).toBe("main");

    const hookFile = join(bare, "hooks", "reference-transaction");
    expect(existsSync(hookFile)).toBe(true);
    expect(statSync(hookFile).mode & 0o111).not.toBe(0);
    expect(gitOk(root, ["--git-dir", bare, "config", "--get", "pi-sec.registryRoot"]).stdout.trim()).toBe(root);

    const resolved = await resolveRepo(settings, "local/demo");
    expect(resolved).toEqual({ id: "local/demo", gitDir: bare, inPlace: false });
  });

  it("refuses to register the same name twice", async () => {
    await expect(registerRepo(settings, "local/demo")).rejects.toThrow(/already registered/);
  });

  it.skipIf(!orphanWorktreeSupported)("adds a worktree with --orphan while the repository has no commit", async () => {
    const added = await addWorktree(settings, "local/demo", "empty-one");
    expect(added.repo).toBe("local/demo");
    expect(added.path).toBe(worktreeDir(root, "local/demo", "empty-one"));
    expect(added.branch).toBe("wt/empty-one");
    expect(added.mode).toBe("copy");
    expect(added.buildDirs).toEqual([]);
    expect(git(root, ["-C", added.path, "rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    expect(gitOk(root, ["--git-dir", bare, "worktree", "list", "--porcelain"]).stdout).toContain(added.path);

    // The name is checked before anything is created.
    await expect(addWorktree(settings, "local/demo", "Not A Name")).rejects.toThrow(/invalid worktree name/);
    await expect(addWorktree(settings, "local/demo", "empty-one")).rejects.toThrow(/already exists/);
  });

  it.skipIf(!orphanWorktreeSupported)("removes that empty worktree", async () => {
    const removed = await removeWorktree(settings, "local/demo", "empty-one");
    expect(removed.buildDirs).toEqual([]);
    expect(existsSync(removed.path)).toBe(false);
    expect(gitOk(root, ["--git-dir", bare, "worktree", "list", "--porcelain"]).stdout).not.toContain(removed.path);
    // The branch of an orphan worktree has no ref until a commit is made in it,
    // so the name is free again and a second worktree may take it.
    const again = await addWorktree(settings, "local/demo", "empty-one");
    expect(again.branch).toBe("wt/empty-one");
    await removeWorktree(settings, "local/demo", "empty-one");
  });

  it("takes the seed commit on main through the hook", () => {
    const sha = seedRepo(bare, seed, "1.0.0");
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(gitOk(root, ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/main"]).stdout.trim()).toBe(sha);
    gitOk(root, ["--git-dir", bare, "remote", "add", "origin", "https://example.invalid/demo.git"]);
  });

  it("adds a worktree and installs its build directory", async () => {
    a = await addWorktree(settings, "local/demo", WORKTREE_A);
    expect(a.branch).toBe(`wt/${WORKTREE_A}`);
    expect(a.buildDirs).toEqual([{ dir: "node_modules", filledFrom: null, installed: true }]);
    expect(readFileSync(join(a.path, "node_modules", "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(a.path, "node_modules", ".package-lock.json"))).toBe(true);
    expect(installsIn(root)).toEqual([a.path]);
  });

  it("lets a commit through in the worktree and refuses a moved main", () => {
    writeFileSync(join(a.path, "work.txt"), "hello\n");
    gitOk(a.path, ["add", "work.txt"]);
    gitOk(a.path, ["commit", "-m", "work"]);
    expect(gitOk(root, ["--git-dir", bare, "rev-parse", "refs/heads/main"]).stdout.trim()).not.toBe(
      gitOk(root, ["--git-dir", bare, "rev-parse", `refs/heads/wt/${WORKTREE_A}`]).stdout.trim(),
    );

    const moved = git(root, ["-C", a.path, "branch", "-f", "main", "HEAD"]);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain("refguard");
  });

  it("turns the newest install into a cache", async () => {
    const entries = await refreshCaches(settings);
    const entry = entryOf(entries, "local/demo", "node_modules");
    expect(entry.action).toBe("created");
    expect(entry.pruned).toEqual([]);
    expect(entry.reason).toBeUndefined();
    expect(entry.cache).toBeDefined();
    firstCache = entry.cache?.path ?? "";
    expect(existsSync(firstCache)).toBe(true);
    expect(existsSync(join(firstCache, "pi-sec-cache.json"))).toBe(true);
    expect(entry.cache?.readOnly).toBe(false);
    expect(entry.cache?.meta?.createdAt).toBe(entry.cache?.createdAt);
    expect(entry.cache?.meta?.repo).toBe("local/demo");
    expect(entry.cache?.meta?.buildDir).toBe("node_modules");
    expect(entry.cache?.meta?.sourceWorktree).toBe(a.path);
    expect(entry.cache?.meta?.lockfileHash).toBe(lockfileHash(join(a.path, "package-lock.json")));
    expect(readFileSync(join(firstCache, "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(registryPaths(root).lastRefresh)).toBe(true);
    expect(JSON.parse(readFileSync(registryPaths(root).lastRefresh, "utf8")).at).toMatch(/^\d{4}-/u);
  });

  it("fills a second worktree from the cache without an install", async () => {
    b = await addWorktree(settings, "local/demo", "b");
    expect(b.buildDirs).toEqual([{ dir: "node_modules", filledFrom: firstCache, installed: false }]);
    expect(readFileSync(join(b.path, "node_modules", "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(b.path, "node_modules", "pi-sec-cache.json"))).toBe(true);
    expect(installsIn(root)).toEqual([a.path]);

    const listing = await listRegistry(settings, { repo: "local/demo" });
    const filled = worktreeOf(listing, b.path).buildDirs[0];
    expect(filled?.dir).toBe("node_modules");
    expect(filled?.filledFrom).toBe(firstCache);
    expect(filled?.mode).toBe("copy");
  });

  it("keeps every worktree and the cache apart", () => {
    writeFileSync(join(a.path, "node_modules", "pkg", "value"), "changed in a\n");
    rmSync(join(a.path, "node_modules", "pkg", "extra"));
    writeFileSync(join(b.path, "node_modules", "pkg", "added in b"), "b\n");

    expect(readFileSync(join(b.path, "node_modules", "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(b.path, "node_modules", "pkg", "extra"))).toBe(true);
    expect(readFileSync(join(firstCache, "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(firstCache, "pkg", "extra"))).toBe(true);
    expect(existsSync(join(firstCache, "pkg", "added in b"))).toBe(false);
    expect(existsSync(join(a.path, "node_modules", "pkg", "added in b"))).toBe(false);
  });

  it("makes a new cache from the later install and prunes past the keep count", async () => {
    const marker = join(a.path, "node_modules", ".package-lock.json");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(marker, later, later);

    const second = entryOf(await refreshCaches(settings), "local/demo", "node_modules");
    expect(second.action).toBe("created");
    expect(second.pruned).toEqual([]);
    expect(second.cache?.meta?.sourceWorktree).toBe(a.path);
    expect(second.cache?.path).not.toBe(firstCache);

    utimesSync(marker, new Date(later.getTime() + 60 * 60 * 1000), new Date(later.getTime() + 60 * 60 * 1000));
    const third = entryOf(await refreshCaches(settings), "local/demo", "node_modules");
    expect(third.action).toBe("created");
    expect(third.pruned).toEqual([firstCache]);
    expect(existsSync(firstCache)).toBe(false);

    const kept = await listCaches(cacheParent(root, "local/demo", "node_modules"));
    expect(kept).toHaveLength(settings.cacheKeep);

    // An install older than the newest cache with the same lockfile is current.
    const older = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(marker, older, older);
    const current = entryOf(await refreshCaches(settings), "local/demo", "node_modules");
    expect(current.action).toBe("skipped");
    expect(current.cache).toBeUndefined();
    expect(await listCaches(cacheParent(root, "local/demo", "node_modules"))).toHaveLength(settings.cacheKeep);
  });

  it("lists repositories, worktrees and caches in the documented shape", async () => {
    // A worktree cut outside the registry, which the listing must still show.
    const outside = join(root, "outside", "one");
    gitOk(root, ["--git-dir", bare, "worktree", "add", "-b", "wt/outside", outside, "main"]);

    const listing = await listRegistry(settings, {
      jobLookup: (jobId) => (jobId === JOB_ID ? { title: "registry flow", status: "active" } : undefined),
    });
    expect(Object.keys(listing).sort()).toEqual(["caches", "mode", "repos", "root", "worktrees"]);
    expect(listing.root).toBe(root);
    expect(listing.mode).toBe("copy");

    const repo = listing.repos[0];
    expect(repo).toBeDefined();
    expect(Object.keys(repo ?? {}).sort()).toEqual([
      "defaultBranch",
      "gitDir",
      "hookInstalled",
      "id",
      "inPlace",
      "remotes",
      "sizeBytes",
    ]);
    expect(repo).toMatchObject({
      id: "local/demo",
      gitDir: bare,
      inPlace: false,
      defaultBranch: "main",
      hookInstalled: true,
      remotes: [{ name: "origin", url: "https://example.invalid/demo.git" }],
    });
    expect(repo?.sizeBytes).toBeGreaterThan(0);

    const mine = worktreeOf(listing, a.path);
    expect(Object.keys(mine).sort()).toEqual([
      "branch",
      "buildDirs",
      "createdAt",
      "dirty",
      "head",
      "jobId",
      "jobStatus",
      "jobTitle",
      "managed",
      "path",
      "repo",
      "sizeBytes",
    ]);
    expect(mine.repo).toBe("local/demo");
    expect(mine.managed).toBe(true);
    expect(mine.branch).toBe(`wt/${WORKTREE_A}`);
    expect(mine.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(mine.dirty).toBe(false);
    expect(mine.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/u);
    expect(mine.jobId).toBe(JOB_ID);
    expect(mine.jobTitle).toBe("registry flow");
    expect(mine.jobStatus).toBe("active");
    expect(mine.sizeBytes).toBeGreaterThan(0);
    expect(mine.buildDirs).toHaveLength(1);
    const buildDir = mine.buildDirs[0];
    expect(Object.keys(buildDir ?? {}).sort()).toEqual([
      "dir",
      "filledFrom",
      "installedAt",
      "lockfileHash",
      "mode",
      "sizeBytes",
    ]);
    expect(buildDir?.dir).toBe("node_modules");
    expect(buildDir?.mode).toBe("copy");
    expect(buildDir?.filledFrom).toBeNull();
    expect(buildDir?.installedAt).toMatch(/^\d{4}-/u);
    expect(buildDir?.lockfileHash).toBe(lockfileHash(join(a.path, "package-lock.json")));
    expect(buildDir?.sizeBytes).toBeGreaterThan(0);

    const second = worktreeOf(listing, b.path);
    expect(second.buildDirs[0]?.filledFrom).toBeNull();
    expect(second.jobId).toBeNull();
    expect(second.jobTitle).toBeNull();
    expect(second.jobStatus).toBeNull();

    const unmanaged = worktreeOf(listing, outside);
    expect(unmanaged.managed).toBe(false);
    expect(unmanaged.sizeBytes).toBeNull();
    expect(unmanaged.buildDirs).toEqual([]);

    expect(listing.caches).toHaveLength(settings.cacheKeep);
    const newest = listing.caches[0];
    expect(Object.keys(newest ?? {}).sort()).toEqual([
      "buildDir",
      "createdAt",
      "lockfileHash",
      "path",
      "readOnly",
      "repo",
      "sizeBytes",
      "sourceWorktree",
    ]);
    expect(newest).toMatchObject({
      repo: "local/demo",
      buildDir: "node_modules",
      sourceWorktree: a.path,
      readOnly: false,
    });
    expect(newest?.lockfileHash).toBe(lockfileHash(join(a.path, "package-lock.json")));
    expect(Date.parse(newest?.createdAt ?? "")).toBeGreaterThan(0);
    expect(newest?.sizeBytes).toBeGreaterThan(0);

    // A job store that cannot answer leaves the two job fields empty and nothing else.
    const blind = await listRegistry(settings, {
      jobLookup: () => {
        throw new Error("the job store is not open");
      },
    });
    const blindWorktree = worktreeOf(blind, a.path);
    expect(blindWorktree.jobId).toBe(JOB_ID);
    expect(blindWorktree.jobTitle).toBeNull();
    expect(blindWorktree.jobStatus).toBeNull();
    expect(blindWorktree.managed).toBe(true);
  });

  it("refuses to remove a worktree with changes and removes a clean one", async () => {
    const c = await addWorktree(settings, "local/demo", "c");
    writeFileSync(join(c.path, "scratch.txt"), "uncommitted\n");

    await expect(removeWorktree(settings, "local/demo", "c")).rejects.toThrow(/modified or untracked/);
    expect(existsSync(join(c.path, "node_modules"))).toBe(true);
    expect(existsSync(c.path)).toBe(true);

    rmSync(join(c.path, "scratch.txt"));
    // An ignored folder is not a change, and git removes the whole worktree with
    // it: this is what git 2.56 does, and the removal relies on it.
    mkdirSync(join(c.path, "dist"));
    writeFileSync(join(c.path, "dist", "out.js"), "built\n");
    expect(gitOk(c.path, ["status", "--porcelain"]).stdout).toBe("");

    const removed = await removeWorktree(settings, "local/demo", "c");
    expect(removed.buildDirs).toEqual([join(c.path, "node_modules")]);
    expect(existsSync(c.path)).toBe(false);
    expect(git(root, ["--git-dir", bare, "rev-parse", "--verify", "--quiet", "refs/heads/wt/c"]).status).toBe(0);
  });

  it("moves main forward and refuses a backward or diverged branch", async () => {
    const mainBefore = gitOk(root, ["--git-dir", bare, "rev-parse", "refs/heads/main"]).stdout.trim();
    const aHead = gitOk(root, ["--git-dir", bare, "rev-parse", `refs/heads/wt/${WORKTREE_A}`]).stdout.trim();

    const moved = await fastForward(settings, "local/demo", `wt/${WORKTREE_A}`);
    expect(moved).toEqual({ from: mainBefore, to: aHead });
    expect(gitOk(root, ["--git-dir", bare, "rev-parse", "refs/heads/main"]).stdout.trim()).toBe(aHead);

    // Backward: b still sits on the seed commit, which main has passed.
    await expect(fastForward(settings, "local/demo", "wt/b")).rejects.toThrow(/main holds commits/);

    // Diverged: a commit whose parent is the old main, made without a worktree.
    const tree = gitOk(root, ["--git-dir", bare, "rev-parse", `${mainBefore}^{tree}`]).stdout.trim();
    const made = spawnSync("git", ["--git-dir", bare, "commit-tree", tree, "-p", mainBefore, "-m", "diverged"], {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (made.status !== 0) throw new Error(`git commit-tree failed: ${made.stderr}`);
    const diverged = made.stdout.trim();
    gitOk(root, ["--git-dir", bare, "update-ref", "refs/heads/wt/diverged", diverged]);
    await expect(fastForward(settings, "local/demo", "wt/diverged")).rejects.toThrow(/main holds commits/);

    // A branch on the same commit is already there, and is not an error.
    const same = await fastForward(settings, "local/demo", "main");
    expect(same).toEqual({ from: aHead, to: aHead });
  });

  it("registers a repository in place and refuses to move its main", async () => {
    const plain = join(root, "plain");
    gitOk(root, ["init", "-b", "main", plain]);
    writeFileSync(join(plain, "a.txt"), "a\n");
    gitOk(plain, ["add", "a.txt"]);
    gitOk(plain, ["commit", "-m", "one"]);
    gitOk(plain, ["checkout", "-b", "topic"]);
    writeFileSync(join(plain, "b.txt"), "b\n");
    gitOk(plain, ["add", "b.txt"]);
    gitOk(plain, ["commit", "-m", "two"]);
    gitOk(plain, ["checkout", "main"]);

    const ref = await registerInPlace(settings, join(plain, ".git"), "host");
    expect(ref.id).toBe("local/host");
    expect(ref.inPlace).toBe(true);
    expect(ref.gitDir).toBe(join(plain, ".git"));

    const record = inPlaceRecordPath(root, "local/host");
    expect(existsSync(record)).toBe(true);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ gitDir: join(plain, ".git") });
    expect(existsSync(join(plain, ".git", "hooks", "reference-transaction"))).toBe(true);
    expect(gitOk(plain, ["config", "--get", "pi-sec.registryRoot"]).stdout.trim()).toBe(root);

    const resolved = await resolveRepo(settings, "local/host");
    expect(resolved).toEqual({ id: "local/host", gitDir: join(plain, ".git"), inPlace: true });
    await expect(registerInPlace(settings, join(plain, ".git"), "host")).rejects.toThrow(/already registered/);

    const mainBefore = gitOk(plain, ["rev-parse", "refs/heads/main"]).stdout.trim();
    let message = "";
    try {
      await fastForward(settings, "local/host", "topic");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("main is checked out in");
    expect(message).toContain(plain);
    expect(gitOk(plain, ["rev-parse", "refs/heads/main"]).stdout.trim()).toBe(mainBefore);

    // The main worktree of an in-place repository is listed, and not as managed.
    const listing = await showRepo(settings, "local/host");
    expect(listing.repos.map((repo) => repo.id)).toEqual(["local/host"]);
    const mainWorktree = worktreeOf(listing, plain);
    expect(mainWorktree.managed).toBe(false);
    expect(mainWorktree.branch).toBe("main");
    expect(mainWorktree.sizeBytes).toBeNull();
  });

  it("refuses to register in place over another tool's hook", async () => {
    const other = join(root, "other");
    gitOk(root, ["init", "-b", "main", other]);
    writeFileSync(join(other, "a.txt"), "a\n");
    gitOk(other, ["add", "a.txt"]);
    gitOk(other, ["commit", "-m", "one"]);
    const hookFile = join(other, ".git", "hooks", "reference-transaction");
    mkdirSync(join(other, ".git", "hooks"), { recursive: true });
    writeFileSync(hookFile, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    await expect(registerInPlace(settings, join(other, ".git"), "other")).rejects.toThrow(/refusing to replace/);
    expect(existsSync(inPlaceRecordPath(root, "local/other"))).toBe(false);
    expect(readFileSync(hookFile, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("shows one repository only, and refuses a name it does not hold", async () => {
    const shown = await showRepo(settings, "local/demo");
    expect(shown.repos.map((repo) => repo.id)).toEqual(["local/demo"]);
    expect(shown.worktrees.every((worktree) => worktree.repo === "local/demo")).toBe(true);
    expect(shown.caches.every((cache) => cache.repo === "local/demo")).toBe(true);
    await expect(showRepo(settings, "local/absent")).rejects.toThrow(/not registered/);
  });

  it("reports the state of the registry with doctor", async () => {
    const report = await doctorRegistry(settings);
    expect(report.checks.some((check) => check.name === "hook present local/demo" && check.ok)).toBe(true);
    expect(report.checks.some((check) => check.name === "hook content local/demo" && check.ok)).toBe(true);
    expect(report.checks.some((check) => check.name === "buildfs mode" && check.detail === "copy")).toBe(true);
    expect(report.ok).toBe(true);

    const hookFile = join(bare, "hooks", "reference-transaction");
    chmodSync(hookFile, 0o644);
    const broken = await doctorRegistry(settings);
    expect(broken.ok).toBe(false);
    expect(broken.checks.find((check) => check.name === "hook executable local/demo")?.ok).toBe(false);

    chmodSync(hookFile, 0o755);
    expect((await doctorRegistry(settings)).ok).toBe(true);
  });

  it("prunes the caches past the keep count on its own", async () => {
    const kept = await listCaches(cacheParent(root, "local/demo", "node_modules"));
    expect(kept).toHaveLength(2);

    // One cache is enough for the rest of the file, and it proves that the keep
    // count is what decides.
    const entry = entryOf(await pruneAll({ ...settings, cacheKeep: 1 }), "local/demo", "node_modules");
    expect(entry.action).toBe("none");
    expect(entry.reason).toBeUndefined();
    expect(entry.pruned).toHaveLength(1);
    expect(existsSync(entry.pruned[0] ?? "")).toBe(false);
    const left = await listCaches(cacheParent(root, "local/demo", "node_modules"));
    expect(left).toHaveLength(1);
    expect(left[0]?.path).toBe(kept[0]?.path);

    const again = entryOf(await pruneAll({ ...settings, cacheKeep: 1 }), "local/demo", "node_modules");
    expect(again.pruned).toEqual([]);
  });

  it("empties and fills the build directory again", async () => {
    const before = installsIn(root).length;
    const refilled = await refillBuildfs(settings, "local/demo", WORKTREE_A);
    expect(refilled.path).toBe(a.path);
    expect(refilled.branch).toBe(`wt/${WORKTREE_A}`);
    expect(refilled.buildDirs).toHaveLength(1);
    expect(refilled.buildDirs[0]?.dir).toBe("node_modules");
    // The newest cache has this lockfile, so the build directory comes from it.
    expect(refilled.buildDirs[0]?.filledFrom).not.toBeNull();
    expect(refilled.buildDirs[0]?.installed).toBe(false);
    // The newest cache was taken from this worktree after its build directory was
    // changed, so that is what comes back: a cache is a copy of that moment.
    const newest = (await listCaches(cacheParent(root, "local/demo", "node_modules")))[0];
    expect(readFileSync(join(a.path, "node_modules", "pkg", "value"), "utf8")).toBe(
      readFileSync(join(newest?.path ?? "", "pkg", "value"), "utf8"),
    );
    expect(existsSync(join(a.path, "node_modules", "pkg", "added in b"))).toBe(false);
    expect(installsIn(root)).toHaveLength(before);
  });

  it("leaves the worktree in place when the install fails", async () => {
    const failRoot = join(root, "failing");
    const failSettings = settingsFor(failRoot, {
      buildDirs: [
        { dir: "node_modules", lockfile: "package-lock.json", install: ["sh", "-c", "exit 3"] },
      ],
    });
    await registerRepo(failSettings, "local/fail");
    seedRepo(bareRepoDir(failRoot, "local/fail"), join(failRoot, "seed"), "1.0.0");

    await expect(addWorktree(failSettings, "local/fail", "broken")).rejects.toThrow(/could not be filled/);
    const path = worktreeDir(failRoot, "local/fail", "broken");
    expect(existsSync(path)).toBe(true);
    // The half-filled directory is gone again, so the worktree holds no claim
    // that the install finished.
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });

  it("runs the refresh on its own schedule", async () => {
    const timerRoot = join(root, "timers");
    const timerSettings = settingsFor(timerRoot);
    await registerRepo(timerSettings, "local/timer");
    seedRepo(bareRepoDir(timerRoot, "local/timer"), join(timerRoot, "seed"), "1.0.0");
    await addWorktree(timerSettings, "local/timer", "one");

    const lastRefresh = registryPaths(timerRoot).lastRefresh;
    const cacheDir = cacheParent(timerRoot, "local/timer", "node_modules");
    const clock = Date.now();
    const timers = fakeTimers();
    const log: string[] = [];
    const refresher = new BuildfsRefresher({
      settings: () => timerSettings,
      log: (line) => log.push(line),
      timers,
      now: () => clock,
    });

    refresher.start();
    expect(timers.delays()).toEqual([5 * 60 * 1000]);
    expect(existsSync(lastRefresh)).toBe(false);
    expect(log).toEqual([]);

    timers.fire(0);
    await vi.waitFor(() => {
      expect(existsSync(lastRefresh)).toBe(true);
    });
    await vi.waitFor(() => {
      expect(timers.delays()).toEqual([60 * 60 * 1000]);
    });
    expect(await listCaches(cacheDir)).toHaveLength(1);

    // An hour later the record is fresh, so the check runs nothing.
    timers.fire(0);
    await vi.waitFor(() => {
      expect(timers.delays()).toEqual([60 * 60 * 1000]);
    });
    expect(await listCaches(cacheDir)).toHaveLength(1);

    // An install newer than the cache, and a record older than refreshHours.
    const marker = join(timerRoot, "worktrees", "local", "timer", "one", "node_modules", ".package-lock.json");
    const later = new Date(clock + 60 * 60 * 1000);
    utimesSync(marker, later, later);
    writeFileSync(lastRefresh, `${JSON.stringify({ at: new Date(clock - 25 * 60 * 60 * 1000).toISOString() })}\n`);
    timers.fire(0);
    await vi.waitFor(async () => {
      expect(await listCaches(cacheDir)).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(timers.delays()).toEqual([60 * 60 * 1000]);
    });

    refresher.stop();
    expect(timers.delays()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("does nothing for a registry root that is not there", async () => {
    const missing = join(root, "never-created");
    const timers = fakeTimers();
    const log: string[] = [];
    const refresher = new BuildfsRefresher({
      settings: () => ({ ...settingsFor(root), root: missing }),
      log: (line) => log.push(line),
      timers,
    });
    await refresher.runOnce();
    refresher.start();
    timers.fire(0);
    await vi.waitFor(() => {
      expect(timers.delays()).toEqual([60 * 60 * 1000]);
    });
    refresher.stop();
    expect(existsSync(missing)).toBe(false);
    expect(log).toEqual([]);
  });
});

/** A timer set a test drives itself: it records the delay and fires on demand. */
interface FakeTimers extends BuildfsRefresherTimers {
  /** The delay of every armed timer, oldest first. */
  delays(): number[];
  /** Fire the timer at `index` and drop it from the armed list. */
  fire(index: number): void;
}

function fakeTimers(): FakeTimers {
  const armed: { delayMs: number; callback: () => void; cancelled: boolean }[] = [];
  return {
    set(callback, delayMs) {
      const handle = { delayMs, callback, cancelled: false };
      armed.push(handle);
      return {
        cancel() {
          handle.cancelled = true;
          const index = armed.indexOf(handle);
          if (index !== -1) armed.splice(index, 1);
        },
      };
    },
    delays() {
      return armed.map((handle) => handle.delayMs);
    },
    fire(index) {
      const handle = armed[index];
      if (handle === undefined) throw new Error(`no armed timer at ${String(index)}`);
      armed.splice(index, 1);
      handle.callback();
    },
  };
}

/**
 * The doctor check over a repository the registry holds in place.
 *
 * The worktree of such a repository is not one the registry made, so its build
 * directory is a folder an operator installed and not a store the registry
 * keeps. The check runs in `subvolume` mode here, because a file system that is
 * not btrfs never reaches it: the mode is what decides, and a setting pins it.
 */
describe("doctor over a repository registered in place", () => {
  it("does not test the build directory of a worktree the registry did not make", async () => {
    const root = tempRoot("registry-doctor-inplace");
    try {
      const plain = join(root, "plain");
      gitOk(root, ["init", "-b", "main", plain]);
      writeFileSync(join(plain, "a.txt"), "a\n");
      // The lockfile is what tells the registry that this worktree carries the
      // `node_modules` build directory the settings name.
      writeLockfile(plain, "1.0.0");
      gitOk(plain, ["add", "-A"]);
      gitOk(plain, ["commit", "-m", "one"]);

      // A plain folder where a worktree the registry made would hold a subvolume.
      const buildDir = join(plain, "node_modules");
      mkdirSync(join(buildDir, "pkg"), { recursive: true });
      writeFileSync(join(buildDir, "pkg", "value"), "installed by hand\n");
      expect(isSubvolume(buildDir)).toBe(false);

      await registerInPlace(settingsFor(root, { mode: "subvolume" }), join(plain, ".git"), "solo");

      const report = await doctorRegistry(settingsFor(root, { mode: "subvolume" }));
      expect(report.checks.some((check) => check.name === `subvolume ${buildDir}`)).toBe(false);
      expect(report.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

/**
 * The btrfs half. It runs only when `PI_SEC_TEST_BTRFS_DIR` names a btrfs
 * directory, because a subvolume cannot be faked. Every command runs for real,
 * and the tree is removed at the end with its read-only caches first.
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

/** Run one command for real, whatever the caller's deps say. */
function realRun(cmd: string, args: string[], opts?: { cwd?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({
        code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 126,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr !== "" ? stderr : error.message,
      });
    });
  });
}

/** Delete every subvolume below a folder, read-only ones first, then the folders. */
function deleteSubvolumes(path: string): void {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return;
  }
  for (const name of names) {
    const child = join(path, name);
    if (isSubvolume(child)) {
      deleteSubvolumes(child);
      spawnSync("btrfs", ["property", "set", child, "ro", "false"], { stdio: "ignore" });
      spawnSync("btrfs", ["subvolume", "delete", child], { stdio: "ignore" });
      continue;
    }
    try {
      if (lstatSync(child).isDirectory()) deleteSubvolumes(child);
    } catch {
      // Gone during the walk.
    }
  }
}

describe.skipIf(!btrfsAvailable)("the registry flow on btrfs", () => {
  let root = "";
  let settings: RegistrySettings;
  let bare = "";
  let one: Awaited<ReturnType<typeof addWorktree>>;
  let two: Awaited<ReturnType<typeof addWorktree>>;
  let firstCache = "";

  beforeAll(() => {
    mkdirSync(btrfsRoot, { recursive: true, mode: 0o700 });
    root = mkdtempSync(join(btrfsRoot, "registry-flow-"));
    settings = settingsFor(root, { mode: "auto" });
  });

  afterAll(() => {
    if (root === "") return;
    deleteSubvolumes(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("fills a new worktree from the newest cache as a subvolume", async () => {
    await registerRepo(settings, "local/bt");
    bare = bareRepoDir(root, "local/bt");
    seedRepo(bare, join(root, "seed"), "1.0.0");

    one = await addWorktree(settings, "local/bt", "one");
    expect(one.mode).toBe("subvolume");
    const firstDir = join(one.path, "node_modules");
    expect(isSubvolume(firstDir)).toBe(true);
    expect(lstatSync(firstDir).ino).toBe(256);
    expect(one.buildDirs).toEqual([{ dir: "node_modules", filledFrom: null, installed: true }]);

    const entry = entryOf(await refreshCaches(settings), "local/bt", "node_modules");
    expect(entry.action).toBe("created");
    firstCache = entry.cache?.path ?? "";
    expect(isSubvolume(firstCache)).toBe(true);
    expect(entry.cache?.readOnly).toBe(true);

    two = await addWorktree(settings, "local/bt", "two");
    const secondDir = join(two.path, "node_modules");
    expect(isSubvolume(secondDir)).toBe(true);
    expect(lstatSync(secondDir).ino).toBe(256);
    expect(two.buildDirs).toEqual([{ dir: "node_modules", filledFrom: firstCache, installed: false }]);
    expect(readFileSync(join(secondDir, "pkg", "value"), "utf8")).toBe("v1\n");
    expect(installsIn(root)).toEqual([one.path]);
  });

  it("keeps one worktree's changes out of the other worktree and the cache", () => {
    writeFileSync(join(one.path, "node_modules", "pkg", "value"), "changed in one\n");
    rmSync(join(one.path, "node_modules", "pkg", "extra"));

    expect(readFileSync(join(two.path, "node_modules", "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(two.path, "node_modules", "pkg", "extra"))).toBe(true);
    expect(readFileSync(join(firstCache, "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(firstCache, "pkg", "extra"))).toBe(true);

    writeFileSync(join(two.path, "node_modules", "pkg", "only in two"), "two\n");
    expect(existsSync(join(one.path, "node_modules", "pkg", "only in two"))).toBe(false);
    expect(existsSync(join(firstCache, "pkg", "only in two"))).toBe(false);
  });

  it("takes a new cache from the latest install and prunes past the keep count", async () => {
    const marker = join(one.path, "node_modules", ".package-lock.json");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(marker, later, later);

    const second = entryOf(await refreshCaches(settings), "local/bt", "node_modules");
    expect(second.action).toBe("created");
    expect(second.cache?.meta?.sourceWorktree).toBe(one.path);
    expect(second.pruned).toEqual([]);
    expect(second.cache?.readOnly).toBe(true);

    utimesSync(marker, new Date(later.getTime() + 60 * 60 * 1000), new Date(later.getTime() + 60 * 60 * 1000));
    const third = entryOf(await refreshCaches(settings), "local/bt", "node_modules");
    expect(third.action).toBe("created");
    expect(third.cache?.meta?.sourceWorktree).toBe(one.path);
    expect(third.pruned).toEqual([firstCache]);
    expect(existsSync(firstCache)).toBe(false);
    expect(await listCaches(cacheParent(root, "local/bt", "node_modules"))).toHaveLength(settings.cacheKeep);
  });

  it("fills a plain folder again and has doctor report it first", async () => {
    // A build tool that deletes its build directory and makes it again turns the
    // subvolume into a plain folder, which a backup then copies.
    const target = join(one.path, "node_modules");
    deleteSubvolumes(target);
    expect(spawnSync("btrfs", ["subvolume", "delete", target], { stdio: "ignore" }).status).toBe(0);
    mkdirSync(join(target, "pkg"), { recursive: true });
    writeFileSync(join(target, "pkg", "value"), "made by a build tool\n");
    expect(isSubvolume(target)).toBe(false);

    const report = await doctorRegistry(settings);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === `subvolume ${target}`)?.ok).toBe(false);

    const refilled = await refillBuildfs(settings, "local/bt", "one");
    expect(refilled.buildDirs[0]?.dir).toBe("node_modules");
    expect(refilled.buildDirs[0]?.filledFrom).not.toBeNull();
    expect(refilled.buildDirs[0]?.installed).toBe(false);
    expect(isSubvolume(target)).toBe(true);
    expect(lstatSync(target).ino).toBe(256);
    expect(existsSync(join(target, "pkg", "value"))).toBe(true);
    expect((await doctorRegistry(settings)).ok).toBe(true);
  });

  it("removes a worktree's build directory with btrfs subvolume delete", async () => {
    const buildDir = join(two.path, "node_modules");
    const commands: { cmd: string; args: string[] }[] = [];
    const deps = {
      run: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === "btrfs") commands.push({ cmd, args: [...args] });
        return realRun(cmd, args, opts);
      },
    };

    const removed = await removeWorktree(settings, "local/bt", "two", deps);
    expect(removed.buildDirs).toEqual([buildDir]);
    expect(existsSync(buildDir)).toBe(false);
    expect(existsSync(two.path)).toBe(false);
    expect(
      commands.some(
        (command) => command.cmd === "btrfs" && command.args[0] === "subvolume" && command.args[1] === "delete" && command.args[2] === buildDir,
      ),
    ).toBe(true);
  });
});
