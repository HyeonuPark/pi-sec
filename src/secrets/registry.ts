import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createRedactor,
  NULL_REDACTOR,
  type Redactor,
  type RedactorOptions,
  type SecretValue,
} from "./redact.ts";

export interface SecretRegistryOptions {
  readonly dir: string;
  readonly dummyFormat?: string;
  readonly encodings?: readonly ("raw" | "base64" | "url")[];
  readonly includeModelCredentials?: boolean;
  readonly modelCredentialPaths?: readonly string[];
  readonly onWarning?: (message: string) => void;
}

/**
 * Key names whose string values are credential material. Anything else in a
 * model credential file is metadata — an auth type, a scope, an expiry — and
 * registering a discriminator as a secret redacts an ordinary word everywhere
 * it appears. That is not a theoretical cost: it has already rewritten source
 * files, through a read-modify-write that redacted the literal it was editing.
 */
const MATERIAL_KEY =
  /^(api[_-]?key|key|api[_-]?token|auth[_-]?token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|id[_-]?token|idtoken|token|secret|client[_-]?secret|private[_-]?key|session[_-]?key|password|passwd|passphrase|authorization|bearer|credential|credentials|access|refresh)$/i;

/**
 * Below this length, a value under a credential-ish key is a flag or an enum
 * (`"apiKey"`, `"none"`, `"dev"`) rather than credential material. Redacting a
 * short generic string damages more than it hides, so it is not registered.
 */
export const MIN_CREDENTIAL_LENGTH = 8;

/** Whether a key of a model credential file names credential material. */
export function isCredentialMaterialKey(key: string): boolean {
  return MATERIAL_KEY.test(key);
}

/**
 * A field of `auth.json` that names a file in the secret store instead of
 * holding a value: `{ "file": "model-auth.deepseek.key" }`. The value is the
 * file's content, and the store registers it under the file's name.
 */
export interface CredentialFileReference {
  readonly file: string;
}

/** Whether `node` is a file reference: an object whose only key is a string `file`. */
export function isCredentialFileReference(node: unknown): node is CredentialFileReference {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === "file" && typeof (node as { file: unknown }).file === "string";
}

/** Remove one trailing newline, the way a secret file is read. */
export function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

/** Parse an optional `env` file of `KEY=value` lines. Malformed lines are warned and skipped. */
export function parseEnvFile(text: string, onWarning?: (message: string) => void): SecretValue[] {
  const out: SecretValue[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      onWarning?.(`secrets env: ignoring malformed line: ${rawLine}`);
      continue;
    }
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (name.length === 0 || value.length === 0) {
      onWarning?.(`secrets env: ignoring empty entry ${name || "<unnamed>"}`);
      continue;
    }
    out.push({ name, value });
  }
  return out;
}

/** Collect the credential material of `auth.json`, named `model-auth.<path>`. */
function credentialValuesFromAuth(value: unknown): SecretValue[] {
  return credentialValues(value, "model-auth");
}

/** Collect string leaves under sensitive keys of `models.json`. */
function credentialValuesFromModels(value: unknown): SecretValue[] {
  return credentialValues(value, "model-models");
}

/**
 * Walk a credential file, naming string leaves `prefix.path`. A leaf is
 * registered when its key says it is credential material, and only when it is
 * long enough for that to be plausible; everything else is metadata.
 *
 * The names use dots, the same shape as the secret file that holds the value
 * once it moved out of `auth.json` (`model-auth.deepseek.key`), so a value has
 * one name before and after the move. A file reference is skipped: its string
 * is a file name, not a value, and the value is registered from that file.
 */
function credentialValues(value: unknown, prefix: string): SecretValue[] {
  const out: SecretValue[] = [];
  const walk = (node: unknown, path: string[], material: boolean): void => {
    if (typeof node === "string") {
      if (material && node.length >= MIN_CREDENTIAL_LENGTH) {
        out.push({ name: `${prefix}.${path.join(".")}`, value: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, [...path, String(index)], material));
      return;
    }
    if (isCredentialFileReference(node)) return;
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, [...path, key], material || MATERIAL_KEY.test(key));
      }
    }
  };
  walk(value, [], false);
  return out;
}

