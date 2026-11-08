import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { zoneMinute } from "../src/time-format.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * `[[pi-sec:now]]` becomes the current time when `write` or `edit` saves a note.
 *
 * The harness's own trees are the temp directories the test harness builds
 * (`<home>/workspace` and `<home>/snapshot`), so a file "outside" is one in a
 * directory of its own beside them. Every case goes through a real tool call
 * made by the agent, because the rule lives in a `ToolTask` hook: a call made
 * straight against the tool object would skip it, and the `js` case goes through
 * the sandbox because a nested call is the one path that has no hook.
 *
 * The result line is matched against its exact wording rather than against the
 * module that builds it, so a change to either one shows up here.
 */

const ZONE = "Asia/Tokyo";

/** The time a note gets, as the rule prints it: minute, with the offset. */
const TIME = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} \+09:00/;

/** The line appended to a result, with the count it must carry. */
function noteLine(count: number): RegExp {
  return new RegExp(`^Replaced \\[\\[pi-sec:now\\]\\] ${count} ${count === 1 ? "time" : "times"} with ${TIME.source}\\.$`);
}

interface ToolRun {
  /** The whole text of the last tool result in the conversation. */
  readonly text: string;
}

async function runTool(harness: TestHarness, name: string, args: Record<string, unknown>): Promise<ToolRun> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "save a note" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  // The store reads newest first, so the call this submission made is the first
  // tool result in the page.
  const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  const results = page.items.filter((entry) => entry.kind === "pi.tool-result");
  const last = results[0];
  const text = (last?.model ?? [])
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
  return { text };
}

/** The last line of a tool result. */
function lastLine(text: string): string {
  const lines = text.split("\n");
  return lines[lines.length - 1] ?? "";
}

/** Whether some line of a result is the marker line, and the time on it. */
function noteIn(text: string, count: number): string | undefined {
  return text.split("\n").find((line) => noteLine(count).test(line));
}

/**
 * The instant a note carries must be the minute of the save.
 *
 * The save happens between the two readings, so the note names the zone form of
 * one of them: a save that crosses a minute boundary lands on the later minute,
 * which is the value read after the call.
 */
function expectSavedNow(note: string, before: number, after: number): void {
  const found = note.match(TIME)?.[0];
  expect(found, `no zone time in ${JSON.stringify(note)}`).toBeDefined();
  expect([zoneMinute(before, ZONE), zoneMinute(after, ZONE)]).toContain(found);
}

