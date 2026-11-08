import { createGunzip, gunzipSync, constants as zlibConstants } from "node:zlib";
import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { acceptsGzip, GZIP_MIN_BYTES, isCompressibleType } from "../src/server/compress.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * Gzip on the surfaces a page load touches.
 *
 * The page, its assets, a JSON answer of at least a kilobyte and all three event
 * streams are compressed when the client asks; a client that does not ask gets
 * exactly what it got before. A compressed stream flushes each event through the
 * compressor, so a reader can decode one event without waiting for the next.
 *
 * The requests here are raw `http` ones: a client library that decompresses on
 * its own would hide both the header and the bytes these tests are about.
 */

interface RawAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly text: string;
}

async function get(origin: string, path: string, headers: Record<string, string> = {}): Promise<RawAnswer> {
  const url = new URL(path, origin);
  return await new Promise<RawAnswer>((resolve, reject) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "GET", headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            text: body.toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("acceptsGzip", () => {
  const req = (value: string | undefined): IncomingMessage =>
    ({ headers: value === undefined ? {} : { "accept-encoding": value } }) as unknown as IncomingMessage;

  it("reads the header rather than the token", () => {
    expect(acceptsGzip(req("gzip"))).toBe(true);
    expect(acceptsGzip(req("gzip, deflate, br"))).toBe(true);
    expect(acceptsGzip(req("deflate, gzip;q=0.5"))).toBe(true);
    expect(acceptsGzip(req("x-gzip"))).toBe(true);
    expect(acceptsGzip(req("GZIP"))).toBe(true);
    // A refusal is not a request.
    expect(acceptsGzip(req("gzip;q=0"))).toBe(false);
    expect(acceptsGzip(req("gzip;q=0, deflate"))).toBe(false);
    expect(acceptsGzip(req("br, deflate"))).toBe(false);
    expect(acceptsGzip(req("identity"))).toBe(false);
    expect(acceptsGzip(req(undefined))).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  it("compresses text, scripts, styles, JSON and SVG, and nothing else", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/css; charset=utf-8",
      "application/json; charset=utf-8",
      "image/svg+xml",
    ]) {
      expect(isCompressibleType(type)).toBe(true);
    }
    for (const type of ["image/png", "font/woff2", "application/octet-stream", undefined]) {
      expect(isCompressibleType(type)).toBe(false);
    }
  });
});

describe("gzip on the wire", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  let deps: AppDeps | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
    deps = undefined;
  });

  /** A daemon with one job, so `GET /api/jobs` answers more than a kilobyte. */
  async function boot(): Promise<string> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
    deps = {
      runtime: harness.runtime,
      bus: harness.events,
      sse,
      streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
      startedAt: Date.now(),
      version: "test",
      webDir: defaultWebDir(),
      adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    const created = await fetch(`${started.origin}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a job with a long description", description: "why it exists. ".repeat(120) }),
    });
    expect(created.status).toBe(201);
    return started.origin;
  }

  it("compresses the page, an asset, a large JSON answer and the three streams", async () => {
    const origin = await boot();
    const gzip = { "accept-encoding": "gzip" };

    const page = await get(origin, "/basic-chat", gzip);
    expect(page.status).toBe(200);
    expect(page.headers["content-encoding"]).toBe("gzip");
    expect(page.headers["vary"]).toBe("Accept-Encoding");
    expect(Number(page.headers["content-length"])).toBe(page.body.byteLength);
    // The bytes really are gzip, and they really hold the page.
    expect(page.text.slice(0, 2)).not.toBe("<!");
    expect(gunzipSync(page.body).toString("utf8").startsWith("<!")).toBe(true);

    const asset = await get(origin, "/base.js", gzip);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-encoding"]).toBe("gzip");
    expect(asset.headers["etag"]).toMatch(/^W\/"/);

    const jobs = await get(origin, "/api/jobs", gzip);
    expect(jobs.status).toBe(200);
    const plain = gunzipSync(jobs.body);
    // One kilobyte is the threshold, so the answer that was compressed is above it.
    expect(plain.byteLength).toBeGreaterThanOrEqual(GZIP_MIN_BYTES);
    expect(jobs.headers["content-encoding"]).toBe("gzip");
    expect(jobs.headers["vary"]).toBe("Accept-Encoding");
    expect((JSON.parse(plain.toString("utf8")) as { jobs: unknown[] }).jobs).toHaveLength(1);

    for (const path of ["/basic-chat/events", "/api/jobs/events", "/api/focused-chats/events"]) {
      const stream = await openStream(origin, path, gzip);
      expect(stream.headers["content-encoding"]).toBe("gzip");
      expect(stream.headers["vary"]).toBe("Accept-Encoding");
      // The framing header stays, whatever the encoding.
      expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
      expect(stream.headers["x-accel-buffering"]).toBe("no");
      stream.destroy();
    }
  }, 30_000);

  it("sends everything whole when the request does not ask for gzip", async () => {
    const origin = await boot();
    const page = await get(origin, "/basic-chat", { "accept-encoding": "identity" });
    expect(page.status).toBe(200);
    expect(page.headers["content-encoding"]).toBeUndefined();
    expect(page.text.startsWith("<!")).toBe(true);
    // A compressible type says what its two answers are, compressed or not.
    expect(page.headers["vary"]).toBe("Accept-Encoding");

    const asset = await get(origin, "/base.js", { "accept-encoding": "identity" });
    expect(asset.headers["content-encoding"]).toBeUndefined();
    expect(asset.text).toContain("function");

    const jobs = await get(origin, "/api/jobs", { "accept-encoding": "identity" });
    expect(jobs.headers["content-encoding"]).toBeUndefined();
    expect(() => JSON.parse(jobs.text)).not.toThrow();

    for (const path of ["/basic-chat/events", "/api/jobs/events", "/api/focused-chats/events"]) {
      const stream = await openStream(origin, path, { "accept-encoding": "identity" });
      expect(stream.headers["content-encoding"]).toBeUndefined();
      stream.destroy();
    }
  }, 30_000);

  it("does not compress a JSON answer below a kilobyte", async () => {
    const origin = await boot();
    const health = await get(origin, "/healthz", { "accept-encoding": "gzip" });
    expect(health.status).toBe(200);
    expect(health.body.byteLength).toBeLessThan(GZIP_MIN_BYTES);
    expect(health.headers["content-encoding"]).toBeUndefined();
  }, 30_000);

  it("flushes each event through the compressor, so one event can be read at once", async () => {
    const origin = await boot();
    const response = await openStream(origin, "/basic-chat/events", { "accept-encoding": "gzip" });
    expect(response.headers["content-encoding"]).toBe("gzip");

    // `finishFlush: Z_SYNC_FLUSH` is what a client needs for a stream that stays
    // open: the same marker the server writes after every event.
    const gunzip = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
    response.pipe(gunzip);
    let text = "";
    gunzip.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });

    const until = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!text.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; decoded so far:\n${text.slice(-300)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await until("event: snapshot");
    // One more event, published while nothing else is written: a heartbeat is 15
    // seconds away, so what arrives next is this event and nothing else.
    deps!.bus.sink.emit("notice", { type: "notice", code: "gzip_flush_check" });
    await until("gzip_flush_check");
    expect(text).toContain("event: notice");

    gunzip.destroy();
    response.destroy();
  }, 30_000);
});

/** Open one SSE request and hand the still-open response back. */
async function openStream(origin: string, path: string, headers: Record<string, string>): Promise<IncomingMessage> {
  const url = new URL(path, origin);
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers, agent: false },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}
