/**
 * The JSON data blocks the server writes into a dashboard page.
 *
 * The blocks are data, not code: their type is `application/json`, so the browser
 * parses them and never runs them, and the page's policy (`script-src 'self'`)
 * has nothing to refuse. That is why the header's facts and the list page's first
 * answer travel this way rather than as an inline script.
 *
 * `github-pr-meta` is on all three pages and answers three questions the header
 * asks before any request: who gh is logged in as, which repositories the
 * operator configured, and whether the write routes answer at all.
 * `github-pr-list-first` is on the list page only and holds the list the server
 * already had, so the rows draw with the page. `github-pr-pending-first` is on the
 * list page only too and holds the saved reviews, so the Pending reviews section
 * draws with the page as well.
 *
 * A missing block and a block this build cannot read both answer the same thing:
 * the empty meta, and no list. The page then asks the server instead, which is
 * what it would have done anyway, and it draws no write control, which is the
 * safe side of a switch that did not arrive.
 */
import type { GithubPrListAnswer, GithubPrPendingAnswer, GithubPrRepo } from "../api/github-pr.ts";

/** The id of the block that names the viewer, the repositories and the write switch. */
export const META_ID = "github-pr-meta";

/** The id of the block that holds the list the server already had. */
export const LIST_FIRST_ID = "github-pr-list-first";

/** The id of the block that holds the saved reviews the server already read. */
export const PENDING_FIRST_ID = "github-pr-pending-first";

/** What `github-pr-meta` holds. */
export interface GithubPrMeta {
  /** The login gh answers as, or `null` when the server could not read it. */
  readonly viewer: string | null;
  readonly repos: readonly GithubPrRepo[];
  /** True when the write routes answer; false when every write answers 403. */
  readonly writes: boolean;
}

/** What a page says when it carries no usable meta block. */
const EMPTY_META: GithubPrMeta = { viewer: null, repos: [], writes: false };

/** Read one JSON data block the server wrote into the page, or `undefined`. */
export function readDataBlock(id: string): unknown {
  if (typeof document === "undefined") return undefined;
  const element = document.getElementById(id);
  if (element === null) return undefined;
  try {
    return JSON.parse(element.textContent ?? "");
  } catch {
    return undefined;
  }
}

/** Whether a value is the meta shape this build reads. */
function isMeta(value: unknown): value is GithubPrMeta {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { viewer?: unknown; repos?: unknown; writes?: unknown };
  if (candidate.viewer !== null && typeof candidate.viewer !== "string") return false;
  if (typeof candidate.writes !== "boolean") return false;
  if (!Array.isArray(candidate.repos)) return false;
  return candidate.repos.every(
    (repo) => typeof repo === "object" && repo !== null && typeof (repo as { repo?: unknown }).repo === "string",
  );
}

/** Whether a value is the list shape this build reads. */
function isListAnswer(value: unknown): value is GithubPrListAnswer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { sections?: unknown };
  return Array.isArray(candidate.sections);
}

/** Whether a value is the saved reviews shape this build reads. */
function isPendingAnswer(value: unknown): value is GithubPrPendingAnswer {
  if (typeof value !== "object" || value === null) return false;
  const reviews = (value as { reviews?: unknown }).reviews;
  if (!Array.isArray(reviews)) return false;
  return reviews.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const row = item as { kind?: unknown; repo?: unknown; number?: unknown; savedAt?: unknown };
    return (
      (row.kind === "draft" || row.kind === "unreadable") &&
      typeof row.repo === "string" &&
      typeof row.number === "number" &&
      typeof row.savedAt === "string"
    );
  });
}

/** The header's facts, read from the page's own block. */
export function readMeta(): GithubPrMeta {
  const value = readDataBlock(META_ID);
  return isMeta(value) ? value : EMPTY_META;
}

/**
 * Whether the write controls may be drawn.
 *
 * Every part that would draw a control which writes reads this and none of them
 * decides for itself: `writes` off means the reply boxes, the comment box, the
 * reaction buttons and the diff's line selection are not drawn at all.
 */
export function writesEnabled(): boolean {
  return readMeta().writes;
}

/** The list the server wrote into the page, or `undefined` when it wrote none. */
export function readFirstList(): GithubPrListAnswer | undefined {
  const value = readDataBlock(LIST_FIRST_ID);
  return isListAnswer(value) ? value : undefined;
}

/** The saved reviews the server wrote into the page, or `undefined` when it wrote none. */
export function readFirstPending(): GithubPrPendingAnswer | undefined {
  const value = readDataBlock(PENDING_FIRST_ID);
  return isPendingAnswer(value) ? value : undefined;
}
