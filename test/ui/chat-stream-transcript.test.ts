/**
 * What the transcript draws, from the rows the state module builds.
 *
 * The rules are the hand-written chat page's (removed in this commit): the first
 * line of a message decides its shape,
 * one working stretch is one folded card whatever it holds, structural markers are
 * dividers and not messages, the writing row always sits at the tail, and an
 * unchanged row keeps its element.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assistant, loadStreamPage, operatorMessage, toolResult, type StreamPage } from "./chat-stream-harness.ts";

let open: StreamPage | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadStreamPage>[0] = {}): Promise<StreamPage> {
  open = await loadStreamPage(options);
  return open;
}

/** Let the signals settle: a signal notifies its readers in a microtask. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Every row the transcript holds, in order. */
function rows(ui: StreamPage): Element[] {
  return [...ui.document.querySelectorAll("#transcript > [data-row-key]")];
}

/** The keys of those rows. */
function keys(ui: StreamPage): string[] {
  return rows(ui).map((row) => row.getAttribute("data-row-key") ?? "");
}

/** One user message written inside the envelope the server uses now. */
function envelope(id: number, source: string, body: string, attributes: Record<string, string> = {}): Record<string, unknown> {
  const extra = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  return {
    id,
    kind: "pi.user",
    model: [{ role: "user", content: `<pi-message src="${source}"${extra}>\n${body}\n</pi-message>` }],
  };
}

describe("what one entry draws", () => {
  it("gives the operator's own words a bubble, with the envelope taken off", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "please look")] });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.className).toBe("message user");
    expect(row?.textContent?.trim()).toBe("please look");
  });

  it("draws an answer as markdown, never as markup", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "**bold** and <img src=x onerror=alert(1)>")] });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.className).toBe("message assistant");
    expect(row?.querySelector("strong")?.textContent).toBe("bold");
    expect(row?.querySelector("img")).toBeNull();
  });

  it("leaves out a system prompt change and a silent assistant turn", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        { id: 1, kind: "pi.system", model: [{ role: "system", content: "rules" }] },
        assistant(2, "[pi-sec no-response]"),
        assistant(3, "a real answer"),
      ],
    });
    await flush();
    expect(keys(ui)).toEqual(["entry:3", "writing"]);
  });

  it("draws a reset and a compaction as dividers", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        { id: 1, kind: "pi.reset", model: [] },
        { id: 2, kind: "pi.compaction", model: [{ role: "user", content: "summary" }] },
      ],
    });
    await flush();
    expect(ui.document.querySelector('[data-row-key="divider:1"]')?.textContent).toBe("new session");
    expect(ui.document.querySelector('[data-row-key="divider:2"]')?.textContent).toBe("context compacted");
  });

  it("draws a system prompt change as a divider and a folded note that keeps its own value", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [{ id: 1, kind: "sec.section-update", model: [{ role: "user", content: "the whole new role file" }] }],
    });
    await flush();
    expect(ui.document.querySelector('[data-row-key="divider:1"]')?.textContent).toBe("system prompt updated");
    const note = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="section:1"]');
    expect(note?.open).toBe(false);
    expect(note?.querySelector("summary")?.textContent).toBe("system prompt section changed: show the new value");
    expect(note?.textContent).toContain("the whole new role file");

    note!.open = true;
    note!.dispatchEvent(new ui.window.Event("toggle"));
    await flush();
    expect(ui.transcript.isGroupOpen("section:1")).toBe(true);
    ui.emit("message_start", {});
    await flush();
    expect(ui.document.querySelector<HTMLDetailsElement>('[data-row-key="section:1"]')?.open).toBe(true);
  });
});

