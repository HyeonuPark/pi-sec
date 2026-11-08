/**
 * One-way secret redaction. Real values become fixed dummy tokens; there is no
 * `resolve()`. A dummy passed to a tool is passed literally.
 */

export interface SecretValue {
  readonly name: string;
  readonly value: string;
}

export interface Redactor {
  /** Real secret values in `text` replaced by their dummy tokens. */
  redact(text: string): string;
  /** Whether `text` contains any registered value or variant. */
  containsSecret(text: string): boolean;
  /** The dummy token for a stored value, if it is registered. */
  dummyOf(value: string): string | undefined;
  /** Longest registered variant; the streaming window size derives from it. */
  readonly maxVariantLength: number;
}

export interface RedactorOptions {
  /** `⟦secret:{name}⟧` by default. `{name}` is replaced. */
  readonly dummyFormat?: string;
  readonly encodings?: readonly ("raw" | "base64" | "url")[];
}

/** Standard, unpadded, and URL-safe base64 variants. */
function base64Variants(value: string): string[] {
  const buf = Buffer.from(value, "utf8");
  const standard = buf.toString("base64");
  const url = buf.toString("base64url");
  const strip = (s: string): string => s.replace(/=+$/, "");
  return [standard, strip(standard), url, strip(url)];
}

function variantsOf(value: string, encodings: readonly string[]): string[] {
  const out = new Set<string>();
  if (value.length === 0) return [];
  if (encodings.includes("raw")) out.add(value);
  if (encodings.includes("base64")) for (const v of base64Variants(value)) out.add(v);
  if (encodings.includes("url")) {
    out.add(encodeURIComponent(value));
    out.add(encodeURI(value));
  }
  return [...out].filter((v) => v.length > 0);
}

function dummyFor(name: string, format: string): string {
  return format.replaceAll("{name}", name);
}

/** Build an immutable redactor over a snapshot of secret values. */
export function createRedactor(entries: readonly SecretValue[], options: RedactorOptions = {}): Redactor {
  const encodings = options.encodings ?? ["raw", "base64", "url"];
  const format = options.dummyFormat ?? "⟦secret:{name}⟧";

  const dummyByVariant = new Map<string, string>();
  const dummyByValue = new Map<string, string>();
  for (const entry of entries) {
    if (entry.value.length === 0) continue;
    const dummy = dummyFor(entry.name, format);
    dummyByValue.set(entry.value, dummy);
    for (const variant of variantsOf(entry.value, encodings)) {
      dummyByVariant.set(variant, dummy);
    }
  }

  const ordered = [...dummyByVariant.entries()].sort((a, b) => b[0].length - a[0].length);
  const maxVariantLength = ordered.reduce((max, [variant]) => Math.max(max, variant.length), 0);

  const redact = (text: string): string => {
    if (text.length === 0 || ordered.length === 0) return text;
    let out = text;
    for (const [variant, dummy] of ordered) {
      if (out.includes(variant)) out = out.split(variant).join(dummy);
    }
    return out;
  };

  return {
    redact,
    containsSecret: (text) => ordered.some(([variant]) => text.includes(variant)),
    dummyOf: (value) => dummyByValue.get(value),
    maxVariantLength,
  };
}

/** The empty redactor used before any secret has been loaded. */
export const NULL_REDACTOR: Redactor = createRedactor([]);

export interface RedactingStream {
  /** Feed a chunk; returns text safe to emit now (may be empty). */
  push(chunk: string): string;
  /** Flush the held tail; call once at stream end. */
  flush(): string;
}

/**
 * Sliding-window redaction for chunked output. Holds back the last
 * `maxVariantLength - 1` characters so a secret split across chunks is never
 * emitted in the clear.
 */
export function createRedactingStream(redactor: Redactor): RedactingStream {
  const hold = Math.max(0, redactor.maxVariantLength - 1);
  let buffer = "";
  return {
    push(chunk: string): string {
      buffer += chunk;
      if (hold === 0) {
        const out = redactor.redact(buffer);
        buffer = "";
        return out;
      }
      if (buffer.length <= hold) return "";
      const cut = buffer.length - hold;
      const prefix = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return redactor.redact(prefix);
    },
    flush(): string {
      const out = redactor.redact(buffer);
      buffer = "";
      return out;
    },
  };
}
