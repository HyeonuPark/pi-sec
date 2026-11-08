import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restrictSqliteFileModes } from "../runtime/sqlite-file.ts";

/**
 * One row per model call that went through the model library.
 *
 * The file is `state/model-calls.sqlite`, a database of its own because the
 * schema of `state/sec.sqlite` belongs to the durable library. A row holds
 * timing and token counts only: no prompt, no response, no conversation id and
 * no error text.
 */

/** The table the rows live in. */
export const MODEL_CALLS_TABLE = "model_calls";

/** The columns of the table, in the order of the table. */
export const MODEL_CALLS_COLUMNS = [
  "id",
  "started_at",
  "provider",
  "model",
  "api",
  "stop_reason",
  "input",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
  "headers_ms",
  "ttft_ms",
  "duration_ms",
  "last_content_ms",
  "content_events",
] as const;

/** Rows older than this many days are deleted. */
export const MODEL_CALLS_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a caller writes: one finished call. */
export interface ModelCallInput {
  /** Epoch milliseconds when pi-sec called the model library. */
  readonly startedAt: number;
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly stopReason: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** `null` when the provider does not report reasoning tokens. */
  readonly reasoning: number | null;
  /** Time to the `start` event. `null` when none came. */
  readonly headersMs: number | null;
  /** Time to the first content event. `null` when none came. */
  readonly ttftMs: number | null;
  readonly durationMs: number;
  /** Time to the last content event, on the clock of `ttftMs`. `null` when none came, and for rows from before the column. */
  readonly lastContentMs: number | null;
  /** Number of content events. 0 when none came, `null` for rows from before the column. */
  readonly contentEvents: number | null;
}

/** What a reader gets: one stored row. */
export interface ModelCallRow extends ModelCallInput {
  readonly id: number;
}

export class ModelCallsStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #lastPruneDay: number | undefined;

  private constructor(db: DatabaseSync, now: () => number) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS ${MODEL_CALLS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      api TEXT NOT NULL,
      stop_reason TEXT NOT NULL,
      input INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER,
      headers_ms INTEGER,
      ttft_ms INTEGER,
      duration_ms INTEGER NOT NULL,
      last_content_ms INTEGER,
      content_events INTEGER
    )`);
    // A file from before these columns gets them once. The rows keep NULL in both.
    const have = new Set(
      (db.prepare(`PRAGMA table_info(${MODEL_CALLS_TABLE})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const column of ["last_content_ms", "content_events"]) {
      if (!have.has(column)) db.exec(`ALTER TABLE ${MODEL_CALLS_TABLE} ADD COLUMN ${column} INTEGER`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS model_calls_started_at ON ${MODEL_CALLS_TABLE} (started_at)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS model_calls_provider_started_at ON ${MODEL_CALLS_TABLE} (provider, started_at)`,
    );
  }

  /** Open (or create) the store at `path`. `:memory:` is accepted, for tests. */
  static async open(path: string, now: () => number = Date.now): Promise<ModelCallsStore> {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await restrictSqliteFileModes(path);
    }
    const db = new DatabaseSync(path);
    if (path !== ":memory:") await restrictSqliteFileModes(path);
    return new ModelCallsStore(db, now);
  }

  /**
   * Write one row. At the first write after the UTC day
   * changes, it also deletes the rows older than the retention.
   */
  insert(call: ModelCallInput): void {
    this.#pruneOncePerDay();
    this.#db
      .prepare(
        `INSERT INTO ${MODEL_CALLS_TABLE} (started_at, provider, model, api, stop_reason, input, cache_read,
          cache_write, output, reasoning, headers_ms, ttft_ms, duration_ms, last_content_ms, content_events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.round(call.startedAt),
        call.provider,
        call.model,
        call.api,
        call.stopReason,
        call.input,
        call.cacheRead,
        call.cacheWrite,
        call.output,
        call.reasoning,
        call.headersMs === null ? null : Math.round(call.headersMs),
        call.ttftMs === null ? null : Math.round(call.ttftMs),
        Math.round(call.durationMs),
        call.lastContentMs === null ? null : Math.round(call.lastContentMs),
        call.contentEvents,
      );
  }

  /** Delete the rows older than the retention. Returns how many it deleted. */
  prune(): number {
    const cutoff = this.#now() - MODEL_CALLS_RETENTION_DAYS * DAY_MS;
    const result = this.#db.prepare(`DELETE FROM ${MODEL_CALLS_TABLE} WHERE started_at < ?`).run(cutoff);
    return Number(result.changes);
  }

  /** Every row, oldest first. For tests and readers of small data. */
  rows(): ModelCallRow[] {
    const stored = this.#db.prepare(`SELECT * FROM ${MODEL_CALLS_TABLE} ORDER BY id`).all() as Record<
      string,
      number | string | null
    >[];
    return stored.map((r) => ({
      id: Number(r.id),
      startedAt: Number(r.started_at),
      provider: String(r.provider),
      model: String(r.model),
      api: String(r.api),
      stopReason: String(r.stop_reason),
      input: Number(r.input),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      output: Number(r.output),
      reasoning: r.reasoning === null ? null : Number(r.reasoning),
      headersMs: r.headers_ms === null ? null : Number(r.headers_ms),
      ttftMs: r.ttft_ms === null ? null : Number(r.ttft_ms),
      durationMs: Number(r.duration_ms),
      lastContentMs: r.last_content_ms == null ? null : Number(r.last_content_ms),
      contentEvents: r.content_events == null ? null : Number(r.content_events),
    }));
  }

  #pruneOncePerDay(): void {
    const day = Math.floor(this.#now() / DAY_MS);
    if (this.#lastPruneDay === day) return;
    this.prune();
    this.#lastPruneDay = day;
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* the process is ending; a close failure must not replace its reason */
    }
  }
}
