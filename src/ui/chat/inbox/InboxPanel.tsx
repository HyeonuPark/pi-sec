/**
 * The inbox: one line per notice, with the badge and the `hide all` control the
 * panel's heading carries.
 *
 * The row is the old page's row, element for element: the severity dot, an inline
 * SVG mark (a document for a report notice, a bell for anything else), the title,
 * the age, a caret, and its own hide button. The list is keyed by the item's id,
 * and every row is one element that survives a read, a `report_created` frame or
 * an age tick, so the focus on a title or a hide button, the text selected in an
 * opened body, and the open state itself stay where the operator left them.
 *
 * A title press opens the item and reads it; a report notice opens the report
 * panel instead, and a focused-chat notice opens that chat. Both openers are
 * handed in by the panels this one does not draw (`state/inbox.ts`
 * · `setInboxOpeners`).
 */
import type { InboxItem } from "../../../shared/wire/inbox.ts";
import {
  hideAllInbox,
  hideInboxItem,
  inboxClock,
  inboxMarkName,
  isReportItem,
  openInboxItem,
  relativeTime,
  revertInbox,
  expandedInbox,
  unreadCount,
  visibleInboxItems,
} from "../../state/inbox.ts";
import { clearedInbox, revertQueueInbox } from "../../state/jobs.ts";

/**
 * The two pictograms an inbox mark is drawn with. They are inline SVG rather than
 * a font glyph, so the same bytes draw the same shape on every platform. Both are
 * outline only: at 0.75rem a second line turns to grey mush, and the silhouette
 * is what has to read.
 */
function ReportMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 2h4l4 4v8H4z" />
      <path d="M8 2v4h4" />
    </svg>
  );
}

function NoticeMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11V7a4 4 0 0 1 8 0v4" />
      <path d="M2.5 11.5h11" />
    </svg>
  );
}

/** The revert button both cleared lists end with. */
function RevertButton({ id, count }: { id: string; count: number }) {
  return (
    <button type="button" class="list-clear" id={id} disabled={count === 0} onClick={() => revertInbox()}>
      {`↩ revert (${count})`}
    </button>
  );
}

/** One inbox row. */
function InboxRow({ item }: { item: InboxItem }) {
  const id = String(item.id);
  // A set-aside report's notice is drawn the way a read item is drawn: it stays in
  // the list, and it stops looking like something that waits for an answer.
  const unread = item.readAt === undefined && item.pending !== true;
  const severity = item.severity === "warn" || item.severity === "error" ? item.severity : "info";
  const report = isReportItem(item);
  const expanded = expandedInbox.value.has(id);
  const reportEvent = item.source?.reportEvent;
  const knownEvent = reportEvent === "published" || reportEvent === "updated" || reportEvent === "answered";
  const markClass = report
    ? `inbox-mark inbox-mark--report${knownEvent ? ` inbox-mark--${reportEvent}` : ""}`
    : "inbox-mark inbox-mark--other";
  const markName = inboxMarkName(report, reportEvent, item.kind);
  // The stamp the one-minute tick reads back. An item with no readable time keeps
  // no attribute, so the tick never rewrites its empty age.
  const createdAt = Number(item.createdAt);
  const ageAttr = Number.isFinite(createdAt) ? String(createdAt) : undefined;
  return (
    <div class={`inbox-item ${unread ? "unread" : "read"}${item.pending === true ? " pending" : ""}`} data-id={id}>
      <div class="inbox-head">
        <button
          type="button"
          class="inbox-title"
          aria-expanded={expanded ? "true" : "false"}
          title={item.title}
          onClick={() => void openInboxItem(id)}
        >
          <span class={markClass} role="img" aria-label={markName} title={markName}>
            {report ? <ReportMark /> : <NoticeMark />}
          </span>
          <span class="inbox-caret" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span class="inbox-title-text">{item.title}</span>
        </button>
        <span class={`severity-dot severity-${severity}`} title={item.severity ?? "info"} />
        <span class="inbox-age" data-created-at={ageAttr}>
          {relativeTime(item.createdAt, inboxClock.value)}
        </span>
        <button
          type="button"
          class="inbox-hide"
          title="Hide this item"
          aria-label={`Hide: ${item.title}`}
          onClick={() => hideInboxItem(id)}
        >
          ✕
        </button>
      </div>
      {expanded ? (
        <div class="inbox-meta">
          <span>{`${item.kind ?? "notice"}${item.pending === true ? " · pending" : ""}`}</span>
        </div>
      ) : null}
      {expanded ? <div class="inbox-body">{item.body}</div> : null}
    </div>
  );
}

/** The list the shell carries as `#inbox`. */
export function InboxPanel() {
  const items = visibleInboxItems();
  const queue = revertQueueInbox.value;
  if (items.length === 0) {
    // With nothing on screen and nothing ever cleared, the panel says so. With
    // items cleared, it keeps the revert button, which is the only way back.
    if (clearedInbox.value.size === 0) {
      return (
        <div id="inbox" class="inbox">
          <p class="inbox-body">Inbox is empty.</p>
        </div>
      );
    }
    return (
      <div id="inbox" class="inbox">
        <RevertButton id="inbox-restore" count={queue.length} />
      </div>
    );
  }
  return (
    <div id="inbox" class="inbox">
      {items.map((item) => (
        <InboxRow key={String(item.id)} item={item} />
      ))}
      <RevertButton id="inbox-restore" count={queue.length} />
    </div>
  );
}

/** The unread badge in the panel's heading. */
export function InboxCount() {
  return (
    <span id="inbox-count" class="badge">
      {String(unreadCount())}
    </span>
  );
}

/** The `hide all` control in the panel's heading. */
export function InboxHideAll() {
  const disabled = visibleInboxItems().length === 0;
  return (
    <button
      type="button"
      id="inbox-hide-all"
      class="panel-action"
      title="Hide every inbox item"
      disabled={disabled}
      onClick={() => hideAllInbox()}
    >
      hide all
    </button>
  );
}
