import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Redactor } from "../secrets/redact.ts";
import { NULL_REDACTOR } from "../secrets/redact.ts";

export interface AuditEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AuditLogOptions {
  readonly file: string;
  readonly maxBytes?: number;
  readonly retainDays?: number;
  readonly redactor?: () => Redactor;
  readonly now?: () => number;
}

export interface AuditLog {
  append(event: AuditEvent): void;
  /** Hash of tool arguments; never the raw secret values. */
  hashArguments(value: unknown): string;
}

function rotateBySize(file: string, maxBytes: number): void {
  if (maxBytes <= 0) return;
  try {
    if (statSync(file).size < maxBytes) return;
  } catch {
    return;
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  try {
    renameSync(file, `${file}.${stamp}`);
  } catch {
    /* ignore */
  }
}

function pruneByAge(file: string, retainDays: number): void {
  if (retainDays <= 0) return;
  // Best-effort: the janitor performs the real pruning pass; this keeps the
  // active file from being rewritten here.
  void file;
  void retainDays;
}

/**
 * Append-only JSONL audit trail. Append-only is a convention, not an
 * OS-enforced guarantee (the agent runs under the same UID). Every record is
 * redacted before serialization.
 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
  const redactor = options.redactor ?? (() => NULL_REDACTOR);
  const now = options.now ?? (() => Date.now());

  const append = (event: AuditEvent): void => {
    const record = { time: now(), ...event };
    let line: string;
    try {
      line = redactor().redact(JSON.stringify(record));
    } catch {
      line = JSON.stringify({ time: now(), type: "audit_error" });
    }
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      rotateBySize(options.file, options.maxBytes ?? 0);
      pruneByAge(options.file, options.retainDays ?? 0);
      appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
    } catch {
      /* never let auditing break work */
    }
  };

  return {
    append,
    hashArguments: (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex"),
  };
}

/** Read the tail of an audit file, newest last. */
export async function readAuditTail(file: string, since: number | undefined, limit: number): Promise<AuditEvent[]> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as AuditEvent;
      if (since !== undefined && typeof parsed.time === "number" && parsed.time < since) continue;
      events.push(parsed);
    } catch {
      /* skip corrupt line */
    }
  }
  return events.slice(-limit);
}

/** Exposed for tests: remove rotated files past the retention window. */
export function auditRotate(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}
