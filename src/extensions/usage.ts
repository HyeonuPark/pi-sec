import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { contextUsage } from "../agent/context-usage.ts";
import { requireHarness, type ExtensionContext } from "./context.ts";

function summary(state: { models: Readonly<Record<string, unknown>>; tools: Readonly<Record<string, unknown>> }): string {
  const models = Object.entries(state.models)
    .map(([key, usage]) => `${key}: ${JSON.stringify(usage)}`)
    .join("\n");
  const tools = Object.entries(state.tools)
    .map(([key, usage]) => `${key}: ${JSON.stringify(usage)}`)
    .join("\n");
  return [models, tools].filter((part) => part !== "").join("\n") || "no usage yet";
}

/**
 * The bundled `usage` extension.
 *
 * It reports what a decision can be made on: how full this conversation's
 * context is, against the model's window and the point where compaction fires.
 * Per-conversation token totals were removed because they answer nothing — the
 * number that matters inside one conversation is how much room is left before
 * the next request has to compact.
 *
 * The occupancy and the usable maximum come from `contextUsage`, the same reader
 * the chat page fills its context bar from. The first line is the pair a
 * decision is made on: tokens used over the maximum that excludes the room kept
 * free for the answer, so a full bar in the UI and a full line here mean the
 * same thing.
 *
 * Deliberately no system-prompt section. These numbers move with every request,
 * and a section that renders a different value each time rewrites the head of the
 * request and costs the provider's whole prefix cache. See
 * `test/agent-and-focused-chats.test.ts`.
 */
export function createUsageExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const usageTool = defineTool({
    name: "usage",
    description:
      "Report how full this conversation's context is, how much room is left before compaction, and the session's token and cost totals.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const harness = requireHarness(context);
      const config = context.getConfig();
      const reserveTokens = config.agent.compaction.reserveTokens;
      const lines: string[] = [];

      const conversation = await harness.conversation(api.conversationId, ctx);
      const usage =
        conversation === undefined ? undefined : await contextUsage(conversation, api.models, reserveTokens, ctx);

      const used = usage?.used;
      const max = usage?.max;
      const window = usage?.window;
      if (used !== undefined && max !== undefined) {
        lines.push(`context: ${used} / ${max} tokens used (${max - used} left before compaction)`);
      } else if (used !== undefined) {
        lines.push(`context: ${used} tokens used (the model's window is not in the catalog)`);
      } else {
        lines.push("context: not measured yet (no response in this conversation)");
      }
      if (window !== undefined) {
        lines.push(`window: ${window} tokens, ${reserveTokens} held back for the answer`);
      }
      lines.push(`entries in context: ${usage?.entries ?? 0}`);
      lines.push("", summary((await harness.usage(ctx)) as never));
      return { output: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  return defineExtension({ name: "usage", tools: [usageTool] });
}
