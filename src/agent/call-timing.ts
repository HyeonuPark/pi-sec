import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Models,
} from "@earendil-works/pi-ai";
import type { Logger } from "../runtime/logger.ts";
import type { ModelCallInput } from "./model-calls-store.ts";

/** Where the wrapper writes a finished call. Any failure is caught by the wrapper. */
export interface CallSink {
  insert(call: ModelCallInput): void;
}

export interface CallTimingOptions {
  readonly sink: CallSink;
  readonly logger: Logger;
  /** Epoch milliseconds. Tests give a fixed one. */
  readonly wallClock?: () => number;
  /** Monotonic milliseconds. Tests give a fixed one. */
  readonly monotonic?: () => number;
}

const CONTENT_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/**
 * Wrap a `Models` object so every streaming call leaves one timing row.
 *
 * Every other member is forwarded, bound to the original object, because the
 * model runtime keeps private state. `stream` and `streamSimple` return a
 * pass-through stream that hands each event to the caller unchanged and in
 * order. `complete` and `completeSimple` are rebuilt on the wrapped methods,
 * because the library's own versions call its internal `stream`. A deferred
 * fetch passes through without a row.
 */
export function withCallTiming(models: Models, options: CallTimingOptions): Models {
  const wall = options.wallClock ?? Date.now;
  const mono = options.monotonic ?? (() => performance.now());

  const record = (call: ModelCallInput): void => {
    try {
      options.sink.insert(call);
    } catch (error) {
      options.logger.warn("model call timing was not stored", { error });
    }
  };

  const timed = (
    provider: string,
    source: () => AssistantMessageEventStream,
  ): AssistantMessageEventStream => {
    const startedAt = wall();
    const t0 = mono();
    const inner = source();
    const out = createAssistantMessageEventStream();
    let headersMs: number | null = null;
    let ttftMs: number | null = null;
    let lastContentMs: number | null = null;
    let contentEvents = 0;
    let written = false;

    const finish = (message: AssistantMessage): void => {
      if (written) return;
      written = true;
      const clock = mono() - t0;
      const own = (message as { durationMs?: unknown }).durationMs;
      const usage = message.usage;
      record({
        startedAt,
        provider,
        model: message.model,
        api: message.api,
        stopReason: message.stopReason,
        input: usage?.input ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        output: usage?.output ?? 0,
        reasoning: typeof usage?.reasoning === "number" ? usage.reasoning : null,
        headersMs,
        ttftMs,
        durationMs: typeof own === "number" ? own : clock,
        lastContentMs,
        contentEvents,
      });
    };

    void (async () => {
      try {
        for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
          if (event.type === "start" && headersMs === null) headersMs = mono() - t0;
          else if (CONTENT_EVENTS.has(event.type)) {
            const at = mono() - t0;
            if (ttftMs === null) ttftMs = at;
            lastContentMs = at;
            contentEvents += 1;
          }
          if (event.type === "done") finish(event.message);
          else if (event.type === "error") finish(event.error);
          out.push(event);
        }
        out.end();
      } catch {
        // The library stream does not throw. If it does, end with its result when it has one.
        out.end(await inner.result().catch(() => undefined));
      }
    })();
    return out;
  };

  const stream = (model: { provider: string }, context: unknown, opts: unknown): AssistantMessageEventStream =>
    timed(model.provider, () => (models.stream as Function).call(models, model, context, opts));
  const streamSimple = (model: { provider: string }, context: unknown, opts: unknown): AssistantMessageEventStream =>
    timed(model.provider, () => (models.streamSimple as Function).call(models, model, context, opts));

  return new Proxy(models, {
    get(target, prop) {
      if (prop === "stream") return stream;
      if (prop === "streamSimple") return streamSimple;
      if (prop === "complete") return (m: never, c: never, o: never) => (stream as Function)(m, c, o).result();
      if (prop === "completeSimple") return (m: never, c: never, o: never) => (streamSimple as Function)(m, c, o).result();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Models;
}
