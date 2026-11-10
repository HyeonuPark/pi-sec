import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RepoInfo } from "../../src/extensions/github-pr/network.ts";
import {
  createRepoStore,
  DiskLimitError,
  treeBytes,
  type ReconcileReport,
  type RepoStore,
} from "../../src/extensions/github-pr/store.ts";

/**
 * The bare repository store, against local git repositories.
 *
 * Every remote here is a directory on this machine, created by the test, so
 * nothing reaches GitHub. `remoteUrl` is what the daemon fills with
 * `https://github.com/<owner>/<repo>.git` and what these tests fill with a path.
 */

const root = mkdtempSync(join(tmpdir(), "gh-repo-store-"));
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

/** A repository with one commit on `main`, usable as a remote. */
function makeOrigin(label: string): string {
  sequence += 1;
  const dir = join(root, "origins", `${label}-${sequence}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main", "."]);
  writeFileSync(join(dir, "readme.md"), `# ${label}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "first"]);
  return dir;
}

/** A store over a fresh `gh-repo` root, with the given local remotes. */
function makeStore(options: {
  repos: Record<string, RepoInfo>;
  origins: Record<string, string>;
  diskLimitMegabytes?: number | (() => number);
  reconcileIntervalMs?: number;
  now?: () => number;
}): { store: RepoStore; storeRoot: string } {
  sequence += 1;
  const storeRoot = join(root, "gh-repo", String(sequence));
  mkdirSync(storeRoot, { recursive: true });
  const store = createRepoStore({
    root: storeRoot,
    ...(options.diskLimitMegabytes === undefined ? {} : { diskLimitMegabytes: options.diskLimitMegabytes }),
    ...(options.reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs: options.reconcileIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    remoteUrl: (slug) => options.origins[slug] ?? join(root, "origins", "missing"),
    read: async (owner, repo) => {
      const value = options.repos[`${owner}/${repo}`.toLowerCase()];
      if (value === undefined) throw new Error(`HTTP 404: Not Found for ${owner}/${repo}`);
      return value;
    },
  });
  return { store, storeRoot };
}

const plain = (size: number): RepoInfo => ({ fork: false, size });
const forkOf = (source: string, size: number): RepoInfo => {
  const at = source.indexOf("/");
  return { fork: true, source: { owner: source.slice(0, at), name: source.slice(at + 1) }, size };
};

function remotesOf(bareRepo: string): string[] {
  return git(bareRepo, ["remote"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

describe("layout", () => {
  it("creates one lowercase bare repository per network, private, with a remote per member", async () => {
    const app = makeOrigin("app");
    const mine = makeOrigin("fork");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "me/app": mine },
      repos: { "acme/app": plain(1000), "me/app": forkOf("acme/app", 20) },
    });

    const report = await store.reconcile(["Acme/App", "me/app"]);
    expect(report.networks).toBe(1);
    expect(report.remotesAdded).toBe(2);

    const bareRepo = join(storeRoot, "acme", "app.git");
    expect(existsSync(bareRepo)).toBe(true);
    expect(remotesOf(bareRepo)).toEqual(["acme/app", "me/app"]);
    expect(git(bareRepo, ["remote", "get-url", "me/app"]).trim()).toBe(mine);

    // 0700 on the root, on the owner directory and on the bare repository.
    expect(statSync(storeRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(storeRoot, "acme")).mode & 0o777).toBe(0o700);
    expect(statSync(bareRepo).mode & 0o777).toBe(0o700);
    // Nothing was written outside the expected two directories.
    expect(existsSync(join(storeRoot, "me"))).toBe(false);
  });

  it("answers the handle of a mapped repository and nothing else", async () => {
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": makeOrigin("app") },
      repos: { "acme/app": plain(10) },
    });
    await store.reconcile(["acme/app"]);

    const handle = store.forRepo("ACME/APP");
    expect(handle).toEqual({
      slug: "acme/app",
      root: "acme/app",
      path: join(storeRoot, "acme", "app.git"),
      remote: "acme/app",
    });
    expect(store.forRepo("acme/other")).toBeUndefined();
    expect(store.mappedRepos().map((entry) => entry.slug)).toEqual(["acme/app"]);
  });
});

