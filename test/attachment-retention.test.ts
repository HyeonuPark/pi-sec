import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defaultConfig } from "../src/config/schema.ts";
import type { StartedServer } from "../src/server/server.ts";
import { readAuditTail } from "../src/runtime/audit.ts";
import {
  createAttachment,
  getAttachment,
  type AttachmentContext,
  type AttachmentRoots,
} from "../src/attachments/store.ts";
import { sweepAttachments } from "../src/attachments/sweep.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  for (let index = 26; index < buf.length; index += 1) buf[index] = index * 7;
  return buf;
}

interface Fixture {
  readonly h: TestHarness;
  readonly base: string;
  readonly roots: AttachmentRoots;
  readonly started: StartedServer;
  ctx(): AttachmentContext;
}

let open: Fixture | undefined;

afterEach(async () => {
  await open?.started.close();
  await open?.h.close();
  if (open !== undefined) await rm(open.base, { recursive: true, force: true });
  open = undefined;
});

async function boot(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-sec-attach-retention-"));
  const roots: AttachmentRoots = { attachments: join(base, "attachments"), share: join(base, "share") };
  await mkdir(roots.attachments, { recursive: true, mode: 0o700 });
  await mkdir(roots.share, { recursive: true, mode: 0o700 });
  const h = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
  const started = await startTestServer(h, { attachmentRoots: roots });
  const fixture: Fixture = {
    h,
    base,
    roots,
    started,
    ctx: () => ({
      storage: h.runtime.storage,
      harness: h.runtime.harness,
      audit: h.runtime.audit,
      roots,
    }),
  };
  open = fixture;
  return fixture;
}

describe("a job's files after the job is archived", () => {
  it("keeps the rows, the bytes and both addresses, through the archive move and the boot sweep", async () => {
    const f = await boot();
    const { jobs, archive, drafts } = f.h.runtime;
    const job = await jobs.create(BACKGROUND_CONTEXT, { title: "finished work" });
    const png = pngBytes(16, 16);
    const share = await createAttachment(f.ctx(), {
      kind: "share",
      name: "shared.png",
      mime: "image/png",
      data: png,
      jobId: job.id,
    });
    const upload = await createAttachment(f.ctx(), {
      kind: "attachment",
      name: "upload.png",
      mime: "image/png",
      data: png,
      jobId: job.id,
    });
    const draft = await drafts.create(BACKGROUND_CONTEXT, {
      agentConversationId: "conversation-000000",
      jobId: job.id,
      title: "Draft",
      content: "# Draft\n",
    });
    await jobs.update(BACKGROUND_CONTEXT, job.id, { status: "done" });

    await archive.sweep(BACKGROUND_CONTEXT, 0);
    expect(await jobs.get(BACKGROUND_CONTEXT, job.id)).toBeUndefined();

    const check = async (): Promise<void> => {
      for (const id of [share.id, upload.id]) {
        const row = await getAttachment(f.ctx(), id);
        expect(row?.jobId).toBe(job.id);
        expect(await readFile(row!.storagePath)).toEqual(png);
      }
      const shared = await fetch(`${f.started.origin}/api/share/${basename(share.storagePath)}`);
      expect(shared.status).toBe(200);
      expect(Buffer.from(await shared.arrayBuffer())).toEqual(png);
      const uploaded = await fetch(`${f.started.origin}/api/attachments/${upload.id}`);
      expect(uploaded.status).toBe(200);
      expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(png);
      const events = await readAuditTail(f.h.paths.auditLog, undefined, 200);
      expect(events.filter((event) => event.type === "attachment_disposed")).toEqual([]);
    };
    await check();

    // The boot sweep must not take a file whose job has left the live store.
    expect(await sweepAttachments(f.ctx())).toEqual({ dropped: 0, orphanFiles: 0 });
    await check();

    // The draft rule is unchanged: a draft goes with its job.
    expect(await drafts.get(BACKGROUND_CONTEXT, draft.id)).toBeUndefined();
  });
});
