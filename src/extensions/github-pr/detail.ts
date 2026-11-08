import { GhError, type GhReader } from "./gh.ts";
import { PR_DETAIL_QUERY, PR_REFS_QUERY } from "./queries.ts";

/**
 * One pull request, shaped as the browser's page expects it.
 *
 * The GraphQL answer nests everything three levels deep and repeats the reaction
 * groups on every comment. The page wants a flat shape: a list of reaction
 * entries with a count and whether the viewer reacted, a comment list, a review
 * list, and review threads with the first comment's `diffHunk` lifted onto the
 * thread. This module is that translation and nothing else.
 *
 * Field names are fixed, with one addition: `repo` (the configured `owner/repo`) is
 * added by the caller, and there is no `remote` field.
 */

interface RawAuthor {
  readonly login?: string | null;
}

interface RawReactionGroup {
  readonly content: string;
  readonly viewerHasReacted?: boolean;
  readonly reactors?: { readonly totalCount?: number } | null;
}

interface RawComment {
  readonly id?: string;
  readonly author?: RawAuthor | null;
  readonly body?: string | null;
  readonly createdAt?: string;
  readonly url?: string | null;
  readonly diffHunk?: string | null;
  readonly path?: string | null;
  readonly state?: string;
  readonly viewerCanUpdate?: boolean;
  readonly viewerDidAuthor?: boolean;
  readonly reactionGroups?: readonly RawReactionGroup[] | null;
}

interface RawThread {
  readonly id?: string;
  readonly isResolved?: boolean;
  readonly viewerCanResolve?: boolean;
  readonly isOutdated?: boolean;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly startLine?: number | null;
  readonly originalLine?: number | null;
  readonly originalStartLine?: number | null;
  readonly diffSide?: string | null;
  readonly subjectType?: string | null;
  readonly comments?: { readonly nodes?: readonly RawComment[] | null } | null;
}

interface RawCheckContext {
  readonly __typename?: string;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly detailsUrl?: string;
  readonly context?: string;
  readonly state?: string;
  readonly targetUrl?: string;
}

interface RawDetail {
  readonly id?: string;
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly url?: string;
  readonly state?: string;
  readonly isDraft?: boolean;
  readonly createdAt?: string;
  readonly author?: RawAuthor | null;
  readonly viewerCanUpdate?: boolean;
  readonly viewerDidAuthor?: boolean;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly baseRefName?: string;
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly labels?: { readonly nodes?: readonly { readonly name: string; readonly color: string }[] | null } | null;
  readonly reactionGroups?: readonly RawReactionGroup[] | null;
  readonly comments?: { readonly nodes?: readonly RawComment[] | null } | null;
  readonly reviews?: { readonly nodes?: readonly RawComment[] | null } | null;
  readonly reviewThreads?: { readonly nodes?: readonly RawThread[] | null } | null;
  readonly commitList?: {
    readonly totalCount?: number;
    readonly nodes?: readonly {
      readonly commit?: {
        readonly oid?: string;
        readonly abbreviatedOid?: string;
        readonly messageHeadline?: string;
        readonly committedDate?: string;
        readonly authoredDate?: string;
        readonly url?: string;
        readonly author?: { readonly name?: string | null; readonly user?: { readonly login?: string } | null } | null;
      };
    }[] | null;
  } | null;
  readonly commits?: {
    readonly nodes?: readonly {
      readonly commit?: {
        readonly oid?: string;
        readonly statusCheckRollup?: {
          readonly state?: string;
          readonly contexts?: { readonly nodes?: readonly RawCheckContext[] | null } | null;
        } | null;
      };
    }[] | null;
  } | null;
}

/** One reaction with its count. Groups nobody used are dropped. */
export interface PrReaction {
  readonly content: string;
  readonly count: number;
  readonly mine: boolean;
}

export interface PrComment {
  readonly id: string;
  readonly author: string | null;
  readonly body: string | null;
  readonly createdAt: string;
  readonly url: string | null;
  /** Whether GitHub lets this account edit the comment. */
  readonly viewerCanUpdate: boolean;
  /** Whether this account wrote the comment. */
  readonly viewerDidAuthor: boolean;
  readonly reactions: readonly PrReaction[];
}

export interface PrReview extends PrComment {
  readonly reviewState: string | null;
}

