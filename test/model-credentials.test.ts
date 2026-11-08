import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Record every rename, to read the write order and to see that each write went
// through a dot-named temporary file.
const renames: { from: string; to: string }[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renames.push({ from, to });
      return actual.rename(from, to);
    },
  };
});

const { createModels } = await import("../src/agent/models.ts");
const { migrateModelCredentials, modelSecretName, ModelCredentialStore } = await import(
  "../src/secrets/model-credentials.ts"
);
const { SecretRegistry } = await import("../src/secrets/registry.ts");
const { isValidSecretName, SECRET_NAME_PATTERN } = await import("../src/secrets/upload.ts");

// Fake values only. Each is long and unique so a search for it cannot miss.
const FAKE_KEY = "sk-fake-deepseek-key-0123456789abcdef";
const FAKE_ACCESS = "sk-ant-fake-access-token-aaaaaaaaaaaaaaaa";
const FAKE_REFRESH = "sk-ant-fake-refresh-token-rrrrrrrrrrrrrrrr";
const NEW_ACCESS = "sk-ant-fake-access-token-NEW-bbbbbbbbbbbbbb";
const NEW_REFRESH = "sk-ant-fake-refresh-token-NEW-ssssssssssssss";
const FAKES = [FAKE_KEY, FAKE_ACCESS, FAKE_REFRESH, NEW_ACCESS, NEW_REFRESH];

interface Logged {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

async function setup(auth: unknown) {
  const home = await mkdtemp(join(tmpdir(), "pi-sec-model-auth-"));
  const authPath = join(home, "auth.json");
  const secretsDir = join(home, "secrets");
  const authText = JSON.stringify(auth, null, 2);
  await writeFile(authPath, authText, { mode: 0o600 });
  const logs: Logged[] = [];
  const log = (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => {
    logs.push({ level, message, fields });
  };
  return { home, authPath, secretsDir, authText, logs, log };
}

function inlineAuth() {
  return {
    deepseek: { type: "api_key", key: FAKE_KEY },
    anthropic: { type: "oauth", refresh: FAKE_REFRESH, access: FAKE_ACCESS, expires: 4_102_444_800_000 },
  };
}

function referencedAuth() {
  return {
    deepseek: { type: "api_key", key: { file: "model-auth.deepseek.key" } },
    anthropic: {
      type: "oauth",
      refresh: { file: "model-auth.anthropic.refresh" },
      access: { file: "model-auth.anthropic.access" },
      expires: 4_102_444_800_000,
    },
  };
}

async function writeSecrets(secretsDir: string, values: Record<string, string>) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(values)) await writeFile(join(secretsDir, name), `${value}\n`, { mode: 0o600 });
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function expectNoFake(text: string) {
  for (const fake of FAKES) expect(text).not.toContain(fake);
}

beforeEach(() => {
  renames.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("model credential names", () => {
  it("passes the secret write name rule for every name it makes", () => {
    for (const [provider, field] of [
      ["deepseek", "key"],
      ["anthropic", "access"],
      ["anthropic", "refresh"],
    ] as const) {
      const name = modelSecretName(provider, field);
      expect(name).toBe(`model-auth.${provider}.${field}`);
      expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
      expect(isValidSecretName(name)).toBe(true);
    }
  });
});

describe("ModelCredentialStore reads", () => {
  it("reads values from the files that auth.json names", async () => {
    const env = await setup(referencedAuth());
    await writeSecrets(env.secretsDir, {
      "model-auth.deepseek.key": FAKE_KEY,
      "model-auth.anthropic.access": FAKE_ACCESS,
      "model-auth.anthropic.refresh": FAKE_REFRESH,
    });
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });

    expect(await store.read("deepseek")).toEqual({ type: "api_key", key: FAKE_KEY });
    expect(await store.read("anthropic")).toEqual({
      type: "oauth",
      refresh: FAKE_REFRESH,
      access: FAKE_ACCESS,
      expires: 4_102_444_800_000,
    });
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([
      { providerId: "deepseek", type: "api_key" },
      { providerId: "anthropic", type: "oauth" },
    ]);
  });

  it("reads the inline format too", async () => {
    const env = await setup(inlineAuth());
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });
    expect(await store.read("deepseek")).toEqual({ type: "api_key", key: FAKE_KEY });
    expect((await store.read("anthropic"))?.type).toBe("oauth");
  });

