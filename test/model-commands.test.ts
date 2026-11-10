/**
 * `pi-sec models` and `pi-sec setup-model`.
 *
 * Both commands run as a child process, the way an operator runs them. The
 * refusals matter as much as the write: a refused run leaves `config.json`
 * byte-for-byte as it was, because the next boot reads that file.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetupModelPlan, writeSetupModel } from "../src/config/write.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/acme/", import.meta.url));

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlink(join(root, ".pi", "sec", "extensions", "node_modules")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface Sandbox {
  readonly paths: Paths;
  readonly env: NodeJS.ProcessEnv;
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-model-commands-"));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  const homeDir = join(root, "home");
  await ensureLayout(paths);
  await mkdir(homeDir, { recursive: true });
  return { paths, env: { PI_SEC_HOME: paths.home, HOME: homeDir, PATH: process.env.PATH, TERM: "dumb" } };
}

/** The fixture provider, plus a `models.json` provider that needs no server for a listing. */
async function writeProviders(sb: Sandbox): Promise<void> {
  await cp(FIXTURE, join(sb.paths.extensionsDir, "acme"), { recursive: true });
  await writeFile(
    join(sb.paths.extensionsDir, "acme", "config.json"),
    JSON.stringify({ answer: "command fixture" }),
    "utf8",
  );
  await writeFile(
    sb.paths.modelsFile,
    JSON.stringify({
      providers: {
        "local-fake": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fake-local-endpoint-key",
          models: [
            {
              id: "fake-local",
              name: "Fake Local",
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 1_024,
              reasoning: false,
            },
          ],
        },
      },
    }),
    "utf8",
  );
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(sb: Sandbox, args: readonly string[]): Run {
  const run = spawnSync(
    process.execPath,
    [join(REPO, "src", "cli.ts"), ...args],
    { cwd: REPO, env: sb.env, encoding: "utf8", timeout: 120_000 },
  );
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function lines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/** The plan the CLI builds for `--provider acme --model acme-fake-chat`. */
const DEFAULT_PLAN = buildSetupModelPlan({
  provider: "acme",
  modelId: "acme-fake-chat",
  thinking: "medium",
  force: false,
});

const ROOT_KEY = { provider: "acme", modelId: "acme-fake-chat", thinkingLevel: "medium", prompt: "default" };

describe("pi-sec models", () => {
  it("lists each model with its source and whether it has credentials", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const run = runCli(sb, ["models"]);
    expect(run.status, run.stderr).toBe(0);
    const rows = lines(run.stdout);

    // A built-in provider, the `models.json` one and the extension one, each
    // labelled with the layer it comes from.
    expect(rows).toContain("deepseek/deepseek-flash\tsource=builtin\tauth=no");
    expect(rows).toContain("local-fake/fake-local\tsource=models.json\tauth=yes");
    expect(rows).toContain("acme/acme-fake-chat\tsource=extension:acme\tauth=yes");
    expect(rows).toContain("acme-native/acme-native-chat\tsource=extension:acme\tauth=no");
    for (const row of rows) expect(row).toMatch(/^[^/\t]+\/[^\t]+\tsource=(builtin|models\.json|extension:[^\t]+)\tauth=(yes|no)$/);
  }, 60_000);

  it("narrows to one provider, and refuses an id it does not know", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const one = runCli(sb, ["models", "--provider", "local-fake"]);
    expect(one.status, one.stderr).toBe(0);
    expect(lines(one.stdout)).toEqual(["local-fake/fake-local\tsource=models.json\tauth=yes"]);

    const unknown = runCli(sb, ["models", "--provider", "nope"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('no provider named "nope"');
  }, 60_000);
});

describe("pi-sec setup-model", () => {
  it("writes the four vmodels and the two agent keys, and keeps every other key", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const before = { timezone: "Asia/Tokyo", server: { port: 19555 }, vmodels: {}, agent: { roles: [] } };
    await writeFile(sb.paths.configFile, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });

    const run = runCli(sb, ["setup-model", "--provider", "acme", "--model", "acme-fake-chat"]);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`wrote vmodels root, orchestrator, planner, worker to ${sb.paths.configFile}`);

    const written = JSON.parse(await readFile(sb.paths.configFile, "utf8")) as Record<string, any>;
    expect(written["vmodels"]).toEqual({ root: ROOT_KEY, orchestrator: ROOT_KEY, planner: ROOT_KEY, worker: ROOT_KEY });
    // The root's own rules live in `root-agent`, the shared user-facing rules in
    // `user-facing-agent`, so an empty list gets both, in that order.
    expect(written["agent"]).toEqual({ vmodel: "root", roles: ["root-agent", "user-facing-agent"] });
    // Untouched keys keep their values.
    expect(written["timezone"]).toBe("Asia/Tokyo");
    expect(written["server"]).toEqual({ port: 19555 });
    // The file stays private to the account.
    expect((await stat(sb.paths.configFile)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it("gives the worker its own model when one is named", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const run = runCli(sb, [
      "setup-model",
      "--provider",
      "acme",
      "--model",
      "acme-fake-chat",
      "--thinking",
      "low",
      "--worker-provider",
      "acme-native",
      "--worker-model",
      "acme-native-chat",
    ]);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const written = JSON.parse(await readFile(sb.paths.configFile, "utf8")) as Record<string, any>;
    expect(written["vmodels"]["root"]).toEqual({ ...ROOT_KEY, thinkingLevel: "low" });
    expect(written["vmodels"]["orchestrator"]).toEqual({ ...ROOT_KEY, thinkingLevel: "low" });
    // The planner starts as a copy of the orchestrator.
    expect(written["vmodels"]["planner"]).toEqual({ ...ROOT_KEY, thinkingLevel: "low" });
    expect(written["vmodels"]["worker"]).toEqual({
      provider: "acme-native",
      modelId: "acme-native-chat",
      thinkingLevel: "low",
      prompt: "default",
    });
  }, 60_000);

  it("keeps a role list that is not empty", async () => {
    const sb = await sandbox();
    await writeFile(
      sb.paths.configFile,
      `${JSON.stringify({ agent: { vmodel: "", roles: ["root", "orchestrator"] } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    // The role list is decided by the write, so this case calls it directly. The CLI success run is the first case.
    expect(await writeSetupModel(sb.paths.configFile, DEFAULT_PLAN)).toMatchObject({ status: "written" });
    const written = JSON.parse(await readFile(sb.paths.configFile, "utf8")) as Record<string, any>;
    expect(written["agent"]).toEqual({ vmodel: "root", roles: ["root", "orchestrator"] });
  }, 60_000);

  it("writes nothing when the model is not in the catalog", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const before = `${JSON.stringify({ timezone: "UTC" }, null, 2)}\n`;
    await writeFile(sb.paths.configFile, before, { mode: 0o600 });

    const run = runCli(sb, ["setup-model", "--provider", "acme", "--model", "no-such-model"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("acme/no-such-model is not in the catalog");
    expect(run.stderr).toContain("nothing was written");
    expect(await readFile(sb.paths.configFile, "utf8")).toBe(before);
  }, 60_000);

  it("refuses to overwrite an existing vmodel without --force, and overwrites with it", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    // The first write only prepares the file, so it is a direct call. The refusal and the --force run stay on the CLI.
    expect(await writeSetupModel(sb.paths.configFile, DEFAULT_PLAN)).toMatchObject({ status: "written" });
    const written = await readFile(sb.paths.configFile, "utf8");

    const refused = runCli(sb, ["setup-model", "--provider", "acme-native", "--model", "acme-native-chat"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('already defines the vmodel "root", "orchestrator", "planner", "worker"');
    expect(refused.stderr).toContain("--force");
    expect(await readFile(sb.paths.configFile, "utf8")).toBe(written);

    const forced = runCli(sb, [
      "setup-model",
      "--provider",
      "acme-native",
      "--model",
      "acme-native-chat",
      "--force",
    ]);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    const overwritten = JSON.parse(await readFile(sb.paths.configFile, "utf8")) as Record<string, any>;
    expect(overwritten["vmodels"]["root"]).toEqual({
      provider: "acme-native",
      modelId: "acme-native-chat",
      thinkingLevel: "medium",
      prompt: "default",
    });
  }, 60_000);

  it("refuses a run without a model, an unknown thinking level, or half a worker pair", async () => {
    const sb = await sandbox();
    await writeProviders(sb);
    const noModel = runCli(sb, ["setup-model", "--provider", "acme"]);
    expect(noModel.status).toBe(2);
    expect(noModel.stderr).toContain("usage: pi-sec setup-model");

    const badLevel = runCli(sb, ["setup-model", "--provider", "acme", "--model", "acme-fake-chat", "--thinking", "highish"]);
    expect(badLevel.status).toBe(2);
    expect(badLevel.stderr).toContain('unknown thinking level "highish"');

    const halfPair = runCli(sb, [
      "setup-model",
      "--provider",
      "acme",
      "--model",
      "acme-fake-chat",
      "--worker-provider",
      "acme-native",
    ]);
    expect(halfPair.status).toBe(2);
    expect(halfPair.stderr).toContain("--worker-provider and --worker-model go together");
    // None of the three wrote a file.
    await expect(readFile(sb.paths.configFile, "utf8")).rejects.toThrow();
  }, 90_000);
});
