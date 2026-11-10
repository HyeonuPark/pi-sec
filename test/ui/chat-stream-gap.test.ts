/**
 * The old page's conversation-stream assertions that the new tests did not yet
 * cover.
 *
 * Each test here is one old assertion, rewritten against the
 * new page: the shell, `mountChatStream`, the state modules and the real stream
 * client, with the server faked (`chat-stream-harness.ts`). The old files are the
 * source of the claim, not of the code: `test/web-ui.test.ts`,
 * `test/no-response-ui.test.ts`, `test/reminder-hidden-web.test.ts`,
 * `test/stream-entries-ui.test.ts`, `test/attachments-web.test.ts` and
 * `test/focused-chat-web.test.ts`.
 *
 * A claim is kept at the strength the old test gave it. Where the old test counted
 * rows, this one counts them too. Where it counted requests, this one counts them.
 * Where it read one element by its key, this one does that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGE_SOURCES, wrapMessage, type MessageSource } from "../../src/message-envelope.ts";
import { slimSnapshot } from "../../src/server/stream-entries.ts";
import { isSilentAssistantTurn } from "../../src/ui/chat/transcript/envelope.ts";
import { settle } from "./harness.ts";
import { assistant, loadStreamPage, operatorMessage, toolResult, type StreamPage } from "./chat-stream-harness.ts";
import { fullEntries } from "../stream-entries-fixture.ts";

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

/** The marker an assistant turn carries when it has nothing to say. */
const MARKER = "[pi-sec no-response]";

/**
 * The reminder block a stored input carries after its envelope. The page must
 * never draw it: it already reads the body from inside the envelope only.
 */
const STORED_BLOCK_TEXT = "예시 안내 문장입니다.";

/** One entry whose text is a message envelope, as the server writes it. */
function envelope(id: number, source: MessageSource, body: string, attributes: Record<string, string> = {}): Record<string, unknown> {
  return {
    id,
    kind: "pi.user",
    model: [{ role: "user", content: wrapMessage(source, body, attributes) }],
  };
}

/** One stored input: the envelope, then the reminder block after its closing tag. */
function storedInput(id: number, body: string, reminder: string | undefined): Record<string, unknown> {
  const text = wrapMessage("agent", body, { at: "2026-10-25T19:00:00+09:00" });
  const withReminder =
    reminder === undefined ? text : `${text}\n<pi-reminder name="reply-language">\n${reminder}\n</pi-reminder>`;
  return { id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: withReminder }] }] };
}

/** One answered `ask_user` question, as the answer route writes it. */
function answerEntry(id: number, lines: readonly string[]): Record<string, unknown> {
  return envelope(id, "operator", lines.join("\n"), { via: "ask-user", key: "k1", mode: "choice", choice: "0" });
}

/** The note `sections.ts` writes: a sealed section's change, in an envelope. */
function sectionNote(id: number, body: string, key = "role:worker"): Record<string, unknown> {
  const text = wrapMessage("section", body, { key });
  return { id, kind: "sec.section-update", model: [{ role: "user", content: [{ type: "text", text }] }] };
}

/** The rows drawn for entries and nothing else, without the hidden writing row. */
function drawnRows(ui: StreamPage): Element[] {
  return [...ui.document.querySelectorAll('#transcript > [data-row-key]:not([data-row-key="writing"])')];
}

describe("an operator message with no files", () => {
  it("draws a message without the attribute exactly as before", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "plain words")] });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain("plain words");
    expect(html).not.toContain("message-attachments");
  });
});

