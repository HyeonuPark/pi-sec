import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  SecUserQueryList,
  USER_QUERY_RESOLVED_EVENT,
  type UserQueryListItem,
  type UserQueryMode,
  type UserQueryListRecord,
} from "../../documents.ts";
import { submitEnveloped } from "../../submit-envelope.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { API_VERSION, type AppDeps } from "../deps.ts";

/**
 * The active `ask_user` questions, and the one door an answer comes back by.
 *
 * The truth is the `sec.userQueryList` document and nothing else. This module
 * reads it to draw the sidebar list and to find the item an answer names, and it
 * writes the answer into the conversation that asked the question. The waiter map
 * this route used to call is not consulted: a question is answerable while it is
 * in the list, so a restart loses neither the question nor the ability to answer
 * it.
 *
 * The path parameter of an answer is the item's `key` (the content key from
 * `userQueryKey`), not its id. The id stays on the item for display and for the
 * audit log, and it is what the request id of the answer is built from.
 */

/**
 * The body labels of an answer entry, in the fixed order they appear.
 *
 * The client draws the `Question:` and `Answer:` lines of that entry as a card,
 * so it looks for these two strings. The strings are written out on both sides
 * rather than shared: the page has its own copy in
 * `src/ui/chat/transcript/envelope.ts` and the server has this one, and the two
 * closed source lists in `message-envelope.ts` and that module already follow
 * that split. A test is what keeps the two sides together.
 */
const QUESTION_LABEL = "Question:";
const OPTIONS_LABEL = "Options:";
const ANSWER_LABEL = "Answer:";

/**
 * The `via` attribute of an answer entry.
 *
 * The answer is operator input, and it says which door it came by. A new source
 * value would mean touching both closed source lists and would read back as
 * `unknown` to an older build, so the source stays `operator` and this attribute
 * says the rest.
 */
const ANSWER_VIA = "ask-user";

/** The list document's value before anything has written one. */
const EMPTY_LIST: UserQueryListRecord = { items: [], updatedAt: 0 };

/** The open questions, oldest first. An absent document is an empty list. */
async function openQuestions(deps: AppDeps): Promise<readonly UserQueryListItem[]> {
  const stored = await deps.runtime.harness.snapshot(SecUserQueryList, BACKGROUND_CONTEXT);
  return stored?.items ?? EMPTY_LIST.items;
}

/**
 * The text of one answer entry: the question, the options, and the answer.
 *
 * The model reads all three here, so it does not have to find the question again
 * in its context, and an option is numbered the same way the sidebar card numbers
 * it. The card is not the only reader: this text is the transcript's record of a
 * question that was asked and is now closed.
 */
function answerBody(item: UserQueryListItem, answer: string): string {
  return [
    `${QUESTION_LABEL} ${item.question}`,
    OPTIONS_LABEL,
    ...item.options.map((option, index) => `${index + 1}) ${option}`),
    `${ANSWER_LABEL} ${answer}`,
  ].join("\n");
}

/**
 * Take one item out of the active list, and name the item it took.
 *
 * One read and one write in the same commit, so an item another answer or a
 * withdrawal removed in the meantime stays removed and is not closed twice. The
 * id is read before the commit returns because the draft is unusable after it.
 *
 * `undefined` means the item was already gone. That is not an error here:
 * whether it was answered, withdrawn, or never there is not a distinction the
 * list can make, and the caller has already been told the key is unknown.
 */
async function removeItem(deps: AppDeps, key: string): Promise<string | undefined> {
  return await deps.runtime.harness.commit(async (tx) => {
    const draft = await tx.doc(SecUserQueryList);
    const at = draft.items.findIndex((item) => item.key === key);
    const removed = at === -1 ? undefined : draft.items.splice(at, 1)[0];
    if (removed === undefined) return undefined;
    draft.updatedAt = Date.now();
    return removed.id;
  }, BACKGROUND_CONTEXT);
}

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

export function registerUserQueries(router: Router, deps: AppDeps): void {
  router.get("/api/user-queries/events", async (route: RouteContext) => {
    await deps.streams.attachUserQueries(route, async () => ({
      type: "snapshot",
      apiVersion: API_VERSION,
      userQueries: await openQuestions(deps),
    }));
  });

  router.get("/api/user-queries", async (route) => {
    json(route.res, 200, { queries: await openQuestions(deps) });
  });

  router.post("/api/user-queries/:key", async (route) => {
    const key = route.params["key"]!;
    const body = bodyObject(route.body);
    if (body === undefined) {
      apiError(route.res, 400, "invalid_request", "body must be an object", route.requestId);
      return;
    }
    const item = (await openQuestions(deps)).find((candidate) => candidate.key === key);
    if (item === undefined) {
      // The item was answered, withdrawn, or never there. The list keeps no
      // record that separates the three, so the answer is the same 404 for all.
      apiError(route.res, 404, "not_found", "no open question with that key", route.requestId);
      return;
    }

    let mode: UserQueryMode;
    let answer: string;
    let choice: string | undefined;
    const chosen = body["choice"];
    if (typeof chosen === "number") {
      const option = item.options[chosen];
      if (!Number.isInteger(chosen) || option === undefined) {
        apiError(route.res, 400, "invalid_request", "choice is out of range", route.requestId);
        return;
      }
      mode = "choice";
      answer = option;
      choice = String(chosen);
    } else if (typeof body["other"] === "string") {
      mode = "other";
      answer = body["other"];
    } else {
      apiError(route.res, 400, "invalid_request", "provide choice or other", route.requestId);
      return;
    }

    const conversation = await deps.runtime.harness.conversation(
      Number(item.conversationId) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (conversation === undefined) {
      apiError(route.res, 404, "not_found", "the question's conversation is gone", route.requestId);
      return;
    }

    // Delivery first, removal second. The answer is what the model acts on, so
    // it must not be lost to a failed delete; if the delete fails the card stays
    // and a retry of the same answer is folded into this one by the request id.
    await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
      type: "input",
      src: "operator",
      attrs: { via: ANSWER_VIA, key: item.key, mode, id: item.id, choice },
      content: answerBody(item, answer),
      whenBusy: "followUp",
      requestId: `ask-user-answer:${item.id}`,
    }, deps.runtime.getConfig().timezone);

    const removedId = await removeItem(deps, item.key);
    if (removedId !== undefined) {
      // The audit line cannot join the commit above: `AuditLog.append` writes one
      // JSONL line to a file and takes no transaction, and a side effect inside a
      // commit body would survive a commit that then failed. It is written here,
      // right after that commit returns and only when the item was really taken,
      // which is what `question_withdraw` does (src/extensions/ask-user.ts).
      deps.runtime.audit.append({
        type: "question_answered",
        key: item.key,
        id: removedId,
        conversationId: item.conversationId,
        mode,
      });
      deps.bus.sink.emit(USER_QUERY_RESOLVED_EVENT, {
        id: removedId,
        reason: "answer",
        conversationId: item.conversationId,
      });
    }
    json(route.res, 202, { status: "resolved", mode });
  });
}
