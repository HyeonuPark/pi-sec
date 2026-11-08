import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { ConfigSchema, defaultConfig, REGISTRY_ROOT_DEFAULT, type Config } from "./schema.ts";
import { resolveHome, underHome } from "../runtime/paths.ts";
import { describeBasePathProblem, trustedProxyProblems } from "../server/proxy.ts";
import { parseCron } from "../extensions/scheduler.ts";
import { requireTimeZone } from "../jobs/routine.ts";

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cron problems the schema cannot see.
 *
 * `scheduler.jobs[].schedule` used to be parsed only when its job came due, and
 * the reconciler answers a failure there with one `warn` line and moves on. So a
 * typo disabled a job in silence: the process started, the screen showed
 * nothing, and `stats.runs` staying at 0 was the only clue. A configuration that
 * cannot work has to say so at load, and the parser that will run at each tick is
 * the one that says it here — one parser, so the two cannot drift.
 */
function scheduleProblems(jobs: unknown): string[] {
  if (!Array.isArray(jobs)) return [];
  const problems: string[] = [];
  jobs.forEach((job: unknown, index: number) => {
    const expression = isPlainObject(job) ? job["schedule"] : undefined;
    // A missing or non-string value is the schema's to report, not this one's.
    if (typeof expression !== "string") return;
    try {
      parseCron(expression);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`/scheduler/jobs/${index}/schedule ${message}`);
    }
  });
  return problems;
}

/**
 * A time zone the schema cannot judge.
 *
 * `timezone` is a string to the schema, and an unresolvable name would reach
 * every reader — the restart notice, `expiry_check`, the page stamp, the
 * preamble — and format the wrong clock in each. The check is the one routines
 * already use (`requireTimeZone`), so a name accepted here is a name the
 * scheduler accepts too.
 */
function timezoneProblems(timezone: unknown): string[] {
  if (typeof timezone !== "string") return [];
  try {
    requireTimeZone(timezone, "/timezone");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [message];
  }
  return [];
}

/**
 * Problems the schema cannot see, one line each.
 *
 * `githubPr` is an optional top-level key, so the schema accepts a config that
 * leaves it out whatever the enabled list says. The one condition here is the
 * combination the shape of a single value cannot express: the enabled list names
 * `github-pr` and the key is absent. That config cannot work, because the
 * extension is installed with no repositories and no write switch, so it would
 * answer 403 for every write and show nothing.
 *
 * The key is left alone while the extension is off: its values are then unused,
 * and refusing a config over an unused key would block a boot for nothing.
 *
 * Two `repos` entries that differ only in case are not a problem. They name one
 * repository to GitHub, and GitHub compares the two parts of a name without
 * regard to case, so the extension folds them into one when it reads them. The
 * loader does not rewrite the list: the operator's own spelling is what the file
 * says, and one reader of the fold is enough.
 */
function githubPrProblems(config: { agent?: { extensions?: { enabled?: unknown } }; githubPr?: unknown }): string[] {
  const enabled = Array.isArray(config.agent?.extensions?.enabled) ? config.agent.extensions.enabled : [];
  if (!enabled.includes("github-pr")) return [];
  if (config.githubPr === undefined || config.githubPr === null) {
    return [
      "/githubPr is required while agent.extensions.enabled names github-pr: " +
        "the extension has no repositories and no write switch without it",
    ];
  }
  return [];
}

/**
 * The same check for `linear`: an enabled extension with no `linear` key has no
 * secret to read and no write switch, so every call would refuse. The key is left
 * alone while the extension is off.
 */
function linearProblems(config: { agent?: { extensions?: { enabled?: unknown } }; linear?: unknown }): string[] {
  const enabled = Array.isArray(config.agent?.extensions?.enabled) ? config.agent.extensions.enabled : [];
  if (!enabled.includes("linear")) return [];
  if (config.linear === undefined || config.linear === null) {
    return [
      "/linear is required while agent.extensions.enabled names linear: " +
        "the extension has no secret to read and no write switch without it",
    ];
  }
  return [];
}

