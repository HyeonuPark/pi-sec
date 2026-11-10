import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readImageSize, sniffImageFormat, imageFormatOf } from "../src/attachments/image-size.ts";
import {
  SecAttachment,
  SecShare,
  UNOWNED_GRACE_MS,
  assignAttachments,
  createAttachment,
  getAttachment,
  listAttachments,
  readAttachmentBytes,
  resolveRoots,
  shareNameFor,
  sweep,
  type AttachmentContext,
  type AttachmentRoots,
  type LiveJobLookup,
} from "../src/attachments/store.ts";
import { sweepAttachments } from "../src/attachments/sweep.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import { ulid } from "../src/runtime/ids.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Header fixtures: the smallest buffer each reader accepts, built by hand so a
// failure names the parser rather than a fixture library.
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // colour type
  return buf;
}

function gifBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF", 4, "latin1");
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

/** The extended container: canvas size in three bytes each, stored minus one. */
function webpVp8xBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUInt32LE(10, 16);
  const write24 = (at: number, value: number): void => {
    buf[at] = value & 0xff;
    buf[at + 1] = (value >> 8) & 0xff;
    buf[at + 2] = (value >> 16) & 0xff;
  };
  write24(24, width - 1);
  write24(27, height - 1);
  return buf;
}

function webpLossyBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8 ", 12, "latin1");
  buf.writeUInt32LE(10, 16);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

function webpLosslessBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(25);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(17, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf.writeUInt32LE(5, 16);
  buf[20] = 0x2f;
  buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return buf;
}

describe("image header size", () => {
  it("reads the PNG IHDR", () => {
    expect(readImageSize(pngBytes(1920, 1080), "image/png")).toEqual({ width: 1920, height: 1080 });
  });

  it("reads the GIF logical screen descriptor", () => {
    expect(readImageSize(gifBytes(400, 300), "image/gif")).toEqual({ width: 400, height: 300 });
  });

  it("reads a JPEG frame header after an application segment", () => {
    expect(readImageSize(jpegBytes(1280, 720), "image/jpeg")).toEqual({ width: 1280, height: 720 });
  });

  it("reads all three WebP payloads", () => {
    const size = { width: 1920, height: 1080 };
    expect(readImageSize(webpVp8xBytes(1920, 1080), "image/webp")).toEqual(size);
    expect(readImageSize(webpLossyBytes(1920, 1080), "image/webp")).toEqual(size);
    expect(readImageSize(webpLosslessBytes(1920, 1080), "image/webp")).toEqual(size);
  });

  it("reads the size the refuse decision needs, above FHD as well as below", () => {
    // The upload route compares these two numbers with 1920x1080, so both sides of
    // the boundary have to come out of the header and not out of a guess.
    expect(readImageSize(pngBytes(3840, 2160), "image/png")).toEqual({ width: 3840, height: 2160 });
    expect(readImageSize(jpegBytes(1921, 1080), "image/jpeg")).toEqual({ width: 1921, height: 1080 });
    expect(readImageSize(gifBytes(65535, 65535), "image/gif")).toEqual({ width: 65535, height: 65535 });
  });

  it("returns undefined for a body it cannot read", () => {
    expect(readImageSize(Buffer.from("not an image at all"), "image/png")).toBeUndefined();
    // Declared a PNG and it is a GIF: the signature decides, not the header name.
    expect(readImageSize(gifBytes(10, 10), "image/png")).toBeUndefined();
    // An unknown MIME falls back to the signature, which is what saves a PNG sent
    // as `application/octet-stream`.
    expect(readImageSize(pngBytes(10, 10), "application/pdf")).toEqual({ width: 10, height: 10 });
    // A truncated PNG keeps its signature and loses its IHDR.
    expect(readImageSize(pngBytes(10, 10).subarray(0, 20), "image/png")).toBeUndefined();
    // A zero dimension is not a size a viewer can lay out.
    expect(readImageSize(pngBytes(0, 10), "image/png")).toBeUndefined();
    expect(readImageSize(Buffer.alloc(0), "image/webp")).toBeUndefined();
  });

  it("falls back to the signature when the MIME names nothing useful", () => {
    expect(imageFormatOf("image/JPEG; charset=binary")).toBe("jpeg");
    expect(imageFormatOf("image/jpg")).toBe("jpeg");
    expect(imageFormatOf("application/octet-stream")).toBeUndefined();
    expect(sniffImageFormat(pngBytes(1, 1))).toBe("png");
    expect(sniffImageFormat(webpVp8xBytes(1, 1))).toBe("webp");
    expect(readImageSize(pngBytes(64, 48), "")).toEqual({ width: 64, height: 48 });
  });
});