describe("the no-response marker in the transcript", () => {
  it("draws nothing for a turn whose whole answer is the marker", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [assistant(1, MARKER), assistant(2, `  ${MARKER}\n`), assistant(3, "")],
    });
    await flush();

    expect(ui.document.querySelectorAll(".message.assistant:not(.writing)")).toHaveLength(0);
    expect(ui.document.getElementById("transcript")?.innerHTML ?? "").not.toContain("no-response");
    expect(drawnRows(ui)).toHaveLength(0);
    // The rows the page holds are the hidden writing row and nothing else.
    expect(ui.rows().map((row) => row.key)).toEqual(["writing"]);
  });

  it("draws a turn that says something else next to the marker", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        assistant(1, `${MARKER}\nHere is the answer after all.`),
        assistant(2, `${MARKER} because there is nothing to add`),
        assistant(3, "A plain answer."),
      ],
    });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain("Here is the answer after all.");
    expect(html).toContain("because there is nothing to add");
    expect(html).toContain("A plain answer.");
    // Three answers drawn. The hidden writing row that always ends the list is not one of them.
    expect(ui.document.querySelectorAll(".message.assistant:not(.writing)")).toHaveLength(3);
  });

  it("draws a marker that is not the whole answer", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [assistant(1, `before ${MARKER} after`), assistant(2, `\`${MARKER}\``)],
    });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).toContain("no-response");
    expect(ui.document.querySelectorAll(".message.assistant:not(.writing)")).toHaveLength(2);
  });

  it("keeps one card when a silent turn sits between two tool calls", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        toolResult(1, "bash", "c1", "output of bash"),
        assistant(2, ""),
        assistant(3, MARKER),
        toolResult(4, "read", "c2", "output of read"),
      ],
    });
    await flush();

    const cards = [...ui.document.querySelectorAll("details.run-group")];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent ?? "").toContain("bash");
    expect(cards[0]?.textContent ?? "").toContain("read");
    expect(cards[0]?.querySelector("summary")?.textContent).toBe("2 tool calls · bash, read");
  });

  it("draws the writing row, and never a fragment of the marker", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [] });
    await flush();
    ui.emit("message_start", {});
    await flush();

    const row = ui.document.querySelector("#transcript .writing");
    expect(row).not.toBeNull();
    expect(row?.textContent ?? "").toContain("writing");
    expect(ui.document.getElementById("transcript")?.innerHTML ?? "").not.toContain("no-response");

    // A delta frame draws nothing at all, so the marker cannot show up half
    // spelled and then be taken back.
    ui.emit("message_update", { changes: [{ type: "text_delta", delta: "[pi-sec no" }] });
    ui.emit("message_update", { changes: [{ type: "text_delta", delta: MARKER }] });
    await flush();
    expect(ui.document.getElementById("transcript")?.innerHTML ?? "").not.toContain("no-response");
    expect(ui.document.querySelector("#transcript .writing")).not.toBeNull();
  });

  it("draws every copy of the marker that is not the whole answer", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        assistant(1, `\`${MARKER}\``),
        assistant(2, "[]"),
        assistant(3, "[ ]"),
        assistant(4, `표지는 ${MARKER} 입니다.`),
      ],
    });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain("no-response");
    expect(ui.document.querySelectorAll(".message.assistant:not(.writing)")).toHaveLength(4);
  });

  it("judges only the marker alone as silence", () => {
    expect(typeof isSilentAssistantTurn).toBe("function");
    expect(isSilentAssistantTurn("")).toBe(true);
    expect(isSilentAssistantTurn("   \n")).toBe(true);
    expect(isSilentAssistantTurn(MARKER)).toBe(true);
    expect(isSilentAssistantTurn(` ${MARKER} `)).toBe(true);
    expect(isSilentAssistantTurn(`${MARKER} more`)).toBe(false);
    expect(isSilentAssistantTurn("hello")).toBe(false);
  });
});

describe("a stored reminder on the chat page", () => {
  it("draws the input and not the reminder that follows it", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [storedInput(1, "the worker finished", STORED_BLOCK_TEXT)] });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain("the worker finished");
    expect(html).not.toContain("pi-reminder");
    expect(html).not.toContain("예시 안내");
    expect(ui.document.getElementById("transcript")?.textContent ?? "").not.toContain(STORED_BLOCK_TEXT);
  });

  it("draws nothing extra for an input with no reminder", async () => {
    const withReminder = await page();
    withReminder.emit("snapshot", { entries: [storedInput(1, "a note", STORED_BLOCK_TEXT)] });
    await flush();
    const withHtml = withReminder.document.getElementById("transcript")?.innerHTML ?? "";
    withReminder.close();
    open = undefined;

    const without = await page();
    without.emit("snapshot", { entries: [storedInput(1, "a note", undefined)] });
    await flush();
    const withoutHtml = without.document.getElementById("transcript")?.innerHTML ?? "";

    // The two stored texts differ by the reminder, and the page draws the same
    // thing for both: the reminder is not part of what a person reads.
    expect(withHtml).toContain("a note");
    expect(withHtml).toBe(withoutHtml);
  });
});

