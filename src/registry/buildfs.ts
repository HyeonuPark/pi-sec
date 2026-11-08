import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { hasUserSubvolRmAllowed } from "./mountinfo.ts";

/**
 * A build directory is the tree an install writes: `node_modules`, `.venv`, or
 * `target`. It is big, it is rebuilt from a lockfile, and a backup that copies it
 * pays for every worktree that carries one.
 *
 * This module owns the path-level work around one such directory: how it is
 * stored, filled from a cache, copied into a cache, and removed. It knows nothing
 * about repositories, worktrees, or where the registry keeps them; a caller
 * hands it absolute paths.
 *
 * On btrfs a build directory and a cache are subvolumes. A subvolume root has
 * inode 256, and a backup tool excludes it by that number instead of walking it.
 * A snapshot fills a new worktree in one call and costs no data copy. On another
 * file system the same flow runs with plain copies.
 */

export type BuildfsMode = "subvolume" | "copy" | "none";

/** One external command's outcome. A missing binary is a result, not a throw. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The seams a test or a caller can replace. Every function here takes this as its
 * last argument, and every external command goes through `run`, so a test can
 * drive the btrfs branches without btrfs.
 */
export interface BuildfsDeps {
  run?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>;
  /** The text of the mount table; defaults to reading the live file. */
  mountinfo?: () => string;
}

/** btrfs's `statfs` magic, the value `fs.statfsSync(path).type` reports there. */
const BTRFS_SUPER_MAGIC = 2435016766;

/** The file that records which cache a build directory was filled from. */
const CACHE_META_FILE = "pi-sec-cache.json";

/** The inode number of a btrfs subvolume root. */
const SUBVOLUME_INO = 256;

/**
 * Run `cmd` and report what happened. `execFile` gives an error for a non-zero
 * exit and for a binary that does not exist; both become a plain result, because
 * a missing `btrfs` or `restorecon` is expected on some hosts.
 */
const defaultRun: NonNullable<BuildfsDeps["run"]> = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      if (error === null) {
        resolve({ code: 0, stdout: text(stdout), stderr: text(stderr) });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({
        code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 126,
        stdout: text(stdout),
        stderr: text(stderr) === "" ? error.message : text(stderr),
      });
    });
  });

function runOf(deps: BuildfsDeps): NonNullable<BuildfsDeps["run"]> {
  return deps.run ?? defaultRun;
}

function outputOf(result: RunResult): string {
  const text = `${result.stdout}${result.stderr}`.trim();
  return text === "" ? `exited ${result.code}` : `exited ${result.code}: ${text}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the storage for new build directories. `auto` asks the file system: on
 * btrfs a real subvolume is created and deleted under `probeParent`, because the
 * magic number alone does not say that this user may make one there.
 *
 * The probe directory is removed on every path, including the failure where
 * `btrfs subvolume delete` refused and left it behind.
 */
export async function detectMode(
  probeParent: string,
  configured: "auto" | BuildfsMode,
  deps: BuildfsDeps = {},
): Promise<BuildfsMode> {
  if (configured !== "auto") return configured;
  try {
    if (statfsSync(probeParent).type !== BTRFS_SUPER_MAGIC) return "copy";
  } catch {
    return "copy";
  }
  const run = runOf(deps);
  const probe = join(probeParent, `.pi-sec-buildfs-probe-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    if ((await run("btrfs", ["subvolume", "create", probe])).code !== 0) return "copy";
    if ((await run("btrfs", ["subvolume", "delete", probe])).code !== 0) return "copy";
    return "subvolume";
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {
      // A subvolume that could not be deleted cannot be removed as a directory
      // either; the caller reports the mode, and the leftover is not a build dir.
    }
  }
}

/** A subvolume root carries inode 256 on btrfs; nothing else does. */
export function isSubvolume(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && info.ino === SUBVOLUME_INO;
  } catch {
    return false;
  }
}

