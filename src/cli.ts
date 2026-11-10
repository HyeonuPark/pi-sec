#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels, syntheticCatalogOf } from "./agent/models.ts";
import { readModelsJsonProviderIds, writeModelCatalogFile } from "./agent/model-catalog-file.ts";
import { createSyntheticCatalog } from "./agent/synthetic-catalog.ts";
import { createAgentRuntime } from "./agent/harness.ts";
import { checkRootVmodel, isModelSetupMode } from "./agent/model-setup.ts";
import { createConfigReloader } from "./server/config-reload.ts";
import { defaultPromptDir, PromptFiles, VmodelResolver, vmodelEntry } from "./agent/vmodel.ts";
import { loadConfig, renderDefaultConfig, ConfigError } from "./config/load.ts";
import type { Config, VmodelConfig } from "./config/schema.ts";
import {
  buildSetupModelPlan,
  firstModelOutsideCatalog,
  SETUP_MODEL_PROMPT,
  THINKING_LEVELS,
  writeSetupModel,
  type ThinkingLevel,
} from "./config/write.ts";
import { ProviderRegistry, preloadExtensionProviders, type ProvidersLogger } from "./registry/providers.ts";
import {
  jobIdFromWorktreeName,
  registryPaths,
  registrySettings,
  type RegistrySettings,
} from "./registry/layout.ts";
import {
  doctorRegistry,
  listRegistry,
  listRepoIds,
  registerInPlace,
  registerRepo,
  showRepo,
  topLevelNames,
  type RegistryListing,
} from "./registry/store.ts";
import { addWorktree, fastForward, refillBuildfs, removeWorktree } from "./registry/worktree.ts";
import { pruneAll, refreshCaches } from "./registry/refresh.ts";
import { ArchiveStore } from "./jobs/archive.ts";
import { JobRegistry } from "./jobs/registry.ts";
import { openPrivateSqliteStorage } from "./runtime/sqlite-file.ts";
import { AdminNotes } from "./runtime/notes.ts";
import { buildPaths, ensureLayout, expandPath, resolveHome, type Paths } from "./runtime/paths.ts";
import { createLogger } from "./runtime/logger.ts";
import { createAuditLog, readAuditTail } from "./runtime/audit.ts";
import { createEventBus } from "./runtime/event-bus.ts";
import { openStorage, readSchemaVersion, writeSchemaVersion } from "./runtime/storage.ts";
import { RestartLauncher, reportPendingRestart } from "./runtime/restart-helper.ts";
import { realTimers, runShutdown } from "./runtime/shutdown.ts";
import { collectWaitingWork, notifyRestartNotice } from "./runtime/restart-notice.ts";
import { readCodeDrift, rebuildWebAssets, UiAssetError } from "./runtime/ui-assets.ts";
import { acquireDaemonLock, DaemonLockHeldError, type DaemonLock } from "./runtime/daemon-lock.ts";
import { readPid } from "./runtime/supervisor.ts";
import { SecretRegistry } from "./secrets/registry.ts";
import {
  migrateModelCredentials,
  ModelCredentialStore,
  type MigrateModelCredentialsResult,
  type ModelCredentialLog,
} from "./secrets/model-credentials.ts";
import { SseHub } from "./server/sse.ts";
import { StreamHub } from "./server/streams.ts";
import { defaultWebDir, startServer } from "./server/server.ts";
import type { AppDeps, AdminState } from "./server/deps.ts";
import { VERSION } from "./version.ts";

interface Flags {
  readonly [key: string]: string | boolean;
}

