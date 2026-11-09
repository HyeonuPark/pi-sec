import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecSettings } from "../src/documents.ts";
import { UI_PREFERENCE_KEYS } from "../src/prefs/store.ts";
import { CONTROL_EVENTS } from "../src/server/streams.ts";
import { injectPreferences } from "../src/server/static.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

/** What a document with nothing chosen answers: no theme, no fold list, revision 0. */
const EMPTY = {
  hiddenJobs: [],
  expandedJobs: [],
  clearedInbox: [],
  revertQueueJobs: [],
  revertQueueInbox: [],
  collapsedJobs: [],
  uiRevision: 0,
};

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
    expect(await read(origin)).toEqual(EMPTY);

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
    expect(await read(origin)).toEqual(EMPTY);
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
    expect(await response.json()).toEqual(EMPTY);
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
      ...EMPTY,
      revertQueueJobs: ["job-1", "job-2"],
      revertQueueInbox: ["note-1"],
      uiRevision: 1,
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
    expect(await response.json()).toEqual(EMPTY);
  });
});

describe("the shared UI state", () => {
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

  /** The `preferences_updated` events the bus carried, from now on. */
  function watchUpdates(): Record<string, unknown>[] {
    const seen: Record<string, unknown>[] = [];
    harness!.events.subscribe((event) => {
      if (event.type === "preferences_updated") seen.push(event.data as Record<string, unknown>);
    });
    return seen;
  }

  it("round-trips the theme, both fold lists and the folded groups", async () => {
    const origin = await boot();
    const response = await patch(origin, {
      theme: "dark",
      foldedWide: ["jobs", "inbox"],
      foldedNarrow: ["machines"],
      collapsedJobs: ["job-1"],
    });
    expect(response.status).toBe(200);
    const expected = {
      theme: "dark",
      // The store keeps a fold list in the sidebar's own order.
      foldedWide: ["inbox", "jobs"],
      foldedNarrow: ["machines"],
      collapsedJobs: ["job-1"],
    };
    expect(await response.json()).toMatchObject(expected);
    expect(await read(origin)).toMatchObject(expected);
  });

  it("refuses a theme outside the three modes and a fold name outside the foldable panels", async () => {
    const origin = await boot();
    expect((await patch(origin, { theme: "purple" })).status).toBe(400);
    expect((await patch(origin, { theme: 3 })).status).toBe(400);
    expect((await patch(origin, { foldedWide: ["notes"] })).status).toBe(400);
    expect((await patch(origin, { foldedNarrow: "inbox" })).status).toBe(400);
    expect((await patch(origin, { foldedWide: ["inbox", 7] })).status).toBe(400);
    expect((await patch(origin, { baseRevision: "1", theme: "dark" })).status).toBe(400);
    expect((await patch(origin, { baseRevision: -1, theme: "dark" })).status).toBe(400);
    expect(await read(origin)).toEqual(EMPTY);
  });

  it("raises uiRevision by one for a change and not for a write that changes nothing", async () => {
    const origin = await boot();
    const updates = watchUpdates();

    expect(((await (await patch(origin, { theme: "dark" })).json()) as { uiRevision: number }).uiRevision).toBe(1);
    // The same value again is not a change.
    expect(((await (await patch(origin, { theme: "dark" })).json()) as { uiRevision: number }).uiRevision).toBe(1);
    expect(((await (await patch(origin, { hiddenJobs: [] })).json()) as { uiRevision: number }).uiRevision).toBe(1);
    expect(((await (await patch(origin, { hiddenJobs: ["job-1"] })).json()) as { uiRevision: number }).uiRevision).toBe(2);
    expect(((await (await patch(origin, { hiddenJobs: ["job-1", "job-1"] })).json()) as { uiRevision: number }).uiRevision).toBe(2);

    // One event per changing write, carrying the revision and nothing else.
    expect(updates).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("refuses a stale baseRevision with 409 and the current state, and writes nothing", async () => {
    const origin = await boot();
    await patch(origin, { hiddenJobs: ["job-1"] });
    const updates = watchUpdates();

    const stale = await patch(origin, { hiddenJobs: ["job-2"], baseRevision: 0 });

    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string }; current: { hiddenJobs: string[]; uiRevision: number } };
    expect(body.error.code).toBe("preferences_conflict");
    expect(body.current).toMatchObject({ hiddenJobs: ["job-1"], uiRevision: 1 });
    expect(await read(origin)).toMatchObject({ hiddenJobs: ["job-1"], uiRevision: 1 });
    expect(updates).toEqual([]);

    // The same press on the current state, with the revision the answer named.
    const retry = await patch(origin, { hiddenJobs: ["job-1", "job-2"], baseRevision: 1 });
    expect(retry.status).toBe(200);
    expect(await read(origin)).toMatchObject({ hiddenJobs: ["job-1", "job-2"], uiRevision: 2 });
  });

  it("accepts a save without baseRevision, as an older page sends it", async () => {
    const origin = await boot();
    await patch(origin, { hiddenJobs: ["job-1"] });
    await patch(origin, { hiddenJobs: ["job-1", "job-2"] });
    expect(await read(origin)).toMatchObject({ hiddenJobs: ["job-1", "job-2"], uiRevision: 2 });
  });

  it("keeps two writes that arrive together from losing either, in the order the server committed them", async () => {
    const origin = await boot();
    const [first, second] = await Promise.all([
      patch(origin, { hiddenJobs: ["job-1"], baseRevision: 0 }),
      patch(origin, { hiddenJobs: ["job-2"], baseRevision: 0 }),
    ]);
    // One of the two was stale by the time it committed and was refused whole.
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(((await read(origin)) as { uiRevision: number }).uiRevision).toBe(1);
  });

  it("seeds the theme and the fold lists only where none is stored", async () => {
    const origin = await boot();
    const updates = watchUpdates();

    await patch(origin, { theme: "dark", foldedWide: ["jobs"], seedOnly: true });
    expect(await read(origin)).toMatchObject({ theme: "dark", foldedWide: ["jobs"], uiRevision: 1 });

    // Another browser's carry finds a theme and a wide list, and fills only the narrow list.
    await patch(origin, { theme: "light", foldedWide: ["inbox"], foldedNarrow: ["machines"], seedOnly: true });
    expect(await read(origin)).toMatchObject({
      theme: "dark",
      foldedWide: ["jobs"],
      foldedNarrow: ["machines"],
      uiRevision: 2,
    });

    // With nothing left to fill it changes nothing, and says nothing.
    await patch(origin, { theme: "auto", foldedNarrow: [], seedOnly: true });
    expect(await read(origin)).toMatchObject({ theme: "dark", foldedNarrow: ["machines"], uiRevision: 2 });
    expect(updates).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("leaves the agent's notes alone when the UI fields change", async () => {
    const origin = await boot();
    await harness!.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecSettings);
      draft.notes = "written by the agent";
    }, ctx);

    await patch(origin, { theme: "light", foldedNarrow: ["inbox"], collapsedJobs: ["job-1"] });

    const stored = await harness!.runtime.harness.snapshot(SecSettings, ctx);
    expect(stored?.notes).toBe("written by the agent");
    expect(stored?.theme).toBe("light");
  });

  it("holds preferences_updated in the control events", () => {
    expect(CONTROL_EVENTS.has("preferences_updated")).toBe(true);
  });

  it("carries preferences_updated on the chats list stream, with the revision only", async () => {
    const origin = await boot();
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/focused-chats/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`the stream ended before ${needle}`);
        text += decoder.decode(chunk.value);
      }
    };
    await until("event: snapshot");

    await patch(origin, { theme: "dark" });
    await until("event: preferences_updated");
    controller.abort();

    const frame = text.split("\n\n").find((entry) => entry.includes("event: preferences_updated"))!;
    const data = frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5).trim();
    expect(JSON.parse(data)).toEqual({ revision: 1 });
  });
});

