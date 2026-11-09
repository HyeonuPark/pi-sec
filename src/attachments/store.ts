import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type Harness, type Storage } from "@earendil-works/pi-durable";
import { defaultConfig, type Config } from "../config/schema.ts";
import type { AuditLog } from "../runtime/audit.ts";
import { isUlid, ulid } from "../runtime/ids.ts";
import { expandPath } from "../runtime/paths.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";
import { imageFormatOf } from "./image-size.ts";

/**
 * Where the two kinds of file live.
 *
 * The locations are configuration (`attachments.dir` and `attachments.shareDir`)
 * and nothing here spells one out. Both are absolute once resolved: a relative
 * `state/...` path would resolve against the agent's working directory, which is
 * the workspace tree, and nothing this store writes may land there.
 *
 * They resolve against the run account's home (`$HOME`), not the pi-sec home:
 * `~/attachments` means the operator's attachments directory whatever
 * `PI_SEC_HOME` says.
 */
export function attachmentRootsFrom(spec: { dir: string; shareDir: string }): AttachmentRoots {
  const home = process.env.HOME ?? homedir();
  return {
    attachments: expandPath(spec.dir, process.cwd(), home),
    share: expandPath(spec.shareDir, process.cwd(), home),
  };
}

/** The roots the built-in defaults name, resolved. The last fallback there is. */
export function defaultAttachmentRoots(): AttachmentRoots {
  return attachmentRootsFrom(defaultConfig().attachments);
}

/** How long an attachment may stay unowned before the sweep removes it. */
export const UNOWNED_GRACE_MS = 24 * 60 * 60 * 1000;

/** An operator upload (`sec.attachment`) or a file an agent published (`sec.share`). */
export type AttachmentKind = "attachment" | "share";

/**
 * One stored file.
 *
 * A `type` and not an `interface`: the document store takes a JSON object, and
 * only a type alias gets the implicit index signature that satisfies it.
 *
 * The bytes are never in here. `storagePath` is the only place the content
 * lives, and `readAttachmentBytes` is the only reader: an attachment is
 * immutable, so the same path yields the same bytes, which is what keeps the
 * model request prefix stable turn after turn.
 */
export type AttachmentRecord = {
  readonly id: string;
  readonly kind: AttachmentKind;
  /**
   * The name the operator or the agent gave it. For a share this is the served
   * name; for an attachment it is the label, and it seeds the disk name without
   * ever reaching a path as given.
   */
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Pixel size, when the file is an image this runtime could measure. */
  readonly w?: number;
  readonly h?: number;
  readonly collectedAt: number;
  readonly storagePath: string;
  /** The job that owns it. Absent while it is unowned. */
  readonly jobId?: string;
  readonly conversationId?: string;
  /**
   * Set only by `share_page`. The page route serves a share row only when this
   * is true, so an HTML file that arrived another way stays a download.
   */
  readonly richPage?: boolean;
  /** Set only by `share_page`: the title as given, which the shell page shows. */
  readonly title?: string;
};

export interface CreateAttachmentInput {
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mime: string;
  readonly data: Buffer;
  readonly w?: number;
  readonly h?: number;
  readonly jobId?: string;
  readonly conversationId?: string;
  /** Mark the row as a rich page (`share_page` only). */
  readonly richPage?: boolean;
  /** The title of a rich page as given (`share_page` only). */
  readonly title?: string;
}

/** The two storage roots, which a test may point somewhere else. */
export interface AttachmentRoots {
  readonly attachments: string;
  readonly share: string;
}

/** The one thing this store needs from the live job registry. */
export interface LiveJobLookup {
  get(context: Context, id: string): Promise<{ readonly id: string } | undefined>;
}

/**
 * What every function here needs from its caller.
 *
 * `ExtensionContext` satisfies this as it stands, so an extension or a route can
 * pass its own context unchanged. A test builds the same shape by hand, which
 * is also how it points `roots` at a temporary directory instead of the real
 * ones: the configured locations are the default and never the only option.
 */
