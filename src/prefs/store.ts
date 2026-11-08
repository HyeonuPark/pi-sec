import type { Context } from "@earendil-works/chord";
import type { Session } from "@earendil-works/pi-durable";
import { SecSettings, type SecPreferences } from "../documents.ts";

/**
 * The UI state the server keeps on the browser's behalf.
 *
 * Three lists and two queues of ids. The lists are the jobs the operator has
 * cleared off the list, the job titles they have opened, and the inbox items
 * they have cleared. The queues (`revertQueueJobs`, `revertQueueInbox`) hold the
 * last hides of each list, oldest first, so the revert button can take one back.
 * This state lives here rather than in `localStorage` because a browser store is
 * per device, can be cleared without telling anyone, and fails by throwing into a
 * `catch` nobody reads — which is exactly how the cleared list came back after a
 * reload.
 *
 * The lists are a display preference, not a security boundary: an id that does
 * not exist is kept and simply matches nothing.
 *
 * The names live in this list and nowhere else: the route validates a patch
 * against it and `write` applies a patch by looping over it. When the route kept
 * its own copy and a cast joined the two, a key added to one copy alone was
 * accepted with a `200` and then dropped without a word. `UiPreferences` is this
 * list field by field, so `toPreferences` and `SANITIZERS` cannot compile until a
 * key added here can be read and written.
 */
export const UI_PREFERENCE_KEYS = [
  "hiddenJobs",
  "expandedJobs",
  "clearedInbox",
  "revertQueueJobs",
  "revertQueueInbox",
] as const satisfies readonly (keyof StoredPreferences)[];

export type UiPreferenceKey = (typeof UI_PREFERENCE_KEYS)[number];

/** `UiPreferences` is the state above, field by field: one id list per name. */
export type UiPreferences = { readonly [K in UiPreferenceKey]: readonly string[] };

/** A patch on its way in: the same fields, assignable one key at a time. */
export type UiPreferencesPatch = { -readonly [K in UiPreferenceKey]?: readonly string[] };

export const NO_UI_PREFERENCES: UiPreferences = {
  hiddenJobs: [],
  expandedJobs: [],
  clearedInbox: [],
  revertQueueJobs: [],
  revertQueueInbox: [],
};

/**
 * A browser told to keep thousands of ids is either broken or hostile, and the
 * document is rewritten on every toggle. The cap is far above any real list, and
 * the *first* entries are the oldest — a list trimmed at the tail keeps the
 * decisions the operator made first.
 */
const MAX_IDS = 2000;

/**
 * How many hides each revert queue remembers.
 *
 * A queue holds the operator's last hides, oldest first, so a queue that
 * overflows drops its *front* — the opposite of `sanitize`, which trims the tail
 * and so keeps the oldest. One hide is one click, and ten cells undo ten clicks.
 * The cap is a display memory, not a limit on hiding: a longer list is trimmed,
 * never refused.
 */
const MAX_QUEUE_IDS = 10;

/** Keep only non-empty string ids, in order, without duplicates. */
function sanitize(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

/**
 * Keep only non-empty string ids in a queue, newest last, and drop the front
 * when the queue is full.
 *
 * A repeated id moves to the end instead of keeping its first position: in a
 * queue the last sighting is the recent one. `sanitize` does the opposite on
 * both counts (it keeps the first sighting and the oldest entries), so the
 * queues do not go through it.
 */
function sanitizeQueue(ids: readonly unknown[], cap: number = MAX_QUEUE_IDS): string[] {
  const queue: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed === "") continue;
    const earlier = queue.indexOf(trimmed);
    if (earlier !== -1) queue.splice(earlier, 1);
    queue.push(trimmed);
    if (queue.length > cap) queue.shift();
  }
  return queue;
}

/** `sec.settings` with the readonly modifiers dropped, so a write can assign to it. */
type MutablePreferences = { -readonly [K in keyof SecPreferences]: SecPreferences[K] };

/**
 * `sec.settings` as this module reads and writes it: the runtime's own fields
 * plus the two undo queues.
 *
 * The queues are declared here because this module is their only reader and
 * writer, and the stored JSON is the same either way. Move them into
 * `SecPreferences` if a second module ever needs them.
 */
type StoredPreferences = MutablePreferences & {
  revertQueueJobs?: string[];
  revertQueueInbox?: string[];
};

/**
 * How one key's ids are trimmed. A list keeps its oldest ids and drops the tail,
 * a queue drops its front, so the two shapes cannot share one rule.
 */
const SANITIZERS: Record<UiPreferenceKey, (ids: readonly string[]) => string[]> = {
  hiddenJobs: sanitize,
  expandedJobs: sanitize,
  clearedInbox: sanitize,
  revertQueueJobs: sanitizeQueue,
  revertQueueInbox: sanitizeQueue,
};

function toPreferences(stored: StoredPreferences): UiPreferences {
  return {
    hiddenJobs: [...(stored.hiddenJobs ?? [])],
    expandedJobs: [...(stored.expandedJobs ?? [])],
    clearedInbox: [...(stored.clearedInbox ?? [])],
    revertQueueJobs: [...(stored.revertQueueJobs ?? [])],
    revertQueueInbox: [...(stored.revertQueueInbox ?? [])],
  };
}

/** Read and write `sec.settings`' UI lists and revert queues. */
export class PreferencesStore {
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  async read(context: Context): Promise<UiPreferences> {
    const stored = (await this.session.snapshot(SecSettings, context)) as StoredPreferences | undefined;
    return stored === undefined ? NO_UI_PREFERENCES : toPreferences(stored);
  }

  /**
   * Replace the lists that were given, leaving the rest — `notes` included —
   * untouched. One commit, so two clients toggling at once cannot lose each
   * other's field.
   */
  async write(patch: UiPreferencesPatch, context: Context): Promise<UiPreferences> {
    return await this.session.commit(async (tx) => {
      const draft = (await tx.doc(SecSettings)) as StoredPreferences;
      for (const key of UI_PREFERENCE_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        draft[key] = SANITIZERS[key](value);
      }
      return toPreferences(draft);
    }, context);
  }
}