describe("reconcile", () => {
  it("removes a remote that dropped out of the list, and keeps the others", async () => {
    const app = makeOrigin("app");
    const fork = makeOrigin("fork");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "me/app": fork },
      repos: { "acme/app": plain(1000), "me/app": forkOf("acme/app", 20) },
    });
    await store.reconcile(["acme/app", "me/app"]);

    const second = await store.reconcile(["acme/app"]);
    expect(second.remotesRemoved).toBe(1);
    expect(remotesOf(join(storeRoot, "acme", "app.git"))).toEqual(["acme/app"]);
    expect(second.removedRepos).toEqual([]);
  });

  it("removes a bare repository whose last remote is gone, with its folder", async () => {
    const app = makeOrigin("app");
    const other = makeOrigin("other");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "acme/other": other },
      repos: { "acme/app": plain(10), "acme/other": plain(10) },
    });
    await store.reconcile(["acme/app", "acme/other"]);
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(true);

    const second = await store.reconcile(["acme/other"]);
    expect(second.remotesRemoved).toBe(1);
    expect(second.removedRepos).toEqual(["acme/app"]);
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(false);
    expect(existsSync(join(storeRoot, "acme", "other.git"))).toBe(true);
  });

  it("removes a bare repository that has no remote at all, such as one an interrupted fetch left", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(10) },
    });
    await store.reconcile(["acme/app"]);

    const leftover = join(storeRoot, "acme", "leftover.git");
    mkdirSync(leftover, { recursive: true });
    git(leftover, ["init", "--bare", "--quiet", "."]);

    const second = await store.reconcile(["acme/app"]);
    expect(second.removedRepos).toEqual(["acme/leftover"]);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(true);
  });

  it("moves a repository to another network: remote out of the old, into the new", async () => {
    const app = makeOrigin("app");
    const base = makeOrigin("base");
    const mine = makeOrigin("fork");
    const repos: Record<string, RepoInfo> = { "acme/app": plain(1000), "me/app": forkOf("acme/app", 20) };
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "zed/base": base, "me/app": mine },
      repos,
    });
    await store.reconcile(["acme/app", "me/app"]);

    // The same name now reports a different source: a different network.
    repos["me/app"] = forkOf("zed/base", 20);
    const second = await store.reconcile(["acme/app", "me/app"]);

    expect(second.remotesRemoved).toBe(1);
    expect(remotesOf(join(storeRoot, "acme", "app.git"))).toEqual(["acme/app"]);
    expect(remotesOf(join(storeRoot, "zed", "base.git"))).toEqual(["me/app"]);
    expect(store.forRepo("me/app")?.root).toBe("zed/base");
  });

  it("skips a repository it cannot read, keeps what it had, and reports the error", async () => {
    const app = makeOrigin("app");
    const repos: Record<string, RepoInfo> = { "acme/app": plain(10) };
    const { store, storeRoot } = makeStore({ origins: { "acme/app": app }, repos });
    await store.reconcile(["acme/app"]);

    // The next read fails: the remote stays, the folder stays, the report says why.
    delete repos["acme/app"];
    const second: ReconcileReport = await store.reconcile(["acme/app"]);
    expect(second.failures).toEqual([{ repo: "acme/app", message: "HTTP 404: Not Found for acme/app" }]);
    expect(second.remotesRemoved).toBe(0);
    expect(remotesOf(join(storeRoot, "acme", "app.git"))).toEqual(["acme/app"]);
  });

  it("removes no folder while a read failed, because the mapping is then incomplete", async () => {
    const app = makeOrigin("app");
    const other = makeOrigin("other");
    const repos: Record<string, RepoInfo> = { "acme/app": plain(10), "acme/other": plain(10) };
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "acme/other": other },
      repos,
    });
    await store.reconcile(["acme/app", "acme/other"]);
    const appRepo = join(storeRoot, "acme", "app.git");
    expect(existsSync(appRepo)).toBe(true);

    // `acme/app` is dropped from the list and `acme/other` cannot be read. The
    // remote goes, the folder stays: the failed read might have been the one
    // that would have said where `acme/app` moved to.
    delete repos["acme/other"];
    const second = await store.reconcile(["acme/other"]);
    expect(second.failures).toHaveLength(1);
    expect(existsSync(appRepo)).toBe(true);
    expect(remotesOf(appRepo)).toEqual([]);

    // The next reconcile reads both, and the empty folder goes.
    repos["acme/other"] = plain(10);
    const third = await store.reconcile(["acme/other"]);
    expect(third.removedRepos).toEqual(["acme/app"]);
    expect(existsSync(appRepo)).toBe(false);
  });

  it("does not create a bare repository for a repository only one read failed on", async () => {
    const { store, storeRoot } = makeStore({ origins: {}, repos: {} });
    const report = await store.reconcile(["gone/missing"]);

    expect(report.failures).toHaveLength(1);
    expect(report.networks).toBe(0);
    expect(existsSync(join(storeRoot, "gone"))).toBe(false);
  });

  it("leaves a path outside the root alone, including a symbolic link named like a bare repository", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(10) },
    });
    await store.reconcile(["acme/app"]);

    // A file directly under the root, a stray directory, and a link to a bare
    // repository placed one level deep where pruning looks.
    const outside = join(root, "outside.git");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep"), "keep\n");
    writeFileSync(join(storeRoot, "keep.txt"), "keep\n");
    mkdirSync(join(storeRoot, "acme", "stray"), { recursive: true });
    execFileSync("ln", ["-s", outside, join(storeRoot, "acme", "link.git")]);

    await store.reconcile(["acme/app"]);

    expect(existsSync(join(storeRoot, "keep.txt"))).toBe(true);
    expect(existsSync(join(storeRoot, "acme", "stray"))).toBe(true);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(existsSync(join(storeRoot, "acme", "link.git"))).toBe(true);
  });
});

