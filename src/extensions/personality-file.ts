import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Paths } from "../runtime/paths.ts";
import type { PersonalityLanguage } from "./personality-texts.ts";

/**
 * The personality document: one markdown file the operator can read and edit.
 *
 * The file starts with an optional front matter of three or four lines: the
 * opening marker, one or two key lines (`language` and `name`, in either order),
 * and the closing marker.
 *
 *   ---
 *   language: ko
 *   name: 테스트봇
 *   ---
 *   {the document}
 *
 * Two keys are read, and nothing else. A file with no front matter, or with a
 * language that is neither `en` nor `ko`, reads as English: a fresh install may
 * run a model that does not read Korean, so English is the side that cannot
 * surprise an operator. A three-line block is front matter whatever its middle
 * line holds, which is how this module read every file before the name line
 * existed: a marker pair a person sees is stripped as they saw it, and a line
 * this release does not read leaves the language at English and the name empty.
 * A four-line block is front matter only when one key line is a `language` line
 * and the other a `name` line, because two key lines this release cannot both
 * read are a block it does not understand, and dropping text a person wrote is
 * worse than keeping the whole file as the body.
 *
 * The body is what the prompt carries. The front matter is metadata and never
 * reaches a section, because the section text already says the language in a
 * sentence the model can act on. The name is metadata of the same kind: the web
 * page reads it, and the prompt does not.
 */

/** The file `personality.file` names when the config leaves it empty. */
export const DEFAULT_PERSONALITY_FILE = "memory/personality.md";

/** Longest personality accepted, in characters. A guardrail, not a target. */
export const MAX_PERSONALITY_CHARS = 8000;

/**
 * Longest name `personality_set` accepts, in code points.
 *
 * The page draws the name as the title of the root chat, so it has to fit one
 * line of a top bar. A hand-edited file may hold a longer one, and it is read
 * as written: the limit guards the tool argument, not the reader.
 */
export const MAX_PERSONALITY_NAME_CHARS = 40;

/** The front matter marker, in the form this module writes it. */
const FRONT_MATTER_OPEN = "---";
const LANGUAGE_LINE = /^language:\s*(\S+)\s*$/;
const NAME_LINE = /^name:\s*(.*)$/;

export interface PersonalityDocument {
  /** The language the front matter names, or `en` when it names none or an unknown value. */
  readonly language: PersonalityLanguage;
  /** Whether the front matter named a language this release understands. */
  readonly languageNamed: boolean;
  /** The name the front matter gives, trimmed. Absent when the front matter names none. */
  readonly name?: string;
  /** The text after the front matter, trimmed. Never empty. */
  readonly body: string;
}

/** The result of reading a candidate front matter: its keys and where the body starts. */
interface FrontMatter {
  readonly language?: string;
  readonly name?: string;
  /** The index of the first line after the closing marker. */
  readonly bodyStart: number;
}

/**
 * Read a front matter from the first lines of a document, or `undefined`.
 *
 * A three-line block is front matter whatever its middle line holds: the marker
 * pair alone decided that before this module read a name at all, and a line it
 * does not read leaves the language at English and the name empty. A four-line
 * block counts only when its two key lines are a `language` line and a `name`
 * line, in either order and never twice. Reading an unknown two-key block as
 * metadata would silently drop text a person wrote, and guessing which line was
 * meant is worse than keeping the whole file as the body.
 */
function frontMatterOf(lines: readonly string[]): FrontMatter | undefined {
  if (lines[0]?.trim() !== FRONT_MATTER_OPEN) return undefined;
  const bodyStart = lines[2]?.trim() === FRONT_MATTER_OPEN ? 3 : lines[3]?.trim() === FRONT_MATTER_OPEN ? 4 : undefined;
  if (bodyStart === undefined) return undefined;
  let language: string | undefined;
  let languageSeen = false;
  let name: string | undefined;
  let nameSeen = false;
  for (const line of lines.slice(1, bodyStart - 1)) {
    const text = line.trim();
    const languageMatch = LANGUAGE_LINE.exec(text);
    if (languageMatch !== null && !languageSeen) {
      language = languageMatch[1];
      languageSeen = true;
      continue;
    }
    const nameMatch = NAME_LINE.exec(text);
    if (nameMatch !== null && !nameSeen) {
      // An empty value is a name line with no name, not an unknown key: that is
      // how a person clears the name by hand.
      const trimmed = (nameMatch[1] ?? "").trim();
      name = trimmed === "" ? undefined : trimmed;
      nameSeen = true;
      continue;
    }
    // A three-line block is the shape every file had before the name line
    // existed, so an unread middle line keeps its old reading: the markers are
    // stripped and nothing is named. A four-line block has no such past, and an
    // unread key line in it still makes the whole file the body.
    if (bodyStart === 3) return { bodyStart };
    return undefined;
  }
  return { language, name, bodyStart };
}