describe("the three special cards", () => {
  it("draws a note from the viewer as its own category, not as an operator message", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [envelope(1, "operator", "the note body", { report: "example-plan", version: "3" })],
    });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.className).toBe("message review");
    expect(row?.querySelector(".review-head")?.textContent).toContain("feedback · ");
    expect(row?.querySelector(".review-head a")?.getAttribute("href")).toBe("/report/example-plan");
    expect(row?.querySelector(".review-head")?.textContent).toContain("v3");
    expect(row?.querySelector(".review-head a")?.getAttribute("target")).toBe("_blank");
    expect(row?.querySelector(".review-head a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(row?.querySelector(".review-body")?.textContent).toContain("the note body");
  });

  it("reads a note written before the envelope, by its marker line", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "[pi-sec review] report=r1 v=2\nold note" }] }],
    });
    await flush();
    expect(ui.document.querySelector('[data-row-key="entry:1"]')?.className).toBe("message review");
    expect(ui.document.querySelector('[data-row-key="entry:1"]')?.textContent).toContain("old note");
  });

  it("draws an approval as one line, and never the marker line as prose", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(
          1,
          "operator",
          '[pi-sec approve] report=r1 v=2 sha=abc\nThe user approved revision 2 of "Plan r2"',
          { via: "approval" },
        ),
      ],
    });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.className).toBe("message approval");
    expect(row?.textContent).toContain("Approved · ");
    expect(row?.textContent).toContain("Plan r2");
    expect(row?.textContent).toContain("v2");
    expect(row?.textContent).not.toContain("[pi-sec approve]");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe("/report/r1");
    expect(row?.querySelector(".approval-head a")?.getAttribute("target")).toBe("_blank");
    expect(row?.querySelector(".approval-head a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("draws a Done as its own line, with the follow-up words the user wrote", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(
          1,
          "operator",
          '[pi-sec approve] report=run-log v=1 sha=abc button=done\n' +
            'The user pressed Done on revision 1 of "Run log" (/report/run-log) from the report viewer.\n' +
            "This is the approval of the text hashed above, the same as Approve. A later revision is a new proposal and needs its own approval.\n\n" +
            "The user also asked for follow-up work with Done. The approval of this revision stands. Hand the request over as a new request, with report 01R, job 01J, and the title above as context. The user's words:\n\n" +
            "Run the check on the second machine.",
          { via: "approval" },
        ),
      ],
    });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    // The card says Done rather than Approved, because the marker line says which
    // button was pressed.
    expect(row?.className).toBe("message approval");
    expect(row?.querySelector(".approval-head")?.textContent).toContain("Done · ");
    expect(row?.querySelector(".approval-head")?.textContent).toContain("Run log");
    expect(row?.querySelector(".approval-head")?.textContent).toContain("v1");
    // The user's words are under it, and the paragraph the root reads is not.
    expect(row?.querySelector(".approval-body")?.textContent?.trim()).toBe("Run the check on the second machine.");
    expect(row?.textContent).not.toContain("Hand the request over");
    expect(row?.textContent).not.toContain("[pi-sec approve]");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe("/report/run-log");
  });

  it("draws a Done with no text as one line and no body", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(
          1,
          "operator",
          '[pi-sec approve] report=run-log v=2 sha=abc button=done\n' +
            'The user pressed Done on revision 2 of "Run log" (/report/run-log) from the report panel in the chat.\n' +
            "This is the approval of the text hashed above, the same as Approve. A later revision is a new proposal and needs its own approval.",
          { via: "approval" },
        ),
      ],
    });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.querySelector(".approval-head")?.textContent).toContain("Done · ");
    expect(row?.querySelector(".approval-body")).toBeNull();
  });

  it("draws an answer as the question and the choice, without the option list", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(1, "operator", "Question:\nWhich one?\nOptions:\na\nb\nAnswer:\nb", { via: "ask-user" }),
      ],
    });
    await flush();
    const row = ui.document.querySelector('[data-row-key="entry:1"]');
    expect(row?.className).toBe("message answer");
    expect(row?.querySelector(".answer-question")?.textContent).toBe("Which one?");
    expect(row?.querySelector(".answer-choice")?.textContent).toBe("b");
  });
});

