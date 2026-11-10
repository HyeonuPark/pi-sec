import { readMessage } from "./message-envelope.ts";
import { SAFE_NAME_PATTERN, isSafeName } from "./runtime/names.ts";

/**
 * How a background call's result reaches the conversation.
 *
 * The result arrives as user input, because that is the only admission that
 * starts a run: a passive entry write would sit in the transcript until
 * something else woke the agent. It is not input the operator typed, and two
 * readers have to be able to tell the difference:
 *
 *   - the UI draws it as a tool call, in the same group as tool results, so it
 *     never looks like an operator message;
 *   - the model is told, in the `async_call` description and in a prompt
 *     section, that a message whose first line carries this tag is tool output.
 *
 * A result written now is an envelope with `src="tool-output"`
 * (`src/message-envelope.ts`, which owns the format and the escaping rules).
 * The older `<tool-call-output ...>` tag stays readable because a stored
 * transcript still holds it, and `readMessage` reads it. Nothing writes it any
 * more.
 *
 * `src/agent-message.ts` is the same shape for a message from another agent.
 */

export type AsyncOutputStatus = "done" | "failed" | "interrupted" | "cancelled";

export interface AsyncOutput {
  readonly title: string;
  readonly tool: string;
  readonly status: AsyncOutputStatus;
  /** One-line summary of the arguments, already bounded and redacted. */
  readonly args?: string;
  readonly body: string;
}

export interface ParsedAsyncOutput {
  readonly title: string;
  readonly tool: string;
  readonly status: string;
  readonly body: string;
}

/**
 * The request id of one call's delivery. The completion path and the cancel
 * path both use it, so whichever arrives first is the one that lands: a known
 * request id returns its existing submission and writes nothing.
 */
export function asyncOutputRequestId(title: string): string {
  return `async-call:${title}`;
}

/** The name rule, shared with subagent names and prompt keys. */
export const ASYNC_TITLE_PATTERN = SAFE_NAME_PATTERN;

export function isAsyncTitle(title: string): boolean {
  return isSafeName(title);
}

/**
 * Parse a rendered result, or `undefined` when this is not one.
 *
 * Both stored forms are read through `readMessage`, which owns the escaping
 * rules, so they are not written down a second time here.
 */
export function parseAsyncOutput(content: string): ParsedAsyncOutput | undefined {
  const read = readMessage(content);
  if (read === undefined || read.source !== "tool-output") return undefined;
  const title = read.attrs["title"];
  const tool = read.attrs["tool"];
  if (title === undefined || tool === undefined) return undefined;
  return { title, tool, status: read.attrs["status"] ?? "done", body: read.body };
}
