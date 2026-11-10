import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, type Config } from "../../src/config/schema.ts";
import { fillMarker } from "../../src/extensions/github-pr/routes.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../../src/server/server.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { fakeGhFixture, writeResponses, type FakeGhFixture } from "./fake-gh-helpers.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

/**
 * The dashboard's web routes, end to end over HTTP.
 *
 * Every case here goes through the real server, a real harness and the fake
 * `gh`: nothing is stubbed at the module boundary, so what the test proves is
 * what a browser would get. The fake is reached through the extension's own
 * options (`ServerOptions.extensionRoutes["github-pr"]`), which is the seam the
 * daemon leaves empty and a test fills.
 *
 * What is pinned, in a fixed order:
 *
 *   1. The pages: the list page carries the list this process already held, the
 *      pull request page allows an `https` image and the other two pages do not,
 *      a repository the config does not name is `404`, and no page's policy moves
 *      for the pages that existed before.
 *   2. The read APIs: one pull request with the configured spelling of its
 *      repository, and `404` for a number that is not a number.
 *   3. The writes: `403` with nothing sent when the switch is off, the one
 *      request and one audit row without the body when it is on, and `415` for a
 *      body that is not JSON.
 *   4. The list cache: a forced refresh that changed the list publishes `prs`,
 *      and a failed one keeps the copy.
 *   5. The diff: `409` with the three sizes when the disk guard refuses the first
 *      fetch, and a real diff from a local repository otherwise.
 *   6. The shipped catalog: `/github/pr/` answers while the name is enabled and
 *      `404` when it is not.
 *
 * One more case pins a trap of the data blocks rather than a path: a value that
 * carries `$` reaches the page unchanged, because a string replacement reads `$`
 * as a pattern.
 *
 * No test starts a real `gh`, and none reaches GitHub: the `ghPath` of every boot
 * is the fake, and the only git remote is a directory this file made.
 */

/** The policy every page of this server sends, and the list and diff page keep. */
const BASE_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

/** The pull request page's policy: the same, with `https:` images allowed. */
const IMAGE_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'";

/** A timer queue that never fires: only the boot cycle of the poll runs. */
const NEVER_FIRE = {
  set: (): unknown => Symbol("never"),
  clear: (): void => {
    /* nothing is ever scheduled */
  },
};

/** The shared response directory of the fake `gh`, read only. */
const SHARED_RESPONSES = fileURLToPath(new URL("../fixtures/github-pr/responses", import.meta.url));

interface Booted {
  readonly origin: string;
  readonly deps: AppDeps;
  readonly harness: TestHarness;
}

