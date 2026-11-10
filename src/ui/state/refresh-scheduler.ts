/**
 * One refresh scheduler for a panel that reads a list and hears events about it.
 *
 * The rules, shared by the jobs panel and the machines panel:
 * - One read runs at a time. A request during a read is served by one more read
 *   that starts when that read ends, and the caller gets the read in flight.
 * - A burst of events costs one read per window.
 * - A hidden tab reads nothing. Looking at the tab again reads once, which
 *   covers the events it was not told about.
 */

export interface RefreshScheduler {
  /** Read now, or once more after the read in flight. */
  refresh(): Promise<void>;
  /** An event: read at most once per window, and never while the tab is hidden. */
  event(): void;
  /** The tab came back: read once. */
  visible(): Promise<void>;
  /** Cancel the window timer and forget the read in flight. */
  reset(): void;
}

function tabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function createRefreshScheduler(read: () => Promise<void>, windowMs: number): RefreshScheduler {
  let readInFlight: Promise<void> | null = null;
  let readAgain = false;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;

  function refresh(): Promise<void> {
    if (readInFlight !== null) {
      readAgain = true;
      return readInFlight;
    }
    readInFlight = read().finally(() => {
      readInFlight = null;
      if (readAgain) {
        readAgain = false;
        void refresh();
      }
    });
    return readInFlight;
  }

  return {
    refresh,
    event(): void {
      if (tabHidden() || windowTimer !== undefined) return;
      windowTimer = setTimeout(() => {
        windowTimer = undefined;
        if (tabHidden()) return;
        void refresh();
      }, windowMs);
    },
    visible: refresh,
    reset(): void {
      if (windowTimer !== undefined) clearTimeout(windowTimer);
      windowTimer = undefined;
      readInFlight = null;
      readAgain = false;
    },
  };
}
