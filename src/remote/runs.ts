/**
 * The run directory: how a detached run is started, read and stopped on the
 * remote machine, and how the answers it leaves are read back.
 *
 * ## Why a directory
 *
 * A run has to survive the ssh session that started it, the daemon that started
 * it, and a connection that drops for a minute. Nothing on this side can hold the
 * process, so the remote machine holds the facts: one directory per run, written
 * by the scripts below and read by the checks. The facts are four.
 *
 *   - `pid` holds the process number and the process's start time, written as one
 *     file so a reader sees both or neither.
 *   - `exit` holds the exit status, written when the command ends.
 *   - `stop` holds who stopped the run, written before the signal is sent.
 *   - `output` is the command's own stdout and stderr, and its size and write
 *     time are the progress a check reports.
 *
 * ## Why the start cannot happen twice
 *
 * `mkdir runs/<id>` fails when the directory is there, and the run id is a digest
 * of the conversation and the tool call that asked for it. So one tool call makes
 * one directory however many times it runs, and a `remote_run` that the daemon
 * repeats after a restart finds the run it already started instead of a second
 * one. That is the whole safety of the property, and it is why the tool declares
 * itself safe to repeat.
 *
 * ## Why the process start time is read too
 *
 * A process number is reused. `kill -0` on a reused number says a process is
 * alive, and it is the wrong process. So the runner records
 * `/proc/<pid>/stat` field 22 (its start time in clock ticks since boot) beside
 * its number, and a check compares that value with the live one: a number that is
 * alive with a different start time is a lost run, not a running one.
 *
 * ## Why the scripts are one string and the command is base64
 *
 * ssh hands its command arguments to the remote login shell, joined by spaces, so
 * a script is one argument and the remote shell runs it. The user's command is
 * arbitrary text and must not be quoted at all: it travels base64-encoded and is
 * decoded into the run directory, and the runner reads it back from that file.
 * The same goes for the working directory and for the runner itself.
 *
 * The scripts are POSIX `sh`: the remote login shell is whatever the user has,
 * and nothing here may assume bash for it. The runner does name bash for the
 * user's own command line, because `remote_run` documents that bash runs it.
 */

import { createHash } from "node:crypto";

/**
 * One script, as the command words one ssh call carries.
 *
 * ssh joins the words after the destination with spaces and hands the result to the
 * remote login shell, which splits it again on whitespace. So a script cannot be one
 * argument: its newlines would be word breaks, and `sh -c echo\necho` runs `echo`
 * with the wrong arguments. The script is base64-encoded instead, and the remote
 * shell decodes it into a shell of its own. Nothing in the script has to be quoted
 * for a shell that has not read it yet, because no shell reads the encoding.
 *
 * `printf` and not `echo`, because an implementation of `echo` may read a backslash
 * in its argument and the base64 alphabet has none while its padding might in a
 * different alphabet. `printf '%s'` writes its argument byte for byte.
 */
export function remoteScript(script: string): string[] {
  return ["printf '%s' '" + Buffer.from(script, "utf8").toString("base64") + "' | base64 -d | sh"];
}

/** Directory under the remote user's home that holds every run. */
export const RUN_STATE_DIR = ".local/state/pi-sec";

/** The run directories, under {@link RUN_STATE_DIR}. */
export const RUNS_DIR = `${RUN_STATE_DIR}/runs`;

/**
 * How much of a run's output a check carries back, in bytes.
 *
 * The answer travels through one ssh call whose own output is capped at 64 KiB,
 * and base64 costs four characters per three bytes. Six thousand bytes is an
 * eighth of that cap, which leaves room for the facts beside it.
 */
export const RUN_TAIL_BYTES = 6_000;

/** Deadline of the ssh call that starts a run. It waits for the pid file. */
export const START_DEADLINE_MS = 30_000;

/** Deadline of the ssh call that reads one run. */
export const CHECK_DEADLINE_MS = 20_000;

/** How long the stop script waits between the polite signal and the forced one. */
export const STOP_GRACE_SECONDS = 10;

