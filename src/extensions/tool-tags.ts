import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { Config } from "../config/schema.ts";

/**
 * The `complex` tag on a tool, and how a tool gets one.
 *
 * The tag says two things: this tool may take a long time, so starting it in
 * the background is allowed, and this tool observes its own invocation's
 * `context.abortSignal`, so cancelling it actually stops something. The second
 * is what makes `async_cancel` more than a name.
 *
 * A tag is keyed by the pair (extension, tool), never by the tool name alone. A
 * runtime extension that registers a tool called `bash` must not inherit the
 * bundled `bash`'s tag, and a declaration only counts for the extension that
 * provides the tool. That is what makes resolution independent of install
 * order: the answer is read at call time from the extension that currently
 * provides the tool.
 *
 * Sources, lowest first:
 *   1. the built-in table below;
 *   2. an extension's own declaration, through its `toolTags` export, which the
 *      loader reads at install time;
 *   3. the operator's list in `agent.tools.complex`.
 */

export interface ToolTag {
  readonly complex: boolean;
}

/** What an extension may declare for one of its tools. */
export interface ToolTagDeclaration {
  readonly complex?: boolean;
}

interface BuiltinTag {
  readonly extension: string;
  readonly tool: string;
  readonly complex: boolean;
}

/**
 * Bundled tags, keyed by the pair. `bash` comes from `CodingTools` inside the
 * `coding` extension; `js` is ours.
 */
export const BUILTIN_TOOL_TAGS: readonly BuiltinTag[] = [
  { extension: "coding", tool: "bash", complex: true },
  { extension: "js-tools", tool: "js", complex: true },
  // A request-response can take as long as the other agent takes to work. Run in
  // the background it does not hold a run of the asking conversation, and its
  // answer arrives as a message; run directly it blocks and carries a deadline.
  { extension: "subagents", tool: "request_message", complex: true },
  // The gate runs the type check and the whole test suite, about two minutes, and
  // it kills the command in flight when its call is cancelled. Run in the
  // background the root ends its turn at once, and the gate's answer arrives as a
  // message.
  { extension: "self-edit", tool: "request_restart", complex: true },
];

function readTags(value: unknown): { tags: Map<string, ToolTag>; rejected: string[] } {
  const tags = new Map<string, ToolTag>();
  const rejected: string[] = [];
  if (value === undefined || value === null) return { tags, rejected };
  if (typeof value !== "object" || Array.isArray(value)) return { tags, rejected: ["(not an object)"] };
  for (const [name, declaration] of Object.entries(value as Record<string, unknown>)) {
    if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
      rejected.push(name);
      continue;
    }
    const complex = (declaration as ToolTagDeclaration).complex;
    if (complex !== undefined && typeof complex !== "boolean") {
      rejected.push(name);
      continue;
    }
    tags.set(name, { complex: complex ?? true });
  }
  return { tags, rejected };
}

/** The catalog of `complex` tags, shared by the extensions that read them. */
export class ToolTagCatalog {
  private readonly getConfig: () => Config;
  private readonly declared = new Map<string, ReadonlyMap<string, ToolTag>>();

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig;
  }

  /**
   * Record what an extension declared, replacing anything it declared before.
   * Replacement, not merge: a reloaded extension that dropped a declaration
   * must drop the tag with it. Returns the names it could not read, for the
   * loader to report.
   */
  declare(extension: string, value: unknown): string[] {
    const { tags, rejected } = readTags(value);
    if (tags.size === 0) this.declared.delete(extension);
    else this.declared.set(extension, tags);
    return rejected;
  }

  forget(extension: string): void {
    this.declared.delete(extension);
  }

  /** Whether one tool of one extension carries the `complex` tag right now. */
  isComplex(extension: string, tool: string): boolean {
    const overrides = this.getConfig().agent.tools.complex;
    if (overrides.remove.includes(tool)) return false;
    const declared = this.declared.get(extension)?.get(tool);
    if (declared !== undefined) return declared.complex;
    const builtin = BUILTIN_TOOL_TAGS.find((tag) => tag.extension === extension && tag.tool === tool);
    if (builtin !== undefined) return builtin.complex;
    return overrides.add.includes(tool);
  }

  /** The complex tools among `tools`, for the messages that list them. */
  complexTools(tools: readonly { readonly extension: Extension<ToolRegistration>; readonly tool: ToolRegistration }[]): string[] {
    const names: string[] = [];
    for (const entry of tools) {
      if (!this.isComplex(entry.extension.name, entry.tool.name)) continue;
      if (!names.includes(entry.tool.name)) names.push(entry.tool.name);
    }
    return names;
  }
}
