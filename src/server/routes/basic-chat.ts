import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { findDefaultConversation, resolveDefaultConversation } from "../../agent/conversation.ts";
import { contextUsage } from "../../agent/context-usage.ts";
import { getAttachment, type AttachmentContext, type AttachmentRecord } from "../../attachments/store.ts";
import { attachmentContext } from "./attachments.ts";
import { sendBody } from "../compress.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { type AppDeps, API_VERSION } from "../deps.ts";
import { injectName, readIndex, renderPage, serveStatic } from "../static.ts";
import { contentSecurityPolicy, fillUiSlots, UI_RENDER_TIMEOUT_MS } from "../ui-page.ts";
import { resolveMount } from "../proxy.ts";
import { agentsWorkingRefusal, workingSubagents } from "../streams.ts";
import { personalityPath, readPersonalityFile } from "../../extensions/personality-file.ts";
import {
  BUNDLED_EXTENSIONS,
  collectPageLinks,
  type BundledExtension,
  type ExtensionPageLink,
} from "../../extensions/index.ts";
import { readMessage } from "../../message-envelope.ts";
import { restartHandoff, submitEnveloped } from "../../submit-envelope.ts";
import { isHeldOperatorInput } from "../../agent/hold-gate.ts";
import { cutSessionBlock, readBeforeParam } from "./history.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/**
 * The attachment ids a submission names, or `undefined` when it names none.
 *
 * The browser uploads each file first and sends the ids with the text. They
 * travel as an envelope attribute, which is the only place a stored entry can
 * carry a reference: the entry itself stays text, and the request hook turns the
 * attribute into image parts. A submission without ids takes exactly the path it
 * took before this attribute existed, down to the envelope text.
 */
export function attachmentAttrs(value: unknown): { attachments: string } | undefined {
  if (!Array.isArray(value)) return undefined;
  const named = value.filter((item): item is string => typeof item === "string").join(",");
  const ids = parseAttachmentIds(named);
  return ids.length === 0 ? undefined : { attachments: ids.join(",") };
}

/**
 * The attachment ids one comma-separated value names, in order, without repeats.
 *
 * This is the only place the rule lives. The writing side builds the envelope
 * attribute from the upload array with it, and the reading side takes ids back
 * out of a stored entry with it, so a message that the page renders and a
 * payload that describes it cannot disagree about which ids a message carries.
 */
