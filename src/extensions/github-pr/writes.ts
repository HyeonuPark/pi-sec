import type { AuditLog } from "../../runtime/audit.ts";
import { fetchPrRefs, type PrRefs } from "./detail.ts";
import { GhError, type GhReader, type GhWriter } from "./gh.ts";
import { splitRepository, type GithubPrSettings } from "./settings.ts";

/**
 * The six writes of the dashboard: a reply in a review thread, a comment on the
 * whole pull request, a reaction added or removed, a submitted review, the
 * resolve of a review thread, and the edit of the pull request description or of
 * one of the account's own comments.
 *
 * Two rules sit in front of every one of them.
 *
 *   1. The `writes` switch is read again on every call, from the config as it is
 *      now, never from a value held since boot. Off means this function rejects
 *      before anything is started, so a switched-off install sends nothing to
 *      `gh`. The HTTP route turns that rejection into `403`.
 *   2. Every write that reaches GitHub leaves one audit row: the repository, the
 *      pull request number and the kind of write. The body is never written down,
 *      because a comment is the operator's text and the audit trail is not the
 *      place for it.
 *
 * The mutations and the one REST call are the original's. The identifiers they
 * need (`subjectId`, the head commit) are read with the read half, never guessed.
 */

/**
 * The reaction names GitHub accepts, as a value rather than a free string, so an
 * invalid one is refused here instead of by a GraphQL error.
 */
export const REACTION_CONTENTS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const;

export type ReactionContent = (typeof REACTION_CONTENTS)[number];

/** The verdict a submitted review carries. */
export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;

export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** Which side of the diff a review comment is on. */
export type DiffSide = "LEFT" | "RIGHT";

/** One line comment of a review being submitted. */
export interface ReviewLineComment {
  readonly body: string;
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number;
  readonly startLine?: number | null;
}

/** What the route hands one write, after it checked the request body's shape. */
export interface WriteContext {
  /**
   * The settings as they are at the moment of the call.
   *
   * A function rather than a value on purpose: the route wires
   * `() => readSettings(deps.runtime.getConfig())` once, and every write then
   * reads the `writes` of the config that is loaded now, so a config reload
   * changes what this install may do without a restart and without a stale copy
   * of the old value lying around.
   */
  readonly settings: () => GithubPrSettings | undefined;
  /** The configured spelling, `owner/repo`. */
  readonly repo: string;
  /** The pull request number from the URL. */
  readonly number: number;
  /** Where a row goes. Absent in a test that only checks the refusal. */
  readonly audit?: AuditLog;
  /** The write half of `gh`. */
  readonly writer: GhWriter;
  /** The read half, for the identifiers a write needs. */
  readonly reader: GhReader;
}

/**
 * A write refused because this install may not write. The route answers `403`.
 *
 * It is deliberately not a `GhError`: a route that turns a `gh` failure into
 * `502` must check this one first, and a separate type is what makes that check
 * impossible to forget by accident.
 */
export class WritesDisabledError extends Error {
  constructor() {
    super("writes are disabled");
    this.name = "WritesDisabledError";
  }
}

/** A write whose input is wrong. The route answers `400`. */
export class WriteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteInputError";
  }
}

/** A write whose target changed on GitHub after the page read it. The route answers `409`. */
export class WriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteConflictError";
  }
}

/**
 * The most bytes of text one edit may carry.
 *
 * The write half of `gh.ts` sends every GraphQL variable as one command-line
 * argument, and Linux refuses one argument of 131072 bytes or more. The limit
 * leaves room for the `body=` prefix, and a longer text is refused here with a
 * clear message instead of failing inside `gh` with `E2BIG`.
 */
export const EDIT_TEXT_LIMIT_BYTES = 131_000;

const THREAD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: { pullRequestReviewThreadId: $threadId, body: $body }
  ) { comment { id } }
}
`;

const PR_COMMENT_MUTATION = `
mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id } }
  }
}
`;

const ADD_REACTION_MUTATION = `
mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) {
    reaction { id }
  }
}
`;

const REMOVE_REACTION_MUTATION = `
mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) {
    reaction { id }
  }
}
`;

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
`;

