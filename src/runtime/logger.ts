import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Redactor } from "../secrets/redact.ts";
import { NULL_REDACTOR } from "../secrets/redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly file?: string;
  readonly level?: LogLevel;
  readonly console?: boolean;
  readonly maxBytes?: number;
  readonly retainFiles?: number;
  /** Live redactor lookup; log records are redacted before serialization. */
  readonly redactor?: () => Redactor;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function normalizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (fields === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = serializeError(value);
  return out;
}

function rotate(file: string, maxBytes: number, retainFiles: number): void {
  if (maxBytes <= 0 || retainFiles <= 0) return;
  try {
    const info = statSync(file);
    if (info.size < maxBytes) return;
  } catch {
    return;
  }
  try {
    unlinkSync(`${file}.${retainFiles}`);
  } catch {
    /* absent */
  }
  for (let index = retainFiles - 1; index >= 1; index -= 1) {
    const from = `${file}.${index}`;
    if (existsSync(from)) {
      try {
        renameSync(from, `${file}.${index + 1}`);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
}

/** Structured JSON-lines logger with secret redaction. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const toConsole = options.console ?? true;
  const maxBytes = options.maxBytes ?? 0;
  const retainFiles = options.retainFiles ?? 0;
  const redactor = options.redactor ?? (() => NULL_REDACTOR);

  const emit = (entryLevel: LogLevel, bindings: Record<string, unknown>, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const record = {
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...bindings,
      ...normalizeFields(fields),
    };
    let line: string;
    try {
      line = redactor().redact(JSON.stringify(record));
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level: "error", message: "log serialization failed" });
    }
    if (options.file) {
      try {
        mkdirSync(dirname(options.file), { recursive: true });
        rotate(options.file, maxBytes, retainFiles);
        appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
      } catch {
        /* never let logging break work */
      }
    }
    if (toConsole) {
      const stream = entryLevel === "error" || entryLevel === "warn" ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    }
  };

  const make = (bindings: Record<string, unknown>): Logger => ({
    debug: (message, fields) => emit("debug", bindings, message, fields),
    info: (message, fields) => emit("info", bindings, message, fields),
    warn: (message, fields) => emit("warn", bindings, message, fields),
    error: (message, fields) => emit("error", bindings, message, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  });

  return make({});
}
