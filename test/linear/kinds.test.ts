import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { FOCUSED_CHAT_TOOLS, SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../../src/agent/tool-profile.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { SecAgent } from "../../src/documents.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { CTX } from "./helpers.ts";

const READ_TOOLS = ["linear_status", "linear_search_issues", "linear_get_issue", "linear_list_projects", "linear_get_project", "linear_list_teams", "linear_graphql"];
const WRITE_TOOLS = ["linear_create_issue", "linear_update_issue", "linear_add_comment"];

describe("kind limits of the Linear tools", () => {
  it("removes the three write tools from scheduled runs, and no read tool", () => {
    for (const name of WRITE_TOOLS) expect(SCHEDULED_TOOL_REMOVALS, name).toContain(name);
    for (const name of READ_TOOLS) expect(SCHEDULED_TOOL_REMOVALS, name).not.toContain(name);
  });

  it("leaves all ten in the subagent offer, and out of the focused chat allow list", () => {
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(SUBAGENT_TOOL_REMOVALS, name).not.toContain(name);
      expect(FOCUSED_CHAT_TOOLS, name).not.toContain(name);
    }
  });
});

function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof (part as { text?: unknown }).text === "string" ? String((part as { text?: string }).text) : "")).join(" ");
}

async function makeAgent(test: TestHarness, kind: "subagent" | "scheduled"): Promise<Conversation> {
  const model = test.faux.getModel();
  return await test.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = kind;
        record.name = "helper";
        record.vmodel = "faux";
        record.roles = kind === "subagent" ? ["worker"] : [];
        record.status = "running";
        record.createdAt = Date.now();
        record.updatedAt = Date.now();
      },
    },
    CTX,
  );
}

async function toolResultOf(test: TestHarness, conversation: Conversation, name: string, args: Record<string, unknown>): Promise<string> {
  const before = await conversation.entries({ order: "ascending" }, 500, undefined, CTX);
  const lastId = before.items.at(-1)?.id ?? 0;
  test.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])),
  ]);
  const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
  await submission.wait(CTX);
  const after = await conversation.entries({ minEntryId: (lastId + 1) as never, order: "ascending" }, 500, undefined, CTX);
  return after.items
    .filter((entry: EntryRecord) => entry.kind === "pi.tool-result")
    .map((entry: EntryRecord) => (entry.model ?? []).map(messageText).join("\n"))
    .join("\n");
}

describe("the live kind gate, with the extension enabled", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    const base = defaultConfig();
    return await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "linear"] } },
        linear: { apiKeySecret: "linear.api-key", writes: true },
      },
    });
  }

  it("blocks linear_add_comment for a scheduled run and sends nothing, and lets a subagent reach the write gate", async () => {
    harness = await boot();
    const scheduled = await makeAgent(harness, "scheduled");
    const blocked = await toolResultOf(harness, scheduled, "linear_add_comment", { report_id: "no-such-report", id: "ENG-1", body: "x" });
    expect(blocked).toContain("`linear_add_comment` is not available to a scheduled agent");
    expect(blocked).toContain("It is for: root, subagent");
    expect(blocked).not.toContain("Refused at step");

    const subagent = await makeAgent(harness, "subagent");
    const reached = await toolResultOf(harness, subagent, "linear_add_comment", { report_id: "no-such-report", id: "ENG-1", body: "x" });
    expect(reached).not.toContain("is not available to a");
    expect(reached).toContain("Refused at step 2");
    expect(reached).toContain("Nothing was sent to Linear.");
  });
});
