// Where this page is mounted — one rule, shared by the chat page and the report
// viewer. A classic script, not a module, so the tests can load it the same way
// the page does (`window.eval`), and so it can come before either page's script.
//
// The server stamps the mount point into `<meta name="pi-sec-base">` on every
// page it serves, and that stamp is authoritative. Behind a path-prefix proxy
// the browser's URL says nothing about it: a proxy that strips its prefix
// forwards `/basic-chat` for a page the browser visited at `/sec/basic-chat`.
//
// When the stamp is missing the page did not come from this server — a static
// copy, or a cached one from before the stamp existed. There is a fallback for
// that, but it is *checked*: it may only be used when the page's own path names
// the page (so the prefix is whatever precedes it), and the result has to look
// like a mount. Falling back to the empty string or to a guess is what put a
// browser on `/basic-chat/events` with no prefix, which a proxy answers 404
// before the daemon ever sees the request — and, worse, the same shape let a
// proxy's wrong prefix (`/other`) rewrite every URL the page used without
// anything on the page noticing. So when nothing can be determined, callers are
// told that it is unknown and say so, rather than quietly building wrong URLs.
(function () {
  /** The page routes this app serves. A path ending in one of these names it. */
  var PAGES = ["/basic-chat", "/report", "/chats", "/usage"];

  /** A usable mount: empty, or a sequence of plain path segments. */
  var MOUNT = /^(?:\/[A-Za-z0-9._~-]+)*$/;

  function trim(value) {
    return String(value).replace(/\/+$/, "");
  }

  function usable(value) {
    return value === "" || (MOUNT.test(value) && value.indexOf("//") === -1);
  }

  /**
   * The mount implied by a page path: everything before the page route the path
   * names. `undefined` when the path names no page, because then the path says
   * nothing about where the app is mounted.
   */
  function mountFromPath(pathname) {
    for (var i = 0; i < PAGES.length; i += 1) {
      var page = PAGES[i];
      var at = pathname.indexOf(page);
      if (at === -1) continue;
      var after = pathname.slice(at + page.length);
      if (after === "" || after.charAt(0) === "/") return trim(pathname.slice(0, at));
    }
    return undefined;
  }

  /**
   * `{ base, known, inferred }` for one document.
   *
   * `known` is false when neither the stamp nor the path says where this page is
   * mounted. `base` is then empty — the same value the app would have used
   * silently — but the caller is expected to say so rather than act on it.
   */
  function resolve(doc) {
    var document_ = doc || window.document;
    var meta = document_.querySelector('meta[name="pi-sec-base"]');
    var stamped = meta === null ? "" : (meta.getAttribute("content") || "").trim();
    if (stamped !== "") {
      var cleaned = trim(stamped);
      if (usable(cleaned)) return { base: cleaned, known: true, inferred: false };
    }

    var path = (document_.location && document_.location.pathname) || "";
    var inferred = mountFromPath(path.replace(/\/+$/, ""));
    if (inferred !== undefined && usable(inferred)) return { base: inferred, known: true, inferred: true };

    return { base: "", known: false, inferred: false };
  }

  /**
   * A route under the mount: `at("/sec", "/report/x")` is `/sec/report/x`.
   * Absolute, always — a route that is not absolute would silently land next to
   * whatever page happens to be open. That is the bug this file exists to stop.
   */
  function at(base, route) {
    if (typeof route !== "string" || route.charAt(0) !== "/") {
      throw new Error("a route must be absolute, got " + JSON.stringify(route));
    }
    return base + route;
  }

  /** The same, for a route that may already carry the mount. */
  function join(base, route) {
    if (base !== "" && (route === base || route.indexOf(base + "/") === 0)) return route;
    return at(base, route);
  }

  window.piSecMount = { resolve: resolve, at: at, join: join, usable: usable, trim: trim };
})();
