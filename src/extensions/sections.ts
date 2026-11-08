import { createHash } from "node:crypto";
import {
  GenerationTask,
  defineEntry,
  defineExtension,
  defineTool,
  hook,
  type ConversationId,
  type Extension,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { ExtensionContext } from "./context.ts";

/**
 * `sections` — session-sealed system-prompt sections.
 *
 * A provider caches on the exact token prefix of a request, so the head of every
 * request must stay byte-identical for as long as a session lasts. A section that
 * renders a different value than it did on the previous request breaks that, and
 * the break costs the whole prompt and the whole transcript: on the DeepSeek Flash
 * model a cache miss is 50x a hit, and that model accepts no system messages mid
 * conversation, so every section it is sent leads the request.
 *
 * One rule, enforced for every section:
 *
 *   The value a session committed is the value that session keeps. If a section's
 *   source moves, the movement never reaches the head, and it is not written into
 *   the history either: the seal records it. The root reads that record with
 *   `session_stale` at its own milestone, and opens the restart round on its own
 *   judgment.
 *
 * A session starts at a fresh conversation, at a reset, and at a compaction. The
 * harness writes one baseline of every section at that point, which is why the
 * first render of a session sees nothing shown yet.
 *
 * Which values count as sources is not this module's business: the wrapper is
 * applied to every section, whatever it reads. See `wrapSections()` for the two
 * places that apply it.
 */

/** One section whose source moved after this session sealed its value. */
interface PendingUpdate {
  readonly key: string;
  /** The value the source holds now, or `undefined` when the section stopped producing one. */
  readonly text: string | undefined;
  /** Identity of the change, so the same change is recorded once. */
  readonly hash: string;
}

/**
 * An older revision wrote this note; nothing writes it now, and the definition
 * stays so a stored entry of this kind still reads as itself.
 */
export const SectionUpdateEntry = defineEntry("sec.section-update");

/** Digits of a change hash kept in a recorded change's identity. Long enough, and short enough to read. */
const HASH_CHARS = 16;

function changeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_CHARS);
}

/** A section's text as it is committed: the wrapper must return this shape, never re-wrap it. */
function tagged(key: string, text: string): string {
  return `<${key}>\n${text}\n</${key}>`;
}

/**
 * The seal: what each session committed, what has moved since, and what it has
 * already recorded. One instance per daemon, shared by every wrapping point.
 */
export class SectionSeal {
  /** Changes detected but not yet taken by the hook, per conversation by section. */
  readonly #pending = new Map<ConversationId, Map<string, PendingUpdate>>();
  /** Changes recorded for a conversation, per section. */
  readonly #noted = new Map<ConversationId, Map<string, Set<string>>>();

  /**
   * Wrap one section so that its rendered value can only ever enter a request at
   * the start of a session.
   *
   * The returned section is untagged: `input.shown` holds the committed text with
   * its `<key>` tags already around it, so returning it through a tagged section
   * would wrap it a second time. That mistake is silent and corrupts the prompt.
   */
  seal<T extends ToolRegistration>(key: string, render: PromptSection<T>["render"]): PromptSection<T> {
    return {
      key,
      tag: false,
      render: async (input, context) => {
        const fresh = await render(input, context);
        const shown = input.shown[key];

        // A session with nothing shown yet is starting. This render is the value it
        // will keep, so take the source as it stands and drop the last session's
        // bookkeeping, banner included.
        if (Object.keys(input.shown).length === 0) {
          this.#noted.delete(input.conversationId);
          this.#pending.delete(input.conversationId);
          return fresh === undefined ? undefined : tagged(key, fresh);
        }

        if (shown === undefined) {
          // The session is under way and this section had no value at its start.
          // Whatever the source says now is a mid-session change, not a seal.
          if (fresh !== undefined) this.#record(input.conversationId, key, fresh);
          return undefined;
        }

        if (fresh === undefined) this.#record(input.conversationId, key, undefined);
        else if (tagged(key, fresh) !== shown) this.#record(input.conversationId, key, fresh);
        return shown;
      },
    };
  }

