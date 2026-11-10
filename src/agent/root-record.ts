import type { Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Harness } from "@earendil-works/pi-durable";
import type { Config } from "../config/schema.ts";
import { SecAgent } from "../documents.ts";

/**
 * The root agent's record, kept in step with the configuration.
 *
 * The root's vmodel and roles come from `config.agent`, and every other
 * conversation's come from its spawn call. The record is what the prompt
 * sections actually read, so it has to agree with the configuration, and it had
 * one way to fall out of agreement: it was written once, at the first boot, and
 * never looked at again. An operator who changed `agent.roles` afterwards got a
 * configuration that said one thing and a root agent that did another, with
 * nothing to point at the difference.
 *
 * The record is synced at boot and after a configuration reload, and never on
 * a read: each is a single event off the request path, and a read would put a
 * write on every request. Changing roles still reaches only the next session,
 * because the prompt sections are sealed, so a reload changes the record under a
 * running session in the same way a boot does.
 *
 * `absent` is an ordinary answer, not a failure: the daemon prepares the root
 * conversation at boot before this sync runs, so `absent` means that preparation
 * failed, and the first write route creates it.
 */
export type RootRecordSync = "created" | "updated" | "unchanged" | "absent";

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function syncRootRecord(harness: Harness, config: Config, context: Context): Promise<RootRecordSync> {
  if ((await harness.conversation(ROOT_CONVERSATION_ID, context)) === undefined) return "absent";

  const key = String(ROOT_CONVERSATION_ID);
  const current = await harness.snapshot(SecAgent, key, context);

  if (current === undefined) {
    const now = Date.now();
    await harness.commit(async (tx) => {
      const record = await tx.doc(SecAgent, key, key);
      record.kind = "root";
      record.name = "operator";
      record.vmodel = config.agent.vmodel;
      record.roles = [...config.agent.roles];
      record.status = "running";
      record.createdAt = now;
      record.updatedAt = now;
    }, context);
    return "created";
  }

  if (current.vmodel === config.agent.vmodel && sameList(current.roles, config.agent.roles)) return "unchanged";

  await harness.commit(async (tx) => {
    const record = await tx.doc(SecAgent, key, key);
    record.vmodel = config.agent.vmodel;
    record.roles = [...config.agent.roles];
    record.updatedAt = Date.now();
  }, context);
  return "updated";
}
