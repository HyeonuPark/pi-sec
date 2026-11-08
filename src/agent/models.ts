import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";
import { ModelCredentialStore, type ModelCredentialLog } from "../secrets/model-credentials.ts";
import { createSyntheticCatalog, type SyntheticModelCatalog } from "./synthetic-catalog.ts";
import { SYNTHETIC_PROVIDER_ID, syntheticProviderConfig } from "./synthetic-provider.ts";

/**
 * Where the synthetic.new model list lives and whether this runtime reads it.
 *
 * Without this setting the runtime registers the one model the code carries and
 * reads nothing, which is what a test and a one-off process want. The daemon
 * sets `network` and gets the stored list at boot plus a read every six hours.
 */
export interface SyntheticCatalogSettings {
  /** The state directory the last good answer is stored in. */
  readonly stateDir: string;
  /** Read the service at start and every interval. Default false. */
  readonly network?: boolean;
  /** The fetch to read with. Default: the process's own. */
  readonly fetch?: typeof fetch;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface CreateModelsOptions {
  readonly authPath: string;
  readonly modelsPath?: string | null;
  /** Allow a network catalog refresh while creating. Default false. */
  readonly allowModelNetwork?: boolean;
  /**
   * The secret store directory. When set, credentials are read through
   * pi-sec's own store: `auth.json` names a secret file for each value, and
   * every write puts the value in that file. Without it, the library's default
   * store reads and writes values inline in `auth.json`.
   */
  readonly secretsDir?: string;
  /** Called after a credential write, so the secret registry reloads. */
  readonly onCredentialsChanged?: () => Promise<void> | void;
  readonly log?: ModelCredentialLog;
  /** Register synthetic.new's model list from `stateDir`. Absent: the one model. */
  readonly syntheticCatalog?: SyntheticCatalogSettings;
}

/** The catalog of a runtime this module built, for the daemon's shutdown. */
const catalogs = new WeakMap<ModelRuntime, SyntheticModelCatalog>();

/**
 * The synthetic.new catalog of one runtime, when it was built with a state
 * directory. The daemon calls `stop` on it before it exits.
 */
export function syntheticCatalogOf(models: ModelRuntime): SyntheticModelCatalog | undefined {
  return catalogs.get(models);
}

/**
 * pi-sec's own model runtime. Credentials and catalog come from
 * `~/.pi/sec/auth.json` and `~/.pi/sec/models.json`; the operator's
 * `~/.pi/agent` is never read.
 *
 * The return type is the runtime, not only its `Models` face: runtime
 * extensions register their providers through `registerProvider`,
 * `registerNativeProvider` and `unregisterProvider`, and the daemon needs that
 * surface next to the catalog.
 *
 * pi-sec's own provider is registered here rather than next to one caller. The
 * daemon, the model login panel and the one-shot commands all build their
 * runtime through this function, and a registration placed in `cli.ts` would
 * only reach the paths that boot the daemon.
 *
 * The registration is finished before this function returns, because the daemon
 * checks the root vmodel against the catalog on the next line. What the
 * registration holds is the stored model list, or the fallback model when there
 * is none; with `network` set, the read of the service's list starts after that
 * and replaces the list when it succeeds.
 */
export async function createModels(options: CreateModelsOptions): Promise<ModelRuntime> {
  let catalog: SyntheticModelCatalog | undefined;
  const models = await ModelRuntime.create({
    authPath: options.authPath,
    modelsPath: options.modelsPath ?? null,
    allowModelNetwork: options.allowModelNetwork ?? false,
    ...(options.secretsDir === undefined
      ? {}
      : {
          credentials: new ModelCredentialStore({
            authPath: options.authPath,
            secretsDir: options.secretsDir,
            onChange: async (providerId: string) => {
              await options.onCredentialsChanged?.();
              // A key that the login panel has just stored is the one thing a
              // list read waited for: read now instead of at the next interval.
              if (providerId === SYNTHETIC_PROVIDER_ID) void catalog?.refresh();
            },
            log: options.log,
          }),
        }),
  });
  // Before the caller reads the catalog: the panel lists this provider, and a
  // vmodel may name its model, which the runtime refuses until it is known.
  if (options.syntheticCatalog === undefined) {
    models.registerProvider(SYNTHETIC_PROVIDER_ID, syntheticProviderConfig());
    return models;
  }
  catalog = createSyntheticCatalog({
    models,
    stateDir: options.syntheticCatalog.stateDir,
    log: options.log,
    ...(options.syntheticCatalog.fetch === undefined ? {} : { fetch: options.syntheticCatalog.fetch }),
    ...(options.syntheticCatalog.intervalMs === undefined ? {} : { intervalMs: options.syntheticCatalog.intervalMs }),
    ...(options.syntheticCatalog.timeoutMs === undefined ? {} : { timeoutMs: options.syntheticCatalog.timeoutMs }),
  });
  catalogs.set(models, catalog);
  catalog.registerStoredOrFallback();
  if (options.syntheticCatalog.network === true) catalog.start();
  return models;
}

/** Model reference helper with pi-sec's default provider/model. */
export function modelRef(provider: string, modelId: string): ModelRef {
  return { provider, modelId };
}