/** Deadline of the ssh call that stops a run: the grace period plus the rest. */
export const STOP_DEADLINE_MS = (STOP_GRACE_SECONDS + 20) * 1_000;

/** How long a start waits for the pid file, in tenths of a second. */
const PID_WAIT_TENTHS = 100;

/**
 * The run id of one tool call.
 *
 * A digest of the conversation and the tool call, so it is the same on a repeat
 * and different for any other call. Only hex digits and the `run-` prefix reach
 * the file name: a conversation id and a tool call id can carry any character,
 * and a path is the last place to find that out.
 */
export function runIdFor(conversationId: string, toolCallId: string): string {
  const digest = createHash("sha256").update(`${conversationId}\u0000${toolCallId}`).digest("hex").slice(0, 20);
  return `run-${digest}`;
}

/** Whether a value looks like a run id this module made. */
export function isRunId(value: string): boolean {
  return /^run-[0-9a-f]{20}$/.test(value);
}

/**
 * The command prefix that makes a run light work, for the `restricted` level.
 *
 * `ionice -c3` puts the run in the idle I/O class, `nice -n 10` lowers its CPU
 * priority, and `timeout -k 5 <seconds>` ends it after the level's limit and kills
 * it five seconds later if it ignored the first signal. Nothing here uses a
 * systemd unit: a machine can have `linger` off, so a
 * `systemd-run --user` unit can die with the last login session. Priority and a clock are what is left.
 *
 * `timeout` puts itself in a process group of its own before it starts the
 * command, so a run at this level is not one process group: the runner's group
 * holds the runner alone, and `timeout` and the command sit in a group of their
 * own that no signal to the runner's group reaches. The run is still one session,
 * because `timeout` does not leave it, and that is what {@link stopScript} finds
 * the run's processes by.
 */
export function restrictedWrap(seconds: number): string {
  const limit = Math.max(1, Math.round(seconds));
  return `ionice -c3 nice -n 10 timeout -k 5 ${String(limit)}`;
}

/** The runner: it records itself, runs the command and records the exit status. */
export const RUNNER_SCRIPT = `# started by the pi-sec daemon, one per run directory
RD=$1
s=$(cat /proc/$$/stat 2>/dev/null)
rest=\${s##*) }
tick=$(printf '%s' "$rest" | cut -d' ' -f20)
printf '%s %s\\n' "$$" "$tick" > "$RD/.pid" && mv "$RD/.pid" "$RD/pid"
wrap=$(cat "$RD/wrap" 2>/dev/null)
cmd=$(cat "$RD/command" 2>/dev/null)
cwd=$(cat "$RD/cwd" 2>/dev/null)
if [ -n "\${cwd:-}" ]; then cd "$cwd" 2>/dev/null || true; fi
if [ -n "\${wrap:-}" ]; then
  $wrap bash -c "$cmd"
else
  bash -c "$cmd"
fi
code=$?
printf '%s\\n' "$code" > "$RD/.exit" && mv "$RD/.exit" "$RD/exit"
`;

/** Base64 of a text, as a shell `printf` argument with nothing to quote. */
function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * The lines that report what a run directory holds.
 *
 * They are one `key=value` per line and they are read by
 * {@link parseRunFacts}, which takes the last value it sees for a key. So a
 * login banner, a shell profile that prints, or any other noise before or after
 * them costs nothing: only the keys it knows are read.
 *
 * `$D` must already name the run directory. `alive` is the bare answer of
 * `kill -0`; whether that process is *this* run is {@link readRunState}'s
 * question, because it compares the start time.
 */
