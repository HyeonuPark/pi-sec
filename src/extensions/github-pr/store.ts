import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { runGit } from "./git.ts";
import {
  isSafeNamePart,
  isSafeSlug,
  repoSlug,
  resolveNetworks,
  splitRepoSlug,
  type ForkNetwork,
  type NetworkReadFailure,
  type NetworkResolution,
  type RepoInfoReader,
  type RepoSlug,
} from "./network.ts";

/**
 * The bare repositories this extension keeps, and the rules around them.
 *
 * One bare repository holds one fork network (see `network.ts`), and every
 * repository in that network is a git remote in it. The layout is
 *
 *     ~/.pi/sec/gh-repo/<root owner>/<root repo>.git      (remote: <owner>/<repo>)
 *
 * with every part lowercase, because GitHub compares names without regard to
 * case. A remote name carries a slash on purpose: git then keeps that remote's
 * branches under `refs/remotes/<owner>/<repo>/`, so two forks of one repository
 * with the same branch name do not collide.
 *
 * Three rules shape the code below.
 *
 *   1. One git operation at a time per bare repository. A fetch of a pull
 *      request head, a fetch of a base branch and a reconcile's pruning must
 *      not interleave, or a prune can remove the remote a fetch is using. The
 *      lock here is a promise chain keyed by the bare repository's path, and it
 *      covers the whole of a diff computation, not one command.
 *   2. Nothing is deleted outside the root. Pruning walks only directories it
 *      finds exactly one level under `<root>/<owner>/`, checks the resolved path
 *      is under the root before it removes anything, refuses a symbolic link,
 *      and removes only a directory whose name ends in `.git`.
 *   3. The disk limit (0 means no limit) is checked once per network, before its first fetch. The
 *      size of a checkout cannot be known in advance, so the guard adds the
 *      current size of the root to GitHub's size for the network root, and
 *      refuses the first fetch of a network when that sum passes the limit. A
 *      network that already has refs is never refused, because refusing it
 *      would break a diff that used to work and delete nothing.
 *   4. Every name that reaches git is checked first. A remote name, a folder
 *      name and a branch name may come from GitHub's answer, and git reads an
 *      argument that starts with `-` as an option. One fetch option runs a
 *      command, so a name that fails the check never becomes an argument: the
 *      network is reported as refused and no folder is made for it.
 *
 * Everything the caller has to supply is injected: the root directory, the
 * remote URL rule (a test points it at a local repository), the reader that
 * resolves fork networks, and the clock.
 */

/** The default: 2048 MB, and the schema allows 0 (no limit) or 100 to 4096. */
export const DEFAULT_DISK_LIMIT_MEGABYTES = 2048;

/** How often a fork network is read again when nothing else asks for it. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RepoStoreOptions {
  /** Absolute path of the `gh-repo` directory. It is created on first use. */
  readonly root: string;
  /**
   * Cap on everything under the root, in megabytes. Default 2048. 0 means no limit.
   *
   * A function is called at every disk check, so a caller that reads the cap from
   * the config passes `() => config.githubPr.diskLimitMegabytes` and a reload
   * changes the cap without a new store. A number is a fixed cap.
   */
  readonly diskLimitMegabytes?: number | (() => number);
  /**
   * How a remote's URL is built from `owner/repo`. Default
   * `https://github.com/<owner>/<repo>.git`. A test returns a local path.
   */
  readonly remoteUrl?: (slug: RepoSlug) => string;
  /**
   * The reader that answers one repository's fork relation and size. The daemon
   * passes the `gh` read function (`network.ts` never calls `gh` itself), and a
   * test passes a table. Either this or `resolve` is needed; with neither, the
   * store refuses the first repository it is asked about and says why.
   */
  readonly read?: RepoInfoReader;
  /**
   * A whole network resolution, for a caller that has one already (a cached
   * resolution, a test that wants to control the grouping). It wins over `read`.
   */
  readonly resolve?: (repos: readonly string[]) => Promise<NetworkResolution>;
  /** The clock, for the 24-hour reconcile interval. */
  readonly now?: () => number;
  /** Override of the reconcile interval, for tests. */
  readonly reconcileIntervalMs?: number;
}

