import type { EntryRecord } from "@earendil-works/pi-durable";

/**
 * One conversation's entries in the shape pi-durable stores, with every field the
 * chat page never draws filled in: a system prompt entry that carries the whole
 * prompt, an assistant turn with thinking text, a thinking signature, a tool call
 * with arguments and a usage record, a plain tool result, and an edit result whose
 * `details` hold the same change twice (`diff` and `patch`).
 *
 * Two tests read this: the unit test of the slimming rule, and the jsdom test that
 * draws the same conversation twice — once from these entries and once from the
 * slimmed ones — and compares the transcript. Sharing the fixture is what makes
 * the second test about the real rule rather than about a fixture written by hand
 * to suit it.
 */

const SECTIONS = "A role rule. ".repeat(400);
const TOOL_SCHEMA = { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } };

export function fullEntries(): EntryRecord[] {
  const rows = [
    {
      id: "01KA00000000000000000000E1",
      conversationId: "1",
      kind: "pi.system",
      model: [
        {
          role: "system",
          content: "You are pi-sec, an autonomous personal secretary.",
          sections: { roles: SECTIONS, conventions: SECTIONS },
          toolsAdded: [{ name: "read", description: SECTIONS, parameters: TOOL_SCHEMA }],
          timestamp: 1_000,
        },
      ],
    },
    {
      id: "01KA00000000000000000000E2",
      conversationId: "1",
      kind: "pi.user",
      model: [
        { role: "user", content: [{ type: "text", text: "the parser drops the last line" }], timestamp: 2_000 },
      ],
    },
    {
      id: "01KA00000000000000000000E3",
      conversationId: "1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          content: [
            { type: "thinking", thinking: "The parser reads to the last newline ".repeat(20), thinkingSignature: "sig-" + "s".repeat(200) },
            { type: "text", text: "I will read the file first." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/parser.ts" } },
          ],
          usage: {
            input: 12_000,
            output: 400,
            cacheRead: 8_000,
            cacheWrite: 0,
            totalTokens: 12_400,
            cost: { input: 0.03, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.051 },
          },
          stopReason: "toolUse",
          timestamp: 3_000,
        },
      ],
    },
    {
      id: "01KA00000000000000000000E4",
      conversationId: "1",
      kind: "pi.tool-result",
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "export function parse(text: string) {\n  return text.split(\"\\n\");\n}\n" }],
          isError: false,
          timestamp: 4_000,
        },
      ],
    },
    {
      id: "01KA00000000000000000000E5",
      conversationId: "1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          content: [
            { type: "thinking", thinking: "The trailing newline is dropped by split.", thinkingSignature: "sig-" + "t".repeat(200) },
            { type: "text", text: "The split drops the trailing newline. I will append one." },
            { type: "toolCall", id: "call-2", name: "edit", arguments: { path: "/tmp/parser.ts", text: "return text.split(\"\\n\");" } },
          ],
          usage: {
            input: 12_400,
            output: 300,
            cacheRead: 12_000,
            cacheWrite: 0,
            totalTokens: 12_700,
            cost: { input: 0.03, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.051 },
          },
          stopReason: "toolUse",
          timestamp: 5_000,
        },
      ],
    },
    {
      id: "01KA00000000000000000000E6",
      conversationId: "1",
      kind: "pi.tool-result",
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "edit",
          content: [{ type: "text", text: "edited /tmp/parser.ts (+1 -1)" }],
          details: {
            diff: "-  return text.split(\"\\n\");\n+  return text.split(\"\\n\").concat(\"\");\n",
            patch: "*** Begin Patch\n*** Update File: /tmp/parser.ts\n-  return text.split(\"\\n\");\n+  return text.split(\"\\n\").concat(\"\");\n*** End Patch\n",
          },
          isError: false,
          timestamp: 6_000,
        },
      ],
    },
    {
      id: "01KA00000000000000000000E7",
      conversationId: "1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "Done. The parser keeps the last line now." }],
          usage: {
            input: 12_700,
            output: 20,
            cacheRead: 12_400,
            cacheWrite: 0,
            totalTokens: 12_720,
            cost: { input: 0.03, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.051 },
          },
          stopReason: "stop",
          timestamp: 7_000,
        },
      ],
    },
  ];
  return rows as unknown as EntryRecord[];
}
