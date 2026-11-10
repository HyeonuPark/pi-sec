import { describe, expect, it, vi } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Config } from "../src/config/schema.ts";
import { FOCUSED_CHAT_TOOLS, SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS } from "../src/agent/tool-profile.ts";
import { createRemoteMachinesExtension, SECTION_TEXT } from "../src/extensions/remote-machines.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createRunFixture, type RunFixture } from "./remote-run-helpers.ts";

/**
 * The `remote-machines` extension: its nine tools and its one section.
 *
 * These tests stand where an agent stands. Each tool is handed the arguments an
 * agent would give it and an `api` that names the conversation and the call, and
 * what it answers has to be what the core underneath said: the rule is that
 * a tool adds no check of its own and passes a refusal on as it stands.
 *
 * The fakes are the ones `test/remote-run-helpers.ts` builds: a machine that
 * really runs what it is asked, in a directory that plays the remote user's home.
 * Nothing here reaches a real machine.
 */

/** The tools the extension must register, in the order it registers them. */
const TOOL_NAMES = [
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

/** The extension over one fixture's remote machines. */
function extensionOf(fixture: RunFixture) {
  const config: Config = fixture.runtime.getConfig();
  const context = {
    remoteMachines: fixture.runtime.remoteMachines,
    getConfig: () => config,
  } as unknown as ExtensionContext;
  return createRemoteMachinesExtension(context);
}

/** One tool of the extension, by name. */
function toolOf(fixture: RunFixture, name: string) {
  const tool = extensionOf(fixture).tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the extension registers no tool ${name}`);
  return tool;
}

/** The `api` a tool execution is handed, with the two values the run id is made of. */
function callApi(conversationId: string | number, callId = "call-1"): ToolExecutionApi {
  return { conversationId, callId } as unknown as ToolExecutionApi;
}

/** The text of a tool result, all parts in order. */
function textOf(result: { readonly content?: readonly { readonly type: string; readonly text?: string }[] }): string {
  return (result.output ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** The run id a tool's answer names, or an empty string when it names none. */
function runIdIn(text: string): string {
  return /Run (run-[0-9a-f]{20})\b/.exec(text)?.[1] ?? "";
}

describe("the extension's declaration", () => {
  it("registers the nine tools in a fixed order, and one section", async () => {
    const fixture = await createRunFixture();
    try {
      const extension = extensionOf(fixture);
      expect(extension.name).toBe("remote-machines");
      expect((extension.tools ?? []).map((tool) => tool.name)).toEqual(TOOL_NAMES);
      const sections = extension.sections ?? [];
      expect(sections).toHaveLength(1);
      expect(sections[0]?.key).toBe("remote-machines");
      // The wrapper is what puts `<remote-machines>` and `</remote-machines>` around
      // the body, so a section that turned its own tag off would ship the body bare.
      expect(sections[0]?.tag).not.toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("declares remote_run as safe to run again, and nothing else", async () => {
    const fixture = await createRunFixture();
    try {
      expect(toolOf(fixture, "remote_run").replay).toBe("safe");
      // A run stop, a file write and a tree copy are not idempotent: a rerun after
      // an interrupted execution is a second stop, a second write or a second copy.
      for (const name of ["remote_run_stop", "remote_write", "remote_edit", "remote_sync"]) {
        expect(toolOf(fixture, name).replay, name).not.toBe("safe");
      }
    } finally {
      await fixture.close();
    }
  });
});

describe("the prompt section", () => {
  /** The input a section reads its tool list from. */
  function offered(...names: string[]) {
    return { agent: { tools: names.map((name) => ({ name })) } } as never;
  }

  it("renders the section text only when the conversation has a remote tool", async () => {
    const fixture = await createRunFixture();
    try {
      const section = (extensionOf(fixture).sections ?? [])[0];
      if (section === undefined) throw new Error("the extension has no section");
      expect(await section.render(offered("read", "bash", "js"), BACKGROUND_CONTEXT)).toBeUndefined();
      expect(await section.render(offered(), BACKGROUND_CONTEXT)).toBeUndefined();
      const rendered = await section.render(offered("read", "remote_run"), BACKGROUND_CONTEXT);
      expect(rendered).toBe(SECTION_TEXT);
      // Every one of the nine names is enough on its own, which is what keeps the
      // section on a scheduled run, where six of them are removed.
      for (const name of TOOL_NAMES) {
        expect(await section.render(offered(name), BACKGROUND_CONTEXT), name).toBe(SECTION_TEXT);
      }
    } finally {
      await fixture.close();
    }
  });

  it("names no level, so a session cannot read a stale one", async () => {
    const fixture = await createRunFixture();
    try {
      // A level is read with remote_machines, and the section is the same text on
      // every request while the session lives.
      expect(SECTION_TEXT).not.toContain("level: on");
      expect(SECTION_TEXT).toContain("The level is the user's allowance for one machine");
    } finally {
      await fixture.close();
    }
  });
});

describe("remote_machines", () => {
  it("lists the machines without contacting any of them", async () => {
    const fixture = await createRunFixture();
    try {
      const listed = await toolOf(fixture, "remote_machines").execute({}, callApi(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
      const text = textOf(listed);
      expect(text).toContain("1 remote machine(s) are registered");
      expect(text).toContain("box-a at 192.0.2.10:22");
      expect(text).toContain("level off");
      expect(text).toContain("alice: not-checked");
      // The plan's rule for this tool: no name, no ssh call.
      expect(await fixture.calls()).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a machine at off with the core's sentence, and calls no ssh", async () => {
    const fixture = await createRunFixture();
    try {
      const refused = await toolOf(fixture, "remote_machines").execute(
        { machine: "box-a" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("is at level off, so nothing may be done on it");
      expect(await fixture.calls()).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("reads the load, memory and sessions of a machine that is on", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      // Moving a level checks the machine at once, so the baseline is taken after
      // that: what this measures is the read, and the read is one ssh call.
      const before = (await fixture.calls()).length;
      const listed = await toolOf(fixture, "remote_machines").execute(
        { machine: "box-a" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      const text = textOf(listed);
      expect(text).toContain("Load on box-a, read now:");
      expect(text).toContain("load average:");
      expect(text).toContain("cpus:");
      expect(text).toContain("logged-in sessions:");
      expect((await fixture.calls()).length).toBe(before + 1);
    } finally {
      await fixture.close();
    }
  });

  it("says the feature is off when the config names no remoteMachines key", async () => {
    const fixture = await createRunFixture();
    try {
      fixture.setConfig((config) => {
        const next = { ...config };
        delete (next as { remoteMachines?: unknown }).remoteMachines;
        return next;
      });
      const listed = await toolOf(fixture, "remote_machines").execute({}, callApi(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
      expect(listed.isError).toBe(true);
      expect(textOf(listed)).toContain("no remoteMachines key");
    } finally {
      await fixture.close();
    }
  });
});

describe("remote_run", () => {
  it("answers a command that ends inside the wait with its output and exit code", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      const result = await toolOf(fixture, "remote_run").execute(
        { machine: "box-a", command: "echo started; echo bad >&2; exit 3" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      const text = textOf(result);
      expect(result.isError).not.toBe(true);
      expect(text).toMatch(/^Run run-[0-9a-f]+ finished with exit code 3\./);
      expect(text).toContain("started");
      // The run id is the digest of the conversation and the call, which is what
      // makes a repeat harmless.
      const runId = /Run (run-[0-9a-f]+)/.exec(text)?.[1] ?? "";
      expect(runId).toMatch(/^run-[0-9a-f]{20}$/);
    } finally {
      await fixture.close();
    }
  });

  it("answers a longer command with a run id, and reads and stops it afterwards", { timeout: 120_000 }, async () => {
    const fixture = await createRunFixture();
    // The tool waits twenty seconds before it answers a command that is still
    // going, and this test would wait all of it. The wait is the one slow part and
    // it is not what this test is about, so the run manager waits one second
    // instead. The tool still reaches `start` on its own path, with the arguments
    // it builds; only the wait it does not name changes.
    const runs = fixture.runtime.remoteMachines.runs();
    const start = runs.start.bind(runs);
    const waited = vi
      .spyOn(runs, "start")
      .mockImplementation(async (input) => await start({ ...input, waitMs: input.waitMs ?? 1_000 }));
    try {
      await fixture.setLevel("box-a", "on");
      const result = await toolOf(fixture, "remote_run").execute(
        { machine: "box-a", command: "echo working; sleep 120" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      const text = textOf(result);
      const runId = /Run (run-[0-9a-f]+) is still running/.exec(text)?.[1] ?? "";
      expect(runId).toMatch(/^run-[0-9a-f]{20}$/);
      expect(text).toContain("The core checks it at least every 30 minutes");
      expect(text).toContain("remote_run_status");

      const read = await toolOf(fixture, "remote_run_status").execute(
        { run: runId },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      const readText = textOf(read);
      expect(readText).toContain(": running, no exit code.");
      expect(readText).toContain("working");

      const stopped = await toolOf(fixture, "remote_run_stop").execute(
        { run: runId },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      const stoppedText = textOf(stopped);
      expect(stopped.isError).not.toBe(true);
      expect(stoppedText).toContain(`Run ${runId} was stopped`);
      expect(stoppedText).toContain("Work it already did is not undone.");
    } finally {
      waited.mockRestore();
      await fixture.close();
    }
  });

  it("starts a second run when two scripts make the same first call, and one when a direct call repeats", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      const tool = toolOf(fixture, "remote_run");
      // A script names its calls by their position in it (`src/extensions/js-tool.ts`
      // hands the nested tool `js:<tool>:<n>`), so the first `remote_run` of two
      // different scripts arrives with one id. A run id computed from that id alone
      // would answer the second script with the first script's run.
      const scriptCall = callApi(ROOT_CONVERSATION_ID, "js:remote_run:1");
      const firstScript = textOf(
        await tool.execute({ machine: "box-a", command: "echo from-the-first-script" }, scriptCall, BACKGROUND_CONTEXT),
      );
      const secondScript = textOf(
        await tool.execute({ machine: "box-a", command: "echo from-the-second-script" }, scriptCall, BACKGROUND_CONTEXT),
      );
      const first = runIdIn(firstScript);
      const second = runIdIn(secondScript);
      expect(first).toMatch(/^run-[0-9a-f]{20}$/);
      expect(second).toMatch(/^run-[0-9a-f]{20}$/);
      expect(second).not.toBe(first);
      // The second answer is the second command's own run, output and all.
      expect(secondScript).toContain("from-the-second-script");

      // A call the model made is still the same call when it is made again, so its
      // second execution answers the run instead of starting another one.
      const directCall = callApi(ROOT_CONVERSATION_ID, "call-9");
      const directFirst = textOf(
        await tool.execute({ machine: "box-a", command: "echo direct" }, directCall, BACKGROUND_CONTEXT),
      );
      const directSecond = textOf(
        await tool.execute({ machine: "box-a", command: "echo direct" }, directCall, BACKGROUND_CONTEXT),
      );
      expect(runIdIn(directSecond)).toBe(runIdIn(directFirst));

      const runs = await readdir(join(fixture.remote, ".local", "state", "pi-sec", "runs"));
      expect(runs.sort()).toEqual([first, second, runIdIn(directFirst)].sort());
    } finally {
      await fixture.close();
    }
  });

  it("passes a refusal on, and starts nothing", async () => {
    const fixture = await createRunFixture();
    try {
      const refused = await toolOf(fixture, "remote_run").execute(
        { machine: "box-a", command: "echo no" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("is at level off");
      expect(await fixture.calls()).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});

describe("the file tools", () => {
  it("reads a file whole, and refuses one past the cap instead of cutting it", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/note.txt`, "one\ntwo\n", "utf8");
      const read = await toolOf(fixture, "remote_read").execute(
        { machine: "box-a", path: `${fixture.remote}/note.txt` },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(textOf(read)).toBe("one\ntwo\n");

      const refused = await toolOf(fixture, "remote_read").execute(
        { machine: "box-a", path: `${fixture.remote}/note.txt`, maxBytes: 4 },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("more than the 4-byte cap");
    } finally {
      await fixture.close();
    }
  });

  it("writes through the core and answers with the byte count", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/target.txt`, "old\n", "utf8");
      const written = await toolOf(fixture, "remote_write").execute(
        { machine: "box-a", path: `${fixture.remote}/target.txt`, content: "new text\n" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(written.isError).not.toBe(true);
      expect(textOf(written)).toBe(`${fixture.remote}/target.txt was written: 9 bytes.`);
      const read = await toolOf(fixture, "remote_read").execute(
        { machine: "box-a", path: `${fixture.remote}/target.txt` },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(textOf(read)).toBe("new text\n");
    } finally {
      await fixture.close();
    }
  });

  it("edits one occurrence, and refuses a string that appears twice", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/a.txt`, "alpha\nbeta\n", "utf8");
      const edited = await toolOf(fixture, "remote_edit").execute(
        { machine: "box-a", path: `${fixture.remote}/a.txt`, oldText: "beta", newText: "gamma" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(edited.isError).not.toBe(true);
      expect(textOf(edited)).toContain("one occurrence of the old text was replaced");

      await writeFile(`${fixture.remote}/b.txt`, "same\nsame\n", "utf8");
      const refused = await toolOf(fixture, "remote_edit").execute(
        { machine: "box-a", path: `${fixture.remote}/b.txt`, oldText: "same", newText: "other" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("an edit must match exactly once");
    } finally {
      await fixture.close();
    }
  });

  it("refuses remote_sync at restricted with the core's reason", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "restricted");
      const refused = await toolOf(fixture, "remote_sync").execute(
        { machine: "box-a", direction: "push", source: `${fixture.home}/a`, destination: "/tmp/b" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("the size of a copy is not known before it starts");
      expect(await fixture.rsyncCalls()).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});

describe("remote_level_tighten", () => {
  it("refuses every conversation that is not the root", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      const elsewhere = await fixture.addConversation({ name: "worker" });
      const refused = await toolOf(fixture, "remote_level_tighten").execute(
        { machine: "box-a", level: "restricted", reason: "the user asked" },
        callApi(elsewhere),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("is the root's alone");
      expect(await fixture.runtime.remoteMachines.levelOf("box-a")).toBe("on");
    } finally {
      await fixture.close();
    }
  });

  it("narrows a level from the root, and lets the core refuse a widening", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.setLevel("box-a", "on");
      const narrowed = await toolOf(fixture, "remote_level_tighten").execute(
        { machine: "box-a", level: "restricted", reason: "the run must not use the whole machine" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(narrowed.isError).not.toBe(true);
      expect(textOf(narrowed)).toContain("its level is now restricted");
      expect(await fixture.runtime.remoteMachines.levelOf("box-a")).toBe("restricted");

      const widened = await toolOf(fixture, "remote_level_tighten").execute(
        { machine: "box-a", level: "on", reason: "try to widen" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(widened.isError).toBe(true);
      // The core's own sentence: a level that is not stricter is refused there, so
      // no tool can widen a machine even if it forgot the rule.
      expect(textOf(widened)).toContain("is not a tightening");
      expect(await fixture.runtime.remoteMachines.levelOf("box-a")).toBe("restricted");
    } finally {
      await fixture.close();
    }
  });

  it("refuses a level that is not one of the two stricter ones", async () => {
    const fixture = await createRunFixture();
    try {
      const refused = await toolOf(fixture, "remote_level_tighten").execute(
        { machine: "box-a", level: "half", reason: "nonsense" },
        callApi(ROOT_CONVERSATION_ID),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('level must be "off" or "restricted"');
    } finally {
      await fixture.close();
    }
  });
});

describe("the tool profile", () => {
  it("takes the level tool from every subagent, and the writing tools from a scheduled run", () => {
    expect(SUBAGENT_TOOL_REMOVALS).toContain("remote_level_tighten");
    // Reading tools stay: a worker reports what a machine is doing, and the level
    // tool is the only one whose decision is the user's.
    for (const name of ["remote_machines", "remote_run_status", "remote_read", "remote_run", "remote_write"]) {
      expect(SUBAGENT_TOOL_REMOVALS, name).not.toContain(name);
    }
    for (const name of [
      "remote_level_tighten",
      "remote_run",
      "remote_run_stop",
      "remote_write",
      "remote_edit",
      "remote_sync",
    ]) {
      expect(SCHEDULED_TOOL_REMOVALS, name).toContain(name);
    }
    for (const name of ["remote_machines", "remote_run_status", "remote_read"]) {
      expect(SCHEDULED_TOOL_REMOVALS, name).not.toContain(name);
    }
    // A focused chat's list is an allow list, so nothing is added to it.
    for (const name of TOOL_NAMES) expect(FOCUSED_CHAT_TOOLS, name).not.toContain(name);
  });
});
