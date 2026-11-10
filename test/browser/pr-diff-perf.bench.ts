/**
 * Timing of the PR diff page (/github/pr/<repo>/<n>/diff) on a large diff, in a real Chromium.
 * Read-only measurement: nothing in src/ is touched. The server, the fake `gh` and the local
 * git remote are the ones of github-pr.browser.ts. Nothing reaches GitHub.
 *
 * Environment
 *   BENCH_OUT   directory for results.json / profiles (default: <repo>/../bench)
 *   BENCH_REPS  timed rounds (default 3). One more round is run with the CDP profiler on.
 *   BENCH_WEB   directory of the built web files for the timed rounds (default dist/web)
 *   BENCH_WEB_PROFILE  web directory for the profiled round (default: BENCH_WEB)
 *   BENCH_NO_PROFILE=1   skip the profiled round
 *   BENCH_DRAG_LINES    lines of the drag (default 30, at most 30)
 *   BENCH_KEYS          keys typed in the line comment box (default 50, at most 54)
 *   BENCH_SUMMARY_KEYS  keys typed in the overall comment (default 10, at most 10)
 *   BENCH_STEP_CAP_MS   an action stops and is marked failed when one step takes longer (default: no cap)
 * Not part of `npm test` or `npm run test:browser`: it has no .test or .browser name.
 *
 * Run (see bench/run.sh): npx vitest --run --config test/browser/pr-diff-perf.vitest.config.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import { AdminNotes } from "../../src/runtime/notes.ts";
import { SseHub } from "../../src/server/sse.ts";
import { StreamHub } from "../../src/server/streams.ts";
import { startServer, type StartedServer } from "../../src/server/server.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { fakeGhFixture, type FakeGhFixture } from "../github-pr/fake-gh-helpers.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";

const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}
const LAUNCH_ARGS = ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"];
const NEVER_FIRE = { set: (): unknown => Symbol("never"), clear: (): void => {} };
const REPO = "acme/widgets";
const NUMBER = 10;
const REPS = Number(process.env["BENCH_REPS"] ?? "3");
const OUT = process.env["BENCH_OUT"] ?? resolve(process.cwd(), "../bench");
const BIG = "src/a-big.ts";
const SMALL_FILES = 20;
const QUICK = process.env["BENCH_QUICK"] === "1";
/** Knobs for a shorter run. Defaults keep the full measurement. */
const NO_PROFILE = process.env["BENCH_NO_PROFILE"] === "1";
const DRAG_LINES = Math.min(30, Number(process.env["BENCH_DRAG_LINES"] ?? "30"));
const KEYS = Math.min(54, Number(process.env["BENCH_KEYS"] ?? "50"));
const SUMMARY_KEYS = Math.min(10, Number(process.env["BENCH_SUMMARY_KEYS"] ?? "10"));
/** When one step takes longer than this (ms), the action stops and is marked failed. 0 means no cap. */
const STEP_CAP_MS = Number(process.env["BENCH_STEP_CAP_MS"] ?? "0");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 1 << 28,
  });
}

/* ------------------------------------------------------------ the big diff */

/** One base line. The text varies so the highlighter has strings, numbers, calls and keywords to colour. */
function baseLine(file: number, i: number): string {
  const k = i % 5;
  if (k === 0) return `export function fn${file}_${i}(a: number, b: string): string { return b + String(a * ${i}); }`;
  if (k === 1) return `  const value${i} = compute(${i}, "item-${file}-${i}", options.flag${i % 7}) + ${i};`;
  if (k === 2) return `  if (state.count${i % 9} > ${i} && state.name === "n${i}") { counters.push(${i}); }`;
  if (k === 3) return `  // note ${i}: keep this in sync with the table of ${file}`;
  return `  return items${i % 4}.map((item) => item.id + ${i}).filter(Boolean).join(",");`;
}
/** A changed form of the line: only part of the text differs, so the page draws an emphasis range. */
function partlyChanged(line: string): string {
  return line.replace(/\d+/, (m) => String(Number(m) + 1)).replace("item", "entry");
}

