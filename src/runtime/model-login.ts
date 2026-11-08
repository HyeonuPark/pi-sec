/**
 * Signing a model provider in from the web UI.
 *
 * The daemon's model runtime owns the login flows; this module owns the one
 * login session the daemon allows at a time, and the record of when each
 * provider last logged in.
 *
 * Three rules hold everything here together.
 *
 * - A login session lives in memory only. A restart ends it, and nothing of it
 *   reaches the disk except the record entry a success writes.
 * - Prompts and notifications are passed through to whoever holds the session
 *   id, and to nobody else. The answers are never written to a log, an audit
 *   row, a record file or an error sentence: they are credential material.
 * - One audit row per finished session, `model_login`, naming the provider, the
 *   login type and the outcome, and nothing else.
 *
 * The record file (`state/model-logins.json`) holds the newest successful login
 * per provider: its UTC time and its type. It never holds a value. A login that
 * succeeds is a success even when the record cannot be written; the panel then
 * shows the warning and the audit row still says success.
 *
 * The installation ID a login flow may ask for lives in `state/device-id`: one
 * lowercase UUID, created on first use, and never rewritten. A file that holds
 * anything else is left as it is and the login that needs the ID fails, so the
 * ID cannot change under a provider that already knows this install.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Models, Provider } from "@earendil-works/pi-ai";
import type { AuditLog } from "./audit.ts";
import type { Logger } from "./logger.ts";
import type { SecretRegistry } from "../secrets/registry.ts";
import { writeFileAtomic } from "../secrets/model-credentials.ts";

/** How long a session may run before the daemon ends it. */
export const MODEL_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long a finished session's last state stays readable. */
export const MODEL_LOGIN_FINISHED_MS = 10 * 60_000;

/** The file under the state directory that holds the installation ID. */
export const DEVICE_ID_FILE_NAME = "device-id";

/** What the file must hold: one lowercase UUID of version 4. */
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The outcome an audit row carries. */
export type ModelLoginOutcome = "success" | "failed" | "cancelled" | "timeout";

/** Where a session is now. The last four are final. */
export type ModelLoginStatus = "running" | "prompt" | "succeeded" | "failed" | "cancelled" | "timeout";

/** Why a session ended without a credential. Fixed codes, never an error text. */
export type ModelLoginReason = "cancelled" | "timeout" | "code_rejected" | "failed";

/** A refusal the caller turns into an HTTP answer. */
export type ModelLoginFailure =
  | "login_unavailable"
  | "login_busy"
  | "login_not_found"
  | "login_no_prompt"
  | "unknown_provider"
  | "login_type_unavailable";

/** One question the flow is waiting on, in the shape a page needs. */
export interface ModelLoginPrompt {
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
}

/**
 * One notification of the flow, in the shape a page needs.
 *
 * `auth_url` and `device_code` are shown, never logged. Both can carry the
 * proof that binds the browser's answer to this flow, so they are treated as
 * secret material from here on.
 */
export type ModelLoginEvent =
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: "progress"; readonly message: string };

/** The newest successful login of one provider, as the record file keeps it. */
export interface ModelLoginRecordEntry {
  readonly at: string;
  readonly type: AuthType;
}

/** The record file. */
export interface ModelLoginRecord {
  version: 1;
  logins: Record<string, ModelLoginRecordEntry>;
}

/**
 * The same file with every entry kept exactly as it was read.
 *
 * Another provider's entry is not rewritten, only the login's own: an entry
 * written by hand can carry a field this module does not know about (for example
 * a `note`), and rewriting it from the fields below would drop
 * that field without saying so.
 */
type RawRecord = { version: 1; logins: Record<string, Record<string, unknown>> };

/** One provider as the panel lists it. */
export interface ModelLoginProvider {
  readonly id: string;
  /** The extension that registered the provider, or null for a built-in one. */
  readonly extension: string | null;
  /** Whether a credential is stored or ambient right now. */
  readonly configured: boolean;
  /** The login types this provider can actually run. */
  readonly types: readonly AuthType[];
  readonly lastLogin: ModelLoginRecordEntry | null;
}

