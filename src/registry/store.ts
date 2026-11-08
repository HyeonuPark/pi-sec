import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { checkHook, installHook } from "./hooks.ts";
import { hasUserSubvolRmAllowed, mountFor, parseMountinfo } from "./mountinfo.ts";
import type { BuildfsDeps, RunResult } from "./buildfs.ts";
import { detectMode, isSubvolume, listCaches, lockfileHash, treeSize } from "./buildfs.ts";
import {
  bareRepoDir,
  cacheParent,
  ensureRegistryDirs,
  inPlaceRecordPath,
  jobIdFromWorktreeName,
  parseRepoName,
  registryPaths,
  resolveBuildDirs,
  type RegistryMode,
  type RegistrySettings,
} from "./layout.ts";

/**
 * The store: what the registry holds and what it can say about it.
 *
 * A repository is registered here as one of two kinds. A bare repository is one
 * the registry made, under `repos/<owner>/<repo>.git`; a repository registered
 * where it already lived keeps its own git directory, and a small record under
 * `repos/<owner>/<repo>.inplace.json` says where that is. Both kinds are found
 * by reading the `repos` folder, so a folder an operator made by hand is a
 * repository the registry knows.
 *
 * Everything else is read from git itself, because git is the only thing that
 * knows which worktrees a repository has and which commits they hold. Only the
 * facts git does not keep, the moment a build directory was installed and which
 * cache filled it, are read from the small files the buildfs code writes.
 *
 * Nothing in this module deletes a repository or a worktree; the work of making
 * and removing a worktree is in `worktree.ts`.
 */

/**
 * Run one external command and report what happened.
 *
 * This is the same shape as the runner in `buildfs.ts`, and the two stay
 * separate because this one also runs `git`: a git command is given an
 * environment without the four variables that describe the repository of the
 * caller, since `--git-dir` already names the repository this module means and
 * an inherited `GIT_DIR` would let git read two answers. Everything else, such
 * as the operator's identity and `GIT_CONFIG_*`, is kept.
 */
