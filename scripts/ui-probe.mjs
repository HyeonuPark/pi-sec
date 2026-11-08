// A headless-browser probe for the web UI.
//
// jsdom is what `test/web-ui.test.ts` uses, and jsdom does not execute
// `<script type="module">`. That gap is how a page that renders nothing in a
// real browser passed its tests. This runs the real thing and prints only text:
// console output, page errors, failed requests, and what actually ended up in
// the DOM and the layout.
//
//   node scripts/ui-probe.mjs http://127.0.0.1:8787/<prefix>/report/plans
//   node scripts/ui-probe.mjs <url> --desktop
//   node scripts/ui-probe.mjs <url> --height 500
//   node scripts/ui-probe.mjs <url> --shot /tmp/page.png
//   node scripts/ui-probe.mjs <url> --click '#diff-toggle'
//   node scripts/ui-probe.mjs <url> --focused 42
//
// Mobile first: the narrow layout is the one that breaks, and it is the one a
// single screenshot cannot stand in for.
//
// The probe reads the UI and changes no server state. Every request the page
// makes that is not a GET, HEAD or OPTIONS is blocked before it leaves the
// browser, printed under "blocked writes", and turns the exit code to 1. That
// guard exists because this script once sent messages and an attachment into
// a live root conversation. A click that writes has to land in a
// focused chat (a session opened for tests), and `--focused <id>` is how the
// caller names it: writes to that conversation and attachment uploads pass, and
// nothing else does. The id is checked against the server before the browser
// starts, so the root conversation's id cannot be passed by mistake.
//
// Use the prefix the daemon serves: the page's `pi-sec-base` meta tag, or the
// path of `server.publicUrl`. A proxy either strips its prefix or the daemon
// does, so asset URLs and API calls resolve exactly as they do in production.

import { existsSync } from "node:fs";
import { chromium } from "playwright";

// Chromium needs X11/atk/gbm libraries that a minimal Linux image may not ship, and root
// may not be available to install them. They are unpacked from Fedora RPMs into a local
// prefix instead; point the dynamic linker at it before launching.
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
if (existsSync(BROWSER_LIBS)) {
  process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
}

const argv = process.argv.slice(2);

/** The argument after `--flag`, or -1 when the flag is not there. */
function valueIndex(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? -1 : index + 1;
}

// The value of a flag is not the URL, whatever order the two are given in.
const flagValues = new Set([
  valueIndex("--shot"),
  valueIndex("--height"),
  valueIndex("--click"),
  valueIndex("--focused"),
]);
const url = argv.find((arg, index) => !arg.startsWith("--") && !flagValues.has(index)) ?? null;
if (url === null) {
  console.error(
    "usage: node scripts/ui-probe.mjs <url> [--desktop] [--height <n>] [--shot <path>] [--click <selector>] [--focused <id>]",
  );
  process.exit(2);
}
// A view that only renders after a click (the diff toggle) has to be clicked
// before the DOM is read, or the probe measures the prose view instead.
const clickIndex = argv.indexOf("--click");
const clickSelector = clickIndex === -1 ? null : argv[clickIndex + 1];
const desktop = argv.includes("--desktop");
const shotIndex = argv.indexOf("--shot");
const shotPath = shotIndex === -1 ? null : argv[shotIndex + 1];
// The address bar and the keyboard are the two things that change this height,
// and 844 is the phone the layout was measured on. A short page is how the
// keyboard case is reproduced without one.
const heightIndex = argv.indexOf("--height");
const viewportHeight = heightIndex === -1 ? 844 : Number(argv[heightIndex + 1]);
if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
  console.error("--height takes a positive number of pixels");
  process.exit(2);
}

/**
 * The path prefix the page is mounted under, or "" for a daemon reached
 * directly.
 *
 * The prefix is the one the daemon serves: the page's `pi-sec-base` meta tag,
 * or the path of `server.publicUrl`. A proxy either strips its prefix or the
 * daemon does (README.md), so the probe can be given `<prefix>/basic-chat`, and
 * the API calls the page makes there are `<prefix>/api/...`. The prefix is
 * whatever comes before the first page path, and every path the write decision
 * compares is rebuilt with it. Self-contained because the test lifts this
 * function out of the file on its own.
 */
