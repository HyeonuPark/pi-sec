import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { configuredPrefix } from "../server/proxy.ts";
import { imageFormatOf, readImageSize, sniffImageFormat, type ImageFormat } from "../attachments/image-size.ts";
import {
  assignAttachments,
  createAttachment,
  getAttachment,
  listAttachments,
  readAttachmentBytes,
  type AttachmentRecord,
} from "../attachments/store.ts";
import type { ExtensionContext } from "./context.ts";
import { withLocal } from "../time-format.ts";

/**
 * The attachment tools: publish an image into a reply, open a stored one again,
 * list what exists, and give files to a job.
 *
 * The three that read or write files go through `src/attachments/store.ts`, so
 * there is one writer of the roots and one index. Nothing here reaches into a
 * path by hand except the `source` a caller named.
 *
 * `attachments_assign` is the root's tool: `src/agent/tool-profile.ts` removes it
 * from every subagent and scheduled run, because ownership of a job's files is
 * part of the operator's channel.
 */

/** The MIME of each image format the store understands. */
const MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Extension to image MIME, for bytes whose header is not one we recognize. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A `data:` URL: `data:<mime>;base64,<payload>`. */
const DATA_URL = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/s;

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function mimeOf(name: string, data: Buffer): string {
  const format = sniffImageFormat(data);
  if (format !== undefined) return MIME_BY_FORMAT[format];
  return MIME_BY_EXTENSION[extensionOf(name)] ?? "application/octet-stream";
}

/** One file read from a path or a base64 `data:` URL. */
interface SourceFile {
  readonly name: string;
  readonly data: Buffer;
  readonly mime: string;
}

async function readSource(context: ExtensionContext, source: string): Promise<SourceFile> {
  const data = DATA_URL.exec(source);
  if (data !== null) {
    const declared = data[1];
    const parameters = data[2] ?? "";
    const payload = data[3] ?? "";
    const bytes = parameters.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    const mime = declared ?? mimeOf("", bytes);
    const extension = Object.entries(MIME_BY_FORMAT).find(([, value]) => value === mime)?.[0] ?? "";
    return { name: `image${extension === "" ? "" : `.${extension === "jpeg" ? "jpg" : extension}`}`, data: bytes, mime };
  }
  const path = isAbsolute(source) ? source : join(context.paths.workspaceTree, source);
  const bytes = await readFile(path);
  return { name: basename(path), data: bytes, mime: mimeOf(path, bytes) };
}

/**
 * The mount this daemon is served under, from the configuration.
 *
 * A tool call carries no request, so the prefix a trusted proxy announces in
 * `X-Forwarded-Prefix` is not available here. `configuredPrefix` is the part of
 * `resolveMount` that needs no request: `server.basePath`, or the path of
 * `server.publicUrl`.
 *
 * A context that cannot read the config answers the empty prefix, which is what
 * a server with no mount emits anyway.
 */
export function mountPrefixOf(context: ExtensionContext): string {
  if (typeof context.getConfig !== "function") return "";
  const config = context.getConfig();
  return configuredPrefix(config.server.basePath, config.server.publicUrl);
}

/**
 * The served URL of one record: the mount prefix, then the route.
 *
 * The browser prefixes the API calls it makes itself, so this URL must carry
 * the mount: a reader follows it as it stands, from whatever page it was on.
 */
export function urlOf(record: AttachmentRecord, prefix = ""): string {
  const route =
    record.kind === "attachment"
      ? `/api/attachments/${record.id}`
      : `/api/share/${encodeURIComponent(record.name)}`;
  return `${prefix.replace(/\/+$/, "")}${route}`;
}

/** The fields a caller reads back, never the storage path. */
function describe(record: AttachmentRecord, prefix: string): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mime: record.mime,
    bytes: record.bytes,
    url: urlOf(record, prefix),
    ...(record.w === undefined ? {} : { w: record.w }),
    ...(record.h === undefined ? {} : { h: record.h }),
    ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    collectedAt: record.collectedAt,
  };
}

function textResult(text: string, isError = false): { output: { type: "text"; text: string }[]; isError?: boolean } {
  return isError ? { output: [{ type: "text" as const, text }], isError: true } : { output: [{ type: "text" as const, text }] };
}

/**
 * The bundled `attachments` extension.
 *
 * `context` is passed to the store unchanged: `ExtensionContext` satisfies what
 * the store needs, and the store reads the harness lazily, because the harness
 * does not exist yet when this extension is installed.
 */
