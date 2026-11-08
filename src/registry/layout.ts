import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import { REGISTRY_ROOT_DEFAULT } from "../config/schema.ts";
import { expandPath } from "../runtime/paths.ts";

/**
 * The shape of the registry on disk, and the names it accepts.
 *
 * The registry keeps three kinds of thing under one root: the bare repositories
 * it manages, the worktrees an agent works in, and a cache of build directories
 * (the installed packages a worktree needs) taken from those worktrees. Every
 * path is derived here from the root and a repository id, so a caller never
 * builds one by hand and the layout lives in one file.
 *
 * The names are lowercase throughout, because GitHub compares the two parts of
 * a repository name without regard to case: one repository must have one folder
 * name, or the same repository registered under two spellings becomes two.
 */

/** Which buildfs method the operator allows. `auto` decides per repository. */
export type RegistryMode = "auto" | "subvolume" | "copy" | "none";

/**
 * One entry of `registry.buildDirs`: a build directory of a repository, the
 * lockfile that decides when it is stale, and the command that fills it.
 *
 * `repo` absent means every repository; present, it names the one repository
 * the rule applies to. A rule whose `lockfile` is set applies only while that
 * file is in the worktree. A rule with the `dir` of a built-in rule replaces
 * that built-in rule, which is how an npm project becomes a pnpm one.
 */
export interface BuildDirRule {
  repo?: string;
  dir: string;
  lockfile?: string;
  install?: string[];
}

/** The values of the `registry` key, with every default filled in. */
export interface RegistrySettings {
  /** Absolute path of the registry root. */
  root: string;
  /** How many caches to keep for each repository and build directory. */
  cacheKeep: number;
  /** How old the caches may be before a refresh, in hours. */
  refreshHours: number;
  /** Operator rules that override or add to the built-in ones. */
  buildDirs: BuildDirRule[];
  mode: RegistryMode;
}

/** The `cacheKeep` a config that names none gets. */
const CACHE_KEEP_DEFAULT = 2;
/** The `refreshHours` a config that names none gets. */
const REFRESH_HOURS_DEFAULT = 24;

/**
 * Read the `registry` key, with every value the file left out taken from the
 * defaults here.
 *
 * The key is optional in the schema so that a config file written before the
 * registry existed still loads and so that a test can build a config by hand.
 * The load fills the defaults too (`defaultConfig` and `Value.Default`), but
 * this function is the reader, and a reader that trusts its input to be
 * complete is the one that breaks when a caller passes a partial config.
 *
 * `root` expands `~` and `$HOME` here rather than at every use, so a config
 * that names `~/repos` hands git an absolute path. `applyHomeDefaults` already
 * moved the default `~/.pi/sec/repos` under `PI_SEC_HOME`, and a value that it
 * did not move is the operator's own home.
 */
export function registrySettings(config: Config): RegistrySettings {
  const registry = config.registry ?? {};
  return {
    root: expandPath(registry.root ?? REGISTRY_ROOT_DEFAULT),
    cacheKeep: registry.cacheKeep ?? CACHE_KEEP_DEFAULT,
    refreshHours: registry.refreshHours ?? REFRESH_HOURS_DEFAULT,
    buildDirs: (registry.buildDirs ?? []).map(copyRule),
    mode: registry.mode ?? "auto",
  };
}

/** A rule with its install list copied, so a caller cannot change the config. */
function copyRule(rule: BuildDirRule): BuildDirRule {
  const copy: BuildDirRule = { dir: rule.dir };
  if (rule.repo !== undefined) copy.repo = rule.repo;
  if (rule.lockfile !== undefined) copy.lockfile = rule.lockfile;
  if (rule.install !== undefined) copy.install = [...rule.install];
  return copy;
}

/** One part of a repository name: lowercase letters, digits, `.`, `_`, `-`. */
const REPO_PART = /^[a-z0-9._-]+$/;

/** The owner of a name written without a slash. */
const LOCAL_OWNER = "local";

/** A worktree name: lowercase words joined by single hyphens, at most 80 chars. */
const WORKTREE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest worktree name accepted. */
const WORKTREE_NAME_MAX = 80;

/** A lowercased job id at the front of a worktree name, then `-` or the end. */
const WORKTREE_JOB_PREFIX = /^(\d{8})-([0-9a-z]{26})(?=-|$)/;

