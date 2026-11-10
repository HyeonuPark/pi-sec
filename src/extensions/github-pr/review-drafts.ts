import { chmod, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../secrets/model-credentials.ts";
import { isSafeNamePart } from "./network.ts";

/**
 * The server's copy of a review that a reader collected on the diff page and did
 * not submit yet: one JSON file per pull request.
 *
 * The pull request is the unit of deletion, so it is the unit of storage. The
 * file name is `<owner>+<repo>+<number>.json` in lower case. `+` is allowed in
 * neither name part, so the name splits back into one owner, one repository and
 * one number, and two pull requests cannot share a file. Both parts are checked
 * again here with `isSafeNamePart`, and the final path must sit directly in the
 * drafts directory, so a name that the configuration schema should have refused
 * still touches no other file.
 *
 * Rules that hold for every change:
 *
 *   - One promise chain per pull request runs every change to its file, so two
 *     changes never overlap. Two pull requests run side by side.
 *   - The file is written with `writeFileAtomic`: a reader sees the old content
 *     or the new content.
 *   - A draft with no comment and an empty overall comment has no file.
 *   - Nothing here deletes a draft on a timer or after a list read. A file goes
 *     away when the reader submits the review, removes its last comment, or
 *     deletes it in the UI. A file that does not parse is set aside under a name
 *     of its own (`<name>.json.unreadable-<ms>`) and is never deleted here.
 *   - The list page can delete a draft or a set-aside file by the reader's
 *     request: `discard` and `discardSetAside`. `discard` refuses when the draft
 *     changed after the reader saw it.
 *   - Nothing here reaches GitHub, so the write switch does not guard it.
 */

export const MAX_COMMENTS = 500;
export const MAX_TEXT = 65536;
export const DRAFT_VERSION = 1;
const UNREADABLE = ".unreadable";
const FILE_NAME = /^([a-z0-9-]+)\+([a-z0-9._-]+)\+(\d{1,18})\.json$/;
/** A set-aside file: the old `.unreadable` name and the new `.unreadable-<epoch ms>` name. */
const SET_ASIDE_NAME = /^([a-z0-9-]+)\+([a-z0-9._-]+)\+(\d{1,18})\.json\.unreadable(?:-\d{1,16})?$/;

export type DraftSide = "LEFT" | "RIGHT";
export type DraftEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** The text of the first and the last line of a comment's range. */
export interface DraftAnchor {
  readonly first: string;
  readonly last: string;
}

export interface DraftComment {
  readonly id: string;
  readonly path: string;
  readonly side: DraftSide;
  readonly line: number;
  readonly startLine: number | null;
  readonly body: string;
  readonly headSha: string;
  readonly anchor: DraftAnchor | null;
  readonly createdAt: string;
}

export interface Draft {
  readonly version: number;
  readonly repo: string;
  readonly number: number;
  readonly listed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly summary: string;
  readonly event: DraftEvent;
  readonly comments: readonly DraftComment[];
}

/** One change of a draft, as the draft route names it. */
export type DraftOp =
  | { readonly op: "add"; readonly comment: DraftComment }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "set"; readonly summary?: string; readonly event?: DraftEvent }
  | { readonly op: "discard" };

/** A change the store refuses. The route answers it with 400. */
export class DraftInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftInputError";
  }
}

/** The pull request a change names. `repo` is the configured spelling. */
export interface DraftTarget {
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** The refusal of a delete because the draft changed after the reader saw it. The route answers 409. */
export class DraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftConflictError";
  }
}

/** One saved review as the list of saved reviews shows it. `repo` is the spelling stored in the draft. */
export interface StoredDraftEntry {
  readonly kind: "draft";
  readonly repo: string;
  readonly number: number;
  readonly comments: number;
  /** Whether the overall comment is not empty. */
  readonly summary: boolean;
  readonly event: DraftEvent;
  /** The `updatedAt` of the draft. */
  readonly savedAt: string;
}

/** A file that did not parse and was set aside. `repo` is the lower-case name from the file name. */
export interface StoredUnreadableEntry {
  readonly kind: "unreadable";
  readonly repo: string;
  readonly number: number;
  readonly file: string;
  /** The modification time of the file. */
  readonly savedAt: string;
}

export type StoredEntry = StoredDraftEntry | StoredUnreadableEntry;

