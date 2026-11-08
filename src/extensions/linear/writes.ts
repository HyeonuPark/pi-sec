import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, int, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { checkApprovedReport } from "../../jobs/registry.ts";
import { LinearError, describeError, requireData, isNotFound, type LinearClient, type LinearResult } from "./client.ts";
import { DESCRIPTION_ADD_COMMENT, DESCRIPTION_CREATE_ISSUE, DESCRIPTION_UPDATE_ISSUE } from "./descriptions.ts";
import type { LinearEnv } from "./env.ts";
import { refusal, when, type ToolText } from "./format.ts";
import { grantsIssue, grantsTeam, parseGrants } from "./grants.ts";
import { issueRef, teamFilter } from "./reads.ts";

/**
 * The write rule, in code.
 *
 * A write needs the user's request and an approved report revision that names
 * its target in a grant line (`grants.ts`). Code cannot check the request, which
 * is the user's own words, so it checks the approval. The steps run in this
 * order, and the first one that fails ends the call:
 *
 *   1. `linear.writes` is true in the configuration read now.
 *   2. `checkApprovedReport`, the check the routine gate and the restart gate use.
 *   3. The newest revision's text can be read, and its sha256 is the recorded one.
 *   4. The text holds a grant line.
 *   5. One read of the target from Linear.
 *   6. A grant line names the target.
 *   7. Names are resolved with reads, and one mutation is sent.
 *
 * Steps 1 to 4 run before any request. Every call, refused or sent, leaves one
 * audit row, and the row never holds a title, a description or a comment body.
 */

export const CREATE_DOCUMENT =
  "mutation LinearIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { name } } } }";
export const UPDATE_DOCUMENT =
  "mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url } } }";
export const COMMENT_DOCUMENT =
  "mutation LinearCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id createdAt url } } }";

const TEAM_DOCUMENT =
  "query LinearTeamForWrite($filter: TeamFilter) { teams(filter: $filter, first: 10) { nodes { id key name } } }";
const ISSUE_DOCUMENT =
  "query LinearIssueForWrite($id: String!) { issue(id: $id) { id identifier title url team { id key } state { id name } assignee { id name displayName } priority priorityLabel project { id name } dueDate estimate labels(first: 50) { nodes { id name } } } }";
const STATES_DOCUMENT =
  "query LinearStatesForWrite($filter: WorkflowStateFilter) { workflowStates(filter: $filter, first: 100) { nodes { id name } } }";
const LABELS_DOCUMENT =
  "query LinearLabelsForWrite($filter: IssueLabelFilter) { issueLabels(filter: $filter, first: 250) { nodes { id name } } }";
const PROJECTS_DOCUMENT =
  "query LinearProjectsForWrite($filter: ProjectFilter) { projects(filter: $filter, first: 100) { nodes { id name } } }";
const USERS_DOCUMENT =
  "query LinearUsersForWrite($filter: UserFilter) { users(filter: $filter, first: 10) { nodes { id name displayName email } } }";
const VIEWER_DOCUMENT = "query LinearViewerForWrite { viewer { id name displayName } }";

export const WRITE_DOCUMENTS: Readonly<Record<string, { document: string; mutation: string }>> = {
  linear_create_issue: { document: CREATE_DOCUMENT, mutation: "issueCreate" },
  linear_update_issue: { document: UPDATE_DOCUMENT, mutation: "issueUpdate" },
  linear_add_comment: { document: COMMENT_DOCUMENT, mutation: "commentCreate" },
};

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTHING_SENT = "Nothing was sent to Linear.";
const ONE_READ = "No write was sent to Linear. One read was sent.";
const NO_WRITE = "No write was sent to Linear.";

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A refusal that ends the call and leaves one audit row. */
class WriteRefused extends LinearError {
  readonly step: Step | "arguments";
  constructor(step: Step | "arguments", message: string) {
    super(message);
    this.step = step;
  }
}

interface Approved {
  readonly reportId: string;
  readonly revision: number;
  readonly grants: ReadonlySet<string>;
}

