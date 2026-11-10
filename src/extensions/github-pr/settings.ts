import type { Config, GithubPrConfig } from "../../config/schema.ts";
import { dedupeRepos, splitRepoSlug } from "./network.ts";

/**
 * Reading `githubPr` from the config, once per request and once per poll.
 *
 * The extension is turned on by `agent.extensions.enabled`, which is read while
 * the daemon boots, but the four values under `githubPr` are read again on every
 * request and every poll. So an operator changes `repos`, `writes`,
 * `fetchIntervalSeconds` or `diskLimitMegabytes`, reloads the config, and the next
 * request already uses them. That is why nothing here caches: a cached value would
 * be a value the reload did not reach.
 *
 * `repos` also loses its case-only duplicates here. GitHub compares owner and
 * repository name without regard to case, so `Foo/Bar` and `foo/bar` name one
 * repository, and the loader deliberately accepts both. `dedupeRepos` of
 * network.ts folds them, and the first spelling in the file wins, because that is the spelling the operator wrote first and the one the
 * pages show.
 */

/** The settings the dashboard reads, with the defaults of the schema applied. */
export interface GithubPrSettings {
  /** Whether this install may write to GitHub. No default: the file decides. */
  readonly writes: boolean;
  /** The configured repositories as `owner/repo`, in file order, deduped. */
  readonly repos: readonly string[];
  /** Seconds between the end of one poll and the start of the next. */
  readonly fetchIntervalSeconds: number;
  /** Cap on `~/.pi/sec/gh-repo/`, in megabytes. 0 means no limit. */
  readonly diskLimitMegabytes: number;
}

/** The defaults of the two numbers, which the schema also declares. */
export const FETCH_INTERVAL_DEFAULT_SECONDS = 300;
export const DISK_LIMIT_DEFAULT_MEGABYTES = 2048;

/** Split `owner/repo`; throws on a value the schema should have refused. */
export function splitRepository(repo: string): { owner: string; name: string } {
  const parts = splitRepoSlug(repo);
  if (parts === undefined) throw new Error(`not owner/repo: ${repo}`);
  return { owner: parts.owner, name: parts.repo };
}

/** The config as the extension sees it, or undefined when the key is absent. */
function rawSettings(config: Config): GithubPrConfig | undefined {
  return config.githubPr;
}

/**
 * Read the settings of one config.
 *
 * A config without `githubPr` is not an error here: the loader refuses that only
 * while the extension is enabled, and this function is also reachable from a test
 * that builds a config by hand. It returns `undefined` then, and a caller treats
 * that as "nothing to display and nothing to write".
 */
export function readSettings(config: Config): GithubPrSettings | undefined {
  const raw = rawSettings(config);
  if (raw === undefined) return undefined;
  return {
    writes: raw.writes,
    repos: dedupeRepos(raw.repos),
    fetchIntervalSeconds: raw.fetchIntervalSeconds ?? FETCH_INTERVAL_DEFAULT_SECONDS,
    diskLimitMegabytes: raw.diskLimitMegabytes ?? DISK_LIMIT_DEFAULT_MEGABYTES,
  };
}

/**
 * The settings of the config a caller asks for, read fresh on every call.
 *
 * The argument is a function rather than a config, so a caller wires
 * `() => deps.runtime.getConfig()` once and never holds a stale copy. `undefined`
 * means the key is absent.
 */
export function createSettingsReader(getConfig: () => Config): () => GithubPrSettings | undefined {
  return () => readSettings(getConfig());
}

/**
 * Find the configured spelling of a repository named in a URL.
 *
 * The URL carries `<owner>/<repo>` and GitHub does not distinguish case, so the
 * match ignores it; the return value is the configured spelling, which is what
 * every payload shows. `undefined` means the repository is not configured, and the
 * caller answers `404`.
 */
export function configuredRepository(settings: GithubPrSettings, owner: string, name: string): string | undefined {
  const wanted = `${owner}/${name}`.toLowerCase();
  return settings.repos.find((repo) => repo.toLowerCase() === wanted);
}
