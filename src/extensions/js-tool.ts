import type { Context } from "@earendil-works/chord/context";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  CodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeResult,
  type CodemodeTool,
  type CodemodeWasmModule,
} from "@earendil-works/pi-codemode";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExtensionContext } from "./context.ts";
import { resolveAgentWorkingDirectory } from "../agent/env.ts";
import { applyNowMarker, nowMarkerNote, type NowMarkerScope } from "../now-marker.ts";

/**
 * The bundled `js-tools` extension: one `js` tool.
 *
 * The script runs in a QuickJS VM (a wasm instance) inside a worker thread, and
 * that is the whole of the isolation: the daemon's event loop keeps serving
 * while a script spins, a deadline terminates the worker, and the VM has a real
 * memory cap. It is not a security boundary. A nested tool call is executed by
 * the host, on the daemon's thread, with the same privileges as any other call.
 * See `docs/extensions.md`.
 */
const JS_DESCRIPTION = `Run JavaScript and return its result. The code is an async function body: use await and return a value.

Call tools as tools.name(args) or tools["name"](args). ALL_TOOLS lists what you can call; describe(name) gives a tool's description and argument schema. A call resolves to the tool's text output and throws an Error when the tool fails; invoke(name, args) returns { ok, text, details, diagnostics } instead. Pass an id that a call creates or prints through the value that the call returned: the same id typed into the script is invented. When a tool cut its output, the text ends with one line that starts with [truncated] and says how to read the rest. There are no timers, no fetch, no process and no require: use the tools. console.log and text() output is returned with the value.

Set timeoutMs when the work could hang. Nothing else stops a script that loops forever. The script runs in its own sandbox and dies when the call is cancelled, together with any tool call it has in flight.

One script's nested calls are capped by \`agent.tools.js.maxToolCalls\`, and the error names the value it passed. The cap bounds the blast radius, not the script: the call that passes it fails while the calls before it keep their effects, so split a long script instead of pushing past the cap.`;

function textOf(content: ToolResultMessage["content"]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(no return value)";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One nested call's outcome as the script sees it. */
interface NestedOutcome {
  readonly ok: boolean;
  /** The tool's text, plus one `[truncated]` line when the tool cut its output. */
  readonly text: string;
  readonly details: unknown;
  readonly diagnostics: ToolDiagnostic[];
}

/**
 * Append the cutting tool's own remark, as one line, to the text the script gets.
 *
 * The `read` tool puts its "Showing lines ..." remark in a diagnostic and leaves
 * the content as bare file text, so a script that never looks at `diagnostics`
 * would see a silently cut file. Code `truncated` is the marker: the harness uses
 * it for its own result cut as well, and both say how to read the rest.
 */
function withTruncationNote(text: string, diagnostics: readonly ToolDiagnostic[]): string {
  const cut = diagnostics.find((diagnostic) => diagnostic.code === "truncated");
  if (cut === undefined) return text;
  const note = `[truncated] ${cut.message}`;
  return text === "" ? note : `${text}\n${note}`;
}

/**
 * Run one of the model's tools for a script.
 *
 * The arguments are validated with the harness's own validator, so a script and
 * a direct call agree on what a tool accepts. The result is the tool's text. A
 * tool that reports an error becomes a thrown `Error` in the script, which is
 * the rule the SDK's own `codemode` tool uses.
 *
 * The call is *not* a tool task: it does not enter the transcript, does not run
 * the `beforeTool`/`afterTool` hooks, and is not counted in `pi.usage`. Its
 * output is captured per call instead of being streamed, because the live
 * output channel is not redacted and this one is.
 *
 * A tool that cut its output says so in the last line of the text the script
 * gets, and in the outcome's `diagnostics` as well.
 *
 * Because no hook runs here, the `[[pi-sec:now]]` marker is applied to the
 * validated arguments before the call: a `write` or `edit` a script makes saves
 * the current time exactly as a direct call does, and the line that reports the
 * count goes into the text the script gets. `src/now-marker.ts` is the rule, and
 * `coding` installs the same one for direct calls.
 */
function nestedRunner(
  outer: ToolExecutionApi,
  ctx: Context,
  limit: number,
  nowMarker: () => NowMarkerScope,
) {
  let count = 0;
  const run = async (tool: ToolRegistration, args: unknown, signal: AbortSignal, callId: string): Promise<NestedOutcome> => {
    count += 1;
    if (count > limit) throw new Error(`script exceeded its tool call limit (${limit})`);
    const validated = validateToolArguments(tool, { id: callId, name: tool.name, arguments: args } as ToolCall);
    const marked = applyNowMarker(tool.name, validated as Record<string, unknown>, nowMarker());
    const chunks: string[] = [];
    const recorded: ToolDiagnostic[] = [];
    let reported: unknown;
    const nested: ToolExecutionApi = {
      ...outer,
      callId,
      output: (chunk) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      },
      outputWindow: undefined,
      // The remark still reaches the outer `js` call's own diagnostics, and it is
      // kept here as well: a tool may report through `api.diagnostic()` or in its
      // result, and the script sees both.
      diagnostic: (diagnostic) => {
        recorded.push(diagnostic);
        outer.diagnostic(diagnostic);
      },
      details: async (value) => {
        reported = value;
      },
    };
    const result = await tool.execute(
      (marked === undefined ? validated : marked.arguments) as typeof validated,
      nested,
      withAbortSignal(signal, ctx),
    );
    const diagnostics = [...recorded, ...(result.diagnostics ?? [])];
    const saved = result.output === undefined ? chunks.join("") : textOf(result.output);
    const text =
      marked === undefined
        ? saved
        : saved === ""
          ? nowMarkerNote(marked.count, marked.time)
          : `${saved}\n${nowMarkerNote(marked.count, marked.time)}`;
    return {
      ok: result.isError !== true,
      text: withTruncationNote(text, diagnostics),
      details: reported ?? result.details,
      diagnostics,
    };
  };
  return run;
}

