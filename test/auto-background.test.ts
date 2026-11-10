import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createAgentRuntime, type AgentRuntime } from "../src/agent/harness.ts";
import { buildPaths, ensureLayout } from "../src/runtime/paths.ts";
import { SecretRegistry } from "../src/secrets/registry.ts";
import { createLogger } from "../src/runtime/logger.ts";
import { createAuditLog } from "../src/runtime/audit.ts";
import { createEventBus } from "../src/runtime/event-bus.ts";
import { openPrivateSqliteStorage } from "../src/runtime/sqlite-file.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAsyncCall } from "../src/documents.ts";
import { NEVER_MOVED, backgroundCheckText, createAsyncToolsExtension, movedCallText } from "../src/extensions/async-tools.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A direct tool call that runs past `agent.tools.backgroundAfterMs` moves to the
 * background instead of holding the turn, and every running background call earns
 * a status check every `agent.tools.backgroundCheckMs`.
 *
 * The limits here are milliseconds, so a test can watch the move happen. The
 * production defaults are ten and thirty minutes.
 */

interface Row {
  readonly kind: string;
  readonly text: string;
}

function rows(entries: readonly { kind: string; model?: unknown[] }[]): Row[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    text: (entry.model ?? [])
      .map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((part) =>
            part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
              ? String((part as { text?: string }).text ?? "")
              : "",
          )
          .join("");
      })
      .join("\n"),
  }));
}

function toolResult(entries: readonly Row[]): string {
  return entries.filter((row) => row.kind === "pi.tool-result").map((row) => row.text).join("\n");
}

function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text?: string }).text)
        : "",
    )
    .join(" ");
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Whether a process is running whose command line carries `marker`.
 *
 * A `bash` tool call runs its command in a shell of its own, so the text of that
 * command is in a command line while the call runs. That is the fact a test waits
 * for when it has to act on a call that is still running, and a fixed pause is a
 * guess at how long the call takes to start.
 */
async function processWith(marker: string): Promise<boolean> {
  const carries = async (pid: string): Promise<boolean> => {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(marker);
    } catch {
      // Another account's process, or one that ended before the read.
      return false;
    }
  };
  // The call's shell is a descendant of this test process. Reading only those
  // processes takes a few reads, where a pass over all of /proc can take seconds on
  // a busy machine and miss a shell that lives for two seconds.
  const seen = new Set<string>();
  const queue = [String(process.pid)];
  let treeReadable = true;
  while (queue.length > 0) {
    const pid = queue.pop() as string;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (pid !== String(process.pid) && (await carries(pid))) return true;
    let tasks: string[];
    try {
      tasks = await readdir(`/proc/${pid}/task`);
    } catch {
      continue; // The process ended.
    }
    for (const task of tasks) {
      try {
        const children = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
        queue.push(...children.split(/\s+/).filter((child) => /^\d+$/.test(child)));
      } catch (error) {
        // No children file (kernel without it): fall back to reading every process.
        if (pid === String(process.pid) && (error as NodeJS.ErrnoException).code === "ENOENT") treeReadable = false;
      }
    }
  }
  if (treeReadable) return false;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    if (await carries(entry)) return true;
  }
  return false;
}

/** Every tool call gets the next scripted answer, whatever conversation asks. */
function scripted(responses: ReturnType<typeof fauxAssistantMessage>[]): FauxResponseFactory {
  let index = 0;
  return () => {
    const step = responses[index] ?? fauxAssistantMessage([fauxText("done")]);
    index += 1;
    return step;
  };
}

function tools(overrides: Partial<Config["agent"]["tools"]>): Partial<Config> {
  const base = defaultConfig();
  return { agent: { ...base.agent, tools: { ...base.agent.tools, ...overrides } } } as Partial<Config>;
}

async function boot(options: {
  readonly responses: ReturnType<typeof fauxAssistantMessage>[];
  readonly tools?: Partial<Config["agent"]["tools"]>;
}): Promise<TestHarness> {
  const harness = await createTestHarness({ config: tools(options.tools ?? {}) });
  // One scripted step is consumed per model call, so the same router (one shared
  // step counter) is offered many times.
  const router = scripted(options.responses);
  harness.faux.setResponses(Array.from({ length: 30 }, () => router));
  return harness;
}

async function conversationOf(harness: TestHarness) {
  return await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
}

async function entries(harness: TestHarness): Promise<Row[]> {
  const conversation = await conversationOf(harness);
  const page = await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT);
  return rows(page.items);
}

