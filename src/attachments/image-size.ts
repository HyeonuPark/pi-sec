/**
 * Pixel size read from an image header, with no decoder.
 *
 * The store has no image codec dependency (no sharp, jimp or canvas), and the
 * upload route must not re-encode an operator's file: it reads the size from the
 * header and refuses anything over the cap. So the only thing needed here is the
 * first few dozen bytes of four container formats.
 *
 * `undefined` means "this reader cannot say". The caller decides whether that is
 * a refusal (an `image/*` body) or a fact it can ignore (anything else).
 */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/**
 * The formats whose size this reader can produce.
 *
 * The upload route keeps its own allow-list; this is only what the header
 * reader understands, and the two are allowed to disagree.
 */
export const READABLE_IMAGE_FORMATS: readonly ImageFormat[] = ["png", "jpeg", "gif", "webp"];

/** The format a MIME string names, or `undefined` for anything else. */
export function imageFormatOf(mime: string): ImageFormat | undefined {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base === "image/png") return "png";
  if (base === "image/jpeg" || base === "image/jpg" || base === "image/pjpeg") return "jpeg";
  if (base === "image/gif") return "gif";
  if (base === "image/webp") return "webp";
  return undefined;
}

/** The format the leading bytes name, for a body whose MIME says nothing useful. */
export function sniffImageFormat(buf: Buffer): ImageFormat | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("latin1", 0, 3) === "GIF") return "gif";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

/**
 * The size of one image, by its declared MIME first and by its signature second.
 *
 * The signature is the fallback because a browser can send `image/jpg` or no
 * type at all for a body that is unambiguously a PNG; refusing such a body would
 * be a lie about the file, not about the MIME.
 */
export function readImageSize(buf: Buffer, mime: string): ImageSize | undefined {
  const format = imageFormatOf(mime) ?? sniffImageFormat(buf);
  switch (format) {
    case "png":
      return readPng(buf);
    case "jpeg":
      return readJpeg(buf);
    case "gif":
      return readGif(buf);
    case "webp":
      return readWebp(buf);
    default:
      return undefined;
  }
}

/** A size is only a size when both halves are positive and inside 32 bits. */
function size(width: number, height: number): ImageSize | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  if (width > 0x7fffffff || height > 0x7fffffff) return undefined;
  return { width, height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IHDR is the first chunk of every valid PNG, so the size is at a fixed offset. */
function readPng(buf: Buffer): ImageSize | undefined {
  if (buf.length < 24) return undefined;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return size(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

/** The logical screen descriptor holds the size a viewer lays out. */
function readGif(buf: Buffer): ImageSize | undefined {
  if (buf.length < 10) return undefined;
  const signature = buf.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return size(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

/** Markers that stand alone: no length field follows them. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Any SOF marker except the four that are not frames.
 *
 * `0xc4` (Huffman table), `0xc8` (JPEG extension) and `0xcc` (arithmetic coding
 * table) sit in the same numeric range and would be misread as a frame header.
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walk the marker segments to the first frame header.
 *
 * The size is not at a fixed offset in a JPEG — application segments of any
 * length can precede it, and a progressive file names its frame in a different
 * marker — so the segments are followed by their own length fields.
 */
function readJpeg(buf: Buffer): ImageSize | undefined {
  if (buf.length < 4) return undefined;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let offset = 2;
  // A segment is at least two bytes, so the loop always advances; the bound is
  // the buffer, and a truncated file falls out of it.
  while (offset + 2 <= buf.length) {
    if (buf[offset] !== 0xff) {
      // Not at a marker: resync rather than refuse, because a stray byte before
      // the first segment costs nothing and refusing costs the whole file.
      offset += 1;
      continue;
    }
    let at = offset + 1;
    let marker = buf[at] ?? 0;
    while (marker === 0xff && at + 1 < buf.length) {
      at += 1;
      marker = buf[at] ?? 0;
    }
    at += 1;
    offset = at;
    if (marker === 0x00) continue;
    if (isStandaloneMarker(marker)) continue;
    // End of image, or the start of the scan: no frame header came first.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (offset + 2 > buf.length) return undefined;
    const length = buf.readUInt16BE(offset);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (offset + 7 > buf.length) return undefined;
      return size(buf.readUInt16BE(offset + 5), buf.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return undefined;
}

function readUInt24LE(buf: Buffer, at: number): number {
  return (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8) | ((buf[at + 2] ?? 0) << 16);
}

/**
 * WebP holds three different payloads under one container.
 *
 * `VP8 ` is the lossy frame (size after a 3-byte start code), `VP8L` is the
 * lossless one (both sizes packed into 32 bits), and `VP8X` is an extended file
 * whose canvas size is three bytes each and stored minus one.
 */
function readWebp(buf: Buffer): ImageSize | undefined {
  if (buf.length < 16) return undefined;
  if (buf.toString("latin1", 0, 4) !== "RIFF") return undefined;
  if (buf.toString("latin1", 8, 12) !== "WEBP") return undefined;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    if (buf.length < 30) return undefined;
    return size(readUInt24LE(buf, 24) + 1, readUInt24LE(buf, 27) + 1);
  }
  if (chunk === "VP8 ") {
    if (buf.length < 30) return undefined;
    // The key frame start code sits before the size; without it this is not a frame.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (buf.length < 25) return undefined;
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}
