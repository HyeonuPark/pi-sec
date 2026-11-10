import { commitWrites } from "@earendil-works/pi-durable/testing";
import { readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { AdminNotes } from "../src/runtime/notes.ts";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { loadConfig } from "../src/config/load.ts";
import { SseHub } from "../src/server/sse.ts";
import { RestartLauncher } from "../src/runtime/restart-helper.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps, UiRestartOutcome } from "../src/server/deps.ts";
import { createInboxItemTx } from "../src/extensions/notify.ts";
import { SecAgent, SecUserQueryList } from "../src/documents.ts";
import { resolveRoutineApproval } from "../src/jobs/registry.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

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
  readonly id: number;
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
      const id = Number(lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "0");
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return [{ id, event, data }];
    });
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("http server", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(
    options: Parameters<typeof createTestHarness>[0] = {},
    extra: { reloadConfig?: () => Promise<void> } = {},
  ): Promise<{ origin: string; deps: AppDeps }> {
    harness = await createTestHarness({
      ...options,
      config: {
        ...(options.config ?? {}),
        server: { ...defaultConfig().server, ...(options.config?.server ?? {}), port: 0 },
      },
    });
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
      ...(extra.reloadConfig === undefined ? {} : { reloadConfig: extra.reloadConfig }),
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin, deps };
  }

  it("reports health", async () => {
    const { origin } = await boot();
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; apiVersion: number; scheduler: string };
    expect(body.status).toBe("ok");
    expect(body.apiVersion).toBe(1);
    expect(response.headers.get("x-api-version")).toBe("1");
    expect(body.scheduler).toBe("running");
  });

  it("says the scheduler is off when the configuration turns it off", async () => {
    const { origin } = await boot({ config: { scheduler: { ...defaultConfig().scheduler, enabled: false } } });
    const response = await fetch(`${origin}/healthz`);
    const body = (await response.json()) as { scheduler: string };
    expect(body.scheduler).toBe("disabled");
  });

  it("serves the chat UI", async () => {
    const { origin } = await boot();
    const response = await fetch(`${origin}/basic-chat`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("pi-sec");
    expect(html).toContain("ui-chat.js");
  });

  it("admits a message, answers it, and streams events", async () => {
    const { origin } = await boot({ responses: [fauxAssistantMessage([fauxText("streamed answer")])] });

    const controller = new AbortController();
    const streamResponse = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const initial = await readUntil(reader, (buffer) => buffer.includes("event: snapshot"));
    expect(initial).toContain("event: snapshot");

    const post = await fetch(`${origin}/basic-chat/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(post.status).toBe(202);

    const finalBuffer = await readUntil(reader, (buffer) => buffer.includes("event: run_end"));
    expect(finalBuffer).toContain("event: run_start");
    expect(finalBuffer).toContain("streamed answer");
    controller.abort();
  });

  it("reports how full the context is, against the point where compaction fires", async () => {
    const { origin } = await boot({ responses: [fauxAssistantMessage([fauxText("answer")])] });
    const readContext = async (): Promise<{ used: number | null; max: number; window: number; reserveTokens: number }> => {
      const response = await fetch(`${origin}/basic-chat/context`);
      expect(response.status).toBe(200);
      return (await response.json()) as { used: number | null; max: number; window: number; reserveTokens: number };
    };

    // Nothing has answered in this context yet, so nothing is measured. The two
    // bounds are known anyway: the window comes from the model catalog and the
    // reserve from the config.
    const before = await readContext();
    expect(before.used).toBeNull();
    expect(before.reserveTokens).toBe(defaultConfig().agent.compaction.reserveTokens);
    expect(before.max).toBe(before.window - before.reserveTokens);

    const controller = new AbortController();
    const stream = await fetch(`${origin}/basic-chat/events`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    await readUntil(reader, (buffer) => buffer.includes("event: snapshot"));
    await fetch(`${origin}/basic-chat/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    await readUntil(reader, (buffer) => buffer.includes("event: run_end"));
    controller.abort();

    // The answer is the request that filled the context, so its size is what the
    // bar is filled with.
    const after = await readContext();
    expect(after.used).toBeGreaterThan(0);
    expect(after.used!).toBeLessThan(after.max);
  });

  describe("behind a reverse proxy", () => {
    const trusting = () => ({ ...defaultConfig().server, port: 0, trustedProxies: ["127.0.0.1/32"] });

    /** Send a request with a `Host` header of our choosing: `fetch` will not. */
    function statusForHost(origin: string, host: string): Promise<number> {
      const { hostname, port } = new URL(origin);
      return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname, port, path: "/healthz", method: "GET", headers: { host } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end();
      });
    }

    it("compares hostnames, so a port is not a different host and a suffix is not the host", async () => {
      const { origin } = await boot({ config: { server: { ...trusting(), publicUrl: "https://agent.example.com/sec" } } });

      expect(await statusForHost(origin, "agent.example.com")).toBe(200);
      // Same host, another port: the identity being compared is the hostname.
      expect(await statusForHost(origin, "agent.example.com:8443")).toBe(200);
      // Loopback always works, on any port.
      expect(await statusForHost(origin, "127.0.0.1:9999")).toBe(200);
      expect(await statusForHost(origin, "[::1]:9999")).toBe(200);
      // A name that merely starts with a loopback address is not loopback.
      expect(await statusForHost(origin, "127.0.0.1.evil.example")).toBe(421);
      expect(await statusForHost(origin, "localhost.evil.example")).toBe(421);
      expect(await statusForHost(origin, "evil.example")).toBe(421);
    });

    it("stamps the asset URLs, so they do not follow the page URL's shape", async () => {
      const { origin } = await boot({ config: { server: { ...defaultConfig().server, port: 0, basePath: "/sec" } } });

      const page = await (await fetch(`${origin}/sec/basic-chat`)).text();
      // No placeholder survives, and every asset carries the mount: a relative
      // URL resolved against `/sec/basic-chat/` used to reach a different route
      // than the same asset resolved against `/sec/basic-chat`.
      expect(page).not.toContain("{{base}}");
      expect(page).toContain('href="/sec/theme.css"');
      expect(page).toContain('src="/sec/ui-chat.js"');
      expect(page).toContain('src="/sec/base.js"');

      // And those URLs are the ones the server actually serves.
      expect((await fetch(`${origin}/sec/theme.css`)).status).toBe(200);
      expect((await fetch(`${origin}/sec/base.js`)).status).toBe(200);
    });

    it("stamps the harness time zone into the page, and follows a reload", async () => {
      const { origin, deps } = await boot({ config: { timezone: "Asia/Tokyo" } });

      expect(await (await fetch(`${origin}/basic-chat`)).text()).toContain(
        '<meta name="pi-sec-timezone" content="Asia/Tokyo" />',
      );

      // The zone is read from the config the runtime holds now, so a reload
      // changes what the next page load says, with no restart.
      deps.runtime.setConfig({ ...deps.runtime.getConfig(), timezone: "UTC" });
      expect(await (await fetch(`${origin}/basic-chat`)).text()).toContain(
        '<meta name="pi-sec-timezone" content="UTC" />',
      );
    });

    it("names the mount when a path arrives without it", async () => {
      const { origin } = await boot({ config: { server: { ...defaultConfig().server, port: 0, basePath: "/sec" } } });
      const response = await fetch(`${origin}/basic-chat`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("/sec");
    });

    it("tells the browser to revalidate the UI instead of keeping a stale copy", async () => {
      const { origin } = await boot();
      expect((await fetch(`${origin}/basic-chat`)).headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(`${origin}/base.js`)).headers.get("cache-control")).toBe("no-cache");
    });

    it("mounts under a prefix announced by a trusted proxy", async () => {
      const { origin } = await boot({ config: { server: trusting() } });
      const headers = { "X-Forwarded-Prefix": "/sec" };

      // The proxy strips the prefix, so the bare path must still route...
      const health = await fetch(`${origin}/healthz`, { headers });
      expect(health.status).toBe(200);

      // ...and the page is told where it is really mounted.
      const page = await fetch(`${origin}/basic-chat`, { headers });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<meta name="pi-sec-base" content="/sec" />');

      // ...and hitting the root goes to the external mount point.
      const redirect = await fetch(`${origin}/`, { headers, redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/sec/basic-chat");
    });

    it("tolerates a proxy that forwards the prefix unstripped", async () => {
      const { origin } = await boot({ config: { server: trusting() } });
      const page = await fetch(`${origin}/sec/basic-chat`, { headers: { "X-Forwarded-Prefix": "/sec" } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<meta name="pi-sec-base" content="/sec" />');
    });

    it("redirects a root that arrives with the prefix still attached", async () => {
      const { origin } = await boot({ config: { server: trusting() } });
      const headers = { "X-Forwarded-Prefix": "/sec" };
      // This used to 404: the root redirect ran before the prefix was stripped,
      // so the path was still `/sec/` and never equalled `/`.
      const redirect = await fetch(`${origin}/sec/`, { headers, redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/sec/basic-chat");
    });

    it("derives the mount point from publicUrl when no prefix is announced", async () => {
      // An arrangement where the proxy strips the prefix and
      // announces nothing, so `publicUrl` is the only thing that names the mount.
      const { origin } = await boot({
        config: { server: { ...defaultConfig().server, port: 0, basePath: "", publicUrl: "https://example.com/sec" } },
      });

      const redirect = await fetch(`${origin}/`, { redirect: "manual" });
      expect(redirect.headers.get("location")).toBe("/sec/basic-chat");

      const unstripped = await fetch(`${origin}/sec/`, { redirect: "manual" });
      expect(unstripped.status).toBe(302);
      expect(unstripped.headers.get("location")).toBe("/sec/basic-chat");

      const page = await fetch(`${origin}/basic-chat`);
      expect(await page.text()).toContain('<meta name="pi-sec-base" content="/sec" />');

      const prefixedPage = await fetch(`${origin}/sec/basic-chat`);
      expect(prefixedPage.status).toBe(200);
    });

    it("ignores a forwarded prefix from a peer that is not trusted", async () => {
      const { origin } = await boot({ config: { server: { ...defaultConfig().server, port: 0, trustedProxies: ["10.0.0.0/8"] } } });
      const headers = { "X-Forwarded-Prefix": "/evil" };

      const page = await fetch(`${origin}/basic-chat`, { headers });
      expect(await page.text()).toContain('<meta name="pi-sec-base" content="" />');

      const redirect = await fetch(`${origin}/`, { headers, redirect: "manual" });
      expect(redirect.headers.get("location")).toBe("/basic-chat");
    });

    it("refuses a forwarded prefix that is not a plain path", async () => {
      const { origin } = await boot({ config: { server: trusting() } });
      for (const hostile of ["//evil.example.com", "/sec/../../x", "https://evil.example.com", "/a b"]) {
        const redirect = await fetch(`${origin}/`, {
          headers: { "X-Forwarded-Prefix": hostile },
          redirect: "manual",
        });
        expect(redirect.headers.get("location"), hostile).toBe("/basic-chat");
        const page = await fetch(`${origin}/basic-chat`, { headers: { "X-Forwarded-Prefix": hostile } });
        expect(await page.text(), hostile).toContain('<meta name="pi-sec-base" content="" />');
      }
      // A rejected prefix does not stand in for the configured mount.
      const mounted = await boot({ config: { server: { ...trusting(), basePath: "/sec" } } });
      const hostileHeaders = { "X-Forwarded-Prefix": "//evil.example.com" };
      expect((await fetch(`${mounted.origin}/healthz`, { headers: hostileHeaders })).status).toBe(404);
      expect((await fetch(`${mounted.origin}/sec/healthz`, { headers: hostileHeaders })).status).toBe(200);
    });

    it("still requires a locally configured basePath", async () => {
      const { origin } = await boot({ config: { server: { ...defaultConfig().server, port: 0, basePath: "/sec" } } });

      expect((await fetch(`${origin}/sec/healthz`)).status).toBe(200);
      expect((await fetch(`${origin}/healthz`)).status).toBe(404);
      const page = await fetch(`${origin}/sec/basic-chat`);
      expect(await page.text()).toContain('<meta name="pi-sec-base" content="/sec" />');
      const redirect = await fetch(`${origin}/`, { redirect: "manual" });
      expect(redirect.headers.get("location")).toBe("/sec/basic-chat");

      const bareMount = await fetch(`${origin}/sec`, { redirect: "manual" });
      expect(bareMount.status).toBe(302);
      expect(bareMount.headers.get("location")).toBe("/sec/basic-chat");
    });
  });

  describe("host and origin checks", () => {
    interface Reply {
      readonly status: number;
      readonly body: string;
    }

    /**
     * Send a request with headers `fetch` will not set for us, `Host` and
     * `Origin` among them, and read the answer.
     */
    function send(
      base: string,
      path: string,
      options: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ): Promise<Reply> {
      const { hostname, port } = new URL(base);
      return new Promise((resolve, reject) => {
        let answered = false;
        const req = httpRequest(
          { hostname, port, path, method: options.method ?? "GET", headers: options.headers ?? {} },
          (res) => {
            answered = true;
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        // A refused request is answered before its body is read, so the write of
        // that body can fail on a connection the server has already finished.
        req.on("error", (error) => {
          if (!answered) reject(error);
        });
        if (options.body !== undefined) req.write(options.body);
        req.end();
      });
    }

    function errorCode(reply: Reply): string {
      return (JSON.parse(reply.body) as { error: { code: string } }).error.code;
    }

    const creating = (title: string) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });

    it("accepts only loopback Host names when publicUrl is unset", async () => {
      const { origin } = await boot();
      const { port } = new URL(origin);

      expect((await send(origin, "/healthz", { headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
      // A name is not needed to tell this machine from another one.
      expect((await send(origin, "/healthz", { headers: { host: "localhost" } })).status).toBe(200);
      expect((await send(origin, "/healthz", { headers: { host: "[::1]" } })).status).toBe(200);

      // Any other name reaches this port only if someone pointed it here, which
      // is what a DNS-rebinding page does.
      const foreign = await send(origin, "/healthz", { headers: { host: "evil.example" } });
      expect(foreign.status).toBe(421);
      expect(errorCode(foreign)).toBe("misdirected");
      expect((await send(origin, "/healthz", { headers: { host: "localhost.evil.example" } })).status).toBe(421);
    });

    it("refuses a write from another site, and the write does not happen", async () => {
      const { origin } = await boot();

      const refused = await send(origin, "/api/jobs", {
        ...creating("from another site"),
        headers: { ...creating("from another site").headers, origin: "https://evil.example" },
      });
      expect(refused.status).toBe(403);
      expect(errorCode(refused)).toBe("origin_forbidden");
      expect(JSON.parse(refused.body)).toMatchObject({ error: { message: "origin not allowed" } });

      // Nothing was created: the same request without an `Origin` is the one that
      // creates a job, so the count is about the refused one alone.
      const before = (await (await fetch(`${origin}/api/jobs`)).json()) as { jobs: unknown[] };
      expect(before.jobs).toHaveLength(0);

      const accepted = await send(origin, "/api/jobs", creating("from another site"));
      expect(accepted.status).toBe(201);
      const after = (await (await fetch(`${origin}/api/jobs`)).json()) as { jobs: unknown[] };
      expect(after.jobs).toHaveLength(1);
    });

    it("treats a null Origin, and an Origin that is not a URL, as no origin at all", async () => {
      const { origin } = await boot();
      for (const value of ["null", "https://evil.example", "http://evil.example  http://other.example"]) {
        const request = creating("refused");
        const reply = await send(origin, "/api/jobs", {
          ...request,
          headers: { ...request.headers, origin: value },
        });
        expect(reply.status, value).toBe(403);
        expect(errorCode(reply), value).toBe("origin_forbidden");
      }
    });

    it("accepts a loopback origin on the port the server listens on", async () => {
      const { origin } = await boot();
      const { port } = new URL(origin);
      for (const name of ["127.0.0.1", "localhost"]) {
        const request = creating(`from ${name}`);
        const reply = await send(origin, "/api/jobs", {
          ...request,
          headers: { ...request.headers, origin: `http://${name}:${port}` },
        });
        expect(reply.status, name).toBe(201);
      }
    });

    it("refuses a loopback origin on another port", async () => {
      const { origin } = await boot();
      const { port } = new URL(origin);
      const request = creating("from another port");
      const reply = await send(origin, "/api/jobs", {
        ...request,
        headers: { ...request.headers, origin: `http://127.0.0.1:${Number(port) + 1}` },
      });
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("origin_forbidden");
    });

    it("accepts the origin publicUrl names, and still refuses another one", async () => {
      const { origin } = await boot({
        config: { server: { ...defaultConfig().server, port: 0, publicUrl: "https://agent.example.com/sec" } },
      });

      const page = creating("from the public address");
      const accepted = await send(origin, "/api/jobs", {
        ...page,
        headers: { ...page.headers, origin: "https://agent.example.com" },
      });
      expect(accepted.status).toBe(201);

      // The origin is what is compared, so a mount point appended to it is still
      // the same origin; the scheme and the host are not.
      const mounted = creating("with the mount point appended");
      const stillAccepted = await send(origin, "/api/jobs", {
        ...mounted,
        headers: { ...mounted.headers, origin: "https://agent.example.com/sec" },
      });
      expect(stillAccepted.status).toBe(201);

      for (const value of ["http://agent.example.com", "https://agent.example.com:8443", "https://other.example.com"]) {
        const request = creating("refused");
        const reply = await send(origin, "/api/jobs", { ...request, headers: { ...request.headers, origin: value } });
        expect(reply.status, value).toBe(403);
        expect(errorCode(reply), value).toBe("origin_forbidden");
      }
    });

    it("does not block a read from another site, including the two basic-chat GET routes", async () => {
      const { origin } = await boot();
      expect((await send(origin, "/healthz", { headers: { origin: "https://evil.example" } })).status).toBe(200);
      expect((await send(origin, "/basic-chat", { headers: { origin: "https://evil.example" } })).status).toBe(200);
      expect((await send(origin, "/basic-chat/context", { headers: { origin: "https://evil.example" } })).status).toBe(
        200,
      );
    });

    it("accepts a write with no Origin at all", async () => {
      // What the CLI, the scripts and a `fetch` from Node send.
      const { origin } = await boot();
      expect((await send(origin, "/api/jobs", creating("no origin"))).status).toBe(201);
    });
  });

  it("refuses a config reload that cannot load, and says why", async () => {
    let applied: Config | undefined;
    const { origin } = await boot(
      {},
      {
        reloadConfig: async () => {
          const next = await loadConfig({ home: harness!.paths.home });
          harness!.runtime.setConfig(next.config);
          applied = next.config;
        },
      },
    );
    const home = harness!.paths.home;
    const running = harness!.runtime.getConfig().server.basePath;

    await writeFile(join(home, "config.json"), JSON.stringify({ server: { basePath: "https://example.com/sec/" } }));
    const refused = await fetch(`${origin}/api/admin/reload`, { method: "POST" });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { status: string; issues: string[]; restartRequired: boolean };
    expect(body.status).toBe("config_failed");
    expect(body.issues.join(" ")).toContain("server.publicUrl");

    // The daemon keeps the config that loaded, so the mount point does not
    // disappear underneath a running server.
    expect(applied).toBeUndefined();
    expect(harness!.runtime.getConfig().server.basePath).toBe(running);

    // A restart would read the same file and refuse to start. Recording it as a
    // pending restart would be advice to brick the daemon.
    const status = (await (await fetch(`${origin}/api/admin/status`)).json()) as {
      configError: { issues: string[] } | null;
      restartRequired: boolean;
    };
    expect(body.restartRequired).toBe(false);
    expect(status.restartRequired).toBe(false);
    expect(status.configError?.issues.join(" ")).toContain("server.publicUrl");

    // A config that loads clears it again.
    await writeFile(join(home, "config.json"), JSON.stringify({ server: { basePath: "" } }));
    expect((await fetch(`${origin}/api/admin/reload`, { method: "POST" })).status).toBe(200);
    const cleared = (await (await fetch(`${origin}/api/admin/status`)).json()) as { configError: unknown };
    expect(cleared.configError).toBeNull();
  });

  /**
   * A conversation the faux provider refused for usage, put into a hold by one pass
   * of the watch. The probe that pass sends is refused too, so the hold stays and the
   * next probe waits ten minutes.
   */
  async function holdOneConversation(): Promise<number> {
    const runtime = harness!.runtime;
    const harnessTyped = harness!;
    const conversation = await runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: harnessTyped.faux.getModel().id }, thinkingLevel: "off" },
      },
      BACKGROUND_CONTEXT,
    );
    const id = Number(conversation.id);
    await runtime.harness.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "go", timestamp: Date.now() }],
      });
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [
          {
            ...fauxAssistantMessage("usage limit", {
              stopReason: "error",
              errorMessage: "429: This request would exceed your account's rate limit",
            }),
            provider: "faux",
          },
        ],
      });
      const record = await tx.doc(SecAgent, String(id), String(id));
      record.kind = "scheduled";
      record.name = "round";
      record.status = "running";
      record.createdAt = Date.now();
      record.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    const submission = await runtime.storage.mintId();
    await commitWrites(runtime.storage, [
        {
          type: "submission",
          value: {
            id: submission,
            conversationId: id,
            type: "input",
            status: "unanswered",
            reason: "model_error",
            detail: "429: This request would exceed your account's rate limit",
          },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    harnessTyped.faux.setResponses([
      fauxAssistantMessage("usage limit", { stopReason: "error", errorMessage: "429: nope" }),
    ]);
    const pass = await runtime.usageFreeze!.tick(BACKGROUND_CONTEXT);
    expect(pass.held).toBe(1);
    return id;
  }

  it("carries no held provider while nothing is held, and the one that is held after a refusal", async () => {
    // The status route answers the banner's value, so a page opened before any
    // refusal reads an empty list and draws no usage line.
    const { origin } = await boot();
    const empty = (await (await fetch(`${origin}/api/admin/status`)).json()) as {
      usageHold?: readonly unknown[];
    };
    expect(empty.usageHold).toEqual([]);

    // A conversation the provider refused for usage, and one pass of the watch:
    // the route now names the provider, and says how many conversations wait.
    expect(harness!.runtime.usageFreeze).toBeDefined();
    await holdOneConversation();

    const held = (await (await fetch(`${origin}/api/admin/status`)).json()) as {
      usageHold?: readonly { provider: string; conversations: number; readable: boolean }[];
    };
    expect(held.usageHold?.map((entry) => entry.provider)).toEqual(["faux"]);
    expect(held.usageHold?.[0]?.conversations).toBe(1);
    // The faux provider has no reader in this catalog, so the answer says so: the
    // banner then writes "checked with a short request" instead of a reset time.
    expect(held.usageHold?.[0]?.readable).toBe(false);
  });

  it("says a held conversation's message waits when a person sends it, and says nothing when a send was usual", async () => {
    const { origin } = await boot();
    const id = await holdOneConversation();
    const runtime = harness!.runtime;
    const callsBefore = harness!.faux.state.callCount;

    // The operator's own message into the held conversation: the text is stored and
    // no run starts, and the answer names the hold so the page can say so.
    const sent = await fetch(`${origin}/api/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "typed while the provider was refusing" }),
    });
    expect(sent.status).toBe(202);
    const answer = (await sent.json()) as { status: string; held?: boolean };
    expect(answer.status).toBe("accepted");
    expect(answer.held).toBe(true);
    expect(harness!.faux.state.callCount).toBe(callsBefore);

    // The transcript holds the text, which is the copy the retry carries.
    const entries = await runtime.storage.scanEntries(
      { conversationId: id, order: "ascending" },
      200,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const userTexts = entries.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) => (entry.model ?? [])[0] as { content?: unknown } | undefined)
      .map((message) => (typeof message?.content === "string" ? message.content : ""));
    expect(userTexts.some((text) => text.includes("typed while the provider was refusing"))).toBe(true);

    // A conversation nobody holds answers the ordinary 202: no field, and the run it
    // starts goes to the provider as it always did.
    const usual = await runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: harness!.faux.getModel().id }, thinkingLevel: "off" },
      },
      BACKGROUND_CONTEXT,
    );
    harness!.faux.setResponses([fauxAssistantMessage([fauxText("answered")])]);
    const ordinary = await fetch(`${origin}/api/conversations/${usual.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(ordinary.status).toBe(202);
    expect(((await ordinary.json()) as { held?: boolean }).held).toBeUndefined();
  });

  it("re-reads the secret names, so a file removed from the store leaves the list", async () => {
    const { origin } = await boot();
    const name = "reload-removes-me";
    const status = async () =>
      (await (await fetch(`${origin}/api/admin/status`)).json()) as { secretNames: string[] };

    // The one route that writes the store reloads the registry itself, so the
    // name is listed before the file goes away.
    const written = await fetch(`${origin}/api/admin/secrets/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text: "a value that stands in for a secret" }),
    });
    expect(written.status).toBe(200);
    expect((await status()).secretNames).toContain(name);

    // An operator deleting the file by hand leaves the registry holding a name
    // whose file is gone. Only a re-read of the directory clears it, and nothing
    // but a reload asks for one.
    await rm(join(harness!.paths.secretsDir, name));

    expect((await fetch(`${origin}/api/admin/reload`, { method: "POST" })).status).toBe(200);
    expect((await status()).secretNames).not.toContain(name);
  });

  it("creates and lists jobs over HTTP", async () => {
    const { origin } = await boot();
    const created = await fetch(`${origin}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "research", labels: ["research"] }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as { id: string; title: string };

    const list = await fetch(`${origin}/api/jobs`);
    const body = (await list.json()) as { jobs: { id: string }[] };
    expect(body.jobs.some((entry) => entry.id === job.id)).toBe(true);

    const cancelled = await fetch(`${origin}/api/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { status: string }).status).toBe("cancelled");
  });

  it("cancels the open descendants of a job over HTTP, and leaves finished ones alone", async () => {
    const { origin } = await boot();
    const jobs = harness!.runtime.jobs;
    const ctx = BACKGROUND_CONTEXT;
    const parent = await jobs.create(ctx, { title: "parent" });
    const open = await jobs.create(ctx, { title: "open child", parentId: parent.id });
    await jobs.update(ctx, open.id, { status: "active" });
    const done = await jobs.create(ctx, { title: "done child", parentId: parent.id });
    const doneRecord = await jobs.update(ctx, done.id, { status: "done" });
    const failed = await jobs.create(ctx, { title: "failed child", parentId: parent.id });
    await jobs.update(ctx, failed.id, { status: "failed" });
    // A finished job can still hold open work under it, and that work is cancelled.
    const grandchild = await jobs.create(ctx, { title: "open grandchild", parentId: done.id });

    const cancelled = await fetch(`${origin}/api/jobs/${parent.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);

    expect((await jobs.get(ctx, parent.id))?.status).toBe("cancelled");
    expect((await jobs.get(ctx, open.id))?.status).toBe("cancelled");
    expect((await jobs.get(ctx, grandchild.id))?.status).toBe("cancelled");
    // Finished work keeps what it ended as, and when.
    expect((await jobs.get(ctx, done.id))?.status).toBe("done");
    expect((await jobs.get(ctx, done.id))?.completedAt).toBe(doneRecord.completedAt);
    expect((await jobs.get(ctx, failed.id))?.status).toBe("failed");
  });

  it("asks one approval for an open routine descendant over HTTP, and cancels it with that approval", async () => {
    const { origin } = await boot();
    const runtime = harness!.runtime;
    const ctx = BACKGROUND_CONTEXT;
    const planJob = await runtime.jobs.create(ctx, { title: "plan" });
    const report = await runtime.reports.create(ctx, { jobId: planJob.id, title: "Plan", content: "one\n" });
    expect((await runtime.reports.approve(ctx, report.id, 1, { via: "panel" })).ok).toBe(true);
    const parent = await runtime.jobs.create(ctx, { title: "parent" });
    const outcome = await resolveRoutineApproval({
      reports: runtime.reports,
      context: ctx,
      reportId: report.id,
      gate: { gated: true, reasons: ["creates a job that carries a routine"] },
    });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const routineChild = await runtime.jobs.create(ctx, {
      title: "nightly",
      parentId: parent.id,
      routine: { cron: "0 6 * * *", timezone: "UTC", prompt: "run", enabled: true },
      routineApproval: outcome.approval,
    });

    // No reportId: the button is not refused for the descendant as such, but the
    // routine under it still needs the approval every routine close needs.
    const refused = await fetch(`${origin}/api/jobs/${parent.id}/cancel`, { method: "POST" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error?: { message?: string } }).error?.message ?? "").toContain(routineChild.id);
    expect((await runtime.jobs.get(ctx, parent.id))?.status).toBe("planned");
    expect((await runtime.jobs.get(ctx, routineChild.id))?.status).toBe("planned");

    const approved = await fetch(`${origin}/api/jobs/${parent.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId: report.id }),
    });
    expect(approved.status).toBe(200);
    expect((await runtime.jobs.get(ctx, parent.id))?.status).toBe("cancelled");
    expect((await runtime.jobs.get(ctx, routineChild.id))?.status).toBe("cancelled");
  });

/**
 * One SSE client, pumped continuously. Nothing is read on demand, so no frame
 * can be swallowed by a read that was abandoned while it was still pending.
 */
class ChatClient {
  #buffer = "";
  #decoder = new TextDecoder();

  private constructor(
    readonly controller: AbortController,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.#buffer += this.#decoder.decode(value, { stream: true });
        }
      } catch {
        /* aborted at the end of the test */
      }
    })();
  }

  static async open(origin: string, path: string, headers: Record<string, string> = {}): Promise<ChatClient> {
    const controller = new AbortController();
    const response = await fetch(`${origin}${path}`, { headers, signal: controller.signal });
    expect(response.status).toBe(200);
    return new ChatClient(controller, response.body!.getReader());
  }

  get text(): string {
    return this.#buffer;
  }

  /** Wait until what has arrived satisfies `what`; throws rather than hanging. */
  async waitFor(what: (text: string) => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!what(this.#buffer)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; received:\n${this.#buffer}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Let late frames land, so a duplicate cannot slip past the count. */
  settle(ms = 300): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  close(): void {
    this.controller.abort();
  }
}

const sawSnapshot = (text: string) => text.includes("event: snapshot");
const sawRunEnd = (text: string) => text.includes("event: run_end");
const inboxItems = (text: string) => countOf(text, "event: inbox_item");

describe("with more than one client attached", () => {
  // One window per SSE connection, but one upstream source per endpoint. A
  // second connection must join the fan-out, never become a second source:
  // otherwise every event is published once per attached client, and each
  // client renders the whole run again for every other window that is open.
  it("delivers a conversation event to each client exactly once", async () => {
    const { origin } = await boot({ responses: [fauxAssistantMessage([fauxText("streamed answer")])] });
    const clients = [await ChatClient.open(origin, "/basic-chat/events"), await ChatClient.open(origin, "/basic-chat/events")];
    await Promise.all(clients.map((client) => client.waitFor(sawSnapshot, "the snapshot")));

    const post = await fetch(`${origin}/basic-chat/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(post.status).toBe(202);

    await Promise.all(clients.map((client) => client.waitFor(sawRunEnd, "the end of the run")));
    await Promise.all(clients.map((client) => client.settle()));
    clients.forEach((client) => client.close());

    for (const client of clients) {
      expect(countOf(client.text, "event: run_start")).toBe(1);
      expect(countOf(client.text, "event: run_end")).toBe(1);
      const announced = parseFrames(client.text)
        .filter((frame) => frame.event === "message_end")
        .map((frame) => (JSON.parse(frame.data) as { entry: { id: number } }).entry.id);
      expect(announced.length).toBeGreaterThan(0);
      expect(new Set(announced).size).toBe(announced.length);
    }
  });

  it("delivers a control event to each client exactly once", async () => {
    const { origin, deps } = await boot();
    const clients = [await ChatClient.open(origin, "/basic-chat/events"), await ChatClient.open(origin, "/basic-chat/events")];
    await Promise.all(clients.map((client) => client.waitFor(sawSnapshot, "the snapshot")));

    deps.bus.sink.emit("inbox_item", { id: "item-1" });

    await Promise.all(clients.map((client) => client.waitFor((text) => inboxItems(text) === 1, "the control event")));
    await Promise.all(clients.map((client) => client.settle()));
    clients.forEach((client) => client.close());
    for (const client of clients) expect(inboxItems(client.text)).toBe(1);
  });

  it("carries a report event on the conversation stream", async () => {
    // A report write leaves an inbox item behind it, and this event is how an open
    // page learns to read the inbox again.
    const { origin, deps } = await boot();
    const client = await ChatClient.open(origin, "/basic-chat/events");
    await client.waitFor(sawSnapshot, "the snapshot");

    deps.bus.sink.emit("report_updated", { id: "report-1" });

    await client.waitFor((text) => countOf(text, "event: report_updated") === 1, "the report event");
    client.close();
  });

  it("delivers a job event to each client exactly once", async () => {
    const { origin, deps } = await boot();
    const clients = [await ChatClient.open(origin, "/api/jobs/events"), await ChatClient.open(origin, "/api/jobs/events")];
    await Promise.all(clients.map((client) => client.waitFor(sawSnapshot, "the job snapshot")));

    deps.bus.sink.emit("job_created", { id: "job-1" });

    await Promise.all(clients.map((client) => client.waitFor((text) => countOf(text, "event: job_created") === 1, "the job event")));
    await Promise.all(clients.map((client) => client.settle()));
    clients.forEach((client) => client.close());
    for (const client of clients) expect(countOf(client.text, "event: job_created")).toBe(1);
  });

  it("resumes a reconnecting client from the frame buffer, not from a snapshot", async () => {
    const { origin, deps } = await boot();
    const kept = await ChatClient.open(origin, "/basic-chat/events");
    await kept.waitFor(sawSnapshot, "the snapshot");

    deps.bus.sink.emit("inbox_item", { id: "seen" });
    await kept.waitFor((text) => inboxItems(text) === 1, "the first control event");
    const lastId = Math.max(...parseFrames(kept.text).map((frame) => frame.id));
    expect(lastId).toBeGreaterThan(0);

    // A client that knows how far it got is served the frames after that id.
    const resumed = await ChatClient.open(origin, "/basic-chat/events", { "last-event-id": String(lastId) });
    await resumed.settle(200);
    expect(resumed.text).not.toContain("event: snapshot");

    deps.bus.sink.emit("inbox_item", { id: "after" });
    await Promise.all([
      kept.waitFor((text) => inboxItems(text) === 2, "the second control event"),
      resumed.waitFor((text) => inboxItems(text) === 1, "the replayed control event"),
    ]);
    await Promise.all([kept.settle(), resumed.settle()]);
    kept.close();
    resumed.close();

    expect(inboxItems(kept.text)).toBe(2);
    expect(inboxItems(resumed.text)).toBe(1);
    expect(resumed.text).toContain("after");
    expect(resumed.text).not.toContain("seen");
  });

  it("delivers a question event to each client exactly once", async () => {
    const { origin, deps } = await boot();
    const clients = [
      await ChatClient.open(origin, "/api/user-queries/events"),
      await ChatClient.open(origin, "/api/user-queries/events"),
    ];
    await Promise.all(clients.map((client) => client.waitFor(sawSnapshot, "the question snapshot")));

    deps.bus.sink.emit("user_query", { id: "q-1" });

    await Promise.all(clients.map((client) => client.waitFor((text) => countOf(text, "event: user_query\n") >= 1, "the question event")));
    await Promise.all(clients.map((client) => client.settle()));
    clients.forEach((client) => client.close());
    for (const client of clients) expect(countOf(client.text, "event: user_query\n")).toBe(1);
  });

  it("sends a question event that arrives during the snapshot read after the snapshot", async () => {
    const { origin, deps } = await boot();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harness = deps.runtime.harness;
    const original = harness.snapshot.bind(harness) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(harness, "snapshot").mockImplementation((async (...args: unknown[]) => {
      if (args[0] === SecUserQueryList) await gate;
      return await original(...args);
    }) as never);
    let client: ChatClient | undefined;
    try {
      client = await ChatClient.open(origin, "/api/user-queries/events");
      deps.bus.sink.emit("user_query", { id: "q-during" });
      await client.settle(100);
    } finally {
      open();
    }
    await client.waitFor(sawSnapshot, "the question snapshot");
    await client.settle();
    client.close();
    const events = parseFrames(client.text).map((frame) => frame.event);
    expect(events.filter((event) => event !== "notice")).toEqual(["snapshot", "user_query"]);
  });

  it("replays a question event made while no client was attached", async () => {
    const { origin, deps } = await boot();
    const first = await ChatClient.open(origin, "/api/user-queries/events");
    await first.waitFor(sawSnapshot, "the question snapshot");
    deps.bus.sink.emit("user_query", { id: "q-seen" });
    await first.waitFor((text) => countOf(text, "event: user_query\n") === 1, "the first question event");
    const lastId = Math.max(...parseFrames(first.text).map((frame) => frame.id));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    deps.bus.sink.emit("user_query", { id: "q-while-idle" });
    const resumed = await ChatClient.open(origin, "/api/user-queries/events", { "last-event-id": String(lastId) });
    await resumed.settle(200);
    resumed.close();
    expect(resumed.text).toContain("q-while-idle");
    expect(resumed.text).not.toContain("event: snapshot");
  });

  it("sends a job event that arrives during the snapshot reads after the snapshot", async () => {
    const { origin, deps } = await boot();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const jobs = deps.runtime.jobs;
    const original = jobs.tree.bind(jobs);
    vi.spyOn(jobs, "tree").mockImplementation((async (...args: Parameters<typeof original>) => {
      await gate;
      return await original(...args);
    }) as never);
    let client: ChatClient | undefined;
    try {
      client = await ChatClient.open(origin, "/api/jobs/events");
      deps.bus.sink.emit("job_updated", { id: "job-during" });
      await client.settle(100);
    } finally {
      open();
    }
    await client.waitFor(sawSnapshot, "the job snapshot");
    await client.settle();
    client.close();
    const events = parseFrames(client.text).map((frame) => frame.event);
    expect(events.filter((event) => event !== "notice")).toEqual(["snapshot", "job_updated"]);
  });

  it("answers 404 to an event stream of a conversation that does not exist", async () => {
    const { origin, deps } = await boot();
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/conversations/987654/events`, { signal: controller.signal });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
      expect(deps.streams.conversationCount).toBe(0);
    } finally {
      controller.abort();
    }
  });

  it("drops the endpoint of a conversation when its last client leaves", async () => {
    const { origin, deps } = await boot();
    const created = (await (await fetch(`${origin}/api/conversations`, { method: "POST" })).json()) as { id: number };
    const client = await ChatClient.open(origin, `/api/conversations/${created.id}/events`);
    await client.waitFor(sawSnapshot, "the snapshot");
    expect(deps.streams.conversationCount).toBe(1);
    expect(deps.sse.has(`conversation:${created.id}`)).toBe(true);

    client.close();
    const deadline = Date.now() + 3000;
    while (deps.streams.conversationCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(deps.streams.conversationCount).toBe(0);
    expect(deps.sse.has(`conversation:${created.id}`)).toBe(false);
  });

  it("keeps one stream for clients that attach while the endpoint is being dropped", async () => {
    const { origin, deps } = await boot();
    const first = await ChatClient.open(origin, "/basic-chat/events");
    await first.waitFor(sawSnapshot, "the snapshot");
    first.close();

    const clients = await Promise.all([
      ChatClient.open(origin, "/basic-chat/events"),
      ChatClient.open(origin, "/basic-chat/events"),
    ]);
    await Promise.all(clients.map((client) => client.waitFor(sawSnapshot, "the snapshot")));
    deps.bus.sink.emit("inbox_item", { id: "after-drop" });
    await Promise.all(clients.map((client) => client.waitFor((text) => inboxItems(text) >= 1, "the control event")));
    await Promise.all(clients.map((client) => client.settle()));
    clients.forEach((client) => client.close());
    for (const client of clients) expect(inboxItems(client.text)).toBe(1);
  });

  it("snapshots a client whose last event id comes from before the endpoint went idle, while another client is attached", async () => {
    const { origin, deps } = await boot();
    const first = await ChatClient.open(origin, "/basic-chat/events");
    await first.waitFor(sawSnapshot, "the snapshot");
    deps.bus.sink.emit("inbox_item", { id: "seen" });
    await first.waitFor((text) => inboxItems(text) === 1, "the control event");
    const lastId = Math.max(...parseFrames(first.text).map((frame) => frame.id));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = await ChatClient.open(origin, "/basic-chat/events");
    await second.waitFor(sawSnapshot, "the snapshot");
    const third = await ChatClient.open(origin, "/basic-chat/events", { "last-event-id": String(lastId) });
    await third.settle(300);
    second.close();
    third.close();
    // Commits made while nothing watched are in no buffer, so the old id must not resume.
    expect(third.text).toContain("event: snapshot");
  });

  it("snapshots a client that reconnects after the endpoint went idle", async () => {
    const { origin, deps } = await boot();
    const first = await ChatClient.open(origin, "/basic-chat/events");
    await first.waitFor(sawSnapshot, "the snapshot");

    deps.bus.sink.emit("inbox_item", { id: "seen" });
    await first.waitFor((text) => inboxItems(text) === 1, "the control event");
    const lastId = Math.max(...parseFrames(first.text).map((frame) => frame.id));
    first.close();
    // Let the close land, so the endpoint is genuinely idle before the next client.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const resumed = await ChatClient.open(origin, "/basic-chat/events", { "last-event-id": String(lastId) });
    await resumed.waitFor(sawSnapshot, "the snapshot");
    await resumed.settle(200);
    resumed.close();
    // Nothing was watching in between, so those commits are in no buffer: replaying
    // from the old id would silently leave a hole in the transcript.
    expect(resumed.text).toContain("event: snapshot");
  });
});

  it("lists inbox items and marks them read", async () => {
    const { origin, deps } = await boot();
    const item = await deps.runtime.harness.commit(
      (tx) => createInboxItemTx(tx, { title: "Brief", body: "All good" }),
      BACKGROUND_CONTEXT,
    );
    const list = await fetch(`${origin}/api/inbox`);
    const body = (await list.json()) as { items: { id: string }[] };
    expect(body.items.some((entry) => entry.id === item.id)).toBe(true);

    const read = await fetch(`${origin}/api/inbox/${item.id}/read`, { method: "POST" });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { readAt?: number }).readAt).toBeTypeOf("number");
  });
});

describe("shared files", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<{ origin: string }> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
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
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin };
  }

  it("no longer answers the legacy /share route", async () => {
    const { origin } = await boot();
    expect((await fetch(`${origin}/share/shot.png`)).status).toBe(404);
  });
});

describe("restart from the web UI", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  interface Call {
    readonly command: string;
    readonly args: readonly string[];
    readonly logFile?: string;
  }

  interface BootOptions {
    readonly userUnit?: boolean;
    readonly systemUnit?: boolean;
    readonly systemdRun?: boolean;
  }

  /**
   * Boot with the real launcher over fake hooks. The launcher's refusals and the
   * command it builds are the interesting part; only the two calls that leave the
   * process are replaced, so no test starts a service.
   */
  async function boot(options: BootOptions = {}): Promise<{
    origin: string;
    probes: Call[];
    launched: Call[];
    marker: string;
  }> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    const probes: Call[] = [];
    const launched: Call[] = [];
    const launcher = new RestartLauncher({
      home: harness.paths.home,
      workspaceTree: harness.paths.workspaceTree,
      snapshotTree: harness.paths.snapshotTree,
      logsDir: harness.paths.logsDir,
      runDir: harness.paths.runDir,
      env: { PATH: "/usr/bin:/bin", HOME: harness.paths.home },
      nodePath: "/usr/bin/node",
      now: () => 1_700_000_000_000,
      hooks: {
        probe: async (command, args) => {
          probes.push({ command, args });
          if (command === "systemctl" && args[0] === "--user") return { code: options.userUnit === false ? 1 : 0, stdout: "", stderr: "" };
          if (command === "systemctl") return { code: options.systemUnit === true ? 0 : 1, stdout: "", stderr: "" };
          if (command === "systemd-run") return { code: options.systemdRun === false ? 1 : 0, stdout: "", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        },
        launch: async (command, args, logFile) => {
          launched.push({ command, args, logFile });
          return { code: 0 };
        },
        exists: (path) => path.startsWith(harness!.paths.workspaceTree),
      },
    });

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
      restart: launcher,
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin, probes, launched, marker: join(harness.paths.runDir, "restart-pending") };
  }

  const post = (origin: string, headers: Record<string, string> = { "Content-Type": "application/json" }, body = "{}") =>
    fetch(`${origin}/api/admin/restart`, { method: "POST", headers, body });

  it("hands the update script to systemd as a unit of its own", async () => {
    const { origin, launched, marker } = await boot();
    const response = await post(origin);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; unit: string; script: string; logFile: string };
    expect(body.status).toBe("launched");
    expect(body.unit).toBe("pi-sec-restart-1700000000");
    expect(body.script).toBe(join(harness!.paths.workspaceTree, "user-tools", "update-and-restart"));

    expect(launched).toHaveLength(1);
    expect(launched[0]!.command).toBe("systemd-run");
    const args = launched[0]!.args;
    expect(args).toContain("--user");
    expect(args).toContain("--collect");
    expect(args).toContain("--unit=pi-sec-restart-1700000000");
    // A transient unit inherits the user manager's environment, which has no
    // node on PATH: the three values the script needs are passed explicitly.
    expect(args).toContain("--setenv=PATH=/usr/bin:/usr/bin:/bin");
    expect(args).toContain(`--setenv=HOME=${harness!.paths.home}`);
    expect(args).toContain(`--setenv=PI_SEC_HOME=${harness!.paths.home}`);
    expect(args).toContain(body.script);

    // The marker is what lets the next boot report a restart that never finished.
    const pending = JSON.parse(await readFile(marker, "utf8")) as { at: number; source: string };
    expect(pending.at).toBe(1_700_000_000_000);
    expect(pending.source).toBe("ui");
  });

  it("keeps the plain restart command character for character", async () => {
    const { origin, launched } = await boot();
    await post(origin);

    const args = launched[0]!.args;
    // Spelled out, because the forced reinstall shares this head: an edit that
    // reaches the plain command has to fail here rather than in production.
    expect(args[args.length - 3]).toBe('echo "[$(date -Is)] restart requested from the web UI"; sleep 2; exec "$0" >>"$1" 2>&1');
    expect(args[args.length - 2]).toBe(join(harness!.paths.workspaceTree, "user-tools", "update-and-restart"));
    expect(args[args.length - 1]).toBe(join(harness!.paths.logsDir, "update-and-restart.log"));
    expect(args.some((arg) => arg.includes("--reinstall"))).toBe(false);
  });

  it("passes --reinstall to the script when the menu asks for it", async () => {
    const { origin, launched, marker } = await boot();
    const response = await post(origin, { "Content-Type": "application/json" }, JSON.stringify({ reinstall: true }));
    expect(response.status).toBe(202);

    const args = launched[0]!.args;
    // The flag rides in the `-c` command, and it is there once: the script sees
    // exactly one argument.
    const command = args[args.length - 3]!;
    expect(command.match(/--reinstall/g)).toHaveLength(1);
    expect(command.endsWith('exec "$0" --reinstall >>"$1" 2>&1')).toBe(true);
    // `$0` and `$1` keep their places: the script and the log.
    expect(args[args.length - 2]).toBe(join(harness!.paths.workspaceTree, "user-tools", "update-and-restart"));
    expect(args[args.length - 1]).toBe(join(harness!.paths.logsDir, "update-and-restart.log"));

    // The marker names the entry, so the next boot can say which one failed.
    const pending = JSON.parse(await readFile(marker, "utf8")) as { source: string };
    expect(pending.source).toBe("ui-reinstall");
  });

  it("records the forced reinstall in the audit log", async () => {
    const { origin } = await boot();
    await post(origin, { "Content-Type": "application/json" }, JSON.stringify({ reinstall: true }));
    const audit = (await (await fetch(`${origin}/api/admin/audit`)).json()) as { events: { type: string; reinstall?: boolean }[] };
    expect(audit.events.find((event) => event.type === "restart_launched")?.reinstall).toBe(true);
  });

  it("records both the launch and a refusal in the audit log", async () => {
    const { origin } = await boot();
    expect((await post(origin)).status).toBe(202);
    const audit = (await (await fetch(`${origin}/api/admin/audit`)).json()) as { events: { type: string }[] };
    expect(audit.events.some((event) => event.type === "restart_launched")).toBe(true);

    const again = await post(origin);
    expect(again.status).toBe(409);
    const after = (await (await fetch(`${origin}/api/admin/audit`)).json()) as { events: { type: string }[] };
    expect(after.events.some((event) => event.type === "restart_refused")).toBe(true);
  });

  it("refuses a second request in the same process", async () => {
    const { origin, launched } = await boot();
    expect((await post(origin)).status).toBe(202);

    const second = await post(origin);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("already_requested");
    expect(launched).toHaveLength(1);
  });

  it("refuses a body that a cross-site form could send", async () => {
    const { origin, launched } = await boot();
    // A form POST is a simple request: no preflight, so the daemon has to be the
    // one that says no. Only a JSON body type is accepted.
    const response = await post(origin, { "Content-Type": "text/plain" });
    expect(response.status).toBe(415);
    expect(launched).toHaveLength(0);
  });

  it.each<[string, BootOptions, number, string?, string?]>([
    ["refuses when there is no unit to drive: no user unit", { userUnit: false }, 409],
    ["says why a system unit cannot be restarted from here", { userUnit: false, systemUnit: true }, 409, "system_unit", "sudo"],
    ["refuses when there is no unit to drive: no user unit and no systemd-run", { userUnit: false, systemdRun: false }, 409],
    ["refuses when systemd-run is missing", { systemdRun: false }, 500, "systemd_run_missing"],
  ])("%s", async (_name, options, status, code, message) => {
    // Each row boots its own server; nothing may be launched for a refusal.
    const { origin, launched } = await boot(options);
    const response = await post(origin);
    expect(response.status, JSON.stringify(options)).toBe(status);
    expect(launched).toHaveLength(0);
    if (code === undefined) return;
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    if (message !== undefined) expect(body.error.message).toContain(message);
  });
});

describe("ui restart from the web UI", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  /**
   * Boot with a stubbed swap. The interesting part here is the route's answer and
   * its audit row, not the copy, which `test/ui-assets.test.ts` owns: the stub is
   * what lets a refusal and a failure be produced on demand.
   */
  async function boot(uiRestart?: AppDeps["uiRestart"]): Promise<{ origin: string }> {
    harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
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
      ...(uiRestart === undefined ? {} : { uiRestart }),
    };
    started = await startServer(deps, { webDir: defaultWebDir() });
    return { origin: started.origin };
  }

  const post = (origin: string, headers: Record<string, string> = { "Content-Type": "application/json" }, body = "{}") =>
    fetch(`${origin}/api/admin/ui-restart`, { method: "POST", headers, body });

  function stub(outcome: UiRestartOutcome): { wired: AppDeps["uiRestart"]; calls: { count: number } } {
    const calls = { count: 0 };
    return {
      calls,
      wired: {
        async run() {
          calls.count += 1;
          return outcome;
        },
      },
    };
  }

  async function audit(origin: string): Promise<{ type: string; [key: string]: unknown }[]> {
    const body = (await (await fetch(`${origin}/api/admin/audit`)).json()) as { events: { type: string }[] };
    return body.events;
  }

  it("replaces the assets and reports what it copied", async () => {
    const { wired } = stub({
      ok: true,
      copied: 7,
      uiHash: "abc123",
      source: "/ws/src/web",
      target: "/snapshot/dist/web",
      codeDrift: { known: true, behind: 2, codePaths: ["src/server/routes/admin.ts"] },
    });
    const { origin } = await boot(wired);

    const response = await post(origin);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      copied: number;
      uiHash: string;
      source: string;
      target: string;
      codeDrift: { known: boolean; behind: number; codePaths: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.copied).toBe(7);
    expect(body.uiHash).toBe("abc123");
    expect(body.source).toBe("/ws/src/web");
    expect(body.target).toBe("/snapshot/dist/web");
    expect(body.codeDrift).toEqual({ known: true, behind: 2, codePaths: ["src/server/routes/admin.ts"] });

    const row = (await audit(origin)).find((event) => event.type === "ui_restart");
    expect(row).toMatchObject({ source: "ui", copied: 7, uiHash: "abc123", behind: 2 });
  });

  it("refuses a body that a cross-site form could send", async () => {
    const { wired, calls } = stub({ ok: true, copied: 1, uiHash: "h" });
    const { origin } = await boot(wired);

    for (const type of ["text/plain", "application/x-www-form-urlencoded", ""] ) {
      const response = await post(origin, { "Content-Type": type });
      expect(response.status, type).toBe(415);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("json_required");
    }
    expect(calls.count).toBe(0);
  });

  it.each<[string, UiRestartOutcome, number, boolean, string?]>([
    ["answers 409 when the source directory is missing", { ok: false, code: "source_missing", restored: true }, 409, true],
    // A build that fails is a fact about the workspace code, like a missing
    // directory: the operator fixes the page and presses again, and the served
    // tree is untouched in the meantime, which `restored` states.
    [
      "answers 409 when the workspace pages do not build",
      { ok: false, code: "build_failed", restored: true },
      409,
      true,
      "the web pages could not be built from the workspace",
    ],
    // `restored: false` is the sentence that matters: the assets directory was
    // not put back, so the page has to say so instead of "try again".
    ["answers 500 when the swap fails", { ok: false, code: "sync_failed", restored: false }, 500, false],
  ])("%s", async (_name, outcome, status, restored, message) => {
    const { wired } = stub(outcome);
    const { origin } = await boot(wired);

    const response = await post(origin);
    expect(response.status).toBe(status);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string; details: { code: string; restored: boolean } };
    };
    expect(body.error.code).toBe(outcome.code);
    expect(body.error.requestId).toBeTruthy();
    if (message !== undefined) expect(body.error.message).toBe(message);
    expect(body.error.details).toEqual({ code: outcome.code, restored });

    const events = await audit(origin);
    expect(events.find((event) => event.type === "ui_restart_refused")).toMatchObject({ source: "ui", code: outcome.code });
    // A refusal is not a swap: no success row may be written for it.
    expect(events.some((event) => event.type === "ui_restart")).toBe(false);
  });

  it("answers 500 sync_failed when the swap throws", async () => {
    const calls = { count: 0 };
    const wired: AppDeps["uiRestart"] = {
      async run() {
        calls.count += 1;
        throw new Error("the filesystem said no");
      },
    };
    const { origin } = await boot(wired);

    const response = await post(origin);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; details: { code: string; restored: boolean } } };
    expect(calls.count).toBe(1);
    // A swap that threw is a failed swap, not an internal error of the route: the
    // page's next step is the web directory either way, and the audit row has to
    // name the same code the answer does.
    expect(body.error.code).toBe("sync_failed");
    expect(body.error.details).toEqual({ code: "sync_failed", restored: false });

    const row = (await audit(origin)).find((event) => event.type === "ui_restart_refused");
    expect(row).toMatchObject({ source: "ui", code: "sync_failed" });
  });

  it("answers 500 when the daemon has no way to swap assets", async () => {
    const { origin } = await boot();

    const response = await post(origin);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ui_restart_unavailable");
  });
});