/**
 * Read a repository name as `<owner>/<repo>`, throwing on a name that cannot be
 * one.
 *
 * A name without a slash is a repository that GitHub does not hold, and its
 * owner is `local`. Upper case becomes lower case, for the reason the file
 * comment gives: GitHub treats `Owner/Repo` and `owner/repo` as one repository,
 * so the registry must too, or a repository gets two bare copies and two sets of
 * worktrees.
 *
 * A part may not start with `.` and may not hold `..`: both name a directory
 * other than the one the registry means. A leading `-` is allowed here even
 * though `git` reads such a name as an option, because no path this module
 * builds is passed to git as a bare argument; the caller that does pass one
 * checks for it.
 */
export function parseRepoName(input: string): { owner: string; repo: string; id: string } {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("invalid repository name: it is empty");
  }
  const lowered = input.toLowerCase();
  const slash = lowered.indexOf("/");
  let owner: string;
  let repo: string;
  if (slash === -1) {
    owner = LOCAL_OWNER;
    repo = lowered;
  } else {
    owner = lowered.slice(0, slash);
    repo = lowered.slice(slash + 1);
    if (repo.includes("/")) {
      throw new Error(`invalid repository name "${input}": it holds more than one slash, and a name is <owner>/<repo>`);
    }
  }
  checkRepoPart(owner, "owner", input);
  checkRepoPart(repo, "repo", input);
  return { owner, repo, id: `${owner}/${repo}` };
}

/** Refuse one part of a repository name, naming the part and the whole name. */
function checkRepoPart(part: string, role: "owner" | "repo", input: string): void {
  const reason =
    part.length === 0
      ? "it is empty"
      : part.startsWith(".")
        ? "it starts with a dot"
        : part.includes("..")
          ? 'it holds ".."'
          : !REPO_PART.test(part)
            ? 'it holds a character other than a lowercase letter, a digit, ".", "_" or "-"'
            : undefined;
  if (reason !== undefined) {
    throw new Error(`invalid repository name "${input}": the ${role} "${part}" is refused because ${reason}`);
  }
}

/**
 * Whether a worktree folder name is accepted.
 *
 * Lowercase words joined by single hyphens, at most 80 characters. The name
 * becomes a folder under the repository and a branch `wt/<name>`, so it must be
 * a name git and the shell both accept without quoting.
 */
export function isValidWorktreeName(name: string): boolean {
  return name.length > 0 && name.length <= WORKTREE_NAME_MAX && WORKTREE_NAME.test(name);
}

/**
 * The job id a worktree name carries, or nothing.
 *
 * A worktree is named after the job that works in it, and this is the one place
 * that reads the job back out of the name. A job id is `YYYYMMDD-` and a ULID of
 * 26 characters; the folder name is lowercase, so the ULID is upper-cased again
 * here. `20261103-01m6ef23h50000000000005rpq-fix-hook` names job
 * `20261103-01M6EF23H50000000000005RPQ`. A name that does not start with one
 * carries no job, and the list shows empty job fields for it.
 */
export function jobIdFromWorktreeName(name: string): string | undefined {
  const match = WORKTREE_JOB_PREFIX.exec(name);
  const date = match?.[1];
  const ulid = match?.[2];
  if (date === undefined || ulid === undefined) return undefined;
  return `${date}-${ulid.toUpperCase()}`;
}

/** The fixed folders under a registry root. */
export interface RegistryPaths {
  readonly root: string;
  readonly repos: string;
  readonly worktrees: string;
  readonly buildfs: string;
  readonly state: string;
  /** The file that records when the caches were last refreshed. */
  readonly lastRefresh: string;
}

/** The folders a registry keeps under one root. */
export function registryPaths(root: string): RegistryPaths {
  const state = join(root, "state");
  return {
    root,
    repos: join(root, "repos"),
    worktrees: join(root, "worktrees"),
    buildfs: join(root, "buildfs"),
    state,
    lastRefresh: join(state, "last-refresh.json"),
  };
}

/** Split `<owner>/<repo>`, refusing a string that is not one. */
function splitRepoId(id: string): { owner: string; repo: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1 || slash !== id.lastIndexOf("/")) {
    throw new Error(`invalid repository id "${id}": it is not <owner>/<repo>`);
  }
  return { owner: id.slice(0, slash), repo: id.slice(slash + 1) };
}

/** The bare repository of one repository id. */
export function bareRepoDir(root: string, id: string): string {
  const { owner, repo } = splitRepoId(id);
  return join(root, "repos", owner, `${repo}.git`);
}

/** The record that marks a repository registered where it already lived. */
export function inPlaceRecordPath(root: string, id: string): string {
  const { owner, repo } = splitRepoId(id);
  return join(root, "repos", owner, `${repo}.inplace.json`);
}

