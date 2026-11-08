import { readFileSync } from "node:fs";

/**
 * The kernel's own description of what is mounted where.
 *
 * `/proc/self/mountinfo` is the table that decides whether a path can carry a
 * mount option such as `user_subvol_rm_allowed`, so a caller that removes a
 * btrfs subvolume without root has to read it. The table is text: one record per
 * line, fields separated by single spaces, and the mount point and the other
 * path fields escaped so that a space inside a name cannot split the record.
 *
 * A line is:
 *
 *   mount-id parent-id major:minor root mount-point mount-options
 *   [optional fields...] - fs-type mount-source super-options
 *
 * The optional fields (`shared:1`, `master:2`) end at the separator `-`. The
 * last field is the superblock option set, which is a different set from the
 * per-mount options and is what decides flags such as `ro` for the whole
 * file system.
 */
export interface MountEntry {
  readonly mountId: number;
  readonly parentId: number;
  /** `major:minor` of the mounted device, as the kernel prints it. */
  readonly majorMinor: string;
  /** The path inside the file system that the mount exposes, field 4. */
  readonly root: string;
  /** Where the mount appears in this namespace, with escapes resolved. */
  readonly mountPoint: string;
  /** Field 6: the per-mount options, such as `rw` and `user_subvol_rm_allowed`. */
  readonly options: string[];
  /** Fields 7 and up before the separator, such as `shared:560`. */
  readonly optionalFields: string[];
  readonly fsType: string;
  /** Field after the file-system type: the device or pseudo source. */
  readonly source: string;
  /** The last field: the superblock options, such as `rw,seclabel,subvol=/root`. */
  readonly superOptions: string[];
}

const OCTAL_ESCAPE = /\\([0-7]{3})/gu;

/**
 * Resolve the kernel's octal escapes (`\040` for a space, `\134` for a
 * backslash). The kernel escapes only space, tab, newline and backslash, but any
 * three-digit octal sequence is resolved the same way.
 */
function unescapeField(field: string): string {
  return field.replace(OCTAL_ESCAPE, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * Parse the table. A line that does not carry the fixed part and the separator
 * is skipped instead of failing the whole read: the file is live, and one
 * record that a newer kernel prints in a shape this code does not know must not
 * hide every other mount.
 */
export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const fields = line.split(" ");
    if (fields.length < 10) continue;
    // The separator sits at index 6 when the record has no optional field.
    const separator = fields.indexOf("-", 6);
    if (separator < 6 || separator + 3 >= fields.length) continue;
    const mountId = Number(fields[0]);
    const parentId = Number(fields[1]);
    const majorMinor = fields[2] ?? "";
    const root = fields[3] ?? "";
    const mountPoint = fields[4] ?? "";
    const options = (fields[5] ?? "").split(",").filter((option) => option !== "");
    const optionalFields = fields.slice(6, separator);
    const fsType = fields[separator + 1] ?? "";
    const source = fields[separator + 2] ?? "";
    const superOptions = fields.slice(separator + 3).join(" ").split(",").filter((option) => option !== "");
    if (!Number.isFinite(mountId) || !Number.isFinite(parentId)) continue;
    entries.push({
      mountId,
      parentId,
      majorMinor,
      root: unescapeField(root),
      mountPoint: unescapeField(mountPoint),
      options,
      optionalFields,
      fsType,
      source: unescapeField(source),
      superOptions,
    });
  }
  return entries;
}

/** Strip trailing slashes; the root stays `/`. */
function normalizeAbsolute(path: string): string {
  if (!path.startsWith("/")) throw new Error(`the path must be absolute: ${path}`);
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * True when `path` is the mount point or sits below it. A bare prefix is not
 * enough: `/a/b` is not a prefix of `/a/bc`, and a mount at `/a/b` therefore
 * does not own `/a/bc`.
 */
function covers(mountPoint: string, path: string): boolean {
  if (mountPoint === "/") return path.startsWith("/");
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

/**
 * The mount that owns the path: the longest mount point that covers it. A bind
 * mount placed over an older one has the same mount point, so on a tie the later
 * record wins, which is the order the kernel mounts them.
 */
export function mountFor(entries: readonly MountEntry[], absPath: string): MountEntry | undefined {
  const path = normalizeAbsolute(absPath);
  let best: MountEntry | undefined;
  for (const entry of entries) {
    if (!covers(entry.mountPoint, path)) continue;
    if (best === undefined || entry.mountPoint.length >= best.mountPoint.length) best = entry;
  }
  return best;
}

/**
 * Whether an unprivileged user may delete a btrfs subvolume on the file system
 * that holds the path. Without the option, a subvolume needs the fallback that
 * empties the tree and removes the directory.
 *
 * `user_subvol_rm_allowed` is a superblock option, and on a live btrfs the kernel
 * prints it in the last field of the record, not in the per-mount options: this
 * a host can report it as `... - btrfs /dev/x rw,seclabel,user_subvol_rm_allowed,
 * subvol=/root`. Both sets are read here, because a kernel or a mount tool that
 * files it under the per-mount options must still be understood, and the answer
 * must not depend on which field a version happens to choose.
 *
 * `text` is the table to read; without it the live `/proc/self/mountinfo` is
 * read, which is what the runtime wants and what a test overrides.
 */
export function hasUserSubvolRmAllowed(absPath: string, text?: string): boolean {
  const source = text ?? readFileSync("/proc/self/mountinfo", "utf8");
  const mount = mountFor(parseMountinfo(source), absPath);
  if (mount === undefined) return false;
  return mount.options.includes("user_subvol_rm_allowed") || mount.superOptions.includes("user_subvol_rm_allowed");
}
