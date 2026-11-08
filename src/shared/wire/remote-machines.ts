/**
 * What `GET /api/remote-machines` answers, and what a level change returns.
 *
 * The server's own copy of these shapes is `src/documents.ts`
 * (`RemoteMachineRecord`) and `src/remote/machines.ts` (the state it builds from
 * that record and from the config). They are written out again here because the
 * page type check must not pull the server's Node imports in with them: the field
 * names and the closed unions are the contract, and a field added on the server
 * is added here with it.
 *
 * A machine appears in this answer only while `config.json` names it. A record
 * left behind by a machine removed from the config is kept in the store and is
 * not shown, so the answer is a view of the config with the stored state
 * attached.
 */

/**
 * How much this install may do on a machine.
 *
 * `off` means no connection at all, `restricted` allows light work, `on` allows
 * heavy work. The level is stored and shown on its own: the difference
 * between `restricted` and `on` comes from the tools. All three orders are listed weakest first, and the index of a
 * level in this list is its rank (see {@link levelRank}).
 */
export type MachineLevel = "off" | "restricted" | "on";

/** Every level, weakest first. */
export const MACHINE_LEVELS: readonly MachineLevel[] = ["off", "restricted", "on"];

/** Whether a value is one of the three levels. */
export function isMachineLevel(value: unknown): value is MachineLevel {
  return typeof value === "string" && (MACHINE_LEVELS as readonly string[]).includes(value);
}

/**
 * How wide the permissions a level gives are: 0 for `off`, 1 for `restricted`,
 * 2 for `on`.
 *
 * Loosening is a move to a higher rank and tightening a move to a lower one, so
 * the one comparison that decides which of the two happened lives here.
 */
export function levelRank(level: MachineLevel): number {
  return MACHINE_LEVELS.indexOf(level);
}

/** Whether the move from `from` to `to` gives wider permissions. */
export function loosens(from: MachineLevel, to: MachineLevel): boolean {
  return levelRank(to) > levelRank(from);
}

/**
 * What the last check of one user's connection found.
 *
 * `not-checked` is what a machine at `off` reports: no heartbeat was sent, so
 * there is nothing to say about that user's connection. `unknown` is a machine
 * that has been asked for a check but has no answer yet.
 */
export type MachineLinkState = "reachable" | "unreachable" | "not-checked" | "unknown";

/** One user's connection, as the panel shows it. */
export interface MachineUserState {
  /** The ssh user. The first one in the config is the main user. */
  readonly name: string;
  readonly state: MachineLinkState;
  /** When the state was last written. Absent while nothing has been checked. */
  readonly since?: number | null;
  /** The last line of ssh's error, for `unreachable`. */
  readonly error?: string | null;
}

/** Why every connection to a machine is stopped. */
export type MachineBlockReason = "host-key-mismatch" | "machine-id-mismatch";

/** A stopped machine, and the moment it was stopped. */
export interface MachineBlock {
  readonly reason: MachineBlockReason;
  readonly at: number;
  /** The ssh line, or the values that disagreed. For the panel's tooltip. */
  readonly detail: string;
}

/**
 * A stricter level that waits until the runs that do not fit it are stopped.
 *
 * The new level is stored at once when the user moves the slider; this is the wait
 * that follows, and it lasts until the runs that no longer fit have ended or the
 * core has stopped them. The panel draws the pending step in another colour and
 * puts one line under the slider while it is set.
 */
export interface MachinePending {
  /** The level the user chose; it is already stored. */
  readonly level: MachineLevel;
  /** When the wait started, in epoch milliseconds. */
  readonly since: number;
  /** When the core stops whatever is left, in epoch milliseconds. */
  readonly deadline: number;
  /** How many runs still do not fit. */
  readonly runs: number;
}

/**
 * One machine as the panel draws it.
 *
 * `pending` is `null` except while a tightening is being applied. A reader that
 * treats `null` and a missing field alike keeps working across both shapes.
 */
export interface RemoteMachineState {
  readonly id: string;
  readonly address: string;
  readonly port: number;
  /** The main user first, then the secondary users, in config order. */
  readonly users: readonly MachineUserState[];
  readonly level: MachineLevel;
  /** When the level was last changed, or null while it was never changed. */
  readonly levelChangedAt: number | null;
  /** The tightening that is being applied, or null. */
  readonly pending: MachinePending | null;
  /** Whether the pinned host key file holds this machine's key. */
  readonly hostKey: "pinned" | "unpinned";
  /** Why connections are stopped, or null while they are not. */
  readonly blocked: MachineBlock | null;
}

/** The answer to `GET /api/remote-machines`. */
export interface RemoteMachinesResponse {
  /**
   * Whether `config.json` declares `remoteMachines` at all. A false value means
   * the feature is off: the panel hides, and the list is empty.
   */
  readonly enabled: boolean;
  /** Machines in config order. */
  readonly machines: readonly RemoteMachineState[];
}

/** The payload of a `remote_machine_updated` frame on the conversation stream. */
export interface RemoteMachineEventFrame {
  /** The machine whose state changed. A page re-reads the list for any value. */
  readonly id?: string;
}
