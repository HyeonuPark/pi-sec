/**
 * The setup card: what the page asks for while the daemon has no model.
 *
 * The daemon starts with an empty `agent.vmodel` on a new install. It then answers
 * `modelSetupRequired` on the status route, and the page shows a card with three
 * steps: sign a provider in, choose the first model, load the configuration. This
 * module holds what the card shows and what its three presses do.
 *
 * What the operator chose in the form is theirs: a list read again (after the login
 * panel closed) keeps the choices that the new list still holds. A refusal is the
 * daemon's own sentence, shown as written.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { onPaneClose } from "./panels.ts";
import { modelSetupRequired, refreshStatus } from "./run.ts";
import { openLoginPanelInSlot } from "./login.ts";
import type {
  SetupModelProvider,
  SetupModelRequest,
  SetupModelsAnswer,
  SetupThinkingLevel,
} from "../../shared/wire/model-setup.ts";

/** The thinking levels the form offers, in the order the command lists them. */
export const THINKING_LEVELS: readonly SetupThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** The command for the operator who works on the server. */
export const SETUP_COMMAND = "pi-sec setup-model --provider <id> --model <id>";

/** Whether the list has been read at least once, so the form does not claim "no provider" too early. */
export const setupLoaded = signal(false);

/** The signed-in providers with their chat models, as the last read answered. */
export const setupProviders = signal<readonly SetupModelProvider[]>([]);

/** The vmodels config.json declares already. The replace box shows only when it is not empty. */
export const setupExisting = signal<readonly string[]>([]);

/** The main model the operator chose, as {@link modelKey}; empty before a choice. */
export const setupModel = signal("");

/** The thinking level the operator chose. */
export const setupThinking = signal<SetupThinkingLevel>("medium");

/** Whether the closed section for another worker model is open. */
export const setupWorkerOpen = signal(false);

/** The worker model the operator chose, as {@link modelKey}; empty before a choice. */
export const setupWorker = signal("");

/** Whether the operator ticked the replace box. */
export const setupForce = signal(false);

/** True while the save request is on its way. */
export const setupSaving = signal(false);

/** True while the reload request is on its way. */
export const setupReloading = signal(false);

/** The refusal under the form, as the daemon wrote it. */
export const setupError = signal("");

/** The problem sentences under the reload button. */
export const setupIssues = signal<readonly string[]>([]);

/** The one line a copy press leaves behind. */
export const setupCopyNote = signal("");

/** One model of the list as one string, which a `<select>` can carry. */
export function modelKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

/** The provider and the model a key names. A model id may hold `|`, a provider id does not. */
export function splitModelKey(key: string): { readonly provider: string; readonly model: string } | null {
  const at = key.indexOf("|");
  if (at <= 0 || at === key.length - 1) return null;
  return { provider: key.slice(0, at), model: key.slice(at + 1) };
}

/** Whether the list holds a model, so a read again can keep a choice. */
function listHolds(list: readonly SetupModelProvider[], key: string): boolean {
  const parts = splitModelKey(key);
  if (parts === null) return false;
  return list.some((entry) => entry.id === parts.provider && entry.models.some((m) => m.id === parts.model));
}

/** Read the model list: the signed-in providers and what config.json already declares. */
export async function refreshSetupModels(): Promise<void> {
  let data: SetupModelsAnswer | undefined;
  try {
    data = await request<SetupModelsAnswer>("/api/admin/model-setup/models");
  } catch (error) {
    setupError.value = refusalText(error);
    setupLoaded.value = true;
    return;
  }
  const list = Array.isArray(data?.providers) ? data.providers : [];
  setupProviders.value = list;
  setupExisting.value = Array.isArray(data?.existingVmodels) ? data.existingVmodels : [];
  if (!listHolds(list, setupModel.value)) setupModel.value = "";
  if (!listHolds(list, setupWorker.value)) setupWorker.value = "";
  if (setupExisting.value.length === 0) setupForce.value = false;
  setupLoaded.value = true;
}

