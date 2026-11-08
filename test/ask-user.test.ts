import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SecAgent, SecUserQueryList, userQueryKey, type UserQueryListItem } from "../src/documents.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `ask_user` opens a question and returns at once; the answer comes back later,
 * through the route, as operator input.
 *
 * These tests pin the whole contract of the review round: the question is a row
 * in the session document `sec.userQueryList`, the key is the row's name, the
 * turn is never blocked, `questions_open` and `question_withdraw` read and change
 * the same row, and one commit holds the read and the write of both.
 */

const ctx = BACKGROUND_CONTEXT;

/** A scripted turn that calls one tool, with the arguments the tool declares. */
function callTool(name: string, args: Parameters<typeof fauxToolCall>[1]): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function said(text: string): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxText(text)]);
}

/** The text of one entry, whichever shape its content takes. */
function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: string }).text ?? "")
            : "",
        )
        .join("");
    })
    .join("\n");
}

/** Every tool result of one conversation, with the flag that says it failed. */
async function toolResults(conversation: Conversation): Promise<{ text: string; isError: boolean }[]> {
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
  return page.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const first = (entry.model?.[0] ?? {}) as { isError?: boolean };
      return { text: entryText(entry), isError: first.isError === true };
    });
}

/** The open questions as the server reads them. */
async function openItems(harness: TestHarness): Promise<readonly UserQueryListItem[]> {
  const stored = await harness.runtime.harness.snapshot(SecUserQueryList, ctx);
  return stored?.items ?? [];
}

/** The whole list document, or `undefined` when nothing has written it. */
async function listDocument(harness: TestHarness) {
  return await harness.runtime.harness.snapshot(SecUserQueryList, ctx);
}

/**
 * Run one turn of `responses` in `conversation` and wait for it to end.
 *
 * Every turn here ends on its own: `ask_user` does not wait, so a blocked turn
 * would show up as a missing scripted answer rather than as an unanswered
 * question. A test that expects the turn to be blocked therefore fails on the
 * response queue instead of hanging.
 */
async function run(
  harness: TestHarness,
  conversation: Conversation,
  responses: ReturnType<typeof fauxAssistantMessage>[],
): Promise<void> {
  harness.faux.setResponses(responses);
  const submission = await conversation.submit({ type: "input", content: "ask me" }, ctx);
  const settled = await submission.wait(ctx);
  expect(settled.status).toBe("done");
}

/** Ask one question in one conversation, and return the row that names it. */
async function ask(
  harness: TestHarness,
  conversation: Conversation,
  args: { question: string; options: string[]; supersedes?: string },
): Promise<UserQueryListItem> {
  await run(harness, conversation, [callTool("ask_user", args), said("noted")]);
  const key = userQueryKey(String(conversation.id), args.question, args.options);
  const item = (await openItems(harness)).find((candidate) => candidate.key === key);
  expect(item, `no open row for ${JSON.stringify(args.question)}`).toBeDefined();
  return item!;
}

/**
 * A second root conversation, so a test can ask the same question somewhere else.
 *
 * A conversation nobody registered reads as `scheduled` to the tool gate, and
 * `ask_user` is for the root only, so this one writes its own agent record first,
 * which is what the kind gate reads.
 */
async function secondRootConversation(harness: TestHarness): Promise<Conversation> {
  const model = harness.faux.getModel();
  return await harness.runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: model.id }, thinkingLevel: "medium" },
      init: async (tx, conversationId) => {
        const record = await tx.doc(SecAgent, String(conversationId), String(conversationId));
        record.kind = "root";
        record.name = "second-root";
        record.vmodel = "faux";
        record.roles = [];
        record.status = "running";
        record.createdAt = Date.now();
        record.updatedAt = Date.now();
      },
    },
    ctx,
  );
}

