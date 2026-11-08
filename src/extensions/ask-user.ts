import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import {
  SecUserQueryList,
  USER_QUERY_EVENT,
  USER_QUERY_RESOLVED_EVENT,
  userQueryKey,
  type UserQueryListItem,
} from "../documents.ts";
import { ulid } from "../runtime/ids.ts";
import { zoneIso } from "../time-format.ts";
import type { ExtensionContext } from "./context.ts";

/**
 * The body labels of an answer envelope.
 *
 * The answer route (`src/server/routes/user-queries.ts`) writes the same three
 * strings, and the client looks for `Question:` and `Answer:` to draw the answer
 * card. They are written out here so the model reads the shape it will receive.
 */
const ANSWER_LABELS = "Question:, Options: and Answer:";

/** How the answer to one question arrives, said in one sentence. */
function answerArrival(key: string): string {
  return `The answer arrives as a message whose first line carries src="operator", via="ask-user", key="${key}", mode="choice" or "other", and the question's id; its body carries the question, the choices, and the answer under the labels ${ANSWER_LABELS}.`;
}

const ASK_USER_DESCRIPTION = `Ask the user a question with fixed choices.

This tool returns at once and does not wait for the answer, so the turn continues and the conversation is not blocked. The question shows up for the user as a card with its choices, and the answer arrives later as a user message whose first line carries src="operator" and via="ask-user". Its body carries the question, the choices, and the answer under three labels:

Question: <the question>
Options:
1) <the first choice>
Answer: <the chosen choice, or the words the user typed>

That message is the user's answer to this question. Asking the same question twice does not open a second one: the second call returns the question that is already open, with its id and key. Pass supersedes with the key of an open question to replace that question with this one. Use questions_open to list your open questions and question_withdraw to close one you no longer need.`;

const QUESTIONS_OPEN_DESCRIPTION = `List the questions you asked with ask_user that nobody has answered or withdrawn yet, in this conversation. One line per question, in the order they were asked:

<item id="01J..." key="2f81..." question="which account?" options="2" created="2026-10-15T19:00:00.000Z" />

key names the question for question_withdraw, options is how many choices it has, and created is when it was opened. If nothing is open the result says so. This tool only reads: it changes nothing.`;

const QUESTION_WITHDRAW_DESCRIPTION = `Withdraw an open question you asked with ask_user, named by its key from questions_open. The question leaves the active list and the user's sidebar, and no answer arrives for it afterwards. A question that was already answered, already withdrawn, or never open is an error. Use this when a question went stale and you no longer need the answer.`;