export interface PrThread {
  readonly id: string;
  readonly isResolved: boolean;
  /** Whether GitHub lets this account resolve the thread. */
  readonly viewerCanResolve: boolean;
  readonly isOutdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly diffSide: string | null;
  /** `FILE` for a comment on a whole file, `LINE` for anything else. */
  readonly subjectType: "LINE" | "FILE";
  readonly diffHunk: string | null;
  readonly comments: readonly PrComment[];
}

export interface PrCheck {
  readonly name: string;
  readonly status: string;
  readonly url: string | null;
}

/** One commit of the pull request, as the Commits panel shows it. */
export interface PrCommit {
  readonly oid: string;
  readonly abbreviatedOid: string;
  readonly headline: string;
  /** The account login when GitHub links one, else the git author name. */
  readonly author: string | null;
  readonly committedDate: string;
  readonly url: string;
}

/** The detail payload. `repo` is added by the caller. */
export interface PrDetail {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly author: string | null;
  /** Whether GitHub lets this account edit the description. */
  readonly viewerCanUpdate: boolean;
  /** Whether this account wrote the pull request. */
  readonly viewerDidAuthor: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly labels: readonly { readonly name: string; readonly color: string }[];
  readonly reactions: readonly PrReaction[];
  readonly comments: readonly PrComment[];
  readonly reviews: readonly PrReview[];
  readonly threads: readonly PrThread[];
  readonly ciState: string | null;
  readonly checks: readonly PrCheck[];
  /** The newest commits, oldest first. */
  readonly commits: readonly PrCommit[];
  /** How many commits the pull request has, which can pass `commits.length`. */
  readonly totalCommits: number;
}

/** Reactions of one subject: the groups with a count above zero, in GitHub's order. */
export function shapeReactions(groups: readonly RawReactionGroup[] | null | undefined): PrReaction[] {
  const shaped: PrReaction[] = [];
  for (const group of groups ?? []) {
    const count = group.reactors?.totalCount ?? 0;
    if (count === 0) continue;
    shaped.push({ content: group.content, count, mine: group.viewerHasReacted === true });
  }
  return shaped;
}

/** One comment. The `id` of a comment is what a reaction write names. */
export function shapeComment(comment: RawComment): PrComment {
  return {
    id: comment.id ?? "",
    author: comment.author?.login ?? null,
    body: comment.body ?? null,
    createdAt: comment.createdAt ?? "",
    url: comment.url ?? null,
    viewerCanUpdate: comment.viewerCanUpdate === true,
    viewerDidAuthor: comment.viewerDidAuthor === true,
    reactions: shapeReactions(comment.reactionGroups),
  };
}

/**
 * The CI state and the list of checks of the head commit.
 *
 * A check run reports a conclusion once it finished and a status before that, so
 * the one field the page shows is the conclusion when there is one and the status
 * otherwise. A status context (an older style, still common) reports a state.
 */
function shapeChecks(detail: RawDetail): { ciState: string | null; checks: PrCheck[] } {
  const rollup = detail.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (rollup === null || rollup === undefined) return { ciState: null, checks: [] };
  const checks: PrCheck[] = [];
  for (const context of rollup.contexts?.nodes ?? []) {
    if (context.__typename === "CheckRun") {
      checks.push({
        name: context.name ?? "",
        // The original showed the conclusion once there was one and the status
        // before that; an empty conclusion string counts as none.
        status: context.conclusion || context.status || "",
        url: context.detailsUrl ?? null,
      });
    } else {
      checks.push({
        name: context.context ?? "",
        status: context.state ?? "",
        url: context.targetUrl ?? null,
      });
    }
  }
  return { ciState: rollup.state ?? null, checks };
}

