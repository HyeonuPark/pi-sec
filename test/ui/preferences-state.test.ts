// @vitest-environment jsdom
/**
 * The page's side of the shared UI state: reading the record, saving a press as an
 * intent with the revision the page last saw, the retry after a `409`, and the
 * rule that applying a server answer never saves.
 *
 * The server is `fakePreferences`, which refuses a stale `baseRevision` the way the
 * route does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAVE_ATTEMPTS,
  applyPreferences,
  applyPreferencesEvent,
  currentRevision,
  onPreferences,
  readPreferences,
  resetPreferencesState,
  revisionOf,
  savePreferenceIntent,
  stampedPreferences,
  type SharedPreferences,
} from "../../src/ui/state/preferences.ts";
import { clearJob, collapsedJobs, hiddenJobs, resetJobsState, toggleJobChildren } from "../../src/ui/state/jobs.ts";
import { toast, hideToast } from "../../src/ui/state/toast.ts";
import { fakePreferences, type FakePreferences } from "./preferences-fake.ts";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

let calls: Call[] = [];
let server: FakePreferences;
/** Lets a test change what the next PATCH answers, for example to refuse it again. */
let override: ((call: Call) => { status: number; body: unknown } | undefined) | undefined;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const patches = () => calls.filter((call) => call.method === "PATCH").map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);
const gets = () => calls.filter((call) => call.method === "GET");

function response(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => text } as Response;
}

beforeEach(() => {
  calls = [];
  override = undefined;
  server = fakePreferences();
  resetJobsState();
  hideToast();
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Call = { url: String(input), method: (init?.method ?? "GET").toUpperCase(), body: init?.body ?? null };
    calls.push(call);
    const forced = override?.(call);
    const answered = forced ?? server.handle(call);
    return response(answered.status, answered.body);
  };
  document.head.innerHTML = "";
});

afterEach(() => {
  resetJobsState();
});

describe("reading the record", () => {
  it("applies the answer to every registered module, and the revision follows", async () => {
    const seen: SharedPreferences[] = [];
    onPreferences((record) => seen.push(record));
    server.external({ theme: "dark" });

    await readPreferences();

    expect(seen.at(-1)?.theme).toBe("dark");
    expect(currentRevision()).toBe(1);
  });

  it("serves callers that ask while a read is out with that one read", async () => {
    await Promise.all([readPreferences(), readPreferences(), readPreferences()]);
    expect(gets()).toHaveLength(1);
  });

  it("keeps what it holds when the read fails", async () => {
    await readPreferences();
    override = () => ({ status: 500, body: {} });
    server.external({ theme: "light" });

    const kept = await readPreferences();

    expect(kept?.theme).toBeUndefined();
  });

  it("applies nothing older than what it already holds", async () => {
    applyPreferences({ theme: "dark", uiRevision: 5 });
    const seen: SharedPreferences[] = [];
    onPreferences((record) => seen.push(record));

    applyPreferences({ theme: "light", uiRevision: 4 });

    expect(seen).toEqual([]);
    expect(currentRevision()).toBe(5);
  });

  it("reads the record the server stamped into the page", () => {
    const meta = document.createElement("meta");
    meta.name = "pi-sec-preferences";
    meta.content = JSON.stringify({ theme: "dark", foldedWide: ["jobs"], uiRevision: 3 });
    document.head.append(meta);
    resetPreferencesState();

    expect(stampedPreferences()).toEqual({ theme: "dark", foldedWide: ["jobs"], uiRevision: 3 });
    expect(currentRevision()).toBe(3);
  });

  it("treats an empty or unreadable stamp as no stamp", () => {
    for (const content of ["", "{broken", "[1]"]) {
      document.head.innerHTML = "";
      const meta = document.createElement("meta");
      meta.name = "pi-sec-preferences";
      meta.content = content;
      document.head.append(meta);
      resetPreferencesState();
      expect(stampedPreferences()).toBeUndefined();
    }
  });
});

describe("the event", () => {
  it("names a revision, and a page that already holds it reads nothing", async () => {
    await readPreferences();
    server.external({ theme: "dark" });
    await readPreferences();
    calls = [];

    applyPreferencesEvent(1);
    applyPreferencesEvent(0);
    await settle();

    expect(calls).toEqual([]);
    expect(revisionOf({ revision: 4 })).toBe(4);
    expect(revisionOf({})).toBeUndefined();
    expect(revisionOf("text")).toBeUndefined();
  });

  it("reads the record back when it names a newer revision, and saves nothing", async () => {
    await readPreferences();
    calls = [];
    server.external({ theme: "dark" });

    applyPreferencesEvent(1);
    await settle();

    expect(gets()).toHaveLength(1);
    expect(patches()).toEqual([]);
    expect(currentRevision()).toBe(1);
  });
});

