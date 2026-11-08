/**
 * The one place this dashboard turns text into HTML.
 *
 * Three kinds of text arrive here, and all three are somebody else's words: a
 * pull request's description, its comments and reviews, the comments of a review
 * thread, and one line of a diff. GitHub renders the first two as markdown and
 * lets an author write raw HTML inside them, so the page has to do the same and
 * still not run the author's code. The order below is the whole answer to that:
 *
 * 1. markdown-it turns the text into HTML with `html: true`, so a `<details>`
 *    block an author wrote is kept as an element, `linkify` turns a URL that the
 *    author typed into a link, and `breaks` keeps one source newline a line
 *    break, as GitHub does.
 * 2. Two rules are added to markdown-it itself, so no new package comes in: a
 *    mention (`@login`) becomes a highlighted span, and a task list (`- [ ]`,
 *    `- [x]`) becomes a checkbox that is always disabled.
 * 3. A fenced code block whose info string names a language is highlighted with
 *    highlight.js. Only the common language bundle is imported, so the page does
 *    not carry every grammar the package ships.
 * 4. The result is read back by the browser's own HTML parser and every element
 *    the allowlist does not name is dropped, with a fixed attribute allowlist.
 *    A `script` is removed with its content, an element the
 *    list does not know is unwrapped so its words stay, and a link or an image
 *    keeps its destination only when the scheme is one of the allowed ones.
 * 5. Only after that walk does each `<pre>` get its copy button. A button an
 *    author wrote cannot survive step 4, so a copy button on the page is always
 *    the page's own, and a reader can trust that pressing it copies code.
 *
 * What the diff page needs is here too, and for the same reason: one highlighted
 * line of a file is HTML as well. {@link highlightLine} answers it, and
 * {@link CodeHtml} is the only component that puts highlighted HTML on a page.
 *
 * `test/ui/source-rules.ts` allows the two HTML-string constructs (`innerHTML`
 * and `dangerouslySetInnerHTML`) in this file and in the older markdown
 * component, and nowhere else; that is why the markup of this dashboard is built
 * here rather than in each card.
 */
import MarkdownIt from "markdown-it";
import type { StateCore, StateInline } from "markdown-it";
import hljs from "highlight.js/lib/common";
import { useMemo } from "preact/hooks";

