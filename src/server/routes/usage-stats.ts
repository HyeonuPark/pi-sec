/**
 * `GET /api/usage/stats`: model call timing statistics.
 *
 * A read. It opens `state/model-calls.sqlite` read-only through `call-stats.ts`
 * and never writes. The page route `GET /usage/stats` serves the shell the graphs are drawn in.
 */
import { sendBody } from "../compress.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";
import { resolveMount } from "../proxy.ts";
import { readPage, renderPage } from "../static.ts";
import { contentSecurityPolicy } from "../ui-page.ts";
import {
  computeCallStats,
  defaultStep,
  MAX_SLOTS,
  slotEdges,
} from "../usage/call-stats.ts";
import {
  USAGE_STATS_RANGES,
  USAGE_STATS_STEPS,
  type UsageStatsRange,
  type UsageStatsStep,
} from "../../shared/wire/usage-stats.ts";

export interface UsageStatsRouteOptions {
  readonly now?: () => number;
}

export function registerUsageStats(router: Router, deps: AppDeps, options: UsageStatsRouteOptions = {}): void {
  const now = options.now ?? Date.now;

  // The page shell, stamped with the mount prefix and the zone like `/usage`. It
  // carries no extension slot and no first-paint block: the page asks the route
  // below.
  router.get("/usage/stats", async ({ req, res }: RouteContext) => {
    const raw = await readPage(deps.webDir, "usage-stats.html");
    if (raw === undefined) {
      apiError(res, 500, "ui_missing", "usage stats UI is not installed", "");
      return;
    }
    const config = deps.runtime.getConfig();
    const prefix = resolveMount(req, config).prefix;
    sendBody(res, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: renderPage(raw, prefix, config.timezone),
      headers: {
        "Cache-Control": "no-cache",
        "Content-Security-Policy": contentSecurityPolicy(),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });

  router.get("/api/usage/stats", ({ res, url, requestId }: RouteContext) => {
    const rangeRaw = url.searchParams.get("range") ?? "7d";
    const stepRaw = url.searchParams.get("step");
    if (!(USAGE_STATS_RANGES as readonly string[]).includes(rangeRaw)) {
      apiError(res, 400, "bad_query", `range must be one of ${USAGE_STATS_RANGES.join(", ")}`, requestId);
      return;
    }
    if (stepRaw !== null && !(USAGE_STATS_STEPS as readonly string[]).includes(stepRaw)) {
      apiError(res, 400, "bad_query", `step must be one of ${USAGE_STATS_STEPS.join(", ")}`, requestId);
      return;
    }
    const range = rangeRaw as UsageStatsRange;
    const step = (stepRaw ?? defaultStep(range)) as UsageStatsStep;
    const timezone = deps.runtime.getConfig().timezone;
    const at = now();
    // One slot per step, plus the partial one the range starts in.
    if (slotEdges(at, range, step, timezone).length - 1 > MAX_SLOTS) {
      apiError(res, 400, "range_too_large", `range ${range} with step ${step} needs more than ${MAX_SLOTS} slots`, requestId);
      return;
    }
    try {
      const provider = url.searchParams.get("provider");
      const model = url.searchParams.get("model");
      json(
        res,
        200,
        computeCallStats({
          path: deps.runtime.paths.modelCallsDb,
          now: at,
          timezone,
          range,
          step,
          provider: provider === null || provider === "" ? undefined : provider,
          model: model === null || model === "" ? undefined : model,
        }),
      );
    } catch (error) {
      deps.runtime.logger.error("usage stats failed", { requestId, error });
      apiError(res, 500, "internal_error", "usage stats failed", requestId);
    }
  });
}
