import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type Storage,
} from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../agent/harness.ts";
import { DOC_KINDS, SecAgent, type JobRecord } from "../documents.ts";
import type { ExtensionContext } from "../extensions/context.ts";
import { newestEntryId, snapshotOf, translateView, type AgentEvent, type SnapshotEvent } from "./conversation-events.ts";
import type { JobNode } from "../jobs/registry.ts";
import { legacyListProblem } from "../jobs/routine-migration.ts";
import type { EventBus } from "../runtime/event-bus.ts";
import { API_VERSION } from "./deps.ts";
import { attachmentContext } from "./routes/attachments.ts";
import {
  attachmentDescriptors,
  attachmentLookup,
  type AttachmentDescriptors,
  type AttachmentLookup,
} from "./routes/basic-chat.ts";
import type { RouteContext } from "./router.ts";
import type { SseChannel, SseHub } from "./sse.ts";
import { slimAgentEvent, slimSnapshot } from "./stream-entries.ts";
import { hasEntriesBefore } from "./routes/history.ts";

/**
 * One stream frame with the attachment descriptors its entries name.
 *
 * The page draws a message's files on the first render and asks nothing else,
 * so the frame that carries an entry also carries what each of its attachment
 * ids is. Only the three entry-bearing frames are touched: `snapshot` carries
 * every visible entry, and `entry_appended` and `message_end` each carry one.
 * Every other frame gets no descriptors, but it is slimmed like the rest:
 * `message_start`, `tool_execution_end` and `tool_execution_update` can lose
 * fields there, and any other frame passes through unchanged.
 *
 * The entries are slimmed first (see `stream-entries.ts`), so the resume buffer
 * replays slim frames as well. Slimming keeps every block that carries an
 * attachment envelope: those ride on message text, which is never trimmed.
 */
async function withAttachments(
  deps: StreamDeps,
  conversationId: number,
  raw: AgentEvent,
): Promise<AgentEvent | (AgentEvent & { attachments: AttachmentDescriptors; hasEarlier?: boolean })> {
  const event = slimAgentEvent(raw);
  if (event.type !== "snapshot" && event.type !== "entry_appended" && event.type !== "message_end") return event;
  const lookup = attachmentLookupOf(deps);
  if (event.type === "snapshot") {
    return {
      ...event,
      attachments: await attachmentDescriptors(event.entries, lookup),
      hasEarlier: await hasEarlierEntry(deps, conversationId, event),
    };
  }
  return { ...event, attachments: await attachmentDescriptors([event.entry], lookup) };
}

/** The attachment store, read through the runtime this stream already holds. */
function attachmentLookupOf(deps: StreamDeps): AttachmentLookup {
  return attachmentLookup(attachmentContext(deps));
}

/**
 * The smallest entry id a snapshot carries, or `undefined` for an empty one.
 *
 * Not the first entry's id: the durable layer puts a head marker at the front of
 * the active context, and a compaction's marker carries an id above the entries
 * it keeps. The smallest id is the place the page has to walk back from, so it is
 * the one read here.
 */
