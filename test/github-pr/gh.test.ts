import { readFile } from "node:fs/promises";
import { fakeGhFixture, writeResponses } from "./fake-gh-helpers.ts";
import {
  mentionDetailQuery,
  PR_DETAIL_QUERY,
  PR_REFS_QUERY,
  repoInfoEndpoint,
  SEARCH_QUERY,
  VIEWER_QUERY,
} from "../../src/extensions/github-pr/queries.ts";
import { describe, expect, it } from "vitest";
import {
  createGhClient,
  createGhReader,
  createGhWriter,
  fetchRepositoryInfo,
  GhError,
  GhRefusalError,
  type GhClient,
  type GhClientOptions,
} from "../../src/extensions/github-pr/gh.ts";

/**
 * The `gh` subprocess layer, proved without a real `gh`.
 *
 * Every call here goes to `test/fixtures/github-pr/fake-gh.mjs`, which records the
 * arguments and the standard input it received and answers from a response file.
 * The two rules that carry the security of the read half are checked the same way:
 * a refused call must leave the record file empty, which is the only proof that no
 * process was started.
 */

interface Fixture {
  readonly clientOptions: GhClientOptions;
  readonly logFile: string;
}

/**
 * A fake `gh` over a response directory built for the test.
 *
 * The executable, the log and the counters are `fakeGhFixture`; this adds only the
 * one-file responses a test of a single call needs.
 */
async function fixture(responses: Record<string, unknown>): Promise<Fixture> {
  const responsesDir = await writeResponses(responses);
  const found = await fakeGhFixture({ responsesDir });
  return { clientOptions: found.clientOptions, logFile: found.logFile };
}

function client(found: Fixture, extraEnvironment: Record<string, string> = {}): GhClient {
  return createGhClient({
    ...found.clientOptions,
    env: { ...found.clientOptions.env, ...extraEnvironment },
  });
}

async function logged(found: Fixture): Promise<{ args: string[]; stdin: string; response: string }[]> {
  const text = await readFile(found.logFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string; response: string });
}

