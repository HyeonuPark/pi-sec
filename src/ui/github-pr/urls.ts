/**
 * Every address the three dashboard pages link to, built in one place.
 *
 * The dashboard is not a single page with a fragment router: the list, one pull
 * request and one diff are three addresses, so a row is a real link that opens in
 * a new tab and the browser's back button means what it looks like. That only
 * works if every link carries the mount prefix, which is what `at()` puts on a
 * route, and if the two segments of a repository are encoded the same way every
 * time. Both happen here, so no component builds a URL of its own.
 *
 * The routes are the ones the dashboard's interface contract names: the list is
 * `/github/pr/`, one pull request is `/github/pr/<owner>/<repo>/<number>` with the
 * thread anchor `#thread-<id>`, and its diff adds `/diff`.
 */
import { at } from "../mount.ts";

/** The repository as the two path segments an address carries. */
function segments(repo: string): readonly [string, string] {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new Error(`a repository is owner/repo, got ${JSON.stringify(repo)}`);
  }
  return [encodeURIComponent(repo.slice(0, slash)), encodeURIComponent(repo.slice(slash + 1))];
}

/** Where the list page lives, under the mount. */
export function listUrl(): string {
  return at("/github/pr/");
}

/** Where one pull request's page lives, with an optional thread anchor. */
export function prUrl(repo: string, number: number, threadId?: string): string {
  const [owner, name] = segments(repo);
  const base = at(`/github/pr/${owner}/${name}/${number}`);
  return threadId === undefined ? base : `${base}#thread-${encodeURIComponent(threadId)}`;
}

/** Where one pull request's diff page lives. */
export function diffUrl(repo: string, number: number): string {
  const [owner, name] = segments(repo);
  return at(`/github/pr/${owner}/${name}/${number}/diff`);
}

/** Where the diff page of one commit of a pull request lives. */
export function commitUrl(repo: string, number: number, sha: string): string {
  const [owner, name] = segments(repo);
  return at(`/github/pr/${owner}/${name}/${number}/commits/${encodeURIComponent(sha)}`);
}