/** The answer of `GET .../providers`. */
export interface ModelLoginProviders {
  /** False when the catalog cannot log in at all; the panel then says so. */
  readonly available: boolean;
  readonly providers: readonly ModelLoginProvider[];
  /** Whether a session is running now. */
  readonly sessionActive: boolean;
}

/** The answer of `POST .../state`, `.../answer` and `.../cancel`. */
export interface ModelLoginState {
  readonly status: ModelLoginStatus;
  readonly provider: string;
  readonly type: AuthType;
  readonly prompt: ModelLoginPrompt | null;
  readonly events: readonly ModelLoginEvent[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** The time a success recorded, when the record file took it. */
  readonly loginAt: string | null;
  readonly reason: ModelLoginReason | null;
  /** `warning: the login time was not recorded in <file>: <reason>` */
  readonly warning: string | null;
}

export interface ModelLoginServiceOptions {
  readonly models: Models;
  /** The extension that registered a provider; the panel shows it. */
  readonly ownerOf?: (providerId: string) => string | undefined;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly secrets: SecretRegistry;
  /** `state/model-logins.json`. */
  readonly recordFile: string;
  /** `state/device-id`, the installation ID a login flow may ask for. */
  readonly deviceIdFile: string;
  /** A test shortens this; the daemon uses the default. */
  readonly sessionTimeoutMs?: number;
  /** A test shortens this; the daemon uses the default. */
  readonly finishedRetentionMs?: number;
  readonly now?: () => number;
}

/**
 * The sentence a device ID file problem carries. Fixed, and naming the file:
 * the file is the one thing the reader has to look at.
 */
export function deviceIdMessage(file: string): string {
  return `the device ID file ${file} must hold one lowercase UUID; pi-sec leaves the file as it is and the login that needs the ID fails`;
}

/**
 * Write the ID under the name the daemon reads, readable by this user only.
 *
 * The temporary name is in the same directory, so the rename is one step and a
 * reader finds no file or the whole one. A failed attempt leaves no temporary
 * file behind.
 */
function createDeviceIdFile(file: string, id: string): void {
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let handle: number | undefined;
  try {
    handle = openSync(temp, "wx", 0o600);
    writeFileSync(handle, `${id}\n`, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* the temporary name may never have been made */
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`the device ID file ${file} could not be created (${code ?? "error"})`);
  }
}

/**
 * The installation ID, created on the first call and read after that.
 *
 * Synchronous on purpose: the library asks for the ID through `getDeviceId?: ()
 * => string`, so a promise has nowhere to go. A file that cannot be read or
 * does not hold a UUID is a failure and not a reason to write a new ID, because
 * a provider that already knows this install would see a different one.
 */
export function readOrCreateDeviceId(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(deviceIdMessage(file));
    const id = randomUUID();
    createDeviceIdFile(file, id);
    return id;
  }
  const id = text.trim();
  if (!DEVICE_ID_PATTERN.test(id)) throw new Error(deviceIdMessage(file));
  return id;
}

interface PendingPrompt {
  readonly prompt: AuthPrompt;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

interface Session {
  readonly id: string;
  readonly provider: string;
  readonly type: AuthType;
  readonly startedAt: number;
  readonly controller: AbortController;
  events: ModelLoginEvent[];
  prompt: ModelLoginPrompt | null;
  pending: PendingPrompt | undefined;
  /** Set by cancel and by the timeout, so the failure carries the right code. */
  ending: "cancelled" | "timeout" | undefined;
  /** True once an answer to a manual_code or text prompt was submitted. */
  answeredCode: boolean;
  settled: boolean;
  finishedAt: number | undefined;
  loginAt: string | undefined;
  warning: string | undefined;
  status: ModelLoginStatus;
  deadline: ReturnType<typeof setTimeout> | undefined;
  retention: ReturnType<typeof setTimeout> | undefined;
  drive: Promise<void> | undefined;
}

/** An abort reason the flow sees as a cancellation rather than a failure. */
class LoginEnded extends Error {
  constructor(reason: "cancelled" | "timeout") {
    super(reason === "timeout" ? "the login timed out" : "the login was cancelled");
    this.name = "LoginEnded";
  }
}

function emptyRecord(): RawRecord {
  return { version: 1, logins: {} };
}

function entryOf(value: unknown): ModelLoginRecordEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as { at?: unknown; type?: unknown };
  if (typeof entry.at !== "string" || entry.at === "") return undefined;
  if (entry.type !== "oauth" && entry.type !== "api_key") return undefined;
  return { at: entry.at, type: entry.type };
}

