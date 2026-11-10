import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { submitEnveloped } from "../src/submit-envelope.ts";
import { defaultConfig } from "../src/config/schema.ts";
import type { StartedServer } from "../src/server/server.ts";
import { ulid } from "../src/runtime/ids.ts";
import * as store from "../src/attachments/store.ts";
import {
  assignAttachments,
  createAttachment,
  getAttachment,
  type AttachmentContext,
  type AttachmentRoots,
} from "../src/attachments/store.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures: the smallest header each reader accepts, written by hand so a
// failure names the parser rather than a fixture library.
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  // A little payload, so a round trip that compares bytes has something to lose.
  for (let index = 26; index < buf.length; index += 1) buf[index] = index * 7;
  return buf;
}

const CAP = 8 * 1024 * 1024;

interface Fixture {
  readonly h: TestHarness;
  readonly origin: string;
  readonly base: string;
  readonly roots: AttachmentRoots;
  readonly started: StartedServer;
  ctx(jobs?: AttachmentContext["jobs"]): AttachmentContext;
}

let open: Fixture | undefined;

afterEach(async () => {
  await open?.started.close();
  await open?.h.close();
  if (open !== undefined) await rm(open.base, { recursive: true, force: true });
  open = undefined;
});

/**
 * Boot one server over a temporary tree.
 *
 * `fromConfig` names the two roots in the configuration instead of injecting
 * them as a route option, which is how production finds them: the server then
 * has no override at all and must read `attachments.dir` and `attachments.shareDir`.
 */
