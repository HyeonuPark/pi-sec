import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { BuildfsDeps } from "./buildfs.ts";
import { detectMode, fillBuildDir, lockfileHash, removeBuildfs, type BuildfsMode } from "./buildfs.ts";
import {
  cacheParent,
  ensureRegistryDirs,
  isValidWorktreeName,
  registryPaths,
  resolveBuildDirs,
  worktreeDir,
  type RegistrySettings,
  type ResolvedBuildDir,
} from "./layout.ts";
import {
  defaultBranchOf,
  git,
  gitOrThrow,
  isInside,
  resolveRepo,
  topLevelNames,
  worktreeRecords,
} from "./store.ts";

/**
 * The worktrees of a registry repository.
 *
 * A worktree is where an agent works: its own folder, its own branch
 * `wt/<name>`, and its own build directory filled from the repository's cache.
 * The folder lives under `<root>/worktrees/<owner>/<repo>/<name>`, which is what
 * makes it a registry worktree rather than one an operator cut elsewhere.
 *
 * Three rules are fixed here because each of them protects work that is not
 * this module's to throw away:
 *
 * - A worktree is removed only when git reports no change in it. The build
 *   directories go first, and git refuses a folder with untracked or modified
 *   files, so a change that appeared after the check would leave a worktree
 *   without its build directories if the order were the other way round.
 * - `git worktree remove` is never given `--force`, so git has the last word.
 * - The `wt/` branch is left in place. A branch is the commit the work reached;
 *   deleting it is a decision for the operator, and the protection hook refuses
 *   a deletion inside a worktree in any case.
 */

/** One build directory a worktree add filled, and where it came from. */
export interface FilledBuildDir {
  dir: string;
  /** The cache the directory was filled from, or null when it was installed. */
  filledFrom: string | null;
  installed: boolean;
}

/** What `addWorktree` made. */
export interface AddedWorktree {
  repo: string;
  path: string;
  branch: string;
  mode: BuildfsMode;
  buildDirs: FilledBuildDir[];
}

/** The build directories a worktree needs, with the worktree's lockfile hashes. */
interface BuildDirPlan {
  rule: ResolvedBuildDir;
  target: string;
  /** The worktree's lockfile hash; a matching cache fills without an install. */
  lockHash?: string;
}

/**
 * The build directories of one worktree and how each is filled or emptied.
 *
 * The rule comes from the lockfiles that are present, so a worktree without a
 * `package-lock.json` gets no `node_modules` at all, and an operator rule for
 * another ecosystem replaces the built-in one.
 */
function planBuildDirs(settings: RegistrySettings, id: string, path: string): BuildDirPlan[] {
  const names = topLevelNames(path);
  return resolveBuildDirs(id, names, settings.buildDirs).map((rule) => {
    const lockPath = rule.lockfile === undefined ? undefined : join(path, rule.lockfile);
    const plan: BuildDirPlan = { rule, target: join(path, rule.dir) };
    if (lockPath !== undefined && existsSync(lockPath)) plan.lockHash = lockfileHash(lockPath);
    return plan;
  });
}

/**
 * Create one worktree and fill its build directories.
 *
 * A repository with no commit yet gets `--orphan`, because there is no commit to
 * start the branch from; a repository with commits starts the branch at its
 * default branch, so a worktree always begins where `main` is now.
 *
 * A failed install leaves the worktree in place and reports the failure: the
 * folder holds a branch and possibly a commit that exists nowhere else, so
 * removing it is the caller's decision, not this function's.
 */