/** The absolute path of the personality file: `personality.file`, under the home when relative. */
export function personalityPath(paths: Pick<Paths, "home">, file: string): string {
  const configured = file.length === 0 ? DEFAULT_PERSONALITY_FILE : file;
  return isAbsolute(configured) ? configured : join(paths.home, configured);
}

/** Split a document into its front matter and the body that follows it. */
export function parsePersonality(raw: string): PersonalityDocument | undefined {
  const lines = raw.split("\n");
  const frontMatter = frontMatterOf(lines);
  const body = frontMatter === undefined ? raw : lines.slice(frontMatter.bodyStart).join("\n");
  const text = body.trim();
  if (text.length === 0) return undefined;
  const named = frontMatter?.language;
  const languageNamed = named === "en" || named === "ko";
  return {
    language: languageNamed ? (named as PersonalityLanguage) : "en",
    languageNamed,
    ...(frontMatter?.name === undefined ? {} : { name: frontMatter.name }),
    body: text,
  };
}

/**
 * A document as the file holds it: the front matter, then the body.
 *
 * The name line follows the language line, and it is written only when a name is
 * given: a file with no name reads the same as a file this release wrote before
 * the name line existed.
 */
export function renderPersonalityFile(language: PersonalityLanguage, body: string, name?: string): string {
  const named = name !== undefined && name.trim() !== "" ? `name: ${name.trim()}\n` : "";
  return `${FRONT_MATTER_OPEN}\nlanguage: ${language}\n${named}${FRONT_MATTER_OPEN}\n${body}\n`;
}

/**
 * The body of a document a caller is registering.
 *
 * A caller may paste a document that already carries front matter. The language
 * then comes from the tool argument, not from the pasted file, so the front
 * matter is dropped instead of being written inside the body.
 */
export function personalityBodyOf(content: string): string {
  const lines = content.split("\n");
  const frontMatter = frontMatterOf(lines);
  if (frontMatter !== undefined) return lines.slice(frontMatter.bodyStart).join("\n").trim();
  return content.trim();
}

/**
 * The stamp that tells an unchanged file from a changed one.
 *
 * A section renders on every request, so the file is read on every request
 * unless this stamp says nothing moved. `mtimeMs`, size, and inode together
 * change on any ordinary edit. The value a request carries is decided by the
 * session seal in the core, never by this read: a read that misses a change here
 * means the change is announced one edit later, not that the prompt moves.
 */
interface CacheEntry {
  readonly stamp: string;
  readonly document: PersonalityDocument | undefined;
}

const cache = new Map<string, CacheEntry>();

/** Forget a path, so the next read reflects a write this process just made. */
export function forgetPersonality(path: string): void {
  cache.delete(path);
}

/** The registered personality at `path`, or `undefined` when there is none. */
export async function readPersonalityFile(path: string): Promise<PersonalityDocument | undefined> {
  let stamp: string;
  try {
    const info = await stat(path);
    stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    // A missing file is the normal "not registered yet" case. Any other stat
    // failure degrades to the same answer rather than breaking the request.
    cache.delete(path);
    return undefined;
  }
  const cached = cache.get(path);
  if (cached !== undefined && cached.stamp === stamp) return cached.document;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // The file moved between the stat and the read. Leave the cache alone so the
    // next request tries again.
    return undefined;
  }
  const document = parsePersonality(raw);
  cache.set(path, { stamp, document });
  return document;
}

/**
 * Write the document with the front matter, at mode 0600, through a temp file.
 *
 * The temp file and the rename are the old extension's rule and they still hold:
 * a reader never sees half a document, and a personality file is personal text,
 * so it is not world-readable.
 */
export async function writePersonalityFile(
  path: string,
  language: PersonalityLanguage,
  body: string,
  name?: string,
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, renderPersonalityFile(language, body, name), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  forgetPersonality(path);
}
