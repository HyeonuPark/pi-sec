import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `--pull` and `--check --pull` in `user-tools/update-and-restart`.
 *
 * The script moves the workspace tree's `main` to a commit it did not have
 * before, then applies that commit to the execution tree and builds it. The
 * remote is a bare repository in the sandbox, and a second clone of it plays the
 * publisher: a commit pushed there is what a new release looks like.
 *
 * The merge is a fast-forward and nothing else. The agent commits its own edits
 * to `main`, so the two sides diverge in normal use, and the script must refuse
 * instead of leaving a conflict in a tree nobody is watching. Every refusal
 * happens before the daemon is stopped and before the execution tree is touched,
 * so the ERR trap has nothing to start again.
 *
 * `npm`, `systemctl` and the build under `snapshot/dist/cli.js` are fakes on
 * PATH: no install runs, no unit is touched, and the status answer is whatever
 * the test asks for.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UPDATE = join(REPO, "user-tools", "update-and-restart");

const roots = new Set<string>();

const GIT_IDENTITY = ["-c", "user.name=pi-sec test", "-c", "user.email=test@localhost"];

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly homeDir: string;
  readonly workspace: string;
  readonly snapshot: string;
  readonly origin: string;
  /** A second clone of `origin`: commits made here are commits on the remote. */
  readonly upstream: string;
  readonly bin: string;
  readonly npmLog: string;
  readonly systemctlLog: string;
  /** The commit both trees start on, and the one `origin/main` pointed at. */
  readonly base: string;
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((settle, fail) => {
    execFile("git", [...GIT_IDENTITY, ...args], { cwd }, (error, stdout, stderr) => {
      if (error !== null) fail(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
      else settle(stdout.trim());
    });
  });
}

async function commitIn(cwd: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [name, body] of Object.entries(files)) await writeFile(join(cwd, name), body);
  await git(cwd, ["add", ...Object.keys(files)]);
  await git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A commit on the remote: it lands in `origin` and nowhere else until a fetch. */
async function publish(sb: Sandbox, files: Record<string, string>, message: string): Promise<string> {
  const sha = await commitIn(sb.upstream, files, message);
  await git(sb.upstream, ["push", "origin", "main"]);
  return sha;
}

