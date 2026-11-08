/**
 * The job tree: nested rows with a status chip, a schedule badge, a reports link
 * and the run counts, and the full-width title block an opened job takes under
 * its row.
 *
 * The tree is a flat run of sibling rows indented by `data-depth`, exactly as the
 * old page drew it, so the stylesheet needs no change. Every row is keyed by the
 * job's id, which is what keeps the pressed chip or title, the opened block and
 * the list's scroll position where they are when a job event reads the tree back,
 * the page opens, or the tab returns.
 *
 * A closed job's chip clears the row and its subtree (recoverable from the revert
 * button at the foot, which remembers the last ten hides). A live chip with
 * children folds them, and that fold is session-only: a reload opens every group.
 * The title opens the full-width block, and that choice is saved on the server
 * (`expandedJobs`), so it survives a reload.
 */
import type { JSX, VNode } from "preact";
import type { JobNode, WorkingJob } from "../../../shared/wire/jobs.ts";
import { at } from "../../mount.ts";
import { isFolded } from "../../state/folds.ts";
import {
  CLEARABLE_STATUSES,
  clearJob,
  collapsedJobs,
  expandedJobs,
  hiddenJobs,
  jobs,
  legacyScheduleProblem,
  revertJobs,
  revertQueueJobs,
  toggleJobChildren,
  toggleJobExpanded,
  zoneRowStamp,
  zoneStamp,
} from "../../state/jobs.ts";

/** What the last run did. A row names an outcome, not a status code. */
const RUN_STATUS_LABELS: Readonly<Record<string, string>> = { success: "success", failure: "failed" };

/** What the last run did and when: the two words a row can spare. */
function lastRunText(lastRun: { readonly status?: string; readonly at?: number }): string {
  const status = String(lastRun.status ?? "");
  const label = RUN_STATUS_LABELS[status] ?? status;
  return [label, zoneRowStamp(lastRun.at)]
    .filter((part) => part !== "")
    .join(" ");
}

