/**
 * The report page's state, and the server reads that fill it.
 *
 * The page is two screens behind one shell: the list (`/report`) and one report
 * (`/report/<slug>`). What is on screen is a signal here, and so is the little
 * the reader decides for themselves: which revision they are reading and whether
 * the comparison is on. The server never writes those two signals, which is the
 * rule the whole rewrite turns on: a read that comes back
 * while a revision is chosen leaves the choice alone, and a report that is read
 * again does not take the reader back to the newest revision.
 *
 * The two lists are matched to the ones drawn before them by the report id
 * (`reconcileById`), so a row whose report did not change keeps its object, and
 * with it the element under it, its focus and its place in the scroll.
 *
 * Nothing here draws. The page reads these signals and the components draw them,
 * which is what keeps a read from rewriting a region wholesale.
 */
import { signal } from "@preact/signals";
import type { LineDiff, ReportListAnswer, ReportStanding, ReportSummary } from "../../shared/wire/reports.ts";
import type { ReportDetail } from "../../shared/wire/reports.ts";
import { at } from "../mount.ts";
import { request } from "../api/request.ts";
import { requestText } from "../api/text.ts";
import { reconcileById } from "./keyed.ts";
import { showError } from "./toast.ts";

/** Which screen the shell shows. */
export type ReportPageMode = "list" | "viewer" | "unknown-mount";

/** The screen the shell shows now. */
export const pageMode = signal<ReportPageMode>("list");

/** The job the list is narrowed to, from `?job=<id>`, or `null` for every job. */
export const jobFilter = signal<string | null>(null);

/**
 * The reports the list draws, in the order the server sent them, or `null` before
 * the first read answers. `null` is what draws `Loading…`; a re-read leaves the
 * rows it had, so a fast button does not look like a broken one.
 */
export const listReports = signal<readonly ReportSummary[] | null>(null);

/** The archived reports, which the list folds into one closed section. */
export const listArchived = signal<readonly ReportSummary[]>([]);

/** True while the list is being read again, so a second press waits for the first. */
export const listBusy = signal(false);

/** True when the first read of the list failed, so the view says so instead of `Loading…`. */
export const listFailed = signal(false);

/** The report the viewer shows, or `null` before it is read. */
export const viewerReport = signal<ReportDetail | null>(null);

/** True when the report in the address could not be read at all. */
export const viewerFailed = signal(false);

/**
 * The revision the reader is on. Chosen by the reader, and kept across a read:
 * `readReport` honours it while the report still has that revision.
 */
export const openVersion = signal(0);

/** Whether the body shows the comparison instead of the prose. The reader's choice. */
export const compareMode = signal(false);

/** The markdown of {@link openVersion}, as the server wrote it. */
export const bodyText = signal("");

/** The comparison of {@link openVersion} with the revision before it. */
export const reportDiff = signal<LineDiff | null>(null);

/** The list's own URL, which is also where a send goes. It carries the mount. */
export function listUrl(): string {
  return at("/report");
}

/** One report's URL, from its slug. It carries the mount, as every route does. */
export function reportUrl(name: string): string {
  return at(`/report/${encodeURIComponent(name)}`);
}

/**
 * Where one report stands, in one word.
 *
 * The server sends `status`; the older flags are the fallback, so a page talking
 * to an older daemon still draws something true. `inactive` is a report whose job
 * ended, which the list calls `Finished`.
 */
export function standing(report: ReportSummary): ReportStanding {
  if (typeof report.status === "string") return report.status;
  return report.archived ? "archived" : report.active ? "active" : "inactive";
}

/**
 * The kind of a report as the bar needs it.
 *
 * Three kinds now, and `plan` is still what an absent or unknown value means: a
 * page talking to an older daemon draws the report it always drew.
 */
export function kindOf(report: ReportSummary): "plan" | "result" | "briefing" {
  if (report.kind === "result" || report.kind === "briefing") return report.kind;
  return "plan";
}

/** The sentence a failure is shown with: the server's message when it wrote one. */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/**
 * Read the list and put it in the signals.
 *
 * The narrowing to one job is done here rather than by the server, because the
 * page asks for every report anyway: the archive is a second list in the same
 * answer, and the hint above the rows names the job from these rows.
 */
export async function readList(): Promise<void> {
  const job = jobFilter.value;
  const answer = await request<ReportListAnswer>("/api/reports?includeArchived=true");
  const all = answer.reports ?? [];
  const archived = answer.archived ?? [];
  const mine = job === null ? all : all.filter((report) => report.jobId === job);
  const archivedMine = job === null ? archived : archived.filter((report) => report.jobId === job);
  listReports.value = reconcileById(listReports.value ?? [], mine, (report) => report.id);
  // An archived briefing is left out of the Archive section: the user sees the
  // newest briefing and nothing older, and an older one is still read by id by the
  // agent tools. A report archived with its job keeps its place there.
  listArchived.value = reconcileById(listArchived.value, archivedMine.filter((report) => kindOf(report) !== "briefing"), (report) => report.id);
}

/** The first read of the list: `Loading…` until it answers, then the rows or the failure. */
export async function openList(): Promise<void> {
  pageMode.value = "list";
  listFailed.value = false;
  try {
    await readList();
  } catch (error) {
    listFailed.value = true;
    showError(`Could not load: ${messageOf(error)}`);
  }
}

