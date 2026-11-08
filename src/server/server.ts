import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apiError, json, Router } from "./router.ts";
import { API_VERSION, type AppDeps } from "./deps.ts";
import { serveStatic } from "./static.ts";
import { resolveMount, stripMount } from "./proxy.ts";
import { registerHealth } from "./routes/health.ts";
import { registerBasicChat } from "./routes/basic-chat.ts";
import { registerUi } from "./routes/ui.ts";
import { UI_ACTION_TIMEOUT_MS, UI_RENDER_TIMEOUT_MS } from "./ui-page.ts";
import { registerConversations } from "./routes/conversations.ts";
import { registerFocusedChats } from "./routes/focused-chats.ts";
import { registerJobs } from "./routes/jobs.ts";
import { registerPreferences } from "./routes/preferences.ts";
import { registerReports } from "./routes/reports.ts";
import {
  isBinaryUploadRequest,
  registerAttachments,
  type AttachmentRouteRoots,
} from "./routes/attachments.ts";
import { registerShareFiles } from "./routes/share-files.ts";
import { registerInbox } from "./routes/inbox.ts";
import { registerUserQueries } from "./routes/user-queries.ts";
import { registerAdmin, registerSecretWrite } from "./routes/admin.ts";
import { registerModelLogin } from "./routes/model-login.ts";
import { registerModelSetup } from "./routes/model-setup.ts";
import { ModelNotConfiguredError } from "../agent/model-setup.ts";
import { registerUsage, type UsageRouteOptions } from "./routes/usage.ts";
import { registerUsageStats, type UsageStatsRouteOptions } from "./routes/usage-stats.ts";
import { registerRemoteMachines } from "./routes/remote-machines.ts";
import { BUNDLED_EXTENSIONS, type BundledExtension, type ExtensionRouteCleanup } from "../extensions/index.ts";

export interface ServerOptions {
  readonly webDir?: string;
  /**
   * Where uploaded and published files are stored. A test points these at a
   * temporary directory; production reads them from the `attachments` config.
   */
  readonly attachmentRoots?: AttachmentRouteRoots;
  /**
   * How long a card may take. A page load waits at most `renderTimeoutMs` per
   * card, and a `POST /api/ui/call` answers 504 after `actionTimeoutMs`. A test
   * sets both small so it does not spend seconds proving a timeout works.
   */
  readonly ui?: {
    readonly renderTimeoutMs?: number;
    readonly actionTimeoutMs?: number;
  };
  /**
   * The usage route's own options: the ledger to read, the clock, and the
   * `fetch` a provider call goes through. The daemon passes none of them, so the
   * route reads its own database and the real clock. A test passes them here
   * instead of replacing a global that the whole process shares.
   */
  readonly usage?: UsageRouteOptions;
  /** The model call statistics route's test settings (the clock). */
  readonly usageStats?: UsageStatsRouteOptions;
  /**
   * Per-extension options for the `routes` function of a bundled extension,
   * keyed by the name in `agent.extensions.enabled`.
   *
   * The daemon passes none of them, so an extension uses its real inputs: the
   * `gh` on `PATH` and `~/.pi/sec/gh-repo/`. A test passes the fake `gh` path,
   * a temporary repository root and a clock here instead of replacing a global
   * that the whole process shares. A name the catalog does not hold, or one the
   * enabled list leaves out, is ignored: no `routes` function is called for it.
   */
  readonly extensionRoutes?: Readonly<Record<string, unknown>>;
  /**
   * The catalog to read the route functions from. Defaults to
   * `BUNDLED_EXTENSIONS`.
   *
   * A test passes a catalog of its own, so the route device is proved without
   * the extension that fills it: a fake entry can answer a path that the real
   * one registers nothing on yet, and the enabled list decides the same way it
   * decides for the shipped catalog.
   */
  readonly catalog?: readonly BundledExtension[];
}

export function defaultWebDir(): string {
  return fileURLToPath(new URL("../web/", import.meta.url));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  // Over the cap the rest of the body is read and dropped rather than the socket
  // being destroyed: a client hears 413 only on a connection that is still there.
  // The upload route settles the same trade the same way (see
  // `readBinaryBody` in routes/attachments.ts).
  let overCap = false;
  return await new Promise<unknown>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        overCap = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overCap) {
        reject(Object.assign(new Error("body too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json") || raw.startsWith("{") || raw.startsWith("[")) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error("invalid JSON body"), { code: "INVALID_JSON" }));
        }
      } else {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-API-Version", String(API_VERSION));
}