  it("resolves an api_key value the way the default store does", async () => {
    vi.stubEnv("PI_SEC_FAKE_KEY_VAR", FAKE_KEY);
    const env = await setup({ deepseek: { type: "api_key", key: { file: "model-auth.deepseek.key" } } });
    await writeSecrets(env.secretsDir, { "model-auth.deepseek.key": "$PI_SEC_FAKE_KEY_VAR" });
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });
    expect(await store.read("deepseek")).toEqual({ type: "api_key", key: FAKE_KEY });
  });

  it("fails with names only when a referenced file is missing or auth.json is broken", async () => {
    const env = await setup(referencedAuth());
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });
    await expect(store.read("deepseek")).rejects.toThrow(/model-auth\.deepseek\.key for deepseek\.key is missing/);

    await writeFile(env.authPath, `{ "deepseek": { "key": "${FAKE_KEY}" `);
    const error = await store.read("deepseek").catch((caught: Error) => caught);
    expect(String(error)).toMatch(/not valid JSON/);
    expectNoFake(String(error));
  });

  it("serves a model runtime: createModels with a secret store resolves the key from its file", async () => {
    const env = await setup(referencedAuth());
    await writeSecrets(env.secretsDir, {
      "model-auth.deepseek.key": FAKE_KEY,
      "model-auth.anthropic.access": FAKE_ACCESS,
      "model-auth.anthropic.refresh": FAKE_REFRESH,
    });
    const models = await createModels({ authPath: env.authPath, modelsPath: null, secretsDir: env.secretsDir });
    const auth = await models.getAuth("deepseek");
    expect(auth?.auth.apiKey).toBe(FAKE_KEY);
  });
});

