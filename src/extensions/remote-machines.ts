import { randomUUID } from "node:crypto";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  ROOT_CONVERSATION_ID,
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DEFAULT_READ_MAX_BYTES, READ_MAX_BYTES_LIMIT } from "../remote/files.ts";
import type { LoadResult } from "../remote/machines.ts";
import { isMachineLevel, type MachineUserState, type RemoteMachineState } from "../shared/wire/remote-machines.ts";
import { zoneMinute } from "../time-format.ts";
import type { ExtensionContext } from "./context.ts";

/**
 * `remote-machines` — the tools an agent uses to work on another computer.
 *
 * The tools are thin on purpose. Every decision lives in `src/remote/`: the level
 * check is `RemoteMachines.access`, a run is `RemoteRuns`, a file is
 * `RemoteFiles`. This module names the nine tools, writes their English answers,
 * and adds the prompt section that tells an agent when to reach for one. A tool
 * here never runs `ssh` of its own, so there is one place that builds an ssh
 * command line and one place that can be wrong about it.
 *
 * Three things are worth knowing before reading a tool:
 *
 *   1. The step check is not repeated here. Every `src/remote/` call the tools
 *      make runs `access` first, at `off` it answers with a refusal instead of
 *      contacting the machine, and the tools pass that sentence on as it stands.
 *      A second check here would be a second place to keep true.
 *   2. `remote_run` is the one tool declared `replay: "safe"`. Its run id is a
 *      digest of the conversation and the tool call, and the remote `mkdir` of the
 *      run directory is what makes a repeat harmless: the second execution finds
 *      the record and answers the state of the one run, without starting a second
 *      process.
 *   3. The prompt section is rendered only for a conversation whose tool list
 *      holds a remote tool. A scheduled run keeps the reading tools and loses the
 *      writing ones (`src/agent/tool-profile.ts`), so the section it needs is the
 *      same one, and a focused chat, whose list is an allow list, gets neither.
 */

/** The section's key, which is also the tag the section is wrapped in. */
export const SECTION_KEY = "remote-machines";

/**
 * The section body: the approved wording, word for word.
 *
 * The sentence about the
 * level has one after it, so that the root's own act (making a level
 * stricter when the user asked) is named beside the user's. The automatic off added
 * the core's own act beside both, and the stranded run to the paragraph about runs.
 *
 * Without its final newline, because the section wrapper puts one before
 * `</remote-machines>`. It names no level of any machine: a section is sealed when
 * a session starts, so a level written here would be the level of that moment for
 * as long as the session lives. `remote_machines` is where an agent reads it.
 */
export const SECTION_TEXT = `[remote machines]

A remote machine is another computer this install reaches over ssh. Use the remote tools for it, and never run an ssh call of your own in bash. The tools carry the pinned host key, the kept-open connection and the machine's level. A call you build by hand carries none of them.

The level is the user's allowance for one machine.
- off: do not touch the machine. Every remote tool refuses.
- restricted: light work only. A command started with remote_run runs at low priority under a time limit.
- on: heavy work too, such as a build.

Only the user widens a level, with the sidebar slider. The core makes a level off by itself when a machine does not answer for longer than the outage threshold, and the user raises it again with the slider after that. The root makes one stricter, to off or to restricted, only when the user asked, and with remote_level_tighten. Every other agent leaves the level alone.

Start with remote_machines when you do not know what is registered. Before heavy work on a machine at on, name that machine in remote_machines and read its load, memory and logged-in sessions. The user can be using that machine at the same time.

Use remote_run for anything that can outlive the turn. It keeps running when the connection drops. Read it with remote_run_status and stop it with remote_run_stop. A run check message arrives in this conversation while the run goes on, and it says whether the run is running, finished, lost, stopped or unreachable. A run on a machine the core made off is stranded: the core stops watching it, its end is unknown, and one message says so. Read the run with remote_run_status after the user raises the level again. The core does not stop a run because its output went quiet.

When the user makes a machine stricter, a run that no longer fits it is stopped after a deadline. The root asks you to stop your own runs first, so do that when it asks.

Before you work as a secondary user of a machine, read that user's own file on this machine if it exists: ~/.pi/sec/memory/remote-machines/<machine>/<user>.md. It holds what that user is for and what not to disturb.

Change a remote file with remote_read, remote_write and remote_edit, and copy a tree with remote_sync, instead of a shell redirect: those tools write a temporary file and rename it, so a reader never sees half a file.

When the work needs a wider level than the machine has, do not work around it. Tell your parent agent, and the root asks the user.`;

