/**
 * The composer's own state: the text, the draft the browser keeps of it, one send
 * at a time, and the actions the composer's buttons take.
 *
 * Two rules shape this module.
 *
 * The text is the operator's, and nothing from the server writes it. A stream
 * frame, a snapshot after a reconnect and a read of any list leave it exactly as
 * it is: only a keystroke puts text in, and only a send the server accepted takes
 * it out. The browser's copy (`./drafts.ts`) follows the same rule from the other
 * side: it is written on every keystroke and read once, when the page opens.
 *
 * A send is decided once, where both the button and `Enter` end up. `Enter`
 * submits the form, and a submit is the only entry into {@link submitComposer},
 * so the activity ring is checked there and not only on the button: a ring that
 * is turning is the page saying the agent cannot take a message now, and the
 * draft, its files and the cursor stay where they are until it stops. A press on
 * Send while the agent is busy does not submit: it queues the message
 * (`send-queue.ts`), and `Enter` never queues. The queue sends by calling
 * {@link submitComposer} once the page is idle.
 *
 * The rest of this file is the menu: Stop, Compact, New session, and the two
 * restarts. They change the conversation or the daemon, not this page, and each
 * asks before it sends anything it cannot take back.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { chatId, quotedChatName, routes } from "./conversation.ts";
import { clearDraft, pruneDrafts, readDraft, writeDraft } from "./drafts.ts";
import { activityStage, restartReady, restartRequired, sending } from "./run.ts";
import { showError, showToast } from "./toast.ts";
import { attachmentIsUploading, clearAttachments, readyAttachmentIds } from "./attachments.ts";

/* ---------------------------------------------------------------- the text */

/** The field's text. The server never writes it; a keystroke and a send do. */
export const composerText = signal<string>("");

/** The field itself, so a resize can measure it without a second query. */
let field: HTMLTextAreaElement | null = null;

/** How tall the field grows before it scrolls instead. `12rem` at the root size. */
export const COMPOSER_MAX_HEIGHT_PX = 192;

/** Tell the module which element the text is drawn in. */
export function setComposerField(element: HTMLTextAreaElement | null): void {
  field = element;
}

/** The field the text is drawn in, or `null` before the composer is mounted. */
export function composerField(): HTMLTextAreaElement | null {
  return field;
}

/**
 * Grow the field to fit what is in it, up to {@link COMPOSER_MAX_HEIGHT_PX}.
 *
 * The scrollbar the browser would draw for a one-row field is what this avoids:
 * the field is as tall as its text until the text is six lines, and past that it
 * scrolls without a drawn bar (`styles.css` `.composer textarea`).
 */
export function autoSize(element: HTMLTextAreaElement | null = field): void {
  if (element === null) return;
  // An empty field is the height its stylesheet gives it, and an inline height
  // left over from a longer draft would keep it there.
  if (element.value === "") {
    element.style.removeProperty("height");
    return;
  }
  // The stylesheet's height is one row, borders included (`box-sizing:
  // border-box`). Text that fits in it keeps that height, so one typed line is
  // exactly as tall as the empty field.
  element.style.removeProperty("height");
  if (element.scrollHeight <= element.clientHeight) return;
  // `scrollHeight` holds the padding but not the border, and the height the
  // field is given is the border box, so the border is added back.
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const border = (parseFloat(style?.borderTopWidth ?? "") || 0) + (parseFloat(style?.borderBottomWidth ?? "") || 0);
  element.style.height = `${Math.min(element.scrollHeight + border, COMPOSER_MAX_HEIGHT_PX)}px`;
}

/* -------------------------------------------------------------- the draft */

/**
 * The browser's name for this conversation's unsent text.
 *
 * The key names the conversation, so a draft written in one focused chat never
 * appears in another, and the root conversation's draft is its own. The mount
 * prefix is added by the drafts module, so two installs behind different proxies
 * never read each other's text.
 */
