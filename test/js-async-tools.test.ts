import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { parseAsyncOutput } from "../src/async-output.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAsyncCall } from "../src/documents.ts";
import { ToolTagCatalog } from "../src/extensions/tool-tags.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

interface Row {
  readonly kind: string;
  readonly text: string;
}

function rows(entries: readonly { kind: string; model?: unknown[] }[]): Row[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    text: (entry.model ?? [])
      .map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((part) => (part !== null && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
          .join("");
      })
      .join("\n"),
  }));
}

async function run(harness: TestHarness, content: string): Promise<{ conversation: Conversation; entries: Row[] }> {
  const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
  const submission = await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return { conversation, entries: rows(page.items) };
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function toolResult(entries: readonly Row[]): string {
  return entries
    .filter((row) => row.kind === "pi.tool-result")
    .map((row) => row.text)
    .join("\n");
}

describe("complex tool tags", () => {
  it("reads the built-in pair, never the bare name", () => {
    const config = defaultConfig();
    const catalog = new ToolTagCatalog(() => config);
    expect(catalog.isComplex("coding", "bash")).toBe(true);
    expect(catalog.isComplex("js-tools", "js")).toBe(true);
    expect(catalog.isComplex("subagents", "request_message")).toBe(true);
    // The restart gate takes about two minutes and kills its commands on cancel.
    expect(catalog.isComplex("self-edit", "request_restart")).toBe(true);
    // Another extension with a tool of the same name inherits nothing.
    expect(catalog.isComplex("my-tools", "bash")).toBe(false);
    expect(catalog.isComplex("coding", "read")).toBe(false);
  });

  it("takes an extension's own declaration, replacing it on reload", () => {
    const config = defaultConfig();
    const catalog = new ToolTagCatalog(() => config);
    expect(catalog.declare("my-tools", { slow_one: { complex: true } })).toEqual([]);
    expect(catalog.isComplex("my-tools", "slow_one")).toBe(true);
    // A reload that drops the declaration drops the tag with it.
    catalog.declare("my-tools", undefined);
    expect(catalog.isComplex("my-tools", "slow_one")).toBe(false);
    // Unreadable entries are reported, not swallowed.
    expect(catalog.declare("bad", { thing: 5 })).toEqual(["thing"]);
  });

  it("lets the operator add and remove by name", () => {
    const config = defaultConfig();
    const catalog = new ToolTagCatalog(() => config);
    config.agent.tools.complex.add = ["fetch_url"];
    expect(catalog.isComplex("web", "fetch_url")).toBe(true);
    config.agent.tools.complex.remove = ["bash"];
    expect(catalog.isComplex("coding", "bash")).toBe(false);
  });
});

describe("js tool", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("runs a script, calls another tool, and returns the value", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("js", {
              code: 'const names = await tools.secrets_list({}); const d = await describe("secrets_list"); return `nested:${names}|${d.name}|${2 + 2}`;',
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const { entries } = await run(harness, "run a script");
    expect(toolResult(entries)).toContain("nested:(none)|secrets_list|4");
    expect(toolResult(entries)).toContain("deadline: none");
  });

  it("stops a spinning script when a deadline is given", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage([fauxToolCall("js", { code: "while (true) {}", timeoutMs: 300 })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const { entries } = await run(harness, "spin with a deadline");
    expect(toolResult(entries)).toContain("Script stopped");
    expect(toolResult(entries)).toContain("deadline: 300ms");
  });

  it("refuses an empty script and a non-positive deadline", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage([fauxToolCall("js", { code: "   " })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("js", { code: "return 1;", timeoutMs: 0 })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const { entries } = await run(harness, "bad inputs");
    expect(toolResult(entries)).toContain("code is empty");
    expect(toolResult(entries)).toContain("timeoutMs must be a positive number");
  });
});

describe("background calls", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("runs a complex tool in the background and delivers the result as user input", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage([fauxToolCall("async_call", { title: "greet", tool: "bash", args: { command: "echo hi" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("started")]),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
    const submitted = await conversation.submit({ type: "input", content: "start it" }, BACKGROUND_CONTEXT);
    await submitted.wait(BACKGROUND_CONTEXT);
    expect(toolResult(rows((await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items))).toContain('started "greet"');

    const delivered = await until(async () => {
      const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
      const found = rows(page.items).find((row) => parseAsyncOutput(row.text)?.title === "greet");
      return found === undefined ? undefined : parseAsyncOutput(found.text)!;
    }, "the background result");
    expect(delivered.tool).toBe("bash");
    expect(delivered.status).toBe("done");
    expect(delivered.body).toContain("hi");

    const record = await harness.runtime.harness.snapshot(SecAsyncCall, conversation.id, "greet", BACKGROUND_CONTEXT);
    expect(record?.status).toBe("done");
    expect(record?.deliveredAt).toBeTypeOf("number");
  });

  it("refuses a repeated title and a tool without the complex tag", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage([fauxToolCall("async_call", { title: "dup", tool: "bash", args: { command: "true" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("async_call", { title: "dup", tool: "bash", args: { command: "true" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("async_call", { title: "plain", tool: "read", args: { path: "x" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    const { entries } = await run(harness, "two calls");
    expect(toolResult(entries)).toContain("is not tagged complex");
    expect(toolResult(entries)).toContain('the title "dup" is already used');
  });

  it("cancels one call and reports the work it left behind", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage([fauxToolCall("async_call", { title: "long", tool: "bash", args: { command: "sleep 30" } })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("async_cancel", { title: "long" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("background_list", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
    const submitted = await conversation.submit({ type: "input", content: "start and cancel" }, BACKGROUND_CONTEXT);
    await submitted.wait(BACKGROUND_CONTEXT);

    const listed = toolResult(rows((await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items));
    expect(listed).toContain('kind="async_tool_call"');
    expect(listed).toContain('title="long"');

    const record = await until(async () => {
      const found = await harness!.runtime.harness.snapshot(SecAsyncCall, conversation.id, "long", BACKGROUND_CONTEXT);
      return found?.status === "cancelled" ? found : undefined;
    }, "the cancelled record");
    expect(record.status).toBe("cancelled");

    const delivered = await until(async () => {
      const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
      const found = rows(page.items).find((row) => parseAsyncOutput(row.text)?.status === "cancelled");
      return found === undefined ? undefined : parseAsyncOutput(found.text)!;
    }, "the cancellation notice");
    expect(delivered.body).toContain("not undone");
  });
});
