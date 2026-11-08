/**
 * Rules about the source tree itself, read off the files: the argument order
 * of the stores, the fallback of the composer menu, and the script that probes the
 * page.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("store-argument-order.test.ts", () => {
  /**
   * The context argument comes first, in every method of every store.
   *
   * Passing it in the wrong position does not throw: the store reads the argument
   * that should be a context as an id, and the answer is a missing job rather than
   * a type error. Two orders in one class is what made that mistake easy, so the
   * two stores this file reads declare one order, and a method that takes a
   * context takes it first.
   *
   * The check reads the source because the rule is about the declared parameter
   * order, and a test that called each method would test the calls it writes, not
   * the signatures other callers use.
   */

  const REPO = new URL("..", import.meta.url);

  /** One method declaration found in a class body. */
  interface Method {
    readonly name: string;
    readonly params: string;
  }

  /**
   * The public methods of one exported class: its name, and their parameter lists.
   *
   * A parameter list may run over several lines, so it is collected until the
   * parenthesis that opened it closes.
   */
  async function publicMethods(file: string, className: string): Promise<Method[]> {
    const text = await readFile(new URL(`src/${file}`, REPO), "utf8");
    const start = text.search(new RegExp(`^export class ${className}\\b`, "m"));
    if (start < 0) throw new Error(`no class ${className} in ${file}`);
    const body = text.slice(start);
    const methods: Method[] = [];
    const head = /^ {2}(?!constructor\b|private\b|readonly\b|#)(?:async )?(?:\*)?([A-Za-z][A-Za-z0-9]*)\(/gm;
    for (let match = head.exec(body); match !== null; match = head.exec(body)) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < body.length; end += 1) {
        const char = body[end];
        if (char === "(") depth += 1;
        else if (char === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      methods.push({ name: match[1]!, params: body.slice(open + 1, end) });
    }
    return methods;
  }

  /** The first parameter of a list, cut at the comma that separates it from the next. */
  function firstParameter(params: string): string {
    let depth = 0;
    for (let index = 0; index < params.length; index += 1) {
      const char = params[index];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if (char === "," && depth === 0) return params.slice(0, index).trim();
    }
    return params.trim();
  }

  /** Whether a parameter list names a context at all, wherever it sits. */
  function takesContext(params: string): boolean {
    return /\bcontext\??: Context\b/.test(params);
  }

  describe("the stores take the context argument first", () => {
    const stores = [
      { file: "jobs/registry.ts", className: "JobRegistry", atLeast: 11 },
      { file: "reports/store.ts", className: "ReportStore", atLeast: 13 },
    ] as const;

    for (const store of stores) {
      it(`declares no context in ${store.className} after the first position`, async () => {
        const methods = await publicMethods(store.file, store.className);
        // A method that takes a context but not first is the mistake this rule is
        // about, whatever its name.
        const late = methods.filter((method) => takesContext(method.params) && !/^context\??: Context\b/.test(firstParameter(method.params)));
        expect(late.map((method) => `${method.name}(${method.params.trim()})`)).toEqual([]);

        // The parse itself: a class whose methods were not found would pass the
        // check above for the wrong reason.
        const withContext = methods.filter((method) => takesContext(method.params));
        expect(withContext.length).toBeGreaterThanOrEqual(store.atLeast);
      });
    }

    it("names the jobs every public method of the registry that takes a context", async () => {
      const names = (await publicMethods("jobs/registry.ts", "JobRegistry"))
        .filter((method) => takesContext(method.params))
        .map((method) => method.name)
        .sort();

      // The methods a caller reaches without a `Tx`: each of them is one a
      // wrong-order call site could have been written against.
      expect(names).toEqual(
        [
          "cancel",
          "create",
          "descendantIds",
          "get",
          "keys",
          "list",
          "remove",
          "removeAll",
          "tree",
          "update",
          "writeAll",
        ].sort(),
      );
    });
  });
});