function parseFlags(args: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[name!] = inline;
      else if (args[index + 1] !== undefined && !args[index + 1]!.startsWith("--")) {
        flags[name!] = args[index + 1]!;
        index += 1;
      } else flags[name!] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function loadSecrets(paths: ReturnType<typeof buildPaths>, config: Awaited<ReturnType<typeof loadConfig>>["config"]) {
  const secrets = new SecretRegistry({
    dir: expandPath(config.secrets.dir),
    dummyFormat: config.secrets.dummyFormat,
    encodings: config.secrets.redactEncodings,
    includeModelCredentials: config.secrets.includeModelCredentials,
    modelCredentialPaths: config.secrets.modelCredentialPaths,
    onWarning: (message) => process.stderr.write(`warning: ${message}\n`),
  });
  await secrets.load();
  return secrets;
}

/**
 * The logging surface of the commands that run without the daemon.
 *
 * `models` and `setup-model` write one line per problem to stderr and
 * carry on, which is what a person at a terminal can act on. No message and no
 * field ever carries a credential value.
 */
const stderrLogger: ProvidersLogger = {
  warn: (message, fields) => process.stderr.write(`warning: ${message} ${JSON.stringify(fields ?? {})}\n`),
  info: (message, fields) => process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
};

function notifySystemd(message: string): void {
  const socket = process.env.NOTIFY_SOCKET;
  if (socket === undefined) return;
  spawnSync("systemd-notify", [message], { stdio: "ignore" });
}

export { rootVmodelProblem } from "./agent/model-setup.ts";

async function commandStart(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const env = process.env;
  const paths = buildPaths(resolveHome(env));
  await ensureLayout(paths);

  let loaded;
  try {
    loaded = await loadConfig({ home: paths.home });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`pi-sec: invalid configuration\n${error.issues.map((issue) => `  - ${issue}`).join("\n")}\n`);
      return 2;
    }
    throw error;
  }
  const config = loaded.config;
  if (flags["port"] !== undefined) config.server.port = Number(flags["port"]);
  if (flags["bind"] !== undefined) config.server.bind = String(flags["bind"]);

  // One daemon per home, decided before anything of this one exists. The order
  // is the whole point: `openStorage` migrates the database and the runtime
  // resumes unfinished work on the way up, so a second process has already
  // written by the time the port would refuse it. A lock that outlives its
  // holder cannot do this job either, so the check is a held kernel resource:
  // the pid file survives a crash and names whatever the pid was reused for.
  let lock: DaemonLock;
  try {
    lock = acquireDaemonLock(paths.daemonLockFile);
  } catch (error) {
    if (error instanceof DaemonLockHeldError) {
      const owner = await readPid(paths.pidFile);
      process.stderr.write(
        `pi-sec: another pi-sec daemon is running on this home (${paths.home}, pid ${owner ?? "unknown"}); not starting\n`,
      );
      return 1;
    }
    throw error;
  }
  // The early returns below, and the shutdown handler further down, both end the
  // process; this one call covers whichever of them gets there first.
  process.once("exit", () => lock.release());

  // Before the first registry load: values that are still inline in auth.json
  // move to the secret store once, so the registry reads them from their files.
  // The logger needs the registry, so the move reports to stderr first and to
  // the app log once the logger exists. Neither line carries a value.
  const secretsDir = expandPath(config.secrets.dir);
  const pendingLines: Parameters<ModelCredentialLog>[] = [];
  const migration: MigrateModelCredentialsResult = await migrateModelCredentials({
    authPath: paths.authFile,
    secretsDir,
    log: (level, message, fields) => {
      pendingLines.push([level, message, fields]);
      process.stderr.write(`${level}: ${message} ${JSON.stringify(fields ?? {})}\n`);
    },
  });

  const secrets = await loadSecrets(paths, config);
  const logger = createLogger({
    file: paths.appLog,
    level: config.logging.level,
    maxBytes: config.logging.maxBytes,
    retainFiles: config.logging.retainFiles,
    redactor: () => secrets.redactor(),
  });
  const audit = createAuditLog({
    file: paths.auditLog,
    maxBytes: config.audit.maxBytes,
    retainDays: config.audit.retainDays,
    redactor: () => secrets.redactor(),
  });

  for (const [level, message, fields] of pendingLines) logger[level](message, fields);
  if (migration.status === "migrated" || migration.status === "conflict") {
    audit.append({
      type: "model_credentials_move",
      status: migration.status,
      files: migration.status === "migrated" ? migration.moved.map((entry) => entry.file) : migration.conflicts,
    });
  }

  let models;
  try {
    models = await createModels({
      authPath: paths.authFile,
      modelsPath: paths.modelsFile,
      secretsDir,
      onCredentialsChanged: () => secrets.reload(),
      onResolvedCredential: (entry) => secrets.addValues([entry]),
      log: (level, message, fields) => logger[level](message, fields),
      // The stored list is registered before this returns, so the root vmodel
      // check below sees the models the last read named. The read of the
      // service's list starts after that and does not hold the boot.
      syntheticCatalog: { stateDir: paths.stateDir, network: true },
    });
  } catch (error) {
    logger.error("failed to create model runtime", { error });
    return 2;
  }
  // Runtime extensions may provide models, and the root vmodel may name one of
  // them. Register their providers before anything reads the catalog: the check
  // below is a catalog lookup, so without this step a home whose root model comes
  // from an extension would refuse to boot. The agent runtime further down takes
  // this same registry, so its full load replaces these entries instead of
  // registering the same ids a second time.
  const providers = new ProviderRegistry({ host: models, logger });
  try {
    await preloadExtensionProviders({ extensionsDir: paths.extensionsDir, registry: providers, logger });
  } catch (error) {
    // Each extension's own failure is already one warning line. Only a fault of
    // the directory itself reaches here, and the boot's own extension load
    // reports it again; the daemon still serves with the catalog it has.
    logger.warn("extension provider preload failed", { error });
  }

  // Fail closed here rather than at the first message. A vmodel that does not
  // exist, or whose prompt file is missing, would otherwise leave a daemon that
  // reports ready and then fail every request; and the failure would land in a
  // prompt section, where a throw is reported and the section is simply absent.
  // The one state that passes without a model is an empty `agent.vmodel`: the
  // daemon then runs in setup mode and the web page asks for the first model. A
  // name that is set and cannot be used still stops here.
  const rootCheck = await checkRootVmodel(config, paths, models);
  if (!rootCheck.ok) {
    if (rootCheck.kind === "catalog") {
      logger.error("configured model is not in the catalog", { model: rootCheck.model });
    } else {
      logger.error("the configured vmodel is not usable", { problem: rootCheck.problem });
    }
    return 2;
  }
  const setupMode = isModelSetupMode(config);
  if (setupMode) logger.warn("no root model is configured; serving the model setup notice");

  const bundle = await openStorage(paths);
  await writeSchemaVersion(paths, bundle.schemaVersion);

  const bus = createEventBus();
  const runtime = await createAgentRuntime({
    paths,
    config,
    storage: bundle.storage,
    models,
    secrets,
    logger,
    audit,
    events: bus.sink,
    loadExtensions: true,
    watchExtensions: true,
    providers,
  });

  // A person who edits `vmodels` by hand reads this list. It is written once
  // per boot, after the extensions are loaded so a provider an extension
  // registered is in it, and nothing in pi-sec reads it back. Boot does not
  // wait for the write and a failure is one warning line: the file is a
  // reference, not a dependency.
  void writeModelCatalogFile({
    models,
    providers,
    modelsJsonFile: paths.modelsFile,
    file: paths.modelCatalogFile,
    timezone: config.timezone,
  }).catch((error) => logger.warn("model catalog not written", { path: paths.modelCatalogFile, error }));

  const adminState: AdminState = { restart: runtime.restart, notes: new AdminNotes() };

  // A restart asked for from the web UI can fail halfway and leave the daemon
  // down. The process that comes up next is the only place to say so: nobody was
  // watching a terminal when it happened.
  const pending = await reportPendingRestart(paths.runDir, adminState.notes, paths.logsDir);
  if (pending !== undefined) {
    logger.warn("previous restart did not finish", { at: pending.at, source: pending.source });
    audit.append({ type: "restart_incomplete", at: pending.at, source: pending.source });
  }

  // Under `user-tools/run` there is no unit to hand the script to: the request
  // ends this process with the code the runner reads as "update and come back".
  // The function is filled in by the promise below, which owns the shutdown: the
  // launcher is built before the server listens, and nothing may end the process
  // before there is something to close.
  let stopForRunner: ((code: number) => void) | undefined;
  const restart = new RestartLauncher({
    home: paths.home,
    workspaceTree: paths.workspaceTree,
    snapshotTree: paths.snapshotTree,
    logsDir: paths.logsDir,
    runDir: paths.runDir,
    env: process.env,
    nodePath: process.execPath,
    exitForRunner: (code) => stopForRunner?.(code),
  });
  const sse = new SseHub({
    heartbeatMs: config.server.sse.heartbeatMs,
    queueBytes: config.server.sse.queueBytes,
    bufferMs: config.server.sse.bufferMs,
  });
  // One answer to "where are the web assets served from": the swap target and the
  // static route read the same directory.
  const webDir = defaultWebDir();
  const deps: AppDeps = {
    runtime,
    bus,
    sse,
    streams: new StreamHub({ runtime, bus, sse }),
    startedAt: Date.now(),
    version: VERSION,
    webDir,
    adminState,
    restart,
    uiRestart: {
      async run() {
        // The source is the workspace working tree, not the committed revision:
        // the point of the button is to see an edit before it is committed. The
        // served pages are bundles, so the swap copies `src/web` into a staging
        // directory beside the served tree and has the workspace's own build
        // script write the page bundles into that directory before anything is
        // moved. The target is the directory this process serves from, which is
        // inside the execution tree, and the drift check compares that tree's
        // commit with the workspace's.
        const workspace = runtime.getConfig().agent.workspace;
        const source = join(workspace, "src", "web");
        try {
          const synced = await rebuildWebAssets({ workspaceDir: workspace, targetDir: webDir });
          // `webDir` is `<execution tree>/dist/web`, so its root is two levels up.
          const codeDrift = await readCodeDrift({ workspaceDir: workspace, snapshotDir: resolve(webDir, "../..") });
          return { ok: true, copied: synced.copied, uiHash: synced.uiHash, source, target: webDir, codeDrift };
        } catch (error) {
          // A refusal about the trees or a build of the workspace's code is an
          // outcome the route reports; anything else is a fault of this daemon
          // and is left to reach the route as a 500 with its own message.
          if (error instanceof UiAssetError) {
            // The code and the `restored` flag travel to the page. The detail
            // does not: the route answers one fixed sentence per code, and the
            // detail is the part that names where the previous tree ended up or
            // which line of the workspace failed to build, so it goes to the log
            // where an operator can read it.
            logger.warn("ui assets not swapped", { code: error.code, restored: error.restored, reason: error.message });
            return { ok: false, code: error.code, restored: error.restored };
          }
          throw error;
        }
      },
    },
    reloadConfig: createConfigReloader({ home: paths.home, runtime }),
  };

  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer(deps);
  } catch (error) {
    // The entry point answers a rejected `main` with an exit code alone, and by
    // now the storage, the scheduler and the watchdog hold the event loop open:
    // the process would stay up with no port, holding the lock and the database
    // as a daemon that cannot serve. So the failure shuts down here, in the
    // order a signal takes, and only then reports.
    process.stderr.write(`pi-sec: ${String(error)}\n`);
    syntheticCatalogOf(models)?.stop();
    try {
      await runtime.close();
    } catch (closeError) {
      logger.error("shutdown error", { error: closeError });
    }
    // The pid file is left alone: this process never wrote one, and the file on
    // disk belongs to the daemon whose port this one could not have.
    lock.release();
    // Whatever a dependency forgot to unref would keep the loop alive for good.
    // The work is over, so a late exit is the right answer, and it is late
    // enough that the error above reaches a pipe instead of a closed descriptor.
    setTimeout(() => process.exit(1), 2_000).unref();
    return 1;
  }
  // The stop handlers are installed before the pid file is written, because the
  // pid file is how a supervisor, a test, or an operator reads "ready": from the
  // moment it exists a signal must end this process through `shutdown`. Node's
  // default action ends it with the pid file, the storage and the lock left
  // behind. The restart notice below can take seconds on a large audit trail,
  // and a signal that arrives inside that wait reaches these handlers too. The
  // promise they settle is made here and awaited after the notice, so the boot
  // that is already ending still reports the code the shutdown chose.
  let settleStop: ((code: number) => void) | undefined;
  const stopped = new Promise<number>((resolve) => {
    settleStop = resolve;
  });
  let shuttingDown = false;
  // The exit code is 0 for SIGTERM and SIGINT, and the runner's own code when a
  // restart request ended the process instead.
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("pi-sec stopping", { signal });
    audit.append({ type: "server_stop", signal });
    // Nothing may read the model list after the runtime it registers into has
    // gone; the interval is cleared here, before either close.
    syntheticCatalogOf(models)?.stop();
    await runShutdown({
      code,
      log: logger,
      exit: (exitCode) => process.exit(exitCode),
      timers: realTimers,
      steps: [
        { name: "server", run: () => started.close(), done: "server closed" },
        { name: "runtime", run: () => runtime.close(), done: "runtime closed" },
      ],
      release: async () => {
        await rm(paths.pidFile, { force: true });
        // Last, after the pid file is gone: a start that took the lock from here
        // would otherwise find this process's pid still on disk and write its own
        // over a file that this process then deletes.
        lock.release();
      },
    });
    settleStop?.(code);
  };
  // Set before the signal handlers, so the restart route can reach it from the
  // moment the server answers: the route calls it once the 202 is flushed.
  stopForRunner = (code) => void shutdown("runner-restart", code);
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => {
    void runtime.loader.reload().catch((error) => logger.warn("extension reload failed", { error }));
  });

  // A pid file that outlived its process is the trace of an exit that skipped
  // shutdown: the handler above removes the file, so a clean stop leaves none.
  // Read it before this process writes its own pid over the answer.
  const previousPid = await readPid(paths.pidFile);
  // A signal that came while the pid was read has started the shutdown: writing
  // the pid file now would leave it behind a process that is ending.
  if (shuttingDown) return await stopped;
  await writeFile(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  logger.info("pi-sec started", {
    origin: started.origin,
    pid: process.pid,
    vmodel: config.agent.vmodel,
    ...(setupMode ? { mode: "model setup" } : {}),
  });
  audit.append({ type: "server_start", pid: process.pid, origin: started.origin });
  notifySystemd("READY=1");

  // Before the notice, not after it: reading the audit tail parses the whole
  // active file, and a watchdog ping must not wait behind that read.
  const watchdog = flags["watchdog"] === true;
  const watchdogTimer = watchdog
    ? setInterval(() => notifySystemd("WATCHDOG=1"), 30_000)
    : undefined;
  watchdogTimer?.unref?.();

  // The process that comes up is the only place a restart can be reported, and
  // the root conversation is the only reader that matters. The notice holds the
  // boot until the submission is admitted and no longer; a failure here must
  // never keep the daemon down, so it is caught and only logged. The stop
  // handlers are already installed, so a signal that arrives while this waits
  // takes the shutdown and ends the boot through it.
  // The same gap reaches here: a signal that arrived while the pid file was
  // written has started the shutdown, and a notice now would outlive it.
  if (shuttingDown) return await stopped;
  try {
    await notifyRestartNotice({
      harness: runtime.harness,
      pid: process.pid,
      startedAt: deps.startedAt,
      // The boot's own config: the notice is written once, before any reload.
      timezone: config.timezone,
      previousPid,
      snapshotTree: paths.snapshotTree,
      auditFile: paths.auditLog,
      appendAudit: (event) => audit.append(event),
      // The two lists are read here, at the boot, and only if the notice is
      // written: a job that waits for an approval and an agent that parked with
      // `await_orders` do not resume by themselves, and the root is the only
      // reader that can resume them.
      readWaitingWork: (noticeCtx) =>
        collectWaitingWork({ jobs: runtime.jobs, subagents: runtime.subagents, ctx: noticeCtx }),
      logger,
    });
  } catch (error) {
    logger.warn("restart notice failed", { error });
  }

  // The promise the handlers above settle. A shutdown that a signal started
  // during the notice already resolved it, so this returns at once with the code
  // the shutdown chose.
  return await stopped;
}

