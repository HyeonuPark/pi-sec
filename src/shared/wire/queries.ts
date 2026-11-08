/**
 * The questions that wait on the operator's answer, and the one door an answer
 * goes back by.
 *
 * The server's own copy of the item shape is `src/documents.ts`
 * (`UserQueryListItem`). It is written out again here because the page type
 * check must not pull the server's Node imports in with it.
 *
 * The page reads `GET /api/user-queries` and answers with
 * `POST /api/user-queries/:key`, where the path parameter is the item's `key`
 * and not its `id`: the key names the question, the id is what the audit record
 * keeps.
 */

/** One open `ask_user` question. */
export interface UserQuery {
  /** The content key the answer travels on. */
  readonly key: string;
  /** The record's own id, kept for display and for the audit log. */
  readonly id: string;
  readonly conversationId: string;
  readonly question: string;
  readonly options: readonly string[];
  /** When the question was asked, in epoch milliseconds. */
  readonly createdAt: number;
}

/** The answer to `GET /api/user-queries`. */
export interface UserQueryListResponse {
  readonly queries?: readonly UserQuery[];
}

/**
 * What an answer carries: one option's index, or the operator's own words. The
 * route refuses a body with neither.
 */
export interface UserQueryAnswer {
  readonly choice?: number;
  readonly other?: string;
}

/** The answer to a submitted reply. */
export interface UserQueryAnswerResponse {
  readonly status?: string;
  readonly mode?: "choice" | "other";
}