describe("a snapshot that was slimmed before it was sent", () => {
  it("builds the same transcript from the full snapshot and the slimmed one", async () => {
    const full = {
      entries: fullEntries(),
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
    };
    const slim = slimSnapshot(full as never);

    // The two payloads really differ in what the rule names: without this, a
    // slimming rule that did nothing would also pass the comparison.
    const slimText = JSON.stringify(slim.entries);
    const fullText = JSON.stringify(full.entries);
    expect(fullText).toContain("thinkingSignature");
    expect(fullText).toContain("A role rule.");
    expect(fullText).toContain("*** Begin Patch");
    expect(fullText).toContain('"arguments"');
    expect(slimText).not.toContain("thinkingSignature");
    expect(slimText).not.toContain("A role rule.");
    expect(slimText).not.toContain("*** Begin Patch");
    expect(slimText).not.toContain('"arguments"');
    expect(slimText).not.toContain('"usage"');
    expect(slim.tools).toEqual([]);
    expect(slim.compactions).toEqual([]);
    expect(slim.usage).toEqual({});

    const fromFullPage = await page();
    fromFullPage.emit("snapshot", full);
    await settle();
    await flush();
    const fromFull = fromFullPage.document.getElementById("transcript")?.innerHTML ?? "";
    fromFullPage.close();
    open = undefined;

    const fromSlimPage = await page();
    fromSlimPage.emit("snapshot", slim);
    await settle();
    await flush();
    const fromSlim = fromSlimPage.document.getElementById("transcript")?.innerHTML ?? "";

    expect(fromSlim).toBe(fromFull);
    // The transcript is not empty, and it holds the rows both payloads must draw.
    expect(fromFull).toContain('class="message user"');
    expect(fromFull).toContain("edited /tmp/parser.ts");
    expect(fromFull).toContain("I will read the file first.");
  });
});

describe("an operator message that only carries the answer attribute", () => {
  it("leaves an operator message that carries only the attribute alone", async () => {
    const ui = await page();
    // One marker line is not enough: this is prose the operator typed, written by
    // the same door with the same attribute.
    ui.emit("snapshot", {
      entries: [envelope(1, "operator", "I will just do it this way", { via: "ask-user" })],
    });
    await flush();

    const html = ui.document.getElementById("transcript")?.innerHTML ?? "";
    expect(html).toContain('class="message user"');
    expect(html).not.toContain('class="message answer"');
  });
});

describe("the card a stretch draws", () => {
  it("starts a new group after an assistant message", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        toolResult(2, "bash", "call_a", "one"),
        toolResult(3, "read", "call_b", "two"),
        assistant(4, "here is what I found"),
        toolResult(5, "grep", "call_c", "three"),
      ],
    });
    await flush();

    expect(ui.document.querySelectorAll("details.run-group")).toHaveLength(2);
    expect(ui.document.querySelectorAll(".tool-item")).toHaveLength(3);
  });

  it("gives an in-flight call its own group after a message is drawn", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [toolResult(2, "bash", "call_a", "one"), assistant(3, "found it, now checking")],
    });
    await flush();
    ui.emit("tool_execution_start", { toolCallId: "call_live", toolName: "grep" });
    await flush();

    expect(ui.document.querySelectorAll("details.run-group")).toHaveLength(2);
    expect(ui.document.querySelectorAll(".tool-item")).toHaveLength(2);
  });
});

