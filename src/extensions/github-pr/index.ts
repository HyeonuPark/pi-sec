import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionRouteContext, ExtensionRoutes } from "../index.ts";
import type { ExtensionContext } from "../context.ts";
import { registerGithubPrRoutes, type GithubPrRouteOptions } from "./routes.ts";

/**
 * `github-pr` — the pull request dashboard, served under `/github/pr/`.
 *
 * The extension is one catalog entry with two independent halves:
 *
 *   1. The extension object the harness installs. This half is deliberately
 *      empty: the dashboard has no tool and no prompt section, because every
 *      agent that reads a pull request does it through its own tools.
 *   2. The `routes` function the server calls. This half only exists while the
 *      name is in `agent.extensions.enabled`, which is what decides whether
 *      `/github/pr/` answers or the router finds nothing and answers 404.
 *
 * Turning the extension on and off needs a daemon restart, because the enabled
 * list is read while the process boots. The `githubPr` values are a different
 * matter: they are read on every request and every poll, so an operator changes
 * them and reloads the config without a restart.
 *
 * Settings live under the top-level `githubPr` key, which the schema declares
 * and only accepts while this name is enabled (`src/config/schema.ts`,
 * `src/config/load.ts`).
 *
 * A test replaces the two inputs a dashboard cannot fake in a unit test: the
 * `gh` executable and the directory the bare repositories live in. They arrive
 * in `ServerOptions.extensionRoutes["github-pr"]`, whose shape is
 * {@link GithubPrRouteOptions} in `routes.ts` and is written out in the table on
 * {@link githubPrRoutes} below. Every field of it is optional, and an absent
 * field means the real thing, which is what the daemon passes.
 */
export function createGithubPrExtension(_context: ExtensionContext): Extension<ToolRegistration> {
  return defineExtension({ name: "github-pr" });
}

/**
 * The routes this extension adds, called once when the server starts.
 *
 * The paths and the answers are `routes.ts`'s; this function is the catalog's
 * entry to them. The returned cleanup stops the list poll, and the server calls
 * it once when it closes.
 *
 * ## The options a caller may pass
 *
 * `ServerOptions.extensionRoutes["github-pr"]` reaches
 * {@link registerGithubPrRoutes} as its `options` argument, and its shape is
 * {@link GithubPrRouteOptions}: every field is optional, and an absent field
 * means the real thing. The daemon passes none of it. A test passes a fake `gh`,
 * a temporary repository root and a clock this way instead of replacing a global
 * that the whole process shares.
 *
 * | Field | Type | Default |
 * | --- | --- | --- |
 * | `ghPath` | `string` | `gh` on `PATH` |
 * | `ghEnv` | `Record<string, string>` | the process environment |
 * | `repoRoot` | `string` | `<pi-sec home>/gh-repo` |
 * | `draftsDir` | `string` | `<pi-sec home>/state/github-pr/review-drafts` |
 * | `remoteUrl` | `(slug: string) => string` | `https://github.com/<slug>.git` |
 * | `now` | `() => number` | `Date.now` |
 * | `timers` | `{ set, clear }` | `setTimeout`/`clearTimeout` |
 * | `diskLimitMegabytes` | `number` or `() => number` | `githubPr.diskLimitMegabytes` (0 means no limit), read at every disk check |
 * | `reconcileIntervalMs` | `number` | 24 hours |
 * | `webDir` | `string` | `deps.webDir` |
 *
 * `repoRoot` is fixed while the process runs, because the store it reaches takes
 * it when the routes are registered. Every other field is read when it is
 * needed: the disk cap is a function the store calls at each check, and the poll
 * interval is read at each cycle. So a reload of `githubPr` reaches a running
 * daemon.
 */
export const githubPrRoutes: ExtensionRoutes = (context: ExtensionRouteContext): (() => void) =>
  registerGithubPrRoutes(context);