export function composerDraftKey(): string {
  return chatId === null ? "composer:root" : `composer:chat:${chatId}`;
}

/** Keep what was typed. The drafts module is the one that says a write failed. */
export function saveComposerDraft(text: string): void {
  writeDraft(composerDraftKey(), text);
}

/** A send the server accepted is the only thing that drops what was typed. */
export function clearComposerDraft(): void {
  clearDraft(composerDraftKey());
}

/**
 * Put back what was typed before the last reload, and drop drafts older than
 * fourteen days on the way.
 *
 * A field that already holds text keeps it: that text is this draft or newer (the
 * UI restart carry, {@link restoreUiState}), and reading over it would be a step
 * backwards.
 */
export function restoreComposerDraft(): void {
  pruneDrafts();
  if (composerText.value !== "") return;
  const text = readDraft(composerDraftKey());
  if (text === "") return;
  composerText.value = text;
}

/* ---------------------------------------------------------------- the send */

/** A fresh request id for one draft. */
function newRequestId(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") return `web:${cryptoApi.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `web:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The draft the last send was for, and the id it carried.
 *
 * The id is kept while the draft stays the same, so a send that failed and is
 * tried again carries the id it carried the first time and the server admits it
 * once. A new draft, or the next draft after a send that went through, gets a new
 * id.
 */
let pendingDraft: { readonly key: string; readonly requestId: string } | undefined;

/** One message, with the files uploaded for it. */
async function sendMessage(content: string, attachmentIds: readonly string[], requestId: string): Promise<SendAnswer | undefined> {
  const body: Record<string, unknown> = attachmentIds.length === 0 ? { content } : { content, attachmentIds };
  if (requestId !== "") body["requestId"] = requestId;
  return await request<SendAnswer>(routes.messages, { method: "POST", body: JSON.stringify(body) });
}

/**
 * What a send answers, as far as this page reads it.
 *
 * `held` is the one field worth reading: the conversation waits for a provider that
 * refused it for usage, so the server stored the text and started no run. The page
 * says so, because an operator whose message went nowhere would otherwise read the
 * silence as an answer on its way.
 */
interface SendAnswer {
  readonly held?: boolean;
}

/** What the page says when the provider's usage limit holds the conversation. */
const HELD_NOTICE =
  "This conversation is paused because the provider's usage limit was reached. Your message is saved and will be sent when the provider recovers.";

/** The sentence a send that did not go through gets, with the server's own words. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Send what is in the field.
 *
 * Refused, in this order, and each one leaves the draft where it is: a second
 * send while one is on its way, a send while the ring turns, an empty draft with
 * no files, and a send while a file is still uploading. The last one says so,
 * because a file that is dropped without a word is worse than a wait.
 *
 * What the server accepted is what empties the field, the tray and the stored
 * draft; a refusal leaves all three.
 */
export async function submitComposer(): Promise<void> {
  if (sending.value) return;
  if (activityStage.value !== "") return;
  const content = composerText.value.trim();
  const attachmentIds = readyAttachmentIds();
  if (content === "" && attachmentIds.length === 0) return;
  if (attachmentIsUploading()) {
    showToast("A file is still uploading. Send again when its chip stops moving.", { kind: "info" });
    return;
  }
  const key = JSON.stringify([content, attachmentIds]);
  if (pendingDraft === undefined || pendingDraft.key !== key) pendingDraft = { key, requestId: newRequestId() };
  sending.value = true;
  try {
    const answer = await sendMessage(content, attachmentIds, pendingDraft.requestId);
    pendingDraft = undefined;
    composerText.value = "";
    clearComposerDraft();
    clearAttachments();
    // A held conversation took the text into the transcript and calls the model
    // later, so the operator hears it from the page now. The answer is read after
    // the field is cleared: the text is where it belongs even when the provider has
    // not taken it yet.
    if (answer?.held === true) showToast(HELD_NOTICE, { kind: "info" });
  } catch (error) {
    showError(`Send failed: ${messageOf(error)}`);
  } finally {
    sending.value = false;
  }
}

/** Stop the run this conversation is in. A refusal says nothing the ring has not. */
export function abortRun(): void {
  void request(routes.abort, { method: "POST" }).catch(() => {
    // The ring is the report: a run that ended on its own needs no notice.
  });
}

/** Compact this conversation's context. */
export function compactContext(): void {
  void request(routes.compact, { method: "POST", body: JSON.stringify({}) }).catch(() => {
    // A compaction that did not start leaves the context bar as it was.
  });
}

/* ---------------------------------------------------------- New session */

/** One working sub-agent a refused reset names. */
export interface WorkingAgent {
  readonly conversationId?: string;
  readonly name: string;
}

/**
 * The second question a refused reset asks, naming the agents that are working.
 *
 * The server names them, so the operator can tell whose work a new session would
 * hide. The list stops at five names because a confirm dialog is read once: the
 * count carries the rest. Both questions name the chat the press acts on, so a
 * focused chat is never mistaken for the root.
 *
 * A refusal that names nobody keeps the server's own sentence as its first line:
 * saying `0 sub-agents are working` there would be a lie about the one thing the
 * operator is being asked to weigh.
 */
export function agentsWorkingQuestion(count: number, agents: readonly WorkingAgent[]): string {
  const names = agents.slice(0, 5).map((agent) => agent.name);
  const rest = agents.length - names.length;
  const listed = rest > 0 ? `${names.join(", ")}, and ${rest} more` : names.join(", ");
  const who = count === 1 ? "1 sub-agent is working" : `${count} sub-agents are working`;
  const context =
    routes.focused === false
      ? "A new session empties the root's context, so the root forgets how this work stands."
      : "A new session empties this chat's context, so the chat forgets how this work stands.";
  return [
    names.length === 0 ? `${who}.` : `${who}: ${listed}.`,
    `${context} The agents keep running and report to the new session.`,
    `Start a new session in ${quotedChatName()} anyway?`,
  ].join("\n");
}

/**
 * The working sub-agents one refusal names.
 *
 * The 409 body puts them beside the `error` envelope rather than inside it
 * (`agentsWorkingRefusal` in `src/server/streams.ts`), so they are read out of the
 * whole body the request function keeps on the error. A refusal whose body is
 * another shape, or whose entries carry no name, names nobody: the caller then
 * asks its question with the server's own count and no names.
 */
export function workingAgentsOf(error: unknown): readonly WorkingAgent[] {
  const body = (error as { readonly body?: unknown } | null | undefined)?.body;
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { readonly agents?: unknown }).agents;
  if (!Array.isArray(list)) return [];
  const agents: WorkingAgent[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as { readonly name?: unknown }).name;
    if (typeof name !== "string" || name === "") continue;
    const id = (item as { readonly conversationId?: unknown }).conversationId;
    agents.push({ name, conversationId: typeof id === "string" ? id : undefined });
  }
  return agents;
}

