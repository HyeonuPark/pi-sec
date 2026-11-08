/**
 * The card call API and the card file route.
 *
 * Two properties are checked here that a unit test cannot reach: that the
 * refusals happen where the server already decides them (origin, body cap,
 * content type), and that a card's action answer goes through the same markup
 * check its rendered markup does. The file route is checked for the bytes and
 * headers a browser needs, and for the paths it must not answer.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const CAPTURE_KEY = "__piSecUiRouteTest";

/** The action input and the publish function the fixture extension hands the test. */
interface Captured {
  action?: Record<string, unknown>;
  publish?: (card: string, event: string, value?: unknown) => void;
}

function captured(): Captured {
  const store = globalThis as unknown as Record<string, Captured | undefined>;
  return store[CAPTURE_KEY] ?? {};
}

/** The publish the extension's `start` kept, for the stream test. */
function capturedPublish(): (card: string, event: string, value?: unknown) => void {
  const publish = captured().publish;
  if (publish === undefined) throw new Error("the extension's start hook did not keep its publish function");
  return publish;
}

const CARD_SCRIPT = "export const on = true;\n";
const SHEET = "body{color:red}\n";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One card with a script, an action for every case the tests name, and a `publish`. */
const DEMO_CARDS = `
export const name = "demo-cards";
export function create() {
  return { name: "demo-cards" };
}
export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "toggle", script: "card.js" }],
  render() {
    return { html: "<b>on</b>" };
  },
  action(input) {
    globalThis.${CAPTURE_KEY} = { ...globalThis.${CAPTURE_KEY}, action: input };
    if (input.action === "set") return { value: input.value, html: "<i>done</i>" };
    if (input.action === "nothing") return undefined;
    if (input.action === "bad") return { html: "<script>alert(1)</script>" };
    if (input.action === "slow") return new Promise(() => {});
    if (input.action === "throws") throw new Error("action exploded");
    return { value: "unknown action" };
  },
  start({ publish }) {
    globalThis.${CAPTURE_KEY} = { ...globalThis.${CAPTURE_KEY}, publish };
  },
};
`;

/** A card with no action at all, so the route can refuse it. */
const DEMO_STATIC = `
export const name = "demo-static";
export function create() {
  return { name: "demo-static" };
}
export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "plain" }],
  render() {
    return { html: "<b>static</b>" };
  },
};
`;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
  delete (globalThis as unknown as Record<string, unknown>)[CAPTURE_KEY];
});

interface BootOptions {
  readonly config?: Partial<Config>;
  readonly ui?: ServerOptions["ui"];
}

/** A harness with the fixture extensions, and a server on port 0. */
async function boot(options: BootOptions = {}): Promise<string> {
  harness = await createTestHarness({
    config: {
      ...(options.config ?? {}),
      server: { ...defaultConfig().server, ...(options.config?.server ?? {}), port: 0 },
    },
  });
  const extensionsDir = harness.paths.extensionsDir;
  for (const [name, body] of [
    ["demo-cards", DEMO_CARDS],
    ["demo-static", DEMO_STATIC],
  ] as const) {
    const dir = join(extensionsDir, name);
    await mkdir(join(dir, "ui"), { recursive: true });
    await writeFile(join(dir, "index.js"), body);
  }
  // The files a card may point at, and two it may not have served.
  const uiDir = join(extensionsDir, "demo-cards", "ui");
  await writeFile(join(uiDir, "card.js"), CARD_SCRIPT);
  await writeFile(join(uiDir, "card.mjs"), CARD_SCRIPT);
  await writeFile(join(uiDir, "card.css"), SHEET);
  await writeFile(join(uiDir, "icon.svg"), SVG);
  await writeFile(join(uiDir, "pic.png"), PNG);
  await writeFile(join(uiDir, "notes.txt"), "not a card file\n");
  await writeFile(join(uiDir, "data.json"), "{}\n");
  await mkdir(join(uiDir, "dir.js"), { recursive: true });
  // A link that leaves `ui/` must not be followed, even though it ends in .js.
  await writeFile(join(extensionsDir, "demo-cards", "outside.js"), "export const stolen = true;\n");
  await symlink(join(extensionsDir, "demo-cards", "outside.js"), join(uiDir, "linked.js"));

  const loaded = await harness.runtime.loader.loadAll();
  expect(loaded.errors).toEqual([]);

  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
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
  started = await startServer(deps, {
    webDir: defaultWebDir(),
    ui: options.ui ?? { renderTimeoutMs: 50, actionTimeoutMs: 100 },
  });
  return started.origin;
}

