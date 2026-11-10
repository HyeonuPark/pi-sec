import { chmod, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { wrapTool, type ToolExecutionApi, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { ok, type ExecutionEnv, type FileError, type Result } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/**
 * Two guards on the file tools of the `coding` extension.
 *
 * They are tool wrappers rather than hooks, because a hook does not run for a
 * nested call: a `js` script that calls `edit` or `bash` runs the tool itself,
 * with no `ToolTask` around it. Wrapping `execute` covers both paths, and it
 * leaves the `[[pi-sec:now]]` hook untouched, because a wrapper changes the api
 * and nothing else.
 *
 * The first guard is a lock per conversation. A call that writes a file (`edit`,
 * `write`) and a call that runs a shell (`bash`) never overlap in one
 * conversation, so a `sed -i` cannot read a file in the moment `edit` has
 * truncated it and put an empty file back. Two calls of the same kind do
 * overlap: two shells, and two edits of different files, still run together.
 * The lock is memory only, so a daemon that dies takes it with it.
 *
 * The second guard changes how `edit` and `write` write. Every write goes to a
 * temporary file in the same directory and is renamed into place, so a reader
 * sees the old bytes or the new ones and never a truncated file. `edit` compares
 * the text it read with the text the file holds just before the rename, and
 * refuses with an error when the two differ, and it refuses a result that would
 * leave the file empty.
 */

/** What a call takes the conversation's slot as. */
export type WriteKind = "write" | "shell";

/** The long-running counterpart of a kind: the one it waits for. */
function otherKind(kind: WriteKind): WriteKind {
  return kind === "write" ? "shell" : "write";
}

/** One call holding or waiting for a slot. */
interface Holder {
  readonly kind: WriteKind;
  /** False once the call left the turn, which is what a call moved to the background did. */
  stillPartOfTurn(): boolean;
  released: boolean;
}

interface Waiter {
  readonly kind: WriteKind;
  readonly stillPartOfTurn: () => boolean;
  grant(holder: Holder): void;
}

interface LockState {
  readonly holders: { write: number; shell: number };
  /** The same holders, so one that left the turn can be found and dropped. */
  readonly held: Set<Holder>;
  readonly waiters: Waiter[];
  /** Runs while at least one call waits, because a holder may leave the turn without releasing. */
  recheck?: NodeJS.Timeout;
}

/** One lock per conversation. A key holds nothing once its last call has finished. */
const locks = new Map<string, LockState>();

/** How often a waiting call looks for a holder that left the turn. */
const RECHECK_MS = 1000;

function lockFor(key: string): LockState {
  let state = locks.get(key);
  if (state === undefined) {
    state = { holders: { write: 0, shell: 0 }, held: new Set(), waiters: [] };
    locks.set(key, state);
  }
  return state;
}

function forgetIfIdle(key: string, state: LockState): void {
  if (state.holders.write > 0 || state.holders.shell > 0 || state.waiters.length > 0) return;
  if (state.recheck !== undefined) {
    clearInterval(state.recheck);
    state.recheck = undefined;
  }
  if (locks.get(key) === state) locks.delete(key);
}

function releaseHolder(key: string, state: LockState, holder: Holder): void {
  if (holder.released) return;
  holder.released = true;
  state.held.delete(holder);
  state.holders[holder.kind] -= 1;
  pump(key, state);
  forgetIfIdle(key, state);
}

/**
 * Drop the holders that left the turn, so a call they are no longer part of
 * cannot block the next bundle. A call that moved to the background keeps
 * running; it just stops counting as a holder.
 */
function dropMoved(key: string, state: LockState): void {
  for (const holder of [...state.held]) {
    if (holder.stillPartOfTurn()) continue;
    releaseHolder(key, state, holder);
  }
}

/**
 * Give the slot to the calls that may have it, in the order they asked for it.
 *
 * The head of the queue decides: while its counterpart holds the slot it waits,
 * and once it has the slot, every call of its kind behind it goes too. Calls of
 * the other kind then wait until those are done. So the order across the two
 * kinds is the order the calls arrived, and calls of one kind never wait for
 * each other.
 */
function pump(key: string, state: LockState): void {
  for (;;) {
    const head = state.waiters[0];
    if (head === undefined) return;
    if (state.holders[otherKind(head.kind)] > 0) return;
    while (state.waiters[0]?.kind === head.kind) {
      const waiter = state.waiters.shift() as Waiter;
      const holder: Holder = { kind: waiter.kind, stillPartOfTurn: waiter.stillPartOfTurn, released: false };
      state.holders[holder.kind] += 1;
      state.held.add(holder);
      waiter.grant(holder);
    }
  }
}

function startRecheck(key: string, state: LockState): void {
  if (state.recheck !== undefined) return;
  state.recheck = setInterval(() => {
    dropMoved(key, state);
    forgetIfIdle(key, state);
  }, RECHECK_MS);
  state.recheck.unref?.();
}

/**
 * Take the conversation's slot for one call, as `kind`.
 *
 * `stillPartOfTurn` says whether the call is still part of the turn; a call that
 * answers false has left it, and stops holding the slot. The returned function
 * releases the slot and is safe to call twice.
 */
export async function acquireWriteSlot(
  key: string,
  kind: WriteKind,
  stillPartOfTurn: () => boolean = () => true,
): Promise<() => void> {
  const state = lockFor(key);
  dropMoved(key, state);
  if (state.waiters.length === 0 && state.holders[otherKind(kind)] === 0) {
    const holder: Holder = { kind, stillPartOfTurn, released: false };
    state.holders[kind] += 1;
    state.held.add(holder);
    return () => releaseHolder(key, state, holder);
  }
  const holder = await new Promise<Holder>((grant) => {
    state.waiters.push({ kind, stillPartOfTurn, grant });
  });
  forgetIfIdle(key, state);
  return () => releaseHolder(key, state, holder);
}

/**
 * Whether this call runs in the background rather than inside the turn.
 *
 * A background call holds no slot: it can run for a long time, and the turn it
 * used to belong to is over. `async_call` runs a tool with the api of its own
 * task, and that api's call id carries the prefix below; the tools of the turn
 * carry the model's call id, and a nested call carries `js:<tool>:<n>`.
 */
const BACKGROUND_CALL_PREFIX = "async:";

function runsInBackground(api: ToolExecutionApi): boolean {
  return String(api.callId).startsWith(BACKGROUND_CALL_PREFIX);
}

/**
 * Whether the call is still part of the turn it started in.
 *
 * A call that runs past `agent.tools.backgroundAfterMs` moves to the background:
 * `async-tools` hands its api to the background task that owns it from then on,
 * so `taskId` changes and the call is no longer part of any turn.
 */
function staysInTurn(api: ToolExecutionApi): () => boolean {
  const task = api.taskId;
  return () => api.taskId === task;
}

/** What a guarded call holds while it runs. */
function taken(api: ToolExecutionApi, kind: WriteKind): Promise<() => void> {
  return acquireWriteSlot(String(api.conversationId), kind, staysInTurn(api));
}

/** A counter for temporary file names, so two writes of one directory never share one. */
let temporaryCounter = 0;

/** The real path of a write target, so a rename replaces the file a symlink names. */
async function writeTarget(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const canonical = await env.canonicalPath(path, context);
  return canonical.ok ? canonical.value : path;
}

/** The permission bits of an existing file, or nothing when there is no file to copy them from. */
async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` over `path` through a temporary file beside it.
 *
 * The temporary file carries the permission bits of the file it replaces, so a
 * script that stopped running because of them keeps stopping, and a private file
 * stays private. A write that fails removes its temporary file.
 */
async function writeAtomically(
  env: ExecutionEnv,
  path: string,
  content: string | Uint8Array,
  context: Context,
): Promise<Result<void, FileError>> {
  const target = await writeTarget(env, path, context);
  const directory = dirname(target);
  const created = await env.createDir(directory, { recursive: true }, context);
  if (!created.ok) return created;
  const mode = await existingMode(target);
  temporaryCounter += 1;
  const temporary = join(directory, `.${basename(target)}.pi-sec-${process.pid}-${temporaryCounter}.tmp`);
  const written = await env.writeFile(temporary, content, context);
  if (!written.ok) {
    await env.remove(temporary, { force: true }, context);
    return written;
  }
  if (mode !== undefined) {
    try {
      await chmod(temporary, mode);
    } catch {
      /* the rename below still replaces the bytes; only the permissions are lost */
    }
  }
  const renamed = await env.renameFile(temporary, target, context);
  if (!renamed.ok) {
    await env.remove(temporary, { force: true }, context);
    return renamed;
  }
  return ok(undefined);
}

/** Whether a result leaves nothing in the file. */
function isEmptyText(text: string): boolean {
  return text === "" || text === "\uFEFF";
}

/**
 * The environment one `edit` or `write` call gets.
 *
 * Every other operation is the environment's own, inherited unchanged, so a
 * tool that asks for the working directory, the file's kind, or a shell command
 * gets the answer it always got.
 */
function guardedEnv(env: ExecutionEnv, kind: "edit" | "write"): ExecutionEnv {
  const guarded = Object.create(env) as ExecutionEnv;
  /** What this call read, and from where: the text `edit` matched its edits against. */
  let read: { path: string; text: string } | undefined;
  guarded.readTextFile = async (path, context) => {
    const result = await env.readTextFile(path, context);
    if (result.ok) read = { path, text: result.value };
    return result;
  };
  guarded.writeFile = async (path, content, context) => {
    const previous = read;
    if (kind === "edit" && previous !== undefined && previous.path === path) {
      const current = await env.readTextFile(path, context);
      if (!current.ok) return current;
      if (current.value !== previous.text) {
        throw new Error(
          `Refused to edit ${path}: the file changed on disk after this call read it, so writing this edit would discard that change. Read the file again and make the edit from the content it has now.`,
        );
      }
      if (typeof content === "string" && isEmptyText(content) && !isEmptyText(previous.text)) {
        throw new Error(
          `Refused to edit ${path}: this edit would leave the file empty, and the file it replaces is not empty. Use the write tool with empty content if the file must be empty.`,
        );
      }
    }
    return writeAtomically(env, path, content, context);
  };
  return guarded;
}

/** The api one guarded call gets: its own environment, and everything else inherited. */
function guardedApi(api: ToolExecutionApi, kind: "edit" | "write"): ToolExecutionApi {
  const env = api.env;
  if (env === undefined) return api;
  const guarded = Object.create(api) as ToolExecutionApi;
  Object.defineProperty(guarded, "env", { value: guardedEnv(env, kind), enumerable: true });
  return guarded;
}

/** One tool, guarded: the slot while it runs, and for a file tool its environment. */
function guardedTool(
  tool: ToolRegistration,
  kind: WriteKind,
  fileTool?: "edit" | "write",
): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, context) => {
      // A background call takes no slot, because it must not make a turn wait, but
      // a file tool keeps its guarded environment: the rename and the two refusals
      // protect the file, whoever runs the call.
      if (runsInBackground(api)) {
        return tool.execute(args, fileTool === undefined ? api : guardedApi(api, fileTool), context);
      }
      const release = await taken(api, kind);
      try {
        return await tool.execute(args, fileTool === undefined ? api : guardedApi(api, fileTool), context);
      } finally {
        release();
      }
    },
  };
}

/** The tool of `CodingTools` with this name; a name it does not carry is a bug in this module. */
function codingTool(name: string): ToolRegistration {
  const found = CodingTools.tools?.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`the coding tools have no ${name}`);
  return found;
}

/**
 * The guards as wrappers of the `coding` extension, applied wherever `coding` is
 * selected. The tools are named here rather than taken from the agent, because a
 * wrapper is built once, when an agent is resolved.
 */
export function writeGuardWraps(): Wrap<ToolRegistration>[] {
  return [
    wrapTool(codingTool("edit"), (tool) => guardedTool(tool, "write", "edit")),
    wrapTool(codingTool("write"), (tool) => guardedTool(tool, "write", "write")),
    wrapTool(codingTool("bash"), (tool) => guardedTool(tool, "shell")),
  ];
}
