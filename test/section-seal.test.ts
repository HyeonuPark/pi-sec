import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import type { Config } from "../src/config/schema.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The `personality` extension adds a request-scoped system message to a fresh
 * root conversation while no personality is registered (the design interview).
 * A provider without mid-conversation system messages replays it into the head,
 * so the first request of a session carries text the second one does not. These
 * tests measure a section's committed value, so the interview is switched off.
 */
const NO_INTERVIEW = {
  personality: { file: "memory/personality.md", interview: false, roles: ["orchestrator"] },
} as Partial<Config>;

/**
 * A section's value may only enter a request at the start of a session. These
 * tests drive a real runtime extension whose section reads a file, so the whole
 * path runs: the loader, the seal and the record it keeps, and the value a new
 * session picks up.
 */
describe("session seal for system prompt sections", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** Install a runtime extension with one section that reads `source`. */
  async function installProbe(test: TestHarness, source: string): Promise<void> {
    const dir = join(test.paths.extensionsDir, "probe");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "index.js"),
      [
        'import { readFile } from "node:fs/promises";',
        'import { defineExtension, section } from "@earendil-works/pi-durable";',
        'export const name = "probe";',
        `const SOURCE = ${JSON.stringify(source)};`,
        "export function create() {",
        '  return defineExtension({ name, sections: [section("probe", async () => (await readFile(SOURCE, "utf8")).trim())] });',
        "}",
        "",
      ].join("\n"),
    );
    await test.runtime.loader.loadAll();
  }

  /** Answer with a fixed text, capturing the head of the request that asked for it. */
  function recordHeads(test: TestHarness, heads: string[]): void {
    test.faux.setResponses([
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("ok")]);
      },
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("ok")]);
      },
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("ok")]);
      },
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);
  }

  async function notes(test: TestHarness): Promise<string[]> {
    const page = await test.runtime.storage.scanEntries({ conversationId: 1 as never }, 200, undefined, BACKGROUND_CONTEXT);
    return page.items
      .filter((entry) => entry.kind === "sec.section-update")
      .map((entry) => (entry.model ?? []).map((message) => String(message.content)).join("\n"));
  }

  it("freezes the value, writes nothing into the history, and lets a new session pick the change up", async () => {
    harness = await createTestHarness({ config: NO_INTERVIEW });
    const source = join(harness.paths.home, "probe.txt");
    await writeFile(source, "value one\n");
    await installProbe(harness, source);

    const heads: string[] = [];
    recordHeads(harness, heads);
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);

    const first = await conversation.submit({ type: "input", content: "first" }, BACKGROUND_CONTEXT);
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(heads[0]).toContain("<probe>\nvalue one\n</probe>");
    expect(await notes(harness)).toHaveLength(0);

    // The source moves. The session must not notice it in the prompt.
    await writeFile(source, "value two\n");
    const second = await conversation.submit({ type: "input", content: "second" }, BACKGROUND_CONTEXT);
    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(heads[1]).toBe(heads[0]);
    expect(harness.runtime.sections.stale(1 as never)).toEqual(["probe"]);

    // Nothing reaches the history: the change lives in the seal, and the agent
    // reads it there with `session_stale`.
    expect(await notes(harness)).toHaveLength(0);

    // The same change seen again adds nothing, and the head still holds.
    const third = await conversation.submit({ type: "input", content: "third" }, BACKGROUND_CONTEXT);
    expect((await third.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(heads[2]).toBe(heads[0]);
    expect(await notes(harness)).toHaveLength(0);

    // A new session takes the value the source holds now, and stops reporting.
    await conversation.reset(undefined, BACKGROUND_CONTEXT);
    const fourth = await conversation.submit({ type: "input", content: "fourth" }, BACKGROUND_CONTEXT);
    expect((await fourth.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(heads[3]).toContain("<probe>\nvalue two\n</probe>");
    expect(heads[3]).not.toBe(heads[0]);
    expect(harness.runtime.sections.stale(1 as never)).toEqual([]);
  });

  it("installs the seal whatever the enable list says", async () => {
    // The seal is a property of how a request is built, not a feature. A config
    // that dropped it would leave every section unsealed and silent.
    harness = await createTestHarness({ config: { agent: { extensions: { enabled: ["coding"] } } } as never });
    const installed = harness.runtime.registry.snapshot().installed().map((extension) => extension.name);
    expect(installed).toContain("sections");
  });

  it("returns the committed value for a bundled section, untagged", async () => {
    harness = await createTestHarness();
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const preamble = agent.sections.find((section) => section.key === "preamble");
    expect(preamble).toBeDefined();

    // A tagged section would wrap the committed text a second time, which is
    // silent and corrupts the prompt.
    expect(preamble?.tag).toBe(false);
    const shown = "<preamble>\ncommitted on the first request\n</preamble>";
    const rendered = await preamble?.render(
      { conversationId: conversation.id, agent, env: undefined, shown: { preamble: shown }, read: {} as never },
      BACKGROUND_CONTEXT,
    );
    expect(rendered).toBe(shown);

    // That render recorded a change no request has taken yet, and the status the
    // admin page reads reports it from the pending side just the same.
    expect(harness.runtime.sections.staleConversations()).toContainEqual({
      conversationId: conversation.id,
      keys: ["preamble"],
    });
  });

  it("writes no note and moves no head while the source holds still", async () => {
    harness = await createTestHarness({ config: NO_INTERVIEW });
    const source = join(harness.paths.home, "probe.txt");
    await writeFile(source, "steady\n");
    await installProbe(harness, source);

    const heads: string[] = [];
    recordHeads(harness, heads);
    const conversation = await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, BACKGROUND_CONTEXT);

    for (const input of ["one", "two"]) {
      const submission = await conversation.submit({ type: "input", content: input }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    }

    expect(heads[1]).toBe(heads[0]);
    expect(await notes(harness)).toHaveLength(0);
    expect(harness.runtime.sections.stale(1 as never)).toEqual([]);
  });
});

/** The leading system message as an API without mid-conversation system messages receives it. */
function collapsedHead(messages: Parameters<typeof collapseSystemMessages>[0]["messages"]): string {
  const collapsed = collapseSystemMessages({ messages }).messages;
  const head = collapsed[0];
  return head !== undefined && head.role === "system" ? getSystemMessageText(head) : "";
}
