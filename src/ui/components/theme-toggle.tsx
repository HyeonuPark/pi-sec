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
 * so the palette is right from the first paint.
 */
import { useLayoutEffect } from "preact/hooks";
import { cycleTheme, initTheme, theme, themeLabel } from "../state/theme.ts";

export function ThemeToggle() {
  useLayoutEffect(() => {
    initTheme();
  }, []);
  const mode = theme.value;
  return (
    <button id="theme-toggle" class="button" type="button" onClick={() => void cycleTheme()}>
      {themeLabel(mode)}
    </button>
  );
}
