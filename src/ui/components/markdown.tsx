/**
 * The one place a markdown string becomes HTML in a page.
 *
 * The hand-written chat page and report page each built a markdown-it renderer
 * of their own (both removed in this commit); this component is that renderer,
 * once, for every page. The options
 * are the ones both pages ran with and they are load-bearing:
 *
 * - `html: false` keeps raw HTML in a message as text. The transcript renders
 *   model and tool output, so a `<img onerror=…>` in an answer must not become
 *   an element.
 * - `linkify: true` turns a bare URL into a link, and `breaks: true` keeps a
 *   single source newline a line break.
 * - A link written as a route (`/report/<slug>`, `/api/share/<name>`) gets the
 *   mount prefix, because the route belongs to the server and the reader may sit
 *   behind a path-prefix proxy. The hand-written chat page did this and its
 *   report page did not; every page gets it now, and
 *   `test/ui/common-markdown.test.ts` holds it.
 * - Every link carries `rel="noopener noreferrer"`, and markdown-it's own link
 *   validation still refuses `javascript:` and the other dangerous schemes.
 *
 * If the parser cannot be built, or throws on one text, the text is escaped into
 * a `<p>`: a page that cannot draw markdown still shows what was said, which is
 * what the hand-written pages did before it (both removed in this commit).
 *
 * This is the one file under `src/ui/` that may put an HTML string into the DOM
 * (`test/ui/state-and-sources.test.ts` holds the rest of the tree to that). The DOM is
 * written only when the HTML changes: Preact skips an identical
 * `dangerouslySetInnerHTML`, so a re-render with the same text leaves the
 * elements, the selection inside them, and the scroll position alone.
 */
import MarkdownIt from "markdown-it";
import { useMemo } from "preact/hooks";
import { at, mount } from "../mount.ts";

/** One markdown-it instance, made once; `null` when it could not be made. */
let renderer: InstanceType<typeof MarkdownIt> | null | undefined;

/** A route under the mount, unless it already carries it. */
function mountedHref(href: string): string {
  const base = mount().base;
  if (base === "" || href === base || href.startsWith(`${base}/`)) return href;
  return at(href);
}

/** The renderer, with the link rule both pages applied. */
function markdownRenderer(): InstanceType<typeof MarkdownIt> | null {
  if (renderer !== undefined) return renderer;
  try {
    const created = new MarkdownIt({ html: false, linkify: true, breaks: true });
    const previous = created.renderer.rules.link_open;
    created.renderer.rules.link_open = (tokens, index, options, env, self) => {
      const token = tokens[index];
      if (token !== undefined) {
        const href = token.attrGet("href");
        if (typeof href === "string" && href.startsWith("/")) token.attrSet("href", mountedHref(href));
        token.attrSet("rel", "noopener noreferrer");
      }
      return previous !== undefined
        ? previous(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options);
    };
    renderer = created;
  } catch {
    renderer = null;
  }
  return renderer;
}

/** A text as HTML, the way the page shows it when no parser can be had. */
export function escapeMarkdownText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * One markdown text as HTML.
 *
 * The text that a parser cannot read comes back as escaped text in a paragraph,
 * never as an exception: a row that cannot be parsed must not take the page with
 * it.
 */
export function renderMarkdownHtml(text: string): string {
  const source = String(text ?? "");
  const markdown = markdownRenderer();
  if (markdown === null) return `<p>${escapeMarkdownText(source)}</p>`;
  try {
    return markdown.render(source);
  } catch {
    return `<p>${escapeMarkdownText(source)}</p>`;
  }
}

/** The elements `Markdown` can draw into. The tag decides the CSS that applies. */
export type MarkdownTag = "div" | "article" | "section" | "p";

export interface MarkdownProps {
  /** The markdown source. The same text never redraws the element. */
  readonly text: string;
  /** The element to draw into; `div` unless the surrounding markup needs another. */
  readonly tag?: MarkdownTag;
  readonly class?: string;
  readonly id?: string;
}

/**
 * A text drawn as markdown into the element the page needs there.
 *
 * The tag is a prop because the page's CSS is written against it: the transcript
 * bubble is a `div.message`, and a report body is an `article.report-body`. The
 * component is that element rather than a child of it, so the markup the pages
 * draw is the markup they drew before.
 */
export function Markdown({ text, tag = "div", class: className, id }: MarkdownProps) {
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  const Tag = tag as "div";
  return <Tag class={className} id={id} dangerouslySetInnerHTML={{ __html: html }} />;
}