describe("ask_user", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("returns at once, opens the question, and does not block the turn", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);

    await run(harness, conversation, [
      callTool("ask_user", { question: "Which account?", options: ["work", "personal"] }),
      said("carrying on"),
    ]);

    const items = await openItems(harness);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.question).toBe("Which account?");
    expect(item.options).toEqual(["work", "personal"]);
    expect(item.conversationId).toBe(String(conversation.id));
    expect(item.key).toBe(userQueryKey(String(conversation.id), "Which account?", ["work", "personal"]));
    expect(typeof item.id).toBe("string");
    expect(item.id.length).toBeGreaterThan(0);
    expect(typeof item.createdAt).toBe("number");

    // The turn ran to its scripted end: the tool result names the key, and
    // nothing in the conversation was waiting for an answer.
    const results = await toolResults(conversation);
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toContain(`key ${item.key}`);
    expect(results[0]!.text).toContain("not blocked");

    const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
    expect(page.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
  });

  it("opens one row for a question asked twice and names the row that is already open", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);

    const first = await ask(harness, conversation, { question: "Which account?", options: ["work"] });
    const afterFirst = await listDocument(harness);

    await run(harness, conversation, [
      callTool("ask_user", { question: "Which account?", options: ["work"] }),
      said("noted"),
    ]);

    const items = await openItems(harness);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(first.id);
    expect(items[0]!.key).toBe(first.key);
    // A second call that opens nothing does not touch the list, so the row keeps
    // the time it was opened.
    expect(items[0]!.createdAt).toBe(first.createdAt);
    expect((await listDocument(harness))?.updatedAt).toBe(afterFirst?.updatedAt);

    const results = await toolResults(conversation);
    expect(results[1]!.text).toContain(`already open as ${first.id}`);
    expect(results[1]!.text).toContain(`key ${first.key}`);
  });

  it("replaces an open question when the call names it as superseded", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);

    const first = await ask(harness, conversation, { question: "Which account?", options: ["work"] });
    const second = await ask(harness, conversation, {
      question: "Which mailbox?",
      options: ["shared"],
      supersedes: first.key,
    });

    const items = await openItems(harness);
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe(second.key);
    expect(items[0]!.id).not.toBe(first.id);
  });

  it("lists this conversation's open questions only, in the order they were asked", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const first = await ask(harness, conversation, { question: "Which account?", options: ["work"] });
    const second = await ask(harness, conversation, { question: "Which mailbox?", options: ["shared", "team"] });

    const elsewhere = await secondRootConversation(harness);
    const other = await ask(harness, elsewhere, { question: "Which account?", options: ["work"] });

    await run(harness, conversation, [callTool("questions_open", {}), said("noted")]);

    const text = (await toolResults(conversation)).at(-1)!.text;
    const lines = text.split("\n").filter((line) => line.startsWith("<item "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`key="${first.key}"`);
    expect(lines[1]).toContain(`key="${second.key}"`);
    expect(lines[1]).toContain('options="2"');
    // The other conversation's question is not this conversation's to answer.
    expect(text).not.toContain(other.key);
  });

  it("says nothing is open when no question has ever been asked", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    // No document has been written at all: an absent list is an empty list.
    expect(await listDocument(harness)).toBeUndefined();

    await run(harness, conversation, [callTool("questions_open", {}), said("noted")]);

    expect((await toolResults(conversation)).at(-1)!.text.trim()).toBe("no open questions in this conversation");
  });

  it("withdraws an open question, records it, and takes it off the list", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const item = await ask(harness, conversation, { question: "Which account?", options: ["work"] });

    const seen: unknown[] = [];
    harness.events.subscribe((event) => seen.push(event));
    await run(harness, conversation, [callTool("question_withdraw", { key: item.key }), said("noted")]);

    expect(await openItems(harness)).toHaveLength(0);
    expect((await toolResults(conversation)).at(-1)!.isError).toBe(false);
    expect((await toolResults(conversation)).at(-1)!.text).toContain(item.id);

    const records = (await readAuditTail(harness.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "question_withdrawn",
    );
    expect(records).toHaveLength(1);
    expect(records[0]!["key"]).toBe(item.key);
    expect(records[0]!["id"]).toBe(item.id);
    expect(records[0]!["conversationId"]).toBe(String(conversation.id));

    const resolved = seen.filter(
      (event) => (event as { type?: string }).type === "user_query_resolved",
    ) as { data?: { reason?: string; id?: string } }[];
    expect(resolved.map((event) => event.data?.reason)).toEqual(["withdraw"]);
    expect(resolved[0]!.data?.id).toBe(item.id);
  });

  it("refuses to withdraw a key that is not open and leaves the list alone", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const item = await ask(harness, conversation, { question: "Which account?", options: ["work"] });

    await run(harness, conversation, [callTool("question_withdraw", { key: "0".repeat(64) }), said("noted")]);

    const results = await toolResults(conversation);
    const refusal = results.at(-1)!;
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toContain("no open question with key");
    expect(refusal.text).toContain("0".repeat(64));

    // The question that was open is still open, and no withdrawal was recorded.
    const items = await openItems(harness);
    expect(items.map((each) => each.key)).toEqual([item.key]);
    const records = (await readAuditTail(harness.paths.auditLog, undefined, 50)).filter(
      (event) => event.type === "question_withdrawn",
    );
    expect(records).toHaveLength(0);
  });

  it("refuses a withdrawal of another conversation's question", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const elsewhere = await secondRootConversation(harness);
    const other = await ask(harness, elsewhere, { question: "Which account?", options: ["work"] });

    await run(harness, conversation, [callTool("question_withdraw", { key: other.key }), said("noted")]);

    const refusal = (await toolResults(conversation)).at(-1)!;
    expect(refusal.isError).toBe(true);
    expect((await openItems(harness)).map((each) => each.key)).toEqual([other.key]);
  });
});