/** The folder of one worktree of one repository. */
export function worktreeDir(root: string, id: string, name: string): string {
  const { owner, repo } = splitRepoId(id);
  return join(root, "worktrees", owner, repo, name);
}

/** The folder that holds the caches of one build directory of one repository. */
export function cacheParent(root: string, id: string, buildDir: string): string {
  const { owner, repo } = splitRepoId(id);
  return join(root, "buildfs", owner, repo, buildDir);
}

/** A build directory a worktree needs, and how to fill it. */
export interface ResolvedBuildDir {
  dir: string;
  lockfile?: string;
  install?: string[];
}

/** The rules this install ships: lockfile, build directory, install command. */
const BUILT_IN: readonly { lockfile: string; dir: string; install?: readonly string[] }[] = [
  { lockfile: "package-lock.json", dir: "node_modules", install: ["npm", "ci"] },
  { lockfile: "uv.lock", dir: ".venv", install: ["uv", "sync"] },
  { lockfile: "Cargo.lock", dir: "target" },
];

/**
 * The build directories that the lockfiles present in a worktree ask for.
 *
 * Three rules are built in, because they are the ecosystems this install works
 * in and a rule nobody wrote should not have to be written for them. The order
 * of `BUILT_IN` is the order of the result, so a worktree with both a
 * `package-lock.json` and a `Cargo.lock` always gets `node_modules` first.
 *
 * `rules` are the operator's: a rule with no `repo` applies to every repository,
 * one with a `repo` to that repository alone (compared without regard to case,
 * as `parseRepoName` lowercases). A rule replaces the built-in rule of the same
 * `dir` whatever its own lockfile says, and a rule with a `dir` of its own adds
 * a build directory. A rule whose `lockfile` is named applies only while that
 * file is present: an operator who replaces npm with pnpm must not get `npm ci`
 * on a worktree that has no `pnpm-lock.yaml`, and must not get it on one that
 * has no `package-lock.json` either.
 */
export function resolveBuildDirs(
  repoId: string,
  presentLockfiles: readonly string[],
  rules: readonly BuildDirRule[] = [],
): ResolvedBuildDir[] {
  const present = new Set(presentLockfiles);
  const applicable = rules.filter(
    (rule) => rule.repo === undefined || rule.repo.toLowerCase() === repoId.toLowerCase(),
  );
  // The last rule of a `dir` wins, so a repository rule written after a general
  // one takes effect. A Map keeps the first insertion position of a key, which
  // keeps the result in the order the file wrote the rules.
  const overrides = new Map<string, BuildDirRule>();
  for (const rule of applicable) overrides.set(rule.dir, rule);

  const out: ResolvedBuildDir[] = [];
  for (const rule of BUILT_IN) {
    // A built-in rule that the operator replaced is not applied any more, even
    // when its own lockfile is present: the replacement decides.
    if (overrides.has(rule.dir)) continue;
    if (!present.has(rule.lockfile)) continue;
    out.push(resolved(rule.dir, rule.lockfile, rule.install));
  }
  for (const rule of overrides.values()) {
    if (rule.lockfile !== undefined && !present.has(rule.lockfile)) continue;
    // A rule that replaces a built-in rule is emitted here, and so is one that
    // adds a build directory of its own; neither was emitted above.
    if (!out.some((entry) => entry.dir === rule.dir)) {
      out.push(resolved(rule.dir, rule.lockfile, rule.install));
    }
  }
  return out;
}

/** One rule as a result entry, with its install list copied. */
function resolved(dir: string, lockfile?: string, install?: readonly string[]): ResolvedBuildDir {
  const entry: ResolvedBuildDir = { dir };
  if (lockfile !== undefined) entry.lockfile = lockfile;
  if (install !== undefined) entry.install = [...install];
  return entry;
}

/**
 * Create the registry folders, mode 0700, like the rest of the pi-sec home.
 *
 * A folder that already exists is left as it is, and only a folder this call
 * created is chmodded, because `mkdir`'s mode is masked by the process umask.
 * The call is safe to repeat: every command that touches the registry calls it
 * first, so a registry root an operator created by hand still works.
 */
export async function ensureRegistryDirs(root: string): Promise<void> {
  const paths = registryPaths(root);
  for (const dir of [paths.root, paths.repos, paths.worktrees, paths.buildfs, paths.state]) {
    const existed = existsSync(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!existed) await chmod(dir, 0o700);
  }
}
