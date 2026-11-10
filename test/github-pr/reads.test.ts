/**
 * Reading the pull request pages' data: one pull request's detail, the fork
 * network, and the list cache and its poll.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGhClient, createGhReader, GhError } from "../../src/extensions/github-pr/gh.ts";
import { fetchPrDetail, fetchPrRefs, shapeDetail, shapeReactions } from "../../src/extensions/github-pr/detail.ts";
import { fakeGhFixture, writeResponses } from "./fake-gh-helpers.ts";

const RESPONSES = fileURLToPath(new URL("../fixtures/github-pr/responses", import.meta.url));
import { createPrListCache, type ListCacheTimers } from "../../src/extensions/github-pr/list-cache.ts";
import type { PrListPayload } from "../../src/extensions/github-pr/list.ts";
import { dedupeRepos, isSafeNamePart, isSafeSlug, repoSlug, resolveNetworks, splitRepoSlug, type RepoInfo, type RepoInfoReader } from "../../src/extensions/github-pr/network.ts";

describe("detail.test.ts", () => {
  /**
   * The pull request detail, as the page reads it.
   *
   * The fake `gh` answers the real query text with `test/fixtures/github-pr/
   * responses/pr-detail.json`, so one test covers the query, the parse and the
   * translation; the unit tests below cover the parts of the translation a fixture
   * would have to grow a lot to reach.
   */

  describe("pr detail: through the fake gh", () => {
    it("shapes the pull request, its comments, reviews, threads and checks", async () => {
      const found = await fakeGhFixture();
      const reader = createGhReader(createGhClient(found.clientOptions));

      const pr = await fetchPrDetail(reader, { owner: "acme", name: "widgets" }, 10);

      expect(pr.id).toBe("PR_node_10");
      expect(pr.number).toBe(10);
      expect(pr.title).toBe("Add widget cache");
      expect(pr.state).toBe("OPEN");
      expect(pr.author).toBe("example-other");
      expect(pr.additions).toBe(120);
      expect(pr.deletions).toBe(8);
      expect(pr.changedFiles).toBe(4);
      expect(pr.baseRefName).toBe("main");
      expect(pr.headRefOid).toBe("1111111111111111111111111111111111111111");
      expect(pr.labels).toEqual([
        { name: "cache", color: "0e8a16" },
        { name: "reviewed", color: "1d76db" },
      ]);

      // Two reactions had a count; the third group is a reaction nobody used.
      expect(pr.reactions).toEqual([
        { content: "THUMBS_UP", count: 2, mine: true },
        { content: "ROCKET", count: 1, mine: false },
      ]);

      expect(pr.comments).toHaveLength(1);
      expect(pr.comments[0]).toEqual({
        id: "IC_1",
        author: "example-other",
        body: "First look, @example-user.",
        createdAt: "2026-10-27T10:00:00Z",
        url: "https://github.example.com/acme/widgets/pull/10#issuecomment-1",
        viewerCanUpdate: true,
        viewerDidAuthor: true,
        reactions: [{ content: "THUMBS_UP", count: 1, mine: false }],
      });

      // The description carries both edit flags; a flag the answer leaves out is false.
      expect(pr.viewerCanUpdate).toBe(true);
      expect(pr.viewerDidAuthor).toBe(false);
      expect(pr.reviews[0]).toMatchObject({ viewerCanUpdate: false, viewerDidAuthor: false });
      expect(pr.threads[0]?.comments[0]).toMatchObject({ viewerCanUpdate: false, viewerDidAuthor: false });

      expect(pr.reviews).toHaveLength(1);
      expect(pr.reviews[0]?.reviewState).toBe("COMMENTED");
      expect(pr.reviews[0]?.author).toBe("example-user");

      // Two threads: the first carries the hunk of its first comment, the second is
      // a resolved, outdated thread with no comments left.
      expect(pr.threads).toHaveLength(3);
      expect(pr.threads[0]).toMatchObject({
        id: "PRRT_1",
        isResolved: false,
        viewerCanResolve: true,
        isOutdated: false,
        path: "src/cache.ts",
        line: 42,
        startLine: 40,
        originalLine: 41,
        originalStartLine: 39,
        diffSide: "RIGHT",
        diffHunk: "@@ -39,7 +39,9 @@ export function read(key: string) {",
      });
      expect(pr.threads[0]?.comments[0]?.id).toBe("PRRC_1");
      expect(pr.threads[1]).toMatchObject({ id: "PRRT_2", isResolved: true, viewerCanResolve: false, isOutdated: true, diffHunk: null });
      expect(pr.threads[1]?.comments).toEqual([]);
      // subjectType: LINE as sent, LINE when missing, FILE for a comment on a whole file.
      expect(pr.threads.map((thread) => thread.subjectType)).toEqual(["LINE", "LINE", "FILE"]);
      expect(pr.threads[2]).toMatchObject({ id: "PRRT_3", path: "src/added.ts", line: 1, diffHunk: "" });

      // A check run that finished shows its conclusion, one still running shows its
      // status, and a status context shows its state.
      expect(pr.ciState).toBe("FAILURE");
      expect(pr.checks).toEqual([
        { name: "unit", status: "SUCCESS", url: "https://ci.example.com/1" },
        { name: "lint", status: "IN_PROGRESS", url: "https://ci.example.com/2" },
        { name: "coverage", status: "FAILURE", url: "https://ci.example.com/3" },
      ]);
    });

    it("reports a missing pull request as an error naming the number", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fake-gh-missing-"));
      await writeFile(
        join(dir, "routes.json"),
        JSON.stringify({ routes: [{ contains: ["statusCheckRollup"], file: "missing.json" }] }),
      );
      await writeFile(join(dir, "missing.json"), JSON.stringify({ json: { data: { repository: { pullRequest: null } } } }));
      const found = await fakeGhFixture({ responsesDir: dir });
      const reader = createGhReader(createGhClient(found.clientOptions));

      const error = await fetchPrDetail(reader, { owner: "acme", name: "widgets" }, 404).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GhError);
      expect((error as GhError).message).toBe("PR #404 not found");
    });
  });

  describe("pr detail: shaping", () => {
    it("keeps reaction order and drops the groups nobody used", () => {
      expect(
        shapeReactions([
          { content: "HEART", viewerHasReacted: false, reactors: { totalCount: 0 } },
          { content: "EYES", viewerHasReacted: true, reactors: { totalCount: 3 } },
        ]),
      ).toEqual([{ content: "EYES", count: 3, mine: true }]);
      expect(shapeReactions(null)).toEqual([]);
    });

    it("shapes the commit list in order, with the login or else the author name", async () => {
      const found = await fakeGhFixture();
      const reader = createGhReader(createGhClient(found.clientOptions));
      const pr = await fetchPrDetail(reader, { owner: "acme", name: "widgets" }, 10);
      expect(pr.totalCommits).toBe(3);
      expect(pr.commits.map((commit) => [commit.abbreviatedOid, commit.headline, commit.author])).toEqual([
        ["2222222", "Add the cache", "example-other"],
        ["3333333", "Fix a typo", "No Account"],
        ["1111111", "Use the cache in read()", "example-other"],
      ]);
      expect(pr.commits[2]?.oid).toBe(pr.headRefOid);
      expect(pr.commits[0]?.committedDate).toBe("2026-10-27T09:10:00Z");
      expect(pr.commits[0]?.url).toContain("/commit/2222222");
      // The fake gh log holds only the one read: no mutation, no non-GET call.
      const calls = await found.calls();
      expect(calls).toHaveLength(1);
      for (const call of calls) {
        expect(call.args.join(" ")).not.toMatch(/\bmutation\b/i);
        expect(call.args).not.toContain("--method");
        expect(call.args).not.toContain("-X");
      }
    });

    it("reports more commits than rows when GitHub has more than it was asked for", async () => {
      const body = await readFile(join(RESPONSES, "pr-detail-many-commits.json"), "utf8");
      const dir = await writeResponses({ "1.json": JSON.parse(body) });
      const found = await fakeGhFixture({ responsesDir: dir });
      const reader = createGhReader(createGhClient(found.clientOptions));
      const pr = await fetchPrDetail(reader, { owner: "acme", name: "widgets" }, 10);
      expect(pr.commits).toHaveLength(2);
      expect(pr.totalCommits).toBe(130);
    });

    it("gives an empty commit list and zero when the answer has no commitList", () => {
      const shaped = shapeDetail({ number: 5 });
      expect(shaped.commits).toEqual([]);
      expect(shaped.totalCommits).toBe(0);
    });

    it("fills the fields an empty answer leaves out, instead of throwing", () => {
      const shaped = shapeDetail({ number: 5 });
      expect(shaped).toMatchObject({
        number: 5,
        title: "",
        body: null,
        author: null,
        labels: [],
        comments: [],
        reviews: [],
        threads: [],
        ciState: null,
        checks: [],
      });
    });

    it("reads the head commit's rollup only, not an older commit's", () => {
      const shaped = shapeDetail({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
              },
            },
            {
              commit: {
                statusCheckRollup: { state: "FAILURE", contexts: { nodes: [] } },
              },
            },
          ],
        },
      });
      expect(shaped.ciState).toBe("SUCCESS");
    });
  });

  describe("pr refs: through the fake gh", () => {
    it("reads the base, the head and the title of one pull request", async () => {
      const found = await fakeGhFixture();
      const reader = createGhReader(createGhClient(found.clientOptions));

      expect(await fetchPrRefs(reader, { owner: "acme", name: "widgets" }, 10)).toEqual({
        id: "PR_node_10",
        number: 10,
        title: "Add widget cache",
        baseRefName: "main",
        headRefName: "feature/widget-cache",
        headRefOid: "1111111111111111111111111111111111111111",
      });
    });
  });
});

