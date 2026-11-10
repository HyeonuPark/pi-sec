/**
 * `user-tools/install`: the eight steps of the install, from a clean account.
 *
 * The child process gets an environment built from nothing but the two homes
 * this file makes, its own PATH, and the stubs below. Nothing from
 * `process.env` is spread in: a `PI_SEC_HOME` in the parent environment can
 * name the home of a running daemon, and the install writes trees and a config.
 * A child that inherited that variable could install into the home of a running
 * daemon. `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are left
 * out for the same reason the install script must not reach the user manager:
 * a running daemon can be the user unit `pi-sec`.
 *
 * What is stubbed, and why:
 *
 * - `npm`: a real `npm ci` is 240 MB and a real `npm run build` is a minute. The
 *   stub records every call, makes `npm ci` create `node_modules`, and makes
 *   `npm run build` write a `dist/cli.js` that answers `config --default` from
 *   the real default config captured once in `beforeAll`. That stub also writes
 *   every call it gets to the home's `cli.log`, so a test can assert what the
 *   install asked the CLI to do, and it answers no other command. Every
 *   other step is real: the git clone, the worktree, the config file, the unit
 *   rendering.
 * - a fake `id` for the root case only, and a PATH without `npm` for the
 *   missing-tool case.
 * - `flock` and `fc-list`, so no case depends on the host having them. Every
 *   case also gets a browser folder inside its own home and a download host
 *   that refuses at once, so nothing is downloaded and nothing lands in the
 *   real browser cache. A fake Playwright CLI stands in for the real one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** bash by its full path: one case below runs with a PATH that has no bash. */
const BASH = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

/** Where everything this file makes lives. Removed in `afterAll`. */
let root = "";
/** The stub `npm`, and the directory the install's PATH starts with. */
let bin = "";
/** A clone of this repository, standing in for the tree an operator clones. */
let source = "";
/** The installer inside that clone: the file under test, where an operator has it. */
let installer = "";
/** A bare repository the clone's `origin` points at. */
let origin = "";
/** A node_modules the stub `npm ci` copies in: the fake Playwright CLI and the real playwright-core. */
let fakeModules = "";

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** Top-level names a copy of the tree leaves out: none of them is tracked. */
const NOT_TRACKED = new Set([".git", "node_modules", "dist", "coverage"]);

/**
 * The repository the install clones, standing in for the tree an operator has.
 *
 * The test always makes this repository out of the files of the checkout it runs
 * from, and never uses that checkout itself. The install clones its source and
 * adds a worktree of the clone, and neither step needs the history of this
 * checkout. A checkout has whatever branches it has: a `git archive` copy has
 * none, a clone of the public repository is on `main`, and this one is on
 * `release`. A repository the test builds is on `main` and carries
 * `test-checkout` in every copy alike.
 */
async function sourceRepository(): Promise<string> {
  const copy = join(root, "src-work");
  await cp(REPO, copy, { recursive: true, filter: (entry) => !NOT_TRACKED.has(basename(entry)) });
  git(["init", "--quiet", "-b", "main", copy]);
  // The copy is the test's own directory and holds nothing else, so every file
  // in it belongs in the one commit the install clones.
  git(["-C", copy, "add", "--all"]);
  git([
    "-c",
    "user.name=pi-sec test",
    "-c",
    "user.email=test@example.com",
    "-C",
    copy,
    "commit",
    "--quiet",
    "-m",
    "the tree the install test runs from",
  ]);
  // A clone checks out the branch the repository has. The clone below needs a
  // branch of its own, because the test makes a local `main` from `origin/main`.
  git(["-C", copy, "branch", "test-checkout"]);
  git(["-C", copy, "checkout", "--quiet", "test-checkout"]);
  return copy;
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * The environment one install runs in.
 *
 * `HOME` and `PI_SEC_HOME` both point inside `home`, so the trees, the config
 * and the unit file land where the test can read them.
 */
function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: join(home, "home"),
    PI_SEC_HOME: join(home, "pi-sec"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERM: "dumb",
    PI_SEC_TEST_NPM_LOG: join(home, "npm.log"),
    PI_SEC_TEST_CLI_LOG: join(home, "cli.log"),
    PI_SEC_TEST_FAKE_CLI: join(root, "fake-cli.js"),
    PI_SEC_TEST_DEFAULT_CONFIG: join(root, "default-config.json"),
    PLAYWRIGHT_BROWSERS_PATH: join(home, "browsers"),
    PLAYWRIGHT_DOWNLOAD_HOST: "http://127.0.0.1:9",
    ...extra,
  };
  // A user manager reached from here would be the one that runs the live unit.
  expect(env["XDG_RUNTIME_DIR"]).toBeUndefined();
  expect(env["DBUS_SESSION_BUS_ADDRESS"]).toBeUndefined();
  for (const name of ["PI_SEC_RUNNER", "NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"]) {
    expect(env[name]).toBeUndefined();
  }
  return env;
}

/**
 * Run the install with stdin not a terminal, so a step that would ask is a step
 * that used its option or its default. The child never waits for input.
 */
