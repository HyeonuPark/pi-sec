import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReviewDraftStore,
  DraftInputError,
  MAX_COMMENTS,
  MAX_TEXT,
  readOp,
  type DraftComment,
  type DraftTarget,
  type ReviewDraftStore,
} from "../../src/extensions/github-pr/review-drafts.ts";

/**
 * The server's review draft store, one file per pull request, in a directory of
 * its own that each case makes with `mkdtemp`. Nothing here reads or writes a
 * real install path.
 */

const DAY = 24 * 60 * 60 * 1000;

function target(repo: string, number: number): DraftTarget {
  const [owner = "", name = ""] = repo.split("/");
  return { repo, owner, name, number };
}

function comment(id: string, extra: Partial<DraftComment> = {}): DraftComment {
  return {
    id,
    path: "src/a.ts",
    side: "RIGHT",
    line: 10,
    startLine: null,
    body: `body ${id}`,
    headSha: "1".repeat(40),
    anchor: { first: "const a = 1;", last: "const a = 1;" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("review draft store", () => {
  const roots: string[] = [];
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const warnings: string[] = [];
  const infos: Record<string, unknown>[] = [];

  async function fresh(): Promise<{ dir: string; store: ReviewDraftStore }> {
    const root = await mkdtemp(join(tmpdir(), "review-drafts-"));
    roots.push(root);
    const dir = join(root, "drafts");
    return { dir, store: open(dir) };
  }
  function open(dir: string): ReviewDraftStore {
    return createReviewDraftStore({
      dir,
      now: () => clock,
      logger: {
        info: (_m, fields) => void infos.push(fields ?? {}),
        warn: (message) => void warnings.push(message),
      },
    });
  }

  afterEach(() => {
    clock = Date.parse("2026-03-01T00:00:00.000Z");
    warnings.length = 0;
    infos.length = 0;
  });

  it("applies add, remove, set and discard, keeps one comment for a repeated add, and reads back", async () => {
    const { dir, store } = await fresh();
    const pr = target("acme/widgets", 7);
    expect((await store.get(pr)).comments).toEqual([]);

    await store.apply(pr, { op: "add", comment: comment("c1") });
    await store.apply(pr, { op: "add", comment: comment("c1") });
    await store.apply(pr, { op: "add", comment: comment("c2", { line: 20 }) });
    let draft = await store.apply(pr, { op: "set", summary: "overall", event: "APPROVE" });
    expect(draft.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(draft).toMatchObject({ summary: "overall", event: "APPROVE", repo: "acme/widgets", number: 7, listed: false });

    // A new store over the same directory reads the same draft.
    expect(await open(dir).get(pr)).toEqual(draft);

    draft = await store.apply(pr, { op: "remove", id: "c1" });
    expect(draft.comments.map((c) => c.id)).toEqual(["c2"]);
    // An unknown id changes nothing.
    expect((await store.apply(pr, { op: "remove", id: "nope" })).comments).toHaveLength(1);

    const names = await readdir(dir);
    expect(names).toEqual(["acme+widgets+7.json"]);
    expect((await stat(join(dir, names[0] ?? ""))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    await store.apply(pr, { op: "discard" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps two pull requests in two files, folds the case of a name, and deletes only its own file", async () => {
    const { dir, store } = await fresh();
    await store.apply(target("Acme/Widgets", 7), { op: "add", comment: comment("a") });
    await store.apply(target("acme/widgets", 7), { op: "add", comment: comment("b") });
    await store.apply(target("acme/widgets", 8), { op: "add", comment: comment("c") });
    expect((await readdir(dir)).sort()).toEqual(["acme+widgets+7.json", "acme+widgets+8.json"]);
    expect((await store.get(target("acme/widgets", 7))).comments.map((c) => c.id)).toEqual(["a", "b"]);

    // A change that leaves the draft empty deletes the file, and only that one.
    await store.apply(target("acme/widgets", 8), { op: "remove", id: "c" });
    expect(await readdir(dir)).toEqual(["acme+widgets+7.json"]);
    await store.apply(target("acme/widgets", 7), { op: "discard" });
    expect(await readdir(dir)).toEqual([]);

    // A verdict alone is not kept.
    await store.apply(target("acme/widgets", 9), { op: "set", event: "APPROVE" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a request over a limit, and a name that fails the second guard, with no file", async () => {
    const { dir, store } = await fresh();
    const pr = target("acme/widgets", 7);
    await store.apply(pr, { op: "add", comment: comment("c1") });
    const before = await readFile(join(dir, "acme+widgets+7.json"), "utf8");

    expect(() => readOp({ op: "add", comment: { ...comment("x"), body: "x".repeat(MAX_TEXT + 1) } }, "t")).toThrow(DraftInputError);
    expect(() => readOp({ op: "set", summary: "x".repeat(MAX_TEXT + 1) }, "t")).toThrow(DraftInputError);
    expect(() => readOp({ op: "bogus" }, "t")).toThrow(DraftInputError);
    for (let index = 0; index < MAX_COMMENTS; index += 1) {
      await store.apply(target("acme/many", 1), { op: "add", comment: comment(`m${index}`) });
    }
    await expect(store.apply(target("acme/many", 1), { op: "add", comment: comment("over") })).rejects.toThrow(DraftInputError);
    expect(await readFile(join(dir, "acme+widgets+7.json"), "utf8")).toBe(before);

    const outside = await readdir(join(dir, ".."));
    for (const bad of [
      target("acme/..", 1),
      { repo: "x/y", owner: "..", name: "x", number: 1 },
      { repo: "x/y", owner: "acme", name: "a/b", number: 1 },
      target("a/b+c", 1),
      target("ac+me/widgets", 1),
      { repo: "x/y", owner: "acme", name: "widgets", number: 0 },
    ]) {
      await expect(store.apply(bad, { op: "add", comment: comment("z") })).rejects.toThrow(DraftInputError);
      await expect(store.get(bad)).rejects.toThrow(DraftInputError);
    }
    expect(await readdir(join(dir, ".."))).toEqual(outside);
    expect((await readdir(dir)).filter((n) => n.includes("z") || n.includes(".."))).toEqual([]);
  });

  it("removes a leftover temporary file at start and sets an unreadable file aside under a new name", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-drafts-"));
    roots.push(root);
    const dir = join(root, "drafts");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".acme+widgets+7.json.tmp-1-abcdef"), "{");
    await writeFile(join(dir, "acme+widgets+8.json"), "{ not json");
    await writeFile(join(dir, "notes.txt"), "keep me");
    const store = open(dir);
    await store.ready();
    expect((await readdir(dir)).sort()).toEqual(["acme+widgets+8.json", "notes.txt"]);

    const answer = await store.get(target("acme/widgets", 8));
    expect(answer.comments).toEqual([]);
    const aside = `acme+widgets+8.json.unreadable-${clock}`;
    expect((await readdir(dir)).sort()).toEqual([aside, "notes.txt"]);
    expect(warnings).toEqual(["github-pr draft file is not readable and was set aside"]);
    expect(infos).toEqual([]);

    // Nothing in the store deletes a set-aside file, however old it is.
    const old = new Date(clock - 400 * DAY);
    await utimes(join(dir, aside), old, old);
    await open(dir).ready();
    expect((await readdir(dir)).sort()).toEqual([aside, "notes.txt"]);
  });

  it("lands two changes sent at the same time, in order", async () => {
    const { dir, store } = await fresh();
    const pr = target("acme/widgets", 7);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.apply(pr, { op: "add", comment: comment(`c${index}`) })),
    );
    expect(results.map((r) => r.comments.length)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const parsed = JSON.parse(await readFile(join(dir, "acme+widgets+7.json"), "utf8")) as { comments: { id: string }[] };
    expect(parsed.comments.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
  });

  it("removes the submitted comments and the summary and keeps the others", async () => {
    const { dir, store } = await fresh();
    const pr = target("acme/widgets", 7);
    await store.apply(pr, { op: "add", comment: comment("a") });
    await store.apply(pr, { op: "add", comment: comment("b") });
    await store.apply(pr, { op: "set", summary: "s" });
    await store.removeSubmitted(pr, ["a"]);
    const draft = await store.get(pr);
    expect(draft.comments.map((c) => c.id)).toEqual(["b"]);
    expect(draft.summary).toBe("");
    await store.removeSubmitted(pr, ["b"]);
    expect(await readdir(dir)).toEqual([]);
  });
});
