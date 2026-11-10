/**
 * The model list synthetic.new serves: the mapping, the costs, the stored
 * answer and the reads that replace it.
 *
 * Nothing here reaches synthetic.new. The answers are the shape the service's
 * model list returned on 2026-10-28, and
 * every fetch is a fake.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createModels } from "../src/agent/models.ts";
import {
  SYNTHETIC_CATALOG_REFRESH_MS,
  SYNTHETIC_MODELS_URL,
  SyntheticModelCatalog,
  createSyntheticCatalog,
  parseSyntheticCatalogResponse,
  readSyntheticCatalogFile,
  syntheticCatalogFile,
  syntheticModelsFromCatalog,
  writeSyntheticCatalogFile,
  type SyntheticCatalogHost,
  type SyntheticModelEntry,
} from "../src/agent/synthetic-catalog.ts";
import { SYNTHETIC_MODEL_ID, SYNTHETIC_PROVIDER_ID } from "../src/agent/synthetic-provider.ts";
import { loadConfig } from "../src/config/load.ts";
import { openCatalog } from "../src/cli.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";

const DEEPSEEK_ID = "hf:deepseek-ai/DeepSeek-V4.1-Flash";
const KIMI_ID = "hf:moonshotai/Kimi-K3";
const ALIAS_ID = "syn:large:text";
const INFINITE_ID = "infinite:small:vision";
const UNKNOWN_ID = "hf:acme/Unknown-1";

/** One answer of the service, with the fields this code reads. */
const ANSWER = {
  data: [
    {
      id: DEEPSEEK_ID,
      name: "deepseek-ai/DeepSeek-V4.1-Flash",
      display_name: "DeepSeek V4.1 Flash",
      provider: "synthetic",
      hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash",
      always_on: true,
      reasoning_parameters: { efforts: ["none", "low", "high", "xhigh", "max"] },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_length: 524_288,
      max_output_length: 65_536,
      pricing: {
        prompt: "$0.0000006",
        completion: "$0.0000012",
        image: "0",
        request: "0",
        input_cache_reads: "$0.00000003",
        input_cache_writes: "0",
      },
      supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
    },
    {
      id: KIMI_ID,
      name: "moonshotai/Kimi-K3",
      display_name: "Kimi K3",
      hugging_face_id: "moonshotai/Kimi-K3",
      reasoning_parameters: { efforts: ["low", "high", "xhigh"] },
      input_modalities: ["text"],
      context_length: 262_144,
      max_output_length: 32_768,
      pricing: { prompt: "$0.000003", completion: "$0.000015", input_cache_reads: "$0.00000046" },
      supported_features: ["tools", "reasoning"],
    },
    {
      // An alias of Kimi: no `hugging_face_id` of its own, so the rate table is
      // found through `alias_of`.
      id: ALIAS_ID,
      display_name: "Synthetic Large",
      alias_of: KIMI_ID,
      input_modalities: ["text"],
      context_length: 262_144,
      max_output_length: 32_768,
      pricing: { prompt: "$0.000003", completion: "$0.000015" },
      supported_features: ["tools"],
    },
    {
      // The free alias: `infinite:` is not billed against the weekly credit, so
      // the subscription table must not be used for it.
      id: INFINITE_ID,
      display_name: "Synthetic Infinite Small",
      alias_of: DEEPSEEK_ID,
      input_modalities: ["text", "image"],
      context_length: 524_288,
      max_output_length: 65_536,
      pricing: { prompt: "0", completion: "0", input_cache_reads: "0" },
      supported_features: ["tools"],
    },
    {
      // A model the subscription table does not name: the list's own price.
      id: UNKNOWN_ID,
      display_name: "Acme Unknown 1",
      hugging_face_id: "acme/Unknown-1",
      input_modalities: ["text"],
      context_length: 8_192,
      max_output_length: 4_096,
      pricing: { prompt: "$0.000001", completion: "$0.000002" },
      supported_features: [],
    },
  ],
};

const roots: string[] = [];

/**
 * Let a read that is running finish.
 *
 * The timers of the interval are faked in the one test that measures them, and
 * a read outlives the timer that started it until its file write returns: this
 * waits on the catalog's own state instead of on a timer.
 */
