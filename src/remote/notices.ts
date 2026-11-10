/**
 * The messages the root conversation receives from this feature, and the one
 * delivery path a run check uses for the conversation that started a run.
 *
 * The texts are the approved wording, word for word: they are core
 * strings, they are English like the rest of the code's own text, and the values
 * in angle brackets are filled in by the functions below. A message is written for
 * the root agent to read, so it says what changed and whether it asks for action.
 *
 * Delivery is the device the restart notice already uses: an `input` entry in the
 * root conversation with an envelope that names its source, submitted with
 * `whenBusy: "followUp"` so a root in the middle of a turn hears it after that
 * turn instead of being refused. Two rules are copied from
 * `src/runtime/restart-notice.ts` for the same reasons, and both are about not
 * putting words in a conversation that cannot read them:
 *
 *   - A missing root conversation is not created here. Creating one on a notice
 *     would set up the root's model, roles and instructions as a side effect of a
 *     heartbeat.
 *   - A root with no message entry yet is skipped. The one thing such a
 *     conversation would do with the notice is start a model run, and on an
 *     install with no credential that run fails and stays in the transcript.
 *
 * Neither case is silent to the operator: the caller writes an audit row for both.
 *
 * The source is `system`, an existing member of the closed list in
 * `src/message-envelope.ts`, with `via="remote-machines"` as the delivery marker.
 * The list already holds the value, so no prompt text changes for this, which is
 * what the existing list requires.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type Cursor,
  type Harness,
} from "@earendil-works/pi-durable";
import { submitEnveloped } from "../submit-envelope.ts";
import type { MachineLevel } from "../shared/wire/remote-machines.ts";

/** The entry source, from the closed list in `src/message-envelope.ts`. */
export const NOTICE_SOURCE = "system";

/** The delivery marker. `via` is a free string that no reader validates. */
export const NOTICE_VIA = "remote-machines";

/**
 * The entry kinds that carry a message.
 *
 * A reset or a compaction can leave positional state behind, and `pi.system` is
 * that state rather than something anybody said; these three are the kinds that
 * mean somebody talked.
 */
const MESSAGE_ENTRY_KINDS: readonly string[] = [UserEntry.kind, AssistantEntry.kind, ToolResultEntry.kind];

/** How many entries one look at the root's log takes while it looks for a message. */
const EMPTY_SCAN_PAGE = 20;

/** The text of the notice a loosened level sends. */
export function loosenedLevelText(input: {
  readonly machine: string;
  readonly from: MachineLevel;
  readonly to: MachineLevel;
  /** The instant, already formatted in the harness zone. */
  readonly time: string;
}): string {
  return `The user loosened remote machine "${input.machine}" from ${input.from} to ${input.to} with the sidebar slider at ${input.time}. The new level applies now. This message is a notice and asks for no action.`;
}

/** The text of the notice a changed host key sends, when it stops the machine. */
export function hostKeyBlockedText(input: {
  readonly machine: string;
  readonly time: string;
  readonly address: string;
  readonly sshError: string;
}): string {
  return `pi-sec stopped every connection to remote machine "${input.machine}" at ${input.time}. The host at ${input.address} did not present the pinned host key (ssh said: ${input.sshError}). Ask the user whether this machine's host key changed. Pin a new key only after the user has checked its fingerprint on the machine's own console. Connections stay stopped until the pinned key or this machine's configuration changes.`;
}

/** The text of the notice a wrong machine-id sends, when it stops the machine. */
export function machineIdBlockedText(input: {
  readonly machine: string;
  readonly time: string;
  readonly found: string;
  readonly user: string;
  readonly expected: string;
}): string {
  return `pi-sec stopped every connection to remote machine "${input.machine}" at ${input.time}. /etc/machine-id read as ${input.found} for user ${input.user}, but ${input.expected} was expected. The address may now reach another machine or a reinstalled system. Ask the user. Connections stay stopped until this machine's configuration changes.`;
}

/**
 * The text of the request the root receives when a level becomes stricter.
 *
 * One message per tightening, however many runs are named: the root's job is to
 * ask the agents that started them to stop their own runs before the deadline,
 * and one list is one job. `<deadline>` is a duration and `<deadline time>` is a
 * moment, because the root needs the first to judge urgency and the second to
 * compare it with the clock it reads.
 */
