/**
 * One chat-stream page in jsdom, without the page bundle.
 *
 * The chat page is assembled by the panel branch, so this branch's parts are drawn
 * by mounting them in place of the elements `src/web/index.html` already carries
 * (`mountChatStream`). The shell is the real one: its `<meta>` stamps are filled the
 * way the server fills them, its own `<script>` tags are dropped, and `base.js` runs
 * so `window.piSecMount` is there before any module reads the mount.
 *
 * The modules are imported fresh for every page (`vi.resetModules`), because the
 * chat number and the mount are read once at module load, as they are in the
 * browser. `window`, `document` and `EventSource` are installed on the Node global
 * before the import, which is how the component and state modules see the page.
 *
 * Everything the page fetches is answered here, and every stream it opens is a
 * {@link FakeEventSource} from `test/ui/harness.ts`.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";
import { FakeEventSource, captureElement, expectUntouched, settle, type CapturedElement } from "./harness.ts";

/** The repository root, from this file's place in `test/ui/`. */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** What the fake `fetch` answers with. */
export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
}

/** An answer, or a function that reads the request and answers it. */
export type Answer = FakeAnswer | ((request: RecordedCall) => FakeAnswer | Promise<FakeAnswer>);

/** One request the page made. */
export interface RecordedCall {
  readonly url: string;
  /** The path without the mount prefix. */
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
}

/** What a test may set about the page it loads. */
export interface StreamPageOptions {
  /** The mount prefix the server would stamp; empty at the root. */
  readonly base?: string;
  /** The registered name the server would stamp. */
  readonly name?: string;
  /** The chat number in the address; `null` is the root conversation. */
  readonly chat?: number | null;
  /** Answers by path without the mount. An unlisted path answers `200 {}`. */
  readonly fetch?: Readonly<Record<string, Answer>>;
  /** False leaves the page without a mount stamp, which is the unknown-mount case. */
  readonly stamped?: boolean;
}

/** What one loaded page offers a test. */
export interface StreamPage {
  readonly window: JSDOM["window"];
  readonly document: Document;
  /** The stream module of this page. */
  readonly stream: typeof import("../../src/ui/streams/conversation.ts");
  /** The transcript state of this page. */
  readonly transcript: typeof import("../../src/ui/state/transcript.ts");
  /** The run state of this page. */
  readonly run: typeof import("../../src/ui/state/run.ts");
  /** The chat state of this page. */
  readonly conversation: typeof import("../../src/ui/state/conversation.ts");
  /** The one notice. */
  readonly toast: typeof import("../../src/ui/state/toast.ts");
  /** Every request the page made, in order. */
  readonly fetchCalls: RecordedCall[];
  /** Every URL a stream was opened on, in order. */
  streams(): string[];
  /** The stream the page holds now. */
  currentStream(): FakeEventSource;
  /** Send one frame on the current stream. */
  emit(name: string, payload?: unknown): void;
  /** Answer a path from now on. */
  respond(path: string, answer: Answer): void;
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
  /** The transcript's rows, as the page draws them. */
  rows(): ReturnType<typeof import("../../src/ui/streams/conversation.ts").currentRows>;
  /** Draw the parts into the shell a second time, as a page does after a reload. */
  remount(): void;
  close(): void;
}

