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
 * - Every link carries `rel="noopener noreferrer"`. A link whose address does
 *   not start with `#` also carries `target="_blank"`, so a press opens a new
 *   tab and the page keeps its place; this holds for outside addresses, bare
 *   URLs and the page's own routes alike. A `#` link stays in the same tab.
 *   Markdown-it's own link validation still refuses `javascript:` and the other
 *   dangerous schemes.
 *
 * - An image whose address is a rich page route (`<mount>/rich-pages/<ULID>`) is
 *   drawn as a sandboxed frame with a caption and a link that opens the page in a
 *   new tab. Any other image stays an `<img>`. `html: false` stays: a raw
 *   `<iframe>` in a message is text, and only that image tag makes a frame.
 * - With `deferMedia`, an image and a page frame carry `data-defer-src` and no
 *   `src`, and the chat's observers load them near the view (`deferred-media.ts`).
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
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { at, mount } from "../mount.ts";
import {
  DEFER_ATTRIBUTE,
  DEFER_PENDING_CLASS,
  deferredElementsIn,
  registerDeferredMedia,
  unregisterDeferredMedia,
} from "../chat/transcript/deferred-media.ts";
import { installRichPageFrameListener, RICH_PAGE_FRAME_CLASS } from "./rich-page-frames.ts";

/** What a render call carries through the markdown-it `env` argument. */
type RenderEnv = {
  readonly deferMedia?: boolean;
};

/** The address of a rich page: a path that ends in `/rich-pages/<ULID>`, with any mount before it. */
const RICH_PAGE_ADDRESS = /^(?:\/[^?#\s]*)?\/rich-pages\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;

/** The flags of a page frame. Same text as the server's shell. */
const RICH_PAGE_SANDBOX = "allow-scripts allow-forms";

/** One markdown-it instance, made once; `null` when it could not be made. */
let renderer: InstanceType<typeof MarkdownIt> | null | undefined;

/** A route under the mount, unless it already carries it. */
function mountedHref(href: string): string {
  const base = mount().base;
  if (base === "" || href === base || href.startsWith(`${base}/`)) return href;
  return at(href);
}

/** One rich page as markup: the frame and its caption. Every inserted value is escaped. */
function richPageHtml(id: string, title: string, env: RenderEnv | undefined): string {
  installRichPageFrameListener();
  const frame = escapeMarkdownText(at(`/rich-pages/${id}/frame`));
  const page = escapeMarkdownText(at(`/rich-pages/${id}`));
  const text = escapeMarkdownText(title);
  const source = env?.deferMedia === true ? DEFER_ATTRIBUTE : "src";
  return (
    `<span class="rich-page">` +
    `<iframe class="${RICH_PAGE_FRAME_CLASS}" ${source}="${frame}" sandbox="${RICH_PAGE_SANDBOX}" referrerpolicy="no-referrer" loading="lazy" title="${text}"></iframe>` +
    `<span class="rich-page-caption"><span class="rich-page-label">Generated page</span> ${text} ` +
    `<a href="${page}" target="_blank" rel="noopener noreferrer">Open in new tab ↗</a></span>` +
    `</span>`
  );
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
        const final = token.attrGet("href");
        if (typeof final === "string" && !final.startsWith("#")) token.attrSet("target", "_blank");
      }
      return previous !== undefined
        ? previous(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options);
    };
    const previousImage = created.renderer.rules.image;
    created.renderer.rules.image = (tokens, index, options, env, self) => {
      const flags = env as RenderEnv | undefined;
      const token = tokens[index];
      const src = token?.attrGet("src");
      if (token !== undefined && typeof src === "string") {
        const page = src.startsWith("//") ? null : RICH_PAGE_ADDRESS.exec(src);
        if (page !== null) return richPageHtml(page[1]!, self.renderInlineAsText(token.children ?? [], options, env), flags);
        if (flags?.deferMedia === true) {
          token.attrs = (token.attrs ?? []).filter((attribute) => attribute[0] !== "src");
          token.attrSet(DEFER_ATTRIBUTE, src);
          token.attrSet("class", DEFER_PENDING_CLASS);
        }
      }
      return previousImage !== undefined
        ? previousImage(tokens, index, options, env, self)
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
export function renderMarkdownHtml(text: string, options: { readonly deferMedia?: boolean } = {}): string {
  const source = String(text ?? "");
  const markdown = markdownRenderer();
  if (markdown === null) return `<p>${escapeMarkdownText(source)}</p>`;
  try {
    const env: RenderEnv = { deferMedia: options.deferMedia === true };
    return markdown.render(source, env);
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
  /** The chat sets this: images and page frames load near the visible part only. */
  readonly deferMedia?: boolean;
}

/**
 * A text drawn as markdown into the element the page needs there.
 *
 * The tag is a prop because the page's CSS is written against it: the transcript
 * bubble is a `div.message`, and a report body is an `article.report-body`. The
 * component is that element rather than a child of it, so the markup the pages
 * draw is the markup they drew before.
 */
export function Markdown({ text, tag = "div", class: className, id, deferMedia }: MarkdownProps) {
  const html = useMemo(() => renderMarkdownHtml(text, { deferMedia: deferMedia === true }), [text, deferMedia]);
  const host = useRef<HTMLElement>(null);
  // After each change of the HTML, hand the deferred elements to the observers,
  // and forget the old ones when the HTML is replaced or the row goes away.
  useLayoutEffect(() => {
    if (deferMedia !== true || host.current === null) return undefined;
    const found = deferredElementsIn(host.current);
    for (const element of found) registerDeferredMedia(element);
    return () => {
      for (const element of found) unregisterDeferredMedia(element);
    };
  }, [html, deferMedia]);
  const Tag = tag as "div";
  return <Tag ref={host as never} class={className} id={id} dangerouslySetInnerHTML={{ __html: html }} />;
}
