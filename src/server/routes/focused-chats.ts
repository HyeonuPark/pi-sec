import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../../agent/harness.ts";
import { SecAgent } from "../../documents.ts";
import {
  focusedChatView,
  FocusedChatError,
  focusedStatusOf,
  lookupFocusedChat,
  openFocusedChat,
  setFocusedChatTitle,
  type FocusedChatView,
  type FocusedDeps,
} from "../../focused/service.ts";
import { BadCursorError } from "../../focused/store.ts";
import { sendBody } from "../compress.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { type AppDeps } from "../deps.ts";
import { resolveMount } from "../proxy.ts";
import { readPage, renderPage } from "../static.ts";

/**
 * The focused chats: the page's four routes, the list page's event stream, and
 * the page itself.
 *
 * A focused chat is a conversation the user opens from the web page to talk about
 * one topic at length. It is a child of the root, so it counts against the same
 * slot limit as a subagent, and the root reaches it by name like any other child.
 *
 * Deliberately missing: a route that archives a chat or deletes one. Both are the
 * root's tools, because both end a conversation the user is reading, and the
 * page offers no button for either. Opening a chat is a route, because opening
 * one is the user's own act on the page.
 */

/** What one focused chat action needs, read from the runtime the routes hold. */
function depsOf(deps: AppDeps): FocusedDeps {
  const runtime = deps.runtime;
  return {
    harness: runtime.harness,
    store: runtime.focusedChats,
    paths: runtime.paths,
    getConfig: () => runtime.getConfig(),
    hub: runtime.subagents,
    events: runtime.events,
    audit: runtime.audit,
    reports: runtime.reports,
  };
}

/** A conversation number from a path, or `undefined` when it is not one. */
function conversationId(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** Answer one refusal with the status its code names. */
function refuse(route: RouteContext, error: unknown): void {
  if (error instanceof FocusedChatError) {
    apiError(route.res, focusedStatusOf(error.code), error.code, error.message, route.requestId);
    return;
  }
  if (error instanceof BadCursorError) {
    apiError(route.res, 400, "invalid_request", error.message, route.requestId);
    return;
  }
  throw error;
}

/** One item of a list answer, with whether a run is going on inside it. */
async function listItem(runtime: AgentRuntime, view: FocusedChatView): Promise<FocusedChatView & { running: boolean }> {
  const record = await runtime.harness.snapshot(SecAgent, String(view.conversationId), BACKGROUND_CONTEXT);
  const running = record !== undefined && (record.status === "starting" || record.status === "running");
  return { ...view, running };
}

/**
 * The chats page, served the way the reports page is.
 *
 * `chats.html` is a page of its own under the web assets, so it is read through
 * the same helper and stamped with the same mount prefix: a page reached through
 * a proxy has to ask for its assets under the prefix it is mounted at, and one
 * page deriving that for itself is how the two disagree.
 */
async function servePage(deps: AppDeps, route: RouteContext): Promise<void> {
  const raw = await readPage(deps.webDir, "chats.html");
  if (raw === undefined) {
    apiError(route.res, 500, "ui_missing", "the chats page is not installed", route.requestId);
    return;
  }
  const config = deps.runtime.getConfig();
  const html = renderPage(raw, resolveMount(route.req, config).prefix, config.timezone);
  sendBody(route.res, {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: html,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function registerFocusedChats(router: Router, deps: AppDeps): void {
  const focused = () => depsOf(deps);

  router.post("/api/focused-chats", async (route) => {
    const body = bodyObject(route.body);
    // A body with no title is the page's "New chat" button; anything else that is
    // not an object is a caller mistake, and it is refused rather than read as
    // "no title".
    if (route.body !== undefined && body === undefined) {
      apiError(route.res, 400, "invalid_request", "the body must be an object", route.requestId);
      return;
    }
    try {
      const row = await openFocusedChat(
        focused(),
        { title: body?.["title"], test: body?.["test"] },
        BACKGROUND_CONTEXT,
      );
      json(route.res, 201, {
        conversationId: row.conversationId,
        name: row.name,
        title: row.title,
        openedAt: row.openedAt,
        test: row.test,
      });
    } catch (error) {
      refuse(route, error);
    }
  });

  router.get("/api/focused-chats", async (route) => {
    const state = route.url.searchParams.get("state") ?? "active";
    const store = deps.runtime.focusedChats;
    if (state === "active") {
      const items = await Promise.all(
        store.listActive().map(async (row) => listItem(deps.runtime, focusedChatView(row))),
      );
      json(route.res, 200, { items });
      return;
    }
    if (state !== "archived") {
      apiError(
        route.res,
        400,
        "invalid_request",
        `state must be "active" or "archived", and it was ${JSON.stringify(state)}`,
        route.requestId,
      );
      return;
    }
    const q = route.url.searchParams.get("q") ?? undefined;
    const cursor = route.url.searchParams.get("cursor") ?? undefined;
    try {
      const page = store.listArchived({
        ...(q === undefined ? {} : { q }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const items = await Promise.all(page.items.map(async (row) => listItem(deps.runtime, focusedChatView(row))));
      json(route.res, 200, { items, ...(page.next === undefined ? {} : { next: page.next }) });
    } catch (error) {
      refuse(route, error);
    }
  });

  // The live feed of the list page. It is registered before the `:id` route
  // below, because a path is matched in the order its routes were added: `events`
  // is a valid conversation-shaped segment, so the `:id` route would otherwise
  // swallow it and answer "invalid conversation id" to every page that asks for
  // the stream.
  router.get("/api/focused-chats/events", (route) => {
    deps.streams.attachFocusedChatEvents(route);
  });

  router.get("/api/focused-chats/:id", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    // The root is a conversation like any other, and it is not a focused chat.
    // Answering for it would let a page open the root as if it were one.
    if (id === Number(ROOT_CONVERSATION_ID)) {
      apiError(route.res, 404, "not_found", "this conversation is not a focused chat", route.requestId);
      return;
    }
    const found = lookupFocusedChat(deps.runtime.focusedChats, id);
    if (found.state === "deleted") {
      apiError(route.res, 404, "chat_deleted", "this focused chat was deleted", route.requestId);
      return;
    }
    if (found.state === "none") {
      apiError(route.res, 404, "not_found", "this conversation is not a focused chat", route.requestId);
      return;
    }
    json(route.res, 200, focusedChatView(found.row));
  });

  router.patch("/api/focused-chats/:id", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    if (body === undefined || !("title" in body)) {
      apiError(route.res, 400, "invalid_request", "the body must carry a title", route.requestId);
      return;
    }
    try {
      const row = setFocusedChatTitle(focused(), id, body["title"]);
      json(route.res, 200, focusedChatView(row));
    } catch (error) {
      refuse(route, error);
    }
  });

  // The page. It reads its own address to decide which chat to show, so the route
  // carries no parameter, and its assets are the ones every page shares: a
  // relative asset URL on `/chats` resolves at the server root, so this page needs
  // no asset route of its own.
  router.get("/chats", async (route) => servePage(deps, route));
}
