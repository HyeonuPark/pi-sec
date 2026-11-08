import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  type AssistantMessageEvent,
  type Models,
} from "@earendil-works/pi-ai";
import { withCallTiming } from "../src/agent/call-timing.ts";
import {
  MODEL_CALLS_RETENTION_DAYS,
  ModelCallsStore,
  type ModelCallInput,
} from "../src/agent/model-calls-store.ts";
import { createLogger } from "../src/runtime/logger.ts";

const DAY = 24 * 60 * 60 * 1000;
const logger = createLogger({ level: "error" } as never);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function setup(): { raw: Models; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider({ provider: "faux" });
  const raw = createModels();
  raw.setProvider(faux.provider);
  return { raw, faux };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const ctx = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

function call(overrides: Partial<ModelCallInput> = {}): ModelCallInput {
  return {
    startedAt: Date.now(),
    provider: "p",
    model: "m",
    api: "a",
    stopReason: "stop",
    input: 1,
    cacheRead: 0,
    cacheWrite: 0,
    output: 2,
    reasoning: null,
    headersMs: 1,
    ttftMs: 2,
    durationMs: 3,
    lastContentMs: null,
    contentEvents: null,
    ...overrides,
  };
}

describe("model call timing", () => {
  // The library stamps its own durationMs on a message unless the message timestamp is older than the
  // stream start. A future timestamp selects the library clock, a past one selects the wrapper clock.
  const clockPaths = [
    { name: "writes one row per call and passes the same events in the same order", timestamp: Date.now() + DAY, library: true },
    { name: "writes one row per call on the wrapper clock when the message has no duration", timestamp: 1, library: false },
  ];
  for (const { name, timestamp, library } of clockPaths)
  it(name, async () => {
    const { raw, faux } = setup();
    const store = await ModelCallsStore.open(":memory:");
    cleanups.push(() => store.close());
    const wrapped = withCallTiming(raw, { sink: store, logger });
    const model = faux.getModel();

    faux.setResponses([fauxAssistantMessage([fauxThinking("hmm"), fauxText("hello there")])]);
    const direct = await drain(raw.streamSimple(model, ctx));
    faux.setResponses([fauxAssistantMessage([fauxThinking("hmm"), fauxText("hello there")], { timestamp })]);
    const before = Date.now();
    const seen = await drain(wrapped.streamSimple(model, ctx));
    const after = Date.now();

    expect(seen.map((e) => e.type)).toEqual(direct.map((e) => e.type));
    expect(seen.length).toBeGreaterThan(3);
    const rows = store.rows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const done = seen.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") throw new Error("unreachable");
    expect(row.provider).toBe("faux");
    expect(row.model).toBe(model.id);
    expect(row.stopReason).toBe("stop");
    expect(row.startedAt).toBeGreaterThanOrEqual(before);
    expect(row.startedAt).toBeLessThanOrEqual(after);
    expect(row.ttftMs).not.toBeNull();
    expect(row.headersMs).not.toBeNull();
    expect(row.ttftMs!).toBeGreaterThanOrEqual(row.headersMs!);
    if (library) {
      // The stored duration is the library's own, so it is not on the wrapper clock that gives ttftMs.
      // The product does not promise durationMs >= ttftMs across the two clocks, so only equality is checked.
      expect(typeof (done.message as { durationMs?: number }).durationMs).toBe("number");
      expect(row.durationMs).toBe((done.message as { durationMs?: number }).durationMs);
    } else {
      // Both values come from the wrapper clock here, so the order holds.
      expect((done.message as { durationMs?: number }).durationMs).toBeUndefined();
      expect(row.durationMs).toBeGreaterThanOrEqual(row.ttftMs!);
      expect(row.durationMs).toBeGreaterThanOrEqual(row.lastContentMs!);
    }
    expect(row.input).toBe(done.message.usage.input);
    expect(row.output).toBe(done.message.usage.output);
    expect(row.output).toBeGreaterThan(0);
  });

  it("records the last content time and the number of content events", async () => {
    const { raw, faux } = setup();
    const store = await ModelCallsStore.open(":memory:");
    cleanups.push(() => store.close());
    const wrapped = withCallTiming(raw, { sink: store, logger });
    const model = faux.getModel();

    faux.setResponses([fauxAssistantMessage([fauxThinking("hmm"), fauxText("hello there, this is a longer answer")])]);
    const seen = await drain(wrapped.streamSimple(model, ctx));
    const deltas = seen.filter((e) => ["text_delta", "thinking_delta", "toolcall_delta"].includes(e.type)).length;
    expect(deltas).toBeGreaterThan(0);
    faux.setResponses([fauxAssistantMessage([])]);
    await drain(wrapped.streamSimple(model, ctx));

    const [withDeltas, none] = store.rows();
    expect(withDeltas!.contentEvents).toBe(deltas);
    expect(withDeltas!.lastContentMs).not.toBeNull();
    expect(withDeltas!.lastContentMs!).toBeGreaterThanOrEqual(withDeltas!.ttftMs!);
    expect(none!.lastContentMs).toBeNull();
    expect(none!.contentEvents).toBe(0);
  });

  it("adds the two columns to an old file once, keeps old rows NULL and fills new rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-calls-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "model-calls.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      api TEXT NOT NULL, stop_reason TEXT NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER, headers_ms INTEGER, ttft_ms INTEGER,
      duration_ms INTEGER NOT NULL)`);
    old
      .prepare(
        `INSERT INTO model_calls (started_at, provider, model, api, stop_reason, input, cache_read, cache_write, output,
          reasoning, headers_ms, ttft_ms, duration_ms) VALUES (1000, 'p', 'm', 'a', 'stop', 1, 0, 0, 2, NULL, 1, 2, 3)`,
      )
      .run();
    old.close();

    const columns = (): string[] => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return (db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((c) => c.name);
      } finally {
        db.close();
      }
    };
    expect(columns()).not.toContain("content_events");

    const first = await ModelCallsStore.open(path, () => 2000);
    first.insert(call({ startedAt: 1500, lastContentMs: 7.4, contentEvents: 3 }));
    const afterFirst = first.rows();
    first.close();
    const names = columns();
    expect(names).toContain("last_content_ms");
    expect(names).toContain("content_events");
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]).toMatchObject({ startedAt: 1000, lastContentMs: null, contentEvents: null });
    expect(afterFirst[1]).toMatchObject({ startedAt: 1500, lastContentMs: 7, contentEvents: 3 });

    const second = await ModelCallsStore.open(path, () => 2000);
    const afterSecond = second.rows();
    second.close();
    expect(columns()).toEqual(names);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("forwards the other methods and builds complete on the timed stream", async () => {
    const { raw, faux } = setup();
    const store = await ModelCallsStore.open(":memory:");
    cleanups.push(() => store.close());
    const wrapped = withCallTiming(raw, { sink: store, logger });
    expect(wrapped.getProvider("faux")).toBe(raw.getProvider("faux"));
    faux.setResponses([fauxAssistantMessage("a")]);
    const message = await wrapped.completeSimple(faux.getModel(), ctx);
    expect(message.role).toBe("assistant");
    expect(store.rows()).toHaveLength(1);
  });

  it("still returns the message when the store fails", async () => {
    const { raw, faux } = setup();
    const wrapped = withCallTiming(raw, {
      sink: {
        insert: () => {
          throw new Error("disk full");
        },
      },
      logger,
    });
    faux.setResponses([fauxAssistantMessage("fine")]);
    const message = await wrapped.completeSimple(faux.getModel(), ctx);
    expect(message.stopReason).toBe("stop");
    expect(message.content[0]).toMatchObject({ type: "text", text: "fine" });
  });

  it("keeps the stop reason of an error call", async () => {
    const { raw, faux } = setup();
    const store = await ModelCallsStore.open(":memory:");
    cleanups.push(() => store.close());
    const wrapped = withCallTiming(raw, { sink: store, logger });
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);
    const message = await wrapped.completeSimple(faux.getModel(), ctx);
    expect(message.stopReason).toBe("error");
    const controller = new AbortController();
    controller.abort();
    faux.setResponses([fauxAssistantMessage("x")]);
    const aborted = await wrapped.completeSimple(faux.getModel(), ctx, { signal: controller.signal });
    const rows = store.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.stopReason).toBe("error");
    expect(rows[1]!.stopReason).toBe(aborted.stopReason);
    expect(["aborted", "error"]).toContain(rows[1]!.stopReason);
    expect(JSON.stringify(rows)).not.toContain("boom");
  });

  it("deletes rows older than 90 days at the first write of a day and keeps new rows", async () => {
    let now = 1_800_000_000_000;
    const store = await ModelCallsStore.open(":memory:", () => now);
    cleanups.push(() => store.close());
    store.insert(call({ startedAt: now - (MODEL_CALLS_RETENTION_DAYS + 1) * DAY }));
    store.insert(call({ startedAt: now - 10 * DAY }));
    // The first write pruned before it inserted, so the old row is still there.
    expect(store.rows()).toHaveLength(2);
    now += DAY;
    store.insert(call({ startedAt: now }));
    const rows = store.rows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.startedAt >= now - MODEL_CALLS_RETENTION_DAYS * DAY)).toBe(true);
  });
});
