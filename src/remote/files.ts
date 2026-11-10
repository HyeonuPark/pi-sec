/**
 * The file tools: reading, replacing and editing one remote file over sftp, and
 * copying a tree with rsync.
 *
 * ## Why sftp and not a shell
 *
 * A shell redirect is what a person reaches for, and it is the one thing this
 * module must not build: `ssh host 'cat > path'` has no quoting rule that survives a
 * path somebody else chose, and a write that is interrupted leaves half a file for
 * the next reader. sftp takes a batch of commands on standard input, so a whole
 * read or write is one connection, one process, and no shell anywhere on the path.
 *
 * ## Why every write is a temporary file and a rename
 *
 * A reader on the machine may be reading the file this install is replacing: a log
 * the user is watching, a config a service reads. Writing in place would show that
 * reader a half-written file. So the new bytes go to a temporary file in the same
 * directory (the only place a rename can be atomic) and the rename puts them in
 * place. Nothing here creates a directory: a missing one is the caller's mistake
 * and saying so is more useful than a `mkdir` nobody asked for.
 *
 * ## Why `edit` reads the original twice
 *
 * The four steps: read the file, refuse unless the old text is
 * there exactly once, write the result to a temporary file, then read the original
 * again and refuse if it changed while that happened. Without the second read, an
 * edit silently discards whatever another writer put in the file in between.
 *
 * ## Why the local side of `sync` gets a wrapper script
 *
 * rsync builds the command line of the ssh it starts from `-e`, and it splits that
 * string with its own parser, not a shell's. So the pinned-key options cannot be
 * quoted into it. `sync` writes a four-line wrapper that runs ssh with the one
 * option list and takes its arguments through, and hands rsync the wrapper.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Access, RemotePlumbing } from "./plumbing.ts";
import { sftpArguments, sftpQuote, sshOptions, sshShellWrapper } from "./ssh.ts";

/** Deadline of one sftp call, in milliseconds. */
export const SFTP_DEADLINE_MS = 120_000;

/** Deadline of one rsync call. A tree can be large, and the setting says nothing about it. */
export const RSYNC_DEADLINE_MS = 1_800_000;

/** The default cap on what `read` returns, in bytes. */
export const DEFAULT_READ_MAX_BYTES = 262_144;

/** The largest cap a caller may ask for: it is a file, not a stream. */
export const READ_MAX_BYTES_LIMIT = 4 * 1024 * 1024;

/** What `read` came to. */
export type ReadFileResult =
  | { readonly kind: "ok"; readonly path: string; readonly content: string; readonly bytes: number }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** What `write` and `edit` came to. */
export type WriteFileResult =
  | { readonly kind: "ok"; readonly path: string; readonly bytes: number }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** What `sync` came to. */
