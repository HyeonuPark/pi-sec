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
 */
import { useEffect, useLayoutEffect } from "preact/hooks";
import { readPreferences, stampedPreferences } from "../state/preferences.ts";
import { carryStoredTheme, cycleTheme, initTheme, theme, themeLabel } from "../state/theme.ts";

export function ThemeToggle() {
  useLayoutEffect(() => {
    initTheme();
  }, []);
  useEffect(() => {
    // A served page already carries the shared mode in its stamp, so it asks the
    // server nothing at load. A page without a stamp reads the record once.
    const stamped = stampedPreferences();
    if (stamped !== undefined) void carryStoredTheme(stamped.theme);
    else void readPreferences().then((record) => carryStoredTheme(record?.theme));
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void readPreferences();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const mode = theme.value;
  return (
    <button id="theme-toggle" class="button" type="button" onClick={() => void cycleTheme()}>
      {themeLabel(mode)}
    </button>
  );
}
