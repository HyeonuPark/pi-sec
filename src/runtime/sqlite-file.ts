import { chmod } from "node:fs/promises";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeSqliteStorageOptions } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** The mode every pi-sec file has, per `docs/runtime-layout.md`. */
const FILE_MODE = 0o600;

/**
 * Every file one database owns: the database, the write-ahead log, and the
 * shared-memory index.
 *
 * SQLite creates the last two beside the database and deletes them when the
 * last connection closes. A caller must therefore treat a missing path as
 * normal and not as an error.
 */
export function sqliteFiles(path: string): readonly string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

/**
 * Set the mode of every present file of one database. A missing sidecar is not
 * an error.
 */
export async function restrictSqliteFileModes(path: string): Promise<void> {
  for (const file of sqliteFiles(path)) await chmod(file, FILE_MODE).catch(() => undefined);
}

/**
 * Open file-backed durable storage as owner-only.
 *
 * `node:sqlite` takes no mode, and SQLite creates a database with `0644` masked
 * by the process umask. No part of the library enforces `0600`, so a database
 * born under a permissive umask stays readable by every account on the host.
 * SQLite also copies the mode of the database file onto each `-wal` and `-shm`
 * it creates later. The database file is therefore tightened before the open,
 * and the whole set again after it. A sidecar that appears after this call
 * inherits `0600` from the database file.
 */
export async function openPrivateSqliteStorage(
  path: string,
  options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
  if (path === ":memory:") return openNodeSqliteStorage(path, options);
  await restrictSqliteFileModes(path);
  const storage = await openNodeSqliteStorage(path, options);
  await restrictSqliteFileModes(path);
  return storage;
}