// ---------------------------------------------------------------------------
// Store fixtures: real files under a temporary root, index rows in the harness.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly h: TestHarness;
  readonly roots: AttachmentRoots;
  ctx(jobs?: LiveJobLookup): AttachmentContext;
}

let open: Fixture | undefined;

afterEach(async () => {
  await open?.h.close();
  if (open !== undefined) {
    await rm(open.roots.attachments, { recursive: true, force: true });
    await rm(open.roots.share, { recursive: true, force: true });
  }
  open = undefined;
});

async function boot(): Promise<Fixture> {
  const h = await createTestHarness();
  const base = await mkdtemp(join(tmpdir(), "pi-sec-attachments-"));
  const roots: AttachmentRoots = {
    attachments: join(base, "attachments"),
    share: join(base, "share"),
  };
  await mkdir(roots.attachments, { recursive: true, mode: 0o700 });
  await mkdir(roots.share, { recursive: true, mode: 0o700 });
  const fixture: Fixture = {
    h,
    roots,
    ctx: (jobs) => ({
      storage: h.runtime.storage,
      harness: h.runtime.harness,
      audit: h.runtime.audit,
      roots,
      ...(jobs === undefined ? {} : { jobs }),
    }),
  };
  open = fixture;
  return fixture;
}

/** A job lookup that knows exactly the ids it was given. */
function liveJobs(ids: readonly string[]): LiveJobLookup {
  const known = new Set(ids);
  return {
    get: async (_context, id) => (known.has(id) ? { id } : undefined),
  };
}

function auditEvents(h: TestHarness): Promise<AuditEvent[]> {
  return readAuditTail(h.paths.auditLog, undefined, 200);
}

