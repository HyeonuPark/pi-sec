/**
 * What the server answers over HTTP: the mount prefix, a static asset, the
 * stream, the page it stamps, the attachment URL, the proxy and the markup a card
 * may carry.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingHttpHeaders, createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SseHub, SseWriter } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { injectName, jsonDataBlock } from "../src/server/static.ts";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createAttachment, type AttachmentContext, type AttachmentRecord } from "../src/attachments/store.ts";
import { attachmentRefsInText } from "../src/extensions/attachment-context.ts";
import { createAttachmentsExtension, urlOf } from "../src/extensions/attachments.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { describeBasePathProblem, effectivePrefix, isTrustedPeer, normalizePrefix, proxyContext, resolveMount, trustedProxyProblems } from "../src/server/proxy.ts";
import { checkCardMarkup, UI_MARKUP_MAX_BYTES } from "../src/server/ui-markup.ts";

describe("base-mount.test.ts", () => {
  /**
   * The one rule that builds every URL on the page: `base.js`, which every shell
   * serves as a classic script before its own page module starts.
   *
   * Two things are pinned here. The chats list is a page of this app, so the mount
   * is read from a list that names it, and a chats page served under a prefix has
   * to be in that list. And a page whose own path names a prefix resolves that
   * prefix, which is what every URL the page builds then starts with.
   *
   * These two tests moved out of `focused-chat-web.test.ts` when the switch commit
   * deleted the hand-written chat page script: they read `base.js` alone and never
   * loaded that script, so they outlived it. `src/web/base.js` is unchanged.
   */

  const root = dirname(dirname(fileURLToPath(import.meta.url)));

  describe("the page routes the mount is read from", () => {
    it("resolves the mount from a chats page's own path", async () => {
      const source = await readFile(join(root, "src/web/base.js"), "utf8");
      const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "http://localhost/sec/chats",
        runScripts: "outside-only",
      });
      dom.window.eval(source);
      const resolved = (dom.window as unknown as { piSecMount: { resolve(doc: Document): { base: string; known: boolean } } })
        .piSecMount.resolve(dom.window.document);
      expect(resolved.base).toBe("/sec");
      expect(resolved.known).toBe(true);
    });
  });
});

