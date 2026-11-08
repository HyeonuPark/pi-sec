import type { Context } from "@earendil-works/chord";
import type { Session, Storage, Tx } from "@earendil-works/pi-durable";
import { SecInbox, type InboxItem } from "../documents.ts";
import { ulid } from "../runtime/ids.ts";

export interface InboxFilter {
  readonly unread?: boolean;
  readonly kind?: string;
}

/** One item to write, as the core describes it. */
export interface InboxInput {
  readonly title: string;
  readonly body: string;
  readonly kind?: string;
  readonly severity?: "info" | "warn" | "error";
  readonly jobId?: string;
  readonly conversationId?: string;
  /** The report this item is about, when it is a report notice. */
  readonly reportId?: string;
  /** Which report write this item announces: published, updated, or answered. */
  readonly reportEvent?: "published" | "updated" | "answered";
  readonly id?: string;
}

/**
 * Write one notification inbox item inside a commit.
 *
 * It lives beside the store rather than in the `notify` extension, so a part of the
 * core that must tell the user something can write the item in the same commit as
 * the change it is about. A caller that writes it in that commit has told the user
 * even when the process dies right after the write: there is no delivery step and
 * nothing to retry. The `notify` extension imports it from here and re-exports it,
 * so every caller and test of that tool keeps its import.
 */
export async function createInboxItemTx(tx: Tx, input: InboxInput, now = Date.now()): Promise<InboxItem> {
  const id = input.id ?? ulid(now);
  const draft = await tx.doc(SecInbox, id, id);
  draft.id = id;
  draft.kind = input.kind ?? "notice";
  draft.title = input.title;
  draft.body = input.body;
  draft.createdAt = now;
  const source: {
    jobId?: string;
    conversationId?: string;
    reportId?: string;
    reportEvent?: "published" | "updated" | "answered";
  } = {};
  if (input.jobId !== undefined) source.jobId = input.jobId;
  if (input.conversationId !== undefined) source.conversationId = input.conversationId;
  if (input.reportId !== undefined) source.reportId = input.reportId;
  if (input.reportEvent !== undefined) source.reportEvent = input.reportEvent;
  if (Object.keys(source).length > 0) draft.source = source;
  if (input.severity !== undefined) draft.severity = input.severity;
  return JSON.parse(JSON.stringify(draft)) as InboxItem;
}

export interface InboxStoreOptions {
  readonly session: Session;
  readonly storage: Storage;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Durable notification inbox over the `sec.inbox` session family. */
export class InboxStore {
  private readonly session: Session;
  private readonly storage: Storage;

  constructor(options: InboxStoreOptions) {
    this.session = options.session;
    this.storage = options.storage;
  }

  async keys(context: Context): Promise<string[]> {
    const keys: string[] = [];
    let cursor: Parameters<Storage["scanDocuments"]>[2];
    for (;;) {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "sec.inbox" },
        500,
        cursor,
        context,
      );
      for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return keys;
  }

  async list(context: Context, filter?: InboxFilter): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const key of await this.keys(context)) {
      const item = await this.session.snapshot(SecInbox, key, context);
      if (item === undefined) continue;
      if (filter?.unread === true && item.readAt !== undefined) continue;
      if (filter?.kind !== undefined && item.kind !== filter.kind) continue;
      items.push(item as InboxItem);
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  async get(context: Context, id: string): Promise<InboxItem | undefined> {
    const item = await this.session.snapshot(SecInbox, id, context);
    return item as InboxItem | undefined;
  }

  async markReadTx(tx: Tx, id: string, now = Date.now()): Promise<InboxItem | undefined> {
    const draft = await tx.doc(SecInbox, id, id);
    if (draft.createdAt === 0) return undefined;
    draft.readAt = now;
    return plain(draft);
  }

  async markRead(id: string, context: Context): Promise<InboxItem | undefined> {
    return this.session.commit((tx) => this.markReadTx(tx, id), context);
  }
}