describe("the folded working stretch", () => {
  it("folds messages that are not the operator's into one card, whatever their source", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(1, "agent", "a message from another agent"),
        envelope(2, "tool-output", "a background result"),
        {
          id: 3,
          kind: "pi.user",
          model: [{ role: "user", content: '<tool-call-output kind="note">\nlegacy body\n</tool-call-output>' }],
        },
        { id: 4, kind: "pi.user", model: [{ role: "user", content: "[restart x] back again" }] },
      ],
    });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]');
    expect(card).not.toBeNull();
    expect(card?.open).toBe(false);
    const head = card?.querySelector("summary")?.textContent ?? "";
    expect(head).toContain("4 messages");
    expect(head).toContain("agent, tool-output, restart");
    expect(card?.querySelectorAll(".message-item")).toHaveLength(4);
    expect(card?.textContent).toContain("a message from another agent");
    expect(card?.textContent).toContain("legacy body");
  });

  it("folds the tool calls and the messages of one stretch into one card", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        operatorMessage(1, "please look"),
        toolResult(2, "bash", "c1", "one"),
        envelope(3, "agent", "a note"),
        toolResult(4, "read", "c2", "two"),
        assistant(5, "done"),
      ],
    });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:2"]');
    expect(card).not.toBeNull();
    const head = card?.querySelector("summary")?.textContent ?? "";
    expect(head).toContain("2 tool calls");
    expect(head).toContain("1 message");
    expect(head).toContain("bash, read");
    expect(head).toContain("agent");
    expect(card?.querySelectorAll(".tool-item")).toHaveLength(2);
    expect(card?.querySelectorAll(".message-item")).toHaveLength(1);
  });

  it("names a source it cannot read as `unknown`, and counts it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [envelope(1, "stranger", "who sent this")] });
    await flush();
    expect(ui.document.querySelector("summary")?.textContent).toBe("1 message · unknown");
  });

  it("keeps a card open once the operator opens it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [toolResult(1, "bash", "c1", "out")] });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]');
    expect(card?.open).toBe(false);

    card!.open = true;
    card!.dispatchEvent(new ui.window.Event("toggle"));
    await flush();
    expect(ui.transcript.isGroupOpen("run:1")).toBe(true);

    // A later event draws the transcript again; the operator's choice survives it.
    ui.emit("message_start", {});
    await flush();
    expect(ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:1"]')?.open).toBe(true);
  });

  it("leaves the operator's own message out of the group", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [toolResult(1, "bash", "c1", "out"), operatorMessage(2, "my own words"), toolResult(3, "read", "c2", "in")],
    });
    await flush();
    expect(keys(ui)).toEqual(["run:1", "entry:2", "run:3", "writing"]);
  });

  it("joins a call in flight to the run it continues", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [toolResult(1, "bash", "c1", "out")] });
    ui.emit("tool_execution_start", { toolCallId: "c2", toolName: "read" });
    await flush();
    const card = ui.document.querySelector('[data-row-key="run:1"]');
    expect(card?.querySelectorAll(".tool-item")).toHaveLength(2);
    expect(card?.querySelector("summary")?.textContent).toContain("2 tool calls …");
  });

  it("gives a call in flight a group of its own on a conversation with nothing in it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    ui.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    await flush();
    const card = ui.document.querySelector<HTMLDetailsElement>('[data-row-key="run:live"]');
    expect(card).not.toBeNull();
    expect(card?.open).toBe(false);
    expect(card?.querySelector(".tool-item-name")?.textContent).toBe("bash");
  });

  it("drops a tool call once its result is committed", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    ui.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    await flush();
    expect(ui.document.querySelector('[data-row-key="run:live"]')).not.toBeNull();
    ui.emit("tool_execution_end", { toolCallId: "c1" });
    ui.emit("message_end", { entry: toolResult(9, "bash", "c1", "the output") });
    await flush();
    expect(keys(ui)).toEqual(["run:9", "writing"]);
    expect(ui.document.querySelectorAll(".tool-item")).toHaveLength(1);
  });
});

describe("a tool panel", () => {
  it("writes a growing output into the panel that is already there", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    ui.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    await flush();
    const panel = ui.document.querySelector<HTMLElement>('[data-tool-call-id="c1"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(".tool-item-name")?.textContent).toBe("bash");
    const built = ui.transcript.transcriptStats.built;

    for (let index = 0; index < 5; index += 1) {
      ui.emit("tool_execution_update", { toolCallId: "c1", output: { append: String(index) } });
    }
    await flush();
    expect(ui.document.querySelector('[data-tool-call-id="c1"] pre')?.textContent).toBe("01234");
    // No row was built again for an output that only grew.
    expect(ui.transcript.transcriptStats.built).toBe(built);
  });

  it("takes an output that is set instead of appended", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    ui.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
    ui.emit("tool_execution_update", { toolCallId: "c1", output: { set: "reset" } });
    await flush();
    expect(ui.document.querySelector('[data-tool-call-id="c1"] pre')?.textContent).toBe("reset");
  });
});

