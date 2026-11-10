/**
 * Which conversation this page shows, what it is called, and whether it can be
 * written to.
 *
 * The chat number comes from `?chat=<id>` once, at load, and every route the page
 * uses is chosen from it. That is the whole safety of the page: a focused chat's
 * route set does not hold the root's paths, so no control on the page can send a
 * message, a reset or a compaction to the root while it shows a focused chat.
 *
 * The record the server answers (`GET /api/focused-chats/:id`) is applied here and
 * nowhere else, whether it came from the read route, from a rename's answer, or
 * from a `focused_chat_updated` frame. Those three disagree about how the archive
 * is spelled (a flag on the read route, a time on the event), and one place reads
 * both.
 */
import { computed, signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { installName, mount } from "../mount.ts";
import type { ChatState, ConversationRoutes, FocusedChatRecord } from "../../shared/wire/conversation.ts";
import { checkTitle } from "./chat-title.ts";
import { showError } from "./toast.ts";

/** The chat number in the address, or `null` for the root conversation. */
export function readChatId(search: string): number | null {
  const raw = new URLSearchParams(search).get("chat");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Every chat route this page uses, chosen once from the chat number. */
export function chatRoutes(id: number | null): ConversationRoutes {
  if (id === null) {
    return {
      focused: false,
      info: null,
      events: "/basic-chat/events",
      context: "/basic-chat/context",
      history: "/basic-chat/history",
      messages: "/basic-chat/messages",
      abort: "/basic-chat/abort",
      reset: "/basic-chat/reset",
      compact: "/basic-chat/compact",
    };
  }
  const conversation = `/api/conversations/${id}`;
  return {
    focused: true,
    info: `/api/focused-chats/${id}`,
    events: `${conversation}/events`,
    context: `${conversation}/context`,
    history: `${conversation}/history`,
    messages: `${conversation}/messages`,
    abort: `${conversation}/abort`,
    reset: `${conversation}/reset`,
    compact: `${conversation}/compact`,
  };
}

/** The chat this page shows, read once at load. */
export const chatId = typeof window === "undefined" ? null : readChatId(window.location.search);

/** The route set of this page, fixed once from the chat number. */
export const routes: ConversationRoutes = chatRoutes(chatId);

/** The personality's name, read once: it is what the root conversation is called. */
export const rootName = installName() || "pi-sec";

/** The chat the top bar names. */
export const chat = signal<ChatState>({ root: chatId === null, title: null, archived: false, missing: false, unreadable: false });

/** What the top bar shows: the install's name, the chat's title, or a refusal. */
export const chatName = computed<string>(() => {
  const current = chat.value;
  if (current.root) return rootName;
  // A number the server does not know has no name to show; the bar says so rather
  // than inventing the "Untitled" a real chat without a title shows.
  if (current.missing) return "Chat not found";
  if (current.unreadable) return "Chat could not be read";
  return typeof current.title === "string" && current.title !== "" ? current.title : "Untitled";
});

/** Why the composer is not there, or `null` when this chat can be written to. */
export const chatBlocked = computed<"missing" | "unreadable" | "archived" | null>(() => {
  const current = chat.value;
  if (current.missing) return "missing";
  if (current.unreadable) return "unreadable";
  if (current.archived) return "archived";
  return null;
});

/** The list the notice points at, which is the way out of a chat that cannot be written. */
export function chatsHref(): string {
  return `${mount().base}/chats`;
}

/** The address of one focused chat. The number is the whole of which chat is meant. */
export function chatHref(id: number): string {
  return `${mount().base}/basic-chat?chat=${Number(id)}`;
}

/** Point the page at one chat record, from whichever of the three sources sent it. */
export function applyChatRecord(record: FocusedChatRecord | null | undefined): void {
  chat.value = {
    root: false,
    title: typeof record?.title === "string" && record.title !== "" ? record.title : null,
    archived: record?.archived === true || (record?.archivedAt !== null && record?.archivedAt !== undefined),
    missing: false,
    unreadable: false,
  };
}

/**
 * Draw the state a chat page shows when its record is gone.
 *
 * Written once, so the first read and a re-read after a reconnect draw exactly the
 * same thing.
 */
export function markChatMissing(): void {
  chat.value = { ...chat.value, archived: false, missing: true, unreadable: false };
}

/**
 * Draw the state a chat page shows when its record could not be read for a reason
 * other than a 404. The chat may exist, so the page does not say it is gone: the
 * reader reloads the page to try again.
 */
export function markChatUnreadable(): void {
  chat.value = { ...chat.value, archived: false, missing: false, unreadable: true };
}

/**
 * Read this page's chat record, and point the page at it.
 *
 * A 404 is the notice the page draws for a chat number it cannot show, so it is
 * reported as `"missing"` and not as a failure. Any other failure is thrown to the
 * caller, which decides whether the page can go on: `openChat` shows the server's
 * own words and opens no stream.
 */
export async function readChatRecord(): Promise<"ok" | "missing"> {
  if (routes.info === null) return "ok";
  try {
    applyChatRecord(await request<FocusedChatRecord>(routes.info));
    return "ok";
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      markChatMissing();
      return "missing";
    }
    throw error;
  }
}

/**
 * Ask for a new title and send it.
 *
 * The two refusals the server makes are made here first: an empty title and one
 * over the limit are one sentence each, and a round trip to be told the same is
 * worse than saying it.
 */
export async function renameChat(): Promise<void> {
  const current = chat.value;
  if (current.root || current.archived || current.missing || current.unreadable) return;
  if (routes.info === null) return;
  const answer = typeof window === "undefined" ? null : window.prompt("New title (1 to 80 characters)", current.title ?? "");
  if (answer === null) return;
  const checked = checkTitle(answer);
  if ("refusal" in checked) {
    showError(checked.refusal);
    return;
  }
  const { title } = checked;
  try {
    applyChatRecord(await request<FocusedChatRecord>(routes.info, { method: "PATCH", body: JSON.stringify({ title }) }));
  } catch (error) {
    if (error instanceof ApiError && error.code === "chat_archived") {
      // Archived while this page was open. The refusal is the newest fact about
      // the chat, so the screen follows it.
      chat.value = { ...chat.value, archived: true };
      showError("This chat is archived, so its title can no longer change.");
      return;
    }
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** The chat's name as a confirmation sentence says it. */
export function quotedChatName(): string {
  return `"${chatName.value}"`;
}
