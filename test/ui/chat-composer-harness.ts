/**
 * One chat composer on the chat page, in jsdom, without the page bundle.
 *
 * The chat page is assembled by the panel branch, so this harness does what that
 * assembly will do: it draws the shell `src/web/index.html` really is (the stamps
 * filled the way the server fills them, the shell's own `<script>` tags dropped),
 * runs `base.js` so `window.piSecMount` is there before any module reads the
 * mount, and then mounts the two sets of parts that are in `main` today: the
 * composer (`mountChatComposer`) and the conversation stream's header and
 * transcript (`mountChatStream`). The composer's own tests only need the first,
 * but a page with a stream is the page the composer lives on, and the class the
 * stream's branch toggles on the form is part of the composer's story.
 *
 * The composer is mounted first, then the stream's parts, and then the stream is
 * opened, which is the order that keeps a class the stream branch wrote.
 *
 * The modules are imported fresh for every page (`vi.resetModules`), because the
 * chat number and the mount are read once at module load, as they are in the
 * browser. `window`, `document` and `EventSource` are installed on the Node global
 * before the import, which is how the component and state modules see the page.
 *
 * Everything the page fetches is answered here, every stream it opens is a
 * {@link FakeEventSource}, and `confirm` records the questions it is asked, so a
 * question is a value a test reads rather than something it has to intercept.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";
import { h } from "preact";
import { mountAt } from "../../src/ui/mount.ts";
import { FakeEventSource, captureElement, expectUntouched, type CapturedElement } from "./harness.ts";

/** The repository root, from this file's place in `test/ui/`. */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** What the fake `fetch` answers with. */
export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** One request the page made. */
export interface RecordedCall {
  readonly url: string;
  /** The path without the mount prefix. */
  readonly path: string;
  readonly method: string;
  /** The body as the fake saw it: text, or the file a body carries. */
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** An answer, or a function that reads the request and answers it. */
export type Answer = FakeAnswer | ((request: RecordedCall) => FakeAnswer | Promise<FakeAnswer>);

/** How one canvas was asked to shrink a picture. */
export interface CanvasCounters {
  contexts: number;
  draws: unknown[][];
  blobs: { type: string | undefined; quality: number | undefined; width: number; height: number }[];
}

/** What a test may set about the page it loads. */
export interface ComposerPageOptions {
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
  /** What a previous page left in `localStorage`, so a reload can be built from it. */
  readonly storage?: Readonly<Record<string, string>>;
  /** What a UI restart left in `sessionStorage`. */
  readonly session?: Readonly<Record<string, string>>;
  /** Refuse every draft write, the way a full store does. */
  readonly refuseWrites?: boolean;
  /** The size `createImageBitmap` reports for every picture. Absent, none is installed. */
  readonly bitmap?: { readonly width: number; readonly height: number };
  /** Leave the page without a real `confirm`: every question is refused. */
  readonly ask?: readonly boolean[];
}

/** What one loaded page offers a test. */
export interface ComposerPage {
  readonly window: JSDOM["window"];
  readonly document: Document;
  /** The composer's own state. */
  readonly composer: typeof import("../../src/ui/state/composer.ts");
  /** The tray and its uploads. */
  readonly attachments: typeof import("../../src/ui/state/attachments.ts");
  /** The context bar's numbers. */
  readonly context: typeof import("../../src/ui/state/context.ts");
  /** The run and connection state the buttons read. */
  readonly run: typeof import("../../src/ui/state/run.ts");
  /** The chat this page shows. */
  readonly conversation: typeof import("../../src/ui/state/conversation.ts");
  /** The one notice. */
  readonly toast: typeof import("../../src/ui/state/toast.ts");
  /** Every request the page made, in order. */
  readonly fetchCalls: RecordedCall[];
  /** Every canvas call, so "did this even touch a canvas" is measured. */
  readonly canvas: CanvasCounters;
  /** The reloads jsdom was asked for and refused: one entry is one reload. */
  readonly navigations: string[];
  /** Every question `confirm` was asked, in order. */
  readonly questions: string[];
  /** Every URL a stream was opened on, in order. */
  streams(): string[];
  /** The stream the page holds now. */
  currentStream(): FakeEventSource;
  /** Send one frame on the current stream. */
  emit(name: string, payload?: unknown): void;
  /** Answer a path from now on. */
  respond(path: string, answer: Answer): void;
  /** The text in the composer's field. */
  text(): string;
  /** Type into the field the way a reader does: the value, then the `input` event. */
  type(text: string): void;
  /** Press a key on the field. */
  press(init: KeyboardEventInit): KeyboardEvent;
  /** Submit the form, as a press on Send does. */
  submit(): void;
  /** Remember an element, its value, its caret, its focus, its scroll and its open state. */
  capture(selector: string): CapturedElement;
  /** Compare an element against what {@link capture} remembered. */
  expectUntouched(before: CapturedElement): void;
  /** Let the page answer: module updates, reads and renders. */
  settle(turns?: number): Promise<void>;
  /** Draw the parts into the shell a second time, as a page does after a reload. */
  remount(): void;
  close(): void;
}

/** Put one page value on the Node global, and say so if the runtime refuses. */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** The server's stamps: the mount and the registered name. */
function stamp(html: string, base: string, name: string): string {
  return html
    .replaceAll("{{base}}", base)
    .replace(/<meta\s+name="pi-sec-base"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-base" content="${base}" />`)
    .replace(/<meta\s+name="pi-sec-timezone"\s+content="[^"]*"\s*\/?>/i, '<meta name="pi-sec-timezone" content="Asia/Tokyo" />')
    .replace(/<meta\s+name="pi-sec-name"\s+content="[^"]*"\s*\/?>/i, `<meta name="pi-sec-name" content="${name}" />`);
}

/** One response object of the shape the request function reads. */
function responseFor(answer: FakeAnswer): {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const status = answer.status ?? 200;
  const text = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
  const headers = answer.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * Load one chat composer page: the shell, the mount bridge, the composer, the
 * stream's parts, and the conversation stream.
 *
 * The modules of the previous page are dropped first, so every page reads its own
 * chat number, its own mount and its own state.
 */
export async function loadComposerPage(options: ComposerPageOptions = {}): Promise<ComposerPage> {
  vi.resetModules();
  const base = options.base ?? "";
  const chat = options.chat ?? null;
  let html = stamp(await readFile(join(root, "src/web/index.html"), "utf8"), base, options.name ?? "");
  if (options.stamped === false) html = html.replace(/<meta\s+name="pi-sec-base"[^>]*>/i, "");
  const shell = html.replace(/<script\b[^>]*>\s*<\/script>/gi, "");

  const navigations: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    const message = String((error as { message?: unknown })?.message ?? error);
    // jsdom does not navigate, so a page that reloads itself lands here. That is
    // how a test counts the reloads its own press caused.
    if (message.includes("navigation")) {
      navigations.push(message);
      return;
    }
    // `requestSubmit` fires the submit event and then cannot take the form
    // anywhere, which is the step the page already prevents.
    if (message.includes("requestSubmit")) return;
    console.error(message);
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

  for (const [key, value] of Object.entries(options.storage ?? {})) window.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(options.session ?? {})) window.sessionStorage.setItem(key, value);

  // A store that refuses every write, the way a full one does, put in place before
  // any module reads it.
  if (options.refuseWrites === true) {
    const kept = new Map<string, string>(Object.entries(options.storage ?? {}));
    const refusing = {
      get length(): number {
        return kept.size;
      },
      key: (index: number): string | null => [...kept.keys()][index] ?? null,
      getItem: (key: string): string | null => kept.get(key) ?? null,
      setItem: (): void => {
        throw new Error("QuotaExceededError: the store is full");
      },
      removeItem: (key: string): void => {
        kept.delete(key);
      },
      clear: (): void => {
        kept.clear();
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => refusing });
  }

  const answers = new Map<string, Answer>(Object.entries(options.fetch ?? {}));
  const calls: RecordedCall[] = [];
  /** How many uploads the default answer has stored, so each gets its own id. */
  let uploadSeq = 0;
  /** The answer to a route no test named. An upload is stored; anything else is `200 {}`. */
  const defaultAnswer = (request: RecordedCall): FakeAnswer => {
    if (request.method === "POST" && request.path.startsWith("/api/attachments")) {
      uploadSeq += 1;
      const name = decodeURIComponent(new URL(request.url, "http://localhost").searchParams.get("name") ?? "attachment");
      return {
        status: 201,
        body: {
          id: `att-${uploadSeq}`,
          url: `/api/attachments/att-${uploadSeq}`,
          mime: request.headers["content-type"] ?? "application/octet-stream",
          bytes: (request.body as Blob | undefined)?.size ?? 0,
          name,
        },
      };
    }
    return { status: 200, body: {} };
  };
  const fakeFetch = async (input: unknown, init?: { method?: string; body?: unknown; headers?: unknown }) => {
    const requestUrl = String(input);
    const parsed = new URL(requestUrl, "http://localhost");
    const path = base !== "" && parsed.pathname.startsWith(`${base}/`) ? parsed.pathname.slice(base.length) : parsed.pathname;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, unknown>)) {
      headers[name.toLowerCase()] = String(value);
    }
    const request: RecordedCall = {
      url: requestUrl,
      path,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body,
      headers,
    };
    calls.push(request);
    const answer = answers.get(parsed.pathname) ?? answers.get(path);
    const resolved = typeof answer === "function" ? await answer(request) : (answer ?? defaultAnswer(request));
    return responseFor(resolved);
  };