/** sha256 of the lockfile bytes, as lowercase hex. */
export function lockfileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface CacheMeta {
  repo: string;
  buildDir: string;
  /** The worktree the cache was taken from. */
  sourceWorktree: string;
  lockfileHash: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface CacheEntry {
  path: string;
  /** The directory name: `YYYYMMDDTHHMMSSZ`, or the same with `-2`, `-3`. */
  name: string;
  createdAt: string;
  /** Absent when the cache carries no meta file or a meta file that does not parse. */
  meta?: CacheMeta;
  readOnly: boolean;
}

/** UTC `YYYYMMDDTHHMMSSZ`: sortable as text and readable in a listing. */
function cacheStamp(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error(`not a valid date: ${String(date)}`);
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function readMeta(dir: string): CacheMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CACHE_META_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = ["repo", "buildDir", "sourceWorktree", "lockfileHash", "createdAt"] as const;
  for (const key of keys) {
    if (typeof record[key] !== "string") return undefined;
  }
  return {
    repo: record["repo"] as string,
    buildDir: record["buildDir"] as string,
    sourceWorktree: record["sourceWorktree"] as string,
    lockfileHash: record["lockfileHash"] as string,
    createdAt: record["createdAt"] as string,
  };
}

/** Newest first, and on the same second the later name (`-2`) first. */
function compareNewestFirst(a: CacheEntry, b: CacheEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? 1 : -1;
}

/**
 * The caches under one parent, newest first. A missing parent is an empty list:
 * a repository that was never refreshed has no caches, which is not an error.
 */
export async function listCaches(cacheParent: string, deps: BuildfsDeps = {}): Promise<CacheEntry[]> {
  let names: string[];
  try {
    const found = await readdir(cacheParent, { withFileTypes: true });
    names = found.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const run = runOf(deps);
  const caches: CacheEntry[] = [];
  for (const name of names) {
    const path = join(cacheParent, name);
    const meta = readMeta(path);
    let createdAt = meta?.createdAt;
    if (createdAt === undefined) {
      try {
        createdAt = statSync(path).mtime.toISOString();
      } catch {
        createdAt = new Date(0).toISOString();
      }
    }
    let readOnly = false;
    if (isSubvolume(path)) {
      const result = await run("btrfs", ["property", "get", path, "ro"]);
      readOnly = result.code === 0 && /(^|\s)ro=true(\s|$)/u.test(result.stdout);
    }
    caches.push({ path, name, createdAt, ...(meta === undefined ? {} : { meta }), readOnly });
  }
  return caches.sort(compareNewestFirst);
}

/**
 * The caches a prune would remove: everything after the newest `keep`. Pure, so
 * the policy can be checked without a file system.
 */
export function chooseCachesToPrune(entries: readonly CacheEntry[], keep: number): CacheEntry[] {
  return [...entries].sort(compareNewestFirst).slice(Math.max(0, Math.trunc(keep)));
}

/** `btrfs property get <p> ro` prints `<p>: ro=true`; anything else is not a yes. */
async function subvolumeIsReadOnly(path: string, run: NonNullable<BuildfsDeps["run"]>): Promise<boolean | undefined> {
  const result = await run("btrfs", ["property", "get", path, "ro"]);
  if (result.code !== 0) return undefined;
  return /(^|\s)ro=true(\s|$)/u.test(result.stdout);
}

/**
 * `restorecon` fixes the SELinux label of a fresh subvolume, which starts as
 * `unlabeled_t`. It is absent on a host without SELinux, and a failure there
 * changes nothing about the tree, so both are ignored.
 */
async function restorecon(path: string, run: NonNullable<BuildfsDeps["run"]>): Promise<void> {
  await run("restorecon", [path]);
}

async function createEmptyBuildDir(
  mode: BuildfsMode,
  target: string,
  run: NonNullable<BuildfsDeps["run"]>,
): Promise<void> {
  if (mode === "subvolume") {
    const result = await run("btrfs", ["subvolume", "create", target]);
    if (result.code !== 0) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // Nothing was created, or what was created cannot be removed here.
      }
      throw new Error(`btrfs subvolume create failed for ${target}: ${outputOf(result)}`);
    }
    await restorecon(target, run);
    return;
  }
  mkdirSync(target);
}

/**
 * Remove a build directory this call created and could not fill. A subvolume has
 * to go through `btrfs subvolume delete`; the plain removal is the last resort,
 * and neither path is allowed to hide the install failure that follows.
 */
