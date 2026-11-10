import type { Context } from "@earendil-works/chord/context";
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
  "collapsedJobs",
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
  collapsedJobs: [],
};

/** The theme modes the page can show. A stored `theme` is one of these. */
export const THEME_MODES = ["auto", "light", "dark"] as const;

/** The sidebar panels that fold. The page's own list of them is `FOLDABLE_PANELS`. */
export const FOLDABLE_PANEL_NAMES = ["inbox", "jobs", "machines"] as const;

/** The two fold lists: one per screen class. */
export const FOLD_KEYS = ["foldedWide", "foldedNarrow"] as const;
export type FoldKey = (typeof FOLD_KEYS)[number];

/**
 * The shared UI state as the route answers it: the id lists, the optional
 * `theme` and fold lists (absent until a browser has chosen), and `uiRevision`,
 * which rises by one on every write that changes any of them.
 */
export type UiState = UiPreferences & {
  readonly theme?: string;
  readonly foldedWide?: readonly string[];
  readonly foldedNarrow?: readonly string[];
  readonly uiRevision: number;
};

/** The non-list fields a patch may carry. */
export type UiSettingsPatch = UiPreferencesPatch & {
  theme?: string;
  foldedWide?: readonly string[];
  foldedNarrow?: readonly string[];
};

/** What a write can be told besides the fields. */
export interface WriteOptions {
  /** Refuse the write when the stored `uiRevision` is higher than this. */
  readonly baseRevision?: number;
  /** Apply `theme` and the fold lists only where the document holds none yet. */
  readonly seedOnly?: boolean;
}

/** The answer of a write: the state, whether it changed, or the state that refused it. */
export type WriteResult =
  | { readonly ok: true; readonly state: UiState; readonly changed: boolean }
  | { readonly ok: false; readonly state: UiState };

/** Whether a value is one of the three theme modes. */
export function isThemeMode(value: unknown): value is (typeof THEME_MODES)[number] {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** Whether a value is a foldable panel name. */
export function isFoldablePanel(value: unknown): boolean {
  return typeof value === "string" && (FOLDABLE_PANEL_NAMES as readonly string[]).includes(value);
}

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
  collapsedJobs: sanitize,
};

/** A fold list: known panel names only, once each, in the sidebar's order. */
function sanitizeFolds(names: readonly string[]): string[] {
  return FOLDABLE_PANEL_NAMES.filter((panel) => names.includes(panel));
}

function toPreferences(stored: StoredPreferences): UiPreferences {
  return {
    hiddenJobs: [...(stored.hiddenJobs ?? [])],
    expandedJobs: [...(stored.expandedJobs ?? [])],
    clearedInbox: [...(stored.clearedInbox ?? [])],
    revertQueueJobs: [...(stored.revertQueueJobs ?? [])],
    revertQueueInbox: [...(stored.revertQueueInbox ?? [])],
    collapsedJobs: [...(stored.collapsedJobs ?? [])],
  };
}

function toState(stored: StoredPreferences): UiState {
  return {
    ...toPreferences(stored),
    ...(stored.theme !== undefined && isThemeMode(stored.theme) ? { theme: stored.theme } : {}),
    ...(stored.foldedWide !== undefined ? { foldedWide: [...stored.foldedWide] } : {}),
    ...(stored.foldedNarrow !== undefined ? { foldedNarrow: [...stored.foldedNarrow] } : {}),
    uiRevision: stored.uiRevision ?? 0,
  };
}

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const before = left ?? [];
  return before.length === right.length && before.every((id, index) => id === right[index]);
}

/** Read and write `sec.settings`' UI lists and revert queues. */
export class PreferencesStore {
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  async read(context: Context): Promise<UiState> {
    const stored = (await this.session.snapshot(SecSettings, context)) as StoredPreferences | undefined;
    return stored === undefined ? { ...NO_UI_PREFERENCES, uiRevision: 0 } : toState(stored);
  }

  /**
   * Replace the fields that were given, leaving the rest, `notes` included,
   * untouched. One commit, so two clients toggling at once cannot lose each
   * other's field.
   *
   * With `baseRevision`, the commit compares it with the stored `uiRevision`
   * first and refuses a stale writer without touching the document. Only a write
   * that changes a UI field raises the revision, so a save that repeats the
   * stored state is not an event.
   */
  async write(patch: UiSettingsPatch, context: Context, options: WriteOptions = {}): Promise<WriteResult> {
    return await this.session.commit(async (tx): Promise<WriteResult> => {
      const draft = (await tx.doc(SecSettings)) as StoredPreferences;
      const revision = draft.uiRevision ?? 0;
      if (options.baseRevision !== undefined && options.baseRevision < revision) {
        return { ok: false, state: toState(draft) };
      }
      let changed = false;
      for (const key of UI_PREFERENCE_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        const next = SANITIZERS[key](value);
        if (sameList(draft[key], next)) continue;
        draft[key] = next;
        changed = true;
      }
      if (patch.theme !== undefined && isThemeMode(patch.theme)) {
        if (draft.theme !== patch.theme && !(options.seedOnly === true && draft.theme !== undefined)) {
          draft.theme = patch.theme;
          changed = true;
        }
      }
      for (const key of FOLD_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        if (options.seedOnly === true && draft[key] !== undefined) continue;
        const next = sanitizeFolds(value);
        if (draft[key] !== undefined && sameList(draft[key], next)) continue;
        draft[key] = next;
        changed = true;
      }
      if (changed) draft.uiRevision = revision + 1;
      return { ok: true, state: toState(draft), changed };
    }, context);
  }
}