describe("ModelCredentialStore writes", () => {
  it("writes a refresh to the secret files, refresh then access then auth.json, each atomically and 0600", async () => {
    const env = await setup(referencedAuth());
    await writeSecrets(env.secretsDir, {
      "model-auth.deepseek.key": FAKE_KEY,
      "model-auth.anthropic.access": FAKE_ACCESS,
      "model-auth.anthropic.refresh": FAKE_REFRESH,
    });
    const registry = new SecretRegistry({
      dir: env.secretsDir,
      includeModelCredentials: true,
      modelCredentialPaths: [env.authPath],
    });
    await registry.load();
    let reloads = 0;
    const store = new ModelCredentialStore({
      authPath: env.authPath,
      secretsDir: env.secretsDir,
      log: env.log,
      onChange: async () => {
        reloads += 1;
        await registry.reload();
      },
    });
    // The new value is not known to the registry before the write.
    expect(registry.redactor().redact(NEW_ACCESS)).toBe(NEW_ACCESS);

    const seen: unknown[] = [];
    const result = await store.modify("anthropic", async (current) => {
      seen.push(current);
      return { type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 4_102_444_900_000 };
    });

    // The refresh callback sees the values, not the references.
    expect(seen).toEqual([{ type: "oauth", refresh: FAKE_REFRESH, access: FAKE_ACCESS, expires: 4_102_444_800_000 }]);
    expect(result).toEqual({ type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 4_102_444_900_000 });

    expect(renames.map((entry) => entry.to)).toEqual([
      join(env.secretsDir, "model-auth.anthropic.refresh"),
      join(env.secretsDir, "model-auth.anthropic.access"),
      env.authPath,
    ]);
    for (const entry of renames) expect(entry.from.split("/").pop()!.startsWith(".")).toBe(true);

    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.refresh"), "utf8")).toBe(NEW_REFRESH);
    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.access"), "utf8")).toBe(NEW_ACCESS);
    expect(await mode(join(env.secretsDir, "model-auth.anthropic.refresh"))).toBe(0o600);
    expect(await mode(join(env.secretsDir, "model-auth.anthropic.access"))).toBe(0o600);
    expect(await mode(env.authPath)).toBe(0o600);

    const authText = await readFile(env.authPath, "utf8");
    expectNoFake(authText);
    expect(JSON.parse(authText)).toEqual({ ...referencedAuth(), anthropic: { ...referencedAuth().anthropic, expires: 4_102_444_900_000 } });

    // No temporary file is left, and the lock is released.
    expect((await readdir(env.secretsDir)).filter((name) => name.startsWith("."))).toEqual([]);
    expect((await readdir(env.home)).filter((name) => name.startsWith(".") || name.endsWith(".lock"))).toEqual([]);

    // The registry reloaded once, and the new values are redacted from then on.
    expect(reloads).toBe(1);
    expect(registry.redactor().redact(`a ${NEW_ACCESS} b ${NEW_REFRESH}`)).toBe(
      "a \u27e6secret:model-auth.anthropic.access\u27e7 b \u27e6secret:model-auth.anthropic.refresh\u27e7",
    );
    expect(registry.names()).toEqual(["model-auth.anthropic.access", "model-auth.anthropic.refresh", "model-auth.deepseek.key"]);

    expectNoFake(JSON.stringify(env.logs));
    expect(env.logs.some((line) => line.message.includes("written to secret files"))).toBe(true);
  });

  it("turns an inline credential into references on a write without a registry (login)", async () => {
    const env = await setup({ deepseek: { type: "api_key", key: "sk-old-inline-value-xxxxxxxx" } });
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir, log: env.log });
    await store.modify("deepseek", async () => ({ type: "api_key", key: FAKE_KEY }));
    expect(await readFile(join(env.secretsDir, "model-auth.deepseek.key"), "utf8")).toBe(FAKE_KEY);
    expect(JSON.parse(await readFile(env.authPath, "utf8"))).toEqual({
      deepseek: { type: "api_key", key: { file: "model-auth.deepseek.key" } },
    });
    expect(await store.read("deepseek")).toEqual({ type: "api_key", key: FAKE_KEY });
    expectNoFake(JSON.stringify(env.logs));
  });

  it("leaves everything as it was when the callback returns nothing, and does not reload", async () => {
    const env = await setup(inlineAuth());
    let reloads = 0;
    const store = new ModelCredentialStore({
      authPath: env.authPath,
      secretsDir: env.secretsDir,
      onChange: () => {
        reloads += 1;
      },
    });
    await store.modify("anthropic", async () => undefined);
    expect(await readFile(env.authPath, "utf8")).toBe(env.authText);
    expect(renames).toEqual([]);
    expect(reloads).toBe(0);
  });

  it("keeps the write when the registry reload fails, and logs no value", async () => {
    const env = await setup(referencedAuth());
    await writeSecrets(env.secretsDir, { "model-auth.anthropic.access": FAKE_ACCESS, "model-auth.anthropic.refresh": FAKE_REFRESH });
    const store = new ModelCredentialStore({
      authPath: env.authPath,
      secretsDir: env.secretsDir,
      log: env.log,
      onChange: () => {
        throw new Error("registry unreadable");
      },
    });
    await store.modify("anthropic", async () => ({ type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 1 }));
    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.refresh"), "utf8")).toBe(NEW_REFRESH);
    expect(env.logs.some((line) => line.level === "warn" && line.message.includes("reload"))).toBe(true);
    expectNoFake(JSON.stringify(env.logs));
  });

  it("deletes a credential from auth.json and keeps its secret files", async () => {
    const env = await setup(referencedAuth());
    await writeSecrets(env.secretsDir, { "model-auth.deepseek.key": FAKE_KEY });
    let reloads = 0;
    const store = new ModelCredentialStore({
      authPath: env.authPath,
      secretsDir: env.secretsDir,
      log: env.log,
      onChange: () => {
        reloads += 1;
      },
    });
    await store.delete("deepseek");
    expect(Object.keys(JSON.parse(await readFile(env.authPath, "utf8")))).toEqual(["anthropic"]);
    expect(await readFile(join(env.secretsDir, "model-auth.deepseek.key"), "utf8")).toBe(`${FAKE_KEY}\n`);
    expect(reloads).toBe(1);
    expectNoFake(JSON.stringify(env.logs));
  });
});

