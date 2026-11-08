import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  createSession,
  Harness,
  type Extension,
  type Harness as HarnessType,
  type Registry,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Config } from "../config/schema.ts";
import type { Paths } from "../runtime/paths.ts";
import type { Logger } from "../runtime/logger.ts";
import type { AuditLog } from "../runtime/audit.ts";
import type { SecretRegistry } from "../secrets/registry.ts";
import { createEnvFactory } from "./env.ts";
import { sweepContextFiles } from "./context-file.ts";
import { dropForJobs, sweepAttachments } from "../attachments/sweep.ts";
import { resolveDefaultConversation } from "./conversation.ts";
import { isModelSetupMode } from "./model-setup.ts";
import { createLiveSettings } from "./settings.ts";
import { RetryBudget } from "./retry-budget.ts";
import { JobRegistry } from "../jobs/registry.ts";
import { InboxStore } from "../jobs/inbox.ts";
import { ArchiveStore, Archivist, type ArchiveSweepReport, type ArchivistTimers } from "../jobs/archive.ts";
import { ReportStore } from "../reports/store.ts";
import { reportNotice } from "../reports/notice.ts";
import { DraftStore } from "../reports/drafts.ts";
import { runMigrations, type MigrationResult } from "../runtime/migrations.ts";
import { createInboxItemTx } from "../extensions/notify.ts";
import { ExtensionLoader } from "../registry/loader.ts";
import { providerRegistryFor, warnMissingVmodels, type ProviderRegistry } from "../registry/providers.ts";
import { Judges } from "../judges.ts";
import { UiRegistry } from "../registry/ui.ts";
import type { SubagentHub } from "../extensions/subagents.ts";
import { createBundledExtensions, bundledExtension } from "../extensions/index.ts";
import { SectionSeal, createSectionsExtension, wrapSections } from "../extensions/sections.ts";
import { ToolTagCatalog } from "../extensions/tool-tags.ts";
import { Scheduler } from "../extensions/scheduler.ts";
import type { EventsSink, ExtensionContext, UsageFreezeWatch } from "../extensions/context.ts";
import { hasPrivateTmp, Janitor } from "../runtime/janitor.ts";
import { registrySettings } from "../registry/layout.ts";
import { BuildfsRefresher } from "../registry/refresh.ts";
import { RestartState } from "../runtime/restart.ts";
import { DEVICE_ID_FILE_NAME, ModelLoginService } from "../runtime/model-login.ts";
import { openPrivateSqliteStorage } from "../runtime/sqlite-file.ts";
import { FocusedChatStore } from "../focused/store.ts";
import { ContextAdvice, getContextAdvice, setContextAdvice } from "../context-advice.ts";
import { RemoteMachines, type AgentIdentity, type RemoteMachinesOverrides } from "../remote/machines.ts";
import { SecAgent } from "../documents.ts";
import { createUsageService, type UsageModels, type UsageService } from "../server/usage/service.ts";
import { UsageRecords } from "../server/usage/records.ts";
import { JudgeUsage } from "../server/usage/judges.ts";
import { withCallTiming } from "./call-timing.ts";
import { ModelCallsStore } from "./model-calls-store.ts";

