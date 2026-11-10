/**
 * The Results section and a result report's two buttons, in a real browser.
 *
 * jsdom cannot answer the question this file exists for: whether the list draws
 * the section above Pending and whether the viewer's bar really puts two buttons
 * on screen, at a width a person reads. It also holds the one rule that no jsdom
 * test can hold — a press is received by a fake transport, so nothing reaches a
 * running daemon.
 *
 * The daemon serves the page shell, the stylesheet and the bundles, and every
 * `/api/` request is answered here by a route handler instead. The fixtures are
 * fixed data, and the press is caught by that handler: the fake send function the
 * plan asked for.
 *
 * Measured here, and why each number:
 *
 *   - the order of the section headings on the list, which is the whole change;
 *   - the two buttons of a result report, their labels and their enabled state;
 *   - where the two buttons sit, and how tall they are, at 390px and at 1280px,
 *     on the viewer and in the chat's report panel: Done and Feedback share a row
 *     and are at least 44px tall wherever the field takes a row of its own;
 *   - the line under the bar: the sentence that explains the buttons is hidden at
 *     every width, and the approval record is shown at every width;
 *   - the Done press: one POST to `/api/reports/<id>/done`, with the field's text
 *     in its body and `via` naming the viewer.
 *
 * The four viewport cases are the completion conditions of this change. They are here, in a real browser,
 * because jsdom has no layout: only the browser can say whether two buttons share
 * a top edge or how tall they came out.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { defaultConfig } from "../../src/config/schema.ts";
import type { StartedServer } from "../../src/server/server.ts";
import { createTestHarness, type TestHarness } from "../helpers.ts";
import { builtWebDir } from "./web-dir.ts";
import { launchChromium } from "./chromium.ts";
import { startTestServer } from "../server-helpers.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let origin = "";
/** Everything the page reported as its own error. */
const pageErrors: string[] = [];
/** Every POST the fake transport caught, in order. */
const posts: { path: string; body: unknown }[] = [];

const RESULT_HINT = "Done closes this result. Text with Done asks for follow-up work. Feedback asks for more in this report.";

/** The two widths every layout question below is asked at. */
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;

/** The smallest a button may be, which is the tap target the stylesheet promises. */
const TAP_PX = 44;

/** What one bar drew, in CSS pixels, on the page as it stands. */
interface BarFacts {
  /** The line under the bar is drawn, rather than in the page and hidden. */
  readonly hintShown: boolean;
  /** The line's text, whether or not it is drawn. */
  readonly hintText: string;
  /** Where the field and the two buttons are, or `null` when the bar has none. */
  readonly field: Box | null;
  readonly done: Box | null;
  readonly feedback: Box | null;
  /** The container the bar stands in: `#note-bar` or `#report-pane-feedback`. */
  readonly bar: Box;
}

interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
}

/**
 * Read the bar that stands in `containerId`.
 *
 * A drawn box and a hidden one are told apart by `getClientRects()`, not by
 * `display`: a hidden element has no rects, and a `<p>` with no text has none
 * either, which is the case for a plan's bar that has nothing to say.
 */
async function readBar(target: Page, containerId: string): Promise<BarFacts> {
  return await target.evaluate((id) => {
    const box = (element: Element | null): Box | null => {
      if (element === null || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, right: rect.right };
    };
    const container = document.getElementById(id);
    const hint = document.getElementById("feedback-hint");
    const bar = box(container);
    if (bar === null) throw new Error(`the page draws no #${id}`);
    return {
      hintShown: box(hint) !== null,
      hintText: hint?.textContent ?? "",
      field: box(document.getElementById("feedback-body")),
      done: box(document.getElementById("feedback-done")),
      feedback: box(document.getElementById("feedback-submit")),
      bar,
    };
  }, containerId);
}

