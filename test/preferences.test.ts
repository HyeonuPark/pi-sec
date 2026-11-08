import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecSettings } from "../src/documents.ts";
import { UI_PREFERENCE_KEYS } from "../src/prefs/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

describe("preferences", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<string> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime: harness.runtime,
      bus: harness.events,
      sse,
      streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return started.origin;
  }

  const read = async (origin: string) => (await fetch(`${origin}/api/preferences`)).json();
  const patch = (origin: string, body: unknown) =>
    fetch(`${origin}/api/preferences`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("starts empty and changes one list at a time", async () => {
    const origin = await boot();
    expect(await read(origin)).toEqual({
      hiddenJobs: [],
      expandedJobs: [],
      clearedInbox: [],
      revertQueueJobs: [],
      revertQueueInbox: [],
    });

    const first = await patch(origin, { hiddenJobs: ["job-1"] });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ hiddenJobs: ["job-1"], expandedJobs: [], clearedInbox: [] });

    // A second client toggling another list must not undo the first.
    const second = await patch(origin, { clearedInbox: ["note-1"] });
    expect(await second.json()).toMatchObject({ hiddenJobs: ["job-1"], clearedInbox: ["note-1"] });
    expect(await read(origin)).toMatchObject({ hiddenJobs: ["job-1"], clearedInbox: ["note-1"] });
  });

  it("leaves the agent's own preferences alone", async () => {
    const origin = await boot();
    await harness!.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecSettings);
      draft.notes = "written by the agent";
    }, ctx);

    await patch(origin, { hiddenJobs: ["job-1"] });

    const stored = await harness!.runtime.harness.snapshot(SecSettings, ctx);
    expect(stored?.notes).toBe("written by the agent");
    expect(stored?.hiddenJobs).toEqual(["job-1"]);
  });

  it("refuses a list that is not a list of ids", async () => {
    const origin = await boot();
    expect((await patch(origin, { hiddenJobs: "job-1" })).status).toBe(400);
    expect((await patch(origin, { hiddenJobs: ["job-1", 7] })).status).toBe(400);
    expect((await patch(origin, "nonsense")).status).toBe(400);

    // Nothing was written by the refused calls.
    expect(await read(origin)).toEqual({
      hiddenJobs: [],
      expandedJobs: [],
      clearedInbox: [],
      revertQueueJobs: [],
      revertQueueInbox: [],
    });
  });

  it("keeps only usable ids", async () => {
    const origin = await boot();
    const body = (await (await patch(origin, { hiddenJobs: ["job-1", "job-1", "  ", "job-2"] })).json()) as {
      hiddenJobs: string[];
    };
    expect(body.hiddenJobs).toEqual(["job-1", "job-2"]);
  });

  it("treats a patch with nothing in it as a read", async () => {
    const origin = await boot();
    const response = await patch(origin, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hiddenJobs: [],
      expandedJobs: [],
      clearedInbox: [],
      revertQueueJobs: [],
      revertQueueInbox: [],
    });
  });

  // The route drops a key that is not in `UI_PREFERENCE_KEYS` and still answers
  // 200. If `revertQueueJobs` or `revertQueueInbox` were missing from that list,
  // the queues below would read back empty after a successful-looking write, so
  // the round trip is what pins the two names.
  it("round-trips the two revert queues", async () => {
    const origin = await boot();
    const response = await patch(origin, { revertQueueJobs: ["job-1", "job-2"], revertQueueInbox: ["note-1"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revertQueueJobs: ["job-1", "job-2"],
      revertQueueInbox: ["note-1"],
    });

    // The queues come back on the next read, and the lists are untouched.
    expect(await read(origin)).toEqual({
      hiddenJobs: [],
      expandedJobs: [],
      clearedInbox: [],
      revertQueueJobs: ["job-1", "job-2"],
      revertQueueInbox: ["note-1"],
    });
  });

  it("caps each revert queue at ten and drops the oldest cell", async () => {
    const origin = await boot();
    const eleven = ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9", "j10", "j11"];

    const jobs = (await (await patch(origin, { revertQueueJobs: eleven })).json()) as { revertQueueJobs: string[] };
    // The newest ten survive: a tail trim would answer with j1..j10 instead.
    expect(jobs.revertQueueJobs).toEqual(eleven.slice(1));
    expect(jobs.revertQueueJobs).toHaveLength(10);

    // The cap is per key: the inbox queue has its own ten cells.
    const inbox = (await (
      await patch(origin, { revertQueueInbox: ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"] })
    ).json()) as { revertQueueInbox: string[] };
    expect(inbox.revertQueueInbox).toEqual(["n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]);

    // An overflowing queue is trimmed, not refused, and the jobs queue kept its
    // own ten across the second write.
    const both = (await read(origin)) as { revertQueueJobs: string[]; revertQueueInbox: string[] };
    expect(both.revertQueueJobs).toEqual(eleven.slice(1));
    expect(both.revertQueueInbox).toEqual(["n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]);
  });

  it("keeps a repeated id once, at the end of the queue", async () => {
    const origin = await boot();
    const body = (await (
      await patch(origin, { revertQueueJobs: ["job-1", "job-2", "job-1"] })
    ).json()) as { revertQueueJobs: string[] };
    // A queue remembers one cell per id, and the newest sighting is the recent
    // one, so the repeated id moves to the end instead of keeping its first cell.
    expect(body.revertQueueJobs).toEqual(["job-2", "job-1"]);
  });

  it("saves and reads back every key in the store's list", async () => {
    const origin = await boot();
    // One value per key, taken from the list itself: a key the route accepts and
    // the store then drops reads back empty, and a key missing from either list
    // never appears here at all. The lists and the queues are checked the same
    // way, so a key that needs its own rule cannot be added to one half only.
    for (const [index, key] of UI_PREFERENCE_KEYS.entries()) {
      const value = [`${key}-${index}`];
      const response = await patch(origin, { [key]: value });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ [key]: value });
      expect(await read(origin)).toMatchObject({ [key]: value });
    }
  });

  it("ignores a key that is not in the route's list", async () => {
    const origin = await boot();
    const response = await patch(origin, { revertQueueJobz: ["job-1"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hiddenJobs: [],
      expandedJobs: [],
      clearedInbox: [],
      revertQueueJobs: [],
      revertQueueInbox: [],
    });
  });
});
