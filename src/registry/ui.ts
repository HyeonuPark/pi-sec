/**
 * Cards a runtime extension offers to the page.
 *
 * A runtime extension is an ordinary ES module under `~/.pi/sec/extensions/`.
 * Alongside `create`/`configSchema`/`toolTags`/`providers` it may export `ui`:
 * the cards it puts in a named slot of the page, the render and action callbacks
 * the server calls, and a `start` hook that keeps a `publish` function for
 * events the browser should hear about.
 *
 * This module owns what happens to that export:
 *
 * - which extension holds which card, so a reload can take back exactly what the
 *   previous module instance registered,
 * - the rules a slot name, a card name and a card script must follow, with one
 *   diagnostic line per dropped entry,
 * - the `publish` function an extension's `start` receives: it closes on reload
 *   and unregister, and it refuses a value the browser could not read,
 * - when `start` is called: once, and never awaited, so a hook that keeps a
 *   polling loop cannot hold the load pass that called it.
 *
 * The registry never touches the page. It calls the extension and hands the
 * result to the server, which owns markup checking, timeouts and injection.
 */
import { Buffer } from "node:buffer";
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { EventsSink } from "../extensions/context.ts";

/** A slot name: lowercase words joined by dots, for example `sidebar.bottom`. */
export const UI_SLOT_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

/** A card name: what the page puts in `data-ui-card`, unique within one extension. */
export const UI_CARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** An event name an extension may publish. */
export const UI_EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** The largest JSON value an extension may publish, in UTF-8 bytes. */
export const UI_EVENT_MAX_BYTES = 16 * 1024;

/** How many diagnostic lines one extension keeps; the newest win. */
const UI_DIAGNOSTIC_MAX_ERRORS = 20;

/** One card an extension declared and the registry accepted. */
export interface UiCard {
  readonly extension: string;
  readonly name: string;
  readonly slot: string;
  readonly script?: string;
}

/** What `render` may return for one card, or null for nothing. */
export interface UiRenderResult {
  readonly html: string;
  readonly css?: string;
}

/** What `action` may return for one call. Both fields are optional. */
export interface UiActionResult {
  readonly html?: string;
  readonly value?: unknown;
}

/** What went wrong for one extension: the cards that survived, and why the rest did not. */
export interface UiDiagnostic {
  readonly cards: readonly string[];
  readonly errors: readonly string[];
}

/** The logging surface the registry needs. `info` is optional, like the loader's logger. */
export interface UiLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

/** Where the extension's module lives and the config value its factory received. */
export interface UiRegisterContext {
  readonly dir: string;
  readonly config: unknown;
}

/** What the server passes to `render`: the slot being filled, and pi-sec's timezone. */
export interface UiRenderInput {
  readonly slot: string;
  readonly timezone: string;
}

/** What the server passes to `action`. */
export interface UiActionInput {
  readonly timezone: string;
}

/** An extension's publish function: `publish(cardName, eventName, value)`. */
export type UiPublish = (card: string, event: string, value?: unknown) => void;

/** The argument object `render` receives. `card` is the card name. */
interface RenderArgs {
  slot: string;
  card: string;
  config: unknown;
  timezone: string;
}

/** The argument object `action` receives. */
interface ActionArgs {
  card: string;
  action: string;
  value: unknown;
  config: unknown;
  timezone: string;
}

/** The argument object `start` receives. */
interface StartArgs {
  publish: UiPublish;
  config: unknown;
}

type RenderFn = (args: RenderArgs) => unknown;
type ActionFn = (args: ActionArgs) => unknown;
type StartFn = (args: StartArgs) => unknown;

/** One extension's accepted registration, held for as long as it stands. */
interface Registration {
  readonly extension: string;
  readonly dir: string;
  readonly uiDir: string;
  readonly config: unknown;
  readonly cards: readonly UiCard[];
  readonly cardNames: ReadonlySet<string>;
  readonly render: RenderFn | undefined;
  readonly action: ActionFn | undefined;
  /** The live diagnostic lines, mutated in place so `publish` can add to them. */
  readonly errors: string[];
  /** Closed when this registration is replaced or taken back. */
  readonly closed: { value: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A value as a short phrase for a diagnostic line. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value;
}

/** Whether a returned value is a promise, or anything else with a `then` function. */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The problem with one card script, or `undefined` when it is usable.
 *
 * The rules are the ones the server repeats when it serves the file: a relative
 * path of plain segments under `ui/`, ending in `.js` or `.mjs`, that resolves to
 * a regular file inside the real `ui/` directory. A symlink that leaves `ui/` is
 * refused here, so a static server that re-checks realpath has nothing new to
 * learn.
 */
async function scriptProblem(uiDir: string, script: unknown): Promise<string | undefined> {
  if (typeof script !== "string") return "script must be a string";
  for (const segment of script.split("/")) {
    if (segment === "." || segment === "..") return `script "${script}" has a "." or ".." segment`;
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) return `script "${script}" is not a plain path under ui/`;
  }
  if (!/\.(?:js|mjs)$/.test(script)) return `script "${script}" must end in .js or .mjs`;

