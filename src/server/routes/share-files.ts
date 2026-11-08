import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { apiError, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";
import { resolveRoots } from "../../attachments/store.ts";
import { attachmentContext, writeStoredFile, type AttachmentRouteOptions } from "./attachments.ts";

/**
 * Files an agent published for a human eye, served from the share root by name.
 *
 * The name is the whole protection, which is worth being plain about. So:
 *
 *   - one path segment, no leading dot, and an alphabet with no separator in it;
 *   - an extension allowlist, and only raster images in it. Not SVG: an SVG is a
 *     document, it is same-origin here, and opening one would run its script;
 *   - anything not on that list is a download, with
 *     `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, so the
 *     declared type is the only type and the page it might become cannot run.
 */

/** Raster image types only, deliberately. See above. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function mimeByName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function registerShareFiles(
  router: Router,
  deps: AppDeps,
  options: AttachmentRouteOptions = {},
): void {
  router.get("/api/share/:name", async (route) => {
    const name = route.params["name"] ?? "";
    if (!SAFE_NAME.test(name)) {
      apiError(route.res, 404, "not_found", "file not found", route.requestId);
      return;
    }
    const root = resolve(resolveRoots(attachmentContext(deps, options)).share);
    const path = resolve(join(root, name));
    // The alphabet above forbids a separator and a leading dot; this is the
    // second lock, so the served path cannot leave the root it was joined to.
    if (dirname(path) !== root) {
      apiError(route.res, 404, "not_found", "file not found", route.requestId);
      return;
    }
    let data: Buffer;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      data = await readFile(path);
    } catch {
      apiError(route.res, 404, "not_found", "file not found", route.requestId);
      return;
    }
    writeStoredFile(route.res, { data, mime: mimeByName(name), name, download: false });
  });
}
