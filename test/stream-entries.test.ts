import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryDraft,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { slimAgentEvent, slimEntries, slimEntry, slimSnapshot } from "../src/server/stream-entries.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { fullEntries } from "./stream-entries-fixture.ts";

const ctx = BACKGROUND_CONTEXT;

/** A deep copy, so a test can prove the input was not changed in place. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function entryOf(entries: readonly EntryRecord[], kind: string): EntryRecord {
  const found = entries.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`the fixture has no ${kind} entry`);
  return found;
}

function assistantEntries(entries: readonly EntryRecord[]): EntryRecord[] {
  return entries.filter((entry) => entry.kind === "pi.assistant");
}

describe("slimming one entry", () => {
  it("empties the model of a pi.system entry and keeps the entry itself", () => {
    const entries = fullEntries();
    const system = entryOf(entries, "pi.system");
    const slim = slimEntry(system);

    expect(slim.model).toEqual([]);
    expect(slim.id).toBe(system.id);
    expect(slim.kind).toBe("pi.system");
    // The prompt really was there, and it is still there in the entry we were given.
    expect(JSON.stringify(system)).toContain("A role rule.");
  });

  it("drops thinking, tool-call arguments and usage from an assistant message", () => {
    const entries = fullEntries();
    const [first] = assistantEntries(entries);
    const slim = slimEntry(first!);
    const message = slim.model?.[0] as Record<string, unknown>;
    const blocks = message["content"] as Record<string, unknown>[];

    expect(blocks.map((block) => block["type"])).toEqual(["text", "toolCall"]);
    expect(blocks[0]).toEqual({ type: "text", text: "I will read the file first." });
    expect(blocks[1]).toEqual({ type: "toolCall", id: "call-1", name: "read" });
    expect(message["usage"]).toBeUndefined();
    // Everything else on the message stays.
    expect(message["role"]).toBe("assistant");
    expect(message["api"]).toBe("anthropic-messages");
    expect(message["provider"]).toBe("anthropic");
    expect(message["model"]).toBe("claude-sonnet-4");
    expect(message["stopReason"]).toBe("toolUse");
    expect(message["timestamp"]).toBe(3_000);

    // Neither the thinking text nor its signature survives anywhere.
    const text = JSON.stringify(slim);
    expect(text).not.toContain("The parser reads to the last newline");
    expect(text).not.toContain("thinkingSignature");
    expect(text).not.toContain("arguments");
    expect(text).not.toContain("cacheRead");
  });

  it("drops details from a tool result and keeps its text", () => {
    const entries = fullEntries();
    const edit = entries.find((entry) => JSON.stringify(entry).includes("*** Begin Patch"))!;
    const slim = slimEntry(edit);
    const message = slim.model?.[0] as Record<string, unknown>;

    expect(message["details"]).toBeUndefined();
    expect(message["content"]).toEqual([{ type: "text", text: "edited /tmp/parser.ts (+1 -1)" }]);
    expect(message["toolCallId"]).toBe("call-2");
    expect(message["toolName"]).toBe("edit");
    expect(message["isError"]).toBe(false);
    expect(message["timestamp"]).toBe(6_000);
    // The rest of the entry, `data` included, is untouched.
    expect(slim.data).toEqual({ diagnostics: [] });
    expect(slim.kind).toBe("pi.tool-result");
  });

  it("leaves a user message and an entry with no model alone", () => {
    const entries = fullEntries();
    const user = entryOf(entries, "pi.user");
    expect(slimEntry(user)).toBe(user);

    const bare = { id: "x", conversationId: "1", kind: "pi.reset", data: { at: 1 } } as unknown as EntryRecord;
    expect(slimEntry(bare)).toBe(bare);
  });

  it("passes an unknown block and an unknown message role through as they are", () => {
    const entry = {
      id: "x",
      conversationId: "1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            { type: "somethingNew", payload: { keep: "me" } },
            { type: "thinking", thinking: "gone" },
          ],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        },
        { role: "somethingNew", content: "kept" },
      ],
    } as unknown as EntryRecord;
    const slim = slimEntry(entry);
    const [assistant, other] = slim.model!;

    expect((assistant as { content: unknown[] }).content).toEqual([{ type: "somethingNew", payload: { keep: "me" } }]);
    expect(other).toEqual({ role: "somethingNew", content: "kept" });
    // The two model messages are new objects, so the stored ones cannot be reached
    // from a frame that was slimmed.
    expect(slim.model![0]).not.toBe(entry.model![0]);
  });
});

describe("slimming a frame", () => {
  it("never changes the entries it was given", () => {
    const entries = fullEntries();
    const before = copy(entries);
    const slimmed = slimEntries(entries);

    expect(slimmed).toHaveLength(entries.length);
    expect(entries).toEqual(before);
    // A slimmed entry shares nothing mutable with the stored one.
    const system = slimmed.find((entry) => entry.kind === "pi.system")!;
    expect(system).not.toBe(entryOf(entries, "pi.system"));
    expect(system.model).toEqual([]);
  });

  it("keeps every other snapshot field as it is", () => {
    const snapshot = {
      type: "snapshot" as const,
      entries: fullEntries(),
      tools: [{ name: "read", state: "idle" }],
      compactions: [{ taskId: "t1", attempt: 1 }],
      usage: { context: { used: 1 } },
      agent: { name: "root" },
      run: { inputs: ["01J"] },
      generation: { attempt: 1 },
      inbox: [],
    };
    const slim = slimSnapshot(snapshot as never);

    expect(slim.tools).toBe(snapshot.tools);
    expect(slim.compactions).toBe(snapshot.compactions);
    expect(slim.usage).toBe(snapshot.usage);
    expect(slim.agent).toBe(snapshot.agent);
    expect(slim.run).toBe(snapshot.run);
    expect(slim.generation).toBe(snapshot.generation);
    expect(JSON.stringify(slim.entries)).not.toContain("sections");
  });

  it("slims the two frames that carry one entry and leaves other frames alone", () => {
    const [assistant] = assistantEntries(fullEntries());
    for (const type of ["entry_appended", "message_end"] as const) {
      const frame = { type, entry: assistant! } as never;
      const slim = slimAgentEvent(frame) as { entry: EntryRecord };
      expect(JSON.stringify(slim)).not.toContain("thinkingSignature");
      expect(slim.entry.id).toBe(assistant!.id);
    }

    const other = { type: "run_start", inputs: ["01J"] } as never;
    expect(slimAgentEvent(other)).toBe(other);
  });
});

describe("slimming the frames that carry a message or a tool result", () => {
  it("drops sections and toolsAdded from a system message on message_start", () => {
    const entries = fullEntries();
    const systemMessage = entryOf(entries, "pi.system").model![0] as Record<string, unknown>;
    // The message really carries the prompt, so the assertion is about dropping it.
    expect(JSON.stringify(systemMessage)).toContain('"sections"');
    expect(JSON.stringify(systemMessage)).toContain('"toolsAdded"');

    const frame = { type: "message_start", message: systemMessage } as never;
    const slim = slimAgentEvent(frame) as { type: string; message: Record<string, unknown> };

    expect(slim.type).toBe("message_start");
    expect(slim.message["role"]).toBe("system");
    expect(slim.message["sections"]).toBeUndefined();
    expect(slim.message["toolsAdded"]).toBeUndefined();
    // What a reader shows stays, and so does everything else on the message.
    expect(slim.message["content"]).toBe("You are pi-sec, an autonomous personal secretary.");
    expect(slim.message["timestamp"]).toBe(1_000);
    // The message this frame was given is untouched.
    expect(systemMessage["sections"]).toBeDefined();
    expect(systemMessage["toolsAdded"]).toBeDefined();
  });

  it("leaves a message_start with nothing to trim alone, and slims an assistant one", () => {
    const [first] = assistantEntries(fullEntries());
    const plain = { role: "assistant", content: "done" } as never;
    const frame = { type: "message_start", message: plain } as never;
    expect(slimAgentEvent(frame)).toBe(frame);

    // An assistant message does have something to trim, so that frame is a copy.
    const assistantFrame = { type: "message_start", message: first!.model![0] } as never;
    const slim = slimAgentEvent(assistantFrame) as { message: Record<string, unknown> };
    expect(slim).not.toBe(assistantFrame);
    expect(slim.message["usage"]).toBeUndefined();
    expect(JSON.stringify(slim)).not.toContain("thinkingSignature");
  });

  it("slims the entry of tool_execution_end and keeps the frame's own fields", () => {
    const entries = fullEntries();
    const edit = entries.find((entry) => JSON.stringify(entry).includes("*** Begin Patch"))!;
    const frame = {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "edit",
      entry: edit,
    } as never;
    const slim = slimAgentEvent(frame) as {
      type: string;
      toolCallId: string;
      toolName: string;
      entry: EntryRecord;
    };

    expect(slim.toolCallId).toBe("call-2");
    expect(slim.toolName).toBe("edit");
    expect(slim.entry.id).toBe(edit.id);
    expect(JSON.stringify(slim)).not.toContain("*** Begin Patch");
    expect(JSON.stringify(slim)).toContain("edited /tmp/parser.ts (+1 -1)");
    // The stored entry keeps the details.
    expect(JSON.stringify(edit)).toContain("*** Begin Patch");
  });

  it("leaves a tool_execution_end with no entry as it arrived", () => {
    const frame = { type: "tool_execution_end", toolCallId: "call-9", toolName: "read" } as never;
    expect(slimAgentEvent(frame)).toBe(frame);
  });

  it("drops details from tool_execution_update and keeps the output", () => {
    const frame = {
      type: "tool_execution_update",
      toolCallId: "call-2",
      toolName: "edit",
      output: { append: "half a diff" },
      details: { diff: "-old\n+new\n", patch: "*** Begin Patch\n*** End Patch\n" },
      diagnostics: [],
    } as never;
    const slim = slimAgentEvent(frame) as Record<string, unknown>;

    expect(slim["details"]).toBeUndefined();
    expect(slim["output"]).toEqual({ append: "half a diff" });
    expect(slim["diagnostics"]).toEqual([]);
    expect(slim["toolCallId"]).toBe("call-2");
    // The frame this call was given still holds its details.
    expect((frame as { details?: unknown }).details).toBeDefined();

    const withoutDetails = {
      type: "tool_execution_update",
      toolCallId: "call-2",
      toolName: "edit",
      output: { set: "text" },
    } as never;
    expect(slimAgentEvent(withoutDetails)).toBe(withoutDetails);
  });
});

describe("the conversation stream", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<{ origin: string; harness: TestHarness }> {
    const created = await createTestHarness({
      config: { server: { ...defaultConfig().server, port: 0 } },
    });
    harness = created;
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    const deps: AppDeps = {
      runtime: created.runtime,
      bus: created.events,
      sse,
      streams: new StreamHub({ runtime: created.runtime, bus: created.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: created.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin, harness: created };
  }

  function append(h: TestHarness, entry: EntryDraft, conversationId = 1): Promise<unknown> {
    return h.runtime.harness.commit(async (tx) => {
      await tx.appendEntry(conversationId as ConversationId, entry);
    }, ctx);
  }

  /** Reads one SSE stream and hands back the payload of the frame a test waits for. */
  async function frameOf(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    event: string,
    state: { buffer: string } = { buffer: "" },
  ): Promise<{ data: unknown; state: { buffer: string } }> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    for (;;) {
      // Complete frames only: a block with no terminator is still arriving.
      let at = state.buffer.indexOf("\n\n");
      while (at !== -1) {
        const block = state.buffer.slice(0, at);
        state.buffer = state.buffer.slice(at + 2);
        if (block.split("\n").includes(`event: ${event}`)) {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          return { data: JSON.parse(data), state };
        }
        at = state.buffer.indexOf("\n\n");
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${event}; so far:\n${state.buffer.slice(-400)}`);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${event}`);
      state.buffer += decoder.decode(value, { stream: true });
    }
  }

  /**
   * Every frame from the buffer up to and including `event`, in the order it arrived.
   *
   * `frameOf` answers one event and skips the rest, so a test that has to judge the
   * whole sequence reads it here.
   */
  async function framesUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    event: string,
    state: { buffer: string } = { buffer: "" },
  ): Promise<{ frames: { type: string; data: unknown }[]; state: { buffer: string } }> {
    const decoder = new TextDecoder();
    const frames: { type: string; data: unknown }[] = [];
    const deadline = Date.now() + 30_000;
    for (;;) {
      let at = state.buffer.indexOf("\n\n");
      while (at !== -1) {
        const block = state.buffer.slice(0, at);
        state.buffer = state.buffer.slice(at + 2);
        const lines = block.split("\n");
        const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
        if (type !== undefined) {
          const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          frames.push({ type, data: JSON.parse(data) });
          if (type === event) return { frames, state };
        }
        at = state.buffer.indexOf("\n\n");
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${event}; saw ${frames.map((frame) => frame.type).join(", ")}`);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${event}`);
      state.buffer += decoder.decode(value, { stream: true });
    }
  }

  /** The text of every `text` block in a message, joined as the page draws it. */
  function textOf(content: readonly { type: string; text?: string }[] | undefined): string {
    return (content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  it("sends slim entries on the stream and full entries from the conversation route", { timeout: 30_000 }, async () => {
    const { origin, harness: h } = await boot();
    // Entries committed before the page attaches are what the first snapshot holds.
    for (const entry of fullEntries()) await append(h, entry as unknown as EntryDraft);

    const controller = new AbortController();
    const response = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const { data: snapshot, state } = await frameOf(reader, "snapshot");
    const payload = snapshot as { entries: { kind: string; model?: unknown[] }[] };

    expect(payload.entries).toHaveLength(fullEntries().length);
    expect(JSON.stringify(payload)).not.toContain("thinkingSignature");
    expect(JSON.stringify(payload)).not.toContain('"sections"');
    expect(JSON.stringify(payload)).not.toContain('"arguments"');
    expect(JSON.stringify(payload)).not.toContain("*** Begin Patch");
    // The fields other readers use are still in the snapshot.
    expect(payload).toMatchObject({ type: "snapshot" });
    expect((snapshot as { tools: unknown }).tools).toBeDefined();
    expect((snapshot as { compactions: unknown }).compactions).toBeDefined();

    // A new entry arrives without the field it no longer needs to carry. An entry
    // with a model message is announced as `message_end` (see pi-durable's
    // `translate`), and that is the frame the rule has to cover.
    const later: EntryDraft = {
      kind: "pi.tool-result",
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult",
          toolCallId: "call-3",
          toolName: "edit",
          content: [{ type: "text", text: "edited again" }],
          details: { diff: "+added", patch: "*** Begin Patch\n*** End Patch\n" },
          isError: false,
          timestamp: 8_000,
        },
      ],
    };
    await append(h, later);
    const { data: ended } = await frameOf(reader, "message_end", state);
    expect(JSON.stringify(ended)).not.toContain("*** Begin Patch");
    expect(JSON.stringify(ended)).toContain("edited again");

    // An entry with no model message is announced as `entry_appended`, and it
    // carries nothing to trim.
    await append(h, { kind: "test.note", data: { at: 9_000 } });
    const { data: appended } = await frameOf(reader, "entry_appended", state);
    expect((appended as { entry?: { kind?: string } }).entry?.kind).toBe("test.note");

    // The same conversation read through the full route still holds everything.
    const full = (await (await fetch(`${origin}/api/conversations/1`)).json()) as { entries: unknown[] };
    const fullText = JSON.stringify(full);
    expect(fullText).toContain("thinkingSignature");
    expect(fullText).toContain('"sections"');
    expect(fullText).toContain("*** Begin Patch");
    controller.abort();
  });

  it("sends the system prompt message of message_start without its sections", { timeout: 30_000 }, async () => {
    const { origin, harness: h } = await boot();
    const controller = new AbortController();
    const response = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const { state } = await frameOf(reader, "snapshot");

    // A `pi.system` entry appended after the page attached is announced by
    // `message_start`, and its message is the prompt itself.
    const systemEntry = {
      kind: "pi.system",
      model: [
        {
          role: "system",
          content: "You are pi-sec, an autonomous personal secretary.",
          sections: { roles: "A role rule. ".repeat(400) },
          toolsAdded: [{ name: "read", description: "Read a file." }],
          timestamp: 1_000,
        },
      ],
    } as unknown as EntryDraft;
    await append(h, systemEntry);

    const { data } = await frameOf(reader, "message_start", state);
    const message = (data as { message: Record<string, unknown> }).message;
    expect(message["role"]).toBe("system");
    expect(message["sections"]).toBeUndefined();
    expect(message["toolsAdded"]).toBeUndefined();
    expect(message["content"]).toBe("You are pi-sec, an autonomous personal secretary.");

    // The stored entry still carries the whole prompt.
    const full = (await (await fetch(`${origin}/api/conversations/1?limit=1000`)).json()) as {
      entries: unknown[];
    };
    expect(JSON.stringify(full)).toContain('"toolsAdded"');
    expect(JSON.stringify(full)).toContain('"sections"');
    controller.abort();
  });

  it("drops the deltas but still sends the start, the end, and what follows in order", { timeout: 30_000 }, async () => {
    const { origin, harness: h } = await boot();
    // A model that writes one chunk every 200 ms makes pi-durable commit several
    // partials: the first opens `message_start` and each later one changes the
    // message, which is the commit that used to be published as `message_update`.
    const answer = "The answer arrives in pieces, and the page draws it whole. ".repeat(3).trim();
    const slow = fauxProvider({ provider: "faux", tokensPerSecond: 20 });
    h.models.setProvider(slow.provider);
    slow.setResponses([fauxAssistantMessage([fauxText(answer)])]);

    const controller = new AbortController();
    const response = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const { state } = await frameOf(reader, "snapshot");

    // A second, raw watch on the same conversation: it is what the library delivers,
    // with no server between, so the test can show that the deltas existed at all.
    // A view revision that holds a changed partial answer is a delta.
    const library: string[] = [];
    const conversation = await h.runtime.harness.conversation(ROOT_CONVERSATION_ID, ctx);
    const raw = await conversation!.watch(ctx);
    let lastPartial: unknown;
    raw.start(async (call) => {
      if (call.kind !== "value") return;
      const live = call.value.docs["pi.live"] as { generation?: { message?: unknown } } | undefined;
      const partial = live?.generation?.message;
      if (partial !== undefined && lastPartial !== undefined && partial !== lastPartial) library.push("message_update");
      lastPartial = partial;
    });
    try {
      const post = await fetch(`${origin}/basic-chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(post.status).toBe(202);

      const run = await framesUntil(reader, "run_end", state);
      // The library's own callbacks settle beside the server's; a short wait keeps
      // the assertion about them from depending on which callback ran first.
      const deadline = Date.now() + 2_000;
      while (!library.includes("message_update") && Date.now() < deadline) await sleep(20);

      const frames = run.frames;
      const types = frames.map((frame) => frame.type);
      const startsAnswer = (frame: { type: string; data: unknown }): boolean =>
        frame.type === "message_start" &&
        (frame.data as { message?: { role?: string } }).message?.role === "assistant";
      const endsAnswer = (frame: { type: string; data: unknown }): boolean =>
        frame.type === "message_end" &&
        (frame.data as { entry?: { model?: { role?: string }[] } }).entry?.model?.[0]?.role === "assistant";

      // The library really did commit deltas during this answer.
      expect(library).toContain("message_update");
      // None of them reached the client, and every other frame did.
      expect(types).not.toContain("message_update");
      expect(frames.filter(startsAnswer)).toHaveLength(1);
      expect(frames.filter(endsAnswer)).toHaveLength(1);
      expect(frames.findIndex(startsAnswer)).toBeLessThan(frames.findIndex(endsAnswer));
      expect(types.indexOf("run_start")).toBeLessThan(frames.findIndex(startsAnswer));
      expect(frames.findIndex(endsAnswer)).toBeLessThan(types.indexOf("run_end"));

      // The end frame carries the whole answer, as the page draws it.
      const end = frames.find(endsAnswer)!.data as {
        entry: { model?: { content: { type: string; text?: string }[] }[] };
      };
      expect(textOf(end.entry.model?.[0]?.content)).toBe(answer);

      // Every other frame still reaches the client, in order: an entry committed after
      // the run arrives as `entry_appended` and nothing else.
      await append(h, { kind: "test.note", data: { at: 9_000 } });
      const later = await framesUntil(reader, "entry_appended", run.state);
      expect(later.frames.at(-1)!.type).toBe("entry_appended");
      expect(later.frames.map((frame) => frame.type)).not.toContain("message_update");
      controller.abort();
    } finally {
      await raw.stop();
    }
  });

  it("slims the frames the focused chat stream carries too", { timeout: 30_000 }, async () => {
    const { origin, harness: h } = await boot();
    // A focused chat is an ordinary conversation; the stream route is the general one.
    const created = (await (
      await fetch(`${origin}/api/focused-chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "notes", test: true }),
      })
    ).json()) as { conversationId: number };

    for (const entry of fullEntries()) await append(h, entry as unknown as EntryDraft, created.conversationId);

    const controller = new AbortController();
    const response = await fetch(`${origin}/api/conversations/${created.conversationId}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const { data: snapshot } = await frameOf(reader, "snapshot");
    const text = JSON.stringify(snapshot);
    expect(text).toContain('"entries"');
    expect(text).not.toContain("thinkingSignature");
    expect(text).not.toContain('"sections"');
    controller.abort();
  });
});
