/**
 * What pi-sec's judgement models cost, per judge name and per window.
 *
 * A judgement runs outside every conversation, so no row of the ledger counts it:
 * `records.ts` reads the model calls a conversation made, and a judge call is
 * written as one line of the audit trail instead (`logs/audit.jsonl`, `type:
 * "judge"`). This module turns those lines into the three windows the usage
 * screen shows: the last 24 hours, the last 7 days and the last 30 days, each
 * ending at the moment of the read. A line timed after the read counts in no
 * window until that moment comes.
 *
 * Four rules hold here.
 *
 * - **The audit trail is read, never written.** The daemon appends to it through
 *   `createAuditLog`, and this is a reader of the files that log leaves behind.
 * - **The rotated files are read too.** The log renames itself to
 *   `<file>.<stamp>` when it passes `audit.maxBytes`, so a window of 30 days can
 *   hold more than one file. Every file beside the live one whose name starts
 *   with the live one's name is read, and a line that falls outside the window is
 *   dropped by its own `time`.
 * - **A count is a count of lines.** `calls` is every judgement line in the
 *   window, whatever its outcome, so the number a reader sees is the number of
 *   judgements the audit trail records. `unanswered` is the part of it that gave
 *   no answer: a failed call and a skipped one. A skipped judgement asked no
 *   model, and it is still a judgement that did not happen, which is the fact a
 *   reader needs when a judge is misconfigured.
 * - **No line's text is carried.** A judgement line holds the name, the provider,
 *   the model, the outcome, the token counts and the cost, and the text under
 *   judgement is never written to it. This module reads exactly those fields, so
 *   nothing the judge was shown can reach the answer.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { USAGE_WINDOW_MS, type UsageWindowName } from "./records.ts";

/** One window of one judge's calls. */
export interface JudgeWindowSums {
  /** Every judgement line in the window, answered or not. */
  readonly calls: number;
  /** The tokens the service reported using, over those lines. */
  readonly tokens: number;
  /** The cost the service reported, over those lines, in dollars. */
  readonly cost: number;
  /** The lines that gave no answer: failed and skipped ones. */
  readonly unanswered: number;
}

/** The three windows of one judge. */
export type JudgeWindows = Readonly<Record<UsageWindowName, JudgeWindowSums>>;

/** One judge, as the audit trail records it. */
export interface JudgeUsageRow {
  readonly name: string;
  /** The provider the recorded calls used, or null when no line states one. */
  readonly provider: string | null;
  /** The model id the recorded calls used, or null when no line states one. */
  readonly model: string | null;
  readonly windows: JudgeWindows;
}

/** A window with no judgement in it. */
export const NO_JUDGE_SUMS: JudgeWindowSums = { calls: 0, tokens: 0, cost: 0, unanswered: 0 };

/** Every window at zero, for a judge the config names and the audit trail never saw. */
export const NO_JUDGE_WINDOWS: JudgeWindows = {
  day: NO_JUDGE_SUMS,
  week: NO_JUDGE_SUMS,
  month: NO_JUDGE_SUMS,
};

export interface JudgeUsageOptions {
  /** `paths.auditLog`: the live file, whose rotated neighbours are read as well. */
  readonly file: string;
}

/** The sums of one judge while the files are being read. */
interface Counting {
  provider: string | null;
  model: string | null;
  day: { calls: number; tokens: number; cost: number; unanswered: number };
  week: { calls: number; tokens: number; cost: number; unanswered: number };
  month: { calls: number; tokens: number; cost: number; unanswered: number };
}

function counting(): Counting {
  return {
    provider: null,
    model: null,
    day: { calls: 0, tokens: 0, cost: 0, unanswered: 0 },
    week: { calls: 0, tokens: 0, cost: 0, unanswered: 0 },
    month: { calls: 0, tokens: 0, cost: 0, unanswered: 0 },
  };
}

/** A finite count or cost, or 0 for anything else. */
function numberOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return 0;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The files one audit trail consists of: the live file and every rotated file
 * beside it.
 *
 * `rotateBySize` renames the live file to `<file>.<ISO stamp>`, so the neighbours
 * of one trail share its name as a prefix. The list is sorted, which puts the
 * live file first on most file systems and costs nothing where it does not: the
 * order of the files does not change a sum.
 */
async function auditFiles(file: string): Promise<string[]> {
  const directory = dirname(file);
  const live = basename(file);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // No log directory yet: an installation that never recorded an event has no
    // judgement either.
    return [];
  }
  return names
    .filter((name) => name === live || name.startsWith(`${live}.`))
    .sort()
    .map((name) => join(directory, name));
}

/**
 * The judgement lines of one file, parsed.
 *
 * A line that is not JSON, or that is JSON of another type, is skipped: a file
 * half written by a crash, or a line of another event, is no reason to lose the
 * rest of the trail.
 */
function linesOf(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* skip a corrupt line */
    }
  }
  return events;
}

/**
 * The in-memory sums over one audit trail.
 *
 * One instance belongs to the usage route. It holds the file path and nothing
 * else: the work a read does is one pass over the files, and the caller decides
 * when to repeat it (the service reuses one read for ten minutes).
 */
export class JudgeUsage {
  readonly #file: string;

  constructor(options: JudgeUsageOptions) {
    this.#file = options.file;
  }

  /**
   * Every judge the audit trail records in the last 30 days, by name.
   *
   * A file that cannot be read is skipped the way a corrupt line is: the rest of
   * the trail still counts, and a trail nothing can read answers an empty map,
   * which the caller turns into "no judgement card" rather than into an error on
   * a page about spending.
   */
  async rows(now: number): Promise<Map<string, JudgeUsageRow>> {
    const oldest = now - USAGE_WINDOW_MS.month;
    const counted = new Map<string, Counting>();

    for (const file of await auditFiles(this.#file)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const event of linesOf(text)) {
        if (event["type"] !== "judge") continue;
        const judge = textOf(event["judge"]);
        if (judge === null) continue;
        const at = typeof event["time"] === "number" ? event["time"] : Number(event["time"]);
        if (!Number.isFinite(at) || at < oldest || at > now) continue;

        let sums = counted.get(judge);
        if (sums === undefined) {
          sums = counting();
          counted.set(judge, sums);
        }
        // The first line that states them names the provider and the model of
        // this judge. A later line that states another model of the same name is
        // a judge whose config changed, and the current config states which one
        // is meant, so the name is filled once and the caller prefers the config.
        sums.provider ??= textOf(event["provider"]);
        sums.model ??= textOf(event["model"]);

        const tokens = numberOf(event["totalTokens"]);
        const cost = numberOf(event["costUsd"]);
        const outcome = event["outcome"];
        const unanswered = outcome === "failed" || outcome === "skipped" ? 1 : 0;
        for (const window of ["day", "week", "month"] as const) {
          if (at < now - USAGE_WINDOW_MS[window]) continue;
          const sum = sums[window];
          sum.calls += 1;
          sum.tokens += tokens;
          sum.cost += cost;
          sum.unanswered += unanswered;
        }
      }
    }

    const rows = new Map<string, JudgeUsageRow>();
    for (const [judge, sums] of counted) {
      rows.set(judge, {
        name: judge,
        provider: sums.provider,
        model: sums.model,
        windows: { day: { ...sums.day }, week: { ...sums.week }, month: { ...sums.month } },
      });
    }
    return rows;
  }
}
