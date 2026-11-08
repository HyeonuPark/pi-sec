/**
 * Setup mode and the root vmodel check.
 *
 * A daemon whose `agent.vmodel` is empty has no root model yet. It runs in
 * setup mode: the web server answers, the chat write routes refuse with one
 * fixed sentence, and the first model is chosen on the web page or with
 * `pi-sec setup-model`. An `agent.vmodel` that names something is never setup
 * mode: a key the file does not declare, a missing prompt file or a model
 * outside the catalog still stop the boot, because a daemon with a broken model
 * would report ready and then fail every request.
 *
 * The boot and the configuration reload run the same check, so a file that
 * cannot boot is never applied to a running daemon either.
 */
import type { Config } from "../config/schema.ts";
import type { Paths } from "../runtime/paths.ts";
import { VmodelResolver } from "./vmodel.ts";

/** The sentence every chat write route answers with while no model is set. */
export const MODEL_NOT_CONFIGURED_MESSAGE =
  "No model is set up yet. Choose one on the web page, or run `pi-sec setup-model --provider <id> --model <id>` on the server and then load the configuration.";

/** Thrown by `resolveDefaultConversation` in setup mode; the server answers 409. */
export class ModelNotConfiguredError extends Error {
  constructor() {
    super(MODEL_NOT_CONFIGURED_MESSAGE);
    this.name = "ModelNotConfiguredError";
  }
}

/** Whether the config names no root vmodel. The empty value alone decides it. */
export function isModelSetupMode(config: Config): boolean {
  return config.agent.vmodel.trim() === "";
}

/**
 * Why the root vmodel the config names cannot be used, or `undefined` when it can.
 *
 * `defaultConfig()` ships no alias, so a file that names no root model is a file
 * with no root model. The message names the keys the file does declare, because
 * the fix is one word in `config.json`.
 */
export function rootVmodelProblem(config: Config): string | undefined {
  const wanted = config.agent.vmodel;
  const known = Object.keys(config.vmodels);
  const list = known.join(", ") || "(none)";
  if (wanted.trim() === "") {
    return `config.json must name one of the vmodels keys in agent.vmodel, and it names none. Known vmodel keys: ${list}`;
  }
  if (!Object.hasOwn(config.vmodels, wanted)) {
    return `config.json names agent.vmodel "${wanted}", which is not a vmodels key. Known vmodel keys: ${list}`;
  }
  return undefined;
}

export type RootCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `vmodel` for the key, the prompt file and the role files; `catalog` for the model. */
      readonly kind: "vmodel" | "catalog";
      readonly problem: string;
      readonly model?: { readonly provider: string; readonly modelId: string };
    };

/**
 * The checks the boot and the reload run on a config.
 *
 * Setup mode passes the vmodel steps and still reads the root role files. Every
 * other problem is returned as a sentence, never thrown.
 */
export async function checkRootVmodel(
  config: Config,
  paths: Paths,
  models: { getModel(provider: string, modelId: string): unknown },
): Promise<RootCheck> {
  const resolver = new VmodelResolver({ getConfig: () => config, paths });
  if (isModelSetupMode(config)) {
    try {
      await resolver.rolesText(config.agent.roles);
    } catch (error) {
      return { ok: false, kind: "vmodel", problem: String(error) };
    }
    return { ok: true };
  }
  const problem = rootVmodelProblem(config);
  if (problem !== undefined) return { ok: false, kind: "vmodel", problem };
  let resolved;
  try {
    resolved = await resolver.resolve(config.agent.vmodel);
    await resolver.rolesText(config.agent.roles);
  } catch (error) {
    return { ok: false, kind: "vmodel", problem: String(error) };
  }
  if (models.getModel(resolved.model.provider, resolved.model.modelId) === undefined) {
    return {
      ok: false,
      kind: "catalog",
      problem: `the root model ${resolved.model.provider}/${resolved.model.modelId} is not in the catalog`,
      model: resolved.model,
    };
  }
  return { ok: true };
}
