import type { Context } from "@earendil-works/chord";
import {
  ROOT_CONVERSATION_ID,
  wrapTool,
  type ConversationId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { agentScopeOf, type AgentScope } from "./agent-scope.ts";
import type { ExtensionContext } from "./context.ts";

/**
 * The guard on the record of the user's own facts.
 *
 * The record is one file in the memory directory, and the split files of a long
 * record sit in a directory beside it. Only the root conversation reads and
 * writes them. A focused chat is a conversation the user writes to, so it reads
 * the record and writes nothing. Every other agent asks the root for the facts
 * that its work needs, and the root puts those facts into an answer or a brief.
 *
 * The guard is a tool wrapper and not a hook: a `js` script that calls `read` or
 * `edit` runs the tool itself, with no ToolTask around it, and a nested call
 * keeps the conversation id of the caller. Wrapping `execute` covers that path,
 * and the same shape as the guards in `write-guard.ts`.
 *
 * `bash` is not covered: `cat` and `grep` reach the file with the same Unix
 * account, and a shell refuses nothing. That hole is known, and the conventions tell every agent not to use it.
 */

/** The file that holds the user's own facts, in the memory directory. */
export const USER_RECORD_FILE = "user-facts.md";

/** The directory that holds the split files of a long record. */
export const USER_RECORD_DIRECTORY = "user-facts";

/** A tool that opens the record. */
export type RecordTool = "read" | "read_full" | "write" | "edit";

/**
 * True when the path names the record or a file under its split directory.
 *
 * The test is by name and not only by absolute path, because a relative path is
 * resolved against the workspace of the caller. A file with this name anywhere
 * is refused too: a wrong refusal costs one question to the root, and a missed
 * one costs a fact of the user.
 */
export function touchesUserRecord(path: string, memoryDir: string): boolean {
  const normal = path.replace(/\/{2,}/g, "/");
  if (normal === `${memoryDir}/${USER_RECORD_FILE}`) return true;
  if (`${normal}/`.includes(`/${USER_RECORD_DIRECTORY}/`)) return true;
  return normal === USER_RECORD_FILE || normal.endsWith(`/${USER_RECORD_FILE}`);
}

/** True when this scope may not open the record with this tool. */
export function refusesUserRecord(scope: AgentScope, tool: RecordTool): boolean {
  if (tool === "read" || tool === "read_full") return scope !== "root" && scope !== "focused";
  return scope !== "root";
}

/** The refusal a caller sees: an error result, so it cannot be taken for a short file. */
export function recordRefusal(tool: RecordTool, path: string) {
  const who = tool === "read" || tool === "read_full" ? "reads" : "writes";
  return {
    isError: true,
    output: [
      {
        type: "text" as const,
        text:
          `${tool} did not open ${path}: the file that holds the user's own facts opens for the root conversation, ` +
          `and a focused chat reads it without writing. Only the root ${who} it. ` +
          "Ask the root for the fact that this work needs.",
      },
    ],
  };
}

/** The tool of `CodingTools` with this name; a name it does not carry is a bug here. */
function codingTool(name: string): ToolRegistration {
  const found = CodingTools.tools?.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`the coding tools have no ${name}`);
  return found;
}

/** The memory directory of this install. A bare context, as a test builds, has none. */
function memoryDirOf(context: ExtensionContext): string {
  return context.paths?.memoryDir ?? "";
}

/** One tool, with the record guard in front of its `execute`. */
function guardedByRecord(context: ExtensionContext, tool: ToolRegistration, kind: RecordTool): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, chord) => {
      const path = String((args as { path?: unknown } | undefined)?.path ?? "");
      if (touchesUserRecord(path, memoryDirOf(context))) {
        const scope = await agentScopeOf(context, api.conversationId as ConversationId, chord as Context);
        if (refusesUserRecord(scope, kind)) return recordRefusal(kind, path);
      }
      return tool.execute(args as never, api as ToolExecutionApi, chord);
    },
  };
}

/** The guard as wrappers of the `coding` extension, for `read`, `write` and `edit`. */
export function userRecordWraps(context: ExtensionContext): Wrap<ToolRegistration>[] {
  return [
    wrapTool(codingTool("read"), (tool) => guardedByRecord(context, tool, "read")),
    wrapTool(codingTool("write"), (tool) => guardedByRecord(context, tool, "write")),
    wrapTool(codingTool("edit"), (tool) => guardedByRecord(context, tool, "edit")),
  ];
}

/** The same decision for a tool that lives outside `CodingTools`, such as `read_full`. */
export async function refusesRecordForCall(
  context: ExtensionContext,
  api: ToolExecutionApi,
  chord: Context,
  kind: RecordTool,
  path: string,
): Promise<boolean> {
  if (!touchesUserRecord(path, memoryDirOf(context))) return false;
  const scope = await agentScopeOf(context, api.conversationId as ConversationId, chord);
  return refusesUserRecord(scope, kind);
}

/** The root conversation id, exported so a test names it once. */
export const RECORD_OWNER = ROOT_CONVERSATION_ID;
