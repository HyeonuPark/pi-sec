/**
 * The pull request dashboard in a real browser: the list, one pull request, and
 * its diff, opened in Chromium against a server this file boots with a fake `gh`.
 *
 * `test/ui/github-pr-*.test.ts` draws the same pages in jsdom from the built test
 * bundles. What only a browser can answer is what this file asks:
 *
 * - Does each page load clean? A page error, a request that failed, a response
 *   with a 4xx or 5xx, a `securitypolicyviolation` event and a console line that
 *   names the policy are all counted before the first script runs, the same way
 *   `pages-load.browser.ts` counts them. The page must have drawn what it exists
 *   to draw before it is judged, because a reporter that answered 200 with a page
 *   stuck on "Loading…" is not healthy.
 * - Does a press on the page work where the script under jsdom could not be sure?
 *   jsdom has no layout, no scrolling and no `scrollIntoView`: a press on a
 *   folded stretch, a press on a file in the tree, and an address with
 *   `#thread-<id>` are three presses that jsdom cannot prove.
 * - Does reading write nothing? The write switch is off in a real install until
 *   the operator turns it on, and this file turns it on, because a page with the
 *   write controls drawn is the page a reader sees after that decision. The
 *   presses here are read-only presses, so the count of POST requests must be 0.
 *
 * The server is the real one, with the extension's own options
 * (`ServerOptions.extensionRoutes["github-pr"]`): the fake `gh` from
 * `test/fixtures/github-pr`, a temporary `gh-repo` root, and a local git
 * repository as the remote, so the diff is computed from real git history. No
 * test here starts a real `gh` and none reaches GitHub.
 *
 * `GITHUB_PR_SHOTS_DIR` is not a condition of this file. When it is set, each page
 * writes one PNG into that directory after it is drawn, which is the picture the
 * result report shows; when it is not set, no file is written.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { fakeGhFixture, type FakeGhFixture } from "../github-pr/fake-gh-helpers.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";

// Same library prefix and launch args as the other browser tests: Chromium needs
// X11/atk/gbm libraries that a minimal Linux image may not ship, and it may have no GPU.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];

/** A timer queue that never fires: the boot cycle of the poll is the only one run. */
const NEVER_FIRE = {
  set: (): unknown => Symbol("never"),
  clear: (): void => {
    /* nothing is ever scheduled */
  },
};

/** The configured repository, spelled the way the fake `gh` answers for. */
const REPO = "acme/widgets";
/** The pull request the fake `gh` has an answer for, and the local repository too. */
const NUMBER = 10;

/** Where the page pictures go, when the run asked for them. */
const SHOTS_DIR = process.env["GITHUB_PR_SHOTS_DIR"] ?? "";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let gh: FakeGhFixture | undefined;
let origin = "";
let draftsDir = "";

/** Every request each page sent with a method other than GET or HEAD, in order. */
const writes: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One `git` call in a scratch repository, with an identity a bare commit needs. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * A local repository standing in for GitHub: `main` with two files, and a
 * `feature` branch whose change leaves a stretch of more than thirty folded lines
 * before it, which is what gives the diff page its stepped expand buttons.
 */
let featureSha = "";

/** Temporary roots this file made, removed when the file ends. */
const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function makeRemote(): Promise<string> {
  const path = await tempRoot("gh-pr-browser-origin-");
  git(path, ["init", "--quiet", "-b", "main", "."]);
  await mkdir(join(path, "src"), { recursive: true });
  const cache = Array.from({ length: 60 }, (_unused, index) => `export const value${index + 1} = ${index + 1};`);
  await writeFile(join(path, "src", "cache.ts"), `${cache.join("\n")}\n`, "utf8");
  await writeFile(join(path, "src", "index.ts"), "export function main(): void {\n  run();\n}\n", "utf8");
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "base"]);

  git(path, ["checkout", "--quiet", "-b", "feature"]);
  const changed = [...cache];
  changed[39] = "export const value40 = 400;";
  await writeFile(join(path, "src", "cache.ts"), `${changed.join("\n")}\n`, "utf8");
  const added = Array.from({ length: 80 }, (_unused, index) => `  step${index + 1}();`);
  await writeFile(
    join(path, "src", "index.ts"),
    `export function main(): void {\n  run();\n${added.join("\n")}\n  report();\n}\n`,
    "utf8",
  );
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "change"]);
  const head = git(path, ["rev-parse", "HEAD"]).trim();
  featureSha = head;
  // A pull request ref exists on GitHub only, so the local stand-in names one too.
  git(path, ["update-ref", `refs/pull/${NUMBER}/head`, head]);
  git(path, ["checkout", "--quiet", "main"]);
  return path;
}

