import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { acceptsGzip, GZIP_MIN_BYTES, gzipBody, isCompressibleType } from "./compress.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * The Content-Type for a file path, by its extension.
 *
 * Exported because the card file route serves files of its own and must name them
 * the way the page's assets are named: one table, so an `.svg` is an image on both
 * routes or on neither.
 */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * What one asset file is, as far as an answer needs to know: the validator and the
 * gzipped bytes, keyed by the version of the file they were computed from.
 *
 * A page load asks for nine assets and asks for them again on every refresh. The
 * hash and the compressed copy are worth keeping between requests; they are only
 * good for one version of the file, so the key is its modification time and size,
 * and a file that changed replaces the entry.
 */
interface AssetVersion {
  readonly key: string;
  readonly etag: string;
  readonly gzipped?: Buffer;
}

const assetVersions = new Map<string, AssetVersion>();

/** Strong enough to notice a change, weak because a byte-identical file is identical. */
function etagOf(data: Buffer): string {
  return `W/"${createHash("sha1").update(data).digest("base64url")}"`;
}

/**
 * Whether `If-None-Match` names this tag.
 *
 * The header is a comma list, `*` matches anything, and the comparison ignores
 * the `W/` prefix on either side: that is what makes it a weak validator.
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const tags = header
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  if (tags.includes("*")) return true;
  const opaque = (tag: string): string => (tag.startsWith("W/") ? tag.slice(2) : tag);
  return tags.some((tag) => opaque(tag) === opaque(etag));
}

/**
 * Serve a file from the web root, rejecting path traversal. Returns false when absent.
 *
 * A file carries a weak ETag built from its content, so a browser that already has
 * this version is answered `304` and downloads nothing. `Cache-Control: no-cache`
 * stays: the browser still asks every time, so a Restart UI or a daemon restart
 * reaches the next load without waiting for anything to expire.
 *
 * A compressible file of at least a kilobyte is sent gzipped when the client asked
 * for it, from bytes kept per file version: a refresh compresses nothing.
 */
export async function serveStatic(res: ServerResponse, root: string, relativePath: string): Promise<boolean> {
  const target = resolve(root, normalize(relativePath).replace(/^([/\\])+/, ""));
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return false;
  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const contentType = contentTypeFor(target);
  const compressible = isCompressibleType(contentType);
  const key = `${info.mtimeMs}:${info.size}`;
  let version = assetVersions.get(target);
  if (version === undefined || version.key !== key) {
    let data: Buffer;
    try {
      data = await readFile(target);
    } catch {
      return false;
    }
    version = {
      key,
      etag: etagOf(data),
      ...(compressible && data.byteLength >= GZIP_MIN_BYTES ? { gzipped: gzipBody(data) } : {}),
    };
    assetVersions.set(target, version);
  }
  const headers: Record<string, string> = {
    "ETag": version.etag,
    // No freshness window: a cached page used to survive a deploy with nothing on
    // either side able to say so. `no-cache` keeps the browser's copy but makes it
    // revalidate, which the ETag now answers with `304` when nothing changed.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  // One compressed answer and one plain answer are two different bodies for the
  // same URL, so a cache has to be told which one it got.
  if (compressible) headers["Vary"] = "Accept-Encoding";
  if (matchesEtag(res.req?.headers["if-none-match"], version.etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const compressed = version.gzipped !== undefined && acceptsGzip(res.req);
  let body: Buffer;
  if (compressed) {
    body = version.gzipped!;
  } else {
    try {
      body = await readFile(target);
    } catch {
      return false;
    }
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
    ...(compressed ? { "Content-Encoding": "gzip" } : {}),
  });
  res.end(body);
  return true;
}

/** Read one HTML page from the web root. */
export async function readPage(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, name), "utf8");
  } catch {
    return undefined;
  }
}

/** Read the bundled index.html (cached by the caller if desired). */
export async function readIndex(root: string): Promise<string | undefined> {
  return readPage(root, "index.html");
}

const BASE_META = /<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i;

/**
 * Stamp the external mount prefix into the UI's `<meta name="pi-sec-base">`, so
 * the page builds its API and SSE URLs for the path it is actually served from
 * instead of guessing from `location.pathname`.
 *
 * A `<meta>` element, not an inline script: the UI is served under a strict
 * `script-src 'self'` CSP, which would block an inline one.
 */
export function injectBase(html: string, prefix: string): string {
  if (!BASE_META.test(html)) return html;
  const value = escapeAttribute(prefix);
  return html.replace(BASE_META, `<meta name="pi-sec-base" content="${value}" />`);
}

