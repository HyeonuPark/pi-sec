import { int, obj, opt, str, bool, unknown } from "@earendil-works/pi-schema";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { LinearError, errorLines, isNotFound, requireData, describeError } from "./client.ts";
import {
  DESCRIPTION_GET_ISSUE,
  DESCRIPTION_GET_PROJECT,
  DESCRIPTION_GRAPHQL,
  DESCRIPTION_LIST_PROJECTS,
  DESCRIPTION_LIST_TEAMS,
  DESCRIPTION_SEARCH_ISSUES,
  DESCRIPTION_STATUS,
} from "./descriptions.ts";
import type { LinearEnv } from "./env.ts";
import {
  ANSWER_LIMIT,
  COMMENT_TEXT_LIMIT,
  DATA_NOTICE,
  ISSUE_TEXT_LIMIT,
  cursorLine,
  cut,
  issueLine,
  joinWithinLimit,
  person,
  when,
} from "./format.ts";

const READ = "query" as const;
const OUTPUT_LIMITS = { maxBytes: 32768, retain: "head" } as const;
const STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);
const PROJECT_STATUSES = new Set(["backlog", "planned", "started", "paused", "completed", "canceled"]);

/** The issue fields every list line needs. */
const ISSUE_LINE_FIELDS =
  "identifier title url priorityLabel updatedAt state { name type } assignee { name displayName } team { key } project { name } labels(first: 5) { nodes { name } }";

export const STATUS_DOCUMENT = "query LinearStatus { viewer { id name displayName email admin guest } organization { name urlKey } }";

export const SEARCH_DOCUMENT = `query LinearSearchIssues($term: String!, $filter: IssueFilter, $first: Int!, $after: String, $includeComments: Boolean, $includeArchived: Boolean) { searchIssues(term: $term, filter: $filter, first: $first, after: $after, includeComments: $includeComments, includeArchived: $includeArchived) { nodes { ${ISSUE_LINE_FIELDS} } pageInfo { hasNextPage endCursor } } }`;

export const LIST_ISSUES_DOCUMENT = `query LinearListIssues($filter: IssueFilter, $first: Int!, $after: String, $includeArchived: Boolean) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt, includeArchived: $includeArchived) { nodes { ${ISSUE_LINE_FIELDS} } pageInfo { hasNextPage endCursor } } }`;

export const GET_ISSUE_DOCUMENT =
  "query LinearGetIssue($id: String!, $commentsFirst: Int!, $commentsAfter: String) { issue(id: $id) { id identifier title url priorityLabel dueDate estimate createdAt updatedAt completedAt canceledAt description state { name type } assignee { name displayName } creator { name displayName } team { key name } project { name } cycle { number name } parent { identifier title } labels(first: 10) { nodes { name } } children(first: 25) { nodes { identifier title state { name } } } relations(first: 10) { nodes { type relatedIssue { identifier title } } } attachments(first: 10) { nodes { title url } } comments(first: $commentsFirst, after: $commentsAfter) { nodes { id body createdAt editedAt resolvedAt user { name displayName } parent { id } } pageInfo { hasNextPage endCursor } } } }";

export const LIST_PROJECTS_DOCUMENT =
  "query LinearListProjects($filter: ProjectFilter, $first: Int!, $after: String, $includeArchived: Boolean) { projects(filter: $filter, first: $first, after: $after, orderBy: updatedAt, includeArchived: $includeArchived) { nodes { id name status { name type } lead { name displayName } startDate targetDate progress health updatedAt url teams(first: 5) { nodes { key } } } pageInfo { hasNextPage endCursor } } }";

export const GET_PROJECT_DOCUMENT =
  "query LinearGetProject($id: String!, $issuesFirst: Int!) { project(id: $id) { id name description content status { name type } health progress startDate targetDate url slugId updatedAt lead { name displayName } members(first: 20) { nodes { name displayName } } teams(first: 10) { nodes { key name } } projectMilestones(first: 20) { nodes { name targetDate status progress } } projectUpdates(first: 3) { nodes { body health createdAt url user { name displayName } } } issues(first: $issuesFirst) { nodes { identifier title state { name } assignee { name displayName } } pageInfo { hasNextPage endCursor } } } }";

