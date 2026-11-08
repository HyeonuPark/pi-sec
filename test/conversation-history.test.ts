/**
 * The two read-only routes that hand one earlier session back, and the snapshot
 * field that says there is one.
 *
 * A session is the stretch of a conversation between two session restarts. The
 * page draws the active context alone, so everything a restart left behind is
 * stored and not sent; these routes are the read that gives it back, one session
 * per press, and they write nothing.
 *
 * The shape of the answer is what the page draws: the session's entries oldest
 * first with its `pi.reset` first of all (that is the `new session` divider), the
 * attachment descriptors those entries name, and `hasMore`, which is whether the
 * conversation stores anything before the first entry answered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryDraft, EntryId } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { HISTORY_MAX_BYTES, cutSessionBlock, hasEntriesBefore, readBeforeParam } from "../src/server/routes/history.ts";
import { createAttachment } from "../src/attachments/store.ts";
import { bootServer, conversationOf, focusedHarness, openChat, type BootedServer } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

const CTX = BACKGROUND_CONTEXT;

/** The smallest PNG header the upload reader accepts, written by hand. */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  for (let index = 26; index < buf.length; index += 1) buf[index] = index * 7;
  return buf;
}

/** One answer, as the two routes write it. */
interface HistoryAnswer {
  entries: { id: number; kind: string; model?: unknown[] }[];
  attachments: Record<string, { name?: string; mime?: string }>;
  hasMore: boolean;
  apiVersion: number;
}

