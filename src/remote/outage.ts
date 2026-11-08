/**
 * The long outage: does an outage start, continue or end, and is the automatic off due?
 *
 * A machine that stops answering while the user did not set it to `off` is the one
 * case this feature acts on without being asked. The decision is here, alone, so it
 * can be read and tested without a store, a clock or an ssh call: given the stored
 * outage, the users' states, the level, the block and the clock, it answers what the
 * heartbeat round does next.
 *
 * `src/remote/machines.ts` calls this after each round of one machine and carries
 * the answer out: it makes the level `off` in one commit, settles the runs that were
 * live, writes the user's inbox item and sends the notice. Nothing in this module
 * reads or writes anything.
 *
 * ## The definitions the table uses
 *
 *   - A user answered when the last heartbeat of that user came back with the
 *     machine's id. A user with no state at all was never checked, so it neither
 *     answers nor counts as unreachable: a machine whose host key is not pinned
 *     writes no state, and a machine that was never reached never starts an outage.
 *   - No user answered when every user that has a state reads `unreachable`. Any ssh
 *     failure counts, so a refused connection, a timeout, no route and a refused key
 *     all read the same way; the notice carries the error text, which is how the
 *     operator tells a machine that is off from an account that stopped working.
 *   - The outage starts at the moment the core first saw the machine down, and that
 *     moment is the record's own `since`. A user's `since` is not used: it moves
 *     whenever the failure text changes, and it is written per user.
 *   - The outage ends when any user answers, when the level becomes `off`, or when a
 *     block stops every connection. The record is dropped, and the machine can start
 *     a new outage with a new start.
 *   - One outage makes the level `off` once. The record holds the start and nothing
 *     else, because nothing asks and nothing waits for an answer. A write that fails
 *     leaves the record and the level apart, which is why the next round decides the
 *     same thing again: the level is not `off` yet, so the outage is still one.
 */

import type { RemoteMachineOutageRecord } from "../documents.ts";
import type { MachineLevel } from "../shared/wire/remote-machines.ts";

/** What one round of one machine read, as the decision needs it. */
export interface OutageReading {
  /** The machine's level, as the record holds it. */
  readonly level: MachineLevel;
  /** Whether a block stops every connection to the machine. */
  readonly blocked: boolean;
  /**
   * One entry per user that has a state, in the config's order.
   *
   * A user with no state is left out, because a heartbeat that never ran says
   * nothing about the machine.
   */
  readonly users: readonly { readonly state: string }[];
  /** The stored outage, or undefined while the machine is not in one. */
  readonly outage: RemoteMachineOutageRecord | undefined;
  /** The instant of this round, in epoch milliseconds. */
  readonly now: number;
  /** The threshold, in seconds, as `remoteMachines.outageSeconds` declares it. */
  readonly outageSeconds: number;
}

/** What the round does next about one machine's outage. */
export type OutageDecision =
  /** Write nothing: no outage starts, none ends, and the threshold has not passed. */
  | { readonly kind: "none" }
  /** Drop the stored record: the outage ended, or this machine is not watched. */
  | { readonly kind: "drop" }
  /** Write the record with this start, and do nothing else yet. */
  | { readonly kind: "start"; readonly since: number }
  /** Make the level `off` by itself, because the threshold passed with no answer. */
  | { readonly kind: "off"; readonly since: number };

/**
 * Read one round of one machine.
 *
 * The order is the rule: a block and a level of
 * `off` are read first, because a machine that is stopped or switched off is not a
 * machine that is down, and only then the users, because one user's answer is the
 * whole question.
 */
export function decideOutage(reading: OutageReading): OutageDecision {
  // A block already sent its own notice, and a host key that does not fit is not a
  // machine that is off. The record goes, so a machine that later answers starts a
  // new outage rather than continuing an old one.
  if (reading.blocked) return { kind: "drop" };
  // The round never checked a machine at `off`, and a machine the user switched off
  // is not watched. The user's own act is the answer, and nothing is announced.
  if (reading.level === "off") return { kind: "drop" };

  if (reading.users.some((user) => user.state === "reachable")) return { kind: "drop" };
  const unreachable = reading.users.some((user) => user.state === "unreachable");
  // No user was ever checked, so nothing is known and nothing is written.
  if (!unreachable) return { kind: "none" };

  const outage = reading.outage;
  if (outage === undefined) return { kind: "start", since: reading.now };

  const threshold = reading.outageSeconds * 1000;
  if (reading.now - outage.since < threshold) return { kind: "none" };

  return { kind: "off", since: outage.since };
}
