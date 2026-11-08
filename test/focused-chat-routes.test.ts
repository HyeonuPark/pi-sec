import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { entryAttachmentIds } from "../src/server/routes/basic-chat.ts";
import { archiveFocusedChat, deleteFocusedChat, setFocusedChatTitle } from "../src/focused/service.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import { bootServer, conversationOf, depsOf, focusedHarness, openChat, type BootedServer } from "./focused-helpers.ts";
import type { TestHarness } from "./helpers.ts";

/**
 * The focused chat routes, over a real HTTP server.
 *
 * Four routes serve the page: open, list, read one, rename. Archiving and
 * deleting have no route at all, so they are called here the way the root's tools
 * call them, which is also the way a test reaches the 409 and 404 answers below.
 */

const CTX = BACKGROUND_CONTEXT;

interface Item {
  readonly conversationId: number;
  readonly name: string;
  readonly title: string | null;
  readonly openedAt: number;
  readonly archivedAt: number | null;
  readonly running: boolean;
  readonly test: boolean;
}

interface Created {
  readonly conversationId: number;
  readonly name: string;
  readonly title: string | null;
  readonly openedAt: number;
  readonly test: boolean;
}

describe("focused chat routes", () => {
  let harness: TestHarness | undefined;
  let booted: BootedServer | undefined;

  afterEach(async () => {
    await booted?.started.close();
    booted = undefined;
    await harness?.close();
    harness = undefined;
  });

  async function boot(options: Parameters<typeof focusedHarness>[0] = {}): Promise<string> {
    harness = await focusedHarness({
      ...options,
      config: {
        ...(options.config ?? {}),
        server: { ...defaultConfig().server, port: 0 },
      },
    });
    booted = await bootServer(harness);
    return booted.origin;
  }

  function post(origin: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function patch(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** An approved report whose text names one conversation, through the public routes. */
  async function approvedReport(origin: string, conversationId: number): Promise<string> {
    const job = await harness!.runtime.jobs.create(CTX, { title: "chat test" });
    const created = await post(origin, "/api/reports", {
      jobId: job.id,
      title: "Chat test",
      content: `The test chat is conversation ${conversationId}.\n`,
    });
    expect(created.status).toBe(201);
    const report = (await created.json()) as { id: string };
    const approved = await post(origin, `/api/reports/${report.id}/approve`, { version: 1, via: "panel" });
    expect(approved.status).toBe(201);
    return report.id;
  }

  it("opens a chat and answers for it", async () => {
    const origin = await boot();
    const created = await post(origin, "/api/focused-chats", { title: "  Plan the trip  " });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Created;
    expect(body.name).toBe("focused-1");
    expect(body.title).toBe("Plan the trip");
    expect(body.openedAt).toBeGreaterThan(0);
    expect(body.test).toBe(false);

    const one = await fetch(`${origin}/api/focused-chats/${body.conversationId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({
      conversationId: body.conversationId,
      name: "focused-1",
      title: "Plan the trip",
      openedAt: body.openedAt,
      archived: false,
      archivedAt: null,
      test: false,
    });

    // No title is the page's "New chat" button.
    const untitled = await post(origin, "/api/focused-chats");
    expect(untitled.status).toBe(201);
    expect(((await untitled.json()) as { title: string | null }).title).toBeNull();

    // A title that is not one is refused, and nothing is created.
    for (const title of ["", "x".repeat(81), 5]) {
      expect((await post(origin, "/api/focused-chats", { title })).status).toBe(400);
    }
    expect(harness!.runtime.focusedChats.listActive()).toHaveLength(2);
  });

  it("marks a chat as a test only when the body says so, and answers the mark", async () => {
    const origin = await boot();

    // `true` is a test chat; `false`, an absent key and no body are all normal
    // chats, which is what the page's New chat button sends.
    const marked = await post(origin, "/api/focused-chats", { test: true });
    expect(marked.status).toBe(201);
    const testChat = (await marked.json()) as Created;
    expect(testChat.test).toBe(true);

    const explicitFalse = await post(origin, "/api/focused-chats", { test: false });
    expect(explicitFalse.status).toBe(201);
    const explicitFalseChat = (await explicitFalse.json()) as Created;
    expect(explicitFalseChat.test).toBe(false);

    const absent = await post(origin, "/api/focused-chats", { title: "a title" });
    expect(absent.status).toBe(201);
    const absentChat = (await absent.json()) as Created;
    expect(absentChat.test).toBe(false);

    const noBody = await post(origin, "/api/focused-chats");
    expect(noBody.status).toBe(201);
    const noBodyChat = (await noBody.json()) as Created;
    expect(noBodyChat.test).toBe(false);

    // The read routes carry it: one chat, the open list, and the archive.
    const one = (await (await fetch(`${origin}/api/focused-chats/${testChat.conversationId}`)).json()) as {
      test: boolean;
    };
    expect(one.test).toBe(true);

    const activeBody = await fetch(`${origin}/api/focused-chats?state=active`);
    const active = ((await activeBody.json()) as { items: Item[] }).items;
    expect(active.map((item) => [item.conversationId, item.test])).toEqual([
      [noBodyChat.conversationId, false],
      [absentChat.conversationId, false],
      [explicitFalseChat.conversationId, false],
      [testChat.conversationId, true],
    ]);

    await archiveFocusedChat(depsOf(harness!), testChat.conversationId, CTX);
    const archivedBody = await fetch(`${origin}/api/focused-chats?state=archived`);
    const archived = ((await archivedBody.json()) as { items: Item[] }).items;
    expect(archived.map((item) => [item.conversationId, item.test])).toEqual([[testChat.conversationId, true]]);

    // Any other value is refused rather than read as "not a test".
    for (const test of ["true", "false", 1, 0, null, {}, []]) {
      const refused = await post(origin, "/api/focused-chats", { test });
      expect(refused.status).toBe(400);
      const error = (await refused.json()) as { error: { code: string; message: string } };
      expect(error.error.code).toBe("invalid_request");
      expect(error.error.message).toContain("true or false");
    }
    // Every refusal created nothing: the four chats opened above are all there is.
    expect(harness!.runtime.focusedChats.listActive()).toHaveLength(3);
  });

  it("answers 404 for the root and for a conversation that is not a focused chat", async () => {
    const origin = await boot();
    const root = await fetch(`${origin}/api/focused-chats/1`);
    expect(root.status).toBe(404);
    expect(((await root.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const other = await post(origin, "/api/conversations");
    const id = ((await other.json()) as { id: number }).id;
    const missing = await fetch(`${origin}/api/focused-chats/${id}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");

    expect((await fetch(`${origin}/api/focused-chats/not-a-number`)).status).toBe(400);
  });

  it("renames an open chat and refuses an archived one", async () => {
    const origin = await boot();
    const row = await openChat(harness!);

    const renamed = await patch(origin, `/api/focused-chats/${row.conversationId}`, { title: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { title: string }).title).toBe("Renamed");
    expect(harness!.runtime.focusedChats.get(row.conversationId)?.title).toBe("Renamed");

    // The body has to carry a title, and the title has to be one.
    expect((await patch(origin, `/api/focused-chats/${row.conversationId}`, {})).status).toBe(400);
    expect((await patch(origin, `/api/focused-chats/${row.conversationId}`, { title: "  " })).status).toBe(400);

    await archiveFocusedChat(depsOf(harness!), row.conversationId, CTX);
    const refused = await patch(origin, `/api/focused-chats/${row.conversationId}`, { title: "Later" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("chat_archived");
    expect(harness!.runtime.focusedChats.get(row.conversationId)?.title).toBe("Renamed");
  });

  it("lists the open chats newest first, with whether a run is going on", async () => {
    const origin = await boot();
    const first = await openChat(harness!, "one");
    const second = await openChat(harness!, "two");

    const response = await fetch(`${origin}/api/focused-chats?state=active`);
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: Item[] }).items;
    expect(items.map((item) => item.conversationId)).toEqual([second.conversationId, first.conversationId]);
    expect(items.every((item) => item.running === false)).toBe(true);
    expect(items.every((item) => item.archivedAt === null)).toBe(true);

    // `running` is the agent record's answer, and a fresh chat waits for a message.
    const record = await harness!.runtime.harness.snapshot(SecAgent, String(first.conversationId), CTX);
    expect(record?.status).toBe("waiting");

    const bad = await fetch(`${origin}/api/focused-chats?state=everything`);
    expect(bad.status).toBe(400);
  });

  it("pages the archived list, searches it, and refuses a bad cursor", async () => {
    const origin = await boot();
    // 25 chats archived in opening order, so the archive order is the reverse.
    for (let index = 1; index <= 25; index += 1) {
      const row = await openChat(harness!, index === 3 ? "50% discount" : `topic ${index}`);
      await archiveFocusedChat(depsOf(harness!), row.conversationId, CTX);
    }

    const first = await fetch(`${origin}/api/focused-chats?state=archived`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: Item[]; next?: string };
    expect(page.items).toHaveLength(20);
    expect(page.items[0]!.title).toBe("topic 25");
    expect(page.next).toBeDefined();
    expect(page.items.every((item) => item.archivedAt !== null)).toBe(true);

    const second = await fetch(`${origin}/api/focused-chats?state=archived&cursor=${encodeURIComponent(page.next!)}`);
    const rest = (await second.json()) as { items: Item[]; next?: string };
    expect(rest.items).toHaveLength(5);
    expect(rest.next).toBeUndefined();
    const seen = new Set([...page.items, ...rest.items].map((item) => item.conversationId));
    expect(seen.size).toBe(25);

    const searched = await fetch(`${origin}/api/focused-chats?state=archived&q=${encodeURIComponent("50%")}`);
    const found = (await searched.json()) as { items: Item[] };
    expect(found.items.map((item) => item.title)).toEqual(["50% discount"]);

    const badCursor = await fetch(`${origin}/api/focused-chats?state=archived&cursor=nonsense`);
    expect(badCursor.status).toBe(400);
  });

  it("answers 409 to writes and still answers reads for an archived chat", async () => {
    const origin = await boot();
    const row = await openChat(harness!, "archived chat");
    await archiveFocusedChat(depsOf(harness!), row.conversationId, CTX);

    const write = async (path: string, body?: unknown): Promise<Response> =>
      await post(origin, `/api/conversations/${row.conversationId}${path}`, body);

    for (const response of [
      await write("/messages", { content: "hello" }),
      await write("/abort"),
      await write("/reset"),
      await write("/compact"),
    ]) {
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("chat_archived");
    }

    // Reads still answer: the record of a finished chat is what the page shows.
    const one = await fetch(`${origin}/api/conversations/${row.conversationId}`);
    expect(one.status).toBe(200);
    const listed = (await one.json()) as { entries: unknown[] };
    expect(Array.isArray(listed.entries)).toBe(true);
    expect((await fetch(`${origin}/api/conversations/${row.conversationId}/tasks`)).status).toBe(200);
    expect((await fetch(`${origin}/api/conversations/${row.conversationId}/context`)).status).toBe(200);
    expect((await fetch(`${origin}/api/focused-chats/${row.conversationId}`)).status).toBe(200);

    const controller = new AbortController();
    const events = await fetch(`${origin}/api/conversations/${row.conversationId}/events`, {
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    controller.abort();
  });

  it("carries attachment ids on the conversation-scoped message route", async () => {
    const origin = await boot();
    const row = await openChat(harness!);
    const sent = await post(origin, `/api/conversations/${row.conversationId}/messages`, {
      content: "look at this",
      attachmentIds: ["01ATTACHMENT", "01ATTACHMENT", "01SECOND"],
    });
    expect(sent.status).toBe(202);

    const conversation = await conversationOf(harness!, row.conversationId);
    const page = await conversation.entries({ order: "ascending" }, 100, undefined, CTX);
    const ids = page.items.flatMap((entry) => entryAttachmentIds(entry));
    // In order, without repeats: the rule the root's own route uses.
    expect(ids).toEqual(["01ATTACHMENT", "01SECOND"]);

    // A body with no ids takes the path it took before they existed.
    const plain = await post(origin, `/api/conversations/${row.conversationId}/messages`, { content: "no files" });
    expect(plain.status).toBe(202);
  });

  it("answers the context route with the root route's shape", async () => {
    const origin = await boot();
    const row = await openChat(harness!);
    const response = await fetch(`${origin}/api/conversations/${row.conversationId}/context`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max", "reserveTokens", "used", "window"]);

    const root = await fetch(`${origin}/basic-chat/context`);
    const rootBody = (await root.json()) as Record<string, unknown>;
    expect(Object.keys(rootBody).sort()).toEqual(Object.keys(body).sort());

    expect((await fetch(`${origin}/api/conversations/not-a-number/context`)).status).toBe(400);
  });

  it("stops showing a deleted chat, and answers chat_deleted for it", async () => {
    const origin = await boot();
    const row = await openChat(harness!, "a test chat");
    const reportId = await approvedReport(origin, row.conversationId);

    await deleteFocusedChat(depsOf(harness!), { conversationId: row.conversationId, reportId }, CTX);

    const one = await fetch(`${origin}/api/focused-chats/${row.conversationId}`);
    expect(one.status).toBe(404);
    expect(((await one.json()) as { error: { code: string } }).error.code).toBe("chat_deleted");
    expect(((await (await fetch(`${origin}/api/focused-chats?state=active`)).json()) as { items: Item[] }).items).toEqual([]);
    expect(((await (await fetch(`${origin}/api/focused-chats?state=archived`)).json()) as { items: Item[] }).items).toEqual([]);

    const message = await post(origin, `/api/conversations/${row.conversationId}/messages`, { content: "hello" });
    expect(message.status).toBe(404);
    expect(((await message.json()) as { error: { code: string } }).error.code).toBe("chat_deleted");
    for (const path of ["/abort", "/reset", "/compact"]) {
      const response = await post(origin, `/api/conversations/${row.conversationId}${path}`, {});
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("chat_deleted");
    }
    expect((await fetch(`${origin}/api/conversations/${row.conversationId}/context`)).status).toBe(404);
  });

  it("serves no route that archives or deletes a chat", async () => {
    const origin = await boot();
    const row = await openChat(harness!);
    // A caller cannot end a chat the user is reading; only the root's tools can.
    expect((await post(origin, `/api/focused-chats/${row.conversationId}/archive`, {})).status).toBe(404);
    expect((await post(origin, `/api/focused-chats/${row.conversationId}/delete`, {})).status).toBe(404);
    expect(harness!.runtime.focusedChats.get(row.conversationId)?.archivedAt).toBeNull();
  });

  it("publishes a change event on a rename", async () => {
    const origin = await boot();
    const row = await openChat(harness!, "before");
    const seen: Record<string, unknown>[] = [];
    const off = harness!.events.subscribe((event) => {
      if (event.type === "focused_chat_updated") seen.push(event.data);
    });
    await setFocusedChatTitle(depsOf(harness!), row.conversationId, "after");
    off();
    expect(seen).toEqual([
      {
        conversationId: row.conversationId,
        name: row.name,
        title: "after",
        openedAt: row.openedAt,
        archivedAt: null,
        change: "titled",
      },
    ]);
    void origin;
  });
});