async function submit(harness: TestHarness, content = "go"): Promise<void> {
  const conversation = await conversationOf(harness);
  const submission = await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

let open: TestHarness | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("moving a long call to the background", () => {
  it("answers the turn with the call's title and delivers the result later", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 150, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1.5; echo MOVED-OK" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("background_list", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("the turn went on")]),
      ],
    });
    await submit(open);
    const placeholder = await until(async () => {
      const text = toolResult(await entries(open!));
      return text.includes("moved to the background") ? text : undefined;
    }, "the placeholder");
    // The title is derived from the tool name and a counter.
    expect(placeholder).toContain("auto-bash-1");
    // The turn continued: the model was asked again while the call was still running.
    expect(open.faux.state.callCount).toBeGreaterThanOrEqual(2);

    const conversation = await conversationOf(open);
    const record = await open.runtime.harness.snapshot(SecAsyncCall, conversation.id, "auto-bash-1", BACKGROUND_CONTEXT);
    expect(record?.tool).toBe("bash");
    expect(record?.taskId).toBeTypeOf("string");

    // `background_list` shows it, which is what makes it a background call.
    const listed = await until(async () => {
      const text = toolResult(await entries(open!));
      return text.includes('kind="async_tool_call"') ? text : undefined;
    }, "the background list");
    expect(listed).toContain('title="auto-bash-1"');

    const delivered = await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("MOVED-OK"));
      return found;
    }, "the delivered result");
    expect(delivered.kind).toBe("pi.user");
    expect(delivered.text).toContain('src="tool-output"');
    const settled = await until(async () => {
      const found = await open!.runtime.harness.snapshot(SecAsyncCall, conversation.id, "auto-bash-1", BACKGROUND_CONTEXT);
      return found?.status === "done" ? found : undefined;
    }, "the settled record");
    expect(settled.deliveredAt).toBeTypeOf("number");
  });

  it("stops a moved call with async_cancel, and the killed shell writes nothing", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 150, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage(
          [fauxToolCall("bash", { command: "sleep 3; echo LATE > cancel-late.txt" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxToolCall("async_cancel", { title: "auto-bash-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    await submit(open);
    await until(async () => {
      const text = toolResult(await entries(open!));
      return text.includes("auto-bash-1") ? text : undefined;
    }, "the placeholder");
    const cancelled = await until(async () => {
      const text = toolResult(await entries(open!));
      return text.includes('"auto-bash-1" is cancelled') ? text : undefined;
    }, "the cancel answer");
    expect(cancelled).toContain("cancelled");
    const conversation = await conversationOf(open);
    const record = await until(async () => {
      const found = await open!.runtime.harness.snapshot(SecAsyncCall, conversation.id, "auto-bash-1", BACKGROUND_CONTEXT);
      return found?.status === "cancelled" ? found : undefined;
    }, "the cancelled record");
    expect(record.settledAt).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await exists(join(open.paths.workspaceTree, "cancel-late.txt"))).toBe(false);
  });

  it("returns a call that finishes inside the limit unchanged, redaction included", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 60_000, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo 'token ghp_secret_value'" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    await writeFile(join(open.paths.secretsDir, "gh_token"), "ghp_secret_value\n", "utf8");
    await open.runtime.secrets.reload();
    await submit(open);
    const result = toolResult(await entries(open));
    expect(result).toContain("token");
    expect(result).not.toContain("ghp_secret_value");
    expect(result).not.toContain("moved to the background");
  });

  it("stops the call when the turn is aborted before the move", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 5000, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2; echo LATE > abort-early.txt" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const conversation = await conversationOf(open);
    void conversation.submit({ type: "input", content: "start and stop" }, BACKGROUND_CONTEXT);
    // The abort has to land while the call runs and before the five second limit moves
    // it: wait for the call's own shell, not for a fixed pause.
    await until(async () => ((await processWith("abort-early.txt")) ? true : undefined), "the running call");
    await conversation.abort(BACKGROUND_CONTEXT);
    expect(toolResult(await entries(open))).not.toContain("moved to the background");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await exists(join(open.paths.workspaceTree, "abort-early.txt"))).toBe(false);
  });

  it("keeps a moved call running when the turn is aborted after the move", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 150, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1.5; echo AFTER-ABORT-OK" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ],
    });
    const conversation = await conversationOf(open);
    const submission = await conversation.submit({ type: "input", content: "start" }, BACKGROUND_CONTEXT);
    await until(async () => {
      const text = toolResult(await entries(open!));
      return text.includes("auto-bash-1") ? text : undefined;
    }, "the placeholder");
    await conversation.abort(BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT).catch(() => undefined);
    const delivered = await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("AFTER-ABORT-OK"));
      return found;
    }, "the result of the aborted turn's call");
    expect(delivered.text).toContain('src="tool-output"');
  });
});

