/**
 * A runtime with the remote machines feature on, a fake ssh, and a clock.
 *
 * Every test of this feature needs the same four things, and none of them may be
 * the real one: a temporary home so nothing touches the install, the fake ssh from
 * `test/fixtures/remote/fake-ssh.mjs` so no process connects to anything, a clock
 * the test moves by hand, and a root conversation that already holds a message,
 * because a notice to a root nobody has spoken to is deliberately not sent.
 *
 * The harness is built here rather than by `test/helpers.ts` because the runtime
 * takes the replacement ssh and the clock through `AgentRuntimeOptions`, and that
 * file is shared by tests that want neither. The rest of the setup is the same:
 * a temporary home, an empty vmodel prompt file, and a working directory.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, UserEntry, type Storage } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Models } from "@earendil-works/pi-ai";
import { defaultConfig, type Config, type RemoteMachineConfig } from "../src/config/schema.ts";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus, type EventBus } from "../src/runtime/event-bus.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { appendEnveloped } from "../src/submit-envelope.ts";
import type { RemoteMachinesOverrides } from "../src/remote/machines.ts";

/** The fake ssh, as the program the manager starts. */
export const FAKE_SSH = new URL("./fixtures/remote/fake-ssh.mjs", import.meta.url).pathname;

/** The fake ssh that really runs a command with a temporary home. */
export const FAKE_EXEC_SSH = new URL("./fixtures/remote/fake-exec-ssh.mjs", import.meta.url).pathname;

/** The fake sftp, whose batch is done against the temporary home. */
export const FAKE_EXEC_SFTP = new URL("./fixtures/remote/fake-exec-sftp.mjs", import.meta.url).pathname;

/** The fake rsync, which copies between real paths and records its arguments. */
export const FAKE_EXEC_RSYNC = new URL("./fixtures/remote/fake-exec-rsync.mjs", import.meta.url).pathname;

/** One line of the fake ssh's log. */
export interface FakeSshCall {
  readonly n: number;
  readonly args: readonly string[];
  readonly kinds: readonly string[];
  readonly user: string;
}

/** What one call answers. */
export interface FakeSshAnswer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
}

/** One rule of the response file: every given field must match. */
export interface FakeSshRule {
  readonly contains?: readonly string[];
  readonly user?: string;
  readonly kinds?: readonly string[];
  readonly response?: FakeSshAnswer;
}

/** The response file the fake ssh reads on every call. */
export interface FakeSshResponses {
  readonly rules?: readonly FakeSshRule[];
  readonly default?: FakeSshAnswer;
}

/** The machine-id the fake machine answers with unless a test says otherwise. */
export const FAKE_MACHINE_ID = "0123456789abcdef0123456789abcdef";

/** A machine named the way the repository's tests name one. */
export const MACHINE: RemoteMachineConfig = {
  id: "box-a",
  address: "192.0.2.10",
  users: ["alice", "bob"],
};

export interface RemoteFixture {
  readonly runtime: AgentRuntime;
  readonly paths: Paths;
  readonly events: EventBus;
  readonly home: string;
  readonly config: Config;
  readonly models: Models;
  /** The instant the manager believes it is. */
  now(): number;
  /** Move the clock. */
  setNow(at: number): void;
  /** Replace what the next ssh call answers. */
  respond(responses: FakeSshResponses): Promise<void>;
  /** Every ssh call so far, in order. */
  calls(): Promise<FakeSshCall[]>;
  /** The calls that are not a local socket close. */
  remoteCalls(): Promise<FakeSshCall[]>;
  /** Forget the log, as if no call had been made. */
  clearCalls(): Promise<void>;
  /** Pin a host key for the machine, as the install step does. */
  pinHostKey(line?: string): Promise<void>;
  /** Change the machine's entry in the config the runtime reads. */
  setConfig(mutate: (config: Config) => Config): void;
  /** Put one operator message in the root conversation, so a notice can land. */
  seedRoot(): Promise<void>;
  /** The bodies of the messages the root received from this feature, in order. */
  rootNotices(): Promise<string[]>;
  close(): Promise<void>;
}

export interface RemoteFixtureOptions {
  /** Override one machine entry. */
  readonly machine?: RemoteMachineConfig;
  /** The whole `machines` list, for a test with two machines. */
  readonly machines?: readonly RemoteMachineConfig[];
  /** The heartbeat interval, in seconds. */
  readonly heartbeatSeconds?: number;
  /** Without `remoteMachines` at all: the feature is off. */
  readonly noFeature?: boolean;
  /** Seed the root conversation with one operator message. Default true. */
  readonly seedRoot?: boolean;
  /** More config, merged over the base. */
  readonly config?: Partial<Config>;
  /**
   * The store to use instead of a fresh one.
   *
   * A test that builds two runtimes over one store passes the same store to both,
   * which is what a restart looks like from the outside: the second runtime reads
   * what the first one wrote.
   */
  readonly storage?: Storage;
}

