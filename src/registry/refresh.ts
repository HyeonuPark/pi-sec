import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildfsDeps } from "./buildfs.ts";
import {
  detectMode,
  listCaches,
  lockfileHash,
  pruneCaches,
  snapshotToCache,
  type BuildfsMode,
  type CacheEntry,
} from "./buildfs.ts";
import {
  cacheParent,
  ensureRegistryDirs,
  registryPaths,
  resolveBuildDirs,
  type RegistrySettings,
  type ResolvedBuildDir,
} from "./layout.ts";
import {
  installStamp,
  isInside,
  listRepoIds,
  resolveRepo,
  topLevelNames,
  worktreeRecords,
  type WorktreeRecord,
} from "./store.ts";

/**
 * Keeping the caches of build directories current.
 *
 * A cache saves an install, so the newest install of a repository is the one
 * worth copying: it is a build directory that the packages of the current
 * lockfile actually produced. A refresh therefore looks at every managed
 * worktree, picks the one whose install finished last, and turns that build
 * directory into a cache unless the newest cache already came from the same
 * lockfile and is newer than the install.
 *
 * Two things keep the work bounded. A lock folder in the registry state makes
 * two runs (the daemon's and an operator's) take turns, and a lock left behind
 * by a run that died is taken over after two hours. Each repository and each
 * build directory is handled on its own, so one failed snapshot is reported in
 * its own entry and the rest of the run continues.
 *
 * Pruning is the only irreversible step: the caches past `cacheKeep` are deleted
 * and rebuilding one needs the network and the install time.
 */

/** What one repository and build directory produced. */
export interface RefreshEntry {
  repo: string;
  /** The build directory, or null when the repository could not be read at all. */
  buildDir: string | null;
  /** `created`: a new cache; `skipped`: the newest cache is current; `none`: nothing to do. */
  action: "created" | "skipped" | "none";
  cache?: CacheEntry;
  pruned: string[];
  reason?: string;
}

/** A refresh lock older than this belongs to a run that died, and is taken over. */
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Read a JSON file, or nothing when it cannot be read or parsed. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The `packages` map of a lockfile, or nothing when the file is not one. */
function packagesOf(value: unknown): Record<string, unknown> | undefined {
  const packages = (value as { packages?: unknown } | null)?.packages;
  if (packages === null || typeof packages !== "object") return undefined;
  return packages as Record<string, unknown>;
}

/** The `version` field of one lockfile entry. */
function versionOf(entry: unknown): unknown {
  return (entry as { version?: unknown } | null)?.version;
}

/** Whether one lockfile entry is marked optional. */
function isOptional(entry: unknown): boolean {
  return (entry as { optional?: unknown } | null)?.optional === true;
}

/**
 * Whether an npm install marker still describes the packages of its lockfile.
 *
 * npm writes `node_modules/.package-lock.json` at the end of an install, and the
 * file holds the packages that are actually there. It matches `package-lock.json`
 * when every package of the marker is in the lockfile with the same version, and
 * every package of the lockfile that is not the root entry and not optional is in
 * the marker. A lockfile that lists a package the install never wrote means the
 * install did not follow that lockfile, and such a worktree is no source for a
 * cache.
 */
export function markerMatches(markerFile: string, lockfile: string): boolean {
  const marker = packagesOf(readJson(markerFile));
  const lock = packagesOf(readJson(lockfile));
  if (marker === undefined || lock === undefined) return false;
  for (const [key, entry] of Object.entries(marker)) {
    const other = lock[key];
    if (other === undefined) return false;
    if (versionOf(other) !== versionOf(entry)) return false;
  }
  for (const [key, entry] of Object.entries(lock)) {
    if (key === "") continue;
    if (isOptional(entry)) continue;
    if (!(key in marker)) return false;
  }
  return true;
}

/** One worktree that could be the source of a cache. */
interface Candidate {
  worktree: string;
  /** The moment its build directory finished installing. */
  at: Date;
  /** Its lockfile hash, or null when the rule names no lockfile. */
  lockHash: string | null;
}

