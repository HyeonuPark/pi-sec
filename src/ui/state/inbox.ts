/**
 * The inbox: the notices the daemon leaves for the operator.
 *
 * One list, read from `GET /api/inbox?cleared=exclude` — the server leaves out
 * an item the operator cleared, unless a revert cell can still bring it back, so
 * the page never draws a row it would have to hide again. A section's title opens
 * the item and reads it (`POST /api/inbox/:id/read`); its own hide button clears
 * it, and one revert cell brings back the last ten hides.
 *
 * A report notice opens the report panel and a focused-chat notice opens that
 * chat; both openers belong to the panels this module does not draw, so they are
 * handed in with {@link setInboxOpeners}. Until one is handed in, a report notice
 * folds open in place and a chat notice navigates the page.
 *
 * The age on a row moves with the clock and no frame on the wire says so, so a
 * one-minute tick moves a clock signal instead of drawing the list again. A tab
 * nobody looks at pays nothing, and one tick runs the moment it is looked at, so
 * the value is right the first time it is read.
 */
import { signal } from "@preact/signals";
import type { InboxItem, InboxListResponse } from "../../shared/wire/inbox.ts";
import { request } from "../api/request.ts";
import { at } from "../mount.ts";
import {
  addToSet,
  clearedInbox,
  queueEntryIds,
  rememberHide,
  rememberHideGroup,
  removeFromSet,
  revertQueueInbox,
  savePreference,
  withId,
  withoutEntry,
  withoutId,
} from "./jobs.ts";
import { reconcileById } from "./keyed.ts";

/** The items the server answered with, newest first. */
export const inboxItems = signal<readonly InboxItem[]>([]);

/** Items opened in place. Session only: an unopened item folds back up on load. */
export const expandedInbox = signal<ReadonlySet<string>>(new Set());

/** The instant the ages are measured from. A tick moves it once a minute. */
export const inboxClock = signal<number>(Date.now());

/** How often the age text is measured again. */
export const INBOX_AGE_TICK_MS = 60_000;

