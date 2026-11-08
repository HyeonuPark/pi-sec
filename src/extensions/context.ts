import type { Context } from "@earendil-works/chord";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Config } from "../config/schema.ts";
import type { Paths } from "../runtime/paths.ts";
import type { AuditLog } from "../runtime/audit.ts";
import type { Logger } from "../runtime/logger.ts";
import type { RestartState } from "../runtime/restart.ts";
import type { SecretRegistry } from "../secrets/registry.ts";
import type { JobRegistry } from "../jobs/registry.ts";
import type { ArchiveStore } from "../jobs/archive.ts";
import type { ReportStore } from "../reports/store.ts";
import type { SectionSeal } from "./sections.ts";
import type { ToolTagCatalog } from "./tool-tags.ts";
import type { DraftStore } from "../reports/drafts.ts";
import type { SubagentHub } from "./subagents.ts";
import type { FocusedChatStore } from "../focused/store.ts";
import type { RetryBudget } from "../agent/retry-budget.ts";
import type { Judges } from "../judges.ts";
import type { ContextAdvice } from "../context-advice.ts";
import type { UsageService } from "../server/usage/service.ts";
import type { ProviderRegistry } from "../registry/providers.ts";
import type { RemoteMachines } from "../remote/machines.ts";

/** Fan-out sink for pi-sec control events (surfaced as SSE). */
export interface EventsSink {
  emit(type: string, data: Record<string, unknown>): void;
}

export const NULL_EVENTS: EventsSink = { emit: () => undefined };

/**
 * Shared context for bundled extensions. `harness` and `jobs`
 * are attached after `Harness.open`, so extensions that need them must read
 * them lazily at call time.
 */
export interface ExtensionContext {
  getConfig(): Config;
  readonly paths: Paths;
  readonly secrets: SecretRegistry;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly events: EventsSink;
  /**
   * The shared restart state. `self-edit` raises it when it records committed
   * core work; the admin API and the web banner read it. One object, so the two
   * cannot disagree — a restart flag the operator cannot see is how a core
   * change goes unapplied.
   */
  readonly restart: RestartState;
  /**
   * The session seal for system-prompt sections. Built before any extension is
   * installed, because installing one is what wraps its sections.
   */
  readonly sections: SectionSeal;
  /**
   * The `complex` tag catalog. Extensions read it at call time; the loader
   * writes an extension's own declaration into it at install time.
   */
  readonly toolTags: ToolTagCatalog;
  /**
   * The names of the installed tools, read when an agent is resolved.
   *
   * A tool wrapper targets one tool by name and cannot see the registry, so the
   * runtime hands it the names. Reading them per resolution is what covers a tool
   * a reload added.
   */
  readonly toolNames?: () => readonly string[];
  /**
   * The runtime's storage. Only the reads that need a document scan use it, such
   * as the background-work list; everything else goes through the harness.
   */
  readonly storage: Storage;
  harness?: Harness;
  jobs?: JobRegistry;
  /** Live-first job reads, plus the archive. Absent before the runtime wires it. */
  archive?: ArchiveStore;
  /** Long documents owned by jobs. Absent before the runtime wires it. */
  reports?: ReportStore;
  /** Runtime-extension reload hook, installed by the loader once available. */
  reloadExtensions?: () => Promise<{ reloaded: string[]; errors: string[] }>;
  /** Draft reports, owned by subagents until the root publishes or drops them. */
  drafts?: DraftStore;
  /** The subagent registry. Absent before the extension is installed. */
  subagents?: SubagentHub;
  /**
   * The focused chats the user opened from the web page. Absent only in a test
   * that builds a context by hand.
   */
  focusedChats?: FocusedChatStore;
  /**
   * The process-wide retry window. One per runtime: the settings getter reads it
   * on every attempt, and the hook that sees a failure counts into it.
   */
  readonly retryBudget: RetryBudget;
  /**
   * The restart advice. One per runtime, built before any extension is installed,
   * because installing one is what opts a conversation into the advice, and
   * because the module that puts inputs into conversations reads the same object
   * from the process rather than from here.
   */
  readonly contextAdvice: ContextAdvice;
  /**
   * The remote machines: their level, their runs, their checks and their files.
   *
   * The `remote-machines` extension reads everything it needs from here, so the
   * tools it registers hold no state of their own. It is built by the runtime after
   * the harness, and the field is set on the same object, so a tool reads it at call
   * time and never sees an empty one.
   *
   * Nothing else in this context is a way to a machine, and no other field reaches
   * the level check: a tool that skips `remoteMachines.access` cannot start a
   * process on a machine at `off`.
   */
  readonly remoteMachines: RemoteMachines;
  /**
   * The judgement models named in `config.judges`, called by name with
   * `judge(name, { state, questions })`.
   *
   * A judgement is one classifier call outside any conversation: it answers,
   * skips or fails, and it never throws, so an extension that judges a reply can
   * carry on without one. It writes one audit line per call, and the usage page
   * sums those lines on its "Decision models" card rather than in any provider
   * card. See `src/judges.ts`.
   */
  readonly judges: Judges;
  /**
   * The provider cards' reader: what each provider's own API says about its
   * quota, and pi-sec's own ledger of what it spent.
   *
   * The runtime builds one and hands the same object to this context and to the
   * usage page's routes, so "the value the card shows" and "the value the hold
   * watch judges on" cannot be two different readings of one provider. Absent
   * only in a test that builds a context by hand.
   */
  readonly usage?: UsageService;
  /**
   * The model catalog, which `models` on a hook already carries and a watch does
   * not.
   *
   * The hold watch asks a refused provider one short question with a model of
   * its own, and that model is looked up here. Absent only in a test that builds
   * a context by hand.
   */
  readonly models?: Models;
  /**
   * Whether a provider is an extension's virtual one, which answers no request
   * itself.
   *
   * A request a virtual provider forwards is answered by the provider it
   * forwarded to, so a 429 that arrives that way belongs to that provider. This
   * tells the two apart: a failure a virtual provider made before choosing a
   * target carries the virtual id, and that is not a usage limit of anybody's.
   */
  readonly isVirtualProvider?: (providerId: string) => boolean;
  /**
   * The provider registrations the runtime extensions made, when the catalog can
   * take them.
   *
   * It is assigned after the app-phase extensions are installed, because that is
   * when the registry exists; a reader that asks it lazily, such as
   * `isVirtualProvider`, is unaffected by the order.
   */
  providers?: ProviderRegistry;
  /**
   * The hold watch, once the `usage-freeze` extension is installed. The runtime
   * starts and stops it beside the stall watch.
   */
  usageFreeze?: UsageFreezeWatch;
}

