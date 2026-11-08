import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { ok, type ExecutionEnv, type FileError, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createCodingExtension } from "../src/extensions/coding.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The guards on the file tools: one slot per conversation between a file write
 * and a shell, an atomic write, and the refusal of a file that changed under the
 * call and of an edit that would empty it.
 *
 * The race is reproduced with a widened window. `SlowEnv` truncates the file and
 * waits before it writes the new bytes, which is what `fs.writeFile` does in one
 * step, and the wait is where a `sed -i` reads: the reproduction below is exact,
 * not a matter of luck. Every case drives the tools the way the harness does,
 * through the wrappers the `coding` extension declares (`extension.wraps`), so a
 * run of a build without those wrappers reproduces the damage.
 */

/** One tool of the coding extension, with the wrappers the extension declares applied. */
function codingTools(): Map<string, ToolRegistration> {
  const extension = createCodingExtension({} as unknown as ExtensionContext);
  const tools = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool]));
  for (const wrap of extension.wraps ?? []) {
    if (!("tool" in wrap)) continue;
    const target = tools.get(wrap.tool);
    if (target !== undefined) tools.set(wrap.tool, wrap.wrap(target));
  }
  return tools;
}

/** The api a tool gets, with whatever this case needs to differ. */
function apiFor(env: ExecutionEnv, overrides: Record<string, unknown> = {}): ToolExecutionApi {
  const api = {
    env,
    callId: "call-1",
    conversationId: 1,
    taskId: 1,
    outputWindow: undefined,
    output: () => undefined,
    retainedOutput: () => ({ text: "", truncated: false }),
    diagnostic: () => undefined,
    details: async () => undefined,
    ...overrides,
  };
  return api as unknown as ToolExecutionApi;
}

/** A call context with no cancellation. */
function ctx(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until a fact holds, for at most `ms`, and fails with `message` if it never does. */
async function waitUntil(fact: () => boolean, message: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fact()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(5);
  }
}

/** A shell command that runs until `signal` exists. */
function waitForFile(signal: string): string {
  return `while [ ! -e ${JSON.stringify(signal)} ]; do sleep 0.02; done`;
}

/** Fails with `message` if `work` takes longer than `ms`, which is how a wrongly held slot shows. */
async function finishesWithin<T>(work: Promise<T>, message: string, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The environment of a case: the local one, with a record of what the tools did
 * and a write that waits before it writes, so a window can be widened on purpose.
 */
class SlowEnv extends NodeExecutionEnv {
  readonly events: string[] = [];

  /**
   * `holdUntilStarts`: after a write starts, it waits (up to 3 s) until that
   * many writes have started, so a case does not depend on a short real-time window.
   */
  constructor(cwd: string, private readonly writeMs = 0, private readonly holdUntilStarts = 0) {
    super({ cwd });
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    this.events.push(`write:start:${basename(path)}`);
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "w");
    if (this.holdUntilStarts > 0) {
      await waitUntil(
        () => this.events.filter((event) => event.startsWith("write:start:")).length >= this.holdUntilStarts,
        "the other write never started while this one was open",
      );
    }
    if (this.writeMs > 0) await delay(this.writeMs);
    await handle.writeFile(content);
    await handle.close();
    this.events.push(`write:end:${basename(path)}`);
    return ok(undefined);
  }

  override async exec(
    command: string | readonly string[],
    options: Parameters<NodeExecutionEnv["exec"]>[1],
    context: Context,
  ): ReturnType<NodeExecutionEnv["exec"]> {
    this.events.push("shell:start");
    const result = await super.exec(command, options, context);
    this.events.push("shell:end");
    return result;
  }
}

/** An environment whose first read is followed by a change made from outside the call. */
class RacingReadEnv extends NodeExecutionEnv {
  private changed = false;

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await super.readTextFile(path, context);
    if (result.ok && !this.changed) {
      this.changed = true;
      await writeFile(path, "CHANGED ELSEWHERE\n", "utf8");
    }
    return result;
  }
}

