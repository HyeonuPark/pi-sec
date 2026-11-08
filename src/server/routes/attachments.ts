import type { IncomingMessage, ServerResponse } from "node:http";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";
import {
  createAttachment,
  getAttachment,
  readAttachmentBytes,
  type AttachmentContext,
} from "../../attachments/store.ts";
import {
  imageFormatOf,
  readImageSize,
  sniffImageFormat,
  type ImageFormat,
} from "../../attachments/image-size.ts";
import { isUlid } from "../../runtime/ids.ts";

/**
 * Operator uploads, and the two ways to read one back.
 *
 * The body of an upload is the file itself: no JSON, no base64, no multipart.
 * `Content-Type` is the MIME and `?name=` is the original file name, which is
 * metadata from that point on and never a path. Nothing the network said decides
 * where the file goes: the store names it by an id it made up.
 *
 * This server has no authentication, so the only thing between a stranger and a
 * file is the proxy in front of it. What this module adds is that one attachment
 * id cannot reach another file, and that a body which is not an image is served
 * as a download with scripting switched off.
 */

/** The MIME each container this reader understands is served as. */
const IMAGE_MIME: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Where a test points the store instead of the two live roots. */
export interface AttachmentRouteRoots {
  readonly attachments?: string;
  readonly share?: string;
}

export interface AttachmentRouteOptions {
  /** Injected by a test; production reads both roots from the configuration. */
  readonly roots?: AttachmentRouteRoots;
}

/**
 * The one path whose body is not text.
 *
 * Every other request goes through the server's `readBody`, which decodes the
 * stream as UTF-8. A PNG does not survive that, so this route reads its own body
 * and the server must not have read it first.
 */
export function isBinaryUploadRequest(method: string, pathname: string): boolean {
  return method.toUpperCase() === "POST" && pathname === "/api/attachments";
}

export type BinaryBodyResult =
  | { readonly ok: true; readonly data: Buffer }
  | { readonly ok: false; readonly code: "payload_too_large" };

/**
 * The raw bytes of one request body, up to `maxBytes`.
 *
 * Over the cap the rest of the body is read and dropped rather than the socket
 * being destroyed: a client hears 413 only on a connection that is still there.
 * Nothing is buffered past the cap, so a body far over it costs bandwidth and no
 * memory.
 */
export async function readBinaryBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BinaryBodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  return await new Promise<BinaryBodyResult>((settle, fail) => {
    req.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      settle(
        overflow
          ? { ok: false, code: "payload_too_large" }
          : { ok: true, data: Buffer.concat(chunks) },
      );
    });
    req.on("error", fail);
  });
}

/**
 * The context the store works against, built from what the runtime exposes.
 *
 * It reads nothing but `runtime`, so a caller that holds less than `AppDeps`
 * (the stream hub holds the runtime and the event bus) builds the same context
 * through this function instead of assembling one by hand.
 *
 * The two storage roots come from the live configuration (`attachments.dir` and
 * `attachments.shareDir`) on every call, because the config can be reloaded while
 * the server runs. `options.roots` is a test's override and wins over it.
 */
export function attachmentContext(
  deps: Pick<AppDeps, "runtime">,
  options: AttachmentRouteOptions = {},
): AttachmentContext {
  return {
    storage: deps.runtime.storage,
    harness: deps.runtime.harness,
    audit: deps.runtime.audit,
    jobs: deps.runtime.jobs,
    getConfig: () => deps.runtime.getConfig(),
    ...(options.roots === undefined ? {} : { roots: options.roots }),
  };
}

/**
 * A `Content-Disposition` value that survives a non-ASCII name.
 *
 * The plain parameter keeps a client that ignores RFC 5987 working, and both are
 * stripped of the characters that would end the header early.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 120);
  const fallback = ascii === "" ? "file" : ascii;
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Write one stored file with the headers its type earns.
 *
 * An image may render in the page, so it is served as itself and cached for as
 * long as the store keeps it: a row is immutable, so a second read of one id
 * cannot see different bytes. Everything else is a download, always, with every
 * subresource switched off in case a browser opens it anyway.
 */
