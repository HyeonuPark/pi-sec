import { defineExtension, section, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { agentScopeOf } from "./agent-scope.ts";
import type { ExtensionContext } from "./context.ts";
import { AGENT_LANGUAGE_KO, FLUENT_KOREAN, SIMPLE_ENGLISH } from "./language-rules-text.ts";
import { personalityPath, readPersonalityFile } from "./personality-file.ts";

/**
 * `language-rules` — how to write, in the system prompt.
 *
 * Three sections, all constant strings (`language-rules-text.ts`):
 *
 *   simple-english  Every agent, always. The rules hold whatever language the
 *                   agent writes in: the section itself says how they apply to
 *                   a Korean document.
 *   fluent-korean   Every agent but a planner, whatever its scope, and only while
 *                   the personality names Korean. Its rules are about Korean
 *                   words, and a planner writes its working document in English:
 *                   an agent writing English has nothing to do with them, and a
 *                   worker that writes Korean briefs and reports obeys them like
 *                   everyone else.
 *   agent-language  A worker, a scheduled run and a planner, and only while the
 *                   personality names Korean. It names the language they write
 *                   to other agents in, and it says that state files, companion
 *                   files, code, identifiers, and quoted error text keep the
 *                   project's conventions. The root, a focused chat and an
 *                   orchestrator read that rule in their personality
 *                   introduction instead, and they do not get this section.
 *
 * The scope is decided the same way the `personality` section decides it
 * (`agent-scope.ts`). The personality section itself stays gated to the root, the
 * focused chats and the orchestrators: a worker that receives the personality's
 * voice would write instructions in it. The language rules are not the voice, so
 * a Korean installation gives its workers the two that apply to them, and a
 * planner the one that applies to it: it writes English documents and Korean
 * notes.
 */

/** The language the personality file names, or `undefined` when it names none. */
async function personalityLanguage(context: ExtensionContext): Promise<"en" | "ko" | undefined> {
  const document = await readPersonalityFile(personalityPath(context.paths, context.getConfig().personality.file));
  return document?.language;
}

/** The bundled `language-rules` extension: three sections, no tool and no hook. */
export function createLanguageRulesExtension(context: ExtensionContext): Extension<ToolRegistration> {
  return defineExtension({
    name: "language-rules",
    sections: [
      section("simple-english", () => SIMPLE_ENGLISH),
      section("fluent-korean", async (input, ctx) => {
        if ((await agentScopeOf(context, input.conversationId, ctx)) === "planner") return undefined;
        return (await personalityLanguage(context)) === "ko" ? FLUENT_KOREAN : undefined;
      }),
      section("agent-language", async (input, ctx) => {
        const scope = await agentScopeOf(context, input.conversationId, ctx);
        if (scope !== "other" && scope !== "planner") return undefined;
        return (await personalityLanguage(context)) === "ko" ? AGENT_LANGUAGE_KO : undefined;
      }),
    ],
  });
}