/** A bar with two buttons drawn, which every layout question below needs. */
function twoButtons(facts: BarFacts): { done: Box; feedback: Box } {
  if (facts.done === null || facts.feedback === null) throw new Error("the bar drew fewer than two buttons");
  return { done: facts.done, feedback: facts.feedback };
}

/** One report as every report route answers it. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01RESULTFIXTURE00000000000",
    jobId: "01JOBFIXTURE00000000000000",
    name: "run-log",
    title: "Run log",
    versions: [{ n: 1, at: 1_000, bytes: 8, sha256: "a" }],
    feedback: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    active: true,
    archived: false,
    status: "result",
    kind: "result",
    job: { id: "01JOBFIXTURE00000000000000", title: "work", status: "active" },
    ...over,
  };
}

/** The list: a plan, a result report, a set-aside one and a finished one. */
const LIST = {
  reports: [
    report({ id: "01PLANFIXTURE0000000000000", name: "plan", title: "Plan", status: "active", kind: undefined }),
    report(),
    report({ id: "01PENDINGFIXTURE0000000000", name: "later", title: "Later", status: "pending", pendingAt: 4_000, kind: undefined }),
    report({ id: "01OLDFIXTURE0000000000000", name: "old", title: "Old", status: "inactive", active: false, kind: undefined }),
  ],
  archived: [],
};

/**
 * A plan whose one revision the user already approved, which is the bar that has
 * something of its own to say: `Approved v1 · …`.
 */
const APPROVED = report({
  id: "01APPROVEDFIXTURE0000000000",
  name: "approved",
  title: "Approved plan",
  status: "approved",
  kind: undefined,
  versions: [{ n: 1, at: Date.now() - 4 * 60_000, bytes: 8, sha256: "a", approval: { at: Date.now() - 4 * 60_000, via: "viewer", sha256: "a" } }],
});

/** The one notice the chat's inbox carries, so the report panel can be opened. */
const NOTICE = {
  id: "i1",
  kind: "report",
  title: "Report published: Run log",
  body: "the notice body",
  createdAt: Date.now() - 60_000,
  source: { reportId: report()["id"], jobId: report()["jobId"], reportEvent: "published" },
};

const BODY = "# Run log\n\nthe work ran, and here is what it did\n";

beforeAll(async () => {
  harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  started = await startTestServer(harness, { webDir: builtWebDir() });
  origin = started.origin;

  browser = await launchChromium();
  page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  // Every API request is answered here, so nothing this file does reaches the
  // daemon: no report is read from its store, and no press is recorded in it.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const answer = (status: number, body: unknown): Promise<void> =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "POST") {
      posts.push({ path, body: request.postData() === null ? null : JSON.parse(request.postData()!) });
      return await answer(201, { id: report()["id"], version: 1, approval: { at: 5_000, via: "viewer", sha256: "a", button: "done" } });
    }
    if (path === "/api/reports") return await answer(200, LIST);
    if (path === "/api/reports/by-name/run-log") return await answer(200, report());
    if (path === "/api/reports/by-name/approved") return await answer(200, APPROVED);
    if (path === `/api/reports/${String(report()["id"])}`) return await answer(200, report());
    if (path === `/api/reports/${String(APPROVED["id"])}`) return await answer(200, APPROVED);
    if (path === "/api/reports/01RESULTFIXTURE00000000000/versions/1") {
      return await route.fulfill({ status: 200, contentType: "text/markdown", body: BODY });
    }
    if (path === "/api/reports/01APPROVEDFIXTURE0000000000/versions/1") {
      return await route.fulfill({ status: 200, contentType: "text/markdown", body: "# Approved plan\n\nbody\n" });
    }
    if (path === "/api/inbox") return await answer(200, { items: [NOTICE] });
    return await answer(200, {});
  });
});

