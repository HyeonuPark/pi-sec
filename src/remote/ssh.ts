/**
 * Every ssh command line this feature starts, and the reading of what came back.
 *
 * One rule decides the shape of this module: the ssh options arrive on the
 * command line, never from a config file. `-F /dev/null` is the first of them, so
 * neither the operator's `~/.ssh/config` nor `/etc/ssh/ssh_config` is read. A
 * system ssh configuration can make an
 * ordinary `ssh` fail, and a call that inherited it would fail for a reason this
 * code could not see (`docs/security.md`, the remote machines section).
 *
 * Everything else is here for one of four reasons:
 *
 *   - `BatchMode=yes` turns every question into a failure. Nothing can answer a
 *     password prompt or a `[fingerprint] (yes/no)?` question, so a call that
 *     would ask is a call that hangs.
 *   - `StrictHostKeyChecking=yes` with a file of pinned keys refuses a machine
 *     whose key is not the one the operator checked. `UpdateHostKeys=no` stops
 *     the server's own suggestion from being added to that file.
 *   - `HostKeyAlias` looks the key up by the machine's name instead of its
 *     address, so a machine that moves keeps the key it was checked with.
 *   - `ControlMaster`/`ControlPath`/`ControlPersist` keep one connection open per
 *     machine and user, which is what makes a heartbeat cost milliseconds instead
 *     of a handshake.
 *
 * A timeout is this module's own: ssh kills a dead connection after
 * `ConnectTimeout` seconds, but a connection that is up and silent has no such
 * bound, so the caller gives each run a deadline and a run past it is killed.
 *
 * ## One list of options, three programs
 *
 * `ssh`, `sftp` and `rsync` all reach the machine, and all three carry the same
 * options: sftp takes the ssh ones directly, and rsync passes them to the ssh it
 * starts through `-e`. So the list is built once, in `sshOptions`, and every
 * argument builder here starts from it. A second copy of the list in the sftp or
 * rsync path would be a second place to forget `StrictHostKeyChecking=yes`.
 *
 * ## Two ways to feed a program
 *
 * A command line carries everything on the command line, so its standard input is
 * closed: a remote command that reads stdin must read an empty one rather than
 * wait for a terminal, which is what `BatchMode=yes` already assumes. sftp is the
 * other way round: it reads its commands from stdin (`-b -`), so it needs a path
 * that writes one.
 */

import { spawn } from "node:child_process";

/** One machine and user, as the ssh options name them. */
export interface SshTarget {
  /** The machine's name. It is the `HostKeyAlias`, so the pinned key is found by name. */
  readonly machineId: string;
  readonly address: string;
  readonly port: number;
  readonly user: string;
  /** The private key file, already expanded (`~` and `$HOME` resolved). */
  readonly identityFile: string;
  /** The pinned-keys file, already expanded. */
  readonly knownHostsFile: string;
  /** The socket of the connection kept open to this machine and user. */
  readonly controlPath: string;
}

/**
 * The options every call carries, in this order.
 *
 * Exported as a list so a test can hold the whole set in one place, and so a
 * reader can compare it with the table in the documentation. Order matters only
 * for readability: ssh takes a repeated option's last value, and none of these
 * repeats.
 */