/** `blocks` blocks of 50 base lines; each block changes 45 diff lines and keeps 20 lines as context. */
function makeFile(file: number, blocks: number): { base: string; head: string; changed: number } {
  const base: string[] = [];
  const head: string[] = [];
  let changed = 0;
  let n = 0;
  for (let b = 0; b < blocks; b += 1) {
    for (let j = 0; j < 50; j += 1) {
      const line = baseLine(file, n);
      n += 1;
      base.push(line);
      if (j < 15) { head.push(partlyChanged(line)); changed += 2; }       // 15 partly changed: 1 del + 1 add
      else if (j < 20) { changed += 1; }                                   // 5 deleted
      else if (j < 30) { head.push(line); head.push(`  added(${n}, "extra-${file}-${n}");`); changed += 1; } // 10 added
      else head.push(line);                                                // 20 unchanged
    }
  }
  return { base: `${base.join("\n")}\n`, head: `${head.join("\n")}\n`, changed };
}

interface Facts { bigChanged: number; smallChanged: number[]; totalChanged: number; files: number }
const facts: Facts = { bigChanged: 0, smallChanged: [], totalChanged: 0, files: 0 };

async function makeRemote(): Promise<string> {
  facts.bigChanged = 0; facts.smallChanged = []; facts.totalChanged = 0;
  const path = await mkdtemp(join(tmpdir(), "gh-pr-bench-origin-"));
  git(path, ["init", "--quiet", "-b", "main", "."]);
  await mkdir(join(path, "src"), { recursive: true });
  const specs: { name: string; blocks: number; idx: number }[] = [{ name: BIG, blocks: Number(process.env["BENCH_BIG_BLOCKS"] ?? "67"), idx: 0 }];
  for (let f = 1; f <= SMALL_FILES; f += 1) specs.push({ name: `src/f${String(f).padStart(2, "0")}.ts`, blocks: 2 + (f % 2), idx: f });
  const heads: { name: string; head: string }[] = [];
  for (const s of specs) {
    const made = makeFile(s.idx, s.blocks);
    await writeFile(join(path, s.name), made.base, "utf8");
    heads.push({ name: s.name, head: made.head });
    if (s.idx === 0) facts.bigChanged = made.changed; else facts.smallChanged.push(made.changed);
    facts.totalChanged += made.changed;
  }
  facts.files = specs.length;
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "base"]);
  git(path, ["checkout", "--quiet", "-b", "feature"]);
  for (const h of heads) await writeFile(join(path, h.name), h.head, "utf8");
  git(path, ["add", "--all"]);
  git(path, ["commit", "--quiet", "-m", "change"]);
  const head = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["update-ref", `refs/pull/${NUMBER}/head`, head]);
  git(path, ["checkout", "--quiet", "main"]);
  return path;
}

/** A copy of the shared fake gh answers whose review threads sit on the big file. */
async function makeResponses(): Promise<string> {
  const src = resolve(process.cwd(), "test/fixtures/github-pr/responses");
  const dir = await mkdtemp(join(tmpdir(), "gh-pr-bench-responses-"));
  await cp(src, dir, { recursive: true });
  const file = join(dir, "pr-detail.json");
  const text = await readFile(file, "utf8");
  const detail = JSON.parse(text);
  const find = (o: any): any => {
    if (o && typeof o === "object") {
      if (o.reviewThreads) return o;
      for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    }
    return undefined;
  };
  const holder = find(detail);
  const comment = (id: string, body: string) => ({
    id, author: { login: "example-other" }, body, createdAt: "2026-10-27T12:00:00Z",
    url: `https://github.example.com/acme/widgets/pull/10#discussion_${id}`, diffHunk: "@@ -1,3 +1,3 @@\n-old line\n+new line\n ctx", path: BIG, reactionGroups: [],
  });
  const nodes: any[] = [];
  // 12 live threads at spread-out lines on the new side (line numbers of the head file)
  for (let t = 0; t < 12; t += 1) {
    const line = 5 + t * 230;
    nodes.push({ id: `PRRT_big${t}`, isResolved: t % 4 === 3, viewerCanResolve: true, isOutdated: false, path: BIG, line, startLine: null,
      originalLine: line, originalStartLine: null, diffSide: "RIGHT", subjectType: "LINE", comments: { nodes: [comment(`PRRC_big${t}`, `thread ${t}`)] } });
  }
  // 3 outdated threads (a stale row with a foldable hunk) and one file thread
  for (let t = 0; t < 3; t += 1) {
    nodes.push({ id: `PRRT_old${t}`, isResolved: false, isOutdated: true, path: BIG, line: null, startLine: null, originalLine: 100 + t * 900,
      originalStartLine: null, diffSide: "RIGHT", subjectType: "LINE", comments: { nodes: [comment(`PRRC_old${t}`, `outdated ${t}`)] } });
  }
  nodes.push({ id: "PRRT_file0", isResolved: false, isOutdated: false, path: BIG, line: 1, startLine: null, originalLine: 1, originalStartLine: null,
    diffSide: "RIGHT", subjectType: "FILE", comments: { nodes: [comment("PRRC_file0", "about the whole file")] } });
  holder.reviewThreads = { nodes };
  await writeFile(file, JSON.stringify(detail), "utf8");
  return dir;
}

