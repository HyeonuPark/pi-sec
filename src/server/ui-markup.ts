import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

/** The largest markup one card may carry, in UTF-8 bytes of html plus css. */
export const UI_MARKUP_MAX_BYTES = 64 * 1024;

export type MarkupCheck =
  | { readonly ok: true; readonly html: string; readonly css: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Elements that never reach a page from a card. The check looks at the local
 * name in every namespace, so `<svg><style>` and `<svg><script>` are refused as
 * well.
 */
const REJECTED_ELEMENTS = new Set([
  "script",
  "style",
  "template",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
]);

/** Attributes whose value the browser reads as a URL to fetch or follow. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "ping",
  "srcset",
]);

type Attribute = DefaultTreeAdapterTypes.Element["attrs"][number];

/**
 * ASCII whitespace and control characters, which a browser removes from a URL
 * before it reads the scheme. `java\tscript:` and ` javascript:` are the same
 * scheme as `javascript:` once this runs.
 */
const URL_NOISE = /[\u0000-\u0020\u007f]/g;

/** The value with the characters a browser ignores in a scheme removed. */
function cleanUrl(value: string): string {
  return value.replace(URL_NOISE, "").toLowerCase();
}

/** The attribute name as the serializer writes it, such as `xlink:href`. */
function qualifiedName(attr: Attribute): string {
  return attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node;
}

/** The whitespace that separates a srcset URL from its descriptor. */
function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";
}

/** The URL of each candidate in a `srcset` value, without its descriptor. */
function srcsetCandidates(value: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && isSpace(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !isSpace(value[index] ?? "")) index += 1;
    let url = value.slice(start, index);
    if (url.endsWith(",")) {
      // A candidate with no descriptor ends with the comma before the next one.
      url = url.replace(/,+$/, "");
      if (url !== "") urls.push(url);
      continue;
    }
    urls.push(url);
    while (index < value.length && value[index] !== ",") index += 1;
    if (index < value.length) index += 1;
  }
  return urls;
}

function urlAllowed(value: string, tagName: string, attribute: string): boolean {
  if (value === "") return true;
  if (value.startsWith("#")) return true;
  // A URL that starts with two slashes names another host. A browser reads
  // `/\host` as `//host` as well, so it is the same refusal.
  if (value.startsWith("\\") || value.startsWith("//") || value.startsWith("/\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(value)?.[1];
  if (scheme === undefined) return true;
  if (scheme === "http" || scheme === "https") return true;
  // An inline image is the one data URL a card may carry.
  if (
    scheme === "data" &&
    tagName === "img" &&
    (attribute === "src" || attribute === "srcset") &&
    value.startsWith("data:image/")
  ) {
    return true;
  }
  return false;
}

/** The first problem in one attribute, or undefined when the attribute is fine. */
function attributeProblem(tagName: string, attr: Attribute): string | undefined {
  const name = qualifiedName(attr).toLowerCase();
  const value = cleanUrl(attr.value);
  if (value.startsWith("javascript:") || value.startsWith("vbscript:")) {
    return `attribute ${name} has a script URL`;
  }
  if (attr.name.toLowerCase().startsWith("on")) {
    return `attribute ${name} is not allowed`;
  }
  if (attr.name.toLowerCase() === "style") {
    return `attribute ${name} is not allowed`;
  }
  if (!URL_ATTRIBUTES.has(name)) return undefined;
  if (name === "srcset") {
    for (const candidate of srcsetCandidates(attr.value)) {
      if (!urlAllowed(cleanUrl(candidate), tagName, name)) {
        return `attribute ${name} has a URL that is not allowed`;
      }
    }
    return undefined;
  }
  if (urlAllowed(value, tagName, name)) return undefined;
  return `attribute ${name} has a URL that is not allowed`;
}

function findProblem(node: DefaultTreeAdapterTypes.Node): string | undefined {
  if (isElement(node)) {
    const tagName = node.tagName.toLowerCase();
    if (REJECTED_ELEMENTS.has(tagName)) return `element <${tagName}> is not allowed`;
    for (const attr of node.attrs) {
      const problem = attributeProblem(tagName, attr);
      if (problem !== undefined) return problem;
    }
  }
  if (!("childNodes" in node)) return undefined;
  for (const child of node.childNodes) {
    const problem = findProblem(child);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Remove every comment node in place, so the serialized markup holds none. */
function dropComments(node: DefaultTreeAdapterTypes.ParentNode): void {
  const children = node.childNodes;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (child.nodeName === "#comment") {
      children.splice(index, 1);
      continue;
    }
    if ("childNodes" in child) dropComments(child);
  }
}

/**
 * Check the markup and css one card returned. The html is parsed and
 * re-serialized from the parse tree, so the result holds only well-formed
 * elements and attributes and the card cannot leave the element it is put in.
 */
export function checkCardMarkup(html: string, css?: string): MarkupCheck {
  const styles = css ?? "";
  const bytes = Buffer.byteLength(html, "utf8") + Buffer.byteLength(styles, "utf8");
  if (bytes > UI_MARKUP_MAX_BYTES) {
    return { ok: false, reason: `markup is larger than ${UI_MARKUP_MAX_BYTES} bytes` };
  }
  if (/<\/style/i.test(styles)) {
    return { ok: false, reason: `css contains "</style"` };
  }
  if (styles.includes("<!--")) {
    return { ok: false, reason: `css contains "<!--"` };
  }
  const fragment = parseFragment(html);
  const problem = findProblem(fragment);
  if (problem !== undefined) return { ok: false, reason: problem };
  dropComments(fragment);
  return { ok: true, html: serialize(fragment), css: styles };
}