afterAll(async () => {
  await browser?.close();
  browser = undefined;
  page = undefined;
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

function current(): Page {
  if (page === undefined) throw new Error("chromium is not running");
  return page;
}

it("draws Done and Feedback in the viewer, with the sentence that explains them kept out of sight", async () => {
  const target = current();
  await target.setViewportSize(DESKTOP);
  await target.goto(`${origin}/report/run-log`, { waitUntil: "load", timeout: 30000 });
  await target.waitForSelector("#feedback-done", { timeout: 30000 });

  const drawn = await target.evaluate(() => {
    const done = document.getElementById("feedback-done") as HTMLButtonElement | null;
    const feedback = document.getElementById("feedback-submit") as HTMLButtonElement | null;
    return {
      done: done === null ? null : { text: done.textContent, disabled: done.disabled, width: done.getBoundingClientRect().width },
      feedback:
        feedback === null
          ? null
          : { text: feedback.textContent, disabled: feedback.disabled, width: feedback.getBoundingClientRect().width },
    };
  });

  expect(drawn.done?.text).toBe("Done");
  expect(drawn.feedback?.text).toBe("Feedback");
  // Done is one press even with an empty field; Feedback waits for text.
  expect(drawn.done?.disabled).toBe(false);
  expect(drawn.feedback?.disabled).toBe(true);
  // Both buttons are on screen and tappable at a desktop width.
  expect(drawn.done?.width).toBeGreaterThan(0);
  expect(drawn.feedback?.width).toBeGreaterThan(0);

  // The sentence is published with the bar and hidden by the stylesheet, so it is
  // still in the page: what changed is that it is not drawn. `docs/ui.md` is where
  // the same words are written down for a reader.
  const bar = await readBar(target, "note-bar");
  expect(bar.hintText).toBe(RESULT_HINT);
  expect(bar.hintShown, `${DESKTOP.width}px: the explanation is still drawn`).toBe(false);
  expect(pageErrors).toEqual([]);
});

it("keeps Done and Feedback on one row at 390px and at 1280px, and hides the explanation at both", async () => {
  const target = current();
  for (const size of [PHONE, DESKTOP]) {
    await target.setViewportSize(size);
    await target.goto(`${origin}/report/run-log`, { waitUntil: "load", timeout: 30000 });
    await target.waitForSelector("#feedback-done", { timeout: 30000 });
    const bar = await readBar(target, "note-bar");
    const { done, feedback } = twoButtons(bar);

    expect(done.top, `${size.width}px: Done and Feedback are not on one row`).toBe(feedback.top);
    expect(feedback.left, `${size.width}px: Done is not left of Feedback`).toBeGreaterThan(done.left);
    expect(bar.hintShown, `${size.width}px: the explanation is drawn`).toBe(false);

    if (size === PHONE) {
      // The field takes a row of its own and the buttons share the row under it,
      // half each, at the 44px tap target the stylesheet promises.
      if (bar.field === null) throw new Error("the bar drew no field");
      expect(done.top, "390px: the buttons are not under the field").toBeGreaterThanOrEqual(bar.field.top + bar.field.height - 1);
      expect(done.height, "390px: Done is under 44px tall").toBeGreaterThanOrEqual(TAP_PX);
      expect(feedback.height, "390px: Feedback is under 44px tall").toBeGreaterThanOrEqual(TAP_PX);
      expect(Math.abs(done.width - feedback.width), "390px: the two buttons are not half each").toBeLessThanOrEqual(1);
    } else {
      // The wide viewer keeps the row it had: the field, then the two buttons to
      // its right, on the same line.
      if (bar.field === null) throw new Error("the bar drew no field");
      expect(done.left, "1280px: the buttons are not to the right of the field").toBeGreaterThanOrEqual(
        bar.field.left + bar.field.width - 1,
      );
      expect(Math.abs(done.top + done.height - (bar.field.top + bar.field.height)), "1280px: the buttons and the field do not share a line").toBeLessThanOrEqual(1);
    }
  }
  expect(pageErrors).toEqual([]);
});

it("keeps the approval record on screen at 390px and at 1280px", async () => {
  const target = current();
  for (const size of [PHONE, DESKTOP]) {
    await target.setViewportSize(size);
    await target.goto(`${origin}/report/approved`, { waitUntil: "load", timeout: 30000 });
    await target.waitForSelector("#feedback-submit", { timeout: 30000 });
    const bar = await readBar(target, "note-bar");

    // This line says who approved which revision and when, and nothing else on the
    // screen says it, so it is shown at every width.
    expect(bar.hintText, `${size.width}px: the approval record is gone`).toContain("Approved v1");
    expect(bar.hintShown, `${size.width}px: the approval record is not drawn`).toBe(true);
    expect(bar.done, `${size.width}px: an approved plan drew a result report's buttons`).toBeNull();
  }
  expect(pageErrors).toEqual([]);
});

it("puts the report panel's two buttons on one row at every width, without the explanation", async () => {
  const target = current();
  for (const size of [PHONE, DESKTOP]) {
    await target.setViewportSize(size);
    await target.goto(`${origin}/basic-chat`, { waitUntil: "load", timeout: 30000 });
    if (size.width < 860) {
      // The inbox is the drawer on a narrow screen, and the drawer starts closed.
      const open = await target.evaluate(() => document.body.dataset["sidebar"] === "open");
      if (!open) {
        await target.click("#sidebar-toggle");
        await target.waitForFunction(() => document.body.dataset["sidebar"] === "open", undefined, { timeout: 10000 });
      }
    }
    await target.waitForSelector("#inbox .inbox-title", { timeout: 30000 });
    await target.click("#inbox .inbox-title");
    await target.waitForFunction(() => document.getElementById("feedback-done") !== null, undefined, { timeout: 30000 });
    const bar = await readBar(target, "report-pane-feedback");
    const { done, feedback } = twoButtons(bar);

    // The panel is narrower than a row of field and buttons needs, so the buttons
    // are under the field at every width, even on a wide screen.
    if (bar.field === null) throw new Error("the panel drew no field");
    expect(done.top, `${size.width}px panel: the buttons are not under the field`).toBeGreaterThanOrEqual(
      bar.field.top + bar.field.height - 1,
    );
    expect(done.height, `${size.width}px panel: Done is under 44px tall`).toBeGreaterThanOrEqual(TAP_PX);
    expect(feedback.height, `${size.width}px panel: Feedback is under 44px tall`).toBeGreaterThanOrEqual(TAP_PX);
    expect(done.top, `${size.width}px panel: Done and Feedback are not on one row`).toBe(feedback.top);
    expect(bar.hintShown, `${size.width}px panel: the explanation is drawn`).toBe(false);
  }
  expect(pageErrors).toEqual([]);
});

it("sends one Done with the field's text, and the fake transport receives it", async () => {
  const target = current();
  posts.length = 0;
  await target.goto(`${origin}/report/run-log`, { waitUntil: "load", timeout: 30000 });
  await target.waitForSelector("#feedback-done", { timeout: 30000 });
  await target.fill("#feedback-body", "run it on the second machine");
  // Typing is what turns Feedback on: the two buttons read the same field.
  await target.waitForFunction(() => {
    const feedback = document.getElementById("feedback-submit") as HTMLButtonElement | null;
    return feedback !== null && !feedback.disabled;
  }, undefined, { timeout: 10000 });
  await target.click("#feedback-done");
  // A press the server took leaves for the list, exactly as an approval from this
  // bar does: the list is read fresh, which is where what just landed is read.
  await target.waitForURL(/\/report$/, { timeout: 10000 });

  // One press, one request, and the daemon never sees it.
  expect(posts).toHaveLength(1);
  expect(posts[0]?.path).toBe("/api/reports/01RESULTFIXTURE00000000000/done");
  expect(posts[0]?.body).toEqual({ version: 1, via: "viewer", text: "run it on the second machine" });
  expect(pageErrors).toEqual([]);
});
