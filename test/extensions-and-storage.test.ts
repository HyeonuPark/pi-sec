/**
 * The extension loader and its card registry, the janitor, the secret store,
 * and how a file left on disk or in the store is written.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { lstat, mkdir, mkdtemp, readlink, rm, writeFile, symlink, utimes, lutimes, readdir, chmod, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, basename, sep } from "node:path";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { ensureDependencyLink, ExtensionLoader } from "../src/registry/loader.ts";
import type { EventsSink } from "../src/extensions/context.ts";
import { UI_EVENT_MAX_BYTES, UiRegistry, type UiPublish } from "../src/registry/ui.ts";
import { CONTROL_EVENTS } from "../src/server/streams.ts";
import { Janitor } from "../src/runtime/janitor.ts";
import { isProcessAlive, readPid, writePid } from "../src/runtime/supervisor.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { createRedactingStream, createRedactor } from "../src/secrets/redact.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPrivateSqliteStorage, sqliteFiles } from "../src/runtime/sqlite-file.ts";
import { AdminNotes, NOTE_LIMIT } from "../src/runtime/notes.ts";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

describe("loader.test.ts", () => {
  const silentLogger = { warn: () => undefined };

  /**
   * Temporary trees this test created, removed after every test.
   *
   * The loader links `node_modules` into the extensions directory it is given. A
   * directory that outlives the test would hold a link into a real tree, and a
   * cleanup walk that follows the link can delete the files of that tree. Removal
   * after each test is what keeps this test from seeding such a link, and the
   * link target is a temporary directory for the same reason.
   */
  const tempTrees: string[] = [];

  async function tempTree(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempTrees.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempTrees.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  async function makeExtension(
    dir: string,
    name: string,
    body: string,
    config?: unknown,
    entry = "index.js",
  ): Promise<void> {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, entry), body);
    if (config !== undefined) await writeFile(join(dir, name, "config.json"), JSON.stringify(config));
  }

  // NOTE: do not "prove" bare-specifier resolution by importing a package from an
  // extension fixture. Vitest resolves bare specifiers through Vite from the
  // project root, so such a test passes even when the real loader cannot resolve
  // them — which is exactly how the extensions directory shipped broken. Plain
  // Node resolves by walking up from the importing file, and these tests pin that
  // behaviour (the link is what makes it work) instead.
  describe("extension loader", () => {
    it("loads a default-exported extension and hot reloads changes", async () => {
      const dir = await tempTree("pi-sec-ext-");
      const modules = await tempTree("pi-sec-modules-");
      await makeExtension(
        dir,
        "hello",
        `export default { name: "hello", sections: [{ key: "hello", render: () => "v1" }] };\n`,
      );
      const registry = createRegistry();
      const loader = new ExtensionLoader({
        extensionsDir: dir,
        registry,
        logger: silentLogger,
        appModulesDir: modules,
      });
      const first = await loader.loadAll();
      expect(first.errors).toEqual([]);
      expect(registry.snapshot().extension("hello")).toBeDefined();

      await writeFile(
        join(dir, "hello", "index.js"),
        `export default { name: "hello", tools: [{ name: "ping", description: "p", parameters: { type: "object" }, execute: async () => ({}) }] };\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await loader.reload();
      expect(second.errors).toEqual([]);
      const installed = registry.snapshot().extension("hello");
      expect(installed?.tools?.some((tool) => tool.name === "ping")).toBe(true);
    });

    // A reload used to re-import only the entry file, so a
    // changed lib file kept the module the daemon already had. The lib is what Node's
    // own module map holds, and a test inside vitest does not have that map (the
    // loader's import goes through Vite's module runner), so the check runs in a child
    // Node process, the way this file already checks what a child process sees.
    it("reloads a changed lib file, not only the entry", async () => {
      const dir = await tempTree("pi-sec-ext-lib-");
      const probe = join(dir, "probe.mjs");
      await writeFile(
        probe,
        `import { mkdtemp, mkdir, writeFile } from "node:fs/promises";\n` +
          `import { join } from "node:path";\n` +
          `import { tmpdir } from "node:os";\n` +
          `const { ExtensionLoader } = await import(process.argv[2]);\n` +
          `const root = await mkdtemp(join(tmpdir(), "pi-sec-lib-probe-"));\n` +
          `const extensionsDir = join(root, "extensions");\n` +
          `const modulesDir = join(root, "modules");\n` +
          `await mkdir(join(extensionsDir, "demo", "lib"), { recursive: true });\n` +
          `await mkdir(modulesDir, { recursive: true });\n` +
          `await writeFile(join(extensionsDir, "demo", "lib", "value.js"), 'export const value = "v1";\\n');\n` +
          `await writeFile(join(extensionsDir, "demo", "index.js"),\n` +
          `  'import { value } from "./lib/value.js";\\nexport default { name: "demo", sections: [{ key: "s", render: () => value }] };\\n');\n` +
          `const installed = new Map();\n` +
          `const registry = { install: (extension) => installed.set(extension.name, extension),\n` +
          `  snapshot: () => ({ extension: (name) => installed.get(name) }) };\n` +
          `const loader = new ExtensionLoader({ extensionsDir, registry, appModulesDir: modulesDir, logger: { warn: () => undefined } });\n` +
          `await loader.loadAll();\n` +
          `const shown = () => installed.get("demo")?.sections?.[0]?.render();\n` +
          `const first = shown();\n` +
          `await writeFile(join(extensionsDir, "demo", "lib", "value.js"), 'export const value = "v2";\\n');\n` +
          `await loader.reload();\n` +
          `process.stdout.write(JSON.stringify({ first, second: shown() }));\n`,
      );
      const loaderUrl = new URL("../src/registry/loader.ts", import.meta.url).href;
      const out = execFileSync(process.execPath, [probe, loaderUrl], {
        encoding: "utf8",
      });

      expect(JSON.parse(out)).toEqual({ first: "v1", second: "v2" });
    });

    // This test pins the limit that docs/extensions.md states under "Loading
    // runtime extensions": a reload installs what it finds on disk and does not
    // rebuild the installed set, so a removed directory's tools stay installed
    // until a cold restart. If removal is ever implemented, this test and those
    // doc sentences change together.
    it("keeps a removed extension's tools installed until a cold restart", async () => {
      const dir = await tempTree("pi-sec-ext-removed-");
      const modules = await tempTree("pi-sec-modules-");
      await makeExtension(
        dir,
        "example-tool-ext",
        `export default { name: "example-tool-ext", tools: [{ name: "example-tool", description: "example", parameters: { type: "object" }, execute: async () => ({}) }] };\n`,
      );
      const registry = createRegistry();
      const loader = new ExtensionLoader({
        extensionsDir: dir,
        registry,
        logger: silentLogger,
        appModulesDir: modules,
      });
      const first = await loader.loadAll();
      expect(first.errors).toEqual([]);
      expect(registry.snapshot().extension("example-tool-ext")?.tools?.some((tool) => tool.name === "example-tool")).toBe(
        true,
      );

      await rm(join(dir, "example-tool-ext"), { recursive: true, force: true });
      const second = await loader.reload();
      expect(second.errors).toEqual([]);
      expect(second.reloaded).toEqual([]);
      expect(registry.snapshot().extension("example-tool-ext")?.tools?.some((tool) => tool.name === "example-tool")).toBe(
        true,
      );
    });

    it("validates config.json against a declared schema", async () => {
      const dir = await tempTree("pi-sec-ext-");
      const modules = await tempTree("pi-sec-modules-");
      await makeExtension(
        dir,
        "greeter",
        `import { Type } from "typebox";
  export const name = "greeter";
  export const configSchema = Type.Object({ greeting: Type.String() });
  export function create(config) { return { name: "greeter", sections: [{ key: "g", render: () => config.greeting }] }; }
  `,
        { greeting: "hi" },
      );
      const registry = createRegistry();
      const loader = new ExtensionLoader({
        extensionsDir: dir,
        registry,
        logger: silentLogger,
        appModulesDir: modules,
      });
      const result = await loader.loadAll();
      expect(result.errors).toEqual([]);
      expect(registry.snapshot().extension("greeter")).toBeDefined();
    });

    it("hands the extensions directory this install's node_modules", async () => {
      const dir = await tempTree("pi-sec-ext-link-");
      const modules = await tempTree("pi-sec-modules-");

      expect(await ensureDependencyLink(dir, modules)).toBeUndefined();
      const link = join(dir, "node_modules");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(modules);
      // Idempotent.
      expect(await ensureDependencyLink(dir, modules)).toBeUndefined();
      // Repoints a stale link, e.g. one left over from a different install tree.
      const other = await tempTree("pi-sec-modules-");
      expect(await ensureDependencyLink(dir, other)).toBeUndefined();
      expect(await readlink(link)).toBe(other);
    });

    it("leaves a real node_modules directory alone", async () => {
      const dir = await tempTree("pi-sec-ext-real-");
      await mkdir(join(dir, "node_modules", "keep"), { recursive: true });
      expect(await ensureDependencyLink(dir, join(dir, "absent"))).toBeUndefined();
      const info = await lstat(join(dir, "node_modules"));
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
    });

    it("does not mistake the dependency link for an extension", async () => {
      const dir = await tempTree("pi-sec-ext-scan-");
      const modules = await tempTree("pi-sec-modules-");
      await makeExtension(dir, "hello", `export default { name: "hello" };\n`);
      const registry = createRegistry();
      const loader = new ExtensionLoader({
        extensionsDir: dir,
        registry,
        logger: silentLogger,
        appModulesDir: modules,
      });
      const result = await loader.loadAll();
      expect(result.errors).toEqual([]);
      expect(result.reloaded).toEqual(["hello"]);
    });

    it("rejects a config.json without a schema and keeps other extensions loading", async () => {
      const dir = await tempTree("pi-sec-ext-");
      const modules = await tempTree("pi-sec-modules-");
      await makeExtension(dir, "noconfig", `export default { name: "noconfig" };\n`, { a: 1 });
      await makeExtension(dir, "fine", `export default { name: "fine" };\n`);
      const registry = createRegistry();
      const loader = new ExtensionLoader({
        extensionsDir: dir,
        registry,
        logger: silentLogger,
        appModulesDir: modules,
      });
      const result = await loader.loadAll();
      expect(result.errors.some((error) => error.startsWith("noconfig"))).toBe(true);
      expect(registry.snapshot().extension("fine")).toBeDefined();
      expect(registry.snapshot().extension("noconfig")).toBeUndefined();
    });

    // A .ts entry follows the same export rule as a .js entry. The fixtures import
    // nothing, for the reason in the NOTE above.
    describe.each(["index.js", "index.ts", "index.mts"])("entry %s", (entry) => {
      async function loadOne(body: string) {
        const dir = await tempTree("pi-sec-ext-shape-");
        const modules = await tempTree("pi-sec-modules-");
        await makeExtension(dir, "shape", body, undefined, entry);
        const registry = createRegistry();
        const loader = new ExtensionLoader({
          extensionsDir: dir,
          registry,
          logger: silentLogger,
          appModulesDir: modules,
        });
        const result = await loader.loadAll();
        return { result, registry };
      }

      it("installs a module that defines create() and has no default export", async () => {
        const { result, registry } = await loadOne(
          `export const name = "shape";\nexport function create() { return { name: "shape" }; }\n`,
        );
        expect(result.errors).toEqual([]);
        expect(result.reloaded).toEqual(["shape"]);
        expect(registry.snapshot().extension("shape")).toBeDefined();
      });

      it("installs a module that has a default export only", async () => {
        const { result, registry } = await loadOne(`export default { name: "shape" };\n`);
        expect(result.errors).toEqual([]);
        expect(registry.snapshot().extension("shape")).toBeDefined();
      });

      it("refuses a module that both default-exports and defines create()", async () => {
        const { result, registry } = await loadOne(
          `export const name = "shape";\nexport function create() { return { name: "shape" }; }\nexport default { name: "shape" };\n`,
        );
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("may not both default-export and define create()");
        expect(registry.snapshot().extension("shape")).toBeUndefined();
      });
    });
  });
});

describe("ui-registry.test.ts", () => {
  /**
   * Cards a runtime extension offers.
   *
   * The loader is driven here exactly as the runtime drives it: a temporary
   * extensions directory, an `index.js` written into it, and `loadAll()`. The cards
   * themselves are checked on a `UiRegistry` built over a recording event sink, so
   * a test can see both what the page would get and what the stream would carry.
   */

  const silentLogger = { warn: () => undefined };

  /**
   * Temporary trees this test created.
   *
   * The loader links `node_modules` into the extensions directory it is given, so
   * the link target is a temporary directory too and both trees are removed here.
   * A link left into a real tree is how a cleanup walk deletes dependencies.
   */
  const tempTrees: string[] = [];

  async function tempTree(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempTrees.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempTrees.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  interface Emitted {
    readonly type: string;
    readonly data: Record<string, unknown>;
  }

  interface Harness {
    readonly ui: UiRegistry;
    readonly loader: ExtensionLoader;
    readonly extensionsDir: string;
    readonly events: Emitted[];
  }

  /** An extensions directory with a loader over it, and a recording sink behind the registry. */
  async function harness(): Promise<Harness> {
    const extensionsDir = await tempTree("pi-sec-ui-ext-");
    const modulesDir = await tempTree("pi-sec-ui-modules-");
    const events: Emitted[] = [];
    const sink: EventsSink = {
      emit: (type, data) => {
        events.push({ type, data });
      },
    };
    const ui = new UiRegistry({ events: sink, logger: silentLogger });
    const loader = new ExtensionLoader({
      extensionsDir,
      registry: createRegistry(),
      logger: silentLogger,
      appModulesDir: modulesDir,
      ui,
    });
    return { ui, loader, extensionsDir, events };
  }

  async function writeExtension(dir: string, name: string, body: string): Promise<void> {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "index.js"), body);
  }

  /** Rewrite an entry file with a later mtime, so the loader imports a fresh module. */
  async function rewriteEntry(path: string, body: string): Promise<void> {
    await writeFile(path, body);
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
  }

  /**
   * What the fixture extension kept for the test: its `publish`, and the argument
   * object of the last `render` or `action` call. The loader imports each version
   * of an entry as its own module instance, and the global is how one instance
   * hands a value to the test that cannot otherwise reach inside it.
   */
  interface Captured {
    publish?: UiPublish;
    render?: unknown;
    action?: unknown;
  }

  const CAPTURE_KEY = "__piSecUiTestCapture";

  function capture(): Captured {
    const store = globalThis as unknown as Record<string, Captured | undefined>;
    return store[CAPTURE_KEY] ?? {};
  }

  function capturedPublish(): UiPublish {
    const publish = capture().publish;
    if (publish === undefined) throw new Error("the extension did not hand the test its publish function");
    return publish;
  }

  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[CAPTURE_KEY];
  });

  /** A fixture that declares two cards, renders markup, answers an action, and publishes. */
  const DEMO_V1 = `
  export const name = "demo-cards";
  export function create() {
    return { name: "demo-cards" };
  }
  export const ui = {
    cards: [
      { slot: "sidebar.bottom", name: "toggle", script: "toggle.js" },
      { slot: "sidebar.bottom", name: "status" },
    ],
    render(input) {
      globalThis.${CAPTURE_KEY}.render = input;
      return { html: "<b>on</b>", css: "b{color:red}" };
    },
    action(input) {
      globalThis.${CAPTURE_KEY}.action = input;
      return { value: 1, html: "<i>done</i>" };
    },
    start({ publish }) {
      globalThis.${CAPTURE_KEY} = { publish };
    },
  };
  `;

  /** The same extension after a reload: one renamed card and one card in another slot. */
  const DEMO_V2 = `
  export const name = "demo-cards";
  export function create() {
    return { name: "demo-cards" };
  }
  export const ui = {
    cards: [
      { slot: "sidebar.bottom", name: "next" },
      { slot: "sidebar.top", name: "extra" },
    ],
    render() {
      return null;
    },
    start({ publish }) {
      globalThis.${CAPTURE_KEY} = { publish };
    },
  };
  `;

  describe("ui card registry", () => {
    it("loads the cards an extension exports and reports them in the loader list", async () => {
      const h = await harness();
      await writeExtension(h.extensionsDir, "demo-cards", DEMO_V1);
      await mkdir(join(h.extensionsDir, "demo-cards", "ui"), { recursive: true });
      await writeFile(join(h.extensionsDir, "demo-cards", "ui", "toggle.js"), "export const on = true;\n");

      const result = await h.loader.loadAll();

      expect(result.errors).toEqual([]);
      expect(h.ui.names()).toEqual(["demo-cards"]);
      // Sorted by extension name, then in the order the extension declared.
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["toggle", "status"]);
      expect(h.ui.cards("sidebar.top")).toEqual([]);
      expect(h.ui.card("demo-cards", "toggle")).toEqual({
        extension: "demo-cards",
        name: "toggle",
        slot: "sidebar.bottom",
        script: "toggle.js",
      });
      expect(h.ui.uiDir("demo-cards")).toBe(join(h.extensionsDir, "demo-cards", "ui"));
      expect(h.ui.hasAction("demo-cards")).toBe(true);

      const listed = h.loader.list().find((entry) => entry.name === "demo-cards");
      expect(listed?.error).toBeUndefined();
      expect(listed?.ui).toEqual({ cards: ["toggle", "status"], errors: [] });
    });

    it("replaces the cards on reload and drops an event published with the old publish", async () => {
      const h = await harness();
      await writeExtension(h.extensionsDir, "demo-cards", DEMO_V1);
      await mkdir(join(h.extensionsDir, "demo-cards", "ui"), { recursive: true });
      await writeFile(join(h.extensionsDir, "demo-cards", "ui", "toggle.js"), "export const on = true;\n");
      expect((await h.loader.loadAll()).errors).toEqual([]);
      const oldPublish = capturedPublish();

      await rewriteEntry(join(h.extensionsDir, "demo-cards", "index.js"), DEMO_V2);
      const reloaded = await h.loader.reload();
      expect(reloaded.errors).toEqual([]);
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["next"]);
      expect(h.ui.cards("sidebar.top").map((card) => card.name)).toEqual(["extra"]);
      expect(h.ui.card("demo-cards", "toggle")).toBeUndefined();

      oldPublish("toggle", "changed", 1);
      expect(h.events).toEqual([]);

      const newPublish = capturedPublish();
      expect(newPublish).not.toBe(oldPublish);
      newPublish("next", "changed", { on: true });
      expect(h.events).toEqual([
        {
          type: "ui_event",
          data: { extension: "demo-cards", card: "next", event: "changed", value: { on: true } },
        },
      ]);
    });

    it("keeps the previous cards when the reload fails", async () => {
      const h = await harness();
      await writeExtension(h.extensionsDir, "demo-cards", DEMO_V1);
      await mkdir(join(h.extensionsDir, "demo-cards", "ui"), { recursive: true });
      await writeFile(join(h.extensionsDir, "demo-cards", "ui", "toggle.js"), "export const on = true;\n");
      expect((await h.loader.loadAll()).errors).toEqual([]);
      const publish = capturedPublish();

      await rewriteEntry(join(h.extensionsDir, "demo-cards", "index.js"), "export const ui = {");
      const broken = await h.loader.reload();

      expect(broken.errors).toHaveLength(1);
      expect(broken.errors[0]).toContain("demo-cards");
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["toggle", "status"]);
      // The registration was never replaced, so the publish the extension already
      // holds still reaches the stream.
      publish("status", "kept", true);
      expect(h.events.map((event) => event.type)).toEqual(["ui_event"]);
      const listed = h.loader.list().find((entry) => entry.name === "demo-cards");
      expect(listed?.ui?.cards).toEqual(["toggle", "status"]);
    });

    it("unregisters the cards and closes publish when the directory is gone", async () => {
      const h = await harness();
      await writeExtension(h.extensionsDir, "demo-cards", DEMO_V1);
      await mkdir(join(h.extensionsDir, "demo-cards", "ui"), { recursive: true });
      await writeFile(join(h.extensionsDir, "demo-cards", "ui", "toggle.js"), "export const on = true;\n");
      expect((await h.loader.loadAll()).errors).toEqual([]);
      const publish = capturedPublish();

      await rm(join(h.extensionsDir, "demo-cards"), { recursive: true, force: true });
      expect((await h.loader.loadAll()).errors).toEqual([]);

      expect(h.ui.names()).toEqual([]);
      expect(h.ui.cards()).toEqual([]);
      expect(h.ui.uiDir("demo-cards")).toBeUndefined();
      expect(h.ui.diagnostics("demo-cards")).toBeUndefined();
      publish("toggle", "after-removal", true);
      expect(h.events).toEqual([]);
    });

    it("drops a broken card entry alone, with the reason in the diagnostics", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "broken-cards",
        `
  export const name = "broken-cards";
  export function create() {
    return { name: "broken-cards" };
  }
  export const ui = {
    cards: [
      { slot: "Sidebar.Bottom", name: "badSlot" },
      { slot: "sidebar.bottom", name: "bad name!" },
      { slot: "sidebar.bottom", name: "twin" },
      { slot: "sidebar.bottom", name: "twin" },
      { slot: "sidebar.bottom", name: "escape", script: "../outside.js" },
      { slot: "sidebar.bottom", name: "missing", script: "missing.js" },
      { slot: "sidebar.bottom", name: "outside", script: "outside.js" },
      { slot: "sidebar.bottom", name: "wrong", script: "wrong.txt" },
      { slot: "sidebar.bottom", name: "good", script: "good.js" },
    ],
    render() {
      return { html: "ok" };
    },
  };
  `,
      );
      const root = join(h.extensionsDir, "broken-cards");
      await mkdir(join(root, "ui"), { recursive: true });
      await writeFile(join(root, "ui", "good.js"), "export const on = true;\n");
      await writeFile(join(root, "ui", "wrong.txt"), "not a script\n");
      // A script symlink whose real file sits outside `ui/`.
      await writeFile(join(root, "outside.js"), "export const off = true;\n");
      await symlink(join(root, "outside.js"), join(root, "ui", "outside.js"));

      const result = await h.loader.loadAll();

      expect(result.errors).toHaveLength(7);
      for (const message of result.errors) expect(message.startsWith("broken-cards: ")).toBe(true);
      // The two valid cards stay: the first `twin`, and `good`.
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["twin", "good"]);

      const listed = h.loader.list().find((entry) => entry.name === "broken-cards");
      const errors = listed?.ui?.errors ?? [];
      expect(errors).toHaveLength(7);
      expect(errors[0]).toContain("cards[0]");
      expect(errors[0]).toContain("slot");
      expect(errors[1]).toContain("name");
      expect(errors[2]).toContain("cards[3]");
      expect(errors[2]).toContain("already declared");
      expect(errors[3]).toContain('".."');
      expect(errors[4]).toContain("is not a file in ui/");
      expect(errors[5]).toContain("resolves outside ui/");
      expect(errors[6]).toContain("must end in .js or .mjs");
      expect(listed?.ui?.cards).toEqual(["twin", "good"]);
      // A bad entry does not fail the extension: its tools and sections installed.
      expect(listed?.error).toBeUndefined();
    });

    it("reports one error and keeps no cards when ui has no render function", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "no-render",
        `
  export const name = "no-render";
  export function create() {
    return { name: "no-render" };
  }
  export const ui = { cards: [{ slot: "sidebar.bottom", name: "ghost" }] };
  `,
      );

      const result = await h.loader.loadAll();

      expect(result.errors).toEqual(["no-render: ui has no render function"]);
      expect(h.ui.cards()).toEqual([]);
      expect(h.ui.names()).toEqual(["no-render"]);
      expect(h.ui.diagnostics("no-render")).toEqual({ cards: [], errors: ["ui has no render function"] });
      const listed = h.loader.list().find((entry) => entry.name === "no-render");
      expect(listed?.ui?.errors).toEqual(["ui has no render function"]);
    });

    it("drops a publish the browser could not read, and sends undefined as null", async () => {
      const h = await harness();
      await writeExtension(h.extensionsDir, "demo-cards", DEMO_V1);
      await mkdir(join(h.extensionsDir, "demo-cards", "ui"), { recursive: true });
      await writeFile(join(h.extensionsDir, "demo-cards", "ui", "toggle.js"), "export const on = true;\n");
      expect((await h.loader.loadAll()).errors).toEqual([]);
      const publish = capturedPublish();

      publish("status", "ready", undefined);
      expect(h.events).toEqual([
        { type: "ui_event", data: { extension: "demo-cards", card: "status", event: "ready", value: null } },
      ]);

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      publish("ghost-card", "ready", 1);
      publish("status", "not a name", 1);
      publish("status", "ready", 1n);
      publish("status", "ready", circular);
      publish("status", "ready", "x".repeat(UI_EVENT_MAX_BYTES));
      expect(h.events).toHaveLength(1);

      const errors = h.ui.diagnostics("demo-cards")?.errors ?? [];
      expect(errors).toHaveLength(5);
      expect(errors[0]).toContain("publish dropped");
      expect(errors[0]).toContain("is not a card of this extension");
      expect(errors[1]).toContain("event name");
      expect(errors[2]).toContain("bigint");
      expect(errors[3]).toContain("no JSON form");
      expect(errors[4]).toContain(`${UI_EVENT_MAX_BYTES} byte limit`);
      expect(h.events[0]?.data.extension).toBe("demo-cards");
    });

    it("passes the validated config and the timezone to render and action", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "configured-cards",
        `
  export const name = "configured-cards";
  export const configSchema = {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
    additionalProperties: false,
  };
  export function create(config) {
    return { name: "configured-cards", sections: [{ key: "c", render: () => config.greeting }] };
  }
  export const ui = {
    cards: [
      { slot: "sidebar.bottom", name: "box" },
      { slot: "sidebar.bottom", name: "quiet" },
    ],
    render(input) {
      globalThis.${CAPTURE_KEY} = { render: input };
      if (input.card === "quiet") return null;
      return { html: "<b>hi</b>" };
    },
    action(input) {
      globalThis.${CAPTURE_KEY} = { action: input };
      return { value: 7 };
    },
  };
  `,
      );
      await writeFile(join(h.extensionsDir, "configured-cards", "config.json"), JSON.stringify({ greeting: "hi" }));
      expect((await h.loader.loadAll()).errors).toEqual([]);

      const rendered = await h.ui.render("configured-cards", "box", { slot: "sidebar.bottom", timezone: "Asia/Tokyo" });
      expect(rendered).toEqual({ html: "<b>hi</b>" });
      expect(rendered !== null && "css" in rendered).toBe(false);
      expect(capture().render).toEqual({
        slot: "sidebar.bottom",
        card: "box",
        config: { greeting: "hi" },
        timezone: "Asia/Tokyo",
      });

      expect(await h.ui.render("configured-cards", "quiet", { slot: "sidebar.bottom", timezone: "Asia/Tokyo" })).toBeNull();

      const answered = await h.ui.action("configured-cards", "box", "save", { on: true }, { timezone: "Asia/Tokyo" });
      expect(answered).toEqual({ value: 7 });
      expect(capture().action).toEqual({
        card: "box",
        action: "save",
        value: { on: true },
        config: { greeting: "hi" },
        timezone: "Asia/Tokyo",
      });

      await expect(
        h.ui.render("configured-cards", "ghost", { slot: "sidebar.bottom", timezone: "Asia/Tokyo" }),
      ).rejects.toThrow(/has no card/);
      await expect(
        h.ui.action("demo-cards-missing", "box", "save", undefined, { timezone: "Asia/Tokyo" }),
      ).rejects.toThrow(/has no ui registration/);
    });

    it("throws when render or action returns the wrong shape", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "bad-render",
        `
  export const name = "bad-render";
  export function create() {
    return { name: "bad-render" };
  }
  export const ui = {
    cards: [{ slot: "sidebar.bottom", name: "box" }],
    render() {
      return { html: 42 };
    },
    action() {
      return { html: 9 };
    },
  };
  `,
      );
      expect((await h.loader.loadAll()).errors).toEqual([]);

      await expect(h.ui.render("bad-render", "box", { slot: "sidebar.bottom", timezone: "UTC" })).rejects.toThrow(
        /must return|no html string/,
      );
      await expect(h.ui.action("bad-render", "box", "save", undefined, { timezone: "UTC" })).rejects.toThrow(
        /html value that is not a string/,
      );
    });
  });

  describe("ui start hook", () => {
    it("does not hold the load pass when start never settles", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "slow-start",
        `
  export const name = "slow-start";
  export function create() {
    return { name: "slow-start" };
  }
  export const ui = {
    cards: [
      { slot: "sidebar.bottom", name: "patient" },
      { slot: "sidebar.top", name: "also" },
    ],
    render() {
      return { html: "ok" };
    },
    start() {
      return new Promise(() => undefined);
    },
  };
  `,
      );

      const result = await h.loader.loadAll();

      expect(result.reloaded).toEqual(["slow-start"]);
      expect(h.ui.names()).toEqual(["slow-start"]);
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["patient"]);
      expect(h.ui.cards("sidebar.top").map((card) => card.name)).toEqual(["also"]);
      expect(h.ui.diagnostics("slow-start")?.errors).toEqual([]);
      expect(h.loader.list().find((entry) => entry.name === "slow-start")?.error).toBeUndefined();
    }, 5000);

    it("reports a start hook that rejects after the load pass returned", async () => {
      const h = await harness();
      await writeExtension(
        h.extensionsDir,
        "rejecting-start",
        `
  export const name = "rejecting-start";
  export function create() {
    return { name: "rejecting-start" };
  }
  export const ui = {
    cards: [{ slot: "sidebar.bottom", name: "box" }],
    render() {
      return { html: "ok" };
    },
    async start() {
      await Promise.resolve();
      throw new Error("poll failed");
    },
  };
  `,
      );

      await h.loader.loadAll();
      // The cards stay: a failing hook is a diagnostic line, not a failed load.
      expect(h.ui.cards("sidebar.bottom").map((card) => card.name)).toEqual(["box"]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const errors = h.ui.diagnostics("rejecting-start")?.errors ?? [];
      expect(errors).toEqual(["ui.start threw: poll failed"]);
      expect(h.loader.list().find((entry) => entry.name === "rejecting-start")?.error).toBeUndefined();
    });
  });

  describe("ui_event on the conversation stream", () => {
    it("is a control event, so the conversation stream carries it", () => {
      expect(CONTROL_EVENTS.has("ui_event")).toBe(true);
    });
  });
});

describe("janitor.test.ts", () => {
  /**
   * Temporary trees this file created, removed after every test.
   *
   * A tree that outlives its test is a leak: the directory stays under the tmp
   * root for good, and a link inside it keeps pointing at another tree. Removal
   * after each test is what keeps the tmp root from filling up. The list is at
   * module scope so one hook covers every test in the file.
   */
  const tempTrees: string[] = [];

  async function makeTempTree(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempTrees.push(dir);
    return dir;
  }

  /**
   * Remove temporary trees. `rm` unlinks a symbolic link instead of following it,
   * so a tree that holds a link keeps the tree that link points at.
   */
  async function removeTempTrees(trees: readonly string[]): Promise<void> {
    await Promise.all(
      trees.map(async (tree) => {
        await rm(tree, { recursive: true, force: true });
      }),
    );
  }

  afterEach(async () => {
    await removeTempTrees(tempTrees.splice(0));
  });

  /**
   * A clock far enough ahead of a file's creation that the file counts as old.
   *
   * The janitor measures a file's age from the later of its mtime and its ctime,
   * and the kernel stamps the ctime with the moment the file was written. So a
   * test cannot make an old file by pushing its mtime into the past alone: it also
   * has to hand the janitor a clock that reads the file's creation as old. This is
   * the clock, and it is 48 hours ahead of the run.
   */
  function clockAhead(): number {
    return Date.now() + 48 * 60 * 60 * 1000;
  }

  /** Write a file whose mtime is `ageMs` before `now`, the clock the janitor reads. */
  async function makeFile(dir: string, name: string, content: string, ageMs: number, now: number): Promise<void> {
    const path = join(dir, name);
    await writeFile(path, content);
    await setTime(path, ageMs, now);
  }

  /** Give a path the same mtime `makeFile` would give a file it wrote. */
  async function setTime(path: string, ageMs: number, now: number): Promise<void> {
    const seconds = (now - ageMs) / 1000;
    await utimes(path, seconds, seconds);
  }

  /** Give a symbolic link that mtime. `utimes` follows a link, so the link needs `lutimes`. */
  async function setLinkTime(path: string, ageMs: number, now: number): Promise<void> {
    const seconds = (now - ageMs) / 1000;
    await lutimes(path, seconds, seconds);
  }

  describe("janitor", () => {
    let dir: string | undefined;

    it("deletes old and oversized files only in a verified private tmp", async () => {
      dir = await makeTempTree("pi-sec-janitor-");
      const now = clockAhead();
      await makeFile(dir, "old.txt", "old", 48 * 60 * 60 * 1000, now);
      await makeFile(dir, "big.txt", "x".repeat(2048), 1000, now);
      await makeFile(dir, "fresh.txt", "fresh", 1000, now);

      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024,
        now: () => now,
      });
      const report = await janitor.run();
      expect(report.skipped).toBe(false);
      const remaining = await readdir(dir);
      expect(remaining).toContain("fresh.txt");
      expect(remaining).not.toContain("old.txt");
      expect(remaining).not.toContain("big.txt");
    });

    it("ages out a file nine directories below a cleanup root", async () => {
      dir = await makeTempTree("pi-sec-janitor-deep-");
      const now = clockAhead();
      const deep = join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "i");
      await mkdir(deep, { recursive: true });
      await makeFile(deep, "old.txt", "old", 48 * 60 * 60 * 1000, now);
      await makeFile(deep, "fresh.txt", "fresh", 1000, now);

      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
      });
      await janitor.run();

      expect(await readdir(deep)).toEqual(["fresh.txt"]);
    });

    it("logs a directory too deep to walk", async () => {
      dir = await makeTempTree("pi-sec-janitor-toodeep-");
      const now = clockAhead();
      const levels = Array.from({ length: 66 }, () => "d");
      await mkdir(join(dir, ...levels), { recursive: true });
      const lines: Record<string, unknown>[] = [];
      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
        logger: {
          info: (message, fields) => lines.push({ message, ...fields }),
          warn: () => undefined,
        },
      });
      await janitor.run();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toBe("janitor cleanup summary");
      expect(lines[0]?.tooDeep).toBe(1);
      expect(lines[0]?.deepSample).toEqual([join(dir, ...levels.slice(0, 65))]);
    });

    it("does not follow a directory symlink out of the cleanup root", async () => {
      dir = await makeTempTree("pi-sec-janitor-root-");
      const outside = await makeTempTree("pi-sec-janitor-outside-");
      const now = clockAhead();
      await mkdir(join(dir, "work", "sub"), { recursive: true });
      await symlink(outside, join(dir, "work", "sub", "node_modules"), "dir");
      await setLinkTime(join(dir, "work", "sub", "node_modules"), 1000, now);
      await makeFile(outside, "package.json", "outside", 48 * 60 * 60 * 1000, now);
      await mkdir(join(outside, "lib"), { recursive: true });
      await makeFile(join(outside, "lib"), "index.js", "outside", 48 * 60 * 60 * 1000, now);
      await makeFile(dir, "old.txt", "old", 48 * 60 * 60 * 1000, now);

      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
      });
      await janitor.run();

      // The walk stops at the link, so a tree the root does not contain keeps its files.
      expect(await readdir(outside)).toContain("package.json");
      expect(await readdir(join(outside, "lib"))).toContain("index.js");
      // The root's own old file is still a victim, and the fresh link itself is not.
      expect(await readdir(dir)).not.toContain("old.txt");
      expect(await readdir(join(dir, "work", "sub"))).toContain("node_modules");
    });

    it("logs one summary line per cleanup root", async () => {
      dir = await makeTempTree("pi-sec-janitor-root-");
      const now = clockAhead();
      await makeFile(dir, "old.txt", "old", 48 * 60 * 60 * 1000, now);
      await makeFile(dir, "fresh.txt", "fresh", 1000, now);
      const lines: Record<string, unknown>[] = [];
      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
        logger: {
          info: (message, fields) => lines.push({ message, ...fields }),
          warn: () => undefined,
        },
      });
      await janitor.run();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toBe("janitor cleanup summary");
      expect(lines[0]?.root).toBe(dir);
      expect(lines[0]?.deleted).toBe(1);
      expect(lines[0]?.bytes).toBe(3);
      expect(lines[0]?.linksSkipped).toBe(0);
      expect(lines[0]?.sample).toEqual([join(dir, "old.txt")]);
      expect(await readdir(dir)).toContain("fresh.txt");
    });

    it("logs nothing when it deleted nothing and skipped no link", async () => {
      dir = await makeTempTree("pi-sec-janitor-");
      const now = clockAhead();
      await makeFile(dir, "fresh.txt", "fresh", 1000, now);
      let calls = 0;
      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
        logger: {
          info: () => {
            calls += 1;
          },
          warn: () => undefined,
        },
      });
      const report = await janitor.run();

      expect(report.deleted).toEqual([]);
      expect(calls).toBe(0);
    });

    it("bounds the sample and reports the links it did not follow", async () => {
      dir = await makeTempTree("pi-sec-janitor-root-");
      const outside = await makeTempTree("pi-sec-janitor-outside-");
      const now = clockAhead();
      await writeFile(join(outside, "keep.txt"), "keep");
      for (let index = 0; index < 12; index += 1) {
        await makeFile(dir, `old-${index}.txt`, "old", 48 * 60 * 60 * 1000, now);
      }
      await symlink(outside, join(dir, "node_modules"), "dir");
      await setLinkTime(join(dir, "node_modules"), 1000, now);
      const lines: Record<string, unknown>[] = [];
      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        now: () => now,
        logger: {
          info: (message, fields) => lines.push({ message, ...fields }),
          warn: () => undefined,
        },
      });
      await janitor.run();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.deleted).toBe(12);
      expect(lines[0]?.sample).toHaveLength(10);
      expect(lines[0]?.linksSkipped).toBe(1);
      expect(lines[0]?.linkSample).toEqual([join(dir, "node_modules")]);
      // The link points at a tree this root does not contain, so that tree keeps its files.
      expect(await readdir(outside)).toContain("keep.txt");
    });

    it("skips tmp cleanup without a private tmp", async () => {
      dir = await makeTempTree("pi-sec-janitor-");
      const now = clockAhead();
      await makeFile(dir, "old.txt", "old", 48 * 60 * 60 * 1000, now);
      const janitor = new Janitor({
        privateTmp: false,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1,
        eagerThresholdBytes: 1,
        now: () => now,
      });
      const report = await janitor.run();
      expect(report.skipped).toBe(false);
      expect(await readdir(dir)).toContain("old.txt");
    });

    it("keeps a file whose mtime is old but whose ctime is recent", async () => {
      dir = await makeTempTree("pi-sec-janitor-");
      // `tar -x`, `cp -p` and `rsync -a` keep the source's mtime and write a new
      // file, so the kernel stamps the copy with the moment of the copy. The file
      // is an hour old in this tree, not the 48 hours its mtime says.
      await makeFile(dir, "unpacked.txt", "old", 48 * 60 * 60 * 1000, Date.now());

      const janitor = new Janitor({
        privateTmp: true,
        tmpDirs: [dir],
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
      });
      const report = await janitor.run();

      // Age is measured from the later of the two times, which is the copy's own.
      expect(report.deleted).toEqual([]);
      expect(await readdir(dir)).toContain("unpacked.txt");
    });

    it("keeps such a file in the cache directory as well", async () => {
      const cache = await makeTempTree("pi-sec-janitor-cache-");
      await makeFile(cache, "unpacked.txt", "old", 48 * 60 * 60 * 1000, Date.now());

      const janitor = new Janitor({
        privateTmp: false,
        maxAgeHours: 6,
        maxBytes: 1024 * 1024,
        eagerThresholdBytes: 1024 * 1024,
        cacheDir: cache,
      });
      const report = await janitor.run();

      expect(report.deleted).toEqual([]);
      expect(await readdir(cache)).toContain("unpacked.txt");
    });
  });

  describe("supervisor pid helpers", () => {
    it("writes and reads a pid file", async () => {
      const home = await makeTempTree("pi-sec-pid-");
      const pidFile = join(home, "pi-sec.pid");
      await writePid(pidFile, process.pid);
      expect(await readPid(pidFile)).toBe(process.pid);
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(isProcessAlive(999_999_999)).toBe(false);
    });
  });
});

describe("secrets.test.ts", () => {
  describe("secrets", () => {
    it("redacts raw, base64, and percent-encoded variants with fixed dummies", () => {
      const redactor = createRedactor([{ name: "gh_token", value: "s3cr3t-value" }]);
      const raw = redactor.redact("token is s3cr3t-value here");
      const b64 = redactor.redact(`token is ${Buffer.from("s3cr3t-value").toString("base64")} here`);
      const url = redactor.redact(`token is ${encodeURIComponent("s3cr3t-value")} here`);
      expect(raw).toBe("token is \u27e6secret:gh_token\u27e7 here");
      expect(b64).toBe("token is \u27e6secret:gh_token\u27e7 here");
      expect(url).toBe("token is \u27e6secret:gh_token\u27e7 here");
    });

    it("does not preserve value length in the dummy", () => {
      const short = createRedactor([{ name: "a", value: "x" }]).redact("x");
      const long = createRedactor([{ name: "a", value: "x".repeat(100) }]).redact("x".repeat(100));
      expect(short).toBe(long);
    });

    it("redacts a secret split across streamed chunks", () => {
      const redactor = createRedactor([{ name: "tok", value: "abcdefghij" }]);
      const stream = createRedactingStream(redactor);
      let output = "";
      for (const chunk of ["abc", "defgh", "ij", " tail"]) output += stream.push(chunk);
      output += stream.flush();
      expect(output).toBe("\u27e6secret:tok\u27e7 tail");
      expect(output).not.toContain("abcdefghij");
    });

    it("loads file secrets and env entries from the store", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      await writeFile(join(dir, "gh_token"), "ghp_secret\n");
      await writeFile(join(dir, "env"), "EXAMPLE_KEY=abc123\n# comment\nMALFORMED\n");
      const registry = new SecretRegistry({ dir, includeModelCredentials: false });
      await registry.load();
      expect(registry.names()).toContain("gh_token");
      expect(registry.names()).toContain("EXAMPLE_KEY");
      expect(registry.redactor().redact("ghp_secret abc123")).toBe("\u27e6secret:gh_token\u27e7 \u27e6secret:EXAMPLE_KEY\u27e7");
    });

    it("does not quote a malformed env line in a warning", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const madeUp = ["made", "up", "stray", "value"].join("-");
      await writeFile(join(dir, "env"), `EXAMPLE_KEY=abc12345\n${madeUp}\n`);
      const warnings: string[] = [];
      const registry = new SecretRegistry({
        dir,
        includeModelCredentials: false,
        onWarning: (message) => warnings.push(message),
      });
      await registry.load();
      expect(registry.names()).toEqual(["EXAMPLE_KEY"]);
      expect(warnings).toHaveLength(1);
      expect(registry.diagnostics()).toHaveLength(1);
      expect(JSON.stringify([warnings, registry.diagnostics()])).not.toContain(madeUp);
    });

    it("registers credential material from auth.json, not its metadata", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      // Outside the store, or the store would register the whole file as one secret.
      const authPath = join(await mkdtemp(join(tmpdir(), "pi-sec-auth-")), "auth.json");
      await writeFile(
        authPath,
        JSON.stringify({ deepseek: { type: "apiKey", key: "sk-very-secret-value", expiresAt: 1234 } }),
      );
      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      await registry.load();

      expect(registry.names()).toEqual(["model-auth.deepseek.key"]);
      // The auth type is a discriminator. Redacting an ordinary word would rewrite
      // every file that contains it, including the source that names it.
      expect(registry.redactor().redact("the apiKey column")).toBe("the apiKey column");
      expect(registry.redactor().redact("key sk-very-secret-value")).toBe(
        "key \u27e6secret:model-auth.deepseek.key\u27e7",
      );
    });

    it("ignores values too short to be credential material", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const authPath = join(await mkdtemp(join(tmpdir(), "pi-sec-auth-")), "auth.json");
      await writeFile(authPath, JSON.stringify({ p: { apiKey: "dev" }, q: { secret: "none" } }));
      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      await registry.load();

      expect(registry.names()).toEqual([]);
      expect(registry.redactor().redact("dev none")).toBe("dev none");
    });

    it("auto-registers model credentials from auth.json", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, JSON.stringify({ deepseek: { apiKey: "sk-very-secret" } }));
      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      await registry.load();
      expect(registry.names().some((name) => name.startsWith("model-auth.deepseek"))).toBe(true);
      expect(registry.redactor().redact("key sk-very-secret")).toContain("\u27e6secret:");
    });

    it("does not register a file reference in auth.json; the value comes from the secret file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      await writeFile(join(dir, "model-auth.deepseek.key"), "sk-fake-file-value-123\n", { mode: 0o600 });
      const authPath = join(await mkdtemp(join(tmpdir(), "pi-sec-auth-")), "auth.json");
      await writeFile(
        authPath,
        JSON.stringify({
          deepseek: { type: "api_key", key: { file: "model-auth.deepseek.key" } },
          anthropic: { type: "oauth", access: { file: "model-auth.anthropic.access" }, expires: 1 },
        }),
      );
      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      await registry.load();

      expect(registry.names()).toEqual(["model-auth.deepseek.key"]);
      // The reference string is a file name. Registered, it would redact the name everywhere.
      expect(registry.redactor().redact("file model-auth.anthropic.access")).toBe("file model-auth.anthropic.access");
      expect(registry.redactor().redact("key sk-fake-file-value-123")).toBe("key \u27e6secret:model-auth.deepseek.key\u27e7");
    });
  });
});

describe("secrets-failclosed.test.ts", () => {
  /** Every `length`-character piece of `value`. */
  function piecesOf(value: string, length: number): string[] {
    const out: string[] = [];
    for (let start = 0; start + length <= value.length; start += 1) out.push(value.slice(start, start + length));
    return out;
  }

  describe("secret store failure modes", () => {
    it("fails closed when the store path is not a directory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const file = join(dir, "not-a-dir");
      await writeFile(file, "x");
      const registry = new SecretRegistry({ dir: file, includeModelCredentials: false });
      await expect(registry.load()).rejects.toThrow(/not a directory/);
    });

    it("fails closed when model credentials are present but unparseable", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, "{ not json");
      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      await expect(registry.load()).rejects.toThrow(/model credentials unreadable/);
    });

    it("keeps every piece of a model credential out of the unreadable sentence", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const authPath = join(dir, "auth.json");
      // The value is written without quotes, so V8's own sentence quotes the text
      // around the token it failed on, and that text starts with the value.
      const fake = "sk-fake-0123456789abcdefghij-KLAMZOR";
      await writeFile(authPath, `{"deepseek":{"type":"api_key","key":${fake}}}`);

      const registry = new SecretRegistry({ dir, includeModelCredentials: true, modelCredentialPaths: [authPath] });
      let sentence = "";
      await registry.load().then(
        () => {
          throw new Error("the load must fail closed");
        },
        (error: unknown) => {
          sentence = String(error);
        },
      );

      expect(sentence).toContain(authPath);
      expect(sentence).toContain("is not valid JSON");
      for (const piece of piecesOf(fake, 12)) expect(sentence).not.toContain(piece);
      // V8 quotes about ten characters of the text it failed on, so an eight
      // character check catches a leak that the twelve character one misses.
      for (const piece of piecesOf(fake, 8)) expect(sentence).not.toContain(piece);
    });

    it("treats a missing store as empty", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-secrets-"));
      const registry = new SecretRegistry({ dir: join(dir, "absent"), includeModelCredentials: false });
      await registry.load();
      expect(registry.names()).toEqual([]);
      expect(registry.hasEntries()).toBe(false);
    });
  });
});

describe("storage-mode.test.ts", () => {
  /**
   * `state/sec.sqlite` is the whole conversation history, and `0600` is the
   * convention for every file under the control structure. SQLite creates its
   * files with `0644` masked by the process umask, so the mode must be forced.
   * These tests open real databases, because the failure lives in SQLite and not
   * in our own code.
   */

  /** The permission bits of a path, as a number such as `0o600`. */
  async function mode(path: string): Promise<number> {
    return (await stat(path)).mode & 0o777;
  }

  /** A directory of its own, so one test cannot see the files of another. */
  async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "pi-sec-sqlite-mode-"));
  }

  describe("sqlite file modes", () => {
    it("opens a new database, its log, and its shared memory at 0600", async () => {
      const path = join(await tempDir(), "sec.sqlite");
      const storage = await openPrivateSqliteStorage(path);
      try {
        expect(await mode(path)).toBe(0o600);
        expect(await mode(`${path}-wal`)).toBe(0o600);
        expect(await mode(`${path}-shm`)).toBe(0o600);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    });

    it("hardens a database that an older run left at 0644", async () => {
      const path = join(await tempDir(), "sec.sqlite");
      // A database created before the mode was enforced, sidecars included.
      const raw = await openNodeSqliteStorage(path);
      await chmod(path, 0o644);
      await chmod(`${path}-wal`, 0o644);
      await chmod(`${path}-shm`, 0o644);
      expect(await mode(path)).toBe(0o644);

      await raw.close(BACKGROUND_CONTEXT);
      const storage = await openPrivateSqliteStorage(path);
      try {
        expect(await mode(path)).toBe(0o600);
        expect(await mode(`${path}-wal`)).toBe(0o600);
        expect(await mode(`${path}-shm`)).toBe(0o600);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    });

    it("gives a sidecar created after the open the mode of the database", async () => {
      const path = join(await tempDir(), "sec.sqlite");
      const first = await openPrivateSqliteStorage(path);
      await first.close(BACKGROUND_CONTEXT);
      // Closing removes the log and the shared memory, so the next open recreates
      // them. A permissive umask here stands for any later writer on the host: it
      // must not be able to widen a database that is already `0600`.
      const previous = process.umask(0o022);
      try {
        const raw = await openNodeSqliteStorage(path);
        try {
          expect(await mode(`${path}-wal`)).toBe(0o600);
          expect(await mode(`${path}-shm`)).toBe(0o600);
        } finally {
          await raw.close(BACKGROUND_CONTEXT);
        }
      } finally {
        process.umask(previous);
      }
    });

    it("names the database and its two sidecars", () => {
      expect(sqliteFiles("/tmp/x/sec.sqlite")).toEqual([
        "/tmp/x/sec.sqlite",
        "/tmp/x/sec.sqlite-wal",
        "/tmp/x/sec.sqlite-shm",
      ]);
    });
  });
});

describe("notes.test.ts", () => {
  describe("admin notes", () => {
    it("keeps what happened, newest last, with a time", () => {
      const notes = new AdminNotes();
      notes.add("first", 1000);
      notes.add("second", 2000);
      expect(notes.all()).toEqual([
        { at: 1000, text: "first" },
        { at: 2000, text: "second" },
      ]);
    });

    it("moves a repeated note to the end instead of stacking it", () => {
      // A mount conflict or a failed reload repeats on every request that hits it;
      // the operator needs to see that it is still happening, not fifty copies.
      const notes = new AdminNotes();
      notes.add("same", 1000);
      notes.add("other", 1500);
      notes.add("same", 2000);
      expect(notes.all()).toEqual([
        { at: 1500, text: "other" },
        { at: 2000, text: "same" },
      ]);
    });

    it("drops the oldest once it is full", () => {
      const notes = new AdminNotes(3);
      for (let index = 1; index <= 5; index += 1) notes.add(`note ${index}`, index);
      expect(notes.all().map((note) => note.text)).toEqual(["note 3", "note 4", "note 5"]);
      expect(NOTE_LIMIT).toBeGreaterThan(0);
    });

    it("hands out a copy, so a caller cannot rearrange the list", () => {
      const notes = new AdminNotes();
      notes.add("keep", 1);
      const taken = notes.all() as { at: number; text: string }[];
      taken.push({ at: 2, text: "not mine" });
      expect(notes.all()).toHaveLength(1);
    });
  });
});

describe("test-tmpdir.test.ts", () => {
  /**
   * The setup module this file inherits from `vitest.config.ts`: the root it makes
   * before a test file starts, and what a child process of that file sees.
   *
   * The root is a directory the file's own process made, named `pi-sec-test-`.
   * `tmpdir()` must answer with it, and a child must inherit it, because that is
   * how the eighty existing call sites land inside the root without a change.
   */
  describe("the temporary directory of a test file", () => {
    it("is a root of the file's own, named pi-sec-test-", () => {
      const dir = tmpdir();

      expect(basename(dir)).toMatch(/^pi-sec-test-[0-9A-Za-z]+$/);
      expect(existsSync(dir)).toBe(true);
      expect(process.env["TMPDIR"]).toBe(dir);
    });

    it("is the same root in a child process the file starts", () => {
      const script = "import { tmpdir } from 'node:os'; process.stdout.write(tmpdir());";

      const childDir = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });

      expect(childDir).toBe(tmpdir());
    });

    it("is a home of the file's own, inside that root, and the same in a child process", () => {
      // The setup module also gives the file a home, so a configuration default such
      // as `~/attachments` cannot reach the home of the account that runs the suite.
      const home = process.env["HOME"];
      const dir = tmpdir();

      expect(home).toBeDefined();
      expect(home!.startsWith(dir + sep)).toBe(true);
      expect(existsSync(home!)).toBe(true);
      expect(homedir()).toBe(home);

      const script = "import { homedir } from 'node:os'; process.stdout.write(homedir());";

      const childHome = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });

      expect(childHome).toBe(home);
    });
  });
});
