/**
 * The error envelope the HTTP server writes for a refusal.
 *
 * The wire types here are shared by the server and the page code: they describe
 * what travels between them, and hold no code and no import of `src/server`, so
 * the page type check does not pull the Node types in with them.
 *
 * `src/server/router.ts` · `apiError` writes `{ error: { code, message, requestId } }`.
 * A refusal that needs one more fact adds `details`, as `POST /api/admin/ui-restart`
 * does when it says whether the previous assets were restored.
 */

/** The body of every error answer. */
export interface ApiErrorBody {
  readonly error: ApiErrorDetail;
}

/** The one object an error answer carries. */
export interface ApiErrorDetail {
  /** A stable identifier the page branches on, such as `not_found`. */
  readonly code: string;
  /** A sentence for a person. The page may show it as it is. */
  readonly message: string;
  /** The id the server logged for this request, for a bug report. */
  readonly requestId: string;
  /** A refusal's extra facts, when the code alone does not say enough. */
  readonly details?: unknown;
}
