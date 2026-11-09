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
 * The mode is shared: the server keeps one, stamps it into `<html data-theme>`
 * of every page it serves, and tells every open page when it changes. A press
 * applies the mode at once and saves it as the shared one. `localStorage` stays
 * as a cache for a page the server cannot reach, and as the one value an older
 * build left behind, which the first page to see a server without a mode carries
 * over ({@link carryStoredTheme}).
 *
 * The code is kept as it was, including what it does with a value nobody wrote:
 * a stored string that is not one of the three is applied as it stands, exactly
 * as the pages applied it, and the next press of the toggle moves on from
 * `auto`. The button's label is the mode's own word (`◐ auto`), which is why the
 * mode is a string here rather than a closed union.
 */
import { signal } from "@preact/signals";
import { onPreferences, savePreferenceIntent, sendPreferences, stampedPreferences } from "./preferences.ts";

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

/** The cached choice, `null` when this browser never kept one (or keeps no store). */
function storedThemeOrNull(): string | null {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

/** The stored choice, or `auto` when there is none (or no store at all). */
export function readStoredTheme(): string {
  // A browser that keeps no storage still draws the page, in `auto`.
  return storedThemeOrNull() ?? "auto";
}

/** Whether a value is one of the three modes the server accepts. */
function isMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_ORDER as readonly string[]).includes(value);
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

/** One press of the toggle: the next mode, applied, cached and saved as the shared mode. */
export function cycleTheme(): string {
  const mode = applyTheme(nextTheme(documentTheme()));
  void savePreferenceIntent(() => ({ theme: mode }), "theme");
  return mode;
}

/** The cached mode at the page start, or `null`. */
let cachedAtStart: string | null = null;

/**
 * Start the page on the shared mode the server stamped, else on the cached mode,
 * else on `auto`. Only a mode that came from the server is written to the cache:
 * a browser that never chose one must not look like it chose `auto`.
 */
export function initTheme(): string {
  // What this browser kept before this page drew anything. The carry below sends
  // this, not a mode the operator pressed while the first read was out.
  cachedAtStart = storedThemeOrNull();
  const stamped = stampedPreferences()?.theme;
  if (isMode(stamped)) return applyTheme(stamped);
  const mode = cachedAtStart ?? "auto";
  theme.value = mode;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = mode;
  return mode;
}

/**
 * Carry this browser's own cached mode to the server, once, when the server has
 * none. The server takes it only if it still holds none, so the first browser
 * wins and the others adopt it.
 */
export async function carryStoredTheme(serverTheme: string | undefined): Promise<void> {
  if (serverTheme !== undefined) return;
  if (!isMode(cachedAtStart)) return;
  await sendPreferences({ theme: cachedAtStart, seedOnly: true });
}

// A record from the server sets the mode. It never saves, so a page that adopts
// another browser's mode does not send it back.
onPreferences((record) => {
  if (!isMode(record.theme) || record.theme === documentTheme()) return;
  applyTheme(record.theme);
});