async function discardBuildDir(
  mode: BuildfsMode,
  target: string,
  run: NonNullable<BuildfsDeps["run"]>,
): Promise<void> {
  if (mode === "subvolume" && isSubvolume(target)) {
    const deleted = await run("btrfs", ["subvolume", "delete", target]);
    if (deleted.code === 0) return;
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // A read-only or busy subvolume stays; the caller hears the install failure.
  }
}

/** The newest cache, when its lockfile hash is the one the worktree has now. */
async function cacheForLock(opts: FillBuildDirOptions, deps: BuildfsDeps): Promise<string | undefined> {
  if (opts.mode === "none" || opts.lockHash === undefined) return undefined;
  const newest = (await listCaches(opts.cacheParent, deps))[0];
  if (newest?.meta === undefined) return undefined;
  return newest.meta.lockfileHash === opts.lockHash ? newest.path : undefined;
}

export interface FillBuildDirOptions {
  mode: BuildfsMode;
  /** The build directory to create. It must not exist yet. */
  target: string;
  /** The parent that holds this build directory's caches. */
  cacheParent: string;
  /** The worktree's lockfile hash; a match with the newest cache skips the install. */
  lockHash?: string;
  /** The install command, argv style, run in `cwd`. */
  install?: string[];
  /** The worktree root the install command runs in. */
  cwd: string;
}

export interface FillBuildDirResult {
  /** Set when the directory came from a cache; the cache's path. */
  filledFrom?: string;
  installed: boolean;
  mode: BuildfsMode;
}

/**
 * Create one build directory. A cache whose lockfile hash matches fills the
 * directory in one call and skips the install; otherwise an empty directory is
 * created and the install runs.
 *
 * The cache's meta file stays inside the new directory, so a listing can say
 * which cache a worktree was filled from.
 *
 * An install that fails removes the half-filled directory before it throws: the
 * caller sees a worktree with no build directory, not one it cannot trust.
 */
export async function fillBuildDir(opts: FillBuildDirOptions, deps: BuildfsDeps = {}): Promise<FillBuildDirResult> {
  const run = runOf(deps);
  if (exists(opts.target)) throw new Error(`the build directory already exists: ${opts.target}`);

  const filledFrom = await cacheForLock(opts, deps);
  if (filledFrom !== undefined) {
    if (opts.mode === "subvolume") {
      const result = await run("btrfs", ["subvolume", "snapshot", filledFrom, opts.target]);
      if (result.code !== 0) throw new Error(`btrfs subvolume snapshot failed for ${opts.target}: ${outputOf(result)}`);
      await restorecon(opts.target, run);
    } else {
      const result = await run("cp", ["-a", "--reflink=auto", filledFrom, opts.target]);
      if (result.code !== 0) throw new Error(`copying the cache into ${opts.target} failed: ${outputOf(result)}`);
    }
    return { filledFrom, installed: false, mode: opts.mode };
  }

  await createEmptyBuildDir(opts.mode, opts.target, run);
  const install = opts.install;
  if (install === undefined || install.length === 0) return { installed: false, mode: opts.mode };

  const command = install[0];
  if (command === undefined) return { installed: false, mode: opts.mode };
  const result = await run(command, install.slice(1), { cwd: opts.cwd });
  if (result.code !== 0) {
    await discardBuildDir(opts.mode, opts.target, run);
    throw new Error(`the install command failed in ${opts.cwd}: ${outputOf(result)}`);
  }
  return { installed: true, mode: opts.mode };
}

export interface SnapshotToCacheOptions {
  mode: "subvolume" | "copy";
  /** The build directory to take the cache from. */
  source: string;
  /** The parent that holds this build directory's caches. */
  cacheParent: string;
  meta: Omit<CacheMeta, "createdAt"> & { createdAt?: string };
}

/**
 * Turn a build directory into a cache. A subvolume cache becomes read-only after
 * its meta file is written, because `btrfs subvolume snapshot -r` cannot write
 * that file into the new snapshot and the meta is what a listing reads first. The
 * SELinux label is fixed in the same window, just before the read-only flag goes
 * on: a read-only subvolume accepts no write, that one included.
 *
 * A cache that is read-only still fills a worktree: a snapshot of a read-only
 * subvolume is writable.
 */
