import { GitError, runGit } from "./git.ts";
import { DiskLimitError, type RepoStore } from "./store.ts";

/**
 * The pull request diff, computed from the bare repository the store keeps.
 *
 * The work follows a fixed order of steps, because the browser expects the same
 * payload:
 *
 *   1. If the PR's head commit is not local, fetch `refs/pull/<n>/head` from the
 *      remote of the repository the PR is open in. A pull request ref exists on
 *      GitHub only; a plain fetch of the branches does not bring it, which is
 *      why it is fetched on its own.
 *   2. Fetch the base branch every time the diff is viewed, so a base branch
 *      that moved is current. When that fetch fails, use the remote-tracking
 *      ref left by an earlier fetch.
 *   3. Compare the merge base of the two commits, not the base branch tip: the
 *      diff is then the change the PR makes and not the change main took since
 *      the branch was cut.
 *   4. `git diff --no-color --find-renames -U3` between the merge base and the
 *      head, parsed into hunks. `runGit` sets `core.quotePath=false`, so git
 *      prints a non-ASCII name as it is. A name with a control character, a
 *      double quote or a backslash stays quoted, and the parser decodes it.
 *   5. Add the whole file on both sides of every changed file, so the browser
 *      can expand a collapsed context region without another request. A file
 *      over 50000 lines is left out: it is not expandable, and the payload is
 *      not allowed to grow without bound.
 *
 * The payload field names are the original's (`number`, `baseRef`, `baseSha`,
 * `headSha`, `mergeBase`, `files`, and per file `oldPath`, `path`, `status`,
 * `binary`, `hunks`, `additions`, `deletions`, `oldContent`, `newContent`). The
 * route adds `repo` and `title`, which are not git's business.
 */

/** Lines of a file beyond which the whole content is not sent. */
export const MAX_CONTENT_LINES = 50000;

/** One line of a hunk. `t` says what happened to it. */
export interface DiffLine {
  readonly t: "add" | "del" | "ctx";
  /** The line without its leading `+`, `-` or space. */
  readonly s: string;
}

/** One `@@` block. */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** The text after the closing `@@`, trimmed: the enclosing function, usually. */
  readonly section: string;
  readonly lines: DiffLine[];
}

/** `A` added, `D` deleted, `R` renamed or copied, `M` modified. */
export type DiffStatus = "A" | "D" | "R" | "M";

/**
 * One changed file.
 *
 * The fields are writable because the payload is a JSON object the browser
 * reads, not a value this module has to keep immutable: `computePrDiff` fills
 * the file contents in after the parse.
 */
export interface DiffFile {
  /** The path before the change. `null` for an added file. */
  oldPath: string | null;
  /** The path after the change. `null` for a deleted file. */
  path: string | null;
  status: DiffStatus;
  /** Git reported the contents as binary, so there are no hunks and no content. */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Whole file at `mergeBase`. Absent for an added or binary file. */
  oldContent?: string[] | null;
  /** Whole file at the head. Absent for a deleted or binary file. */
  newContent?: string[] | null;
}

/**
 * The diff payload.
 *
 * `number` stays a number; `title` and `repo` are added by the route, which has
 * the pull request's GitHub information and the configured name.
 */
export interface PrDiffPayload {
  readonly number: number;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBase: string;
  readonly files: DiffFile[];
}

export interface PrDiffInput {
  /** The store that owns the bare repository, its lock and its disk guard. */
  readonly store: RepoStore;
  /** The repository the pull request is open in, `owner/repo`. */
  readonly repo: string;
  /** The pull request number, used for `refs/pull/<n>/head`. */
  readonly number: number;
  /** The base branch name as GitHub reports it, for example `main`. */
  readonly baseRef: string;
  /** The head commit GitHub reports for the pull request. */
  readonly headSha: string;
}

/**
 * Compute one pull request's diff.
 *
 * Everything happens under the bare repository's lock: the fetches, the
 * merge-base and the diffs are one unit, so a reconcile's prune cannot take a
 * remote away in the middle.
 *
 * A first fetch of a network that would pass the disk limit throws
 * `DiskLimitError` from the store, before anything is fetched. The caller turns
 * it into the `409 disk_limit` answer and does not retry.
 */
