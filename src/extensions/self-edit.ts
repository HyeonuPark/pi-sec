import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Extension,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SecCandidate, SecSelfEdit, type AgentRecord } from "../documents.ts";
import { checkApprovedReport, type ApprovalWording } from "../jobs/registry.ts";
import { ulid } from "../runtime/ids.ts";
import type { RestartState } from "../runtime/restart.ts";
import { collectChangeText, runValidation } from "../runtime/validation.ts";
import { submitEnveloped } from "../submit-envelope.ts";
import type { ExtensionContext } from "./context.ts";
import type { SubagentHub } from "./subagents.ts";

export class WorkspaceBoundaryError extends Error {
  constructor(path: string, root: string) {
    super(`path escapes the workspace tree (${root}): ${path}`);
    this.name = "WorkspaceBoundaryError";
  }
}

/** Resolve a workspace-relative path, rejecting traversal outside the tree. */
export function resolveWorkspacePath(root: string, candidate: string): string {
  const abs = resolve(root, candidate);
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new WorkspaceBoundaryError(candidate, root);
  }
  return abs;
}

/**
 * `resolveWorkspacePath`, and then the same check on real paths.
 *
 * The text check cannot see a symbolic link. This one resolves the root and the
 * nearest existing part of the target with `realpath`, and refuses the path when
 * that real path lies outside the real root. A link that stays inside the tree is
 * allowed, and so is a new file in a directory that does not exist yet.
 */
export async function resolveWorkspacePathReal(root: string, candidate: string): Promise<string> {
  const abs = resolveWorkspacePath(root, candidate);
  const realRoot = await realpath(resolve(root));
  let existing = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // A dangling link or a loop is not a path to write through.
        if (code === "ELOOP") throw new WorkspaceBoundaryError(candidate, root);
        throw error;
      }
      // A link whose target does not exist would be created through by a write.
      if ((await lstat(existing).catch(() => undefined))?.isSymbolicLink() === true) {
        throw new WorkspaceBoundaryError(candidate, root);
      }
      const parent = dirname(existing);
      if (parent === existing) throw new WorkspaceBoundaryError(candidate, root);
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
  const real = join(existing, ...missing);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new WorkspaceBoundaryError(candidate, root);
  }
  return abs;
}

export interface ValidationResult {
  readonly typecheck?: boolean;
  readonly tests?: boolean;
  readonly secretsClean: boolean;
}

/**
 * Why a restart cannot be asked for: the approval its report is missing.
 *
 * The gate below proves a change is sound; it cannot say whether anyone agreed
 * to it. The report store is where consent is written — an approval sits inside
 * the revision that was on screen — so this is the check that the user's "go
 * ahead" exists at all.
 *
 * The rule is the routine gate's (`checkApprovedReport` in
 * `src/jobs/registry.ts`): the report is live, its job has not ended, and the
 * approval names the sha256 of the newest revision. An approval on an older
 * revision does not count, because a newer revision is a new proposal. A report
 * that moved to the archive with its finished job does not count either: that
 * approval covered the work it was written for, not the next change.
 *
 * A build with no report store has no approval record to read, so the check
 * passes there rather than inventing a refusal. A store that is present but
 * cannot be read is a failure and not a pass: the read is not caught, so its
 * error is what the tool reports.
 *
 * The refusal comes back in two parts, and the split is deliberate. `message` is
 * what the model reads and acts on, so it stays a full instruction. `code` is
 * what the audit row keeps, so a reader can tell one refusal from another
 * without parsing that prose.
 */
export interface RestartRefusal {
  /** Stable and machine-readable: the `code` of the `restart_refused` row. */
  readonly code: string;
  /** What the tool reports, and the single entry in the row's `reasons`. */
  readonly message: string;
}

/** How the restart gate words the shared approval check. */
const RESTART_WORDING: ApprovalWording = {
  act: "this change",
  retry: () => "call request_restart again",
};

async function approvalRefusal(
  context: ExtensionContext,
  ctx: import("@earendil-works/chord").Context,
  reportId: string | undefined,
): Promise<RestartRefusal | undefined> {
  const reports = context.reports;
  if (reports === undefined) return undefined;
  if (reportId === undefined || reportId.trim() === "") {
    return {
      code: "report_id_required",
      message:
        "Restart NOT requested — reportId is required: name the report whose newest revision the user approved." +
        " Write the plan as a report, have the user approve its newest revision, then call request_restart again.",
    };
  }
  // The live store answers first. A report that is only in the archive gets its
  // own words, because "no report exists" would be false and the reader has to
  // learn why its approval no longer counts.
  if ((await reports.get(ctx, reportId.trim())) === undefined) {
    if ((await reports.getArchived(ctx, reportId.trim())) !== undefined) {
      return {
        code: "report_archived",
        message:
          `Restart NOT requested — report ${reportId} is archived because its job finished, so its approval covered the work that job landed and not this change.` +
          " Write the plan for this change as a report on a live job, have the user approve its newest revision, then call request_restart again.",
      };
    }
    return {
      code: "report_not_found",
      message:
        `Restart NOT requested — no report ${reportId} exists, so there is no approval that could cover this change.` +
        " Publish the plan as a report, have the user approve its newest revision, then call request_restart again.",
    };
  }
  const check = await checkApprovedReport({ reports, context: ctx, reportId, wording: RESTART_WORDING });
  if (check.ok) return undefined;
  return { code: check.code, message: `Restart NOT requested — ${check.detail}` };
}

/**
 * The fields every `restart_refused` row carries, whatever refused.
 *
 * Three places record one: the two refusals inside `request_restart` and the web
 * UI's launch route (`src/server/routes/admin.ts`). They are read by whoever
 * asks why a restart was not asked for, so the shape is a contract rather than a
 * local choice: `source` names the path, `code` the reason, and `reasons` the
 * human-readable detail, always as a list. Only the tool path adds `title` and
 * `conversationId`, because only it has them. `test/restart-flow.test.ts`
 * pins this for all three places.
 */