export function tightenRequestedText(input: {
  readonly machine: string;
  readonly from: MachineLevel;
  readonly to: MachineLevel;
  /** The instant of the change, already formatted in the harness zone. */
  readonly time: string;
  readonly runs: readonly { readonly run: string; readonly agent: string }[];
  /** The deadline as a duration, already formatted, for example `5 minutes`. */
  readonly deadline: string;
  /** The moment the deadline falls, already formatted in the harness zone. */
  readonly deadlineTime: string;
}): string {
  const list = input.runs.map((run) => `${run.run} (started by ${run.agent})`).join(", ");
  return `The user made remote machine "${input.machine}" stricter: ${input.from} to ${input.to}, at ${input.time}. These runs no longer fit that level and must stop: ${list}. Ask those agents to stop them. The core stops whatever is left after ${input.deadline}, at ${input.deadlineTime}.`;
}

/** The runs one message names, as the count and the parentheses beside it read. */
function runList(runs: readonly string[]): string {
  return runs.length === 0 ? "none" : runs.join(", ");
}

/**
 * The text of the notice the core sends after it made a level `off` by itself.
 *
 * It reports the change it made and asks for no action: the core no longer asks the
 * root whether the machine is off, so the root must not repeat the question to the
 * user. It carries the machine, the moment its connections stopped answering, the
 * threshold that passed, the level it moved from (so the root can say the user did
 * not switch the machine off), what ssh said last, and the runs of that machine the
 * core stopped watching. A run on a machine that is away cannot be read, and its
 * starting conversation hears the same change in a message of its own.
 */
export function automaticOffText(input: {
  readonly machine: string;
  /** The moment the core first saw the machine down, already formatted in the harness zone. */
  readonly time: string;
  /** The threshold in seconds, as `remoteMachines.outageSeconds` declares it. */
  readonly seconds: number;
  /** The level the machine held before the core made it `off`. */
  readonly level: MachineLevel;
  /** The last line of the last failed heartbeat. */
  readonly sshError: string;
  /** The ids of the runs that were live, in the store's order. */
  readonly runs: readonly string[];
}): string {
  return (
    `Remote machine "${input.machine}" has not answered since ${input.time}, and that is longer than the ` +
    `${String(input.seconds)} seconds this install waits, so pi-sec made its level off. The level was ${input.level}. ` +
    `ssh said: ${input.sshError}. Runs of that machine that were live and are no longer watched: ` +
    `${String(input.runs.length)} (${runList(input.runs)}). ` +
    "The user has one inbox item about this change. This message asks for no action: do not ask the user whether " +
    "the machine is off. When the machine is back, the user raises the level again with the sidebar slider."
  );
}

/**
 * The title of the inbox item the core writes with the automatic off.
 *
 * The item is the one channel that does not depend on the root conversation being
 * there, so it is what the promise to tell the user rests on. It is written in the
 * core's own English, as the other items the core writes are.
 */
export function automaticOffItemTitle(input: { readonly machine: string }): string {
  return `Remote machine "${input.machine}" was set to off: it stopped answering`;
}

/**
 * The three lines of that inbox item's body.
 *
 * It carries the same facts as the notice, minus the sentence about the notice, and
 * it ends with the way back: the slider in the panel. `time` is the moment the core
 * first saw the machine down, formatted in the harness zone.
 */
export function automaticOffItemBody(input: {
  readonly time: string;
  readonly seconds: number;
  readonly sshError: string;
  readonly runs: readonly string[];
}): string {
  return [
    `The machine has not answered since ${input.time}, and that is longer than the ${String(input.seconds)} seconds this install waits, so pi-sec made its level off. ssh said: ${input.sshError}.`,
    `Runs of that machine that were live and are no longer watched: ${String(input.runs.length)} (${runList(input.runs)}).`,
    "When the machine is back, raise its level again with the sidebar slider in the Machines panel.",
  ].join("\n");
}

/**
 * The text the root receives after the core stopped what was left.
 *
 * `<count>` is how many runs it stopped and `<runs>` names them, because a root
 * that hears only a number cannot tell the agents which of their runs ended.
 */
export function tightDeadlineText(input: {
  /** The moment the deadline passed, already formatted in the harness zone. */
  readonly time: string;
  readonly count: number;
  readonly runs: readonly string[];
  readonly machine: string;
  readonly level: MachineLevel;
}): string {
  return `The deadline passed at ${input.time}, so pi-sec stopped ${String(input.count)} run(s) on remote machine "${input.machine}": ${input.runs.join(", ")}. Their starting conversations were told. The level is now ${input.level} and no level change waits.`;
}

/** One message to put into the root conversation. */
export interface RootNotice {
  /** Unique per message: the same notice is never delivered twice. */
  readonly requestId: string;
  readonly text: string;
}

/** What one delivery came to. The caller turns it into an audit row. */
export type NoticeOutcome =
  | { readonly kind: "sent"; readonly submissionId: number }
  | { readonly kind: "skipped"; readonly reason: "no_root" | "root_empty" | "no_harness" }
  | { readonly kind: "failed"; readonly error: string };