describe("a file write and a shell in one conversation", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function directory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "write-guard-"));
    scratch.push(dir);
    return dir;
  }

  it("does not let a shell keep the empty file an edit left while it was writing", async () => {
    const dir = await directory();
    const file = join(dir, "root.md");
    await writeFile(file, "keep\nEDITBASE\ntail\n", "utf8");
    const env = new SlowEnv(dir, 120);
    const tools = codingTools();

    await Promise.allSettled([
      tools.get("edit")?.execute({ path: file, edits: [{ oldText: "EDITBASE", newText: "EDITED" }] }, apiFor(env), ctx()),
      tools.get("bash")?.execute({ command: `sed -i '/^keep$/d' ${JSON.stringify(file)}` }, apiFor(env), ctx()),
    ]);

    const text = await readFile(file, "utf8");
    expect(text).toContain("EDITED");
    expect(text).not.toContain("keep");
  });

  it("runs an edit and a shell one after the other, in the order they arrived", async () => {
    const dir = await directory();
    const file = join(dir, "order.md");
    await writeFile(file, "a\nb\n", "utf8");
    const env = new SlowEnv(dir, 80);
    const tools = codingTools();

    await Promise.allSettled([
      tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx()),
      tools.get("bash")?.execute({ command: "true" }, apiFor(env), ctx()),
    ]);

    // The shell started after the edit's write ended, and the edit did not
    // write again after the shell had run.
    const writes = env.events.filter((event) => event.startsWith("write:"));
    const shellStart = env.events.indexOf("shell:start");
    expect(shellStart).toBeGreaterThan(env.events.lastIndexOf(writes.at(-1) as string));
    expect(writes).toHaveLength(2);
  });

  it("runs two shells together", async () => {
    const dir = await directory();
    const env = new SlowEnv(dir);
    const tools = codingTools();

    await Promise.all([
      tools.get("bash")?.execute({ command: "sleep 0.2" }, apiFor(env), ctx()),
      tools.get("bash")?.execute({ command: "sleep 0.2" }, apiFor(env), ctx()),
    ]);

    expect(env.events).toEqual(["shell:start", "shell:start", "shell:end", "shell:end"]);
  });

  it("runs two edits of different files together", async () => {
    const dir = await directory();
    const first = join(dir, "first.md");
    const second = join(dir, "second.md");
    await writeFile(first, "a\n", "utf8");
    await writeFile(second, "a\n", "utf8");
    const env = new SlowEnv(dir, 80, 2);
    const tools = codingTools();

    await Promise.all([
      tools.get("edit")?.execute({ path: first, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx()),
      tools.get("edit")?.execute({ path: second, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx()),
    ]);

    // Each write stayed open until both had started, so neither waited for the other.
    const starts = env.events.filter((event) => event.startsWith("write:start:"));
    expect(starts).toHaveLength(2);
    expect(env.events.slice(0, 2)).toEqual([starts[0], starts[1]]);
  });

  it("does not make a read wait for a shell, and does not make another conversation wait", async () => {
    const dir = await directory();
    const file = join(dir, "read.md");
    await writeFile(file, "text\n", "utf8");
    const env = new SlowEnv(dir);
    const tools = codingTools();

    const signal = join(dir, "release");
    const shell = tools.get("bash")?.execute({ command: waitForFile(signal) }, apiFor(env), ctx());
    await waitUntil(() => env.events.includes("shell:start"), "the shell never started");

    try {
      const read = await finishesWithin(
        tools.get("read")?.execute({ path: file }, apiFor(env), ctx()) as Promise<unknown>,
        "the read waited for the shell",
      );
      expect(JSON.stringify(read)).toContain("text");
      expect(env.events).not.toContain("shell:end");

      await finishesWithin(
        tools.get("edit")?.execute(
          { path: file, edits: [{ oldText: "text", newText: "next" }] },
          apiFor(env, { conversationId: 2 }),
          ctx(),
        ) as Promise<unknown>,
        "the edit of another conversation waited for the shell",
      );
      expect(env.events).not.toContain("shell:end");
    } finally {
      await writeFile(signal, "", "utf8");
    }

    await shell;
  });

  it("releases the slot when a call fails and when it is aborted", async () => {
    const dir = await directory();
    const file = join(dir, "released.md");
    await writeFile(file, "a\n", "utf8");
    const env = new SlowEnv(dir);
    const tools = codingTools();

    await expect(
      tools.get("edit")?.execute({ path: join(dir, "missing.md"), edits: [{ oldText: "a", newText: "b" }] }, apiFor(env), ctx()),
    ).rejects.toThrow(/Could not edit file/);

    const aborted = { abortSignal: AbortSignal.abort() } as unknown as Context;
    await expect(
      tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "b" }] }, apiFor(env), aborted),
    ).rejects.toThrow(/aborted/i);

    // Both failures left the conversation's slot free, so a shell runs at once.
    const started = Date.now();
    await tools.get("bash")?.execute({ command: "true" }, apiFor(env), ctx());
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does not hold the slot for a call that runs in the background", async () => {
    const dir = await directory();
    const file = join(dir, "background.md");
    await writeFile(file, "a\n", "utf8");
    const env = new SlowEnv(dir);
    const tools = codingTools();

    const signal = join(dir, "release");
    const background = tools
      .get("bash")
      ?.execute({ command: waitForFile(signal) }, apiFor(env, { callId: "async:demo" }), ctx());
    await waitUntil(() => env.events.includes("shell:start"), "the shell never started");

    try {
      await finishesWithin(
        tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx()) as Promise<unknown>,
        "the edit waited for a call that runs in the background",
      );
      expect(env.events).not.toContain("shell:end");
    } finally {
      await writeFile(signal, "", "utf8");
    }

    await background;
  });

  it("stops holding the slot when a call moves to the background", async () => {
    const dir = await directory();
    const file = join(dir, "moved.md");
    await writeFile(file, "a\n", "utf8");
    const env = new SlowEnv(dir);
    const tools = codingTools();

    let taskId: unknown = "foreground";
    const moving = {
      env,
      callId: "call-moved",
      conversationId: 7,
      outputWindow: undefined,
      output: () => undefined,
      retainedOutput: () => ({ text: "", truncated: false }),
      diagnostic: () => undefined,
      details: async () => undefined,
      get taskId() {
        return taskId;
      },
    } as unknown as ToolExecutionApi;

    const signal = join(dir, "release");
    const moved = tools.get("bash")?.execute({ command: waitForFile(signal) }, moving, ctx());
    await waitUntil(() => env.events.includes("shell:start"), "the shell never started");
    // What `async-tools` does at the move: the call's api becomes the api of the
    // background task that owns it from then on, so its task id changes.
    taskId = "background";

    try {
      await finishesWithin(
        tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env, { conversationId: 7 }), ctx()) as Promise<unknown>,
        "the edit waited for a call that moved to the background",
      );
      expect(env.events).not.toContain("shell:end");
    } finally {
      await writeFile(signal, "", "utf8");
    }

    await moved;
  });

  it("waits for a call that is still part of its turn", async () => {
    const dir = await directory();
    const file = join(dir, "waits.md");
    await writeFile(file, "a\n", "utf8");
    const env = new SlowEnv(dir);
    const tools = codingTools();

    const shell = tools.get("bash")?.execute({ command: "sleep 0.3" }, apiFor(env, { conversationId: 8 }), ctx());
    await delay(50);

    const started = Date.now();
    await tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env, { conversationId: 8 }), ctx());
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    await shell;
  });
});

