/**
 * The routes under `/ext/<name>/`: the page document, the api, the limits, and the
 * rule that an extension answers only under its own prefix.
 */
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.ts";
import {
  bootServer,
  installHostStatus,
  pagesExtension,
  writeExtension,
  type BootOptions,
  type BootedPages,
} from "./ext-pages-helpers.ts";

let booted: BootedPages | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const SHEET = "body{color:red}\n";
const SCRIPT = "export const on = true;\n";

/** An extension whose pages behave as the case needs. Each `render` branch reads its page name. */
const DEMO = pagesExtension(
  "demo",
  `
export const pages = {
  entries: [
    { page: "", label: "Demo", menu: true, script: "app.js", style: "app.css" },
    { page: "plain", label: "Plain" },
    { page: "styled", label: "Styled" },
    { page: "gone", label: "Gone" },
    { page: "throws", label: "Throws" },
    { page: "slow", label: "Slow" },
    { page: "huge", label: "Huge" },
    { page: "echo", label: "Echo" },
    { page: "tricky", label: "Tricky" },
  ],
  render({ page, query, config, timezone }) {
    if (page === "gone") return null;
    if (page === "throws") throw new Error("boom");
    if (page === "slow") return new Promise(() => {});
    if (page === "huge") return { html: "x".repeat(2000) };
    if (page === "styled") return { html: "<p>styled</p>", css: "p { color: blue }" };
    if (page === "echo") return { html: "<p>" + JSON.stringify({ query, timezone, config }) + "</p>" };
    if (page === "tricky") return { html: "<p>$& $1 <!--ext-head--></p>", title: "A <b> & \\"q\\"" };
    return { html: "<p>body of " + (page || "index") + "</p><script>window.inline = 1</script>" };
  },
  api({ method, path, query, body }) {
    if (path === "slow") return new Promise(() => {});
    if (path === "throws") throw new Error("api boom");
    if (path === "huge") return { json: { text: "y".repeat(3000) } };
    if (path === "cyclic") { const a = {}; a.a = a; return { json: a }; }
    if (path === "empty") return { status: 204 };
    if (path === "created") return { status: 201, json: { made: true } };
    return { json: { method, path, query, body: body === undefined ? null : body } };
  },
};
`,
);

/** Boot a server with the demo extension loaded. */
async function boot(options: BootOptions = {}): Promise<string> {
  booted = await bootServer({
    ...options,
    server: { extPages: { renderTimeoutMs: 100, apiTimeoutMs: 100, maxPageBytes: 1000, maxApiBytes: 1000 }, ...(options.server ?? {}) },
  });
  await writeExtension(booted.harness, "demo", DEMO, {
    "ui/app.js": SCRIPT,
    "ui/app.css": SHEET,
    "ui/other.mjs": SCRIPT,
  });
  const loaded = await booted.harness.runtime.loader.loadAll();
  expect(loaded.errors).toEqual([]);
  return booted.origin;
}

interface ErrorBody {
  error: { code: string };
}

