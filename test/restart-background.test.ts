import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAsyncCall } from "../src/documents.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The restart gate in the background.
 *
 * `request_restart` runs the type check and the whole test suite, about two
 * minutes, so the root starts it with `async_call` and ends its turn. Two facts
 * make that safe, and both are under test here: the tool passes its own call's
 * signal to the gate it runs, and a cancelled call raises no request.
 *
 * The gate itself shells out to `tsc` and `vitest` in the workspace tree, and this
 * harness's workspace tree holds no dependencies. Both are replaced by a stand-in
 * that stops when its signal aborts, which is the contract the tool has to keep.
 */
const gate = vi.hoisted(() => ({
  calls: 0,
  signal: undefined as AbortSignal | undefined,
  stopped: false,
  /** When set, the gate answers at once with this output and a failed test run. */
  refusal: undefined as string | undefined,
}));

vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: (options: { signal?: AbortSignal }) => {
    gate.calls += 1;
    gate.signal = options.signal;
    if (gate.refusal !== undefined) return Promise.resolve({ typecheck: true, tests: false, output: gate.refusal });
    return new Promise((resolve) => {
      const stop = (): void => {
        gate.stopped = true;
        resolve({ typecheck: false, tests: false, output: "cancelled" });
      };
      if (options.signal?.aborted === true) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });
    });
  },
  collectChangeText: async () => ({ text: "" }),
}));

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("request_restart in the background", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    gate.refusal = undefined;
  });

  it("runs the gate as a background call, and a cancel stops the gate it is running", async () => {
    harness = await createTestHarness();
    const h = harness;
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, BACKGROUND_CONTEXT);

    // The approval the tool reads before it runs the gate. What it covers is not
    // under test here; `test/restart-approval-guard.test.ts` owns that check.
    const job = await h.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "work" });
    const report = await h.runtime.reports.create(BACKGROUND_CONTEXT, { jobId: job.id, title: "Plan", content: "one\n" });
    expect((await h.runtime.reports.approve(BACKGROUND_CONTEXT, report.id, 1, { via: "panel" })).ok).toBe(true);

    h.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("async_call", {
            title: "restart-gate",
            tool: "request_restart",
            args: { title: "batch", reportId: report.id },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("started it")]),
    ]);
    await (await conversation.submit({ type: "input", content: "check the batch" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    const toolResults = (await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items
      .filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) =>
        ((entry.model ?? []) as { content?: { type: string; text?: string }[] }[])
          .flatMap((message) => message.content ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n"),
      )
      .join("\n");
    // Accepted, not refused: the pair {self-edit, request_restart} carries the tag.
    expect(toolResults).toContain('started "restart-gate" (request_restart) in the background');

    // The call belongs to the conversation that asked for it, and it names the tool it runs.
    const record = await until(
      async () => await h.runtime.harness.snapshot(SecAsyncCall, conversation.id, "restart-gate", BACKGROUND_CONTEXT),
      "the background call record",
    );
    expect(record.tool).toBe("request_restart");
    expect(record.conversationId).toBe(String(conversation.id));

    // The gate is running, and it was given the call's own signal.
    await until(async () => (gate.calls === 1 && gate.signal !== undefined ? true : undefined), "the gate to start");
    expect(gate.signal?.aborted).toBe(false);

    h.faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("async_cancel", { title: "restart-gate" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("cancelled it")]),
    ]);
    await (await conversation.submit({ type: "input", content: "cancel it" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    await until(
      async () =>
        (await h.runtime.harness.snapshot(SecAsyncCall, conversation.id, "restart-gate", BACKGROUND_CONTEXT))?.status === "cancelled"
          ? true
          : undefined,
      "the call to settle as cancelled",
    );
    // The signal reached the gate: it stopped instead of running to its own end.
    expect(gate.stopped).toBe(true);
    // A gate that did not finish raises nothing.
    expect(h.runtime.restart.status.ready).not.toBe(true);
  }, 30000);

  /**
   * A refusal reaches the root as a background result, and the delivery path
   * keeps the whole of it. The gate keeps the head and the tail of a long
   * output itself (`test/validation.test.ts` owns that), and what it keeps has
   * to survive the envelope: the last line of a test run is its summary, so a
   * delivery that kept only the front would lose the one line that says how the
   * run ended.
   */
  it("delivers the tail of a long gate refusal as the background result", async () => {
    harness = await createTestHarness();
    const h = harness;
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, BACKGROUND_CONTEXT);

    const job = await h.runtime.jobs.create(BACKGROUND_CONTEXT, { title: "work" });
    const report = await h.runtime.reports.create(BACKGROUND_CONTEXT, { jobId: job.id, title: "Plan", content: "one\n" });
    expect((await h.runtime.reports.approve(BACKGROUND_CONTEXT, report.id, 1, { via: "panel" })).ok).toBe(true);

    // About 8,000 characters, the most the gate keeps: the passing tests first,
    // one failed test and the run's summary last.
    const passing = Array.from({ length: 130 }, (_, n) => `✓ test/some.test.ts > passing test ${n} (3 ms)`);
    const LAST_LINE = "Tests  1 failed | 2623 passed (2624)";
    gate.refusal = [
      ...passing,
      "… 12000 characters omitted …",
      "FAIL  test/x.test.ts > suite > broken test",
      LAST_LINE,
    ].join("\n");
    expect(gate.refusal.length).toBeGreaterThan(5000);

    h.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("async_call", {
            title: "restart-gate",
            tool: "request_restart",
            args: { title: "batch", reportId: report.id },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("started it")]),
    ]);
    await (await conversation.submit({ type: "input", content: "check the batch" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

    await until(
      async () =>
        (await h.runtime.harness.snapshot(SecAsyncCall, conversation.id, "restart-gate", BACKGROUND_CONTEXT))?.status === "failed"
          ? true
          : undefined,
      "the call to settle as failed",
    );

    // The refusal arrives as a tool-output envelope in a user turn, which is the
    // shape the root reads.
    const delivered = (await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT)).items
      .filter((entry) => entry.kind === "pi.user")
      .flatMap((entry) => (entry.model ?? []) as { content?: unknown }[])
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(delivered).toContain('src="tool-output"');
    expect(delivered).toContain("the gate refused the change");
    expect(delivered).toContain(LAST_LINE);
    // Nothing was raised: a gate that refused asks the user for nothing.
    expect(h.runtime.restart.status.ready).not.toBe(true);
  }, 30000);
});
