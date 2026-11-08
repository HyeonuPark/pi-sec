/**
 * The chat list page's state and the work behind its presses.
 *
 * The page is one list of chats in two halves: the open ones, which the server
 * sends whole, and the archived ones, which the server pages. Everything a press
 * can change lives here, so the components draw what the signals hold and never
 * read the server themselves.
 *
 * The rules are the ones the hand-written chats page followed (removed in this
 * commit), written as signals:
 *
 * - One read or write at a time, so a fast press cannot interleave two pages of
 *   the archived list. A change the stream reports while something is in flight
 *   is answered by one read after it, so a burst costs one read per burst.
 * - A list that comes back from the server is matched to the list on screen by
 *   conversation id, so a row that did not change keeps its object and the
 *   element under it. That is what keeps a reader's focus and caret in place.
 * - The search term is the key of a read of the archived list, and it is the term
 *   that was submitted, not what is being typed. What is typed belongs to the
 *   field and is never written by this module.
 *
 * `fetch` is reached through `src/ui/api/request.ts`, and timers are not used
 * here: every wait in this page is the stream client's.
 */
import { signal } from "@preact/signals";
import type { ChatsListAnswer, ChatsListItem, FocusedChatFrame, NewChatAnswer } from "../../shared/wire/chats.ts";
import { ApiError, request } from "../api/request.ts";
import { at } from "../mount.ts";
import { reconcileById } from "./keyed.ts";
import { showError } from "./toast.ts";

/** The longest title the server takes. The page refuses a longer one first. */
export const TITLE_MAX = 80;

/** The open chats, test ones included, as `GET /api/focused-chats?state=active` answers. */
export const activeChats = signal<readonly ChatsListItem[]>([]);

/** The archived rows read so far, oldest read last. */
export const archivedChats = signal<readonly ChatsListItem[]>([]);

/** The search term the archived list was read with, and is read with again. */
export const archivedTerm = signal("");

/** Where the next archived page starts, or `undefined` at the end of the list. */
export const archivedNext = signal<string | undefined>(undefined);

/** How many pages of the archived list are held, so a re-read keeps them all. */
export const archivedPages = signal(0);

/**
 * Whether the `Test` section is open. It starts closed on every page load, and it
 * is kept here rather than in the browser: a reader who opened the section keeps
 * it open through a stream refresh, a `↻ reload` and a rename, and the next load
 * starts closed again.
 */
export const testSectionOpen = signal(false);

/** Whether a new chat is being asked for, so its button waits disabled. */
export const creatingChat = signal(false);

/** One read or write at a time. */
let busy = false;

/** A change the stream reported while a read or a write was in flight. */
let queued = false;

/** The list key: the number the server gave a chat is the whole of which chat it is. */
function keyOf(item: ChatsListItem): string {
  return String(item.conversationId);
}

/** The address of one chat: the number is the whole of which chat is meant. */
export function chatHref(id: number): string {
  return at(`/basic-chat?chat=${Number(id)}`);
}

/** The message of a failure, which a notice shows as it is. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------- reads */

