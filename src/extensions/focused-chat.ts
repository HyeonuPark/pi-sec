import type { Context } from "@earendil-works/chord/context";
import { num, obj, str } from "@earendil-works/pi-schema";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  archiveFocusedChat,
  deleteFocusedChat,
  FOCUSED_CHAT_TITLE_MAX,
  focusedDepsOf,
  publishFocusedChatChange,
} from "../focused/service.ts";
import { FOCUSED_CHAT_ARCHIVE_DESCRIPTION, FOCUSED_CHAT_DELETE_DESCRIPTION, FOCUSED_CHAT_TITLE_DESCRIPTION } from "./focused-chat-texts.ts";
import { FocusedChatError } from "../focused/service.ts";
import type { ExtensionContext } from "./context.ts";

/**
 * `focused-chat` — the three tools a focused chat and the root need between them.
 *
 * A focused chat is a conversation the user opens from the web page to talk about
 * one topic at length. It reads and answers; it does not change the system. So
 * the tools that name it are few, and which conversation may call which one is
 * the whole of the policy:
 *
 *   focused_chat_title    the chat's own, once, while it has no title.
 *   focused_chat_archive  the root's: the user's permission ends a chat.
 *   focused_chat_delete   the root's, and only with an approved report that
 *                         names the conversation.
 *
 * The kinds are enforced twice on purpose. The stored tool filter (an allow list
 * for a focused chat, a removal list for the other kinds) decides what is
 * offered, and `TOOL_KINDS` in the subagents extension is the live gate, which is
 * the one that also covers a conversation created before this existed. The
 * checks inside the bodies are the third layer, and they are what turns a wrong
 * call into a sentence the model can act on.
 *
 * The tools are installed by the `subagents` extension (`createFocusedChatTools`
 * below), not by an extension of their own: one act, one hub, one enabled-list
 * entry.
 */

function text(body: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) };
}

/** A refusal with the code the store gave it, in words a model can use. */
function refusal(error: unknown): ToolExecutionResult {
  if (error instanceof FocusedChatError) {
    const where =
      error.code === "not_found"
        ? " That conversation is not a focused chat."
        : error.code === "chat_deleted"
          ? " That chat was deleted."
          : "";
    return text(`Refused: ${error.message}.${where}`, true);
  }
  return text(`Failed: ${error instanceof Error ? error.message : String(error)}`, true);
}

/**
 * The three focused chat tools, ready to install.
 *
 * The `subagents` extension installs them, and that placement is deliberate: a
 * bundled extension reaches a running install only when its name is in
 * `agent.extensions.enabled`, and an install whose list was written out by hand
 * would silently lose all three. The hub those tools act through comes from
 * `subagents`, so a build with the hub is a build with them.
 */
export function createFocusedChatTools(context: ExtensionContext): ToolRegistration[] {
  const tools = () => focusedDepsOf(context);

  const setTitle = defineTool({
    name: "focused_chat_title",
    description: FOCUSED_CHAT_TITLE_DESCRIPTION,
    parameters: obj(
      {
        title: str({ description: `The title: 1 to ${FOCUSED_CHAT_TITLE_MAX} characters.` }),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx: Context) => {
      const deps = tools();
      const id = Number(api.conversationId);
      const row = deps.store.get(id);
      if (row === undefined) {
        return deps.store.isDeleted(id)
          ? text("Refused: this focused chat was deleted, so it has no title to set.", true)
          : text("Refused: this conversation is not a focused chat, so it has no title to set.", true);
      }
      if (row.archivedAt !== null) {
        return text("Refused: this focused chat is archived, so its title no longer changes.", true);
      }
      if (row.title !== null) {
        return text(
          `Refused: this focused chat already has the title "${row.title}". Only the user changes it now, on the web page.`,
          true,
        );
      }
      const wanted = String(args.title ?? "").trim();
      if (wanted === "") return text("Refused: the title must not be empty.", true);
      if (wanted.length > FOCUSED_CHAT_TITLE_MAX) {
        return text(
          `Refused: the title is ${wanted.length} characters and the limit is ${FOCUSED_CHAT_TITLE_MAX}.`,
          true,
        );
      }
      // The write itself decides the race: two calls that both read an untitled
      // chat still have one winner, and the loser hears that the title is taken.
      if (!deps.store.setTitleIfUntitled(id, wanted)) {
        const after = deps.store.get(id);
        return text(
          `Refused: this focused chat was titled while this call ran${after?.title === null || after?.title === undefined ? "" : ` ("${after.title}")`}. Only the user changes it now.`,
          true,
        );
      }
      const titled = deps.store.get(id);
      if (titled !== undefined) publishFocusedChatChange(deps, titled, "titled");
      void ctx;
      return text(`Titled this focused chat "${wanted}".`);
    },
  });

  const archive = defineTool({
    name: "focused_chat_archive",
    description: FOCUSED_CHAT_ARCHIVE_DESCRIPTION,
    parameters: obj(
      {
        conversationId: num({ description: "The focused chat's conversation number." }),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx: Context) => {
      const deps = tools();
      const id = Number(args.conversationId);
      if (!Number.isInteger(id) || id <= 0) {
        return text(`Refused: "${String(args.conversationId)}" is not a conversation number.`, true);
      }
      try {
        const row = await archiveFocusedChat(deps, id, ctx);
        return text(
          `Archived "${row.name}"${row.title === null ? "" : ` (${row.title})`}, conversation ${row.conversationId}. Its transcript and its record stay, its slot is free, and it no longer takes messages.`,
        );
      } catch (error) {
        return refusal(error);
      }
    },
  });

  const remove = defineTool({
    name: "focused_chat_delete",
    description: FOCUSED_CHAT_DELETE_DESCRIPTION,
    parameters: obj(
      {
        conversationId: num({ description: "The focused chat's conversation number." }),
        reportId: str({
          description:
            "The result report whose newest revision the user approved and whose text names this conversation id.",
        }),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx: Context) => {
      const deps = tools();
      const id = Number(args.conversationId);
      if (!Number.isInteger(id) || id <= 0) {
        return text(`Refused: "${String(args.conversationId)}" is not a conversation number.`, true);
      }
      try {
        const row = await deleteFocusedChat(deps, { conversationId: id, reportId: String(args.reportId ?? "") }, ctx);
        return text(
          `Deleted "${row.name}"${row.title === null ? "" : ` (${row.title})`}, conversation ${row.conversationId}. No focused chat route shows it any more; its transcript entries stay in the state database.`,
        );
      } catch (error) {
        return refusal(error);
      }
    },
  });

  return [setTitle, archive, remove];
}