export interface AttachmentContext {
  readonly storage: Storage;
  /** Absent before the runtime wires it. */
  readonly harness?: Harness;
  readonly audit?: AuditLog;
  /**
   * The Chord context for the storage reads and commits.
   *
   * Defaults to the background one, which is what an upload route and the boot
   * sweep have. A caller inside a tool may pass its own so a cancelled request
   * cancels the commit with it.
   */
  readonly context?: Context;
  /** Override the storage roots. Tests use this; production does not. */
  readonly roots?: { readonly attachments?: string; readonly share?: string };
  /**
   * The live configuration, when the caller has one.
   *
   * `ExtensionContext` satisfies this as it stands. A context that cannot read
   * the config falls back to the built-in defaults, which name the same two
   * directories a config that mentions neither would.
   */
  readonly getConfig?: () => Pick<Config, "attachments">;
  /** Live job lookups for `assignAttachments`. */
  readonly jobs?: LiveJobLookup;
}

/** Stored kind strings. Spelled here because `src/documents.ts` is not edited by this stream. */
export const ATTACHMENT_DOC_KIND = "sec.attachment";
export const SHARE_DOC_KIND = "sec.share";

function emptyRecord(id: string, kind: AttachmentKind): AttachmentRecord {
  return { id, kind, name: "", mime: "", bytes: 0, sha256: "", collectedAt: 0, storagePath: "" };
}

/** An operator upload: one directory per file, so a name can never escape it. */
export const SecAttachment = defineDocFamily<AttachmentRecord, string>({
  kind: ATTACHMENT_DOC_KIND,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => emptyRecord(id, "attachment"),
});

/** A file an agent published under the share root. */
export const SecShare = defineDocFamily<AttachmentRecord, string>({
  kind: SHARE_DOC_KIND,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: (id) => emptyRecord(id, "share"),
});

const DOC_KIND_BY_KIND: Readonly<Record<AttachmentKind, string>> = {
  attachment: ATTACHMENT_DOC_KIND,
  share: SHARE_DOC_KIND,
};

function requireHarness(ctx: AttachmentContext): Harness {
  if (ctx.harness === undefined) throw new Error("the harness is not available yet");
  return ctx.harness;
}

function chordContext(ctx: AttachmentContext): Context {
  return ctx.context ?? BACKGROUND_CONTEXT;
}

/**
 * The two roots: the caller's override, else the configured ones, else the
 * built-in defaults resolved.
 *
 * There is no fixed path under this. Every reader of the roots goes through this
 * function, so a configured directory reaches the store, the two routes and the
 * tools by one road.
 */
export function resolveRoots(ctx: AttachmentContext): AttachmentRoots {
  const config = ctx.getConfig?.();
  const base = config === undefined ? defaultAttachmentRoots() : attachmentRootsFrom(config.attachments);
  return {
    attachments: ctx.roots?.attachments ?? base.attachments,
    share: ctx.roots?.share ?? base.share,
  };
}

function normalizeMime(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return base === "" ? "application/octet-stream" : base;
}

const EXT_BY_FORMAT: Readonly<Record<string, string>> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};

/**
 * The file extension for a stored file.
 *
 * Taken from the MIME when it names an image this store understands, and from
 * the supplied name otherwise. Never from the raw name alone: the extension goes
 * into a path and the name came from the network.
 *
 * `fallback` is what an extensionless name gets. An operator upload passes `txt`
 * for text, because the agent opens that file with `read` and the extension is
 * the only hint on disk about what the bytes are. A share keeps `bin`: its URL
 * carries the name, so changing the fallback there would move a served URL.
 */
function extensionFor(mime: string, name: string, fallback: "bin" | "txt" = "bin"): string {
  const format = imageFormatOf(mime);
  const byMime = format === undefined ? "" : (EXT_BY_FORMAT[format] ?? "");
  if (byMime !== "") return byMime;
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? fallback;
}

/**
 * A share file name that is safe to concatenate with the share root.
 *
 * One segment, no leading dot, and a restricted alphabet. The result is what the
 * file is called on disk and what the served URL carries, so the two cannot say
 * different things.
 */
export function shareNameFor(name: string, fallback: string, ext: string): string {
  const base = basename(name.trim()).replace(/[^A-Za-z0-9._-]+/g, "-");
  const stripped = base.replace(/^[.-]+/, "").replace(/-+/g, "-");
  const filled = stripped === "" ? `${fallback}.${ext}` : stripped;
  const withExt = /\.[A-Za-z0-9]{1,8}$/.test(filled) ? filled : `${filled}.${ext}`;
  return withExt.slice(0, 120);
}

