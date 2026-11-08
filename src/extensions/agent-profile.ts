import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineExtension,
  section,
  type Extension,
  type PromptInput,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { VmodelResolver } from "../agent/vmodel.ts";
import { SecAgent } from "../documents.ts";
import { agentScopeOf } from "./agent-scope.ts";
import type { ExtensionContext } from "./context.ts";
import { personalityPath, readPersonalityFile } from "./personality-file.ts";
import { REPLY_LANGUAGE_EN, REPLY_LANGUAGE_KO } from "./reply-language-text.ts";

/**
 * The bundled `agent-profile` extension: the system-prompt text that belongs to
 * the agent itself, rather than to a tool.
 *
 * Three sealed sections. `reply-language` renders the language of every text the
 * user reads, in that language, and only for the root and a focused chat while a
 * personality is registered: those are the two conversations that talk with the
 * user, and the personality names the language. `vmodel` and `roles` render the
 * model's extra prompt and the role texts of whichever conversation is asking.
 * The last two read the conversation's `sec.agent` record, and fall back to
 * config when there is none, which is the root's situation: the browser chat is
 * the root, so the operator's own model and roles are the config's.
 *
 * `reply-language` comes first, and that is the point of it: a rule that only the
 * last sections state was not enough, because a reply written in the wrong
 * language over a thought in the right one still happened. It sits second in the
 * prompt, right after `preamble`. It adds no new break to the shared prefix,
 * since `vmodel` and `roles` already differ per conversation at the same place.
 *
 * Why a section and not `agent.instructions`: `instructions` is not wrapped by
 * the section seal, so a mid-session change to it rewrites the head of the next
 * request and costs the provider's whole prefix cache. A section is sealed, so a
 * role file edited mid-session is reported as a change and applies from the next
 * session instead. On the DeepSeek Flash model that difference is a factor of
 * fifty on every input token.
 *
 * One `VmodelResolver` is built here and reused, because the resolver owns the
 * mtime-keyed file cache; a fresh instance per render would re-read every file on
 * every request.
 */
export function createAgentProfileExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const resolver = new VmodelResolver({ getConfig: () => context.getConfig(), paths: context.paths });

  /** The vmodel and roles that apply to the asking conversation. */
  const profileOf = async (
    input: PromptInput<ToolRegistration>,
    ctx: Parameters<PromptSection["render"]>[1],
  ): Promise<{ readonly vmodel: string; readonly roles: readonly string[] }> => {
    const record = await input.read.snapshot(SecAgent, String(input.conversationId), ctx);
    if (record !== undefined && record.vmodel !== "") return { vmodel: record.vmodel, roles: record.roles };
    const config = context.getConfig();
    return { vmodel: config.agent.vmodel, roles: config.agent.roles };
  };

  /**
   * The language of every text the user reads: the root and a focused chat, and
   * only while a personality is registered. A personality names the language, so
   * without one the interview decides the language first and this section has
   * nothing to say. An orchestrator, a worker and a scheduled run never talk to
   * the user, so they get no instruction about how to.
   */
  const replyLanguageSection = section("reply-language", async (input, ctx) => {
    const scope = await agentScopeOf(context, input.conversationId, ctx);
    if (scope !== "root" && scope !== "focused") return undefined;
    const document = await readPersonalityFile(
      personalityPath(context.paths, context.getConfig().personality.file),
    );
    if (document === undefined) return undefined;
    return document.language === "ko" ? REPLY_LANGUAGE_KO : REPLY_LANGUAGE_EN;
  });

  const vmodelSection = section("vmodel", async (input, ctx) => {
    const profile = await profileOf(input, ctx);
    const text = (await resolver.resolve(profile.vmodel)).prompt.trim();
    return text === "" ? undefined : text;
  });

  const rolesSection = section("roles", async (input, ctx) => {
    const profile = await profileOf(input, ctx);
    if (profile.roles.length === 0) return undefined;
    const text = (await resolver.rolesText(profile.roles)).trim();
    return text === "" ? undefined : text;
  });

  return defineExtension({
    name: "agent-profile",
    sections: [replyLanguageSection, vmodelSection, rolesSection],
  });
}
