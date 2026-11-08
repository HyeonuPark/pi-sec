/**
 * The model login panel: which provider to sign in, which way, and where the
 * login got to.
 *
 * The daemon holds one login at a time and hands it an id; every later request
 * names that id in the body. Nothing here puts the id or an answer in a URL, and
 * nothing is written to `localStorage`: a pasted code and an API key are
 * credential material, and the page keeps them only in the field until they are
 * sent.
 *
 * Two rules about redrawing are the reason this module exists in this shape.
 *
 * 1. The progress poll runs once a second, and it writes only what it read. A
 *    value equal to the one on screen changes nothing at all, so a poll that
 *    carried no news does not redraw the form under the operator's hands.
 * 2. What the operator chose — the provider, the login type — and what they are
 *    typing into the answer field are theirs. The first two are signals here; the
 *    third stays in the field the component drew, and the component only draws a
 *    new one when the question itself changes.
 *
 * Together those two are what stops the old behaviour where a key pasted into the
 * answer field was wiped a second later by the next poll.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { closePane, onPaneClose, paneIsOpen, takeSlot } from "./panels.ts";
import { providers as bannerProviders, rootProvider as bannerRootProvider } from "./run.ts";
import { zoneStamp } from "./jobs.ts";
import type {
  LoginProvider,
  LoginProvidersAnswer,
  LoginStartAnswer,
  LoginState,
  LoginStatus,
  LoginType,
} from "../../shared/wire/login.ts";

/* ------------------------------------------------------------- the answer */

/** False when the daemon cannot sign a model provider in at all. */
export const loginAvailable = signal(true);

/** The providers the daemon offers, as the last read answered. */
export const loginProviders = signal<readonly LoginProvider[]>([]);

/** The provider the root conversation's model belongs to, when it resolves. */
export const loginRootProvider = signal<string | null>(null);

/** The session id of the login this page started, while it is live. */
export const loginSession = signal<string | null>(null);

/** The last state read, or `null` before one. */
export const loginState = signal<LoginState | null>(null);

/** The one line under the form: a refusal from the daemon, never a value. */
export const loginError = signal("");

/* ------------------------------------------------------------ the choices */

/** The provider the operator chose. Theirs: a list read again leaves it alone. */
export const chosenProvider = signal("");

/** The login type the operator chose. Theirs, for the same reason. */
export const chosenType = signal("");

/** The providers whose catalog entry says how to sign in at all. */
export function usableProviders(): readonly LoginProvider[] {
  return loginProviders.value.filter((entry) => Array.isArray(entry.types) && entry.types.length > 0);
}

/** The provider the form has selected, or `undefined` when the list is empty. */
export function selectedProvider(): LoginProvider | undefined {
  const id = chosenProvider.value;
  return usableProviders().find((entry) => entry.id === id);
}

/** The login types the selected provider offers. */
export function selectedTypes(): readonly LoginType[] {
  return selectedProvider()?.types ?? [];
}

/** A login type as the form writes it. */
export function loginTypeLabel(type: string): string {
  return type === "oauth" ? "OAuth" : "API key";
}

/** The sentence above the form. */
export function loginIntro(): string {
  return loginAvailable.value ? "Choose a provider and how to sign in." : "This daemon cannot sign a model provider in.";
}

/** The line under the two selects: when this provider last signed in. */
export function loginProviderNote(): string {
  const last = selectedProvider()?.lastLogin;
  if (last === undefined || last === null) return "";
  const at = Date.parse(last.at);
  if (Number.isNaN(at)) return "";
  return `Signed in ${zoneStamp(at)} (${loginTypeLabel(last.type)}).`;
}

/** Whether a login this page started is live, which is what the two buttons follow. */
export function loginIsLive(): boolean {
  return loginSession.value !== null;
}

/* ------------------------------------------------------------- the states */

/** Where a login is: the last four never change again. */
export function loginIsFinal(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timeout";
}

/** The line under the prompt: where the login is, in one sentence. */
export function loginStatusText(state: LoginState | null): string {
  if (state === null) return "";
  const type = loginTypeLabel(state.type);
  if (state.status === "running") return `Waiting for ${state.provider} (${type})…`;
  if (state.status === "prompt") return "Waiting for your answer.";
  if (state.status === "succeeded") {
    const at = typeof state.loginAt === "string" ? Date.parse(state.loginAt) : Number.NaN;
    return Number.isNaN(at) ? "Signed in." : `Signed in: ${zoneStamp(at)}.`;
  }
  if (state.status === "cancelled") return "The login was cancelled.";
  if (state.status === "timeout") return "The login timed out. Start again.";
  if (state.reason === "code_rejected") return "The provider rejected the code.";
  return "The login failed. Start again.";
}