describe("the writing row", () => {
  it("sits at the tail, idle but with its height", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    await flush();
    const row = ui.document.querySelector('[data-row-key="writing"]');
    expect(row?.className).toBe("message assistant writing idle");
    expect(row?.getAttribute("aria-hidden")).toBe("true");
    expect(row?.textContent).toBe("writing…");
  });

  it("shows while an answer is written, and hides again in place", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    await flush();
    const before = ui.document.querySelector('[data-row-key="writing"]');

    ui.emit("message_start", {});
    await flush();
    const writing = ui.document.querySelector('[data-row-key="writing"]');
    expect(writing?.className).toBe("message assistant writing");
    expect(writing?.hasAttribute("aria-hidden")).toBe(false);
    // The same element, so the list does not move when the row appears.
    expect(writing).toBe(before);

    ui.emit("message_end", {});
    await flush();
    expect(ui.document.querySelector('[data-row-key="writing"]')).toBe(before);
    expect(before?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the row for an answer already under way when the page attaches", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [], generation: { message: { id: 1 } } });
    await flush();
    expect(ui.document.querySelector('[data-row-key="writing"]')?.className).toBe("message assistant writing");
  });
});

describe("the compaction line", () => {
  it("is drawn by the snapshot, and cleared by the end frame", async () => {
    const ui = await page();
    const line = ui.document.getElementById("compaction-status") as HTMLElement;
    expect(line.classList.contains("hidden")).toBe(true);
    ui.emit("snapshot", { entries: [], compactions: [{ id: 1 }] });
    await flush();
    expect(line.classList.contains("hidden")).toBe(false);
    ui.emit("compaction_end", {});
    await flush();
    expect(line.classList.contains("hidden")).toBe(true);
    ui.emit("compaction_start", {});
    await flush();
    expect(line.classList.contains("hidden")).toBe(false);
  });
});

describe("an appended entry", () => {
  it("is drawn once, even when the same frame arrives twice", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.emit("entry_appended", { entry: assistant(1, "first") });
    ui.emit("entry_appended", { entry: assistant(1, "first") });
    await flush();
    expect(keys(ui)).toEqual(["entry:1", "writing"]);
  });
});

describe("the state a snapshot carries", () => {
  it("draws the calls in flight a snapshot carries, and skips a pending one", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [],
      tools: [
        { callId: "c1", name: "bash", status: "running", output: "half" },
        { callId: "c2", name: "read", status: "done", output: "whole" },
        { callId: "c3", name: "grep", status: "pending" },
      ],
    });
    await flush();
    const panels = ui.document.querySelectorAll('[data-row-key="run:live"] .tool-item');
    expect(panels).toHaveLength(2);
    expect(ui.document.querySelector('[data-tool-call-id="c1"] pre')?.textContent).toBe("half");
    expect(ui.document.querySelector('[data-tool-call-id="c2"] pre')?.textContent).toBe("whole");
    expect(ui.document.querySelector('[data-tool-call-id="c3"]')).toBeNull();
  });

  it("builds no row again for an event that changes nothing", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "hello"), toolResult(2, "bash", "c1", "out"), operatorMessage(3, "hi")] });
    await flush();
    const built = ui.transcript.transcriptStats.built;
    expect(built).toBe(3);

    ui.emit("run_start", {});
    ui.emit("message_start", {});
    ui.emit("message_end", {});
    ui.emit("run_end", {});
    ui.emit("entry_appended", { entry: assistant(3, "hi") });
    await flush();
    expect(ui.transcript.transcriptStats.built).toBe(built);
    expect(ui.document.querySelectorAll('#transcript > [data-row-key]:not([data-row-key="writing"])')).toHaveLength(3);
  });

  it("builds one row for the one entry that arrives", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "one"), assistant(2, "two"), operatorMessage(3, "three")] });
    await flush();
    const built = ui.transcript.transcriptStats.built;
    ui.emit("entry_appended", { entry: assistant(4, "four") });
    await flush();
    expect(ui.transcript.transcriptStats.built).toBe(built + 1);
  });
});

describe("the rows the CSS is written against", () => {
  it("draws every row as a direct child carrying data-row-key", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [assistant(1, "an answer"), toolResult(2, "bash", "c1", "out")] });
    await flush();
    const transcript = ui.document.getElementById("transcript") as HTMLElement;
    const children = [...transcript.children];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect(child.getAttribute("data-row-key")).not.toBeNull();
  });
});
