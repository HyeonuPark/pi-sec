/**
 * The parser of the `env` file of the secret store: one `KEY=value` per line.
 *
 * This module imports nothing at run time, so the tree scanner in `scripts/`
 * can import it and read `env` with the same rule as the daemon registry.
 */
import type { SecretValue } from "./redact.ts";

/**
 * Parse an optional `env` file of `KEY=value` lines. Malformed lines are warned
 * and skipped. A warning names a malformed line by its number and never quotes
 * it, because the line can hold a secret value that no entry registers.
 */
export function parseEnvFile(text: string, onWarning?: (message: string) => void): SecretValue[] {
  const out: SecretValue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      onWarning?.(`secrets env: ignoring malformed line ${index + 1}`);
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
