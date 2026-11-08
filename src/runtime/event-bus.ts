import type { EventsSink } from "../extensions/context.ts";

export interface PiSecEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly time: number;
}

export interface EventBus {
  readonly sink: EventsSink;
  subscribe(listener: (event: PiSecEvent) => void): () => void;
}

/** In-process pub/sub for pi-sec control events, fanned out to SSE streams. */
export function createEventBus(now: () => number = () => Date.now()): EventBus {
  const listeners = new Set<(event: PiSecEvent) => void>();
  return {
    sink: {
      emit: (type, data) => {
        const event: PiSecEvent = { type, data, time: now() };
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            /* a slow/broken listener must not break the emitter */
          }
        }
      },
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