/** The bundled `ask-user` extension. */
export function createAskUserExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const ask = defineTool({
    name: "ask_user",
    description: ASK_USER_DESCRIPTION,
    parameters: obj(
      {
        question: str(),
        options: arr(str()),
        supersedes: opt(str()),
      },
    ),
    // A recovery rerun takes the same id from the memo and finds the item it
    // already added by its key, so the list does not grow a second copy.
    replay: "safe",
    execute: async (args, api, ctx) => {
      const conversationId = String(api.conversationId);
      const key = userQueryKey(conversationId, args.question, args.options);
      const id = await api.memo<string>("ask_user:query", ulid(), ctx);
      const createdAt = Date.now();
      const outcome: {
        opened?: UserQueryListItem;
        alreadyOpen?: string;
        superseded?: { id: string; conversationId: string };
      } = {};

      await api.commit(async (tx) => {
        // Read and write in one commit: the session line serializes commits, so no
        // other question can slip in between the duplicate check and the row.
        const draft = await tx.doc(SecUserQueryList);
        if (args.supersedes !== undefined) {
          const at = draft.items.findIndex((item) => item.key === args.supersedes);
          if (at !== -1) {
            const removed = draft.items.splice(at, 1)[0];
            // Read the fields now: the draft is unusable once this commit returns.
            if (removed !== undefined) {
              outcome.superseded = { id: removed.id, conversationId: removed.conversationId };
            }
            draft.updatedAt = createdAt;
          }
        }
        const open = draft.items.find((item) => item.key === key);
        if (open !== undefined) {
          outcome.alreadyOpen = open.id;
          return;
        }
        const item: UserQueryListItem = {
          key,
          id,
          conversationId,
          question: args.question,
          options: [...args.options],
          createdAt,
        };
        draft.items.push(item);
        draft.updatedAt = createdAt;
        outcome.opened = { ...item };
      }, ctx);

      if (outcome.superseded !== undefined) {
        context.events.emit(USER_QUERY_RESOLVED_EVENT, {
          id: outcome.superseded.id,
          reason: "supersede",
          conversationId: outcome.superseded.conversationId,
        });
      }

      if (outcome.opened !== undefined) {
        context.events.emit(USER_QUERY_EVENT, { ...outcome.opened });
        return {
          output: [
            {
              type: "text" as const,
              text: `Question ${id} is open (key ${key}). This turn is not blocked. ${answerArrival(key)}`,
            },
          ],
        };
      }

      return {
        output: [
          {
            type: "text" as const,
            text: `The question is already open as ${outcome.alreadyOpen} (key ${key}). This turn is not blocked. ${answerArrival(key)}`,
          },
        ],
      };
    },
  });

  const questionsOpen = defineTool({
    name: "questions_open",
    description: QUESTIONS_OPEN_DESCRIPTION,
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      // A list nobody has written yet has no document at all. That is an empty
      // list, not an error and not a missing list.
      const list = await api.snapshot(SecUserQueryList, ctx);
      const conversationId = String(api.conversationId);
      const items = (list?.items ?? []).filter((item) => item.conversationId === conversationId);
      if (items.length === 0) {
        return { output: [{ type: "text" as const, text: "no open questions in this conversation" }] };
      }
      const lines = items.map((item) => {
        const question = item.question.replace(/"/g, "'").replace(/\s+/g, " ").slice(0, 200);
        const fields = [
          `id="${item.id}"`,
          `key="${item.key}"`,
          `question="${question}"`,
          `options="${item.options.length}"`,
          `created="${zoneIso(item.createdAt, context.getConfig().timezone)}"`,
        ];
        return `<item ${fields.join(" ")} />`;
      });
      return { output: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  const questionWithdraw = defineTool({
    name: "question_withdraw",
    description: QUESTION_WITHDRAW_DESCRIPTION,
    parameters: obj({ key: str() }),
    // Withdrawn is gone: a rerun of a call that already removed its item finds no
    // such key and reports the same error as a key that never existed.
    replay: "safe",
    execute: async (args, api, ctx) => {
      const conversationId = String(api.conversationId);
      let withdrawn: { id: string } | undefined;

      await api.commit(async (tx) => {
        const draft = await tx.doc(SecUserQueryList);
        const at = draft.items.findIndex((item) => item.key === args.key && item.conversationId === conversationId);
        if (at === -1) return;
        const removed = draft.items.splice(at, 1)[0];
        // Read the id now: the draft is unusable once this commit returns.
        if (removed !== undefined) {
          withdrawn = { id: removed.id };
        }
        draft.updatedAt = Date.now();
      }, ctx);

      if (withdrawn === undefined) {
        return {
          output: [
            { type: "text" as const, text: `no open question with key "${args.key}" in this conversation` },
          ],
          isError: true,
        };
      }

      context.audit.append({ type: "question_withdrawn", key: args.key, id: withdrawn.id, conversationId });
      context.events.emit(USER_QUERY_RESOLVED_EVENT, { id: withdrawn.id, reason: "withdraw", conversationId });
      return {
        output: [{ type: "text" as const, text: `question ${withdrawn.id} (key ${args.key}) withdrawn.` }],
      };
    },
  });

  return defineExtension({ name: "ask-user", tools: [ask, questionsOpen, questionWithdraw] });
}