/** POST a JSON body to the call API, as the page does. */
async function call(
  origin: string,
  body: unknown,
  init: { path?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return await fetch(`${origin}${init.path ?? "/api/ui/call"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

describe("POST /api/ui/call", () => {
  it("passes the action name and value through and answers the value with checked html", async () => {
    const origin = await boot({ config: { timezone: "Asia/Tokyo" } });
    const response = await call(origin, { extension: "demo-cards", card: "toggle", action: "set", value: "on" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "on", html: "<i>done</i>" });

    // The extension saw exactly the names the page sent, and the harness zone.
    const input = captured().action;
    expect(input?.["card"]).toBe("toggle");
    expect(input?.["action"]).toBe("set");
    expect(input?.["value"]).toBe("on");
    expect(input?.["timezone"]).toBe("Asia/Tokyo");

    // An action that returns nothing answers no keys at all, rather than nulls.
    const empty = await call(origin, { extension: "demo-cards", card: "toggle", action: "nothing" });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});
  });

  it("answers the invalid-markup sentence when the action's html is refused", async () => {
    const origin = await boot();
    const response = await call(origin, { extension: "demo-cards", card: "toggle", action: "bad" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ html: "demo-cards/toggle: invalid markup" });
  });

  it("refuses a foreign origin, a non-JSON body type, and an oversized body where the server already decides", async () => {
    const origin = await boot({ config: { server: { ...defaultConfig().server, port: 0, maxBodyBytes: 200 } } });
    const valid = { extension: "demo-cards", card: "toggle", action: "set", value: "on" };

    const foreign = await call(origin, valid, { headers: { Origin: "http://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as ApiErrorBody).error.code).toBe("origin_forbidden");

    const plain = await call(origin, valid, { headers: { "Content-Type": "text/plain" } });
    expect(plain.status).toBe(415);
    expect(((await plain.json()) as ApiErrorBody).error.code).toBe("json_required");

    const oversized = await call(origin, {
      extension: "demo-cards",
      card: "toggle",
      action: "set",
      value: "x".repeat(400),
    });
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as ApiErrorBody).error.code).toBe("payload_too_large");
  });

  it("answers 504 for a slow action, naming the timeout", async () => {
    const origin = await boot();
    const response = await call(origin, { extension: "demo-cards", card: "toggle", action: "slow" });
    expect(response.status).toBe(504);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("ui_action_timeout");
    expect(body.error.message).toContain("100 ms");
  });

  it("answers 500 for an action that throws, and keeps serving", async () => {
    const origin = await boot();
    const response = await call(origin, { extension: "demo-cards", card: "toggle", action: "throws" });
    expect(response.status).toBe(500);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("ui_action_failed");

    // The failure is one request: the next one is answered normally.
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const next = await call(origin, { extension: "demo-cards", card: "toggle", action: "set", value: 1 });
    expect(next.status).toBe(200);
  });

  it("answers 404 for an unknown extension, an unknown card and an extension without an action", async () => {
    const origin = await boot();
    for (const body of [
      { extension: "no-such-ext", card: "toggle", action: "set" },
      { extension: "demo-cards", card: "no-such-card", action: "set" },
      { extension: "demo-static", card: "plain", action: "set" },
    ]) {
      const response = await call(origin, body);
      expect(response.status, JSON.stringify(body)).toBe(404);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe("not_found");
    }
  });

  it("answers 400 for a field that is not a name", async () => {
    const origin = await boot();
    for (const body of [
      { extension: "demo-cards", card: "toggle", action: "not a name" },
      { extension: "demo-cards", card: "toggle", action: "" },
      { extension: "demo-cards", card: "bad card", action: "set" },
      { extension: "demo-cards", card: "toggle" },
      { card: "toggle", action: "set" },
    ]) {
      const response = await call(origin, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe("invalid_request");
    }
  });
});

/** A GET whose path reaches the server without being normalised by the client. */
async function statusForPath(origin: string, path: string): Promise<number> {
  const url = new URL(origin);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, path, method: "GET" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("GET /ext/<extension>/ui/<file>", () => {
  it("serves a card script with the headers a browser needs", async () => {
    const origin = await boot();
    const response = await fetch(`${origin}/ext/demo-cards/ui/card.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(CARD_SCRIPT)));
    expect(await response.text()).toBe(CARD_SCRIPT);
  });

  it("names each served file type the way the assets are named", async () => {
    const origin = await boot();
    const expected: [string, string][] = [
      ["card.mjs", "text/javascript; charset=utf-8"],
      ["card.css", "text/css; charset=utf-8"],
      ["icon.svg", "image/svg+xml"],
      ["pic.png", "image/png"],
    ];
    for (const [file, type] of expected) {
      const response = await fetch(`${origin}/ext/demo-cards/ui/${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toBe(type);
    }
    // The png bytes arrive unchanged.
    const png = await fetch(`${origin}/ext/demo-cards/ui/pic.png`);
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
  });

  it("serves under the mount prefix", async () => {
    const origin = await boot({ config: { server: { ...defaultConfig().server, port: 0, basePath: "/sec" } } });
    const response = await fetch(`${origin}/sec/ext/demo-cards/ui/card.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CARD_SCRIPT);
    // ...and the un-prefixed path is not served at all.
    expect((await fetch(`${origin}/ext/demo-cards/ui/card.js`)).status).toBe(404);
  });

  it("answers 404 for a traversal, a symlink out of ui/, a file type it does not serve, a missing file, an unknown extension", async () => {
    const origin = await boot();

    // `..` sent raw: the client does not normalise it, and neither does the route.
    expect(await statusForPath(origin, "/ext/demo-cards/ui/../index.js")).toBe(404);
    // The same segment percent-encoded, which reaches the route as a literal `..`.
    expect(await statusForPath(origin, "/ext/demo-cards/ui/%2e%2e/index.js")).toBe(404);
    // A link inside ui/ whose real path is outside it.
    expect((await fetch(`${origin}/ext/demo-cards/ui/linked.js`)).status).toBe(404);
    // File types a card may not have served, even though they exist.
    expect((await fetch(`${origin}/ext/demo-cards/ui/notes.txt`)).status).toBe(404);
    expect((await fetch(`${origin}/ext/demo-cards/ui/data.json`)).status).toBe(404);
    // A file that is not there, and an extension nobody registered.
    expect((await fetch(`${origin}/ext/demo-cards/ui/missing.js`)).status).toBe(404);
    expect((await fetch(`${origin}/ext/no-such-ext/ui/card.js`)).status).toBe(404);
    // A directory is not a file, even when its name ends in a served type.
    expect((await fetch(`${origin}/ext/demo-cards/ui/dir.js`)).status).toBe(404);
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffer)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for SSE; buffer so far:\n${buffer}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

interface Frame {
  readonly event: string;
  readonly data: string;
}

/** Complete SSE frames in a buffer; a trailing partial frame is dropped. */
function parseFrames(buffer: string): Frame[] {
  return buffer
    .split("\n\n")
    .slice(0, -1)
    .flatMap((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      if (event === undefined) return [];
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return [{ event, data }];
    });
}

describe("ui_event on the conversation stream", () => {
  it("carries the card event to the page and drops a value over 16 KiB", async () => {
    const origin = await boot();
    const controller = new AbortController();
    const response = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = await readUntil(reader, (text) => text.includes("event: snapshot"));

    const publish = capturedPublish();
    publish("toggle", "changed", { on: true });
    buffer += await readUntil(reader, (text) => text.includes('"changed"'));

    // A value over the limit is dropped with a diagnostic, so the frame after it
    // is the only evidence that the stream went on.
    publish("toggle", "too-big", "x".repeat(20_000));
    publish("toggle", "after", null);
    buffer += await readUntil(reader, (text) => text.includes('"after"'));
    controller.abort();

    const frames = parseFrames(buffer).filter((frame) => frame.event === "ui_event");
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([
      { extension: "demo-cards", card: "toggle", event: "changed", value: { on: true } },
      { extension: "demo-cards", card: "toggle", event: "after", value: null },
    ]);
    expect(buffer).not.toContain("x".repeat(20_000));
  });
});
