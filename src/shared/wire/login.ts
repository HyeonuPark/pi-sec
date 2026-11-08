/**
 * What travels between the model login routes and the login panel.
 *
 * The server builds these shapes in `src/server/routes/model-login.ts` and
 * `src/runtime/model-login.ts`; nothing here is imported from either, because the
 * page only needs the fields it draws, written down once so the panel and its
 * tests agree on them.
 *
 * The one thing that is deliberately absent is the answer the operator types: it
 * goes out in the request body and the server never repeats it, so no shape here
 * carries it back. `events` carries what the provider asked to show (a sign-in
 * link, a device code, a line of progress) and nothing that was typed into the
 * panel.
 */

/** How a provider can be signed in. The server accepts exactly these two. */
export type LoginType = "oauth" | "api_key";

/** Where a login is. The last four never move again. */
export type LoginStatus = "running" | "prompt" | "succeeded" | "failed" | "cancelled" | "timeout";

/** Why a login that ended, ended. */
export type LoginReason = "cancelled" | "timeout" | "code_rejected" | "failed";

/** The newest successful login of one provider, as the record file keeps it. */
export interface LoginRecord {
  /** An ISO instant. */
  readonly at: string;
  readonly type: LoginType;
}

/** One provider as the panel lists it. */
export interface LoginProvider {
  readonly id: string;
  /** The extension that registered the provider, or null for a built-in one. */
  readonly extension: string | null;
  /** Whether a credential is stored or ambient right now. */
  readonly configured: boolean;
  /** The login types this provider can actually run. */
  readonly types: readonly LoginType[];
  readonly lastLogin: LoginRecord | null;
}

/** The answer of `GET /api/admin/model-login/providers`. */
export interface LoginProvidersAnswer {
  /** False when the catalog cannot log in at all; the panel then says so. */
  readonly available?: boolean;
  readonly providers?: readonly LoginProvider[];
  /** Whether a session is running now. */
  readonly sessionActive?: boolean;
  /** The provider the root conversation's model belongs to, when it resolves. */
  readonly rootProvider?: string | null;
}

/** One choice a `select` prompt offers. */
export interface LoginChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** One question the flow is waiting on. */
export interface LoginPrompt {
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly LoginChoice[];
}

/** One notification of the flow, in the shape the panel draws. */
export type LoginEvent =
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly { readonly url: string; readonly label?: string }[];
    }
  | { readonly type: "progress"; readonly message: string };

/** The answer of `POST .../state`, `.../answer` and `.../cancel`. */
export interface LoginState {
  readonly status: LoginStatus;
  readonly provider: string;
  readonly type: LoginType;
  readonly prompt: LoginPrompt | null;
  readonly events: readonly LoginEvent[];
  /** ISO instants. */
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly loginAt: string | null;
  readonly reason: LoginReason | null;
  /** The daemon's own sentence about a login time it could not record. */
  readonly warning: string | null;
}

/** The answer of `POST .../start`: the session id, and the state it began in. */
export interface LoginStartAnswer {
  readonly session?: string;
  readonly state?: LoginState;
}
