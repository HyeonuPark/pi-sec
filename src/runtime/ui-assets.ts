import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename as fsRename, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/**
 * Swap the browser-facing assets of a running daemon without touching it.
 *
 * The static route reads from disk on every request and sends `no-cache`
 * (see `src/server/static.ts`), so a page reload after this call serves the new
 * bytes. Nothing here is cached in the process, so nothing has to be reloaded in
 * the process either: the only state that moves is `dist/web` on disk.
 *
 * Two properties make the swap safe to run while the daemon answers requests.
 *
 *   - The copy is built beside the target and moved into place with a rename in
 *     the same parent, so a half-written tree is never served. The two renames
 *     that follow leave the target absent for the length of one rename, which is
 *     the only window in which a request can miss a file.
 *   - A failure puts the previous tree back and says so, because the caller has
 *     to be able to tell "nothing changed" from "you now have no assets".
 *
 * The last section is the build: the served pages are bundles, so the source of
 * a swap is the workspace's `src/web` plus the bundles its build tool writes
 * into the same staging directory. A build that fails leaves the served tree
 * alone and answers `build_failed`, because the fix is in the workspace code.
 *
 * This module writes nothing but the sibling directories of the target, and it
 * does not log or exit: the caller owns the report and the audit row.
 */

/** Why a sync refused to run, or ran and did not finish. */
export type UiAssetCode = "source_missing" | "web_dir_missing" | "sync_failed" | "build_failed";

/**
 * A sync that did not complete.
 *
 * `restored` answers the question the operator asks after a failure: is the
 * previous asset tree still in place at the target? It is true for every
 * failure that left the served tree alone, which includes the two pre-flight
 * refusals (nothing was touched) and a failed copy (only the unfinished copy is
 * removed). It is false when the target itself is missing, because then there
 * is no tree being served at all.
 */
export class UiAssetError extends Error {
  readonly code: UiAssetCode;
  readonly restored: boolean;

  constructor(code: UiAssetCode, restored: boolean, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UiAssetError";
    this.code = code;
    this.restored = restored;
  }
}

export interface UiSyncResult {
  /** Files copied into the new tree. Directories are not counted. */
  readonly copied: number;
  /**
   * One hash over the whole tree: each file's relative path and the sha256 of
   * its bytes, in path order. Two syncs of the same content give the same value,
   * so an audit row can say which asset tree was served without storing it.
   */
  readonly uiHash: string;
}

interface CopiedFile {
  readonly path: string;
  readonly sha256: string;
}

