/**
 * Writing the first model configuration into `config.json`.
 *
 * `pi-sec setup-model` is the one command that edits the control structure's
 * configuration file, so the edit is narrow on purpose: it adds the four
 * vmodels every install needs and the two agent keys that point at them, and it
 * copies every other key through untouched. A key the file does not have stays
 * absent rather than being written out at its default, because a default copied
 * into the file stops following the default.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { deepMerge } from "./load.ts";
import { ConfigSchema, defaultConfig, type VmodelConfig } from "./schema.ts";

/** The vmodels this command writes, in the order it writes them. */
export const SETUP_MODEL_VMODELS = ["root", "orchestrator", "planner", "worker"] as const;

/** The roles the root agent gets when its role list is empty. */
export const SETUP_MODEL_ROOT_ROLES = ["root-agent", "user-facing-agent"] as const;

/** The shipped prompt file a vmodel written here names. */
export const SETUP_MODEL_PROMPT = "default";

/** The thinking levels `setup-model` and the web form accept. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SetupModelInput {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: ThinkingLevel;
  /** Both worker fields come together; none means workers use the main model. */
  readonly workerProvider?: string | undefined;
  readonly workerModel?: string | undefined;
  readonly force: boolean;
}

/**
 * The plan `pi-sec setup-model` and the web save route both hand to
 * `writeSetupModel`, so one input leaves the same bytes whichever one wrote.
 */
export function buildSetupModelPlan(input: SetupModelInput): SetupModelPlan {
  const entry = (provider: string, modelId: string): VmodelConfig => ({
    provider,
    modelId,
    thinkingLevel: input.thinking,
    prompt: SETUP_MODEL_PROMPT,
  });
  return {
    root: entry(input.provider, input.modelId),
    worker: entry(input.workerProvider ?? input.provider, input.workerModel ?? input.modelId),
    force: input.force,
  };
}

/**
 * The first model of the input that the catalog does not hold, or `undefined`.
 * The root model is checked before the worker model.
 */
export function firstModelOutsideCatalog(
  catalog: { getModel(provider: string, modelId: string): unknown },
  input: Pick<SetupModelInput, "provider" | "modelId" | "workerProvider" | "workerModel">,
): { readonly label: "root" | "worker"; readonly provider: string; readonly modelId: string } | undefined {
  const wanted: { label: "root" | "worker"; provider: string; modelId: string }[] = [
    { label: "root", provider: input.provider, modelId: input.modelId },
  ];
  if (input.workerProvider !== undefined && input.workerModel !== undefined) {
    wanted.push({ label: "worker", provider: input.workerProvider, modelId: input.workerModel });
  }
  return wanted.find((want) => catalog.getModel(want.provider, want.modelId) === undefined);
}

export interface SetupModelPlan {
  /** The model the root, the orchestrator and the planner use. */
  readonly root: VmodelConfig;
  /** The model workers use; equal to `root` when the command was given none. */
  readonly worker: VmodelConfig;
  /** Overwrite vmodels that already exist. Without it the command refuses. */
  readonly force: boolean;
}

export type SetupModelOutcome =
  | { readonly status: "written"; readonly vmodels: string[]; readonly roles: string[] }
  | { readonly status: "refused"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema problems of one finished document, checked before it replaces the file. */
function documentProblems(value: unknown): string[] {
  const merged = deepMerge(defaultConfig(), value);
  return [...Value.Errors(ConfigSchema, merged)].map((error) => `${error.instancePath || "/"} ${error.message}`);
}

async function readConfigText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Write one document over `path` in a way that leaves the old bytes or the new
 * ones: a dot-named temporary file beside it, flushed, then renamed.
 */
async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.config.json`);
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Write the four vmodels and the two agent keys.
 *
 * Nothing is written when the plan is refused: an existing vmodel without
 * `--force`, a document that cannot be parsed, or a result the schema would
 * reject. The file is untouched in each of those cases.
 */
export async function writeSetupModel(configFile: string, plan: SetupModelPlan): Promise<SetupModelOutcome> {
  const text = await readConfigText(configFile);
  let document: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    } catch {
      return { status: "refused", reason: `${configFile} is not valid JSON` };
    }
    if (!isRecord(parsed)) return { status: "refused", reason: `${configFile} does not hold a JSON object` };
    document = parsed;
  }

  const vmodels = isRecord(document.vmodels) ? { ...document.vmodels } : {};
  const alreadyThere = SETUP_MODEL_VMODELS.filter((name) => Object.hasOwn(vmodels, name));
  if (alreadyThere.length > 0 && !plan.force) {
    const names = alreadyThere.map((name) => `"${name}"`).join(", ");
    return {
      status: "refused",
      reason: `${configFile} already defines the vmodel ${names}; pass --force to overwrite it`,
    };
  }

  const agent = isRecord(document.agent) ? { ...document.agent } : {};
  const roles =
    Array.isArray(agent.roles) && agent.roles.length > 0 ? (agent.roles as string[]) : [...SETUP_MODEL_ROOT_ROLES];

  const next: Record<string, unknown> = {
    ...document,
    // The planner starts as a copy of the orchestrator: the same provider, model
    // and thinking level, so the two can be moved apart later by editing one key.
    vmodels: { ...vmodels, root: plan.root, orchestrator: plan.root, planner: plan.root, worker: plan.worker },
    agent: { ...agent, vmodel: "root", roles },
  };

  const problems = documentProblems(next);
  if (problems.length > 0) {
    return { status: "refused", reason: `the result would not be a valid config: ${problems.join("; ")}` };
  }

  await writeAtomically(configFile, `${JSON.stringify(next, null, 2)}\n`);
  return { status: "written", vmodels: [...SETUP_MODEL_VMODELS], roles };
}
