/**
 * How often the page reads the daemon's status.
 *
 * `GET /api/admin/status` answers three things the page draws: the staged-restart
 * banner, the failed config reload, and the notes in the sidebar. The
 * hand-written page (removed in this commit) read it once when it opened and once
 * more each time its stream opened, and filled the notes from that same answer.
 *
 * This file pins the same count on the assembled page, because a second reader of
 * the same route for the notes is one request per open that says nothing new. The
 * notes panel is checked with it: it is filled from the header's read, so it shows
 * what the daemon said without a read of its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { byId, loadChatPage, more } from "./chat-harness.ts";
import type { UiPageHandle } from "./harness.ts";

let open: UiPageHandle | undefined;

afterEach(() => {
  vi.useRealTimers();
  open?.close();
  open = undefined;
});

/** How many times the page asked for the daemon's status. */
function statusReads(ui: UiPageHandle): number {
  return ui.fetchCalls.filter((call) => call.path === "/api/admin/status").length;
}

describe("the daemon's status", () => {
  it("is read twice when the page opens: once for the page, once for its stream", async () => {
    open = await loadChatPage();
    const ui = open;
    // The page's own read, before anything is streamed.
    expect(statusReads(ui)).toBe(1);

    ui.currentStream().open();
    await more(3);
    expect(statusReads(ui)).toBe(2);
  });

  it("fills the notes panel from that read, without a read of its own", async () => {
    open = await loadChatPage({
      fetch: {
        "/api/admin/status": {
          body: {
            restartRequired: false,
            restartReady: false,
            configError: null,
            notes: [{ at: Date.now() - 60_000, text: "mount conflict: X-Forwarded-Prefix \"/other\"" }],
          },
        },
      },
    });
    const ui = open;
    ui.currentStream().open();
    await more(3);

    expect(statusReads(ui)).toBe(2);
    expect(byId(ui, "notes-panel").classList.contains("hidden")).toBe(false);
    expect(byId(ui, "notes").textContent).toContain("/other");
  });

  it("reads it once more when the stream comes back, and follows what it says", async () => {
    open = await loadChatPage();
    const ui = open;
    ui.currentStream().open();
    await more(3);
    expect(statusReads(ui)).toBe(2);
    expect(byId(ui, "restart-banner").classList.contains("hidden")).toBe(true);

    // A reconnect can mean a new daemon whose restart state is not the one this
    // page read at load, so the route is read again — once.
    ui.respond("/api/admin/status", {
      body: { restartRequired: true, restartReady: true, configError: null, notes: [] },
    });
    vi.useFakeTimers();
    ui.currentStream().fail({ closed: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ui.streams().length).toBe(2);
    ui.currentStream().open();
    await vi.advanceTimersByTimeAsync(0);

    expect(statusReads(ui)).toBe(3);
    expect(byId(ui, "restart-banner").classList.contains("hidden")).toBe(false);
    expect(byId(ui, "restart-banner").textContent).toContain("Restart ready");
  });
});
