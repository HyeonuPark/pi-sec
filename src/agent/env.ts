import { homedir } from "node:os";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { createRedactingStream, type Redactor } from "../secrets/redact.ts";
import type { Config } from "../config/schema.ts";
import { expandPath, underHome, type Paths } from "../runtime/paths.ts";

/**
 * The directory an agent's shell starts in.
 *
 * An empty value means the workspace tree under the pi-sec home. A value that
 * carries the literal `~/.pi/sec` prefix follows `PI_SEC_HOME`, the same way the
 * config defaults are rewritten at load (`underHome`): a default written once
 * must name the same directory in a test, in another install, and here. Any
 * other value expands as written, so `~/notes` is under the run account's home
 * and an absolute path is used as it stands.
 *
 * Both the environment factory and the `coding` preamble call this, so the
 * directory the model is told about is the one its shell runs in.
 */
export function resolveAgentWorkingDirectory(configured: string, paths: Paths): string {
  if (configured.length === 0) return paths.workspaceTree;
  return expandPath(underHome(configured, paths.home), process.cwd(), homedir());
}

/**
 * The longest line of shell output that reaches the conversation.
 *
 * The tail a shell keeps is measured in lines and bytes, so one line of a
 * compressed file, of a query with every column, or of `grep -o` over multi-byte
 * text can fill the whole window by itself. The cap is applied after redaction,
 * so the cut cannot land inside a secret and show the part before it, and the
 * length is the one the model would have read.
 */
const MAX_OUTPUT_LINE = 2000;

/** What one line's cut appends, in place of the characters it removed. */
function lineCutMarker(removed: number): string {
  return ` [line cut: ${removed} more characters]`;
}

/** The state of one line being read, and of the part of it already returned. */
interface LineCapper {
  /** Return the text to pass on now, cut where a line passed the cap. */
  push(text: string): string;
  /** Return the marker of a line that ended without a newline, if it was cut. */
  flush(): string;
}

/**
 * Cut every line at the cap, fed one read at a time.
 *
 * A shell's reads have nothing to do with lines, so a line arrives in one push
 * or in five, and the result has to be the same either way. Both counts carry
 * across pushes: the length counts every character of the line, and the
 * returning part stops at the cap. Text up to the cap goes out as soon as it
 * arrives rather than waiting for a newline, because a command that prints a
 * progress line without one has to keep showing progress.
 *
 * The marker needs the whole line's length, so it goes out when the line ends:
 * with the newline, which is kept, or from `flush` when the output ended first.
 */
function createLineCapper(): LineCapper {
  let seen = 0;
  let sent = 0;
  return {
    push(text: string): string {
      let out = "";
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;
        if (sent < MAX_OUTPUT_LINE) {
          const room = MAX_OUTPUT_LINE - sent;
          const part = text.slice(start, end).slice(0, room);
          out += part;
          sent += part.length;
        }
        seen += end - start;
        if (newline === -1) break;
        if (seen > MAX_OUTPUT_LINE) out += lineCutMarker(seen - MAX_OUTPUT_LINE);
        out += "\n";
        seen = 0;
        sent = 0;
        start = newline + 1;
      }
      return out;
    },
    flush(): string {
      if (seen <= MAX_OUTPUT_LINE) {
        seen = 0;
        sent = 0;
        return "";
      }
      const out = lineCutMarker(seen - MAX_OUTPUT_LINE);
      seen = 0;
      sent = 0;
      return out;
    },
  };
}

/**
 * `NodeExecutionEnv` with a redaction boundary on everything the model can
 * read. Committing output redacted is the primary secret chokepoint.
 */
export class RedactingEnv extends NodeExecutionEnv {
  private readonly getRedactor: () => Redactor;

  constructor(options: { cwd: string; redactor: () => Redactor; shellEnv?: NodeJS.ProcessEnv }) {
    super({ cwd: options.cwd, shellEnv: options.shellEnv ?? process.env });
    this.getRedactor = options.redactor;
  }

  override async readTextFile(
    path: string,
    context: Context,
  ): Promise<Result<string, import("@earendil-works/pi-durable/env").FileError>> {
    const result = await super.readTextFile(path, context);
    if (result.ok) return { ok: true, value: this.getRedactor().redact(result.value) };
    return result;
  }

