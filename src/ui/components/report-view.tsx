/**
 * One report, drawn from what the caller hands it.
 *
 * This is the viewer's middle: the title and its standing, the revision selector,
 * the compare box, the revision on screen (as markdown, or as the comparison),
 * and the feedback left on the report. It reads no page path, no address and no
 * server: the report, the revision, the text and the comparison are props, and
 * the two things the reader changes are called back.
 *
 * The report page and the chat's report panel both draw a report, and they draw
 * it with this. A component that read the slug off `location` could not be used by
 * the panel, which shows a report the chat is talking about rather than the one in
 * the address bar.
 *
 * Nothing here is redrawn wholesale. A revision change writes the article's
 * content and leaves the selector, the compare box and the feedback section as
 * they are; the markdown component leaves the article's own elements alone when
 * the text did not change, so a reader's selection inside the prose survives a
 * report that is read again.
 */
import { Markdown } from "./markdown.tsx";
import { diffVNode } from "./diff.ts";
import { relativeTime } from "./relative-time.ts";
import { standing } from "../state/reports.ts";
import type { LineDiff, ReportSummary } from "../../shared/wire/reports.ts";

/** Which chip colour each standing takes. `inactive` reads as `done`: the job ended. */
const CHIP_TONE: Readonly<Record<string, string>> = {
  active: "active",
  // A result report is open work, so it takes a colour of its own: the accent,
  // which no other standing uses and which reads as a third state beside the
  // active green and the waiting amber.
  result: "result",
  // A briefing is not work the user has to answer about, so it takes neither the
  // active green nor the waiting amber: it has a colour of its own.
  briefing: "briefing",
  pending: "pending",
  inactive: "done",
  archived: "cancelled",
};

/**
 * The one-word standing of a report, in its chip.
 *
 * The list and the viewer draw the same chip, and the panel draws it as a word in
 * its meta line, so the mapping from a standing to a colour lives here once.
 */
export function StatusChip({ report }: { report: ReportSummary }) {
  const status = standing(report);
  return <span class={`status-chip status-${CHIP_TONE[status] ?? "done"}`}>{status}</span>;
}

export interface ReportViewProps {
  /** The report to draw, or `null` while the page is still reading it. */
  readonly report: ReportSummary | null;
  /** The revision on screen. */
  readonly version: number;
  /** The markdown of {@link version}, as the server wrote it. */
  readonly body: string;
  /** Whether the body shows the comparison instead of the prose. */
  readonly compare?: boolean;
  /** The comparison of {@link version} with the revision before it, once it is read. */
  readonly diff?: LineDiff | null;
  /** The reader chose a revision. */
  readonly onVersion?: (n: number) => void;
  /** The reader turned the comparison on or off. */
  readonly onCompare?: (on: boolean) => void;
}

/** The revision's own note, which sits beside the selector. */
function noteOf(report: ReportSummary, version: number): string {
  return report.versions.find((entry) => entry.n === version)?.note ?? "";
}

/** One report: its head, the body, and the feedback left on it. */
export function ReportView({ report, version, body, compare, diff, onVersion, onCompare }: ReportViewProps) {
  if (report === null) return <p class="report-empty">Loading…</p>;
  // Newest first, as the selector has always listed them.
  const versions = [...report.versions].sort((left, right) => right.n - left.n);
  const showDiff = compare === true && diff !== null && diff !== undefined;
  return (
    <>
      <div class="report-head">
        <h1 class="report-h1">{report.title}</h1>
        <div class="report-row-meta">
          <StatusChip report={report} />
          {report.job === null ? (
            <span>job missing</span>
          ) : (
            <span>
              job <code>{report.job.id}</code> · {report.job.title} · {report.job.status}
            </span>
          )}
        </div>
        <div class="report-tools">
          <label class="report-tool">
            <span class="report-tool-name">revision</span>{" "}
            <select
              id="version-select"
              value={String(version)}
              onChange={(event) => onVersion?.(Number((event.currentTarget as HTMLSelectElement).value))}
            >
              {versions.map((entry) => (
                <option value={String(entry.n)} key={entry.n}>{`v${entry.n}`}</option>
              ))}
            </select>
          </label>
          <label class="report-tool">
            <input
              type="checkbox"
              id="diff-toggle"
              checked={compare === true}
              onChange={(event) => onCompare?.((event.currentTarget as HTMLInputElement).checked)}
            />{" "}
            compare with previous
          </label>
          <span class="report-tool report-dim">{noteOf(report, version)}</span>
        </div>
      </div>
      {showDiff ? (
        <article id="report-body" class="report-body">
          {diffVNode(diff)}
        </article>
      ) : (
        <Markdown tag="article" class="report-body" id="report-body" text={body} />
      )}
      <section class="report-feedback">
        <h2 class="report-h2">Feedback</h2>
        <div id="report-notes">
          {report.feedback.length === 0 ? (
            <p class="report-empty">No feedback yet.</p>
          ) : (
            report.feedback.map((entry) => (
              <div class="report-note" key={entry.id}>
                <div class="report-note-meta">
                  {`${entry.from}${entry.version !== undefined ? ` · v${entry.version}` : ""} · ${relativeTime(entry.at)}`}
                </div>
                <div class="report-note-body">{entry.body}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}
