import type { ExtensionContext } from "../context.ts";
import { LinearClient, LinearError, loadKey, resolveDeps, type LinearDeps } from "./client.ts";
import { answer, refusal, type ToolText } from "./format.ts";

/** What the read and write tools share: the context, the dependencies and the pacing of search. */
export interface LinearEnv {
  readonly context: ExtensionContext;
  readonly deps: ReturnType<typeof resolveDeps>;
  readonly readKey: LinearDeps["readKey"];
  /** Wait until the last search is at least two seconds old. */
  pace(): Promise<void>;
  /** Run one tool body with a client that holds the key for this call only. */
  run(body: (client: LinearClient) => Promise<string>): Promise<ToolText>;
}

const SEARCH_GAP_MS = 2_000;

export function createEnv(context: ExtensionContext, input: LinearDeps): LinearEnv {
  const deps = resolveDeps(input);
  let lastSearch = Number.NEGATIVE_INFINITY;
  return {
    context,
    deps,
    readKey: input.readKey,
    async pace() {
      const wait = lastSearch + SEARCH_GAP_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastSearch = deps.now();
    },
    async run(body) {
      const settings = context.getConfig().linear;
      if (settings === undefined) {
        return refusal("The linear settings key is missing from the configuration, so no Linear call can be made.");
      }
      let client: LinearClient | undefined;
      try {
        const key = await loadKey(context.paths.secretsDir, settings.apiKeySecret, input.readKey);
        client = new LinearClient(key, deps, context.getConfig().timezone);
        const text = await body(client);
        const budget = client.budgetLine();
        return answer(client.scrub(budget === "" ? text : `${text}\n${budget}`));
      } catch (error) {
        if (error instanceof LinearError) {
          return refusal(client === undefined ? error.message : client.scrub(error.message));
        }
        // The message of an unexpected error is not passed on: it could hold a
        // request detail. The name is enough to find the cause in the code.
        const name = error instanceof Error ? error.name : "error";
        context.logger.warn("linear tool failed", { name });
        return refusal(`The Linear tool failed unexpectedly (${name}). Nothing more is known; try again once.`);
      }
    },
  };
}
