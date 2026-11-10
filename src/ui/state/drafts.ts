/**
 * The unsent text of the two boxes, kept in the browser.
 *
 * The two boxes are the chat page's composer and the feedback field the report
 * viewer and the chat's report panel share. The hand-written drafts module kept
 * both (removed in this commit), and this module keeps both with the same keys
 * and the same rules, so a text typed
 * before the rewrite is still there after it:
 *
 *   key   `pi-sec:drafts:<mount>:<box>` where the box is `composer:root`,
 *         `composer:chat:<id>` or `feedback:<report id>`. The mount is the
 *         prefix the page is served from, so two installs behind different
 *         proxies never read each other's text. A feedback key does not name
 *         the revision: a new revision must not drop what is being typed about
 *         the old one.
 *   value `{"text": …, "at": <epoch ms>}` in `localStorage`, not
 *         `sessionStorage`, so a tab closed by mistake or a phone that drops a
 *         background tab does not take the text with it.
 *
 * What it does:
 *
 *   readDraft(key)        the stored text, or "" when there is none
 *   writeDraft(key, text) true when it was stored; false when the browser
 *                         refused (a full store, or one that refuses writes). A
 *                         whitespace-only text removes the entry instead.
 *   clearDraft(key)       remove the entry; a store that refuses leaves nothing
 *                         worse than a stale draft
 *   pruneDrafts()         drop every entry older than 14 days, return the count
 *
 * A refused write says so once per page load, and the module says it, not the
 * caller: the two boxes have the same failure and used to have two sentences for
 * it. The text stays in the field either way, and nothing throws out of here,
 * because an exception on a keystroke would break typing.
 *
 * Before the rewrite, a page that could not load the hand-written drafts module
 * (removed in this commit) treated a missing store as nothing to remember. In the new tree the module is always there, and a
 * browser that refuses storage is the only way to lose the memory, which every
 * function below handles.
 */
import { resolveMount } from "../mount.ts";
import { showToast } from "./toast.ts";

/** Every key this app writes starts here, so the prune never reads a stranger's. */
export const DRAFT_PREFIX = "pi-sec:drafts:";

/** How long an untouched draft stays: a report can wait days for an answer. */
export const DRAFT_MAX_AGE_DAYS = 14;

/** The sentence a refused write gets, once per page load. */
export const DRAFT_REFUSED_NOTICE = "Could not save this text in the browser. It stays in the box, but a reload will lose it.";

/** The browser's store, or `null` when it refuses to be reached at all. */
function store(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The mount this page is served from, or "" when it cannot be read. */
function mountBase(): string {
  try {
    const found = resolveMount();
    if (typeof found.base === "string") return found.base;
  } catch {
    // A page without the mount bridge files its drafts under the empty mount,
    // which is the value the page itself would use, and reads them back.
  }
  return "";
}

/** The storage name of one box. */
export function draftStorageKey(key: string): string {
  return `${DRAFT_PREFIX}${mountBase()}:${String(key)}`;
}

/** Set once a write was refused, so a store that refuses every write says so once. */
let refused = false;

/** Say, once, that the text could not be kept. */
function noticeRefusal(): void {
  if (refused) return;
  refused = true;
  showToast(DRAFT_REFUSED_NOTICE, { kind: "info" });
}

/** The stored text of one box, or "" when there is none. */
export function readDraft(key: string): string {
  const storage = store();
  if (storage === null) return "";
  let raw: string | null;
  try {
    raw = storage.getItem(draftStorageKey(key));
  } catch {
    return "";
  }
  if (raw === null) return "";
  try {
    const entry = JSON.parse(raw) as { text?: unknown } | null;
    return entry !== null && typeof entry.text === "string" ? entry.text : "";
  } catch {
    return "";
  }
}

/**
 * Keep one box's text, and answer whether the browser took it.
 *
 * Whitespace is not a draft: it reads as nothing, and keeping it would put a
 * space back in a field the operator emptied.
 */
export function writeDraft(key: string, text: unknown): boolean {
  const storage = store();
  if (storage === null) return false;
  const body = typeof text === "string" ? text : String(text === undefined || text === null ? "" : text);
  try {
    if (body.trim() === "") {
      storage.removeItem(draftStorageKey(key));
      return true;
    }
    storage.setItem(draftStorageKey(key), JSON.stringify({ text: body, at: Date.now() }));
    return true;
  } catch {
    // A full store refuses the write. Throwing from here would break typing.
    noticeRefusal();
    return false;
  }
}

/** Drop one box's text. A store that refuses leaves nothing worse than a stale draft. */
export function clearDraft(key: string): void {
  const storage = store();
  if (storage === null) return;
  try {
    storage.removeItem(draftStorageKey(key));
  } catch {
    // Nothing to do: the entry ages out with `pruneDrafts`.
  }
}

/**
 * Drop every entry nobody came back for, and answer how many went.
 *
 * An entry that cannot be read is not a draft anyone can restore, so it goes
 * with the old ones rather than sitting there for ever.
 */
export function pruneDrafts(): number {
  const storage = store();
  if (storage === null) return 0;
  const cutoff = Date.now() - DRAFT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const names: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name !== null && name.startsWith(DRAFT_PREFIX)) names.push(name);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    let entry: { text?: unknown; at?: unknown } | null = null;
    try {
      entry = JSON.parse(storage.getItem(name) ?? "null") as { text?: unknown; at?: unknown } | null;
    } catch {
      entry = null;
    }
    const at = entry === null ? Number.NaN : Number(entry.at);
    if (entry === null || typeof entry.text !== "string" || !Number.isFinite(at) || at < cutoff) {
      try {
        storage.removeItem(name);
        removed += 1;
      } catch {
        // A refused removal leaves it for the next page load.
      }
    }
  }
  return removed;
}