export async function snapshotToCache(opts: SnapshotToCacheOptions, deps: BuildfsDeps = {}): Promise<CacheEntry> {
  const run = runOf(deps);
  const createdAt = opts.meta.createdAt ?? new Date().toISOString();
  const stamp = cacheStamp(new Date(createdAt));
  mkdirSync(opts.cacheParent, { recursive: true, mode: 0o700 });

  let dest = join(opts.cacheParent, stamp);
  for (let suffix = 2; exists(dest); suffix += 1) dest = join(opts.cacheParent, `${stamp}-${suffix}`);

  if (opts.mode === "subvolume") {
    const result = await run("btrfs", ["subvolume", "snapshot", opts.source, dest]);
    if (result.code !== 0) throw new Error(`btrfs subvolume snapshot failed for ${dest}: ${outputOf(result)}`);
  } else {
    const result = await run("cp", ["-a", "--reflink=auto", opts.source, dest]);
    if (result.code !== 0) throw new Error(`copying ${opts.source} into ${dest} failed: ${outputOf(result)}`);
  }

  const meta: CacheMeta = {
    repo: opts.meta.repo,
    buildDir: opts.meta.buildDir,
    sourceWorktree: opts.meta.sourceWorktree,
    lockfileHash: opts.meta.lockfileHash,
    createdAt,
  };
  writeFileSync(join(dest, CACHE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);

  let readOnly = false;
  if (opts.mode === "subvolume") {
    // The label is fixed before the snapshot goes read-only: `restorecon` writes
    // the SELinux label of the tree, and a read-only subvolume refuses that write,
    // so a label set afterwards would stay `unlabeled_t` forever.
    await restorecon(dest, run);
    const result = await run("btrfs", ["property", "set", dest, "ro", "true"]);
    if (result.code !== 0) throw new Error(`making the cache read-only failed for ${dest}: ${outputOf(result)}`);
    readOnly = true;
  }
  return { path: dest, name: dest.slice(dest.lastIndexOf(sep) + 1), createdAt, meta, readOnly };
}

export interface RemoveBuildfsOptions {
  /** The tree the target must sit inside. The root itself is refused. */
  allowedRoot: string;
  mode: BuildfsMode;
}

export interface RemoveBuildfsResult {
  removed: boolean;
  method: "subvolume-delete" | "rm-rmdir" | "rm" | "none";
  reason?: string;
}

function permissionDenied(output: string): boolean {
  return /permission denied|operation not permitted|EACCES|EPERM/iu.test(output);
}

/**
 * Empty a subvolume and remove its directory.
 *
 * `btrfs subvolume delete` needs either root or the mount option
 * `user_subvol_rm_allowed`. Without it a user can still remove an empty
 * subvolume with `rmdir`, so the fallback removes every child and then the
 * directory. A read-only subvolume is made writable first, because nothing can
 * be removed from it while it is read-only.
 */
async function emptyAndRemove(
  path: string,
  readOnly: boolean,
  run: NonNullable<BuildfsDeps["run"]>,
): Promise<RemoveBuildfsResult> {
  if (readOnly) await run("btrfs", ["property", "set", path, "ro", "false"]);
  try {
    for (const name of readdirSync(path)) rmSync(join(path, name), { recursive: true, force: true });
  } catch (error) {
    return { removed: false, method: "none", reason: `emptying the subvolume failed: ${errorText(error)}` };
  }
  try {
    rmdirSync(path);
  } catch (error) {
    return { removed: false, method: "none", reason: `rmdir failed: ${errorText(error)}` };
  }
  return { removed: true, method: "rm-rmdir" };
}

/** The subvolume branch of `removeBuildfs`, after the path checks. */
async function removeSubvolume(
  path: string,
  deps: BuildfsDeps,
  run: NonNullable<BuildfsDeps["run"]>,
): Promise<RemoveBuildfsResult> {
  const table = deps.mountinfo === undefined ? undefined : deps.mountinfo();
  if (!hasUserSubvolRmAllowed(path, table)) {
    // The mount grants no unprivileged delete; the fallback is the only way.
    const readOnly = (await subvolumeIsReadOnly(path, run)) === true;
    return emptyAndRemove(path, readOnly, run);
  }

  const readOnly = (await subvolumeIsReadOnly(path, run)) === true;
  if (readOnly) {
    const cleared = await run("btrfs", ["property", "set", path, "ro", "false"]);
    if (cleared.code !== 0) return emptyAndRemove(path, true, run);
  }

  const deleted = await run("btrfs", ["subvolume", "delete", path]);
  if (deleted.code === 0) return { removed: true, method: "subvolume-delete" };

  const output = `${deleted.stdout}\n${deleted.stderr}`;
  if (/not empty/iu.test(output)) {
    // A nested subvolume is a cache or a worktree in its own right; deleting the
    // parent would take it too, so nothing is removed.
    return { removed: false, method: "none", reason: `the subvolume holds another subvolume: ${output.trim()}` };
  }
  if (permissionDenied(output)) return emptyAndRemove(path, false, run);
  return { removed: false, method: "none", reason: `btrfs subvolume delete failed: ${output.trim()}` };
}

/**
 * Remove one build directory or cache.
 *
 * Two checks come before any removal. The real path must sit below `allowedRoot`
 * and must not be the root itself, because `btrfs subvolume delete` removes a
 * whole tree in one call and one wrong path would take every cache with it. And
 * a plain directory is refused when the mode says subvolumes, so a mistyped path
 * into a worktree is not deleted as if it were a cache.
 *
 * The method in the result says what actually happened, so a caller can report
 * that a fallback ran where a subvolume delete was expected.
 */
export async function removeBuildfs(
  path: string,
  opts: RemoveBuildfsOptions,
  deps: BuildfsDeps = {},
): Promise<RemoveBuildfsResult> {
  const run = runOf(deps);
  if (!exists(path)) return { removed: false, method: "none", reason: "missing" };

  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(opts.allowedRoot);
  } catch (error) {
    return { removed: false, method: "none", reason: `the allowed root does not resolve: ${errorText(error)}` };
  }
  try {
    targetReal = realpathSync(path);
  } catch (error) {
    return { removed: false, method: "none", reason: `the path does not resolve: ${errorText(error)}` };
  }
  if (targetReal === rootReal) {
    return { removed: false, method: "none", reason: `the path is the allowed root: ${targetReal}` };
  }
  if (!targetReal.startsWith(`${rootReal}${sep}`)) {
    return { removed: false, method: "none", reason: `the path is outside the allowed root: ${targetReal}` };
  }

  if (isSubvolume(path)) return removeSubvolume(path, deps, run);
  if (opts.mode === "subvolume") {
    return {
      removed: false,
      method: "none",
      reason: `the path is a plain directory, not a subvolume: ${path}`,
    };
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, method: "none", reason: `removing the directory failed: ${errorText(error)}` };
  }
  return { removed: true, method: "rm" };
}