/** One tool's description: the approved wording, word for word. */
const DESCRIPTION_REMOTE_MACHINES = `Show the remote machines this install can use. For each machine it gives the level, whether a level change is still being applied, the users with their reachability, and why connections are stopped if they are. Name one machine to read its live load, memory and logged-in sessions. That read is one short command, so it asks the machine. Call it without an argument to find out what is registered. Name a machine before heavy work on a machine at level on.`;
const DESCRIPTION_REMOTE_RUN = `Run one command on a remote machine in a way that keeps it alive after the ssh session ends. A command that finishes within the wait returns its output and exit code. A longer command returns a run id, and the core then checks the run at least every 30 minutes and reports to this conversation. The command is a shell command line, and bash runs it in the user's home or in cwd. At level restricted it runs at low priority under a time limit. At level on it runs as it is. Starting the same call twice does not start a second run.`;
const DESCRIPTION_REMOTE_RUN_STATUS = `Read one run: whether it is running, finished, lost, stopped or stranded, its exit code, how large its output is and when it last grew, and the end of its output. The read asks the machine now, so an answer that the machine cannot be reached says nothing about the run itself.`;
const DESCRIPTION_REMOTE_RUN_STOP = `Stop one run. The core asks the run's process group to stop, and kills it if it is still there after ten seconds. The run is then reported as stopped. Work the run already did is not undone.`;
const DESCRIPTION_REMOTE_READ = `Read a remote file over sftp and return its text. A file larger than the cap is refused rather than cut, so an edit that follows sees every byte. Name the user when the file is in a secondary user's home.`;
const DESCRIPTION_REMOTE_WRITE = `Replace a remote file's content over sftp. The text goes to a temporary file in the same directory and is renamed into place, so a reader sees the old bytes or the new ones and never a half-written file. It creates no directory: name one that exists.`;
const DESCRIPTION_REMOTE_EDIT = `Replace exactly one occurrence of a string in a remote file, over sftp. It reads the file, refuses when the string appears zero times or more than once, writes the result to a temporary file, reads the original again and refuses if that changed meanwhile, and then renames the temporary file into place.`;
const DESCRIPTION_REMOTE_SYNC = `Copy a tree between this machine and a remote machine with rsync. push copies from this machine to the remote, pull the other way. delete removes files at the destination that the source does not have, and it is off unless you name it. Level restricted refuses this tool, because the size of a copy is not known before it starts.`;
const DESCRIPTION_REMOTE_LEVEL_TIGHTEN = `Make a remote machine's level stricter, to off or to restricted. Only the root can call it, and only when the user asked. It cannot widen a level. The sidebar slider is the user's own act. Runs that do not fit the new level are stopped after the deadline.`;

/** The nine tool names, so the section can tell whether a conversation has them. */
const TOOL_NAMES: readonly string[] = [
  "remote_machines",
  "remote_run",
  "remote_run_status",
  "remote_run_stop",
  "remote_read",
  "remote_write",
  "remote_edit",
  "remote_sync",
  "remote_level_tighten",
];

/** The prefix `src/extensions/js-tool.ts` puts on a tool it calls from a script. */
const JS_CALL_PREFIX = "js:";

/**
 * The tool call id a run id is computed from.
 *
 * A call the model made carries the id of that call, and an `async_call` carries
 * `async:<title>`, whose title is unique by the rule of that tool. Both are the same
 * value when the harness runs an interrupted call again, and that is what makes a
 * run id the name of one run instead of the name of one attempt: the second
 * execution is answered with the run the first one started.
 *
 * A tool called from inside a `js` script carries `js:<tool>:<n>`, where `n` is only
 * the position of the call in that script. Two scripts of one conversation would
 * therefore give their first `remote_run` the same id, and the second script would
 * be answered with the first script's run and would start nothing. A `js` call is
 * never run again: the tool declares `replay: "unsafe"`, and the harness reruns an
 * interrupted call only when the stored policy and the current one both say `safe`
 * (`@earendil-works/pi-durable`, `harness/tool.js`, the `execute` phase of
 * `ToolTask`). With no rerun to answer, a value made fresh for each call costs the
 * property above nothing.
 */
function runToolCallId(callId: string): string {
  return callId.startsWith(JS_CALL_PREFIX) ? `${callId}@${randomUUID()}` : callId;
}

/** An answer that failed, so the caller sees the refusal and not a success. */
function refusal(message: string) {
  return { isError: true, output: [{ type: "text" as const, text: message }] };
}