function restartRefusedRow(
  refusal: { readonly code: string; readonly reasons: readonly string[] },
  title: string,
  conversationId: number,
): { type: "restart_refused"; source: "agent"; code: string; reasons: string[]; title: string; conversationId: number } {
  return {
    type: "restart_refused",
    source: "agent",
    code: refusal.code,
    reasons: [...refusal.reasons],
    title,
    conversationId,
  };
}

/**
 * What `request_restart` returns when its own call was cancelled mid-gate.
 *
 * The background form makes this reachable: the root starts the gate and then
 * stops the call, because the batch moved. The signal kills the commands in
 * flight, and a check that did not finish raises nothing.
 */
function cancelledRestart(): { output: { type: "text"; text: string }[]; isError: true } {
  return {
    output: [
      {
        type: "text" as const,
        text: "Restart NOT requested — the call was cancelled while the gate was running, so the check did not finish and nothing was raised. Call request_restart again when the batch is closed.",
      },
    ],
    isError: true,
  };
}

/**
 * How long a safe-point note stands before the same busy child is told again.
 *
 * The note is delivered at the end of the run in flight, so a child that never
 * parks would otherwise be told once and never again. Ten minutes is long enough
 * that a normal run finishes first, and short enough that a stuck child is
 * prodded again while the user is still waiting. The precedent is the stall
 * watch's "one episode, one telling": telling again after a restart is the right
 * way to be wrong.
 */
const SAFE_POINT_RESEND_MS = 10 * 60_000;

/** Scan page size, and the caps on the reads below, as the diagnostics extension uses them. */
const SCAN_PAGE = 50;
const TASK_SCAN_MAX = 200;
const ENTRY_SCAN_MAX = 200;

/** The tool a result entry holds, if it holds one. */
function toolNameOf(entry: EntryRecord): string | undefined {
  for (const message of entry.model ?? []) {
    if (message.role === "toolResult") return message.toolName;
  }
  return undefined;
}

/** Count the tasks of one conversation that are not terminal, as `diagnose_conversation` counts them. */
async function readLiveTasks(
  storage: Storage,
  conversationId: ConversationId,
  ctx: import("@earendil-works/chord").Context,
): Promise<number> {
  let cursor: Cursor | undefined;
  let read = 0;
  let liveTasks = 0;
  for (;;) {
    const page = await storage.scanTasks({ conversationId, order: "descending" }, SCAN_PAGE, cursor, ctx);
    for (const task of page.items) {
      read += 1;
      if (task.state.status !== "terminal") liveTasks += 1;
    }
    if (page.next === undefined || read >= TASK_SCAN_MAX) break;
    cursor = page.next;
  }
  return liveTasks;
}

/** The newest tool that returned a result in one conversation, if it ran one. */
async function readLastTool(
  storage: Storage,
  conversationId: ConversationId,
  ctx: import("@earendil-works/chord").Context,
): Promise<string | undefined> {
  let cursor: Cursor | undefined;
  let read = 0;
  for (;;) {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, SCAN_PAGE, cursor, ctx);
    for (const entry of page.items) {
      read += 1;
      const tool = toolNameOf(entry);
      if (tool !== undefined) return tool;
    }
    if (page.next === undefined || read >= ENTRY_SCAN_MAX) break;
    cursor = page.next;
  }
  return undefined;
}

/**
 * One conversation in the caller's tree, as the safe-point check reads it.
 *
 * The fields are the diagnostics extension's: `liveTasks` counts the tasks that
 * are not terminal, `lastTool` is the newest tool that returned a result. Both
 * are computed per call and never stored, so a diagnosis and this check cannot
 * disagree about a conversation neither of them wrote.
 */
interface ConversationLoad {
  readonly conversationId: string;
  readonly name: string;
  /** The kind the record carries: a focused chat is judged by a rule of its own. */
  readonly kind: AgentRecord["kind"];
  /** The record's status, note and write time, which is how a park is read. */
  readonly status: AgentRecord["status"];
  readonly lastNote: string | undefined;
  readonly updatedAt: number;
  readonly liveTasks: number;
  readonly runningCalls: number;
  readonly lastTool: string | undefined;
  /** How many of its own children are working, as the hub's park rule counts them. */
  readonly workingChildren: number;
  /** Working and holding something in flight: the only state a restart would cut. */
  readonly busy: boolean;
}

/**
 * Whether one conversation is busy.
 *
 * `starting` is included because a child that has just been spawned is on its
 * way into its first run, and a restart in that window cuts the same work
 * `running` would. `waiting` is parked, and parking is what the note asks for:
 * there is nothing to interrupt, so it is not busy.
 *
 * A working conversation is busy while it holds a live task, a running
 * background call, or a child that is working. The last condition is the hub's
 * own park rule (`SubagentHub.workingChildren`): an orchestrator that ended its
 * turn to wait for a working child has not parked, because `await_orders` is
 * refused to it until that child is done. Counting it as parked would let the
 * gate pass while the work under it is still running.
 */
function isBusy(record: Readonly<AgentRecord>, liveTasks: number, runningCalls: number, workingChildren: number): boolean {
  const working = record.status === "starting" || record.status === "running";
  return working && (liveTasks > 0 || runningCalls > 0 || workingChildren > 0);
}

/**
 * Every conversation below one conversation, with what each is holding.
 *
 * The caller's own conversation is where the walk starts, so it is never in the
 * result: `request_restart` runs in a task of that conversation, and counting
 * that task would refuse every call. Children are read through the hub's own
 * index, which `retireIfFinished` clears in the same commit that ends a child.
 */