interface Call {
  readonly tool: string;
  readonly conversationId: string;
  readonly reportId: string | undefined;
  readonly target: string;
  readonly lengths: Record<string, number>;
  readonly fields: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Steps 1 to 4. They send nothing, and a refusal says so. */
async function approve(env: LinearEnv, reportId: string | undefined, ctx: Context): Promise<Approved> {
  const { context } = env;
  if (context.getConfig().linear?.writes !== true) {
    throw new WriteRefused(1, `Refused at step 1: linear.writes is false in this install's configuration, so no Linear write is allowed. ${NOTHING_SENT}`);
  }
  const reports = context.reports;
  if (reports === undefined) {
    throw new WriteRefused(2, `Refused at step 2: the reports extension is not enabled, so no approval can be read. ${NOTHING_SENT}`);
  }
  const check = await checkApprovedReport({
    reports,
    context: ctx,
    reportId,
    wording: { act: "this Linear write", retry: (id) => `call again with report_id=${id}` },
  });
  if (!check.ok) {
    throw new WriteRefused(2, `Refused at step 2: ${check.detail} ${NOTHING_SENT}`);
  }
  const text = await reports.readVersion(check.reportId, check.revision);
  if (text === undefined || sha256(text) !== check.sha256) {
    throw new WriteRefused(
      3,
      `Refused at step 3: the text of report ${check.reportId} v${String(check.revision)} could not be read as the approved revision. ${NOTHING_SENT}`,
    );
  }
  const grants = parseGrants(text);
  if (grants.size === 0) {
    throw new WriteRefused(
      4,
      `Refused at step 4: the approved text of report ${check.reportId} v${String(check.revision)} holds no grant line. A grant line starts with "linear-write:" and lists issue identifiers or team:<KEY> targets. ${NOTHING_SENT}`,
    );
  }
  return { reportId: check.reportId, revision: check.revision, grants };
}

interface Named {
  readonly id: string;
  readonly name: string;
}

/** Pick one item by name: an exact match ignoring case, else one item that contains the text. */
function pick(kind: string, wanted: string, scope: string, items: readonly Named[], extra?: (item: Named) => string[]): Named {
  const needle = wanted.trim().toLowerCase();
  const keys = (item: Named): string[] => [item.name.toLowerCase(), ...(extra?.(item) ?? [])].map((k) => k.toLowerCase());
  const exact = items.filter((item) => keys(item).includes(needle));
  const partial = items.filter((item) => keys(item).some((k) => k.includes(needle)));
  const found = exact.length > 0 ? exact : partial;
  if (found.length === 1) return found[0] as Named;
  const list = (found.length > 0 ? found : items).slice(0, 15).map((item) => item.name).join(", ");
  if (found.length === 0) {
    throw new WriteRefused(7, `Refused at step 7: no ${kind} named "${wanted}" in ${scope}. Candidates: ${list || "(none)"}. ${NO_WRITE}`);
  }
  throw new WriteRefused(7, `Refused at step 7: the ${kind} "${wanted}" matches ${String(found.length)} items in ${scope}: ${list}. Use a more exact name. ${NO_WRITE}`);
}

async function readNodes(client: LinearClient, tool: string, document: string, variables: Record<string, unknown>, field: string): Promise<Named[]> {
  const result = requireData(await client.request(tool, document, variables, "query"));
  return (result.data[field] as { nodes: Named[] }).nodes;
}

/** Resolve the names an issue field may carry to ids, inside one team. */
class Resolver {
  private readonly client: LinearClient;
  private readonly tool: string;
  private readonly teamId: string;
  private readonly teamKey: string;

  constructor(client: LinearClient, tool: string, teamId: string, teamKey: string) {
    this.client = client;
    this.tool = tool;
    this.teamId = teamId;
    this.teamKey = teamKey;
  }

  private scope(): string {
    return `team ${this.teamKey}`;
  }

  async state(name: string): Promise<Named> {
    const nodes = await readNodes(this.client, this.tool, STATES_DOCUMENT, { filter: { team: { id: { eq: this.teamId } } } }, "workflowStates");
    return pick("state", name, this.scope(), nodes);
  }

  async labels(names: readonly string[]): Promise<Named[]> {
    const nodes = await readNodes(
      this.client,
      this.tool,
      LABELS_DOCUMENT,
      { filter: { or: [{ team: { id: { eq: this.teamId } } }, { team: { null: true } }] } },
      "issueLabels",
    );
    return names.map((name) => pick("label", name, this.scope(), nodes));
  }

  async project(name: string): Promise<Named> {
    const nodes = await readNodes(
      this.client,
      this.tool,
      PROJECTS_DOCUMENT,
      { filter: { accessibleTeams: { some: { id: { eq: this.teamId } } } } },
      "projects",
    );
    return pick("project", name, this.scope(), nodes);
  }

