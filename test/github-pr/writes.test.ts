import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/runtime/audit.ts";
import {
  createGhClient,
  createGhReader,
  createGhWriter,
} from "../../src/extensions/github-pr/gh.ts";
import {
  commentOnPullRequest,
  EDIT_TEXT_LIMIT_BYTES,
  editComment,
  editDescription,
  WriteConflictError,
  replyToThread,
  resolveThread,
  setReaction,
  submitReview,
  WritesDisabledError,
  WriteInputError,
  type WriteContext,
} from "../../src/extensions/github-pr/writes.ts";
import {
  configuredRepository,
  readSettings,
  splitRepository,
  type GithubPrSettings,
} from "../../src/extensions/github-pr/settings.ts";
import { defaultConfig, type Config } from "../../src/config/schema.ts";
import { fakeGhFixture, writeResponses } from "./fake-gh-helpers.ts";

/**
 * The five writes, and the two rules in front of them.
 *
 * `writes` is read at every call, so a switched-off install refuses before a
 * process exists: the fake `gh`'s log file stays empty, which is the only thing
 * that proves nothing was sent. A switched-on install sends exactly the request
 * the original sent, and leaves one audit row that names the repository, the
 * number and the kind, and never the body.
 */

const SETTINGS: GithubPrSettings = {
  writes: true,
  repos: ["acme/widgets"],
  fetchIntervalSeconds: 300,
  diskLimitMegabytes: 2048,
};

async function context(
  writes: boolean,
  responsesDir?: string,
): Promise<{ context: WriteContext; log: string; auditFile: string }> {
  const found = await fakeGhFixture(responsesDir === undefined ? { allowWrites: true } : { allowWrites: true, responsesDir });
  const root = await mkdtemp(join(tmpdir(), "write-audit-"));
  const auditFile = join(root, "audit.jsonl");
  const audit = createAuditLog({ file: auditFile });
  const client = createGhClient(found.clientOptions);
  return {
    context: {
      settings: () => ({ ...SETTINGS, writes }),
      repo: "acme/widgets",
      number: 10,
      audit,
      writer: createGhWriter(client),
      reader: createGhReader(client),
    },
    log: found.logFile,
    auditFile,
  };
}

async function lines(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("writes: the switch", () => {
  it("refuses every write with nothing sent and no audit row when writes are off", async () => {
    const { context: ctx, log, auditFile } = await context(false);

    await expect(replyToThread(ctx, "PRRT_1", "thanks")).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(commentOnPullRequest(ctx, "a comment")).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(setReaction(ctx, "IC_1", "THUMBS_UP", true)).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(submitReview(ctx, "APPROVE", "looks good", [])).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(resolveThread(ctx, "PRRT_1")).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(editDescription(ctx, "new", "old")).rejects.toBeInstanceOf(WritesDisabledError);
    await expect(editComment(ctx, "IC_mine", "new", "old")).rejects.toBeInstanceOf(WritesDisabledError);

    expect(await lines(log)).toEqual([]);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("treats a missing settings value as writes off", async () => {
    const { context: ctx, log } = await context(true);
    await expect(replyToThread({ ...ctx, settings: () => undefined }, "PRRT_1", "hi")).rejects.toBeInstanceOf(
      WritesDisabledError,
    );
    expect(await lines(log)).toEqual([]);
  });

  it("reads the current switch on each call, so a config reload takes effect at once", async () => {
    const { context: ctx, log } = await context(false);
    // The same context object, with the setting it reads switched the way a
    // config reload would switch it.
    await expect(commentOnPullRequest(ctx, "first")).rejects.toBeInstanceOf(WritesDisabledError);
    let writes = true;
    const reloaded: WriteContext = { ...ctx, settings: () => ({ ...SETTINGS, writes }) };
    await commentOnPullRequest(reloaded, "second");
    const calls = await lines(log);
    expect(calls).toHaveLength(2);

    // Switched off again between two calls: the next one is refused at once.
    writes = false;
    await expect(commentOnPullRequest(reloaded, "third")).rejects.toBeInstanceOf(WritesDisabledError);
    expect(await lines(log)).toHaveLength(2);
  });
});

describe("writes: the four calls", () => {
  it("answers in a thread and records the kind without the body", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await replyToThread(ctx, "PRRT_1", "Body text that must not reach the audit file");

    const calls = await lines(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.["args"]).toContain("threadId=PRRT_1");
    expect(calls[0]?.["args"]).toContain("body=Body text that must not reach the audit file");

    const rows = await lines(auditFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "github_pr_write",
      repo: "acme/widgets",
      number: 10,
      kind: "reply_thread",
      threadId: "PRRT_1",
    });
    const rowText = await readFile(auditFile, "utf8");
    expect(rowText).not.toContain("must not reach the audit file");
  });

  it("comments on the pull request, reading its node id first", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await commentOnPullRequest(ctx, "a comment on the whole pull request");

    const calls = await lines(log);
    // One read for the node id, then the mutation.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.["args"]?.join(" ")).toContain("baseRefName headRefName headRefOid");
    expect(calls[1]?.["args"]?.join(" ")).toContain("addComment(");
    expect(calls[1]?.["args"]).toContain("subjectId=PR_node_10");
    expect((await lines(auditFile))[0]).toMatchObject({ kind: "comment" });
  });

  it("adds and removes a reaction", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await setReaction(ctx, "IC_1", "THUMBS_UP", true);
    await setReaction(ctx, "IC_1", "THUMBS_UP", false);

    const calls = await lines(log);
    expect(calls[0]?.["args"]?.join(" ")).toContain("addReaction(");
    expect(calls[1]?.["args"]?.join(" ")).toContain("removeReaction(");
    const rows = await lines(auditFile);
    expect(rows.map((row) => row["kind"])).toEqual(["reaction_add", "reaction_remove"]);
    expect(rows[0]?.["content"]).toBe("THUMBS_UP");
  });

  it("submits a review as one REST call with the head commit and the line comments", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await submitReview(ctx, "REQUEST_CHANGES", "Please fix this", [
      { body: "rename this", path: "src/cache.ts", side: "RIGHT", line: 42, startLine: 40 },
      { body: "and this", path: "src/index.ts", side: "RIGHT", line: 7 },
    ]);

    const calls = await lines(log);
    expect(calls).toHaveLength(2);
    const reviewCall = calls[1];
    expect(reviewCall?.["args"]).toContain("repos/acme/widgets/pulls/10/reviews");
    expect(reviewCall?.["args"]).toContain("POST");
    expect(JSON.parse(String(reviewCall?.["stdin"]))).toEqual({
      commit_id: "1111111111111111111111111111111111111111",
      event: "REQUEST_CHANGES",
      body: "Please fix this",
      comments: [
        { path: "src/cache.ts", side: "RIGHT", line: 42, body: "rename this", start_line: 40, start_side: "RIGHT" },
        { path: "src/index.ts", side: "RIGHT", line: 7, body: "and this" },
      ],
    });
    expect((await lines(auditFile))[0]).toMatchObject({ kind: "review", event: "REQUEST_CHANGES", comments: 2 });
  });
});

