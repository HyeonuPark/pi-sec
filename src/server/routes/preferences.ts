import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  FOLD_KEYS,
  PreferencesStore,
  THEME_MODES,
  UI_PREFERENCE_KEYS,
  isFoldablePanel,
  isThemeMode,
  type UiSettingsPatch,
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
 *
 * Beside the lists the document holds the shared `theme`, the two fold lists and
 * `uiRevision`. A write that changes any of them raises the revision and emits
 * one `preferences_updated` event that carries the revision and nothing else:
 * a page reads the state back, as it does for `inbox_item`. A patch may carry
 * `baseRevision`, and a stale one is refused with `409` and the current state.
 * `seedOnly` applies the theme and the fold lists only where none is stored.
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

    const patch: UiSettingsPatch = {};
    for (const name of UI_PREFERENCE_KEYS) {
      const value = body[name];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
        apiError(route.res, 400, "invalid_request", `${name} must be an array of ids`, route.requestId);
        return;
      }
      patch[name] = value as readonly string[];
    }
    if (body["theme"] !== undefined) {
      if (!isThemeMode(body["theme"])) {
        apiError(route.res, 400, "invalid_request", `theme must be one of ${THEME_MODES.join(", ")}`, route.requestId);
        return;
      }
      patch.theme = body["theme"];
    }
    for (const name of FOLD_KEYS) {
      const value = body[name];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every(isFoldablePanel)) {
        apiError(route.res, 400, "invalid_request", `${name} must be an array of panel names`, route.requestId);
        return;
      }
      patch[name] = value as readonly string[];
    }
    const baseRevision = body["baseRevision"];
    if (baseRevision !== undefined && (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 0)) {
      apiError(route.res, 400, "invalid_request", "baseRevision must be a whole number", route.requestId);
      return;
    }
    const seedOnly = body["seedOnly"] === true;

    if (Object.keys(patch).length === 0) {
      // Nothing to change is not an error: the client sends whatever it has.
      json(route.res, 200, await store().read(BACKGROUND_CONTEXT));
      return;
    }

    const result = await store().write(patch, BACKGROUND_CONTEXT, {
      ...(baseRevision === undefined ? {} : { baseRevision: baseRevision as number }),
      seedOnly,
    });
    if (!result.ok) {
      json(route.res, 409, {
        error: {
          code: "preferences_conflict",
          message: "another window changed the shared state first",
          requestId: route.requestId,
        },
        current: result.state,
      });
      return;
    }
    if (result.changed) deps.runtime.events.emit("preferences_updated", { revision: result.state.uiRevision });
    json(route.res, 200, result.state);
  });
}
