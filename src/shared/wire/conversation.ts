/**
 * What the conversation stream carries, and what the chat page reads about the
 * conversation it shows.
 *
 * These are the shapes the chat page reads off the wire, written down once so the
 * page code and its tests agree on them. They describe the wire only: no code, and no
 * import of `src/server`, so the page type check does not pull Node with them.
 *
 * The server's own writers decide these fields: the snapshot is built beside the
 * conversation route, and a focused chat's record is `GET /api/focused-chats/:id`.
 * An entry is whatever the durable layer stored, which is why its fields are
 * loosely typed here: the page draws `kind`, `id` and `model`, and leaves the
 * rest alone.
 */

/** One entry of a stored conversation, as a snapshot or an appended frame delivers it. */
export interface ConversationEntry {
  /** The durable entry id. Absent on an entry that was never committed. */
  readonly id?: number | string | null;
  /** The kind the transcript routes on, such as `pi.user` or `pi.tool-result`. */
  readonly kind: string;
  /** The model messages this entry committed: an array of `{ role, content }`. */
  readonly model?: readonly unknown[] | null;
  /** Kind-specific fields, such as a tool result's `toolName`. */
  readonly data?: Readonly<Record<string, unknown>> | null;
  /**
   * The first entry of the active context, on a reset and on a compaction. A
   * live frame that carries one makes the page open a new stream, because the
   * server draws that context alone.
   */
  readonly head?: unknown;
  readonly [field: string]: unknown;
}

/** What one attachment id is, as a payload describes it beside its entries. */
export interface AttachmentDescriptor {
  readonly name?: string;
  readonly mime?: string;
  readonly bytes?: number;
  readonly w?: number;
  readonly h?: number;
}

/** The provider and model the shown conversation runs on. */
export interface ModelId {
  readonly provider: string;
  readonly modelId: string;
}

/** One tool call a snapshot carries, so a page that reconnected can draw it. */
export interface ToolSnapshot {
  readonly callId: string;
  readonly name?: string;
  /** `running`, `done` or `pending`; a pending call draws nothing. */
  readonly status?: string;
  readonly output?: string;
}

/**
 * The whole state frame a conversation stream opens with, and sends again after
 * a reconnect the server cannot replay.
 */
export interface ConversationSnapshot {
  readonly entries?: readonly ConversationEntry[];
  /**
   * Whether the conversation stores anything before the first entry this frame
   * carries, which is what decides whether the page draws its
   * `Load previous session` button on the first paint.
   *
   * Optional on purpose: a page that does not read it draws no button, and a
   * page that does read it treats an absent value as `false`. Adding it is an
   * additive change, so the announced API revision does not move.
   */
  readonly hasEarlier?: boolean;
  /** What each attachment id named by these entries is, by id. */
  readonly attachments?: Readonly<Record<string, AttachmentDescriptor>>;
  readonly agent?: { readonly model?: ModelId | null } | null;
  readonly tools?: readonly ToolSnapshot[];
  readonly compactions?: readonly unknown[];
  readonly generation?: { readonly message?: unknown } | null;
  /** Present while a run is active. */
  readonly run?: unknown;
}

/** One focused chat's record, from the read route, the rename answer and the event. */
export interface FocusedChatRecord {
  readonly conversationId?: number;
  readonly title?: string;
  /** The read route's spelling of the archive state. */
  readonly archived?: boolean;
  /** The event's spelling of it: a time, or `null` while the chat is live. */
  readonly archivedAt?: string | number | null;
  /** Set by the event: `created`, `updated` or `deleted`. */
  readonly change?: string;
}

/**
 * One earlier session, as `GET /basic-chat/history?before=` answers it, and as
 * `GET /api/conversations/:id/history?before=` answers the same question.
 */
export interface ConversationHistory {
  /** The session's entries, oldest first, its session restart first of all. */
  readonly entries?: readonly ConversationEntry[];
  /** What each attachment id these entries name is, by id. */
  readonly attachments?: Readonly<Record<string, AttachmentDescriptor>>;
  /** Whether the conversation stores anything before the first entry answered. */
  readonly hasMore?: boolean;
  readonly apiVersion?: number;
}

/**
 * Every conversation route the chat page uses, chosen once from the chat number.
 *
 * A root route is not in a focused chat's set, so a page that shows a focused
 * chat cannot address the root conversation at all.
 */
export interface ConversationRoutes {
  readonly focused: boolean;
  readonly info: string | null;
  readonly events: string;
  readonly context: string;
  /** One earlier session; the page adds `?before=<entry id>` when it asks. */
  readonly history: string;
  readonly messages: string;
  readonly abort: string;
  readonly reset: string;
  readonly compact: string;
}

/** Which conversation the top bar names, and whether the page can write to it. */
export interface ChatState {
  /** True on the root conversation, which is the page's own. */
  readonly root: boolean;
  /** The focused chat's title, or `null` while the agent has not set one. */
  readonly title: string | null;
  readonly archived: boolean;
  /** True for a chat number the server does not know. */
  readonly missing: boolean;
}

/** What `GET /api/admin/status` answers, as this page reads it. */
export interface AdminStatus {
  readonly restartRequired?: boolean;
  readonly restartReady?: boolean;
  /** True while `agent.vmodel` is empty and the daemon waits for a first model. */
  readonly modelSetupRequired?: boolean;
  readonly sectionsStale?: readonly unknown[];
  readonly configError?: { readonly issues?: readonly string[] } | null;
  readonly notes?: readonly unknown[];
  /** The providers whose usage limit is holding conversations, one entry each. */
  readonly usageHold?: readonly UsageHoldView[];
}

/** One provider holding conversations because it refused a request for usage. */
export interface UsageHoldView {
  readonly provider: string;
  /** How many conversations wait for this provider. */
  readonly conversations: number;
  /** Epoch milliseconds the provider's own window resets, when it states one. */
  readonly resetsAt?: number;
  /** False when this server cannot read the provider's own usage at all. */
  readonly readable: boolean;
  readonly lastProbeAt?: number;
  readonly lastProbeResult?: "none" | "ok" | "rate_limited" | "failed";
  readonly lastProbeReason?: string;
  /** When the next short request that checks recovery is allowed. */
  readonly nextProbeAt?: number;
}

/** One provider entry of `GET /api/admin/model-login/providers`. */
export interface ProviderEntry {
  readonly id: string;
  readonly configured?: boolean;
  readonly [field: string]: unknown;
}

/** What `GET /api/admin/model-login/providers` answers. */
export interface ProviderList {
  readonly providers?: readonly ProviderEntry[];
  readonly available?: boolean;
  /** The provider the root conversation's model belongs to. */
  readonly rootProvider?: string | null;
}
