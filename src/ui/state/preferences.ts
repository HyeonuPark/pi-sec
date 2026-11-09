/**
 * The UI state the server shares between every browser: the theme, the two fold
 * lists, the id lists of the work panel, and the revision that orders them.
 *
 * One record on the server (`GET`/`PATCH /api/preferences`) holds all of it. This
 * module is the page's only reader and writer of that record, in four parts:
 *
 * - the stamp: the server writes the theme, the fold lists and the revision into
 *   `<meta name="pi-sec-preferences">`, so the first paint already has them;
 * - the read: {@link readPreferences} fetches the record and hands it to the state
 *   modules, which registered an applier with {@link onPreferences};
 * - the save: {@link savePreferenceIntent} sends what one press means (add this id,
 *   fold this panel) with the revision the page last saw. A `409` answers with the
 *   current record, and the same press is applied to it and sent again, three
 *   tries at most, so an old tab never writes an old list over a newer one;
 * - the event: `preferences_updated` carries a revision, and a page that is
 *   behind reads the record back.
 *
 * Applying a server record never sends a save. Only a press does, so two open
 * pages cannot start a loop. Saves go one at a time, and a read that arrives
 * while a save is out waits for it, so the page never draws the record under a
 * press it has not sent yet.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { showError } from "./toast.ts";

/** The record as the page holds it. Every field is optional: the stamp has no lists. */
export interface SharedPreferences {
  readonly theme?: string;
  readonly foldedWide?: readonly string[];
  readonly foldedNarrow?: readonly string[];
  readonly hiddenJobs?: readonly string[];
  readonly expandedJobs?: readonly string[];
  readonly collapsedJobs?: readonly string[];
  readonly clearedInbox?: readonly string[];
  readonly revertQueueJobs?: readonly string[];
  readonly revertQueueInbox?: readonly string[];
  readonly uiRevision?: number;
}

/** What a press changes: the fields it sets, whole. */
export type PreferencesPatch = Omit<SharedPreferences, "uiRevision">;

/** One press, as a function of the record it is applied to. */
export type PreferenceIntent = (current: SharedPreferences) => PreferencesPatch;

/** How many times a save is tried before the page gives up and says so. */
export const SAVE_ATTEMPTS = 3;

/** The `<meta>` the server stamps the record into. */
const PREFERENCES_META = 'meta[name="pi-sec-preferences"]';

/** The newest full record this page has seen, or `undefined` before the first read. */
let known: SharedPreferences | undefined;
/** The revision the stamp carried. A page that never read the lists knows only this. */
let stampedRevision = 0;
/** The stamp, read once. */
let stamp: SharedPreferences | undefined;
let stampRead = false;

/** The revision of the newest record this page holds. */
export const preferencesRevision = signal(0);

/** Saves that are queued or running. */
let pending = 0;
/** The last save in the queue, so the next one starts after it. */
let tail: Promise<void> = Promise.resolve();
/** The read that is out, shared by every caller that asks meanwhile. */
let readInFlight: Promise<SharedPreferences | undefined> | undefined;
/** A read was asked for while a save was out. */
let readWanted = false;

const appliers: Array<(record: SharedPreferences) => void> = [];

/**
 * Register what a state module does with a record. The module reads the fields it
 * owns and ignores the rest, and it must not save: an applier runs for a server
 * answer, not for a press.
 */
export function onPreferences(apply: (record: SharedPreferences) => void): void {
  appliers.push(apply);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record the server stamped into the page, or `undefined` when it did not. */
export function stampedPreferences(): SharedPreferences | undefined {
  if (stampRead) return stamp;
  if (typeof document === "undefined") return undefined;
  stampRead = true;
  const raw = (document.querySelector(PREFERENCES_META)?.getAttribute("content") ?? "").trim();
  if (raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      stamp = parsed as SharedPreferences;
      stampedRevision = typeof stamp.uiRevision === "number" ? stamp.uiRevision : 0;
      preferencesRevision.value = stampedRevision;
    }
  } catch {
    /* an unreadable stamp is no stamp */
  }
  return stamp;
}

/** The newest revision this page holds, from the stamp or from a read. */
export function currentRevision(): number {
  stampedPreferences();
  return Math.max(stampedRevision, known?.uiRevision ?? 0);
}