/** Translate one raw pull request into the payload the page reads. */
export function shapeDetail(detail: RawDetail): PrDetail {
  const { ciState, checks } = shapeChecks(detail);
  return {
    id: detail.id ?? "",
    number: detail.number ?? 0,
    title: detail.title ?? "",
    body: detail.body ?? null,
    url: detail.url ?? "",
    state: detail.state ?? "",
    isDraft: detail.isDraft === true,
    createdAt: detail.createdAt ?? "",
    author: detail.author?.login ?? null,
    viewerCanUpdate: detail.viewerCanUpdate === true,
    viewerDidAuthor: detail.viewerDidAuthor === true,
    additions: detail.additions ?? 0,
    deletions: detail.deletions ?? 0,
    changedFiles: detail.changedFiles ?? 0,
    baseRefName: detail.baseRefName ?? "",
    headRefName: detail.headRefName ?? "",
    headRefOid: detail.headRefOid ?? "",
    labels: detail.labels?.nodes ?? [],
    reactions: shapeReactions(detail.reactionGroups),
    comments: (detail.comments?.nodes ?? []).map(shapeComment),
    reviews: (detail.reviews?.nodes ?? []).map((review) => ({
      ...shapeComment(review),
      reviewState: review.state ?? null,
    })),
    threads: (detail.reviewThreads?.nodes ?? []).map((thread) => {
      const comments = thread.comments?.nodes ?? [];
      return {
        id: thread.id ?? "",
        isResolved: thread.isResolved === true,
        viewerCanResolve: thread.viewerCanResolve === true,
        isOutdated: thread.isOutdated === true,
        path: thread.path ?? null,
        line: thread.line ?? null,
        startLine: thread.startLine ?? null,
        originalLine: thread.originalLine ?? null,
        originalStartLine: thread.originalStartLine ?? null,
        diffSide: thread.diffSide ?? null,
        subjectType: thread.subjectType === "FILE" ? ("FILE" as const) : ("LINE" as const),
        // Every comment of a thread carries the same hunk, so the first one is
        // lifted onto the thread and the page draws it once.
        diffHunk: comments[0]?.diffHunk ?? null,
        comments: comments.map(shapeComment),
      };
    }),
    ciState,
    checks,
    commits: (detail.commitList?.nodes ?? []).map((node) => ({
      oid: node.commit?.oid ?? "",
      abbreviatedOid: node.commit?.abbreviatedOid ?? "",
      headline: node.commit?.messageHeadline ?? "",
      author: node.commit?.author?.user?.login ?? node.commit?.author?.name ?? null,
      committedDate: node.commit?.committedDate ?? node.commit?.authoredDate ?? "",
      url: node.commit?.url ?? "",
    })),
    totalCommits: detail.commitList?.totalCount ?? 0,
  };
}

/**
 * Read one pull request.
 *
 * A number that does not exist is a `GhError` with the original's wording, which
 * the route turns into a message; a repository the account cannot read fails
 * inside `gh` and arrives here as the same kind of error.
 */
export async function fetchPrDetail(
  reader: GhReader,
  repository: { readonly owner: string; readonly name: string },
  number: number,
): Promise<PrDetail> {
  const data = await reader.graphql<{ repository?: { pullRequest?: RawDetail | null } | null }>(PR_DETAIL_QUERY, {
    owner: repository.owner,
    name: repository.name,
    number,
  });
  const pr = data.repository?.pullRequest;
  if (pr === null || pr === undefined) {
    throw new GhError(`PR #${number} not found`);
  }
  return shapeDetail(pr);
}

/** The few fields the diff view needs, read without the whole detail. */
export interface PrRefs {
  /** The GraphQL node id, which a comment names. */
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
}

/**
 * Read one pull request's refs and title.
 *
 * The diff does not come from GitHub: it comes from the local bare repository,
 * and all it needs from GitHub is the base branch name, the head commit and the
 * title the page shows. This query is a tenth of the detail query's cost, which is
 * why the diff page asks for it instead.
 */
export async function fetchPrRefs(
  reader: GhReader,
  repository: { readonly owner: string; readonly name: string },
  number: number,
): Promise<PrRefs> {
  const data = await reader.graphql<{
    repository?: {
      pullRequest?: {
        id?: string;
        number?: number;
        title?: string;
        baseRefName?: string;
        headRefName?: string;
        headRefOid?: string;
      } | null;
    } | null;
  }>(PR_REFS_QUERY, { owner: repository.owner, name: repository.name, number });
  const pr = data.repository?.pullRequest;
  if (pr === null || pr === undefined) {
    throw new GhError(`PR #${number} not found`);
  }
  return {
    id: pr.id ?? "",
    number: pr.number ?? number,
    title: pr.title ?? "",
    baseRefName: pr.baseRefName ?? "",
    headRefName: pr.headRefName ?? "",
    headRefOid: pr.headRefOid ?? "",
  };
}
