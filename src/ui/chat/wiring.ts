/**
 * What the conversation stream announces, handed to the parts that draw it.
 *
 * The page has one stream (`src/ui/streams/conversation.ts`), and the frames on it
 * are about more than the transcript: a job was created, an inbox item was
 * written, a question is waiting, a report got a new revision. Each of those
 * belongs to a part of the page that is not the transcript — the sidebar panels,
 * the report panel — and those parts read their own state rather than listening
 * themselves. This module is the one place where the two meet, so the wiring of
 * the page is written down once instead of spreading through the components.
 *
 * It also hands the panel presses to the panels they belong to: the fourth attach
 * button and the `⋯` menu's `Model login` entry are the composer's, but what they
 * open is here. Each of those hand-overs is a registration, not an import, so the
 * composer does not depend on a panel it does not draw (`state/composer.ts`
 * explains the same thing from its side).
 *
 * The extension cards are the one thing that is carried and not read: an
 * extension published something for one of its cards, and what that means is the
 * card script's business. The frame is handed to `window.piSecUi`, which
 * `src/web/ui-cards.js` installs, and nothing here looks inside a card.
 */
import { applyInboxFrame, setInboxOpeners } from "../state/inbox.ts";
import { applyJobEvent } from "../state/jobs.ts";
import { applyMachineEvent } from "../state/machines.ts";
import { applyQueryEvent } from "../state/queries.ts";
import {
  closePane,
  openReportPane,
  openPane,
  reportPane,
  setSidebar,
  sidebarIsOpen,
} from "../state/panels.ts";
import { openLoginPanelInSlot } from "../state/login.ts";
import { openSnippetPanel } from "../state/snippets.ts";
import { onLoginPress, onSnippetPress, registerReportPane } from "../state/composer.ts";
import { onCredentialPress } from "./header/Banners.tsx";
import { applyPreferencesEvent, revisionOf } from "../state/preferences.ts";
import { applySideSnapshot } from "./SideParts.tsx";
import { onConversationEvent } from "../streams/conversation.ts";

/** The one frame shape the report panel reads: which report it is about. */
interface ReportFrame {
  readonly id?: unknown;
}

/** What {@link mountChatWiring} answers: the way to undo every registration. */
export interface ChatWiringHandle {
  unmount(): void;
}

/** Whether a report frame is about the report the panel holds. */
function namesOpenReport(event: { readonly data?: unknown }): string | null {
  const data = event.data as ReportFrame | null;
  const id = typeof data?.id === "string" ? data.id : null;
  if (id === null) return null;
  if (openPane.value !== "report" || reportPane.value.id !== id) return null;
  return id;
}

/**
 * Hand the page's frames and presses to the parts that act on them.
 *
 * It is called before the parts are drawn: the carry a UI restart leaves behind
 * is put back while the composer mounts (`restoreUiState`), and the report it
 * names can only be opened if the panel's bridge is already registered.
 */
export function mountChatWiring(doc: Document = document): ChatWiringHandle {
  const offs: (() => void)[] = [];

  // A press on an inbox report notice opens the report panel, which is the one
  // thing the inbox cannot do for itself.
  setInboxOpeners({ openReport: (id) => void openReportPane(id) });
  offs.push(() => setInboxOpeners({}));

  // The composer's two panel presses, and the header's credential line.
  onSnippetPress(() => openSnippetPanel());
  onLoginPress(() => openLoginPanelInSlot());
  offs.push(() => onSnippetPress(null));
  offs.push(() => onLoginPress(null));
  offs.push(onCredentialPress(() => openLoginPanelInSlot()));

  // The carry a UI restart leaves behind names an open report by its id; the
  // composer asks for it here rather than importing the panel.
  registerReportPane({
    current: () => (openPane.value === "report" ? reportPane.value.id : null),
    open: (id) => void openReportPane(id),
  });
  offs.push(() => registerReportPane(null));

  const frameOffs = [
    onConversationEvent("job_created", (event) => applyJobEvent(event.name)),
    onConversationEvent("job_updated", (event) => applyJobEvent(event.name)),
    onConversationEvent("inbox_item", (event) => applyInboxFrame(event.name)),
    onConversationEvent("report_created", (event) => applyInboxFrame(event.name)),
    onConversationEvent("report_updated", (event) => {
      applyInboxFrame(event.name);
      // A revision landed, which is a new proposal: the record the panel renders
      // changed, so it is read again. Left alone, an open panel would keep showing
      // the revision before this one and the approval that went with it.
      const id = namesOpenReport(event);
      if (id !== null) void openReportPane(id);
    }),
    onConversationEvent("report_feedback", (event) => {
      // A note left in the viewer arrives in the conversation as a review, so the
      // transcript needs no help from this frame. What it carries is that the
      // record changed, and the panel renders that record.
      const id = namesOpenReport(event);
      if (id !== null) void openReportPane(id);
    }),
    // A remote machine changed: its level, one user's link state, or a block. The
    // frame names the machine and the panel re-reads its list, which is one route
    // for all three.
    onConversationEvent("remote_machine_updated", () => applyMachineEvent()),
    // The shared UI state changed on some page. The frame carries the revision
    // only, and the page reads the record back when it is behind.
    onConversationEvent("preferences_updated", (event) => applyPreferencesEvent(revisionOf(event.data))),
    onConversationEvent("user_query", (event) => applyQueryEvent(event.name)),
    onConversationEvent("user_query_resolved", (event) => applyQueryEvent(event.name)),
    onConversationEvent("snapshot", (event) => {
      // The first snapshot is this page's own connection. From the second one on
      // the stream was away, and the frames it would have sent went to nobody:
      // the inbox, the questions and the job tree are read again.
      if (event.snapshotCount > 1) applySideSnapshot();
    }),
    onConversationEvent("ui_event", (event) => {
      // An extension published something for one of its cards. The frame names
      // the card; what it means is the card's own script's business, so the page
      // only carries it across (`src/web/ui-cards.js`).
      (window as Window & { piSecUi?: { dispatch(payload: unknown): void } }).piSecUi?.dispatch(event.data);
    }),
  ];
  offs.push(...frameOffs);

  // `Esc` closes whatever the page put over itself: the panels in the one slot,
  // and the drawer the work panel became.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    closePane(doc);
    if (sidebarIsOpen()) setSidebar(false);
  };
  doc.addEventListener("keydown", onKeyDown as EventListener);
  offs.push(() => doc.removeEventListener("keydown", onKeyDown as EventListener));

  return {
    unmount() {
      for (const off of offs.reverse()) off();
    },
  };
}