describe("attachment store", () => {
  it("round-trips the bytes, the hash, the size and the MIME", async () => {
    const f = await boot();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "screenshot.png",
      mime: "image/PNG; charset=binary",
      data,
      w: 1920,
      h: 1080,
      conversationId: "conv-1",
    });

    expect(record.mime).toBe("image/png");
    expect(record.bytes).toBe(data.byteLength);
    expect(record.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(record.w).toBe(1920);
    expect(record.h).toBe(1080);
    expect(record.jobId).toBeUndefined();
    expect(record.storagePath).toBe(join(f.roots.attachments, record.id, "screenshot.png"));

    const read = await getAttachment(f.ctx(), record.id);
    expect(read).toEqual(record);
    expect(await readAttachmentBytes(read!)).toEqual(data);
    expect(await listAttachments(f.ctx(), { conversationId: "conv-1" })).toEqual([record]);
    expect(await listAttachments(f.ctx(), { conversationId: "other" })).toEqual([]);
    expect(await listAttachments(f.ctx())).toHaveLength(1);
  });

  it("keeps the original name as metadata and not as a path", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "../../escape attempt.bin",
      mime: "application/pdf",
      data: Buffer.from("x"),
    });
    expect(record.name).toBe("../../escape attempt.bin");
    expect(record.storagePath).toBe(join(f.roots.attachments, record.id, "escape-attempt.bin"));
    expect(record.storagePath.startsWith(f.roots.attachments)).toBe(true);
  });

  it("writes a private directory and a private file, with no temporary left behind", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.txt",
      mime: "text/plain",
      data: Buffer.from("hello"),
    });
    const dir = await stat(join(f.roots.attachments, record.id));
    const file = await stat(record.storagePath);
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    expect(await readdir(join(f.roots.attachments, record.id))).toEqual(["a.txt"]);
  });

  it("publishes a share under the share root, with a name safe to serve", async () => {
    const f = await boot();
    const data = pngBytes(32, 24);
    const record = await createAttachment(f.ctx(), {
      kind: "share",
      name: "../../my shot!.png",
      mime: "image/png",
      data,
      w: 32,
      h: 24,
    });
    expect(record.name).toBe("my-shot-.png");
    expect(record.storagePath).toBe(join(f.roots.share, "my-shot-.png"));
    expect(await readAttachmentBytes(record)).toEqual(data);

    // A second file under the same name may not overwrite the first: both are
    // served by name, so two rows would otherwise point at one body.
    const second = await createAttachment(f.ctx(), {
      kind: "share",
      name: "my shot!.png",
      mime: "image/png",
      data: Buffer.from("different"),
    });
    expect(second.name).not.toBe(record.name);
    expect(await readAttachmentBytes(record)).toEqual(data);
    expect((await listAttachments(f.ctx())).map((each) => each.kind)).toEqual(["share", "share"]);
  });

  it("builds a share name with no separator and no leading dot", () => {
    expect(shareNameFor("/etc/passwd", "id", "bin")).toBe("passwd.bin");
    expect(shareNameFor("..", "id", "png")).toBe("id.png");
    expect(shareNameFor("shot one.png", "id", "png")).toBe("shot-one.png");
    expect(shareNameFor("", "id", "png")).toBe("id.png");
  });

  it("resolves the default roots under the run account's home", async () => {
    // No `attachments` in the config: the built-in defaults are `~/attachments`
    // and `~/share`, and `~` is the account running the daemon, so the same
    // install keeps its two directories wherever `PI_SEC_HOME` points.
    const accountHome = await mkdtemp(join(tmpdir(), "pi-sec-account-"));
    vi.stubEnv("HOME", accountHome);
    try {
      const bare = { storage: undefined as never };
      expect(resolveRoots(bare)).toEqual({
        attachments: join(accountHome, "attachments"),
        share: join(accountHome, "share"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves a configured ~/ path under the run account's home", async () => {
    const accountHome = await mkdtemp(join(tmpdir(), "pi-sec-account-"));
    vi.stubEnv("HOME", accountHome);
    try {
      const configured = {
        storage: undefined as never,
        getConfig: () => ({ attachments: { dir: "~/files", shareDir: "~/published" } }),
      };
      expect(resolveRoots(configured)).toEqual({
        attachments: join(accountHome, "files"),
        share: join(accountHome, "published"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a configured absolute path as it stands", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "pi-sec-roots-"));
    const configured = {
      storage: undefined as never,
      getConfig: () => ({
        attachments: { dir: join(elsewhere, "uploads"), shareDir: join(elsewhere, "served") },
      }),
    };
    expect(resolveRoots(configured)).toEqual({
      attachments: join(elsewhere, "uploads"),
      share: join(elsewhere, "served"),
    });
  });
});

/**
 * A row and a file in the layout this store wrote before the name change.
 *
 * `<id>/<id>.<ext>`, written by hand rather than by `createAttachment`, because
 * the point of the rows below is that the store no longer produces this shape
 * and must still read it.
 */
async function legacyRow(
  f: Fixture,
  name: string,
  mime: string,
  data: Buffer,
  jobId?: string,
): Promise<{ id: string; dir: string; path: string }> {
  const id = ulid();
  const dir = join(f.roots.attachments, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "bin";
  const path = join(dir, `${id}.${ext}`);
  await writeFile(path, data, { mode: 0o600 });
  await f.h.runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(SecAttachment, id, id);
    doc.id = id;
    doc.kind = "attachment";
    doc.name = name;
    doc.mime = mime;
    doc.bytes = data.byteLength;
    doc.sha256 = createHash("sha256").update(data).digest("hex");
    doc.collectedAt = Date.now();
    doc.storagePath = path;
    if (jobId !== undefined) doc.jobId = jobId;
  }, BACKGROUND_CONTEXT);
  return { id, dir, path };
}

// ---------------------------------------------------------------------------
// The name on disk: what an agent finds with `ls` under the id directory.
// ---------------------------------------------------------------------------

describe("attachment storage name", () => {
  it("stores a text snippet as <id>/snippet.txt and keeps the name as metadata", async () => {
    const f = await boot();
    const data = Buffer.from("the body the agent has to choose to read\n", "utf8");
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "snippet",
      mime: "text/plain; charset=utf-8",
      data,
    });

    expect(record.name).toBe("snippet");
    expect(record.storagePath).toBe(join(f.roots.attachments, record.id, "snippet.txt"));
    expect(dirname(record.storagePath)).toBe(join(f.roots.attachments, record.id));
    expect(await readdir(join(f.roots.attachments, record.id))).toEqual(["snippet.txt"]);
    expect(await readAttachmentBytes(record)).toEqual(data);
    expect((await getAttachment(f.ctx(), record.id))?.storagePath).toBe(record.storagePath);
  });

  it("adds txt for text and bin for anything else when the name carries no extension", async () => {
    const f = await boot();
    const notes = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "notes",
      mime: "text/plain",
      data: Buffer.from("words"),
    });
    const blob = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "blob",
      mime: "application/octet-stream",
      data: Buffer.from([0x00, 0x01]),
    });
    // A name that already says what it is keeps its own extension.
    const log = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "run.log",
      mime: "text/plain",
      data: Buffer.from("line\n"),
    });

    expect(notes.storagePath).toBe(join(f.roots.attachments, notes.id, "notes.txt"));
    expect(blob.storagePath).toBe(join(f.roots.attachments, blob.id, "blob.bin"));
    expect(log.storagePath).toBe(join(f.roots.attachments, log.id, "run.log"));
  });

  it("reduces a separator, a leading dot and a control character to one safe segment", async () => {
    const f = await boot();
    const escaped = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "../../etc/passwd",
      mime: "application/pdf",
      data: Buffer.from("x"),
    });
    const dotted = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "..",
      mime: "text/plain",
      data: Buffer.from("x"),
    });
    const control = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "sni\npet",
      mime: "text/plain",
      data: Buffer.from("x"),
    });

    expect(escaped.storagePath).toBe(join(f.roots.attachments, escaped.id, "passwd.bin"));
    expect(dotted.storagePath).toBe(join(f.roots.attachments, dotted.id, `${dotted.id}.txt`));
    expect(control.storagePath).toBe(join(f.roots.attachments, control.id, "sni-pet.txt"));

    for (const record of [escaped, dotted, control]) {
      // One segment beside the id directory, and nothing reaches the parent.
      expect(dirname(record.storagePath)).toBe(join(f.roots.attachments, record.id));
      expect(record.storagePath.startsWith(join(f.roots.attachments, record.id) + "/")).toBe(true);
      expect(basename(record.storagePath)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(await readAttachmentBytes(record)).toEqual(Buffer.from("x"));
    }
    // The original names are untouched metadata: the download header uses them.
    expect(escaped.name).toBe("../../etc/passwd");
    expect(control.name).toBe("sni\npet");
  });

  it("falls back to the id when nothing of the name survives, and keeps the original name", async () => {
    const f = await boot();
    const data = Buffer.from("korean body\n", "utf8");
    // Korean text here is test data: the code under test handles Korean on purpose.
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "한글 스니펫",
      mime: "text/plain; charset=utf-8",
      data,
    });

    expect(record.storagePath).toBe(join(f.roots.attachments, record.id, `${record.id}.txt`));
    expect(record.name).toBe("한글 스니펫");
    expect(await readdir(join(f.roots.attachments, record.id))).toEqual([`${record.id}.txt`]);
    expect(await readAttachmentBytes(record)).toEqual(data);
    expect((await getAttachment(f.ctx(), record.id))?.name).toBe("한글 스니펫");
  });
});

