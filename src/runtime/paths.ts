import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve `~` and `$HOME` at the start of a configured path. Relative paths are
 * resolved against `cwd`.
 */
export function expandPath(value: string, cwd = process.cwd(), home = homedir()): string {
  let out = value;
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = join(home, out.slice(2));
  out = out.replace(/^\$HOME(?=\/|$)/, home);
  return isAbsolute(out) ? resolve(out) : resolve(cwd, out);
}

/**
 * Resolve the pi-sec control-structure root.
 *
 * `PI_SEC_HOME` overrides everything; the default is `~/.pi/sec` under the run
 * account's home. Nothing else moves it: the install script and the service
 * file both name that directory, so a second answer here would put the default
 * control structure somewhere neither of them looks.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_SEC_HOME && env.PI_SEC_HOME.length > 0) {
    return expandPath(env.PI_SEC_HOME, process.cwd(), env.HOME ?? homedir());
  }
  return join(env.HOME ?? homedir(), ".pi", "sec");
}

/**
 * Treat the literal `~/.pi/sec` prefix as the resolved pi-sec home.
 *
 * A configured path that names the default control structure is read in two
 * places — the load-time rewrite of the defaults (`applyHomeDefaults`) and the
 * agent's working directory (`resolveAgentWorkingDirectory`) — so the rule lives
 * here and both import it instead of keeping a copy. `PI_SEC_HOME` relocates the
 * whole tree; a value that does not carry the prefix is returned unchanged and
 * expands as written.
 */
export function underHome(value: string, home: string): string {
  if (value === "~/.pi/sec") return home;
  if (value.startsWith("~/.pi/sec/")) return home + value.slice("~/.pi/sec".length);
  return value;
}

/** Every fixed location of the pi-sec control structure and code trees. */
export interface Paths {
  readonly home: string;
  readonly configFile: string;
  readonly authFile: string;
  readonly modelsFile: string;
  /** The reference list of providers and models, written once per boot and never read back. */
  readonly modelCatalogFile: string;
  readonly versionFile: string;
  readonly stateDir: string;
  readonly stateDb: string;
  /** Newest successful model login per provider: its UTC time and its type. */
  readonly modelLoginsFile: string;
  /** Long report bodies, one directory per report, one file per revision. */
  readonly reportsDir: string;
  /**
   * Draft report bodies, one file per draft.
   *
   * A draft is open work of a job rather than a cache entry, so its body is not
   * under `cache/`: the cleanup pass must not take a draft that nobody published
   * yet.
   */
  readonly draftsDir: string;
  /**
   * One context file per agent conversation, plus the root's permanent one.
   *
   * This is where an agent keeps the current state of its own work, and where
   * its parent reads it. The files outlive the agent that wrote them, so the
   * directory is part of the control structure rather than a cache.
   */
  readonly agentsDir: string;
  /** Archived job and report documents, in their own database. */
  readonly archiveDb: string;
  /**
   * The focused chats: one row per chat the user opened from the web page.
   *
   * A file of its own for the reason the archive has one: the transcript store is
   * the durable library's schema, and a table added to it would be one this code
   * does not own. Titles and archive times live here and nowhere else.
   */
  readonly focusedChatsDb: string;
  /** One row per model call: its timing and token counts. */
  readonly modelCallsDb: string;
  /** Archived report bodies, moved wholesale out of `reportsDir`. */
  readonly archiveDir: string;
  readonly memoryDir: string;
  readonly promptsDir: string;
  readonly extensionsDir: string;
  readonly secretsDir: string;
  readonly logsDir: string;
  readonly appLog: string;
  readonly auditLog: string;
  readonly runDir: string;
  readonly pidFile: string;
  /** Exclusive lock held by the one daemon that may run on this home. */
  readonly daemonLockFile: string;
  readonly cacheDir: string;
  /**
   * The host keys this install pinned, one line per machine.
   *
   * Not the operator's `~/.ssh/known_hosts`: an entry there is the operator's
   * decision about their own shell, and a key this feature adds on the operator's
   * behalf would be one they never checked. `src/remote/ssh.ts` hands this file to
   * every ssh call.
   */
  readonly remoteKnownHostsFile: string;
  /**
   * The sockets of the ssh connections kept open to remote machines.
   *
   * One file per machine and user, named by a digest of both, so an address change
   * does not lose the name. A unix socket path cannot exceed 108 bytes, and
   * `src/config/load.ts` refuses a pi-sec home that would not fit one.
   */
  readonly sshSocketDir: string;
  readonly snapshotTree: string;
  readonly workspaceTree: string;
}

/** Build the fixed layout for a control-structure root. */
export function buildPaths(home: string): Paths {
  return {
    home,
    configFile: join(home, "config.json"),
    authFile: join(home, "auth.json"),
    modelsFile: join(home, "models.json"),
    modelCatalogFile: join(home, "model-catalog.json"),
    versionFile: join(home, "VERSION"),
    stateDir: join(home, "state"),
    stateDb: join(home, "state", "sec.sqlite"),
    modelLoginsFile: join(home, "state", "model-logins.json"),
    reportsDir: join(home, "state", "reports"),
    draftsDir: join(home, "state", "drafts"),
    agentsDir: join(home, "state", "agents"),
    archiveDb: join(home, "state", "archive.sqlite"),
    focusedChatsDb: join(home, "state", "focused-chats.sqlite"),
    modelCallsDb: join(home, "state", "model-calls.sqlite"),
    archiveDir: join(home, "state", "archive"),
    memoryDir: join(home, "memory"),
    promptsDir: join(home, "prompts"),
    extensionsDir: join(home, "extensions"),
    secretsDir: join(home, "secrets"),
    logsDir: join(home, "logs"),
    appLog: join(home, "logs", "app.log"),
    auditLog: join(home, "logs", "audit.jsonl"),
    runDir: join(home, "run"),
    pidFile: join(home, "run", "pi-sec.pid"),
    daemonLockFile: join(home, "run", "daemon.lock"),
    cacheDir: join(home, "cache"),
    remoteKnownHostsFile: join(home, "state", "remote-machines", "known_hosts"),
    sshSocketDir: join(home, "run", "ssh"),
    snapshotTree: join(home, "snapshot"),
    workspaceTree: join(home, "workspace"),
  };
}

const DIRS_0700 = (paths: Paths): string[] => [
  paths.home,
  paths.stateDir,
  paths.reportsDir,
  paths.draftsDir,
  paths.agentsDir,
  paths.archiveDir,
  paths.memoryDir,
  paths.promptsDir,
  paths.extensionsDir,
  paths.secretsDir,
  paths.logsDir,
  paths.runDir,
  paths.cacheDir,
  paths.sshSocketDir,
];

/**
 * Create the control structure if absent. Directories are `0700`; the caller is
 * responsible for the mode of individual files.
 */
export async function ensureLayout(paths: Paths): Promise<void> {
  for (const dir of DIRS_0700(paths)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  for (const dir of DIRS_0700(paths)) {
    // mkdir's mode is masked by the process umask; enforce it.
    await chmod(dir, 0o700).catch(() => undefined);
  }
}
