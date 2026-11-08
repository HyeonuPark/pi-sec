/**
 * Fork networks: which configured repositories share one bare repository.
 *
 * GitHub reports, for every repository, whether it is a fork and, when it is,
 * which repository it was forked from (`source`). Forks of one repository
 * share their history, so one bare repository holds them all and every member
 * is a remote in it; a diff of a pull request then compares objects that are
 * already local instead of fetching a second copy of the same history.
 *
 * This module never calls `gh`. It takes a reader that returns one
 * repository's information, so the caller owns that call (and its caching,
 * its error handling and its tests) and this module stays a pure grouping
 * rule. The grouping is:
 *
 *   - repositories whose `source` is the same repository share one network;
 *   - a fork that reports no `source` is the root of a network of its own. A
 *     private fork can answer this way, and a diff still comes out right: it
 *     costs the disk of one more bare repository;
 *   - a repository that is not a fork is the root of its own network;
 *   - a repository whose information cannot be read is left out of every
 *     network, and its error travels back with the result so the caller can
 *     show it.
 */

/** What the caller's reader returns for one repository. */
export interface RepoInfo {
  /** Whether GitHub calls this repository a fork. */
  readonly fork: boolean;
  /** The repository it was forked from, when GitHub reports it. */
  readonly source?: { readonly owner: string; readonly name: string } | undefined;
  /** GitHub's size for the repository, in kilobytes. It is an estimate. */
  readonly size: number;
}

/**
 * Reads one repository's information. `owner` and `repo` are the parts of the
 * configured name as written, so a caller can report an error against the name
 * the operator typed.
 */
export type RepoInfoReader = (owner: string, repo: string) => Promise<RepoInfo>;

/** A lowercase `owner/repo`, which is how the store names remotes and folders. */
export type RepoSlug = string;

/** One repository of a network. */
export interface NetworkMember {
  /** Lowercase `owner/repo`: the remote name and the folder part. */
  readonly slug: RepoSlug;
  /** GitHub's size for this repository, in kilobytes. */
  readonly sizeKilobytes: number;
}

/** One bare repository's worth of repositories. */
export interface ForkNetwork {
  /** Lowercase `owner/repo` of the repository the network is rooted at. */
  readonly root: RepoSlug;
  /** The members, including the root when the root is configured, sorted by slug. */
  readonly members: readonly NetworkMember[];
  /**
   * GitHub's size for the root, in kilobytes, which is what the disk guard
   * estimates a first fetch with. When the root itself is not in the
   * configured list (a fork whose root nobody asked for), this is the largest
   * member size instead.
   */
  readonly estimateKilobytes: number;
}

/** A configured repository whose information could not be read. */
export interface NetworkReadFailure {
  /** The name as it was configured. */
  readonly repo: string;
  /** The reader's message. */
  readonly message: string;
}

export interface NetworkResolution {
  /** One entry per network, sorted by root slug. */
  readonly networks: readonly ForkNetwork[];
  /** One entry per repository whose information could not be read. */
  readonly failures: readonly NetworkReadFailure[];
  /** The slugs that make up some network. */
  readonly grouped: readonly RepoSlug[];
}

/** Split `owner/repo` into its parts, or `undefined` for anything else. */
export function splitRepoSlug(name: string): { owner: string; repo: string } | undefined {
  const trimmed = name.trim();
  const at = trimmed.indexOf("/");
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const owner = trimmed.slice(0, at);
  const repo = trimmed.slice(at + 1);
  if (owner.includes("/") || repo.includes("/")) return undefined;
  return { owner, repo };
}

/** The lowercase `owner/repo` form of a name. */
export function repoSlug(name: string): RepoSlug {
  return name.trim().toLowerCase();
}

/**
 * One part of a name that is safe to hand to git and to the filesystem: letters,
 * digits, dot, underscore and hyphen, and neither `.` nor `..`.
 *
 * Both parts of a slug pass this check before the slug becomes a remote name, a
 * directory name or a command argument. A name that starts with `-` is refused
 * here, because git reads such an argument as an option, and one of the fetch
 * options runs a command.
 */
