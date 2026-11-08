import type { PrListPayload } from "./list.ts";

/**
 * The memory copy of the pull request list, and the poll that keeps it fresh.
 *
 * This is the one place in the extension that holds state across requests. Every
 * other read goes to GitHub per request, as the original did; the list does not,
 * because a browser asks for it on every page open and on every change notice.
 *
 * The rules that matter, all of them the original's:
 *
 *   1. A forced refresh reads GitHub at once and replaces the copy. It never
 *      falls back to the old copy; a failed refresh rejects to the caller and
 *      leaves the copy as it was.
 *   2. A poll reads GitHub, and a failure is swallowed: the copy stays, and the
 *      next cycle tries again. One slow or failing GitHub must not end the loop.
 *   3. A poll cycle starts counting after the previous one finished, so two
 *      fetches never run at the same time even when GitHub is slow.
 *   4. The change callback fires only when a fetch replaces a populated copy with
 *      a different one. Filling an empty cache is not a change, because nobody
 *      was looking at the old one.
 *
 * The timer and the clock are injectable so a test drives cycles by hand instead
 * of waiting for them, and the timer is unreferenced so a live poll never keeps
 * the daemon awake on its own.
 */

/** The two timer operations this module needs, with `setTimeout`'s own shape. */
export interface ListCacheTimers {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** `setTimeout`/`clearTimeout`, with the timer unreferenced where Node allows it. */
export const systemTimers: ListCacheTimers = {
  set(handler, ms) {
    const handle = setTimeout(handler, ms);
    // A poll is background work: it must not be a reason for the process to stay.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface PrListCacheOptions {
  /** Reads GitHub. Rejects when any repository fails; the merge is all-or-nothing. */
  readonly fetch: () => Promise<PrListPayload>;
  /**
   * Seconds between the end of one poll and the start of the next. A function is
   * read at every cycle, so a config reload changes the pace without a restart.
   */
  readonly interval: number | (() => number);
  /** Called after a fetch replaced a populated copy with a different one. */
  readonly onChange?: () => void;
  /** Timer functions. Default `systemTimers`. */
  readonly timers?: ListCacheTimers;
}

export interface PrListCache {
  /** The copy in memory, or `undefined` before the first successful fetch. */
  current(): PrListPayload | undefined;
  /**
   * The copy, fetching first when there is none or when `force` is set. A failure
   * rejects and leaves the previous copy in place.
   */
  load(options?: { readonly force?: boolean }): Promise<PrListPayload>;
  /** Read GitHub now, replace the copy, notify on a change, and reject on failure. */
  refresh(): Promise<PrListPayload>;
  /** Start the poll. Calling it twice starts nothing new. */
  start(): void;
  /** Stop the poll. Calling it twice is harmless. */
  stop(): void;
  /**
   * Wait until the reads that are running or queued have finished.
   *
   * A read already under way keeps going after `stop`, and this is what lets a
   * caller wait for it instead of racing the work it does.
   */
  settled(): Promise<void>;
  /** Whether the poll loop is running. */
  readonly polling: boolean;
}

export function createPrListCache(options: PrListCacheOptions): PrListCache {
  const timers = options.timers ?? systemTimers;
  const intervalSeconds = typeof options.interval === "number" ? () => options.interval as number : options.interval;

  let data: PrListPayload | undefined;
  let polling = false;
  let timer: unknown;
  /** Bumped by `stop`, so a cycle that was already under way does not reschedule. */
  let generation = 0;
  /** The fetch in flight, so two cold loads at once share one read. */
  let inFlight: Promise<PrListPayload> | undefined;
  /**
   * The tail of the fetch queue.
   *
   * Reads run one at a time, in the order they were asked for, so a poll and a
   * forced refresh never interleave and the copy is always the newest finished
   * read rather than whichever read finished last. The original held a lock over
   * the same span for the same reason.
   */
  let queue: Promise<unknown> = Promise.resolve();

  const same = (a: PrListPayload, b: PrListPayload): boolean => JSON.stringify(a) === JSON.stringify(b);

  const fetchAndStore = (): Promise<PrListPayload> => {
    const run = queue.then(async () => {
      const previous = data;
      const next = await options.fetch();
      data = next;
      if (previous !== undefined && !same(previous, next)) options.onChange?.();
      return next;
    });
    // The queue never carries a rejection forward: a failed read is the caller's
    // to see and nobody else's.
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (loadOptions: { readonly force?: boolean } = {}): Promise<PrListPayload> => {
    if (loadOptions.force !== true) {
      if (data !== undefined) return data;
      // Two page opens before the first fetch finished share one read. A forced
      // refresh asks for its own read, because the caller wants GitHub now.
      if (inFlight !== undefined) return inFlight;
    }
    const started = fetchAndStore();
    if (loadOptions.force === true) return started;
    inFlight = started;
    try {
      return await started;
    } finally {
      inFlight = undefined;
    }
  };

  const schedule = (): void => {
    if (!polling) return;
    const ms = Math.max(0, intervalSeconds() * 1000);
    const mine = generation;
    timer = timers.set(() => {
      timer = undefined;
      if (!polling || mine !== generation) return;
      void load({ force: true })
        // A poll failure is expected sometimes: the copy stays, the next cycle
        // retries, and nothing is logged here because the loop is the report.
        .catch(() => undefined)
        // The wait starts now, after the fetch finished, which is what keeps two
        // cycles apart however long one takes.
        .finally(() => {
          if (!polling || mine !== generation) return;
          schedule();
        });
    }, ms);
  };

  return {
    current: () => data,
    load,
    refresh: () => load({ force: true }),
    start() {
      if (polling) return;
      polling = true;
      generation += 1;
      // The first cycle reads at once: a page opened at boot already has a list.
      const mine = generation;
      void load({ force: true })
        .catch(() => undefined)
        .finally(() => {
          if (!polling || mine !== generation) return;
          schedule();
        });
    },
    stop() {
      polling = false;
      generation += 1;
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
    },
    async settled() {
      // The queue grows when a read is added while this waits, so it is read
      // again after each turn: the last answer is the one that stayed put.
      for (;;) {
        const tail = queue;
        await tail.catch(() => undefined);
        if (tail === queue) return;
      }
    },
    get polling() {
      return polling;
    },
  };
}