/** The newest full record, or `undefined` before the first read. */
export function knownPreferences(): SharedPreferences | undefined {
  return known;
}

/** Take a record from the server: remember it and hand it to every state module. */
export function applyPreferences(record: SharedPreferences): void {
  const revision = record.uiRevision ?? 0;
  if (known !== undefined && revision < (known.uiRevision ?? 0)) return;
  known = record;
  preferencesRevision.value = Math.max(preferencesRevision.value, revision);
  for (const apply of appliers) apply(record);
}

/**
 * Read the record and apply it. A failed read keeps what the page holds: the next
 * read replaces it. A read that arrives during a save is held until the save ends.
 */
export function readPreferences(): Promise<SharedPreferences | undefined> {
  if (pending > 0) {
    readWanted = true;
    return Promise.resolve(known);
  }
  // One read serves every caller that asks while it is out: the page asks from
  // its start, its visibility and its stream at nearly the same time.
  readInFlight ??= (async () => {
    try {
      const record = await request<SharedPreferences>("/api/preferences");
      if (record === undefined) return known;
      if (pending === 0) applyPreferences(record);
      else readWanted = true;
      return known;
    } catch {
      return known;
    } finally {
      readInFlight = undefined;
    }
  })();
  return readInFlight;
}

/**
 * The event named a revision. A page that already holds it, or a newer one, has
 * nothing to read.
 */
export function applyPreferencesEvent(revision: unknown): void {
  const next = typeof revision === "number" ? revision : Number.NaN;
  if (Number.isFinite(next) && next <= currentRevision()) return;
  void readPreferences();
}

/** The revision a `preferences_updated` frame names, or `undefined`. */
export function revisionOf(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  const revision = data["revision"];
  return typeof revision === "number" ? revision : undefined;
}

/**
 * Send a patch with no revision and no retry, for a value that has no press
 * behind it: the first carry of an old browser value. The answer is applied.
 */
export async function sendPreferences(body: Record<string, unknown>): Promise<SharedPreferences | undefined> {
  try {
    const record = await request<SharedPreferences>("/api/preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (record !== undefined) applyPreferences(record);
    return record;
  } catch {
    return known;
  }
}

function conflictRecord(error: unknown): SharedPreferences | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const body: unknown = error.body;
  if (!isRecord(body) || !isRecord(body["current"])) return undefined;
  return body["current"] as SharedPreferences;
}

async function runSave(intent: PreferenceIntent, label: string): Promise<void> {
  try {
    if (known === undefined) await loadFresh();
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      const base = known;
      if (base === undefined) throw new Error("the shared state could not be read");
      const patch = intent(base);
      try {
        const record = await request<SharedPreferences>("/api/preferences", {
          method: "PATCH",
          body: JSON.stringify({ ...patch, baseRevision: base.uiRevision ?? 0 }),
        });
        if (record !== undefined) applyPreferences(record);
        return;
      } catch (error) {
        const current = conflictRecord(error);
        if (current === undefined) throw error;
        applyPreferences(current);
        if (attempt === SAVE_ATTEMPTS) throw new Error("another window kept changing it");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showError(`Could not save the ${label}: ${message}`);
    // The page drew the press at once. The server did not take it, so draw the
    // record the server holds.
    if (known !== undefined) for (const apply of appliers) apply(known);
  }
}

/** A read inside the save queue, which {@link readPreferences} must not join. */
async function loadFresh(): Promise<void> {
  const record = await request<SharedPreferences>("/api/preferences");
  if (record !== undefined) applyPreferences(record);
}

/**
 * Save one press. The page has already drawn it. `label` names the field for the
 * error the operator reads when the server refuses.
 */
export function savePreferenceIntent(intent: PreferenceIntent, label: string): Promise<void> {
  pending += 1;
  const run = tail.then(() => runSave(intent, label));
  tail = run.finally(() => {
    pending -= 1;
    if (pending === 0 && readWanted) {
      readWanted = false;
      void readPreferences();
    }
  });
  return run;
}

/** Put this module back where a freshly loaded page starts. */
export function resetPreferencesState(): void {
  known = undefined;
  stamp = undefined;
  stampRead = false;
  stampedRevision = 0;
  preferencesRevision.value = 0;
  pending = 0;
  tail = Promise.resolve();
  readWanted = false;
  readInFlight = undefined;
}