const THREAD_OWNER_QUERY = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      isResolved
      viewerCanResolve
      pullRequest { number repository { nameWithOwner } }
    }
  }
}
`;

const UPDATE_DESCRIPTION_MUTATION = `
mutation($pullRequestId: ID!, $body: String!) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, body: $body }) {
    pullRequest { id body }
  }
}
`;

const UPDATE_ISSUE_COMMENT_MUTATION = `
mutation($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) {
    issueComment { id body }
  }
}
`;

const UPDATE_REVIEW_COMMENT_MUTATION = `
mutation($commentId: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
    pullRequestReviewComment { id body }
  }
}
`;

const DESCRIPTION_READ_QUERY = `
query EditDescriptionRead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id body viewerCanUpdate viewerDidAuthor }
  }
}
`;

const COMMENT_READ_QUERY = `
query EditCommentRead($commentId: ID!) {
  node(id: $commentId) {
    __typename
    ... on IssueComment { body viewerCanUpdate viewerDidAuthor pullRequest { number repository { nameWithOwner } } }
    ... on PullRequestReviewComment { body viewerCanUpdate viewerDidAuthor pullRequest { number repository { nameWithOwner } } }
  }
}
`;

/**
 * Refuse a call when this install may not write, and record it when it may.
 *
 * The order is deliberate: the check comes first, so a switched-off install
 * neither writes nor leaves an audit row that says it did.
 */
function allowWrite(context: WriteContext): void {
  const settings = context.settings();
  if (settings === undefined || settings.writes !== true) {
    throw new WritesDisabledError();
  }
}

/** One audit row per write that reached GitHub. The body never appears. */
function recordWrite(context: WriteContext, kind: string, extra: Record<string, unknown> = {}): void {
  context.audit?.append({
    type: "github_pr_write",
    repo: context.repo,
    number: context.number,
    kind,
    ...extra,
  });
}

/**
 * The refs of the pull request, which carry the node id and the head commit.
 *
 * A write names a subject by node id, and a review names the commit it belongs to.
 * Neither is guessed: both come from the read half, and a pull request that does
 * not exist fails here before anything is written.
 */
function prRefs(context: WriteContext): Promise<PrRefs> {
  const { owner, name } = splitRepository(context.repo);
  return fetchPrRefs(context.reader, { owner, name }, context.number);
}

/** The node id of a pull request, which a comment and a reaction name. */
async function prNodeId(context: WriteContext): Promise<string> {
  const refs = await prRefs(context);
  if (refs.id === "") throw new GhError(`PR #${context.number} not found`);
  return refs.id;
}

/**
 * Answer in a review thread.
 *
 * `threadId` is the GraphQL node id of the thread, which the page carries from the
 * detail payload; nothing here looks it up, because a thread belongs to the pull
 * request the URL already names.
 */
export async function replyToThread(context: WriteContext, threadId: string, body: string): Promise<void> {
  allowWrite(context);
  if (body.trim() === "") throw new WriteInputError("empty comment body");
  if (threadId.trim() === "") throw new WriteInputError("missing threadId");
  await context.writer.mutation(THREAD_REPLY_MUTATION, { threadId, body });
  recordWrite(context, "reply_thread", { threadId });
}

/** Comment on the whole pull request, rather than inside a thread. */
export async function commentOnPullRequest(context: WriteContext, body: string): Promise<void> {
  allowWrite(context);
  if (body.trim() === "") throw new WriteInputError("empty comment body");
  const subjectId = await prNodeId(context);
  await context.writer.mutation(PR_COMMENT_MUTATION, { subjectId, body });
  recordWrite(context, "comment");
}

/**
 * Add or remove one reaction on any node of the pull request: the pull request
 * itself, a comment, a review, or a review comment.
 *
 * `subjectId` comes from the detail payload, so the page never invents one. The
 * reaction name is checked against GitHub's list before anything is sent.
 */
export async function setReaction(
  context: WriteContext,
  subjectId: string,
  content: ReactionContent,
  add: boolean,
): Promise<void> {
  allowWrite(context);
  if (!REACTION_CONTENTS.includes(content)) throw new WriteInputError("invalid reaction content");
  if (subjectId.trim() === "") throw new WriteInputError("missing subjectId");
  await context.writer.mutation(add ? ADD_REACTION_MUTATION : REMOVE_REACTION_MUTATION, { subjectId, content });
  recordWrite(context, add ? "reaction_add" : "reaction_remove", { content });
}

/**
 * Submit a whole review at once: the line comments the page collected, an
 * optional summary, and a verdict.
 *
 * This is the one write that is not GraphQL. GitHub's review API is REST and takes
 * the whole review in one body, which is why the page holds the pending comments
 * in the browser until the operator submits them. The head commit is read first,
 * because a review belongs to a commit.
 */
