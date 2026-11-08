/**
 * Which sidebar panels are folded, and the one place that remembers it.
 *
 * Three panels fold from their heading: the inbox, the job tree and the remote
 * machines. The operator's choice is browser state, not server state, so it lives
 * in `localStorage` under `pi-sec-folded-panels`, the way the theme's choice lives
 * under `pi-sec-theme` (`state/theme.ts`). A phone and a computer remember their
 * own choice, which is what a narrow screen wants: the drawer has less room than
 * the column.
 *
 * The folded names are written to `<body data-folded="…">`, space separated, and
 * the stylesheet hides what a folded panel holds by that attribute. This is the
 * shape the whole-sidebar toggle already uses (`body[data-sidebar]`), so a panel
 * and the drawer are read the same way.
 *
 * A browser that keeps no storage still folds and unfolds on screen; only the
 * memory between page loads is lost. A stored value this page cannot use — one
 * that does not parse, or that names a panel this build has no fold for — is
 * dropped whole, and every panel is drawn open: half a remembered choice would
 * open panels the operator left folded without saying so.
 */
import { effect, signal } from "@preact/signals";

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

/** The stored choice, or nothing folded when there is none (or no store at all). */
export function readStoredFolds(): ReadonlySet<FoldPanel> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FOLDS_KEY);
  } catch {
    // A browser that keeps no storage draws every panel open, and folds on press.
    return new Set();
  }
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

/** Keep the choice for the next page load. A refused write costs only that. */
function saveFolds(panels: ReadonlySet<FoldPanel>): void {
  const names = FOLDABLE_PANELS.filter((panel) => panels.has(panel));
  try {
    window.localStorage.setItem(FOLDS_KEY, JSON.stringify(names));
  } catch {
    // The fold holds on this page and is forgotten by the next one.
  }
}

/** Fold an open panel, or open a folded one, and remember the choice. */
export function toggleFold(panel: FoldPanel): void {
  const next = new Set(foldedPanels.value);
  if (next.has(panel)) next.delete(panel);
  else next.add(panel);
  foldedPanels.value = next;
  saveFolds(next);
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
 * Start the page on the stored choice, and keep `<body data-folded>` in step.
 *
 * The returned function drops the effect, for a page that is torn down.
 */
export function startFolds(doc: Document = document): () => void {
  foldedPanels.value = readStoredFolds();
  return effect(() => applyFolded(doc));
}
