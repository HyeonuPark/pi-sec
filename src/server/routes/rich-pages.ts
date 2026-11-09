/**
 * Rich pages: HTML documents that a model wrote with `share_page`.
 *
 * Two routes serve them:
 *
 *   - `GET /rich-pages/<id>/frame` answers the stored document under an isolation
 *     header. The header's `sandbox` directive gives the document an opaque
 *     origin, also when a browser opens it without a frame, and the rest of the
 *     policy blocks every request the page could make.
 *   - `GET /rich-pages/<id>` answers the shell: a small core page with a label
 *     bar and the same sandboxed frame below it. This is the address a person
 *     opens in a separate tab.
 *
 * Only a share row that `share_page` marked (`richPage`) is served. An HTML file
 * that reached the share root another way stays a download at `/api/share/<name>`.
 *
 * The page is untrusted code, so nothing here shares its origin: the frame is
 * sandboxed without `allow-same-origin`, and the shell holds no script.
 */
import type { ServerResponse } from "node:http";
import { getAttachment, readAttachmentBytes, type AttachmentRecord } from "../../attachments/store.ts";
import { isUlid } from "../../runtime/ids.ts";
import { zoneMinute } from "../../time-format.ts";
import { sendBody } from "../compress.ts";
import type { AppDeps } from "../deps.ts";
import { resolveMount } from "../proxy.ts";
import { type RouteContext, type Router } from "../router.ts";
import { escapeHtml } from "../ui-page.ts";
import { attachmentContext, type AttachmentRouteOptions } from "./attachments.ts";

/** What a frame and the shell say when the page is gone. */
export const RICH_PAGE_GONE = "This page no longer exists";

/**
 * The version of the height reporter below. It is part of the ETag, so a change
 * to the script reaches a browser that holds an older copy of a page.
 */
export const RICH_PAGE_REPORTER_VERSION = 1;

/** The sandbox flags of every frame: scripts and form events, and nothing else. */
export const RICH_PAGE_SANDBOX = "allow-scripts allow-forms";

/**
 * The inline script appended to every page. Inside a frame it posts the content
 * height to the parent, on load and on every size change. Outside a frame it does
 * nothing. The parent finds the frame by `event.source`, so the message needs no
 * token: a page can only change the height of its own frame.
 */
export const RICH_PAGE_REPORTER =
  "<script>(function(){if(parent===window)return;var last=-1;" +
  "function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);" +
  "if(h===last)return;last=h;parent.postMessage({piSecRichPage:1,height:h},\"*\");}" +
  "addEventListener(\"load\",send);send();" +
  "if(typeof ResizeObserver===\"function\"){var ro=new ResizeObserver(send);ro.observe(document.documentElement);" +
  "if(document.body)ro.observe(document.body);}})();</script>";

/**
 * The headers of a page frame. This is the one place that builds the isolation
 * policy of a rich page.
 *
 * - `sandbox` without `allow-same-origin` gives an opaque origin: no cookie, no
 *   storage, no read of the daemon or of the page around it.
 * - `script-src 'unsafe-inline' 'unsafe-eval'` lets the model's own inline code run.
 *   Every script in the document is model-written, so a nonce would protect
 *   nothing, and it would block the `onclick` attributes that models write.
 * - `default-src 'none'` and `connect-src 'none'` block every request.
 * - `form-action 'none'` lets a submit event fire and stops the submission.
 */
export function richPageFrameHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      `sandbox ${RICH_PAGE_SANDBOX}`,
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "font-src data:",
      "media-src data: blob:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  };
}

/** The policy of the shell: the one the report page sends. */
const SHELL_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

/** A row that the page routes may serve. */
async function pageRecord(
  deps: AppDeps,
  options: AttachmentRouteOptions,
  id: string,
): Promise<AttachmentRecord | undefined> {
  if (!isUlid(id)) return undefined;
  const record = await getAttachment(attachmentContext(deps, options), id);
  if (record === undefined) return undefined;
  if (record.kind !== "share" || record.mime !== "text/html" || record.richPage !== true) return undefined;
  return record;
}