describe("migrateModelCredentials", () => {
  const now = () => new Date(2030, 9, 21, 4, 30, 15);

  it("copies auth.json, writes each value to a 0600 file, then rewrites auth.json with references", async () => {
    const env = await setup(inlineAuth());
    const result = await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, log: env.log, now });

    expect(result.status).toBe("migrated");
    const backup = `${env.authPath}.bak-20301021-model-auth`;
    expect(result).toMatchObject({ backup });
    expect(await readFile(backup, "utf8")).toBe(env.authText);
    expect(await mode(backup)).toBe(0o600);

    for (const [name, value] of [
      ["model-auth.deepseek.key", FAKE_KEY],
      ["model-auth.anthropic.access", FAKE_ACCESS],
      ["model-auth.anthropic.refresh", FAKE_REFRESH],
    ] as const) {
      expect(await readFile(join(env.secretsDir, name), "utf8")).toBe(value);
      expect(await mode(join(env.secretsDir, name))).toBe(0o600);
    }
    expect(await mode(env.secretsDir)).toBe(0o700);

    const authText = await readFile(env.authPath, "utf8");
    expect(JSON.parse(authText)).toEqual(referencedAuth());
    expectNoFake(authText);
    expect(await mode(env.authPath)).toBe(0o600);

    // auth.json is the last write, after every value is on disk.
    expect(renames.at(-1)?.to).toBe(env.authPath);
    expect(renames.slice(0, -1).map((entry) => entry.to.split("/").pop())).toEqual([
      "model-auth.deepseek.key",
      "model-auth.anthropic.refresh",
      "model-auth.anthropic.access",
    ]);

    // Names and byte counts, never values.
    const logged = JSON.stringify(env.logs);
    expectNoFake(logged);
    expectNoFake(JSON.stringify(result));
    expect(logged).toContain(`"bytes":${FAKE_KEY.length}`);

    // The store reads the moved values; the registry registers them once, by file name.
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });
    expect(await store.read("deepseek")).toEqual({ type: "api_key", key: FAKE_KEY });
    const registry = new SecretRegistry({ dir: env.secretsDir, includeModelCredentials: true, modelCredentialPaths: [env.authPath] });
    await registry.load();
    expect(registry.names()).toEqual(["model-auth.anthropic.access", "model-auth.anthropic.refresh", "model-auth.deepseek.key"]);

    // A second start finds nothing to move.
    expect(await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, now })).toEqual({
      status: "nothing_to_move",
    });
  });

  it("does not overwrite an existing backup of the same day", async () => {
    const env = await setup(inlineAuth());
    await writeFile(`${env.authPath}.bak-20301021-model-auth`, "earlier", { mode: 0o600 });
    const result = await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, now });
    expect(result).toMatchObject({ status: "migrated", backup: `${env.authPath}.bak-20301021-model-auth-043015` });
    expect(await readFile(`${env.authPath}.bak-20301021-model-auth`, "utf8")).toBe("earlier");
  });

  it("stops, changing nothing, when a secret file of the same name holds a different value", async () => {
    const env = await setup(inlineAuth());
    await writeSecrets(env.secretsDir, { "model-auth.anthropic.access": "sk-some-other-fake-value-zzzzzzzz" });
    const result = await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, log: env.log, now });

    expect(result).toEqual({ status: "conflict", conflicts: ["model-auth.anthropic.access"] });
    expect(await readFile(env.authPath, "utf8")).toBe(env.authText);
    expect(await readdir(env.secretsDir)).toEqual(["model-auth.anthropic.access"]);
    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.access"), "utf8")).toBe(
      "sk-some-other-fake-value-zzzzzzzz\n",
    );
    expect((await readdir(env.home)).filter((name) => name.includes(".bak-"))).toEqual([]);
    expect(env.logs).toEqual([
      {
        level: "warn",
        message: "model credential move stopped: a secret file of the same name holds a different value",
        fields: { files: ["model-auth.anthropic.access"] },
      },
    ]);
    expectNoFake(JSON.stringify(env.logs));

    // The daemon keeps running on the inline values.
    const store = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir, log: env.log });
    expect((await store.read("anthropic")) as unknown).toMatchObject({ access: FAKE_ACCESS });

    // A refresh in that state does not overwrite the other file: the clashing
    // field stays inline, the other field moves to its file.
    await store.modify("anthropic", async () => ({ type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 2 }));
    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.access"), "utf8")).toBe(
      "sk-some-other-fake-value-zzzzzzzz\n",
    );
    expect(await readFile(join(env.secretsDir, "model-auth.anthropic.refresh"), "utf8")).toBe(NEW_REFRESH);
    expect(JSON.parse(await readFile(env.authPath, "utf8")).anthropic).toEqual({
      type: "oauth",
      refresh: { file: "model-auth.anthropic.refresh" },
      access: NEW_ACCESS,
      expires: 2,
    });
    expect(await store.read("anthropic")).toEqual({ type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 2 });
    expectNoFake(JSON.stringify(env.logs));
  });

  it("counts a file that already holds the same value as moved", async () => {
    const env = await setup(inlineAuth());
    await writeSecrets(env.secretsDir, { "model-auth.deepseek.key": FAKE_KEY });
    const result = await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, now });
    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.moved.find((entry) => entry.file === "model-auth.deepseek.key")?.alreadyPresent).toBe(true);
    expect(JSON.parse(await readFile(env.authPath, "utf8"))).toEqual(referencedAuth());
  });

  it("reports a broken auth.json without its text and without changing it", async () => {
    const env = await setup({});
    const broken = `{ "deepseek": { "type": "api_key", "key": "${FAKE_KEY}" `;
    await writeFile(env.authPath, broken);
    const result = await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir, log: env.log, now });
    expect(result.status).toBe("failed");
    expectNoFake(JSON.stringify(result));
    expectNoFake(JSON.stringify(env.logs));
    expect(await readFile(env.authPath, "utf8")).toBe(broken);
  });

  it("does nothing when there is no auth.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-model-auth-"));
    expect(await migrateModelCredentials({ authPath: join(home, "auth.json"), secretsDir: join(home, "secrets") })).toEqual({
      status: "absent",
    });
    expect(await readdir(home)).toEqual([]);
  });
});

