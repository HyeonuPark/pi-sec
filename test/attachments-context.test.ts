import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type HookApi, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { createAttachment, type AttachmentContext, type AttachmentRecord } from "../src/attachments/store.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { createAttachmentsExtension } from "../src/extensions/attachments.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { wrapMessage } from "../src/message-envelope.ts";
import { attachmentAttrs } from "../src/server/routes/basic-chat.ts";
import { submitEnveloped } from "../src/submit-envelope.ts";
import type { StartedServer } from "../src/server/server.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A file whose base64 carries a chosen ASCII string at a group boundary.
 *
 * The first nine bytes are the PNG signature plus one pad byte, so the nine
 * bytes after them encode from a fresh four-character group: `ABCDEFGHI` becomes
 * exactly `QUJDREVGR0hJ`. That string is registered as a secret in the ordering
 * test, which turns the fixture into evidence: if the materialization hook ran
 * before redaction, the base64 of the injected part would carry the dummy token
 * instead of the bytes on disk.
 */
const SECRET = "QUJDREVGR0hJ";
const SECRET_BYTES = "ABCDEFGHI";

function pngBytes(width = 2, height = 1): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

function pngCarryingTheSecret(): Buffer {
  // The lead is a multiple of three bytes, so `ABCDEFGHI` starts a fresh base64
  // group and encodes as exactly the secret.
  const lead = Buffer.concat([pngBytes(), Buffer.alloc(3)]);
  return Buffer.concat([lead, Buffer.from(SECRET_BYTES, "latin1"), Buffer.alloc(4, 0x20)]);
}

interface Roots {
  readonly attachments: string;
  readonly share: string;
}

let harness: TestHarness | undefined;
let roots: Roots | undefined;
let server: StartedServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await harness?.close();
  harness = undefined;
  if (roots !== undefined) await rm(roots.attachments, { recursive: true, force: true }).catch(() => undefined);
  if (roots !== undefined) await rm(roots.share, { recursive: true, force: true }).catch(() => undefined);
  roots = undefined;
});

/**
 * The agent config with this extension and the redaction hook enabled.
 *
 * The root is pointed at the faux alias here rather than left to the test
 * helper: a config object that names the alias itself skips the helper's
 * default, and a root with no model fails every turn with `no_model`.
 */
function agentConfig(): Config["agent"] {
  const base = defaultConfig();
  return {
    ...base.agent,
    vmodel: "faux",
    extensions: { enabled: [...base.agent.extensions.enabled, "attachment-context", "attachments"] },
  };
}

/** A harness with this extension and the redaction hook installed, and temp roots. */
async function boot(): Promise<{ h: TestHarness; roots: Roots }> {
  const base = defaultConfig();
  const h = await createTestHarness({
    config: {
      agent: agentConfig(),
      // An ephemeral port: two test files that bind the configured one collide.
      server: { ...base.server, port: 0 },
    },
  });
  harness = h;
  const dir = await mkdtemp(join(tmpdir(), "pi-sec-attach-context-"));
  const built: Roots = { attachments: join(dir, "attachments"), share: join(dir, "share") };
  roots = built;
  return { h, roots: built };
}

/** The store's context, pointed at the temporary roots. */
function storeContext(h: TestHarness, into: Roots, jobs?: AttachmentContext["jobs"]): AttachmentContext {
  return {
    storage: h.runtime.storage,
    harness: h.runtime.harness,
    audit: h.runtime.audit,
    roots: into,
    ...(jobs === undefined ? {} : { jobs }),
  };
}

/** The tool extension over a context that carries the temporary roots. */
function attachmentsExtension(h: TestHarness, into: Roots, jobs?: AttachmentContext["jobs"]) {
  const context = {
    storage: h.runtime.storage,
    harness: h.runtime.harness,
    audit: h.runtime.audit,
    paths: h.paths,
    roots: into,
    // `attachments_list` writes a time in the harness zone, and the zone is config.
    getConfig: () => h.runtime.getConfig(),
    ...(jobs === undefined ? {} : { jobs }),
  } as unknown as ExtensionContext;
  return createAttachmentsExtension(context);
}

type ToolLike = {
  name: string;
  execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<unknown>;
};

function toolsOf(h: TestHarness, into: Roots, jobs?: AttachmentContext["jobs"]): Map<string, ToolLike> {
  const extension = attachmentsExtension(h, into, jobs);
  return new Map((extension.tools ?? []).map((tool) => [tool.name, tool as unknown as ToolLike]));
}

