import { obj, opt, str } from "@earendil-works/pi-schema";
import { type Message, type SystemMessage } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  defineExtension,
  defineTool,
  hook,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { readMessage } from "../message-envelope.ts";
import { agentScopeOf } from "./agent-scope.ts";
import type { ExtensionContext } from "./context.ts";
import {
  MAX_PERSONALITY_CHARS,
  MAX_PERSONALITY_NAME_CHARS,
  personalityBodyOf,
  personalityPath,
  readPersonalityFile,
  writePersonalityFile,
} from "./personality-file.ts";
import {
  INTERVIEW,
  PERSONALITY_GET_DESCRIPTION,
  PERSONALITY_GET_NONE,
  PERSONALITY_INTRO_FOCUSED,
  PERSONALITY_INTRO_ORCHESTRATOR,
  PERSONALITY_INTRO_ROOT,
  PERSONALITY_SET_DESCRIPTION,
  PERSONALITY_SET_FIRST,
  PERSONALITY_SET_LANGUAGE_DESCRIPTION,
  PERSONALITY_SET_NAME_DESCRIPTION,
  PERSONALITY_SET_REPLACED,
  type PersonalityLanguage,
} from "./personality-texts.ts";

/**
 * `personality` — a registered personality: a language, a name, a character, a
 * voice, and the words the agent uses for the user and for itself.
 *
 * Four parts:
 *
 *   section "personality"   The registered document, in the system prompt of the
 *                           root and of the orchestrators. The introduction is
 *                           the root's or the orchestrator's, and both come in
 *                           the document's own language. A planner, a worker and
 *                           a scheduled run get nothing: they write no text the
 *                           user reads, and a personality in their prompt would
 *                           put a voice into instructions nobody reads as
 *                           conversation.
 *
 *   hook  GenerationTask    The design interview, on the root's first request
 *                           while no personality is registered. It is
 *                           request-scoped: the transcript is not touched, so
 *                           the prompt of the next session is not two
 *                           directives deep. The note's language follows the
 *                           user's first message, so the interview opens in the
 *                           language the user wrote in.
 *
 *   tools                   `personality_get`, which any agent may call, and
 *                           `personality_set`, which only the root may call.
 *
 *   config                  `personality.file`, `personality.interview`, and
 *                           `personality.roles` (which roles make a subagent an
 *                           orchestrator for this extension).
 *
 * The document is an ordinary markdown file under the pi-sec home
 * (`memory/personality.md` by default): readable, hand-editable, and fixable
 * without touching this extension.
 *
 * A section's value is fixed when a session starts, so a new or changed
 * personality reaches the prompt in a new session and not in the running one.
 * `personality_set` says so in its result; the restart itself is the caller's
 * step.
 */

/** An error result, so the caller sees a failure and not a sentence it may act on. */
function refusal(message: string) {
  return { isError: true, output: [{ type: "text" as const, text: message }] };
}

/** The languages `personality_set` accepts, as the argument's own values. */
function languageArgument(value: unknown): PersonalityLanguage | undefined {
  return value === "en" || value === "ko" ? value : undefined;
}

/**
 * The name the file is left with, and the sentence that refuses a bad value.
 *
 * Three values mean three things, and the page depends on the difference: an
 * absent argument keeps the name already registered, an empty string clears it,
 * and anything else becomes the new name. The value is trimmed, because a name
 * is a label and a stray space would show in the page title. One line and 40
 * code points, because the page draws it in a top bar: counted as code points so
 * that a Korean name is measured in letters and not in bytes.
 */
function nameArgument(
  value: unknown,
  current: string | undefined,
): { readonly name?: string; readonly refusal?: string } {
  if (value === undefined) return { name: current };
  if (typeof value !== "string") {
    return { refusal: `Refused: \`name\` must be a string, and it was ${JSON.stringify(value)}.` };
  }
  if (/[\n\r]/.test(value)) {
    return { refusal: "Refused: `name` must be on one line, and the value contains a line break." };
  }
  const trimmed = value.trim();
  if (trimmed === "") return {};
  const length = [...trimmed].length;
  if (length > MAX_PERSONALITY_NAME_CHARS) {
    return {
      refusal: `Refused: \`name\` is ${length} characters, over the ${MAX_PERSONALITY_NAME_CHARS} limit. The page draws it as the title of the root chat, so keep it short.`,
    };
  }
  return { name: trimmed };
}

/**
 * The text of one message, with any source envelope removed.
 *
 * `message-tags` labels every user message with `<pi-message ...>`, and an older
 * transcript may hold `<agent-message ...>` or `<tool-call-output ...>`. Those
 * tags are written in Latin letters, so counting them would push every short
 * Korean message to English. The core reader undoes the envelope; a stray tag in
 * a text that is not one is dropped by the pattern.
 */
function messageText(message: Message): string {
  const content: unknown = (message as { content?: unknown }).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
                ? String((part as { text?: unknown }).text ?? "")
                : "",
            )
            .join("\n")
        : "";
  const parsed = readMessage(text);
  if (parsed !== undefined) return parsed.body;
  return text.replace(/<\/?(?:pi-message|agent-message|tool-call-output)\b[^>]*>/g, "");
}

const HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g;
const LATIN = /[A-Za-z]/g;

/** How many characters of the text are in each script. */
export function scriptCounts(text: string): { readonly hangul: number; readonly latin: number } {
  return { hangul: text.match(HANGUL)?.length ?? 0, latin: text.match(LATIN)?.length ?? 0 };
}

/**
 * The language the interview opens in.
 *
 * The user's own text decides, not a setting: a person who writes in Korean gets
 * a Korean question, and one who writes in English gets an English one. The
 * interview asks which language the user wants for the text they read, so a
 * guess here costs one question, not a wrong choice.
 *
 * Korean needs a majority, not a presence: a Korean sentence that quotes an
 * English error message is still Korean, but an English sentence with one Korean
 * word is not.
 */
