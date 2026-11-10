/**
 * A runtime with the remote machines feature on, a machine that really runs what
 * it is asked, and a clock the test moves by hand.
 *
 * `test/remote-helpers.ts` uses the fake ssh that answers from a file, which is
 * what the heartbeat tests need. A detached run needs the opposite: the core reads
 * the run directory after the start and decides from what is in it, so the command
 * has to have run and left its pid, its output and its exit status. The three fakes
 * used here do that (`test/fixtures/remote/fake-exec-*.mjs`), with a directory that
 * plays the remote user's home.
 *
 * The clock is two halves. `now()` is the instant the manager believes it is, and
 * `runTimer()` fires the timers the run checks arm. A test moves both together with
 * `advance(ms)`, which is the only way to see an interval pass without waiting for
 * one: `--maxWorkers` runs several of these at once, and a test that slept for
 * thirty minutes would not be one.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openPrivateSqliteStorage } from "../src/runtime/sqlite-file.ts";
import { SecAgent } from "../src/documents.ts";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Models } from "@earendil-works/pi-ai";
import { defaultConfig, type Config, type RemoteMachineConfig } from "../src/config/schema.ts";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus, type EventBus } from "../src/runtime/event-bus.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { appendEnveloped } from "../src/submit-envelope.ts";
import type { RemoteMachinesOverrides } from "../src/remote/machines.ts";
import type { RunTimers } from "../src/remote/plumbing.ts";
import { FAKE_EXEC_RSYNC, FAKE_EXEC_SFTP, FAKE_EXEC_SSH } from "./remote-helpers.ts";

/** One armed timer, as the fixture's clock holds it. */
interface ArmedTimer {
  readonly dueAt: number;
  readonly callback: () => void | Promise<void>;
  cancelled: boolean;
}

/**
 * A clock and a set of timers a test drives.
 *
 * `advanceTo(at)` moves the clock and fires every timer that is due by then, in the
 * order they were armed. Firing one runs its callback, which is asynchronous, so the
 * runner gives the microtask queue a turn before it looks at the next.
 */
export class FakeClock implements RunTimers {
  #now: number;
  readonly #armed: ArmedTimer[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Arm one timer. A test never calls this; `checks.ts` does through the seam. */
  set(callback: () => void | Promise<void>, delayMs: number): { cancel(): void } {
    const entry: ArmedTimer = { dueAt: this.#now + Math.max(0, delayMs), callback, cancelled: false };
    this.#armed.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /**
   * Timers that are still armed: not cancelled and not yet due.
   *
   * A timer that fired and whose callback armed the next one is armed again, so
   * this counts what a running check keeps alive rather than what has ever been
   * set.
   */
  pending(): number {
    return this.#armed.filter((entry) => !entry.cancelled).length;
  }

  /** Timers armed for a moment still in the future. */
  future(): number {
    return this.#armed.filter((entry) => !entry.cancelled && entry.dueAt > this.#now).length;
  }

  /** Move to `at` and fire every timer due by then, in the order armed. */
  async advanceTo(at: number): Promise<void> {
    this.#now = at;
    for (const entry of this.#armed) {
      if (entry.cancelled) continue;
      if (entry.dueAt > at) continue;
      entry.cancelled = true;
      await entry.callback();
      await settle();
    }
  }

  /** Move forward by `ms`, firing what falls due on the way. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.#now + ms);
  }

  /**
   * Move forward by `ms` and fire nothing.
   *
   * That is what a process that stops and starts again looks like to a clock: the
   * timers of the process that stopped never fire, and the one that starts reads
   * the store and decides from the times in it.
   */
  jump(ms: number): void {
    this.#now += ms;
  }
}

/**
 * The process group of a live process, or nothing when it is gone.
 *
 * The fields after the command name start at field 3, so field 5 (the process
 * group) is `rest[2]`.
 */
async function groupOf(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const group = Number(rest[2]);
    return Number.isInteger(group) ? group : null;
  } catch {
    return null;
  }
}

/**
 * Every process this fixture's fake machine started.
 *
 * The fake ssh hands each command `FAKE_EXEC_HOME`, the fixture's own remote home,
 * so the command a run started carries it in its environment, and so do the runner
 * and the `timeout` that wraps a run at `restricted`. That is a better identity than
 * a process group: GNU `timeout` puts the command it watches in a group of its own,
 * so a run at `restricted` is not one group at all, and killing the runner's group
 * would leave the command running.
 */
export async function fakeMachineProcesses(remote: string): Promise<number[]> {
  const marker = `FAKE_EXEC_HOME=${remote}\u0000`;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // The test process is nobody's run: it has this fixture's home in an argument,
    // not in its environment, and it is never a candidate anyway.
    if (pid === process.pid) continue;
    try {
      const environment = await readFile(`/proc/${entry}/environ`, "utf8");
      if (environment.includes(marker)) found.push(pid);
    } catch {
      // Another user's process, or one that exited between the listing and the read.
    }
  }
  return found;
}

