import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AppDeps } from "../server/deps.ts";
import type { Router } from "../server/router.ts";
import type { Logger } from "../runtime/logger.ts";
import { createAskUserExtension } from "./ask-user.ts";
import { createAgentProfileExtension } from "./agent-profile.ts";
import { createConventionsExtension } from "./conventions.ts";
import { createSubagentsExtension } from "./subagents.ts";
import { createCodingExtension } from "./coding.ts";
import { createExpiryCheckExtension } from "./expiry-check/index.ts";
import type { ExtensionContext } from "./context.ts";
import { createDiagnosticsExtension } from "./diagnostics.ts";
import { createGithubPrExtension, githubPrRoutes } from "./github-pr/index.ts";
import { createLinearExtension } from "./linear/index.ts";
import { createJobsExtension } from "./jobs.ts";
import { createLanguageRulesExtension } from "./language-rules.ts";
import { createLessonsExtension } from "./lessons.ts";
import { createMessageTagsExtension } from "./message-tags.ts";
import { createAsyncToolsExtension } from "./async-tools.ts";
import { createJsToolExtension } from "./js-tool.ts";
import { createNotifyExtension } from "./notify.ts";
import { createPersonalityExtension } from "./personality.ts";
import { createReadFullExtension } from "./read-full.ts";
import { createRegistryExtension } from "./registry/index.ts";
import { createRemoteMachinesExtension } from "./remote-machines.ts";
import { createReportsExtension } from "./reports.ts";
import { createSchedulerExtension } from "./scheduler.ts";
import { createSecretsExtension } from "./secrets.ts";
import { createAttachmentContextExtension } from "./attachment-context.ts";
import { createAttachmentsExtension } from "./attachments.ts";
import { createSectionsExtension, wrapSections } from "./sections.ts";
import { createSelfEditExtension } from "./self-edit.ts";
import { createSessionRestartExtension } from "./session-restart.ts";
import { createUsageExtension } from "./usage.ts";
import { createUsageFreezeExtension } from "./usage-freeze.ts";
import { createWebExtension } from "./web.ts";

export type ExtensionFactory = (context: ExtensionContext) => Extension<ToolRegistration>;

/** What the server hands one bundled extension that registers web routes. */
export interface ExtensionRouteContext {
  /**
   * The path router. The fixed routes are already in it, so a route this server
   * names answers before an extension can claim the same path.
   */
  readonly router: Router;
  /** The shared parts that every HTTP route in this process reads. */
  readonly deps: AppDeps;
  /**
   * This extension's entry of `ServerOptions.extensionRoutes`, or `undefined`.
   * The daemon passes none, so an extension falls back to its real inputs; a
   * test passes a fake `gh` path, a temporary repository root and a clock here.
   */
  readonly options: unknown;
}

/**
 * The cleanup a route registration returns: called once, when the server
 * closes, which is where an extension stops its polling timer.
 *
 * A Promise means the cleanup is also a wait. The server awaits it before it
 * reports itself closed, so work the extension had already started finishes
 * first: a caller that removes the directory such work writes into does not
 * race it. A cleanup that only stops a timer keeps the sync form.
 */
export type ExtensionRouteCleanup = () => void | Promise<void>;

/**
 * The optional `routes` field of a catalog entry: the web routes one bundled
 * extension adds.
 *
 * It is a field of the catalog rather than of `Extension`, because pi-durable's
 * extension object describes what a conversation sees (tools, sections, hooks)
 * and knows nothing about HTTP. The server reads this field for the extensions
 * the enabled list names, in catalog order, after its own routes.
 */
export type ExtensionRoutes = (context: ExtensionRouteContext) => void | ExtensionRouteCleanup;

export interface BundledExtension {
  readonly name: string;
  readonly create: ExtensionFactory;
  /** `core` installs before `Harness.open`; `app` after, when the harness exists. */
  readonly phase: "core" | "app";
  /**
   * Web routes this extension adds. Absent for every extension that answers no
   * page and no API of its own.
   */
  readonly routes?: ExtensionRoutes;
  /**
   * The pages this extension serves, as the chat page's Pages menu names them.
   * Absent for every extension that serves no page of its own.
   *
   * A link is a field of the catalog for the same reason `routes` is: it states
   * what the extension adds to the web surface, and the core names no
   * extension's own path. The server reads the list of the enabled entries at
   * boot and plants it in the chat page, so a link appears exactly while the
   * routes it names answer.
   */
  readonly pages?: readonly ExtensionPageLink[];
}

/**
 * One page link a catalog entry declares: the menu text and the path under the
 * mount.
 *
 * `path` is absolute — it starts with `/` and carries no mount prefix — because
 * the page builds the address with the mount it was served at.
 */
export interface ExtensionPageLink {
  readonly label: string;
  readonly path: string;
}

/**
 * The page links of the enabled bundled extensions, in catalog order.
 *
 * An entry is dropped, and one warning line is written for it, when its label is
 * empty or its path does not start with `/`: a menu item with no text cannot be
 * pressed, and a relative path would resolve against whatever page is open. A
 * dropped entry never reaches the page, so the page needs no rule of its own.
 */
export function collectPageLinks(
  catalog: readonly BundledExtension[],
  enabled: readonly string[],
  logger: Pick<Logger, "warn">,
): ExtensionPageLink[] {
  const links: ExtensionPageLink[] = [];
  for (const extension of catalog) {
    if (extension.pages === undefined) continue;
    if (!enabled.includes(extension.name)) continue;
    for (const link of extension.pages) {
      const label = typeof link?.label === "string" ? link.label.trim() : "";
      const path = typeof link?.path === "string" ? link.path : "";
      if (label === "" || !path.startsWith("/")) {
        logger.warn("extension page link dropped", { extension: extension.name, label: link?.label, path: link?.path });
        continue;
      }
      links.push({ label, path });
    }
  }
  return links;
}