function goneFrame(res: ServerResponse): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${RICH_PAGE_GONE}</title></head><body><p>${RICH_PAGE_GONE}.</p></body></html>`;
  sendBody(res, { status: 404, contentType: "text/html; charset=utf-8", body, headers: richPageFrameHeaders() });
}

async function serveFrame(deps: AppDeps, options: AttachmentRouteOptions, route: RouteContext): Promise<void> {
  const id = route.params["id"] ?? "";
  const record = await pageRecord(deps, options, id);
  if (record === undefined) {
    goneFrame(route.res);
    return;
  }
  // A browser sets this header itself and a page cannot forge it. Opened as a
  // top-level document, the page would be able to navigate away with data in the
  // address, which no policy stops, so the browser goes to the shell instead.
  if (route.req.headers["sec-fetch-dest"] === "document") {
    const mount = resolveMount(route.req, deps.runtime.getConfig());
    route.res.writeHead(302, { Location: `${mount.prefix}/rich-pages/${id}`, "Cache-Control": "no-cache" });
    route.res.end();
    return;
  }
  const etag = `"${record.sha256}-${RICH_PAGE_REPORTER_VERSION}"`;
  const headers: Record<string, string> = { ...richPageFrameHeaders(), ETag: etag };
  const sent = route.req.headers["if-none-match"];
  if (typeof sent === "string" && sent.split(",").some((tag) => tag.trim() === etag)) {
    delete headers["Content-Type"];
    route.res.writeHead(304, headers);
    route.res.end();
    return;
  }
  let stored: Buffer;
  try {
    stored = await readAttachmentBytes(record);
  } catch {
    goneFrame(route.res);
    return;
  }
  const body = Buffer.concat([stored, Buffer.from(`\n${RICH_PAGE_REPORTER}\n`, "utf8")]);
  route.res.writeHead(200, { ...headers, "Content-Length": String(body.byteLength) });
  route.res.end(body);
}

function shellDocument(prefix: string, label: string, title: string, meta: string, id: string | undefined): string {
  const bar =
    `<header class="rich-page-bar"><span class="rich-page-bar-label">${escapeHtml(label)}</span>` +
    `<span class="rich-page-bar-title">${escapeHtml(title)}</span>` +
    (meta === "" ? "" : `<span class="rich-page-bar-meta">${escapeHtml(meta)}</span>`) +
    `<a class="rich-page-bar-back" href="${escapeHtml(prefix)}/basic-chat">Back to chat</a></header>`;
  const content =
    id === undefined
      ? `<main class="rich-page-gone"><p>${RICH_PAGE_GONE}.</p></main>`
      : `<iframe class="rich-page-shell-frame" src="${escapeHtml(prefix)}/rich-pages/${id}/frame" sandbox="${RICH_PAGE_SANDBOX}" referrerpolicy="no-referrer" title="${escapeHtml(title)}"></iframe>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="${escapeHtml(prefix)}/theme.css">` +
    `<link rel="stylesheet" href="${escapeHtml(prefix)}/rich-page.css">` +
    `</head><body class="rich-page-shell">${bar}${content}</body></html>`
  );
}

async function serveShell(deps: AppDeps, options: AttachmentRouteOptions, route: RouteContext): Promise<void> {
  const id = route.params["id"] ?? "";
  const config = deps.runtime.getConfig();
  const prefix = resolveMount(route.req, config).prefix;
  const record = await pageRecord(deps, options, id);
  const body =
    record === undefined
      ? shellDocument(prefix, "Generated page", RICH_PAGE_GONE, "", undefined)
      : shellDocument(prefix, "Generated page", pageTitle(record), zoneMinute(record.collectedAt, config.timezone), record.id);
  sendBody(route.res, {
    status: record === undefined ? 404 : 200,
    contentType: "text/html; charset=utf-8",
    body,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Security-Policy": SHELL_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** The stored name without its extension: the row keeps no separate title. */
function pageTitle(record: AttachmentRecord): string {
  return record.name.replace(/\.html$/i, "");
}

export function registerRichPages(router: Router, deps: AppDeps, options: AttachmentRouteOptions = {}): void {
  router.get("/rich-pages/:id/frame", async (route) => serveFrame(deps, options, route));
  router.get("/rich-pages/:id", async (route) => serveShell(deps, options, route));
}