async function loadTree(
  context: ExtensionContext,
  hub: SubagentHub,
  conversationId: ConversationId,
  ctx: import("@earendil-works/chord").Context,
): Promise<ConversationLoad[]> {
  const storage: Storage = context.storage;
  const harness = context.harness;
  const out: ConversationLoad[] = [];
  const seen = new Set<string>([String(conversationId)]);
  let frontier: ConversationId[] = [conversationId];
  while (frontier.length > 0) {
    const next: ConversationId[] = [];
    for (const parent of frontier) {
      for (const child of await hub.children(parent, ctx)) {
        if (seen.has(child.conversationId)) continue;
        seen.add(child.conversationId);
        const id = Number(child.conversationId) as ConversationId;
        // A child whose conversation is gone is nobody's work to wait for. The
        // store refuses a read of an unknown conversation, and a gate that threw
        // on a stale id would be the fault, not the finding.
        if (harness !== undefined && (await harness.conversation(id, ctx)) === undefined) continue;
        const liveTasks = await readLiveTasks(storage, id, ctx);
        const runningCalls = (await hub.ownAsyncCalls(id, ctx)).length;
        const workingChildren = (await hub.workingChildren(id, ctx)).length;
        out.push({
          conversationId: child.conversationId,
          name: child.name,
          kind: child.kind,
          status: child.status,
          lastNote: child.lastNote,
          updatedAt: child.updatedAt,
          liveTasks,
          runningCalls,
          workingChildren,
          lastTool: await readLastTool(storage, id, ctx),
          busy: isBusy(child, liveTasks, runningCalls, workingChildren),
        });
        next.push(id);
      }
    }
    frontier = next;
  }
  return out;
}

/** How long ago a note went out, in the words the tool result uses. */
function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes <= 0) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/**
 * The note that asks one working child to stand at a safe point.
 *
 * It is a `note`, not an `order`: the child is working, and a note queued in its
 * inbox is placed at the end of the run in flight, which is exactly "finish what
 * you are doing first". The wording follows the restart round's `childNote`.
 *
 * It names three cases, because one instruction does not fit every reader. An
 * agent with a working subagent is refused `await_orders`, so it ends its turn
 * and waits for that subagent's message. An agent whose work is done ends with
 * the tool its role names, which for a worker is `finish_work`. Any other agent
 * parks with `await_orders` and says where it stopped.
 */
function safePointNote(title: string): string {
  return [
    `[restart gate] A cold restart of this daemon is being prepared for the change "${title}".`,
    "A cold restart cuts the turn in flight, so every conversation doing work has to stand at a safe point. You are one of them.",
    "Finish the block you are doing. Start no new work. Write your current state and the next step to your context file. Then do the one of these that fits:",
    "1. If a subagent of yours is still working, end your turn without a tool call. Its message starts your next turn; read this note again then.",
    "2. If the work you were given is done, end with the tool your role names for that: `finish_work` or `await_orders`.",
    "3. Otherwise, park with `await_orders` and tell your parent that you are at a safe point and where you stopped.",
  ].join("\n");
}

/**
 * The note that asks one open focused chat to stand at a safe point.
 *
 * A chat is not a child agent: it has no parent to report to and no subagent of
 * its own, and the user is reading it. So the three cases above do not fit, and
 * the note is written for a conversation with a person on the other side: tell
 * the user, write the state, and end at `await_orders`, because a reply that
 * just stops is not a park and the gate judges the park.
 */
export function focusedSafePointNote(title: string): string {
  return [
    `[restart gate] A cold restart of this daemon is being prepared for the change "${title}".`,
    "A cold restart cuts the turn in flight, so this chat has to stand at a safe point before it.",
    "In this same turn, do these three steps in order:",
    "1. Tell the user in one or two sentences that a restart is coming and that this chat continues after it.",
    "2. Write your current state and the next step to your context file.",
    "3. Call `await_orders`, and say in its note that you are at a safe point. A reply that ends without `await_orders` does not count as a safe point.",
  ].join("\n");
}

/**
 * Whether one open focused chat stands at its safe point.
 *
 * A focused chat is idle most of the time, and the user may write to it at any
 * moment, so its idle state is not the state a restart wants. Its record is
 * `waiting` from the moment it is opened, before it ever had a brief, so a
 * status alone proves nothing either.
 *
 * What counts is a park that came after the gate asked. `await_orders` writes
 * `waiting`, keeps the note and moves `updatedAt`, so a record written at or
 * after the time this gate sent its note is the chat's answer to that note. A
 * chat that parked before the note was sent is asked again: the user may be
 * reading it right now.
 */
function focusedAtSafePoint(load: ConversationLoad, askedAt: number | undefined): boolean {
  if (askedAt === undefined) return false;
  if (load.status !== "waiting" || load.lastNote === undefined) return false;
  return load.updatedAt >= askedAt;
}

/** What the safe-point check decided, and what the caller has to record either way. */
interface SafePointOutcome {
  /** Set when the restart has to wait: what to report, and the row's per-child reasons. */
  readonly refusal?: { readonly code: string; readonly message: string; readonly reasons: readonly string[] };
  /** Set when `allowBusyReason` skipped the check: the lines the passing row keeps. */
  readonly bypass?: readonly string[];
}

/**
 * Tell every working child to stand at a safe point, and refuse to ask the
 * user until they have.
 *
 * A cold restart does not end a session: the conversation and the job records
 * survive it, and what it cuts is the turn in flight. So a parked child is no
 * reason to wait, and a working one is not a reason to refuse — it is a reason
 * to tell that child to finish the block it is on and park.
 *
 * An open focused chat is a target whether it is working or idle, because the
 * user can write to it at any moment. It counts as parked only after it parked
 * since this gate asked it to (`focusedAtSafePoint`), so the `waiting` status it
 * was opened with never passes the gate on its own.
 *
 * The notes are delivered at the end of each child's run, so this call can only
 * report that they went out. The next call re-reads the tree: a child that has
 * parked is no longer busy, and the gate goes on to its own checks.
 *
 * A build with no subagent hub has no children to check, so the check passes
 * there rather than inventing a wait nobody can end.
 */
