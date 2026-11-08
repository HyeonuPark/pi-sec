/**
 * The model list synthetic.new serves, kept and kept up to date.
 *
 * synthetic.new answers `GET https://api.synthetic.new/openai/v1/models` with
 * one entry per model it serves. The entry carries what a model reference needs
 * except the request shape and the cost basis, which this code decides
 * (`synthetic-provider.ts`). This module reads that answer, turns it into model
 * entries, and keeps the last good answer in a file, so a start without a
 * network still knows the models the last successful read named.
 *
 * Three rules hold the reader together.
 *
 * - The file is the answer, not the model entries: the mapping below runs over
 *   the stored answer again at every start, so a change to the mapping reaches a
 *   home that has not read the service since.
 * - A read that fails changes nothing. The stored answer stays, the catalog
 *   keeps what it registered, and one warning line names the reason.
 * - The key never leaves the request. It is not written to the store file, and
 *   no log line, warning or error message carries it.
 *
 * Costs are synthetic.new's subscription rates, the rates at which a token
 * subtracts from the weekly credit. The service's list does not carry them: it
 * carries the usage-based price per token. The table below is the subscription
 * side, from `https://synthetic.new/pricing/models` checked on 2026-10-28, and a
 * model the table does not name falls back to the list's own price.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ModelCredentialLog } from "../secrets/model-credentials.ts";
import { writeFileAtomic } from "../secrets/model-credentials.ts";
import {
  SYNTHETIC_PROVIDER_ID,
  syntheticDeepseekCompat,
  syntheticDeepseekThinkingLevelMap,
  syntheticFallbackModel,
  syntheticProviderConfig,
} from "./synthetic-provider.ts";

/** The one address the list comes from. */
export const SYNTHETIC_MODELS_URL = "https://api.synthetic.new/openai/v1/models";

/** The name of the stored answer under the state directory. */
export const SYNTHETIC_CATALOG_FILE_NAME = "synthetic-models.json";

/** How often the daemon reads the list again. */
export const SYNTHETIC_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

/** How long one read of the list may take. */
export const SYNTHETIC_CATALOG_TIMEOUT_MS = 15_000;

/** The version of the stored answer. A file of another version is not used. */
const STORED_VERSION = 1;

/**
 * The thinking levels pi knows, taken from its own type.
 *
 * `satisfies` makes a level removed from pi-ai a type error here, and the
 * `Exclude` below makes a level added to pi-ai one too, so the map built for a
 * model never silently leaves a level out.
 */
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** Never satisfied for a level pi-ai has and the list above does not. */
type AssertComplete<T extends never> = T;
type _ThinkingLevelsAreComplete = AssertComplete<Exclude<ThinkingLevel, (typeof PI_THINKING_LEVELS)[number]>>;

/**
 * synthetic.new's subscription rates, per million tokens in dollars.
 *
 * Keyed by `hugging_face_id`, which is the same for a model and for the dated
 * release of it. `cacheWrite` is zero on every model: the service charges
 * nothing for writing the prompt cache.
 */
const SUBSCRIPTION_RATES: Readonly<Record<string, { input: number; cacheRead: number; output: number }>> = {
  "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.06, cacheRead: 0.003, output: 0.3 },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.06, cacheRead: 0.003, output: 0.3 },
  "moonshotai/Kimi-K3": { input: 1.5, cacheRead: 0.23, output: 7.5 },
  "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": { input: 0.1, cacheRead: 0.02, output: 0.4 },
  "openai/gpt-oss-120b": { input: 0.01, cacheRead: 0.003, output: 0.05 },
  "Qwen/Qwen3.8-27B": { input: 0.23, cacheRead: 0.05, output: 1.1 },
  "zai-org/GLM-4.7-Flash": { input: 0.01, cacheRead: 0.003, output: 0.05 },
  "zai-org/GLM-5.3": { input: 0.4, cacheRead: 0.07, output: 2.2 },
  "zai-org/GLM-5.3-Flash": { input: 0.1, cacheRead: 0.02, output: 0.25 },
};

/** One model of the list, as far as this code reads it. */
export interface SyntheticModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly hugging_face_id?: string;
  readonly alias_of?: string;
  readonly input_modalities?: readonly string[];
  readonly context_length: number;
  readonly max_output_length: number;
  readonly reasoning_parameters?: { readonly efforts?: readonly string[] };
  readonly supported_features?: readonly string[];
  readonly pricing?: Readonly<Record<string, string>>;
}

/** The host this module registers into and reads a credential from. */
export interface SyntheticCatalogHost {
  registerProvider(providerId: string, config: ProviderConfig): void;
  getAuth(providerId: string): Promise<{ readonly auth: { readonly apiKey?: string } } | undefined>;
}

