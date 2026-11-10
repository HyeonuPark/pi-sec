import { spawn } from "node:child_process";

/**
 * The git subprocess gate.
 *
 * The extension only ever reads history and fetches into the bare repositories
 * it keeps under `~/.pi/sec/gh-repo/`. Everything that could change a
 * repository on GitHub, and everything that could rewrite or delete local
 * history, is refused here, before a process is started, so no caller can reach
 * it by mistake: `push`, `gc`, `reset`, `checkout`, `clean`, `update-ref`,
 * `reflog` and the rest are not on the list.
 *
 * Two more properties matter for a daemon that runs unattended.
 *
 *   - `GIT_TERMINAL_PROMPT=0`. A private repository authenticates through the
 *     credential helper already in the account's git config, and a repository
 *     that needs a password git cannot get fails at once instead of waiting on
 *     a terminal that no one is watching. `GIT_PAGER=cat` keeps a pager out of
 *     the pipe.
 *   - Nothing is inherited from the caller but the environment, and the output
 *     and the time are both bounded. A subprocess of a daemon has to end by
 *     itself, and a fetch that hangs must not keep a bare repository's lock
 *     forever.
 *
 * What this module does not do is check the values it passes. A branch name or
 * a remote name that starts with `-` is still read by git as an option, so the
 * caller checks those first: `diff.ts` checks the branch name and the commit id,
 * and `store.ts` checks every name that becomes a remote or a folder.
 */

/**
 * The subcommands this extension may run. Reading: `cat-file`, `diff`, `show`,
 * `merge-base`, `rev-parse`, `fetch`. Remote management: `remote`, `init`,
 * `config`. Nothing else.
 */
export const ALLOWED_GIT_SUBCOMMANDS = [
  "cat-file",
  "config",
  "diff",
  "fetch",
  "init",
  "merge-base",
  "remote",
  "rev-parse",
  "show",
] as const;

/** One of the subcommands on the list. */
export type GitSubcommand = (typeof ALLOWED_GIT_SUBCOMMANDS)[number];

const ALLOWED: ReadonlySet<string> = new Set<string>(ALLOWED_GIT_SUBCOMMANDS);

/** Output kept per stream before the call is killed: a huge diff, not a hang. */
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** The ceiling for one call. A fetch of a large repository is slow, not this slow. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface GitOptions {
  /**
   * Whether a non-zero exit rejects with `GitError`. Default `true`. `false`
   * returns the result, for the calls whose failure is an answer: an absent
   * commit, a branch that is not on the remote.
   */
  readonly check?: boolean;
  /** Per-stream output cap, in bytes. */
  readonly maxOutputBytes?: number;
  /** Ceiling for the call, in milliseconds. */
  readonly timeoutMs?: number;
  /** Extra environment for this call, on top of the two values this module sets. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GitResult {
  /** The arguments as given, without the program name. */
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A git call that exited non-zero. */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], code: number | null, stderr: string, message?: string) {
    const detail = stderr.trim();
    super(message ?? (detail.length > 0 ? detail : `git ${args.join(" ")} failed`));
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/** A git call that was refused before a process was started. */
export class GitCommandRefusedError extends Error {
  /** The subcommand that was asked for, or `""` when the argument list was empty. */
  readonly subcommand: string;
  readonly args: readonly string[];

  constructor(args: readonly string[]) {
    const subcommand = args[0] ?? "";
    super(
      subcommand.length === 0
        ? "git was called with no subcommand, and this extension only runs the subcommands it allows"
        : `git ${subcommand} is not one of the subcommands this extension runs (${ALLOWED_GIT_SUBCOMMANDS.join(", ")})`,
    );
    this.name = "GitCommandRefusedError";
    this.subcommand = subcommand;
    this.args = args;
  }
}

/** Whether the argument list starts with a subcommand this extension runs. */
export function isAllowedGitCall(args: readonly string[]): boolean {
  const subcommand = args[0];
  return subcommand !== undefined && ALLOWED.has(subcommand);
}

/**
 * Run git in one directory and collect its output.
 *
 * `cwd` is the repository (a bare one, usually). The subcommand is checked
 * against the list before `spawn` is reached, so a refusal is a rejected
 * promise and never a child process.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  if (!isAllowedGitCall(args)) throw new GitCommandRefusedError(args);

  const check = options.check ?? true;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...options.env,
  };

  const result = await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;

    const timer = setTimeout(() => {
      failure = new GitError(args, null, "", `git ${args.join(" ")} took longer than ${timeoutMs} ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const collect = (chunks: Buffer[], chunk: Buffer, isStdout: boolean): void => {
      if (isStdout) stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        failure ??= new GitError(args, null, "", `git ${args.join(" ")} printed more than ${maxOutputBytes} bytes`);
        child.kill("SIGKILL");
        return;
      }
      // Bytes, not text: a character can be split between two chunks.
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitError(args, null, "", `git could not be started: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (code === null) {
        // A signal from outside ended the child (for example the out-of-memory
        // killer), so its output is partial and the call gave no answer.
        reject(new GitError(args, null, Buffer.concat(stderr).toString("utf8"), `git ${args.join(" ")} was ended by ${signal ?? "a signal"}`));
        return;
      }
      resolve({
        args: [...args],
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

  if (check && result.code !== 0) {
    throw new GitError(args, result.code, result.stderr);
  }
  return result;
}