/** The names that reach this machine without a name lookup. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** `new URL(value).origin`, or `undefined` when the value is not a URL. */
function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function hostAllowed(req: IncomingMessage, publicUrl: string | undefined): boolean {
  // `publicUrl` is the only thing that names the address a browser page is on.
  // Without it, a name that resolves to this machine is indistinguishable from
  // `localhost`, and a page on another site that points its own name at
  // `127.0.0.1` (DNS rebinding) would arrive with a `Host` of its own choosing.
  // So with no `publicUrl`, only the loopback names are accepted.
  let expected: string | undefined;
  if (publicUrl !== undefined && publicUrl !== "") {
    try {
      expected = new URL(publicUrl).hostname.toLowerCase();
    } catch {
      // A `publicUrl` that is not a URL names no address either. Refusing every
      // name but loopback is the safe reading of a value nobody can use.
      expected = undefined;
    }
  }

  // Compare hostnames, not `Host` values: a port is not part of the identity, so
  // `example.com:8443` is the same host, and a suffix match would let
  // `127.0.0.1.evil.example` pass as loopback.
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (expected !== undefined && hostname === expected) return true;
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Whether a write request may come from the page it says it came from.
 *
 * A browser puts `Origin` on every request that is not a `GET` or a `HEAD`, and
 * a page on another site cannot remove it. The allowed origins are the address
 * `publicUrl` names, and the loopback addresses on the port this request
 * arrived on: a page opened at `http://127.0.0.1:<port>` is the same trust
 * boundary as the process itself. The port is read from the connection and not
 * from the config, so a server that asked the kernel for a port (a test) has the
 * right one.
 */
function originAllowed(req: IncomingMessage, publicUrl: string | undefined): boolean {
  const header = req.headers.origin;
  // No `Origin` at all: not a browser. The CLI, the scripts and the tests arrive
  // this way, and a page on another site always sends one.
  if (header === undefined) return true;
  // `null` (a sandboxed frame, a `file://` page), two values joined by a comma,
  // and anything else a URL cannot parse is not an origin this server names.
  const origin = normalizeOrigin(header);
  if (origin === undefined) return false;

  if (publicUrl !== undefined && publicUrl !== "") {
    if (origin === normalizeOrigin(publicUrl)) return true;
  }
  const port = req.socket.localPort;
  if (port === undefined) return false;
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    if (origin === normalizeOrigin(`http://${name}:${port}`)) return true;
  }
  return false;
}

/**
 * Register the web routes of every enabled bundled extension that has some.
 *
 * Called after the fixed list below, so a path this server names answers before
 * an extension can claim it: the router keeps its insertion order and the first
 * match wins. A function that throws is reported and the boot carries on, the
 * same way the loader answers a runtime extension that throws, and a cleanup
 * that throws is reported after the server has closed.
 */
function registerExtensionRoutes(
  router: Router,
  deps: AppDeps,
  options: ServerOptions,
): ExtensionRouteCleanup[] {
  const enabled = deps.runtime.getConfig().agent.extensions.enabled;
  const cleanups: ExtensionRouteCleanup[] = [];
  for (const extension of options.catalog ?? BUNDLED_EXTENSIONS) {
    if (extension.routes === undefined) continue;
    if (!enabled.includes(extension.name)) continue;
    const own = options.extensionRoutes === undefined ? undefined : options.extensionRoutes[extension.name];
    try {
      const cleanup = extension.routes({ router, deps, options: own });
      if (typeof cleanup === "function") cleanups.push(cleanup);
    } catch (error) {
      deps.runtime.logger.error("extension routes failed", { extension: extension.name, error });
      deps.adminState.notes.add(`extension routes failed: ${extension.name}`);
    }
  }
  return cleanups;
}

/**
 * The cleanups of one server, by the server object itself. A map rather than a
 * field on the `Server`: the object is the one `startServer` closes, and nothing
 * about it is part of its public shape.
 */
const routeCleanups = new WeakMap<Server, ExtensionRouteCleanup[]>();

/**
 * The cleanup run of one server, once it has started. A second caller awaits the
 * same run rather than finding nothing: `startServer`'s `close` and the HTTP
 * server's own `close` event both reach `closeExtensionRoutes`, and whichever is
 * second must still be able to wait.
 */