/** "5m ago", "3h ago" — enough to place a note without asking for a tooltip. */
export function relativeTime(value: unknown, now: number = Date.now()): string {
  const seconds = Math.round((now - Number(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The items on screen: everything the server sent that was not cleared. */
export function visibleInboxItems(): readonly InboxItem[] {
  const cleared = clearedInbox.value;
  return inboxItems.value.filter((item) => !cleared.has(String(item.id)));
}

/**
 * How many items raise the badge. A notice about a report the operator set aside
 * does not count: the point of setting one aside is that it stops asking. A read
 * item does not count either.
 */
export function unreadCount(): number {
  return visibleInboxItems().filter((item) => item.readAt === undefined && item.pending !== true).length;
}

/** True when the item is a report notice, whose title opens the report panel. */
export function isReportItem(item: InboxItem): boolean {
  return typeof item.source?.reportId === "string" && item.source.reportId !== "";
}

/**
 * The focused chat a notice is about, as a number, or null. The server stores the
 * number as a string in `source.conversationId`.
 */
export function focusedChatOf(item: InboxItem): number | null {
  if (item.kind !== "focused_chat") return null;
  const id = Number(item.source?.conversationId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The name the mark carries: the shape says report or not, the name says which event. */
export function inboxMarkName(report: boolean, reportEvent: string | undefined, kind: string | undefined): string {
  if (!report) {
    if (kind === "archive") return "Archive sweep";
    if (kind === "async_call") return "Background task";
    if (kind === "focused_chat") return "Focused chat";
    return "Notification";
  }
  if (reportEvent === "published") return "Report published";
  if (reportEvent === "updated") return "Report updated";
  if (reportEvent === "answered") return "Report answered";
  return "Report";
}

/* ------------------------------------------------------------- the openers */

/** What a title press does when the item is about another panel. */
export interface InboxOpeners {
  /** Open a report in the panel. */
  openReport?: (reportId: string) => void;
  /** Open a focused chat's page. */
  openChat?: (chatId: number) => void;
}

let openers: InboxOpeners = {};

/** Hand in the openers the panels provide. A second call replaces them. */
export function setInboxOpeners(next: InboxOpeners): void {
  openers = { ...next };
}

/* --------------------------------------------------------------- the reads */

/** Read the inbox once and draw it. A failed read keeps the last list. */
export async function readInbox(): Promise<void> {
  try {
    const data = await request<InboxListResponse>("/api/inbox?cleared=exclude");
    inboxItems.value = reconcileById(inboxItems.value, data?.items ?? [], (item) => String(item.id));
  } catch {
    /* ignore: the last list stays on screen */
  }
}

/**
 * A frame that says the inbox may have changed: `inbox_item`, `report_created`,
 * `report_updated`. The frame names the change and not the list, so the list is
 * read back.
 */
export function applyInboxFrame(_type?: string): void {
  void readInbox();
}

/** Read the item and mark it read on the server and on the row. */
export async function markInboxRead(id: string): Promise<void> {
  try {
    await request(`/api/inbox/${encodeURIComponent(id)}/read`, { method: "POST" });
    const readAt = Date.now();
    inboxItems.value = inboxItems.value.map((item) => (item.id === id ? { ...item, readAt } : item));
  } catch {
    /* ignore: the row stays unread, which is the truth */
  }
}

/**
 * A press on a title. A report notice opens the panel; a focused-chat notice
 * opens that chat, read first because leaving the page drops what was not sent;
 * anything else folds open in place. Either way the item is read.
 */
export async function openInboxItem(id: string): Promise<void> {
  const item = inboxItems.value.find((entry) => entry.id === id);
  if (item === undefined) return;
  const chat = focusedChatOf(item);
  if (isReportItem(item)) {
    openers.openReport?.(String(item.source?.reportId));
  } else if (chat !== null) {
    if (item.readAt === undefined) await markInboxRead(id);
    if (openers.openChat !== undefined) openers.openChat(chat);
    else window.location.assign(at(`/basic-chat?chat=${chat}`));
    return;
  } else if (expandedInbox.value.has(id)) {
    expandedInbox.value = removeFromSet(expandedInbox.value, id);
  } else {
    expandedInbox.value = addToSet(expandedInbox.value, id);
  }
  if (item.readAt === undefined) await markInboxRead(id);
}

/** The hide button: the row leaves the list, and the queue remembers the hide. */
export function hideInboxItem(id: string): void {
  const key = String(id);
  clearedInbox.value = addToSet(clearedInbox.value, key);
  expandedInbox.value = removeFromSet(expandedInbox.value, key);
  revertQueueInbox.value = rememberHide(revertQueueInbox.value, key);
  savePreference(
    (current) => ({
      clearedInbox: withId(current.clearedInbox, key),
      revertQueueInbox: rememberHide(current.revertQueueInbox ?? [], key),
    }),
    "clearedInbox list",
  );
}

/**
 * Hide every item on screen, as one queue entry: one click, one undo. With
 * nothing on screen there is nothing to hide, and the click declines here as well
 * as by the disabled button.
 */
export function hideAllInbox(): void {
  const ids = visibleInboxItems().map((item) => String(item.id));
  if (ids.length === 0) return;
  let cleared = clearedInbox.value;
  let expanded = expandedInbox.value;
  for (const id of ids) {
    cleared = addToSet(cleared, id);
    expanded = removeFromSet(expanded, id);
  }
  clearedInbox.value = cleared;
  expandedInbox.value = expanded;
  revertQueueInbox.value = rememberHideGroup(revertQueueInbox.value, ids);
  savePreference(
    (current) => ({
      clearedInbox: ids.reduce<readonly string[]>((list, id) => withId(list, id), current.clearedInbox ?? []),
      revertQueueInbox: rememberHideGroup(current.revertQueueInbox ?? [], ids),
    }),
    "clearedInbox list",
  );
}

/** Bring back the newest cell of history: one hide, or one whole group. */
export function revertInbox(): void {
  const queue = revertQueueInbox.value;
  const undone = queue[queue.length - 1];
  if (undone === undefined) return;
  revertQueueInbox.value = queue.slice(0, -1);
  let cleared = clearedInbox.value;
  for (const id of queueEntryIds(undone)) cleared = removeFromSet(cleared, id);
  clearedInbox.value = cleared;
  const back = queueEntryIds(undone);
  savePreference(
    (current) => ({
      clearedInbox: back.reduce<readonly string[]>((list, id) => withoutId(list, id), current.clearedInbox ?? []),
      revertQueueInbox: withoutEntry(current.revertQueueInbox, undone),
    }),
    "clearedInbox list",
  );
}

/* --------------------------------------------------------------- the clock */

let ageTimer: ReturnType<typeof setInterval> | undefined;

/** Move the ages once, unless the tab is hidden. */
export function tickInboxAges(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  inboxClock.value = Date.now();
}

/** Start the one-minute age tick. A second call does nothing. */
export function startInboxAgeTimer(): void {
  if (ageTimer !== undefined) return;
  ageTimer = setInterval(tickInboxAges, INBOX_AGE_TICK_MS);
}

/** Stop the age tick, so a page that is torn down leaves no timer behind. */
export function stopInboxAgeTimer(): void {
  if (ageTimer === undefined) return;
  clearInterval(ageTimer);
  ageTimer = undefined;
}

/** Put this module back where a freshly loaded page starts. */
export function resetInboxState(): void {
  stopInboxAgeTimer();
  openers = {};
  inboxItems.value = [];
  expandedInbox.value = new Set();
  inboxClock.value = Date.now();
}
