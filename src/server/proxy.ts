import type { IncomingMessage } from "node:http";
import { BlockList, isIP, isIPv4 } from "node:net";
import type { Config } from "../config/schema.ts";

/**
 * Reverse-proxy support.
 *
 * `pi-sec` is normally fronted by a proxy that terminates TLS and
 * authentication. On a shared domain it is mounted under a path prefix, e.g.
 * `https://example.com/sec/basic-chat`, and the proxy either strips that prefix
 * before forwarding or passes it through.
 *
 * Two different things are true of that prefix, and conflating them breaks one
 * case or the other:
 *
 *  - **`server.basePath` is configured locally.** The prefix is still on the
 *    incoming path, so it must be *required* and stripped, and re-applied to
 *    every URL the server emits.
 *  - **A forwarded prefix arrives from a trusted peer.** The proxy has already
 *    stripped it, so the incoming path carries none; requiring it would 404
 *    every request. It is re-applied to emitted URLs only.
 *
 * `X-Forwarded-*` is honoured **only** when the peer is listed in
 * `server.trustedProxies`. The empty default trusts nothing, so a directly
 * reachable daemon cannot be steered by a spoofed header. The forwarded client
 * identity is used for display and audit only — never as a security gate — but
 * the forwarded **prefix is not display-only**: it decides the URLs the server
 * emits (the page's stamped mount, and the root redirect), so a trusted peer's
 * wrong value sends the browser to paths that do not exist. A disagreement with
 * the configured mount is logged once instead of passing silently.
 */

/** Entries are IPs (`10.0.0.5`) or CIDR blocks (`127.0.0.1/32`, `::1/128`). */
export type TrustedProxies = readonly string[];

const listCache = new Map<string, BlockList>();

/** Build (and memoise) a matcher for a `trustedProxies` list. */
function trustedList(entries: TrustedProxies): BlockList | undefined {
  if (entries.length === 0) return undefined;
  const key = entries.join("\n");
  const cached = listCache.get(key);
  if (cached !== undefined) return cached;

  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === "") continue;
    const slash = entry.lastIndexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const bits = slash === -1 ? undefined : Number(entry.slice(slash + 1));
    if (!isIP(address)) continue;
    const type = isIPv4(address) ? "ipv4" : "ipv6";
    const size = type === "ipv4" ? 32 : 128;
    if (bits === undefined) list.addAddress(address, type);
    else if (Number.isInteger(bits) && bits >= 0 && bits <= size) list.addSubnet(address, bits, type);
  }

  // The key comes from local config, so this cannot grow from request traffic;
  // the cap is only so a long-running process that keeps rewriting its config
  // cannot accumulate stale matchers.
  if (listCache.size > 8) listCache.clear();
  listCache.set(key, list);
  return list;
}

/** True when `address` is one of the configured proxies. */
export function isTrustedPeer(address: string | undefined, entries: TrustedProxies): boolean {
  const list = trustedList(entries);
  if (list === undefined || address === undefined || !isIP(address)) return false;
  try {
    // `BlockList` understands IPv4-mapped IPv6 (`::ffff:127.0.0.1`).
    return list.check(address, isIPv4(address) ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

/**
 * Normalise a path prefix.
 *
 * Returns `""` for "no prefix", the clean prefix when usable, and `undefined`
 * when the value must be rejected. A forwarded prefix is attacker-controlled
 * whenever a proxy is misconfigured, and it ends up in a `Location` header and
 * in the served HTML, so anything but a strictly boring path is refused:
 * absolute, no empty or relative segments, no scheme-relative `//`, and only
 * unreserved path characters.
 */
export function normalizePrefix(raw: string | undefined | null): string | "" | undefined {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim();
  if (value === "" || value === "/") return "";
  if (value.length > 256) return undefined;
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(value)) return undefined;
  if (value.includes("//")) return undefined;
  const segments = value.replace(/\/+$/, "").split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return undefined;
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed;
}

/**
 * Why a configured `basePath` cannot be used, or `undefined` when it can.
 *
 * `basePath` is a *path* prefix, not a mount URL. An unusable value used to be
 * discarded in silence, which turned one typo into a lost mount point and a
 * `Location` header pointing outside the proxy. So this reports the problem in
 * words instead of returning a boolean nobody acts on.
 */
export function describeBasePathProblem(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "" || value === "/") return undefined;
  if (normalizePrefix(value) !== undefined) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return `server.basePath is a URL (${value}). basePath is a path prefix such as "/sec"; a full URL mount point belongs in server.publicUrl.`;
  }
  return `server.basePath must be an absolute path starting with "/", with no empty or relative segments: got ${JSON.stringify(value)}`;
}