describe("gh subprocess: reads", () => {
  it("runs one api graphql query and returns its data", async () => {
    const found = await fixture({ "viewer.json": { json: { data: { viewer: { login: "octo" } } } } });
    const reader = createGhReader(client(found));

    const data = await reader.graphql<{ viewer: { login: string } }>("query { viewer { login } }");

    expect(data).toEqual({ viewer: { login: "octo" } });
    const calls = await logged(found);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(calls[0]?.args[3]).toBe("query=query { viewer { login } }");
  });

  it("passes numbers and booleans as typed variables and strings as text", async () => {
    const found = await fixture({ "ok.json": { json: { data: { repository: null } } } });
    const reader = createGhReader(client(found));

    await reader.graphql("query($a: Int!, $b: Boolean!, $c: String!) { x }", { a: 7, b: false, c: "owner/repo" });

    const args = (await logged(found))[0]?.args ?? [];
    expect(args).toContain("-F");
    expect(args).toContain("a=7");
    expect(args).toContain("b=false");
    expect(args).toContain("c=owner/repo");
  });

  it("refuses a GraphQL mutation before it starts a process", async () => {
    const found = await fixture({ "ok.json": { json: { data: {} } } });
    const reader = createGhReader(client(found));

    await expect(reader.graphql("mutation { addComment(input: {}) { clientMutationId } }")).rejects.toBeInstanceOf(
      GhRefusalError,
    );
    expect(await logged(found)).toEqual([]);
  });

  it("refuses a read whose method is not GET", async () => {
    const found = await fixture({ "ok.json": { json: { data: {} } } });
    const reader = createGhReader(client(found));

    await expect(reader.api(["api", "repos/a/b/pulls/1/reviews", "-X", "POST"])).rejects.toBeInstanceOf(GhRefusalError);
    await expect(reader.api(["api", "repos/a/b", "--method", "DELETE"])).rejects.toBeInstanceOf(GhRefusalError);
    await expect(reader.api(["api", "repos/a/b", "-XPATCH"])).rejects.toBeInstanceOf(GhRefusalError);
    expect(await logged(found)).toEqual([]);
  });

  it("refuses a REST read that would turn into a POST because it carries a body", async () => {
    const found = await fixture({ "ok.json": { json: { ok: true } } });
    const reader = createGhReader(client(found));

    // `gh api` sends a POST as soon as any parameter is added, so a read that
    // carries one and no explicit GET would write.
    const implicitPosts: string[][] = [
      ["api", "repos/o/r/issues", "-f", "title=x"],
      ["api", "repos/o/r/issues", "-F", "title=x"],
      ["api", "repos/o/r/issues", "--field", "title=x"],
      ["api", "repos/o/r/issues", "--raw-field", "title=x"],
      ["api", "repos/o/r/issues", "--input", "body.json"],
      ["api", "repos/o/r/issues", "-ftitle=x"],
      ["api", "repos/o/r/issues", "-Ftitle=x"],
      ["api", "repos/o/r/issues", "--field=title=x"],
      ["api", "repos/o/r/issues", "--raw-field=title=x"],
      ["api", "repos/o/r/issues", "--input=body.json"],
      ["api", "-f", "title=x", "repos/o/r/issues"],
    ];
    for (const args of implicitPosts) {
      await expect(reader.api(args), args.join(" ")).rejects.toBeInstanceOf(GhRefusalError);
    }
    expect(await logged(found)).toEqual([]);
  });

  it("allows a read with a body when it names GET, in every spelling of the flag", async () => {
    const found = await fixture({ "default.json": { json: { ok: true } } });
    const reader = createGhReader(client(found));

    const explicitGets: string[][] = [
      ["api", "repos/o/r/issues", "-f", "title=x", "-X", "GET"],
      ["api", "repos/o/r/issues", "-F", "title=x", "--method", "GET"],
      ["api", "repos/o/r/issues", "-f", "title=x", "--method=GET"],
      ["api", "repos/o/r/issues", "-f", "title=x", "--method=get"],
      ["api", "repos/o/r/issues", "-f", "title=x", "-XGET"],
      ["api", "repos/o/r/issues", "-f", "title=x", "-X", "get"],
      ["api", "--method", "GET", "repos/o/r/issues", "--input=body.json"],
    ];
    for (const args of explicitGets) {
      await expect(reader.api(args), args.join(" ")).resolves.toContain("ok");
    }
    expect(await logged(found)).toHaveLength(explicitGets.length);
  });

  it("allows a graphql read to carry its query and variables as fields", async () => {
    const found = await fixture({ "default.json": { json: { ok: true } } });
    const reader = createGhReader(client(found));

    // A GraphQL request is a POST whatever the flags say, and it reads.
    const graphqlWithFields = ["api", "graphql", "-f", "query=query { viewer { login } }", "-F", "owner=x"];
    await expect(reader.api(graphqlWithFields)).resolves.toContain("ok");
    await expect(reader.api(["api", "--paginate", "graphql", "-fquery=query { viewer { login } }"])).resolves.toContain(
      "ok",
    );
    expect(await logged(found)).toHaveLength(2);
  });

  it("allows the flags that take a value but add no parameters", async () => {
    const found = await fixture({ "default.json": { json: { ok: true } } });
    const reader = createGhReader(client(found));

    // `-H`, `--jq` and `--template` carry a value and do not make a POST.
    const header = ["api", "repos/o/r", "-H", "Accept: application/vnd.github+json"];
    await expect(reader.api(header)).resolves.toContain("ok");
    await expect(reader.api(["api", "repos/o/r", "--jq", ".name"])).resolves.toContain("ok");
    await expect(reader.api(["api", "repos/o/r", "--template", "{{.name}}"])).resolves.toContain("ok");
    expect(await logged(found)).toHaveLength(3);
  });

  it("allows an explicit GET and any subcommand that is not api is refused", async () => {
    const found = await fixture({ "ok.json": { json: { ok: true } } });
    const reader = createGhReader(client(found));

    await expect(reader.api(["api", "repos/a/b", "-X", "GET"])).resolves.toContain("ok");
    await expect(reader.api(["pr", "list"])).rejects.toBeInstanceOf(GhRefusalError);
    expect(await logged(found)).toHaveLength(1);
  });

  it("reports the gh error text of a failed call", async () => {
    const found = await fixture({ "fail.json": { stderr: "HTTP 404: Not Found", exit: 1 } });
    const reader = createGhReader(client(found));

    const error = await reader.graphql("query { viewer { login } }").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toBe("HTTP 404: Not Found");
  });

  it("turns a GraphQL errors array into an error and keeps every message", async () => {
    const found = await fixture({
      "errors.json": { json: { errors: [{ message: "first" }, { message: "second" }] } },
    });
    const reader = createGhReader(client(found));

    const error = await reader.graphql("query { viewer { login } }").catch((caught: unknown) => caught);
    expect((error as GhError).message).toBe("first; second");
  });

  it("refuses output that is not JSON", async () => {
    const found = await fixture({ "text.json": { stdout: "not json" } });
    const reader = createGhReader(client(found));

    await expect(reader.graphql("query { viewer { login } }")).rejects.toBeInstanceOf(GhError);
  });
});

