import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The stop check in `user-tools/update-and-restart` and `user-tools/rollback`.
 *
 * With a systemd unit the scripts stop the service before they touch the tree.
 * Without one there is nothing to stop, so they now ask `pi-sec status` whether a
 * daemon of this home runs, and refuse before the first change when it does. The
 * tree they would merge or reset is the tree that daemon loads its modules from.
 *
 * Two trees are real git repositories here, laid out the way the scripts expect:
 * `workspace` on branch `main`, and `snapshot` a worktree of it on branch
 * `snapshot`, one commit behind. `npm`, `systemctl` and the build under
 * `snapshot/dist/cli.js` are fakes on PATH: no install runs, no unit is touched,
 * and the status answer is whatever the test asks for.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UPDATE = join(REPO, "user-tools", "update-and-restart");
const ROLLBACK = join(REPO, "user-tools", "rollback");

const roots = new Set<string>();

const GIT_IDENTITY = ["-c", "user.name=pi-sec test", "-c", "user.email=test@localhost"];

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly homeDir: string;
  readonly workspace: string;
  readonly snapshot: string;
  readonly bin: string;
  readonly npmLog: string;
  readonly systemctlLog: string;
  /** The commit `snapshot` is on: the workspace's first commit. */
  readonly first: string;
  /** The commit `main` is on: the workspace's second commit. */
  readonly second: string;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((settle, fail) => {
    execFile("git", [...GIT_IDENTITY, ...args], { cwd }, (error, stdout, stderr) => {
      if (error !== null) fail(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
      else settle(stdout.trim());
    });
  });
}

/** A fake command that records its arguments, so a call it should not get fails the test. */
async function fake(bin: string, name: string, script: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/usr/bin/env bash\n${script}\n`);
  await chmod(path, 0o700);
}

/** What the second commit of a sandbox adds besides `two.txt`: the files under `user-tools/`. */
type Installer = (workspace: string, log: string) => Promise<void>;

async function sandbox(installer?: Installer): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-update-scripts-"));
  roots.add(root);
  const home = join(root, "pi-sec");
  const homeDir = join(root, "home");
  const workspace = join(home, "workspace");
  const snapshot = join(home, "snapshot");
  const bin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  const systemctlLog = join(root, "systemctl.log");
  for (const dir of [home, homeDir, workspace, bin, join(home, "run"), join(home, "logs")]) {
    await mkdir(dir, { recursive: true });
  }

  // `dist/` and `node_modules/` are ignored, so the fake build below neither
  // dirties the tree nor blocks a rollback's clean-tree check.
  await writeFile(join(workspace, ".gitignore"), "dist/\nnode_modules/\n");
  await git(workspace, ["init", "-b", "main"]);
  await writeFile(join(workspace, "one.txt"), "one\n");
  await git(workspace, ["add", ".gitignore", "one.txt"]);
  await git(workspace, ["commit", "-m", "one"]);
  const first = await git(workspace, ["rev-parse", "HEAD"]);
  await git(workspace, ["branch", "snapshot"]);
  await git(workspace, ["worktree", "add", snapshot, "snapshot"]);
  await writeFile(join(workspace, "two.txt"), "two\n");
  await git(workspace, ["add", "two.txt"]);
  if (installer !== undefined) {
    await installer(workspace, join(root, "installer.log"));
    await git(workspace, ["add", "user-tools"]);
  }
  await git(workspace, ["commit", "-m", "two"]);
  const second = await git(workspace, ["rev-parse", "HEAD"]);

  // The build the scripts ask for `status`. It answers the way a daemon's own
  // `status` would: 0 when a pid file names a live process, 1 when not.
  await mkdir(join(snapshot, "dist"), { recursive: true });
  await writeFile(
    join(snapshot, "dist", "cli.js"),
    `if (process.argv[2] !== "status") {
  process.stderr.write("unexpected command: " + process.argv.slice(2).join(" ") + "\\n");
  process.exit(2);
}
process.stdout.write("pi-sec test\\nhome: " + (process.env.PI_SEC_HOME ?? "(none)") + "\\n");
process.exit(Number(process.env.FAKE_STATUS_EXIT ?? "1"));
`,
  );

  await fake(bin, "npm", `printf '%s\\n' "$*" >> "${npmLog}"\nexit 0`);
  await fake(bin, "systemctl", `printf '%s\\n' "$*" >> "${systemctlLog}"\nexit 1`);

  return { root, home, homeDir, workspace, snapshot, bin, npmLog, systemctlLog, first, second };
}

/** The environment a child gets: nothing of this process's, and no bus. */
function childEnv(sb: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sb.bin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: sb.homeDir,
    PI_SEC_HOME: sb.home,
    TERM: "dumb",
    ...extra,
  };
  // Rules 2 and 2a of this stage. Without both, `systemctl --user` in the script
  // would reach the live unit of this account, and the stop check would drive it.
  expect(env.XDG_RUNTIME_DIR, "the child must not carry a runtime directory").toBeUndefined();
  expect(env.DBUS_SESSION_BUS_ADDRESS, "the child must not carry a bus address").toBeUndefined();
  return env;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(sb: Sandbox, script: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  const env = childEnv(sb, extra);
  return new Promise<Run>((settle) => {
    execFile("bash", [script, ...args], { env, cwd: sb.root, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      settle({ code, stdout, stderr });
    });
  });
}

async function lines(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
}

async function headOf(sb: Sandbox): Promise<string> {
  return git(sb.snapshot, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

/** A fake installer that records how it was called, then exits with `status`. */
function fakeInstaller(status: number): Installer {
  return async (workspace, log) => {
    await mkdir(join(workspace, "user-tools"), { recursive: true });
    const path = join(workspace, "user-tools", "install-git-hooks");
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "${log}"\nexit ${status}\n`);
    await chmod(path, 0o755);
  };
}