/** Put one page value on the Node global, and say so if the runtime refuses. */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** The server's stamps: the mount, the time zone and the registered name. */
function stamp(html: string, base: string, name: string): string {
  return html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-timezone" content="Asia/Tokyo" />`)
    .replace(/<meta\s+name="pi-sec-name"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-name" content="${name}" />`);
}

/** One response object of the shape the request function reads. */
function responseFor(answer: FakeAnswer): {
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

/**
 * Load one chat page: the shell, the mount bridge, this branch's parts, and the
 * conversation stream.
 *
 * The modules of the previous page are dropped first, so every page reads its own
 * chat number, its own mount and its own state.
 */
export async function loadStreamPage(options: StreamPageOptions = {}): Promise<StreamPage> {
  vi.resetModules();
  const base = options.base ?? "";
  const chat = options.chat ?? null;
  let html = stamp(await readFile(join(root, "src/web/index.html"), "utf8"), base, options.name ?? "");
  if (options.stamped === false) html = html.replace(/<meta\s+name="pi-sec-base"[^>]*>/i, "");
  const shell = html.replace(/<script\b[^>]*>\s*<\/script>/gi, "");

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });
  for (const level of ["error", "warn"] as const) {
    virtualConsole.on(level, (...args: unknown[]) => console[level](...args));
  }

  FakeEventSource.instances = [];
  const pagePath = options.stamped === false ? "/nowhere" : "/basic-chat";
  const url = `http://localhost${pagePath}${chat === null ? "" : `?chat=${chat}`}`;
  const dom = new JSDOM(shell, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const document = window.document;

  const answers = new Map<string, Answer>(Object.entries(options.fetch ?? {}));
  const calls: RecordedCall[] = [];
  const fakeFetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const requestUrl = String(input);
    const parsed = new URL(requestUrl, "http://localhost");
    const path = base !== "" && parsed.pathname.startsWith(`${base}/`) ? parsed.pathname.slice(base.length) : parsed.pathname;
    const request: RecordedCall = {
      url: requestUrl,
      path,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(request);
    const answer = answers.get(parsed.pathname) ?? answers.get(path);
    const resolved = typeof answer === "function" ? await answer(request) : (answer ?? { status: 200, body: {} });
    return responseFor(resolved);
  };

  (window as unknown as { fetch: unknown }).fetch = fakeFetch;
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  // The modules run in Node, so the page they draw into has to be the global one.
  setGlobal("window", window);
  setGlobal("document", document);
  setGlobal("EventSource", FakeEventSource);
  setGlobal("fetch", fakeFetch);
  setGlobal("Node", window.Node);
  setGlobal("Element", window.Element);
  setGlobal("HTMLElement", window.HTMLElement);
  setGlobal("HTMLDetailsElement", window.HTMLDetailsElement);

  window.eval(await readFile(join(root, "src/web/base.js"), "utf8"));

  const parts = await import("../../src/ui/chat/ChatStreamParts.tsx");
  const stream = await import("../../src/ui/streams/conversation.ts");
  const transcript = await import("../../src/ui/state/transcript.ts");
  const run = await import("../../src/ui/state/run.ts");
  const conversation = await import("../../src/ui/state/conversation.ts");
  const toast = await import("../../src/ui/state/toast.ts");

  const handle = parts.mountChatStream(document);
  await stream.openChat();
  await settle();

  const currentStream = (): FakeEventSource => {
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("the chat page opened no stream");
    return source;
  };

  return {
    window,
    document,
    stream,
    transcript,
    run,
    conversation,
    toast,
    fetchCalls: calls,
    streams: () => FakeEventSource.instances.map((stream_) => stream_.url),
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
    rows: () => stream.currentRows(),
    remount() {
      handle.unmount();
      parts.mountChatStream(document);
    },
    close() {
      stream.stopConversation();
      handle.unmount();
      dom.window.close();
    },
  };
}

/** One snapshot entry the way the server writes it: an assistant answer. */
export function assistant(id: number, text: string): Record<string, unknown> {
  return { id, kind: "pi.assistant", model: [{ role: "assistant", content: text }] };
}

/** One operator message, written inside the envelope the server uses now. */
export function operatorMessage(id: number, body: string, attributes: Record<string, string> = {}): Record<string, unknown> {
  const extra = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  return {
    id,
    kind: "pi.user",
    model: [{ role: "user", content: `<pi-message src="operator"${extra}>\n${body}\n</pi-message>` }],
  };
}

/** One tool result entry. */
export function toolResult(id: number, name: string, callId: string, text: string): Record<string, unknown> {
  return {
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolName: name, toolCallId: callId, content: text }],
  };
}

/** Advance by one animation frame, for a page whose draw waits for one. */
export function nextFrame(window: JSDOM["window"]): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

// The first test in a file imports about ten TSX modules cold. On a busy machine
// that import alone passes the default 5 s test limit. This line applies only to
// files that import this harness.
vi.setConfig({ testTimeout: 50_000 });