  const path = join(uiDir, script);
  let info;
  try {
    info = await stat(path);
  } catch {
    return `script "${script}" is not a file in ui/`;
  }
  if (!info.isFile()) return `script "${script}" is not a regular file`;

  let base: string;
  try {
    base = await realpath(uiDir);
  } catch {
    return `script "${script}" cannot be resolved: ui/ is not a directory`;
  }
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    return `script "${script}" cannot be resolved`;
  }
  if (target !== base && !target.startsWith(base + sep)) return `script "${script}" resolves outside ui/`;
  return undefined;
}

/** The cards one extension's `ui.cards` array stands for, plus one line per dropped entry. */
async function readCards(
  extension: string,
  uiDir: string,
  declared: readonly unknown[],
): Promise<{ cards: UiCard[]; errors: string[] }> {
  const cards: UiCard[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index];
    const where = `cards[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: a card must be an object`);
      continue;
    }
    const slot = entry.slot;
    if (typeof slot !== "string" || !UI_SLOT_NAME.test(slot)) {
      errors.push(`${where}: slot ${describe(slot)} is not a valid slot name`);
      continue;
    }
    const name = entry.name;
    if (typeof name !== "string" || !UI_CARD_NAME.test(name)) {
      errors.push(`${where}: name ${describe(name)} is not a valid card name`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${where}: card name "${name}" is already declared in this extension`);
      continue;
    }
    let script: string | undefined;
    if (entry.script !== undefined) {
      const problem = await scriptProblem(uiDir, entry.script);
      if (problem !== undefined) {
        errors.push(`${where} ("${name}"): ${problem}`);
        continue;
      }
      script = entry.script as string;
    }
    seen.add(name);
    cards.push(Object.freeze(script === undefined ? { extension, name, slot } : { extension, name, slot, script }));
  }
  return { cards, errors };
}

/**
 * The JSON value to emit for one `publish` call, or the reason there is none.
 *
 * `undefined` becomes `null` so the browser always receives a value key. A
 * top-level function, symbol or bigint has no JSON form; a nested one makes
 * `JSON.stringify` throw, and both are refused here rather than sent as
 * something the extension did not mean.
 */
function serializeValue(value: unknown): { readonly json: string } | { readonly error: string } {
  if (value === undefined) return { json: "null" };
  const kind = typeof value;
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    return { error: `value is a ${kind} and has no JSON form` };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    return { error: `value has no JSON form: ${messageOf(error)}` };
  }
  if (typeof json !== "string") return { error: `value is a ${kind} and has no JSON form` };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > UI_EVENT_MAX_BYTES) {
    return { error: `value is ${bytes} bytes, over the ${UI_EVENT_MAX_BYTES} byte limit` };
  }
  return { json };
}

/**
 * The card registrations runtime extensions hold.
 *
 * `register` is called by the loader once per extension per load pass. It is
 * transactional in the same way `ProviderRegistry.register` is: an extension's
 * previous cards and `publish` are taken back only when the new registration
 * replaces them, so a load that fails before reaching this point changes
 * nothing.
 */
export class UiRegistry {
  private readonly events: EventsSink;
  private readonly logger: UiLogger;
  private readonly entries = new Map<string, Registration>();

  constructor(options: { readonly events: EventsSink; readonly logger: UiLogger }) {
    this.events = options.events;
    this.logger = options.logger;
  }

  /** Extensions that hold a registration. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** Every registered card, sorted by extension name, then declared order. */
  cards(slot?: string): UiCard[] {
    const out: UiCard[] = [];
    for (const extension of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(extension);
      if (entry === undefined) continue;
      for (const card of entry.cards) {
        if (slot === undefined || card.slot === slot) out.push(card);
      }
    }
    return out;
  }

  /** One card, or `undefined` when the extension does not declare it. */
  card(extension: string, name: string): UiCard | undefined {
    return this.entries.get(extension)?.cards.find((card) => card.name === name);
  }

  /** `<dir>/ui` of a registered extension, the directory its scripts are served from. */
  uiDir(extension: string): string | undefined {
    return this.entries.get(extension)?.uiDir;
  }

  /** Whether the extension exports an `action` callback. */
  hasAction(extension: string): boolean {
    return this.entries.get(extension)?.action !== undefined;
  }

  /** What survived and what was dropped for one extension, or `undefined` when it holds nothing. */
  diagnostics(extension: string): UiDiagnostic | undefined {
    const entry = this.entries.get(extension);
    if (entry === undefined) return undefined;
    return { cards: entry.cards.map((card) => card.name), errors: [...entry.errors] };
  }

  /**
   * Register one extension's `ui` export, replacing what it registered last time.
   *
   * The previous `publish` closes first, then the new cards are stored, then
   * `start` is called once. A broken entry is dropped alone with a diagnostic line;
   * a `ui` that is not an object, has no `render` function or has `cards` that is
   * not an array keeps no cards and reports one error. A `start` that throws
   * keeps the cards.
   *
   * `start` is called without `await`: an extension may start a loop that never
   * settles, and this method must return even then. A synchronous throw is
   * reported before the return. A returned promise is watched instead, and its
   * rejection adds the same diagnostic line to the registration afterwards.
   *
   * This method never throws. Everything it could not accept comes back in
   * `errors`, which the loader joins into its own load result.
   */
  async register(
    extension: string,
    exported: unknown,
    context: UiRegisterContext,
  ): Promise<{ cards: string[]; errors: string[] }> {
    const previous = this.entries.get(extension);
    if (previous !== undefined) {
      this.close(previous, "replaced");
      this.entries.delete(extension);
    }

    // No `ui` export is not a mistake: most extensions have none, and the ones
    // that keep a `providers` export only may still export nothing else.
    if (exported === undefined || exported === null) return { cards: [], errors: [] };

    const dir = context.dir;
    const uiDir = join(dir, "ui");

    let uiExport: Record<string, unknown> | undefined;
    let shapeProblem: string | undefined;
    if (!isRecord(exported)) {
      shapeProblem = "ui must be an object";
    } else if (typeof exported.render !== "function") {
      shapeProblem = "ui has no render function";
    } else if (!Array.isArray(exported.cards)) {
      shapeProblem = "ui.cards must be an array";
    } else {
      uiExport = exported;
    }
    if (uiExport === undefined) {
      const message = shapeProblem ?? "ui must be an object";
      const errors: string[] = [message];
      this.entries.set(extension, {
        extension,
        dir,
        uiDir,
        config: context.config,
        cards: [],
        cardNames: new Set<string>(),
        render: undefined,
        action: undefined,
        errors,
        closed: { value: false },
      });
      this.logger.warn("extension ui export was not usable", { name: extension, error: message });
      return { cards: [], errors };
    }

    const read = await readCards(extension, uiDir, uiExport.cards as readonly unknown[]);
    const errors = read.errors;
    if (errors.length > UI_DIAGNOSTIC_MAX_ERRORS) errors.splice(0, errors.length - UI_DIAGNOSTIC_MAX_ERRORS);
    const render = uiExport.render as RenderFn;
    const action = uiExport.action;
    const start = uiExport.start;
    if (action !== undefined && typeof action !== "function") {
      this.addError(errors, "ui.action is not a function, so it is ignored");
    }
    if (start !== undefined && typeof start !== "function") {
      this.addError(errors, "ui.start is not a function, so it is ignored");
    }

    const closed = { value: false };
    const cardNames = new Set(read.cards.map((card) => card.name));
    const publish: UiPublish = (card, event, value) => {
      if (closed.value) return;
      this.publishEvent(extension, cardNames, errors, card, event, value);
    };
    this.entries.set(extension, {
      extension,
      dir,
      uiDir,
      config: context.config,
      cards: read.cards,
      cardNames,
      render,
      action: typeof action === "function" ? (action as ActionFn) : undefined,
      errors,
      closed,
    });

    if (typeof start === "function") {
      const failStart = (error: unknown): void => {
        const message = messageOf(error);
        this.addError(errors, `ui.start threw: ${message}`);
        this.logger.warn("extension ui start failed", { name: extension, error: message });
      };
      try {
        const returned: unknown = (start as StartFn)({ publish, config: context.config });
        // A thenable is watched, never awaited: the load pass returns now, and a
        // rejection still reaches the diagnostics and the log.
        if (isThenable(returned)) void Promise.resolve(returned).catch(failStart);
      } catch (error) {
        failStart(error);
      }
    }

    for (const message of errors) this.logger.warn("extension ui card skipped", { name: extension, error: message });
    const cards = read.cards.map((card) => card.name);
    if (cards.length > 0) this.logger.info?.("extension ui cards registered", { name: extension, cards });
    return { cards, errors };
  }

  /** Take back one extension's cards and close its `publish`, e.g. after its directory is gone. */
  unregister(extension: string, reason: string): void {
    const entry = this.entries.get(extension);
    if (entry === undefined) return;
    this.close(entry, reason);
    this.entries.delete(extension);
  }

  /**
   * Render one card. `null` means the card renders nothing this time.
   *
   * The extension's callback throws through: the server owns the timeout, the
   * logging and the failure line the page shows. A result that is not
   * `{ html: string, css?: string }` is a bug in the extension and throws here.
   */
  async render(extension: string, card: string, input: UiRenderInput): Promise<UiRenderResult | null> {
    const entry = this.lookup(extension, card);
    const found = this.mustFind(entry, card);
    if (entry.render === undefined) throw new Error(`extension "${extension}" has no ui render function`);
    const result = await entry.render({
      slot: input.slot,
      card: found.name,
      config: entry.config,
      timezone: input.timezone,
    });
    if (result === undefined || result === null) return null;
    if (!isRecord(result)) {
      throw new Error(`ui.render of ${extension}/${card} must return { html, css? } or null`);
    }
    if (typeof result.html !== "string") {
      throw new Error(`ui.render of ${extension}/${card} returned no html string`);
    }
    if (result.css !== undefined && typeof result.css !== "string") {
      throw new Error(`ui.render of ${extension}/${card} returned a css value that is not a string`);
    }
    return Object.freeze(result.css === undefined ? { html: result.html } : { html: result.html, css: result.css });
  }

  /**
   * Call one card's `action`. `undefined` means the extension returned nothing,
   * and no `value` or `html` key reaches the browser.
   */
  async action(
    extension: string,
    card: string,
    action: string,
    value: unknown,
    input: UiActionInput,
  ): Promise<UiActionResult | undefined> {
    const entry = this.lookup(extension, card);
    const found = this.mustFind(entry, card);
    if (entry.action === undefined) throw new Error(`extension "${extension}" has no ui action function`);
    const result = await entry.action({
      card: found.name,
      action,
      value,
      config: entry.config,
      timezone: input.timezone,
    });
    if (result === undefined || result === null) return undefined;
    if (!isRecord(result)) {
      throw new Error(`ui.action of ${extension}/${card} must return { html?, value? }, null or undefined`);
    }
    const out: { html?: string; value?: unknown } = {};
    if (hasOwn(result, "html")) {
      if (typeof result.html !== "string") {
        throw new Error(`ui.action of ${extension}/${card} returned an html value that is not a string`);
      }
      out.html = result.html;
    }
    if (hasOwn(result, "value")) out.value = result.value;
    return out;
  }

  private lookup(extension: string, card: string): Registration {
    const entry = this.entries.get(extension);
    if (entry === undefined) throw new Error(`extension "${extension}" has no ui registration`);
    if (entry.cards.every((candidate) => candidate.name !== card)) {
      throw new Error(`extension "${extension}" has no card "${card}"`);
    }
    return entry;
  }

  private mustFind(entry: Registration, card: string): UiCard {
    const found = entry.cards.find((candidate) => candidate.name === card);
    if (found === undefined) throw new Error(`extension "${entry.extension}" has no card "${card}"`);
    return found;
  }

  /** One `publish` call: silently dropped when closed, otherwise checked, serialized, emitted. */
  private publishEvent(
    extension: string,
    cardNames: ReadonlySet<string>,
    errors: string[],
    card: unknown,
    event: unknown,
    value: unknown,
  ): void {
    const drop = (reason: string): void => {
      this.addError(errors, `publish dropped: ${reason}`);
      this.logger.warn("extension ui event dropped", { name: extension, card, event, reason });
    };
    if (typeof card !== "string" || !cardNames.has(card)) {
      drop(typeof card === "string" ? `"${card}" is not a card of this extension` : "the card name is not a string");
      return;
    }
    if (typeof event !== "string" || !UI_EVENT_NAME.test(event)) {
      drop(`event name ${describe(event)} does not match the event name rule`);
      return;
    }
    const serialized = serializeValue(value);
    if ("error" in serialized) {
      drop(serialized.error);
      return;
    }
    // `extension` comes from the core. An extension that publishes under another
    // name would make the browser dispatch to a card it does not own.
    this.events.emit("ui_event", { extension, card, event, value: JSON.parse(serialized.json) as unknown });
  }

  private close(entry: Registration, reason: string): void {
    entry.closed.value = true;
    this.logger.info?.("extension ui unregistered", { name: entry.extension, reason });
  }

  private addError(errors: string[], message: string): void {
    errors.push(message);
    if (errors.length > UI_DIAGNOSTIC_MAX_ERRORS) errors.splice(0, errors.length - UI_DIAGNOSTIC_MAX_ERRORS);
  }
}
