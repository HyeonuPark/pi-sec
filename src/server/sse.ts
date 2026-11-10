import type { IncomingMessage, ServerResponse } from "node:http";
import { createGzip, constants as zlibConstants, type Gzip } from "node:zlib";
import { acceptsGzip } from "./compress.ts";
import { apiError } from "./router.ts";

export interface SseFrame {
  readonly id: number;
  readonly event: string;
  readonly data: string;
}

export interface SseOptions {
  readonly heartbeatMs: number;
  readonly queueBytes: number;
  readonly bufferMs: number;
  readonly retryMs?: number;
  readonly maxFrames?: number;
}

const DEFAULT_RETRY_MS = 3000;

function formatFrame(frame: SseFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

/** Bounded per-endpoint frame history for `Last-Event-ID` resume. */
export class SseBuffer {
  private readonly byKey = new Map<string, { frame: SseFrame; at: number }[]>();

  private readonly options: SseOptions;

  constructor(options: SseOptions) {
    this.options = options;
  }

  append(key: string, frame: SseFrame): void {
    const list = this.byKey.get(key) ?? [];
    list.push({ frame, at: Date.now() });
    const cutoff = Date.now() - this.options.bufferMs;
    while (list.length > 0 && (list[0]!.at < cutoff || list.length > (this.options.maxFrames ?? 500))) list.shift();
    this.byKey.set(key, list);
  }

  /** Forget one key's frames. */
  remove(key: string): void {
    this.byKey.delete(key);
  }

  /** Frames after `lastId`, or undefined when it is no longer buffered. */
  since(key: string, lastId: number): SseFrame[] | undefined {
    const list = this.byKey.get(key);
    if (list === undefined) return undefined;
    const index = list.findIndex((entry) => entry.frame.id === lastId);
    if (index === -1) return undefined;
    return list.slice(index + 1).map((entry) => entry.frame);
  }
}

/** One connected client. */
export class SseWriter {
  private closed = false;
  private heartbeat: NodeJS.Timeout | undefined;
  /** The compressor, when this client asked for one; every write goes through it. */
  private gzip: Gzip | undefined;

  private readonly res: ServerResponse;
  private readonly options: SseOptions;
  private readonly onClose: (writer: SseWriter) => void;

  constructor(res: ServerResponse, options: SseOptions, onClose: (writer: SseWriter) => void) {
    this.res = res;
    this.options = options;
    this.onClose = onClose;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` stays: a proxy must not re-compress or buffer this. The
      // framing is ours, and an event that sits in a proxy buffer is an event the
      // reader sees late.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    const compress = acceptsGzip(res.req);
    if (compress) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
    }
    res.writeHead(200, headers);
    // A client that drops the connection makes the next write fail asynchronously,
    // and an unheard `error` on a response is an uncaught exception. Closing the
    // writer is the whole answer either way.
    res.on("error", () => this.close());
    if (compress) {
      const gzip = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
      gzip.on("error", () => this.close());
      gzip.pipe(this.res);
      this.gzip = gzip;
    }
    this.writeNow(`retry: ${options.retryMs ?? DEFAULT_RETRY_MS}\n\n`);
    this.heartbeat = setInterval(() => this.comment(`heartbeat ${new Date().toISOString()}`), options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: string, data: unknown, id?: number): void {
    if (this.closed) return;
    const frame: SseFrame = { id: id ?? 0, event, data: JSON.stringify(data ?? {}) };
    this.write(formatFrame(frame));
  }

  sendFrame(frame: SseFrame): void {
    if (this.closed) return;
    this.write(formatFrame(frame));
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`);
  }

  /**
   * Bytes written but not yet on the wire.
   *
   * `res.writableLength` is the answer for a `ServerResponse`: Node defines it as
   * the response's own queued bytes plus the socket's, so one number covers both
   * and nothing is counted twice. When the body is compressed, what is still
   * inside the compressor has not reached the socket either, so it is added: the
   * readable side is what `pipe` has not taken yet and the writable side is what
   * has not been compressed yet.
   */
  private unsentBytes(): number {
    const queued = this.res.writableLength ?? 0;
    const gzip = this.gzip;
    if (gzip === undefined) return queued;
    return queued + gzip.readableLength + gzip.writableLength;
  }

  /**
   * Write one frame, unless this client is already too far behind.
   *
   * The test is the real unsent byte count before the write, not a counter of
   * failed `write` calls. `res.write` returns `false` as soon as the socket's high
   * water mark is passed, which one large frame (the initial `snapshot`) always
   * does, so the return value says nothing about a client that stopped reading:
   * it is normal backpressure. What matters is the backlog this frame would join.
   * A lone oversized frame is therefore delivered, because nothing is waiting
   * behind it, and a client whose backlog passes the cap is disconnected on the
   * next frame with the notice first.
   */
  private write(text: string): void {
    if (this.closed) return;
    if (this.unsentBytes() > this.options.queueBytes) {
      try {
        this.writeNow(`event: notice\ndata: ${JSON.stringify({ type: "notice", code: "stream_lagging" })}\n\n`);
      } catch {
        /* the socket is already gone */
      }
      this.close();
      return;
    }
    this.writeNow(text);
  }

  /**
   * Put one piece of text on the stream, flushing it through the compressor.
   *
   * An event that is still inside `zlib`'s buffer reaches nobody, so every write
   * is followed by a sync flush: the reader can decode that event at once,
   * without waiting for the next one or for the end of the stream.
   */
  private writeNow(text: string): void {
    const gzip = this.gzip;
    if (gzip === undefined) {
      this.res.write(text);
      return;
    }
    try {
      gzip.write(text);
      gzip.flush(zlibConstants.Z_SYNC_FLUSH);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    const gzip = this.gzip;
    try {
      // `pipe` ends the response when the compressor does, and ending the
      // compressor flushes what is left of it.
      if (gzip !== undefined) gzip.end();
      else this.res.end();
    } catch {
      /* already closed */
    }
    this.onClose(this);
  }
}

export interface SseAttachOptions {
  /** Run after the writer has left the channel, in addition to the channel's own teardown. */
  readonly onClose?: (writer: SseWriter) => void;
  /**
   * `"always"` ignores `Last-Event-ID`, drops the caller's buffered frames and asks for
   * a snapshot. A caller does that when it cannot serve a resume: the frames it would
   * replay are not the whole story, because nothing was watching meanwhile.
   */
  readonly snapshot?: "auto" | "always";
}

/**
 * Answer a stream request that arrives after the shutdown began.
 *
 * A stream opened now would stay open and hold the HTTP server's close callback
 * back for good. The browser does not retry an event stream that answered with a
 * status other than 200 by itself, so the page's own stream client opens it again
 * after its backoff, and that request reaches the next daemon.
 */
export function refuseStream(res: ServerResponse): void {
  const header = res.getHeader("X-Request-Id");
  const requestId = typeof header === "string" ? header : "";
  apiError(res, 503, "shutting_down", "the server is shutting down", requestId);
}

/** Fan-out channel for one SSE endpoint. */
export class SseChannel {
  private readonly writers = new Set<SseWriter>();
  private closed = false;

  readonly key: string;
  private readonly options: SseOptions;
  private readonly buffer: SseBuffer;
  /** The next frame id of the hub, shared by every channel. */
  private readonly nextId: () => number;

  constructor(key: string, options: SseOptions, buffer: SseBuffer, nextId: () => number) {
    this.key = key;
    this.options = options;
    this.buffer = buffer;
    this.nextId = nextId;
  }

  /**
   * Attach a client; replays buffered frames when possible. Returns whether a
   * snapshot is still needed. After `closeAll` the client is refused with 503 and
   * no writer is made, so the writer is `undefined`.
   */
  attach(
    req: IncomingMessage,
    res: ServerResponse,
    options: SseAttachOptions = {},
  ): { writer: SseWriter | undefined; needsSnapshot: boolean } {
    if (this.closed) {
      refuseStream(res);
      return { writer: undefined, needsSnapshot: false };
    }
    const header = req.headers["last-event-id"];
    const lastId = typeof header === "string" ? Number.parseInt(header, 10) : Number.NaN;
    const buffered =
      options.snapshot === "always" || !Number.isFinite(lastId) ? undefined : this.buffer.since(this.key, lastId);

    const writer = new SseWriter(res, this.options, (closed) => {
      this.writers.delete(closed);
      options.onClose?.(closed);
    });
    this.writers.add(writer);
    req.on("close", () => writer.close());

    if (buffered !== undefined) {
      for (const frame of buffered) writer.sendFrame(frame);
      return { writer, needsSnapshot: false };
    }
    return { writer, needsSnapshot: true };
  }

  /** Publish an event to every attached client and to the resume buffer. */
  publish(event: string, data: unknown): void {
    const frame: SseFrame = { id: this.nextId(), event, data: JSON.stringify(data ?? {}) };
    this.buffer.append(this.key, frame);
    for (const writer of this.writers) writer.sendFrame(frame);
  }

  closeAll(): void {
    this.closed = true;
    for (const writer of [...this.writers]) writer.close();
  }

  get size(): number {
    return this.writers.size;
  }
}

/** Registry of SSE channels by endpoint key. */
export class SseHub {
  private readonly channels = new Map<string, SseChannel>();
  private readonly buffer: SseBuffer;

  private readonly options: SseOptions;
  private closed = false;
  /** One counter for every channel, so a frame id never repeats in this process. */
  private frameId = 0;

  constructor(options: SseOptions) {
    this.options = options;
    this.buffer = new SseBuffer(options);
  }

  /** Whether a channel with this key exists. */
  has(key: string): boolean {
    return this.channels.has(key);
  }

  /**
   * Remove a channel and its buffered frames. A client that still holds an id of
   * the removed channel matches no frame later, because ids never repeat, so it
   * gets a snapshot.
   */
  remove(key: string): void {
    this.channels.delete(key);
    this.buffer.remove(key);
  }

  channel(key: string): SseChannel {
    const existing = this.channels.get(key);
    if (existing !== undefined) return existing;
    const channel = new SseChannel(key, this.options, this.buffer, () => (this.frameId += 1));
    // A channel made after the close refuses its first client.
    if (this.closed) channel.closeAll();
    this.channels.set(key, channel);
    return channel;
  }

  /** Close every stream and refuse the ones that arrive later. */
  closeAll(): void {
    this.closed = true;
    for (const channel of this.channels.values()) channel.closeAll();
  }
}
