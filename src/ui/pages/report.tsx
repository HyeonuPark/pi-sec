/**
 * The report page's entry module: the shell, and the two screens behind it.
 *
 * One page serves both `/report` (the list) and `/report/<slug>` (one report).
 * The page reads its own path rather than a query parameter, so a report can be
 * linked, bookmarked and shared as itself (the hand-written report page did the
 * same).
 *
 * The shell is the one `src/web/report.html` writes: a header whose buttons this
 * page owns, a scrolling row that holds the view, and the feedback bar as the
 * shell's last row so it stays on screen wherever the reader has scrolled. Each
 * of those is taken over with `mountAt`, one element at a time, so the elements
 * and their classes are the ones the stylesheet already names and the server's
 * own children — nothing here draws outside its place.
 *
 * The page itself is short on purpose: what it reads and what the reader chose is
 * in `src/ui/state/reports.ts`, what a report looks like is in
 * `src/ui/components/report-view.tsx`, and what the bar does is in
 * `src/ui/components/feedback.tsx`. This file is the wiring between them and the
 * three things that belong to the document: the address, the tab title and the
 * visual viewport.
 */
import { mount, mountAt, mountPage } from "../mount.ts";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Toast } from "../components/toast.tsx";
import { FeedbackBar } from "../components/feedback.tsx";
import { ReportView } from "../components/report-view.tsx";
import { ReportList } from "../report/list.tsx";
import { pruneDrafts } from "../state/drafts.ts";
import { showError } from "../state/toast.ts";
import {
  barTarget,
  bodyText,
  chooseVersion,
  compareMode,
  jobFilter,
  listArchived,
  listBusy,
  listFailed,
  listReports,
  listUrl,
  messageOf,
  openList,
  openReport,
  openVersion,
  pageMode,
  reloadList,
  reloadReport,
  reportDiff,
  setCompare,
  viewerFailed,
  viewerReport,
} from "../state/reports.ts";

/** The one function a send is judged by, which the hand-written report page exposed too. */
declare global {
  interface Window {
    piSecReport?: { listUrl(): string };
  }
}

/** The slug in the address, or `null` for the list. */
function currentName(): string | null {
  const base = mount().base;
  let pathname = window.location.pathname.replace(/\/+$/, "");
  if (base !== "" && pathname.startsWith(base)) pathname = pathname.slice(base.length);
  const rest = pathname.replace(/^\/report\/?/, "");
  return rest === "" ? null : decodeURIComponent(rest);
}

/* ------------------------------------------------------------------- screens */

/** The list: `Loading…` until the first read answers, then the rows. */
function ListScreen() {
  if (listFailed.value) return <p class="report-empty">Could not load this report.</p>;
  const reports = listReports.value;
  if (reports === null) return <p class="report-empty">Loading…</p>;
  return <ReportList reports={reports} archived={listArchived.value} jobFilter={jobFilter.value} />;
}

/** One report: the viewer, its body and its feedback. */
function ViewerScreen() {
  if (viewerFailed.value) return <p class="report-empty">Could not load this report.</p>;
  return (
    <ReportView
      report={viewerReport.value}
      version={openVersion.value}
      body={bodyText.value}
      compare={compareMode.value}
      diff={reportDiff.value}
      onVersion={chooseVersion}
      onCompare={setCompare}
    />
  );
}

/**
 * What the scrolling row holds.
 *
 * A page with no mount stamp cannot be fetched from, and the failure would
 * otherwise read as `Loading…` for ever. It says what is missing first, and asks
 * the server for nothing (the old page did the same).
 */
function Screens() {
  if (pageMode.value === "unknown-mount") {
    return (
      <p class="report-empty">
        Mount point unknown — this page carried no mount stamp and its path does not name a known page, so its URLs
        cannot be built. Reload it from the server.
      </p>
    );
  }
  if (pageMode.value === "viewer") return <ViewerScreen />;
  return <ListScreen />;
}

/* -------------------------------------------------------------- the shell */