const api = { conversationId: 41 } as unknown as ToolExecutionApi;

function textOf(result: unknown): string {
  const content = (result as { output: readonly { type: string; text?: string }[] }).output;
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function imagePartOf(result: unknown): ImageContent | undefined {
  const content = (result as { output: readonly { type: string }[] }).output;
  return content.find((part) => part.type === "image") as ImageContent | undefined;
}

// ---------------------------------------------------------------------------
// The hook, called the way the generation task calls it
// ---------------------------------------------------------------------------

type BeforeRequest = (
  request: { messages: readonly Message[] },
  api: HookApi,
  context: Context,
) => Promise<{ messages: readonly Message[] } | undefined>;

/** Every `beforeRequest` handler for generation, in installed order. */
function beforeRequestHandlers(h: TestHarness): { name: string; handler: BeforeRequest }[] {
  const out: { name: string; handler: BeforeRequest }[] = [];
  for (const extension of h.runtime.registry.snapshot().installed()) {
    for (const registration of extension.hooks ?? []) {
      if (registration.task !== "pi.generation") continue;
      const handlers = registration.handlers as { beforeRequest?: BeforeRequest } | undefined;
      const handler = handlers?.beforeRequest;
      if (typeof handler === "function") out.push({ name: extension.name, handler });
    }
  }
  return out;
}

function materializer(h: TestHarness): BeforeRequest {
  const found = beforeRequestHandlers(h).find((each) => each.name === "attachment-context");
  expect(found, "the attachment-context hook is not installed").toBeDefined();
  return found!.handler;
}

/**
 * The runtime api a hook gets: the run's conversation and committed reads.
 *
 * `conversationId` is part of the real api, and a hook reads it: the subagents
 * hook asks whether this run belongs to a finished subagent, and a missing id
 * makes that document read throw. These turns run in the root conversation, which
 * is the harness's default conversation and never a finished subagent.
 */
function hookApiOf(h: TestHarness): HookApi {
  const reader = h.runtime.harness as unknown as {
    snapshot: (token: unknown, key: string, context: Context) => Promise<unknown>;
  };
  return {
    conversationId: ROOT_CONVERSATION_ID,
    snapshot: (token: unknown, ...rest: unknown[]) =>
      reader.snapshot(token, ...(rest as [string, Context])),
  } as unknown as HookApi;
}

async function runHandlers(
  handlers: { name: string; handler: BeforeRequest }[],
  h: TestHarness,
  messages: readonly Message[],
): Promise<readonly Message[]> {
  let current = messages;
  for (const each of handlers) {
    const replaced = await each.handler({ messages: current }, hookApiOf(h), ctx);
    if (replaced !== undefined) current = replaced.messages;
  }
  return current;
}

function textPartsOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function imagePartsOf(message: Message): ImageContent[] {
  if (typeof message.content === "string") return [];
  return message.content.filter((part): part is ImageContent => part.type === "image");
}

/** Store one file under the temporary attachment root and return its record. */
async function storeImage(h: TestHarness, into: Roots, data: Buffer, mime = "image/png"): Promise<AttachmentRecord> {
  return await createAttachment(storeContext(h, into), { kind: "attachment", name: "shot.png", mime, data });
}

/** Write a source file into the harness's workspace tree and return its path. */
async function workspaceFile(h: TestHarness, name: string, data: Buffer): Promise<string> {
  await mkdir(h.paths.workspaceTree, { recursive: true });
  const path = join(h.paths.workspaceTree, name);
  await writeFile(path, data);
  return path;
}

/** The text of one stored entry, whichever shape its content takes. */
function entryText(entry: { readonly model?: readonly unknown[] }): string {
  return (entry.model ?? [])
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: string }).text ?? "")
            : "",
        )
        .join("");
    })
    .join("\n");
}

const userMessage = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

// ---------------------------------------------------------------------------
// Ordering: redaction first, materialization second
// ---------------------------------------------------------------------------

