import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restrictSqliteFileModes } from "../runtime/sqlite-file.ts";

/**
 * The focused chats: which conversations the user opened from the web page, and
 * what became of them.
 *
 * This is a database of its own (`state/focused-chats.sqlite`) for the reason the
 * job archive has one: the transcript store is managed by the durable library,
 * and a table added to it would be a schema this code does not own. A focused
 * chat's row is small — its conversation id, its name, its title, when it opened
 * and when it was archived — and the transcript stays where it always was.
 *
 * The title and the archive time live here and nowhere else, so there is one
 * answer to "what is this chat called" and one answer to "is it archived".
 *
 * A deleted chat moves to `deleted_focused_chats` instead of vanishing. The
 * routes have to tell "no such chat" from "this chat was deleted", and a deleted
 * row's transcript entries stay in the transcript store, which has no delete.
 */

/** One row: a focused chat, open or archived. */
export interface FocusedChatRow {
  /** The store's row id. The chat's name is built from it. */
  readonly seq: number;
  readonly conversationId: number;
  /** `focused-<seq>`, fixed when the chat is opened. */
  readonly name: string;
  /** `null` while the chat has no title yet. */
  readonly title: string | null;
  readonly openedAt: number;
  /** `null` while the chat is open. */
  readonly archivedAt: number | null;
  /**
   * Whether the chat was opened as a test chat.
   *
   * An agent that opens a chat for a test says so in the open request, and only
   * the chats list acts on it: the chat page and the chat's own prompt read
   * nothing from this, so a test chat looks and behaves like any other chat.
   */
  readonly test: boolean;
}

/** What one page of the archived list asks for. */
export interface ArchivedQuery {
  /** A substring of the title. Absent or empty means no filter. */
  readonly q?: string;
  /** The `next` value of the page before, or nothing for the first page. */
  readonly cursor?: string;
  /** Rows per page. Defaults to 20, the page size the route uses. */
  readonly limit?: number;
}

/** One page of the archived list. `next` is present only while more rows exist. */
export interface ArchivedPage {
  readonly items: readonly FocusedChatRow[];
  readonly next?: string;
}

/** The page size of the archived list. */
export const FOCUSED_CHAT_PAGE = 20;

/** The chat's name, taken from its row id so two chats cannot share one. */
export function focusedChatName(seq: number): string {
  return `focused-${seq}`;
}

/** A cursor that is not one this store wrote. */
export class BadCursorError extends Error {
  constructor(cursor: string) {
    super(`the cursor is not one this list wrote: ${JSON.stringify(cursor)}`);
    this.name = "BadCursorError";
  }
}

/**
 * The opaque cursor of the archived list: the last row of the page before.
 *
 * The pair `archived_at:seq` is the list's own order, so resuming strictly after
 * it can neither repeat nor skip a row. It is base64url so a caller treats it as
 * a token rather than as a number to do arithmetic on.
 */
export function encodeCursor(row: FocusedChatRow): string {
  const archivedAt = row.archivedAt ?? 0;
  return Buffer.from(`${archivedAt}:${row.seq}`, "utf8").toString("base64url");
}

/** Read one cursor back. A value this store did not write is refused. */
export function decodeCursor(cursor: string): { readonly archivedAt: number; readonly seq: number } {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(text);
  if (match === null) throw new BadCursorError(cursor);
  return { archivedAt: Number(match[1]), seq: Number(match[2]) };
}

/**
 * A search term as a `LIKE` pattern that matches the term itself.
 *
 * `%` and `_` are wildcards to SQLite, so a user searching for `50%` would match
 * everything without this. The escape character is the backslash, named in every
 * `LIKE` below.
 */
