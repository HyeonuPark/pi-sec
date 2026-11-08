import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `read_full` is a bundled extension that the default enabled list does not
 * name, so these tests turn it on by name and drive it as the model does: a
 * tool call in a live turn, and the tool result the harness stored.
 *
 * The size cap is `readFull.maxBytes`, and it is read on every call. The second
 * property is what an operator changing the key on a running runtime needs, so
 * one test lowers the value after the first call and calls again.
 */

/** The default enabled list plus `read-full`. */
function enabledConfig(overrides: Partial<Config> = {}): Partial<Config> {
  return {
    agent: { extensions: { enabled: [...defaultConfig().agent.extensions.enabled, "read-full"] } },
    ...overrides,
  } as Partial<Config>;
}

/** The text of the newest tool result of a conversation. */
async function runReadFull(harness: TestHarness, path: string): Promise<string> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_full", { path })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "read it" }, BACKGROUND_CONTEXT);
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

  // Entries read newest first, so the first tool result in the page is the call above.
  const page = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const result = page.items.find((entry) => entry.kind === "pi.tool-result");
  if (result === undefined) throw new Error("the read_full call wrote no tool result");
  return (result.model ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content
        .filter(
          (part): part is { type: string; text: string } =>
            part !== null && typeof part === "object" && (part as { type?: string }).type === "text",
        )
        .map((part) => part.text);
    })
    .join("\n");
}

describe("read_full", () => {
  let harness: TestHarness | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  async function file(name: string, content: string): Promise<string> {
    if (scratch === undefined) scratch = await mkdtemp(join(tmpdir(), "pi-sec-read-full-"));
    const path = join(scratch, name);
    await writeFile(path, content, "utf8");
    return path;
  }

  it("is not installed, and offers no tool, unless the enabled list names it", async () => {
    harness = await createTestHarness();
    const snapshot = harness.runtime.registry.snapshot();

    expect(snapshot.extension("read-full")).toBeUndefined();
    expect(snapshot.tools().some((entry) => entry.tool.name === "read_full")).toBe(false);
  });

  it("returns one whole text file in a single call", async () => {
    const content = "line one\nline two\n  indented\n";
    const path = await file("whole.txt", content);
    harness = await createTestHarness({ config: enabledConfig() });

    expect(harness.runtime.registry.snapshot().extension("read-full")).toBeDefined();
    expect(await runReadFull(harness, path)).toBe(content);
  });

  it("refuses a file above readFull.maxBytes instead of cutting it", async () => {
    const path = await file("large.txt", "x".repeat(64));
    harness = await createTestHarness({ config: enabledConfig({ readFull: { maxBytes: 32 } }) });

    const result = await runReadFull(harness, path);

    expect(result).toContain(`over the 32B (32 bytes) size cap of read_full`);
    expect(result).toContain("so it was refused and not cut");
    expect(result).toContain("64B (64 bytes)");
  });

  it("refuses a path that is a directory, and names why it could not be read", async () => {
    harness = await createTestHarness({ config: enabledConfig() });
    const directory = harness.paths.workspaceTree;

    const result = await runReadFull(harness, directory);

    // The environment refuses the open, so the refusal is the open's message.
    expect(result).toContain(`read_full cannot open ${directory}`);
  });

  it("reads the cap on every call, so a changed value is enforced next", async () => {
    const path = await file("cap.txt", "y".repeat(64));
    harness = await createTestHarness({ config: enabledConfig({ readFull: { maxBytes: 1024 } }) });

    expect(await runReadFull(harness, path)).toBe("y".repeat(64));

    const current = harness.runtime.getConfig();
    harness.runtime.setConfig({ ...current, readFull: { maxBytes: 16 } });

    expect(await runReadFull(harness, path)).toContain("size cap of read_full");
  });

  it("defaults the cap to 256 KiB", () => {
    expect(defaultConfig().readFull.maxBytes).toBe(262144);
  });
});
