import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { ensureContextFile, subagentContextBriefing } from "../agent/context-file.ts";
import { focusedChatTools } from "../agent/tool-profile.ts";
import { isModelSetupMode, MODEL_NOT_CONFIGURED_MESSAGE } from "../agent/model-setup.ts";
import { vmodelEntry } from "../agent/vmodel.ts";
import type { Config } from "../config/schema.ts";
import { SecAgent, SecAgentChild, SecAgentHub } from "../documents.ts";
import { CapacityError, SpawnHoldError, type SubagentHub } from "../extensions/subagents.ts";
import { createInboxItemTx } from "../extensions/notify.ts";
import { requireHarness, type EventsSink, type ExtensionContext } from "../extensions/context.ts";
import type { ReportStore } from "../reports/store.ts";
import type { AuditLog } from "../runtime/audit.ts";
import type { Paths } from "../runtime/paths.ts";
import type { FocusedChatRow, FocusedChatStore } from "./store.ts";

/**
 * The focused chats, as the rest of the system acts on them.
 *
 * One module owns what a focused chat is: opening one, archiving it, deleting
 * it, and the title it chooses for itself. The HTTP routes and the root's tools
 * both call these functions, so a route cannot create a chat the tools would not
 * recognize and a tool cannot archive one the routes would not show.
 *
 * A focused chat is a conversation like a subagent's: its own transcript, its own
 * `sec.agent` record, and an entry in the root's `sec.agentChild` index, so it
 * counts against the same slot limit and the root reaches it by name. Its own row
 * in `focused-chats.sqlite` says what the record cannot: whether the user still
 * has it open, what it is called, and whether it was deleted.
 */

/** The roles a focused chat always has, in this order. No setting names them. */
export const FOCUSED_CHAT_ROLES: readonly string[] = ["focused-chat", "user-facing-agent"];

/** The longest title, in characters, after trimming. */
export const FOCUSED_CHAT_TITLE_MAX = 80;

/** The body of the inbox notice that says a chat was opened. */
const OPENED_BODY = "Open it from this notice or from the Chats page.";

/** Why a focused chat action did not happen. The code reaches the HTTP answer. */
export type FocusedErrorCode =
  | "invalid_request"
  | "root_missing"
  | "model_not_configured"
  | "capacity"
  | "not_found"
  | "chat_deleted"
  | "chat_archived"
  | "report_refused"
  | "not_test_chat";

/** A refusal with a code the routes and the tools can tell apart. */
export class FocusedChatError extends Error {
  readonly code: FocusedErrorCode;
  readonly live: number | undefined;
  readonly limit: number | undefined;

  constructor(code: FocusedErrorCode, message: string, capacity?: { readonly live: number; readonly limit: number }) {
    super(message);
    this.name = "FocusedChatError";
    this.code = code;
    this.live = capacity?.live;
    this.limit = capacity?.limit;
  }
}

/** The HTTP status one refusal answers with. */
export function focusedStatusOf(code: FocusedErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "root_missing":
      return 503;
    case "model_not_configured":
    case "capacity":
    case "chat_archived":
    case "report_refused":
    case "not_test_chat":
      return 409;
    case "not_found":
    case "chat_deleted":
      return 404;
  }
}

/** What the caller of a focused chat action needs from the rest of the process. */
export interface FocusedDeps {
  readonly harness: Harness;
  readonly store: FocusedChatStore;
  readonly paths: Paths;
  readonly getConfig: () => Config;
  /** The parent edge and the slot counter. A chat cannot exist without it. */
  readonly hub: SubagentHub | undefined;
  readonly events: EventsSink;
  readonly audit: AuditLog;
  /** The reports a delete has to check for the user's approval. */
  readonly reports: ReportStore | undefined;
}

/** How a conversation number stands as a focused chat. */
export type FocusedChatLookup =
  | { readonly state: "open"; readonly row: FocusedChatRow }
  | { readonly state: "archived"; readonly row: FocusedChatRow }
  | { readonly state: "deleted" }
  | { readonly state: "none" };