async function safePointCheck(
  context: ExtensionContext,
  ctx: import("@earendil-works/chord").Context,
  conversationId: ConversationId,
  title: string,
  allowBusyReason: string | undefined,
  told: Map<string, number>,
  focusedTold: Map<string, number>,
): Promise<SafePointOutcome> {
  // An empty reason is not a bypass: it would skip the check and leave the audit
  // row with nothing in it, which is the one thing this argument exists to avoid.
  if (allowBusyReason !== undefined && allowBusyReason.trim() === "") {
    return {
      refusal: {
        code: "busy_bypass_reason_invalid",
        reasons: ["allowBusyReason was given but is empty, so nothing was skipped and no reason was recorded."],
        message:
          "Restart NOT requested — `allowBusyReason` was given as an empty string. Skipping the safe-point check leaves an audit row with no reason in it, so the check was not skipped." +
          " Say why the check cannot wait for the children, or leave the argument out and let them be told.",
      },
    };
  }

  const hub: SubagentHub | undefined = context.subagents;
  if (hub === undefined) return {};

  const loads = await loadTree(context, hub, conversationId, ctx);
  const busy = loads.filter((load) => load.kind !== "focused" && load.busy);
  // Every open focused chat is a target, working or not: the user can write to
  // one at any moment, so an idle chat is not a chat a restart may skip. One
  // that is archived or deleted is gone from the parent's index already, and
  // the store is asked as well, because an archive retires the edge and the
  // record in two steps.
  const store = context.focusedChats;
  const focused = loads.filter((load) => {
    if (load.kind !== "focused") return false;
    const row = store?.get(Number(load.conversationId));
    return row !== undefined && row.archivedAt === null;
  });
  const focusedWaiting = focused.filter(
    (load) => !focusedAtSafePoint(load, focusedTold.get(load.conversationId)),
  );

  // The maps outlive one call, so an entry whose conversation no longer appears
  // in this scan is a child that was retired or deleted. Keeping it would deny
  // that conversation a note if it came back; dropping it costs one note after
  // a restart, which is the right way to be wrong.
  const seen = new Set(loads.map((load) => load.conversationId));
  for (const id of [...told.keys()]) if (!seen.has(id)) told.delete(id);
  for (const id of [...focusedTold.keys()]) {
    if (!focused.some((load) => load.conversationId === id)) focusedTold.delete(id);
  }
  // A child that is still here but no longer busy is forgotten too, so the next
  // request tells it again if it starts working in the meantime. A focused chat
  // keeps its entry while it is parked: that time is what the parked rule reads.
  for (const load of loads) if (load.kind !== "focused" && !load.busy) told.delete(load.conversationId);

  if (allowBusyReason !== undefined) {
    const skipped = [...busy, ...focusedWaiting].map(
      (load) => `${load.name} (conversation ${load.conversationId})`,
    );
    return {
      bypass: [
        `busy bypass: ${allowBusyReason.trim()}`,
        skipped.length === 0 ? "busy bypass skipped no child, because none was busy" : `busy bypass skipped: ${skipped.join(", ")}`,
      ],
    };
  }

  // Every child and every focused chat is at a safe point: there is nothing to
  // interrupt, and the gate goes on to its own checks.
  if (busy.length === 0 && focusedWaiting.length === 0) return {};

  const now = Date.now();
  const body = safePointNote(title);
  const focusedBody = focusedSafePointNote(title);
  const me = await hub.nameOf(conversationId, ctx);
  const lines: string[] = [];
  for (const load of busy) {
    const earlier = told.get(load.conversationId);
    let sent: string;
    if (earlier !== undefined && now - earlier < SAFE_POINT_RESEND_MS) {
      sent = `note sent ${ageText(now - earlier)}`;
    } else {
      let delivery: { readonly delivered: boolean; readonly problem?: string };
      try {
        const message = await hub.writeMessage(ctx, {
          from: { conversationId: String(conversationId), name: me.name, agentKind: me.kind },
          to: { conversationId: load.conversationId, name: load.name, agentKind: "subagent" },
          kind: "note",
          body,
        });
        delivery = await hub.deliver(ctx, message);
      } catch (error) {
        delivery = { delivered: false, problem: error instanceof Error ? error.message : String(error) };
      }
      // Recorded even when it failed: a child that could not be told is retried
      // on the same ten-minute clock as one that was, so a broken delivery cannot
      // turn one request per second into one message per second.
      told.set(load.conversationId, now);
      sent = delivery.delivered ? "note sent now" : `note NOT delivered: ${delivery.problem ?? "the hub did not say why"}`;
    }
    const calls = load.runningCalls === 0 ? "" : `, running background calls: ${load.runningCalls}`;
    lines.push(`${load.name} (conversation ${load.conversationId}, last tool: ${load.lastTool ?? "-"}, live tasks: ${load.liveTasks}${calls}, ${sent})`);
  }
  // A focused chat gets its own note and is told once per request, on the same
  // clock. It is idle most of the time, so the note reaches it at once instead
  // of at the end of a run, and the chat's role file says what to do with it.
  for (const load of focusedWaiting) {
    const earlier = focusedTold.get(load.conversationId);
    let sent: string;
    if (earlier !== undefined && now - earlier < SAFE_POINT_RESEND_MS) {
      sent = `note sent ${ageText(now - earlier)}`;
    } else {
      let delivery: { readonly delivered: boolean; readonly problem?: string };
      try {
        const message = await hub.writeMessage(ctx, {
          from: { conversationId: String(conversationId), name: me.name, agentKind: me.kind },
          to: { conversationId: load.conversationId, name: load.name, agentKind: "focused" },
          kind: "note",
          body: focusedBody,
        });
        delivery = await hub.deliver(ctx, message);
      } catch (error) {
        delivery = { delivered: false, problem: error instanceof Error ? error.message : String(error) };
      }
      // Kept after a failed delivery for the same reason as a subagent's: one
      // request per second must not become one message per second.
      focusedTold.set(load.conversationId, now);
      sent = delivery.delivered ? "note sent now" : `note NOT delivered: ${delivery.problem ?? "the hub did not say why"}`;
    }
    lines.push(
      `${load.name} (conversation ${load.conversationId}, focused chat, status: ${load.status}, ${sent})`,
    );
  }

  // What the tool reports has to match the restart state, not the call. Three
  // states are different facts, and only one of them can say a request is out:
  // nothing recorded; a core change recorded with no request raised yet (the
  // batch is open, or an earlier gate run failed); and a gate that passed, which
  // is the only state the user can act on. None of the three withdraws
  // anything — this call raised no request, and what is recorded stays recorded.
  const status = context.restart.status;
  const opening = status.ready
    ? "Restart NOT requested again — a request already went to the user for this batch, and this call left it as it is."
    : status.required
      ? "Restart NOT requested yet — a core change is recorded, but no request has gone to the user."
      : "Restart NOT requested yet — no request is recorded.";

  return {
    refusal: {
      code: "safe_point_waiting",
      reasons: lines,
      message: [
        `${opening} This call raised no request; safe-point requests sent to ${lines.length} child conversation${lines.length === 1 ? "" : "s"}:`,
        ...lines.map((line) => `  - ${line}`),
        "A working child receives the note at the end of the run in flight, and an idle focused chat receives it now. Call request_restart again after each reports a safe point.",
      ].join("\n"),
    },
  };
}

