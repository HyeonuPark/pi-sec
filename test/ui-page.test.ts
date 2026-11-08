/**
 * Server-side page injection of extension cards.
 *
 * The page the server sends already holds each card: a host element inside the
 * slot, a declarative shadow root, the card's style under a nonce, its markup,
 * and its script. The assertions parse the page with parse5 rather than looking
 * for substrings, because the property that matters is the shape of the tree:
 * the card stays inside its slot and the page around it is untouched.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "parse5";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/** The policy the page carried before cards existed. */
const CSP_BASE = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

interface PNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: { readonly name: string; readonly value: string }[];
  readonly childNodes?: PNode[];
  /** `<template>` holds its children here, not in `childNodes`. */
  readonly content?: PNode;
}

function walk(node: PNode, visit: (node: PNode) => void): void {
  for (const child of node.childNodes ?? []) {
    visit(child);
    walk(child, visit);
    if (child.content !== undefined) walk(child.content, visit);
  }
}

/** The element children of one node, one level down. */
function children(node: PNode): PNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
}

/** Every element below one node, in document order; a template's content counts. */
function elements(node: PNode): PNode[] {
  const out: PNode[] = [];
  walk(node, (child) => {
    if (child.tagName !== undefined) out.push(child);
  });
  return out;
}

function attr(node: PNode, name: string): string | undefined {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function classes(node: PNode): string[] {
  return (attr(node, "class") ?? "").split(/\s+/).filter((name) => name !== "");
}

function text(node: PNode): string {
  let out = node.value ?? "";
  for (const child of node.childNodes ?? []) out += text(child);
  return out;
}

/** The element with this id, somewhere in the page. */
function byId(document: PNode, id: string): PNode | undefined {
  return elements(document).find((node) => attr(node, "id") === id);
}

/** The slot marker of the page, which is the div the cards go into. */
function slot(document: PNode, name = "sidebar.bottom"): PNode | undefined {
  return elements(document).find((node) => attr(node, "data-ui-slot") === name);
}

/** The host element of one card inside a slot. */
function host(document: PNode, card: string): PNode | undefined {
  return elements(document).find((node) => attr(node, "data-ui-card") === card);
}

/** The nonce attribute of the card's style element. */
function styleNonce(document: PNode): string | undefined {
  const style = elements(document).find((node) => node.tagName === "style");
  return style === undefined ? undefined : attr(style, "nonce");
}

/** The card's script URL, from the page tree. */
function scriptSrc(document: PNode): string | undefined {
  const script = elements(document).find((node) => node.tagName === "script" && attr(node, "src") !== undefined);
  return script === undefined ? undefined : attr(script, "src");
}

let harness: TestHarness | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

interface BootOptions {
  readonly config?: Partial<Config>;
  readonly ui?: ServerOptions["ui"];
  readonly extension?: { readonly name: string; readonly body: string; readonly files?: Record<string, string> };
}

/** A harness, optionally with one fixture extension, and a server on port 0. */
async function boot(options: BootOptions = {}): Promise<string> {
  harness = await createTestHarness({
    config: {
      ...(options.config ?? {}),
      server: { ...defaultConfig().server, ...(options.config?.server ?? {}), port: 0 },
    },
  });
  if (options.extension !== undefined) {
    const dir = join(harness.paths.extensionsDir, options.extension.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.js"), options.extension.body);
    for (const [path, body] of Object.entries(options.extension.files ?? {})) {
      const target = join(dir, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, body);
    }
    const loaded = await harness.runtime.loader.loadAll();
    expect(loaded.errors).toEqual([]);
  }
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: harness.runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: defaultWebDir(), ui: options.ui ?? { renderTimeoutMs: 50 } });
  return started.origin;
}

/** The card as the page declares it: one slot, one script, one render result. */
const DEMO_CARDS = `
export const name = "demo-cards";
export function create() {
  return { name: "demo-cards" };
}
export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "toggle", script: "card.js" }],
  render() {
    return { html: '<label class="toggle"><input type="checkbox" /> demo</label>', css: "label{color:red}" };
  },
};
`;