/* ------------------------------------------------------------------ escaping */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** `text` with the five characters that could end an element or a string entity-escaped. */
export function escapeHtml(text: string): string {
  return String(text ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/* ------------------------------------------------- syntax highlighting (lines) */

/** The longest line that is highlighted; a longer one is only escaped. */
export const MAX_HIGHLIGHT_LENGTH = 1000;

/**
 * The language of a file, from its name, in the original's table.
 *
 * The answer is a name highlight.js knows, or `null`. The table names a few
 * languages the common bundle leaves out (`cmake`, `dockerfile`, `protobuf`), and
 * those answer `null` rather than a name that would throw on the first line: a
 * diff of a `Dockerfile` then reads as plain text, which is what the original did
 * with the same bundle.
 */
const LANGUAGES_BY_EXTENSION: Readonly<Record<string, string>> = {
  rs: "rust",
  py: "python",
  pyi: "python",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cu: "cpp",
  java: "java",
  kt: "kotlin",
  go: "go",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  html: "xml",
  xml: "xml",
  css: "css",
  sql: "sql",
  proto: "protobuf",
  cmake: "cmake",
  dockerfile: "dockerfile",
  swift: "swift",
};

/**
 * One of the names in the table, if the bundle carries its grammar.
 *
 * A name highlight.js does not know is `null`, never the name itself: everything
 * downstream reads the answer as "highlight this with that grammar or not at all".
 */
function knownLanguage(name: string | null | undefined): string | null {
  if (name === null || name === undefined || name === "") return null;
  return hljs.getLanguage(name) === undefined ? null : name;
}

/** The language of one file path, or `null` for a file the table does not know. */
export function languageForPath(path: string | null | undefined): string | null {
  const base = String(path ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return knownLanguage("dockerfile");
  if (base === "cmakelists.txt") return knownLanguage("cmake");
  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot + 1);
  return knownLanguage(LANGUAGES_BY_EXTENSION[extension]);
}

/**
 * One line of a diff as HTML: highlighted when `language` is known, escaped
 * otherwise.
 *
 * A line longer than {@link MAX_HIGHLIGHT_LENGTH} characters is escaped without
 * highlighting. A minified bundle is one such line, and highlighting it costs
 * more than the colour is worth, which is the rule the original applied. A line
 * that the grammar cannot read is escaped as well, so one odd edit cannot take
 * the page with it.
 */
export function highlightLine(text: string, language: string | null | undefined): string {
  const source = String(text ?? "");
  const name = knownLanguage(language);
  if (name === null || source.length > MAX_HIGHLIGHT_LENGTH) return escapeHtml(source);
  try {
    return hljs.highlight(source, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(source);
  }
}

/* ------------------------------------------------------------ markdown rules */

/** A GitHub login, from the `@` that starts it. */
const MENTION = /^@([A-Za-z0-9][A-Za-z0-9-]*)/;

/** How much source one mention rule reads at a time, which bounds a long word. */
const MENTION_WINDOW = 128;

/**
 * `@login` as a highlighted span.
 *
 * The rule sits after `linkify`, and a mention has to start a word: an `@` that
 * follows a letter or a digit is part of a longer word, and in practice it is an
 * email address, which the link rule already turned into a `mailto:` link. Without
 * that check `me@example.com` would lose its domain to a mention.
 */
function mentionRule(state: StateInline, silent: boolean): boolean {
  const before = state.pos === 0 ? "" : (state.src[state.pos - 1] ?? "");
  if (/[A-Za-z0-9]/.test(before)) return false;
  const match = MENTION.exec(state.src.slice(state.pos, state.pos + MENTION_WINDOW));
  if (match === null) return false;
  if (!silent) {
    const token = state.push("mention", "span", 0);
    token.content = match[1] ?? "";
  }
  state.pos += match[0].length;
  return true;
}

/** The start of a task list item, as markdown-it hands the item's inline text over. */
const TASK_ITEM = /^\[([ xX])\](?:[ \t]|$)/;

/**
 * `- [ ]` and `- [x]` as a checkbox at the start of a list item.
 *
 * The checkbox is written as a raw `input` with `disabled`, and the sanitizer
 * forces `disabled` again: a task list is a record of what is done, and pressing
 * one on GitHub's own page would not change the markdown either.
 */
function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.type !== "inline") continue;
    if (tokens[index - 1]?.type !== "paragraph_open") continue;
    if (tokens[index - 2]?.type !== "list_item_open") continue;
    const children = token.children;
    const first = children?.[0];
    if (children === null || children === undefined || first === undefined) continue;
    if (first.type !== "text") continue;
    const match = TASK_ITEM.exec(first.content);
    if (match === null) continue;
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox"${match[1] === " " ? "" : " checked"} disabled>`;
    first.content = first.content.slice(match[0].length);
    children.unshift(box);
    if (first.content === "") children.splice(1, 1);
  }
}

/** One markdown-it instance, made once, and `null` when it could not be made. */
let markdown: InstanceType<typeof MarkdownIt> | null | undefined;

/** The renderer, with this dashboard's two rules and its two renderers. */
function markdownRenderer(): InstanceType<typeof MarkdownIt> | null {
  if (markdown !== undefined) return markdown;
  try {
    const created = new MarkdownIt({ html: true, linkify: true, breaks: true });
    created.inline.ruler.after("linkify", "mention", mentionRule);
    created.core.ruler.after("inline", "github_task_list", taskListRule);
    created.renderer.rules["mention"] = (tokens, index) => {
      const login = tokens[index]?.content ?? "";
      return `<span class="mention">@${escapeHtml(login)}</span>`;
    };
    created.renderer.rules["fence"] = (tokens, index) => {
      const token = tokens[index];
      if (token === undefined) return "";
      return `<pre class="md-code"><code>${highlightBlock(token.content, token.info)}</code></pre>\n`;
    };
    markdown = created;
  } catch {
    markdown = null;
  }
  return markdown;
}

/**
 * A fenced block of code as highlighted HTML.
 *
 * The info string names the language (` ```ts `), and a name the bundle does not
 * carry is looked up in the extension table, which is what the original did. A
 * block with no language at all is escaped, not guessed: an author who wrote no
 * language did not ask for colour.
 */
