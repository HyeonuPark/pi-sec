import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The `js` tool's result caps are config keys with a reader.
 *
 * `agent.tools.js.maxResultBytes` and `maxResultLines` were declared in the
 * schema, defaulted, and read by nothing: the tool carried the same numbers as a
 * literal in its registration, so an operator who set either key changed
 * nothing. These tests pin the two properties that fix it — the cap follows the
 * config, and it is read at call time, not when the extension was registered.
 *
 * The second property is what a reload needs. Each test lowers the value on one
 * running runtime and runs the same script again: a registration-time copy could
 * not move, however the config changed afterwards.
 */

const JS_KEYS = defaultConfig().agent.tools.js;

/** The js keys, with the ones a test moves replaced. */
function jsConfig(changes: Partial<typeof JS_KEYS>): Config["agent"]["tools"]["js"] {
  return { ...JS_KEYS, ...changes };
}

/** Submit one `js` call on the harness's default conversation and return the newest tool result's text. */
async function runScript(harness: TestHarness, code: string): Promise<string> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("js", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "measure" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  // Entries read newest first by default, so the first tool result in the page is
  // the call made above. The content ends with the rendered diagnostics, which is
  // where the harness reports what it dropped.
  const page = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const result = page.items.find((entry) => entry.kind === "pi.tool-result");
  if (result === undefined) throw new Error("the js call wrote no tool result");
  return (result.model ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content
        .filter((part): part is { type: string; text: string } => part !== null && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => part.text);
    })
    .join("\n");
}

/** Replace the runtime's config with one whose js keys are `js`. */
function setJsConfig(harness: TestHarness, js: Config["agent"]["tools"]["js"]): void {
  const current = harness.runtime.getConfig();
  harness.runtime.setConfig({
    ...current,
    agent: { ...current.agent, tools: { ...current.agent.tools, js } },
  });
}

describe("js tool result limits", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("takes maxResultLines from the config on every call", async () => {
    harness = await createTestHarness({});
    const code = `return ["L1", "L2", "L3", "L4", "L5", "L6"].join("\\n");`;

    const first = await runScript(harness, code);
    expect(first).toContain("L6");
    expect(first).not.toContain("Output truncated");

    setJsConfig(harness, jsConfig({ maxResultLines: 3 }));
    const second = await runScript(harness, code);
    // The head is kept, so the cut shows as the lines past the third going
    // missing, with the harness saying how many were dropped.
    expect(second).toContain("L1\nL2\nL3");
    expect(second).not.toContain("L4");
    expect(second).toContain("Output truncated to its beginning");

    setJsConfig(harness, jsConfig({ maxResultLines: 2 }));
    const third = await runScript(harness, code);
    // A second, different value on the same running extension: what a call sees
    // is the config at that call, not the one the extension started with.
    expect(third).toContain("L1\nL2");
    expect(third).not.toContain("L3");
  });

  it("takes maxResultBytes from the config on every call", async () => {
    harness = await createTestHarness({});
    const code = `return "abcdefghijklmnop";`;

    const first = await runScript(harness, code);
    expect(first).toContain("abcdefghijklmnop");
    expect(first).not.toContain("Output truncated");

    setJsConfig(harness, jsConfig({ maxResultBytes: 10 }));
    const second = await runScript(harness, code);
    expect(second).toContain("abcdefghij");
    expect(second).not.toContain("abcdefghijk");
    expect(second).toContain("Output truncated to its beginning");

    setJsConfig(harness, jsConfig({ maxResultBytes: 6 }));
    const third = await runScript(harness, code);
    expect(third).toContain("abcdef");
    expect(third).not.toContain("abcdefg");
  });

  it("takes maxToolCalls from the config on every call", async () => {
    harness = await createTestHarness({});
    const code = `
      const settled = await Promise.allSettled([
        tools.bash({ command: "echo one" }),
        tools.bash({ command: "echo two" }),
        tools.bash({ command: "echo three" }),
      ]);
      return settled.map((each) => (each.status === "fulfilled" ? "ok" : String(each.reason))).join(" | ");
    `;

    const first = await runScript(harness, code);
    expect(first).toContain("ok | ok | ok");

    // The cap is what an operator raises for a long script. It has to reach a
    // running process too, or `agent.tools.js.maxToolCalls` is another key that
    // changes nothing until a restart.
    setJsConfig(harness, jsConfig({ maxToolCalls: 2 }));
    const second = await runScript(harness, code);
    expect(second).toContain("script exceeded its tool call limit (2)");
  });

  /*
   * The caps keep the head of a result, so a cap that keeps nothing, or a byte
   * cap that reads as a cut from the end, is a configuration mistake that would
   * show up as a quietly useless tool. Both are load errors instead.
   */
  it("refuses a result cap below one when the config loads", async () => {
    for (const key of ["maxResultBytes", "maxResultLines"] as const) {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-js-limits-"));
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ agent: { tools: { js: { ...JS_KEYS, [key]: 0 } } } }),
      );
      const failure = await loadConfig({ home, env: {} }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConfigError);
      // The issue list names the path, which is what tells the operator which key
      // to fix; the message only carries the file.
      expect((failure as ConfigError).issues.join("\n")).toContain(key);
    }
  });
});