describe("p5-composer-menu-and-color-mix.test.ts", () => {
  /**
   * Two defects in the web page, both in `styles.css` and neither visible to jsdom,
   * which lays nothing out:
   *
   * 1. The composer menu was 11rem wide while its longest label needs more, so
   *    "Force reinstall and restart" wrapped into three lines inside it at 1280px
   *    as well as at 390px. The menu now takes its width from its widest label.
   * 2. A browser without `color-mix()` does not fall back to the declaration the
   *    rule carried before it: a value that holds a `var()` is not checked against
   *    the property's grammar at parse time, so it is rejected only once the
   *    variables are substituted and the property then goes unset. Measured that
   *    way, the activity ring lost its border, the error banner lost its fill and
   *    the working chip kept its white label over no fill at all. One
   *    `@supports not (...)` block now carries a plain stand-in for every mixed
   *    value.
   *
   * The assertions below pin the mechanism, since the numbers themselves come from
   * a browser: measured at 320px, 390px and 1280px, the longest label went from
   * three lines at 82.3px of height to one line at 37.3px, the menu stayed inside
   * the viewport at every one of those widths, and with `color-mix()` made unknown
   * the ring was drawn again, the banner kept its panel and the chip kept its
   * label readable.
   */

  const root = dirname(dirname(fileURLToPath(import.meta.url)));

  /** One rule: its selector, and its declaration block. */
  interface Rule {
    selector: string;
    body: string;
  }

  /** The stylesheet with its comments gone, so a comment cannot read as a rule. */
  async function styles(): Promise<string> {
    const text = await readFile(join(root, "src/web/styles.css"), "utf8");
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  /** Every rule in a slice of CSS. Rules nested in an at-rule are read as rules. */
  function rulesIn(text: string): Rule[] {
    const out: Rule[] = [];
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("@"))
        .join(" ");
      if (selector === "") continue;
      out.push({ selector, body: match[2] });
    }
    return out;
  }

  /** The `@media` blocks of a stylesheet, with the width each one asks for. */
  function mediaBlocks(text: string): { maxWidth: number; body: string }[] {
    const out: { maxWidth: number; body: string }[] = [];
    for (const match of text.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      let close = text.length;
      for (let index = open; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            close = index;
            break;
          }
        }
      }
      out.push({ maxWidth: Number(match[1]), body: text.slice(open, close) });
    }
    return out;
  }

  /** The properties a rule sets with a mixed value, in the order they appear. */
  function mixedProperties(rule: Rule): string[] {
    return rule.body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.includes("color-mix("))
      .map((declaration) => declaration.slice(0, declaration.indexOf(":")).trim());
  }

  const FALLBACK = "@supports not (color: color-mix(in srgb, red, blue))";

  /** The fallback block's rules, and the CSS that stands before it. */
  function splitFallback(text: string): { before: string; fallback: Rule[] } {
    const at = text.indexOf(FALLBACK);
    expect(at).toBeGreaterThan(-1);
    const open = text.indexOf("{", at);
    let depth = 0;
    let close = text.length;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    return { before: text.slice(0, at), fallback: rulesIn(text.slice(open, close)) };
  }

  describe("composer menu labels", () => {
    it("takes the menu's width from its widest label, so no label is folded", async () => {
      // The narrow-screen rule also names this selector, so the sizing rule is the
      // one that asks for a content width.
      const menu = rulesIn(await styles())
        .filter((rule) => rule.selector === ".composer-menu")
        .filter((rule) => rule.body.includes("width: max-content"));

      expect(menu).toHaveLength(1);
      // A fixed width is what folded the label: sized from its content, the label
      // is one line, and the page edge is the only cap.
      expect(menu[0].body).toMatch(/min-width:\s*11rem/);
      expect(menu[0].body).toMatch(/max-width:\s*calc\(100vw - 2 \* var\(--space-3\)\)/);
      // A nowrap label would leave the menu instead of widening it.
      expect(menu[0].body).not.toMatch(/white-space:\s*nowrap/);
    });

    it("holds the longest label the page puts in the menu", async () => {
      const html = await readFile(join(root, "src/web/index.html"), "utf8");
      const at = html.indexOf('id="composer-menu"');
      expect(at).toBeGreaterThan(-1);
      const menu = html.slice(at, html.indexOf("</div>", at));
      const labels = [...menu.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim());

      expect(labels).toContain("Force reinstall and restart");
      // Twenty-six characters: in the 11rem the menu used to be, this is what
      // wrapped onto three lines.
      expect(Math.max(...labels.map((label) => label.length))).toBeGreaterThan(20);
    });

    it("opens from the composer's edge on a narrow screen, so the menu stays on screen", async () => {
      const text = await styles();
      const narrow = mediaBlocks(text).filter((block) => block.maxWidth === 400);

      expect(narrow).toHaveLength(1);
      const rules = rulesIn(narrow[0].body);
      // The toggle cannot hold the label in the room the ⋯ button leaves, so the
      // menu is anchored to the composer there.
      expect(rules.some((rule) => rule.selector === ".composer-more" && /position:\s*static/.test(rule.body))).toBe(true);
      expect(rules.some((rule) => rule.selector === ".composer-menu" && /right:\s*var\(--space-4\)/.test(rule.body))).toBe(
        true,
      );
      // Which is a positioning context the composer has to be.
      const composer = rulesIn(text).filter((rule) => rule.selector === ".composer");
      expect(composer[0]?.body).toMatch(/position:\s*relative/);
    });
  });

  describe("browsers with no color-mix()", () => {
    it("gives every mixed value a plain stand-in", async () => {
      const { before, fallback } = splitFallback(await styles());
      const mixed = rulesIn(before).filter((rule) => mixedProperties(rule).length > 0);
      const missing: string[] = [];

      expect(mixed.length).toBeGreaterThan(0);
      for (const rule of mixed) {
        const selectors = fallback.filter((item) =>
          item.selector
            .split(",")
            .map((part) => part.trim())
            .includes(rule.selector),
        );
        for (const property of mixedProperties(rule)) {
          const stands = selectors.some((item) =>
            item.body
              .split(";")
              .map((declaration) => declaration.split(":")[0]?.trim())
              .includes(property),
          );
          if (!stands) missing.push(`${rule.selector} { ${property} }`);
        }
      }

      // The list is the defect report: a mixed value with no stand-in is what left
      // the activity ring and the working chip's label unreadable.
      expect(missing).toEqual([]);
      // And the stand-in has to be something the browser can read.
      for (const rule of fallback) expect(rule.body).not.toContain("color-mix(");
    });

    it("names the function it tests for, rather than a copy of it", async () => {
      const text = await styles();
      expect(text).toContain(FALLBACK);
      // The gate has to be the function the mixed values use, or it would pass in a
      // browser that cannot read them.
      const { before } = splitFallback(text);
      expect(before).toContain("color-mix(in srgb");
    });
  });
});

