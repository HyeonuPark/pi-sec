/**
 * Web pages a runtime extension offers under `/ext/<name>/`.
 *
 * A runtime extension may export `pages` next to `create` and `ui`: the pages it
 * declares, a `render` function that draws the body of one page, and an optional
 * `api` function that answers the page's own requests. This module owns what
 * happens to that export:
 *
 * - which extension holds which page, so a reload takes back exactly what the
 *   previous module instance registered,
 * - the rules a page name and a page's script and style files must follow, with
 *   one diagnostic line per dropped entry,
 * - the shape checks on what `render` and `api` return.
 *
 * The registry never touches the network. The server owns the document frame, the
 * timeouts, the size limits and the headers. An extension registers no path: the
 * server fixes every route under `/ext/<name>/`, and this registry only answers
 * which pages and which callbacks the live registration holds.
 */
import { join } from "node:path";
import { uiFileProblem } from "./ui-file.ts";

/** A page name: lowercase words joined by hyphens. The empty string is the index page. */
export const PAGE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An extension name that can be one URL segment. The rule of the card file route. */
export const PAGE_EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Sub-paths the core serves under `/ext/<name>/`, so no page may use them. */
export const PAGE_RESERVED_NAMES: readonly string[] = ["ui", "api"];

/** The HTTP methods the api route passes to an extension. */
export const PAGE_API_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** How many diagnostic lines one extension keeps; the newest win. */
const PAGE_DIAGNOSTIC_MAX_ERRORS = 20;

/** How the diagnostics name the index page, which has no valid page name. */
const INDEX_LABEL = "/";

/** One page an extension declared and the registry accepted. */
export interface PageEntry {
  readonly extension: string;
  /** The page name; the empty string is the index page at `/ext/<name>/`. */
  readonly page: string;
  readonly label: string;
  readonly menu: boolean;
  readonly script?: string;
  readonly style?: string;
}

/** One Pages menu entry: the text and the path under the mount. */
export interface PageMenuLink {
  readonly label: string;
  readonly path: string;
}

/** What `render` may return for one page, or null for a 404. */
export interface PageRenderResult {
  readonly title?: string;
  readonly html: string;
  readonly css?: string;
}

/** What `api` may return for one call. */
export interface PageApiResult {
  readonly status: number;
  readonly json?: unknown;
}

/** What went wrong for one extension: the pages that survived, and why the rest did not. */
export interface PageDiagnostic {
  readonly pages: readonly string[];
  readonly errors: readonly string[];
}

/** The logging surface the registry needs. */
export interface PageLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

/** Where the extension's module lives and the config value its factory received. */
export interface PageRegisterContext {
  readonly dir: string;
  readonly config: unknown;
}

/** What the server passes to `render`. */
export interface PageRenderInput {
  readonly query: Readonly<Record<string, string>>;
  readonly timezone: string;
}

/** What the server passes to `api`. */
export interface PageApiInput {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timezone: string;
}

interface RenderArgs {
  page: string;
  query: Readonly<Record<string, string>>;
  config: unknown;
  timezone: string;
}

interface ApiArgs {
  method: string;
  path: string;
  query: Readonly<Record<string, string>>;
  body: unknown;
  config: unknown;
  timezone: string;
}

type RenderFn = (args: RenderArgs) => unknown;
type ApiFn = (args: ApiArgs) => unknown;

/** One extension's accepted registration, held for as long as it stands. */
interface Registration {
  readonly extension: string;
  readonly uiDir: string;
  readonly config: unknown;
  readonly pages: readonly PageEntry[];
  readonly render: RenderFn | undefined;
  readonly api: ApiFn | undefined;
  readonly errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as a short phrase for a diagnostic line. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value;
}