function run(env: NodeJS.ProcessEnv, args: readonly string[]): Run {
  const result = spawnSync(BASH, [installer, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A home of its own under the test root. */
async function makeHome(name: string): Promise<string> {
  const home = join(root, name);
  await mkdir(join(home, "home"), { recursive: true });
  return home;
}

/** The parts of a home that a second install must not change. */
async function fingerprint(home: string): Promise<Record<string, string>> {
  const homeDir = join(home, "pi-sec");
  const tree = (path: string): string =>
    `${git(["-C", path, "rev-parse", "HEAD"])} ${git(["-C", path, "status", "--porcelain"])}`;
  return {
    config: await sha256(join(homeDir, "config.json")),
    workspace: tree(join(homeDir, "workspace")),
    snapshot: tree(join(homeDir, "snapshot")),
    npmCalls: await readFile(join(home, "npm.log"), "utf8").catch(() => ""),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-install-"));
  bin = join(root, "bin");
  await mkdir(bin, { recursive: true });

  // The source repository, and the origin its origin points at. The install
  // copies the origin across, so the workspace in the new home updates from the
  // same place this code came from.
  source = join(root, "src");
  git(["clone", "--quiet", await sourceRepository(), source]);
  // The file under test, copied into the clone rather than committed, so the
  // test runs the working copy of this checkout and not the last commit of it.
  installer = join(source, "user-tools", "install");
  await copyFile(join(REPO, "user-tools", "install"), installer);
  await chmod(installer, 0o755);
  await copyFile(join(REPO, "user-tools", "pi-sec.service"), join(source, "user-tools", "pi-sec.service"));
  await copyFile(join(REPO, "user-tools", "optional-deps.mjs"), join(source, "user-tools", "optional-deps.mjs"));
  // A local `main`: the branch the execution tree starts from. A
  // clone keeps the branch it checked out and carries the rest as remotes.
  git(["-C", source, "branch", "main", "origin/main"]);
  origin = join(root, "origin.git");
  git(["clone", "--quiet", "--bare", source, origin]);
  git(["-C", source, "remote", "set-url", "origin", origin]);

  // The default config the stub CLI prints. Captured from the real CLI, so the
  // file the install writes is the one the build would have written.
  const captured = spawnSync(
    process.execPath,
    [join(REPO, "src", "cli.ts"), "config", "--default"],
    { env: { PATH: process.env.PATH ?? "", HOME: join(root, "capture"), TERM: "dumb" }, encoding: "utf8" },
  );
  expect(captured.status, captured.stderr).toBe(0);
  await writeFile(join(root, "default-config.json"), captured.stdout);

  await writeFile(
    join(root, "fake-cli.js"),
    `// Stub for the built CLI: answers \`config --default\` and records every call.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.PI_SEC_TEST_CLI_LOG, \`\${args.join(" ")}\\n\`);
if (args[0] === "config" && args.includes("--default")) {
  process.stdout.write(readFileSync(process.env.PI_SEC_TEST_DEFAULT_CONFIG, "utf8"));
  process.exit(0);
}
process.stderr.write(\`install-script test stub: unsupported command \${args.join(" ")}\\n\`);
process.exit(1);
`,
  );

  // The recorded calls go to a file in each home, so two tests cannot cross.
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh
printf '%s\\t%s\\n' "$PWD" "$*" >> "$PI_SEC_TEST_NPM_LOG"
case "$1" in
  ci)
    mkdir -p node_modules
    if [ -n "\${PI_SEC_TEST_NODE_MODULES:-}" ]; then cp -a "$PI_SEC_TEST_NODE_MODULES"/. node_modules/; fi
    exit 0
    ;;
  run)
    if [ "\${2:-}" = build ]; then
      mkdir -p dist
      cp "$PI_SEC_TEST_FAKE_CLI" dist/cli.js
      chmod 755 dist/cli.js
    fi
    exit 0
    ;;
esac
exit 0
`,
  );
  await chmod(join(bin, "npm"), 0o755);
  await writeFile(join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "flock"), 0o755);
  await writeFile(
    join(bin, "fc-list"),
    `#!/bin/sh
if [ -z "\${PI_SEC_TEST_NO_KOREAN_FONT:-}" ]; then echo "/usr/share/fonts/NanumGothic.ttf: NanumGothic:style=Regular"; fi
exit 0
`,
  );
  await chmod(join(bin, "fc-list"), 0o755);

  // The fake Playwright: a package whose cli.js records its arguments and acts
  // by PI_SEC_TEST_PLAYWRIGHT_MODE, next to a link to the real playwright-core.
  fakeModules = join(root, "fake-nm");
  await mkdir(join(fakeModules, "playwright"), { recursive: true });
  await symlink(realpathSync(join(REPO, "node_modules", "playwright-core")), join(fakeModules, "playwright-core"));
  await writeFile(join(fakeModules, "playwright", "package.json"), '{"name":"playwright","version":"0.0.0"}\n');
  await writeFile(
    join(fakeModules, "playwright", "cli.js"),
    `const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.PI_SEC_TEST_PLAYWRIGHT_LOG, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("fake playwright stdout\\n");
process.stderr.write("fake playwright stderr\\n");
const mode = process.env.PI_SEC_TEST_PLAYWRIGHT_MODE;
if (mode === "fail") {
  process.stdout.write("Failed to install browsers\\n");
  process.exit(1);
}
if (mode === "ok") {
  const { registry } = require("playwright-core/lib/coreBundle");
  const shell = registry.registry.findExecutable("chromium-headless-shell");
  const executable = shell.executablePath("javascript");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "");
  fs.writeFileSync(path.join(shell.directory, "INSTALLATION_COMPLETE"), "");
}
process.exit(0);
`,
  );
}, 60_000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("user-tools/install", () => {
  it("refuses to run as root, and builds nothing", async () => {
    const home = await makeHome("root");
    const fakeId = join(root, "rootbin");
    await mkdir(fakeId, { recursive: true });
    const realId = execFileSync("sh", ["-c", "command -v id"], { encoding: "utf8" }).trim();
    await writeFile(join(fakeId, "id"), `#!/bin/sh\nif [ "\${1:-}" = "-u" ]; then echo 0; exit 0; fi\nexec ${realId} "$@"\n`);
    await chmod(join(fakeId, "id"), 0o755);

    const result = run(childEnv(home, { PATH: `${fakeId}:${process.env.PATH ?? ""}` }), [
      "--yes",
      "--skip-model",
      "--run",
      "manual",
    ]);

    expect(result.stderr).toContain("do not install as root");
    expect(result.code).toBe(1);
    expect(await exists(join(home, "pi-sec", "workspace"))).toBe(false);
  }, 60_000);

  it("lists every missing tool, with an install hint, before it exits", async () => {
    const home = await makeHome("missing");
    // A PATH with the tools the check itself needs, and no npm. node is a link
    // to the real one, so only npm is missing.
    const tools = join(root, "npmless");
    await mkdir(tools, { recursive: true });
    for (const name of ["node", "git", "dirname", "id"]) {
      const path = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      await symlink(path, join(tools, name));
    }

    const result = run(childEnv(home, { PATH: tools }), ["--yes", "--skip-model", "--run", "manual"]);

    expect(result.stderr).toContain("required tools are missing");
    expect(result.stderr).toContain("npm: comes with Node.js");
    expect(result.stderr).toContain("flock:");
    expect(result.stderr).toContain("util-linux");
    expect(result.code).toBe(1);
    expect(await exists(join(home, "pi-sec", "workspace"))).toBe(false);
  }, 60_000);

  it("installs into an empty home, and a second run changes nothing", async () => {
    const home = await makeHome("fresh");
    const homeDir = join(home, "pi-sec");
    const workspace = join(homeDir, "workspace");
    const snapshot = join(homeDir, "snapshot");
    const args = ["--yes", "--skip-model", "--run", "manual"];
    const env = childEnv(home);

    const first = run(env, args);
    expect(first.stderr, first.stdout).toBe("");
    expect(first.code, first.stdout).toBe(0);

    // The modification tree is a clone of the source, and it keeps the source's
    // origin rather than a path into the directory this test happens to use.
    expect(git(["-C", workspace, "remote", "get-url", "origin"])).toBe(origin);
    expect(git(["-C", workspace, "rev-parse", "HEAD"])).toBe(git(["-C", source, "rev-parse", "HEAD"]));

    // The commit hooks of the workspace are the shipped files, with mode 755, and
    // the word list and the identity list exist with mode 600.
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
      const installedHook = join(workspace, ".git", "hooks", name);
      expect(await readFile(installedHook, "utf8")).toBe(
        await readFile(join(REPO, "user-tools", "git-hooks", name), "utf8"),
      );
      expect(await mode(installedHook)).toBe(0o755);
    }
    expect(await mode(join(homeDir, "scan-words.txt"))).toBe(0o600);
    expect(await mode(join(homeDir, "commit-identities.txt"))).toBe(0o600);

    // The execution tree is a worktree of that repository on branch `snapshot`.
    expect(git(["-C", snapshot, "rev-parse", "--abbrev-ref", "HEAD"])).toBe("snapshot");
    // It starts from `main`, which a clone carries as a remote-tracking branch.
    expect(git(["-C", snapshot, "rev-parse", "HEAD"])).toBe(
      git(["-C", workspace, "rev-parse", "refs/remotes/origin/main"]),
    );
    expect(git(["-C", workspace, "worktree", "list", "--porcelain"])).toContain(`worktree ${snapshot}`);
    // A worktree carries a `.git` file that points at the shared repository.
    expect((await stat(join(snapshot, ".git"))).isFile()).toBe(true);

    // The build the stub npm made, and the config written from it.
    expect(await exists(join(snapshot, "dist", "cli.js"))).toBe(true);
    const configPath = join(homeDir, "config.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 1,
      vmodels: {},
      agent: { vmodel: "" },
    });
    expect(await mode(configPath)).toBe(0o600);
    expect(await mode(homeDir)).toBe(0o700);
    // npm ran for both trees and then for the build, once each.
    expect((await readFile(join(home, "npm.log"), "utf8")).trim().split("\n")).toEqual([
      `${workspace}\tci`,
      `${snapshot}\tci`,
      `${snapshot}\trun build`,
    ]);

    // The manual mode names the runner, the home, and how to reach the UI.
    expect(first.stdout).toContain(join(snapshot, "user-tools", "run"));
    expect(first.stdout).toContain(`PI_SEC_HOME="${homeDir}"`);
    expect(first.stdout).toContain("http://127.0.0.1:8787/");
    expect(first.stdout).toContain("authenticating proxy");
    // The old system-unit instructions are gone: this account needs no root.
    expect(first.stdout).not.toContain("sudo");
    expect(first.stdout).not.toContain("/etc/systemd/system");
    expect(await exists(join(home, "home", ".config", "systemd", "user", "pi-sec.service"))).toBe(false);

    const before = await fingerprint(home);
    const second = run(env, args);
    expect(second.code, second.stdout).toBe(0);
    expect(second.stdout).toContain("already holds a repository");
    expect(second.stdout).toContain("already holds a worktree");
    expect(second.stdout).toContain("config.json exists");
    expect(second.stdout).toContain("dependencies are already installed");
    expect(second.stdout).toContain("already built");
    expect(await fingerprint(home)).toEqual(before);
  }, 180_000);

  it("takes a models.json endpoint file once, and falls back to manual without a user manager", async () => {
    const home = await makeHome("models-json");
    const homeDir = join(home, "pi-sec");
    const modelsPath = join(homeDir, "models.json");
    const env = childEnv(home);

    // No --run and no terminal: the account has no user manager here, so the
    // default is manual. Nothing is registered or started either way.
    const noFile = run(env, ["--yes", "--models-json", "--skip-model"]);
    expect(noFile.code, noFile.stdout).toBe(0);
    expect(noFile.stdout).toContain("no --run given; using manual");
    expect(noFile.stdout).toContain("docs/install.md");
    expect(await exists(modelsPath)).toBe(false);

    const endpointFile = join(home, "endpoint.json");
    const endpoint = '{"providers":[{"id":"local","baseUrl":"http://127.0.0.1:1/v1","models":[]}]}\n';
    await writeFile(endpointFile, endpoint);
    const copied = run(env, ["--yes", "--models-json", endpointFile, "--skip-model"]);
    expect(copied.code, copied.stdout).toBe(0);
    expect(await readFile(modelsPath, "utf8")).toBe(endpoint);
    expect(await mode(modelsPath)).toBe(0o600);

    // A second run leaves the file alone, even with a different one on hand.
    await writeFile(endpointFile, '{"providers":[]}\n');
    const kept = run(env, ["--yes", "--models-json", endpointFile, "--skip-model"]);
    expect(kept.code, kept.stdout).toBe(0);
    expect(kept.stdout).toContain("exists; leaving it as it is");
    expect(await readFile(modelsPath, "utf8")).toBe(endpoint);
  }, 180_000);

  it("copies an extension without signing anything in, and refuses the options that signed in", async () => {
    const home = await makeHome("extension-copy");
    const homeDir = join(home, "pi-sec");
    const env = childEnv(home);
    // The calls the script made to the CLI. `config --default` lands here as
    // well, so only a login would be read.
    const logins = async (): Promise<string[]> =>
      (await readFile(join(home, "cli.log"), "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("login "));

    const extension = join(home, "acme-ext");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export {};\n");

    // The extension is copied, and the credential is left to the web UI: the
    // stub CLI would refuse a login, and none is recorded.
    const copied = run(env, ["--yes", "--extension", extension, "--skip-model", "--run", "manual"]);
    expect(copied.code, copied.stdout + copied.stderr).toBe(0);
    expect(await exists(join(homeDir, "extensions", "acme-ext", "index.ts"))).toBe(true);
    expect(await logins()).toEqual([]);
    expect(copied.stdout).toContain("Model login");
    expect(copied.stdout).toContain("the daemon does not sign a provider in");

    // The two options that used to sign a provider in are unknown arguments now,
    // so an automated install command that still names one stops at once.
    const login = run(env, ["--yes", "--login", "oauth", "--skip-model", "--run", "manual"]);
    expect(login.code, login.stdout).toBe(1);
    expect(login.stderr).toContain("unknown argument: --login");
    const skipped = run(env, ["--yes", "--skip-login", "--skip-model", "--run", "manual"]);
    expect(skipped.code, skipped.stdout).toBe(1);
    expect(skipped.stderr).toContain("unknown argument: --skip-login");
  }, 180_000);

  it("renders a home with an ampersand as it is, and refuses one with a space", async () => {
    // bash 5.2 gives `&` in a ${text//pat/repl} replacement the meaning "the
    // matched text", so a home with an ampersand used to put the placeholder
    // back into the unit. The renderer must not go through that.
    const amp = await makeHome("a&b");
    const ampHome = join(amp, "home");
    const wrote = run(childEnv(amp), ["--yes", "--skip-model", "--run", "systemd", "--no-start"]);
    expect(wrote.code, wrote.stdout + wrote.stderr).toBe(0);
    const unit = await readFile(join(ampHome, ".config", "systemd", "user", "pi-sec.service"), "utf8");
    expect(unit).toContain(`Environment=HOME=${ampHome}`);
    expect(unit).toContain(`ReadWritePaths=${ampHome}`);
    expect(unit).toContain(`Environment=PI_SEC_HOME=${join(amp, "pi-sec")}`);
    expect(unit.match(/@[A-Z_]+@/g)).toBeNull();

    // systemd splits these lines on whitespace and has no escape for it, so the
    // install says so instead of writing a unit that starts with wrong values.
    const spaced = await makeHome("sp ace");
    const refused = run(childEnv(spaced), ["--yes", "--skip-model", "--run", "systemd", "--no-start"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("cannot carry one");
    expect(await exists(join(spaced, "home", ".config", "systemd", "user", "pi-sec.service"))).toBe(false);
  }, 180_000);

  it("writes a systemd user unit with this account's own paths, and never overwrites one", async () => {
    const home = await makeHome("systemd");
    const homeDir = join(home, "pi-sec");
    const snapshot = join(homeDir, "snapshot");
    const unitPath = join(home, "home", ".config", "systemd", "user", "pi-sec.service");
    const env = childEnv(home);
    const args = ["--yes", "--skip-model", "--run", "systemd", "--no-start"];

    const result = run(env, args);
    expect(result.stderr).toBe("");
    expect(result.code, result.stdout).toBe(0);
    // Nothing was registered or started: --no-start prints the commands instead.
    expect(result.stdout).toContain("not registering or starting the unit");
    expect(result.stdout).toContain("systemctl --user enable --now pi-sec");
    expect(result.stdout).toContain("loginctl enable-linger");

    const unit = await readFile(unitPath, "utf8");
    const nodeBin = execFileSync("sh", ["-c", "command -v node"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    }).trim();
    expect(nodeBin.startsWith("/")).toBe(true);
    expect(unit).toContain(`Environment=HOME=${join(home, "home")}`);
    expect(unit).toContain(`Environment=PI_SEC_HOME=${homeDir}`);
    expect(unit).toContain(`Environment=PATH=${dirname(nodeBin)}:/usr/local/bin:/usr/bin:/bin`);
    expect(unit).toContain(`ExecStart=${nodeBin} ${join(snapshot, "dist", "cli.js")} start --watchdog`);
    expect(unit).toContain(`WorkingDirectory=${snapshot}`);
    expect(unit).toContain(`ReadWritePaths=${join(home, "home")}`);
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("NotifyAccess=all");
    expect(unit).toContain("WatchdogSec=60");
    expect(unit).toContain("ExecReload=/bin/kill -HUP $MAINPID");
    expect(unit).toContain("WantedBy=default.target");
    // A user unit names no account, and no placeholder survives the render.
    expect(unit.split("\n").filter((line) => /^(User|Group)=/.test(line))).toEqual([]);
    expect(unit.match(/@[A-Z_]+@/g)).toBeNull();
    expect(await mode(unitPath)).toBe(0o600);

    // The unit is checked where a check needs no manager. `systemd-analyze
    // --user verify` wants the account's user manager; the verification worker
    // runs it, not this file.
    const verify = spawnSync("systemd-analyze", ["verify", unitPath], {
      env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
      encoding: "utf8",
    });
    if (verify.error === undefined) expect(verify.status, verify.stdout + verify.stderr).toBe(0);

    const wrote = await sha256(unitPath);
    const again = run(env, args);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain(`${unitPath} already exists`);
    expect(await sha256(unitPath)).toBe(wrote);
  }, 180_000);

  it("prints the access notice on real lines, for a loopback and for another bind", async () => {
    const home = await makeHome("notice-lines");
    const env = childEnv(home);
    const args = ["--yes", "--skip-model", "--run", "manual"];

    // The notice is printed by `cat <<EOF` with the value in it, so a `\n`
    // inside that value reaches the terminal as two characters, not a break.
    const loopback = run(env, args);
    expect(loopback.code, loopback.stdout + loopback.stderr).toBe(0);
    expect(loopback.stdout).toContain("If another\nmachine must, put an authenticating proxy in front of the port.");
    expect(loopback.stdout).not.toContain("\\n");

    // The other arrangement, for an address other machines reach. A second run
    // on an installed home keeps `config.json`, so the bind comes from here.
    const configPath = join(home, "pi-sec", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config["server"] = { ...(config["server"] as Record<string, unknown> | undefined), bind: "0.0.0.0" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const other = run(env, args);
    expect(other.code, other.stdout + other.stderr).toBe(0);
    expect(other.stdout).toContain(
      "Put an\nauthenticating proxy in front of the port, or set server.bind to 127.0.0.1.",
    );
    expect(other.stdout).not.toContain("\\n");
  }, 180_000);
});

// --- system dependency checks ------------------------------------------------

const DEBIAN_RELEASE = "ID=ubuntu\nID_LIKE=debian\n";
const FEDORA_RELEASE = "ID=fedora\n";
const DOWNLOAD_COMMAND = "npx playwright install --only-shell chromium";

interface StubOptions {
  /** Packages the dpkg-query stub reports as not installed; null leaves the stub out. */
  readonly dpkgHide?: readonly string[] | null;
  /** Commands present as stubs. */
  readonly commands?: readonly string[];
  /** What fc-list prints; null leaves it out. */
  readonly fcList?: "font" | "empty" | "emptyfail" | null;
  /** Shared libraries the ldconfig stub lists; undefined leaves it out. */
  readonly ldconfig?: readonly string[];
}

/** A folder of stub commands. Used alone as a PATH, so no host command leaks in. */
async function makeStubs(name: string, options: StubOptions = {}): Promise<string> {
  const dir = join(root, `stubs-${name}`);
  await mkdir(dir, { recursive: true });
  const put = async (file: string, body: string): Promise<void> => {
    await writeFile(join(dir, file), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, file), 0o755);
  };
  for (const command of options.commands ?? []) await put(command, "exit 0");
  if (options.dpkgHide !== null) {
    const hide = (options.dpkgHide ?? []).join(" ");
    await put(
      "dpkg-query",
      `shift; shift\nstatus=0\nfor p in "$@"; do case " ${hide} " in *" $p "*) status=1 ;; *) echo "$p ii " ;; esac; done\nexit $status`,
    );
  }
  const fc = options.fcList === undefined ? "font" : options.fcList;
  if (fc === "font") await put("fc-list", 'echo "/usr/share/fonts/NanumGothic.ttf: NanumGothic:style=Regular"');
  if (fc === "empty") await put("fc-list", "exit 0");
  if (fc === "emptyfail") await put("fc-list", "exit 1");
  if (options.ldconfig !== undefined) {
    const lines = options.ldconfig.map((soname) => `echo "\t${soname} (libc6,x86-64) => /usr/lib/${soname}"`).join("\n");
    await put("ldconfig", lines === "" ? "true" : lines);
  }
  return dir;
}

const ALL_COMMANDS = ["ssh", "sftp", "rsync", "gh"] as const;

/** Where Playwright puts the headless shell for a browser folder, from the real playwright-core. */
function browserPaths(browsers: string): { directory: string; executable: string } {
  const text = execFileSync(
    process.execPath,
    [
      "-e",
      `const { registry } = require("playwright-core/lib/coreBundle");
const shell = registry.registry.findExecutable("chromium-headless-shell");
process.stdout.write(JSON.stringify({ directory: shell.directory, executable: shell.executablePath("javascript") }));`,
    ],
    { cwd: REPO, env: { PATH: process.env.PATH ?? "", PLAYWRIGHT_BROWSERS_PATH: browsers }, encoding: "utf8" },
  );
  return JSON.parse(text) as { directory: string; executable: string };
}

async function placeBrowser(browsers: string): Promise<void> {
  const { directory, executable } = browserPaths(browsers);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "");
  await writeFile(join(directory, "INSTALLATION_COMPLETE"), "");
}

/** Every path under a folder, to see that a run created nothing. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true }).catch(() => [] as string[])).sort();
}

/** A tree for the helper: node_modules with the real playwright-core, with none, or with one that has no package table. */
async function makeTree(name: string, kind: "real" | "none" | "nobundle"): Promise<string> {
  const tree = join(root, `tree-${name}`);
  await mkdir(join(tree, "node_modules"), { recursive: true });
  if (kind === "real") {
    await symlink(realpathSync(join(REPO, "node_modules", "playwright-core")), join(tree, "node_modules", "playwright-core"));
  } else if (kind === "nobundle") {
    const core = join(tree, "node_modules", "playwright-core");
    await mkdir(join(core, "lib"), { recursive: true });
    await writeFile(join(core, "package.json"), '{"name":"playwright-core","version":"9.9.9"}\n');
    await writeFile(join(core, "lib", "coreBundle.js"), "// a bundle without the package table\n");
  }
  return tree;
}

/** The helper itself, run with node under a PATH of stubs only. */
async function helper(
  name: string,
  tree: string,
  stubs: string,
  options: { release?: string; extraArgs?: readonly string[]; env?: Record<string, string> } = {},
): Promise<Run> {
  const releaseFile = join(root, `os-release-${name}`);
  await writeFile(releaseFile, options.release ?? DEBIAN_RELEASE);
  const result = spawnSync(
    process.execPath,
    [join(REPO, "user-tools", "optional-deps.mjs"), "--tree", tree, ...(options.extraArgs ?? [])],
    {
      env: {
        PATH: stubs,
        HOME: join(root, "capture"),
        PI_SEC_OS_RELEASE: releaseFile,
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu22.04-x64",
        PLAYWRIGHT_BROWSERS_PATH: join(root, `browsers-${name}`),
        ...options.env,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The environment of a full install that sees the host-independent stubs first. */
function depsEnv(home: string, stubs: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return childEnv(home, {
    PATH: `${stubs}:${bin}:${process.env.PATH ?? ""}`,
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu22.04-x64",
    PI_SEC_OS_RELEASE: join(root, "os-release-debian"),
    PI_SEC_TEST_NODE_MODULES: fakeModules,
    PI_SEC_TEST_PLAYWRIGHT_LOG: join(home, "playwright.log"),
    PI_SEC_TEST_PLAYWRIGHT_MODE: "fail",
    ...extra,
  });
}

describe("user-tools/install: system dependencies", () => {
  const manual = ["--yes", "--skip-model", "--run", "manual"];

  beforeAll(async () => {
    await writeFile(join(root, "os-release-debian"), DEBIAN_RELEASE);
  });

  it("keeps going when optional packages are missing, and prints one root command", async () => {
    const home = await makeHome("deps-missing");
    const stubs = await makeStubs("missing", { dpkgHide: ["libgbm1", "libnss3"], commands: [], fcList: null });
    const result = run(depsEnv(home, stubs, { PI_SEC_TEST_NO_KOREAN_FONT: "1" }), manual);

    expect(result.stderr, result.stdout).toBe("");
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("optional system packages");
    expect(result.stdout).toContain("libgbm1 libnss3");
    expect(result.stdout).toContain("Korean font");
    expect(result.stdout).toContain("fonts-nanum");
    // Stubs hide only the libraries. Which of rsync and gh the host has varies,
    // so the helper cases below test those two.
    expect(result.stdout.split("\n").filter((line) => line.includes("apt-get"))).toHaveLength(1);
    expect(result.stdout).toContain("the download failed in this run");
    expect(result.stdout).toContain(DOWNLOAD_COMMAND);
    expect(result.stdout).not.toContain("sudo");
  }, 180_000);

  it("prints one line when every optional item is present", async () => {
    const home = await makeHome("deps-present");
    const stubs = await makeStubs("present", { commands: ALL_COMMANDS });
    await placeBrowser(join(home, "browsers"));
    const result = run(depsEnv(home, stubs), manual);

    expect(result.stderr, result.stdout).toBe("");
    expect(result.code, result.stdout).toBe(0);
    const allPresent = result.stdout.split("\n").filter((line) => line.includes("all present:"));
    expect(allPresent).toHaveLength(1);
    expect(allPresent[0]).toBe("  all present: headless Chromium libraries and browser, Korean font, ssh, sftp, rsync, gh");
    expect(result.stdout).not.toContain("apt-get");
    expect(result.stdout).not.toContain("browser download");
    expect(await exists(join(home, "playwright.log"))).toBe(false);
  }, 180_000);

  it("--check-deps checks and changes nothing, and takes no other option", async () => {
    const home = await makeHome("deps-check");
    const stubs = await makeStubs("check", { dpkgHide: ["libnss3"], commands: [], fcList: null });
    const workspaceModules = join(home, "pi-sec", "workspace", "node_modules");
    await mkdir(workspaceModules, { recursive: true });
    await cp(fakeModules, workspaceModules, { recursive: true, verbatimSymlinks: true });
    const env = depsEnv(home, stubs, { PI_SEC_TEST_NO_KOREAN_FONT: "1" });
    const before = await listing(home);

    const result = run(env, ["--check-deps"]);
    expect(result.stderr, result.stdout).toBe("");
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("optional system packages");
    expect(result.stdout).toContain("libnss3");
    expect(result.stdout).toContain("not downloaded");
    expect(result.stdout).toContain(DOWNLOAD_COMMAND);
    expect(await listing(home)).toEqual(before);
    expect(await exists(join(home, "browsers"))).toBe(false);
    expect(await exists(join(home, "playwright.log"))).toBe(false);

    // A required tool that is missing still stops it, with exit 1.
    const tools = join(root, "flockless");
    await mkdir(tools, { recursive: true });
    for (const name of ["node", "git", "dirname", "id"]) {
      const path = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      await symlink(path, join(tools, name));
    }
    await copyFile(join(bin, "npm"), join(tools, "npm"));
    await chmod(join(tools, "npm"), 0o755);
    const noFlock = run(childEnv(home, { PATH: tools }), ["--check-deps"]);
    expect(noFlock.code).toBe(1);
    expect(noFlock.stderr).toContain("flock:");

    for (const other of ["--skip-browser", "--yes"]) {
      const refused = run(env, ["--check-deps", other]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("takes no other option");
    }
    expect(await listing(home)).toEqual(before);
  }, 180_000);

  it("reads the package list of the real Playwright in node_modules", async () => {
    const tree = await makeTree("real", "real");
    // Must fail to check: no dpkg-query on PATH.
    const unchecked = await helper("real-none", tree, await makeStubs("real-none", { dpkgHide: null, commands: ALL_COMMANDS }));
    expect(unchecked.stdout).toContain("because dpkg-query is missing");

    // Every package of the list is reported when dpkg-query knows none.
    const noneStubs = await makeStubs("real-all-hidden", { commands: ALL_COMMANDS });
    await writeFile(join(noneStubs, "dpkg-query"), "#!/bin/sh\nexit 1\n");
    const all = await helper("real-all", tree, noneStubs);
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(/missing \d+ of the \d+ packages that Playwright [\d.]+ lists for ubuntu22\.04-x64/);
    expect(all.stdout).toContain(" libnss3 ");

    // With every package installed, the list is read and nothing is missing.
    const ok = await helper("real-ok", tree, await makeStubs("real-ok", { commands: ALL_COMMANDS }));
    expect(ok.stdout).not.toContain("packages that Playwright");
    expect(ok.stdout).not.toContain("because dpkg-query");
    // One hidden package is the only one reported.
    const one = await helper("real-one", tree, await makeStubs("real-one", { dpkgHide: ["libnss3"], commands: ALL_COMMANDS }));
    expect(one.stdout).toContain("missing 1 of the");
    expect(one.stdout).toMatch(/\n\s+libnss3\n/);
  }, 120_000);

  it("falls back to shared libraries, to 'not checked', and to the dry-run hint", async () => {
    const tree = await makeTree("fallback", "real");
    // Fedora: the list is of shared libraries, and no apt-get line appears.
    const nothing = await helper("fedora-none", tree, await makeStubs("fedora-none", { commands: ALL_COMMANDS, ldconfig: [] }), {
      release: FEDORA_RELEASE,
    });
    expect(nothing.code).toBe(0);
    const sonames = /missing 27 of 27 shared libraries: (.*)\n/.exec(nothing.stdout)?.[1]?.split(" ") ?? [];
    expect(sonames).toContain("libnss3.so");
    expect(nothing.stdout).not.toContain("apt-get");

    const partial = await helper(
      "fedora-one",
      tree,
      await makeStubs("fedora-one", { commands: ALL_COMMANDS, ldconfig: sonames.filter((name) => name !== "libnss3.so") }),
      { release: FEDORA_RELEASE },
    );
    expect(partial.code).toBe(0);
    expect(partial.stdout).toContain("missing 1 of 27 shared libraries: libnss3.so");
    expect(partial.stdout).toContain("Install the packages of this distribution");
    expect(partial.stdout).not.toContain("apt-get");

    const full = await helper("fedora-ok", tree, await makeStubs("fedora-ok", { commands: ALL_COMMANDS, ldconfig: sonames }), {
      release: FEDORA_RELEASE,
    });
    expect(full.stdout).not.toContain("shared libraries");

    // A tree with no Playwright.
    const bare = await helper("bare", await makeTree("bare", "none"), await makeStubs("bare", { commands: ALL_COMMANDS }));
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("not checked, because Playwright is not installed in");
    expect(bare.stdout).toContain("npm ci");

    // A Playwright whose bundle has no package table.
    const odd = await helper("odd", await makeTree("odd", "nobundle"), await makeStubs("odd", { commands: ALL_COMMANDS }));
    expect(odd.code).toBe(0);
    expect(odd.stdout).toContain("could not read the package list of Playwright 9.9.9");
    expect(odd.stdout).toContain("npx playwright install-deps --dry-run chromium");
  }, 120_000);

  it("notes a command that the daemon cannot find, only when the unit PATH lacks it", async () => {
    const tree = await makeTree("note", "none");
    const stubs = await makeStubs("note", { commands: ALL_COMMANDS });
    const emptyPath = join(root, "empty-path");
    await mkdir(emptyPath, { recursive: true });

    // Must show.
    const shown = await helper("note-show", tree, stubs, { extraArgs: ["--daemon-path", emptyPath] });
    expect(shown.stdout).toMatch(/the daemon will not find .*\bgh\b/);
    expect(shown.stdout).toContain(`PATH is ${emptyPath}`);
    // Must not show.
    const hidden = await helper("note-hide", tree, stubs, { extraArgs: ["--daemon-path", stubs] });
    expect(hidden.stdout).not.toContain("the daemon will not find");
    const none = await helper("note-none", tree, stubs);
    expect(none.stdout).not.toContain("the daemon will not find");
    // A command the shell does not find is missing, and the note is not for it.
    const missing = await helper("note-missing", tree, await makeStubs("note-missing", { commands: [] }), {
      extraArgs: ["--daemon-path", emptyPath],
    });
    expect(missing.stdout).not.toContain("the daemon will not find");
    expect(missing.stdout).toMatch(/apt-get install .*openssh-client rsync gh/);
    const missingFedora = await helper("note-missing-fedora", tree, await makeStubs("note-missing-fedora", { commands: [] }), {
      release: FEDORA_RELEASE,
    });
    expect(missingFedora.stdout).toContain("install the package that provides each missing command, as root: ssh, sftp, rsync, gh");
    expect(missingFedora.stdout).not.toContain("apt-get");

    // The install wiring. A manual run passes no unit PATH.
    const stubbed = await makeStubs("note-install", { commands: ALL_COMMANDS });
    const manualHome = await makeHome("note-manual");
    const manualRun = run(depsEnv(manualHome, stubbed), manual);
    expect(manualRun.code, manualRun.stdout).toBe(0);
    expect(manualRun.stdout).not.toContain("the daemon will not find");

    // A systemd run passes it. The host decides whether the unit folders hold a gh.
    const unitHome = await makeHome("note-systemd");
    const unitRun = run(depsEnv(unitHome, stubbed), ["--yes", "--skip-model", "--run", "systemd", "--no-start"]);
    expect(unitRun.code, unitRun.stdout).toBe(0);
    const nodeFolder = dirname(execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim());
    const unitHasGh = [nodeFolder, "/usr/local/bin", "/usr/bin", "/bin"].some((dir) => existsSync(join(dir, "gh")));
    if (unitHasGh) {
      expect(unitRun.stdout).not.toMatch(/the daemon will not find .*\bgh\b/);
    } else {
      expect(unitRun.stdout).toMatch(/the daemon will not find .*\bgh\b/);
      expect(unitRun.stdout).toContain(`the systemd unit's PATH is ${nodeFolder}:/usr/local/bin:/usr/bin:/bin`);
    }
  }, 240_000);

  describe("the browser download", () => {
    const attempt = async (name: string, playwrightMode: string, args: readonly string[] = manual, prepare = false) => {
      const home = await makeHome(name);
      const stubs = await makeStubs(name, { commands: ALL_COMMANDS });
      if (prepare) await placeBrowser(join(home, "browsers"));
      const result = run(depsEnv(home, stubs, { PI_SEC_TEST_PLAYWRIGHT_MODE: playwrightMode }), args);
      const log = await readFile(join(home, "playwright.log"), "utf8").catch(() => "");
      return { home, result, log };
    };

    it("downloads once with the Playwright CLI, and the block no longer lists the browser", async () => {
      const { home, result, log } = await attempt("dl-ok", "ok");
      expect(result.stderr, result.stdout).toBe("");
      expect(result.code, result.stdout).toBe(0);
      expect(log).toBe("install --only-shell chromium\n");
      expect(result.stdout).toContain("browser download");
      expect(result.stdout).toContain("fake playwright stderr");
      expect(await exists(join(browserPaths(join(home, "browsers")).directory, "INSTALLATION_COMPLETE"))).toBe(true);
      expect(result.stdout).not.toContain("headless Chromium browser, for the same features");
    }, 180_000);

    it("goes on with exit 0 when the download fails, or leaves no browser", async () => {
      for (const failing of ["fail", "nomarker"]) {
        const { result, log } = await attempt(`dl-${failing}`, failing);
        expect(result.stderr, result.stdout).toBe("");
        expect(result.code, result.stdout).toBe(0);
        expect(log).toBe("install --only-shell chromium\n");
        expect(result.stdout).toContain("the download failed in this run");
        expect(result.stdout).toContain(DOWNLOAD_COMMAND);
      }
    }, 240_000);

    it("does not run the CLI for a browser that is there or with --skip-browser", async () => {
      const there = await attempt("dl-there", "ok", manual, true);
      expect(there.result.stderr, there.result.stdout).toBe("");
      expect(there.result.code, there.result.stdout).toBe(0);
      expect(there.log).toBe("");
      expect(there.result.stdout).not.toContain("browser download");

      const skipped = await attempt("dl-skip", "ok", [...manual, "--skip-browser"]);
      expect(skipped.result.stderr, skipped.result.stdout).toBe("");
      expect(skipped.result.code, skipped.result.stdout).toBe(0);
      expect(skipped.log).toBe("");
      expect(skipped.result.stdout).not.toContain("browser download");
      expect(skipped.result.stdout).toContain("not downloaded (--skip-browser)");
      expect(skipped.result.stdout).toContain(DOWNLOAD_COMMAND);
      expect(await exists(browserPaths(join(skipped.home, "browsers")).directory)).toBe(false);
    }, 240_000);
  });

  describe("the Korean font item", () => {
    it("reports a missing font, and names the packages for the Debian family", async () => {
      const tree = await makeTree("font", "none");
      const commands = ALL_COMMANDS;

      const present = await helper("font-present", tree, await makeStubs("font-present", { commands, fcList: "font" }));
      expect(present.stdout).not.toContain("Korean font");

      // Must show, for an empty list and for a failing fc-list.
      for (const fcList of ["empty", "emptyfail"] as const) {
        const absent = await helper(`font-${fcList}`, tree, await makeStubs(`font-${fcList}`, { commands, fcList }));
        expect(absent.stdout).toContain("Korean font, for Korean text in browser screenshots: missing");
        expect(absent.stdout).toMatch(/apt-get install .*fonts-nanum/);
        expect(absent.stdout).not.toContain("fontconfig");
      }

      const noTool = await helper("font-notool", tree, await makeStubs("font-notool", { commands, fcList: null }));
      expect(noTool.stdout).toContain("not checked, because fc-list is missing");
      expect(noTool.stdout).toMatch(/apt-get install .*fontconfig fonts-nanum/);

      const fedoraNoTool = await helper("font-fedora-notool", tree, await makeStubs("font-fedora-notool", { commands, fcList: null }), {
        release: FEDORA_RELEASE,
      });
      expect(fedoraNoTool.stdout).toContain("not checked, because fc-list is missing");
      expect(fedoraNoTool.stdout).not.toContain("fonts-nanum");
      expect(fedoraNoTool.stdout).not.toContain("fontconfig fonts");

      const fedora = await helper("font-fedora", tree, await makeStubs("font-fedora", { commands, fcList: "empty" }), {
        release: FEDORA_RELEASE,
      });
      expect(fedora.stdout).toContain("Install a font that covers Korean, as root.");
      expect(fedora.stdout).not.toContain("fonts-nanum");
    }, 120_000);
  });
});