describe("github-pr routes", () => {
  let booted: Booted | undefined;
  const closures: (() => void)[] = [];

  afterEach(async () => {
    for (const close of closures.splice(0)) close();
    await booted?.harness.close();
    booted = undefined;
  });

  /**
   * Boot one server with the fake `gh` and a temporary repository root.
   *
   * `enabled` is the extension list, so a case can leave `github-pr` out and see
   * the same server answer `404` for every path of the dashboard.
   */
  async function boot(
    options: {
      readonly enabled?: readonly string[];
      readonly githubPr?: Config["githubPr"];
      readonly gh?: FakeGhFixture;
      readonly routeOptions?: Record<string, unknown>;
      readonly server?: ServerOptions;
    } = {},
  ): Promise<Booted> {
    const found = options.gh ?? (await fakeGhFixture());
    const repoRoot = await mkdtemp(join(tmpdir(), "gh-repo-routes-"));
    const enabled = options.enabled ?? ["github-pr"];
    const created = await createTestHarness({
      config: {
        server: { ...defaultConfig().server, port: 0 },
        agent: { ...defaultConfig().agent, extensions: { enabled: [...enabled] } },
        ...(options.githubPr === undefined
          ? {}
          : { githubPr: options.githubPr as NonNullable<Config["githubPr"]> }),
      },
    });
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime: created.runtime,
      bus: created.events,
      sse,
      streams: new StreamHub({ runtime: created.runtime, bus: created.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: created.runtime.restart, notes: new AdminNotes() },
    };
    const started: StartedServer = await startServer(deps, {
      webDir: defaultWebDir(),
      extensionRoutes: {
        "github-pr": {
          ghPath: found.clientOptions.ghPath,
          ghEnv: found.clientOptions.env ?? {},
          repoRoot,
          timers: NEVER_FIRE,
          ...(options.routeOptions ?? {}),
        },
      },
      ...(options.server ?? {}),
    });
    closures.push(() => {
      void started.close();
    });
    booted = { origin: started.origin, deps, harness: created };
    return booted;
  }

  /** One page or API answer, with the text read before the connection closes. */
  async function get(
    origin: string,
    path: string,
  ): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
    const response = await fetch(`${origin}${path}`);
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /**
   * The body of one JSON data block the server wrote into a page.
   *
   * Each shell's own comment names the block it leaves room for, so the page
   * carries the element twice: once as the comment's example text and once as the
   * block the server filled. The block is the one that parses as JSON, and the
   * escaping rule is checked on it: no value may close the element early.
   */
  function block(html: string, id: string): unknown {
    const pattern = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, "gs");
    for (const match of html.matchAll(pattern)) {
      const body = match[1] ?? "";
      if (body.includes("<")) continue;
      try {
        return JSON.parse(body);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * One open SSE endpoint, read frame by frame.
   *
   * A frame is complete when a blank line ends it, so the buffer holds whatever
   * follows the last one. Waiting is bounded: a stream that never answers fails
   * with the frames it did send.
   */
  function openEvents(
    origin: string,
    path: string,
  ): { frames: { event: string; data: string }[]; until: (event: string, timeoutMs?: number) => Promise<void>; close: () => void } {
    const controller = new AbortController();
    const frames: { event: string; data: string }[] = [];
    let buffer = "";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const decoder = new TextDecoder();
    const opened = fetch(`${origin}${path}`, { signal: controller.signal }).then((response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      return response.body!.getReader();
    });

    const drain = (): void => {
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut === -1) return;
        const text = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const lines = text.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        if (event === undefined) continue;
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        frames.push({ event, data });
      }
    };

    closures.push(() => controller.abort());
    return {
      frames,
      close: () => controller.abort(),
      async until(event, timeoutMs = 5000) {
        reader ??= await opened;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (frames.some((frame) => frame.event === event)) return;
          if (Date.now() > deadline) {
            throw new Error(`no ${event} frame; saw ${JSON.stringify(frames.map((frame) => frame.event))}`);
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`the stream ended before ${event}`);
          buffer += decoder.decode(chunk.value, { stream: true });
          drain();
        }
      },
    };
  }

  /* --------------------------------------------------------------- pages */

  it("draws the list with the data it holds, and allows https images on the pull request page only", async () => {
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] } });
    // The page carries whatever the poll holds at that moment, and the poll starts
    // at boot. Reading the list once makes the assertion below about a server that
    // has a list, which is the state a reader opens the page in.
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);

    // The list page: the shell, the meta block, and the list this process
    // already fetched at boot.
    const list = await get(origin, "/github/pr/");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-cache");
    expect(list.headers.get("content-security-policy")).toBe(BASE_CSP);

    const meta = block(list.text, "github-pr-meta") as { viewer: string; repos: { repo: string }[]; writes: boolean };
    expect(meta.viewer).toBe("example-user");
    expect(meta.repos).toEqual([{ repo: "acme/widgets" }]);
    expect(meta.writes).toBe(false);

    const first = block(list.text, "github-pr-list-first") as {
      viewer: string;
      sections: { key: string; prs: { number: number; repo: string }[] }[];
    };
    const opened = first.sections.find((section) => section.key === "opened");
    expect(opened?.prs.map((pr) => pr.number)).toEqual([20]);
    expect(opened?.prs[0]?.repo).toBe("acme/widgets");

    // The pull request page: the same shell treatment, one directive wider.
    const view = await get(origin, "/github/pr/acme/widgets/10");
    expect(view.status).toBe(200);
    expect(view.headers.get("content-security-policy")).toBe(IMAGE_CSP);
    expect(block(view.text, "github-pr-meta")).toEqual(meta);
    expect(view.text).not.toContain('id="github-pr-list-first"');

    // The diff page: no image of its own, so the policy of every other page.
    const diff = await get(origin, "/github/pr/acme/widgets/10/diff");
    expect(diff.status).toBe(200);
    expect(diff.headers.get("content-security-policy")).toBe(BASE_CSP);

    // A page that existed before this route table moved not at all.
    const usage = await get(origin, "/usage");
    expect(usage.headers.get("content-security-policy")).toBe(BASE_CSP);

    // A repository the config does not name, and a number that is not a number,
    // are both "no such page".
    const otherRepo = await get(origin, "/github/pr/other/repo/10");
    expect(otherRepo.status).toBe(404);
    expect(otherRepo.json).toEqual({ error: "not found" });
    const notANumber = await get(origin, "/github/pr/acme/widgets/ten");
    expect(notANumber.status).toBe(404);
    expect(notANumber.json).toEqual({ error: "not found" });
    // The case-insensitive match still names the configured spelling.
    const otherCase = await get(origin, "/github/pr/ACME/Widgets/10");
    expect(otherCase.status).toBe(200);
  }, 40_000);

  it("writes a value that carries a dollar sign into the page unchanged", () => {
    // `String.replace` reads `$` in a string replacement as a pattern, so a
    // title such as `$&` would otherwise pull the marker itself into the block.
    const shell = "<head><!--MARK--></head>";
    const block = `<script>{"title":"Fix $& and $' and $1 in the shell"}</script>`;
    expect(fillMarker(shell, "<!--MARK-->", block)).toBe(`<head>${block}</head>`);
    expect(fillMarker("<head></head>", "<!--MARK-->", block)).toBe("<head></head>");
  });

  /* ---------------------------------------------------------------- reads */

  it("answers one pull request with the configured spelling of its repository, and refuses a bad number", async () => {
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] } });

    const detail = await get(origin, "/api/github/pr/acme/widgets/10");
    expect(detail.status).toBe(200);
    const body = detail.json as { repo: string; id: string; number: number; title: string; threads: unknown[] };
    expect(body.repo).toBe("acme/widgets");
    expect(body.id).toBe("PR_node_10");
    expect(body.number).toBe(10);
    expect(body.title).toBe("Add widget cache");
    expect(body.threads.length).toBeGreaterThan(0);
    const listed = detail.json as { commits: { abbreviatedOid: string }[]; totalCommits: number };
    expect(listed.commits.map((commit) => commit.abbreviatedOid)).toEqual(["2222222", "3333333", "1111111"]);
    expect(listed.totalCommits).toBe(3);

    for (const path of [
      "/api/github/pr/acme/widgets/0",
      "/api/github/pr/acme/widgets/10x",
      "/api/github/pr/other/repo/10",
    ]) {
      const refused = await get(origin, path);
      expect(refused.status, path).toBe(404);
      expect(refused.json).toEqual({ error: "not found" });
    }
  }, 40_000);

  /* --------------------------------------------------------------- writes */

  /** The fake `gh` log, one entry per answered call. */
  async function calls(found: FakeGhFixture): Promise<{ args: string[]; stdin: string }[]> {
    return await found.calls();
  }

  /** Whether any answered call carried a GraphQL mutation or a method that is not GET. */
  function wroteAnything(entries: { args: string[] }[]): boolean {
    return entries.some((entry) => {
      const joined = entry.args.join(" ");
      if (/\bmutation\b/i.test(joined)) return true;
      return entry.args.some((arg, index) => {
        if (arg === "-X" || arg === "--method") {
          const method = (entry.args[index + 1] ?? "GET").toUpperCase();
          return method !== "GET";
        }
        if (arg.startsWith("--method=")) return arg.slice("--method=".length).toUpperCase() !== "GET";
        if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).toUpperCase() !== "GET";
        return false;
      });
    });
  }

  /** The audit rows of one type, newest last. */
  async function auditRows(harness: TestHarness, type: string): Promise<Record<string, unknown>[]> {
    const text = await readFile(harness.paths.auditLog, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["type"] === type);
  }

  const REPLY = { body: "thanks for the review", threadId: "PRRT_1" };

  it("refuses every write with 403 and sends nothing while writes are off", async () => {
    // Writes are allowed in the fake on purpose: a leak would then reach it and
    // leave a line in the log, which is what this test reads.
    const gh = await fakeGhFixture({ allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh });
    // Let the boot poll finish first, so the count below is stable.
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);
    const before = (await calls(gh)).length;

    for (const [path, body] of [
      ["/api/github/pr/acme/widgets/10/reply", REPLY],
      ["/api/github/pr/acme/widgets/10/reaction", { subjectId: "PR_node_10", content: "THUMBS_UP", add: true }],
      ["/api/github/pr/acme/widgets/10/review", { body: "", event: "APPROVE", comments: [] }],
      ["/api/github/pr/acme/widgets/10/resolve", { threadId: "PRRT_1" }],
      ["/api/github/pr/acme/widgets/10/edit", { body: "new", baseBody: "old" }],
    ] as const) {
      const answer = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(answer.status, path).toBe(403);
      expect(await answer.json()).toEqual({ error: "writes are disabled" });
    }

    const after = await calls(gh);
    expect(after.length).toBe(before);
    expect(wroteAnything(after)).toBe(false);
    expect(await auditRows(booted!.harness, "github_pr_write")).toEqual([]);
  }, 40_000);

  it("sends the one reply, records it without the body, and refuses a body that is not JSON", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);

    const answer = await fetch(`${origin}/api/github/pr/acme/widgets/10/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(REPLY),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });

    // Exactly one write reached the fake, and it is the thread reply.
    const writes = (await calls(gh)).filter((entry) => /\bmutation\b/i.test(entry.args.join(" ")));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args.join(" ")).toContain("addPullRequestReviewThreadReply");
    expect(writes[0]?.args.join(" ")).toContain("PRRT_1");

    // One audit row: the repository, the number and the kind, never the text.
    const rows = await auditRows(booted!.harness, "github_pr_write");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: "acme/widgets", number: 10, kind: "reply_thread" });
    expect(JSON.stringify(rows[0])).not.toContain("thanks for the review");

    // A form could have sent this, so a body without a JSON type never arrives.
    const notJson = await fetch(`${origin}/api/github/pr/acme/widgets/10/reply`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(REPLY),
    });
    expect(notJson.status).toBe(415);
    expect(await notJson.json()).toEqual({ error: "send this request with Content-Type: application/json" });

    // Bad input inside a JSON body is 400, and sends nothing either.
    const badInput = await fetch(`${origin}/api/github/pr/acme/widgets/10/reaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId: "PR_node_10", content: "SHRUG", add: true }),
    });
    expect(badInput.status).toBe(400);
    expect((await calls(gh)).filter((entry) => /\bmutation\b/i.test(entry.args.join(" ")))).toHaveLength(1);
  }, 40_000);

  it("resolves a thread: 415 for a body that is not JSON, 400 for a missing id, 200 with the thread state", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);
    const url = `${origin}/api/github/pr/acme/widgets/10/resolve`;
    const mutations = async () =>
      (await calls(gh)).filter((entry) => /\bmutation\b/i.test(entry.args.join(" ")));

    const notJson = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ threadId: "PRRT_1" }),
    });
    expect(notJson.status).toBe(415);

    const missing = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await mutations()).toHaveLength(0);

    const foreign = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "PRRT_other_pr" }),
    });
    expect(foreign.status).toBe(400);
    expect(await mutations()).toHaveLength(0);

    const answer = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "PRRT_1" }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, thread: { id: "PRRT_1", isResolved: true } });
    const sent = await mutations();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args.join(" ")).toContain("resolveReviewThread");
    expect(sent[0]?.args.join(" ")).not.toContain("resolutionReason");
    const rows = await auditRows(booted!.harness, "github_pr_write");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: "acme/widgets", number: 10, kind: "resolve_thread", threadId: "PRRT_1" });
  }, 40_000);

  it("answers 502 when the resolve fails inside gh", async () => {
    const responses = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
    await cp(SHARED_RESPONSES, responses, { recursive: true });
    await writeFile(join(responses, "write-resolve.json"), JSON.stringify({ stderr: "boom from gh", exit: 1 }));
    const gh = await fakeGhFixture({ responsesDir: responses, allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);

    const answer = await fetch(`${origin}/api/github/pr/acme/widgets/10/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "PRRT_1" }),
    });
    expect(answer.status).toBe(502);
    expect(String((await answer.json() as { error: string }).error)).toContain("boom from gh");
    expect(await auditRows(booted!.harness, "github_pr_write")).toEqual([]);
  }, 40_000);

  it("edits the description and own comments: 415, 400 for wrong fields, 409 on a conflict, 200 with the new text", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);
    const url = `${origin}/api/github/pr/acme/widgets/10/edit`;
    const post = (body: unknown, type = "application/json") =>
      fetch(url, { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(body) });
    const mutations = async () =>
      (await calls(gh)).filter((entry) => /\bmutation\b/i.test(entry.args.join(" ")));

    expect((await post({ body: "a", baseBody: "b" }, "text/plain")).status).toBe(415);
    expect((await post({ baseBody: "b" })).status).toBe(400);
    expect((await post({ body: 3, baseBody: "b" })).status).toBe(400);
    expect((await post({ body: "a" })).status).toBe(400);
    expect((await post({ body: "a", baseBody: null })).status).toBe(400);
    expect((await post({ body: "a", baseBody: "b", commentId: 7 })).status).toBe(400);
    expect(await mutations()).toHaveLength(0);

    // The page's base text is not what GitHub holds: 409 with the message, nothing sent.
    const conflict = await post({ body: "mine", baseBody: "an older description" });
    expect(conflict.status).toBe(409);
    expect(String(((await conflict.json()) as { error: string }).error)).toContain("changed on GitHub");
    expect(await mutations()).toHaveLength(0);

    const edited = await post({
      body: "Adds a small cache, now with notes.",
      baseBody: "Adds a small cache.\r\n\r\nThanks.",
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ ok: true, body: "Adds a small cache, now with notes." });
    const sent = await mutations();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args.join(" ")).toContain("updatePullRequest(");

    // With a comment id, the same route edits that comment.
    const comment = await post({ body: "My first note, edited.", baseBody: "My first note.", commentId: "IC_mine" });
    expect(comment.status).toBe(200);
    expect(await comment.json()).toEqual({ ok: true, body: "My first note, edited." });
    expect((await mutations())[1]?.args.join(" ")).toContain("updateIssueComment(");

    const foreign = await post({ body: "x", baseBody: "My first note.", commentId: "IC_other_pr" });
    expect(foreign.status).toBe(400);
    expect(await mutations()).toHaveLength(2);

    const rows = await auditRows(booted!.harness, "github_pr_write");
    expect(rows.map((row) => row["kind"])).toEqual(["edit_description", "edit_comment"]);
    expect(JSON.stringify(rows)).not.toContain("now with notes");
  }, 40_000);

  it("answers 502 when the edit fails inside gh", async () => {
    const responses = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
    await cp(SHARED_RESPONSES, responses, { recursive: true });
    await writeFile(join(responses, "write-edit-description.json"), JSON.stringify({ stderr: "boom from gh", exit: 1 }));
    const gh = await fakeGhFixture({ responsesDir: responses, allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);

    const answer = await fetch(`${origin}/api/github/pr/acme/widgets/10/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "new text", baseBody: "Adds a small cache.\r\n\r\nThanks." }),
    });
    expect(answer.status).toBe(502);
    expect(String(((await answer.json()) as { error: string }).error)).toContain("boom from gh");
    expect(await auditRows(booted!.harness, "github_pr_write")).toEqual([]);
  }, 40_000);

  /* ---------------------------------------------------------- review drafts */

  const DRAFT_COMMENT = {
    id: "c-000001",
    path: "src/a.ts",
    side: "RIGHT",
    line: 10,
    startLine: null,
    body: "please rename",
    headSha: "1".repeat(40),
    anchor: { first: "const a = 1;", last: "const a = 1;" },
  };

  async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const answer = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: answer.status, json: (await answer.json()) as Record<string, unknown> };
  }

  /** A draft file as the store writes it, for a case that seeds one by hand. */
  function seededDraft(number: number, listed: boolean): string {
    return JSON.stringify({
      version: 1,
      repo: "acme/widgets",
      number,
      listed,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: "",
      event: "COMMENT",
      comments: [{ ...DRAFT_COMMENT, createdAt: "2026-01-01T00:00:00.000Z" }],
    });
  }

  it("answers the draft routes with the switch off, sends nothing to GitHub, and refuses what it must", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const draftsDir = join(await mkdtemp(join(tmpdir(), "drafts-routes-")), "drafts");
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh, routeOptions: { draftsDir } });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);
    const before = (await calls(gh)).length;
    const base = "/api/github/pr/acme/widgets/10/draft";

    const empty = await get(origin, base);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ comments: [], summary: "", event: "COMMENT", number: 10 });

    const added = await postJson(origin, base, { op: "add", comment: DRAFT_COMMENT });
    expect(added.status).toBe(200);
    expect((added.json["comments"] as unknown[]).length).toBe(1);
    const same = await postJson(origin, base, { op: "add", comment: DRAFT_COMMENT });
    expect((same.json["comments"] as unknown[]).length).toBe(1);
    const set = await postJson(origin, base, { op: "set", summary: "overall", event: "REQUEST_CHANGES" });
    expect(set.json).toMatchObject({ summary: "overall", event: "REQUEST_CHANGES" });
    expect((await get(origin, base)).json).toMatchObject({ summary: "overall", comments: [{ id: "c-000001" }] });
    expect((await readdir(draftsDir)).sort()).toEqual(["acme+widgets+10.json"]);

    const removed = await postJson(origin, base, { op: "remove", id: "c-000001" });
    expect(removed.json["comments"]).toEqual([]);
    expect((await postJson(origin, base, { op: "discard" })).status).toBe(200);
    expect(await readdir(draftsDir)).toEqual([]);

    const notJson = await fetch(`${origin}${base}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(notJson.status).toBe(415);
    expect((await postJson(origin, base, { op: "bogus" })).status).toBe(400);
    expect((await get(origin, "/api/github/pr/acme/other/10/draft")).status).toBe(404);
    expect((await get(origin, "/api/github/pr/acme/widgets/x/draft")).status).toBe(404);
    expect((await postJson(origin, "/api/github/pr/acme/other/10/draft", { op: "discard" })).status).toBe(404);

    // The routes never reached `gh`.
    expect((await calls(gh)).length).toBe(before);
  }, 40_000);

  it("removes the submitted comments after GitHub accepts a review and leaves the draft when it does not", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const draftsDir = join(await mkdtemp(join(tmpdir(), "drafts-routes-")), "drafts");
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh, routeOptions: { draftsDir } });
    expect((await get(origin, "/api/github/pr/list")).status).toBe(200);
    const base = "/api/github/pr/acme/widgets/10";
    await postJson(origin, `${base}/draft`, { op: "add", comment: DRAFT_COMMENT });
    await postJson(origin, `${base}/draft`, { op: "add", comment: { ...DRAFT_COMMENT, id: "c-000002", line: 20 } });
    await postJson(origin, `${base}/draft`, { op: "set", summary: "overall" });
    const file = join(draftsDir, "acme+widgets+10.json");
    const before = await readFile(file, "utf8");

    // The switch refuses (403): a draft is not touched. Flip the switch off by a bad body first.
    const bad = await postJson(origin, `${base}/review`, { event: "COMMENT", body: "x", comments: [], draftCommentIds: "no" });
    expect(bad.status).toBe(400);
    expect(await readFile(file, "utf8")).toBe(before);

    const accepted = await postJson(origin, `${base}/review`, {
      event: "COMMENT",
      body: "overall",
      comments: [{ body: "please rename", path: "src/a.ts", side: "RIGHT", line: 10, startLine: null }],
      draftCommentIds: ["c-000001"],
    });
    expect(accepted.status).toBe(200);
    const draft = (await get(origin, `${base}/draft`)).json as { comments: { id: string }[]; summary: string };
    expect(draft.comments.map((c) => c.id)).toEqual(["c-000002"]);
    expect(draft.summary).toBe("");
  }, 40_000);

  it("leaves the draft as it was when gh fails the review or the switch is off", async () => {
    const responses = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
    await cp(SHARED_RESPONSES, responses, { recursive: true });
    await writeFile(join(responses, "write-review.json"), JSON.stringify({ stderr: "boom from gh", exit: 1 }));
    const gh = await fakeGhFixture({ responsesDir: responses, allowWrites: true });
    const draftsDir = join(await mkdtemp(join(tmpdir(), "drafts-routes-")), "drafts");
    const { origin } = await boot({ githubPr: { writes: true, repos: ["acme/widgets"] }, gh, routeOptions: { draftsDir } });
    const base = "/api/github/pr/acme/widgets/10";
    await postJson(origin, `${base}/draft`, { op: "add", comment: DRAFT_COMMENT });
    const file = join(draftsDir, "acme+widgets+10.json");
    const before = await readFile(file, "utf8");
    const failed = await postJson(origin, `${base}/review`, {
      event: "COMMENT",
      body: "",
      comments: [{ body: "please rename", path: "src/a.ts", side: "RIGHT", line: 10, startLine: null }],
      draftCommentIds: ["c-000001"],
    });
    expect(failed.status).toBe(502);
    expect(await readFile(file, "utf8")).toBe(before);

    // With the switch off the review is refused with 403 and the file stays too.
    const off = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh, routeOptions: { draftsDir } });
    const refused = await postJson(off.origin, `${base}/review`, { event: "COMMENT", body: "", comments: [], draftCommentIds: ["c-000001"] });
    expect(refused.status).toBe(403);
    // The poll of the second server may mark the draft as listed, so compare the review itself.
    expect(JSON.parse(await readFile(file, "utf8")).comments).toEqual(JSON.parse(before).comments);
  }, 40_000);

  it("deletes the draft of a listed pull request that a successful read no longer lists", async () => {
    const responses = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
    await cp(SHARED_RESPONSES, responses, { recursive: true });
    const gh = await fakeGhFixture({ responsesDir: responses });
    const draftsDir = join(await mkdtemp(join(tmpdir(), "drafts-routes-")), "drafts");
    await mkdir(draftsDir, { recursive: true });
    // Seeded as if an earlier daemon had saved it: 12345 was listed, and the
    // list this daemon reads never shows it, which is the daemon-was-down case.
    await writeFile(join(draftsDir, "acme+widgets+12345.json"), seededDraft(12345, true));
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh, routeOptions: { draftsDir } });
    const cold = await get(origin, "/api/github/pr/list");
    expect(cold.status).toBe(200);
    expect(await readdir(draftsDir)).toEqual([]);

    const listed = (cold.json as { sections: { prs: { number: number }[] }[] }).sections.flatMap((s) => s.prs.map((p) => p.number));
    expect(listed.length).toBeGreaterThan(0);
    const number = listed[0] ?? 0;
    const draftPath = `/api/github/pr/acme/widgets/${number}/draft`;
    const file = join(draftsDir, `acme+widgets+${number}.json`);
    await postJson(origin, draftPath, { op: "add", comment: DRAFT_COMMENT });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ listed: true });

    // A refresh whose list still has it keeps it.
    expect((await get(origin, "/api/github/pr/list?refresh=1")).status).toBe(200);
    expect(await readdir(draftsDir)).toEqual([`acme+widgets+${number}.json`]);

    // A failed refresh deletes nothing.
    const saved = await mkdtemp(join(tmpdir(), "fake-gh-saved-"));
    await cp(responses, saved, { recursive: true });
    await writeFile(join(responses, "routes.json"), JSON.stringify({ routes: [], default: "not-authenticated.json" }));
    await writeFile(join(responses, "not-authenticated.json"), JSON.stringify({ stderr: "gh auth login", exit: 1 }));
    expect((await get(origin, "/api/github/pr/list?refresh=1")).status).toBe(502);
    expect(await readdir(draftsDir)).toEqual([`acme+widgets+${number}.json`]);

    // A successful refresh whose list is empty deletes it.
    await cp(saved, responses, { recursive: true });
    const empty = JSON.stringify({ json: { data: { search: { nodes: [] } } } });
    for (const name of ["search-mentions", "search-need-review", "search-opened", "search-draft", "search-involves", "search-reviewed"]) {
      await writeFile(join(responses, `${name}.json`), empty);
    }
    expect((await get(origin, "/api/github/pr/list?refresh=1")).status).toBe(200);
    expect(await readdir(draftsDir)).toEqual([]);
  }, 40_000);

  /* ---------------------------------------------------------------- cache */

  it("publishes prs when a forced refresh changed the list, and keeps the copy when it fails", async () => {
    // A copy of the shared answers, because this case rewrites one of them.
    const responses = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
    await cp(SHARED_RESPONSES, responses, { recursive: true });
    const gh = await fakeGhFixture({ responsesDir: responses, allowWrites: true });
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh });

    const cold = await get(origin, "/api/github/pr/list");
    expect(cold.status).toBe(200);

    const events = openEvents(origin, "/api/github/pr/events");
    // Replacing one search answer moves a pull request from one section to
    // another, which is a change the cache reports.
    await writeFile(
      join(responses, "search-opened.json"),
      JSON.stringify({ json: { data: { search: { nodes: [] } } } }),
      "utf8",
    );

    const refreshed = await get(origin, "/api/github/pr/list?refresh=1");
    expect(refreshed.status).toBe(200);
    expect(refreshed.json).not.toEqual(cold.json);
    await events.until("prs");
    events.close();

    // A refresh that fails answers 502 and leaves the copy exactly as it was.
    await writeFile(
      join(responses, "routes.json"),
      JSON.stringify({ routes: [], default: "not-authenticated.json" }),
      "utf8",
    );
    await writeFile(
      join(responses, "not-authenticated.json"),
      JSON.stringify({ stderr: "To get started with GitHub CLI, please run: gh auth login", exit: 1 }),
      "utf8",
    );
    const failed = await get(origin, "/api/github/pr/list?refresh=1");
    expect(failed.status).toBe(502);
    expect((failed.json as { error: string }).error).toContain("gh auth login");

    const kept = await get(origin, "/api/github/pr/list");
    expect(kept.status).toBe(200);
    expect(kept.json).toEqual(refreshed.json);
  }, 40_000);

  /* ----------------------------------------------------------------- diff */

  /** The root the local repositories of this file's diff cases live under. */
  let diffRoot: string | undefined;

  async function diffRootDir(): Promise<string> {
    diffRoot ??= await mkdtemp(join(tmpdir(), "gh-repo-route-diff-"));
    return diffRoot;
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /** A local repository with `main` and one pull request branch on it. */
  async function makeOrigin(name: string): Promise<{ path: string; headSha: string }> {
    const path = join(await diffRootDir(), name);
    await mkdir(path, { recursive: true });
    git(path, ["init", "--quiet", "-b", "main", "."]);
    await writeFile(join(path, "keep.txt"), "one\ntwo\nthree\n");
    git(path, ["add", "--all"]);
    git(path, ["commit", "--quiet", "-m", "base"]);
    git(path, ["checkout", "--quiet", "-b", "feature"]);
    await writeFile(join(path, "keep.txt"), "one\nTWO\nthree\n");
    git(path, ["add", "--all"]);
    git(path, ["commit", "--quiet", "-m", "change"]);
    const headSha = git(path, ["rev-parse", "HEAD"]).trim();
    git(path, ["update-ref", "refs/pull/7/head", headSha]);
    git(path, ["checkout", "--quiet", "main"]);
    return { path, headSha };
  }

  /** The fake answers a diff needs: the refs of PR 7 and the repository's fork relation. */
  async function diffResponses(headSha: string, sizeKilobytes: number): Promise<string> {
    return await writeResponses({
      "routes.json": {
        routes: [
          { contains: ["id number title baseRefName headRefName headRefOid"], file: "pr-refs.json" },
          { contains: ["api repos/acme/app"], file: "repo-info.json" },
        ],
        default: "empty.json",
      },
      "pr-refs.json": {
        json: {
          data: {
            repository: {
              pullRequest: {
                id: "PR_node_7",
                number: 7,
                title: "Add widget cache",
                baseRefName: "main",
                headRefName: "feature",
                headRefOid: headSha,
              },
            },
          },
        },
      },
      // A REST answer is the repository itself, not a `data` envelope, and it
      // leaves `source` out for a repository that is not a fork.
      "repo-info.json": { json: { full_name: "acme/app", fork: false, size: sizeKilobytes } },
      "empty.json": { json: { data: {} } },
    });
  }

  it("refuses the first fetch with 409 and the three sizes when the disk guard says no", async () => {
    const origin = await makeOrigin("limited");
    const responses = await diffResponses("1111111111111111111111111111111111111111", 90_000);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"] },
      gh,
      routeOptions: { diskLimitMegabytes: 10, remoteUrl: () => origin.path },
    });

    const answer = await get(started.origin, "/api/github/pr/acme/app/7/diff");
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual({
      error: "disk_limit",
      currentMegabytes: 0,
      estimateMegabytes: 88,
      limitMegabytes: 10,
    });
  }, 40_000);

  it("reads the disk limit of the config again, so a reload changes it without a restart", async () => {
    const origin = await makeOrigin("reload");
    // GitHub reports a network of about 390 MB, so a 100 MB cap refuses the
    // first fetch and the schema's default of 2048 MB allows it.
    const responses = await diffResponses(origin.headSha, 400_000);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"], diskLimitMegabytes: 100 },
      gh,
      routeOptions: { remoteUrl: () => origin.path },
    });

    const refused = await get(started.origin, "/api/github/pr/acme/app/7/diff");
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: "disk_limit", limitMegabytes: 100 });

    // The operator changes the cap and the daemon loads the config again. The
    // store holds the settings reader, so the next check answers 2048.
    started.deps.runtime.setConfig({
      ...started.deps.runtime.getConfig(),
      githubPr: { writes: false, repos: ["acme/app"], diskLimitMegabytes: 2048 },
    });

    const allowed = await get(started.origin, "/api/github/pr/acme/app/7/diff");
    expect(allowed.status).toBe(200);
    expect((allowed.json as { headSha: string }).headSha).toBe(origin.headSha);
  }, 40_000);

  it("lets the diff route answer 200 for a network above 4096 MB when the limit is 0", async () => {
    const origin = await makeOrigin("unlimited");
    // GitHub reports about 4.8 GB, which no numeric cap of the schema allows.
    const responses = await diffResponses(origin.headSha, 5_000_000);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"], diskLimitMegabytes: 0 },
      gh,
      routeOptions: { remoteUrl: () => origin.path },
    });

    const answer = await get(started.origin, "/api/github/pr/acme/app/7/diff");
    expect(answer.status).toBe(200);
    expect((answer.json as { headSha: string }).headSha).toBe(origin.headSha);
  }, 40_000);

  it("computes a diff from the local repository and adds the repository and the title", async () => {
    const origin = await makeOrigin("plain");
    const responses = await diffResponses(origin.headSha, 64);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"] },
      gh,
      routeOptions: { remoteUrl: () => origin.path },
    });

    const answer = await get(started.origin, "/api/github/pr/acme/app/7/diff");
    expect(answer.status).toBe(200);
    const body = answer.json as {
      repo: string;
      title: string;
      number: number;
      baseRef: string;
      headSha: string;
      files: { path: string; status: string; additions: number; deletions: number }[];
    };
    expect(body.repo).toBe("acme/app");
    expect(body.title).toBe("Add widget cache");
    expect(body.number).toBe(7);
    expect(body.baseRef).toBe("main");
    expect(body.headSha).toBe(origin.headSha);
    expect(body.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["keep.txt", "M", 1, 1],
    ]);
  }, 40_000);

  /** The fake `gh` log of a request that only reads: no mutation and no non-GET call. */
  async function expectOnlyReads(gh: FakeGhFixture, minimum = 1): Promise<void> {
    const calls = await gh.calls();
    expect(calls.length).toBeGreaterThanOrEqual(minimum);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toMatch(/\bmutation\b/i);
      const method = call.args.findIndex((arg) => arg === "--method" || arg === "-X");
      if (method !== -1) expect((call.args[method + 1] ?? "").toUpperCase()).toBe("GET");
    }
  }

  it("answers the commit page with the diff shell, and 404 for an unconfigured repository or a malformed id", async () => {
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] } });
    const sha = "a".repeat(40);

    const page = await get(origin, `/github/pr/acme/widgets/10/commits/${sha}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain("ui-github-pr-diff.js");
    expect(page.headers.get("content-security-policy")).toBe(BASE_CSP);
    const diffPage = await get(origin, "/github/pr/acme/widgets/10/diff");
    expect(page.text).toBe(diffPage.text);

    expect((await get(origin, `/github/pr/other/repo/10/commits/${sha}`)).status).toBe(404);
    expect((await get(origin, "/github/pr/acme/widgets/10/commits/abc123")).status).toBe(404);
    expect((await get(origin, `/github/pr/acme/widgets/0/commits/${sha}`)).status).toBe(404);
  });

  it("answers the diff of one commit of the pull request and sends only reads to GitHub", async () => {
    const origin = await makeOrigin("commit");
    const responses = await diffResponses(origin.headSha, 64);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: true, repos: ["acme/app"] },
      gh,
      routeOptions: { remoteUrl: () => origin.path },
    });

    const answer = await get(started.origin, `/api/github/pr/acme/app/7/commits/${origin.headSha}`);
    expect(answer.status).toBe(200);
    const body = answer.json as {
      repo: string;
      title: string;
      number: number;
      headSha: string;
      mergeBase: string;
      baseRef: string;
      files: { path: string; status: string; additions: number; deletions: number }[];
      commit: { sha: string; headline: string; parents: string[] };
    };
    expect(body.repo).toBe("acme/app");
    expect(body.title).toBe("Add widget cache");
    expect(body.number).toBe(7);
    expect(body.headSha).toBe(origin.headSha);
    expect(body.baseRef).toBe("");
    expect(body.mergeBase).toBe(body.commit.parents[0]);
    expect(body.commit).toMatchObject({ sha: origin.headSha, headline: "change" });
    expect(body.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["keep.txt", "M", 1, 1],
    ]);
    await expectOnlyReads(gh);
  }, 40_000);

  it("answers 404 with the force-push sentence for a commit that is not in the pull request", async () => {
    const origin = await makeOrigin("outside");
    const responses = await diffResponses(origin.headSha, 64);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"] },
      gh,
      routeOptions: { remoteUrl: () => origin.path },
    });

    const unknown = "b".repeat(40);
    const answer = await get(started.origin, `/api/github/pr/acme/app/7/commits/${unknown}`);
    expect(answer.status).toBe(404);
    expect((answer.json as { error: string }).error).toBe(
      "commit bbbbbbb is not part of pull request #7 now. A force-push can remove a commit. Reload the pull request page for the current list.",
    );
    await expectOnlyReads(gh);
  }, 40_000);

  it("answers 404 for a malformed commit id and an unconfigured repository on the commit route, and asks GitHub nothing", async () => {
    const gh = await fakeGhFixture();
    const { origin } = await boot({ githubPr: { writes: false, repos: ["acme/widgets"] }, gh });
    const before = (await gh.calls()).length;
    expect((await get(origin, "/api/github/pr/acme/widgets/10/commits/abc123")).status).toBe(404);
    expect((await get(origin, "/api/github/pr/acme/widgets/10/commits/--upload-pack=sh")).status).toBe(404);
    expect((await get(origin, `/api/github/pr/other/repo/10/commits/${"a".repeat(40)}`)).status).toBe(404);
    expect((await gh.calls()).length).toBe(before);
    await expectOnlyReads(gh, 0);
  });

  it("refuses the first fetch of a commit diff with 409 and the three sizes when the disk guard says no", async () => {
    const origin = await makeOrigin("commit-limited");
    const responses = await diffResponses("1111111111111111111111111111111111111111", 90_000);
    const gh = await fakeGhFixture({ responsesDir: responses });
    const started = await boot({
      githubPr: { writes: false, repos: ["acme/app"] },
      gh,
      routeOptions: { diskLimitMegabytes: 10, remoteUrl: () => origin.path },
    });

    const answer = await get(started.origin, `/api/github/pr/acme/app/7/commits/${"1".repeat(40)}`);
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual({
      error: "disk_limit",
      currentMegabytes: 0,
      estimateMegabytes: 88,
      limitMegabytes: 10,
    });
    await expectOnlyReads(gh);
  }, 40_000);

  /* -------------------------------------------------------- shipped catalog */

  it("answers /github/pr/ while the shipped catalog has the extension enabled, and 404 when it is off", async () => {
    const gh = await fakeGhFixture({ allowWrites: true });
    const on = await boot({ enabled: ["github-pr"], githubPr: { writes: false, repos: ["acme/widgets"] }, gh });
    const page = await get(on.origin, "/github/pr/");
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="github-pr-meta"');
    await booted?.harness.close();
    booted = undefined;

    const off = await boot({ enabled: [], githubPr: { writes: false, repos: ["acme/widgets"] }, gh });
    const refused = await get(off.origin, "/github/pr/");
    expect(refused.status).toBe(404);
    expect((refused.json as { error: { code: string } }).error.code).toBe("not_found");
  }, 40_000);
});
