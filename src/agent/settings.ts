import type { HarnessSettings, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { Config } from "../config/schema.ts";
import type { RetryBudget } from "./retry-budget.ts";

/**
 * Build live `HarnessSettings` whose getters read the current config. A config
 * reload therefore affects subsequent work without a restart.
 *
 * `budget` is the process-wide retry window. When it is spent, the `retry`
 * getter hands the library a policy with no retries left, which is the only
 * place that can change the library's own retry decision. The count itself is
 * kept by the extension that sees the failures.
 */
export function createLiveSettings<Tool extends ToolRegistration>(
  getConfig: () => Config,
  getExtensions?: () => readonly Extension<Tool>[] | undefined,
  budget?: RetryBudget,
): HarnessSettings {
  return {
    get extensions() {
      return getExtensions?.();
    },
    get retry() {
      const retry = getConfig().agent.retry;
      if (budget !== undefined && budget.spent(Date.now(), retry.windowMs, retry.maxFailures)) {
        // `enabled` stays as configured: the budget stops the retries, and the
        // operator's switch still means what it says. The cost of a spent budget
        // is that compaction retries stop too, because they read this same
        // policy.
        return { enabled: retry.enabled, maxRetries: 0 };
      }
      return { enabled: retry.enabled, maxRetries: retry.maxRetries };
    },
    get compaction() {
      const compaction = getConfig().agent.compaction;
      return {
        enabled: compaction.enabled,
        reserveTokens: compaction.reserveTokens,
        keepRecentTokens: compaction.keepRecentTokens,
        backgroundTokens: compaction.backgroundTokens,
      };
    },
    get toolExecution() {
      return "parallel" as const;
    },
    /**
     * The request options of every model request: the prompt cache's retention.
     *
     * An absent `agent.stream.cacheRetention` leaves `cacheRetention` out of the
     * object, and the model library then decides from its own default and the
     * `PI_CACHE_RETENTION` environment variable. That is the behavior before
     * the key existed, so a config that does not name the key sends
     * exactly what it sent before.
     *
     * The value is read here, on every resolution of the settings, so a config
     * reload reaches the next request with no restart. The getter rebuilds the
     * object rather than keeping one, because a stored object would hold the value
     * of the config that was in force when this settings object was built.
     */
    get stream() {
      const retention = getConfig().agent.stream.cacheRetention;
      return retention === undefined ? {} : { cacheRetention: retention };
    },
    /**
     * Everything queued while a run is in flight is placed together at the next
     * boundary, rather than one item per boundary.
     *
     * The queue is where every asynchronous arrival lands: a background tool
     * result, a message from another agent, an input the operator sent while the
     * agent was working. Placing one item per turn means one run — one model
     * call, one prompt — per arrival, so ten subagents reporting cost ten root
     * runs and a steer that waits its turn leaves the rest of what was sent
     * sitting in the queue behind it.
     *
     * The cost is that several messages arrive as one user message at the end of
     * a run, so the model has to answer them together and may answer only the
     * last. Nothing is dropped either way; that is the trade this takes.
     */
    get steeringMode() {
      return "all" as const;
    },
    get followUpMode() {
      return "all" as const;
    },
    get contextRetentionMs() {
      return 600_000;
    },
  };
}
