/**
 * Model providers a runtime extension exports.
 *
 * A runtime extension is an ordinary ES module under `~/.pi/sec/extensions/`.
 * Alongside `create`/`configSchema`/`toolTags` it may export `providers`, and
 * this module owns what happens to that export:
 *
 * - which extension registered which provider id, so a reload can take back
 *   exactly the ids that extension held,
 * - the rule that the first extension to claim an id keeps it,
 * - the preload `pi-sec start` and `pi-sec models` run, so a provider exists
 *   before anything reads the model catalog.
 *
 * The registry never touches credentials. It only calls the model runtime's
 * three registration methods, so an extension provider reaches the same login,
 * catalog and streaming code a built-in provider does.
 *
 * Two entry forms, told apart by shape:
 *
 * - `{ id, config }`, where `config` is the `ProviderConfig` that pi's
 *   `registerProvider(name, config)` takes, registered with
 *   `registerProvider(id, config)`.
 * - a complete pi-ai `Provider` object, registered with
 *   `registerNativeProvider(provider)`. A `Provider` is the object that owns
 *   `getModels()` and `auth`, and it is what tells the two forms apart: an entry
 *   with a `getModels` function is a provider, an entry with a `config` object
 *   is a config. An entry that has both, or neither, is refused.
 *
 * Either form may carry `virtual: true` at the top of the entry, next to `id`.
 * The extension says with it that the provider is not a service of its own and
 * that pi-sec's summary of one provider's spending must carry no card for it.
 * The marker sits beside `config` rather than inside it, because `config` is the
 * `ProviderConfig` that reaches pi's model runtime unchanged and pi has no field
 * for it. The registry records the marker and `isVirtual` answers it.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config/schema.ts";
import { defaultAppModulesDir, ensureDependencyLink } from "./loader.ts";
import {
  findEntry,
  importModule,
  readExtensionConfig,
  resolveExtensionConfigValue,
  type ModuleShape,
} from "./extension-module.ts";

/** The logging surface a preload needs. `info` is optional in the same way the loader's logger is. */
export interface ProvidersLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

/** What provider registration needs from the model runtime. `ModelRuntime` satisfies this. */
export interface ProviderHost {
  registerProvider(providerId: string, config: ProviderConfig): void;
  registerNativeProvider(provider: Provider): void;
  unregisterProvider(providerId: string): void;
  getProviders(): readonly Provider[];
}

/**
 * One entry of an extension's `providers` export.
 *
 * `virtual` is pi-sec's own marker and not part of either pi type. An extension
 * that does not state it states nothing rather than saying `false`: a provider
 * with no marker is a service of its own.
 */
export type ProviderEntry =
  | { readonly id: string; readonly config: ProviderConfig; readonly virtual?: boolean }
  | (Provider & { readonly virtual?: boolean });

