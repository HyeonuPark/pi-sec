/**
 * The Machines panel: one row per remote machine, with its level and its links.
 *
 * The shell carries `#machines-panel`, and this component draws the whole section,
 * so it can hide itself the way the Notes panel does: no machine registered means
 * no panel, because an empty one would be a promise with nothing behind it.
 *
 * A row is three things, in the order the operator reads them:
 *
 *   1. The machine's name and address.
 *   2. A slider of three positions, `off`, `restricted` and `on`. The position the
 *      machine holds is pressed-in, and a press sends one `POST`. A refused press
 *      writes the reason under the slider and the mark returns to what the server
 *      last said. While a tightening is being applied, the position that waits is
 *      drawn in the waiting colour and one line under the slider says what waits.
 *   3. One line per user, main user first, with that user's link state. The state
 *      word is text, not colour alone, and an `unreachable` line names when it
 *      started and why.
 *
 * When every connection to a machine is stopped, one red line says so and says
 * why. That line is the only place the panel says "connections stopped": the user
 * lines beside it say `unreachable`, which is what one check found, and the block
 * line says why nothing further was tried.
 */
import {
  MACHINE_LEVELS,
  type MachineLevel,
  type MachineUserState,
  type RemoteMachineState,
} from "../../../shared/wire/remote-machines.ts";
import { isFolded } from "../../state/folds.ts";
import { machineErrors, machines, machinesVisible, markedLevel, setMachineLevel } from "../../state/machines.ts";
import { zoneRowStamp, zoneStamp } from "../../state/jobs.ts";
import { PanelFold } from "../sidebar/PanelFold.tsx";

/** What each level means, as the slider's tooltip says it. */
const LEVEL_TITLES: Readonly<Record<MachineLevel, string>> = {
  off: "Off: pi-sec does not connect to this machine",
  restricted: "Restricted: light work only",
  on: "On: heavy work allowed",
};

/** One user's line: `alice · reachable`, or the reason it is not. */
function userLine(user: MachineUserState): string {
  const name = String(user.name);
  const state = String(user.state ?? "unknown");
  if (state === "unreachable") {
    const since = typeof user.since === "number" ? ` since ${zoneRowStamp(user.since)}` : "";
    const why = typeof user.error === "string" && user.error !== "" ? ` (${user.error})` : "";
    return `${name} · unreachable${since}${why}`;
  }
  // A machine at `off` was not checked at all, which is a different fact from a
  // check that has not run yet: the panel says which of the two it is.
  if (state === "not-checked") return `${name} · not checked (off)`;
  return `${name} · ${state}`;
}

/** The line that says why every connection to this machine is stopped. */
function blockLine(machine: RemoteMachineState): string | null {
  const blocked = machine.blocked;
  if (blocked === null || blocked === undefined) return null;
  const reason = blocked.reason === "machine-id-mismatch" ? "machine-id mismatch" : "host key mismatch";
  return `${reason}: connections stopped (${zoneStamp(blocked.at)})`;
}

/** The line that says a tightening is still being applied, or null. */
export function pendingLine(machine: RemoteMachineState): string | null {
  const pending = machine.pending;
  if (pending === null || pending === undefined) return null;
  const runs = pending.runs;
  const line = `pending: stopping ${runs} ${runs === 1 ? "run" : "runs"}`;
  // The core has to reach the machine to stop anything, so a machine whose users
  // are all unreachable says why the wait is still there.
  const users = machine.users ?? [];
  const offline = users.length > 0 && users.every((user) => user.state === "unreachable");
  return offline ? `${line}, no connection` : line;
}

/** The three-position slider of one machine. */
function LevelSlider({ machine }: { machine: RemoteMachineState }) {
  const marked = markedLevel(machine);
  // The wait keeps the level the slider moved to, so its button is the marked one
  // and carries the waiting colour instead of the applied one.
  const waiting = machine.pending?.level;
  const error = machineErrors.value[machine.id];
  return (
    <div class="machine-level">
      <div class="machine-slider" role="group" aria-label={`Level for ${machine.id}`}>
        {MACHINE_LEVELS.map((level) => {
          const waitingHere = level === waiting;
          const pressed = level === marked;
          const classes = ["machine-level-button"];
          if (waitingHere) classes.push("pending");
          else if (pressed) classes.push("marked");
          return (
            <button
              type="button"
              key={level}
              class={classes.join(" ")}
              data-machine-level={level}
              data-machine-id={machine.id}
              data-machine-waiting={waitingHere ? "true" : undefined}
              aria-pressed={pressed ? "true" : "false"}
              title={LEVEL_TITLES[level]}
              onClick={() => void setMachineLevel(machine.id, level)}
            >
              {level}
            </button>
          );
        })}
      </div>
      {error === undefined ? null : (
        <p class="machine-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** One machine. */
function MachineRow({ machine }: { machine: RemoteMachineState }) {
  const blocked = blockLine(machine);
  const waiting = pendingLine(machine);
  return (
    <div class="machine-row" data-machine-row={machine.id}>
      <div class="machine-head">
        <span class="machine-name" title={machine.id}>
          {machine.id}
        </span>
        <span class="machine-address">
          {machine.port === 22 ? machine.address : `${machine.address}:${machine.port}`}
        </span>
      </div>
      <LevelSlider machine={machine} />
      {waiting === null ? null : (
        <p class="machine-pending" data-machine-pending={machine.id}>
          {waiting}
        </p>
      )}
      <div class="machine-users">
        {machine.users.map((user) => (
          <div class="machine-user" key={user.name} data-machine-user={user.name} data-link-state={user.state}>
            {userLine(user)}
          </div>
        ))}
      </div>
      {machine.hostKey === "unpinned" ? <p class="machine-note">host key not pinned</p> : null}
      {blocked === null ? null : (
        <p class="machine-block" role="alert" title={machine.blocked?.detail ?? undefined}>
          {blocked}
        </p>
      )}
    </div>
  );
}

/**
 * Whether a machine's connections are stopped, which is what the folded heading
 * warns about.
 *
 * The record says it in one field: `blocked` carries the reason and the moment
 * when every connection to the machine was stopped (a host key that changed, or
 * a machine id that does not match). The panel's red line reads the same field,
 * and the fold hides that line, so the heading has to say it instead.
 */
export function machineStopped(machine: RemoteMachineState): boolean {
  return machine.blocked !== null && machine.blocked !== undefined;
}

/** Whether any registered machine is stopped. */
export function anyMachineStopped(): boolean {
  return machinesVisible() && machines.value.some(machineStopped);
}

/** The panel the shell carries as `#machines-panel`. */
export function MachinesPanel() {
  const list = machines.value;
  const empty = !machinesVisible();
  const stopped = isFolded("machines") && anyMachineStopped();
  return (
    <section id="machines-panel" class={empty ? "panel hidden" : "panel"} data-panel="machines">
      <h2>
        <PanelFold panel="machines" label="Machines" controls="machines" />
        <span id="machines-stopped" class={stopped ? "badge badge-stopped" : "badge badge-stopped hidden"} role="alert">
          {stopped ? "stopped" : ""}
        </span>
      </h2>
      <div id="machines" class="machines">
        {list.map((machine) => (
          <MachineRow machine={machine} key={machine.id} />
        ))}
      </div>
    </section>
  );
}
