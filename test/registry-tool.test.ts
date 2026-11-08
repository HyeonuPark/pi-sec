/**
 * The registry command line and the one registry tool.
 *
 * Every command runs through `main()` in this process rather than through a
 * child process: the CLI takes its home from `PI_SEC_HOME`, so a temporary home
 * and a captured stdout is all a command needs, and a file of eight commands
 * stays under a few seconds. The core is not faked: real git makes the bare
 * repository and the worktree, and a small shell script plays the part of an
 * install, exactly as `test/registry-flow.test.ts` does it.
 *
 * Nothing here waits on the clock. The install time is set with `utimesSync`
 * where a test needs one.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { main } from "../src/cli.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createRegistryExtension } from "../src/extensions/registry/index.ts";
import { loadConfig } from "../src/config/load.ts";
import { buildPaths } from "../src/runtime/paths.ts";
import {
  bareRepoDir,
  inPlaceRecordPath,
  registryPaths,
  registrySettings,
  worktreeDir,
  type RegistrySettings,
} from "../src/registry/layout.ts";
import { listRegistry, showRepo } from "../src/registry/store.ts";

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

const SAVED_ENV = new Map<string, string | undefined>();

let HOME = "";
let ROOT = "";
let settings: RegistrySettings;
let config: Awaited<ReturnType<typeof loadConfig>>["config"];

/** The install script: it copies the lockfile into the marker npm writes. */
const INSTALL_SCRIPT = `#!/bin/sh
set -e
mkdir -p node_modules/pkg
cp package-lock.json node_modules/.package-lock.json
printf 'v1\\n' > node_modules/pkg/value
`;

interface CliRun {
  code: number;
  out: string;
  err: string;
}