/** The open chats, test ones included. */
async function readActive(): Promise<readonly ChatsListItem[]> {
  const data = await request<ChatsListAnswer>("/api/focused-chats?state=active");
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * One page of the archived list: the first page with no cursor, and any later
 * page from the cursor the page before it left behind.
 */
async function readArchivedPage(cursor: string | undefined): Promise<{
  readonly items: readonly ChatsListItem[];
  readonly next: string | undefined;
}> {
  const query = new URLSearchParams({ state: "archived" });
  if (archivedTerm.value !== "") query.set("q", archivedTerm.value);
  if (cursor !== undefined) query.set("cursor", cursor);
  const data = await request<ChatsListAnswer>(`/api/focused-chats?${query.toString()}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  // `next` absent is the end of the list. A cursor the server cannot use would
  // read the same page for ever, so only a non-empty string is kept.
  const next = typeof data?.next === "string" && data.next !== "" ? data.next : undefined;
  return { items, next };
}

/** Read `count` pages of the archived list, from `cursor` on, following `next`. */
async function readArchived(
  cursor: string | undefined,
  count: number,
): Promise<{ readonly items: readonly ChatsListItem[]; readonly next: string | undefined; readonly read: number }> {
  let items: readonly ChatsListItem[] = [];
  let next = cursor;
  let read = 0;
  while (read < count) {
    const page = await readArchivedPage(next);
    items = items.concat(page.items);
    read += 1;
    next = page.next;
    if (next === undefined) break;
  }
  return { items, next, read };
}

/**
 * Read the archived list again from its first page, as deep as it was already
 * read: a reader who loaded three pages keeps three pages. A new search term
 * starts at one page, because the term names a different list.
 */
async function reloadArchived(): Promise<void> {
  const page = await readArchived(undefined, Math.max(1, archivedPages.value));
  archivedChats.value = reconcileById(archivedChats.value, page.items, keyOf);
  archivedNext.value = page.next;
  archivedPages.value = page.read;
}

/** Add the page after the rows already read, on the term they were read with. */
async function loadMoreArchived(): Promise<void> {
  const cursor = archivedNext.value;
  if (cursor === undefined) return;
  const page = await readArchived(cursor, 1);
  archivedChats.value = reconcileById(archivedChats.value, [...archivedChats.value, ...page.items], keyOf);
  archivedNext.value = page.next;
  archivedPages.value += page.read;
}

/** Read both lists. */
export async function reload(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    activeChats.value = reconcileById(activeChats.value, await readActive(), keyOf);
    await reloadArchived();
  } catch (error) {
    showError(`Could not load the chats: ${messageOf(error)}`);
  } finally {
    busy = false;
    // Both lists were just read in full, so a change the stream reported while
    // this ran is already in what was drawn.
    queued = false;
  }
}

/** Read and add the page after the archived rows on screen. */
export async function loadMore(): Promise<void> {
  if (busy || archivedNext.value === undefined) return;
  busy = true;
  try {
    await loadMoreArchived();
  } catch (error) {
    showError(`Could not load more chats: ${messageOf(error)}`);
  } finally {
    busy = false;
  }
}

/**
 * Search the archived titles. The term is read when the form is submitted, not on
 * every keystroke: the term is the key of a read, and half a word is a read of
 * half the list. The same term is the same list, and a new one starts at the
 * first page.
 */
export async function searchArchived(term: string): Promise<void> {
  if (term === archivedTerm.value) return;
  archivedTerm.value = term;
  archivedNext.value = undefined;
  archivedPages.value = 0;
  await reload();
}

/* ------------------------------------------------------------------ writes */

/** The page's window surface: how a chat's address is built, and how one is opened. */
export interface ChatsBridge {
  /** The address of one chat, under the mount this page is served from. */
  chatHref(id: number): string;
  /** Go to a chat. A test replaces this, because jsdom does not navigate. */
  openChat(href: string): void;
}

let bridge: ChatsBridge | undefined;

/**
 * Install the bridge on `window`, as the hand-written page did with
 * `window.piSecChats`.
 *
 * It is one object rather than two functions so a test can say where a press
 * would have gone: the page calls the bridge, not `location.assign`, so replacing
 * `openChat` on the installed object replaces the press's last step.
 */
export function installChatsBridge(): ChatsBridge {
  bridge ??= {
    chatHref,
    openChat(href: string): void {
      window.location.assign(href);
    },
  };
  (window as unknown as { piSecChats?: ChatsBridge }).piSecChats = bridge;
  return bridge;
}

/** The installed bridge. It is installed by the page entry before anything is drawn. */
export function chatsBridge(): ChatsBridge {
  return bridge ?? installChatsBridge();
}

/**
 * Open a chat with no title and go to it: the chat's agent names it after the
 * first message.
 */
export async function newChat(): Promise<void> {
  if (busy) return;
  busy = true;
  creatingChat.value = true;
  try {
    const created = await request<NewChatAnswer>("/api/focused-chats", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const id = Number(created?.conversationId);
    if (!Number.isInteger(id)) throw new Error("the server did not name the new chat");
    const surface = chatsBridge();
    surface.openChat(surface.chatHref(id));
    return;
  } catch (error) {
    showError(`Could not open a chat: ${messageOf(error)}`);
  } finally {
    busy = false;
    creatingChat.value = false;
  }
}

/**
 * Ask for a new title and send it. The two refusals the server makes are made
 * here first: an empty title and one over the limit are one sentence each, and a
 * round trip to be told the same is worse than saying it.
 *
 * A `chat_archived` refusal means the chat left this list between the read and
 * the press, so both lists are read again rather than patched up here.
 */
export async function renameChat(id: number): Promise<void> {
  if (busy) return;
  const item = activeChats.value.find((each) => Number(each.conversationId) === id);
  const answer = window.prompt("New title (1 to 80 characters)", item === undefined ? "" : (item.title ?? ""));
  if (answer === null) return;
  const title = answer.trim();
  if (title === "") {
    showError("A title cannot be empty.");
    return;
  }
  if (title.length > TITLE_MAX) {
    showError(`A title holds at most ${TITLE_MAX} characters.`);
    return;
  }
  busy = true;
  try {
    await request(`/api/focused-chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  } catch (error) {
    if (error instanceof ApiError && error.code === "chat_archived") {
      showError("This chat is archived, so its title can no longer change.");
      busy = false;
      await reload();
      return;
    }
    busy = false;
    showError(`Could not rename the chat: ${messageOf(error)}`);
    return;
  }
  busy = false;
  await reload();
}

/* ------------------------------------------------------------------ stream */

/**
 * Read the lists again because the event stream said a chat changed.
 *
 * Which list a change can touch is the event's own answer: `opened` and `titled`
 * touch an open chat, and `archived` and `deleted` move a row between the lists
 * or out of both. Without a change the event was not the one this page reads, so
 * both lists are read.
 */
export async function refreshFromStream(change?: string): Promise<void> {
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  try {
    activeChats.value = reconcileById(activeChats.value, await readActive(), keyOf);
    if (change !== "opened" && change !== "titled") await reloadArchived();
  } catch (error) {
    showError(`Could not load the chats: ${messageOf(error)}`);
  } finally {
    busy = false;
  }
  if (queued) {
    queued = false;
    await refreshFromStream();
  }
}

/** The change a `focused_chat_updated` frame names, or `undefined` when it names none. */
export function changeOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const change = (data as FocusedChatFrame).change;
  return typeof change === "string" ? change : undefined;
}