const defaultRun: NonNullable<BuildfsDeps["run"]> = (cmd, args, opts) =>
  new Promise((done) => {
    const env = cmd === "git" ? gitEnv() : process.env;
    execFile(cmd, [...args], { cwd: opts?.cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      if (error === null) {
        done({ code: 0, stdout: text(stdout), stderr: text(stderr) });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      done({
        code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 126,
        stdout: text(stdout),
        stderr: text(stderr) === "" ? error.message : text(stderr),
      });
    });
  });

/** The environment git runs with: the caller's, less its own repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_COMMON_DIR"];
  delete env["GIT_INDEX_FILE"];
  return env;
}

/** The command runner a caller's deps ask for, or the default one. */
export function runner(deps: BuildfsDeps): NonNullable<BuildfsDeps["run"]> {
  return deps.run ?? defaultRun;
}

/** Run one git command and give back its exit status and both streams. */
export async function git(
  deps: BuildfsDeps,
  args: readonly string[],
  opts?: { cwd?: string },
): Promise<RunResult> {
  return runner(deps)("git", [...args], opts);
}

/** Run one git command and refuse to go on when it fails. */
export async function gitOrThrow(
  deps: BuildfsDeps,
  args: readonly string[],
  opts?: { cwd?: string },
): Promise<string> {
  const result = await git(deps, args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

/** One repository the registry holds. */
export interface RepoRef {
  /** `<owner>/<repo>`, lowercase. */
  id: string;
  /** The git directory every worktree of this repository shares. */
  gitDir: string;
  /** The repository keeps its own git directory instead of a bare copy here. */
  inPlace: boolean;
}

/** The record a repository registered in place leaves behind. */
interface InPlaceRecord {
  gitDir: string;
}

/** Read one in-place record, and say what is wrong with it when it cannot be read. */
function readInPlaceRecord(file: string): InPlaceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`the in-place record ${file} is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const gitDir = (parsed as { gitDir?: unknown } | null)?.gitDir;
  if (typeof gitDir !== "string" || gitDir === "" || !isAbsolute(gitDir)) {
    throw new Error(`the in-place record ${file} does not hold an absolute "gitDir"`);
  }
  return { gitDir };
}

/**
 * The repository one id names, or nothing when the registry does not hold it.
 *
 * The bare repository is looked for first, and a record second. A record that
 * sits next to a bare repository of the same name is a registry that was written
 * twice; the bare copy wins and the record is left for `doctor` to report.
 */
export function repoRefOf(settings: RegistrySettings, id: string): RepoRef | undefined {
  const bare = bareRepoDir(settings.root, id);
  if (existsSync(bare)) return { id, gitDir: bare, inPlace: false };
  const record = inPlaceRecordPath(settings.root, id);
  if (existsSync(record)) return { id, gitDir: readInPlaceRecord(record).gitDir, inPlace: true };
  return undefined;
}

/** Resolve a repository name, refusing one the registry does not hold. */
export async function resolveRepo(
  settings: RegistrySettings,
  name: string,
  // The signature takes deps for the callers that will run git next; nothing
  // here needs a command, and a caller may pass none.
  _deps: BuildfsDeps = {},
): Promise<RepoRef> {
  const { id } = parseRepoName(name);
  const ref = repoRefOf(settings, id);
  if (ref === undefined) {
    throw new Error(`the repository "${id}" is not registered under ${registryPaths(settings.root).root}`);
  }
  return ref;
}

/**
 * Every repository id the `repos` folder holds, sorted.
 *
 * `repos/<owner>/<repo>.git` is a bare repository and
 * `repos/<owner>/<repo>.inplace.json` is an in-place record. Any other entry,
 * such as a folder an operator made or a half-written record, is not a
 * repository and is not listed; `doctor` reads the records that do not parse.
 */
export function listRepoIds(settings: RegistrySettings): string[] {
  const reposDir = registryPaths(settings.root).repos;
  let owners: string[];
  try {
    owners = readdirSync(reposDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const owner of owners) {
    if (owner.startsWith(".")) continue;
    let entries: string[];
    try {
      entries = readdirSync(join(reposDir, owner));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".git")) {
        if (isDirectory(join(reposDir, owner, entry))) ids.push(`${owner}/${entry.slice(0, -".git".length)}`);
        continue;
      }
      if (entry.endsWith(".inplace.json")) {
        ids.push(`${owner}/${entry.slice(0, -".inplace.json".length)}`);
      }
    }
  }
  return ids.sort();
}

/** Whether a path is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Register a new, empty bare repository and give it the protection hook. */
export async function registerRepo(
  settings: RegistrySettings,
  name: string,
  deps: BuildfsDeps = {},
): Promise<RepoRef> {
  const { id } = parseRepoName(name);
  await ensureRegistryDirs(settings.root);
  const bare = bareRepoDir(settings.root, id);
  if (existsSync(bare)) throw new Error(`the repository "${id}" is already registered: ${bare}`);
  const record = inPlaceRecordPath(settings.root, id);
  if (existsSync(record)) {
    throw new Error(`the repository "${id}" is registered where it already lived: ${record}`);
  }
  // `git init` creates the owner folder and the bare folder itself, and `-b main`
  // is set now rather than left to `init.defaultBranch`, which the operator's own
  // configuration might set to another name.
  await gitOrThrow(deps, ["init", "--bare", "-b", "main", bare]);
  // The hook is what keeps a worktree from moving `main`; a repository without it
  // is a repository whose worktrees share refs unguarded, so a failure here is
  // reported and the caller can register again (the call is safe to repeat).
  installHook(bare, settings.root);
  return { id, gitDir: bare, inPlace: false };
}

/**
 * Register a repository at the git directory it already has.
 *
 * The answer of `rev-parse --git-common-dir` is resolved to an absolute path,
 * because a relative answer is relative to the git directory that was named.
 * Where a worktree of the repository sits is not recorded: a repository can have
 * several, and git itself is the list of them.
 *
 * The hook is installed before the record is written, so a repository whose
 * `reference-transaction` hook belongs to another tool is refused and no record
 * appears. The record is written through a temporary file and a rename, so a
 * reader never sees half of it.
 */
export async function registerInPlace(
  settings: RegistrySettings,
  gitDir: string,
  name: string,
  deps: BuildfsDeps = {},
): Promise<RepoRef> {
  const { id } = parseRepoName(name);
  await ensureRegistryDirs(settings.root);
  if (existsSync(bareRepoDir(settings.root, id))) {
    throw new Error(`the repository "${id}" is already registered as a bare repository`);
  }
  const record = inPlaceRecordPath(settings.root, id);
  if (existsSync(record)) throw new Error(`the repository "${id}" is already registered: ${record}`);

  const answer = (await gitOrThrow(deps, ["--git-dir", gitDir, "rev-parse", "--git-common-dir"])).trim();
  if (answer === "") throw new Error(`git named no common git directory for ${gitDir}`);
  const common = isAbsolute(answer) ? answer : resolve(gitDir, answer);

  installHook(common, settings.root);

  // The owner folder is not one of the fixed folders that `ensureRegistryDirs`
  // makes. A bare repository gets it from `git init`, but an in-place record is
  // written straight into it, so it is made here before the record is written.
  // Only the folder this call created is chmodded, for the reason the same call
  // in `layout.ts` gives: `mkdir`'s mode is masked by the process umask.
  const recordDir = dirname(record);
  const recordDirExisted = existsSync(recordDir);
  await mkdir(recordDir, { recursive: true, mode: 0o700 });
  if (!recordDirExisted) await chmod(recordDir, 0o700);

  const temporary = `${record}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify({ gitDir: common }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, record);
  return { id, gitDir: common, inPlace: true };
}

/**
 * One worktree as git reports it, with the three fields that matter here.
 *
 * `bare` marks the repository itself in the listing of a bare repository. `head`
 * is nothing for an unborn branch, which git prints as forty zeros.
 */
export interface WorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** The worktrees one repository has, in the order git lists them. */
export async function worktreeRecords(gitDir: string, deps: BuildfsDeps): Promise<WorktreeRecord[]> {
  const text = await gitOrThrow(deps, ["--git-dir", gitDir, "worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line !== "");
    if (lines.length === 0) continue;
    let path = "";
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) {
        const sha = line.slice("HEAD ".length).trim();
        head = /^0+$/u.test(sha) ? null : sha;
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "bare") bare = true;
      else if (line.startsWith("locked")) locked = true;
      else if (line.startsWith("prunable")) prunable = true;
    }
    if (path !== "") records.push({ path, head, branch, bare, locked, prunable });
  }
  return records;
}

/** The branch `HEAD` points at, or nothing when it points at a commit. */
export async function defaultBranchOf(gitDir: string, deps: BuildfsDeps): Promise<string | null> {
  const result = await git(deps, ["--git-dir", gitDir, "symbolic-ref", "--short", "HEAD"]);
  const name = result.stdout.trim();
  return result.code === 0 && name !== "" ? name : null;
}

/** The remotes of one repository, as `{ name, url }` in the order git lists them. */
export async function remotesOf(
  gitDir: string,
  deps: BuildfsDeps,
): Promise<{ name: string; url: string }[]> {
  const result = await git(deps, ["--git-dir", gitDir, "remote", "-v"]);
  if (result.code !== 0) return [];
  const seen = new Set<string>();
  const remotes: { name: string; url: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^(\S+)\s+(.*?)\s+\(fetch\)$/u.exec(line.trim());
    const name = match?.[1];
    const url = match?.[2];
    if (name === undefined || url === undefined || seen.has(name)) continue;
    seen.add(name);
    remotes.push({ name, url });
  }
  return remotes;
}

/** The names of a folder's entries, or nothing when it cannot be read. */
export function topLevelNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Whether a path sits inside a folder, the folder itself included. */
export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** The file the buildfs code writes inside a build directory and a cache. */
const CACHE_META_FILE = "pi-sec-cache.json";

/** The npm install marker, whose mtime is when the install finished. */
const NPM_MARKER_FILE = ".package-lock.json";

/**
 * When a build directory was last installed, and the npm marker when it has one.
 *
 * npm keeps `node_modules/.package-lock.json` and writes it at the end of an
 * install, so its mtime is the moment the install finished. Every other build
 * directory is judged by its newest top-level entry, and the folder's own mtime
 * when it is empty.
 *
 * `at` is null only for a folder that does not exist.
 */
export interface InstallStamp {
  at: Date | null;
  marker: string | null;
}

/** Read the install stamp of one build directory. */
export function installStamp(buildDir: string): InstallStamp {
  const markerFile = join(buildDir, NPM_MARKER_FILE);
  try {
    const info = statSync(markerFile);
    if (info.isFile()) return { at: info.mtime, marker: markerFile };
  } catch {
    // No marker: the build directory belongs to another ecosystem, or npm has
    // not finished an install here yet.
  }
  let newest = 0;
  try {
    newest = statSync(buildDir).mtimeMs;
  } catch {
    return { at: null, marker: null };
  }
  for (const name of topLevelNames(buildDir)) {
    try {
      const info = statSync(join(buildDir, name));
      if (info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      // An entry that vanished while the folder was read is not an install time.
    }
  }
  return { at: new Date(newest), marker: null };
}

/** The cache name a moment gets: UTC `YYYYMMDDTHHMMSSZ`. */
function cacheStamp(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** The `createdAt` a cache's meta file carries, or nothing when it has none. */
function cacheMetaCreatedAt(path: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(path, CACHE_META_FILE), "utf8"));
  } catch {
    return null;
  }
  const createdAt = (parsed as { createdAt?: unknown } | null)?.createdAt;
  return typeof createdAt === "string" ? createdAt : null;
}