/** An answer that succeeded. */
function answer(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

/** One user's line under a machine. */
function userLine(user: MachineUserState, zone: string): string {
  const since = user.since === null || user.since === undefined ? "" : `, since ${zoneMinute(user.since, zone)}`;
  const error = typeof user.error === "string" && user.error !== "" ? `: ${user.error}` : "";
  return `    ${user.name}: ${user.state}${since}${error}`;
}

/** One machine: its level, its users, and anything that is stopping it. */
function machineLines(state: RemoteMachineState, zone: string): string[] {
  const changed = state.levelChangedAt === null ? "" : `, set ${zoneMinute(state.levelChangedAt, zone)}`;
  const lines = [
    `- ${state.id} at ${state.address}:${String(state.port)}, level ${state.level}${changed}`,
    `  host key ${state.hostKey === "pinned" ? "pinned" : "not pinned"}`,
  ];
  for (const user of state.users) lines.push(userLine(user, zone));
  if (state.pending !== null) {
    lines.push(
      `  a stricter level is being applied: ${state.pending.level} since ${zoneMinute(state.pending.since, zone)}, ` +
        `${String(state.pending.runs)} run(s) do not fit it yet, and the core stops what is left at ` +
        `${zoneMinute(state.pending.deadline, zone)}`,
    );
  }
  if (state.blocked !== null) {
    lines.push(
      `  connections are stopped: ${state.blocked.reason} at ${zoneMinute(state.blocked.at, zone)} (${state.blocked.detail})`,
    );
  }
  return lines;
}

/** The load, memory and sessions one named machine answered with. */
function loadLines(machine: string, load: Extract<LoadResult, { kind: "ok" }>): string[] {
  const memory =
    load.memoryAvailableKb === null || load.memoryTotalKb === null
      ? "memory: not reported"
      : `memory: ${String(load.memoryTotalKb - load.memoryAvailableKb)} KiB used of ${String(load.memoryTotalKb)} KiB`;
  const lines = [
    `Load on ${machine}, read now:`,
    `  load average: ${load.load === "" ? "not reported" : load.load}`,
    `  ${memory}`,
    `  cpus: ${load.cpus === null ? "not reported" : String(load.cpus)}`,
    "  logged-in sessions:",
  ];
  if (load.sessions.length === 0) lines.push("    (none)");
  for (const session of load.sessions) lines.push(`    ${session}`);
  return lines;
}

/** The bundled `remote-machines` extension: nine tools and one section. */
export function createRemoteMachinesExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const machines = defineTool({
    name: "remote_machines",
    description: DESCRIPTION_REMOTE_MACHINES,
    parameters: obj(
      {
        machine: opt(
          str({ description: "Machine id to read the live load of; omit it to list the machines" }),
        ),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      const manager = context.remoteMachines;
      const listed = await manager.list(ctx);
      if (!listed.enabled) {
        return refusal(
          "remote_machines: off. This install has no remoteMachines key in config.json, so no machine is registered " +
            "and every remote tool refuses.",
        );
      }
      const zone = context.getConfig().timezone;
      const lines: string[] = [];
      if (listed.machines.length === 0) {
        lines.push("No remote machine is registered in config.json.");
      } else {
        lines.push(`${String(listed.machines.length)} remote machine(s) are registered:`);
        for (const state of listed.machines) lines.push(...machineLines(state, zone));
      }
      if (args.machine !== undefined) {
        const load = await manager.load(args.machine);
        if (load.kind !== "ok") return refusal(load.reason);
        lines.push("", ...loadLines(args.machine, load));
      }
      return answer(lines.join("\n"));
    },
  });

  const run = defineTool({
    name: "remote_run",
    description: DESCRIPTION_REMOTE_RUN,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        command: str({ description: "Shell command line; bash runs it" }),
        user: opt(str({ description: "ssh user; the machine's main user when absent" })),
        cwd: opt(
          str({ description: "Directory to run in, on the remote machine; the user's home when absent" }),
        ),
      },
    ),
    // A repeat starts nothing: the run id is the call's, and the remote directory
    // is what makes the second execution answer the one run.
    replay: "safe",
    execute: async (args, api, ctx: Context) => {
      const started = await context.remoteMachines.runs().start({
        conversationId: String(api.conversationId),
        toolCallId: runToolCallId(api.callId),
        machine: args.machine,
        command: args.command,
        ...(args.user === undefined ? {} : { user: args.user }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ctx,
      });
      if (started.kind === "refused" || started.kind === "failed") return refusal(started.reason);
      if (started.kind === "running") {
        return answer(
          `Run ${started.runId} is still running on remote machine "${started.machine}" for user ${started.user}. ` +
            "The core checks it at least every 30 minutes and reports to this conversation. " +
            "Read it with remote_run_status, and stop it with remote_run_stop.",
        );
      }
      const head =
        started.code >= 0
          ? `Run ${started.runId} finished with exit code ${String(started.code)}.`
          : `Run ${started.runId} ended without an exit code: its process is gone.`;
      const size = started.truncated
        ? `${String(started.bytes)} bytes of output, and the text below is the end of it:`
        : `${String(started.bytes)} bytes of output:`;
      return answer([`${head} ${size}`, "", started.output].join("\n"));
    },
  });

  const runStatus = defineTool({
    name: "remote_run_status",
    description: DESCRIPTION_REMOTE_RUN_STATUS,
    parameters: obj(
      {
        run: str({ description: "Run id, as remote_run returned it" }),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      const read = await context.remoteMachines.runs().status(args.run, ctx);
      if (read.kind !== "ok") return refusal(read.reason);
      const zone = context.getConfig().timezone;
      const exit = read.exitCode === null ? "no exit code" : `exit code ${String(read.exitCode)}`;
      const grown = read.grewAt === null ? "not written yet" : `last written ${zoneMinute(read.grewAt, zone)}`;
      return answer(
        [
          `Run ${read.runId} on remote machine "${read.machine}" for user ${read.user}: ${read.state}, ${exit}.`,
          `Output: ${String(read.bytes)} bytes, ${grown}.`,
          "",
          read.output,
        ].join("\n"),
      );
    },
  });

  const runStop = defineTool({
    name: "remote_run_stop",
    description: DESCRIPTION_REMOTE_RUN_STOP,
    parameters: obj(
      {
        run: str({ description: "Run id, as remote_run returned it" }),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      const stopped = await context.remoteMachines.runs().stop({ runId: args.run, who: "agent", ctx });
      if (stopped.kind !== "stopped") return refusal(stopped.reason);
      return answer(
        `Run ${stopped.runId} was stopped; it was ${stopped.was}. Work it already did is not undone.`,
      );
    },
  });

  const read = defineTool({
    name: "remote_read",
    description: DESCRIPTION_REMOTE_READ,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        path: str({ description: "Path of the file, on the remote machine" }),
        user: opt(str({ description: "ssh user; the machine's main user when absent" })),
        maxBytes: opt(
          num({
            description: `Largest file to accept in bytes: ${String(DEFAULT_READ_MAX_BYTES)} by default, at most ${String(READ_MAX_BYTES_LIMIT)}`,
          }),
        ),
      },
    ),
    // A whole file has to arrive whole, or a caller that writes it back writes a
    // cut file. The declared bound is what `RemoteFiles.read` may return at its
    // own limit, so the Harness cut lands past every answer this tool can give.
    outputLimits: {
      maxBytes: READ_MAX_BYTES_LIMIT + 4 * 1024,
      // Every line is at least one byte of the same file, so a file of the byte
      // bound has fewer lines than this and the byte bound is the one that holds.
      maxLines: READ_MAX_BYTES_LIMIT + 1,
      retain: "head" as const,
    },
    execute: async (args, _api, ctx: Context) => {
      const file = await context.remoteMachines.files().read({
        machine: args.machine,
        path: args.path,
        ...(args.user === undefined ? {} : { user: args.user }),
        ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
        ctx,
      });
      if (file.kind !== "ok") return refusal(file.reason);
      return { output: file.content === "" ? [] : [{ type: "text" as const, text: file.content }] };
    },
  });

  const write = defineTool({
    name: "remote_write",
    description: DESCRIPTION_REMOTE_WRITE,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        path: str({ description: "Path of the file, on the remote machine; its directory must exist" }),
        content: str({ description: "The new content, as text" }),
        user: opt(str({ description: "ssh user; the machine's main user when absent" })),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      const written = await context.remoteMachines.files().write({
        machine: args.machine,
        path: args.path,
        content: args.content,
        ...(args.user === undefined ? {} : { user: args.user }),
        ctx,
      });
      if (written.kind !== "ok") return refusal(written.reason);
      return answer(`${written.path} was written: ${String(written.bytes)} bytes.`);
    },
  });

  const edit = defineTool({
    name: "remote_edit",
    description: DESCRIPTION_REMOTE_EDIT,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        path: str({ description: "Path of the file, on the remote machine" }),
        oldText: str({ description: "The text to replace; it must appear exactly once" }),
        newText: str({ description: "The text to put in its place" }),
        user: opt(str({ description: "ssh user; the machine's main user when absent" })),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      const edited = await context.remoteMachines.files().edit({
        machine: args.machine,
        path: args.path,
        oldText: args.oldText,
        newText: args.newText,
        ...(args.user === undefined ? {} : { user: args.user }),
        ctx,
      });
      if (edited.kind !== "ok") return refusal(edited.reason);
      return answer(
        `${edited.path} was edited: one occurrence of the old text was replaced, and it is ${String(edited.bytes)} bytes now.`,
      );
    },
  });

  const sync = defineTool({
    name: "remote_sync",
    description: DESCRIPTION_REMOTE_SYNC,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        direction: str({ description: "push copies from this machine to the remote; pull copies the other way" }),
        source: str({ description: "The side the copy starts from" }),
        destination: str({ description: "The side the copy goes to" }),
        user: opt(str({ description: "ssh user; the machine's main user when absent" })),
        delete: opt(
          bool({
            description: "Remove files at the destination that the source does not have; off when absent",
          }),
        ),
      },
    ),
    execute: async (args, _api, ctx: Context) => {
      if (args.direction !== "push" && args.direction !== "pull") {
        return refusal(`direction must be "push" or "pull", and it was ${JSON.stringify(args.direction)}`);
      }
      const copied = await context.remoteMachines.files().sync({
        machine: args.machine,
        direction: args.direction,
        source: args.source,
        destination: args.destination,
        ...(args.user === undefined ? {} : { user: args.user }),
        ...(args.delete === undefined ? {} : { delete: args.delete }),
        ctx,
      });
      if (copied.kind !== "ok") return refusal(copied.reason);
      const removed =
        args.delete === true
          ? " Files at the destination that the source does not have are gone."
          : "";
      return answer(`The ${copied.direction} copy finished.${removed}`);
    },
  });

  const tighten = defineTool({
    name: "remote_level_tighten",
    description: DESCRIPTION_REMOTE_LEVEL_TIGHTEN,
    parameters: obj(
      {
        machine: str({ description: "Machine id, as remote_machines lists it" }),
        level: str({ description: '"off" or "restricted"; nothing wider is accepted' }),
        reason: str({ description: "Why the level should be tighter; it is written to the audit trail" }),
      },
    ),
    execute: async (args, api, ctx: Context) => {
      // The second of the two layers: the tool profile takes this tool from every
      // subagent and every scheduled run, and this holds for a conversation whose
      // stored filter was written before that profile existed.
      if (api.conversationId !== ROOT_CONVERSATION_ID) {
        return refusal(
          "remote_level_tighten is the root's alone, and this conversation is not the root, so no level was changed. " +
            "Report what you need to your parent agent.",
        );
      }
      // A value that is not a level at all is answered here, because `tighten` takes
      // a level and nothing else. A level that would widen the machine is left to
      // the core, so the sentence the caller reads is the one place that decides it.
      if (!isMachineLevel(args.level)) {
        return refusal(
          `level must be "off" or "restricted", and it was ${JSON.stringify(args.level)}. Only the user widens a level, ` +
            "with the sidebar slider.",
        );
      }
      const outcome = await context.remoteMachines.tighten(args.machine, args.level, args.reason, ctx);
      if (outcome.kind === "refused") return refusal(outcome.reason);
      if (outcome.kind === "not-found") return refusal(`no remote machine is registered as ${args.machine}`);
      if (outcome.kind === "disabled") {
        return refusal("the remote machines feature is off: config.json has no remoteMachines key");
      }
      const changed = outcome.changed
        ? `its level is now ${outcome.machine.level}`
        : `its level was already ${outcome.machine.level}, so nothing changed`;
      const pending =
        outcome.machine.pending === null
          ? ""
          : ` ${String(outcome.machine.pending.runs)} run(s) do not fit it, and the core stops what is left at the deadline.`;
      return answer(`Remote machine ${args.machine}: ${changed}.${pending}`);
    },
  });

  const guide = section(SECTION_KEY, (input) =>
    input.agent.tools.some((tool) => TOOL_NAMES.includes(tool.name)) ? SECTION_TEXT : undefined,
  );

  return defineExtension({
    name: "remote-machines",
    tools: [machines, run, runStatus, runStop, read, write, edit, sync, tighten],
    sections: [guide],
  });
}