export async function addWorktree(
  settings: RegistrySettings,
  repo: string,
  name: string,
  deps: BuildfsDeps = {},
): Promise<AddedWorktree> {
  if (!isValidWorktreeName(name)) {
    throw new Error(
      `invalid worktree name "${name}": it must be lowercase letters, digits and single hyphens, at most 80 characters`,
    );
  }
  const ref = await resolveRepo(settings, repo, deps);
  await ensureRegistryDirs(settings.root);
  const paths = registryPaths(settings.root);
  const path = worktreeDir(settings.root, ref.id, name);
  const branch = `wt/${name}`;

  const existing = await git(deps, ["--git-dir", ref.gitDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.code === 0) {
    throw new Error(`the branch ${branch} already exists in ${ref.id}; another worktree may not share it`);
  }
  if (existsSync(path)) throw new Error(`the worktree folder already exists: ${path}`);

  const head = await git(deps, ["--git-dir", ref.gitDir, "rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code === 0) {
    const start = (await defaultBranchOf(ref.gitDir, deps)) ?? "HEAD";
    await gitOrThrow(deps, ["--git-dir", ref.gitDir, "worktree", "add", "-b", branch, path, start]);
  } else {
    await gitOrThrow(deps, ["--git-dir", ref.gitDir, "worktree", "add", "--orphan", "-b", branch, path]);
  }

  const mode = await detectMode(paths.buildfs, settings.mode, deps);
  const buildDirs: FilledBuildDir[] = [];
  for (const plan of planBuildDirs(settings, ref.id, path)) {
    try {
      const filled = await fillBuildDir(
        {
          mode,
          target: plan.target,
          cacheParent: cacheParent(settings.root, ref.id, plan.rule.dir),
          ...(plan.lockHash === undefined ? {} : { lockHash: plan.lockHash }),
          ...(plan.rule.install === undefined ? {} : { install: plan.rule.install }),
          cwd: path,
        },
        deps,
      );
      buildDirs.push({ dir: plan.rule.dir, filledFrom: filled.filledFrom ?? null, installed: filled.installed });
    } catch (error) {
      // The worktree stays: it holds a branch, and the caller decides what to do
      // with a folder whose install failed.
      throw new Error(
        `the worktree ${path} was created but ${plan.rule.dir} could not be filled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { repo: ref.id, path, branch, mode, buildDirs };
}

/** What `removeWorktree` took away. */
export interface RemovedWorktree {
  repo: string;
  path: string;
  branch: string | null;
  /** The build directories that were removed before the folder went. */
  buildDirs: string[];
}

/**
 * Remove one worktree: its build directories first, then the folder.
 *
 * An empty `git status --porcelain` is the condition for removing anything at
 * all, and it is checked before the first removal, so a refusal cannot leave a
 * worktree whose build directories are already gone.
 *
 * Ignored files do not appear in that status, and git removes the whole folder
 * with them; a test checks that against git itself rather than trusting this
 * comment.
 */
export async function removeWorktree(
  settings: RegistrySettings,
  repo: string,
  name: string,
  deps: BuildfsDeps = {},
): Promise<RemovedWorktree> {
  const ref = await resolveRepo(settings, repo, deps);
  const paths = registryPaths(settings.root);
  const path = worktreeDir(settings.root, ref.id, name);
  if (!existsSync(path)) throw new Error(`the worktree folder does not exist: ${path}`);
  if (!isInside(paths.worktrees, path)) {
    throw new Error(`${path} is not a registry worktree; only ${paths.worktrees} is removed from`);
  }

  const status = await git(deps, ["-C", path, "status", "--porcelain"]);
  if (status.code !== 0) {
    throw new Error(`git could not read the state of ${path} (exit ${status.code}): ${status.stderr.trim()}`);
  }
  if (status.stdout.trim() !== "") {
    throw new Error(
      `the worktree ${path} holds modified or untracked files; nothing was removed. Commit or discard them first`,
    );
  }

  const mode = await detectMode(paths.buildfs, settings.mode, deps);
  const buildDirs: string[] = [];
  for (const plan of planBuildDirs(settings, ref.id, path)) {
    if (!existsSync(plan.target)) continue;
    const removed = await removeBuildfs(plan.target, { allowedRoot: paths.worktrees, mode }, deps);
    if (!removed.removed && removed.reason !== "missing") {
      throw new Error(`the build directory ${plan.target} was not removed: ${removed.reason ?? "no reason given"}`);
    }
    buildDirs.push(plan.target);
  }

  // Without `--force`: git removes the folder only when it holds nothing that
  // would be lost, and it keeps the worktree registered otherwise.
  const answer = await git(deps, ["--git-dir", ref.gitDir, "worktree", "remove", path]);
  if (answer.code !== 0) {
    throw new Error(
      `git refused to remove the worktree ${path} (exit ${answer.code}): ${answer.stderr.trim() || answer.stdout.trim()}`,
    );
  }

  return { repo: ref.id, path, branch: `wt/${name}`, buildDirs };
}

/**
 * Empty and fill the build directories of one worktree again.
 *
 * This is the answer to a build tool that deleted its own build directory
 * (`cargo clean`, or an `rm -rf node_modules`), which turns a subvolume into a
 * plain folder that a backup then copies. `removeBuildfs` refuses a plain folder
 * where a subvolume is expected, because doing otherwise would let a mistyped
 * path delete a tree; that refusal is the one case this function handles on its
 * own, and only for a path it resolved itself: a build directory of this
 * worktree, below `<root>/worktrees/`.
 */
export async function refillBuildfs(
  settings: RegistrySettings,
  repo: string,
  name: string,
  deps: BuildfsDeps = {},
): Promise<AddedWorktree> {
  const ref = await resolveRepo(settings, repo, deps);
  const paths = registryPaths(settings.root);
  const path = worktreeDir(settings.root, ref.id, name);
  if (!existsSync(path)) throw new Error(`the worktree folder does not exist: ${path}`);

  const mode = await detectMode(paths.buildfs, settings.mode, deps);
  const buildDirs: FilledBuildDir[] = [];
  for (const plan of planBuildDirs(settings, ref.id, path)) {
    if (existsSync(plan.target)) {
      const removed = await removeBuildfs(plan.target, { allowedRoot: paths.worktrees, mode }, deps);
      if (!removed.removed && removed.reason !== "missing") {
        if (mode === "subvolume" && (removed.reason ?? "").startsWith("the path is a plain directory")) {
          removePlainBuildDir(paths.worktrees, path, plan.target);
        } else {
          throw new Error(`the build directory ${plan.target} was not removed: ${removed.reason}`);
        }
      }
    }
    const filled = await fillBuildDir(
      {
        mode,
        target: plan.target,
        cacheParent: cacheParent(settings.root, ref.id, plan.rule.dir),
        ...(plan.lockHash === undefined ? {} : { lockHash: plan.lockHash }),
        ...(plan.rule.install === undefined ? {} : { install: plan.rule.install }),
        cwd: path,
      },
      deps,
    );
    buildDirs.push({ dir: plan.rule.dir, filledFrom: filled.filledFrom ?? null, installed: filled.installed });
  }

  return { repo: ref.id, path, branch: `wt/${name}`, mode, buildDirs };
}

/**
 * Remove a plain folder standing where a build directory belongs.
 *
 * Two checks come before the removal, matching the checks `removeBuildfs` makes
 * for the subvolume case: the path is one this call computed from the worktree
 * and a resolved build directory, and its real parent sits below the worktrees
 * folder. Nothing else is ever removed here.
 */
function removePlainBuildDir(worktreesRoot: string, worktreePath: string, target: string): void {
  if (target === worktreePath || !isInside(worktreePath, target)) {
    throw new Error(`${target} is not a build directory of ${worktreePath}`);
  }
  let parentReal: string;
  let rootReal: string;
  try {
    parentReal = realpathSync(worktreePath);
    rootReal = realpathSync(worktreesRoot);
  } catch (error) {
    throw new Error(`could not resolve ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parentReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`${worktreePath} is outside ${worktreesRoot}`);
  }
  let info;
  try {
    info = lstatSync(target);
  } catch {
    return;
  }
  if (!info.isDirectory()) throw new Error(`${target} is not a directory`);
  rmSync(target, { recursive: true, force: true });
}

/**
 * Move `refs/heads/main` forward to a branch, and never backward.
 *
 * The move is allowed only when `main` is an ancestor of the branch, which makes
 * the branch a superset of what `main` holds. A branch that is behind, or one
 * that has its own commits from an older point, is refused: landing it would
 * drop commits from `main`.
 *
 * `main` may not be checked out in any worktree of the repository, and the
 * refusal names that worktree. This is the one repository whose `main` a person
 * moves by hand (the working tree of the installation), and moving it under a
 * checked-out folder would leave that folder on an old commit with a dirty
 * index.
 *
 * The update runs against the git directory, outside every worktree, so the
 * protection hook leaves it alone: that is the path the landing procedure uses.
 */
export async function fastForward(
  settings: RegistrySettings,
  repo: string,
  branch: string,
  deps: BuildfsDeps = {},
): Promise<{ from: string; to: string }> {
  const ref = await resolveRepo(settings, repo, deps);
  const target = "refs/heads/main";
  const from = (await gitOrThrow(deps, ["--git-dir", ref.gitDir, "rev-parse", "--verify", target])).trim();
  const to = (
    await gitOrThrow(deps, ["--git-dir", ref.gitDir, "rev-parse", "--verify", `refs/heads/${branch}`])
  ).trim();

  const ancestor = await git(deps, ["--git-dir", ref.gitDir, "merge-base", "--is-ancestor", target, `refs/heads/${branch}`]);
  if (ancestor.code === 1) {
    throw new Error(`${branch} is not ahead of main in ${ref.id}: main holds commits that ${branch} does not`);
  }
  if (ancestor.code !== 0) {
    throw new Error(`git could not compare main with ${branch} (exit ${ancestor.code}): ${ancestor.stderr.trim()}`);
  }

  const checkedOut = (await worktreeRecords(ref.gitDir, deps)).find(
    (record) => !record.bare && record.branch === "main",
  );
  if (checkedOut !== undefined) {
    throw new Error(
      `main is checked out in ${checkedOut.path}, so it is not moved here; move it in that folder instead`,
    );
  }

  if (from === to) return { from, to };
  // The old value is given with the new one, so a `main` that moved between the
  // check and the update is refused by git rather than written over.
  await gitOrThrow(deps, ["--git-dir", ref.gitDir, "update-ref", target, to, from]);
  return { from, to };
}
