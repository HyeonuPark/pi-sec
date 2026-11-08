import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TERMINAL_JOB_STATUSES, type InboxItem } from "../../documents.ts";
import { PreferencesStore } from "../../prefs/store.ts";
import { apiError, json, type Router } from "../router.ts";
import type { AppDeps } from "../deps.ts";

/**
 * The prefix a revert queue entry uses when one press hid a group of items.
 *
 * The page writes it and the server reads it, so the rule is copied rather than
 * imported: web code is served to a browser and never runs here.
 */
const HIDE_GROUP_PREFIX = "hide-all:";

/** The item ids one queue entry stands for: an id, or a group's ids. */
function queueEntryIds(entry: string): string[] {
  if (!entry.startsWith(HIDE_GROUP_PREFIX)) return [entry];
  return entry
    .slice(HIDE_GROUP_PREFIX.length)
    .split(",")
    .filter((id) => id !== "");
}

/**
 * The items a request for visible ones keeps.
 *
 * An item the operator cleared off the list is still in the inbox, and the page
 * draws none of it. What it must still see is everything a revert button can
 * bring back, which is what `revertQueueInbox` holds: the last hides, each one
 * an id or a group of them. So a cleared item is dropped unless a queue entry
 * names it.
 */
function visibleOnly(items: readonly InboxItem[], clearedInbox: readonly string[], revertQueue: readonly string[]): InboxItem[] {
  const cleared = new Set(clearedInbox);
  if (cleared.size === 0) return [...items];
  const restorable = new Set<string>();
  for (const entry of revertQueue) for (const id of queueEntryIds(entry)) restorable.add(id);
  return items.filter((item) => !cleared.has(item.id) || restorable.has(item.id));
}

/**
 * The answer to whether this item is a notice about a report set aside as
 * `pending`.
 *
 * A pending report is one the operator asked not to be asked about yet, so its
 * notices stop raising the unread badge, which is the surface that asks for
 * attention. The item itself is untouched: it is the record of a report write,
 * and dropping or hiding it would be a claim that the write did not happen.
 *
 * The test is the same standing the report list shows, so the two surfaces cannot
 * disagree: the flag counts only while the report's job is live, because a notice
 * about a report whose job has finished is not quieted by a flag that has stopped
 * meaning anything.
 */
async function setAside(deps: AppDeps, item: InboxItem): Promise<boolean> {
  const reportId = item.source?.reportId;
  if (typeof reportId !== "string" || reportId === "") return false;
  const report = await deps.runtime.reports.get(BACKGROUND_CONTEXT, reportId);
  if (report === undefined || report.pendingAt === undefined) return false;
  const job = await deps.runtime.jobs.get(BACKGROUND_CONTEXT, report.jobId);
  return job !== undefined && !TERMINAL_JOB_STATUSES.includes(job.status);
}

export function registerInbox(router: Router, deps: AppDeps): void {
  router.get("/api/inbox", async (route) => {
    const unread = route.url.searchParams.get("unread") === "true";
    // `cleared=exclude` is the page asking for what it draws. Without it the
    // answer is every item, which is what a caller that wants the record gets.
    const excludeCleared = route.url.searchParams.get("cleared") === "exclude";
    let items = await deps.runtime.inbox.list(BACKGROUND_CONTEXT, { unread });
    if (excludeCleared) {
      const stored = await new PreferencesStore(deps.runtime.harness).read(BACKGROUND_CONTEXT);
      items = visibleOnly(items, stored.clearedInbox, stored.revertQueueInbox);
    }
    // `pending` is added only where it is true, so a caller reads it the way it
    // reads every other optional field on an item.
    const marked = await Promise.all(
      items.map(async (item) => ((await setAside(deps, item)) ? { ...item, pending: true } : item)),
    );
    json(route.res, 200, { items: marked });
  });

  router.post("/api/inbox/:id/read", async (route) => {
    const item = await deps.runtime.inbox.markRead(route.params["id"]!, BACKGROUND_CONTEXT);
    if (item === undefined) {
      apiError(route.res, 404, "not_found", "inbox item not found", route.requestId);
      return;
    }
    // Another window shows the same list, and its badge is only as fresh as this
    // event: without it the item stays unread there until something else arrives.
    deps.runtime.events.emit("inbox_item", item as unknown as Record<string, unknown>);
    json(route.res, 200, item);
  });
}
