import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, AssistantEntry, ToolResultEntry, UserEntry, type Conversation, type ConversationId, type Cursor, type Harness } from "@earendil-works/pi-durable";
import type { AgentRecord, JobRecord, JobStatus } from "../documents.ts";
import { NO_RESPONSE_MARKER } from "../shared/silent-turn.ts";
import { submitEnveloped } from "../submit-envelope.ts";
import { zoneIso } from "../time-format.ts";
import { readAuditTail, type AuditEvent } from "./audit.ts";

/**
 * The zone formatter, re-exported for the callers that know it from this module.
 *
 * The function itself lives in `src/time-format.ts`, with the other form the
 * harness writes, so one module owns the format. This line keeps
 * `test/restart-flow.test.ts` and any importer of the notice module working
 * unchanged.
 */
export { zoneIso };

/**
 * Tell the root conversation that the daemon started again.
 *
 * A cold restart is invisible from inside the process that comes up: the same
 * conversation, the same history, and no entry that says the daemon was away. Once, the root
 * learned about a restart only because a handoff text said so; without that text a restart reads like a quiet night. This module writes
 * the missing sentence once per boot, as an input entry in the root conversation
 * with `src="restart"` and `via="cold-start"`. That is the one surface the root
 * actually reads: an inbox item would reach the operator and not the model.
 *
 * The chat draws the entry as a folded card, not as an operator message, so the
 * notice does not put words in the operator's mouth.
 *
 * Five rules keep the notice cheap and honest.
 *
 *   - A boot with no earlier `server_start` in the audit tail is a first start,
 *     and a first start is not a restart. Nothing is written.
 *   - A missing root conversation means the boot preparation failed and nobody
 *     wrote to the root since, so there is nobody to tell. The conversation is
 *     never created here: that would set up the root's model, roles and
 *     instructions as a side effect of a boot.
 *   - A root conversation with no message yet means nobody talked to the root.
 *     The daemon creates the root at boot, so before the first message every
 *     restart lands here. A notice would start a model run, and on a fresh
 *     install with no credential that run fails and stays in the transcript.
 *     The audit row says `root_empty`.
 *   - A pid file left by the previous process (the shutdown handler removes it)
 *     is the trace of an exit that skipped shutdown, and it is evidence the
 *     audit trail alone cannot give. Otherwise the last `server_stop` row is a
 *     clean stop.
 *   - A notice inside the suppression window is skipped. A crash loop must not
 *     wake the root on every boot; the count is carried into the next notice.
 *   - Every failure stays inside this module and lands in the audit trail as
 *     `restart_notice_failed`. A notice is never worth a daemon that does not
 *     come up, and `commandStart` wraps the call as well.
 *
 * The trail is also how the next boot answers "what happened last time": it
 * carries the last `restart_launched`, `server_stop` and `restart_notice` rows.
 * `readAuditTail` reads the active file only, so a rotation between two boots
 * hides those rows; the notice then falls on the quiet side and is skipped.
 */

/**
 * How long one notice keeps further boots quiet.
 *
 * The window is a module constant, not a setting: turning the notice off is
 * `git revert` and a restart, and a schema key would outlive the feature.
 */
export const NOTICE_SUPPRESS_MS = 60_000;

/**
 * How many rows of the active audit file the decision reads, newest last.
 *
 * At a busy deployment's rate (thousands of rows a day) the tail covers several
 * days, which is more than a restart loop needs and less than the whole file. A
 * boot after a longer pause can miss the previous `server_start` and read as a
 * first start, which skips one notice rather than sending a wrong one.
 */
const TAIL_LIMIT = 20_000;

/** How many entries one read of the root's log takes while it looks for a message. */
const EMPTY_SCAN_PAGE = 20;

/**
 * The entry kinds that carry a message: the ones a reset or a compaction cannot
 * leave on their own. `pi.system` is positional state written before a request,
 * not something the operator or the model said.
 */
