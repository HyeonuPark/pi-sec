import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { sendAndWait } from "../src/cli.ts";
import { defaultConfig } from "../src/config/schema.ts";
import type { StartedServer } from "../src/server/server.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

/**
 * `pi-sec send` prints the answer to its own message.
 *
 * The answer comes from the message's submission record, which names the final
 * assistant entry of the run. The transcript holds more than that: text the run
 * wrote beside a tool call, and answers to other inputs.
 */

describe("pi-sec send", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  /** The real routes over a test runtime, wired as test/root-prepare.test.ts wires them. */
  async function boot(responses: ReturnType<typeof fauxAssistantMessage>[]): Promise<string> {
    harness = await createTestHarness({
      responses,
      config: { server: { ...defaultConfig().server, port: 0 } },
    });
    started = await startTestServer(harness);
    return started.origin;
  }

  /** A fetch that answers from a script and records every URL it was asked for. */
  function scripted(answers: readonly (() => Response)[]): { io: { fetch: typeof fetch; sleep: () => Promise<void> }; urls: string[] } {
    const urls: string[] = [];
    let at = 0;
    const fake = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const make = answers[Math.min(at, answers.length - 1)]!;
      at += 1;
      return make();
    }) as typeof fetch;
    return { io: { fetch: fake, sleep: async () => undefined }, urls };
  }

  const accepted = (extra: Record<string, unknown> = {}): Response =>
    new Response(JSON.stringify({ conversationId: 1, submissionId: 5, status: "accepted", ...extra }), { status: 202 });
  const record = (body: Record<string, unknown>): Response => new Response(JSON.stringify(body), { status: 200 });

  it("prints the final answer of its own message, not a message the run wrote beside a tool call", async () => {
    const origin = await boot([
      fauxAssistantMessage([fauxText("INTERIM"), fauxToolCall("secrets_list", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("FINAL"),
    ]);
    expect(await sendAndWait(origin, "hello", 10_000)).toBe("FINAL");
  }, 20_000);

  it("waits for its own submission when another answer arrives first", async () => {
    const mine = { status: "done", reason: null, answerEntry: { kind: "pi.assistant", model: [{ content: [{ type: "text", text: "MINE" }] }] } };
    const { io, urls } = scripted([
      () => accepted(),
      () => record({ status: "placed", reason: null, answerEntry: null }),
      () => record(mine),
    ]);
    expect(await sendAndWait("http://daemon", "hello", 10_000, io)).toBe("MINE");
    expect(urls).toEqual([
      "http://daemon/basic-chat/messages",
      "http://daemon/api/conversations/1/submissions/5",
      "http://daemon/api/conversations/1/submissions/5",
    ]);
  });

  it("says at once that a held conversation will answer later", async () => {
    const { io, urls } = scripted([() => accepted({ held: true })]);
    await expect(sendAndWait("http://daemon", "hello", 10_000, io)).rejects.toThrow("waits for its provider");
    expect(urls).toHaveLength(1);
  });

  it("reports an unanswered input with its reason", async () => {
    const { io } = scripted([() => accepted(), () => record({ status: "unanswered", reason: "model_error", answerEntry: null })]);
    await expect(sendAndWait("http://daemon", "hello", 10_000, io)).rejects.toThrow("model_error");
  });

  it("answers 404 for a submission of another conversation", async () => {
    const origin = await boot([fauxAssistantMessage("FINAL")]);
    const post = await fetch(`${origin}/basic-chat/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const { conversationId, submissionId } = (await post.json()) as { conversationId: number; submissionId: number };
    const created = (await (await fetch(`${origin}/api/conversations`, { method: "POST" })).json()) as { id: number };

    expect((await fetch(`${origin}/api/conversations/${created.id}/submissions/${submissionId}`)).status).toBe(404);
    expect((await fetch(`${origin}/api/conversations/${conversationId}/submissions/999999`)).status).toBe(404);
    expect((await fetch(`${origin}/api/conversations/${conversationId}/submissions/abc`)).status).toBe(400);
    const own = await fetch(`${origin}/api/conversations/${conversationId}/submissions/${submissionId}`);
    expect(own.status).toBe(200);
  }, 20_000);
});