describe("reconcileIfDue", () => {
  it("runs on the first call, then only for a changed list or an expired interval", async () => {
    let clock = 1_000_000;
    const app = makeOrigin("app");
    const other = makeOrigin("other");
    const { store } = makeStore({
      origins: { "acme/app": app, "acme/other": other },
      repos: { "acme/app": plain(10), "acme/other": plain(10) },
      reconcileIntervalMs: 60_000,
      now: () => clock,
    });

    expect(await store.reconcileIfDue(["acme/app"])).toBeDefined();
    expect(await store.reconcileIfDue(["acme/app"])).toBeUndefined();

    clock += 30_000;
    expect(await store.reconcileIfDue(["ACME/APP"])).toBeUndefined();

    // A changed list is due at once, whatever the clock says.
    expect(await store.reconcileIfDue(["acme/app", "acme/other"])).toBeDefined();
    expect(await store.reconcileIfDue(["acme/app", "acme/other"])).toBeUndefined();

    clock += 60_000;
    expect(await store.reconcileIfDue(["acme/app", "acme/other"])).toBeDefined();
  });
});

describe("disk limit", () => {
  it("refuses a network's first fetch when the root plus the estimate passes the limit", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(8192) },
      diskLimitMegabytes: 4,
    });

    // The reconcile reports the refusal and keeps going: the guard is one
    // network's answer, not a reason to stop.
    const report = await store.reconcile(["acme/app"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.repo).toBe("acme/app");
    expect(report.failures[0]?.message).toContain("4 MB");
    // The refusal happened before `git init`: no folder was created.
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(false);

    // The diff that asks for it gets the error with the numbers the route needs.
    const failure = await store.prepare("acme/app").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiskLimitError);
    const limit = failure as DiskLimitError;
    expect(limit.currentMegabytes).toBe(0);
    expect(limit.estimateMegabytes).toBe(8);
    expect(limit.limitMegabytes).toBe(4);
    expect(limit.toPayload()).toEqual({
      error: "disk_limit",
      currentMegabytes: 0,
      estimateMegabytes: 8,
      limitMegabytes: 4,
    });
  });

  it("reads the limit again for every first-fetch check, so a changed value applies at once", async () => {
    const app = makeOrigin("app");
    // A cap the operator raises by reloading the config: the store holds the
    // function, not its answer, so the next check reads the new value.
    let limit = 4;
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(8192) },
      diskLimitMegabytes: () => limit,
    });

    const refused = await store.prepare("acme/app").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DiskLimitError);
    expect((refused as DiskLimitError).limitMegabytes).toBe(4);
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(false);

    limit = 16;
    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(join(storeRoot, "acme", "app.git"));
    expect(remotesOf(handle.path)).toEqual(["acme/app"]);
  });

  it("prepares a network far above any cap when the limit is 0", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      // About 100 GB by GitHub's estimate.
      repos: { "acme/app": plain(100 * 1024 * 1024) },
      diskLimitMegabytes: 0,
    });

    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(join(storeRoot, "acme", "app.git"));
    expect(remotesOf(handle.path)).toEqual(["acme/app"]);
  });

  it("refuses a network while the limit is 4 and allows it after the limit becomes 0", async () => {
    const app = makeOrigin("app");
    let limit = 4;
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(8192) },
      diskLimitMegabytes: () => limit,
    });

    const refused = await store.prepare("acme/app").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DiskLimitError);
    expect(existsSync(join(storeRoot, "acme", "app.git"))).toBe(false);

    limit = 0;
    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(join(storeRoot, "acme", "app.git"));
  });

  it("still makes the other networks ready when one is refused", async () => {
    const app = makeOrigin("app");
    const big = makeOrigin("big");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "acme/big": big },
      repos: { "acme/app": plain(1), "acme/big": plain(8192) },
      diskLimitMegabytes: 4,
    });

    const report = await store.reconcile(["acme/app", "acme/big"]);
    expect(report.failures.map((failure) => failure.repo)).toEqual(["acme/big"]);
    expect(remotesOf(join(storeRoot, "acme", "app.git"))).toEqual(["acme/app"]);
    expect(existsSync(join(storeRoot, "acme", "big.git"))).toBe(false);
  });

  it("refuses a bare repository left behind without a ref, and allows one with a ref", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(8192) },
      diskLimitMegabytes: 4,
    });

    // An earlier attempt created the folder and stopped: no refs, so the guard
    // still applies and this network is not "already fetched".
    const bareRepo = join(storeRoot, "acme", "app.git");
    mkdirSync(bareRepo, { recursive: true });
    git(bareRepo, ["init", "--bare", "--quiet"]);
    await expect(store.prepare("acme/app")).rejects.toBeInstanceOf(DiskLimitError);

    // One fetch lands a ref: from then on the network is never refused.
    git(bareRepo, ["remote", "add", "acme/app", app]);
    git(bareRepo, ["fetch", "acme/app", "main"]);
    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(bareRepo);
    expect(remotesOf(bareRepo)).toEqual(["acme/app"]);
  });

  it("counts what the root already holds, not the estimate alone", async () => {
    const app = makeOrigin("app");
    const other = makeOrigin("other");
    // 4096 KB is 4 MB, which is not over the 4 MB limit by itself.
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app, "acme/other": other },
      repos: { "acme/app": plain(1), "acme/other": plain(4096) },
      diskLimitMegabytes: 4,
    });

    // A network that fits comes first and puts something on disk. A bare
    // repository of one commit is a few tens of kilobytes, so the test adds a
    // 1.5 MiB file: what the guard reads is the whole root, whatever wrote it.
    await store.prepare("acme/app");
    writeFileSync(join(storeRoot, "filler.bin"), Buffer.alloc(1536 * 1024));
    const used = await store.usage();
    expect(used.bytes).toBe(await treeBytes(storeRoot));
    // The guard reads whole megabytes, and `usage` reports the exact fraction.
    expect(Math.round(used.megabytes)).toBe(2);
    expect(used.megabytes).toBeLessThan(4);

    // The estimate is under the limit and the sum passes it, so the sum is what
    // the guard reads.
    const failure = await store.prepare("acme/other").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DiskLimitError);
    const limit = failure as DiskLimitError;
    expect(limit.estimateMegabytes).toBe(4);
    expect(limit.currentMegabytes + limit.estimateMegabytes).toBeGreaterThan(limit.limitMegabytes);
    expect(limit.currentMegabytes).toBeGreaterThan(0);
  });
});

