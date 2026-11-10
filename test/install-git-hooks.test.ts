/**
 * `user-tools/install-git-hooks` and the three hooks it installs.
 *
 * Every case works in a temporary repository with a temporary `PI_SEC_HOME`.
 * The environment is built from nothing but those paths, so no case reads or
 * writes the hooks of this checkout or the word list of a live install. The word
 * in the list is a made-up one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LISTED_IDENTITY, UNLISTED_IDENTITY, mustFail } from "./made-up-values.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const INSTALLER = join(REPO, "user-tools", "install-git-hooks");
const WORD = "zebra-quartz";

let root = "";
let counter = 0;

interface Out {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Fixture {
  readonly repo: string;
  readonly piHome: string;
  readonly words: string;
  readonly identities: string;
  readonly env: NodeJS.ProcessEnv;
}

function sh(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Out {
  const result = spawnSync(command, [...args], { env, cwd, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** A repository that holds the tree scan, an install home with no word list yet, and a clean environment. */
async function fixture(): Promise<Fixture> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  const repo = join(dir, "repo");
  const piHome = join(dir, "pi-sec");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(piHome, { recursive: true });
  await copyFile(join(REPO, "scripts", "scan-tree.mjs"), join(repo, "scripts", "scan-tree.mjs"));
  // The scan imports the env file parser from src/secrets, so the copy holds it too.
  await mkdir(join(repo, "src", "secrets"), { recursive: true });
  await copyFile(join(REPO, "src", "secrets", "env-file.ts"), join(repo, "src", "secrets", "env-file.ts"));
  await copyFile(join(REPO, "scripts", "scan-allow.txt"), join(repo, "scripts", "scan-allow.txt"));
  await copyFile(join(REPO, "scripts", "check-identity.mjs"), join(repo, "scripts", "check-identity.mjs"));
  const env: NodeJS.ProcessEnv = {
    HOME: join(dir, "home"),
    PI_SEC_HOME: piHome,
    PATH: process.env.PATH ?? "",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    TERM: "dumb",
  };
  await mkdir(env.HOME as string, { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main", repo], { env });
  return { repo, piHome, words: join(piHome, "scan-words.txt"), identities: join(piHome, "commit-identities.txt"), env };
}

function install(f: Fixture, repo: string = f.repo): Out {
  return sh("sh", [INSTALLER, repo], f.env, f.repo);
}

function git(f: Fixture, args: readonly string[], cwd: string = f.repo): Out {
  return sh("git", args, f.env, cwd);
}

async function installed(f: Fixture): Promise<Fixture> {
  const out = install(f);
  expect(out.code, out.stderr).toBe(0);
  await writeFile(f.words, `# test list\n${WORD}\n`);
  await writeFile(f.identities, `# test list\n${LISTED_IDENTITY}\n`);
  return f;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-hooks-"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("user-tools/install-git-hooks", () => {
  it("ships the three hooks and the installer as executable files", async () => {
    for (const path of ["install-git-hooks", "git-hooks/pre-commit", "git-hooks/commit-msg", "git-hooks/pre-push"]) {
      expect((await mode(join(REPO, "user-tools", path))) & 0o111, path).not.toBe(0);
    }
  });

  it("installs the three hooks with mode 755 and creates a word list with mode 600", async () => {
    const f = await fixture();
    const out = install(f);
    expect(out.code, out.stderr).toBe(0);
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
      const target = join(f.repo, ".git", "hooks", name);
      expect(await readFile(target, "utf8")).toBe(await readFile(join(REPO, "user-tools", "git-hooks", name), "utf8"));
      expect(await mode(target)).toBe(0o755);
    }
    expect(await mode(f.words)).toBe(0o600);
    expect(await readFile(f.words, "utf8")).toMatch(/^#/);
    expect((await readFile(f.words, "utf8")).split("\n").filter((l) => l !== "" && !l.startsWith("#"))).toEqual([]);
  });

  it("changes nothing on a second run and keeps a word list that exists", async () => {
    const f = await installed(await fixture());
    const before = await readFile(f.words, "utf8");
    const out = install(f);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain("already installed");
    expect(await readFile(f.words, "utf8")).toBe(before);
  });

  it("refuses to replace a hook file that holds other text, and changes no hook", async () => {
    const f = await fixture();
    const hooks = join(f.repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "commit-msg"), "#!/bin/sh\necho foreign\n");
    const out = install(f);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("commit-msg");
    expect(await readFile(join(hooks, "commit-msg"), "utf8")).toBe("#!/bin/sh\necho foreign\n");
    expect((await readdir(hooks)).includes("pre-commit")).toBe(false);
  });

  it("reads and writes no other hook file", async () => {
    const f = await fixture();
    const hooks = join(f.repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "reference-transaction"), "#!/bin/sh\nexit 0\n");
    await chmod(join(hooks, "reference-transaction"), 0o700);
    const before = await stat(join(hooks, "reference-transaction"));
    expect(install(f).code).toBe(0);
    const after = await stat(join(hooks, "reference-transaction"));
    expect(await readFile(join(hooks, "reference-transaction"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
  });
});

describe("the installed hooks", () => {
  it("refuse a staged file that holds a listed word, and name the word", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), `a line with ${WORD} inside\n`);
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", "plain message"]);
    expect(out.code).not.toBe(0);
    expect(out.stdout + out.stderr).toContain(WORD);
    expect(git(f, ["rev-parse", "--verify", "HEAD"]).code).not.toBe(0);
  });

  it("refuse a commit message that holds a listed word", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", `message about ${WORD}`]);
    expect(out.code).not.toBe(0);
    expect(out.stdout + out.stderr).toContain(WORD);
  });

  it("check the index and not the work tree", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), `leak ${WORD}\n`);
    git(f, ["add", "a.txt", "scripts", "src"]);
    await writeFile(join(f.repo, "a.txt"), "clean again\n");
    expect(git(f, ["commit", "-m", "plain message"]).code).not.toBe(0);
  });

  it("run in a linked worktree", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    expect(git(f, ["commit", "-m", "first"]).code).toBe(0);
    const wt = join(root, `wt-${counter}`);
    expect(git(f, ["worktree", "add", "--quiet", "--detach", wt, "main"]).code).toBe(0);
    await writeFile(join(wt, "b.txt"), `leak ${WORD}\n`);
    git(f, ["add", "b.txt"], wt);
    expect(git(f, ["commit", "-m", "plain message"], wt).code).not.toBe(0);
    await writeFile(join(wt, "b.txt"), "clean\n");
    git(f, ["add", "b.txt"], wt);
    const ok = git(f, ["commit", "-m", "plain message"], wt);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
  });

  it("refuse every commit when the word list is missing, and say why", async () => {
    const f = await installed(await fixture());
    await rm(f.words);
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", "plain message"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("cannot read the word list");
  });
});