/**
 * Read the list again, in place: the rows on screen stay until the answer
 * arrives, and only the reports that changed become new elements.
 */
export async function reloadList(): Promise<void> {
  if (listBusy.value) return;
  listBusy.value = true;
  try {
    await readList();
  } catch (error) {
    showError(`Could not reload the list: ${messageOf(error)}`);
  } finally {
    listBusy.value = false;
  }
}

/**
 * Read one report by its slug.
 *
 * With `keepChosen` the reader's revision is taken when the answer arrives, not
 * when the request left: it is honoured when the report still has that revision,
 * so a reader who moved off the newest one, or who chose another revision during
 * the read, is not moved back by a read that comes from somewhere else.
 */
async function readReport(name: string, keepChosen = false): Promise<void> {
  const report = await request<ReportDetail>(`/api/reports/by-name/${encodeURIComponent(name)}`);
  // A report always has at least one revision, so an answer without the list is
  // not a report: it is a wrong address or a page talking to something else. It
  // fails like any other answer that cannot be used, instead of drawing a head
  // with no revision behind it.
  if (!Array.isArray(report.versions)) throw new Error("the answer carried no revisions");
  const keep = openVersion.value;
  viewerReport.value = report;
  openVersion.value = keepChosen && report.versions.some((entry) => entry.n === keep) ? keep : report.versions.length;
}

/** Read one report for the viewer, then its body. */
export async function openReport(name: string): Promise<void> {
  pageMode.value = "viewer";
  viewerFailed.value = false;
  try {
    await readReport(name);
  } catch (error) {
    viewerFailed.value = true;
    showError(`Could not load: ${messageOf(error)}`);
    return;
  }
  await refreshViewer();
}

/**
 * Read what the body shows again: the markdown of the revision on screen, and
 * the comparison when it is on. The writer of this function's callers is what
 * keeps a version change, the compare box and a report read in step.
 */
export async function refreshViewer(): Promise<void> {
  const mine = ++viewerSerial;
  await loadBody(mine);
  if (mine === viewerSerial && compareMode.value) await loadDiff(mine);
}

/**
 * Raised by each read of the viewer. An answer is drawn only while the serial is
 * still its own, so a late answer for a revision the reader left changes nothing.
 */
let viewerSerial = 0;

/** Read the markdown of the revision on screen. A failure says so and leaves an empty body. */
async function loadBody(mine: number): Promise<void> {
  const report = viewerReport.value;
  if (report === null) return;
  const version = openVersion.value;
  try {
    const text = await requestText(`/api/reports/${encodeURIComponent(report.id)}/versions/${version}`);
    if (mine === viewerSerial) bodyText.value = text;
  } catch {
    if (mine !== viewerSerial) return;
    bodyText.value = "";
    showError("Could not load that revision.");
  }
}

/**
 * Read the comparison of the revision on screen with the one before it.
 *
 * The first revision has nothing before it, so it is identical to itself and no
 * request is made — which is what the old page did before it asked the server.
 */
async function loadDiff(mine: number): Promise<void> {
  const report = viewerReport.value;
  if (report === null) return;
  const to = openVersion.value;
  const from = Math.max(1, to - 1);
  if (from === to) {
    reportDiff.value = { identical: true, hunks: [], added: 0, removed: 0, truncated: false };
    return;
  }
  try {
    const diff = await request<LineDiff>(`/api/reports/${encodeURIComponent(report.id)}/diff?from=${from}&to=${to}`);
    if (mine === viewerSerial) reportDiff.value = diff;
  } catch {
    if (mine !== viewerSerial) return;
    reportDiff.value = null;
    showError("Could not load the comparison.");
  }
}

/** The reader chose a revision: the choice is theirs, and the body follows it. */
export function chooseVersion(n: number): void {
  openVersion.value = n;
  void refreshViewer();
}

/** The reader turned the comparison on or off; the body follows it. */
export function setCompare(on: boolean): void {
  compareMode.value = on;
  void refreshViewer();
}

/**
 * The report changed under the screen — a new revision, a recorded approval, or a
 * stored feedback entry. The server is the truth about all three, so it is read
 * again rather than patched up here, and the revision on screen is kept.
 */
export async function reloadReport(): Promise<void> {
  const report = viewerReport.value;
  if (report === null) return;
  try {
    await readReport(report.name, true);
  } catch (error) {
    showError(`Could not reload the report: ${messageOf(error)}`);
  }
  await refreshViewer();
}

/**
 * The report on screen as the approval control needs it, or `null` when there is
 * none.
 *
 * The kind travels with it, because the kind is what decides how many buttons the
 * bar draws. A report the server describes without one is a plan, which is the
 * reading a page talking to an older daemon has to make anyway.
 */
export function barTarget(): {
  readonly id: string;
  readonly version: number;
  readonly latest: number;
  readonly active: boolean;
  readonly kind: "plan" | "result" | "briefing";
  readonly approval: { at: number; via: "viewer" | "panel"; sha256: string; button?: "done"; text?: string } | undefined;
} | null {
  const report = viewerReport.value;
  if (report === null) return null;
  const version = openVersion.value;
  return {
    id: report.id,
    version,
    latest: report.versions.length,
    active: report.active === true,
    kind: kindOf(report),
    approval: report.versions.find((entry) => entry.n === version)?.approval,
  };
}