describe("writes: resolve a thread", () => {
  it("reads the thread, sends one mutation with only the thread id, and records one row", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    const state = await resolveThread(ctx, "PRRT_1");

    expect(state).toEqual({ id: "PRRT_1", isResolved: true });
    const calls = await lines(log);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.["args"]?.join(" ")).toContain("viewerCanResolve");
    expect(calls[0]?.["args"]).toContain("threadId=PRRT_1");
    const mutation = calls[1]?.["args"]?.join(" ") ?? "";
    expect(mutation).toContain("resolveReviewThread(input: { threadId: $threadId })");
    expect(mutation).not.toContain("resolutionReason");
    expect(calls[1]?.["args"]).toContain("threadId=PRRT_1");
    const rows = await lines(auditFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "github_pr_write",
      repo: "acme/widgets",
      number: 10,
      kind: "resolve_thread",
      threadId: "PRRT_1",
    });
  });

  it("refuses a thread of another pull request or another repository, sending no mutation", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await expect(resolveThread(ctx, "PRRT_other_pr")).rejects.toBeInstanceOf(WriteInputError);
    await expect(resolveThread(ctx, "PRRT_other_repo")).rejects.toBeInstanceOf(WriteInputError);
    await expect(resolveThread(ctx, "PRRT_nothread")).rejects.toBeInstanceOf(WriteInputError);

    const calls = await lines(log);
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => /\bmutation\b/i.test(String(call["args"])))).toBe(false);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses a thread this account cannot resolve", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await expect(resolveThread(ctx, "PRRT_cannot")).rejects.toThrow("this account cannot resolve this thread");

    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("sends no mutation and writes no row for a thread that is already resolved", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    expect(await resolveThread(ctx, "PRRT_done")).toEqual({ id: "PRRT_done", isResolved: true });

    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses an empty thread id before anything is sent", async () => {
    const { context: ctx, log } = await context(true);
    await expect(resolveThread(ctx, "  ")).rejects.toBeInstanceOf(WriteInputError);
    expect(await lines(log)).toEqual([]);
  });
});

/** One description read answer, for a test that needs a state the shared fixtures lack. */
function descriptionRead(fields: Record<string, unknown>): unknown {
  return {
    json: {
      data: {
        repository: {
          pullRequest: { id: "PR_node_10", body: "old", viewerCanUpdate: true, viewerDidAuthor: true, ...fields },
        },
      },
    },
  };
}


