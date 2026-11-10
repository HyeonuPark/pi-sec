/**
 * The one left-hand slot of the chat page, and the drawer the work panel becomes
 * on a narrow screen.
 *
 * The report panel, the text snippet panel and the model login panel are three
 * `<aside>` elements in one grid cell (`src/web/index.html`, and the stylesheet
 * picks the one to show from `body[data-report|data-snippet|data-login]`). One
 * place, one document: opening any of them closes the other two, and `Esc`
 * closes whichever is open. That rule lives here and nowhere else, so no second
 * caller can open a panel beside one that is already up.
 *
 * On a narrow screen the work panel is a drawer over the very place these panels
 * open into, so opening one closes the drawer first: a notice tapped inside it
 * would otherwise look like nothing happened. On a wide screen the sidebar stays
 * where it is, because it is in flow there.
 *
 * What the report panel shows is here too. The record, its meta line and its text
 * are server values. What the reader did with them — the feedback field's text,
 * the scroll, the selection inside the prose — belongs to the components, which is
 * why reading the same report again writes these signals and touches nothing the
 * reader is holding.
 *
 * Nothing here draws. The components in `src/ui/chat/panels/` read these signals,
 * and `mountChatPanels` is the one call that puts them in the page.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import { requestText } from "../api/text.ts";
import { at } from "../mount.ts";
import { relativeTime } from "../components/relative-time.ts";
import { kindOf, standing } from "./reports.ts";
import { showError } from "./toast.ts";
import type { ReportApproval, ReportSummary } from "../../shared/wire/reports.ts";

/** Which of the three panels the one slot holds, or `null` when it is empty. */
export type PaneName = "report" | "snippet" | "login";

/** The panel in the slot now. */
export const openPane = signal<PaneName | null>(null);

/* ------------------------------------------------------------- the drawer */

/** The width below which the work panel is a drawer over the transcript. */
export const NARROW_QUERY = "(max-width: 860px)";

/** Whether the work panel is out. On a wide screen it is a column, so it is out. */
export const sidebarOpen = signal(true);

/**
 * Whether anything has moved the drawer yet.
 *
 * The shell's button is called `Toggle the work panel` until a press says which
 * way it would go; the hand-written page wrote `Hide`/`Show the work panel` from
 * the moment it moved the drawer, and from nowhere else. Keeping that order is
 * what makes the first paint's accessibility text the same as it always was.
 */
export const sidebarMoved = signal(false);

/** The browser's answer for the narrow breakpoint, read now. */
export function isNarrow(): boolean {
  if (typeof window === "undefined") return false;
  const view = window as Window & { matchMedia?: (query: string) => MediaQueryList };
  if (typeof view.matchMedia !== "function") return false;
  return view.matchMedia(NARROW_QUERY).matches === true;
}

/** Put the work panel out or away. */
export function setSidebar(open: boolean): void {
  sidebarOpen.value = open;
  sidebarMoved.value = true;
}

/** Whether the work panel is out. */
export function sidebarIsOpen(): boolean {
  return sidebarOpen.value;
}

/**
 * Follow the width, and answer what the mode became.
 *
 * Two sources say the same thing and both are watched, because a browser does not
 * promise either alone: the media query's own `change`, which is what the
 * hand-written page listened to, and a `resize` that reads the query again. A
 * crossing fires both in a browser, and the second read costs nothing.
 */