describe("the header banners", () => {
  const banner = (ui: StreamPage, id: string) => ui.document.getElementById(id) as HTMLElement;

  it("draws no banner when a sealed section moved", async () => {
    const ui = await page({
      fetch: {
        "/api/admin/status": {
          body: { restartRequired: false, sectionsStale: [{ conversationId: 1, keys: ["personality"] }] },
        },
      },
    });
    await flush();

    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(true);
    expect(banner(ui, "restart-banner").textContent).not.toContain("start a new session");
  });

  it("takes the core-change request from the event, not from a moved section", async () => {
    const ui = await page({ fetch: { "/api/admin/status": { body: { restartRequired: false } } } });
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(true);

    ui.emit("sections_stale", { conversationId: 1, keys: ["personality"] });
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(true);

    ui.emit("restart_required", { ready: true });
    await flush();
    expect(banner(ui, "restart-banner").classList.contains("hidden")).toBe(false);
    expect(banner(ui, "restart-banner").textContent).toContain("user-tools/update-and-restart");
    expect(banner(ui, "restart-banner").textContent).not.toContain("start a new session");
  });

  it("stays hidden while the config on disk loads", async () => {
    const ui = await page({ fetch: { "/api/admin/status": { body: { configError: null } } } });
    await flush();

    expect(banner(ui, "config-banner").classList.contains("hidden")).toBe(true);
    expect(banner(ui, "config-banner").textContent).toBe("");
  });
});

describe("a delta frame", () => {
  it("draws nothing at all for a delta frame", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "hi")] });
    await flush();

    const transcript = () => ui.document.getElementById("transcript") as HTMLElement;
    const before = transcript().innerHTML;
    const user = ui.document.querySelector('[data-row-key="entry:1"]');

    ui.emit("message_update", { changes: [{ type: "text_delta", delta: "half a sent" }] });
    await flush();

    expect(transcript().innerHTML).toBe(before);
    expect(ui.document.querySelector('[data-row-key="entry:1"]')).toBe(user);
    expect(transcript().textContent).not.toContain("half a sent");
  });
});

describe("a call in flight that ends", () => {
  it("redraws only the card of a call in flight when the call ends", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: [operatorMessage(1, "hi")] });
    ui.emit("tool_execution_start", { toolCallId: "call_a", toolName: "bash" });
    await flush();

    const user = ui.document.querySelector('[data-row-key="entry:1"]');
    const card = ui.document.querySelector("details[data-group-key]") as HTMLDetailsElement | null;
    expect(card).not.toBeNull();
    expect(card?.querySelector("summary")?.textContent).toContain("…");
    card!.open = true;
    card!.dispatchEvent(new ui.window.Event("toggle"));
    const built = ui.transcript.transcriptStats.built;

    ui.emit("tool_execution_end", { toolCallId: "call_a" });
    await flush();

    const redrawn = ui.document.querySelector("details[data-group-key]") as HTMLDetailsElement;
    // The head lost the "…", so this one row is drawn again, and it stays open.
    expect(redrawn.querySelector("summary")?.textContent).not.toContain("…");
    expect(redrawn.open).toBe(true);
    // Nothing else was built, and nothing else lost its element.
    expect(ui.document.querySelector('[data-row-key="entry:1"]')).toBe(user);
    expect(ui.transcript.transcriptStats.built).toBe(built + 1);
    // The operator's turn, the card, and the hidden writing row.
    expect(ui.document.querySelectorAll("#transcript > [data-row-key]")).toHaveLength(3);
  });
});

describe("one conversation drawn twice", () => {
  it("draws the same HTML row by row as it does in one list", async () => {
    const stepwise = await page();
    stepwise.emit("snapshot", { entries: [operatorMessage(1, "hi"), assistant(2, "first")] });
    stepwise.emit("tool_execution_start", { toolCallId: "call_a", toolName: "bash" });
    stepwise.emit("tool_execution_update", { toolCallId: "call_a", output: { set: "half a line" } });
    stepwise.emit("message_end", { entry: toolResult(3, "bash", "call_a", "half a line") });
    stepwise.emit("message_end", { entry: assistant(4, "last") });
    stepwise.emit("entry_appended", { entry: toolResult(5, "read", "call_b", "read out") });
    await flush();
    const stepwiseHtml = stepwise.document.getElementById("transcript")?.innerHTML ?? "";
    stepwise.close();
    open = undefined;

    // The same conversation, drawn once from a snapshot: every row new.
    const whole = await page();
    whole.emit("snapshot", {
      entries: [
        operatorMessage(1, "hi"),
        assistant(2, "first"),
        toolResult(3, "bash", "call_a", "half a line"),
        assistant(4, "last"),
        toolResult(5, "read", "call_b", "read out"),
      ],
    });
    await flush();
    const wholeHtml = whole.document.getElementById("transcript")?.innerHTML ?? "";

    expect(wholeHtml).toContain("read out");
    expect(stepwiseHtml).toBe(wholeHtml);
  });
});