/**
 * The active list is read and written in one commit.
 *
 * These three tests follow the read-modify-write shape that the tool uses:
 * a read and a write in one commit, a second ask that does not grow the list, and one question in two
 * conversations landing as two rows.
 */
describe("ask_user: the active list is read and written in one commit", () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("reads, changes and writes the list in one commit, and the next commit sees it", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const conversationId = String(conversation.id);
    const first = { conversationId, question: "Which account?", options: ["work"] };
    const second = { conversationId, question: "Which mailbox?", options: ["shared"] };

    await harness.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecUserQueryList);
      // The seed value is the empty list, and the write lands with the commit.
      expect(draft.items).toEqual([]);
      draft.items.push({
        key: userQueryKey(first.conversationId, first.question, first.options),
        id: "01J000000000000000000000AA",
        conversationId,
        question: first.question,
        options: [...first.options],
        createdAt: 5,
      });
      draft.updatedAt = 5;
    }, ctx);

    await harness.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecUserQueryList);
      // The previous commit is what this read returns, and the change is built
      // on it rather than on a copy taken before.
      expect(draft.items).toHaveLength(1);
      expect(draft.items[0]!.question).toBe(first.question);
      draft.items.push({
        key: userQueryKey(second.conversationId, second.question, second.options),
        id: "01J000000000000000000000BB",
        conversationId,
        question: second.question,
        options: [...second.options],
        createdAt: 6,
      });
      draft.updatedAt = 6;
    }, ctx);

    const stored = await listDocument(harness);
    expect(stored?.items.map((item) => item.question)).toEqual([first.question, second.question]);
    expect(stored?.updatedAt).toBe(6);
  });

  it("adopts the shape for the tool: two asks of one question leave one row", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);

    const first = await ask(harness, conversation, { question: "Which account?", options: ["work", "personal"] });
    await ask(harness, conversation, { question: "Which account?", options: ["work", "personal"] });

    const stored = await listDocument(harness);
    expect(stored?.items).toHaveLength(1);
    expect(stored?.items[0]!.id).toBe(first.id);
    // One row, one key: the duplicate check and the write happened in the same
    // commit, so the second call could not read a list without the first row.
    expect(new Set(stored?.items.map((item) => item.key)).size).toBe(1);
  });

  it("adopts the shape across conversations: one question in two conversations is two rows", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    const elsewhere = await secondRootConversation(harness);

    const here = await ask(harness, conversation, { question: "Which account?", options: ["work"] });
    const there = await ask(harness, elsewhere, { question: "Which account?", options: ["work"] });

    expect(here.key).not.toBe(there.key);
    expect(here.id).not.toBe(there.id);
    const stored = await listDocument(harness);
    expect(stored?.items).toHaveLength(2);
    expect(stored?.items.map((item) => item.conversationId).sort()).toEqual(
      [String(conversation.id), String(elsewhere.id)].sort(),
    );
  });
});