/**
 * The cache a build directory was filled from, found through its meta file.
 *
 * A cache is named after the moment it was made, and a second cache in the same
 * second carries `-2`, `-3` and so on, so the name is derived from the meta
 * rather than read back from the build directory: the meta is inside the cache,
 * not the path of it.
 */
export function cacheDirForCreatedAt(parent: string, createdAt: string): string | null {
  const stamp = cacheStamp(new Date(createdAt));
  if (stamp === null) return null;
  for (let suffix = 1; suffix <= 20; suffix += 1) {
    const path = join(parent, suffix === 1 ? stamp : `${stamp}-${String(suffix)}`);
    if (cacheMetaCreatedAt(path) === createdAt) return path;
  }
  return null;
}

/** One remote of a repository. */
export interface RepoRemote {
  name: string;
  url: string;
}

/** One repository in a listing. */
export interface RepoListing {
  id: string;
  gitDir: string;
  inPlace: boolean;
  remotes: RepoRemote[];
  defaultBranch: string | null;
  sizeBytes: number | null;
  hookInstalled: boolean;
}

/** One build directory of one worktree in a listing. */
export interface WorktreeBuildDirListing {
  dir: string;
  /** A subvolume, or a plain folder that the build tool made again. */
  mode: "subvolume" | "copy";
  filledFrom: string | null;
  installedAt: string | null;
  lockfileHash: string | null;
  sizeBytes: number | null;
}

