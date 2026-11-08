/**
 * Runtime extensions that export model providers.
 *
 * A fake provider answers every request with a fixed text, so a request here
 * proves which registration the runtime used without a network call. The
 * fixture in `fixtures/extensions/acme` exports both entry forms: the
 * `{ id, config }` pair and a complete `Provider` object.
 */
import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels } from "../src/agent/models.ts";
import { ExtensionLoader } from "../src/registry/loader.ts";
import { ProviderRegistry, preloadExtensionProviders, warnMissingVmodels } from "../src/registry/providers.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import type { Config } from "../src/config/schema.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/acme/", import.meta.url));

/**
 * Temporary homes this file created.
 *
 * The loader links this checkout's `node_modules` into the extensions directory
 * it is given, so the link is removed before the tree is: a recursive removal
 * that followed it would delete the checkout's dependencies.
 */
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlink(join(root, ".pi", "sec", "extensions", "node_modules")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

type LogLine = { readonly level: "warn" | "info"; readonly message: string; readonly fields?: Record<string, unknown> };

interface Sandbox {
  readonly root: string;
  readonly paths: Paths;
  readonly log: LogLine[];
  readonly logger: {
    warn(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
  };
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-providers-"));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "default.md"), "", "utf8");
  const log: LogLine[] = [];
  return {
    root,
    paths,
    log,
    logger: {
      warn: (message, fields) => log.push({ level: "warn", message, fields }),
      info: (message, fields) => log.push({ level: "info", message, fields }),
    },
  };
}

/** Copy the fixture into one sandbox's extensions directory, with its config. */
async function installFixture(sb: Sandbox, name = "acme", config?: unknown): Promise<void> {
  const target = join(sb.paths.extensionsDir, name);
  await cp(FIXTURE, target, { recursive: true });
  if (config !== undefined) await writeFile(join(target, "config.json"), JSON.stringify(config), "utf8");
}

interface Loaded {
  readonly models: ModelRuntime;
  readonly providers: ProviderRegistry;
  readonly registry: Registry<ToolRegistration>;
  readonly loader: ExtensionLoader;
  readonly afterLoadCount: () => number;
}

async function load(sb: Sandbox): Promise<Loaded> {
  const models = await createModels({
    authPath: sb.paths.authFile,
    modelsPath: null,
    secretsDir: sb.paths.secretsDir,
  });
  const providers = new ProviderRegistry({ host: models, logger: sb.logger });
  const registry = createRegistry<ToolRegistration>();
  let afterLoad = 0;
  const loader = new ExtensionLoader({
    extensionsDir: sb.paths.extensionsDir,
    registry,
    logger: sb.logger,
    providers,
    afterLoad: () => {
      afterLoad += 1;
    },
  });
  return { models, providers, registry, loader, afterLoadCount: () => afterLoad };
}

/** The text one model answers with, through the runtime the loader registered it in. */
async function answerOf(models: ModelRuntime, provider: string, modelId: string): Promise<string> {
  const model = models.getModel(provider, modelId);
  expect(model, `${provider}/${modelId} is not in the catalog`).toBeDefined();
  const message = await models.completeSimple(model!, {
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  });
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

describe("extension model providers", () => {
  it("registers the config pair and the provider object, and installs the rest of the extension", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "fixture answer" });
    const loaded = await load(sb);

    const result = await loaded.loader.loadAll();
    expect(result).toEqual({ reloaded: ["acme"], errors: [] });
    expect(loaded.providers.list()).toEqual([
      { id: "acme", extension: "acme" },
      { id: "acme-native", extension: "acme" },
    ]);
    expect(await answerOf(loaded.models, "acme", "acme-fake-chat")).toBe("fixture answer");
    expect(await answerOf(loaded.models, "acme-native", "acme-native-chat")).toBe("fixture answer");

    // The provider export does not replace the rest of the extension.
    expect(loaded.registry.snapshot().extension("acme")).toBeDefined();
    // One post-load pass per load, which is where the vmodel check runs.
    expect(loaded.afterLoadCount()).toBe(1);

    await loaded.loader.reload();
    expect(loaded.afterLoadCount()).toBe(2);
  });

  it("replaces an extension's providers when it reloads", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "first answer" });
    const loaded = await load(sb);
    await loaded.loader.loadAll();
    expect(await answerOf(loaded.models, "acme", "acme-fake-chat")).toBe("first answer");

    // A different provider id, so the reload has to take the old one back rather
    // than register over it.
    await writeFile(
      join(sb.paths.extensionsDir, "acme", "config.json"),
      JSON.stringify({ answer: "second answer", id: "acme-two" }),
      "utf8",
    );
    const reloaded = await loaded.loader.reload();
    expect(reloaded.errors).toEqual([]);
    expect(loaded.models.getModel("acme", "acme-fake-chat")).toBeUndefined();
    expect(await answerOf(loaded.models, "acme-two", "acme-fake-chat")).toBe("second answer");
    expect(loaded.providers.ownerOf("acme-two")).toBe("acme");
    expect(loaded.providers.ownerOf("acme")).toBeUndefined();
  });

  it("overrides a built-in provider and gives it back when the extension directory goes", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "proxy answer", id: "deepseek" });
    const loaded = await load(sb);
    await loaded.loader.loadAll();

    // The built-in model is replaced by the extension's list, which is what a
    // a proxy uses this for.
    expect(loaded.models.getModel("deepseek", "deepseek-flash")).toBeUndefined();
    expect(await answerOf(loaded.models, "deepseek", "acme-fake-chat")).toBe("proxy answer");
    expect(sb.log.some((line) => line.message === "extension provider overrides a catalog provider" && line.fields?.provider === "deepseek")).toBe(true);

    await rm(join(sb.paths.extensionsDir, "acme"), { recursive: true, force: true });
    const after = await loaded.loader.reload();
    expect(after.reloaded).toEqual([]);
    expect(loaded.models.getModel("deepseek", "acme-fake-chat")).toBeUndefined();
    expect(loaded.models.getModel("deepseek", "deepseek-flash")).toBeDefined();
    expect(loaded.providers.list()).toEqual([]);
    expect(sb.log.some((line) => line.message === "extension providers unregistered" && line.fields?.name === "acme")).toBe(true);
  });

  it("keeps the first registration of a shared id and reports the second extension", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "first extension" });
    const dup = join(sb.paths.extensionsDir, "dup");
    await mkdir(dup, { recursive: true });
    await writeFile(
      join(dup, "index.js"),
      `const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function config(id, name) {
  return {
    name,
    baseUrl: "http://127.0.0.1:1/v1",
    api: "dup-api",
    apiKey: "dup-fake-key",
    models: [{ id, name, input: ["text"], cost, contextWindow: 1000, maxTokens: 100, reasoning: false }],
  };
}
export default { name: "dup" };
export const providers = [
  { id: "acme", config: config("dup-chat", "Dup chat") },
  { id: "dup-other", config: config("dup-other-chat", "Dup other") },
];
`,
      "utf8",
    );

    const loaded = await load(sb);
    const result = await loaded.loader.loadAll();
    expect(result.reloaded).toEqual(["acme", "dup"]);
    expect(result.errors).toEqual(['dup: provider "acme" is already registered by extension "acme"']);

    // The first extension keeps the id; the second one keeps its other provider,
    // and its own extension is installed.
    expect(loaded.providers.ownerOf("acme")).toBe("acme");
    expect(await answerOf(loaded.models, "acme", "acme-fake-chat")).toBe("first extension");
    expect(loaded.models.getModel("dup-other", "dup-other-chat")).toBeDefined();
    expect(loaded.registry.snapshot().extension("dup")).toBeDefined();
  });

  it("installs a .ts module that defines create() and exports providers", async () => {
    const sb = await sandbox();
    const dir = join(sb.paths.extensionsDir, "ts-factory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "index.ts"),
      `const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const name = "ts-factory";
export function create() {
  return { name: "ts-factory" };
}
export function providers() {
  return [
    {
      id: "ts-factory",
      config: {
        name: "Ts factory",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "ts-factory-api",
        apiKey: "ts-factory-fake-key",
        models: [{ id: "ts-factory-chat", name: "Ts factory chat", input: ["text"], cost, contextWindow: 1000, maxTokens: 100, reasoning: false }],
      },
    },
  ];
}
`,
      "utf8",
    );
    const loaded = await load(sb);
    const result = await loaded.loader.loadAll();
    expect(result).toEqual({ reloaded: ["ts-factory"], errors: [] });
    expect(loaded.registry.snapshot().extension("ts-factory")).toBeDefined();
    expect(loaded.providers.list()).toEqual([{ id: "ts-factory", extension: "ts-factory" }]);
    expect(loaded.models.getModel("ts-factory", "ts-factory-chat")).toBeDefined();
  });

  it("keeps the previous registration when a reload cannot load the module", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "before the break" });
    const loaded = await load(sb);
    await loaded.loader.loadAll();

    await writeFile(join(sb.paths.extensionsDir, "acme", "index.js"), "export const providers = [ };\n", "utf8");
    const reloaded = await loaded.loader.reload();
    expect(reloaded.errors.length).toBe(1);
    expect(reloaded.errors[0]).toContain("acme:");
    expect(await answerOf(loaded.models, "acme", "acme-fake-chat")).toBe("before the break");
    expect(loaded.providers.ownerOf("acme")).toBe("acme");
  });

  it("keeps the previous registration when the providers function throws", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "kept answer" });
    const loaded = await load(sb);
    await loaded.loader.loadAll();

    await writeFile(
      join(sb.paths.extensionsDir, "acme", "config.json"),
      JSON.stringify({ answer: "kept answer", broken: true }),
      "utf8",
    );
    const reloaded = await loaded.loader.reload();
    expect(reloaded.errors).toEqual(['acme: providers() threw: acme: broken is set in config.json']);
    // The extension itself still installs: only its providers were refused.
    expect(reloaded.reloaded).toEqual(["acme"]);
    expect(await answerOf(loaded.models, "acme", "acme-fake-chat")).toBe("kept answer");
  });

  it("warns once about an extension that cannot load and keeps the others' providers", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "preloaded answer" });
    const wrecked = join(sb.paths.extensionsDir, "wrecked");
    await mkdir(wrecked, { recursive: true });
    await writeFile(join(wrecked, "index.js"), "export const providers = [ };\n", "utf8");

    // The read-only preload, which the daemon's `start` runs before it reads the
    // catalog: it registers providers and installs nothing else.
    const loaded = await load(sb);
    const result = await preloadExtensionProviders({
      extensionsDir: sb.paths.extensionsDir,
      registry: loaded.providers,
      logger: sb.logger,
    });

    // One line for the broken extension, and it names the directory.
    const warnings = sb.log.filter((line) => line.message === "extension provider preload failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.["name"]).toBe("wrecked");
    expect(typeof warnings[0]?.fields?.["error"]).toBe("string");

    // The extension beside it is still registered and still owns its ids.
    expect(result.loaded).toEqual(["acme"]);
    expect(loaded.providers.list()).toEqual([
      { id: "acme", extension: "acme" },
      { id: "acme-native", extension: "acme" },
    ]);
    expect(loaded.providers.ownerOf("acme")).toBe("acme");
  });

  it("warns about a vmodel whose model left the catalog, naming the vmodel and the provider", async () => {
    const sb = await sandbox();
    const models = await createModels({
      authPath: sb.paths.authFile,
      modelsPath: null,
      secretsDir: sb.paths.secretsDir,
    });
    const config = {
      vmodels: {
        kept: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium", prompt: "default" },
        gone: { provider: "acme", modelId: "acme-fake-chat", thinkingLevel: "medium", prompt: "default" },
      },
    } as unknown as Config;

    warnMissingVmodels({ config, models, logger: sb.logger });
    const warnings = sb.log.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("vmodel names a model the catalog does not have");
    expect(warnings[0]?.fields).toEqual({ vmodel: "gone", provider: "acme", model: "acme-fake-chat" });
  });
});

