/**
 * Fill the page's UI slots with the cards runtime extensions offer.
 *
 * `src/web/index.html` leaves a marker where a slot goes:
 * `<div class="ui-slot" data-ui-slot="sidebar.bottom"></div>`. This module finds
 * every marker, renders the cards that name that slot, and replaces the marker
 * with the same `div` holding one host element per rendered card. Each host
 * carries its card as a declarative shadow root, so the browser shows the card
 * before any script runs.
 *
 * Two things are deliberate.
 *
 * The fill runs after `renderPage`, so card markup is never stamped by the
 * `{{base}}` and meta replacements: an extension's own text must not be treated
 * as a placeholder of ours.
 *
 * The style a card brings needs a nonce in the page's CSP, and a CSP that names
 * no nonce is byte-for-byte the one this server sent before cards existed. So the
 * nonce is made only when a card actually rendered, and a page with no card
 * carries the unchanged header.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { UI_SLOT_NAME, type UiCard, type UiRegistry } from "../registry/ui.ts";
import { checkCardMarkup } from "./ui-markup.ts";

/** How long one card's `render` may take before the slot shows a failure line. */
export const UI_RENDER_TIMEOUT_MS = 2000;

/** How long one `action` call may take before the API answers 504. */
export const UI_ACTION_TIMEOUT_MS = 10000;

/** The page's policy as it was before cards existed, and as it stays when none rendered. */
const CSP_BASE =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

/** A slot marker exactly as `index.html` writes it. */
const SLOT_MARKER = /<div class="ui-slot" data-ui-slot="([^"]*)"><\/div>/g;

/** The one logging surface this module needs. */
export interface UiPageLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** What one page asks of the policy beyond the shared default. */
export interface ContentSecurityPolicyOptions {
  /**
   * Whether the page may show an image from another site over `https:`.
   *
   * One page needs it: a pull request description may embed a picture on a host
   * of its own, and a policy of `img-src 'self' data:` would leave that picture
   * blank. Absent or false keeps the directive as it is, so every other page
   * carries a policy that has not changed at all.
   */
  readonly externalImages?: boolean;
}

/**
 * The page's Content-Security-Policy.
 *
 * Without a nonce this is the string the server has always sent. With one, only
 * the `style-src` directive changes: the card's style element carries the nonce,
 * and nothing else on the page gains a permission. `externalImages` widens
 * `img-src` to `https:` and touches no other directive.
 */