describe("lock", () => {
  it("runs one git task at a time in one bare repository, and independent ones in parallel", async () => {
    const { store, storeRoot } = makeStore({ origins: {}, repos: {} });
    const first = join(storeRoot, "a", "one.git");
    const second = join(storeRoot, "a", "two.git");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const events: string[] = [];
    // Each task ends when the test says so, so the order does not depend on wall time.
    const gate = (): { open: () => void; opened: Promise<void> } => {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const task = (label: string, hold: Promise<void>, started: () => void, ended: () => void) => async (): Promise<void> => {
      events.push(`${label}:start`);
      started();
      await hold;
      events.push(`${label}:end`);
      ended();
    };
    const holdA = gate();
    const holdC = gate();
    const startedA = gate();
    const startedC = gate();
    const endedC = gate();

    const all = Promise.all([
      store.withLock(first, task("a", holdA.opened, startedA.open, () => {})),
      store.withLock(first, task("b", Promise.resolve(), () => {}, () => {})),
      store.withLock(second, task("c", holdC.opened, startedC.open, endedC.open)),
    ]);
    await Promise.all([startedA.opened, startedC.opened]);
    // The other repository's task finishes while the first task still holds its lock.
    holdC.open();
    await endedC.opened;
    expect(events).not.toContain("b:start");
    holdA.open();
    await all;

    // The second task in the first repository waits for the first to finish; the
    // task in the other repository does not.
    expect(events.indexOf("a:end")).toBeLessThan(events.indexOf("b:start"));
    expect(events.indexOf("c:end")).toBeLessThan(events.indexOf("a:end"));
  });

  it("releases the lock when a task throws", async () => {
    const { store, storeRoot } = makeStore({ origins: {}, repos: {} });
    const path = join(storeRoot, "a", "one.git");
    mkdirSync(path, { recursive: true });

    await expect(
      store.withLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.withLock(path, async () => "ok")).resolves.toBe("ok");
  });
});

describe("prepare", () => {
  it("reads a network on the spot when a diff arrives before a reconcile", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(10) },
    });

    const handle = await store.prepare("acme/app");
    expect(handle).toEqual({
      slug: "acme/app",
      root: "acme/app",
      path: join(storeRoot, "acme", "app.git"),
      remote: "acme/app",
    });
    expect(remotesOf(handle.path)).toEqual(["acme/app"]);
  });

  it("says which repository could not be read instead of creating a bare repository for it", async () => {
    const { store, storeRoot } = makeStore({ origins: {}, repos: {} });
    await expect(store.prepare("gone/missing")).rejects.toThrow("gone/missing: HTTP 404");
    expect(existsSync(join(storeRoot, "gone"))).toBe(false);
  });

  it("is idempotent: a second prepare changes nothing and keeps the same remote", async () => {
    const app = makeOrigin("app");
    const { store } = makeStore({ origins: { "acme/app": app }, repos: { "acme/app": plain(10) } });
    const first = await store.prepare("acme/app");
    const second = await store.prepare("acme/app");
    expect(second).toEqual(first);
    expect(remotesOf(first.path)).toEqual(["acme/app"]);
  });
});

