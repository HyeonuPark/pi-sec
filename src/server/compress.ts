import { gzipSync, constants as zlibConstants } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Response compression, in one place.
 *
 * The daemon sends a chat page, nine static assets, JSON answers and three event
 * streams, and on a slow tunnel the difference between sending them whole and
 * sending them gzipped is most of the load time. Only gzip: it carried almost all
 * of the measured gain, and every browser and every intermediary handles it.
 *
 * A body is compressed only when the client asked for gzip and the type is one
 * that compresses (text and JSON, never a picture), and only when it is large
 * enough for the header and the CPU to pay for themselves.
 */

/** Below this size a body is sent as it is: the gzip frame costs more than it saves. */
export const GZIP_MIN_BYTES = 1024;

const COMPRESSIBLE = [/^text\/html/i, /^text\/javascript/i, /^text\/css/i, /^application\/json/i, /^image\/svg\+xml/i];

/** Whether a `Content-Type` names something worth compressing. */
export function isCompressibleType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return COMPRESSIBLE.some((pattern) => pattern.test(contentType));
}

/**
 * Whether the request accepts gzip.
 *
 * `gzip;q=0` is a refusal, not a request, so the quality value is read rather
 * than the presence of the token. A parameter list this code cannot parse counts
 * as no gzip, which is the safe direction: an uncompressed answer is always valid.
 * Node's `response.req` reaches the request, which is how a route that only holds
 * the response can ask.
 */
export function acceptsGzip(req: IncomingMessage | undefined): boolean {
  const header: unknown = req?.headers["accept-encoding"];
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : String(header);
  let best = 0;
  for (const part of value.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName?.trim().toLowerCase();
    if (name !== "gzip" && name !== "x-gzip") continue;
    let quality = 1;
    for (const param of params) {
      const [rawKey, rawValue] = param.split("=");
      if (rawKey?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue?.trim());
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    if (quality > best) best = quality;
  }
  return best > 0;
}

/** `Vary` with `Accept-Encoding` in it, once. */
function withAcceptEncoding(vary: string | undefined): string {
  if (vary === undefined || vary.trim() === "") return "Accept-Encoding";
  const parts = vary.split(",").map((part) => part.trim().toLowerCase());
  if (parts.includes("accept-encoding") || parts.includes("*")) return vary;
  return `${vary}, Accept-Encoding`;
}

export interface BodyAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string | Buffer;
  /** Headers the route sets itself. They are kept byte for byte. */
  readonly headers?: Record<string, string>;
}

/**
 * Write one whole body, gzipped when the client asked for it and the type pays.
 *
 * A compressible type always carries `Vary: Accept-Encoding`, compressed or not,
 * so no cache can hand a gzipped body to a client that cannot read it.
 */
export function sendBody(res: ServerResponse, answer: BodyAnswer): void {
  const headers: Record<string, string> = { "Content-Type": answer.contentType, ...answer.headers };
  const body = typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : answer.body;
  const compressible = isCompressibleType(answer.contentType);
  if (compressible) headers["Vary"] = withAcceptEncoding(headers["Vary"]);
  const compress =
    compressible && body.byteLength >= GZIP_MIN_BYTES && headers["Content-Encoding"] === undefined && acceptsGzip(res.req);
  const payload = compress ? gzipSync(body) : body;
  if (compress) headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = String(payload.byteLength);
  res.writeHead(answer.status, headers);
  res.end(payload);
}

/** One body as gzip bytes, for a caller that caches the result. */
export function gzipBody(body: Buffer): Buffer {
  return gzipSync(body, { level: zlibConstants.Z_DEFAULT_COMPRESSION });
}