describe("writes: edit the description", () => {
  it("reads first, sends one mutation with only the id and the text, and records one row without the text", async () => {
    const { context: ctx, log, auditFile } = await context(true);
    const base = "Adds a small cache.\r\n\r\nThanks.";

    const edited = await editDescription(ctx, "Adds a small cache, now with notes.", base);

    expect(edited).toEqual({ body: "Adds a small cache, now with notes." });
    const calls = await lines(log);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.["args"]?.join(" ")).toContain("viewerDidAuthor");
    const mutation = calls[1]?.["args"]?.join(" ") ?? "";
    expect(mutation).toContain("updatePullRequest(input: { pullRequestId: $pullRequestId, body: $body })");
    for (const field of ["title", "state", "baseRefName", "labels", "assignees", "milestone"]) {
      expect(mutation).not.toContain(`${field}:`);
    }
    expect(calls[1]?.["args"]).toContain("pullRequestId=PR_node_10");
    expect(calls[1]?.["args"]).toContain("body=Adds a small cache, now with notes.");
    const rows = await lines(auditFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "github_pr_write", repo: "acme/widgets", number: 10, kind: "edit_description" });
    expect(await readFile(auditFile, "utf8")).not.toContain("now with notes");
  });

  it("refuses with a conflict when GitHub's text is not the base text, and sends nothing", async () => {
    const dir = await writeResponses({ "0001-read.json": descriptionRead({ body: "someone else changed this" }) });
    const { context: ctx, log, auditFile } = await context(true, dir);

    await expect(editDescription(ctx, "my text", "old")).rejects.toBeInstanceOf(WriteConflictError);

    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses when the account cannot update the pull request", async () => {
    const dir = await writeResponses({ "0001-read.json": descriptionRead({ viewerCanUpdate: false }) });
    const { context: ctx, log, auditFile } = await context(true, dir);
    await expect(editDescription(ctx, "new", "old")).rejects.toThrow("this account cannot edit this description");
    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses a pull request that another account wrote", async () => {
    const dir = await writeResponses({ "0001-read.json": descriptionRead({ viewerDidAuthor: false }) });
    const { context: ctx, log, auditFile } = await context(true, dir);
    await expect(editDescription(ctx, "new", "old")).rejects.toThrow("this account did not write this pull request");
    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("sends no mutation and writes no row when the text did not change", async () => {
    const dir = await writeResponses({ "0001-read.json": descriptionRead({ body: "same" }) });
    const { context: ctx, log, auditFile } = await context(true, dir);
    expect(await editDescription(ctx, "same", "same")).toEqual({ body: "same" });
    expect(await lines(log)).toHaveLength(1);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses a text over the size limit before any gh call", async () => {
    const { context: ctx, log } = await context(true);
    const long = "가".repeat(Math.ceil(EDIT_TEXT_LIMIT_BYTES / 3) + 1);
    await expect(editDescription(ctx, long, "old")).rejects.toThrow(/this page sends at most 131000 bytes/);
    await expect(editComment(ctx, "IC_mine", long, "old")).rejects.toBeInstanceOf(WriteInputError);
    expect(await lines(log)).toEqual([]);
  });

  it("lets an empty description replace an empty description on GitHub", async () => {
    const dir = await writeResponses({
      "0001-read.json": descriptionRead({ body: null }),
      "0002-write.json": { json: { data: { updatePullRequest: { pullRequest: { id: "PR_node_10", body: "first text" } } } } },
    });
    const { context: ctx, log, auditFile } = await context(true, dir);
    expect(await editDescription(ctx, "first text", "")).toEqual({ body: "first text" });
    expect(await lines(log)).toHaveLength(2);
    expect(await lines(auditFile)).toHaveLength(1);
    // Emptying a description is allowed too.
    const clear = await writeResponses({
      "0001-read.json": descriptionRead({ body: "old" }),
      "0002-write.json": { json: { data: { updatePullRequest: { pullRequest: { id: "PR_node_10", body: "" } } } } },
    });
    const second = await context(true, clear);
    expect(await editDescription(second.context, "", "old")).toEqual({ body: "" });
  });

  it("fails as a gh error for a pull request that does not exist", async () => {
    const dir = await writeResponses({ "0001-read.json": { json: { data: { repository: { pullRequest: null } } } } });
    const { context: ctx } = await context(true, dir);
    await expect(editDescription(ctx, "new", "old")).rejects.toThrow("PR #10 not found");
  });

});