const MESSAGE_ENTRY_KINDS: readonly string[] = [UserEntry.kind, AssistantEntry.kind, ToolResultEntry.kind];

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
 * How many rows one list of the notice carries before it counts the rest.
 *
 * A restart after a long session can leave dozens of jobs and agents parked, and
 * the notice is read by a model: twenty rows name what has to be resumed, and the
 * count at the end says how much the list left out.
 */
export const NOTICE_LIST_LIMIT = 20;

/** How the notice names the root agent as somebody's parent. */
const ROOT_PARENT_LABEL = "the root agent";

/** One job in the waiting status, as the notice lists it. */
export interface WaitingJob {
  readonly id: string;
  readonly title: string;
}

/** One subagent that waits for orders, as the notice lists it. */
export interface WaitingSubagent {
  readonly name: string;
  /** The conversation number, which is what a later `subagents_*` call takes. */
  readonly conversationId: string;
  readonly parentName: string;
}

/**
 * What was parked when the daemon stopped, and so did not resume by itself.
 *
 * The root reads this list in the notice and decides what to resume. Both lists
 * are complete counts; the lines that name them stop at `NOTICE_LIST_LIMIT`.
 */
export interface WaitingWork {
  readonly jobs: readonly WaitingJob[];
  readonly subagents: readonly WaitingSubagent[];
}

/** The two stores `collectWaitingWork` reads. Both are optional in what they must offer. */
export interface WaitingWorkSources {
  /** `runtime.jobs`. */
  readonly jobs: { list(context: Context, filter?: { readonly status?: JobStatus }): Promise<readonly JobRecord[]> };
  /** `runtime.subagents`, absent when the subagents extension is not installed. */
  readonly subagents?: {
    children(conversationId: ConversationId, ctx: Context): Promise<readonly Readonly<AgentRecord>[]>;
  };
  readonly ctx: Context;
}

/**
 * Read the two lists the notice carries: jobs in the waiting status, and every
 * subagent under the root that waits for orders.
 *
 * A restart stops a job that waited for an approval and an agent that parked with
 * `await_orders`, and nothing in the daemon resumes either of them: the state
 * survives, the intent does not. The root is the only reader that can act on it,
 * so the notice names them.
 *
 * The walk over the subagents starts at the root and goes down every level,
 * because a grandchild that waits for orders is as stuck as a child. Only the
 * `subagent` kind is listed: a focused chat that waits is waiting for the
 * operator, and an order from the root would not resume it.
 */
export async function collectWaitingWork(sources: WaitingWorkSources): Promise<WaitingWork> {
  const jobs = (await sources.jobs.list(sources.ctx, { status: "waiting" })).map((job) => ({
    id: job.id,
    title: job.title,
  }));
  const subagents: WaitingSubagent[] = [];
  const hub = sources.subagents;
  if (hub !== undefined) {
    // Breadth first, and each conversation is visited once: a child holds one
    // parent, so the walk cannot loop, and a repeated id would list it twice.
    const seen = new Set<string>([String(ROOT_CONVERSATION_ID)]);
    const queue: ConversationId[] = [ROOT_CONVERSATION_ID];
    while (queue.length > 0) {
      const parent = queue.shift() as ConversationId;
      for (const child of await hub.children(parent, sources.ctx)) {
        if (seen.has(child.conversationId)) continue;
        seen.add(child.conversationId);
        queue.push(Number(child.conversationId) as ConversationId);
        if (child.kind !== "subagent" || child.status !== "waiting") continue;
        subagents.push({
          name: child.name,
          conversationId: child.conversationId,
          // A child of the root stores the root's own name (`operator`), which is
          // not what the root calls itself. The sentence reads the same label the
          // system prompt gives it.
          parentName:
            child.parentConversationId === undefined || child.parentConversationId === String(ROOT_CONVERSATION_ID)
              ? ROOT_PARENT_LABEL
              : (child.parentName ?? ROOT_PARENT_LABEL),
        });
      }
    }
  }
  return { jobs, subagents };
}

/** The entry source, from the closed list in `src/message-envelope.ts`. */
const NOTICE_SOURCE = "restart";

/** The delivery marker. `via` is a free string that no reader validates. */
const NOTICE_VIA = "cold-start";