type NormalizedEntry =
  | { readonly id: string; readonly kind: "config"; readonly config: ProviderConfig; readonly virtual: boolean }
  | { readonly id: string; readonly kind: "native"; readonly provider: Provider; readonly virtual: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an entry is a complete pi-ai `Provider` rather than a config pair.
 *
 * The marker is structural, because an extension module is plain JavaScript:
 * `getModels` is a function only a composed provider has, and `auth` is the
 * object the runtime reads its credentials from.
 */
export function isNativeProvider(value: unknown): value is Provider {
  return isRecord(value) && typeof value.getModels === "function" && isRecord(value.auth) && typeof value.id === "string";
}

function normalizeEntry(value: unknown): NormalizedEntry | { readonly error: string } {
  if (isNativeProvider(value)) {
    const id = String(value.id).trim();
    if (id === "") return { error: "a provider entry has an empty id" };
    // `id` is what the registry and the catalog key on, so a provider whose id
    // carries spaces is refused rather than registered under a name nothing can
    // look up.
    if (id !== value.id) return { error: `provider id "${String(value.id)}" has surrounding spaces` };
    return { id, kind: "native", provider: value, virtual: (value as { virtual?: unknown }).virtual === true };
  }
  if (isRecord(value) && typeof value.id === "string" && isRecord(value.config)) {
    const id = value.id.trim();
    if (id === "") return { error: "a provider entry has an empty id" };
    if (id !== value.id) return { error: `provider id "${value.id}" has surrounding spaces` };
    return { id, kind: "config", config: value.config as ProviderConfig, virtual: value.virtual === true };
  }
  if (isRecord(value) && isNativeProvider(value.config)) {
    return { error: `provider entry ${String(value.id ?? "")} carries both a config pair and a provider object` };
  }
  return { error: "a provider entry is neither { id, config } nor a Provider object" };
}

/**
 * The array an extension's `providers` export stands for.
 *
 * The export may be the array itself or a function of the extension's validated
 * config value, which is how an extension adds a provider only when its config
 * asks for one. A function that returns anything but an array (a promise, say)
 * is an error, not an empty list: silence would hide the mistake.
 */
export function providerEntries(exported: unknown, config: unknown): { entries: unknown[] } | { error: string } {
  if (exported === undefined || exported === null) return { entries: [] };
  if (typeof exported === "function") {
    let value: unknown;
    try {
      value = (exported as (config: unknown) => unknown)(config);
    } catch (error) {
      return { error: `providers() threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (value === null || value === undefined) return { entries: [] };
    if (!Array.isArray(value)) return { error: "providers() must return an array" };
    return { entries: value };
  }
  if (!Array.isArray(exported)) return { error: "providers must be an array or a function returning one" };
  return { entries: exported };
}

/** One provider id an extension registered. */
export interface RegisteredProvider {
  readonly id: string;
  readonly extension: string;
}

/**
 * Provider registrations, keyed by the extension that made them.
 *
 * The loader calls `register` once per extension after that extension installs.
 * `register` is transactional: a registration that throws leaves the extension's
 * previous providers in place, which is the same promise the loader makes for
 * tools on a failed reload.
 */
export class ProviderRegistry {
  private readonly host: ProviderHost;
  private readonly logger: ProvidersLogger;
  /** Provider ids the catalog held before any extension registered, for the override log. */
  private readonly catalogIds: Set<string>;
  /** Provider id to the extension that currently owns it. */
  private readonly owners = new Map<string, string>();
  /** Provider ids whose entry declares `virtual: true`. */
  private readonly virtuals = new Set<string>();
  /** The entries each extension last registered, for the rollback above. */
  private readonly stored = new Map<string, NormalizedEntry[]>();

  constructor(options: { readonly host: ProviderHost; readonly logger: ProvidersLogger }) {
    this.host = options.host;
    this.logger = options.logger;
    this.catalogIds = new Set(options.host.getProviders().map((provider) => provider.id));
  }

  /** Every provider an extension registered, in registration order. */
  list(): RegisteredProvider[] {
    return [...this.owners].map(([id, extension]) => ({ id, extension }));
  }

  /** The extension that registered this provider, or `undefined` for a catalog provider. */
  ownerOf(providerId: string): string | undefined {
    return this.owners.get(providerId);
  }

  /**
   * Whether this provider's entry declares `virtual: true`.
   *
   * An extension provides it and pi-sec routes each request to another provider,
   * so its own spending is recorded under the provider that answered. A caller
   * that lists providers to a reader keeps no entry for it. A registration the
   * extension took back is not virtual any more, and neither is a provider in the
   * catalog that nothing marked.
   */
  isVirtual(providerId: string): boolean {
    return this.virtuals.has(providerId);
  }

  /** Extensions that hold at least one provider. */
  names(): string[] {
    return [...new Set(this.owners.values())];
  }

  /**
   * Register one extension's providers, replacing what it registered last time.
   *
   * Errors do not stop the rest of the extension: a duplicate id is skipped and
   * reported, and the other entries are registered.
   */
  register(extensionName: string, exported: unknown, config: unknown): { registered: string[]; errors: string[] } {
    const errors: string[] = [];
    const resolved = providerEntries(exported, config);
    if ("error" in resolved) {
      this.logger.warn("extension providers were not read", { name: extensionName, error: resolved.error });
      return { registered: [], errors: [`${extensionName}: ${resolved.error}`] };
    }

    const accepted: NormalizedEntry[] = [];
    const seen = new Set<string>();
    for (const value of resolved.entries) {
      const normalized = normalizeEntry(value);
      if ("error" in normalized) {
        errors.push(`${extensionName}: ${normalized.error}`);
        this.logger.warn("extension provider skipped", { name: extensionName, error: normalized.error });
        continue;
      }
      const owner = this.owners.get(normalized.id);
      if (owner !== undefined && owner !== extensionName) {
        const message = `provider "${normalized.id}" is already registered by extension "${owner}"`;
        errors.push(`${extensionName}: ${message}`);
        this.logger.warn("extension provider skipped", { name: extensionName, provider: normalized.id, reason: message });
        continue;
      }
      if (seen.has(normalized.id)) {
        errors.push(`${extensionName}: provider "${normalized.id}" appears twice in its own providers export`);
        continue;
      }
      seen.add(normalized.id);
      accepted.push(normalized);
    }

    const previous = this.stored.get(extensionName) ?? [];
    try {
      for (const entry of previous) {
        if (accepted.some((next) => next.id === entry.id)) continue;
        this.drop(entry.id);
      }
      for (const entry of accepted) {
        this.install(extensionName, entry);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.restore(extensionName, previous);
      this.logger.warn("extension providers were not registered", { name: extensionName, error: message });
      return { registered: [], errors: [...errors, `${extensionName}: ${message}`] };
    }

    this.stored.set(extensionName, accepted);
    const registered = accepted.map((entry) => entry.id);
    if (registered.length > 0) {
      this.logger.info?.("extension providers registered", { name: extensionName, providers: registered });
    }
    return { registered, errors };
  }

  /** Take back every provider one extension holds, e.g. after its directory is gone. */
  unregister(extensionName: string, reason: string): string[] {
    const previous = this.stored.get(extensionName);
    if (previous === undefined) return [];
    for (const entry of previous) this.drop(entry.id);
    this.stored.delete(extensionName);
    const removed = previous.map((entry) => entry.id);
    if (removed.length > 0) {
      this.logger.info?.("extension providers unregistered", { name: extensionName, providers: removed, reason });
    }
    return removed;
  }

  private install(extensionName: string, entry: NormalizedEntry): void {
    if (this.catalogIds.has(entry.id)) {
      this.logger.info?.("extension provider overrides a catalog provider", {
        name: extensionName,
        provider: entry.id,
      });
    }
    if (entry.kind === "native") this.host.registerNativeProvider(entry.provider);
    else this.host.registerProvider(entry.id, entry.config);
    this.owners.set(entry.id, extensionName);
    // Written on every install, so a reload that drops the marker stops being
    // virtual, and a reload that adds it starts being virtual.
    if (entry.virtual) this.virtuals.add(entry.id);
    else this.virtuals.delete(entry.id);
  }

  private drop(providerId: string): void {
    this.host.unregisterProvider(providerId);
    this.owners.delete(providerId);
    this.virtuals.delete(providerId);
  }

  /** Put one extension's last good registration back after a failed attempt. */
  private restore(extensionName: string, previous: readonly NormalizedEntry[]): void {
    for (const [id, owner] of [...this.owners]) {
      if (owner === extensionName) this.drop(id);
    }
    for (const entry of previous) {
      try {
        this.install(extensionName, entry);
      } catch (error) {
        // The catalog refused an entry it accepted before; there is nothing
        // better to do than say so, and the entry stays out.
        this.logger.warn("extension provider could not be restored", {
          name: extensionName,
          provider: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * The registry over `models`, or `undefined` when the object cannot register
 * providers (a test double, or a `Models` collection without the runtime).
 */
export function providerRegistryFor(models: Models, logger: ProvidersLogger): ProviderRegistry | undefined {
  const candidate = models as Partial<ProviderHost>;
  if (
    typeof candidate.registerProvider !== "function" ||
    typeof candidate.registerNativeProvider !== "function" ||
    typeof candidate.unregisterProvider !== "function" ||
    typeof candidate.getProviders !== "function"
  ) {
    return undefined;
  }
  return new ProviderRegistry({ host: candidate as ProviderHost, logger });
}

export interface PreloadProvidersOptions {
  readonly extensionsDir: string;
  readonly registry: ProviderRegistry;
  readonly logger: ProvidersLogger;
  /** Where extensions resolve bare specifiers from. Defaults to this install's `node_modules`. */
  readonly appModulesDir?: string;
}

/**
 * Register the providers runtime extensions export, without installing anything
 * else they define.
 *
 * `pi-sec start` runs this before it checks the root vmodel, and `pi-sec models`
 * runs it before it lists providers. It does what the loader does up to the
 * point of a registration: link `node_modules` into the extensions directory,
 * import each entry file, read `config.json` through the module's schema, and
 * read `providers`. Tools, sections, hooks and tasks are not installed, so
 * nothing an extension does on install runs here.
 *
 * A failure is one warning line and a skip. The daemon keeps its own behavior:
 * if the root vmodel names a model the failed extension would have provided, the
 * existing catalog check stops the boot with exit code 2, and the log holds the
 * extension's error.
 */
export async function preloadExtensionProviders(options: PreloadProvidersOptions): Promise<{ loaded: string[] }> {
  const linkProblem = await ensureDependencyLink(options.extensionsDir, options.appModulesDir ?? defaultAppModulesDir());
  if (linkProblem !== undefined) {
    options.logger.warn("runtime extensions cannot resolve shared packages", { error: linkProblem });
  }

  let entries: string[];
  try {
    entries = await readdir(options.extensionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: [] };
    throw error;
  }

  const loaded: string[] = [];
  for (const dirName of entries.sort()) {
    if (dirName.startsWith(".") || dirName === "node_modules") continue;
    const dir = join(options.extensionsDir, dirName);
    try {
      const entry = await findEntry(dir);
      // A config.json-only override of a bundled extension has no module of its
      // own, so it has no `providers` to read.
      if (entry === undefined) continue;
      const module: ModuleShape = await importModule(entry);
      if (module.providers === undefined) continue;
      const { configValue, configPresent } = await readExtensionConfig(dir);
      const config = resolveExtensionConfigValue(dirName, module, configValue, configPresent);
      // The registry already writes one line per skipped entry, so this loop
      // only tracks what loaded; reporting again would double every warning.
      const result = options.registry.register(dirName, module.providers, config);
      if (result.registered.length > 0) loaded.push(dirName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn("extension provider preload failed", { name: dirName, error: message });
    }
  }
  return { loaded };
}

/**
 * Warn about every configured vmodel whose model is not in the catalog.
 *
 * Run after each load and reload: a reload that drops a provider, or a directory
 * that disappears, leaves a vmodel naming a model nothing can serve. The next
 * request on that vmodel fails; the daemon itself keeps running, so this line is
 * the only notice the operator gets.
 */
export function warnMissingVmodels(options: {
  readonly config: Config;
  readonly models: Models;
  readonly logger: ProvidersLogger;
}): void {
  for (const [key, entry] of Object.entries(options.config.vmodels)) {
    if (options.models.getModel(entry.provider, entry.modelId) !== undefined) continue;
    options.logger.warn("vmodel names a model the catalog does not have", {
      vmodel: key,
      provider: entry.provider,
      model: entry.modelId,
    });
  }
}