/**
 * Problems with `remoteMachines` that the schema cannot see, one line each.
 *
 * Every value of the key is a valid string to the schema, and two shapes of the
 * key make a configuration that cannot work:
 *
 *   - Two machines with one name. The name keys the stored level and the pinned
 *     host key, so two machines that share one would share both: the slider of one
 *     would set the level of the other, and a key pinned for one would be the key
 *     both are checked against. This is a property of the list and not of one
 *     entry, which is why no schema can express it.
 *   - A pi-sec home whose ssh socket path does not fit in a unix socket. The socket
 *     name is 16 characters under `<home>/run/ssh/`, and ssh first binds a temporary
 *     name 17 bytes longer than the path it was given, which leaves the limit at
 *     `MAX_SSH_SOCKET_PATH` bytes. A longer home makes every connection fail with a
 *     message about a path nobody would think to look at. The refusal here names the
 *     home.
 *
 * Both are refused at load, which is this repository's rule for a value that would
 * silently disable what it configures: the running daemon keeps the previous
 * config and says what is wrong with the new one.
 */
function remoteMachinesProblems(config: { remoteMachines?: { machines?: unknown } }, home: string): string[] {
  const machines = config.remoteMachines?.machines;
  if (!Array.isArray(machines)) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  machines.forEach((machine: unknown, index: number) => {
    const id = isPlainObject(machine) ? machine["id"] : undefined;
    // A missing or non-string id is the schema's to report, not this one's.
    if (typeof id !== "string") return;
    if (seen.has(id)) {
      problems.push(
        `/remoteMachines/machines/${index}/id names the machine "${id}" twice: ` +
          "a name keys the stored level and the pinned host key, so two machines cannot share one",
      );
      return;
    }
    seen.add(id);
  });

  if (machines.length > 0) {
    // The layout `src/runtime/paths.ts` builds: `<home>/run/ssh/<16 hex>`.
    const socketPath = `${home.replace(/\/+$/, "")}/run/ssh/${"0".repeat(16)}`;
    if (socketPath.length > MAX_SSH_SOCKET_PATH) {
      problems.push(
        `/remoteMachines cannot work under this home: an ssh connection's socket path would be ` +
          `${socketPath.length} bytes (${socketPath}), and it may be at most ${MAX_SSH_SOCKET_PATH}: ` +
          "a unix socket path holds 107 bytes, and ssh first binds a temporary name 17 bytes longer. " +
          "Move the pi-sec home somewhere shorter.",
      );
    }
  }
  return problems;
}

/**
 * The longest ssh socket path this feature builds, in bytes.
 *
 * A unix socket path holds 107 bytes, and its terminator is not part of that count.
 * OpenSSH does not bind the `ControlPath` it is given: it first binds a temporary
 * name of that path plus `.` and 16 random characters, which is 17 bytes longer, so
 * a `ControlPath` of more than 107 - 17 = 90 bytes fails before any connection is
 * made.
 */
const MAX_SSH_SOCKET_PATH = 90;

/** Deep-merge `override` over `base`; arrays and scalars replace wholesale. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject((base as Record<string, unknown>)[key])
      ? deepMerge((base as Record<string, unknown>)[key], value)
      : value;
  }
  return result as T;
}

/** Parse a `PI_SEC_*` value; JSON where possible, otherwise the raw string. */
function parseEnvValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * The key names of an object schema, for folding an environment variable's
 * segments onto the config's own names.
 */
function schemaKeys(schema: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(schema)) return undefined;
  const properties = schema["properties"];
  return isPlainObject(properties) ? properties : undefined;
}

const CONFIG_KEYS = schemaKeys(ConfigSchema);

/**
 * Fold `segments` onto the config's key names, ignoring case.
 *
 * The keys are camelCase and environment variables are conventionally
 * upper-case, so a literal reading of `PI_SEC_SERVER__BASEPATH` produced
 * `server.basepath`, which the schema then rejected as an unknown key. Names are
 * matched against the schema instead, so the documented form works — including
 * for an optional key that has no default, such as `server.publicUrl`.
 *
 * A segment that matches nothing is kept **as written**: the merged config then
 * fails the schema, which is the loud answer a typo deserves, and the odd-case
 * path in the error is the hint that it came from the environment rather than
 * from `config.json`.
 */
function resolveEnvPath(segments: readonly string[]): string[] {
  const path: string[] = [];
  let level: Record<string, unknown> | undefined = CONFIG_KEYS;
  for (const segment of segments) {
    const keys = level === undefined ? undefined : Object.keys(level);
    const match = keys?.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (level === undefined || match === undefined) {
      path.push(segment);
      level = undefined;
      continue;
    }
    path.push(match);
    level = schemaKeys(level[match]);
  }
  return path;
}