async function boot(options: { fromConfig?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-sec-attach-routes-"));
  const roots: AttachmentRoots = {
    attachments: join(base, "attachments"),
    share: join(base, "share"),
  };
  await mkdir(roots.attachments, { recursive: true, mode: 0o700 });
  await mkdir(roots.share, { recursive: true, mode: 0o700 });
  const h = await createTestHarness({
    config: {
      server: { ...defaultConfig().server, port: 0 },
      ...(options.fromConfig === true
        ? { attachments: { dir: roots.attachments, shareDir: roots.share } }
        : {}),
    },
  });

  const started = await startTestServer(h, options.fromConfig === true ? {} : { attachmentRoots: roots });
  const fixture: Fixture = {
    h,
    origin: started.origin,
    base,
    roots,
    started,
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

/** POST the file itself, with the name and the MIME in the two places they belong. */
async function upload(
  origin: string,
  bytes: Buffer,
  mime: string,
  name: string,
): Promise<Response> {
  return await fetch(`${origin}/api/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": mime },
    body: new Uint8Array(bytes),
  });
}

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

type UploadedBody = {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  sha256: string;
  name: string;
  w?: number;
  h?: number;
};

describe("upload route", () => {
  it("round-trips a binary body and serves it back as the same bytes", async () => {
    const f = await boot();
    const png = pngBytes(64, 48);
    const response = await upload(f.origin, png, "image/png", "kitten.png");
    expect(response.status).toBe(201);
    const body = (await response.json()) as UploadedBody;

    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.url).toBe(`/api/attachments/${body.id}`);
    expect(body.name).toBe("kitten.png");
    expect(body.mime).toBe("image/png");
    expect(body.bytes).toBe(png.byteLength);
    expect(body.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(body.w).toBe(64);
    expect(body.h).toBe(48);

    const inline = await fetch(`${f.origin}${body.url}`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inline.headers.get("content-disposition")).toBeNull();
    expect(await bytesOf(inline)).toEqual(png);

    const download = await fetch(`${f.origin}${body.url}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain("kitten.png");
    expect(await bytesOf(download)).toEqual(png);
  });

  it("takes the MIME from the signature when the header names nothing useful", async () => {
    const f = await boot();
    const png = pngBytes(8, 8);
    const response = await upload(f.origin, png, "application/octet-stream", "pasted");
    expect(response.status).toBe(201);
    const body = (await response.json()) as UploadedBody;
    expect(body.mime).toBe("image/png");
    expect(body.w).toBe(8);
  });

  it("never serves a body that is not an image as a page", async () => {
    const f = await boot();
    const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
    const response = await upload(f.origin, html, "text/html", "note.html");
    expect(response.status).toBe(201);
    const body = (await response.json()) as UploadedBody;
    expect(body.mime).toBe("text/html");

    const served = await fetch(`${f.origin}${body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("content-disposition")).toContain("attachment;");
    expect(await bytesOf(served)).toEqual(html);
  });

  it(
    "accepts a body of exactly the cap and refuses one byte more",
    async () => {
      const f = await boot();
      const atCap = Buffer.alloc(CAP, 0x07);
      const accepted = await upload(f.origin, atCap, "application/octet-stream", "big.bin");
      expect(accepted.status).toBe(201);
      expect(((await accepted.json()) as UploadedBody).bytes).toBe(CAP);

      const overCap = Buffer.alloc(CAP + 1, 0x07);
      const refused = await upload(f.origin, overCap, "application/octet-stream", "too-big.bin");
      expect(refused.status).toBe(413);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "payload_too_large",
      );
    },
    30_000,
  );

  it("refuses an image above FHD and accepts one at the limit", async () => {
    const f = await boot();
    const atLimit = await upload(f.origin, pngBytes(1920, 1080), "image/png", "fhd.png");
    expect(atLimit.status).toBe(201);

    const tooWide = await upload(f.origin, pngBytes(1921, 1080), "image/png", "wide.png");
    expect(tooWide.status).toBe(413);
    expect(((await tooWide.json()) as { error: { code: string } }).error.code).toBe(
      "image_dimensions_exceeded",
    );

    const tooTall = await upload(f.origin, pngBytes(1920, 1081), "image/png", "tall.png");
    expect(tooTall.status).toBe(413);
    expect(((await tooTall.json()) as { error: { code: string } }).error.code).toBe(
      "image_dimensions_exceeded",
    );
  });

  it("refuses an image whose header declares no size", async () => {
    const f = await boot();
    const broken = Buffer.from("this claims to be a png and is not one at all", "utf8");
    const response = await upload(f.origin, broken, "image/png", "broken.png");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "image_unreadable",
    );
  });
});

describe("the configured storage roots", () => {
  it("stores an upload and serves a share from the directories in the config", async () => {
    // No route option here: this server must find both directories through
    // `attachments.dir` and `attachments.shareDir`, the way production does, and
    // neither may fall back to a path baked into the code.
    const f = await boot({ fromConfig: true });
    const png = pngBytes(20, 10);
    const response = await upload(f.origin, png, "image/png", "chart.png");
    expect(response.status).toBe(201);
    const body = (await response.json()) as UploadedBody;
    expect((await stat(join(f.roots.attachments, body.id))).isDirectory()).toBe(true);
    expect(await bytesOf(await fetch(`${f.origin}${body.url}`))).toEqual(png);

    await writeFile(join(f.roots.share, "published.png"), png);
    const share = await fetch(`${f.origin}/api/share/published.png`);
    expect(share.status).toBe(200);
    expect(await bytesOf(share)).toEqual(png);
  });
});

describe("serving routes", () => {
  it("answers 404 for an id nothing stored", async () => {
    const f = await boot();
    const response = await fetch(`${f.origin}/api/attachments/${ulid()}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("describes a stored file without shipping its bytes", async () => {
    const f = await boot();
    // A file far larger than any description of it, so a body that rode along
    // with the JSON would show up as a length and not only as a byte pattern.
    const png = Buffer.concat([pngBytes(120, 90), Buffer.alloc(200_000, 0x41)]);
    const uploaded = await upload(f.origin, png, "image/png", "chart.png");
    const { id } = (await uploaded.json()) as UploadedBody;

    const response = await fetch(`${f.origin}/api/attachments/${id}/meta`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text.length).toBeLessThan(1000);
    expect(text).not.toContain("QUFB");
    const meta = JSON.parse(text) as UploadedBody;
    expect(meta).toEqual({
      id,
      name: "chart.png",
      mime: "image/png",
      bytes: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
      url: `/api/attachments/${id}`,
      w: 120,
      h: 90,
    });
    expect(response.headers.get("content-disposition")).toBeNull();

    const missing = await fetch(`${f.origin}/api/attachments/${ulid()}/meta`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("refuses a path that is not one segment", async () => {
    const f = await boot();
    for (const path of [
      "/api/attachments/..%2F..%2Fetc%2Fpasswd",
      "/api/attachments/%2e%2e",
      "/api/share/..%2F..%2Fetc%2Fpasswd",
      "/api/share/.hidden",
      "/api/share/..",
    ]) {
      const response = await fetch(`${f.origin}${path}`);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe(
        "not_found",
      );
    }
  });

  it("serves a published share by name and gives a stranger's file nothing", async () => {
    const f = await boot();
    const png = pngBytes(32, 32);
    const image = await createAttachment(f.ctx(), {
      kind: "share",
      name: "shot.png",
      mime: "image/png",
      data: png,
    });
    const text = await createAttachment(f.ctx(), {
      kind: "share",
      name: "run.log",
      mime: "text/plain",
      data: Buffer.from("line one\nline two\n", "utf8"),
    });

    const served = await fetch(`${f.origin}/api/share/${image.name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await bytesOf(served)).toEqual(png);

    const other = await fetch(`${f.origin}/api/share/${text.name}`);
    expect(other.status).toBe(200);
    expect(other.headers.get("content-type")).toBe("application/octet-stream");
    expect(other.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(other.headers.get("content-disposition")).toContain("attachment;");

    const missing = await fetch(`${f.origin}/api/share/not-there.png`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("does not follow a symbolic link in the share root", async () => {
    const f = await boot();
    await writeFile(join(f.base, "leak-target.png"), "LINK-MARKER-OUTSIDE", "utf8");
    await symlink(join(f.base, "leak-target.png"), join(f.roots.share, "leak.png"));
    const response = await fetch(`${f.origin}/api/share/leak.png`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("LINK-MARKER-OUTSIDE");
  });

  it("does not serve a stored file that was replaced by a link", async () => {
    const f = await boot();
    const image = await createAttachment(f.ctx(), {
      kind: "share",
      name: "swap.png",
      mime: "image/png",
      data: pngBytes(32, 32),
    });
    await writeFile(join(f.base, "swap-target.txt"), "LINK-MARKER-OUTSIDE", "utf8");
    await rm(image.storagePath);
    await symlink(join(f.base, "swap-target.txt"), image.storagePath);
    const response = await fetch(`${f.origin}/api/attachments/${image.id}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("LINK-MARKER-OUTSIDE");
  });

  it("will not follow a name out of the share root even if the root holds one", async () => {
    const f = await boot();
    // A file just outside the root is the thing a traversal would reach.
    await writeFile(join(f.base, "outside.txt"), "secret", "utf8");
    const response = await fetch(`${f.origin}/api/share/${encodeURIComponent("../outside.txt")}`);
    expect(response.status).toBe(404);
  });
});

describe("archive disposal", () => {
  it("keeps the file an archived job owns and keeps serving it", async () => {
    const f = await boot();
    const png = pngBytes(16, 16);
    const response = await upload(f.origin, png, "image/png", "owned.png");
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as UploadedBody;

    const { jobs, archive } = f.h.runtime;
    const job = await jobs.create(BACKGROUND_CONTEXT, { title: "finished work" });
    const assigned = await assignAttachments(f.ctx(jobs), [id], job.id);
    expect(assigned.assigned).toEqual([id]);
    const shared = await createAttachment(f.ctx(), {
      kind: "share",
      name: "shared.png",
      mime: "image/png",
      data: png,
      jobId: job.id,
    });

    const record = await getAttachment(f.ctx(), id);
    expect(record).toBeDefined();
    const path = record!.storagePath;

    await jobs.update(BACKGROUND_CONTEXT, job.id, { status: "done" });
    await archive.sweep(BACKGROUND_CONTEXT, 0);
    expect(await jobs.get(BACKGROUND_CONTEXT, job.id)).toBeUndefined();

    await expect(stat(path)).resolves.toBeDefined();
    expect((await getAttachment(f.ctx(), id))?.jobId).toBe(job.id);
    const kept = await fetch(`${f.origin}/api/attachments/${id}`);
    expect(kept.status).toBe(200);
    expect(await bytesOf(kept)).toEqual(png);
    const sharedAnswer = await fetch(`${f.origin}/api/share/${basename(shared.storagePath)}`);
    expect(sharedAnswer.status).toBe(200);
    expect(await bytesOf(sharedAnswer)).toEqual(png);
  });
});

// ---------------------------------------------------------------------------
// The descriptors an entries payload carries
// ---------------------------------------------------------------------------

interface Frame {
  readonly event: string;
  readonly data: string;
}

/**
 * One open SSE endpoint, read frame by frame.
 *
 * A frame is complete when a blank line ends it, so the buffer keeps whatever
 * follows the last one. Waiting is bounded: a stream that never answers fails
 * the test with the frames it did send.
 */
function openEvents(
  origin: string,
  path: string,
): {
  until: (done: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  close: () => void;
} {
  const controller = new AbortController();
  const frames: Frame[] = [];
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  const opened = fetch(`${origin}${path}`, { signal: controller.signal }).then((response) => {
    expect(response.status).toBe(200);
    return response.body!.getReader();
  });

  function drain(): void {
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut === -1) return;
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      if (event === undefined) continue;
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      frames.push({ event, data });
    }
  }

  return {
    close: () => controller.abort(),
    async until(done, timeoutMs = 5000) {
      reader ??= await opened;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(done);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(`timed out; frames so far: ${frames.map((frame) => frame.event).join(", ")}`);
        }
        const { value, done: ended } = await reader.read();
        if (ended) throw new Error(`stream ended; frames so far: ${frames.map((frame) => frame.event).join(", ")}`);
        buffer += decoder.decode(value, { stream: true });
        drain();
      }
    },
  };
}

/** The conversation this fixture's page talks to. */
function defaultConversation(f: Fixture) {
  return resolveDefaultConversation(f.h.runtime.harness, f.h.config, f.h.runtime.paths, BACKGROUND_CONTEXT);
}

/** One entry whose envelope names these attachment ids, written straight into the transcript. */
async function writeEntryWith(f: Fixture, attachments: string): Promise<number> {
  const conversation = await defaultConversation(f);
  await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
    type: "write",
    src: "operator",
    attrs: { attachments },
    entry: {
      kind: "pi.user",
      model: [{ role: "user", content: "look at these", timestamp: Date.now() }],
    },
  }, f.h.config.timezone);
  return conversation.id;
}

/**
 * One entry that carries no text at all.
 *
 * Its frame is `entry_appended`: the durable layer reports an entry with a
 * message as `message_end`, so the model-less entry is what exercises the other
 * frame.
 */
async function writeNoteEntry(f: Fixture): Promise<void> {
  const conversation = await defaultConversation(f);
  await conversation.submit({ type: "write", entry: { kind: "pi.note" } }, BACKGROUND_CONTEXT);
}

type Described = { readonly attachments: Record<string, Record<string, unknown>> };

describe("a conversation payload", () => {
  it("describes the attachments its entries name, over the resource and both live frames", async () => {
    const f = await boot();
    const png = pngBytes(6, 4);
    const uploaded = await upload(f.origin, png, "image/png", "first.png");
    expect(uploaded.status).toBe(201);
    const first = (await uploaded.json()) as UploadedBody;
    const record = await getAttachment(f.ctx(), first.id);
    expect(record).toBeDefined();

    const conversationId = await writeEntryWith(f, first.id);

    // The resource: the map is there, the entry is untouched, and every field
    // comes from the stored record.
    const resource = await fetch(`${f.origin}/api/conversations/${conversationId}`);
    expect(resource.status).toBe(200);
    const body = (await resource.json()) as Described & { entries: { readonly model?: unknown }[] };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.entries)).toContain(`attachments=\\"${first.id}\\"`);
    expect(body.attachments[first.id]).toEqual({
      id: first.id,
      mime: "image/png",
      name: "first.png",
      bytes: png.byteLength,
      w: 6,
      h: 4,
    });
    expect(record!.mime).toBe("image/png");
    expect(body.attachments[first.id]!["sha256"]).toBeUndefined();
    expect(body.attachments[first.id]!["storagePath"]).toBeUndefined();

    // A snapshot taken with that entry already in the transcript describes it.
    const events = openEvents(f.origin, `/api/conversations/${conversationId}/events`);
    try {
      const snapshot = await events.until((frame) => frame.event === "snapshot");
      const data = JSON.parse(snapshot.data) as Described;
      expect(data.attachments[first.id]).toEqual(body.attachments[first.id]);
    } finally {
      events.close();
    }

    // And a frame that carries one later entry describes that entry's file.
    const second = await upload(f.origin, pngBytes(12, 9), "image/png", "second.png");
    expect(second.status).toBe(201);
    const later = (await second.json()) as UploadedBody;
    const live = openEvents(f.origin, `/api/conversations/${conversationId}/events`);
    try {
      await live.until((frame) => frame.event === "snapshot");
      // A message frame describes the attachments of the message it carries.
      await writeEntryWith(f, later.id);
      const ended = await live.until((frame) => frame.event === "message_end" && frame.data.includes(later.id));
      const described = JSON.parse(ended.data) as Described;
      expect(described.attachments).toEqual({
        [later.id]: {
          id: later.id,
          mime: "image/png",
          name: "second.png",
          bytes: pngBytes(12, 9).byteLength,
          w: 12,
          h: 9,
        },
      });
      // An entry with no text names no id, and the frame still carries the map,
      // so a reader never has to tell the two frames apart before it reads it.
      await writeNoteEntry(f);
      const appended = await live.until((frame) => frame.event === "entry_appended");
      expect((JSON.parse(appended.data) as Described).attachments).toEqual({});
    } finally {
      live.close();
    }
  });

  it("looks a repeated id up once, and drops an id whose record is gone", async () => {
    const f = await boot();
    const [one, two] = await Promise.all([
      upload(f.origin, pngBytes(6, 4), "image/png", "one.png"),
      upload(f.origin, pngBytes(3, 3), "image/png", "two.png"),
    ]);
    const first = (await one.json()) as UploadedBody;
    const second = (await two.json()) as UploadedBody;
    const missing = ulid();

    const conversationId = await writeEntryWith(f, [first.id, first.id, second.id, missing].join(","));

    const spy = vi.spyOn(store, "getAttachment");
    try {
      const response = await fetch(`${f.origin}/api/conversations/${conversationId}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Described;

      // Three distinct ids in one payload: the repeat costs nothing, the id with
      // no record costs one read and nothing else.
      expect(spy.mock.calls.map((call) => call[1])).toEqual([first.id, second.id, missing]);
      expect(Object.keys(body.attachments).sort()).toEqual([first.id, second.id].sort());
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the response whole when no record answers for an id", async () => {
    const f = await boot();
    const missing = ulid();
    const conversationId = await writeEntryWith(f, missing);

    const response = await fetch(`${f.origin}/api/conversations/${conversationId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Described & { entries: unknown[] };
    expect(body.attachments).toEqual({});
    // The message is still there; only the description is absent.
    expect(JSON.stringify(body.entries)).toContain(missing);
  });
});
