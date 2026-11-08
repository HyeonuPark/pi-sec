/**
 * The files waiting beside the composer: what was picked, how far its upload
 * got, and the ids the next message carries.
 *
 * One chip per picked file, in the order they were picked, each with its own
 * upload. A chip is `uploading`, `ready` with the server's id, or `failed` with
 * the reason and a Retry. A ready chip contributes its id to the next message,
 * and a send the server accepted empties the tray.
 *
 * Two things are measured rather than assumed, because both cost the operator
 * something: a picture that already fits the server's limit must not be decoded
 * and re-encoded (that loses a GIF its animation and costs a phone a second), and
 * a picture that is larger is drawn once, at the largest size the server takes.
 * Neither is a decision the server can make for the page, because the bytes are
 * already on their way by then.
 *
 * The tray itself is the operator's screen state: a chip keeps the element it
 * has while another chip moves, so a press on Retry is not taken away by an
 * upload that finished somewhere else.
 */
import { signal } from "@preact/signals";
import { request } from "../api/request.ts";
import type { UploadedAttachment, UploadedAttachmentAnswer } from "../../shared/wire/attachments.ts";
import { seedAttachmentInfo } from "./transcript.ts";

/** The most a picture may be, in pixels, before it is drawn down to fit. */
export const IMAGE_MAX_WIDTH = 1920;
export const IMAGE_MAX_HEIGHT = 1080;

/** What a shrunk picture that is not a PNG is written as. */
export const JPEG_QUALITY = 0.85;

/** How far one chip's upload has got. */
export type AttachmentStatus = "uploading" | "ready" | "failed";

/** One file in the tray. Every field is replaced on an update; the key is not. */
export interface AttachmentEntry {
  /** Names this chip, and the two buttons on it. Stable for the life of the chip. */
  readonly key: string;
  /** The file as it was picked, kept for a retry that needs no second pick. */
  readonly file: File;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly status: AttachmentStatus;
  /** The sentence a failed chip prints, empty otherwise. */
  readonly error: string;
  /** What this page did to the bytes, such as `shrunk to 1280×720`. */
  readonly note: string;
  /** The server's id, once it has one. A message names the file by it. */
  readonly id: string | null;
}

/** The files waiting beside the field, oldest first. */
export const attachments = signal<readonly AttachmentEntry[]>([]);

/** How many chips this page has made, so each key is its own. */
let keySeq = 0;

/** The server's own sentence for a failed upload, or the error itself. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** One entry, replaced rather than changed, so the chip's element survives. */
function updateEntry(key: string, change: Partial<AttachmentEntry>): AttachmentEntry | undefined {
  const current = attachments.value.find((entry) => entry.key === key);
  if (current === undefined) return undefined;
  const next: AttachmentEntry = { ...current, ...change };
  attachments.value = attachments.value.map((entry) => (entry.key === key ? next : entry));
  return next;
}

/** The size of a picture, and what can be drawn from it. */
interface ImageSource {
  readonly width: number;
  readonly height: number;
  readonly drawable: CanvasImageSource;
  /** Free whatever the reading held, once the pixels have been drawn. */
  release(): void;
}

/** One global the page may or may not have, read the way the bundle sees it. */
function pageGlobal<T>(name: string): T | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof value === "function" ? (value as T) : undefined;
}

/**
 * The same size, read the long way round: the file becomes a data URL and an
 * `<img>` decodes it.
 *
 * A data URL is what the page's CSP already allows for an image
 * (`img-src 'self' data:`), which an object URL is not, so this path works in the
 * browser it is meant for.
 */
function readImageSourceWithImage(file: File): Promise<ImageSource | undefined> {
  return new Promise((resolve) => {
    const Reader = pageGlobal<typeof FileReader>("FileReader");
    const ImageElement = pageGlobal<typeof Image>("Image");
    if (Reader === undefined || ImageElement === undefined) {
      resolve(undefined);
      return;
    }
    const reader = new Reader();
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const image = new ImageElement();
      image.onload = () =>
        resolve(
          image.naturalWidth > 0 && image.naturalHeight > 0
            ? { width: image.naturalWidth, height: image.naturalHeight, drawable: image, release: () => {} }
            : undefined,
        );
      image.onerror = () => resolve(undefined);
      image.src = String(reader.result ?? "");
    };
    reader.readAsDataURL(file);
  });
}

