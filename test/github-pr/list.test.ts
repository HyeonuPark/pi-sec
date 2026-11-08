import { describe, expect, it } from "vitest";
import { createGhClient, createGhReader, GhError, type GhReader } from "../../src/extensions/github-pr/gh.ts";
import {
  fetchPrList,
  hasPendingMention,
  mentionPattern,
  SECTIONS,
  type PrListPayload,
  type MentionSource,
} from "../../src/extensions/github-pr/list.ts";
import { fakeGhFixture } from "./fake-gh-helpers.ts";

/**
 * The list: five sections, one pull request in one section, the mention rule, the
 * merge across repositories, and the order inside a section.
 *
 * The single-repository case runs through the fake `gh` and its response files, so
 * the GraphQL text and the parsing are exercised together. The multi-repository
 * cases use a stub reader, because a response file cannot easily answer "this
 * repository, but not that one" for seven searches and still read like a fixture.
 */

describe("list: mention rule", () => {
  const source = (comments: string[], threads: string[][] = [], reviews: string[] = []): MentionSource => ({
    comments: comments.map((body, index) => ({
      author: { login: body.startsWith("me:") ? "me" : "other" },
      body: body.replace(/^[a-z]+:/, ""),
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
    })),
    reviews: reviews.map((body, index) => ({
      author: { login: body.startsWith("me:") ? "me" : "other" },
      body: body.replace(/^[a-z]+:/, ""),
      createdAt: `2026-01-02T00:00:${String(index).padStart(2, "0")}Z`,
    })),
    threads: threads.map((thread, threadIndex) => ({
      comments: thread.map((body, index) => ({
        author: { login: body.startsWith("me:") ? "me" : "other" },
        body: body.replace(/^[a-z]+:/, ""),
        createdAt: `2026-01-03T0${threadIndex}:00:${String(index).padStart(2, "0")}Z`,
      })),
    })),
  });

  it("matches @login and refuses a longer name, an e-mail and a path", () => {
    const pattern = mentionPattern("me");
    expect(pattern.test("ping @me please")).toBe(true);
    expect(pattern.test("ping @ME")).toBe(true);
    expect(pattern.test("ping @memo")).toBe(false);
    expect(pattern.test("mail me@me.example")).toBe(false);
    expect(pattern.test("see docs/@me")).toBe(false);
  });

  it("keeps a mention that nobody answered", () => {
    expect(hasPendingMention(source(["other:@me look"]), "me")).toBe(true);
  });

  it("drops a mention the viewer answered, and reopens it after a new one", () => {
    expect(hasPendingMention(source(["other:@me look", "me:done"]), "me")).toBe(false);
    expect(hasPendingMention(source(["other:@me look", "me:done", "other:and again @me"]), "me")).toBe(true);
  });

  it("keeps a mention inside a review thread that no later reply answered", () => {
    expect(hasPendingMention(source([], [["other:why @me?"], ["me:ok"]]), "me")).toBe(true);
    expect(hasPendingMention(source([], [["me:ok"]]), "me")).toBe(false);
  });

  it("counts a review body as part of the pull request conversation and skips an empty one", () => {
    expect(hasPendingMention(source([], [], ["other:@me in the summary"]), "me")).toBe(true);
    expect(hasPendingMention(source(["other:@me", "me:done"], [], ["me:Approved"]), "me")).toBe(false);
  });
});

