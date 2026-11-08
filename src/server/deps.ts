import type { AgentRuntime } from "../agent/harness.ts";
import type { AdminNotes } from "../runtime/notes.ts";
import type { RestartState } from "../runtime/restart.ts";
import type { EventBus } from "../runtime/event-bus.ts";
import type { RestartLaunchOptions, RestartOutcome } from "../runtime/restart-helper.ts";
import type { SseHub } from "./sse.ts";
import type { StreamHub } from "./streams.ts";

/** Current public API revision, announced in headers and the first snapshot. */
export const API_VERSION = 1;

/** Mutable admin-visible state (the restart state, diagnostics). */
export interface AdminState {
  /**
   * Whether a cold restart is needed, and whether it is ready to be applied.
   * The same object the extension context holds, so `self-edit` and this API
   * cannot report different things about the same process.
   */
  readonly restart: RestartState;
  /** Recent diagnostics, capped and de-duplicated; see `AdminNotes`. */
  notes: AdminNotes;
  /**
   * The last config reload that failed, while the config on disk is still
   * unusable. Kept as state rather than an event: a page opened after the
   * failure has to see it too, and it stays until a reload succeeds.
   */
  configError?: { readonly at: number; readonly issues: readonly string[] };
}

/**
 * What one attempt at replacing the browser-facing assets came to.
 *
 * One shape for both outcomes, because the route has to answer with the same
 * fields it reports to the audit log: a refusal that named only a reason would
 * leave the page unable to say whether the previous assets are still served
 * (`restored`) or the assets directory has to be rebuilt.
 */
export interface UiRestartOutcome {
  readonly ok: boolean;
  readonly code?: "source_missing" | "web_dir_missing" | "sync_failed" | "build_failed";
  readonly restored?: boolean;
  readonly copied?: number;
  readonly uiHash?: string;
  /** The directory the assets were copied from, for the page to name. */
  readonly source?: string;
  /** The directory that was replaced; the one the static route serves. */
  readonly target?: string;
  /** Which server-code changes the new assets do not carry; see `readCodeDrift`. */
  readonly codeDrift?: { known: boolean; behind: number; codePaths: string[] };
}

/** Shared dependencies for every HTTP route. */
export interface AppDeps {
  readonly runtime: AgentRuntime;
  readonly bus: EventBus;
  readonly sse: SseHub;
  /** One upstream source per streaming endpoint, fanned out to every attached client. */
  readonly streams: StreamHub;
  readonly startedAt: number;
  readonly version: string;
  readonly webDir: string;
  readonly adminState: AdminState;
  readonly reloadConfig?: () => Promise<void>;
  /**
   * Cold restart on request, by handing `user-tools/update-and-restart` to
   * systemd as a unit of its own. Absent when nothing wired one in.
   * `reinstall` asks for `--reinstall`, which builds node_modules again.
   */
  readonly restart?: { launch(source?: string, options?: RestartLaunchOptions): Promise<RestartOutcome> };
  /**
   * Replace the served web assets without restarting the daemon. Absent when
   * nothing wired one in, which is every test that does not ask for one.
   */
  readonly uiRestart?: { run(): Promise<UiRestartOutcome> };
}