beforeAll(async () => {
  const remote = await makeRemote();
  const repoRoot = await tempRoot("gh-repo-browser-");
  // The drafts directory is this test's own, and one saved review is in it before
  // the server starts, as if an earlier session had left it.
  draftsDir = await tempRoot("gh-drafts-browser-");
  await writeFile(
    join(draftsDir, `${REPO.replace("/", "+")}+${NUMBER}.json`),
    JSON.stringify({
      version: 1,
      repo: REPO,
      number: NUMBER,
      listed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: "saved overall comment",
      event: "COMMENT",
      comments: [
        {
          id: "saved-in-a-fold",
          path: "src/cache.ts",
          side: "RIGHT",
          line: 10,
          startLine: null,
          body: "this line sits in a folded stretch",
          headSha: "",
          anchor: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "saved-second",
          path: "src/index.ts",
          side: "RIGHT",
          line: 2,
          startLine: null,
          body: "second saved comment",
          headSha: "",
          anchor: null,
          createdAt: new Date().toISOString(),
        },
      ],
    }),
    "utf8",
  );
  gh = await fakeGhFixture();
  roots.push(dirname(gh.logFile));

  harness = await createTestHarness({
    config: {
      server: { ...defaultConfig().server, port: 0 },
      agent: { ...defaultConfig().agent, extensions: { enabled: ["github-pr"] } },
      // The write switch is on, so every write control is drawn: the page a
      // reader sees after the operator turns writes on. The presses this file
      // makes are read-only, and the POST count at the end proves it.
      githubPr: { writes: true, repos: [REPO] },
    },
  });

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
  started = await startServer(deps, {
    webDir: builtWebDir(),
    extensionRoutes: {
      "github-pr": {
        ghPath: gh.clientOptions.ghPath,
        ghEnv: gh.clientOptions.env ?? {},
        repoRoot,
        draftsDir,
        remoteUrl: () => remote,
        timers: NEVER_FIRE,
      },
    },
  });
  origin = started.origin;

  // The boot poll reads the list once by itself; waiting for the answer here makes
  // the first page open a page that already has its list, which is the state a
  // reader opens.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${origin}/api/github/pr/list`);
    if (response.ok) break;
    await wait(100);
  }

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
}, 120000);

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  context = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 60000);

function currentContext(): BrowserContext {
  if (context === undefined) throw new Error("chromium is not running");
  return context;
}

/** Everything one page said about itself while it loaded. */
interface LoadFacts {
  readonly status: number | undefined;
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  readonly errorResponses: readonly string[];
  readonly violations: readonly string[];
  readonly consoleLines: readonly string[];
}

