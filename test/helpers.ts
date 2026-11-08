import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Models } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus, type EventBus } from "../src/runtime/event-bus.ts";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import type { UsageService } from "../src/server/usage/service.ts";

export interface TestHarness {
  readonly runtime: AgentRuntime;
  readonly paths: Paths;
  readonly config: Config;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly models: Models;
  readonly events: EventBus;
  close(): Promise<void>;
}

export interface TestHarnessOptions {
  readonly config?: Partial<Config>;
  readonly responses?: ReturnType<typeof fauxAssistantMessage>[];
  /**
   * Whether the runtime prepares the root conversation during boot. Default true,
   * as in the daemon. A test that needs a store with no root conversation passes
   * false; that is the only way to reach it now that boot creates the root.
   */
  readonly prepareRoot?: boolean;
  /**
   * Whether the bundled extensions are loaded, which is what makes the runtime run
   * its boot repair. Default false, as every other test wants. A test that checks
   * what the boot repair does on a fresh store turns it on.
   */
  readonly loadExtensions?: boolean;
  /**
   * The provider cards' reader the runtime should use instead of building one.
   *
   * A test hands in a double so that "the hold watch judged on this provider's
   * numbers" is checked without a provider call, and so that a watch's recovery
   * signal is a value the test chose.
   */
  readonly usage?: UsageService;
}

/** Build a fully wired AgentRuntime over MemoryStorage and a faux model provider. */
export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const home = await mkdtemp(join(tmpdir(), "pi-sec-test-"));
  const paths = buildPaths(home);
  await ensureLayout(paths);
  // The agent's default working directory is the workspace tree under this
  // harness's home, and a shell cannot start in a directory that is not there.
  // The install script creates the real one; a test harness makes its own.
  await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
  // Every vmodel names a prompt file and a missing file is an error, so the alias
  // the tests use gets an empty one. An empty prompt is a legitimate value and
  // means "no addition to the system prompt".
  await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
  await writeFile(join(paths.promptsDir, "vmodel", "faux.md"), "", "utf8");

  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const base = defaultConfig();
  const config: Config = {
    ...base,
    ...(options.config ?? {}),
    // The boot repair sweeps the attachment roots, and the built-in default is
    // `~/attachments` and `~/share` under the run account's home. A test boot must
    // sweep this harness's own temporary home, never the real one.
    attachments: {
      dir: join(home, "attachments"),
      shareDir: join(home, "share"),
      ...(options.config?.attachments ?? {}),
    },
    vmodels: {
      ...base.vmodels,
      ...(options.config?.vmodels ?? {}),
      // The faux provider is the only model a test can rely on, so it gets an
      // alias of its own and the root agent points at it.
      faux: { provider: "faux", modelId: model.id, thinkingLevel: "medium", prompt: "faux" },
    },
    agent: {
      ...base.agent,
      ...(options.config?.agent ?? {}),
      vmodel: options.config?.agent?.vmodel || "faux",
      extensions: options.config?.agent?.extensions ?? base.agent.extensions,
    },
    code: {
      snapshot: paths.snapshotTree,
      workspace: paths.workspaceTree,
      ...(options.config?.code ?? {}),
    },
  };

  const secrets = new SecretRegistry({ dir: paths.secretsDir, includeModelCredentials: false });
  await secrets.load();
  const logger = createLogger({ console: false, file: paths.appLog });
  const audit = createAuditLog({ file: paths.auditLog, redactor: () => secrets.redactor() });
  const events = createEventBus();

  faux.setResponses(options.responses ?? [fauxAssistantMessage([fauxText("ok")])]);

  const runtime = await createAgentRuntime({
    paths,
    config,
    storage: new MemoryStorage(),
    archiveStorage: new MemoryStorage(),
    models,
    secrets,
    logger,
    audit,
    events: events.sink,
    loadExtensions: options.loadExtensions ?? false,
    watchExtensions: false,
    ...(options.prepareRoot === undefined ? {} : { prepareRoot: options.prepareRoot }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });

  return {
    runtime,
    paths,
    config,
    faux,
    models,
    events,
    close: async () => {
      await runtime.close();
      // The home tree lives under the cleanup root, and the harness points the
      // runtime at it. Removing it here keeps a test from leaving a directory
      // (and any link inside it) behind after the run.
      await rm(home, { recursive: true, force: true });
    },
  };
}
