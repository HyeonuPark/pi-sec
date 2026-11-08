/**
 * The report list: the sections of rows, and the hint above them when one job was
 * asked for.
 *
 * It draws what the state module has read and nothing else. The hand-written
 * report page built this as one HTML string and put it in the view; here each
 * row is an
 * element keyed by the report's id, so a re-read that changed one report leaves
 * every other row the same element — with its focus and its place in the scroll
 * (the reset test).
 *
 * The groups are the server's standings, in this order: `briefing` under
 * `Briefing` above the `h1`, `active` under the `h1`, `result` under `Results`,
 * `pending` (only when there are any), `inactive` under `Finished`, and the
 * archive inside one closed `details`. The briefing goes first because it is the
 * one report the user reads every day and does not have to answer about. The
 * Results section sits directly above Pending, because a result report waits for
 * the user exactly as a plan under Active does: it is work the user still has to
 * answer about, and it ranks above a report the user set aside. A section with no
 * rows is not drawn, and a list with no active plans still says so, which is what
 * the old page did.
 */
import { StatusChip } from "../components/report-view.tsx";
import { relativeTime } from "../components/relative-time.ts";
import { listUrl, reportUrl, standing } from "../state/reports.ts";
import type { ReportSummary } from "../../shared/wire/reports.ts";

export interface ReportListProps {
  /** Every report that is not archived, in the order the server sent them. */
  readonly reports: readonly ReportSummary[];
  /** The archived reports, which the list folds into one section. */
  readonly archived: readonly ReportSummary[];
  /** The job the list is narrowed to, or `null` for every job. */
  readonly jobFilter: string | null;
}

/** One report as a row: a link at its slug, with its standing and its counts. */
function ReportRow({ report }: { report: ReportSummary }) {
  return (
    <a class="report-row" href={reportUrl(report.name)}>
      <div class="report-row-head">
        <StatusChip report={report} />
        <span class="report-row-title">{report.title}</span>
        <span class="report-row-name">{`/report/${report.name}`}</span>
      </div>
      <div class="report-row-meta">
        <span>{report.job === null ? "job missing" : report.job.title}</span>
        <span>{`v${report.versions.length}`}</span>
        <span>{`${report.feedback.length} feedback`}</span>
        <span>{relativeTime(report.updatedAt)}</span>
      </div>
    </a>
  );
}

/** One group of rows, or nothing when the group is empty and has no heading of its own. */
function Group({ reports }: { reports: readonly ReportSummary[] }) {
  return (
    <div class="report-list">
      {reports.map((report) => (
        <ReportRow report={report} key={report.id} />
      ))}
    </div>
  );
}

/** The list the page draws. */
export function ReportList({ reports, archived, jobFilter }: ReportListProps) {
  const briefings = reports.filter((report) => standing(report) === "briefing");
  const active = reports.filter((report) => standing(report) === "active");
  const results = reports.filter((report) => standing(report) === "result");
  const pending = reports.filter((report) => standing(report) === "pending");
  const inactive = reports.filter((report) => standing(report) === "inactive");
  // The hint names the job the way the job is titled, and falls back to the id it
  // was asked for when no report of that job is in the answer.
  const job = jobFilter === null ? undefined : [...reports, ...archived].find((report) => report.jobId === jobFilter)?.job;
  return (
    <>
      <h1 class="report-h1">Reports</h1>
      {jobFilter === null ? null : (
        <p class="report-hint">
          Filtered to {job === null || job === undefined ? jobFilter : job.title} · <a href={listUrl()}>all reports</a>
        </p>
      )}
      {briefings.length === 0 ? null : (
        <>
          <h2 class="report-h2">Briefing</h2>
          <p class="report-hint">The morning briefing. Read it, and write Feedback if something is off.</p>
          <Group reports={briefings} />
        </>
      )}
      {active.length === 0 ? (
        <p class="report-empty">No active reports.</p>
      ) : (
        <Group reports={active} />
      )}
      {results.length === 0 ? null : (
        <>
          <h2 class="report-h2">Results</h2>
          <p class="report-hint">Work that ran. Press Done to close it, or write Feedback for more in the report.</p>
          <Group reports={results} />
        </>
      )}
      {pending.length === 0 ? null : (
        <>
          <h2 class="report-h2">Pending</h2>
          <p class="report-hint">Not finished, and not waiting on an answer right now.</p>
          <Group reports={pending} />
        </>
      )}
      {inactive.length === 0 ? null : (
        <>
          <h2 class="report-h2">Finished</h2>
          <p class="report-hint">Their job is done, cancelled, or failed.</p>
          <Group reports={inactive} />
        </>
      )}
      {archived.length === 0 ? null : (
        <details class="report-archive">
          <summary>{`Archive (${archived.length})`}</summary>
          <p class="report-hint">Moved out with their job. Still readable.</p>
          <Group reports={archived} />
        </details>
      )}
    </>
  );
}