/** One worktree in a listing. */
export interface WorktreeListing {
  repo: string;
  path: string;
  managed: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  createdAt: string | null;
  jobId: string | null;
  jobTitle: string | null;
  jobStatus: string | null;
  sizeBytes: number | null;
  buildDirs: WorktreeBuildDirListing[];
}

/** One cache in a listing. */
export interface CacheListing {
  repo: string;
  buildDir: string;
  path: string;
  createdAt: string;
  sourceWorktree: string | null;
  lockfileHash: string | null;
  readOnly: boolean;
  sizeBytes: number;
}

/** The whole registry, as `listRegistry` answers it. */
export interface RegistryListing {
  root: string;
  mode: RegistryMode;
  repos: RepoListing[];
  worktrees: WorktreeListing[];
  caches: CacheListing[];
}

/** What a caller may ask a listing for. */
export interface ListRegistryOptions {
  /** One repository, by name. Absent means every repository. */
  repo?: string;
  /** The job of a worktree, read by the caller that holds the job store. */
  jobLookup?: (jobId: string) => { title: string; status: string } | undefined;
}

/**
 * When a folder was made: its birth time, or its mtime where the file system
 * keeps no birth time. `null` when the folder cannot be read.
 */
function createdAtOf(path: string): string | null {
  try {
    const info = statSync(path);
    const at = info.birthtimeMs > 0 ? info.birthtime : info.mtime;
    return at.toISOString();
  } catch {
    return null;
  }
}

