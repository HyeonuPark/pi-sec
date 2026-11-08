/**
 * The extension card script's assertions that the old page's tests made and the
 * new page's tests did not.
 *
 * `src/web/ui-cards.js` is not part of the rewrite: the daemon keeps serving it as
 * it is, and a new shell keeps loading it beside the bundle, so a card an extension
 * draws in `.ui-slot` is attached, mounted and answered by this same file. That is
 * why these two tests load the script itself, in the page shell it is served with,
 * rather than the bundle: the behaviour under test lives in the file that does not
 * change.
 *
 * What the old tests held, and what is held here: a card mounts once whichever
 * order `define` and the card's arrival take, and a button press reaches the
 * extension with the button's `value` attribute, or with null when it has none.
 *
 * The shell is loaded with its own scripts left to this file (`runScripts:
 * "outside-only"`), the way the harness does it: jsdom parses no declarative
 * shadow root and runs no script tag, so the fallback attach is the one exercised.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { root, settle } from "./harness.ts";

/** The one slot the server draws extension cards into on these pages. */
const SLOT = '.ui-slot[data-ui-slot="sidebar.bottom"]';

/** One card exactly as the server puts it into the slot. */
function cardMarkup(options: { extension: string; card: string; body: string }): string {
  return (
    `<div class="ui-card" data-ui-extension="${options.extension}" data-ui-card="${options.card}">` +
    `<template shadowrootmode="open"><div class="ui-card-body" data-ui-body>${options.body}</div></template>` +
    `</div>`
  );
}

/** What the card script hands a card's own mount. */
interface CardApi {
  call(action: string, value?: unknown): Promise<unknown>;
  on(event: string, handler: (value: unknown) => void): () => void;
}

type CardMount = (root: ShadowRoot, api: CardApi) => void;

/** `window.piSecUi`, the one global the card script installs. */
interface CardUi {
  define(id: string, mount: CardMount): void;
  dispatch(payload: { extension: string; card: string; event: string; value?: unknown }): void;
}

/** One loaded shell, with the card script in it and a fake call route behind it. */
interface CardsPage {
  readonly window: JSDOM["window"];
  /** The slot the test puts cards into. */
  readonly slot: HTMLElement;
  /** `window.piSecUi`. */
  readonly cards: CardUi;
  /** Every body `POST /api/ui/call` carried, in order. */
  readonly bodies: unknown[];
  /** The card hosts in the slot, in the order they were drawn. */
  hosts(): HTMLElement[];
  close(): void;
}

/** A response object of the shape the card script reads. */
function okAnswer(): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => "{}" };
}

/** Load the chat shell with the card script in it, and a card already in the slot. */
async function loadCards(options: { slotMarkup?: string } = {}): Promise<CardsPage> {
  const html = (await readFile(join(root, "src/web/index.html"), "utf8")).replaceAll("{{base}}", "");
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!String((error as { message?: unknown })?.message ?? error).includes("navigation")) console.error(error);
  });
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;

  const bodies: unknown[] = [];
  (window as unknown as { fetch: unknown }).fetch = async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    return okAnswer();
  };

  const slot = window.document.querySelector<HTMLElement>(SLOT);
  if (slot === null) throw new Error(`the shell has no element matching ${SLOT}`);
  if (options.slotMarkup !== undefined) slot.innerHTML = options.slotMarkup;

  // Both scripts a page loads before its bundle, in the shell's own order.
  window.eval(await readFile(join(root, "src/web/base.js"), "utf8"));
  window.eval(await readFile(join(root, "src/web/ui-cards.js"), "utf8"));
  await settle();

  const cards = (window as unknown as { piSecUi: CardUi }).piSecUi;
  return {
    window,
    slot,
    cards,
    bodies,
    hosts: () => [...window.document.querySelectorAll<HTMLElement>(`${SLOT} .ui-card`)],
    close: () => window.close(),
  };
}

describe("the extension card script's mount", () => {
  it("mounts a card once whether define runs before or after the card is attached", async () => {
    // Defined first, attached later: a card that arrives after its script.
    const page = await loadCards();
    try {
      const roots: ShadowRoot[] = [];
      const apis: CardApi[] = [];
      page.cards.define("demo-cards/toggle", (root, api) => {
        roots.push(root);
        apis.push(api);
      });
      expect(roots).toHaveLength(0);

      page.slot.innerHTML = cardMarkup({ extension: "demo-cards", card: "toggle", body: "<b>1</b>" });
      page.window.document.dispatchEvent(new page.window.Event("DOMContentLoaded"));
      expect(roots).toHaveLength(1);
      // A second pass over the page finds nothing new to do.
      page.window.document.dispatchEvent(new page.window.Event("DOMContentLoaded"));
      expect(roots).toHaveLength(1);

      const host = page.hosts()[0]!;
      expect(roots[0]).toBe(host.shadowRoot);
      expect(typeof apis[0]!.call).toBe("function");
      expect(typeof apis[0]!.on).toBe("function");
    } finally {
      page.close();
    }

    // Attached first, defined later: the card the server drew.
    const late = await loadCards({
      slotMarkup: cardMarkup({ extension: "demo-cards", card: "toggle", body: "<b>2</b>" }),
    });
    try {
      let runs = 0;
      late.cards.define("demo-cards/toggle", () => {
        runs += 1;
      });
      expect(runs).toBe(1);
      // A second define of the same id does not run the card's script again.
      late.cards.define("demo-cards/toggle", () => {
        runs += 10;
      });
      expect(runs).toBe(1);
    } finally {
      late.close();
    }
  });
});

describe("the extension card script's press", () => {
  it("sends a press from a button as its value attribute, or null when it has none", async () => {
    const page = await loadCards({
      slotMarkup: cardMarkup({
        extension: "demo-cards",
        card: "panel",
        body:
          '<button type="button" data-action="pick" value="left">left</button>' +
          '<button type="button" data-action="clear">clear</button>',
      }),
    });
    try {
      const host = page.hosts()[0]!;
      const shadow = host.shadowRoot;
      expect(shadow).not.toBeNull();
      (shadow!.querySelector('[data-action="pick"]') as HTMLElement).dispatchEvent(
        new page.window.MouseEvent("click", { bubbles: true }),
      );
      (shadow!.querySelector('[data-action="clear"]') as HTMLElement).dispatchEvent(
        new page.window.MouseEvent("click", { bubbles: true }),
      );
      await settle();
      await settle();

      expect(page.bodies).toEqual([
        { extension: "demo-cards", card: "panel", action: "pick", value: "left" },
        { extension: "demo-cards", card: "panel", action: "clear", value: null },
      ]);
    } finally {
      page.close();
    }
  });
});