// ---------------------------------------------------------------------------
// Two layouts on disk at one time: the rows written before the change and
// the rows written after it. Nothing migrates, so both have to work.
// ---------------------------------------------------------------------------

describe("attachment layout change", () => {
  it("reads, serves and disposes a row that still points at <id>/<id>.<ext>", async () => {
    const f = await boot();
    const data = pngBytes(8, 8);
    const legacy = await legacyRow(f, "old.png", "image/png", data);

    const record = await getAttachment(f.ctx(), legacy.id);
    expect(record?.storagePath).toBe(legacy.path);
    expect(await readAttachmentBytes(record!)).toEqual(data);

    const fresh = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "snippet",
      mime: "text/plain",
      data: Buffer.from("new layout"),
    });

    // The sweep counts what an indexed row points at, so neither layout is an
    // orphan and neither directory loses its file.
    expect(await sweepAttachments(f.ctx())).toEqual({ dropped: 0, orphanFiles: 0 });
    expect(await readAttachmentBytes(record!)).toEqual(data);
    expect(await readdir(legacy.dir)).toEqual([`${legacy.id}.png`]);
    expect(await readdir(dirname(fresh.storagePath))).toEqual(["snippet.txt"]);

    // `dispose` deletes `dirname(storagePath)`, so both layouts go the same way.
    // Both rows have no owner job, so the unowned rule removes them once they are old.
    await f.h.runtime.harness.commit(async (tx) => {
      for (const id of [legacy.id, fresh.id]) {
        const doc = await tx.doc(SecAttachment, id, id);
        doc.collectedAt = Date.now() - UNOWNED_GRACE_MS - 60_000;
      }
    }, BACKGROUND_CONTEXT);
    expect(await sweepAttachments(f.ctx())).toEqual({ dropped: 2, orphanFiles: 0 });
    expect(await stat(legacy.dir).then(() => true, () => false)).toBe(false);
    expect(await stat(dirname(fresh.storagePath)).then(() => true, () => false)).toBe(false);
    expect(await getAttachment(f.ctx(), legacy.id)).toBeUndefined();
    expect(await getAttachment(f.ctx(), fresh.id)).toBeUndefined();
  });
});

