import { readFile, stat } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  defineExtension,
  hook,
  type Extension,
  type HookApi,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { SHARE_DOC_KIND, SecAttachment, SecShare, type AttachmentRecord } from "../attachments/store.ts";
import { imageFormatOf } from "../attachments/image-size.ts";
import { readMessage } from "../message-envelope.ts";
import { isUlid } from "../runtime/ids.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";
import type { ExtensionContext } from "./context.ts";

/**
 * The materialization hook: a stored reference becomes an image part, once per
 * request.
 *
 * The transcript carries text and nothing else. An attachment is written into
 * the transcript as a reference — the envelope attribute `attachments="id,id"`
 * or a markdown image URL — and this hook turns each reference into an
 * `{type:"image"}` part when the request is built. Two consequences are the
 * reason the split exists:
 *
 *   - A stored entry never carries base64. An entry is re-read on every turn, so
 *     a picture inside one would be re-read from the database for the life of
 *     the conversation.
 *   - The request is deterministic. The same file produces the same bytes, so
 *     the same prefix is built every turn and the provider's prefix cache holds.
 *     A file never changes: the store writes each body once.
 *
 * Only the standard `ImageContent` part is produced. A custom part type is
 * outside the provider union and is dropped, silently, by the conversion.
 *
 * Ordering is the one thing this hook depends on. It must run after the
 * `secrets` redaction hook: the injected base64 is not text that came from the
 * operator, and passing a large opaque string through the redactor is both
 * wasted work and a chance to alter bytes the model is meant to see. The order
 * comes from extension registration order, which `src/extensions/index.ts`
 * states and `test/attachments-context.test.ts` pins.
 */

/** A reference to one stored file, as found in message text. */
export interface AttachmentRef {
  readonly kind: "attachment" | "share";
  /** An attachment id, or a share file name. */
  readonly key: string;
}

