/**
 * The registry's layout, its settings key, and the protection hook.
 *
 * The layout half is pure: names, paths, and the build directories a worktree
 * needs. The settings half loads a real `config.json` from a temporary home, so
 * the schema, the defaults and the home rewrite are tested together.
 *
 * The hook half runs real git in temporary repositories, because a hook is only
 * worth what git does with it: a test that read the script and guessed its
 * behaviour would pass while the script refused every commit. Every case that
 * must pass and every case that must be refused is a git command whose exit
 * status is checked.
 *
 * Nothing here waits on a clock, and no path of this machine appears: every
 * directory comes from `os.tmpdir()`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { REFERENCE_TRANSACTION_HOOK, checkHook, installHook } from "../src/registry/hooks.ts";
import {
  bareRepoDir,
  cacheParent,
  ensureRegistryDirs,
  inPlaceRecordPath,
  isValidWorktreeName,
  jobIdFromWorktreeName,
  parseRepoName,
  registryPaths,
  registrySettings,
  resolveBuildDirs,
  worktreeDir,
} from "../src/registry/layout.ts";

/**
 * The git settings every call of this file runs with.
 *
 * A test may not depend on the operator's configuration, so the global and
 * system files are cut off and the identity is set here. `installHook` reads
 * `process.env`, so these are put into it rather than passed to a helper: one
 * environment, one answer, whichever side of the module runs git.
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
function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): GitRun {
  const result = spawnSync("git", [...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run one git command that must succeed. */