/** One configured repository, and where its history lives. */
export interface RepoHandle {
  /** Lowercase `owner/repo`, as configured. */
  readonly slug: RepoSlug;
  /** Lowercase `owner/repo` of the network root: the bare repository's name. */
  readonly root: RepoSlug;
  /** Absolute path of the bare repository. */
  readonly path: string;
  /** The git remote that names this repository inside the bare repository. */
  readonly remote: string;
}

/** How much space the root takes. */
export interface DiskUsage {
  readonly bytes: number;
  /** The same size in mebibytes, not rounded. The disk guard rounds it to whole megabytes. */
  readonly megabytes: number;
}

/** What one reconcile did. */
export interface ReconcileReport {
  /** Networks the resolve produced. */
  readonly networks: number;
  /** Remotes added, retargeted and removed, across all bare repositories. */
  readonly remotesAdded: number;
  readonly remotesUpdated: number;
  readonly remotesRemoved: number;
  /** Bare repositories whose last remote was removed and whose folder is gone. */
  readonly removedRepos: readonly string[];
  /** Repositories whose information could not be read, with the reader's message. */
  readonly failures: readonly NetworkReadFailure[];
  /** When the reconcile ran, from the injected clock. */
  readonly at: number;
}

/**
 * The refusal of a first fetch that would pass the disk limit.
 *
 * The fields are the ones the diff route answers with: HTTP 409 and
 * `{ "error": "disk_limit", "currentMegabytes", "estimateMegabytes",
 * "limitMegabytes" }`. The numbers are whole megabytes; the estimate comes from
 * GitHub's size for the network root and is approximate.
 */
export class DiskLimitError extends Error {
  readonly code = "disk_limit";
  readonly currentMegabytes: number;
  readonly estimateMegabytes: number;
  readonly limitMegabytes: number;

  constructor(currentMegabytes: number, estimateMegabytes: number, limitMegabytes: number) {
    super(
      `the disk limit for the git store is ${limitMegabytes} MB, it already holds ${currentMegabytes} MB, ` +
        `and this repository is estimated at ${estimateMegabytes} MB, so it was not fetched`,
    );
    this.name = "DiskLimitError";
    this.currentMegabytes = currentMegabytes;
    this.estimateMegabytes = estimateMegabytes;
    this.limitMegabytes = limitMegabytes;
  }

  /** The body the diff route answers with. */
  toPayload(): {
    error: "disk_limit";
    currentMegabytes: number;
    estimateMegabytes: number;
    limitMegabytes: number;
  } {
    return {
      error: "disk_limit",
      currentMegabytes: this.currentMegabytes,
      estimateMegabytes: this.estimateMegabytes,
      limitMegabytes: this.limitMegabytes,
    };
  }
}

/** Where one network's bare repository sits, and what it should contain. */
interface NetworkPlacement {
  readonly root: RepoSlug;
  readonly path: string;
  readonly members: readonly RepoSlug[];
  readonly estimateKilobytes: number;
}

interface MappedRepo {
  readonly handle: RepoHandle;
  readonly estimateKilobytes: number;
}

/**
 * The bare repositories of one `gh-repo` root.
 *
 * One instance per daemon: it holds the network mapping and the reconcile clock,
 * and it is what gives the diff module its lock.
 */
export class RepoStore {
  /** Absolute path of `gh-repo`. */
  readonly root: string;

  private readonly diskLimit: () => number;
  private readonly remoteUrl: (slug: RepoSlug) => string;
  private readonly resolver: (repos: readonly string[]) => Promise<NetworkResolution>;
  private readonly clock: () => number;
  private readonly reconcileIntervalMs: number;
  /** Current mapping, replaced as a whole by a reconcile. */
  private mapping = new Map<RepoSlug, MappedRepo>();
  /** Tail of the promise chain per bare repository path. */
  private readonly chains = new Map<string, Promise<void>>();
  private lastReconcileAt: number | undefined;
  private lastSignature: string | undefined;

  constructor(options: RepoStoreOptions) {
    this.root = options.root;
    // A function is read at every check, so the cap follows the config without a
    // new store; a number becomes a function that always answers it.
    const limit = options.diskLimitMegabytes ?? DEFAULT_DISK_LIMIT_MEGABYTES;
    this.diskLimit = typeof limit === "function" ? limit : () => limit;
    this.remoteUrl = options.remoteUrl ?? ((slug) => `https://github.com/${slug}.git`);
    const read = options.read;
    this.resolver =
      options.resolve ??
      (read === undefined
        ? unreachableResolver
        : (repos) => resolveNetworks(repos, read));
    this.clock = options.now ?? (() => Date.now());
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  }

