/**
 * The `⋯` menu: the four conversation and daemon actions it holds, each behind its
 * own question, and the UI restart that carries the text and the open panel across
 * the reload it causes.
 *
 * Nothing here reaches a server. The fake `fetch` answers every route, and the
 * questions are values: `confirm` records what it was asked and answers from the
 * list a test gives it.
 *
 * One entry is answered twice: a reset the server refuses while sub-agents work
 * asks a second question naming them, and sends the reset again with `force`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/ui/api/request.ts";
import { workingAgentsOf } from "../../src/ui/state/composer.ts";
import { bodyOf, loadComposerPage, type ComposerPage } from "./chat-composer-harness.ts";

let open: ComposerPage | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

async function page(options: Parameters<typeof loadComposerPage>[0] = {}): Promise<ComposerPage> {
  open = await loadComposerPage(options);
  return open;
}

/** Calls by route, whichever method. */
function calls(ui: ComposerPage, suffix: string) {
  return ui.fetchCalls.filter((call) => call.path.endsWith(suffix));
}

/** The refusal a reset gets while sub-agents work, exactly as the server writes it. */
function agentsWorking(agents: { conversationId: string; name: string }[], message: string) {
  return {
    status: 409,
    body: { error: { code: "agents_working", message }, agents },
  };
}

describe("the menu", () => {
  it("opens from its button, and closes on a choice, on Escape, and on a press outside", async () => {
    const ui = await page();
    const menu = ui.document.getElementById("composer-menu") as HTMLElement;
    const toggle = ui.document.getElementById("more-actions") as HTMLElement;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await ui.settle();
    expect(menu.classList.contains("open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    (ui.document.getElementById("compact") as HTMLButtonElement).click();
    await ui.settle();
    expect(menu.classList.contains("open")).toBe(false);

    toggle.click();
    await ui.settle();
    ui.window.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape" }));
    await ui.settle();
    expect(menu.classList.contains("open")).toBe(false);

    toggle.click();
    await ui.settle();
    (ui.document.getElementById("transcript") as HTMLElement).click();
    await ui.settle();
    expect(menu.classList.contains("open")).toBe(false);
  });

  it("keeps the menu open, and the field as it is, when the stream sends a frame", async () => {
    const ui = await page();
    (ui.document.getElementById("more-actions") as HTMLButtonElement).click();
    ui.type("half a message");
    await ui.settle();

    ui.emit("entry_appended", { entry: { id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: "hi" }] } });
    await ui.settle();

    // Both are the operator's, and no frame of the server closes or opens either.
    expect((ui.document.getElementById("composer-menu") as HTMLElement).classList.contains("open")).toBe(true);
    expect(ui.text()).toBe("half a message");
  });

  it("hands `Model login` to the panel that owns it", async () => {
    const ui = await page();
    let opened = 0;
    ui.composer.onLoginPress(() => {
      opened += 1;
    });
    (ui.document.getElementById("model-login") as HTMLButtonElement).click();
    await ui.settle();
    expect(opened).toBe(1);
    expect((ui.document.getElementById("composer-menu") as HTMLElement).classList.contains("open")).toBe(false);
  });
});

describe("Compact", () => {
  it("posts a compaction of this conversation", async () => {
    const ui = await page();
    (ui.document.getElementById("compact") as HTMLButtonElement).click();
    await ui.settle();

    const [compact] = calls(ui, "/compact");
    expect(compact?.method).toBe("POST");
    expect(compact?.path).toBe("/basic-chat/compact");
    expect(bodyOf(compact)).toEqual({});
  });

  it("compacts a focused chat on its own route", async () => {
    const ui = await page({
      chat: 7,
      fetch: { "/api/focused-chats/7": { body: { conversationId: 7, title: "Topic", archived: false } } },
    });
    (ui.document.getElementById("compact") as HTMLButtonElement).click();
    await ui.settle();
    expect(calls(ui, "/compact")[0]?.path).toBe("/api/conversations/7/compact");
  });
});

const TWO_AGENTS = [
  { conversationId: "12", name: "orch-example" },
  { conversationId: "14", name: "worker-example" },
];

/** A 409 refusal whose body, when one is given, is the parsed JSON the server sent. */
const refusal = (body?: unknown) => new ApiError(409, "agents_working", "x", body === undefined ? undefined : { body });