/** The event that was judged, kept in the audit row so a reader can tell what moved. */
export type RestartWatchTrigger = "status" | "request" | "async-started" | "async-settled";

/**
 * The two notes the harness owes the root while a restart request is up.
 *
 * The state belongs to the root. Only `request_restart`, `withdraw_restart`, and
 * the admin routes write it, and this watch never does: what the root raised, the
 * root takes back. What the harness can do is notice the one fact the root cannot
 * see from inside its own turn — that its subagents went back to work after the
 * gate passed, or that they have all stopped again — and say so once.
 *
 * The events judged are the ones that can move the safe point: a status change in
 * the hub, a subagent's model request, and a background call that starts or
 * settles. There is no timer, so a quiet tree is judged by nothing.
 */
export interface RestartSafePointWatch {
  /** A gate passed and the request went to the user: from here on the safe point is judged. */
  arm(input: { readonly conversationId: ConversationId; readonly title: string }): void;
  /** One event that can move the safe point. Answers at once while no episode is open. */
  observe(ctx: Context, trigger: RestartWatchTrigger): Promise<void>;
}

/**
 * One episode of the watch.
 *
 * `up` is a request that went to the user with the tree at a safe point. `lost`
 * is the same request after a subagent broke that, which the root was told about;
 * the second note is owed from then on, and it ends the episode. Nothing is
 * judged in `idle` or `done`, so the cost of the watch is nothing until a gate
 * passes, and nothing again after the episode closes.
 */
type WatchPhase = "idle" | "up" | "lost" | "done";

/** What the root is told when a subagent goes back to work under a request that is still up. */
function safePointLostNote(title: string, agentName: string): string {
  return `[restart state] The restart request for "${title}" is still up, but ${agentName} started working. The safe point no longer holds. Withdraw the request with withdraw_restart and tell the user that the restart must wait.`;
}

/** What the root is told once every subagent is at a safe point again and the request is withdrawn. */
function safePointBackNote(): string {
  return "[restart state] Every subagent is at a safe point again. If the batch is closed, raise the restart request again with request_restart.";
}

/**
 * The watch of one runtime, keyed by the restart state it watches.
 *
 * The state is one object per process (`src/runtime/restart.ts`), shared by the
 * harness, the extension context, and the admin API, so it is the handle that the
 * code which reports an event already holds. `self-edit` registers the watch when
 * the extension is built, and `subagents` and `async-tools` ask for it. A build
 * without the `self-edit` extension has no watch and sends no notes.
 */
const restartWatches = new WeakMap<RestartState, RestartSafePointWatch>();

/** The watch of the runtime that owns this restart state, if one was registered. */
export function restartWatchOf(restart: RestartState): RestartSafePointWatch | undefined {
  return restartWatches.get(restart);
}

/**
 * The safe-point watch itself: who is working, and which note that earns.
 *
 * The rule is the gate's own (`loadTree`, `isBusy` above), so the watch and
 * `request_restart` cannot disagree about what "working" means. What it reports
 * goes one way only: notes into the root's conversation and rows into the audit
 * log. The restart state is read here and never written.
 */