describe("an interrupted attempt", () => {
  it("initializes a bare-repository folder that holds no repository at all", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(10) },
    });
    const bareRepo = join(storeRoot, "acme", "app.git");
    mkdirSync(bareRepo, { recursive: true });
    writeFileSync(join(bareRepo, "half-written"), "x");

    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(bareRepo);
    expect(remotesOf(bareRepo)).toEqual(["acme/app"]);
    // A file the interrupted attempt left behind is not part of the repository
    // and is left alone: this code removes only what a reconcile decides to.
    expect(existsSync(join(bareRepo, "half-written"))).toBe(true);
  });
});

describe("a store that sits inside another repository", () => {
  it("initializes its own bare repository instead of borrowing the parent's", async () => {
    // The root is a plain directory inside a repository (the test's own temporary
    // tree is not, so one is made here). `git rev-parse` would answer for the
    // parent; the folder check must not.
    const container = join(root, "container");
    mkdirSync(container, { recursive: true });
    git(container, ["init", "--quiet", "-b", "main", "."]);
    writeFileSync(join(container, "x.txt"), "x\n");
    git(container, ["add", "--all"]);
    git(container, ["commit", "--quiet", "-m", "container"]);

    const app = makeOrigin("app");
    const storeRoot = join(container, "nested-gh-repo");
    mkdirSync(storeRoot, { recursive: true });
    const store = createRepoStore({
      root: storeRoot,
      remoteUrl: () => app,
      read: async () => ({ fork: false, size: 10 }),
    });
    const bareRepo = join(storeRoot, "acme", "app.git");
    mkdirSync(bareRepo, { recursive: true });

    const handle = await store.prepare("acme/app");
    expect(handle.path).toBe(bareRepo);
    // Its own repository, not the container's: it has its own objects and HEAD.
    expect(existsSync(join(bareRepo, "HEAD"))).toBe(true);
    expect(remotesOf(bareRepo)).toEqual(["acme/app"]);
    // And it is a bare repository git itself agrees with.
    expect(git(bareRepo, ["rev-parse", "--is-bare-repository"]).trim()).toBe("true");
  });
});

describe("permissions", () => {
  it("keeps a bare repository at 0700 even when the folder was created world-readable", async () => {
    const app = makeOrigin("app");
    const { store, storeRoot } = makeStore({
      origins: { "acme/app": app },
      repos: { "acme/app": plain(10) },
    });
    const ownerDir = join(storeRoot, "acme");
    mkdirSync(ownerDir, { recursive: true });
    chmodSync(ownerDir, 0o755);

    await store.prepare("acme/app");
    expect(statSync(ownerDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(ownerDir, "app.git")).mode & 0o777).toBe(0o700);
  });
});