/**
 * The in-process secret registry used to build redactors. The store is the
 * source of truth; values are never written to conversation state or logs.
 *
 * Fail closed: a store that exists but cannot be read or parsed throws, so the
 * daemon never runs with a partial or empty registry while secret files exist.
 */
export class SecretRegistry {
  private readonly options: SecretRegistryOptions;
  private entries: SecretValue[] = [];
  private current: Redactor = NULL_REDACTOR;
  private readonly warnings: string[] = [];

  constructor(options: SecretRegistryOptions) {
    this.options = options;
  }

  private get redactorOptions(): RedactorOptions {
    return {
      dummyFormat: this.options.dummyFormat,
      encodings: this.options.encodings,
    };
  }

  /** Load the store; throws (fail closed) when it exists but is unreadable. */
  async load(): Promise<void> {
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
      this.options.onWarning?.(message);
    };

    const entries = await this.readStore(warn);
    this.warnings.length = 0;
    this.warnings.push(...warnings);
    this.entries = entries;
    this.current = createRedactor(this.entries, this.redactorOptions);
  }

  private async readStore(warn: (message: string) => void): Promise<SecretValue[]> {
    const entries: SecretValue[] = [];
    const dirInfo = await stat(this.options.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new Error(`secret store unreadable at ${this.options.dir}: ${String(error)}`);
    });
    if (dirInfo !== undefined) {
      if (!dirInfo.isDirectory()) {
        throw new Error(`secret store path is not a directory: ${this.options.dir}`);
      }
      let names: string[];
      try {
        names = await readdir(this.options.dir);
      } catch (error) {
        throw new Error(`secret store unreadable at ${this.options.dir}: ${String(error)}`);
      }
      names.sort();
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const filePath = join(this.options.dir, name);
        const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
          throw new Error(`secret file unreadable: ${filePath}: ${String(error)}`);
        });
        if (!info.isFile()) continue;
        if ((info.mode & 0o077) !== 0) {
          warn(`secret file ${filePath} is group/world-accessible (mode ${(info.mode & 0o777).toString(8)})`);
        }
        let text: string;
        try {
          text = await readFile(filePath, "utf8");
        } catch (error) {
          throw new Error(`secret file unreadable: ${filePath}: ${String(error)}`);
        }
        if (name === "env") {
          entries.push(...parseEnvFile(text, warn));
        } else {
          const value = stripTrailingNewline(text);
          if (value.length > 0) entries.push({ name, value });
        }
      }
    }

    if (this.options.includeModelCredentials) {
      for (const path of this.options.modelCredentialPaths ?? []) {
        const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw new Error(`model credentials unreadable at ${path}: ${String(error)}`);
        });
        if (info === undefined) continue;
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch (error) {
          throw new Error(`model credentials unreadable at ${path}: ${String(error)}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          // The parser's own sentence is not used: V8 quotes a piece of the text
          // it failed on, and that text holds credential material. The startup
          // error of the daemon goes to stderr, so only the meaning is reported.
          throw new Error(`model credentials unreadable at ${path}: is not valid JSON`);
        }
        if (path.endsWith("auth.json")) entries.push(...credentialValuesFromAuth(parsed));
        else if (path.endsWith("models.json")) entries.push(...credentialValuesFromModels(parsed));
        else {
          entries.push(...credentialValuesFromAuth(parsed));
          entries.push(...credentialValuesFromModels(parsed));
        }
      }
    }

    return entries;
  }

  /** Reload from disk (e.g. after an OAuth refresh rewrote `auth.json`). */
  async reload(): Promise<void> {
    await this.load();
  }

  /** Merge extra values discovered at runtime. */
  addValues(entries: readonly SecretValue[]): void {
    if (entries.length === 0) return;
    const byName = new Map<string, SecretValue>();
    for (const entry of this.entries) byName.set(`${entry.name}\u0000${entry.value}`, entry);
    for (const entry of entries) byName.set(`${entry.name}\u0000${entry.value}`, entry);
    this.entries = [...byName.values()];
    this.current = createRedactor(this.entries, this.redactorOptions);
  }

  /** A consistent redactor for one request. */
  redactor(): Redactor {
    return this.current;
  }

  /** Registered secret names (safe to show the model). */
  names(): string[] {
    return [...new Set(this.entries.map((entry) => entry.name))].sort();
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }

  diagnostics(): readonly string[] {
    return this.warnings;
  }
}
