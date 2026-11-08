import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JOB_STATUSES, TERMINAL_JOB_STATUSES, type JobOnceSpec, type JobRecord, type JobRoutineSpec, type JobStatus } from "../../documents.ts";
import {
  judgeRoutineChange,
  resolveRoutineApproval,
  type RoutineApproval,
  type RoutineChangeSubject,
  type RoutineGate,
} from "../../jobs/registry.ts";
import { validateScheduleFields } from "../../jobs/routine.ts";
import { dropDraftsOfEndedJobs, droppedDraftRefs } from "../../reports/drafts.ts";
import { jobTreeIds, jobWorkers, legacyScheduleProblem, withWorking, withWorkingTree } from "../streams.ts";
import { apiError, json, type RouteContext, type Router } from "../router.ts";
import { type AppDeps } from "../deps.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function asStatus(value: unknown): JobStatus | undefined {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value) ? (value as JobStatus) : undefined;
}

/**
 * The schedule fields of a write, checked against the scheduler's own rules.
 *
 * The route used to refuse a schedule outright, because accepting one promised
 * recurrence nothing carried out. It carries one out now: `routine` and `once`
 * are the record's schedule and the reconciler reads them, so the same check the
 * tool path uses runs here as well.
 */
function scheduleChange(
  routine: unknown,
  once: unknown,
  nowMs: number,
  before: JobRecord | undefined,
): { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null } {
  const given = validateScheduleFields(routine === null ? undefined : routine, once === null ? undefined : once, nowMs, {
    requireFutureOnce: before?.once === undefined,
  });
  return {
    ...(routine === null ? { routine: null } : given.routine === undefined ? {} : { routine: given.routine }),
    ...(once === null ? { once: null } : given.once === undefined ? {} : { once: given.once }),
  };
}

/**
 * Apply the routine gate to one HTTP write.
 *
 * Returns the approval the registry needs, or answers the request itself with
 * `403` and the refusal text, and records the refusal in the audit log. The
 * judgement is the same function the `jobs_*` tools call, so a write over HTTP
 * and the same write through a tool cannot come out differently.
 */
