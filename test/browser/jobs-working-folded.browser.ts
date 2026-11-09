/**
 * The working marker on a folded job, in a real browser.
 *
 * A folded row is the only row that can hide the work below it, so the panel
 * fills the folded row's chip itself while an agent under it runs, and says so in
 * the tooltip. That is a fact about computed style and about a click the operator
 * really makes, which jsdom cannot answer: it applies no stylesheet, so "the chip
 * is filled" is untestable there. So this file drives Chromium through Playwright
 * against a real server on port 0 and reads the background the browser computed.
 *
 * The two jobs and the live agent are real: a `sec.agent` record that names the
 * child job in `forJobId`, and a run the faux model holds open. That is the same
 * "working" test the server makes in production, so nothing here stubs it.
 *
 * The three cases are: folded with work below fills and names it,
 * opened shows only the row's own work, and a folded row with nothing working
 * below it stays unfilled.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { defaultConfig } from "../../src/config/schema.ts";
import { SecAgent } from "../../src/documents.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";

// Same library prefix and launch args as the other browser tests: Chromium needs
// X11/atk/gbm libraries that a minimal Linux image may not ship, and it may have no GPU.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

const CTX = BACKGROUND_CONTEXT;

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let origin = "";
/** The job whose child is being worked on. */
let parentId = "";
/** That child, which the live agent names in `forJobId`. */
let workId = "";
/** The job whose subtree is idle. */
let quietId = "";
let held: { readonly opened: Promise<void>; open(): void } | undefined;

/** A gate that keeps one fake model request open, so a run stays live. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const h = harness;

  // Two groups: one with a child an agent is working for, and one whose subtree
  // has nothing running. Both parents are `planned`, so each chip is the button
  // that folds its children.
  const parent = await h.runtime.jobs.create(CTX, { title: "folded group with work below" });
  parentId = parent.id;
  const child = await h.runtime.jobs.create(CTX, { title: "the job being worked on", parentId });
  workId = child.id;
  const quiet = await h.runtime.jobs.create(CTX, { title: "folded group with nothing running" });
  quietId = quiet.id;
  await h.runtime.jobs.create(CTX, { title: "an idle child", parentId: quiet.id });

  // One agent that works for the child job without a handover, and a run held
  // open so the job list sees it as working.
  let childConversation = "";
  await h.runtime.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    childConversation = String(conversation.id);
    const record = await tx.doc(SecAgent, childConversation, childConversation);
    record.kind = "subagent";
    record.name = "worker-below";
    record.parentConversationId = "1";
    record.status = "running";
    record.forJobId = child.id;
  }, CTX);
  held = gate();
  const opened = held.opened;
  const answer: FauxResponseFactory = async () => {
    await opened;
    return fauxAssistantMessage([fauxText("still working")]);
  };
  h.faux.setResponses(Array.from({ length: 20 }, () => answer));
  const conversation = await h.runtime.harness.conversation(Number(childConversation) as ConversationId, CTX);
  if (conversation === undefined) throw new Error(`no conversation ${childConversation}`);
  await conversation.configure(
    { model: { provider: "faux", modelId: h.faux.getModel().id }, thinkingLevel: "medium" },
    CTX,
  );
  void conversation.submit({ type: "input", content: "work" }, CTX);

  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: h.runtime,
    bus: h.events,
    sse,
    streams: new StreamHub({ runtime: h.runtime, bus: h.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: builtWebDir(),
    adminState: { restart: h.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
});

afterAll(async () => {
  held?.open();
  held = undefined;
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

/** The page, once the jobs panel has drawn both groups. */
async function openJobs(): Promise<Page> {
  const page = await currentContext().newPage();
  await page.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector(`#jobs [data-job-id="${quietId}"] .status-chip`, { timeout: 30000 });
  await page.waitForSelector(`#jobs [data-job-id="${parentId}"] [data-toggle-children]`, { timeout: 30000 });
  return page;
}

/** Whether the browser computed a fill behind the chip, rather than `none`. */
async function filled(page: Page, jobId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const chip = document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`);
    if (chip === null) throw new Error(`no chip for ${id}`);
    const colour = getComputedStyle(chip).backgroundColor;
    const rgba = colour.match(/rgba?\(([^)]+)\)/);
    if (rgba === null) return colour !== "none" && colour !== "transparent";
    const parts = rgba[1]!.split(/[,/\s]+/).filter((part) => part !== "");
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
    return alpha > 0;
  }, jobId);
}

/**
 * Press a row's chip, then take the pointer off it.
 *
 * `button.status-chip:hover` paints the chip with `--bg`, which is an opaque
 * colour and would read as a fill in `filled`. The pointer stays where the last
 * press left it, so it is moved away before anything is read.
 */
async function pressChip(page: Page, jobId: string): Promise<void> {
  await page.click(`#jobs [data-job-id="${jobId}"] [data-toggle-children]`);
  await page.mouse.move(1, 1);
}

async function title(page: Page, jobId: string): Promise<string> {
  return page.evaluate((id) => {
    const chip = document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`);
    if (chip === null) throw new Error(`no chip for ${id}`);
    return chip.getAttribute("title") ?? "";
  }, jobId);
}

it("fills a folded job for the work under it, and names that work", async () => {
  const page = await openJobs();

  // Open, the group draws its own work only, and it has none. The child, which is
  // being worked on, is filled in its own row.
  expect(await filled(page, parentId), "an open group with no work of its own is filled").toBe(false);
  expect(await title(page, parentId)).toBe("");
  expect(await filled(page, workId), "the row of the job being worked on is not filled").toBe(true);

  await pressChip(page, parentId);
  await page.waitForFunction(
    (id) => document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`)?.getAttribute("aria-expanded") === "false",
    parentId,
    { timeout: 10000 },
  );

  // Folded: the child's row is gone, and the group carries the marker itself.
  expect(await page.locator(`#jobs [data-job-id="${parentId}"] .status-chip`).textContent()).toContain("▸");
  await until(async () => ((await filled(page, parentId)) ? true : undefined), "the folded chip to be filled");
  expect(await title(page, parentId)).toBe("Working below: worker-below");

  // Opened again: the fill goes back to the row's own work, which is none.
  await pressChip(page, parentId);
  await page.waitForFunction(
    (id) => document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`)?.getAttribute("aria-expanded") === "true",
    parentId,
    { timeout: 10000 },
  );
  await until(async () => ((await filled(page, parentId)) ? undefined : true), "the opened chip to lose the fill");
  expect(await title(page, parentId)).toBe("");

  await page.close();
});

it("leaves a folded job unfilled when nothing under it runs", async () => {
  const page = await openJobs();
  await pressChip(page, quietId);
  await page.waitForFunction(
    (id) => document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`)?.getAttribute("aria-expanded") === "false",
    quietId,
    { timeout: 10000 },
  );

  // The fold really hid the child, so an unfilled chip here is a fact about the
  // marker and not about a page that never drew the group.
  expect(await page.locator(`#jobs [data-job-id="${quietId}"] .status-chip`).textContent()).toContain("▸");
  expect(await filled(page, quietId)).toBe(false);
  expect(await title(page, quietId)).toBe("");

  // The fold is shared state on the server, so it is put back for the next case.
  await pressChip(page, quietId);
  await page.waitForFunction(
    (id) => document.querySelector(`#jobs [data-job-id="${id}"] .status-chip`)?.getAttribute("aria-expanded") === "true",
    quietId,
    { timeout: 10000 },
  );

  await page.close();
});
