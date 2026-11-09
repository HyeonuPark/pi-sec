/**
 * What the header says about the run, the model and the connection, and whether
 * the composer may take a message.
 *
 * Every value here comes from the server: a snapshot, a run frame, the status
 * route. Nothing here is the user's own state, so a stream event may write any of
 * it. What the user typed stays in the composer's own module.
 *
 * The one value other parts read is {@link canSend}: the activity ring turning is
 * the page saying it cannot take a message now, so Send and Enter both wait. A
 * lost connection outranks a run, because a page that cannot reach the server
 * cannot take a message either.
 */
import { computed, signal } from "@preact/signals";
import { request } from "../api/request.ts";
import type {
  AdminStatus,
  ModelId,
  ProviderEntry,
  ProviderList,
  ToolSnapshot,
  UsageHoldView,
} from "../../shared/wire/conversation.ts";
import { applyStatus } from "./notes.ts";
import { showError } from "./toast.ts";

/** How long a lost connection turns the ring before the toast says so. */
export const DISCONNECT_TOAST_DELAY_MS = 5000;

/** The sentence a lost connection says once the wait is over. */
export const LOST_CONNECTION = "Connection lost — retrying…";

/** The stage of the activity ring: empty at rest. */
export type ActivityStage = "" | "offline" | "tool" | "model";

/** Whether the stream this page listens to is open. */
export const connected = signal(false);

/**
 * True while the daemon has no model configured (`agent.vmodel` is empty). The
 * page then shows the setup card, keeps the composer off, and does not call the
 * missing chat stream "offline".
 */
export const modelSetupRequired = signal(false);

/** Whether a run is active, as the snapshot and the run frames say. */
export const running = signal(false);

/** True while an answer is being written. Nothing of it is drawn until it is complete. */
export const writing = signal(false);

/** True while one send is on its way, so the button stays down for it. */
export const sending = signal(false);

/** The model the shown conversation runs on, or `null` before the first snapshot. */
export const model = signal<ModelId | null>(null);

/** One tool call still in flight, by call id. */
export interface LiveTool {
  readonly name: string;
  readonly done: boolean;
}

/**
 * The calls in flight, by call id.
 *
 * Their growing output is kept apart ({@link toolOutputs}) so that one output
 * frame redraws the text of one panel and no row around it.
 */
export const liveTools = signal<ReadonlyMap<string, LiveTool>>(new Map());

/** The output of each live call, by call id. Read only by the panel that shows it. */
export const toolOutputs = signal<ReadonlyMap<string, string>>(new Map());

/** True while the server compacts the context: the transient row above the composer. */
export const compacting = signal(false);

/** A committed core change is not what this process booted from. */
export const restartRequired = signal(false);

/** The batch is closed and its gate passed, so a restart now is the right move. */
export const restartReady = signal(false);

/** The config on disk failed to load; the running config is the last one that did. */
export const configError = signal<AdminStatus["configError"]>(null);

/**
 * The providers whose usage limit is holding conversations right now.
 *
 * It is a list, because a recovery is judged per provider: two accounts over
 * their quota at once are two holds, and one of them recovering says nothing about
 * the other. Empty means nothing is held, which is what takes the banner down.
 */
export const usageHold = signal<readonly UsageHoldView[]>([]);

/** The provider of the root conversation's model, and whether it has a credential. */
export const rootProvider = signal<string | null>(null);
export const providers = signal<readonly ProviderEntry[]>([]);

/**
 * What the agent is doing right now, for the header ring. Empty when it is idle.
 *
 * A run is either waiting on the model or running a tool, so the ring is on for the
 * whole of a run and its stage says which half: `tool` while a call has not
 * finished, `model` for everything else. A finished call that has not been
 * committed yet does not count; its result is already decided.
 *
 * A lost connection outranks a run: a page that cannot reach the server says so in
 * red, whatever the run it last heard about was doing.
 */
export const activityStage = computed<ActivityStage>(() => {
  // No model means no root conversation to reach: the card says so, not the ring.
  if (modelSetupRequired.value) return "";
  if (!connected.value) return "offline";
  if (!running.value) return "";
  for (const tool of liveTools.value.values()) if (!tool.done) return "tool";
  return "model";
});

/** Whether the composer may take a message now. */
export const canSend = computed<boolean>(
  () => !modelSetupRequired.value && activityStage.value === "" && !sending.value,
);

/**
 * Whether the agent is busy on a page that can still reach it: a run is active,
 * the stream is open and no send is on its way. A press on Send queues the
 * message in this state. Every other reason the composer is closed (offline, no
 * model, a send on its way) is not busy.
 */
export const agentBusy = computed<boolean>(
  () => (activityStage.value === "tool" || activityStage.value === "model") && !sending.value,
);

/** Forget every live call. */
export function clearTools(): void {
  liveTools.value = new Map();
  toolOutputs.value = new Map();
}

