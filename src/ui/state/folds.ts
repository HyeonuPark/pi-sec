/**
 * Which sidebar panels are folded, and the one place that remembers it.
 *
 * Three panels fold from their heading: the inbox, the job tree and the remote
 * machines. The choice is shared state: the server keeps two lists, one for wide
 * screens and one for narrow screens (`foldedWide`, `foldedNarrow`), stamps them
 * into the page, and tells every open page when one changes. The boundary is the
 * narrow query of the drawer (`NARROW_QUERY` in `state/panels.ts`), so a phone
 * and a computer each keep their own choice, and every phone follows every other
 * phone. A page that crosses the boundary draws the list of its new class.
 *
 * `localStorage` under `pi-sec-folded-panels` stays as the cache of a page the
 * server cannot reach, and as the one value an older build left behind. It is
 * read only while the server holds no list for the page's class, and the first
 * page that finds the server without a list carries it over
 * ({@link carryStoredFolds}).
 *
 * The folded names are written to `<body data-folded="…">`, space separated, and
 * the stylesheet hides what a folded panel holds by that attribute. This is the
 * shape the whole-sidebar toggle already uses (`body[data-sidebar]`), so a panel
 * and the drawer are read the same way.
 *
 * A browser that keeps no storage still folds and unfolds on screen. A stored
 * value this page cannot use, one that does not parse or that names a panel this
 * build has no fold for, is dropped whole, and every panel is drawn open: half a
 * remembered choice would open panels the operator left folded without saying so.
 */
import { effect, signal } from "@preact/signals";
import { isNarrow, watchWidth } from "./panels.ts";
import {
  knownPreferences,
  onPreferences,
  savePreferenceIntent,
  sendPreferences,
  stampedPreferences,
  type SharedPreferences,
} from "./preferences.ts";

/** The storage key the folded names are kept under. */
export const FOLDS_KEY = "pi-sec-folded-panels";

/**
 * The panels that fold, in the order the sidebar draws them.
 *
 * Awaiting you and Notes are not here: the first asks for an answer and the
 * second reports a failure, and both are things the operator has to see.
 */
export const FOLDABLE_PANELS = ["inbox", "jobs", "machines"] as const;

/** One of {@link FOLDABLE_PANELS}. */
export type FoldPanel = (typeof FOLDABLE_PANELS)[number];

/** The panels that are folded right now. */
export const foldedPanels = signal<ReadonlySet<FoldPanel>>(new Set());

/** Whether a value names a panel this build can fold. */
export function isFoldPanel(value: unknown): value is FoldPanel {
  return typeof value === "string" && (FOLDABLE_PANELS as readonly string[]).includes(value);
}

/** Whether one panel is folded. */
export function isFolded(panel: FoldPanel): boolean {
  return foldedPanels.value.has(panel);
}

/** The raw cached value, `null` when there is none (or no store at all). */
function readRawFolds(): string | null {
  try {
    return window.localStorage.getItem(FOLDS_KEY);
  } catch {
    // A browser that keeps no storage draws every panel open, and folds on press.
    return null;
  }
}

/** The cached choice, or nothing folded when there is none (or no store at all). */
export function readStoredFolds(): ReadonlySet<FoldPanel> {
  const raw = readRawFolds();
  if (raw === null || raw.trim() === "") return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  // One name this build cannot fold makes the whole value unusable: see the note
  // at the top of the file.
  if (!parsed.every(isFoldPanel)) return new Set();
  return new Set(parsed);
}

/** Keep the choice as the cache. A refused write costs only that. */
function saveFoldsCache(panels: ReadonlySet<FoldPanel>): void {
  const names = FOLDABLE_PANELS.filter((panel) => panels.has(panel));
  try {
    window.localStorage.setItem(FOLDS_KEY, JSON.stringify(names));
  } catch {
    // The fold holds on this page and is forgotten by the next one.
  }
}

/** The key of the list the page's screen class draws. */
export function foldKey(narrow: boolean = isNarrow()): "foldedWide" | "foldedNarrow" {
  return narrow ? "foldedNarrow" : "foldedWide";
}