describe("list-cache.test.ts", () => {
  /**
   * The list cache and its poll, driven by hand.
   *
   * The clock is a fake: `settle` runs the microtask queue, and `tick` fires the
   * one timer the cache holds wait for. So a test never waits for a real interval
   * and never leaves a timer behind.
   */

  function payload(viewer: string, numbers: readonly number[] = []): PrListPayload {
    return {
      viewer,
      repos: [{ repo: "acme/widgets" }],
      sections: [
        {
          key: "opened",
          title: "Opened",
          prs: numbers.map((number) => ({
            number,
            title: `PR ${number}`,
            url: `https://github.example.com/acme/widgets/pull/${number}`,
            isDraft: false,
            author: viewer,
            updatedAt: "2026-10-30T00:00:00Z",
            headRefName: "b",
            baseRefName: "main",
            reviewDecision: null,
            labels: [],
            ciState: null,
            repo: "acme/widgets",
          })),
        },
      ],
    };
  }

  /** A timer queue with one slot: the cache schedules one wait at a time. */
  function fakeTimers() {
    const pending: { handler: () => void; ms: number }[] = [];
    const delays: number[] = [];
    const timers: ListCacheTimers = {
      set(handler, ms) {
        delays.push(ms);
        pending.push({ handler, ms });
        return handler;
      },
      clear(handle) {
        const index = pending.findIndex((entry) => entry.handler === handle);
        if (index >= 0) pending.splice(index, 1);
      },
    };
    return {
      timers,
      delays,
      waiting: () => pending.length,
      async tick() {
        const next = pending.shift();
        if (next === undefined) throw new Error("no timer is waiting");
        next.handler();
        await settle();
      },
    };
  }

  /** Let every pending promise callback run. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 8; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  describe("pr list cache", () => {
    it("fetches once for a cold read and serves the copy afterwards", async () => {
      let reads = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          return payload("first");
        },
        interval: 300,
      });

      expect(cache.current()).toBeUndefined();
      expect((await cache.load()).viewer).toBe("first");
      expect((await cache.load()).viewer).toBe("first");
      expect(reads).toBe(1);
    });

    it("reads GitHub on a forced refresh and calls the change callback only when the payload differs", async () => {
      let reads = 0;
      let changes = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          return payload("viewer", reads >= 3 ? [1] : []);
        },
        interval: 300,
        onChange: () => {
          changes += 1;
        },
      });

      // Filling an empty cache is not a change: nobody saw the old copy.
      await cache.load();
      expect(changes).toBe(0);

      await cache.refresh();
      expect(changes).toBe(0);

      const changed = await cache.refresh();
      expect(changed.sections[0]?.prs).toHaveLength(1);
      expect(changes).toBe(1);
      expect(reads).toBe(3);
    });

    it("leaves the previous copy in place and rejects when a forced refresh fails", async () => {
      let reads = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          if (reads === 2) throw new GhError("HTTP 502");
          return payload("kept");
        },
        interval: 300,
      });

      const first = await cache.load();
      await expect(cache.refresh()).rejects.toBeInstanceOf(GhError);
      expect(cache.current()).toBe(first);
      expect((await cache.load()).viewer).toBe("kept");
    });

    it("runs one cycle at a time and counts the next wait from the end of the previous one", async () => {
      const clock = fakeTimers();
      let reads = 0;
      let release: (() => void) | undefined;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          if (reads === 2) {
            // The second read hangs until the test lets go, which is how a slow
            // GitHub looks to the loop.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return payload("viewer");
        },
        interval: () => 90,
        timers: clock.timers,
      });

      cache.start();
      await settle();
      // The first read at start, then a wait of one interval.
      expect(reads).toBe(1);
      expect(clock.waiting()).toBe(1);
      expect(clock.delays).toEqual([90_000]);

      await clock.tick();
      // The timer fired and the second read started; while it hangs, no third read
      // and no new timer exist.
      expect(reads).toBe(2);
      expect(clock.waiting()).toBe(0);

      release?.();
      await settle();
      expect(clock.waiting()).toBe(1);
      expect(clock.delays).toEqual([90_000, 90_000]);
      cache.stop();
    });

    it("swallows a poll failure and tries again on the next cycle", async () => {
      const clock = fakeTimers();
      let reads = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          if (reads === 1) return payload("kept");
          if (reads === 2) throw new GhError("HTTP 502");
          return payload("kept", [2]);
        },
        interval: 60,
        timers: clock.timers,
      });

      cache.start();
      await settle();
      expect(reads).toBe(1);

      await clock.tick();
      expect(reads).toBe(2);
      expect(cache.current()?.viewer).toBe("kept");
      // The failed cycle still schedules the next one.
      expect(clock.waiting()).toBe(1);

      await clock.tick();
      expect(reads).toBe(3);
      expect(cache.current()?.sections[0]?.prs).toHaveLength(1);
      cache.stop();
    });

    it("stops the timer, and a cycle that ends after stop schedules nothing", async () => {
      const clock = fakeTimers();
      let release: (() => void) | undefined;
      let reads = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return payload("viewer");
        },
        interval: 60,
        timers: clock.timers,
      });

      cache.start();
      await settle();
      expect(cache.polling).toBe(true);
      // The first read is still running, so nothing is scheduled yet.
      expect(clock.waiting()).toBe(0);

      cache.stop();
      expect(cache.polling).toBe(false);
      release?.();
      await settle();
      expect(clock.waiting()).toBe(0);
      expect(reads).toBe(1);

      // A stopped cache serves what it has and does not read on its own.
      await cache.load();
      expect(reads).toBe(1);
    });

    it("serializes a forced refresh behind a running read, so two reads never overlap", async () => {
      const clock = fakeTimers();
      let running = 0;
      let peak = 0;
      const releases: (() => void)[] = [];
      const cache = createPrListCache({
        fetch: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          running -= 1;
          return payload("viewer");
        },
        interval: 60,
        timers: clock.timers,
      });

      cache.start();
      await settle();
      // The start's read is running; a forced refresh asked for now waits its turn.
      const forced = cache.refresh();
      await settle();
      expect(peak).toBe(1);

      releases.shift()?.();
      await settle();
      expect(peak).toBe(1);
      releases.shift()?.();
      await expect(forced).resolves.toMatchObject({ viewer: "viewer" });
      expect(peak).toBe(1);
      cache.stop();
    });

    it("does not start a second loop when start is called twice", async () => {
      const clock = fakeTimers();
      let reads = 0;
      const cache = createPrListCache({
        fetch: async () => {
          reads += 1;
          return payload("viewer");
        },
        interval: 60,
        timers: clock.timers,
      });

      cache.start();
      cache.start();
      await settle();
      expect(reads).toBe(1);
      expect(clock.waiting()).toBe(1);
      cache.stop();
    });
  });
});

describe("network.test.ts", () => {
  /**
   * Fork network resolution.
   *
   * The module never calls `gh`: the reader is injected, so every case below is a
   * table of repository information and nothing leaves the process.
   */

  /** A reader over a table, keyed by lowercase `owner/repo`. */
  function readerOf(table: Record<string, RepoInfo | Error>): RepoInfoReader {
    return async (owner, repo) => {
      const value = table[`${owner}/${repo}`.toLowerCase()];
      if (value === undefined) throw new Error(`no entry for ${owner}/${repo}`);
      if (value instanceof Error) throw value;
      return value;
    };
  }

  const plain = (size: number): RepoInfo => ({ fork: false, size });
  const forkOf = (source: string, size: number): RepoInfo => {
    const at = source.indexOf("/");
    return { fork: true, source: { owner: source.slice(0, at), name: source.slice(at + 1) }, size };
  };
  const forkWithoutSource = (size: number): RepoInfo => ({ fork: true, size });

  describe("repository names", () => {
    it("splits owner/repo and refuses anything else", () => {
      expect(splitRepoSlug("acme/app")).toEqual({ owner: "acme", repo: "app" });
      expect(splitRepoSlug(" acme/app ")).toEqual({ owner: "acme", repo: "app" });
      expect(splitRepoSlug("acme")).toBeUndefined();
      expect(splitRepoSlug("/app")).toBeUndefined();
      expect(splitRepoSlug("acme/")).toBeUndefined();
      expect(splitRepoSlug("a/b/c")).toBeUndefined();
      expect(repoSlug(" Acme/App ")).toBe("acme/app");
    });

    it("calls a name safe only when git can take each part as a plain argument", () => {
      for (const safe of ["acme/app", "a-b/c.d_e", "0/9"]) {
        expect(isSafeSlug(safe)).toBe(true);
      }
      // Git reads a leading `-` as an option, and one fetch option runs a command.
      for (const unsafe of ["-n/app", "acme/-x", "a/..", "../x", "a/b c", "a/b/c", "a"]) {
        expect(isSafeSlug(unsafe)).toBe(false);
      }
      expect(isSafeNamePart("-")).toBe(false);
      expect(isSafeNamePart(".")).toBe(false);
      expect(isSafeNamePart("ok.1-2_3")).toBe(true);
    });

    it("keeps the first spelling of a name and folds case duplicates", () => {
      expect(dedupeRepos(["Acme/App", "acme/app", "other/x", "OTHER/X"])).toEqual(["Acme/App", "other/x"]);
      // `readSettings` uses this function too, so the trim and empty-name rules count.
      expect(dedupeRepos([" Acme/App ", "other/x", "", "ACME/APP", "  "])).toEqual(["Acme/App", "other/x"]);
    });
  });

  describe("resolveNetworks", () => {
    it("gives a fork and its source one network rooted at the source", async () => {
      const resolution = await resolveNetworks(
        ["acme/app", "me/app"],
        readerOf({ "acme/app": plain(1000), "me/app": forkOf("acme/app", 20) }),
      );

      expect(resolution.failures).toEqual([]);
      expect(resolution.networks).toHaveLength(1);
      const network = resolution.networks[0];
      expect(network?.root).toBe("acme/app");
      expect(network?.members.map((member) => member.slug)).toEqual(["acme/app", "me/app"]);
      expect(network?.estimateKilobytes).toBe(1000);
      expect(resolution.grouped).toEqual(["acme/app", "me/app"]);
    });

    type NetworkRow = [
      name: string,
      repos: string[],
      table: Record<string, RepoInfo>,
      networks: Array<{ root: string; members: Array<{ slug: string; sizeKilobytes?: number }>; estimateKilobytes?: number }>,
      exact?: { network: number; members: Array<{ slug: string; sizeKilobytes: number }> },
    ];
    // A row's `networks` is matched by shape: the list length and each list of members are exact, each object is a subset.
    // A row with `exact` also compares one network's members whole, as the old cases did.
    const networkRows: NetworkRow[] = [
      [
        "puts two forks of one source in the same network",
        ["me/one", "you/two", "acme/app"],
        { "acme/app": plain(500), "me/one": forkOf("acme/app", 10), "you/two": forkOf("acme/app", 10) },
        [{ root: "acme/app", members: [{ slug: "acme/app" }, { slug: "me/one" }, { slug: "you/two" }] }],
      ],
      [
        "makes a network of its own for a fork that reports no source",
        ["acme/app", "me/private-fork"],
        { "acme/app": plain(1000), "me/private-fork": forkWithoutSource(300) },
        [
          { root: "acme/app", members: [{ slug: "acme/app" }] },
          { root: "me/private-fork", members: [{ slug: "me/private-fork", sizeKilobytes: 300 }] },
        ],
        { network: 1, members: [{ slug: "me/private-fork", sizeKilobytes: 300 }] },
      ],
      [
        "makes a network of its own for a repository that is not a fork",
        ["acme/one", "acme/two"],
        { "acme/one": plain(10), "acme/two": plain(20) },
        [
          { root: "acme/one", members: [{ slug: "acme/one" }], estimateKilobytes: 10 },
          { root: "acme/two", members: [{ slug: "acme/two" }], estimateKilobytes: 20 },
        ],
      ],
      [
        // The root itself is not in the list, so the largest member is the estimate.
        "names the source as the root when the source is not configured",
        ["me/fork"],
        { "me/fork": forkOf("upstream/proj", 40) },
        [{ root: "upstream/proj", members: [{ slug: "me/fork", sizeKilobytes: 40 }], estimateKilobytes: 40 }],
        { network: 0, members: [{ slug: "me/fork", sizeKilobytes: 40 }] },
      ],
      [
        "follows a chain of forks to the oldest configured repository",
        ["acme/app", "mid/app", "me/app"],
        { "acme/app": plain(700), "mid/app": forkOf("acme/app", 15), "me/app": forkOf("mid/app", 15) },
        [{ root: "acme/app", members: [{ slug: "acme/app" }, { slug: "me/app" }, { slug: "mid/app" }] }],
      ],
    ];

    it.each(networkRows)("%s", async (_name, repos, table, networks, exact) => {
      const resolution = await resolveNetworks(repos, readerOf(table));

      expect(resolution.networks).toMatchObject(networks);
      if (exact) expect(resolution.networks[exact.network]?.members).toEqual(exact.members);
    });

    it("stops a cycle of sources instead of looping forever", async () => {
      const resolution = await resolveNetworks(
        ["a/x", "b/y"],
        readerOf({ "a/x": forkOf("b/y", 1), "b/y": forkOf("a/x", 1) }),
      );

      expect(resolution.networks).toHaveLength(1);
      expect(resolution.networks[0]?.members.map((member) => member.slug)).toEqual(["a/x", "b/y"]);
    });

    it("skips a repository it cannot read and reports the error", async () => {
      const resolution = await resolveNetworks(
        ["acme/app", "me/app", "gone/missing"],
        readerOf({
          "acme/app": plain(1000),
          "me/app": forkOf("acme/app", 20),
          "gone/missing": new Error("HTTP 404: Not Found"),
        }),
      );

      expect(resolution.failures).toEqual([{ repo: "gone/missing", message: "HTTP 404: Not Found" }]);
      expect(resolution.grouped).toEqual(["acme/app", "me/app"]);
    });

    it("reports a name it cannot split as a failure without calling the reader", async () => {
      let calls = 0;
      const resolution = await resolveNetworks(["not-a-repo"], async () => {
        calls += 1;
        return plain(1);
      });

      expect(calls).toBe(0);
      expect(resolution.failures).toEqual([{ repo: "not-a-repo", message: "a repository name must be owner/repo" }]);
      expect(resolution.networks).toEqual([]);
    });

    it("reads one repository once when the list repeats a name in another case", async () => {
      const seen: string[] = [];
      const resolution = await resolveNetworks(["Acme/App", "acme/APP"], async (owner, repo) => {
        seen.push(`${owner}/${repo}`);
        return plain(5);
      });

      expect(seen).toEqual(["Acme/App"]);
      expect(resolution.networks.map((network) => network.root)).toEqual(["acme/app"]);
    });
  });
});