export function watchWidth(onChange: (narrow: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const view = window as Window & { matchMedia?: (query: string) => MediaQueryList };
  let last = isNarrow();
  const notify = (): void => {
    const narrow = isNarrow();
    if (narrow === last) return;
    last = narrow;
    onChange(narrow);
  };
  const list = typeof view.matchMedia === "function" ? view.matchMedia(NARROW_QUERY) : undefined;
  if (list !== undefined) {
    if (typeof list.addEventListener === "function") list.addEventListener("change", notify);
    else (list as MediaQueryList & { addListener?: (fn: () => void) => void }).addListener?.(notify);
  }
  view.addEventListener("resize", notify);
  return () => {
    if (list !== undefined) {
      if (typeof list.removeEventListener === "function") list.removeEventListener("change", notify);
      else (list as MediaQueryList & { removeListener?: (fn: () => void) => void }).removeListener?.(notify);
    }
    view.removeEventListener("resize", notify);
  };
}

/* --------------------------------------------------------------- the slot */

/** Let the focus go, rather than leave it on an element that is being hidden. */
function blurInside(doc: Document, selector: string): void {
  const pane = doc.querySelector(selector);
  const active = doc.activeElement;
  if (pane === null || !(active instanceof Element)) return;
  if (pane.contains(active) && typeof (active as HTMLElement).blur === "function") (active as HTMLElement).blur();
}

/** The element each panel was written as in the shell, for the focus it holds. */
const PANE_SELECTOR: Readonly<Record<PaneName, string>> = {
  report: "#report-pane",
  snippet: "#snippet-pane",
  login: "#login-pane",
};

/** What a panel's own module wants run when its panel closes (a poll to stop). */
const closeHooks = new Map<PaneName, Set<() => void>>();

/**
 * Run `hook` when the panel named closes, and answer the way to drop it.
 *
 * A panel that keeps a timer — the login panel reads its state once a second —
 * stops it from here rather than from every place that closes the slot, because
 * every one of those places is this module.
 */
export function onPaneClose(pane: PaneName, hook: () => void): () => void {
  const set = closeHooks.get(pane) ?? new Set<() => void>();
  set.add(hook);
  closeHooks.set(pane, set);
  return () => {
    set.delete(hook);
  };
}

/** Whether the panel named is the panel in the slot. */
export function paneIsOpen(pane: PaneName): boolean {
  return openPane.value === pane;
}

/**
 * Close whichever panel is up.
 *
 * The focus goes first: an element being hidden keeps it otherwise, and a reader
 * pressing `Esc` would be typing into something they can no longer see.
 */
export function closePane(doc: Document = document): void {
  const pane = openPane.value;
  if (pane === null) return;
  blurInside(doc, PANE_SELECTOR[pane]);
  openPane.value = null;
  for (const hook of closeHooks.get(pane) ?? []) hook();
}

/**
 * Take the slot for one panel: the other two go, the drawer on a narrow screen
 * goes, and the panel named is the one the stylesheet shows.
 */
export function takeSlot(pane: PaneName, doc: Document = document): void {
  if (openPane.value !== null && openPane.value !== pane) closePane(doc);
  if (isNarrow() && sidebarIsOpen()) setSidebar(false);
  openPane.value = pane;
}

/**
 * Run `work` in the task after this one.
 *
 * A press on a link that opens another tab ends in the browser's own navigation,
 * which happens in the same task, after every handler has returned. So page code
 * that closes something from a handler changes the screen the browser is about to
 * read: closing the report panel points its `Open page` link back at the report
 * list, and the new tab would open the list instead of the report. Waiting one
 * task puts the close behind that navigation. Timers belong in a state module, so
 * the wait is here and the two press handlers only say what to close.
 */
export function afterTheTask(work: () => void): void {
  setTimeout(work, 0);
}

/* --------------------------------------------------------- the report pane */

/** What the report panel shows. Every field is a server value but the panel's own. */
export interface ReportPaneView {
  /** The report open in the panel, or `null`. */
  readonly id: string | null;
  readonly title: string;
  /** `v3 · work · active · approved 5m ago`, as the panel writes it. */
  readonly meta: string;
  /** Where `Open page` goes. */
  readonly href: string;
  /** The markdown of the newest revision, or `null` before one is read. */
  readonly text: string | null;
  /** The read failed, so the panel says so instead of loading for ever. */
  readonly failed: boolean;
  /** The report and revision the shared feedback bar is pointed at. */
  readonly target: {
    readonly id: string;
    readonly version: number;
    readonly latest: number;
    readonly active: boolean;
    readonly kind: "plan" | "result" | "briefing";
    readonly approval: ReportApproval | undefined;
  } | null;
}

/** The state a closed panel starts from. */
function shutReportPane(): ReportPaneView {
  return { id: null, title: "Report", meta: "", href: at("/report"), text: null, failed: false, target: null };
}

/** The panel's own state. One signal, so a read writes it once. */
export const reportPane = signal<ReportPaneView>(shutReportPane());

/**
 * The report's standing as a word, or nothing while it is simply active.
 *
 * `status` is the server's word on all four states; the older flags are the
 * fallback, so a page talking to an older daemon still says something true.
 */
export function reportStanding(record: ReportSummary): string {
  const status = typeof record.status === "string" ? record.status : standing(record);
  return status === "active" ? "" : status;
}

/**
 * The approval fragment of the panel's meta line: `approved 5m ago`, or
 * `approved` when the record carries no usable time. Absent when the server
 * reports no approval for this revision.
 */
export function approvalMeta(approval: { readonly at?: number } | undefined): string {
  if (approval === undefined || approval === null) return "";
  const when = relativeTime(approval.at);
  return when === "" ? "approved" : `approved ${when}`;
}

/** The one-line standing the panel shows under its title. */
export function paneMeta(record: ReportSummary, version: number): string {
  return [
    `v${version}`,
    record.job === null || record.job === undefined ? "job missing" : record.job.title,
    reportStanding(record),
    approvalMeta(record.versions[version - 1]?.approval),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** Whether the report panel is the panel in the slot. */
export function reportPaneIsOpen(): boolean {
  return paneIsOpen("report");
}

/**
 * Raised by each open of the report panel and by its close. A read writes its
 * answer or its failure only while the serial is still its own, so an older read
 * of the same report cannot bring an older revision back.
 */
let paneSerial = 0;

/**
 * Close the report panel.
 *
 * The id goes with it, so a read still in flight fails its own guard instead of
 * opening the panel again on its own.
 */
export function closeReportPane(doc: Document = document): void {
  paneSerial += 1;
  if (!reportPaneIsOpen()) return;
  closePane(doc);
  reportPane.value = shutReportPane();
}

/**
 * Open one report, and read the newest revision of it.
 *
 * The panel keeps what it already shows while it reads the same report again: a
 * new revision, or a note left on it, corrects the screen the reader is looking
 * at rather than bringing a different document. Another report starts from the
 * loading line, which is the one case where the panel had nothing to show.
 */
export async function openReportPane(id: string, doc: Document = document): Promise<void> {
  const mine = ++paneSerial;
  const same = reportPane.value.id === id && reportPane.value.text !== null;
  takeSlot("report", doc);
  // The same report read again keeps what is on screen until the new text lands.
  if (!same) reportPane.value = { ...shutReportPane(), id };
  try {
    const record = await request<ReportSummary>(`/api/reports/${encodeURIComponent(id)}`);
    const version = record.versions.length;
    const text = await requestText(`/api/reports/${encodeURIComponent(id)}/versions/${version}`);
    // Another report was opened, or this one was closed, while the reads ran.
    if (mine !== paneSerial || reportPane.value.id !== id) return;
    reportPane.value = {
      id,
      title: record.title,
      meta: paneMeta(record, version),
      href: at(`/report/${encodeURIComponent(record.name)}`),
      text,
      failed: false,
      target: {
        id: record.id,
        version,
        latest: version,
        active: record.active === true,
        kind: kindOf(record),
        approval: record.versions[version - 1]?.approval,
      },
    };
  } catch (error) {
    if (mine !== paneSerial || reportPane.value.id !== id) return;
    reportPane.value = { ...reportPane.value, failed: true, text: null, target: null };
    const reason = error instanceof ApiError ? error.message : String(error);
    showError(`Could not load the report: ${reason}`);
  }
}

/* --------------------------------------------------------------- the rest */

/**
 * Write what the stylesheet reads of all this on the `<body>`: the three panel
 * flags and the drawer's.
 *
 * It is one function, written from the signals, so two callers cannot disagree
 * about which panel is up.
 */
export function applyBodyFlags(doc: Document = document): void {
  const pane = openPane.value;
  doc.body.dataset.report = pane === "report" ? "open" : "closed";
  doc.body.dataset.snippet = pane === "snippet" ? "open" : "closed";
  doc.body.dataset.login = pane === "login" ? "open" : "closed";
  doc.body.dataset.sidebar = sidebarOpen.value ? "open" : "closed";
}

/** Put this module back where a freshly loaded page starts. */
export function resetPanelState(doc: Document = document): void {
  openPane.value = null;
  sidebarOpen.value = true;
  sidebarMoved.value = false;
  reportPane.value = shutReportPane();
  applyBodyFlags(doc);
}
