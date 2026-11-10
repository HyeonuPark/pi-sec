import type { AgentRuntime } from "../src/agent/harness.ts";
import type { EventBus } from "../src/runtime/event-bus.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../src/server/server.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";

/** What the server is built over: a TestHarness, a remote fixture, or a runtime and a bus made by hand. */
export interface TestServerSource {
  readonly runtime: AgentRuntime;
  readonly events: EventBus;
}

/** The AppDeps fields that a test sets. A field that is absent or undefined keeps the standard value, or stays absent. */
export interface TestServerDeps {
  /** The runtime that the routes and the streams see. `adminState.restart` still comes from the source's runtime. */
  readonly runtime?: AgentRuntime;
  readonly startedAt?: number;
  readonly reloadConfig?: AppDeps["reloadConfig"];
  readonly restart?: AppDeps["restart"];
  readonly uiRestart?: AppDeps["uiRestart"];
}

export interface TestServerOptions extends ServerOptions {
  /** The served directory. AppDeps.webDir gets the same value. Default `defaultWebDir()`. */
  readonly webDir?: string;
  readonly deps?: TestServerDeps;
}

/** A started server, with the dependencies that it was built from. */
export interface TestServer extends StartedServer {
  readonly deps: AppDeps;
}

/** The hub options that every test server uses. */
export const TEST_SSE_OPTIONS = { heartbeatMs: 15_000, queueBytes: 1_000_000, bufferMs: 60_000 } as const;

/**
 * Start the standard test server over a harness. The caller owns the harness and
 * closes the server with `close()`, as it closed the started server before.
 */
export async function startTestServer(source: TestServerSource, options: TestServerOptions = {}): Promise<TestServer> {
  const { deps: extra = {}, ...serverOptions } = options;
  const webDir = options.webDir ?? defaultWebDir();
  const runtime = extra.runtime ?? source.runtime;
  const sse = new SseHub(TEST_SSE_OPTIONS);
  const deps: AppDeps = {
    runtime,
    bus: source.events,
    sse,
    streams: new StreamHub({ runtime, bus: source.events, sse }),
    startedAt: extra.startedAt ?? Date.now(),
    version: "test",
    webDir,
    adminState: { restart: source.runtime.restart, notes: new AdminNotes() },
    ...(extra.reloadConfig === undefined ? {} : { reloadConfig: extra.reloadConfig }),
    ...(extra.restart === undefined ? {} : { restart: extra.restart }),
    ...(extra.uiRestart === undefined ? {} : { uiRestart: extra.uiRestart }),
  };
  const started = await startServer(deps, { ...serverOptions, webDir });
  return { server: started.server, origin: started.origin, close: () => started.close(), deps };
}
