import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { snapshotOf, translateView } from "../src/server/conversation-events.ts";

/** A view with the given entries and `pi.live` document; the other fields are not read. */
function view(entries: readonly unknown[], live: Record<string, unknown> = {}): ConversationView {
  return { conversation: {}, entries, docs: { "pi.live": live } } as unknown as ConversationView;
}

function entry(id: number, role: string, extra: Record<string, unknown> = {}): EntryRecord {
  return { id, conversationId: 1, kind: `pi.${role}`, model: [{ role, content: "x", ...extra }] } as unknown as EntryRecord;
}

const types = (events: readonly { type: string }[]): string[] => events.map((event) => event.type);

describe("conversation-events.ts: frames built from two view revisions", () => {
  it("sends an appended entry once, as a start and an end, and nothing for an entry already sent", () => {
    const before = view([entry(1, "user")]);
    const after = view([entry(1, "user"), entry(2, "assistant")]);
    const first = translateView(before, after, 1);
    expect(types(first.events)).toEqual(["message_start", "message_end"]);
    expect(first.newest).toBe(2);
    const again = translateView(after, after, first.newest);
    expect(again.events).toEqual([]);
  });

  it("sends an entry without a message as entry_appended", () => {
    const note = { id: 3, conversationId: 1, kind: "test.note", data: {} } as unknown as EntryRecord;
    const { events } = translateView(view([]), view([note]), 0);
    expect(types(events)).toEqual(["entry_appended"]);
  });

  it("does not repeat message_start for an answer that streamed", () => {
    const partial = { role: "assistant", content: [] };
    const before = view([entry(1, "user")], { generation: { attempt: 1, message: partial }, run: { taskId: 5, inputs: [9], turns: 0 } });
    const after = view([entry(1, "user"), entry(2, "assistant")], { run: { taskId: 5, inputs: [9], turns: 0 } });
    expect(types(translateView(before, after, 1).events)).toEqual(["message_end"]);
    const opens = translateView(view([entry(1, "user")]), before, 1);
    expect(types(opens.events)).toEqual(["message_start", "run_start"]);
  });

  it("orders a tool's end before its result entry, and sends the run's end after them", () => {
    const slot = { callId: "c1", name: "bash", status: "running" };
    const result = entry(4, "toolResult", { toolCallId: "c1" });
    const before = view([entry(3, "assistant")], { run: { taskId: 5, inputs: [9], turns: 1 }, tools: [slot] });
    const after = view([entry(3, "assistant"), result], { tools: [{ ...slot, status: "done", entry: 4 }] });
    const { events } = translateView(before, after, 3);
    expect(types(events)).toEqual(["tool_execution_end", "message_start", "message_end", "run_end"]);
    const end = events[0] as { entry?: EntryRecord };
    expect(end.entry?.id).toBe(4);
  });

  it("sends a tool's start and its output as an append or a replacement", () => {
    const slot = { callId: "c1", name: "bash", status: "running", output: "ab" };
    const started = translateView(view([], {}), view([], { tools: [slot] }), 0);
    expect(types(started.events)).toEqual(["tool_execution_start"]);
    const appended = translateView(view([], { tools: [slot] }), view([], { tools: [{ ...slot, output: "abcd" }] }), 0);
    expect(appended.events).toEqual([{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { append: "cd" } }]);
    const replaced = translateView(view([], { tools: [slot] }), view([], { tools: [{ ...slot, output: "zz" }] }), 0);
    expect((replaced.events[0] as { output: unknown }).output).toEqual({ set: "zz" });
  });

  it("builds a snapshot from the active entries and the live document", () => {
    const snapshot = snapshotOf(view([entry(1, "user")], { run: { taskId: 5, inputs: [9], turns: 0 } }), [entry(2, "user")]);
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.entries.map((each) => each.id)).toEqual([2]);
    expect(snapshot.run).toEqual({ inputs: [9] });
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.agent).toBeDefined();
  });
});
