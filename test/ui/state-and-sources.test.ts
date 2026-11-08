/**
 * The list helper the pages keep unchanged rows with, and the source rules the
 * page code is held to.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { describe, expect, it } from "vitest";
import { reconcileById } from "../../src/ui/state/keyed.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKDOWN_COMPONENT, checkSource, checkTree, codeOnly, defaultRoot } from "./source-rules.ts";

describe("keyed.test.ts", () => {
  /**
   * `reconcileById` is what keeps a list's unchanged rows on the same object, and
   * that is what keeps their elements, focus and carets across a server refresh.
   * These tests pin the three things the page code relies on: an unchanged item
   * keeps its object, a changed one is replaced, and a refresh that changes
   * nothing returns the array it was given, so a signal does not notify.
   */

  interface Row {
    readonly id: string;
    readonly title: string;
    readonly count?: number;
  }

  const byId = (row: Row): string => row.id;

  describe("reconcileById", () => {
    it("keeps the object of an item whose fields did not change", () => {
      const current: Row[] = [
        { id: "a", title: "first" },
        { id: "b", title: "second" },
      ];
      const incoming: Row[] = [
        { id: "a", title: "first" },
        { id: "b", title: "changed" },
      ];

      const next = reconcileById(current, incoming, byId);

      expect(next).toHaveLength(2);
      expect(next[0]).toBe(current[0]);
      expect(next[1]).toBe(incoming[1]);
      expect(next[1]).not.toBe(current[1]);
    });

    it("returns the current array itself when nothing changed", () => {
      const current: Row[] = [
        { id: "a", title: "first" },
        { id: "b", title: "second" },
      ];
      const incoming: Row[] = [
        { id: "a", title: "first" },
        { id: "b", title: "second" },
      ];

      expect(reconcileById(current, incoming, byId)).toBe(current);
    });

    it("follows the incoming order and keeps the objects it matched", () => {
      const a: Row = { id: "a", title: "first" };
      const b: Row = { id: "b", title: "second" };
      const current = [a, b];

      const next = reconcileById(current, [{ id: "b", title: "second" }, { id: "a", title: "first" }], byId);

      expect(next).not.toBe(current);
      expect(next[0]).toBe(b);
      expect(next[1]).toBe(a);
    });

    it("drops an item the server no longer sends and takes the new one", () => {
      const current: Row[] = [
        { id: "a", title: "first" },
        { id: "b", title: "second" },
      ];
      const incoming: Row[] = [
        { id: "b", title: "second" },
        { id: "c", title: "third" },
      ];

      const next = reconcileById(current, incoming, byId);

      expect(next.map((row) => row.id)).toEqual(["b", "c"]);
      expect(next[0]).toBe(current[1]);
      expect(next[1]).toBe(incoming[1]);
    });

    it("compares only one level deep, so a changed nested value is a new object", () => {
      const current = [{ id: "a", title: "first", tags: ["x"] }];
      const incoming = [{ id: "a", title: "first", tags: ["x"] }];

      const next = reconcileById(current, incoming, byId);

      expect(next).not.toBe(current);
      expect(next[0]).toBe(incoming[0]);
    });

    it("uses the comparator it is given", () => {
      const current: Row[] = [{ id: "a", title: "first" }];
      const incoming: Row[] = [{ id: "a", title: "first" }];

      const next = reconcileById(current, incoming, byId, () => false);

      expect(next[0]).toBe(incoming[0]);
    });

    it("keeps the current array when the comparator says nothing changed", () => {
      const current: Row[] = [{ id: "a", title: "first" }];
      const incoming: Row[] = [{ id: "a", title: "other" }];

      expect(reconcileById(current, incoming, byId, () => true)).toBe(current);
    });

    it("answers an empty list for an empty answer, and keeps the same array", () => {
      const current: Row[] = [];
      expect(reconcileById(current, [], byId)).toBe(current);
    });
  });
});