/** Describe one worktree of one repository. */
async function describeWorktree(
  settings: RegistrySettings,
  id: string,
  record: WorktreeRecord,
  opts: ListRegistryOptions,
  deps: BuildfsDeps,
): Promise<WorktreeListing> {
  const paths = registryPaths(settings.root);
  const managed = isInside(paths.worktrees, record.path);
  const rules = resolveBuildDirs(id, topLevelNames(record.path), settings.buildDirs);

  let dirty = false;
  const status = await git(deps, ["-C", record.path, "status", "--porcelain"]);
  if (status.code === 0) dirty = status.stdout.trim() !== "";

  const buildDirs: WorktreeBuildDirListing[] = [];
  for (const rule of rules) {
    const target = join(record.path, rule.dir);
    if (!existsSync(target)) continue;
    const stamp = installStamp(target);
    const lockPath = rule.lockfile === undefined ? undefined : join(record.path, rule.lockfile);
    const hash = lockPath !== undefined && existsSync(lockPath) ? lockfileHash(lockPath) : null;
    buildDirs.push({
      dir: rule.dir,
      mode: isSubvolume(target) ? "subvolume" : "copy",
      filledFrom: filledFromCache(cacheParent(settings.root, id, rule.dir), target),
      installedAt: stamp.at === null ? null : stamp.at.toISOString(),
      lockfileHash: hash,
      sizeBytes: managed ? await treeSize(target) : null,
    });
  }

  const jobId = jobIdFromWorktreeName(basename(record.path));
  let jobTitle: string | null = null;
  let jobStatus: string | null = null;
  if (jobId !== undefined && opts.jobLookup !== undefined) {
    try {
      const job = opts.jobLookup(jobId);
      if (job !== undefined) {
        jobTitle = job.title;
        jobStatus = job.status;
      }
    } catch {
      // A job store that cannot answer leaves these two fields empty and every
      // other field of the listing as it was.
    }
  }

  // The git admin folder of a linked worktree is where git keeps the moment it
  // made it; the main worktree of an in-place repository has none.
  const admin = await git(deps, ["-C", record.path, "rev-parse", "--git-dir"]);
  const adminPath = admin.code === 0 ? admin.stdout.trim() : "";
  const madeAt =
    adminPath === "" ? null : createdAtOf(isAbsolute(adminPath) ? adminPath : resolve(record.path, adminPath));

  return {
    repo: id,
    path: record.path,
    managed,
    branch: record.branch,
    head: record.head,
    dirty,
    createdAt: madeAt ?? createdAtOf(record.path),
    jobId: jobId ?? null,
    jobTitle,
    jobStatus,
    sizeBytes: managed ? await treeSize(record.path) : null,
    buildDirs,
  };
}

/**
 * The cache a worktree build directory was filled from.
 *
 * `fillBuildDir` leaves the cache's meta file inside the new directory, so the
 * moment it names is the way back to the cache folder. A directory that was
 * installed rather than filled has no meta file and answers null.
 */
function filledFromCache(parent: string, buildDir: string): string | null {
  const createdAt = cacheMetaCreatedAt(buildDir);
  return createdAt === null ? null : cacheDirForCreatedAt(parent, createdAt);
}

