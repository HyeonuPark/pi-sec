/**
 * The inbox list the sidebar draws.
 *
 * The server's own copy of the item shape is `src/documents.ts` (`InboxItem`).
 * It is written out again here because the page type check must not pull the
 * server's Node imports in with it.
 *
 * The page reads `GET /api/inbox?cleared=exclude`, which leaves out every item a
 * revert button could not bring back, and POSTs `POST /api/inbox/:id/read` when
 * the operator opens one.
 */

/** How loud an item is. Anything else the server stores reads as `info`. */
export type InboxSeverity = "info" | "warn" | "error";

/** One notification item (`sec.inbox`). */
export interface InboxItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
  readonly readAt?: number;
  /**
   * What the item is about. `reportId` marks a report notice, whose title opens
   * the report panel; `conversationId` on a `focused_chat` item is the chat whose
   * page the title opens.
   */
  readonly source?: {
    readonly jobId?: string;
    readonly conversationId?: string;
    readonly reportId?: string;
    /** Which report write this item announces, when a report write made it. */
    readonly reportEvent?: "published" | "updated" | "answered";
  };
  readonly severity?: InboxSeverity;
  /**
   * Set by the route, never stored: the notice is about a report the operator
   * set aside, so it must not raise the unread badge. The item stays listed.
   */
  readonly pending?: boolean;
}

/** The answer to `GET /api/inbox`. */
export interface InboxListResponse {
  readonly items?: readonly InboxItem[];
}