describe("attachment descriptors in the payload", () => {
  /** The descriptor the server puts beside an entry, for one picture. */
  const photo = "01M55HG8RJ0000000000004WFW";
  const picture = { id: photo, mime: "image/jpeg", name: "photo.jpg", bytes: 88273, w: 810, h: 1080 };

  /** The bubble this id draws: a picture, named and sized from the descriptor. */
  function expectPicture(ui: StreamPage): void {
    const link = ui.document.querySelector("#transcript a.message-image");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(`/api/attachments/${photo}`);
    expect(ui.document.querySelector("#transcript a.message-file")).toBeNull();
    const image = link!.querySelector("img");
    expect(image).not.toBeNull();
    expect(image!.getAttribute("src")).toBe(`/api/attachments/${photo}`);
    expect(image!.getAttribute("alt")).toBe("photo.jpg");
    expect(image!.getAttribute("width")).toBe("810");
    expect(image!.getAttribute("height")).toBe("1080");
  }

  it("attachments payload seeds the picture branch without a meta request", async () => {
    // No upload happens in this test, so the page knows nothing about the id
    // before the payload arrives. That is the case the descriptors are for.
    const ui = await page();
    ui.emit("snapshot", {
      entries: [operatorMessage(1, "here is a photo", { attachments: photo })],
      attachments: { [photo]: picture },
    });
    await flush();
    expectPicture(ui);

    // The frame that really carries descriptors is `message_end`, so the same
    // claim is made for it: the bubble it appends is drawn from the map it
    // carried, on the render that same handler makes.
    ui.emit("message_end", {
      entry: operatorMessage(2, "one more", { attachments: photo }),
      attachments: { [photo]: picture },
    });
    await flush();
    expect(ui.document.querySelectorAll("#transcript a.message-image")).toHaveLength(2);

    // A frame with no descriptors of its own still draws a picture, because the
    // map the earlier payload filled is kept.
    ui.emit("entry_appended", {
      entry: operatorMessage(3, "the third", { attachments: photo }),
      attachments: {},
    });
    await flush();
    expect(ui.document.querySelectorAll("#transcript a.message-image")).toHaveLength(3);

    // Nothing was asked for a descriptor: the first render had it already.
    expect(ui.fetchCalls.filter((call) => call.url.includes("/meta"))).toHaveLength(0);
  });
});

describe("the items of a folded card", () => {
  /** Every source that folds, with the attributes that place it. */
  function notTheOperators(): Record<string, unknown>[] {
    return [
      envelope(9, "operator-scheduled", "starting the nightly sweep.", { job: "routine-a" }),
      envelope(10, "tool-output", "background output", { title: "nightly", tool: "bash", status: "done" }),
      envelope(11, "agent", "the sweep found something so far.", { from: "agent-a", kind: "note" }),
      envelope(12, "restart", "carry on", { via: "continuation", round: "R2" }),
      envelope(13, "system", "continue", { kind: "nudge" }),
      envelope(14, "unknown", "text whose source is unknown"),
      sectionNote(15, "[system prompt change]\nthe role file changed."),
    ];
  }

  it("names every item's source and shows its body with the envelope taken off", async () => {
    const ui = await page();
    ui.emit("snapshot", { entries: notTheOperators() });
    await flush();

    const group = ui.document.querySelector("details.run-group");
    if (group === null) throw new Error("no run rendered");
    group.open = true;
    group.dispatchEvent(new ui.window.Event("toggle"));

    const items = [...group.querySelectorAll(".message-item")];
    const heads = items.map((item) => item.querySelector(".message-item-name")?.textContent ?? "");
    // The source first, then the attributes that place the message, `job` among
    // them: a scheduled run says which job it came from.
    expect(heads[0]).toBe("operator-scheduled · job=routine-a");
    expect(heads[1]).toContain("tool-output");
    expect(heads[2]).toContain("agent");
    // `unknown` is named like every other source; it is not hidden.
    expect(heads[5]).toBe("unknown");
    expect(heads[6]).toContain("section");
    expect(items[0]?.querySelector("pre")?.textContent).toBe("starting the nightly sweep.");
    expect(items[1]?.querySelector("pre")?.textContent).toBe("background output");
    expect(items[5]?.querySelector("pre")?.textContent).toBe("text whose source is unknown");
    // The label is not the message: no envelope is left anywhere in the group.
    expect(group.textContent).not.toContain("pi-message");
  });
});

