import { describe, expect, it } from "vitest";
import type { GhReader } from "../../src/extensions/github-pr/gh.ts";
import type { PrListPayload, PrRow } from "../../src/extensions/github-pr/list.ts";
import {
  buildPendingReviews,
  draftKeys,
  offListTargets,
  readPendingFacts,
  type PendingPr,
} from "../../src/extensions/github-pr/pending.ts";
import type { StoredEntry } from "../../src/extensions/github-pr/review-drafts.ts";

/** The pure join of the Pending reviews section and the poll's per-pull-request read, with fakes only. */

function row(repo: string, number: number, title: string, extra: Partial<PrRow> = {}): PrRow {
  return {
    number,
    title,
    url: `https://github.example.com/${repo}/pull/${number}`,
    isDraft: false,
    author: "someone",
    updatedAt: "2026-10-01T00:00:00Z",
    headRefName: "topic",
    baseRefName: "main",
    reviewDecision: null,
    labels: [],
    ciState: null,
    repo,
    ...extra,
  };
}

function listOf(...rows: PrRow[]): PrListPayload {
  return {
    viewer: "me",
    repos: [{ repo: "acme/widgets" }],
    sections: [{ key: "need-review", title: "Need review", prs: rows }],
  };
}

function draft(repo: string, number: number, savedAt: string): StoredEntry {
  return { kind: "draft", repo, number, comments: 2, summary: true, event: "COMMENT", savedAt };
}

const FACT: PendingPr = {
  title: "Merged one",
  url: "https://github.example.com/acme/widgets/pull/4",
  state: "MERGED",
  isDraft: false,
  author: "other",
  updatedAt: "2026-09-01T00:00:00Z",
};

describe("pending reviews", () => {
  it("takes a listed pull request from the list, an off-list one from the poll facts, and leaves an unknown one null", () => {
    const rows = buildPendingReviews(
      [
        draft("acme/widgets", 12, "2026-10-03T00:00:00.000Z"),
        draft("acme/widgets", 4, "2026-10-02T00:00:00.000Z"),
        draft("acme/widgets", 5, "2026-10-01T00:00:00.000Z"),
      ],
      listOf(row("acme/widgets", 12, "On the list", { isDraft: true })),
      new Map([["acme/widgets#4", FACT]]),
      ["acme/widgets"],
    );
    expect(rows.map((r) => r.kind === "draft" && r.pr)).toEqual([
      {
        title: "On the list",
        url: "https://github.example.com/acme/widgets/pull/12",
        state: "OPEN",
        isDraft: true,
        author: "someone",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      FACT,
      null,
    ]);
  });

  it("marks a repository that is not in the settings, and names the stored spelling", () => {
    const rows = buildPendingReviews(
      [draft("Old/Tool", 4, "2026-10-02T00:00:00.000Z"), draft("acme/widgets", 1, "2026-10-01T00:00:00.000Z")],
      undefined,
      new Map(),
      ["Acme/Widgets"],
    );
    expect(rows).toMatchObject([
      { kind: "draft", repo: "Old/Tool", configured: false },
      { kind: "draft", repo: "Acme/Widgets", configured: true },
    ]);
  });

  it("sorts by savedAt, newest first, and puts set-aside files among them by modification time", () => {
    const rows = buildPendingReviews(
      [
        draft("acme/widgets", 1, "2026-10-01T00:00:00.000Z"),
        { kind: "unreadable", repo: "acme/widgets", number: 7, file: "acme+widgets+7.json.unreadable-1", savedAt: "2026-10-02T00:00:00.000Z" },
        draft("acme/widgets", 3, "2026-10-03T00:00:00.000Z"),
      ],
      undefined,
      new Map(),
      ["acme/widgets"],
    );
    expect(rows.map((r) => r.number)).toEqual([3, 7, 1]);
    expect(rows[1]).toEqual({
      kind: "unreadable",
      repo: "acme/widgets",
      number: 7,
      file: "acme+widgets+7.json.unreadable-1",
      savedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("names the drafts of a list and keeps set-aside files out of it", () => {
    const entries: StoredEntry[] = [
      draft("Acme/Widgets", 12, "x"),
      { kind: "unreadable", repo: "acme/widgets", number: 7, file: "f", savedAt: "x" },
    ];
    expect([...draftKeys(entries)]).toEqual(["acme/widgets#12"]);
    expect(offListTargets(entries, listOf(row("acme/widgets", 12, "t")))).toEqual([]);
    expect(offListTargets(entries, listOf())).toEqual([{ repo: "Acme/Widgets", owner: "Acme", name: "Widgets", number: 12 }]);
  });

  it("keeps the earlier facts when a read fails, drops facts of a draft that is gone, and reads nothing for a pull request on the list", async () => {
    const asked: number[] = [];
    const warnings: string[] = [];
    const reader: GhReader = {
      graphql: (async (_query: string, variables?: Record<string, unknown>) => {
        const number = variables?.["number"] as number;
        asked.push(number);
        if (number === 4) throw new Error("GitHub is down");
        return { repository: { pullRequest: { number, title: `Title ${number}`, url: "u", state: "CLOSED", isDraft: false, updatedAt: "t", author: null } } };
      }) as GhReader["graphql"],
      rest: (async () => ({})) as unknown as GhReader["rest"],
    } as GhReader;
    const previous = new Map<string, PendingPr>([
      ["acme/widgets#4", FACT],
      ["acme/widgets#99", { ...FACT, title: "gone" }],
    ]);
    const targets = offListTargets(
      [draft("acme/widgets", 12, "x"), draft("acme/widgets", 4, "x"), draft("acme/widgets", 5, "x")],
      listOf(row("acme/widgets", 12, "on the list")),
    );
    const next = await readPendingFacts(reader, targets, previous, { warn: (message) => void warnings.push(message) });
    expect(asked).toEqual([4, 5]);
    expect([...next.keys()]).toEqual(["acme/widgets#4", "acme/widgets#5"]);
    expect(next.get("acme/widgets#4")).toEqual(FACT);
    expect(next.get("acme/widgets#5")).toMatchObject({ title: "Title 5", state: "CLOSED", author: null });
    expect(warnings).toEqual(["github-pr saved review facts could not be read"]);
  });
});
