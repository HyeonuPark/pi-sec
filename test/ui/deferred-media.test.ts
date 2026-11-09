// @vitest-environment jsdom
/** Deferred loading of images and page frames in the chat (C10, unit part). */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, render } from "preact";

type MarkdownModule = typeof import("../../src/ui/components/markdown.tsx");
type DeferredModule = typeof import("../../src/ui/chat/transcript/deferred-media.ts");

let Markdown: MarkdownModule["Markdown"];
let renderMarkdownHtml: MarkdownModule["renderMarkdownHtml"];
let media: DeferredModule;

const ID = "01TEST0000000000000000000A";
const TEXT = `![pic](/api/share/shot.png)\n\n![Page](/rich-pages/${ID})`;

beforeAll(async () => {
  const meta = document.createElement("meta");
  meta.name = "pi-sec-base";
  meta.content = "";
  document.head.append(meta);
  ({ Markdown, renderMarkdownHtml } = await import("../../src/ui/components/markdown.tsx"));
  media = await import("../../src/ui/chat/transcript/deferred-media.ts");
});

interface FakeEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
}

/** An observer that records its options and lets the test fire entries. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    private readonly callback: (entries: FakeEntry[]) => void,
    readonly options: { root: Element; rootMargin: string },
  ) {
    FakeObserver.all.push(this);
  }
  observe(element: Element): void {
    this.observed.add(element);
  }
  unobserve(element: Element): void {
    this.observed.delete(element);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
  fire(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting }]);
  }
}

afterEach(() => {
  media.resetDeferredMediaForTest();
  document.body.replaceChildren();
  FakeObserver.all = [];
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

function install(): void {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
}

function observers(): { load: FakeObserver; unload: FakeObserver } {
  const load = FakeObserver.all.find((item) => item.options.rootMargin === media.DEFER_LOAD_MARGIN);
  const unload = FakeObserver.all.find((item) => item.options.rootMargin === media.DEFER_UNLOAD_MARGIN);
  if (load === undefined || unload === undefined) throw new Error("observers are missing");
  return { load, unload };
}

describe("deferred media markup", () => {
  it("carries data-defer-src and no src for an image and a page frame", () => {
    const html = renderMarkdownHtml(TEXT, { deferMedia: true });
    const box = document.createElement("div");
    box.innerHTML = html;
    const image = box.querySelector("img")!;
    expect(image.getAttribute("data-defer-src")).toBe("/api/share/shot.png");
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.classList.contains("defer-media-pending")).toBe(true);
    const frame = box.querySelector("iframe")!;
    expect(frame.getAttribute("data-defer-src")).toBe(`/rich-pages/${ID}/frame`);
    expect(frame.hasAttribute("src")).toBe(false);
  });

  it("is the plain output without the flag", () => {
    const box = document.createElement("div");
    box.innerHTML = renderMarkdownHtml(TEXT);
    expect(box.querySelector("img")?.getAttribute("src")).toBe("/api/share/shot.png");
    expect(box.querySelector("img")?.hasAttribute("data-defer-src")).toBe(false);
    expect(box.querySelector("iframe")?.getAttribute("src")).toBe(`/rich-pages/${ID}/frame`);
    expect(box.querySelector("iframe")?.hasAttribute("data-defer-src")).toBe(false);
  });
});

describe("deferred media observers", () => {
  it("watches with the pane as root, one and three pane heights wide", () => {
    install();
    const pane = document.createElement("div");
    media.startDeferredMedia(pane);
    const { load, unload } = observers();
    expect(load.options.root).toBe(pane);
    expect(unload.options.root).toBe(pane);
    expect(load.options.rootMargin).toBe("100% 0px");
    expect(unload.options.rootMargin).toBe("300% 0px");
  });

  it("sets the address when an entry intersects, and removes the placeholder class when the picture loads", () => {
    install();
    const pane = document.createElement("div");
    document.body.append(pane);
    render(h(Markdown, { text: TEXT, deferMedia: true }), pane);
    media.startDeferredMedia(pane);
    const { load } = observers();
    const image = pane.querySelector("img")!;
    expect(load.observed.has(image)).toBe(true);
    expect(image.hasAttribute("src")).toBe(false);
    load.fire(image, false);
    expect(image.hasAttribute("src")).toBe(false);
    load.fire(image, true);
    expect(image.getAttribute("src")).toBe("/api/share/shot.png");
    expect(load.observed.has(image)).toBe(false);
    expect(image.classList.contains("defer-media-pending")).toBe(true);
    image.dispatchEvent(new Event("load"));
    expect(image.classList.contains("defer-media-pending")).toBe(false);
  });

  it("unloads a frame to about:blank beyond three pane heights, keeps its height, and loads it again", () => {
    install();
    const pane = document.createElement("div");
    document.body.append(pane);
    render(h(Markdown, { text: TEXT, deferMedia: true }), pane);
    media.startDeferredMedia(pane);
    const { load, unload } = observers();
    const frame = pane.querySelector("iframe")!;
    expect(unload.observed.has(frame)).toBe(true);
    load.fire(frame, true);
    expect(frame.getAttribute("src")).toBe(`/rich-pages/${ID}/frame`);
    frame.style.height = "512px";
    unload.fire(frame, false);
    expect(frame.getAttribute("src")).toBe("about:blank");
    expect(frame.style.height).toBe("512px");
    load.fire(frame, true);
    expect(frame.getAttribute("src")).toBe(`/rich-pages/${ID}/frame`);
    // An image is never unloaded.
    const image = pane.querySelector("img")!;
    load.fire(image, true);
    unload.fire(image, false);
    expect(image.getAttribute("src")).toBe("/api/share/shot.png");
  });

  it("forgets the elements when the text changes", () => {
    install();
    const pane = document.createElement("div");
    document.body.append(pane);
    render(h(Markdown, { text: TEXT, deferMedia: true }), pane);
    media.startDeferredMedia(pane);
    expect(media.deferredMediaCountForTest()).toBe(2);
    render(h(Markdown, { text: "plain", deferMedia: true }), pane);
    expect(media.deferredMediaCountForTest()).toBe(0);
  });

  it("sets every address at once without IntersectionObserver", () => {
    const pane = document.createElement("div");
    document.body.append(pane);
    render(h(Markdown, { text: TEXT, deferMedia: true }), pane);
    expect(pane.querySelector("img")?.getAttribute("src")).toBe("/api/share/shot.png");
    expect(pane.querySelector("iframe")?.getAttribute("src")).toBe(`/rich-pages/${ID}/frame`);
  });
});