/** What a refused request says. The code is fixed; the daemon's sentence is not repeated. */
export function loginFailureMessage(failure: unknown): string {
  const code = failure instanceof ApiError ? failure.code : "";
  if (code === "login_busy") return "A login is already running. Cancel it, or wait for it to end.";
  if (code === "login_not_found") return "That login session is gone. Start again.";
  if (code === "login_no_prompt") return "The login is not waiting for an answer.";
  if (code === "unknown_provider") return "The daemon does not know that provider.";
  if (code === "login_type_unavailable") return "The provider does not offer that login type.";
  if (code === "login_unavailable") return "This daemon cannot sign a model provider in.";
  if (code === "https_required") return "A login can only start from the host itself, or over HTTPS.";
  if (code === "json_required") return "The request was not sent as JSON.";
  if (code === "origin_forbidden") return "This page is not allowed to send that request.";
  const status = failure instanceof ApiError ? failure.status : 0;
  return status === 0 ? "The request failed." : `The request failed (${status}).`;
}

/**
 * Whether two reads of one login say the same thing.
 *
 * The poll compares the whole answer, because every field of it is drawn: a login
 * that is still running answers the same run of events, the same question and the
 * same times, and that answer must change nothing.
 */
function sameState(a: LoginState | null, b: LoginState | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Put one read of the login's state on screen — and nothing at all when it says
 * what the last one said.
 */
export function applyLoginState(next: LoginState | null): void {
  if (sameState(loginState.value, next)) return;
  loginState.value = next;
}

/* --------------------------------------------------------------- the reads */

/**
 * Read the provider list: the two selects, the note under them, and the idle
 * form's one sentence.
 *
 * A list read again leaves the operator's two choices alone when the list still
 * holds them, and falls back to the root model's provider (the one they most
 * often want) when it does not.
 *
 * One route, one read, two screens. The header's credential line is drawn from
 * `run.ts`'s store and this form from this module's, and the hand-written page had
 * one store for both: a login that ended refreshed it once. So this read fills
 * both stores from the answer it already has, rather than asking the route again
 * for the header's half.
 */
export async function refreshLoginProviders(): Promise<void> {
  let data: LoginProvidersAnswer | undefined;
  try {
    data = await request<LoginProvidersAnswer>("/api/admin/model-login/providers");
  } catch {
    // A hint is not worth an error line on a page that is otherwise working.
    return;
  }
  const listed = Array.isArray(data?.providers) ? data.providers : [];
  const root = typeof data?.rootProvider === "string" ? data.rootProvider : null;
  loginProviders.value = listed;
  loginAvailable.value = data?.available !== false;
  loginRootProvider.value = root;
  // The header's half of the same answer: its banner is drawn from these two.
  bannerProviders.value = listed;
  bannerRootProvider.value = root;

  const usable = usableProviders();
  const chosen = chosenProvider.value;
  if (!usable.some((entry) => entry.id === chosen)) {
    const root = loginRootProvider.value;
    const fallback = usable.find((entry) => entry.id === root) ?? usable[0];
    chosenProvider.value = fallback === undefined ? "" : fallback.id;
  }
  const types = selectedTypes();
  if (!types.includes(chosenType.value as LoginType)) chosenType.value = types[0] ?? "";
}

/**
 * Open the login panel: read the form it should show, and pick up a login this
 * page started that is still running.
 */
export async function openLoginPanel(): Promise<void> {
  loginError.value = "";
  await refreshLoginProviders();
  // A login this page started may still be running after the panel was closed
  // and opened again: read it once more rather than showing a stale form.
  if (loginSession.value !== null) scheduleLoginPoll(0);
}

/* ---------------------------------------------------------------- the poll */

/** The waiting read, as a timer id; undefined when none waits. */
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** The wait before the next read. One second while it runs, two after a failure. */
export const LOGIN_POLL_MS = 1000;

/** The wait after a refused read, so a broken daemon is not hammered. */
export const LOGIN_POLL_AFTER_FAILURE_MS = 2000;

/** The first read after a press, which is sooner because the operator is waiting. */
export const LOGIN_POLL_AFTER_PRESS_MS = 200;

/** Wait, then read the login's state once. */
export function scheduleLoginPoll(delay: number = LOGIN_POLL_MS): void {
  stopLoginPoll();
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void pollLogin();
  }, delay);
}