/* ------------------------------------------------------------------ server */

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let gh: FakeGhFixture | undefined;
let origin = "";

async function boot(webDir: string): Promise<void> {
  const remote = await makeRemote();
  const repoRoot = await mkdtemp(join(tmpdir(), "gh-repo-bench-"));
  gh = await fakeGhFixture({ responsesDir: await makeResponses(), allowWrites: true });
  harness = await createTestHarness({
    config: {
      server: { ...defaultConfig().server, port: 0 },
      agent: { ...defaultConfig().agent, extensions: { enabled: ["github-pr"] } },
      githubPr: { writes: true, repos: [REPO] },
    },
  });
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: harness.runtime, bus: harness.events, sse,
    streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
    startedAt: Date.now(), version: "test", webDir, adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  started = await startServer(deps, {
    webDir,
    extensionRoutes: { "github-pr": { ghPath: gh.clientOptions.ghPath, ghEnv: gh.clientOptions.env ?? {}, repoRoot, remoteUrl: () => remote, timers: NEVER_FIRE } },
  });
  origin = started.origin;
  for (let a = 0; a < 100; a += 1) {
    if ((await fetch(`${origin}/api/github/pr/list`)).ok) break;
    await wait(100);
  }
}
async function shutdown(): Promise<void> {
  await started?.close(); started = undefined;
  await harness?.close(); harness = undefined;
}

/* --------------------------------------------------------------- measuring */

interface Step { ms: number; msFrame: number }
interface Rec { stN: number; stSum: number; stMax: number; steps: Step[]; totalMs: number; totalFrameMs: number; ltN: number; ltSum: number; ltMax: number; extra: Record<string, number | string>; error?: string }
interface Top { name: string; where: string; selfMs: number }
const results: Record<string, Rec[]> = {};
const profiles: Record<string, Top[]> = {};
const inclusive: Record<string, Top[]> = {};
const order: string[] = [];

const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const now = () => performance.now();

async function resetLt(page: Page): Promise<void> {
  await page.evaluate(() => { const b = (window as any).__b; if (b) { b.lt.length = 0; b.stalls.length = 0; b.obs.takeRecords(); } });
}
async function readLt(page: Page): Promise<{ n: number; sum: number; max: number; stN: number; stSum: number; stMax: number }> {
  return page.evaluate(() => {
    const b = (window as any).__b;
    for (const e of b.obs.takeRecords()) b.lt.push(e.duration);
    const lt: number[] = b.lt;
    const st: number[] = b.stalls;
    return { n: lt.length, sum: lt.reduce((a, c) => a + c, 0), max: lt.reduce((a, c) => Math.max(a, c), 0), stN: st.length, stSum: st.reduce((a, c) => a + c, 0), stMax: st.reduce((a, c) => Math.max(a, c), 0) };
  });
}
async function nodeCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("*").length);
}