/** The `js` tool, plus the section that explains the sandbox to the model. */
export function createJsToolExtension(context: ExtensionContext): Extension<ToolRegistration> {
  // Compiled once per process; every call's sandbox reuses it. Loading it is
  // lazy so a boot that never uses the tool never reads the wasm.
  let wasm: Promise<CodemodeWasmModule> | undefined;

  const tool = defineTool({
    name: "js",
    description: JS_DESCRIPTION,
    parameters: obj(
      {
        code: str(),
        timeoutMs: opt(num()),
      },
    ),
    // Arbitrary code with arbitrary side effects must not be replayed.
    replay: "unsafe",
    /**
     * The output limits, read from config every time they are asked for.
     *
     * This is a getter, not a literal, because the harness reads `outputLimits`
     * while it sets up each call (`@earendil-works/pi-durable`, `harness/tool.js`,
     * `run()`), and holds the tool object by identity, so the value a call sees is
     * the config the runtime holds at that moment. A literal would freeze the
     * value the process started with, and a reload could not move it: `maxResultBytes`
     * and `maxResultLines` were declared in the schema and defaulted long before
     * anything read them, which made those two keys silent no-ops.
     *
     * `retain: "head"` keeps the beginning of the result and drops the end, and the
     * harness appends one `truncated` diagnostic with the dropped line and byte
     * counts. The schema sets a minimum of 1 on both keys, so a value that would
     * keep nothing or read as a tail cut is refused at load instead.
     */
    get outputLimits() {
      const js = context.getConfig().agent.tools.js;
      return { maxBytes: js.maxResultBytes, maxLines: js.maxResultLines, retain: "head" as const };
    },
    execute: async (args, api, ctx) => {
      const config = context.getConfig().agent.tools.js;
      const redact = (text: string): string => context.secrets.redactor().redact(text);
      if (!config.enabled) {
        return { output: [{ type: "text" as const, text: "the js tool is disabled in config" }], isError: true };
      }
      if (args.code.trim() === "") {
        return { output: [{ type: "text" as const, text: "code is empty" }], isError: true };
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        return {
          output: [{ type: "text" as const, text: `timeoutMs must be a positive number of milliseconds, got ${args.timeoutMs}` }],
          isError: true,
        };
      }
      const deadline = args.timeoutMs ?? config.timeoutMs ?? Infinity;

      const agent = await api.agent(ctx);
      const offered = agent.tools.filter((candidate) => candidate.name !== "js");
      const byName = new Map<string, ToolRegistration>();
      for (const candidate of offered) if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);

      // The marker rule is read per call: a reload can move the trees it
      // compares against, and the zone it prints is the config's own.
      const nowMarker = (): NowMarkerScope => {
        const current = context.getConfig();
        return {
          workingDirectory: resolveAgentWorkingDirectory(current.agent.workspace, context.paths),
          workspaceTree: context.paths.workspaceTree,
          snapshotTree: context.paths.snapshotTree,
          timeZone: current.timezone,
        };
      };
      const run = nestedRunner(api, ctx, config.maxToolCalls, nowMarker);
      let calls = 0;
      const codemodeTool = (candidate: ToolRegistration): CodemodeTool => ({
        name: candidate.name,
        description: candidate.description,
        execute: async (nestedArgs, nestedContext) => {
          calls += 1;
          const outcome = await run(candidate, nestedArgs, nestedContext.signal, `js:${candidate.name}:${calls}`);
          if (!outcome.ok) throw new Error(outcome.text === "" ? `${candidate.name} failed` : outcome.text);
          return outcome.text;
        },
      });

      const sandbox = new CodemodeSandbox({
        tools: offered.map(codemodeTool),
        globals: [
          {
            name: "describe",
            description: "Description and argument schema of one tool.",
            execute: (name) => {
              const candidate = typeof name === "string" ? byName.get(name) : undefined;
              if (candidate === undefined) throw new Error(`unknown tool: ${String(name)}`);
              return { name: candidate.name, description: candidate.description, parameters: candidate.parameters };
            },
          },
          {
            name: "invoke",
            description: "Call a tool and get { ok, text, details, diagnostics } instead of a thrown error.",
            spread: true,
            execute: async (values, nestedContext) => {
              const [name, nestedArgs] = Array.isArray(values) ? values : [values, undefined];
              const candidate = typeof name === "string" ? byName.get(name) : undefined;
              if (candidate === undefined) throw new Error(`unknown tool: ${String(name)}`);
              calls += 1;
              const outcome = await run(candidate, nestedArgs, nestedContext.signal, `js:${candidate.name}:${calls}`);
              return { ok: outcome.ok, text: outcome.text, details: outcome.details ?? null, diagnostics: outcome.diagnostics };
            },
          },
        ],
        timeoutMs: deadline,
        memoryLimitBytes: config.memoryLimitBytes,
        wasm: (wasm ??= loadQuickJSWasm()),
      });

      let result: CodemodeResult;
      try {
        result = await sandbox.execute(args.code, { signal: ctx.abortSignal });
      } finally {
        void sandbox.close().catch(() => undefined);
      }

      const output = result.output
        .map((item) => (item.type === "text" ? item.text : `[image: ${item.mimeType}]`))
        .join("\n");
      const lines: string[] = [];
      if (output !== "") lines.push(output);
      if (result.ok) {
        lines.push(valueText(result.value));
      } else {
        const { error } = result;
        const detail =
          error.kind === "script"
            ? `Script error: ${error.name ?? "Error"}: ${error.message}${error.stack === undefined ? "" : `\n${error.stack}`}`
            : error.kind === "timeout"
              ? `Script stopped: ${error.message}`
              : error.kind === "aborted"
                ? `Script cancelled: ${error.message}`
                : `Sandbox problem: ${error.message}`;
        lines.push(detail);
      }
      const summary = result.calls
        .map((call) => `${call.name}: ${call.status} (${Math.round(call.durationMs)}ms)`)
        .join(", ");
      const diagnostics = [
        `deadline: ${Number.isFinite(deadline) ? `${deadline}ms` : "none"}`,
        ...(summary === "" ? [] : [`tool calls: ${summary}`]),
      ];
      return {
        output: [{ type: "text" as const, text: redact([...lines, `(${diagnostics.join("; ")})`].join("\n")) }],
        isError: !result.ok,
      };
    },
  });

  const guide = section(
    "js-tools",
    () =>
      "The `js` tool runs JavaScript that can call your other tools as `tools.<name>(args)`. Use it when the steps depend on each other and one script is clearer than a series of calls. It has no timers; set `timeoutMs` when the work could hang. Cancelling the call stops the script and any tool call it has in flight. Nested calls are capped per script by `agent.tools.js.maxToolCalls`: the call that passes the cap fails while the calls before it keep their effects, so split a script that may pass the cap into two.",
  );

  return defineExtension({ name: "js-tools", tools: [tool], sections: [guide] });
}
