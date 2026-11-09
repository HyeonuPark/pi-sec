/**
 * Rich pages in a real browser (C4, C5, C6, C10).
 *
 * jsdom enforces no Content-Security-Policy, runs no sandboxed frame and has no
 * layout, so none of these facts can be shown there:
 *
 *   - the example page runs its script in a chat row, in the report viewer and in
 *     the shell tab, and its frame follows its content height;
 *   - a hostile page cannot reach the daemon, the parent page, a window or a
 *     form target, and no request of it reaches the server (the server side
 *     counts every request that carries the canary marker);
 *   - in the chat, a far image, a far upload and a far page frame send no request
 *     at page load, load within one pane height, keep the reader's place, and a
 *     page frame more than three pane heights away goes back to `about:blank`
 *     and keeps its height; the report viewer loads its frame at once.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { createAttachment, type AttachmentContext } from "../../src/attachments/store.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import { builtWebDir } from "./web-dir.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";

const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
let port = 0;
let tempDir = "";
let store: AttachmentContext;
/** Every request path that reached the server, in order. */
const seen: string[] = [];

/** A solid-color PNG of the given size, written by hand so the test needs no image library. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x70)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function readFixture(name: string): Promise<string> {
  return await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

async function makePage(name: string, html: string): Promise<string> {
  const record = await createAttachment(store, { kind: "share", name, mime: "text/html", data: Buffer.from(html, "utf8"), richPage: true });
  return record.id;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-sec-rich-pages-browser-"));
  const roots = { attachments: join(tempDir, "attachments"), share: join(tempDir, "share") };
  await mkdir(roots.attachments, { recursive: true });
  await mkdir(roots.share, { recursive: true });
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  store = { storage: harness.runtime.storage, harness: harness.runtime.harness, audit: harness.runtime.audit, roots };
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: harness.runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: builtWebDir(),
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: builtWebDir(), attachmentRoots: roots });
  origin = started.origin;
  port = Number(new URL(origin).port);
  started.server.on("request", (request) => {
    seen.push(request.url ?? "");
  });
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

function chatEntry(id: number, kind: "pi.user" | "pi.assistant", text: string, attributes = "") {
  const content = kind === "pi.user" ? `<pi-message src="operator"${attributes}>\n${text}\n</pi-message>` : [{ type: "text", text }];
  return { id, kind, model: [{ role: kind === "pi.user" ? "user" : "assistant", content }] };
}

interface Frame {
  readonly type: string;
  readonly data?: unknown;
}

interface FramePage {
  readonly page: Page;
  readonly pageErrors: string[];
  emit(frames: Frame[]): Promise<void>;
}

/** A chat page whose conversation stream this test drives. Routes, images and frames are the real server's. */
async function openChatPage(): Promise<FramePage> {
  const page = await currentContext().newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await page.addInitScript(() => {
    const sources: Array<{ emit: (type: string, data?: unknown) => void }> = [];
    (window as unknown as { __sseSources: unknown }).__sseSources = sources;
    (window as unknown as { __messages: unknown[] }).__messages = [];
    window.addEventListener("message", (event) => (window as unknown as { __messages: unknown[] }).__messages.push(event.data));
    class EmittingSource {
      readonly listeners: Map<string, Array<(event: { data: string }) => void>> = new Map();
      constructor() {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: { data: string }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      removeEventListener(): void {}
      close(): void {}
      emit(type: string, data?: unknown): void {
        const payload = data === undefined ? "" : JSON.stringify(data);
        for (const listener of this.listeners.get(type) ?? []) listener({ data: payload });
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = EmittingSource;
  });
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => ((window as unknown as { __sseSources?: unknown[] }).__sseSources?.length ?? 0) > 0, undefined, {
    timeout: 30000,
  });
  const emit = async (frames: Frame[]): Promise<void> => {
    await page.evaluate((handed) => {
      const built = (window as unknown as { __sseSources: Array<{ emit: (type: string, data?: unknown) => void }> }).__sseSources;
      const source = built[built.length - 1]!;
      for (const frame of handed) source.emit(frame.type, frame.data);
    }, frames);
  };
  return { page, pageErrors, emit };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("runs the example page in a chat row, with a frame that follows its content height", async () => {
  const id = await makePage("example.html", await readFixture("rich-page-example.html"));
  const { page, pageErrors, emit } = await openChatPage();
  await emit([
    { type: "open" },
    { type: "snapshot", data: { entries: [chatEntry(1, "pi.user", "show me"), chatEntry(2, "pi.assistant", `Here it is.\n\n![Weekly tool calls](/rich-pages/${id})`)] } },
  ]);
  const frameElement = page.locator("iframe.rich-page-frame");
  await frameElement.waitFor({ state: "attached", timeout: 30000 });
  const frame = page.frameLocator("iframe.rich-page-frame");
  await frame.locator("rect.bar").first().waitFor({ timeout: 30000 });
  expect(await frame.locator("rect.bar").count()).toBe(7);
  await frame.locator("rect.bar").nth(3).hover();
  expect(await frame.locator("#readout").textContent()).toBe("Thu: 41 calls");
  // The caption is core markup outside the frame.
  expect(await page.locator(".rich-page-label").textContent()).toBe("Generated page");
  expect(await page.locator(".rich-page-caption a").getAttribute("href")).toBe(`/rich-pages/${id}`);
  // The frame took the height of its content: not the starting 360, and inside 80..1200.
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLElement>("iframe.rich-page-frame");
    return element !== null && element.style.height !== "" && element.style.height !== "360px";
  });
  const heights = await page.evaluate(async () => {
    const element = document.querySelector<HTMLIFrameElement>("iframe.rich-page-frame")!;
    return { frame: element.getBoundingClientRect().height, style: element.style.height };
  });
  expect(heights.frame).toBeGreaterThanOrEqual(80);
  expect(heights.frame).toBeLessThanOrEqual(1200);
  const content = await page.frames().find((candidate) => candidate.url().includes(`/rich-pages/${id}/frame`))!.evaluate(
    () => Math.ceil(document.documentElement.getBoundingClientRect().height),
  );
  expect(heights.style).toBe(`${content}px`);
  expect(pageErrors).toEqual([]);
  await page.close();
});

it("runs the example page in the report viewer, loaded at once", async () => {
  const id = await makePage("example-report.html", await readFixture("rich-page-example.html"));
  const page = await currentContext().newPage();
  const reportId = "01REPORTFIXTURE0000000000";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const record = {
      id: reportId,
      jobId: "01JOBFIXTURE00000000000000",
      name: "page-report",
      title: "Page report",
      versions: [{ n: 1, at: 1_000, bytes: 8, sha256: "a" }],
      feedback: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      active: true,
      archived: false,
      status: "active",
      job: { id: "01JOBFIXTURE00000000000000", title: "work", status: "active" },
    };
    if (path === "/api/reports") return await json({ reports: [record], archived: [] });
    if (path === "/api/reports/by-name/page-report" || path === `/api/reports/${reportId}`) return await json(record);
    if (path === `/api/reports/${reportId}/versions/1`) {
      return await route.fulfill({ status: 200, contentType: "text/markdown", body: `# Page report\n\n![Weekly tool calls](/rich-pages/${id})\n` });
    }
    return await json({});
  });
  await page.goto(`${origin}/report/page-report`, { waitUntil: "load", timeout: 30000 });
  const element = page.locator("iframe.rich-page-frame");
  await element.waitFor({ state: "attached", timeout: 30000 });
  // No scroll and no observer: the address is set by the renderer, not deferred.
  expect(await element.getAttribute("src")).toBe(`/rich-pages/${id}/frame`);
  expect(await element.getAttribute("data-defer-src")).toBeNull();
  const frame = page.frameLocator("iframe.rich-page-frame");
  await frame.locator("rect.bar").first().waitFor({ timeout: 30000 });
  expect(await frame.locator("rect.bar").count()).toBe(7);
  await page.close();
});

