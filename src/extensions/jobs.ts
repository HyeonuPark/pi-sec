import {
  defineExtension,
  defineTool,
  type Extension,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, bool, lit, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord";
import {
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  type JobOnceSpec,
  type JobRecord,
  type JobRoutineSpec,
  type JobStatus,
} from "../documents.ts";
import {
  judgeRoutineChange,
  resolveRoutineApproval,
  RoutineDescendantError,
  type JobCancelResult,
  type JobNode,
  type JobRegistry,
  type RoutineApproval,
  type RoutineChangeSubject,
} from "../jobs/registry.ts";
import { validateScheduleFields } from "../jobs/routine.ts";
import { withLocal, zoneIso } from "../time-format.ts";
import { dropDraftsOfEndedJobs, droppedDraftsNote } from "../reports/drafts.ts";
import { requireJobs, optionalArchive, type ExtensionContext } from "./context.ts";

const StatusSchema = union([
  lit("planned"),
  lit("active"),
  lit("waiting"),
  lit("paused"),
  lit("done"),
  lit("failed"),
  lit("cancelled"),
]);

/**
 * One recurring schedule, as a tool argument.
 *
 * `additionalProperties: false` throughout: a stale `cron` or `timezone` key has
 * to fail the call rather than be dropped, because a caller that believes it set
 * a schedule it did not set is the failure this whole change removes.
 */
const RoutineSchema = obj(
  {
    cron: str(),
    timezone: opt(str()),
    catchUp: opt(union([lit("skip"), lit("once"), lit("all")])),
    overlap: opt(union([lit("skip"), lit("queue"), lit("allow")])),
    prompt: str(),
    vmodel: opt(str({ description: "Required. A key of config.vmodels." })),
    enabled: opt(bool()),
  },
);

/** One single run, as a tool argument. `at` takes an ISO 8601 instant or epoch milliseconds. */
const OnceSchema = obj(
  {
    at: union([str(), num()]),
    prompt: str(),
    vmodel: opt(str({ description: "Required. A key of config.vmodels." })),
    state: opt(
      union([lit("pending"), lit("done"), lit("cancelled"), lit("missed")]),
    ),
  },
);

/** What a tool says when it refuses: text plus `isError`, never a thrown error. */
interface ToolRefusal {
  readonly output: { type: "text"; text: string }[];
  readonly isError: true;
}

function refusalText(text: string): ToolRefusal {
  return { output: [{ type: "text", text }], isError: true };
}

/**
 * The schedule fields of a tool call, checked at the write.
 *
 * A `cron` is parsed here and not at the tick that would have used it, and an
 * `at` in the past is refused before anything is stored. Both checks are the
 * scheduler's own (`validateScheduleFields`), so a stored value is one the
 * reconciler can act on. `null` clears a field on an update; `undefined` leaves
 * it alone.
 *
 * A schedule written here must name its model. The stored value keeps the
 * `vmodel` optional, because a record written before this rule exists still has
 * to be readable, and a record that names none fails at its run instead. Only
 * the write is held to the rule.
 */
function scheduleChange(
  routine: unknown,
  once: unknown,
  nowMs: number,
  before: JobRecord | undefined,
  vmodelKeys: () => readonly string[],
): { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null } {
  const given = validateScheduleFields(routine === null ? undefined : routine, once === null ? undefined : once, nowMs, {
    // A new one-off run must be in the future. An existing one is past its time
    // by definition once it fired, so an edit to its prompt is not refused for
    // the clock.
    requireFutureOnce: before?.once === undefined,
  });
  for (const [path, spec] of [
    ["routine", given.routine],
    ["once", given.once],
  ] as const) {
    if (spec === undefined) continue;
    const keys = vmodelKeys();
    const known = `Known vmodel keys: ${keys.join(", ") || "(none)"}`;
    if (spec.vmodel === undefined) {
      throw new Error(`${path}.vmodel is required and must be a key of config.vmodels. ${known}`);
    }
    if (!keys.includes(spec.vmodel)) {
      throw new Error(`${path}.vmodel "${spec.vmodel}" is not a key of config.vmodels. ${known}`);
    }
  }
  return {
    ...(routine === null ? { routine: null } : given.routine === undefined ? {} : { routine: given.routine }),
    ...(once === null ? { once: null } : given.once === undefined ? {} : { once: given.once }),
  };
}

/**
 * The routine gate, as the tools apply it.
 *
 * The judgement comes from the registry (`judgeRoutineChange`), so a tool and
 * the registry cannot disagree about which writes are gated. The approval comes
 * from `resolveRoutineApproval`, which reads the report store. A refusal is
 * returned as text with `isError` and recorded in the audit log with the new
 * `routine_refused` type: `restart_refused` is not reused, because its fields
 * are fixed by their own tests and name a different act.
 */
async function gateRoutineChange(args: {
  readonly context: ExtensionContext;
  readonly ctx: Context;
  readonly source: string;
  readonly reportId: string | undefined;
  readonly before: JobRecord | undefined;
  readonly change: RoutineChangeSubject;
  readonly jobId?: string;
}): Promise<{ readonly approval?: RoutineApproval; readonly refusal?: ToolRefusal }> {
  const gate = judgeRoutineChange(args.before, args.change);
  if (!gate.gated) return {};
  const outcome = await resolveRoutineApproval({
    reports: args.context.reports,
    context: args.ctx,
    reportId: args.reportId,
    gate,
  });
  if (outcome.ok) return { approval: outcome.approval };
  args.context.audit.append({
    type: "routine_refused",
    source: args.source,
    code: outcome.refusal.code,
    reasons: [...outcome.refusal.reasons],
    ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
    ...(args.reportId === undefined ? {} : { reportId: args.reportId }),
  });
  return { refusal: refusalText(outcome.refusal.message) };
}

function formatJob(job: JobRecord, timeZone: string): string {
  const parent = job.parentId !== undefined ? ` parent=${job.parentId}` : "";
  const run =
    job.lastRun !== undefined ? ` lastRun=${zoneIso(job.lastRun.at, timeZone)}:${job.lastRun.status}` : "";
  const done = job.completedAt !== undefined ? ` completed=${zoneIso(job.completedAt, timeZone)}` : "";
  return `${job.id} [${job.status}] ${job.title}${parent}${run}${done} runs=${job.stats.runs} failures=${job.stats.failures}`;
}

/**
 * Refuse a reparent that would make the tree unreadable.
 *
 * The registry stores `parentId` without a check, and every reader of the tree —
 * `tree`, `jobs_list`, the cancel route's descendant walk — recurses through it.
 * A cycle is not a wrong answer there, it is a hang: the walk never reaches a
 * job without children. So the tool is where a cycle is refused, and the walk up
 * from the new parent is what decides it. Seen ids are tracked as well, because
 * a chain that already loops in hand-edited data would otherwise be walked for
 * ever. `null` removes the parent and cannot close a loop, so it is not checked.
 */
async function assertReparentable(
  jobs: JobRegistry,
  context: Context,
  id: string,
  parentId: string,
): Promise<void> {
  if (parentId === id) throw new Error(`a job cannot be its own parent: ${id}`);
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor !== undefined) {
    if (cursor === id) {
      throw new Error(`job ${parentId} is a descendant of ${id}, so it cannot become its parent`);
    }
    if (seen.has(cursor)) {
      throw new Error(`the parent chain of ${parentId} already loops at ${cursor}`);
    }
    seen.add(cursor);
    const parent = await jobs.get(context, cursor);
    if (parent === undefined) throw new Error(`parent job not found: ${cursor}`);
    cursor = parent.parentId;
  }
}

