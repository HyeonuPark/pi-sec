import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodingExtension } from "../src/extensions/coding.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import {
  refusesUserRecord,
  touchesUserRecord,
  USER_RECORD_DIRECTORY,
  USER_RECORD_FILE,
  type RecordTool,
} from "../src/extensions/user-record-guard.ts";

/**
 * The guard on the record of the user's own facts: which paths it covers, which
 * scope may open them with which tool, and the refusal a caller sees through the
 * `coding` extension's wrappers.
 *
 * The scope is read from the subagent hub, and a test harness without one reports
 * `root` for conversation 1 and `other` for every other conversation. That is
 * enough for the two ends of the rule: the owner reaches the record, and a
 * subagent does not. The focused allowance is covered by the decision table.
 */

const MEMORY = mkdtempSync(join(tmpdir(), "user-record-guard-"));
writeFileSync(join(MEMORY, USER_RECORD_FILE), "# test record\n");
writeFileSync(join(MEMORY, "pi-sec-notes.md"), "# test notes\n");

afterAll(() => rmSync(MEMORY, { recursive: true, force: true }));

describe("touchesUserRecord", () => {
  it("covers the record and its split directory", () => {
    expect(touchesUserRecord(`${MEMORY}/${USER_RECORD_FILE}`, MEMORY)).toBe(true);
    expect(touchesUserRecord(`${MEMORY}/${USER_RECORD_DIRECTORY}/devices.md`, MEMORY)).toBe(true);
  });

  it("covers a path by name, wherever it resolves", () => {
    expect(touchesUserRecord(USER_RECORD_FILE, MEMORY)).toBe(true);
    expect(touchesUserRecord(`memory/${USER_RECORD_FILE}`, MEMORY)).toBe(true);
    expect(touchesUserRecord(`/tmp/x/${USER_RECORD_FILE}`, MEMORY)).toBe(true);
  });

  it("leaves the other memory files alone", () => {
    expect(touchesUserRecord(`${MEMORY}/operator-preferences.md`, MEMORY)).toBe(false);
    expect(touchesUserRecord(`${MEMORY}/pi-sec-notes.md`, MEMORY)).toBe(false);
    expect(touchesUserRecord(`${MEMORY}/${USER_RECORD_DIRECTORY}-old.md`, MEMORY)).toBe(false);
  });
});

describe("refusesUserRecord", () => {
  const cases: readonly [string, RecordTool, boolean][] = [
    ["root", "read", false],
    ["root", "read_full", false],
    ["root", "write", false],
    ["root", "edit", false],
    ["focused", "read", false],
    ["focused", "read_full", false],
    ["focused", "write", true],
    ["focused", "edit", true],
    ["orchestrator", "read", true],
    ["planner", "read", true],
    ["other", "read", true],
    ["other", "write", true],
  ];

  it("lets the root through, and a focused chat read only", () => {
    for (const [scope, tool, refused] of cases) {
      expect(refusesUserRecord(scope as never, tool), `${scope} ${tool}`).toBe(refused);
    }
  });
});

describe("the guard on the coding tools", () => {
  /** One coding tool with the extension's wrappers applied, as the harness applies them. */
  function codingTool(name: string): ToolRegistration {
    const extension = createCodingExtension({
      paths: { memoryDir: MEMORY },
    } as unknown as ExtensionContext);
    let tool = (CodingTools.tools ?? []).find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    for (const wrap of extension.wraps ?? []) {
      if ("tool" in wrap && wrap.tool === name) tool = wrap.wrap(tool);
    }
    return tool;
  }

  function apiFor(conversationId: number): ToolExecutionApi {
    const env = new NodeExecutionEnv({ cwd: "/tmp" });
    return {
      env,
      callId: "call-1",
      conversationId,
      taskId: 1,
      outputWindow: undefined,
      output: () => undefined,
      diagnostic: () => undefined,
      details: async () => undefined,
    } as unknown as ToolExecutionApi;
  }

  const ctx = BACKGROUND_CONTEXT as Context;
  const record = `${MEMORY}/${USER_RECORD_FILE}`;

  it("refuses a read of the record from a conversation that is not the root", async () => {
    const result = await codingTool("read").execute({ path: record }, apiFor(7), ctx);
    expect(result.isError).toBe(true);
    // The harness reads a tool result from `output`. A refusal in `content` reaches the
    // model as an empty error result, so the sentence is pinned in `output`.
    expect(JSON.stringify((result as { output?: unknown }).output)).toContain("Ask the root for the fact that this work needs.");
  });

  it("lets the root read the record", async () => {
    const result = await codingTool("read").execute({ path: record }, apiFor(1), ctx);
    expect(result.isError).toBeFalsy();
  });

  it("refuses a write of the record from a conversation that is not the root", async () => {
    const result = await codingTool("write").execute({ path: record, content: "x" }, apiFor(7), ctx);
    expect(result.isError).toBe(true);
  });

  it("leaves another memory file open", async () => {
    const result = await codingTool("read").execute({ path: `${MEMORY}/pi-sec-notes.md` }, apiFor(7), ctx);
    expect(result.isError).toBeFalsy();
  });
});
