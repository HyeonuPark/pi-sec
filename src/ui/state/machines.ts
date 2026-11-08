/**
 * The Machines panel's list, and the one press it sends.
 *
 * The list is read from `GET /api/remote-machines` and drawn from a signal. The
 * conversation stream's `remote_machine_updated` frame says that something
 * changed and not what, so the list is read back: a burst of frames is one read,
 * the way the job tree already does it, and a press that fails writes one sentence
 * under the slider it came from.
 *
 * The level a machine has and the level a press asked for are two different
 * things while the request is in flight. The panel draws the asked-for level as
 * the marked one until the answer arrives, so a press does not look ignored; when
 * the answer is a failure, the mark goes back to what the server last said and the
 * reason is shown.
 *
 * A tightening is a third thing: the server stores the level at once and then
 * stops the runs that no longer fit it, and `pending` says that the second part is
 * still running. Every answer is read through {@link readPending}, so the panel
 * sees `null` or the wait and never an absent field.
 */
import { signal } from "@preact/signals";
import {
  isMachineLevel,
  type MachineLevel,
  type MachinePending,
  type RemoteMachineState,
  type RemoteMachinesResponse,
} from "../../shared/wire/remote-machines.ts";
import { request } from "../api/request.ts";

/** How long a burst of frames is collected before the one read it costs. */
export const MACHINES_REFRESH_WINDOW_MS = 500;

/** The machines the server last answered with, in config order. */
export const machines = signal<readonly RemoteMachineState[]>([]);

/** Whether `config.json` declares the feature. False hides the panel. */
export const machinesEnabled = signal(false);

/** The level each machine's press asked for, by machine id, until it is answered. */
export const pendingLevels = signal<Readonly<Record<string, MachineLevel>>>({});

/** The reason a press failed, by machine id. */
export const machineErrors = signal<Readonly<Record<string, string>>>({});

/**
 * Whether the panel is drawn at all.
 *
 * Both conditions are needed: the feature is on, and at least one machine is
 * registered. A panel with no machine in it would be a promise with nothing
 * behind it, which is the rule the Notes panel already follows.
 */
export function machinesVisible(): boolean {
  return machinesEnabled.value && machines.value.length > 0;
}

/** The level the panel marks for one machine: the asked-for one, else the stored one. */
export function markedLevel(machine: RemoteMachineState): MachineLevel {
  return pendingLevels.value[machine.id] ?? machine.level;
}

/**
 * The wait one machine is in, read from an answer that may not carry one.
 *
 * Three answers reach this function. An early server declared the field as always null,
 * a server that predates the wait does not send the field at all, and a current
 * server fills it in. All three are read into one of two values, so the panel has
 * one shape to draw: `null` while nothing waits, and the wait itself otherwise.
 *
 * A wait needs the level and the run count, because those are what the panel
 * writes. A value that lacks either is read as no wait rather than as a line with
 * a hole in it. The two instants are not drawn, so a value that lacks one is
 * still a wait, with the instant read as 0.
 */
export function readPending(value: unknown): MachinePending | null {
  if (value === null || typeof value !== "object") return null;
  const pending = value as Partial<MachinePending>;
  if (!isMachineLevel(pending.level)) return null;
  const runs = pending.runs;
  if (typeof runs !== "number" || !Number.isFinite(runs) || runs < 0) return null;
  const instant = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  return {
    level: pending.level,
    since: instant(pending.since),
    deadline: instant(pending.deadline),
    runs: Math.floor(runs),
  };
}

/** One machine as the panel holds it, with the wait read into its one shape. */
function readMachine(machine: RemoteMachineState): RemoteMachineState {
  return { ...machine, pending: readPending(machine.pending) };
}

/** Take one answer from the server, and clear what the press left behind. */
export function applyMachinesAnswer(answer: RemoteMachinesResponse | undefined): void {
  const list = Array.isArray(answer?.machines) ? answer.machines : [];
  machines.value = list.map(readMachine);
  machinesEnabled.value = answer?.enabled === true;
}

/** Read the list once. A failed read keeps the last one on screen. */
export async function readMachines(): Promise<void> {
  try {
    applyMachinesAnswer(await request<RemoteMachinesResponse>("/api/remote-machines"));
  } catch {
    /* the last list stays: a panel that empties itself on one bad read is worse */
  }
}

/** The read in flight, if any. */
let readInFlight: Promise<void> | null = null;
/** One more read is wanted once the read in flight ends. */
let readAgain = false;
/** The window timer, while it is open. */
let windowTimer: ReturnType<typeof setTimeout> | undefined;
/** Frames arrived while the tab was hidden. */
let missed = false;

/** Read the list, unless a read is already running. */
export function refreshMachines(): Promise<void> {
  if (readInFlight !== null) {
    readAgain = true;
    return readInFlight;
  }
  readInFlight = readMachines().finally(() => {
    readInFlight = null;
    if (readAgain) {
      readAgain = false;
      void refreshMachines();
    }
  });
  return readInFlight;
}

/**
 * A `remote_machine_updated` frame: read the list back, at most once per window.
 *
 * A hidden tab holds the read until it is looked at again, the same rule the job
 * tree keeps: a page nobody looks at pays nothing.
 */
export function applyMachineEvent(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missed = true;
    return;
  }
  if (windowTimer !== undefined) return;
  windowTimer = setTimeout(() => {
    windowTimer = undefined;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      missed = true;
      return;
    }
    void refreshMachines();
  }, MACHINES_REFRESH_WINDOW_MS);
}

/** The tab came back: read the list once, which covers the frames it missed. */
export async function machinesTabVisible(): Promise<void> {
  missed = false;
  await refreshMachines();
}

/** Whether a frame arrived while the tab was hidden, for a caller that asks. */
export function machinesMissedWhileHidden(): boolean {
  return missed;
}

/** One level press, its request, and what the answer did to the panel. */
export async function setMachineLevel(id: string, level: MachineLevel): Promise<void> {
  const before = machines.value.find((machine) => machine.id === id);
  if (before !== undefined && before.level === level && pendingLevels.value[id] === undefined) return;
  pendingLevels.value = { ...pendingLevels.value, [id]: level };
  machineErrors.value = omit(machineErrors.value, id);
  try {
    const answer = await request<RemoteMachineState>(`/api/remote-machines/${encodeURIComponent(id)}/level`, {
      method: "POST",
      body: JSON.stringify({ level }),
    });
    // The answer is the changed machine alone, so the list is patched rather than
    // replaced: a machine the answer does not mention keeps what it had.
    if (answer !== undefined && typeof answer.id === "string") {
      const changed = readMachine(answer);
      machines.value = machines.value.map((machine) => (machine.id === changed.id ? changed : machine));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    machineErrors.value = { ...machineErrors.value, [id]: message };
  } finally {
    pendingLevels.value = omit(pendingLevels.value, id);
  }
}

/** The same record without one key. */
function omit<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (record[key] === undefined) return record;
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
}

/** Put this module back where a freshly loaded page starts. */
export function resetMachinesState(): void {
  if (windowTimer !== undefined) clearTimeout(windowTimer);
  windowTimer = undefined;
  readInFlight = null;
  readAgain = false;
  missed = false;
  machines.value = [];
  machinesEnabled.value = false;
  pendingLevels.value = {};
  machineErrors.value = {};
}
