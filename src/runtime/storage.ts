import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { readFile, writeFile } from "node:fs/promises";
import type { Paths } from "./paths.ts";
import { openPrivateSqliteStorage } from "./sqlite-file.ts";

export interface StorageBundle {
  readonly storage: Storage;
  readonly schemaVersion: number;
  close(): Promise<void>;
}

/** Read the schema/migration version recorded in `VERSION`, if any. */
export async function readSchemaVersion(paths: Paths): Promise<number | undefined> {
  try {
    const text = await readFile(paths.versionFile, "utf8");
    const value = Number.parseInt(text.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the schema/migration version recorded in `VERSION`. */
export async function writeSchemaVersion(paths: Paths, version: number): Promise<void> {
  await writeFile(paths.versionFile, `${version}\n`, { mode: 0o600 });
}

/**
 * Every key of one session-scoped document family.
 *
 * The `sec.*` families are not enumerable from inside a `Tx`, so anything that
 * needs to walk them has to go through Storage directly.
 */
export async function scanDocumentKeys(
  storage: Storage,
  kind: string,
  context: Context,
  scope: Parameters<Storage["scanDocuments"]>[0]["scope"] = { kind: "session" },
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: Parameters<Storage["scanDocuments"]>[2];
  for (;;) {
    const page = await storage.scanDocuments(
      { scope, at: "current", kind },
      500,
      cursor,
      context,
    );
    for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return keys;
}

/**
 * Open the single-owner SQLite storage. A storage written by a newer pi-sec
 * refuses to open on an older binary.
 */
export async function openStorage(paths: Paths): Promise<StorageBundle> {
  const recorded = await readSchemaVersion(paths);
  if (recorded !== undefined && recorded > CURRENT_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `storage schema ${recorded} is newer than this binary (${CURRENT_SQLITE_SCHEMA_VERSION}); upgrade pi-sec or restore a matching backup`,
    );
  }
  const storage = await openPrivateSqliteStorage(paths.stateDb);
  return {
    storage,
    schemaVersion: CURRENT_SQLITE_SCHEMA_VERSION,
    close: async () => {
      await storage.close(BACKGROUND_CONTEXT);
    },
  };
}