describe("the agents a refusal names", () => {
  it.each([
    [
      "reads the list the refusal carries beside its error envelope",
      new ApiError(409, "agents_working", "2 sub-agents are working", {
        requestId: "r1",
        body: {
          error: { code: "agents_working", message: "2 sub-agents are working", requestId: "r1" },
          agents: TWO_AGENTS,
        },
      }),
      TWO_AGENTS,
    ],
    // A refusal this page cannot read says nothing about who is working, which is
    // what the question falls back on.
    ["names nobody when the body is missing", new ApiError(409, "agents_working", "2 sub-agents are working"), []],
    ["names nobody when the agents are not a list", refusal({ agents: "two" }), []],
    ["names nobody when the only entries are nameless or null", refusal({ agents: [{ conversationId: "12" }, null] }), []],
    ["names nobody when the error is undefined", undefined, []],
    ["names nobody when the error is not a refusal", new Error("not a refusal"), []],
    [
      // An entry with no conversation is still a person the operator loses track of.
      "keeps only the entries that name a person",
      refusal({ agents: [{ conversationId: "12", name: "a" }, { conversationId: "14" }, { name: "b" }] }),
      [
        { conversationId: "12", name: "a" },
        { conversationId: undefined, name: "b" },
      ],
    ],
  ])("%s", (_name, error, expected) => {
    expect(workingAgentsOf(error)).toEqual(expected);
  });
});

describe("New session", () => {
  it("asks one question naming the chat, and sends the reset", async () => {
    const ui = await page({ ask: [true] });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toEqual(['Start a new session in "pi-sec"? History is kept.']);
    const [reset] = calls(ui, "/reset");
    expect(reset?.method).toBe("POST");
    expect(bodyOf(reset)).toEqual({});
  });

  it("sends nothing when the operator withdraws the press", async () => {
    const ui = await page({ ask: [false] });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toHaveLength(1);
    expect(calls(ui, "/reset")).toHaveLength(0);
  });

  it("asks a second time when sub-agents are working, and sends the reset again with force", async () => {
    const ui = await page({
      ask: [true, true],
      fetch: {
        "/basic-chat/reset": () => agentsWorking([{ conversationId: "12", name: "a" }, { conversationId: "14", name: "b" }], "2 sub-agents are working"),
      },
    });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toHaveLength(2);
    // The second question names the agents the server named, says what a new
    // session would do, and says what keeps running. It is asked, not assumed.
    expect(ui.questions[1]).toBe(
      [
        "2 sub-agents are working: a, b.",
        "A new session empties the root's context, so the root forgets how this work stands. The agents keep running and report to the new session.",
        'Start a new session in "pi-sec" anyway?',
      ].join("\n"),
    );

    const resets = calls(ui, "/reset");
    expect(resets).toHaveLength(2);
    expect(bodyOf(resets[0])).toEqual({});
    expect(bodyOf(resets[1])).toEqual({ force: true });
  });

  it("names five agents and counts the rest, and speaks of one in the singular", async () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((name, index) => ({ conversationId: String(20 + index), name }));
    const ui = await page({
      ask: [true, false],
      fetch: { "/basic-chat/reset": () => agentsWorking(seven, "7 sub-agents are working") },
    });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions[1]).toBe(
      [
        "7 sub-agents are working: a, b, c, d, e, and 2 more.",
        "A new session empties the root's context, so the root forgets how this work stands. The agents keep running and report to the new session.",
        'Start a new session in "pi-sec" anyway?',
      ].join("\n"),
    );
    ui.close();
    open = undefined;

    const single = await page({
      ask: [true, false],
      fetch: { "/basic-chat/reset": () => agentsWorking([{ conversationId: "12", name: "only-one" }], "1 sub-agent is working") },
    });
    (single.document.getElementById("reset") as HTMLButtonElement).click();
    await single.settle();
    expect(single.questions[1]).toContain("1 sub-agent is working: only-one.");
  });

  it("asks without names when the refusal names nobody", async () => {
    const ui = await page({
      ask: [true, true],
      // A refusal of the right code that carries no list: the count and the
      // consequences are all the question can honestly say.
      fetch: { "/basic-chat/reset": { status: 409, body: { error: { code: "agents_working", message: "3 sub-agents are working" } } } },
    });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions[1]).toBe(
      [
        "3 sub-agents are working.",
        "A new session empties the root's context, so the root forgets how this work stands. The agents keep running and report to the new session.",
        'Start a new session in "pi-sec" anyway?',
      ].join("\n"),
    );
    expect(calls(ui, "/reset")).toHaveLength(2);
    expect(bodyOf(calls(ui, "/reset")[1])).toEqual({ force: true });
  });

  it("sends nothing more when the second question is refused", async () => {
    const ui = await page({
      ask: [true, false],
      fetch: { "/basic-chat/reset": () => agentsWorking([{ conversationId: "12", name: "only-one" }], "1 sub-agent is working") },
    });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toHaveLength(2);
    expect(calls(ui, "/reset")).toHaveLength(1);
  });

  it("shows the server's message when the reset fails for another reason", async () => {
    const ui = await page({
      ask: [true],
      fetch: { "/basic-chat/reset": { status: 500, body: { error: { code: "failed", message: "the store is unavailable" } } } },
    });
    (ui.document.getElementById("reset") as HTMLButtonElement).click();
    await ui.settle();

    // One question, one request, and the reason on the page rather than only in
    // the console: a failure here used to be swallowed.
    expect(ui.questions).toHaveLength(1);
    expect(calls(ui, "/reset")).toHaveLength(1);
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("the store is unavailable");
  });
});