it("shows the page in the shell tab, and a raw frame address opened as a page lands on the shell", async () => {
  const id = await makePage("shell.html", await readFixture("rich-page-example.html"));
  const page = await currentContext().newPage();
  await page.goto(`${origin}/rich-pages/${id}`, { waitUntil: "load", timeout: 30000 });
  expect(await page.locator(".rich-page-bar-label").textContent()).toBe("Generated page");
  expect(await page.locator(".rich-page-bar-title").textContent()).toBe("shell");
  const frame = page.frameLocator("iframe.rich-page-shell-frame");
  await frame.locator("rect.bar").first().waitFor({ timeout: 30000 });
  expect(await frame.locator("rect.bar").count()).toBe(7);
  await frame.locator("rect.bar").nth(1).hover();
  expect(await frame.locator("#readout").textContent()).toBe("Tue: 30 calls");

  const raw = await currentContext().newPage();
  await raw.goto(`${origin}/rich-pages/${id}/frame`, { waitUntil: "load", timeout: 30000 });
  expect(new URL(raw.url()).pathname).toBe(`/rich-pages/${id}`);
  expect(await raw.locator(".rich-page-bar-label").count()).toBe(1);
  await raw.close();
  await page.close();
});

it("keeps a hostile page from reaching the daemon, the parent, a window, a form target or an outside address", async () => {
  const outside = `http://localhost:${port}`;
  const html = (await readFixture("rich-page-hostile.html")).replaceAll("__OUTSIDE__", outside);
  const id = await makePage("hostile.html", html);
  const { page, emit } = await openChatPage();
  const before = seen.length;
  await emit([
    { type: "open" },
    { type: "snapshot", data: { entries: [chatEntry(1, "pi.user", "go"), chatEntry(2, "pi.assistant", `![Hostile](/rich-pages/${id})`)] } },
  ]);
  await page.waitForFunction(
    () => (window as unknown as { __messages: Array<{ hostileResults?: unknown }> }).__messages.some((m) => m?.hostileResults !== undefined),
    undefined,
    { timeout: 30000 },
  );
  await wait(800);
  const results = await page.evaluate(
    () => (window as unknown as { __messages: Array<{ hostileResults?: unknown }> }).__messages.find((m) => m?.hostileResults !== undefined)!.hostileResults,
  );
  expect(results).toEqual({
    fetchGet: "rejected",
    fetchPost: "rejected",
    image: "error",
    parentDocument: "threw",
    topLocation: "threw",
    windowOpen: "null",
    formSubmitEvents: 1,
  });
  // The server counted nothing the page tried: the only requests since the frame
  // loaded are the page's own and the chat page's.
  const canaries = seen.slice(before).filter((path) => path.includes("canary"));
  expect(canaries).toEqual([]);
  // The chat page stayed where it was, and so did the frame.
  expect(new URL(page.url()).pathname).toBe("/basic-chat");
  expect(page.frames().some((candidate) => candidate.url().includes("canary"))).toBe(false);
  await page.close();
});

