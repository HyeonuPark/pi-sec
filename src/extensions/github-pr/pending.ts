import type { GhReader } from "./gh.ts";
import { prKey, type PrListPayload, type RawPr } from "./list.ts";
import { PENDING_PR_QUERY } from "./queries.ts";
import type { DraftEvent, DraftLogger, DraftTarget, StoredEntry } from "./review-drafts.ts";

/**
 * The Pending reviews section: every pull request that has a saved review on the
 * server, whatever its state and whether or not its repository is configured.
 *
 * Two pure steps and one read.
 *
 *   - {@link buildPendingReviews} joins the stored entries with what the server
 *     already holds about the pull request and sorts them. It never asks GitHub.
 *   - {@link readPendingFacts} is the read of the poll: one request for each
 *     saved review whose pull request is not on the list, so that the section
 *     can show its title and state. A failed read keeps the earlier facts.
 *
 * The facts of a pull request come from the cached list when the pull request is
 * on it, from the facts of the last poll when it is not, and are absent when
 * neither knows it yet.
 */

/** What the section shows about a pull request. */
export interface PendingPr {
  readonly title: string;
  readonly url: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly updatedAt: string;
}

/** One row of the section, as `GET /api/github/pr/pending` answers it. */
export type PendingReview =
  | {
      readonly kind: "draft";
      /** The configured spelling when the repository is configured, else the spelling stored in the draft. */
      readonly repo: string;
      readonly number: number;
      readonly configured: boolean;
      readonly comments: number;
      readonly summary: boolean;
      readonly event: DraftEvent;
      readonly savedAt: string;
      readonly pr: PendingPr | null;
    }
  | {
      readonly kind: "unreadable";
      readonly repo: string;
      readonly number: number;
      readonly file: string;
      readonly savedAt: string;
    };

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Join the stored entries with the list and the facts of the last poll, newest saved first. */
export function buildPendingReviews(
  entries: readonly StoredEntry[],
  list: PrListPayload | undefined,
  facts: ReadonlyMap<string, PendingPr>,
  configuredRepos: readonly string[],
): PendingReview[] {
  const configured = new Map(configuredRepos.map((repo) => [repo.trim().toLowerCase(), repo] as const));
  const onList = new Map<string, PendingPr>();
  for (const section of list?.sections ?? []) {
    for (const row of section.prs) {
      const key = prKey(row.repo, row.number);
      if (onList.has(key)) continue;
      onList.set(key, {
        title: row.title,
        url: row.url,
        state: "OPEN",
        isDraft: row.isDraft,
        author: row.author,
        updatedAt: row.updatedAt,
      });
    }
  }

  const rows: PendingReview[] = entries.map((entry): PendingReview => {
    const spelling = configured.get(entry.repo.trim().toLowerCase());
    if (entry.kind === "unreadable") {
      return { kind: "unreadable", repo: spelling ?? entry.repo, number: entry.number, file: entry.file, savedAt: entry.savedAt };
    }
    const key = prKey(entry.repo, entry.number);
    return {
      kind: "draft",
      repo: spelling ?? entry.repo,
      number: entry.number,
      configured: spelling !== undefined,
      comments: entry.comments,
      summary: entry.summary,
      event: entry.event,
      savedAt: entry.savedAt,
      pr: onList.get(key) ?? facts.get(key) ?? null,
    };
  });
  return rows.sort(
    (a, b) =>
      compareText(b.savedAt, a.savedAt) || compareText(a.repo.toLowerCase(), b.repo.toLowerCase()) || a.number - b.number,
  );
}

/** The keys of the pull requests that have a saved review. A set-aside file is not one of them. */
export function draftKeys(entries: readonly StoredEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) if (entry.kind === "draft") keys.add(prKey(entry.repo, entry.number));
  return keys;
}

/** The saved reviews whose pull request is not on the list: the ones the poll reads. */
export function offListTargets(entries: readonly StoredEntry[], list: PrListPayload): DraftTarget[] {
  const onList = new Set<string>();
  for (const section of list.sections) for (const row of section.prs) onList.add(prKey(row.repo, row.number));
  const seen = new Set<string>();
  const targets: DraftTarget[] = [];
  for (const entry of entries) {
    if (entry.kind !== "draft") continue;
    const key = prKey(entry.repo, entry.number);
    if (onList.has(key) || seen.has(key)) continue;
    seen.add(key);
    const [owner = "", name = ""] = entry.repo.split("/");
    targets.push({ repo: entry.repo, owner, name, number: entry.number });
  }
  return targets;
}

interface PendingAnswer {
  readonly repository?: { readonly pullRequest?: RawPr | null } | null;
}

/**
 * Read one pull request for each target, one after another, like the searches of
 * the list. The answer holds only the targets: the facts of a pull request that
 * no longer has a saved review are dropped. A read that fails keeps the earlier
 * facts of that pull request, writes one warning, and never rejects.
 */
export async function readPendingFacts(
  reader: GhReader,
  targets: readonly DraftTarget[],
  previous: ReadonlyMap<string, PendingPr>,
  logger: Pick<DraftLogger, "warn">,
): Promise<Map<string, PendingPr>> {
  const next = new Map<string, PendingPr>();
  for (const target of targets) {
    const key = prKey(target.repo, target.number);
    const earlier = previous.get(key);
    try {
      const data = await reader.graphql<PendingAnswer>(PENDING_PR_QUERY, {
        owner: target.owner,
        name: target.name,
        number: target.number,
      });
      const pr = data.repository?.pullRequest;
      if (pr === null || pr === undefined) throw new Error("GitHub has no such pull request");
      next.set(key, {
        title: pr.title ?? "",
        url: pr.url ?? "",
        state: pr.state ?? "OPEN",
        isDraft: pr.isDraft ?? false,
        author: pr.author?.login ?? null,
        updatedAt: pr.updatedAt ?? "",
      });
    } catch (error) {
      logger.warn("github-pr saved review facts could not be read", { repo: target.repo, number: target.number, error });
      if (earlier !== undefined) next.set(key, earlier);
    }
  }
  return next;
}
