/**
 * The GraphQL text, the one REST path, and the read limits the dashboard sends
 * to GitHub.
 *
 * The GraphQL text is fixed, with two changes that
 * the code needs and nothing else: no `remote` field (the port names a
 * repository by `repo`), and the limits sit here as named constants so that a
 * test can check them without reading the text.
 *
 * The text is data, not code: nothing here parses it, and a caller may wrap it as
 * it likes. The one rule that matters is the read/write split of `gh.ts`: every
 * query in this file reads, and the mutation texts live in `writes.ts`.
 *
 * One read is not GraphQL. A repository's fork relationship is read over REST,
 * because GitHub's GraphQL `Repository` type has no field for the repository a
 * fork came from (see {@link repoInfoEndpoint}).
 */

/**
 * How many of each thing one query asks for.
 *
 * The numbers come from the original and are kept as they were, because the
 * GraphQL cost of a query grows with them: a card of pull requests with 20 labels
 * and a rollup each, a detail with 100 comments and 100 threads of 100 comments,
 * and a search that returns at most 50 pull requests.
 */
const READ_LIMITS = {
  /** Labels on one pull request in a list row. */
  listLabels: 20,
  /** Labels on the pull request detail. */
  detailLabels: 30,
  /** Issue comments on the pull request detail. */
  detailComments: 100,
  /** Reviews on the pull request detail. */
  detailReviews: 50,
  /** Review threads on the pull request detail. */
  detailThreads: 100,
  /** Comments inside one review thread. */
  threadComments: 100,
  /** CI contexts (check runs and status contexts) of the head commit. */
  checkContexts: 100,
  /** Newest commits of the pull request detail's commit list. */
  detailCommits: 100,
  /** Results of one search, which is the page size of every list section. */
  search: 50,
  /** Comments and reviews the mention check reads per pull request. */
  mentionComments: 100,
  mentionReviews: 50,
  mentionThreads: 100,
} as const;

/** The fields of one pull request as a list row shows it. */
const PR_LIST_FIELDS = `
    number
    title
    url
    isDraft
    state
    updatedAt
    author { login }
    headRefName
    baseRefName
    reviewDecision
    labels(first: ${READ_LIMITS.listLabels}) { nodes { name color } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

/** The login of the account `gh` is authenticated as. One query, no repository. */
export const VIEWER_QUERY = `query { viewer { login } }`;

/**
 * One search: `$q` carries the repository and the qualifier, and the results are
 * pull requests (the search covers issues too, so the fragment narrows them).
 */
export const SEARCH_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: ${READ_LIMITS.search}) {
    nodes { ... on PullRequest { ${PR_LIST_FIELDS} } }
  }
}
`;

/**
 * One pull request as a list row shows it, open or not. The poll reads it for a
 * saved review whose pull request is not on the list, so the page can show its
 * title and state. The name is part of the text, so a test answers it by name.
 */
export const PENDING_PR_QUERY = `
query PendingReviewPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PR_LIST_FIELDS} }
  }
}
`;

/** The full pull request detail: body, comments, reviews, threads and CI. */
export const PR_DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      body
      url
      state
      isDraft
      createdAt
      author { login }
      viewerCanUpdate
      viewerDidAuthor
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      headRefOid
      labels(first: ${READ_LIMITS.detailLabels}) { nodes { name color } }
      reactionGroups { content viewerHasReacted reactors { totalCount } }
      comments(first: ${READ_LIMITS.detailComments}) {
        nodes { id author { login } body createdAt url viewerCanUpdate viewerDidAuthor reactionGroups { content viewerHasReacted reactors { totalCount } } }
      }
      reviews(first: ${READ_LIMITS.detailReviews}) {
        nodes { id author { login } body state createdAt url reactionGroups { content viewerHasReacted reactors { totalCount } } }
      }
      reviewThreads(first: ${READ_LIMITS.detailThreads}) {
        nodes {
          id
          isResolved
          viewerCanResolve
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          subjectType
          comments(first: ${READ_LIMITS.threadComments}) {
            nodes { id author { login } body createdAt url viewerCanUpdate viewerDidAuthor diffHunk path reactionGroups { content viewerHasReacted reactors { totalCount } } }
          }
        }
      }
      commitList: commits(last: ${READ_LIMITS.detailCommits}) {
        totalCount
        nodes { commit { oid abbreviatedOid messageHeadline committedDate authoredDate url author { name user { login } } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: ${READ_LIMITS.checkContexts}) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

/**
 * The few fields the diff view needs: the two ref names, the head commit and the
 * title. The diff itself comes from git, not from here.
 */
export const PR_REFS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title baseRefName headRefName headRefOid
    }
  }
}
`;

/**
 * The alias one pull request gets in a mention-detail query.
 *
 * The aliases are `p0`, `p1`, ... and the caller reads the answer by alias, so
 * the numbers a query asked about are the numbers that come back.
 */
export function mentionAlias(index: number): string {
  return `p${index}`;
}

/**
 * The mention check for a chunk of pull requests.
 *
 * Every comment, review body and thread reply of one pull request is read, in
 * time order, and the caller keeps the pull request only when a mention of the
 * viewer has no later word from the viewer in the same thread. Owner and name are
 * written into the query text rather than passed as variables, as the original
 * did, because the repository is a constant of the whole call.
 */
export function mentionDetailQuery(owner: string, name: string, numbers: readonly number[]): string {
  const fields = numbers
    .map(
      (number, index) => `${mentionAlias(index)}: pullRequest(number: ${number}) {
        number
        comments(last: ${READ_LIMITS.mentionComments}) { nodes { author { login } body createdAt } }
        reviews(last: ${READ_LIMITS.mentionReviews}) { nodes { author { login } body createdAt } }
        reviewThreads(first: ${READ_LIMITS.mentionThreads}) {
          nodes { comments(first: ${READ_LIMITS.threadComments}) { nodes { author { login } body createdAt } } }
        }
      }`,
    )
    .join("\n");
  return `query {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }
  }`;
}

/**
 * The REST path one repository's fork relationship and size are read from.
 *
 * The fork-network resolver of `network.ts` takes a reader, and `gh.ts` answers it
 * with this one REST call: `fork` and `source.full_name` decide which
 * repositories share one bare repository, and `size` (GitHub's size in
 * kilobytes) feeds the disk guard. It reads no pull request, so a resolve costs
 * one small call per configured repository.
 *
 * It is REST rather than GraphQL because GraphQL cannot answer the question that
 * matters here. `Repository` has an `isFork` field and a `parent` field, and
 * `parent` names the repository a fork was made from one step up, but it has no
 * field for the repository at the root of the fork network. A fork of a fork
 * would then land in a network of its own, and two configured forks of one
 * repository would each keep a copy of the same history. The REST answer names
 * `source`: the repository at the root of the network, whichever fork asked, and
 * in the same answer as `fork` and `size`. So one GET answers the whole
 * question, and `size` has the same meaning as the `diskUsage` the GraphQL
 * answer carried.
 */
export function repoInfoEndpoint(owner: string, repo: string): string {
  // The two parts are escaped: a name is a URL path segment here, and this
  // function must not let a configured name change the path it asks for.
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