describe("one earlier session", () => {
  let harness: TestHarness | undefined;
  let booted: BootedServer | undefined;

  afterEach(async () => {
    await booted?.started.close();
    booted = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<string> {
    harness = await focusedHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
    booted = await bootServer(harness);
    return booted.origin;
  }

  /** One entry appended to one conversation, without running the model. */
  async function append(
    test: TestHarness,
    conversationId: number,
    entry: EntryDraft,
  ): Promise<EntryId> {
    let id = 0 as EntryId;
    await test.runtime.harness.commit(async (tx) => {
      const written = await tx.appendEntry(conversationId as ConversationId, entry);
      id = written.id;
    }, CTX);
    return id;
  }

  /** One operator message inside the envelope the server writes. */
  function operatorMessage(body: string): EntryDraft {
    return {
      kind: "pi.user",
      model: [{ role: "user", content: `<pi-message src="operator">\n${body}\n</pi-message>`, timestamp: Date.now() }],
    };
  }

  /** One answer the model wrote. */
  function assistantMessage(body: string): EntryDraft {
    return {
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "text", text: body }], timestamp: Date.now() }],
    };
  }

  /** One session restart: the entry that ends a session and starts the next. */
  function restart(handoff?: string): EntryDraft {
    return {
      kind: "pi.reset",
      head: "self",
      ...(handoff === undefined
        ? {}
        : { model: [{ role: "user", content: handoff, timestamp: Date.now() }] }),
    };
  }

  /** Every entry of one conversation, oldest first, read the way the store holds them. */
  async function allEntries(test: TestHarness, conversationId: number) {
    const conversation = await conversationOf(test, conversationId);
    const page = await conversation.entries({ order: "ascending" }, 5000, undefined, CTX);
    return page.items;
  }

  /**
   * A conversation with three sessions, built by hand so the ids are known.
   *
   * Session 1 is one message, session 2 is two messages, and session 3 is what the
   * page would be showing: `ids[0]` to `ids[6]` in order, with the restarts at
   * `ids[1]` and `ids[4]`.
   */
  async function threeSessions(test: TestHarness): Promise<{ conversationId: number; ids: number[] }> {
    const conversation = await conversationOf(test, ROOT_CONVERSATION_ID as unknown as number);
    const ids: number[] = [];
    for (const entry of [
      operatorMessage("first session, one line"),
      restart("handoff one"),
      operatorMessage("second session, first line"),
      assistantMessage("second session, the answer"),
      restart("handoff two"),
      operatorMessage("third session, the line on screen"),
      assistantMessage("third session, the answer on screen"),
    ]) {
      ids.push(await append(test, conversation.id as unknown as number, entry));
    }
    return { conversationId: conversation.id as unknown as number, ids };
  }

  function read(origin: string, path: string): Promise<Response> {
    return fetch(`${origin}${path}`);
  }

  it("cuts one session at a time and tiles the conversation with no gap and no overlap", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const { conversationId, ids } = await threeSessions(harness!);
    const everything = await allEntries(harness!, conversationId);
    // What the page does not hold: everything stored before the active context, and
    // the presses below have to cover exactly that.
    const stored = everything.map((entry) => entry.id as number).filter((id) => id < ids[4]!);

    // The page holds the active context, which starts at the newest restart.
    let before = ids[4]!;
    const collected: number[] = [];
    const answers: HistoryAnswer[] = [];
    for (let press = 0; press < 10; press += 1) {
      const response = await read(origin, `/api/conversations/${conversationId}/history?before=${before}`);
      expect(response.status).toBe(200);
      const answer = (await response.json()) as HistoryAnswer;
      answers.push(answer);
      collected.unshift(...answer.entries.map((entry) => entry.id));
      if (!answer.hasMore) break;
      before = answer.entries[0]!.id;
    }

    // Every entry stored before the active context is covered once, in order, and
    // the last answer says so.
    expect(collected).toEqual(stored);
    expect(answers.at(-1)?.hasMore).toBe(false);
    expect(answers[0]?.hasMore).toBe(true);
    expect(answers[0]?.apiVersion).toBe(1);

    // A press brings one session, and its first entry is the session restart that
    // opened it: that entry is the `new session` line drawn above the session's
    // conversation. The rest of the block runs in id order.
    expect(answers[0]?.entries[0]).toMatchObject({ id: ids[1], kind: "pi.reset" });
    expect(answers[0]?.entries.map((entry) => entry.id)).toEqual([ids[1], ids[2], ids[3]]);
    // The first session has no restart to open it, so the conversation's first entry
    // is where the walk stopped, and nothing is left before it.
    expect(answers[1]?.entries.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(answers[1]?.hasMore).toBe(false);
    expect(answers).toHaveLength(2);
    for (const answer of answers) {
      const ordered = answer.entries.map((entry) => entry.id);
      expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    }

    // The model's context is untouched: the store holds exactly what it held.
    const after = await allEntries(harness!, conversationId);
    expect(after.map((entry) => entry.id)).toEqual(everything.map((entry) => entry.id));
  }, 30_000);

  it("answers the same block under a size cap, newest first, and the press goes on where it stopped", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const { conversationId, ids } = await threeSessions(harness!);
    const everything = await allEntries(harness!, conversationId);

    // A cap far under 4 MB: the session that ends before the newest restart is
    // answered in as many pieces as it takes, and not one entry is lost or doubled.
    const stored = await conversationOf(harness!, conversationId);
    const seen: number[] = [];
    let before = ids[4]!;
    for (let press = 0; press < 20; press += 1) {
      const block = await cutSessionBlock(stored, before as EntryId, 1);
      expect(block.entries.length).toBeGreaterThan(0);
      seen.unshift(...block.entries.map((entry) => entry.id as number));
      if (!block.hasMore) break;
      before = block.entries[0]!.id as unknown as number;
    }
    expect(seen).toEqual(everything.map((entry) => entry.id as number).filter((id) => id < ids[4]!));

    // Under a cap, the answer starts at a single entry and not at a restart, and
    // `hasMore` says the rest is still there.
    const capped = await cutSessionBlock(stored, ids[4]! as EntryId, 1);
    expect(capped.entries).toHaveLength(1);
    expect(capped.entries[0]?.kind).not.toBe("pi.reset");
    expect(capped.hasMore).toBe(true);
    void origin;
  }, 30_000);

  it("refuses a request with no `before`, and answers nothing for a conversation it does not know", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const { conversationId } = await threeSessions(harness!);

    for (const path of [
      `/basic-chat/history`,
      `/api/conversations/${conversationId}/history`,
      `/basic-chat/history?before=`,
      `/basic-chat/history?before=abc`,
      `/basic-chat/history?before=0`,
      `/basic-chat/history?before=-3`,
      `/api/conversations/${conversationId}/history?before=1.5`,
    ]) {
      const response = await read(origin, path);
      expect(response.status, path).toBe(400);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("invalid_request");
    }

    const missing = await read(origin, `/api/conversations/987654/history?before=10`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error?: { code?: string } }).error?.code).toBe("not_found");
  }, 30_000);

  it("answers an empty block when nothing is stored before the place the page names", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const { conversationId, ids } = await threeSessions(harness!);
    const response = await read(origin, `/api/conversations/${conversationId}/history?before=${ids[0]}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: [], hasMore: false, apiVersion: 1 });
  }, 30_000);

  it("answers the root conversation and a focused chat through their own routes, and both write nothing", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const test = harness!;
    const { conversationId, ids } = await threeSessions(test);

    const before = await allEntries(test, conversationId);
    const viaChat = (await (
      await read(origin, `/api/conversations/${conversationId}/history?before=${ids[4]}`)
    ).json()) as HistoryAnswer;
    // The root's own route answers the same question for the root conversation.
    const viaRoot = (await (await read(origin, `/basic-chat/history?before=${ids[4]}`)).json()) as HistoryAnswer;
    expect(viaRoot).toEqual(viaChat);

    // Read-only: the store holds the same entries, with the same content.
    const after = await allEntries(test, conversationId);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.length).toBe(before.length);

    // A focused chat has the same route, and the answer is that chat's sessions.
    const chat = await openChat(test, "history routes");
    const chatId = chat.conversationId;
    const chatIds: number[] = [];
    for (const entry of [operatorMessage("chat first"), restart("chat handoff"), operatorMessage("chat second")]) {
      chatIds.push(await append(test, chatId, entry));
    }
    const chatAnswer = (await (
      await read(origin, `/api/conversations/${chatId}/history?before=${chatIds[2]}`)
    ).json()) as HistoryAnswer;
    expect(chatAnswer.entries.map((entry) => entry.id)).toEqual([chatIds[1]]);
    expect(chatAnswer.entries[0]).toMatchObject({ kind: "pi.reset" });
    expect(chatAnswer.hasMore).toBe(true);
    // The press after it reaches the chat's first session and takes the button away.
    const chatFirst = (await (
      await read(origin, `/api/conversations/${chatId}/history?before=${chatIds[1]}`)
    ).json()) as HistoryAnswer;
    expect(chatFirst.entries.map((entry) => entry.id)).toEqual([chatIds[0]]);
    expect(chatFirst.hasMore).toBe(false);
  }, 30_000);

  it("carries the attachment descriptors of the entries it answers", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const test = harness!;
    // A stored file a loaded message names, so the block carries the descriptor the
    // page needs to draw a picture as a picture.
    const record = await createAttachment(
      { storage: test.runtime.storage, harness: test.runtime.harness },
      { kind: "attachment", name: "chart.png", mime: "image/png", data: pngBytes(64, 48) },
    );
    const chat = await openChat(test, "history attachments");
    const chatId = chat.conversationId;
    const namedFile = await append(test, chatId, {
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: `<pi-message src="operator" attachments="${record.id}">\nlook at this\n</pi-message>`,
          timestamp: Date.now(),
        },
      ],
    });
    // A message that names an id the store does not hold draws as a chip: the answer
    // must not fail over it, and its id is left out of the map.
    const dangling = await append(test, chatId, {
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: `<pi-message src="operator" attachments="missing-one">\nand this\n</pi-message>`,
          timestamp: Date.now(),
        },
      ],
    });
    const restarted = await append(test, chatId, restart("a newer session"));

    const answer = (await (
      await read(origin, `/api/conversations/${chatId}/history?before=${restarted}`)
    ).json()) as HistoryAnswer;
    expect(answer.entries.map((entry) => entry.id)).toEqual([namedFile, dangling]);
    expect(answer.attachments[record.id]).toMatchObject({
      name: "chart.png",
      mime: "image/png",
      bytes: pngBytes(64, 48).byteLength,
    });
    expect(Object.keys(answer.attachments)).toEqual([record.id]);
    expect(answer.hasMore).toBe(false);
  }, 30_000);

  it("says on the snapshot whether anything is stored before the context it draws", { timeout: 30_000 }, async () => {
    const origin = await boot();
    const test = harness!;
    const { ids } = await threeSessions(test);
    // A page that attaches now gets the active context, which starts at the
    // newest restart, and the session before it is stored.
    const frame = await firstSnapshot(origin, `/basic-chat/events`);
    expect(frame.hasEarlier).toBe(true);
    expect((frame.entries as { id: number }[]).map((entry) => entry.id)).not.toContain(ids[0]);

    // With no restart anywhere, the context is the whole conversation and nothing
    // is stored before it.
    const chat = await openChat(test, "one session only");
    await append(test, chat.conversationId, operatorMessage("the only session"));
    const single = await firstSnapshot(origin, `/api/conversations/${chat.conversationId}/events`);
    expect(single.hasEarlier).toBe(false);
    expect((single.entries as unknown[]).length).toBeGreaterThan(0);
  }, 30_000);

  it("keeps the size cap at 4 MB and answers at least one entry under any cap", () => {
    // The cap is a constant the route reads and the cut takes as an argument, so a
    // test can hold the rule at a size it can build.
    expect(HISTORY_MAX_BYTES).toBe(4 * 1024 * 1024);
    const url = new URL("http://localhost/basic-chat/history?before=42");
    expect(readBeforeParam(url)).toBe(42);
    expect(readBeforeParam(new URL("http://localhost/basic-chat/history?before=4e2"))).toBeUndefined();
    expect(readBeforeParam(new URL("http://localhost/basic-chat/history"))).toBeUndefined();
  });

  it("asks the store whether one entry exists before a place", { timeout: 30_000 }, async () => {
    const { ids } = await threeSessions(harness = await focusedHarness({}));
    const conversation = await conversationOf(harness, ROOT_CONVERSATION_ID as unknown as number);
    expect(await hasEntriesBefore(conversation, ids[1]! as unknown as EntryId)).toBe(true);
    expect(await hasEntriesBefore(conversation, ids[0]! as unknown as EntryId)).toBe(false);
    expect(await hasEntriesBefore(conversation, 1 as EntryId)).toBe(false);
  }, 30_000);
});

/** The first `snapshot` frame one stream sends. */
async function firstSnapshot(origin: string, path: string): Promise<{ entries: unknown; hasEarlier?: boolean }> {
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}${path}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 20_000;
    for (;;) {
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const lines = block.split("\n");
        if (lines.includes("event: snapshot")) {
          const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          return JSON.parse(data) as { entries: unknown; hasEarlier?: boolean };
        }
        at = buffer.indexOf("\n\n");
      }
      if (Date.now() > deadline) throw new Error(`no snapshot frame on ${path}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before its snapshot on ${path}`);
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}
