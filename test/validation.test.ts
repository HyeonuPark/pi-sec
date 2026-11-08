import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectChangeText, runValidation } from "../src/runtime/validation.ts";

/** Run git in one tree with a fixed identity, so a commit works on any machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A workspace tree with one commit, and a snapshot tree cloned from it: the
 * shape `user-tools/update-and-restart` leaves behind after a restart.
 */
async function trees(): Promise<{ readonly workspace: string; readonly snapshot: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-sec-scan-"));
  const workspace = join(base, "workspace");
  const snapshot = join(base, "snapshot");
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "a.ts"), "export const a = 1;\n");
  git(workspace, "add", "a.ts");
  git(workspace, "commit", "-q", "-m", "first");
  execFileSync("git", ["clone", "-q", workspace, snapshot]);
  return { workspace, snapshot };
}

/**
 * Run `body` with git's upward search for a repository stopped at `directory`'s
 * parent, then put the variable back.
 *
 * Two tests here need a temporary directory that belongs to no repository: one
 * asks git to read a tree that is not a repository, the other asks for a HEAD
 * it must not find. `TMPDIR` decides where such a directory lands, and a run
 * with `TMPDIR` inside a work tree puts it inside one, where git walks up from
 * the temporary directory, finds the outer repository and answers with its
 * HEAD. `GIT_CEILING_DIRECTORIES` is git's own way to say "do not look above
 * here", so the assumption holds wherever the directory is. It is put back,
 * because every git command of every test in this file reads the variable.
 */
async function inTreeOfItsOwn<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(directory);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
}

/**
 * A tree whose `tsc` and `vitest` are stand-ins, so the gate's own order can be
 * read without compiling anything. The stand-in `tsc` writes the arguments it
 * was given to a log, and fails only when the page project is asked for and
 * `pages` says it must fail.
 */