describe("Restart server", () => {
  it("asks what it costs, then asks the server to restart", async () => {
    const ui = await page({ ask: [true] });
    (ui.document.getElementById("restart") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions).toHaveLength(1);
    expect(ui.questions[0]).toContain("Restart the server?");
    expect(ui.questions[0]).toContain("cut off");
    expect(ui.questions[0]).toContain("committed update");

    const [restart] = calls(ui, "/api/admin/restart");
    expect(restart?.method).toBe("POST");
    // The plain entry sends an empty body: the field is what asks for the reinstall.
    expect(bodyOf(restart)).toEqual({});
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("Restart requested");
  });

  it("sends nothing when the question is refused", async () => {
    const ui = await page({ ask: [false] });
    (ui.document.getElementById("restart") as HTMLButtonElement).click();
    await ui.settle();
    expect(calls(ui, "/api/admin/restart")).toHaveLength(0);
  });

  it("names the risk when a batch is still open", async () => {
    const ui = await page({ ask: [true], fetch: { "/api/admin/status": { body: { restartRequired: true, restartReady: false } } } });
    (ui.document.getElementById("restart") as HTMLButtonElement).click();
    await ui.settle();

    // The daemon comes back running whatever is committed, which mid-batch can be
    // half a change. Warning beats refusing: the operator is the authority.
    expect(ui.questions[0]).toContain("batch is not closed");
  });

  it("asks for a forced reinstall, and says what it costs", async () => {
    const ui = await page({ ask: [true] });
    (ui.document.getElementById("restart-reinstall") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.questions[0]).toContain("node_modules");
    expect(ui.questions[0]).toContain("installed again");
    expect(ui.questions[0]).toContain("longer than a plain restart");
    expect(bodyOf(calls(ui, "/api/admin/restart")[0])).toEqual({ reinstall: true });
  });

  it("says when the server refused the restart", async () => {
    const ui = await page({
      ask: [true],
      fetch: {
        "/api/admin/restart": { status: 409, body: { error: { code: "already_requested", message: "this daemon has already asked for a restart" } } },
      },
    });
    (ui.document.getElementById("restart") as HTMLButtonElement).click();
    await ui.settle();

    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("already asked for a restart");
    expect(calls(ui, "/healthz")).toHaveLength(0);
  });

  it("reloads into the new process, and only into one that has just started", async () => {
    const ui = await page({ ask: [true], fetch: { "/healthz": { body: { uptimeMs: 4000 } } } });
    vi.useFakeTimers();
    (ui.document.getElementById("restart") as HTMLButtonElement).click();

    // The first wait is the couple of seconds the old process is still answering.
    await vi.advanceTimersByTimeAsync(ui.composer.RESTART_FIRST_WAIT_MS - 1000);
    expect(ui.navigations).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(ui.navigations).toHaveLength(1);
    expect(calls(ui, "/healthz")).toHaveLength(1);
  });

  it("says the restart did not happen when the old process keeps answering", async () => {
    const ui = await page({ ask: [true], fetch: { "/healthz": { body: { uptimeMs: 5 * 60 * 1000 } } } });
    vi.useFakeTimers();
    (ui.document.getElementById("restart") as HTMLButtonElement).click();

    await vi.advanceTimersByTimeAsync(ui.composer.RESTART_OLD_PROCESS_MS + ui.composer.RESTART_FIRST_WAIT_MS);
    expect(ui.navigations).toHaveLength(0);
    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("the restart did not happen");
  });
});

