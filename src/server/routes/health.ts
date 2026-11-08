import { json, type Router } from "../router.ts";
import { API_VERSION, type AppDeps } from "../deps.ts";

export function registerHealth(router: Router, deps: AppDeps): void {
  router.get("/healthz", ({ res }) => {
    json(
      res,
      200,
      {
        status: "ok",
        version: deps.version,
        apiVersion: API_VERSION,
        uptimeMs: Date.now() - deps.startedAt,
        scheduler: "running",
      },
      { "X-API-Version": String(API_VERSION) },
    );
  });
}