/** Drop the waiting read. A panel that closes stops asking. */
export function stopLoginPoll(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

/** Read the login's state once, draw it, and come back for the next one. */
export async function pollLogin(): Promise<void> {
  const session = loginSession.value;
  if (session === null) return;
  let state: LoginState;
  try {
    state = await request<LoginState>("/api/admin/model-login/state", {
      method: "POST",
      body: JSON.stringify({ session }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "login_not_found") {
      // A daemon restart drops the session, and so does the retention window.
      loginSession.value = null;
      applyLoginState(null);
      loginStatusGone.value = "That login session is gone. Start again.";
      return;
    }
    loginError.value = loginFailureMessage(error);
    scheduleLoginPoll(LOGIN_POLL_AFTER_FAILURE_MS);
    return;
  }
  // The form is drawn again only if the read named a different session than the
  // one this page holds, which is what a finish changes.
  applyLoginState(state);
  if (loginIsFinal(state.status)) {
    loginSession.value = null;
    // The credential state and the recorded login time have just changed, and
    // the header's line and this form's list are both drawn from them. One read
    // of the route fills both halves, which is what the hand-written page did.
    void refreshLoginProviders();
    return;
  }
  scheduleLoginPoll();
}

/**
 * The sentence a session that is gone leaves behind.
 *
 * It is kept apart from {@link loginError} because it is not a refusal of
 * anything the operator pressed: the read succeeded and the login is simply not
 * there any more.
 */
export const loginStatusGone = signal("");

/* --------------------------------------------------------------- the press */

/** Start a login with the provider and type the form has chosen. */
export async function startLogin(): Promise<void> {
  const provider = chosenProvider.value;
  const type = chosenType.value;
  if (provider === "" || type === "") return;
  loginError.value = "";
  loginStatusGone.value = "";
  let started: LoginStartAnswer;
  try {
    started = await request<LoginStartAnswer>("/api/admin/model-login/start", {
      method: "POST",
      body: JSON.stringify({ provider, type }),
    });
  } catch (error) {
    loginError.value = loginFailureMessage(error);
    return;
  }
  loginSession.value = typeof started?.session === "string" ? started.session : null;
  applyLoginState(started?.state ?? null);
  if (loginSession.value !== null) scheduleLoginPoll(LOGIN_POLL_AFTER_PRESS_MS);
}

/** Hand one answer to the daemon, then read on. The value is not kept here. */
export async function submitLoginAnswer(value: string): Promise<void> {
  const session = loginSession.value;
  if (session === null) return;
  loginError.value = "";
  let state: LoginState;
  try {
    state = await request<LoginState>("/api/admin/model-login/answer", {
      method: "POST",
      body: JSON.stringify({ session, value }),
    });
  } catch (error) {
    loginError.value = loginFailureMessage(error);
    return;
  }
  applyLoginState(state);
  if (loginIsFinal(state.status)) {
    // The answer ended the login, which the next state read would have said a
    // moment later; saying it now is one read less and no wrong form on screen.
    // The provider list is read once, for both the header's line and this form.
    loginSession.value = null;
    void refreshLoginProviders();
    return;
  }
  scheduleLoginPoll(LOGIN_POLL_AFTER_PRESS_MS);
}

/** Ask the daemon to give the login up. A running login is the daemon's, not this page's. */
export async function cancelLogin(): Promise<void> {
  const session = loginSession.value;
  if (session === null) return;
  let state: LoginState;
  try {
    state = await request<LoginState>("/api/admin/model-login/cancel", {
      method: "POST",
      body: JSON.stringify({ session }),
    });
  } catch (error) {
    loginError.value = loginFailureMessage(error);
    return;
  }
  loginSession.value = null;
  applyLoginState(state);
}

/** Open the login panel in the slot, and read what it should show. */
export function openLoginPanelInSlot(): void {
  takeSlot("login");
  void openLoginPanel();
}

/** Close the login panel, if it is the one in the slot. */
export function closeLoginPanel(): void {
  if (paneIsOpen("login")) closePane();
  stopLoginPoll();
}

// A panel that leaves the screen stops asking: the login itself goes on in the
// daemon, and the next open reads it again.
onPaneClose("login", stopLoginPoll);

/** Put this module back where a freshly loaded page starts. */
export function resetLoginState(): void {
  stopLoginPoll();
  loginAvailable.value = true;
  loginProviders.value = [];
  loginRootProvider.value = null;
  loginSession.value = null;
  loginState.value = null;
  loginError.value = "";
  loginStatusGone.value = "";
  chosenProvider.value = "";
  chosenType.value = "";
}

/** The status a panel shows: the gone sentence first, else the state's own. */
export function loginStatusLine(): string {
  if (loginStatusGone.value !== "") return loginStatusGone.value;
  return loginStatusText(loginState.value);
}