describe("saving a press", () => {
  it("sends the result of the intent with the revision the page last saw", async () => {
    await readPreferences();

    await savePreferenceIntent(() => ({ theme: "dark" }), "theme");

    expect(patches()).toEqual([{ theme: "dark", baseRevision: 0 }]);
    expect(currentRevision()).toBe(1);
  });

  it("reads the record first when the page holds none, so the intent never works on an empty list", async () => {
    server.external({ hiddenJobs: ["job-9"] });

    await savePreferenceIntent((current) => ({ hiddenJobs: [...(current.hiddenJobs ?? []), "job-1"] }), "hiddenJobs list");

    expect(patches()).toEqual([{ hiddenJobs: ["job-9", "job-1"], baseRevision: 1 }]);
  });

  it("applies the same press to the current state after a 409, and saves once more", async () => {
    await readPreferences();
    // Another browser clears job 1 while this page still holds revision 0.
    server.external({ hiddenJobs: ["job-1"] });

    await savePreferenceIntent((current) => ({ hiddenJobs: [...(current.hiddenJobs ?? []), "job-2"] }), "hiddenJobs list");

    expect(patches()).toEqual([
      { hiddenJobs: ["job-2"], baseRevision: 0 },
      { hiddenJobs: ["job-1", "job-2"], baseRevision: 1 },
    ]);
    // Both clears are on the server, and no 409 is left over.
    expect(server.state()["hiddenJobs"]).toEqual(["job-1", "job-2"]);
  });

  it("keeps both clears when an old tab clears a second job through the page's own control", async () => {
    // The page holds revision 0 with nothing cleared.
    await readPreferences();
    server.external({ hiddenJobs: ["job-1"] });

    clearJob("job-2");
    await settle();
    await settle();

    expect(server.state()["hiddenJobs"]).toEqual(["job-1", "job-2"]);
    // The page now draws both.
    expect([...hiddenJobs.value].sort()).toEqual(["job-1", "job-2"]);
  });

  it("stops after three tries and shows the save error", async () => {
    await readPreferences();
    let refused = 0;
    override = (call) => {
      if (call.method !== "PATCH") return undefined;
      refused += 1;
      server.external({ expandedJobs: [`other-${refused}`] });
      return {
        status: 409,
        body: { error: { code: "preferences_conflict", message: "stale" }, current: server.state() },
      };
    };

    await savePreferenceIntent(() => ({ theme: "dark" }), "theme");

    expect(SAVE_ATTEMPTS).toBe(3);
    expect(patches()).toHaveLength(3);
    expect(toast.value?.text ?? "").toContain("Could not save the theme");
  });

  it("shows the save error for a refusal that is not a conflict, without a retry", async () => {
    await readPreferences();
    override = (call) => (call.method === "PATCH" ? { status: 500, body: { error: { code: "boom", message: "boom" } } } : undefined);

    await savePreferenceIntent(() => ({ theme: "dark" }), "theme");

    expect(patches()).toHaveLength(1);
    expect(toast.value?.text ?? "").toContain("boom");
  });

  it("sends saves one at a time, each on the revision the one before it made", async () => {
    await readPreferences();

    const first = savePreferenceIntent(() => ({ theme: "light" }), "theme");
    const second = savePreferenceIntent(() => ({ theme: "dark" }), "theme");
    await Promise.all([first, second]);

    expect(patches()).toEqual([
      { theme: "light", baseRevision: 0 },
      { theme: "dark", baseRevision: 1 },
    ]);
  });

  it("holds an event's read until the save that is out has ended", async () => {
    await readPreferences();
    calls = [];

    const save = savePreferenceIntent(() => ({ theme: "dark" }), "theme");
    applyPreferencesEvent(5);
    await save;
    await settle();

    // The read came after the save, so the page never drew a record under a press.
    const order = calls.map((call) => call.method);
    expect(order.indexOf("PATCH")).toBeLessThan(order.lastIndexOf("GET"));
  });
});

describe("the folded groups", () => {
  it("are saved and adopted like the opened titles", async () => {
    await readPreferences();

    toggleJobChildren("job-1");
    await settle();
    await settle();
    expect(patches().at(-1)).toEqual({ collapsedJobs: ["job-1"], baseRevision: 0 });
    expect([...collapsedJobs.value]).toEqual(["job-1"]);

    // Another browser folds job 2: this page adopts it without a save.
    calls = [];
    server.external({ collapsedJobs: ["job-1", "job-2"] });
    applyPreferencesEvent(2);
    await settle();
    await settle();
    expect([...collapsedJobs.value].sort()).toEqual(["job-1", "job-2"]);
    expect(patches()).toEqual([]);
  });
});