describe("GET /ext/<name>/ and /ext/<name>/<page>", () => {
  it("builds the document: stamps, theme, title, body, and the file URLs with a version", async () => {
    const origin = await boot();
    const response = await fetch(`${origin}/ext/demo/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('<meta name="pi-sec-base" content="" />');
    expect(html).toContain('<meta name="pi-sec-ext" content="demo" />');
    expect(html).toContain('<meta name="pi-sec-page" content="" />');
    expect(html).toMatch(/<meta name="pi-sec-timezone" content="[^"]+" \/>/);
    expect(html).toMatch(/<html lang="en" data-theme="[a-z]+">/);
    expect(html).toContain('<link rel="stylesheet" href="/theme.css" />');
    expect(html).toContain("<title>Demo · pi-sec</title>");
    expect(html).toContain("<p>body of index</p>");
    expect(html).toMatch(/<link rel="stylesheet" href="\/ext\/demo\/ui\/app\.css\?v=\d+" \/>/);
    expect(html).toMatch(/<script type="module" src="\/ext\/demo\/ui\/app\.js\?v=\d+"><\/script>/);
    // The style link comes after the core styles, and the script after the helper.
    expect(html.indexOf("ext/demo/ui/app.css")).toBeGreaterThan(html.indexOf("/ext-page.css"));
    expect(html.indexOf("ext/demo/ui/app.js")).toBeGreaterThan(html.indexOf("/ext-page.js"));
    // No placeholder is left behind.
    expect(html).not.toContain("<!--ext-");
    expect(html).not.toContain("{{base}}");
  });

  it("answers the same page without the trailing slash, and a named page", async () => {
    const origin = await boot();
    expect(await (await fetch(`${origin}/ext/demo`)).text()).toContain("body of index");
    const plain = await fetch(`${origin}/ext/demo/plain`);
    expect(plain.status).toBe(200);
    const html = await plain.text();
    expect(html).toContain("<p>body of plain</p>");
    expect(html).toContain('<meta name="pi-sec-page" content="plain" />');
    // A page with no script or style declares no file.
    expect(html).not.toContain("/ext/demo/ui/");
  });

  it("puts the mount prefix in the meta tag and in every URL", async () => {
    const origin = await boot({
      config: { server: { ...defaultConfig().server, port: 0, basePath: "/pi", publicUrl: undefined } },
    });
    const html = await (await fetch(`${origin}/pi/ext/demo/`)).text();
    expect(html).toContain('<meta name="pi-sec-base" content="/pi" />');
    expect(html).toContain('href="/pi/theme.css"');
    expect(html).toContain('src="/pi/ext-page.js"');
    expect(html).toMatch(/href="\/pi\/ext\/demo\/ui\/app\.css\?v=\d+"/);
    expect(html).toMatch(/src="\/pi\/ext\/demo\/ui\/app\.js\?v=\d+"/);
  });

  it("sends the core policy without a nonce, and with a nonce when render returns css", async () => {
    const origin = await boot();
    const base = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";
    const plain = await fetch(`${origin}/ext/demo/plain`);
    expect(plain.headers.get("content-security-policy")).toBe(base);
    expect(plain.headers.get("cache-control")).toBe("no-cache");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    expect(plain.headers.get("referrer-policy")).toBe("no-referrer");

    const styled = await fetch(`${origin}/ext/demo/styled`);
    const policy = styled.headers.get("content-security-policy") ?? "";
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(policy.replace(/'nonce-[^']+'/, "").replace("style-src 'self' ", "style-src 'self'")).toBe(base);
    const html = await styled.text();
    expect(html).toContain(`<style nonce="${nonce}">p { color: blue }</style>`);
  });

  it("does not read the extension's text as a placeholder, and escapes the title", async () => {
    const origin = await boot();
    const html = await (await fetch(`${origin}/ext/demo/tricky`)).text();
    expect(html).toContain("<p>$& $1 <!--ext-head--></p>");
    expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;q&quot; · pi-sec</title>");
  });

  it("does not run the card markup check: forms, scripts and long bodies are the page's own", async () => {
    const origin = await boot();
    const html = await (await fetch(`${origin}/ext/demo/plain`)).text();
    expect(html).toContain("<script>window.inline = 1</script>");
  });

  it("passes the query, the zone and the config to render", async () => {
    const origin = await boot({ config: { timezone: "Asia/Tokyo" } });
    const html = await (await fetch(`${origin}/ext/demo/echo?a=1&b=two&a=3`)).text();
    expect(html).toContain('{"query":{"a":"1","b":"two"},"timezone":"Asia/Tokyo"}');
  });

  it("answers 404 for a null render, an unknown page, an unknown extension, a deep path and a reserved name", async () => {
    const origin = await boot();
    for (const path of [
      "/ext/demo/gone",
      "/ext/demo/nope",
      "/ext/nope/",
      "/ext/demo/plain/more",
      "/ext/demo/Plain",
      "/ext/demo/ui",
      "/ext/demo/..",
      "/ext/demo/%2e%2e",
      "/ext/demo/a%2Fb",
    ]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(404);
    }
    // The same answer for an unknown extension and an unknown page.
    const a = await (await fetch(`${origin}/ext/nope/`)).json() as ErrorBody;
    const b = await (await fetch(`${origin}/ext/demo/nope`)).json() as ErrorBody;
    expect(a.error.code).toBe(b.error.code);
  });

  it("answers a core error page for a throw (500), a timeout (504) and a body over the limit (500)", async () => {
    const origin = await boot();
    const thrown = await fetch(`${origin}/ext/demo/throws`);
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).not.toContain("boom");
    expect((await fetch(`${origin}/ext/demo/slow`)).status).toBe(504);
    expect((await fetch(`${origin}/ext/demo/huge`)).status).toBe(500);
  });
});

describe("/ext/<name>/api/*", () => {
  const post = (origin: string, path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }), ...init });

  it("passes the method, path, query and body, for every method", async () => {
    const origin = await boot();
    const get = await fetch(`${origin}/ext/demo/api/x/y?q=1`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ method: "GET", path: "x/y", query: { q: "1" }, body: null });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await post(origin, "/ext/demo/api/m", { method });
      expect(await response.json(), method).toEqual({ method, path: "m", query: {}, body: { a: 1 } });
    }
    const bare = await fetch(`${origin}/ext/demo/api/m`, { method: "DELETE" });
    expect(bare.status).toBe(200);
  });

  it("answers the status the extension returned, and no body for 204", async () => {
    const origin = await boot();
    const created = await fetch(`${origin}/ext/demo/api/created`);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ made: true });
    expect(created.headers.get("content-type")).toContain("application/json");
    const empty = await fetch(`${origin}/ext/demo/api/empty`);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("answers 415 for a body that is not JSON", async () => {
    const origin = await boot();
    const response = await post(origin, "/ext/demo/api/m", { headers: { "Content-Type": "text/plain" }, body: "hello" });
    expect(response.status).toBe(415);
    expect(((await response.json()) as ErrorBody).error.code).toBe("json_required");
  });

  it("answers 403 for Origin null and for a foreign origin, before the extension runs", async () => {
    const origin = await boot();
    for (const value of ["null", "https://evil.example"]) {
      const response = await post(origin, "/ext/demo/api/m", { headers: { "Content-Type": "application/json", Origin: value } });
      expect(response.status, value).toBe(403);
    }
    // The page's own origin passes.
    const same = await post(origin, "/ext/demo/api/m", { headers: { "Content-Type": "application/json", Origin: origin } });
    expect(same.status).toBe(200);
  });

  it("answers 404 for an unknown extension, an extension with no api, and the wrong prefix", async () => {
    const origin = await boot();
    expect((await fetch(`${origin}/ext/nope/api/x`)).status).toBe(404);
    await writeExtension(
      booted!.harness,
      "noapi",
      pagesExtension("noapi", `export const pages = { entries: [{ page: "", label: "x" }], render() { return { html: "" }; } };`),
    );
    await booted!.harness.runtime.loader.reload();
    expect((await fetch(`${origin}/ext/noapi/api/x`)).status).toBe(404);
    expect((await fetch(`${origin}/ext/noapi/`)).status).toBe(200);
  });

  it("answers 504 on a timeout, 500 on a throw, a cyclic answer and an answer over the limit", async () => {
    const origin = await boot();
    expect((await fetch(`${origin}/ext/demo/api/slow`)).status).toBe(504);
    const thrown = await fetch(`${origin}/ext/demo/api/throws`);
    expect(thrown.status).toBe(500);
    expect(JSON.stringify(await thrown.json())).not.toContain("api boom");
    expect((await fetch(`${origin}/ext/demo/api/cyclic`)).status).toBe(500);
    expect((await fetch(`${origin}/ext/demo/api/huge`)).status).toBe(500);
  });
});

describe("the file route and the other routes", () => {
  it("serves the files of a page-only extension, and still serves cards", async () => {
    const origin = await boot();
    const file = await fetch(`${origin}/ext/demo/ui/app.css`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(SHEET);
    expect((await fetch(`${origin}/ext/demo/ui/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${origin}/ext/demo/ui/nope.js`)).status).toBe(404);
    expect((await fetch(`${origin}/ext/demo/ui/%2e%2e/index.js`)).status).toBe(404);

    // An extension with cards and no pages keeps its file route.
    await writeExtension(
      booted!.harness,
      "cards",
      pagesExtension(
        "cards",
        `export const ui = { cards: [{ slot: "sidebar.bottom", name: "c", script: "c.js" }], render() { return { html: "<b>x</b>" }; } };`,
      ),
      { "ui/c.js": SCRIPT },
    );
    await booted!.harness.runtime.loader.reload();
    expect((await fetch(`${origin}/ext/cards/ui/c.js`)).status).toBe(200);
    expect((await fetch(`${origin}/ext/cards/`)).status).toBe(404);
  });

  it("answers only under its own prefix: another extension and the core routes are unaffected", async () => {
    const origin = await boot();
    // An extension named like a core route owns only /ext/<that name>/.
    await writeExtension(
      booted!.harness,
      "report",
      pagesExtension("report", `export const pages = { entries: [{ page: "", label: "r" }], render() { return { html: "<p>mine</p>" }; } };`),
    );
    await booted!.harness.runtime.loader.reload();
    expect(await (await fetch(`${origin}/ext/report/`)).text()).toContain("<p>mine</p>");
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${origin}/ext/demo/`)).text()).toContain("body of index");
    // A path that is not under /ext/<name>/ is not an extension's.
    expect((await fetch(`${origin}/demo/`)).status).toBe(404);
  });

  it("serves the example page, its api and its files", async () => {
    booted = await bootServer();
    await installHostStatus(booted.harness);
    await booted.harness.runtime.loader.reload();
    const html = await (await fetch(`${booted.origin}/ext/host-status/`)).text();
    expect(html).toContain("<h1>Host status</h1>");
    expect(html).toContain('data-field="load"');
    const status = (await (await fetch(`${booted.origin}/ext/host-status/api/status`)).json()) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual([
      "daemonUptimeSeconds",
      "freeMemoryBytes",
      "hostUptimeSeconds",
      "load",
      "totalMemoryBytes",
    ]);
    expect((await fetch(`${booted.origin}/ext-page.js`)).status).toBe(200);
    expect((await fetch(`${booted.origin}/ext-page.css`)).status).toBe(200);
  });

  it("survives a malformed percent escape in the path", async () => {
    const origin = await boot();
    const port = Number(new URL(origin).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/ext/demo/%zz" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${origin}/ext/demo/`)).status).toBe(200);
  });
});
