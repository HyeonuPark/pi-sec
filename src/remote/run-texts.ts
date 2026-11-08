/**
 * The six texts a run check delivers to the conversation that started the run.
 *
 * The texts are the approved wording, word for word: they are core
 * strings, they are English like the rest of the code's own text, and the values
 * in angle brackets are filled in by the functions below.
 *
 * They arrive as a message from the `system` source with `via="remote-machines"`,
 * in the conversation the run was started from, and they are written for whoever
 * is reading that conversation. So each one says what was found and what the
 * reader can do next, in the same order: what the run is, what was measured, and
 * which tool reads or stops it.
 *
 * `<when>` is a moment already formatted in the harness zone
 * (`zoneMinute`), because a conversation is read by a person as well as by an
 * agent, and the reader expects the local clock.
 */

/** The fields every check message names. */
export interface RunCheckCommon {
  readonly run: string;
  readonly machine: string;
  readonly user: string;
}

/**
 * The message for a run that is still going.
 *
 * `when` is when the output file last grew, not when the check ran: that moment
 * is what tells a reader whether the command is making progress or is waiting.
 */
export function runningCheckText(input: RunCheckCommon & { readonly when: string; readonly bytes: number }): string {
  return `[remote run check] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} is still running. Its output was last written at ${input.when} and is ${String(input.bytes)} bytes now. Read it with remote_run_status, and stop it with remote_run_stop if it must stop.`;
}

/** The message for a run that left an exit code. */
export function finishedCheckText(input: RunCheckCommon & { readonly when: string; readonly code: number }): string {
  return `[remote run check] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} finished at ${input.when} with exit code ${String(input.code)}. Read its output with remote_run_status.`;
}

/** The message for a run whose process is gone and which wrote no exit code. */
export function lostCheckText(input: RunCheckCommon): string {
  return `[remote run check] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} is lost: it wrote no exit code and its process is gone. This happens when the machine reboots or sleeps, or when someone kills the process. Its output file holds what it printed. Nothing was restarted.`;
}

/**
 * The message for a run somebody stopped.
 *
 * `who` is `you` when the agent that started the run called `remote_run_stop`,
 * and `the core` when the core stopped it because the level became stricter. The reader of this message is that same agent.
 */
export function stoppedCheckText(input: RunCheckCommon & { readonly when: string; readonly who: string }): string {
  return `[remote run check] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} was stopped at ${input.when}, by ${input.who}. Work it already did is not undone.`;
}

/** The message for a check that could not reach the machine at all. */
export function unreachableCheckText(input: RunCheckCommon & { readonly reason: string }): string {
  return `[remote run check] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} cannot be read: ${input.reason}. The run can still be going. The core checks again shortly.`;
}

/**
 * The message for a run the core stopped watching, because it made the machine off.
 *
 * It is not the answer of a check, which is why its prefix is not the check's: no
 * check read this run, and the core has no fact about its end. It says the truth the
 * core does have (the machine went `off` after the threshold, and the run's end is
 * unknown), the one way the run can still be alive, and the tool that reads it after
 * the user raises the level again. `remote_run_status` still answers about such a
 * run: the level and the machine decide whether it can, not the settled flag.
 */
export function strandedRunText(input: RunCheckCommon): string {
  return `[remote machine off] Run ${input.run} on remote machine "${input.machine}" for user ${input.user} is stranded: the machine did not answer for longer than the outage threshold, so pi-sec made its level off and stopped watching this run. Its end is unknown. The command can still be running if the machine was only cut off from the network. Read it with remote_run_status after the user raises the level again.`;
}
