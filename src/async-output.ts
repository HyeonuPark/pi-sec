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
 * transcript still holds it, and `renderAsyncOutput` and
 * `parseLegacyAsyncOutput` below are its writer and reader.
 *
 * `src/agent-message.ts` is the same shape for a message from another agent.
 */

/**
 * First tag of the older form of a background result's first line.
 *
 * New results do not use it; the envelope above does. It stays because stored
 * text and the readers of that text are still written against it.
 */
export const ASYNC_OUTPUT_TAG = "tool-call-output";

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

function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Render the older tag.
 *
 * No new result is written this way: the producer builds an envelope,
 * `wrapMessage("tool-output", body, { title, tool, status })`, and redacts it
 * afterwards. The function stays as the writer for the older form, so stored
 * text and the tests that pin that shape keep a producer to compare against.
 */
export function renderAsyncOutput(output: AsyncOutput): string {
  const lines = [
    `<${ASYNC_OUTPUT_TAG} title="${encodeAttribute(output.title)}" tool="${encodeAttribute(output.tool)}" status="${output.status}">`,
  ];
  if (output.args !== undefined && output.args.trim() !== "") lines.push(output.args, "---");
  lines.push(output.body, `</${ASYNC_OUTPUT_TAG}>`);
  return lines.join("\n");
}

/**
 * Parse a rendered result, or `undefined` when this is not one.
 *
 * Both stored forms are read. An envelope is read through `readMessage`, which
 * owns the escaping rules, so they are not written down a second time here. The
 * older tag is read by `parseLegacyAsyncOutput` below.
 */
export function parseAsyncOutput(content: string): ParsedAsyncOutput | undefined {
  const read = readMessage(content);
  if (read !== undefined && read.format === "envelope") {
    if (read.source !== "tool-output") return undefined;
    const title = read.attrs["title"];
    const tool = read.attrs["tool"];
    if (title === undefined || tool === undefined) return undefined;
    return { title, tool, status: read.attrs["status"] ?? "done", body: read.body };
  }
  return parseLegacyAsyncOutput(content);
}

/** The older tag's reader. Kept for text written before the envelope. */
function parseLegacyAsyncOutput(content: string): ParsedAsyncOutput | undefined {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  if (!first.startsWith(`<${ASYNC_OUTPUT_TAG}`)) return undefined;
  const attributes = new Map<string, string>();
  for (const match of first.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g)) {
    attributes.set(match[1]!, decodeAttribute(match[2]!));
  }
  const title = attributes.get("title");
  const tool = attributes.get("tool");
  if (title === undefined || tool === undefined) return undefined;
  const rest = newline === -1 ? "" : content.slice(newline + 1);
  const closing = rest.lastIndexOf(`</${ASYNC_OUTPUT_TAG}>`);
  const body = (closing === -1 ? rest : rest.slice(0, closing)).replace(/\s+$/, "");
  return { title, tool, status: attributes.get("status") ?? "done", body };
}
