/**
 * The report panel on the left of the chat.
 *
 * It covers the left of the transcript instead of taking a column of its own, so
 * opening it never reflows the conversation. What it holds is the one report the
 * chat is talking about: the title, the meta line (`v3 · work · active ·
 * approved`), the newest revision as markdown, a way to the report's own page, a
 * close button, and the feedback control the report viewer carries too — the same
 * component, pointed at this report, so the two surfaces cannot drift.
 *
 * Nothing here decides what is open, which report is loaded or what a press
 * closes: that is `src/ui/state/panels.ts`, and this file draws what it says. The
 * body is the markdown component, which redraws only when the text changes, so a
 * report read again after a new revision keeps the elements around the paragraph
 * that did not move — and the scroll position and the selection the reader left
 * there.
 */
import { Markdown } from "../../components/markdown.tsx";
import { FeedbackBar } from "../../components/feedback.tsx";
import { afterTheTask, closeReportPane, reportPane } from "../../state/panels.ts";
import { showError } from "../../state/toast.ts";

/** The line the body shows while it has nothing to show yet. */
function Placeholder({ failed }: { failed: boolean }) {
  return <p class="inbox-body">{failed ? "Could not load this report." : "Loading…"}</p>;
}

export function ReportPanel() {
  const view = reportPane.value;
  // `Open page` leaves for another tab, and the panel behind it is what the press
  // was done with, so the panel closes too. The close waits one task: the browser
  // follows the link after this handler returns, and closing first would point the
  // link back at the report list, so the new tab would open `/report` instead of
  // the report the reader pressed. A middle-button press is the same press; the
  // right button opens the browser's own menu, which the page cannot see.
  const closeAfterPress = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) return;
    afterTheTask(() => closeReportPane());
  };
  return (
    <aside id="report-pane" class="report-pane" aria-label="Report">
      <div class="report-pane-head">
        <div class="report-pane-titles">
          <h2 id="report-pane-title" class="report-pane-title">
            {view.title}
          </h2>
          <div id="report-pane-meta" class="report-pane-meta">
            {view.meta}
          </div>
        </div>
        <div class="report-pane-actions">
          <a
            id="report-pane-page"
            class="button"
            href={view.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeAfterPress}
            onAuxClick={closeAfterPress}
          >
            Open page
          </a>
          <button
            id="report-pane-close"
            class="button"
            type="button"
            aria-label="Close the report panel"
            onClick={() => closeReportPane()}
          >
            ✕
          </button>
        </div>
      </div>
      {view.text === null ? (
        <div id="report-pane-body" class="report-pane-body report-body">
          <Placeholder failed={view.failed} />
        </div>
      ) : (
        <Markdown id="report-pane-body" class="report-pane-body report-body" text={view.text} />
      )}
      {/*
        Shown only once the control is pointed at a record: a bar on screen
        before that is a press for the report that was open before. It stays
        mounted while it is hidden, so the text being written into it is the
        text the next report read leaves alone.
      */}
      <div id="report-pane-feedback" class="report-pane-feedback" hidden={view.target === null}>
        <FeedbackBar
          target={view.target}
          via="panel"
          onSent={(sent) => {
            // The press is what the panel was for: the chat behind it shows what
            // the server just wrote, instead of the record already answered.
            if (reportPane.value.id === sent.reportId) closeReportPane();
          }}
          onError={({ message }) => showError(message)}
        />
      </div>
    </aside>
  );
}