/**
 * The worktrees of one repository whose build directory of `rule` is installed
 * and can be trusted for that rule's lockfile.
 */
function candidatesFor(rule: ResolvedBuildDir, worktrees: readonly WorktreeRecord[]): Candidate[] {
  const npm = rule.lockfile === "package-lock.json";
  const out: Candidate[] = [];
  for (const record of worktrees) {
    const dir = join(record.path, rule.dir);
    if (!existsSync(dir)) continue;
    const lockPath = rule.lockfile === undefined ? undefined : join(record.path, rule.lockfile);
    const lockHash = lockPath !== undefined && existsSync(lockPath) ? lockfileHash(lockPath) : null;
    const stamp = installStamp(dir);
    if (stamp.at === null) continue;
    if (npm) {
      // An npm worktree without its marker, or with a marker that does not
      // describe its lockfile, was never installed from that lockfile.
      if (stamp.marker === null || lockPath === undefined || lockHash === null) continue;
      if (!markerMatches(stamp.marker, lockPath)) continue;
    }
    out.push({ worktree: record.path, at: stamp.at, lockHash });
  }
  return out;
}

/** The newest cache, when it is current for this candidate. */
function isCurrent(newest: CacheEntry | undefined, candidate: Candidate): boolean {
  if (newest?.meta === undefined) return false;
  const hash = candidate.lockHash ?? "";
  if (newest.meta.lockfileHash !== hash) return false;
  const made = Date.parse(newest.meta.createdAt);
  if (!Number.isFinite(made)) return false;
  return candidate.at.getTime() <= made;
}

/** The build directories of one repository: the ones a worktree needs, and any that has caches. */
function buildDirsOf(settings: RegistrySettings, id: string, worktrees: readonly WorktreeRecord[]): ResolvedBuildDir[] {
  const rules = new Map<string, ResolvedBuildDir>();
  for (const record of worktrees) {
    for (const rule of resolveBuildDirs(id, topLevelNames(record.path), settings.buildDirs)) {
      if (!rules.has(rule.dir)) rules.set(rule.dir, rule);
    }
  }
  // A build directory with caches whose worktree is gone still has caches to keep
  // or prune, and the folder is what the registry knows about it.
  const repoDir = join(registryPaths(settings.root).buildfs, id);
  for (const name of topLevelNames(repoDir)) {
    if (!rules.has(name)) rules.set(name, { dir: name });
  }
  return [...rules.values()];
}

/** The managed worktrees of one repository: the folders under the registry's worktrees. */
async function managedWorktrees(
  settings: RegistrySettings,
  id: string,
  deps: BuildfsDeps,
): Promise<WorktreeRecord[]> {
  const gitDir = (await resolveRepo(settings, id, deps)).gitDir;
  const root = registryPaths(settings.root).worktrees;
  return (await worktreeRecords(gitDir, deps)).filter((record) => !record.bare && isInside(root, record.path));
}

/** Refresh one build directory of one repository, then prune its caches. */
async function refreshBuildDir(
  settings: RegistrySettings,
  id: string,
  rule: ResolvedBuildDir,
  worktrees: readonly WorktreeRecord[],
  mode: BuildfsMode,
  deps: BuildfsDeps,
): Promise<RefreshEntry> {
  const paths = registryPaths(settings.root);
  const parent = cacheParent(settings.root, id, rule.dir);
  const entry: RefreshEntry = { repo: id, buildDir: rule.dir, action: "none", pruned: [] };

  try {
    const candidates = candidatesFor(rule, worktrees);
    if (candidates.length === 0) {
      entry.reason = `no worktree holds an installed ${rule.dir} for this lockfile`;
    } else {
      const newest = (await listCaches(parent, deps))[0];
      const candidate = [...candidates].sort((a, b) => b.at.getTime() - a.at.getTime())[0] as Candidate;
      if (mode === "none") {
        entry.reason = "the buildfs mode is none, so no cache is kept";
      } else if (isCurrent(newest, candidate)) {
        entry.action = "skipped";
        entry.reason = `the newest cache already holds the lockfile of ${candidate.worktree}`;
      } else {
        entry.cache = await snapshotToCache(
          {
            mode,
            source: join(candidate.worktree, rule.dir),
            cacheParent: parent,
            meta: {
              repo: id,
              buildDir: rule.dir,
              sourceWorktree: candidate.worktree,
              lockfileHash: candidate.lockHash ?? "",
            },
          },
          deps,
        );
        entry.action = "created";
      }
    }
  } catch (error) {
    entry.reason = error instanceof Error ? error.message : String(error);
  }

  try {
    entry.pruned = await pruneCaches(parent, settings.cacheKeep, { allowedRoot: paths.buildfs, mode }, deps);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    entry.reason = entry.reason === undefined ? text : `${entry.reason}; pruning failed: ${text}`;
  }
  return entry;
}

