/**
 * A page built from the real page bundle, in jsdom, with the server faked.
 *
 * `loadUiPage(page)` does what the server and the browser do together:
 *
 * 1. It reads the page's shell from `src/web/`, fills the stamps the server
 *    writes into it (`{{base}}`, `pi-sec-base`, `pi-sec-timezone`,
 *    `pi-sec-name`), and drops the shell's own `<script>` tags. The address is
 *    the page's own path unless the test names another, because a page such as
 *    the report viewer reads its route off its own path.
 * 2. It puts `base.js` into the page the way the shell does, with `window.eval`,
 *    so `window.piSecMount` is there before any page code runs.
 * 3. It puts that page's bundle in, also with `window.eval`. The bundle is the
 *    test build of `scripts/build-ui.mjs`: an IIFE built from the same sources as
 *    the production bundle, because jsdom does not run module scripts.
 *
 * The bundle is built once per test process and reused. Everything the page
 * fetches is answered here (`fetch`), every stream it opens is a
 * {@link FakeEventSource}, and both are recorded so a test can read what the
 * page asked for.
 *
 * The extension card slots are left empty: this harness does not run extension
 * code.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { expect } from "vitest";
import { buildUi } from "../../scripts/build-ui.mjs";

/** The repository root. */
export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The pages, named as the entry modules are. */
export type UiPageName = "chat" | "report" | "chats" | "usage" | "usage-stats";

/** The shell the server serves for each page. */
const SHELLS: Readonly<Record<UiPageName, string>> = {
  chat: "index.html",
  report: "report.html",
  chats: "chats.html",
  usage: "usage.html",
  "usage-stats": "usage-stats.html",
};

/** The path each page is served at, which is what its URL says. */
const PAGE_PATHS: Readonly<Record<UiPageName, string>> = {
  chat: "/basic-chat",
  report: "/report",
  chats: "/chats",
  usage: "/usage",
  "usage-stats": "/usage/stats",
};

/** The test bundles, built once for the whole test process. */
let cachedBundles: Promise<Record<string, string>> | undefined;

function bundles(): Promise<Record<string, string>> {
  cachedBundles ??= buildUi({ root, mode: "test" }).then((result) => result.code as Record<string, string>);
  return cachedBundles;
}

/** One request the page made, as the fake `fetch` saw it. */
export interface RecordedRequest {
  readonly url: string;
  /** The path the request went to, with the mount on it. */
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Record<string, string>;
}

/** What the fake `fetch` answers with. */
export interface FakeResponse {
  readonly status?: number;
  /** A JSON body. Ignored when `text` is given. */
  readonly body?: unknown;
  /** The raw body, for a route that does not answer JSON. */
  readonly text?: string;
}

/** An answer, or a function that reads the request and answers it. */
export type FetchAnswer = FakeResponse | ((request: RecordedRequest) => FakeResponse | Promise<FakeResponse>);

/** What a test may change about the page it loads. */
export interface LoadUiPageOptions {
  /** The mount prefix the server would stamp; empty at the root. */
  readonly base?: string;
  /**
   * The address to load the page at, as the browser would show it, without the
   * origin. The page's own path is the default (`/report`, `/chats`, ...); a page
   * that reads its route off its own path — one report at `/report/<slug>`, one
   * focused chat at `/basic-chat?chat=<id>` — is loaded at the address it would
   * be served at.
   */
  readonly url?: string;
  /** The harness time zone the server would stamp. */
  readonly timezone?: string;
  /** The registered name the server would stamp. */
  readonly name?: string;
  /**
   * The shared preferences record the server would stamp into the page.
   *
   * The server stamps one into every page it serves, because `pagePreferences`
   * answers a record whenever its read succeeds. So the harness stamps an empty
   * record unless a test says otherwise: a page loaded here then behaves like a
   * served page and does not read the record at startup. `null` is the page a
   * failed read leaves, which a cached copy is too: that page reads
   * `GET /api/preferences` once, after its first paint.
   */
  readonly preferences?: Readonly<Record<string, unknown>> | null;
  /**
   * Answers by route, without the mount: `/api/jobs` answers the request the
   * page made to `/sec/api/jobs`. A path with no answer gets `200 {}`.
   */
  readonly fetch?: Readonly<Record<string, FetchAnswer>>;
  /**
   * The answer the server writes into the page as its `usage-first` data block.
   * Absent means the page carries none, as it would from a server that could not
   * build one. `loadUiPage` writes it where the shell leaves `<!--usage-first-->`,
   * escaping `<` the way the server does.
   */
  readonly firstPaint?: unknown;
  /**
   * The page links the server writes into the chat page as its `pages-links` data
   * block. Absent means the page carries none, as it would from a server whose
   * enabled extensions declare no page. `loadUiPage` writes it where the shell
   * leaves `<!--pages-links-->`, escaping `<` the way the server does.
   */
  readonly pagesLinks?: unknown;
  /**
   * The page's clock, in epoch milliseconds. When it is given, the page's
   * `Date.now()` starts at this moment and moves on with real time, so a page
   * that says how long ago something was says the same thing on every day the
   * test runs. The page runs in jsdom's own script context, which `vi.useFakeTimers`
   * and `vi.setSystemTime` do not reach, so the harness sets it there. Every
   * page reads the time through `Date.now()`; timers are left alone.
   */
  readonly now?: number;
}