async function commandStatus(): Promise<number> {
  const paths = buildPaths(resolveHome());
  let pid: number | undefined;
  try {
    pid = Number.parseInt((await readFile(paths.pidFile, "utf8")).trim(), 10);
  } catch {
    pid = undefined;
  }
  let alive = false;
  if (pid !== undefined && Number.isFinite(pid)) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  process.stdout.write(`pi-sec ${VERSION}\nhome: ${paths.home}\npid: ${pid ?? "(none)"} ${alive ? "(running)" : "(not running)"}\n`);
  return alive ? 0 : 1;
}

/**
 * The names the core conventions tell every agent to use.
 *
 * The conventions say to spawn with `vmodel: "orchestrator"`, `"planner"` or
 * `"worker"`, and the root role file names roles `orchestrator`, `planner` and
 * `worker` the same way. A config or a prompt tree without one of them fails at
 * spawn, inside a subagent the user may not be watching, so the install check
 * reports it.
 */
const CONVENTION_VMODELS = ["orchestrator", "planner", "worker"] as const;
const CONVENTION_ROLES = ["orchestrator", "planner", "worker"] as const;

type DoctorCatalog = Awaited<ReturnType<typeof openCatalog>>;

/**
 * One line for one vmodel: its model in the catalog, and its prompt file.
 *
 * A prompt file that cannot be read replaces "readable" with the same error the
 * spawn would raise, and the next vmodel is still checked: one broken entry must
 * not hide the rest of what is wrong with the install.
 */
