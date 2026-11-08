import { link, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "../runtime/ids.ts";

/**
 * The one name shape a secret file may have.
 *
 * A name becomes a file name, so it is kept to one unambiguous ASCII class:
 * no path separator, no leading dot, no `..`, no NUL, no control character and
 * no non-ASCII. The first character cannot be a dot or a dash, because a dot
 * would hide the file from the registry and a dash invites an option parse.
 */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A temporary file is invisible to the registry because its name starts with a dot. */
const TEMP_PREFIX = ".upload-";

/** How long a `.upload-` file may stay before the next upload removes it. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Whether `name` may become a secret file name.
 *
 * Three rules the pattern cannot express:
 * - `env` is refused, because the registry reads that file as a `KEY=value`
 *   bundle and registers each value under its key. A single-value secret stored
 *   there would be read as something else entirely.
 * - a trailing dot is refused: `name.` and `name` are one file on some
 *   filesystems and two on others, which makes a duplicate upload look new.
 * - the pattern itself is ASCII-only, so no normalization can fold two names
 *   into one.
 */
export function isValidSecretName(name: string): boolean {
  if (!SECRET_NAME_PATTERN.test(name)) return false;
  if (name === "env") return false;
  if (name.endsWith(".")) return false;
  return true;
}

export type SecretWriteFailure = "invalid_name" | "empty_secret" | "name_exists" | "write_failed";

export type SecretWriteResult =
  | { readonly ok: true; readonly name: string; readonly bytes: number }
  | { readonly ok: false; readonly code: SecretWriteFailure };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Remove `.upload-` files left behind by an upload that died between writing the
 * temporary file and linking it into place.
 *
 * Only files older than an hour go: a younger one may belong to an upload that
 * is still running, and deleting it would fail that upload for no reason.
 */
export async function sweepStaleUploads(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < TEMP_MAX_AGE_MS) continue;
      await unlink(path);
    } catch {
      /* a sweep that cannot remove one file is not a failed upload */
    }
  }
}

/**
 * Write one secret value as `<dir>/<name>`, atomically and without overwriting.
 *
 * The body goes to a temporary file first, is fsynced there, and is then linked
 * to the final name. `link` is the whole point: it fails with `EEXIST` when the
 * name is taken instead of replacing the file, and it is one filesystem
 * operation, so there is no window between "does it exist" and "write it". The
 * final file shares the temporary file's inode and therefore its 0600 mode from
 * the first visible moment; no `chmod` can be missed.
 *
 * `rename` and `os.replace` are deliberately absent: both replace an existing
 * target, which is the one thing this function must never do.
 *
 * The temporary file is removed on both paths. The value never leaves this
 * function, and no caller receives it back.
 */
export async function writeSecretText(dir: string, name: string, text: string): Promise<SecretWriteResult> {
  if (!isValidSecretName(name)) return { ok: false, code: "invalid_name" };

  // The registry drops one trailing newline and does not register a value that is
  // empty after that, so a text that would produce such a file is refused here
  // rather than written as a secret nobody can use. Whitespace alone is refused
  // for a harder reason: the registry has no minimum length, so a value of "\n"
  // or a space would be redacted out of every line the agent reads.
  if (text.replace(/\r?\n$/, "").trim().length === 0) return { ok: false, code: "empty_secret" };

  const bytes = Buffer.byteLength(text, "utf8");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, code: "write_failed" };
  }
  await sweepStaleUploads(dir);

  const temp = join(dir, TEMP_PREFIX + ulid());
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    await unlink(temp).catch(() => undefined);
    return { ok: false, code: "write_failed" };
  }

  try {
    await link(temp, join(dir, name));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    return { ok: false, code: errorCode(error) === "EEXIST" ? "name_exists" : "write_failed" };
  }

  await unlink(temp).catch(() => undefined);
  return { ok: true, name, bytes };
}
