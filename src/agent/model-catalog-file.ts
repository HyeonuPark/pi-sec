/**
 * `<home>/model-catalog.json`: the providers and models this install knows,
 * written for the person who edits `vmodels` by hand.
 *
 * The daemon writes this file once per boot and nothing in pi-sec reads it
 * back. It is not a cache and not configuration: a missing or stale file changes
 * no behavior, and deleting it only means the next boot writes it again. The
 * source is the catalog the daemon already built, so writing it sends no request
 * to a provider and costs a millisecond or two.
 *
 * Two rules shape the content.
 *
 * - Only a provider whose credentials this install holds is listed, because that
 *   is exactly the set a `vmodels` entry can use. A credential value itself is
 *   never read: `getProviderAuthStatus` answers whether one exists.
 * - A provider whose list cannot be read still gets an entry, with `error` in
 *   place of `models`, so one broken provider does not hide the rest.
 *
 * The read of `<home>/models.json` lives here as well, because it decides the
 * `models.json` source label for this file and for `pi-sec models`; both read it
 * through this one function so the two cannot drift apart.
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../secrets/model-credentials.ts";
import { zoneIso } from "../time-format.ts";
import { SYNTHETIC_PROVIDER_ID } from "./synthetic-provider.ts";

/**
 * The first line of the file, in the language of the install.
 *
 * It names the two facts a reader needs: nothing reads the file back, and the
 * one command that lists every provider rather than only the configured ones.
 */
export const MODEL_CATALOG_NOTE =
  "참고용 파일입니다. pi-sec은 이 파일을 읽지 않습니다. 자격 증명이 없는 제공자까지 모두 보려면 pi-sec models 를 실행하십시오.";

/** One model of a provider, as the file lists it. */
export interface ModelCatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/** Where a provider and its list came from: `builtin`, `models.json`, `extension:<name>`, `service`. */
export type ModelCatalogSource = "builtin" | "models.json" | `extension:${string}` | "service";

/** One provider of the file. `models` and `error` never appear together. */
export interface ModelCatalogProvider {
  readonly id: string;
  readonly source: ModelCatalogSource;
  readonly configured: boolean;
  /** Present only for a provider that answers by routing to another one. */
  readonly virtual?: true;
  readonly models?: readonly ModelCatalogModel[];
  /** Why the list could not be read. */
  readonly error?: string;
}

/** The whole document, in the order the keys are written. */
export interface ModelCatalogDocument {
  readonly note: string;
  readonly generatedAt: string;
  readonly providers: readonly ModelCatalogProvider[];
}

/** The sliver of the model runtime this module reads. `ModelRuntime` satisfies it. */
export interface ModelCatalogSourceReader {
  getProviders(): readonly { readonly id: string }[];
  getModels(providerId: string): readonly ModelCatalogModel[];
  getProviderAuthStatus(providerId: string): { readonly configured: boolean };
}

/** The sliver of the provider registry this module reads. `ProviderRegistry` satisfies it. */
export interface ModelCatalogProviderOwners {
  ownerOf(providerId: string): string | undefined;
  isVirtual(providerId: string): boolean;
}

export interface CollectModelCatalogOptions {
  readonly models: ModelCatalogSourceReader;
  /** Which extension owns which provider, and which providers are virtual. */
  readonly providers?: ModelCatalogProviderOwners;
  /** The `providers` keys of `<home>/models.json`. */
  readonly modelsJsonProviders?: ReadonlySet<string>;
  /** The instant the file is stamped with. */
  readonly now: number;
  /** The zone `<home>/config.json` names, for the stamp's offset. */
  readonly timezone: string;
}

export interface WriteModelCatalogFileOptions extends Omit<CollectModelCatalogOptions, "now"> {
  /** `<home>/models.json`, read for the source label. */
  readonly modelsJsonFile: string;
  /** `<home>/model-catalog.json`, written atomically and 0600. */
  readonly file: string;
  /** The clock, for a test. Default `Date.now`. */
  readonly now?: number;
}

