import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The gate a core change has to pass before the user is asked to restart
 * for it. It runs against the workspace (modification) tree — the tree the
 * change was written in — never the running one.
 *
 * What it does not do is as important as what it does. It says "this compiles
 * and the tests pass", not "this is correct", and it cannot catch a fault that
 * only exists in the running tree: vitest resolves a bare specifier from the
 * project root, so a module the daemon cannot import in production still passes
 * here. It lowers the risk of asking for a restart on broken code; it does not
 * remove it.
 */

/** The first characters a display read keeps: a compiler prints its first errors there. */
const HEAD_CHARS = 2000;
/**
 * The last characters a display read keeps: a test runner prints its failed tests
 * and their summary there. Twice the head, because one failed test carries its
 * name, its expected and actual values, and a code frame.
 */
const TAIL_CHARS = 6000;
/**
 * Per-command ceiling, in milliseconds. A gate that can hang is a tool call that
 * can hang.
 *
 * 600 s is about three times the slowest full run measured on a four-core
 * machine (194.8 s, cold cache), which leaves room for a slower machine without
 * letting a stuck command hold the call forever. This is the default of the
 * `validation.timeoutMs` config key; an operator can raise or lower it.
 */
export const VALIDATION_TIMEOUT_MS = 600_000;
/** Ceiling for the change text a secret scan reads. Past this the scan is incomplete, and incomplete is a failure. */
const SCAN_LIMIT_BYTES = 8 * 1024 * 1024;

export interface ValidationRun {
  /** Both TypeScript projects exited 0: the server's, and the page's when the tree has one. */
  readonly typecheck: boolean;
  /** The test suite exited 0. */
  readonly tests: boolean;
  /** What the failing command printed. */
  readonly output?: string;
  /** Set when a check could not run, and why. Never a substitute for a pass. */
  readonly skipped?: string;
}

export interface ChangeText {
  /** Everything a restart would apply, plus the uncommitted change, for a secret scan. */
  readonly text?: string;
  /** Set when the change could not be read in full, so a scan of it proves nothing. */
  readonly problem?: string;
}

interface CommandOutcome {
  readonly ok: boolean;
  readonly output: string;
  readonly truncated: boolean;
}

/** One command's output, kept as the two ends that a reader needs. */
interface DisplayWindow {
  /** Add the next piece of what the command printed. */
  readonly push: (piece: string) => void;
  /** What is left of the output, with one line between the two ends when the middle was dropped. */
  readonly text: () => string;
  /** True when the middle was dropped, so the text is shorter than what the command printed. */
  readonly shortened: () => boolean;
}

/**
 * A window over a command's output that keeps the first {@link HEAD_CHARS} and
 * the last {@link TAIL_CHARS} characters and drops the middle, as it arrives.
 *
 * Keeping the tail costs a rolling copy of the last `TAIL_CHARS` characters, not
 * a copy of the whole output, so a command that prints megabytes stays bounded.
 * The tail of a short output holds everything past the head, which is why a text
 * of at most `HEAD_CHARS + TAIL_CHARS` comes back whole.
 */
function displayWindow(): DisplayWindow {
  let head = "";
  let tail = "";
  let seen = 0;
  const kept = HEAD_CHARS + TAIL_CHARS;
  return {
    push: (piece) => {
      seen += piece.length;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += piece.slice(0, room);
        tail = (tail + piece.slice(room)).slice(-TAIL_CHARS);
        return;
      }
      tail = (tail + piece).slice(-TAIL_CHARS);
    },
    text: () => (seen <= kept ? head + tail : `${head}\n… ${seen - kept} characters omitted …\n${tail}`),
    shortened: () => seen > kept,
  };
}

/**
 * Run one program directly, with no shell, and keep a bounded copy of its output.
 *
 * A `display` read keeps the first {@link HEAD_CHARS} characters and the last
 * {@link TAIL_CHARS} of them: a compiler prints its first errors at the start and
 * a test runner prints its failed tests and their summary at the end, so both
 * ends are what the reader of a refusal needs and the middle is not. When the
 * output is longer than the two ends together, one `… N characters omitted …`
 * line says how much of the middle was dropped.
 *
 * A scan read passes `display: false` and keeps every character up to
 * `limitChars`, flagged as `truncated` past it, because a scan of a shortened
 * text proves nothing about the part that was dropped.
 */
