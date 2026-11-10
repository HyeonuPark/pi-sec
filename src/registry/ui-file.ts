import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * The problem with one declared file under an extension's `ui/` directory, or
 * `undefined` when it is usable.
 *
 * The rules are the ones the server repeats when it serves the file: a relative
 * path of plain segments under `ui/`, with the suffix the field needs, that
 * resolves to a regular file inside the real `ui/` directory. A symlink that
 * leaves `ui/` is refused here, so a static server that re-checks realpath has
 * nothing new to learn. The card scripts and the page scripts and styles all
 * use this one check.
 */
export async function uiFileProblem(
  uiDir: string,
  field: string,
  value: unknown,
  suffix: RegExp,
  suffixText: string,
): Promise<string | undefined> {
  if (typeof value !== "string") return `${field} must be a string`;
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return `${field} "${value}" has a "." or ".." segment`;
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) return `${field} "${value}" is not a plain path under ui/`;
  }
  if (!suffix.test(value)) return `${field} "${value}" must end in ${suffixText}`;

  const path = join(uiDir, value);
  let info;
  try {
    info = await stat(path);
  } catch {
    return `${field} "${value}" is not a file in ui/`;
  }
  if (!info.isFile()) return `${field} "${value}" is not a regular file`;

  let base: string;
  try {
    base = await realpath(uiDir);
  } catch {
    return `${field} "${value}" cannot be resolved: ui/ is not a directory`;
  }
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    return `${field} "${value}" cannot be resolved`;
  }
  if (target !== base && !target.startsWith(base + sep)) return `${field} "${value}" resolves outside ui/`;
  return undefined;
}
