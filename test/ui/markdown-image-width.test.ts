// @vitest-environment jsdom
/**
 * A picture in markdown text is never wider than its text column.
 *
 * jsdom does no layout, so this reads the stylesheet rule and checks that every
 * image the markdown component draws lands inside a container that the rule names.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, render } from "preact";

type MarkdownModule = typeof import("../../src/ui/components/markdown.tsx");

let Markdown: MarkdownModule["Markdown"];

beforeAll(async () => {
  const meta = document.createElement("meta");
  meta.name = "pi-sec-base";
  meta.content = "/sec";
  document.head.append(meta);
  Markdown = (await import("../../src/ui/components/markdown.tsx")).Markdown;
});

afterEach(() => {
  document.body.replaceChildren();
});

interface Rule {
  selectors: string[];
  body: string;
}

async function styleRules(): Promise<Rule[]> {
  const text = (await readFile(join(process.cwd(), "src/web/styles.css"), "utf8")).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const out: Rule[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split("\n")
      .filter((line) => !line.trim().startsWith("@"))
      .join(" ")
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => selector !== "");
    if (selectors.length > 0) out.push({ selectors, body: match[2] });
  }
  return out;
}

describe("markdown image width", () => {
  it("limits an image in a report body and in a chat bubble to the column", async () => {
    const rules = await styleRules();
    for (const selector of [".report-body img", ".message img"]) {
      const rule = rules.find((candidate) => candidate.selectors.includes(selector));
      expect(rule, selector).toBeDefined();
      expect(rule?.body, selector).toMatch(/max-width:\s*100%/);
      expect(rule?.body, selector).toMatch(/height:\s*auto/);
      // No fixed width: a picture narrower than the column keeps its own size.
      expect(rule?.body, selector).not.toMatch(/(^|[;\s])width:/);
    }
  });

  it("has no image rule that sets another max-width", async () => {
    const rules = (await styleRules()).filter(
      (rule) =>
        rule.selectors.some((selector) => /(^|[\s>+~.#\]])img\b/.test(selector)) &&
        /max-width:/.test(rule.body),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.body, rule.selectors.join(", ")).toMatch(/max-width:\s*100%/);
    }
  });

  it("draws every markdown image inside a container that the rule names", () => {
    const text = [
      "![plain](/a.png)",
      "",
      "[![linked](/b.png)](/b.png)",
      "",
      "| a |",
      "| - |",
      "| ![cell](/c.png) |",
    ].join("\n");
    const body = document.createElement("div");
    document.body.append(body);
    render(h(Markdown, { text, tag: "article", class: "report-body" }), body);
    const bubble = document.createElement("div");
    bubble.className = "message";
    document.body.append(bubble);
    render(h(Markdown, { text }), bubble);

    const images = [...document.querySelectorAll("img")];
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(image.matches(".report-body img, .message img"), image.outerHTML).toBe(true);
      expect(image.hasAttribute("width"), image.outerHTML).toBe(false);
    }
  });
});
