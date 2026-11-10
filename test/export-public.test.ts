/**
 * `user-tools/export-public`: one commit of a repository becomes a new
 * repository with a single commit.
 *
 * Every case works in a temporary source repository with a temporary `PI_SEC_HOME`
 * and `HOME`. The word in the list and the identities are made up, and the ids
 * that must be refused are built when the test runs.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LISTED_IDENTITY, UNLISTED_IDENTITY, madeUpUlid } from "./made-up-values.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WORD = "zebra-quartz";

let root = "";
let counter = 0;

interface Fixture {
  readonly dir: string;
  readonly source: string;
  readonly env: NodeJS.ProcessEnv;
}

function sh(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): { code: number | null; text: string } {
  const result = spawnSync(command, [...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  return { code: result.status, text: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A source repository that holds the scan, the identity check and the hook files, with one commit. */
async function fixture(extra: Record<string, string> = {}): Promise<Fixture> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  const source = join(dir, "source");
  const piHome = join(dir, "pi-sec");
  await mkdir(piHome, { recursive: true });
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(join(source, "scripts"), { recursive: true });
  for (const file of ["scan-tree.mjs", "scan-allow.txt", "check-identity.mjs"]) {
    await cp(join(REPO, "scripts", file), join(source, "scripts", file));
  }
  // The scan imports the env file parser from src/secrets, so the copy holds it too.
  await mkdir(join(source, "src", "secrets"), { recursive: true });
  await cp(join(REPO, "src", "secrets", "env-file.ts"), join(source, "src", "secrets", "env-file.ts"));
  await cp(join(REPO, "user-tools"), join(source, "user-tools"), { recursive: true });
  await writeFile(join(source, "README.txt"), "plain text\n");
  for (const [path, text] of Object.entries(extra)) await writeFile(join(source, path), text);
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
  expect(sh("git", ["init", "--quiet", "-b", "main", source], env, dir).code).toBe(0);
  expect(sh("git", ["add", "-A"], env, source).code).toBe(0);
  const committed = sh("git", ["commit", "--quiet", "-m", "source"], env, source);
  expect(committed.code, committed.text).toBe(0);
  return { dir, source, env };
}

function exportRun(f: Fixture, args: readonly string[]): { code: number | null; text: string } {
  return sh(join(REPO, "user-tools", "export-public"), args, f.env, f.dir);
}

function base(f: Fixture, out = join(f.dir, "out")): string[] {
  return ["--repository", f.source, "--ref", "main", "--out", out, "--identity", LISTED_IDENTITY, "--message", "release 1", "--date", "2030-01-15"];
}

function git(f: Fixture, cwd: string, args: readonly string[]): string {
  const out = sh("git", args, f.env, cwd);
  expect(out.code, out.text).toBe(0);
  return out.text.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-export-"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("export-public", () => {
  it("ships as an executable file", async () => {
    const result = sh("test", ["-x", join(REPO, "user-tools", "export-public")], {}, REPO);
    expect(result.code).toBe(0);
  });

  it("exports a clean repository as one commit with the same tree, +0000 dates, and a bundle that clones to the same tree", async () => {
    const f = await fixture();
    const out = join(f.dir, "out");
    const bundle = join(f.dir, "out.bundle");
    const result = exportRun(f, [...base(f, out), "--bundle", bundle]);
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain("export-public: commit ");
    expect(git(f, out, ["rev-list", "--count", "--all"])).toBe("1");
    expect(git(f, out, ["rev-parse", "HEAD^{tree}"])).toBe(git(f, f.source, ["rev-parse", "main^{tree}"]));
    expect(git(f, out, ["log", "-1", "--format=%ad|%cd", "--date=iso-strict"])).toBe("2030-01-15T00:00:00+00:00|2030-01-15T00:00:00+00:00");
    expect(git(f, out, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"])).toBe(`${LISTED_IDENTITY}|${LISTED_IDENTITY}|release 1`);
    expect(git(f, out, ["remote"])).toBe("");
    const clone = join(f.dir, "clone");
    git(f, f.dir, ["clone", "--quiet", bundle, clone]);
    expect(git(f, clone, ["rev-parse", "HEAD^{tree}"])).toBe(git(f, f.source, ["rev-parse", "main^{tree}"]));
  });

  it("uses the top of the repository that holds the script when --repository is not given", async () => {
    const f = await fixture();
    const out = join(f.dir, "out");
    const args = base(f, out).slice(2);
    const result = sh(join(f.source, "user-tools", "export-public"), args, f.env, f.dir);
    expect(result.code, result.text).toBe(0);
    expect(git(f, out, ["rev-list", "--count", "--all"])).toBe("1");
    expect(git(f, out, ["rev-parse", "HEAD^{tree}"])).toBe(git(f, f.source, ["rev-parse", "main^{tree}"]));
  });

  it("installs the same hooks into the export, so a later push runs the same checks", async () => {
    const f = await fixture();
    const out = join(f.dir, "out");
    expect(exportRun(f, base(f, out)).code).toBe(0);
    const installed = sh("cmp", [join(out, ".git", "hooks", "pre-push"), join(out, "user-tools", "git-hooks", "pre-push")], f.env, f.dir);
    expect(installed.code, installed.text).toBe(0);
  });

  it("refuses a listed word in a file, keeps the output directory, and prints no value", async () => {
    const f = await fixture({ "notes.txt": `a line with ${WORD}\n` });
    const out = join(f.dir, "out");
    const result = exportRun(f, base(f, out));
    expect(result.code).toBe(1);
    expect(result.text).toContain("export-public: refused:");
    expect(result.text).not.toContain(WORD);
    expect(sh("test", ["-d", out], f.env, f.dir).code).toBe(0);
  });

  it("refuses a made-up id in a file", async () => {
    const f = await fixture({ "notes.txt": `id ${madeUpUlid(5)}\n` });
    const result = exportRun(f, base(f));
    expect(result.code).toBe(1);
    expect(result.text).toContain("export-public: refused:");
    expect(result.text).not.toContain(madeUpUlid(5));
  });

  it("refuses an identity that is not listed", async () => {
    const f = await fixture();
    const args = base(f);
    args[args.indexOf(LISTED_IDENTITY)] = UNLISTED_IDENTITY;
    const result = exportRun(f, args);
    expect(result.code).toBe(1);
    expect(result.text).toContain("export-public: refused:");
  });

  it("refuses an output directory that exists, and a bundle file that exists", async () => {
    const f = await fixture();
    await mkdir(join(f.dir, "out"));
    const first = exportRun(f, base(f));
    expect(first.code).toBe(1);
    expect(first.text).toContain("exists");
    await writeFile(join(f.dir, "taken.bundle"), "x");
    const second = exportRun(f, [...base(f, join(f.dir, "fresh")), "--bundle", join(f.dir, "taken.bundle")]);
    expect(second.code).toBe(1);
    expect(second.text).toContain("exists");
  });

  it("refuses a commit message that holds a listed word", async () => {
    const f = await fixture();
    const args = base(f);
    args[args.indexOf("release 1")] = `release of ${WORD}`;
    const result = exportRun(f, args);
    expect(result.code).toBe(1);
    expect(result.text).toContain("export-public: refused:");
  });
});