/** Write the bytes and nothing else: 0600 on the file, 0700 on its directory. */
async function writeBytesAtomic(path: string, data: Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  return await writeAtomic(path, data);
}

/**
 * A temporary file in the same directory, renamed into place.
 *
 * Same directory, because `rename` is only atomic within one filesystem. The
 * temporary name starts with a dot and is never an index row, so a crash leaves
 * it for the sweep to report rather than a half-written body under a real name.
 */
async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(path), `.tmp-${ulid()}`);
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** A share name not already taken by another file in the same root. */
async function uniqueShareName(root: string, desired: string): Promise<string> {
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = attempt === 0 ? desired : `${stem}-${ulid().slice(-6).toLowerCase()}${ext}`;
    if (!(await exists(join(root, candidate)))) return candidate;
  }
  return `${stem}-${ulid().toLowerCase()}${ext}`;
}

function snapshotOf(ctx: AttachmentContext, kind: AttachmentKind, id: string): Promise<Readonly<AttachmentRecord> | undefined> {
  const harness = requireHarness(ctx);
  const context = chordContext(ctx);
  if (kind === "attachment") return harness.snapshot(SecAttachment, id, context);
  return harness.snapshot(SecShare, id, context);
}

/**
 * Store one file and index it.
 *
 * The bytes are written before the row, so a crash between them leaves a file
 * the sweep reports as an orphan rather than a row nobody can read.
 */
export async function createAttachment(
  ctx: AttachmentContext,
  input: CreateAttachmentInput,
): Promise<AttachmentRecord> {
  const harness = requireHarness(ctx);
  const roots = resolveRoots(ctx);
  const id = ulid();
  const mime = normalizeMime(input.mime);
  const fallbackExt = input.kind === "attachment" && mime === "text/plain" ? "txt" : "bin";
  const ext = extensionFor(mime, input.name, fallbackExt);
  let servedName = input.name;
  let storagePath: string;
  if (input.kind === "share") {
    servedName = await uniqueShareName(roots.share, shareNameFor(input.name, id, ext));
    storagePath = join(roots.share, servedName);
    await writeBytesAtomic(storagePath, input.data);
  } else {
    // The disk name carries the original name, so an agent can find the file with
    // `ls` instead of reading the index. `shareNameFor` is what makes that name
    // safe: one segment, no leading dot, `[A-Za-z0-9._-]` only, cut at 120. The
    // directory is a fresh ULID, so nothing collides and nothing is overwritten.
    // A name nothing survives from falls back to `<id>.<ext>`, and the original
    // name stays in `record.name` for the download header.
    storagePath = join(roots.attachments, id, shareNameFor(input.name, id, ext));
    await writeBytesAtomic(storagePath, input.data);
  }
  const record: AttachmentRecord = {
    id,
    kind: input.kind,
    name: servedName,
    mime,
    bytes: input.data.byteLength,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    ...(input.w === undefined || input.h === undefined ? {} : { w: input.w, h: input.h }),
    collectedAt: Date.now(),
    storagePath,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.richPage === true ? { richPage: true } : {}),
    ...(input.title === undefined ? {} : { title: input.title }),
  };
  const token = input.kind === "attachment" ? SecAttachment : SecShare;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(token, id, id);
    doc.id = id;
    doc.kind = record.kind;
    doc.name = record.name;
    doc.mime = record.mime;
    doc.bytes = record.bytes;
    doc.sha256 = record.sha256;
    if (record.w !== undefined) doc.w = record.w;
    if (record.h !== undefined) doc.h = record.h;
    doc.collectedAt = record.collectedAt;
    doc.storagePath = record.storagePath;
    if (record.jobId !== undefined) doc.jobId = record.jobId;
    if (record.conversationId !== undefined) doc.conversationId = record.conversationId;
    if (record.richPage === true) doc.richPage = true;
    if (record.title !== undefined) doc.title = record.title;
  }, chordContext(ctx));
  return record;
}