export function writeStoredFile(
  res: ServerResponse,
  file: {
    readonly data: Buffer;
    readonly mime: string;
    readonly name: string;
    readonly download: boolean;
  },
): void {
  const format = imageFormatOf(file.mime);
  const image = format !== undefined;
  const headers: Record<string, string | number> = {
    "Content-Length": file.data.byteLength,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (image) {
    headers["Content-Type"] = IMAGE_MIME[format];
    headers["Cache-Control"] = "private, max-age=31536000, immutable";
  } else {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    headers["Cache-Control"] = "no-store";
  }
  if (file.download || !image) headers["Content-Disposition"] = contentDisposition(file.name);
  res.writeHead(200, headers);
  res.end(file.data);
}

/** The original name, with the bytes that cannot travel in a header removed. */
function incomingName(url: URL): string {
  const raw = (url.searchParams.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return raw === "" ? "attachment" : raw.slice(0, 200);
}

export function registerAttachments(
  router: Router,
  deps: AppDeps,
  options: AttachmentRouteOptions = {},
): void {
  router.post("/api/attachments", async (route) => {
    const config = deps.runtime.getConfig();
    const cap = config.server.maxUploadBytes;
    let body: BinaryBodyResult;
    try {
      body = await readBinaryBody(route.req, cap);
    } catch (error) {
      apiError(
        route.res,
        400,
        "invalid_request",
        `could not read the body: ${String(error)}`,
        route.requestId,
      );
      return;
    }
    if (!body.ok) {
      apiError(route.res, 413, "payload_too_large", `body exceeds ${cap} bytes`, route.requestId);
      return;
    }
    const data = body.data;
    if (data.byteLength === 0) {
      apiError(route.res, 400, "invalid_request", "an uploaded file has no bytes", route.requestId);
      return;
    }

    const declared = String(route.req.headers["content-type"] ?? "");
    // The signature decides when the header names nothing this store reads: a
    // browser sends `image/jpg`, `application/octet-stream`, or nothing at all for
    // a body that is unambiguously a PNG, and refusing that would be a lie about
    // the file rather than about the header.
    const format = imageFormatOf(declared) ?? sniffImageFormat(data);
    let mime = declared;
    let width: number | undefined;
    let height: number | undefined;
    if (format !== undefined) {
      const size = readImageSize(data, IMAGE_MIME[format]);
      if (size === undefined) {
        apiError(
          route.res,
          400,
          "image_unreadable",
          `the image header does not declare a size (${format})`,
          route.requestId,
        );
        return;
      }
      if (size.width > config.server.imageMaxWidth || size.height > config.server.imageMaxHeight) {
        apiError(
          route.res,
          413,
          "image_dimensions_exceeded",
          `${size.width}x${size.height} exceeds ${config.server.imageMaxWidth}x${config.server.imageMaxHeight}`,
          route.requestId,
        );
        return;
      }
      mime = IMAGE_MIME[format];
      width = size.width;
      height = size.height;
    }

    const record = await createAttachment(attachmentContext(deps, options), {
      kind: "attachment",
      name: incomingName(route.url),
      mime,
      data,
      ...(width === undefined || height === undefined ? {} : { w: width, h: height }),
    });

    json(route.res, 201, {
      id: record.id,
      url: `/api/attachments/${record.id}`,
      mime: record.mime,
      bytes: record.bytes,
      sha256: record.sha256,
      name: record.name,
      ...(record.w === undefined || record.h === undefined ? {} : { w: record.w, h: record.h }),
    });
  });

  async function serve(route: RouteContext, download: boolean): Promise<void> {
    const id = route.params["id"] ?? "";
    // A segment can carry `%2F`, so the id is checked here and not only by the
    // router. The store refuses anything that is not a ULID of its own making.
    const record = isUlid(id)
      ? await getAttachment(attachmentContext(deps, options), id)
      : undefined;
    if (record === undefined) {
      apiError(route.res, 404, "not_found", "no such attachment", route.requestId);
      return;
    }
    let data: Buffer;
    try {
      data = await readAttachmentBytes(record);
    } catch {
      apiError(route.res, 404, "not_found", "no such attachment", route.requestId);
      return;
    }
    writeStoredFile(route.res, { data, mime: record.mime, name: record.name, download });
  }

  router.get("/api/attachments/:id", (route) => serve(route, false));
  router.get("/api/attachments/:id/download", (route) => serve(route, true));

  // What a message bubble needs to draw a file chip after a reload. The envelope
  // carries only ids, and the bytes are never part of this answer: a page that
  // has an id can ask what the file is called and how big it is without pulling
  // the file itself.
  router.get("/api/attachments/:id/meta", async (route) => {
    const id = route.params["id"] ?? "";
    const record = isUlid(id)
      ? await getAttachment(attachmentContext(deps, options), id)
      : undefined;
    if (record === undefined) {
      apiError(route.res, 404, "not_found", "no such attachment", route.requestId);
      return;
    }
    json(route.res, 200, {
      id: record.id,
      name: record.name,
      mime: record.mime,
      bytes: record.bytes,
      sha256: record.sha256,
      url: `/api/attachments/${record.id}`,
      ...(record.w === undefined || record.h === undefined ? {} : { w: record.w, h: record.h }),
    });
  });
}
