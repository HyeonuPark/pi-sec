/**
 * One server event stream, and the rules for keeping it open.
 *
 * The rules are the ones the hand-written chat page followed (removed in this
 * commit), written once so every page that opens a stream gets the same
 * behaviour:
 *
 * - The browser reconnects a stream that dropped its connection on its own, and
 *   resumes it with `Last-Event-ID`. A stream the server answered with a non-200
 *   code is `CLOSED` in Chromium and is never retried by it, so this client opens
 *   the next one itself after 1 s, doubling the wait per failed attempt up to 30 s.
 * - Nothing is opened while the page is hidden. A reopen that came due then
 *   waits, and the return does it.
 * - A page hidden for 30 s or more opens a new stream when it comes back, because
 *   the stream it held may have been forgotten and its transcript is behind. A
 *   page restored by `pageshow` with `persisted`, and an `online` event, open a
 *   new stream for the same reason: the old one is gone or unusable.
 * - A page hidden for one minute gives up its stream. The close can come later
 *   than the minute, because a hidden tab's timers can be slowed; the wait is the
 *   minute, not the moment the timer ran.
 *
 * `EventSource` and the timers of the page code live in this folder and in
 * `src/ui/state/`; the source-rule test in `test/ui/state-and-sources.test.ts` holds
 * page code to that.
 */
import { at } from "../mount.ts";

/** The first wait before a stream the server closed is opened again. */
export const REOPEN_FIRST_MS = 1000;
/** The longest wait between attempts. */
export const REOPEN_MAX_MS = 30_000;
/** How long a page must have been hidden before its return opens a new stream. */
export const RETURN_REOPEN_MS = 30_000;
/** How long a page may stay hidden before it gives up its stream. */
export const HIDDEN_CLOSE_MS = 60_000;
/** The code an `EventSource` carries once it is closed and will not retry (`CLOSED`). */
const EVENT_SOURCE_CLOSED = 2;

/** One frame, handed to the listeners registered for its name. */
export interface StreamEvent<TData = unknown> {
  /** The frame's name, such as `snapshot` or `entry_appended`. */
  readonly name: string;
  /** The JSON the server wrote, parsed. A frame that is not JSON arrives as its text. */
  readonly data: TData;
  /** The frame id the browser reports, which is `""` when the server sent none. */
  readonly id: string;
  /** True for the whole-state frame a stream opens with. */
  readonly snapshot: boolean;
  /**
   * How many snapshots this client has received, counting this one. The first is
   * the page's own connection; every later one follows a reopen, and what a
   * stream would have announced while it was away is read again by the page.
   */
  readonly snapshotCount: number;
}

/** What the page does with a delivered frame. */
export type StreamListener = (event: StreamEvent) => void;

/** What a page tells the client when it starts it. */
export interface StreamClientOptions {
  /** The stream's route, such as `/api/jobs/events`. The mount is put on it here. */
  readonly path: string;
  /**
   * Called when the connection opens and when it is lost, so the page can mark
   * itself connected or offline. Not called for a stream it never opened.
   */
  onStateChange?: (connected: boolean) => void;
}

/**
 * One `EventSource`, its lifetime, and its reconnect rules.
 *
 * Listeners are registered per frame name with {@link on}; a frame is handed to
 * the listeners registered for its name and to nobody else. A listener registered
 * after the stream opened is subscribed to the open stream too.
 */
export class StreamClient {
  readonly #path: string;
  readonly #onStateChange: ((connected: boolean) => void) | undefined;
  readonly #listeners = new Map<string, Set<StreamListener>>();
  /** The names this source already carries a listener for. */
  #attached = new Set<string>();
  #source: EventSource | null = null;
  #reopenTimer: ReturnType<typeof setTimeout> | null = null;
  #hiddenCloseTimer: ReturnType<typeof setTimeout> | null = null;
  #delayMs = REOPEN_FIRST_MS;
  #reopenPending = false;
  #hiddenAt = 0;
  #snapshots = 0;
  #connected = false;
  #started = false;
  #stopped = false;
  #onVisibility: (() => void) | undefined;
  #onPageShow: ((event: PageTransitionEvent) => void) | undefined;
  #onOnline: (() => void) | undefined;

  constructor(options: StreamClientOptions) {
    this.#path = options.path;
    this.#onStateChange = options.onStateChange;
  }

  /** Whether the current stream is open. */
  get connected(): boolean {
    return this.#connected;
  }

  /** How many snapshots this client has received. */
  get snapshotCount(): number {
    return this.#snapshots;
  }

  /** Register a listener for one frame name. Returns the way to remove it. */
  on(name: string, listener: StreamListener): () => void {
    const set = this.#listeners.get(name) ?? new Set<StreamListener>();
    set.add(listener);
    this.#listeners.set(name, set);
    if (this.#source !== null) this.#attachName(this.#source, name);
    return () => {
      set.delete(listener);
    };
  }

  /** Open the stream, and start watching the ways a page stops being looked at. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#watch();
    this.#open();
  }

  /** Give up the stream: close it, drop every wait, and stop watching. */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#stopped = true;
    this.#unwatch();
    this.#clearReopen();
    this.#clearHiddenClose();
    this.#hiddenAt = 0;
    this.#closeSource();
  }