/** One record by id, whichever of the two families holds it. */
export async function getAttachment(
  ctx: AttachmentContext,
  id: string,
): Promise<AttachmentRecord | undefined> {
  if (!isUlid(id)) return undefined;
  const attachment = await snapshotOf(ctx, "attachment", id);
  if (attachment !== undefined) return attachment;
  return await snapshotOf(ctx, "share", id);
}

/** Every indexed file, newest last, filtered by the ownership fields. */
export async function listAttachments(
  ctx: AttachmentContext,
  filter: { jobId?: string; conversationId?: string } = {},
): Promise<AttachmentRecord[]> {
  const harness = requireHarness(ctx);
  const context = chordContext(ctx);
  const found: AttachmentRecord[] = [];
  for (const kind of ["attachment", "share"] as const) {
    const token = kind === "attachment" ? SecAttachment : SecShare;
    for (const key of await scanDocumentKeys(ctx.storage, DOC_KIND_BY_KIND[kind], context)) {
      const record = await harness.snapshot(token, key, context);
      if (record === undefined) continue;
      if (filter.jobId !== undefined && record.jobId !== filter.jobId) continue;
      if (filter.conversationId !== undefined && record.conversationId !== filter.conversationId) continue;
      found.push(record);
    }
  }
  return found.sort((a, b) => a.collectedAt - b.collectedAt);
}

/** The bytes on disk. There is no other reader of an attachment body. */
export async function readAttachmentBytes(record: AttachmentRecord): Promise<Buffer> {
  return await readFile(record.storagePath);
}

/** Why an assignment was refused. These strings are part of the tool contract. */
export type AssignmentRefusalReason = "missing" | "job-missing" | "bad-id" | "owned-by-other" | "empty";

export interface AssignmentResult {
  readonly assigned: string[];
  readonly refused: { id: string; reason: AssignmentRefusalReason }[];
}

/**
 * Give unowned files to a job.
 *
 * Every refusal says which rule stopped it, because the root reads this result
 * back to the operator: "no such attachment" and "someone else's" are different
 * answers and the caller cannot tell them apart from a count.
 */
export async function assignAttachments(
  ctx: AttachmentContext,
  ids: readonly string[],
  jobId: string,
): Promise<AssignmentResult> {
  if (ids.length === 0) return { assigned: [], refused: [{ id: "", reason: "empty" }] };
  const harness = requireHarness(ctx);
  const assigned: string[] = [];
  const refused: { id: string; reason: AssignmentRefusalReason }[] = [];
  const job = await ctx.jobs?.get(chordContext(ctx), jobId);
  for (const id of ids) {
    if (!isUlid(id)) {
      refused.push({ id, reason: "bad-id" });
      continue;
    }
    if (ctx.jobs !== undefined && job === undefined) {
      refused.push({ id, reason: "job-missing" });
      continue;
    }
    const record = await getAttachment(ctx, id);
    if (record === undefined) {
      refused.push({ id, reason: "missing" });
      continue;
    }
    if (record.jobId !== undefined && record.jobId !== jobId) {
      refused.push({ id, reason: "owned-by-other" });
      continue;
    }
    if (record.jobId === jobId) {
      assigned.push(id);
      continue;
    }
    const token = record.kind === "attachment" ? SecAttachment : SecShare;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(token, id, id);
      doc.jobId = jobId;
    }, chordContext(ctx));
    assigned.push(id);
  }
  return { assigned, refused };
}

/** What the sweep did, by reason. */
export interface SweepResult {
  readonly dropped: number;
  readonly orphanFiles: number;
}

function recordAudit(ctx: AttachmentContext, record: AttachmentRecord, reason: string): void {
  ctx.audit?.append({
    type: "attachment_disposed",
    attachmentId: record.id,
    kind: record.kind,
    name: record.name,
    fileName: basename(record.storagePath),
    bytes: record.bytes,
    reason,
    ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
  });
}

/**
 * Retire one row and its file, and record why.
 *
 * The row goes first: a crash between the two deletes leaves a file the sweep
 * reports as an orphan, which is readable evidence, rather than a row pointing
 * at nothing. The audit entry is the only surviving trace of either.
 */