/** The pane's visible box and the distance of an element from it, in pixels. */
async function geometry(page: Page, selector: string): Promise<{ pane: number; distance: number }> {
  return await page.evaluate((query) => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane")!;
    const element = document.querySelector<HTMLElement>(query);
    if (element === null) throw new Error(`no element ${query}`);
    const p = pane.getBoundingClientRect();
    const e = element.getBoundingClientRect();
    const distance = e.bottom < p.top ? p.top - e.bottom : e.top > p.bottom ? e.top - p.bottom : 0;
    return { pane: p.height, distance };
  }, selector);
}

function hits(path: string, from = 0): number {
  return seen.slice(from).filter((entry) => entry.includes(path)).length;
}

async function scrollTo(page: Page, top: number): Promise<number> {
  return await page.evaluate((value) => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane")!;
    pane.scrollTop = value;
    return pane.scrollTop;
  }, top);
}

async function paneTop(page: Page): Promise<{ top: number; max: number; height: number }> {
  return await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane")!;
    return { top: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight, height: pane.clientHeight };
  });
}

/** The top of one in-view text row, relative to the pane. The row is chosen by key and kept. */
async function anchorTop(page: Page): Promise<{ key: string; top: number } | null> {
  return await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane")!;
    const p = pane.getBoundingClientRect();
    for (const row of document.querySelectorAll<HTMLElement>("#transcript > [data-row-key]")) {
      const r = row.getBoundingClientRect();
      if (r.top >= p.top + 10 && r.top <= p.bottom - 40 && row.querySelector("img, iframe") === null) {
        return { key: row.dataset["rowKey"]!, top: r.top - p.top };
      }
    }
    return null;
  });
}