/**
 * The list's reload button. It is the list's alone: reading the list again is
 * what it is for, and a report is read by opening it.
 */
function ReloadButton() {
  const shown = pageMode.value === "list";
  return (
    <button
      id="reload-list"
      class={shown ? "button" : "button hidden"}
      type="button"
      disabled={listBusy.value}
      onClick={() => void reloadList()}
    >
      ↻ reload
    </button>
  );
}

/** The way back to the list: shown only while one report is open. */
function ListLink() {
  const shown = pageMode.value === "viewer";
  return (
    <a id="list-link" class={shown ? "pill pill-muted" : "pill pill-muted hidden"} href={listUrl()}>
      ▤ all reports
    </a>
  );
}

/**
 * The feedback bar in the shell's last row.
 *
 * It is mounted once and re-pointed at whatever report and revision are open, so
 * the field keeps the text being written through a report that is read again. A
 * send the server accepts leaves for the list, which is where what just landed is
 * read fresh.
 */
function NoteBar() {
  const target = pageMode.value === "viewer" ? barTarget() : null;
  return (
    <div id="note-bar" class={target === null ? "note-bar hidden" : "note-bar"}>
      <FeedbackBar
        target={target}
        via="viewer"
        onSent={() => {
          window.location.assign(listUrl());
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- the page */

/**
 * The shell's height comes from the visual viewport where the browser has one. A
 * software keyboard can shrink that box alone, leaving the layout viewport — and
 * with it `100dvh` — at its full height, which puts the feedback bar behind the
 * keyboard. Engines without the API (and jsdom) keep `100dvh`, which is the best
 * they have.
 */
function trackVisualViewport(): void {
  const viewport = window.visualViewport;
  if (viewport === null || viewport === undefined) return;
  let queued = false;
  const write = (): void => {
    queued = false;
    document.documentElement.style.setProperty("--app-h", `${Math.round(viewport.height)}px`);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(write);
    else write();
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  write();
}

/** Read the screen the address names, once the shell is on the page. */
function start(): void {
  window.addEventListener("error", (event) => showError(event.message));
  window.addEventListener("unhandledrejection", (event) => showError(String((event as PromiseRejectionEvent).reason)));

  trackVisualViewport();

  // Drafts nobody came back for are dropped once per page load, before the bar can
  // read one.
  pruneDrafts();

  // The one function a send is judged by: jsdom does not navigate, and neither
  // does a reader who only wants to know where the button would have gone.
  window.piSecReport = { listUrl };

  // A page restored from the back/forward cache is the screen as it was left, and
  // after a send elsewhere that screen is out of date. Read it again.
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) void reloadReport();
  });

  // A page with no mount stamp cannot be fetched from, and the failure would
  // otherwise read as "Loading…" for ever. Say what is missing first.
  if (!mount().known) {
    pageMode.value = "unknown-mount";
    return;
  }

  jobFilter.value = new URLSearchParams(window.location.search).get("job");

  let name: string | null;
  try {
    name = currentName();
  } catch (error) {
    showError(`Could not load: ${messageOf(error)}`);
    listFailed.value = true;
    return;
  }

  if (name === null) {
    void openList();
    return;
  }
  void openReport(name).then(() => {
    const report = viewerReport.value;
    if (report !== null) document.title = `${report.title} · pi-sec`;
  });
}

/* Take over the shell's parts, one element at a time. */
mountPage("#view", Screens);
const toastHost = document.getElementById("toast");
if (toastHost !== null) mountAt(toastHost, <Toast />);
const themeHost = document.getElementById("theme-toggle");
if (themeHost !== null) mountAt(themeHost, <ThemeToggle />);
const reloadHost = document.getElementById("reload-list");
if (reloadHost !== null) mountAt(reloadHost, <ReloadButton />);
const linkHost = document.getElementById("list-link");
if (linkHost !== null) mountAt(linkHost, <ListLink />);
const barHost = document.getElementById("note-bar");
if (barHost !== null) mountAt(barHost, <NoteBar />);

start();
