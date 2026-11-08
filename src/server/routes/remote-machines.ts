/**
 * The two routes of the remote machines panel.
 *
 *   `GET  /api/remote-machines`            the list, the levels and the links
 *   `POST /api/remote-machines/:id/level`  change one machine's level
 *
 * The list is read-only and answers even while the feature is off, with
 * `enabled: false` and no machines: that is the answer a page needs in order to
 * hide the panel, and a 404 would leave it guessing whether the route exists.
 *
 * The write route is the only way a level changes, and it is not a security
 * boundary. Two things beside the level keep it from being one that is trivially
 * misused from another site: a JSON content type, which a cross-site form cannot
 * send without a preflight, and one audit row per change. What it cannot do is
 * tell the operator from a shell on the same account, and
 * `docs/security.md` says so: the level holds the operator's intent, and the
 * tools and prompt rules are what keep it.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppDeps } from "../deps.ts";
import { apiError, json, type Router } from "../router.ts";
import { isMachineLevel, type MachineLevel } from "../../shared/wire/remote-machines.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

export function registerRemoteMachines(router: Router, deps: AppDeps): void {
  router.get("/api/remote-machines", async (route) => {
    json(route.res, 200, await deps.runtime.remoteMachines.list(BACKGROUND_CONTEXT));
  });

  router.post("/api/remote-machines/:id/level", async (route) => {
    // The same refusal the admin write routes make, for the same reason: a form on
    // another site can POST here without a preflight, and it can only send
    // text/plain, urlencoded or multipart, all of which fail this check.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }

    const level = bodyObject(route.body)?.["level"];
    if (!isMachineLevel(level)) {
      apiError(
        route.res,
        400,
        "invalid_level",
        'level must be one of "off", "restricted" or "on"',
        route.requestId,
      );
      return;
    }

    const outcome = await deps.runtime.remoteMachines.setLevel(route.params["id"] ?? "", level as MachineLevel, BACKGROUND_CONTEXT);
    if (outcome.kind === "disabled") {
      // No `remoteMachines` key: there is no such machine, and the panel is hidden
      // anyway. 404 rather than 409, because the resource is what is missing.
      apiError(route.res, 404, "not_found", "remote machines are not configured", route.requestId);
      return;
    }
    if (outcome.kind === "not-found") {
      apiError(route.res, 404, "not_found", "no such remote machine", route.requestId);
      return;
    }
    json(route.res, 200, outcome.machine);
  });
}