describe("the page stamp", () => {
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

  const PAGES = ["/basic-chat", "/chats", "/report", "/usage", "/usage/stats"];

  const stampOf = (html: string): Record<string, unknown> => {
    const match = /<meta name="pi-sec-preferences" content="([^"]*)"/.exec(html);
    expect(match, "the page has no preferences stamp").not.toBeNull();
    return JSON.parse(match![1]!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown>;
  };

  it("puts the stored theme on <html> and the folds in the stamp, on each of the five pages", async () => {
    const origin = await boot();
    await fetch(`${origin}/api/preferences`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark", foldedWide: ["jobs"], foldedNarrow: ["inbox", "machines"] }),
    });

    for (const path of PAGES) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toMatch(/<html lang="en" data-theme="dark">/);
      expect(stampOf(html), path).toEqual({
        theme: "dark",
        foldedWide: ["jobs"],
        foldedNarrow: ["inbox", "machines"],
        uiRevision: 1,
      });
    }
  });

  it("leaves auto on <html> and stamps only the revision when nothing is stored", async () => {
    const origin = await boot();
    for (const path of PAGES) {
      const html = await (await fetch(`${origin}${path}`)).text();
      expect(html, path).toMatch(/<html lang="en" data-theme="auto">/);
      expect(stampOf(html), path).toEqual({ uiRevision: 0 });
    }
  });

  it("escapes markup in a stored value, in the attribute and in the stamp", async () => {
    const origin = await boot();
    // The route refuses such a value, so it is written into the document the way a
    // damaged one could be.
    await harness!.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecSettings);
      draft.theme = '"><script>alert(1)</script>';
    }, ctx);
    const html = await (await fetch(`${origin}/usage`)).text();
    expect(html).not.toContain("<script>alert(1)");
    // A stored theme that is not one of the three modes is not stamped at all.
    expect(html).toMatch(/<html lang="en" data-theme="auto">/);
  });

  it("escapes markup in what it stamps, when handed such a value directly", () => {
    const shell =
      '<html lang="en" data-theme="auto"><head><meta name="pi-sec-preferences" content="" /></head></html>';
    const out = injectPreferences(shell, { theme: '"><b>x</b>', foldedWide: ["<i>"], uiRevision: 2 });
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>");
    expect(out).toContain("data-theme=\"&quot;&gt;&lt;b&gt;x&lt;/b&gt;\"");
    expect(out).toContain("&lt;i&gt;");
  });

  it("leaves a page without the meta as it is", () => {
    const shell = '<html lang="en" data-theme="auto"><head></head></html>';
    expect(injectPreferences(shell, { theme: "dark", uiRevision: 1 })).toBe(shell);
    expect(injectPreferences('<html data-theme="auto"><meta name="pi-sec-preferences" content="" />', undefined)).toBe(
      '<html data-theme="auto"><meta name="pi-sec-preferences" content="" />',
    );
  });
});
