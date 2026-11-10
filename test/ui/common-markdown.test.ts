// @vitest-environment jsdom
/**
 * The markdown component: what a message, a report body and a review card are
 * drawn as.
 *
 * These assertions came from the page tests that ran the old scripts
 * (`test/web-ui.test.ts` "markdown", and the report viewer's own rendering), and
 * they are the contract the pages rely on: a pipe table with per-column
 * alignment, prose that only contains pipes, raw HTML kept as text, lists,
 * quotes and rules, a bare URL linked, a `javascript:` URL not linked, and every
 * link carrying `rel="noopener noreferrer"`.
 *
 * Two things are checked here that no page test could see:
 *
 * - a route-shaped link gets the mount prefix, which the chat page did and the
 *   report viewer did not (both pages now share this component);
 * - a re-render with the same text leaves the element and the selection inside it
 *   alone, because the requirement is that an update does not reset what the
 *   reader was doing.
 *
 * The mount is stamped before the module is imported, because the module resolves
 * it once. Everything else is the component drawn into a plain element.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";

type MarkdownModule = typeof import("../../src/ui/components/markdown.tsx");

let Markdown: MarkdownModule["Markdown"];
let renderMarkdownHtml: MarkdownModule["renderMarkdownHtml"];

beforeAll(async () => {
  const meta = document.createElement("meta");
  meta.name = "pi-sec-base";
  meta.content = "/sec";
  document.head.append(meta);
  const module = await import("../../src/ui/components/markdown.tsx");
  Markdown = module.Markdown;
  renderMarkdownHtml = module.renderMarkdownHtml;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("markdown-it");
  vi.resetModules();
});

/** The component drawn with one text, answering the element it drew into. */
function draw(text: string, props: { tag?: "div" | "article"; class?: string; id?: string } = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  render(h(Markdown, { text, ...props }), host);
  return host;
}

/** The component's own element, which is the first child of the host. */
function drawn(host: HTMLElement): HTMLElement {
  const element = host.firstElementChild;
  if (element === null) throw new Error("the component drew nothing");
  return element as HTMLElement;
}

describe("markdown", () => {
  it("renders a pipe table with a header and per-column alignment", () => {
    const message = drawn(
      draw(
        ["| job | state | runs |", "| :--- | :---: | ---: |", "| routine-b | active | 12 |", "| brief | done | 3 |"].join(
          "\n",
        ),
      ),
    );

    expect(message.querySelectorAll("table").length).toBe(1);
    expect(message.querySelectorAll("th").length).toBe(3);
    expect(message.querySelectorAll("tbody tr").length).toBe(2);
    expect(message.querySelector("th")?.textContent).toBe("job");
    expect(message.querySelector("th")?.getAttribute("style")).toContain("left");
    expect(message.querySelectorAll("th")[2]?.getAttribute("style")).toContain("right");
    expect(message.querySelectorAll("tbody td")[5]?.textContent).toBe("3");
  });

  it("keeps a line that merely contains pipes as prose", () => {
    const message = drawn(draw("use a | b to pipe"));
    expect(message.querySelector("table")).toBeNull();
    expect(message.textContent).toContain("use a | b to pipe");
  });

  it("marks up cells but never lets a message become markup", () => {
    const message = drawn(draw("| a | b |\n| --- | --- |\n| `code` | <img src=x onerror=alert(1)> |"));

    expect(message.querySelector("td code")?.textContent).toBe("code");
    expect(message.querySelector("img")).toBeNull();
    expect(message.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders ordered lists, quotes and rules", () => {
    const message = drawn(draw(["1. first", "2. second", "", "> quoted one", "> quoted two", "", "---", "", "- back to bullets"].join("\n")));

    expect(message.querySelectorAll("ol li").length).toBe(2);
    expect(message.querySelector("blockquote")?.textContent).toContain("quoted one");
    expect(message.querySelector("blockquote")?.textContent).toContain("quoted two");
    expect(message.querySelector("hr")).not.toBeNull();
    // A bullet run after a rule is its own list, not part of the ordered one.
    expect(message.querySelectorAll("ul li").length).toBe(1);
  });

  it("renders what a hand-rolled renderer could not", () => {
    const message = drawn(draw(["- top", "  - nested", "", "~~struck~~"].join("\n")));

    expect(message.querySelectorAll("ul ul li").length).toBe(1);
    expect(message.querySelector("s")?.textContent).toBe("struck");
  });

  it("autolinks a bare URL and never links a javascript: one", () => {
    const message = drawn(draw("[click](javascript:alert(1)) and <https://example.com>"));

    expect(message.querySelectorAll("a").length).toBe(1);
    expect(message.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(message.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(message.textContent).toContain("javascript:alert(1)");
  });

  it("puts the mount on a route-shaped link, and not twice on one that carries it", () => {
    const message = drawn(draw("[one](/report/plan) and [two](/sec/api/share/a.txt) and [three](https://example.com/x)"));

    expect([...message.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/sec/report/plan",
      "/sec/api/share/a.txt",
      "https://example.com/x",
    ]);
    for (const link of message.querySelectorAll("a")) expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens every link but a # link in a new tab", () => {
    const message = drawn(draw("[out](https://example.com/a) and https://example.org/b and [route](/report/x) and [here](#x)"));
    const links = [...message.querySelectorAll("a")];

    expect(links.length).toBe(4);
    for (const link of links.slice(0, 3)) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(links[3]?.getAttribute("href")).toBe("#x");
    expect(links[3]?.hasAttribute("target")).toBe(false);
  });

  it("draws into the element the surrounding markup needs", () => {
    const article = drawn(draw("# Plan\n\nbody", { tag: "article", class: "report-body", id: "report-body" }));

    expect(article.tagName).toBe("ARTICLE");
    expect(article.className).toBe("report-body");
    expect(article.id).toBe("report-body");
    expect(article.querySelector("h1")?.textContent).toBe("Plan");
  });

  it("answers the same HTML as a string, for a caller that draws it elsewhere", () => {
    expect(renderMarkdownHtml("<b>x</b>")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>\n");
    expect(renderMarkdownHtml("**bold**")).toBe("<p><strong>bold</strong></p>\n");
  });

  it("shows an unreadable text as escaped text in a paragraph", async () => {
    // The parser is made at first use; a build that throws must leave the page
    // showing what was said rather than nothing at all.
    vi.resetModules();
    vi.doMock("markdown-it", () => ({
      default: class {
        constructor() {
          throw new Error("no parser");
        }
      },
    }));
    const broken = (await import("../../src/ui/components/markdown.tsx")) as MarkdownModule;
    expect(broken.renderMarkdownHtml("<b>hi</b> & bye")).toBe("<p>&lt;b&gt;hi&lt;/b&gt; &amp; bye</p>");
  });
});

describe("markdown without a reset", () => {
  it("leaves the elements and the selection alone when the same text is drawn again", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(h(Markdown, { text: "one **two** three" }), host);

    const paragraph = host.querySelector("p");
    const strong = host.querySelector("strong");
    const bold = strong?.firstChild ?? null;
    expect(paragraph).not.toBeNull();
    expect(bold).not.toBeNull();

    // A reader selected part of the bold word.
    const range = document.createRange();
    range.setStart(bold as Node, 1);
    range.setEnd(bold as Node, 3);
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection?.removeAllRanges();
    selection?.addRange(range);

    render(h(Markdown, { text: "one **two** three" }), host);

    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("strong")).toBe(strong);
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.anchorNode).toBe(bold);
    expect(selection?.anchorOffset).toBe(1);
    expect(selection?.focusOffset).toBe(3);
  });

  it("draws the new text when the text changes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(h(Markdown, { text: "first" }), host);
    const paragraph = host.querySelector("p");

    render(h(Markdown, { text: "second **one**" }), host);

    expect(host.textContent?.trim()).toBe("second one");
    expect(host.querySelector("strong")?.textContent).toBe("one");
    expect(paragraph?.textContent).toBe("first");
  });
});

