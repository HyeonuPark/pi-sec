import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { contextPath } from "../src/agent/context-file.ts";
import { FOCUSED_CHAT_TOOLS, focusedChatTools } from "../src/agent/tool-profile.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild, SecAgentHub, SecInbox } from "../src/documents.ts";
import { FOCUSED_CHAT_ROLES, FocusedChatError, openFocusedChat } from "../src/focused/service.ts";
import { depsOf, focusedHarness, openChat } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";
import type { PiSecEvent } from "../src/runtime/event-bus.ts";

/**
 * Opening a focused chat.
 *
 * One commit has to leave behind everything the chat needs to be a chat: a
 * conversation, an agent record that says it is focused, the root's name index,
 * the tool allow list and the state-file briefing. The store row is written in
 * the same commit, and the inbox notice and the bus event come after it.
 */

const CTX = BACKGROUND_CONTEXT;

describe("opening a focused chat", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("creates the conversation, its record, the parent edge and the store row", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a topic to discuss");

    expect(row.conversationId).toBeGreaterThan(0);
    expect(row.name).toBe(`focused-${row.seq}`);
    expect(row.title).toBe("a topic to discuss");
    expect(row.archivedAt).toBeNull();

    const record = await harness.runtime.harness.snapshot(SecAgent, String(row.conversationId), CTX);
    expect(record?.kind).toBe("focused");
    expect(record?.name).toBe(row.name);
    expect(record?.parentConversationId).toBe(String(ROOT_CONVERSATION_ID));
    expect(record?.status).toBe("waiting");
    expect(record?.vmodel).toBe(harness.config.agent.vmodel);
    expect([...(record?.roles ?? [])]).toEqual([...FOCUSED_CHAT_ROLES]);

    const edge = await harness.runtime.harness.snapshot(SecAgentChild, ROOT_CONVERSATION_ID, row.name, CTX);
    expect(edge?.conversationId).toBe(String(row.conversationId));

    // The model comes from the root's alias, and the two facts a subagent also
    // gets are there: its own model and its own thinking level.
    const conversation = await harness.runtime.harness.conversation(row.conversationId as never, CTX);
    const agent = await conversation!.agent(CTX);
    expect(agent.model?.provider).toBe("faux");
    expect(agent.thinkingLevel).toBe("medium");

    // Its slot is counted, like a subagent's.
    const hub = await harness.runtime.harness.snapshot(SecAgentHub, CTX);
    expect(hub?.live).toBe(1);
  });

  it("offers exactly the allow list, and the config's extra tools after it", async () => {
    harness = await focusedHarness();
    const plain = await openChat(harness);
    const profile = await harness.runtime.harness.snapshot(AgentDoc, plain.conversationId as never, CTX);
    expect(Array.isArray(profile?.tools)).toBe(true);
    expect(profile?.tools).toEqual([...FOCUSED_CHAT_TOOLS]);
    // The briefing names the chat's own state file, as a subagent's does.
    expect(profile?.instructions).toContain(contextPath(harness.paths, String(plain.conversationId)));
  });

  it("adds the configured extra tools to a newly opened chat", async () => {
    harness = await focusedHarness({
      config: { agent: { ...defaultConfig().agent, focusedChat: { extraTools: ["secrets_list", "extra_tool"] } } },
    });
    const row = await openChat(harness);
    const profile = await harness.runtime.harness.snapshot(AgentDoc, row.conversationId as never, CTX);
    expect(profile?.tools).toEqual(focusedChatTools(["secrets_list", "extra_tool"]));
    expect(profile?.tools).toContain("secrets_list");
    expect(profile?.tools).toContain("extra_tool");
    // A name that is already in the fixed list is not written twice.
    expect(focusedChatTools(["read", "read"])).toEqual([...FOCUSED_CHAT_TOOLS]);
  });

  it("writes one inbox notice and publishes one event", async () => {
    harness = await focusedHarness();
    const seen: PiSecEvent[] = [];
    const unsubscribe = harness.events.subscribe((event) => seen.push(event));
    try {
      const row = await openChat(harness, "Plan the trip");

      const notices = seen.filter((event) => event.type === "inbox_item");
      expect(notices).toHaveLength(1);
      const item = notices[0]!.data as unknown as {
        id: string;
        kind: string;
        title: string;
        body: string;
        source?: { conversationId?: string };
      };
      expect(item.kind).toBe("focused_chat");
      expect(item.title).toBe("Focused chat opened: Plan the trip");
      expect(item.body).toBe("Open it from this notice or from the Chats page.");
      expect(item.source?.conversationId).toBe(String(row.conversationId));

      // The item is stored as well as announced: a page opened later reads it back.
      const stored = await harness.runtime.harness.snapshot(SecInbox, item.id, CTX);
      expect(stored?.title).toBe("Focused chat opened: Plan the trip");
      expect(stored?.source?.conversationId).toBe(String(row.conversationId));

      const events = seen.filter((event) => event.type === "focused_chat_updated");
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toEqual({
        conversationId: row.conversationId,
        name: row.name,
        title: "Plan the trip",
        openedAt: row.openedAt,
        archivedAt: null,
        change: "opened",
      });
    } finally {
      unsubscribe();
    }
  });

  it("says Untitled in the notice when the chat has no title", async () => {
    harness = await focusedHarness();
    const seen: PiSecEvent[] = [];
    harness.events.subscribe((event) => seen.push(event));
    await openChat(harness);
    const item = seen.find((event) => event.type === "inbox_item")!.data as unknown as { title: string };
    expect(item.title).toBe("Focused chat opened: Untitled");
  });

  it("opens a test chat with the notice and the event a normal chat gets", async () => {
    harness = await focusedHarness();
    const seen: PiSecEvent[] = [];
    const unsubscribe = harness.events.subscribe((event) => seen.push(event));
    const row = await openFocusedChat(depsOf(harness), { test: true }, CTX);
    unsubscribe();

    // The row keeps the mark, and nothing a surface shows changes with it: the
    // plan has the list page alone tell a test chat apart.
    expect(row.test).toBe(true);
    expect(harness.runtime.focusedChats.get(row.conversationId)?.test).toBe(true);

    const notices = seen.filter((event) => event.type === "inbox_item");
    expect(notices).toHaveLength(1);
    const item = notices[0]!.data as unknown as { kind: string; title: string; body: string };
    expect(item.kind).toBe("focused_chat");
    expect(item.title).toBe("Focused chat opened: Untitled");
    expect(item.body).toBe("Open it from this notice or from the Chats page.");

    const events = seen.filter((event) => event.type === "focused_chat_updated");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      conversationId: row.conversationId,
      name: row.name,
      title: null,
      openedAt: row.openedAt,
      archivedAt: null,
      change: "opened",
    });
  });

  it("creates the chat's state file", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness);
    const text = await readFile(contextPath(harness.paths, String(row.conversationId)), "utf8");
    expect(text).toBe("");
  });

  it("refuses an empty or overlong title", async () => {
    harness = await focusedHarness();
    for (const title of ["", "   ", "x".repeat(81)]) {
      await expect(openChat(harness, title)).rejects.toMatchObject({ code: "invalid_request" });
    }
    // A title of exactly the limit is a title.
    const row = await openChat(harness, "y".repeat(80));
    expect(row.title).toHaveLength(80);
    // Nothing was created by the refusals: only the one chat exists.
    expect(harness.runtime.focusedChats.listActive()).toHaveLength(1);
  });

  it("refuses when the root conversation does not exist", async () => {
    harness = await focusedHarness({ prepareRoot: false });
    await expect(openChat(harness)).rejects.toBeInstanceOf(FocusedChatError);
    await expect(openChat(harness)).rejects.toMatchObject({ code: "root_missing" });
    expect(harness.runtime.focusedChats.listActive()).toEqual([]);
  });

  it("refuses at the slot limit, and leaves nothing behind", async () => {
    harness = await focusedHarness({
      config: {
        agent: {
          ...defaultConfig().agent,
          subagent: { ...defaultConfig().agent.subagent, maxTotal: 0 },
        },
      },
    });
    await expect(openChat(harness)).rejects.toMatchObject({ code: "capacity", live: 0, limit: 0 });
    expect(harness.runtime.focusedChats.listActive()).toEqual([]);
    // The counter was never written: the commit that would have written it failed
    // before it reached the limit line.
    expect(await harness.runtime.harness.snapshot(SecAgentHub, CTX)).toBeUndefined();
  });

  it("counts open chats against the same limit as subagents", async () => {
    harness = await focusedHarness({
      config: {
        agent: {
          ...defaultConfig().agent,
          subagent: { ...defaultConfig().agent.subagent, maxTotal: 2 },
        },
      },
    });
    await openChat(harness);
    await openChat(harness);
    await expect(openChat(harness)).rejects.toMatchObject({ code: "capacity", live: 2, limit: 2 });
    // The first two are untouched: a refusal creates nothing and drops nothing.
    expect(harness.runtime.focusedChats.listActive()).toHaveLength(2);
    expect(harness.runtime.focusedChats.listActive().every((row) => row.archivedAt === null)).toBe(true);
  });
});
