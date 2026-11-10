import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

/** The execution api the harness would hand a tool: an id and a real commit. */
function execApi(h: TestHarness): ToolExecutionApi {
  return {
    conversationId: 1,
    commit: (change: (tx: never) => unknown, context: Context) =>
      h.runtime.harness.commit(change as never, context),
  } as unknown as ToolExecutionApi;
}

describe("self_edit", () => {
  let harness: TestHarness | undefined;
  const outsideDirs: string[] = [];

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    for (const dir of outsideDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<TestHarness> {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.runtime.getConfig(), harness.runtime.paths, ctx);
    return harness;
  }

  function editTool(h: TestHarness): ToolRegistration {
    const runtime = h.runtime;
    const context = {
      getConfig: runtime.getConfig,
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "self_edit");
    if (tool === undefined) throw new Error("self_edit is not registered");
    return tool;
  }

  async function edit(h: TestHarness, args: Record<string, unknown>) {
    const result = (await editTool(h).execute({ title: "t", ...args } as never, execApi(h), ctx)) as {
      output: { text?: string }[];
      isError?: boolean;
    };
    return { text: result.output.map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
  }

  async function outsideDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-outside-"));
    outsideDirs.push(dir);
    return dir;
  }

  it("raises the restart need when kind is left out", async () => {
    const h = await boot();
    expect(h.runtime.restart.status.required).toBe(false);
    const answer = await edit(h, { path: "src/x.ts", content: "export {};\n" });
    expect(answer.isError).toBe(false);
    expect(h.runtime.restart.status.required).toBe(true);
    const audit = await readAuditTail(h.runtime.paths.auditLog, undefined, 50);
    expect(audit.find((event) => event.type === "self_edit")).toMatchObject({ kind: "core-change" });
  });

  it("refuses a write through a link that leaves the workspace tree", async () => {
    const h = await boot();
    const outside = await outsideDir();
    await symlink(outside, join(h.paths.workspaceTree, "link"));
    const answer = await edit(h, { path: "link/file.ts", content: "export {};\n" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("escapes the workspace tree");
    await expect(stat(join(outside, "file.ts"))).rejects.toThrow();
  });

  it("refuses a patch of a file link that points outside", async () => {
    const h = await boot();
    const outside = await outsideDir();
    await writeFile(join(outside, "target.ts"), "old text\n", "utf8");
    await symlink(join(outside, "target.ts"), join(h.paths.workspaceTree, "file-link.ts"));
    const answer = await edit(h, { path: "file-link.ts", oldText: "old", newText: "new" });
    expect(answer.isError).toBe(true);
    expect(await readFile(join(outside, "target.ts"), "utf8")).toBe("old text\n");
  });

  it("refuses a write through a dangling link that points outside", async () => {
    const h = await boot();
    const outside = await outsideDir();
    await symlink(join(outside, "not-yet.ts"), join(h.paths.workspaceTree, "dangling.ts"));
    const answer = await edit(h, { path: "dangling.ts", content: "export {};\n" });
    expect(answer.isError).toBe(true);
    await expect(stat(join(outside, "not-yet.ts"))).rejects.toThrow();
  });

  it("writes through a link that stays inside the tree", async () => {
    const h = await boot();
    await mkdir(join(h.paths.workspaceTree, "real"), { recursive: true });
    await symlink(join(h.paths.workspaceTree, "real"), join(h.paths.workspaceTree, "inner"));
    const answer = await edit(h, { path: "inner/file.ts", content: "export {};\n" });
    expect(answer.isError).toBe(false);
    expect(await readFile(join(h.paths.workspaceTree, "real", "file.ts"), "utf8")).toBe("export {};\n");
  });

  it("creates a file in a new directory", async () => {
    const h = await boot();
    const answer = await edit(h, { path: "fresh/dir/file.ts", content: "export {};\n" });
    expect(answer.isError).toBe(false);
    expect(await readFile(join(h.paths.workspaceTree, "fresh", "dir", "file.ts"), "utf8")).toBe("export {};\n");
  });
});
