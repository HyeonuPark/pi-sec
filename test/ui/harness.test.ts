/**
 * The page harness itself.
 *
 * A harness that quietly stopped recording, or that handed a page a `fetch` the
 * page could not call, would make every page test that uses it say "nothing
 * happened" instead of "this is broken". So this file drives the fakes through
 * the page's own window: a request answers what it was given, a stream is
 * recorded and delivers a frame, and `expectUntouched` both passes on an
 * untouched element and fails on a replaced one.
 *
 * The file also imports one page module, which is what proves the test runner's
 * TSX setting is the one the pages need: without it, a `.tsx` import would look
 * for the React JSX runtime.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { loadUiPage } from "./harness.ts";

describe("the page harness", () => {
  it("loads a shell with the server's stamps and no shell script", async () => {
    const page = await loadUiPage("chats", { base: "/sec" });
    try {
      expect(page.document.querySelector("script")).toBeNull();
      expect(page.document.querySelector('meta[name="pi-sec-base"]')?.getAttribute("content")).toBe("/sec");
      expect(page.document.querySelector('meta[name="pi-sec-timezone"]')?.getAttribute("content")).toBe("Asia/Tokyo");
      // `base.js` is in the page before the bundle, as the shell loads it.
      expect(page.window.piSecMount.at("/sec", "/api/jobs")).toBe("/sec/api/jobs");
      // The page is its own bundle: the entry mounted, and drew nothing.
      expect(page.document.getElementById("view")).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it("gives the page the clock a test names, and the real clock otherwise", async () => {
    // A moment far from today, so the real clock cannot pass for it.
    const now = Date.UTC(2020, 0, 1, 0, 0, 0);
    const fixed = await loadUiPage("chats", { now });
    try {
      const read = Number(fixed.window.eval("Date.now()"));
      expect(read).toBeGreaterThanOrEqual(now);
      expect(read - now).toBeLessThan(60_000);
    } finally {
      fixed.close();
    }
    const real = await loadUiPage("chats");
    try {
      expect(Math.abs(Number(real.window.eval("Date.now()")) - Date.now())).toBeLessThan(60_000);
    } finally {
      real.close();
    }
  });

  it("loads a page at the address a test names, and at the page's own path otherwise", async () => {
    const viewer = await loadUiPage("report", { url: "/report/some-slug" });
    try {
      expect(viewer.window.location.pathname).toBe("/report/some-slug");
    } finally {
      viewer.close();
    }

    const list = await loadUiPage("report");
    try {
      expect(list.window.location.pathname).toBe("/report");
    } finally {
      list.close();
    }
  });

  it("answers and records what the page fetches", async () => {
    const page = await loadUiPage("chats", {
      base: "/sec",
      fetch: { "/api/focused-chats": { body: { chats: [] } } },
    });
    try {
      const answer = (await page.window.fetch("/sec/api/focused-chats")) as {
        status: number;
        json: () => Promise<unknown>;
      };
      expect(answer.status).toBe(200);
      await expect(answer.json()).resolves.toEqual({ chats: [] });
      // A page may read for itself while it starts. What this checks is that
      // the request above was recorded, whatever else the page asked for.
      expect(
        page.fetchCalls.find((call) => call.url === "/sec/api/focused-chats" && call.method === "GET"),
      ).toMatchObject({
        url: "/sec/api/focused-chats",
        path: "/sec/api/focused-chats",
        method: "GET",
      });
    } finally {
      page.close();
    }
  });

  it("records the streams the page opens and delivers a frame to it", async () => {
    const page = await loadUiPage("chats");
    try {
      const source = new page.window.EventSource("/api/focused-chats/events") as unknown as {
        addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
        emit: (type: string, payload?: unknown) => void;
      };
      // A page may open a stream of its own. The one this test opened is
      // recorded, it is the current stream, and the frame below reaches it.
      expect(page.streams()).toContain("/api/focused-chats/events");
      expect(page.currentStream()).toBe(source);

      const seen: string[] = [];
      source.addEventListener("snapshot", (event) => seen.push(event.data));
      page.emit("snapshot", { type: "snapshot", apiVersion: 1 });
      expect(seen).toEqual([JSON.stringify({ type: "snapshot", apiVersion: 1 })]);
    } finally {
      page.close();
    }
  });

  it("passes an untouched element and fails one that was replaced", async () => {
    const page = await loadUiPage("chat");
    try {
      const before = page.capture("#message");
      page.expectUntouched(before);

      before.element.replaceWith(page.document.createElement("textarea"));
      expect(() => page.expectUntouched(before)).toThrow();
    } finally {
      page.close();
    }
  });

  it("imports a page module, so the runner's JSX setting is the page's", { timeout: 30_000 }, async () => {
    const page = new JSDOM('<!doctype html><html><body><div id="transcript"></div></body></html>', {
      url: "http://localhost/basic-chat",
    });
    vi.stubGlobal("document", page.window.document);
    vi.stubGlobal("window", page.window);
    try {
      // Importing the page is what proves the runner's JSX setting is the page's:
      // the module is TSX, and it loads and runs. What it draws is not this
      // test's business — the page's own tests say what is on it — so the
      // assertion stops at "it loaded without throwing".
      const module = await import("../../src/ui/pages/chat.tsx");
      expect(module).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      page.window.close();
    }
  });
});
