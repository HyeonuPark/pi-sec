/**
 * The source rules the page code is held to, and the way to check a tree
 * against them.
 *
 * The rule is that page code never replaces a region wholesale, so
 * the one thing that can reset what the user did cannot come back through a
 * convenient `innerHTML`. The rule that the request function is the only place
 * that calls `fetch`, and that a stream is opened only by the stream client,
 * keeps those two seams real instead of copied around the pages.
 *
 * A check reads code, not text: comments and the inside of string literals are
 * blanked first, so a sentence about `innerHTML` in a comment is not a finding.
 * The quotes of a literal stay, so `textContent = ""` is still visible as an
 * assignment of an empty string. Blanking keeps every newline, so a reported line
 * is the line the reader will find. A regular expression literal is read as code;
 * page code must not write one that carries a quote or a comment marker.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, from this file's place in `test/ui/`. */
export const defaultRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The one component that may draw HTML from a string, when it exists. */
export const MARKDOWN_COMPONENT = "src/ui/components/markdown.tsx";

/**
 * The pull request dashboard's own markdown module, which may draw HTML too.
 *
 * It renders GitHub's markdown, an author's raw HTML inside a comment and one
 * highlighted line of a diff, so it is the second file that puts a string into
 * the page. Its allowlist walk is what keeps that safe, and the rule that the
 * walk must exist is `test/ui/github-pr-markdown.test.ts`.
 */
export const GITHUB_PR_HTML = "src/ui/github-pr/html.tsx";

/** Whether a file may put an HTML string into the page. */
export function mayDrawHtml(file: string): boolean {
  return file === MARKDOWN_COMPONENT || file === GITHUB_PR_HTML;
}

/** One place in one file that breaks a rule. */
export interface SourceViolation {
  /** The file, relative to the repository root, with `/` separators. */
  readonly file: string;
  /** The rule's name, such as `innerHTML` or `fetch`. */
  readonly rule: string;
  /** The line the finding starts on, counting from 1. */
  readonly line: number;
  /** That line as it is written, trimmed. */
  readonly text: string;
}

interface Rule {
  readonly rule: string;
  readonly pattern: RegExp;
  /** Set when some file may use the construct. */
  readonly allowed?: (file: string) => boolean;
  /** Set when the name of a finding depends on what precedes the match. */
  readonly name?: (code: string, index: number) => string;
}

/** Timers belong to the stream client and to the state helpers. */
function timerAllowed(file: string): boolean {
  return file.startsWith("src/ui/streams/") || file.startsWith("src/ui/state/");
}

const RULES: readonly Rule[] = [
  { rule: "innerHTML", pattern: /\binnerHTML\b/g, allowed: mayDrawHtml },
  { rule: "outerHTML", pattern: /\bouterHTML\b/g },
  { rule: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/g },
  { rule: "replaceChildren", pattern: /\breplaceChildren\b/g },
  {
    rule: "dangerouslySetInnerHTML",
    pattern: /\bdangerouslySetInnerHTML\b/g,
    allowed: mayDrawHtml,
  },
  { rule: "empty textContent", pattern: /\.textContent\s*=\s*(?:""|'')/g },
  { rule: "eval", pattern: /(?<![.\w$])eval\s*\(/g },
  {
    rule: "Function",
    pattern: /(?<![.\w$])Function\s*\(/g,
    name: (code, index) => (/new\s+$/.test(code.slice(Math.max(0, index - 8), index)) ? "new Function" : "Function"),
  },
  { rule: "fetch", pattern: /(?<![.\w$])fetch\s*\(/g, allowed: (file) => file.startsWith("src/ui/api/") },
  {
    rule: "new EventSource",
    pattern: /\bnew\s+EventSource\s*\(/g,
    allowed: (file) => file.startsWith("src/ui/streams/"),
  },
  { rule: "setTimeout", pattern: /\bsetTimeout\s*\(/g, allowed: timerAllowed },
  { rule: "setInterval", pattern: /\bsetInterval\s*\(/g, allowed: timerAllowed },
];

/** The same length as `text`, with comments and string literals blanked out. */
export function codeOnly(text: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        // The quote stays, so an empty literal is still an empty literal here,
        // and the text inside it is blanked.
        out.push(char);
        index += 1;
        continue;
      }
      out.push(char);
      index += 1;
      continue;
    }
    if (char === "\n") {
      if (state === "line") state = "code";
      out.push("\n");
      index += 1;
      continue;
    }
    if (state === "block" && char === "*" && next === "/") {
      state = "code";
      out.push("  ");
      index += 2;
      continue;
    }
    if (char === "\\" && (state === "single" || state === "double" || state === "template")) {
      // An escape keeps its newline, if it has one, and is blanked otherwise.
      const chunk = text.slice(index, index + 2);
      out.push(chunk.replace(/[^\n]/g, " "));
      index += chunk.length;
      continue;
    }
    if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
      state = "code";
      out.push(char);
      index += 1;
      continue;
    }
    out.push(" ");
    index += 1;
  }
  return out.join("");
}

/** One path, relative to the repository root, with `/` separators. */
export function normalizePath(file: string): string {
  const unified = file.split(sep).join("/");
  if (!unified.startsWith("/")) return unified;
  return relative(defaultRoot, unified).split(sep).join("/");
}

/** The line a finding starts on, and the text of that line. */
function locate(text: string, index: number): { line: number; text: string } {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, text: (text.split("\n")[line - 1] ?? "").trim() };
}

/** Every rule one file breaks. */
export function checkSource(file: string, text: string): SourceViolation[] {
  const path = normalizePath(file);
  const code = codeOnly(text);
  const found: SourceViolation[] = [];
  for (const rule of RULES) {
    if (rule.allowed?.(path) === true) continue;
    for (const match of code.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      const at = locate(text, index);
      found.push({
        file: path,
        rule: rule.name?.(code, index) ?? rule.rule,
        line: at.line,
        text: at.text,
      });
    }
  }
  found.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule));
  return found;
}

/** Every `.ts` and `.tsx` file under `src/ui/`, deepest last. */
async function pageFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await pageFiles(path)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** Every rule every page file breaks. */
export async function checkTree(root: string = defaultRoot): Promise<SourceViolation[]> {
  const violations: SourceViolation[] = [];
  for (const file of await pageFiles(join(root, "src/ui"))) {
    const text = await readFile(file, "utf8");
    violations.push(...checkSource(relative(root, file).split(sep).join("/"), text));
  }
  return violations;
}