function prefixOf(url) {
  let text = String(url);
  try {
    text = new URL(text).pathname;
  } catch {
    const cut = text.search(/[?#]/);
    text = cut === -1 ? text : text.slice(0, cut);
  }
  const pagePaths = ["/basic-chat", "/chats", "/report"];
  let first = -1;
  for (const page of pagePaths) {
    const index = text.indexOf(page);
    if (index === -1) continue;
    const after = text.slice(index + page.length);
    // `/chatsomething` is not the `/chats` page, so the match has to end there.
    if (after !== "" && !after.startsWith("/")) continue;
    if (first === -1 || index < first) first = index;
  }
  return first === -1 ? "" : text.slice(0, first);
}

/**
 * Whether one request the page makes may reach the server: "pass" or "block".
 *
 * The reading methods pass. Everything else can change server state, so it is
 * blocked whatever path it names, and the caller reads it under "blocked
 * writes" instead of the daemon acting on it.
 *
 * `focusedId` is the one narrow exception: writes to that conversation, and an
 * upload, which is not conversation-scoped (`src/server/routes/attachments.ts`).
 * A write to another conversation id, to `/basic-chat/messages`, to
 * `/api/ui/call` or to an admin route is still blocked, and the id is compared
 * as a whole path segment so that 13 cannot open the door to 130.
 *
 * Pure and self-contained: the test lifts it out of the file, because importing
 * the probe launches its browser.
 */
function writeDecision({ method, url, prefix = "", focusedId = null }) {
  const verb = String(method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return "pass";
  let pathname = String(url);
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    const cut = pathname.search(/[?#]/);
    if (cut !== -1) pathname = pathname.slice(0, cut);
  }
  if (focusedId !== null && focusedId !== undefined) {
    const own = `${prefix}/api/conversations/${focusedId}`;
    if (pathname === own || pathname.startsWith(`${own}/`)) return "pass";
    if (verb === "POST" && pathname === `${prefix}/api/attachments`) return "pass";
  }
  return "block";
}

// Writes are the thing this tool must not do, so the one chat whose writes may
// pass is checked with the server before a browser exists. A wrong id, the root
// conversation's id, or an archived chat ends the run here: no page is loaded
// and no page request is made.
const focusedIndex = argv.indexOf("--focused");
const focusedId = focusedIndex === -1 ? null : Number(argv[focusedIndex + 1]);
if (focusedId !== null && (!Number.isInteger(focusedId) || focusedId <= 0)) {
  console.error("--focused takes a positive integer: the number of an open focused chat");
  process.exit(2);
}
const mountPrefix = prefixOf(url);
if (focusedId !== null) {
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  if (origin === null) {
    console.error(`--focused needs an absolute URL; ${url} has no origin`);
    process.exit(2);
  }
  // The script sets no extra headers on the browser context, so this check sends
  // none either: the daemon in front of the probe carries no authentication.
  const checkUrl = `${origin}${mountPrefix}/api/focused-chats/${focusedId}`;
  let refusal;
  try {
    const response = await fetch(checkUrl);
    if (response.status !== 200) {
      refusal = `answered ${response.status}`;
    } else {
      const body = await response.json().catch(() => null);
      if (body === null || typeof body !== "object") {
        refusal = "answered 200 with no focused chat in the body";
      } else if (body.archived !== false) {
        refusal = `answered 200 with archived: ${JSON.stringify(body.archived)}`;
      }
    }
  } catch (error) {
    refusal = `could not be reached: ${String(error)}`;
  }
  if (refusal !== undefined) {
    console.error(`--focused ${focusedId}: GET ${checkUrl} ${refusal}`);
    console.error("Only an open focused chat takes writes; the root conversation and archived chats do not.");
    process.exit(2);
  }
}

// A host may have no GPU, and then the GPU process cannot start at all
// (`gpu_data_manager_impl_private.cc: GPU process isn't usable`). `--single-process`
// keeps rendering on the CPU inside the browser process, which is all this needs.
const browser = await chromium.launch({
  args: ["--single-process", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
});
const context = await browser.newContext(
  desktop
    ? { viewport: { width: 1280, height: 900 } }
    : { viewport: { width: 390, height: viewportHeight }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
);
// Every request the page makes goes through this decision, so a click that
// writes cannot reach the daemon past the probe's back. Registration happens
// before the first navigation, because a request sent while the page loads would
// otherwise be missed.
const blockedWrites = [];
await context.route("**/*", async (route) => {
  const request = route.request();
  const decision = writeDecision({
    method: request.method(),
    url: request.url(),
    prefix: mountPrefix,
    focusedId,
  });
  if (decision === "pass") {
    await route.continue();
    return;
  }
  blockedWrites.push(`${request.method()} ${request.url()}`);
  await route.abort();
});

const page = await context.newPage();

const consoleLines = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
page.on("requestfailed", (request) => failedRequests.push(`${request.url()} — ${request.failure()?.errorText}`));

let status;
try {
  const response = await page.goto(url, { waitUntil: "load", timeout: 20000 });
  status = response?.status();
  // Give the module time to run its fetches and paint.
  await page.waitForTimeout(1500);
  if (clickSelector !== null) {
    await page.click(clickSelector);
    // The diff is fetched after the click; read the DOM only once it is there.
    await page.waitForTimeout(800);
  }
} catch (error) {
  console.log("NAVIGATION FAILED:", String(error));
}

const info = await page.evaluate(() => {
  const view = document.getElementById("view");
  const rect = view?.getBoundingClientRect();
  const style = view === null ? null : getComputedStyle(view);
  const header = document.querySelector(".app-header");
  // Where the shell put the two rows the viewer is built around: the bar at the
  // foot and the box that scrolls. They are the whole point of the layout, so a
  // probe that does not print them cannot say whether it holds.
  const box = (element) => {
    if (element === null) return null;
    const r = element.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      position: getComputedStyle(element).position,
    };
  };
  const noteBar = document.getElementById("note-bar");
  const scroll = document.querySelector(".report-scroll");
  const reload = document.getElementById("reload-list");
  return {
    title: document.title,
    viewChildElements: view?.childElementCount ?? -1,
    viewText: (view?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
    viewBox: rect === undefined ? null : { h: Math.round(rect.height), w: Math.round(rect.width), top: Math.round(rect.top) },
    viewDisplay: style?.display ?? null,
    viewOverflowY: style?.overflowY ?? null,
    headerHeight: header === null ? null : Math.round(header.getBoundingClientRect().height),
    bodyDisplay: getComputedStyle(document.body).display,
    bodyHeight: Math.round(document.body.getBoundingClientRect().height),
    noteBar: box(noteBar),
    reportScroll: scroll === null ? null : {
      box: box(scroll),
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrolls: scroll.scrollHeight > scroll.clientHeight,
    },
    reloadList: reload === null ? null : { box: box(reload), hidden: reload.classList.contains("hidden") },
    documentScrollHeight: document.documentElement.scrollHeight,
    windowInnerWidth: window.innerWidth,
    windowInnerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    canScroll: document.documentElement.scrollHeight > window.innerHeight,
    markdownitLoaded: typeof window.markdownit === "function",
    wideScanned: (() => {
      // How many elements the overflow walk below actually looked at. Without a
      // count, a run where the selector matched nothing and a run where every
      // matched element fits both print `(none)`, and the first one measured
      // nothing at all. Keep the selector identical to the walk's.
      return document.querySelectorAll("body *").length;
    })(),
    wideOffenders: (() => {
      // Anything wider than the viewport is a layout bug the eye would call
      // "broken": on a phone the right half simply is not on screen.
      const limit = document.documentElement.clientWidth + 1;
      const out = [];
      // `body *`, not `#view *`: only the report page has a `#view`, so a probe
      // scoped to it measured nothing on the app page and reported "no
      // overflow" from an empty list.
      for (const el of document.querySelectorAll("body *")) {
        const w = Math.round(el.getBoundingClientRect().width);
        if (w > limit) {
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className === "" ? null : String(el.className).slice(0, 30),
            width: w,
            scrollWidth: el.scrollWidth,
            overflowX: getComputedStyle(el).overflowX,
            text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
          });
        }
      }
      return out.slice(0, 12);
    })(),
    diffLineOffenders: (() => {
      // A wrapped diff line must fit its own box. One wider than its client
      // width still scrolls sideways, which is the thing this change removes.
      const out = [];
      for (const el of document.querySelectorAll(".diff-line")) {
        if (el.scrollWidth > el.clientWidth + 1) {
          out.push({
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
          });
        }
      }
      return out.slice(0, 12);
    })(),
  };
});

console.log("URL:", url);
console.log("viewport:", desktop ? "desktop 1280x900" : `mobile 390x${viewportHeight}`);
console.log("HTTP status:", status);
console.log("--- DOM ---");
for (const [key, value] of Object.entries(info)) {
  if (key === "wideOffenders" || key === "diffLineOffenders" || key === "wideScanned") continue;
  console.log(`  ${key}: ${JSON.stringify(value)}`);
}
/**
 * The overflow section, as text. The heading carries how many elements the
 * selector walked, because `(none)` alone cannot be read: a page where nothing
 * overflows and a selector that matched nothing print the same line, and only
 * the second one is a measurement that did not happen. The empty line says
 * which of the two it was.
 *
 * The test reads this function's text out of the file and calls it on its own,
 * because importing the probe launches its browser first.
 */
function formatWideSection(info) {
  const heading = `--- elements wider than the viewport (scanned ${info.wideScanned}) ---`;
  if (info.wideOffenders.length === 0) {
    const none =
      info.wideScanned === 0
        ? "  (none) the selector matched no element; the check measured nothing"
        : `  (none) all ${info.wideScanned} matched element(s) fit`;
    return `${heading}\n${none}`;
  }
  const offenders = info.wideOffenders.map(
    (el) =>
      `  <${el.tag}${el.cls === null ? "" : ` class="${el.cls}"`}> ${el.width}px (scroll ${el.scrollWidth}px, overflow-x ${el.overflowX}) :: ${el.text}`,
  );
  return `${heading}\n${offenders.join("\n")}`;
}

console.log(formatWideSection(info));
console.log("--- diff lines wider than their box ---");
console.log(
  info.diffLineOffenders.length === 0
    ? "  (none)"
    : info.diffLineOffenders
        .map((line) => `  scroll ${line.scrollWidth}px, client ${line.clientWidth}px :: ${line.text}`)
        .join("\n"),
);
console.log("--- console ---");
console.log(consoleLines.length === 0 ? "  (none)" : consoleLines.map((line) => `  ${line}`).join("\n"));
console.log("--- page errors ---");
console.log(pageErrors.length === 0 ? "  (none)" : pageErrors.map((line) => `  ${line}`).join("\n"));
console.log("--- failed requests ---");
console.log(failedRequests.length === 0 ? "  (none)" : failedRequests.map((line) => `  ${line}`).join("\n"));
console.log("--- blocked writes ---");
console.log(blockedWrites.length === 0 ? "  (none)" : blockedWrites.map((line) => `  ${line}`).join("\n"));

// A page wider than the viewport is a layout regression, not a matter of taste:
// report it as a failure so a check can catch it instead of an eye.
if (info.wideOffenders.length > 0) {
  console.error(`layout: ${info.wideOffenders.length} element(s) wider than the ${info.clientWidth}px viewport`);
  process.exitCode = 1;
}
if (info.diffLineOffenders.length > 0) {
  console.error(`layout: ${info.diffLineOffenders.length} diff line(s) wider than their own box`);
  process.exitCode = 1;
}
// A blocked write means the page tried to change the server and only this script
// stopped it. That is a failed probe, not a quiet success.
if (blockedWrites.length > 0) {
  console.error(`writes: ${blockedWrites.length} request(s) blocked; the probe changes no server state`);
  process.exitCode = 1;
}

if (shotPath !== null) {
  await page.screenshot({ path: shotPath, fullPage: false });
  console.log("--- screenshot ---");
  console.log(`  wrote ${shotPath}`);
}

await browser.close();