/**
 * Ask for a new session, and ask a second time when the server refuses because
 * sub-agents are working.
 *
 * A refusal, or a press the operator withdraws, leaves this session exactly as it
 * was, still holding the sections it started on. The stale-section marker is the
 * status route's business; this module only sends the reset.
 */
export async function startNewSession(force = false): Promise<void> {
  try {
    await request(routes.reset, { method: "POST", body: JSON.stringify(force ? { force: true } : {}) });
  } catch (error) {
    if (!force && error instanceof ApiError && error.status === 409 && error.code === "agents_working") {
      const agents = workingAgentsOf(error);
      if (agents.length === 0) {
        // The refusal says how many are working but not who. The sentence it wrote
        // is still the truth about what a new session would do.
        const count = Number.parseInt(/\d+/.exec(error.message)?.[0] ?? "1", 10);
        if (confirmQuestion(agentsWorkingQuestion(count, []))) await startNewSession(true);
        return;
      }
      if (confirmQuestion(agentsWorkingQuestion(agents.length, agents))) await startNewSession(true);
      return;
    }
    showError(messageOf(error));
  }
}

/** A press on New session: the question that names the chat. */
export function askNewSession(): void {
  if (!confirmQuestion(`Start a new session in ${quotedChatName()}? History is kept.`)) return;
  void startNewSession(false);
}