function factsLines(): string {
  return `if [ -d "$D" ]; then echo "exists=yes"; else echo "exists=no"; exit 0; fi
if [ -f "$D/exit" ]; then echo "exit=$(cat "$D/exit" 2>/dev/null)"; else echo "exit=none"; fi
if [ -f "$D/stop" ]; then echo "stop=$(cat "$D/stop" 2>/dev/null)"; else echo "stop=none"; fi
pid=none
tick=none
if [ -s "$D/pid" ]; then
  set -- $(cat "$D/pid" 2>/dev/null)
  pid=\${1:-none}
  tick=\${2:-none}
fi
echo "pid=$pid"
echo "tick=$tick"
alive=no
nowtick=none
if [ "$pid" != "none" ] && kill -0 "$pid" 2>/dev/null; then
  s=$(cat "/proc/$pid/stat" 2>/dev/null)
  if [ -n "$s" ]; then
    r=\${s##*) }
    nowtick=$(printf '%s' "$r" | cut -d' ' -f20)
    if [ -n "$nowtick" ]; then alive=yes; else nowtick=none; fi
  fi
fi
echo "alive=$alive"
echo "nowtick=$nowtick"
bytes=0
mtime=none
if [ -f "$D/output" ]; then
  bytes=$(wc -c < "$D/output" 2>/dev/null | tr -d ' ')
  m=$(stat -c %Y "$D/output" 2>/dev/null) && mtime=$m
fi
echo "bytes=\${bytes:-0}"
echo "mtime=\${mtime:-none}"
echo "tail=$(tail -c ${String(RUN_TAIL_BYTES)} "$D/output" 2>/dev/null | base64 -w0)"`;
}

/** The opening of every script: the variables and the directory of the run. */
function scriptHead(runId: string): string {
  return `umask 077
ROOT="$HOME/${RUN_STATE_DIR}"
RUNS="$ROOT/runs"
D="$RUNS/${runId}"`;
}

/**
 * The script that starts one run.
 *
 * `mkdir` is the whole of the once-only rule, so it is the first thing after the
 * directories above it. When it fails the run exists, and the answer says so and
 * reports the run's state instead of starting a second process — which is what a
 * repeated tool call after a daemon restart gets.
 */
export function startScript(input: {
  readonly runId: string;
  readonly command: string;
  readonly cwd: string;
  readonly level: string;
  readonly wrap: string;
}): string {
  return `${scriptHead(input.runId)}
mkdir -p "$ROOT" "$RUNS" 2>/dev/null || { echo "error=cannot-create-directory"; exit 4; }
chmod 700 "$ROOT" "$RUNS" 2>/dev/null || true
if mkdir "$D" 2>/dev/null; then
  echo "created=yes"
  printf '%s' '${b64(input.command)}' | base64 -d > "$D/command" || { echo "error=cannot-write-command"; exit 5; }
  printf '%s' '${b64(input.cwd)}' | base64 -d > "$D/cwd" || true
  printf '%s' '${b64(input.wrap)}' | base64 -d > "$D/wrap" || true
  printf '%s\\n' '${input.level}' > "$D/level" || true
  printf '%s' '${b64(RUNNER_SCRIPT)}' | base64 -d > "$D/runner" || { echo "error=cannot-write-runner"; exit 6; }
  ( setsid bash "$D/runner" "$D" </dev/null >"$D/output" 2>&1 & )
  n=0
  while [ ! -s "$D/pid" ] && [ "$n" -lt ${String(PID_WAIT_TENTHS)} ]; do
    sleep 0.1
    n=$((n+1))
  done
else
  echo "created=no"
fi
${factsLines()}`;
}

/** The script that reads one run. It touches nothing. */
export function checkScript(runId: string): string {
  return `${scriptHead(runId)}
${factsLines()}`;
}

/**
 * The script that waits a little for a run to end, then reads it.
 *
 * `remote_run` answers a short command with its output and a long one with a run
 * id. One call after the start is what decides which: it sleeps until the exit
 * file appears or the window closes, so the daemon spends one ssh call on the
 * wait rather than one per poll.
 */
export function waitScript(input: { readonly runId: string; readonly seconds: number }): string {
  return `${scriptHead(input.runId)}
n=0
while [ ! -f "$D/exit" ] && [ ! -f "$D/stop" ] && [ "$n" -lt ${String(Math.max(1, Math.round(input.seconds)))} ]; do
  sleep 1
  n=$((n+1))
done
${factsLines()}`;
}

