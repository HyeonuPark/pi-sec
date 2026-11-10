/**
 * One loader for the three GitHub pull request page tests (diff, list, view).
 *
 * The page is loaded the way the server and the browser load it: the real shell from
 * `src/web/<page>.html`, the stamps the server writes, the JSON data blocks,
 * `base.js`, and the test bundle of the real entry module. The harness in
 * `test/ui/harness.ts` knows the four older pages only, so these three share this one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { buildUi, ROOT } from "../../scripts/build-ui.mjs";

type DOMWindow = JSDOM["window"];

/** What `github-pr-meta` holds when writes are on. */
export const META_WRITES = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: true };

/** What it holds when writes are off. */
export const META_READ_ONLY = { viewer: "octocat", repos: [{ repo: "acme/widgets" }], writes: false };

/**
 * One request that the page sent. `body` is undefined when the request had no string
 * body or the page was loaded with `recordBody: false`. It is not null, because
 * `toEqual` ignores an undefined field.
 */
export interface PageCall {
  readonly path: string;
  readonly method: string;
  readonly body: string | undefined;
}

/** What the fake `fetch` answers with. */
export interface PageAnswer {
  readonly status?: number;
  readonly body?: unknown;
}

/** An answer, or a function that answers when the test says so. It gets the call. */
export type PageReply = PageAnswer | ((call: PageCall) => PageAnswer | Promise<PageAnswer>);

/** An `EventSource` stand-in, which records itself so a test can drive a frame. */
export class RecordingSource {
  readonly url: string;
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  readyState = 0;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}

  emit(type: string, payload?: unknown): void {
    const data = payload === undefined ? "" : JSON.stringify(payload);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data });
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

export interface GithubPrPageOptions {
  /** The shell src/web/<page>.html and the bundle of the same name. */
  readonly page: "github-pr-diff" | "github-pr-list" | "github-pr-view";
  /** Path and query of the page address. */
  readonly path: string;
  readonly base?: string;
  /** The meta block. Default META_WRITES. */
  readonly meta?: unknown;
  /** False leaves the meta marker empty. */
  readonly metaBlock?: boolean;
  /** Other data blocks: the marker <!--id--> becomes the JSON block "id"; an entry with no value empties the marker. */
  readonly blocks?: Readonly<Record<string, unknown>>;
  /** False records no body, as the list test did: its cases compare whole calls to { path, method }. Default true. */
  readonly recordBody?: boolean;
  readonly replies?: Readonly<Record<string, PageReply>>;
  /** Runs before the page's bundle, so a test can plant what a tab already held. */
  readonly before?: (window: DOMWindow) => void;
}

/** What one loaded page offers a test. */
export interface GithubPrPage {
  readonly window: DOMWindow;
  readonly document: Document;
  readonly calls: PageCall[];
  /** The streams the page opened. Empty for diff and view, which open none. */
  readonly streams: RecordingSource[];
  /** Answer a path from now on. */
  respond(path: string, reply: PageReply): void;
  /** Send one frame on the page's current stream; throws when the page opened none. */
  emit(name: string): void;
  /** A microtask and a macrotask, so the page's reads can answer. */
  settle(): Promise<void>;
  close(): void;
}

/** The test bundles, built once for the whole file. */
let bundles: Promise<Record<string, string>> | undefined;

function bundle(): Promise<Record<string, string>> {
  bundles ??= buildUi({ root: ROOT, mode: "test" }).then((result) => result.code as Record<string, string>);
  return bundles;
}

/** A JSON data block, written as the server writes it: `<` escaped, never run. */
export function block(id: string, value: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`;
}

/** The shell with the server's stamps and the data blocks in it. */
async function shell(options: GithubPrPageOptions): Promise<string> {
  const base = options.base ?? "";
  let html = await readFile(join(ROOT, `src/web/${options.page}.html`), "utf8");
  html = html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, '<meta name="pi-sec-timezone" content="Asia/Tokyo" />');
  html = html.replace("<!--github-pr-meta-->", options.metaBlock === false ? "" : block("github-pr-meta", options.meta ?? META_WRITES));
  for (const [id, value] of Object.entries(options.blocks ?? {})) {
    html = html.replace(`<!--${id}-->`, value === undefined ? "" : block(id, value));
  }
  return html;
}

/** Load one of the three pages with the server faked. */
export async function loadGithubPrPage(options: GithubPrPageOptions): Promise<GithubPrPage> {
  const code = await bundle();
  const source = code[options.page];
  if (source === undefined) throw new Error(`the test build has no ${options.page} page bundle`);

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });

  const dom = new JSDOM(await shell(options), {
    url: `http://localhost${options.path}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const document = window.document;
  const calls: PageCall[] = [];
  const streams: RecordingSource[] = [];
  const replies = new Map<string, PageReply>(Object.entries(options.replies ?? {}));

  (window as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input), "http://localhost");
    const entry: PageCall = {
      path: url.pathname + url.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: options.recordBody !== false && typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(entry);
    const reply = replies.get(url.pathname + url.search) ?? replies.get(url.pathname) ?? { status: 200, body: {} };
    const answer = typeof reply === "function" ? await reply(entry) : reply;
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  (window as unknown as { EventSource: unknown }).EventSource = class extends RecordingSource {
    constructor(url: string | URL) {
      super(url);
      streams.push(this);
    }
  };

  options.before?.(window);
  window.eval(await readFile(join(ROOT, "src/web/base.js"), "utf8"));
  window.eval(source);

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();

  return {
    window,
    document,
    calls,
    streams,
    respond(path, reply) {
      replies.set(path, reply);
    },
    emit(name) {
      const current = streams.at(-1);
      if (current === undefined) throw new Error("the page opened no stream");
      current.emit(name);
    },
    settle,
    close() {
      dom.window.close();
    },
  };
}