async function settle(catalog: SyntheticModelCatalog): Promise<void> {
  // A read outlives the timer that started it until its file write returns, and a
  // write takes as long as the machine gives it, so a fixed count of event loop
  // turns is enough on an idle host and too few on a busy one. Poll the catalog's own
  // state up to a deadline instead. Neither `setImmediate` nor `Date.now` is faked by
  // the one test that fakes the interval, so both work under it.
  const limit = Date.now() + 10_000;
  while (catalog.reading && Date.now() < limit) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(catalog.reading).toBe(false);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-catalog-"));
  roots.push(root);
  const dir = join(root, "state");
  await mkdir(dir, { recursive: true });
  return dir;
}

interface Host {
  readonly host: SyntheticCatalogHost;
  readonly registrations: ProviderModelConfig[][];
}

/** The runtime as the catalog sees it: registration and credential resolution. */
function host(options: { readonly key?: string | undefined } = {}): Host {
  const registrations: ProviderModelConfig[][] = [];
  const host: SyntheticCatalogHost = {
    registerProvider(_providerId: string, config: ProviderConfig) {
      registrations.push((config.models ?? []) as ProviderModelConfig[]);
    },
    async getAuth() {
      const key = "key" in options ? options.key : "test-key";
      return key === undefined ? undefined : { auth: { apiKey: key } };
    },
  };
  return { host, registrations };
}

/** A fetch that answers with the entry list it was given, and records each call. */
function answerFetch(answer: unknown = ANSWER): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof fetch, calls };
}

const entriesOf = (answer: unknown = ANSWER): SyntheticModelEntry[] => parseSyntheticCatalogResponse(answer);

describe("one entry of the list as a model", () => {
  it("keeps the built-in DeepSeek request shape and the response's own values", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    const deepseek = models.find((entry) => entry.id === DEEPSEEK_ID);
    expect(deepseek).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 524_288,
      maxTokens: 65_536,
      cost: { input: 0.06, cacheRead: 0.003, output: 0.3, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        supportsStrictMode: true,
      },
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
    });
  });

  it("gives every other family the OpenAI-compatible defaults and the levels the service names", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    const kimi = models.find((entry) => entry.id === KIMI_ID);
    expect(kimi).toMatchObject({
      name: "Kimi K3",
      input: ["text"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: null },
    });
    // No `compat`: the library's own defaults decide the request shape.
    expect(kimi?.compat).toBeUndefined();

    // The alias stands for Kimi but has no `hugging_face_id`, so it is not
    // DeepSeek and carries no compat either.
    const alias = models.find((entry) => entry.id === ALIAS_ID);
    expect(alias?.compat).toBeUndefined();
    expect(alias?.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
  });

  it("marks a model without the reasoning feature as one that does not reason", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    const unknown = models.find((entry) => entry.id === UNKNOWN_ID);
    expect(unknown?.reasoning).toBe(false);
    expect(unknown?.input).toEqual(["text"]);
  });

  it("registers every model of the answer, aliases included", () => {
    expect(syntheticModelsFromCatalog(entriesOf()).map((entry) => entry.id)).toEqual([
      DEEPSEEK_ID,
      KIMI_ID,
      ALIAS_ID,
      INFINITE_ID,
      UNKNOWN_ID,
    ]);
  });
});