/** What one call to `notifyRestartNotice` decided. Recorded, and returned for tests. */
export type RestartNoticeOutcome =
  | { readonly kind: "notified"; readonly submissionId: number; readonly suppressed: number }
  | { readonly kind: "skipped"; readonly reason: "first_start" | "no_root" | "root_empty" }
  | { readonly kind: "suppressed"; readonly sinceLastNoticeMs: number }
  | { readonly kind: "failed"; readonly error: string };

export interface RestartNoticeDeps {
  /** Only `conversation` is needed: the notice writes no agent record. */
  readonly harness: Pick<Harness, "conversation">;
  /** Defaults to `BACKGROUND_CONTEXT`: a boot has no invocation. */
  readonly ctx?: Context;
  readonly pid: number;
  /** `deps.startedAt` in `commandStart`: the boot time, not the call time. */
  readonly startedAt: number;
  /**
   * The harness time zone (`timezone` in config.json), as the boot read it. The
   * boot time is written in it, with the offset in force at that instant.
   */
  readonly timezone: string;
  /** The tree the running process came from, quoted in the body. */
  readonly snapshotTree: string;
  readonly auditFile: string;
  /**
   * The pid the pid file held before this process wrote its own, or undefined
   * when the file was absent. The shutdown handler removes the file, so a value
   * here is the trace of an exit that skipped shutdown.
   */
  readonly previousPid?: number;
  readonly appendAudit: (event: AuditEvent) => void;
  /** One line goes here when the commit of the running tree cannot be read. */
  readonly logger?: { warn(message: string, meta?: unknown): void };
  /** Injected so a test can decide from a fixed tail without a file. */
  readonly readTail?: (file: string, since: number | undefined, limit: number) => Promise<AuditEvent[]>;
  /** Injected so a test does not shell out. */
  readonly treeCommit?: (tree: string) => string | undefined;
  /**
   * Reads what was parked when the daemon stopped. Called once, and only when the
   * notice is about to be written: a boot that stays quiet pays no store scan.
   *
   * Absent means the two lists are empty, which is what a caller with no store to
   * read says. The reading never fails the notice: a store that throws leaves
   * both lists empty and one warning behind.
   */
  readonly readWaitingWork?: (ctx: Context) => Promise<WaitingWork>;
}

/**
 * Post the notice for this boot, unless one of the three rules says otherwise.
 *
 * This never throws and never rejects: the caller is a boot path. The outcome is
 * returned so a test can read the decision without parsing the audit trail.
 */
export async function notifyRestartNotice(deps: RestartNoticeDeps): Promise<RestartNoticeOutcome> {
  try {
    return await decideAndWrite(deps);
  } catch (error) {
    const reason = errorText(error);
    record(deps, { type: "restart_notice_failed", error: reason });
    return { kind: "failed", error: reason };
  }
}