describe("queries and read limits", () => {
  it("carries each limit into the query text", () => {
    expect(PR_DETAIL_QUERY).toContain("labels(first: 30)");
    // One limit is for the pull request's comments and one for the comments of a thread.
    expect(PR_DETAIL_QUERY.split("comments(first: 100)")).toHaveLength(3);
    expect(PR_DETAIL_QUERY).toContain("reviews(first: 50)");
    expect(PR_DETAIL_QUERY).toContain("reviewThreads(first: 100)");
    expect(PR_DETAIL_QUERY).toContain("subjectType");
    expect(PR_DETAIL_QUERY).toContain("contexts(first: 100)");
    expect(PR_DETAIL_QUERY).toContain("commitList: commits(last: 100)");
    expect(SEARCH_QUERY).toContain("first: 50");
  });

  it("keeps every read query free of a mutation word", () => {
    for (const query of [VIEWER_QUERY, SEARCH_QUERY, PR_DETAIL_QUERY, PR_REFS_QUERY]) {
      expect(/\bmutation\b/i.test(query)).toBe(false);
    }
    // The mention query writes the repository name into its text, so it is built
    // per call; it must be a read too.
    expect(/\bmutation\b/i.test(mentionDetailQuery("acme", "widgets", [1, 2]))).toBe(false);
  });

  it("names one repository's REST path, with both parts escaped", () => {
    expect(repoInfoEndpoint("acme", "widgets")).toBe("repos/acme/widgets");
    // A configured name reaches a URL path segment here, so nothing in it may
    // add a segment or a query of its own.
    expect(repoInfoEndpoint("acme", "a/b?c=1")).toBe("repos/acme/a%2Fb%3Fc%3D1");
  });
});