describe("card injection", () => {
  it("puts the card in the slot as a declarative shadow root, with its style, markup and script", async () => {
    const origin = await boot({
      extension: { name: "demo-cards", body: DEMO_CARDS, files: { "ui/card.js": "export const on = true;\n" } },
    });
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    const document = parse(page) as unknown as PNode;

    const marker = slot(document);
    expect(marker).toBeDefined();
    expect(classes(marker!)).toContain("ui-slot");

    // The slot holds exactly one host, and the host holds exactly one template.
    expect(children(marker!).map((node) => node.tagName)).toEqual(["div"]);
    const cardHost = children(marker!)[0]!;
    expect(classes(cardHost)).toEqual(["ui-card"]);
    expect(attr(cardHost, "data-ui-extension")).toBe("demo-cards");
    expect(attr(cardHost, "data-ui-card")).toBe("toggle");

    expect(children(cardHost).map((node) => node.tagName)).toEqual(["template"]);
    const template = children(cardHost)[0]!;
    expect(attr(template, "shadowrootmode")).toBe("open");

    const content = children(template.content!);
    expect(content.map((node) => node.tagName)).toEqual(["style", "div", "script"]);

    // The style carries the page's nonce and the card's css.
    expect(attr(content[0]!, "nonce")).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
    expect(text(content[0]!)).toBe("label{color:red}");

    // The body is the div a script replaces on an action.
    expect(classes(content[1]!)).toEqual(["ui-card-body"]);
    expect(attr(content[1]!, "data-ui-body")).toBe("");
    const input = elements(content[1]!).find((node) => node.tagName === "input");
    expect(input).toBeDefined();
    expect(attr(input!, "type")).toBe("checkbox");
    expect(text(content[1]!)).toContain("demo");

    // The script is module-typed and versioned by the file's mtime.
    expect(attr(content[2]!, "type")).toBe("module");
    expect(scriptSrc(document)).toMatch(/^\/ext\/demo-cards\/ui\/card\.js\?v=\d+$/);

    // The whole host is the shape the browser script reads, byte for byte.
    const mtime = Math.floor(
      (await stat(join(harness!.paths.extensionsDir, "demo-cards", "ui", "card.js"))).mtimeMs,
    );
    const nonce = styleNonce(document);
    expect(page).toContain(
      '<div class="ui-card" data-ui-extension="demo-cards" data-ui-card="toggle">' +
        '<template shadowrootmode="open">' +
        `<style nonce="${nonce}">label{color:red}</style>` +
        '<div class="ui-card-body" data-ui-body><label class="toggle"><input type="checkbox"> demo</label></div>' +
        `<script type="module" src="/ext/demo-cards/ui/card.js?v=${mtime}"></script>` +
        "</template></div>",
    );
  });

  it("puts the mount prefix in the script URL", async () => {
    const origin = await boot({
      config: { server: { ...defaultConfig().server, port: 0, basePath: "/sec" } },
      extension: { name: "demo-cards", body: DEMO_CARDS, files: { "ui/card.js": "export const on = true;\n" } },
    });
    const page = await (await fetch(`${origin}/sec/basic-chat`)).text();
    const document = parse(page) as unknown as PNode;
    expect(scriptSrc(document)).toMatch(/^\/sec\/ext\/demo-cards\/ui\/card\.js\?v=\d+$/);
    // The stamped page around the card is the one the mount test already expects.
    expect(page).toContain('<meta name="pi-sec-base" content="/sec" />');
  });

  it("names the page's nonce in the CSP, leaves every other directive alone, and makes a new one per response", async () => {
    const origin = await boot({
      extension: { name: "demo-cards", body: DEMO_CARDS, files: { "ui/card.js": "export const on = true;\n" } },
    });

    const first = await fetch(`${origin}/basic-chat`);
    const firstPolicy = first.headers.get("content-security-policy") ?? "";
    const firstNonce = styleNonce(parse(await first.text()) as unknown as PNode);
    expect(firstNonce).toBeDefined();

    // The only change from the policy the page carried before cards existed.
    expect(firstPolicy).toBe(CSP_BASE.replace("style-src 'self'", `style-src 'self' 'nonce-${firstNonce}'`));
    // Spelling it out: the script directive is untouched, so a card cannot add an
    // inline script through its style nonce.
    expect(firstPolicy).toContain("script-src 'self'");
    expect(firstPolicy).not.toContain("script-src 'self' 'nonce");

    const second = await fetch(`${origin}/basic-chat`);
    const secondNonce = styleNonce(parse(await second.text()) as unknown as PNode);
    expect(secondNonce).toBeDefined();
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("sends the old policy, byte for byte, and an empty slot, when no card is registered", async () => {
    const origin = await boot();
    const response = await fetch(`${origin}/basic-chat`);
    expect(response.headers.get("content-security-policy")).toBe(CSP_BASE);

    const document = parse(await response.text()) as unknown as PNode;
    const marker = slot(document);
    expect(marker).toBeDefined();
    expect(children(marker!)).toEqual([]);
    expect(text(marker!)).toBe("");
  });
});

/** A card per failure mode, all in the slot the page opens. */
const BROKEN_CARDS = `
export const name = "demo-cards";
export function create() {
  return { name: "demo-cards" };
}
export const ui = {
  cards: [
    { slot: "sidebar.bottom", name: "good" },
    { slot: "sidebar.bottom", name: "throws" },
    { slot: "sidebar.bottom", name: "slow" },
    { slot: "sidebar.bottom", name: "invalid" },
    { slot: "sidebar.bottom", name: "hidden" },
  ],
  render({ card }) {
    if (card === "good") return { html: "<b>on</b>", css: "b{color:green}" };
    if (card === "throws") throw new Error("render exploded");
    if (card === "slow") return new Promise(() => {});
    if (card === "invalid") return { html: "<script>alert(1)</script>" };
    return null;
  },
};
`;

describe("a card that does not render", () => {
  it("shows a failure line for a throw, a timeout and bad markup, and drops a hidden card", async () => {
    const origin = await boot({ extension: { name: "demo-cards", body: BROKEN_CARDS } });
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    const document = parse(page) as unknown as PNode;

    const failed = (card: string): PNode | undefined => {
      const found = host(document, card);
      return found !== undefined && classes(found).includes("ui-card-failed") ? found : undefined;
    };

    // Each failure is one plain line, with no template and no script inside it.
    expect(text(failed("throws")!)).toBe("demo-cards/throws: failed to load");
    expect(text(failed("slow")!)).toBe("demo-cards/slow: failed to load");
    expect(text(failed("invalid")!)).toBe("demo-cards/invalid: invalid markup");
    for (const card of ["throws", "slow", "invalid"]) {
      const found = failed(card)!;
      expect(elements(found)).toEqual([]);
    }

    // A hidden card leaves nothing at all.
    expect(host(document, "hidden")).toBeUndefined();

    // The good card and the page around the slot are still there.
    const good = host(document, "good")!;
    expect(classes(good)).toEqual(["ui-card"]);
    expect(children(good).map((node) => node.tagName)).toEqual(["template"]);
    expect(byId(document, "theme-toggle")).toBeDefined();
    expect(byId(document, "composer")).toBeDefined();
    expect(byId(document, "context-bar")).toBeDefined();
    expect(byId(document, "sidebar")).toBeDefined();
  });

  it("keeps hostile markup inside the card and never touches the page around it", async () => {
    const hostile = `
export const name = "demo-cards";
export function create() {
  return { name: "demo-cards" };
}
export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "toggle" }],
  render() {
    return {
      html: '<div class="inside">a</div></template></div><b>after<!-- open comment',
      css: "div{color:red}",
    };
  },
};
`;
    const origin = await boot({ extension: { name: "demo-cards", body: hostile } });
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    const document = parse(page) as unknown as PNode;

    // Exactly one template in the page: a stray end tag in the card cannot close
    // the shadow root early and put the rest of the page inside it.
    const templates = elements(document).filter((node) => node.tagName === "template");
    expect(templates).toHaveLength(1);

    // The card's own content is what the check let through, and nothing more.
    const content = children(templates[0]!.content!);
    expect(content.map((node) => node.tagName)).toEqual(["style", "div"]);

    // Everything after the slot is still a node of the page.
    expect(byId(document, "theme-toggle")).toBeDefined();
    expect(byId(document, "sidebar")).toBeDefined();
    expect(byId(document, "composer")).toBeDefined();
    expect(byId(document, "transcript")).toBeDefined();
  });
});