export async function submitReview(
  context: WriteContext,
  event: ReviewEvent,
  body: string,
  comments: readonly ReviewLineComment[],
): Promise<void> {
  allowWrite(context);
  if (!REVIEW_EVENTS.includes(event)) throw new WriteInputError("invalid review event");
  if (comments.length === 0 && body.trim() === "") {
    throw new WriteInputError("a review needs at least one comment or a summary body");
  }
  for (const comment of comments) {
    if (comment.side !== "LEFT" && comment.side !== "RIGHT") {
      throw new WriteInputError("side must be LEFT or RIGHT");
    }
    if (comment.body.trim() === "") throw new WriteInputError("empty comment body");
  }

  const { owner, name } = splitRepository(context.repo);
  const head = (await prRefs(context)).headRefOid;
  if (head === "") {
    throw new GhError(`PR #${context.number} not found`);
  }

  const payload: Record<string, unknown> = { commit_id: head, event, body: body ?? "" };
  const items = comments.map((comment) => {
    const item: Record<string, unknown> = {
      path: comment.path,
      side: comment.side,
      line: comment.line,
      body: comment.body,
    };
    if (comment.startLine !== null && comment.startLine !== undefined && comment.startLine !== comment.line) {
      item["start_line"] = comment.startLine;
      item["start_side"] = comment.side;
    }
    return item;
  });
  if (items.length > 0) payload["comments"] = items;

  await context.writer.api(
    ["api", `repos/${owner}/${name}/pulls/${context.number}/reviews`, "-X", "POST", "--input", "-"],
    JSON.stringify(payload),
  );
  recordWrite(context, "review", { event, comments: items.length });
}

/** What a resolve answers: the thread's id and whether GitHub now holds it resolved. */
export interface ResolvedThread {
  readonly id: string;
  readonly isResolved: boolean;
}

/**
 * Mark one review thread resolved.
 *
 * Unlike a reply, this write reads the thread first and refuses one that does not
 * belong to the pull request the address names, so the page cannot resolve a
 * thread of another pull request or repository by sending its id. A thread the
 * account cannot resolve is refused, and a thread that is already resolved sends
 * no mutation and leaves no audit row. `resolutionReason` is never sent.
 */
export async function resolveThread(context: WriteContext, threadId: string): Promise<ResolvedThread> {
  allowWrite(context);
  if (typeof threadId !== "string" || threadId.trim() === "") throw new WriteInputError("missing threadId");

  const data = await context.reader.graphql<{
    node?: {
      isResolved?: boolean;
      viewerCanResolve?: boolean;
      pullRequest?: { number?: number; repository?: { nameWithOwner?: string } | null } | null;
    } | null;
  }>(THREAD_OWNER_QUERY, { threadId });
  const node = data.node;
  const pullRequest = node?.pullRequest;
  if (node === null || node === undefined || pullRequest === null || pullRequest === undefined) {
    throw new WriteInputError("the thread is not a review thread of this pull request");
  }
  const repository = pullRequest.repository?.nameWithOwner ?? "";
  if (repository.toLowerCase() !== context.repo.toLowerCase() || pullRequest.number !== context.number) {
    throw new WriteInputError("the thread is not a review thread of this pull request");
  }
  if (node.viewerCanResolve !== true) throw new WriteInputError("this account cannot resolve this thread");
  if (node.isResolved === true) return { id: threadId, isResolved: true };

  const answer = await context.writer.mutation<{
    resolveReviewThread?: { thread?: { id?: string; isResolved?: boolean } | null } | null;
  }>(RESOLVE_THREAD_MUTATION, { threadId });
  recordWrite(context, "resolve_thread", { threadId });
  const thread = answer?.resolveReviewThread?.thread;
  return { id: thread?.id ?? threadId, isResolved: thread?.isResolved === true };
}

/** What an edit answers: the text as GitHub holds it after the call. */
export interface EditedText {
  readonly body: string;
}

function checkEditSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > EDIT_TEXT_LIMIT_BYTES) {
    throw new WriteInputError(
      `the text is ${bytes} bytes; this page sends at most ${EDIT_TEXT_LIMIT_BYTES} bytes; edit it on github.com`,
    );
  }
}

/** Compare the text GitHub holds with the text the page started from. */
function checkBase(current: string, baseBody: string, what: string): void {
  if (current !== baseBody) {
    throw new WriteConflictError(
      `the ${what} changed on GitHub after you started editing; your text was not saved. ` +
        "Copy your text, press Cancel, reload, and edit again.",
    );
  }
}

