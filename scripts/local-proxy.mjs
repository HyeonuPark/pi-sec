// A local stand-in for the production reverse proxy.
//
// A production proxy can strip a prefix such as `/sec`, forwards to the daemon, and sits behind an
// oauth2 sign-in that a headless browser cannot get past. This reproduces the
// part that matters — the path rewriting and the `Host` and `Origin` headers —
// and leaves the authentication out, so a page can be rendered and looked at.
//
//   node scripts/local-proxy.mjs            # listens on 127.0.0.1:8788
//
// In a deployment where the proxy strips the prefix, browser requests arrive as
// `/basic-chat/events`, not `/sec/basic-chat/events`. If it announces no
// `X-Forwarded-Prefix` either, the deployment sets `server.publicUrl`, which is
// then the only thing that names the mount point.
//
// `Origin` is rewritten for the same reason `Host` is. The daemon refuses a
// write request whose `Origin` is neither the origin of `publicUrl` nor a
// loopback origin on the port it listens on, and the page here is on this
// proxy's port. So a page served through this proxy has to look like a page on
// the public address, exactly as it does to the daemon's `Host` check.

import { createServer, request } from "node:http";

const PREFIX = process.env.PROXY_PREFIX ?? "/sec";
const PORT = Number(process.env.PROXY_PORT ?? 8788);
const UPSTREAM_HOST = process.env.PROXY_UPSTREAM_HOST ?? "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.PROXY_UPSTREAM_PORT ?? 8787);
/** What the proxied request looks like to the daemon. */
const PUBLIC_HOST = process.env.PROXY_PUBLIC_HOST ?? "example.com";
/**
 * The origin a page served through this proxy is on. `server.publicUrl` in the
 * daemon's config has to name the same address, or the daemon refuses the page's
 * writes. The default is the production shape: the real proxy answers on https.
 */
const PUBLIC_ORIGIN = new URL(process.env.PROXY_PUBLIC_ORIGIN ?? `https://${PUBLIC_HOST}`).origin;

const server = createServer((req, res) => {
  let path = req.url ?? "/";
  if (path === PREFIX) path = "/";
  else if (path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length);

  const headers = { ...req.headers, host: PUBLIC_HOST };
  if (typeof headers["origin"] === "string") headers["origin"] = PUBLIC_ORIGIN;
  // Hop-by-hop headers cannot be forwarded as-is, and a stale content-length on
  // a streamed body would truncate it.
  delete headers["connection"];
  delete headers["keep-alive"];
  delete headers["proxy-connection"];
  delete headers["transfer-encoding"];
  if (req.method === "GET" || req.method === "HEAD") delete headers["content-length"];

  const upstream = request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    // Piped, not buffered: SSE must reach the browser as it is produced.
    up.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`upstream error: ${String(error)}`);
  });
  req.pipe(upstream);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`local proxy on http://127.0.0.1:${PORT}${PREFIX}/ -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
