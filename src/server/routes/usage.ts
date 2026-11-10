/**
 * The usage page and the answer it is drawn from.
 *
 * `GET /usage` is the shell: provider cards are drawn by the page's own script,
 * and the `usage.cards` slot below them is filled by the server, the way the chat
 * page fills `sidebar.bottom`. The shell carries the answer the server already
 * holds as a JSON data block (`#usage-first`), built from held values and the
 * ledger with no provider call, so the cards draw with the page. The page asks
 * `GET /api/usage` only for a provider whose value the block could not carry.
 * `GET /api/usage` is a read: it asks the model catalog which providers have
 * auth, reads pi-sec's ledger for the usage windows, and calls a provider's own
 * API only when its held value is older than ten minutes.
 *
 * The service is made here, so the daemon's one prefetch also starts here: it
 * runs beside the first requests instead of delaying them.
 *
 * `POST /api/usage/refresh` is the one card's own control: it answers that card
 * as the page load would, but asks the provider again unless its minimum interval
 * or an HTTP 429 back-off holds it. The origin check and the body cap are global
 * (see `server.ts`); this route adds the JSON content type and the field shape.
 *
 * The page opens no event stream, so a card in this slot hears no `ui_event`. The
 * card draws at page load and changes through the answer of its own control,
 * which is the same `/api/ui/call` the chat page uses. `docs/ui.md` says so.
 */
import { sendBody } from "../compress.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { type AppDeps } from "../deps.ts";
import { readPage, renderPage } from "../static.ts";
import { pagePreferences } from "../preferences-stamp.ts";
import { contentSecurityPolicy, fillUiSlots, UI_RENDER_TIMEOUT_MS } from "../ui-page.ts";
import { resolveMount } from "../proxy.ts";
import { JudgeUsage } from "../usage/judges.ts";
import { UsageRecords } from "../usage/records.ts";
import { createUsageService, type UsageModels } from "../usage/service.ts";
import type { UsageAnswer } from "../usage/values.ts";

/** The slot this page opens below the provider cards. */
export const USAGE_SLOT = "usage.cards";

/** Where `usage.html` leaves room for the usage answer the server already holds. */
const FIRST_PAINT_MARKER = "<!--usage-first-->";

/**
 * Put a held usage answer into the page as a JSON data block.
 *
 * The block is data, not code: its type is `application/json`, so the browser
 * parses it and never runs it, and the page's `script-src 'self'` policy has
 * nothing to refuse. Every `<` is written as `\u003c`, so no value can close the
 * element early; the rest of the JSON needs no escaping inside a `script`.
 */
export function withFirstPaint(html: string, answer: UsageAnswer): string {
  const json = JSON.stringify(answer).replaceAll("<", "\\u003c");
  return html.replace(FIRST_PAINT_MARKER, () => `<script type="application/json" id="usage-first">${json}</script>`);
}

export interface UsageRouteOptions {
  /** How long one card of the slot may take. A test sets it small. */
  readonly renderTimeoutMs?: number;
  /** The ledger to read. Defaults to the daemon's own database, opened read-only. */
  readonly records?: Pick<UsageRecords, "totals">;
  /**
   * The audit trail to read for the judgement lines. Defaults to the daemon's own
   * `paths.auditLog`, together with the rotated files beside it.
   */
  readonly judgeRecords?: Pick<JudgeUsage, "rows">;
  /** `globalThis.fetch` unless a test injects one, so no test can reach a provider. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** The deadline of one provider call. The service's own default unless a test sets it. */
  readonly timeoutMs?: number;
  /**
   * The model catalog a service of the test's own reads.
   *
   * A test that replaces `runtime.models` with a made-up catalog gives this the
   * same function, so the service it builds here answers about the catalog the
   * test meant. Absent on the daemon, which reads the runtime's own catalog.
   */
  readonly models?: () => UsageModels;
  /**
   * Whether the daemon's one prefetch runs when the service is made. Default
   * true; a test sets it false to measure the page and its routes alone.
   */
  readonly prefetch?: boolean;
}