async function rowTop(page: Page, key: string): Promise<number | null> {
  return await page.evaluate((rowKey) => {
    const pane = document.querySelector<HTMLElement>(".transcript-pane")!;
    const row = document.querySelector<HTMLElement>(`#transcript > [data-row-key="${rowKey}"]`);
    return row === null ? null : row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, key);
}

it("loads far images and page frames only near the view, keeps the reader's place, and unloads a far page", async () => {
  const example = await readFixture("rich-page-example.html");
  const farPage = await makePage("far-page.html", example);
  const nearPage = await makePage("near-page.html", example);
  await createAttachment(store, { kind: "share", name: "far-pic.png", mime: "image/png", data: png(300, 120) });
  await createAttachment(store, { kind: "share", name: "near-pic.png", mime: "image/png", data: png(300, 120) });
  const upload = await createAttachment(store, { kind: "attachment", name: "far-upload.png", mime: "image/png", data: png(300, 120) });

  const paragraph = "A long line of filler text that makes the row tall enough to matter in a short pane. ".repeat(3);
  const entries = [
    chatEntry(1, "pi.user", "here is a file", ` attachments="${upload.id}"`),
    chatEntry(2, "pi.assistant", "far picture\n\n![far pic](/api/share/far-pic.png)"),
    chatEntry(3, "pi.assistant", `far page\n\n![Far page](/rich-pages/${farPage})`),
  ];
  for (let index = 0; index < 60; index += 1) {
    entries.push(chatEntry(4 + index, "pi.assistant", Array.from({ length: 2 }, () => paragraph).join("\n\n")));
  }
  entries.push(chatEntry(70, "pi.assistant", `near\n\n![near pic](/api/share/near-pic.png)\n\n![Near page](/rich-pages/${nearPage})`));

  const { page, pageErrors, emit } = await openChatPage();
  const before = seen.length;
  await emit([
    { type: "open" },
    { type: "snapshot", data: { entries, attachments: { [upload.id]: { name: "far-upload.png", mime: "image/png", bytes: 100 } } } },
  ]);
  await page.waitForFunction(() => document.querySelectorAll("#transcript > [data-row-key]").length >= 40, undefined, { timeout: 30000 });

  // At page load the pane is at its tail. The near items load, and no request
  // reaches the server for the far ones.
  const nearFrame = page.locator(`iframe.rich-page-frame[src$="/rich-pages/${nearPage}/frame"]`);
  await nearFrame.waitFor({ state: "attached", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[data-defer-src$="near-pic.png"]')?.complete === true, undefined, { timeout: 30000 });
  await wait(500);
  expect(hits("/api/share/near-pic.png", before)).toBeGreaterThan(0);
  expect(hits(`/rich-pages/${nearPage}/frame`, before)).toBeGreaterThan(0);
  expect(hits("/api/share/far-pic.png", before)).toBe(0);
  expect(hits(`/api/attachments/${upload.id}`, before)).toBe(0);
  expect(hits(`/rich-pages/${farPage}/frame`, before)).toBe(0);
  expect(await page.locator(`img[data-defer-src$="far-pic.png"]`).getAttribute("src")).toBeNull();
  expect(await page.locator(`iframe[data-defer-src$="/${farPage}/frame"]`).getAttribute("src")).toBeNull();

  // Scroll up in small steps. A far item sends no request while it is more than
  // one pane height away, and does within one pane height. Every step keeps an
  // in-view text row in place: its movement equals the scroll, within 2 pixels.
  const targets: Array<{ selector: string; path: string }> = [
    { selector: `iframe[data-defer-src$="/${farPage}/frame"]`, path: `/rich-pages/${farPage}/frame` },
    { selector: `img[data-defer-src$="far-pic.png"]`, path: "/api/share/far-pic.png" },
    { selector: `img[data-defer-src$="/api/attachments/${upload.id}"]`, path: `/api/attachments/${upload.id}` },
  ];
  let worst = 0;
  let measured = 0;
  for (const target of targets) {
    let arrived = false;
    for (let step = 0; step < 600 && !arrived; step += 1) {
      const { top, height } = await paneTop(page);
      const near = await geometry(page, target.selector);
      if (near.distance <= near.pane * 0.9) {
        // Inside one pane height: the request must arrive.
        for (let attempt = 0; attempt < 40 && hits(target.path, before) === 0; attempt += 1) await wait(50);
        expect(hits(target.path, before), `${target.path} within one pane height`).toBeGreaterThan(0);
        arrived = true;
        break;
      }
      if (near.distance > near.pane * 1.25) expect(hits(target.path, before), `${target.path} beyond one pane height`).toBe(0);
      const anchor = await anchorTop(page);
      const applied = await scrollTo(page, Math.max(0, top - Math.max(20, height * (near.distance > near.pane * 2 ? 0.4 : 0.1))));
      await wait(60);
      if (anchor !== null) {
        const after = await rowTop(page, anchor.key);
        if (after !== null) {
          const expected = anchor.top + (top - applied);
          worst = Math.max(worst, Math.abs(after - expected));
          measured += 1;
        }
      }
    }
    expect(arrived, `${target.path} was reached`).toBe(true);
  }
  // The check ran on real steps, and no step moved the reader's row by more than 2 pixels.
  expect(measured).toBeGreaterThan(10);
  expect(worst).toBeLessThanOrEqual(2);
  // The far page frame runs its script once loaded.
  const farFrame = page.frames().find((candidate) => candidate.url().includes(`/rich-pages/${farPage}/frame`));
  expect(farFrame).toBeDefined();
  await farFrame!.locator("rect.bar").first().waitFor({ timeout: 30000 });
  expect(await farFrame!.locator("rect.bar").count()).toBe(7);

  // Back to the tail: the far page frame is more than three pane heights away,
  // so it goes back to about:blank and keeps the height it had.
  const farSelector = `iframe[data-defer-src$="/${farPage}/frame"]`;
  const loadedHeight = await page.locator(farSelector).evaluate((element) => element.getBoundingClientRect().height);
  expect(loadedHeight).not.toBe(360);
  await scrollTo(page, (await paneTop(page)).max);
  await page.waitForFunction((query) => document.querySelector(query)?.getAttribute("src") === "about:blank", farSelector, { timeout: 30000 });
  const gone = await geometry(page, farSelector);
  expect(gone.distance).toBeGreaterThan(gone.pane * 3);
  expect(await page.locator(farSelector).evaluate((element) => element.getBoundingClientRect().height)).toBe(loadedHeight);
  // A picture is never unloaded.
  expect(await page.locator(`img[data-defer-src$="far-pic.png"]`).getAttribute("src")).toBe("/api/share/far-pic.png");
  expect(pageErrors).toEqual([]);
  await page.close();
});
