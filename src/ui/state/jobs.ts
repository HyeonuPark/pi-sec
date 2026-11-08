/**
 * The job tree, and the five lists the server keeps for the work panel.
 *
 * The sidebar's job list is read from `GET /api/jobs?shape=tree` and drawn from
 * a signal. A job event on the conversation stream names the change and not the
 * list, so the list is read back; a burst of events inside one second is one
 * read (the window), a read that is still running is never joined by a second
 * (the single flight), and one request that arrives during a read causes exactly
 * one more read afterwards, so the last state is the one drawn. A tab nobody
 * looks at pays nothing: an event marks the list dirty instead of reading it,
 * and the return to the tab reads it once.
 *
 * The five id lists beside the tree — the cleared jobs, the opened job titles,
 * the cleared inbox items, and the two revert queues — live on the server
 * (`GET`/`PATCH /api/preferences`). This module owns them because one read fills
 * all five and the job tree is their largest user; `state/inbox.ts` imports the
 * two inbox lists from here rather than keeping a second copy. The old browser
 * keys (`pi-sec-hidden-jobs` and the two beside them) are read once, carried to
 * the server, and then dropped.
 *
 * Screen state the operator makes — which group is folded, what is scrolled,
 * where the focus is — is not in this module: a fold is kept in
 * {@link collapsedJobs} (session only, never saved), and the rest belongs to the
 * elements themselves.
 */
import { signal } from "@preact/signals";
import type { JobNode, JobTreeResponse } from "../../shared/wire/jobs.ts";
import { request } from "../api/request.ts";
import { timezone } from "../mount.ts";
import { reconcileById } from "./keyed.ts";
import { showError } from "./toast.ts";

/** Statuses a job can be cleared from. A live job stays: hiding work in progress is not tidying. */
export const CLEARABLE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled", "failed"]);

/* ------------------------------------------------------------- the lists */

/** A list the server holds for the work panel. */
export interface UiPreferences {
  readonly hiddenJobs?: readonly string[];
  readonly expandedJobs?: readonly string[];
  readonly clearedInbox?: readonly string[];
  readonly revertQueueJobs?: readonly string[];
  readonly revertQueueInbox?: readonly string[];
}

/** The browser keys an older build wrote, read once and then dropped. */
export const LEGACY_KEYS = {
  hiddenJobs: "pi-sec-hidden-jobs",
  expandedJobs: "pi-sec-expanded-jobs",
  clearedInbox: "pi-sec-cleared-inbox",
} as const;

/** How many hides each revert queue remembers. */
export const REVERT_QUEUE_LIMIT = 10;

/**
 * The prefix that marks a queue entry as a group hide rather than one id. An
 * inbox id starts with `YYYYMMDD-`, so an id can never look like a group.
 */
export const HIDE_GROUP_PREFIX = "hide-all:";

/** Jobs cleared off the list. */
export const hiddenJobs = signal<ReadonlySet<string>>(new Set());

/** Job titles opened into the full-width block under the row. */
export const expandedJobs = signal<ReadonlySet<string>>(new Set());

/** Groups whose children are folded away. Session only: nothing is saved. */
export const collapsedJobs = signal<ReadonlySet<string>>(new Set());

/** Inbox items cleared off the list. Read by `state/inbox.ts`. */
export const clearedInbox = signal<ReadonlySet<string>>(new Set());

/** The last job hides, oldest first. */
export const revertQueueJobs = signal<readonly string[]>([]);

/** The last inbox hides, oldest first. */
export const revertQueueInbox = signal<readonly string[]>([]);

/** A set with `id` in it. The same set comes back when it was already there. */
export function addToSet(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (current.has(id)) return current;
  const next = new Set(current);
  next.add(id);
  return next;
}

/** A set without `id`. The same set comes back when it was not there. */
export function removeFromSet(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!current.has(id)) return current;
  const next = new Set(current);
  next.delete(id);
  return next;
}

