import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationId,
  EntryRecord,
  StorageWrite,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { SecAgent, SecAgentChild } from "../src/documents.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import { readMessage } from "../src/message-envelope.ts";
import { notifyRestartNotice } from "../src/runtime/restart-notice.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * Every message kind the harness stores carries `at`, in the harness zone.
 *
 * The row that each test drives is named in its title. One test
 * creates the message through the producer that really writes it — a route, a
 * tool, a scheduler tick, the boot notice — and reads the stored text back, so a
 * producer that forgets the instant fails here rather than in a transcript
 * nobody re-reads.
 *
 * The offset is pinned to the configured zone instead of to the machine's own,
 * in three zones, for the two producers that no other test reaches: the
 * scheduled prompt (the scheduler's zone is fixed) and the cold-start notice (it
 * takes its zone as an argument). The status check of a running background call
 * and the one-shot episodes run in `Asia/Tokyo` only. The five other producers of
 * the harness zone, the chat input, the reset handoff, the background result,
 * the agent brief and note, and the session restart, are guarded by
 * `test/message-tags-emit.test.ts`.
 *
 * The gate of `request_restart` runs `tsc` and `vitest` in a tree that is empty
 * here, so it is replaced for this file alone. What is under test is the note the
 * watch sends, not the gate.
 */
vi.mock("../src/runtime/validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/validation.ts")>()),
  runValidation: async () => ({ typecheck: true, tests: true }),
  collectChangeText: async () => ({ text: "diff --git a/src/x.ts b/src/x.ts\n" }),
}));

const ctx = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;

type Zone = "Asia/Tokyo" | "UTC" | "America/Los_Angeles";

const ZONES: readonly Zone[] = ["Asia/Tokyo", "UTC", "America/Los_Angeles"];

/** The shape every `at` has: seconds, then the zone's offset. */
const ZONE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

// --------------------------------------------------------------- reading back

/** The text of one entry, whichever shape its content takes. */
function entryText(entry: EntryRecord): string {
  return (entry.model ?? [])
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

/** Every user-role entry, oldest first. */
async function userEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, ctx);
  return page.items.filter((entry) => entry.kind === "pi.user");
}

/** The instant the durable layer recorded for one entry, when it has one. */
function recordedAt(entry: EntryRecord): number | undefined {
  return (entry.model ?? [])
    .map((message) => (message as { timestamp?: number }).timestamp)
    .find((value) => typeof value === "number");
}

/** The offset a zone has at one instant, read out of `Intl` rather than assumed. */
function zoneOffset(ms: number, zone: Zone): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  // `longOffset` answers `GMT` for UTC itself, and `GMT+09:00` for a zone east of it.
  const offset = name.replace("GMT", "");
  return offset === "" ? "+00:00" : offset;
}

/**
 * The stamp on one entry: the zone form, the offset of that zone at that instant,
 * and the instant the store recorded for the entry, within a second.
 *
 * The comparison is against the entry's own timestamp, not against the clock of
 * the test: the harness reads the clock just before it hands the text to the
 * store, so the two name the same moment, and a second of room covers the write
 * in between.
 */
function expectStamp(entry: EntryRecord, zone: Zone, where: string): void {
  const parsed = readMessage(entryText(entry));
  const at = parsed?.attrs["at"];
  expect(at, `${where}: at`).toMatch(ZONE_INSTANT);
  const instant = Date.parse(at!);
  expect(instant, `${where}: a readable instant`).not.toBeNaN();
  // The offset is the configured zone's, so a message written in Tokyo does not
  // carry the machine's own zone by accident.
  expect(at!.endsWith(zoneOffset(instant, zone)), `${where}: the offset of ${zone}`).toBe(true);
  const recorded = recordedAt(entry);
  expect(recorded, `${where}: the entry's own timestamp`).toBeTypeOf("number");
  // `at` is written to the second, so the stamp is the instant the harness read
  // the clock truncated down to a second boundary. The entry's own timestamp is
  // read when the store writes the entry, after that. Up to 999 ms of this gap is
  // therefore the truncation, and only the rest is the store's write: a 1000 ms
  // bound left 1 ms for the write, and a loaded machine exceeded it. The bound below keeps a full second for the write on top of the
  // truncation, and the first check holds the direction the truncation implies.
  expect(instant, `${where}: not after the record`).toBeLessThanOrEqual(recorded!);
  expect(recorded! - instant, `${where}: at against the record`).toBeLessThanOrEqual(1999);
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ------------------------------------------------------------------ machinery

let open: TestHarness | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function defaultConversation(h: TestHarness): Promise<Conversation> {
  return await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
}

/** Enough scripted answers that a side conversation cannot empty the queue. */
function answers(count = 40): ReturnType<typeof fauxAssistantMessage>[] {
  return Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));
}