/** What a catalog needs. */
export interface SyntheticCatalogOptions {
  readonly models: SyntheticCatalogHost;
  /** The state directory; the answer is stored as `synthetic-models.json` in it. */
  readonly stateDir: string;
  readonly log?: ModelCredentialLog;
  /** The fetch to read with. Default: the process's own. */
  readonly fetch?: typeof fetch;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/** The file that holds the last good answer, under the state directory. */
export function syntheticCatalogFile(stateDir: string): string {
  return join(stateDir, SYNTHETIC_CATALOG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry): entry is string => typeof entry === "string") ? [...value] : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * One entry of the list, or the reason this answer is not the shape it claims.
 *
 * The required fields are the ones a model entry cannot be built without: an
 * id, a context window and an output limit. Anything else is optional, and an
 * optional field of the wrong type is a broken shape too: the caller keeps the
 * stored answer rather than guess what the service meant.
 */
function entryOf(value: unknown, index: number): SyntheticModelEntry {
  if (!isRecord(value)) throw new Error(`entry ${index} is not an object`);
  const id = value["id"];
  if (typeof id !== "string" || id.trim() === "") throw new Error(`entry ${index} has no id`);
  const context = positiveNumber(value["context_length"]);
  if (context === undefined) throw new Error(`entry ${id} has no context_length`);
  const maxTokens = positiveNumber(value["max_output_length"]);
  if (maxTokens === undefined) throw new Error(`entry ${id} has no max_output_length`);

  const optionalText = (field: string): string | undefined => {
    const raw = value[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") throw new Error(`entry ${id} has a ${field} that is not a string`);
    return raw;
  };
  const optionalList = (field: string): string[] | undefined => {
    const raw = value[field];
    if (raw === undefined || raw === null) return undefined;
    const list = stringArray(raw);
    if (list === undefined) throw new Error(`entry ${id} has a ${field} that is not a list of strings`);
    return list;
  };

  let efforts: string[] | undefined;
  const reasoning = value["reasoning_parameters"];
  if (reasoning !== undefined && reasoning !== null) {
    if (!isRecord(reasoning)) throw new Error(`entry ${id} has reasoning_parameters that is not an object`);
    const rawEfforts = reasoning["efforts"];
    if (rawEfforts !== undefined && rawEfforts !== null) {
      const list = stringArray(rawEfforts);
      if (list === undefined) throw new Error(`entry ${id} has reasoning efforts that are not a list of strings`);
      efforts = list;
    }
  }

  let pricing: Record<string, string> | undefined;
  const rawPricing = value["pricing"];
  if (rawPricing !== undefined && rawPricing !== null) {
    if (!isRecord(rawPricing)) throw new Error(`entry ${id} has pricing that is not an object`);
    pricing = {};
    for (const [field, amount] of Object.entries(rawPricing)) {
      if (typeof amount !== "string") throw new Error(`entry ${id} has a price in ${field} that is not a string`);
      pricing[field] = amount;
    }
  }

  const name = optionalText("name");
  const displayName = optionalText("display_name");
  const huggingFaceId = optionalText("hugging_face_id");
  const aliasOf = optionalText("alias_of");
  const input = optionalList("input_modalities");
  const features = optionalList("supported_features");
  return {
    id,
    context_length: context,
    max_output_length: maxTokens,
    ...(name === undefined ? {} : { name }),
    ...(displayName === undefined ? {} : { display_name: displayName }),
    ...(huggingFaceId === undefined ? {} : { hugging_face_id: huggingFaceId }),
    ...(aliasOf === undefined ? {} : { alias_of: aliasOf }),
    ...(input === undefined ? {} : { input_modalities: input }),
    ...(features === undefined ? {} : { supported_features: features }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(efforts === undefined ? {} : { reasoning_parameters: { efforts } }),
  };
}

/**
 * The model entries of one answer from the service.
 *
 * Throws when the answer is not a list of readable entries. The caller keeps
 * what it has; a half-read list would register models of two different reads.
 */
export function parseSyntheticCatalogResponse(value: unknown): SyntheticModelEntry[] {
  if (!isRecord(value)) throw new Error("the answer is not an object");
  const data = value["data"];
  if (!Array.isArray(data)) throw new Error("the answer has no data list");
  if (data.length === 0) throw new Error("the answer lists no model");
  const entries = data.map((entry, index) => entryOf(entry, index));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`the answer lists ${entry.id} twice`);
    seen.add(entry.id);
  }
  return entries;
}

/** The input kinds of one model, as pi names them. Text is always among them. */
function inputOf(entry: SyntheticModelEntry): ("text" | "image")[] {
  const kinds: ("text" | "image")[] = [];
  for (const modality of entry.input_modalities ?? []) {
    if ((modality === "text" || modality === "image") && !kinds.includes(modality)) kinds.push(modality);
  }
  if (!kinds.includes("text")) kinds.unshift("text");
  return kinds;
}

function isDeepseek(entry: SyntheticModelEntry): boolean {
  return (entry.hugging_face_id ?? "").startsWith("deepseek-ai/");
}

/** `$0.0000006` per token is 0.6 per million tokens. */
function perMillionTokens(value: string | undefined): number {
  if (value === undefined) return 0;
  const amount = Number(value.trim().replace(/^\$/, ""));
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 1_000_000 * 1_000_000) / 1_000_000;
}