export function createAttachmentsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const shareImage = defineTool({
    name: "share_image",
    description:
      "Publish an image file so it can be shown in a reply. Copies it under the share root and returns the id and a markdown image tag to paste into the answer.",
    parameters: obj(
      {
        source: str({
          description: "Path to the image, absolute or relative to the workspace, or a base64 data: URL.",
        }),
        name: opt(str({ description: "File name to publish under. Defaults to the source name." })),
        jobId: opt(str({ description: "Job that owns the file. Omit to leave it unowned." })),
        alt: opt(str({ description: "Alt text for the markdown image tag." })),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      let source: SourceFile;
      try {
        source = await readSource(context, args.source);
      } catch (error) {
        return textResult(`Cannot read ${args.source}: ${String(error)}`, true);
      }
      const jobId = args.jobId;
      if (jobId !== undefined) {
        const job = await context.jobs?.get(ctx, jobId);
        if (context.jobs !== undefined && job === undefined) {
          return textResult(`Job not found: ${jobId}. A shared file must belong to a live job or to none.`, true);
        }
      }
      const size = readImageSize(source.data, source.mime);
      const record = await createAttachment(context, {
        kind: "share",
        name: args.name ?? source.name,
        mime: source.mime,
        data: source.data,
        ...(size === undefined ? {} : { w: size.width, h: size.height }),
        ...(jobId === undefined ? {} : { jobId }),
        conversationId: String(api.conversationId),
      });
      const url = urlOf(record, mountPrefixOf(context));
      const markdown = `![${args.alt ?? ""}](${url})`;
      return textResult(
        JSON.stringify({
          id: record.id,
          url,
          markdown,
          bytes: record.bytes,
          mime: record.mime,
          ...(record.w === undefined ? {} : { w: record.w }),
          ...(record.h === undefined ? {} : { h: record.h }),
        }),
      );
    },
  });

  const open = defineTool({
    name: "attachment_open",
    description:
      "Read a stored attachment again and show it as an image part. Use it after a compaction dropped a picture from the transcript.",
    parameters: obj(
      {
        id: str({ description: "The attachment or share id." }),
      },
    ),
    replay: "safe",
    execute: async (args) => {
      const record = await getAttachment(context, args.id);
      if (record === undefined) return textResult(`No attachment with id ${args.id}.`, true);
      const url = urlOf(record, mountPrefixOf(context));
      const head = `${record.kind} ${record.id}: ${record.name}, ${record.mime}, ${record.bytes} bytes\n${url}`;
      if (imageFormatOf(record.mime) === undefined) {
        return textResult(`${head}\nThis file is not an image, so it cannot be shown.`);
      }
      let data: string;
      try {
        data = (await readAttachmentBytes(record)).toString("base64");
      } catch (error) {
        return textResult(`${head}\nThe file is no longer readable: ${String(error)}`, true);
      }
      return {
        output: [
          { type: "text" as const, text: head },
          { type: "image" as const, data, mimeType: record.mime },
        ],
      };
    },
  });

  const list = defineTool({
    name: "attachments_list",
    description:
      "List stored attachments and shared files, newest last, with the id of each. Narrow with conversationId or jobId.",
    parameters: obj(
      {
        conversationId: opt(str({ description: "Only this conversation's files." })),
        jobId: opt(str({ description: "Only this job's files." })),
      },
    ),
    replay: "safe",
    execute: async (args) => {
      const found = await listAttachments(context, {
        ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
        ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      });
      const prefix = mountPrefixOf(context);
      // The number stays and a readable twin goes beside it, in the harness
      // zone. Only this listing adds it: the other attachment tools answer about
      // one file and no reader of them asks for a twin.
      const zone = context.getConfig().timezone;
      return textResult(
        JSON.stringify({
          attachments: found.slice(-200).map((record) => withLocal(describe(record, prefix), ["collectedAt"], zone)),
        }),
      );
    },
  });

  const assign = defineTool({
    name: "attachments_assign",
    description:
      "Give files to a job, so they live as long as the job does and are deleted when it is archived. The root's tool.",
    parameters: obj(
      {
        ids: arr(str(), { description: "Attachment or share ids." }),
        jobId: str({ description: "The job that now owns the files." }),
      },
    ),
    replay: "unsafe",
    execute: async (args) => {
      const result = await assignAttachments(context, args.ids, args.jobId);
      return textResult(JSON.stringify(result));
    },
  });

  return defineExtension({
    name: "attachments",
    tools: [shareImage, open, list, assign],
  });
}