export async function computePrDiff(input: PrDiffInput): Promise<PrDiffPayload> {
  const { store, repo, baseRef } = input;
  const number = checkNumber(input.number);
  checkBaseRef(baseRef);
  let headSha = checkSha(input.headSha);

  return store.withRepo(repo, async (handle) => {
    const path = handle.path;
    const remote = handle.remote;

    if (!(await hasCommit(path, headSha))) {
      await runGit(path, ["fetch", remote, `refs/pull/${number}/head`]);
      if (!(await hasCommit(path, headSha))) {
        headSha = (await runGit(path, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
      }
    }

    const fetched = await runGit(path, ["fetch", remote, baseRef], { check: false });
    const baseSha =
      fetched.code === 0
        ? (await runGit(path, ["rev-parse", "FETCH_HEAD"])).stdout.trim()
        : (await runGit(path, ["rev-parse", `${remote}/${baseRef}`])).stdout.trim();

    const mergeBase = (await runGit(path, ["merge-base", baseSha, headSha])).stdout.trim();
    if (mergeBase.length === 0) {
      throw new GitError(["merge-base", baseSha, headSha], 0, "", "the two commits have no merge base");
    }

    const diffText = (
      await runGit(path, ["diff", "--no-color", "--find-renames", "-U3", mergeBase, headSha])
    ).stdout;

    const files = await filesWithContent(path, diffText, mergeBase, headSha);

    return { number, baseRef, baseSha, headSha, mergeBase, files };
  });
}

/**
 * Parse a diff, sort its files, and add the whole old content (at `oldSha`) and
 * new content (at `newSha`) of each changed file. `oldSha` is `null` when there
 * is no old side, as for a root commit.
 */
async function filesWithContent(
  path: string,
  diffText: string,
  oldSha: string | null,
  newSha: string,
): Promise<DiffFile[]> {
  const files = parseUnifiedDiff(diffText);
  files.sort((a, b) => compare(a.path ?? "", b.path ?? ""));
  for (const file of files) {
    if (file.binary) continue;
    if (oldSha !== null && file.status !== "A" && file.oldPath !== null) {
      file.oldContent = await fileLines(path, oldSha, file.oldPath);
    }
    if (file.status !== "D" && file.path !== null) {
      file.newContent = await fileLines(path, newSha, file.path);
    }
  }
  return files;
}

/** The facts of one commit that the commit diff page shows. */
export interface CommitFacts {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly headline: string;
  /** The message after the first line, without the blank line that follows it. */
  readonly body: string;
}

/** The commit diff payload: the pull request diff's fields, plus `commit`. */
export interface CommitDiffPayload extends PrDiffPayload {
  readonly commit: CommitFacts;
}

export interface CommitDiffInput {
  readonly store: RepoStore;
  readonly repo: string;
  readonly number: number;
  /** The head commit GitHub reports for the pull request. */
  readonly headSha: string;
  /** The commit to show: 40 or 64 hexadecimal digits. */
  readonly sha: string;
}

/**
 * The commit is not part of the pull request now. The route answers 404 with
 * this message, which is written for the reader of the page.
 */
export class CommitNotInPrError extends Error {
  constructor(sha: string, number: number) {
    super(
      `commit ${sha.slice(0, 7)} is not part of pull request #${number} now. A force-push can remove a commit. Reload the pull request page for the current list.`,
    );
    this.name = "CommitNotInPrError";
  }
}

/**
 * Compute the diff of one commit of a pull request.
 *
 * The commit must exist locally (after fetching `refs/pull/<n>/head` when the
 * head is missing) and be an ancestor of the head, so the page cannot show an
 * arbitrary commit of the whole fork network. The diff is the commit against its
 * first parent; a root commit is its own creation diff.
 */
export async function computeCommitDiff(input: CommitDiffInput): Promise<CommitDiffPayload> {
  const { store, repo } = input;
  const number = checkNumber(input.number);
  const sha = checkSha(input.sha);
  if (sha.length === 0) throw new Error("a commit id must be 40 or 64 hexadecimal digits, not an empty value");
  let headSha = checkSha(input.headSha);

  return store.withRepo(repo, async (handle) => {
    const path = handle.path;
    const remote = handle.remote;

    if (!(await hasCommit(path, headSha))) {
      await runGit(path, ["fetch", remote, `refs/pull/${number}/head`]);
      if (!(await hasCommit(path, headSha))) {
        headSha = (await runGit(path, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
      }
    }

    if (!(await hasCommit(path, sha))) throw new CommitNotInPrError(sha, number);
    const inPr = await runGit(path, ["merge-base", "--is-ancestor", sha, headSha], { check: false });
    if (inPr.code !== 0) throw new CommitNotInPrError(sha, number);

    const parentResult = await runGit(path, ["rev-parse", "--verify", "--quiet", `${sha}^1`], { check: false });
    const parent = parentResult.code === 0 ? parentResult.stdout.trim() : "";

    const diffText = (
      await runGit(path, [
        "show",
        "--no-color",
        "--find-renames",
        "-U3",
        "--format=",
        "--diff-merges=first-parent",
        sha,
      ])
    ).stdout;
    const files = await filesWithContent(path, diffText, parent === "" ? null : parent, sha);

    const raw = (
      await runGit(path, ["show", "-s", "--no-color", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b", sha])
    ).stdout;
    const [fullSha = sha, parents = "", authorName = "", authorEmail = "", authoredAt = "", committedAt = "", headline = "", ...rest] =
      raw.split("\0");
    const commit: CommitFacts = {
      sha: fullSha.trim(),
      parents: parents.split(" ").filter((value) => value !== ""),
      authorName,
      authorEmail,
      authoredAt,
      committedAt,
      headline,
      body: rest.join("\0").trim(),
    };

    return { number, baseRef: "", baseSha: parent, headSha: sha, mergeBase: parent, files, commit };
  });
}

/** A pull request number that is a positive integer, or a refusal. */
function checkNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`a pull request number must be a positive integer, not ${String(value)}`);
  }
  return value;
}

/**
 * A commit sha as git prints it: 40 hex digits of SHA-1, or 64 of SHA-256.
 *
 * Anything else is refused here rather than handed to `git cat-file`, because
 * the value comes from GitHub's answer, which this code does not control. An
 * empty value means "not known", and the fetch below answers with `FETCH_HEAD`.
 */
function checkSha(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error(`a commit id must be 40 or 64 hexadecimal digits, not ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/**
 * A base branch name that is safe to pass to git.
 *
 * The name arrives in GitHub's answer for the pull request, so it is untrusted
 * input: a value that starts with `-` is read by git as an option, and one of
 * the fetch options runs a command. The rules here are the ones `git
 * check-ref-format` applies to a branch name, minus the parts that do not
 * matter for a single short name.
 */
function checkBaseRef(value: string): void {
  const bad =
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value === "@" ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(value);
  if (bad) {
    throw new Error(`the base branch name ${JSON.stringify(value)} is not a name git accepts`);
  }
}

/** Whether the object is a commit this repository has. */
async function hasCommit(path: string, sha: string): Promise<boolean> {
  if (sha.length === 0) return false;
  const result = await runGit(path, ["cat-file", "-e", `${sha}^{commit}`], { check: false });
  return result.code === 0;
}

/**
 * The file's lines at one commit, or `null` when it is absent there or longer
 * than `MAX_CONTENT_LINES`.
 *
 * The trailing newline does not make an empty last line, which is what the
 * original did as well: the browser joins the lines back with `\n`.
 */
async function fileLines(path: string, sha: string, file: string): Promise<string[] | null> {
  let stdout: string;
  try {
    const result = await runGit(path, ["show", `${sha}:${file}`], {
      check: false,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.code !== 0) return null;
    stdout = result.stdout;
  } catch {
    // A file too large for the output cap is as unexpandable as one over the
    // line limit: the browser shows the hunks and no context to expand.
    return null;
  }
  const lines = stdout.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_CONTENT_LINES) return null;
  return lines;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const LINE_TYPE: Readonly<Record<string, DiffLine["t"]>> = { "+": "add", "-": "del", " ": "ctx" };

/**
 * Parse `git diff` output into files and hunks.
 *
 * The parser reads what git prints and keeps the field names the browser uses.
 * Two details come from the original and matter:
 *
 *   - A context line whose content is empty arrives as a single space, and the
 *     empty string is only the artifact of the final newline. So only a line
 *     that starts with `+`, `-` or a space counts.
 *   - A line that starts with a backslash (`\ No newline at end of file`) is
 *     skipped. It is not part of the file.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let inHunks = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const header = parseDiffGitHeader(line.slice("diff --git ".length));
      current = {
        oldPath: header?.oldPath ?? null,
        path: header?.path ?? null,
        status: "M",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(current);
      inHunks = false;
      continue;
    }
    if (current === undefined) continue;

    if (line.startsWith("@@")) {
      const match = HUNK.exec(line);
      if (match !== null) {
        current.hunks.push({
          oldStart: Number(match[1]),
          oldLines: Number(match[2] ?? "1"),
          newStart: Number(match[3]),
          newLines: Number(match[4] ?? "1"),
          section: (match[5] ?? "").trim(),
          lines: [],
        });
        inHunks = true;
      }
      continue;
    }
    if (inHunks && current.hunks.length > 0) {
      const kind = line.length > 0 ? LINE_TYPE[line.slice(0, 1)] : undefined;
      if (kind !== undefined) {
        const hunk = current.hunks[current.hunks.length - 1];
        if (hunk !== undefined) {
          hunk.lines.push({ t: kind, s: line.slice(1) });
          if (kind === "add") current.additions += 1;
          else if (kind === "del") current.deletions += 1;
        }
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = stripDevNull(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      current.path = stripDevNull(line.slice(4));
    } else if (line.startsWith("rename from ")) {
      current.oldPath = decodePath(line.slice("rename from ".length));
      current.status = "R";
    } else if (line.startsWith("rename to ")) {
      current.path = decodePath(line.slice("rename to ".length));
      current.status = "R";
    } else if (line.startsWith("copy from ")) {
      current.oldPath = decodePath(line.slice("copy from ".length));
      current.status = "R";
    } else if (line.startsWith("copy to ")) {
      current.path = decodePath(line.slice("copy to ".length));
      current.status = "R";
    } else if (line.startsWith("new file")) {
      current.status = "A";
    } else if (line.startsWith("deleted file")) {
      current.status = "D";
    } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.binary = true;
    }
  }

  for (const file of files) {
    if (file.path === null) file.path = file.oldPath;
    if (file.status === "A") file.oldPath = null;
  }
  return files;
}

/** The escapes git writes inside a quoted path, besides three-digit octal bytes. */
const PATH_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Read the quoted form of a path that git prints for a name with a control
 * character, a double quote, a backslash or (without `core.quotePath=false`) a
 * byte over 0x7f. Escapes become bytes and the bytes are read as UTF-8. A value
 * that is not wrapped in double quotes is returned as it is.
 */
function decodePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; ) {
    const char = inner[index] ?? "";
    if (char !== "\\") {
      const point = inner.codePointAt(index) ?? 0;
      const text = String.fromCodePoint(point);
      bytes.push(...Buffer.from(text, "utf8"));
      index += text.length;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += 4;
      continue;
    }
    const escaped = PATH_ESCAPES[inner[index + 1] ?? ""];
    if (escaped !== undefined) {
      bytes.push(escaped);
      index += 2;
      continue;
    }
    // An escape that git does not write: keep the backslash.
    bytes.push(0x5c);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Split off one path token at the start of `text`: quoted, or up to the next space. */
function quotedPrefix(text: string): string | undefined {
  if (!text.startsWith('"')) return undefined;
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return text.slice(0, index + 1);
  }
  return undefined;
}

/**
 * The two paths of a `diff --git` line, without the `a/` and `b/` prefixes. Each
 * side can be quoted or not. A name with a space is not quoted, so for two
 * unquoted sides the line is cut where both halves are the same name, or else at
 * the first ` b/`.
 */
function parseDiffGitHeader(rest: string): { oldPath: string; path: string } | undefined {
  const first = quotedPrefix(rest);
  if (first !== undefined) {
    const second = rest.slice(first.length + 1);
    return { oldPath: stripPrefix(decodePath(first)), path: stripPrefix(decodePath(second)) };
  }
  const quotedSecond = rest.indexOf(' "b/');
  if (quotedSecond > 0) {
    return { oldPath: stripPrefix(rest.slice(0, quotedSecond)), path: stripPrefix(decodePath(rest.slice(quotedSecond + 1))) };
  }
  const middle = (rest.length - 1) / 2;
  if (Number.isInteger(middle) && rest[middle] === " " && rest.slice(0, middle).startsWith("a/")) {
    const left = rest.slice(2, middle);
    if (rest.slice(middle + 1) === `b/${left}`) return { oldPath: left, path: left };
  }
  const match = /^a\/(.*?) b\/(.*)$/.exec(rest);
  return match === null ? undefined : { oldPath: match[1] ?? "", path: match[2] ?? "" };
}

/**
 * The path of a `---` or `+++` line: `null` for the exact marker `/dev/null`,
 * else the decoded name without its `a/` or `b/` prefix. Git ends an unquoted
 * name that has a space with a tab, which is dropped here.
 */
function stripDevNull(path: string): string | null {
  const raw = path.endsWith("\t") ? path.slice(0, -1) : path;
  if (raw === "/dev/null") return null;
  return stripPrefix(decodePath(raw));
}

function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Re-exported so the route has one import for "compute a diff, and catch the
 * refusal it can throw". The class itself lives in `store.ts`, which owns the
 * disk limit.
 */
export { DiskLimitError };