/** The two lists the server holds, as far as this page knows them. */
const serverLists: { foldedWide?: readonly string[]; foldedNarrow?: readonly string[] } = {};

/** A list from the server as a set. A list with a name this build cannot fold is unusable. */
function setOf(list: readonly string[] | undefined): ReadonlySet<FoldPanel> | undefined {
  if (!Array.isArray(list) || !list.every(isFoldPanel)) return undefined;
  return new Set(list as readonly FoldPanel[]);
}

/**
 * Draw the list of the current screen class. The server's list wins; a class the
 * server holds no list for keeps the cache.
 */
function drawCurrentClass(): void {
  const shared = setOf(serverLists[foldKey()]);
  foldedPanels.value = shared ?? readStoredFolds();
}

function takeLists(record: SharedPreferences): void {
  if (record.foldedWide !== undefined) serverLists.foldedWide = record.foldedWide;
  if (record.foldedNarrow !== undefined) serverLists.foldedNarrow = record.foldedNarrow;
}

// A record from the server sets the folds of both classes and draws the current
// one. It never saves.
onPreferences((record) => {
  takeLists(record);
  drawCurrentClass();
});

/** Fold an open panel, or open a folded one, and save the choice for this screen class. */
export function toggleFold(panel: FoldPanel): void {
  const before = foldedPanels.value;
  const folding = !before.has(panel);
  const next = new Set(before);
  if (folding) next.add(panel);
  else next.delete(panel);
  foldedPanels.value = next;
  saveFoldsCache(next);
  const key = foldKey();
  serverLists[key] = FOLDABLE_PANELS.filter((name) => next.has(name));
  // The press is "fold this panel" or "open this panel", applied to the list the
  // server holds. With no list there yet, the list this page showed is the base.
  void savePreferenceIntent((current) => {
    const base = new Set<string>(current[key] ?? FOLDABLE_PANELS.filter((name) => before.has(name)));
    if (folding) base.add(panel);
    else base.delete(panel);
    return { [key]: FOLDABLE_PANELS.filter((name) => base.has(name)) };
  }, "folded panels");
}

/**
 * Carry this browser's cached folds to the server, once, into the list of the
 * screen class the page is in, when the server holds none for that class. The
 * server takes the carry only while it holds none.
 */
export async function carryStoredFolds(record: SharedPreferences | undefined): Promise<void> {
  if (record === undefined) return;
  const key = foldKey();
  if (record[key] !== undefined) return;
  const raw = readRawFolds();
  if (raw === null) return;
  const cached = readStoredFolds();
  if (cached.size === 0 && raw.trim() !== "[]") return;
  await sendPreferences({ [key]: FOLDABLE_PANELS.filter((name) => cached.has(name)), seedOnly: true });
}

/**
 * Write the folded names on the `<body>`, which is what the stylesheet reads.
 *
 * The attribute is written from the signal, so the sheet and the headings cannot
 * disagree about which panel is folded.
 */
export function applyFolded(doc: Document = document): void {
  const names = FOLDABLE_PANELS.filter((panel) => foldedPanels.value.has(panel));
  doc.body.dataset.folded = names.join(" ");
}

/**
 * Start the page on the shared choice the server stamped, and keep
 * `<body data-folded>` in step.
 *
 * The returned function drops the effect and the width watcher, for a page that
 * is torn down.
 */
export function startFolds(doc: Document = document): () => void {
  const stamped = stampedPreferences();
  const known = knownPreferences();
  if (stamped !== undefined) takeLists(stamped);
  if (known !== undefined) takeLists(known);
  drawCurrentClass();
  const stopEffect = effect(() => applyFolded(doc));
  const stopWidth = watchWidth(() => drawCurrentClass());
  return () => {
    stopEffect();
    stopWidth();
  };
}

/** Put this module back where a freshly loaded page starts. */
export function resetFoldsState(): void {
  delete serverLists.foldedWide;
  delete serverLists.foldedNarrow;
  foldedPanels.value = new Set();
}