/** The pages one extension's `pages.entries` array stands for, plus one line per dropped entry. */
async function readEntries(
  extension: string,
  uiDir: string,
  declared: readonly unknown[],
): Promise<{ pages: PageEntry[]; errors: string[] }> {
  const pages: PageEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index];
    const where = `entries[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: an entry must be an object`);
      continue;
    }
    const page = entry.page;
    if (typeof page !== "string" || (page !== "" && !PAGE_NAME.test(page))) {
      errors.push(`${where}: page ${describe(page)} is not a valid page name`);
      continue;
    }
    if (PAGE_RESERVED_NAMES.includes(page)) {
      errors.push(`${where}: page "${page}" is a reserved name`);
      continue;
    }
    if (seen.has(page)) {
      errors.push(`${where}: page ${describe(page)} is already declared in this extension`);
      continue;
    }
    const label = entry.label;
    if (typeof label !== "string" || label.trim() === "") {
      errors.push(`${where} (${describe(page)}): label must be a non-empty string`);
      continue;
    }
    if (entry.menu !== undefined && typeof entry.menu !== "boolean") {
      errors.push(`${where} (${describe(page)}): menu must be true or false`);
      continue;
    }
    let script: string | undefined;
    if (entry.script !== undefined) {
      const problem = await uiFileProblem(uiDir, "script", entry.script, /\.(?:js|mjs)$/, ".js or .mjs");
      if (problem !== undefined) {
        errors.push(`${where} (${describe(page)}): ${problem}`);
        continue;
      }
      script = entry.script as string;
    }
    let style: string | undefined;
    if (entry.style !== undefined) {
      const problem = await uiFileProblem(uiDir, "style", entry.style, /\.css$/, ".css");
      if (problem !== undefined) {
        errors.push(`${where} (${describe(page)}): ${problem}`);
        continue;
      }
      style = entry.style as string;
    }
    seen.add(page);
    pages.push(
      Object.freeze({
        extension,
        page,
        label: label.trim(),
        menu: entry.menu === true,
        ...(script === undefined ? {} : { script }),
        ...(style === undefined ? {} : { style }),
      }),
    );
  }
  return { pages, errors };
}

/**
 * The page registrations runtime extensions hold.
 *
 * `register` is called by the loader once per extension per load pass, after the
 * extension installed. A load that fails earlier never reaches it, so the
 * previous pages keep answering.
 */
export class PageRegistry {
  private readonly logger: PageLogger;
  private readonly entries = new Map<string, Registration>();

  constructor(options: { readonly logger: PageLogger }) {
    this.logger = options.logger;
  }

  /** Extensions that hold a registration. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** One page, or `undefined` when the extension does not declare it. */
  page(extension: string, page: string): PageEntry | undefined {
    return this.entries.get(extension)?.pages.find((entry) => entry.page === page);
  }

  /** `<dir>/ui` of an extension that holds at least one page, where its files are served from. */
  uiDir(extension: string): string | undefined {
    const entry = this.entries.get(extension);
    if (entry === undefined || entry.pages.length === 0) return undefined;
    return entry.uiDir;
  }

  /** Whether the extension holds an `api` function. */
  hasApi(extension: string): boolean {
    return this.entries.get(extension)?.api !== undefined;
  }

  /** The menu entries of every extension, sorted by extension name, then declared order. */
  links(): PageMenuLink[] {
    const out: PageMenuLink[] = [];
    for (const extension of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(extension);
      if (entry === undefined) continue;
      for (const page of entry.pages) {
        if (!page.menu) continue;
        out.push({ label: page.label, path: `/ext/${extension}/${page.page}` });
      }
    }
    return out;
  }

  /** What survived and what was dropped for one extension, or `undefined` when it holds nothing. */
  diagnostics(extension: string): PageDiagnostic | undefined {
    const entry = this.entries.get(extension);
    if (entry === undefined) return undefined;
    return {
      pages: entry.pages.map((page) => (page.page === "" ? INDEX_LABEL : page.page)),
      errors: [...entry.errors],
    };
  }