describe("static-etag.test.ts", () => {
  /**
   * An asset answers `304` when the browser already has it.
   *
   * The page's assets are served with `Cache-Control: no-cache`, which makes the
   * browser ask every time and is what lets a Restart UI reach the next load. That
   * is only cheap if asking costs nothing when nothing changed, so each file carries
   * a validator built from its content: the same tag is answered with an empty `304`,
   * a changed file with `200` and its new bytes.
   *
   * The tree here is the test's own, so rewriting a file is part of the test.
   */

  interface Answer {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
    readonly text: string;
  }

  async function get(origin: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
    const url = new URL(path, origin);
    return await new Promise<Answer>((resolve, reject) => {
      const request = httpRequest(
        { host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString("utf8") });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  }

  describe("asset validators", () => {
    let harness: TestHarness | undefined;
    let started: StartedServer | undefined;
    let webDir: string | undefined;

    beforeEach(async () => {
      webDir = await mkdtemp(join(tmpdir(), "pi-sec-assets-"));
    });

    afterEach(async () => {
      await started?.close();
      started = undefined;
      await harness?.close();
      harness = undefined;
      if (webDir !== undefined) await rm(webDir, { recursive: true, force: true });
      webDir = undefined;
    });

    async function boot(): Promise<string> {
      harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
      const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
      const deps: AppDeps = {
        runtime: harness.runtime,
        bus: harness.events,
        sse,
        streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
        startedAt: Date.now(),
        version: "test",
        webDir: webDir!,
        adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
      };
      started = await startServer(deps, { webDir: webDir! });
      return started.origin;
    }

    const write = (name: string, text: string): Promise<void> => writeFile(join(webDir!, name), text, "utf8");

    it("answers 200 with a validator, and 304 without a body when the validator matches", async () => {
      await write("app.js", `// an asset\n${"const value = 1;\n".repeat(200)}`);
      const origin = await boot();

      const first = await get(origin, "/app.js");
      expect(first.status).toBe(200);
      expect(first.headers["etag"]).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
      expect(first.headers["cache-control"]).toBe("no-cache");
      expect(first.headers["vary"]).toBe("Accept-Encoding");
      expect(first.text).toContain("an asset");

      const etag = first.headers["etag"]!;
      const again = await get(origin, "/app.js", { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(again.body.byteLength).toBe(0);
      expect(again.headers["etag"]).toBe(etag);
      // The two headers that make a revalidated answer usable stay on it.
      expect(again.headers["cache-control"]).toBe("no-cache");
      expect(again.headers["vary"]).toBe("Accept-Encoding");

      // A list, a list with a stale tag in front, and `*` all mean the same thing.
      for (const header of [`W/"stale", ${etag}`, `"other", ${etag}`, "*"]) {
        const answer = await get(origin, "/app.js", { "if-none-match": header });
        expect(answer.status).toBe(304);
        expect(answer.body.byteLength).toBe(0);
      }
      // A tag that does not match is a normal answer.
      const stale = await get(origin, "/app.js", { "if-none-match": 'W/"nothing-like-it"' });
      expect(stale.status).toBe(200);
      expect(stale.text).toContain("an asset");
    }, 30_000);

    it("answers 200 with a new validator and the new bytes when the file changed", async () => {
      await write("app.js", `// first\n${"const value = 1;\n".repeat(200)}`);
      const origin = await boot();
      const first = await get(origin, "/app.js");
      const firstEtag = first.headers["etag"]!;

      await write("app.js", `// second, and longer\n${"const other = 2;\n".repeat(200)}`);
      const changed = await get(origin, "/app.js", { "if-none-match": firstEtag });
      expect(changed.status).toBe(200);
      expect(changed.headers["etag"]).not.toBe(firstEtag);
      expect(changed.text).toContain("second, and longer");
      expect(changed.text).not.toContain("// first");

      // The gzipped answer follows the file too: the bytes kept per version are
      // replaced with the ones the change made.
      const zipped = await get(origin, "/app.js", { "accept-encoding": "gzip" });
      expect(zipped.headers["content-encoding"]).toBe("gzip");
      expect(zipped.headers["etag"]).toBe(changed.headers["etag"]);
      expect(gunzipSync(zipped.body).toString("utf8")).toContain("second, and longer");
    }, 30_000);

    it("answers 404 for a file that is not there", async () => {
      const origin = await boot();
      const missing = await get(origin, "/absent.js");
      expect(missing.status).toBe(404);
      expect(missing.text).toContain("not_found");
    }, 30_000);
  });
});

describe("sse.test.ts", () => {
  /**
   * The rule that keeps one slow reader from filling the daemon's memory.
   *
   * `res.write` returning `false` says the socket's high-water mark was passed, and
   * one large frame (the initial `snapshot`) always does that, so the return value
   * cannot be the test: mistaking it for lag tore down every connection right after
   * its snapshot. What counts is the backlog the frame would join, measured as the
   * real number of bytes written but not yet sent — `res.writableLength` — before
   * the write. A lone oversized frame is therefore delivered, and a client whose
   * backlog passes the cap is disconnected on the next frame.
   *
   * These run against a real server and a client that stops reading, because the
   * number under test only exists for a real socket.
   */

  interface Session {
    readonly writer: SseWriter;
    readonly res: ServerResponse;
    readonly client: IncomingMessage;
    /** Everything the client has received once the stream ends. */
    readAll(timeoutMs?: number): Promise<string>;
    /** Everything received until `marker` shows up; the connection is dropped after. */
    readUntil(marker: string, timeoutMs?: number): Promise<string>;
    close(): Promise<void>;
  }

  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A server with one attached client that is not reading yet. */
  async function open(queueBytes: number): Promise<Session> {
    let writer: SseWriter | undefined;
    let response: ServerResponse | undefined;
    const server = createServer((_req, res) => {
      response = res;
      writer = new SseWriter(res, { heartbeatMs: 60_000, queueBytes, bufferMs: 60_000 }, () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const client = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpGet({ host: "127.0.0.1", port, path: "/", agent: false }, resolve);
      request.on("error", reject);
    });
    // Nothing reads until the test says so, which is what builds a backlog.
    client.pause();
    // The handler runs after the socket is accepted, so the writer exists by now.
    for (let i = 0; i < 100 && writer === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    if (writer === undefined || response === undefined) throw new Error("the request handler never ran");
    const attached = writer;
    return {
      writer: attached,
      res: response,
      client,
      readAll: (timeoutMs = 10_000) =>
        new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            client.destroy();
            resolve(Buffer.concat(chunks).toString("utf8"));
          };
          setTimeout(done, timeoutMs).unref?.();
          client.setEncoding("utf8");
          client.on("data", (chunk: string) => chunks.push(Buffer.from(chunk)));
          client.on("end", done);
          client.on("close", done);
          client.on("error", done);
          client.resume();
        }),
      readUntil: (marker: string, timeoutMs = 10_000) =>
        new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            client.destroy();
            resolve(Buffer.concat(chunks).toString("utf8"));
          };
          setTimeout(done, timeoutMs).unref?.();
          client.setEncoding("utf8");
          client.on("data", (chunk: string) => {
            chunks.push(Buffer.from(chunk));
            if (Buffer.concat(chunks).toString("utf8").includes(marker)) done();
          });
          client.on("error", done);
          client.resume();
        }),
      close: async () => {
        attached.close();
        client.destroy();
      },
    };
  }

  /** One frame of roughly this size, as a snapshot would be. */
  function bigFrame(bytes: number): unknown {
    return { type: "snapshot", entries: [{ text: "x".repeat(bytes) }] };
  }

  describe("SseWriter lag on unsent bytes", () => {
    it("delivers a frame larger than the queue cap without disconnecting", async () => {
      const session = await open(64 * 1024);
      session.writer.send("snapshot", bigFrame(1024 * 1024));

      // The frame is bigger than the cap on an empty pipe, so nothing is waiting
      // behind it: it goes out and the connection stays.
      expect(session.writer.isClosed).toBe(false);
      const received = await session.readUntil("x".repeat(64));
      expect(received).toContain("event: snapshot");
      expect(received).not.toContain("stream_lagging");
      await session.close();
    }, 30_000);

    it("disconnects a client whose backlog exceeds the cap", async () => {
      const session = await open(64 * 1024);
      session.writer.send("snapshot", bigFrame(1024 * 1024));
      // The reader is still not reading, so that frame is now an unsent backlog of
      // about a megabyte, far past the cap. The next frame notices and gives up.
      expect(session.writer.isClosed).toBe(false);
      session.writer.send("snapshot", bigFrame(1024 * 1024));

      expect(session.writer.isClosed).toBe(true);
      const received = await session.readAll();
      expect(received).toContain("stream_lagging");
      await session.close();
    }, 30_000);
  });
});

