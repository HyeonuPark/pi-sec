/**
 * Model provider login over HTTP: five routes under `/api/admin/model-login/`.
 *
 * These routes can replace the model credential, which is why they carry every
 * check the other admin write routes carry and one more.
 *
 * - The global `Host` and `Origin` guard in `server.ts` runs first: a page on
 *   another site cannot post here.
 * - Every `POST` requires `Content-Type: application/json`. A cross-site form
 *   can post without a preflight, and a form cannot send that type.
 * - The session id and the answer travel in the body, never in the query, because
 *   the access log records `req.url`.
 * - A start is refused when the request arrived under a name that is not
 *   loopback and the public address is not HTTPS: below that, the proof that
 *   binds the browser's answer to this login crosses the network in the clear.
 *
 * The session itself, the provider list and the login record live in
 * `runtime/model-login.ts`. Nothing here ever sees, keeps or repeats an answer,
 * a link or a token: the refusals are fixed sentences and the audit rows carry
 * a provider, a type and an outcome.
 */
import { vmodelEntry } from "../../agent/vmodel.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";
import type { ModelLoginFailure } from "../../runtime/model-login.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** One fixed sentence per refusal, and nothing taken from the request. */
const FAILURE_MESSAGES: Record<ModelLoginFailure, string> = {
  login_unavailable: "this daemon cannot log model providers in",
  login_busy: "a login is already running; finish or cancel it first",
  login_not_found: "no login session carries that id",
  login_no_prompt: "the login is not waiting for an answer",
  unknown_provider: "the model catalog has no provider with that id",
  login_type_unavailable: "the provider offers no login of that type",
};

const FAILURE_STATUS: Record<ModelLoginFailure, number> = {
  login_unavailable: 503,
  login_busy: 409,
  login_not_found: 404,
  login_no_prompt: 409,
  unknown_provider: 404,
  login_type_unavailable: 400,
};

/** The names that reach this machine without a name lookup. */
function isLoopbackHost(host: string): boolean {
  const hostname = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  if (hostname.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether a sign-in may start on this request.
 *
 * The sign-in link carries the proof that binds the browser's answer to this
 * flow, so it must not cross a network in the clear. A loopback name is this
 * machine and needs no transport; anything else needs an HTTPS public address.
 */
function httpsRequired(host: string, publicUrl: string | undefined): boolean {
  if (isLoopbackHost(host)) return false;
  return !(publicUrl ?? "").startsWith("https:");
}

export function registerModelLogin(router: Router, deps: AppDeps): void {
  const login = deps.runtime.modelLogin;

  const refuse = (route: RouteContext, code: ModelLoginFailure): void => {
    apiError(route.res, FAILURE_STATUS[code], code, FAILURE_MESSAGES[code], route.requestId);
  };

  // Same words as the routes that restart the daemon and write a secret.
  const jsonTypeRequired = (route: RouteContext): boolean => {
    const contentType = route.req.headers["content-type"] ?? "";
    if (contentType.includes("application/json")) return true;
    apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
    return false;
  };

  const sessionOf = (route: RouteContext): string | undefined => {
    const value = bodyObject(route.body)?.session;
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  router.get("/api/admin/model-login/providers", async (route) => {
    const state = await login.providers();
    // The root model's provider is the one a page watches for "no credential
    // yet". It is read the way the daemon reads it; a vmodel that cannot be
    // resolved (no config, an unknown key) leaves the field out rather than
    // failing the list the panel needs to draw its form.
    let rootProvider: string | undefined;
    try {
      rootProvider = vmodelEntry(deps.runtime.getConfig(), deps.runtime.getConfig().agent.vmodel).provider;
    } catch {
      rootProvider = undefined;
    }
    json(route.res, 200, {
      available: state.available,
      providers: state.providers,
      sessionActive: state.sessionActive,
      ...(rootProvider === undefined ? {} : { rootProvider }),
    });
  });

  router.post("/api/admin/model-login/start", (route) => {
    if (!jsonTypeRequired(route)) return;
    const config = deps.runtime.getConfig();
    if (httpsRequired(route.req.headers.host ?? "", config.server.publicUrl)) {
      apiError(
        route.res,
        403,
        "https_required",
        "start a login from the host itself or over an HTTPS public address",
        route.requestId,
      );
      return;
    }
    const body = bodyObject(route.body);
    const provider = typeof body?.provider === "string" ? body.provider : "";
    const type = body?.type === "oauth" ? "oauth" : body?.type === "api_key" ? "api_key" : undefined;
    if (provider === "" || type === undefined) {
      apiError(
        route.res,
        400,
        "invalid_request",
        "the body must carry a provider id and a login type of oauth or api_key",
        route.requestId,
      );
      return;
    }
    const started = login.start(provider, type);
    if (!started.ok) {
      refuse(route, started.code);
      return;
    }
    json(route.res, 200, { session: started.session, state: started.state });
  });

  router.post("/api/admin/model-login/state", (route) => {
    if (!jsonTypeRequired(route)) return;
    const session = sessionOf(route);
    if (session === undefined) {
      apiError(route.res, 400, "invalid_request", "the body must carry a session id", route.requestId);
      return;
    }
    const state = login.state(session);
    if (state === undefined) {
      refuse(route, "login_not_found");
      return;
    }
    json(route.res, 200, state);
  });

  router.post("/api/admin/model-login/answer", (route) => {
    if (!jsonTypeRequired(route)) return;
    const session = sessionOf(route);
    const value = bodyObject(route.body)?.value;
    if (session === undefined || typeof value !== "string") {
      apiError(route.res, 400, "invalid_request", "the body must carry a session id and an answer", route.requestId);
      return;
    }
    const answered = login.answer(session, value);
    if (!answered.ok) {
      refuse(route, answered.code);
      return;
    }
    json(route.res, 200, answered.state);
  });

  router.post("/api/admin/model-login/cancel", (route) => {
    if (!jsonTypeRequired(route)) return;
    const session = sessionOf(route);
    if (session === undefined) {
      apiError(route.res, 400, "invalid_request", "the body must carry a session id", route.requestId);
      return;
    }
    const cancelled = login.cancel(session);
    if (!cancelled.ok) {
      refuse(route, cancelled.code);
      return;
    }
    json(route.res, 200, cancelled.state);
  });
}