  override async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], import("@earendil-works/pi-durable/env").FileError>> {
    const result = await super.readTextLines(path, options, context);
    if (result.ok) return { ok: true, value: result.value.map((line) => this.getRedactor().redact(line)) };
    return result;
  }

  override async exec(
    command: string | readonly string[],
    options: import("@earendil-works/pi-durable/env").ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<import("@earendil-works/pi-durable/env").ShellExecResult, import("@earendil-works/pi-durable/env").ExecutionError>> {
    const stream = createRedactingStream(this.getRedactor());
    const onOutput = options?.onOutput;
    // One cap per stream: stdout and stderr interleave, and a line belongs to
    // the stream it came from.
    const cappers = new Map<"stdout" | "stderr", LineCapper>();
    const capperFor = (name: "stdout" | "stderr"): LineCapper => {
      let capper = cappers.get(name);
      if (capper === undefined) {
        capper = createLineCapper();
        cappers.set(name, capper);
      }
      return capper;
    };
    // The redaction stream holds back the last few characters of whatever it has
    // seen, so its tail is the end of the newest stream, and that is where it goes.
    let newest: "stdout" | "stderr" = "stdout";
    const wrapped = {
      ...options,
      onOutput: (text: string, ctx: Context, info: import("@earendil-works/pi-durable/env").ShellOutputInfo) => {
        newest = info.stream;
        const safe = capperFor(info.stream).push(stream.push(text));
        if (safe !== "" && onOutput !== undefined) onOutput(safe, ctx, info);
      },
    };
    const result = await super.exec(command, wrapped, context);
    const tail = capperFor(newest).push(stream.flush());
    if (tail !== "" && onOutput !== undefined) {
      try {
        onOutput(tail, context, { stream: newest });
      } catch {
        /* output callback failures are not redaction failures */
      }
    }
    // A line the output ended without a newline still owes its marker.
    for (const name of ["stdout", "stderr"] as const) {
      const capper = cappers.get(name);
      if (capper === undefined) continue;
      const rest = capper.flush();
      if (rest === "" || onOutput === undefined) continue;
      try {
        onOutput(rest, context, { stream: name });
      } catch {
        /* output callback failures are not redaction failures */
      }
    }
    return result;
  }
}

/**
 * The variables systemd sets for the readiness and watchdog handshake.
 *
 * They describe the relationship between systemd and the process it supervises,
 * so they belong to that process and to nothing it starts.
 */
const SYSTEMD_NOTIFY_VARIABLES = ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"] as const;

/**
 * The variable `user-tools/run` sets for the daemon it supervises.
 *
 * Same rule, different reason: it describes the process the runner started, so
 * a command an agent runs in a shell must not read itself as running under the
 * runner. A `pi-sec start` from that shell would otherwise take the runner path
 * for its own restart button, and exit 75 with nothing above it to start it
 * again.
 */
const RUNNER_VARIABLES = ["PI_SEC_RUNNER"] as const;

/**
 * The environment an agent shell runs in: the daemon's own, minus the two kinds
 * of variable that describe the process and not the work.
 *
 * A tool shell inherits the daemon's environment, and a `start` launched from one
 * would send READY=1 and WATCHDOG=1 through the socket of the unit that
 * supervises the daemon it is starting beside, or read the restart source it does
 * not have. The daemon's own `process.env` is untouched, because `notifySystemd`
 * reads `NOTIFY_SOCKET` from it.
 *
 * Each name keeps its key and loses its value. `getShellEnv` spreads
 * `process.env` underneath whatever this returns, so a key that is absent here is
 * a key the daemon's own value comes back through; Node's `spawn` leaves out a
 * key whose value is `undefined`. Every other variable is carried as it is.
 */
export function agentShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of [...SYSTEMD_NOTIFY_VARIABLES, ...RUNNER_VARIABLES]) env[name] = undefined;
  return env;
}

export interface EnvFactoryOptions {
  readonly paths: Paths;
  readonly getConfig: () => Config;
  readonly redactor: () => Redactor;
}

/** Build the environment factory passed to `HarnessOptions.env`. */
export function createEnvFactory(options: EnvFactoryOptions) {
  return (target: EnvTarget): ExecutionEnv => {
    const config = options.getConfig();
    const cwd = resolveAgentWorkingDirectory(
      target.cwd ?? config.agent.workspace,
      options.paths,
    );
    return new RedactingEnv({ cwd, redactor: options.redactor, shellEnv: agentShellEnv() });
  };
}
