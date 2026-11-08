import type { AttachmentContext } from "./store.ts";
import { dropForJobs, sweep } from "./store.ts";

/**
 * The two cleanup entry points, in the module the harness wiring reads.
 *
 * The work itself is in `store.ts`, next to the index it walks. This module is
 * the seam: the archive hook calls `dropForJobs`, the boot pass calls
 * `sweepAttachments`, and neither has to know how the two roots are laid out.
 */
export { dropForJobs, sweep };

/** What one sweep pass did, for the boot log. */
export interface AttachmentSweepSummary {
  readonly dropped: number;
  readonly orphanFiles: number;
}

/**
 * One call for the boot sweep.
 *
 * `liveJobIds` is the set of jobs still in the live store. A job that has left it
 * can no longer read what it owns, so its files go; `undefined` means the caller
 * has no live store to compare against, and the ownership rule is skipped rather
 * than guessed. Pass it: without it only the unowned grace and the orphan file
 * checks run.
 *
 * `dropForJobs` is the other half, and it is not called from here: the archive
 * hook knows exactly which jobs left, so it names them instead of waiting for a
 * later boot to notice. Both reach the same `dispose`, so both leave an audit row
 * with the file name, the id and the job id.
 */
export async function sweepAttachments(
  ctx: AttachmentContext,
  liveJobIds?: ReadonlySet<string>,
): Promise<AttachmentSweepSummary> {
  return await sweep(ctx, liveJobIds);
}