/* ------------------------------------------------- the two restarts */

/** The browser's confirmation, or a refusal on a page that has none. */
function confirmQuestion(message: string): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
  return window.confirm(message) === true;
}

/** Reload this page, which the two restarts end with. */
function reloadPage(): void {
  if (typeof window === "undefined") return;
  window.location.reload();
}

/** One wait, in the state module, because timers belong here. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long the restarted daemon is waited for before the page says it is gone. */
export const RESTART_GIVE_UP_MS = 5 * 60 * 1000;

/** How long answers from the old process are accepted before the restart is called off. */
export const RESTART_OLD_PROCESS_MS = 60 * 1000;

/** The first wait, before the old process has had time to stop. */
export const RESTART_FIRST_WAIT_MS = 3000;

/** The wait between two answers while the daemon comes back. */
export const RESTART_POLL_MS = 1000;

/** An uptime below this is a process that started, which is the one to reload into. */
export const RESTART_FRESH_UPTIME_MS = 120_000;

/** When the restart was asked for, so the wait can tell the old process from a new one. */
let restartAskedAt = 0;

/**
 * Reload into the restarted server.
 *
 * The first answer is not enough: for a couple of seconds the old process is
 * still answering, and reloading into it would only lose the page again. A fresh
 * process reports a small `uptimeMs`, which is what this waits for. A minute of
 * answers that all come from the old process means the restart did not happen —
 * the script refused before it stopped anything — and saying so is more useful
 * than waiting out a five minute deadline.
 */
async function waitForRestart(): Promise<void> {
  const started = Date.now();
  await delay(RESTART_FIRST_WAIT_MS);
  for (;;) {
    try {
      const health = await request<{ uptimeMs?: unknown }>("/healthz");
      if (typeof health?.uptimeMs === "number" && health.uptimeMs < RESTART_FRESH_UPTIME_MS) {
        reloadPage();
        return;
      }
      if (Date.now() - started > RESTART_OLD_PROCESS_MS) {
        showError("The server is still the old process: the restart did not happen. See ~/.pi/sec/logs/update-and-restart.log");
        return;
      }
    } catch {
      // Down, or not answering yet: that is what a restarting daemon looks like.
    }
    if (Date.now() - started > RESTART_GIVE_UP_MS) {
      showError("The server did not come back within five minutes. See ~/.pi/sec/logs/update-and-restart.log");
      return;
    }
    await delay(RESTART_POLL_MS);
  }
}

/**
 * Restart the daemon, from the composer menu.
 *
 * The daemon does not restart itself and cannot: it hands
 * `user-tools/update-and-restart` to systemd, which stops and starts the service.
 * This page goes down with it, so it polls until a server answers again and then
 * reloads into the new process.
 *
 * `options.reinstall` is the menu's second entry: the same handoff with
 * `--reinstall`, so the execution tree's `node_modules` is built again.
 */
