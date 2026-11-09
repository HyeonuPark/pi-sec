// The helper every extension page gets: `window.piSecPage`. A classic script, so
// it runs before the extension's own module script.
//
// It reads the meta elements the server stamped, and builds the URLs under
// `<base>/ext/<name>/api/`. `fetch` is a convenience over the ordinary `fetch`:
// a script can call `fetch` itself with the same URL.
(function () {
  function meta(name) {
    var element = document.querySelector('meta[name="' + name + '"]');
    return element === null ? "" : (element.getAttribute("content") || "").trim();
  }

  var base = meta("pi-sec-base").replace(/\/+$/, "");
  var extension = meta("pi-sec-ext");
  var page = meta("pi-sec-page");

  /** `<base>/ext/<name>/api/<path>`; the path has no leading slash. */
  function apiUrl(path) {
    var rest = String(path === undefined ? "" : path).replace(/^\/+/, "");
    return base + "/ext/" + encodeURIComponent(extension) + "/api/" + rest;
  }

  /**
   * The ordinary `fetch` on the api URL. A `body` that is not a string is sent as
   * JSON, and `Content-Type: application/json` is set whenever there is a body.
   */
  function pageFetch(path, init) {
    var options = Object.assign({}, init || {});
    if (options.body !== undefined && options.body !== null) {
      var headers = new Headers(options.headers || {});
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      options.headers = headers;
      if (typeof options.body !== "string") options.body = JSON.stringify(options.body);
    }
    return window.fetch(apiUrl(path), options);
  }

  window.piSecPage = Object.freeze({
    extension: extension,
    page: page,
    base: base,
    apiUrl: apiUrl,
    fetch: pageFetch,
  });
})();