  /**
   * Close the stream this client holds and make a new one, at once.
   *
   * This is a return, not a failed attempt: the backoff of an attempt the page no
   * longer waits for is dropped, and the next failure starts again at one second.
   */
  reopenNow(): void {
    if (this.#stopped) return;
    this.#clearReopen();
    this.#delayMs = REOPEN_FIRST_MS;
    this.#reopen();
  }

  /** Open a source and hand its frames to the registered listeners. */
  #open(): void {
    if (this.#stopped) return;
    const source = new EventSource(at(this.#path));
    this.#source = source;
    this.#attached = new Set<string>();
    for (const name of this.#listeners.keys()) this.#attachName(source, name);
    source.addEventListener("open", () => {
      if (source !== this.#source) return;
      this.#setConnected(true);
      this.#delayMs = REOPEN_FIRST_MS;
    });
    source.addEventListener("error", () => {
      if (source !== this.#source) return;
      this.#setConnected(false);
      // A stream that lost its connection is `CONNECTING`, and the browser opens
      // the next one on its own schedule: this client adds nothing there. Only a
      // stream the browser gave up on is opened again here.
      if (source.readyState === EVENT_SOURCE_CLOSED) this.#scheduleReopen();
    });
  }

  /** Subscribe one frame name on one source, once. */
  #attachName(source: EventSource, name: string): void {
    if (this.#attached.has(name)) return;
    this.#attached.add(name);
    source.addEventListener(name, (event: Event) => {
      // A frame already in flight from a replaced stream must not be drawn by the
      // page that listens now.
      if (source !== this.#source) return;
      this.#dispatch(name, event as MessageEvent);
    });
  }

  /** Hand one frame to the listeners registered for its name. */
  #dispatch(name: string, message: MessageEvent): void {
    const snapshot = name === "snapshot";
    if (snapshot) this.#snapshots += 1;
    const raw = typeof message.data === "string" ? message.data : "";
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // A frame the server did not write as JSON arrives as its text.
    }
    const event: StreamEvent = {
      name,
      data,
      id: message.lastEventId ?? "",
      snapshot,
      snapshotCount: this.#snapshots,
    };
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }

  /**
   * Wait one backoff step, then open the stream again.
   *
   * A hidden page asks for nothing: the reopen is marked pending instead, and the
   * return does it.
   */
  #scheduleReopen(): void {
    if (this.#stopped) return;
    if (this.#hidden()) {
      this.#reopenPending = true;
      return;
    }
    if (this.#reopenTimer !== null) return;
    const delayMs = this.#delayMs;
    this.#delayMs = Math.min(this.#delayMs * 2, REOPEN_MAX_MS);
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = null;
      this.#reopen();
    }, delayMs);
  }

  /** Drop a waiting reopen, for the caller that is about to open the stream itself. */
  #clearReopen(): void {
    if (this.#reopenTimer !== null) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = null;
    this.#reopenPending = false;
  }

  /** Close the stream this client holds, and make a new one. */
  #reopen(): void {
    if (this.#stopped) return;
    this.#closeSource();
    this.#open();
  }

  /** Close the stream, so a replaced one hands the page nothing more. */
  #closeSource(): void {
    const source = this.#source;
    this.#source = null;
    if (source !== null) source.close();
    this.#setConnected(false);
  }

  /** Mark the stream open or lost, and tell the page when that changed. */
  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    this.#onStateChange?.(connected);
  }

  /** Whether the page is hidden now. A page with no document is never hidden. */
  #hidden(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }

  /** Watch the ways a page stops being looked at and comes back. */
  #watch(): void {
    if (typeof document !== "undefined") {
      this.#onVisibility = () => {
        this.#visibilityChanged();
      };
      document.addEventListener("visibilitychange", this.#onVisibility);
    }
    if (typeof window !== "undefined") {
      this.#onPageShow = (event) => {
        // The page came out of the back/forward cache, and the stream it held was
        // closed when it went in.
        if (event.persisted === true) this.reopenNow();
      };
      this.#onOnline = () => {
        // The network came back, which is the case a stream can be gone with no
        // error frame to say so.
        this.reopenNow();
      };
      window.addEventListener("pageshow", this.#onPageShow);
      window.addEventListener("online", this.#onOnline);
    }
  }

  /** Stop watching. */
  #unwatch(): void {
    if (typeof document !== "undefined" && this.#onVisibility !== undefined) {
      document.removeEventListener("visibilitychange", this.#onVisibility);
    }
    if (typeof window !== "undefined") {
      if (this.#onPageShow !== undefined) window.removeEventListener("pageshow", this.#onPageShow);
      if (this.#onOnline !== undefined) window.removeEventListener("online", this.#onOnline);
    }
    this.#onVisibility = undefined;
    this.#onPageShow = undefined;
    this.#onOnline = undefined;
  }

  /** Do what a hide and a return each call for. */
  #visibilityChanged(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      this.#hiddenAt = Date.now();
      this.#clearHiddenClose();
      // A long stay away ends the stream: the server's buffer for it runs out,
      // and a page nobody looks at asks for nothing. A short look at another tab
      // must not cost a fresh snapshot, which is what a new stream starts with.
      this.#hiddenCloseTimer = setTimeout(() => {
        this.#hiddenCloseTimer = null;
        if (document.visibilityState !== "hidden") return;
        this.#closeSource();
        this.#clearReopen();
        this.#reopenPending = true;
      }, HIDDEN_CLOSE_MS);
      return;
    }
    this.#clearHiddenClose();
    const awayMs = this.#hiddenAt === 0 ? 0 : Date.now() - this.#hiddenAt;
    this.#hiddenAt = 0;
    if (this.#reopenPending || awayMs >= RETURN_REOPEN_MS) this.reopenNow();
  }

  /** Drop the wait that closes a stream of a page that stayed hidden. */
  #clearHiddenClose(): void {
    if (this.#hiddenCloseTimer !== null) clearTimeout(this.#hiddenCloseTimer);
    this.#hiddenCloseTimer = null;
  }
}