/** The refresh lock, or null when another run holds it. */
function takeLock(stateDir: string): string | null {
  const lock = join(stateDir, "refresh.lock");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock, { mode: 0o700 });
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    // Released between the two calls; this run leaves the next one to it.
    return null;
  }
  if (age <= LOCK_MAX_AGE_MS) return null;
  // A run that died left the folder behind. An mtime this old is not a run that
  // is still working: no snapshot takes two hours.
  rmSync(lock, { recursive: true, force: true });
  try {
    mkdirSync(lock, { mode: 0o700 });
    return lock;
  } catch {
    return null;
  }
}

/** Release the refresh lock. */
function releaseLock(lock: string): void {
  try {
    rmdirSync(lock);
  } catch {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // A leftover lock is taken over after LOCK_MAX_AGE_MS; failing to remove it
      // must not hide the refresh result.
    }
  }
}

/** Record when the caches were last refreshed. */
function writeLastRefresh(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8" });
}

/**
 * Refresh the caches of one repository, or of every repository when `repo` is
 * absent.
 *
 * A registry that does not exist yet is nothing to do, and a run that finds the
 * lock held returns an empty list rather than waiting: the next hourly check of
 * the daemon comes soon enough.
 */
export async function refreshCaches(
  settings: RegistrySettings,
  repo?: string,
  deps: BuildfsDeps = {},
): Promise<RefreshEntry[]> {
  const paths = registryPaths(settings.root);
  if (!existsSync(paths.repos)) return [];
  await ensureRegistryDirs(settings.root);
  const lock = takeLock(paths.state);
  if (lock === null) return [];

  try {
    const ids = repo === undefined ? listRepoIds(settings) : [(await resolveRepo(settings, repo, deps)).id];
    const mode = await detectMode(paths.buildfs, settings.mode, deps);
    const entries: RefreshEntry[] = [];
    for (const id of ids) {
      let worktrees: WorktreeRecord[];
      try {
        worktrees = await managedWorktrees(settings, id, deps);
      } catch (error) {
        entries.push({
          repo: id,
          buildDir: null,
          action: "none",
          pruned: [],
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const rule of buildDirsOf(settings, id, worktrees)) {
        entries.push(await refreshBuildDir(settings, id, rule, worktrees, mode, deps));
      }
    }
    writeLastRefresh(paths.lastRefresh);
    return entries;
  } finally {
    releaseLock(lock);
  }
}

/** Delete the caches past `cacheKeep`, and nothing else. */
export async function pruneAll(
  settings: RegistrySettings,
  repo?: string,
  deps: BuildfsDeps = {},
): Promise<RefreshEntry[]> {
  const paths = registryPaths(settings.root);
  if (!existsSync(paths.repos)) return [];
  await ensureRegistryDirs(settings.root);
  const lock = takeLock(paths.state);
  if (lock === null) return [];

  try {
    const ids = repo === undefined ? listRepoIds(settings) : [(await resolveRepo(settings, repo, deps)).id];
    const mode = await detectMode(paths.buildfs, settings.mode, deps);
    const entries: RefreshEntry[] = [];
    for (const id of ids) {
      let worktrees: WorktreeRecord[];
      try {
        worktrees = await managedWorktrees(settings, id, deps);
      } catch (error) {
        entries.push({
          repo: id,
          buildDir: null,
          action: "none",
          pruned: [],
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const rule of buildDirsOf(settings, id, worktrees)) {
        const entry: RefreshEntry = { repo: id, buildDir: rule.dir, action: "none", pruned: [] };
        try {
          entry.pruned = await pruneCaches(
            cacheParent(settings.root, id, rule.dir),
            settings.cacheKeep,
            { allowedRoot: paths.buildfs, mode },
            deps,
          );
        } catch (error) {
          entry.reason = error instanceof Error ? error.message : String(error);
        }
        entries.push(entry);
      }
    }
    return entries;
  } finally {
    releaseLock(lock);
  }
}

/** How a timer is armed and cancelled, so a test can drive the clock itself. */
export interface BuildfsRefresherTimers {
  set(callback: () => void, delayMs: number): { cancel(): void };
}

/** The first check runs a few minutes after the daemon starts, then once an hour. */
const FIRST_CHECK_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const SYSTEM_TIMERS: BuildfsRefresherTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    // Unreferenced: a pending check must not keep the process alive.
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface BuildfsRefresherOptions {
  /** The settings to use, read at each check so a reloaded config takes effect. */
  settings: () => RegistrySettings;
  log: (line: string) => void;
  timers?: BuildfsRefresherTimers;
  now?: () => number;
  deps?: BuildfsDeps;
}

/**
 * Runs the cache refresh when it is due: five minutes after the daemon starts,
 * then once an hour.
 *
 * The first check is delayed rather than run at once, so a daemon restart does
 * not start a snapshot in the middle of boot. Each check reads
 * `state/last-refresh.json` and refreshes only when that file is missing or older
 * than `refreshHours`, which is what makes an hourly check a daily refresh.
 *
 * A failure is one line in the log and nothing else: a refresh that failed has
 * nothing to report to a user, and the next check tries again.
 */
export class BuildfsRefresher {
  private readonly options: BuildfsRefresherOptions;
  private timer: { cancel(): void } | undefined;
  private stopped = false;
  private running = false;

  constructor(options: BuildfsRefresherOptions) {
    this.options = options;
  }

  /** Arm the first check. A second call while one is armed does nothing. */
  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.arm(FIRST_CHECK_MS);
  }

  /** Cancel the timer. A run that is already working finishes on its own. */
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** Refresh once, whatever the recorded time says. It never throws. */
  async runOnce(): Promise<void> {
    try {
      const settings = this.options.settings();
      if (!existsSync(settings.root)) return;
      await refreshCaches(settings, undefined, this.options.deps ?? {});
    } catch (error) {
      this.options.log(`registry cache refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Whether a refresh is due, from the time the last one recorded. */
  private due(settings: RegistrySettings): boolean {
    const raw = readJson(registryPaths(settings.root).lastRefresh);
    const at = Date.parse(String((raw as { at?: unknown } | null)?.at ?? ""));
    if (!Number.isFinite(at)) return true;
    const now = this.options.now?.() ?? Date.now();
    return now - at > settings.refreshHours * 60 * 60 * 1000;
  }

  /** One scheduled check, then the next hour's timer. */
  private async check(): Promise<void> {
    if (this.running) return;
    let settings: RegistrySettings;
    try {
      settings = this.options.settings();
    } catch (error) {
      this.options.log(`registry settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (existsSync(settings.root) && this.due(settings)) {
      this.running = true;
      try {
        await this.runOnce();
      } finally {
        this.running = false;
      }
    }
  }

  private arm(delayMs: number): void {
    const timers = this.options.timers ?? SYSTEM_TIMERS;
    this.timer = timers.set(() => {
      this.timer = undefined;
      void this.check().finally(() => {
        if (!this.stopped) this.arm(CHECK_INTERVAL_MS);
      });
    }, delayMs);
  }
}