function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  limitChars = SCAN_LIMIT_BYTES,
  display = true,
): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    // A cancelled call must not leave a command running behind it: the child is the
    // work, and the timer is only a ceiling, so the signal kills the same way.
    if (signal?.aborted === true) {
      resolve({ ok: false, output: `${command} was cancelled before it started`, truncated: false });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolve({ ok: false, output: `cannot run ${command}: ${String(error)}`, truncated: false });
      return;
    }

    const window = display ? displayWindow() : undefined;
    let text = "";
    let truncated = false;
    const append = (chunk: Buffer): void => {
      const piece = chunk.toString("utf8");
      if (window !== undefined) {
        window.push(piece);
        return;
      }
      text += piece;
      if (text.length > limitChars) {
        truncated = true;
        text = text.slice(0, limitChars);
      }
    };
    /** What is left of the output, and whether anything was dropped from it. */
    const kept = (): string => (window === undefined ? text : window.text());
    const cut = (): boolean => (window === undefined ? truncated : window.shortened());
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let stopped: "timeout" | "cancelled" | undefined;
    const stop = (why: "timeout" | "cancelled"): void => {
      if (stopped !== undefined) return;
      stopped = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      stop("timeout");
    }, timeoutMs);
    const onAbort = (): void => {
      stop("cancelled");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finished = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      finished();
      resolve({ ok: false, output: `cannot run ${command}: ${String(error)}`, truncated: cut() });
    });
    child.on("close", (code) => {
      finished();
      if (stopped === "cancelled") {
        // A cancelled run is a run that did not pass. The text says which of the
        // two ways it ended, because "failed" alone would read as a fault in the tree.
        resolve({ ok: false, output: `${command} was cancelled\n${kept()}`, truncated: cut() });
        return;
      }
      if (stopped === "timeout") {
        resolve({
          ok: false,
          output: `${command} did not finish within ${timeoutMs}ms\n${kept()}`,
          truncated: cut(),
        });
        return;
      }
      resolve({ ok: code === 0, output: kept(), truncated: cut() });
    });
  });
}

/** The install's own binary, or `undefined` when the tree has no dependencies yet. */
function binary(root: string, name: string): string | undefined {
  const path = join(root, "node_modules", ".bin", name);
  return existsSync(path) ? path : undefined;
}

export interface ValidationOptions {
  readonly root: string;
  /** Per-command ceiling; defaults to {@link VALIDATION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Cancels the run. The command in flight is killed and the check it belongs to
   * reports a failure, so a cancelled gate never reads as a pass.
   */
  readonly signal?: AbortSignal;
}

/**
 * Typecheck, then test, in `root`. Stops at the first failure and says so: a
 * change that does not compile has nothing to learn from its test run.
 *
 * Missing dependencies fail the run rather than skipping it. "Could not check"
 * and "checked and fine" must never look alike — this gate is the only thing
 * between a broken change and a request to restart onto it.
 */
export async function runValidation(options: ValidationOptions): Promise<ValidationRun> {
  const root = options.root;
  const timeoutMs = options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
  const signal = options.signal;

  const tsc = binary(root, "tsc");
  const vitest = binary(root, "vitest");
  if (tsc === undefined || vitest === undefined) {
    return {
      typecheck: false,
      tests: false,
      skipped: `${root}/node_modules/.bin is missing tsc or vitest; run npm ci in the workspace tree`,
    };
  }

  const typecheck = await runCommand(tsc, ["-p", "tsconfig.json", "--noEmit"], root, timeoutMs, signal);
  if (!typecheck.ok) {
    return { typecheck: false, tests: false, output: typecheck.output };
  }

  // The page code is a second TypeScript project: its own settings (JSX, the DOM
  // types, no Node types) and its own files. A tree that has that project must
  // pass it too, because the pages are part of what a restart applies. A tree
  // without it (before the page code existed) is checked by the first project
  // alone, so this stays a widening of the gate and never a silent skip of it.
  if (existsSync(join(root, "tsconfig.web.json"))) {
    const pages = await runCommand(tsc, ["-p", "tsconfig.web.json", "--noEmit"], root, timeoutMs, signal);
    if (!pages.ok) {
      return { typecheck: false, tests: false, output: pages.output };
    }
  }

  const tests = await runCommand(vitest, ["--run"], root, timeoutMs, signal);
  if (!tests.ok) {
    return { typecheck: true, tests: false, output: tests.output };
  }

  return { typecheck: true, tests: true };
}