/** Every cache one repository keeps, for each build directory under it. */
async function describeCaches(
  settings: RegistrySettings,
  id: string,
  deps: BuildfsDeps,
): Promise<CacheListing[]> {
  const repoDir = join(registryPaths(settings.root).buildfs, id);
  const out: CacheListing[] = [];
  for (const buildDir of topLevelNames(repoDir).sort()) {
    if (!isDirectory(join(repoDir, buildDir))) continue;
    for (const cache of await listCaches(join(repoDir, buildDir), deps)) {
      out.push({
        repo: id,
        buildDir,
        path: cache.path,
        createdAt: cache.createdAt,
        sourceWorktree: cache.meta?.sourceWorktree ?? null,
        lockfileHash: cache.meta?.lockfileHash ?? null,
        readOnly: cache.readOnly,
        sizeBytes: await treeSize(cache.path),
      });
    }
  }
  return out;
}

/**
 * The repositories, worktrees and caches of the registry, in the one shape every
 * caller of a listing shares.
 *
 * A registry folder that does not exist is an empty registry, not an error: the
 * first `repos list` of an installation runs before anything is registered.
 *
 * Sizes are the one slow part, so they are read only where the number is worth
 * waiting for: the git directory of a repository, and the worktrees and caches
 * the registry itself made. A worktree an operator made elsewhere (`managed`
 * false) reports null, since walking it could read a whole home directory.
 */
export async function listRegistry(
  settings: RegistrySettings,
  opts: ListRegistryOptions = {},
  deps: BuildfsDeps = {},
): Promise<RegistryListing> {
  const paths = registryPaths(settings.root);
  if (!existsSync(paths.repos)) {
    return { root: paths.root, mode: settings.mode, repos: [], worktrees: [], caches: [] };
  }
  const mode = existsSync(paths.buildfs) ? await detectMode(paths.buildfs, settings.mode, deps) : settings.mode;

  const ids = opts.repo === undefined ? listRepoIds(settings) : [parseRepoName(opts.repo).id];
  const repos: RepoListing[] = [];
  const worktrees: WorktreeListing[] = [];
  const caches: CacheListing[] = [];

  for (const id of ids) {
    let ref: RepoRef | undefined;
    try {
      ref = repoRefOf(settings, id);
    } catch {
      // A record that does not parse is a repository this listing cannot read;
      // `doctor` reports it by name.
      continue;
    }
    if (ref === undefined) continue;
    const hook = checkHook(ref.gitDir, settings.root);
    const records = await worktreeRecords(ref.gitDir, deps).catch(() => [] as WorktreeRecord[]);
    repos.push({
      id: ref.id,
      gitDir: ref.gitDir,
      inPlace: ref.inPlace,
      remotes: await remotesOf(ref.gitDir, deps),
      defaultBranch: await defaultBranchOf(ref.gitDir, deps),
      sizeBytes: await treeSize(ref.gitDir),
      hookInstalled: hook.present && hook.executable && hook.configured && hook.matches,
    });
    for (const record of records) {
      if (record.bare) continue;
      worktrees.push(await describeWorktree(settings, id, record, opts, deps));
    }
    caches.push(...(await describeCaches(settings, id, deps)));
  }

  return { root: paths.root, mode, repos, worktrees, caches };
}

/** One repository with its worktrees and caches, the same shape as the listing. */
export async function showRepo(
  settings: RegistrySettings,
  name: string,
  opts: Omit<ListRegistryOptions, "repo"> = {},
  deps: BuildfsDeps = {},
): Promise<RegistryListing> {
  const ref = await resolveRepo(settings, name, deps);
  return listRegistry(settings, { ...opts, repo: ref.id }, deps);
}

/** One check of a doctor run. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * A check that reports a shortcoming the registry can still run without, such
   * as a mount option that only decides which removal method is used. It does
   * not make the whole report fail.
   */
  warning?: true;
}

