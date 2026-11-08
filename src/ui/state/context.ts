/**
 * How full the shown conversation's context is: the thin bar above the composer
 * and the readout in the sidebar footer.
 *
 * The ratio is taken against the usable maximum, not the model's window: a full
 * bar is the point where compaction fires, and the window is in the hover text
 * for when the difference matters. The numbers come from the server
 * (`GET …/context`), so this bar and the `usage` tool cannot report different
 * things about the same context.
 *
 * One read at a time, and one more queued behind it: a burst of events lands
 * while a read is on its way, and the operator wants the last state, not a
 * queue of reads that each draw a state older than the one before it.
 */
import { computed, signal } from "@preact/signals";
import { request } from "../api/request.ts";
import { routes } from "./conversation.ts";

/** What `GET …/context` answers. A fresh context has no `used` yet. */
export interface ContextUsage {
  readonly used?: number | null;
  readonly max?: number | null;
  readonly window?: number | null;
  readonly reserveTokens?: number | null;
}

/** The last reading, or `null` before the first one. */
export const contextUsage = signal<ContextUsage | null>(null);

/**
 * The entry kinds that move the bar.
 *
 * An answer is the request that filled the context, a reset starts an empty one,
 * and a compaction summary drops it. Everything else a run commits (tool results,
 * section updates) only reaches the next request, which the answer after it
 * reports.
 */
export const CONTEXT_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.assistant", "pi.reset", "pi.compaction"]);

/** The tokens in use, or `null` before an answer has been measured. */
export const contextUsed = computed<number | null>(() => {
  const used = contextUsage.value?.used;
  return typeof used === "number" ? used : null;
});

/** The usable maximum, or `null` when the server did not say. */
export const contextMax = computed<number | null>(() => {
  const max = contextUsage.value?.max;
  return typeof max === "number" ? max : null;
});

/** How full the bar is, in percent. Zero before there is anything to measure. */
export const contextRatio = computed<number>(() => {
  const used = contextUsed.value;
  const max = contextMax.value;
  return used !== null && max !== null && max > 0 ? (used / max) * 100 : 0;
});

/** A count with its thousands separated, for a hover text that is read exactly. */
function grouped(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A token count in thousands, for a sidebar that is read at a glance:
 * `10659` is `10.7k`, and `950` stays `950`.
 */
export function tokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** The exact counts, the window and what is held back, for both hover texts. */
export const contextExact = computed<string>(() => {
  const context = contextUsage.value;
  const used = contextUsed.value;
  const max = contextMax.value;
  if (used === null) return "No answer in this context yet.";
  const window = typeof context?.window === "number" ? grouped(context.window) : null;
  const reserve = grouped(typeof context?.reserveTokens === "number" ? context.reserveTokens : 0);
  return (
    `${grouped(used)} / ${max === null ? "?" : grouped(max)} tokens (${contextRatio.value.toFixed(1)}%)` +
    (window === null ? "" : ` · window ${window}, ${reserve} held back for the answer`)
  );
});

/** The sidebar row: `10.7k / 983.6k`, `—` before an answer, `950` with no maximum. */
export const contextReadout = computed<string>(() => {
  const used = contextUsed.value;
  const max = contextMax.value;
  if (used === null) return "—";
  return max === null ? tokens(used) : `${tokens(used)} / ${tokens(max)}`;
});

/** Whether a read is on its way. */
let inFlight = false;
/** Whether a call landed while that read was on its way, and wants one more. */
let queued = false;

/**
 * Read the context usage. Called where it could have moved: a fresh page, a
 * snapshot, the end of a run, an answer, and an entry that heads a context.
 *
 * A read already in flight absorbs the call, and a burst that lands during it
 * queues exactly one more, so the last state is always the one drawn. A read that
 * fails keeps the last reading: one failed read is not a reason to blank the bar.
 */
export async function refreshContext(): Promise<void> {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  try {
    for (;;) {
      queued = false;
      try {
        contextUsage.value = (await request<ContextUsage>(routes.context)) ?? null;
      } catch {
        // Keep the last reading.
      }
      if (!queued) return;
    }
  } finally {
    inFlight = false;
  }
}
