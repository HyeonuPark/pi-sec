import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import type { ExtensionContext } from "./context.ts";

/**
 * Which agent is asking, as the two guidance extensions need to know it.
 *
 * The core answers the kind of a conversation through the subagent hub
 * (`kindOf`), and the roles of a subagent through its agent record. The root and
 * a scheduled run are two of the three kinds. The third, `subagent`, splits in
 * three here, because a planner receives neither the personality nor the Korean
 * writing rules, and a subagent that writes reports for a person needs both:
 *
 *   root          the conversation a person reads and writes.
 *   focused       a chat the user opened from the web page: read and written by
 *                 the person, like the root, so it receives the personality and
 *                 the writing rules that go with it.
 *   orchestrator  a subagent whose roles share a name with `personality.roles`.
 *   planner       a subagent whose roles hold `planner`. It writes the working
 *                 document of a plan in English, and it writes no text the user
 *                 reads, so it receives neither the personality nor the Korean
 *                 writing rules, and it receives the rule for the language of
 *                 messages between agents.
 *   other         every other subagent, and every scheduled run.
 *
 * The planner role is read by its name and not from a config list, the same way
 * the reports gates read it: a role named `planner` is the role file
 * `prompts/role/planner.md`, and an installation that renames it writes a role
 * of its own. The planner test comes before the orchestrator test, so an install
 * whose `personality.roles` still names `planner` keeps the planner scope for it.
 *
 * A subagent with no agent record, or with roles that match nothing, reads as
 * `other`. That is the safe side: a worker that receives the personality's voice
 * would write instructions in it, and no person would ever see those.
 */

export type AgentScope = "root" | "focused" | "orchestrator" | "planner" | "other";

/** The role name that makes a subagent a planner. */
export const PLANNER_ROLE = "planner";

/**
 * The scope of `conversationId`.
 *
 * `context.subagents` is absent when the `subagents` extension is not installed.
 * A conversation other than the root then cannot be identified, so it reads as
 * `other`, and only the root keeps its guidance.
 */
export async function agentScopeOf(
  context: ExtensionContext,
  conversationId: ConversationId,
  ctx: Context,
): Promise<AgentScope> {
  const hub = context.subagents;
  if (hub === undefined) {
    return conversationId === ROOT_CONVERSATION_ID ? "root" : "other";
  }
  const kind = await hub.kindOf(conversationId, ctx);
  if (kind === "root") return "root";
  if (kind === "focused") return "focused";
  if (kind !== "subagent") return "other";
  const record = await hub.recordOf(conversationId, ctx);
  if (record === undefined) return "other";
  if (record.roles.includes(PLANNER_ROLE)) return "planner";
  const wanted = context.getConfig().personality.roles;
  return record.roles.some((role) => wanted.includes(role)) ? "orchestrator" : "other";
}