function highlightBlock(content: string, info: string): string {
  const raw = String(content ?? "");
  const declared = String(info ?? "").trim().toLowerCase().split(/\s/)[0] ?? "";
  const name = knownLanguage(declared) ?? knownLanguage(LANGUAGES_BY_EXTENSION[declared]);
  if (name === null) return escapeHtml(raw);
  try {
    return hljs.highlight(raw, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(raw);
  }
}

/* ------------------------------------------------------------------- the walk */

/** Elements that stay, with the attributes the next lists allow. */
const ALLOWED_TAGS = new Set([
  "DETAILS",
  "SUMMARY",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "DEL",
  "INS",
  "CODE",
  "PRE",
  "BR",
  "HR",
  "P",
  "UL",
  "OL",
  "LI",
  "A",
  "IMG",
  "BLOCKQUOTE",
  "KBD",
  "SUP",
  "SUB",
  "SPAN",
  "DIV",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "INPUT",
]);

/** Elements that go, and take their content with them. */
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM"]);

/** The tags whose `class` survives, because the stylesheet colours code by it. */
const CLASS_TAGS = new Set(["SPAN", "DIV", "PRE", "CODE", "TABLE"]);

/** A link destination this page will follow. */
const ALLOWED_HREF = /^(?:https?:|mailto:|#)/i;

/** An image the page will load. The dashboard's policy allows `https:` and no other scheme. */
const ALLOWED_IMAGE = /^https:/i;

/**
 * Whether one attribute stays on one element.
 *
 * The list is fixed, attribute for attribute, with one
 * difference: an image keeps a `src` only when the scheme is `https:`, because
 * the page's policy names `https:` images and nothing else.
 */
function keepAttribute(tag: string, name: string, value: string): boolean {
  if (name === "class") return CLASS_TAGS.has(tag);
  if (tag === "INPUT") return name === "type" || name === "checked" || name === "disabled";
  if (name === "align") return tag === "TD" || tag === "TH";
  if (name === "href") return tag === "A" && ALLOWED_HREF.test(value);
  if (name === "src") return tag === "IMG" && ALLOWED_IMAGE.test(value);
  if (name === "alt") return tag === "IMG";
  if (name === "open") return tag === "DETAILS";
  return false;
}

/**
 * `html` with every element the allowlist does not name taken out.
 *
 * The browser's parser builds the tree, so a malformed tag list is read the way a
 * browser reads it, and this walk then has elements rather than a string to judge.
 * A dropped element keeps nothing; an element the list does not know is unwrapped,
 * so the words around it stay in the sentence they were written in.
 */
function sanitizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll("*")]) {
    if (DROPPED_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    if (element.tagName === "INPUT" && element.getAttribute("type") !== "checkbox") {
      element.remove();
      continue;
    }
    if (element.tagName === "INPUT") element.setAttribute("disabled", "");
    for (const attribute of [...element.attributes]) {
      if (!keepAttribute(element.tagName, attribute.name.toLowerCase(), attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === "IMG" && element.getAttribute("src") === null) {
      // An image whose destination did not survive stays as its `alt` text: the
      // words the author wrote are information, and an `img` with no `src` makes
      // no request and reads as its own alternative text.
      element.setAttribute("alt", element.getAttribute("alt") ?? "");
    }
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener");
    }
  }
  return template.innerHTML;
}

/** What a copy button says, in its title and for a screen reader. */
const COPY_LABEL = "Copy to clipboard";

/**
 * `html` with a copy button at the top right of every code block.
 *
 * This runs after {@link sanitizeHtml}, and that order is the point: a `button`
 * an author wrote is unwrapped by the walk, so no button on the page came from
 * markdown, and the one a reader presses always copies the block it sits in.
 */
function withCopyButtons(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const pre of [...template.content.querySelectorAll("pre")]) {
    pre.classList.add("has-copy");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.title = COPY_LABEL;
    button.setAttribute("aria-label", COPY_LABEL);
    // A paperclip, and not an icon font: the
    // page loads no font it did not come with.
    button.textContent = "\u{1F4CE}";
    pre.prepend(button);
  }
  return template.innerHTML;
}

/* ----------------------------------------------------------------- rendering */

