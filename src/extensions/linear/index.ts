import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionContext } from "../context.ts";
import type { LinearDeps } from "./client.ts";
import { createEnv } from "./env.ts";
import { createReadTools } from "./reads.ts";
import { createWriteTools } from "./writes.ts";

/**
 * `linear` — read a Linear workspace, and write to it only under an
 * approved report.
 *
 * The extension is not in the default enabled list. An install turns it on by
 * naming it in `agent.extensions.enabled` and by adding the top-level `linear`
 * key (`apiKeySecret`, the name of the secret that holds a personal API key, and
 * `writes`). The loader refuses an enabled `linear` without the key. The enabled
 * list is read at boot, so turning the extension on or off is a daemon restart.
 *
 * It registers seven read tools, and three write tools when `linear.writes` is
 * true at boot. A write call reads `linear.writes` again, so a reload that sets it
 * to false stops writes before the next restart. The write rule is in
 * `writes.ts`; the operation check that keeps a mutation out of every read is in
 * `document.ts`.
 *
 * There are no web routes, no pages and no prompt section. The write tools are
 * closed to scheduled runs and to focused chats by the two core tables in
 * `src/agent/tool-profile.ts` and `src/extensions/subagents.ts`.
 *
 * `deps` replaces the outside world in a test: fetch, the key reader, the clock,
 * the sleep and the id source. The catalog passes none of them.
 */
export function createLinearExtension(context: ExtensionContext, deps: LinearDeps = {}): Extension<ToolRegistration> {
  const env = createEnv(context, deps);
  const tools = createReadTools(env);
  if (context.getConfig().linear?.writes === true) tools.push(...createWriteTools(env));
  return defineExtension({ name: "linear", tools });
}
