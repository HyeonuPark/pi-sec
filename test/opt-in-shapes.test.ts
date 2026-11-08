import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createInboxItemTx } from "../src/extensions/notify.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The two opt-in query parameters that make a first load smaller.
 *
 * `GET /api/inbox?cleared=exclude` answers with the items the page draws: the
 * ones the operator cleared are dropped, except the ones the revert button can
 * still bring back. `GET /api/jobs?shape=tree` answers with the one form the page
 * uses, instead of the same records twice. Without the parameter each route
 * answers exactly what it answered before, which is what the CLI and the scripts
 * read.
 */

describe("opt-in answer shapes", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<{ origin: string; harness: TestHarness }> {
    const created = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    harness = created;
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
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin, harness: created };
  }

  async function inboxItems(h: TestHarness, ids: string[]): Promise<void> {
    for (const id of ids) {
      await h.runtime.harness.commit((tx) => createInboxItemTx(tx, { id, title: `note ${id}`, body: "body" }), BACKGROUND_CONTEXT);
    }
  }

  async function prefer(origin: string, patch: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${origin}/api/preferences`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
  }

  const idsOf = async (url: string): Promise<string[]> => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { id: string }[] };
    return body.items.map((item) => item.id);
  };

  it("drops the items the operator cleared, and keeps the ones a revert can restore", async () => {
    const { origin, harness: h } = await boot();
    await inboxItems(h, ["a", "b", "c", "d", "e"]);
    await prefer(origin, {
      // `c` was cleared but is still in the revert queue, so its undo would have
      // nothing to restore. `d` and `e` are named by one group entry.
      clearedInbox: ["a", "c", "d", "e"],
      revertQueueInbox: ["c", "hide-all:d,e"],
    });

    // Without the parameter every item comes, as before.
    expect((await idsOf(`${origin}/api/inbox`)).sort()).toEqual(["a", "b", "c", "d", "e"]);

    const visible = await idsOf(`${origin}/api/inbox?cleared=exclude`);
    expect(visible.sort()).toEqual(["b", "c", "d", "e"]);
    // Only the one that was cleared and is not restorable is gone.
    expect(visible).not.toContain("a");
  }, 30_000);

  it("works together with unread=true", async () => {
    const { origin, harness: h } = await boot();
    await inboxItems(h, ["a", "b", "c"]);
    await prefer(origin, { clearedInbox: ["a", "b"], revertQueueInbox: ["b"] });
    // `b` is cleared but restorable, `c` was never cleared, `a` is cleared and gone.
    const read = await fetch(`${origin}/api/inbox/b/read`, { method: "POST" });
    expect(read.status).toBe(200);

    expect((await idsOf(`${origin}/api/inbox?unread=true`)).sort()).toEqual(["a", "c"]);
    expect((await idsOf(`${origin}/api/inbox?unread=true&cleared=exclude`)).sort()).toEqual(["c"]);
  }, 30_000);

  it("answers with nothing dropped when no item was ever cleared", async () => {
    const { origin, harness: h } = await boot();
    await inboxItems(h, ["a", "b"]);
    expect((await idsOf(`${origin}/api/inbox?cleared=exclude`)).sort()).toEqual(["a", "b"]);
  }, 30_000);

  it("returns the tree alone for shape=tree, with the same nodes and markers", async () => {
    const { origin } = await boot();
    const create = async (body: Record<string, unknown>): Promise<{ id: string }> => {
      const response = await fetch(`${origin}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const parent = await create({ title: "parent" });
    await create({ title: "child one", parentId: parent.id });
    await create({ title: "child two", parentId: parent.id });

    const full = (await (await fetch(`${origin}/api/jobs`)).json()) as {
      jobs: unknown[];
      tree: unknown;
      legacyScheduleProblem: string | null;
    };
    const shaped = (await (await fetch(`${origin}/api/jobs?shape=tree`)).json()) as {
      jobs?: unknown[];
      tree: unknown;
      legacyScheduleProblem: string | null;
    };

    expect(full.jobs).toHaveLength(3);
    expect(shaped.jobs).toBeUndefined();
    // The one form the page draws is the same answer in both.
    expect(shaped.tree).toEqual(full.tree);
    expect(shaped.legacyScheduleProblem).toBe(full.legacyScheduleProblem);
    // The derived marker travels with every node, so the page's job panel cannot
    // read "somebody is working here" out of one shape only.
    const nodes = JSON.stringify(shaped.tree);
    expect(nodes).toContain('"working":[]');
    expect((nodes.match(/"working":/g) ?? []).length).toBe(3);

    // A filter and the archive flag answer the same way in the shaped form.
    const filtered = (await (await fetch(`${origin}/api/jobs?shape=tree&status=planned`)).json()) as {
      jobs?: unknown[];
      tree: { job: { id: string } }[];
    };
    expect(filtered.jobs).toBeUndefined();
    expect(filtered.tree.map((node) => node.job.id)).toEqual([parent.id]);
    const withArchive = (await (await fetch(`${origin}/api/jobs?shape=tree&includeArchived=true`)).json()) as {
      archived?: unknown[];
    };
    expect(withArchive.archived).toEqual([]);
  }, 30_000);
});
