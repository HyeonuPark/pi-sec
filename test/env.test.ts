import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createEnvFactory, RedactingEnv } from "../src/agent/env.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { createRedactor, type Redactor } from "../src/secrets/redact.ts";
import { buildPaths, resolveHome } from "../src/runtime/paths.ts";

describe("RedactingEnv", () => {
  it("redacts file reads and exec output before they reach the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-env-"));
    await writeFile(join(dir, "notes.txt"), "the token is sup3r-secret\n");
    const env = new RedactingEnv({
      cwd: dir,
      redactor: () => createRedactor([{ name: "tok", value: "sup3r-secret" }]),
    });

    const read = await env.readTextFile("notes.txt", BACKGROUND_CONTEXT);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toContain("\u27e6secret:tok\u27e7");
      expect(read.value).not.toContain("sup3r-secret");
    }

    let output = "";
    const exec = await env.exec("printf 'token=%s' sup3r-secret", { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
    expect(exec.ok).toBe(true);
    expect(output).toContain("\u27e6secret:tok\u27e7");
    expect(output).not.toContain("sup3r-secret");

    await env.cleanup(BACKGROUND_CONTEXT);
  });
});

/**
 * The shell's output, line by line, with a cap on one line.
 *
 * A command that prints one compressed file's worth of characters on one line
 * used to put all of it into the conversation, because the tail limits count
 * lines and bytes and neither says anything about one line's length. The cap is
 * applied after redaction, so the cut cannot land inside a secret and expose
 * part of one, and it has to give the same result whether the line arrived in
 * one read or several.
 */
describe("the 2000-character cap on one output line", () => {
  /** A scratch directory holding one script, and the environment that runs it. */
  async function scriptIn(body: string): Promise<{ dir: string; env: RedactingEnv; run: () => Promise<string> }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-lines-"));
    await writeFile(join(dir, "emit.mjs"), body);
    const env = new RedactingEnv({ cwd: dir, redactor: () => createRedactor([]) });
    return {
      dir,
      env,
      run: async () => {
        let output = "";
        const exec = await env.exec("node emit.mjs", { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
        expect(exec.ok).toBe(true);
        return output;
      },
    };
  }

  it("cuts a longer line at 2000 characters and reports the rest", async () => {
    const { env, run } = await scriptIn('process.stdout.write("a".repeat(3000) + "\\n");\n');
    expect(await run()).toBe(`${"a".repeat(2000)} [line cut: 1000 more characters]\n`);
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("passes a line of 2000 characters and a short one unchanged", async () => {
    const { env, run } = await scriptIn('process.stdout.write("b".repeat(2000) + "\\nshort\\n");\n');
    expect(await run()).toBe(`${"b".repeat(2000)}\nshort\n`);
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("gives the same result when the line arrives in several chunks", async () => {
    // Two writes with a gap between them: the shell's output reader delivers
    // them as separate chunks, so one line spans the boundary. The child writes
    // the second part only after the test has received the first, so the gap
    // does not depend on how fast the machine is. The deadline only ends a child
    // that never gets the signal, and the checks below then fail.
    const { dir, env } = await scriptIn(
      'import { existsSync } from "node:fs";\n' +
        'process.stdout.write("a".repeat(1500));\n' +
        "const deadline = Date.now() + 20_000;\n" +
        "const timer = setInterval(() => {\n" +
        '  if (existsSync("go")) process.stdout.write("a".repeat(1500) + "\\n");\n' +
        '  if (existsSync("go") || Date.now() > deadline) clearInterval(timer);\n' +
        "}, 10);\n",
    );
    const chunks: number[] = [];
    let output = "";
    const exec = await env.exec(
      "node emit.mjs",
      {
        onOutput: (text) => {
          chunks.push(text.length);
          output += text;
          writeFileSync(join(dir, "go"), "");
        },
      },
      BACKGROUND_CONTEXT,
    );
    expect(exec.ok).toBe(true);
    // The premise of this case: the line really did arrive in more than one read.
    expect(chunks.length).toBeGreaterThan(1);
    expect(output).toBe(`${"a".repeat(2000)} [line cut: 1000 more characters]\n`);
    await env.cleanup(BACKGROUND_CONTEXT);
  });
});

/**
 * One EnvTarget, with only the fields the factory reads.
 *
 * `read` is never touched by a factory that builds a shell environment, and
 * `conversationId` only names the conversation the directory belongs to.
 */
function target(cwd?: string): EnvTarget {
  return { conversationId: "c-1", ...(cwd === undefined ? {} : { cwd }), read: undefined } as unknown as EnvTarget;
}

describe("the agent's working directory", () => {
  /** A factory over a control structure at `controlHome` and the default config. */
  function factoryAt(controlHome: string, redactor: () => Redactor = () => createRedactor([])) {
    const paths = buildPaths(controlHome);
    const config = defaultConfig();
    return createEnvFactory({ paths, getConfig: () => config, redactor });
  }

  it("follows PI_SEC_HOME when the default workspace is configured", async () => {
    // `PI_SEC_HOME` is temp dir A and the run account's home is temp dir B. The
    // default `agent.workspace` names the control structure, not `$HOME`, so the
    // directory must land under A — otherwise the shell starts in a directory
    // that does not exist and every command fails.
    const controlHome = await mkdtemp(join(tmpdir(), "pi-sec-control-"));
    const accountHome = await mkdtemp(join(tmpdir(), "pi-sec-account-"));
    const paths = buildPaths(resolveHome({ HOME: accountHome, PI_SEC_HOME: controlHome }));
    expect(defaultConfig().agent.workspace).toBe("~/.pi/sec/workspace");

    const env = createEnvFactory({
      paths,
      getConfig: () => defaultConfig(),
      redactor: () => createRedactor([]),
    })(target()) as NodeExecutionEnv;

    expect(env.cwd).toBe(join(controlHome, "workspace"));
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("works in the workspace tree when the configured directory is empty", async () => {
    const controlHome = await mkdtemp(join(tmpdir(), "pi-sec-control-"));
    const paths = buildPaths(controlHome);
    const config = { ...defaultConfig(), agent: { ...defaultConfig().agent, workspace: "" } };

    const env = createEnvFactory({ paths, getConfig: () => config, redactor: () => createRedactor([]) })(target()) as NodeExecutionEnv;

    expect(env.cwd).toBe(paths.workspaceTree);
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("uses an explicit absolute directory as it stands", async () => {
    const controlHome = await mkdtemp(join(tmpdir(), "pi-sec-control-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "pi-sec-elsewhere-"));
    await mkdir(elsewhere, { recursive: true });
    const config = { ...defaultConfig(), agent: { ...defaultConfig().agent, workspace: elsewhere } };

    const env = createEnvFactory({
      paths: buildPaths(controlHome),
      getConfig: () => config,
      redactor: () => createRedactor([]),
    })(target()) as NodeExecutionEnv;

    expect(env.cwd).toBe(elsewhere);
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("lets a conversation's own cwd win over the configured default", async () => {
    const controlHome = await mkdtemp(join(tmpdir(), "pi-sec-control-"));
    const own = await mkdtemp(join(tmpdir(), "pi-sec-conversation-"));

    const env = factoryAt(controlHome)(target(own)) as NodeExecutionEnv;

    expect(env.cwd).toBe(own);
    await env.cleanup(BACKGROUND_CONTEXT);
  });
});
