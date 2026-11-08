import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { SecAgent } from "../src/documents.ts";
import { SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A draft tool reads a file after the calls that come before it in its bundle.
 *
 * `reports_draft` with `path` and `report_check` read the file when the call
 * runs, so in a parallel bundle they can read a file that a shell call beside
 * them is still writing. Both registrations carry `executionMode: "sequential"`,
 * which makes the whole bundle run one call at a time in the order the calls
 * are written.
 *
 * Each case writes a file, then sends one model reply that holds a `bash` call
 * which writes the file 0.5 seconds after it starts and a report call whose
 * `path` is that file. The two texts differ, so a tool that read the file
 * before the shell finished is visible in the answer.
 */

const CTX = BACKGROUND_CONTEXT;

/** The text the file holds before the bundle runs. */
const BEFORE = [
  "# draft",
  "",
  "| a | b |",
  "| c | d |",
  "",
].join("\n");

/** The text the shell writes 0.5 seconds after it starts. */
const AFTER = [
  "# draft",
  "",
  "| a | b |",
  "|---|---|",
  "",
].join("\n");

/** A shell command that writes AFTER over the file at `path`, after a wait. */
function shellWrite(path: string): string {
  const body = AFTER.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/'/g, "'\\''");
  return `sleep 0.5; printf '${body}' > '${path}'`;
}

describe("the order of a bundle that holds a draft tool", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness({ loadExtensions: true });
    return harness;
  }

  /** A conversation of one role, with the agent record and the filter a spawn writes. */
  async function makeAgent(test: TestHarness, roles: readonly string[]): Promise<Conversation> {
    const model = test.faux.getModel();
    return await test.runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
        init: async (tx, conversationId) => {
          const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
          record.kind = "subagent";
          record.name = "helper";
          record.vmodel = "faux";
          record.roles = [...roles];
          record.status = "running";
          record.createdAt = Date.now();
          record.updatedAt = Date.now();
          const profile = await tx.doc(AgentDoc, conversationId);
          profile.tools = { remove: [...SUBAGENT_TOOL_REMOVALS] };
        },
      },
      CTX,
    );
  }

  /** The text of one entry, whichever shape its content takes. */
  function entryText(entry: EntryRecord): string {
    return (entry.model ?? [])
      .map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((part) =>
            part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
              ? String((part as { text?: string }).text ?? "")
              : "",
          )
          .join("");
      })
      .join("\n");
  }

  /** The text of every tool result of a conversation, in order. */
  async function toolResults(conversation: Conversation): Promise<string[]> {
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, CTX);
    return page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => entryText(entry));
  }

  /** A file that holds BEFORE, in a directory of its own. */
  async function fileWithBeforeText(name = "draft.md"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-draft-order-"));
    const path = join(dir, name);
    await writeFile(path, BEFORE, "utf8");
    return path;
  }

  it("gives a draft the text the shell call before it wrote", { timeout: 30_000 }, async () => {
    const test = await boot();
    const path = await fileWithBeforeText();
    const job = await test.runtime.jobs.create(CTX, { title: "work" });
    const conversation = await makeAgent(test, ["orchestrator"]);
    test.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: shellWrite(path) }), fauxToolCall("reports_draft", { jobId: job.id, title: "plan", path })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("await_orders", { note: "checked" })], { stopReason: "toolUse" }),
    ]);
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
    await submission.wait(CTX);

    const drafts = await test.runtime.drafts.list(CTX);
    expect(drafts).toHaveLength(1);
    const held = await readFile(drafts[0]!.path, "utf8");
    expect(held).toBe(AFTER);
    // The draft tool rejected nothing: the file was there when the call ran.
    expect(await toolResults(conversation)).toContainEqual(expect.stringContaining("written"));
  });

  it("gives a check the text the shell call before it wrote", { timeout: 30_000 }, async () => {
    const test = await boot();
    const path = await fileWithBeforeText("checked.md");
    const conversation = await makeAgent(test, ["orchestrator"]);
    test.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: shellWrite(path) }), fauxToolCall("report_check", { path })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("await_orders", { note: "checked" })], { stopReason: "toolUse" }),
    ]);
    const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
    await submission.wait(CTX);

    const results = await toolResults(conversation);
    const checked = results.find((text) => text.includes("Tables:"));
    expect(checked).toBeDefined();
    // BEFORE holds a table without a delimiter row; AFTER holds one with it.
    expect(checked).toContain("Tables: 1 found, 0 without a delimiter row.");
  });
});