const OLD_HOOK = "#!/bin/sh\n# pi-sec install hook. An older text.\nexit 0\n";

describe("install-git-hooks --update", () => {
  it("replaces three older pi-sec hooks with the shipped files", async () => {
    const f = await fixture();
    const hooks = join(f.repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) await writeFile(join(hooks, name), OLD_HOOK);
    expect(install(f).code).toBe(1);
    const out = sh("sh", [INSTALLER, "--update", f.repo], f.env, f.repo);
    expect(out.code, out.stderr).toBe(0);
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
      expect(await readFile(join(hooks, name), "utf8")).toBe(await readFile(join(REPO, "user-tools", "git-hooks", name), "utf8"));
      expect(await mode(join(hooks, name))).toBe(0o755);
    }
  });

  it("refuses a hook file without the pi-sec line and changes no hook", async () => {
    const f = await fixture();
    const hooks = join(f.repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "pre-commit"), OLD_HOOK);
    await writeFile(join(hooks, "pre-push"), "#!/bin/sh\necho foreign\n");
    const out = sh("sh", [INSTALLER, "--update", f.repo], f.env, f.repo);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("pre-push");
    expect(await readFile(join(hooks, "pre-commit"), "utf8")).toBe(OLD_HOOK);
    expect(await readFile(join(hooks, "pre-push"), "utf8")).toBe("#!/bin/sh\necho foreign\n");
    expect((await readdir(hooks)).includes("commit-msg")).toBe(false);
  });
});

describe("the identity list", () => {
  it("is created with mode 600 and the default line", async () => {
    const f = await fixture();
    expect(install(f).code).toBe(0);
    expect(await mode(f.identities)).toBe(0o600);
    const lines = (await readFile(f.identities, "utf8")).split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines).toEqual(["pi-sec <pi-sec@localhost>"]);
  });

  it("is left as it is when it exists", async () => {
    const f = await fixture();
    await writeFile(f.identities, `${UNLISTED_IDENTITY}\n`);
    expect(install(f).code).toBe(0);
    expect(await readFile(f.identities, "utf8")).toBe(`${UNLISTED_IDENTITY}\n`);
  });
});

describe("the identity check of pre-commit", () => {
  it("accepts a commit by a listed identity", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", "plain message"]);
    expect(out.code, out.stdout + out.stderr).toBe(0);
  });

  it("refuses a commit with an author that is not listed, without printing the identity", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", "plain message", `--author=${UNLISTED_IDENTITY}`]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("author is not in");
    expect(out.stdout + out.stderr).not.toContain("zebra");
    expect(git(f, ["rev-parse", "--verify", "HEAD"]).code).not.toBe(0);
  });

  it("refuses a commit with a committer that is not listed", async () => {
    const f = await installed(await fixture());
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["-c", "user.name=zebra", "-c", "user.email=zebra@example.com", "commit", "-m", "plain message"]);
    // The environment names the committer, so the config does not change it: this one passes.
    expect(out.code, out.stdout + out.stderr).toBe(0);
    await writeFile(join(f.repo, "b.txt"), "more\n");
    git(f, ["add", "b.txt"]);
    const env = { ...f.env, GIT_COMMITTER_NAME: "zebra", GIT_COMMITTER_EMAIL: "zebra@example.com" };
    const refused = sh("git", ["commit", "-m", "second"], env, f.repo);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("committer is not in");
  });

  it("refuses every commit when the identity file is missing, and says why", async () => {
    const f = await installed(await fixture());
    await rm(f.identities);
    await writeFile(join(f.repo, "a.txt"), "plain text\n");
    git(f, ["add", "a.txt", "scripts", "src"]);
    const out = git(f, ["commit", "-m", "plain message"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("cannot read the identity list");
  });

  it("refuses a staged ULID-shaped token and a real-looking address through the hook", async () => {
    const f = await installed(await fixture());
    for (const value of mustFail()) {
      await writeFile(join(f.repo, "a.txt"), `${value}\n`);
      git(f, ["add", "a.txt", "scripts", "src"]);
      const out = git(f, ["commit", "-m", "plain message"]);
      expect(out.code, value.length.toString()).not.toBe(0);
      expect(out.stdout + out.stderr).toContain("shape");
    }
  });
});