/** A fake command that records its arguments, so a call it should not get fails the test. */
async function fake(bin: string, name: string, script: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/usr/bin/env bash\n${script}\n`);
  await chmod(path, 0o700);
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-update-pull-"));
  roots.add(root);
  const home = join(root, "pi-sec");
  const homeDir = join(root, "home");
  const workspace = join(home, "workspace");
  const snapshot = join(home, "snapshot");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const upstream = join(root, "upstream");
  const bin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  const systemctlLog = join(root, "systemctl.log");
  for (const dir of [home, homeDir, bin, seed, join(home, "run"), join(home, "logs")]) {
    await mkdir(dir, { recursive: true });
  }

  // The repository the install is cloned from. `dist/` and `node_modules/` are
  // ignored, so the fake build below neither dirties the tree nor blocks a merge.
  await writeFile(join(seed, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(join(seed, "one.txt"), "one\n");
  await writeFile(join(seed, "package-lock.json"), "{}\n");
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["add", ".gitignore", "one.txt", "package-lock.json"]);
  await git(seed, ["commit", "-m", "one"]);
  const base = await git(seed, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", "-b", "main", origin]);
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["push", "origin", "main"]);

  // The install as the install script leaves it: a clone on `main` in the
  // workspace tree, and the execution tree a worktree of it on `snapshot`.
  await git(root, ["clone", origin, workspace]);
  await git(workspace, ["branch", "snapshot"]);
  await git(workspace, ["worktree", "add", snapshot, "snapshot"]);

  // The build the script asks for `status`. It answers the way a daemon's own
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

  // The publisher. Its own clone, so a commit here is a commit the workspace has
  // not seen: the fetch in `--pull` is what brings it.
  await git(root, ["clone", origin, upstream]);

  return {
    root,
    home,
    homeDir,
    workspace,
    snapshot,
    origin,
    upstream,
    bin,
    npmLog,
    systemctlLog,
    base,
  };
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

async function run(sb: Sandbox, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  const env = childEnv(sb, extra);
  return new Promise<Run>((settle) => {
    execFile("bash", [UPDATE, ...args], { env, cwd: sb.root, timeout: 120_000 }, (error, stdout, stderr) => {
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

/** Only the calls that would stop or start something: the probes are expected. */
async function serviceCommands(sb: Sandbox): Promise<string[]> {
  return (await lines(sb.systemctlLog)).filter((line) => /\b(start|stop|restart)\b/.test(line));
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("update-and-restart --pull", () => {
  it(
    "fast-forwards main to the remote's new commit and builds it",
    async () => {
      const sb = await sandbox();
      const tip = await publish(sb, { "three.txt": "three\n" }, "three");

      const result = await run(sb, ["--pull"], { FAKE_STATUS_EXIT: "1" });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("fetching origin");
      expect(result.stdout).toContain("fast-forwarding main to origin/main");
      // The workspace moved, and the tree the daemon boots followed it.
      expect(await git(sb.workspace, ["rev-parse", "HEAD"])).toBe(tip);
      expect(await git(sb.workspace, ["branch", "--show-current"])).toBe("main");
      expect(await git(sb.snapshot, ["rev-parse", "HEAD"])).toBe(tip);
      expect(existsSync(join(sb.snapshot, "three.txt"))).toBe(true);
      // No remote work of its own: the script fetched and merged, and pushed nothing.
      expect(await git(sb.origin, ["rev-parse", "main"])).toBe(tip);
      expect(await lines(sb.npmLog)).toEqual(["ci", "run build"]);
    },
    60_000,
  );

  it(
    "refuses, and changes nothing, when main and origin/main have both moved",
    async () => {
      const sb = await sandbox();
      // The agent's own commits, the ones a fast-forward cannot take.
      await commitIn(sb.workspace, { "local-one.txt": "one\n" }, "local one");
      const localTip = await commitIn(sb.workspace, { "local-two.txt": "two\n" }, "local two");
      // Three on the remote, so the two counts in the message cannot be confused.
      await publish(sb, { "remote-one.txt": "one\n" }, "remote one");
      await publish(sb, { "remote-two.txt": "two\n" }, "remote two");
      const remoteTip = await publish(sb, { "remote-three.txt": "three\n" }, "remote three");

      const result = await run(sb, ["--pull"], { FAKE_STATUS_EXIT: "1" });

      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("main has 2 commits that origin/main does not have");
      expect(result.stderr).toContain("origin/main has 3 that main does not");
      expect(result.stderr).toContain("merge them by hand");
      expect(result.stderr).toContain("nothing was changed");
      // Neither branch moved and no file from the remote arrived.
      expect(await git(sb.workspace, ["rev-parse", "HEAD"])).toBe(localTip);
      expect(await git(sb.snapshot, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(existsSync(join(sb.workspace, "remote-three.txt"))).toBe(false);
      expect(await git(sb.workspace, ["status", "--porcelain"])).toBe("");
      // The fetch did run, so the refusal is about commits and not about a stale ref.
      expect(await git(sb.workspace, ["rev-parse", "origin/main"])).toBe(remoteTip);
      // Nothing was installed, built, stopped or started.
      expect(await lines(sb.npmLog)).toEqual([]);
      expect(await serviceCommands(sb)).toEqual([]);
    },
    60_000,
  );

  it(
    "refuses before the fetch while the workspace has uncommitted changes",
    async () => {
      const sb = await sandbox();
      const tip = await publish(sb, { "three.txt": "three\n" }, "three");
      await writeFile(join(sb.workspace, "one.txt"), "edited\n");

      const result = await run(sb, ["--pull"], { FAKE_STATUS_EXIT: "1" });

      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(`error: ${sb.workspace} has uncommitted changes`);
      expect(result.stderr).toContain("nothing was changed");
      // The local edit is still there, untouched, and neither tree moved.
      expect(await readFile(join(sb.workspace, "one.txt"), "utf8")).toBe("edited\n");
      expect(await git(sb.workspace, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(await git(sb.snapshot, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(existsSync(join(sb.workspace, "three.txt"))).toBe(false);
      // Refused before the fetch: the remote-tracking ref still points at the clone.
      expect(await git(sb.workspace, ["rev-parse", "origin/main"])).toBe(sb.base);
      expect(tip).not.toBe(sb.base);
      expect(await lines(sb.npmLog)).toEqual([]);
    },
    60_000,
  );

  it(
    "stops at a failing fetch without starting a service that was never stopped",
    async () => {
      const sb = await sandbox();
      await git(sb.workspace, ["remote", "remove", "origin"]);

      const result = await run(sb, ["--pull"], { FAKE_STATUS_EXIT: "1" });

      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("origin");
      // The ERR trap keys off having stopped something: nothing was stopped, so
      // nothing may be started, and no failure note may claim otherwise.
      expect(await serviceCommands(sb)).toEqual([]);
      expect(result.stdout).not.toContain("starting pi-sec");
      expect(result.stdout).not.toContain("failed after stopping the service");
      expect(await git(sb.workspace, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(await git(sb.snapshot, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(await lines(sb.npmLog)).toEqual([]);
    },
    60_000,
  );

  it(
    "still refuses --check with --reinstall",
    async () => {
      const sb = await sandbox();

      const result = await run(sb, ["--check", "--reinstall"], { FAKE_STATUS_EXIT: "1" });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: ");
      expect(await lines(sb.npmLog)).toEqual([]);
    },
    60_000,
  );
});

describe("update-and-restart --check --pull", () => {
  it(
    "reports how far main is behind the remote and moves no branch",
    async () => {
      const sb = await sandbox();
      await publish(sb, { "three.txt": "three\n" }, "three");
      const tip = await publish(sb, { "four.txt": "four\n" }, "four");

      // A daemon is up: `--check` is the one mode that keeps working under it.
      const result = await run(sb, ["--check", "--pull"], { FAKE_STATUS_EXIT: "0" });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("fetching origin");
      expect(result.stdout).toContain("main is 2 behind and 0 ahead of origin/main");
      // What `--check` already printed is still printed.
      expect(result.stdout).toContain("commits to apply: 0");
      // The fetch moved the remote-tracking ref and nothing else.
      expect(await git(sb.workspace, ["rev-parse", "origin/main"])).toBe(tip);
      expect(await git(sb.workspace, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(await git(sb.snapshot, ["rev-parse", "HEAD"])).toBe(sb.base);
      expect(existsSync(join(sb.workspace, "four.txt"))).toBe(false);
      expect(await lines(sb.npmLog)).toEqual([]);
      expect(await serviceCommands(sb)).toEqual([]);
    },
    60_000,
  );
});