/** Split a `trustedProxies` entry into its address and bit-length halves. */
function splitTrustedEntry(entry: string): { address: string; bits: string | undefined } {
  const slash = entry.lastIndexOf("/");
  if (slash === -1) return { address: entry, bits: undefined };
  return { address: entry.slice(0, slash), bits: entry.slice(slash + 1) };
}

/**
 * `trustedProxies` entries that can never match, and why.
 *
 * The runtime skips an entry that is not an IP or a CIDR block, so a typo — most
 * often a port, as in `127.0.0.1:8787` — silently empties the trust list and
 * disables every forwarded header. Reporting it is the difference between a
 * five-second fix and an afternoon.
 */
export function trustedProxyProblems(entries: readonly string[]): string[] {
  const problems: string[] = [];
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (entry === "") continue;
    const { address, bits } = splitTrustedEntry(entry);
    const validBits =
      bits === undefined || (/^\d+$/.test(bits) && Number(bits) >= 0 && Number(bits) <= (isIPv4(address) ? 32 : 128));
    if (isIP(address) && validBits) continue;

    const withoutPort = address.includes(":") ? address.slice(0, address.lastIndexOf(":")) : address;
    if (!isIP(address) && address.includes(":") && isIPv4(withoutPort)) {
      problems.push(
        `server.trustedProxies entry ${JSON.stringify(entry)} looks like an address with a port. A port is never part of a peer address; use the address or a CIDR block, such as "127.0.0.1/32".`,
      );
    } else {
      problems.push(
        `server.trustedProxies entry ${JSON.stringify(entry)} is neither an IP address nor a CIDR block.`,
      );
    }
  }
  return problems;
}

export interface PrefixInput {
  /** A prefix announced by a trusted proxy, if any. */
  readonly forwardedPrefix: string | undefined;
  readonly basePath: string;
  readonly publicUrl: string | undefined;
}

/**
 * The prefix the server should put in the URLs it emits: the forwarded one when
 * a trusted proxy supplied a usable value, else `basePath`, else the path of
 * `publicUrl` (which is the documented way to declare a subpath mount when
 * neither of the others does).
 */
