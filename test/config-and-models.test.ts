/**
 * Configuration, model aliases and model credentials.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { mkdtemp, writeFile, mkdir, utimes, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { ConfigError, deepMerge, envOverrides, loadConfig } from "../src/config/load.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { VALIDATION_TIMEOUT_MS } from "../src/runtime/validation.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createLiveSettings } from "../src/agent/settings.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { VmodelError, VmodelResolver } from "../src/agent/vmodel.ts";
import { buildPaths, ensureLayout, type Paths, expandPath, resolveHome } from "../src/runtime/paths.ts";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { rootVmodelProblem } from "../src/cli.ts";
import type { JobRoutineSpec } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createJobsExtension } from "../src/extensions/jobs.ts";
import { writeRoutine } from "../src/jobs/routine.ts";
import { controlPathFor, hostKeyName, pinnedHostKey, readRemoteMachines } from "../src/remote/machines.ts";
import { HOST_KEY_MISMATCH_LINE, readHeartbeat, sshArguments, sshOptions, type SshResult, type SshTarget } from "../src/remote/ssh.ts";
import { MODEL_CATALOG_NOTE, collectModelCatalog, readModelsJsonProviderIds, writeModelCatalogFile, type ModelCatalogModel, type ModelCatalogProviderOwners, type ModelCatalogSourceReader } from "../src/agent/model-catalog-file.ts";
import { ModelCredentialStore } from "../src/secrets/model-credentials.ts";

describe("config.test.ts", () => {
  describe("config", () => {
    it("deep merges nested objects and replaces arrays", () => {
      const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
      expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [9] });
    });

    it("maps PI_SEC_* environment variables with __ nesting", () => {
      const overrides = envOverrides({ PI_SEC_SERVER__PORT: "9000", PI_SEC_AGENT__COMPACTION__ENABLED: "false" });
      expect(overrides).toEqual({ server: { port: 9000 }, agent: { compaction: { enabled: false } } });
    });

    it("matches camelCase config keys without regard to case", () => {
      // The keys are camelCase and environment variables are conventionally
      // upper-case: a literal reading produced `server.basepath`, which the schema
      // then rejected — so the documented form has to fold onto the real names.
      const overrides = envOverrides({
        PI_SEC_SERVER__BASEPATH: "/sec",
        PI_SEC_SERVER__PUBLICURL: "https://x.example.com/sec",
        PI_SEC_SCHEDULER__TICKMS: "5000",
        PI_SEC_AGENT__COMPACTION__BACKGROUNDTOKENS: "1234",
      });
      expect(overrides).toEqual({
        server: { basePath: "/sec", publicUrl: "https://x.example.com/sec" },
        scheduler: { tickMs: 5000 },
        agent: { compaction: { backgroundTokens: 1234 } },
      });
    });

    it("keeps a key that matches nothing, so the schema still refuses it", () => {
      const overrides = envOverrides({ PI_SEC_SERVER__BASEPTH: "oops" });
      // Kept as written, not lower-cased: the schema error then shows a path that
      // no config.json could contain, which is the hint that it came from the
      // environment.
      expect(overrides).toEqual({ server: { BASEPTH: "oops" } });
    });

    it("leaves the variables that are not config keys alone", () => {
      // `PI_SEC_RUNNER` is the runner's flag for the restart route, not a setting:
      // folding it in made the daemon refuse to boot with "/RUNNER schema is
      // false" under `user-tools/run`, which is the one place it is set.
      expect(envOverrides({ PI_SEC_HOME: "/tmp/x", PI_SEC_PRIVATE_TMP: "1", PI_SEC_RUNNER: "1" })).toEqual({});
    });

    it("loads a config while the runner flag is set", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const loaded = await loadConfig({ home, env: { PI_SEC_HOME: home, PI_SEC_RUNNER: "1" } });
      expect(loaded.source).toBe("defaults");
      expect(loaded.config.server.port).toBe(8787);
    });

    it("applies a camelCase override through loadConfig", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ server: { publicUrl: "https://x.example.com/sec" } }));
      const loaded = await loadConfig({ home, env: { PI_SEC_SERVER__BASEPATH: "/sec" } });
      expect(loaded.config.server.basePath).toBe("/sec");
      expect(loaded.config.server.publicUrl).toBe("https://x.example.com/sec");
    });

    it("loads defaults when no config file exists", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.source).toBe("defaults");
      expect(loaded.config.server.port).toBe(8787);
    });

    it("defaults the harness time zone to UTC", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.config.timezone).toBe("UTC");
      // Not the same key as the scheduler's: that one is a routine's default zone.
      expect(loaded.config.scheduler.timezone).toBe("UTC");
    });

    it("takes the harness time zone from the file", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ timezone: "Asia/Tokyo" }));
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.config.timezone).toBe("Asia/Tokyo");
    });

    it("rejects a time zone name no clock can resolve", async () => {
      // A string to the schema, and every reader would format the wrong clock.
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ timezone: "Mars/Base" }));
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/timezone");
      expect((error as ConfigError).issues.join("\n")).toContain("Mars/Base");
    });

    it("fails closed on unknown keys", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ version: 1, surprise: true }));
      await expect(loadConfig({ home, env: {} })).rejects.toBeInstanceOf(ConfigError);
    });

    it("applies file, env, and explicit overrides in precedence order", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ version: 1, server: { ...defaultConfig().server, port: 1000 } }));
      const loaded = await loadConfig({ home, env: { PI_SEC_SERVER__PORT: "2000" }, overrides: { server: { port: 3000 } } });
      expect(loaded.config.server.port).toBe(3000);
    });

    /*
     * These are valid strings to the schema, and both used to be discarded in
     * silence — which turned a typo into a lost mount point and a `Location`
     * header pointing outside the proxy. They fail at load now, by design.
     */

    it("rejects a basePath that is a mount URL, and says where the URL belongs", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...base, server: { ...base.server, basePath: "https://example.com/sec/" } }),
      );
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("publicUrl");
    });

    it("rejects a trustedProxies entry that carries a port", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...base, server: { ...base.server, trustedProxies: ["127.0.0.1:8787/32"] } }),
      );
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("port");
    });

    /*
     * A schedule string is valid input to the schema and unusable to the
     * scheduler. It used to be parsed only when its job came due, and the
     * reconciler answers that failure with one `warn` line, so a typo became a job
     * that never fired with nothing else said. These fail at load by design.
     */

    it("rejects a schedule the cron parser cannot read", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          ...base,
          scheduler: {
            ...base.scheduler,
            jobs: [{ name: "nightly", schedule: "0 99 * * *", timezone: "Asia/Tokyo", prompt: "work" }],
          },
        }),
      );
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/scheduler/jobs/0/schedule");
      expect((error as ConfigError).issues.join("\n")).toContain("99");
    });

    it("rejects a schedule that is not five fields", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          ...base,
          scheduler: { ...base.scheduler, jobs: [{ name: "nightly", schedule: "0 6 * *", prompt: "work" }] },
        }),
      );
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/scheduler/jobs/0/schedule");
    });

    it("accepts the expression the deployed schedule uses", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          ...base,
          scheduler: {
            ...base.scheduler,
            jobs: [{ name: "routine-a", schedule: "0 6 * * *", timezone: "Asia/Tokyo", prompt: "work" }],
          },
        }),
      );
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.config.scheduler.jobs[0]?.schedule).toBe("0 6 * * *");
    });

    it("accepts the documented way to declare a subpath mount", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          ...base,
          server: { ...base.server, basePath: "", publicUrl: "https://example.com/sec", trustedProxies: ["127.0.0.1/32"] },
        }),
      );
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.config.server.publicUrl).toBe("https://example.com/sec");
    });

    it("reads the default validation timeout from a config that names no validation section", async () => {
      // A file written before the key existed has no `validation` section, and the
      // defaults are merged under it. The gate must still get a ceiling.
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify({ version: 1 }));
      const loaded = await loadConfig({ home, env: {} });
      expect(loaded.config.validation.timeoutMs).toBe(VALIDATION_TIMEOUT_MS);
    });

    it("rejects a validation timeout below one second", async () => {
      // One second is the floor: a smaller value would cut every gate command
      // before it could say anything about the tree.
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      const base = defaultConfig();
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ ...base, validation: { timeoutMs: 999 } }),
      );
      const error = await loadConfig({ home, env: {} }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/validation/timeoutMs");
    });
  });

  /*
   * `githubPr` is the settings key of the `github-pr` extension, which is off in a
   * fresh install. The checks below are the rules for it: two keys with no
   * default, two numbers with one, the repository name rule, the two spellings of
   * one name that are not an error, and the cross-check between the enabled list
   * and the key. `defaultConfig()` deliberately does not carry the key, so a config
   * that does not name the extension never grows one.
   */

  describe("githubPr settings", () => {
    /** A home with this config, and the load's answer: a config or the error. */
    async function load(document: Record<string, unknown>): Promise<Config | ConfigError> {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-config-"));
      await writeFile(join(home, "config.json"), JSON.stringify(document));
      return await loadConfig({ home, env: {} }).then(
        (loaded) => loaded.config,
        (error: unknown) => error as ConfigError,
      );
    }

    /** The enabled list of a fresh install, with `github-pr` added. */
    const enabledWithGithubPr = [...defaultConfig().agent.extensions.enabled, "github-pr"];

    it("keeps the key out of the code's defaults", () => {
      // A default entry here would put a key into every config that the operator
      // never wrote, and the whole point of "no default" is that the file says.
      expect(defaultConfig()).not.toHaveProperty("githubPr");
      expect("githubPr" in defaultConfig()).toBe(false);
    });

    it("fills the two numbers and keeps the two required keys as written", async () => {
      const config = await load({ githubPr: { writes: true, repos: ["Owner/Repo"] } });
      expect(config).not.toBeInstanceOf(ConfigError);
      expect((config as Config).githubPr).toEqual({
        writes: true,
        repos: ["Owner/Repo"],
        fetchIntervalSeconds: 300,
        diskLimitMegabytes: 2048,
      });
    });

    it("accepts the values at both ends of each range", async () => {
      const config = await load({
        githubPr: { writes: false, repos: ["o/r"], fetchIntervalSeconds: 60, diskLimitMegabytes: 100 },
      });
      expect((config as Config).githubPr?.fetchIntervalSeconds).toBe(60);
      expect((config as Config).githubPr?.diskLimitMegabytes).toBe(100);

      const top = await load({
        githubPr: { writes: false, repos: ["o/r"], fetchIntervalSeconds: 86400, diskLimitMegabytes: 4096 },
      });
      expect((top as Config).githubPr?.diskLimitMegabytes).toBe(4096);
    });

    it("accepts 0 as no limit for the disk cap and refuses the values between 0 and 100", async () => {
      const off = await load({ githubPr: { writes: true, repos: ["o/r"], diskLimitMegabytes: 0 } });
      expect(off).not.toBeInstanceOf(ConfigError);
      expect((off as Config).githubPr?.diskLimitMegabytes).toBe(0);

      const one = await load({ githubPr: { writes: true, repos: ["o/r"], diskLimitMegabytes: 1 } });
      expect(one).toBeInstanceOf(ConfigError);
      expect((one as ConfigError).issues.join("\n")).toContain("/githubPr/diskLimitMegabytes");
    });

    it("refuses a config without writes, and names the key", async () => {
      const error = await load({ githubPr: { repos: ["o/r"] } });
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/githubPr");
      expect((error as ConfigError).issues.join("\n")).toContain("writes");
    });

    it("refuses a config without repos, and a config with an empty list", async () => {
      const missing = await load({ githubPr: { writes: true } });
      expect(missing).toBeInstanceOf(ConfigError);
      expect((missing as ConfigError).issues.join("\n")).toContain("repos");

      const empty = await load({ githubPr: { writes: true, repos: [] } });
      expect(empty).toBeInstanceOf(ConfigError);
      expect((empty as ConfigError).issues.join("\n")).toContain("/githubPr/repos");
    });

    it("refuses a repository name that is not owner/repo", async () => {
      for (const bad of [
        "no-slash",
        "owner/",
        "/repo",
        "owner/repo/extra",
        "own er/repo",
        "owner/.",
        "owner/..",
        `${"a".repeat(40)}/b`,
        `o/${"b".repeat(101)}`,
      ]) {
        const error = await load({ githubPr: { writes: true, repos: [bad] } });
        expect(error, bad).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues.join("\n"), bad).toContain("/githubPr/repos/0");
      }
    });

    it("refuses a repository name whose owner or repo part starts with a hyphen", async () => {
      // `git remote add -n/app <url>` reads `-n` as an option and fails, so a part
      // that starts with a hyphen is refused at load time. GitHub forbids it for an
      // owner as well.
      for (const bad of ["-x/repo", "owner/-repo"]) {
        const error = await load({ githubPr: { writes: true, repos: [bad] } });
        expect(error, bad).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues.join("\n"), bad).toContain("/githubPr/repos/0");
      }

      const fine = await load({ githubPr: { writes: true, repos: ["my-owner/my-repo", "x/y-z_1.a"] } });
      expect(fine).not.toBeInstanceOf(ConfigError);
      expect((fine as Config).githubPr?.repos).toEqual(["my-owner/my-repo", "x/y-z_1.a"]);
    });

    it("accepts a name at the length limits", async () => {
      const longest = `${"a".repeat(39)}/${"b".repeat(100)}`;
      const config = await load({ githubPr: { writes: true, repos: [longest] } });
      expect((config as Config).githubPr?.repos).toEqual([longest]);
    });

    it("refuses a number outside its range", async () => {
      const interval = await load({ githubPr: { writes: true, repos: ["o/r"], fetchIntervalSeconds: 59 } });
      expect(interval).toBeInstanceOf(ConfigError);
      expect((interval as ConfigError).issues.join("\n")).toContain("/githubPr/fetchIntervalSeconds");

      const low = await load({ githubPr: { writes: true, repos: ["o/r"], diskLimitMegabytes: 99 } });
      expect(low).toBeInstanceOf(ConfigError);
      expect((low as ConfigError).issues.join("\n")).toContain("/githubPr/diskLimitMegabytes");

      const high = await load({ githubPr: { writes: true, repos: ["o/r"], diskLimitMegabytes: 4097 } });
      expect(high).toBeInstanceOf(ConfigError);
      expect((high as ConfigError).issues.join("\n")).toContain("/githubPr/diskLimitMegabytes");
    });

    it("refuses a key it does not know", async () => {
      const error = await load({ githubPr: { writes: true, repos: ["o/r"], surprise: 1 } });
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join("\n")).toContain("/githubPr");
    });

    it("accepts two spellings of one repository, and keeps both as the file wrote them", async () => {
      // GitHub compares owner and repository without regard to case, so these name
      // one repository. The extension folds them into one when it reads them; the
      // load is not an error and does not rewrite the operator's spelling.
      const config = await load({ githubPr: { writes: true, repos: ["Owner/Repo", "owner/repo"] } });
      expect(config).not.toBeInstanceOf(ConfigError);
      expect((config as Config).githubPr?.repos).toEqual(["Owner/Repo", "owner/repo"]);
    });

    it("refuses an enabled github-pr with no githubPr key", async () => {
      const error = await load({ agent: { extensions: { enabled: enabledWithGithubPr } } });
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("/githubPr");
      expect(issues).toContain("github-pr");
    });

    it("accepts an enabled github-pr that carries the key", async () => {
      const config = await load({
        agent: { extensions: { enabled: enabledWithGithubPr } },
        githubPr: { writes: true, repos: ["o/r"] },
      });
      expect(config).not.toBeInstanceOf(ConfigError);
      expect((config as Config).agent.extensions.enabled).toContain("github-pr");
    });

    it("leaves a githubPr key alone while the extension is off", async () => {
      // The values are unused then. Refusing the config would block a boot for a
      // key that nothing reads, which is the one thing a stale key must not do.
      const config = await load({ githubPr: { writes: true, repos: ["o/r"] } });
      expect(config).not.toBeInstanceOf(ConfigError);
      expect((config as Config).agent.extensions.enabled).not.toContain("github-pr");
      expect((config as Config).githubPr?.repos).toEqual(["o/r"]);
    });

    it("takes the values from a PI_SEC_ environment variable", async () => {
      // The env path folds a segment onto the schema's own key name, so the
      // upper-case form has to reach `githubPr` and not a key of its own.
      const overrides = envOverrides({ PI_SEC_GITHUBPR__WRITES: "true", PI_SEC_GITHUBPR__REPOS: '["o/r"]' });
      expect(overrides).toEqual({ githubPr: { writes: true, repos: ["o/r"] } });
    });
  });
});

