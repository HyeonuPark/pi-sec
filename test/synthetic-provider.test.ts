/**
 * The synthetic.new provider pi-sec registers itself.
 *
 * One real `ModelRuntime` over a temporary home, so the catalog and the login
 * panel read what the daemon reads. Nothing here reaches synthetic.new: the
 * catalog is composed from the fallback model and the stored list, the list
 * itself comes from a fake fetch, and the one login this test runs supplies the
 * key from the test instead of from the network.
 *
 * The key below is a fake, and the secret store is the temporary home's own, so
 * no credential of the machine is read or written.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels, syntheticCatalogOf } from "../src/agent/models.ts";
import { syntheticCatalogFile } from "../src/agent/synthetic-catalog.ts";
import { SYNTHETIC_MODEL_ID, SYNTHETIC_PROVIDER_ID, syntheticProviderConfig } from "../src/agent/synthetic-provider.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { ModelLoginService } from "../src/runtime/model-login.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";
import { modelSecretName } from "../src/secrets/model-credentials.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";

const API_KEY = "test-synthetic-key-0000000000000000";

/** One model of the service's list, with the fields this code reads. */
const LISTED_MODEL = {
  id: "hf:moonshotai/Kimi-K3",
  name: "moonshotai/Kimi-K3",
  display_name: "Kimi K3",
  hugging_face_id: "moonshotai/Kimi-K3",
  input_modalities: ["text"],
  context_length: 262_144,
  max_output_length: 32_768,
  reasoning_parameters: { efforts: ["low", "high"] },
  supported_features: ["tools", "reasoning"],
  pricing: { prompt: "$0.000003", completion: "$0.000015", input_cache_reads: "$0.00000046" },
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface Sandbox {
  readonly paths: Paths;
  readonly models: ModelRuntime;
  readonly secrets: SecretRegistry;
  readonly login: ModelLoginService;
  readonly reads: string[];
  readonly lines: string[];
}

/** The fetch the tests hand the catalog: one good answer, and the calls it saw. */
function listingFetch(reads: string[]): typeof fetch {
  return async (input) => {
    reads.push(String(input));
    return new Response(JSON.stringify({ data: [LISTED_MODEL] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A temporary home whose model runtime is the daemon's own constructor. */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-synthetic-"));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  const secrets = new SecretRegistry({ dir: paths.secretsDir });
  await secrets.load();
  const reads: string[] = [];
  const lines: string[] = [];
  const models = await createModels({
    authPath: paths.authFile,
    modelsPath: paths.modelsFile,
    secretsDir: paths.secretsDir,
    onCredentialsChanged: () => secrets.reload(),
    // No `network`: this sandbox reads only when a key is stored, which is the
    // path the last test below follows.
    syntheticCatalog: { stateDir: paths.stateDir, fetch: listingFetch(reads) },
    log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`),
  });
  const login = new ModelLoginService({
    models,
    audit: createAuditLog({ file: paths.auditLog }),
    logger: createLogger({ console: false, file: paths.appLog }),
    secrets,
    recordFile: paths.modelLoginsFile,
    deviceIdFile: join(paths.stateDir, "device-id"),
  });
  return { paths, models, secrets, login, reads, lines };
}

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

describe("the synthetic.new provider", () => {
  it("holds the one model of the code until a list has been read", async () => {
    const app = await sandbox();

    const provider = app.models.getProvider(SYNTHETIC_PROVIDER_ID);
    expect(provider, "the provider is registered").toBeDefined();
    expect(provider?.baseUrl).toBe("https://api.synthetic.new/openai/v1");

    const model = app.models.getModel(SYNTHETIC_PROVIDER_ID, SYNTHETIC_MODEL_ID);
    expect(model).toEqual(
      expect.objectContaining({
        id: SYNTHETIC_MODEL_ID,
        provider: SYNTHETIC_PROVIDER_ID,
        api: "openai-completions",
        baseUrl: "https://api.synthetic.new/openai/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 524_288,
        maxTokens: 65_536,
        cost: { input: 0.06, cacheRead: 0.003, output: 0.3, cacheWrite: 0 },
      }),
    );

    // The request shape is the built-in DeepSeek provider's `deepseek-flash`
    // one: the same model over a different endpoint.
    expect(model?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      supportsStrictMode: true,
    });
    expect(model?.thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: null, high: "high", max: "max" });

    // Nothing was read: the listing fetch has not been called.
    expect(app.reads).toEqual([]);

    // A fresh config on every call, so one runtime cannot edit another's.
    expect(syntheticProviderConfig()).not.toBe(syntheticProviderConfig());
  });

  it("is offered to the login panel as an API-key provider", async () => {
    const app = await sandbox();

    const listed = await app.login.providers();
    expect(listed.available).toBe(true);
    const synthetic = listed.providers.find((entry) => entry.id === SYNTHETIC_PROVIDER_ID);
    expect(synthetic, "the panel lists synthetic").toBeDefined();
    // A built-in provider of pi-sec, not an extension's.
    expect(synthetic?.extension).toBeNull();
    expect(synthetic?.types).toEqual(["api_key"]);
    expect(synthetic?.configured).toBe(false);
  });

  it("takes the key from the panel, stores it, and reads the list", async () => {
    const app = await sandbox();

    const started = app.login.start(SYNTHETIC_PROVIDER_ID, "api_key");
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;

    // The flow asks for the key, which parks the session on that prompt.
    let state = app.login.state(started.session);
    for (let attempt = 0; attempt < 100 && state?.prompt === null; attempt += 1) {
      await sleep(10);
      state = app.login.state(started.session);
    }
    expect(state?.prompt?.type).toBe("secret");
    expect(state?.prompt?.message).toBe("Enter API key");

    const answered = app.login.answer(started.session, API_KEY);
    expect(answered.ok, JSON.stringify(answered)).toBe(true);

    let finished = app.login.state(started.session);
    for (let attempt = 0; attempt < 100 && finished?.status !== "succeeded"; attempt += 1) {
      await sleep(10);
      finished = app.login.state(started.session);
    }
    expect(finished?.status, JSON.stringify(finished)).toBe("succeeded");

    const secretFile = join(app.paths.secretsDir, modelSecretName(SYNTHETIC_PROVIDER_ID, "key"));
    expect(readFileSync(secretFile, "utf8").trim()).toBe(API_KEY);
    const auth = JSON.parse(await readFile(app.paths.authFile, "utf8"));
    expect(auth[SYNTHETIC_PROVIDER_ID]).toEqual({ type: "api_key", key: { file: modelSecretName(SYNTHETIC_PROVIDER_ID, "key") } });

    const after = await app.login.providers();
    expect(after.providers.find((entry) => entry.id === SYNTHETIC_PROVIDER_ID)?.configured).toBe(true);
    expect(await app.models.hasConfiguredAuth(SYNTHETIC_PROVIDER_ID)).toBe(true);

    // A stored key is what a list read waits for: it runs, once, without the
    // interval, and its models replace the fallback model.
    const catalog = syntheticCatalogOf(app.models);
    expect(catalog, "the daemon's catalog is reachable").toBeDefined();
    for (let attempt = 0; attempt < 100 && app.reads.length === 0; attempt += 1) {
      await sleep(10);
    }
    expect(app.reads).toEqual(["https://api.synthetic.new/openai/v1/models"]);
    for (let attempt = 0; attempt < 100 && !app.models.getModel(SYNTHETIC_PROVIDER_ID, LISTED_MODEL.id); attempt += 1) {
      await sleep(10);
    }
    expect(app.models.getModels(SYNTHETIC_PROVIDER_ID).map((entry) => entry.id)).toEqual([LISTED_MODEL.id]);
    expect(app.models.getModel(SYNTHETIC_PROVIDER_ID, SYNTHETIC_MODEL_ID)).toBeUndefined();

    // The key is credential material: it is in its own file and nowhere else.
    const stored = readFileSync(syntheticCatalogFile(app.paths.stateDir), "utf8");
    expect(stored).toContain(LISTED_MODEL.id);
    expect(stored).not.toContain(API_KEY);
    expect(app.lines.join("\n")).not.toContain(API_KEY);
    expect(readFileSync(app.paths.appLog, "utf8")).not.toContain(API_KEY);
  });
});
