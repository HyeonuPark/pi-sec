import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SecAgent, SecAgentChild, SecAgentHub, type AgentStatus } from "../src/documents.ts";
import { archiveFocusedChat } from "../src/focused/service.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { depsOf, focusedHarness, openChat, runTool } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * The places that skip a focused chat.
 *
 * The user reads and writes a focused chat directly, so the harness owes the
 * root nothing about it: `background_list` lists it as what it is,
 * `subagent_delete` refuses it, the stall and idle watches stay silent about it,
 * and `diagnose_conversation` never calls it stalled. Each check drives the real
 * tool or sweep over a real chat, because the refusals and the silences are the
 * intended behavior.
 */

const CTX = BACKGROUND_CONTEXT;
const ROOT = Number(ROOT_CONVERSATION_ID);
const MINUTE = 60_000;

describe("the harness and a focused chat", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    harness = await focusedHarness();
    return harness;
  }

  /** One job and one report whose text names a conversation, with the user's approval. */
  async function approvedReportNaming(test: TestHarness, conversationId: number): Promise<string> {
    const job = await test.runtime.jobs.create(CTX, { title: "chat test" });
    const report = await test.runtime.reports.create(CTX, {
      jobId: job.id,
      title: "Chat test",
      content: `The test chat is conversation ${conversationId}.\n`,
    });
    const outcome = await test.runtime.reports.approve(CTX, report.id, 1, { via: "panel" });
    expect(outcome).toMatchObject({ ok: true });
    return report.id;
  }

  it("lists an open chat by kind and title, and drops it once it is archived or deleted", async () => {
    const h = await boot();
    const titled = await openChat(h, "Chat about the trip");
    const untitled = await openChat(h);

    const listed = await runTool(h, ROOT, "background_list", {});
    expect(listed).toContain('kind="focused"');
    expect(listed).toContain(`name="${titled.name}"`);
    expect(listed).toContain(`conversation="${titled.conversationId}"`);
    expect(listed).toContain('title="Chat about the trip"');
    // A chat without a title is still listed, with an empty title.
    expect(listed).toContain(`conversation="${untitled.conversationId}"`);
    expect(listed).toContain('title=""');
    expect(listed).not.toContain('kind="subagent"');

    await archiveFocusedChat(depsOf(h), titled.conversationId, CTX);
    const afterArchive = await runTool(h, ROOT, "background_list", {});
    expect(afterArchive).not.toContain(`conversation="${titled.conversationId}"`);
    expect(afterArchive).toContain(`conversation="${untitled.conversationId}"`);

    const reportId = await approvedReportNaming(h, untitled.conversationId);
    const deleted = await runTool(h, ROOT, "focused_chat_delete", {
      conversationId: untitled.conversationId,
      reportId,
    });
    expect(deleted).toContain("Deleted");
    const afterDelete = await runTool(h, ROOT, "background_list", {});
    expect(afterDelete).not.toContain(`conversation="${untitled.conversationId}"`);
    expect(afterDelete).toContain("no background calls");
  });

  it("refuses to delete a focused chat, even with force", async () => {
    const h = await boot();
    const chat = await openChat(h, "not yours to delete");

    const refused = await runTool(h, ROOT, "subagent_delete", { name: chat.name, reason: "cleanup" });
    expect(refused).toContain("is a focused chat");
    expect(refused).toContain("focused_chat_archive");
    expect(refused).toContain("focused_chat_delete");

    const forced = await runTool(h, ROOT, "subagent_delete", { name: chat.name, reason: "cleanup", force: true });
    expect(forced).toContain("is a focused chat");

    // Nothing moved: the chat is open, its record is there, and it still holds a slot.
    expect(h.runtime.focusedChats.get(chat.conversationId)?.archivedAt).toBeNull();
    expect(await h.runtime.harness.snapshot(SecAgent, String(chat.conversationId), CTX)).toBeDefined();
    expect(await h.runtime.harness.snapshot(SecAgentChild, ROOT, chat.name, CTX)).toBeDefined();
    expect((await h.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(1);
  });

  /** Write one child record of the root, dated `updatedAt`, as the idle notice reads it. */
  async function seedChild(test: TestHarness, name: string, status: AgentStatus, updatedAt: number): Promise<number> {
    let id = "";
    await test.runtime.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      id = String(conversation.id);
      const record = await tx.doc(SecAgent, id, id);
      record.kind = "subagent";
      record.name = name;
      record.parentConversationId = String(ROOT);
      record.status = status;
      record.createdAt = updatedAt;
      record.updatedAt = updatedAt;
      const index = await tx.doc(SecAgentChild, ROOT, name, name);
      index.name = name;
      index.conversationId = id;
      index.createdAt = updatedAt;
    }, CTX);
    return Number(id);
  }

  it("keeps the sweep silent about a chat that waits, and still counts its slot", async () => {
    const h = await boot();
    const chat = await openChat(h, "quiet chat");
    // The user has not written for a long time, which is exactly the wait that
    // earns a subagent its notice.
    await h.runtime.harness.commit(async (tx) => {
      const record = await tx.doc(SecAgent, String(chat.conversationId), String(chat.conversationId));
      record.updatedAt = Date.now() - 6 * MINUTE;
    }, CTX);
    const child = await seedChild(h, "parked-subagent", "waiting", Date.now() - 6 * MINUTE);

    const result = await h.runtime.subagents!.sweep(CTX);

    const messages = await h.runtime.subagents!.inbox(ROOT as ConversationId, CTX);
    const about = (name: string): number =>
      messages.filter((message) => message.body.includes(`"${name}"`)).length;
    expect(about(chat.name)).toBe(0);
    // The same wait on a subagent is still reported: the silence is about the
    // chat, not about the sweep.
    expect(about("parked-subagent")).toBe(1);
    // Skipping the notes must not drop the slot the chat holds.
    expect((await h.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(2);
    expect(result.live).toBe(2);
    expect(child).toBeGreaterThan(0);
  });

  it("never judges a focused chat stalled, by id or in the walk", async () => {
    const h = await boot();
    const chat = await openChat(h, "not stalled");

    const byId = await runTool(h, ROOT, "diagnose_conversation", {
      conversationId: String(chat.conversationId),
    });
    expect(byId).toContain(`conversation="${chat.conversationId}"`);
    expect(byId).toContain('stalled="no"');
    expect(byId).toContain('rule="focused-chat"');

    const walk = await runTool(h, ROOT, "diagnose_conversation", {});
    const judgement = walk
      .split("\n")
      .find((line) => line.includes("<judgement") && line.includes(`conversation="${chat.conversationId}"`));
    expect(judgement).toContain('stalled="no"');
    expect(judgement).toContain('rule="focused-chat"');
  });
});
