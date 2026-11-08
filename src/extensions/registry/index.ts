import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import {
  jobIdFromWorktreeName,
  registryPaths,
  registrySettings,
  type RegistrySettings,
} from "../../registry/layout.ts";
import { listRegistry, listRepoIds, showRepo, topLevelNames } from "../../registry/store.ts";
import type { ExtensionContext } from "../context.ts";

/**
 * The registry as an agent reads it: one read-only tool over the core in
 * `src/registry/`.
 *
 * The tool answers with the same JSON the `pi-sec repos list` command prints, so
 * an agent and an operator looking at the same registry read the same fields.
 * Nothing here writes: the registry is changed by the command line, where a
 * person decides what a worktree or a cache is worth removing.
 */

/** One job's two fields, as a worktree listing shows them. */
interface JobSummary {
  title: string;
  status: string;
}

/** The synchronous lookup the listing takes, or nothing when it has no job store. */
type JobLookup = (jobId: string) => JobSummary | undefined;

/**
 * The ids of the jobs whose worktrees this registry holds.
 *
 * A worktree folder is named after the job that works in it, and the folder name
 * is the only place the registry keeps that fact. Reading the names before the
 * listing is what makes the lookup synchronous: the listing asks for a job while
 * it runs, and a job store answers asynchronously.
 */
function worktreeJobIds(settings: RegistrySettings): string[] {
  const worktreesRoot = registryPaths(settings.root).worktrees;
  const ids = new Set<string>();
  for (const repo of listRepoIds(settings)) {
    for (const name of topLevelNames(join(worktreesRoot, repo))) {
      const jobId = jobIdFromWorktreeName(name);
      if (jobId !== undefined) ids.add(jobId);
    }
  }
  return [...ids];
}

/**
 * A lookup over the live job store and then the archive, or nothing when this
 * conversation has no job store at all.
 *
 * The live store is asked first and the archive second, so a finished job that
 * the sweep moved out of the live store is still found. One id that cannot be
 * read leaves that worktree's job fields empty and the rest of the listing as it
 * was, which is what the listing does with a lookup that throws.
 */
async function jobLookupOf(context: ExtensionContext, settings: RegistrySettings): Promise<JobLookup | undefined> {
  const jobs = context.jobs;
  const archive = context.archive;
  if (jobs === undefined && archive === undefined) return undefined;

  const found = new Map<string, JobSummary>();
  for (const id of worktreeJobIds(settings)) {
    try {
      const job = archive !== undefined
        ? await archive.getAny(BACKGROUND_CONTEXT, id)
        : await jobs?.get(BACKGROUND_CONTEXT, id);
      if (job !== undefined) found.set(id, { title: job.title, status: job.status });
    } catch {
      // A job store that cannot answer is not a reason to refuse the listing.
    }
  }
  return (jobId) => found.get(jobId);
}

function failure(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * The `repos_list` tool.
 *
 * Read-only by construction: it reads the config for the registry root, reads
 * the registry below it, and writes nothing. `replay: "safe"` is the same claim
 * as for `expiry_check`: on the same registry it answers the same text.
 */
export function createReposListTool(context: ExtensionContext) {
  return defineTool({
    name: "repos_list",
    description:
      "Read the repositories, worktrees and buildfs caches of the git repository registry. It does not change the registry. " +
      "Argument: repo, optional, `<owner>/<repo>`. With it the answer is that one repository; without it every repository. " +
      "Result: JSON {root, mode, repos, worktrees, caches}. A repo: id, gitDir, inPlace, remotes, defaultBranch, sizeBytes, hookInstalled. " +
      "A worktree: repo, path, managed, branch, head, dirty, createdAt, jobId, jobTitle, jobStatus, sizeBytes, buildDirs. " +
      "A build dir: dir, mode, filledFrom, installedAt, lockfileHash, sizeBytes. " +
      "A cache: repo, buildDir, path, createdAt, sourceWorktree, lockfileHash, readOnly, sizeBytes.",
    parameters: obj(
      {
        repo: opt(
          str({
            description: "One repository as `<owner>/<repo>`. Leave it out to read every repository.",
          }),
        ),
      },
    ),
    replay: "safe",
    execute: async (args) => {
      const settings = registrySettings(context.getConfig());
      try {
        const lookup = await jobLookupOf(context, settings);
        const opts = lookup === undefined ? {} : { jobLookup: lookup };
        const listing =
          args.repo === undefined
            ? await listRegistry(settings, opts)
            : await showRepo(settings, args.repo, opts);
        return { output: [{ type: "text" as const, text: JSON.stringify(listing, null, 2) }] };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

/** The bundled `registry` extension: the one read-only tool. */
export function createRegistryExtension(context: ExtensionContext): Extension<ToolRegistration> {
  return defineExtension({
    name: "registry",
    tools: [createReposListTool(context)],
  });
}