export interface AgentRuntimeOptions {
  readonly paths: Paths;
  readonly config: Config;
  readonly storage: Storage;
  readonly models: Models;
  readonly secrets: SecretRegistry;
  readonly logger: Logger;
  readonly audit: AuditLog;
  readonly events: EventsSink;
  /** When false, runtime extensions are not loaded (mainly for tests). */
  readonly loadExtensions?: boolean;
  readonly watchExtensions?: boolean;
  /**
   * Storage for archived jobs. Defaults to SQLite at `paths.archiveDb`; tests
   * inject an in-memory storage so they do not touch the filesystem.
   */
  readonly archiveStorage?: Storage;
  /**
   * The clock the archive schedule reads, and the timer it arms.
   *
   * The daemon passes neither: the sweep runs on the system clock at
   * `archive.sweepAt`. A test passes a clock and a timer it drives itself, so a
   * daily schedule is checked without waiting for a day to pass.
   */
  readonly archiveClock?: () => number;
  readonly archiveTimers?: ArchivistTimers;
  /**
   * Prepare the root conversation during boot, before this call returns.
   *
   * The two `GET` routes of the chat page only read the root, so the root has to
   * exist before the server answers anything. Defaults to true. A test that needs
   * a store with no root conversation passes false, which is how the
   * `root_missing` answer is reached without breaking a boot.
   */
  readonly prepareRoot?: boolean;
  /**
   * Provider registrations made before this runtime existed.
   *
   * `pi-sec start` registers the providers extensions export before it checks
   * the root vmodel, so the daemon boots on a model only an extension provides.
   * It passes the same registry here, and the full load below then replaces
   * those entries instead of adding a second registration for the same id. When
   * absent, the runtime owns a registry of its own if `models` can register
   * providers; a catalog that cannot (a test double) gets none.
   */
  readonly providers?: ProviderRegistry;
  /**
   * How long a web login session may run, and how long its last state stays
   * readable. The daemon takes the defaults in `runtime/model-login.ts`; a test
   * shortens them instead of waiting ten minutes for a timeout. No setting
   * carries either value.
   */
  readonly modelLogin?: { readonly sessionTimeoutMs?: number; readonly finishedRetentionMs?: number };
  /**
   * What the remote machines manager may be told instead of its real inputs.
   *
   * The daemon passes none of it, so `ssh` on `PATH` is what runs and the clock is
   * the system's. A test passes the path of the fake ssh and a clock it controls
   * here instead of replacing a global that the whole process shares, the way the
   * `github-pr` routes take their fake `gh`.
   */
  readonly remoteMachines?: RemoteMachinesOverrides;
  /**
   * The provider cards' reader, when a caller has one already.
   *
   * The daemon passes none and gets a service built over its own ledger and
   * catalog. A test passes a double here, which is how "the hold watch judged on
   * this provider's numbers" is checked without reaching any provider.
   */
  readonly usage?: UsageService;
}

