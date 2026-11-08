import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";

/**
 * The protection hook a registry repository carries.
 *
 * A worktree shares the hooks of its repository, so one file guards every
 * worktree cut from it: it refuses a movement of `main` or `snapshot`, a check
 * out of `main` or `snapshot`, a deletion of a branch or a tag, a movement of a
 * branch that is not the worktree's own, and a movement of a tag that already
 * exists. That is what keeps an agent in a worktree from landing its own work
 * or erasing history, while a commit, a stash, a rebase of its own branch, a
 * new tag and a new branch all keep working.
 *
 * The repository says which registry it belongs to with one git config value,
 * `pi-sec.registryRoot`, and the hook reads it at every ref transaction. So a
 * repository that no registry owns is untouched even if the file is installed
 * by mistake, and a path outside `<root>/worktrees/` is untouched too.
 */

/**
 * The hook script, byte for byte the text the user approved.
 *
 * It is a template literal, so `${new#ref:}` is written `\${new#ref:}` to keep
 * the shell parameter expansion instead of reading a JavaScript variable. Every
 * other character is the approved text as it is; the test compares the two byte
 * for byte.
 *
 * The all-zero old value that git reports needs one care: git sends it both for
 * a ref that is created and for an update that names no old value, so the hook
 * asks git whether the ref is there before it treats the line as a creation.
 */
export const REFERENCE_TRANSACTION_HOOK = `#!/bin/sh
# Refuse, inside a registry worktree, a movement of main or snapshot, a
# deletion of a branch or a tag, and a check out of main or snapshot.
# A worktree shares the hooks of its repository, so one file guards them all.
[ "$1" = "prepared" ] || exit 0
root=$(git config --get pi-sec.registryRoot 2>/dev/null) || exit 0
[ -n "$root" ] || exit 0
here=$(cat "$GIT_DIR/gitdir" 2>/dev/null) || exit 0
case "$here" in "$root"/worktrees/*) ;; *) exit 0 ;; esac
mine=$(sed -n 's|^ref: *||p' "$GIT_DIR/HEAD" 2>/dev/null)
[ -n "$mine" ] || for d in rebase-merge rebase-apply; do
  [ -f "$GIT_DIR/$d/head-name" ] && { mine=$(cat "$GIT_DIR/$d/head-name"); break; }
done
zero=0000000000000000000000000000000000000000
rc=0
while read -r old new ref; do
  case "$ref" in
    HEAD)
      case "$new" in
        ref:refs/heads/main|ref:refs/heads/snapshot)
          echo "refguard: a registry worktree may not check out \${new#ref:}" >&2
          rc=1;;
      esac
      continue;;
    refs/heads/main|refs/heads/snapshot)
      echo "refguard: $ref is moved by a landing or the update script" >&2
      rc=1; continue;;
    refs/heads/*)
      if [ "$new" = "$zero" ]; then
        echo "refguard: deleting $ref is refused" >&2
        rc=1; continue
      fi
      # An update that names no old value reports old as zero even when the ref
      # exists, so ask git whether the ref is there before calling this a create.
      if [ "$old" = "$zero" ] && ! git rev-parse --verify -q "$ref" >/dev/null 2>&1; then
        continue
      fi
      [ "$ref" = "$mine" ] || {
        echo "refguard: $ref is not this worktree's branch ($mine)" >&2
        rc=1
      }
      continue;;
    refs/tags/*)
      if [ "$new" = "$zero" ]; then
        echo "refguard: deleting $ref is refused" >&2
        rc=1; continue
      fi
      if [ "$old" != "$zero" ] || git rev-parse --verify -q "$ref" >/dev/null 2>&1; then
        echo "refguard: moving $ref is refused" >&2
        rc=1
      fi
      continue;;
  esac
done
exit $rc
`;

/** The mode the hook file is installed with: git runs it only when it is executable. */
const HOOK_MODE = 0o755;

/** The file name git runs for a ref transaction, inside the hooks folder. */
const HOOK_NAME = "reference-transaction";

/** The config key that names the registry a repository belongs to. */
const ROOT_KEY = "pi-sec.registryRoot";