export interface RootNoticeDeps {
  /** The harness, when the runtime has built one. Absent before it exists. */
  readonly harness: Pick<Harness, "conversation"> | undefined;
  /** The harness zone (`config.timezone`), which stamps the envelope's `at`. */
  readonly timezone: string;
  readonly ctx?: Context;
}

/**
 * Whether the conversation's log holds a message entry in any of its sessions.
 *
 * Read-only: `Conversation.entries` is a storage scan with no commit behind it.
 * The scan starts at the newest entry, so a conversation that was used answers on
 * the first page and one that never was answers on its only page.
 */
async function hasMessageEntry(conversation: Conversation, ctx: Context): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, EMPTY_SCAN_PAGE, cursor, ctx);
    if (page.items.some((entry) => MESSAGE_ENTRY_KINDS.includes(entry.kind))) return true;
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

/**
 * Put one notice into the root conversation, or say why not.
 *
 * It never throws: the callers are a heartbeat and an HTTP write, and neither may
 * fail because a notice could not be delivered. The outcome is returned so the
 * caller can write an audit row that says what happened.
 */
export async function sendRootNotice(deps: RootNoticeDeps, notice: RootNotice): Promise<NoticeOutcome> {
  try {
    return await deliver(deps, notice);
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function deliver(deps: RootNoticeDeps, notice: RootNotice): Promise<NoticeOutcome> {
  const harness = deps.harness;
  if (harness === undefined) return { kind: "skipped", reason: "no_harness" };
  const ctx = deps.ctx ?? BACKGROUND_CONTEXT;
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  if (conversation === undefined) return { kind: "skipped", reason: "no_root" };
  if (!(await hasMessageEntry(conversation, ctx))) return { kind: "skipped", reason: "root_empty" };
  return await post(conversation, deps.timezone, notice, ctx);
}

/** Put one labelled input into one conversation. */
async function post(
  conversation: Conversation,
  timezone: string,
  notice: RootNotice,
  ctx: Context,
): Promise<NoticeOutcome> {
  const submission = await submitEnveloped(
    conversation,
    ctx,
    {
      type: "input",
      src: NOTICE_SOURCE,
      attrs: { via: NOTICE_VIA },
      content: notice.text,
      // The reader may be in the middle of a turn. A notice is not an order, so it
      // waits for the next boundary instead of being refused.
      whenBusy: "followUp",
      requestId: notice.requestId,
    },
    timezone,
  );
  return { kind: "sent", submissionId: submission.id };
}

/**
 * The conversation one run check answers, and why it answers where it does.
 *
 * The first choice is the conversation that started the run. It is gone when the
 * record names none, when the store has no such conversation, or when that
 * conversation's agent record ended as `stopped`, `failed` or `deleted`: a message
 * put into a conversation nobody will run in is a message nobody reads. The second
 * choice is the root, and when the root is not there either the outcome is the
 * `skipped` this module already answers for the earlier notices, which the caller
 * turns into an audit row and nothing else.
 *
 * A `waiting` or `running` agent's conversation is a fine place for the message, and
 * so is a `focused` chat: both can be read again.
 */
export interface RunNoticeDeps extends RootNoticeDeps {
  /** The conversation the run was started from, or null when it named none. */
  readonly conversationId: string | null;
  /** The agent record of one conversation, or undefined when there is none. */
  readonly agentStatus: (conversationId: string, ctx: Context) => Promise<string | undefined>;
}

/** The agent record states that mean nobody will read that conversation again. */
const ENDED_AGENT_STATES: readonly string[] = ["stopped", "failed", "deleted"];

/**
 * Put one run check into the conversation that started the run, or into the root.
 *
 * It never throws, for the same reason `sendRootNotice` never does: a check runs on
 * a timer and must not die because one message could not be placed. The outcome
 * says what happened, and the caller writes it into the audit trail.
 */
export async function sendRunNotice(deps: RunNoticeDeps, notice: RootNotice): Promise<NoticeOutcome> {
  try {
    const ctx = deps.ctx ?? BACKGROUND_CONTEXT;
    const harness = deps.harness;
    if (harness === undefined) return { kind: "skipped", reason: "no_harness" };
    const id = deps.conversationId;
    if (id !== null && id !== String(ROOT_CONVERSATION_ID)) {
      const status = await deps.agentStatus(id, ctx);
      if (status !== undefined && !ENDED_AGENT_STATES.includes(status)) {
        const conversation = await harness.conversation(id as unknown as Parameters<Harness["conversation"]>[0], ctx);
        if (conversation !== undefined) return await post(conversation, deps.timezone, notice, ctx);
      }
    }
    return await deliver(deps, notice);
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