/** The sentence a refusal says: the daemon's own, and a fixed one when it said none. */
function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    const text = error.message;
    return error.code === "write_refused"
      ? `${text} Tick "Replace existing vmodels" to replace them from this form.`
      : text;
  }
  return "The request failed.";
}

/** Reload the page, which is the end of a setup that worked. */
function reloadPage(): void {
  if (typeof window === "undefined") return;
  window.location.reload();
}

/** Step 1: open the login panel. A close of the panel reads the list again. */
export function pressSetupLogin(): void {
  openLoginPanelInSlot();
}

/** Whether the form holds what a save needs. */
export function setupCanSave(): boolean {
  if (setupSaving.value || splitModelKey(setupModel.value) === null) return false;
  return !setupWorkerOpen.value || splitModelKey(setupWorker.value) !== null;
}

/** The body the form sends: only the fields the operator chose. */
export function setupBody(): SetupModelRequest | null {
  const main = splitModelKey(setupModel.value);
  if (main === null) return null;
  const worker = setupWorkerOpen.value ? splitModelKey(setupWorker.value) : null;
  return {
    provider: main.provider,
    model: main.model,
    thinking: setupThinking.value,
    ...(worker === null ? {} : { workerProvider: worker.provider, workerModel: worker.model }),
    ...(setupExisting.value.length > 0 && setupForce.value ? { force: true } : {}),
  };
}

/** Step 2: save the choice and load the configuration, in one request. */
export async function saveSetup(): Promise<void> {
  const body = setupBody();
  if (body === null || !setupCanSave()) return;
  setupSaving.value = true;
  setupError.value = "";
  try {
    await request("/api/admin/model-setup", { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    setupError.value = refusalText(error);
    setupSaving.value = false;
    return;
  }
  setupSaving.value = false;
  reloadPage();
}

/** Step 3: ask the daemon to read config.json again. */
export async function reloadSetup(): Promise<void> {
  if (setupReloading.value) return;
  setupReloading.value = true;
  setupIssues.value = [];
  try {
    await request("/api/admin/reload", { method: "POST", body: "{}" });
  } catch (error) {
    const issues = (error instanceof ApiError ? (error.body as { issues?: unknown } | undefined)?.issues : undefined);
    setupIssues.value = Array.isArray(issues) && issues.length > 0 ? issues.map(String) : [refusalText(error)];
    setupReloading.value = false;
    return;
  }
  setupReloading.value = false;
  // A reload that worked ends setup mode only when the new file names a model.
  await refreshStatus();
  if (!modelSetupRequired.value) reloadPage();
  else setupIssues.value = ["The configuration loaded, but it still names no model."];
}

/** Copy the server command, when the browser lets the page write to the clipboard. */
export async function copySetupCommand(): Promise<void> {
  const board = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (board === undefined || typeof board.writeText !== "function") {
    setupCopyNote.value = "Copy failed: the clipboard is only available over HTTPS or on localhost.";
    return;
  }
  try {
    await board.writeText(SETUP_COMMAND);
    setupCopyNote.value = "Copied.";
  } catch {
    setupCopyNote.value = "Copy failed: the clipboard is only available over HTTPS or on localhost.";
  }
}

/** Read the list when the card appears, and again whenever the login panel closes. */
export function startSetup(): void {
  void refreshSetupModels();
}

// A login that just ended changes which providers are signed in.
onPaneClose("login", () => {
  if (modelSetupRequired.value) void refreshSetupModels();
});

/** Put this module back where a freshly loaded page starts. */
export function resetSetupState(): void {
  setupLoaded.value = false;
  setupProviders.value = [];
  setupExisting.value = [];
  setupModel.value = "";
  setupThinking.value = "medium";
  setupWorkerOpen.value = false;
  setupWorker.value = "";
  setupForce.value = false;
  setupSaving.value = false;
  setupReloading.value = false;
  setupError.value = "";
  setupIssues.value = [];
  setupCopyNote.value = "";
}