describe("personality-name-page.test.ts", () => {
  /**
   * The registered name on the chat page.
   *
   * Two properties are pinned here and nowhere else. The stamp leaves a page that
   * has no `pi-sec-name` meta tag exactly as it was, because another page of this
   * server may be served through the same helper. And the route reads the
   * personality file on every request, so a name registered after boot reaches the
   * next page load, while a missing file, a file with no name, and an unreadable
   * file all still answer a page: the title is not worth a 500.
   */

  /** A page with the three meta tags the server stamps. */
  const PAGE = `<!doctype html>
  <html>
  <head>
  <meta name="pi-sec-base" content="" />
  <meta name="pi-sec-timezone" content="UTC" />
  <meta name="pi-sec-name" content="" />
  </head>
  <body><div id="chat-title">Root</div></body>
  </html>
  `;

  /** The same page before the name meta tag existed, as another page may look. */
  const PAGE_WITHOUT_NAME = `<!doctype html>
  <html>
  <head>
  <meta name="pi-sec-base" content="" />
  <meta name="pi-sec-timezone" content="UTC" />
  </head>
  <body><div id="chat-title">Root</div></body>
  </html>
  `;

  const NAMED_FILE = "---\nlanguage: ko\nname: 테스트봇\n---\n# 인물\n\n차분하게 말합니다.\n";
  const UNNAMED_FILE = "---\nlanguage: ko\n---\n# 인물\n\n차분하게 말합니다.\n";

  describe("injectName", () => {
    it("writes a name with a `$` pattern as it is", () => {
      const stamped = injectName(PAGE, "N$&M $' $$");
      expect(stamped).toContain('content="N$&amp;M $\' $$"');
      expect(stamped.match(/pi-sec-name/g)?.length).toBe(1);
    });

    it("escapes a name that carries markup", () => {
      const stamped = injectName(PAGE, 'A&B "C" <D>');
      expect(stamped).toContain('<meta name="pi-sec-name" content="A&amp;B &quot;C&quot; &lt;D&gt;" />');
      // The tag is still exactly one tag, and nothing else on the page moved.
      expect(stamped.match(/pi-sec-name/g)?.length).toBe(1);
    });
  });

  describe("GET /basic-chat", () => {
    let harness: TestHarness | undefined;
    let started: StartedServer | undefined;

    afterEach(async () => {
      await started?.close();
      started = undefined;
      await harness?.close();
      harness = undefined;
    });

    /** A harness, a web root holding `page`, and a server on port 0. */
    async function boot(page: string): Promise<string> {
      harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
      const webDir = await mkdtemp(join(tmpdir(), "pi-sec-name-page-"));
      await writeFile(join(webDir, "index.html"), page, "utf8");
      const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
      const deps: AppDeps = {
        runtime: harness.runtime,
        bus: harness.events,
        sse,
        streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
        startedAt: Date.now(),
        version: "test",
        webDir,
        adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
      };
      started = await startServer(deps, { webDir });
      return started.origin;
    }

    /** Write the personality file the config points at, under this harness's home. */
    async function writePersonality(text: string): Promise<void> {
      const path = join(harness!.paths.home, "memory", "personality.md");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    }

    async function pageOf(origin: string): Promise<string> {
      const response = await fetch(`${origin}/basic-chat`);
      expect(response.status).toBe(200);
      return await response.text();
    }

    it("stamps the registered name, and an empty value when there is none", async () => {
      const origin = await boot(PAGE);

      // No personality file yet: the page is served, and the value says so.
      expect(await pageOf(origin)).toContain('<meta name="pi-sec-name" content="" />');

      await writePersonality(NAMED_FILE);
      // Read on every request, so the name reaches the next page load.
      expect(await pageOf(origin)).toContain('<meta name="pi-sec-name" content="테스트봇" />');

      await writePersonality(UNNAMED_FILE);
      expect(await pageOf(origin)).toContain('<meta name="pi-sec-name" content="" />');
    });

    it("serves a page that has no name meta tag without adding one", async () => {
      const origin = await boot(PAGE_WITHOUT_NAME);
      await writePersonality(NAMED_FILE);

      const page = await pageOf(origin);
      expect(page).not.toContain("pi-sec-name");
      // The other stamps still ran, so the page was served as it is served today.
      expect(page).toContain('<meta name="pi-sec-base" content="" />');
    });

    it("serves the page when the personality file cannot be read as a document", async () => {
      const origin = await boot(PAGE);
      // A directory where the file should be: readable as neither a file nor a
      // personality, and still not a reason to fail the page.
      await mkdir(join(harness!.paths.home, "memory", "personality.md"), { recursive: true });

      const response = await fetch(`${origin}/basic-chat`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<meta name="pi-sec-name" content="" />');
    });

    it("reads the file the config names", async () => {
      harness = await createTestHarness({
        config: {
          server: { ...defaultConfig().server, port: 0 },
          personality: { file: "persona/custom.md", interview: false, roles: ["orchestrator"] },
        },
      });
      const webDir = await mkdtemp(join(tmpdir(), "pi-sec-name-page-"));
      await writeFile(join(webDir, "index.html"), PAGE, "utf8");
      const path = join(harness.paths.home, "persona", "custom.md");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "---\nlanguage: en\nname: Alice\n---\n# Persona\n\nWarm.\n", "utf8");

      const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
      const deps: AppDeps = {
        runtime: harness.runtime,
        bus: harness.events,
        sse,
        streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
        startedAt: Date.now(),
        version: "test",
        webDir,
        adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
      };
      started = await startServer(deps, { webDir });

      expect(await pageOf(started.origin)).toContain('<meta name="pi-sec-name" content="Alice" />');
    });
  });
});