function summarize(session: CDPSession | null) {
  return async (name: string, page: Page, fn: (step: (inner: () => Promise<void>) => Promise<void>, extra: Rec["extra"]) => Promise<void>) => {
    if (!order.includes(name)) order.push(name);
    const steps: Step[] = [];
    const extra: Rec["extra"] = {};
    let error: string | undefined;
    await resetLt(page);
    if (session !== null) await session.send("Profiler.start");
    const t0 = now();
    try {
      await fn(async (inner) => {
        const s0 = now();
        await inner();
        const s1 = now();
        await frames(page);
        const s2 = now();
        steps.push({ ms: s1 - s0, msFrame: s2 - s0 });
        if (STEP_CAP_MS > 0 && s2 - s0 > STEP_CAP_MS) throw new Error(`step cap: one step took ${(s2 - s0).toFixed(0)} ms, over ${STEP_CAP_MS} ms`);
      }, extra);
    } catch (e) {
      error = String((e as Error).message ?? e).split("\n")[0];
    }
    const t1 = now();
    await frames(page);
    const t2 = now();
    if (session !== null) {
      const { profile } = await session.send("Profiler.stop");
      profiles[name] = top(profile as any);
      inclusive[name] = topInclusive(profile as any);
    }
    const lt = await readLt(page);
    process.stderr.write(`[bench] ${name}: total ${(t1 - t0).toFixed(0)} ms, steps ${steps.length}${error ? ` ERROR ${error}` : ""}\n`);
    if (session === null) (results[name] ??= []).push({ stN: lt.stN, stSum: lt.stSum, stMax: lt.stMax, steps, totalMs: t1 - t0, totalFrameMs: t2 - t0, ltN: lt.n, ltSum: lt.sum, ltMax: lt.max, extra, ...(error ? { error } : {}) });
  };
}

