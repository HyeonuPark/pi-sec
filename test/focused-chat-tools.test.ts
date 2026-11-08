import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { SecAgent, SecAgentChild, SecAgentHub } from "../src/documents.ts";
import { FocusedChatError } from "../src/focused/service.ts";
import { conversationOf, depsOf, focusedHarness, openChat, runTool } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * The three focused chat tools.
 *
 * A focused chat titles itself once; the root archives a chat with the user's
 * permission and deletes one only with an approved report that names it. Each
 * rule is checked at the tool, because that is where the model meets it, and the
 * effects are checked in the store and in the agent records, because that is
 * where they have to be true.
 */

const CTX = BACKGROUND_CONTEXT;

describe("focused chat tools", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("titles a chat once, and then refuses", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness);

    const first = await runTool(harness, row.conversationId, "focused_chat_title", { title: "  Plan the trip  " });
    expect(first).toContain("Titled this focused chat");
    expect(harness.runtime.focusedChats.get(row.conversationId)?.title).toBe("Plan the trip");

    const second = await runTool(harness, row.conversationId, "focused_chat_title", { title: "Another" });
    expect(second).toContain("already has the title");
    expect(harness.runtime.focusedChats.get(row.conversationId)?.title).toBe("Plan the trip");

    // A title that is not one is refused before anything is written.
    const other = await openChat(harness);
    const empty = await runTool(harness, other.conversationId, "focused_chat_title", { title: "   " });
    expect(empty).toContain("must not be empty");
    const long = await runTool(harness, other.conversationId, "focused_chat_title", { title: "x".repeat(81) });
    expect(long).toContain("81");
    expect(harness.runtime.focusedChats.get(other.conversationId)?.title).toBeNull();
  });

  it("does not let the root title a chat", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness);
    // The root is not offered the tool at all, so the call never reaches a body.
    const refused = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_title", { title: "Root's" });
    expect(refused).toContain("focused_chat_title");
    expect(refused).toContain("not available");
    expect(harness.runtime.focusedChats.get(row.conversationId)?.title).toBeNull();
  });

  it("archives a chat from the root, which ends it but keeps its kind", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a chat to archive");
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(1);

    const archived = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_archive", {
      conversationId: row.conversationId,
    });
    expect(archived).toContain("Archived");
    // The row is archived, and the transcript and the record are still there.
    expect(harness.runtime.focusedChats.get(row.conversationId)).toMatchObject({
      archivedAt: expect.any(Number),
      title: "a chat to archive",
    });
    const record = await harness.runtime.harness.snapshot(SecAgent, String(row.conversationId), CTX);
    expect(record?.kind).toBe("focused");
    expect(record?.status).toBe("stopped");
    expect(record?.note).toBe("archived");
    // Its slot is back, and the root can no longer reach it by name.
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(0);
    expect(
      await harness.runtime.harness.snapshot(SecAgentChild, ROOT_CONVERSATION_ID, row.name, CTX),
    ).toBeUndefined();
    // A second archive is refused: an archived chat is not an open one.
    const again = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_archive", {
      conversationId: row.conversationId,
    });
    expect(again).toContain("already archived");
  });

  it("refuses to archive a conversation that is not a focused chat", async () => {
    harness = await focusedHarness();
    const refused = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_archive", {
      conversationId: Number(ROOT_CONVERSATION_ID),
    });
    expect(refused).toContain("not a focused chat");
  });

  it("does not let a subagent archive or delete a chat", async () => {
    harness = await focusedHarness({
      config: {
        personality: { file: "memory/personality.md", interview: false, roles: [] },
      },
    });
    const row = await openChat(harness);
    // A subagent's own tool round, with the subagent's removal list.
    const spawned = await harness.runtime.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        // A model, or the run ends unanswered before any tool is offered.
        agent: {
          model: { provider: "faux", modelId: harness.faux.getModel().id },
          thinkingLevel: "medium",
        },
        init: async (tx, conversationId) => {
          const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
          record.kind = "subagent";
          record.name = "helper";
          record.vmodel = "faux";
          record.status = "running";
          record.createdAt = Date.now();
          record.updatedAt = Date.now();
          const child = await tx.doc(SecAgentChild, ROOT_CONVERSATION_ID, "helper", "helper");
          child.name = "helper";
          child.conversationId = String(conversationId);
          child.createdAt = Date.now();
          // The spawn's own removal list, which is what a subagent is created with.
          const profile = await tx.doc(AgentDoc, conversationId);
          profile.tools = { remove: [...SUBAGENT_TOOL_REMOVALS] };
        },
      },
      CTX,
    );
    const agent = await spawned.agent(CTX);
    const names = agent.tools.map((tool) => tool.name);
    expect(names).not.toContain("focused_chat_archive");
    expect(names).not.toContain("focused_chat_delete");
    expect(names).not.toContain("focused_chat_title");

    const refused = await runTool(harness, spawned.id, "focused_chat_archive", { conversationId: row.conversationId });
    expect(refused).toContain("not available");
    expect(harness.runtime.focusedChats.get(row.conversationId)?.archivedAt).toBeNull();
  });

  /** One job and one report whose text names a conversation, plus an approval if asked. */
  async function reportNaming(conversationId: number, approve: boolean): Promise<string> {
    const job = await harness!.runtime.jobs.create(CTX, { title: "chat test" });
    const report = await harness!.runtime.reports.create(CTX, {
      jobId: job.id,
      title: "Chat test",
      content: `The test chat is conversation ${conversationId}.\n`,
    });
    if (approve) {
      const outcome = await harness!.runtime.reports.approve(CTX, report.id, 1, { via: "panel" });
      expect(outcome).toMatchObject({ ok: true });
    }
    return report.id;
  }

  it("refuses a delete whose report the user did not approve", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a test chat");
    const reportId = await reportNaming(row.conversationId, false);

    const refused = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId,
    });
    expect(refused).toContain("not the revision the user approved");
    expect(harness.runtime.focusedChats.get(row.conversationId)).toBeDefined();
    expect(harness.runtime.focusedChats.isDeleted(row.conversationId)).toBe(false);
  });

  it("refuses a delete whose approved report names another conversation", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a test chat");
    const other = await openChat(harness, "another chat");
    const reportId = await reportNaming(other.conversationId, true);

    const refused = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId,
    });
    expect(refused).toContain("does not name conversation");
    expect(harness.runtime.focusedChats.get(row.conversationId)).toBeDefined();
  });

  it("deletes a test chat once the approved report names it", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a test chat");
    const reportId = await reportNaming(row.conversationId, true);

    const deleted = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId,
    });
    expect(deleted).toContain("Deleted");
    expect(harness.runtime.focusedChats.get(row.conversationId)).toBeUndefined();
    expect(harness.runtime.focusedChats.isDeleted(row.conversationId)).toBe(true);
    expect(harness.runtime.focusedChats.listActive()).toEqual([]);
    // The parent edge and the record go, and the slot comes back.
    expect(
      await harness.runtime.harness.snapshot(SecAgentChild, ROOT_CONVERSATION_ID, row.name, CTX),
    ).toBeUndefined();
    expect(await harness.runtime.harness.snapshot(SecAgent, String(row.conversationId), CTX)).toBeUndefined();
    expect((await harness.runtime.harness.snapshot(SecAgentHub, CTX))?.live).toBe(0);
    // The transcript entries stay: the transcript store has no delete.
    const conversation = await conversationOf(harness, row.conversationId);
    expect(conversation).toBeDefined();

    const again = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId,
    });
    expect(again).toContain("deleted");
  });

  it("refuses an approval of a revision the text has moved past", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a test chat");
    const reportId = await reportNaming(row.conversationId, true);
    // A newer revision has no approval, so the approval on the older one no longer
    // speaks for what the report says now.
    await harness.runtime.reports.addVersion(CTX, reportId, { content: "something else entirely\n" });

    const refused = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId,
    });
    expect(refused).toContain("not the revision the user approved");
    expect(harness.runtime.focusedChats.get(row.conversationId)).toBeDefined();
  });

  it("fails a message to an archived chat, because its edge is retired", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "gone soon");
    await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_archive", { conversationId: row.conversationId });

    const sent = await runTool(harness, Number(ROOT_CONVERSATION_ID), "send_message", {
      to: row.name,
      body: "still there?",
    });
    expect(sent).toContain(`no subagent named "${row.name}"`);

    const asked = await runTool(harness, Number(ROOT_CONVERSATION_ID), "request_message", {
      to: row.name,
      body: "still there?",
    });
    expect(asked).toContain(`no subagent named "${row.name}"`);
  });

  it("names the root as the focused chat's parent, so parent-agent resolves", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness);
    const hub = harness.runtime.subagents!;
    const target = await hub.resolveTarget(CTX, row.conversationId as never, "focused", "parent-agent");
    expect("peer" in target).toBe(true);
    if (!("peer" in target)) return;
    expect(target.peer.agentKind).toBe("root");
    expect(target.peer.conversationId).toBe(String(ROOT_CONVERSATION_ID));
    // A focused chat may send the root a note and a request, and no order.
    expect(hub.allowedKinds("focused", "root")).toEqual(["note", "request"]);
  });

  it("keeps the refusal codes apart for the routes", async () => {
    // The service layer is what the routes read, so its codes are worth pinning.
    harness = await focusedHarness();
    await expect(
      (async () => {
        const deps = depsOf(harness!);
        const { archiveFocusedChat } = await import("../src/focused/service.ts");
        await archiveFocusedChat(deps, 999, CTX);
      })(),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      (async () => {
        const deps = depsOf(harness!);
        const { archiveFocusedChat } = await import("../src/focused/service.ts");
        await archiveFocusedChat(deps, Number(ROOT_CONVERSATION_ID), CTX);
      })(),
    ).rejects.toBeInstanceOf(FocusedChatError);
  });
});

describe("focused_chat_delete and a Done", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("reads a Done on a result report as the approval it is", async () => {
    harness = await focusedHarness();
    const row = await openChat(harness, "a test chat");
    const job = await harness.runtime.jobs.create(CTX, { title: "chat test" });
    const report = await harness.runtime.reports.create(CTX, {
      jobId: job.id,
      title: "Chat test",
      content: `The test chat is conversation ${row.conversationId}.\n`,
      kind: "result",
    });
    // The result report is approved the way a result report is: with Done, and
    // with the user's words asking for the chat to go.
    const outcome = await harness.runtime.reports.approve(CTX, report.id, 1, {
      via: "viewer",
      button: "done",
      text: "delete the test chat",
    });
    expect(outcome).toMatchObject({ ok: true });

    const deleted = await runTool(harness, Number(ROOT_CONVERSATION_ID), "focused_chat_delete", {
      conversationId: row.conversationId,
      reportId: report.id,
    });
    expect(deleted).toContain("Deleted");
    expect(harness.runtime.focusedChats.isDeleted(row.conversationId)).toBe(true);
  });
});