describe("attachments-url-mount.test.ts", () => {
  /**
   * The URL a tool emits carries the mount.
   *
   * This daemon is served under a path prefix (`https://example.com/sec` here),
   * and a URL an agent pastes into a reply is followed from the page it lands on.
   * A host-root path such as `/api/share/<name>` is right only when the daemon is
   * served at the root, so `urlOf` takes the mount the server already emits every
   * other URL under.
   *
   * The browser prefixes the API calls it makes itself (`piSecMount.at`), so the
   * two rules must not both apply to one URL: the materializer recognises a
   * mounted reference and the page adds nothing to a path that already carries
   * the base.
   */

  interface Roots {
    readonly attachments: string;
    readonly share: string;
  }

  let harness: TestHarness | undefined;
  let roots: Roots | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (roots !== undefined) await rm(roots.attachments, { recursive: true, force: true }).catch(() => undefined);
    if (roots !== undefined) await rm(roots.share, { recursive: true, force: true }).catch(() => undefined);
    roots = undefined;
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    scratch = undefined;
  });

  /** A 33-byte PNG header: enough for the size reader, and not a real image. */
  function pngHeader(width = 2, height = 1): Buffer {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "latin1");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    header[24] = 8;
    header[25] = 6;
    return header;
  }

  /** A harness over temp roots, with the server section the test names. */
  async function boot(server: { readonly basePath: string; readonly publicUrl?: string }): Promise<TestHarness> {
    const base = defaultConfig();
    const h = await createTestHarness({
      config: {
        server: { ...base.server, port: 0, ...server },
      },
    });
    harness = h;
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-attach-url-"));
    roots = { attachments: join(dir, "attachments"), share: join(dir, "share") };
    // A source file lives outside both roots, so the share root holds only what the
    // store wrote.
    scratch = join(dir, "source");
    await mkdir(scratch, { recursive: true });
    return h;
  }

  function storeContext(h: TestHarness, into: Roots): AttachmentContext {
    return { storage: h.runtime.storage, harness: h.runtime.harness, audit: h.runtime.audit, roots: into };
  }

  type ToolLike = {
    name: string;
    execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<unknown>;
  };

  function toolsOf(h: TestHarness, into: Roots): Map<string, ToolLike> {
    // The tool extension reads the config at call time, the way the runtime hands
    // it over; everything else comes from the harness.
    const context = {
      storage: h.runtime.storage,
      harness: h.runtime.harness,
      audit: h.runtime.audit,
      paths: h.paths,
      roots: into,
      getConfig: () => h.config,
    } as unknown as ExtensionContext;
    const extension = createAttachmentsExtension(context);
    return new Map((extension.tools ?? []).map((tool) => [tool.name, tool as unknown as ToolLike]));
  }

  const api = { conversationId: 41 } as unknown as ToolExecutionApi;

  function textOf(result: unknown): string {
    const content = (result as { output: readonly { type: string; text?: string }[] }).output;
    return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  function jsonOf(result: unknown): Record<string, unknown> {
    return JSON.parse(textOf(result)) as Record<string, unknown>;
  }

  /** One record, for the pure `urlOf` calls. */
  function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
    return {
      id: "01M545YXYZ000000000000K9J1",
      kind: "attachment",
      name: "shot.png",
      mime: "image/png",
      bytes: 33,
      sha256: "0".repeat(64),
      collectedAt: 1,
      // Never read by `urlOf`, which is all this record is for.
      storagePath: join(tmpdir(), "pi-sec-fixture", "attachments", "x", "x.png"),
      ...over,
    };
  }

  describe("a tool URL under a configured basePath", () => {
    it("carries the mount in the URL it returns, in the list, and in the reopened file", async () => {
      const h = await boot({ basePath: "/sec" });
      const into = roots!;
      const tools = toolsOf(h, into);

      const source = join(scratch!, "source.png");
      await writeFile(source, pngHeader());

      const shared = jsonOf(
        await tools.get("share_image")!.execute({ source, name: "shot.png" } as never, api, background),
      );
      const url = String(shared["url"]);
      expect(url).toMatch(/^\/sec\/api\/share\/[A-Za-z0-9._-]+$/);
      expect(url).not.toContain("/sec/sec");
      // The markdown an agent pastes is followed from a mounted page, so it has to
      // carry the mount too.
      expect(shared["markdown"]).toBe(`![](${url})`);

      // The materializer reads a mounted reference, not only a host-root one.
      const refs = attachmentRefsInText(String(shared["markdown"]));
      expect(refs).toEqual([{ kind: "share", key: url.slice("/sec/api/share/".length) }]);

      const listed = (jsonOf(await tools.get("attachments_list")!.execute({ conversationId: "41" } as never, api, background))[
        "attachments"
      ] ?? []) as Record<string, unknown>[];
      expect(listed.map((each) => each["url"])).toContain(url);

      // An attachment-kind record takes the other branch of `urlOf`.
      const attachment = await createAttachment(storeContext(h, into), {
        kind: "attachment",
        name: "shot.png",
        mime: "image/png",
        data: pngHeader(),
      });
      const opened = textOf(await tools.get("attachment_open")!.execute({ id: attachment.id } as never, api, background));
      expect(opened).toContain(`/sec/api/attachments/${attachment.id}`);
    });
  });

  describe("urlOf and the mount it is handed", () => {
    it("prefixes both routes, normalises a trailing slash, and derives the mount from publicUrl", async () => {
      expect(urlOf(record(), "/sec")).toBe("/sec/api/attachments/01M545YXYZ000000000000K9J1");
      expect(urlOf(record({ kind: "share", name: "shot.png" }), "/sec")).toBe("/sec/api/share/shot.png");
      // A prefix with a trailing slash must not produce `//`.
      expect(urlOf(record(), "/other/")).toBe("/other/api/attachments/01M545YXYZ000000000000K9J1");
      // No mount: the URL stays host-rooted, which is what a root-served daemon serves.
      expect(urlOf(record())).toBe("/api/attachments/01M545YXYZ000000000000K9J1");

      // `publicUrl` alone declares the mount, and a tool has to use it too.
      const h = await boot({ basePath: "", publicUrl: "https://example.com/sec" });
      const into = roots!;
      const source = join(scratch!, "source.png");
      await writeFile(source, pngHeader());
      const shared = jsonOf(
        await toolsOf(h, into).get("share_image")!.execute({ source, name: "shot.png" } as never, api, background),
      );
      expect(String(shared["url"])).toMatch(/^\/sec\/api\/share\//);
    });
  });
});