/** The bundled extension catalog, keyed by the names in `agent.extensions.enabled`. */
export const BUNDLED_EXTENSIONS: readonly BundledExtension[] = [
  { name: "coding", create: createCodingExtension, phase: "core" },
  { name: "agent-profile", create: createAgentProfileExtension, phase: "core" },
  { name: "secrets", create: createSecretsExtension, phase: "core" },
  // Directly after `secrets`, and that position is load-bearing: both hooks run
  // on `pi.generation.beforeRequest` and the handler order is the install order.
  // Redaction must see the request text before this hook adds image bytes the
  // operator never typed. `test/attachments-context.test.ts` holds the order.
  { name: "attachment-context", create: createAttachmentContextExtension, phase: "core" },
  { name: "web", create: createWebExtension, phase: "core" },
  { name: "expiry-check", create: createExpiryCheckExtension, phase: "core" },
  { name: "jobs", create: createJobsExtension, phase: "app" },
  // One read-only tool over the registry of repositories, worktrees and buildfs
  // caches. It reads the job store the listing shows a worktree's job from, so
  // it is installed after the harness exists, like `jobs` itself.
  { name: "registry", create: createRegistryExtension, phase: "app" },
  { name: "js-tools", create: createJsToolExtension, phase: "app" },
  { name: "async-tools", create: createAsyncToolsExtension, phase: "app" },
  { name: "subagents", create: createSubagentsExtension, phase: "app" },
  // The three focused chat tools (`focused_chat_title`, `focused_chat_archive`,
  // `focused_chat_delete`) are installed by `subagents`, not by a bundled entry
  // of their own: an install whose `agent.extensions.enabled` list was written
  // out by hand would otherwise load no focused chat tool at all.
  { name: "diagnostics", create: createDiagnosticsExtension, phase: "app" },
  { name: "reports", create: createReportsExtension, phase: "app" },
  { name: "attachments", create: createAttachmentsExtension, phase: "app" },
  { name: "lessons", create: createLessonsExtension, phase: "app" },
  { name: "scheduler", create: createSchedulerExtension, phase: "app" },
  { name: "ask-user", create: createAskUserExtension, phase: "app" },
  { name: "notify", create: createNotifyExtension, phase: "app" },
  { name: "self-edit", create: createSelfEditExtension, phase: "app" },
  { name: "usage", create: createUsageExtension, phase: "app" },
  // The usage-limit hold: a conversation whose provider refused it for usage is
  // held, and sent again once a probe shows the provider accepts requests.
  { name: "usage-freeze", create: createUsageFreezeExtension, phase: "app" },
  { name: "session-restart", create: createSessionRestartExtension, phase: "app" },
  // The one bundled extension with web routes of its own. It goes before the
  // prompt section extensions so that everything with a runtime surface stays
  // in the block above them, and it is not in the default enabled list.
  {
    name: "github-pr",
    create: createGithubPrExtension,
    phase: "app",
    routes: githubPrRoutes,
    pages: [{ label: "PRs", path: "/github/pr/" }],
  },
  // The Linear tools: seven reads and three writes that need an approved report.
  // No routes, no pages and no prompt section, so it sits with the other
  // extensions that have a runtime surface, above the prompt section block. Not in
  // the default enabled list: it needs a key in a secret and the `linear` settings.
  { name: "linear", create: createLinearExtension, phase: "app" },
  // The prompt section extensions come last, in this order: `conventions`,
  // `language-rules`, `message-tags`, `personality`, `read-full`,
  // `remote-machines`. Order is section order and hook order, and these names
  // sort alphabetically on purpose, so a later insert keeps the runtime
  // extensions' old position.
  { name: "conventions", create: createConventionsExtension, phase: "app" },
  { name: "language-rules", create: createLanguageRulesExtension, phase: "app" },
  { name: "message-tags", create: createMessageTagsExtension, phase: "app" },
  { name: "personality", create: createPersonalityExtension, phase: "app" },
  { name: "read-full", create: createReadFullExtension, phase: "app" },
  // The remote machine tools: a section and nine tools, and the last entry of the
  // catalog. Its section reads the conversation's tool list, so a conversation
  // that reaches no remote tool renders no text. Not in the default enabled list:
  // a fresh install has no machine registered, and the section would describe a
  // capability the install cannot use.
  { name: "remote-machines", create: createRemoteMachinesExtension, phase: "app" },
];

export function bundledExtension(name: string): BundledExtension | undefined {
  return BUNDLED_EXTENSIONS.find((extension) => extension.name === name);
}

/** Build the enabled bundled extensions for a phase. */
export function createBundledExtensions(
  context: ExtensionContext,
  phase: "core" | "app",
): Extension<ToolRegistration>[] {
  const enabled = context.getConfig().agent.extensions.enabled;
  const out: Extension<ToolRegistration>[] = [];
  for (const extension of BUNDLED_EXTENSIONS) {
    if (extension.phase !== phase) continue;
    if (!enabled.includes(extension.name)) continue;
    // Every section of every bundled extension is sealed, whatever it renders.
    // See `sections.ts`: a section that changes mid-session rewrites the request
    // head and costs the provider's whole prefix cache.
    out.push(wrapSections(extension.create(context), context.sections));
  }
  return out;
}

export type { ExtensionContext } from "./context.ts";