/**
 * What the runtime starts and stops of the hold watch.
 *
 * The admin status route reads `holdView` and the banner draws it; the timer is
 * started and stopped beside the stall watch.
 */
export interface UsageFreezeWatch {
  startWatch(): void;
  stopWatch(): void;
  /** Run one pass now. A test drives the watch with this instead of a timer. */
  tick(ctx?: Context): Promise<UsageFreezePass>;
  /** The providers holding conversations right now, for the status route. */
  holdView(ctx?: Context): Promise<readonly UsageHoldView[]>;
}

/** One provider's hold, as `GET /api/admin/status` carries it. */
export interface UsageHoldView {
  readonly provider: string;
  /** How many conversations wait for this provider. */
  readonly conversations: number;
  /** Epoch milliseconds the provider's own window resets, when it states one. */
  readonly resetsAt?: number;
  /** False when this server cannot read the provider's own usage at all. */
  readonly readable: boolean;
  readonly lastProbeAt?: number;
  readonly lastProbeResult?: "none" | "ok" | "rate_limited" | "failed";
  readonly lastProbeReason?: string;
  /** When the next probe is allowed. */
  readonly nextProbeAt?: number;
}

/** What one pass of the hold watch came to. */
export interface UsageFreezePass {
  /** Conversations this pass began holding. */
  readonly held: number;
  /** Providers this pass probed. */
  readonly probed: number;
  /** Conversations this pass resumed because their provider answered. */
  readonly resumed: number;
}

export function requireDrafts(context: ExtensionContext): DraftStore {
  if (context.drafts === undefined) throw new Error("the draft store is not available yet");
  return context.drafts;
}

export function requireHarness(context: ExtensionContext): Harness {
  if (context.harness === undefined) throw new Error("harness is not available yet");
  return context.harness;
}

export function requireJobs(context: ExtensionContext): JobRegistry {
  if (context.jobs === undefined) throw new Error("job registry is not available yet");
  return context.jobs;
}

/** The archive, when the runtime has wired one. */
export function optionalArchive(context: ExtensionContext): ArchiveStore | undefined {
  return context.archive;
}

/** The report store, which the runtime wires once the harness exists. */
export function requireReports(context: ExtensionContext): ReportStore {
  if (context.reports === undefined) throw new Error("report store is not available yet");
  return context.reports;
}