describe("settings.test.ts", () => {
  describe("live harness settings", () => {
    it("places everything the queue holds at one boundary", () => {
      // Every asynchronous arrival lands in the queue: a background tool result, a
      // message from another agent, an input typed while the agent works. Placing
      // one item per boundary costs one run per arrival, so ten subagents
      // reporting would cost ten root runs. This pins the decision so it cannot be
      // flipped back without someone seeing it here.
      const settings = createLiveSettings(() => defaultConfig());
      expect(settings.followUpMode).toBe("all");
      expect(settings.steeringMode).toBe("all");
    });

    it("reads the retry and compaction policy from the current config", () => {
      let config: Config = defaultConfig();
      const settings = createLiveSettings(() => config);
      expect(settings.retry.maxRetries).toBe(config.agent.retry.maxRetries);
      expect(settings.compaction.reserveTokens).toBe(config.agent.compaction.reserveTokens);

      config = {
        ...config,
        agent: {
          ...config.agent,
          retry: { ...config.agent.retry, maxRetries: 7 },
          compaction: { ...config.agent.compaction, reserveTokens: 1_000 },
        },
      };
      // Getters, not a copy: a config reload reaches the next run with no restart.
      expect(settings.retry.maxRetries).toBe(7);
      expect(settings.compaction.reserveTokens).toBe(1_000);
    });

    it("carries the cache retention of the current config, and nothing when the key is absent", () => {
      let config: Config = defaultConfig();
      const settings = createLiveSettings(() => config);

      // The default names no retention, so the object the library spreads into the
      // request options holds no value at all: the library decides from its own
      // default and `PI_CACHE_RETENTION`, which is the behavior before the
      // key existed.
      expect(config.agent.stream.cacheRetention).toBeUndefined();
      expect(settings.stream).toEqual({});
      expect("cacheRetention" in (settings.stream ?? {})).toBe(false);

      config = { ...config, agent: { ...config.agent, stream: { cacheRetention: "long" } } };
      expect(settings.stream?.cacheRetention).toBe("long");

      // Read on every resolution, so a reload reaches the next request.
      config = { ...config, agent: { ...config.agent, stream: { cacheRetention: "none" } } };
      expect(settings.stream?.cacheRetention).toBe("none");

      config = { ...config, agent: { ...config.agent, stream: {} } };
      expect(settings.stream).toEqual({});
    });
  });

  describe("the cache retention a request carries", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    /**
     * The options one model request was sent with.
     *
     * The faux provider is the only provider a test has, and it receives the same
     * options object the model library builds for a real one, so what it sees here
     * is what Anthropic would see. The factory this installs is the last response
     * in the script, so the request it describes is the one the input started.
     */
    async function optionsOf(config: Partial<Config>): Promise<SimpleStreamOptions | undefined> {
      const test = await createTestHarness({ config });
      harness = test;
      let seen: SimpleStreamOptions | undefined;
      test.faux.setResponses([
        (_messages, options) => {
          seen = options;
          return fauxAssistantMessage([fauxText("ok")]);
        },
      ]);
      const conversation = await resolveDefaultConversation(
        test.runtime.harness,
        test.config,
        test.runtime.paths,
        BACKGROUND_CONTEXT,
      );
      const submission = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      return seen;
    }

    it("carries the configured value, and carries nothing when the key is absent", async () => {
      const off = await optionsOf({});
      // No value: the library's own decision, not a value this code chose.
      expect(off?.cacheRetention).toBeUndefined();

      const on = await optionsOf({
        agent: { ...defaultConfig().agent, stream: { cacheRetention: "long" } },
      });
      expect(on?.cacheRetention).toBe("long");
    });
  });
});

