import { defineExtension, defineTool, GenerationTask, hook, section, ToolTask, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "./context.ts";
import type { Redactor } from "../secrets/redact.ts";

/** Recursively redact every string in a JSON-ish value. */
export function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, redact);
    return out;
  }
  return value;
}

/** A diagnostic tool: report which secret names are registered (never values). */
export function createSecretNamesTool(context: ExtensionContext) {
  return defineTool({
    name: "secrets_list",
    description: "List the names of registered secrets. Values are never available; read the file to use one.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => ({
      output: [{ type: "text" as const, text: context.secrets.names().join("\n") || "(none)" }],
    }),
  });
}

/**
 * The bundled `secrets` extension: the one-way redaction boundary (hooks and a
 * system-prompt section). The environment wrapper lives in `agent/env.ts`.
 */
export function createSecretsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const redactor = (): Redactor => context.secrets.redactor();

  const namesSection = section("secrets", () => {
    const names = context.secrets.names();
    const list = names.length > 0 ? names.join(", ") : "(none registered)";
    return `Secrets are stored as files under ${context.paths.secretsDir}/<name> and are redacted from everything you read.
The redaction is irreversible; you can never see or recover a value.
To use a secret, write a command or script that reads the file yourself, for example:
    TOKEN=$(cat ${context.paths.secretsDir}/gh_token)
    curl -H "Authorization: Bearer $TOKEN" https://api.github.com/user
Do not pass a placeholder such as \u27e6secret:name\u27e7 as a value; it is not resolved. Read the file instead.
Output you produce that contains a secret will be redacted before you see it again, so printing it is useless.
Available secret names: ${list}`;
  });

  return defineExtension({
    name: "secrets",
    sections: [namesSection],
    tools: [createSecretNamesTool(context)],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => ({
          messages: request.messages.map((message) => redactValue(message, redactor().redact) as Message),
        }),
      }),
      hook(ToolTask, {
        afterTool: (_call, result) => redactValue(result, redactor().redact) as typeof result,
      }),
    ],
  });
}
