// @vitest-environment jsdom
/**
 * The work panel as a drawer, and as a column.
 *
 * On a wide screen the sidebar is a 22 rem column in flow; at 860 px or narrower it
 * is a drawer over the transcript, with a scrim and `Esc` to close it, and the page
 * behind it does not scroll. Crossing the breakpoint returns to the default of the
 * mode entered: out in flow, away in the drawer.
 *
 * The width is the one thing a page test cannot change — the page harness answers
 * every media query with "wide" — so this file drives the modules directly, with a
 * media query the test can move. Everything else about the drawer is checked on the
 * assembled page, where a press is a real press.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Widths {
  narrow: boolean;
  /** The listeners the page put on the query, so a crossing can be reported. */
  listeners: Set<() => void>;
}

const widths: Widths = { narrow: false, listeners: new Set() };

/** A media query the test can move, in the shape `matchMedia` answers with. */
function mediaQuery(query: string): MediaQueryList {
  return {
    media: query,
    get matches(): boolean {
      return widths.narrow;
    },
    addEventListener(type: string, listener: () => void): void {
      if (type === "change") widths.listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void): void {
      if (type === "change") widths.listeners.delete(listener);
    },
    addListener(listener: () => void): void {
      widths.listeners.add(listener);
    },
    removeListener(listener: () => void): void {
      widths.listeners.delete(listener);
    },
  } as unknown as MediaQueryList;
}

/** Put the chat page's shell into this test's document, minus its scripts. */
async function installShell(): Promise<void> {
  const html = await readFile(join(process.cwd(), "src/web/index.html"), "utf8");
  const stripped = html.replaceAll("{{base}}", "").replace(/<script\b[^>]*>\s*<\/script>/gi, "");
  const parsed = new DOMParser().parseFromString(stripped, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  for (const attribute of parsed.body.attributes) document.body.setAttribute(attribute.name, attribute.value);
  document.head.innerHTML = parsed.head.innerHTML;
}

interface Mounted {
  readonly sidebar: typeof import("../../src/ui/chat/sidebar/Sidebar.tsx");
  readonly panels: typeof import("../../src/ui/state/panels.ts");
  readonly handle: { unmount(): void };
}

/** Load the modules fresh, mount the drawer's parts, and hand both back. */
async function mount(narrow: boolean): Promise<Mounted> {
  widths.narrow = narrow;
  widths.listeners.clear();
  await installShell();
  (window as unknown as { matchMedia: unknown }).matchMedia = mediaQuery;
  vi.resetModules();
  const panels = await import("../../src/ui/state/panels.ts");
  const sidebar = await import("../../src/ui/chat/sidebar/Sidebar.tsx");
  const parts = await import("../../src/ui/chat/panels/Panels.tsx");
  const wiring = await import("../../src/ui/chat/wiring.ts");
  // The three panels of the one slot are mounted with the drawer, because the
  // `<body>` flags both of them are read from are written in one place. The
  // wiring comes with them: `Esc` is the page's, and the drawer is one of the
  // things it puts away.
  const panelHandle = parts.mountChatPanels(document);
  const wiringHandle = wiring.mountChatWiring(document);
  const handle = sidebar.mountChatSidebar(document);
  return {
    sidebar,
    panels,
    handle: {
      unmount() {
        handle.unmount();
        wiringHandle.unmount();
        panelHandle.unmount();
      },
    },
  };
}

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.handle.unmount();
  mounted = undefined;
});

const toggle = (): HTMLElement => document.getElementById("sidebar-toggle") as HTMLElement;

describe("the work panel on a wide screen", { timeout: 30_000 }, () => {
  it("stands in flow and out, and says what its button would do", async () => {
    mounted = await mount(false);
    expect(document.body.dataset.sidebar).toBe("open");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    // Nothing has moved it, so the button says what it does.
    expect(toggle().getAttribute("aria-label")).toBe("Toggle the work panel");
    expect(toggle().getAttribute("aria-controls")).toBe("sidebar");
  });

  it("goes away and comes back from its button, and says which way it would go", async () => {
    mounted = await mount(false);
    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("closed");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Show the work panel");

    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("open");
    expect(toggle().getAttribute("aria-label")).toBe("Hide the work panel");
  });

  it("closes on the scrim", async () => {
    mounted = await mount(false);
    (document.getElementById("sidebar-scrim") as HTMLElement).click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("closed");
  });

  it("returns to the column's default when the width comes back from the drawer", async () => {
    mounted = await mount(false);
    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("closed");

    // The window narrows, then widens again: each crossing is the mode's default.
    widths.narrow = true;
    window.dispatchEvent(new window.Event("resize"));
    expect(document.body.dataset.sidebar).toBe("closed");

    widths.narrow = false;
    window.dispatchEvent(new window.Event("resize"));
    expect(document.body.dataset.sidebar).toBe("open");
  });
});

describe("the work panel as a drawer", { timeout: 30_000 }, () => {
  it("starts away, so the transcript has the screen", async () => {
    mounted = await mount(true);
    expect(document.body.dataset.sidebar).toBe("closed");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Show the work panel");
  });

  it("comes out from its button, and closes on Escape", async () => {
    mounted = await mount(true);
    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("open");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.body.dataset.sidebar).toBe("closed");
  });

  it("answers the media query's own change, which is what a browser reports", async () => {
    mounted = await mount(false);
    expect(document.body.dataset.sidebar).toBe("open");
    widths.narrow = true;
    for (const listener of widths.listeners) listener();
    expect(document.body.dataset.sidebar).toBe("closed");
    // One crossing is one answer, however many sources reported it.
    window.dispatchEvent(new window.Event("resize"));
    expect(document.body.dataset.sidebar).toBe("closed");
  });

  it("comes back to the drawer's default when the width narrows again", async () => {
    mounted = await mount(false);
    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("closed");

    widths.narrow = true;
    window.dispatchEvent(new window.Event("resize"));
    expect(document.body.dataset.sidebar).toBe("closed");
    toggle().click();
    await Promise.resolve();
    expect(document.body.dataset.sidebar).toBe("open");
  });
});