/**
 * The `virtual: true` marker of a provider entry.
 *
 * The marker says the provider answers no request itself: an extension routes
 * each one to another provider, and pi-sec's ledger records the call under the
 * provider that answered. The usage page then has no card for it. This file
 * checks the registry's half only: that the marker of either entry form is
 * recorded, and that it goes when the registration goes.
 */
describe("a virtual provider entry", () => {
  /**
   * An extension whose two entries carry the marker, and whose third one does not.
   *
   * `marked` false writes the same extension with no marker at all, so one reload
   * separates "the entry does not say" from "the entry says no".
   */
  async function installMarked(sb: Sandbox, marked: boolean): Promise<void> {
    const dir = join(sb.paths.extensionsDir, "virtual");
    await mkdir(dir, { recursive: true });
    const marker = marked ? "virtual: true," : "";
    await writeFile(
      join(dir, "index.js"),
      `const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function config(id, name) {
  return {
    name,
    baseUrl: "http://127.0.0.1:1/v1",
    api: "virtual-api",
    apiKey: "virtual-fake-key",
    models: [{ id, name, input: ["text"], cost, contextWindow: 1000, maxTokens: 100, reasoning: false }],
  };
}
function native(id) {
  return {
    ${marker}
    id,
    name: id,
    auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: "virtual-native-key" }, source: "fixture" }) } },
    getModels: () => [{ id: id + "-chat", name: id, input: ["text"], cost, contextWindow: 1000, maxTokens: 100, reasoning: false }],
    streamSimple: () => { throw new Error("not called"); },
    stream: () => { throw new Error("not called"); },
  };
}
export default { name: "virtual" };
export const providers = [
  { ${marker} id: "routed-config", config: config("routed-config-chat", "Routed config") },
  native("routed-native"),
  { id: "plain-config", config: config("plain-config-chat", "Plain config") },
];
`,
      "utf8",
    );
  }

  it("records the marker of both entry forms, and not its absence", async () => {
    const sb = await sandbox();
    await installMarked(sb, true);
    const loaded = await load(sb);
    const result = await loaded.loader.loadAll();
    expect(result.errors).toEqual([]);

    expect(loaded.providers.isVirtual("routed-config")).toBe(true);
    expect(loaded.providers.isVirtual("routed-native")).toBe(true);
    // An entry that states no marker is not virtual, and neither is an id that
    // nothing registered.
    expect(loaded.providers.isVirtual("plain-config")).toBe(false);
    expect(loaded.providers.isVirtual("absent")).toBe(false);
  });

  it("keeps the marker in step with a reload that drops it", async () => {
    const sb = await sandbox();
    await installMarked(sb, true);
    const loaded = await load(sb);
    await loaded.loader.loadAll();
    expect(loaded.providers.isVirtual("routed-config")).toBe(true);

    await installMarked(sb, false);
    const reloaded = await loaded.loader.reload();
    expect(reloaded.errors).toEqual([]);
    // The ids stay registered; only the marker goes.
    expect(loaded.providers.ownerOf("routed-config")).toBe("virtual");
    expect(loaded.providers.isVirtual("routed-config")).toBe(false);
    expect(loaded.providers.isVirtual("routed-native")).toBe(false);
  });

  it("drops the marker when the extension directory goes", async () => {
    const sb = await sandbox();
    await installMarked(sb, true);
    const loaded = await load(sb);
    await loaded.loader.loadAll();

    await rm(join(sb.paths.extensionsDir, "virtual"), { recursive: true, force: true });
    await loaded.loader.reload();
    expect(loaded.providers.list()).toEqual([]);
    expect(loaded.providers.isVirtual("routed-config")).toBe(false);
    expect(loaded.providers.isVirtual("routed-native")).toBe(false);
  });

  it("records nothing virtual for the fixture, whose entries carry no marker", async () => {
    const sb = await sandbox();
    await installFixture(sb, "acme", { answer: "fixture answer" });
    const loaded = await load(sb);
    await loaded.loader.loadAll();
    expect(loaded.providers.isVirtual("acme")).toBe(false);
    expect(loaded.providers.isVirtual("acme-native")).toBe(false);
  });
});
