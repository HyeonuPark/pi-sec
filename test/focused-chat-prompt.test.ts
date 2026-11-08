import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { FOCUSED_CHAT_TOOLS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import { FOCUSED_CHAT_IDENTITY } from "../src/extensions/focused-chat-texts.ts";
import { FLUENT_KOREAN, SIMPLE_ENGLISH } from "../src/extensions/language-rules-text.ts";
import { PERSONALITY_INTRO_FOCUSED, PERSONALITY_INTRO_ROOT } from "../src/extensions/personality-texts.ts";
import { FOCUSED_CHAT_ROLES, openFocusedChat } from "../src/focused/service.ts";
import type { FocusedChatRow } from "../src/focused/store.ts";
import {
  conversationOf,
  depsOf,
  firstRequest,
  focusedHarness,
  openChat,
  runTool,
  sectionsOf,
  systemText,
} from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * What a focused chat is told, and what it may do.
 *
 * The kind is one value and everything else follows from it: the identity
 * sentence, the personality with an introduction of its own, the Korean writing
 * rules the root also receives, the roles behind the prompt, and the tool list the
 * creating commit stores. These tests read the sections of the request the model
 * is actually sent, because that is the only place those decisions meet.
 */

const CTX = BACKGROUND_CONTEXT;
const NO_INTERVIEW: Partial<Config> = {
  personality: { file: "memory/personality.md", interview: false, roles: ["orchestrator"] },
};

/**
 * Install the two role files and one personality into a test harness's home.
 *
 * The pieces are copied from this checkout's `prompts/` into the harness's control
 * structure, which is the first root every prompt read searches. A test that only
 * read the checkout would pass on a machine where the install's own copy happened
 * to exist, and the daemon reads the control structure's copy.
 */
async function stage(test: TestHarness, language: "en" | "ko" | "none"): Promise<readonly string[]> {
  const source = join(import.meta.dirname, "..", "prompts", "role");
  const texts: string[] = [];
  for (const role of FOCUSED_CHAT_ROLES) {
    const text = await readFile(join(source, `${role}.md`), "utf8");
    const target = join(test.paths.promptsDir, "role", `${role}.md`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    texts.push(text.trim());
  }
  if (language !== "none") {
    const path = join(test.paths.home, "memory", "personality.md");
    await mkdir(dirname(path), { recursive: true });
    const body = language === "ko" ? "# 인물\n\n따뜻하고 담백하게 말합니다." : "# Persona\n\nWarm, plain, and short.";
    await writeFile(path, `---\nlanguage: ${language}\n---\n${body}\n`, "utf8");
  }
  return texts;
}

describe("the focused kind and its prompt", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /**
   * Everything one chat is told, with its own name and its own paths taken out.
   *
   * Two chats cannot have the same name or the same conversation number, so a
   * comparison of two prompts has to set those aside first: the name is the one
   * `focused-<seq>`, and the number appears in the state file the briefing names.
   * What remains is what the kind and the settings decide: the sections, the order
   * they render in, and the briefing the tool allow list was stored with.
   */
  async function promptOf(test: TestHarness, row: FocusedChatRow): Promise<string> {
    const sections = sectionsOf(await firstRequest(test, await conversationOf(test, row.conversationId)));
    const profile = await test.runtime.harness.snapshot(AgentDoc, row.conversationId as never, CTX);
    return [JSON.stringify(sections), profile?.instructions ?? ""]
      .join("\n")
      .replaceAll(`${test.paths.home}/state/agents/${row.conversationId}.md`, "<state file>")
      .replaceAll(test.paths.home, "<home>")
      .replaceAll(row.name, "<name>");
  }

  it("tells a test chat exactly what it tells a normal chat", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    await stage(harness, "en");
    // Opened the same way, with the same title: the only difference is the flag.
    const normal = await openFocusedChat(depsOf(harness), { title: "the same topic" }, CTX);
    const test = await openFocusedChat(depsOf(harness), { title: "the same topic", test: true }, CTX);
    expect(test.test).toBe(true);
    expect(normal.test).toBe(false);

    expect(await promptOf(harness, test)).toBe(await promptOf(harness, normal));
  });

  it("answers focused while the record exists, and still after it is gone", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness);
    const hub = harness.runtime.subagents!;

    expect(await hub.kindOf(row.conversationId as never, CTX)).toBe("focused");
    expect(await hub.kindOf(ROOT_CONVERSATION_ID, CTX)).toBe("root");

    // The stored filter outlives the record, and it is the fallback: the allow list
    // it was created with is what still says which kind this conversation is.
    await harness.runtime.harness.commit(async (tx) => {
      await tx.retireDoc(SecAgent, String(row.conversationId));
    }, CTX);
    expect(await harness.runtime.harness.snapshot(SecAgent, String(row.conversationId), CTX)).toBeUndefined();
    expect(await hub.kindOf(row.conversationId as never, CTX)).toBe("focused");
    expect(await hub.createdAsSubagent(row.conversationId as never, CTX)).toBe(false);
  });

  it("gets the focused identity text with its own name, not the subagent's", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    const row = await openChat(harness);
    const messages = await firstRequest(harness, await conversationOf(harness, row.conversationId));
    const role = sectionsOf(messages)["agent-role"] ?? "";

    expect(role).toContain(FOCUSED_CHAT_IDENTITY.replaceAll("<name>", row.name));
    expect(role).toContain(`You are a focused chat named "${row.name}"`);
    // The subject line is what a subagent reads and a focused chat must not.
    expect(systemText(messages)).not.toContain("No person reads your answers");
  });

  it("gets both role files, in the order the code fixes", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    const [focusedRole, userFacing] = await stage(harness, "none");
    const row = await openChat(harness);
    const messages = await firstRequest(harness, await conversationOf(harness, row.conversationId));
    const sections = sectionsOf(messages);

    expect(sections["roles"]).toBeDefined();
    expect(sections["roles"]).toContain(focusedRole);
    expect(sections["roles"]).toContain(userFacing);
    expect(sections["roles"]!.indexOf(focusedRole!)).toBeLessThan(sections["roles"]!.indexOf(userFacing!));
  });

  it("gets the personality with the focused introduction, in either language", async () => {
    for (const language of ["en", "ko"] as const) {
      harness = await focusedHarness({ config: NO_INTERVIEW });
      await stage(harness, language);
      const row = await openChat(harness);
      const messages = await firstRequest(harness, await conversationOf(harness, row.conversationId));
      const sections = sectionsOf(messages);

      expect(sections["personality"]).toContain(PERSONALITY_INTRO_FOCUSED[language]);
      expect(sections["personality"]).not.toContain(PERSONALITY_INTRO_ROOT[language]);
      // The Korean writing rules follow the document, exactly as they do for the root.
      if (language === "ko") expect(sections["fluent-korean"]).toContain(FLUENT_KOREAN);
      else expect(sections["fluent-korean"]).toBeUndefined();
      expect(sections["simple-english"]).toContain(SIMPLE_ENGLISH);

      await harness.close();
      harness = undefined;
    }
  });

  it("does not get the personality interview the root gets", async () => {
    // The setting is on and no document is registered: exactly the root's
    // first-contact case.
    harness = await focusedHarness();
    const rootHead = systemText(
      await firstRequest(harness, await conversationOf(harness, Number(ROOT_CONVERSATION_ID)), "hello"),
    );
    const row = await openChat(harness);
    const head = systemText(await firstRequest(harness, await conversationOf(harness, row.conversationId)));

    expect(rootHead).toContain("no personality registered yet");
    expect(head).not.toContain("no personality registered yet");
    expect(sectionsOf(await firstRequest(harness, await conversationOf(harness, row.conversationId)))["personality"]).toBeUndefined();
  });

  it("carries the sections a subagent gets, and the two it shares with the root", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    await stage(harness, "en");
    const row = await openChat(harness);
    const messages = await firstRequest(harness, await conversationOf(harness, row.conversationId));

    expect(Object.keys(sectionsOf(messages))).toEqual([
      "preamble",
      // The language of every text the user reads, second in the prompt: this chat
      // talks with the user, and the personality staged above names English.
      "reply-language",
      "roles",
      "secrets",
      "web",
      "jobs",
      "js-tools",
      "async-tools",
      "agent-role",
      "subagents",
      "reports",
      "lessons-count",
      "scheduler",
      "self-edit",
      "session-restart",
      "conventions",
      "simple-english",
      "personality",
      "instructions",
    ]);
  });

  it("cannot call a tool outside its allow list, directly or through js", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    const row = await openChat(harness);

    // Directly: the harness does not offer a tool that is not in the list, so the
    // call comes back as an unknown tool and no body runs.
    const direct = await runTool(harness, row.conversationId, "jobs_create", { title: "not allowed" });
    expect(direct).toContain("jobs_create");
    expect(direct).toContain("not available");
    expect(await harness.runtime.jobs.list(CTX)).toEqual([]);

    // Through `js`: the nested runner looks the tool up in the same list, so the
    // allow list also bounds a nested call.
    const nested = await runTool(harness, row.conversationId, "js", {
      code: 'return await tools.jobs_create({ title: "not allowed either" });',
    });
    expect(nested).toContain("jobs_create");
    expect(await harness.runtime.jobs.list(CTX)).toEqual([]);

    // A tool the list does hold still works: the refusal above is the list, not a
    // broken tool round.
    const listed = await runTool(harness, row.conversationId, "jobs_list", {});
    expect(listed).toContain("job");

    const profile = await harness.runtime.harness.snapshot(AgentDoc, row.conversationId as never, CTX);
    expect(profile?.tools).toEqual([...FOCUSED_CHAT_TOOLS]);
    for (const name of ["focused_chat_title", "request_message", "send_message", "jobs_list", "read", "js", "share_image"]) {
      expect(FOCUSED_CHAT_TOOLS).toContain(name);
    }
    for (const name of ["jobs_create", "spawn_subagent", "focused_chat_archive", "focused_chat_delete", "ask_user"]) {
      expect(FOCUSED_CHAT_TOOLS).not.toContain(name);
    }
  });

  it("offers the title tool only to a focused chat, and archive and delete only to the root", async () => {
    harness = await focusedHarness({ config: NO_INTERVIEW });
    const root = await conversationOf(harness, Number(ROOT_CONVERSATION_ID));
    const row = await openChat(harness);
    const focused = await conversationOf(harness, row.conversationId);

    const names = async (conversation: typeof focused): Promise<string[]> =>
      (await conversation.agent(CTX)).tools.map((tool) => tool.name);

    expect(await names(root)).toEqual(expect.arrayContaining(["focused_chat_archive", "focused_chat_delete"]));
    expect(await names(root)).not.toContain("focused_chat_title");
    expect(await names(focused)).toContain("focused_chat_title");
    expect(await names(focused)).not.toContain("focused_chat_archive");
    expect(await names(focused)).not.toContain("focused_chat_delete");
    // The root keeps its own tools, and the focused chat has none of them.
    expect(await names(root)).toContain("reports_create");
    expect(await names(focused)).not.toContain("reports_create");

    // A subagent's removal list carries the three new names, and its own
    // `createdAsSubagent` rule is unchanged by them.
    for (const name of ["focused_chat_title", "focused_chat_archive", "focused_chat_delete"]) {
      expect(SUBAGENT_TOOL_REMOVALS).toContain(name);
    }
    const subagent = await harness.runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
          record.kind = "subagent";
          record.name = "helper";
          record.vmodel = "faux";
          record.status = "running";
          record.createdAt = Date.now();
          record.updatedAt = Date.now();
          const profile = await tx.doc(AgentDoc, conversationId);
          profile.tools = { remove: [...SUBAGENT_TOOL_REMOVALS] };
        },
      },
      CTX,
    );
    expect(await names(subagent)).not.toContain("focused_chat_archive");
    expect(await names(subagent)).not.toContain("focused_chat_title");
    expect(await harness.runtime.subagents!.createdAsSubagent(subagent.id, CTX)).toBe(true);
  });

  it("takes its model and thinking level from the root's vmodel alias", async () => {
    harness = await focusedHarness({ config: { agent: { ...defaultConfig().agent, vmodel: "faux" } } });
    const row = await openChat(harness);
    const record = await harness.runtime.harness.snapshot(SecAgent, String(row.conversationId), CTX);
    expect(record?.vmodel).toBe("faux");
    const agent = await (await conversationOf(harness, row.conversationId)).agent(CTX);
    expect(agent.model).toEqual({ provider: "faux", modelId: harness.faux.getModel().id });
    expect(agent.thinkingLevel).toBe("medium");
  });
});
