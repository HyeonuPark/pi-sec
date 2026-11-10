import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { DOC_KINDS, SecAgent, type AgentRecord } from "../documents.ts";
import type { Paths } from "../runtime/paths.ts";
import { scanDocumentKeys } from "../runtime/storage.ts";

/**
 * One context file per agent: the current state of its own work.
 *
 * The agent writes it, its parent reads it, and it outlives the agent. That last
 * part is why it is not a draft report: a draft belongs to a job and lives only
 * as long as that job does, while a parent that has just deleted a finished child
 * is exactly the reader that still wants to know what the child found.
 *
 * The root's file is the exception in one more way: it is permanent. The root
 * keeps its ledger across sessions, resets, compactions and restarts, because
 * what the operator was told last week is still true this week.
 */

/** File name of the root's permanent context file. */
export const ROOT_CONTEXT_FILE = "root";

/** How long a finished agent's context file is kept after the agent is gone. */
export const CONTEXT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** One agent conversation's context file. */
export function contextPath(paths: Paths, conversationId: string): string {
  return join(paths.agentsDir, `${conversationId}.md`);
}

/**
 * The root's context file.
 *
 * Named, not keyed by the root conversation id, because the name says what the
 * file is: the one that never expires.
 */
export function rootContextPath(paths: Paths): string {
  return join(paths.agentsDir, `${ROOT_CONTEXT_FILE}.md`);
}

/**
 * Create a file without ever emptying a file that is already there.
 *
 * `wx` makes the two outcomes distinct, and the root's file makes the
 * distinction matter: recreating it on every boot would erase the ledger the
 * operator is relying on. Only EEXIST is swallowed.
 */
async function createIfAbsent(path: string): Promise<void> {
  await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

/** Allocate one subagent's context file. Returns its path. */
export async function ensureContextFile(paths: Paths, conversationId: string): Promise<string> {
  const path = contextPath(paths, conversationId);
  await mkdir(paths.agentsDir, { recursive: true, mode: 0o700 });
  await createIfAbsent(path);
  return path;
}

/** Allocate the root's context file. Returns its path. */
export async function ensureRootContextFile(paths: Paths): Promise<string> {
  const path = rootContextPath(paths);
  await mkdir(paths.agentsDir, { recursive: true, mode: 0o700 });
  await createIfAbsent(path);
  return path;
}

/**
 * What a subagent is told about its context file.
 *
 * This reaches the agent as its `instructions`, which render after every
 * extension section. That ordering is the point, not an accident: the path
 * differs per agent, so a section carrying it would cut the shared instruction
 * text in two and every agent after it would stop sharing a prefix with the
 * others. Anything that varies per conversation belongs here.
 */
export function subagentContextBriefing(paths: Paths, conversationId: string, parent: string): string {
  return `Your context file is ${contextPath(paths, conversationId)}. Keep the current state of your work in it, and rewrite the whole file instead of appending to it. It stays after you finish, so ${parent} can read it.`;
}

/** What the root agent is told about its context file, which never expires. */
export function rootContextBriefing(paths: Paths): string {
  return `Your context file is ${rootContextPath(paths)}. It holds your ledger of what was said and promised. It is not tied to this session: it survives a reset, a compaction and a restart, so continue it rather than starting over.`;
}

export interface ContextSweepOptions {
  readonly harness: Harness;
  readonly storage: Storage;
  readonly paths: Paths;
  readonly context: Context;
  /** Clock override, for tests. */
  readonly now?: number;
  /** Retention override, for tests. */
  readonly retainMs?: number;
}

export interface ContextSweepReport {
  readonly removed: number;
  readonly kept: number;
}

/**
 * Remove context files nobody can use any more.
 *
 * Two ways a file becomes useless:
 *
 * 1. Its parent is gone. An agent whose parent record no longer exists can never
 *    be asked for its file, so the file goes as soon as the parent does.
 * 2. Its agent finished and is gone. A finished agent's record is retired in the
 *    same commit that ends it, so "the record is gone" is how this pass knows the
 *    work stopped. The file is kept for a while after that, because the parent is
 *    often still reading it.
 *
 * The age is read from the file, not from the record, because the record that
 * held the end time is the thing that is gone. The two differ only by the gap
 * between the agent's last write and its end, which is minutes.
 *
 * A file whose agent is still on file is never removed, however old it is: an
 * orchestrator parked for orders, or a worker waiting on a slow command, has an
 * old file and a live reason to keep it.
 *
 * The root's file is never removed. Deleting it is the operator's call.
 */
export async function sweepContextFiles(options: ContextSweepOptions): Promise<ContextSweepReport> {
  const now = options.now ?? Date.now();
  const retainMs = options.retainMs ?? CONTEXT_RETAIN_MS;

  const live = new Map<string, Readonly<AgentRecord>>();
  for (const key of await scanDocumentKeys(options.storage, DOC_KINDS.agent, options.context)) {
    const record = await options.harness.snapshot(SecAgent, key, options.context);
    if (record !== undefined) live.set(key, record);
  }

  const files = await readdir(options.paths.agentsDir).catch(() => [] as string[]);
  let removed = 0;
  let kept = 0;

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (name === ROOT_CONTEXT_FILE) {
      kept += 1;
      continue;
    }
    const path = join(options.paths.agentsDir, file);
    const record = live.get(name);

    if (record !== undefined) {
      const parentId = record.parentConversationId;
      if (parentId !== undefined && !live.has(parentId)) {
        await rm(path, { force: true });
        removed += 1;
        continue;
      }
      kept += 1;
      continue;
    }

    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (now - info.mtimeMs < retainMs) {
      kept += 1;
      continue;
    }
    await rm(path, { force: true });
    removed += 1;
  }

  return { removed, kept };
}