export function sshOptions(target: SshTarget): string[] {
  return [
    // No config file of either kind. First, because everything after it is meant
    // to be the whole configuration of this call.
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `IdentityFile=${target.identityFile}`,
    "-o",
    `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `HostKeyAlias=${target.machineId}`,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${target.controlPath}`,
    "-o",
    "ControlPersist=300",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

/** The destination, as ssh takes it: `user@address`. */
export function sshDestination(target: SshTarget): string {
  return `${target.user}@${target.address}`;
}

/** What one ssh run asks for besides its target. */
export type SshOperation =
  /** Run one command on the machine and return its output. */
  | { readonly kind: "exec"; readonly command: readonly string[] }
  /** Ask the local socket of the kept-open connection to close. Never reaches the machine. */
  | { readonly kind: "exit" };

/**
 * The complete argument list for one ssh call, without the program itself.
 *
 * `exit` is `ssh -O exit <destination>`: it talks to the local socket and to
 * nothing else, which is why it may be sent to a machine the operator has just
 * set to `off`. With no socket at the path ssh answers an error and exits
 * non-zero, which a caller reads as "nothing to close".
 */
export function sshArguments(target: SshTarget, operation: SshOperation): string[] {
  const options = sshOptions(target);
  if (operation.kind === "exit") {
    return [...options, "-O", "exit", sshDestination(target)];
  }
  const port = target.port === 22 ? [] : ["-p", String(target.port)];
  return [...options, ...port, sshDestination(target), ...operation.command];
}

/**
 * The complete argument list for one sftp call, without the program itself.
 *
 * sftp takes the same options as ssh, plus its own port flag (`-P`, where ssh uses
 * `-p`) and `-b -`, which reads the batch of commands from stdin. A remote path
 * that starts with `-` is never a problem here: every path this feature sends goes
 * through {@link sftpQuote}, which puts it in quotes.
 *
 * It is exported for a test that holds the option list in one place, and because
 * the sftp program is a different one from ssh: the caller has to name it.
 */
export function sftpArguments(target: SshTarget): string[] {
  const port = target.port === 22 ? [] : ["-P", String(target.port)];
  return [...sshOptions(target), ...port, "-b", "-", sshDestination(target)];
}

/**
 * One path, as an sftp batch line takes it.
 *
 * sftp's own parser, not a shell: a space needs the quotes, and a quote or a
 * backslash inside one needs a backslash in front of it. Nothing else is special,
 * so a glob character stays literal once the whole path is quoted, which is what a
 * path from a tool argument must be.
 */
export function sftpQuote(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * A wrapper script that runs one ssh with these options, and nothing else.
 *
 * rsync starts its own ssh and takes the command from `-e` as one string, which it
 * splits with its own parser rather than a shell's: a value that needs quoting
 * would be a value that arrives corrupted, and the parser is not the shell's. So
 * the options are not quoted into that string at all. A four-line script is written
 * instead, `exec ssh <options> "$@"`, and rsync is given the script's path. The
 * script is the only place these options meet rsync, and it holds no value that
 * needs quoting beyond the plain single-quote escape a shell understands.
 *
 * `rsync` also puts `-l <user>` and the host before the command, so `"$@"` is
 * where those land; the wrapper adds nothing to them.
 */
export function sshShellWrapper(sshProgram: string, options: readonly string[]): string {
  const quoted = options.map((option) => singleQuote(option)).join(" ");
  return `#!/bin/sh\nexec ${singleQuote(sshProgram)} ${quoted} "$@"\n`;
}

/** One shell word, in single quotes, which every shell reads the same way. */
export function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What one ssh run produced. */
export interface SshResult {
  /** The exit status, or null when a signal ended the process. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the deadline ended the run, so the status says nothing about the machine. */
  readonly timedOut: boolean;
}

/** What a run may be given besides its arguments. */
export interface SshRunOptions {
  /** The program to start. Default `ssh`; a test passes the path of a fake. */
  readonly program?: string;
  /** Deadline of one run, in milliseconds. */
  readonly timeoutMs: number;
  /** Extra environment for the child, on top of this process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory of the child. Defaults to this process's own. */
  readonly cwd?: string;
}

/** Ceiling on what one stream may return, in bytes. A heartbeat answers a few dozen. */
const OUTPUT_LIMIT = 65_536;

/**
 * Run one ssh command line and return what it produced.
 *
 * It never rejects: a failure to start the program is an exit status of null with
 * the reason in `stderr`, which is one more thing a caller has to classify, and a
 * caller here always classifies rather than throws.
 *
 * `stdin` is closed at once and never written: `BatchMode=yes` means no prompt is
 * expected, and a command that reads stdin must read an empty one rather than
 * wait for a terminal.
 */
export async function runSsh(args: readonly string[], options: SshRunOptions): Promise<SshResult> {
  return await runProgram(args, options);
}

/**
 * Run one program that reads its commands from stdin, and return what it produced.
 *
 * sftp is the one caller: `-b -` makes it read a batch of commands from standard
 * input and abort on the first failure, which is a whole read, write or rename in
 * one connection. The text is written and the stream is closed before the answer is
 * read, so a program that waits for the end of its input cannot wait for itself.
 *
 * The same never-throws contract as {@link runSsh}, and the same deadline.
 */
export async function runWithInput(
  args: readonly string[],
  input: string,
  options: SshRunOptions,
): Promise<SshResult> {
  return await runProgram(args, options, input);
}

/** The one implementation behind both entry points. */
async function runProgram(
  args: readonly string[],
  options: SshRunOptions,
  input?: string,
): Promise<SshResult> {
  const program = options.program ?? "ssh";
  return await new Promise<SshResult>((resolve) => {
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
        timedOut,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], {
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...process.env, ...(options.env ?? {}) },
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error), timedOut: false });
      return;
    }

    const deadline = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: a connection that ignores the first signal is
      // exactly the case this deadline exists for.
      child.kill("SIGKILL");
    }, Math.max(1, options.timeoutMs));
    timer = deadline;

    if (input !== undefined) {
      // A program that exits before reading its input makes this stream error, and
      // an error on a stream nobody is watching is an uncaught exception. The write
      // failing is not the answer's fault, so it is swallowed here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) return;
      chunks.push(chunk);
      size += chunk.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) return;
      errors.push(chunk);
      size += chunk.byteLength;
    });
    child.on("error", (error) => {
      errors.push(Buffer.from(String(error)));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** The exit status ssh uses for a failure of its own, not of the remote command. */
export const SSH_FAILURE = 255;

/**
 * The line ssh writes when the key it saw is not the key it was told to expect.
 *
 * Matched as a substring because ssh puts it at the end of a longer report (a
 * banner, the offending key, the known_hosts line number). This one sentence is
 * the whole detection of a changed host key, so a test pins it: if a later
 * OpenSSH changes the wording, the test fails and the sentence is updated here
 * and nowhere else.
 */
export const HOST_KEY_MISMATCH_LINE = "Host key verification failed.";

/** What one heartbeat found. */
export type HeartbeatReading =
  /** The command ran and printed a machine-id. */
  | { readonly kind: "ok"; readonly machineId: string }
  /** The machine presented a key other than the pinned one. */
  | { readonly kind: "host-key-mismatch"; readonly detail: string }
  /** Anything else: no route, a refused login, a deadline, a wrong machine-id line. */
  | { readonly kind: "failed"; readonly detail: string };

/** The last line of some ssh output that carries text, or the fallback. */
export function lastLine(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? fallback : (lines[lines.length - 1] as string);
}

/**
 * Classify one `cat /etc/machine-id` run.
 *
 * The order matters: a mismatch is checked before the exit status, because ssh
 * exits 255 for both a refusal and a changed key, and the sentence is the only
 * thing that tells them apart. A failed run's detail is the last line of stderr,
 * which is the one line a person can act on ("No route to host", "Permission
 * denied (publickey)").
 */
export function readHeartbeat(result: SshResult): HeartbeatReading {
  if (result.stderr.includes(HOST_KEY_MISMATCH_LINE)) {
    return { kind: "host-key-mismatch", detail: lastLine(result.stderr, HOST_KEY_MISMATCH_LINE) };
  }
  if (result.timedOut) return { kind: "failed", detail: "the heartbeat ran past its deadline" };
  if (result.code !== 0) {
    return { kind: "failed", detail: lastLine(result.stderr, `ssh exited ${String(result.code)}`) };
  }
  const machineId = (result.stdout.split("\n")[0] ?? "").trim();
  if (machineId === "") return { kind: "failed", detail: "the machine printed no machine-id" };
  return { kind: "ok", machineId };
}