/** Look one conversation number up among the focused chats. */
export function lookupFocusedChat(store: FocusedChatStore, conversationId: number): FocusedChatLookup {
  const row = store.get(conversationId);
  if (row !== undefined) return row.archivedAt === null ? { state: "open", row } : { state: "archived", row };
  return store.isDeleted(conversationId) ? { state: "deleted" } : { state: "none" };
}

/** What the bus carries when a focused chat changes. */
export type FocusedChatChange = "opened" | "titled" | "archived" | "deleted";

/**
 * The control event one change publishes.
 *
 * The page draws the topbar and the chat list from these, so the shape is the
 * whole of what a change says: which conversation, what it is called, when it
 * opened, whether it is archived, and which change it was. The web page depends
 * on exactly these fields.
 */
export function focusedChatEvent(row: FocusedChatRow, change: FocusedChatChange): Record<string, unknown> {
  return {
    conversationId: row.conversationId,
    name: row.name,
    title: row.title,
    openedAt: row.openedAt,
    archivedAt: row.archivedAt,
    change,
  };
}

/** Publish one change. Every write below ends here, so no surface misses one. */
export function publishFocusedChatChange(deps: FocusedDeps, row: FocusedChatRow, change: FocusedChatChange): void {
  deps.events.emit("focused_chat_updated", focusedChatEvent(row, change));
}

/**
 * A title from a caller, trimmed, or `null` when the caller gave none.
 *
 * The limit is counted after trimming, so a title of spaces is not a title and a
 * title of eighty characters is allowed but not one of eighty-one.
 */
export function parseFocusedTitle(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new FocusedChatError("invalid_request", "the title must be a string");
  }
  const title = value.trim();
  if (title === "") {
    throw new FocusedChatError("invalid_request", "the title must not be empty");
  }
  if (title.length > FOCUSED_CHAT_TITLE_MAX) {
    throw new FocusedChatError(
      "invalid_request",
      `the title is ${title.length} characters and the limit is ${FOCUSED_CHAT_TITLE_MAX}`,
    );
  }
  return title;
}

/**
 * The `test` flag of an open request, or `false` when the caller gave none.
 *
 * A value that is neither `true` nor `false` is refused rather than read as
 * "not a test": a caller that sends `"true"` or `1` means something by it, and
 * a chat that is silently filed as a normal one is worse than a 400.
 */
export function parseFocusedTest(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new FocusedChatError("invalid_request", "test must be true or false");
  }
  return value;
}

/** The subagent hub, or a refusal: a focused chat is a child of the root or nothing. */
function requireHub(deps: FocusedDeps): SubagentHub {
  if (deps.hub === undefined) {
    throw new FocusedChatError("invalid_request", "the subagents extension is not enabled, so there are no focused chats");
  }
  return deps.hub;
}

/**
 * Open one focused chat and return its row.
 *
 * The order is the answer to "what exists if this dies halfway":
 *
 *   1. the root conversation is read, and a store with no root opens nothing,
 *      because the parent edge would point at a conversation that is not there;
 *   2. the creating commit writes the slot count, the parent's name index, the
 *      agent record, the tool allow list and the state-file briefing, and the
 *      store row last, so the name comes from a row that exists;
 *   3. the context file is created after the commit, because a failed file must
 *      not lose a chat the user asked for;
 *   4. the inbox notice and the bus event come last, so no surface is told about
 *      a chat that is not yet readable.
 *
 * A failure inside the commit rolls the row back out again: the name index, the
 * record and the slot go with the commit, and only the store row is ours to drop.
 */