/**
 * The `providers` keys of `<home>/models.json`, or an empty set when the file is
 * absent or unreadable.
 *
 * A broken `models.json` is the model runtime's problem to report: here it only
 * means that no provider carries the `models.json` source label.
 */
export async function readModelsJsonProviderIds(path: string): Promise<Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return new Set();
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return new Set();
  return new Set(Object.keys(providers));
}

/** Id order by code unit, not by locale: the file is diffed and compared by machine. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The layer that defines a provider, most specific first. */
function sourceOf(providerId: string, options: CollectModelCatalogOptions): ModelCatalogSource {
  const owner = options.providers?.ownerOf(providerId);
  if (owner !== undefined) return `extension:${owner}`;
  if (options.modelsJsonProviders?.has(providerId) === true) return "models.json";
  // synthetic.new's list is the service's answer, stored on disk, rather than
  // the catalog the library ships. `pi-sec models` still calls it `builtin`,
  // because there it describes the registration rather than the origin.
  if (providerId === SYNTHETIC_PROVIDER_ID) return "service";
  return "builtin";
}

/**
 * One model entry.
 *
 * `name` is kept only when it says something the id does not, and a length is
 * kept only when it is a finite number: a hand-edited entry with
 * `"contextWindow": "big"` would otherwise reach the file as text.
 */
function modelEntry(model: ModelCatalogModel): ModelCatalogModel {
  const entry: { id: string; name?: string; contextWindow?: number; maxTokens?: number } = { id: model.id };
  if (typeof model.name === "string" && model.name !== "" && model.name !== model.id) entry.name = model.name;
  if (typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)) {
    entry.contextWindow = model.contextWindow;
  }
  if (typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)) entry.maxTokens = model.maxTokens;
  return entry;
}

/**
 * The document the file holds.
 *
 * Providers are visited in id order and only the configured ones are kept, so
 * the answer depends on the catalog alone and not on registration order.
 */
export function collectModelCatalog(options: CollectModelCatalogOptions): ModelCatalogDocument {
  const providers: ModelCatalogProvider[] = [];
  const ids = options.models
    .getProviders()
    .map((provider) => provider.id)
    .sort(compareIds);
  for (const id of ids) {
    const source = sourceOf(id, options);
    let configured: boolean;
    try {
      configured = options.models.getProviderAuthStatus(id).configured === true;
    } catch (error) {
      // Whether this provider could answer is unknown, so it is listed with the
      // reason rather than silently dropped.
      providers.push({ id, source, configured: false, error: describe(error) });
      continue;
    }
    if (!configured) continue;
    const entry: {
      id: string;
      source: ModelCatalogSource;
      configured: boolean;
      virtual?: true;
      models?: ModelCatalogModel[];
      error?: string;
    } = { id, source, configured };
    try {
      if (options.providers?.isVirtual(id) === true) entry.virtual = true;
      entry.models = options.models
        .getModels(id)
        .map(modelEntry)
        .sort((left, right) => compareIds(left.id, right.id));
    } catch (error) {
      entry.error = describe(error);
    }
    providers.push(entry);
  }
  return { note: MODEL_CATALOG_NOTE, generatedAt: zoneIso(options.now, options.timezone), providers };
}

/**
 * Collect the catalog and write it.
 *
 * `writeFileAtomic` puts the body in a 0600 file beside the target, syncs it, and
 * renames it into place, so a reader never sees half a file and the final mode is
 * 0600. A failure is thrown: the caller decides whether it matters, and for the
 * daemon's boot it does not.
 */
export async function writeModelCatalogFile(options: WriteModelCatalogFileOptions): Promise<void> {
  const modelsJsonProviders = await readModelsJsonProviderIds(options.modelsJsonFile);
  const document = collectModelCatalog({
    models: options.models,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    modelsJsonProviders,
    now: options.now ?? Date.now(),
    timezone: options.timezone,
  });
  await writeFileAtomic(options.file, `${JSON.stringify(document, null, 2)}\n`);
}