/** Inclusive time of the functions that live in the page's own bundle, so a caller of a slow native call shows up. */
function topInclusive(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }): Top[] {
  const parent = new Map<number, number>();
  const byId = new Map<number, any>();
  for (const n of profile.nodes) { byId.set(n.id, n); for (const c of n.children ?? []) parent.set(c, n.id); }
  const acc = new Map<string, Top>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    const seen = new Set<string>();
    for (let id: number | undefined = profile.samples[i]; id !== undefined; id = parent.get(id)) {
      const cf = byId.get(id)?.callFrame;
      if (cf === undefined || !String(cf.url ?? "").includes("ui-github-pr-diff")) continue;
      const name = cf.functionName === "" ? "(anonymous)" : cf.functionName;
      const where = `ui-github-pr-diff.js:${cf.lineNumber + 1}`;
      const key = `${name}|${where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const e = acc.get(key) ?? { name, where, selfMs: 0 };
      e.selfMs += dt;
      acc.set(key, e);
    }
  }
  return [...acc.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 8);
}

function top(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }): Top[] {
  const byId = new Map<number, any>();
  for (const n of profile.nodes) byId.set(n.id, n);
  const acc = new Map<string, Top>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const node = byId.get(profile.samples[i]!);
    if (node === undefined) continue;
    const cf = node.callFrame;
    const fname = cf.functionName === "" ? "(anonymous)" : cf.functionName;
    if (fname === "(idle)") continue;
    const url = String(cf.url ?? "").split("/").pop() ?? "";
    const where = url === "" ? "" : `${url}:${cf.lineNumber + 1}`;
    const key = `${fname}|${where}`;
    const e = acc.get(key) ?? { name: fname, where, selfMs: 0 };
    e.selfMs += (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    acc.set(key, e);
  }
  return [...acc.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 10);
}

/* ------------------------------------------------------------------- scenario */

async function newPage(): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.addInitScript(() => {
    const b: any = { lt: [] as number[] };
    b.obs = new PerformanceObserver(() => {});
    try { b.obs.observe({ type: "longtask", buffered: true }); } catch { /* none */ }
    // Proxy for long tasks when the observer reports none: a 10 ms timer; a gap over 50 ms is a stall of (gap - 10) ms.
    b.stalls = [] as number[];
    let last = performance.now();
    setInterval(() => { const t = performance.now(); if (t - last > 50) b.stalls.push(t - last - 10); last = t; }, 10);
    (window as any).__b = b;
  });
  return page;
}

/** Press without the actionability waits: a page that is busy for seconds would time out the wait, not the action. */
const click = (page: Page, sel: string) => page.click(sel, { force: true });
const NUMS = (idx: number) => `#file-${idx} .pane-right .num[data-n]`;

async function scenario(page: Page, session: CDPSession | null, round: number): Promise<void> {
  const act = summarize(session);
  const content = ".diff-content";

  // 1 initial load
  await act("1 initial load (goto -> all 21 files drawn)", page, async (_step, extra) => {
    await page.goto(`${origin}/github/pr/${REPO}/${NUMBER}/diff`, { waitUntil: "commit" });
    await page.waitForFunction(
      (n) => document.querySelectorAll("#view .file-diff").length >= n && document.querySelector(`#file-${n - 1} .split-grid`) !== null,
      facts.files, { polling: "raf" });
    extra["dom nodes"] = await nodeCount(page);
    extra["code cells"] = await page.evaluate(() => document.querySelectorAll(".code-html").length);
    extra["thread marks"] = await page.evaluate(() => document.querySelectorAll(".line-bubble").length);
    extra["stale rows"] = await page.evaluate(() => document.querySelectorAll(".stale-row:not(.file-thread-row)").length);
    extra["file-thread rows"] = await page.evaluate(() => document.querySelectorAll(".file-thread-row").length);
    extra["rows file A"] = await page.evaluate(() => document.querySelectorAll("#file-0 .pane-right .num").length);
  });
  await wait(500);
  if (process.env["BENCH_STOP_AFTER_LOAD"]) { console.log("LOAD FACTS", JSON.stringify(results[order[0]!]![0]!.extra)); return; }

  // 8 hover over line numbers, no button down
  await page.evaluate(([sel]) => (document.querySelector(sel!) as HTMLElement).scrollIntoView({ block: "start" }), [NUMS(0)]);
  await frames(page);
  const boxes = await page.evaluate(([sel]) => [...document.querySelectorAll(sel!)].map((e) => {
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: Number((e as HTMLElement).dataset["n"]) };
  }).filter((b) => b.y > 150 && b.y < 960), [NUMS(0)]);
  const lineBoxes = boxes.slice(0, 32);
  await act("8 hover over 30 line numbers (no button down)", page, async (step) => {
    for (const b of lineBoxes.slice(0, 30)) await step(() => page.mouse.move(b.x, b.y));
  });

  // 2 drag: down on line 0, move 30 lines one by one, wiggle, release
  await act("2a drag: mousedown on a line number", page, async (step) => {
    await page.mouse.move(lineBoxes[0]!.x, lineBoxes[0]!.y);
    await step(() => page.mouse.down());
  });
  await act("2b drag: move down 30 lines, one line per move", page, async (step) => {
    for (const b of lineBoxes.slice(1, QUICK ? 4 : DRAG_LINES + 1)) await step(() => page.mouse.move(b.x, b.y));
  });
  await act("2c drag: 20 small moves inside one line number", page, async (step) => {
    const l = lineBoxes[Math.min(DRAG_LINES, lineBoxes.length - 1)]!;
    for (let i = 0; i < 20; i += 1) await step(() => page.mouse.move(l.x + (i % 2 === 0 ? 3 : -3), l.y + (i % 3) - 1));
  });
  await act("2d drag: mouseup -> comment box open", page, async (step) => {
    await step(async () => {
      await page.mouse.up();
      await page.waitForSelector(".review-form textarea", {});
    });
  });

  // 3 type 50 chars
  const text = "The quick brown fox jumps over the lazy dog again 1234";
  await act("3 comment box: type 50 characters (one key per step)", page, async (step) => {
    for (const ch of text.slice(0, KEYS)) await step(() => page.keyboard.type(ch));
  });

  // 4a cancel
  await act("4a comment box: Cancel", page, async (step) => {
    await step(async () => {
      await click(page, ".review-form .cancel-btn");
      await page.waitForSelector(".review-form", { state: "detached" });
    });
  });
  // quick single-line press, to open a box again (not measured here)
  const reopen = async () => {
    const b = lineBoxes[5]!;
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.up();
    await page.waitForSelector(".review-form textarea", {});
  };
  await reopen();
  await page.keyboard.type("a comment");
  await act("4b comment box: Add to review (collect)", page, async (step) => {
    await step(async () => {
      await click(page, ".review-form .submit-btn");
      await page.waitForSelector(".pending-row", {});
    });
  });
  // 4c open the review panel, type a summary, choose a verdict, submit (POST via the fake gh)
  await act("4c review panel: open", page, async (step) => {
    await step(async () => { await click(page, ".review-bar-btn"); await page.waitForSelector(".review-panel:not(.hidden)", {}); });
  });
  await act("4d review panel: type 10 characters in the overall comment", page, async (step) => {
    for (const ch of "Looks fine".slice(0, SUMMARY_KEYS)) await step(() => page.keyboard.type(ch));
  });
  await act("4e review panel: choose a verdict (radio)", page, async (step) => {
    await step(() => click(page, '.review-panel input[value="APPROVE"]'));
  });
  await act("4f review panel: Submit review (fake gh accepts the write)", page, async (step, extra) => {
    await step(async () => {
      await click(page, ".review-submit");
      await page.waitForSelector(".review-form-ok, #error:not(.hidden)", {});
    });
    extra["notice"] = await page.evaluate(() => document.querySelector(".review-form-ok")?.textContent ?? "(none)");
  });
  await click(page, ".review-bar-btn").catch(() => {});

  // 6 scroll top -> bottom
  await page.evaluate(() => { (document.querySelector(".diff-content") as HTMLElement).scrollTop = 0; });
  await frames(page);
  const scrollInfo = await page.evaluate(() => { const c = document.querySelector(".diff-content") as HTMLElement; return { h: c.scrollHeight, v: c.clientHeight }; });
  await page.mouse.move(800, 500);
  await act("6 scroll top to bottom with the wheel (400 px per step)", page, async (step, extra) => {
    await page.evaluate(() => {
      const b = (window as any).__b; b.gaps = []; let last = performance.now(); b.run = true;
      const loop = (t: number) => { b.gaps.push(t - last); last = t; if (b.run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    const stepsN = Math.min(Math.ceil((scrollInfo.h - scrollInfo.v) / 400), QUICK ? 8 : 400);
    for (let i = 0; i < stepsN; i += 1) await step(() => page.mouse.wheel(0, 400));
    const g = await page.evaluate(() => { const b = (window as any).__b; b.run = false; return b.gaps as number[]; });
    extra["scroll height px"] = scrollInfo.h;
    extra["frame gap max ms"] = Math.round(Math.max(...g));
    extra["frame gap p95 ms"] = Math.round([...g].sort((a, b) => a - b)[Math.floor(g.length * 0.95)] ?? 0);
    extra["frames"] = g.length;
  });
  await page.evaluate(() => { (document.querySelector(".diff-content") as HTMLElement).scrollTop = 0; });
  await frames(page);

  // 7 tree click
  await act("7 file tree: click a file (file 10)", page, async (step) => {
    await step(async () => { await click(page, '.tree-file[data-idx="10"]'); await page.waitForSelector('.tree-file.active[data-idx="10"]'); });
  });
  await act("7b file tree: click file A (back to the top)", page, async (step) => {
    await step(async () => { await click(page, '.tree-file[data-idx="0"]'); await page.waitForSelector('.tree-file.active[data-idx="0"]'); });
  });
  await act("7c file tree: fold and unfold the directory", page, async (step) => {
    if ((await page.$(".tree-dir")) === null) throw new Error("no directory row in the tree");
    await step(() => click(page, ".tree-dir"));
    await step(() => click(page, ".tree-dir"));
  });

  // 5 fold / unfold
  await page.evaluate(() => { (document.querySelector(".diff-content") as HTMLElement).scrollTop = 0; });
  await frames(page);
  const foldOf = (idx: number) => async (step: (f: () => Promise<void>) => Promise<void>) => {
    const sel = `#file-${idx} .file-collapse`;
    await step(async () => { await click(page, sel); await page.waitForSelector(`#file-${idx}.collapsed`); });
    await step(async () => { await click(page, sel); await page.waitForSelector(`#file-${idx}:not(.collapsed)`); });
  };
  await act("5a fold then unfold file A (3000 changed lines): 2 steps", page, async (step) => foldOf(0)(step));
  await page.evaluate(() => document.getElementById("file-1")!.scrollIntoView({ block: "start" }));
  await frames(page);
  await act("5b fold then unfold a small file: 2 steps", page, async (step) => foldOf(1)(step));

  // 10 more: expand gaps, stale threads, reload, sidebar
  await page.evaluate(() => { (document.querySelector(".diff-content") as HTMLElement).scrollTop = 0; });
  await frames(page);
  await act("10a expand a folded stretch in file A", page, async (step, extra) => {
    const before = await page.evaluate(() => document.querySelectorAll("#file-0 .expand-row").length);
    await step(async () => {
      await click(page, '#file-0 .expand-row .exp[data-act="all"]');
      await page.waitForFunction((n) => document.querySelectorAll("#file-0 .expand-row").length < n, before);
    });
  });
  await act("10b expand a folded stretch in a small file", page, async (step) => {
    await page.evaluate(() => document.getElementById("file-2")!.scrollIntoView({ block: "start" }));
    await frames(page);
    const before = await page.evaluate(() => document.querySelectorAll("#file-2 .expand-row").length);
    await step(async () => {
      await click(page, '#file-2 .expand-row .exp[data-act="all"]');
      await page.waitForFunction((n) => document.querySelectorAll("#file-2 .expand-row").length < n, before);
    });
  });
  await act("10c outdated thread: show then hide the original code", page, async (step) => {
    await page.evaluate(() => (document.querySelector("#file-0 .stale-toggle") as HTMLElement).scrollIntoView({ block: "center" }));
    await frames(page);
    await step(async () => { await page.dispatchEvent("#file-0 .stale-toggle", "click"); await page.waitForSelector("#file-0 .stale-hunk:not(.hidden)", { timeout: 120000 }); });
    await step(async () => { await page.dispatchEvent("#file-0 .stale-toggle", "click"); await page.waitForSelector("#file-0 .stale-hunk.hidden", { state: "attached", timeout: 120000 }); });
  });
  await act("10d Reload button (read the diff again and redraw)", page, async (step) => {
    await step(async () => {
      await click(page, 'button:has-text("Reload"), #reload');
      await wait(50);
      await page.waitForFunction(() => document.querySelector("#loading")?.classList.contains("hidden") ?? true, undefined, { polling: "raf" });
    });
  });

  // 9 resize
  await act("9 resize window 1600 -> 1000 px wide, then back", page, async (step) => {
    await step(() => page.setViewportSize({ width: 1000, height: 1000 }));
    await step(() => page.setViewportSize({ width: 1600, height: 1000 }));
  });

  // diag: the second hover/drag on a page that has grown (after expand) is not measured. DOM count at the end:
  await act("0 DOM nodes at the end of the round (no action)", page, async (_s, extra) => { extra["dom nodes"] = await nodeCount(page); });
  void round;
}

async function runRound(round: number, profile: boolean): Promise<void> {
  const page = await newPage();
  let session: CDPSession | null = null;
  if (profile) {
    session = await page.context().newCDPSession(page);
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 100 });
  }
  await scenario(page, session, round);
}

beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  await shutdown();
}, 60000);

it("measures the diff page", async () => {
  const web = process.env["BENCH_WEB"] ?? builtWebDir();
  const profileWeb = process.env["BENCH_WEB_PROFILE"] ?? web;
  const out: Record<string, unknown> = {};
  const phases: { web: string; profile: boolean; rounds: number }[] = [{ web, profile: false, rounds: REPS }];
  if (!NO_PROFILE) phases.push({ web: profileWeb, profile: true, rounds: 1 });
  const save = async () => {
    out["facts"] = facts; out["order"] = order; out["results"] = results; out["profiles"] = profiles; out["inclusive"] = inclusive; out["reps"] = REPS;
    await writeFile(join(OUT, "results.json"), JSON.stringify(out, null, 1), "utf8");
  };
  // A round that fails is logged and the next one runs, and the run fails at the end.
  const failed: string[] = [];
  for (const phase of phases) {
    await boot(phase.web);
    for (let r = 0; r < phase.rounds; r += 1) {
      // One Chromium per round: with --single-process, closing a context takes the browser down with it.
      browser = await chromium.launch({ args: LAUNCH_ARGS });
      process.stderr.write(`[bench] round ${r} profile=${phase.profile}\n`);
      await runRound(r, phase.profile).catch((e) => {
        const line = String(e).split("\n")[0];
        console.log("ROUND FAILED", line);
        failed.push(`round ${r} profile=${phase.profile}: ${line}`);
      });
      await browser.close().catch(() => {}); browser = undefined;
      await save();
    }
    await shutdown();
  }
  out["facts"] = facts;
  out["order"] = order;
  out["results"] = results;
  out["profiles"] = profiles;
  out["inclusive"] = inclusive;
  out["reps"] = REPS;
  await writeFile(join(OUT, "results.json"), JSON.stringify(out, null, 1), "utf8");
  if (failed.length > 0) throw new Error(`${failed.length} round(s) failed: ${failed.join("; ")}`);
}, 14_400_000);
