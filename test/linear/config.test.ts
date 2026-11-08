import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { BUNDLED_EXTENSIONS } from "../../src/extensions/index.ts";

let home: string | undefined;
afterEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = undefined;
});

/** Load a config file whose agent.extensions.enabled and linear key are as given. */
async function load(options: { enabled: boolean; linear?: unknown }) {
  home = await mkdtemp(join(tmpdir(), "pi-sec-linear-config-"));
  await mkdir(home, { recursive: true });
  const base = defaultConfig();
  const file: Record<string, unknown> = {
    agent: { extensions: { enabled: [...base.agent.extensions.enabled, ...(options.enabled ? ["linear"] : [])] } },
  };
  if (options.linear !== undefined) file.linear = options.linear;
  await writeFile(join(home, "config.json"), JSON.stringify(file), "utf8");
  return loadConfig({ home });
}

async function problems(options: Parameters<typeof load>[0]): Promise<string[]> {
  try {
    await load(options);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe("the linear configuration key", () => {
  it("refuses a file that enables linear without the linear key", async () => {
    const found = await problems({ enabled: true });
    expect(found.join("\n")).toContain("/linear is required while agent.extensions.enabled names linear");
  });

  it("accepts the key with both values", async () => {
    const { config } = await load({ enabled: true, linear: { apiKeySecret: "linear.api-key", writes: false } });
    expect(config.linear).toEqual({ apiKeySecret: "linear.api-key", writes: false });
  });

  it("refuses a key without writes, without apiKeySecret, with an unknown field, or with a bad secret name", async () => {
    expect((await problems({ enabled: true, linear: { apiKeySecret: "linear.api-key" } })).join("\n")).toContain("writes");
    expect((await problems({ enabled: true, linear: { writes: true } })).join("\n")).toContain("apiKeySecret");
    expect((await problems({ enabled: true, linear: { apiKeySecret: "linear.api-key", writes: true, extra: 1 } })).length).toBeGreaterThan(0);
    expect((await problems({ enabled: true, linear: { apiKeySecret: "../key", writes: true } })).length).toBeGreaterThan(0);
  });

  it("accepts a linear key while the extension is off, and no key when it is off", async () => {
    expect(await problems({ enabled: false, linear: { apiKeySecret: "linear.api-key", writes: true } })).toEqual([]);
    expect(await problems({ enabled: false })).toEqual([]);
  });

  it("is absent from the default configuration and the default enabled list", () => {
    const base = defaultConfig() as Record<string, unknown>;
    expect("linear" in base).toBe(false);
    expect(defaultConfig().agent.extensions.enabled).not.toContain("linear");
  });

  it("sits in the catalog after github-pr and before the prompt sections, with no routes", () => {
    const names = BUNDLED_EXTENSIONS.map((extension) => extension.name);
    expect(names.indexOf("linear")).toBe(names.indexOf("github-pr") + 1);
    expect(names.indexOf("linear")).toBeLessThan(names.indexOf("conventions"));
    const entry = BUNDLED_EXTENSIONS.find((extension) => extension.name === "linear");
    expect(entry?.phase).toBe("app");
    expect(entry?.routes).toBeUndefined();
    expect(entry?.pages).toBeUndefined();
  });
});
