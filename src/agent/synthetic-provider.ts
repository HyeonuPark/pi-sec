/**
 * synthetic.new as a model provider.
 *
 * The provider is registered by `createModels` (and by `openCatalog`, for the
 * one-shot commands), so every model runtime pi-sec builds knows it: the daemon
 * that serves the web UI, the model login panel and `pi-sec models`. Its models
 * are the ones synthetic.new lists at `GET /openai/v1/models`, reached through
 * the OpenAI-compatible endpoint at `https://api.synthetic.new/openai/v1`.
 * `synthetic-catalog.ts` reads that list, keeps the last good answer and turns
 * it into these model entries.
 *
 * Authentication is an API key. The configuration names no key: with none set
 * and no OAuth flow, the composer gives the provider the API-key login that asks
 * for one, and the panel stores what the user pastes in the secret store as
 * `model-auth.synthetic.key`. The key is never read or written here.
 *
 * Two groups of values are copied on purpose.
 *
 * - The compat and thinking values are the ones the built-in `deepseek`
 *   provider sets on `deepseek-flash` (`providers/data/deepseek.json` in
 *   `@earendil-works/pi-ai`). It is the same model, and synthetic.new documents
 *   the same `reasoning_content` field, so the request shape is the same.
 * - The costs are synthetic.new's subscription rates per million tokens, not the
 *   pay-as-you-go rates the same model carries elsewhere. They are what a token
 *   subtracts from the weekly credit, so the ledger's cost column matches the
 *   credit the request used.
 *
 * No vmodel points here by default: a home that never picks this provider sends
 * nothing to it, and the key alone costs nothing.
 */
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** The provider id the panel, `pi-sec models` and `models.json` use. */
export const SYNTHETIC_PROVIDER_ID = "synthetic";

/** The endpoint every model of this provider is reached through. */
export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";

/**
 * The one model this provider serves until the service's list has been read.
 *
 * A home that has never stored a list and cannot reach the service still boots
 * and still offers a model, and that model is the one this code shipped before
 * the list was read: DeepSeek V4.1 Flash, through the endpoint above.
 */
export const SYNTHETIC_MODEL_ID = "hf:deepseek-ai/DeepSeek-V4.1-Flash";

/**
 * The request shape the built-in DeepSeek provider uses for `deepseek-flash`.
 *
 * A fresh object per call: the runtime merges a re-registration over the
 * previous one, and a shared object would let one runtime's edit reach another.
 */
export function syntheticDeepseekCompat(): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
    supportsStrictMode: true,
  };
}

/**
 * The thinking levels the built-in DeepSeek provider maps for that model.
 *
 * `xhigh` is absent on purpose: the built-in entry has no mapping for it, and
 * pi asks for a level it maps to nothing by leaving it out.
 */
export function syntheticDeepseekThinkingLevelMap(): ThinkingLevelMap {
  return { minimal: null, low: "low", medium: null, high: "high", max: "max" };
}

/** The model registered when no list has been read and stored yet. */
export function syntheticFallbackModel(): ProviderModelConfig {
  return {
    id: SYNTHETIC_MODEL_ID,
    name: "DeepSeek V4.1 Flash (synthetic.new)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    // Per million tokens, in dollars: synthetic.new's subscription rates.
    cost: { input: 0.06, cacheRead: 0.003, output: 0.3, cacheWrite: 0 },
    contextWindow: 524_288,
    maxTokens: 65_536,
    thinkingLevelMap: syntheticDeepseekThinkingLevelMap(),
    compat: syntheticDeepseekCompat(),
  };
}

/**
 * The registration `createModels` hands to `ModelRuntime.registerProvider`.
 *
 * A fresh object per call: the runtime merges a re-registration over the
 * previous one, and a shared object would let one runtime's edit reach another.
 * The runtime replaces the model list of a re-registration as a whole, so a
 * model that the service dropped leaves the catalog here and nowhere else.
 */
export function syntheticProviderConfig(
  models: readonly ProviderModelConfig[] = [syntheticFallbackModel()],
): ProviderConfig {
  return {
    name: "synthetic.new",
    baseUrl: SYNTHETIC_BASE_URL,
    api: "openai-completions",
    models: [...models],
  };
}