/** The real installer and the real hooks, copied into the applied commit. */
const realInstaller: Installer = async (workspace) => {
  await cp(join(REPO, "user-tools"), join(workspace, "user-tools"), { recursive: true });
};

describe("the hook step of update-and-restart", () => {
  it("runs the installer of the execution tree with --update and the workspace path", async () => {
    const sb = await sandbox(fakeInstaller(0));
    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(await lines(join(sb.root, "installer.log"))).toEqual([
      `${sb.snapshot}/user-tools/install-git-hooks --update ${sb.workspace}`,
    ]);
    expect(await lines(sb.npmLog)).toEqual(["ci", "run build"]);
  });

  it("installs the shipped hooks into the workspace and creates both install files with mode 600", async () => {
    const sb = await sandbox(realInstaller);
    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "1" });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
      const installed = join(sb.workspace, ".git", "hooks", name);
      expect(await readFile(installed, "utf8")).toBe(await readFile(join(REPO, "user-tools", "git-hooks", name), "utf8"));
    }
    for (const name of ["scan-words.txt", "commit-identities.txt"]) {
      expect((await stat(join(sb.home, name))).mode & 0o777, name).toBe(0o600);
    }
  });

  it("goes on and prints a note when the installer exits 1", async () => {
    const sb = await sandbox(fakeInstaller(1));
    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("note: the commit hooks were not updated");
    expect(await headOf(sb)).toBe(sb.second);
    expect(await lines(sb.npmLog)).toEqual(["ci", "run build"]);
  });

  it("runs no installer under --check", async () => {
    const sb = await sandbox(fakeInstaller(0));
    const result = await run(sb, UPDATE, ["--check"], { FAKE_STATUS_EXIT: "1" });
    expect(result.code, result.stderr).toBe(0);
    expect(await lines(join(sb.root, "installer.log"))).toEqual([]);
  });
});

describe("update-and-restart with no systemd unit", () => {
  it("refuses, and changes nothing, while a daemon of this home runs", async () => {
    const sb = await sandbox();

    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "0" });

    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(`a pi-sec daemon is running for ${sb.home}`);
    expect(result.stderr).toContain("nothing was changed");
    // The tree is where it was: no merge, no install, no build.
    expect(await headOf(sb)).toBe(sb.first);
    expect(await git(sb.snapshot, ["status", "--porcelain"])).toBe("");
    expect(await lines(sb.npmLog)).toEqual([]);
  });

  it("applies the update when nothing runs", async () => {
    const sb = await sandbox();

    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "1" });

    expect(result.code, result.stderr).toBe(0);
    expect(await headOf(sb)).toBe(sb.second);
    expect(existsSync(join(sb.snapshot, "two.txt"))).toBe(true);
    expect(await lines(sb.npmLog)).toEqual(["ci", "run build"]);
    // With no unit, the script says what to do next and does not pretend a start.
    expect(result.stdout).toContain("start your supervised 'pi-sec start' process");
  });

  it("keeps --check read-only and usable while a daemon runs", async () => {
    const sb = await sandbox();

    const result = await run(sb, UPDATE, ["--check"], { FAKE_STATUS_EXIT: "0" });

    expect(result.code, result.stderr).toBe(0);
    expect(await headOf(sb)).toBe(sb.first);
    expect(await lines(sb.npmLog)).toEqual([]);
    expect(result.stdout).toContain("commits to apply: 1");
  });

  it("refuses under the runner and points at the restart button", async () => {
    const sb = await sandbox();

    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "0", PI_SEC_RUNNER: "1" });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("restart button in the web UI");
    // A daemon under the runner has no unit, so the script never probes for one:
    // the fake `systemctl` records nothing, and the real one is never reached.
    expect(await lines(sb.systemctlLog)).toEqual([]);
    expect(await headOf(sb)).toBe(sb.first);
  });

  it("says the runner starts the daemon again, and probes no unit", async () => {
    const sb = await sandbox();

    const result = await run(sb, UPDATE, [], { FAKE_STATUS_EXIT: "1", PI_SEC_RUNNER: "1" });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("the runner starts the daemon again");
    expect(await lines(sb.systemctlLog)).toEqual([]);
    expect(await headOf(sb)).toBe(sb.second);
  });
});

describe("rollback with no systemd unit", () => {
  it("refuses, and moves nothing, while a daemon of this home runs", async () => {
    const sb = await sandbox();
    await git(sb.snapshot, ["merge", "--ff-only", "main"]);
    expect(await headOf(sb)).toBe(sb.second);

    const result = await run(sb, ROLLBACK, [sb.first], { FAKE_STATUS_EXIT: "0" });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`a pi-sec daemon is running for ${sb.home}`);
    expect(await headOf(sb)).toBe(sb.second);
    expect(await lines(sb.npmLog)).toEqual([]);
  });

  it("moves the execution tree back when nothing runs", async () => {
    const sb = await sandbox();
    await git(sb.snapshot, ["merge", "--ff-only", "main"]);

    const result = await run(sb, ROLLBACK, [sb.first], { FAKE_STATUS_EXIT: "1" });

    expect(result.code, result.stderr).toBe(0);
    expect(await headOf(sb)).toBe(sb.first);
    expect(await lines(sb.npmLog)).toEqual(["ci", "run build"]);
    expect(result.stdout).toContain("start your supervised 'pi-sec start' process");
  });
});
