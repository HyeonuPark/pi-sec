/**
 * The chats page's tests share one fake server.
 *
 * Four test files drive the same page, so the chats behind it, the answers it
 * reads, and the presses a test makes are written once here. This file holds no
 * tests of its own: it is the fixture the `chats-*.test.ts` files import.
 *
 * `answerFrom` answers the way `src/server/routes/focused-chats.ts` does: one
 * page of the archived list per cursor, a `next` cursor while more pages exist,
 * `q` as the search term, and a patch that renames the row it names.
 */
import type { ChatsListItem } from "../../src/shared/wire/chats.ts";
import { loadUiPage, type FetchAnswer, type RecordedRequest, type UiPageHandle } from "./harness.ts";

/** When the chats in these tests were opened: four days before the page's clock. */
export const OPENED_AT = Date.UTC(2026, 9, 24, 3, 0, 0);

/**
 * The page's clock: four days after `OPENED_AT`. The rows say `opened 4d ago`
 * from this moment, whatever day the tests run on.
 */
export const PAGE_NOW = OPENED_AT + 4 * 24 * 60 * 60 * 1000;

/** An open chat. `test` and the row's other facts are left at their defaults. */
export function openChat(id: number, title: string | null, extra: Partial<ChatsListItem> = {}): ChatsListItem {
  return {
    conversationId: id,
    name: `focused-${id}`,
    title,
    openedAt: OPENED_AT,
    archived: false,
    archivedAt: null,
    test: false,
    running: false,
    ...extra,
  };
}

/** An archived chat, opened at the same time and archived a few seconds apart. */
export function archivedChat(id: number, title: string | null, extra: Partial<ChatsListItem> = {}): ChatsListItem {
  return openChat(id, title, { archived: true, archivedAt: OPENED_AT + id * 1000, ...extra });
}

/** One page of the archived list: its rows, and the cursor of the page after it. */
export interface ArchivedPage {
  items: ChatsListItem[];
  next?: string;
}

/** What the fake server holds, which a test can change between presses. */
export interface ChatsServer {
  active: ChatsListItem[];
  /** The archived pages, keyed by the cursor that asks for them; `""` is the first. */
  archived: Record<string, ArchivedPage>;
  /** What `POST /api/focused-chats` answers, instead of the default new chat. */
  post?: FetchAnswer;
  /** What `PATCH /api/focused-chats/:id` answers, instead of renaming the row. */
  patch?: FetchAnswer;
}

/** The answer one request gets, from the server's state. */
export function answerFrom(server: ChatsServer, base = ""): (request: RecordedRequest) => Promise<FetchAnswer> {
  return async (request) => {
    const url = new URL(request.url, "http://localhost");
    const path = base !== "" && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
    const notFound = { status: 404, body: { error: { code: "not_found", message: "no such route" } } } as const;
    if (path !== "/api/focused-chats" && !path.startsWith("/api/focused-chats/")) return notFound;

    // One chat: the page only ever sends a new title to it.
    if (path !== "/api/focused-chats") {
      if (request.method !== "PATCH") return notFound;
      // A test may hold the answer, to see the page wait. A function answer is
      // awaited here, because the harness awaits this function and not one the
      // answer returns.
      if (server.patch !== undefined) return typeof server.patch === "function" ? await server.patch(request) : server.patch;
      const id = Number(path.split("/").at(-1));
      const body = JSON.parse(request.body ?? "{}") as { title?: string };
      const title = body.title ?? null;
      const at = server.active.findIndex((each) => each.conversationId === id);
      if (at !== -1) server.active[at] = { ...(server.active[at] as ChatsListItem), title };
      return { body: { ...openChat(id, title), archived: false, archivedAt: null } };
    }

    if (request.method === "POST") {
      if (server.post !== undefined) return typeof server.post === "function" ? await server.post(request) : server.post;
      return {
        status: 201,
        body: { conversationId: 42, name: "focused-42", title: null, openedAt: OPENED_AT, test: false },
      };
    }
    if (request.method !== "GET") return notFound;
    if (url.searchParams.get("state") === "active") return { body: { items: server.active } };
    const page = server.archived[url.searchParams.get("cursor") ?? ""] ?? { items: [] };
    return { body: page.next === undefined ? { items: page.items } : { items: page.items, next: page.next } };
  };
}

/** A loaded page, with the server it reads still in reach. */
export interface ChatsHandle extends UiPageHandle {
  readonly server: ChatsServer;
}

/**
 * Open the chats page with a fake server behind it.
 *
 * The list route and each open chat's own route are answered, because a rename
 * names one chat (`PATCH /api/focused-chats/:id`) and a route with no answer is
 * given an empty `200` by the harness, which a rename would read as success.
 */
export async function chatsPage(server: ChatsServer, options: { readonly base?: string } = {}): Promise<ChatsHandle> {
  const answer = answerFrom(server, options.base ?? "");
  const fetch: Record<string, FetchAnswer> = { "/api/focused-chats": answer };
  for (const item of server.active) fetch[`/api/focused-chats/${item.conversationId}`] = answer;
  const page = await loadUiPage("chats", {
    ...(options.base === undefined ? {} : { base: options.base }),
    now: PAGE_NOW,
    fetch,
  });
  return Object.assign(page, { server });
}

/** The rows of the three sections, in the order they are drawn. */
export function rows(page: UiPageHandle): HTMLElement[] {
  return [...page.document.querySelectorAll<HTMLElement>("#view .chat-row")];
}

/** The rows under the `Test` heading, drawn or not. */
export function testRows(page: UiPageHandle): HTMLElement[] {
  return [...page.document.querySelectorAll<HTMLElement>("#test-rows .chat-row")];
}

/** The `Test` section's heading, which is the press that opens and closes it. */
export function testToggle(page: UiPageHandle): HTMLElement {
  const toggle = page.document.getElementById("test-toggle");
  if (toggle === null) throw new Error("the chats page draws no Test heading");
  return toggle;
}

/** The requests the page made to the archived list, in order. */
export function archivedReads(page: UiPageHandle): RecordedRequest[] {
  return page.fetchCalls.filter(
    (each) => each.method === "GET" && new URL(each.url, "http://localhost").searchParams.get("state") === "archived",
  );
}

/** The requests the page made to the open list, in order. */
export function activeReads(page: UiPageHandle): RecordedRequest[] {
  return page.fetchCalls.filter(
    (each) => each.method === "GET" && new URL(each.url, "http://localhost").searchParams.get("state") === "active",
  );
}

/** Press one element the way a reader's click arrives. */
export function click(page: UiPageHandle, element: Element): void {
  element.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Type a term into the archived search and submit the form. */
export function search(page: UiPageHandle, term: string): void {
  const field = page.document.getElementById("archive-q") as HTMLInputElement | null;
  if (field === null) throw new Error("the chats page draws no search field");
  field.value = term;
  page.document
    .getElementById("archive-search")
    ?.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
}

/** The text of the page's notice, which is where a refusal is said. */
export function notice(page: UiPageHandle): string {
  return page.document.getElementById("toast")?.textContent ?? "";
}