async function vmodelDoctorLine(
  key: string,
  entry: VmodelConfig,
  prompts: PromptFiles,
  catalog: DoctorCatalog | undefined,
): Promise<string> {
  const model = `${entry.provider}/${entry.modelId}`;
  const inCatalog =
    catalog === undefined
      ? "catalog unreadable"
      : catalog.runtime.getModel(entry.provider, entry.modelId) !== undefined
        ? "in the catalog"
        : "not in the catalog";
  let prompt: string;
  try {
    await prompts.read("vmodel", entry.prompt);
    prompt = `${entry.prompt}.md readable`;
  } catch (error) {
    prompt = error instanceof Error ? error.message : String(error);
  }
  return `vmodel ${key}: ${model} ${inCatalog}, prompt ${prompt}`;
}

async function commandDoctor(): Promise<number> {
  const env = process.env;
  const paths = buildPaths(resolveHome(env));
  const lines: string[] = [`pi-sec ${VERSION} doctor`, `home: ${paths.home}`];
  try {
    const loaded = await loadConfig({ home: paths.home });
    lines.push(`config: valid (${loaded.source})`);
    const config = loaded.config;
    const prompts = new PromptFiles([paths.promptsDir, defaultPromptDir()]);
    // The same catalog `pi-sec models` lists and `setup-model` refuses against.
    // Read-only and offline: it answers "does this home know that model" only.
    let catalog: DoctorCatalog | undefined;
    try {
      catalog = await openCatalog(paths, config);
    } catch (error) {
      lines.push(`catalog: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
    const keys = new VmodelResolver({ getConfig: () => config, paths }).keys().sort();
    for (const key of keys) {
      lines.push(await vmodelDoctorLine(key, vmodelEntry(config, key), prompts, catalog));
    }
    if (isModelSetupMode(config)) {
      lines.push(
        "setup mode: agent.vmodel is empty, so the daemon starts with no root model and the web page asks for one; " +
          "run `pi-sec setup-model --provider <id> --model <id>` or choose a model on the web page",
      );
    } else if (!Object.hasOwn(config.vmodels, config.agent.vmodel)) {
      lines.push(`warning: agent.vmodel "${config.agent.vmodel}" is not in config.vmodels`);
    }
    const resolver = new VmodelResolver({ getConfig: () => config, paths });
    try {
      await resolver.rolesText(config.agent.roles);
      lines.push(`prompt: ${config.agent.roles.length} root role file(s) readable`);
    } catch (error) {
      lines.push(`prompt: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of CONVENTION_VMODELS) {
      if (Object.hasOwn(config.vmodels, name)) continue;
      lines.push(`warning: the conventions spawn agents with vmodel "${name}", and config.vmodels has no such key`);
    }
    // The root's own rules live in "root-agent" since the role split, and a
    // list that names "user-facing-agent" alone reads the shared file only. The
    // daemon still starts, so the loss shows up as missing rules at run time;
    // this line is the place an install notices it.
    if (config.agent.roles.includes("user-facing-agent") && !config.agent.roles.includes("root-agent")) {
      lines.push(
        `warning: agent.roles has "user-facing-agent" but no "root-agent", so the root lost its root-only rules: add "root-agent" to agent.roles before "user-facing-agent"`,
      );
    }
    for (const name of CONVENTION_ROLES) {
      let readable = true;
      try {
        await prompts.read("role", name);
      } catch {
        readable = false;
      }
      if (readable) continue;
      lines.push(`warning: the conventions spawn agents with role "${name}", and no role file "${name}.md" is readable`);
    }
    lines.push(`bind: ${config.server.bind}:${config.server.port}`);
  } catch (error) {
    lines.push(`config: INVALID — ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof ConfigError) for (const issue of error.issues) lines.push(`  - ${issue}`);
  }
  const version = await readSchemaVersion(paths);
  lines.push(`storage: ${paths.stateDb} (schema ${version ?? "unset"})`);
  try {
    const secrets = new SecretRegistry({
      dir: paths.secretsDir,
      includeModelCredentials: false,
    });
    await secrets.load();
    lines.push(`secrets: ${secrets.names().length} registered`);
    for (const warning of secrets.diagnostics()) lines.push(`  warning: ${warning}`);
  } catch (error) {
    lines.push(`secrets: FAIL CLOSED — ${String(error)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function commandConfig(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args);
  if (flags["default"] === true) {
    process.stdout.write(renderDefaultConfig());
    return 0;
  }
  const paths = buildPaths(resolveHome());
  const loaded = await loadConfig({ home: paths.home });
  process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
  return 0;
}

async function commandDb(): Promise<number> {
  const paths = buildPaths(resolveHome());
  const version = await readSchemaVersion(paths);
  process.stdout.write(`${paths.stateDb}\nschema version: ${version ?? "(unset)"}\n`);
  return 0;
}

async function commandMigrate(): Promise<number> {
  const paths = buildPaths(resolveHome());
  await ensureLayout(paths);
  const bundle = await openStorage(paths);
  await writeSchemaVersion(paths, bundle.schemaVersion);
  await bundle.close();
  process.stdout.write(`migrated storage to schema ${bundle.schemaVersion}\n`);
  return 0;
}

async function commandAudit(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const paths = buildPaths(resolveHome());
  const limit = Number(flags["limit"] ?? 50);
  const events = await readAuditTail(paths.auditLog, undefined, Number.isFinite(limit) ? limit : 50);
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  return 0;
}

/**
 * The catalog a command reads: the model runtime, with the providers runtime
 * extensions export registered first, exactly as `pi-sec start` does it.
 */
export async function openCatalog(
  paths: ReturnType<typeof buildPaths>,
  config: Config,
): Promise<{ runtime: ModelRuntime; providers: ProviderRegistry }> {
  const secretsDir = expandPath(config.secrets.dir);
  const runtime = await ModelRuntime.create({
    authPath: paths.authFile,
    modelsPath: paths.modelsFile,
    allowModelNetwork: false,
    credentials: new ModelCredentialStore({
      authPath: paths.authFile,
      secretsDir,
      log: (level, message, fields) => process.stderr.write(`${level}: ${message} ${JSON.stringify(fields ?? {})}\n`),
    }),
  });
  // The stored list, and no read of the service: `pi-sec models` and
  // `pi-sec doctor` answer from what is on disk, so they work with no network
  // and cost nothing. A home that never stored a list registers the one model
  // the code carries, as the daemon does before its first read.
  createSyntheticCatalog({
    models: runtime,
    stateDir: paths.stateDir,
    log: (level, message, fields) =>
      level === "warn" ? stderrLogger.warn(message, fields) : stderrLogger.info?.(message, fields),
  }).registerStoredOrFallback();
  const providers = new ProviderRegistry({ host: runtime, logger: stderrLogger });
  try {
    await preloadExtensionProviders({ extensionsDir: paths.extensionsDir, registry: providers, logger: stderrLogger });
  } catch (error) {
    process.stderr.write(`warning: extension providers were not read ${JSON.stringify({ error: String(error) })}\n`);
  }
  return { runtime, providers };
}

async function loadConfigForCommand(paths: ReturnType<typeof buildPaths>): Promise<Config | undefined> {
  try {
    return (await loadConfig({ home: paths.home })).config;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`pi-sec: invalid configuration\n${error.issues.map((issue) => `  - ${issue}`).join("\n")}\n`);
      return undefined;
    }
    throw error;
  }
}

/**
 * List every model the catalog holds, one line per model.
 *
 * Read-only: it creates the model runtime, registers what extensions export, and
 * prints. The source of each model is the topmost layer that defines its
 * provider, which is the order the runtime composes them in: an extension over
 * `models.json` over the built-in catalog.
 */
async function commandModels(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const paths = buildPaths(resolveHome(process.env));
  await ensureLayout(paths);
  const config = await loadConfigForCommand(paths);
  if (config === undefined) return 2;

  const { runtime, providers } = await openCatalog(paths, config);
  const fromModelsJson = await readModelsJsonProviderIds(paths.modelsFile);
  const only = typeof flags["provider"] === "string" ? flags["provider"] : undefined;
  const available = runtime.getProviders();
  if (only !== undefined && !available.some((entry) => entry.id === only)) {
    process.stderr.write(`pi-sec models: no provider named "${only}". Known: ${available.map((entry) => entry.id).join(", ")}\n`);
    return 2;
  }

  for (const provider of available) {
    if (only !== undefined && provider.id !== only) continue;
    const owner = providers.ownerOf(provider.id);
    const source = owner !== undefined ? `extension:${owner}` : fromModelsJson.has(provider.id) ? "models.json" : "builtin";
    const auth = runtime.getProviderAuthStatus(provider.id).configured ? "yes" : "no";
    for (const model of runtime.getModels(provider.id)) {
      process.stdout.write(`${provider.id}/${model.id}\tsource=${source}\tauth=${auth}\n`);
    }
  }
  return 0;
}

/**
 * Write the first model configuration: four vmodels and the two agent keys.
 *
 * Nothing is written unless the models exist in the catalog (after the same
 * extension-provider preload the daemon runs) and no vmodel is overwritten
 * without `--force`. A refusal leaves the file exactly as it was.
 */
async function commandSetupModel(args: readonly string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const usageLine =
    "usage: pi-sec setup-model --provider <id> --model <id> [--thinking off|minimal|low|medium|high]\n" +
    "                         [--worker-provider <id> --worker-model <id>] [--force]\n";
  const provider = typeof flags["provider"] === "string" ? flags["provider"].trim() : "";
  const modelId = typeof flags["model"] === "string" ? flags["model"].trim() : "";
  if (provider === "" || modelId === "") {
    process.stderr.write(usageLine);
    return 2;
  }
  const thinking = typeof flags["thinking"] === "string" ? flags["thinking"].trim() : "medium";
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    process.stderr.write(
      `pi-sec setup-model: unknown thinking level "${thinking}"; choose one of: ${THINKING_LEVELS.join(", ")}\n`,
    );
    return 2;
  }
  const workerProvider = typeof flags["worker-provider"] === "string" ? flags["worker-provider"].trim() : undefined;
  const workerModel = typeof flags["worker-model"] === "string" ? flags["worker-model"].trim() : undefined;
  if ((workerProvider === undefined) !== (workerModel === undefined) || workerProvider === "" || workerModel === "") {
    process.stderr.write("pi-sec setup-model: --worker-provider and --worker-model go together, and both name a value\n");
    return 2;
  }

  const paths = buildPaths(resolveHome(process.env));
  await ensureLayout(paths);
  const config = await loadConfigForCommand(paths);
  if (config === undefined) return 2;

  const { runtime } = await openCatalog(paths, config);
  const outside = firstModelOutsideCatalog(runtime, { provider, modelId, workerProvider, workerModel });
  if (outside !== undefined) {
    process.stderr.write(
      `pi-sec setup-model: the ${outside.label} model ${outside.provider}/${outside.modelId} is not in the catalog; nothing was written. ` +
        "Run `pi-sec models` to list what this home has.\n",
    );
    return 2;
  }

  const outcome = await writeSetupModel(
    paths.configFile,
    buildSetupModelPlan({
      provider,
      modelId,
      thinking: thinking as ThinkingLevel,
      workerProvider,
      workerModel,
      force: flags["force"] === true,
    }),
  );
  if (outcome.status === "refused") {
    process.stderr.write(`pi-sec setup-model: ${outcome.reason}; nothing was written\n`);
    return 2;
  }

  const worker = `${workerProvider ?? provider}/${workerModel ?? modelId}`;
  process.stdout.write(`wrote vmodels ${outcome.vmodels.join(", ")} to ${paths.configFile}\n`);
  process.stdout.write(`root and orchestrator: ${provider}/${modelId} (thinking ${thinking})\n`);
  process.stdout.write(`worker: ${worker} (thinking ${thinking})\n`);
  process.stdout.write(`agent.vmodel: root\nagent.roles: ${outcome.roles.join(", ")}\n`);
  // Every vmodel above names the shipped `prompts/vmodel/default.md`. A built
  // install has it under `dist/prompts`; a checkout that never ran a build does
  // not, and the first boot would refuse the missing prompt. A warning here is
  // the only place that says so before the boot.
  const promptFile = await new PromptFiles([paths.promptsDir, defaultPromptDir()]).locate("vmodel", SETUP_MODEL_PROMPT);
  if (promptFile === undefined) {
    process.stderr.write(
      `warning: no prompts/vmodel/${SETUP_MODEL_PROMPT}.md in this home and none in the shipped prompts; add one before starting\n`,
    );
  }
  return 0;
}

/**
 * The registry command line: `pi-sec repos ...`.
 *
 * The registry itself lives in `src/registry/`. This block is only the command
 * surface: it reads the config, turns it into `RegistrySettings` with
 * `registrySettings`, and calls one core function per subcommand, so the rules
 * (which path a name becomes, when a hook is installed, what a cache is) stay in
 * the core.
 *
 * A write command prints the object the core returned as JSON. A refusal prints
 * one line to stderr and exits 1. A command line with no subcommand, an unknown
 * one, or the wrong number of arguments prints the usage and exits 2.
 */

const REPOS_USAGE = `usage: pi-sec repos <command> [options]

Commands:
  register --name <owner>/<repo>                Make an empty bare repository and install the protection hook.
  register --in-place <git dir> --name <name>   Register a repository where it already lives.
  worktree add <repo> <name>                    Create a worktree and fill its build directories.
  worktree remove <repo> <name>                 Remove the build directories and the worktree.
  worktree refill <repo> <name>                 Empty and fill the build directories again.
  ff <repo> <branch>                            Move main forward to a branch, never backward.
  cache refresh [repo]                          Refresh the caches once.
  cache prune [repo]                            Delete the caches past the keep count.
  list [--json]                                 List repositories, worktrees and caches.
  show <repo> [--json]                          Show one repository.
  doctor [--json]                               Check the hook, the inodes and the mount options.
`;

/** Print one value as the JSON a caller parses, indented by two spaces. */
function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Report a refusal on stderr, with the exit code a refusal gets. */
function refuseRepos(message: string): number {
  process.stderr.write(`pi-sec repos: ${message}\n`);
  return 1;
}

/** Report a command line the usage does not describe, with the exit code it gets. */
function reposUsageProblem(message: string): number {
  process.stderr.write(`pi-sec repos: ${message}\n\n${REPOS_USAGE}`);
  return 2;
}

/** Align the cells of a small table, so a listing reads as a table in a terminal. */
function formatTable(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** The human-readable form of a listing: three short tables, one per kind. */
function listingLines(listing: RegistryListing): string[] {
  const lines = [`root: ${listing.root} (buildfs mode ${listing.mode})`];

  lines.push("", `repositories (${listing.repos.length}):`);
  if (listing.repos.length === 0) lines.push("  (none)");
  else {
    for (const line of formatTable([
      ["id", "branch", "hook", "git dir"],
      ...listing.repos.map((repo) => [
        repo.id,
        repo.defaultBranch ?? "(none)",
        repo.hookInstalled ? "ok" : "missing",
        repo.gitDir,
      ]),
    ])) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("", `worktrees (${listing.worktrees.length}):`);
  if (listing.worktrees.length === 0) lines.push("  (none)");
  else {
    for (const line of formatTable([
      ["repo", "branch", "dirty", "job", "path"],
      ...listing.worktrees.map((worktree) => [
        worktree.repo,
        worktree.branch ?? "(detached)",
        worktree.dirty ? "yes" : "no",
        worktree.jobId === null
          ? "-"
          : [worktree.jobId, worktree.jobStatus ?? "?", worktree.jobTitle ?? ""].join(" ").trimEnd(),
        worktree.path,
      ]),
    ])) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("", `caches (${listing.caches.length}):`);
  if (listing.caches.length === 0) lines.push("  (none)");
  else {
    for (const line of formatTable([
      ["repo", "build dir", "created", "read-only", "path"],
      ...listing.caches.map((cache) => [
        cache.repo,
        cache.buildDir,
        cache.createdAt,
        cache.readOnly ? "yes" : "no",
        cache.path,
      ]),
    ])) {
      lines.push(`  ${line}`);
    }
  }

  return lines;
}

/** What the command line reads a job's two fields through, and how to close it. */
interface JobLookupHandle {
  readonly lookup: (jobId: string) => { title: string; status: string } | undefined;
  close(): Promise<void>;
}

/**
 * The jobs the registry's worktrees name, read without the daemon.
 *
 * The listing asks for a job's title and status through a synchronous lookup, so
 * the records are read before it runs: a worktree folder carries the job id in
 * its name, and only those ids are asked for. The live store is read first and
 * the archive second, so a finished job the sweep moved is still found. A store
 * that cannot be opened, a missing store, and a read that fails all leave the
 * lookup absent; the listing then shows empty job fields rather than failing.
 */
async function openJobLookup(paths: Paths, settings: RegistrySettings): Promise<JobLookupHandle | undefined> {
  if (!existsSync(paths.stateDb)) return undefined;

  const worktreesRoot = registryPaths(settings.root).worktrees;
  const ids = new Set<string>();
  for (const repo of listRepoIds(settings)) {
    for (const name of topLevelNames(join(worktreesRoot, repo))) {
      const jobId = jobIdFromWorktreeName(name);
      if (jobId !== undefined) ids.add(jobId);
    }
  }
  if (ids.size === 0) return undefined;

  let bundle: Awaited<ReturnType<typeof openStorage>> | undefined;
  let archiveSession: ReturnType<typeof createSession> | undefined;
  try {
    bundle = await openStorage(paths);
    const jobs = new JobRegistry({ session: createSession(bundle.storage), storage: bundle.storage });
    let archive: ArchiveStore | undefined;
    if (existsSync(paths.archiveDb)) {
      const archiveStorage = await openPrivateSqliteStorage(paths.archiveDb);
      archiveSession = createSession(archiveStorage);
      archive = new ArchiveStore({ live: jobs, session: archiveSession, storage: archiveStorage });
    }
    const found = new Map<string, { title: string; status: string }>();
    for (const id of ids) {
      const job = archive === undefined
        ? await jobs.get(BACKGROUND_CONTEXT, id)
        : await archive.getAny(BACKGROUND_CONTEXT, id);
      if (job !== undefined) found.set(id, { title: job.title, status: job.status });
    }
    const opened = bundle;
    return {
      lookup: (jobId) => found.get(jobId),
      close: async () => {
        if (archiveSession !== undefined) await archiveSession.close(BACKGROUND_CONTEXT).catch(() => undefined);
        await opened.close().catch(() => undefined);
      },
    };
  } catch {
    if (archiveSession !== undefined) await archiveSession.close(BACKGROUND_CONTEXT).catch(() => undefined);
    if (bundle !== undefined) await bundle.close().catch(() => undefined);
    return undefined;
  }
}

/** One listing, with the jobs its worktrees name filled in when a store can answer. */
async function listForCommand(
  paths: Paths,
  settings: RegistrySettings,
  repo?: string,
): Promise<RegistryListing> {
  const handle = await openJobLookup(paths, settings);
  try {
    const opts = handle === undefined ? {} : { jobLookup: handle.lookup };
    return repo === undefined ? await listRegistry(settings, opts) : await showRepo(settings, repo, opts);
  } finally {
    await handle?.close();
  }
}

/** `pi-sec repos`: the command surface of the registry. */
async function commandRepos(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    process.stderr.write(REPOS_USAGE);
    return 2;
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(REPOS_USAGE);
    return 0;
  }

  const paths = buildPaths(resolveHome(process.env));
  const config = await loadConfigForCommand(paths);
  if (config === undefined) return 2;
  const settings = registrySettings(config);

  try {
    switch (sub) {
      case "register": {
        const { positional, flags } = parseFlags(rest);
        if (positional.length > 0) return reposUsageProblem("register takes no positional arguments");
        const name = typeof flags["name"] === "string" ? flags["name"].trim() : "";
        if (name === "") return reposUsageProblem("register needs --name <owner>/<repo>");
        const inPlace = flags["in-place"];
        if (inPlace === undefined) {
          writeJson(await registerRepo(settings, name));
          return 0;
        }
        if (typeof inPlace !== "string" || inPlace.trim() === "") {
          return reposUsageProblem("--in-place needs the path of an existing git directory");
        }
        writeJson(await registerInPlace(settings, inPlace, name));
        return 0;
      }
      case "worktree": {
        const { positional } = parseFlags(rest);
        const [action, repo, name, extra] = positional;
        if (action !== "add" && action !== "remove" && action !== "refill") {
          return reposUsageProblem("worktree needs one of: add, remove, refill");
        }
        if (repo === undefined || name === undefined || extra !== undefined) {
          return reposUsageProblem(`worktree ${action} needs <repo> <name>`);
        }
        const result =
          action === "add"
            ? await addWorktree(settings, repo, name)
            : action === "remove"
              ? await removeWorktree(settings, repo, name)
              : await refillBuildfs(settings, repo, name);
        writeJson(result);
        return 0;
      }
      case "ff": {
        const { positional } = parseFlags(rest);
        const [repo, branch, extra] = positional;
        if (repo === undefined || branch === undefined || extra !== undefined) {
          return reposUsageProblem("ff needs <repo> <branch>");
        }
        writeJson(await fastForward(settings, repo, branch));
        return 0;
      }
      case "cache": {
        const { positional } = parseFlags(rest);
        const [action, repo, extra] = positional;
        if (action !== "refresh" && action !== "prune") {
          return reposUsageProblem("cache needs one of: refresh, prune");
        }
        if (extra !== undefined) return reposUsageProblem(`cache ${action} names one repository at most`);
        writeJson(action === "refresh" ? await refreshCaches(settings, repo) : await pruneAll(settings, repo));
        return 0;
      }
      case "list": {
        const { positional, flags } = parseFlags(rest);
        if (positional.length > 0) return reposUsageProblem("list takes no arguments besides --json");
        const listing = await listForCommand(paths, settings);
        if (flags["json"] === true) writeJson(listing);
        else process.stdout.write(`${listingLines(listing).join("\n")}\n`);
        return 0;
      }
      case "show": {
        const { positional, flags } = parseFlags(rest);
        const [repo, extra] = positional;
        if (repo === undefined || extra !== undefined) return reposUsageProblem("show needs one repository");
        const listing = await listForCommand(paths, settings, repo);
        if (flags["json"] === true) writeJson(listing);
        else process.stdout.write(`${listingLines(listing).join("\n")}\n`);
        return 0;
      }
      case "doctor": {
        const { flags } = parseFlags(rest);
        const report = await doctorRegistry(settings);
        if (flags["json"] === true) {
          writeJson(report);
        } else {
          const lines = report.checks.map(
            (check) =>
              `${check.ok ? "ok  " : check.warning === true ? "warn" : "FAIL"} ${check.name}: ${check.detail}`,
          );
          lines.push(report.ok ? "doctor: ok" : "doctor: not ok");
          process.stdout.write(`${lines.join("\n")}\n`);
        }
        return report.ok ? 0 : 1;
      }
      default:
        return reposUsageProblem(`unknown repos command: ${sub}`);
    }
  } catch (error) {
    return refuseRepos(error instanceof Error ? error.message : String(error));
  }
}

function usage(): void {
  process.stdout.write(
    `pi-sec ${VERSION}\n\n` +
      `Usage: pi-sec <command> [options]\n\n` +
      `Commands:\n` +
      `  start        Run the daemon (HTTP + SSE).\n` +
      `  send         Send one message to a running daemon and print the reply.\n` +
      `  chat         Interactive CLI chat against a running daemon.\n` +
      `  status       Report whether the daemon is running.\n` +
      `  doctor       Check config, prompt files, model catalog, storage version, and secrets.\n` +
      `  config       Print the effective config (--default for defaults).\n` +
      `  models       List catalog models with their source and whether credentials exist.\n` +
      `  setup-model  Write the root, orchestrator, planner and worker vmodels into config.json.\n` +
      `  db           Print the storage path and schema version.\n` +
      `  migrate      Apply storage/config migrations.\n` +
      `  audit        Print the audit log tail (--limit N).\n` +
      `  repos        Keep the repository registry: bare repositories, worktrees and buildfs caches.\n` +
      `  version      Print the version.\n` +
      `\nOptions for send/chat: --url <origin> (default http://127.0.0.1:8787), --timeout <ms>.\n`,
  );
}

function extractAssistant(entries: readonly { kind: string; model?: unknown[] }[]): string {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.assistant") continue;
    for (const message of (entry.model ?? []) as { content?: unknown }[]) {
      const content = message.content;
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        texts.push(content.map((block) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text?: unknown }).text ?? "") : "")).join(""));
      }
    }
  }
  return texts.join("\n").trim();
}