async function decideAndWrite(deps: RestartNoticeDeps): Promise<RestartNoticeOutcome> {
  const ctx = deps.ctx ?? BACKGROUND_CONTEXT;
  const readTail = deps.readTail ?? readAuditTail;
  const tail = await readTail(deps.auditFile, undefined, TAIL_LIMIT);
  // A row at or after `startedAt` belongs to this boot. The `server_start` row
  // `commandStart` writes just before this call is one of them, so the previous
  // boot is the last one strictly before `startedAt`.
  const prior = tail.filter((event) => typeof event.time === "number" && event.time < deps.startedAt);

  const previousStart = lastOf(prior, "server_start");
  if (previousStart === undefined) {
    record(deps, { type: "restart_notice_skipped", reason: "first_start" });
    return { kind: "skipped", reason: "first_start" };
  }

  const conversation: Conversation | undefined = await deps.harness.conversation(ROOT_CONVERSATION_ID, ctx);
  if (conversation === undefined) {
    record(deps, { type: "restart_notice_skipped", reason: "no_root" });
    return { kind: "skipped", reason: "no_root" };
  }

  // A conversation nobody has written a message to has nothing to be told about
  // a restart, and the notice would start a model run that a home without a
  // credential answers with an error entry. The markers a reset or a compaction
  // leaves are not messages, so they do not make the transcript content.
  if (!(await hasMessageEntry(conversation, ctx))) {
    record(deps, { type: "restart_notice_skipped", reason: "root_empty" });
    return { kind: "skipped", reason: "root_empty" };
  }

  const lastNotice = lastOf(prior, "restart_notice");
  if (lastNotice !== undefined) {
    const since = deps.startedAt - (lastNotice.time as number);
    if (since < NOTICE_SUPPRESS_MS) {
      record(deps, { type: "restart_notice_suppressed", sinceLastNoticeMs: since });
      return { kind: "suppressed", sinceLastNoticeMs: since };
    }
  }

  const suppressed = countAfter(prior, "restart_notice_suppressed", lastNotice?.time as number | undefined);
  const waiting = await readWaitingWork(deps, ctx);
  const body = await renderNotice(deps, prior, previousStart.time as number, suppressed, waiting);
  const submission = await submitEnveloped(
    conversation,
    ctx,
    {
      type: "input",
      src: NOTICE_SOURCE,
      attrs: { via: NOTICE_VIA },
      content: body,
      // The root may still be running the task `harness.resume()` restarted, so
      // the notice waits for the next boundary instead of being refused.
      whenBusy: "followUp",
      requestId: `restart-notice:${deps.startedAt}`,
    },
    // The clock the notice is stamped with is the one the boot read.
    deps.timezone,
  );
  record(deps, { type: "restart_notice", pid: deps.pid, suppressed, submissionId: submission.id });
  return { kind: "notified", submissionId: submission.id, suppressed };
}

/**
 * The two lists, or two empty ones when nothing can be read.
 *
 * A boot is the wrong place to fail: the notice goes out with what it has, and
 * the warning names the store that did not answer.
 */
async function readWaitingWork(deps: RestartNoticeDeps, ctx: Context): Promise<WaitingWork> {
  const empty: WaitingWork = { jobs: [], subagents: [] };
  const read = deps.readWaitingWork;
  if (read === undefined) return empty;
  try {
    return await read(ctx);
  } catch (error) {
    try {
      deps.logger?.warn("the restart notice could not read what was waiting", { error: errorText(error) });
    } catch {
      /* the boot continues without the line */
    }
    return empty;
  }
}

/** Append one audit row. A trail that cannot be written never fails a boot. */
function record(deps: RestartNoticeDeps, event: AuditEvent): void {
  try {
    deps.appendAudit(event);
  } catch {
    /* the boot continues without the row */
  }
}

async function renderNotice(
  deps: RestartNoticeDeps,
  prior: readonly AuditEvent[],
  previousStartTime: number,
  suppressed: number,
  waiting: WaitingWork,
): Promise<string> {
  const commit = resolveCommit(deps);
  const pidLeftBehind = deps.previousPid !== undefined && deps.previousPid !== deps.pid;
  const verdict = verdictOf(prior, previousStartTime, pidLeftBehind);
  const downtime = downtimeSeconds(prior, deps.startedAt);
  const tree = commit === undefined ? deps.snapshotTree : `${deps.snapshotTree} (HEAD ${commit})`;
  const lines = [
    "The server made a cold restart. (automatic notice)",
    `- pid: ${deps.pid}`,
    `- Started at: ${zoneIso(deps.startedAt, deps.timezone)}`,
    `- Execution tree: ${tree}`,
    `- Previous stop: ${verdict}${downtime === undefined ? "" : ` / downtime ${downtime} s`}`,
    ...(suppressed === 0 ? [] : [`- ${suppressed} more starts in the previous ${NOTICE_SUPPRESS_MS / 1000} s`]),
    "- Boot repair (conversations and children) runs in parallel with this notice.",
    ...waitingList(
      "Jobs in waiting status",
      waiting.jobs.map((job) => `${job.id} ${job.title}`),
      (hidden) => `  - and ${hidden} more. \`jobs_list\` with status waiting shows every one.`,
    ),
    ...waitingList(
      "Subagents waiting for orders",
      waiting.subagents.map(
        (subagent) => `${subagent.name} (conversation ${subagent.conversationId}, parent ${subagent.parentName})`,
      ),
      (hidden) => `  - and ${hidden} more.`,
    ),
    "- Work that stopped for a restart stays stopped until someone resumes it. For each job or subagent above whose next step was this restart, resume it now.",
    `- If nothing above waits for this restart and you have nothing to tell the user, your whole answer is this one line, copied exactly with nothing added: ${NO_RESPONSE_MARKER}`,
  ];
  return lines.join("\n");
}