/** What one loaded page offers a test. */
export interface UiPageHandle {
  readonly page: UiPageName;
  readonly window: JSDOM["window"];
  readonly document: Document;
  /** Every request the page made, in order. */
  readonly fetchCalls: RecordedRequest[];
  /** The page loads (reloads or links) the page asked for; jsdom refuses them and counts them here. */
  readonly navigations: string[];
  /** Every URL a stream was opened on, in order. */
  streams(): string[];
  /** The stream the page holds now. */
  currentStream(): FakeEventSource;
  /** Send one frame on the current stream. */
  emit(name: string, payload?: unknown): void;
  /** Answer a path from now on. */
  respond(path: string, answer: FetchAnswer): void;
  /** Pretend the tab was hidden or is visible again, as the browser reports it. */
  setVisibility(state: "hidden" | "visible"): void;
  /** Fire `pageshow`. `persisted` says the page came out of the back/forward cache. */
  pageShow(persisted: boolean): void;
  /** Fire `online`, as the browser does when the network comes back. */
  online(): void;
  /** Remember an element, its value, its caret, its focus, its scroll and its open state. */
  capture(selector: string): CapturedElement;
  /** Compare an element against what {@link capture} remembered. */
  expectUntouched(before: CapturedElement): void;
  close(): void;
}

/* ------------------------------------------------------------- streams */

type StreamListener = (event: { readonly type: string; readonly data: string; readonly lastEventId: string }) => void;

/**
 * An `EventSource` stand-in that lets a test drive the stream.
 *
 * Events are delivered to the listeners the page registered, with the fields a
 * real `MessageEvent` carries. `fail()` reports an error the way the browser
 * does: `readyState` is `CLOSED` (2) for a stream the server refused, and
 * `CONNECTING` (0) for one that only lost its connection.
 */
export class FakeEventSource {
  /** Every source made since the last `loadUiPage`, in order. */
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, StreamListener[]>();
  readyState = 0;
  /** True once the page closed it. */
  closed = false;
  #frames = 0;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: StreamListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: StreamListener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
    this.listeners.set(type, list);
  }

  /** Deliver one frame. `payload` is written as JSON, as the server writes it. */
  emit(type: string, payload?: unknown): void {
    this.#frames += 1;
    const data = payload === undefined ? "" : JSON.stringify(payload);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, data, lastEventId: String(this.#frames) });
    }
  }

  /** The connection opened. */
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  /**
   * The connection failed. `closed` says the browser gave up on it, which is
   * what it does for a stream the server answered with a non-200 code.
   */
  fail(options: { readonly closed?: boolean } = {}): void {
    this.readyState = options.closed === false ? 0 : 2;
    this.emit("error");
  }

  /** The page closed the stream. A real `EventSource` sends nothing for this. */
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

/* -------------------------------------------------------- what it draws */