const GIT_TIMEOUT_MS = 5_000;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Relative paths are compared across platforms, so the separator is fixed. */
function posixPath(relativePath: string): string {
  return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

async function requireDirectory(dir: string, code: UiAssetCode, restored: boolean, label: string): Promise<void> {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch {
    // A missing directory and a path that is not a directory are the same
    // refusal: there is nothing to copy or nothing to replace.
  }
  throw new UiAssetError(code, restored, `${label} is not a directory: ${dir}`);
}

async function copyTree(sourceDir: string, targetDir: string, relDir: string, files: CopiedFile[]): Promise<void> {
  const entries = await readdir(join(sourceDir, relDir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relDir === "" ? entry.name : join(relDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(join(targetDir, relPath), { recursive: true });
      await copyTree(sourceDir, targetDir, relPath, files);
      continue;
    }
    // Anything that is not a directory is copied as a file. A symlink is
    // followed, so a link that points nowhere fails the copy instead of leaving
    // a dangling entry in the served tree.
    const source = join(sourceDir, relPath);
    await copyFile(source, join(targetDir, relPath));
    files.push({ path: posixPath(relPath), sha256: sha256(await readFile(source)) });
  }
}

/**
 * Copy `sourceDir` into `targetDir`, replacing it in one rename.
 *
 * The sibling names carry a timestamp and a random suffix, so two attempts in
 * the same millisecond get a directory each and neither can remove the other's.
 * They carry the `web.` prefix so an operator who sees one in `dist/` can tell
 * which function left it there.
 *
 * `rename` is a parameter so a test can fail one step on purpose. The restore
 * branch is the one that matters: it is the difference between "nothing changed"
 * and "the assets are in a backup directory", and a caller that is told the
 * wrong one cannot tell the operator what to do next.
 */
export async function syncWebAssets(options: {
  sourceDir: string;
  targetDir: string;
  rename?: (from: string, to: string) => Promise<void>;
}): Promise<UiSyncResult> {
  const { sourceDir, targetDir } = options;
  const move = options.rename ?? fsRename;
  // A missing source is not a rollback: the tree being served was never read.
  await requireDirectory(sourceDir, "source_missing", true, "the web source directory");
  await requireDirectory(targetDir, "web_dir_missing", false, "the web directory to replace");

  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const parent = dirname(targetDir);
  const nextDir = join(parent, `web.next-${stamp}`);
  const prevDir = join(parent, `web.prev-${stamp}`);

  const files: CopiedFile[] = [];
  try {
    await mkdir(nextDir);
    await copyTree(sourceDir, nextDir, "", files);
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
    throw new UiAssetError("sync_failed", true, `copying the web assets failed: ${String(error)}`, error);
  }

  try {
    await move(targetDir, prevDir);
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
    throw new UiAssetError("sync_failed", true, `moving the current web directory aside failed: ${String(error)}`, error);
  }

  try {
    await move(nextDir, targetDir);
  } catch (error) {
    // Put the previous tree back before reporting, and report what happened
    // rather than what was attempted: a tree still sitting in the backup
    // directory is not a restored tree, and calling it one would send the
    // operator looking for a screen that is not there.
    try {
      await move(prevDir, targetDir);
    } catch (restoreError) {
      await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
      throw new UiAssetError(
        "sync_failed",
        false,
        `moving the new web directory into place failed (${String(error)}) and the previous one could not be moved back, so it is still at ${prevDir}: ${String(restoreError)}`,
        error,
      );
    }
    await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
    throw new UiAssetError("sync_failed", true, `moving the new web directory into place failed: ${String(error)}`, error);
  }

  // The previous tree is removal debt now, and a tree that could not be removed
  // is a smaller problem than a swap reported as failed after it worked.
  await rm(prevDir, { recursive: true, force: true }).catch(() => undefined);

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = files.map((file) => `${file.path}\u0000${file.sha256}\n`).join("");
  return { copied: files.length, uiHash: sha256(manifest) };
}

/* ------------------------------------------------ building the page bundles */

/**
 * How long the workspace build may run before the swap gives up on it.
 *
 * The build is esbuild over a handful of page entries, which takes well under a
 * second, but it runs a separate node process in a tree the workspace owns. A
 * number here keeps a build that hangs from holding the request forever.
 */
export const BUILD_TIMEOUT_MS = 120_000;

/** The tail of a build's output, which is what an operator can act on. */
function outputTail(text: string): string {
  const trimmed = text.trim();
  const limit = 2_000;
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

/**
 * Bundle the pages of `workspaceDir` into `outDir`, with the build tool of that
 * tree.
 *
 * The script is the workspace's own `scripts/build-ui.mjs`, run by this
 * process's node, so the build is the one `npm run build` would do and not a
 * second implementation that can drift from it. Its root is its own directory,
 * so the bundles come from the sources in the workspace, which is the tree the
 * operator is editing.
 *
 * Nothing here reaches the served tree: `outDir` is a staging directory, and
 * every failure is an `UiAssetError` whose detail (the build output, or how long
 * it ran) goes to the caller's log and not to the page.
 */
export async function buildWebBundles(options: {
  workspaceDir: string;
  outDir: string;
  timeoutMs?: number;
}): Promise<void> {
  const { workspaceDir, outDir, timeoutMs = BUILD_TIMEOUT_MS } = options;
  const script = join(workspaceDir, "scripts", "build-ui.mjs");
  try {
    if (!(await stat(script)).isFile()) throw new Error("not a file");
  } catch {
    throw new UiAssetError("build_failed", true, `the web build script is missing: ${script}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [script, "--outdir", outDir],
      { cwd: workspaceDir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise();
          return;
        }
        const output = outputTail(`${stdout}${stderr}`);
        const detail = output === "" ? "" : `: ${output}`;
        // `killed` is set when this call's own timeout ended the child. A build
        // that exits with a code was ended by the code in the workspace, which
        // is a different sentence for the operator.
        const message =
          error.killed === true
            ? `the web build did not finish within ${timeoutMs} ms${detail}`
            : `the web build failed${detail}`;
        reject(new UiAssetError("build_failed", true, message, error));
      },
    );
  });
}

/**
 * Build and swap the workspace's web assets into `targetDir`.
 *
 * Four steps, and the order is what makes a failure harmless: the source and the
 * target are checked first, so a missing directory refuses before any work; the
 * workspace's `src/web` is copied into a staging directory beside the target
 * (`web.build-<stamp>`, the same naming as the `web.next-` and `web.prev-`
 * directories of a swap); the bundles are built into that same staging
 * directory, so the shells and the page bundles that belong together are in one
 * tree; and only then does `syncWebAssets` swap the staging directory in.
 *
 * A build that fails therefore never touches the served tree: the staging
 * directory is removed and the caller hears `build_failed` with `restored: true`,
 * which is the truth because the swap had not begun.
 */
export async function rebuildWebAssets(options: {
  workspaceDir: string;
  targetDir: string;
  timeoutMs?: number;
  rename?: (from: string, to: string) => Promise<void>;
}): Promise<UiSyncResult> {
  const { workspaceDir, targetDir, timeoutMs, rename } = options;
  const sourceDir = join(workspaceDir, "src", "web");
  await requireDirectory(sourceDir, "source_missing", true, "the web source directory");
  await requireDirectory(targetDir, "web_dir_missing", false, "the web directory to replace");

  const stagingDir = join(dirname(targetDir), `web.build-${Date.now()}-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(stagingDir);
    try {
      await copyTree(sourceDir, stagingDir, "", []);
    } catch (error) {
      throw new UiAssetError("sync_failed", true, `copying the web assets into the build directory failed: ${String(error)}`, error);
    }
    await buildWebBundles({ workspaceDir, outDir: stagingDir, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return await syncWebAssets({ sourceDir: stagingDir, targetDir, ...(rename === undefined ? {} : { rename }) });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface CodeDrift {
  /** False when git could not answer; the caller reports "unknown", not "none". */
  readonly known: boolean;
  /** Commits in the workspace tree that the execution tree does not have. */
  readonly behind: number;
  /** Paths under `src/` but not `src/web/` or `src/ui/` that changed across those commits. */
  readonly codePaths: string[];
}

const UNKNOWN_DRIFT: CodeDrift = { known: false, behind: 0, codePaths: [] };

/** `-C` on every call: the process cwd is not either tree. */
function git(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
}

/**
 * Which server-code changes the swapped assets will not carry.
 *
 * The button replaces `dist/web` only, and a page drawn from new assets against
 * old compiled server code can be broken. This reads the two commits, the paths
 * between them, and the paths the working tree has changed or added without a
 * commit, so the confirmation dialog can say how much was left out.
 *
 * `src/web` and `src/ui` are what the swap carries: it copies the shells and
 * builds the page bundles from `src/ui` into the same tree, so an edit there is
 * not a core change. The rest of `src/` compiles into the daemon, and that is
 * what the count names.
 *
 * The uncommitted paths are counted because the operator presses this button to
 * look at an edit before committing it, and server code can be open in the same
 * tree at that moment: a change to a server `.ts` file is exactly what the swap
 * cannot carry, and leaving it out of the count would report "nothing else is
 * waiting" while the screen runs against old compiled code.
 *
 * Every failure answers `known: false` instead of throwing: git may be absent,
 * a tree may not be a repository, and a drift check is never a reason to refuse
 * a swap that already happened.
 */
export async function readCodeDrift(options: { workspaceDir: string; snapshotDir: string }): Promise<CodeDrift> {
  const { workspaceDir, snapshotDir } = options;
  try {
    const workspace = (await git(["-C", workspaceDir, "rev-parse", "HEAD"])).trim();
    const snapshot = (await git(["-C", snapshotDir, "rev-parse", "HEAD"])).trim();
    const counted = (await git(["-C", workspaceDir, "rev-list", "--count", `${snapshot}..${workspace}`])).trim();
    const behind = Number.parseInt(counted, 10);
    if (!Number.isInteger(behind) || behind < 0) return UNKNOWN_DRIFT;

    const changed = await git(["-C", workspaceDir, "diff", "--name-only", `${snapshot}..${workspace}`]);
    // `--untracked-files=all` so a new file in a new directory is reported as
    // that file, not as the directory that has no tracked content yet.
    const working = await git(["-C", workspaceDir, "status", "--porcelain", "--untracked-files=all"]);
    const staged = changed
      .split("\n")
      .map((line) => line.trim())
      .filter((path) => path !== "");
    const codePaths = [
      ...new Set(
        [...staged, ...workingPaths(working)].filter(
          (path) => path.startsWith("src/") && !path.startsWith("src/web/") && !path.startsWith("src/ui/"),
        ),
      ),
    ].sort();
    return { known: true, behind, codePaths };
  } catch {
    return UNKNOWN_DRIFT;
  }
}

/**
 * Paths from `git status --porcelain`, one per changed or added entry.
 *
 * A row is `XY <path>`, where `X` is the index and `Y` the working tree; both
 * may be a space, which is why the path starts at column 4 and not after the
 * first space. A rename or a copy writes `R  old -> new`, and the new path is
 * the one that exists now. Untracked rows (`??`) are kept: a file that was never
 * added to git is still part of what the running build does not have.
 */
function workingPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const row of porcelain.split("\n")) {
    if (row.length < 4) continue;
    const path = row.slice(3);
    const arrow = path.lastIndexOf(" -> ");
    paths.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return paths;
}