/** What a body says when it has no words, unless the caller says something else. */
const EMPTY_BODY = "No description provided.";

/**
 * One markdown text as HTML, ready for the walk and for the copy buttons.
 *
 * A text that the parser cannot read comes back as escaped text in a `<pre>`,
 * never as an exception: one unreadable comment must not take the page with it.
 */
export function renderMarkdownHtml(source: string | null | undefined, emptyText: string = EMPTY_BODY): string {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  if (text.trim() === "") return `<p><em>${escapeHtml(emptyText)}</em></p>`;
  const renderer = markdownRenderer();
  if (renderer === null) return `<pre>${escapeHtml(text)}</pre>`;
  try {
    return withCopyButtons(sanitizeHtml(renderer.render(text)));
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

/* -------------------------------------------------------------- copy buttons */

/** The clipboard, when the browser has one that a page may write to. */
function clipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  const found = navigator.clipboard;
  return found !== undefined && typeof found.writeText === "function" ? found : undefined;
}

/** What a reader sees when the press could not copy. */
const COPY_FAILED = "Copy failed: the clipboard is only available over HTTPS or on localhost.";

/**
 * Copy one code block, and say so on its button.
 *
 * The button keeps the `copied` mark until the next press on any copy button of
 * the page, which is what the mark means: the last block this reader copied. A
 * timer would need one, and a page that sets a timer from a component is what the
 * source rules forbid, so the mark is cleared by the next press rather than by
 * the clock.
 */
async function copyCode(button: HTMLElement): Promise<void> {
  const pre = button.closest("pre");
  if (pre === null) return;
  const copy = pre.cloneNode(true) as Element;
  for (const own of [...copy.querySelectorAll("button.code-copy")]) own.remove();
  const text = copy.textContent ?? "";
  const board = clipboard();
  if (board === undefined) {
    button.title = COPY_FAILED;
    return;
  }
  try {
    await board.writeText(text);
    button.classList.add("copied");
    button.title = "Copied";
  } catch {
    button.title = COPY_FAILED;
  }
}

/** One press anywhere in a markdown body, answered when it landed on a copy button. */
function handleMarkdownClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button.code-copy");
  if (!(button instanceof HTMLElement)) return;
  for (const marked of document.querySelectorAll("button.code-copy.copied")) marked.classList.remove("copied");
  void copyCode(button);
}

/* ---------------------------------------------------------------- components */

export interface MarkdownBodyProps {
  /** The markdown source, as GitHub states it. */
  readonly source: string | null | undefined;
  /**
   * A class for the element the body is drawn into.
   *
   * The dashboard's stylesheet colours markdown under `.comment-body`, so a card
   * that wants those rules passes that class and gets the element the original
   * had in the same place.
   */
  readonly class?: string;
  /** What the body says when it has no words. */
  readonly empty?: string;
}

/**
 * One markdown body, drawn into a div of its own.
 *
 * The HTML is memoised on the text, and Preact skips a `dangerouslySetInnerHTML`
 * whose string did not change, so a redraw of the card leaves the code blocks, a
 * reader's selection and the scroll position inside the body alone.
 */
export function MarkdownBody({ source, class: className, empty }: MarkdownBodyProps) {
  const html = useMemo(() => renderMarkdownHtml(source, empty), [source, empty]);
  const classes = className === undefined ? "md-body" : `md-body ${className}`;
  return <div class={classes} dangerouslySetInnerHTML={{ __html: html }} onClick={handleMarkdownClick} />;
}

export interface CodeHtmlProps {
  /** Highlighted HTML, as {@link highlightLine} answers it. */
  readonly html: string;
  /** A class for the span the HTML is drawn into. */
  readonly class?: string;
  /** The same, in the spelling Preact also takes, so a caller may use either. */
  readonly className?: string;
}

/**
 * Highlighted code as the page draws it, which is one inline span.
 *
 * `html` must come from {@link highlightLine} or from the highlighted body above:
 * this component puts a string into the page as it is, and it exists so that no
 * component that draws a line of a diff has to do that itself.
 */
export function CodeHtml({ html, class: cls, className }: CodeHtmlProps) {
  return <span class={cls ?? className} dangerouslySetInnerHTML={{ __html: html }} />;
}