describe("attachment assignment", () => {
  it("gives an unowned attachment to the job and keeps it out of everyone else's list", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    const result = await assignAttachments(f.ctx(liveJobs(["job-a"])), [record.id], "job-a");
    expect(result).toEqual({ assigned: [record.id], refused: [] });
    expect((await getAttachment(f.ctx(), record.id))?.jobId).toBe("job-a");
    expect(await listAttachments(f.ctx(), { jobId: "job-a" })).toHaveLength(1);

    // Assigning the same file to the same job again is a no-op that still counts.
    const again = await assignAttachments(f.ctx(liveJobs(["job-a"])), [record.id], "job-a");
    expect(again.assigned).toEqual([record.id]);
  });

  it("refuses a file another job already owns", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-a",
    });
    const result = await assignAttachments(f.ctx(liveJobs(["job-a", "job-b"])), [record.id], "job-b");
    expect(result).toEqual({ assigned: [], refused: [{ id: record.id, reason: "owned-by-other" }] });
    expect((await getAttachment(f.ctx(), record.id))?.jobId).toBe("job-a");
  });

  it("reports each reason in one pass, keeping the ids it could assign", async () => {
    const f = await boot();
    const free = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "free.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    const taken = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "taken.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-z",
    });
    const absent = ulid();
    const result = await assignAttachments(
      f.ctx(liveJobs(["job-a", "job-z"])),
      [free.id, taken.id, "nope", absent],
      "job-a",
    );
    expect(result.assigned).toEqual([free.id]);
    expect(result.refused).toEqual([
      { id: taken.id, reason: "owned-by-other" },
      { id: "nope", reason: "bad-id" },
      { id: absent, reason: "missing" },
    ]);
  });
});