/** What `checkHook` found. */
export interface HookCheck {
  /** The hook file is in the repository's hooks folder. */
  present: boolean;
  /** The file may be executed. */
  executable: boolean;
  /** `pi-sec.registryRoot` holds the root that was asked about. */
  configured: boolean;
  /** The file is byte for byte the approved hook. */
  matches: boolean;
}

/**
 * The environment git is run with.
 *
 * The four variables below describe the repository of the caller, and a hook
 * runs inside one with them set. `--git-dir` already names the repository this
 * module means, so an inherited `GIT_DIR` or `GIT_WORK_TREE` would only make
 * git read two answers. Everything else, such as the operator's `GIT_CONFIG_*`,
 * is kept: the caller's git configuration is the caller's.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_COMMON_DIR"];
  delete env["GIT_INDEX_FILE"];
  return env;
}

/**
 * Run one git command against a git directory, and give back its exit status and
 * both streams. A command that cannot be started at all throws.
 */
function runGit(gitDir: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], {
    cwd: gitDir,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run one git command and refuse to go on when it fails. */
function gitOrThrow(gitDir: string, args: readonly string[]): string {
  const result = runGit(gitDir, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git ${args.join(" ")} failed in ${gitDir} (exit ${result.status}): ${detail}`);
  }
  return result.stdout;
}

/**
 * The hooks folder git uses for this repository.
 *
 * `rev-parse --git-path hooks` is the only correct answer: it follows
 * `core.hooksPath`, and for a linked worktree it names the shared folder rather
 * than the per-worktree one, which is the folder that actually runs. The answer
 * is relative for a repository at a normal path and absolute under
 * `core.hooksPath`, so a relative answer is resolved against the git directory.
 */
function hooksDir(gitDir: string): string {
  const answer = gitOrThrow(gitDir, ["rev-parse", "--git-path", "hooks"]).trim();
  const path = answer.length === 0 ? "hooks" : answer;
  return isAbsolute(path) ? path : resolve(gitDir, path);
}

/**
 * Install the protection hook in a repository and point it at a registry root.
 *
 * A `reference-transaction` file that already exists with different content is
 * refused and nothing is changed, not even the config: another tool's hook is
 * not this module's to replace, and the operator has to look at it. The same
 * content is accepted and only the mode and the config are put right, which
 * makes the call safe to repeat.
 *
 * Other hook files are never read, written or removed.
 */
export function installHook(gitDir: string, root: string): void {
  const file = join(hooksDir(gitDir), HOOK_NAME);
  if (existsSync(file)) {
    const current = readFileSync(file);
    if (!current.equals(Buffer.from(REFERENCE_TRANSACTION_HOOK, "utf8"))) {
      throw new Error(
        `refusing to replace ${file}: it holds a reference-transaction hook that is not the registry's`,
      );
    }
    chmodSync(file, HOOK_MODE);
  } else {
    // The folder exists in every repository git created, and `mkdir` here only
    // covers a repository whose hooks folder an operator removed.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, REFERENCE_TRANSACTION_HOOK, { encoding: "utf8", mode: HOOK_MODE, flag: "wx" });
    // `writeFileSync`'s mode is masked by the process umask; git skips a hook it
    // may not execute, so the mode is set again.
    chmodSync(file, HOOK_MODE);
  }
  gitOrThrow(gitDir, ["config", ROOT_KEY, root]);
}

/**
 * Report whether this repository carries the hook and points at this root.
 *
 * `configured` is true only when `pi-sec.registryRoot` is the root that was
 * asked about, because that is what the hook compares against: a repository
 * pointed at another root is one this root's worktrees are not guarded in.
 */
export function checkHook(gitDir: string, root: string): HookCheck {
  const file = join(hooksDir(gitDir), HOOK_NAME);
  const present = existsSync(file);
  let executable = false;
  let matches = false;
  if (present) {
    try {
      accessSync(file, constants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
    matches = readFileSync(file).equals(Buffer.from(REFERENCE_TRANSACTION_HOOK, "utf8"));
  }
  const configured = runGit(gitDir, ["config", "--get", ROOT_KEY]).stdout.trim() === root;
  return { present, executable, configured, matches };
}