/** Build a fresh fixture. The caller closes it, which removes the home. */
export async function createRemoteFixture(options: RemoteFixtureOptions = {}): Promise<RemoteFixture> {
  const home = await mkdtemp(join(tmpdir(), "pi-sec-remote-"));
  const paths = buildPaths(home);
  await ensureLayout(paths);
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "faux.md"), "", "utf8");
  await mkdir(paths.remoteKnownHostsFile.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 });

  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);

  const responsesFile = join(home, "fake-ssh-responses.json");
  const logFile = join(home, "fake-ssh.log");
  const writeResponses = async (responses: FakeSshResponses): Promise<void> => {
    await writeFile(responsesFile, JSON.stringify(responses), "utf8");
  };
  await writeResponses({ default: { stdout: `${FAKE_MACHINE_ID}\n`, exit: 0 } });

  const base = defaultConfig();
  const machines = options.machines ?? [options.machine ?? MACHINE];
  const config: Config = {
    ...base,
    ...(options.config ?? {}),
    attachments: {
      dir: join(home, "attachments"),
      shareDir: join(home, "share"),
      ...(options.config?.attachments ?? {}),
    },
    timezone: "UTC",
    code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
    vmodels: {
      faux: { provider: "faux", modelId: faux.getModel().id, thinkingLevel: "medium", prompt: "faux" },
    },
    agent: {
      ...base.agent,
      ...(options.config?.agent ?? {}),
      vmodel: "faux",
      workspace: paths.workspaceTree,
    },
    ...(options.noFeature === true
      ? {}
      : {
          remoteMachines: {
            identityFile: join(home, "id_ed25519"),
            heartbeatSeconds: options.heartbeatSeconds ?? 60,
            machines: [...machines],
          },
        }),
  };

  const secrets = new SecretRegistry({ dir: paths.secretsDir, includeModelCredentials: false });
  await secrets.load();
  const logger = createLogger({ console: false, file: paths.appLog });
  // The clock is declared before the audit log, because the log stamps every row
  // with it: a test that moves time and then reads an audit row's `time` sees the
  // instant the code believed it was, not the instant the test machine happened to
  // run. The long-outage row carries its own `since` beside that stamp.
  let clock = Date.parse("2026-10-31T07:00:00Z");
  const audit = createAuditLog({ file: paths.auditLog, redactor: () => secrets.redactor(), now: () => clock });
  const events = createEventBus();

  const overrides: RemoteMachinesOverrides = {
    sshPath: FAKE_SSH,
    sshEnv: { FAKE_SSH_LOG: logFile, FAKE_SSH_RESPONSES: responsesFile },
    now: () => clock,
    heartbeatDeadlineMs: 5_000,
  };

  const runtime = await createAgentRuntime({
    paths,
    config,
    storage: options.storage ?? new MemoryStorage(),
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

  const readCalls = async (): Promise<FakeSshCall[]> => {
    try {
      const text = await readFile(logFile, "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as FakeSshCall);
    } catch {
      return [];
    }
  };

  const fixture: RemoteFixture = {
    runtime,
    paths,
    events,
    home,
    config,
    models,
    now: () => clock,
    setNow: (at) => {
      clock = at;
    },
    respond: writeResponses,
    calls: readCalls,
    remoteCalls: async () => (await readCalls()).filter((call) => !call.kinds.includes("exit")),
    clearCalls: async () => {
      await rm(logFile, { force: true });
      await rm(`${logFile}.count`, { force: true });
    },
    pinHostKey: async (line = `box-a ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests`) => {
      await mkdir(dirname(paths.remoteKnownHostsFile), { recursive: true, mode: 0o700 });
      await writeFile(paths.remoteKnownHostsFile, `${line}\n`, { mode: 0o600 });
    },
    setConfig: (mutate) => {
      runtime.setConfig(mutate(runtime.getConfig()));
    },
    seedRoot: async () => {
      await runtime.harness.commit(
        (tx) =>
          appendEnveloped(tx, UserEntry, ROOT_CONVERSATION_ID, {
            src: "operator",
            content: "hello",
            whenBusy: "followUp",
          }),
        BACKGROUND_CONTEXT,
      );
    },
    rootNotices: async () => {
      const conversation = await runtime.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      if (conversation === undefined) return [];
      const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
      const bodies: string[] = [];
      // The scan answers newest first; the caller reads the notices in the order
      // they were delivered, so the list is reversed once here.
      const entries = [...(page.items as readonly { kind: string; model?: readonly { role?: string; content?: unknown }[] }[])].reverse();
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
    },
    close: async () => {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    },
  };

  if (options.seedRoot ?? true) await fixture.seedRoot();
  return fixture;
}
