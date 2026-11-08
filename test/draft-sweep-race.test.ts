import { afterEach, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DraftStore } from "../src/reports/drafts.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

describe("the draft sweep against a draft written while it runs", () => {
  let h: TestHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("keeps a draft whose row was committed after the sweep listed the rows", async () => {
    h = await createTestHarness();
    const job = (await h.runtime.jobs.create(ctx, { title: "work" })).id;
    const store = new DraftStore({ harness: () => h!.runtime.harness, paths: h.paths, storage: h.runtime.storage, audit: h.runtime.audit });
    const list = store.list.bind(store);
    let created: { id: string; path: string } | undefined;
    store.list = async (c) => {
      const rows = await list(c);
      if (created === undefined) {
        created = await store.create(ctx, { agentConversationId: "1", jobId: job, title: "T", content: "body\n" });
      }
      return rows;
    };
    await store.sweep(ctx, h.runtime.jobs);
    expect(created).toBeDefined();
    expect(await stat(created!.path).catch(() => undefined)).toBeDefined();
    expect(await store.readById(ctx, created!.id)).toBeDefined();
  });

  it("keeps a draft whose body is written and whose row is not committed yet", async () => {
    h = await createTestHarness();
    const job = (await h.runtime.jobs.create(ctx, { title: "work" })).id;
    const real = h.runtime.harness;
    let armed = true;
    let reached!: () => void;
    const atCommit = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated = {
      snapshot: (...args: Parameters<Harness["snapshot"]>) => real.snapshot(...args),
      commit: async (...args: Parameters<Harness["commit"]>) => {
        if (armed) {
          armed = false;
          reached();
          await gate;
        }
        return await real.commit(...args);
      },
    } as unknown as Harness;
    const store = new DraftStore({ harness: () => gated, paths: h.paths, storage: h.runtime.storage, audit: h.runtime.audit });
    const creating = store.create(ctx, { agentConversationId: "1", jobId: job, title: "T", content: "body\n" });
    await atCommit;
    await store.sweep(ctx, h.runtime.jobs);
    release();
    const created = await creating;
    expect(await store.readById(ctx, created.id)).toBeDefined();
  });

  it("still removes a body that no row names", async () => {
    h = await createTestHarness();
    const store = new DraftStore({ harness: () => h!.runtime.harness, paths: h.paths, storage: h.runtime.storage, audit: h.runtime.audit });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(store.dir, { recursive: true });
    const stray = store.pathFor("01JRACEORPHAN00000000000000");
    await writeFile(stray, "left behind\n");
    expect(await store.sweep(ctx, h.runtime.jobs)).toEqual({ retired: 0, orphanFiles: 1 });
    expect(await stat(stray).catch(() => undefined)).toBeUndefined();
  });
});