describe("how the file tools write", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function directory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "write-guard-write-"));
    scratch.push(dir);
    return dir;
  }

  it("renames a temporary file into place, keeps the permissions, and leaves no temporary file", async () => {
    const dir = await directory();
    const file = join(dir, "mode.md");
    await writeFile(file, "a\nb\n", "utf8");
    await chmod(file, 0o600);
    const env = new NodeExecutionEnv({ cwd: dir });
    const tools = codingTools();

    await tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx());
    expect(await readFile(file, "utf8")).toBe("A\nb\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.includes(".pi-sec-"))).toEqual([]);

    await tools.get("write")?.execute({ path: join(dir, "new", "deep.md"), content: "made\n" }, apiFor(env), ctx());
    expect(await readFile(join(dir, "new", "deep.md"), "utf8")).toBe("made\n");
  });

  it("never leaves the target empty while it writes", async () => {
    const dir = await directory();
    const file = join(dir, "atomic.md");
    await writeFile(file, "old\n", "utf8");
    const env = new SlowEnv(dir, 150);
    const tools = codingTools();

    const edit = tools
      .get("edit")
      ?.execute({ path: file, edits: [{ oldText: "old", newText: "new" }] }, apiFor(env), ctx());
    // Inside the window the write needs: the target still holds what it held.
    await delay(60);
    expect(await readFile(file, "utf8")).toBe("old\n");

    await edit;
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  it("refuses an edit whose file changed after the call read it", async () => {
    const dir = await directory();
    const file = join(dir, "raced.md");
    await writeFile(file, "a\nb\n", "utf8");
    const env = new RacingReadEnv({ cwd: dir });
    const tools = codingTools();

    await expect(
      tools.get("edit")?.execute({ path: file, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx()),
    ).rejects.toThrow(/changed on disk after this call read it/);
    expect(await readFile(file, "utf8")).toBe("CHANGED ELSEWHERE\n");
  });

  it("refuses an edit that would empty the file, and lets a write empty it", async () => {
    const dir = await directory();
    const file = join(dir, "empty.md");
    await writeFile(file, "only\n", "utf8");
    const env = new NodeExecutionEnv({ cwd: dir });
    const tools = codingTools();

    await expect(
      tools.get("edit")?.execute({ path: file, edits: [{ oldText: "only\n", newText: "" }] }, apiFor(env), ctx()),
    ).rejects.toThrow(/would leave the file empty/);
    expect(await readFile(file, "utf8")).toBe("only\n");

    await tools.get("write")?.execute({ path: file, content: "" }, apiFor(env), ctx());
    expect((await stat(file)).size).toBe(0);
  });

  it("edits a file that is reached through a symbolic link without replacing the link", async () => {
    const dir = await directory();
    const target = join(dir, "target.md");
    const link = join(dir, "link.md");
    await writeFile(target, "a\n", "utf8");
    await import("node:fs/promises").then(({ symlink }) => symlink(target, link));
    const env = new NodeExecutionEnv({ cwd: dir });
    const tools = codingTools();

    await tools.get("edit")?.execute({ path: link, edits: [{ oldText: "a", newText: "A" }] }, apiFor(env), ctx());
    expect(await readFile(target, "utf8")).toBe("A\n");
    expect((await import("node:fs/promises").then(({ lstat }) => lstat(link))).isSymbolicLink()).toBe(true);
  });
});

describe("the guards inside a js script", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** The text of the tool result this submission made. */
  async function runTool(h: TestHarness, name: string, args: Record<string, unknown>): Promise<string> {
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const conversation = await resolveDefaultConversation(
      h.runtime.harness,
      h.config,
      h.runtime.paths,
      BACKGROUND_CONTEXT,
    );
    const submission = await conversation.submit({ type: "input", content: "run it" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    const results = page.items.filter((entry) => entry.kind === "pi.tool-result");
    return (results[0]?.model ?? [])
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
      .join("\n");
  }

  it("makes a nested edit wait for a nested shell, which no hook could do", async () => {
    harness = await createTestHarness({ config: { agent: { ...(await import("../src/config/schema.ts")).defaultConfig().agent } } });
    const dir = join(harness.paths.workspaceTree, "nested");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "note.md");
    await writeFile(file, "a\nb\n", "utf8");

    const code = `
      const started = Date.now();
      const shell = tools.bash({ command: "sleep 0.4" }).then(() => Date.now() - started);
      const edit = tools.edit({ path: ${JSON.stringify(file)}, edits: [{ oldText: "a", newText: "A" }] }).then(() => Date.now() - started);
      const [shellAt, editAt] = await Promise.all([shell, edit]);
      return { shellAt, editAt };
    `;
    const text = await runTool(harness, "js", { code });

    expect(await readFile(file, "utf8")).toBe("A\nb\n");
    const found = /\{"shellAt":(\d+),"editAt":(\d+)\}/.exec(text.replace(/\s+/g, ""));
    expect(found, `no timings in ${JSON.stringify(text)}`).not.toBeNull();
    const shellAt = Number(found?.[1]);
    const editAt = Number(found?.[2]);
    // The shell held the slot for its whole sleep, so the edit finished only after it.
    expect(editAt).toBeGreaterThanOrEqual(300);
    expect(editAt).toBeGreaterThanOrEqual(shellAt - 100);
  });
});