function createRestartSafePointWatch(context: ExtensionContext): RestartSafePointWatch {
  let phase: WatchPhase = "idle";
  let root: ConversationId | undefined;
  let title = "";
  /** One id per episode, so a repeated write is the same submission rather than a second note. */
  let episode = "";
  let settled: Promise<void> = Promise.resolve();

  /**
   * Put one note in the root's conversation, and record it.
   *
   * The note is a `restart` input, not an agent message: the harness is not a
   * peer in the tree, and labelling it `agent` would read as one agent talking to
   * another. `whenBusy: followUp` places it at the next boundary, so a root that
   * is inside a tool call reads it when that call returns. A note that does not
   * reach the conversation is logged and named in the row, because a silent
   * failure here is a root that never learns the safe point moved.
   */
  const note = async (
    trigger: RestartWatchTrigger,
    row: "restart_safe_point_lost" | "restart_safe_point_back",
    body: string,
    agent?: string,
  ): Promise<void> => {
    const conversationId = root;
    if (conversationId === undefined) return;
    let problem: string | undefined;
    try {
      const conversation = await context.harness?.conversation(conversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) {
        problem = "the root conversation is gone";
      } else {
        await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
          type: "input",
          src: "restart",
          attrs: { via: row === "restart_safe_point_lost" ? "safe-point-lost" : "safe-point-back" },
          content: body,
          whenBusy: "followUp",
          requestId: `restart-state:${episode}:${row}`,
        }, context.getConfig().timezone);
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem !== undefined) context.logger.warn("the restart state note was not delivered", { problem, trigger });
    context.audit.append({
      type: row,
      title,
      conversationId,
      ...(agent === undefined ? {} : { agent }),
      trigger,
      ...(problem === undefined ? {} : { problem }),
    });
  };

  /**
   * Judge one event, and write the note it earned.
   *
   * A request that went down before anything was lost ends the episode here: the
   * root took it back on its own, so no note is owed and nothing is left to watch.
   * A `lost` episode is judged after the withdrawal too, which is the one case in
   * which an event is read while the state is not ready: the second note is about
   * the withdrawal, and without a judgement there it could never go out.
   */
  const judge = async (ctx: Context, trigger: RestartWatchTrigger): Promise<void> => {
    if (phase !== "up" && phase !== "lost") return;
    if (root === undefined) return;
    const hub: SubagentHub | undefined = context.subagents;
    if (hub === undefined) return;
    const ready = context.restart.status.ready;
    if (phase === "up" && !ready) {
      phase = "idle";
      return;
    }
    // The second note says the request can be raised again, so it cannot go out
    // while the request is still up: that would invite a second request beside it.
    if (phase === "lost" && ready) return;

    const busy = (await loadTree(context, hub, root, ctx)).filter((load) => load.busy);
    if (phase === "up") {
      const first = busy[0];
      if (first === undefined) return;
      // Moved before the note is written, so an event that arrives while it is in
      // flight judges the same episode and writes nothing more.
      phase = "lost";
      await note(trigger, "restart_safe_point_lost", safePointLostNote(title, first.name), first.name);
      return;
    }
    if (busy.length > 0) return;
    phase = "done";
    await note(trigger, "restart_safe_point_back", safePointBackNote());
  };

  return {
    arm(input) {
      phase = "up";
      root = input.conversationId;
      title = input.title;
      episode = ulid();
    },
    observe(ctx, trigger) {
      // Judged one at a time, in the order the events arrived: two events close
      // together would otherwise both read the tree and both write the note.
      settled = settled.then(() => judge(ctx, trigger)).catch((error: unknown) => {
        context.logger.warn("the restart safe-point watch failed", { error, trigger });
      });
      return settled;
    },
  };
}

export interface SelfEditInput {
  readonly title: string;
  readonly kind: "runtime-extension" | "core-change" | "promotion";
  readonly files: readonly string[];
  readonly diffHash?: string;
  readonly validation: ValidationResult;
  readonly commit?: string;
  readonly restartRequired: boolean;
}

