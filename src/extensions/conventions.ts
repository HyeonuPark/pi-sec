import { homedir } from "node:os";
import { defineExtension, section, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Config } from "../config/schema.ts";
import { expandPath, type Paths } from "../runtime/paths.ts";
import type { ExtensionContext } from "./context.ts";
import { CONVENTIONS_TEXT } from "./conventions-text.ts";

/**
 * `conventions` — the standing work rules, in the system prompt.
 *
 * The rules a request obeys are not something an agent should have to remember
 * to look up, so they ride in the prompt on every request. The text itself is a
 * constant (`conventions-text.ts`); the two values it names are filled from the
 * config, so the section says the same directory the rest of the runtime uses.
 *
 *   {jobsDir}    the absolute path of `agent.jobDir`, where a job keeps its
 *                working files. `~` expands against the run account's home.
 *   {piSecHome}  the pi-sec home, the same directory `paths.home` holds.
 *
 * Why a constant and not a config document: a section renders the same bytes on
 * every request only if nothing in it moves. The seal in `sections.ts` keeps a
 * session's first value regardless, and a value that changed under it would cost
 * the provider's whole prefix cache once the session restarted.
 */

/** The directory `agent.jobDir` names when a config file leaves it empty. */
const DEFAULT_JOB_DIR = "~/job";

/** The run account's home: `$HOME` when the process has one, else the passwd entry. */
function accountHome(): string {
  return process.env["HOME"] ?? homedir();
}

/**
 * Render the section: the constant, with both paths as absolute paths.
 *
 * `home` is the directory `~` stands for. It is a parameter so a test can name a
 * temporary home instead of moving the process's own.
 */
export function renderConventions(
  config: Config,
  paths: Pick<Paths, "home">,
  home: string = accountHome(),
): string {
  const configured = config.agent.jobDir.length === 0 ? DEFAULT_JOB_DIR : config.agent.jobDir;
  const jobsDir = expandPath(configured, process.cwd(), home);
  return CONVENTIONS_TEXT.replaceAll("{jobsDir}", jobsDir).replaceAll("{piSecHome}", paths.home);
}

/** The bundled `conventions` extension: one section, no tool and no hook. */
export function createConventionsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  return defineExtension({
    name: "conventions",
    sections: [section("conventions", () => renderConventions(context.getConfig(), context.paths))],
  });
}