/** Take the calls a snapshot carries: a page that reconnected missed their start. */
export function drawSnapshotTools(tools: readonly ToolSnapshot[] | undefined): void {
  if (!Array.isArray(tools)) return;
  const calls = new Map<string, LiveTool>();
  const outputs = new Map<string, string>();
  for (const tool of tools) {
    // A `pending` call is not drawn: its row appears when the call starts.
    if (tool?.status !== "running" && tool?.status !== "done") continue;
    calls.set(tool.callId, { name: tool.name ?? "tool", done: tool.status === "done" });
    outputs.set(tool.callId, tool.output ?? "");
  }
  liveTools.value = calls;
  toolOutputs.value = outputs;
}

/** Start one call, or move one that is already here. */
export function startTool(callId: string, name: string): void {
  const calls = new Map(liveTools.value);
  calls.set(callId, { name, done: false });
  liveTools.value = calls;
  const outputs = new Map(toolOutputs.value);
  outputs.set(callId, "");
  toolOutputs.value = outputs;
}

/** Write one output frame into the call it belongs to. */
export function updateTool(callId: string, output: { readonly set?: string; readonly append?: string } | undefined): void {
  if (!liveTools.value.has(callId)) return;
  const previous = toolOutputs.value.get(callId) ?? "";
  const next = output?.set !== undefined ? output.set : output?.append !== undefined ? previous + output.append : previous;
  if (next === previous) return;
  const outputs = new Map(toolOutputs.value);
  outputs.set(callId, next);
  toolOutputs.value = outputs;
}

/** Mark one call finished. Its row stops being a live panel. */
export function endTool(callId: string): void {
  const tool = liveTools.value.get(callId);
  if (tool === undefined) return;
  const calls = new Map(liveTools.value);
  calls.set(callId, { ...tool, done: true });
  liveTools.value = calls;
}

/** What the toast a lost connection waits for holds, and when the loss started. */
let disconnectToastTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectedAt = 0;

/**
 * Start the wait a lost connection gets before the toast says so.
 *
 * The first seconds are the ring alone. A phone freezes a tab and wakes it with
 * the stream gone, and that is back in well under a second: a toast for every one
 * of those is noise the operator learns to ignore.
 */
export function startDisconnectWait(): void {
  if (disconnectedAt !== 0) return;
  disconnectedAt = Date.now();
  disconnectToastTimer = setTimeout(() => {
    disconnectToastTimer = undefined;
    if (!connected.value) showError(LOST_CONNECTION);
  }, DISCONNECT_TOAST_DELAY_MS);
}

/** The connection is up: the ring and the toast both forget it was ever lost. */
export function endDisconnectWait(): void {
  if (disconnectToastTimer !== undefined) clearTimeout(disconnectToastTimer);
  disconnectToastTimer = undefined;
  disconnectedAt = 0;
}

/** Whether the toast has already spoken for the loss that is going on. */
export function disconnectToastSpoken(): boolean {
  return disconnectedAt !== 0 && disconnectToastTimer === undefined;
}

/**
 * Read the daemon's status: the restart banner, the failed config reload, and the
 * notes the sidebar shows.
 *
 * One route answers three things, so it is read once and its answer is handed to
 * all three: the hand-written page did the same (`refreshStatus` filled
 * `state.notes` and drew both), and a second read of the same route for the notes
 * would put the same facts on the wire twice.
 */
export async function refreshStatus(): Promise<void> {
  try {
    const data = await request<AdminStatus>("/api/admin/status");
    modelSetupRequired.value = data?.modelSetupRequired === true;
    restartRequired.value = data?.restartRequired === true;
    restartReady.value = data?.restartReady === true;
    configError.value = data?.configError ?? null;
    usageHold.value = Array.isArray(data?.usageHold) ? data.usageHold : [];
    applyStatus(data);
  } catch {
    /* a status that cannot be read says nothing; the page is otherwise working */
  }
}

/**
 * Read the provider list, for the one banner that says the root model has no
 * credential.
 *
 * It is read from the login routes and from nowhere else on purpose: a fresh
 * install answers 503 from the two chat GET routes, and the operator who needs
 * this line is looking at exactly that daemon.
 */
export async function refreshProviders(): Promise<void> {
  try {
    const data = await request<ProviderList>("/api/admin/model-login/providers");
    providers.value = Array.isArray(data?.providers) ? data.providers : [];
    rootProvider.value = typeof data?.rootProvider === "string" ? data.rootProvider : null;
  } catch {
    /* a hint is not worth an error line on a page that is otherwise working */
  }
}

/** The provider entry the root model belongs to, when the list knows it. */
export const rootProviderEntry = computed<ProviderEntry | undefined>(() => {
  const id = rootProvider.value;
  if (id === null) return undefined;
  return providers.value.find((entry) => entry.id === id);
});
