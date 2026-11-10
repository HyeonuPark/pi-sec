/**
 * The configuration half of a reload: read `config.json`, check the root
 * vmodel the way the boot does, apply the config, and prepare the root.
 *
 * `POST /api/admin/reload` runs this after it reloads the extensions, and the
 * model setup save route runs it alone, because a save changes no extension.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { checkRootVmodel, isModelSetupMode } from "../agent/model-setup.ts";
import { resolveDefaultConversation } from "../agent/conversation.ts";
import { syncRootRecord } from "../agent/root-record.ts";
import type { AgentRuntime } from "../agent/harness.ts";
import { ConfigError, loadConfig } from "../config/load.ts";
import type { AppDeps } from "./deps.ts";

/** The new config loaded, and its root vmodel cannot be used. The running config stays. */
export class RootCheckError extends Error {
  readonly problem: string;
  constructor(problem: string) {
    super(problem);
    this.problem = problem;
    this.name = "RootCheckError";
  }
}

/**
 * The function `AppDeps.reloadConfig` holds in the daemon.
 *
 * The new config is applied only when the boot's root checks pass on it. A
 * config that fails them throws `RootCheckError` and the running config stays,
 * so a daemon in setup mode stays in setup mode.
 */
export function createConfigReloader(options: {
  readonly home: string;
  readonly runtime: Pick<AgentRuntime, "setConfig" | "paths" | "models">;
}): () => Promise<void> {
  return async () => {
    const next = await loadConfig({ home: options.home });
    const check = await checkRootVmodel(next.config, options.runtime.paths, options.runtime.models);
    if (!check.ok) throw new RootCheckError(check.problem);
    options.runtime.setConfig(next.config);
  };
}

export type ConfigReloadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/**
 * Load and apply the config, then prepare the root conversation.
 *
 * A failure is recorded (the admin notes, the log, the audit log and the event
 * the page reads) and returned as sentences. The running config is the one that
 * was live before the call. A root that cannot be prepared after the config
 * applied, or whose agent record cannot be updated, is a note, not a failed reload.
 */
export async function reloadConfigAndRoot(deps: AppDeps): Promise<ConfigReloadResult> {
  if (deps.reloadConfig === undefined) return { ok: true };
  try {
    await deps.reloadConfig();
  } catch (error) {
    const issues =
      error instanceof ConfigError ? [...error.issues] : error instanceof RootCheckError ? [error.problem] : [String(error)];
    deps.adminState.configError = { at: Date.now(), issues };
    deps.adminState.notes.add(`config reload failed: ${issues.join("; ")}`);
    deps.runtime.logger.error("config reload failed", { issues });
    deps.runtime.audit.append({ type: "config_reload_failed", issues });
    deps.runtime.events.emit("config_reload_failed", { issues });
    return { ok: false, issues };
  }
  deps.adminState.configError = undefined;
  // The chat page's `GET` routes read the root conversation and never write to
  // it, so the new model, thinking level, instructions and tool filter have to be
  // applied here. Setup mode has no root to prepare.
  if (isModelSetupMode(deps.runtime.getConfig())) return { ok: true };
  try {
    await resolveDefaultConversation(deps.runtime.harness, deps.runtime.getConfig(), deps.runtime.paths, BACKGROUND_CONTEXT);
  } catch (error) {
    // The config itself loaded, so this is a note and not a failed reload.
    const reason = error instanceof Error ? error.message : String(error);
    deps.runtime.logger.warn("root reconfigure after reload failed", { error });
    deps.adminState.notes.add(`root reconfigure after reload failed: ${reason}`);
    return { ok: true };
  }
  // The prompt sections read the root's agent record, not the config, so the
  // record follows the reload as it follows a boot. A running session keeps its
  // sealed prompt, and the new roles and vmodel reach the next session.
  try {
    await syncRootRecord(deps.runtime.harness, deps.runtime.getConfig(), BACKGROUND_CONTEXT);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.runtime.logger.warn("root record update after reload failed", { error });
    deps.adminState.notes.add(`root record update after reload failed: ${reason}`);
  }
  return { ok: true };
}