async function dispose(ctx: AttachmentContext, record: AttachmentRecord, reason: string): Promise<void> {
  const harness = requireHarness(ctx);
  const token = record.kind === "attachment" ? SecAttachment : SecShare;
  await harness.commit(async (tx) => {
    await tx.retireDoc(token, record.id);
  }, chordContext(ctx));
  // An attachment owns its whole directory; a share file is one file in a shared
  // root and only that file may go.
  const target = record.kind === "attachment" ? dirname(record.storagePath) : record.storagePath;
  await rm(target, { recursive: record.kind === "attachment", force: true });
  recordAudit(ctx, record, reason);
}

/** Attachment directories are named by ULID, so anything else is not ours. */
function looksLikeOurs(entry: string): boolean {
  return isUlid(entry);
}

/**
 * Remove files nobody indexes, under the attachment root.
 *
 * Only ULID-named directories and ULID-named files are candidates: a stray file
 * somebody else put in the root is left alone and not counted, because deleting
 * what this store did not create would be worse than the leak.
 */
async function orphanAttachmentFiles(ctx: AttachmentContext, known: ReadonlySet<string>): Promise<number> {
  const roots = resolveRoots(ctx);
  const entries = await readdir(roots.attachments, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const path = join(roots.attachments, entry.name);
    if (entry.isDirectory()) {
      if (!looksLikeOurs(entry.name)) continue;
      const inside = await readdir(path).catch(() => [] as string[]);
      const live = inside.filter((file) => known.has(join(path, file)));
      if (live.length === 0) {
        await rm(path, { recursive: true, force: true });
        for (const file of inside) {
          ctx.audit?.append({ type: "attachment_orphan_removed", fileName: file, kind: "attachment", path });
        }
        removed += Math.max(inside.length, 1);
        continue;
      }
      // A row still owns this directory, so the directory stays; anything beside
      // the indexed body is a leftover write that never reached its rename.
      for (const file of inside) {
        if (known.has(join(path, file))) continue;
        await rm(join(path, file), { force: true });
        ctx.audit?.append({
          type: "attachment_orphan_removed",
          fileName: file,
          kind: "attachment",
          path: join(path, file),
        });
        removed += 1;
      }
      continue;
    }
    if (!looksLikeOurs(entry.name.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (known.has(path)) continue;
    await rm(path, { force: true });
    ctx.audit?.append({ type: "attachment_orphan_removed", fileName: entry.name, kind: "attachment", path });
    removed += 1;
  }
  return removed;
}

/**
 * Remove files nobody indexes, under the share root.
 *
 * A share row names one file in a flat root, so the check is membership in the
 * index and nothing else. Read this together with the sweep's caller: while
 * another writer (a runtime extension whose directory is configured separately)
 * points at this root, its files have no index row here.
 */
async function orphanShareFiles(ctx: AttachmentContext, known: ReadonlySet<string>): Promise<number> {
  const roots = resolveRoots(ctx);
  const entries = await readdir(roots.share, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const path = join(roots.share, entry.name);
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (known.has(path)) continue;
    await rm(path, { force: true });
    ctx.audit?.append({ type: "attachment_orphan_removed", fileName: entry.name, kind: "share", path });
    removed += 1;
  }
  return removed;
}

/**
 * The boot sweep: rows whose file is gone, unowned rows past the grace, and
 * files no row names.
 *
 * A row with an owner job is kept, also when the job has left the live store:
 * nothing here deletes a file because of its job. Only a row with no owner job
 * is temporary, and it goes once it is `UNOWNED_GRACE_MS` old.
 */
export async function sweep(ctx: AttachmentContext): Promise<SweepResult> {
  const now = Date.now();
  const records = await listAttachments(ctx);
  const known = new Set<string>();
  let dropped = 0;
  for (const record of records) {
    const present = await exists(record.storagePath);
    if (!present) {
      await dispose(ctx, record, "body-file-missing");
      dropped += 1;
      continue;
    }
    if (record.jobId === undefined && now - record.collectedAt >= UNOWNED_GRACE_MS) {
      await dispose(ctx, record, "unowned");
      dropped += 1;
      continue;
    }
    known.add(record.storagePath);
  }
  const orphanFiles =
    (await orphanAttachmentFiles(ctx, known)) + (await orphanShareFiles(ctx, known));
  return { dropped, orphanFiles };
}
