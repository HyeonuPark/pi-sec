/**
 * A stand-in for `GET`/`PATCH /api/preferences` that keeps state the way the
 * server does: a patch replaces the fields it names, a change raises
 * `uiRevision`, a stale `baseRevision` is refused with `409` and the current
 * state, and `seedOnly` fills the theme and fold lists only where none is stored.
 * Tests that press a control need it, because the page applies the answer of a
 * save.
 */
export interface FakePreferencesCall {
  readonly method: string;
  readonly body: string | null;
}

export interface FakePreferencesAnswer {
  readonly status: number;
  readonly body: unknown;
}

const LISTS = [
  "hiddenJobs",
  "expandedJobs",
  "clearedInbox",
  "revertQueueJobs",
  "revertQueueInbox",
  "collapsedJobs",
] as const;
const OPTIONAL = ["theme", "foldedWide", "foldedNarrow"] as const;

export interface FakePreferences {
  /** The handler to register for `/api/preferences`. */
  handle(call: FakePreferencesCall): FakePreferencesAnswer;
  /** The state now. */
  state(): Record<string, unknown>;
  /** Change the state as another browser would: the revision rises. */
  external(patch: Record<string, unknown>): void;
}

export function fakePreferences(initial: Record<string, unknown> = {}): FakePreferences {
  const stored: Record<string, unknown> = {
    hiddenJobs: [],
    expandedJobs: [],
    clearedInbox: [],
    revertQueueJobs: [],
    revertQueueInbox: [],
    collapsedJobs: [],
    uiRevision: 0,
    ...initial,
  };
  const snapshot = (): Record<string, unknown> => JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const apply = (patch: Record<string, unknown>, seedOnly: boolean): boolean => {
    let changed = false;
    for (const key of [...LISTS, ...OPTIONAL]) {
      if (patch[key] === undefined) continue;
      if (seedOnly && (OPTIONAL as readonly string[]).includes(key) && stored[key] !== undefined) continue;
      if (JSON.stringify(stored[key]) === JSON.stringify(patch[key])) continue;
      stored[key] = patch[key];
      changed = true;
    }
    if (changed) stored["uiRevision"] = (stored["uiRevision"] as number) + 1;
    return changed;
  };
  return {
    handle(call) {
      if (call.method !== "PATCH") return { status: 200, body: snapshot() };
      const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
      const base = body["baseRevision"];
      if (typeof base === "number" && base < (stored["uiRevision"] as number)) {
        return {
          status: 409,
          body: { error: { code: "preferences_conflict", message: "another window changed the shared state first" }, current: snapshot() },
        };
      }
      apply(body, body["seedOnly"] === true);
      return { status: 200, body: snapshot() };
    },
    state: snapshot,
    external(patch) {
      apply(patch, false);
    },
  };
}