/**
 * How big a picture is, read without a canvas: `createImageBitmap` where the page
 * has it, an `<img>` otherwise.
 *
 * `undefined` means the page cannot read the size, which is a file it may still
 * send: the server decides what it takes, and a refusal there is the truth.
 */
function readImageSource(file: File): Promise<ImageSource | undefined> {
  return new Promise((resolve) => {
    const bitmapOf = pageGlobal<(blob: Blob) => Promise<ImageBitmap>>("createImageBitmap");
    if (bitmapOf === undefined) {
      resolve(readImageSourceWithImage(file));
      return;
    }
    void Promise.resolve(bitmapOf(file)).then(
      (bitmap) => {
        if (bitmap.width > 0 && bitmap.height > 0) {
          resolve({
            width: bitmap.width,
            height: bitmap.height,
            drawable: bitmap,
            release: () => {
              if (typeof bitmap.close === "function") bitmap.close();
            },
          });
          return;
        }
        if (typeof bitmap.close === "function") bitmap.close();
        resolve(readImageSourceWithImage(file));
      },
      () => resolve(readImageSourceWithImage(file)),
    );
  });
}

/** The bytes that go to the server for one picked file, and what was done to them. */
export interface PreparedAttachment {
  readonly blob: Blob;
  readonly mime: string;
  readonly name: string;
  readonly note: string;
}

/**
 * The one place a canvas is used: the picture is larger than the server takes, so
 * it is drawn once at `min(1, 1920/w, 1080/h)`.
 *
 * A PNG stays a PNG and everything else becomes a JPEG at {@link JPEG_QUALITY},
 * which is what makes a screenshot small enough to keep. A shrunk GIF keeps its
 * first frame only.
 */