/**
 * The subscription rate of one entry, or undefined when the table does not have
 * it.
 *
 * The table is keyed by `hugging_face_id`. A `syn:` alias carries no
 * `hugging_face_id` of its own but names the model it stands for, so the lookup
 * follows `alias_of` once. An `infinite:` alias is not looked up at all: it is
 * not billed against the weekly credit, so the list's own price is the price.
 */
function subscriptionRateOf(
  entry: SyntheticModelEntry,
  byId: ReadonlyMap<string, SyntheticModelEntry>,
): { input: number; cacheRead: number; output: number } | undefined {
  if (entry.id.startsWith("infinite:")) return undefined;
  const own = entry.hugging_face_id === undefined ? undefined : SUBSCRIPTION_RATES[entry.hugging_face_id];
  if (own !== undefined) return own;
  if (entry.alias_of === undefined) return undefined;
  const target = byId.get(entry.alias_of);
  if (target?.hugging_face_id === undefined) return undefined;
  return SUBSCRIPTION_RATES[target.hugging_face_id];
}

/** The cost of one model, from the table, or from the list's own price. */
function costOf(
  entry: SyntheticModelEntry,
  byId: ReadonlyMap<string, SyntheticModelEntry>,
  log: ModelCredentialLog | undefined,
): ProviderModelConfig["cost"] {
  const rate = subscriptionRateOf(entry, byId);
  if (rate !== undefined) return { ...rate, cacheWrite: 0 };
  const pricing = entry.pricing ?? {};
  // The free alias is not a model without a rate: it is a model that does not
  // spend the credit, so its zero price is the right one and needs no line.
  if (!entry.id.startsWith("infinite:")) {
    log?.("info", "synthetic.new model has no subscription rate; the service's usage-based price is used", {
      model: entry.id,
    });
  }
  return {
    input: perMillionTokens(pricing["prompt"]),
    output: perMillionTokens(pricing["completion"]),
    cacheRead: perMillionTokens(pricing["input_cache_reads"]),
    cacheWrite: 0,
  };
}

/** The thinking levels of one model: a level the model does not name maps to nothing. */
function thinkingLevelMapOf(entry: SyntheticModelEntry): ThinkingLevelMap {
  const efforts = new Set(entry.reasoning_parameters?.efforts ?? []);
  const map: Record<string, string | null> = {};
  for (const level of PI_THINKING_LEVELS) map[level] = efforts.has(level) ? level : null;
  return map;
}

/**
 * The model entries one answer from the service registers.
 *
 * The request shape is the built-in DeepSeek provider's for the DeepSeek
 * models; every other model is registered with the OpenAI-compatible defaults
 * (`compat` absent), because no other model of this service has been checked.
 */
export function syntheticModelsFromCatalog(
  entries: readonly SyntheticModelEntry[],
  options: { readonly log?: ModelCredentialLog } = {},
): ProviderModelConfig[] {
  const byId = new Map(entries.map((entry): [string, SyntheticModelEntry] => [entry.id, entry]));
  return entries.map((entry) => {
    const reasoning = (entry.supported_features ?? []).includes("reasoning");
    const deepseek = isDeepseek(entry);
    const model: ProviderModelConfig = {
      id: entry.id,
      name: entry.display_name ?? entry.name ?? entry.id,
      api: "openai-completions",
      reasoning,
      input: inputOf(entry),
      cost: costOf(entry, byId, options.log),
      contextWindow: entry.context_length,
      maxTokens: entry.max_output_length,
      thinkingLevelMap: deepseek ? syntheticDeepseekThinkingLevelMap() : thinkingLevelMapOf(entry),
      ...(deepseek ? { compat: syntheticDeepseekCompat() } : {}),
    };
    return model;
  });
}

/**
 * The answer stored by the last successful read, or undefined.
 *
 * A file that cannot be read, does not parse, or carries another version is
 * reported in one line and treated as absent: the caller registers the fallback
 * model, which is what a home that never read the service registers.
 */
