/**
 * The appearance button.
 *
 * One `<button id="theme-toggle" class="button" type="button">◐ auto</button>`,
 * which is the element the four pages each wrote in their own header, with the
 * same id and class the stylesheet and the old page code address. A press walks
 * the modes, and the label follows, because the label is the mode's word.
 *
 * The stored mode is applied when the component goes into the page, which is
 * where each page's `start()` applied it: before the page's first server read,
 * so the palette is right from the first paint. The page then reads the shared
 * state once, carries this browser's cached mode over when the server has none,
 * and reads again whenever the tab becomes visible: a page without a stream
 * (the report and usage pages) learns of another browser's mode that way.
 *
 * A page that holds one of the light streams passes `live`: that stream carries
 * `preferences_updated` and reads the record again when it reopens, so the return
 * to the tab costs nothing there. The chats list page promises exactly that — a
 * return within the minute reads nothing — and the read this button would make
 * broke the promise.
 */
import { useEffect, useLayoutEffect } from "preact/hooks";
import { readPreferences, stampedPreferences } from "../state/preferences.ts";
import { carryStoredTheme, cycleTheme, initTheme, theme, themeLabel } from "../state/theme.ts";

/** What a page tells the button about the stream it holds. */
export interface ThemeToggleProps {
  /** True when the page's own stream carries `preferences_updated`, so a return needs no read. */
  readonly live?: boolean;
}

export function ThemeToggle({ live = false }: ThemeToggleProps) {
  useLayoutEffect(() => {
    initTheme();
  }, []);
  useEffect(() => {
    // A served page already carries the shared mode in its stamp, so it asks the
    // server nothing at load. A page without a stamp reads the record once.
    const stamped = stampedPreferences();
    if (stamped !== undefined) void carryStoredTheme(stamped.theme);
    else void readPreferences().then((record) => carryStoredTheme(record?.theme));
    if (live) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void readPreferences();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [live]);
  const mode = theme.value;
  return (
    <button id="theme-toggle" class="button" type="button" onClick={() => void cycleTheme()}>
      {themeLabel(mode)}
    </button>
  );
}