describe("writes: edit a comment", () => {
  it("edits a conversation comment with one mutation and one row", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    const edited = await editComment(ctx, "IC_mine", "My first note, edited.", "My first note.");

    expect(edited).toEqual({ body: "My first note, edited." });
    const calls = await lines(log);
    expect(calls).toHaveLength(2);
    const mutation = calls[1]?.["args"]?.join(" ") ?? "";
    expect(mutation).toContain("updateIssueComment(input: { id: $id, body: $body })");
    expect(calls[1]?.["args"]).toContain("id=IC_mine");
    const rows = await lines(auditFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "edit_comment", commentId: "IC_mine", commentType: "IssueComment" });
    expect(await readFile(auditFile, "utf8")).not.toContain("edited");
  });

  it("edits a review comment with the review comment mutation", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    const edited = await editComment(ctx, "PRRC_mine", "My line note, edited.", "My line note.");

    expect(edited).toEqual({ body: "My line note, edited." });
    const calls = await lines(log);
    const mutation = calls[1]?.["args"]?.join(" ") ?? "";
    expect(mutation).toContain("updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body })");
    expect(calls[1]?.["args"]).toContain("commentId=PRRC_mine");
    expect((await lines(auditFile))[0]).toMatchObject({ kind: "edit_comment", commentType: "PullRequestReviewComment" });
  });

  it("refuses a comment of another pull request or repository, another author, or another node type", async () => {
    const { context: ctx, log, auditFile } = await context(true);

    await expect(editComment(ctx, "IC_other_pr", "x", "My first note.")).rejects.toThrow("not a comment of this pull request");
    await expect(editComment(ctx, "IC_other_repo", "x", "My first note.")).rejects.toThrow("not a comment of this pull request");
    await expect(editComment(ctx, "PRR_1", "x", "My first note.")).rejects.toThrow("not a comment of this pull request");
    await expect(editComment(ctx, "IC_other_author", "x", "Someone else.")).rejects.toThrow("did not write this comment");

    const calls = await lines(log);
    expect(calls).toHaveLength(4);
    expect(calls.some((call) => /\bmutation\b/i.test(String(call["args"])))).toBe(false);
    expect(await lines(auditFile)).toEqual([]);
  });

  it("refuses an empty text and an empty id before anything is sent", async () => {
    const { context: ctx, log } = await context(true);
    await expect(editComment(ctx, "IC_mine", "  ", "My first note.")).rejects.toBeInstanceOf(WriteInputError);
    await expect(editComment(ctx, " ", "text", "base")).rejects.toBeInstanceOf(WriteInputError);
    expect(await lines(log)).toEqual([]);
  });

  it("refuses with a conflict when the base text differs, and sends nothing for an unchanged text", async () => {
    const { context: ctx, log, auditFile } = await context(true);
    await expect(editComment(ctx, "IC_mine", "new", "an older text")).rejects.toBeInstanceOf(WriteConflictError);
    expect(await editComment(ctx, "IC_mine", "My first note.", "My first note.")).toEqual({ body: "My first note." });
    expect(await lines(log)).toHaveLength(2);
    expect(await lines(auditFile)).toEqual([]);
  });
});

describe("writes: refused input", () => {
  it("refuses empty bodies, an unknown reaction and a review with nothing in it", async () => {
    const { context: ctx, log } = await context(true);

    await expect(replyToThread(ctx, "PRRT_1", "   ")).rejects.toBeInstanceOf(WriteInputError);
    await expect(commentOnPullRequest(ctx, "")).rejects.toBeInstanceOf(WriteInputError);
    await expect(setReaction(ctx, "IC_1", "SHRUG" as never, true)).rejects.toBeInstanceOf(WriteInputError);
    await expect(submitReview(ctx, "APPROVE", "  ", [])).rejects.toBeInstanceOf(WriteInputError);
    await expect(submitReview(ctx, "MERGE" as never, "text", [])).rejects.toBeInstanceOf(WriteInputError);

    expect(await lines(log)).toEqual([]);
  });
});

describe("settings", () => {
  it("applies the schema defaults of the two numbers", () => {
    const config = {
      ...defaultConfig(),
      githubPr: { writes: false, repos: ["acme/widgets"] },
    } as Config;
    expect(readSettings(config)).toEqual({
      writes: false,
      repos: ["acme/widgets"],
      fetchIntervalSeconds: 300,
      diskLimitMegabytes: 2048,
    });
  });

  it("returns undefined when the key is absent", () => {
    expect(readSettings(defaultConfig())).toBeUndefined();
  });

  it("matches a URL's owner and repository without regard to case, and returns the configured spelling", () => {
    const settings: GithubPrSettings = { ...SETTINGS, repos: ["Acme/Widgets", "other/tool"] };
    expect(configuredRepository(settings, "acme", "WIDGETS")).toBe("Acme/Widgets");
    expect(configuredRepository(settings, "nobody", "nothing")).toBeUndefined();
    expect(splitRepository("Acme/Widgets")).toEqual({ owner: "Acme", name: "Widgets" });
  });
});