export function effectivePrefix(input: PrefixInput): string {
  const forwarded = normalizePrefix(input.forwardedPrefix);
  if (forwarded !== undefined && forwarded !== "") return forwarded;

  const configured = normalizePrefix(input.basePath);
  if (configured !== undefined && configured !== "") return configured;

  if (input.publicUrl !== undefined && input.publicUrl !== "") {
    try {
      const fromUrl = normalizePrefix(new URL(input.publicUrl).pathname);
      if (fromUrl !== undefined && fromUrl !== "") return fromUrl;
    } catch {
      /* not a URL; ignore */
    }
  }
  return "";
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  // A chained proxy appends; the outermost (client-facing) prefix comes first.
  const first = raw.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

export interface ProxyContext {
  /** The peer is a configured trusted proxy. */
  readonly trusted: boolean;
  /** The external prefix it announced, when usable. */
  readonly forwardedPrefix: string | undefined;
  /** The forwarded client address, for logging only. */
  readonly client: string | undefined;
}

/** Resolve proxy trust and forwarded values for one request. */
export function proxyContext(req: IncomingMessage, config: Config): ProxyContext {
  const peer = req.socket.remoteAddress ?? undefined;
  if (!isTrustedPeer(peer, config.server.trustedProxies)) {
    return { trusted: false, forwardedPrefix: undefined, client: undefined };
  }

  const normalized = normalizePrefix(firstHeaderValue(req.headers["x-forwarded-prefix"]));
  const forwardedPrefix = normalized === undefined || normalized === "" ? undefined : normalized;

  // `X-Forwarded-For` is a log field, so anything that is not an address is
  // dropped rather than written into the log.
  const forwardedFor = firstHeaderValue(req.headers["x-forwarded-for"]);
  const client = forwardedFor !== undefined && isIP(forwardedFor) ? forwardedFor : undefined;

  return { trusted: true, forwardedPrefix, client };
}

/**
 * Everything one request needs to know about its mount point, resolved once.
 *
 * Three questions live here and used to be answered in three different places —
 * in the pipeline, in the chat page route, and in the report page route — with
 * the same three-argument incantation each time. They are the same question.
 */
export interface Mount {
  /** What goes into URLs this server emits, e.g. `/sec`. `""` at the root. */
  readonly prefix: string;
  /** What the incoming path must still carry. `""` when the proxy stripped it. */
  readonly required: string;
  /** The prefix to accept un-stripped, for a proxy that forwards it anyway. */
  readonly tolerated: string;
  /** Forwarded client address, for the access log only. */
  readonly client: string | undefined;
  /** Set when a forwarded prefix disagrees with the configured mount. */
  readonly conflict: string | undefined;
}

/** The mount a configured server expects, ignoring any proxy. */
export function configuredPrefix(basePath: string, publicUrl: string | undefined): string {
  return effectivePrefix({ forwardedPrefix: undefined, basePath, publicUrl });
}

/** Resolve one request's mount point. */
export function resolveMount(req: IncomingMessage, config: Config): Mount {
  const proxy = proxyContext(req, config);
  const configured = configuredPrefix(config.server.basePath, config.server.publicUrl);
  const prefix = effectivePrefix({
    forwardedPrefix: proxy.forwardedPrefix,
    basePath: config.server.basePath,
    publicUrl: config.server.publicUrl,
  });

  // `mount === undefined` cannot happen for a loaded config: `loadConfig`
  // rejects a `basePath` that cannot be a prefix. Anything else is "no mount".
  const mount = normalizePrefix(config.server.basePath) ?? "";
  // A forwarded prefix means the proxy already stripped the path. A configured
  // `basePath` means it did not, so the path still has to carry it.
  const required = proxy.forwardedPrefix !== undefined ? "" : mount;
  const conflict =
    proxy.forwardedPrefix !== undefined && configured !== "" && proxy.forwardedPrefix !== configured
      ? `X-Forwarded-Prefix ${JSON.stringify(proxy.forwardedPrefix)} but the configured mount is ${JSON.stringify(configured)}`
      : undefined;

  return { prefix, required, tolerated: prefix, client: proxy.client, conflict };
}

export interface StrippedPath {
  readonly pathname: string;
  /** Set when the request has to be redirected instead of served. */
  readonly redirectTo?: string;
  /** Set when the path arrived outside the mount and cannot be salvaged. */
  readonly outside?: boolean;
}

/** Remove the mount from an incoming path, or report where it belongs instead. */
export function stripMount(mount: Mount, pathname: string): StrippedPath {
  // A bare `/` belongs at the mount point in every arrangement — including when
  // a configured `basePath` is still expected on the path and did not arrive.
  if (pathname === "/") return { pathname, redirectTo: `${mount.prefix}/basic-chat` };

  if (mount.required !== "") {
    if (pathname !== mount.required && !pathname.startsWith(`${mount.required}/`)) {
      return { pathname, outside: true };
    }
    return { pathname: pathname.slice(mount.required.length) || "/" };
  }

  // Tolerate a proxy that forwards the prefix without stripping it.
  const { tolerated } = mount;
  if (tolerated !== "" && (pathname === tolerated || pathname.startsWith(`${tolerated}/`))) {
    return { pathname: pathname.slice(tolerated.length) || "/" };
  }
  return { pathname };
}
