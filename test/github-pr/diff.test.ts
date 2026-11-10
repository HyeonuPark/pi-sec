import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitCommandRefusedError, GitError, runGit, isAllowedGitCall } from "../../src/extensions/github-pr/git.ts";
import {
  CommitNotInPrError,
  computeCommitDiff,
  computePrDiff,
  MAX_CONTENT_LINES,
  parseUnifiedDiff,
} from "../../src/extensions/github-pr/diff.ts";
import { createRepoStore, DiskLimitError } from "../../src/extensions/github-pr/store.ts";

/**
 * Diff computation and the git gate, against local repositories only.
 *
 * The origin of every case is a directory this file creates. The store's
 * `remoteUrl` is what points a remote at it, which is the same seam the daemon
 * fills with `https://github.com/<owner>/<repo>.git`.
 */

const root = mkdtempSync(join(tmpdir(), "gh-repo-diff-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let sequence = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "--all"]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

interface Fixture {
  /** The repository the PR is open in. */
  readonly origin: string;
  /** The store, with `acme/app` mapped onto `origin`. */
  readonly store: ReturnType<typeof createRepoStore>;
  /** The bare repository the store keeps. */
  readonly bareRepo: string;
  /** `main`'s tip before the PR branch. */
  readonly baseSha: string;
  /** The PR head commit. */
  readonly headSha: string;
  /** Set the PR head and base branch on the origin, as GitHub would report them. */
  setPr(baseSha: string, headSha: string): void;
  /** Path of a source file in the origin's working tree. */
  file(name: string): string;
}

/** A repository with `main`, one PR branch, and a `refs/pull/7/head` ref for it. */
function makeFixture(options: { diskLimitMegabytes?: number } = {}): Fixture {
  sequence += 1;
  const origin = join(root, "origins", `app-${sequence}`);
  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--quiet", "-b", "main", "."]);

  writeFileSync(join(origin, "keep.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(origin, "gone.txt"), "deleted in the pr\n");
  writeFileSync(join(origin, "old-name.txt"), "renamed\n");
  writeFileSync(join(origin, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(origin, "shared.txt"), "base version\n");
  const baseSha = commit(origin, "base");

  git(origin, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(origin, "keep.txt"), "one\nTWO\nthree\n");
  rmSync(join(origin, "gone.txt"));
  git(origin, ["mv", "old-name.txt", "new-name.txt"]);
  writeFileSync(join(origin, "binary.dat"), Buffer.from([0, 9, 8, 7]));
  writeFileSync(join(origin, "added.txt"), "brand new\n");
  const headSha = commit(origin, "change");
  git(origin, ["update-ref", "refs/pull/7/head", headSha]);
  git(origin, ["checkout", "--quiet", "main"]);

  const storeRoot = join(root, "gh-repo", String(sequence));
  mkdirSync(storeRoot, { recursive: true });
  const store = createRepoStore({
    root: storeRoot,
    ...(options.diskLimitMegabytes === undefined ? {} : { diskLimitMegabytes: options.diskLimitMegabytes }),
    remoteUrl: () => origin,
    read: async () => ({ fork: false, size: 64 }),
  });
  const bareRepo = join(storeRoot, "acme", "app.git");

  return {
    origin,
    store,
    bareRepo,
    baseSha,
    headSha,
    setPr(base, head) {
      // GitHub reports the base branch and head commit; the base branch is the
      // ref the diff fetches, so it is moved on the origin here.
      git(origin, ["update-ref", "refs/heads/main", base]);
      git(origin, ["update-ref", "refs/pull/7/head", head]);
    },
    file: (name) => join(origin, name),
  };
}

function diffOf(fixture: Fixture, overrides: { baseRef?: string; headSha?: string } = {}) {
  return computePrDiff({
    store: fixture.store,
    repo: "acme/app",
    number: 7,
    baseRef: overrides.baseRef ?? "main",
    headSha: overrides.headSha ?? fixture.headSha,
  });
}

describe("git subcommand gate", () => {
  it("runs the listed subcommands and refuses everything else before a process starts", async () => {
    const dir = join(root, "gate");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet", "--bare", "."]);

    // An allowed subcommand runs; the directory is a bare repository.
    const init = await runGit(dir, ["rev-parse", "--is-bare-repository"]);
    expect(init.stdout.trim()).toBe("true");

    for (const refused of ["push", "gc", "checkout", "reset", "clean", "update-ref", "reflog", "clone"]) {
      const failure = await runGit(dir, [refused, "origin", "main"]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitCommandRefusedError);
      const error = failure as GitCommandRefusedError;
      expect(error.subcommand).toBe(refused);
      // The message names the refused word and then the whole allowed list, so a
      // caller reading a log sees both what failed and what may be asked.
      expect(error.message).toBe(
        `git ${refused} is not one of the subcommands this extension runs ` +
          "(cat-file, config, diff, fetch, init, merge-base, remote, rev-parse, show)",
      );
    }

    // No subcommand at all is refused too, not run.
    await expect(runGit(dir, [])).rejects.toBeInstanceOf(GitCommandRefusedError);
    expect(isAllowedGitCall(["fetch", "origin"])).toBe(true);
    expect(isAllowedGitCall(["push"])).toBe(false);
  });

  it("does not mistake an argument for a subcommand", async () => {
    const failure = await runGit(root, ["-c", "core.fsmonitor=false", "status"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitCommandRefusedError);
  });

  it("reports a failing command as GitError, and returns it when check is false", async () => {
    const dir = join(root, "gate-fail");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet", "--bare", "."]);

    await expect(runGit(dir, ["show", "0".repeat(40)])).rejects.toBeInstanceOf(GitError);
    const unchecked = await runGit(dir, ["show", "0".repeat(40)], { check: false });
    expect(unchecked.code).not.toBe(0);
    expect(unchecked.stderr.length).toBeGreaterThan(0);
  });

  it("gives the child the caller's environment with the extra values on top", async () => {
    // Git reads `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and
    // `GIT_CONFIG_VALUE_<n>` from its environment as extra config, so a value
    // that arrives that way proves the environment reached the child. The gate
    // builds that environment itself, which is where `GIT_TERMINAL_PROMPT=0`
    // and `GIT_PAGER=cat` are set.
    const dir = join(root, "gate-env");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet", "--bare", "."]);

    const throughEnv = await runGit(dir, ["config", "--get", "core.commentchar"], {
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.commentchar", GIT_CONFIG_VALUE_0: "#" },
    });
    expect(throughEnv.stdout.trim()).toBe("#");

    // The environment is not shared with the next call: the gate starts each
    // one from the daemon's own environment.
    const plainCall = await runGit(dir, ["config", "--get", "core.commentchar"], { check: false });
    expect(plainCall.code).not.toBe(0);
  });

  it("kills a command that prints more than the output cap, and says so", async () => {
    const dir = join(root, "gate-cap");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet", "-b", "main", "."]);
    writeFileSync(join(dir, "big.txt"), `${"x".repeat(4000)}\n`);
    commit(dir, "big");

    // The cap is per stream, so a `git show` of a 4 KB file cannot pass 100 bytes.
    const failure = await runGit(dir, ["show", "HEAD:big.txt"], { maxOutputBytes: 100 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).message).toContain("more than 100 bytes");
  });

  it("reports a directory that is gone as a git that could not be started", async () => {
    const missing = join(root, "no-such-directory");
    const failure = await runGit(missing, ["rev-parse", "--all"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).message).toContain("could not be started");
  });
});

describe("diff payload", () => {
  it("has the original shape and the original order of files by path", async () => {
    const fixture = makeFixture();
    const diff = await diffOf(fixture);

    expect(Object.keys(diff).sort()).toEqual(["baseRef", "baseSha", "files", "headSha", "mergeBase", "number"]);
    expect(diff.number).toBe(7);
    expect(diff.baseRef).toBe("main");
    expect(diff.baseSha).toBe(fixture.baseSha);
    expect(diff.headSha).toBe(fixture.headSha);
    expect(diff.mergeBase).toBe(fixture.baseSha);
    // Sorted by the path after the change, with a deleted file sorted by its old
    // path because it has no new one.
    expect(diff.files.map((file) => file.path ?? file.oldPath)).toEqual([
      "added.txt",
      "binary.dat",
      "gone.txt",
      "keep.txt",
      "new-name.txt",
    ]);
  });

  it("classifies add, modify, delete, rename and binary, with hunks", async () => {
    const fixture = makeFixture();
    const diff = await diffOf(fixture);
    const byPath = new Map(diff.files.map((file) => [file.path ?? file.oldPath, file]));

    const added = byPath.get("added.txt");
    expect(added?.status).toBe("A");
    expect(added?.oldPath).toBeNull();
    expect(added?.additions).toBe(1);
    expect(added?.newContent).toEqual(["brand new"]);
    expect(added?.oldContent).toBeUndefined();

    const modified = byPath.get("keep.txt");
    expect(modified?.path).toBe("keep.txt");
    expect(modified?.status).toBe("M");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);
    expect(modified?.oldContent).toEqual(["one", "two", "three"]);
    expect(modified?.newContent).toEqual(["one", "TWO", "three"]);
    expect(modified?.hunks).toHaveLength(1);
    const hunk = modified?.hunks[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.oldLines).toBe(3);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newLines).toBe(3);
    expect(hunk?.lines).toEqual([
      { t: "ctx", s: "one" },
      { t: "del", s: "two" },
      { t: "add", s: "TWO" },
      { t: "ctx", s: "three" },
    ]);

    // A deleted file keeps its one path in both fields, which is what the
    // original payload did: `path` falls back to `oldPath` when `+++` said
    // /dev/null, and `status` D is what says the file is gone.
    const deleted = byPath.get("gone.txt");
    expect(deleted?.status).toBe("D");
    expect(deleted?.oldPath).toBe("gone.txt");
    expect(deleted?.path).toBe("gone.txt");
    expect(deleted?.oldContent).toEqual(["deleted in the pr"]);
    expect(deleted?.newContent).toBeUndefined();

    const renamed = byPath.get("new-name.txt");
    expect(renamed?.status).toBe("R");
    expect(renamed?.oldPath).toBe("old-name.txt");
    expect(renamed?.newContent).toEqual(["renamed"]);

    const binary = byPath.get("binary.dat");
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);
    expect(binary?.oldContent).toBeUndefined();
    expect(binary?.newContent).toBeUndefined();
  });

  it("compares the merge base, not the base branch tip", async () => {
    const fixture = makeFixture();
    // `main` moves on after the branch was cut. The PR diff must not show it.
    git(fixture.origin, ["checkout", "--quiet", "main"]);
    writeFileSync(fixture.file("shared.txt"), "main moved on\n");
    const movedMain = commit(fixture.origin, "main moves");
    git(fixture.origin, ["checkout", "--quiet", "feature"]);

    const diff = await diffOf(fixture, { headSha: fixture.headSha });
    expect(diff.baseSha).toBe(movedMain);
    expect(diff.mergeBase).toBe(fixture.baseSha);
    expect(diff.files.map((file) => file.path ?? file.oldPath)).not.toContain("shared.txt");
  });

  it("fetches refs/pull/<n>/head when the head commit is not local, then rev-parses FETCH_HEAD", async () => {
    const fixture = makeFixture();
    // A PR opened for a ref that does not exist yet: the given sha is unknown, so
    // the fallback to FETCH_HEAD is what produces the head.
    const diff = await diffOf(fixture, { headSha: "0".repeat(40) });

    expect(diff.headSha).toBe(fixture.headSha);
    expect(diff.files.length).toBeGreaterThan(0);
  });

  it("does not fetch the pull ref again when the head commit is already local", async () => {
    const fixture = makeFixture();
    await diffOf(fixture);

    // The origin's pull ref is deleted. A second view still works because the
    // head commit came down with the first one and is never fetched again.
    git(fixture.origin, ["update-ref", "-d", "refs/pull/7/head"]);
    const second = await diffOf(fixture);
    expect(second.headSha).toBe(fixture.headSha);
  });

  it("fetches the base branch on every view, and falls back to the remote-tracking ref when that fails", async () => {
    const fixture = makeFixture();
    await diffOf(fixture);

    // The branch moves: a second view sees the new tip.
    git(fixture.origin, ["checkout", "--quiet", "main"]);
    writeFileSync(fixture.file("keep.txt"), "one\ntwo\nthree\nfour\n");
    const moved = commit(fixture.origin, "base moves");
    const second = await diffOf(fixture);
    expect(second.baseSha).toBe(moved);

    // The branch disappears from the origin: the fetch fails, and the
    // remote-tracking ref from the earlier fetch is what answers.
    git(fixture.origin, ["checkout", "--quiet", "main"]);
    git(fixture.origin, ["update-ref", "-d", "refs/heads/main"]);
    const third = await diffOf(fixture);
    expect(third.baseSha).toBe(moved);
  });

  it("keeps the path of a file whose name has a space in it", async () => {
    const fixture = makeFixture();
    git(fixture.origin, ["checkout", "--quiet", "-b", "spaced", fixture.baseSha]);
    writeFileSync(fixture.file("with space.txt"), "spaced content\n");
    const head = commit(fixture.origin, "a name with a space");
    git(fixture.origin, ["update-ref", "refs/pull/9/head", head]);
    git(fixture.origin, ["checkout", "--quiet", "main"]);

    const diff = await computePrDiff({
      store: fixture.store,
      repo: "acme/app",
      number: 9,
      baseRef: "main",
      headSha: head,
    });
    const spaced = diff.files.find((file) => file.path === "with space.txt");
    expect(spaced?.status).toBe("A");
    expect(spaced?.newContent).toEqual(["spaced content"]);
  });

  it("leaves the whole content out for a file over the line limit, and still sends the hunks", async () => {
    const fixture = makeFixture();
    git(fixture.origin, ["checkout", "--quiet", "-b", "big", fixture.baseSha]);
    const lines: string[] = [];
    for (let index = 0; index < MAX_CONTENT_LINES + 10; index += 1) lines.push(`line ${index}`);
    writeFileSync(fixture.file("long.txt"), `${lines.join("\n")}\n`);
    const bigHead = commit(fixture.origin, "long file");
    git(fixture.origin, ["update-ref", "refs/pull/8/head", bigHead]);
    git(fixture.origin, ["checkout", "--quiet", "main"]);

    const diff = await computePrDiff({
      store: fixture.store,
      repo: "acme/app",
      number: 8,
      baseRef: "main",
      headSha: bigHead,
    });
    const long = diff.files.find((file) => file.path === "long.txt");
    expect(long?.status).toBe("A");
    expect(long?.newContent).toBeNull();
    expect(long?.additions).toBe(MAX_CONTENT_LINES + 10);
  });

  it("refuses the first fetch of a network that would pass the disk limit", async () => {
    const fixture = makeFixture({ diskLimitMegabytes: 1 });
    // GitHub's size for the network is 64 KB here, so the estimate alone fits;
    // a filler under the root is what pushes the sum over the limit.
    writeFileSync(join(root, "gh-repo", String(sequence), "filler.bin"), Buffer.alloc(2 * 1024 * 1024));

    const failure = await diffOf(fixture).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiskLimitError);
    expect((failure as DiskLimitError).toPayload()).toMatchObject({ error: "disk_limit", limitMegabytes: 1 });
  });

  it("serializes two diffs of one bare repository", async () => {
    const fixture = makeFixture();
    const results = await Promise.all([diffOf(fixture), diffOf(fixture), diffOf(fixture)]);
    for (const result of results) {
      expect(result.headSha).toBe(fixture.headSha);
      expect(result.files.length).toBeGreaterThan(0);
    }
  });

  it("asks no network: every remote is a directory this test made", async () => {
    const fixture = makeFixture();
    await diffOf(fixture);
    const remoteUrls = git(fixture.bareRepo, ["remote", "--verbose"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/)[1] ?? "");
    expect(remoteUrls.length).toBeGreaterThan(0);
    for (const url of remoteUrls) {
      expect(url.startsWith("/")).toBe(true);
      expect(existsSync(url)).toBe(true);
    }
  });

  it("works for a repository in a network whose root is another repository", async () => {
    const fixture = makeFixture();
    // `me/app` is a fork of `acme/app`, so one bare repository holds both, and
    // the diff is fetched from this repository's own remote.
    const forkOrigin = join(root, "origins", `fork-${sequence}`);
    mkdirSync(forkOrigin, { recursive: true });
    execFileSync("git", ["clone", "--quiet", "--bare", fixture.origin, forkOrigin]);
    git(forkOrigin, ["update-ref", "refs/pull/7/head", fixture.headSha]);

    const storeRoot = join(root, "gh-repo-fork");
    mkdirSync(storeRoot, { recursive: true });
    const store = createRepoStore({
      root: storeRoot,
      remoteUrl: (slug) => (slug === "me/app" ? forkOrigin : fixture.origin),
      read: async (owner) =>
        owner === "me"
          ? { fork: true, source: { owner: "acme", name: "app" }, size: 64 }
          : { fork: false, size: 64 },
    });
    await store.reconcile(["acme/app", "me/app"]);
    expect(store.forRepo("me/app")?.path).toBe(join(storeRoot, "acme", "app.git"));

    const diff = await computePrDiff({
      store,
      repo: "me/app",
      number: 7,
      baseRef: "main",
      headSha: fixture.headSha,
    });
    expect(diff.headSha).toBe(fixture.headSha);
    expect(diff.files.map((file) => file.path ?? file.oldPath)).toContain("added.txt");
  });
});

function commitDiffOf(fixture: Fixture, sha: string, headSha: string = fixture.headSha) {
  return computeCommitDiff({ store: fixture.store, repo: "acme/app", number: 7, headSha, sha });
}

describe("commit diff", () => {
  it("gives a normal commit's diff against its parent, with the whole contents and its facts", async () => {
    const fixture = makeFixture();
    const diff = await commitDiffOf(fixture, fixture.headSha);

    expect(diff.number).toBe(7);
    expect(diff.headSha).toBe(fixture.headSha);
    expect(diff.mergeBase).toBe(fixture.baseSha);
    expect(diff.baseSha).toBe(fixture.baseSha);
    expect(diff.baseRef).toBe("");
    // The same files as the pull request diff, because the branch has one commit.
    const whole = await diffOf(fixture);
    // The old path of a rename counts too: it is the check of the commit page's rename.
    expect(diff.files.map((file) => [file.path, file.status, file.additions, file.deletions, file.oldPath])).toEqual(
      whole.files.map((file) => [file.path, file.status, file.additions, file.deletions, file.oldPath]),
    );
    const keep = diff.files.find((file) => file.path === "keep.txt");
    expect(keep?.oldContent).toEqual(["one", "two", "three"]);
    expect(keep?.newContent).toEqual(["one", "TWO", "three"]);
    expect(diff.commit).toMatchObject({
      sha: fixture.headSha,
      parents: [fixture.baseSha],
      authorName: "t",
      authorEmail: "t@example.invalid",
      headline: "change",
      body: "",
    });
    expect(diff.commit.authoredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("gives a root commit's creation diff with no old content, and says it has no parent", async () => {
    const fixture = makeFixture();
    const diff = await commitDiffOf(fixture, fixture.baseSha);
    expect(diff.mergeBase).toBe("");
    expect(diff.commit.parents).toEqual([]);
    expect(diff.commit.headline).toBe("base");
    expect(diff.files.every((file) => file.status === "A")).toBe(true);
    expect(diff.files.every((file) => file.oldContent === undefined)).toBe(true);
    const keep = diff.files.find((file) => file.path === "keep.txt");
    expect(keep?.newContent).toEqual(["one", "two", "three"]);
  });

  it("gives a merge commit's diff against its first parent, and keeps the message body", async () => {
    const fixture = makeFixture();
    git(fixture.origin, ["checkout", "--quiet", "main"]);
    writeFileSync(fixture.file("from-main.txt"), "main only\n");
    commit(fixture.origin, "main adds a file");
    git(fixture.origin, ["checkout", "--quiet", "feature"]);
    git(fixture.origin, ["merge", "--quiet", "--no-ff", "-m", "Merge main\n\nBrings the main file in.", "main"]);
    const merge = git(fixture.origin, ["rev-parse", "HEAD"]).trim();
    git(fixture.origin, ["update-ref", "refs/pull/7/head", merge]);

    const diff = await commitDiffOf(fixture, merge, merge);
    expect(diff.commit.parents).toHaveLength(2);
    expect(diff.mergeBase).toBe(fixture.headSha);
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([["from-main.txt", "A"]]);
    expect(diff.commit.headline).toBe("Merge main");
    expect(diff.commit.body).toBe("Brings the main file in.");
  });

  it("refuses a commit that is local but not an ancestor of the head", async () => {
    const fixture = makeFixture();
    git(fixture.origin, ["checkout", "--quiet", "main"]);
    writeFileSync(fixture.file("shared.txt"), "main moved on\n");
    const movedMain = commit(fixture.origin, "main moves");
    // The pull request diff fetches the base branch, which brings `movedMain` in.
    await diffOf(fixture);
    const failure = await commitDiffOf(fixture, movedMain).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommitNotInPrError);
    expect((failure as Error).message).toContain(`commit ${movedMain.slice(0, 7)} is not part of pull request #7 now`);
  });

  it("refuses a commit that is not local after the head fetch", async () => {
    const fixture = makeFixture();
    const failure = await commitDiffOf(fixture, "a".repeat(40)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommitNotInPrError);
  });

  it("refuses a malformed commit id before git runs", async () => {
    const fixture = makeFixture();
    for (const sha of ["--upload-pack=sh", "abc123", "", "z".repeat(40)]) {
      const failure = await commitDiffOf(fixture, sha).catch((error: unknown) => error);
      expect((failure as Error).message).toContain("commit id");
    }
    // Nothing was fetched: the bare repository was never created.
    expect(existsSync(fixture.bareRepo)).toBe(false);
  });
});

describe("input checks", () => {
  it("refuses a base branch name that git would read as an option", async () => {
    const fixture = makeFixture();
    for (const bad of ["--upload-pack=touch /tmp/pwned", "-x", "a..b", "refs/heads/x@{1}", "with space"]) {
      const failure = await computePrDiff({
        store: fixture.store,
        repo: "acme/app",
        number: 7,
        baseRef: bad,
        headSha: fixture.headSha,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("base branch name");
    }
    // No bare repository was created for a call that was refused at the door.
    expect(existsSync(fixture.bareRepo)).toBe(false);
  });

  it("takes a base branch name that carries a slash", async () => {
    const fixture = makeFixture();
    git(fixture.origin, ["branch", "release/1.0", fixture.baseSha]);
    const diff = await diffOf(fixture, { baseRef: "release/1.0" });
    expect(diff.baseRef).toBe("release/1.0");
    expect(diff.baseSha).toBe(fixture.baseSha);
    expect(diff.files.map((file) => file.path ?? file.oldPath)).toContain("keep.txt");
  });

  it("refuses a head value that is not a commit id", async () => {
    const fixture = makeFixture();
    const failure = await computePrDiff({
      store: fixture.store,
      repo: "acme/app",
      number: 7,
      baseRef: "main",
      headSha: "--upload-pack=sh",
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("commit id");
  });

  it("refuses a pull request number that is not a positive integer", async () => {
    const fixture = makeFixture();
    const failure = await computePrDiff({
      store: fixture.store,
      repo: "acme/app",
      number: 0,
      baseRef: "main",
      headSha: fixture.headSha,
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("pull request number");
  });

  it("refuses a repository name the store cannot use as a remote", async () => {
    const app = makeFixture().origin;
    const storeRoot = join(root, "gh-repo-unsafe");
    mkdirSync(storeRoot, { recursive: true });
    const store = createRepoStore({
      root: storeRoot,
      remoteUrl: () => app,
      read: async () => ({ fork: false, size: 10 }),
    });
    const report = await store.reconcile(["-n/app"]);
    expect(report.failures).toHaveLength(1);
    expect(existsSync(storeRoot)).toBe(true);
    // The owner directory was never created for a name git would read as an option.
    expect(existsSync(join(storeRoot, "-n"))).toBe(false);
    await expect(store.prepare("-n/app")).rejects.toThrow("-n/app");
  });
});

describe("parseUnifiedDiff", () => {
  it("does not mistake the trailing empty line or the no-newline marker for a hunk line", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " first",
      "-second",
      "+SECOND",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { t: "ctx", s: "first" },
      { t: "del", s: "second" },
      { t: "add", s: "SECOND" },
    ]);
    expect(files[0]?.additions).toBe(1);
    expect(files[0]?.deletions).toBe(1);
  });

  it("keeps an empty context line as one context line", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " first",
      " ",
      "-x",
      "+y",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(text);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { t: "ctx", s: "first" },
      { t: "ctx", s: "" },
      { t: "del", s: "x" },
      { t: "add", s: "y" },
    ]);
  });
});
