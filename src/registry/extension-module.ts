/**
 * Reading one runtime extension's module and config.
 *
 * Two callers need the same steps: the loader (which installs the whole
 * extension) and the provider preload (which only reads the `providers` export,
 * before the agent runtime exists). The steps live here so the two cannot drift
 * on which file is imported or how `config.json` is checked.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: true });

/** What a runtime extension module may export. */
export interface ModuleShape {
  name?: string;
  create?: (config: unknown) => Extension<ToolRegistration>;
  configSchema?: TSchema;
  /** Extra, optional: what this extension declares about its own tools. */
  toolTags?: unknown;
  /**
   * Model providers this extension registers. An array, or a function that
   * receives the extension's validated config value and returns an array. Each
   * entry is `{ id, config }` or a complete `Provider`; see `providers.ts`.
   */
  providers?: unknown;
  /**
   * The cards this extension offers to the page. Read by the `UiRegistry`, which
   * owns the rules for slot names, card names and card scripts; see `ui.ts`.
   */
  ui?: unknown;
  default?: Extension<ToolRegistration>;
}

/** Resolve a candidate index file inside an extension directory. */
export async function findEntry(dir: string): Promise<string | undefined> {
  for (const candidate of ["index.js", "index.mjs", "index.cjs", "index.ts", "index.mts"]) {
    const path = join(dir, candidate);
    try {
      const info = await stat(path);
      if (info.isFile()) return path;
    } catch {
      /* absent */
    }
  }
  return undefined;
}

/**
 * Extension directories whose module graph is versioned by `?v=`.
 *
 * Filled by `importModule` before it imports anything, and read by the resolve
 * hook below. A directory that stays here after its extension is removed costs
 * nothing: nothing is imported from it again.
 */
const versionedRoots = new Set<string>();

/**
 * Hand the `?v=` of a module inside an extension directory to the modules it
 * imports from the same directory.
 *
 * Node resolves a relative specifier against the parent URL and drops the query,
 * so `./lib/value.js` imported from `index.js?v=1` is the same module URL for
 * every version. The hook is what makes a reload read the whole extension, not
 * only its entry file. It touches nothing else: a bare package resolves outside
 * the extension directory, and a `node:` built-in is not a file URL.
 */
const versionHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent === undefined || !parent.startsWith("file:") || !parent.includes("?v=")) {
      return nextResolve(specifier, context);
    }
    const queryAt = parent.indexOf("?v=");
    const parentPath = fileURLToPath(parent.slice(0, queryAt));
    const root = [...versionedRoots].find((candidate) => parentPath.startsWith(`${candidate}${sep}`));
    if (root === undefined) return nextResolve(specifier, context);
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith("file:") || resolved.url.includes("?")) return resolved;
    if (!fileURLToPath(resolved.url).startsWith(`${root}${sep}`)) return resolved;
    return { ...resolved, url: `${resolved.url}?v=${parent.slice(queryAt + 3)}` };
  },
});

/**
 * The version of one extension directory: the newest modification time in it and
 * a digest of its files.
 *
 * Both parts matter. The newest mtime moves on every write, so an edit that puts
 * older content back still loads. The digest catches a file that changed while
 * its mtime did not, which is what a copy that keeps times (`cp -p`, `rsync -a`,
 * `tar -x`) leaves behind.
 */
export async function extensionVersion(dir: string): Promise<string> {
  const files: string[] = [];
  await collectFiles(dir, "", files);
  files.sort();
  let newest = 0;
  const digest = createHash("sha256");
  for (const relative of files) {
    const full = join(dir, relative);
    const info = await stat(full);
    newest = Math.max(newest, info.mtimeMs);
    digest.update(relative).update("\0").update(await readFile(full));
  }
  return `${newest}-${digest.digest("hex").slice(0, 16)}`;
}

/** Relative paths of every file under one extension directory, minus `node_modules`. */
async function collectFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collectFiles(dir, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
}

/** Import one extension entry file, with a fresh module graph per version of its directory. */
export async function importModule(path: string): Promise<ModuleShape> {
  const dir = dirname(path);
  versionedRoots.add(dir);
  if (extname(path) === ".ts" || extname(path) === ".mts") {
    const imported = await jiti.import<ModuleShape>(path);
    // jiti's `interopDefault` returns a proxy that answers `default` with the
    // module itself when the file has no default export, and that falls back to
    // the default object for other names. The loader would then see a `default`
    // next to `create`, and a .ts file would be read differently from a .js file.
    // The proxy does not trap `Object.keys` or `Object.getOwnPropertyDescriptor`,
    // so this copy holds only what the file itself exports.
    const own: Record<string, unknown> = {};
    for (const key of Object.keys(imported)) {
      const descriptor = Object.getOwnPropertyDescriptor(imported, key);
      if (descriptor === undefined) continue;
      own[key] = descriptor.get !== undefined ? descriptor.get.call(imported) : descriptor.value;
    }
    return own as ModuleShape;
  }
  const url = `${pathToFileURL(path).href}?v=${await extensionVersion(dir)}`;
  return (await import(url)) as ModuleShape;
}

/** One extension's `config.json`, parsed. */
export interface ExtensionConfigFile {
  readonly configValue: unknown;
  readonly configPresent: boolean;
}

/** Read `<dir>/config.json`. A malformed file is an error, never an empty value. */
export async function readExtensionConfig(dir: string): Promise<ExtensionConfigFile> {
  const configPath = join(dir, "config.json");
  try {
    return { configValue: JSON.parse(await readFile(configPath, "utf8")) as unknown, configPresent: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configValue: undefined, configPresent: false };
    throw new Error(`cannot read config.json: ${String(error)}`);
  }
}

/**
 * The config value an extension's factory receives: its `config.json` with the
 * declared schema's defaults applied, checked against the schema.
 *
 * A file with no `configSchema` is refused when it exists, because nothing would
 * check it. An extension with neither returns whatever was in the file.
 */
export function resolveExtensionConfigValue(
  dirName: string,
  module: ModuleShape,
  configValue: unknown,
  configPresent: boolean,
): unknown {
  const configSchema = module.configSchema;
  if (configPresent && configSchema === undefined) {
    throw new Error(`extension ${dirName} has config.json but the module declares no configSchema`);
  }
  if (configSchema === undefined) return configValue;

  const base = configValue ?? {};
  const withDefaults = Value.Default(configSchema, base) as unknown;
  if (!Value.Check(configSchema, withDefaults)) {
    const issues = [...Value.Errors(configSchema, withDefaults)]
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid config for ${dirName}: ${issues}`);
  }
  return withDefaults;
}