/**
 * The text of everything a restart would apply, for a one-shot secret scan of
 * the whole batch.
 *
 * A restart applies the commits between the execution (snapshot) tree's HEAD
 * and the workspace tree's HEAD. Workers commit before the root asks, so a scan
 * of the uncommitted change alone would read an empty text. The scan reads
 * three parts:
 *
 *   1. `git diff -U0 <snapshot HEAD> HEAD` in the workspace tree: every commit
 *      the running process has not applied yet;
 *   2. `git diff -U0 HEAD`: the uncommitted change;
 *   3. the files git does not track yet.
 *
 * Any part that cannot be read is reported as a problem rather than returned:
 * the snapshot HEAD that cannot be read, a diff git cannot compute (for example
 * a snapshot HEAD the workspace does not know), and a read cut short by the scan
 * limit. A scan of part of a change cannot conclude that the rest of it is clean.
 */
export interface ChangeTextOptions {
  /** Per-command ceiling; defaults to 60 seconds. */
  readonly timeoutMs?: number;
  /** Cancels the read: the git command in flight is killed and the part fails. */
  readonly signal?: AbortSignal;
}

/**
 * Whether an untracked entry that could not be read holds no content: a symbolic
 * link whose target does not exist, or one that names a directory, or a directory
 * itself (git lists a nested repository that way).
 */
async function hasNoContent(path: string): Promise<boolean> {
  const link = await lstat(path).catch(() => undefined);
  if (link === undefined) return false;
  if (link.isDirectory()) return true;
  if (!link.isSymbolicLink()) return false;
  const target = await stat(path).catch(() => undefined);
  return target === undefined || target.isDirectory();
}

export async function collectChangeText(
  root: string,
  snapshotRoot: string,
  options: ChangeTextOptions = {},
): Promise<ChangeText> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const signal = options.signal;
  const head = await runCommand("git", ["-C", snapshotRoot, "rev-parse", "--verify", "HEAD"], root, timeoutMs, signal);
  const base = head.output.trim();
  if (!head.ok || !/^[0-9a-f]{40,64}$/.test(base)) {
    return { problem: `cannot read the execution tree HEAD in ${snapshotRoot}: ${head.output.trim() || "git printed nothing"}` };
  }

  const committed = await runCommand("git", ["diff", "-U0", base, "HEAD"], root, timeoutMs, signal, SCAN_LIMIT_BYTES, false);
  if (!committed.ok) return { problem: `git diff ${base.slice(0, 12)} HEAD failed: ${committed.output}` };
  if (committed.truncated) return { problem: "the change is larger than the scan limit" };

  const tracked = await runCommand("git", ["diff", "-U0", "HEAD"], root, timeoutMs, signal, SCAN_LIMIT_BYTES, false);
  if (!tracked.ok) return { problem: `git diff failed: ${tracked.output}` };
  if (tracked.truncated) return { problem: "the change is larger than the scan limit" };

  const listed = await runCommand("git", ["ls-files", "-z", "--others", "--exclude-standard"], root, timeoutMs, signal, SCAN_LIMIT_BYTES, false);
  if (!listed.ok) return { problem: `git ls-files failed: ${listed.output}` };
  if (listed.truncated) return { problem: "the list of untracked files is larger than the scan limit" };

  const parts = [committed.output, tracked.output];
  let bytes = committed.output.length + tracked.output.length;
  if (bytes > SCAN_LIMIT_BYTES) return { problem: "the change is larger than the scan limit" };
  // `-z` prints names raw and ends each with NUL, so a name with non-ASCII
  // characters or a newline resolves as it is. A name is never trimmed.
  for (const relative of listed.output.split("\0")) {
    if (relative === "") continue;
    const text = await readFile(join(root, relative), "utf8").catch(() => undefined);
    if (text === undefined) {
      if (await hasNoContent(join(root, relative))) continue;
      return { problem: `cannot read the untracked file ${relative}, so the scan cannot cover it` };
    }
    bytes += text.length;
    if (bytes > SCAN_LIMIT_BYTES) return { problem: "the change is larger than the scan limit" };
    parts.push(`${relative}\n${text}`);
  }
  return { text: parts.join("\n") };
}
