/**
 * What travels between the model setup routes and the setup card's form.
 *
 * `GET /api/admin/model-setup/models` lists the models the form may offer.
 * `POST /api/admin/model-setup` saves the first model. Neither shape carries a
 * credential: the list holds ids and names, the request holds model ids.
 */

/** The thinking levels the save route accepts; the form preselects `medium`. */
export type SetupThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** One chat model of a signed-in provider. */
export interface SetupModelChoice {
  readonly id: string;
  readonly name: string;
}

/** One signed-in provider with its chat models. */
export interface SetupModelProvider {
  readonly id: string;
  readonly models: readonly SetupModelChoice[];
}

/** The answer of `GET /api/admin/model-setup/models`. */
export interface SetupModelsAnswer {
  /** Only providers that have a credential stored or ambient. */
  readonly providers: readonly SetupModelProvider[];
  /** Whether config.json declares root, orchestrator, planner or worker already. */
  readonly existingVmodels: readonly string[];
  /** Whether the daemon is in setup mode, the only state the save route accepts. */
  readonly modelSetupRequired: boolean;
}

/** The body of `POST /api/admin/model-setup`. */
export interface SetupModelRequest {
  readonly provider: string;
  readonly model: string;
  /** Default `medium`. */
  readonly thinking?: SetupThinkingLevel;
  /** The two worker fields come together; leave both out for workers on the main model. */
  readonly workerProvider?: string;
  readonly workerModel?: string;
  /** Replace root, orchestrator, planner and worker when config.json already has them. */
  readonly force?: boolean;
}

/** The 200 answer of `POST /api/admin/model-setup`. */
export interface SetupModelSaved {
  readonly status: "saved";
  readonly vmodels: readonly string[];
  readonly roles: readonly string[];
  readonly root: string;
  readonly worker: string;
  readonly thinking: SetupThinkingLevel;
}