export async function restartServer(options: { readonly reinstall?: boolean } = {}): Promise<void> {
  const reinstall = options.reinstall === true;
  const lines = [
    "Restart the server?",
    "The daemon stops for a few seconds, applies any committed update, and starts again.",
    "A turn that is running now is cut off.",
  ];
  // The second entry does more than a restart: it throws the execution tree's
  // node_modules away and installs it again from package-lock.json. That costs
  // time, and it needs the network when the package cache is cold, so the
  // question names both.
  if (reinstall) {
    lines.push("The execution tree's node_modules is deleted and installed again from package-lock.json.");
    lines.push("That takes longer than a plain restart, and it uses the network when the package cache is cold.");
  }
  // A restart runs whatever is committed at that moment. While a batch is still
  // open, that can be half a change: the banner says so, and so does this.
  if (restartRequired.value && !restartReady.value) {
    lines.push(
      "A core change is staged but its batch is not closed. The daemon may come back running a change that is still being written.",
    );
  }
  if (!confirmQuestion(lines.join("\n\n"))) return;
  try {
    await request("/api/admin/restart", { method: "POST", body: JSON.stringify(reinstall ? { reinstall: true } : {}) });
  } catch (error) {
    showError(`Restart refused: ${messageOf(error)}`);
    return;
  }
  showToast("Restart requested. This page reloads when the server is back.", { kind: "info" });
  restartAskedAt = Date.now();
  void waitForRestart();
}

/** When the restart was asked for: the page's own record of the wait it is in. */
export function restartAskedAtMs(): number {
  return restartAskedAt;
}

/** What `POST /api/admin/ui-restart` answers, as this page reads it. */
interface UiRestartAnswer {
  readonly copied?: unknown;
  readonly codeDrift?: {
    readonly known?: unknown;
    readonly codePaths?: unknown;
  } | null;
}

/**
 * Restart the UI, from the composer menu.
 *
 * Only the files the browser is served are replaced: the daemon keeps running,
 * so a turn in progress is not cut off and the process id does not change. The
 * route copies `<workspace>/src/web` over the directory this page came from and
 * builds the page bundles from `<workspace>/src/ui` into that same tree, so an
 * edit under `src/web` or `src/ui` reaches the screen without a cold restart.
 * Server code is not part of that copy, and the answer says how far the tree's
 * server code is ahead, because that half cannot land here.
 */