/** A set from a stored list of ids. */
export function idSet(ids: readonly string[] | undefined): ReadonlySet<string> {
  const next = new Set<string>();
  if (Array.isArray(ids)) for (const id of ids) next.add(String(id));
  return next;
}

/** The ids a queue entry names: one for a single hide, many for a group. */
export function queueEntryIds(entry: string): readonly string[] {
  const text = String(entry);
  if (!text.startsWith(HIDE_GROUP_PREFIX)) return [text];
  return text
    .slice(HIDE_GROUP_PREFIX.length)
    .split(",")
    .filter((id) => id !== "");
}

/** Remember one hide at the tail of a queue, and drop the oldest past the limit. */
export function rememberHide(queue: readonly string[], id: string): readonly string[] {
  const next = queue.filter((entry) => entry !== id);
  next.push(id);
  while (next.length > REVERT_QUEUE_LIMIT) next.shift();
  return next;
}

/** Remember one group hide as a single entry at the tail of a queue. */
export function rememberHideGroup(queue: readonly string[], ids: readonly string[]): readonly string[] {
  if (ids.length === 0) return queue;
  const next = [...queue, HIDE_GROUP_PREFIX + ids.join(",")];
  while (next.length > REVERT_QUEUE_LIMIT) next.shift();
  return next;
}

/**
 * Save one list, and the revert queue that goes with it when the list has one.
 *
 * The server holds every list, so only what changed is sent, in one write: a
 * queue that arrived without its list would let the button undo a hide the list
 * does not show. A save that fails says so, because the point of moving this off
 * the browser was that the failure used to be invisible.
 */
export function savePreference(
  name: string,
  ids: readonly string[],
  queueName: string | null = null,
  queue: readonly string[] = [],
): void {
  const body: Record<string, readonly string[]> =
    queueName === null ? { [name]: [...ids] } : { [name]: [...ids], [queueName]: [...queue] };
  void request("/api/preferences", { method: "PATCH", body: JSON.stringify(body) }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    showError(`Could not save the ${name} list: ${message}`);
  });
}

/** The ids a browser's old key holds, or an empty list. */
function loadLegacyIds(key: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Load the server's lists, carrying over anything a browser still holds.
 *
 * A read that fails leaves every list as it is: without the server there is no
 * work panel to draw anyway, and the tree and the inbox read again on their own.
 */
export async function loadPreferences(): Promise<void> {
  let stored: UiPreferences;
  try {
    stored = (await request<UiPreferences>("/api/preferences")) ?? {};
  } catch {
    return;
  }

  const carried: Record<string, readonly string[]> = {};
  for (const [name, key] of Object.entries(LEGACY_KEYS)) {
    const local = loadLegacyIds(key);
    const already = stored[name as keyof UiPreferences] ?? [];
    if (local.length > 0 && already.length === 0) carried[name] = local;
  }

  if (Object.keys(carried).length > 0) {
    try {
      stored =
        (await request<UiPreferences>("/api/preferences", { method: "PATCH", body: JSON.stringify(carried) })) ??
        stored;
    } catch {
      /* keep what the server answered; the browser copy is dropped below */
    }
  }
  for (const key of Object.values(LEGACY_KEYS)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing to clean up */
    }
  }

  hiddenJobs.value = idSet(stored.hiddenJobs);
  expandedJobs.value = idSet(stored.expandedJobs);
  clearedInbox.value = idSet(stored.clearedInbox);
  revertQueueJobs.value = queueFrom(stored.revertQueueJobs);
  revertQueueInbox.value = queueFrom(stored.revertQueueInbox);
}

/** A revert queue from the server: oldest first, never longer than the limit. */
function queueFrom(ids: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(ids)) return [];
  return ids.slice(-REVERT_QUEUE_LIMIT).map(String);
}

/* -------------------------------------------------------------- the tree */

/** The job tree on screen. */
export const jobs = signal<readonly JobNode[]>([]);

