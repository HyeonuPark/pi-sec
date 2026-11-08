/**
 * One assembled chat page in jsdom, from the real bundle, with the daemon faked.
 *
 * The page tests of this branch load `src/ui/pages/chat.tsx` the way the browser
 * does (`loadUiPage`, `test/ui/harness.ts`): the shell from `src/web/index.html`,
 * `base.js`, and the test build of the page bundle. That is the point of these
 * tests — every part this branch assembled is one commit away from being served,
 * and a page test that mounted the parts by hand would not say so.
 *
 * The answers below are what a quiet daemon says, so a test names only the route
 * it is about. Every route not named here answers `200 {}`, which is what the
 * harness does with no answer at all.
 */
import { loadUiPage, settle, type FetchAnswer, type LoadUiPageOptions, type UiPageHandle } from "./harness.ts";

/** What a quiet daemon answers: no jobs, no notices, no questions, nothing to say. */
export const QUIET: Readonly<Record<string, FetchAnswer>> = {
  "/api/preferences": { body: { hiddenJobs: [], expandedJobs: [], clearedInbox: [] } },
  "/api/jobs": { body: { jobs: [] } },
  "/api/inbox": { body: { items: [] } },
  "/api/user-queries": { body: { queries: [] } },
  "/api/admin/status": { body: { restartRequired: false, restartReady: false, configError: null, notes: [] } },
  "/api/admin/model-login/providers": { body: { available: true, providers: [], sessionActive: false } },
  "/basic-chat/context": { body: { used: null, max: 1, window: 1, reserveTokens: 0 } },
};

/** Let the page answer `count` rounds of microtasks and timers. */
export async function more(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await settle();
}

/** Load the chat page with the quiet answers, and answer what to change about them. */
export async function loadChatPage(options: LoadUiPageOptions = {}): Promise<UiPageHandle> {
  const ui = await loadUiPage("chat", { ...options, fetch: { ...QUIET, ...(options.fetch ?? {}) } });
  await more();
  return ui;
}

/** One report record: `count` revisions, nothing approved, a live job. */
export function reportRecord(count = 1, over: Record<string, unknown> = {}): Record<string, unknown> {
  const versions = [];
  for (let n = 1; n <= count; n += 1) versions.push({ n, at: 1_000 * n, bytes: 8, sha256: String(n) });
  return {
    id: "r1",
    jobId: "j1",
    name: "plan",
    title: "Plan",
    versions,
    feedback: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    active: true,
    archived: false,
    status: "active",
    job: { id: "j1", title: "work", status: "active" },
    ...over,
  };
}

/** One inbox notice of the kind the report panel opens for. */
export function reportNotice(reportId = "r1", over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "i1",
    kind: "report",
    title: "Report published: Plan",
    body: `/report/plan\njob j1\nv1`,
    createdAt: Date.now() - 60_000,
    source: { reportId, jobId: "j1", reportEvent: "published" },
    ...over,
  };
}

/** The provider list a panel draws its form from. */
export function providerList(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    sessionActive: false,
    rootProvider: "anthropic",
    providers: [
      { id: "anthropic", extension: null, configured: false, types: ["oauth", "api_key"], lastLogin: null },
      { id: "acme", extension: "acme", configured: true, types: ["oauth"], lastLogin: null },
    ],
    ...over,
  };
}

/** The one element the page has under an id. */
export function byId<T extends Element = HTMLElement>(ui: UiPageHandle, id: string): T {
  const element = ui.document.getElementById(id);
  if (element === null) throw new Error(`the page has no #${id}`);
  return element as unknown as T;
}

/** Press an element the way an operator does: a bubbling click from the page. */
export function press(ui: UiPageHandle, element: Element): void {
  element.dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Type into a field: set the value, then say so the way an input event does. */
export function type(ui: UiPageHandle, element: Element, value: string): void {
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
}

/** Tick a checkbox the way a press does. */
export function tick(ui: UiPageHandle, element: Element, checked: boolean): void {
  const box = element as HTMLInputElement;
  if (box.checked === checked) return;
  box.checked = checked;
  box.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
}

/** Press `Escape` on the page. */
export function escape(ui: UiPageHandle): void {
  ui.document.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape" }));
}

/** Open the snippet panel the way the operator does: the fourth attach button. */
export async function openSnippetPanel(ui: UiPageHandle): Promise<void> {
  press(ui, byId(ui, "attach-snippet"));
  await more(2);
}

/** Open the model login panel the way the operator does: the `⋯` menu's entry. */
export async function openLoginPanel(ui: UiPageHandle): Promise<void> {
  press(ui, byId(ui, "model-login"));
  await more(3);
}

/** Open a report in the panel the way the operator does: its inbox title. */
export async function openReportPanel(ui: UiPageHandle, position = 0): Promise<void> {
  const title = ui.document.querySelectorAll("#inbox .inbox-title")[position];
  if (title === undefined) throw new Error(`the inbox has no row ${position}`);
  press(ui, title);
  await more(4);
}

/** Every request the page made to a path, in order. */
export function callsTo(ui: UiPageHandle, path: string, method?: string): readonly { readonly url: string }[] {
  return ui.fetchCalls.filter((call) => call.path === path && (method === undefined || call.method === method));
}
