/**
 * The web pages of runtime extensions: `GET /ext/<name>/` and `GET /ext/<name>/<page>`
 * answer a page, and `/ext/<name>/api/<path>` answers the extension's own requests.
 *
 * The routes are fixed. An extension exports `pages` and registers no path, so it
 * cannot answer outside `/ext/<its name>/`. Every request looks up the live
 * `PageRegistry`, so a reload reaches the next request and a removed extension
 * answers 404 at once. The sub-paths `ui/` and `api/` are the only ones the core
 * serves under an extension's prefix: `ui/` is the card file route in `ui.ts`,
 * which also answers for an extension that holds pages and no cards.
 *
 * The page is a document the core builds from `src/web/ext-page.html`: the core
 * writes the head, the theme and the policy, and the extension's `render` result
 * becomes the body. The extension is inside the security boundary, as a card
 * script is. The core policy forbids inline scripts, which keeps a script hidden
 * in outside text that a page shows from running. It is not a boundary against
 * the extension. The card markup check does not run on page markup.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PAGE_API_METHODS, PAGE_EXTENSION_NAME, PAGE_NAME, PAGE_RESERVED_NAMES } from "../../registry/pages.ts";
import { sendBody } from "../compress.ts";
import type { AppDeps } from "../deps.ts";
import { resolveMount } from "../proxy.ts";
import { pagePreferences } from "../preferences-stamp.ts";
import { apiError, type RouteContext, type Router } from "../router.ts";
import { readPage, renderPage } from "../static.ts";
import { contentSecurityPolicy, escapeHtml, UiTimeoutError, withTimeout } from "../ui-page.ts";

/** How long one page's `render` may take before the route answers 504. */
export const EXT_PAGE_RENDER_TIMEOUT_MS = 5000;

/** How long one `api` call may take before the route answers 504. */
export const EXT_PAGE_API_TIMEOUT_MS = 10000;

/** The largest page body (html plus css) a `render` may return, in UTF-8 bytes. */
export const EXT_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The largest JSON answer an `api` may return, in UTF-8 bytes. */
export const EXT_API_MAX_BYTES = 4 * 1024 * 1024;

export interface ExtPagesRouteOptions {
  /** A test sets these small. */
  readonly renderTimeoutMs?: number;
  readonly apiTimeoutMs?: number;
  readonly maxPageBytes?: number;
  readonly maxApiBytes?: number;
}

/** The file's modification time in whole milliseconds, or 0 when it is not a file. */
async function fileMtime(uiDir: string | undefined, file: string): Promise<number> {
  if (uiDir === undefined) return 0;
  try {
    const info = await stat(join(uiDir, file));
    return info.isFile() ? Math.floor(info.mtimeMs) : 0;
  } catch {
    return 0;
  }
}

/** One path of a `ui/` file, each segment encoded so it stays one segment. */
function uiFileUrl(prefix: string, extension: string, file: string, mtime: number): string {
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `${prefix}/ext/${encodeURIComponent(extension)}/ui/${path}?v=${mtime}`;
}

/** A value of the template's `<!--marker-->`, replaced without reading `$` patterns. */
function fill(html: string, marker: string, value: string): string {
  return html.replace(`<!--${marker}-->`, () => value);
}

function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  }
  return out;
}

