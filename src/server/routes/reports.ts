import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  TERMINAL_JOB_STATUSES,
  type JobRecord,
  type ReportApprovalVia,
  type ReportFeedback,
  type ReportKind,
  type ReportRecord,
  type ReportVersion,
} from "../../documents.ts";
import { approvalInput, approvalRequestId } from "../../approvals/input.ts";
import { diffLines } from "../../reports/diff.ts";
import {
  reportKind,
  reportStanding,
  type ReportApprovalRefusal,
  type ReportDoneRefusal,
  type ReportStanding,
  type ReportStore,
} from "../../reports/store.ts";
import { reviewInput, reviewRequestId } from "../../review.ts";
import { submitEnveloped } from "../../submit-envelope.ts";
import { resolveDefaultConversation } from "../../agent/conversation.ts";
import { sendBody } from "../compress.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { type AppDeps } from "../deps.ts";
import { resolveMount } from "../proxy.ts";
import { readPage, renderPage, serveStatic } from "../static.ts";

/**
 * Reports, and the page that shows them.
 *
 * `GET /report` and `GET /report/<name>` serve the same page: a report is
 * identified by its slug, and the list is what you get when there is none. The
 * page reads its own path.
 *
 * A report has one stored fact about its standing, the `pending` flag, and the
 * rest is derived from its job: live exactly while the job is live, finished when
 * the job ends, gone to the archive with it. `reportStanding()` orders the two, so
 * there is still no second copy of the job's truth to fall out of step.
 */

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function store(deps: AppDeps): ReportStore {
  return deps.runtime.reports;
}

export interface ReportView extends ReportRecord {
  /**
   * The job is live, which is what the approval path asks: a revision can be
   * confirmed while its job is open. It says nothing about `pending`, which is a
   * different question, and `status` is the one word that answers both.
   */
  readonly active: boolean;
  readonly archived: boolean;
  /** Where the report stands, as one word. See `reportStanding`. */
  readonly status: ReportStanding;
  readonly job: { readonly id: string; readonly title: string; readonly status: JobRecord["status"] } | null;
}

async function view(deps: AppDeps, record: ReportRecord): Promise<ReportView> {
  const live = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, record.jobId);
  const job = live ?? (await deps.runtime.archive.get(BACKGROUND_CONTEXT, record.jobId));
  // A report leaves the live store in two ways: with its job, which the live job
  // lookup shows, and on its own, which `archivedAt` on the record shows. An older
  // briefing goes the second way while the job of its routine stays live, so the
  // job alone is not the whole answer.
  const archived = live === undefined || record.archivedAt !== undefined;
  return {
    ...record,
    active: !archived && !TERMINAL_JOB_STATUSES.includes(live!.status),
    archived,
    status: reportStanding(record, live?.status),
    job: job === undefined ? null : { id: job.id, title: job.title, status: job.status },
  };
}

async function deliverReview(deps: AppDeps, record: ReportRecord, entry: ReportFeedback): Promise<void> {
  try {
    const conversation = await resolveDefaultConversation(
      deps.runtime.harness,
      deps.runtime.getConfig(),
      deps.runtime.paths,
      BACKGROUND_CONTEXT,
    );
    // `followUp`: a review written while a run is in flight waits for the next
    // boundary instead of interrupting it, and it is never dropped — `reject`
    // would answer 409 and leave the note to be found by hand.
    const note = reviewInput(
      { name: record.name, ...(entry.version === undefined ? {} : { version: entry.version }) },
      entry.body,
    );
    // A note the operator wrote in the viewer: operator text, not a message from
    // another agent, so it carries its own source. `reviewInput` writes the older
    // marker line and does not wrap it, and the envelope goes on here, inside
    // `submitEnveloped`.
    await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
      type: "input",
      src: "operator",
      attrs: { via: "report-feedback" },
      content: note,
      whenBusy: "followUp",
      requestId: reviewRequestId(entry.id),
    }, deps.runtime.getConfig().timezone);
  } catch (error) {
    // The note itself is stored either way, which is the part that must not be
    // lost. But a delivery that fails quietly is the same shape as every silent
    // failure this file has produced, so it is logged and left in the status.
    deps.runtime.logger.error("report feedback delivery failed", { report: record.name, error });
    deps.adminState.notes.add(`report feedback delivery failed: ${record.name}`);
  }
}