describe("attachment materialization order", () => {
  it("installs the materialization hook after the redaction hook", async () => {
    const { h } = await boot();
    const installed = h.runtime.registry.snapshot().installed().map((extension) => extension.name);
    expect(installed).toContain("secrets");
    expect(installed).toContain("attachment-context");
    expect(installed.indexOf("secrets")).toBeLessThan(installed.indexOf("attachment-context"));

    // Both hooks are on the same task, so the generation task runs them as one
    // list in this order: `pi-durable/dist/harness/generation.js` maps over
    // `hooks.each("beforeRequest")`, and the handlers are the installed order.
    const names = beforeRequestHandlers(h).map((each) => each.name);
    expect(names.indexOf("secrets")).toBeLessThan(names.indexOf("attachment-context"));
  });

  it("materializes after redaction, so the injected bytes are the bytes on disk", async () => {
    const { h, roots } = await boot();
    // A registered secret whose value sits inside the file's base64.
    await writeFile(join(h.paths.secretsDir, "probe"), SECRET, { mode: 0o600 });
    await h.runtime.secrets.reload();

    const data = pngCarryingTheSecret();
    expect(data.toString("base64")).toContain(SECRET);
    const record = await storeImage(h, roots, data);

    const text = wrapMessage("operator", `the key is ${SECRET}`, { attachments: record.id });
    const messages = await runHandlers(beforeRequestHandlers(h), h, [userMessage(text)]);

    const message = messages[0]!;
    // The redaction hook ran.
    expect(textPartsOf(message)).toContain("\u27e6secret:probe\u27e7");
    expect(textPartsOf(message)).not.toContain(SECRET);
    // The materialization hook ran after it: the part is the file, byte for byte.
    const image = imagePartsOf(message)[0];
    expect(image).toBeDefined();
    expect(image!.data).toBe(data.toString("base64"));
    expect(image!.data).toContain(SECRET);
    expect(image!.mimeType).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

describe("materialization", () => {
  it("turns an envelope attribute into an image part and leaves the entry text alone", async () => {
    const { h, roots } = await boot();
    const data = pngBytes();
    const record = await storeImage(h, roots, data);
    const text = wrapMessage("operator", "what is in this shot?", { attachments: record.id });

    const replaced = await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx);

    expect(replaced).toBeDefined();
    const message = replaced!.messages[0]!;
    // The text is untouched: the transcript still carries only the reference.
    expect(textPartsOf(message)).toBe(text);
    expect(message.content).not.toBe(text);
    const image = imagePartsOf(message);
    expect(image).toHaveLength(1);
    expect(image[0]!.data).toBe(data.toString("base64"));
    expect(image[0]!.mimeType).toBe("image/png");
    // Nothing but `text` and `image` parts: a custom type would be dropped by the
    // provider conversion without a word.
    expect(
      (message.content as readonly { type: string }[]).every((part) => part.type === "text" || part.type === "image"),
    ).toBe(true);
  });

  it("delivers the same base64 for the same turn twice", async () => {
    const { h, roots } = await boot();
    const data = pngBytes();
    const record = await storeImage(h, roots, data);
    const text = wrapMessage("operator", "twice", { attachments: record.id });

    const first = await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx);
    const second = await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx);

    const once = imagePartsOf(first!.messages[0]!)[0]!;
    const again = imagePartsOf(second!.messages[0]!)[0]!;
    expect(again.data).toBe(once.data);
    expect(createHash("sha256").update(once.data).digest("hex")).toBe(createHash("sha256").update(again.data).digest("hex"));
  });

  it("materializes a markdown image URL for an attachment and for a share file", async () => {
    const { h, roots } = await boot();
    const data = pngBytes();
    const attachment = await storeImage(h, roots, data);
    const share = await createAttachment(storeContext(h, roots), {
      kind: "share",
      name: "chart.png",
      mime: "image/png",
      data: pngBytes(3, 2),
    });

    const text = `two pictures\n![shot](/api/attachments/${attachment.id})\n![chart](/api/share/${share.name})`;
    const replaced = await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx);
    const images = imagePartsOf(replaced!.messages[0]!);
    expect(images).toHaveLength(2);
    expect(images[0]!.data).toBe(data.toString("base64"));
    expect(images[1]!.data).toBe(pngBytes(3, 2).toString("base64"));
  });

  it("skips a missing id, a swept file, and a file that is not an image", async () => {
    const { h, roots } = await boot();
    const swept = await storeImage(h, roots, pngBytes());
    const notAnImage = await storeImage(h, roots, Buffer.from("plain words"), "text/plain");
    await unlink(swept.storagePath);

    const text = [
      wrapMessage("operator", "three references", {
        attachments: `${"01ARZ3NDEK0000000000005FAV"},${notAnImage.id},${swept.id}`,
      }),
      `![gone](/api/attachments/${swept.id})`,
      "![outside](/api/attachments/../../etc/passwd)",
      "![elsewhere](https://example.com/x.png)",
    ].join("\n");

    const replaced = await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx);
    // Nothing materialized, so the hook reports no change at all: a request
    // without a usable reference is the request it would have been.
    expect(replaced).toBeUndefined();
  });

  it("leaves a text snippet on disk and injects no part for it", async () => {
    const { h, roots } = await boot();
    const body = Buffer.from("a long note the agent has to choose to read\n", "utf8");
    const snippet = await createAttachment(storeContext(h, roots), {
      kind: "attachment",
      name: "snippet",
      mime: "text/plain; charset=utf-8",
      data: body,
    });

    // The file is an ordinary file at a name the agent can predict, and that is
    // the whole reading path: no automatic injection is built for text.
    expect(snippet.storagePath).toBe(join(roots.attachments, snippet.id, "snippet.txt"));
    expect(await readFile(snippet.storagePath)).toEqual(body);

    const text = wrapMessage("operator", "see the note", { attachments: snippet.id });
    expect(await materializer(h)({ messages: [userMessage(text)] }, hookApiOf(h), ctx)).toBeUndefined();

    // An image beside it still materializes, so the text branch changed nothing
    // about the image one.
    const image = await storeImage(h, roots, pngBytes(2, 1));
    const both = wrapMessage("operator", "note and shot", { attachments: `${snippet.id},${image.id}` });
    const replaced = await materializer(h)({ messages: [userMessage(both)] }, hookApiOf(h), ctx);
    expect(textPartsOf(replaced!.messages[0]!)).toBe(both);
    const parts = imagePartsOf(replaced!.messages[0]!);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.mimeType).toBe("image/png");
  });

  it("leaves messages with no reference exactly as they are", async () => {
    const { h } = await boot();
    const plain = userMessage(wrapMessage("operator", "just words"));
    const replaced = await materializer(h)({ messages: [plain] }, hookApiOf(h), ctx);
    expect(replaced).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

describe("attachment tools", () => {
  it("share_image writes under the share root and returns the markdown tag", async () => {
    const { h, roots } = await boot();
    const source = await workspaceFile(h, "shot.png", pngBytes(4, 3));

    const payload = jsonOf(await toolsOf(h, roots).get("share_image")!.execute({ source } as never, api, ctx));

    expect(payload["mime"]).toBe("image/png");
    expect(payload["bytes"]).toBe(pngBytes(4, 3).byteLength);
    expect(payload["w"]).toBe(4);
    expect(payload["h"]).toBe(3);
    expect(payload["url"]).toBe(`/api/share/${String(payload["name"] ?? "shot.png")}`);
    expect(payload["markdown"]).toBe(`![](${String(payload["url"])})`);
    const written = await readFile(join(roots.share, "shot.png"));
    expect(written.equals(pngBytes(4, 3))).toBe(true);
    // 0600 on the file, and nothing written outside the temporary share root.
    expect((await stat(join(roots.share, "shot.png"))).mode & 0o777).toBe(0o600);
  });

  it("share_image keeps the alt text in the markdown tag", async () => {
    const { h, roots } = await boot();
    const source = await workspaceFile(h, "with-alt.png", pngBytes());
    const payload = jsonOf(
      await toolsOf(h, roots).get("share_image")!.execute({ source, alt: "build log" } as never, api, ctx),
    );
    expect(payload["markdown"]).toBe(`![build log](${String(payload["url"])})`);
  });

  it("share_image refuses a job that is not live", async () => {
    const { h, roots } = await boot();
    const source = await workspaceFile(h, "orphan.png", pngBytes());
    const jobs = { get: async () => undefined };
    const result = await toolsOf(h, roots, jobs).get("share_image")!.execute({ source, jobId: "nope" } as never, api, ctx);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("Job not found: nope");
  });

  it("attachment_open returns the image part, and names an id it does not know", async () => {
    const { h, roots } = await boot();
    const data = pngBytes(5, 5);
    const record = await storeImage(h, roots, data);
    const tools = toolsOf(h, roots);

    const opened = await tools.get("attachment_open")!.execute({ id: record.id } as never, api, ctx);
    expect(textOf(opened)).toContain(`/api/attachments/${record.id}`);
    const image = imagePartOf(opened);
    expect(image).toBeDefined();
    expect(image!.data).toBe(data.toString("base64"));
    expect(image!.mimeType).toBe("image/png");

    const missing = await tools.get("attachment_open")!.execute({ id: "01ARZ3NDEK0000000000005FAV" } as never, api, ctx);
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain("No attachment with id");
    expect(imagePartOf(missing)).toBeUndefined();
  });

  it("attachment_open describes a file that is not an image instead of sending it", async () => {
    const { h, roots } = await boot();
    const record = await storeImage(h, roots, Buffer.from("plain words"), "text/plain");
    const result = await toolsOf(h, roots).get("attachment_open")!.execute({ id: record.id } as never, api, ctx);
    expect(imagePartOf(result)).toBeUndefined();
    expect(textOf(result)).toContain("not an image");
  });

  it("attachments_list narrows by conversation and by job", async () => {
    const { h, roots } = await boot();
    await createAttachment(storeContext(h, roots), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(),
      conversationId: "7",
    });
    await createAttachment(storeContext(h, roots), {
      kind: "share",
      name: "b.png",
      mime: "image/png",
      data: pngBytes(),
      jobId: "job-one",
    });
    const tool = toolsOf(h, roots).get("attachments_list")!;

    const all = jsonOf(await tool.execute({} as never, api, ctx))["attachments"] as Record<string, unknown>[];
    expect(all).toHaveLength(2);
    expect(all[0]!["url"]).toMatch(/^\/api\//);
    // The storage path is never handed to a model.
    expect(JSON.stringify(all)).not.toContain(roots.attachments);

    const byJob = jsonOf(await tool.execute({ jobId: "job-one" } as never, api, ctx))["attachments"] as unknown[];
    expect(byJob).toHaveLength(1);
    const byConversation = jsonOf(await tool.execute({ conversationId: "7" } as never, api, ctx))[
      "attachments"
    ] as unknown[];
    expect(byConversation).toHaveLength(1);
  });

  it("attachments_assign says why each id was refused", async () => {
    const { h, roots } = await boot();
    const live = new Set(["job-one", "job-two"]);
    const jobs = { get: async (_context: Context, id: string) => (live.has(id) ? { id: id as never } : undefined) };
    const tool = toolsOf(h, roots, jobs).get("attachments_assign")!;
    const mine = await createAttachment(storeContext(h, roots), {
      kind: "attachment",
      name: "mine.png",
      mime: "image/png",
      data: pngBytes(),
    });

    const empty = jsonOf(await tool.execute({ ids: [], jobId: "job-one" } as never, api, ctx));
    expect(empty).toEqual({ assigned: [], refused: [{ id: "", reason: "empty" }] });

    const first = jsonOf(await tool.execute({ ids: [mine.id], jobId: "job-one" } as never, api, ctx));
    expect(first).toEqual({ assigned: [mine.id], refused: [] });

    const result = jsonOf(
      await tool.execute(
        {
          ids: ["not-a-ulid", "01ARZ3NDEK0000000000005FAV", mine.id],
          jobId: "job-two",
        } as never,
        api,
        ctx,
      ),
    );
    expect(result["assigned"]).toEqual([]);
    expect(result["refused"]).toEqual([
      { id: "not-a-ulid", reason: "bad-id" },
      { id: "01ARZ3NDEK0000000000005FAV", reason: "missing" },
      { id: mine.id, reason: "owned-by-other" },
    ]);

    const noJob = jsonOf(await tool.execute({ ids: [mine.id], jobId: "job-gone" } as never, api, ctx));
    expect(noJob["refused"]).toEqual([{ id: mine.id, reason: "job-missing" }]);
    const noJobUnknown = jsonOf(
      await tool.execute({ ids: [mine.id, "01ARZ3NDEK0000000000005FAV"], jobId: "job-gone" } as never, api, ctx),
    );
    expect(noJobUnknown["refused"]).toEqual([
      { id: mine.id, reason: "job-missing" },
      { id: "01ARZ3NDEK0000000000005FAV", reason: "job-missing" },
    ]);
  });

  it("keeps attachments_assign out of the tools a subagent and a scheduled run are offered", async () => {
    const h = await createTestHarness({ config: { agent: agentConfig() } });
    harness = h;
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    const root = new Set((await conversation.agent(ctx)).tools.map((tool) => tool.name));

    expect(root.has("attachments_assign")).toBe(true);
    expect(root.has("share_image")).toBe(true);
    expect(root.has("attachment_open")).toBe(true);
    expect(SUBAGENT_TOOL_REMOVALS).toContain("attachments_assign");
    expect(SCHEDULED_TOOL_REMOVALS).toContain("attachments_assign");
    // The other three stay: a subagent may publish an image and read one back.
    expect(SUBAGENT_TOOL_REMOVALS).not.toContain("share_image");
    expect(SUBAGENT_TOOL_REMOVALS).not.toContain("attachment_open");
    expect(SUBAGENT_TOOL_REMOVALS).not.toContain("attachments_list");
  });
});

// ---------------------------------------------------------------------------
// The request a turn actually sends
// ---------------------------------------------------------------------------

describe("a live turn", () => {
  it("carries an image part in the request and only text in the entry", async () => {
    const { h, roots } = await boot();
    const data = pngBytes(6, 4);
    const record = await storeImage(h, roots, data);
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);

    let seen: readonly Message[] = [];
    h.faux.setResponses([
      (request) => {
        seen = request.messages;
        return fauxAssistantMessage([fauxText("I see it")]);
      },
    ]);
    const submission = await submitEnveloped(conversation, ctx, {
      type: "input",
      src: "operator",
      content: "what is in this shot?",
      attrs: { attachments: record.id },
    }, h.config.timezone);
    expect((await submission.wait(ctx)).status).toBe("done");

    const sent = seen.filter((message) => message.role === "user").at(-1)!;
    const images = imagePartsOf(sent);
    expect(images).toHaveLength(1);
    expect(images[0]!.data).toBe(data.toString("base64"));
    expect(images[0]!.mimeType).toBe("image/png");

    // The transcript holds the reference, not the bytes.
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
    const entries = JSON.stringify(page.items);
    expect(entries).not.toContain(data.toString("base64").slice(0, 64));
    expect(entries).toContain(`attachments=\\"${record.id}\\"`);
  });
});

// ---------------------------------------------------------------------------
// The submission path
// ---------------------------------------------------------------------------

/** Start the HTTP server over the current harness, the way the daemon does. */
async function bootServer(h: TestHarness): Promise<string> {
  server = await startTestServer(h);
  return server.origin;
}

/** The text of the newest operator entry in the default conversation. */
async function operatorText(h: TestHarness): Promise<string> {
  const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
  return page.items.filter((entry) => entry.kind === "pi.user").map(entryText).at(-1) ?? "";
}

describe("the submission path", () => {
  it("reads attachment ids, drops repeats, and stays silent when there are none", () => {
    expect(attachmentAttrs(undefined)).toBeUndefined();
    expect(attachmentAttrs([])).toBeUndefined();
    expect(attachmentAttrs("id")).toBeUndefined();
    expect(attachmentAttrs([""])).toBeUndefined();
    expect(attachmentAttrs([1, 2])).toBeUndefined();
    expect(attachmentAttrs([" a ", "a", "b"])).toEqual({ attachments: "a,b" });
  });

  it("sends a body without attachmentIds down the old path, and one with them as an attribute", async () => {
    // Two runs, each with its own conversation: a second POST to the same
    // conversation while the first turn runs would be rejected as busy.
    const first = await boot();
    const plainOrigin = await bootServer(first.h);
    const plain = await fetch(`${plainOrigin}/basic-chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(plain.status).toBe(202);
    expect(await operatorText(first.h)).toMatch(
      /^<pi-message src="operator" at="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00">\nhello\n<\/pi-message>$/,
    );
    await server?.close();
    server = undefined;
    await first.h.close();

    const second = await boot();
    const record = await storeImage(second.h, second.roots, pngBytes());
    const withIdsOrigin = await bootServer(second.h);
    const withIds = await fetch(`${withIdsOrigin}/basic-chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", attachmentIds: [record.id, record.id, ""] }),
    });
    expect(withIds.status).toBe(202);
    expect(await operatorText(second.h)).toMatch(
      new RegExp(
        `^<pi-message src="operator" at="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\+00:00" attachments="${record.id}">\\nhello\\n</pi-message>$`,
      ),
    );
  });

  it("labels a submission without ids exactly as it was labelled before", async () => {
    const { h } = await boot();
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    h.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);

    const submission = await submitEnveloped(conversation, ctx, { type: "input", src: "operator", content: "hello" }, h.config.timezone);
    expect((await submission.wait(ctx)).status).toBe("done");

    const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
    const text = page.items.filter((entry) => entry.kind === "pi.user").map(entryText).join("\n");
    expect(text).toMatch(
      /<pi-message src="operator" at="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00">\nhello\n<\/pi-message>/,
    );
    expect(text).not.toContain("attachments=");
  });
});
