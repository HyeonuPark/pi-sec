import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The sentence `request_restart` returns when the gate passes.
 *
 * It used to tell the user to run `user-tools/update-and-restart`. That is one of
 * three ways to apply a change now, and the wrong one to name first: the button
 * in the web UI applies it under the systemd user unit and under
 * `user-tools/run`, and the script is what is left when neither is running. So
 * the sentence names the button first and keeps the script as the fallback.
 *
 * The gate itself is not under test here: it shells out to `tsc` and `vitest` in
 * the workspace tree, and this harness's workspace tree is an empty temporary
 * directory. The two commands are replaced, so the call reaches the sentence.
 */

vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: async () => ({ typecheck: true, tests: true }),
  collectChangeText: async () => ({ text: "diff --git a/src/x.ts b/src/x.ts\n" }),
}));

const ctx = BACKGROUND_CONTEXT;

describe("the gate-passed sentence", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: 1,
      commit: (change: (tx: never) => unknown, context: Context) => h.runtime.harness.commit(change as never, context),
    } as unknown as ToolExecutionApi;
  }

  /**
   * The tool over this harness, with no report store and no subagent hub.
   *
   * Both omissions are deliberate. No report store is no approval check
   * (`test/restart-approval-guard.test.ts` owns that), and no hub is no
   * safe-point wait (`test/restart-safe-point.test.ts` owns that), so this file
   * reads the sentence a passing call returns and nothing else.
   */
  function restartTool(h: TestHarness): ToolRegistration {
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
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  it("names the restart button first and the script as the fallback", async () => {
    harness = await createTestHarness();
    await resolveDefaultConversation(harness.runtime.harness, harness.runtime.getConfig(), harness.runtime.paths, ctx);
    const h = harness;

    const result = await restartTool(h).execute({ title: "batch" } as never, execApi(h), ctx);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      "Gate passed: typecheck, tests, and a secret scan of the change. Ask the user to restart the daemon: the restart button in the web UI works under the systemd user unit and under user-tools/run; otherwise the user stops the daemon, runs user-tools/update-and-restart, and starts it again (snapshot tree: " +
        h.paths.snapshotTree +
        ").",
    );
    // The request is raised: this is the passing path, not a refusal.
    expect(h.runtime.restart.status.required).toBe(true);
    expect(h.runtime.restart.status.ready).toBe(true);
  });
});