export const LIST_TEAMS_DOCUMENT =
  "query LinearListTeams($first: Int!, $after: String, $includeArchived: Boolean) { teams(first: $first, after: $after, includeArchived: $includeArchived) { nodes { key name description visibility issueCount archivedAt activeCycle { number name endsAt } } pageInfo { hasNextPage endCursor } } }";

/** Every fixed read document, so a test can run the operation check over all of them. */
export const READ_DOCUMENTS: readonly string[] = [
  STATUS_DOCUMENT,
  SEARCH_DOCUMENT,
  LIST_ISSUES_DOCUMENT,
  GET_ISSUE_DOCUMENT,
  LIST_PROJECTS_DOCUMENT,
  GET_PROJECT_DOCUMENT,
  LIST_TEAMS_DOCUMENT,
];

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** The id part of an issue reference: an identifier, a UUID, or an issue URL. */
export function issueRef(raw: string): string {
  const text = raw.trim();
  const at = text.indexOf("/issue/");
  if (at === -1) return text;
  return text.slice(at + "/issue/".length).split(/[/?#]/)[0] ?? text;
}

/** The id part of a project reference: a UUID, a slug, or a project URL. */
function projectRef(raw: string): string {
  const text = raw.trim();
  const at = text.indexOf("/project/");
  if (at === -1) return text;
  return text.slice(at + "/project/".length).split(/[/?#]/)[0] ?? text;
}

/** A filter that matches a team by key or by name, ignoring case. */
export function teamFilter(team: string): Record<string, unknown> {
  return { or: [{ key: { eqIgnoreCase: team } }, { name: { eqIgnoreCase: team } }] };
}

/** Turn `updated_since` into an absolute ISO time, because the filter page documents no past durations. */
export function sinceIso(value: string, now: number): string {
  const days = /^(\d+)d$/.exec(value.trim());
  if (days !== null) return new Date(now - Number(days[1]) * 86_400_000).toISOString();
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw new LinearError("updated_since must be a date such as 2026-11-01, or a count of days such as 7d.");
  }
  return new Date(parsed).toISOString();
}

interface SearchArgs {
  readonly text?: string;
  readonly team?: string;
  readonly assignee?: string;
  readonly state?: string;
  readonly project?: string;
  readonly label?: string;
  readonly priority?: number;
  readonly updated_since?: string;
  readonly include_comments?: boolean;
  readonly include_archived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

/** The IssueFilter for the filter arguments of a search. */
export function issueFilter(args: SearchArgs, now: number): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (args.team) filter.team = teamFilter(args.team);
  if (args.assignee) {
    const who = args.assignee.trim();
    if (who.toLowerCase() === "me") filter.assignee = { isMe: { eq: true } };
    else if (who.toLowerCase() === "none") filter.assignee = { null: true };
    else {
      filter.assignee = {
        or: [{ name: { containsIgnoreCase: who } }, { displayName: { containsIgnoreCase: who } }, { email: { containsIgnoreCase: who } }],
      };
    }
  }
  if (args.state) {
    const state = args.state.trim();
    filter.state = STATE_TYPES.has(state.toLowerCase()) ? { type: { eq: state.toLowerCase() } } : { name: { eqIgnoreCase: state } };
  }
  if (args.project) filter.project = { name: { containsIgnoreCase: args.project } };
  if (args.label) filter.labels = { some: { name: { eqIgnoreCase: args.label } } };
  if (args.priority !== undefined) filter.priority = { eq: args.priority };
  if (args.updated_since) filter.updatedAt = { gte: sinceIso(args.updated_since, now) };
  return filter;
}

function textOrDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "-" : value;
}

/** Print the lines of a document-sized answer: the data notice, the lines, and the cursor. */
function finish(head: readonly string[], items: readonly string[], page: Parameters<typeof cursorLine>[0], tail: readonly string[] = []): string {
  const { text, left } = joinWithinLimit(items);
  return [...head, text, ...cursorLine(page, left), ...tail].filter((line) => line !== "").join("\n");
}

export function createReadTools(env: LinearEnv): ToolRegistration[] {
  const { context, deps } = env;
  const zone = (): string => context.getConfig().timezone;

  const status = defineTool({
    name: "linear_status",
    description: DESCRIPTION_STATUS,
    parameters: obj({}),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async () =>
      env.run(async (client) => {
        const result = requireData(await client.request("linear_status", STATUS_DOCUMENT, {}, READ));
        const { viewer, organization } = result.data as {
          viewer: { id: string; name: string; displayName: string; email: string; admin: boolean; guest: boolean };
          organization: { name: string; urlKey: string };
        };
        const rate = client.lastRate;
        const role = viewer.admin ? "admin" : viewer.guest ? "guest" : "member";
        return [
          `Linear user: ${person(viewer)} (${viewer.email}), ${role}.`,
          `Workspace: ${organization.name} (${organization.urlKey}).`,
          `Requests left this hour: ${String(rate.requestsRemaining ?? "unknown")}. Complexity points left this hour: ${String(rate.complexityRemaining ?? "unknown")}.`,
          "The key's permissions cannot be read through the API. The user checks them in Linear at Settings > Account > Security & Access.",
          ...errorLines(result),
        ].join("\n");
      }),
  });

  const search = defineTool({
    name: "linear_search_issues",
    description: DESCRIPTION_SEARCH_ISSUES,
    parameters: obj({
      text: opt(str()),
      team: opt(str()),
      assignee: opt(str()),
      state: opt(str()),
      project: opt(str()),
      label: opt(str()),
      priority: opt(int({ minimum: 0, maximum: 4 })),
      updated_since: opt(str()),
      include_comments: opt(bool()),
      include_archived: opt(bool()),
      limit: opt(int({ minimum: 1, maximum: 50 })),
      cursor: opt(str()),
    }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: SearchArgs) =>
      env.run(async (client) => {
        const text = args.text?.trim() ?? "";
        const filter = issueFilter(args, deps.now());
        if (text === "" && Object.keys(filter).length === 0) {
          throw new LinearError(
            "Give text or at least one filter (team, assignee, state, project, label, priority, updated_since). Nothing was sent to Linear.",
          );
        }
        const first = clamp(args.limit, 25, 50);
        const variables: Record<string, unknown> = {
          filter: Object.keys(filter).length === 0 ? null : filter,
          first,
          after: args.cursor ?? null,
          includeArchived: args.include_archived === true,
        };
        let result;
        if (text !== "") {
          // Linear limits this query to 30 per minute, so calls keep two seconds apart.
          await env.pace();
          result = requireData(
            await client.request("linear_search_issues", SEARCH_DOCUMENT, { ...variables, term: text, includeComments: args.include_comments === true }, READ),
          );
        } else {
          result = requireData(await client.request("linear_search_issues", LIST_ISSUES_DOCUMENT, variables, READ));
        }
        const connection = (result.data.searchIssues ?? result.data.issues) as {
          nodes: Parameters<typeof issueLine>[0][];
          pageInfo: Parameters<typeof cursorLine>[0];
        };
        const nodes = connection.nodes;
        const head = [DATA_NOTICE, nodes.length === 0 ? "No issues matched." : `${String(nodes.length)} issue(s):`];
        return finish(head, nodes.map((node) => issueLine(node, zone())), connection.pageInfo, errorLines(result));
      }),
  });

  const getIssue = defineTool({
    name: "linear_get_issue",
    description: DESCRIPTION_GET_ISSUE,
    parameters: obj({
      id: str(),
      comments_limit: opt(int({ minimum: 1, maximum: 100 })),
      comments_cursor: opt(str()),
    }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: { id: string; comments_limit?: number; comments_cursor?: string }) =>
      env.run(async (client) => {
        const id = issueRef(args.id);
        const result = await client.request(
          "linear_get_issue",
          GET_ISSUE_DOCUMENT,
          { id, commentsFirst: clamp(args.comments_limit, 50, 100), commentsAfter: args.comments_cursor ?? null },
          READ,
        );
        if (isNotFound(result, "issue")) throw new LinearError(`No issue ${id} visible to this key.`);
        requireData(result);
        return formatIssue(result.data.issue, zone(), result);
      }),
  });

  const listProjects = defineTool({
    name: "linear_list_projects",
    description: DESCRIPTION_LIST_PROJECTS,
    parameters: obj({
      name: opt(str()),
      team: opt(str()),
      status: opt(str()),
      include_archived: opt(bool()),
      limit: opt(int({ minimum: 1, maximum: 50 })),
      cursor: opt(str()),
    }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: { name?: string; team?: string; status?: string; include_archived?: boolean; limit?: number; cursor?: string }) =>
      env.run(async (client) => {
        const filter: Record<string, unknown> = {};
        if (args.name) filter.name = { containsIgnoreCase: args.name };
        if (args.team) filter.accessibleTeams = { some: teamFilter(args.team) };
        if (args.status) {
          const wanted = args.status.trim().toLowerCase();
          if (!PROJECT_STATUSES.has(wanted)) {
            throw new LinearError("status must be one of backlog, planned, started, paused, completed, canceled.");
          }
          filter.status = { type: { eq: wanted } };
        }
        const result = requireData(
          await client.request(
            "linear_list_projects",
            LIST_PROJECTS_DOCUMENT,
            {
              filter: Object.keys(filter).length === 0 ? null : filter,
              first: clamp(args.limit, 25, 50),
              after: args.cursor ?? null,
              includeArchived: args.include_archived === true,
            },
            READ,
          ),
        );
        const connection = result.data.projects as { nodes: ProjectNode[]; pageInfo: Parameters<typeof cursorLine>[0] };
        const lines = connection.nodes.map((project) => {
          const teams = (project.teams?.nodes ?? []).map((team) => team.key).join(",");
          const dates = `${textOrDash(project.startDate)} to ${textOrDash(project.targetDate)}`;
          const progress = typeof project.progress === "number" ? `${String(Math.round(project.progress * 100))}%` : "-";
          return `${project.name}  [${project.status?.name ?? "-"}]  lead ${person(project.lead)}  ${dates}  ${progress}  health ${textOrDash(project.health)}  teams ${teams || "-"}  ${project.url ?? ""}  id ${project.id}`;
        });
        const head = [DATA_NOTICE, connection.nodes.length === 0 ? "No projects matched." : `${String(connection.nodes.length)} project(s):`];
        return finish(head, lines, connection.pageInfo, errorLines(result));
      }),
  });

  const getProject = defineTool({
    name: "linear_get_project",
    description: DESCRIPTION_GET_PROJECT,
    parameters: obj({ id: str(), issues_limit: opt(int({ minimum: 1, maximum: 100 })) }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: { id: string; issues_limit?: number }) =>
      env.run(async (client) => {
        const issuesFirst = clamp(args.issues_limit, 50, 100);
        let id = projectRef(args.id);
        let result = await client.request("linear_get_project", GET_PROJECT_DOCUMENT, { id, issuesFirst }, READ);
        if (isNotFound(result, "project") && /-/.test(id)) {
          // A slug may be `<name>-<code>`, and Linear may accept only the code.
          id = id.slice(id.lastIndexOf("-") + 1);
          result = await client.request("linear_get_project", GET_PROJECT_DOCUMENT, { id, issuesFirst }, READ);
        }
        if (isNotFound(result, "project")) throw new LinearError(`No project ${projectRef(args.id)} visible to this key.`);
        requireData(result);
        return formatProject(result.data.project, zone(), result);
      }),
  });

  const listTeams = defineTool({
    name: "linear_list_teams",
    description: DESCRIPTION_LIST_TEAMS,
    parameters: obj({ include_archived: opt(bool()) }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: { include_archived?: boolean }) =>
      env.run(async (client) => {
        const result = requireData(
          await client.request(
            "linear_list_teams",
            LIST_TEAMS_DOCUMENT,
            { first: 100, after: null, includeArchived: args.include_archived === true },
            READ,
          ),
        );
        const connection = result.data.teams as {
          nodes: {
            key: string;
            name: string;
            description?: string | null;
            visibility?: string | null;
            issueCount?: number | null;
            archivedAt?: string | null;
            activeCycle?: { number?: number | null; name?: string | null; endsAt?: string | null } | null;
          }[];
          pageInfo: Parameters<typeof cursorLine>[0];
        };
        const lines = connection.nodes.map((team) => {
          const cycle = team.activeCycle
            ? `cycle ${String(team.activeCycle.number ?? "-")}${team.activeCycle.name ? ` ${team.activeCycle.name}` : ""} until ${when(team.activeCycle.endsAt, zone())}`
            : "no active cycle";
          const archived = team.archivedAt ? "  (archived)" : "";
          return `${team.key}  ${team.name}  ${textOrDash(team.visibility)}  ${String(team.issueCount ?? "-")} issues  ${cycle}${archived}${team.description ? `\n    ${cut(team.description, 300)}` : ""}`;
        });
        const head = [DATA_NOTICE, `${String(connection.nodes.length)} team(s):`];
        return finish(head, lines, connection.pageInfo, errorLines(result));
      }),
  });

  const graphql = defineTool({
    name: "linear_graphql",
    description: DESCRIPTION_GRAPHQL,
    parameters: obj({ query: str({ maxLength: 20_000 }), variables: opt(unknown()) }),
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: { query: string; variables?: unknown }) =>
      env.run(async (client) => {
        let variables: Record<string, unknown> = {};
        if (args.variables !== undefined && args.variables !== null) {
          let value = args.variables;
          if (typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {
              throw new LinearError("variables must be a JSON object. Nothing was sent to Linear.");
            }
          }
          if (value === null || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 20_000) {
            throw new LinearError("variables must be a JSON object of at most 20,000 characters. Nothing was sent to Linear.");
          }
          variables = value as Record<string, unknown>;
        }
        const result = await client.request("linear_graphql", args.query, variables, READ);
        const text = JSON.stringify(
          result.errors.length > 0 ? { errors: result.errors.map(describeError), data: result.data } : { data: result.data },
          null,
          2,
        );
        return `${DATA_NOTICE}\n${cut(text, ANSWER_LIMIT)}`;
      }),
  });

  return [status, search, getIssue, listProjects, getProject, listTeams, graphql] as unknown as ToolRegistration[];
}

interface ProjectNode {
  readonly id: string;
  readonly name: string;
  readonly status?: { readonly name?: string | null } | null;
  readonly lead?: { readonly name?: string | null; readonly displayName?: string | null } | null;
  readonly startDate?: string | null;
  readonly targetDate?: string | null;
  readonly progress?: number | null;
  readonly health?: string | null;
  readonly url?: string | null;
  readonly teams?: { readonly nodes?: readonly { readonly key: string }[] } | null;
}

interface IssueDetail {
  identifier: string;
  title: string;
  url: string;
  priorityLabel?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  description?: string | null;
  state?: { name: string; type?: string } | null;
  assignee?: { name?: string | null; displayName?: string | null } | null;
  creator?: { name?: string | null; displayName?: string | null } | null;
  team?: { key: string; name: string } | null;
  project?: { name: string } | null;
  cycle?: { number?: number | null; name?: string | null } | null;
  parent?: { identifier: string; title: string } | null;
  labels?: { nodes: { name: string }[] } | null;
  children?: { nodes: { identifier: string; title: string; state?: { name: string } | null }[] } | null;
  relations?: { nodes: { type: string; relatedIssue: { identifier: string; title: string } }[] } | null;
  attachments?: { nodes: { title: string; url: string }[] } | null;
  comments?: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      editedAt?: string | null;
      resolvedAt?: string | null;
      user?: { name?: string | null; displayName?: string | null } | null;
      parent?: { id: string } | null;
    }[];
    pageInfo?: Parameters<typeof cursorLine>[0];
  } | null;
}