  /** The handle of a repository the last reconcile mapped, or `undefined`. */
  forRepo(name: string): RepoHandle | undefined {
    return this.mapping.get(repoSlug(name))?.handle;
  }

  /** Every repository the last reconcile mapped, sorted by slug. */
  mappedRepos(): readonly RepoHandle[] {
    return [...this.mapping.values()].map((entry) => entry.handle).sort((a, b) => compare(a.slug, b.slug));
  }

  /**
   * Run one task with the bare repository of `name` prepared and locked.
   *
   * The task gets the bare repository's path and remote, and no other git
   * operation in that bare repository runs until it returns: the folder check,
   * the remote check and the task itself are one unit, so a reconcile cannot
   * take a remote away in the middle of a fetch. This call may throw
   * `DiskLimitError`.
   */
  async withRepo<T>(name: string, task: (handle: RepoHandle) => Promise<T>): Promise<T> {
    const mapped = await this.mappedOrRead(name);
    return this.withLock(mapped.handle.path, async () => {
      await this.prepareLocked(mapped.handle, mapped.estimateKilobytes);
      return task(mapped.handle);
    });
  }

  /**
   * Lock one bare repository by path and run `task`.
   *
   * Exposed for the diff module, which holds the lock across a fetch, a
   * merge-base and a diff, and for the tests that check the lock itself.
   */
  async withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(path) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.chains.set(path, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.chains.get(path) === tail) this.chains.delete(path);
    }
  }

  /**
   * Make sure the bare repository of `name` exists, its directory is private and
   * its remote is registered. Returns without doing anything when all three hold.
   *
   * The disk guard runs here, because this is the only place a network's first
   * fetch can start.
   */
  async prepare(name: string): Promise<RepoHandle> {
    const mapped = await this.mappedOrRead(name);
    await this.withLock(mapped.handle.path, () => this.prepareLocked(mapped.handle, mapped.estimateKilobytes));
    return mapped.handle;
  }

  /** The mapping entry for `name`, read on the spot when the last reconcile did not map it. */
  private async mappedOrRead(name: string): Promise<MappedRepo> {
    const mapped = this.mapping.get(repoSlug(name));
    if (mapped !== undefined) return mapped;
    return this.mapSingle(name);
  }

  /** The work `prepare` does inside the lock: layout, bare repository, remote, disk guard. */
  private async prepareLocked(handle: RepoHandle, estimateKilobytes: number): Promise<void> {
    await this.ensureLayout(handle.path);
    await this.ensureRepoAtPath(handle.path, estimateKilobytes);
    await this.syncRemote(handle.path, handle.remote);
  }

  /**
   * Resolve the fork networks of `repos`, then make the bare repositories and
   * their remotes match that resolution.
   *
   * Matching means: every configured repository is a remote in its network's
   * bare repository with the right URL, every remote that names a repository no
   * longer configured is removed, and a bare repository left with no remotes is
   * removed with its folder. A repository that moved to another network is
   * removed from the old one by the first rule and added to the new one by this
   * rule, which is what "moving" amounts to.
   *
   * A repository whose information cannot be read keeps its previous place and
   * is not pruned: a failed `gh` read must not cost the history that is already
   * on disk. The failure is in the report so the caller can show it.
   */
  async reconcile(repos: readonly string[]): Promise<ReconcileReport> {
    const resolution = await this.resolver(repos);
    const previous = this.mapping;
    const { placements, refused } = this.placementsOf(resolution);
    const next = new Map<RepoSlug, MappedRepo>();

    for (const placement of placements) {
      for (const member of placement.members) {
        next.set(member, {
          handle: { slug: member, root: placement.root, path: placement.path, remote: member },
          estimateKilobytes: placement.estimateKilobytes,
        });
      }
    }

    const failed = new Set([...resolution.failures, ...refused].map((failure) => repoSlug(failure.repo)));
    for (const slug of failed) {
      const kept = previous.get(slug);
      if (kept !== undefined) next.set(slug, kept);
    }
    this.mapping = next;

    let remotesAdded = 0;
    let remotesUpdated = 0;
    const refusals: NetworkReadFailure[] = [];
    for (const placement of placements) {
      try {
        const counts = await this.withLock(placement.path, async () => {
          await this.ensureLayout(placement.path);
          await this.ensureRepoAtPath(placement.path, placement.estimateKilobytes);
          let added = 0;
          let updated = 0;
          for (const member of placement.members) {
            const outcome = await this.syncRemote(placement.path, member);
            if (outcome === "added") added += 1;
            if (outcome === "updated") updated += 1;
          }
          return { added, updated };
        });
        remotesAdded += counts.added;
        remotesUpdated += counts.updated;
      } catch (error) {
        // The disk guard refuses a network whose first fetch would pass the
        // limit. That is one network's answer, not the end of the reconcile:
        // the others are made ready, and this one is reported. A diff that asks
        // for it throws the same refusal with the same numbers.
        if (error instanceof DiskLimitError) {
          refusals.push({ repo: placement.root, message: error.message });
          continue;
        }
        throw error;
      }
    }

    // What pruning may not touch: a remote whose repository is still configured
    // but could not be read this time, or whose name this store refused. Its
    // place in the mapping is unknown, so removing its remote could cost history
    // that the next read would want back.
    const keep = new Set<RepoSlug>();
    for (const failure of [...resolution.failures, ...refused]) {
      const slug = repoSlug(failure.repo);
      if (!keep.has(slug)) keep.add(slug);
    }
    const pruned = await this.prune(keep);
    this.lastReconcileAt = this.clock();
    this.lastSignature = signatureOf(repos);

    return {
      networks: resolution.networks.length,
      remotesAdded,
      remotesUpdated,
      remotesRemoved: pruned.remotesRemoved,
      removedRepos: pruned.removedRepos,
      failures: [...resolution.failures, ...refused, ...refusals],
      at: this.lastReconcileAt,
    };
  }

  /**
   * Reconcile when it is due: at the first call, when the configured list
   * changed since the last reconcile, or when the interval has passed.
   * Answers `undefined` when it was not due.
   */
  async reconcileIfDue(repos: readonly string[]): Promise<ReconcileReport | undefined> {
    const signature = signatureOf(repos);
    if (this.lastReconcileAt === undefined) return this.reconcile(repos);
    if (signature !== this.lastSignature) return this.reconcile(repos);
    if (this.clock() - this.lastReconcileAt >= this.reconcileIntervalMs) return this.reconcile(repos);
    return undefined;
  }

  /** How much the root holds. A root that does not exist yet holds nothing. */
  async usage(): Promise<DiskUsage> {
    const bytes = await treeBytes(this.root);
    return { bytes, megabytes: bytes / (1024 * 1024) };
  }

  /**
   * The networks of a resolution, with their absolute paths.
   *
   * A network with a name this store cannot use is left out, and the caller gets
   * it as a refusal: a repository that silently vanished from the mapping would
   * be a page that never loads and no message that says why.
   */
  private placementsOf(resolution: NetworkResolution): {
    readonly placements: readonly NetworkPlacement[];
    readonly refused: readonly NetworkReadFailure[];
  } {
    const placements: NetworkPlacement[] = [];
    const refused: NetworkReadFailure[] = [];
    for (const network of resolution.networks) {
      const path = this.pathOf(network);
      if (path === undefined) {
        for (const member of network.members) {
          refused.push({
            repo: member.slug,
            message: "the repository name holds a character this store cannot use as a remote name",
          });
        }
        continue;
      }
      placements.push({
        root: network.root,
        path,
        members: network.members.map((member) => member.slug),
        estimateKilobytes: network.estimateKilobytes,
      });
    }
    return { placements, refused };
  }

  /**
   * The bare repository path of a network, or `undefined` when any name the
   * network would use is unsafe. A refused network is left out of the mapping
   * entirely: no folder, no remote, no git argument built from that name.
   */
  private pathOf(network: ForkNetwork): string | undefined {
    const parts = splitRepoSlug(network.root);
    if (parts === undefined) return undefined;
    if (!isSafeNamePart(parts.owner) || !isSafeNamePart(parts.repo)) return undefined;
    for (const member of network.members) {
      if (!isSafeSlug(member.slug)) return undefined;
    }
    return join(this.root, parts.owner.toLowerCase(), `${parts.repo.toLowerCase()}.git`);
  }

  /** Map one repository on its own, for a diff that arrives before a reconcile. */
  private async mapSingle(name: string): Promise<MappedRepo> {
    const resolution = await this.resolver([name]);
    const { placements, refused } = this.placementsOf(resolution);
    for (const placement of placements) {
      for (const member of placement.members) {
        this.mapping.set(member, {
          handle: { slug: member, root: placement.root, path: placement.path, remote: member },
          estimateKilobytes: placement.estimateKilobytes,
        });
      }
    }
    const mapped = this.mapping.get(repoSlug(name));
    if (mapped !== undefined) return mapped;
    const failure = refused[0] ?? resolution.failures[0];
    throw new Error(
      failure === undefined
        ? `no fork network holds ${name}`
        : `${failure.repo}: ${failure.message}`,
    );
  }

  /** Create the root, the owner directory and the bare repository directory, mode 0700. */
  private async ensureLayout(path: string): Promise<void> {
    const ownerDir = join(path, "..");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(ownerDir, 0o700);
  }

  /**
   * Create the bare repository at `path` when it is missing, or when it exists
   * without a ref (an earlier attempt that did not finish), and make it private.
   *
   * The disk guard runs only in those two states: a bare repository with a ref
   * is a network that was fetched, and its later fetches are never refused.
   */
  private async ensureRepoAtPath(path: string, estimateKilobytes: number): Promise<void> {
    const exists = await isDirectory(path);
    if (!exists) {
      await this.guardDisk(estimateKilobytes);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await runGit(path, ["init", "--bare", "--quiet"]);
    } else if (!(await isBareRepo(path))) {
      // A folder that is not a git repository: an interrupted attempt left it.
      // It is under the root and named like a bare repository, so it is this
      // extension's own, and it is initialized rather than removed.
      await this.guardDisk(estimateKilobytes);
      await runGit(path, ["init", "--bare", "--quiet"]);
    } else if (!(await hasRefs(path))) {
      await this.guardDisk(estimateKilobytes);
    }
    await chmod(path, 0o700);
  }

  /**
   * Refuse the first fetch of a network when the root plus the estimate passes
   * the limit. The estimate is GitHub's size for the network root in kilobytes.
   */
  private async guardDisk(estimateKilobytes: number): Promise<void> {
    // The cap is read here, at the check, and not when the store was made.
    // 0 means no limit: the root is not walked and nothing is refused.
    const limitMegabytes = this.diskLimit();
    if (limitMegabytes === 0) return;
    const usage = await this.usage();
    const currentMegabytes = toMegabytes(usage.bytes);
    const estimateMegabytes = toMegabytes(estimateKilobytes * 1024);
    if (currentMegabytes + estimateMegabytes > limitMegabytes) {
      throw new DiskLimitError(currentMegabytes, estimateMegabytes, limitMegabytes);
    }
  }

  /** Add the remote, or point it at the right URL. */
  private async syncRemote(path: string, remote: string): Promise<"added" | "updated" | "unchanged"> {
    const url = this.remoteUrl(remote);
    const listed = await runGit(path, ["remote"], { check: false });
    const names = listed.stdout.split("\n").map((line) => line.trim());
    if (!names.includes(remote)) {
      await runGit(path, ["remote", "add", remote, url]);
      return "added";
    }
    const current = await runGit(path, ["remote", "get-url", remote], { check: false });
    if (current.code === 0 && current.stdout.trim() === url) return "unchanged";
    await runGit(path, ["remote", "set-url", remote, url]);
    return "updated";
  }

  /**
   * Remove what the current mapping no longer names: remotes that belong to no
   * configured repository, and bare repositories left with no remote.
   *
   * Only `<root>/<owner>/<repo>.git` directories are considered, every removal
   * is checked against the resolved root, and a symbolic link is skipped.
   *
   * `keep` holds the repositories whose fork network could not be read this
   * time. Their remotes stay, and while the set is not empty no bare repository
   * folder is removed: a folder this run cannot place might be the store of one
   * of them, and the next successful read would have to fetch it again. A stale
   * folder is cheaper than a refetch of tens of megabytes.
   */
  private async prune(keep: ReadonlySet<RepoSlug>): Promise<{ remotesRemoved: number; removedRepos: string[] }> {
    const mayRemoveRepo = keep.size === 0;
    let remotesRemoved = 0;
    const removedRepos: string[] = [];
    if (!(await isDirectory(this.root))) return { remotesRemoved, removedRepos };

    const rootReal = await realpathOf(this.root);
    // Compare resolved paths: a root reached through a symbolic link would
    // otherwise match no mapping entry, and its remotes would all be removed.
    const mappedByReal = new Map<string, Set<RepoSlug>>();
    for (const mapped of this.mapping.values()) {
      const real = await realpathOf(mapped.handle.path);
      const set = mappedByReal.get(real) ?? new Set<RepoSlug>();
      set.add(mapped.handle.remote);
      mappedByReal.set(real, set);
    }
    const owners = await readdirSafe(this.root);
    for (const owner of owners) {
      if (!isSafeNamePart(owner)) continue;
      const ownerDir = join(this.root, owner);
      if (!(await isDirectory(ownerDir))) continue;
      for (const entry of await readdirSafe(ownerDir)) {
        if (!entry.endsWith(".git")) continue;
        const name = entry.slice(0, -".git".length);
        if (!isSafeNamePart(name)) continue;
        const path = join(ownerDir, entry);
        // `lstat`, not `stat`: a symbolic link named like a bare repository is
        // skipped, so a link cannot make this code touch anything outside.
        const info = await lstatSafe(path);
        if (info === undefined || !info.isDirectory()) continue;
        const real = await realpathOf(path);
        if (!isInside(rootReal, real)) continue;

        const wanted = new Set<RepoSlug>(keep);
        for (const remote of mappedByReal.get(real) ?? []) wanted.add(remote);

        remotesRemoved += await this.withLock(path, async () => {
          const listed = await runGit(path, ["remote"], { check: false });
          if (listed.code !== 0) return 0;
          const names = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
          let removed = 0;
          for (const remote of names) {
            if (wanted.has(remote)) continue;
            await runGit(path, ["remote", "remove", remote], { check: false });
            removed += 1;
          }
          const left = (await runGit(path, ["remote"], { check: false })).stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          // A bare repository that names no repository any more is removed with
          // its folder, including one that never had a remote: its history is
          // fetched again from GitHub when a diff next needs it. Nothing is
          // removed while a read failed, because the mapping is then incomplete.
          if (mayRemoveRepo && left.length === 0 && wanted.size === 0 && isInside(rootReal, real)) {
            await rm(real, { recursive: true, force: true });
            removedRepos.push(`${owner}/${name}`);
          }
          return removed;
        });
      }
    }
    return { remotesRemoved, removedRepos };
  }
}