export interface AgentRuntime {
  readonly harness: HarnessType;
  readonly registry: Registry<ToolRegistration>;
  readonly storage: Storage;
  readonly paths: Paths;
  readonly secrets: SecretRegistry;
  readonly models: Models;
  readonly logger: Logger;
  readonly audit: AuditLog;
  readonly events: EventsSink;
  readonly jobs: JobRegistry;
  readonly inbox: InboxStore;
  readonly reports: ReportStore;
  /**
   * Draft reports: open work of the job they belong to. A route reads it to drop
   * a job's drafts when the route itself is what ended the job.
   */
  readonly drafts: DraftStore;
  readonly archive: ArchiveStore;
  readonly archivist: Archivist;
  /**
   * Restart state shared with the admin API. The runtime creates it so the
   * extension context and the HTTP surface cannot end up holding different
   * ones; `cli.ts` hands the server this same object.
   */
  readonly restart: RestartState;
  /**
   * The session seal for system-prompt sections. The admin API reads it to tell
   * the operator which sessions are running on a system prompt that has moved on.
   */
  readonly sections: SectionSeal;
  /** What the startup migration pass did, if anything. */
  readonly migrations: MigrationResult;
  readonly scheduler: Scheduler;
  readonly loader: ExtensionLoader;
  /**
   * The cards runtime extensions offer, and the `publish` functions their `start`
   * hooks hold. The page routes and the card markup injection read it; the loader
   * keeps it current on every load pass.
   */
  readonly ui: UiRegistry;
  /**
   * The one model provider login the web UI may drive, and the record of when
   * each provider last logged in. Its session lives in memory: a restart drops
   * it.
   */
  readonly modelLogin: ModelLoginService;
  /**
   * The provider registrations runtime extensions made, when the catalog can take
   * them. A route reads it to tell which provider is an extension's virtual one;
   * a test double that cannot register providers leaves it empty.
   */
  readonly providers?: ProviderRegistry;
  readonly janitor: Janitor;
  /**
   * The registry's buildfs cache refresh. Its first check runs five minutes
   * after boot and then once an hour, and it refreshes only when
   * `state/last-refresh.json` is older than `registry.refreshHours`.
   */
  readonly buildfsRefresher: BuildfsRefresher;
  /**
   * The subagent registry, once the extensions are installed. The stall sweep is
   * driven from it: boot starts its timer, and a test can run one pass.
   */
  readonly subagents?: SubagentHub;
  /**
   * The usage-limit hold watch, once the extensions are installed.
   *
   * The admin status route reads its view for the banner, and a test runs one pass
   * with `tick()` instead of waiting a minute for the timer.
   */
  readonly usageFreeze?: UsageFreezeWatch;
  /**
   * The provider cards' reader, built once for the whole process.
   *
   * The usage page's routes answer from this object and the hold watch judges a
   * provider's recovery on it, so "the value the card shows" and "the value the
   * watch acts on" cannot be two readings of one provider. `registerUsage()` takes
   * it as its own unless a test hands it a fake one.
   */
  readonly usage: UsageService;
  /**
   * The focused chats the user opened from the web page. The store holds the
   * title, the archive time and the tombstones, which nothing else does.
   */
  readonly focusedChats: FocusedChatStore;
  /**
   * The remote machines: their level, their heartbeat and their live connections.
   *
   * The routes read it, the boot starts its timer, `setConfig` tells it that the
   * config moved, and the shutdown closes its connections. One object, so no two
   * callers can hold different ideas of one machine's level.
   */
  readonly remoteMachines: RemoteMachines;
  getConfig(): Config;
  setConfig(config: Config): void;
  close(): Promise<void>;
}

/**
 * Boot the agent runtime: registry, extensions, harness, job registry,
 * scheduler, and runtime-extension loader.
 */