/**
 * The old schedule list's error, as one value: a string when the server says a
 * `config.scheduler.jobs` list is still populated, and null otherwise. The field
 * rides on `GET /api/jobs`, so a reconnect does not clear a banner that is still
 * true.
 */
export const legacyScheduleProblem = signal<string | null>(null);

/** The problem a job answer carries, or null. */
export function legacyProblemOf(data: JobTreeResponse | undefined): string | null {
  const problem = data?.legacyScheduleProblem;
  return typeof problem === "string" && problem !== "" ? problem : null;
}

/**
 * Whether two job records carry the same fields. Both sides come from the
 * server's own JSON, so the field order of a record is stable and the text form
 * compares field by field, nested schedule and run records included.
 */
function sameJob(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Match a fresh tree to the one on screen by job id, so an unchanged node keeps
 * its object and only a changed one is replaced.
 */
export function reconcileTree(current: readonly JobNode[], incoming: readonly JobNode[]): readonly JobNode[] {
  const previous = new Map<string, JobNode>();
  for (const node of current) if (!previous.has(node.job.id)) previous.set(node.job.id, node);
  const prepared = incoming.map((node) => {
    const before = previous.get(node.job.id);
    const children = reconcileTree(before?.children ?? [], node.children ?? []);
    const job = before !== undefined && sameJob(before.job, node.job) ? before.job : node.job;
    return { job, children };
  });
  return reconcileById(current, prepared, (node) => node.job.id, (before, next) => {
    return before.job === next.job && before.children === next.children;
  });
}

/** Read the job tree once and draw it. A failed read keeps the last tree. */
export async function readJobs(): Promise<void> {
  try {
    const data = await request<JobTreeResponse>("/api/jobs?shape=tree");
    jobs.value = reconcileTree(jobs.value, data?.tree ?? []);
    legacyScheduleProblem.value = legacyProblemOf(data);
  } catch {
    /* ignore: the last tree stays on screen */
  }
}

/** The read in flight, if any. */
let readInFlight: Promise<void> | null = null;
/** One more read is wanted once the read in flight ends. */
let readAgain = false;
/** A job event arrived while the tab was hidden. */
let missed = false;
/** The one-second window, while it is open. */
let windowTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a burst of job events is collected before the one read it costs. */
export const JOBS_REFRESH_WINDOW_MS = 1000;

/**
 * Read the job tree, unless a read is already running. The caller gets the
 * running read; a request that arrived during it is served by one more read
 * that starts when that read ends.
 */
export function refreshJobs(): Promise<void> {
  if (readInFlight !== null) {
    readAgain = true;
    return readInFlight;
  }
  readInFlight = readJobs().finally(() => {
    readInFlight = null;
    if (readAgain) {
      readAgain = false;
      void refreshJobs();
    }
  });
  return readInFlight;
}

/**
 * A job event: read the tree back, at most once per window. A hidden tab holds
 * the request until it is looked at again.
 */
export function applyJobEvent(_type?: string): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    missed = true;
    return;
  }
  if (windowTimer !== undefined) return;
  windowTimer = setTimeout(() => {
    windowTimer = undefined;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      missed = true;
      return;
    }
    void refreshJobs();
  }, JOBS_REFRESH_WINDOW_MS);
}

/**
 * The tab came back. One read covers both the events a hidden tab was not told
 * about and a run that ended under the harness, which publishes no job event.
 */
export async function jobsTabVisible(): Promise<void> {
  missed = false;
  await refreshJobs();
}

/** Fold or unfold one group's children. Session only, so nothing is saved. */
export function toggleJobChildren(id: string): void {
  const key = String(id);
  collapsedJobs.value = collapsedJobs.value.has(key)
    ? removeFromSet(collapsedJobs.value, key)
    : addToSet(collapsedJobs.value, key);
}

/** Open or close one job's full-width title block, and save the list. */
export function toggleJobExpanded(id: string): void {
  const key = String(id);
  const expanded = expandedJobs.value.has(key);
  expandedJobs.value = expanded ? removeFromSet(expandedJobs.value, key) : addToSet(expandedJobs.value, key);
  savePreference("expandedJobs", [...expandedJobs.value]);
}