  /**
   * Sections whose source moved while this session keeps the value it started
   * with. A change counts from the moment it is detected, whether or not the hook
   * has taken it yet.
   */
  stale(conversationId: ConversationId): readonly string[] {
    const keys = new Set(this.#noted.get(conversationId)?.keys() ?? []);
    for (const key of this.#pending.get(conversationId)?.keys() ?? []) keys.add(key);
    return [...keys].sort();
  }

  /**
   * Every conversation with at least one section to report. A change the hook has
   * not taken yet counts, so this reads the same value as the tool.
   */
  staleConversations(): readonly { readonly conversationId: number; readonly keys: readonly string[] }[] {
    const out: { conversationId: number; keys: readonly string[] }[] = [];
    const ids = new Set([...this.#noted.keys(), ...this.#pending.keys()]);
    for (const conversationId of ids) {
      const keys = this.stale(conversationId);
      if (keys.length > 0) out.push({ conversationId, keys });
    }
    return out;
  }

  /**
   * Take the changes the hook has not seen yet. A change is taken once per
   * conversation and value; a restart of the daemon loses this memory, and the
   * next render records the change again.
   */
  drain(conversationId: ConversationId): readonly PendingUpdate[] {
    const byKey = this.#pending.get(conversationId);
    if (byKey === undefined || byKey.size === 0) return [];
    const taken = [...byKey.values()];
    byKey.clear();
    return taken;
  }

  /** Record a change in this conversation, so `session_stale` keeps reporting it. */
  noteWritten(conversationId: ConversationId, update: PendingUpdate): void {
    const byKey = this.#noted.get(conversationId) ?? new Map<string, Set<string>>();
    this.#noted.set(conversationId, byKey);
    const hashes = byKey.get(update.key) ?? new Set<string>();
    hashes.add(update.hash);
    byKey.set(update.key, hashes);
  }

  #record(conversationId: ConversationId, key: string, text: string | undefined): void {
    const byKey = this.#pending.get(conversationId) ?? new Map<string, PendingUpdate>();
    this.#pending.set(conversationId, byKey);
    const hash = changeHash(`${key}\u0000${text ?? ""}`);
    if (byKey.get(key)?.hash === hash) return;
    byKey.set(key, { key, text, hash });
  }
}

/** Apply the seal to every section of an extension. */
export function wrapSections<T extends ToolRegistration>(
  extension: Extension<T>,
  seal: SectionSeal,
): Extension<T> {
  if (extension.sections === undefined || extension.sections.length === 0) return extension;
  return { ...extension, sections: extension.sections.map((section) => seal.seal(section.key, section.render)) };
}

/**
 * The bundled `sections` extension. It carries no section of its own: it records
 * the changes the seal detects, and it offers `session_stale`, the read-only way
 * for a session to learn that a source moved under it.
 */
export function createSectionsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const seal = context.sections;

  const stale = defineTool({
    name: "session_stale",
    description: "Report whether the source of any system-prompt section has moved since this session started.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const keys = seal.stale(api.conversationId);
      const lines =
        keys.length === 0
          ? ["session_stale: no. Every prompt section matches the value this session started with."]
          : [
              `session_stale: yes. Changed since this session started: ${keys.join(", ")}. This session keeps the values it started with.`,
            ];
      return { output: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  const deliver = hook(GenerationTask, {
    beforeRequest: async (_request, api) => {
      const updates = seal.drain(api.conversationId);
      if (updates.length === 0) return undefined;

      // A change is recorded, not written: the session's history stays as it was,
      // and the agent reads the record with `session_stale` at its next milestone.
      const keys = updates.map((update) => update.key);
      for (const update of updates) seal.noteWritten(api.conversationId, update);
      context.events.emit("sections_stale", { conversationId: api.conversationId, keys });
      context.audit.append({ type: "sections_stale", conversationId: api.conversationId, keys });
      return undefined;
    },
  });

  return defineExtension({ name: "sections", tools: [stale], hooks: [deliver] });
}