/** An element and the state the browser does not report after a redraw. */
export interface CapturedElement {
  readonly document: Document;
  readonly selector: string;
  readonly element: Element;
  readonly value: string | undefined;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly focused: boolean;
  readonly scrollTop: number;
  readonly open: boolean | null;
}

/** Remember an element and the state a redraw could take from it. */
export function captureElement(doc: Document, selector: string): CapturedElement {
  const element = doc.querySelector(selector);
  if (element === null) throw new Error(`the page has no element matching ${selector}`);
  const field = element as HTMLInputElement;
  return {
    document: doc,
    selector,
    element,
    value: "value" in element ? String(field.value) : undefined,
    selectionStart: typeof field.selectionStart === "number" ? field.selectionStart : null,
    selectionEnd: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
    focused: doc.activeElement === element,
    scrollTop: (element as HTMLElement).scrollTop ?? 0,
    open: "open" in element ? Boolean((element as HTMLDetailsElement).open) : null,
  };
}

/**
 * Compare an element against a {@link captureElement} before a refresh.
 *
 * The element must be the same node (`===`), and the value, the caret, the
 * focus, the scroll position and the open state must be the ones it had. Every
 * difference is reported, not only the first, because a redraw that resets two
 * things should say both.
 */
export function expectUntouched(before: CapturedElement): void {
  const now = before.document.querySelector(before.selector);
  expect(now, `the page no longer has an element matching ${before.selector}`).toBe(before.element);
  if (now === null) return;
  if (before.value !== undefined) {
    expect.soft((now as HTMLInputElement).value, `${before.selector} lost its value`).toBe(before.value);
  }
  if (before.selectionStart !== null) {
    expect.soft((now as HTMLInputElement).selectionStart, `${before.selector} lost its caret`).toBe(before.selectionStart);
    expect.soft((now as HTMLInputElement).selectionEnd, `${before.selector} lost its selection end`).toBe(before.selectionEnd);
  }
  if (before.focused) {
    expect.soft(before.document.activeElement, `${before.selector} lost the focus`).toBe(before.element);
  } else {
    expect.soft(before.document.activeElement, `${before.selector} took the focus`).not.toBe(before.element);
  }
  expect.soft((now as HTMLElement).scrollTop, `${before.selector} lost its scroll position`).toBe(before.scrollTop);
  if (before.open !== null) {
    expect.soft((now as HTMLDetailsElement).open, `${before.selector} changed its open state`).toBe(before.open);
  }
}

/* -------------------------------------------------------------- the page */

/** The server's stamps: the mount, the time zone and the registered name. */
function stamp(
  html: string,
  base: string,
  timezone: string,
  name: string,
  preferences?: Readonly<Record<string, unknown>>,
): string {
  const content = preferences === undefined ? "" : JSON.stringify(preferences).replaceAll('"', "&quot;");
  return html
    .replace(
      /<meta\s+name="pi-sec-preferences"\s+content="[^"]*"\s*\/?>/i,
      () => `<meta name="pi-sec-preferences" content="${content}" />`,
    )
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(
      /<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="pi-sec-timezone" content="${timezone}" />`,
    )
    .replace(/<meta\s+name="pi-sec-name"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-name" content="${name}" />`);
}

/**
 * The record every served page carries: a store with no theme and no fold list,
 * which the page draws as it would any other.
 */
const DEFAULT_PREFERENCES: Readonly<Record<string, unknown>> = { uiRevision: 0 };

/** One response object of the shape the page's `request` function reads. */
function responseFor(answer: FakeResponse): {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const status = answer.status ?? 200;
  const text = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** A microtask and a macrotask, so the page's startup reads can answer. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the page's first paint, which is when Preact runs its effects.
 *
 * `useEffect` is deferred: Preact flushes it after one `requestAnimationFrame`,
 * which jsdom fires about 16 ms later. A page's startup read of the shared record
 * is one of those effects, so it lands well after {@link settle} returns, at a
 * point that moves with the machine's load. Four page tests in four files
 * compared a request count taken at load against the same count later, and that
 * read arrived inside the window they measured. Waiting for one animation frame
 * here puts every read a page starts at mount before any test reads its requests.
 *
 * No test here installs a fake clock before loading a page, so the wait is a real
 * frame.
 */
async function flushPaint(window: JSDOM["window"]): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  await settle();
}

