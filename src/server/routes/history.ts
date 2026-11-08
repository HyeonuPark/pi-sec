import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { slimEntry } from "../stream-entries.ts";

/**
 * One earlier session of a conversation, cut out of the stored transcript.
 *
 * The page draws the active context alone: the snapshot starts at the newest
 * head marker, so everything a session restart left behind is stored and not
 * sent. This is the read that hands one of those sessions back. It reads and
 * never writes, and the model's context is not touched: the page draws the
 * block, the store keeps exactly what it kept before.
 *
 * The rule is one press, one session:
 *
 * - `before` is the smallest entry id the page holds, so the walk starts at the
 *   entry just before it.
 * - The walk goes back until it meets a session restart (`pi.reset`). That entry
 *   is the boundary, and its `head` is where the session begins; it is placed
 *   first, so the page draws its `new session` divider above the session it
 *   brought. A conversation with no restart left is one session, and its first
 *   entry ends the walk.
 * - A block that would pass `maxBytes` stops earlier: the newest entries that
 *   fit are answered, with `hasMore` true. The page puts the button back above
 *   them, so the part that was left comes on the next press. At least one entry
 *   is always answered, so a press always moves.
 * - `hasMore` says whether anything is stored before the first entry answered,
 *   which is exactly what the page needs to decide whether the button stays.
 *
 * A compaction's `head` is not a boundary: the entries a compaction dropped sit
 * inside the session that holds them, so the block brings them along. The walk
 * therefore looks for `pi.reset` and passes any other marker by.
 */

/** The most one answer carries. The heaviest sessions measured are a few megabytes. */
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/** How many entries one store page holds while the walk goes back. */
const SCAN_PAGE = 200;

/** The kind a session restart is written as, and the one kind that ends a block. */
const SESSION_RESTART = "pi.reset";

/** One earlier session: its entries oldest first, and whether more is stored before it. */
export interface HistoryBlock {
  readonly entries: readonly EntryRecord[];
  /** True when an entry is stored before the first one answered. */
  readonly hasMore: boolean;
}

/** The bytes one answered entry costs, counted after the slimming the stream applies. */
function entryBytes(entry: EntryRecord): number {
  return Buffer.byteLength(JSON.stringify(entry));
}

/** The `head` a marker entry carries, when it carries a numeric one. */
function headOf(entry: EntryRecord): EntryId | undefined {
  const head = (entry as { readonly head?: unknown }).head;
  return typeof head === "number" && Number.isFinite(head) ? (head as EntryId) : undefined;
}

/** Whether any entry of this conversation is stored before `id`. */
export async function hasEntriesBefore(conversation: Conversation, id: EntryId): Promise<boolean> {
  if (id <= 1) return false;
  const page = await conversation.entries(
    { maxEntryId: (id - 1) as EntryId },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.length > 0;
}

/**
 * Read one session that ends just before `before`.
 *
 * The answer's entries are slimmed the way the conversation stream slims them, so
 * a page that draws a loaded session and a page that draws a live one hold the
 * same shape and no field reaches the browser that the stream would drop.
 */
export async function cutSessionBlock(
  conversation: Conversation,
  before: EntryId,
  maxBytes: number = HISTORY_MAX_BYTES,
): Promise<HistoryBlock> {
  const end = before - 1;
  if (!Number.isFinite(end) || end < 1) return { entries: [], hasMore: false };

  const newestFirst: EntryRecord[] = [];
  let bytes = 0;
  let boundary: EntryRecord | undefined;
  let capped = false;

  let cursor: Cursor | undefined;
  walk: for (;;) {
    const page = await conversation.entries(
      { maxEntryId: end as EntryId, order: "descending" },
      SCAN_PAGE,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      const size = entryBytes(slimEntry(entry));
      // The entry that does not fit is left out, and the button that comes back
      // above this block is what fetches it. One entry is always answered: a cap
      // smaller than a single entry would otherwise answer nothing and the press
      // would never move.
      if (newestFirst.length > 0 && bytes + size > maxBytes) {
        capped = true;
        break walk;
      }
      newestFirst.push(entry);
      bytes += size;
      if (entry.kind === SESSION_RESTART && headOf(entry) !== undefined) {
        boundary = entry;
        break walk;
      }
    }
    cursor = page.next;
    if (cursor === undefined) break;
  }

  // Nothing is stored before `before`: the page has reached the start of the
  // conversation, and its button goes away.
  if (newestFirst.length === 0) return { entries: [], hasMore: false };

  const oldest = newestFirst[newestFirst.length - 1]!;
  // A boundary's `head` is where its session begins, and every entry between that
  // head and the boundary itself was read on the way, because the walk was still
  // going back at that point.
  const start = boundary === undefined ? oldest.id : (headOf(boundary) ?? oldest.id);

  const ascending = [...newestFirst].reverse().map(slimEntry);
  if (boundary !== undefined) {
    const at = ascending.findIndex((entry) => entry.id === boundary!.id);
    // The boundary is drawn as the session's first line, so it is the first entry
    // answered. A restart's `head` is itself, so this usually reads as already in
    // place; a marker whose `head` is older needs the move.
    if (at > 0) ascending.unshift(...ascending.splice(at, 1));
  }

  const hasMore = capped ? true : boundary !== undefined ? await hasEntriesBefore(conversation, start as EntryId) : false;
  return { entries: ascending, hasMore };
}

/** The `before` a request names, or `undefined` when it names no entry id. */
export function readBeforeParam(url: URL): EntryId | undefined {
  const raw = url.searchParams.get("before");
  if (raw === null || !/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? (value as EntryId) : undefined;
}