describe("list: one repository through the fake gh", () => {
  it("builds the five sections, keeps one pull request in one section and sorts each by update time", async () => {
    const found = await fakeGhFixture();
    const payload = await fetchPrList(createGhReader(createGhClient(found.clientOptions)), ["acme/widgets"]);

    expect(payload.viewer).toBe("example-user");
    expect(payload.repos).toEqual([{ repo: "acme/widgets" }]);
    expect(payload.sections.map((section) => section.key)).toEqual(SECTIONS.map((section) => section.key));
    expect(payload.sections.map((section) => section.title)).toEqual([
      "Mentioned",
      "Need review",
      "Opened",
      "Draft",
      "Related",
    ]);

    const bySection = Object.fromEntries(payload.sections.map((section) => [section.key, section.prs]));

    // 10 stays in Mentioned because its latest thread comment mentions the viewer
    // after the viewer's own reply; 12 is dropped because the viewer answered.
    expect(bySection["mentioned"]?.map((pr) => pr.number)).toEqual([10]);
    // 10 is in Need review too, but a claimed pull request never appears twice.
    expect(bySection["need-review"]?.map((pr) => pr.number)).toEqual([15]);
    expect(bySection["opened"]?.map((pr) => pr.number)).toEqual([20]);
    expect(bySection["draft"]?.map((pr) => pr.number)).toEqual([21]);
    // 20 is already claimed by Opened, and 31 is closed.
    expect(bySection["related"]?.map((pr) => pr.number)).toEqual([30, 32]);

    const firstRow = bySection["mentioned"]?.[0];
    expect(firstRow).toEqual({
      number: 10,
      title: "Add widget cache",
      url: "https://github.example.com/acme/widgets/pull/10",
      isDraft: false,
      author: "example-other",
      updatedAt: "2026-10-29T09:12:00Z",
      headRefName: "feature/widget-cache",
      baseRefName: "main",
      reviewDecision: "REVIEW_REQUIRED",
      labels: [{ name: "cache", color: "0e8a16" }],
      ciState: "SUCCESS",
      repo: "acme/widgets",
    });
    // A pull request with no rollup says so with null rather than a made-up state.
    expect(bySection["related"]?.[1]?.ciState).toBeNull();
  });
});

describe("list: several repositories", () => {
  /**
   * A reader that answers by the query text and its variables.
   *
   * The search qualifier travels as the `q` variable, not inside the query text,
   * so the stub sees both: the text says which query was made and `q` says for
   * which repository and section.
   */
  function stubReader(answers: (query: string, variables: Record<string, unknown>) => unknown): GhReader {
    const client = createGhClient({ ghPath: "/nonexistent/gh" });
    return {
      client,
      api: async () => {
        throw new Error("not used");
      },
      graphql: async <T,>(query: string, variables: Record<string, unknown> = {}): Promise<T> =>
        answers(query, variables) as T,
    };
  }

  const row = (number: number, updatedAt: string) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.example.com/x/y/pull/${number}`,
    isDraft: false,
    state: "OPEN",
    updatedAt,
    author: { login: "other" },
    headRefName: "b",
    baseRefName: "main",
    reviewDecision: null,
    labels: { nodes: [] },
    commits: { nodes: [] },
  });

  it("merges two repositories into one section and sorts across them", async () => {
    const reader = stubReader((query, variables) => {
      if (query.includes("viewer { login }")) return { viewer: { login: "me" } };
      const q = String(variables["q"] ?? "");
      if (q.includes("author:me draft:false")) {
        return { search: { nodes: q.includes("repo:one/a") ? [row(1, "2026-10-01T00:00:00Z")] : [row(2, "2026-10-05T00:00:00Z")] } };
      }
      return { search: { nodes: [] } };
    });

    const payload: PrListPayload = await fetchPrList(reader, ["one/a", "two/b"]);
    expect(payload.repos).toEqual([{ repo: "one/a" }, { repo: "two/b" }]);
    const opened = payload.sections.find((section) => section.key === "opened");
    expect(opened?.prs.map((pr) => [pr.number, pr.repo])).toEqual([
      [2, "two/b"],
      [1, "one/a"],
    ]);
  });

  it("fails the whole fetch when one repository fails", async () => {
    const reader = stubReader((query, variables) => {
      if (query.includes("viewer { login }")) return { viewer: { login: "me" } };
      if (String(variables["q"] ?? "").includes("repo:bad/b")) throw new GhError("HTTP 404: Not Found");
      return { search: { nodes: [] } };
    });

    await expect(fetchPrList(reader, ["good/a", "bad/b"])).rejects.toBeInstanceOf(GhError);
  });

  it("refuses an empty repository list", async () => {
    const reader = stubReader(() => ({ viewer: { login: "me" } }));
    await expect(fetchPrList(reader, [])).rejects.toBeInstanceOf(GhError);
  });
});