describe("the sources that keep a bubble", () => {
  it("gives a bubble to `operator` and to no other source", async () => {
    // Every source the server can write, from the envelope module itself, so a
    // second source that keeps a bubble fails here.
    const others = MESSAGE_SOURCES.filter((source) => source !== "operator");
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        envelope(1, "operator", "words the operator typed"),
        ...others.map((source, index) => envelope(10 + index, source, `${source} body`)),
        envelope(50, "operator", "the last word"),
      ],
    });
    await flush();

    const bubbles = [...ui.document.querySelectorAll("#transcript .message.user")].map((el) => el.textContent?.trim());
    expect(bubbles).toEqual(["words the operator typed", "the last word"]);
    const group = ui.document.querySelector("details.run-group");
    expect(group?.querySelectorAll(".message-item")).toHaveLength(others.length);
    const summary = group?.querySelector("summary")?.textContent ?? "";
    for (const source of others) expect(summary).toContain(source);
  });
});

describe("an answered question whose answer runs over several lines", () => {
  it("keeps a question from the record when the answer runs over several lines", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        answerEntry(1, [
          "Question: which account should this go to?",
          "Options:",
          "1) work",
          "Answer: to the shared mailbox",
          "a second line",
        ]),
      ],
    });
    await flush();

    expect(ui.document.querySelector(".answer-choice")?.textContent).toBe("to the shared mailbox\na second line");
    expect(ui.document.querySelector(".answer-question")?.textContent).toBe("which account should this go to?");
  });
});

describe("the order of a card's items", () => {
  it("lists the items of a stretch in the order they arrived", async () => {
    const ui = await page();
    ui.emit("snapshot", {
      entries: [
        toolResult(2, "bash", "call_a", "one"),
        envelope(3, "agent", "a note"),
        toolResult(4, "read", "call_b", "two"),
        envelope(5, "system", "continue"),
        toolResult(6, "grep", "call_c", "three"),
      ],
    });
    await flush();

    const body = ui.document.querySelector("details.run-group .run-group-body");
    const kinds = [...(body?.children ?? [])].map((child) => child.className);
    expect(kinds).toEqual(["tool-item", "message-item", "tool-item", "message-item", "tool-item"]);
  });
});

describe("a call that continues a folded message", () => {
  it("joins an in-flight call to the run a folded message opened", async () => {
    // Nothing drawn has come between the message and the call, so they are one
    // stretch, and one stretch is one card.
    const ui = await page();
    ui.emit("snapshot", { entries: [envelope(2, "agent", "a note")] });
    await flush();
    ui.emit("tool_execution_start", { toolCallId: "call_live", toolName: "grep" });
    await flush();

    expect(ui.document.querySelectorAll("details.run-group")).toHaveLength(1);
    expect(ui.document.querySelector("details.run-group summary")?.textContent).toBe(
      "1 tool call … · 1 message · grep · agent",
    );
    expect(ui.document.querySelectorAll(".tool-item")).toHaveLength(1);
    expect(ui.document.querySelectorAll(".message-item")).toHaveLength(1);
  });
});
