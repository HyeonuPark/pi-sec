/**
 * The `PRs` entry of the sidebar's Pages menu, in a real browser.
 *
 * `github-pr` declares one page link (`PRs` at `/github/pr/`), the server plants
 * it in the chat page, and the menu draws it after its own three. Two facts only a
 * browser can settle are checked here:
 *
 * - Does the press open the page the link names, under the mount the page was
 *   served at? jsdom follows no link at all, so it cannot read the address a new
 *   tab really lands on.
 * - Does the menu close after that press, on the chat tab behind the new one?
 *
 * And the other side of the same rule: with `github-pr` off, which is the default
 * enabled list, the menu has three entries and no `PRs`.
 *
 * The server is the real one, with the extension's own options
 * (`ServerOptions.extensionRoutes["github-pr"]`): the fake `gh`, a temporary
 * `gh-repo` root and a local git repository as the remote, so no test here starts
 * a real `gh` and none reaches GitHub.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { fakeGhFixture, type FakeGhFixture } from "../github-pr/fake-gh-helpers.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";

/** How long the chat tab gets to put the press behind it before the test fails. */
const CLOSED_TIMEOUT_MS = 10000;

/** A timer queue that never fires: the boot cycle of the poll is the only one run. */
const NEVER_FIRE = {
  set: (): unknown => Symbol("never"),
  clear: (): void => {
    /* nothing is ever scheduled */
  },
};

/** The configured repository, spelled the way the fake `gh` answers for. */
const REPO = "acme/widgets";

/** One server this file boots: its origin, and the cleanup that stops it. */
interface Boot {
  readonly origin: string;
  close(): Promise<void>;
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let gh: FakeGhFixture | undefined;
let remote = "";
/** The chat page's path under each server's mount. */
const chatPath = (base: string): string => `${base}/basic-chat`;

/** One `git` call in a scratch repository, with an identity a bare commit needs. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Temporary roots this file made, removed when the file ends. */
const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/**
 * A local repository standing in for GitHub: `main` with one file and a
 * `feature` branch, so the dashboard has a list to draw and the fake `gh` has
 * answers for every call the pages make.
 */
async function makeRemote(): Promise<string> {
  const path = await tempRoot("pages-pr-link-origin-");
  git(path, ["init", "--quiet", "-b", "main", "."]);
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src", "index.ts"), "export function main(): void {\n  run();\n}\n", "utf8");
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "base"]);
  git(path, ["checkout", "--quiet", "-b", "feature"]);
  await writeFile(join(path, "src", "index.ts"), "export function main(): void {\n  done();\n}\n", "utf8");
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "change"]);
  const head = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["update-ref", "refs/pull/10/head", head]);
  git(path, ["checkout", "--quiet", "main"]);
  return path;
}

/** Boot a server with `github-pr` on or off, at the mount the caller names. */
async function boot(options: { readonly enabled: boolean; readonly basePath: string }): Promise<Boot> {
  const harness: TestHarness = await createTestHarness({
    config: {
      server: { ...defaultConfig().server, port: 0, basePath: options.basePath },
      agent: {
        ...defaultConfig().agent,
        extensions: { enabled: options.enabled ? ["github-pr"] : defaultConfig().agent.extensions.enabled },
      },
      ...(options.enabled ? { githubPr: { writes: false, repos: [REPO] } } : {}),
    },
  });
  const repoRoot = await tempRoot("pages-pr-link-repo-");
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
  const started: StartedServer = await startServer(deps, {
    webDir: builtWebDir(),
    extensionRoutes: options.enabled
      ? {
          "github-pr": {
            ghPath: gh!.clientOptions.ghPath,
            ghEnv: gh!.clientOptions.env ?? {},
            repoRoot,
            remoteUrl: () => remote,
            timers: NEVER_FIRE,
          },
        }
      : {},
  });
  return {
    origin: started.origin,
    async close() {
      await started.close();
      await harness.close();
    },
  };
}

beforeAll(async () => {
  remote = await makeRemote();
  gh = await fakeGhFixture();
  roots.push(dirname(gh.logFile));
  browser = await launchChromium();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
}, 120000);

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 60000);

function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

/** Open the chat page under a mount and answer its tab once the Pages row is drawn. */
async function openChatPage(origin: string, base: string): Promise<Page> {
  const page = await currentContext().newPage();
  await page.goto(`${origin}${chatPath(base)}`, { waitUntil: "load", timeout: 30000 });
  // The menu is closed, so its links are attached and not yet visible.
  await page.waitForSelector("#pages-menu a", { state: "attached", timeout: 30000 });
  return page;
}

/** The menu's entries, as the tab reads them. */
async function menuLabels(page: Page): Promise<string[]> {
  await page.click("#pages-toggle");
  await page.waitForFunction(() => document.getElementById("pages-menu")?.classList.contains("open") === true, undefined, {
    timeout: 10000,
  });
  return page.evaluate(() =>
    [...document.querySelectorAll("#pages-menu a")].map((each) => (each.textContent ?? "").trim()),
  );
}

it("opens the PRs page in a new tab, under the mount it was served at", async () => {
  const server = await boot({ enabled: true, basePath: "" });
  try {
    const page = await openChatPage(server.origin, "");
    expect(await menuLabels(page)).toEqual(["Reports", "Usage", "Chats", "PRs"]);

    const opened = page.waitForEvent("popup", { timeout: 30000 });
    await page.click("#pages-menu a:last-child");
    const popup = await opened;
    await popup.waitForLoadState("load", { timeout: 30000 });
    // The address the new tab really landed on, which is the page the link names.
    expect(popup.url()).toBe(`${server.origin}/github/pr/`);
    // And the menu is gone on the chat tab behind it.
    await page.waitForFunction(
      () => document.getElementById("pages-menu")?.classList.contains("open") === false,
      undefined,
      { timeout: CLOSED_TIMEOUT_MS },
    );

    await popup.close();
    await page.close();
  } finally {
    await server.close();
  }
}, 180000);

it("keeps the mount prefix on the PRs link at basePath /sec", async () => {
  const server = await boot({ enabled: true, basePath: "/sec" });
  try {
    const page = await openChatPage(server.origin, "/sec");
    expect(await menuLabels(page)).toEqual(["Reports", "Usage", "Chats", "PRs"]);

    const opened = page.waitForEvent("popup", { timeout: 30000 });
    await page.click("#pages-menu a:last-child");
    const popup = await opened;
    await popup.waitForLoadState("load", { timeout: 30000 });
    expect(popup.url()).toBe(`${server.origin}/sec/github/pr/`);
    // The three links of the row carry the same prefix, so the menu is one list.
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll("#pages-menu a")].map((each) => each.getAttribute("href")),
    );
    expect(hrefs).toEqual(["/sec/report", "/sec/usage", "/sec/chats", "/sec/github/pr/"]);

    await popup.close();
    await page.close();
  } finally {
    await server.close();
  }
}, 180000);

it("draws three entries and no PRs while github-pr is off", async () => {
  const server = await boot({ enabled: false, basePath: "" });
  try {
    const page = await openChatPage(server.origin, "");
    expect(await menuLabels(page)).toEqual(["Reports", "Usage", "Chats"]);
    // The block is there and empty, which is what "no page to offer" looks like.
    const block = await page.evaluate(() => document.getElementById("pages-links")?.textContent ?? null);
    expect(block).toBe("[]");
    await page.close();
  } finally {
    await server.close();
  }
}, 180000);