/**
 * Wait for a condition, rather than for a fixed number of turns.
 *
 * A check starts an ssh process, and a process takes as long as the machine gives
 * it: a fixed settle is long enough on an idle host and too short on a busy one. So
 * a test that must see a message waits for the message, up to a bound that is far
 * larger than any answer it will get.
 */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    if (await check()) return true;
    await settle();
  }
  return false;
}

/** Let the runtime's own promises run, without a timer of the test's own. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** A machine named the way the repository's tests name one. */
export const EXEC_MACHINE: RemoteMachineConfig = {
  id: "box-a",
  address: "192.0.2.10",
  users: ["alice", "bob"],
};

/** The machine-id the fake answers with for a heartbeat. */
export const EXEC_MACHINE_ID = "0123456789abcdef0123456789abcdef";

export interface RunFixture {
  readonly runtime: AgentRuntime;
  readonly paths: Paths;
  readonly events: EventBus;
  readonly home: string;
  /** The directory that plays the remote user's home on the fake machine. */
  readonly remote: string;
  /** The clock the manager reads, and the timers the run checks arm. */
  readonly clock: FakeClock;
  readonly config: Config;
  readonly models: Models;
  /** Pin the machine's host key, so the step check lets a tool through. */
  pinHostKey(): Promise<void>;
  /** Set a machine's level through the manager's own path, as the slider does. */
  setLevel(id: string, level: "off" | "restricted" | "on"): Promise<void>;
  /** Every fake ssh call so far, in order. */
  calls(): Promise<Readonly<Record<string, unknown>>[]>;
  /** Every fake sftp call so far, in order. */
  sftpCalls(): Promise<Readonly<Record<string, unknown>>[]>;
  /** Every fake rsync call so far, in order. */
  rsyncCalls(): Promise<Readonly<Record<string, unknown>>[]>;
  /** The bodies of the messages the root received from this feature, in order. */
  rootNotices(): Promise<string[]>;
  /** The bodies of the messages one conversation received from this feature. */
  noticesIn(conversationId: string): Promise<string[]>;
  /** Change the machine's entry in the config the runtime reads. */
  setConfig(mutate: (config: Config) => Config): void;
  /**
   * Make a conversation and an agent record for it, so a run can report to one.
   *
   * A run's message goes where it started only while that conversation can still be
   * read, and the record is what says so: a conversation with no record, or one
   * whose record ended, sends the message to the root instead.
   */
  addConversation(input: { readonly name: string; readonly status?: string }): Promise<string>;
  /**
   * Boot a second runtime over the same store, the same remote home and the same
   * clock.
   *
   * That is what "the daemon came back" is: the runs are still on the machine, the
   * records are still in the store, and the clock has moved. `sshFail` is how a
   * machine that went away while the daemon was down is expressed, because the
   * manager's own environment is fixed when it is built.
   */
  restart(overrides?: { readonly sshFail?: string; readonly sshPath?: string }): Promise<RunFixture>;
  close(): Promise<void>;
}

export interface RunFixtureOptions {
  /** Override the machine entry. */
  readonly machine?: RemoteMachineConfig;
  /** The heartbeat interval, in seconds. */
  readonly heartbeatSeconds?: number;
  /** The run check interval, in seconds. */
  readonly runCheckSeconds?: number;
  /** The tightening deadline, in seconds. */
  readonly tightenDeadlineSeconds?: number;
  /** The time limit at `restricted`, in seconds. */
  readonly restrictedSeconds?: number;
  /** The store a second boot reopens. */
  readonly storage?: MemoryStorage;
  /** The home a second boot reopens. Absent on the first boot. */
  readonly home?: string;
  /** Seed the root conversation with one operator message. Default true. */
  readonly seedRoot?: boolean;
  /** Fail every ssh call with this text, as an unreachable machine would. */
  readonly sshFail?: string;
  /** The ssh program the manager runs. Default: the fake ssh. */
  readonly sshPath?: string;
  /**
   * Leave the machine's host key unpinned. Default false: a pinned key is the state
   * of an install that has been set up, and it is what a restart has to find again.
   */
  readonly unpinned?: boolean;
}