/** Markdown image syntax. Only an explicit image reference materializes. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s<>"']+)>?\s*\)/g;

/** The served URL of an operator attachment, with or without a mount prefix. */
const ATTACHMENT_URL = /(?:^|\/)api\/attachments\/([^/?#]+)\/?$/;

/** The served URL of a share file, with or without a mount prefix. */
const SHARE_URL = /(?:^|\/)api\/share\/([^/?#]+)$/;

/** One path segment. The same alphabet `shareNameFor` produces. */
const SHARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * Every reference one text carries, in the order it appears, without repeats.
 *
 * The envelope attribute is read through `readMessage`, so the escaping rules of
 * the envelope are applied in the one place that owns them rather than a second
 * time here.
 */
export function attachmentRefsInText(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  const push = (ref: AttachmentRef): void => {
    const id = `${ref.kind}:${ref.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push(ref);
  };

  const attribute = readMessage(text)?.attrs["attachments"];
  if (attribute !== undefined) {
    for (const part of attribute.split(",")) {
      const id = part.trim();
      if (isUlid(id)) push({ kind: "attachment", key: id });
    }
  }

  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const url = match[1];
    if (url === undefined) continue;
    const attachment = ATTACHMENT_URL.exec(url);
    if (attachment !== null) {
      const id = attachment[1];
      if (id !== undefined && isUlid(id)) push({ kind: "attachment", key: id });
      continue;
    }
    const share = SHARE_URL.exec(url);
    if (share === null) continue;
    const name = share[1];
    if (name !== undefined && SHARE_NAME.test(name)) push({ kind: "share", key: name });
  }
  return refs;
}

/** One materialized file, kept while its file is unchanged. */
interface CachedImage {
  readonly mtimeMs: number;
  readonly size: number;
  readonly data: string;
  readonly mimeType: string;
}

/** How many images the cache holds before the oldest is dropped. */
const CACHE_LIMIT = 256;

/**
 * What one hook pass may read and remember.
 *
 * `images` is keyed by path and validated by `(mtime, size)`; `shares` maps a
 * share name to the id of the record that serves it, so a transcript full of
 * `/api/share/<name>` URLs costs one scan and then one snapshot per request.
 */
export interface MaterializeDeps {
  readonly storage: Storage;
  readonly images: Map<string, CachedImage>;
  readonly shares: Map<string, string>;
}

/** The base64 of one file, from the cache when the file has not moved. */
async function imageOf(record: AttachmentRecord, deps: MaterializeDeps): Promise<ImageContent | undefined> {
  if (imageFormatOf(record.mime) === undefined) return undefined;
  const info = await stat(record.storagePath);
  const cached = deps.images.get(record.storagePath);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { type: "image", data: cached.data, mimeType: cached.mimeType };
  }
  const bytes = await readFile(record.storagePath);
  const data = bytes.toString("base64");
  deps.images.set(record.storagePath, { mtimeMs: info.mtimeMs, size: info.size, data, mimeType: record.mime });
  if (deps.images.size > CACHE_LIMIT) {
    for (const key of deps.images.keys()) {
      deps.images.delete(key);
      if (deps.images.size <= CACHE_LIMIT) break;
    }
  }
  return { type: "image", data, mimeType: record.mime };
}

/** One record by id, whichever of the two families holds it. */
async function recordById(api: HookApi, id: string, context: Context): Promise<AttachmentRecord | undefined> {
  const attachment = await api.snapshot(SecAttachment, id, context);
  if (attachment !== undefined) return attachment;
  return await api.snapshot(SecShare, id, context);
}

/**
 * The record that serves a share name.
 *
 * A share file is addressed by name in its URL and by ULID in the store, so the
 * name has to be resolved. The mapping is remembered: a name is written once
 * with the file, and the snapshot that follows proves the record still exists.
 */
async function recordByShareName(
  api: HookApi,
  name: string,
  context: Context,
  deps: MaterializeDeps,
): Promise<AttachmentRecord | undefined> {
  const known = deps.shares.get(name);
  if (known !== undefined) {
    const record = await api.snapshot(SecShare, known, context);
    if (record !== undefined && record.name === name) return record;
    deps.shares.delete(name);
  }
  for (const key of await scanDocumentKeys(deps.storage, SHARE_DOC_KIND, context)) {
    const record = await api.snapshot(SecShare, key, context);
    if (record === undefined || record.name !== name) continue;
    deps.shares.set(name, record.id);
    return record;
  }
  return undefined;
}

/** The image parts one message's text refers to. Unreadable references are skipped. */
async function imagesFor(message: Message, api: HookApi, context: Context, deps: MaterializeDeps): Promise<ImageContent[]> {
  const text = textOf(message);
  if (text === undefined || text.length === 0) return [];
  const found: ImageContent[] = [];
  const seen = new Set<string>();
  for (const ref of attachmentRefsInText(text)) {
    try {
      const record =
        ref.kind === "attachment"
          ? await recordById(api, ref.key, context)
          : await recordByShareName(api, ref.key, context, deps);
      if (record === undefined) continue;
      if (seen.has(record.id)) continue;
      const image = await imageOf(record, deps);
      if (image === undefined) continue;
      seen.add(record.id);
      found.push(image);
    } catch {
      // A missing file, an unreadable row, a scan that fails: the reference stays
      // in the text and the turn goes on without the picture. A request that
      // failed because one screenshot was swept would be worse than a missing
      // image the model can be told about again.
    }
  }
  return found;
}

/** The text a message carries, whichever shape its content is. */
function textOf(message: Message): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  const parts: string[] = [];
  for (const part of message.content) if (part.type === "text") parts.push(part.text);
  return parts.join("\n");
}

/**
 * The messages of one request with image parts appended.
 *
 * Only user-role content is extended. `AssistantMessage.content` is typed
 * without `ImageContent`, and the provider conversion keeps only its text blocks
 * (`pi-ai/dist/api/openai-completions.js`), so a part added there would be a
 * type error and would not reach the model either. An image the agent showed in
 * its own reply stays in the transcript as text; `attachment_open` brings the
 * picture back when it is needed again.
 *
 * An unchanged message keeps its exact shape, and a request with nothing to
 * materialize returns `undefined`: the caller then leaves the messages as they
 * are, which is what keeps a request without attachments byte-identical to what
 * it was before this extension existed.
 */
export async function materializeMessages(
  messages: readonly Message[],
  api: HookApi,
  context: Context,
  deps: MaterializeDeps,
): Promise<readonly Message[] | undefined> {
  let changed = false;
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      out.push(message);
      continue;
    }
    const images = await imagesFor(message, api, context, deps);
    if (images.length === 0) {
      out.push(message);
      continue;
    }
    const parts: (TextContent | ImageContent)[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
    const withImages: UserMessage = { ...message, content: [...parts, ...images] };
    out.push(withImages);
    changed = true;
  }
  return changed ? out : undefined;
}

/**
 * The bundled `attachment-context` extension.
 *
 * It offers no tool and no section: its whole job is the request hook. It is
 * registered in the core phase directly after `secrets`, so the redaction hook
 * runs first — see the note at the head of this file.
 */
export function createAttachmentContextExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const deps: MaterializeDeps = { storage: context.storage, images: new Map(), shares: new Map() };
  return defineExtension({
    name: "attachment-context",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, chord) => {
          const messages = await materializeMessages(request.messages, api, chord, deps);
          return messages === undefined ? undefined : { messages };
        },
      }),
    ],
  });
}