describe("user-tools/model-auth-restore-plain", () => {
  const script = resolve(import.meta.dirname, "..", "user-tools", "model-auth-restore-plain");

  it("rebuilds an inline auth.json from the secret files, deletes its copy, and prints no value", async () => {
    const env = await setup(inlineAuth());
    await migrateModelCredentials({ authPath: env.authPath, secretsDir: env.secretsDir });

    const run = spawnSync("bash", [script], {
      env: { ...process.env, PI_SEC_HOME: env.home, PI_SEC_SECRETS_DIR: "" },
      input: "restore\n",
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expectNoFake(run.stdout + run.stderr);
    expect(JSON.parse(await readFile(env.authPath, "utf8"))).toEqual(inlineAuth());
    expect(await mode(env.authPath)).toBe(0o600);

    // The copy it made before the write is gone, and it says so.
    expect((await readdir(env.home)).filter((name) => name.includes("-before-restore"))).toEqual([]);
    expect(run.stdout).toMatch(/^deleted backup: .+-before-restore$/m);
    // The secret files stay.
    expect((await readdir(env.secretsDir)).sort()).toEqual([
      "model-auth.anthropic.access",
      "model-auth.anthropic.refresh",
      "model-auth.deepseek.key",
    ]);
  });

  it("keeps the copy when the restore fails, and prints no value", async () => {
    // auth.json names secret files that are not there, so the rewrite fails
    // after the copy is made.
    const env = await setup(referencedAuth());
    const run = spawnSync("bash", [script], {
      env: { ...process.env, PI_SEC_HOME: env.home, PI_SEC_SECRETS_DIR: "" },
      input: "restore\n",
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expectNoFake(run.stdout + run.stderr);
    expect(await readFile(env.authPath, "utf8")).toBe(env.authText);

    const backups = (await readdir(env.home)).filter((name) => name.endsWith("-before-restore"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(env.home, backups[0]!), "utf8")).toBe(env.authText);
    expect(await mode(join(env.home, backups[0]!))).toBe(0o600);
    // The copy stays where the printed line says it is.
    expect(run.stdout).toContain(`backup: ${join(env.home, backups[0]!)}`);
  });

  it("changes nothing without the confirmation word", async () => {
    const env = await setup(referencedAuth());
    const run = spawnSync("bash", [script], {
      env: { ...process.env, PI_SEC_HOME: env.home },
      input: "yes\n",
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(await readFile(env.authPath, "utf8")).toBe(env.authText);
    expect((await readdir(env.home)).filter((name) => name.includes(".bak-"))).toEqual([]);
  });
});