const SAFE_PART = /^[A-Za-z0-9._-]+$/;

/** Whether one part of a repository name is safe to use. */
export function isSafeNamePart(part: string): boolean {
  if (part === "." || part === "..") return false;
  if (part.startsWith("-")) return false;
  return SAFE_PART.test(part);
}

/** Whether a whole `owner/repo` is safe to use as a remote name and a folder name. */
export function isSafeSlug(slug: RepoSlug): boolean {
  const parts = splitRepoSlug(slug);
  if (parts === undefined) return false;
  return isSafeNamePart(parts.owner) && isSafeNamePart(parts.repo);
}

/**
 * Fold the configured names into lowercase slugs, keeping the first spelling of
 * each. GitHub compares names without regard to case, so `Owner/Repo` and
 * `owner/repo` name one repository and get one network.
 */
export function dedupeRepos(repos: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of repos) {
    const slug = repoSlug(name);
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    out.push(name.trim());
  }
  return out;
}

/**
 * Read every configured repository and group them into fork networks.
 *
 * The reads run one after another on purpose: a network resolution is not
 * urgent, it runs at most a few times an hour, and a burst of parallel `gh`
 * calls is what a rate limit notices.
 */
export async function resolveNetworks(
  repos: readonly string[],
  read: RepoInfoReader,
): Promise<NetworkResolution> {
  const names = dedupeRepos(repos);
  const info = new Map<RepoSlug, RepoInfo>();
  const failures: NetworkReadFailure[] = [];

  for (const name of names) {
    const parts = splitRepoSlug(name);
    if (parts === undefined) {
      failures.push({ repo: name, message: "a repository name must be owner/repo" });
      continue;
    }
    try {
      const value = await read(parts.owner, parts.repo);
      info.set(repoSlug(name), value);
    } catch (error) {
      failures.push({ repo: name, message: errorMessage(error) });
    }
  }

  /** Root slug -> members. */
  const groups = new Map<RepoSlug, NetworkMember[]>();
  for (const [slug, value] of info) {
    const root = rootOf(slug, value, info);
    const members = groups.get(root) ?? [];
    members.push({ slug, sizeKilobytes: value.size });
    groups.set(root, members);
  }

  const networks: ForkNetwork[] = [];
  for (const [root, members] of groups) {
    members.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    const rootSize = info.get(root)?.size;
    const estimate = rootSize ?? largestSize(members);
    networks.push({ root, members: [...members], estimateKilobytes: estimate });
  }
  networks.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));

  const grouped = networks.flatMap((network) => network.members.map((member) => member.slug));
  return { networks, failures, grouped };
}

/**
 * The repository a member belongs to.
 *
 * `source` names it whenever GitHub reports one. A fork without `source` is its
 * own root, which is the private-fork case, handled this way.
 *
 * The chain is followed when the source is itself configured and is a fork of
 * a third repository, so a fork of a fork lands in the network of the oldest
 * repository in the chain. The walk stops at the first repository that is not
 * configured or reports no source.
 *
 * GitHub reports no cycle (a fork's source is older than the fork), but a wrong
 * read could report one. A cycle then resolves to its smallest slug, which is
 * one answer for every member of the cycle instead of one per member.
 */
function rootOf(slug: RepoSlug, value: RepoInfo, info: ReadonlyMap<RepoSlug, RepoInfo>): RepoSlug {
  let current = slug;
  let currentInfo = value;
  const seen = new Set<RepoSlug>([slug]);
  for (;;) {
    const source = currentInfo.source;
    if (source === undefined) return current;
    const sourceSlug = repoSlug(`${source.owner}/${source.name}`);
    if (sourceSlug.length === 0) return current;
    if (seen.has(sourceSlug)) return [...seen].sort()[0] ?? current;
    const parent = info.get(sourceSlug);
    if (parent === undefined) return sourceSlug;
    seen.add(sourceSlug);
    current = sourceSlug;
    currentInfo = parent;
  }
}

function largestSize(members: readonly NetworkMember[]): number {
  let largest = 0;
  for (const member of members) largest = Math.max(largest, member.sizeKilobytes);
  return largest;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
