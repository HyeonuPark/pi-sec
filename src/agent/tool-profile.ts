import type { AgentKind } from "../documents.ts";

/**
 * Which tools a conversation of each kind is offered.
 *
 * A tool that is not in a conversation's tool list cannot be reached at all:
 * `js`'s nested runner and `async_call` both look the tool up in that
 * conversation's `agent.tools`, so removal is the gate that also holds for
 * nested calls. `ToolTask.beforeTool` runs on top of it as a second layer, for
 * the case where a selection is wrong.
 *
 * The lists are the whole truth about a kind's capabilities, which is why they
 * live in one place rather than at each call site.
 */

/**
 * Tools a subagent must not have: the operator's channel is the root's.
 *
 * `spawn_subagent` and `subagent_delete` are not here on purpose, so a worker is
 * offered both. A worker starts no agent today, and the worker role file and the
 * conventions say so; the tools stay because the subagent roles a worker may
 * start are still to be added, and a stored filter cannot be widened when they
 * arrive. Until then they are an offer a worker does not use, not a capability.
 */
export const SUBAGENT_TOOL_REMOVALS: readonly string[] = [
  // Reaching the operator is the root's job. A subagent reports to its parent.
  "ask_user",
  "notify",
  // The active question list is part of the same channel. A subagent answers to
  // its parent, so it neither opens a question for the operator nor withdraws one.
  "questions_open",
  "question_withdraw",
  // Publishing a report is the root's decision; a subagent may only draft one.
  "reports_create",
  "reports_add_version",
  "reports_publish_draft",
  "reports_draft_drop",
  // Whether a report waits for the operator's answer is a judgement about the
  // operator's attention, and the root is the one who holds the whole picture of
  // what is waiting on them. A report is also published by the root alone, so the
  // agent that sets one aside is the agent that put it there.
  "reports_set_pending",
  // Which job a report belongs to is a decision about the job tree, like
  // publishing one, so the root makes it.
  "reports_move",
  // A core change asks the operator for a restart, so only the root may stage one.
  "self_edit",
  "reload_extensions",
  "request_restart",
  "withdraw_restart",
  // Ownership of a job's files is the operator's channel. A subagent reports to
  // its parent, so it may publish an image or read one back, but it does not
  // decide which job keeps a file.
  "attachments_assign",
  // A focused chat is a sub-session of the root that the user reads and writes,
  // so nothing that publishes, asks, or changes the installation belongs to it.
  // Archiving and deleting a chat are the root's acts and are named here as well
  // as in the live gate below, because the stored filter is what a conversation
  // created before the gate existed keeps.
  "focused_chat_archive",
  "focused_chat_delete",
  // A title is the focused chat's own fact: the root has no title to set.
  "focused_chat_title",
  // The personality decides the language and the voice of everything the user
  // reads, so registering one is the root's act: a subagent's document would
  // reach the root's next session and no one else's. Reading it stays open, which
  // is why only the setter is here. The scheduled list extends this one, so it is
  // removed there too.
  "personality_set",
  // A session's seal is that session's own fact, and only the root opens a restart
  // round. The scheduled list extends this one, so it is removed there too.
  "session_stale",
  // A level is the user's allowance for a machine, and only the root talks with the
  // user. A subagent asks its parent, and the root asks the user; a tool a worker
  // cannot call is a tool it cannot reach through `js` or `async_call` either.
  // `RemoteMachines.tighten` refuses a wider level as well, so a conversation whose
  // stored filter predates this entry is still held to one direction.
  "remote_level_tighten",
];

/**
 * Tools a scheduled run must not have.
 *
 * A scheduled run investigates. If real work is needed it tells the root and
 * ends, so it neither spawns agents nor waits for anything: it can only read,
 * run commands, and send the root one message. `async_call` is excluded because
 * the run's conversation ends with it, and a background result delivered to a
 * conversation nobody reads is a result nobody gets.
 */
export const SCHEDULED_TOOL_REMOVALS: readonly string[] = [
  ...SUBAGENT_TOOL_REMOVALS,
  "reports_draft",
  "spawn_subagent",
  "subagent_delete",
  "background_list",
  "send_reply",
  "request_message",
  "await_orders",
  // A scheduled run holds no slot and ends with its one message to the root.
  "finish_work",
  "async_call",
  "async_cancel",
  // Restarting is a session-wide act across a tree of agents. A scheduled run
  // has one turn, no children, and reports to the root instead.
  "restart_session",
  "restart_cascade_start",
  "restart_cascade_status",
  "restart_cascade_close",
  // A scheduled run leaves one answer and ends, so no conversation stays to watch
  // what it started on a remote machine: a run would go on with nobody reading its
  // checks, a write would change a machine nobody is looking at, and a sync could
  // remove files there. The reading tools of that extension stay: they change
  // nothing on the machine.
  "remote_run",
  "remote_run_stop",
  "remote_write",
  "remote_edit",
  "remote_sync",
  // A scheduled run investigates and reports, so it never needs to write to the
  // issue tracker. The reading tools of that extension stay.
  "linear_create_issue",
  "linear_update_issue",
  "linear_add_comment",
];