export function readSyntheticCatalogFile(
  file: string,
  log?: ModelCredentialLog,
): SyntheticModelEntry[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log?.("warn", "the stored synthetic.new model list cannot be read", { file, code });
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value["version"] !== STORED_VERSION) throw new Error("the stored answer has another version");
    return parseSyntheticCatalogResponse({ data: value["data"] });
  } catch (error) {
    log?.("warn", "the stored synthetic.new model list is not usable", {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Store one answer, so the next start does not need the service. */
export async function writeSyntheticCatalogFile(file: string, entries: readonly SyntheticModelEntry[]): Promise<void> {
  const body = JSON.stringify({ version: STORED_VERSION, fetchedAt: new Date().toISOString(), data: entries }, null, 2);
  await writeFileAtomic(file, `${body}\n`);
}

/**
 * The provider registration, the stored answer and the read that refreshes it.
 *
 * The daemon creates one of these per runtime, registers the stored answer
 * synchronously in the constructor's caller, and starts the read. The one-shot
 * commands create one and register the stored answer only: they read no
 * network.
 */
export class SyntheticModelCatalog {
  readonly #options: SyntheticCatalogOptions;
  readonly #file: string;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<boolean> | undefined;

  constructor(options: SyntheticCatalogOptions) {
    this.#options = options;
    this.#file = syntheticCatalogFile(options.stateDir);
    this.#intervalMs = options.intervalMs ?? SYNTHETIC_CATALOG_REFRESH_MS;
    this.#timeoutMs = options.timeoutMs ?? SYNTHETIC_CATALOG_TIMEOUT_MS;
  }

  /** The file the last good answer is stored in. */
  get file(): string {
    return this.#file;
  }

  /** Whether a read is running now. */
  get reading(): boolean {
    return this.#inFlight !== undefined;
  }

  /**
   * Register the stored answer, or the fallback model when nothing is stored.
   *
   * Synchronous on purpose: the daemon checks the root vmodel against the
   * catalog before it serves, and a check that ran before this registration
   * would refuse a home whose root model only the list names.
   */
  registerStoredOrFallback(): void {
    // No line per model here: the price fallback was reported when the answer
    // was read, and a start that reads it out again must not repeat it.
    const entries = readSyntheticCatalogFile(this.#file, this.#options.log);
    const models = entries === undefined ? [syntheticFallbackModel()] : syntheticModelsFromCatalog(entries);
    this.#register(models);
  }

  /** Read the list now and register it. A failure leaves the catalog as it is. */
  async refresh(): Promise<boolean> {
    const running = this.#inFlight;
    if (running !== undefined) return running;
    const task = this.#read();
    this.#inFlight = task;
    try {
      return await task;
    } finally {
      if (this.#inFlight === task) this.#inFlight = undefined;
    }
  }

  /**
   * Read the list once, without holding the caller, and read it again every
   * interval.
   *
   * The timer does not hold the process open: a daemon that ends its work must
   * be able to exit, and `stop` is what a shutdown calls anyway.
   */
  start(): void {
    void this.refresh();
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
  }

  /** End the interval. A read already running is left to finish. */
  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #register(models: ProviderModelConfig[]): void {
    this.#options.models.registerProvider(SYNTHETIC_PROVIDER_ID, syntheticProviderConfig(models));
  }

  async #read(): Promise<boolean> {
    // The key is the runtime's own resolution of this provider's credential,
    // whatever stored it. Without one there is nothing to read with, and the
    // list is read again when the panel stores a key.
    let key: string | undefined;
    try {
      const auth = await this.#options.models.getAuth(SYNTHETIC_PROVIDER_ID);
      key = auth?.auth.apiKey;
    } catch {
      key = undefined;
    }
    if (key === undefined || key === "") return false;

    const doFetch = this.#options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await doFetch(SYNTHETIC_MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`the service answered HTTP ${response.status}`);
      const entries = parseSyntheticCatalogResponse(await response.json());
      const models = syntheticModelsFromCatalog(entries, { log: this.#options.log });
      this.#register(models);
      this.#options.log?.("info", "synthetic.new model list read", { models: models.length });
      try {
        await writeSyntheticCatalogFile(this.#file, entries);
      } catch (error) {
        this.#options.log?.("warn", "the synthetic.new model list was not stored", {
          file: this.#file,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    } catch (error) {
      this.#options.log?.("warn", "synthetic.new model list not read; the stored list stays in use", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the catalog of one runtime. */
export function createSyntheticCatalog(options: SyntheticCatalogOptions): SyntheticModelCatalog {
  return new SyntheticModelCatalog(options);
}