export function interviewLanguage(messages: readonly Message[]): PersonalityLanguage {
  const first = messages.find((message) => message.role === "user");
  if (first === undefined) return "en";
  const counts = scriptCounts(messageText(first));
  return counts.hangul > counts.latin ? "ko" : "en";
}

/** The bundled `personality` extension. */
export function createPersonalityExtension(context: ExtensionContext): Extension<ToolRegistration> {
  /** The file the config names, resolved once: the value is fixed at boot. */
  const file = (): string => personalityPath(context.paths, context.getConfig().personality.file);

  const personality = section("personality", async (input, ctx) => {
    const scope = await agentScopeOf(context, input.conversationId, ctx);
    if (scope === "other" || scope === "planner") return undefined;
    const document = await readPersonalityFile(file());
    if (document === undefined) return undefined;
    // A focused chat talks with the user too, so it receives the same document
    // with an introduction of its own: the root's introduction would tell it to
    // run the interview and to restart, and neither is a focused chat's.
    const intro =
      scope === "root"
        ? PERSONALITY_INTRO_ROOT
        : scope === "focused"
          ? PERSONALITY_INTRO_FOCUSED
          : PERSONALITY_INTRO_ORCHESTRATOR;
    return `${intro[document.language]}\n\n${document.body}`;
  });

  const firstContact = hook(GenerationTask, {
    beforeRequest: async (request, api, ctx) => {
      if (!context.getConfig().personality.interview) return undefined;
      const messages = request.messages ?? [];

      // The interview opens a conversation, so it never interrupts one that is
      // already under way, and it never runs where nobody can answer.
      if (messages.some((message) => message.role === "assistant")) return undefined;
      if (!messages.some((message) => message.role === "user")) return undefined;
      if ((await agentScopeOf(context, api.conversationId, ctx)) !== "root") return undefined;
      if ((await readPersonalityFile(file())) !== undefined) return undefined;

      // The timestamp is the message's own; a request is cached on its text, not
      // on this field, and the harness reads it only as the instant of the part.
      const directive: SystemMessage = {
        role: "system",
        content: INTERVIEW[interviewLanguage(messages)],
        timestamp: Date.now(),
      };
      return { messages: [...messages, directive] };
    },
  });

  const get = defineTool({
    name: "personality_get",
    description: PERSONALITY_GET_DESCRIPTION,
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const path = file();
      const document = await readPersonalityFile(path);
      if (document === undefined) {
        return { output: [{ type: "text" as const, text: PERSONALITY_GET_NONE.replace("<path>", path) }] };
      }
      const head = document.languageNamed
        ? `Language: ${document.language}`
        : "Language: en (the document names no language, so English applies)";
      // The name line sits right after the language line, and it is absent when
      // the file names no name: an empty `Name:` line would read as a name that
      // is there and empty.
      const named = document.name === undefined ? head : `${head}\nName: ${document.name}`;
      return { output: [{ type: "text" as const, text: `${named}\n\n${document.body}` }] };
    },
  });

  const set = defineTool({
    name: "personality_set",
    description: PERSONALITY_SET_DESCRIPTION,
    parameters: obj(
      {
        content: str({ description: "The complete personality document, as markdown prose." }),
        // Optional to the schema on purpose: a required argument is refused by the
        // harness with a validation error that names no way forward. The refusal in
        // `execute` says which values are accepted and what the value decides.
        language: opt(str({ description: PERSONALITY_SET_LANGUAGE_DESCRIPTION })),
        name: opt(str({ description: PERSONALITY_SET_NAME_DESCRIPTION })),
      },
    ),
    replay: "unsafe",
    execute: async (args) => {
      const language = languageArgument(args.language);
      if (language === undefined) {
        return refusal(
          `Refused: \`language\` must be "en" or "ko", and it was ${JSON.stringify(args.language ?? null)}. ` +
            "The language decides which introduction and which Korean writing rules the prompt carries.",
        );
      }

      const body = personalityBodyOf(String(args.content ?? ""));
      if (body.length === 0) {
        return refusal("Refused: the personality document is empty.");
      }
      if (body.length > MAX_PERSONALITY_CHARS) {
        return refusal(
          `Refused: ${body.length} characters is over the ${MAX_PERSONALITY_CHARS} limit. A personality is a shape, not a manual, so cut it back.`,
        );
      }
      // The heading check is the old extension's rule and it still holds: the
      // document is read by a person as well as by a model, so it is a document.
      if (!/^#{1,6}\s|\n#{1,6}\s/.test(body)) {
        return refusal("Refused: no markdown heading found. Give it at least a title heading so it reads as a document.");
      }

      const path = file();
      const existing = await readPersonalityFile(path);
      const chosen = nameArgument(args.name, existing?.name);
      if (chosen.refusal !== undefined) return refusal(chosen.refusal);

      try {
        await writePersonalityFile(path, language, body, chosen.name);
      } catch (error) {
        return refusal(`Failed to write ${path}: ${String(error)}`);
      }

      const template = existing === undefined ? PERSONALITY_SET_FIRST : PERSONALITY_SET_REPLACED;
      // `<name>` is filled last, so a name that happens to spell another
      // placeholder is written as the name and not read as one.
      const text = template
        .replace("<n>", String(body.length))
        .replace("<en|ko>", language)
        .replace("<path>", path)
        .replace("<name>", chosen.name ?? "no name");
      return { output: [{ type: "text" as const, text }] };
    },
  });

  return defineExtension({
    name: "personality",
    sections: [personality],
    hooks: [firstContact],
    tools: [get, set],
  });
}