describe("source-rules.test.ts", () => {
  /**
   * The source rules of the page code.
   *
   * The rule list exists because the first requirement of the rewrite is that an
   * update never resets what the user did not touch: a region replaced wholesale
   * is exactly that reset. A rule that only ever reports nothing proves nothing,
   * so this file feeds the checker code that must fail, and code that must pass,
   * and then runs it over the page code as it stands.
   */

  /** Write a file with the lines given, and answer the text. */
  function source(...lines: string[]): string {
    return `${lines.join("\n")}\n`;
  }

  describe("checkSource", () => {
    it("finds every construct that replaces a region wholesale", () => {
      const text = source(
        'const element = document.querySelector("#region");',
        'element.innerHTML = "<p>x</p>";',
        "element.outerHTML = '';",
        'element.insertAdjacentHTML("beforeend", "<p>x</p>");',
        "element.replaceChildren();",
        'element.textContent = "";',
      );

      const found = checkSource("src/ui/pages/bad.tsx", text);

      expect(found.map((violation) => violation.rule)).toEqual([
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "replaceChildren",
        "empty textContent",
      ]);
      expect(found[0]?.line).toBe(2);
      expect(found[0]?.file).toBe("src/ui/pages/bad.tsx");
    });

    it("finds eval and Function in both spellings", () => {
      const found = checkSource("src/ui/pages/bad.tsx", source('eval("1");', 'new Function("return 1")();', 'Function("x")();'));
      expect(found.map((violation) => violation.rule)).toEqual(["eval", "new Function", "Function"]);
    });

    it("lets the markdown component draw HTML, and no other file", () => {
      const text = source("element.innerHTML = markdown;", "return <div dangerouslySetInnerHTML={{ __html: html }} />;");

      expect(checkSource(MARKDOWN_COMPONENT, text)).toEqual([]);
      expect(checkSource("src/ui/pages/report.tsx", text).map((violation) => violation.rule)).toEqual([
        "innerHTML",
        "dangerouslySetInnerHTML",
      ]);
      // The allowlist is for those two constructs only: replacing a region's
      // children wholesale is a reset wherever it happens.
      expect(checkSource(MARKDOWN_COMPONENT, source("element.replaceChildren();")).map((v) => v.rule)).toEqual([
        "replaceChildren",
      ]);
    });

    it("lets fetch be called only from the request folder", () => {
      expect(checkSource("src/ui/api/request.ts", source("await fetch(url);"))).toEqual([]);
      expect(checkSource("src/ui/pages/chat.tsx", source("await fetch(url);")).map((v) => v.rule)).toEqual(["fetch"]);
      // A member call is not the global one.
      expect(checkSource("src/ui/pages/chat.tsx", source("window.fetch(url);"))).toEqual([]);
    });

    it("lets a stream be opened only by the stream client", () => {
      expect(checkSource("src/ui/streams/client.ts", source('new EventSource("/api/jobs/events");'))).toEqual([]);
      expect(checkSource("src/ui/pages/chat.tsx", source('new EventSource("/api/jobs/events");')).map((v) => v.rule)).toEqual([
        "new EventSource",
      ]);
    });

    it("lets timers belong to the stream client and to the state helpers only", () => {
      const text = source("setTimeout(work, 1000);", "setInterval(work, 1000);");
      expect(checkSource("src/ui/streams/client.ts", text)).toEqual([]);
      expect(checkSource("src/ui/state/keyed.ts", text)).toEqual([]);
      expect(checkSource("src/ui/pages/chat.tsx", text).map((v) => v.rule)).toEqual(["setTimeout", "setInterval"]);
    });

    it("reads code, not comments or the inside of strings", () => {
      const text = source(
        "// never write element.innerHTML here",
        "/* replaceChildren() would reset the list */",
        'const help = "do not call fetch() or eval() in a page";',
        'const name = "innerHTML";',
      );
      expect(checkSource("src/ui/pages/chat.tsx", text)).toEqual([]);
    });

    it("keeps line numbers through a blanked block comment", () => {
      const found = checkSource("src/ui/pages/chat.tsx", source("/* one", "two", "*/", "element.innerHTML = x;"));
      expect(found).toHaveLength(1);
      expect(found[0]?.line).toBe(4);
      expect(found[0]?.text).toBe("element.innerHTML = x;");
    });

    it("keeps an empty string an empty string when it blanks a literal", () => {
      expect(codeOnly('element.textContent = "";')).toContain('""');
      expect(checkSource("src/ui/pages/chat.tsx", source('element.textContent = " ";'))).toEqual([]);
    });
  });

  describe("checkTree", () => {
    it("finds nothing in the page code as it stands", async () => {
      await expect(checkTree(defaultRoot)).resolves.toEqual([]);
    });

    it("finds a violation in a tree that has one", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sec-source-rules-"));
      try {
        await mkdir(join(root, "src/ui/pages"), { recursive: true });
        await writeFile(join(root, "src/ui/pages/bad.tsx"), source("export function bad(el: Element) {", '  el.innerHTML = "";', "}"));
        const found = await checkTree(root);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ file: "src/ui/pages/bad.tsx", rule: "innerHTML", line: 2 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("answers an empty list for a tree with no page code", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-sec-source-rules-"));
      try {
        await expect(checkTree(root)).resolves.toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