async function gateRoutine(
  route: RouteContext,
  deps: AppDeps,
  args: {
    readonly source: string;
    readonly reportId: string | undefined;
    readonly before: JobRecord | undefined;
    readonly change: RoutineChangeSubject;
    /** Reasons from outside the record itself, such as an open descendant that carries a routine. */
    readonly extraReasons?: readonly string[];
    readonly jobId?: string;
  },
): Promise<{ readonly ok: true; readonly approval?: RoutineApproval } | { readonly ok: false }> {
  const judged = judgeRoutineChange(args.before, args.change);
  const reasons = [...(judged.gated ? judged.reasons : []), ...(args.extraReasons ?? [])];
  if (reasons.length === 0) return { ok: true };
  const gate: RoutineGate = { gated: true, reasons };
  const outcome = await resolveRoutineApproval({
    reports: deps.runtime.reports,
    context: BACKGROUND_CONTEXT,
    reportId: args.reportId,
    gate,
  });
  if (outcome.ok) return { ok: true, approval: outcome.approval };
  deps.runtime.audit.append({
    type: "routine_refused",
    source: args.source,
    code: outcome.refusal.code,
    reasons: [...outcome.refusal.reasons],
    ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
    ...(args.reportId === undefined ? {} : { reportId: args.reportId }),
  });
  apiError(route.res, 403, outcome.refusal.code, outcome.refusal.message, route.requestId);
  return { ok: false };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function registerJobs(router: Router, deps: AppDeps): void {
  router.get("/api/jobs/events", async (route: RouteContext) => {
    await deps.streams.attachJobs(route);
  });

  router.get("/api/jobs", async (route) => {
    const status = asStatus(route.url.searchParams.get("status") ?? undefined);
    const parentId = route.url.searchParams.get("parentId") ?? undefined;
    const label = route.url.searchParams.get("label") ?? undefined;
    const includeArchived = route.url.searchParams.get("includeArchived") === "true";
    // `shape=tree` is the page asking for the one form it draws. The list and the
    // tree carry the same records, so answering both put the whole job list on
    // the wire twice; a caller that wants both gets both, as before.
    const treeOnly = route.url.searchParams.get("shape") === "tree";
    const jobs = treeOnly ? undefined : await deps.runtime.jobs.list(BACKGROUND_CONTEXT, { status, parentId, label });
    const tree = await deps.runtime.jobs.tree(BACKGROUND_CONTEXT, { status, parentId, label });
    const archived = includeArchived ? await deps.runtime.archive.list(BACKGROUND_CONTEXT) : undefined;
    // Read-only derivation over the same records: no status is changed, and the
    // list is empty for a job nobody is running on (see `jobWorkers`). The ids
    // come from the tree when the flat list was not read, which is the same set
    // for one set of filters, so the `working` markers cannot differ per shape.
    const ids = jobs === undefined ? jobTreeIds(tree) : jobs.map((job) => job.id);
    const workers = await jobWorkers(deps.runtime, ids);
    json(route.res, 200, {
      ...(jobs === undefined ? {} : { jobs: jobs.map((job) => withWorking(job, workers)) }),
      tree: withWorkingTree(tree, workers),
      ...(archived === undefined ? {} : { archived }),
      // The page draws a banner for a `config.scheduler.jobs` that is still
      // populated, because nothing fires from it any more. The same value rides
      // on the job SSE snapshot, so a reconnect does not clear the banner.
      legacyScheduleProblem: await legacyScheduleProblem(deps.runtime),
    });
  });

  router.get("/api/jobs/:id", async (route) => {
    // Archived ids stay resolvable: a job that was moved out of the live store
    // must not turn into a 404 for a conversation that still holds its id.
    const job = await deps.runtime.archive.getAny(BACKGROUND_CONTEXT, route.params["id"]!);
    if (job === undefined) {
      apiError(route.res, 404, "not_found", "job not found", route.requestId);
      return;
    }
    const live = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, job.id);
    const subjobs = await deps.runtime.jobs.list(BACKGROUND_CONTEXT, { parentId: job.id });
    const archivedSubjobs = live === undefined ? await deps.runtime.archive.registry.list(BACKGROUND_CONTEXT, { parentId: job.id }) : [];
    // A subjob is a job row on the same screen, so it carries the same derived
    // list; a finished job that nobody is on gets an empty one.
    const attached = [...subjobs, ...archivedSubjobs];
    const workers = await jobWorkers(deps.runtime, [job.id, ...attached.map((subjob) => subjob.id)]);
    json(route.res, 200, {
      ...withWorking(job, workers),
      archived: live === undefined,
      subjobs: attached.map((subjob) => withWorking(subjob, workers)),
    });
  });

  router.post("/api/jobs", async (route) => {
    const body = bodyObject(route.body);
    if (typeof body?.["title"] !== "string" || body["title"].trim() === "") {
      apiError(route.res, 400, "invalid_request", "title is required", route.requestId);
      return;
    }
    let schedule: { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null };
    try {
      // `undefined` leaves a field alone, `null` clears it, a value sets it.
      schedule = scheduleChange(body["routine"], body["once"], Date.now(), undefined);
    } catch (error) {
      apiError(route.res, 400, "invalid_request", String(error), route.requestId);
      return;
    }
    const gate = await gateRoutine(route, deps, {
      source: "http_post_jobs",
      reportId: asString(body["reportId"]),
      before: undefined,
      change: { routine: schedule.routine, once: schedule.once },
    });
    if (!gate.ok) return;
    try {
      const job = await deps.runtime.jobs.create(BACKGROUND_CONTEXT, {
        title: body["title"],
        description: typeof body["description"] === "string" ? body["description"] : undefined,
        parentId: typeof body["parentId"] === "string" ? body["parentId"] : undefined,
        labels: Array.isArray(body["labels"]) ? (body["labels"] as string[]) : undefined,
        memoryAnchors: Array.isArray(body["memoryAnchors"]) ? (body["memoryAnchors"] as string[]) : undefined,
        stateDir: typeof body["stateDir"] === "string" ? body["stateDir"] : undefined,
        ...(schedule.routine === undefined || schedule.routine === null ? {} : { routine: schedule.routine }),
        ...(schedule.once === undefined || schedule.once === null ? {} : { once: schedule.once }),
        ...(gate.approval === undefined ? {} : { routineApproval: gate.approval }),
        origin: "user",
        conversationId: typeof body["conversationId"] === "string" ? body["conversationId"] : undefined,
      });
      deps.runtime.events.emit("job_created", job as unknown as Record<string, unknown>);
      json(route.res, 201, job);
    } catch (error) {
      apiError(route.res, 400, "invalid_request", String(error), route.requestId);
    }
  });

  router.patch("/api/jobs/:id", async (route) => {
    const body = bodyObject(route.body) ?? {};
    const id = route.params["id"]!;
    const before = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, id);
    const status = asStatus(body["status"]);
    let schedule: { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null };
    try {
      schedule = scheduleChange(body["routine"], body["once"], Date.now(), before);
    } catch (error) {
      apiError(route.res, 400, "invalid_request", String(error), route.requestId);
      return;
    }
    const gate = await gateRoutine(route, deps, {
      source: "http_patch_jobs",
      reportId: asString(body["reportId"]),
      before,
      change: { routine: schedule.routine, once: schedule.once, status },
      jobId: id,
    });
    if (!gate.ok) return;
    try {
      const job = await deps.runtime.jobs.update(BACKGROUND_CONTEXT, id, {
        status,
        title: typeof body["title"] === "string" ? body["title"] : undefined,
        description: typeof body["description"] === "string" ? body["description"] : undefined,
        labels: Array.isArray(body["labels"]) ? (body["labels"] as string[]) : undefined,
        memoryAnchors: Array.isArray(body["memoryAnchors"]) ? (body["memoryAnchors"] as string[]) : undefined,
        stateDir: typeof body["stateDir"] === "string" ? body["stateDir"] : undefined,
        routine: schedule.routine,
        once: schedule.once,
        ...(gate.approval === undefined ? {} : { routineApproval: gate.approval }),
      });
      deps.runtime.events.emit("job_updated", job as unknown as Record<string, unknown>);
      // A draft is open work of its job, so a job that ends takes its drafts with
      // it here as well: this route is one of the ways a job ends, and the reply
      // says which drafts went. One function serves this route and the
      // `jobs_update` tool, so the two cannot come out differently.
      const dropped = TERMINAL_JOB_STATUSES.includes(job.status)
        ? await dropDraftsOfEndedJobs(deps.runtime.drafts, BACKGROUND_CONTEXT, [job.id])
        : [];
      json(route.res, 200, { ...job, ...(dropped.length === 0 ? {} : { droppedDrafts: droppedDraftRefs(dropped) }) });
    } catch (error) {
      apiError(route.res, 404, "not_found", String(error), route.requestId);
    }
  });

  router.post("/api/jobs/:id/cancel", async (route) => {
    const id = route.params["id"]!;
    const before = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, id);
    // The user's cancel button cancels the whole open subtree, and one approval
    // covers it: the gate is asked over the target and every open descendant
    // that carries a routine, the same set the registry checks in `cancelTx`.
    const descendants = await deps.runtime.jobs.descendantIds(BACKGROUND_CONTEXT, id);
    const extra: string[] = [];
    for (const descendantId of descendants) {
      const record = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, descendantId);
      if (record === undefined || (TERMINAL_JOB_STATUSES as readonly string[]).includes(record.status)) continue;
      const judged = judgeRoutineChange(record, { status: "cancelled" });
      if (judged.gated) extra.push(...judged.reasons.map((reason) => `has descendant ${record.id} that ${reason}`));
    }
    const gate = await gateRoutine(route, deps, {
      source: "http_cancel_job",
      reportId: asString(bodyObject(route.body)?.["reportId"]),
      before,
      change: { status: "cancelled" },
      extraReasons: extra,
      jobId: id,
    });
    if (!gate.ok) return;
    try {
      const result = await deps.runtime.jobs.cancel(
        BACKGROUND_CONTEXT,
        id,
        gate.approval === undefined ? {} : { routineApproval: gate.approval },
      );
      for (const job of [result.job, ...result.descendants]) {
        deps.runtime.events.emit("job_updated", job as unknown as Record<string, unknown>);
      }
      // The cancel ends every job it moved, so each one takes its drafts with it.
      // This is the route behind the user's cancel button, and the tool
      // `jobs_cancel` drops through the same function.
      const dropped = await dropDraftsOfEndedJobs(deps.runtime.drafts, BACKGROUND_CONTEXT, [
        result.job.id,
        ...result.descendants.map((job) => job.id),
      ]);
      json(route.res, 200, {
        ...result.job,
        ...(dropped.length === 0 ? {} : { droppedDrafts: droppedDraftRefs(dropped) }),
      });
    } catch (error) {
      apiError(route.res, 404, "not_found", String(error), route.requestId);
    }
  });
}
