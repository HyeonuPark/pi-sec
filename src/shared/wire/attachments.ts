/**
 * What the composer sends to the attachment route, and what comes back.
 *
 * `POST /api/attachments?name=<file name>` takes the file itself as the body,
 * with the file's own content type, and answers the record it stored
 * (`src/server/routes/attachments.ts`). The page needs the id, because a message
 * carries ids and nothing else, and the name, size and picture size, because the
 * chip above the field and the bubble in the transcript both print them.
 *
 * These are wire shapes only: no code, and no import of `src/server`, so the page
 * type check does not pull Node in with them.
 */

/** The record the route answers with, as the page reads it. */
export interface UploadedAttachment {
  /** The id a message names this file by. */
  readonly id: string;
  /** The route the bytes are served from, under the mount. */
  readonly url: string;
  /** The type the server stored it as, which is sniffed when the header is vague. */
  readonly mime: string;
  /** The name the server kept, which is the one that travelled in the query. */
  readonly name: string;
  readonly bytes: number;
  /** A picture's width and height, when the server could read them. */
  readonly w?: number;
  readonly h?: number;
  /**
   * What this page did to the file before sending it, such as `shrunk to
   * 1280×720`. Not part of the answer: the chip's tooltip carries it.
   */
  readonly note: string;
}

/**
 * The route's answer before it is read: every field may be missing, and a
 * refusal answers the app's error shape instead.
 */
export interface UploadedAttachmentAnswer {
  readonly id?: unknown;
  readonly url?: unknown;
  readonly mime?: unknown;
  readonly name?: unknown;
  readonly bytes?: unknown;
  readonly w?: unknown;
  readonly h?: unknown;
}