describe("proxy.test.ts", () => {
  function request(headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
    return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
  }

  function config(trustedProxies: string[]) {
    return { ...defaultConfig(), server: { ...defaultConfig().server, trustedProxies } };
  }

  describe("normalizePrefix", () => {
    // A forwarded prefix reaches a Location header and the served HTML, so a
    // misconfigured proxy must not be able to inject either.
    it.each<[string, string | null | undefined, string | undefined]>([
      ["accepts plain paths and normalises the trailing slash", "/sec", "/sec"],
      ["accepts plain paths and normalises the trailing slash", "/sec/", "/sec"],
      ["accepts plain paths and normalises the trailing slash", "/a/b/c", "/a/b/c"],
      ["accepts plain paths and normalises the trailing slash", "  /sec  ", "/sec"],
      ["reads empty and root as no prefix", "", ""],
      ["reads empty and root as no prefix", "/", ""],
      ["reads empty and root as no prefix", undefined, ""],
      ["reads empty and root as no prefix", null, ""],
      ["rejects anything that is not a boring path", "//evil.example.com", undefined],
      ["rejects anything that is not a boring path", "https://evil.example.com", undefined],
      ["rejects anything that is not a boring path", "/sec/../../etc", undefined],
      ["rejects anything that is not a boring path", "/sec/./x", undefined],
      ["rejects anything that is not a boring path", "/sec%2f..%2f", undefined],
      ["rejects anything that is not a boring path", "/a b", undefined],
      ["rejects anything that is not a boring path", "/sec<x>", undefined],
      ["rejects anything that is not a boring path", "/sec\\x", undefined],
      ["rejects anything that is not a boring path", "/sec\nLocation: https://evil.example.com", undefined],
      ["rejects anything that is not a boring path", "sec", undefined],
      ["rejects anything that is not a boring path", `/${"a".repeat(300)}`, undefined],
    ])("%s: normalizePrefix(%j) is %j", (_name, input, expected) => {
      expect(normalizePrefix(input)).toBe(expected);
    });
  });

  describe("isTrustedPeer", () => {
    it("trusts nothing when the list is empty", () => {
      expect(isTrustedPeer("127.0.0.1", [])).toBe(false);
    });

    it("matches exact addresses and CIDR blocks, v4 and v6", () => {
      expect(isTrustedPeer("127.0.0.1", ["127.0.0.1"])).toBe(true);
      expect(isTrustedPeer("127.0.0.2", ["127.0.0.1"])).toBe(false);
      expect(isTrustedPeer("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
      expect(isTrustedPeer("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
      expect(isTrustedPeer("::1", ["::1/128"])).toBe(true);
      expect(isTrustedPeer("::2", ["::1/128"])).toBe(false);
      // Node reports IPv4 peers on a dual-stack socket in mapped form.
      expect(isTrustedPeer("::ffff:127.0.0.1", ["127.0.0.1/32"])).toBe(true);
      expect(isTrustedPeer("::ffff:10.9.9.9", ["10.0.0.0/8"])).toBe(true);
    });

    it("ignores junk entries and junk addresses", () => {
      expect(isTrustedPeer("127.0.0.1", ["not-an-ip"])).toBe(false);
      expect(isTrustedPeer("127.0.0.1", ["10.0.0.0/99"])).toBe(false);
      expect(isTrustedPeer(undefined, ["127.0.0.1"])).toBe(false);
      expect(isTrustedPeer("not-an-ip", ["0.0.0.0/0"])).toBe(false);
    });
  });

  describe("effectivePrefix", () => {
    const from = (forwardedPrefix: string | undefined, basePath: string, publicUrl?: string) => ({
      forwardedPrefix,
      basePath,
      publicUrl,
    });
    it.each([
      ["prefers a forwarded prefix over configuration", from("/proxy", "/configured", "https://x.example.com/url"), "/proxy"],
      ["falls back to basePath, then to the path of publicUrl: basePath", from(undefined, "/configured"), "/configured"],
      ["falls back to basePath, then to the path of publicUrl: publicUrl path", from(undefined, "", "https://agent.example.com/sec"), "/sec"],
      ["falls back to basePath, then to the path of publicUrl: publicUrl without a path", from(undefined, "", "https://agent.example.com"), ""],
      ["ignores a rejected forwarded prefix rather than trusting it: basePath set", from("//evil.example.com", "/sec"), "/sec"],
      ["ignores a rejected forwarded prefix rather than trusting it: nothing set", from("//evil.example.com", ""), ""],
    ])("%s", (_name, input, expected) => {
      expect(effectivePrefix(input)).toBe(expected);
    });
  });

  describe("resolveMount", () => {
    function serverConfig(server: Partial<ReturnType<typeof defaultConfig>["server"]>) {
      const base = defaultConfig();
      return { ...base, server: { ...base.server, ...server } };
    }

    it("reports a forwarded prefix that disagrees with the configured mount", () => {
      const mount = resolveMount(
        request({ "x-forwarded-prefix": "/attacker" }),
        serverConfig({ trustedProxies: ["127.0.0.1/32"], publicUrl: "https://example.com/sec" }),
      );
      // The forwarded value still wins — it is how a stripping proxy declares the
      // mount — but the disagreement is no longer silent.
      expect(mount.prefix).toBe("/attacker");
      expect(mount.conflict).toContain("/attacker");
      expect(mount.conflict).toContain("/sec");
    });

    it("says nothing when there is nothing to disagree with", () => {
      const mount = resolveMount(
        request({ "x-forwarded-prefix": "/attacker" }),
        serverConfig({ trustedProxies: ["127.0.0.1/32"] }),
      );
      expect(mount.conflict).toBeUndefined();
    });
  });

  describe("proxyContext", () => {
    it("reads forwarded values from a trusted peer", () => {
      const context = proxyContext(
        request({ "x-forwarded-prefix": "/sec", "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
        config(["127.0.0.1/32"]),
      );
      expect(context.trusted).toBe(true);
      expect(context.forwardedPrefix).toBe("/sec");
      // Leftmost entry is the client; used for the access log only.
      expect(context.client).toBe("203.0.113.7");
    });

    it("ignores forwarded values from anyone else", () => {
      const context = proxyContext(
        request({ "x-forwarded-prefix": "/sec", "x-forwarded-for": "203.0.113.7" }, "198.51.100.9"),
        config(["127.0.0.1/32"]),
      );
      expect(context.trusted).toBe(false);
      expect(context.forwardedPrefix).toBeUndefined();
      expect(context.client).toBeUndefined();
    });

    it("drops a forwarded client that is not an address", () => {
      const context = proxyContext(
        request({ "x-forwarded-for": "not an ip" }),
        config(["127.0.0.1/32"]),
      );
      expect(context.client).toBeUndefined();
    });
  });

  /*
   * A prefix that cannot work used to be dropped in silence, which turned one
   * typo into a lost mount point and a redirect to nowhere. These are the checks
   * that turn it into a message.
   */

  describe("describeBasePathProblem", () => {
    it("accepts a plain path and an empty value", () => {
      expect(describeBasePathProblem("/sec")).toBeUndefined();
      expect(describeBasePathProblem("/a/b")).toBeUndefined();
      expect(describeBasePathProblem("")).toBeUndefined();
      expect(describeBasePathProblem("  ")).toBeUndefined();
      expect(describeBasePathProblem(undefined)).toBeUndefined();
    });

    it("points a URL at publicUrl instead", () => {
      const problem = describeBasePathProblem("https://example.com/sec/");
      expect(problem).toBeTypeOf("string");
      expect(problem).toContain("publicUrl");
    });

    it("rejects anything that is not an absolute plain path", () => {
      for (const bad of ["static", "//evil.example.com", "/sec/../x", "/a b", "sec/"]) {
        expect(describeBasePathProblem(bad), bad).toBeTypeOf("string");
      }
    });
  });

  describe("trustedProxyProblems", () => {
    it.each<[string, string[], number, string?]>([
      ["accepts addresses and CIDR blocks", ["127.0.0.1", "10.0.0.0/8", "::1", "::1/128"], 0],
      ["ignores blanks", ["", "  "], 0],
      // The bug: `isIP("127.0.0.1:8787")` is false, so the entry was skipped
      // and the trust list came out empty.
      ["names a port as the mistake it usually is", ["127.0.0.1:8787/32"], 1, "port"],
      ["rejects a value that is neither an address nor a valid block: a name", ["localhost"], 1, "neither"],
      ["rejects a value that is neither an address nor a valid block: a long block", ["127.0.0.1/64"], 1],
      ["rejects a value that is neither an address nor a valid block: one bad entry among good", ["10.0.0.0/8", "nonsense"], 1],
    ])("%s", (_name, list, count, text) => {
      const problems = trustedProxyProblems(list);
      if (count === 0) expect(problems).toEqual([]);
      expect(problems).toHaveLength(count);
      if (text !== undefined) expect(problems[0]).toContain(text);
    });
  });
});

describe("json-data-block.test.ts", () => {
  // The fourth column is the whole element as text, for the rows where it is short
  // enough to spell out, so the table is not a copy of the code it checks.
  const BLOCKS: ReadonlyArray<readonly [string, string, unknown, string?]> = [
    ["a plain list", "pages-links", [{ label: "PRs", path: "/github/pr/" }]],
    ["an empty list", "pages-links", [], '<script type="application/json" id="pages-links">[]</script>'],
    ["an angle bracket in a label", "pages-links", [{ label: "Pull <requests>", path: "/github/pr/" }]],
    ["an element end in a value", "usage-first", { name: "Fixture <Meter> & Co </script><img>" }],
    ["a dollar pattern", "usage-first", { name: "$& $' $1" }],
  ];

  it.each(BLOCKS)("writes %s as one data block that no value can end", (_label, id, value, literal) => {
    const block = jsonDataBlock(id, value);
    if (literal !== undefined) expect(block).toBe(literal);
    const inner = new RegExp(`^<script type="application/json" id="${id}">([\\s\\S]*)</script>$`).exec(block)?.[1] ?? "";
    // Every "<" in the block is the escape.
    expect(inner).not.toContain("<");
    expect(inner).toBe(JSON.stringify(value).replaceAll("<", "\\u003c"));
    // The escape is JSON's own, so the page reads the value back.
    expect(JSON.parse(inner)).toEqual(value);
  });
});

describe("ui-markup.test.ts", () => {
  function reasonOf(html: string, css?: string): string {
    const result = checkCardMarkup(html, css);
    if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(html)}`);
    return result.reason;
  }

  function accepted(html: string, css?: string): { html: string; css: string } {
    const result = checkCardMarkup(html, css);
    if (!result.ok) {
      throw new Error(`expected acceptance for ${JSON.stringify(html)}: ${result.reason}`);
    }
    return { html: result.html, css: result.css };
  }

  describe("rejected elements", () => {
    // <frame> and <frameset> are dropped by the HTML parser in body content, so
    // the other ten are the ones that can reach the tree in the HTML namespace.
    const ELEMENTS = [
      "script",
      "style",
      "template",
      "link",
      "meta",
      "base",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "form",
    ];
    const IN_HTML = ELEMENTS.filter((tag) => tag !== "frame" && tag !== "frameset");

    for (const tag of IN_HTML) {
      it(`refuses <${tag}> inside a card`, () => {
        expect(reasonOf(`<div><${tag}></${tag}></div>`)).toContain(`<${tag}>`);
      });
    }

    it("refuses frame and frameset, which only reach the tree inside <svg>", () => {
      expect(reasonOf("<svg><frame></frame></svg>")).toContain("<frame>");
      expect(reasonOf("<svg><frameset></frameset></svg>")).toContain("<frameset>");
      expect(accepted("<div><frame></frame></div>").html).toBe("<div></div>");
      expect(accepted("<div><frameset></frameset></div>").html).toBe("<div></div>");
    });

    it("refuses every rejected element written inside <svg>", () => {
      for (const tag of ELEMENTS) {
        expect(reasonOf(`<svg><${tag}></${tag}></svg>`)).toContain(`<${tag}>`);
      }
    });

    it("names the first problem in the reason", () => {
      expect(reasonOf("<script></script><style></style>")).toBe("element <script> is not allowed");
    });
  });

  describe("rejected attributes", () => {
    it("refuses an on* attribute", () => {
      expect(reasonOf('<div onclick="alert(1)">a</div>')).toContain("onclick");
      expect(reasonOf('<div ONLOAD="alert(1)">a</div>')).toContain("onload");
      expect(reasonOf('<div onmouseover="alert(1)">a</div>')).toContain("onmouseover");
    });

    it("refuses a style attribute", () => {
      expect(reasonOf('<div style="color: red">a</div>')).toContain("style");
    });
  });

  describe("URL attributes", () => {
    it("refuses javascript: in href, including obfuscated forms", () => {
      const values = [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "  javascript:alert(1)",
        "java\tscript:alert(1)",
        "&#106;avascript:alert(1)",
        "javascript&colon;alert(1)",
      ];
      for (const value of values) {
        expect(reasonOf(`<a href="${value}">a</a>`)).toMatch(/href/);
      }
    });

    it("refuses javascript: in xlink:href", () => {
      const reason = reasonOf('<svg><a xlink:href="javascript:alert(1)">a</a></svg>');
      expect(reason).toContain("xlink:href");
    });

    it("allows a safe xlink:href", () => {
      expect(checkCardMarkup('<svg><a xlink:href="https://cards.invalid/x">a</a></svg>').ok).toBe(
        true,
      );
    });

    it("refuses vbscript: whatever the attribute name", () => {
      expect(reasonOf('<div title="vbscript:msgbox(1)">a</div>')).toContain("title");
    });

    it("refuses protocol-relative and backslash URLs", () => {
      expect(reasonOf('<img src="//other.host/x.png">')).toMatch(/src/);
      expect(reasonOf('<a href="//other.host/x">a</a>')).toMatch(/href/);
      expect(reasonOf('<a href="\\\\other.host\\x">a</a>')).toMatch(/href/);
    });

    it("refuses a slash-then-backslash URL, which the browser reads as //host", () => {
      // Two slashes name another host. A browser treats `/\\host` as `//host`, so a
      // check that only looked for `//` would let this one through.
      expect(reasonOf('<img src="/\\other.host/x.png">')).toMatch(/src/);
      expect(reasonOf('<a href="/\\other.host/x">a</a>')).toMatch(/href/);
      expect(reasonOf('<img srcset="/\\other.host/x 2x">')).toMatch(/srcset/);
      // A single forward slash stays an ordinary path on this host.
      expect(checkCardMarkup('<a href="/assets/x.png">a</a>').ok).toBe(true);
    });

    it("refuses data: URLs other than an image on img", () => {
      expect(reasonOf('<a href="data:text/html,<b>x</b>">a</a>')).toMatch(/href/);
      expect(reasonOf('<a href="data:image/png;base64,AA">a</a>')).toMatch(/href/);
      expect(reasonOf('<img src="data:text/html,<b>x</b>">')).toMatch(/src/);
      expect(checkCardMarkup('<img src="data:image/svg+xml,<svg></svg>">').ok).toBe(true);
    });

    it("allows a data image on img src and srcset", () => {
      expect(accepted('<img src="data:image/png;base64,iVBORw0KGgo=">').html).toBe(
        '<img src="data:image/png;base64,iVBORw0KGgo=">',
      );
    });

    it("allows http, https, relative and fragment URLs", () => {
      for (const value of [
        "https://cards.invalid/x",
        "http://cards.invalid/x",
        "cards/x.png",
        "./x.css",
        "/assets/x.png",
        "#frag",
        "?q=1",
        "",
      ]) {
        expect(checkCardMarkup(`<a href="${value}">a</a>`).ok).toBe(true);
      }
    });

    it("checks every srcset candidate", () => {
      expect(reasonOf('<img srcset="a.png 1x, javascript:alert(1) 2x">')).toMatch(/srcset/);
      expect(reasonOf('<img srcset="a.png 1x, //other.host/x 2x">')).toMatch(/srcset/);
      const result = accepted('<img srcset="a.png 1x, data:image/png;base64,AA 2x">');
      expect(result.html).toContain("data:image/png;base64,AA 2x");
    });

    it("applies the URL rules to the other URL attributes", () => {
      expect(reasonOf('<video poster="javascript:alert(1)"></video>')).toMatch(/poster/);
      expect(reasonOf('<input formaction="//other.host/x">')).toMatch(/formaction/);
      expect(reasonOf('<a ping="//other.host/x">a</a>')).toMatch(/ping/);
      expect(reasonOf('<div background="//other.host/x">a</div>')).toMatch(/background/);
    });
  });

  describe("size", () => {
    it("allows exactly 64 KiB and refuses one byte more", () => {
      expect(checkCardMarkup("a".repeat(UI_MARKUP_MAX_BYTES)).ok).toBe(true);
      expect(reasonOf("a".repeat(UI_MARKUP_MAX_BYTES + 1))).toContain("65536");
    });

    it("counts UTF-8 bytes, not characters", () => {
      const text = "가".repeat(Math.floor(UI_MARKUP_MAX_BYTES / 3) + 1);
      expect(text.length).toBeLessThan(UI_MARKUP_MAX_BYTES);
      expect(reasonOf(text)).toContain("65536");
    });

    it("counts html and css together", () => {
      expect(checkCardMarkup("a".repeat(UI_MARKUP_MAX_BYTES - 1), "a").ok).toBe(true);
      expect(reasonOf("a".repeat(UI_MARKUP_MAX_BYTES), "a")).toContain("65536");
    });
  });

  describe("css", () => {
    it("refuses css that closes its style element", () => {
      expect(reasonOf("<div></div>", "div{}</style><script>alert(1)</script>")).toContain("style");
      expect(reasonOf("<div></div>", "div{}</STYLE>")).toContain("style");
    });

    it("refuses css with an HTML comment opener", () => {
      expect(reasonOf("<div></div>", "/* <!-- */")).toContain("<!--");
    });

    it("passes ordinary css through", () => {
      expect(accepted("<div></div>", "div{color:red}").css).toBe("div{color:red}");
    });
  });

  describe("broken markup", () => {
    it("closes elements the card left open", () => {
      expect(accepted("<div><b>x").html).toBe("<div><b>x</b></div>");
    });

    it("drops comments, including an unclosed one", () => {
      expect(accepted("<div><!-- note --><b>x</b></div>").html).toBe("<div><b>x</b></div>");
      const unclosed = accepted("before <!-- never closed");
      expect(unclosed.html).not.toContain("<!--");
      expect(unclosed.html).toContain("before");
    });

    it("does not turn a stray end tag into markup", () => {
      const output = accepted("</template></div></div>").html;
      expect(output).not.toContain("</template>");
      expect(output).not.toContain("</div>");
      expect(accepted("a </template> b").html).not.toContain("</template>");
      // The card after the stray tags survives, so it can sit inside the page's template.
      expect(accepted("</template></div></div><div>card</div>").html).toBe("<div>card</div>");
    });

    it("escapes text that looks like an end tag", () => {
      expect(accepted("&lt;/template&gt;").html).toBe("&lt;/template&gt;");
    });
  });

  describe("result shape", () => {
    it("returns the serialized markup and the css", () => {
      expect(checkCardMarkup('<div class="x">a &amp; b</div>', "div{color:red}")).toEqual({
        ok: true,
        html: '<div class="x">a &amp; b</div>',
        css: "div{color:red}",
      });
    });

    it("returns an empty css when the card gave none", () => {
      expect(checkCardMarkup("<b>x</b>")).toEqual({ ok: true, html: "<b>x</b>", css: "" });
    });
  });
});
