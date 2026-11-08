import { DatabaseSync } from "node:sqlite";

/**
 * A held single-run lock on one home.
 *
 * The database connection behind it stays reachable for as long as this object
 * does, on purpose: SQLite holds the lock on the connection, so a connection the
 * garbage collector finalized would drop the lock while the daemon kept running.
 */
export interface DaemonLock {
  readonly path: string;
  /** Drop the lock. Idempotent, and safe to call on a path that never took it. */
  release(): void;
}

/** Another process holds the lock on this home. */
export class DaemonLockHeldError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`another process holds ${lockPath}`);
    this.name = "DaemonLockHeldError";
    this.lockPath = lockPath;
  }
}

/** SQLITE_BUSY and SQLITE_LOCKED, the two codes an exclusive lock raises. */
const LOCKED_CODES = new Set([5, 6]);

function isLockedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  if (typeof errcode === "number" && LOCKED_CODES.has(errcode)) return true;
  return typeof message === "string" && /database (table )?is locked/i.test(message);
}

/**
 * Take the single-run lock on `lockPath`, or say who has it.
 *
 * The lock is an exclusive SQLite lock on a file of its own, not on the storage.
 * The storage permits several connections and recovers on its own, so nothing
 * there refuses a second process; this is a resource with one owner by
 * construction. Waiting is not an option here: a start that waited would be a
 * second daemon queued behind the first, so the timeout is zero and the busy
 * code comes back at once.
 *
 * Nothing has to be cleaned up after a crash. The operating system releases the
 * lock when the holder's last descriptor closes, so a SIGKILL, an OOM kill and a
 * clean stop all leave the next start free to take it.
 */
export function acquireDaemonLock(lockPath: string): DaemonLock {
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    // The failed connection is closed before the refusal leaves this function:
    // a connection left in exclusive locking mode would answer for this process.
    try {
      db.close();
    } catch {
      /* the refusal is the answer; a close failure must not replace it */
    }
    if (isLockedError(error)) throw new DaemonLockHeldError(lockPath);
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        db.close();
      } catch {
        /* the process is ending, and the kernel drops the lock with it */
      }
    },
  };
}