export function registerExtPages(router: Router, deps: AppDeps, options: ExtPagesRouteOptions = {}): void {
  const renderTimeoutMs = options.renderTimeoutMs ?? EXT_PAGE_RENDER_TIMEOUT_MS;
  const apiTimeoutMs = options.apiTimeoutMs ?? EXT_PAGE_API_TIMEOUT_MS;
  const maxPageBytes = options.maxPageBytes ?? EXT_PAGE_MAX_BYTES;
  const maxApiBytes = options.maxApiBytes ?? EXT_API_MAX_BYTES;

  /** A small core error page for a page that cannot be drawn. It names no detail. */
  const errorPage = (route: RouteContext, status: number, text: string): void => {
    sendBody(route.res, {
      status,
      contentType: "text/html; charset=utf-8",
      body:
        `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(text)}</title></head>` +
        `<body><p>${escapeHtml(text)}</p></body></html>`,
      headers: {
        "Cache-Control": "no-cache",
        "Content-Security-Policy": contentSecurityPolicy(),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  };

  // The api routes come before the page route, so `api/...` never reads as a page.
  for (const method of PAGE_API_METHODS) {
    router.add(method, "/ext/:extension/api/*", async (route) => {
      const { req, res, requestId } = route;
      const extension = route.params["extension"] ?? "";
      if (!PAGE_EXTENSION_NAME.test(extension) || !deps.runtime.pages.hasApi(extension)) {
        apiError(res, 404, "not_found", "no such extension api", requestId);
        return;
      }
      const isRead = method === "GET";
      const contentType = req.headers["content-type"];
      // Only JSON bodies: a cross-site form cannot send this type. A request with
      // no body and no type at all (a bare DELETE) has nothing to refuse.
      if (!isRead && (contentType !== undefined || route.body !== undefined) && !(contentType ?? "").includes("application/json")) {
        apiError(res, 415, "json_required", "send this request with Content-Type: application/json", requestId);
        return;
      }

      const timezone = deps.runtime.getConfig().timezone;
      let result;
      try {
        result = await withTimeout(
          Promise.resolve(
            deps.runtime.pages.api(extension, {
              method,
              path: route.params["*"] ?? "",
              query: queryObject(route.url),
              body: isRead ? undefined : route.body,
              timezone,
            }),
          ),
          apiTimeoutMs,
          `pages.api of ${extension}`,
        );
      } catch (error) {
        if (error instanceof UiTimeoutError) {
          apiError(res, 504, "page_api_timeout", "the extension api did not answer in time", requestId);
          return;
        }
        deps.runtime.logger.warn("extension page api failed", {
          extension,
          method,
          reason: error instanceof Error ? error.message : String(error),
        });
        apiError(res, 500, "page_api_failed", "the extension api failed", requestId);
        return;
      }

      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (result.status === 204 || result.status === 205) {
        res.writeHead(result.status, headers);
        res.end();
        return;
      }
      let text: string;
      try {
        text = JSON.stringify(result.json ?? null);
      } catch (error) {
        deps.runtime.logger.warn("extension page api answer has no JSON form", { extension, reason: String(error) });
        apiError(res, 500, "page_api_failed", "the extension api failed", requestId);
        return;
      }
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxApiBytes) {
        deps.runtime.logger.warn("extension page api answer is over the size limit", { extension, limit: maxApiBytes });
        apiError(res, 500, "page_api_failed", "the extension api failed", requestId);
        return;
      }
      sendBody(res, {
        status: result.status,
        contentType: "application/json; charset=utf-8",
        body: text,
        headers,
      });
    });
  }

  router.get("/ext/:extension/*", async (route) => {
    const { req, res, requestId } = route;
    const notFound = (): void => apiError(res, 404, "not_found", "page not found", requestId);
    const extension = route.params["extension"] ?? "";
    const page = route.params["*"] ?? "";
    // One segment at most: an empty rest is the index page. The reserved names
    // belong to the core routes above and never name a page.
    if (!PAGE_EXTENSION_NAME.test(extension) || (page !== "" && !PAGE_NAME.test(page)) || PAGE_RESERVED_NAMES.includes(page)) {
      notFound();
      return;
    }
    const pages = deps.runtime.pages;
    const entry = pages.page(extension, page);
    if (entry === undefined) {
      notFound();
      return;
    }

    const uiDir = pages.uiDir(extension);
    const config = deps.runtime.getConfig();
    let result;
    try {
      result = await withTimeout(
        Promise.resolve(pages.render(extension, page, { query: queryObject(route.url), timezone: config.timezone })),
        renderTimeoutMs,
        `pages.render of ${extension}/${page}`,
      );
    } catch (error) {
      if (error instanceof UiTimeoutError) {
        deps.runtime.logger.warn("extension page render timed out", { extension, page, ms: renderTimeoutMs });
        errorPage(route, 504, "This page took too long to draw.");
        return;
      }
      deps.runtime.logger.warn("extension page render failed", {
        extension,
        page,
        reason: error instanceof Error ? error.message : String(error),
      });
      errorPage(route, 500, "This page could not be drawn.");
      return;
    }
    if (result === null) {
      notFound();
      return;
    }
    const css = result.css ?? "";
    if (Buffer.byteLength(result.html, "utf8") + Buffer.byteLength(css, "utf8") > maxPageBytes) {
      deps.runtime.logger.warn("extension page is over the size limit", { extension, page, limit: maxPageBytes });
      errorPage(route, 500, "This page could not be drawn.");
      return;
    }

    const raw = await readPage(deps.webDir, "ext-page.html");
    if (raw === undefined) {
      apiError(res, 500, "ui_missing", "extension page template is not installed", requestId);
      return;
    }
    const prefix = resolveMount(req, config).prefix;
    // The stamps come first and the extension's text goes in afterwards, so it is
    // never read as one of the core placeholders. The same order the chat page uses.
    let html = renderPage(raw, prefix, config.timezone, await pagePreferences(deps));
    const nonce = css === "" ? undefined : randomBytes(16).toString("base64");

    let head =
      `<meta name="pi-sec-ext" content="${escapeHtml(extension)}" />` +
      `<meta name="pi-sec-page" content="${escapeHtml(page)}" />`;
    if (entry.style !== undefined) {
      const mtime = await fileMtime(uiDir, entry.style);
      head += `<link rel="stylesheet" href="${escapeHtml(uiFileUrl(prefix, extension, entry.style, mtime))}" />`;
    }
    if (nonce !== undefined) {
      head += `<style nonce="${escapeHtml(nonce)}">${css.replaceAll(/<\/style/gi, "<\\/style")}</style>`;
    }
    let script = "";
    if (entry.script !== undefined) {
      const mtime = await fileMtime(uiDir, entry.script);
      script = `<script type="module" src="${escapeHtml(uiFileUrl(prefix, extension, entry.script, mtime))}"></script>`;
    }
    html = fill(html, "ext-title", escapeHtml(`${result.title ?? entry.label} · pi-sec`));
    html = fill(html, "ext-head", head);
    html = fill(html, "ext-body", result.html);
    html = fill(html, "ext-script", script);

    sendBody(res, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
      headers: {
        "Cache-Control": "no-cache",
        "Content-Security-Policy": contentSecurityPolicy(nonce),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