/** Build a nested override object from `PI_SEC_*` variables (`__` nests). */
export function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PI_SEC_") || value === undefined) continue;
    // Not config keys, and each would fail the schema as an unknown one: the home,
    // a scratch directory, and the flag `user-tools/run` sets on the daemon it
    // supervises so the restart route ends the process instead of asking a unit.
    if (key === "PI_SEC_HOME" || key === "PI_SEC_PRIVATE_TMP" || key === "PI_SEC_RUNNER") continue;
    const segments = key.slice("PI_SEC_".length).split("__").filter((segment) => segment !== "");
    if (segments.length === 0) continue;

    const path = resolveEnvPath(segments);
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i]!;
      const next = cursor[segment];
      if (!isPlainObject(next)) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = parseEnvValue(value);
  }
  return root;
}

export interface LoadConfigOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Highest-precedence overrides, e.g. CLI flags. */
  readonly overrides?: Record<string, unknown>;
  /** When false, a missing config file is fine (still returns defaults). */
  readonly required?: boolean;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly source: "defaults" | "file";
  readonly home: string;
}

/** Rewrite default control-structure paths so `PI_SEC_HOME` relocates everything. */
export function applyHomeDefaults(config: Config, home: string): Config {
  return {
    ...config,
    code: {
      snapshot: underHome(config.code.snapshot, home),
      workspace: underHome(config.code.workspace, home),
    },
    agent: { ...config.agent, workspace: underHome(config.agent.workspace, home) },
    auth: {
      authPath: underHome(config.auth.authPath, home),
      modelsPath: underHome(config.auth.modelsPath, home),
    },
    secrets: {
      ...config.secrets,
      dir: underHome(config.secrets.dir, home),
      modelCredentialPaths: config.secrets.modelCredentialPaths.map((path) => underHome(path, home)),
    },
    // The registry root is the one path of the registry, and every other path
    // under it is derived from this value. A config that names no `registry`
    // key gets the default root here, so a caller never sees a relative one.
    registry: {
      ...config.registry,
      root: underHome(config.registry?.root ?? REGISTRY_ROOT_DEFAULT, home),
    },
  };
}

/** Read, merge, and validate `config.json`. Fail closed on invalid config. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveHome(env);
  const configFile = `${home}/config.json`;

  let fileValue: unknown = {};
  let source: "defaults" | "file" = "defaults";
  try {
    const text = await readFile(configFile, "utf8");
    fileValue = JSON.parse(text) as unknown;
    source = "file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new ConfigError(`cannot read ${configFile}: ${String(error)}`);
    }
    if (options.required) throw new ConfigError(`missing config file ${configFile}`);
  }

  const merged = deepMerge(
    deepMerge(defaultConfig(), fileValue),
    deepMerge(envOverrides(env), options.overrides ?? {}),
  );

  // Schema defaults fill a value the file left out of an object it did declare.
  // `Value.Default` is the only reader of the `default` keyword. Three keys carry
  // one: the two `githubPr` numbers, and the three `remoteMachines` values, so
  // this line changes nothing for a config that names neither key.
  Value.Default(ConfigSchema, merged);

  const errors = [...Value.Errors(ConfigSchema, merged)].map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );

  // The schema cannot express these: each is a valid string, and each silently
  // disables what it configures when it is wrong — a mount that redirects to
  // nowhere, a proxy list that trusts no one, a cron job that never fires, a time
  // zone no reader can resolve. Failing here rather than accepting them is the
  // whole point: a configuration that cannot work should say so at load, not
  // weeks later.
  const server = (merged as { server?: { basePath?: string; trustedProxies?: string[] } }).server ?? {};
  const basePathProblem = describeBasePathProblem(server.basePath);
  if (basePathProblem !== undefined) errors.push(basePathProblem);
  errors.push(...trustedProxyProblems(server.trustedProxies ?? []));
  errors.push(...scheduleProblems((merged as { scheduler?: { jobs?: unknown } }).scheduler?.jobs));
  errors.push(...timezoneProblems((merged as { timezone?: unknown }).timezone));
  errors.push(
    ...githubPrProblems(
      merged as { agent?: { extensions?: { enabled?: unknown } }; githubPr?: unknown },
    ),
  );
  errors.push(
    ...linearProblems(merged as { agent?: { extensions?: { enabled?: unknown } }; linear?: unknown }),
  );
  errors.push(...remoteMachinesProblems(merged as { remoteMachines?: { machines?: unknown } }, home));

  if (errors.length > 0) {
    throw new ConfigError(`invalid config in ${configFile}`, errors);
  }

  return { config: applyHomeDefaults(merged as Config, home), source, home };
}

/** Build the default config document, for `pi-sec config --default`. */
export function renderDefaultConfig(): string {
  return `${JSON.stringify(defaultConfig(), null, 2)}\n`;
}