/**
 * The record file, plus the reason it could not be used.
 *
 * A missing file is not a problem: it is a home that never logged in. A file
 * that cannot be read, or that is not the shape of a record, is a warning:
 * the pass starts from an empty record, so the login it is about still lands.
 */
function parseRecord(text: string): RawRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as { version?: unknown; logins?: unknown };
  if (record.version !== 1) return undefined;
  if (typeof record.logins !== "object" || record.logins === null || Array.isArray(record.logins)) return undefined;
  const logins: Record<string, Record<string, unknown>> = {};
  for (const [provider, value] of Object.entries(record.logins as Record<string, unknown>)) {
    // Every entry has to be one this module can read, or the file is not a login
    // record and the pass starts again rather than writing over a shape it does
    // not understand.
    if (entryOf(value) === undefined) return undefined;
    logins[provider] = { ...(value as Record<string, unknown>) };
  }
  return { version: 1, logins };
}

async function readRecord(file: string): Promise<{ readonly record: RawRecord; readonly problem?: string }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { record: emptyRecord() };
    return { record: emptyRecord(), problem: `the file could not be read (${code ?? "error"})` };
  }
  const parsed = parseRecord(text);
  if (parsed === undefined) return { record: emptyRecord(), problem: "the file is not a login record" };
  return { record: parsed };
}

/** The login types a provider can actually run; ambient API-key auth has no login. */
function offeredTypes(provider: Provider): AuthType[] {
  const types: AuthType[] = [];
  if (provider.auth.oauth !== undefined) types.push("oauth");
  if (provider.auth.apiKey?.login !== undefined) types.push("api_key");
  return types;
}

function promptOf(prompt: AuthPrompt): ModelLoginPrompt {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  };
}

/**
 * One notification in the shape a page needs, with every field it does not
 * name left out. Copying them one by one keeps a field the library adds later
 * from reaching a page, and with it the log, by accident.
 */
function eventOf(event: AuthEvent): ModelLoginEvent {
  switch (event.type) {
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "info":
      return {
        type: "info",
        message: event.message,
        ...(event.links === undefined || event.links.length === 0
          ? {}
          : { links: event.links.map((link) => (link.label === undefined ? { url: link.url } : { url: link.url, label: link.label })) }),
      };
    case "progress":
      return { type: "progress", message: event.message };
  }
}

/**
 * The one login session the daemon allows, and the record of successful logins.
 *
 * Held by the agent runtime, so the routes, the audit log and the secret
 * registry are the daemon's own objects and a restart drops every session with
 * the process.
 */
export class ModelLoginService {
  readonly #options: ModelLoginServiceOptions;
  readonly #timeoutMs: number;
  readonly #finishedMs: number;
  /** The session that may be answered or cancelled now. */
  #live: Session | undefined;
  /** The last finished session, readable until retention ends or a new start. */
  #finished: Session | undefined;
  /** Whether the device ID warning has been written in this run. */
  #deviceWarningLogged = false;

  constructor(options: ModelLoginServiceOptions) {
    this.#options = options;
    this.#timeoutMs = options.sessionTimeoutMs ?? MODEL_LOGIN_TIMEOUT_MS;
    this.#finishedMs = options.finishedRetentionMs ?? MODEL_LOGIN_FINISHED_MS;
  }

