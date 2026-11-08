import { GhError, type GhReader } from "./gh.ts";
import { mentionAlias, mentionDetailQuery, READ_LIMITS, SEARCH_QUERY, VIEWER_QUERY } from "./queries.ts";
import { splitRepository } from "./settings.ts";

/**
 * The pull request list: five sections, one pull request in one section, and the
 * mention rule that decides whether a mention is still waiting for an answer.
 *
 * The sections are the original's, in the original's order, and so is the rule
 * that a pull request claimed by an earlier section cannot appear in a later one.
 * A repository is fetched by seven searches plus one mention-detail query per 20
 * mentioned pull requests; several repositories are merged into one payload.
 *
 * The merge is all-or-nothing. One repository's failure rejects the whole fetch,
 * and the caller keeps the list it already had. That is the chosen behavior:
 * a list that silently lacked a repository would read as "nothing to review
 * there", which is the one thing this dashboard must never say by accident.
 */

/**
 * Compare two timestamps as text.
 *
 * GitHub's timestamps are ISO 8601 in UTC, so a byte comparison is a time
 * comparison, and it is the same comparison the original's `sorted` made. A
 * locale-aware comparison would be worse here: it is slower, and it is not the
 * order the timestamps encode.
 */
function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The key and heading of each section, in the order they are shown. */
export const SECTIONS = [
  { key: "mentioned", title: "Mentioned" },
  { key: "need-review", title: "Need review" },
  { key: "opened", title: "Opened" },
  { key: "draft", title: "Draft" },
  { key: "related", title: "Related" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

/** One label as GitHub returns it. */
export interface PrLabel {
  readonly name: string;
  readonly color: string;
}

/** One pull request as a list row shows it. */
export interface PrRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly updatedAt: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly reviewDecision: string | null;
  readonly labels: readonly PrLabel[];
  readonly ciState: string | null;
  /** The configured spelling of the repository, `owner/repo`. */
  readonly repo: string;
}

export interface PrSection {
  readonly key: SectionKey;
  readonly title: string;
  readonly prs: readonly PrRow[];
}

/** The list payload the browser receives, and the shape the cache holds. */
export interface PrListPayload {
  readonly viewer: string | null;
  readonly repos: readonly { readonly repo: string }[];
  readonly sections: readonly PrSection[];
}

/** Raw shapes of the GraphQL answers this module reads. */
interface RawAuthor {
  readonly login?: string | null;
}

interface RawPr {
  readonly number?: number | null;
  readonly title?: string;
  readonly url?: string;
  readonly isDraft?: boolean;
  readonly state?: string;
  readonly updatedAt?: string;
  readonly author?: RawAuthor | null;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly reviewDecision?: string | null;
  readonly labels?: { readonly nodes?: readonly PrLabel[] | null } | null;
  readonly commits?: {
    readonly nodes?: readonly { readonly commit?: { readonly statusCheckRollup?: { readonly state?: string } | null } }[] | null;
  } | null;
}

interface RawComment {
  readonly author?: RawAuthor | null;
  readonly body?: string | null;
  readonly createdAt?: string;
}

/** The comment, review and thread set the mention rule reads for one PR. */
export interface MentionSource {
  readonly comments: readonly RawComment[];
  readonly reviews: readonly RawComment[];
  readonly threads: readonly { readonly comments: readonly RawComment[] }[];
}

/**
 * The mention matcher of the original: `@login`, not preceded by a word
 * character or a slash (so an e-mail or a path does not count), and not followed
 * by a word character. GitHub logins are case-insensitive here, as there.
 */
export function mentionPattern(login: string): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w/])@${escaped}\\b`, "i");
}

/**
 * Whether one thread still holds a mention of `login` with no later word from
 * `login`.
 *
 * The state walks the thread in time order: a comment by the viewer clears it, a
 * comment by anyone else that mentions the viewer sets it. So a reply from the
 * viewer closes the mention, and a second mention after that reply opens it again.
 */
function threadIsPending(comments: readonly RawComment[], login: string): boolean {
  const pattern = mentionPattern(login);
  const ordered = [...comments].sort((a, b) => compareText(a.createdAt, b.createdAt));
  let pending = false;
  for (const comment of ordered) {
    const author = comment.author?.login ?? null;
    if (author === login) {
      pending = false;
    } else if (pattern.test(comment.body ?? "")) {
      pending = true;
    }
  }
  return pending;
}

/**
 * Whether a pull request holds a mention of `login` that waits for an answer.
 *
 * Pull request comments and review bodies count as one thread, because a review
 * summary and the comments above it are one conversation; every review thread
 * counts on its own. A review with an empty body is not part of it: a bare
 * "Approved" cannot carry a mention.
 */
export function hasPendingMention(source: MentionSource | undefined, login: string): boolean {
  if (source === undefined) return false;
  const prWide: RawComment[] = [...source.comments];
  for (const review of source.reviews) {
    if ((review.body ?? "").trim() !== "") prWide.push(review);
  }
  if (threadIsPending(prWide, login)) return true;
  return source.threads.some((thread) => threadIsPending(thread.comments, login));
}

/** One list row from a raw pull request. */
export function slimPr(pr: RawPr, repo: string): PrRow {
  const commit = pr.commits?.nodes?.[0]?.commit;
  return {
    number: pr.number ?? 0,
    title: pr.title ?? "",
    url: pr.url ?? "",
    isDraft: pr.isDraft ?? false,
    author: pr.author?.login ?? null,
    updatedAt: pr.updatedAt ?? "",
    headRefName: pr.headRefName ?? "",
    baseRefName: pr.baseRefName ?? "",
    reviewDecision: pr.reviewDecision ?? null,
    labels: pr.labels?.nodes ?? [],
    ciState: commit?.statusCheckRollup?.state ?? null,
    repo,
  };
}

/** The login `gh` is authenticated as. */
export async function fetchViewer(reader: GhReader): Promise<string | null> {
  const data = await reader.graphql<{ viewer?: { login?: string | null } | null }>(VIEWER_QUERY);
  return data.viewer?.login ?? null;
}

/** One search: the repository, `is:pr is:open`, and the section's qualifier. */
async function search(reader: GhReader, repo: string, qualifier: string): Promise<RawPr[]> {
  const query = `repo:${repo} is:pr is:open ${qualifier}`;
  const data = await reader.graphql<{ search?: { nodes?: readonly (RawPr | null)[] | null } | null }>(SEARCH_QUERY, {
    q: query,
  });
  const nodes = data.search?.nodes ?? [];
  return nodes.filter((node): node is RawPr => node !== null && node !== undefined && Boolean(node.number));
}

/**
 * Read the mention state of a chunk of pull requests.
 *
 * The answer comes back under the aliases the query made, so the numbers that were
 * asked for are the keys of the result whatever order GitHub answers in.
 */
async function fetchMentionDetails(
  reader: GhReader,
  repo: string,
  numbers: readonly number[],
): Promise<Map<number, MentionSource>> {
  const result = new Map<number, MentionSource>();
  if (numbers.length === 0) return result;
  const { owner, name } = splitRepository(repo);
  const data = await reader.graphql<{ repository?: Record<string, unknown> | null }>(
    mentionDetailQuery(owner, name, numbers),
  );
  const repository = data.repository ?? {};
  numbers.forEach((number, index) => {
    const node = repository[mentionAlias(index)];
    if (node === null || node === undefined || typeof node !== "object") return;
    const record = node as {
      comments?: { nodes?: readonly RawComment[] | null } | null;
      reviews?: { nodes?: readonly RawComment[] | null } | null;
      reviewThreads?: { nodes?: readonly { comments?: { nodes?: readonly RawComment[] | null } | null }[] | null } | null;
    };
    result.set(number, {
      comments: record.comments?.nodes ?? [],
      reviews: record.reviews?.nodes ?? [],
      threads: (record.reviewThreads?.nodes ?? []).map((thread) => ({ comments: thread.comments?.nodes ?? [] })),
    });
  });
  return result;
}

/** Keep the mentions that still wait for an answer from the viewer. */
async function filterPendingMentions(
  reader: GhReader,
  repo: string,
  candidates: readonly RawPr[],
  viewer: string,
): Promise<RawPr[]> {
  if (candidates.length === 0) return [];
  const numbers = candidates.map((pr) => pr.number ?? 0);
  const details = new Map<number, MentionSource>();
  for (let start = 0; start < numbers.length; start += READ_LIMITS.mentionChunk) {
    const chunk = numbers.slice(start, start + READ_LIMITS.mentionChunk);
    const found = await fetchMentionDetails(reader, repo, chunk);
    for (const [number, source] of found) details.set(number, source);
  }
  return candidates.filter((pr) => hasPendingMention(details.get(pr.number ?? 0), viewer));
}

/**
 * Build the five sections of one repository.
 *
 * Order matters and is the original's: a pull request seen in `Mentioned` is not
 * shown again under `Opened`, and the last section, `Related`, holds what no other
 * section claimed. Every section is sorted by `updatedAt`, newest first, and a
 * pull request that is no longer open is dropped.
 */
async function repositorySections(reader: GhReader, repo: string, viewer: string): Promise<PrSection[]> {
  const mentionedCandidates = await search(reader, repo, `mentions:${viewer}`);
  const mentioned = await filterPendingMentions(reader, repo, mentionedCandidates, viewer);
  const needReview = await search(reader, repo, `review-requested:${viewer}`);
  const opened = await search(reader, repo, `author:${viewer} draft:false`);
  const draft = await search(reader, repo, `author:${viewer} draft:true`);

  const related = new Map<number, RawPr>();
  for (const qualifier of [`involves:${viewer}`, `review-requested:${viewer}`, `reviewed-by:${viewer}`]) {
    for (const pr of await search(reader, repo, qualifier)) {
      const number = pr.number ?? 0;
      if (!related.has(number)) related.set(number, pr);
    }
  }

  const claimed = new Set<number>();
  const sections: PrSection[] = [];
  const add = (key: SectionKey, title: string, prs: readonly RawPr[]): void => {
    const fresh: PrRow[] = [];
    const ordered = [...prs].sort((a, b) => compareText(b.updatedAt, a.updatedAt));
    for (const pr of ordered) {
      const number = pr.number ?? 0;
      if (claimed.has(number)) continue;
      if (pr.state !== "OPEN") continue;
      claimed.add(number);
      fresh.push(slimPr(pr, repo));
    }
    sections.push({ key, title, prs: fresh });
  };

  add("mentioned", "Mentioned", mentioned);
  add("need-review", "Need review", needReview);
  add("opened", "Opened", opened);
  add("draft", "Draft", draft);
  add("related", "Related", [...related.values()]);
  return sections;
}

/**
 * Fetch and merge the list for every configured repository.
 *
 * Sequential on purpose: a poll is one burst of searches, and running five
 * repositories at once would spend the same GraphQL budget sooner, not later. The
 * viewer is read once and reused, because `gh` authenticates as one account.
 */
export async function fetchPrList(reader: GhReader, repos: readonly string[]): Promise<PrListPayload> {
  if (repos.length === 0) {
    throw new GhError("no repository is configured");
  }
  const viewer = await fetchViewer(reader);
  if (viewer === null) {
    throw new GhError("gh is not authenticated as anyone");
  }

  const merged = new Map<SectionKey, { key: SectionKey; title: string; prs: PrRow[] }>();
  for (const section of SECTIONS) {
    merged.set(section.key, { key: section.key, title: section.title, prs: [] });
  }

  for (const repo of repos) {
    const sections = await repositorySections(reader, repo, viewer);
    for (const section of sections) {
      const target = merged.get(section.key);
      if (target === undefined) continue;
      target.prs.push(...section.prs);
    }
  }

  const sections: PrSection[] = [];
  for (const section of SECTIONS) {
    const entry = merged.get(section.key);
    if (entry === undefined) continue;
    entry.prs.sort((a, b) => compareText(b.updatedAt, a.updatedAt));
    sections.push({ key: entry.key, title: entry.title, prs: entry.prs });
  }

  return {
    viewer,
    repos: repos.map((repo) => ({ repo })),
    sections,
  };
}