function firstEntryId(view: SnapshotEvent): number | undefined {
  let smallest: number | undefined;
  for (const entry of view.entries) {
    const id = (entry as { readonly id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (smallest === undefined || id < smallest) smallest = id;
  }
  return smallest;
}

/**
 * Whether the conversation stores anything before the smallest entry this
 * snapshot carries.
 *
 * The frame says so on the first paint, because a page that read it afterwards
 * would grow a row above the reader and push what they were reading down. An
 * entry that cannot be read or a store that cannot answer both say `false`, and
 * the page then draws no button: the transcript it does draw is what matters,
 * and the button comes back with the next snapshot.
 *
 * The walk asks whether one entry exists before that id, which is one bounded
 * store read with no entry loaded beyond the first.
 */
async function hasEarlierEntry(deps: StreamDeps, conversationId: number, view: SnapshotEvent): Promise<boolean> {
  const id = firstEntryId(view);
  if (id === undefined) return false;
  try {
    const conversation = await deps.runtime.harness.conversation(
      conversationId as Parameters<typeof deps.runtime.harness.conversation>[0],
      BACKGROUND_CONTEXT,
    );
    if (conversation === undefined) return false;
    return await hasEntriesBefore(conversation, id as Parameters<typeof hasEntriesBefore>[1]);
  } catch {
    return false;
  }
}

/**
 * pi-sec control events carried on the conversation stream, beside the agent's own.
 *
 * Exported so a test can pin the set: a frame a page needs but this set omits is
 * silently dropped, and nothing else in the server would notice.
 */
export const CONTROL_EVENTS = new Set([
  "job_created",
  "job_updated",
  "inbox_item",
  "report_created",
  "report_updated",
  "report_feedback",
  "user_query",
  "user_query_resolved",
  "sections_stale",
  // A focused chat was opened, titled, archived or deleted. The page's topbar and
  // its chat list read this one event, so the shape it carries is a contract.
  "focused_chat_updated",
  "notice",
  "restart_required",
  "restart_withdrawn",
  "extension_reloaded",
  // A card event, fanned out to the page so `ui-cards.js` can dispatch it to the
  // card that asked for it.
  "ui_event",
  // A remote machine's level, link state or block changed. The Machines panel
  // re-reads its list, which is one route for every one of those changes.
  "remote_machine_updated",
  // The providers that hold conversations for a usage limit changed: a hold
  // began, a provider recovered, or a resumed conversation was held again. The
  // banner re-reads `/api/admin/status`, which is the only answer it draws from.
  "usage_hold_changed",
  // The shared UI state (theme, folds, cleared lists) changed. The frame carries
  // only the revision, and the page reads `GET /api/preferences` back.
  "preferences_updated",
]);

/** One agent that is running on a job right now. */
export type JobWorker = {
  readonly conversationId: string;
  readonly name: string;
};

/** One job with the derived list attached. `working` empty means nobody is on it. */
export type WorkingJob = JobRecord & { readonly working: readonly JobWorker[] };

/** A job tree whose every node carries the derived list. */
export type WorkingNode = { readonly job: WorkingJob; readonly children: WorkingNode[] };

/**
 * Who is running on these jobs right now, read-only.
 *
 * No job status is written here and none is read as an answer: a job with a worker
 * on it keeps whatever status it holds (`planned` included), and "somebody is on
 * it" is derived per read instead of stored.
 *
 * The join is the agent's own `jobId` or `forJobId`, not the job's
 * `conversationId`. A job's `conversationId` defaults to the conversation that
 * created it, so joining on it would mark every job the root ever created as
 * working whenever the root is busy. Both fields are links to a job by the agent:
 * `jobId` is the handover, which moves the job's owner to the agent, and
 * `forJobId` is the same statement without the handover, which is what a planner
 * or a worker started for one job carries. An agent can hold both, though a
 * spawn refuses to give both, and each field is joined on its own.
 *
 * Liveness is `pi.live.run`, which exists exactly while the harness is driving that
 * conversation. The cheaper signals over-report. An agent document is enough to
 * say "not retired", but a record left behind by a killed process is
 * indistinguishable from a live one, and its `status` is `waiting` both for a
 * healthy agent parked on `await_orders` and for one that died. A parked worker
 * therefore reads as not working here, which is the safe direction: a marker that
 * appears for finished work costs more than a marker that waits for work to start.
 *
 * A missing entry and an empty list both mean nobody is working on that job. A
 * store that cannot answer is reported the same way: the job rows matter more than
 * the marker.
 */
export async function jobWorkers(
  runtime: AgentRuntime,
  jobIds: Iterable<string>,
): Promise<Map<string, JobWorker[]>> {
  const wanted = new Set(jobIds);
  const workers = new Map<string, JobWorker[]>();
  if (wanted.size === 0) return workers;
  try {
    for (const conversationId of await agentConversationIds(runtime)) {
      const record = await runtime.harness.snapshot(SecAgent, conversationId, BACKGROUND_CONTEXT);
      if (record === undefined) continue;
      const linked = [record.jobId, record.forJobId].filter(
        (id): id is string => id !== undefined && wanted.has(id),
      );
      if (linked.length === 0) continue;
      if (!(await isDriving(runtime, conversationId))) continue;
      const worker = { conversationId, name: record.name };
      for (const jobId of new Set(linked)) {
        const list = workers.get(jobId);
        if (list === undefined) workers.set(jobId, [worker]);
        else list.push(worker);
      }
    }
  } catch {
    // "Which agents exist" is not worth failing the job list over.
  }
  return workers;
}

/**
 * The sub-agents under one conversation that are working right now, read-only.
 *
 * A reset empties the conversation's context, so the agent that resets it forgets
 * how the work of its sub-agents stands. This reads the two facts a reset needs
 * before it happens: which agents are below this conversation, and which of them
 * are being driven right now.
 *
 * Every descendant counts, not only a direct child: an orchestrator that waits
 * for orders can have a worker under it that is working, and that worker is the
 * work the reset would lose track of. So each record's parent chain is walked up
 * to the conversation, and a chain that loops back on itself stops there.
 *
 * Only `kind` `subagent` counts. The root and a scheduled run are not work under
 * this conversation, and any kind added later is not counted until it is named
 * here.
 *
 * Working is the same test `jobWorkers` uses: a `pi.live.run` exists, so an agent
 * that waits for orders is not working, and its working descendants still are.
 *
 * A store that cannot answer reads as no working agent, the same direction
 * `jobWorkers` takes: a reset must not be blocked by a failed read.
 */
export async function workingSubagents(
  runtime: AgentRuntime,
  conversationId: string,
): Promise<JobWorker[]> {
  const working: JobWorker[] = [];
  try {
    const parents = new Map<string, string | undefined>();
    const records = new Map<string, { readonly name: string; readonly kind: string }>();
    for (const id of await agentConversationIds(runtime)) {
      const record = await runtime.harness.snapshot(SecAgent, id, BACKGROUND_CONTEXT);
      if (record === undefined) continue;
      parents.set(id, record.parentConversationId);
      records.set(id, { name: record.name, kind: record.kind });
    }
    for (const [id, record] of records) {
      if (record.kind !== "subagent") continue;
      if (!descendsFrom(parents, id, conversationId)) continue;
      if (!(await isDriving(runtime, id))) continue;
      working.push({ conversationId: id, name: record.name });
    }
  } catch {
    // "Which agents are working" is not worth failing a reset over.
  }
  return working;
}

/** Whether the parent chain of `id` reaches `ancestor` in the loaded tree. */
function descendsFrom(
  parents: ReadonlyMap<string, string | undefined>,
  id: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>([id]);
  let current = parents.get(id);
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

/**
 * The 409 body both reset routes send while sub-agents are working.
 *
 * The `error` object has the shape `apiError` writes, and the working agents ride
 * beside it so a caller can name them without a second request.
 */
export function agentsWorkingRefusal(
  working: readonly JobWorker[],
  requestId: string,
): {
  error: { code: string; message: string; requestId: string };
  agents: { conversationId: string; name: string }[];
} {
  return {
    error: {
      code: "agents_working",
      message: working.length === 1 ? "1 sub-agent is working" : `${working.length} sub-agents are working`,
      requestId,
    },
    agents: working.map((agent) => ({ conversationId: agent.conversationId, name: agent.name })),
  };
}

/** Attach the derived list to one job record. */
export function withWorking(job: JobRecord, workers: ReadonlyMap<string, readonly JobWorker[]>): WorkingJob {
  return { ...job, working: workers.get(job.id) ?? [] };
}

/** Attach the derived list to every node of a job tree. */
export function withWorkingTree(
  nodes: readonly JobNode[],
  workers: ReadonlyMap<string, readonly JobWorker[]>,
): WorkingNode[] {
  return nodes.map((node) => ({
    job: withWorking(node.job, workers),
    children: withWorkingTree(node.children, workers),
  }));
}

/**
 * The legacy schedule list that is no longer read, as both job surfaces report it.
 *
 * A `config.scheduler.jobs` that is still populated after the boot migration is an
 * operator editing a file that decides nothing: the records are the schedule, and
 * the list is ignored. The page shows those names in a banner, so both the list
 * route and the first job snapshot carry the same field: a snapshot that omitted
 * it would clear the banner on every reconnect.
 *
 * The answer is cached against the config object itself. `legacyListProblem`
 * records what it ignored, an audit row and the state file, so calling it per
 * request would write a row per page load. A reload replaces the config object,
 * which is exactly when the answer can change.
 */
const legacyProblemByConfig = new WeakMap<object, string | null>();

export async function legacyScheduleProblem(runtime: AgentRuntime): Promise<string | null> {
  const config = runtime.getConfig();
  const cached = legacyProblemByConfig.get(config);
  if (cached !== undefined) return cached;
  // The helper takes the extension context, which the runtime keeps to itself; it
  // reads these five fields and nothing else.
  const context = {
    getConfig: () => runtime.getConfig(),
    paths: runtime.paths,
    logger: runtime.logger,
    audit: runtime.audit,
    events: runtime.events,
  } as unknown as ExtensionContext;
  const problem = (await legacyListProblem(context)) ?? null;
  legacyProblemByConfig.set(config, problem);
  return problem;
}

/** Every job id in a tree, for one `jobWorkers` call. */
export function jobTreeIds(nodes: readonly JobNode[]): string[] {
  return nodes.flatMap((node) => [node.job.id, ...jobTreeIds(node.children)]);
}

/**
 * Every live `sec.agent` key. The family has no enumerating API of its own, so the
 * same paged scan the job registry uses is the precedent to follow.
 */
async function agentConversationIds(runtime: AgentRuntime): Promise<string[]> {
  const keys: string[] = [];
  let cursor: Parameters<Storage["scanDocuments"]>[2];
  for (;;) {
    const page = await runtime.storage.scanDocuments(
      { scope: { kind: "session" }, at: "current", kind: DOC_KINDS.agent },
      500,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return keys;
}

/** Whether the harness is driving that conversation right now. */
async function isDriving(runtime: AgentRuntime, conversationId: string): Promise<boolean> {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    const live = await runtime.harness.snapshot(LiveDoc, id as ConversationId, BACKGROUND_CONTEXT);
    return live?.run !== undefined;
  } catch {
    return false;
  }
}

/** What a stream needs from the app; narrower than `AppDeps`, so there is no cycle. */
export interface StreamDeps {
  readonly runtime: AgentRuntime;
  readonly bus: EventBus;
  readonly sse: SseHub;
}

/**
 * One endpoint's events, fanned out to every attached client.
 *
 * A window is a *reader*, never a source. The upstream watch belongs to the
 * endpoint: attaching per connection makes every connection a publisher, so each
 * event is published once per open window and every client renders the same run
 * again for each other window that is attached. It also multiplies the resume
 * buffer and re-subscribes the control-event bus per connection.
 */
class ConversationStream {
  #refs = 0;
  #watch: ConversationWatch | undefined;
  /** The view revision the last frames were built from. */
  #last: ConversationView | undefined;
  /** The newest entry id already sent, in the snapshot or in a frame. */
  #sent = 0;
  #starting: Promise<SnapshotEvent | undefined> | undefined;
  #unsubscribe: (() => void) | undefined;
  #paused = false;
  #held: (() => void)[] = [];
  #attaching: Promise<unknown> = Promise.resolve();

  private readonly deps: StreamDeps;
  readonly channel: SseChannel;
  private readonly conversationId: number;

  constructor(deps: StreamDeps, channel: SseChannel, conversationId: number) {
    this.deps = deps;
    this.channel = channel;
    this.conversationId = conversationId;
  }

  get attached(): number {
    return this.#refs;
  }

  get running(): boolean {
    return this.#watch !== undefined;
  }

  /** Attaches are serialized, so two windows opening at once cannot snapshot at once. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#attaching.then(task, task);
    this.#attaching = next.catch(() => undefined);
    return next;
  }

  /**
   * Hold publications while a snapshot is taken. The snapshot and the frame
   * stream have to tile exactly: everything published before the hold is already
   * in the snapshot, and everything published during it must reach the joining
   * client afterwards, with its frame ID assigned then.
   */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    const held = this.#held;
    this.#held = [];
    for (const publish of held) publish();
  }

  publish(event: string, data: unknown): void {
    if (this.#paused) {
      this.#held.push(() => this.channel.publish(event, data));
      return;
    }
    this.channel.publish(event, data);
  }

  retain(): void {
    this.#refs += 1;
  }

  release(): void {
    if (this.#refs > 0) this.#refs -= 1;
    if (this.#refs === 0) void this.#stop();
  }

  /** Start the single upstream watch, or return the snapshot it started with. */
  async start(): Promise<SnapshotEvent | undefined> {
    if (this.#watch !== undefined) return undefined;
    if (this.#starting === undefined) this.#starting = this.#begin();
    const starting = this.#starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  /** The current view, for a client that joins while the stream is already running. */
  async view(): Promise<SnapshotEvent> {
    const attached = await this.#attach();
    try {
      return attached.snapshot;
    } finally {
      await attached.watch.stop();
    }
  }

  /**
   * Attach a watch of the conversation and build the snapshot frame from it: the
   * active context's entries, and the documents of the view the watch starts with.
   */
  async #attach(): Promise<{ watch: ConversationWatch; snapshot: SnapshotEvent; sent: number }> {
    const conversation = await this.deps.runtime.harness.conversation(this.#id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`conversation ${this.conversationId} does not exist`);
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    try {
      // Read after the watch is attached, so an entry committed in between is in the
      // snapshot and in no later frame: a frame carries only entries above `sent`.
      const context = await conversation.context(BACKGROUND_CONTEXT);
      const sent = newestEntryId(context.entries, newestEntryId(watch.value.entries));
      return { watch, snapshot: snapshotOf(watch.value, context.entries), sent };
    } catch (error) {
      await watch.stop();
      throw error;
    }
  }

  get #id(): ConversationId {
    return this.conversationId as ConversationId;
  }

  async #begin(): Promise<SnapshotEvent | undefined> {
    const attached = await this.#attach();
    const watch = attached.watch;
    // Every client left while the watch was attaching: stop it again instead of
    // leaving an unread view attachment behind.
    if (this.#refs === 0) {
      await watch.stop();
      return undefined;
    }
    this.#watch = watch;
    this.#last = watch.value;
    this.#sent = attached.sent;
    this.#unsubscribe = this.deps.bus.subscribe((event) => {
      if (CONTROL_EVENTS.has(event.type)) this.publish(event.type, event.data);
    });
    watch.start(async (call) => {
      if (call.kind !== "value" || this.#last === undefined) return;
      // A revision folds the commits made while the last one was delivered, so the
      // frames below describe the change from the revision before it.
      const { events, newest } = translateView(this.#last, call.value, this.#sent);
      this.#last = call.value;
      this.#sent = newest;
      for (const event of events) {
        this.publish(event.type, await withAttachments(this.deps, this.conversationId, event));
      }
    });
    return attached.snapshot;
  }

  /** Drop this endpoint entirely, whatever the number of attached clients. */
  async shutdown(): Promise<void> {
    this.#refs = 0;
    await this.#stop();
  }

  async #stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const watch = this.#watch;
    this.#watch = undefined;
    this.#last = undefined;
    if (watch !== undefined) await watch.stop();
  }
}

/** The fan-out for every streaming endpoint. */
export class StreamHub {
  readonly #conversations = new Map<number, ConversationStream>();
  #jobChannel: SseChannel | undefined;
  #jobUnsubscribe: (() => void) | undefined;
  #focusedChatChannel: SseChannel | undefined;
  #focusedChatUnsubscribe: (() => void) | undefined;

  private readonly deps: StreamDeps;

  constructor(deps: StreamDeps) {
    this.deps = deps;
  }

  /** Attach one more client to a conversation's events. */
  async attachConversation(route: RouteContext, conversationId: number): Promise<void> {
    const stream = this.#conversation(conversationId);
    await stream.exclusive(async () => {
      stream.pause();
      try {
        // An idle endpoint has no live upstream, so the resume buffer cannot
        // bridge the gap since this client's last event: snapshot instead.
        const { writer, needsSnapshot } = stream.channel.attach(route.req, route.res, {
          snapshot: stream.attached === 0 ? "always" : "auto",
          onClose: () => stream.release(),
        });
        if (writer.isClosed) return;
        stream.retain();

        const started = await stream.start();
        if (!needsSnapshot) return;
        // The snapshot the joining client gets is the slimmed one, for the same
        // reason every published frame is: the page draws none of what it drops.
        const view = slimSnapshot(started ?? (await stream.view()));
        if (!writer.isClosed)
          writer.send("snapshot", {
            ...view,
            type: "snapshot",
            attachments: await attachmentDescriptors(view.entries, attachmentLookupOf(this.deps)),
            hasEarlier: await hasEarlierEntry(this.deps, conversationId, view),
            apiVersion: API_VERSION,
          });
      } finally {
        stream.resume();
      }
    });
  }

  /**
   * Attach one more client to the job events. One bus subscription serves the
   * endpoint for the process lifetime: subscribing per connection would publish
   * every job event once per open window.
   */
  async attachJobs(route: RouteContext): Promise<void> {
    const channel = this.#jobChannel ?? (this.#jobChannel = this.deps.sse.channel("jobs"));
    if (this.#jobUnsubscribe === undefined) {
      this.#jobUnsubscribe = this.deps.bus.subscribe((event) => {
        if (event.type.startsWith("job_")) channel.publish(event.type, event.data);
      });
    }
    const { writer, needsSnapshot } = channel.attach(route.req, route.res);
    if (!needsSnapshot) return;
    const tree = await this.deps.runtime.jobs.tree(BACKGROUND_CONTEXT);
    // The first screen is filled from this snapshot, so it carries the derived
    // "working now" list just as `GET /api/jobs` does; without it the marker
    // would only appear after the next unrelated event.
    const workers = await jobWorkers(this.deps.runtime, jobTreeIds(tree));
    const legacyListText = await legacyScheduleProblem(this.deps.runtime);
    if (!writer.isClosed)
      writer.send("snapshot", {
        type: "snapshot",
        apiVersion: API_VERSION,
        jobs: withWorkingTree(tree, workers),
        legacyScheduleProblem: legacyListText,
      });
  }

  /**
   * Attach one more client to the focused chat events.
   *
   * The chats list page needs exactly one thing from a stream: that a chat was
   * opened, titled, archived or deleted. It cannot borrow a conversation stream
   * for it, because attaching one downloads that chat's whole transcript, so this
   * endpoint carries the control event alone. The snapshot is a bare "connected"
   * frame with the API version: the page reads its lists over HTTP, and a list in
   * this snapshot would be a second copy of the list route answering the same
   * question twice.
   *
   * One bus subscription serves the endpoint for the process lifetime, like the
   * job channel: subscribing per connection would publish every change once per
   * open window, and the resume buffer of the channel would be written per
   * connection.
   */
  attachFocusedChatEvents(route: RouteContext): void {
    const channel =
      this.#focusedChatChannel ?? (this.#focusedChatChannel = this.deps.sse.channel("focused-chats"));
    if (this.#focusedChatUnsubscribe === undefined) {
      this.#focusedChatUnsubscribe = this.deps.bus.subscribe((event) => {
        if (event.type === "focused_chat_updated" || event.type === "preferences_updated") channel.publish(event.type, event.data);
      });
    }
    const { writer, needsSnapshot } = channel.attach(route.req, route.res);
    if (!needsSnapshot || writer.isClosed) return;
    writer.send("snapshot", { type: "snapshot", apiVersion: API_VERSION });
  }

  /** Drop the endpoint-level subscriptions; attached clients are closed by the hub. */
  close(): void {
    this.#jobUnsubscribe?.();
    this.#jobUnsubscribe = undefined;
    this.#jobChannel = undefined;
    this.#focusedChatUnsubscribe?.();
    this.#focusedChatUnsubscribe = undefined;
    this.#focusedChatChannel = undefined;
    for (const stream of this.#conversations.values()) void stream.shutdown();
    this.#conversations.clear();
  }

  #conversation(conversationId: number): ConversationStream {
    const existing = this.#conversations.get(conversationId);
    if (existing !== undefined) return existing;
    const channel = this.deps.sse.channel(`conversation:${conversationId}`);
    const stream = new ConversationStream(this.deps, channel, conversationId);
    this.#conversations.set(conversationId, stream);
    return stream;
  }
}