describe("what is never moved", () => {
  it("leaves the tools whose result ends the turn out of the wrapper list", () => {
    const config = defaultConfig();
    const context = {
      getConfig: () => config,
      toolNames: () => [...NEVER_MOVED, "bash"],
    } as unknown as ExtensionContext;
    const extension = createAsyncToolsExtension(context);
    const wrapped = (extension.wraps ?? []).map((wrap) => ("tool" in wrap ? wrap.tool : ""));
    expect(wrapped).toEqual(["bash"]);
    expect(NEVER_MOVED).toContain("await_orders");
    expect(NEVER_MOVED).toContain("restart_session");
    expect(NEVER_MOVED).toContain("async_call");
  });

  it("does not move a call in a conversation that has no background tools", { timeout: 20_000 }, async () => {
    const config = defaultConfig();
    config.agent.tools.backgroundAfterMs = 1;
    const context = {
      getConfig: () => config,
      toolNames: () => ["slow_tool"],
      logger: { warn: () => undefined },
    } as unknown as ExtensionContext;
    const extension = createAsyncToolsExtension(context);
    const wrap = (extension.wraps ?? []).find((candidate) => "tool" in candidate && candidate.tool === "slow_tool");
    if (wrap === undefined || !("wrap" in wrap)) throw new Error("the extension does not wrap slow_tool");
    let finished = false;
    const inner = {
      name: "slow_tool",
      description: "a tool that takes a while",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        finished = true;
        return { content: [{ type: "text" as const, text: "plain result" }] };
      },
    } as unknown as ToolRegistration;
    const attached = wrap.wrap(inner);
    // A scheduled run's tool list: the background tools are removed from it.
    const api = {
      callId: "call-1",
      conversationId: 1,
      agent: async () => ({ tools: [{ name: "slow_tool" }] }),
    } as unknown as ToolExecutionApi;
    const result = await attached.execute({}, api, BACKGROUND_CONTEXT);
    expect(finished).toBe(true);
    expect(JSON.stringify(result)).toContain("plain result");
  });

  it("does not wrap the calls a script makes, because the script is one unit", () => {
    const config = defaultConfig();
    const context = { getConfig: () => config, toolNames: () => ["bash"] } as unknown as ExtensionContext;
    const extension = createAsyncToolsExtension(context);
    expect(extension.wraps?.length).toBe(1);
  });
});

describe("the status check of a running background call", () => {
  it("reaches a moved call every interval, with the sentence that fits how it moved", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 100, backgroundCheckMs: 300 },
      responses: [
        fauxAssistantMessage([fauxToolCall("bash", { command: "while [ ! -e checked-signal.txt ]; do sleep 0.05; done; echo CHECKED-OK" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    await submit(open);
    const checks = await until(async () => {
      const found = (await entries(open!)).filter((row) => row.text.includes("[background call check]"));
      return found.length >= 2 ? found : undefined;
    }, "two status checks");
    // The shell waits for this file, so the call is still running while the checks
    // arrive, however late the timers run. Its result comes only after it exists.
    await writeFile(join(open.paths.workspaceTree, "checked-signal.txt"), "go\n");
    expect(checks[0]?.text).toContain("auto-bash-1");
    expect(checks[0]?.text).toContain("(bash)");
    expect(checks[0]?.text).toContain("It moved to the background after 10 minutes.");
    expect(checks[0]?.text).toContain("Check whether it is still making progress");
    await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("CHECKED-OK"));
      return found;
    }, "the call's result");
    // The checks stop with the call: nothing new arrives after its result.
    const after = (await entries(open)).filter((row) => row.text.includes("[background call check]")).length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect((await entries(open)).filter((row) => row.text.includes("[background call check]")).length).toBe(after);
  });

  it("reaches a call the agent started with async_call, and says so", { timeout: 30_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 0, backgroundCheckMs: 300 },
      responses: [
        fauxAssistantMessage(
          [fauxToolCall("async_call", { title: "longer", tool: "bash", args: { command: "sleep 1.2; echo CALLED-OK" } })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    await submit(open);
    const check = await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("[background call check]"));
      return found;
    }, "the status check");
    expect(check.text).toContain("longer (bash)");
    expect(check.text).toContain("You started it with async_call.");
    await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("CALLED-OK"));
      return found;
    }, "the call's result");
  });

  it("says nothing when the interval is 0", { timeout: 20_000 }, async () => {
    open = await boot({
      tools: { backgroundAfterMs: 0, backgroundCheckMs: 0 },
      responses: [
        fauxAssistantMessage(
          [fauxToolCall("async_call", { title: "quiet", tool: "bash", args: { command: "sleep 0.4; echo QUIET-OK" } })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("noted")]),
      ],
    });
    await submit(open);
    await until(async () => {
      const found = (await entries(open!)).find((row) => row.text.includes("QUIET-OK"));
      return found;
    }, "the call's result");
    expect((await entries(open)).some((row) => row.text.includes("[background call check]"))).toBe(false);
  });
});

