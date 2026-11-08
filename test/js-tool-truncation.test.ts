import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A nested call whose tool cut its output says so in the text the script gets.
 *
 * The `read` tool keeps its content as bare file text and puts the "Showing
 * lines ..." remark in a diagnostic, so before this the `js` tool handed a
 * script a file cut at 50KB with nothing to mark the cut. The remark now ends the
 * text as one `[truncated]` line, and `invoke()` carries the diagnostics array as
 * well. A result the tool did not cut must read exactly as it did before.
 */

/** Submit one `js` call on the harness's default conversation and return the newest tool result's text. */
async function runScript(harness: TestHarness, code: string): Promise<string> {
  harness.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("js", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const conversation = await resolveDefaultConversation(
    harness.runtime.harness,
    harness.config,
    harness.runtime.paths,
    BACKGROUND_CONTEXT,
  );
  const submission = await conversation.submit({ type: "input", content: "measure" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  // Entries read newest first by default, so the first tool result in the page is
  // the call made above.
  const page = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const result = page.items.find((entry) => entry.kind === "pi.tool-result");
  if (result === undefined) throw new Error("the js call wrote no tool result");
  return (result.model ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content
        .filter(
          (part): part is { type: string; text: string } =>
            part !== null && typeof part === "object" && (part as { type?: string }).type === "text",
        )
        .map((part) => part.text);
    })
    .join("\n");
}

/** Read the JSON object the script returned out of the js result, which ends with the call summary line. */
function returned(result: string): Record<string, unknown> {
  const start = result.indexOf("{");
  const end = result.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`the script returned no object: ${result.slice(0, 400)}`);
  return JSON.parse(result.slice(start, end + 1)) as Record<string, unknown>;
}

/** 1000 lines of 100 bytes each: the 50KB byte cap cuts before the 2000 line cap. */
function largeText(): string {
  const lines: string[] = [];
  for (let index = 1; index <= 1000; index++) {
    lines.push(`${String(index).padStart(4, "0")} ${"x".repeat(95)}`);
  }
  return lines.join("\n");
}

describe("js tool truncation of a nested call", () => {
  let harness: TestHarness | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("ends the text with one [truncated] line and reports the code to invoke", async () => {
    harness = await createTestHarness({});
    dir = await mkdtemp(join(tmpdir(), "js-truncation-"));
    const file = join(dir, "large.txt");
    const body = largeText();
    await writeFile(file, body, "utf8");
    const result = await runScript(
      harness,
      `
      const direct = await tools.read({ path: ${JSON.stringify(file)} });
      const viaInvoke = await invoke("read", { path: ${JSON.stringify(file)} });
      const lines = direct.split("\\n");
      const last = lines[lines.length - 1];
      return JSON.stringify({
        chars: direct.length,
        charsBeforeNote: direct.slice(0, -(last.length + 1)).length,
        lastLine: last,
        codes: viaInvoke.diagnostics.map((each) => each.code),
        severities: viaInvoke.diagnostics.map((each) => each.severity),
        invokeTextEndsWithNote: viaInvoke.text.slice(-(last.length + 1)) === "\\n" + last,
        invokeTextIsTheSameText: viaInvoke.text === direct,
        noteIsTheDiagnosticMessage: last === "[truncated] " + viaInvoke.diagnostics[0].message,
      });
      `,
    );
    const seen = returned(result);
    // The file is 1000 lines of 100 bytes, so the 50KB cap cuts it and the remark
    // names the last line shown and the offset that continues.
    expect(String(seen.lastLine)).toMatch(/^\[truncated\] Showing lines 1-\d+ of 1000 \(50\.0KB limit\)\. Use offset=\d+ to continue\.$/);
    expect(seen.codes).toEqual(["truncated"]);
    expect(seen.severities).toEqual(["info"]);
    // One line, and one newline between it and the text.
    expect(seen.noteIsTheDiagnosticMessage).toBe(true);
    expect(seen.invokeTextIsTheSameText).toBe(true);
    expect(seen.invokeTextEndsWithNote).toBe(true);
    // The text before the note is the cut file text, not the whole file: that is
    // what makes the marker matter.
    expect(Number(seen.chars)).toBeLessThan(body.length);
    expect(Number(seen.charsBeforeNote)).toBe(Number(seen.chars) - String(seen.lastLine).length - 1);
  });

  it("leaves an uncut result byte for byte as it was and still carries a diagnostics array", async () => {
    harness = await createTestHarness({});
    dir = await mkdtemp(join(tmpdir(), "js-truncation-"));
    const file = join(dir, "small.txt");
    const body = "first line\nsecond line\nthird line\n";
    await writeFile(file, body, "utf8");
    const result = await runScript(
      harness,
      `
      const direct = await tools.read({ path: ${JSON.stringify(file)} });
      const viaInvoke = await invoke("read", { path: ${JSON.stringify(file)} });
      const ok = await invoke("bash", { command: "echo hi" });
      return JSON.stringify({
        text: direct,
        invokeText: viaInvoke.text,
        sameText: viaInvoke.text === direct,
        hasArray: Array.isArray(viaInvoke.diagnostics),
        empty: viaInvoke.diagnostics.length,
        marked: direct.includes("[truncated]"),
        bashArray: Array.isArray(ok.diagnostics),
        bashLength: ok.diagnostics.length,
      });
      `,
    );
    const seen = returned(result);
    // `read` hands back the file's own text; the note would change these bytes.
    expect(seen.text).toBe(body);
    expect(seen.sameText).toBe(true);
    expect(seen.marked).toBe(false);
    // `invoke` always answers with an array, empty when the tool said nothing.
    expect(seen.hasArray).toBe(true);
    expect(seen.empty).toBe(0);
    expect(seen.bashArray).toBe(true);
    expect(seen.bashLength).toBe(0);
  });
});
