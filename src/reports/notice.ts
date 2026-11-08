import type { ReportRecord } from "../documents.ts";
import type { InboxInput } from "../jobs/inbox.ts";
import type { ReportChange } from "./store.ts";

/**
 * The address lines every report notice body carries: where the document is, and
 * which revision of it the item is about.
 *
 * They live in one function because two callers need them. A report write puts
 * them under its own title, and `notify` puts them under the words the agent
 * wrote when it raises a notice for a report that already exists. The operator
 * reads them as the fallback address when the click cannot open the panel.
 */
export function noticeAddressLines(report: ReportRecord): string[] {
  return [`/report/${report.name}`, `job ${report.jobId}`, `v${report.versions.length}`];
}

/**
 * The inbox notice for one report write.
 *
 * A report is written for the operator to read, and the write is often the last
 * thing the agent does in a run. Nothing else tells the operator that a document
 * appeared or moved to a new revision, so each write leaves one item in the inbox.
 * The item carries `reportId`, which is what the chat UI reads to open the report
 * panel at the document itself rather than showing a line of prose about it.
 *
 * A note left in the viewer is *not* announced: it arrives in the conversation as
 * a review input, which is where the agent reads it, so an inbox item about it
 * would only tell the operator what they had just written.
 *
 * The third kind is the answer to that note. A message is a legitimate answer to
 * feedback, and it leaves no revision, so this notice is the only record that the
 * operator was answered — and the item's body is the answer itself, under the same
 * address lines a report write uses. It is written by the report's own commit, so
 * a report cannot come back to the Active list with nobody told why.
 *
 * The title is the report's own title, with no header in front of it: the inbox row
 * shows the title as the operator's text and marks the three kinds by a colored
 * mark instead, so a header in the string would only take the room the mark needs.
 * What the header used to say lives in `reportEvent`, which the chat UI reads. A
 * revision keeps its number on the title, because that is how two notices about
 * the same report are told apart at a glance.
 */
export function reportNotice(change: ReportChange): InboxInput {
  const { kind, report } = change;
  const address = noticeAddressLines(report);
  if (kind === "answered") {
    const answer = change.answer?.trim() ?? "";
    return {
      kind: "report",
      title: report.title,
      body: answer === "" ? address.join("\n") : [answer, "", ...address].join("\n"),
      jobId: report.jobId,
      reportId: report.id,
      reportEvent: "answered",
    };
  }
  const version = report.versions.length;
  const lines = address;
  // The revision's own note, when it has one, reads as the last address line.
  const note = report.versions.at(-1)?.note;
  if (note !== undefined && note !== "") lines.push(note);
  return {
    kind: "report",
    // A publication is a first revision and reads as the title alone; an update
    // carries the revision number, which is the fact the operator reads.
    title: kind === "created" ? report.title : `${report.title} (v${version})`,
    body: lines.join("\n"),
    jobId: report.jobId,
    reportId: report.id,
    // A report's first revision is its publication; every later one is an update.
    reportEvent: kind === "created" ? "published" : "updated",
  };
}