/** The stored `pi.agent.tools` filter for one kind, as a removal list. */
export function toolFilterFor(kind: AgentKind): { readonly remove: string[] } | undefined {
  // A focused chat's filter is an allow list and not a removal list, so it is
  // built by `focusedChatTools` when the chat is opened. Removing a tool from a
  // list the chat never receives would say nothing.
  if (kind === "focused") return undefined;
  const list =
    kind === "scheduled" ? SCHEDULED_TOOL_REMOVALS : kind === "subagent" ? SUBAGENT_TOOL_REMOVALS : ROOT_TOOL_REMOVALS;
  return list.length === 0 ? undefined : { remove: [...list] };
}

/**
 * The tool a stored allow list must contain to be a focused chat's.
 *
 * The stored filter is what outlives the agent record, so `kindOf` reads it for a
 * conversation whose record is gone. Only a focused chat is offered this tool, so
 * its presence is what tells an allow list apart from anything else a future
 * feature may store there.
 */
export const FOCUSED_CHAT_CREATED_MARKER = "focused_chat_title";

/**
 * The tools a focused chat is offered, as an allow list.
 *
 * An allow list and not a removal list, on purpose: a focused chat answers, reads
 * and asks the root, so a tool nobody thought about must arrive closed. A removal
 * list would open every tool added later to a conversation the user believes is
 * read-only.
 *
 * The list is fixed when the chat is opened and written into the creating commit,
 * the way a spawn writes its own filter. A runtime extension's tool is reachable
 * only from `agent.focusedChat.extraTools`, because that list is what an operator
 * decides for this installation.
 *
 * `await_orders` and `restart_session` are here for a restart: a focused chat is
 * told about one and parks like any other session. `js` and `async_call` reach
 * only the tools of their own conversation, so the list also bounds a nested
 * call.
 */
export const FOCUSED_CHAT_TOOLS: readonly string[] = [
  // Reading: answers, jobs, reports, lessons, files, and the state of other work.
  "read",
  "read_full",
  "jobs_list",
  "jobs_get",
  "reports_list",
  "reports_get",
  "lessons_list",
  "lessons_get",
  "attachments_list",
  "attachment_open",
  "personality_get",
  "usage",
  "expiry_check",
  "diagnose_conversation",
  "fetch_url",
  // Asking the root: a focused chat does not change the system, it reports what
  // the user asked for.
  "send_message",
  "request_message",
  "async_call",
  "async_cancel",
  "background_list",
  // A restart: the chat tells the user, writes its state file, then parks.
  "await_orders",
  "restart_session",
  // The chat's own title, once.
  FOCUSED_CHAT_CREATED_MARKER,
  // A picture in an answer. It copies a file and changes no behavior.
  "share_image",
  // Shell and files. The role file restricts the shell to reading commands and
  // the file tools to the chat's own state file; that is a prompt rule, not a gate.
  "bash",
  "write",
  "edit",
  "js",
];

/**
 * The allow list one focused chat is opened with: the fixed tools, then whatever
 * this installation adds in `agent.focusedChat.extraTools`.
 *
 * A name that is repeated keeps its first place, so the stored filter is stable
 * and the seal sees no change between two openings.
 */
export function focusedChatTools(extra: readonly string[] = []): string[] {
  const tools = [...FOCUSED_CHAT_TOOLS];
  for (const name of extra) {
    const trimmed = name.trim();
    if (trimmed === "" || tools.includes(trimmed)) continue;
    tools.push(trimmed);
  }
  return tools;
}

/**
 * Tools the root must not have.
 *
 * Drafting is how a subagent hands a document to the root for a decision. The
 * root makes the decision, so it publishes directly with `reports_create`; a
 * draft tool in its list would only offer a step that leads nowhere. Removing it
 * from the selection matters as much as blocking it, because an offered tool
 * costs prompt tokens on every request and invites a call that always fails.
 *
 * `finish_work` ends a subagent for good. The root is the user's conversation
 * and never ends, so the tool would only be a call that always fails.
 *
 * `focused_chat_title` names the focused chat that sets it, and the root is not
 * one. The root archives and deletes chats; it does not title them.
 */
export const ROOT_TOOL_REMOVALS: readonly string[] = ["reports_draft", "finish_work", "focused_chat_title"];
