/**
 * Shared setup of the rich page tests: a harness over temporary share roots, a
 * server on port 0, and the `attachments` tools bound to the same roots.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { createAttachmentsExtension } from "../src/extensions/attachments.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import type { AttachmentContext, AttachmentRoots } from "../src/attachments/store.ts";
import type { StartedServer } from "../src/server/server.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

export interface RichPagesFixture {
  readonly h: TestHarness;
  readonly origin: string;
  readonly base: string;
  readonly roots: AttachmentRoots;
  readonly started: StartedServer;
  /** The store context over the temporary roots. */
  ctx(): AttachmentContext;
  /** One `attachments` tool by name. */
  tool(name: string, options?: { prefix?: string; jobs?: AttachmentContext["jobs"] }): ToolLike;
  close(): Promise<void>;
}

export interface ToolLike {
  name: string;
  execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<unknown>;
}

export const toolApi = { conversationId: 41 } as unknown as ToolExecutionApi;

export function textOf(result: unknown): string {
  const content = (result as { output: readonly { type: string; text?: string }[] }).output;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

export function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

export async function bootRichPages(): Promise<RichPagesFixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-sec-rich-pages-"));
  const roots: AttachmentRoots = { attachments: join(base, "attachments"), share: join(base, "share") };
  await mkdir(roots.attachments, { recursive: true, mode: 0o700 });
  await mkdir(roots.share, { recursive: true, mode: 0o700 });
  const h = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0, trustedProxies: ["127.0.0.1/32", "::1/128"] } } });
  const started = await startTestServer(h, { attachmentRoots: roots });
  const ctx = (): AttachmentContext => ({
    storage: h.runtime.storage,
    harness: h.runtime.harness,
    audit: h.runtime.audit,
    roots,
  });
  return {
    h,
    origin: started.origin,
    base,
    roots,
    started,
    ctx,
    tool(name, options = {}) {
      const config = h.runtime.getConfig();
      const context = {
        storage: h.runtime.storage,
        harness: h.runtime.harness,
        audit: h.runtime.audit,
        paths: h.paths,
        roots,
        getConfig: () =>
          options.prefix === undefined
            ? config
            : { ...config, server: { ...config.server, basePath: options.prefix } },
        ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      } as unknown as ExtensionContext;
      const found = createAttachmentsExtension(context).tools?.find((tool) => tool.name === name);
      if (found === undefined) throw new Error(`no tool ${name}`);
      return found as unknown as ToolLike;
    },
    async close() {
      await started.close();
      await h.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

export { BACKGROUND_CONTEXT };