  (window as unknown as { fetch: unknown }).fetch = fakeFetch;
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  // The questions `confirm` is asked, and how each is answered. A refusal is the
  // default, so a press a test did not expect to ask anything fails loudly.
  const questions: string[] = [];
  const replies = [...(options.ask ?? [])];
  (window as unknown as { confirm: unknown }).confirm = (message: string) => {
    questions.push(String(message));
    return replies.shift() === true;
  };

  // The modules run in Node, so the page they draw into has to be the global one.
  setGlobal("window", window);
  setGlobal("document", document);
  setGlobal("EventSource", FakeEventSource);
  setGlobal("fetch", fakeFetch);
  setGlobal("Node", window.Node);
  setGlobal("Element", window.Element);
  setGlobal("HTMLElement", window.HTMLElement);
  setGlobal("HTMLDetailsElement", window.HTMLDetailsElement);

  // Every canvas call is counted, and jsdom's absence of a canvas is replaced by
  // the least a shrinking path needs: a 2d context that records `drawImage`, and a
  // `toBlob` that hands back a few bytes.
  const canvas: CanvasCounters = { contexts: 0, draws: [], blobs: [] };
  const proto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto["getContext"] = function (this: HTMLCanvasElement) {
    canvas.contexts += 1;
    return { drawImage: (...args: unknown[]) => canvas.draws.push(args) };
  };
  proto["toBlob"] = function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ) {
    canvas.blobs.push({ type, quality, width: this.width, height: this.height });
    callback(new window.Blob([new Uint8Array([1, 2, 3])], { type }));
  };

  // A page either has `createImageBitmap` or it does not, and the global of a
  // previous page must not answer for this one.
  if (options.bitmap !== undefined) {
    const { width, height } = options.bitmap;
    const bitmapOf = async () => ({ width, height, close() {} });
    (window as unknown as { createImageBitmap: unknown }).createImageBitmap = bitmapOf;
    setGlobal("createImageBitmap", bitmapOf);
  } else {
    setGlobal("createImageBitmap", undefined);
  }

  window.eval(await readFile(join(root, "src/web/base.js"), "utf8"));

  const parts = await import("../../src/ui/chat/ComposerParts.tsx");
  const toastPart = await import("../../src/ui/components/toast.tsx");
  const streamParts = await import("../../src/ui/chat/ChatStreamParts.tsx");
  const stream = await import("../../src/ui/streams/conversation.ts");
  const composer = await import("../../src/ui/state/composer.ts");
  const attachments = await import("../../src/ui/state/attachments.ts");
  const context = await import("../../src/ui/state/context.ts");
  const run = await import("../../src/ui/state/run.ts");
  const conversation = await import("../../src/ui/state/conversation.ts");
  const toast = await import("../../src/ui/state/toast.ts");

  // The one notice is a part of its own (`src/ui/components/toast.tsx`), and the
  // page draws it; a page without it would swallow every sentence the composer
  // says about a refusal.
  const notice = document.querySelector("#toast");
  const offNotice = notice === null ? () => {} : mountAt(notice, h(toastPart.Toast, {}));

  const composerHandle = parts.mountChatComposer(document);
  const streamHandle = streamParts.mountChatStream(document);
  await stream.openChat();
  await settleTurns(6);

  const currentStream = (): FakeEventSource => {
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("the chat page opened no stream");
    return source;
  };
  // The browser opens the stream on its own, so the page is connected unless a
  // test says otherwise by failing it.
  if (FakeEventSource.instances.length > 0) {
    currentStream().open();
    await settleTurns(2);
  }

  const field = (): HTMLTextAreaElement => {
    const element = document.getElementById("message");
    if (element === null) throw new Error("the page has no composer field");
    return element as HTMLTextAreaElement;
  };

  return {
    window,
    document,
    composer,
    attachments,
    context,
    run,
    conversation,
    toast,
    fetchCalls: calls,
    canvas,
    navigations,
    questions,
    streams: () => FakeEventSource.instances.map((source) => source.url),
    currentStream,
    emit(name, payload) {
      currentStream().emit(name, payload);
    },
    respond(path, answer) {
      answers.set(path, answer);
    },
    text: () => field().value,
    type(text) {
      const element = field();
      element.value = text;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    press(init) {
      const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
      field().dispatchEvent(event);
      return event;
    },
    submit() {
      const form = document.getElementById("composer") as HTMLFormElement | null;
      if (form === null) throw new Error("the page has no composer");
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    capture: (selector) => captureElement(document, selector),
    expectUntouched,
    settle: settleTurns,
    remount() {
      composerHandle.unmount();
      streamHandle.unmount();
      parts.mountChatComposer(document);
      streamParts.mountChatStream(document);
    },
    close() {
      stream.stopConversation();
      composerHandle.unmount();
      streamHandle.unmount();
      offNotice();
      dom.window.close();
    },
  };
}

/** Some macrotasks, so a read answers and a render lands. */
export async function settleTurns(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One file a test picks. */
export function fileOf(window: JSDOM["window"], name: string, type: string, bytes = 1024): File {
  return new window.File([new Uint8Array(bytes)], name, { type }) as unknown as File;
}

/** One operator message the transcript can carry, inside the envelope the server writes. */
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

/** One assistant answer. */
export function assistant(id: number, text: string): Record<string, unknown> {
  return { id, kind: "pi.assistant", model: [{ role: "assistant", content: text }] };
}

/** The body the page sent on one POST, read as JSON. */
export function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.body ?? "{}")) as Record<string, unknown>;
}

// The first test in a file imports about ten TSX modules cold. On a busy machine
// that import alone passes the default 5 s test limit. This line applies only to
// files that import this harness.
vi.setConfig({ testTimeout: 50_000 });