const TIMEZONE_META = /<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i;

/**
 * Stamp the harness time zone into the UI's `<meta name="pi-sec-timezone">`.
 *
 * The page draws a schedule's time on the harness clock, and the browser's own
 * clock says nothing about which zone that is. A `<meta>` element for the same
 * reason as `injectBase`: the pages are served under a strict `script-src 'self'`
 * CSP, so an inline script could not carry the value.
 *
 * The caller reads `timezone` from the current config on every request, so a
 * reload that changes the zone reaches the next page load.
 */
export function injectTimezone(html: string, timeZone: string): string {
  if (!TIMEZONE_META.test(html)) return html;
  const value = escapeAttribute(timeZone);
  return html.replace(TIMEZONE_META, `<meta name="pi-sec-timezone" content="${value}" />`);
}

const NAME_META = /<meta\s+name="pi-sec-name"\s+content="[^"]*"\s*\/?>/i;

/**
 * Stamp the registered name into the UI's `<meta name="pi-sec-name">`.
 *
 * The page draws this value as the title of the root conversation. It is a
 * `<meta>` element for the same reason as `injectBase`: the pages are served
 * under a strict `script-src 'self'` CSP, so an inline script could not carry it,
 * and the value has to be in the page before its scripts run.
 *
 * The caller reads the personality file on every request and passes an empty
 * string when there is no name, so an empty value means "no name registered":
 * the page then shows its own default, which is the name of the install.
 */
export function injectName(html: string, name: string): string {
  if (!NAME_META.test(html)) return html;
  const value = escapeAttribute(name);
  return html.replace(NAME_META, () => `<meta name="pi-sec-name" content="${value}" />`);
}

/** The shared UI state a page is stamped with. Every field is optional. */
export interface PagePreferences {
  readonly theme?: string;
  readonly foldedWide?: readonly string[];
  readonly foldedNarrow?: readonly string[];
  readonly uiRevision?: number;
}

const PREFERENCES_META = /<meta\s+name="pi-sec-preferences"\s+content="[^"]*"\s*\/?>/i;
const HTML_THEME = /(<html\b[^>]*?\sdata-theme=")[^"]*(")/i;

/**
 * Stamp the shared theme into `<html data-theme>` and the shared UI state into
 * `<meta name="pi-sec-preferences">`.
 *
 * The page draws its first frame before any script runs, and the CSP forbids an
 * inline script, so the attribute is the only way to paint the shared theme at
 * once. The meta holds the theme, the two fold lists and the revision as JSON,
 * escaped like the other stamps, so the page starts on the shared folds. A page
 * without the meta is left as it is, and a state without a theme leaves
 * `data-theme` at what the file says (`auto`).
 */
export function injectPreferences(html: string, preferences: PagePreferences | undefined): string {
  if (preferences === undefined || !PREFERENCES_META.test(html)) return html;
  let out = html;
  if (preferences.theme !== undefined) {
    const theme = escapeAttribute(preferences.theme);
    out = out.replace(HTML_THEME, (_match, head: string, tail: string) => `${head}${theme}${tail}`);
  }
  const value = escapeAttribute(JSON.stringify(preferences));
  return out.replace(PREFERENCES_META, () => `<meta name="pi-sec-preferences" content="${value}" />`);
}

const BASE_PLACEHOLDER = /\{\{base\}\}/g;

/**
 * Stamp the mount prefix into a page's `{{base}}` placeholders.
 *
 * A placeholder in the markup, not a script: the pages are served under a strict
 * `script-src 'self'` CSP, so a page that computed its own asset URLs at runtime
 * would need an inline script it is not allowed to have.
 */
export function injectBasePlaceholder(html: string, prefix: string): string {
  return html.replace(BASE_PLACEHOLDER, escapeAttribute(prefix));
}

/**
 * Every stamp a page route wants: the mount prefix, in the meta tag and in the
 * asset URLs, and the harness time zone.
 *
 * The name is stamped by the route that serves the chat page, because it is the
 * only page that draws it and the value comes from the personality file rather
 * than from the config. The shared UI state is stamped when the caller passes it.
 */
export function renderPage(
  html: string,
  prefix: string,
  timeZone: string,
  preferences?: PagePreferences,
): string {
  return injectPreferences(
    injectTimezone(injectBasePlaceholder(injectBase(html, prefix), prefix), timeZone),
    preferences,
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
