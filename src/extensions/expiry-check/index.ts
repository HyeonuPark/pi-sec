import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { ExtensionContext } from "../context.ts";
import {
  DEFAULT_WARN_DAYS,
  ExpiryRegistryError,
  evaluateExpiry,
  parseRegistry,
  todayInZone,
  type DueEntry,
} from "./evaluate.ts";

/** What one call writes: the measured day, and the entries inside the window. */
export interface ExpiryReport {
  readonly registry: string;
  readonly today: string;
  readonly warnDaysDefault: number;
  readonly due: readonly DueEntry[];
}

export function formatReport(report: ExpiryReport): string {
  return JSON.stringify(report, null, 2);
}

function failure(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Measure one registry file and report the entries whose warning window has
 * been entered.
 *
 * The tool is read-only by construction: it opens one file named by the caller,
 * reads nothing else, writes nothing, and reaches no network. The same call on
 * the same file and day returns the same text, which is what its `replay: safe`
 * declares.
 *
 * `timeZone` is the harness time zone (`timezone` in config.json), read at call
 * time so a config reload lands on the next call. The default is the harness
 * default, UTC.
 */
export function createExpiryCheckTool(timeZone: () => string = () => "UTC") {
  return defineTool({
    name: "expiry_check",
    description:
      "Read a JSON expiry registry and report the entries inside their warning window. Returns JSON {registry, today, warnDaysDefault, due: []}; due is empty when nothing is close to expiry. Each entry field: expires_on (YYYY-MM-DD, required), warn_days_before (whole days, default warnDaysDefault or 30), note, renew. The registry may be an array of entries with a name, {entries: [...]}, or an object keyed by name. Read-only: it writes nothing and needs no secret.",
    parameters: obj(
      {
        registryPath: str({
          description: "Absolute path of the JSON registry file to read.",
        }),
        warnDaysDefault: opt(
          num({
            minimum: 0,
            description: `Warning window for entries that carry no warn_days_before. Default ${DEFAULT_WARN_DAYS}.`,
          }),
        ),
        today: opt(
          str({
            description:
              "Day to measure against, YYYY-MM-DD. Defaults to the date in the harness timezone (`timezone` in config.json).",
          }),
        ),
      },
    ),
    replay: "safe",
    execute: async (args) => {
      if (!isAbsolute(args.registryPath)) {
        return failure(`registryPath must be an absolute path: ${args.registryPath}`);
      }
      let text: string;
      try {
        text = await readFile(args.registryPath, "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failure(`cannot read registry ${args.registryPath}: ${reason}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failure(`registry ${args.registryPath} is not JSON: ${reason}`);
      }
      const today = args.today ?? todayInZone(Date.now(), timeZone());
      const warnDaysDefault = args.warnDaysDefault ?? DEFAULT_WARN_DAYS;
      try {
        const entries = parseRegistry(raw, args.registryPath);
        const due = evaluateExpiry(entries, { today, warnDaysDefault });
        return {
          output: [
            {
              type: "text" as const,
              text: formatReport({ registry: args.registryPath, today, warnDaysDefault, due }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof ExpiryRegistryError) return failure(error.message);
        throw error;
      }
    },
  });
}

/**
 * The bundled `expiry-check` extension: the measurement machine only.
 *
 * Which registry is watched, how often, and what happens when an entry comes
 * due all live outside this extension — in the workspace registry and in the
 * scheduler job that calls the tool. That split is the point of the design:
 * the machine knows a schema, not a site.
 *
 * Installed in the core phase, like `web`: it reads no harness state, so the
 * first request of a conversation can call it.
 */
export function createExpiryCheckExtension(context: ExtensionContext): Extension<ToolRegistration> {
  return defineExtension({
    name: "expiry-check",
    tools: [createExpiryCheckTool(() => context.getConfig().timezone)],
  });
}
