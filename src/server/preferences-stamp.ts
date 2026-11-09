import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PreferencesStore } from "../prefs/store.ts";
import type { AppDeps } from "./deps.ts";
import type { PagePreferences } from "./static.ts";

/**
 * The shared UI state a page is stamped with, read once per page request.
 *
 * A failed read stamps nothing: the page then starts on its own cache and reads
 * the state itself, which is what it did before the stamp existed.
 */
export async function pagePreferences(deps: AppDeps): Promise<PagePreferences | undefined> {
  try {
    const state = await new PreferencesStore(deps.runtime.harness).read(BACKGROUND_CONTEXT);
    return {
      ...(state.theme === undefined ? {} : { theme: state.theme }),
      ...(state.foldedWide === undefined ? {} : { foldedWide: state.foldedWide }),
      ...(state.foldedNarrow === undefined ? {} : { foldedNarrow: state.foldedNarrow }),
      uiRevision: state.uiRevision,
    };
  } catch {
    return undefined;
  }
}