describe("Restart UI", () => {
  /** The carry the reload leaves behind, as it is stored. */
  const carried = (ui: ComposerPage): unknown => {
    const raw = ui.window.sessionStorage.getItem("pi-sec-ui-restart");
    return raw === null ? null : JSON.parse(raw);
  };

  it("asks first, then asks the server to apply the web folder, then asks before reloading", async () => {
    const ui = await page({
      ask: [true, false],
      // A tree level with the process: the answer names a copied file count and a
      // drift that was read and is empty.
      fetch: { "/api/admin/ui-restart": { body: { ok: true, copied: 7, codeDrift: { known: true, behind: 0, codePaths: [] } } } },
    });
    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();

    // The question has to say that this is not a server restart: the daemon stays
    // up, so a turn in flight is safe.
    expect(ui.questions[0]).toContain("Restart the UI?");
    expect(ui.questions[0]).toContain("The server keeps running");
    expect(ui.questions[0]).toContain("not interrupted");
    expect(ui.questions[0]).toContain("workspace's web folder");

    const [posted] = calls(ui, "/api/admin/ui-restart");
    expect(posted?.method).toBe("POST");
    expect(bodyOf(posted)).toEqual({});

    // Nothing in the tree is ahead of the running process, so the answer says that
    // server code is not part of this at all.
    expect(ui.questions[1]).toContain("UI files applied (7).");
    expect(ui.questions[1]).toContain("Server code changes are not part of this.");
    expect(ui.questions[1]).toContain("Reload now?");
    // The files are applied either way; the reload is the operator's to time.
    expect(ui.navigations).toHaveLength(0);
    expect(carried(ui)).toBeNull();
  });

  it("sends nothing when the first question is refused", async () => {
    const ui = await page({ ask: [false] });
    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();
    expect(calls(ui, "/api/admin/ui-restart")).toHaveLength(0);
    expect(ui.questions).toHaveLength(1);
  });

  it("keeps the draft and the open report across the reload", async () => {
    const ui = await page({ ask: [true, true] });
    const opened: string[] = [];
    ui.composer.registerReportPane({ current: () => "r1", open: (id) => opened.push(id) });
    ui.type("half a message");

    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();

    expect(ui.navigations).toHaveLength(1);
    // A reload would drop both, and neither can be read back from the server.
    expect(carried(ui)).toEqual({ draft: "half a message", report: "r1" });
    expect(opened).toEqual([]);
  });

  it("names the server code it could not apply", async () => {
    const ui = await page({
      ask: [true, false],
      fetch: {
        "/api/admin/ui-restart": {
          body: {
            ok: true,
            copied: 9,
            codeDrift: {
              known: true,
              behind: 4,
              codePaths: ["src/server/routes/admin.ts", "src/cli.ts", "src/runtime/ui-assets.ts", "src/server/server.ts"],
            },
          },
        },
      },
    });
    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();

    // This button copies the web folder alone. A tree with server code in it has to
    // hear that the copy did not reach that code.
    expect(ui.questions[1]).toContain("UI files applied (9).");
    expect(ui.questions[1]).toContain("Server code changes in your tree are not applied (4)");
    expect(ui.questions[1]).toContain("src/server/routes/admin.ts, src/cli.ts, src/runtime/ui-assets.ts");
    expect(ui.questions[1]).not.toContain("src/server/server.ts");
    expect(ui.questions[1]).toContain("A cold restart is needed for those.");
  });

  it("says when it could not read whether server code moved", async () => {
    const ui = await page({
      ask: [true, false],
      fetch: { "/api/admin/ui-restart": { body: { ok: true, copied: 7, codeDrift: { known: false, behind: 0, codePaths: [] } } } },
    });
    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();

    // An empty list means nothing only when it was read.
    expect(ui.questions[1]).toContain(
      "Server code drift could not be read, so whether your tree also changed server code is unknown. This applies web files only.",
    );
    expect(ui.questions[1]).not.toContain("not applied");
    expect(ui.questions[1]).not.toContain("are not part of this");
    expect(ui.questions[1]).toContain("Reload now?");
  });

  it("says when the server refused to apply the files", async () => {
    const ui = await page({
      ask: [true, true],
      fetch: {
        "/api/admin/ui-restart": {
          status: 500,
          body: { error: { code: "sync_failed", message: "the swapped folder could not be kept" } },
        },
      },
    });
    (ui.document.getElementById("restart-ui") as HTMLButtonElement).click();
    await ui.settle();

    expect((ui.document.getElementById("toast") as HTMLElement).textContent).toContain("the swapped folder could not be kept");
    // One question, not two: there is nothing to reload into.
    expect(ui.questions).toHaveLength(1);
    expect(ui.navigations).toHaveLength(0);
  });

  it("puts the draft and the open report back on the next load, and spends the carry", async () => {
    const ui = await page({
      session: { "pi-sec-ui-restart": JSON.stringify({ draft: "still here", report: "r1" }) },
    });
    const opened: string[] = [];
    // The panel is another branch's; the bridge is what a reload asks it for.
    expect(ui.text()).toBe("still here");
    expect(ui.window.sessionStorage.getItem("pi-sec-ui-restart")).toBeNull();

    // And a panel that is registered late is not asked: the carry is spent as the
    // page reads it, which is what keeps a later page from inheriting this draft.
    ui.composer.registerReportPane({ current: () => null, open: (id) => opened.push(id) });
    expect(opened).toEqual([]);
  });
});