/** The clock both boots of one fixture share, so a restart does not move time. */
const CLOCK_START = Date.parse("2026-10-31T07:00:00Z");

/**
 * Build a fixture. `restart()` builds a second one over the same home and store,
 * with the same clock, which is how "the daemon came back" is expressed.
 */
export async function createRunFixture(options: RunFixtureOptions = {}): Promise<RunFixture> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "pi-sec-runs-")));
  const remote = join(home, "remote-home");
  const clock = new FakeClock(CLOCK_START);
  return await boot({ ...options, home }, remote, clock);
}

async function boot(options: RunFixtureOptions, remote: string, clock: FakeClock): Promise<RunFixture> {
  const home = options.home as string;
  const paths = buildPaths(home);
  await ensureLayout(paths);
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "faux.md"), "", "utf8");
  await mkdir(paths.remoteKnownHostsFile.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 });
  await mkdir(remote, { recursive: true, mode: 0o700 });

  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage([fauxText("ok")])));

  const sshLog = join(home, "fake-exec-ssh.log");
  const sftpLog = join(home, "fake-exec-sftp.log");
  const rsyncLog = join(home, "fake-exec-rsync.log");

  const base = defaultConfig();
  const config: Config = {
    ...base,
    timezone: "UTC",
    code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
    attachments: { dir: join(home, "attachments"), shareDir: join(home, "share") },
    vmodels: {
      faux: { provider: "faux", modelId: faux.getModel().id, thinkingLevel: "medium", prompt: "faux" },
    },
    agent: { ...base.agent, vmodel: "faux", workspace: paths.workspaceTree },
    remoteMachines: {
      identityFile: join(home, "id_ed25519"),
      heartbeatSeconds: options.heartbeatSeconds ?? 60,
      machines: [options.machine ?? EXEC_MACHINE],
      ...(options.runCheckSeconds === undefined ? {} : { runCheckSeconds: options.runCheckSeconds }),
      ...(options.tightenDeadlineSeconds === undefined
        ? {}
        : { tightenDeadlineSeconds: options.tightenDeadlineSeconds }),
      ...(options.restrictedSeconds === undefined ? {} : { restrictedSeconds: options.restrictedSeconds }),
    },
  };

  const secrets = new SecretRegistry({ dir: paths.secretsDir, includeModelCredentials: false });
  await secrets.load();
  const logger = createLogger({ console: false, file: paths.appLog });
  const audit = createAuditLog({ file: paths.auditLog, redactor: () => secrets.redactor() });
  const events = createEventBus();

  const environment: Record<string, string> = {
    FAKE_EXEC_SSH_LOG: sshLog,
    FAKE_EXEC_SFTP_LOG: sftpLog,
    FAKE_EXEC_RSYNC_LOG: rsyncLog,
    FAKE_EXEC_HOME: remote,
    ...(options.sshFail === undefined ? {} : { FAKE_EXEC_FAIL: options.sshFail }),
  };
  const overrides: RemoteMachinesOverrides = {
    sshPath: options.sshPath ?? FAKE_EXEC_SSH,
    sftpPath: FAKE_EXEC_SFTP,
    rsyncPath: FAKE_EXEC_RSYNC,
    sshEnv: environment,
    now: () => clock.now(),
    heartbeatDeadlineMs: 10_000,
    timers: clock,
  };

  // A file-backed store by default, because the restart test needs the records of
  // the first boot to be readable by the second. An in-memory store is closed with
  // the runtime that opened it, so a restart over one would see an empty install.
  const storage = options.storage ?? (await openPrivateSqliteStorage(paths.stateDb));
  const runtime = await createAgentRuntime({
    paths,
    config,
    storage,
    archiveStorage: new MemoryStorage(),
    models,
    secrets,
    logger,
    audit,
    events: events.sink,
    loadExtensions: false,
    watchExtensions: false,
    remoteMachines: overrides,
  });

  const readLog = async (file: string): Promise<Readonly<Record<string, unknown>>[]> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      // The fake tool makes the file at its first call, so a missing file is no call yet.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Only complete lines count: text after the last line break is a line the fake
    // tool is still writing, and the next read has it. A complete line that is not
    // JSON is a broken log, and it throws.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    return complete
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const readConversation = async (conversationId: string): Promise<string[]> => {
    const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
    if (conversation === undefined) return [];
    const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
    const bodies: string[] = [];
    const entries = [
      ...(page.items as readonly { kind: string; model?: readonly { role?: string; content?: unknown }[] }[]),
    ].reverse();
    for (const entry of entries) {
      if (entry.kind !== UserEntry.kind) continue;
      for (const message of entry.model ?? []) {
        if (message.role !== "user" || typeof message.content !== "string") continue;
        const text = message.content;
        if (!text.includes('via="remote-machines"')) continue;
        bodies.push(text.slice(text.indexOf(">") + 1, text.lastIndexOf("</pi-message>")));
      }
    }
    return bodies;
  };

  /**
   * Kill the processes this fixture left on the fake machine, and wait for them.
   *
   * The fake machine is this machine, so a run's command is a real process, and the
   * core never stops a run by itself: a test that ends with an endless command alive
   * leaves that command running for as long as the host is up. That is a leak of the
   * test's own, and it made this suite flaky, because the host's pid limit is shared
   * and small: after enough runs the fake ssh could not be started at all, which
   * failed every test in the file rather than one.
   *
   * The signal goes to the process group of each match, so a command and the shell
   * around it go together, and the scan is repeated until it finds nothing: a
   * `while true` loop can fork between the scan and the signal.
   */
  const stopRunProcesses = async (): Promise<void> => {
    const limit = Date.now() + 5_000;
    for (;;) {
      const left = await fakeMachineProcesses(remote);
      if (left.length === 0) return;
      if (Date.now() > limit) {
        throw new Error(`a process of the fake machine still runs after SIGKILL: ${left.join(", ")}`);
      }
      for (const pid of left) {
        const group = await groupOf(pid);
        try {
          if (group === pid) process.kill(-pid, "SIGKILL");
          else process.kill(pid, "SIGKILL");
        } catch {
          // It went on its own between the scan and the signal.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const fixture: RunFixture = {
    runtime,
    paths,
    events,
    home,
    remote,
    clock,
    config,
    models,
    pinHostKey: async () => {
      await mkdir(paths.remoteKnownHostsFile.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 });
      await writeFile(
        paths.remoteKnownHostsFile,
        "box-a ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests\n",
        { mode: 0o600 },
      );
    },
    setLevel: async (id, level) => {
      await runtime.remoteMachines.setLevel(id, level, BACKGROUND_CONTEXT);
    },
    calls: () => readLog(sshLog),
    sftpCalls: () => readLog(sftpLog),
    rsyncCalls: () => readLog(rsyncLog),
    rootNotices: () => readConversation(String(ROOT_CONVERSATION_ID)),
    noticesIn: (conversationId) => readConversation(conversationId),
    setConfig: (mutate) => {
      runtime.setConfig(mutate(runtime.getConfig()));
    },
    addConversation: async (input) => {
      const conversation = await runtime.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      const id = String(conversation.id);
      await runtime.harness.commit(async (tx) => {
        const record = await tx.doc(SecAgent, id, id);
        record.kind = "subagent";
        record.name = input.name;
        record.vmodel = "faux";
        record.status = (input.status ?? "running") as never;
        record.createdAt = clock.now();
        record.updatedAt = clock.now();
      }, BACKGROUND_CONTEXT);
      return id;
    },
    restart: async (overrides) => {
      await runtime.close();
      return await boot(
        {
          ...options,
          home,
          storage: undefined,
          ...(overrides?.sshFail === undefined ? {} : { sshFail: overrides.sshFail }),
          // Only the override sets it: a restart without it goes back to the fake ssh.
          sshPath: overrides?.sshPath,
        },
        remote,
        clock,
      );
    },
    close: async () => {
      await stopRunProcesses();
      await runtime.close();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };

  // A machine whose key is pinned is the normal state of an install that has been
  // set up, and every tool needs it: the check refuses an unpinned machine before it
  // contacts it. Writing it here means a restart finds the same pinned key the first
  // boot had, which is what a real install does.
  if (options.unpinned !== true) {
    await writeFile(
      paths.remoteKnownHostsFile,
      `${EXEC_MACHINE.id} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests\n`,
      { mode: 0o600 },
    );
  }

  // The daemon starts the manager's timers only when it loads extensions, and a
  // fixture boots without extensions to keep a test small. Starting it here is what
  // the daemon does at that point, and it is what makes a restart pick up the checks
  // the previous process left: `start` resumes them from the store.
  runtime.remoteMachines.start(BACKGROUND_CONTEXT);
  await settle();

  if (options.seedRoot ?? true) {
    await runtime.harness.commit(
      (tx) =>
        appendEnveloped(tx, UserEntry, ROOT_CONVERSATION_ID, {
          src: "operator",
          content: "hello",
          whenBusy: "followUp",
        }),
      BACKGROUND_CONTEXT,
    );
  }
  return fixture;
}