export async function openFocusedChat(
  deps: FocusedDeps,
  input: { readonly title?: unknown; readonly test?: unknown } = {},
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<FocusedChatRow> {
  const title = parseFocusedTitle(input.title);
  const test = parseFocusedTest(input.test);
  const hub = requireHub(deps);
  // Before the root lookup: setup mode has no root, and "send a message or
  // restart" is the wrong advice there.
  if (isModelSetupMode(deps.getConfig())) {
    throw new FocusedChatError("model_not_configured", MODEL_NOT_CONFIGURED_MESSAGE);
  }
  const root = await deps.harness.conversation(ROOT_CONVERSATION_ID, ctx);
  if (root === undefined) {
    throw new FocusedChatError(
      "root_missing",
      "the root conversation does not exist; send a message or restart the daemon",
    );
  }
  const config = deps.getConfig();
  const vmodelKey = config.agent.vmodel;
  const entry = vmodelEntry(config, vmodelKey);
  const vmodel = {
    model: { provider: entry.provider, modelId: entry.modelId },
    thinkingLevel: entry.thinkingLevel,
  };
  const tools = focusedChatTools(config.agent.focusedChat.extraTools);
  const openedAt = Date.now();
  // The store row is written inside the creating commit, and the name comes from
  // it, so this is the id its rollback has to drop — and only while the chat does
  // not exist yet. A failure after the commit must not take a real chat's row with
  // it, which is why `opened` is the guard the catch reads.
  let reserved: number | undefined;
  let opened: FocusedChatRow | undefined;
  try {
    const created = await hub.createChild(ctx, {
      kind: "focused",
      parentId: ROOT_CONVERSATION_ID,
      parentName: "operator",
      name: (conversationId) => {
        const row = deps.store.reserve({ conversationId: Number(conversationId), openedAt, title, test });
        reserved = row.conversationId;
        return row.name;
      },
      vmodelKey,
      vmodel,
      roles: FOCUSED_CHAT_ROLES,
      tools: { allow: tools },
      instructions: (conversationId) =>
        subagentContextBriefing(deps.paths, conversationId, "the root agent"),
      initialStatus: "waiting",
      // The user is the person opening this chat, so the four-fifths hold, which
      // exists to make an agent ask a person first, has nothing to ask.
      holdAtFourFifths: false,
    });
    const row = deps.store.get(Number(created.conversationId));
    if (row === undefined) throw new Error("the focused chat row disappeared while it was opened");
    opened = row;
    // The file exists before the chat's first request, so the briefing it was
    // handed never names a file that is not there yet. A failed file does not lose
    // a chat the user asked for: the chat is alive and can rewrite its notebook.
    await ensureContextFile(deps.paths, String(created.conversationId)).catch(() => undefined);
    // A failed notice does not undo a chat that exists and holds a slot.
    await announceOpened(deps, row, ctx).catch((error: unknown) => {
      deps.audit.append({
        type: "focused_chat_open_notice_failed",
        conversationId: String(row.conversationId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    deps.audit.append({
      type: "focused_chat_opened",
      conversationId: String(row.conversationId),
      name: row.name,
    });
    publishFocusedChatChange(deps, row, "opened");
    return row;
  } catch (error) {
    if (opened === undefined && reserved !== undefined) deps.store.discard(reserved);
    if (error instanceof CapacityError) {
      throw new FocusedChatError(
        "capacity",
        `the subagent limit is full (${error.live}/${error.limit}), so no chat was opened`,
        { live: error.live, limit: error.limit },
      );
    }
    if (error instanceof SpawnHoldError) {
      throw new FocusedChatError(
        "capacity",
        `the subagent slots are four fifths full (${error.live}/${error.limit}), so no chat was opened`,
        { live: error.live, limit: error.limit },
      );
    }
    throw error;
  }
}

/**
 * Tell the user, in the inbox, that a chat is open.
 *
 * The notice is the only way back to a chat the user opened and then lost the
 * address of, so it names the title it has and carries the conversation id the
 * page opens from.
 */
async function announceOpened(deps: FocusedDeps, row: FocusedChatRow, ctx: Context): Promise<void> {
  const item = await deps.harness.commit(
    (tx: Tx) =>
      createInboxItemTx(tx, {
        kind: "focused_chat",
        title: `Focused chat opened: ${row.title ?? "Untitled"}`,
        body: OPENED_BODY,
        conversationId: String(row.conversationId),
      }),
    ctx,
  );
  deps.events.emit("inbox_item", item as unknown as Record<string, unknown>);
}

/** One chat's answer shape for `GET /api/focused-chats/:id`. */
export interface FocusedChatView {
  readonly conversationId: number;
  readonly name: string;
  readonly title: string | null;
  readonly openedAt: number;
  readonly archived: boolean;
  readonly archivedAt: number | null;
  /** Whether this chat was opened as a test chat. Only the chats list reads it. */
  readonly test: boolean;
}

export function focusedChatView(row: FocusedChatRow): FocusedChatView {
  return {
    conversationId: row.conversationId,
    name: row.name,
    title: row.title,
    openedAt: row.openedAt,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    test: row.test,
  };
}

/**
 * The user's title change, from the web page.
 *
 * A chat that is archived keeps the title it had: the list is a record of what
 * the chat was, and a record that renames itself after it ends is not one. The
 * page cannot reach this case through its own controls, so reaching it means a
 * caller made a mistake, and it is refused rather than accepted quietly.
 */
export function setFocusedChatTitle(
  deps: FocusedDeps,
  conversationId: number,
  value: unknown,
): FocusedChatRow {
  const title = parseFocusedTitle(value);
  if (title === null) throw new FocusedChatError("invalid_request", "the title must not be empty");
  const found = lookupFocusedChat(deps.store, conversationId);
  if (found.state === "deleted") throw new FocusedChatError("chat_deleted", "this focused chat was deleted");
  if (found.state === "none") throw new FocusedChatError("not_found", "this conversation is not a focused chat");
  if (found.state === "archived") {
    throw new FocusedChatError("chat_archived", "this focused chat is archived, so its title no longer changes");
  }
  // Unconditional over an open chat: this is the user renaming their own chat.
  deps.store.setTitle(conversationId, title);
  const row = deps.store.get(conversationId);
  if (row === undefined) throw new FocusedChatError("not_found", "this conversation is not a focused chat");
  publishFocusedChatChange(deps, row, "titled");
  return row;
}

/**
 * How long an archive or a delete waits for the run in flight to stop.
 *
 * The same grace `subagent_delete` takes: the run may be half way through a tool
 * call, and its own abort has to reach a boundary before the status below says it
 * is over.
 */
const ABORT_GRACE_MS = 10_000;

/** Stop whatever this chat is running, and wait a bounded time for it to stop. */
async function stopRun(deps: FocusedDeps, conversationId: number, ctx: Context): Promise<void> {
  const conversation = await deps.harness.conversation(conversationId as ConversationId, ctx);
  if (conversation === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conversation.abort(ctx, { background: true }).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ABORT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Take a chat off the root's index and give its slot back.
 *
 * The record is the caller's decision: an archive keeps it, because the kind and
 * the name have to survive the chat, and a delete retires it, because nothing
 * should point at the conversation afterwards. One commit writes both, so the
 * name cannot stay taken after the record is gone.
 */
async function retireChild(
  deps: FocusedDeps,
  input: {
    readonly conversationId: number;
    readonly name: string;
    readonly holdsSlot: boolean;
    readonly retireRecord: boolean;
  },
  ctx: Context,
): Promise<void> {
  await deps.harness.commit(async (tx: Tx) => {
    await tx.retireDoc(SecAgentChild, ROOT_CONVERSATION_ID, input.name);
    if (input.retireRecord) await tx.retireDoc(SecAgent, String(input.conversationId));
    if (input.holdsSlot) {
      const counter = await tx.doc(SecAgentHub);
      counter.live = Math.max(0, counter.live - 1);
    }
  }, ctx);
}

/**
 * Archive one open focused chat.
 *
 * The record stays, because the kind has to stay answerable: after this the chat
 * is `stopped` with the note `archived`, its transcript is readable, and the page
 * shows it under the archived chats. The parent's name index goes, so the root
 * can no longer reach it by name, and the slot goes back, so an archived chat
 * costs nothing.
 *
 * The permission to archive is the user's, and it is the prompt's rule, not this
 * function's: the tool says so and the root asks.
 */
export async function archiveFocusedChat(
  deps: FocusedDeps,
  conversationId: number,
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<FocusedChatRow> {
  const hub = requireHub(deps);
  const found = lookupFocusedChat(deps.store, conversationId);
  if (found.state === "deleted") throw new FocusedChatError("chat_deleted", "this focused chat was deleted");
  if (found.state === "none") throw new FocusedChatError("not_found", "this conversation is not a focused chat");
  if (found.state === "archived") {
    // An archive that failed after the store write left its name on the root's
    // index. A second call finishes the steps that are left. When the index no
    // longer holds this chat, the archive was complete and the call is refused.
    if (!(await indexHolds(deps, found.row.name, conversationId, ctx))) {
      throw new FocusedChatError("chat_archived", "this focused chat is already archived");
    }
    return await finishArchive(deps, hub, found.row, ctx);
  }

  await stopRun(deps, conversationId, ctx);
  const row = deps.store.archive(conversationId, Date.now());
  if (row === undefined) throw new FocusedChatError("chat_archived", "this focused chat is already archived");
  await hub.setStatus(ctx, conversationId as ConversationId, "stopped", { note: "archived", endedAt: Date.now() });
  await retireChild(deps, { conversationId, name: row.name, holdsSlot: true, retireRecord: false }, ctx);
  deps.audit.append({ type: "focused_chat_archived", conversationId: String(conversationId), name: row.name });
  publishFocusedChatChange(deps, row, "archived");
  return row;
}

/** Whether the root's name index still holds this chat under its name. */
async function indexHolds(deps: FocusedDeps, name: string, conversationId: number, ctx: Context): Promise<boolean> {
  const entry = await deps.harness.snapshot(SecAgentChild, ROOT_CONVERSATION_ID, name, ctx);
  return entry !== undefined && entry.conversationId === String(conversationId);
}

/**
 * The steps of an archive after the store write, for a second call.
 *
 * It never gives the slot back. The first call did not get that far, and the
 * sweep of the subagent hub counts the slots again from the store row, which
 * already says archived. Lowering the counter here would count one slot too few.
 */
async function finishArchive(
  deps: FocusedDeps,
  hub: NonNullable<FocusedDeps["hub"]>,
  row: FocusedChatRow,
  ctx: Context,
): Promise<FocusedChatRow> {
  const { conversationId } = row;
  const record = await deps.harness.snapshot(SecAgent, String(conversationId), ctx);
  // The status call is a no-op when the record already says stopped with this note.
  if (record !== undefined) {
    await hub.setStatus(ctx, conversationId as ConversationId, "stopped", { note: "archived", endedAt: Date.now() });
  }
  await retireChild(deps, { conversationId, name: row.name, holdsSlot: false, retireRecord: false }, ctx);
  deps.audit.append({ type: "focused_chat_archived", conversationId: String(conversationId), name: row.name });
  publishFocusedChatChange(deps, row, "archived");
  return row;
}

/** Whether the text holds the number as a whole number: no digit touches it. */
function namesNumber(text: string, conversationId: number): boolean {
  return new RegExp(`(?<![0-9])${conversationId}(?![0-9])`).test(text);
}

/**
 * The approval a delete needs, checked against the report itself.
 *
 * Two facts have to hold, and both are read from the store rather than taken
 * from the caller: the newest revision carries an approval, that approval names
 * the revision's own hash, and the revision's text names this conversation
 * number. A later revision voids the approval by existing, which is exactly the
 * rule the report viewer already follows.
 */
async function requireApprovalNaming(
  deps: FocusedDeps,
  conversationId: number,
  reportId: string,
  ctx: Context,
): Promise<void> {
  if (deps.reports === undefined) {
    throw new FocusedChatError("report_refused", "the reports extension is not enabled, so nothing can be approved");
  }
  const report = await deps.reports.getAny(ctx, reportId);
  if (report === undefined) {
    throw new FocusedChatError("report_refused", `no report with id ${reportId}`);
  }
  const newest = report.versions.at(-1);
  if (newest === undefined) {
    throw new FocusedChatError("report_refused", `report ${reportId} has no revision`);
  }
  const approval = newest.approval;
  if (approval === undefined || approval.sha256 !== newest.sha256) {
    throw new FocusedChatError(
      "report_refused",
      `the newest revision of report ${reportId} (v${newest.n}) is not the revision the user approved`,
    );
  }
  const text = await deps.reports.readVersion(report.id, newest.n);
  if (text === undefined) {
    throw new FocusedChatError("report_refused", `the body of report ${reportId} v${newest.n} could not be read`);
  }
  if (!namesNumber(text, conversationId)) {
    throw new FocusedChatError(
      "report_refused",
      `the approved revision of report ${reportId} does not name conversation ${conversationId}`,
    );
  }
}

/**
 * Delete one focused chat, if the user approved a report that names it.
 *
 * A test that opens a chat leaves it behind, and nothing but this removes one: an
 * agent deleting a conversation the user reads would be exactly the kind of write
 * a design rule keeps away from agents. So the permission is the user's approval of
 * a report revision, and that revision has to name this conversation in its own
 * words.
 *
 * The transcript stays: the transcript store has no delete, and the row moves to
 * a tombstone so every route can still say the chat was deleted rather than never
 * existing.
 */
export async function deleteFocusedChat(
  deps: FocusedDeps,
  input: { readonly conversationId: number; readonly reportId: string },
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<FocusedChatRow> {
  const hub = requireHub(deps);
  const { conversationId, reportId } = input;
  const found = lookupFocusedChat(deps.store, conversationId);
  if (found.state === "deleted") {
    // A delete that failed after the store write left the agent record and the
    // name on the index. A second call finishes it. When the record is gone, the
    // delete was complete and the call is refused.
    const record = await deps.harness.snapshot(SecAgent, String(conversationId), ctx);
    if (record === undefined || record.kind !== "focused") {
      throw new FocusedChatError("chat_deleted", "this focused chat was deleted");
    }
    await requireApprovalNaming(deps, conversationId, reportId, ctx);
    // The slot counter is not lowered: the sweep of the subagent hub corrects it.
    await retireChild(deps, { conversationId, name: record.name, holdsSlot: false, retireRecord: true }, ctx);
    deps.audit.append({
      type: "focused_chat_deleted",
      conversationId: String(conversationId),
      name: record.name,
      reportId,
    });
    // The row is gone from the store, so the title is not known any more.
    const finished: FocusedChatRow = {
      seq: 0,
      conversationId,
      name: record.name,
      title: null,
      openedAt: record.createdAt,
      archivedAt: null,
      test: true,
    };
    publishFocusedChatChange(deps, finished, "deleted");
    return finished;
  }
  if (found.state === "none") throw new FocusedChatError("not_found", "this conversation is not a focused chat");

  if (!found.row.test) {
    throw new FocusedChatError("not_test_chat", "this focused chat was not opened for a test, so it cannot be deleted");
  }

  await requireApprovalNaming(deps, conversationId, reportId, ctx);

  // An archived chat already gave its slot back, so only an open one takes one.
  const wasOpen = found.row.archivedAt === null;
  await stopRun(deps, conversationId, ctx);
  const row = deps.store.delete(conversationId, Date.now());
  if (row === undefined) throw new FocusedChatError("not_found", "this conversation is not a focused chat");
  if (wasOpen) {
    await hub.setStatus(ctx, conversationId as ConversationId, "stopped", { note: "deleted", endedAt: Date.now() });
  }
  await retireChild(deps, { conversationId, name: row.name, holdsSlot: wasOpen, retireRecord: true }, ctx);
  deps.audit.append({
    type: "focused_chat_deleted",
    conversationId: String(conversationId),
    name: row.name,
    reportId,
  });
  publishFocusedChatChange(deps, row, "deleted");
  return row;
}

/**
 * What a focused chat action needs, read from the extension context.
 *
 * The tools and the routes build this the same way, so a route cannot act on a
 * store the tools do not use.
 */
export function focusedDepsOf(context: ExtensionContext): FocusedDeps {
  const store = context.focusedChats;
  if (store === undefined) throw new Error("the focused chat store is not available yet");
  return {
    harness: requireHarness(context),
    store,
    paths: context.paths,
    getConfig: context.getConfig,
    hub: context.subagents,
    events: context.events,
    audit: context.audit,
    reports: context.reports,
  };
}