function shrinkImage(file: File, source: ImageSource): Promise<PreparedAttachment | undefined> {
  return new Promise((resolve) => {
    const ratio = Math.min(1, IMAGE_MAX_WIDTH / source.width, IMAGE_MAX_HEIGHT / source.height);
    const width = Math.max(1, Math.round(source.width * ratio));
    const height = Math.max(1, Math.round(source.height * ratio));
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    if (context === null) {
      resolve(undefined);
      return;
    }
    context.drawImage(source.drawable, 0, 0, width, height);
    const done = (blob: Blob | null | undefined): void => {
      if (blob === null || blob === undefined) {
        resolve(undefined);
        return;
      }
      const frame = file.type === "image/gif" ? ", first frame" : "";
      resolve({ blob, mime: type, name: file.name, note: `shrunk to ${width}×${height}${frame}` });
    };
    try {
      canvas.toBlob(done, type, type === "image/jpeg" ? JPEG_QUALITY : undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * The bytes that go to the server for one picked file.
 *
 * The happy path is the file itself, untouched: when a picture already fits
 * 1920×1080 there is nothing to gain by decoding and re-encoding it. So the size
 * is read first and the canvas is reached only when the source is larger. A size
 * that cannot be read is not a reason to shrink: the file goes as it is and the
 * server decides.
 */
export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  const untouched: PreparedAttachment = {
    blob: file,
    mime: file.type === "" || file.type === undefined ? "application/octet-stream" : file.type,
    name: file.name,
    note: "",
  };
  if (!(file.type ?? "").startsWith("image/")) return untouched;
  const source = await readImageSource(file);
  if (source === undefined) return { ...untouched, note: "size could not be read, sent as it is" };
  try {
    if (source.width <= IMAGE_MAX_WIDTH && source.height <= IMAGE_MAX_HEIGHT) return untouched;
    const shrunk = await shrinkImage(file, source);
    return shrunk ?? untouched;
  } finally {
    source.release();
  }
}

/**
 * Upload one file and read back the record the server made of it.
 *
 * The route takes the file itself as the body, so the name is metadata and
 * travels in the query: a body is the bytes alone. `request` hands its body to
 * `fetch` as it is, so the bytes go with the file's own content type; the cast is
 * the one place this page says so, because that option speaks of a JSON body.
 */
export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const prepared = await prepareAttachment(file);
  const route = `/api/attachments?name=${encodeURIComponent(file.name)}`;
  const answer = await request<UploadedAttachmentAnswer>(route, {
    method: "POST",
    headers: { "Content-Type": prepared.mime },
    body: prepared.blob as unknown as string,
  });
  return {
    id: typeof answer?.id === "string" ? answer.id : "",
    url: typeof answer?.url === "string" ? answer.url : "",
    mime: typeof answer?.mime === "string" ? answer.mime : prepared.mime,
    name: typeof answer?.name === "string" ? answer.name : file.name,
    bytes: typeof answer?.bytes === "number" ? answer.bytes : prepared.blob.size,
    w: typeof answer?.w === "number" ? answer.w : undefined,
    h: typeof answer?.h === "number" ? answer.h : undefined,
    note: prepared.note,
  };
}

/**
 * Put one chip through its states: uploading, then ready or failed.
 *
 * Every state is drawn, so a chip that is still moving is never mistaken for one
 * that is ready to send. A chip the operator removed while its upload was on its
 * way is not drawn again, and its answer is dropped.
 */
export async function uploadAttachmentEntry(key: string): Promise<void> {
  const entry = updateEntry(key, { status: "uploading", error: "" });
  if (entry === undefined) return;
  try {
    const record = await uploadAttachment(entry.file);
    if (record.id === "") throw new Error("the server did not name the upload");
    const ready = updateEntry(key, {
      id: record.id,
      name: record.name === "" ? entry.name : record.name,
      mime: record.mime,
      bytes: record.bytes,
      note: record.note,
      status: "ready",
      error: "",
    });
    if (ready === undefined) return;
    // Remembered here, so the bubble that comes back from the transcript names
    // the file instead of printing its id.
    seedAttachmentInfo({
      attachments: { [record.id]: { name: ready.name, mime: ready.mime, bytes: ready.bytes, w: record.w, h: record.h } },
    });
  } catch (error) {
    updateEntry(key, { status: "failed", error: messageOf(error) });
  }
}

/** Take the files a picker returned, and upload every one of them. */
export function addAttachmentFiles(files: Iterable<File>): void {
  const picked = [...files];
  if (picked.length === 0) return;
  const added: AttachmentEntry[] = picked.map((file) => {
    keySeq += 1;
    return {
      key: `att-${keySeq}`,
      file,
      name: file.name === "" ? "attachment" : file.name,
      bytes: file.size,
      mime: file.type === "" ? "application/octet-stream" : file.type,
      status: "uploading",
      error: "",
      note: "",
      id: null,
    };
  });
  attachments.value = [...attachments.value, ...added];
  for (const entry of added) void uploadAttachmentEntry(entry.key);
}

/** Upload one failed chip again, on the file it already holds. */
export function retryAttachment(key: string): void {
  const entry = attachments.value.find((item) => item.key === key);
  if (entry === undefined) return;
  void uploadAttachmentEntry(key);
}

/** Drop one chip: the file does not go with the next message. */
export function removeAttachment(key: string): void {
  attachments.value = attachments.value.filter((entry) => entry.key !== key);
}

/** The ids ready to go with the next message, in the order they were picked. */
export function readyAttachmentIds(): string[] {
  return attachments.value
    .filter((entry) => entry.status === "ready" && typeof entry.id === "string" && entry.id !== "")
    .map((entry) => entry.id as string);
}

/** Whether a chip is still moving. A send now would drop it and say nothing. */
export function attachmentIsUploading(): boolean {
  return attachments.value.some((entry) => entry.status === "uploading");
}

/** Empty the tray, which a send the server accepted does. */
export function clearAttachments(): void {
  if (attachments.value.length === 0) return;
  attachments.value = [];
}