describe("the cost of one model", () => {
  it("takes the subscription rate the table holds for the model", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    expect(models.find((entry) => entry.id === KIMI_ID)?.cost).toEqual({
      input: 1.5,
      cacheRead: 0.23,
      output: 7.5,
      cacheWrite: 0,
    });
  });

  it("follows alias_of once when the alias carries no hugging_face_id", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    expect(models.find((entry) => entry.id === ALIAS_ID)?.cost).toEqual({
      input: 1.5,
      cacheRead: 0.23,
      output: 7.5,
      cacheWrite: 0,
    });
  });

  it("keeps the list's own price for an infinite: alias", () => {
    const models = syntheticModelsFromCatalog(entriesOf());
    expect(models.find((entry) => entry.id === INFINITE_ID)?.cost).toEqual({
      input: 0,
      cacheRead: 0,
      output: 0,
      cacheWrite: 0,
    });
  });

  it("turns the list's per-token price into a per-million one, and says so once for that model", () => {
    const lines: string[] = [];
    const models = syntheticModelsFromCatalog(entriesOf(), {
      log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`),
    });
    expect(models.find((entry) => entry.id === UNKNOWN_ID)?.cost).toEqual({
      input: 1,
      cacheRead: 0,
      output: 2,
      cacheWrite: 0,
    });
    const aboutUnknown = lines.filter((line) => line.includes(UNKNOWN_ID));
    expect(aboutUnknown).toHaveLength(1);
    expect(aboutUnknown[0]).toContain("info");
    // No other model needed the fallback price.
    expect(lines).toHaveLength(1);
  });
});

describe("the answer's shape", () => {
  it("is refused when it is not a list of readable models", () => {
    expect(() => parseSyntheticCatalogResponse({})).toThrow(/no data list/);
    expect(() => parseSyntheticCatalogResponse({ data: [] })).toThrow(/lists no model/);
    expect(() => parseSyntheticCatalogResponse({ data: [{ id: "a" }] })).toThrow(/context_length/);
    expect(() =>
      parseSyntheticCatalogResponse({
        data: [
          { ...ANSWER.data[0] },
          { ...ANSWER.data[0] },
        ],
      }),
    ).toThrow(/twice/);
  });
});

describe("the stored list", () => {
  it("is written by a read and registered again at the next start", async () => {
    const dir = await stateDir();
    const first = host();
    const answer = answerFetch();
    const catalog = createSyntheticCatalog({ models: first.host, stateDir: dir, fetch: answer.fetch });
    catalog.registerStoredOrFallback();
    // Nothing stored yet: the one model the code carries.
    expect(first.registrations.at(-1)?.map((entry) => entry.id)).toEqual([SYNTHETIC_MODEL_ID]);
    expect(first.registrations).toHaveLength(1);

    await expect(catalog.refresh()).resolves.toBe(true);
    expect(answer.calls).toEqual([SYNTHETIC_MODELS_URL]);
    expect(first.registrations.at(-1)?.map((entry) => entry.id)).toEqual([
      DEEPSEEK_ID,
      KIMI_ID,
      ALIAS_ID,
      INFINITE_ID,
      UNKNOWN_ID,
    ]);

    const stored = JSON.parse(await readFile(syntheticCatalogFile(dir), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.fetchedAt).toEqual(expect.any(String));
    expect(stored.data).toHaveLength(5);

    // A second start reads the file, not the service.
    const second = host();
    const offline = createSyntheticCatalog({ models: second.host, stateDir: dir });
    offline.registerStoredOrFallback();
    expect(second.registrations.at(-1)?.map((entry) => entry.id)).toEqual([
      DEEPSEEK_ID,
      KIMI_ID,
      ALIAS_ID,
      INFINITE_ID,
      UNKNOWN_ID,
    ]);
    expect(readSyntheticCatalogFile(syntheticCatalogFile(dir))?.map((entry) => entry.id)).toContain(DEEPSEEK_ID);
  });

  it("stays in use when a read fails", async () => {
    const dir = await stateDir();
    const lines: string[] = [];
    const log = (level: string, message: string) => lines.push(`${level} ${message}`);
    const target = host();
    await writeSyntheticCatalogFile(syntheticCatalogFile(dir), entriesOf());
    const catalog = createSyntheticCatalog({ models: target.host, stateDir: dir, log, fetch: answerFetch().fetch });
    catalog.registerStoredOrFallback();
    const before = target.registrations.length;
    const storedBefore = await readFile(syntheticCatalogFile(dir), "utf8");

    // The network is gone, then the service answers with an error.
    const broken: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.synthetic.new");
    };
    const failing = createSyntheticCatalog({ models: target.host, stateDir: dir, log, fetch: broken });
    await expect(failing.refresh()).resolves.toBe(false);
    await expect(
      createSyntheticCatalog({
        models: target.host,
        stateDir: dir,
        log,
        fetch: (async () => new Response("nope", { status: 503 })) as typeof fetch,
      }).refresh(),
    ).resolves.toBe(false);

    expect(target.registrations.length).toBe(before);
    expect(await readFile(syntheticCatalogFile(dir), "utf8")).toBe(storedBefore);
    expect(lines.filter((line) => line.startsWith("warn"))).toHaveLength(2);
    // The warning names the reason, never a credential.
    expect(lines.join("\n")).not.toContain("test-key");
  });

  it("is read again six hours after the last read, and not after stop", async () => {
    const dir = await stateDir();
    const target = host();
    const answer = answerFetch();
    const catalog = createSyntheticCatalog({ models: target.host, stateDir: dir, fetch: answer.fetch });
    expect(SYNTHETIC_CATALOG_REFRESH_MS).toBe(6 * 60 * 60 * 1000);

    // Only the scheduling is faked: the read touches the disk, and a fake
    // `setImmediate` would leave the wait below with nothing to wait on.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      catalog.registerStoredOrFallback();
      catalog.start();
      await settle(catalog);
      expect(answer.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(SYNTHETIC_CATALOG_REFRESH_MS - 1);
      await settle(catalog);
      expect(answer.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle(catalog);
      expect(answer.calls).toHaveLength(2);

      catalog.stop();
      await vi.advanceTimersByTimeAsync(SYNTHETIC_CATALOG_REFRESH_MS * 2);
      await settle(catalog);
      expect(answer.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a model the service no longer lists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-catalog-"));
    roots.push(root);
    const paths = buildPaths(join(root, ".pi", "sec"));
    await ensureLayout(paths);

    const answer = answerFetch();
    const models = await createModels({
      authPath: paths.authFile,
      modelsPath: paths.modelsFile,
      syntheticCatalog: { stateDir: paths.stateDir, fetch: answer.fetch },
    });
    // A key would be needed for a read; the fake host's own resolution is not
    // part of this runtime, so the read is driven through the catalog's own API.
    const catalog = new SyntheticModelCatalog({
      models: {
        registerProvider: (providerId, config) => models.registerProvider(providerId, config),
        getAuth: async () => ({ auth: { apiKey: "test-key" } }),
      },
      stateDir: paths.stateDir,
      fetch: answer.fetch,
    });
    catalog.registerStoredOrFallback();

    await catalog.refresh();
    expect(models.getModels(SYNTHETIC_PROVIDER_ID).map((entry) => entry.id)).toEqual([
      DEEPSEEK_ID,
      KIMI_ID,
      ALIAS_ID,
      INFINITE_ID,
      UNKNOWN_ID,
    ]);

    // One model left in the answer: the other four leave the catalog with it.
    const shrunk = answerFetch({ data: [ANSWER.data[1]] });
    const again = new SyntheticModelCatalog({
      models: {
        registerProvider: (providerId, config) => models.registerProvider(providerId, config),
        getAuth: async () => ({ auth: { apiKey: "test-key" } }),
      },
      stateDir: paths.stateDir,
      fetch: shrunk.fetch,
    });
    await again.refresh();
    expect(models.getModels(SYNTHETIC_PROVIDER_ID).map((entry) => entry.id)).toEqual([KIMI_ID]);
    expect(models.getModel(SYNTHETIC_PROVIDER_ID, DEEPSEEK_ID)).toBeUndefined();
    expect(syntheticModelIds(await readFile(syntheticCatalogFile(paths.stateDir), "utf8"))).toEqual([KIMI_ID]);
  });
});

function syntheticModelIds(text: string): string[] {
  const stored = JSON.parse(text) as { data: { id: string }[] };
  return stored.data.map((entry) => entry.id);
}

describe("the one-shot commands", () => {
  let paths: Paths;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-catalog-cli-"));
    roots.push(root);
    paths = buildPaths(join(root, ".pi", "sec"));
    await ensureLayout(paths);
  });

  it("show synthetic from the stored list and read no network", async () => {
    await writeSyntheticCatalogFile(syntheticCatalogFile(paths.stateDir), entriesOf());
    const { config } = await loadConfig({ home: paths.home, overrides: { secrets: { dir: paths.secretsDir } } });

    const network = vi.fn(async () => {
      throw new Error("the one-shot commands must not call the network");
    });
    vi.stubGlobal("fetch", network);

    const { runtime } = await openCatalog(paths, config);
    expect(network).not.toHaveBeenCalled();
    expect(runtime.getProviders().map((provider) => provider.id)).toContain(SYNTHETIC_PROVIDER_ID);
    expect(runtime.getModels(SYNTHETIC_PROVIDER_ID).map((model) => model.id)).toEqual([
      DEEPSEEK_ID,
      KIMI_ID,
      ALIAS_ID,
      INFINITE_ID,
      UNKNOWN_ID,
    ]);
  });
});
