/**
 * Model provider credentials kept as files in the secret store.
 *
 * `auth.json` holds the shape of each credential: its type, its expiry, and,
 * for every field that is credential material, a reference to a secret file:
 *
 *     { "deepseek": { "type": "api_key", "key": { "file": "model-auth.deepseek.key" } } }
 *
 * The value lives in `<secrets dir>/model-auth.deepseek.key`, mode 0600, next
 * to every other secret, and the registry registers it under that name. A field
 * that still holds its value inline (the format before the move) is read as it
 * is, so a request works before, during and after the move.
 *
 * Nothing here writes a value to a log line, an error message or a result.
 * Log lines carry provider ids, field names, file names and byte counts.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import {
  isCredentialFileReference,
  isCredentialMaterialKey,
  MIN_CREDENTIAL_LENGTH,
  stripTrailingNewline,
} from "./registry.ts";
import { isValidSecretName } from "./upload.ts";

/** One structured log line. Fields never carry a credential value. */
export type ModelCredentialLog = (
  level: "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

/** The secret file name of one credential field: `model-auth.<provider>.<field>`. */
export function modelSecretName(providerId: string, field: string): string {
  return `model-auth.${providerId}.${field}`;
}

/**
 * Write order inside one credential. A refresh token rotates: once the provider
 * answered a refresh, the old refresh token is dead. Writing the new one first
 * means a crash part-way through still leaves a refresh token that works.
 */
function writeRank(field: string): number {
  if (field === "refresh") return 0;
  if (field === "access") return 1;
  return 2;
}

type CredentialFile = Record<string, Record<string, unknown>>;

/** A field whose value moves to a secret file. */
interface MaterialField {
  readonly field: string;
  readonly value: string;
}

/** The top-level fields of one credential whose inline string is credential material. */
function materialFields(credential: Record<string, unknown>): MaterialField[] {
  const out: MaterialField[] = [];
  for (const [field, value] of Object.entries(credential)) {
    if (typeof value !== "string") continue;
    if (!isCredentialMaterialKey(field) || value.length < MIN_CREDENTIAL_LENGTH) continue;
    out.push({ field, value });
  }
  return out.sort((left, right) => writeRank(left.field) - writeRank(right.field));
}

/**
 * A digest of one credential's values, so a read can tell whether any of them
 * changed since the last one. The digest never leaves memory: no log line and
 * no error message carries it.
 */
function credentialFingerprint(credential: Record<string, unknown>): string {
  const order = Object.keys(credential).sort();
  const hash = createHash("sha256");
  for (const key of order) hash.update(`${key}\u0000${String(credential[key])}\u0000`);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `auth.json`. The parser's own message is not used: V8 quotes a piece of
 * the text it failed on, and that text is credential material.
 */
function parseCredentialFile(text: string | undefined): CredentialFile {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("model credentials: auth.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("model credentials: auth.json is not a JSON object");
  return parsed as CredentialFile;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`model credentials: cannot read ${basename(path)} (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

/**
 * Replace `path` with `content` atomically: a dot-named temporary file in the
 * same directory, created 0600, written, flushed to disk, then renamed over the
 * target. The target holds the old bytes or the new bytes, never a mix.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  // Make the rename itself durable. A directory that cannot be opened for sync
  // (some filesystems) still has the rename; only its durability is weaker.
  try {
    const dirHandle = await open(dir, fsConstants.O_RDONLY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Library pieces that the package does not export.

type ResolveConfigValue = (config: string, env?: Record<string, string>) => string | undefined;
let resolveConfigValueLoaded: Promise<ResolveConfigValue> | undefined;

/**
 * The default store's api_key resolution (`!command`, `$VAR`, literal), taken
 * from the library itself so the behaviour is the same and the command cache is
 * shared. The package exports only its root entry, so the module is loaded by
 * file URL from the installed package directory.
 */
function loadResolveConfigValue(): Promise<ResolveConfigValue> {
  resolveConfigValueLoaded ??= (async () => {
    const packageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
    if (packageJson === undefined) throw new Error("model credentials: @earendil-works/pi-coding-agent is not installed");
    const url = pathToFileURL(join(dirname(packageJson), "dist", "core", "resolve-config-value.js")).href;
    const module = (await import(url)) as { resolveConfigValue?: ResolveConfigValue };
    if (typeof module.resolveConfigValue !== "function") {
      throw new Error("model credentials: the library no longer provides resolveConfigValue");
    }
    return module.resolveConfigValue;
  })();
  return resolveConfigValueLoaded;
}

interface ProperLockfile {
  lock(
    file: string,
    options: { realpath: boolean; retries: number; stale: number; onCompromised: (error: Error) => void },
  ): Promise<() => Promise<void>>;
}

/** The lock library the default store uses, so both take the same `auth.json.lock`. */
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_DELAY_MS = 2_000;

/** Take the `auth.json` lock the way the library's file store does: retry until the stale time. */
async function acquireLock(path: string, signal: AbortSignal | undefined, onCompromised: (error: Error) => void) {
  const deadline = Date.now() + LOCK_STALE_MS;
  let retry = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const release = await lockfile.lock(path, { realpath: false, retries: 0, stale: LOCK_STALE_MS, onCompromised });
      if (signal?.aborted) {
        await release();
        signal.throwIfAborted();
      }
      return release;
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      const remaining = deadline - Date.now();
      if (code !== "ELOCKED" || remaining <= 0) throw error;
      const base = Math.min(10 * 2 ** retry, LOCK_MAX_DELAY_MS / 2);
      retry += 1;
      const delay = Math.min(Math.round(base * (1 + Math.random())), remaining);
      await (signal ? sleep(delay, undefined, { signal }) : sleep(delay));
    }
  }
}

async function ensureAuthFile(authPath: string): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(authPath, "wx", 0o600);
    await handle.writeFile("{}", "utf8");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Run `fn` while holding the `auth.json` lock. */
async function withAuthLock<T>(authPath: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  await ensureAuthFile(authPath);
  let compromised: Error | undefined;
  const release = await acquireLock(authPath, signal, (error) => {
    compromised = error;
  });
  try {
    const result = await fn();
    if (compromised !== undefined) throw new Error("model credentials: the auth.json lock was lost during a write");
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Reading

export interface ModelCredentialPaths {
  /** `auth.json`: credential shapes and file references. */
  readonly authPath: string;
  /** The secret store directory that holds the values. */
  readonly secretsDir: string;
}

function referencedPath(secretsDir: string, providerId: string, field: string, file: string): string {
  if (!isValidSecretName(file)) {
    throw new Error(`model credentials: ${providerId}.${field} names an invalid secret file name`);
  }
  return join(secretsDir, file);
}

/** Replace each file reference of one credential with the file's content. */
async function dereference(
  secretsDir: string,
  providerId: string,
  credential: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...credential };
  for (const [field, value] of Object.entries(credential)) {
    if (!isCredentialFileReference(value)) continue;
    const text = await readOptional(referencedPath(secretsDir, providerId, field, value.file));
    if (text === undefined) {
      throw new Error(`model credentials: secret file ${value.file} for ${providerId}.${field} is missing`);
    }
    out[field] = stripTrailingNewline(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The store

export interface ModelCredentialStoreOptions extends ModelCredentialPaths {
  /**
   * Called when the secret registry must read the files again, so it redacts
   * the new values from then on: after every write that changed a value, and
   * after a read that found the values changed underneath this store (another
   * process wrote them). The provider id says whose credential changed, so a
   * caller can act on one provider's change without acting on every change.
   * Absent where there is no registry, as in a one-off process that only reads
   * or writes the store.
   */
  readonly onChange?: (providerId: string) => Promise<void> | void;
  readonly log?: ModelCredentialLog;
}

/**
 * pi-sec's credential store for the model runtime. It is the `credentials`
 * the library's `ModelRuntime.create` takes, in place of its default file
 * store, and it keeps the same `auth.json` lock.
 */
export class ModelCredentialStore implements CredentialStore {
  readonly #options: ModelCredentialStoreOptions;
  /**
   * The values each provider's credential had at this store's last read, as a
   * digest. Another process (the login command) writes the same files, and the
   * store is the only place the daemon reads them through, so a read that sees
   * a different digest is the signal that the secret list is out of date.
   */
  readonly #fingerprints = new Map<string, string>();

  constructor(options: ModelCredentialStoreOptions) {
    this.#options = options;
  }

  async #readFile(): Promise<CredentialFile> {
    return parseCredentialFile(await readOptional(this.#options.authPath));
  }

  /**
   * Compare this read of one credential with the last one. The first read only
   * sets the baseline. A changed digest means someone else wrote the values, so
   * the registry reloads before the caller gets them; the reload is awaited so
   * the new value is redacted from the request that first sees it.
   */
  async #noteValues(providerId: string, credential: Record<string, unknown>): Promise<void> {
    const fingerprint = credentialFingerprint(credential);
    const previous = this.#fingerprints.get(providerId);
    this.#fingerprints.set(providerId, fingerprint);
    if (previous === undefined || previous === fingerprint) return;
    await this.#changed(providerId);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const stored = (await this.#readFile())[providerId];
    if (!isRecord(stored)) return undefined;
    const credential = (await dereference(this.#options.secretsDir, providerId, stored)) as unknown as Credential;
    await this.#noteValues(providerId, credential as unknown as Record<string, unknown>);
    options?.signal?.throwIfAborted();
    if (credential.type !== "api_key" || credential.key === undefined) return credential;
    const resolveConfigValue = await loadResolveConfigValue();
    return { ...credential, key: resolveConfigValue(credential.key, credential.env) } as Credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = await this.#readFile();
    return Object.entries(data)
      .filter(([, credential]) => isRecord(credential))
      .map(([providerId, credential]) => ({ providerId, type: credential["type"] as Credential["type"] }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const signal = options?.signal;
    let changed = false;
    const result = await withAuthLock(this.#options.authPath, signal, async () => {
      const data = await this.#readFile();
      const stored = data[providerId];
      const current = isRecord(stored)
        ? ((await dereference(this.#options.secretsDir, providerId, stored)) as unknown as Credential)
        : undefined;
      const next = await fn(current);
      if (next === undefined) return current;
      signal?.throwIfAborted();
      const shaped = await this.#writeValues(
        providerId,
        next as unknown as Record<string, unknown>,
        isRecord(stored) ? stored : undefined,
      );
      await writeFileAtomic(this.#options.authPath, JSON.stringify({ ...data, [providerId]: shaped }, null, 2));
      changed = true;
      return next;
    });
    if (changed) {
      // This store made the change, so the digest is already current: the read
      // after it must not report the same change again.
      if (result !== undefined) {
        this.#fingerprints.set(providerId, credentialFingerprint(result as unknown as Record<string, unknown>));
      }
      await this.#changed(providerId);
    }
    return result;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await withAuthLock(this.#options.authPath, options?.signal, async () => {
      const data = await this.#readFile();
      const stored = data[providerId];
      delete data[providerId];
      await writeFileAtomic(this.#options.authPath, JSON.stringify(data, null, 2));
      // The secret files stay: deleting a credential file cannot be undone, and
      // a file that nothing references is still registered and redacted.
      if (isRecord(stored)) {
        const files = Object.values(stored).filter(isCredentialFileReference).map((reference) => reference.file);
        this.#options.log?.("info", "model credential removed from auth.json; its secret files stay", {
          provider: providerId,
          files,
        });
      }
    });
    // The digest of a deleted credential stays as it was: the files stay on
    // disk, and a credential that another process writes under the same id is a
    // change this store has not seen.
    await this.#changed(providerId);
  }

  /**
   * Write the material fields of `next` to secret files, refresh first, and
   * return the credential as `auth.json` keeps it: references in place of
   * values. A field keeps the file its stored reference already names.
   */
  async #writeValues(
    providerId: string,
    next: Record<string, unknown>,
    stored: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const shaped: Record<string, unknown> = { ...next };
    const written: { field: string; file: string; bytes: number }[] = [];
    for (const { field, value } of materialFields(next)) {
      const previous = stored?.[field];
      const file = isCredentialFileReference(previous) ? previous.file : modelSecretName(providerId, field);
      if (!isValidSecretName(file)) {
        // A provider id that cannot be a file name keeps the value inline,
        // where the registry still finds it.
        this.#options.log?.("warn", "model credential field kept inline: no valid secret file name", {
          provider: providerId,
          field,
        });
        continue;
      }
      const path = join(this.#options.secretsDir, file);
      const existing = await readOptional(path);
      if (
        typeof previous === "string" &&
        existing !== undefined &&
        stripTrailingNewline(existing) !== previous &&
        stripTrailingNewline(existing) !== value
      ) {
        // The state the start-up move stopped on: a file of this name holds
        // some other value. It is not ours to overwrite, so the field stays
        // inline until a person settles the clash.
        shaped[field] = value;
        this.#options.log?.("warn", "model credential field kept inline: a secret file of the same name holds a different value", {
          provider: providerId,
          field,
          file,
        });
        continue;
      }
      if (existing === undefined || stripTrailingNewline(existing) !== value) {
        await mkdir(this.#options.secretsDir, { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, value);
        written.push({ field, file, bytes: Buffer.byteLength(value, "utf8") });
      }
      shaped[field] = { file };
    }
    if (written.length > 0) {
      this.#options.log?.("info", "model credential written to secret files", { provider: providerId, written });
    }
    return shaped;
  }

  async #changed(providerId: string): Promise<void> {
    if (this.#options.onChange === undefined) return;
    try {
      await this.#options.onChange(providerId);
    } catch (error) {
      // The values are on disk whatever happens here. A registry that cannot
      // reload keeps its old list; the failure is reported, never the value.
      this.#options.log?.("warn", "secret registry reload after a credential change failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The one-time move at daemon start

export interface MigrateModelCredentialsOptions extends ModelCredentialPaths {
  readonly log?: ModelCredentialLog;
  /** Clock for the backup name. Tests pin it. */
  readonly now?: () => Date;
}

export interface MovedField {
  readonly provider: string;
  readonly field: string;
  readonly file: string;
  readonly bytes: number;
  /** The file already held this value, so nothing was written. */
  readonly alreadyPresent: boolean;
}

export type MigrateModelCredentialsResult =
  | { readonly status: "absent" }
  | { readonly status: "nothing_to_move" }
  | { readonly status: "migrated"; readonly backup: string; readonly moved: readonly MovedField[] }
  | { readonly status: "conflict"; readonly conflicts: readonly string[] }
  | { readonly status: "failed"; readonly error: string };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function dayStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function timeStamp(date: Date): string {
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Copy `text` to a new backup file, 0600, never over an existing one. */
async function writeBackup(authPath: string, text: string, now: Date): Promise<string> {
  const base = `${authPath}.bak-${dayStamp(now)}-model-auth`;
  const candidates = [base, `${base}-${timeStamp(now)}`];
  for (let index = 1; index <= 20; index += 1) candidates.push(`${base}-${timeStamp(now)}-${index}`);
  for (const candidate of candidates) {
    if (await exists(candidate)) continue;
    const handle = await open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return candidate;
  }
  throw new Error("model credentials: no free backup name for auth.json");
}

/**
 * Move every inline credential value of `auth.json` to a secret file, once.
 *
 * Order: copy `auth.json` to `auth.json.bak-<YYYYMMDD>-model-auth`, write each
 * value to `model-auth.<provider>.<field>` atomically, then rewrite `auth.json`
 * with references, atomically. A secret file of that name that already holds a
 * different value stops the move before anything is written, and `auth.json`
 * stays as it was; the daemon keeps running on the inline values. A file that
 * already holds the same value counts as moved.
 *
 * Never throws: a failure is the result, and `auth.json` is then unchanged or
 * fully rewritten, because its rewrite is the last and atomic step.
 */
export async function migrateModelCredentials(options: MigrateModelCredentialsOptions): Promise<MigrateModelCredentialsResult> {
  const log = options.log;
  try {
    if (!(await exists(options.authPath))) return { status: "absent" };
    return await withAuthLock(options.authPath, undefined, async () => {
      const text = (await readOptional(options.authPath)) ?? "";
      const data = parseCredentialFile(text);

      const plan: { provider: string; field: string; file: string; value: string; alreadyPresent: boolean }[] = [];
      const conflicts: string[] = [];
      for (const [provider, credential] of Object.entries(data)) {
        if (!isRecord(credential)) continue;
        for (const { field, value } of materialFields(credential)) {
          const file = modelSecretName(provider, field);
          if (!isValidSecretName(file)) {
            log?.("warn", "model credential field kept inline: no valid secret file name", { provider, field });
            continue;
          }
          const existing = await readOptional(join(options.secretsDir, file));
          if (existing !== undefined && stripTrailingNewline(existing) !== value) {
            conflicts.push(file);
            continue;
          }
          plan.push({ provider, field, file, value, alreadyPresent: existing !== undefined });
        }
      }

      if (conflicts.length > 0) {
        log?.("warn", "model credential move stopped: a secret file of the same name holds a different value", {
          files: conflicts,
        });
        return { status: "conflict", conflicts } as const;
      }
      if (plan.length === 0) return { status: "nothing_to_move" } as const;

      const backup = await writeBackup(options.authPath, text, (options.now ?? (() => new Date()))());
      await mkdir(options.secretsDir, { recursive: true, mode: 0o700 });
      for (const entry of plan) {
        if (!entry.alreadyPresent) await writeFileAtomic(join(options.secretsDir, entry.file), entry.value);
      }
      const next: CredentialFile = structuredClone(data);
      for (const entry of plan) next[entry.provider]![entry.field] = { file: entry.file };
      await writeFileAtomic(options.authPath, JSON.stringify(next, null, 2));

      const moved: MovedField[] = plan.map((entry) => ({
        provider: entry.provider,
        field: entry.field,
        file: entry.file,
        bytes: Buffer.byteLength(entry.value, "utf8"),
        alreadyPresent: entry.alreadyPresent,
      }));
      log?.("info", "model credentials moved to secret files", { backup: basename(backup), moved });
      return { status: "migrated", backup, moved } as const;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.("warn", "model credential move failed; auth.json is unchanged", { error: message });
    return { status: "failed", error: message };
  }
}