/**
 * The script that stops one run.
 *
 * The marker goes down before the signal, so a check that runs while the process
 * is still dying reports a stopped run rather than a lost one. Only a run that is
 * this run's own is signalled, and it is signalled as a session: the runner is a
 * session leader, so its number is the session's, and every process the run
 * started is in that session whatever process group it made for itself.
 *
 * The session and not only the process group, because `timeout` at `restricted`
 * puts itself and the command it watches in a group of their own. A signal to the
 * runner's group reaches the runner alone, and `timeout` and the command outlive
 * it until the level's limit runs out, while the run's record already says it was
 * stopped. So the group is signalled first, as it always was, and then every
 * member of the session is.
 *
 * The members are read from `/proc/<n>/stat` field 6 here, because `pkill -s`
 * needs procps and a remote machine may not have it. The field is the session id,
 * the fourth of the fields after the command name. A process that has exited and
 * waits to be read is skipped: it is a session member until its parent reaps it,
 * and waiting for one would keep the grace period busy for nothing.
 */
export function stopScript(input: {
  readonly runId: string;
  readonly who: string;
  readonly at: number;
}): string {
  return `${scriptHead(input.runId)}
session_members() {
  for f in /proc/[0-9]*/stat; do
    s=
    IFS= read -r s < "$f" 2>/dev/null || :
    if [ -z "$s" ]; then continue; fi
    r=\${s##*) }
    set -- $r
    if [ "\${1:-}" = "Z" ] || [ "\${1:-}" = "X" ]; then continue; fi
    if [ "\${4:-}" != "$pid" ]; then continue; fi
    if [ "$f" = "/proc/$$/stat" ]; then continue; fi
    n=\${f#/proc/}
    printf '%s\\n' "\${n%/stat}"
  done
}
if [ ! -d "$D" ]; then echo "exists=no"; exit 0; fi
echo "exists=yes"
pid=none
tick=none
if [ -s "$D/pid" ]; then
  set -- $(cat "$D/pid" 2>/dev/null)
  pid=\${1:-none}
  tick=\${2:-none}
fi
mine=no
if [ "$pid" != "none" ] && kill -0 "$pid" 2>/dev/null; then
  s=$(cat "/proc/$pid/stat" 2>/dev/null)
  if [ -n "$s" ]; then
    r=\${s##*) }
    nowtick=$(printf '%s' "$r" | cut -d' ' -f20)
    if [ -n "$nowtick" ] && [ "$nowtick" = "$tick" ]; then mine=yes; fi
  fi
fi
if [ "$mine" = "yes" ] && [ ! -f "$D/stop" ]; then
  printf '%s %s\\n' '${input.who}' '${String(input.at)}' > "$D/.stop" && mv "$D/.stop" "$D/stop"
fi
if [ "$mine" = "yes" ]; then
  kill -s TERM -- "-$pid" 2>/dev/null || kill -s TERM "$pid" 2>/dev/null
  for p in $(session_members); do
    kill -s TERM "$p" 2>/dev/null || true
  done
  n=0
  while [ "$n" -lt $(( ${String(STOP_GRACE_SECONDS)} * 10 )) ]; do
    left=$(session_members)
    if [ -z "$left" ]; then break; fi
    sleep 0.1
    n=$((n+1))
  done
  left=$(session_members)
  if [ -n "$left" ]; then
    kill -s KILL -- "-$pid" 2>/dev/null || true
    for p in $left; do
      kill -s KILL "$p" 2>/dev/null || true
    done
    sleep 0.2
  fi
fi
echo "stopped=$mine"
${factsLines()}`;
}

/** What one run directory holds, as the scripts above report it. */
export interface RunFacts {
  readonly exists: boolean;
  /** The exit status, or null when the command has not left one. */
  readonly exitCode: number | null;
  /** Who stopped the run (`agent` or `core`) and when, or null. */
  readonly stop: { readonly who: string; readonly at: number } | null;
  readonly pid: number | null;
  /** The start time the runner recorded, as text: it is compared, never computed on. */
  readonly tick: string | null;
  /** The bare answer of `kill -0` for {@link pid}. */
  readonly alive: boolean;
  readonly nowTick: string | null;
  readonly bytes: number;
  /** The output file's write time, in epoch milliseconds, or null. */
  readonly mtime: number | null;
  /** The end of the output, already decoded. */
  readonly output: string;
}