describe("ui-probe-writes.test.ts", () => {
  /**
   * `scripts/ui-probe.mjs` opens the web UI in a real browser and reads it. Once,
   * that script sent messages and an attachment into a live root conversation,
   * because a click that writes went straight through.
   *
   * The probe now decides every request the page makes: reading passes, writing is
   * blocked, and the only exception is the one focused chat the caller names with
   * `--focused <id>`. These tests pin that decision on its own, and pin the wiring
   * that puts it in front of the browser, so a later edit that widens the
   * exception fails here instead of in the user's conversation.
   *
   * The probe is a script, not a module: importing it launches Chromium. So the
   * two pure functions are lifted out of the source and run as they are, which
   * keeps the assertion on the code the tool really uses instead of on a copy.
   */

  const root = dirname(dirname(fileURLToPath(import.meta.url)));

  interface WriteInput {
    method: string;
    url: string;
    prefix?: string;
    focusedId?: number | null;
  }

  type WriteDecision = (input: WriteInput) => "pass" | "block";
  type PrefixOf = (url: string) => string;

  /** One function declaration out of `scripts/ui-probe.mjs`, compiled alone. */
  async function pureFunction<T>(name: string): Promise<T> {
    const source = await readFile(join(root, "scripts/ui-probe.mjs"), "utf8");
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`ui-probe.mjs has no ${name}`);
    const end = source.indexOf("\n}\n", start);
    if (end === -1) throw new Error(`${name} has no closing brace at column 0`);
    const body = source.slice(start, end + 2);
    return new Function(`${body}\nreturn ${name};`)() as T;
  }

  const decide = () => pureFunction<WriteDecision>("writeDecision");
  const prefixOf = () => pureFunction<PrefixOf>("prefixOf");

  describe("ui-probe write decision: blocking", () => {
    it("blocks a write to the page's own API path", async () => {
      const writeDecision = await decide();
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/basic-chat/messages" })).toBe("block");
    });

    it("blocks the root conversation's messages with no --focused", async () => {
      const writeDecision = await decide();
      // The incident: a POST here reached the user's live conversation.
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/1/messages" })).toBe("block");
    });

    it("blocks another conversation's messages while one is focused", async () => {
      const writeDecision = await decide();
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/12/messages", focusedId: 13 }),
      ).toBe("block");
    });

    it("blocks an upload with no --focused", async () => {
      const writeDecision = await decide();
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/attachments" })).toBe("block");
    });

    it("blocks a tool call and a focused-chat rename", async () => {
      const writeDecision = await decide();
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/ui/call", focusedId: 13 })).toBe("block");
      // The focused chat is the caller's to write messages into, not to retitle.
      expect(writeDecision({ method: "PATCH", url: "http://127.0.0.1:8787/api/focused-chats/13", focusedId: 13 })).toBe(
        "block",
      );
    });

    it("blocks a write under a proxy prefix, which the exception does not name", async () => {
      const writeDecision = await decide();
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/pi/basic-chat/messages", prefix: "/pi", focusedId: 13 }),
      ).toBe("block");
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/pi/api/ui/call", prefix: "/pi", focusedId: 13 }),
      ).toBe("block");
    });

    it("blocks a method other than POST on the upload path", async () => {
      const writeDecision = await decide();
      // Only an upload passes; the path alone is not the exception.
      expect(writeDecision({ method: "DELETE", url: "http://127.0.0.1:8787/api/attachments", focusedId: 13 })).toBe("block");
    });

    it("does not read 13 as a prefix of 130", async () => {
      const writeDecision = await decide();
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/130/messages", focusedId: 13 }),
      ).toBe("block");
    });

    it("does not accept a path that is missing the configured prefix", async () => {
      const writeDecision = await decide();
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/13/messages", prefix: "/pi", focusedId: 13 }),
      ).toBe("block");
    });
  });

  describe("ui-probe write decision: passing", () => {
    it("passes every reading method, whatever the path", async () => {
      const writeDecision = await decide();
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(writeDecision({ method, url: "http://127.0.0.1:8787/api/conversations/13/messages" })).toBe("pass");
        expect(writeDecision({ method, url: "http://127.0.0.1:8787/api/conversations/1/messages" })).toBe("pass");
        expect(writeDecision({ method, url: "http://127.0.0.1:8787/api/admin/status", focusedId: 13 })).toBe("pass");
      }
    });

    it("passes writes to the focused chat and only that one", async () => {
      const writeDecision = await decide();
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/13/messages", focusedId: 13 })).toBe(
        "pass",
      );
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/13/reset", focusedId: 13 })).toBe(
        "pass",
      );
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/conversations/13/compact", focusedId: 13 })).toBe(
        "pass",
      );
    });

    it("passes an upload while a chat is focused", async () => {
      const writeDecision = await decide();
      // Uploads are not conversation-scoped, so the route cannot say which chat it
      // is for. The caller's check of the id is what keeps this narrow.
      expect(writeDecision({ method: "POST", url: "http://127.0.0.1:8787/api/attachments", focusedId: 13 })).toBe("pass");
    });

    it("passes the same writes under a proxy prefix", async () => {
      const writeDecision = await decide();
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/pi/api/conversations/13/messages", prefix: "/pi", focusedId: 13 }),
      ).toBe("pass");
      expect(
        writeDecision({ method: "POST", url: "http://127.0.0.1:8787/pi/api/attachments", prefix: "/pi", focusedId: 13 }),
      ).toBe("pass");
    });
  });

  describe("ui-probe mount prefix", () => {
    it("finds the prefix in front of a page path", async () => {
      const derive = await prefixOf();
      expect(derive("/basic-chat")).toBe("");
      expect(derive("/pi/basic-chat?chat=5")).toBe("/pi");
      expect(derive("/chats")).toBe("");
      expect(derive("/report/x")).toBe("");
      expect(derive("http://127.0.0.1:8787/sec/report/plans")).toBe("/sec");
      expect(derive("http://127.0.0.1:8787/pi/chats?archived=1")).toBe("/pi");
      expect(derive("http://127.0.0.1:8787/basic-chat")).toBe("");
    });

    it("reports no prefix for a URL that names no page", async () => {
      const derive = await prefixOf();
      expect(derive("http://127.0.0.1:8787")).toBe("");
      expect(derive("http://127.0.0.1:8787/api/health")).toBe("");
    });
  });

  describe("ui-probe wiring", () => {
    it("puts the decision in front of every request and reports what it blocked", async () => {
      const source = await readFile(join(root, "scripts/ui-probe.mjs"), "utf8");
      // Interception is registered on the context, before the page exists, and a
      // blocked request is aborted rather than continued.
      expect(source).toContain('context.route("**/*"');
      expect(source).toContain("route.abort()");
      expect(source).toContain("writeDecision({");
      // The list reaches stdout and the exit code.
      expect(source).toContain("--- blocked writes ---");
      expect(source).toContain("blockedWrites.length > 0");
      // The id is checked with the server before the browser starts.
      expect(source).toContain("/api/focused-chats/${focusedId}");
    });
  });
});