function gitOk(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): GitRun {
  const run = git(cwd, args, extraEnv);
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${run.status}): ${run.stderr || run.stdout}`);
  }
  return run;
}

/**
 * A bare repository with one commit on `main`, shaped the way the registry
 * makes one: `<root>/repos/local/<name>.git`.
 *
 * A commit is put in through a throwaway repository that pushes into the bare
 * one, which is the shortest path that needs no worktree and no hand-written
 * object.
 */
function bareWithMain(root: string, name: string): string {
  const bare = join(root, "repos", "local", `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  gitOk(root, ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  const seed = join(root, `seed-${name}`);
  mkdirSync(seed, { recursive: true });
  gitOk(seed, ["init", "--quiet", "--initial-branch=main", "."]);
  writeFileSync(join(seed, "README.md"), "seed\n", "utf8");
  writeFileSync(join(seed, "common.txt"), "base\n", "utf8");
  gitOk(seed, ["add", "README.md", "common.txt"]);
  gitOk(seed, ["commit", "--quiet", "-m", "seed"]);
  gitOk(seed, ["push", "--quiet", bare, "main"]);
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A temporary directory with every symlink resolved, for one test. */
function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("repository and worktree names", () => {
  it("reads a repository name as owner and repo", () => {
    expect(parseRepoName("Owner/Repo")).toEqual({ owner: "owner", repo: "repo", id: "owner/repo" });
    expect(parseRepoName("local/thing.v2")).toEqual({ owner: "local", repo: "thing.v2", id: "local/thing.v2" });
    // A name with no slash is a repository GitHub does not hold.
    expect(parseRepoName("plain")).toEqual({ owner: "local", repo: "plain", id: "local/plain" });
  });

  it("refuses a repository name that cannot be one", () => {
    const refused = ["", "a/b/c", "/repo", "owner/", ".hidden/x", "a/..", "a/b..c", "a b/c", "a$b/c", "../x"];
    for (const name of refused) {
      expect(() => parseRepoName(name), name).toThrow();
    }
  });

  it("accepts and refuses worktree names", () => {
    const accepted = ["a", "fix-hook", "20261103-01m6ef23h50000000000005rpq-impl", "x".repeat(80)];
    for (const name of accepted) expect(isValidWorktreeName(name), name).toBe(true);
    const refused = ["", "Upper", "two--dashes", "-lead", "trail-", "under_score", "x".repeat(81)];
    for (const name of refused) expect(isValidWorktreeName(name), name).toBe(false);
  });

  it("reads the job id a worktree name carries", () => {
    expect(jobIdFromWorktreeName("20261103-01m6ef23h50000000000005rpq")).toBe(
      "20261103-01M6EF23H50000000000005RPQ",
    );
    expect(jobIdFromWorktreeName("20261103-01m6ef23h50000000000005rpq-fix-hook")).toBe(
      "20261103-01M6EF23H50000000000005RPQ",
    );
    // A ULID of 27 characters, a date of 7 digits, and a job id that is not at
    // the front are all names without a job.
    expect(jobIdFromWorktreeName("20261103-01m6ef23h50000000000005rpqx")).toBeUndefined();
    expect(jobIdFromWorktreeName("2026110-01m6ef23h50000000000005rpq")).toBeUndefined();
    expect(jobIdFromWorktreeName("fix-20261103-01m6ef23h50000000000005rpq")).toBeUndefined();
  });
});

describe("registry paths", () => {
  const root = "/srv/registry";

  it("lays the folders out under the root", () => {
    expect(registryPaths(root)).toEqual({
      root,
      repos: join(root, "repos"),
      worktrees: join(root, "worktrees"),
      buildfs: join(root, "buildfs"),
      state: join(root, "state"),
      lastRefresh: join(root, "state", "last-refresh.json"),
    });
  });

  it("derives one repository's folders", () => {
    expect(bareRepoDir(root, "acme/widget")).toBe(join(root, "repos", "acme", "widget.git"));
    expect(inPlaceRecordPath(root, "local/pi-sec")).toBe(join(root, "repos", "local", "pi-sec.inplace.json"));
    expect(worktreeDir(root, "acme/widget", "fix-hook")).toBe(
      join(root, "worktrees", "acme", "widget", "fix-hook"),
    );
    expect(cacheParent(root, "acme/widget", "node_modules")).toBe(
      join(root, "buildfs", "acme", "widget", "node_modules"),
    );
  });

  it("refuses an id that is not owner/repo", () => {
    expect(() => bareRepoDir(root, "widget")).toThrow();
    expect(() => bareRepoDir(root, "a/b/c")).toThrow();
    expect(() => worktreeDir(root, "/a", "b")).toThrow();
  });
});

type BuildRules = Parameters<typeof resolveBuildDirs>[2];
const NPM = { dir: "node_modules", lockfile: "package-lock.json", install: ["npm", "ci"] };
const GO_RULE = { dir: "vendor", lockfile: "go.sum", install: ["go", "mod", "download"] };
const SHARED_RULES: BuildRules = [GO_RULE, { repo: "acme/widget", dir: "dist", install: ["./build.sh"] }];
const CASE_RULES: BuildRules = [{ repo: "Acme/Widget", dir: "out", install: ["make"] }];
const PNPM_RULES: BuildRules = [
  { dir: "node_modules", lockfile: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"] },
];

// Each row is one old case input: its name, the repository, the lockfiles present, the rules, and the whole result.
const BUILD_DIR_ROWS: [string, string, string[], BuildRules, unknown[]][] = [
  ["takes one directory for each lockfile that is present", "local/app", ["package-lock.json"], [], [NPM]],
  [
    "takes one directory for each lockfile that is present",
    "local/app",
    ["package-lock.json", "Cargo.lock"],
    [],
    [NPM, { dir: "target", lockfile: "Cargo.lock" }],
  ],
  ["takes one directory for each lockfile that is present", "local/app", [], [], []],
  [
    "applies a rule to one repository or to all of them",
    "acme/widget",
    ["go.sum", "package-lock.json"],
    SHARED_RULES,
    [NPM, GO_RULE, { dir: "dist", install: ["./build.sh"] }],
  ],
  ["applies a rule to one repository or to all of them", "local/app", ["go.sum"], SHARED_RULES, [GO_RULE]],
  ["compares the repository of a rule without regard to case", "acme/widget", [], CASE_RULES, [{ dir: "out", install: ["make"] }]],
  ["compares the repository of a rule without regard to case", "local/app", [], CASE_RULES, []],
  ["lets a rule replace a built-in directory", "local/app", ["pnpm-lock.yaml"], PNPM_RULES, PNPM_RULES],
  // The replacement decides. Without its own lockfile it does not apply, and
  // the npm rule it replaced does not come back.
  ["lets a rule replace a built-in directory", "local/app", ["package-lock.json"], PNPM_RULES, []],
  [
    "keeps a rule whose lockfile is absent out of the result",
    "local/app",
    ["uv.lock"],
    [{ dir: "vendor", lockfile: "go.sum" }],
    [{ dir: ".venv", lockfile: "uv.lock", install: ["uv", "sync"] }],
  ],
];

describe("build directories a worktree needs", () => {
  it.each(BUILD_DIR_ROWS)("%s (row %#)", (_oldCase, repo, lockfiles, rules, expected) => {
    expect(resolveBuildDirs(repo, lockfiles, rules)).toEqual(expected);
  });
});

describe("the registry settings key", () => {
  let home: string;

  beforeEach(async () => {
    home = tempRoot("registry-config-");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Write a config file into the temporary home, and load it. */
  async function load(value: unknown): Promise<{ config: ReturnType<typeof defaultConfig> }> {
    writeFileSync(join(home, "config.json"), JSON.stringify(value), "utf8");
    return loadConfig({ home });
  }

  /** Load a config that must be refused, and give back the refusal. */
  async function refusal(value: unknown): Promise<ConfigError> {
    try {
      await load(value);
    } catch (error) {
      return error as ConfigError;
    }
    throw new Error("the config loaded, and it should have been refused");
  }

  it("reads the defaults when the file names no registry key", async () => {
    const { config } = await load({ version: 1, timezone: "UTC" });
    const expected = {
      root: join(home, "repos"),
      cacheKeep: 2,
      refreshHours: 24,
      buildDirs: [],
      mode: "auto",
    };
    expect(config.registry).toEqual(expected);
    expect(registrySettings(config)).toEqual(expected);
  });

  it("keeps the values the file names and fills the rest", async () => {
    const { config } = await load({
      version: 1,
      timezone: "UTC",
      registry: {
        root: "/srv/repos",
        cacheKeep: 5,
        buildDirs: [{ repo: "acme/widget", dir: "dist", install: ["./build.sh"] }],
        mode: "copy",
      },
    });
    expect(config.registry).toEqual({
      root: "/srv/repos",
      cacheKeep: 5,
      refreshHours: 24,
      buildDirs: [{ repo: "acme/widget", dir: "dist", install: ["./build.sh"] }],
      mode: "copy",
    });
    expect(registrySettings(config).root).toBe("/srv/repos");
  });

  it("reads the shipped defaults, with the root under the run account's home", () => {
    expect(registrySettings(defaultConfig())).toEqual({
      root: join(homedir(), ".pi", "sec", "repos"),
      cacheKeep: 2,
      refreshHours: 24,
      buildDirs: [],
      mode: "auto",
    });
  });

  it.each([
    ["a mode that is not one of the four", { mode: "hardlink" }, "/registry/mode"],
    ["a keep count below one", { cacheKeep: 0 }, "/registry/cacheKeep"],
    ["a refresh period of zero", { refreshHours: 0 }, "/registry/refreshHours"],
    ["a build directory that leaves the cache folder", { buildDirs: [{ dir: "../outside" }] }, "/registry/buildDirs/0/dir"],
    ["a registry key it does not know", { mode: "copy", extra: true }, "/registry"],
  ])("refuses %s (row %#)", async (_what, registry, path) => {
    const error = await refusal({ version: 1, timezone: "UTC", registry });
    expect(error.issues.join("\n")).toContain(path);
  });
});

describe("registry folders", () => {
  let root: string;

  beforeEach(() => {
    root = join(tempRoot("registry-dirs-"), "registry");
  });

  afterEach(() => {
    rmSync(dirname(root), { recursive: true, force: true });
  });

  it("creates them 0700 and leaves an existing one as it is", async () => {
    await ensureRegistryDirs(root);
    const paths = registryPaths(root);
    for (const dir of [paths.root, paths.repos, paths.worktrees, paths.buildfs, paths.state]) {
      expect(statSync(dir).isDirectory(), dir).toBe(true);
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    }
    // A folder that is already there is not a folder this call made.
    chmodSync(paths.state, 0o750);
    await ensureRegistryDirs(root);
    expect(statSync(paths.state).mode & 0o777).toBe(0o750);
  });
});

describe("the approved hook text", () => {
  it("keeps the shell's own expansion of the checked-out ref", () => {
    expect(REFERENCE_TRANSACTION_HOOK.startsWith("#!/bin/sh\n")).toBe(true);
    expect(REFERENCE_TRANSACTION_HOOK.endsWith("exit $rc\n")).toBe(true);
    // The one escape of the JavaScript literal: the shell must still expand it.
    expect(REFERENCE_TRANSACTION_HOOK).toContain(
      'echo "refguard: a registry worktree may not check out ${new#ref:}" >&2',
    );
    expect(REFERENCE_TRANSACTION_HOOK).not.toContain("\\${");
  });
});

/** Whether this git calls the reference-transaction hook when a check out moves HEAD. */
const hookSeesCheckout = ((): boolean => {
  const dir = tempRoot("registry-probe-");
  try {
    gitOk(dir, ["init", "--quiet", "--initial-branch=main", "."]);
    gitOk(dir, ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "probe"]);
    gitOk(dir, ["branch", "other"]);
    const log = join(dir, "hook-calls");
    const hook = join(dir, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${log}'\n`, "utf8");
    chmodSync(hook, 0o755);
    gitOk(dir, ["checkout", "--quiet", "other"]);
    return existsSync(log);
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("the reference-transaction hook in a real repository", () => {
  let root: string;
  let bare: string;
  let worktree: string;

  beforeEach(() => {
    root = tempRoot("registry-hook-");
    bare = bareWithMain(root, "t");
    installHook(bare, root);
    worktree = worktreeDir(root, "local/t", "a");
    gitOk(bare, ["worktree", "add", "--quiet", worktree, "-b", "wt/a"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a commit, a stash, a tag, a new branch and a rebase that replays", () => {
    writeFileSync(join(worktree, "a.txt"), "a\n", "utf8");
    gitOk(worktree, ["add", "a.txt"]);
    expect(git(worktree, ["commit", "--quiet", "-m", "first"]).status, "a commit").toBe(0);

    writeFileSync(join(worktree, "a.txt"), "changed\n", "utf8");
    expect(git(worktree, ["stash", "--quiet"]).status, "git stash").toBe(0);
    expect(git(worktree, ["stash", "pop", "--quiet"]).status, "git stash pop").toBe(0);
    gitOk(worktree, ["checkout", "--", "a.txt"]);

    expect(git(worktree, ["tag", "v1"]).status, "a tag").toBe(0);
    expect(git(worktree, ["checkout", "--quiet", "-b", "feature/a"]).status, "checkout -b").toBe(0);

    writeFileSync(join(worktree, "b.txt"), "b\n", "utf8");
    gitOk(worktree, ["add", "b.txt"]);
    gitOk(worktree, ["commit", "--quiet", "-m", "second"]);

    // A second worktree commits, and an update outside every worktree moves
    // main to that commit. That is the one way main moves without a landing.
    const other = worktreeDir(root, "local/t", "b");
    expect(git(bare, ["worktree", "add", "--quiet", other, "-b", "wt/b"]).status, "a second worktree").toBe(0);
    writeFileSync(join(other, "c.txt"), "c\n", "utf8");
    gitOk(other, ["add", "c.txt"]);
    gitOk(other, ["commit", "--quiet", "-m", "third"]);
    const otherHead = gitOk(other, ["rev-parse", "HEAD"]).stdout.trim();
    const oldMain = gitOk(bare, ["rev-parse", "main"]).stdout.trim();
    expect(
      git(root, ["--git-dir", bare, "update-ref", "refs/heads/main", otherHead, oldMain]).status,
      "update-ref outside every worktree",
    ).toBe(0);
    expect(gitOk(bare, ["rev-parse", "main"]).stdout.trim()).toBe(otherHead);

    // The branch has a commit main does not have, so this rebase replays it.
    // git detaches HEAD and then moves the branch, and the hook reads the branch
    // from the rebase folder, so the replay is allowed.
    expect(git(worktree, ["rebase", "--quiet", "main"]).status, "a rebase that replays").toBe(0);
    expect(gitOk(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("feature/a");
    expect(gitOk(worktree, ["rev-list", "--count", "main..feature/a"]).stdout.trim(), "the replayed commits").toBe("2");
    expect(existsSync(join(bare, "worktrees", "a", "rebase-merge")), "the rebase folder").toBe(false);
  });

  it("allows a rebase to continue after the conflict is resolved", () => {
    writeFileSync(join(worktree, "common.txt"), "worktree\n", "utf8");
    gitOk(worktree, ["add", "common.txt"]);
    gitOk(worktree, ["commit", "--quiet", "-m", "worktree edit"]);

    const other = worktreeDir(root, "local/t", "b");
    gitOk(bare, ["worktree", "add", "--quiet", other, "-b", "wt/b"]);
    writeFileSync(join(other, "common.txt"), "mainline\n", "utf8");
    gitOk(other, ["add", "common.txt"]);
    gitOk(other, ["commit", "--quiet", "-m", "mainline edit"]);
    gitOk(bare, ["update-ref", "refs/heads/main", gitOk(other, ["rev-parse", "HEAD"]).stdout.trim()]);

    // Both branches changed the same line, so git stops the rebase and asks for
    // a resolution. The stop is git's, not the hook's refusal.
    expect(git(worktree, ["rebase", "main"]).status, "a conflicting rebase stops").not.toBe(0);
    writeFileSync(join(worktree, "common.txt"), "resolved\n", "utf8");
    gitOk(worktree, ["add", "common.txt"]);

    const continued = git(worktree, ["rebase", "--continue"], { GIT_EDITOR: "true" });
    expect(continued.status, "rebase --continue").toBe(0);
    expect(gitOk(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("wt/a");
    expect(existsSync(join(bare, "worktrees", "a", "rebase-merge")), "the rebase folder").toBe(false);
  });

  it("refuses a deletion of a tag and a moved main", () => {
    writeFileSync(join(worktree, "a.txt"), "a\n", "utf8");
    gitOk(worktree, ["add", "a.txt"]);
    gitOk(worktree, ["commit", "--quiet", "-m", "first"]);
    gitOk(worktree, ["tag", "v1"]);
    const head = gitOk(worktree, ["rev-parse", "HEAD"]).stdout.trim();

    const tag = git(worktree, ["tag", "-d", "v1"]);
    expect(tag.status, "tag -d").not.toBe(0);
    expect(tag.stderr).toContain("refguard: deleting refs/tags/v1 is refused");

    const branch = git(worktree, ["branch", "-f", "main", head]);
    expect(branch.status, "branch -f main").not.toBe(0);
    expect(branch.stderr).toContain("refguard: refs/heads/main is moved by a landing or the update script");

    // Nothing moved: the branch is still the one the worktree took out, and main
    // is still the commit the repository was made with.
    expect(gitOk(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("wt/a");
    expect(gitOk(bare, ["rev-parse", "main"]).stdout.trim()).not.toBe(head);
  });

  // Some git versions never call the reference-transaction hook for a check out,
  // so the hook cannot refuse one there. The probe runs a check out in a
  // temporary repository and sees whether the hook was called.
  it.skipIf(!hookSeesCheckout)("refuses a check out of main", () => {
    writeFileSync(join(worktree, "a.txt"), "a\n", "utf8");
    gitOk(worktree, ["add", "a.txt"]);
    gitOk(worktree, ["commit", "--quiet", "-m", "first"]);
    const head = gitOk(worktree, ["rev-parse", "HEAD"]).stdout.trim();

    const checkout = git(worktree, ["checkout", "--quiet", "main"]);
    expect(checkout.status, "checkout main").not.toBe(0);
    expect(checkout.stderr).toContain("refguard: a registry worktree may not check out refs/heads/main");
    expect(gitOk(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("wt/a");
    expect(gitOk(bare, ["rev-parse", "main"]).stdout.trim()).not.toBe(head);
  });

  it("refuses a move of another worktree's branch and of a tag that already exists", () => {
    const other = worktreeDir(root, "local/t", "b");
    gitOk(bare, ["worktree", "add", "--quiet", other, "-b", "wt/b"]);
    writeFileSync(join(other, "c.txt"), "c\n", "utf8");
    gitOk(other, ["add", "c.txt"]);
    gitOk(other, ["commit", "--quiet", "-m", "third"]);
    const otherHead = gitOk(other, ["rev-parse", "HEAD"]).stdout.trim();

    writeFileSync(join(worktree, "a.txt"), "a\n", "utf8");
    gitOk(worktree, ["add", "a.txt"]);
    gitOk(worktree, ["commit", "--quiet", "-m", "first"]);
    const head = gitOk(worktree, ["rev-parse", "HEAD"]).stdout.trim();

    // No old value is named, so git reports it as an all-zero value. The branch
    // exists, so the hook reads the line as a move of a branch that is not this
    // worktree's, and refuses it.
    const moved = git(worktree, ["update-ref", "refs/heads/wt/b", head]);
    expect(moved.status, "update-ref without the old value").not.toBe(0);
    expect(moved.stderr).toContain("refguard: refs/heads/wt/b is not this worktree's branch");
    expect(gitOk(bare, ["rev-parse", "refs/heads/wt/b"]).stdout.trim()).toBe(otherHead);

    // A tag that exists is not moved, also when the new value is a commit.
    gitOk(worktree, ["tag", "v1"]);
    const tagBefore = gitOk(bare, ["rev-parse", "refs/tags/v1"]).stdout.trim();
    const earlier = gitOk(worktree, ["rev-parse", "HEAD~1"]).stdout.trim();
    const forced = git(worktree, ["tag", "-f", "v1", earlier]);
    expect(forced.status, "tag -f").not.toBe(0);
    expect(forced.stderr).toContain("refguard: moving refs/tags/v1 is refused");
    expect(gitOk(bare, ["rev-parse", "refs/tags/v1"]).stdout.trim()).toBe(tagBefore);
  });

  it("does nothing in a worktree outside the registry root", () => {
    // The repository is registered, but the worktree is not under the root's
    // worktree folder, so the hook leaves it alone.
    const elsewhere = join(root, "elsewhere");
    gitOk(bare, ["worktree", "add", "--quiet", elsewhere, "-b", "side"]);
    writeFileSync(join(elsewhere, "x.txt"), "x\n", "utf8");
    gitOk(elsewhere, ["add", "x.txt"]);
    gitOk(elsewhere, ["commit", "--quiet", "-m", "side"]);
    const side = gitOk(elsewhere, ["rev-parse", "HEAD"]).stdout.trim();

    // The command the worktree above refuses passes here.
    expect(git(elsewhere, ["branch", "-f", "main", side]).status, "branch -f main outside").toBe(0);
    expect(gitOk(bare, ["rev-parse", "main"]).stdout.trim()).toBe(side);
  });

  it("does nothing in a repository that names no registry root", () => {
    const other = tempRoot("registry-noconfig-");
    try {
      const otherBare = bareWithMain(other, "n");
      installHook(otherBare, other);
      gitOk(otherBare, ["config", "--unset", "pi-sec.registryRoot"]);
      // The worktree is inside this root's worktree folder, so only the missing
      // config value keeps the hook out of the way.
      const guarded = worktreeDir(other, "local/n", "a");
      gitOk(otherBare, ["worktree", "add", "--quiet", guarded, "main"]);

      writeFileSync(join(guarded, "y.txt"), "y\n", "utf8");
      gitOk(guarded, ["add", "y.txt"]);
      // A commit on main, which the hook refuses once the root is configured.
      expect(git(guarded, ["commit", "--quiet", "-m", "on main"]).status, "commit on main").toBe(0);

      gitOk(otherBare, ["config", "pi-sec.registryRoot", other]);
      writeFileSync(join(guarded, "z.txt"), "z\n", "utf8");
      gitOk(guarded, ["add", "z.txt"]);
      expect(git(guarded, ["commit", "--quiet", "-m", "refused"]).status, "commit on main with the root set").not.toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("installing and checking the hook", () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot("registry-install-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("installs it executable with the root set, and reports both", () => {
    const bare = bareWithMain(root, "c");
    expect(checkHook(bare, root)).toEqual({ present: false, executable: false, configured: false, matches: false });

    installHook(bare, root);
    expect(checkHook(bare, root)).toEqual({ present: true, executable: true, configured: true, matches: true });
    const file = join(bare, "hooks", "reference-transaction");
    expect(readFileSync(file, "utf8")).toBe(REFERENCE_TRANSACTION_HOOK);
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it("puts the mode and the config right when the same hook is already there", () => {
    const bare = bareWithMain(root, "d");
    installHook(bare, root);
    const file = join(bare, "hooks", "reference-transaction");
    chmodSync(file, 0o644);
    expect(checkHook(bare, root).executable).toBe(false);

    expect(() => installHook(bare, root)).not.toThrow();
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(checkHook(bare, root)).toEqual({ present: true, executable: true, configured: true, matches: true });
  });

  it("refuses to replace another hook and changes nothing", () => {
    const bare = bareWithMain(root, "e");
    installHook(bare, root);
    const file = join(bare, "hooks", "reference-transaction");
    const other = "#!/bin/sh\nexit 0\n";
    writeFileSync(file, other, "utf8");
    gitOk(bare, ["config", "pi-sec.registryRoot", "/somewhere/else"]);

    expect(() => installHook(bare, root)).toThrow(/refusing to replace/);
    expect(readFileSync(file, "utf8")).toBe(other);
    expect(gitOk(bare, ["config", "--get", "pi-sec.registryRoot"]).stdout.trim()).toBe("/somewhere/else");
    expect(checkHook(bare, root)).toEqual({ present: true, executable: true, configured: false, matches: false });
    expect(checkHook(bare, "/somewhere/else").configured).toBe(true);
  });

  it("reports a repository with no hook file", () => {
    const bare = bareWithMain(root, "f");
    expect(checkHook(bare, root).present).toBe(false);
  });
});