/** Run one command through `main()`, with stdout and stderr captured. */
async function runCli(args: readonly string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
  try {
    const code = await main([...args]);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

/** Run one git command and report its exit status whatever it is. */
function git(cwd: string, args: readonly string[]) {
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
function gitOk(cwd: string, args: readonly string[]) {
  const run = git(cwd, args);
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${run.status}): ${run.stderr.trim()}`);
  return run;
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

/**
 * Two commits on `main` in the bare repository, so a test has an older commit
 * to refuse as a `main` that is behind. The first commit is `first`, the second
 * is what `main` points at.
 */
function seed(bare: string, work: string): { first: string; head: string } {
  mkdirSync(work, { recursive: true, mode: 0o700 });
  gitOk(work, ["init", "-b", "main"]);
  writeFileSync(join(work, ".gitignore"), "node_modules/\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-m", "one"]);
  const first = gitOk(work, ["rev-parse", "HEAD"]).stdout.trim();
  writeLockfile(work, "1.0.0");
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-m", "two"]);
  const head = gitOk(work, ["rev-parse", "HEAD"]).stdout.trim();
  gitOk(work, ["push", bare, "main"]);
  return { first, head };
}

/** The parsed stdout of one command that must have printed JSON and succeeded. */
function jsonOf(run: CliRun): unknown {
  expect(run.code, run.err).toBe(0);
  return JSON.parse(run.out) as unknown;
}

/** The text of one tool result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(GIT_VARIABLES)) {
    SAVED_ENV.set(name, process.env[name]);
    process.env[name] = value;
  }
  SAVED_ENV.set("PI_SEC_HOME", process.env["PI_SEC_HOME"]);

  HOME = mkdtempSync(join(tmpdir(), "registry-tool-home-"));
  process.env["PI_SEC_HOME"] = HOME;

  const script = join(HOME, "install.sh");
  writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  // The registry settings a fresh install does not carry: a copy-mode build
  // directory whose install is the script above, so no npm runs in a test.
  writeFileSync(
    join(HOME, "config.json"),
    `${JSON.stringify(
      {
        registry: {
          mode: "copy",
          buildDirs: [{ dir: "node_modules", lockfile: "package-lock.json", install: ["sh", script] }],
        },
      },
      null,
      2,
    )}\n`,
  );

  config = (await loadConfig({ home: HOME })).config;
  settings = registrySettings(config);
  ROOT = settings.root;
});

afterAll(() => {
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (HOME !== "") rmSync(HOME, { recursive: true, force: true, maxRetries: 3 });
});

describe("pi-sec repos", () => {
  let bare = "";

  it("reports the usage and exit code of a command line that names nothing", async () => {
    const bare_ = await runCli(["repos"]);
    expect(bare_.code).toBe(2);
    expect(bare_.out).toBe("");
    expect(bare_.err).toContain("usage: pi-sec repos");

    const unknown = await runCli(["repos", "bogus"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown repos command: bogus");

    const help = await runCli(["repos", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: pi-sec repos");
    expect(help.out).toContain("worktree refill");
  });

  it("lists an empty registry instead of failing on a root that does not exist", async () => {
    const listing = jsonOf(await runCli(["repos", "list", "--json"]));
    expect(listing).toEqual({ root: ROOT, mode: "copy", repos: [], worktrees: [], caches: [] });

    const human = await runCli(["repos", "list"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`root: ${ROOT} (buildfs mode copy)`);
    expect(human.out).toContain("(none)");
  });

  it("registers a bare repository and refuses the same name twice", async () => {
    const run = await runCli(["repos", "register", "--name", "local/t"]);
    const created = jsonOf(run) as { id: string; gitDir: string; inPlace: boolean };
    bare = bareRepoDir(ROOT, "local/t");
    expect(created).toEqual({ id: "local/t", gitDir: bare, inPlace: false });
    expect(statSync(bare).isDirectory()).toBe(true);

    const hook = join(bare, "hooks", "reference-transaction");
    expect(existsSync(hook)).toBe(true);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(gitOk(ROOT, ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"]).stdout.trim()).toBe("main");
    expect(gitOk(ROOT, ["--git-dir", bare, "config", "--get", "pi-sec.registryRoot"]).stdout.trim()).toBe(ROOT);

    const again = await runCli(["repos", "register", "--name", "local/t"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already registered");
  });

  it("needs --name, and needs a real path for --in-place", async () => {
    const noName = await runCli(["repos", "register"]);
    expect(noName.code).toBe(2);
    expect(noName.err).toContain("--name");

    const noPath = await runCli(["repos", "register", "--name", "local/x", "--in-place"]);
    expect(noPath.code).toBe(2);
    expect(noPath.err).toContain("--in-place");
  });

  it("adds a worktree and fills its build directory with the configured install", async () => {
    const seeded = seed(bare, join(HOME, "seed"));
    expect(seeded.head).toMatch(/^[0-9a-f]{40}$/u);

    const added = jsonOf(await runCli(["repos", "worktree", "add", "local/t", "one"])) as {
      repo: string;
      path: string;
      branch: string;
      mode: string;
      buildDirs: { dir: string; filledFrom: string | null; installed: boolean }[];
    };
    expect(added.repo).toBe("local/t");
    expect(added.path).toBe(worktreeDir(ROOT, "local/t", "one"));
    expect(added.branch).toBe("wt/one");
    expect(added.mode).toBe("copy");
    expect(added.buildDirs).toEqual([{ dir: "node_modules", filledFrom: null, installed: true }]);
    expect(readFileSync(join(added.path, "node_modules", "pkg", "value"), "utf8")).toBe("v1\n");
    expect(existsSync(join(added.path, "node_modules", ".package-lock.json"))).toBe(true);
  });

  it("lists and shows one repository in the shape the core returns", async () => {
    const run = await runCli(["repos", "list", "--json"]);
    const listing = jsonOf(run) as {
      repos: { id: string; gitDir: string; defaultBranch: string; hookInstalled: boolean }[];
      worktrees: { repo: string; branch: string; jobId: string | null; jobTitle: string | null; buildDirs: unknown[] }[];
      caches: unknown[];
    };
    expect(listing).toEqual(await listRegistry(settings));

    expect(listing.repos.map((repo) => repo.id)).toEqual(["local/t"]);
    expect(listing.repos[0]).toMatchObject({
      id: "local/t",
      gitDir: bare,
      defaultBranch: "main",
      hookInstalled: true,
    });
    expect(listing.worktrees).toHaveLength(1);
    expect(listing.worktrees[0]).toMatchObject({ repo: "local/t", branch: "wt/one", jobId: null, jobTitle: null });
    expect(listing.worktrees[0]?.buildDirs).toHaveLength(1);

    const shown = jsonOf(await runCli(["repos", "show", "local/t", "--json"]));
    expect(shown).toEqual(await showRepo(settings, "local/t"));

    const missing = await runCli(["repos", "show", "local/absent", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not registered");

    const human = await runCli(["repos", "list"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("local/t");
    expect(human.out).toContain("worktrees (1)");
    expect(human.out).toContain("wt/one");
  });

  it("refreshes and prunes the caches", async () => {
    const refreshed = jsonOf(await runCli(["repos", "cache", "refresh"])) as {
      repo: string;
      buildDir: string | null;
      action: string;
      cache?: { path: string };
      pruned: string[];
    }[];
    const entry = refreshed.find((item) => item.repo === "local/t" && item.buildDir === "node_modules");
    expect(entry?.action).toBe("created");
    const cachePath = entry?.cache?.path ?? "";
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(registryPaths(ROOT).lastRefresh)).toBe(true);

    // The newest cache already holds this lockfile and is newer than the
    // install, so the second run creates nothing.
    const marker = join(worktreeDir(ROOT, "local/t", "one"), "node_modules", ".package-lock.json");
    const older = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(marker, older, older);
    const again = jsonOf(await runCli(["repos", "cache", "refresh", "local/t"])) as { action: string }[];
    expect(again.some((item) => item.action === "skipped")).toBe(true);

    const pruned = jsonOf(await runCli(["repos", "cache", "prune"]));
    expect(Array.isArray(pruned)).toBe(true);
  });

  it("refills a worktree's build directory from the cache", async () => {
    const refilled = jsonOf(await runCli(["repos", "worktree", "refill", "local/t", "one"])) as {
      path: string;
      buildDirs: { dir: string; filledFrom: string | null; installed: boolean }[];
    };
    expect(refilled.path).toBe(worktreeDir(ROOT, "local/t", "one"));
    expect(refilled.buildDirs[0]?.dir).toBe("node_modules");
    expect(refilled.buildDirs[0]?.filledFrom).not.toBeNull();
    expect(refilled.buildDirs[0]?.installed).toBe(false);
  });

  it("moves main forward and refuses a branch that is behind it", async () => {
    const same = jsonOf(await runCli(["repos", "ff", "local/t", "main"])) as { from: string; to: string };
    expect(same.from).toBe(same.to);

    // The first seed commit, which main has passed.
    const first = gitOk(ROOT, ["--git-dir", bare, "rev-list", "--max-parents=0", "main"]).stdout.trim();
    gitOk(ROOT, ["--git-dir", bare, "branch", "old", first]);
    const behind = await runCli(["repos", "ff", "local/t", "old"]);
    expect(behind.code).toBe(1);
    expect(behind.err).toContain("main holds commits");

    const unknown = await runCli(["repos", "ff", "local/t", "no-such-branch"]);
    expect(unknown.code).toBe(1);
  });

  it("reports a missing worktree name as a usage error", async () => {
    const run = await runCli(["repos", "worktree", "add", "local/t"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("needs <repo> <name>");
  });

  it("removes a worktree, and its build directory with it", async () => {
    const path = worktreeDir(ROOT, "local/t", "one");
    const removed = jsonOf(await runCli(["repos", "worktree", "remove", "local/t", "one"])) as {
      path: string;
      buildDirs: string[];
    };
    expect(removed.path).toBe(path);
    expect(removed.buildDirs).toEqual([join(path, "node_modules")]);
    expect(existsSync(path)).toBe(false);
  });

  it("registers a repository where it already lives", async () => {
    const plain = join(HOME, "plain");
    gitOk(HOME, ["init", "-b", "main", plain]);
    writeFileSync(join(plain, "a.txt"), "a\n");
    gitOk(plain, ["add", "a.txt"]);
    gitOk(plain, ["commit", "-m", "one"]);

    const registered = jsonOf(
      await runCli(["repos", "register", "--in-place", join(plain, ".git"), "--name", "host"]),
    ) as { id: string; gitDir: string; inPlace: boolean };
    expect(registered).toEqual({ id: "local/host", gitDir: join(plain, ".git"), inPlace: true });
    expect(existsSync(inPlaceRecordPath(ROOT, "local/host"))).toBe(true);
    expect(existsSync(join(plain, ".git", "hooks", "reference-transaction"))).toBe(true);
  });

  it("reports the hook checks with doctor, and fails when the hook cannot run", async () => {
    const healthy = await runCli(["repos", "doctor", "--json"]);
    const report = jsonOf(healthy) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.name === "hook present local/t" && check.ok)).toBe(true);
    expect(report.checks.some((check) => check.name === "hook content local/t" && check.ok)).toBe(true);

    const hook = join(bare, "hooks", "reference-transaction");
    chmodSync(hook, 0o644);
    const broken = await runCli(["repos", "doctor"]);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("FAIL hook executable local/t");
    expect(broken.out).toContain("doctor: not ok");

    chmodSync(hook, 0o755);
    expect((await runCli(["repos", "doctor"])).code).toBe(0);
  });
});

describe("the repos_list tool", () => {
  /** A context with the config and nothing else: the tool needs no harness. */
  function stubContext(): ExtensionContext {
    return { getConfig: () => config, paths: buildPaths(HOME) } as unknown as ExtensionContext;
  }

  function tool() {
    const extension = createRegistryExtension(stubContext());
    const found = (extension.tools ?? []).find((entry) => entry.name === "repos_list");
    if (found === undefined) throw new Error("the registry extension registers no repos_list tool");
    return found;
  }

  it("is read-only and describes its argument and result", () => {
    const reposList = tool();
    expect(reposList.replay).toBe("safe");
    expect(reposList.description).toContain(
      "Read the repositories, worktrees and buildfs caches of the git repository registry. It does not change the registry.",
    );
    expect(reposList.description).toContain("buildDirs");
    expect(reposList.description).toContain("hookInstalled");
  });

  it("answers with the same JSON as the listing, and narrows to one repository", async () => {
    const all = await tool().execute({}, {} as never, BACKGROUND_CONTEXT);
    expect(JSON.parse(textOf(all))).toEqual(await listRegistry(settings));

    const one = await tool().execute({ repo: "local/t" }, {} as never, BACKGROUND_CONTEXT);
    expect(JSON.parse(textOf(one))).toEqual(await showRepo(settings, "local/t"));

    const missing = await tool().execute({ repo: "local/absent" }, {} as never, BACKGROUND_CONTEXT);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("not registered");
  });
});