export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  let currentConfig = options.config;
  const getConfig = (): Config => currentConfig;

  const registry = createRegistry<ToolRegistration>();
  const restart = new RestartState();
  // One retry window for the whole process. The settings getter enforces it and
  // the subagents extension counts into it, so the two cannot disagree about
  // what "spent" means.
  const retryBudget = new RetryBudget();
  const sections = new SectionSeal();
  // One catalog, shared by the loader (which writes declarations) and the
  // extensions that read them. Built before any extension is installed, because
  // installing one is what records its declaration.
  const toolTags = new ToolTagCatalog(getConfig);
  // The restart advice, and the process-wide handle that `src/submit-envelope.ts`
  // reads. Built before any extension is installed, because installing one is what
  // opts a conversation into the advice, and the handle has to be there before the
  // first input can arrive.
  const contextAdvice = new ContextAdvice({
    getConfig,
    getHarness: () => context.harness,
    logger: options.logger,
  });
  setContextAdvice(contextAdvice);
  // The focused chats live in their own database, like the job archive, so the
  // transcript store keeps the schema its library owns. It is opened before any
  // extension is installed: the subagents extension reads it to tell whether a
  // `stopped` focused record still holds a slot.
  const focusedChats = await FocusedChatStore.open(options.paths.focusedChatsDb);
  // Every streaming model call leaves one timing row in a database of its own.
  // A store that cannot open leaves the models unwrapped: the daemon records
  // nothing and still starts.
  const modelCalls = await ModelCallsStore.open(options.paths.modelCallsDb).catch((error: unknown) => {
    options.logger.warn("model call store did not open; model calls are not recorded", { error });
    return undefined;
  });
  const models: Models =
    modelCalls === undefined ? options.models : withCallTiming(options.models, { sink: modelCalls, logger: options.logger });
  // The judgement models of `config.judges`. It reads the config on every call,
  // so a config that changed since boot reaches the next judgement, and it needs
  // nothing that the harness has not built yet.
  const judges = new Judges({
    getConfig,
    models: options.models,
    logger: options.logger,
    audit: options.audit,
  });
  // The provider cards' reader, built here rather than in the usage route because
  // the hold watch runs before the server is made and reads the same object. It
  // calls no provider at construction, so a boot with no credential still boots.
  const usage = options.usage ?? createUsageService({
    // The catalog is read through a getter, so a provider an extension registers
    // after this point is asked about on the next read.
    models: () => options.models as unknown as UsageModels,
    records: new UsageRecords({ path: options.paths.stateDb }),
    isVirtual: (providerId) => context.providers?.isVirtual(providerId) === true,
    judgeModels: () => getConfig().judges,
    judgeRecords: new JudgeUsage({ file: options.paths.auditLog }),
    timezone: () => getConfig().timezone,
    logger: options.logger,
  });

  // The remote machines. Built before the context so the context can carry it, and
  // before the harness because everything it reads from the harness is a getter:
  // the manager is asked for a conversation or a document only when a call needs
  // one, so an object built ahead of the harness sees the harness when it exists.
  const remoteMachines = new RemoteMachines({
    paths: options.paths,
    getConfig,
    session: () => harness,
    harness: () => harness,
    storage: () => options.storage,
    // A run check answers the conversation that started the run and needs to know
    // whether that conversation can still be read; the tightening request names
    // the agent that started each run. Both read the same record.
    agent: async (conversationId: string): Promise<AgentIdentity | undefined> => {
      try {
        const record = await harness.snapshot(SecAgent, conversationId, BACKGROUND_CONTEXT);
        return record === undefined ? undefined : { name: record.name, status: record.status };
      } catch {
        return undefined;
      }
    },
    audit: options.audit,
    logger: options.logger,
    events: options.events,
    ...(options.remoteMachines === undefined ? {} : { overrides: options.remoteMachines }),
  });

  const context: ExtensionContext = {
    remoteMachines,
    focusedChats,
    usage,
    models,
    // A virtual provider answers no request itself, so a 429 that carries its id
    // is a failure it made before choosing a target: not a usage limit of any
    // account. Read through the registry on every call, so a reload that adds or
    // drops the marker reaches the next pass.
    isVirtualProvider: (providerId) => context.providers?.isVirtual(providerId) === true,
    getConfig,
    paths: options.paths,
    secrets: options.secrets,
    audit: options.audit,
    logger: options.logger,
    events: options.events,
    restart,
    sections,
    toolTags,
    // A tool wrapper targets one tool by name, and the registry is where the
    // names live; reading them per resolution covers a tool a reload added.
    toolNames: () => registry.snapshot().tools().map((pair) => pair.tool.name),
    storage: options.storage,
    retryBudget,
    contextAdvice,
    judges,
  };

  // The seal is installed before anything else and is not part of the enable
  // list: it is an invariant of how a request is built, not a feature an operator
  // can switch off. Its sections reach the history through the hook it carries.
  registry.install(createSectionsExtension(context));

  for (const extension of createBundledExtensions(context, "core")) registry.install(extension);

  const settings = createLiveSettings(getConfig, undefined, retryBudget);
  const env = createEnvFactory({
    paths: options.paths,
    getConfig,
    redactor: () => options.secrets.redactor(),
  });

  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry,
      settings,
      env,
      onReport: (report) => options.logger.warn("extension error", { error: report.error, kind: report.kind }),
    },
    BACKGROUND_CONTEXT,
  );

  context.harness = harness;

  const jobs = new JobRegistry({ session: harness, storage: options.storage });
  const inbox = new InboxStore({ session: harness, storage: options.storage });
  context.jobs = jobs;
  // Data migrations run before anything reads these documents. The ledger entry
  // is committed together with the change it records, so a crash can never
  // claim a migration that did not happen.
  const migrations = await runMigrations({
    session: harness,
    storage: options.storage,
    context: BACKGROUND_CONTEXT,
    logger: options.logger,
  });

  // The archive lives in its own database so the live store stays small and
  // scanning jobs stays cheap. Nothing is deleted; an archived id still resolves.
  const ownedArchive = options.archiveStorage === undefined;
  const archiveStorage = options.archiveStorage ?? (await openPrivateSqliteStorage(options.paths.archiveDb));
  const archiveSession = createSession(archiveStorage);
  const reports = new ReportStore({
    session: harness,
    storage: options.storage,
    reportsDir: options.paths.reportsDir,
    archiveDir: options.paths.archiveDir,
    archiveSession,
    archiveStorage,
    // The notice is written by the report's own commit, so a published report is
    // never visible without the item that says so. Callers announce the change
    // afterwards, which is what refreshes an open inbox.
    onChange: async (tx, change) => {
      await createInboxItemTx(tx, reportNotice(change));
    },
    // A briefing report leaves the live store on its own when a newer one
    // replaces it, and the audit row is where that is explained.
    audit: options.audit,
  });
  // Draft reports: files with an index row, invisible to the operator. A draft
  // belongs to a job, so it goes when the job ends; only a draft written before
  // the job field existed still goes with its author.
  const drafts = new DraftStore({
    harness: () => harness,
    paths: options.paths,
    storage: options.storage,
    audit: options.audit,
  });
  context.drafts = drafts;
  // Reports go with their job: the documents, then the body files.
  const archive = new ArchiveStore({
    live: jobs,
    session: archiveSession,
    storage: archiveStorage,
    onArchive: async (jobIds, sweepContext) => {
      await reports.moveJobsToArchive(sweepContext, jobIds);
      // A draft is a temporary file rather than a document the job kept, so it is
      // dropped here instead of being moved. The reason reaches the audit row,
      // which is the only place the disposal survives.
      await drafts.dropForJobs(sweepContext, jobIds, "job-archived");
      // An attachment and a share file belong to their job the same way: a job that
      // has left the live store can never read them again, so the files go with it.
      // Warn only, because the archive move above has already happened and a file
      // left behind is the sweep's to find rather than a reason to fail the hook.
      try {
        await dropForJobs(
          {
            storage: options.storage,
            harness,
            audit: options.audit,
            jobs,
            context: sweepContext,
          },
          jobIds,
          "job-archived",
        );
      } catch (error) {
        options.logger.warn("attachment disposal failed", { error });
      }
    },
  });
  context.archive = archive;
  context.reports = reports;

  async function announceSweep(report: ArchiveSweepReport): Promise<void> {
    const body = [
      `${report.archived.length} moved, ${report.heldBack.length} held back (a live descendant keeps a job in the live store).`,
      ...report.archived.map((id) => `archived: ${id}`),
      ...report.failed.map((failure) => `failed: ${failure.id} — ${failure.error}`),
    ].join("\n");
    try {
      const item = await harness.commit(
        (tx) =>
          createInboxItemTx(tx, {
            title: `Archive sweep: ${report.archived.length} job(s) archived`,
            body,
            kind: "archive",
            severity: report.failed.length > 0 ? "warn" : "info",
          }),
        BACKGROUND_CONTEXT,
      );
      options.events.emit("inbox_item", item as unknown as Record<string, unknown>);
    } catch (error) {
      options.logger.warn("archive sweep notice failed", { error });
    }
    // A swept job leaves the live store, and the job list is built from that
    // store: without one event per archived job an open page keeps a row whose
    // job is gone. These are separate from the notice above so that a notice
    // failure cannot take them with it.
    for (const id of report.archived) {
      try {
        const job = await archive.getAny(BACKGROUND_CONTEXT, id);
        if (job !== undefined) options.events.emit("job_updated", job as unknown as Record<string, unknown>);
      } catch (error) {
        options.logger.warn("archive sweep job notice failed", { id, error });
      }
    }
  }

  const archivist = new Archivist({
    store: archive,
    enabled: currentConfig.archive.enabled,
    // Read through the current config, not copied out of it: a reload that moves
    // the time of day or the harness zone reaches the next run.
    policy: {
      get afterDays() {
        return currentConfig.archive.afterDays;
      },
      get sweepAt() {
        return currentConfig.archive.sweepAt;
      },
      get timeZone() {
        return currentConfig.timezone;
      },
    },
    logger: options.logger,
    onSweep: (report) => void announceSweep(report),
    ...(options.archiveClock === undefined ? {} : { now: options.archiveClock }),
    ...(options.archiveTimers === undefined ? {} : { timers: options.archiveTimers }),
  });

  // `archive.sweepMs` is the interval the sweep used to run on. It is still in
  // the schema so an older config loads, but nothing reads it any more, and an
  // operator who left one in place should hear that it does nothing.
  if (currentConfig.archive.sweepMs !== undefined) {
    options.logger.warn("archive.sweepMs is ignored: the sweep runs once a day at archive.sweepAt", {
      sweepMs: currentConfig.archive.sweepMs,
      sweepAt: currentConfig.archive.sweepAt,
    });
  }

  for (const extension of createBundledExtensions(context, "app")) registry.install(extension);

  const providers = options.providers ?? providerRegistryFor(options.models, options.logger);
  // The context reads it for `isVirtualProvider`, which the hold watch asks before
  // it treats a 429 as an account's usage limit.
  if (providers !== undefined) context.providers = providers;
  // The login surface is found by looking for it rather than by asking the
  // caller for it: the daemon's catalog is the model runtime, which has it, and
  // a test double that has not just means the login routes answer
  // `login_unavailable` instead of failing at boot.
  const modelLogin = new ModelLoginService({
    models: options.models,
    ...(providers === undefined ? {} : { ownerOf: (providerId: string) => providers.ownerOf(providerId) }),
    audit: options.audit,
    logger: options.logger,
    secrets: options.secrets,
    recordFile: options.paths.modelLoginsFile,
    deviceIdFile: join(options.paths.stateDir, DEVICE_ID_FILE_NAME),
    ...(options.modelLogin?.sessionTimeoutMs === undefined
      ? {}
      : { sessionTimeoutMs: options.modelLogin.sessionTimeoutMs }),
    ...(options.modelLogin?.finishedRetentionMs === undefined
      ? {}
      : { finishedRetentionMs: options.modelLogin.finishedRetentionMs }),
  });
  const ui = new UiRegistry({ events: options.events, logger: options.logger });
  const loader = new ExtensionLoader({
    extensionsDir: options.paths.extensionsDir,
    registry,
    logger: options.logger,
    coreFactory: (name) => {
      const bundled = bundledExtension(name);
      return bundled === undefined ? undefined : () => bundled.create(context);
    },
    sealSections: (extension) => wrapSections(extension, sections),
    onToolTags: (name, tags) => toolTags.declare(name, tags),
    ...(providers === undefined ? {} : { providers }),
    ui,
    // Every load pass, including a reload that removed a provider, ends with a
    // check that each vmodel still names a model the catalog has. A warning, not
    // a stop: the requests on that vmodel fail and the log says why.
    afterLoad: () => {
      warnMissingVmodels({ config: getConfig(), models: options.models, logger: options.logger });
      // The judge check reads each provider's credential, which is asynchronous,
      // so its lines land just after the load pass instead of inside it. It is
      // a warning either way: a judge nothing can call does not stop the daemon.
      void judges.warnMissing().catch((error) => options.logger.warn("judge catalog check failed", { error }));
    },
  });
  context.reloadExtensions = () => loader.reload();
  if (options.loadExtensions ?? true) {
    await loader.loadAll();
    if (options.watchExtensions ?? false) loader.startWatching();
  }

  const scheduler = new Scheduler({ context });
  const janitor = new Janitor({
    privateTmp: hasPrivateTmp(),
    maxAgeHours: currentConfig.tmp.maxAgeHours,
    maxBytes: currentConfig.tmp.maxBytes,
    eagerThresholdBytes: currentConfig.tmp.eagerThresholdBytes,
    cacheDir: options.paths.cacheDir,
    logger: options.logger,
  });
  // The registry's buildfs caches. Its settings are read at each check, so a
  // reload that moves the registry root or the keep count reaches the next one,
  // and its failure is one warning line: a cache that was not refreshed has
  // nothing to tell a user, and the next check tries again.
  const buildfsRefresher = new BuildfsRefresher({
    settings: () => registrySettings(getConfig()),
    log: (line) => options.logger.warn(line),
  });
  if (options.loadExtensions ?? true) {
    scheduler.start();
    // The remote machines' heartbeat. Started here rather than in the manager's
    // constructor, because a boot that loads no extension (a test, a diagnostic
    // command) must not open a timer that outlives the call.
    remoteMachines.start();
    if (currentConfig.tmp.cleanup) janitor.start();
    buildfsRefresher.start();
    // One timer to the next `archive.sweepAt`. Boot runs no sweep of its own: a
    // daemon that was down at that time skips the day rather than catching up, so
    // a restart is not a second sweep.
    archivist.start();
    // The first pass over settled children is what turns a silent failure into a
    // note to the parent, so it runs on a fixed interval rather than at boot
    // only. Its interval is a constant in the extension; no setting can turn it
    // off, and no setting is needed to make it work.
    context.subagents?.startStallWatch();
    // The usage-limit hold watch. Its first pass reads the hold documents, so a
    // daemon restarted in the middle of a hold closes the same conversations to
    // input before the first request can arrive.
    context.usageFreeze?.startWatch();
  }

  // The root conversation is prepared here, once, before the harness resumes
  // tasks and before the server can answer a request. The chat page's two `GET`
  // routes only read the root, so its creation, its model and its tool filter
  // have to happen somewhere else: this is that place. It writes storage only and
  // calls no model, so a daemon with no model credential still boots.
  // Setup mode (an empty `agent.vmodel`) has no root model to prepare, and that
  // is not a failure: the reload that ends setup mode prepares the root.
  if ((options.prepareRoot ?? true) && !isModelSetupMode(currentConfig)) {
    try {
      await resolveDefaultConversation(harness, currentConfig, options.paths, BACKGROUND_CONTEXT);
    } catch (error) {
      // A failed preparation is not a reason to refuse to boot: the first write
      // route creates the root the way it always did, and the two read routes
      // answer `root_missing` until then.
      options.logger.warn("root conversation preparation failed", { error });
    }
  }

  harness.resume();

  // Boot repair, after the tasks left by the previous process have been
  // re-dispatched: the counter is recomputed from the records, an agent whose
  // work vanished is reported rather than left pretending to run, and a finished
  // agent's row is released so it cannot hold a slot forever.
  let bootRepair: Promise<void> | undefined;
  if (options.loadExtensions ?? true) {
    // Not awaited: boot must not block on it. `close()` waits for it before it
    // returns, because the passes below write under `state/` and a caller that
    // removes that tree behind the close would race them.
    bootRepair = (async () => {
      try {
        const result = await context.subagents?.reconcile(BACKGROUND_CONTEXT);
        if (result !== undefined) options.logger.info("subagent reconcile", result);
      } catch (error) {
        options.logger.warn("subagent reconcile failed", { error });
      }
      // A body written before drafts moved under `state/` is still under
      // `cache/`, which the cleanup pass empties on an age. The move runs before
      // the sweep, so the sweep reads the paths the rows end up with.
      try {
        const relocated = await context.drafts?.relocate(BACKGROUND_CONTEXT);
        if (relocated !== undefined && relocated.moved > 0) {
          options.logger.info("draft relocate", relocated);
        }
      } catch (error) {
        options.logger.warn("draft relocate failed", { error });
      }
      try {
        const swept = await context.drafts?.sweep(BACKGROUND_CONTEXT, jobs);
        if (swept !== undefined && (swept.retired > 0 || swept.orphanFiles > 0)) {
          options.logger.info("draft sweep", swept);
        }
      } catch (error) {
        options.logger.warn("draft sweep failed", { error });
      }
      // The attachment roots hold real files, so a row going away does not remove
      // one. This pass drops what no live job can read, what lost its body, and
      // what no row indexes. Warn only: boot must not wait for it.
      try {
        const liveJobIds = new Set(
          (await jobs.list(BACKGROUND_CONTEXT)).map((job) => job.id),
        );
        const attachments = await sweepAttachments(
          {
            storage: options.storage,
            harness,
            audit: options.audit,
            jobs,
            context: BACKGROUND_CONTEXT,
            // The roots are configuration, so the sweep reads the same two
            // directories the tools and the routes do.
            getConfig,
          },
          liveJobIds,
        );
        if (attachments.dropped > 0 || attachments.orphanFiles > 0) {
          options.logger.info("attachment sweep", { ...attachments });
        }
      } catch (error) {
        options.logger.warn("attachment sweep failed", { error });
      }
      // Context files outlive the agents that wrote them, so nothing removes them
      // as a side effect of anything else. This is the only pass that does.
      try {
        const agents = await sweepContextFiles({
          harness,
          storage: options.storage,
          paths: options.paths,
          context: BACKGROUND_CONTEXT,
        });
        if (agents.removed > 0) options.logger.info("context file sweep", { ...agents });
      } catch (error) {
        options.logger.warn("context file sweep failed", { error });
      }
    })();
  }

  return {
    harness,
    registry,
    storage: options.storage,
    paths: options.paths,
    secrets: options.secrets,
    models: options.models,
    logger: options.logger,
    audit: options.audit,
    events: options.events,
    jobs,
    inbox,
    reports,
    drafts,
    archive,
    archivist,
    restart,
    sections,
    migrations,
    scheduler,
    loader,
    ui,
    modelLogin,
    ...(providers === undefined ? {} : { providers }),
    janitor,
    buildfsRefresher,
    subagents: context.subagents,
    usage,
    usageFreeze: context.usageFreeze,
    focusedChats,
    remoteMachines,
    getConfig,
    setConfig: (next) => {
      currentConfig = next;
      // The manager reads the config on every use, so nothing is copied here. What
      // it must hear about is the change itself: a block that the new config or a
      // newly pinned key makes obsolete ends here, and an open page is told to
      // re-read the list. Not awaited: `setConfig` is synchronous and a reload
      // route has nothing to do with this work.
      void remoteMachines.configChanged().catch((error) => {
        options.logger.warn("remote machines config change failed", { error });
      });
    },
    close: async () => {
      await scheduler.drain();
      // Before the harness closes: a connection this daemon opened is closed here,
      // and `-O exit` is an ssh call of its own.
      await remoteMachines.close().catch((error) => {
        options.logger.warn("remote machines close failed", { error });
      });
      await bootRepair;
      janitor.stop();
      buildfsRefresher.stop();
      archivist.stop();
      context.subagents?.stopStallWatch();
      context.usageFreeze?.stopWatch();
      loader.stopWatching();
      await harness.close(BACKGROUND_CONTEXT);
      // The process handle goes with the runtime that set it. A second runtime in
      // the same process (which tests do) keeps its own: only the handle that
      // still points at this advice is cleared.
      if (getContextAdvice() === contextAdvice) setContextAdvice(undefined);
      focusedChats.close();
      modelCalls?.close();
      if (ownedArchive) await archiveSession.close(BACKGROUND_CONTEXT);
    },
  };
}

export type { Extension };
