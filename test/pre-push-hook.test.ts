/**
 * `user-tools/git-hooks/pre-push`.
 *
 * Every case works in a temporary repository with a bare remote, a temporary
 * `PI_SEC_HOME`, and a temporary word list. The environment is built from
 * nothing but those paths, so no case reads the word list of a live install.
 * The word in the list is a made-up one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LISTED_IDENTITY, UNLISTED_IDENTITY } from "./made-up-values.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const INSTALLER = join(REPO, "user-tools", "install-git-hooks");
const WORD = "zebra-quartz";

let root = "";
let counter = 0;

interface Out {
  readonly code: number | null;
  readonly text: string;
}

interface Fixture {
  readonly repo: string;
  readonly remote: string;
  readonly env: NodeJS.ProcessEnv;
}

function git(f: Fixture, args: readonly string[]): Out {
  const r = spawnSync("git", [...args], { env: f.env, cwd: f.repo, encoding: "utf8", timeout: 60_000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function commit(f: Fixture, file: string, text: string, message = "plain message"): Promise<void> {
  await writeFile(join(f.repo, file), text);
  git(f, ["add", file]);
  const out = git(f, ["commit", "--quiet", "-m", message]);
  expect(out.code, out.text).toBe(0);
}

/** A repository with the scan, the installed pre-push hook only, a bare remote, and one pushed clean commit. */
async function fixture(): Promise<Fixture> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  const piHome = join(dir, "pi-sec");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(piHome, { recursive: true });
  await mkdir(join(dir, "home"), { recursive: true });
  await copyFile(join(REPO, "scripts", "scan-tree.mjs"), join(repo, "scripts", "scan-tree.mjs"));
  // The scan imports the env file parser from src/secrets, so the copy holds it too.
  await mkdir(join(repo, "src", "secrets"), { recursive: true });
  await copyFile(join(REPO, "src", "secrets", "env-file.ts"), join(repo, "src", "secrets", "env-file.ts"));
  await copyFile(join(REPO, "scripts", "scan-allow.txt"), join(repo, "scripts", "scan-allow.txt"));
  await copyFile(join(REPO, "scripts", "check-identity.mjs"), join(repo, "scripts", "check-identity.mjs"));
  await writeFile(join(piHome, "scan-words.txt"), `# test list\n${WORD}\n`);
  await writeFile(join(piHome, "commit-identities.txt"), `# test list\n${LISTED_IDENTITY}\n`);
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
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote], { env });
  execFileSync("git", ["init", "--quiet", "-b", "main", repo], { env });
  const f: Fixture = { repo, remote, env };
  git(f, ["remote", "add", "origin", remote]);
  await commit(f, "a.txt", "plain text\n");
  await commit(f, "scripts-note.txt", "scripts are tracked\n");
  git(f, ["add", "scripts", "src"]);
  git(f, ["commit", "--quiet", "-m", "add the scan"]);
  const out = spawnSync("sh", [INSTALLER, repo], { env, cwd: repo, encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  // Install only matters for the pre-push file; hooks of the other two names stay out of the way.
  await rm(join(repo, ".git", "hooks", "pre-commit"));
  await rm(join(repo, ".git", "hooks", "commit-msg"));
  const first = git(f, ["push", "--quiet", "origin", "main"]);
  expect(first.code, first.text).toBe(0);
  return f;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-prepush-"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("pre-push hook", () => {
  it("accepts a clean push", async () => {
    const f = await fixture();
    await commit(f, "b.txt", "more plain text\n");
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code, out.text).toBe(0);
  });

  it("refuses a commit that adds a listed word, and prints neither the word nor the line", async () => {
    const f = await fixture();
    await commit(f, "b.txt", `leak ${WORD} here\n`);
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code).not.toBe(0);
    expect(out.text).toContain("b.txt:1: word");
    expect(out.text).not.toContain(WORD);
    expect(out.text).not.toContain("leak");
    expect(git(f, ["--git-dir", f.remote, "rev-parse", "main"]).text).not.toBe(git(f, ["rev-parse", "main"]).text);
  });

  it("refuses when a later commit of the same push removes the word", async () => {
    const f = await fixture();
    await commit(f, "b.txt", `leak ${WORD}\n`);
    await commit(f, "b.txt", "clean again\n");
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code).not.toBe(0);
    expect(out.text).not.toContain(WORD);
  });

  it("refuses a push that holds one commit by an unlisted author, and prints no identity", async () => {
    const f = await fixture();
    await commit(f, "b.txt", "clean\n");
    await writeFile(join(f.repo, "c.txt"), "also clean\n");
    git(f, ["add", "c.txt"]);
    const out = git(f, ["commit", "--quiet", "-m", "by someone else", `--author=${UNLISTED_IDENTITY}`]);
    expect(out.code, out.text).toBe(0);
    const pushed = git(f, ["push", "origin", "main"]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.text).toContain("author is not in");
    expect(pushed.text).not.toContain("zebra");
    expect(git(f, ["--git-dir", f.remote, "rev-parse", "main"]).text).not.toBe(git(f, ["rev-parse", "main"]).text);
  });

  it("refuses every push when the identity file is missing", async () => {
    const f = await fixture();
    await rm(join(f.env.PI_SEC_HOME as string, "commit-identities.txt"));
    await commit(f, "b.txt", "clean\n");
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code).not.toBe(0);
    expect(out.text).toContain("cannot read the identity list");
  });

  it("refuses a commit message that holds a listed word", async () => {
    const f = await fixture();
    await commit(f, "b.txt", "plain\n", `message about ${WORD}`);
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code).not.toBe(0);
    expect(out.text).toContain("msg ");
    expect(out.text).not.toContain(WORD);
  });

  it("scans only the commits that the remote lacks", async () => {
    const f = await fixture();
    await commit(f, "b.txt", "clean\n");
    expect(git(f, ["push", "origin", "main"]).code).toBe(0);
    // Add a word to the list that an already pushed commit holds: nothing new is scanned.
    await writeFile(join(f.env.PI_SEC_HOME as string, "scan-words.txt"), "plain text\n");
    await commit(f, "c.txt", "clean\n");
    expect(git(f, ["push", "origin", "main"]).code).toBe(0);
  });

  it("scans a new branch against the other remote refs and lets a delete pass", async () => {
    const f = await fixture();
    git(f, ["checkout", "--quiet", "-b", "topic"]);
    await commit(f, "b.txt", `leak ${WORD}\n`);
    expect(git(f, ["push", "origin", "topic"]).code).not.toBe(0);
    git(f, ["checkout", "--quiet", "main"]);
    git(f, ["branch", "--quiet", "-D", "topic"]);
    execFileSync("git", ["--git-dir", f.remote, "branch", "topic", "main"], { env: f.env });
    expect(git(f, ["push", "origin", "--delete", "topic"]).code).toBe(0);
  });

  it("refuses every push when the word list is missing, and says why", async () => {
    const f = await fixture();
    await rm(join(f.env.PI_SEC_HOME as string, "scan-words.txt"));
    await commit(f, "b.txt", "clean\n");
    const out = git(f, ["push", "origin", "main"]);
    expect(out.code).not.toBe(0);
    expect(out.text).toContain("cannot read the word list");
  });
});