async function fakeToolchain(options: { readonly pages: "pass" | "fail" | "absent" }): Promise<{
  readonly root: string;
  readonly tscCalls: () => Promise<string[]>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-tools-"));
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const log = join(root, "tsc.log");
  const failPageProject = options.pages === "fail" ? 1 : 0;
  await writeFile(
    join(bin, "tsc"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  *tsconfig.web.json*)
    if [ ${failPageProject} -eq 1 ]; then
      echo "tsconfig.web.json(1,1): error TS1005: the page project did not compile"
      exit 1
    fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "vitest"), '#!/bin/sh\necho "tests passed"\nexit 0\n', { mode: 0o755 });
  if (options.pages !== "absent") await writeFile(join(root, "tsconfig.web.json"), "{}\n");
  return {
    root,
    tscCalls: async () => {
      try {
        return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
  };
}

/**
 * A tree whose `tsc` is a stand-in that records its own pid and then blocks, so a
 * cancelled run has a real child process to stop.
 */
async function blockingToolchain(): Promise<{ readonly root: string; readonly pidFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-cancel-"));
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const pidFile = join(root, "tsc.pid");
  await writeFile(
    join(bin, "tsc"),
    `#!/bin/sh\necho "$$" > ${JSON.stringify(pidFile)}\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "vitest"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, pidFile };
}

/**
 * A tree whose `tsc` passes and whose `vitest` is a stand-in that runs a script
 * of its own, so a test can decide what a long run prints and how it ends.
 */
async function failingRunner(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-runner-"));
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "vitest"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return root;
}

/**
 * The text vitest and tsc print: the failures and the summary at the end, the
 * first errors at the start, and a long middle nobody reads.
 */
const PASS_LINE = "✓ test/some.test.ts > a test that passed (3 ms)";
const FAIL_LINE = "FAIL  test/x.test.ts > suite > broken test";
const SUMMARY_LINE = "Tests  1 failed | 2623 passed (2624)";

/** A shell loop that prints `count` lines, so the stand-in prints a long middle. */
function manyLines(count: number, line: string): string {
  return `i=0\nwhile [ $i -lt ${count} ]; do echo "${line}"; i=$((i + 1)); done`;
}

/** A shell line of exactly `length` characters, counting the newline `printf` adds. */
function oneLongLine(length: number): string {
  return `line=$(head -c ${length - 1} /dev/zero | tr '\\0' 'x')\nprintf '%s\\n' "$line"`;
}

/** The line a display read writes where it dropped the middle of an output. */
const OMITTED_LINE = /^… (\d+) characters omitted …$/m;

/**
 * A tree whose `tsc` prints `first` and then a long run of lines and fails, so a
 * test can see which end of a compiler's output the gate keeps.
 */
async function failingCompiler(first: string, fillerLines: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-tsc-"));
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "tsc"),
    `#!/bin/sh\necho "${first}"\n${manyLines(fillerLines, "tsconfig.json(2,1): error TS1005: a later error")}\nexit 1\n`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "vitest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return root;
}

/** Read a pid the stand-in `tsc` wrote, waiting for it to appear. */
async function readPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const text = await readFile(pidFile, "utf8");
      const pid = Number(text.trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error("the stand-in tsc never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The gate is the only thing between a broken change and a request to restart
 * onto it, so its failure mode matters more than its success. "Could not check"
 * must never be reachable as a pass.
 */
describe("validation gate", () => {
  it("fails closed when the tree has no dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-"));
    const run = await runValidation({ root });
    expect(run.typecheck).toBe(false);
    expect(run.tests).toBe(false);
    expect(run.skipped).toContain("node_modules");
  });

  it("checks the page project after the server project", async () => {
    const { root, tscCalls } = await fakeToolchain({ pages: "pass" });
    const run = await runValidation({ root });
    expect(run).toEqual({ typecheck: true, tests: true });
    expect(await tscCalls()).toEqual(["-p tsconfig.json --noEmit", "-p tsconfig.web.json --noEmit"]);
  });

  it("fails when the page project does not compile", async () => {
    const { root } = await fakeToolchain({ pages: "fail" });
    const run = await runValidation({ root });
    expect(run.typecheck).toBe(false);
    expect(run.tests).toBe(false);
    expect(run.output).toContain("the page project did not compile");
  });

  it("runs the server project alone when the tree has no page project", async () => {
    const { root, tscCalls } = await fakeToolchain({ pages: "absent" });
    const run = await runValidation({ root });
    expect(run.typecheck).toBe(true);
    expect(await tscCalls()).toEqual(["-p tsconfig.json --noEmit"]);
  });

  it("kills the command in flight when the call is cancelled", async () => {
    const { root, pidFile } = await blockingToolchain();
    const controller = new AbortController();
    const running = runValidation({ root, signal: controller.signal });
    const pid = await readPid(pidFile);

    controller.abort();
    const run = await running;

    // A cancelled run is a failed run, never a pass.
    expect(run.typecheck).toBe(false);
    expect(run.tests).toBe(false);
    expect(run.output).toContain("was cancelled");
    // The child is gone: `close` fires only after Node reaped it.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("keeps the failed test's name and the run's summary out of a long run's middle", async () => {
    // 40,000 characters of passing tests, then the one failure and the summary at
    // the end: reading the head alone loses exactly what says why the gate refused.
    const root = await failingRunner(
      `${manyLines(850, PASS_LINE)}\necho "${FAIL_LINE}"\necho "${SUMMARY_LINE}"\nexit 1`,
    );
    const run = await runValidation({ root });
    expect(run.typecheck).toBe(true);
    expect(run.tests).toBe(false);
    expect(run.output).toContain(FAIL_LINE);
    expect(run.output).toContain(SUMMARY_LINE);
    expect(run.output).toMatch(/… \d+ characters omitted …/);
  }, 30000);

  it("keeps the first error when a compiler fails after a long run", async () => {
    const FIRST_ERROR = "src/broken.ts(1,1): error TS2304: cannot find the first name";
    const root = await failingCompiler(FIRST_ERROR, 600);
    const run = await runValidation({ root });
    expect(run.typecheck).toBe(false);
    expect(run.tests).toBe(false);
    // The first error is at the head, the count of errors is at the tail: one
    // read has to carry both.
    expect(run.output).toContain(FIRST_ERROR);
    expect(run.output).toMatch(OMITTED_LINE);
  }, 30000);

  it("leaves an output of the two kept ends together alone, and shortens a longer one", async () => {
    const short = await failingRunner(`${oneLongLine(8000)}\nexit 1`);
    const shortRun = await runValidation({ root: short });
    expect(shortRun.tests).toBe(false);
    expect(shortRun.output).toBe("x".repeat(7999) + "\n");
    expect(shortRun.output).not.toMatch(OMITTED_LINE);

    const long = await failingRunner(`${oneLongLine(20000)}\nexit 1`);
    const longRun = await runValidation({ root: long });
    expect(longRun.tests).toBe(false);
    const marker = OMITTED_LINE.exec(longRun.output ?? "");
    expect(marker?.[1]).toBe("12000");
    // Both ends are kept and the middle is not: what is left is the head, the
    // tail, and one line that says what was dropped.
    const kept = (longRun.output ?? "").replace(/\n… \d+ characters omitted …\n/, "");
    expect(kept.length).toBeLessThanOrEqual(8000);
  }, 30000);

  it("reports a change it cannot read instead of scanning part of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-gate-"));
    const change = await inTreeOfItsOwn(root, () => collectChangeText(root, root));
    expect(change.text).toBeUndefined();
    expect(change.problem).toBeDefined();
  });

  it("reads the commits the snapshot has not applied, the uncommitted change, and untracked files", async () => {
    const { workspace, snapshot } = await trees();
    // Committed but not applied: the order the workers use, commit first and
    // ask for the restart later. A scan of the uncommitted change alone saw
    // nothing here.
    await writeFile(join(workspace, "a.ts"), "export const a = 'committed-marker';\n");
    git(workspace, "commit", "-q", "-am", "second");
    await writeFile(join(workspace, "b.ts"), "export const b = 'untracked-marker';\n");
    await writeFile(join(workspace, "a.ts"), "export const a = 'uncommitted-marker';\n");

    const change = await collectChangeText(workspace, snapshot);

    expect(change.problem).toBeUndefined();
    expect(change.text).toContain("committed-marker");
    expect(change.text).toContain("uncommitted-marker");
    expect(change.text).toContain("untracked-marker");
  });

  it("reads a committed change in full, past the length a tool result keeps", async () => {
    const { workspace, snapshot } = await trees();
    // The gate's command output is shortened in the middle for display. A scan
    // that read the shortened copy would miss a value in the middle of a long diff.
    const filler = Array.from({ length: 2000 }, (_, n) => `export const line${n} = ${n};`).join("\n");
    await writeFile(join(workspace, "long.ts"), `${filler}\nexport const middle = 'deep-marker';\n${filler}\n`);
    git(workspace, "add", "long.ts");
    git(workspace, "commit", "-q", "-m", "long");

    const change = await collectChangeText(workspace, snapshot);

    expect(change.problem).toBeUndefined();
    expect(change.text).toContain("deep-marker");
  });

  it("finds nothing to scan when the snapshot is at the workspace HEAD and the tree is clean", async () => {
    const { workspace, snapshot } = await trees();
    const change = await collectChangeText(workspace, snapshot);
    expect(change.problem).toBeUndefined();
    expect(change.text?.trim()).toBe("");
  });

  it("fails when the execution tree HEAD cannot be read", async () => {
    const { workspace } = await trees();
    const notATree = await mkdtemp(join(tmpdir(), "pi-sec-no-snapshot-"));
    const change = await inTreeOfItsOwn(notATree, () => collectChangeText(workspace, notATree));
    expect(change.text).toBeUndefined();
    expect(change.problem).toContain("cannot read the execution tree HEAD");
  });

  it("fails when the workspace does not know the execution tree HEAD", async () => {
    const { workspace } = await trees();
    // An unrelated history: its HEAD is not a commit of the workspace tree, so
    // git cannot compute what a restart would apply.
    const other = await trees();
    await writeFile(join(other.workspace, "c.ts"), "export const c = 3;\n");
    git(other.workspace, "add", "c.ts");
    git(other.workspace, "commit", "-q", "-m", "elsewhere");

    const change = await collectChangeText(workspace, other.workspace);
    expect(change.text).toBeUndefined();
    expect(change.problem).toContain("failed");
  });
});
