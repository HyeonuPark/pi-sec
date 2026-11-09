import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readlink, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import {
  findEntry,
  importModule,
  readExtensionConfig,
  resolveExtensionConfigValue,
  type ModuleShape,
} from "./extension-module.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { PageDiagnostic, PageRegistry } from "./pages.ts";
import type { UiDiagnostic, UiRegistry } from "./ui.ts";

/** Builds an extension from a validated config value. */
export type LoaderFactory = (config: unknown) => Extension<ToolRegistration>;

export interface RuntimeExtensionDiagnostic {
  readonly name: string;
  readonly source: "runtime" | "core-override";
  readonly path: string;
  readonly mtime: number;
  readonly configHash?: string;
  readonly error?: string;
  /**
   * The cards this extension holds right now, and the entries that were dropped.
   * Read from the `UiRegistry` when `list()` is called, so a reload or a failed
   * load shows what the page will actually get.
   */
  readonly ui?: UiDiagnostic;
  /** The pages this extension holds right now, and the entries that were dropped. */
  readonly pages?: PageDiagnostic;
}

export interface ExtensionLoaderOptions {
  readonly extensionsDir: string;
  readonly registry: Registry<ToolRegistration>;
  readonly logger: { warn(message: string, fields?: Record<string, unknown>): void; info?(message: string, fields?: Record<string, unknown>): void };
  /** Resolve a core extension factory by name, for `config.json`-only overrides. */
  readonly coreFactory?: (name: string) => LoaderFactory | undefined;
  /** Where runtime extensions resolve bare specifiers from. Defaults to this install's `node_modules`. */
  readonly appModulesDir?: string;
  /**
   * Applied to every extension before it is installed. The runtime wires the
   * section seal here: a runtime extension's sections are sealed like the bundled
   * ones, including a reload that would otherwise rewrite the head of a request.
   */
  readonly sealSections?: (extension: Extension<ToolRegistration>) => Extension<ToolRegistration>;
  /**
   * Called with an extension's `toolTags` export at install time. Returns the
   * names it could not read, for the warning below. A declaration is read here
   * and never cached into the extension: resolution happens at call time, from
   * the extension that currently provides the tool (see `tool-tags.ts`).
   */
  readonly onToolTags?: (name: string, tags: unknown) => string[];
  /**
   * Provider registrations, when the model runtime can hold them. The loader
   * registers an extension's `providers` export here after the extension
   * installs, and takes back the providers of an extension that fails or whose
   * directory is gone. Without it, `providers` is ignored.
   */
  readonly providers?: ProviderRegistry;
  /**
   * Card registrations, when the runtime can hold them. The loader registers an
   * extension's `ui` export here after the extension installs, and takes back the
   * cards of an extension that has no module or whose directory is gone. Without
   * it, `ui` is ignored.
   */
  readonly ui?: UiRegistry;
  /**
   * Page registrations, when the runtime can hold them. The loader registers an
   * extension's `pages` export here right after `ui`, on the same terms, and takes
   * back the pages of an extension that has no module or whose directory is gone.
   * Without it, `pages` is ignored.
   */
  readonly pages?: PageRegistry;
  /**
   * Called once every load pass has finished, whatever it did. The runtime wires
   * the vmodel catalog check here: after a reload, a vmodel may name a model
   * that the reload took away.
   */
  readonly afterLoad?: () => void;
}

/** This install's `node_modules`, the directory runtime extensions resolve shared packages from. */
export function defaultAppModulesDir(): string {
  return fileURLToPath(new URL("../../node_modules", import.meta.url));
}

/**
 * Make bare specifiers resolve for runtime extensions.
 *
 * A runtime extension lives in `<home>/extensions/<name>/`, which sits outside
 * every `node_modules` tree, so `import "@earendil-works/pi-durable"` cannot
 * resolve: Node walks *up* from the importing file and finds nothing. Link this
 * install's `node_modules` into the extensions directory, which is the ordinary
 * way to hand dependencies to a plugin directory.
 *
 * The scan skips a directory named `node_modules`, so the link is invisible to
 * `loadAll`. A real (non-symlink) `node_modules` is left strictly alone.
 *
 * Returns a diagnostic when the link could not be established.
 */