/** A scripted tool call. The stop reason is what makes the harness offer it to a tool task. */
function callTool(name: string, args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** One harness whose harness zone is `zone`. */
async function harnessIn(zone: Zone, options: Parameters<typeof createTestHarness>[0] = {}): Promise<TestHarness> {
  const base = options.config ?? {};
  open = await createTestHarness({
    ...options,
    config: {
      ...base,
      timezone: zone,
      server: { ...defaultConfig().server, ...(base.server ?? {}), port: 0 },
    },
  });
  return open;
}

// ------------------------------------------------------------------ the rows

describe.each(ZONES)("a message the harness stores, in the zone %s", (zone) => {
  it("operator-scheduled: the prompt a routine sends", async () => {
    const h = await harnessIn(zone, {
      responses: answers(4),
      config: {
        scheduler: {
          enabled: true,
          tickMs: 30_000,
          timezone: "UTC",
          jobs: [
            {
              name: "nightly",
              schedule: "* * * * *",
              timezone: "UTC",
              catchUp: "skip",
              overlap: "skip",
              prompt: "check the log",
              vmodel: "faux",
            },
          ],
        },
      },
    });
    const dispatched: { conversationId?: number }[] = [];
    h.events.subscribe((event) => {
      if (event.type === "notice" && (event.data as { code?: string }).code === "scheduler_dispatch") {
        dispatched.push(event.data as { conversationId?: number });
      }
    });

    await h.runtime.scheduler.tick(Date.UTC(2026, 0, 1, 12, 0, 0));

    const notice = await until(async () => {
      const found = dispatched.find((each) => each.conversationId !== undefined);
      return found;
    }, "the scheduled run to be dispatched");
    const conversation = await h.runtime.harness.conversation(notice.conversationId as ConversationId, ctx);
    expect(conversation).toBeDefined();

    const entry = await until(async () => (await userEntries(conversation!))[0], "the scheduled prompt to be stored");
    const parsed = readMessage(entryText(entry));
    expect(parsed?.source).toBe("operator-scheduled");
    expect(parsed?.body).toBe("check the log");
    // `occurrence` stays the epoch millisecond of the due minute, beside the instant.
    expect(parsed?.attrs["occurrence"]).toBeDefined();
    expectStamp(entry, zone, "the scheduled prompt");
  });
  it("restart: the cold-start notice a boot writes", async () => {
    const h = await harnessIn(zone, { responses: answers(10) });
    const conversation = await defaultConversation(h);
    // A conversation nobody wrote to gets no notice, so the root speaks first.
    await (await conversation.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);

    const startedAt = Date.now();
    const outcome = await notifyRestartNotice({
      harness: h.runtime.harness,
      pid: 4242,
      startedAt,
      timezone: zone,
      snapshotTree: h.paths.snapshotTree,
      auditFile: h.paths.auditLog,
      appendAudit: () => undefined,
      logger: { warn: () => undefined },
      readTail: async () => [
        { time: startedAt - 60_000, type: "server_start", pid: 1111 },
        { time: startedAt - 59_000, type: "server_stop", signal: "SIGTERM" },
        { time: startedAt, type: "server_start", pid: 4242 },
      ],
      treeCommit: () => undefined,
    });
    expect(outcome.kind).toBe("notified");

    const entry = await until(async () => {
      return (await userEntries(conversation)).find(
        (candidate) => readMessage(entryText(candidate))?.attrs["via"] === "cold-start",
      );
    }, "the cold-start notice to be stored");
    expectStamp(entry, zone, "the cold-start notice");
  });
});

/** The status check of a call that keeps running needs a second of waiting, so it runs in one zone. */
describe("the status check of a background call, in Asia/Tokyo", () => {
  const zone: Zone = "Asia/Tokyo";

  it("tool-output: the status check of a call that keeps running", { timeout: 30_000 }, async () => {
    const base = defaultConfig();
    const h = await harnessIn(zone, {
      config: { agent: { ...base.agent, tools: { ...base.agent.tools, backgroundCheckMs: 300 } } },
      responses: [
        fauxAssistantMessage(
          [fauxToolCall("async_call", { title: "longer", tool: "bash", args: { command: "sleep 1.2; echo CALLED-OK" } })],
          { stopReason: "toolUse" },
        ),
        ...answers(4),
      ],
    });
    const conversation = await defaultConversation(h);
    const submitted = await conversation.submit({ type: "input", content: "start it" }, ctx);
    await submitted.wait(ctx);

    const entry = await until(async () => {
      return (await userEntries(conversation)).find((candidate) => {
        const parsed = readMessage(entryText(candidate));
        return parsed?.source === "tool-output" && parsed.attrs["status"] === "running";
      });
    }, "the status check to arrive", 30_000);
    expect(readMessage(entryText(entry))?.body).toContain("[background call check]");
    expectStamp(entry, zone, "the status check");
  });
});

/**
 * The two producers that need a ready-made restart request or a run that refuses
 * to park. Both are one-shot episodes with no cheap way to repeat them in three
 * zones, so they run in the harness zone.
 */
describe("the notes that exist only during an episode, in Asia/Tokyo", () => {
  const ZONE: Zone = "Asia/Tokyo";
  const TITLE = "restart: tell the root when a subagent leaves the safe point";

  function textOf(result: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  }): string {
    return result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  function execApi(h: TestHarness): ToolExecutionApi {
    return {
      conversationId: ROOT,
      commit: (change: (tx: never) => unknown, context: Context) =>
        h.runtime.harness.commit(change as never, context),
    } as unknown as ToolExecutionApi;
  }

  /** One child of the root, with the hub's own index entry beside its record. */
  async function seedChild(h: TestHarness, name: string, status: "waiting" | "running"): Promise<ConversationId> {
    let id = "";
    await h.runtime.harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      id = String(conversation.id);
      const record = await tx.doc(SecAgent, id, id);
      record.kind = "subagent";
      record.name = name;
      record.parentConversationId = String(ROOT);
      record.status = status;
      record.createdAt = 1;
      record.updatedAt = 1;
      const index = await tx.doc(SecAgentChild, ROOT, name, name);
      index.name = name;
      index.conversationId = id;
      index.createdAt = 1;
    }, ctx);
    return Number(id) as ConversationId;
  }

  /** One task on a conversation, in the state the busy rule reads. */
  async function seedTask(h: TestHarness, conversationId: ConversationId): Promise<void> {
    const storage = h.runtime.storage;
    const taskId = await storage.mintId<TaskId>();
    const write = {
      type: "task",
      value: {
        id: taskId,
        conversationId,
        kind: "pi.generation",
        version: 1,
        input: {},
        background: false,
        abortRequested: false,
        startedAt: Date.now(),
        state: { status: "running", checkpoint: { phase: "execute" } },
      },
    } as unknown as StorageWrite;
    await commitWrites(storage, [write], ctx);
  }

  /** The `request_restart` tool over one harness, with the runtime's own state. */
  function restartTool(h: TestHarness): ToolRegistration {
    const runtime = h.runtime;
    const context = {
      getConfig: runtime.getConfig,
      paths: runtime.paths,
      secrets: runtime.secrets,
      audit: runtime.audit,
      logger: runtime.logger,
      events: runtime.events,
      restart: runtime.restart,
      sections: runtime.sections,
      storage: runtime.storage,
      harness: runtime.harness,
      subagents: runtime.subagents,
    } as unknown as ExtensionContext;
    const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
    if (tool === undefined) throw new Error("request_restart is not registered");
    return tool;
  }

  it("restart: the safe-point note the restart watch sends the root", async () => {
    const h = await harnessIn(ZONE, { responses: answers(40) });
    await defaultConversation(h);
    const tool = restartTool(h);
    const child = await seedChild(h, "agent-a", "waiting");

    // The child is parked, so the gate passes and the request goes out.
    const raised = await tool.execute({ title: TITLE } as never, execApi(h), ctx);
    expect(textOf(raised)).toContain("Gate passed");

    // The child works again after the gate passed: that is the note's trigger.
    await seedTask(h, child);
    await h.runtime.subagents!.setStatus(ctx, child, "running", {});

    const page = await h.runtime.storage.scanEntries({ conversationId: ROOT, order: "descending" }, 200, undefined, ctx);
    const entry = await until(async () => {
      const found = page.items.find((candidate) =>
        (candidate.model ?? []).some((message) => {
          const parsed = readMessage(String((message as { content?: unknown }).content));
          return parsed?.attrs["via"] === "safe-point-lost";
        }),
      );
      return found;
    }, "the safe-point note");
    expectStamp(entry, ZONE, "the safe-point note");
  });

  it("system: the nudge the harness sends a subagent", async () => {
    const brief = { name: "researcher", vmodel: "faux", roles: [], initialPrompt: "find the thing" };
    // The child answers instead of parking, so the discipline hook nudges it.
    const h = await harnessIn(ZONE, { responses: [callTool("spawn_subagent", brief), ...answers(40)] });
    const conversation = await defaultConversation(h);
    await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

    const index = await until(
      async () => await h.runtime.harness.snapshot(SecAgentChild, conversation.id, "researcher", ctx),
      "the child index entry",
    );
    const child = await h.runtime.harness.conversation(Number(index.conversationId) as ConversationId, ctx);

    const entry = await until(async () => {
      return (await userEntries(child!)).find((candidate) => {
        const parsed = readMessage(entryText(candidate));
        return parsed?.source === "system" && parsed.attrs["kind"] === "nudge";
      });
    }, "the nudge to reach the child");
    // A nudge is one entry the harness stores, not text rebuilt on every request,
    // which is why it may carry an instant at all.
    expectStamp(entry, ZONE, "the nudge");
  });
});