describe("vmodel.test.ts", () => {
  async function fixture(): Promise<{ config: Config; paths: Paths }> {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-vmodel-"));
    const paths = buildPaths(home);
    await ensureLayout(paths);
    await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
    await mkdir(join(paths.promptsDir, "role"), { recursive: true });
    return { config: aliasConfig(), paths };
  }

  /**
   * The alias these tests resolve, declared here rather than taken from
   * `defaultConfig()`.
   *
   * The code ships no alias and no default root model, so a test that read either
   * from the defaults would fail once the default is gone, or would quietly keep a
   * default alive that was removed on purpose.
   */
  const ALIAS = "test-alias";

  function aliasConfig(): Config {
    const base = defaultConfig();
    return {
      ...base,
      vmodels: {
        [ALIAS]: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium", prompt: ALIAS },
      },
      agent: { ...base.agent, vmodel: ALIAS },
    };
  }

  function resolverFor(config: Config, paths: Paths): VmodelResolver {
    return new VmodelResolver({ getConfig: () => config, paths });
  }

  describe("vmodel resolution", () => {
    it("ships no alias and no root model in the defaults", () => {
      const base = defaultConfig();
      expect(base.vmodels).toEqual({});
      expect(base.agent.vmodel).toBe("");
    });

    it("resolves an alias to its model, thinking level and prompt text", async () => {
      const { config, paths } = await fixture();
      await writeFile(join(paths.promptsDir, "vmodel", "test-alias.md"), "be terse\n", "utf8");
      const resolved = await resolverFor(config, paths).resolve(ALIAS);
      expect(resolved.model).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
      expect(resolved.thinkingLevel).toBe("medium");
      expect(resolved.prompt.trim()).toBe("be terse");
    });

    it("treats an empty prompt file as no addition rather than an error", async () => {
      const { config, paths } = await fixture();
      await writeFile(join(paths.promptsDir, "vmodel", "test-alias.md"), "", "utf8");
      const resolved = await resolverFor(config, paths).resolve(ALIAS);
      expect(resolved.prompt).toBe("");
    });

    it("names the known aliases when the key is unknown", async () => {
      const { config, paths } = await fixture();
      expect(() => resolverFor(config, paths).entry("nope")).toThrow(VmodelError);
      expect(() => resolverFor(config, paths).entry("nope")).toThrow(/test-alias/);
    });

    it("refuses a key that is not a usable file name", async () => {
      const { config, paths } = await fixture();
      expect(() => resolverFor(config, paths).entry("../etc/passwd")).toThrow(/not usable/);
    });

    it("treats a missing prompt file as an error, never as an empty prompt", async () => {
      const { config, paths } = await fixture();
      const broken: Config = {
        ...config,
        vmodels: { ...config.vmodels, [ALIAS]: { ...config.vmodels[ALIAS]!, prompt: "absent" } },
      };
      await expect(resolverFor(broken, paths).resolve(ALIAS)).rejects.toThrow(/no vmodel file/);
    });

    it("re-reads a file when it changes and keeps the cached text when it does not", async () => {
      const { config, paths } = await fixture();
      const file = join(paths.promptsDir, "vmodel", "test-alias.md");
      await writeFile(file, "first\n", "utf8");
      const resolver = resolverFor(config, paths);
      expect((await resolver.resolve(ALIAS)).prompt.trim()).toBe("first");

      // The old timestamp keeps the change visible even on a filesystem whose
      // clock has a coarse resolution, which is what the cache is keyed on.
      await utimes(file, new Date(0), new Date(0));
      await writeFile(file, "second\n", "utf8");
      await utimes(file, new Date(1_000), new Date(1_000));
      expect((await resolver.resolve(ALIAS)).prompt.trim()).toBe("second");

      expect((await resolver.resolve(ALIAS)).prompt.trim()).toBe("second");
    });

    it("concatenates role texts and lists the roles that exist", async () => {
      const { config, paths } = await fixture();
      await writeFile(join(paths.promptsDir, "role", "terse.md"), "keep it short\n", "utf8");
      await writeFile(join(paths.promptsDir, "role", "korean.md"), "answer in Korean\n", "utf8");
      const resolver = resolverFor(config, paths);
      const text = await resolver.rolesText(["terse", "korean"]);
      expect(text).toContain("keep it short");
      expect(text).toContain("answer in Korean");
      expect(await resolver.roleNames()).toEqual(["korean", "terse"]);
    });

    it("refuses a role with no prompt file and names the ones that exist", async () => {
      const { config, paths } = await fixture();
      await writeFile(join(paths.promptsDir, "role", "terse.md"), "keep it short\n", "utf8");
      const resolver = resolverFor(config, paths);
      await expect(resolver.rolesText(["missing"])).rejects.toThrow(/no role file/);
      expect(await resolver.roleNames()).toEqual(["terse"]);
    });

    it("names both search roots when a prompt file is missing everywhere", async () => {
      // The control structure is searched first and the install's shipped prompts
      // second, so the error has to say both places to look.
      const { config, paths } = await fixture();
      const broken: Config = {
        ...config,
        vmodels: { ...config.vmodels, [ALIAS]: { ...config.vmodels[ALIAS]!, prompt: "absent" } },
      };
      const message = await resolverFor(broken, paths)
        .resolve(ALIAS)
        .then(() => "")
        .catch((error: unknown) => String(error));
      expect(message).toContain(paths.promptsDir);
      expect(message).toContain("prompts");
      expect(message).toContain("absent.md");
    });
  });
});