/**
 * Replace the description of the pull request the address names.
 *
 * The pull request id comes from a read made here, never from the page. The write
 * is refused when GitHub does not let this account update the pull request or
 * when another account wrote it, and it is refused with `WriteConflictError` when
 * GitHub's text is no longer `baseBody`, the text the page started from. A text
 * equal to the current one sends no mutation and leaves no audit row. Only
 * `pullRequestId` and `body` are sent, so GitHub leaves every other field alone.
 */
export async function editDescription(context: WriteContext, body: string, baseBody: string): Promise<EditedText> {
  allowWrite(context);
  checkEditSize(body);
  const { owner, name } = splitRepository(context.repo);
  const data = await context.reader.graphql<{
    repository?: {
      pullRequest?: { id?: string; body?: string | null; viewerCanUpdate?: boolean; viewerDidAuthor?: boolean } | null;
    } | null;
  }>(DESCRIPTION_READ_QUERY, { owner, name, number: context.number });
  const pr = data.repository?.pullRequest;
  if (pr === null || pr === undefined || (pr.id ?? "") === "") {
    throw new GhError(`PR #${context.number} not found`);
  }
  if (pr.viewerCanUpdate !== true) throw new WriteInputError("this account cannot edit this description");
  if (pr.viewerDidAuthor !== true) throw new WriteInputError("this account did not write this pull request");
  const current = pr.body ?? "";
  checkBase(current, baseBody, "description");
  if (body === current) return { body: current };

  const answer = await context.writer.mutation<{
    updatePullRequest?: { pullRequest?: { body?: string | null } | null } | null;
  }>(UPDATE_DESCRIPTION_MUTATION, { pullRequestId: pr.id ?? "", body });
  recordWrite(context, "edit_description");
  return { body: answer?.updatePullRequest?.pullRequest?.body ?? body };
}

/**
 * Replace the text of one of the account's own comments on the pull request: a
 * conversation comment or a review comment.
 *
 * The comment id comes from the page, so it is read first and refused when it is
 * neither kind of comment, belongs to another pull request or repository, or was
 * written by another account. The base text check, the unchanged text and the
 * audit row work as in {@link editDescription}. An empty text is refused, because
 * GitHub refuses an empty comment.
 */
export async function editComment(
  context: WriteContext,
  commentId: string,
  body: string,
  baseBody: string,
): Promise<EditedText> {
  allowWrite(context);
  checkEditSize(body);
  if (typeof commentId !== "string" || commentId.trim() === "") throw new WriteInputError("missing commentId");
  if (body.trim() === "") throw new WriteInputError("empty comment body");

  const data = await context.reader.graphql<{
    node?: {
      __typename?: string;
      body?: string | null;
      viewerCanUpdate?: boolean;
      viewerDidAuthor?: boolean;
      pullRequest?: { number?: number; repository?: { nameWithOwner?: string } | null } | null;
    } | null;
  }>(COMMENT_READ_QUERY, { commentId });
  const node = data.node;
  const type = node?.__typename;
  const pullRequest = node?.pullRequest;
  const notHere = "the comment is not a comment of this pull request";
  if (
    node === null ||
    node === undefined ||
    (type !== "IssueComment" && type !== "PullRequestReviewComment") ||
    pullRequest === null ||
    pullRequest === undefined
  ) {
    throw new WriteInputError(notHere);
  }
  const repository = pullRequest.repository?.nameWithOwner ?? "";
  if (repository.toLowerCase() !== context.repo.toLowerCase() || pullRequest.number !== context.number) {
    throw new WriteInputError(notHere);
  }
  if (node.viewerCanUpdate !== true) throw new WriteInputError("this account cannot edit this comment");
  if (node.viewerDidAuthor !== true) throw new WriteInputError("this account did not write this comment");
  const current = node.body ?? "";
  checkBase(current, baseBody, "comment");
  if (body === current) return { body: current };

  if (type === "IssueComment") {
    const answer = await context.writer.mutation<{
      updateIssueComment?: { issueComment?: { body?: string | null } | null } | null;
    }>(UPDATE_ISSUE_COMMENT_MUTATION, { id: commentId, body });
    recordWrite(context, "edit_comment", { commentId, commentType: type });
    return { body: answer?.updateIssueComment?.issueComment?.body ?? body };
  }
  const answer = await context.writer.mutation<{
    updatePullRequestReviewComment?: { pullRequestReviewComment?: { body?: string | null } | null } | null;
  }>(UPDATE_REVIEW_COMMENT_MUTATION, { commentId, body });
  recordWrite(context, "edit_comment", { commentId, commentType: type });
  return { body: answer?.updatePullRequestReviewComment?.pullRequestReviewComment?.body ?? body };
}