/** When a one-off run fires and where it stands. */
function OnceNotice({ job }: { job: WorkingJob }) {
  const once = job.once;
  if (once === undefined || once === null) return null;
  const state = String(once.state ?? "pending");
  const text = [zoneRowStamp(once.at), state].filter((part) => part !== "").join(" ");
  // A one-off that has fired also carries `lastRun`, and the row has room for one
  // notice only: the result joins the tooltip instead of the title's width.
  const result = job.lastRun === undefined || job.lastRun === null ? "" : lastRunText(job.lastRun);
  const note = [
    `once.at = ${zoneStamp(once.at)}`,
    `once.state = ${state}`,
    result === "" ? "" : `lastRun: ${result}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <span class="job-stats job-once" data-once-state={state} title={note}>
      {text}
    </span>
  );
}

/** What the last run did and when, with the record's own words in the tooltip. */
function LastRunNotice({ job }: { job: WorkingJob }) {
  const lastRun = job.lastRun;
  if (lastRun === undefined || lastRun === null) return null;
  const status = String(lastRun.status ?? "");
  const text = lastRunText(lastRun);
  const note = [status, lastRun.summary === undefined ? null : String(lastRun.summary), zoneStamp(lastRun.at)]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  const title = note === "" ? undefined : note;
  return (
    <span class="job-stats job-last-run" data-last-run-status={status} title={title}>
      {text}
    </span>
  );
}

/** One notice per row: a one-off names its own run, every other row its last run. */
function ScheduleNotice({ job }: { job: WorkingJob }) {
  if (job.once !== undefined && job.once !== null) return <OnceNotice job={job} />;
  return <LastRunNotice job={job} />;
}

/** A recurring schedule is `routine`, a single run is `once`, and both are fields. */
function ScheduleBadge({ job }: { job: WorkingJob }) {
  if (job.routine !== undefined && job.routine !== null) {
    return (
      <span class="job-stats job-badge" data-job-badge="routine">
        routine
      </span>
    );
  }
  if (job.once !== undefined && job.once !== null) {
    return (
      <span class="job-stats job-badge" data-job-badge="once">
        once
      </span>
    );
  }
  return null;
}

/**
 * The names of the agents working anywhere under these nodes, in tree order.
 *
 * A folded row hides its children, so their chips are not on screen. The folded
 * row is then the only place the operator can see that work is happening below
 * it, and this is what it is told. The walk is over the tree the server sent, so
 * a name appears once per job it is working on and the caller de-duplicates.
 */
function workingBelow(nodes: readonly JobNode[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    for (const worker of node.job.working ?? []) {
      if (typeof worker?.name === "string" && !names.includes(worker.name)) names.push(worker.name);
    }
    for (const name of workingBelow(node.children ?? [])) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The status chip: a clear button, a fold button, or a plain label.
 *
 * `below` names the agents working under this row, and it is read only while the
 * row is folded: an open row draws its own work and nothing else, because the
 * children it shows carry that information themselves. A folded row fills with
 * the same colour either way; the tooltip is what says which of the two lit it.
 */
function StatusChip({
  job,
  id,
  folds,
  below,
}: {
  job: WorkingJob;
  id: string;
  folds: boolean;
  below: readonly string[];
}) {
  // Derived by the server and read-only: `status` stays whatever the record says,
  // and this only says that an agent attached to the job is running right now.
  const workers = Array.isArray(job.working) ? job.working.filter((worker) => typeof worker?.name === "string") : [];
  const clearing = CLEARABLE_STATUSES.has(job.status);
  const folded = folds && collapsedJobs.value.has(id);
  const belowNow = folded ? below : [];
  const working = workers.length > 0 || belowNow.length > 0;
  const head = [
    clearing ? "Clear this job" : null,
    workers.length > 0 ? `Working: ${workers.map((worker) => worker.name).join(", ")}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  // Two facts, two lines: a row can be both worked on itself and the top of a
  // subtree that is being worked on. The screen is one fill either way.
  const note = [head, belowNow.length > 0 ? `Working below: ${belowNow.join(", ")}` : ""]
    .filter((part) => part !== "")
    .join("\n");
  const classes = `status-chip status-${job.status}${working ? " job-working" : ""}`;
  const title = note === "" ? undefined : note;
  if (clearing) {
    return (
      <button type="button" class={classes} data-hide-job={id} title={title} onClick={() => clearJob(id)}>
        {job.status}
      </button>
    );
  }
  if (folds) {
    return (
      <button
        type="button"
        class={classes}
        data-toggle-children={id}
        aria-expanded={folded ? "false" : "true"}
        title={title}
        onClick={() => toggleJobChildren(id)}
      >
        {`${folded ? "▸" : "▾"} ${job.status}`}
      </button>
    );
  }
  return (
    <span class={classes} title={title}>
      {job.status}
    </span>
  );
}

/** One job row, its opened block, and then its children. */
function pushRows(nodes: readonly JobNode[], depth: number, out: VNode[]): void {
  for (const node of nodes) {
    const job = node.job;
    const id = String(job.id);
    // A cleared job takes its subtree with it: that is the row the operator asked
    // to stop seeing.
    if (hiddenJobs.value.has(id)) continue;
    const expanded = expandedJobs.value.has(id);
    const clearing = CLEARABLE_STATUSES.has(job.status);
    const folds = !clearing && (node.children?.length ?? 0) > 0;
    // Only a folded row can hide the work below it, so only a folded row is told
    // about it. An open row's children are on screen and speak for themselves.
    const below = folds ? workingBelow(node.children ?? []) : [];
    // The title leaves the row when it is opened: the row is 22rem and a long
    // title only wrapped inside a quarter of it. The button keeps the caret as its
    // one visible mark and the title only where a screen reader reads it.
    const title: JSX.Element = expanded ? (
      <button
        type="button"
        class="job-title expanded"
        aria-expanded="true"
        aria-label={job.title}
        onClick={() => toggleJobExpanded(id)}
      />
    ) : (
      <button type="button" class="job-title" aria-expanded="false" onClick={() => toggleJobExpanded(id)}>
        {job.title}
      </button>
    );
    out.push(
      <div class="job-row" key={`row:${id}`} data-job-id={id} data-depth={Math.min(depth, 8)} title={job.title}>
        <StatusChip job={job} id={id} folds={folds} below={below} />
        <ScheduleBadge job={job} />
        {title}
        <a class="job-reports" href={at(`/report?job=${encodeURIComponent(id)}`)} title="Reports for this job">
          ▤
        </a>
        <ScheduleNotice job={job} />
        <span class="job-stats job-counts">{`${job.stats.runs}/${job.stats.failures}`}</span>
      </div>,
    );
    // A direct child of `#jobs`, so the block is as wide as the panel's content box
    // and carries no depth indent of its own. It carries `data-open-job-id` rather
    // than `data-job-id`, so one job is one `[data-job-id]` node.
    if (expanded) {
      out.push(
        <button
          type="button"
          class="job-open"
          key={`open:${id}`}
          data-open-job-id={id}
          aria-expanded="true"
          aria-label={`Collapse: ${job.title}`}
          onClick={() => toggleJobExpanded(id)}
        >
          <span class="job-open-title">{job.title}</span>
        </button>,
      );
    }
    // Folded: the row stays, its children do not. The tree is a flat run of
    // sibling rows, so the skip happens here and not in the stylesheet.
    if (!collapsedJobs.value.has(id) && node.children?.length) pushRows(node.children, depth + 1, out);
  }
}

/**
 * The count of jobs an agent is on, for the heading of a folded job tree.
 *
 * The working marker is a fill on a row's chip, and a folded panel has no row on
 * screen. So the heading says the number of jobs with an agent on them, which is
 * the one fact the fold would otherwise hide. Each job counts once however many
 * agents it holds, and a cleared job does not count: it is not on the list even
 * while the panel is open. Nothing working, or a panel that is open, draws no
 * badge at all.
 */
export function workingCount(nodes: readonly JobNode[], hidden: ReadonlySet<string>): number {
  let count = 0;
  for (const node of nodes) {
    const id = String(node.job.id);
    if (hidden.has(id)) continue;
    if (Array.isArray(node.job.working) && node.job.working.length > 0) count += 1;
    count += workingCount(node.children ?? [], hidden);
  }
  return count;
}

/** The badge the shell carries as `#jobs-working`, in the job tree's heading. */
export function JobsWorkingBadge(): VNode {
  const count = isFolded("jobs") ? workingCount(jobs.value, hiddenJobs.value) : 0;
  const hidden = count === 0;
  return (
    <span
      id="jobs-working"
      class={hidden ? "badge badge-working hidden" : "badge badge-working"}
      title={hidden ? undefined : `${count} ${count === 1 ? "job is" : "jobs are"} working`}
    >
      {hidden ? "" : `${count} working`}
    </span>
  );
}

/** The panel the shell carries as `#jobs`. */
export function JobsPanel() {
  const rows: VNode[] = [];
  pushRows(jobs.value, 0, rows);
  const queue = revertQueueJobs.value;
  const problem = legacyScheduleProblem.value;
  // The banner sits above the tree and above the empty line: the list that came
  // back is exactly the case where a job the operator believed was scheduled fires
  // nothing.
  const banner =
    problem === null ? null : (
      <p class="jobs-banner" role="alert">
        {problem}
      </p>
    );
  return (
    <div id="jobs" class="jobs">
      {banner}
      {rows.length === 0 && hiddenJobs.value.size === 0 ? (
        <p class="inbox-body">No jobs yet.</p>
      ) : (
        [
          ...rows,
          <button type="button" class="list-clear" id="jobs-restore" key="revert" disabled={queue.length === 0} onClick={() => revertJobs()}>
            {`↩ revert (${queue.length})`}
          </button>,
        ]
      )}
    </div>
  );
}