async function servePage(deps: AppDeps, route: RouteContext): Promise<void> {
  const raw = await readPage(deps.webDir, "report.html");
  if (raw === undefined) {
    apiError(route.res, 500, "ui_missing", "report UI is not installed", route.requestId);
    return;
  }
  const config = deps.runtime.getConfig();
  const html = renderPage(raw, resolveMount(route.req, config).prefix, config.timezone);
  sendBody(route.res, {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: html,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function asInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The revision an approval is for: a positive whole number, and nothing else. */
function asVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * The surface the press came from. Absent means the viewer: that is the page
 * which has always had this button, and it is the safe reading of an older
 * caller that does not name a surface.
 */
function asVia(value: unknown): ReportApprovalVia | undefined {
  if (value === undefined) return "viewer";
  return value === "viewer" || value === "panel" ? value : undefined;
}

/**
 * Answer an approval refusal.
 *
 * The fields beside `error` are not decoration. The feedback bar reads `latest`
 * and `approval` from the body's top level, so a screen
 * that learns the report moved can correct itself instead of waiting for a
 * reload to disagree with it. `apiError` writes the error envelope alone, so
 * these refusals are written here.
 */
function refusalResponse(route: RouteContext, refusal: ReportApprovalRefusal | ReportDoneRefusal): void {
  const error = (code: string, message: string): Record<string, unknown> => ({
    error: { code, message, requestId: route.requestId },
  });
  switch (refusal.reason) {
    case "not_found":
      apiError(route.res, 404, "not_found", "report not found", route.requestId);
      return;
    case "not_active":
      json(route.res, 409, {
        ...error(
          "not_active",
          refusal.status === undefined
            ? "this report's job is no longer live, so it cannot be approved"
            : `this report's job is ${refusal.status}, so it cannot be approved`,
        ),
        status: refusal.status,
      });
      return;
    case "stale_revision":
      json(route.res, 409, {
        ...error("stale_revision", `only the newest revision can be approved, and that is v${refusal.latest}`),
        latest: refusal.latest,
        latestSha256: refusal.latestSha256,
      });
      return;
    case "already_approved":
      json(route.res, 409, {
        ...error("already_approved", "this revision is already approved"),
        approval: refusal.approval,
      });
      return;
    case "not_a_result":
      json(route.res, 409, {
        ...error("not_a_result", "Done is the approve button of a result report, and this report is a plan"),
      });
      return;
    case "briefing":
      json(route.res, 409, {
        ...error("briefing", "a briefing report asks for no approval, so Feedback is its only button"),
      });
      return;
  }
}

/**
 * Put the approval into the conversation, as operator input.
 *
 * The record in the store is what stops the next change from landing; this input
 * is what tells the root agent the operator said yes. `submitEnveloped` puts the
 * source on the text, and the `requestId` makes the admission idempotent: a
 * second press for the same revision does not put a second approval in the
 * transcript. `followUp` is the same choice the feedback route makes — a press
 * waits for the next boundary instead of interrupting a run.
 */
async function deliverApproval(
  deps: AppDeps,
  report: ReportRecord,
  version: ReportVersion,
  via: ReportApprovalVia,
  done?: { readonly text?: string },
): Promise<void> {
  const conversation = await resolveDefaultConversation(
    deps.runtime.harness,
    deps.runtime.getConfig(),
    deps.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const surface = via === "panel" ? "the report panel in the chat" : "the report viewer";
  const sentence =
    done === undefined
      ? `The user approved revision ${version.n} of "${report.title}" (/report/${report.name}) from ${surface}.\n` +
        "This is consent to the text hashed above. A later revision is a new proposal and needs its own approval."
      : `The user pressed Done on revision ${version.n} of "${report.title}" (/report/${report.name}) from ${surface}.\n` +
        "This is the approval of the text hashed above, the same as Approve. A later revision is a new proposal and needs its own approval.";
  const followUp =
    done?.text === undefined || done.text === ""
      ? ""
      : `\n\nThe user also asked for follow-up work with Done. The approval of this revision stands. Hand the request over as a new request, with report ${report.id}, job ${report.jobId}, and the title above as context. The user's words:\n\n${done.text}`;
  const note = approvalInput(
    {
      name: report.name,
      version: version.n,
      sha256: version.sha256,
      ...(done === undefined ? {} : { button: "done" as const }),
    },
    `${sentence}${followUp}`,
  );
  await submitEnveloped(conversation, BACKGROUND_CONTEXT, {
    type: "input",
    src: "operator",
    attrs: { via: "approval", approval: `${report.id}/v${version.n}` },
    content: note,
    whenBusy: "followUp",
    requestId: approvalRequestId(report.id, version.n),
  }, deps.runtime.getConfig().timezone);
}

/**
 * One press of Approve or of Done, from either surface.
 *
 * Both buttons write the same record, so they go through one function: the only
 * difference is the `button=done` field on the approval, the sentence the input
 * carries, and the follow-up paragraph a Done with text adds. A Done on a plan is
 * refused, because a plan is approved with Approve.
 *
 * The order is the contract. The refusal is taken first, before anything has
 * happened, because this route's own input says the operator approved a revision
 * and a refusal that left that message behind would put an approval in the
 * conversation that was never recorded. The record is written last, and only what
 * the store itself accepts.
 */
async function pressApproval(deps: AppDeps, route: RouteContext, done: boolean): Promise<void> {
  const id = route.params["id"]!;
  const body = bodyObject(route.body);
  const version = asVersion(body?.["version"]);
  if (version === undefined) {
    apiError(route.res, 400, "invalid_request", "version must be the number of the revision being approved", route.requestId);
    return;
  }
  const via = asVia(body?.["via"]);
  if (via === undefined) {
    apiError(route.res, 400, "invalid_request", 'via must be "viewer" or "panel"', route.requestId);
    return;
  }
  // The text a Done carries is the user's request for follow-up work, and it is
  // kept as they wrote it. Approve reads it and drops it, as it always has: the
  // field goes with Done.
  const text = done && typeof body?.["text"] === "string" ? body["text"] : undefined;

  const check = await store(deps).checkApproval(BACKGROUND_CONTEXT, id, version);
  if (!check.ok) {
    refusalResponse(route, check);
    return;
  }
  if (done && reportKind(check.report) !== "result") {
    refusalResponse(route, { ok: false, reason: "not_a_result" });
    return;
  }

  try {
    await deliverApproval(deps, check.report, check.version, via, done ? { text: text ?? "" } : undefined);
  } catch (error) {
    // Nothing was written, so the press is simply refused and can be taken
    // again: the same request id means a retry does not stack input.
    deps.runtime.logger.error("report approval delivery failed", { report: check.report.name, error });
    apiError(
      route.res,
      500,
      "delivery_failed",
      `the approval input could not be delivered: ${String(error)}`,
      route.requestId,
    );
    return;
  }

  // Only now the record, and only what the store itself accepts: the input it
  // would otherwise contradict is already in the conversation.
  const outcome = await store(deps).approve(BACKGROUND_CONTEXT, id, version, {
    via,
    ...(done ? { button: "done" as const } : {}),
    ...(done && text !== undefined && text !== "" ? { text } : {}),
  });
  if (!outcome.ok) {
    // Reachable only when the state moved between the check above and this
    // write — a new revision, another press, or the job finishing in between.
    // The input stays: it is what the operator did, and a retry reuses its
    // request id. It is logged because this is the one path where the record
    // and the conversation disagree.
    deps.runtime.logger.error("report approval input delivered but the record was refused", {
      report: check.report.name,
      reason: outcome.reason,
    });
    deps.adminState.notes.add(
      `report approval input delivered but the record was refused: ${check.report.name} (${outcome.reason})`,
    );
    refusalResponse(route, outcome);
    return;
  }

  const updated = await view(deps, outcome.report);
  deps.runtime.events.emit("report_updated", updated as unknown as Record<string, unknown>);
  json(route.res, 201, { id: outcome.report.id, version, approval: outcome.approval });
}

export function registerReports(router: Router, deps: AppDeps): void {
  router.get("/report", async (route) => servePage(deps, route));
  router.get("/report/assets/*", async (route) => {
    const asset = route.params["*"] ?? "";
    if (!(await serveStatic(route.res, deps.webDir, asset))) {
      apiError(route.res, 404, "not_found", "asset not found", route.requestId);
    }
  });
  // Registered after the asset route so `/report/assets/...` is not read as a name.
  router.get("/report/:name", async (route) => servePage(deps, route));

  router.get("/api/reports", async (route) => {
    const jobId = route.url.searchParams.get("jobId") ?? undefined;
    const includeArchived = route.url.searchParams.get("includeArchived") === "true";
    const reports = await store(deps).list(BACKGROUND_CONTEXT, jobId === undefined ? undefined : { jobId });
    const views = await Promise.all(reports.map((record) => view(deps, record)));
    const archived = includeArchived
      ? await Promise.all((await store(deps).listArchived(BACKGROUND_CONTEXT)).map((record) => view(deps, record)))
      : undefined;
    json(route.res, 200, {
      reports: views,
      ...(archived === undefined ? {} : { archived }),
    });
  });

  router.post("/api/reports", async (route) => {
    const body = bodyObject(route.body);
    const jobId = typeof body?.["jobId"] === "string" ? body["jobId"] : "";
    const title = typeof body?.["title"] === "string" ? body["title"] : "";
    const content = typeof body?.["content"] === "string" ? body["content"] : "";
    if (title.trim() === "" || content.trim() === "") {
      apiError(route.res, 400, "invalid_request", "title and content are required", route.requestId);
      return;
    }
    if ((await deps.runtime.jobs.get(BACKGROUND_CONTEXT, jobId)) === undefined) {
      apiError(route.res, 400, "invalid_request", `job not found: ${jobId}`, route.requestId);
      return;
    }
    // `plan`, `result` and `briefing` are the three kinds, and a value outside them
    // is refused rather than read as a plan: a typo must not decide the kind of a
    // report.
    const named = body?.["kind"];
    if (named !== undefined && named !== "plan" && named !== "result" && named !== "briefing") {
      apiError(route.res, 400, "invalid_request", 'kind must be "plan", "result" or "briefing"', route.requestId);
      return;
    }
    try {
      const record = await store(deps).create(BACKGROUND_CONTEXT, {
        jobId,
        title,
        content,
        ...(typeof body?.["name"] === "string" ? { name: body["name"] } : {}),
        ...(typeof body?.["note"] === "string" ? { note: body["note"] } : {}),
        ...(named === "result" || named === "briefing" ? { kind: named } : {}),
      });
      const created = await view(deps, record);
      deps.runtime.events.emit("report_created", created as unknown as Record<string, unknown>);
      json(route.res, 201, created);
    } catch (error) {
      apiError(route.res, 400, "invalid_request", String(error), route.requestId);
    }
  });

  router.get("/api/reports/by-name/:name", async (route) => {
    const found = await store(deps).byName(BACKGROUND_CONTEXT, route.params["name"]!);
    if (found === undefined) {
      apiError(route.res, 404, "not_found", "report not found", route.requestId);
      return;
    }
    json(route.res, 200, { ...(await view(deps, found.report)), archivedName: found.archived });
  });

  router.get("/api/reports/:id", async (route) => {
    const record = await store(deps).getAny(BACKGROUND_CONTEXT, route.params["id"]!);
    if (record === undefined) {
      apiError(route.res, 404, "not_found", "report not found", route.requestId);
      return;
    }
    json(route.res, 200, await view(deps, record));
  });

  router.get("/api/reports/:id/versions/:n", async (route) => {
    const n = asInt(route.params["n"]);
    const record = await store(deps).getAny(BACKGROUND_CONTEXT, route.params["id"]!);
    if (record === undefined || n === undefined || n < 1 || n > record.versions.length) {
      apiError(route.res, 404, "not_found", "revision not found", route.requestId);
      return;
    }
    const text = await store(deps).readVersion(record.id, n);
    if (text === undefined) {
      apiError(route.res, 410, "body_missing", `revision ${n} has no body file`, route.requestId);
      return;
    }
    route.res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "X-Content-Type-Options": "nosniff",
    });
    route.res.end(text);
  });

  router.post("/api/reports/:id/versions", async (route) => {
    const body = bodyObject(route.body);
    const content = typeof body?.["content"] === "string" ? body["content"] : "";
    if (content.trim() === "") {
      apiError(route.res, 400, "invalid_request", "content is required", route.requestId);
      return;
    }
    try {
      const record = await store(deps).addVersion(BACKGROUND_CONTEXT, route.params["id"]!, {
        content,
        ...(typeof body?.["note"] === "string" ? { note: body["note"] } : {}),
      });
      const updated = await view(deps, record);
      deps.runtime.events.emit("report_updated", updated as unknown as Record<string, unknown>);
      json(route.res, 201, updated);
    } catch (error) {
      apiError(route.res, 404, "not_found", String(error), route.requestId);
    }
  });

  router.get("/api/reports/:id/diff", async (route) => {
    const record = await store(deps).getAny(BACKGROUND_CONTEXT, route.params["id"]!);
    if (record === undefined) {
      apiError(route.res, 404, "not_found", "report not found", route.requestId);
      return;
    }
    const to = asInt(route.url.searchParams.get("to") ?? undefined) ?? record.versions.length;
    const from = asInt(route.url.searchParams.get("from") ?? undefined) ?? Math.max(1, to - 1);
    if (from < 1 || to < 1 || from > record.versions.length || to > record.versions.length) {
      apiError(route.res, 404, "not_found", "revision not found", route.requestId);
      return;
    }
    const before = await store(deps).readVersion(record.id, from);
    const after = await store(deps).readVersion(record.id, to);
    if (before === undefined || after === undefined) {
      apiError(route.res, 410, "body_missing", "one of the revisions has no body file", route.requestId);
      return;
    }
    json(route.res, 200, { id: record.id, from, to, ...diffLines(before, after) });
  });

  router.post("/api/reports/:id/approve", async (route) => {
    await pressApproval(deps, route, false);
  });

  // Done is the approve button of a result report. It records the same approval as
  // Approve, with `button=done` on it, and it also carries the request for
  // follow-up work the user wrote, if they wrote one.
  router.post("/api/reports/:id/done", async (route) => {
    await pressApproval(deps, route, true);
  });

  router.post("/api/reports/:id/feedback", async (route) => {
    const body = bodyObject(route.body);
    const text = typeof body?.["body"] === "string" ? body["body"] : "";
    if (text.trim() === "") {
      apiError(route.res, 400, "invalid_request", "body is required", route.requestId);
      return;
    }
    const record = await store(deps).getAny(BACKGROUND_CONTEXT, route.params["id"]!);
    if (record === undefined) {
      apiError(route.res, 404, "not_found", "report not found", route.requestId);
      return;
    }
    try {
      const entry = await store(deps).addFeedback(BACKGROUND_CONTEXT, record.id, {
        body: text,
        ...(asInt(body?.["version"]) !== undefined ? { version: asInt(body?.["version"])! } : {}),
        from: "operator",
      });
      // Straight into the conversation, like user input: the review is what the
      // agent has to act on, so it is pushed rather than parked in a surface
      // somebody has to go and read (see src/review.ts).
      await deliverReview(deps, record, entry);
      deps.runtime.events.emit("report_feedback", { id: record.id, entry });
      json(route.res, 201, entry);
    } catch (error) {
      apiError(route.res, 400, "invalid_request", String(error), route.requestId);
    }
  });
}