/** Open one page with every watcher installed before the first script runs. */
async function openPage(path: string): Promise<{ page: Page; facts: () => Promise<LoadFacts> }> {
  const page = await currentContext().newPage();
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const errorResponses: string[] = [];
  const consoleLines: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
  });
  page.on("request", (request) => {
    const method = request.method().toUpperCase();
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  await page.addInitScript(() => {
    const probe = window as unknown as { __csp?: string[] };
    probe.__csp = [];
    document.addEventListener(
      "securitypolicyviolation",
      (event) => probe.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`),
      true,
    );
  });

  const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30000 });
  return {
    page,
    facts: async () => {
      // Two frames after the last thing drawn, so a script that fails right after
      // its first draw is still counted.
      await wait(300);
      const violations = (await page.evaluate(
        () => (window as unknown as { __csp?: string[] }).__csp ?? [],
      )) as string[];
      return { status: response?.status(), pageErrors, failedRequests, errorResponses, violations, consoleLines };
    },
  };
}

/** The console lines that report a policy refusal, which are the ones that matter here. */
function cspConsoleLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("Content Security Policy") || line.includes("CSP"));
}

/** Every condition, in one place, so each page is judged by the same five. */
function expectClean(facts: LoadFacts, path: string): void {
  expect(facts.status, `${path} answered ${facts.status}`).toBe(200);
  expect(facts.pageErrors, `${path} threw`).toEqual([]);
  expect(facts.failedRequests, `${path} asked for a file it did not get`).toEqual([]);
  expect(facts.errorResponses, `${path} was answered with an error`).toEqual([]);
  expect(facts.violations, `${path} was refused by its own policy`).toEqual([]);
  expect(cspConsoleLines(facts.consoleLines), `${path} reported a policy refusal`).toEqual([]);
}

/** Save one page picture, when the run asked for pictures. */
async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === "") return;
  await mkdir(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: false });
}

it("opens the list page and draws its five sections and a pull request row", async () => {
  const { page, facts } = await openPage("/github/pr/");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#view .section").length === 5 &&
      document.querySelectorAll("#view .section-header").length === 5 &&
      document.querySelectorAll("#view .pr-row").length >= 1,
    undefined,
    { timeout: 30000 },
  );
  // The row that says what waits on the reader is a link to its own page.
  const firstRow = await page.evaluate(() => {
    const row = document.querySelector("#view .pr-row");
    return { href: row?.getAttribute("href") ?? "", title: row?.querySelector(".pr-title")?.textContent ?? "" };
  });
  expect(firstRow.href).not.toBe("");
  expect(firstRow.title).not.toBe("");
  await shoot(page, "list");
  expectClean(await facts(), "/github/pr/");
  await page.close();
}, 60000);

it("opens a pull request at a thread anchor, unfolds that thread, and marks it as the target", async () => {
  // `PRRT_2` is a resolved thread, and the fixture draws a resolved thread folded.
  // An address that names it must open it, which is the whole point of the anchor.
  const { page, facts } = await openPage(`/github/pr/${REPO}/${NUMBER}#thread-PRRT_2`);
  await page.waitForFunction(
    () => (document.querySelector("#view .dash-title")?.textContent ?? "").includes("Add widget cache"),
    undefined,
    { timeout: 30000 },
  );
  await page.waitForSelector("#thread-PRRT_2.thread-target", { state: "attached", timeout: 30000 });
  const thread = await page.evaluate(() => {
    const card = document.getElementById("thread-PRRT_2");
    const inner = card?.querySelector(".thread-inner");
    const box = card?.getBoundingClientRect();
    return {
      targeted: card?.classList.contains("thread-target") ?? false,
      open: inner !== null && inner !== undefined && !inner.classList.contains("hidden"),
      toggle: card?.querySelector(".thread-toggle")?.textContent ?? "",
      threads: document.querySelectorAll("#view .thread-card").length,
      // Where the card really is on screen, which is the half of the anchor that
      // jsdom cannot answer: `scrollIntoView` moves a real viewport or nothing.
      inView: box !== undefined && box.top >= 0 && box.top < window.innerHeight,
    };
  });
  expect(thread.targeted).toBe(true);
  expect(thread.open).toBe(true);
  expect(thread.toggle).toContain("Hide resolved thread");
  expect(thread.threads).toBeGreaterThanOrEqual(2);
  expect(thread.inView).toBe(true);
  await shoot(page, "pr");
  expectClean(await facts(), `/github/pr/${REPO}/${NUMBER}`);
  await page.close();
}, 60000);

it("opens the diff page, expands a folded stretch, and moves to a file from the tree", async () => {
  const { page, facts } = await openPage(`/github/pr/${REPO}/${NUMBER}/diff`);
  await page.waitForFunction(
    () => document.querySelectorAll("#view .file-diff").length >= 2 && document.querySelectorAll(".tree-file").length >= 2,
    undefined,
    { timeout: 30000 },
  );
  // The code itself must be drawn, not only the file box: a highlighted line is a
  // `.code-html` span inside a code cell.
  const drawn = await page.evaluate(() => ({
    files: [...document.querySelectorAll("#view .file-diff")].map((element) => element.getAttribute("data-path") ?? ""),
    tree: [...document.querySelectorAll(".tree-file")].map((element) => element.getAttribute("data-idx") ?? ""),
    code: document.querySelectorAll("#view .split-grid .code-html").length,
    numbers: document.querySelectorAll("#file-0 .split-grid .num").length,
    gaps: document.querySelectorAll("#file-0 .expand-row").length,
  }));
  expect(drawn.files).toEqual(["src/cache.ts", "src/index.ts"]);
  expect(drawn.tree).toEqual(["0", "1"]);
  expect(drawn.code).toBeGreaterThan(0);
  // One hunk of `-U3` in the middle of a 60-line file leaves two folded stretches,
  // the lines before the change and the lines after it.
  expect(drawn.gaps).toBe(2);

  // The change sits 39 lines into the file, so the stretch above it is longer than
  // one reveal step and the row offers the whole stretch as well.
  await page.waitForSelector('#file-0 .expand-row .exp[data-act="all"]', { state: "attached", timeout: 30000 });
  await page.click('#file-0 .expand-row .exp[data-act="all"]');
  await page.waitForFunction(
    (before) => document.querySelectorAll("#file-0 .split-grid .num").length > before,
    drawn.numbers,
    { timeout: 30000 },
  );
  const expanded = await page.evaluate(() => ({
    numbers: document.querySelectorAll("#file-0 .split-grid .num").length,
    gaps: document.querySelectorAll("#file-0 .expand-row").length,
  }));
  // The stretch the press opened is gone, the other one is still folded, and the
  // lines it revealed are in the pane: one number per side per row.
  expect(expanded.numbers).toBeGreaterThan(drawn.numbers);
  expect(expanded.gaps).toBe(drawn.gaps - 1);

  // The tree: a press on the second file's row puts that file at the top of the
  // panes and marks its row, which are the two halves of "move to that file".
  const beforePress = await page.evaluate(
    () => (document.querySelector(".diff-content") as HTMLElement | null)?.scrollTop ?? 0,
  );
  await page.click('.tree-file[data-idx="1"]');
  await page.waitForSelector('.tree-file.active[data-idx="1"]', { state: "attached", timeout: 30000 });
  const after = await page.evaluate(() => {
    const content = document.querySelector(".diff-content") as HTMLElement | null;
    const file = document.getElementById("file-1");
    return {
      scrollTop: content?.scrollTop ?? 0,
      reached: file !== null && content !== null ? file.offsetTop - content.offsetTop : -1,
      active: [...document.querySelectorAll(".tree-file")].map((element) => ({
        index: element.getAttribute("data-idx") ?? "",
        active: element.classList.contains("active"),
      })),
    };
  });
  // Exactly one row is marked, and it is the one that was pressed.
  expect(after.active.filter((row) => row.active).map((row) => row.index)).toEqual(["1"]);
  // The panes scrolled down to that file's own top, which is what the press is
  // for: a marked row without the file in view would mark the wrong thing.
  expect(after.scrollTop).toBeGreaterThan(beforePress);
  expect(Math.abs(after.scrollTop - after.reached)).toBeLessThanOrEqual(8);

  await shoot(page, "diff");
  expectClean(await facts(), `/github/pr/${REPO}/${NUMBER}/diff`);
  await page.close();
}, 60000);

it("folds the CI status panel on a press, and lists the commits with links to their diff", async () => {
  const { page, facts } = await openPage(`/github/pr/${REPO}/${NUMBER}`);
  await page.waitForSelector(".dash-side .side-fold", { timeout: 30000 });
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll("#side-ci .check-row").length,
    visible: (document.querySelector("#side-ci") as HTMLElement | null)?.offsetHeight ?? 0,
    commits: [...document.querySelectorAll("#side-commits .commit-row")].map((row) => row.getAttribute("href") ?? ""),
  }));
  expect(before.rows).toBeGreaterThan(0);
  expect(before.visible).toBeGreaterThan(0);
  expect(before.commits.length).toBeGreaterThan(0);
  expect(before.commits[0]).toContain(`/github/pr/${REPO}/${NUMBER}/commits/`);
  await shoot(page, "pr-commits");
  await page.click('.side-fold[aria-controls="side-ci"]');
  const after = await page.evaluate(() => ({
    expanded: document.querySelector('.side-fold[aria-controls="side-ci"]')?.getAttribute("aria-expanded"),
    visible: (document.querySelector("#side-ci") as HTMLElement | null)?.offsetHeight ?? -1,
    mark: document.querySelector('.side-fold[aria-controls="side-ci"]')?.parentElement?.textContent ?? "",
  }));
  expect(after.expanded).toBe("false");
  expect(after.visible).toBe(0);
  expect(after.mark.length).toBeGreaterThan("▸ CI status".length - 1);
  await shoot(page, "pr-ci-folded");
  expectClean(await facts(), `/github/pr/${REPO}/${NUMBER}`);
  await page.close();
}, 60000);

