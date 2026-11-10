import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { Config } from "../config/schema.ts";
import type { Paths } from "../runtime/paths.ts";
import { rootContextBriefing } from "./context-file.ts";
import { toolFilterFor } from "./tool-profile.ts";
import { isModelSetupMode, ModelNotConfiguredError } from "./model-setup.ts";
import { vmodelEntry } from "./vmodel.ts";

/**
 * Look up the operator's conversation without touching it: `undefined` when the
 * root does not exist.
 *
 * This is the read-only half of `resolveDefaultConversation`, for callers that
 * must not write: the two `GET` routes of the chat page, and the restart notice.
 * `Harness.conversation` reads the conversation record and returns a handle; it
 * creates nothing and commits nothing, so a page load stays a read even on a
 * store where the root is missing. Preparing the root is the daemon's job at
 * boot, and the write routes call `resolveDefaultConversation` before they act.
 */
export function findDefaultConversation(
  harness: Pick<Harness, "conversation">,
  context: Context,
): Promise<Conversation | undefined> {
  return harness.conversation(ROOT_CONVERSATION_ID, context);
}

/**
 * Resolve the operator's conversation: always the harness root.
 *
 * Every write route calls this, and so does the boot preparation: it creates the
 * root when it is absent and then makes its model, thinking level, instructions
 * and tool filter match the configuration. A read route calls
 * `findDefaultConversation` instead.
 *
 * `/basic-chat` shows one conversation, so a configurable id bought nothing and
 * cost something real. With a non-root conversation configured, every
 * "root agent only" gate keyed on `ROOT_CONVERSATION_ID` would silently stop
 * matching, and `ask_user` — the one tool that reaches the operator — would be
 * withheld from the only agent that should have it. A scheduled run gets its own
 * conversation instead, and that is a different thing from the operator's.
 *
 * The root's model and thinking level are enforced on every call, and its roles
 * and vmodel prompt text reach the request through the sealed `agent-profile`
 * sections. Its `instructions` are written here once and then left alone, and
 * they carry the one fact that differs per agent: where this agent's context file
 * is. `instructions` is the only place in the system prompt that renders after
 * every extension section, which is why a per-agent fact belongs there and not in
 * a section.
 *
 * The original reason this file wrote no `instructions` at all still holds and is
 * worth keeping in view: `instructions` are not sealed, so a change mid-session
 * rewrites the head of the next request and costs the provider's whole prefix
 * cache. A value fixed for the life of the conversation carries none of that
 * risk, and the comparison below is what keeps it fixed.
 */
export async function resolveDefaultConversation(
  harness: Harness,
  config: Config,
  paths: Paths,
  context: Context,
): Promise<Conversation> {
  // No root model yet: a named error, which the server answers with 409
  // `model_not_configured` instead of the 500 an unnamed vmodel error would be.
  if (isModelSetupMode(config)) throw new ModelNotConfiguredError();
  const vmodel = vmodelEntry(config, config.agent.vmodel);
  const model = { provider: vmodel.provider, modelId: vmodel.modelId };
  const instructions = rootContextBriefing(paths);

  const conversation = await harness.root(context, {
    agent: { model, thinkingLevel: vmodel.thinkingLevel, instructions },
  });

  const agent = await conversation.agent(context);
  const modelDiffers =
    agent.model === undefined ||
    agent.model.provider !== model.provider ||
    agent.model.modelId !== model.modelId;
  const thinkingDiffers = agent.thinkingLevel !== vmodel.thinkingLevel;
  const instructionsDiffer = agent.instructions !== instructions;
  if (modelDiffers || thinkingDiffers || instructionsDiffer) {
    await conversation.configure(
      {
        ...(modelDiffers ? { model } : {}),
        ...(thinkingDiffers ? { thinkingLevel: vmodel.thinkingLevel } : {}),
        ...(instructionsDiffer ? { instructions } : {}),
      },
      context,
    );
  }

  // The root's tool list is narrowed here rather than at conversation creation,
  // because the root conversation is usually already there by the time this runs.
  // Reading first keeps it to one commit per change instead of one per chat load.
  const filter = toolFilterFor("root");
  const profile = await harness.snapshot(AgentDoc, conversation.id, context);
  if (filter !== undefined && JSON.stringify(profile?.tools) !== JSON.stringify(filter)) {
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(AgentDoc, conversation.id);
      doc.tools = { remove: [...filter.remove] };
    }, context);
  }
  return conversation;
}