describe("vmodel-required.test.ts", () => {
  /**
   * No model is chosen for the caller.
   *
   * There is no default alias, no default root model, and no rule that reads a key
   * off a role name. So the three places that name a model each say so out loud: the
   * config names the root's, a spawn names its own, and a schedule names one on the
   * record. Each of them refuses the call that names none, and none of them
   * substitutes `agent.vmodel` for a run that stayed silent.
   */

  const ctx = BACKGROUND_CONTEXT;

  type ToolLike = {
    name: string;
    execute: (
      args: never,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<{ content: readonly { type: string; text?: string }[]; isError?: boolean }>;
  };

  const routine: JobRoutineSpec = {
    cron: "* * * * *",
    timezone: "UTC",
    catchUp: "skip",
    overlap: "skip",
    prompt: "check the log",
    enabled: true,
  };

  function extensionContext(h: TestHarness): ExtensionContext {
    const runtime = h.runtime;
    return {
      getConfig: () => runtime.getConfig(),
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      harness: runtime.harness,
      jobs: runtime.jobs,
      archive: runtime.archive,
      reports: runtime.reports,
    } as unknown as ExtensionContext;
  }

  function jobsToolset(h: TestHarness): Map<string, ToolLike> {
    const extension = createJobsExtension(extensionContext(h));
    return new Map((extension.tools ?? []).map((found) => [found.name, found as unknown as ToolLike]));
  }

  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: "01VMODELREQUIRED0000000000",
      commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: Context) =>
        h.runtime.harness.commit(change, context),
    } as unknown as ToolExecutionApi;
  }

  function tool(tools: Map<string, ToolLike>, name: string): ToolLike {
    const found = tools.get(name);
    if (found === undefined) throw new Error(`no tool named ${name}`);
    return found;
  }

  function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  /** The runs this tick started, as the notice the scheduler emits for each. */
  function dispatchNotices(h: TestHarness): { code?: string; jobId?: string }[] {
    const found: { code?: string; jobId?: string }[] = [];
    h.events.subscribe((event) => {
      if (event.type !== "notice") return;
      const data = event.data as { code?: string; jobId?: string };
      if (data.code === "scheduler_dispatch") found.push(data);
    });
    return found;
  }

  describe("a schedule names its model", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    async function boot(): Promise<TestHarness> {
      harness = await createTestHarness({
        responses: Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])),
      });
      return harness;
    }

    it("refuses a routine with no vmodel, and creates nothing", async () => {
      const h = await boot();
      const tools = jobsToolset(h);
      const result = await tool(tools, "jobs_create").execute({ title: "nightly", routine } as never, execApi(h), ctx);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("schedule rejected");
      expect(textOf(result)).toContain("routine.vmodel is required");
      // The keys it could have named are part of the refusal, because the fix is a
      // word in the call.
      expect(textOf(result)).toContain("faux");
      expect(await h.runtime.jobs.list(ctx)).toHaveLength(0);
    });

    it("refuses a routine whose vmodel is not a key, and lists the keys", async () => {
      const h = await boot();
      const tools = jobsToolset(h);
      const result = await tool(tools, "jobs_create").execute(
        { title: "nightly", routine: { ...routine, vmodel: "worker" } } as never,
        execApi(h),
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('routine.vmodel "worker" is not a key of config.vmodels');
      expect(textOf(result)).toContain("faux");
      expect(await h.runtime.jobs.list(ctx)).toHaveLength(0);
    });

    it("refuses a one-off with no vmodel, and a key it does not know", async () => {
      const h = await boot();
      const tools = jobsToolset(h);
      const api = execApi(h);
      const at = Date.now() + 60_000;

      const silent = await tool(tools, "jobs_create").execute({ title: "one run", once: { at, prompt: "run" } } as never, api, ctx);
      expect(silent.isError).toBe(true);
      expect(textOf(silent)).toContain("once.vmodel is required");

      const unknown = await tool(tools, "jobs_create").execute(
        { title: "one run", once: { at, prompt: "run", vmodel: "worker" } } as never,
        api,
        ctx,
      );
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain('once.vmodel "worker" is not a key of config.vmodels');
      expect(await h.runtime.jobs.list(ctx)).toHaveLength(0);

      // The same call with a declared key goes through, so the check is the key and
      // not the schedule.
      const named = await tool(tools, "jobs_create").execute(
        { title: "one run", once: { at, prompt: "run", vmodel: "faux" } } as never,
        api,
        ctx,
      );
      expect(named.isError).toBeUndefined();
      expect(textOf(named)).toContain("created");
    });

    it("refuses an update that writes a routine with no vmodel, and leaves the record alone", async () => {
      const h = await boot();
      const tools = jobsToolset(h);
      const api = execApi(h);
      const job = await h.runtime.jobs.create(ctx, { title: "nightly" });

      const result = await tool(tools, "jobs_update").execute({ id: job.id, routine } as never, api, ctx);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("routine.vmodel is required");
      expect((await h.runtime.jobs.get(ctx, job.id))?.routine).toBeUndefined();
    });

    it("records a failure and starts no conversation when a stored routine names no vmodel", async () => {
      const h = await boot();
      const context = extensionContext(h);
      const job = await h.runtime.jobs.create(ctx, { title: "nightly" });
      // A record written before the rule exists still loads: the stored spec keeps
      // `vmodel` optional, and the run is where the missing model shows up.
      await writeRoutine(context, job.id, routine);
      const dispatched = dispatchNotices(h);

      await h.runtime.scheduler.tick(Date.UTC(2026, 5, 15, 12, 1, 30));

      const stored = await h.runtime.jobs.get(ctx, job.id);
      expect(dispatched).toHaveLength(0);
      expect(stored?.conversationId).toBeUndefined();
      expect(stored?.stats.runs).toBe(1);
      expect(stored?.stats.failures).toBe(1);
      expect(stored?.lastRun?.status).toBe("failure");
    });
  });

  describe("the boot names the root model or refuses to start", () => {
    function withRoot(vmodel: string): Config {
      const base = defaultConfig();
      return {
        ...base,
        vmodels: { worker: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium", prompt: "worker" } },
        agent: { ...base.agent, vmodel },
      };
    }

    it("refuses the defaults, which name no key at all", () => {
      const message = rootVmodelProblem(defaultConfig());
      expect(message).toBeDefined();
      expect(message).toContain("agent.vmodel");
      expect(message).toContain("(none)");
    });

    it("refuses a key the file does not declare, and names the keys it does", () => {
      const message = rootVmodelProblem(withRoot("nope"));
      expect(message).toBeDefined();
      expect(message).toContain('"nope"');
      expect(message).toContain("worker");
    });

    it("accepts a key the file declares", () => {
      expect(rootVmodelProblem(withRoot("worker"))).toBeUndefined();
    });
  });
});