export function likePattern(q: string): string {
  const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${escaped}%`;
}

interface StoredRow {
  readonly seq: number;
  readonly conversation_id: number;
  readonly name: string;
  readonly title: string | null;
  readonly opened_at: number;
  readonly archived_at: number | null;
  readonly test?: number | null;
}

function rowOf(stored: StoredRow): FocusedChatRow {
  return {
    seq: Number(stored.seq),
    conversationId: Number(stored.conversation_id),
    name: String(stored.name),
    title: stored.title === null || stored.title === undefined ? null : String(stored.title),
    openedAt: Number(stored.opened_at),
    archivedAt: stored.archived_at === null || stored.archived_at === undefined ? null : Number(stored.archived_at),
    test: Number(stored.test ?? 0) !== 0,
  };
}

/** How many statements one write runs before it is committed. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS focused_chats (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    opened_at INTEGER NOT NULL,
    archived_at INTEGER,
    test INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS deleted_focused_chats (
    conversation_id INTEGER PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
`;

/**
 * The focused chat store.
 *
 * One connection, opened by the runtime and closed with it. `node:sqlite` is the
 * same library the archive file uses (through the durable storage it wraps), and
 * the mode rule is the same one `sqlite-file.ts` applies: the file is `0600`,
 * because a title can say what the user is working on.
 */
export class FocusedChatStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    this.#addTestColumn();
  }

  /**
   * Add the test-chat column to a file an older build wrote.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there,
   * so the column is added by its own statement when it is missing. The rows an
   * older build wrote read `0`, which is "not a test chat": that build could not
   * mark one. The older build still runs on the new file, because its INSERT
   * names its own columns and this one has a default.
   */
  #addTestColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(focused_chats)").all() as unknown as {
      readonly name?: string;
    }[];
    if (columns.some((column) => column.name === "test")) return;
    this.#db.exec("ALTER TABLE focused_chats ADD COLUMN test INTEGER NOT NULL DEFAULT 0");
  }

  /** Open (or create) the store at `path`. `:memory:` is accepted, for tests. */
  static async open(path: string): Promise<FocusedChatStore> {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await restrictSqliteFileModes(path);
    }
    const db = new DatabaseSync(path);
    if (path !== ":memory:") await restrictSqliteFileModes(path);
    return new FocusedChatStore(db);
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* the process is ending; a close failure must not replace its reason */
    }
  }

  /**
   * Write the row of a chat that is being opened.
   *
   * The conversation already exists when this runs — the creating commit hands
   * its id to this call — so the row is complete from its first moment and there
   * is no placeholder id for a second chat to collide with.
   */
  reserve(input: {
    readonly conversationId: number;
    readonly openedAt: number;
    readonly title?: string | null;
    /** Whether this chat is opened as a test chat. Defaults to `false`. */
    readonly test?: boolean;
  }): FocusedChatRow {
    const insert = this.#db.prepare(
      "INSERT INTO focused_chats (conversation_id, name, title, opened_at, archived_at, test) VALUES (?, '', ?, ?, NULL, ?)",
    );
    const written = insert.run(input.conversationId, input.title ?? null, input.openedAt, input.test === true ? 1 : 0);
    const seq = Number(written.lastInsertRowid);
    const name = focusedChatName(seq);
    this.#db.prepare("UPDATE focused_chats SET name = ? WHERE seq = ?").run(name, seq);
    const row = this.get(input.conversationId);
    if (row === undefined) throw new Error(`focused chat row ${seq} disappeared while it was written`);
    return row;
  }

  /** Drop a row whose creating commit failed. Only an unopened chat is dropped. */
  discard(conversationId: number): void {
    this.#db.prepare("DELETE FROM focused_chats WHERE conversation_id = ? AND archived_at IS NULL").run(conversationId);
  }

  get(conversationId: number): FocusedChatRow | undefined {
    const stored = this.#db.prepare("SELECT * FROM focused_chats WHERE conversation_id = ?").get(conversationId) as
      | StoredRow
      | undefined;
    return stored === undefined ? undefined : rowOf(stored);
  }

  /** Every open chat, newest first. */
  listActive(): FocusedChatRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM focused_chats WHERE archived_at IS NULL ORDER BY opened_at DESC, seq DESC")
      .all() as unknown as StoredRow[];
    return rows.map(rowOf);
  }

  /**
   * One page of the archived chats, newest archived first.
   *
   * One function owns the order, the page size, the search and the cursor, so
   * replacing `LIKE` with full-text search later changes this function and the
   * table and leaves the route's `q` and `cursor` exactly as they are.
   */
  listArchived(query: ArchivedQuery = {}): ArchivedPage {
    const limit = query.limit ?? FOCUSED_CHAT_PAGE;
    const wanted = query.q === undefined || query.q === "" ? undefined : query.q;
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    const where: string[] = ["archived_at IS NOT NULL"];
    const values: (string | number)[] = [];
    if (wanted !== undefined) {
      // A chat with no title never matches a search: `NULL LIKE ...` is NULL, and
      // the row must not appear for a term it cannot contain.
      where.push("title IS NOT NULL AND title LIKE ? ESCAPE '\\'");
      values.push(likePattern(wanted));
    }
    if (after !== undefined) {
      where.push("(archived_at < ? OR (archived_at = ? AND seq < ?))");
      values.push(after.archivedAt, after.archivedAt, after.seq);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM focused_chats WHERE ${where.join(" AND ")} ORDER BY archived_at DESC, seq DESC LIMIT ?`,
      )
      .all(...values, limit + 1) as unknown as StoredRow[];
    const page = rows.slice(0, limit).map(rowOf);
    const more = rows.length > limit;
    const last = page.at(-1);
    return more && last !== undefined ? { items: page, next: encodeCursor(last) } : { items: page };
  }

  /**
   * Set the title outright, whoever asks.
   *
   * This is the user renaming the chat on the web page. The chat's own tool goes
   * through `setTitleIfUntitled` instead: one conversation chooses its own title
   * once, and the user owns it after that.
   */
  setTitle(conversationId: number, title: string): boolean {
    const written = this.#db
      .prepare("UPDATE focused_chats SET title = ? WHERE conversation_id = ?")
      .run(title, conversationId);
    return Number(written.changes) > 0;
  }

  /**
   * Set the title of a chat that has none.
   *
   * The `title IS NULL` in the statement is the whole rule of `focused_chat_title`:
   * one chat chooses its own title once, and afterwards only the user changes it.
   * Two calls that race both pass the read and only one passes the write.
   */
  setTitleIfUntitled(conversationId: number, title: string): boolean {
    const written = this.#db
      .prepare("UPDATE focused_chats SET title = ? WHERE conversation_id = ? AND title IS NULL")
      .run(title, conversationId);
    return Number(written.changes) > 0;
  }

  /**
   * Mark an open chat archived, and return the row as it stood.
   *
   * The returned row is read before the write, so the caller keeps the values it
   * announced. A chat that is already archived returns `undefined`, which is what
   * makes the archive tool idempotent rather than a second event.
   */
  archive(conversationId: number, at: number): FocusedChatRow | undefined {
    const row = this.get(conversationId);
    if (row === undefined || row.archivedAt !== null) return undefined;
    const written = this.#db
      .prepare("UPDATE focused_chats SET archived_at = ? WHERE conversation_id = ? AND archived_at IS NULL")
      .run(at, conversationId);
    if (Number(written.changes) === 0) return undefined;
    return { ...row, archivedAt: at };
  }

  /**
   * Move a chat out of the list and into the tombstone, and return the row it had.
   *
   * The two statements run in one transaction: a row in neither table would make
   * the chat invisible to the routes that have to refuse it by name.
   */
  delete(conversationId: number, at: number): FocusedChatRow | undefined {
    const row = this.get(conversationId);
    if (row === undefined) return undefined;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("INSERT INTO deleted_focused_chats (conversation_id, deleted_at) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET deleted_at = excluded.deleted_at")
        .run(conversationId, at);
      this.#db.prepare("DELETE FROM focused_chats WHERE conversation_id = ?").run(conversationId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return row;
  }

  /** Whether this conversation was a focused chat that was deleted. */
  isDeleted(conversationId: number): boolean {
    return this.#db.prepare("SELECT 1 AS found FROM deleted_focused_chats WHERE conversation_id = ?").get(conversationId) !== undefined;
  }

  /** When the chat was deleted, or `undefined`. */
  deletedAt(conversationId: number): number | undefined {
    const stored = this.#db
      .prepare("SELECT deleted_at FROM deleted_focused_chats WHERE conversation_id = ?")
      .get(conversationId) as { deleted_at?: number } | undefined;
    return stored?.deleted_at === undefined ? undefined : Number(stored.deleted_at);
  }
}