/** Create the store of one `gh-repo` root. */
export function createRepoStore(options: RepoStoreOptions): RepoStore {
  return new RepoStore(options);
}

/** A resolution that refuses, so a store built without a reader says what is missing. */
const unreachableResolver = (): Promise<never> =>
  Promise.reject(new Error("this repository store was built without a repository reader"));

/** Milliseconds value to whole megabytes, rounded to the nearest one. */
function toMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function signatureOf(repos: readonly string[]): string {
  return [...new Set(repos.map((name) => repoSlug(name)))].sort().join(",");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await lstatSafe(path);
  return info !== undefined && info.isDirectory();
}

/** `lstat`, as a value: `undefined` when the path is gone or unreadable-name. */
async function lstatSafe(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function realpathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Whether `candidate` sits under `root`, strictly: a path equal to the root is
 * not inside it, so this is what guards every removal.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Whether the directory at `path` is itself a bare repository.
 *
 * This reads the three things `git init --bare` writes, and it does not ask git:
 * `git rev-parse` walks up from the working directory and would answer for a
 * parent repository, so a folder inside another repository would look like a
 * bare repository and the store would never initialize it.
 */
async function isBareRepo(path: string): Promise<boolean> {
  if (!(await isDirectory(join(path, "objects")))) return false;
  if (!(await isDirectory(join(path, "refs")))) return false;
  const head = await lstatSafe(join(path, "HEAD"));
  return head !== undefined && head.isFile();
}

/** Whether the bare repository at `path` has any ref: a fetch has landed there. */
async function hasRefs(path: string): Promise<boolean> {
  const result = await runGit(path, ["rev-parse", "--all"], { check: false });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/** Every regular file under `dir`, summed. Symbolic links are skipped. */
export async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const info = await lstatSafe(full);
        if (info !== undefined) total += info.size;
      }
    }
  }
  return total;
}
