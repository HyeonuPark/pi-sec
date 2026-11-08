/**
 * The questions waiting on the operator, and the one answer each one takes.
 *
 * A question is drawn from the list `GET /api/user-queries` answers with, keyed
 * by its `key`, which is also what an answer travels on. A live `user_query` or
 * `user_query_resolved` frame names no list, so the list is read back rather than
 * patched: the server holds the only copy of what is still open, and a question
 * can close without this page sending anything.
 *
 * What is typed into a card's `Other…` field is not in this module. The field is
 * an ordinary input inside a card keyed by the question's own key, so a read, an
 * event about another question, or a clock tick leaves the field, its caret and
 * its focus exactly where the operator left them. Only a question that closed
 * takes its card — and the text in it — off the screen.
 */
import { signal } from "@preact/signals";
import type { UserQuery, UserQueryAnswer, UserQueryListResponse } from "../../shared/wire/queries.ts";
import { request } from "../api/request.ts";
import { relativeTime } from "./inbox.ts";
import { reconcileById } from "./keyed.ts";

/** The open questions, oldest first, as the server answered. */
export const queries = signal<readonly UserQuery[]>([]);

/** The instant an age is measured from. A return to the tab moves it. */
export const queriesClock = signal<number>(Date.now());

/** Read the open questions once and draw them. A failed read keeps the last list. */
export async function refreshQueries(): Promise<void> {
  try {
    const data = await request<UserQueryListResponse>("/api/user-queries");
    queries.value = reconcileById(queries.value, data?.queries ?? [], (query) => String(query.key));
  } catch {
    /* ignore: a live event can still fill the map */
  }
}

/** A `user_query` or `user_query_resolved` frame: the list changed, read it. */
export function applyQueryEvent(_type?: string): void {
  void refreshQueries();
}

/**
 * The answers this page is sending right now, as `<key>\0<text>`. A card is
 * redrawn every time the list is read back, so the guard against a second send of
 * the same answer lives here rather than in one card: the answer still on its way
 * is the same answer after a redraw, and it goes out once.
 */
const answersInFlight = new Set<string>();

/** Send one answer to one question, then read the list back either way. */
export async function answerQuery(key: string, payload: UserQueryAnswer): Promise<void> {
  try {
    await request(`/api/user-queries/${encodeURIComponent(key)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    /* ignore: a refusal leaves the card up, which is what the read below shows */
  }
  // Read the list back rather than dropping this card out of a local list: the
  // server holds the only copy of what is still open.
  await refreshQueries();
}

/** Send the operator's own words as the answer, at most once per same text. */
export async function sendOtherAnswer(key: string, text: string): Promise<void> {
  const fingerprint = `${key}\u0000${text}`;
  if (answersInFlight.has(fingerprint)) return;
  answersInFlight.add(fingerprint);
  try {
    await answerQuery(key, { other: text });
  } finally {
    answersInFlight.delete(fingerprint);
  }
}

/**
 * When the question was asked: the clock time it was made, and how long ago that
 * was. Both, because the clock time never goes stale and the age is what says
 * whether this is fresh. No deadline wording, no colour and no countdown: the
 * same stamp would then read as pressure to answer.
 */
export function queryAge(createdAt: unknown, now: number = Date.now()): string {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) return "";
  const clock = new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return `asked ${clock} · ${relativeTime(value, now)}`;
}

/** Put this module back where a freshly loaded page starts. */
export function resetQueriesState(): void {
  queries.value = [];
  queriesClock.value = Date.now();
  answersInFlight.clear();
}
