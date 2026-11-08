/**
 * The first model from the web page (two routes).
 *
 * `GET /api/admin/model-setup/models` lists the chat models of the providers
 * that are signed in. `POST /api/admin/model-setup` writes the first model into
 * `config.json` the way `pi-sec setup-model` does and loads the configuration,
 * in setup mode only. Neither route changes a credential.
 *
 * The save holds one in-process lock from the setup-mode check to the end of the
 * configuration load, so two saves cannot both write: the second waits, finds
 * setup mode over, and gets 409 `model_already_configured`.
 *
 * The route adds no HTTPS rule. The login start has one because its sign-in
 * proof must not cross a network in the clear; this body holds model ids only.
 */
import { defaultPromptDir, PromptFiles } from "../../agent/vmodel.ts";
import { isModelSetupMode } from "../../agent/model-setup.ts";
import {
  buildSetupModelPlan,
  firstModelOutsideCatalog,
  SETUP_MODEL_PROMPT,
  SETUP_MODEL_VMODELS,
  THINKING_LEVELS,
  writeSetupModel,
  type ThinkingLevel,
} from "../../config/write.ts";
import { readFile } from "node:fs/promises";
import type { SetupModelProvider, SetupModelsAnswer, SetupModelSaved } from "../../shared/wire/model-setup.ts";
import type { AppDeps } from "../deps.ts";
import { reloadConfigAndRoot } from "../config-reload.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** The names of the four vmodels the file declares now, read from disk. */
async function declaredVmodels(configFile: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await readFile(configFile, "utf8")).replace(/^\uFEFF/, ""));
    const vmodels = bodyObject(bodyObject(parsed)?.vmodels);
    return vmodels === undefined ? [] : SETUP_MODEL_VMODELS.filter((name) => Object.hasOwn(vmodels, name));
  } catch {
    return [];
  }
}

export function registerModelSetup(router: Router, deps: AppDeps): void {
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = lock.then(work, work);
    lock = run.catch(() => undefined);
    return run;
  };

  router.get("/api/admin/model-setup/models", async (route) => {
    const state = await deps.runtime.modelLogin.providers();
    const providers: SetupModelProvider[] = [];
    for (const provider of state.providers) {
      if (!provider.configured) continue;
      providers.push({
        id: provider.id,
        models: deps.runtime.models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name })),
      });
    }
    const answer: SetupModelsAnswer = {
      providers,
      existingVmodels: await declaredVmodels(deps.runtime.paths.configFile),
      modelSetupRequired: isModelSetupMode(deps.runtime.getConfig()),
    };
    json(route.res, 200, answer);
  });

  const save = async (route: RouteContext): Promise<void> => {
    // Step 2: the limit of this form. The check runs again inside the lock.
    if (!isModelSetupMode(deps.runtime.getConfig())) {
      apiError(
        route.res,
        409,
        "model_already_configured",
        "a model is already set up; change it with `pi-sec setup-model --force` on the server or edit config.json",
        route.requestId,
      );
      return;
    }

    // Step 3: the same checks the command makes on its options.
    const body = bodyObject(route.body);
    const text = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() : undefined);
    const provider = text(body?.provider) ?? "";
    const modelId = text(body?.model) ?? "";
    if (provider === "" || modelId === "") {
      apiError(route.res, 400, "invalid_request", "provider and model are required", route.requestId);
      return;
    }
    const thinking = body?.thinking === undefined ? "medium" : text(body.thinking);
    if (thinking === undefined || !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
      apiError(
        route.res,
        400,
        "invalid_request",
        `unknown thinking level; choose one of: ${THINKING_LEVELS.join(", ")}`,
        route.requestId,
      );
      return;
    }
    const workerProvider = body?.workerProvider === undefined ? undefined : text(body.workerProvider);
    const workerModel = body?.workerModel === undefined ? undefined : text(body.workerModel);
    if (
      (body?.workerProvider === undefined) !== (body?.workerModel === undefined) ||
      workerProvider === "" ||
      workerModel === "" ||
      (body?.workerProvider !== undefined && workerProvider === undefined) ||
      (body?.workerModel !== undefined && workerModel === undefined)
    ) {
      apiError(
        route.res,
        400,
        "invalid_request",
        "workerProvider and workerModel go together, and both name a value",
        route.requestId,
      );
      return;
    }
    if (body?.force !== undefined && typeof body.force !== "boolean") {
      apiError(route.res, 400, "invalid_request", "force must be true or false", route.requestId);
      return;
    }
    const input = { provider, modelId, workerProvider, workerModel };

    // Step 4: a model outside the catalog and a missing prompt file both refuse,
    // so the route never writes a configuration that cannot boot.
    const outside = firstModelOutsideCatalog(deps.runtime.models, input);
    if (outside !== undefined) {
      apiError(
        route.res,
        400,
        "model_not_in_catalog",
        `the ${outside.label} model ${outside.provider}/${outside.modelId} is not in the catalog; nothing was written`,
        route.requestId,
      );
      return;
    }
    const prompts = new PromptFiles([deps.runtime.paths.promptsDir, defaultPromptDir()]);
    if ((await prompts.locate("vmodel", SETUP_MODEL_PROMPT)) === undefined) {
      apiError(
        route.res,
        409,
        "prompt_missing",
        `no prompts/vmodel/${SETUP_MODEL_PROMPT}.md in this install; nothing was written`,
        route.requestId,
      );
      return;
    }
    if (deps.reloadConfig === undefined) {
      apiError(route.res, 500, "reload_unavailable", "this daemon cannot load a configuration; nothing was written", route.requestId);
      return;
    }

    // Step 5: the command's own plan and writer.
    const outcome = await writeSetupModel(
      deps.runtime.paths.configFile,
      buildSetupModelPlan({
        provider,
        modelId,
        thinking: thinking as ThinkingLevel,
        workerProvider,
        workerModel,
        force: body?.force === true,
      }),
    );
    if (outcome.status === "refused") {
      deps.runtime.audit.append({ type: "model_setup", provider, model: modelId, outcome: "refused" });
      apiError(route.res, 409, "write_refused", `${outcome.reason}; nothing was written`, route.requestId);
      return;
    }

    // Step 6: the configuration part of the reload, with no extension reload.
    const reloaded = await reloadConfigAndRoot(deps);
    // Step 7: one audit row. Ids only, never a credential.
    deps.runtime.audit.append({
      type: "model_setup",
      provider,
      model: modelId,
      ...(workerProvider === undefined ? {} : { workerProvider, workerModel }),
      thinking,
      outcome: reloaded.ok ? "saved" : "written_not_applied",
    });
    if (!reloaded.ok) {
      apiError(
        route.res,
        409,
        "config_not_applied",
        `config.json was written but the daemon did not apply it and stays in setup mode: ${reloaded.issues.join("; ")}`,
        route.requestId,
      );
      return;
    }
    const answer: SetupModelSaved = {
      status: "saved",
      vmodels: outcome.vmodels,
      roles: outcome.roles,
      root: `${provider}/${modelId}`,
      worker: `${workerProvider ?? provider}/${workerModel ?? modelId}`,
      thinking: thinking as ThinkingLevel,
    };
    json(route.res, 200, answer);
  };

  router.post("/api/admin/model-setup", async (route) => {
    // Step 1: a cross-site form cannot send a JSON content type.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }
    await exclusive(() => save(route));
  });
}