/** Send one message to a running daemon and return its reply. */
async function sendAndWait(origin: string, content: string, timeoutMs: number): Promise<string> {
  let beforeMax = 0;
  try {
    const list = (await (await fetch(`${origin}/api/conversations`)).json()) as { conversations?: { id: number }[] };
    const id = list.conversations?.[0]?.id;
    if (id !== undefined) {
      const snap = (await (await fetch(`${origin}/api/conversations/${id}`)).json()) as { entries?: { id: number }[] };
      beforeMax = Math.max(0, ...(snap.entries ?? []).map((entry) => entry.id));
    }
  } catch {
    /* fresh daemon */
  }

  const post = await fetch(`${origin}/basic-chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!post.ok) throw new Error(`HTTP ${post.status}: ${await post.text()}`);
  const accepted = (await post.json()) as { conversationId: number };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res = await fetch(`${origin}/api/conversations/${accepted.conversationId}`);
    if (!res.ok) continue;
    const data = (await res.json()) as { entries?: { id: number; kind: string; model?: unknown[] }[] };
    const newer = (data.entries ?? []).filter((entry) => entry.id > beforeMax);
    const answer = extractAssistant(newer);
    if (answer !== "") return answer;
  }
  throw new Error("timed out waiting for a reply");
}

async function commandSend(args: readonly string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const origin = (typeof flags["url"] === "string" ? flags["url"] : "http://127.0.0.1:8787").replace(/\/$/, "");
  const timeout = Number(flags["timeout"] ?? 180000);
  const content = positional.join(" ").trim();

  if (content === "") {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (;;) {
        const line = await rl.question("you> ").catch(() => null);
        if (line === null) break;
        const trimmed = line.trim();
        if (trimmed === "" ) continue;
        if (trimmed === "/exit" || trimmed === "/quit") break;
        try {
          const answer = await sendAndWait(origin, trimmed, timeout);
          process.stdout.write(`pi-sec> ${answer}\n`);
        } catch (error) {
          process.stderr.write(`error: ${String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
    return 0;
  }

  try {
    const answer = await sendAndWait(origin, content, timeout);
    process.stdout.write(`${answer}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`send failed: ${String(error)}\n`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return commandStart(rest);
    case "send":
    case "chat":
      return commandSend(rest);
    case "status":
      return commandStatus();
    case "doctor":
      return commandDoctor();
    case "config":
      return commandConfig(rest);
    case "models":
      return commandModels(rest);
    case "setup-model":
      return commandSetupModel(rest);
    case "db":
      return commandDb();
    case "migrate":
      return commandMigrate();
    case "audit":
      return commandAudit(rest);
    case "repos":
      return commandRepos(rest);
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      usage();
      return 2;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // A command whose promise never settles leaves no handle behind, and Node
  // then ends the process with the exit code it has, which is 0. `beforeExit`
  // runs at that moment, and the flag tells it whether a result ever came.
  let reported = false;
  process.once("beforeExit", () => {
    if (reported) return;
    process.stderr.write("pi-sec: the command ended without a result\n");
    process.exitCode = 1;
  });
  main()
    .then((code) => {
      reported = true;
      process.exitCode = code;
    })
    .catch((error) => {
      reported = true;
      process.stderr.write(`pi-sec: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
