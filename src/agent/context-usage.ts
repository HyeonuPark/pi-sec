import type { Models } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";

/**
 * How full one conversation's context is, and what it is full against.
 *
 * `used` is the size of the request the provider last answered in this context:
 * `input + cacheRead + cacheWrite` on the newest assistant entry. It is read from
 * the committed context, not from the transcript, so a reset or a compaction
 * that dropped entries is already reflected. Counting the transcript instead
 * would report a context that no longer exists.
 *
 * `max` is the usable maximum: the model's window less the tokens the harness
 * holds back for the answer, which is where compaction fires. A ratio taken
 * against `max` reaches 100% exactly when the context is about to be compacted,
 * which is what the operator's bar means. `window` is reported beside it so the
 * difference is never a surprise.
 *
 * One reader for both the `usage` tool and the chat page: two counters that
 * measure the same context for themselves would eventually disagree, and the
 * disagreement would be invisible to whoever compared them.
 */
export interface ContextUsage {
  /** Request size in tokens; `undefined` when this context holds no answer yet. */
  readonly used: number | undefined;
  /** `window - reserveTokens`; `undefined` when the model is not in the catalog. */
  readonly max: number | undefined;
  readonly window: number | undefined;
  /** The room kept free for the answer, as the harness was configured. */
  readonly reserveTokens: number;
  /** Entries in the committed context, for the tool's own reporting. */
  readonly entries: number;
}

/**
 * Read one conversation's context usage. Read-only: it commits nothing and needs
 * no task scheduling, so a viewer can call it as often as it likes.
 */
export async function contextUsage(
  conversation: Conversation,
  models: Models,
  reserveTokens: number,
  context: Context,
): Promise<ContextUsage> {
  const view = await conversation.context(context);

  // Newest first: the last answer is the request that produced the context as it
  // stands now, so the first one found is the whole answer.
  let used: number | undefined;
  for (let index = view.entries.length - 1; index >= 0 && used === undefined; index -= 1) {
    for (const message of view.entries[index]?.model ?? []) {
      if (message.role !== "assistant") continue;
      used = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      break;
    }
  }

  const agent = await conversation.agent(context);
  const model = agent.model === undefined ? undefined : models.getModel(agent.model.provider, agent.model.modelId);
  const window = model?.contextWindow;

  return {
    used,
    window,
    reserveTokens,
    max: window === undefined ? undefined : window - reserveTokens,
    entries: view.entries.length,
  };
}