/**
 * Remove every cache after the newest `keep`. The paths that were removed are
 * returned; a cache that was refused stays where it is and is not listed.
 */
export async function pruneCaches(
  cacheParent: string,
  keep: number,
  opts: RemoveBuildfsOptions,
  deps: BuildfsDeps = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of chooseCachesToPrune(await listCaches(cacheParent, deps), keep)) {
    if ((await removeBuildfs(entry.path, opts, deps)).removed) removed.push(entry.path);
  }
  return removed;
}

/**
 * Bytes on disk below `path`: the allocated blocks of every file, not the sum of
 * their lengths. A sparse file and a hard link are what makes the difference, and
 * a worktree tree has both.
 *
 * The walk does not follow a symbolic link, and it does not stop at a subvolume
 * boundary: a build directory inside a worktree is part of that worktree's size
 * only when the caller names it. A path that does not exist is zero bytes.
 */
export async function treeSize(path: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;

  const walk = async (current: string): Promise<void> => {
    let info;
    try {
      info = await lstat(current);
    } catch {
      return;
    }
    const key = `${String(info.dev)}:${String(info.ino)}`;
    if (seen.has(key)) return;
    seen.add(key);
    total += info.blocks * 512;
    if (!info.isDirectory()) return;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) await walk(join(current, name));
  };

  await walk(path);
  return total;
}