function formatIssue(issue: IssueDetail, zone: string, result: Parameters<typeof errorLines>[0]): string {
  const lines: string[] = [DATA_NOTICE];
  lines.push(`${issue.identifier}  ${issue.title}`);
  lines.push(`URL: ${issue.url}`);
  lines.push(
    `State: ${issue.state?.name ?? "-"} (${issue.state?.type ?? "-"})  Priority: ${textOrDash(issue.priorityLabel)}  Assignee: ${person(issue.assignee, "unassigned")}  Creator: ${person(issue.creator)}`,
  );
  lines.push(
    `Team: ${issue.team?.key ?? "-"}  Project: ${issue.project?.name ?? "-"}  Cycle: ${issue.cycle ? `${String(issue.cycle.number ?? "-")} ${issue.cycle.name ?? ""}`.trim() : "-"}  Parent: ${issue.parent ? `${issue.parent.identifier} ${issue.parent.title}` : "-"}`,
  );
  lines.push(
    `Labels: ${(issue.labels?.nodes ?? []).map((l) => l.name).join(", ") || "-"}  Due: ${textOrDash(issue.dueDate)}  Estimate: ${issue.estimate ?? "-"}`,
  );
  lines.push(
    `Created: ${when(issue.createdAt, zone)}  Updated: ${when(issue.updatedAt, zone)}  Completed: ${when(issue.completedAt, zone)}  Canceled: ${when(issue.canceledAt, zone)}`,
  );
  lines.push("", "Description:", cut(issue.description, ISSUE_TEXT_LIMIT) || "(none)");
  const children = issue.children?.nodes ?? [];
  if (children.length > 0) {
    lines.push("", "Sub-issues:", ...children.map((c) => `  ${c.identifier}  [${c.state?.name ?? "-"}]  ${c.title}`));
  }
  const relations = issue.relations?.nodes ?? [];
  if (relations.length > 0) {
    lines.push("", "Relations:", ...relations.map((r) => `  ${r.type} ${r.relatedIssue.identifier}  ${r.relatedIssue.title}`));
  }
  const attachments = issue.attachments?.nodes ?? [];
  if (attachments.length > 0) {
    lines.push("", "Links:", ...attachments.map((a) => `  ${a.title}  ${a.url}`));
  }
  const comments = [...(issue.comments?.nodes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  lines.push("", `Comments (${String(comments.length)} on this page, oldest first):`);
  const ids = new Set(comments.map((c) => c.id));
  const rendered = comments.map((c) => {
    const nested = c.parent?.id !== undefined && ids.has(c.parent.id);
    const pad = nested ? "      " : "  ";
    const flags = `${c.editedAt ? ", edited" : ""}${c.resolvedAt ? ", resolved" : ""}`;
    const reply = c.parent?.id ? `, reply to ${c.parent.id}` : "";
    const head = `${pad}${nested ? "> " : ""}[${c.id}] ${person(c.user, "unknown")}, ${when(c.createdAt, zone)}${flags}${reply}`;
    const body = cut(c.body, COMMENT_TEXT_LIMIT)
      .split("\n")
      .map((line) => `${pad}  ${line}`)
      .join("\n");
    return `${head}\n${body}`;
  });
  const { text, left } = joinWithinLimit(rendered, Math.max(2_000, ANSWER_LIMIT - lines.join("\n").length));
  lines.push(text || "  (none)", ...cursorLine(issue.comments?.pageInfo, left), ...errorLines(result));
  return lines.join("\n");
}

interface ProjectDetail extends ProjectNode {
  description?: string | null;
  content?: string | null;
  slugId?: string | null;
  updatedAt?: string | null;
  members?: { nodes: { name?: string | null; displayName?: string | null }[] } | null;
  teams?: { nodes: { key: string; name?: string }[] } | null;
  projectMilestones?: { nodes: { name: string; targetDate?: string | null; status?: string | null; progress?: number | null }[] } | null;
  projectUpdates?: {
    nodes: { body: string; health?: string | null; createdAt: string; url?: string | null; user?: { name?: string | null; displayName?: string | null } | null }[];
  } | null;
  issues?: {
    nodes: { identifier: string; title: string; state?: { name: string } | null; assignee?: { name?: string | null; displayName?: string | null } | null }[];
    pageInfo?: Parameters<typeof cursorLine>[0];
  } | null;
}

function formatProject(project: ProjectDetail, zone: string, result: Parameters<typeof errorLines>[0]): string {
  const lines: string[] = [DATA_NOTICE];
  lines.push(project.name, `URL: ${textOrDash(project.url)}  id ${project.id}  slug ${textOrDash(project.slugId)}`);
  const progress = typeof project.progress === "number" ? `${String(Math.round(project.progress * 100))}%` : "-";
  lines.push(
    `Status: ${project.status?.name ?? "-"}  Lead: ${person(project.lead)}  Progress: ${progress}  Health: ${textOrDash(project.health)}`,
    `Start: ${textOrDash(project.startDate)}  Target: ${textOrDash(project.targetDate)}  Updated: ${when(project.updatedAt, zone)}`,
    `Teams: ${(project.teams?.nodes ?? []).map((t) => t.key).join(", ") || "-"}`,
    `Members: ${(project.members?.nodes ?? []).map((m) => person(m)).join(", ") || "-"}`,
  );
  if (project.description) lines.push("", "Summary:", cut(project.description, COMMENT_TEXT_LIMIT));
  lines.push("", "Content:", cut(project.content, ISSUE_TEXT_LIMIT) || "(none)");
  const milestones = project.projectMilestones?.nodes ?? [];
  if (milestones.length > 0) {
    lines.push(
      "",
      "Milestones:",
      ...milestones.map(
        (m) => `  ${m.name}  [${textOrDash(m.status)}]  target ${textOrDash(m.targetDate)}  ${typeof m.progress === "number" ? `${String(Math.round(m.progress * 100))}%` : "-"}`,
      ),
    );
  }
  const updates = project.projectUpdates?.nodes ?? [];
  if (updates.length > 0) {
    lines.push("", "Latest updates:");
    for (const update of updates) {
      lines.push(`  ${when(update.createdAt, zone)}  ${person(update.user)}  health ${textOrDash(update.health)}`);
      lines.push(...cut(update.body, COMMENT_TEXT_LIMIT).split("\n").map((line) => `    ${line}`));
    }
  }
  const issues = project.issues?.nodes ?? [];
  lines.push("", `Issues (${String(issues.length)} shown):`);
  const rendered = issues.map(
    (i) => `  ${i.identifier}  [${i.state?.name ?? "-"}]  ${i.assignee ? `@${person(i.assignee)}` : "unassigned"}  ${i.title}`,
  );
  const { text, left } = joinWithinLimit(rendered, Math.max(2_000, ANSWER_LIMIT - lines.join("\n").length));
  const more =
    left > 0 || project.issues?.pageInfo?.hasNextPage === true
      ? ["The project has more issues than shown. Raise issues_limit (at most 100), or use linear_search_issues with the project filter."]
      : [];
  lines.push(text || "  (none)", ...more, ...errorLines(result));
  return lines.join("\n");
}