/** What `doctorRegistry` found. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Check that the parts a registry depends on are in place.
 *
 * The protection hook is checked per repository and in four parts, because each
 * part fails differently: a missing file protects nothing, a file without the
 * execute bit is skipped by git, a file with other content belongs to another
 * tool, and a missing `pi-sec.registryRoot` makes the hook leave everything
 * alone. The buildfs checks run only when build directories are subvolumes,
 * since the inode number is what a backup skips by.
 *
 * The mount option is a warning: without it a subvolume is emptied and removed
 * through the fallback, which works, so it must not hide a real failure.
 */
export async function doctorRegistry(
  settings: RegistrySettings,
  deps: BuildfsDeps = {},
): Promise<DoctorReport> {
  const paths = registryPaths(settings.root);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "registry root",
    ok: existsSync(paths.root),
    detail: existsSync(paths.root) ? paths.root : `${paths.root} does not exist yet`,
  });

  for (const id of listRepoIds(settings)) {
    let ref: RepoRef | undefined;
    try {
      ref = repoRefOf(settings, id);
    } catch (error) {
      checks.push({ name: `record ${id}`, ok: false, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (ref === undefined) {
      checks.push({ name: `record ${id}`, ok: false, detail: "the registry lists it but neither a git directory nor a record is there" });
      continue;
    }
    const hook = checkHook(ref.gitDir, settings.root);
    checks.push({ name: `hook present ${id}`, ok: hook.present, detail: hook.present ? "reference-transaction is in the hooks folder" : "reference-transaction is missing" });
    checks.push({ name: `hook executable ${id}`, ok: hook.executable, detail: hook.executable ? "git may run it" : "git skips a hook it may not execute" });
    checks.push({ name: `hook configuration ${id}`, ok: hook.configured, detail: hook.configured ? `pi-sec.registryRoot is ${settings.root}` : "pi-sec.registryRoot does not name this root" });
    checks.push({ name: `hook content ${id}`, ok: hook.matches, detail: hook.matches ? "the file is the registry hook" : "the file holds other content" });
  }

  const listed = existsSync(paths.repos) ? await listRegistry(settings, {}, deps) : undefined;
  const mode = listed?.mode ?? settings.mode;
  checks.push({ name: "buildfs mode", ok: true, detail: mode });

  if (listed !== undefined && mode === "subvolume") {
    for (const worktree of listed.worktrees) {
      // Only a worktree the registry made keeps its build directory as a store of
      // its own. A worktree that an operator made elsewhere holds a folder their
      // own build tool installed, which is not this registry's to test.
      if (!worktree.managed) continue;
      for (const buildDir of worktree.buildDirs) {
        const path = join(worktree.path, buildDir.dir);
        checks.push({
          name: `subvolume ${path}`,
          ok: isSubvolume(path),
          detail: isSubvolume(path) ? "the inode number is 256" : "a plain folder, so a backup copies it",
        });
      }
    }
    for (const cache of listed.caches) {
      checks.push({
        name: `cache subvolume ${cache.path}`,
        ok: isSubvolume(cache.path),
        detail: isSubvolume(cache.path) ? "the inode number is 256" : "a plain folder, so a backup copies it",
      });
    }
  }

  const mount = mountOf(paths.buildfs, deps);
  if (mount !== undefined && mount.fsType === "btrfs") {
    const allowed = hasUserSubvolRmAllowed(paths.buildfs, mount.text);
    checks.push({
      name: "mount user_subvol_rm_allowed",
      ok: allowed,
      detail: allowed
        ? "a subvolume may be deleted without root"
        : "removal empties the tree and removes the folder instead",
      ...(allowed ? {} : { warning: true as const }),
    });
  }

  return { ok: checks.every((check) => check.ok || check.warning === true), checks };
}

/** The mount that owns a path, with the table it was read from. */
function mountOf(path: string, deps: BuildfsDeps): { fsType: string; text: string } | undefined {
  let text: string;
  try {
    text = deps.mountinfo === undefined ? readFileSync("/proc/self/mountinfo", "utf8") : deps.mountinfo();
  } catch {
    return undefined;
  }
  const mount = mountFor(parseMountinfo(text), path);
  return mount === undefined ? undefined : { fsType: mount.fsType, text };
}
