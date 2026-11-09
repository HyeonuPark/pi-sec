/**
 * The card routes: the call API the page posts to, and the files a card's script
 * and images are served from.
 *
 * `POST /api/ui/call` is the only path from the browser into an extension's
 * `action`. The origin check and the body cap are global (see `server.ts`); this
 * route adds the JSON content type, the field shapes, the timeouts, and the
 * markup check on the html it answers, so a card's own answer goes through the
 * same rules its rendered markup did.
 *
 * `GET /ext/<extension>/ui/<file>` serves what a card declares: a script, or a
 * stylesheet and images the card's markup points at. Only an extension the
 * `UiRegistry` knows has a directory here, only four file types leave it, and a
 * path that resolves outside `ui/` (through `..` or a symlink) is not answered at
 * all.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { UI_CARD_NAME } from "../../registry/ui.ts";
import type { AppDeps } from "../deps.ts";
import { apiError, json, type Router } from "../router.ts";
import { contentTypeFor } from "../static.ts";
import { checkCardMarkup } from "../ui-markup.ts";
import { escapeHtml, UiTimeoutError, UI_ACTION_TIMEOUT_MS, withTimeout } from "../ui-page.ts";

/** An action name: the same rule the registry applies to an event name. */
const UI_ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** An extension directory name. */
const UI_EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The only file types a card may have served, by their lowercase extension. */
const SERVED_FILE = /\.(?:js|mjs|css|svg|png)$/;

export interface UiRouteOptions {
  readonly actionTimeoutMs?: number;
}

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

export function registerUi(router: Router, deps: AppDeps, options: UiRouteOptions = {}): void {
  const actionTimeoutMs = options.actionTimeoutMs ?? UI_ACTION_TIMEOUT_MS;

  /**
   * One card's `action`, called by the page.
   *
   * The answer is `{ value?, html? }` with a key only for what the extension
   * returned. `value` is passed through as JSON; `html` is checked as markup, and
   * a refusal is answered as a sentence the browser can show, because the card is
   * what the operator is looking at.
   */
  router.post("/api/ui/call", async (route) => {
    // The same defence as the admin routes: a cross-site form can POST without a
    // preflight, and a form cannot send a JSON type.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }

    const body = bodyObject(route.body);
    const extension = body?.["extension"];
    const card = body?.["card"];
    const action = body?.["action"];
    if (
      typeof extension !== "string" ||
      !UI_EXTENSION_NAME.test(extension) ||
      typeof card !== "string" ||
      !UI_CARD_NAME.test(card) ||
      typeof action !== "string" ||
      !UI_ACTION_NAME.test(action)
    ) {
      apiError(route.res, 400, "invalid_request", "extension, card and action must be names", route.requestId);
      return;
    }

    const ui = deps.runtime.ui;
    // One answer for both: a card nobody declared and an extension that offers no
    // action are not told apart to a caller that may not be the page.
    if (ui.card(extension, card) === undefined || !ui.hasAction(extension)) {
      apiError(route.res, 404, "not_found", "no such card, or the extension offers no action", route.requestId);
      return;
    }

    const timezone = deps.runtime.getConfig().timezone;
    let result;
    try {
      result = await withTimeout(
        ui.action(extension, card, action, body?.["value"], { timezone }),
        actionTimeoutMs,
        `ui.action of ${extension}/${card}`,
      );
    } catch (error) {
      if (error instanceof UiTimeoutError) {
        apiError(route.res, 504, "ui_action_timeout", error.message, route.requestId);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      deps.runtime.logger.warn("ui action failed", { extension, card, action, reason });
      apiError(route.res, 500, "ui_action_failed", reason, route.requestId);
      return;
    }

    const payload: { value?: unknown; html?: string } = {};
    if (result !== undefined) {
      if (result.html !== undefined) {
        const checked = checkCardMarkup(result.html);
        if (checked.ok) {
          payload.html = checked.html;
        } else {
          deps.runtime.logger.warn("ui action html refused", { extension, card, reason: checked.reason });
          payload.html = escapeHtml(`${extension}/${card}: invalid markup`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(result, "value")) payload.value = result.value;
    }
    json(route.res, 200, payload);
  });

  /**
   * One file from an extension's `ui/` directory.
   *
   * Nothing here is guessed: the extension must hold a registration, every path
   * segment must be a plain name, the file must be one of the four card types,
   * and its real path must stay inside the real `ui/` directory. Anything else is
   * the same 404, so a probe learns nothing about what exists.
   */
  router.get("/ext/:extension/ui/*", async (route) => {
    const notFound = (): void => {
      apiError(route.res, 404, "not_found", "card file not found", route.requestId);
    };

    const extension = route.params["extension"] ?? "";
    const rest = route.params["*"] ?? "";
    // A page-only extension has no card registration: its files come from the
    // page registry, which holds the same `<dir>/ui/` directory.
    const uiDir = deps.runtime.ui.uiDir(extension) ?? deps.runtime.pages.uiDir(extension);
    if (uiDir === undefined) {
      notFound();
      return;
    }

    const segments = rest.split("/");
    if (segments.length === 0 || !SERVED_FILE.test(rest)) {
      notFound();
      return;
    }
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") {
        notFound();
        return;
      }
      if (/[\\\u0000]/.test(segment)) {
        notFound();
        return;
      }
    }

    let base: string;
    let target: string;
    try {
      base = await realpath(uiDir);
      target = await realpath(join(base, ...segments));
    } catch {
      notFound();
      return;
    }
    if (target !== base && !target.startsWith(base + sep)) {
      notFound();
      return;
    }

    let data: Uint8Array;
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        notFound();
        return;
      }
      data = await readFile(target);
    } catch {
      notFound();
      return;
    }

    route.res.writeHead(200, {
      "Content-Type": contentTypeFor(target),
      "Content-Length": data.byteLength,
      "X-Content-Type-Options": "nosniff",
      // The script URL carries the file's mtime, so the browser may keep this copy
      // but has to ask again: a reloaded extension can change a file in place.
      "Cache-Control": "no-cache",
    });
    route.res.end(data);
  });
}
