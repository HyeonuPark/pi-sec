import type { AttachmentContext } from "./store.ts";
import { sweep } from "./store.ts";

/**
 * The cleanup entry point, in the module the harness wiring reads.
 *
 * The work itself is in `store.ts`, next to the index it walks. This module is
 * the seam: the boot pass calls `sweepAttachments`, and it does not have to know
 * how the two roots are laid out.
 */
export { sweep };

/** What one sweep pass did, for the boot log. */
export interface AttachmentSweepSummary {
  readonly dropped: number;
  readonly orphanFiles: number;
}

/**
 * One call for the boot sweep.
 *
 * A stored file with an owner job is kept, also after the job is archived. A
 * stored file with no owner job is temporary: this pass deletes it once it is 24
 * hours old. The pass also retires a row whose file is gone, and deletes a file
 * that no row names. Every deletion leaves an audit row with the file name, the
 * id and the reason.
 */
export async function sweepAttachments(ctx: AttachmentContext): Promise<AttachmentSweepSummary> {
  return await sweep(ctx);
}
