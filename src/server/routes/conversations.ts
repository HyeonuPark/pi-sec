import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentChange, ConversationId, EntryId, ModelRef } from "@earendil-works/pi-durable";
import { apiError, intParam, json, type RouteContext, type Router } from "../router.ts";
import { API_VERSION, type AppDeps } from "../deps.ts";
import {
  attachmentAttrs,
  attachmentDescriptors,
  attachmentLookup,
  contextUsagePayload,
  historyPayload,
  streamConversation,
} from "./basic-chat.ts";
import { readBeforeParam } from "./history.ts";
import { lookupFocusedChat } from "../../focused/service.ts";
import { attachmentContext } from "./attachments.ts";
import { agentsWorkingRefusal, workingSubagents } from "../streams.ts";
import { restartHandoff, submitEnveloped } from "../../submit-envelope.ts";
import { isHeldOperatorInput } from "../../agent/hold-gate.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function conversationId(raw: string | undefined): ConversationId | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? (value as ConversationId) : undefined;
}

function parseAgentChange(body: Record<string, unknown>): AgentChange {
  const change: {
    model?: ModelRef | null;
    thinkingLevel?: AgentChange["thinkingLevel"];
    instructions?: string | null;
    cwd?: string | null;
  } = {};
  const model = body["model"];
  if (model === null) change.model = null;
  else if (typeof model === "object" && model !== null) {
    const ref = model as { provider?: unknown; modelId?: unknown };
    if (typeof ref.provider === "string" && typeof ref.modelId === "string") {
      change.model = { provider: ref.provider, modelId: ref.modelId };
    }
  }
  const thinking = body["thinkingLevel"];
  if (thinking === null) change.thinkingLevel = null;
  if (thinking === "off" || thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high") {
    change.thinkingLevel = thinking;
  }
  if (typeof body["instructions"] === "string" || body["instructions"] === null) {
    change.instructions = body["instructions"] as string | null;
  }
  if (typeof body["cwd"] === "string" || body["cwd"] === null) {
    change.cwd = body["cwd"] as string | null;
  }
  return change;
}

/**
 * Answer the refusal an archived or deleted focused chat earns.
 *
 * A focused chat stops taking writes when the root archives it, and a deleted one
 * stops answering at all. Both rules live here rather than in each route, because
 * the four write routes must agree: a chat that refuses a message but accepts a
 * reset is a chat the user cannot trust to be finished.
 */
function focusedWriteRefusal(route: RouteContext, deps: AppDeps, id: number): boolean {
  const found = lookupFocusedChat(deps.runtime.focusedChats, id);
  if (found.state === "archived") {
    apiError(route.res, 409, "chat_archived", "this focused chat is archived, so it takes no writes", route.requestId);
    return true;
  }
  if (found.state === "deleted") {
    apiError(route.res, 404, "chat_deleted", "this focused chat was deleted", route.requestId);
    return true;
  }
  return false;
}