  /** Whether the catalog this daemon holds can run a login at all. */
  get available(): boolean {
    return typeof (this.#options.models as { login?: unknown }).login === "function";
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /**
   * The providers the panel offers, each with the newest login the record file
   * holds. A record file that cannot be read costs the `lastLogin` entries and
   * nothing else: this is a read, and it writes nothing.
   */
  async providers(): Promise<ModelLoginProviders> {
    const { record } = await readRecord(this.#options.recordFile);
    const providers: ModelLoginProvider[] = [];
    for (const provider of this.#options.models.getProviders()) {
      providers.push({
        id: provider.id,
        extension: this.#options.ownerOf?.(provider.id) ?? null,
        configured: await this.#configured(provider.id),
        types: offeredTypes(provider),
        lastLogin: entryOf(record.logins[provider.id]) ?? null,
      });
    }
    return { available: this.available, providers, sessionActive: this.#live !== undefined };
  }

  async #configured(providerId: string): Promise<boolean> {
    const models = this.#options.models as Models & { hasConfiguredAuth?: (id: string) => boolean };
    if (typeof models.hasConfiguredAuth === "function") {
      try {
        return models.hasConfiguredAuth(providerId);
      } catch {
        return false;
      }
    }
    // A catalog without the synchronous check answers the same question the
    // side-effect-free way. A provider that throws is one nothing can be said
    // about, and "not configured" is the safe reading: the panel then offers a
    // login instead of hiding it.
    try {
      return (await models.checkAuth(providerId)) !== undefined;
    } catch {
      return false;
    }
  }

  #stateOf(session: Session): ModelLoginState {
    const failedAfterCode =
      session.status === "failed" && session.type === "oauth" && session.answeredCode;
    return {
      status: session.status,
      provider: session.provider,
      type: session.type,
      prompt: session.status === "prompt" ? session.prompt : null,
      events: session.events.map((event) => ({ ...event })),
      startedAt: new Date(session.startedAt).toISOString(),
      finishedAt: session.finishedAt === undefined ? null : new Date(session.finishedAt).toISOString(),
      loginAt: session.loginAt ?? null,
      reason:
        session.status === "cancelled"
          ? "cancelled"
          : session.status === "timeout"
            ? "timeout"
            : failedAfterCode
              ? "code_rejected"
              : session.status === "failed"
                ? "failed"
                : null,
      warning: session.warning ?? null,
    };
  }

  /**
   * Start a login. The answer carries the session id, which every later request
   * has to name: prompts, notifications and the outcome are readable only with
   * it.
   */
  start(
    providerId: string,
    type: AuthType,
  ): { ok: true; session: string; state: ModelLoginState } | { ok: false; code: ModelLoginFailure } {
    if (!this.available) return { ok: false, code: "login_unavailable" };
    if (this.#live !== undefined) return { ok: false, code: "login_busy" };
    const provider = this.#options.models.getProvider(providerId);
    if (provider === undefined) return { ok: false, code: "unknown_provider" };
    if (!offeredTypes(provider).includes(type)) return { ok: false, code: "login_type_unavailable" };

    // One finished session is kept for a short while, so a page that polls once
    // more after the end still reads the outcome. A new start takes that slot,
    // which is what stops finished states from piling up.
    this.#dropFinished();

    const startedAt = this.#now();
    const session: Session = {
      id: randomBytes(16).toString("base64url"),
      provider: providerId,
      type,
      startedAt,
      controller: new AbortController(),
      events: [],
      prompt: null,
      pending: undefined,
      ending: undefined,
      answeredCode: false,
      settled: false,
      finishedAt: undefined,
      loginAt: undefined,
      warning: undefined,
      status: "running",
      deadline: undefined,
      retention: undefined,
      drive: undefined,
    };
    this.#live = session;
    const timer = setTimeout(() => {
      if (session.settled) return;
      this.#endLive(session, "timeout");
    }, this.#timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    session.deadline = timer;
    session.drive = this.#drive(session);
    return { ok: true, session: session.id, state: this.#stateOf(session) };
  }

  /** The current state of one session, or `undefined` when the id names none. */
  state(sessionId: string): ModelLoginState | undefined {
    const session = this.#find(sessionId);
    return session === undefined ? undefined : this.#stateOf(session);
  }

  /**
   * Answer the prompt the flow is waiting on. The value is handed to the flow
   * and nowhere else: it is not stored, logged or echoed back.
   */
  answer(
    sessionId: string,
    value: string,
  ): { ok: true; state: ModelLoginState } | { ok: false; code: ModelLoginFailure } {
    const session = this.#find(sessionId);
    if (session === undefined) return { ok: false, code: "login_not_found" };
    const pending = session.pending;
    if (session.settled || pending === undefined) return { ok: false, code: "login_no_prompt" };

    session.pending = undefined;
    session.prompt = null;
    session.status = "running";
    if (pending.prompt.type === "manual_code" || pending.prompt.type === "text") session.answeredCode = true;
    pending.resolve(value);
    return { ok: true, state: this.#stateOf(session) };
  }

  /** End the live session. A finished session answers with the state it has. */
  cancel(sessionId: string): { ok: true; state: ModelLoginState } | { ok: false; code: ModelLoginFailure } {
    const session = this.#find(sessionId);
    if (session === undefined) return { ok: false, code: "login_not_found" };
    if (!session.settled) this.#endLive(session, "cancelled");
    return { ok: true, state: this.#stateOf(session) };
  }

  #find(sessionId: string): Session | undefined {
    if (this.#live !== undefined && this.#live.id === sessionId) return this.#live;
    if (this.#finished !== undefined && this.#finished.id === sessionId) return this.#finished;
    return undefined;
  }

  /**
   * The interaction the model runtime drives the flow with. `prompt` parks the
   * flow on a promise that `answer` resolves, and `notify` collects what the
   * page has to show without ever writing it down.
   */
  #interaction(session: Session): AuthInteraction {
    return {
      signal: session.controller.signal,
      prompt: (prompt: AuthPrompt) =>
        new Promise<string>((resolve, reject) => {
          if (session.settled) {
            reject(new LoginEnded(session.ending ?? "cancelled"));
            return;
          }
          session.prompt = promptOf(prompt);
          session.status = "prompt";
          session.pending = { prompt, resolve, reject };
          // A provider may cancel one prompt on its own, for example when a
          // callback server answers before the paste arrives. The flow then
          // takes the next step and this question is over.
          prompt.signal?.addEventListener(
            "abort",
            () => {
              if (session.pending?.prompt !== prompt) return;
              session.pending = undefined;
              session.prompt = null;
              reject(new LoginEnded("cancelled"));
            },
            { once: true },
          );
        }),
      notify: (event: AuthEvent) => {
        if (session.settled) return;
        session.events.push(eventOf(event));
      },
    };
  }

  /**
   * The installation ID, or the failure the flow sees.
   *
   * The flow asks for the ID only when it needs one, so an `openai-codex` login
   * never touches the file. The warning is written once per daemon run: the
   * fixed sentence names the file, and a file that stays broken would otherwise
   * add a line to every login attempt.
   */
  #deviceId(): string {
    const file = this.#options.deviceIdFile;
    try {
      return readOrCreateDeviceId(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : deviceIdMessage(file);
      if (!this.#deviceWarningLogged) {
        this.#deviceWarningLogged = true;
        this.#options.logger.warn(message);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async #drive(session: Session): Promise<void> {
    try {
      // The login options carry the installation ID and nothing else: the
      // library sends `agentName` as the Codex originator, and that login works
      // as it is.
      await this.#options.models.login(session.provider, session.type, this.#interaction(session), {
        getDeviceId: () => this.#deviceId(),
      });
    } catch {
      // Nothing of the error is kept: a library error can carry the provider's
      // response body, and that body is exactly what must not travel further.
      this.#settle(session, session.ending ?? "failed");
      return;
    }
    if (session.settled) return;
    await this.#succeed(session);
  }

  /** Record the login time, refresh redaction, then settle as a success. */
  async #succeed(session: Session): Promise<void> {
    const at = new Date(this.#now()).toISOString();
    const warning = await this.#record(session.provider, session.type, at);
    try {
      // The credential store reloads the registry on its own change. A catalog
      // built without that callback does not, and nothing here can tell which
      // one ran, so the read is repeated: a second pass over the directory is
      // idempotent and costs one read of a few small files.
      await this.#options.secrets.reload();
    } catch {
      this.#options.logger.warn("secret store reload after model login failed", { provider: session.provider });
    }
    if (session.settled) return;
    session.loginAt = at;
    session.warning = warning;
    this.#settle(session, "success");
  }

  /**
   * Write this provider's entry, keeping every other provider's.
   *
   * A login that succeeded stays a success when the file cannot be written:
   * the credential is already in the secret store. The returned warning is the
   * one line the panel shows, and it names the file and a reason code, never a
   * value.
   */
  async #record(provider: string, type: AuthType, at: string): Promise<string | undefined> {
    const file = this.#options.recordFile;
    const { record, problem } = await readRecord(file);
    // The login's own entry is replaced whole, so a field an older entry carried
    // (for example a hand-written `note`) goes with it. Every other entry is
    // written back exactly as it was read.
    const next: RawRecord = {
      version: 1,
      logins: { ...record.logins, [provider]: { at, type } },
    };
    if (problem !== undefined) {
      // The pass started from an empty record, so the entries the file used to
      // hold are about to be replaced by this one entry.
      this.#options.logger.warn("login record file replaced", { file, reason: problem });
    }
    let failure: string | undefined;
    try {
      await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failure = `the file could not be written (${code ?? "error"})`;
      this.#options.logger.warn("login time not recorded", { file, reason: failure });
    }
    const explanation = failure ?? problem;
    if (explanation === undefined) return undefined;
    return `warning: the login time was not recorded in ${file}: ${explanation}`;
  }

  /** Settle as cancelled or timed out, and stop the flow. */
  #endLive(session: Session, reason: "cancelled" | "timeout"): void {
    if (session.settled) return;
    session.ending = reason;
    this.#settle(session, reason);
    try {
      session.controller.abort(new LoginEnded(reason));
    } catch {
      /* an abort listener that throws is not a reason to keep the session */
    }
  }

  /**
   * The one place a session ends. Every path calls it once: the audit row, the
   * cleared timers and the readable finished state all come from here, so no
   * path can end a session twice or leave one behind.
   */
  #settle(session: Session, outcome: ModelLoginOutcome): void {
    if (session.settled) return;
    session.settled = true;
    if (session.deadline !== undefined) {
      clearTimeout(session.deadline);
      session.deadline = undefined;
    }
    const pending = session.pending;
    session.pending = undefined;
    session.prompt = null;
    // A flow still parked on a question has to be let go, or its provider keeps
    // a promise alive with nothing that can ever answer it.
    pending?.reject(new LoginEnded(session.ending ?? "cancelled"));

    session.status =
      outcome === "success"
        ? "succeeded"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "timeout"
            ? "timeout"
            : "failed";
    session.finishedAt = this.#now();

    this.#options.audit.append({
      type: "model_login",
      provider: session.provider,
      loginType: session.type,
      outcome,
    });
    this.#options.logger.info("model login", {
      provider: session.provider,
      loginType: session.type,
      outcome,
    });

    if (this.#live === session) this.#live = undefined;
    this.#finished = session;
    const timer = setTimeout(() => {
      if (this.#finished === session) this.#finished = undefined;
    }, this.#finishedMs);
    if (typeof timer.unref === "function") timer.unref();
    session.retention = timer;
  }

  #dropFinished(): void {
    const finished = this.#finished;
    if (finished === undefined) return;
    if (finished.retention !== undefined) clearTimeout(finished.retention);
    finished.retention = undefined;
    this.#finished = undefined;
  }
}
