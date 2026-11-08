/**
 * The appearance control's state: three modes, one stored choice, one attribute.
 *
 * All four pages carried the same code, copied: cycle `auto → light → dark`, put
 * the mode on `<html data-theme>`, keep it in `localStorage` under
 * `pi-sec-theme`, and start from the stored choice (or `auto`). The theme
 * stylesheet picks the palette from that attribute, and `auto` follows the
 * browser's own `prefers-color-scheme`, so nothing else has to know which mode
 * is on.
 *
 * The code is kept as it was, including what it does with a value nobody wrote:
 * a stored string that is not one of the three is applied as it stands, exactly
 * as the pages applied it, and the next press of the toggle moves on from
 * `auto`. The button's label is the mode's own word (`◐ auto`), which is why the
 * mode is a string here rather than a closed union.
 */
import { signal } from "@preact/signals";

/** The storage key all four pages wrote. A page that reads it must keep the name. */
export const THEME_KEY = "pi-sec-theme";

/** The modes a press walks through, in order. */
export const THEME_ORDER = ["auto", "light", "dark"] as const;

/** One of {@link THEME_ORDER}. */
export type ThemeMode = (typeof THEME_ORDER)[number];

/** The mode on screen. The toggle reads it; applying one writes it. */
export const theme = signal<string>("auto");

/** The one button's text for a mode. */
export function themeLabel(mode: string): string {
  return `◐ ${mode}`;
}

/** The stored choice, or `auto` when there is none (or no store at all). */
export function readStoredTheme(): string {
  try {
    return window.localStorage.getItem(THEME_KEY) ?? "auto";
  } catch {
    // A browser that keeps no storage still draws the page, in `auto`.
    return "auto";
  }
}

/**
 * Put a mode on the document, remember it, and publish it.
 *
 * The `<html>` attribute is what the stylesheet reads, so it is set first and
 * whether or not the store takes the write.
 */
export function applyTheme(mode: string): string {
  theme.value = mode;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = mode;
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // A refused write costs the next page load its memory, not this page's theme.
  }
  return mode;
}

/** The mode the document says it is in, read the way the toggle always read it. */
export function documentTheme(): string {
  if (typeof document === "undefined") return "auto";
  return document.documentElement.dataset.theme ?? "auto";
}

/** The next mode in {@link THEME_ORDER}; an unknown mode moves on to `auto`. */
export function nextTheme(mode: string): string {
  const index = (THEME_ORDER as readonly string[]).indexOf(mode);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? "auto";
}

/** One press of the toggle: the next mode, applied and stored. */
export function cycleTheme(): string {
  return applyTheme(nextTheme(documentTheme()));
}

/** Start the page on the stored mode, or on `auto`. */
export function initTheme(): string {
  return applyTheme(readStoredTheme());
}