describe("the text the model and the turn read", () => {
  /**
   * The input a section reads its tool list from. The section is rendered only for
   * a conversation that has `async_call`, so the tool list here names it.
   */
  const OFFERED = { agent: { tools: [{ name: "async_call" }] } } as never;

  it("follows the config: 20 minutes to move, 5 to check", () => {
    const config = defaultConfig();
    config.agent.tools.backgroundAfterMs = 1_200_000;
    config.agent.tools.backgroundCheckMs = 300_000;
    const context = { getConfig: () => config } as unknown as ExtensionContext;
    const extension = createAsyncToolsExtension(context);
    const section = extension.sections?.find((candidate) => candidate.key === "async-tools");
    const rendered = String(section?.render(OFFERED, {} as never));
    expect(rendered).toContain("longer than 20 minutes");
    expect(rendered).toContain("every 5 minutes");
  });

  it("names the call and both channels in the placeholder and in the check", () => {
    expect(movedCallText("auto-bash-3", "bash", 10)).toContain('Its title is "auto-bash-3"');
    expect(movedCallText("auto-bash-3", "bash", 10)).toContain('async_cancel("auto-bash-3")');
    expect(backgroundCheckText("auto-bash-3", "bash", 30, true)).toContain("It moved to the background after 10 minutes.");
    expect(backgroundCheckText("chosen", "bash", 30, false)).toContain("You started it with async_call.");
  });
});

describe("a restart in the middle of a moved call", () => {
  it("reports the call as interrupted and never starts it again", { timeout: 60_000 }, async () => {
    // A real restart needs storage that outlives the process, so this test builds
    // its own runtime over SQLite files instead of the in-memory test harness.
    const home = await mkdtemp(join(tmpdir(), "pi-sec-restart-"));
    const paths = buildPaths(home);
    await ensureLayout(paths);
    await mkdir(paths.workspaceTree, { recursive: true, mode: 0o700 });
    await mkdir(join(paths.promptsDir, "vmodel"), { recursive: true });
    await writeFile(join(paths.promptsDir, "vmodel", "faux.md"), "", "utf8");
    const faux = fauxProvider({ provider: "faux" });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const base = defaultConfig();
    const config: Config = {
      ...base,
      vmodels: { ...base.vmodels, faux: { provider: "faux", modelId: model.id, thinkingLevel: "medium", prompt: "faux" } },
      agent: {
        ...base.agent,
        vmodel: "faux",
        tools: { ...base.agent.tools, backgroundAfterMs: 150, backgroundCheckMs: 0 },
      },
      code: { snapshot: paths.snapshotTree, workspace: paths.workspaceTree },
    };
    const secrets = new SecretRegistry({ dir: paths.secretsDir, includeModelCredentials: false });
    await secrets.load();
    const logger = createLogger({ console: false, file: paths.appLog });
    const audit = createAuditLog({ file: paths.auditLog, redactor: () => secrets.redactor() });
    const events = createEventBus();
    const router = scripted([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 4; echo RESTART-LATE > restart-late.txt" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    faux.setResponses(Array.from({ length: 30 }, () => router));

    const bootRuntime = async (): Promise<AgentRuntime> =>
      await createAgentRuntime({
        paths,
        config,
        storage: await openPrivateSqliteStorage(paths.stateDb),
        archiveStorage: await openPrivateSqliteStorage(paths.archiveDb),
        models,
        secrets,
        logger,
        audit,
        events: events.sink,
        loadExtensions: false,
        watchExtensions: false,
      });

    const first = await bootRuntime();
    let second: AgentRuntime | undefined;
    try {
      const conversation = await resolveDefaultConversation(first.harness, config, paths, BACKGROUND_CONTEXT);
      const submission = await conversation.submit({ type: "input", content: "start it" }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);
      const before = rows((await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT)).items);
      expect(toolResult(before)).toContain("auto-bash-1");

      // The restart: this runtime closes, and a second one opens over the same
      // files. The moved call's promise died with the first process, so recovery
      // reports the call instead of repeating work that may have partly run.
      await first.close();
      second = await bootRuntime();
      const record = await until(async () => {
        const found = await second!.harness.snapshot(SecAsyncCall, conversation.id, "auto-bash-1", BACKGROUND_CONTEXT);
        return found?.status === "interrupted" ? found : undefined;
      }, "the interrupted record");
      expect(record.settledAt).toBeTypeOf("number");
      expect(record.error ?? "").toContain("interrupted");
      // It was not started again: no second shell wrote the file.
      await new Promise((resolve) => setTimeout(resolve, 4500));
      expect(await exists(join(paths.workspaceTree, "restart-late.txt"))).toBe(false);
    } finally {
      await second?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