export async function restartUi(): Promise<void> {
  const question =
    "Restart the UI? The server keeps running, so a turn in progress is not interrupted. This applies the files in your workspace's web folder and reloads the page.";
  if (!confirmQuestion(question)) return;

  let answer: UiRestartAnswer | undefined;
  try {
    answer = await request<UiRestartAnswer>("/api/admin/ui-restart", { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    showError(`UI restart refused: ${messageOf(error)}`);
    return;
  }

  // The second question is where the operator decides when to reload, and where
  // the one thing this does not do gets said. A toast would fade before an edit
  // under `src/` is acted on; a question that has to be answered keeps the fact in
  // front of the operator: the copied files are the web folder alone, so a server
  // change in the tree still waits for a cold restart.
  const copied = typeof answer?.copied === "number" ? answer.copied : 0;
  const drift = answer?.codeDrift;
  const codePaths = Array.isArray(drift?.codePaths) ? drift.codePaths.filter((path): path is string => typeof path === "string") : [];
  const lines = [`UI files applied (${copied}).`];
  if (drift?.known !== true) {
    // A tree whose git state could not be read says nothing about server code.
    // "Not part of this" would read as "nothing else is waiting", which is the one
    // answer this page must not invent when it does not know.
    lines.push(
      "Server code drift could not be read, so whether your tree also changed server code is unknown. This applies web files only.",
    );
  } else if (codePaths.length > 0) {
    lines.push(
      `Server code changes in your tree are not applied (${codePaths.length}): ${codePaths.slice(0, 3).join(", ")}. A cold restart is needed for those.`,
    );
  } else {
    lines.push("Server code changes are not part of this.");
  }
  lines.push(
    "Text in the message box and the open report panel are kept. The scroll position and expanded groups are not. Reload now?",
  );
  if (!confirmQuestion(lines.join("\n\n"))) return;

  saveUiState();
  reloadPage();
}

/* --------------------------------------------- what a UI restart carries */

/**
 * Where the reload a UI restart causes keeps what it would otherwise drop:
 * the text in the composer and the report panel that is open.
 *
 * `sessionStorage` and not `localStorage`: this belongs to one tab and one
 * reload, so a second tab that reloads on its own is never handed this one's
 * draft.
 */
export const UI_RESTART_KEY = "pi-sec-ui-restart";

/**
 * The report panel is another branch's. What the carry needs from it is two
 * answers, and it registers them here rather than being imported: the composer
 * must not depend on a panel it does not draw.
 */
export interface ReportPaneBridge {
  /** The report the panel shows now, or `null` when it is closed. */
  current(): string | null;
  /** Open one report, as a press on its inbox notice does. */
  open(id: string): void;
}

/** The panel, when its branch registered one. */
let reportPane: ReportPaneBridge | null = null;

/** Tell the composer how to save and restore an open report panel. */
export function registerReportPane(bridge: ReportPaneBridge | null): void {
  reportPane = bridge;
}

/**
 * Put aside what the reload is about to drop.
 *
 * A store that refuses the write must not stop the reload: the draft is lost
 * either way, and staying on the page the operator asked to replace would be worse
 * than a refused write.
 */
export function saveUiState(): void {
  if (typeof window === "undefined") return;
  const draft = composerText.value;
  const report = reportPane === null ? null : reportPane.current();
  try {
    window.sessionStorage.setItem(UI_RESTART_KEY, JSON.stringify({ draft, report }));
  } catch {
    /* ignore */
  }
}

/**
 * Read back what {@link saveUiState} put aside, and clear it.
 *
 * The key is removed as it is read: a page opened later, or a second tab, must not
 * be handed a draft that belongs to this one reload. The draft goes in through the
 * same signal a typed one takes, so the field grows to fit it rather than scrolling
 * a line inside it.
 */
export function restoreUiState(): void {
  if (typeof window === "undefined") return;
  let saved: { draft?: unknown; report?: unknown } | null = null;
  try {
    const raw = window.sessionStorage.getItem(UI_RESTART_KEY);
    window.sessionStorage.removeItem(UI_RESTART_KEY);
    saved = raw === null ? null : (JSON.parse(raw) as { draft?: unknown; report?: unknown } | null);
  } catch {
    /* a store that refuses reads leaves nothing to restore */
  }
  if (saved === null || typeof saved !== "object") return;
  if (typeof saved.draft === "string" && saved.draft !== "") composerText.value = saved.draft;
  if (typeof saved.report === "string" && saved.report !== "" && reportPane !== null) reportPane.open(saved.report);
}

/* ------------------------------------------------------------- the menu */

/** Whether the `⋯` menu is open. The operator's, and no stream touches it. */
export const composerMenuOpen = signal(false);

/** Open or close the `⋯` menu. */
export function setComposerMenu(open: boolean): void {
  if (composerMenuOpen.value === open) return;
  composerMenuOpen.value = open;
}

/** A press on `⋯`. */
export function toggleComposerMenu(): void {
  setComposerMenu(!composerMenuOpen.value);
}

/**
 * The two menu entries whose panels belong to another branch.
 *
 * The snippet panel and the model login panel are drawn by the branch that owns
 * them, which registers here. Until then the press does nothing, which is what a
 * page that has not assembled those parts should do.
 */
let snippetPress: (() => void) | null = null;
let loginPress: (() => void) | null = null;

/** Register what a press on the snippet button does. */
export function onSnippetPress(handler: (() => void) | null): void {
  snippetPress = handler;
}

/** Register what a press on `Model login` does. */
export function onLoginPress(handler: (() => void) | null): void {
  loginPress = handler;
}

/** A press on the fourth attach button: a snippet is typed, not picked. */
export function openSnippetPane(): void {
  snippetPress?.();
}

/** A press on `Model login`, and on the header's credential line. */
export function openLoginPane(): void {
  loginPress?.();
}
