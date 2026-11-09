/**
 * The chat page's sidebar panels, and the one call that starts them.
 *
 * Five parts, in the order the operator reads them: the questions waiting on an
 * answer, the inbox (with its badge and `hide all` control), the notes, the job
 * tree, and the remote machines. Each part takes over one element of the shell
 * with `mountAt`, so the element keeps its place among its siblings and the
 * stylesheet's selectors keep finding it; the parts are keyed by the server's
 * ids, so an update changes the values it carries and nothing else.
 *
 * The page entry (`pages/chat.tsx`) is assembled by another branch. It calls
 * `mountSideParts()` once and `startSidePanels()` once, then hands the stream's
 * frames to `applyJobEvent`, `applyInboxFrame`, `applyQueryEvent` and
 * `applyMachineEvent`; those functions live in the state modules, so this file
 * never touches a stream.
 */
import { h, type VNode } from "preact";
import { mountAt } from "../mount.ts";
import { startFolds, type FoldPanel } from "../state/folds.ts";
import { applyInboxFrame, readInbox, startInboxAgeTimer, stopInboxAgeTimer, tickInboxAges } from "../state/inbox.ts";
import { applyJobEvent, jobsTabVisible, loadPreferences, refreshJobs } from "../state/jobs.ts";
import { applyMachineEvent, machinesTabVisible, refreshMachines } from "../state/machines.ts";
import { readPreferences } from "../state/preferences.ts";
import { refreshStatus } from "../state/run.ts";
import { openReportPane, reportPane, reportPaneIsOpen } from "../state/panels.ts";
import { applyQueryEvent, queriesClock, refreshQueries } from "../state/queries.ts";
import { InboxCount, InboxHideAll, InboxPanel } from "./inbox/InboxPanel.tsx";
import { JobsPanel, JobsWorkingBadge } from "./jobs/JobsPanel.tsx";
import { MachinesPanel } from "./machines/MachinesPanel.tsx";
import { NotesPanel } from "./notes/NotesPanel.tsx";
import { QueriesPanel } from "./queries/QueriesPanel.tsx";
import { PanelFold } from "./sidebar/PanelFold.tsx";

/**
 * A foldable panel's heading. `mountAt` draws a vnode that carries no props, and
 * the heading's props are fixed by the panel it belongs to: this is the one place
 * that says which.
 */
const foldHeading = (panel: FoldPanel, label: string, controls: string): VNode =>
  h(PanelFold, { panel, label, controls }) as VNode;

/** The elements of `src/web/index.html` the four panels take over. */
const PARTS: ReadonlyArray<readonly [string, () => VNode]> = [
  ["#queries", () => h(QueriesPanel, {})],
  // The heading of a foldable panel is the button that folds it, drawn from the
  // stored choice, and the badges beside it say what the fold would hide.
  ["#inbox-fold", () => foldHeading("inbox", "Inbox", "inbox")],
  ["#inbox-count", () => h(InboxCount, {})],
  ["#inbox-hide-all", () => h(InboxHideAll, {})],
  ["#inbox", () => h(InboxPanel, {})],
  ["#notes-panel", () => h(NotesPanel, {})],
  ["#jobs-fold", () => foldHeading("jobs", "Jobs", "jobs")],
  ["#jobs-working", () => h(JobsWorkingBadge, {})],
  ["#jobs", () => h(JobsPanel, {})],
  // The whole section, so the panel can hide itself while no machine is
  // registered. Mounting `#machines` would leave the heading on screen.
  ["#machines-panel", () => h(MachinesPanel, {})],
];

/**
 * Take over the sidebar's elements. The returned function puts the page back the
 * way the shell left it, for a page that is torn down.
 */
export function mountSideParts(doc: Document = document): () => void {
  const stops: Array<() => void> = [];
  // The fold is read before the first draw, so a panel the operator left folded
  // is never drawn open and then folded.
  stops.push(startFolds(doc));
  for (const [selector, vnode] of PARTS) {
    const element = doc.querySelector(selector);
    if (element === null) throw new Error(`the chat page has no element matching ${selector}`);
    stops.push(mountAt(element, vnode()));
  }
  return () => {
    for (const stop of stops) stop();
  };
}

/** The document whose visibility this module already listens to. */
let startedOn: Document | null = null;
/** The one visibility listener, kept so a torn-down page can drop it. */
let onVisibility: (() => void) | undefined;

/**
 * Read what the panels draw, and keep the parts that move with the clock moving.
 *
 * A return to the tab does three things and reads no list it does not need: the
 * inbox ages move once, the questions' ages are measured again, and the job tree
 * is read once — which covers both the events a hidden tab was not told about and
 * a run that ended under the harness without publishing a job event.
 */
/** What a caller may say about the read this does. */
export interface StartSidePanelsOptions {
  /**
   * Whether to read the status route for the notes panel. `false` for a page
   * whose header already reads it (`refreshStatus` fills the notes from the same
   * answer), so the route is read once for the whole page.
   */
  readonly readNotes?: boolean;
}

export async function startSidePanels(
  doc: Document = document,
  options: StartSidePanelsOptions = {},
): Promise<void> {
  startInboxAgeTimer();
  if (startedOn !== doc) {
    startedOn = doc;
    onVisibility = () => {
      if (doc.visibilityState !== "visible") return;
      tickInboxAges();
      queriesClock.value = Date.now();
      void jobsTabVisible();
      void machinesTabVisible();
      // Another browser may have changed the shared state while this tab was away.
      void readPreferences();
    };
    doc.addEventListener("visibilitychange", onVisibility);
  }
  // The cleared lists have to be in place before the first read draws a row, or
  // every row the operator cleared flashes back into view.
  await loadPreferences();
  // The notes come out of the status route, and that route is read once for the
  // whole page: the reader is `refreshStatus` (`state/run.ts`), which fills the
  // notes as well as the header's banners. A page whose header reads that route
  // passes `readNotes: false`, so one screen is not two reads of one route.
  const notes = options.readNotes === false ? [] : [refreshStatus()];
  await Promise.all([refreshJobs(), readInbox(), refreshQueries(), refreshMachines(), ...notes]);
}

/**
 * The stream came back and sent its whole state. The inbox and the questions
 * change only when a frame says so, and that frame went to nobody while the
 * stream was away, so both are read again; the job tree goes through its own
 * one-second window, which is what a reconnect costs anyway. An open report panel
 * is the same case: `report_updated` and `report_feedback` are the only frames
 * that re-read it, and a reconnect drops them, so the record it shows is read
 * again here.
 */
export function applySideSnapshot(): void {
  applyInboxFrame("snapshot");
  applyQueryEvent("snapshot");
  applyJobEvent("snapshot");
  applyMachineEvent();
  // A frame that named a change of the shared state went to nobody meanwhile.
  void readPreferences();
  const open = reportPane.value.id;
  if (open !== null && reportPaneIsOpen()) void openReportPane(open);
}

/** Stop the timers and the listener this module started. */
export function stopSidePanels(doc: Document = document): void {
  stopInboxAgeTimer();
  if (startedOn === doc && onVisibility !== undefined) doc.removeEventListener("visibilitychange", onVisibility);
  startedOn = null;
  onVisibility = undefined;
}
