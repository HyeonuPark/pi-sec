import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Config, VmodelConfig } from "../config/schema.ts";
import { isSafeName, SAFE_NAME_RULE } from "../runtime/names.ts";
import type { Paths } from "../runtime/paths.ts";

/** A vmodel key, a role name, or a prompt file that cannot be used. */
export class VmodelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmodelError";
  }
}

/**
 * Shipped prompt text inside the running install.
 *
 * `scripts/copy-assets.mjs` copies the repository's `prompts/` into `dist/`, so
 * this resolves to `<install>/dist/prompts/` for a built daemon and to a path
 * that simply does not exist when the sources run directly under vitest. The
 * same shape as `defaultWebDir()`.
 */
export function defaultPromptDir(): string {
  return fileURLToPath(new URL("../prompts/", import.meta.url));
}

interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
}

/**
 * Prompt text, read through an mtime-keyed cache.
 *
 * A prompt file can name a large role, and a section renders on every request,
 * so re-reading every time would be waste. The key is the file's modification
 * time and size, the same signal `registry/loader.ts` uses for extensions: an
 * unchanged file yields the same string, and the section seal then sees no
 * change and writes no note.
 *
 * Roots are searched in order, so the control structure wins over what the
 * install shipped, and a fresh install works with no copying step.
 */
export class PromptFiles {
  readonly #roots: readonly string[];
  readonly #cache = new Map<string, CachedFile>();

  constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  /** Path of the first root that holds this file, or `undefined`. */
  async locate(area: string, name: string): Promise<string | undefined> {
    for (const root of this.#roots) {
      const path = join(root, area, `${name}.md`);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && info.isFile()) return path;
    }
    return undefined;
  }

  /**
   * The text of one prompt file. A missing file is an error, never an empty
   * value: a vmodel whose prompt silently vanished would run with a system
   * prompt nobody wrote.
   */
  async read(area: string, name: string): Promise<string> {
    if (!isSafeName(name)) {
      throw new VmodelError(`${area} name "${name}" is not usable: ${SAFE_NAME_RULE}`);
    }
    const path = await this.locate(area, name);
    if (path === undefined) {
      throw new VmodelError(`no ${area} file "${name}.md" in ${this.#roots.join(" or ")}`);
    }
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) throw new VmodelError(`${path} disappeared while it was being read`);
    const cached = this.#cache.get(path);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.text;
    const text = await readFile(path, "utf8");
    this.#cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text });
    return text;
  }

  /** Every file name available in one area, for the error that lists them. */
  async names(area: string): Promise<string[]> {
    const found = new Set<string>();
    for (const root of this.#roots) {
      const entries = await readdir(join(root, area), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        found.add(entry.name.slice(0, -3));
      }
    }
    return [...found].sort();
  }
}

export interface VmodelResolution {
  readonly key: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly thinkingLevel: ModelThinkingLevel;
  /** Contents of the vmodel's prompt file. Empty is a legitimate value. */
  readonly prompt: string;
}

export interface VmodelResolverOptions {
  readonly getConfig: () => Config;
  readonly paths: Paths;
}

/**
 * The stored entry for one vmodel key.
 *
 * Free of `Paths` on purpose: a caller that only needs the model reference
 * should not have to build a resolver, and building one would drag the prompt
 * directory into a module that never reads a file.
 */
export function vmodelEntry(config: Config, key: string): VmodelConfig {
  if (!isSafeName(key)) throw new VmodelError(`vmodel name "${key}" is not usable: ${SAFE_NAME_RULE}`);
  const table = config.vmodels;
  const entry = Object.hasOwn(table, key) ? table[key] : undefined;
  if (entry === undefined) {
    throw new VmodelError(`no vmodel named "${key}". Known: ${Object.keys(table).join(", ") || "(none)"}`);
  }
  return entry;
}

/**
 * Resolves the model aliases in `config.vmodels`.
 *
 * A vmodel is how every model choice in this system is named, for the root
 * agent and for each spawned subagent alike. It carries the provider, the model
 * id, the thinking level, and the extra system-prompt text that belongs to that
 * model, so "which model, thinking how, told what" is one lookup.
 */
export class VmodelResolver {
  readonly #getConfig: () => Config;
  readonly #prompts: PromptFiles;

  constructor(options: VmodelResolverOptions) {
    this.#getConfig = options.getConfig;
    this.#prompts = new PromptFiles([options.paths.promptsDir, defaultPromptDir()]);
  }

  /** Every configured vmodel key. */
  keys(): string[] {
    return Object.keys(this.#getConfig().vmodels);
  }

  /** The stored entry for one key, or an error that lists what does exist. */
  entry(key: string): VmodelConfig {
    return vmodelEntry(this.#getConfig(), key);
  }

  /** The model reference of one key, for `configure()` and for spawn. */
  model(key: string): { readonly provider: string; readonly modelId: string } {
    const entry = this.entry(key);
    return { provider: entry.provider, modelId: entry.modelId };
  }

  async resolve(key: string): Promise<VmodelResolution> {
    const entry = this.entry(key);
    return {
      key,
      model: { provider: entry.provider, modelId: entry.modelId },
      thinkingLevel: entry.thinkingLevel,
      prompt: await this.#prompts.read("vmodel", entry.prompt),
    };
  }

  /**
   * The concatenated text of a role list.
   *
   * Nothing is inherited: this is the whole of what a conversation's roles say,
   * and the caller that built the list (config for the root, the spawn call for
   * a subagent) decided all of it.
   */
  async rolesText(roles: readonly string[]): Promise<string> {
    const parts: string[] = [];
    for (const role of roles) parts.push(await this.#prompts.read("role", role));
    return parts.filter((part) => part.trim() !== "").join("\n\n");
  }

  /** Role names that exist, for the error that lists them. */
  async roleNames(): Promise<string[]> {
    return await this.#prompts.names("role");
  }
}