it("opens the diff page of one commit, with its header and files and no review control", async () => {
  const path = `/github/pr/${REPO}/${NUMBER}/commits/${featureSha}`;
  const { page, facts } = await openPage(path);
  await page.waitForFunction(
    () => document.querySelectorAll("#view .file-diff").length >= 2 && document.querySelectorAll(".tree-file").length >= 2,
    undefined,
    { timeout: 30000 },
  );
  const seen = await page.evaluate(() => ({
    title: document.querySelector(".diff-head-title")?.textContent ?? "",
    line: document.querySelector(".diff-head .muted")?.textContent ?? "",
    review: document.querySelectorAll(".review-bar, .review-form, textarea").length,
  }));
  expect(seen.title).toBe("change");
  expect(seen.line).toContain(`commit ${featureSha.slice(0, 10)}`);
  expect(seen.review).toBe(0);
  await shoot(page, "commit-diff");
  expectClean(await facts(), path);
  await page.close();
}, 60000);

it("lists a saved review in the panel, and a press or the Enter key brings its comment into view, focused and marked", async () => {
  const { page, facts } = await openPage(`/github/pr/${REPO}/${NUMBER}/diff`);
  await page.waitForFunction(() => document.querySelectorAll("#view .file-diff").length >= 2, undefined, { timeout: 30000 });
  await page.click(".review-bar-btn");
  await page.waitForSelector(".review-link", { state: "attached", timeout: 30000 });
  const links = await page.evaluate(() => [...document.querySelectorAll(".review-link")].map((e) => e.textContent ?? ""));
  expect(links).toEqual([
    "src/cache.ts new 10 this line sits in a folded stretch",
    "src/index.ts new 2 second saved comment",
  ]);
  expect(await page.inputValue(".review-summary")).toBe("saved overall comment");

  const state = (): Promise<{ inView: boolean; focused: boolean; marked: boolean; folded: boolean }> =>
    page.evaluate(() => {
      const row = document.querySelector('[data-pending-id="saved-in-a-fold"]') as HTMLElement | null;
      const box = row?.getBoundingClientRect();
      return {
        inView: box !== undefined && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight,
        focused: document.activeElement === row,
        marked: row?.classList.contains("pending-target") ?? false,
        folded: document.getElementById("file-0")?.classList.contains("collapsed") ?? false,
      };
    });

  // A press on the link: the file was folded, the line is inside a folded stretch.
  await page.click("#file-0 .file-collapse");
  await page.evaluate(() => {
    const content = document.querySelector(".diff-content") as HTMLElement;
    content.scrollTop = content.scrollHeight;
  });
  expect((await state()).folded).toBe(true);
  await page.click('[data-link-id="saved-in-a-fold"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-pending-id") === "saved-in-a-fold", undefined, { timeout: 30000 });
  const afterPress = await state();
  expect(afterPress).toEqual({ inView: true, focused: true, marked: true, folded: false });

  // The Enter key on a focused link does the same.
  await page.evaluate(() => {
    const content = document.querySelector(".diff-content") as HTMLElement;
    content.scrollTop = content.scrollHeight;
    (document.activeElement as HTMLElement).blur();
  });
  expect((await state()).inView).toBe(false);
  await page.focus('[data-link-id="saved-in-a-fold"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-pending-id") === "saved-in-a-fold", undefined, { timeout: 30000 });
  expect(await state()).toEqual({ inView: true, focused: true, marked: true, folded: false });
  await shoot(page, "diff-review-links");
  expectClean(await facts(), `/github/pr/${REPO}/${NUMBER}/diff`);
  await page.close();
}, 60000);

it("sent no write while the three pages were read", async () => {
  // The switch was on, so every write control was drawn. A page that sends one
  // when it is only being read would have reached the fake `gh` and failed the
  // page, and the log would show it. Both halves are read here: what the pages
  // sent to the server, and what the server sent on to `gh`.
  expect(writes).toEqual([]);
  const fixture = gh;
  if (fixture === undefined) throw new Error("the fake gh is not set up");
  const calls = await fixture.calls();
  expect(calls.length).toBeGreaterThan(0);
  const mutations = calls.filter((entry) => /\bmutation\b/i.test(entry.args.join(" ")));
  expect(mutations.map((entry) => entry.args.join(" ").slice(0, 120))).toEqual([]);
}, 60000);