export interface DraftLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ReviewDraftStoreOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly logger?: DraftLogger;
  /**
   * Called after a draft file was created or removed. An edit of an existing
   * draft does not call it.
   */
  readonly onChange?: () => void;
}

export interface ReviewDraftStore {
  get(target: DraftTarget): Promise<Draft>;
  /** Apply one change and answer the whole draft after it. */
  apply(target: DraftTarget, op: DraftOp): Promise<Draft>;
  /** Remove the submitted comments and the overall comment, after GitHub accepted the review. */
  removeSubmitted(target: DraftTarget, ids: readonly string[]): Promise<void>;
  /** Every saved review and every set-aside file, each read in its own pull request's queue. */
  list(): Promise<StoredEntry[]>;
  /**
   * Delete one draft by the reader's request. Resolves `false` when it is gone,
   * and rejects with {@link DraftConflictError} when its `updatedAt` is not `savedAt`.
   */
  discard(target: DraftTarget, savedAt: string): Promise<boolean>;
  /** Delete one set-aside file by the reader's request. Resolves `false` when it is gone. */
  discardSetAside(file: string): Promise<boolean>;
  /** Resolves when the start-up cleanup is done. */
  ready(): Promise<void>;
}

/**
 * A new draft. `listed` stays in the file and is always false in a new one:
 * nothing reads it any more, and an older build refuses a file without it as
 * unreadable, so a revert of this rule does not set new drafts aside.
 */
function emptyDraft(target: DraftTarget, at: string): Draft {
  return {
    version: DRAFT_VERSION,
    repo: target.repo,
    number: target.number,
    listed: false,
    createdAt: at,
    updatedAt: at,
    summary: "",
    event: "COMMENT",
    comments: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAnchor(value: unknown): DraftAnchor | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value["first"] !== "string" || typeof value["last"] !== "string") {
    throw new DraftInputError("anchor must be null or { first, last } of strings");
  }
  if (value["first"].length > MAX_TEXT || value["last"].length > MAX_TEXT) throw new DraftInputError("anchor text is too long");
  return { first: value["first"], last: value["last"] };
}

/** Read one comment from untrusted input. */
export function readComment(value: unknown, now: string): DraftComment {
  if (!isRecord(value)) throw new DraftInputError("comment must be an object");
  const id = value["id"];
  const path = value["path"];
  const side = value["side"];
  const line = value["line"];
  const startLine = value["startLine"] ?? null;
  const body = value["body"];
  const headSha = value["headSha"] ?? "";
  const createdAt = value["createdAt"];
  if (typeof id !== "string" || id === "" || id.length > 100) throw new DraftInputError("comment.id must be a string of 1 to 100 characters");
  if (typeof path !== "string" || path === "" || path.length > 4096) throw new DraftInputError("comment.path must be a string");
  if (side !== "LEFT" && side !== "RIGHT") throw new DraftInputError("comment.side must be LEFT or RIGHT");
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new DraftInputError("comment.line must be a positive integer");
  if (startLine !== null && (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1)) {
    throw new DraftInputError("comment.startLine must be null or a positive integer");
  }
  if (typeof body !== "string") throw new DraftInputError("comment.body must be a string");
  if (body.length > MAX_TEXT) throw new DraftInputError(`comment.body is over ${MAX_TEXT} characters`);
  if (typeof headSha !== "string" || headSha.length > 64) throw new DraftInputError("comment.headSha must be a string");
  return {
    id,
    path,
    side,
    line,
    startLine,
    body,
    headSha,
    anchor: readAnchor(value["anchor"]),
    createdAt: typeof createdAt === "string" && createdAt.length <= 40 ? createdAt : now,
  };
}