describe("paths.test.ts", () => {
  describe("pi-sec home", () => {
    it("defaults to ~/.pi/sec even when XDG_DATA_HOME is set", async () => {
      // A second answer to "where is the control structure" is how a default moves
      // without anyone deciding: the install script and the service file both name
      // `~/.pi/sec`, so nothing else may win over it.
      const home = await mkdtemp(join(tmpdir(), "pi-sec-home-"));
      const resolved = resolveHome({
        HOME: home,
        XDG_DATA_HOME: join(home, "xdg-data"),
      });
      expect(resolved).toBe(join(home, ".pi", "sec"));
    });

    it("lets PI_SEC_HOME override the default", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-home-"));
      const elsewhere = await mkdtemp(join(tmpdir(), "pi-sec-control-"));
      expect(resolveHome({ HOME: home, PI_SEC_HOME: elsewhere })).toBe(elsewhere);
      expect(buildPaths(resolveHome({ HOME: home, PI_SEC_HOME: elsewhere })).configFile).toBe(
        join(elsewhere, "config.json"),
      );
    });
  });

  describe("expandPath", () => {
    it("expands ~ and $HOME against the given home", () => {
      expect(expandPath("~/attachments", "/cwd", "/someone")).toBe("/someone/attachments");
      expect(expandPath("$HOME/share", "/cwd", "/someone")).toBe("/someone/share");
      expect(expandPath("/absolute/place", "/cwd", "/someone")).toBe("/absolute/place");
    });
  });
});