/**
 * One list of the notice: a heading with its full count, up to
 * `NOTICE_LIST_LIMIT` rows, then one line for the rest.
 *
 * An empty list is one `none` row rather than no row at all, because a missing
 * list reads as a list nobody looked at, and the count in the heading says the
 * same number in one character.
 */
function waitingList(heading: string, rows: readonly string[], overflow: (hidden: number) => string): string[] {
  const shown = rows.slice(0, NOTICE_LIST_LIMIT);
  const lines = [`- ${heading} (${rows.length}):`];
  if (shown.length === 0) {
    lines.push("  - none");
    return lines;
  }
  for (const row of shown) lines.push(`  - ${row}`);
  const hidden = rows.length - shown.length;
  if (hidden > 0) lines.push(overflow(hidden));
  return lines;
}

/**
 * The commit of the tree the process runs from.
 *
 * The tree is `paths.snapshotTree`: the workspace tree is where a change waits
 * to be deployed, so its commit would name code this process is not running. A
 * missing answer costs the sha and nothing else, so it leaves one line in the
 * log and the notice goes out without it.
 */
function resolveCommit(deps: RestartNoticeDeps): string | undefined {
  const commit = (deps.treeCommit ?? treeCommit)(deps.snapshotTree);
  if (commit === undefined) {
    try {
      deps.logger?.warn("the restart notice carries no commit sha", { tree: deps.snapshotTree });
    } catch {
      /* the boot continues without the line */
    }
  }
  return commit;
}

/**
 * Why the previous process stopped, from the evidence the boot has.
 *
 * A `restart_launched` row after the previous start is the only record that the
 * stop was asked for. Otherwise a pid file the previous process left behind is
 * the trace of an exit that skipped shutdown, and a `server_stop` row as the
 * last event is a clean stop.
 */
function verdictOf(prior: readonly AuditEvent[], previousStartTime: number, pidLeftBehind: boolean): string {
  const after = prior.filter((event) => (timeOf(event) ?? -1) > previousStartTime);
  if (after.some((event) => event.type === "restart_launched")) return "restart on request";
  if (pidLeftBehind) return "automatic start after an abnormal exit";
  const last = prior[prior.length - 1];
  if (last !== undefined && last.type === "server_stop") return "start after a normal stop";
  return "unknown";
}

/** Seconds between the last stop evidence and this boot, or undefined without it. */
function downtimeSeconds(prior: readonly AuditEvent[], startedAt: number): number | undefined {
  let at: number | undefined;
  for (const event of prior) {
    if (event.type !== "server_stop" && event.type !== "restart_launched") continue;
    const time = timeOf(event);
    if (time !== undefined && (at === undefined || time > at)) at = time;
  }
  if (at === undefined) return undefined;
  return Math.max(0, Math.round((startedAt - at) / 1000));
}

/** The full commit of one tree, or undefined when git cannot answer for it. */
function treeCommit(tree: string): string | undefined {
  const result = spawnSync("git", ["-C", tree, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const sha = String(result.stdout ?? "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

function timeOf(event: AuditEvent): number | undefined {
  return typeof event.time === "number" ? event.time : undefined;
}

function lastOf(events: readonly AuditEvent[], type: string): AuditEvent | undefined {
  let found: AuditEvent | undefined;
  for (const event of events) if (event.type === type) found = event;
  return found;
}

function countAfter(events: readonly AuditEvent[], type: string, since: number | undefined): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== type) continue;
    const time = timeOf(event);
    if (time === undefined) continue;
    if (since !== undefined && time <= since) continue;
    count += 1;
  }
  return count;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