/** Read one op from untrusted input. */
export function readOp(value: unknown, now: string): DraftOp {
  if (!isRecord(value)) throw new DraftInputError("the body must be a JSON object");
  const op = value["op"];
  if (op === "add") return { op, comment: readComment(value["comment"], now) };
  if (op === "remove") {
    const id = value["id"];
    if (typeof id !== "string" || id === "") throw new DraftInputError("id must be a string");
    return { op, id };
  }
  if (op === "set") {
    const summary = value["summary"];
    const event = value["event"];
    if (summary === undefined && event === undefined) throw new DraftInputError("set needs summary, event, or both");
    if (summary !== undefined) {
      if (typeof summary !== "string") throw new DraftInputError("summary must be a string");
      if (summary.length > MAX_TEXT) throw new DraftInputError(`summary is over ${MAX_TEXT} characters`);
    }
    if (event !== undefined && event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") {
      throw new DraftInputError("event must be COMMENT, APPROVE or REQUEST_CHANGES");
    }
    return {
      op,
      ...(summary === undefined ? {} : { summary: summary as string }),
      ...(event === undefined ? {} : { event: event as DraftEvent }),
    };
  }
  if (op === "discard") return { op };
  throw new DraftInputError("op must be add, remove, set or discard");
}

/** Read a stored file's content, or `undefined` when it is not a draft. */
function readStored(text: string): Draft | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["version"] !== DRAFT_VERSION) return undefined;
  const comments = value["comments"];
  if (typeof value["repo"] !== "string" || typeof value["number"] !== "number" || !Array.isArray(comments)) return undefined;
  if (typeof value["summary"] !== "string" || typeof value["listed"] !== "boolean") return undefined;
  if (typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string") return undefined;
  const event = value["event"];
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") return undefined;
  try {
    const read = comments.map((item) => readComment(item, value["createdAt"] as string));
    return {
      version: DRAFT_VERSION,
      repo: value["repo"],
      number: value["number"],
      listed: value["listed"],
      createdAt: value["createdAt"],
      updatedAt: value["updatedAt"],
      summary: value["summary"],
      event,
      comments: read,
    };
  } catch {
    return undefined;
  }
}