describe("markdown: rich page tags", () => {
  const ID = "01TEST0000000000000000000A";

  it("draws a page tag as a sandboxed frame with a caption and a new-tab link, under the mount", () => {
    const message = drawn(draw(`![Weekly calls](/rich-pages/${ID})`));
    const frame = message.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(`/sec/rich-pages/${ID}/frame`);
    expect(frame?.hasAttribute("data-defer-src")).toBe(false);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("title")).toBe("Weekly calls");
    expect(message.querySelector(".rich-page-label")?.textContent).toBe("Generated page");
    const link = message.querySelector(".rich-page-caption a");
    expect(link?.getAttribute("href")).toBe(`/sec/rich-pages/${ID}`);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(message.querySelector("img")).toBeNull();
    // The block sits inside the paragraph, so the wrappers are spans.
    expect(message.querySelector("p > .rich-page")).not.toBeNull();
  });

  it("rebuilds an address that already carries a prefix under the page's own mount", () => {
    const message = drawn(draw(`![t](/other/prefix/rich-pages/${ID}/)`));
    expect(message.querySelector("iframe")?.getAttribute("src")).toBe(`/sec/rich-pages/${ID}/frame`);
  });

  it("keeps a non-ULID id, an absolute address and a normal image as images", () => {
    const message = drawn(
      draw(
        [
          "![a](/rich-pages/not-a-ulid)",
          `![b](https://example.com/rich-pages/${ID})`,
          `![c](//example.com/rich-pages/${ID})`,
          "![d](/api/share/shot.png)",
        ].join("\n\n"),
      ),
    );
    expect(message.querySelectorAll("iframe").length).toBe(0);
    expect(message.querySelectorAll("img").length).toBe(4);
    expect(message.querySelectorAll("img")[3]?.getAttribute("src")).toBe("/api/share/shot.png");
    expect(message.querySelectorAll("[data-defer-src]")).toHaveLength(0);
  });

  it("escapes a title with a quote and an angle bracket", () => {
    const message = drawn(draw(`![a "q" <b>x</b>](/rich-pages/${ID})`));
    const frame = message.querySelector("iframe");
    expect(frame?.getAttribute("title")).toBe('a "q" <b>x</b>');
    expect(message.querySelector("b")).toBeNull();
    expect(message.querySelectorAll("iframe").length).toBe(1);
  });

  it("keeps a raw iframe in the text as text", () => {
    const message = drawn(draw('<iframe src="/rich-pages/x"></iframe>'));
    expect(message.querySelector("iframe")).toBeNull();
    expect(message.textContent).toContain("<iframe");
  });
});