export type SyncResult =
  | { readonly kind: "ok"; readonly direction: "push" | "pull" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** What one sftp batch answered. */
interface SftpAnswer {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * The three file tools and the tree copy.
 *
 * One object per `RemoteMachines`, reached through it. It holds only the plumbing:
 * every call resolves its target from the config and runs, which is what lets one
 * config reload reach a running daemon.
 */
export class RemoteFiles {
  readonly #plumbing: RemotePlumbing;

  constructor(plumbing: RemotePlumbing) {
    this.#plumbing = plumbing;
  }

  /**
   * Read one remote file.
   *
   * The cap is checked on the size the sftp listing reports, before any bytes are
   * fetched, so a 4 GB log is refused without transferring it. The plan is explicit
   * that the file is refused rather than cut: an `edit` that follows has to see
   * every byte, and a cut file would make it write a truncated result.
   */
  async read(input: {
    readonly machine: string;
    readonly path: string;
    readonly user?: string;
    readonly maxBytes?: number;
    readonly ctx?: Context;
  }): Promise<ReadFileResult> {
    const access = await this.#plumbing.access(input.machine, "read", input.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const cap = Math.min(READ_MAX_BYTES_LIMIT, Math.max(1, input.maxBytes ?? DEFAULT_READ_MAX_BYTES));
    const local = await mkdtemp(join(tmpdir(), "pi-sec-remote-read-"));
    try {
      const target = join(local, "file");
      const size = await this.#size(access, input.path);
      if (size === undefined) {
        return { kind: "failed", reason: `cannot read ${input.path}: the file is not there or cannot be listed` };
      }
      if (size > cap) {
        return {
          kind: "refused",
          reason: `${input.path} is ${String(size)} bytes, which is more than the ${String(cap)}-byte cap; name a larger maxBytes or read part of it with a command`,
        };
      }
      const answer = await this.#sftp(access, [`get ${sftpQuote(input.path)} ${sftpQuote(target)}`]);
      if (answer.code !== 0) return { kind: "failed", reason: sftpReason(answer) };
      const content = await readFile(target, "utf8");
      return { kind: "ok", path: input.path, content, bytes: Buffer.byteLength(content, "utf8") };
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }

  /**
   * Replace one remote file's content.
   *
   * The temporary file is a sibling of the target, so the rename cannot cross a
   * filesystem boundary. Its name carries the process's own number and a random
   * part, so each call has its own name and two writers of the same file cannot
   * collide on it, and it is removed when the write fails so
   * nothing is left beside the target.
   */
  async write(input: {
    readonly machine: string;
    readonly path: string;
    readonly content: string;
    readonly user?: string;
    readonly ctx?: Context;
  }): Promise<WriteFileResult> {
    const access = await this.#plumbing.access(input.machine, "write", input.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const temp = tempPathFor(input.path);
    const local = await mkdtemp(join(tmpdir(), "pi-sec-remote-write-"));
    try {
      const source = join(local, "file");
      await writeFile(source, input.content, "utf8");
      const answer = await this.#sftp(access, [
        `put ${sftpQuote(source)} ${sftpQuote(temp)}`,
        `rename ${sftpQuote(temp)} ${sftpQuote(input.path)}`,
      ]);
      if (answer.code !== 0) {
        await this.#sftp(access, [`-rm ${sftpQuote(temp)}`]);
        return { kind: "failed", reason: sftpReason(answer) };
      }
      return { kind: "ok", path: input.path, bytes: Buffer.byteLength(input.content, "utf8") };
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }

  /**
   * Replace exactly one occurrence of a string in a remote file.
   *
   * The five steps, in one connection each: read the file, count
   * the occurrences and refuse anything but one, write the result beside it, read
   * the original again and compare, and only then rename. The second read is what
   * turns a concurrent writer from silent data loss into a refusal.
   */
  async edit(input: {
    readonly machine: string;
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly user?: string;
    readonly ctx?: Context;
  }): Promise<WriteFileResult> {
    if (input.oldText === "") {
      return { kind: "refused", reason: "the old text is empty, so it would match everywhere" };
    }
    const read = await this.read({
      machine: input.machine,
      path: input.path,
      ...(input.user === undefined ? {} : { user: input.user }),
      maxBytes: READ_MAX_BYTES_LIMIT,
      ...(input.ctx === undefined ? {} : { ctx: input.ctx }),
    });
    if (read.kind !== "ok") return read;
    const occurrences = countOccurrences(read.content, input.oldText);
    if (occurrences === 0) {
      return { kind: "refused", reason: `the old text appears nowhere in ${input.path}` };
    }
    if (occurrences > 1) {
      return {
        kind: "refused",
        reason: `the old text appears ${String(occurrences)} times in ${input.path}; an edit must match exactly once`,
      };
    }
    const at = read.content.indexOf(input.oldText);
    const next = read.content.slice(0, at) + input.newText + read.content.slice(at + input.oldText.length);

    const access = await this.#plumbing.access(input.machine, "edit", input.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const temp = tempPathFor(input.path);
    const local = await mkdtemp(join(tmpdir(), "pi-sec-remote-edit-"));
    try {
      const source = join(local, "file");
      await writeFile(source, next, "utf8");
      const put = await this.#sftp(access, [`put ${sftpQuote(source)} ${sftpQuote(temp)}`]);
      if (put.code !== 0) {
        await this.#sftp(access, [`-rm ${sftpQuote(temp)}`]);
        return { kind: "failed", reason: sftpReason(put) };
      }
      // The original is read again before the rename. These are two separate sftp
      // calls, so a writer that changes the file in the gap of one round trip is
      // not seen: sftp has no compare-and-swap, and the second read cannot close
      // that gap. A file that changed since the first read is caught here.
      const again = await this.read({
        machine: input.machine,
        path: input.path,
        ...(input.user === undefined ? {} : { user: input.user }),
        maxBytes: READ_MAX_BYTES_LIMIT,
        ...(input.ctx === undefined ? {} : { ctx: input.ctx }),
      });
      if (again.kind !== "ok") {
        await this.#sftp(access, [`-rm ${sftpQuote(temp)}`]);
        return { kind: "failed", reason: "the file could not be read again before the rename" };
      }
      if (again.content !== read.content) {
        await this.#sftp(access, [`-rm ${sftpQuote(temp)}`]);
        return {
          kind: "refused",
          reason: `${input.path} changed while the edit was being prepared, so nothing was written`,
        };
      }
      const rename = await this.#sftp(access, [`rename ${sftpQuote(temp)} ${sftpQuote(input.path)}`]);
      if (rename.code !== 0) {
        await this.#sftp(access, [`-rm ${sftpQuote(temp)}`]);
        return { kind: "failed", reason: sftpReason(rename) };
      }
      return { kind: "ok", path: input.path, bytes: Buffer.byteLength(next, "utf8") };
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  }

  /**
   * Copy a tree between this machine and a remote one with rsync.
   *
   * `push` reads the source here, `pull` reads it there. `delete` removes files at
   * the destination that the source does not have, and it is off unless named,
   * because it is the one part of this tool that removes something.
   *
   * The level check refuses this tool at `restricted`: the size of a copy is not
   * known before it starts, so it cannot be called light work.
   */
  async sync(input: {
    readonly machine: string;
    readonly direction: "push" | "pull";
    readonly source: string;
    readonly destination: string;
    readonly user?: string;
    readonly delete?: boolean;
    readonly ctx?: Context;
  }): Promise<SyncResult> {
    const access = await this.#plumbing.access(input.machine, "sync", input.user);
    if (!access.ok) return { kind: "refused", reason: access.reason };
    const remote = `${access.user}@${access.target.address}:${input.destination}`;
    const localSide = input.direction === "push" ? input.source : input.destination;
    const remoteSide = input.direction === "push" ? remote : `${access.user}@${access.target.address}:${input.source}`;
    const from = input.direction === "push" ? localSide : remoteSide;
    const to = input.direction === "push" ? remoteSide : input.destination;

    const dir = await mkdtemp(join(tmpdir(), "pi-sec-remote-sync-"));
    try {
      const wrapper = join(dir, "ssh-wrapper");
      const programs = this.#plumbing.programs();
      await writeFile(wrapper, sshShellWrapper(programs.ssh, sshOptions(access.target)), { mode: 0o700 });
      const args = ["-a", ...(input.delete === true ? ["--delete"] : []), "-e", wrapper, from, to];
      const result = await this.#plumbing.run(programs.rsync, args, { timeoutMs: RSYNC_DEADLINE_MS });
      if (result.timedOut) return { kind: "failed", reason: "the copy ran past its deadline" };
      if (result.code !== 0) return { kind: "failed", reason: lastLine(result.stderr, `rsync exited ${String(result.code)}`) };
      return { kind: "ok", direction: input.direction };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // -- sftp ----------------------------------------------------------------

  /** Run one sftp batch against one machine and user. */
  async #sftp(access: Access, lines: readonly string[]): Promise<SftpAnswer> {
    const batch = `${lines.join("\n")}\n`;
    const result = await this.#plumbing.run(this.#plumbing.programs().sftp, sftpArguments(access.target), {
      timeoutMs: SFTP_DEADLINE_MS,
      input: batch,
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
  }

  /**
   * The size of one remote file, from an sftp long listing.
   *
   * `ls -ln` prints one line per match: permissions, links, owner, group, size, date,
   * time, name. The size is the fifth field. A listing of a directory prints many
   * lines and a listing of a missing file prints none, so anything but exactly one
   * line is "cannot tell", which the caller reports rather than guesses about.
   */
  async #size(access: Access, path: string): Promise<number | undefined> {
    const answer = await this.#sftp(access, [`ls -ln ${sftpQuote(path)}`]);
    if (answer.code !== 0) return undefined;
    const lines = answer.stdout
      .split("\n")
      .map((line) => line.replace(/^sftp>\s*/, "").trim())
      .filter((line) => line !== "" && !line.startsWith("ls "));
    if (lines.length !== 1) return undefined;
    const fields = (lines[0] as string).split(/\s+/);
    const size = Number(fields[4]);
    return Number.isFinite(size) ? size : undefined;
  }
}

/**
 * The temporary file a write or an edit uses, beside its target. Each call gets
 * its own name, so two overlapping calls on one path never share a temporary file.
 */
function tempPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const head = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `${head}.${name}.pi-sec-${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
}

/** How many times `needle` appears in `haystack`, counted without overlapping. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** ssh's own sentence for a failure of the connection rather than of a command. */
function sftpReason(answer: SftpAnswer): string {
  if (answer.timedOut) return "the machine did not answer in time";
  return lastLine(answer.stderr, `sftp exited ${String(answer.code)}`);
}

/** The last line of some output that carries text, or the fallback. */
function lastLine(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? fallback : (lines[lines.length - 1] as string);
}

/** The context a read of a file uses when the caller names none. */
export const FILE_CONTEXT = BACKGROUND_CONTEXT;
