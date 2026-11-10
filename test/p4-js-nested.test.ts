import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * P4 measurements for the `js` tool's nested calls.
 *
 * The follow-up item claimed a hole where a tool called from inside the sandbox
 * calls `js` again, or where overlapping tool calls corrupt state. These tests
 * record what the code actually does, so the claim can be judged from evidence
 * rather than from the shape of the code.
 *
 * Read the assertions as measurements of the current behaviour, not as promises:
 * the `async_call` case below pins a path that is open today.
 *
 * No test here separates parallel from sequential execution by wall clock. The
 * overlap test uses a rendezvous instead: each nested call writes its own marker
 * and then waits for the other's, so a sequential runner can only give up and
 * report `:alone`, whatever the machine's load. The abandoned-call test reads the
 * call status the sandbox records (`cancelled`, never `ok`), which needs no
 * clock either.
 */

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runScript(harness: TestHarness, code: string, timeoutMs?: number): Promise<string> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("js", timeoutMs === undefined ? { code } : { code, timeoutMs })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
  const submission = await conversation.submit({ type: "input", content: "measure" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  return page.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) =>
      (entry.model ?? [])
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
        .join("\n"),
    )
    .join("\n");
}

describe("P4: js nested calls", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("keeps js out of the script namespace by name", async () => {
    harness = await createTestHarness({});
    const result = await runScript(
      harness,
      `
      const out = {};
      try { out.property = "no throw: " + typeof tools.js; } catch (e) { out.property = "throw: " + e.message; }
      try { out.invoke = "no throw: " + JSON.stringify(await invoke("js", { code: "return 1" })); } catch (e) { out.invoke = "throw: " + e.message; }
      try { out.unknown = "no throw: " + (await tools.no_such_tool({})); } catch (e) { out.unknown = "throw: " + e.message; }
      out.allTools = ALL_TOOLS.filter((t) => t.name === "js").length;
      return JSON.stringify(out);
      `,
    );
    // Both property access and invoke() refuse it, and ALL_TOOLS never lists it.
    expect(result).toContain('"property":"throw: tools.js does not exist');
    expect(result).toContain('"invoke":"throw: unknown tool: js"');
    expect(result).toContain('"allTools":0');
    expect(result).toContain('"unknown":"throw: tools.no_such_tool does not exist');
  });

  it("runs two overlapping nested calls at once and keeps their output apart", async () => {
    harness = await createTestHarness({});
    const gate = await mkdtemp(join(tmpdir(), "p4-rendezvous-"));
    const one = join(gate, "one");
    const two = join(gate, "two");
    // Each call writes its marker and then waits for the other's. Both calls can
    // only report ":met" if they are in flight at the same time: a runner that
    // runs them one after another makes the first wait for a marker the second
    // writes only after the first has given up, so it reports ":alone" and the
    // test fails on content rather than on a clock. The give-up window is three
    // seconds, which is far above the few milliseconds the other call needs to
    // start, and below this test's five second limit, so the sequential case
    // still ends by itself and reports what it saw.
    const wait = (mine: string, theirs: string, label: string): string =>
      `touch ${mine}; for i in $(seq 1 30); do [ -f ${theirs} ] && break; sleep 0.1; done; if [ -f ${theirs} ]; then echo ${label}:met; else echo ${label}:alone; fi`;
    try {
      const result = await runScript(
        harness,
        `
      const [a, b] = await Promise.all([
        tools.bash({ command: ${JSON.stringify(wait(one, two, "A"))} }),
        tools.bash({ command: ${JSON.stringify(wait(two, one, "B"))} }),
      ]);
      return JSON.stringify({ a: a.trim(), b: b.trim() });
      `,
        20_000,
      );
      const parsed = JSON.parse(result.slice(result.indexOf("{"), result.indexOf("}") + 1)) as { a: string; b: string };
      // Neither call gave up waiting, so each saw the other's marker: they ran at
      // the same time. Outputs are still routed to their own call.
      expect(parsed.a).toBe("A:met");
      expect(parsed.b).toBe("B:met");
      // Both calls are reported on the js call's own diagnostics line.
      expect(result.match(/bash: ok/g)?.length).toBe(2);
    } finally {
      await rm(gate, { recursive: true, force: true });
    }
  });

  it("holds the tool call limit while calls overlap", async () => {
    harness = await createTestHarness({
      config: {
        agent: {
          tools: {
            js: { enabled: true, timeoutMs: null, memoryLimitBytes: 268435456, maxResultBytes: 102400, maxResultLines: 2000, maxToolCalls: 2 },
          },
        },
      },
    });
    const result = await runScript(
      harness,
      `
      const settled = await Promise.allSettled([
        tools.bash({ command: "echo one" }),
        tools.bash({ command: "echo two" }),
        tools.bash({ command: "echo three" }),
      ]);
      return JSON.stringify(settled.map((each) => (each.status === "fulfilled" ? "ok:" + each.value.trim() : "err:" + String(each.reason))));
      `,
    );
    // The counter is taken before the call runs, so overlap cannot smuggle a
    // third call past a limit of two.
    expect(result).toContain('["ok:one","ok:two","err:Error: script exceeded its tool call limit (2)"]');
  });

  it("cancels an unawaited nested call when the script settles", async () => {
    harness = await createTestHarness({});
    const result = await runScript(harness, `tools.bash({ command: "sleep 5; echo LATE" }); return "returned";`);
    // The script returns without waiting for the call it left behind. The status
    // the sandbox records for that call is the evidence: a call still pending when
    // the script settles is `cancelled`, and a call the script had waited for
    // would have finished and been recorded as `ok` instead.
    expect(result).toContain("returned");
    expect(result).toContain("bash: cancelled");
    expect(result).not.toContain("bash: ok");
  });

  it("reaches the js tool again through async_call from inside a script", async () => {
    harness = await createTestHarness({});
    const result = await runScript(harness, `return String(await tools.async_call({ title: "reenter", tool: "js", args: { code: "return 6*7" } }));`);
    // The name filter closes the direct path only. `js` carries the complex tag,
    // so `async_call` accepts it, and a background js call starts from a script.
    expect(result).toContain('started "reenter" (js) in the background');
  });

  it("marks a nested call with the js: callId prefix that await_orders refuses", async () => {
    harness = await createTestHarness({});
    const result = await runScript(
      harness,
      `try { return "no throw: " + (await tools.await_orders({ note: "measured" })); } catch (e) { return "throw: " + e.message; }`,
    );
    // src/extensions/subagents.ts refuses a nested call by testing the callId
    // prefix, so the shape of the id made here is a contract with that file.
    expect(result).toContain("throw: await_orders must run on its own, not through async_call or js:");
  });

  it("cancels a background js call whose two nested calls are both in flight", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall(
              "async_call",
              {
                title: "cancellable",
                tool: "js",
                args: {
                  code: 'const both = await Promise.all([tools.bash({ command: "sleep 30; echo A" }), tools.bash({ command: "sleep 30; echo B" })]); return both.join("|");',
                },
              },
              { id: "start" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("async_cancel", { title: "cancellable" }, { id: "cancel" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("background_list", {}, { id: "list" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
    const submission = await conversation.submit({ type: "input", content: "start and cancel" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const text = await until(async () => {
      const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
      const body = page.items.map((entry) => JSON.stringify(entry.model)).join("\n");
      return body.includes("cancelled") ? body : undefined;
    }, "the cancellation, the delivered result and background_list");
    // The delivered result and the list both settle on "cancelled".
    expect(text).toContain('title=\\"cancellable\\"');
    expect(text).toContain('status=\\"cancelled\\"');
    // Nothing of the script or its two nested calls is left running.
    expect(text).not.toContain('status=\\"running\\"');
  });

  it("runs two js calls of one round at once without crossing their results", async () => {
    harness = await createTestHarness({
      responses: [
        fauxAssistantMessage(
          [
            fauxToolCall("js", { code: `const a = await tools.bash({ command: "sleep 0.5; echo one" }); return "first:" + a.trim();` }, { id: "js-1" }),
            fauxToolCall("js", { code: `const b = await tools.bash({ command: "sleep 0.5; echo two" }); return "second:" + b.trim();` }, { id: "js-2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const conversation: Conversation = await resolveDefaultConversation(
      harness.runtime.harness,
      harness.config,
      harness.runtime.paths,
      BACKGROUND_CONTEXT,
    );
    const submission = await conversation.submit({ type: "input", content: "two scripts" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    const text = page.items
      .filter((entry) => entry.kind === "pi.tool-result")
      .map((entry) => JSON.stringify(entry.model))
      .join("\n");
    expect(text).toContain("first:one");
    expect(text).toContain("second:two");
  });
});