const routeCleanupRuns = new WeakMap<Server, Promise<void>>();

/**
 * Run the cleanups of one server once, and forget them.
 *
 * A cleanup that returns a promise is awaited, so `startServer`'s `close`
 * reports itself finished only after the work an extension had already started
 * has ended: a caller that removes the directory such work writes into does not
 * race it. The `close` event of the HTTP server cannot wait for anything, so
 * that path starts this call and lets it settle.
 */
function closeExtensionRoutes(server: Server): Promise<void> {
  const running = routeCleanupRuns.get(server);
  if (running !== undefined) return running;
  const cleanups = routeCleanups.get(server);
  if (cleanups === undefined) return Promise.resolve();
  routeCleanups.delete(server);
  const run = (async () => {
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        // After the close: there is no request to fail, so one line and the next
        // cleanup still runs.
        process.stderr.write(`pi-sec: extension route cleanup failed: ${String(error)}\n`);
      }
    }
  })();
  routeCleanupRuns.set(server, run);
  return run;
}

/** Build the HTTP server with every route registered. */
export function createServer(deps: AppDeps, options: ServerOptions = {}): Server {
  const router = new Router();
  const renderTimeoutMs = options.ui?.renderTimeoutMs ?? UI_RENDER_TIMEOUT_MS;
  const actionTimeoutMs = options.ui?.actionTimeoutMs ?? UI_ACTION_TIMEOUT_MS;
  registerHealth(router, deps);
  registerBasicChat(router, deps, { renderTimeoutMs, catalog: options.catalog ?? BUNDLED_EXTENSIONS });
  registerUi(router, deps, { actionTimeoutMs });
  registerConversations(router, deps);
  registerFocusedChats(router, deps);
  registerJobs(router, deps);
  registerPreferences(router, deps);
  registerReports(router, deps);
  registerUsage(router, deps, options.usage);
  registerUsageStats(router, deps, options.usageStats);
  registerAttachments(router, deps, { roots: options.attachmentRoots });
  registerShareFiles(router, deps, { roots: options.attachmentRoots });
  registerInbox(router, deps);
  registerUserQueries(router, deps);
  registerRemoteMachines(router, deps);
  registerAdmin(router, deps);
  // Its own line, so the one route that writes into the secret store is visible
  // in this list instead of arriving with the rest of the admin surface.
  registerSecretWrite(router, deps);
  // Its own line for the same reason: these five routes can replace the model
  // credential, and one of them starts a sign-in.
  registerModelLogin(router, deps);
  registerModelSetup(router, deps);

  // After every fixed route, in catalog order. A bundled extension answers only
  // while its name is in `agent.extensions.enabled`, which is read here at boot:
  // turning one on or off is a restart, unlike its own config values.
  const extensionCleanups = registerExtensionRoutes(router, deps, options);

  const webDir = options.webDir ?? defaultWebDir();

  // A forwarded prefix that disagrees with the configured mount is reported
  // once. Warn only: the forwarded value still wins, because a proxy that
  // announces a prefix is the documented way to declare a mount it stripped —
  // but a silent disagreement is how a mount changes without anyone deciding.
  const reportedMountConflicts = new Set<string>();
  const reportMountConflict = (conflict: string): void => {
    if (reportedMountConflicts.has(conflict)) return;
    reportedMountConflicts.add(conflict);
    deps.runtime.logger.warn("mount conflict", { conflict });
    deps.adminState.notes.add(`mount conflict: ${conflict}`);
  };

  const server = createHttpServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader("X-Request-Id", requestId);
    securityHeaders(res);
    // Set by the trusted-proxy path below; declared here so the access log can
    // name the client rather than the proxy. Display and audit only.
    let forwardedClient: string | undefined;
    res.on("finish", () => {
      deps.runtime.logger.info("http_request", {
        requestId,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        remote: forwardedClient ?? req.socket.remoteAddress,
        ...(forwardedClient === undefined ? {} : { peer: req.socket.remoteAddress }),
      });
    });

    void (async () => {
      try {
        const config = deps.runtime.getConfig();
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        let pathname = decodeURIComponent(url.pathname);

        // One answer to "where is this request mounted?", shared with every route
        // that emits a URL instead of each deriving its own.
        const mount = resolveMount(req, config);
        forwardedClient = mount.client;
        if (mount.conflict !== undefined) reportMountConflict(mount.conflict);

        if (!hostAllowed(req, config.server.publicUrl)) {
          apiError(res, 421, "misdirected", "host not allowed", requestId);
          return;
        }

        // Reads are left out on purpose: no `GET` or `HEAD` route writes, so a
        // page on another site that sends one changes nothing and cannot read the
        // answer. `/basic-chat/events` and `/basic-chat/context` only read the
        // root conversation: the daemon prepares it at boot, and the write routes
        // prepare it before they act. `OPTIONS` is not left out: nothing here
        // answers a preflight, and a preflight from another site has no reason
        // to be told anything. Checked here rather than in a route, so the body
        // is not read and no handler runs for a request that is refused.
        const method = (req.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && !originAllowed(req, config.server.publicUrl)) {
          apiError(res, 403, "origin_forbidden", "origin not allowed", requestId);
          return;
        }

        const stripped = stripMount(mount, pathname);
        if (stripped.redirectTo !== undefined) {
          res.writeHead(302, { Location: stripped.redirectTo });
          res.end();
          return;
        }
        if (stripped.outside === true) {
          // Name the mount: a path that arrived without it is the one failure a
          // proxy arrangement produces most often, and this sentence is the
          // whole diagnosis.
          apiError(res, 404, "not_found", `path is outside the mount point ${mount.required}`, requestId);
          return;
        }
        pathname = stripped.pathname;

        // Checked after the strip, so a proxy that forwards `/sec/` un-stripped is
        // redirected rather than 404'd.
        if (pathname === "/" && (req.method ?? "GET") === "GET") {
          res.writeHead(302, { Location: `${mount.prefix}/basic-chat` });
          res.end();
          return;
        }

        let body: unknown = undefined;
        // One route takes the file itself and not a text body. `readBody` decoded
        // the stream as UTF-8, which no binary survives, so that path keeps the
        // stream for its handler and nothing else changes here.
        if (!isBinaryUploadRequest(req.method ?? "GET", pathname)) {
          try {
            body = await readBody(req, config.server.maxBodyBytes);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === "PAYLOAD_TOO_LARGE") {
              apiError(res, 413, "payload_too_large", "request body too large", requestId);
              return;
            }
            apiError(res, 400, "invalid_request", String(error), requestId);
            return;
          }
        }

        const match = router.match(req.method ?? "GET", pathname);
        if (match !== undefined) {
          await match.handler({ req, res, url, params: match.params, requestId, body });
          return;
        }

        if (req.method === "GET" && (await serveStatic(res, webDir, pathname))) return;

        apiError(res, 404, "not_found", "route not found", requestId);
      } catch (error) {
        // No root model yet: a refusal the page can act on, not a fault.
        if (error instanceof ModelNotConfiguredError && !res.headersSent) {
          apiError(res, 409, "model_not_configured", error.message, requestId);
          return;
        }
        deps.runtime.logger.error("request failed", { requestId, error });
        if (!res.headersSent) apiError(res, 500, "internal_error", String(error), requestId);
        else res.end();
      }
    })();
  });

  // Filed under the object the caller closes, and before it is returned: a
  // close that happened first would find no entry and leave the timer running.
  // The `close` event covers a caller that closes the HTTP server itself, and
  // `startServer.close` calls the same idempotent function once more so the
  // timer stops before the last sockets drain.
  if (extensionCleanups.length > 0) {
    routeCleanups.set(server, extensionCleanups);
    // `void`: nothing here can wait, and `closeExtensionRoutes` catches every
    // cleanup failure itself, so no rejection is left behind.
    server.once("close", () => void closeExtensionRoutes(server));
  }
  return server;
}

export interface StartedServer {
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
}

/** Create and listen on the configured bind/port. */
export async function startServer(deps: AppDeps, options: ServerOptions = {}): Promise<StartedServer> {
  const config = deps.runtime.getConfig();
  const server = createServer(deps, options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.bind, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.server.port;
  return {
    server,
    origin: `http://${config.server.bind}:${port}`,
    close: async () => {
      deps.streams.close();
      deps.sse.closeAll();
      // Before `server.close` waits for the sockets: a poll timer that fires
      // while the last request drains would keep the work alive past this call.
      // Awaited, so this call answers only after a cleanup that waits has
      // finished, and a caller may remove what the extension was writing then.
      await closeExtensionRoutes(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export { json, apiError };