describe("gh subprocess: repository information", () => {
  it("reads one repository's fork relationship and size with one REST GET", async () => {
    // The answer has the shape the REST endpoint returns for a fork: the
    // repository itself, with `fork`, `size` and a `source` object. It carries
    // `parent` too, which names the repository one step up, so a reader that
    // walked `parent` instead of `source` would answer something else.
    const found = await fixture({
      "0001-repo.json": {
        json: {
          id: 31415926,
          node_id: "R_kgDOExampleFork",
          name: "widgets",
          full_name: "acme/widgets",
          private: false,
          owner: { login: "acme", id: 4711, type: "Organization", site_admin: false },
          fork: true,
          size: 82729,
          default_branch: "main",
          parent: { id: 27182819, name: "widgets-middle", full_name: "middle/widgets", fork: true, size: 85000 },
          source: { id: 27182818, name: "widgets", full_name: "upstream/widgets", fork: false, size: 90000 },
        },
      },
    });
    const reader = createGhReader(client(found));

    expect(await fetchRepositoryInfo(reader, "acme", "widgets")).toEqual({
      fork: true,
      source: { owner: "upstream", name: "widgets" },
      size: 82729,
    });

    // One REST read: no `graphql` subargument, no `-f`/`-F`, which is what makes
    // `gh api` send a GET rather than a POST with a body.
    const calls = await logged(found);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["api", "repos/acme/widgets"]);
  });

  it("reports a repository that is not a fork, whose answer carries no source key", async () => {
    const found = await fixture({
      "0001-repo.json": {
        json: { full_name: "upstream/widgets", fork: false, size: 90000, default_branch: "main" },
      },
    });
    const reader = createGhReader(client(found));
    expect(await fetchRepositoryInfo(reader, "upstream", "widgets")).toEqual({ fork: false, size: 90000 });
  });

  it("reports a fork whose source GitHub answers as null without a source", async () => {
    // A private fork can come back this way, and `network.ts` then treats the
    // repository as the root of its own network.
    const found = await fixture({
      "0001-repo.json": { json: { full_name: "acme/secret-fork", fork: true, size: 12, source: null } },
    });
    const reader = createGhReader(client(found));
    expect(await fetchRepositoryInfo(reader, "acme", "secret-fork")).toEqual({ fork: true, size: 12 });
  });

  it("carries GitHub's own message when REST refuses a repository", async () => {
    // A REST 404 makes `gh` exit non-zero, so there is no body to read: the
    // error is the one `gh` printed, and the resolver shows it next to the name.
    const found = await fixture({
      "0001-repo.json": { stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    });
    const reader = createGhReader(client(found));

    const error = await fetchRepositoryInfo(reader, "acme", "nothing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toBe("gh: Not Found (HTTP 404)");
  });

  it("reports an empty REST answer as an error rather than a repository", async () => {
    const found = await fixture({ "0001-repo.json": { stdout: "" } });
    const reader = createGhReader(client(found));

    await expect(fetchRepositoryInfo(reader, "acme", "widgets")).rejects.toBeInstanceOf(GhError);
  });
});

describe("gh subprocess: writes", () => {
  it("runs a mutation and records the arguments", async () => {
    const found = await fixture({ "reply.json": { json: { data: { addPullRequestReviewThreadReply: null } } } });
    const writer = createGhWriter(client(found, { FAKE_GH_ALLOW_WRITES: "1" }));

    await writer.mutation("mutation($body: String!) { reply(body: $body) { id } }", { body: "thanks" });

    const calls = await logged(found);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("body=thanks");
    expect(calls[0]?.response).toBe("reply.json");
  });

  it("sends a REST write with its body on standard input", async () => {
    const found = await fixture({ "review.json": { json: { ok: true } } });
    const writer = createGhWriter(client(found, { FAKE_GH_ALLOW_WRITES: "1" }));

    await writer.api(
      ["api", "repos/o/r/pulls/3/reviews", "-X", "POST", "--input", "-"],
      JSON.stringify({ event: "COMMENT" }),
    );

    const calls = await logged(found);
    expect(calls[0]?.args).toContain("POST");
    expect(calls[0]?.stdin).toBe(JSON.stringify({ event: "COMMENT" }));
  });

  it("refuses a write that is not a write", async () => {
    const found = await fixture({ "ok.json": { json: { ok: true } } });
    const writer = createGhWriter(client(found, { FAKE_GH_ALLOW_WRITES: "1" }));

    await expect(writer.api(["api", "repos/o/r", "-X", "GET"])).rejects.toBeInstanceOf(GhRefusalError);
    await expect(writer.mutation("query { viewer { login } }")).rejects.toBeInstanceOf(GhRefusalError);
    expect(await logged(found)).toEqual([]);
  });

  it("never records a write that the fake gh itself was not told to allow", async () => {
    const found = await fixture({ "ok.json": { json: { data: {} } } });
    const writer = createGhWriter(client(found));

    await expect(writer.api(["api", "repos/o/r", "-X", "POST", "--input", "-"], "{}")).rejects.toBeInstanceOf(GhError);
    expect(await logged(found)).toEqual([]);
  });
});
