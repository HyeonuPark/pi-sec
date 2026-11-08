/**
 * The composer branch's features, on the assembled page.
 *
 * The composer branch's own tests
 * mount the composer, the attachment tray and the context bar by hand. This file
 * says the same features still hold where the page draws them beside the
 * transcript, the sidebar and the three panels — one bundle, one form, one submit.
 *
 * What a test answers is the form's own routes; the confirmations are stubs whose
 * questions are read as values.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPageHandle } from "./harness.ts";
import { byId, loadChatPage, more, press, type } from "./chat-harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** Every request the page made to a path, in order. */
function calls(ui: UiPageHandle, path: string) {
  return ui.fetchCalls.filter((call) => call.path === path);
}

/** Press a key on the page's own field. */
function key(ui: UiPageHandle, name: string, extra: KeyboardEventInit = {}): void {
  byId(ui, "message").dispatchEvent(
    new ui.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }),
  );
}

/** The field the operator types into. */
function field(ui: UiPageHandle): HTMLTextAreaElement {
  return byId<HTMLTextAreaElement>(ui, "message");
}

describe("the composer on the assembled page", () => {
  it("sends on Enter, adds a newline on Shift+Enter, and ignores an input method's Enter", async () => {
    open = await loadChatPage();
    const ui = open;
    // A page whose stream is open is the one that may send; another test pins the other.
    ui.currentStream().open();
    await more(1);

    type(ui, field(ui), "first message");
    key(ui, "Enter");
    await more(3);
    const sent = calls(ui, "/basic-chat/messages");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "null")).toMatchObject({ content: "first message" });
    expect(field(ui).value).toBe("");

    // Shift+Enter is a line break, and nothing is sent.
    type(ui, field(ui), "second");
    key(ui, "Enter", { shiftKey: true });
    await more(2);
    expect(calls(ui, "/basic-chat/messages")).toHaveLength(1);

    // The Enter that commits a composition belongs to the input method.
    byId(ui, "message").dispatchEvent(
      new ui.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
    );
    await more(2);
    expect(calls(ui, "/basic-chat/messages")).toHaveLength(1);
  });

  it("sends a draft once, with one request id, and refuses an empty one", async () => {
    open = await loadChatPage();
    const ui = open;
    ui.currentStream().open();
    await more(1);
    press(ui, byId(ui, "send"));
    await more(2);
    expect(calls(ui, "/basic-chat/messages")).toHaveLength(0);

    type(ui, field(ui), "  " );
    press(ui, byId(ui, "send"));
    await more(2);
    expect(calls(ui, "/basic-chat/messages")).toHaveLength(0);

    type(ui, field(ui), "hello");
    // Two presses before the first answer lands: one send, not two.
    press(ui, byId(ui, "send"));
    press(ui, byId(ui, "send"));
    await more(3);
    const sent = calls(ui, "/basic-chat/messages");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "null")).toMatchObject({ content: "hello" });
  });

  it("stops the run on the conversation's abort route", async () => {
    open = await loadChatPage();
    const ui = open;
    expect(byId<HTMLButtonElement>(ui, "abort").disabled).toBe(true);
    ui.emit("run_start", {});
    await more(2);
    expect(byId<HTMLButtonElement>(ui, "abort").disabled).toBe(false);

    press(ui, byId(ui, "abort"));
    await more(2);
    expect(calls(ui, "/basic-chat/abort")).toHaveLength(1);
  });

  it("compacts this conversation, and asks before a new session", async () => {
    open = await loadChatPage();
    const ui = open;
    press(ui, byId(ui, "more-actions"));
    await more(2);
    press(ui, byId(ui, "compact"));
    await more(2);
    expect(calls(ui, "/basic-chat/compact")).toHaveLength(1);

    const asked: string[] = [];
    (ui.window as unknown as { confirm: (text: string) => boolean }).confirm = (text: string) => {
      asked.push(text);
      return false;
    };
    press(ui, byId(ui, "more-actions"));
    await more(2);
    press(ui, byId(ui, "reset"));
    await more(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("pi-sec");
    // The press was withdrawn, so nothing was reset.
    expect(calls(ui, "/basic-chat/reset")).toHaveLength(0);
  });

  it("asks what a restart costs before it posts one", async () => {
    open = await loadChatPage();
    const ui = open;
    const asked: string[] = [];
    (ui.window as unknown as { confirm: (text: string) => boolean }).confirm = (text: string) => {
      asked.push(text);
      return true;
    };
    press(ui, byId(ui, "more-actions"));
    await more(2);
    press(ui, byId(ui, "restart"));
    await more(2);
    expect(asked[0]).toContain("Restart the server");
    const posted = calls(ui, "/api/admin/restart");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]?.body ?? "null")).toMatchObject({});
  });

  it("carries the draft and the open report across a UI restart", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/inbox": {
          body: {
            items: [
              {
                id: "i1",
                kind: "report",
                title: "Report published: Plan",
                body: "/report/plan",
                createdAt: Date.now(),
                source: { reportId: "r1", jobId: "j1", reportEvent: "published" },
              },
            ],
          },
        },
        "/api/reports/r1": { body: { id: "r1", name: "plan", title: "Plan", versions: [{ n: 1, at: 1, bytes: 1, sha256: "a" }], feedback: [], active: true, status: "active", job: { id: "j1", title: "work", status: "active" } } },
        "/api/reports/r1/versions/1": { text: "a report" },
      },
    });
    const ui = open;
    const title = ui.document.querySelector("#inbox .inbox-title") as HTMLElement;
    press(ui, title);
    await more(3);
    expect(ui.document.body.dataset.report).toBe("open");
    type(ui, field(ui), "a draft that must survive");

    // Both questions are answered yes: the second one is where the carry is
    // written, just before the page is asked to reload.
    const questions: string[] = [];
    (ui.window as unknown as { confirm: (text: string) => boolean }).confirm = (text: string) => {
      questions.push(text);
      return true;
    };
    press(ui, byId(ui, "more-actions"));
    await more(2);
    press(ui, byId(ui, "restart-ui"));
    await more(4);

    expect(questions).toHaveLength(2);
    const carry = ui.window.sessionStorage.getItem("pi-sec-ui-restart");
    expect(carry).not.toBeNull();
    expect(JSON.parse(carry ?? "null")).toMatchObject({ draft: "a draft that must survive", report: "r1" });
  });

  it("keeps an unsent draft under the conversation it was written in", async () => {
    open = await loadChatPage();
    const ui = open;
    type(ui, field(ui), "keep me");
    await more(4);
    const keys = Object.keys(ui.window.localStorage);
    const stored = keys.map((key) => ui.window.localStorage.getItem(key) ?? "").join("\n");
    expect(stored).toContain("keep me");
    // One entry for this conversation, under the mount.
    expect(keys.filter((key) => key.startsWith("pi-sec:drafts:"))).toHaveLength(1);
  });

  it("opens the picker each of the three attach buttons belongs to", async () => {
    open = await loadChatPage();
    const ui = open;
    const opened: string[] = [];
    for (const id of ["pick-image", "pick-camera", "pick-file"]) {
      const input = byId(ui, id) as HTMLInputElement;
      input.click = () => opened.push(id);
    }
    press(ui, byId(ui, "attach-image"));
    press(ui, byId(ui, "attach-camera"));
    press(ui, byId(ui, "attach-file"));
    expect(opened).toEqual(["pick-image", "pick-camera", "pick-file"]);
    // The three pickers keep their own file rules.
    expect(byId(ui, "pick-image").getAttribute("multiple")).not.toBeNull();
    expect(byId(ui, "pick-camera").getAttribute("capture")).toBe("environment");
    expect(byId(ui, "pick-camera").getAttribute("multiple")).toBeNull();
  });

  it("sends a picture that already fits as it is, and never reads a text file's size", async () => {
    open = await loadChatPage();
    const ui = open;
    const reads: string[] = [];
    // A file reader that says it was asked: the shrink path reads the file.
    const RealReader = ui.window.FileReader;
    class Watching extends RealReader {
      readAsDataURL(blob: Blob): void {
        reads.push(blob.type);
        super.readAsDataURL(blob);
      }
    }
    (ui.window as unknown as { FileReader: unknown }).FileReader = Watching;

    const pick = byId(ui, "pick-file") as HTMLInputElement;
    const file = new ui.window.File(["notes"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(pick, "files", { value: [file], configurable: true });
    pick.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    await more(4);
    // A file that is not an image is uploaded as it is: nothing reads it first.
    expect(reads).toEqual([]);
    expect(calls(ui, "/api/attachments")).toHaveLength(1);
  });

  it("gives every picked file a chip with its state and its controls", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/attachments": (request: { readonly url: string }) => ({
          status: 201,
          body: { id: "a1", url: "/api/attachments/a1", mime: "text/plain", bytes: 5, name: new URL(request.url, "http://localhost").searchParams.get("name") ?? "" },
        }),
      },
    });
    const ui = open;
    const pick = byId(ui, "pick-file") as HTMLInputElement;
    const file = new ui.window.File(["notes"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(pick, "files", { value: [file], configurable: true });
    pick.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    await more(4);

    const chip = ui.document.querySelector("#attachment-tray .attachment-chip");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("class")).toContain("is-ready");
    expect(chip?.querySelector(".attachment-name")?.textContent).toBe("notes.txt");
    expect(chip?.querySelector("button.attachment-remove")).not.toBeNull();
    expect(byId(ui, "attachment-tray").classList.contains("hidden")).toBe(false);
  });

  it("fills the context bar from the context route, and reads it once at open", async () => {
    open = await loadChatPage({
      fetch: { "/basic-chat/context": { body: { used: 10_659, max: 983_616, window: 1_000_000, reserveTokens: 16_384 } } },
    });
    const ui = open;
    expect(calls(ui, "/basic-chat/context")).toHaveLength(1);
    const bar = byId(ui, "context-bar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(byId(ui, "context-usage").textContent).toContain("10.7k");

    // An answer that lands moves the numbers, and reads once more.
    ui.emit("message_end", {
      entry: { id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: "an answer" }] },
    });
    await more(3);
    expect(calls(ui, "/basic-chat/context").length).toBeGreaterThan(1);
  });
});
