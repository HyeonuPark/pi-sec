import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { RouteContext } from "../src/server/router.ts";
import type { AppDeps } from "../src/server/deps.ts";
import type { BundledExtension, ExtensionRouteContext } from "../src/extensions/index.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * What a server does with event streams once its shutdown began.
 *
 * An event stream that opens after the shutdown started stays open, because the
 * browser opens it again by itself after the old one ended. The HTTP server then
 * waits for that stream for good, so the daemon never ends. These cases show the
 * three refusals that stop it: a hub that refuses after it closed, a stream hub
 * that refuses on all four attach methods, and a server close that ends while a
 * client still holds a request.
 */

const OPTIONS = { heartbeatMs: 15_000, queueBytes: 1_000_000, bufferMs: 60_000 };

/** A plain HTTP server that hands each request to `handle`, closed when the case ends. */
const servers: Server[] = [];
async function listen(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function expectRefusal(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("shutting_down");
}

describe("SseHub after closeAll", () => {
  it("answers 503 to a client of a channel that existed, and adds no writer", async () => {
    const hub = new SseHub(OPTIONS);
    const channel = hub.channel("one");
    const origin = await listen((req, res) => {
      channel.attach(req, res);
    });
    hub.closeAll();
    await expectRefusal(await fetch(`${origin}/`));
    expect(channel.size).toBe(0);
  });

  it("answers 503 to a client of a channel made after the close", async () => {
    const hub = new SseHub(OPTIONS);
    hub.closeAll();
    const late = hub.channel("late");
    const origin = await listen((req, res) => {
      expect(late.attach(req, res).writer).toBeUndefined();
    });
    await expectRefusal(await fetch(`${origin}/`));
    expect(late.size).toBe(0);
  });

  it("still serves a stream before the close", async () => {
    const hub = new SseHub(OPTIONS);
    const channel = hub.channel("open");
    const origin = await listen((req, res) => {
      channel.attach(req, res);
    });
    const controller = new AbortController();
    const response = await fetch(`${origin}/`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(channel.size).toBe(1);
    controller.abort();
  });
});

describe("StreamHub after close", () => {
  it("answers 503 on each of its four attach methods", async () => {
    const sse = new SseHub(OPTIONS);
    // The refusal comes before the hub reads anything of its dependencies.
    const streams = new StreamHub({ sse } as never);
    streams.close();
    const origin = await listen((req, res) => {
      const route = { req, res } as RouteContext;
      const path = req.url ?? "";
      if (path === "/conversation") void streams.attachConversation(route, 1);
      else if (path === "/jobs") void streams.attachJobs(route);
      else if (path === "/questions") void streams.attachUserQueries(route, async () => ({}));
      else streams.attachFocusedChatEvents(route);
    });
    for (const path of ["/conversation", "/jobs", "/questions", "/focused"]) await expectRefusal(await fetch(`${origin}${path}`));
    expect(sse.channel("jobs").size).toBe(0);
  });
});

describe("startServer close", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    started = undefined;
  });

  it("ends while an extension cleanup is slow and a client holds a request", async () => {
    let cleanupStarted: (() => void) | undefined;
    const cleaning = new Promise<void>((resolve) => (cleanupStarted = resolve));
    const catalog: BundledExtension[] = [
      {
        name: "close-fixture",
        create: () => {
          throw new Error("never installed");
        },
        phase: "app",
        routes: (context: ExtensionRouteContext) => {
          // A request that never answers, like a stream that came back too late.
          context.router.get("/close-fixture/hang", ({ res }) => {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write("retry: 3000\n\n");
          });
          return async () => {
            cleanupStarted?.();
            await new Promise((resolve) => setTimeout(resolve, 300));
          };
        },
      },
    ];
    harness = await createTestHarness({
      config: {
        server: { ...defaultConfig().server, port: 0 },
        agent: { ...defaultConfig().agent, extensions: { enabled: ["close-fixture"] } },
      },
    });
    const sse = new SseHub(OPTIONS);
    const deps: AppDeps = {
      runtime: harness.runtime,
      bus: harness.events,
      sse,
      streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir(), catalog, closeGraceMs: 200 });
    const port = Number(new URL(started.origin).port);

    // The client holds an open response of its own, outside the hub's reach.
    const held = new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/close-fixture/hang" }, (res) => {
        res.on("data", () => undefined);
        res.on("error", () => resolve());
        res.on("close", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const begun = Date.now();
    await started.close();
    const took = Date.now() - begun;
    // The cleanup takes 300 ms and the grace 200 ms: the close ends soon after
    // both, and the held connection ended with it.
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3_000);
    await cleaning;
    await held;
  }, 30_000);
});