export async function ensureDependencyLink(extensionsDir: string, appModulesDir: string): Promise<string | undefined> {
  const link = join(extensionsDir, "node_modules");
  try {
    await mkdir(extensionsDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return `cannot create ${extensionsDir}: ${String(error)}`;
  }

  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) return undefined;
    if ((await readlink(link)) === appModulesDir) return undefined;
    // Stale link, e.g. left pointing at a tree the process no longer runs from.
    await unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `cannot inspect ${link}: ${String(error)}`;
    }
  }

  try {
    await symlink(appModulesDir, link, "dir");
    return undefined;
  } catch (error) {
    return `cannot link ${link} -> ${appModulesDir}: ${String(error)}`;
  }
}

function hashConfig(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

/** Validate and build an extension from a module, config, and optional core factory. */
export function normalizeExtension(
  dirName: string,
  module: ModuleShape,
  configValue: unknown,
  configPresent: boolean,
  coreFactory: LoaderFactory | undefined,
): Extension<ToolRegistration> {
  const factory = module.create ?? coreFactory;

  if (module.default !== undefined && factory !== undefined) {
    throw new Error(`extension ${dirName} may not both default-export and define create()`);
  }

  if (module.default !== undefined) {
    if (configPresent) throw new Error(`extension ${dirName} has config.json but no configSchema`);
    return module.default;
  }

  if (factory === undefined) {
    throw new Error(`extension ${dirName} exports neither a factory nor a default extension`);
  }

  return factory(resolveExtensionConfigValue(dirName, module, configValue, configPresent));
}

/** Load and hot-reload runtime extensions from `~/.pi/sec/extensions`. */
export class ExtensionLoader {
  private readonly options: ExtensionLoaderOptions;
  private diagnostics = new Map<string, RuntimeExtensionDiagnostic>();
  private watcher: ReturnType<typeof watch> | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();

  private readonly appModulesDir: string;

  constructor(options: ExtensionLoaderOptions) {
    this.options = options;
    this.appModulesDir = options.appModulesDir ?? defaultAppModulesDir();
  }

  list(): RuntimeExtensionDiagnostic[] {
    return [...this.diagnostics.values()].map((diagnostic) => {
      const ui = this.options.ui?.diagnostics(diagnostic.name);
      const pages = this.options.pages?.diagnostics(diagnostic.name);
      return {
        ...diagnostic,
        ...(ui === undefined ? {} : { ui }),
        ...(pages === undefined ? {} : { pages }),
      };
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Load every extension directory and install what validates. */
  async loadAll(): Promise<{ reloaded: string[]; errors: string[] }> {
    const reloaded: string[] = [];
    const errors: string[] = [];

    // Before anything is imported: hand the extensions directory the packages
    // an extension is allowed to import. Without this, every extension that
    // imports the SDK fails to load.
    const linkProblem = await ensureDependencyLink(this.options.extensionsDir, this.appModulesDir);
    if (linkProblem !== undefined) {
      this.options.logger.warn("runtime extensions cannot resolve shared packages", { error: linkProblem });
    }

    let entries: string[];
    try {
      entries = await readdir(this.options.extensionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }
    const present = new Set(entries.filter((name) => !name.startsWith(".") && name !== "node_modules"));
    for (const dirName of [...present].sort()) {
      const result = await this.loadOne(dirName);
      if (result.ok) {
        reloaded.push(dirName);
        // A provider or a card this extension could not register is a load
        // result, not a load failure: the rest of the extension is installed.
        for (const message of result.providerErrors) errors.push(message);
        for (const message of result.uiErrors) errors.push(`${dirName}: ${message}`);
        for (const message of result.pageErrors) errors.push(`${dirName}: ${message}`);
      } else {
        errors.push(`${dirName}: ${result.error}`);
      }
    }
    // A directory that is gone takes its providers with it. Tools and sections
    // stay installed: the installed set is not rebuilt from the directory scan,
    // so only the providers are taken back here.
    if (this.options.providers !== undefined) {
      for (const name of this.options.providers.names()) {
        if (present.has(name)) continue;
        this.options.providers.unregister(name, "its directory is gone");
      }
    }
    // The same for a directory that is gone: its cards leave the page and its
    // `publish` closes, so a page opened later cannot show a card whose files
    // the server no longer serves.
    if (this.options.ui !== undefined) {
      for (const name of this.options.ui.names()) {
        if (present.has(name)) continue;
        this.options.ui.unregister(name, "its directory is gone");
      }
    }
    // And its pages: the routes answer 404 and the menu link goes at once.
    if (this.options.pages !== undefined) {
      for (const name of this.options.pages.names()) {
        if (present.has(name)) continue;
        this.options.pages.unregister(name, "its directory is gone");
      }
    }
    this.runAfterLoad();
    return { reloaded, errors };
  }

  /** The post-load hook, which must never turn a finished load into a failure. */
  private runAfterLoad(): void {
    try {
      this.options.afterLoad?.();
    } catch (error) {
      this.options.logger.warn("extension post-load check failed", { error });
    }
  }

  /** Reload every configured extension, keeping the previous instance on failure. */
  async reload(): Promise<{ reloaded: string[]; errors: string[] }> {
    return this.loadAll();
  }

  private async loadOne(
    dirName: string,
  ): Promise<{ ok: true; providerErrors: string[]; uiErrors: string[]; pageErrors: string[] } | { ok: false; error: string }> {
    const dir = join(this.options.extensionsDir, dirName);
    try {
      const entry = await findEntry(dir);
      const configPath = join(dir, "config.json");
      const { configValue, configPresent } = await readExtensionConfig(dir);

      const coreFactory = this.options.coreFactory?.(dirName);
      if (entry === undefined) {
        if (!configPresent || coreFactory === undefined) {
          throw new Error("no index.js/index.ts found and no matching core extension");
        }
        const normalized = normalizeExtension(dirName, {}, configValue, true, coreFactory);
        const extension = this.options.sealSections?.(normalized) ?? normalized;
        this.options.registry.install(extension);
        // A core extension overridden by `config.json` alone has no module, so it
        // can export no cards: take back whatever the directory held before it
        // lost its entry file.
        this.options.ui?.unregister(dirName, "no module");
        this.options.pages?.unregister(dirName, "no module");
        this.diagnostics.set(dirName, {
          name: dirName,
          source: "core-override",
          path: configPath,
          mtime: (await stat(configPath)).mtimeMs,
          configHash: hashConfig(configValue),
        });
        this.notify();
        return { ok: true, providerErrors: [], uiErrors: [], pageErrors: [] };
      }

      const module = await importModule(entry);
      const normalized = normalizeExtension(dirName, module, configValue, configPresent, coreFactory);
      if (normalized.name !== dirName) {
        throw new Error(`extension name "${normalized.name}" does not match directory "${dirName}"`);
      }
      const extension = this.options.sealSections?.(normalized) ?? normalized;
      this.options.registry.install(extension);
      const rejected = this.options.onToolTags?.(dirName, module.toolTags) ?? [];
      if (rejected.length > 0) {
        this.options.logger.warn("extension toolTags entries were not readable", { name: dirName, entries: rejected });
      }
      // After the extension is installed: a provider registration is a step of a
      // load that has otherwise succeeded, so a failure here keeps the tools and
      // reports one error rather than undoing the extension.
      const providerResult = this.options.providers?.register(
        dirName,
        module.providers,
        resolveExtensionConfigValue(dirName, module, configValue, configPresent),
      );
      // Cards are registered on the same terms as providers: the extension is
      // installed either way, and an entry the registry dropped is reported.
      const uiResult = await this.options.ui?.register(dirName, module.ui, {
        dir,
        config: resolveExtensionConfigValue(dirName, module, configValue, configPresent),
      });
      const pagesResult = await this.options.pages?.register(dirName, module.pages, {
        dir,
        config: resolveExtensionConfigValue(dirName, module, configValue, configPresent),
      });
      this.diagnostics.set(dirName, {
        name: dirName,
        source: coreFactory !== undefined && module.create === undefined && module.default === undefined ? "core-override" : "runtime",
        path: entry,
        mtime: (await stat(entry)).mtimeMs,
        configHash: configPresent ? hashConfig(configValue) : undefined,
      });
      this.notify();
      return { ok: true, providerErrors: providerResult?.errors ?? [], uiErrors: uiResult?.errors ?? [],
        pageErrors: pagesResult?.errors ?? [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existing = this.diagnostics.get(dirName);
      this.diagnostics.set(dirName, {
        name: dirName,
        source: existing?.source ?? "runtime",
        path: existing?.path ?? dir,
        mtime: existing?.mtime ?? 0,
        error: message,
      });
      this.options.logger.warn("runtime extension failed to load", { name: dirName, error: message });
      return { ok: false, error: message };
    }
  }

  /** Watch the extensions directory and debounce a reload. */
  startWatching(): void {
    if (this.watcher !== undefined) return;
    try {
      this.watcher = watch(this.options.extensionsDir, { recursive: true }, () => {
        if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          void this.reload().catch((error) => this.options.logger.warn("extension reload failed", { error }));
        }, 250);
      });
    } catch (error) {
      this.options.logger.warn("extension watcher unavailable", { error });
    }
  }

  stopWatching(): void {
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