  async assignee(who: string): Promise<string> {
    if (who.trim().toLowerCase() === "me") {
      const result = requireData(await this.client.request(this.tool, VIEWER_DOCUMENT, {}, "query"));
      return (result.data.viewer as { id: string }).id;
    }
    const text = who.trim();
    const nodes = (await readNodes(
      this.client,
      this.tool,
      USERS_DOCUMENT,
      { filter: { or: [{ name: { containsIgnoreCase: text } }, { displayName: { containsIgnoreCase: text } }, { email: { containsIgnoreCase: text } }] } },
      "users",
    )) as (Named & { displayName?: string; email?: string })[];
    const named = nodes.map((user) => ({ ...user, name: user.displayName || user.name }));
    return pick("user", who, "the workspace", named, (item) => {
      const original = nodes.find((user) => user.id === item.id);
      return [original?.name ?? "", original?.email ?? ""];
    }).id;
  }

  async parent(identifier: string): Promise<string> {
    const result = await this.client.request(this.tool, ISSUE_DOCUMENT, { id: issueRef(identifier) }, "query");
    if (isNotFound(result, "issue")) {
      throw new WriteRefused(7, `Refused at step 7: no parent issue ${identifier} is visible to this key. ${NO_WRITE}`);
    }
    return (requireData(result).data.issue as { id: string }).id;
  }
}

interface IssueForWrite {
  id: string;
  identifier: string;
  title: string;
  url: string;
  team: { id: string; key: string };
  state: Named | null;
  assignee: { id: string; name: string; displayName?: string } | null;
  priority: number | null;
  priorityLabel: string | null;
  project: Named | null;
  dueDate: string | null;
  estimate: number | null;
  labels: { nodes: Named[] };
}

/** Step 5 for an update or a comment: read the issue once. */
async function readIssue(client: LinearClient, tool: string, rawId: string): Promise<IssueForWrite> {
  const id = issueRef(rawId);
  const result = await client.request(tool, ISSUE_DOCUMENT, { id }, "query");
  if (isNotFound(result, "issue")) throw new WriteRefused(5, `Refused at step 5: no issue ${id} is visible to this key. ${ONE_READ}`);
  return requireData(result).data.issue as IssueForWrite;
}

function mutationResult(result: LinearResult, field: string): Record<string, unknown> {
  if (result.data === null) {
    throw new WriteRefused(7, `Linear returned an error: ${result.errors.map(describeError).join("; ")}. The write was not applied.`);
  }
  const payload = result.data[field] as { success?: boolean } & Record<string, unknown>;
  if (payload?.success !== true) {
    const why = result.errors.length > 0 ? ` ${result.errors.map(describeError).join("; ")}.` : "";
    throw new WriteRefused(7, `Linear did not accept the write (success was not true).${why} Read the target before you try again.`);
  }
  return payload;
}

export function createWriteTools(env: LinearEnv): ToolRegistration[] {
  const { context, deps } = env;

  /**
   * Run one write tool: the gate, the reads, the mutation, and the audit row.
   *
   * `check` runs after step 4 and before any request. It throws a refusal for
   * arguments that cannot be sent, so a bad call sends nothing.
   */
  async function execute(
    tool: string,
    call: Omit<Call, "tool" | "conversationId" | "reportId">,
    args: { report_id?: string },
    api: ToolExecutionApi,
    ctx: Context,
    check: () => void,
    body: (client: LinearClient, approved: Approved) => Promise<{ text: string; url: string; target: string }>,
  ): Promise<ToolText> {
    const base: Call = { tool, conversationId: String(api.conversationId), reportId: args.report_id, ...call };
    let audited = false;
    const record = (error: LinearError, approved?: Approved): void => {
      audited = true;
      if (!(error instanceof WriteRefused) && error.unsure) {
        context.audit.append({ type: "linear_write", ...rowOf(base, approved), outcome: "unknown" });
        return;
      }
      const step = error instanceof WriteRefused ? error.step : 7;
      context.audit.append({ type: "linear_write_refused", ...rowOf(base, approved), step });
    };

    let approved: Approved;
    try {
      approved = await approve(env, args.report_id, ctx);
      check();
    } catch (error) {
      if (error instanceof WriteRefused) {
        record(error);
        return refusal(error.message);
      }
      throw error;
    }

    const result = await env.run(async (client) => {
      try {
        const sent = await body(client, approved);
        audited = true;
        context.audit.append({
          type: "linear_write",
          ...rowOf({ ...base, target: sent.target }, approved),
          outcome: "sent",
          url: sent.url,
        });
        return sent.text;
      } catch (error) {
        if (error instanceof LinearError) record(error, approved);
        throw error;
      }
    });
    if (result.isError === true && !audited) {
      // The key could not be read, so the body never ran.
      context.audit.append({ type: "linear_write_refused", ...rowOf(base, approved), step: 5 });
    }
    return result;
  }

  const create = defineTool({
    name: "linear_create_issue",
    description: DESCRIPTION_CREATE_ISSUE,
    parameters: obj({
      report_id: str(),
      team: str(),
      title: str({ maxLength: 255 }),
      description: opt(str({ maxLength: 20_000 })),
      state: opt(str()),
      assignee: opt(str()),
      priority: opt(int({ minimum: 0, maximum: 4 })),
      labels: opt(arr(str())),
      project: opt(str()),
      parent: opt(str()),
      due_date: opt(str()),
      estimate: opt(num()),
    }),
    execute: async (args: CreateArgs, api, ctx) =>
      execute(
        "linear_create_issue",
        {
          target: args.team,
          lengths: {
            title: args.title.length,
            ...(args.description === undefined ? {} : { description: args.description.length }),
          },
          fields: CREATE_FIELDS.filter((key) => args[key] !== undefined),
        },
        args,
        api,
        ctx,
        () => {
          if (args.title.trim() === "") throw new WriteRefused("arguments", `Refused: title must not be empty. ${NOTHING_SENT}`);
          if (args.due_date !== undefined && !DATE.test(args.due_date)) {
            throw new WriteRefused("arguments", `Refused: due_date must be YYYY-MM-DD. ${NOTHING_SENT}`);
          }
        },
        async (client, approved) => {
          // Step 5: read the team once.
          const teams = (await readNodes(client, "linear_create_issue", TEAM_DOCUMENT, { filter: teamFilter(args.team) }, "teams")) as TeamNode[];
          const wanted = args.team.trim().toLowerCase();
          const byKey = teams.filter((t) => t.key.toLowerCase() === wanted);
          const found = byKey.length > 0 ? byKey : teams.filter((t) => t.name.toLowerCase() === wanted);
          if (found.length === 0) {
            throw new WriteRefused(5, `Refused at step 5: no team "${args.team}" is visible to this key. ${ONE_READ}`);
          }
          if (found.length > 1) {
            throw new WriteRefused(
              5,
              `Refused at step 5: "${args.team}" matches ${String(found.length)} teams: ${found.map((t) => `${t.key} ${t.name}`).join(", ")}. Use the team key. ${ONE_READ}`,
            );
          }
          const team = found[0] as TeamNode;
          // Step 6: a grant line names the team.
          if (!grantsTeam(approved.grants, team.key)) {
            throw new WriteRefused(
              6,
              `Refused at step 6: the approved text of report ${approved.reportId} v${String(approved.revision)} has no grant line for team:${team.key}. ${ONE_READ}`,
            );
          }
          // Step 7: resolve names, then send one mutation.
          const resolver = new Resolver(client, "linear_create_issue", team.id, team.key);
          const input: Record<string, unknown> = { id: deps.newId(), teamId: team.id, title: args.title };
          if (args.description !== undefined) input.description = args.description;
          if (args.state !== undefined) input.stateId = (await resolver.state(args.state)).id;
          if (args.assignee !== undefined) input.assigneeId = await resolver.assignee(args.assignee);
          if (args.priority !== undefined) input.priority = args.priority;
          if (args.labels !== undefined && args.labels.length > 0) input.labelIds = (await resolver.labels(args.labels)).map((l) => l.id);
          if (args.project !== undefined) input.projectId = (await resolver.project(args.project)).id;
          if (args.parent !== undefined) input.parentId = await resolver.parent(args.parent);
          if (args.due_date !== undefined) input.dueDate = args.due_date;
          if (args.estimate !== undefined) input.estimate = args.estimate;
          const sent = mutationResult(
            await client.request("linear_create_issue", CREATE_DOCUMENT, { input }, { mutation: "issueCreate" }, { write: true }),
            "issueCreate",
          );
          const issue = sent.issue as { identifier: string; title: string; url: string; state?: { name: string } | null };
          return {
            text: `Created ${issue.identifier}: ${issue.title} [${issue.state?.name ?? "-"}]\n${issue.url}`,
            url: issue.url,
            target: `team:${team.key}`,
          };
        },
      ),
  });

  const update = defineTool({
    name: "linear_update_issue",
    description: DESCRIPTION_UPDATE_ISSUE,
    parameters: obj({
      report_id: str(),
      id: str(),
      title: opt(str({ maxLength: 255 })),
      state: opt(str()),
      assignee: opt(str()),
      priority: opt(int({ minimum: 0, maximum: 4 })),
      add_labels: opt(arr(str())),
      remove_labels: opt(arr(str())),
      project: opt(str()),
      due_date: opt(str()),
      estimate: opt(unknown()),
    }),
    execute: async (args: UpdateArgs, api, ctx) =>
      execute(
        "linear_update_issue",
        {
          target: args.id,
          lengths: args.title === undefined ? {} : { title: args.title.length },
          fields: UPDATE_FIELDS.filter((key) => args[key] !== undefined),
        },
        args,
        api,
        ctx,
        () => {
          if (UPDATE_FIELDS.every((key) => args[key] === undefined)) {
            throw new WriteRefused("arguments", `Refused: give at least one field to change. ${NOTHING_SENT}`);
          }
          if (args.title !== undefined && args.title.trim() === "") throw new WriteRefused("arguments", `Refused: title must not be empty. ${NOTHING_SENT}`);
          if (args.due_date !== undefined && args.due_date !== "none" && !DATE.test(args.due_date)) {
            throw new WriteRefused("arguments", `Refused: due_date must be YYYY-MM-DD, or none. ${NOTHING_SENT}`);
          }
          if (args.estimate !== undefined && args.estimate !== "none" && typeof args.estimate !== "number") {
            throw new WriteRefused("arguments", `Refused: estimate must be a number, or none. ${NOTHING_SENT}`);
          }
        },
        async (client, approved) => {
          // Step 5: read the issue once.
          const issue = await readIssue(client, "linear_update_issue", args.id);
          // Step 6: a grant line names the issue or its team.
          if (!grantsIssue(approved.grants, issue.identifier, issue.team.key)) {
            throw new WriteRefused(
              6,
              `Refused at step 6: the approved text of report ${approved.reportId} v${String(approved.revision)} has no grant line for ${issue.identifier} or team:${issue.team.key}. ${ONE_READ}`,
            );
          }
          // Step 7: resolve names, then send one mutation.
          const resolver = new Resolver(client, "linear_update_issue", issue.team.id, issue.team.key);
          const input: Record<string, unknown> = {};
          const changes: string[] = [];
          if (args.title !== undefined) {
            input.title = args.title;
            changes.push(`title: ${issue.title} -> ${args.title}`);
          }
          if (args.state !== undefined) {
            const state = await resolver.state(args.state);
            input.stateId = state.id;
            changes.push(`state: ${issue.state?.name ?? "-"} -> ${state.name}`);
          }
          if (args.assignee !== undefined) {
            const old = issue.assignee === null ? "unassigned" : issue.assignee.displayName || issue.assignee.name;
            if (args.assignee.trim().toLowerCase() === "none") {
              input.assigneeId = null;
              changes.push(`assignee: ${old} -> unassigned`);
            } else {
              input.assigneeId = await resolver.assignee(args.assignee);
              changes.push(`assignee: ${old} -> ${args.assignee}`);
            }
          }
          if (args.priority !== undefined) {
            input.priority = args.priority;
            changes.push(`priority: ${issue.priorityLabel ?? "-"} -> ${PRIORITY_LABELS[args.priority] ?? String(args.priority)}`);
          }
          if (args.add_labels !== undefined && args.add_labels.length > 0) {
            const labels = await resolver.labels(args.add_labels);
            input.addedLabelIds = labels.map((l) => l.id);
            changes.push(`labels added: ${labels.map((l) => l.name).join(", ")}`);
          }
          if (args.remove_labels !== undefined && args.remove_labels.length > 0) {
            const present = issue.labels.nodes;
            const labels = args.remove_labels.map((name) => pick("label", name, `the labels of ${issue.identifier}`, present));
            input.removedLabelIds = labels.map((l) => l.id);
            changes.push(`labels removed: ${labels.map((l) => l.name).join(", ")}`);
          }
          if (args.project !== undefined) {
            if (args.project.trim().toLowerCase() === "none") {
              input.projectId = null;
              changes.push(`project: ${issue.project?.name ?? "-"} -> none`);
            } else {
              const project = await resolver.project(args.project);
              input.projectId = project.id;
              changes.push(`project: ${issue.project?.name ?? "-"} -> ${project.name}`);
            }
          }
          if (args.due_date !== undefined) {
            input.dueDate = args.due_date === "none" ? null : args.due_date;
            changes.push(`due date: ${issue.dueDate ?? "-"} -> ${args.due_date}`);
          }
          if (args.estimate !== undefined) {
            input.estimate = args.estimate === "none" ? null : args.estimate;
            changes.push(`estimate: ${issue.estimate ?? "-"} -> ${String(args.estimate)}`);
          }
          const sent = mutationResult(
            await client.request("linear_update_issue", UPDATE_DOCUMENT, { id: issue.id, input }, { mutation: "issueUpdate" }, { write: true }),
            "issueUpdate",
          );
          const url = (sent.issue as { url?: string } | null)?.url ?? issue.url;
          return { text: `Updated ${issue.identifier}:\n${changes.map((c) => `  ${c}`).join("\n")}\n${url}`, url, target: issue.identifier };
        },
      ),
  });

  const comment = defineTool({
    name: "linear_add_comment",
    description: DESCRIPTION_ADD_COMMENT,
    parameters: obj({ report_id: str(), id: str(), body: str({ maxLength: 10_000 }), reply_to: opt(str()) }),
    execute: async (args: { report_id: string; id: string; body: string; reply_to?: string }, api, ctx) =>
      execute(
        "linear_add_comment",
        {
          target: args.id,
          lengths: { body: args.body.length },
          fields: ["body", ...(args.reply_to === undefined ? [] : ["reply_to"])],
        },
        args,
        api,
        ctx,
        () => {
          if (args.body.trim() === "") throw new WriteRefused("arguments", `Refused: body must not be empty. ${NOTHING_SENT}`);
        },
        async (client, approved) => {
          // Step 5: read the issue once.
          const issue = await readIssue(client, "linear_add_comment", args.id);
          // Step 6: a grant line names the issue or its team.
          if (!grantsIssue(approved.grants, issue.identifier, issue.team.key)) {
            throw new WriteRefused(
              6,
              `Refused at step 6: the approved text of report ${approved.reportId} v${String(approved.revision)} has no grant line for ${issue.identifier} or team:${issue.team.key}. ${ONE_READ}`,
            );
          }
          // Step 7: send one mutation.
          const input: Record<string, unknown> = { issueId: issue.id, body: args.body };
          if (args.reply_to !== undefined) input.parentId = args.reply_to;
          const sent = mutationResult(
            await client.request("linear_add_comment", COMMENT_DOCUMENT, { input }, { mutation: "commentCreate" }, { write: true }),
            "commentCreate",
          );
          const added = sent.comment as { id: string; createdAt: string; url: string };
          const zone = context.getConfig().timezone;
          return {
            text: `Added comment ${added.id} to ${issue.identifier} at ${when(added.createdAt, zone)}\n${added.url}`,
            url: added.url,
            target: issue.identifier,
          };
        },
      ),
  });

  return [create, update, comment] as unknown as ToolRegistration[];
}

interface TeamNode extends Named {
  readonly key: string;
}

interface CreateArgs {
  report_id: string;
  team: string;
  title: string;
  description?: string;
  state?: string;
  assignee?: string;
  priority?: number;
  labels?: string[];
  project?: string;
  parent?: string;
  due_date?: string;
  estimate?: number;
}

interface UpdateArgs {
  report_id: string;
  id: string;
  title?: string;
  state?: string;
  assignee?: string;
  priority?: number;
  add_labels?: string[];
  remove_labels?: string[];
  project?: string;
  due_date?: string;
  estimate?: number | string;
}

const CREATE_FIELDS = ["title", "description", "state", "assignee", "priority", "labels", "project", "parent", "due_date", "estimate"] as const;
const UPDATE_FIELDS = ["title", "state", "assignee", "priority", "add_labels", "remove_labels", "project", "due_date", "estimate"] as const;

function rowOf(call: Call, approved: Approved | undefined): Record<string, unknown> {
  return {
    conversationId: call.conversationId,
    tool: call.tool,
    reportId: approved?.reportId ?? call.reportId ?? null,
    ...(approved === undefined ? {} : { revision: approved.revision }),
    target: call.target,
    fields: call.fields,
    lengths: call.lengths,
  };
}