describe("attachment sweep", () => {
  it("keeps what an archived job owns", async () => {
    const f = await boot();
    const upload = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "kept.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-archived",
    });
    const shared = await createAttachment(f.ctx(), {
      kind: "share",
      name: "shared.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-archived",
    });

    expect(await sweepAttachments(f.ctx())).toEqual({ dropped: 0, orphanFiles: 0 });
    expect(await getAttachment(f.ctx(), upload.id)).toBeDefined();
    expect(await getAttachment(f.ctx(), shared.id)).toBeDefined();
    expect(await readAttachmentBytes(upload)).toEqual(pngBytes(8, 8));
    expect(await readAttachmentBytes(shared)).toEqual(pngBytes(8, 8));
    const disposed = (await auditEvents(f.h)).filter((event) => event.type === "attachment_disposed");
    expect(disposed).toEqual([]);
  });

  it("drops an unowned upload and an unowned share file, and records the file, the id and the kind", async () => {
    const f = await boot();
    const upload = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "old.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    const shared = await createAttachment(f.ctx(), {
      kind: "share",
      name: "shared.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    const fresh = await createAttachment(f.ctx(), {
      kind: "share",
      name: "fresh.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    await f.h.runtime.harness.commit(async (tx) => {
      const docs = [
        await tx.doc(SecAttachment, upload.id, upload.id),
        await tx.doc(SecShare, shared.id, shared.id),
      ];
      for (const doc of docs) doc.collectedAt = Date.now() - UNOWNED_GRACE_MS - 60_000;
    }, BACKGROUND_CONTEXT);

    expect(await sweepAttachments(f.ctx())).toEqual({ dropped: 2, orphanFiles: 0 });
    expect(await getAttachment(f.ctx(), upload.id)).toBeUndefined();
    expect(await getAttachment(f.ctx(), shared.id)).toBeUndefined();
    expect(await getAttachment(f.ctx(), fresh.id)).toBeDefined();
    const disposed = (await auditEvents(f.h)).filter((event) => event.type === "attachment_disposed");
    expect(disposed).toHaveLength(2);
    for (const event of disposed) {
      expect(event.reason).toBe("unowned");
      expect(typeof event.attachmentId).toBe("string");
      expect(typeof event.fileName).toBe("string");
    }
    expect(disposed.map((event) => event.kind).sort()).toEqual(["attachment", "share"]);
  });

  it("keeps a row whose job left the live store", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-live",
    });
    const swept = await sweepAttachments(f.ctx());
    expect(swept).toEqual({ dropped: 0, orphanFiles: 0 });
    expect(await getAttachment(f.ctx(), record.id)).toBeDefined();
  });

  it("keeps what a live job owns and what an unowned file still has time for", async () => {
    const f = await boot();
    const owned = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-live",
    });
    const fresh = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "b.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    const swept = await sweepAttachments(f.ctx());
    expect(swept).toEqual({ dropped: 0, orphanFiles: 0 });
    expect(await getAttachment(f.ctx(), owned.id)).toBeDefined();
    expect(await getAttachment(f.ctx(), fresh.id)).toBeDefined();
  });

  it("drops an unowned file after the 24 hour grace", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    // Move the collection time back rather than the clock forward: the store reads
    // the recorded time, so this is the same fact the sweep would meet tomorrow.
    await f.h.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(SecAttachment, record.id, record.id);
      doc.collectedAt = Date.now() - UNOWNED_GRACE_MS - 60_000;
    }, BACKGROUND_CONTEXT);

    const swept = await sweepAttachments(f.ctx());
    expect(swept).toEqual({ dropped: 1, orphanFiles: 0 });
    expect(await getAttachment(f.ctx(), record.id)).toBeUndefined();
    expect(await stat(join(f.roots.attachments, record.id)).then(() => true, () => false)).toBe(false);
    const disposed = (await auditEvents(f.h)).filter((event) => event.type === "attachment_disposed");
    expect(disposed[0]).toMatchObject({ reason: "unowned", attachmentId: record.id });
  });

  it("drops a row whose body file is gone", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-live",
    });
    await rm(record.storagePath, { force: true });
    const swept = await sweepAttachments(f.ctx());
    expect(swept.dropped).toBe(1);
    expect(await getAttachment(f.ctx(), record.id)).toBeUndefined();
    const disposed = (await auditEvents(f.h)).filter((event) => event.type === "attachment_disposed");
    expect(disposed[0]).toMatchObject({ reason: "body-file-missing", jobId: "job-live" });
  });

  it("removes a file nothing indexes, and leaves a foreign file alone", async () => {
    const f = await boot();
    const strayId = ulid();
    await mkdir(join(f.roots.attachments, strayId), { recursive: true, mode: 0o700 });
    await writeFile(join(f.roots.attachments, strayId, `${strayId}.png`), "body", { mode: 0o600 });
    await writeFile(join(f.roots.share, "stray.png"), "body", { mode: 0o600 });
    await mkdir(join(f.roots.attachments, "not-ours"), { recursive: true, mode: 0o700 });
    await writeFile(join(f.roots.attachments, "not-ours", "keep.txt"), "body", { mode: 0o600 });

    const swept = await sweepAttachments(f.ctx());
    expect(swept).toEqual({ dropped: 0, orphanFiles: 2 });
    expect(await stat(join(f.roots.attachments, strayId)).then(() => true, () => false)).toBe(false);
    expect(await stat(join(f.roots.share, "stray.png")).then(() => true, () => false)).toBe(false);
    expect(await stat(join(f.roots.attachments, "not-ours", "keep.txt")).then(() => true)).toBe(true);
    expect((await auditEvents(f.h)).filter((event) => event.type === "attachment_orphan_removed")).toHaveLength(2);
  });

  it("counts a whole orphaned directory once per file it held", async () => {
    const f = await boot();
    const strayId = ulid();
    const dir = join(f.roots.attachments, strayId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${strayId}.png`), "a", { mode: 0o600 });
    await writeFile(join(dir, ".tmp-leftover"), "b", { mode: 0o600 });

    const swept = await sweepAttachments(f.ctx());
    expect(swept.orphanFiles).toBe(2);
    expect(await stat(dir).then(() => true, () => false)).toBe(false);
  });

  it("collects a leftover temporary file beside a body that is still indexed", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
    });
    // A crash between the write and the rename leaves this behind. The row is
    // live, so the sweep must take the leftover and keep the directory.
    await writeFile(join(f.roots.attachments, record.id, ".tmp-dead"), "half", { mode: 0o600 });
    const swept = await sweepAttachments(f.ctx());
    expect(swept).toEqual({ dropped: 0, orphanFiles: 1 });
    expect(await getAttachment(f.ctx(), record.id)).toBeDefined();
    expect(await readdir(join(f.roots.attachments, record.id))).toEqual(["a.png"]);
  });

  it("does not drop an owned file when no live store was supplied", async () => {
    const f = await boot();
    const record = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "a.png",
      mime: "image/png",
      data: pngBytes(8, 8),
      jobId: "job-any",
    });
    const swept = await sweep(f.ctx());
    expect(swept.dropped).toBe(0);
    expect(await getAttachment(f.ctx(), record.id)).toBeDefined();
  });
});
