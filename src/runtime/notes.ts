/**
 * The daemon's own recent diagnostics, as the operator sees them.
 *
 * Three things push notes: a config reload that failed, a report review that
 * could not be delivered, and a forwarded prefix that disagrees with the
 * configured mount. A note is the only trace some of those leave, so the list
 * has to stay readable: it is capped, a repeated message moves to the end
 * instead of piling up, and every note carries when it happened. Before this it
 * was an unbounded array of strings that grew for the life of the process, with
 * no timestamps and nothing on screen rendering it — which is why a wrong
 * forwarded prefix had to be found in devtools.
 */
export interface AdminNote {
  readonly at: number;
  readonly text: string;
}

/** How many notes are kept. Old ones are dropped; they are diagnostics, not a log. */
export const NOTE_LIMIT = 50;

export class AdminNotes {
  private readonly list: AdminNote[] = [];

  private readonly limit: number;

  constructor(limit: number = NOTE_LIMIT) {
    this.limit = limit;
  }

  /** Add a note, or move an identical one to the end with a fresh time. */
  add(text: string, at: number = Date.now()): void {
    const seen = this.list.findIndex((note) => note.text === text);
    if (seen !== -1) this.list.splice(seen, 1);
    this.list.push({ at, text });
    const excess = this.list.length - this.limit;
    if (excess > 0) this.list.splice(0, excess);
  }

  /** Oldest first, newest last — the order they happened in. */
  all(): readonly AdminNote[] {
    return [...this.list];
  }
}