export function registerUsage(router: Router, deps: AppDeps, options: UsageRouteOptions = {}): void {
  const renderTimeoutMs = options.renderTimeoutMs ?? UI_RENDER_TIMEOUT_MS;
  const records = options.records ?? new UsageRecords({ path: deps.runtime.paths.stateDb });
  const judgeRecords = options.judgeRecords ?? new JudgeUsage({ file: deps.runtime.paths.auditLog });
  // The daemon's service is the runtime's own: the hold watch judges a provider's
  // recovery on the same object the cards are drawn from, so the two cannot hold
  // different ideas of what one provider said. A test that hands in its own inputs
  // (a fake `fetch`, a fake ledger, a clock) gets a service of its own here, and
  // the runtime's is left alone.
  const own =
    options.fetch !== undefined ||
    options.records !== undefined ||
    options.judgeRecords !== undefined ||
    options.now !== undefined ||
    options.timeoutMs !== undefined ||
    options.models !== undefined;
  const usage = own ? createUsageService({
    // The catalog is read through the runtime on every request, so a provider
    // that appeared since the daemon started is asked about on the next one.
    models: options.models ?? (() => deps.runtime.models as unknown as UsageModels),
    records,
    // An extension's virtual provider gets no card: its spending is recorded
    // under the provider that answered. Read through the runtime on every
    // request, so a reload that adds or drops the marker reaches the next
    // answer. A runtime with no registry hides nothing.
    isVirtual: (providerId) => deps.runtime.providers?.isVirtual(providerId) === true,
    // Both are read on every request, so a judge the config gains and a judgement
    // the trail records both reach the page without a restart.
    judgeModels: () => deps.runtime.getConfig().judges,
    judgeRecords,
    timezone: () => deps.runtime.getConfig().timezone,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    logger: deps.runtime.logger,
  }) : deps.runtime.usage;

  // The daemon's start asks each provider once, so the first page after a restart
  // usually has the values already. Not awaited, so a slow or unreachable provider
  // delays neither the listen nor the first request, and `prefetch()` never
  // throws. It obeys the ten-minute reuse and each provider's own interval.
  if (options.prefetch !== false) void usage.prefetch();

  router.get("/usage", async ({ req, res }: RouteContext) => {
    const raw = await readPage(deps.webDir, "usage.html");
    if (raw === undefined) {
      apiError(res, 500, "ui_missing", "usage UI is not installed", "");
      return;
    }
    // Exactly the chat page's order: stamp the mount and the zone, then fill the
    // slot, so a card's own text is never read as one of our placeholders.
    const config = deps.runtime.getConfig();
    const prefix = resolveMount(req, config).prefix;
    const page = await fillUiSlots(renderPage(raw, prefix, config.timezone, await pagePreferences(deps)), {
      ui: deps.runtime.ui,
      prefix,
      timezone: config.timezone,
      renderTimeoutMs,
      logger: deps.runtime.logger,
    });
    // The answer the cards are drawn from, from held values and the ledger only:
    // no provider is asked while someone waits for the page. Without the block the
    // page asks `GET /api/usage`, which is what it did before, so a failure here
    // costs a slow first paint and nothing else.
    let html = page.html;
    try {
      html = withFirstPaint(page.html, await usage.firstPaint());
    } catch (error) {
      deps.runtime.logger.warn("usage first paint failed", { error });
    }
    sendBody(res, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
      headers: {
        "Cache-Control": "no-cache",
        // The policy the chat page sends, with the card styles' nonce only when a
        // card rendered. A page with no card carries it byte for byte.
        "Content-Security-Policy": contentSecurityPolicy(page.nonce),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });

  // A read: nothing here writes, so there is no `Origin` question and no body.
  router.get("/api/usage", async ({ res, requestId }: RouteContext) => {
    try {
      json(res, 200, await usage.answer());
    } catch (error) {
      // Every provider failure is already inside the answer. This is the one that
      // leaves nothing to draw, and it says so rather than sending a half answer.
      deps.runtime.logger.error("usage answer failed", { requestId, error });
      apiError(res, 500, "internal_error", "usage answer failed", requestId);
    }
  });

  /**
   * One card, asked to refresh.
   *
   * A cross-site form can POST without a preflight and cannot send a JSON type,
   * so the type is required here, as on the card-call route. The provider id is a
   * name in the body and never in the query, because the access log records
   * `req.url`.
   */
  router.post("/api/usage/refresh", async ({ req, res, body, requestId }: RouteContext) => {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(res, 415, "json_required", "send this request with Content-Type: application/json", requestId);
      return;
    }

    const object = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const provider = object?.["provider"];
    if (typeof provider !== "string" || provider === "") {
      apiError(res, 400, "invalid_request", "provider must be a provider id", requestId);
      return;
    }

    try {
      const result = await usage.refresh(provider);
      if (!result.ok) {
        // A provider the catalog does not have, and one without auth, get the same
        // answer: a refresh is about one card, and there is no card to name.
        apiError(res, 404, result.code, "no usage card for that provider", requestId);
        return;
      }
      json(res, 200, result.answer);
    } catch (error) {
      deps.runtime.logger.error("usage refresh failed", { requestId, error });
      apiError(res, 500, "internal_error", "usage refresh failed", requestId);
    }
  });
}