export function registerConversations(router: Router, deps: AppDeps): void {
  router.get("/api/conversations", async (route) => {
    const limit = intParam(route.url, "limit", 50);
    const page = await deps.runtime.storage.scanConversations({}, limit, undefined, BACKGROUND_CONTEXT);
    json(route.res, 200, { conversations: page.items, cursor: page.next ?? null });
  });

  router.post("/api/conversations", async (route) => {
    const conversation = await deps.runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    json(route.res, 201, { id: conversation.id });
  });

  router.get("/api/conversations/:id/events", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    await streamConversation(deps, route, id as unknown as number);
  });

  router.get("/api/conversations/:id", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    const conversation = await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    const limit = intParam(route.url, "limit", 100);
    const page = await conversation.entries({}, limit, undefined, BACKGROUND_CONTEXT);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    json(route.res, 200, {
      id: conversation.id,
      agent,
      entries: page.items,
      entriesCursor: page.next ?? null,
      hasMore: page.next !== undefined,
      // What the page needs to draw a message's attachments on the first
      // render, without a request per file. Additive: a client that does not
      // read this field draws the transcript it drew before.
      attachments: await attachmentDescriptors(page.items, attachmentLookup(attachmentContext(deps))),
      apiVersion: API_VERSION,
    });
  });

  /**
   * One earlier session of one conversation, for the transcript's button.
   *
   * The same answer `/basic-chat/history` gives for the root conversation, for a
   * focused chat: one payload builder serves both, so a page that shows either
   * draws the same thing. Read-only, and answered for an archived chat as well,
   * because reading the record of a finished chat is what the page may do.
   */
  router.get("/api/conversations/:id/history", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    const before = readBeforeParam(route.url);
    if (before === undefined) {
      apiError(route.res, 400, "invalid_request", "before must be a positive entry id", route.requestId);
      return;
    }
    const conversation = await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    json(route.res, 200, await historyPayload(deps, conversation, before));
  });

  /**
   * How full one conversation's context is, with the answer the root's own route
   * gives: the page shows one bar, and it does not care which conversation it is
   * looking at. Read-only, and answered for an archived chat as well, because
   * reading the record of a finished chat is what the page is allowed to do.
   */
  router.get("/api/conversations/:id/context", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id === undefined) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id", route.requestId);
      return;
    }
    const found = lookupFocusedChat(deps.runtime.focusedChats, id);
    if (found.state === "deleted") {
      apiError(route.res, 404, "chat_deleted", "this focused chat was deleted", route.requestId);
      return;
    }
    const conversation = await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    json(route.res, 200, await contextUsagePayload(deps, conversation));
  });

  router.post("/api/conversations/:id/messages", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    if (id === undefined || body === undefined || typeof body["content"] !== "string") {
      apiError(route.res, 400, "invalid_request", "invalid conversation id or content", route.requestId);
      return;
    }
    if (focusedWriteRefusal(route, deps, id)) return;
    const conversation = await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    const whenBusy = { "follow-up": "followUp", steer: "steer", reject: "reject" }[String(body["whenBusy"])] as
      | "followUp"
      | "steer"
      | "reject"
      | undefined;
    // The composer uploads each file first and sends the ids with the text, and
    // this route takes them exactly as `/basic-chat/messages` does: one function
    // builds the envelope attribute for both, so a message cannot carry files on
    // one page and lose them on the other.
    const attrs = attachmentAttrs(body["attachmentIds"]);
    try {
      // A conversation waiting for its provider records the text instead of sending
      // it, and the page says so. The gate's answer is read just before the submit,
      // because that answer is what the submit itself acts on and the watch changes
      // it at most once a pass.
      const held = isHeldOperatorInput(String(conversation.id), "operator");
      const submission = await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
        type: "input",
        src: "operator",
        content: body["content"],
        ...(attrs === undefined ? {} : { attrs }),
        whenBusy,
        requestId: typeof body["requestId"] === "string" ? body["requestId"] : undefined,
      }, deps.runtime.getConfig().timezone);
      json(route.res, 202, {
        status: "accepted",
        submissionId: submission.id,
        conversationId: conversation.id,
        ...(held ? { held: true } : {}),
      });
    } catch (error) {
      apiError(route.res, 409, "conversation_busy", String(error), route.requestId);
    }
  });

  router.post("/api/conversations/:id/abort", async (route) => {
    const id = conversationId(route.params["id"]);
    if (id !== undefined && focusedWriteRefusal(route, deps, id)) return;
    const conversation = id === undefined ? undefined : await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    await conversation.abort(BACKGROUND_CONTEXT);
    json(route.res, 202, { status: "aborted" });
  });

  router.post("/api/conversations/:id/reset", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    if (id !== undefined && focusedWriteRefusal(route, deps, id)) return;
    const conversation = id === undefined ? undefined : await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    // The handoff string is this route's own text, and it lands as user input.
    const handoff = typeof body?.["handoff"] === "string" ? restartHandoff(body["handoff"], deps.runtime.getConfig().timezone) : undefined;
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
    json(route.res, 202, { status: "accepted" });
  });

  router.post("/api/conversations/:id/compact", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    if (id !== undefined && focusedWriteRefusal(route, deps, id)) return;
    const conversation = id === undefined ? undefined : await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    const taskId = await conversation.compact(typeof body?.["instructions"] === "string" ? body["instructions"] : undefined, BACKGROUND_CONTEXT);
    json(route.res, 202, { status: "accepted", taskId });
  });

  router.patch("/api/conversations/:id/agent", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    const conversation = id === undefined ? undefined : await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined || body === undefined) {
      apiError(route.res, 404, "not_found", "conversation not found", route.requestId);
      return;
    }
    await conversation.configure(parseAgentChange(body), BACKGROUND_CONTEXT);
    json(route.res, 200, { agent: await conversation.agent(BACKGROUND_CONTEXT) });
  });

  router.post("/api/conversations/:id/forks", async (route) => {
    const id = conversationId(route.params["id"]);
    const body = bodyObject(route.body);
    const at = Number(body?.["atEntryId"]);
    const conversation = id === undefined ? undefined : await deps.runtime.harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined || !Number.isFinite(at)) {
      apiError(route.res, 400, "invalid_request", "invalid conversation id or atEntryId", route.requestId);
      return;
    }
    const forked = await conversation.fork(at as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    json(route.res, 201, { conversationId: forked.id, forkedAtEntryId: at });
  });

  router.get("/api/conversations/:id/tasks", async (route: RouteContext) => {
    const graph = await deps.runtime.harness.watchTaskGraph(BACKGROUND_CONTEXT);
    const value = graph.value;
    await graph.stop();
    json(route.res, 200, value);
  });
}
