/**
 * `pi-sec doctor` covers every vmodel.
 *
 * The command runs as a child process against a throwaway home, the way an
 * operator runs it. What matters is the line per vmodel: one broken entry must
 * not hide the others, and a name the conventions need must be reported before
 * an agent spawn fails on it.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Sandbox {
  readonly paths: Paths;
  readonly env: NodeJS.ProcessEnv;
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-doctor-"));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  return { paths, env: { PI_SEC_HOME: paths.home, HOME: join(root, "home"), PATH: process.env.PATH, TERM: "dumb" } };
}

/** A model that the built-in catalog holds, so the check needs no credentials. */
const KNOWN = { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium" };

async function writeConfig(
  sb: Sandbox,
  vmodels: Record<string, unknown>,
  roles: readonly string[] = ["root-agent", "user-facing-agent"],
): Promise<void> {
  const config = { vmodels, agent: { vmodel: "root", roles } };
  await writeFile(sb.paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function writePrompt(sb: Sandbox, area: "vmodel" | "role", name: string): Promise<void> {
  const dir = join(sb.paths.promptsDir, area);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), `${name} text\n`, "utf8");
}

/** The four vmodels, the roles the conventions name, and the root's two files. */
async function writeTree(sb: Sandbox): Promise<void> {
  await writeConfig(sb, {
    orchestrator: { ...KNOWN, prompt: "claude" },
    planner: { ...KNOWN, prompt: "claude" },
    root: { ...KNOWN, prompt: "claude" },
    worker: { ...KNOWN, prompt: "deepseek-flash" },
  });
  await writePrompt(sb, "vmodel", "claude");
  await writePrompt(sb, "vmodel", "deepseek-flash");
  for (const role of ["root-agent", "user-facing-agent", "orchestrator", "planner", "worker"]) {
    await writePrompt(sb, "role", role);
  }
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runDoctor(sb: Sandbox): Run {
  const run = spawnSync(
    process.execPath,
    [join(REPO, "src", "cli.ts"), "doctor"],
    { cwd: REPO, env: sb.env, encoding: "utf8", timeout: 120_000 },
  );
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("pi-sec doctor", () => {
  it("writes one line per vmodel, in name order, with no warning when all is well", async () => {
    const sb = await sandbox();
    await writeTree(sb);
    const run = runDoctor(sb);
    expect(run.status, run.stderr).toBe(0);
    const vmodelLines = lines(run.stdout).filter((line) => line.startsWith("vmodel "));
    expect(vmodelLines).toEqual([
      "vmodel orchestrator: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
      "vmodel planner: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
      "vmodel root: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
      "vmodel worker: deepseek/deepseek-flash in the catalog, prompt deepseek-flash.md readable",
    ]);
    expect(run.stdout).toContain("prompt: 2 root role file(s) readable");
    expect(run.stdout).not.toContain("warning:");
  }, 60_000);

  it("reports a missing prompt file on its own line and keeps the other vmodels", async () => {
    const sb = await sandbox();
    await writeTree(sb);
    await unlink(join(sb.paths.promptsDir, "vmodel", "deepseek-flash.md"));

    const run = runDoctor(sb);
    expect(run.status, run.stderr).toBe(0);
    const vmodelLines = lines(run.stdout).filter((line) => line.startsWith("vmodel "));
    expect(vmodelLines.slice(0, 3)).toEqual([
      "vmodel orchestrator: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
      "vmodel planner: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
      "vmodel root: deepseek/deepseek-flash in the catalog, prompt claude.md readable",
    ]);
    expect(vmodelLines[3]).toMatch(/^vmodel worker: deepseek\/deepseek-flash in the catalog, prompt no vmodel file "deepseek-flash\.md" in /);
  }, 60_000);

  it("says so when a vmodel's model is not in the catalog", async () => {
    const sb = await sandbox();
    await writeTree(sb);
    await writeConfig(sb, {
      orchestrator: { ...KNOWN, prompt: "claude" },
      planner: { ...KNOWN, prompt: "claude" },
      root: { ...KNOWN, prompt: "claude" },
      worker: { provider: "deepseek", modelId: "no-such-model", thinkingLevel: "medium", prompt: "deepseek-flash" },
    });

    const run = runDoctor(sb);
    expect(run.status, run.stderr).toBe(0);
    expect(lines(run.stdout)).toContain(
      "vmodel worker: deepseek/no-such-model not in the catalog, prompt deepseek-flash.md readable",
    );
  }, 60_000);

  it("warns once when config.vmodels has no `worker` key", async () => {
    const sb = await sandbox();
    await writeConfig(sb, {
      orchestrator: { ...KNOWN, prompt: "claude" },
      planner: { ...KNOWN, prompt: "claude" },
      root: { ...KNOWN, prompt: "claude" },
    });
    await writePrompt(sb, "vmodel", "claude");
    for (const role of ["root-agent", "user-facing-agent", "orchestrator", "planner", "worker"]) {
      await writePrompt(sb, "role", role);
    }

    const run = runDoctor(sb);
    expect(run.status, run.stderr).toBe(0);
    const warnings = lines(run.stdout).filter((line) => line.startsWith("warning:"));
    expect(warnings).toEqual([
      'warning: the conventions spawn agents with vmodel "worker", and config.vmodels has no such key',
    ]);
  }, 60_000);

  it("warns when agent.roles has user-facing-agent but no root-agent", async () => {
    const sb = await sandbox();
    await writeTree(sb);
    // The list every install had before the role split: the shared file only.
    await writeConfig(
      sb,
      {
        orchestrator: { ...KNOWN, prompt: "claude" },
        planner: { ...KNOWN, prompt: "claude" },
        root: { ...KNOWN, prompt: "claude" },
        worker: { ...KNOWN, prompt: "deepseek-flash" },
      },
      ["user-facing-agent", "instance-root"],
    );
    await writePrompt(sb, "role", "instance-root");

    const run = runDoctor(sb);
    // A warning, not a failure: the other warnings of this command also leave
    // the exit code alone.
    expect(run.status, run.stderr).toBe(0);
    const warnings = lines(run.stdout).filter((line) => line.startsWith("warning:"));
    expect(warnings).toContain(
      'warning: agent.roles has "user-facing-agent" but no "root-agent", so the root lost its root-only rules: add "root-agent" to agent.roles before "user-facing-agent"',
    );
  }, 60_000);

  it("says nothing about root-agent when agent.roles names both files in order", async () => {
    const sb = await sandbox();
    await writeTree(sb);
    await writeConfig(
      sb,
      {
        orchestrator: { ...KNOWN, prompt: "claude" },
        planner: { ...KNOWN, prompt: "claude" },
        root: { ...KNOWN, prompt: "claude" },
        worker: { ...KNOWN, prompt: "deepseek-flash" },
      },
      ["root-agent", "user-facing-agent", "instance-root"],
    );
    await writePrompt(sb, "role", "instance-root");

    const run = runDoctor(sb);
    expect(run.status, run.stderr).toBe(0);
    expect(lines(run.stdout).filter((line) => line.includes("root-agent"))).toEqual([]);
    expect(run.stdout).toContain("prompt: 3 root role file(s) readable");
    expect(run.stdout).not.toContain("warning:");
  }, 60_000);

  it("says the daemon starts in setup mode for an empty agent.vmodel, and warns for a key it does not hold", async () => {
    const sb = await sandbox();
    await writeFile(sb.paths.configFile, `${JSON.stringify({ agent: { vmodel: "" } })}\n`, { mode: 0o600 });
    const empty = runDoctor(sb);
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain("setup mode: agent.vmodel is empty");
    expect(empty.stdout).toContain("pi-sec setup-model");
    expect(empty.stdout).not.toContain('warning: agent.vmodel ""');

    await writeFile(sb.paths.configFile, `${JSON.stringify({ agent: { vmodel: "nope" } })}\n`, { mode: 0o600 });
    const named = runDoctor(sb);
    expect(named.stdout).toContain('warning: agent.vmodel "nope" is not in config.vmodels');
    expect(named.stdout).not.toContain("setup mode");
  }, 60_000);
});