describe("remote-machines-config.test.ts", () => {
  /**
   * The config key and the ssh command line: the two things the rest of the feature
   * stands on.
   *
   * The config tests go through `loadConfig`, not through the schema alone, because
   * the two checks that matter most are not schema checks: a duplicate machine name
   * and an ssh socket path that would not fit are both cases of a valid string that
   * makes a configuration that cannot work. They are refused at load, which keeps the
   * rule this repository already has: an unusable configuration says so at load and
   * the previous one stays in force.
   *
   * The command-line tests read the arguments this code builds, so the table in the
   * documentation and the code cannot drift: every option of the table is present,
   * and `accept-new` — which would trust a key nobody checked — is present nowhere.
   */

  /** A home directory with the config given, loaded the way the daemon loads it. */
  async function loadWith(value: unknown): Promise<Config> {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-remote-config-"));
    homes.push(home);
    await writeFile(join(home, "config.json"), JSON.stringify(value), "utf8");
    const loaded = await loadConfig({ home, env: { PI_SEC_HOME: home } });
    return loaded.config;
  }

  /** The error `loadConfig` throws for a config, as its issue list. */
  async function issuesOf(value: unknown): Promise<readonly string[]> {
    try {
      await loadWith(value);
    } catch (error) {
      if (error instanceof ConfigError) return error.issues;
      throw error;
    }
    throw new Error("the config was accepted, and the case expects a refusal");
  }

  const homes: string[] = [];

  /** A home directory whose path is exactly `length` bytes, under the temporary directory. */
  async function homeOfLength(length: number): Promise<string> {
    const base = tmpdir().replace(/\/+$/, "");
    const home = `${base}/${"h".repeat(length - base.length - 1)}`;
    expect(home.length).toBe(length);
    await mkdir(home, { recursive: true });
    homes.push(home);
    return home;
  }

  /** The issues `loadConfig` reports for a config file sitting in one named home. */
  async function socketPathIssues(home: string): Promise<readonly string[]> {
    await mkdir(home, { recursive: true });
    homes.push(home);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ remoteMachines: { machines: [machine()] } }),
      "utf8",
    );
    try {
      await loadConfig({ home, env: { PI_SEC_HOME: home } });
    } catch (error) {
      if (error instanceof ConfigError) return error.issues;
      throw error;
    }
    return [];
  }

  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  /** One valid machine entry, as the tests below vary it. */
  function machine(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: "box-a", address: "192.0.2.10", users: ["alice"], ...over };
  }

  describe("the remoteMachines config key", () => {
    it("is off while the file names no such key", async () => {
      const config = await loadWith({});
      expect(config.remoteMachines).toBeUndefined();
      // The one reader every other part of the feature goes through answers undefined,
      // which is what "no machine, no timer, no ssh call" means.
      expect(readRemoteMachines(config)).toBeUndefined();
    });

    it("accepts a machine and fills the three defaults", async () => {
      const config = await loadWith({
        remoteMachines: { machines: [machine({ users: ["alice", "bob"] })] },
      });
      const settings = readRemoteMachines(config);
      expect(settings).toBeDefined();
      // The schema's own defaults: the key file, the interval, and the port.
      expect(settings?.identityFile).toBe("~/.ssh/id_ed25519");
      expect(settings?.heartbeatSeconds).toBe(60);
      expect(settings?.machines[0]?.port).toBe(22);
      expect(settings?.machines[0]?.users).toEqual(["alice", "bob"]);
      // The first user is the main user, and the order the file wrote is kept.
      expect(config.remoteMachines?.machines.map((entry) => entry.id)).toEqual(["box-a"]);
    });

    it("keeps the order of the machines, which is the order the panel draws", async () => {
      const config = await loadWith({
        remoteMachines: {
          heartbeatSeconds: 30,
          machines: [machine({ id: "box-b", address: "192.0.2.11" }), machine({ id: "box-a" })],
        },
      });
      expect(config.remoteMachines?.machines.map((entry) => entry.id)).toEqual(["box-b", "box-a"]);
      expect(config.remoteMachines?.heartbeatSeconds).toBe(30);
    });

    it("refuses two machines with the same name", async () => {
      const issues = await issuesOf({
        remoteMachines: {
          machines: [machine(), machine({ address: "192.0.2.11" })],
        },
      });
      // A name is the key of the stored level and of the pinned key, so two machines
      // that share one would share both: the slider of one would set the level of
      // the other, and one pinned key would be checked for both.
      expect(issues.join("\n")).toContain('names the machine "box-a" twice');
      expect(issues.join("\n")).toContain("two machines cannot share one");
    });

    it("refuses an address or a user name that starts with a hyphen", async () => {
      const address = await issuesOf({ remoteMachines: { machines: [machine({ address: "-oProxyCommand=x" })] } });
      expect(address.length).toBeGreaterThan(0);
      const user = await issuesOf({ remoteMachines: { machines: [machine({ users: ["-oProxyCommand=x"] })] } });
      expect(user.length).toBeGreaterThan(0);
    });

    it("refuses a name that the ssh options could not carry", async () => {
      // A machine name is a `HostKeyAlias` and half of a socket name, so it is kept
      // to letters, digits and `-`.
      const issues = await issuesOf({ remoteMachines: { machines: [machine({ id: "Box A" })] } });
      expect(issues.length).toBeGreaterThan(0);
    });

    it("refuses an unknown key inside an entry and inside the feature key", async () => {
      await expect(
        issuesOf({ remoteMachines: { machines: [machine({ level: "on" })] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
      await expect(
        issuesOf({ remoteMachines: { machines: [machine()], interval: 5 } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
    });

    it("refuses an entry with no user, and an interval outside the two bounds", async () => {
      await expect(
        issuesOf({ remoteMachines: { machines: [machine({ users: [] })] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
      await expect(
        issuesOf({ remoteMachines: { heartbeatSeconds: 14, machines: [machine()] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
      await expect(
        issuesOf({ remoteMachines: { heartbeatSeconds: 3601, machines: [machine()] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
    });

    it("reads the outage threshold, and refuses one outside its two bounds", async () => {
      // The default is one hour: a machine that stops
      // answering is asked about once, and not sooner.
      const absent = await loadWith({ remoteMachines: { machines: [machine()] } });
      expect(readRemoteMachines(absent)?.outageSeconds).toBe(3600);
      // A value in the range is read as it stands, and 120 is the one the
      // end-to-end check uses.
      const named = await loadWith({ remoteMachines: { outageSeconds: 120, machines: [machine()] } });
      expect(readRemoteMachines(named)?.outageSeconds).toBe(120);
      // Below a minute the next heartbeat round answers anyway, and above a day the
      // notice comes after the user would have noticed the machine was gone.
      await expect(
        issuesOf({ remoteMachines: { outageSeconds: 59, machines: [machine()] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
      await expect(
        issuesOf({ remoteMachines: { outageSeconds: 86_401, machines: [machine()] } }),
      ).resolves.toSatisfy((issues: readonly string[]) => issues.length > 0);
    });

    it("accepts a home whose ssh socket path is exactly the limit, and refuses one byte more", async () => {
      // The socket path is `<home>` plus `/run/ssh/` (9 bytes) plus the 16-byte socket
      // name, so it is 25 bytes longer than the home. The limit is 90 bytes: a unix
      // socket path holds 107, and ssh first binds a temporary name 17 bytes longer.
      const accepted = await homeOfLength(65);
      await expect(socketPathIssues(accepted)).resolves.toEqual([]);
      expect(controlPathFor(buildPaths(accepted), "box-a", "alice").length).toBe(90);

      const refusedHome = await homeOfLength(66);
      const refusedIssues = await socketPathIssues(refusedHome);
      expect(refusedIssues.join("\n")).toContain("it may be at most 90");
      expect(controlPathFor(buildPaths(refusedHome), "box-a", "alice").length).toBe(91);
    });

    it("refuses a pi-sec home so deep that no ssh socket fits in it", async () => {
      // The socket is 25 bytes longer than the home and the limit is 90, so a home
      // past this length makes every connection fail with a message about a path
      // nobody would look at. The refusal happens at load, which is the only place
      // that knows the home and the machines together.
      const home = `/tmp/${"n".repeat(110)}`;
      expect(controlPathFor(buildPaths(home), "box-a", "alice").length).toBeGreaterThan(90);
      // The same config in a home of ordinary depth is accepted, so the refusal
      // below is about the path and not about the config.
      await expect(loadWith({ remoteMachines: { machines: [machine()] } })).resolves.toBeDefined();
      const refused = await socketPathIssues(home);
      expect(refused.join("\n")).toContain("ssh");
      // A name that repeats is named by the sentence, so the operator knows which.
      const duplicate = await issuesOf({
        remoteMachines: { machines: [machine(), machine({ address: "192.0.2.11" })] },
      });
      expect(duplicate.join("\n")).toContain('names the machine "box-a" twice');
    });
  });

  /** One target, as the manager builds it for a machine and a user. */
  function target(over: Partial<SshTarget> = {}): SshTarget {
    return {
      machineId: "box-a",
      address: "192.0.2.10",
      port: 22,
      user: "alice",
      identityFile: "/home/tester/.ssh/id_ed25519",
      knownHostsFile: "/home/tester/.pi/sec/state/remote-machines/known_hosts",
      controlPath: "/home/tester/.pi/sec/run/ssh/0123456789abcdef",
      ...over,
    };
  }

  describe("the ssh command line", () => {
    /** The options as `-o name=value` pairs, in the order they were written. */
    function pairs(args: readonly string[]): Map<string, string> {
      const out = new Map<string, string>();
      for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== "-o") continue;
        const pair = String(args[index + 1]);
        const at = pair.indexOf("=");
        out.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return out;
    }

    it("carries every option of the table", () => {
      const args = sshArguments(target(), { kind: "exec", command: ["cat", "/etc/machine-id"] });
      const options = pairs(args);
      expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
      expect(options.get("BatchMode")).toBe("yes");
      expect(options.get("IdentitiesOnly")).toBe("yes");
      expect(options.get("IdentityFile")).toBe("/home/tester/.ssh/id_ed25519");
      expect(options.get("UserKnownHostsFile")).toBe("/home/tester/.pi/sec/state/remote-machines/known_hosts");
      expect(options.get("GlobalKnownHostsFile")).toBe("/dev/null");
      expect(options.get("StrictHostKeyChecking")).toBe("yes");
      expect(options.get("UpdateHostKeys")).toBe("no");
      expect(options.get("HostKeyAlias")).toBe("box-a");
      expect(options.get("ControlMaster")).toBe("auto");
      expect(options.get("ControlPath")).toBe("/home/tester/.pi/sec/run/ssh/0123456789abcdef");
      expect(options.get("ControlPersist")).toBe("300");
      expect(options.get("ConnectTimeout")).toBe("10");
      expect(options.get("ServerAliveInterval")).toBe("15");
      expect(options.get("ServerAliveCountMax")).toBe("3");
      // The destination and the command come last, in that order.
      expect(args.slice(-3)).toEqual(["alice@192.0.2.10", "cat", "/etc/machine-id"]);
    });

    it("never asks ssh to trust a key it has not seen", () => {
      // Every form of the option that is ruled out, over each of the three calls
      // this code can make. `accept-new` would add a key nobody checked to the file.
      const calls = [
        sshArguments(target(), { kind: "exec", command: ["cat", "/etc/machine-id"] }),
        sshArguments(target(), { kind: "exit" }),
        sshOptions(target()),
      ];
      for (const args of calls) {
        expect(args.join(" ")).not.toContain("accept-new");
      }
      // The check above finds something when there is something to find: the one
      // value that would let a new key in is caught by the same comparison.
      expect(["StrictHostKeyChecking=accept-new"]).toEqual(
        expect.arrayContaining(["StrictHostKeyChecking=accept-new"]),
      );
      expect("StrictHostKeyChecking=accept-new".includes("accept-new")).toBe(true);
    });

    it("sends -O exit to the local socket and to nothing else", () => {
      const args = sshArguments(target(), { kind: "exit" });
      expect(args.slice(-3)).toEqual(["-O", "exit", "alice@192.0.2.10"]);
      // No command follows the destination, and the port is not part of this call:
      // the socket path is given whole, so ssh has nothing to compute from it.
      expect(args).not.toContain("-p");
    });

    it("adds the port only when it is not the default", () => {
      const custom = sshArguments(target({ port: 2222 }), { kind: "exec", command: ["true"] });
      expect(custom).toContain("-p");
      expect(custom[custom.indexOf("-p") + 1]).toBe("2222");
      const standard = sshArguments(target({ port: 22 }), { kind: "exec", command: ["true"] });
      expect(standard).not.toContain("-p");
    });
  });

  describe("reading a heartbeat", () => {
    const result = (over: Partial<SshResult> = {}): SshResult => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...over,
    });

    it("reads the machine-id a successful call printed", () => {
      expect(readHeartbeat(result({ stdout: "0123456789abcdef0123456789abcdef\n" }))).toEqual({
        kind: "ok",
        machineId: "0123456789abcdef0123456789abcdef",
      });
    });

    it("tells a changed host key from an unreachable machine", () => {
      // Both exit 255, so the sentence is the only thing that separates them. The
      // sentence is ssh's own, and this expectation is what pins it.
      const mismatch = readHeartbeat(
        result({
          code: 255,
          stderr: `@@@@@@@\nHost key for box-a has changed and you have requested strict checking.\n${HOST_KEY_MISMATCH_LINE}`,
        }),
      );
      expect(mismatch.kind).toBe("host-key-mismatch");
      expect(HOST_KEY_MISMATCH_LINE).toBe("Host key verification failed.");

      const unreachable = readHeartbeat(
        result({ code: 255, stderr: "ssh: connect to host 192.0.2.10 port 22: No route to host" }),
      );
      expect(unreachable).toEqual({ kind: "failed", detail: "ssh: connect to host 192.0.2.10 port 22: No route to host" });
    });

    it("reports a deadline and a silent machine as failures with a reason", () => {
      expect(readHeartbeat(result({ timedOut: true, code: null }))).toEqual({
        kind: "failed",
        detail: "the heartbeat ran past its deadline",
      });
      expect(readHeartbeat(result({ stdout: "\n" }))).toEqual({
        kind: "failed",
        detail: "the machine printed no machine-id",
      });
    });
  });

  describe("the socket name and the pinned key", () => {
    it("names a socket by the machine and the user, and not by the address", () => {
      const paths = buildPaths("/home/tester/.pi/sec");
      const first = controlPathFor(paths, "box-a", "alice");
      // Sixteen hex characters after the directory, which is what keeps the path
      // inside the 90-byte limit this feature enforces for a plausible home.
      expect(first).toMatch(/\/[0-9a-f]{16}$/);
      expect(first.length).toBe(paths.sshSocketDir.length + 17);
      expect(first.length).toBeLessThan(90);
      expect(first).toBe(controlPathFor(paths, "box-a", "alice"));
      expect(controlPathFor(paths, "box-a", "bob")).not.toBe(first);
      expect(controlPathFor(paths, "box-b", "alice")).not.toBe(first);
    });

    it("finds a pinned key by the machine's name, and not when the file has none", async () => {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-known-hosts-"));
      homes.push(home);
      const file = join(home, "known_hosts");
      await writeFile(file, "# a comment\nbox-a ssh-ed25519 AAAAfake\nbox-c ssh-ed25519 AAAAfake\n", "utf8");
      expect(await pinnedHostKey(file, "box-a", 22)).toBe(true);
      expect(await pinnedHostKey(file, "box-b", 22)).toBe(false);
      // A non-default port is part of the name ssh writes, and `HostKeyAlias` keeps
      // the machine's own name in front of it.
      expect(hostKeyName("box-a", 22)).toBe("box-a");
      expect(hostKeyName("box-a", 2222)).toBe("[box-a]:2222");
      await writeFile(file, "[box-a]:2222 ssh-ed25519 AAAAfake\n", "utf8");
      expect(await pinnedHostKey(file, "box-a", 2222)).toBe(true);
      // A missing file means nothing is pinned, which is not an error.
      expect(await pinnedHostKey(join(home, "absent"), "box-a", 22)).toBe(false);
      expect(await readFile(file, "utf8")).toContain("box-a");
    });
  });
});

describe("model-catalog-file.test.ts", () => {
  /**
   * `model-catalog.json`: which providers the file keeps, in which order, and what
   * one entry of each looks like.
   *
   * Every reader here is a fake. The daemon's own boot is proved in
   * `model-catalog-boot.test.ts`, where the real catalog is read.
   */

  const roots = new Set<string>();

  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots.clear();
  });

  async function tempDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-model-catalog-"));
    roots.add(root);
    return root;
  }

  interface FakeProvider {
    readonly id: string;
    readonly configured?: boolean;
    readonly models?: readonly ModelCatalogModel[];
    readonly throwOnAuth?: boolean;
    readonly throwOnModels?: boolean;
  }

  /** A catalog reader of the shape the runtime has, answering from a list. */
  function reader(providers: readonly FakeProvider[]): ModelCatalogSourceReader {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    return {
      getProviders: () => providers.map((provider) => ({ id: provider.id })),
      getModels: (providerId: string) => {
        const provider = byId.get(providerId);
        if (provider?.throwOnModels === true) throw new Error(`${providerId}: the list is gone`);
        return provider?.models ?? [];
      },
      getProviderAuthStatus: (providerId: string) => {
        const provider = byId.get(providerId);
        if (provider?.throwOnAuth === true) throw new Error(`${providerId}: the credential store is unreadable`);
        return { configured: provider?.configured === true };
      },
    };
  }

  /** The registry face, answering from two plain maps. */
  function owners(entries: Readonly<Record<string, string>>, virtuals: readonly string[] = []): ModelCatalogProviderOwners {
    return {
      ownerOf: (providerId: string) => entries[providerId],
      isVirtual: (providerId: string) => virtuals.includes(providerId),
    };
  }

  describe("collectModelCatalog", () => {
    it("keeps the configured providers only, in id order, with the layer each came from", () => {
      const document = collectModelCatalog({
        models: reader([
          { id: "zulu", configured: true, models: [{ id: "zulu-large" }] },
          { id: "beta", configured: false, models: [{ id: "beta-1" }] },
          { id: "alpha", configured: true, models: [{ id: "alpha-1" }] },
          { id: "from-json", configured: true, models: [{ id: "json-1" }] },
          { id: "synthetic", configured: true, models: [{ id: "syn-1" }] },
          { id: "acme", configured: true, models: [{ id: "acme-fake-chat" }] },
          { id: "routed", configured: true, models: [{ id: "routed-1" }] },
        ]),
        providers: owners({ acme: "acme-extension", routed: "virtual-providers" }, ["routed"]),
        modelsJsonProviders: new Set(["from-json"]),
        now: Date.UTC(2026, 10, 2, 20, 31, 12),
        timezone: "Asia/Tokyo",
      });

      expect(document.note).toBe(MODEL_CATALOG_NOTE);
      expect(document.generatedAt).toBe("2026-11-03T05:31:12+09:00");
      expect(document.providers.map((provider) => provider.id)).toEqual([
        "acme",
        "alpha",
        "from-json",
        "routed",
        "synthetic",
        "zulu",
      ]);
      const sources = Object.fromEntries(document.providers.map((provider) => [provider.id, provider.source]));
      expect(sources).toEqual({
        acme: "extension:acme-extension",
        alpha: "builtin",
        "from-json": "models.json",
        routed: "extension:virtual-providers",
        synthetic: "service",
        zulu: "builtin",
      });
      // The marker exists only where the registry says so.
      expect(document.providers.find((provider) => provider.id === "routed")?.virtual).toBe(true);
      expect(document.providers.find((provider) => provider.id === "acme")?.virtual).toBeUndefined();
    });

    it("sorts models by id, keeps a name only when it differs, and a length only when it is a number", () => {
      const document = collectModelCatalog({
        models: reader([
          {
            id: "deepseek",
            configured: true,
            models: [
              { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxTokens: 384_000 },
              { id: "deepseek-flash", name: "deepseek-flash" },
              {
                id: "deepseek-mini",
                name: "",
                contextWindow: Number.NaN,
                maxTokens: Number.POSITIVE_INFINITY,
              },
            ],
          },
        ]),
        now: Date.UTC(2026, 10, 2, 20, 31, 12),
        timezone: "Asia/Tokyo",
      });

      expect(document.providers[0]?.models).toEqual([
        { id: "deepseek-flash" },
        { id: "deepseek-mini" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxTokens: 384_000 },
      ]);
    });

    it("gives a provider whose list throws an error and no models, and keeps the rest", () => {
      const document = collectModelCatalog({
        models: reader([
          { id: "broken", configured: true, throwOnModels: true },
          { id: "whole", configured: true, models: [{ id: "whole-1" }] },
          { id: "unreadable", throwOnAuth: true },
        ]),
        now: Date.UTC(2026, 10, 2, 20, 31, 12),
        timezone: "Asia/Tokyo",
      });

      expect(document.providers.map((provider) => provider.id)).toEqual(["broken", "unreadable", "whole"]);
      const broken = document.providers[0]!;
      expect(broken.error).toContain("the list is gone");
      expect(broken.models).toBeUndefined();
      expect(broken.configured).toBe(true);
      const unreadable = document.providers[1]!;
      expect(unreadable.error).toContain("the credential store is unreadable");
      expect(unreadable.configured).toBe(false);
      expect(unreadable.models).toBeUndefined();
      expect(document.providers[2]?.models).toEqual([{ id: "whole-1" }]);
    });
  });

  describe("readModelsJsonProviderIds", () => {
    it("reads the providers keys, and answers an empty set for a missing or unreadable file", async () => {
      const dir = await tempDir();
      const file = join(dir, "models.json");
      await writeFile(file, JSON.stringify({ providers: { acme: {}, zulu: {} } }), "utf8");
      expect([...(await readModelsJsonProviderIds(file))].sort()).toEqual(["acme", "zulu"]);

      expect((await readModelsJsonProviderIds(join(dir, "absent.json"))).size).toBe(0);
      await writeFile(file, "{ not json", "utf8");
      expect((await readModelsJsonProviderIds(file)).size).toBe(0);
    });
  });

  describe("writeModelCatalogFile", () => {
    it("writes the document 0600, leaves no temporary file behind, and ends with a newline", async () => {
      const dir = await tempDir();
      const file = join(dir, "model-catalog.json");
      const modelsJsonFile = join(dir, "models.json");
      await writeFile(modelsJsonFile, JSON.stringify({ providers: { alpha: {} } }), "utf8");

      await writeModelCatalogFile({
        models: reader([{ id: "alpha", configured: true, models: [{ id: "alpha-1" }] }]),
        modelsJsonFile,
        file,
        now: Date.UTC(2026, 10, 2, 20, 31, 12),
        timezone: "Asia/Tokyo",
      });

      const body = await readFile(file, "utf8");
      expect(body.endsWith("}\n")).toBe(true);
      const parsed = JSON.parse(body) as { note: string; generatedAt: string; providers: { id: string; source: string }[] };
      expect(parsed.note).toBe(MODEL_CATALOG_NOTE);
      expect(parsed.generatedAt).toBe("2026-11-03T05:31:12+09:00");
      expect(parsed.providers).toEqual([
        { id: "alpha", source: "models.json", configured: true, models: [{ id: "alpha-1" }] },
      ]);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  });
});

describe("model-credentials-external-write.test.ts", () => {
  // Fake values only. Each is long and unique so a search for it cannot miss.
  const FAKE_ACCESS = "sk-ant-fake-access-token-aaaaaaaaaaaaaaaa";
  const FAKE_REFRESH = "sk-ant-fake-refresh-token-rrrrrrrrrrrrrrrr";
  const NEW_ACCESS = "sk-ant-fake-access-token-NEW-bbbbbbbbbbbbbb";
  const NEW_REFRESH = "sk-ant-fake-refresh-token-NEW-ssssssssssssss";
  const FAKES = [FAKE_ACCESS, FAKE_REFRESH, NEW_ACCESS, NEW_REFRESH];

  function expectNoFake(text: string) {
    for (const fake of FAKES) expect(text).not.toContain(fake);
  }

  describe("ModelCredentialStore sees a credential another process wrote", () => {
    async function setup() {
      const home = await mkdtemp(join(tmpdir(), "pi-sec-model-credentials-"));
      const authPath = join(home, "auth.json");
      const secretsDir = join(home, "secrets");
      await mkdir(secretsDir, { recursive: true, mode: 0o700 });
      await writeFile(join(secretsDir, "model-auth.anthropic.access"), FAKE_ACCESS, { mode: 0o600 });
      await writeFile(join(secretsDir, "model-auth.anthropic.refresh"), FAKE_REFRESH, { mode: 0o600 });
      await writeFile(
        authPath,
        JSON.stringify(
          {
            anthropic: {
              type: "oauth",
              refresh: { file: "model-auth.anthropic.refresh" },
              access: { file: "model-auth.anthropic.access" },
              expires: 4_102_444_800_000,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return { home, authPath, secretsDir };
    }

    it("reloads once for an outside write, not again for the same values, and not for its own write", async () => {
      const env = await setup();
      // The daemon's store: it holds the secret list, so it has onChange.
      let reloads = 0;
      const daemon = new ModelCredentialStore({
        authPath: env.authPath,
        secretsDir: env.secretsDir,
        onChange: () => {
          reloads += 1;
        },
      });
      // The other process's store: no registry runs in that process.
      const login = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });

      // The first read only sets the baseline.
      expect(await daemon.read("anthropic")).toMatchObject({ access: FAKE_ACCESS, refresh: FAKE_REFRESH });
      expect(reloads).toBe(0);

      // A second read of the same values says nothing.
      await daemon.read("anthropic");
      expect(reloads).toBe(0);

      // Another process replaces the values.
      await login.modify("anthropic", async () => ({
        type: "oauth",
        refresh: NEW_REFRESH,
        access: NEW_ACCESS,
        expires: 4_102_444_900_000,
      }));
      expect(reloads).toBe(0);

      // The daemon's next read returns the new values, after one reload.
      expect(await daemon.read("anthropic")).toMatchObject({ access: NEW_ACCESS, refresh: NEW_REFRESH });
      expect(reloads).toBe(1);

      // The change is reported once, not on every later read.
      await daemon.read("anthropic");
      await daemon.read("anthropic");
      expect(reloads).toBe(1);

      // Its own write reloads once (the write path), and the read after it does not.
      await daemon.modify("anthropic", async () => ({
        type: "oauth",
        refresh: FAKE_REFRESH,
        access: FAKE_ACCESS,
        expires: 4_102_444_950_000,
      }));
      expect(reloads).toBe(2);
      expect(await daemon.read("anthropic")).toMatchObject({ access: FAKE_ACCESS, refresh: FAKE_REFRESH });
      expect(reloads).toBe(2);

      // No value reached a log line: the store has no log here, and nothing was
      // printed. The store's own log is checked by the other test file.
      expectNoFake(await readFile(env.authPath, "utf8"));
    });

    it("reloads when a provider this store deleted comes back with other values", async () => {
      const env = await setup();
      let reloads = 0;
      const daemon = new ModelCredentialStore({
        authPath: env.authPath,
        secretsDir: env.secretsDir,
        onChange: () => {
          reloads += 1;
        },
      });
      const login = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });

      await daemon.read("anthropic");
      await daemon.delete("anthropic");
      expect(reloads).toBe(1);

      // Another process signs in again, so the values under this id are new.
      await login.modify("anthropic", async () => ({
        type: "oauth",
        refresh: NEW_REFRESH,
        access: NEW_ACCESS,
        expires: 4_102_444_900_000,
      }));
      expect(await daemon.read("anthropic")).toMatchObject({ access: NEW_ACCESS });
      expect(reloads).toBe(2);
    });

    it("keeps the read working when the reload fails, and reports it without a value", async () => {    const env = await setup();
      const lines: string[] = [];
      let reloads = 0;
      const daemon = new ModelCredentialStore({
        authPath: env.authPath,
        secretsDir: env.secretsDir,
        log: (level, message) => lines.push(`${level}: ${message}`),
        onChange: () => {
          reloads += 1;
          throw new Error("registry unreadable");
        },
      });
      const login = new ModelCredentialStore({ authPath: env.authPath, secretsDir: env.secretsDir });

      await daemon.read("anthropic");
      await login.modify("anthropic", async () => ({ type: "oauth", refresh: NEW_REFRESH, access: NEW_ACCESS, expires: 1 }));

      // The value still comes back; the failure is logged the way the write path logs it.
      expect(await daemon.read("anthropic")).toMatchObject({ access: NEW_ACCESS });
      expect(reloads).toBe(1);
      expect(lines.some((line) => line.startsWith("warn:") && line.includes("reload"))).toBe(true);
      expectNoFake(lines.join("\n"));
    });
  });
});
