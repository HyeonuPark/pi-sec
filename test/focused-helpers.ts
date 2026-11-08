import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { openFocusedChat, type FocusedDeps } from "../src/focused/service.ts";
import type { FocusedChatRow } from "../src/focused/store.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The focused chat tests' shared parts.
 *
 * Opening a chat and running one tool round are the two actions almost every test
 * below needs, and both have a trap: a chat only exists when the extensions are
 * loaded, and a tool round has to park or answer so the next scripted response is
 * not consumed by a nudge.
 */

const CTX = BACKGROUND_CONTEXT;

/** What a focused chat action needs, read from the runtime the test built. */
export function depsOf(test: TestHarness): FocusedDeps {
  const runtime = test.runtime;
  return {
    harness: runtime.harness,
    store: runtime.focusedChats,
    paths: runtime.paths,
    getConfig: runtime.getConfig,
    hub: runtime.subagents,
    events: runtime.events,
    audit: runtime.audit,
    reports: runtime.reports,
  };
}

/** One test harness with the extensions loaded, which is what installs the hub. */
export async function focusedHarness(
  options: Parameters<typeof createTestHarness>[0] = {},
): Promise<TestHarness> {
  return await createTestHarness({ loadExtensions: true, ...options });
}

/** Open one focused chat, or fail with the refusal's own words. */
export async function openChat(test: TestHarness, title?: string): Promise<FocusedChatRow> {
  return await openFocusedChat(depsOf(test), title === undefined ? {} : { title }, CTX);
}

/** A conversation handle by id. */
export async function conversationOf(test: TestHarness, conversationId: number): Promise<Conversation> {
  const conversation = await test.runtime.harness.conversation(conversationId as never, CTX);
  if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
  return conversation;
}

/** One text message of one model message, whatever shape its content has. */
export function messageText(message: Message): string {
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

/**
 * The sections one request carries, by key, in the order they render.
 *
 * The harness hands the prompt to the provider as a map of tagged sections rather
 * than as one string, so this is the closest reading of "what is in the prompt"
 * there is. A directive the extensions added mid-request arrives in `content`, and
 * that is read separately.
 */
export function sectionsOf(messages: readonly Message[]): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const message of messages) {
    if (message.role !== "system") continue;
    const carried = (message as unknown as { sections?: Record<string, string> }).sections;
    if (carried !== undefined) Object.assign(sections, carried);
  }
  return sections;
}

/** The text of every system message in a request, joined: the prompt and any directive. */
export function systemText(messages: readonly Message[]): string {
  const sections = Object.values(sectionsOf(messages)).join("\n---\n");
  const direct = messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message))
    .join("\n---\n");
  return [sections, direct].filter((part) => part !== "").join("\n---\n");
}

/**
 * Submit one input to one conversation and return the messages of its first request.
 *
 * Every later request is answered with a plain text so a nudge cannot consume the
 * scripted answer the caller meant for this request.
 */
export async function firstRequest(
  test: TestHarness,
  conversation: Conversation,
  content = "hello",
): Promise<readonly Message[]> {
  let captured: readonly Message[] | undefined;
  const capture = (context: { readonly messages: readonly Message[] }): ReturnType<typeof fauxAssistantMessage> => {
    if (captured === undefined) captured = context.messages;
    return fauxAssistantMessage([fauxText("ok")]);
  };
  test.faux.setResponses(Array.from({ length: 20 }, () => capture));
  const submission = await conversation.submit({ type: "input", content }, CTX);
  await submission.wait(CTX);
  if (captured === undefined) throw new Error("the conversation made no model request");
  return captured;
}

/**
 * Run one tool call in one conversation and return the text of its result.
 *
 * The answer after the call is plain text, so a conversation that ends its turn
 * without parking is not nudged into a second round that would read the wrong
 * script.
 */
export async function runTool(
  test: TestHarness,
  conversationId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const conversation = await conversationOf(test, conversationId);
  const before = await conversation.entries({ order: "ascending" }, 500, undefined, CTX);
  const lastId = before.items.at(-1)?.id ?? 0;
  test.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])),
  ]);
  const submission = await conversation.submit({ type: "input", content: "go" }, CTX);
  await submission.wait(CTX);
  const after = await conversation.entries(
    { minEntryId: (lastId + 1) as never, order: "ascending" },
    500,
    undefined,
    CTX,
  );
  return after.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => (entry.model ?? []).map(messageText).join("\n"))
    .join("\n");
}

/** A wired server over a test runtime, as `test/server.test.ts` builds one. */
export interface BootedServer {
  readonly origin: string;
  readonly deps: AppDeps;
  readonly started: StartedServer;
}

export async function bootServer(
  test: TestHarness,
  reloadConfig?: () => Promise<void>,
): Promise<BootedServer> {
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: test.runtime,
    bus: test.events,
    sse,
    streams: new StreamHub({ runtime: test.runtime, bus: test.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: test.runtime.restart, notes: new AdminNotes() },
    ...(reloadConfig === undefined ? {} : { reloadConfig }),
  };
  const started = await startServer(deps, { webDir: defaultWebDir() });
  return { origin: started.origin, deps, started };
}

/** A test harness whose HTTP port the kernel picks, the way the server tests do it. */
export function serverConfig(): Parameters<typeof createTestHarness>[0] {
  return { config: { server: { ...defaultConfig().server, port: 0 } } };
}
