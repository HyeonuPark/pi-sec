import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  NO_UI_PREFERENCES,
  PreferencesStore,
  UI_PREFERENCE_KEYS,
  type UiPreferencesPatch,
} from "../../prefs/store.ts";
import { apiError, json, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/**
 * UI state the operator expects to survive a reload.
 *
 * It is not a security boundary and not a truth about the jobs: these are ids
 * the browser has been told to stop showing, so any string is accepted and an id
 * that no longer exists matches nothing. What *is* rejected is a field that is
 * not a list of strings, because silently dropping it would put the browser back
 * where it started — showing rows the operator cleared. The accepted names are
 * `UI_PREFERENCE_KEYS` in the store, which is also the list `write` loops over,
 * so validation and storage cannot disagree about a key. The two `revertQueue*`
 * keys are the last hides, oldest first, and the store trims them to ten rather
 * than refusing a longer list.
 */
export function registerPreferences(router: Router, deps: AppDeps): void {
  const store = (): PreferencesStore => new PreferencesStore(deps.runtime.harness);

  router.get("/api/preferences", async (route) => {
    json(route.res, 200, await store().read(BACKGROUND_CONTEXT));
  });

  router.patch("/api/preferences", async (route) => {
    const body = bodyObject(route.body);
    if (body === undefined) {
      apiError(route.res, 400, "invalid_request", "body must be an object", route.requestId);
      return;
    }

    const patch: UiPreferencesPatch = {};
    for (const name of UI_PREFERENCE_KEYS) {
      const value = body[name];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
        apiError(route.res, 400, "invalid_request", `${name} must be an array of ids`, route.requestId);
        return;
      }
      patch[name] = value as readonly string[];
    }

    if (Object.keys(patch).length === 0) {
      // Nothing to change is not an error: the client sends whatever it has.
      json(route.res, 200, (await store().read(BACKGROUND_CONTEXT)) ?? NO_UI_PREFERENCES);
      return;
    }

    json(route.res, 200, await store().write(patch, BACKGROUND_CONTEXT));
  });
}