/** The bundled `self-edit` extension. */
export function createSelfEditExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const config = context.getConfig();
  const workspaceRoot = resolve(config.code.workspace);
  const snapshotRoot = resolve(config.code.snapshot);

  // Which working child a safe-point note has already gone to, and when. The
  // map lives as long as this extension does: `reload_extensions` and a cold
  // restart build it again, and telling a child twice is the right way to be
  // wrong.
  const safePointNotesSent = new Map<string, number>();
  // The same, for the open focused chats. The time kept here is also the mark
  // the parked rule reads: a chat's own `await_orders` write compared with it.
  const focusedNotesSent = new Map<string, number>();

  // The watch that reports a broken safe point to the root. It is registered
  // under the restart state, which is the object the code that sees an event
  // already holds, and it is armed only when a gate passes.
  const restartWatch = createRestartSafePointWatch(context);
  // A context with no runtime behind it (a stub in a test, or a build without the
  // harness) has no restart state to key a watch by, and nothing to report to.
  if (context.restart !== undefined) restartWatches.set(context.restart, restartWatch);

  const record = async (
    api: import("@earendil-works/pi-durable").ToolExecutionApi,
    ctx: import("@earendil-works/chord").Context,
    input: SelfEditInput,
  ) => {
    const id = ulid();
    const now = Date.now();
    await api.commit(async (tx) => {
      const draft = await tx.doc(SecSelfEdit, api.conversationId, id, id);
      draft.id = id;
      draft.title = input.title;
      draft.kind = input.kind;
      draft.files = [...input.files];
      if (input.diffHash !== undefined) draft.diffHash = input.diffHash;
      draft.validation = { ...input.validation };
      if (input.commit !== undefined) draft.commit = input.commit;
      draft.restartRequired = input.restartRequired;
      draft.createdAt = now;
      draft.updatedAt = now;
      if (input.kind !== "runtime-extension") {
        // A core change reaches the review queue only once the gate let it
        // through. An ungated single-file edit is still recorded in the
        // operation log — that is the audit trail — but proposing a change
        // nobody has checked is how the queue fills with work that cannot be
        // applied.
        const checked = input.validation.typecheck === true && input.validation.tests === true;
        if (!checked) return;
        const candidateId = ulid();
        const candidate = await tx.doc(SecCandidate, candidateId, candidateId);
        candidate.id = candidateId;
        candidate.title = input.title;
        candidate.summary = input.files.join(", ");
        candidate.origin = input.kind === "promotion" ? "runtime-promotion" : "core-edit";
        candidate.files = [...input.files];
        if (input.diffHash !== undefined) candidate.diffHash = input.diffHash;
        if (input.commit !== undefined) candidate.commit = input.commit;
        candidate.validation = { ...input.validation };
        candidate.status = "proposed";
        candidate.createdAt = now;
        candidate.updatedAt = now;
      }
    }, ctx);
    // Committed core work is not what this process booted from, and any earlier
    // "go ahead" is stale the moment the batch moves again: a restart taken up
    // mid-batch boots half a change. This is the single place that raises the
    // need, so `self_edit` and `request_restart` cannot forget to.
    if (input.kind !== "runtime-extension") context.restart.requireRestart();
  };

  const edit = defineTool({
    name: "self_edit",
    description:
      "Write or patch a file in the workspace (modification) tree. Never executed by the running process; a core change needs a cold restart. Without kind, the write counts as a core change.",
    parameters: obj(
      {
        path: str(),
        content: opt(str()),
        oldText: opt(str()),
        newText: opt(str()),
        title: str(),
        kind: opt(union([lit("runtime-extension"), lit("core-change"), lit("promotion")])),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const target = resolveWorkspacePath(workspaceRoot, args.path);
      try {
        await resolveWorkspacePathReal(workspaceRoot, args.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) {
          return { output: [{ type: "text" as const, text: `refused: ${error.message}` }], isError: true };
        }
        throw error;
      }
      if (args.content === undefined && (args.oldText === undefined || args.newText === undefined)) {
        return { output: [{ type: "text" as const, text: "provide content, or both oldText and newText" }], isError: true };
      }
      let next: string;
      if (args.content !== undefined) {
        next = args.content;
      } else {
        const current = await readFile(target, "utf8").catch(() => undefined);
        if (current === undefined) {
          return { output: [{ type: "text" as const, text: `file not found: ${args.path}` }], isError: true };
        }
        if (!current.includes(args.oldText!)) {
          return { output: [{ type: "text" as const, text: `oldText not found in ${args.path}` }], isError: true };
        }
        next = current.replace(args.oldText!, args.newText!);
      }

      const secretsClean = !context.secrets.redactor().containsSecret(next);
      if (!secretsClean) {
        return { output: [{ type: "text" as const, text: "refused: the edited file contains a registered secret value" }], isError: true };
      }

      // Checked again right before the write: the tree may have changed since.
      try {
        await resolveWorkspacePathReal(workspaceRoot, args.path);
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) {
          return { output: [{ type: "text" as const, text: `refused: ${error.message}` }], isError: true };
        }
        throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, next, { encoding: "utf8", mode: 0o600 });
      const rel = relative(workspaceRoot, target);
      const diffHash = createHash("sha256").update(next).digest("hex");
      const kind = args.kind ?? "core-change";
      const validation: ValidationResult = { secretsClean };
      await record(api, ctx, {
        title: args.title,
        kind,
        files: [rel],
        diffHash,
        validation,
        restartRequired: kind !== "runtime-extension",
      });
      context.audit.append({ type: "self_edit", path: rel, diffHash, kind, conversationId: api.conversationId });
      if (kind !== "runtime-extension") {
        context.events.emit("restart_required", { title: args.title, files: [rel], diffHash, ready: false });
      }
      return {
        output: [
          {
            type: "text" as const,
            text:
              kind === "runtime-extension"
                ? `wrote ${rel} (${diffHash.slice(0, 12)}) in the workspace tree`
                : `wrote ${rel} (${diffHash.slice(0, 12)}) in the workspace tree. A restart is now needed but NOT requested: call request_restart when the batch is closed so the gate can run.`,
          },
        ],
      };
    },
  });

  const reload = defineTool({
    name: "reload_extensions",
    description:
      "Reload runtime extensions from the extensions directory. Core code is cold-only. A removed directory's tools and sections stay until the next cold restart.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      if (context.reloadExtensions === undefined) {
        return { output: [{ type: "text" as const, text: "runtime extension loader is not available" }], isError: true };
      }
      const result = await context.reloadExtensions();
      return {
        output: [
          {
            type: "text" as const,
            text: `reloaded: ${result.reloaded.join(", ") || "(none)"}${result.errors.length > 0 ? `\nerrors: ${result.errors.join("; ")}` : ""}`,
          },
        ],
        isError: result.errors.length > 0,
      };
    },
  });

  const restart = defineTool({
    name: "request_restart",
    description:
      "Ask the user to apply a committed core change. Needs `reportId`: the report whose newest revision the user approved. Runs the gate against the workspace tree — typecheck, the test suite, and a secret scan of the whole change — and raises the request only when it passes. A child conversation that is working is first told to stand at a safe point, and the call returns `safe_point_waiting` until each has parked; `allowBusyReason` skips that check and records the reason instead.",
    parameters: obj(
      {
        title: str(),
        files: opt(arr(str())),
        reportId: str({
          description:
            "The report whose newest revision carries the user's approval. Consent is recorded there, so the gate cannot stand in for it.",
        }),
        allowBusyReason: opt(
          str({
            description:
              "Skip the safe-point check for child conversations that are still working, and record this reason instead. Only for a child that cannot reach a safe point; an empty string is refused.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      // Asked first, because it is the cheaper question and because a refusal is
      // a refusal whether or not the change compiles: running the suite to say
      // "no" spends minutes to answer something else.
      const refused = await approvalRefusal(context, ctx, args.reportId);
      if (refused !== undefined) {
        context.audit.append(
          restartRefusedRow({ code: refused.code, reasons: [refused.message] }, args.title, api.conversationId),
        );
        return { output: [{ type: "text" as const, text: refused.message }], isError: true };
      }

      // A restart cuts the turn in flight, so a child that is working has to be
      // told to stand at a safe point before the user is asked at all. This
      // is a wait rather than a refusal: the children receive the note at the
      // end of their run, and the next call re-reads the tree.
      const safePoint = await safePointCheck(
        context,
        ctx,
        api.conversationId,
        args.title,
        args.allowBusyReason,
        safePointNotesSent,
        focusedNotesSent,
      );
      if (safePoint.refusal !== undefined) {
        context.audit.append(
          restartRefusedRow(
            { code: safePoint.refusal.code, reasons: safePoint.refusal.reasons },
            args.title,
            api.conversationId,
          ),
        );
        return { output: [{ type: "text" as const, text: safePoint.refusal.message }], isError: true };
      }

      const files = args.files ?? [];
      // The gate runs the full test suite, so its time follows that run: every
      // command it starts is bounded by `validation.timeoutMs`. The root may run
      // this call in the background and cancel it when the batch changes. The
      // signal reaches both commands, and a cancelled gate raises nothing: a check
      // that did not finish is not a pass.
      const signal = ctx.abortSignal;
      // Read through a call, so the value is taken after each await instead of
      // being narrowed once from the state it had before the gate started.
      const cancelled = (): boolean => signal?.aborted === true;
      const gate = await runValidation({
        root: workspaceRoot,
        timeoutMs: context.getConfig().validation.timeoutMs,
        signal,
      });
      if (cancelled()) return cancelledRestart();
      const change = await collectChangeText(workspaceRoot, snapshotRoot, { signal });
      if (cancelled()) return cancelledRestart();
      const secretsClean = change.text !== undefined && !context.secrets.redactor().containsSecret(change.text);

      await record(api, ctx, {
        title: args.title,
        kind: "core-change",
        files,
        validation: { secretsClean, typecheck: gate.typecheck, tests: gate.tests },
        restartRequired: true,
      });

      if (!secretsClean || !gate.typecheck || !gate.tests) {
        const reasons = [
          ...(secretsClean ? [] : [`secret scan: ${change.problem ?? "a registered secret value appears in the change"}`]),
          ...(gate.typecheck ? [] : [`typecheck: ${gate.skipped ?? "failed"}`]),
          ...(gate.tests
            ? []
            : [`tests: ${gate.skipped ?? (gate.typecheck ? "failed" : "not run, because the change does not compile")}`]),
        ];
        context.audit.append(restartRefusedRow({ code: "gate_failed", reasons }, args.title, api.conversationId));
        return {
          output: [
            {
              type: "text" as const,
              text: `Restart NOT requested — the gate refused the change, so the user was not asked.\n${reasons
                .map((reason) => `- ${reason}`)
                .join("\n")}${gate.output === undefined ? "" : `\n\n${gate.output}`}`,
            },
          ],
          isError: true,
        };
      }

      context.restart.markReady();
      // The request is out and the tree is at a safe point. From here on, work by
      // a subagent breaks what the request says, and the root hears about it.
      restartWatch.arm({ conversationId: api.conversationId, title: args.title });
      context.events.emit("restart_required", { title: args.title, files, ready: true });
      context.audit.append({
        type: "restart_required",
        title: args.title,
        conversationId: api.conversationId,
        // The one record a bypass leaves behind: an unchecked gate is a fact the
        // user has to be able to find afterwards.
        ...(safePoint.bypass === undefined ? {} : { reasons: [...safePoint.bypass] }),
      });
      return {
        output: [
          {
            type: "text" as const,
            text: `Gate passed: typecheck, tests, and a secret scan of the change. Ask the user to restart the daemon: the restart button in the web UI works under the systemd user unit and under user-tools/run; otherwise the user stops the daemon, runs user-tools/update-and-restart, and starts it again (snapshot tree: ${snapshotRoot}).`,
          },
        ],
      };
    },
  });

  // A restart applies whatever is on disk at that moment, so a request raised
  // before the batch is closed can boot half a change. Retracting it is the only
  // way to say "still working" without also pretending the need went away.
  const withdraw = defineTool({
    name: "withdraw_restart",
    description:
      "Retract a pending restart request while more work is added to the batch. The restart is still required; this only says it is not ready to be applied yet.",
    parameters: obj({ reason: opt(str()) }),
    replay: "unsafe",
    execute: async (args, api) => {
      context.restart.withdraw();
      const status = context.restart.status;
      context.events.emit("restart_withdrawn", { reason: args.reason ?? null });
      context.audit.append({ type: "restart_withdrawn", reason: args.reason, conversationId: api.conversationId });
      return {
        output: [
          {
            type: "text" as const,
            text: status.required
              ? "Restart request withdrawn. The core change still needs a restart — call request_restart again once the batch is closed and the gate passes."
              : "Nothing was pending: a restart is not required, so there was no request to withdraw.",
          },
        ],
      };
    },
  });

  /**
   * What the model reads about extending pi-sec, chosen by its own tool list.
   *
   * Staging a core change is the root's act: `request_restart` and
   * `withdraw_restart` are removed from every other kind, so the sentences that
   * tell the reader to call them reach the root alone. Every other conversation
   * reads what it can do instead: edit a runtime extension, and know that a core
   * change needs a restart the user applies and the root asks for. The tool list
   * is written in the commit that creates the conversation and never changes, so
   * this choice is as stable as any other value a section renders.
   */
  const guide = section("self-edit", (input) => {
    const offered = new Set(input.agent.tools.map((tool) => tool.name));
    if (offered.has("request_restart")) {
      return `You can extend yourself without a restart by editing runtime extensions under the extensions directory. The daemon watches that directory and reloads every runtime extension about 250 ms after a file changes, so an edit is live at once, and a half-written file fails to load while the previous version stays installed. Write a new version to a temporary file in the same directory and rename it into place.
To change core code, edit files in the workspace (modification) tree. A committed core change needs a cold restart, which only the user applies: edit, then close the batch and call \`request_restart\`, which runs the gate (typecheck, tests, secret scan) and asks the user only if it passes. Before it asks, it tells every child conversation that is working to finish the block it is on, park, and report a safe point; the call returns \`safe_point_waiting\` until they have. While the batch is still open, \`withdraw_restart\` retracts an earlier request — the restart stays required, it just must not be applied mid-batch.
The running process never replaces its own loaded code.
Workspace tree: ${workspaceRoot}. Execution (snapshot) tree (read-only, current behavior): ${snapshotRoot}.`;
    }
    return `You can extend pi-sec without a restart by editing runtime extensions under the extensions directory. The daemon watches that directory and reloads every runtime extension about 250 ms after a file changes, so an edit is live at once, and a half-written file fails to load while the previous version stays installed. Write a new version to a temporary file in the same directory and rename it into place.
To change core code, edit files in the workspace (modification) tree. A committed core change needs a cold restart, which only the user applies. The root requests that restart after the change is committed. Before the restart, every conversation that is working is asked to finish the block it is on, park, and report a safe point.
The running process never replaces its own loaded code.
Workspace tree: ${workspaceRoot}. Execution (snapshot) tree (read-only, current behavior): ${snapshotRoot}.`;
  });

  return defineExtension({ name: "self-edit", tools: [edit, reload, restart, withdraw], sections: [guide] });
}