/** The keys {@link parseRunFacts} reads, so a stray line cannot invent one. */
const FACT_KEYS: ReadonlySet<string> = new Set([
  "exists",
  "exit",
  "stop",
  "pid",
  "tick",
  "alive",
  "nowtick",
  "bytes",
  "mtime",
  "tail",
  "created",
  "stopped",
  "error",
]);

/**
 * Read the facts out of one script's standard output.
 *
 * Key by key, last value wins, and only the keys this module knows. That is what
 * makes the scripts' answers robust against a login banner or a shell profile
 * that prints: nothing in them can look like `bytes=`.
 *
 * A malformed number reads as absent rather than as a guess: a `pid` that is not
 * a number leaves {@link RunFacts.pid} null, which no state reads as alive.
 */
export function parseRunFacts(stdout: string): RunFacts {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!FACT_KEYS.has(key)) continue;
    values.set(key, line.slice(at + 1));
  }
  const text = (key: string): string | null => {
    const value = values.get(key);
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };
  const number = (key: string): number | null => {
    const value = text(key);
    if (value === null || value === "none") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const stopText = text("stop");
  let stop: RunFacts["stop"] = null;
  if (stopText !== null && stopText !== "none") {
    const [who = "", at = ""] = stopText.split(/\s+/);
    stop = { who, at: Number.isFinite(Number(at)) ? Number(at) : 0 };
  }
  const mtimeSeconds = number("mtime");
  const tail = text("tail");
  return {
    exists: text("exists") === "yes",
    exitCode: number("exit"),
    stop,
    pid: number("pid"),
    tick: text("tick") === "none" ? null : text("tick"),
    alive: text("alive") === "yes",
    nowTick: text("nowtick") === "none" ? null : text("nowtick"),
    bytes: number("bytes") ?? 0,
    mtime: mtimeSeconds === null ? null : mtimeSeconds * 1000,
    output: tail === null ? "" : Buffer.from(tail, "base64").toString("utf8"),
  };
}

/** What one run is doing, as the four judgments name it. */
export type RunState =
  /** The command wrote no exit status and its process is this run's own. */
  | { readonly kind: "running" }
  /** The command left an exit status. */
  | { readonly kind: "finished"; readonly code: number }
  /** Somebody stopped it; work it already did is not undone. */
  | { readonly kind: "stopped"; readonly who: string; readonly at: number }
  /** No exit status and no process: a reboot, a sleep, or a kill from outside. */
  | { readonly kind: "lost" }
  /** The run directory is not there, or the answer came from somewhere else. */
  | { readonly kind: "missing" };

/**
 * Judge one run from its facts.
 *
 * The order is fixed, with one addition at the front: a stop marker is
 * a fact about what this install asked for, so it outranks an exit status that
 * the same stop produced.
 *
 * `alive` alone is not enough. A process number that is alive but started at a
 * different time belongs to another program, and the run's own process is gone,
 * which is a lost run.
 */
export function readRunState(facts: RunFacts): RunState {
  if (!facts.exists) return { kind: "missing" };
  if (facts.stop !== null) return { kind: "stopped", who: facts.stop.who, at: facts.stop.at };
  if (facts.exitCode !== null) return { kind: "finished", code: facts.exitCode };
  if (facts.alive) {
    // The number is alive, so the question is whose number it is. A run's own
    // process started at the tick its runner recorded; a program that took the
    // number over started at another one, which is a lost run. The comparison is
    // between two values read together in one call, never between a value read now
    // and one remembered: that is why the record's copy is only a fallback.
    if (facts.tick !== null && facts.nowTick !== null && facts.tick !== facts.nowTick) {
      return { kind: "lost" };
    }
    return { kind: "running" };
  }
  // No live process and no exit status: a reboot, a sleep, or a kill from outside.
  // A check that arrived before the runner wrote its pid reads the same way, and
  // that window is an accepted risk.
  return { kind: "lost" };
}

/** One word for a state, as a stored record and a message use it. */
export type RunStateWord = RunState["kind"];

/** The word for a state. */
export function runStateWord(state: RunState): RunStateWord {
  return state.kind;
}