export function createReviewDraftStore(options: ReviewDraftStoreOptions): ReviewDraftStore {
  const dir = resolve(options.dir);
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const changed = (): void => {
    try {
      options.onChange?.();
    } catch (error) {
      logger?.warn("github-pr draft change callback failed", { error });
    }
  };
  const iso = (): string => new Date(now()).toISOString();

  const queues = new Map<string, Promise<unknown>>();
  /** Run `work` after every earlier change to the same pull request. */
  const enqueue = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };

  let directoryReady: Promise<void> | undefined;
  /** Make the directory and delete leftover temporary files, once. */
  const ensure = (): Promise<void> => {
    directoryReady ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => undefined);
      for (const name of await readdir(dir)) {
        if (name.startsWith(".") && name.includes(".tmp-")) await unlink(join(dir, name)).catch(() => undefined);
      }
    })();
    directoryReady.catch(() => {
      directoryReady = undefined;
    });
    return directoryReady;
  };

  const keyOf = (target: DraftTarget): { key: string; path: string } => {
    const owner = target.owner.toLowerCase();
    const repo = target.name.toLowerCase();
    if (!isSafeNamePart(owner) || !isSafeNamePart(repo) || owner.includes("+") || repo.includes("+")) {
      throw new DraftInputError("the repository name is not safe to use as a file name");
    }
    if (!Number.isSafeInteger(target.number) || target.number < 1) throw new DraftInputError("the pull request number is not valid");
    const key = `${owner}+${repo}+${target.number}`;
    const path = resolve(dir, `${key}.json`);
    if (resolve(path, "..") !== dir) throw new DraftInputError("the draft path leaves the drafts directory");
    return { key, path };
  };

  const load = async (path: string): Promise<Draft | undefined> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const draft = readStored(text);
    if (draft !== undefined) return draft;
    const aside = `${path}${UNREADABLE}-${now()}`;
    await rename(path, aside).catch(() => undefined);
    logger?.warn("github-pr draft file is not readable and was set aside", { file: aside.split("/").pop() ?? "" });
    return undefined;
  };

  const save = async (path: string, draft: Draft): Promise<void> => {
    await writeFileAtomic(path, `${JSON.stringify(draft)}\n`);
  };
  const remove = async (path: string): Promise<void> => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  const isEmpty = (draft: Draft): boolean => draft.comments.length === 0 && draft.summary === "";

  const apply = async (target: DraftTarget, change: DraftOp): Promise<Draft> => {
    const { key, path } = keyOf(target);
    await ensure();
    return await enqueue(key, async () => {
      const stored = await load(path);
      const at = iso();
      const base = stored ?? emptyDraft(target, at);
      if (change.op === "discard") {
        await remove(path);
        if (stored !== undefined) changed();
        return emptyDraft(target, at);
      }
      let next: Draft = base;
      if (change.op === "add") {
        if (base.comments.some((c) => c.id === change.comment.id)) return base;
        if (base.comments.length >= MAX_COMMENTS) throw new DraftInputError(`a draft holds at most ${MAX_COMMENTS} comments`);
        next = { ...base, comments: [...base.comments, change.comment] };
      } else if (change.op === "remove") {
        if (!base.comments.some((c) => c.id === change.id)) return base;
        next = { ...base, comments: base.comments.filter((c) => c.id !== change.id) };
      } else {
        next = {
          ...base,
          summary: change.summary ?? base.summary,
          event: change.event ?? base.event,
        };
      }
      next = { ...next, updatedAt: at };
      if (isEmpty(next)) {
        await remove(path);
        if (stored !== undefined) changed();
        return next;
      }
      await save(path, next);
      if (stored === undefined) changed();
      return next;
    });
  };

  return {
    ready: ensure,
    async get(target) {
      const { key, path } = keyOf(target);
      await ensure();
      return await enqueue(key, async () => (await load(path)) ?? emptyDraft(target, iso()));
    },
    apply,
    async removeSubmitted(target, ids) {
      const { key, path } = keyOf(target);
      await ensure();
      await enqueue(key, async () => {
        const draft = await load(path);
        if (draft === undefined) return;
        const gone = new Set(ids);
        const next: Draft = { ...draft, summary: "", comments: draft.comments.filter((c) => !gone.has(c.id)), updatedAt: iso() };
        if (isEmpty(next)) {
          await remove(path);
          changed();
        } else await save(path, next);
      });
    },
    async list() {
      await ensure();
      const entries: StoredEntry[] = [];
      for (const name of await readdir(dir)) {
        const match = FILE_NAME.exec(name);
        if (match === null) continue;
        const number = Number.parseInt(match[3] ?? "", 10);
        const path = join(dir, name);
        // A file that does not parse is set aside by `load`, and shows below.
        const draft = await enqueue(`${match[1]}+${match[2]}+${number}`, () => load(path)).catch(() => undefined);
        if (draft === undefined) continue;
        entries.push({
          kind: "draft",
          repo: draft.repo,
          number: draft.number,
          comments: draft.comments.length,
          summary: draft.summary !== "",
          event: draft.event,
          savedAt: draft.updatedAt,
        });
      }
      for (const name of await readdir(dir)) {
        const match = SET_ASIDE_NAME.exec(name);
        if (match === null) continue;
        const info = await stat(join(dir, name)).catch(() => undefined);
        if (info === undefined) continue;
        entries.push({
          kind: "unreadable",
          repo: `${match[1]}/${match[2]}`,
          number: Number.parseInt(match[3] ?? "", 10),
          file: name,
          savedAt: new Date(info.mtimeMs).toISOString(),
        });
      }
      return entries;
    },
    async discard(target, savedAt) {
      const { key, path } = keyOf(target);
      await ensure();
      return await enqueue(key, async () => {
        const draft = await load(path);
        if (draft === undefined) return false;
        if (draft.updatedAt !== savedAt) {
          throw new DraftConflictError("The saved review changed after this list showed it. Reload the list and try again.");
        }
        await remove(path);
        logger?.info("github-pr draft deleted", {
          repo: draft.repo,
          number: draft.number,
          reason: "deleted on the list page",
          comments: draft.comments.length,
        });
        changed();
        return true;
      });
    },
    async discardSetAside(file) {
      const match = SET_ASIDE_NAME.exec(file);
      if (match === null || resolve(dir, file, "..") !== dir) throw new DraftInputError("file is not the name of a set-aside saved review");
      await ensure();
      const number = Number.parseInt(match[3] ?? "", 10);
      return await enqueue(`${match[1]}+${match[2]}+${number}`, async () => {
        const path = join(dir, file);
        const info = await stat(path).catch(() => undefined);
        if (info === undefined) return false;
        await remove(path);
        logger?.info("github-pr draft deleted", {
          repo: `${match[1]}/${match[2]}`,
          number,
          reason: "deleted on the list page",
          file,
        });
        changed();
        return true;
      });
    },
  };
}
