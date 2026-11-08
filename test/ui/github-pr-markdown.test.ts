// @vitest-environment jsdom
/**
 * The markdown module of the pull request dashboard: what a comment, a review and
 * a description are allowed to draw.
 *
 * The module is the one file of this dashboard that puts an HTML string into the
 * page, and the rules below are the reason it may: an author writes markdown and
 * raw HTML, and the page must show it the way GitHub does and still not run the
 * author's code. Each test names one of those rules, and the tests that draw a
 * body read what the browser made of the string rather than the string itself, so
 * a change of markup that keeps the same elements is not a failure.
 *
 * The copy button is the one place where the order of the steps is visible: a
 * `button` written by an author does not survive the allowlist walk, so the button
 * a reader presses is always the page's own, and exactly one per code block.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { h, render } from "preact";

type HtmlModule = typeof import("../../src/ui/github-pr/html.tsx");

let html: HtmlModule;

/** A string as the page draws it, read back as elements. */
function draw(source: string | null | undefined, empty?: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.renderMarkdownHtml(source, empty);
  document.body.append(host);
  return host;
}

beforeEach(async () => {
  document.body.replaceChildren();
  html = await import("../../src/ui/github-pr/html.tsx");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("the elements an author may write", () => {
  it("drops a script with its content", () => {
    const host = draw("hello\n\n<script>window.pwned = true</script>\n\nbye");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).not.toContain("window.pwned");
    expect(host.textContent).toContain("hello");
    expect(host.textContent).toContain("bye");
    // Nothing ran: the walk read the string, it did not evaluate it.
    expect((window as unknown as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it("drops the other tags whose content is not prose", () => {
    const host = draw(
      [
        "<style>p{color:red}</style>",
        "<iframe src=\"https://example.com\"></iframe>",
        "<object data=\"x\"></object>",
        "<embed src=\"x\">",
        "<link rel=\"stylesheet\" href=\"https://example.com/x.css\">",
        "<meta http-equiv=\"refresh\" content=\"0\">",
        "<form action=\"/x\"><input type=\"text\" name=\"a\"><button>send</button></form>",
        "visible",
      ].join("\n\n"),
    );
    for (const tag of ["style", "iframe", "object", "embed", "link", "meta", "form", "button"]) {
      expect(host.querySelector(tag), tag).toBeNull();
    }
    expect(host.textContent).toContain("visible");
  });

  it("keeps details and summary, which a long comment folds itself with", () => {
    const host = draw("<details open><summary>What changed</summary>\n\nThe body.\n\n</details>");
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.getAttribute("open")).toBe("");
    expect(details?.querySelector("summary")?.textContent).toBe("What changed");
    expect(details?.textContent).toContain("The body.");
  });

  it("unwraps a tag the allowlist does not name and keeps its words", () => {
    const host = draw("<section><custom-thing>kept words</custom-thing></section>");
    expect(host.querySelector("section")).toBeNull();
    expect(host.querySelector("custom-thing")).toBeNull();
    expect(host.textContent).toContain("kept words");
  });

  it("keeps the formatting and the block tags a comment uses", () => {
    const host = draw(
      "<b>bold</b> <em>em</em> <code>code</code> <kbd>K</kbd> <sup>1</sup> <sub>2</sub>\n\n" +
        "<blockquote>quoted</blockquote>\n\n- one\n- two\n\n1. first\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
    for (const tag of ["b", "em", "code", "kbd", "sup", "sub", "blockquote", "ul", "ol", "hr", "table", "td"]) {
      expect(host.querySelector(tag), tag).not.toBeNull();
    }
  });
});

describe("the destinations an author may name", () => {
  it("keeps a link only for http, https, mailto and a fragment", () => {
    const host = draw(
      [
        "[https](https://example.com/x)",
        "[http](http://example.com/x)",
        "[mail](mailto:a@example.com)",
        "[fragment](#thread-abc)",
        "[script](javascript:alert(1))",
        "[data](data:text/html;base64,PHNjcmlwdD4=)",
        "[file](file:///etc/passwd)",
      ].join("\n\n"),
    );
    const hrefs = [...host.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? "");
    expect(hrefs).toEqual(["https://example.com/x", "http://example.com/x", "mailto:a@example.com", "#thread-abc"]);
    // markdown-it itself refuses `javascript:` before the walk sees it, and the
    // text stays text rather than becoming a link.
    expect(host.textContent).toContain("javascript:alert(1)");
  });

  it("opens a kept link in a new tab with no handle on this one", () => {
    const host = draw("[one](https://example.com/x)");
    const link = host.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  it("keeps a link an author wrote as raw HTML when its scheme is allowed", () => {
    const host = draw('<a href="https://example.com/raw">raw</a>');
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.com/raw");
  });

  it("keeps an image only when it is https, and keeps its alt text", () => {
    const host = draw(
      [
        "![https](https://example.com/a.png)",
        "![http](http://example.com/b.png)",
        '![raw](https://example.com/c.png "title")',
        '<img src="data:image/png;base64,AAAA" alt="data">',
        '<img src="http://example.com/d.png" alt="plain">',
      ].join("\n\n"),
    );
    // Every image is still on the page, and the three whose source did not
    // survive keep their alternative text and make no request.
    const images = [...host.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "https://example.com/a.png",
      null,
      "https://example.com/c.png",
      null,
      null,
    ]);
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["https", "http", "raw", "data", "plain"]);
  });
});

describe("a task list", () => {
  it("draws a checkbox that cannot be pressed", () => {
    const host = draw("- [ ] open item\n- [x] done item\n- plain item");
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.hasAttribute("checked"))).toEqual([false, true]);
    for (const box of boxes) expect(box.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("open item");
    expect(host.textContent).toContain("done item");
    expect(host.textContent).not.toContain("[ ]");
  });

  it("forces a checkbox an author wrote by hand to be disabled too", () => {
    const host = draw('<input type="checkbox"> <input type="checkbox" checked>');
    const boxes = [...host.querySelectorAll("input")];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box.hasAttribute("disabled")).toBe(true);
  });

  it("drops an input that is not a checkbox", () => {
    const host = draw('<input type="text" value="x"> <input type="submit">');
    expect(host.querySelector("input")).toBeNull();
  });
});

describe("the copy button of a code block", () => {
  it("is added after the walk, so an author cannot forge one", () => {
    const host = draw(
      ["```js", "const a = 1;", "```", "", "<button class=\"code-copy\">📎</button>", "", "<pre><button class=\"code-copy\">📎</button>echo hi</pre>"].join("\n"),
    );
    const buttons = [...host.querySelectorAll("button.code-copy")];
    // One per code block, both made by the module: the fenced block and the raw
    // `pre`. The author's own buttons were unwrapped before this step.
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toBe("Copy to clipboard");
      // Each one sits inside the block it copies and is the block's first child.
      const pre = button.closest("pre");
      expect(pre).not.toBeNull();
      expect(pre?.firstElementChild).toBe(button);
      expect(pre?.classList.contains("has-copy")).toBe(true);
    }
    // The words of the author's own button are not on the page at all: a button
    // is unwrapped, and a text node inside a `pre` stays text, so the count above
    // is the only thing that says how many buttons the page has.
    expect(buttons.filter((button) => button.closest("pre") === null)).toHaveLength(0);
  });

  it("copies the block without the button, and says so on the button", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      // The press is answered by the body's own handler, so the block is drawn
      // through the component rather than written into a plain element.
      const host = document.createElement("div");
      document.body.append(host);
      render(h(html.MarkdownBody, { source: "```js\nconst a = 1;\n```" }), host);
      const button = host.querySelector("button.code-copy");
      if (!(button instanceof HTMLElement)) throw new Error("no copy button");
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(written).toEqual(["const a = 1;\n"]);
      expect(button.classList.contains("copied")).toBe(true);
      expect(button.title).toBe("Copied");
    } finally {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("says the press failed when the page has no clipboard to write to", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(h(html.MarkdownBody, { source: "```js\nconst a = 1;\n```" }), host);
    const button = host.querySelector("button.code-copy");
    if (!(button instanceof HTMLElement)) throw new Error("no copy button");
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button.classList.contains("copied")).toBe(false);
    expect(button.title).toBe("Copy failed: the clipboard is only available over HTTPS or on localhost.");
  });
});

describe("a mention", () => {
  it("is a highlighted span", () => {
    const host = draw("thanks @octocat and @user-name!");
    const mentions = [...host.querySelectorAll(".mention")];
    expect(mentions.map((mention) => mention.textContent)).toEqual(["@octocat", "@user-name"]);
    // The punctuation after a login is not part of it.
    expect(host.textContent).toContain("@user-name!");
  });

  it("leaves an email address a link and not a mention", () => {
    const host = draw("write to me@example.com");
    expect(host.querySelector(".mention")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("mailto:me@example.com");
  });
});

describe("a fenced code block", () => {
  it("is highlighted when its info string names a language", () => {
    const host = draw("```js\nconst answer = 1;\n```");
    const code = host.querySelector("pre code");
    expect(code?.innerHTML).toContain("hljs-keyword");
    expect(code?.textContent).toBe("const answer = 1;\n");
  });

  it("is escaped and not highlighted when it names none", () => {
    const host = draw("```\n<b>not bold</b>\n```");
    const code = host.querySelector("pre code");
    expect(code?.querySelector("b")).toBeNull();
    expect(code?.textContent).toBe("<b>not bold</b>\n");
    expect(code?.innerHTML).not.toContain("hljs-");
  });

  it("falls back to the extension table for an info string that is not a language", () => {
    const host = draw("```ts\nconst answer: number = 1;\n```");
    expect(host.querySelector("pre code")?.innerHTML).toContain("hljs-keyword");
  });
});

describe("one line of a diff", () => {
  it("is highlighted when the language is known", () => {
    const drawn = html.highlightLine("const a = 1;", "javascript");
    expect(drawn).toContain("hljs-keyword");
    expect(drawn).toContain("hljs-number");
  });

  it("is escaped when the language is not known", () => {
    expect(html.highlightLine("<b>x</b>", null)).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(html.highlightLine("<b>x</b>", "no-such-language")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("is escaped and not highlighted when it is longer than 1000 characters", () => {
    const long = `const x = "${"a".repeat(1000)}";`;
    expect(long.length).toBeGreaterThan(1000);
    const drawn = html.highlightLine(long, "javascript");
    expect(drawn).toBe(html.escapeHtml(long));
    expect(drawn).not.toContain("hljs-");
    // A line of exactly the limit is still highlighted.
    const atLimit = `"${"a".repeat(html.MAX_HIGHLIGHT_LENGTH - 2)}"`;
    expect(atLimit).toHaveLength(html.MAX_HIGHLIGHT_LENGTH);
    expect(html.highlightLine(atLimit, "javascript")).toContain("hljs-string");
  });
});

describe("the language of a file", () => {
  it("comes from the extension table", () => {
    expect(html.languageForPath("src/app.ts")).toBe("typescript");
    expect(html.languageForPath("README.md")).toBe("markdown");
    expect(html.languageForPath("a/b/c.py")).toBe("python");
    expect(html.languageForPath("Cargo.rs")).toBe("rust");
  });

  it("names a file with no extension by its name", () => {
    expect(html.languageForPath("Dockerfile")).toBeNull();
    expect(html.languageForPath("docker/CMakeLists.txt")).toBeNull();
    expect(html.languageForPath("Makefile")).toBeNull();
  });

  it("answers nothing for a path with no language", () => {
    expect(html.languageForPath("")).toBeNull();
    expect(html.languageForPath(null)).toBeNull();
    expect(html.languageForPath("notes.unknown")).toBeNull();
  });
});

describe("a body with no words", () => {
  it("says so in the caller's sentence, or the default one", () => {
    expect(draw("").textContent).toBe("No description provided.");
    expect(draw(null).textContent).toBe("No description provided.");
    expect(draw("   ", "No review comment.").textContent).toBe("No review comment.");
  });

  it("keeps a single newline a line break, as GitHub does", () => {
    const host = draw("one\ntwo");
    expect(host.querySelectorAll("br")).toHaveLength(1);
  });

  it("turns a URL written as text into a link", () => {
    const host = draw("see https://example.com/x for why");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.com/x");
  });
});