/**
 * Load one page.
 *
 * The page's own scripts from the shell are not run: the bundle stands in for
 * them, and running both would draw the page twice.
 */
export async function loadUiPage(page: UiPageName, options: LoadUiPageOptions = {}): Promise<UiPageHandle> {
  const code = await bundles();
  const source = code[page];
  if (source === undefined) throw new Error(`the test build has no ${page} page bundle`);

  const base = options.base ?? "";
  const html = stamp(
    await readFile(join(root, "src/web", SHELLS[page]), "utf8"),
    base,
    options.timezone ?? "Asia/Tokyo",
    options.name ?? "",
    options.preferences === null ? undefined : (options.preferences ?? DEFAULT_PREFERENCES),
  );
  const withBlock =
    options.firstPaint === undefined
      ? html
      : html.replace(
          "<!--usage-first-->",
          `<script type="application/json" id="usage-first">${JSON.stringify(options.firstPaint).replaceAll("<", "\\u003c")}</script>`,
        );
  const withPages =
    options.pagesLinks === undefined
      ? withBlock
      : withBlock.replace(
          "<!--pages-links-->",
          `<script type="application/json" id="pages-links">${JSON.stringify(options.pagesLinks).replaceAll("<", "\\u003c")}</script>`,
        );
  // The shell's own script tags are empty and stay unrun; the block above is not
  // a script the page runs, so it survives this.
  const shell = withPages.replace(/<script\b[^>]*>\s*<\/script>/gi, "");

  const navigations: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    // jsdom cannot navigate, which no page asks for here; anything else is a
    // page error worth failing on.
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.includes("navigation")) navigations.push(message);
    else console.error(error);
  });
  for (const level of ["error", "warn"] as const) {
    virtualConsole.on(level, (...args: unknown[]) => console[level](...args));
  }

  FakeEventSource.instances = [];
  const dom = new JSDOM(shell, {
    url: `http://localhost${options.url ?? PAGE_PATHS[page]}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const document = window.document;

  const answers = new Map<string, FetchAnswer>(Object.entries(options.fetch ?? {}));
  const calls: RecordedRequest[] = [];
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: unknown; headers?: unknown }) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const request: RecordedRequest = {
      url,
      path: parsed.pathname,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(request);
    // A test names routes; the page asks for paths under the mount.
    const route =
      base !== "" && request.path.startsWith(`${base}/`) ? request.path.slice(base.length) : request.path;
    const answer = answers.get(request.path) ?? answers.get(route);
    const resolved = typeof answer === "function" ? await answer(request) : (answer ?? { status: 200, body: {} });
    return responseFor(resolved);
  };
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    media: "(max-width: 860px)",
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });

  if (options.now !== undefined) {
    // Before any page code runs: base.js and the bundle read this `Date`.
    window.eval(`{
      const realNow = Date.now.bind(Date);
      const offset = ${Number(options.now)} - realNow();
      Date.now = () => realNow() + offset;
    }`);
  }
  window.eval(await readFile(join(root, "src/web/base.js"), "utf8"));
  window.eval(source);
  await flushPaint(window);

  const currentStream = (): FakeEventSource => {
    const source_ = FakeEventSource.instances.at(-1);
    if (source_ === undefined) throw new Error(`the ${page} page opened no stream`);
    return source_;
  };

  return {
    page,
    window,
    document,
    fetchCalls: calls,
    navigations,
    streams: () => FakeEventSource.instances.map((stream) => stream.url),
    currentStream,
    emit(name, payload) {
      currentStream().emit(name, payload);
    },
    respond(path, answer) {
      answers.set(path, answer);
    },
    setVisibility(state) {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    pageShow(persisted) {
      const event = new window.Event("pageshow");
      Object.defineProperty(event, "persisted", { value: persisted });
      window.dispatchEvent(event);
    },
    online() {
      window.dispatchEvent(new window.Event("online"));
    },
    capture: (selector) => captureElement(document, selector),
    expectUntouched,
    close() {
      dom.window.close();
    },
  };
}