function formatTree(nodes: readonly JobNode[], timeZone: string, depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}${formatJob(node.job, timeZone)}`);
    if (node.children.length > 0) lines.push(formatTree(node.children, timeZone, depth + 1));
  }
  return lines.join("\n");
}

/** The bundled `jobs` extension: durable high-level job records. */
export function createJobsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  // Every time this extension prints is the harness zone, read from the config
  // each call rather than captured: the zone is config, and config can be reloaded.
  const zone = (): string => context.getConfig().timezone;
  const list = defineTool({
    name: "jobs_list",
    description: "List every job you manage as a tree. Use this to enumerate your work at any time.",
    parameters: obj(
      {
        status: opt(StatusSchema),
        parentId: opt(str()),
        label: opt(str()),
        flat: opt(bool()),
        includeArchived: opt(bool()),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const jobs = requireJobs(context);
      const archive = optionalArchive(context);
      const archived =
        args.includeArchived === true && archive !== undefined ? await archive.list(ctx) : [];
      const section =
        archived.length === 0
          ? ""
          : `\n\nArchived (moved out of the live store; still readable by id):\n${archived.map((job) => formatJob(job, zone())).join("\n")}`;
      if (args.flat === true) {
        const all = await jobs.list(ctx, {
          status: args.status,
          parentId: args.parentId,
          label: args.label,
        });
        return {
          output: [{ type: "text" as const, text: (all.map((job) => formatJob(job, zone())).join("\n") || "(no jobs)") + section }],
        };
      }
      const tree = await jobs.tree(ctx, { status: args.status, parentId: args.parentId, label: args.label });
      return { output: [{ type: "text" as const, text: (formatTree(tree, zone()) || "(no jobs)") + section }] };
    },
  });

  const get = defineTool({
    name: "jobs_get",
    description: "Read one job's full record, including subjobs and links.",
    parameters: obj({ id: str() }),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const jobs = requireJobs(context);
      // Live first, then the archive: a finished job that has been moved out is
      // still a job, and an id held from an earlier turn must keep resolving.
      const job = (await jobs.get(ctx, args.id)) ?? (await optionalArchive(context)?.get(ctx, args.id));
      if (job === undefined) return { output: [{ type: "text" as const, text: `job not found: ${args.id}` }], isError: true };
      const children = (await jobs.list(ctx, { parentId: args.id })).map((child) => child.id);
      const archivedChildren = (await optionalArchive(context)?.registry.list(ctx, { parentId: args.id })) ?? [];
      const live = await jobs.get(ctx, args.id);
      const archived = live === undefined;
      return {
        output: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                // The numbers stay, because a script may read them, and each time
                // gets a readable twin in the harness zone beside it.
                ...withLocal(job, ["createdAt", "updatedAt", "completedAt"], zone()),
                ...(job.lastRun === undefined ? {} : { lastRun: withLocal(job.lastRun, ["at"], zone()) }),
                ...(job.once === undefined ? {} : { once: withLocal(job.once, ["at"], zone()) }),
                archived,
                subjobs: [...children, ...archivedChildren.map((child) => child.id)],
                // The drafts of this job that nobody published yet. A draft is
                // open work of its job, so the job's own record is where a reader
                // sees it; there are none left once the job has ended.
                drafts: ((await context.drafts?.list(ctx)) ?? [])
                  .filter((draft) => draft.jobId === args.id)
                  .map((draft) => ({
                    id: draft.id,
                    title: draft.title,
                    note: draft.note ?? null,
                    agentConversationId: draft.agentConversationId,
                    ...withLocal({ createdAt: draft.createdAt }, ["createdAt"], zone()),
                  })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  const create = defineTool({
    name: "jobs_create",
    description:
      "Create a durable high-level job. A job is the highest unit of work you track." +
      " A schedule lives on the record: `routine` is a recurring schedule and needs an approved report (`reportId`)," +
      " `once` is a single run at a time and needs nothing." +
      " When a `once` fires, or when its time passes unfired, the job is set to `done`.",
    // The schedule arguments are here because the record is the only schedule
    // source now: the scheduler reads `routine` and `once` off the record itself.
    // `additionalProperties: false` is what turns a stale `cron` or `timezone`
    // call into a validation error instead of an ignored key — an argument that
    // is accepted and then dropped is a caller who believes a job will fire.
    parameters: obj(
      {
        title: str(),
        description: opt(str()),
        parentId: opt(str()),
        labels: opt(arr(str())),
        memoryAnchors: opt(arr(str())),
        stateDir: opt(str()),
        conversationId: opt(str()),
        routine: opt(RoutineSchema),
        once: opt(OnceSchema),
        reportId: opt(str()),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const jobs = requireJobs(context);
      let schedule: { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null };
      try {
        schedule = scheduleChange(args.routine, args.once, Date.now(), undefined, () => Object.keys(context.getConfig().vmodels));
      } catch (error) {
        return refusalText(`schedule rejected — the job was not created: ${error instanceof Error ? error.message : String(error)}`);
      }
      const gate = await gateRoutineChange({
        context,
        ctx,
        source: "jobs_create",
        reportId: args.reportId,
        before: undefined,
        change: { routine: schedule.routine, once: schedule.once },
      });
      if (gate.refusal !== undefined) return gate.refusal;
      const job = await api.commit(
        (tx) =>
          jobs.createTx(tx, {
            title: args.title,
            description: args.description,
            parentId: args.parentId,
            labels: args.labels,
            memoryAnchors: args.memoryAnchors,
            stateDir: args.stateDir,
            ...(schedule.routine === undefined || schedule.routine === null ? {} : { routine: schedule.routine }),
            ...(schedule.once === undefined || schedule.once === null ? {} : { once: schedule.once }),
            ...(gate.approval === undefined ? {} : { routineApproval: gate.approval }),
            conversationId: args.conversationId ?? String(api.conversationId),
            origin: "agent",
          }),
        ctx,
      );
      context.events.emit("job_created", job as unknown as Record<string, unknown>);
      context.audit.append({ type: "job_created", jobId: job.id, title: job.title });
      return { output: [{ type: "text" as const, text: `created ${formatJob(job, zone())}` }] };
    },
  });

  const update = defineTool({
    name: "jobs_update",
    description:
      "Update a job's status or fields. Terminal statuses are retained, never deleted." +
      " `parentId` moves the job under another job; `null` removes the parent." +
      " `routine` sets or clears a recurring schedule (needs `reportId` of a report whose newest revision the user approved)," +
      " `once` sets or clears a single run (needs nothing), and closing or pausing a routine's job needs `reportId` too.",
    parameters: obj(
      {
        id: str(),
        status: opt(StatusSchema),
        parentId: opt(union([str(), nul()])),
        title: opt(str()),
        description: opt(str()),
        labels: opt(arr(str())),
        memoryAnchors: opt(arr(str())),
        stateDir: opt(str()),
        routine: opt(union([RoutineSchema, nul()])),
        once: opt(union([OnceSchema, nul()])),
        reportId: opt(str()),
        recordRun: opt(
          obj({ success: bool(), summary: opt(str()) }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const jobs = requireJobs(context);
      const before = await jobs.get(ctx, args.id);
      if (typeof args.parentId === "string") await assertReparentable(jobs, ctx, args.id, args.parentId);
      let schedule: { readonly routine?: JobRoutineSpec | null; readonly once?: JobOnceSpec | null };
      try {
        schedule = scheduleChange(args.routine, args.once, Date.now(), before, () => Object.keys(context.getConfig().vmodels));
      } catch (error) {
        return refusalText(`schedule rejected — nothing was written: ${error instanceof Error ? error.message : String(error)}`);
      }
      const gate = await gateRoutineChange({
        context,
        ctx,
        source: "jobs_update",
        reportId: args.reportId,
        before,
        change: { routine: schedule.routine, once: schedule.once, status: args.status },
        jobId: args.id,
      });
      if (gate.refusal !== undefined) return gate.refusal;
      const job = await api.commit(
        (tx) =>
          jobs.updateTx(tx, args.id, {
            status: args.status,
            parentId: args.parentId,
            title: args.title,
            description: args.description,
            labels: args.labels,
            memoryAnchors: args.memoryAnchors,
            stateDir: args.stateDir,
            routine: schedule.routine,
            once: schedule.once,
            ...(gate.approval === undefined ? {} : { routineApproval: gate.approval }),
            recordRun: args.recordRun,
          }),
        ctx,
      );
      context.events.emit("job_updated", job as unknown as Record<string, unknown>);
      // A draft is open work of its job, so the moment the job ends its drafts go
      // with it, through the same function the HTTP route calls. This runs after
      // the status is stored: a draft dropped for a status write that then failed
      // would be lost for nothing.
      const dropped = TERMINAL_JOB_STATUSES.includes(job.status)
        ? await dropDraftsOfEndedJobs(context.drafts, ctx, [job.id])
        : [];
      return {
        output: [{ type: "text" as const, text: `updated ${formatJob(job, zone())}${droppedDraftsNote(dropped)}` }],
      };
    },
  });

  const cancel = defineTool({
    name: "jobs_cancel",
    description:
      "Cancel a job and its non-terminal descendants. Descendants that are done, failed or cancelled keep their status." +
      " A job with a single run (`once`) is cancelled without an approval; a job with a recurring routine needs `reportId`." +
      " If a non-terminal descendant carries a routine, nothing is cancelled: close that job first with its own approval.",
    parameters: obj({ id: str(), reportId: opt(str()) }),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const jobs = requireJobs(context);
      const before = await jobs.get(ctx, args.id);
      if (before === undefined) throw new Error(`job not found: ${args.id}`);
      const gate = await gateRoutineChange({
        context,
        ctx,
        source: "jobs_cancel",
        reportId: args.reportId,
        before,
        change: { status: "cancelled" },
        jobId: args.id,
      });
      if (gate.refusal !== undefined) return gate.refusal;
      const descendants = await jobs.descendantIds(ctx, args.id);
      let result: JobCancelResult;
      try {
        // The same cancel the HTTP route runs, with one difference: an open
        // descendant that carries a routine refuses the whole call here.
        result = await api.commit(
          (tx) =>
            jobs.cancelTx(tx, args.id, descendants, {
              refuseRoutineDescendants: true,
              ...(gate.approval === undefined ? {} : { routineApproval: gate.approval }),
            }),
          ctx,
        );
      } catch (error) {
        if (!(error instanceof RoutineDescendantError)) throw error;
        context.audit.append({
          type: "routine_refused",
          source: "jobs_cancel",
          code: error.code,
          reasons: error.jobs.map((job) => `open descendant ${job.id} ("${job.title}") carries a routine`),
          jobId: args.id,
          ...(args.reportId === undefined ? {} : { reportId: args.reportId }),
        });
        return refusalText(error.message);
      }
      for (const job of [result.job, ...result.descendants]) {
        context.events.emit("job_updated", job as unknown as Record<string, unknown>);
      }
      // The cancel ends every job it moved, so each one takes its drafts with it.
      // The reply names them: the row retires, and a draft nobody published is
      // not recoverable.
      const dropped = await dropDraftsOfEndedJobs(context.drafts, ctx, [
        result.job.id,
        ...result.descendants.map((job) => job.id),
      ]);
      const also =
        result.descendants.length === 0
          ? ""
          : ` and ${result.descendants.length} non-terminal descendant${result.descendants.length === 1 ? "" : "s"}: ${result.descendants.map((job) => job.id).join(", ")}`;
      return {
        output: [{ type: "text" as const, text: `cancelled ${result.job.id}${also}${droppedDraftsNote(dropped)}` }],
      };
    },
  });

  /**
   * What the model reads about jobs, chosen by its own tool list.
   *
   * `jobs_create` and `spawn_subagent` together mean the reader opens jobs and
   * hands them on, which is the full text. A conversation without `jobs_create` is
   * a focused chat, which reads jobs and changes none of them. A conversation with
   * `jobs_create` and without `spawn_subagent` is a scheduled run: it writes the
   * job it reports on, and it starts no agent. The tool list is written in the
   * commit that creates the conversation and never changes, so the choice is as
   * stable as any other value a section renders.
   */
  const guide: PromptSection = {
    key: "jobs",
    render: (input) => {
      const offered = new Set(input.agent.tools.map((tool) => tool.name));
      const lines = [
        offered.has("jobs_create")
          ? "Jobs are your highest unit of work. Track one with `jobs_create`; list them with `jobs_list`."
          : "Jobs are your highest unit of work. List them with `jobs_list`, and read one with `jobs_get`.",
        `Statuses: ${JOB_STATUSES.join(", ")}. Parent/child is the only hierarchy; labels are hints, not types.`,
      ];
      // A handover names `spawn_subagent`, so only a conversation that may spawn
      // reads it.
      if (offered.has("spawn_subagent")) {
        lines.push("A handover is not a start: naming a job in `spawn_subagent` records the link and leaves the status alone.");
      }
      lines.push(
        "A job id is `YYYYMMDD-<ULID>`: its first segment is the day it was created, so it can be read off the id.",
        "A schedule is a field on the job record, and the record is the only source of one: `routine` is a recurring run and `once` is a single run at a time. When a `once` fires or is missed, its job is set to `done`, so do not put a `once` on a job that must stay open. `config.scheduler.jobs` is read once by the boot migration and then ignored, so editing it changes nothing.",
        "Creating, changing or deleting a `routine`, and closing or pausing the job that carries one, are gated: they need `reportId` of a report whose newest revision the user approved, and that approval must name that revision's sha256. A `once` run needs no approval at any point.",
        "Finished jobs are moved to a separate archive after a few days. They leave `jobs_list` but `jobs_get` still resolves them, and nothing is deleted. A job that carries a `routine` is never archived.",
      );
      return lines.join("\n");
    },
  };

  return defineExtension({ name: "jobs", tools: [list, get, create, update, cancel], sections: [guide] });
}

export type { JobStatus };