export function contentSecurityPolicy(nonce?: string, options: ContentSecurityPolicyOptions = {}): string {
  let policy = CSP_BASE;
  if (options.externalImages === true) {
    policy = policy.replace("img-src 'self' data:", "img-src 'self' data: https:");
  }
  if (nonce === undefined) return policy;
  return policy.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`);
}

/** The HTML-escaped form of a value, for an attribute or for text content. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Raised by `withTimeout` when the work did not answer in time. */
export class UiTimeoutError extends Error {
  readonly ms: number;
  readonly what: string;

  constructor(ms: number, what: string) {
    super(`${what} did not answer within ${ms} ms`);
    this.ms = ms;
    this.what = what;
    this.name = "UiTimeoutError";
  }
}

/**
 * The work's result, or a `UiTimeoutError` after `ms`.
 *
 * The work itself is not cancelled: an extension callback that never answers
 * keeps running. What the timeout buys is that one card cannot hold the page,
 * and one action cannot hold the request. The race attaches a handler to the
 * work, so a late rejection is handled rather than reported as unhandled.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new UiTimeoutError(ms, what)), ms);
    // A pending timer must not keep the process alive on its own.
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What one card came to on this page load. */
type CardOutcome =
  | { readonly kind: "rendered"; readonly card: UiCard; readonly html: string; readonly css: string; readonly mtime: number | undefined }
  | { readonly kind: "hidden"; readonly card: UiCard }
  | { readonly kind: "failed"; readonly card: UiCard }
  | { readonly kind: "invalid"; readonly card: UiCard };

/** The stub `fillUiSlots` reads, so a test can pass a registry or a stand-in. */
export type UiSlotSource = Pick<UiRegistry, "cards" | "render" | "uiDir">;

export interface UiSlotFillOptions {
  readonly ui: UiSlotSource;
  /** The mount prefix every URL this page emits starts with; empty at the root. */
  readonly prefix: string;
  /** pi-sec's timezone, which a card's `render` receives. */
  readonly timezone: string;
  readonly renderTimeoutMs: number;
  readonly logger: UiPageLogger;
}

export interface UiSlotFillResult {
  readonly html: string;
  /** Set only when at least one card rendered, and then the page's CSP names it. */
  readonly nonce?: string;
}

/** The file's modification time in whole milliseconds, or `undefined` when it is not a file. */
async function scriptMtime(uiDir: string | undefined, script: string): Promise<number | undefined> {
  if (uiDir === undefined) return undefined;
  try {
    const info = await stat(join(uiDir, script));
    if (!info.isFile()) return undefined;
    return Math.floor(info.mtimeMs);
  } catch {
    return undefined;
  }
}

/** Render one card, and say what the slot should show for it. */
async function renderCard(card: UiCard, slot: string, options: UiSlotFillOptions): Promise<CardOutcome> {
  // A script's mtime is a cache-busting value, and a script that is gone cannot be
  // promised to the browser: both are settled before the card is asked to render.
  const uiDir = options.ui.uiDir(card.extension);
  let mtime: number | undefined;
  if (card.script !== undefined) {
    mtime = await scriptMtime(uiDir, card.script);
    if (mtime === undefined) {
      options.logger.warn("ui card failed", {
        extension: card.extension,
        card: card.name,
        reason: `script "${card.script}" is not a file in ui/`,
      });
      return { kind: "failed", card };
    }
  }

  let result;
  try {
    result = await withTimeout(
      options.ui.render(card.extension, card.name, { slot, timezone: options.timezone }),
      options.renderTimeoutMs,
      `ui.render of ${card.extension}/${card.name}`,
    );
  } catch (error) {
    options.logger.warn("ui card failed", {
      extension: card.extension,
      card: card.name,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed", card };
  }

  if (result === null) return { kind: "hidden", card };

  const checked = checkCardMarkup(result.html, result.css);
  if (!checked.ok) {
    options.logger.warn("ui card failed", {
      extension: card.extension,
      card: card.name,
      reason: `invalid markup: ${checked.reason}`,
    });
    return { kind: "invalid", card };
  }
  return { kind: "rendered", card, html: checked.html, css: checked.css, mtime };
}

/** One path segment of an emitted URL, encoded so it stays one segment. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** `<prefix>/ext/<extension>/ui/<script>?v=<mtime>`, the script URL of one card. */
function scriptUrl(prefix: string, card: UiCard, mtime: number | undefined): string {
  const extension = card.extension.split("/").map(encodeSegment).join("/");
  const script = (card.script ?? "").split("/").map(encodeSegment).join("/");
  return `${prefix}/ext/${extension}/ui/${script}?v=${mtime ?? 0}`;
}

/**
 * One card's markup inside its slot.
 *
 * The shape is the one `ui-cards.js` reads: a host with the card's identity, a
 * declarative shadow root, the card's style (when it brought one), the body the
 * script replaces on an action, and the script itself. A card that failed takes
 * the failure line and nothing else, so the page shows one plain sentence where
 * the card would have been.
 */
function cardMarkup(outcome: CardOutcome, nonce: string | undefined, prefix: string): string {
  const card = outcome.card;
  const identity =
    `data-ui-extension="${escapeHtml(card.extension)}" data-ui-card="${escapeHtml(card.name)}"`;

  if (outcome.kind === "hidden") return "";

  if (outcome.kind === "failed" || outcome.kind === "invalid") {
    const label = outcome.kind === "failed" ? "failed to load" : "invalid markup";
    return `<div class="ui-card ui-card-failed" ${identity}>${escapeHtml(`${card.extension}/${card.name}: ${label}`)}</div>`;
  }

  const style =
    outcome.css === ""
      ? ""
      : `<style nonce="${escapeHtml(nonce ?? "")}">${outcome.css}</style>`;
  const script =
    card.script === undefined
      ? ""
      : `<script type="module" src="${escapeHtml(scriptUrl(prefix, card, outcome.mtime))}"></script>`;
  return (
    `<div class="ui-card" ${identity}>` +
    `<template shadowrootmode="open">${style}` +
    `<div class="ui-card-body" data-ui-body>${outcome.html}</div>` +
    `${script}</template></div>`
  );
}

/** One slot's cards, in the registry's order. */
async function fillSlot(slot: string, options: UiSlotFillOptions): Promise<CardOutcome[]> {
  const cards = options.ui.cards(slot);
  // Every card of a slot renders at the same time: a slot of five cards costs one
  // timeout at worst, not five.
  return await Promise.all(cards.map(async (card) => renderCard(card, slot, options)));
}

/**
 * Replace every slot marker in the page with the cards of that slot.
 *
 * The markers are found first and the replacements are spliced into the page
 * afterwards, so no card's text is ever parsed as a slot marker of ours.
 */
export async function fillUiSlots(html: string, options: UiSlotFillOptions): Promise<UiSlotFillResult> {
  const markers: { name: string; start: number; end: number }[] = [];
  for (const match of html.matchAll(SLOT_MARKER)) {
    const name = match[1] ?? "";
    if (!UI_SLOT_NAME.test(name)) continue;
    const start = match.index ?? 0;
    markers.push({ name, start, end: start + match[0].length });
  }
  if (markers.length === 0) return { html };

  const slots = new Map<string, CardOutcome[]>();
  await Promise.all(
    [...new Set(markers.map((marker) => marker.name))].map(async (name) => {
      slots.set(name, await fillSlot(name, options));
    }),
  );

  const anyRendered = [...slots.values()].some((outcomes) =>
    outcomes.some((outcome) => outcome.kind === "rendered"),
  );
  const nonce = anyRendered ? randomBytes(16).toString("base64") : undefined;

  let out = "";
  let cursor = 0;
  for (const marker of markers) {
    out += html.slice(cursor, marker.start);
    const outcomes = slots.get(marker.name) ?? [];
    const inner = outcomes.map((outcome) => cardMarkup(outcome, nonce, options.prefix)).join("");
    out += `<div class="ui-slot" data-ui-slot="${escapeHtml(marker.name)}">${inner}</div>`;
    cursor = marker.end;
  }
  out += html.slice(cursor);
  return nonce === undefined ? { html: out } : { html: out, nonce };
}