export function parseAttachmentIds(value: string): string[] {
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id === "" || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * One attachment as an entries payload describes it.
 *
 * The page needs exactly these fields to choose between a picture and a file
 * chip. `sha256` and `storagePath` stay on the server: the first is a transport
 * detail of the store, and the second is a path the page must never learn.
 * `w`/`h` arrive together or not at all, which is the rule the upload response
 * already uses.
 */
export type AttachmentDescriptor = {
  readonly id: string;
  readonly mime: string;
  readonly name: string;
  readonly bytes: number;
  readonly w?: number;
  readonly h?: number;
};

/** The `attachments` map a payload carries: every id it names, by id. */
export type AttachmentDescriptors = Record<string, AttachmentDescriptor>;

/** One store read by id. The caller supplies it, so a route decides where the record comes from. */
export type AttachmentLookup = (id: string) => Promise<AttachmentRecord | undefined>;

/**
 * The lookup the payload builders use: the attachment store, read through the
 * caller's own context.
 *
 * It holds no state, so nothing it learns survives one payload. A later payload
 * asks the store again, because a process-wide cache would need an invalidation
 * rule this store does not have.
 */
export function attachmentLookup(context: AttachmentContext): AttachmentLookup {
  return (id) => getAttachment(context, id);
}

/** The text one message contributes, flattened. Image parts carry none. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/**
 * The attachment ids one entry names.
 *
 * An entry carries text and nothing else, so the reference is the envelope
 * attribute and the envelope's own reader is what finds it: the escaping rules
 * are applied in the one place that owns them.
 */
export function entryAttachmentIds(entry: EntryRecord): string[] {
  const ids: string[] = [];
  for (const message of entry.model ?? []) {
    const attribute = readMessage(messageText((message as { content?: unknown }).content))?.attrs["attachments"];
    if (attribute === undefined) continue;
    for (const id of parseAttachmentIds(attribute)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One record as the payload describes it. */
function descriptorOf(record: AttachmentRecord): AttachmentDescriptor {
  return {
    id: record.id,
    mime: record.mime,
    name: record.name,
    bytes: record.bytes,
    ...(record.w === undefined || record.h === undefined ? {} : { w: record.w, h: record.h }),
  };
}

/**
 * The descriptors for the attachment ids these entries name.
 *
 * Two properties hold for one call. A distinct id is looked up once, so a
 * message that names the same file twice costs one store read, and the memo is
 * the id set itself: nothing is kept between payloads, because a process-wide
 * cache would need an invalidation rule this store does not have. An id whose
 * record is absent is left out and the rest are still described, because a
 * dangling reference must not fail the whole response.
 */
export async function attachmentDescriptors(
  entries: Iterable<EntryRecord>,
  lookup: AttachmentLookup,
): Promise<AttachmentDescriptors> {
  const ids: string[] = [];
  for (const entry of entries) {
    for (const id of entryAttachmentIds(entry)) if (!ids.includes(id)) ids.push(id);
  }
  const described = await Promise.all(
    ids.map(async (id) => {
      try {
        return await lookup(id);
      } catch {
        // A store that cannot answer describes nothing: the entries matter more.
        return undefined;
      }
    }),
  );
  const descriptors: AttachmentDescriptors = {};
  described.forEach((record, at) => {
    if (record === undefined) return;
    descriptors[ids[at]!] = descriptorOf(record);
  });
  return descriptors;
}

/**
 * How full one conversation's context is.
 *
 * One function, because two routes answer the same question: the root's own
 * `/basic-chat/context` and `/api/conversations/:id/context`, which the page uses
 * for every other conversation. The two answers have the same shape, so a page
 * that shows the bar does not care which conversation it is looking at.
 */
export async function contextUsagePayload(
  deps: AppDeps,
  conversation: Conversation,
): Promise<{ used: number | null; max: number | null; window: number | null; reserveTokens: number }> {
  const config = deps.runtime.getConfig();
  const usage = await contextUsage(conversation, deps.runtime.models, config.agent.compaction.reserveTokens, BACKGROUND_CONTEXT);
  return {
    // `null`, not an absent key: a browser that reads `data.used` has to be able
    // to tell "not measured yet" from "this build forgot the field".
    used: usage.used ?? null,
    max: usage.max ?? null,
    window: usage.window ?? null,
    reserveTokens: usage.reserveTokens,
  };
}

/** Stream a conversation's committed events as SSE to one more client. */
export async function streamConversation(deps: AppDeps, route: RouteContext, conversationId: number): Promise<void> {
  await deps.streams.attachConversation(route, conversationId);
}

/**
 * One earlier session, as both history routes answer it.
 *
 * Two routes answer the same question, one for the root conversation and one for
 * a focused chat, so one function builds both answers and they cannot disagree
 * about the shape. It reads and writes nothing: the block comes out of the
 * stored transcript, and the model's context is not touched.
 */
export async function historyPayload(
  deps: AppDeps,
  conversation: Conversation,
  before: EntryId,
): Promise<{
  entries: readonly EntryRecord[];
  attachments: AttachmentDescriptors;
  hasMore: boolean;
  apiVersion: number;
}> {
  const block = await cutSessionBlock(conversation, before);
  return {
    entries: block.entries,
    // Without these the page draws a picture as a file chip: a message carries
    // attachment ids, and only a descriptor says which of them is an image.
    attachments: await attachmentDescriptors(block.entries, attachmentLookup(attachmentContext(deps))),
    hasMore: block.hasMore,
    apiVersion: API_VERSION,
  };
}

/**
 * The name the chat page draws as the title of the root conversation.
 *
 * The personality file is read on every request, so a name registered by
 * `personality_set` reaches the next page load, and a hand edit does too. A
 * missing file, a file with no name, and an unreadable file all answer an empty
 * string: the page must be served either way, and an empty value tells it to
 * show its own default.
 */
async function chatPageName(deps: AppDeps): Promise<string> {
  try {
    const document = await readPersonalityFile(
      personalityPath(deps.runtime.paths, deps.runtime.getConfig().personality.file),
    );
    return document?.name ?? "";
  } catch {
    return "";
  }
}

/** Where `index.html` leaves room for the page links of the enabled extensions. */
const PAGE_LINKS_MARKER = "<!--pages-links-->";

/**
 * Put the enabled extensions' page links into the page as a JSON data block.
 *
 * The block is data, not code: its type is `application/json`, so the browser
 * parses it and never runs it, and the page's `script-src 'self'` policy has
 * nothing to refuse. Every `<` is written as `\u003c`, so no label can close the
 * element early; the rest of the JSON needs no escaping inside a `script`. The
 * menu reads the block and draws one link per entry after its own three, so a
 * page with no block keeps the three links it always had.
 */
export function withPageLinks(html: string, links: readonly ExtensionPageLink[]): string {
  const json = JSON.stringify(links).replaceAll("<", "\\u003c");
  return html.replace(PAGE_LINKS_MARKER, `<script type="application/json" id="pages-links">${json}</script>`);
}

/** The page route's options: how long one card may take to render, and the catalog. */
export interface BasicChatOptions {
  readonly renderTimeoutMs?: number;
  /**
   * The catalog to read the page links from. Defaults to `BUNDLED_EXTENSIONS`.
   *
   * A test passes a catalog of its own, so the link device is proved without
   * the shipped extension that fills it, and the enabled list decides exactly
   * as it decides for route registration.
   */
  readonly catalog?: readonly BundledExtension[];
}

export function registerBasicChat(router: Router, deps: AppDeps, options: BasicChatOptions = {}): void {
  const renderTimeoutMs = options.renderTimeoutMs ?? UI_RENDER_TIMEOUT_MS;
  const catalog = options.catalog ?? BUNDLED_EXTENSIONS;
  // The enabled list is read once, here, which is the same moment the server
  // registers an extension's web routes from it. A link therefore appears
  // exactly while the page behind it answers: a later config read cannot make
  // one of them change without the other, so the menu never offers a page the
  // router does not answer. Turning an extension on or off is a restart, which
  // is why one read is enough. The warning line for a dropped entry is written
  // here too, once per boot.
  const pageLinks = collectPageLinks(catalog, deps.runtime.getConfig().agent.extensions.enabled, deps.runtime.logger);

  router.get("/basic-chat", async ({ req, res }) => {
    const raw = await readIndex(deps.webDir);
    if (raw === undefined) {
      apiError(res, 500, "ui_missing", "web UI is not installed", "");
      return;
    }
    // Tell the page where it is mounted — in the meta tag the scripts read,
    // and in the asset URLs, so they do not depend on the shape of the page
    // URL (a trailing slash used to send them down a different route).
    // The config is read per request, so a reload reaches the next page load.
    const config = deps.runtime.getConfig();
    const prefix = resolveMount(req, config).prefix;
    // Every stamp comes first and the fill runs on the stamped page, never
    // before it: a card's own text must not be read as one of our placeholders,
    // and a placeholder must not land inside a card.
    const named = injectName(raw, await chatPageName(deps));
    const page = await fillUiSlots(renderPage(named, prefix, config.timezone), {
      ui: deps.runtime.ui,
      prefix,
      timezone: config.timezone,
      renderTimeoutMs,
      logger: deps.runtime.logger,
    });
    // After the slots are filled, as the usage page plants its own block: a
    // card's text is never read as one of the shell's placeholders.
    sendBody(res, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: withPageLinks(page.html, pageLinks),
      headers: {
        "Cache-Control": "no-cache",
        // Byte-for-byte the policy this server sent before cards existed, unless a
        // card rendered: then only `style-src` gains the nonce its style carries.
        "Content-Security-Policy": contentSecurityPolicy(page.nonce),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });

  // Read-only. The daemon prepares the root conversation at boot, so this route
  // never creates it: a missing root answers 503 and the page draws its usual
  // connection error until a message creates it or the daemon restarts.
  router.get("/basic-chat/events", async (route) => {
    const conversation = await findDefaultConversation(deps.runtime.harness, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(
        route.res,
        503,
        "root_missing",
        "the root conversation does not exist; send a message or restart the daemon",
        route.requestId,
      );
      return;
    }
    await streamConversation(deps, route, conversation.id as unknown as number);
  });

  /**
   * How full the conversation's context is, for the bar above the composer and
   * the readout in the sidebar.
   *
   * The server answers this rather than the browser, which already holds every
   * entry: the page and the `usage` tool compare the same two numbers, and a
   * second counter in the browser is a second answer to one question. Registered
   * before the asset shim below, which is a wildcard and would otherwise serve
   * this path as a file name.
   *
   * Read-only, like the events stream above: the root conversation is looked up
   * and never created or reconfigured here.
   */
  router.get("/basic-chat/context", async (route) => {
    const conversation = await findDefaultConversation(deps.runtime.harness, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(
        route.res,
        503,
        "root_missing",
        "the root conversation does not exist; send a message or restart the daemon",
        route.requestId,
      );
      return;
    }
    json(route.res, 200, await contextUsagePayload(deps, conversation));
  });

  /**
   * One earlier session of the root conversation, for the transcript's button.
   *
   * Read-only, like the two routes above: the root is looked up and never
   * created, and the session is cut from what is already stored. Registered
   * before the asset shim below, which is a wildcard and would otherwise serve
   * this path as a file name.
   */
  router.get("/basic-chat/history", async (route) => {
    const before = readBeforeParam(route.url);
    if (before === undefined) {
      apiError(route.res, 400, "invalid_request", "before must be a positive entry id", route.requestId);
      return;
    }
    const conversation = await findDefaultConversation(deps.runtime.harness, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(
        route.res,
        503,
        "root_missing",
        "the root conversation does not exist; send a message or restart the daemon",
        route.requestId,
      );
      return;
    }
    json(route.res, 200, await historyPayload(deps, conversation, before));
  });

  // A shim, not the asset route: pages served before the asset URLs were stamped
  // asked for their assets under the page path (`/basic-chat/theme.css`), and a
  // browser or an open tab can still hold one. Nothing the current pages emit
  // needs this, so it can go once no such page can be alive.
  router.get("/basic-chat/*", async (route) => {
    const asset = route.params["*"] ?? "";
    if (!(await serveStatic(route.res, deps.webDir, asset))) {
      apiError(route.res, 404, "not_found", "asset not found", route.requestId);
    }
  });

  router.post("/basic-chat/messages", async (route) => {
    const body = bodyObject(route.body);
    const content = body?.["content"];
    if (typeof content !== "string" || content.trim() === "") {
      apiError(route.res, 400, "invalid_request", "content must be a non-empty string", route.requestId);
      return;
    }
    const conversation = await resolveDefaultConversation(deps.runtime.harness, deps.runtime.getConfig(), deps.runtime.paths, BACKGROUND_CONTEXT);
    const whenBusy = { "follow-up": "followUp", steer: "steer", reject: "reject" }[String(body?.["whenBusy"])] as
      | "followUp"
      | "steer"
      | "reject"
      | undefined;
    const requestId = typeof body?.["requestId"] === "string" ? body["requestId"] : undefined;
    try {
      // Typed in the chat box: the operator's own text, labelled here, once. Any
      // attachment the composer uploaded rides along as an attribute, not as a
      // body change.
      const attrs = attachmentAttrs(body?.["attachmentIds"]);
      // A conversation waiting for its provider records the text instead of sending
      // it, and the page says so. The gate's answer is read just before the submit,
      // because that answer is what the submit itself acts on and the watch changes
      // it at most once a pass.
      const held = isHeldOperatorInput(String(conversation.id), "operator");
      const submission = await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
        type: "input",
        src: "operator",
        content,
        ...(attrs === undefined ? {} : { attrs }),
        whenBusy,
        requestId,
      }, deps.runtime.getConfig().timezone);
      json(route.res, 202, {
        requestId: requestId ?? "",
        status: "accepted",
        submissionId: submission.id,
        conversationId: conversation.id,
        ...(held ? { held: true } : {}),
      });
    } catch (error) {
      apiError(route.res, 409, "conversation_busy", String(error), route.requestId);
    }
  });

  router.post("/basic-chat/abort", async (route) => {
    const conversation = await resolveDefaultConversation(deps.runtime.harness, deps.runtime.getConfig(), deps.runtime.paths, BACKGROUND_CONTEXT);
    await conversation.abort(BACKGROUND_CONTEXT);
    json(route.res, 202, { status: "aborted", conversationId: conversation.id });
  });

  router.post("/basic-chat/reset", async (route) => {
    const body = bodyObject(route.body);
    const handoff = typeof body?.["handoff"] === "string" ? restartHandoff(body["handoff"], deps.runtime.getConfig().timezone) : undefined;
    const conversation = await resolveDefaultConversation(deps.runtime.harness, deps.runtime.getConfig(), deps.runtime.paths, BACKGROUND_CONTEXT);
    // A reset empties the context this conversation's sub-agents report into, so
    // it is refused while one of them is working unless the caller says `force`.
    if (body?.["force"] !== true) {
      const working = await workingSubagents(deps.runtime, String(conversation.id));
      if (working.length > 0) {
        json(route.res, 409, agentsWorkingRefusal(working, route.requestId));
        return;
      }
    }
    await conversation.reset(handoff, BACKGROUND_CONTEXT);
    json(route.res, 202, { status: "accepted", requestId: route.requestId, conversationId: conversation.id });
  });

  router.post("/basic-chat/compact", async (route) => {
    const body = bodyObject(route.body);
    const instructions = typeof body?.["instructions"] === "string" ? body["instructions"] : undefined;
    const conversation = await resolveDefaultConversation(deps.runtime.harness, deps.runtime.getConfig(), deps.runtime.paths, BACKGROUND_CONTEXT);
    const taskId = await conversation.compact(instructions, BACKGROUND_CONTEXT);
    json(route.res, 202, { status: "accepted", requestId: route.requestId, taskId });
  });
}