/** Clear one job off the list, remembering the hide for the revert button. */
export function clearJob(id: string): void {
  const key = String(id);
  hiddenJobs.value = addToSet(hiddenJobs.value, key);
  revertQueueJobs.value = rememberHide(revertQueueJobs.value, key);
  savePreference("hiddenJobs", [...hiddenJobs.value], "revertQueueJobs", revertQueueJobs.value);
}

/** Bring back the newest hidden job. */
export function revertJobs(): void {
  const queue = revertQueueJobs.value;
  const undone = queue[queue.length - 1];
  if (undone === undefined) return;
  revertQueueJobs.value = queue.slice(0, -1);
  hiddenJobs.value = removeFromSet(hiddenJobs.value, undone);
  savePreference("hiddenJobs", [...hiddenJobs.value], "revertQueueJobs", revertQueueJobs.value);
}

/* --------------------------------------------------------------- the clock */

/**
 * The harness time zone, from `<meta name="pi-sec-timezone">`. Missing or empty
 * means the page did not come from this server, and the harness default (UTC) is
 * what the stamps then say.
 */
export function harnessZone(): string {
  const stamped = timezone();
  return stamped === "" ? "UTC" : stamped;
}

/** One formatter per zone, so the page builds each of them once. */
const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A clock in one zone. A name `Intl` will not take falls back to UTC. */
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_FORMATS.get(timeZone);
  if (cached !== undefined) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    format = zoneFormat("UTC");
  }
  ZONE_FORMATS.set(timeZone, format);
  return format;
}

/**
 * The calendar fields of one instant, read in the harness zone. Null when it is
 * not a time.
 *
 * A row asks for the same instant on every draw (a job's `once.at`, its
 * `lastRun.at`), and each ask would run `formatToParts` again. One entry per
 * instant per tab is enough; the map is dropped whole once it grows past the
 * point where it would hold more stamps than a page can show.
 */
const ZONE_FIELDS = new Map<number, Record<string, string>>();
const ZONE_FIELDS_LIMIT = 5000;

function zoneFields(at: unknown): Record<string, string> | null {
  const ms = Number(at);
  if (at === null || at === undefined || !Number.isFinite(ms)) return null;
  const cached = ZONE_FIELDS.get(ms);
  if (cached !== undefined) return cached;
  const fields: Record<string, string> = {};
  for (const part of zoneFormat(harnessZone()).formatToParts(new Date(ms))) fields[part.type] = part.value;
  if (ZONE_FIELDS.size >= ZONE_FIELDS_LIMIT) ZONE_FIELDS.clear();
  ZONE_FIELDS.set(ms, fields);
  return fields;
}

/** One time in the harness zone, as `2030-01-15 14:00 UTC`. */
export function zoneStamp(at: unknown): string {
  const fields = zoneFields(at);
  if (fields === null) return "";
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${harnessZone()}`;
}

/** The same time, short enough for a row: `10.18 14:00`, with a no-break space. */
export function zoneRowStamp(at: unknown): string {
  const fields = zoneFields(at);
  if (fields === null) return "";
  return `${fields.month}.${fields.day}\u00A0${fields.hour}:${fields.minute}`;
}

/* ---------------------------------------------------------------- for tests */

/** Put this module back where a freshly loaded page starts. */
export function resetJobsState(): void {
  if (windowTimer !== undefined) clearTimeout(windowTimer);
  ZONE_FIELDS.clear();
  windowTimer = undefined;
  readInFlight = null;
  readAgain = false;
  missed = false;
  jobs.value = [];
  legacyScheduleProblem.value = null;
  hiddenJobs.value = new Set();
  expandedJobs.value = new Set();
  collapsedJobs.value = new Set();
  clearedInbox.value = new Set();
  revertQueueJobs.value = [];
  revertQueueInbox.value = [];
}