  /**
   * Register one extension's `pages` export, replacing what it registered last time.
   *
   * An `undefined` or `null` export removes the registration and is no error. A
   * value of the wrong shape keeps an empty registration with one error. A bad
   * entry is dropped alone with a diagnostic line. This method never throws.
   */
  async register(
    extension: string,
    exported: unknown,
    context: PageRegisterContext,
  ): Promise<{ pages: string[]; errors: string[] }> {
    if (this.entries.delete(extension)) this.logger.info?.("extension pages replaced", { name: extension });

    if (exported === undefined || exported === null) return { pages: [], errors: [] };

    const uiDir = join(context.dir, "ui");
    const empty = (message: string): { pages: string[]; errors: string[] } => {
      const errors = [message];
      this.entries.set(extension, {
        extension,
        uiDir,
        config: context.config,
        pages: [],
        render: undefined,
        api: undefined,
        errors,
      });
      this.logger.warn("extension pages export was not usable", { name: extension, error: message });
      return { pages: [], errors: [...errors] };
    };

    if (!PAGE_EXTENSION_NAME.test(extension)) {
      return empty(`extension name ${describe(extension)} cannot be a URL segment, so it has no pages`);
    }
    if (!isRecord(exported)) return empty("pages must be an object");
    if (typeof exported.render !== "function") return empty("pages has no render function");
    if (!Array.isArray(exported.entries)) return empty("pages.entries must be an array");

    const read = await readEntries(extension, uiDir, exported.entries as readonly unknown[]);
    const errors = read.errors;
    const api = exported.api;
    if (api !== undefined && typeof api !== "function") {
      errors.push("pages.api is not a function, so it is ignored");
    }
    if (errors.length > PAGE_DIAGNOSTIC_MAX_ERRORS) errors.splice(0, errors.length - PAGE_DIAGNOSTIC_MAX_ERRORS);

    this.entries.set(extension, {
      extension,
      uiDir,
      config: context.config,
      pages: read.pages,
      render: exported.render as RenderFn,
      api: typeof api === "function" ? (api as ApiFn) : undefined,
      errors,
    });
    for (const message of errors) this.logger.warn("extension page skipped", { name: extension, error: message });
    const pages = read.pages.map((page) => (page.page === "" ? INDEX_LABEL : page.page));
    if (pages.length > 0) this.logger.info?.("extension pages registered", { name: extension, pages });
    return { pages, errors: [...errors] };
  }

  /** Take back one extension's pages, e.g. after its directory is gone. */
  unregister(extension: string, reason: string): void {
    if (!this.entries.delete(extension)) return;
    this.logger.info?.("extension pages unregistered", { name: extension, reason });
  }

  /**
   * Render one page. `null` means the page answers 404 this time.
   *
   * The registration is read before the first await, so a call that started
   * before a reload finishes on the module it started on. The extension's
   * callback throws through: the server owns the timeout and the error page. A
   * result of the wrong shape is a bug in the extension and throws here.
   */
  async render(extension: string, page: string, input: PageRenderInput): Promise<PageRenderResult | null> {
    const entry = this.entries.get(extension);
    const found = entry?.pages.find((candidate) => candidate.page === page);
    if (entry === undefined || found === undefined) throw new Error(`extension "${extension}" has no page "${page}"`);
    if (entry.render === undefined) throw new Error(`extension "${extension}" has no pages render function`);
    const result = await entry.render({
      page,
      query: input.query,
      config: entry.config,
      timezone: input.timezone,
    });
    if (result === undefined || result === null) return null;
    const what = `pages.render of ${extension}/${page}`;
    if (!isRecord(result)) throw new Error(`${what} must return { title?, html, css? } or null`);
    if (typeof result.html !== "string") throw new Error(`${what} returned no html string`);
    if (result.title !== undefined && typeof result.title !== "string") {
      throw new Error(`${what} returned a title that is not a string`);
    }
    if (result.css !== undefined && typeof result.css !== "string") {
      throw new Error(`${what} returned a css value that is not a string`);
    }
    return Object.freeze({
      html: result.html,
      ...(result.title === undefined ? {} : { title: result.title }),
      ...(result.css === undefined ? {} : { css: result.css }),
    });
  }

  /**
   * Call one extension's `api`. The status defaults to 200, and `json` is passed
   * through as it is. A result that is not `{ status?, json? }` throws.
   */
  async api(extension: string, input: PageApiInput): Promise<PageApiResult> {
    const entry = this.entries.get(extension);
    if (entry === undefined || entry.api === undefined) throw new Error(`extension "${extension}" has no pages api function`);
    const result = await entry.api({
      method: input.method,
      path: input.path,
      query: input.query,
      body: input.body,
      config: entry.config,
      timezone: input.timezone,
    });
    const what = `pages.api of ${extension}`;
    if (result === undefined || result === null) return { status: 200 };
    if (!isRecord(result)) throw new Error(`${what} must return { status?, json? } or undefined`);
    let status = 200;
    if (result.status !== undefined) {
      if (typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
        throw new Error(`${what} returned a status that is not an integer from 200 to 599`);
      }
      status = result.status;
    }
    return Object.prototype.hasOwnProperty.call(result, "json")
      ? { status, json: result.json }
      : { status };
  }
}