describe("[[pi-sec:now]] on write and edit", () => {
  let harness: TestHarness | undefined;
  const scratch: string[] = [];

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A directory beside the harness's own trees, which is outside both of them. */
  async function outsideDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "now-marker-"));
    scratch.push(dir);
    return dir;
  }

  async function harnessFor(): Promise<TestHarness> {
    harness = await createTestHarness({ config: { timezone: ZONE } });
    return harness;
  }

  it("(a) replaces the marker in an outside .md file and reports the count", async () => {
    const h = await harnessFor();
    const dir = await outsideDir();
    const file = join(dir, "note.md");

    const before = Date.now();
    const run = await runTool(h, "write", { path: file, content: "Saved at [[pi-sec:now]].\n" });
    const after = Date.now();

    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("[[pi-sec:now]]");
    expectSavedNow(saved, before, after);
    expect(saved).toBe(`Saved at ${saved.match(TIME)?.[0]}.\n`);

    expect(lastLine(run.text)).toMatch(noteLine(1));
    expectSavedNow(lastLine(run.text), before, after);
  });

  it("(b) leaves a .md file inside the workspace tree alone, by absolute and relative path", async () => {
    const h = await harnessFor();
    const absolute = join(h.paths.workspaceTree, "note.md");

    const byAbsolute = await runTool(h, "write", { path: absolute, content: "at [[pi-sec:now]]\n" });
    expect(await readFile(absolute, "utf8")).toBe("at [[pi-sec:now]]\n");
    expect(byAbsolute.text).not.toContain("Replaced");
    expect(lastLine(byAbsolute.text)).toBe(`Successfully wrote to ${absolute}`);

    const byRelative = await runTool(h, "write", { path: "relative.md", content: "at [[pi-sec:now]]\n" });
    const relativeFile = join(h.paths.workspaceTree, "relative.md");
    expect(await readFile(relativeFile, "utf8")).toBe("at [[pi-sec:now]]\n");
    expect(byRelative.text).not.toContain("Replaced");
    expect(lastLine(byRelative.text)).toBe("Successfully wrote to relative.md");
  });

  it("(c) leaves a .md file inside the snapshot tree alone", async () => {
    const h = await harnessFor();
    const file = join(h.paths.snapshotTree, "note.md");
    await mkdir(h.paths.snapshotTree, { recursive: true });

    const run = await runTool(h, "write", { path: file, content: "at [[pi-sec:now]]\n" });
    expect(await readFile(file, "utf8")).toBe("at [[pi-sec:now]]\n");
    expect(run.text).not.toContain("Replaced");
  });

  it("(d) leaves a file that is not .md alone", async () => {
    const h = await harnessFor();
    const dir = await outsideDir();
    const file = join(dir, "note.txt");

    const run = await runTool(h, "write", { path: file, content: "at [[pi-sec:now]]\n" });
    expect(await readFile(file, "utf8")).toBe("at [[pi-sec:now]]\n");
    expect(run.text).not.toContain("Replaced");
  });

  it("(e) keeps an escaped marker and replaces only the plain one", async () => {
    const h = await harnessFor();
    const dir = await outsideDir();

    const escaped = join(dir, "escaped.md");
    const onlyEscaped = await runTool(h, "write", { path: escaped, content: "literal \\[[pi-sec:now]]\n" });
    expect(await readFile(escaped, "utf8")).toBe("literal \\[[pi-sec:now]]\n");
    expect(onlyEscaped.text).not.toContain("Replaced");

    const mixed = join(dir, "mixed.md");
    const before = Date.now();
    const run = await runTool(h, "write", {
      path: mixed,
      content: "plain [[pi-sec:now]] and escaped \\[[pi-sec:now]]\n",
    });
    const after = Date.now();
    const saved = await readFile(mixed, "utf8");
    expect(saved).toBe(`plain ${saved.match(TIME)?.[0]} and escaped \\[[pi-sec:now]]\n`);
    expectSavedNow(saved, before, after);
    expect(lastLine(run.text)).toMatch(noteLine(1));
  });

  it("(f) replaces in newText only, and a marker in oldText still matches the file", async () => {
    const h = await harnessFor();
    const dir = await outsideDir();
    const file = join(dir, "edit.md");
    // The seed is written with `fs`, so the file really holds the literal marker
    // the edit has to find. A replacement inside `oldText` would change it, and
    // the call would then fail to find the text it was given.
    await writeFile(file, "stamp: [[pi-sec:now]]\n", "utf8");

    const before = Date.now();
    const run = await runTool(h, "edit", {
      path: file,
      edits: [{ oldText: "stamp: [[pi-sec:now]]", newText: "at [[pi-sec:now]], again [[pi-sec:now]]" }],
    });
    const after = Date.now();

    const saved = await readFile(file, "utf8");
    const time = saved.match(TIME)?.[0];
    expect(time, `no zone time in ${JSON.stringify(saved)}`).toBeDefined();
    expect(saved).toBe(`at ${time}, again ${time}\n`);
    expectSavedNow(saved, before, after);
    expect(lastLine(run.text)).toMatch(noteLine(2));
  });

  it("(g) replaces from a js script, and the nested result carries the line", async () => {
    const h = await harnessFor();
    const dir = await outsideDir();
    const file = join(dir, "script.md");

    const before = Date.now();
    const written = await runTool(h, "js", {
      code: `return await tools.write({ path: ${JSON.stringify(file)}, content: "at [[pi-sec:now]]\\n" });`,
    });
    const after = Date.now();

    const saved = await readFile(file, "utf8");
    expectSavedNow(saved, before, after);
    // The `js` result ends with the sandbox's own summary line, so the marker line
    // is somewhere inside the text the script got, not on the last line.
    const writeNote = noteIn(written.text, 1);
    expect(writeNote, `no marker line in ${JSON.stringify(written.text)}`).toBeDefined();
    expect(writeNote).toContain(saved.match(TIME)?.[0]);

    const edited = await runTool(h, "js", {
      code: `return await tools.edit({
        path: ${JSON.stringify(file)},
        edits: [{ oldText: ${JSON.stringify(`at ${saved.match(TIME)?.[0]}`)}, newText: "again [[pi-sec:now]]" }],
      });`,
    });
    const afterEdit = await readFile(file, "utf8");
    expect(afterEdit).not.toContain("[[pi-sec:now]]");
    expect(afterEdit).toMatch(TIME);
    const editNote = noteIn(edited.text, 1);
    expect(editNote, `no marker line in ${JSON.stringify(edited.text)}`).toBeDefined();
    expect(editNote).toContain(afterEdit.match(TIME)?.[0]);
  });

  it("(h) decides on the resolved path, so .. cannot climb into a tree or out of one", async () => {
    const h = await harnessFor();
    // Written with `..` left in, so the check reads the resolved path and not the
    // string: a path that starts inside a tree and lands in the other one.
    const intoWorkspace = `${h.paths.snapshotTree}/../workspace/climb.md`;
    const inside = await runTool(h, "write", { path: intoWorkspace, content: "at [[pi-sec:now]]\n" });
    expect(await readFile(join(h.paths.workspaceTree, "climb.md"), "utf8")).toBe("at [[pi-sec:now]]\n");
    expect(inside.text).not.toContain("Replaced");

    // The other direction: the string starts inside the workspace tree and the
    // resolved path is outside both trees.
    const dir = await outsideDir();
    const escaped = join(dir, "note.md");
    const outOfTree = `${h.paths.workspaceTree}/../../${relative(tmpdir(), escaped)}`;
    const before = Date.now();
    const out = await runTool(h, "write", { path: outOfTree, content: "at [[pi-sec:now]]\n" });
    const after = Date.now();
    const saved = await readFile(escaped, "utf8");
    expect(saved).not.toContain("[[pi-sec:now]]");
    expectSavedNow(saved, before, after);
    expect(lastLine(out.text)).toMatch(noteLine(1));
  });
});
